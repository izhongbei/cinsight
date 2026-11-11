/**
 * VS Code 层的小工具：取词、位置映射、进度包装、容错打开文件。
 * 约定：这里所有函数都不抛异常（除明确声明的 openLocation 内部已 catch）。
 */
import * as vscode from 'vscode'

import type { SymbolEntry, SymbolKind } from '../shared/types'
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

/** core 的 SymbolKind（function/declaration/macro） -> vscode.SymbolKind。 */
export function toVscodeSymbolKind(kind: SymbolKind): vscode.SymbolKind {
  switch (kind) {
    case 'macro':
      return vscode.SymbolKind.Constant
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
    case 'function':
    default:
      return vscode.l10n.t('Function')
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
