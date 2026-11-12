/**
 * 命令注册（命令 id 与 package.json 完全一致）：
 *
 *   si.configureRoots  多选目录 -> 写入 sourceInsight.indexRoots
 *   si.rebuildIndex    重建索引（withProgress + 可取消）
 *   si.searchSymbol    QuickPick 搜索函数
 *   si.gotoDefinition  当前光标处跳转定义（多候选走 QuickPick）
 *   si.findReferences  当前光标处查找引用（优先原生 peek，兜底 QuickPick）
 *   si.showCallers     当前函数的所有调用者（QuickPick 跳转）
 *   si.showCallees     当前函数调用的所有被调用者（QuickPick 跳转）
 *   si.openSymbolAt    内部：按 (file, line, column) 打开位置（树/QuickPick 使用）
 *   si.clearCache      清空内存索引 + 删除符号快照
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'

import { suppressRebuildPrompt } from './config'
import { sourceFileOf } from './providers/definition'
import { rankDefinitions } from './rank-definitions'
import { showCallerQuickPick, showReferenceQuickPick, showSymbolEntriesQuickPick, showSymbolQuickPick } from './quickpick'
import type { SymbolService } from './service'
import {
  currentWord,
  executeCommand,
  openLocation,
  showInformationMessage,
  showWarningMessage,
} from './util'

export const COMMAND_IDS = [
  'si.configureRoots',
  'si.rebuildIndex',
  'si.searchSymbol',
  'si.gotoDefinition',
  'si.findReferences',
  'si.showCallers',
  'si.showCallees',
  'si.openSymbolAt',
  'si.clearCache',
] as const

const REBUILD_LABEL = vscode.l10n.t('Rebuild')
const LATER_LABEL = vscode.l10n.t('Later')

export function registerCommands(
  _context: vscode.ExtensionContext | undefined,
  service: SymbolService,
): vscode.Disposable {
  const disposables: vscode.Disposable[] = []
  const add = (id: string, handler: (...args: unknown[]) => unknown): void => {
    try {
      if (typeof vscode.commands.registerCommand !== 'function') {
        return
      }
      disposables.push(
        vscode.commands.registerCommand(id, async (...args: unknown[]) => {
          try {
            await handler(...args)
          } catch (error) {
            console.error(`[code-insight] command ${id} failed`, error)
          }
        }),
      )
    } catch (error) {
      console.error(`[code-insight] cannot register command ${id}`, error)
    }
  }

  add('si.configureRoots', async () => configureRoots(service))
  add('si.rebuildIndex', async () => rebuildIndex(service))
  add('si.searchSymbol', async () => showSymbolQuickPick(service))
  add('si.gotoDefinition', async () => gotoDefinition(service))
  add('si.findReferences', async () => findReferences(service))
  add('si.showCallers', async () => showCallers(service))
  add('si.showCallees', async () => showCallees(service))
  add('si.openSymbolAt', async (...args: unknown[]) => openSymbolAt(service, ...args))
  add('si.clearCache', async () => clearCache(service))

  return {
    dispose: (): void => {
      for (const disposable of disposables) {
        try {
          disposable.dispose()
        } catch {
          // ignore
        }
      }
      disposables.length = 0
    },
  }
}

// ---- si.configureRoots ----

interface DirectoryPickItem extends vscode.QuickPickItem {
  readonly value?: string
  readonly browse?: boolean
}

async function configureRoots(service: SymbolService): Promise<void> {
  const workspaceRoot = service.workspaceRoot
  if (!workspaceRoot) {
    await showWarningMessage(
      vscode.l10n.t('Open a folder before configuring Code Insight index roots.'),
    )
    return
  }
  if (typeof vscode.window.showQuickPick !== 'function') {
    return
  }

  const currentRoots = new Set(service.configuredRoots.map((root) => (root === '.' ? '.' : root)))
  const candidates = await listCandidateDirectories(workspaceRoot)
  const items: DirectoryPickItem[] = []
  items.push({
    label: `$(root-folder) ${vscode.l10n.t('Entire workspace')}`,
    description: workspaceRoot,
    detail: vscode.l10n.t('Index every C/C++ file under the workspace folder.'),
    value: '.',
    picked: currentRoots.has('.'),
  })
  for (const candidate of candidates) {
    items.push({
      label: candidate,
      description: vscode.l10n.t('Directory'),
      value: candidate,
      picked: currentRoots.has(candidate),
    })
  }
  items.push({
    label: `$(folder-opened) ${vscode.l10n.t('Browse…')}`,
    description: vscode.l10n.t('Pick directories inside the workspace folder'),
    browse: true,
  })

  const picked = (await vscode.window.showQuickPick(items, {
    canPickMany: true,
    placeHolder: vscode.l10n.t('Select the directories to index recursively'),
    title: vscode.l10n.t('Configure Index Roots'),
  })) as DirectoryPickItem[] | undefined
  if (!picked) {
    return
  }

  const selected = new Set<string>()
  const browsed = picked.some((item) => item.browse)
  for (const item of picked) {
    if (item.browse) {
      continue
    }
    if (item.value) {
      selected.add(item.value)
    }
  }
  if (browsed) {
    for (const directory of await browseDirectories(service, workspaceRoot)) {
      selected.add(directory)
    }
    // 只点了「浏览…」但没选到任何（工作区内）目录：保持原配置不变，避免误清空
    if (selected.size === 0 && currentRoots.size > 0) {
      await showInformationMessage(
        vscode.l10n.t('No directories were added. Index roots are unchanged.'),
      )
      return
    }
  }

  const nextRoots = Array.from(selected)
  suppressRebuildPrompt()
  try {
    const configuration = vscode.workspace.getConfiguration('sourceInsight')
    const target = resolveConfigurationTarget()
    await configuration.update('indexRoots', nextRoots, target)
  } catch (error) {
    console.error('[code-insight] cannot update indexRoots', error)
    await showWarningMessage(
      vscode.l10n.t('Failed to update the Code Insight index roots setting.'),
    )
    return
  }

  if (nextRoots.length === 0) {
    await showInformationMessage(vscode.l10n.t('No index roots configured. Indexing is disabled.'))
    return
  }
  const answer = await showInformationMessage(
    vscode.l10n.t('Index roots updated. Build the index now?'),
    REBUILD_LABEL,
    LATER_LABEL,
  )
  if (answer === REBUILD_LABEL) {
    await executeCommand('si.rebuildIndex')
  }
}

async function listCandidateDirectories(workspaceRoot: string): Promise<string[]> {
  const skip = new Set(['.git', 'node_modules', '.vscode', '.svn', '.hg', 'out', 'dist'])
  const result: string[] = []
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > 2) {
      return
    }
    const absolute = rel ? path.join(workspaceRoot, rel.split('/').join(path.sep)) : workspaceRoot
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(absolute, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || skip.has(entry.name)) {
        continue
      }
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      result.push(childRel)
      await walk(childRel, depth + 1)
    }
  }
  await walk('', 1)
  result.sort((a, b) => a.localeCompare(b))
  return result
}

async function browseDirectories(service: SymbolService, workspaceRoot: string): Promise<string[]> {
  const result: string[] = []
  try {
    if (typeof vscode.window.showOpenDialog !== 'function') {
      return result
    }
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: true,
      openLabel: vscode.l10n.t('Add to index roots'),
    })
    for (const uri of uris ?? []) {
      const fsPath = uri?.fsPath
      if (typeof fsPath !== 'string' || !fsPath) {
        continue
      }
      const relative = service.toRelative(fsPath)
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        await showWarningMessage(
          vscode.l10n.t('{0} is outside the workspace folder and was skipped.', fsPath),
        )
        continue
      }
      result.push(relative === '' ? '.' : relative)
    }
  } catch (error) {
    console.error('[code-insight] browse directories failed', error)
  }
  return result
}

function resolveConfigurationTarget(): vscode.ConfigurationTarget | undefined {
  try {
    const target = vscode.ConfigurationTarget as unknown as Record<string, number> | undefined
    const workspace = target?.Workspace
    if (typeof workspace === 'number') {
      return workspace as unknown as vscode.ConfigurationTarget
    }
  } catch {
    // ignore
  }
  return undefined
}

// ---- si.rebuildIndex ----

async function rebuildIndex(service: SymbolService): Promise<void> {
  if (!service.hasRoots) {
    const answer = await showInformationMessage(
      vscode.l10n.t('No index roots configured yet. Configure them now?'),
      vscode.l10n.t('Configure'),
      LATER_LABEL,
    )
    if (answer === vscode.l10n.t('Configure')) {
      await executeCommand('si.configureRoots')
    }
    return
  }
  const summary = await service.rebuild()
  if (summary) {
    await showInformationMessage(
      vscode.l10n.t(
        'Code Insight index rebuilt: {0} files, {1} symbols in {2} s.',
        String(summary.files),
        String(summary.entries),
        (summary.durationMs / 1000).toFixed(1),
      ),
    )
    return
  }
  if (service.building) {
    await showInformationMessage(vscode.l10n.t('The index build is already running.'))
    return
  }
  if (service.lastError) {
    await showWarningMessage(
      vscode.l10n.t('Index build failed: {0}', service.lastError),
    )
  }
}

// ---- 编辑器光标相关命令 ----

async function gotoDefinition(service: SymbolService): Promise<void> {
  const hit = currentWord()
  if (!hit) {
    return
  }
  let entries = service.definitions(hit.word)
  if (entries.length === 0) {
    await showInformationMessage(vscode.l10n.t('No definition found for "{0}".', hit.word))
    return
  }
  entries = rankDefinitions(entries, {
    sourceFile: sourceFileOf(service, hit.document),
    roots: service.configuredRoots,
  })
  if (entries.length === 1) {
    const entry = entries[0]
    if (entry) {
      await openLocation(service, entry.file, entry.line, entry.column)
    }
    return
  }
  await showSymbolEntriesQuickPick(
    service,
    entries,
    vscode.l10n.t('Select the definition of "{0}"', hit.word),
  )
}

async function findReferences(service: SymbolService): Promise<void> {
  const hit = currentWord()
  if (!hit) {
    return
  }
  // 优先交给 VS Code 原生 peek（会调用我们注册的 ReferenceProvider，自带进度与取消）
  const handledInEditor = await tryNativeFindReferences(hit.document.uri, hit.position)
  if (handledInEditor) {
    return
  }
  const references = await service.references(hit.word)
  if (references.length === 0) {
    await showInformationMessage(
      vscode.l10n.t('No references found for "{0}".', hit.word),
    )
    return
  }
  await showReferenceQuickPick(service, references)
}

async function tryNativeFindReferences(
  uri: vscode.Uri,
  position: vscode.Position,
): Promise<boolean> {
  try {
    if (typeof vscode.commands.executeCommand !== 'function') {
      return false
    }
    await vscode.commands.executeCommand('editor.action.findReferences', uri, position)
    return true
  } catch (error) {
    console.error('[code-insight] native findReferences failed', error)
    return false
  }
}

async function showCallers(service: SymbolService): Promise<void> {
  const hit = currentWord()
  if (!hit) {
    return
  }
  const callers = await service.callers(hit.word)
  if (callers.length === 0) {
    await showInformationMessage(vscode.l10n.t('No callers found for "{0}".', hit.word))
    return
  }
  await showCallerQuickPick(service, callers, hit.word)
}

async function showCallees(service: SymbolService): Promise<void> {
  const hit = currentWord()
  if (!hit) {
    return
  }
  const callees = await service.callees(hit.word)
  if (callees.length === 0) {
    await showInformationMessage(vscode.l10n.t('No callees found for "{0}".', hit.word))
    return
  }
  await showSymbolEntriesQuickPick(
    service,
    callees,
    vscode.l10n.t('Functions called by "{0}"', hit.word),
  )
}

// ---- si.openSymbolAt ----

async function openSymbolAt(service: SymbolService, ...args: unknown[]): Promise<void> {
  const target = normalizeOpenTarget(args)
  if (!target) {
    return
  }
  await openLocation(service, target.file, target.line, target.column)
}

interface OpenTarget {
  readonly file: string
  readonly line: number
  readonly column: number
}

function normalizeOpenTarget(args: readonly unknown[]): OpenTarget | undefined {
  const first = args[0]
  if (typeof first === 'string' && first) {
    return {
      file: first,
      line: toNonNegativeInteger(args[1], 0),
      column: toNonNegativeInteger(args[2], 0),
    }
  }
  if (first && typeof first === 'object') {
    const candidate = first as { file?: unknown; line?: unknown; column?: unknown }
    if (typeof candidate.file === 'string' && candidate.file) {
      return {
        file: candidate.file,
        line: toNonNegativeInteger(candidate.line, 0),
        column: toNonNegativeInteger(candidate.column, 0),
      }
    }
  }
  return undefined
}

function toNonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  return Math.max(0, Math.floor(parsed))
}

// ---- si.clearCache ----

async function clearCache(service: SymbolService): Promise<void> {
  const answer = await showInformationMessage(
    vscode.l10n.t('Clear the Code Insight index cache?'),
    vscode.l10n.t('Clear'),
    vscode.l10n.t('Cancel'),
  )
  if (answer !== vscode.l10n.t('Clear')) {
    return
  }
  await service.clearCache()
  await showInformationMessage(vscode.l10n.t('Code Insight index cache cleared.'))
}
