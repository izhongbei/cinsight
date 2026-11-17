/**
 * QuickPick 交互：
 * - 符号搜索（si.searchSymbol）：输入 120 ms 防抖，回车跳转；
 * - 候选列表（跳转定义多候选 / 调用者 / 被调用者 / 引用列表）。
 */
import * as vscode from 'vscode'

import { type DefinitionGroup } from '../core/definition-groups'
import type { CallerHit, ReferenceHit, SymbolEntry, SymbolTable } from '../shared/types'
import {
  includedFor,
  listAnnotationParts,
  type ListAnnotationText,
} from './list-annotations'
import { baseName, normalizeRelative } from './paths'
import type { SymbolService } from './service'
import { executeCommand, kindLabel, openLocation } from './util'

const SEARCH_DEBOUNCE_MS = 120

/** 列表注记的本地化文本（在调用时组装，避免模块加载期固化语言）。 */
function listAnnotationText(): ListAnnotationText {
  return {
    included: vscode.l10n.t('included'),
    notIncluded: vscode.l10n.t('not included'),
    conditional: vscode.l10n.t('conditional: {0}'),
  }
}

/** 在既有 detail 后追加注记（保持原文本与顺序；无注记时原样返回）。 */
function withListAnnotations(
  detail: string,
  included: boolean | undefined,
  condition: string | undefined,
): string {
  const parts = listAnnotationParts(included, condition, listAnnotationText())
  return parts.length === 0 ? detail : `${detail} · ${parts.join(' · ')}`
}

interface SymbolQuickPickItem extends vscode.QuickPickItem {
  readonly entry: SymbolEntry
}

/** 通用：弹出列表并等待用户关闭（返回后资源已释放）。 */
function showAndWait<T extends vscode.QuickPickItem>(
  quickPick: vscode.QuickPick<T>,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) {
        return
      }
      settled = true
      try {
        quickPick.dispose()
      } catch {
        // ignore
      }
      resolve()
    }
    try {
      quickPick.onDidHide(finish)
    } catch (error) {
      console.error('[code-insight] quick pick hide listener failed', error)
      finish()
      return
    }
    try {
      quickPick.show()
    } catch (error) {
      console.error('[code-insight] quick pick show failed', error)
      finish()
    }
  })
}

function toSymbolItem(
  entry: SymbolEntry,
  sourceFile: string | undefined,
  table: SymbolTable | undefined,
): SymbolQuickPickItem {
  return {
    label: entry.name,
    description: `${entry.file}:${entry.line + 1}`,
    // 设计 §3.6：有源文件锚点 + 快照时标注 included/not included；条件条目再标条件。
    detail: withListAnnotations(
      kindLabel(entry.kind),
      includedFor(table, sourceFile, entry.file),
      entry.condition,
    ),
    entry,
  }
}

/** si.searchSymbol：输入即搜（120 ms 防抖），选中后跳转。 */
export async function showSymbolQuickPick(
  service: SymbolService,
  sourceFile?: string,
): Promise<void> {
  try {
    if (typeof vscode.window.createQuickPick !== 'function') {
      return
    }
    const quickPick = vscode.window.createQuickPick<SymbolQuickPickItem>()
    quickPick.placeholder = vscode.l10n.t('Search functions and macros across the index')
    quickPick.matchOnDescription = true
    quickPick.matchOnDetail = true
    quickPick.ignoreFocusOut = true
    quickPick.items = []

    let timer: ReturnType<typeof setTimeout> | undefined
    const disposeTimer = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
    }

    const disposables: vscode.Disposable[] = []
    try {
      disposables.push(
        quickPick.onDidChangeValue((value: string) => {
          disposeTimer()
          timer = setTimeout(() => {
            try {
              const table = service.snapshot
              quickPick.items = value.trim()
                ? service
                    .search(value)
                    .map((entry) => toSymbolItem(entry, sourceFile, table))
                : []
            } catch (error) {
              console.error('[code-insight] symbol quick pick search failed', error)
              quickPick.items = []
            }
          }, SEARCH_DEBOUNCE_MS)
        }),
      )
      disposables.push(
        quickPick.onDidAccept(() => {
          const selected = quickPick.selectedItems[0]
          quickPick.hide()
          if (selected) {
            void executeCommand(
              'si.openSymbolAt',
              selected.entry.file,
              selected.entry.line,
              selected.entry.column,
            )
          }
        }),
      )
    } catch (error) {
      console.error('[code-insight] quick pick listeners failed', error)
    }

    try {
      await showAndWait(quickPick)
    } finally {
      disposeTimer()
      for (const disposable of disposables) {
        try {
          disposable.dispose()
        } catch {
          // ignore
        }
      }
    }
  } catch (error) {
    console.error('[code-insight] showSymbolQuickPick failed', error)
  }
}

/** 通用符号列表选择（被调用者等符号列表复用）。 */
export async function showSymbolEntriesQuickPick(
  service: SymbolService,
  entries: readonly SymbolEntry[],
  placeholder: string,
  sourceFile?: string,
): Promise<void> {
  try {
    if (entries.length === 0 || typeof vscode.window.showQuickPick !== 'function') {
      return
    }
    const table = service.snapshot
    const items = entries.map((entry) => toSymbolItem(entry, sourceFile, table))
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: placeholder,
      matchOnDescription: true,
      matchOnDetail: true,
    })
    if (picked) {
      await openLocation(service, picked.entry.file, picked.entry.line, picked.entry.column)
    }
  } catch (error) {
    console.error('[code-insight] showSymbolEntriesQuickPick failed', error)
  }
}

// ---- 定义候选（B1/B2/B4）：内容相同的副本折叠成组，多副本可二级展开 ----

interface DefinitionGroupQuickPickItem extends vscode.QuickPickItem {
  readonly group: DefinitionGroup
}

interface DefinitionCopyQuickPickItem extends vscode.QuickPickItem {
  readonly entry: SymbolEntry
}

/**
 * 组 label 在 vscode 层用 l10n 组装：`名称 · included/not included · N copies · 条件`。
 * core 的 `formatDefinitionLabel` 保持纯英文/稳定测试，不参与本地化展示。
 */
function localizedDefinitionLabel(
  group: DefinitionGroup,
  included: boolean | undefined,
): string {
  const parts = [group.representative.name]
  if (included !== undefined) {
    parts.push(included ? vscode.l10n.t('included') : vscode.l10n.t('not included'))
  }
  if (group.copies > 1) {
    parts.push(vscode.l10n.t('{0} copies', String(group.copies)))
  }
  if (group.conditional) {
    const condition = group.representative.condition
    if (condition === undefined) {
      // 防御外部构造的 group：conditional 为 true 但条件文本缺失
      parts.push(vscode.l10n.t('conditional'))
    } else if (condition !== '') {
      parts.push(vscode.l10n.t('conditional: {0}', condition))
    }
  }
  return parts.join('  ·  ')
}

function toDefinitionGroupItem(
  group: DefinitionGroup,
  sourceFile: string | undefined,
): DefinitionGroupQuickPickItem {
  const representative = group.representative
  return {
    label: localizedDefinitionLabel(
      group,
      sourceFile === undefined ? undefined : group.included,
    ),
    description: `${representative.file}:${representative.line + 1}`,
    detail: kindLabel(representative.kind),
    group,
  }
}

function toDefinitionCopyItem(entry: SymbolEntry): DefinitionCopyQuickPickItem {
  return {
    label: `${entry.file}:${entry.line + 1}`,
    description: kindLabel(entry.kind),
    entry,
  }
}

/**
 * 定义候选（si.gotoDefinition / si.showDefinitionCandidates 共用）：
 * 先按组展示（label 含 included/not included、N copies、条件），
 * 选中多副本组时再弹一层副本列表；单副本组直接打开。
 */
export async function showDefinitionGroupQuickPick(
  service: SymbolService,
  groups: readonly DefinitionGroup[],
  symbolName: string,
  sourceFile?: string,
): Promise<void> {
  try {
    if (groups.length === 0 || typeof vscode.window.showQuickPick !== 'function') {
      return
    }
    const picked = await vscode.window.showQuickPick(
      groups.map((group) => toDefinitionGroupItem(group, sourceFile)),
      {
        placeHolder: vscode.l10n.t('Select the definition of "{0}"', symbolName),
        matchOnDescription: true,
        matchOnDetail: true,
      },
    )
    if (!picked) {
      return
    }
    if (picked.group.copies > 1) {
      const copy = await vscode.window.showQuickPick(
        picked.group.entries.map(toDefinitionCopyItem),
        {
          placeHolder: vscode.l10n.t('Select a copy of "{0}"', symbolName),
          matchOnDescription: true,
        },
      )
      if (!copy) {
        return
      }
      await openLocation(service, copy.entry.file, copy.entry.line, copy.entry.column)
      return
    }
    const representative = picked.group.representative
    await openLocation(service, representative.file, representative.line, representative.column)
  } catch (error) {
    console.error('[code-insight] showDefinitionGroupQuickPick failed', error)
  }
}

/** 调用者列表：label = 调用者函数名，description = 调用点位置，detail = 预览 + 注记。 */
export async function showCallerQuickPick(
  service: SymbolService,
  callers: readonly CallerHit[],
  _symbolName: string,
  sourceFile?: string,
): Promise<void> {
  try {
    if (callers.length === 0 || typeof vscode.window.showQuickPick !== 'function') {
      return
    }
    interface CallerItem extends vscode.QuickPickItem {
      readonly hit: CallerHit
    }
    const table = service.snapshot
    const items: CallerItem[] = callers.map((hit) => ({
      label: hit.from?.name ?? baseName(hit.file),
      description: `${hit.file}:${hit.line + 1}`,
      detail: withListAnnotations(
        hit.preview,
        includedFor(table, sourceFile, hit.file),
        hit.from?.condition,
      ),
      hit,
    }))
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: vscode.l10n.t('Select a call site'),
      matchOnDescription: true,
      matchOnDetail: true,
    })
    if (picked) {
      await openLocation(service, picked.hit.file, picked.hit.line, picked.hit.column)
    }
  } catch (error) {
    console.error('[code-insight] showCallerQuickPick failed', error)
  }
}

/** 引用列表（命令入口的兜底 UI）。 */
export async function showReferenceQuickPick(
  service: SymbolService,
  references: readonly ReferenceHit[],
): Promise<void> {
  try {
    if (references.length === 0 || typeof vscode.window.showQuickPick !== 'function') {
      return
    }
    interface ReferenceItem extends vscode.QuickPickItem {
      readonly hit: ReferenceHit
    }
    const items: ReferenceItem[] = references.map((hit) => ({
      label: `${normalizeRelative(hit.file)}:${hit.line + 1}`,
      description: hit.preview,
      hit,
    }))
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: vscode.l10n.t('Select a reference'),
      matchOnDescription: true,
    })
    if (picked) {
      await openLocation(service, picked.hit.file, picked.hit.line, picked.hit.column)
    }
  } catch (error) {
    console.error('[code-insight] showReferenceQuickPick failed', error)
  }
}
