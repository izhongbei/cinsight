/**
 * VS Code 层的小工具：取词、位置映射、进度包装、容错打开文件。
 * 约定：这里所有函数都不抛异常（除明确声明的 openLocation 内部已 catch）。
 */
import * as vscode from 'vscode'

import type { SymbolEntry, SymbolKind, SymbolTable } from '../shared/types'
import { dirOfRel } from './paths'

/** 光标处的标识符（允许 `foo`、`obj->member` 的成员、宏名）。 */
export interface WordHit {
  readonly word: string
  readonly range: vscode.Range
  readonly document: vscode.TextDocument
  readonly position: vscode.Position
}

const WORD_PATTERN = /[A-Za-z_]\w*/

export function getWordAt(
  document: vscode.TextDocument,
  position: vscode.Position,
): WordHit | undefined {
  try {
    const range = document.getWordRangeAtPosition(position, WORD_PATTERN)
    if (range) {
      // 用行文本 + 列区间取词，比 getText(range) 更贴近真实 API 语义，
      // 且不依赖宿主对多行 range 的实现细节。
      let word = ''
      try {
        const lineText = document.lineAt(range.start.line).text
        word = lineText.slice(range.start.character, range.end.character)
      } catch {
        word = ''
      }
      if (!word) {
        try {
          word = document.getText(range)
        } catch {
          word = ''
        }
      }
      if (word) {
        return { word, range, document, position }
      }
    }
  } catch (error) {
    console.error('[code-insight] getWordRangeAtPosition failed', error)
  }
  // 兜底：部分 mock / 老版本 API 行为差异时直接扫该行文本
  try {
    const lineText = document.lineAt(position.line).text
    const regex = new RegExp(WORD_PATTERN.source, 'g')
    let match: RegExpExecArray | null
    while ((match = regex.exec(lineText)) !== null) {
      const start = match.index
      const end = start + match[0].length
      if (position.character >= start && position.character <= end) {
        return {
          word: match[0],
          range: new vscode.Range(position.line, start, position.line, end),
          document,
          position,
        }
      }
    }
  } catch (error) {
    console.error('[code-insight] fallback word scan failed', error)
  }
  return undefined
}

/** 当前活动编辑器光标处的单词；无编辑器/未打开文件时 undefined。 */
export function currentWord(): WordHit | undefined {
  try {
    const editor = vscode.window.activeTextEditor
    if (!editor || !editor.document) {
      return undefined
    }
    return getWordAt(editor.document, editor.selection.active)
  } catch (error) {
    console.error('[code-insight] active editor word lookup failed', error)
    return undefined
  }
}

/** core 的 SymbolKind -> vscode.SymbolKind。 */
export function toVscodeSymbolKind(kind: SymbolKind): vscode.SymbolKind {
  switch (kind) {
    case 'macro':
      return vscode.SymbolKind.Constant
    case 'struct':
    case 'union':
      return vscode.SymbolKind.Struct
    case 'enum':
      return vscode.SymbolKind.Enum
    case 'typedef':
      return vscode.SymbolKind.Class
    // B3 v5 新增三类：大纲里成员/枚举常量/全局变量用 VS Code 原生图标
    case 'member':
      return vscode.SymbolKind.Field
    case 'enumConstant':
      return vscode.SymbolKind.EnumMember
    case 'variable':
      return vscode.SymbolKind.Variable
    case 'declaration':
    case 'function':
    default:
      return vscode.SymbolKind.Function
  }
}

/** 符号种类的人类可读名称（用户可见，走 l10n）。 */
export function kindLabel(kind: SymbolKind): string {
  switch (kind) {
    case 'declaration':
      return vscode.l10n.t('Declaration')
    case 'macro':
      return vscode.l10n.t('Macro')
    case 'struct':
      return vscode.l10n.t('Struct')
    case 'union':
      return vscode.l10n.t('Union')
    case 'enum':
      return vscode.l10n.t('Enum')
    case 'typedef':
      return vscode.l10n.t('Typedef')
    case 'member':
      return vscode.l10n.t('Member')
    case 'enumConstant':
      return vscode.l10n.t('Enum Constant')
    case 'variable':
      return vscode.l10n.t('Variable')
    case 'function':
    default:
      return vscode.l10n.t('Function')
  }
}

/** 可作为「成员归属」父类型的符号种类（struct/union/enum/typedef）。 */
const PARENT_KINDS: readonly SymbolKind[] = ['struct', 'union', 'enum', 'typedef']

/** 扫描器给匿名类型占位用的 parent 名；UI 上应视为「没有父级」。 */
const ANONYMOUS_PARENT = '<anonymous>'

/** 有效父类型名：匿名类型（`<anonymous>`）与缺失 parent 一律返回 undefined。 */
function namedParentOf(entry: SymbolEntry): string | undefined {
  return entry.parent && entry.parent !== ANONYMOUS_PARENT ? entry.parent : undefined
}

/**
 * 成员/枚举常量父类型的种类：查快照里的同名类型符号，同文件优先，其次按
 * struct > union > enum > typedef 取第一个（typedef 别名只在前者都不存在时使用）。
 * 查不到（旧快照/无表/父级已被删）返回 undefined，调用方退化掉 `struct` 前缀。
 */
export function parentKindOf(entry: SymbolEntry, table?: SymbolTable): SymbolKind | undefined {
  const parent = namedParentOf(entry)
  if (!parent || !table) {
    return undefined
  }
  try {
    const candidates = table
      .findByName(parent)
      .filter((candidate) => PARENT_KINDS.includes(candidate.kind))
    if (candidates.length === 0) {
      return undefined
    }
    const sameFile = candidates.filter((candidate) => candidate.file === entry.file)
    const pool = sameFile.length > 0 ? sameFile : candidates
    for (const kind of PARENT_KINDS) {
      if (pool.some((candidate) => candidate.kind === kind)) {
        return kind
      }
    }
    return pool[0]?.kind
  } catch (error) {
    console.error('[code-insight] parent kind lookup failed', error)
    return undefined
  }
}

/**
 * 成员/枚举常量/全局变量的归属描述（B3 §3.7），hover 与搜索列表共用：
 * `member of struct sk_buff` / `enumerator of enum foo` / `variable`。
 * 其他符号种类返回 undefined（调用方使用 kindLabel）。
 */
export function memberPhrase(entry: SymbolEntry, parentKind?: SymbolKind): string | undefined {
  const parent = namedParentOf(entry)
  switch (entry.kind) {
    case 'member':
      if (!parent) {
        return vscode.l10n.t('Member')
      }
      if (parentKind === 'struct') {
        return vscode.l10n.t('member of struct {0}', parent)
      }
      if (parentKind === 'union') {
        return vscode.l10n.t('member of union {0}', parent)
      }
      return vscode.l10n.t('member of {0}', parent)
    case 'enumConstant':
      return parent
        ? vscode.l10n.t('enumerator of enum {0}', parent)
        : // 没有 parent 时与 kindLabel 保持同一个人可读名称（不再用 "Enumerator"）。
          kindLabel('enumConstant')
    case 'variable':
      return vscode.l10n.t('variable')
    default:
      return undefined
  }
}

/** SymbolEntry 的整段范围（定义首行 -> 函数体结束行）。 */
export function fullRangeOf(entry: SymbolEntry): vscode.Range {
  const startLine = Math.max(0, entry.line)
  const endLine = Math.max(startLine, entry.endLine)
  return new vscode.Range(startLine, 0, endLine, 0)
}

/** 名字本身的范围。 */
export function nameRangeOf(entry: SymbolEntry): vscode.Range {
  const line = Math.max(0, entry.line)
  const column = Math.max(0, entry.column)
  return new vscode.Range(line, column, line, column + entry.name.length)
}

/** 只提供绝对路径换算能力的最小接口，避免 util <-> service 的运行时循环依赖。 */
export interface PathResolver {
  toAbsolute(relPath: string): string
}

/** SymbolEntry -> vscode.Location。 */
export function entryLocation(resolver: PathResolver, entry: SymbolEntry): vscode.Location {
  return new vscode.Location(
    vscode.Uri.file(resolver.toAbsolute(entry.file)),
    new vscode.Position(Math.max(0, entry.line), Math.max(0, entry.column)),
  )
}

/** 符号的「位置」容器名（符号搜索的 containerName，用目录）。 */
export function containerNameOf(entry: SymbolEntry): string {
  return dirOfRel(entry.file) || entry.file
}

/** 创建永不取消的 CancellationToken（vscode.window.withProgress 不可用时兜底）。 */
export function neverCancelledToken(): vscode.CancellationToken {
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  }
  return token as unknown as vscode.CancellationToken
}

export type ProgressLike = vscode.Progress<{ message?: string; increment?: number }>

/**
 * `window.withProgress` 的容错包装：mock/极简宿主没有该 API 时直接执行任务。
 * 返回值与任务一致；任务抛错由调用方处理（不会被误判成 API 不可用而重跑）。
 */
export async function withProgress<T>(
  title: string,
  task: (progress: ProgressLike, token: vscode.CancellationToken) => Promise<T>,
  cancellable = true,
): Promise<T> {
  let available = false
  try {
    available = typeof vscode.window.withProgress === 'function'
  } catch {
    available = false
  }
  if (available) {
    let location = 15 as unknown as vscode.ProgressLocation
    try {
      if (typeof vscode.ProgressLocation === 'object' && vscode.ProgressLocation) {
        location = vscode.ProgressLocation.Notification
      }
    } catch {
      // 保留数值兜底
    }
    let pending: Thenable<T>
    try {
      pending = vscode.window.withProgress({ location, title, cancellable }, task)
    } catch (error) {
      // 仅当 withProgress 自身的同步调用失败时才退化为直接执行
      console.error('[code-insight] withProgress unavailable, running task directly', error)
      const fallbackProgress: ProgressLike = { report: () => undefined }
      return task(fallbackProgress, neverCancelledToken())
    }
    return await pending
  }
  const progress: ProgressLike = { report: () => undefined }
  return task(progress, neverCancelledToken())
}

/** 是否 AbortError（core 用 error.name='AbortError' 约定）。 */
export function isAbortError(error: unknown): boolean {
  if (!error) {
    return false
  }
  if (error instanceof Error) {
    return error.name === 'AbortError' || /aborted/i.test(error.message)
  }
  return false
}

/** 把 Promise 的 rejection 转成 undefined，并写日志（Provider 内部使用）。 */
export async function quiet<T>(
  label: string,
  work: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (!isAbortError(error)) {
      console.error(`[code-insight] ${label} failed`, error)
    }
    return fallback
  }
}

/**
 * 打开「workspace 相对文件 + 0-based 行列」并选中该位置。
 * 行号/列号会 clamp 到文档范围，文件不存在时只记日志。
 */
export async function openLocation(
  resolver: PathResolver,
  file: string,
  line: number,
  column = 0,
  preview = false,
): Promise<void> {
  try {
    const uri = vscode.Uri.file(resolver.toAbsolute(file))
    const document = await vscode.workspace.openTextDocument(uri)
    const safeLine = Math.min(Math.max(0, Math.floor(line)), Math.max(0, document.lineCount - 1))
    let lineText = ''
    try {
      lineText = document.lineAt(safeLine).text
    } catch {
      lineText = ''
    }
    const safeColumn = Math.min(Math.max(0, Math.floor(column)), lineText.length)
    const position = new vscode.Position(safeLine, safeColumn)
    await vscode.window.showTextDocument(document, {
      selection: new vscode.Range(position, position),
      preview,
    })
  } catch (error) {
    console.error(`[code-insight] cannot open ${file}:${line + 1}`, error)
  }
}

// ---- 消息类 API 的容错包装（命令/状态栏用） ----

export async function showInformationMessage(message: string, ...items: string[]): Promise<string | undefined> {
  try {
    if (typeof vscode.window.showInformationMessage === 'function') {
      return await vscode.window.showInformationMessage(message, ...items)
    }
  } catch (error) {
    console.error('[code-insight] showInformationMessage failed', error)
  }
  return undefined
}

export async function showWarningMessage(message: string, ...items: string[]): Promise<string | undefined> {
  try {
    if (typeof vscode.window.showWarningMessage === 'function') {
      return await vscode.window.showWarningMessage(message, ...items)
    }
  } catch (error) {
    console.error('[code-insight] showWarningMessage failed', error)
  }
  return undefined
}

export async function showErrorMessage(message: string, ...items: string[]): Promise<string | undefined> {
  try {
    if (typeof vscode.window.showErrorMessage === 'function') {
      return await vscode.window.showErrorMessage(message, ...items)
    }
  } catch (error) {
    console.error('[code-insight] showErrorMessage failed', error)
  }
  return undefined
}

/** 安全地执行一个 VS Code 内置命令。 */
export async function executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
  try {
    if (typeof vscode.commands.executeCommand === 'function') {
      return await vscode.commands.executeCommand(command, ...args)
    }
  } catch (error) {
    console.error(`[code-insight] command ${command} failed`, error)
  }
  return undefined
}

/** 可无副作用 dispose 的 Disposable。 */
export function noopDisposable(): vscode.Disposable {
  return { dispose: () => undefined }
}
