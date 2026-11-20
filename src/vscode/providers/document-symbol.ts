/**
 * Ctrl+Shift+O 大纲：当前文件里的函数/声明/类型/宏，v5 起成员与枚举常量嵌套在
 * 所属 struct/union/enum（或 typedef 别名）下（B3 §3.7）。
 *
 * 嵌套逻辑放在纯函数 `core/outline.ts`，这里只负责 clamp 范围与构造 DocumentSymbol。
 * 父子范围可能不互相包含（匿名 typedef 的别名行在成员下方），因此父节点的**完整范围**
 * 会扩展到覆盖子节点，selectionRange 仍留在别名行。
 */
import * as vscode from 'vscode'

import { buildOutlineTree, type OutlineNode } from '../../core/outline'
import type { SymbolService } from '../service'
import {
  clampSymbolRanges,
  extendRangesOverChildren,
  type SymbolSpan,
} from '../symbol-ranges'
import { kindLabel, noopDisposable, toVscodeSymbolKind } from '../util'
import { C_CPP_SELECTOR } from './definition'

class SourceInsightDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  constructor(private readonly service: SymbolService) {}

  provideDocumentSymbols(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): vscode.DocumentSymbol[] {
    try {
      if (token?.isCancellationRequested) {
        return []
      }
      const relPath = this.service.toRelative(document.uri.fsPath)
      const entries = this.service.fileSymbols(relPath)
      const lineCount = document.lineCount
      const lineLength = (line: number): number => {
        try {
          return document.lineAt(line).text.length
        } catch {
          return 0
        }
      }
      const symbols: vscode.DocumentSymbol[] = []
      for (const node of buildOutlineTree(entries)) {
        const symbol = toDocumentSymbol(node, lineCount, lineLength)
        if (symbol) {
          symbols.push(symbol)
        }
      }
      return symbols
    } catch (error) {
      console.error('[code-insight] document symbol provider failed', error)
      return []
    }
  }
}

/**
 * OutlineNode -> vscode.DocumentSymbol（递归）。
 *
 * 索引可能比当前文档旧（文件被改动过）：clamp 后仍越界的条目整棵子树跳过，
 * 避免把子节点挂到不存在的父范围里。
 */
function toDocumentSymbol(
  node: OutlineNode,
  lineCount: number,
  lineLength: (line: number) => number,
): vscode.DocumentSymbol | undefined {
  const entry = node.entry
  const ranges = clampSymbolRanges(entry, lineCount, lineLength)
  if (!ranges) {
    return undefined
  }
  try {
    const children: vscode.DocumentSymbol[] = []
    for (const child of node.children) {
      const childSymbol = toDocumentSymbol(child, lineCount, lineLength)
      if (childSymbol) {
        children.push(childSymbol)
      }
    }
    // 匿名 typedef 的成员在别名行上方：完整范围必须覆盖子节点，否则 breadcrumbs /
    // sticky scroll 看不到父节点。selectionRange 仍用别名行（ranges.startLine）。
    const span = extendRangesOverChildren(ranges, children.map(documentSymbolSpan))
    const symbol = new vscode.DocumentSymbol(
      entry.name,
      kindLabel(entry.kind),
      toVscodeSymbolKind(entry.kind),
      new vscode.Range(span.startLine, 0, span.endLine, span.endCharacter),
      new vscode.Range(ranges.startLine, ranges.selectionStart, ranges.startLine, ranges.selectionEnd),
    )
    if (Array.isArray(symbol.children)) {
      for (const childSymbol of children) {
        symbol.children.push(childSymbol)
      }
    }
    return symbol
  } catch (error) {
    // 单条符号异常不应让整个大纲失败
    console.error(`[code-insight] skip invalid document symbol ${entry.name}`, error)
    return undefined
  }
}

/** DocumentSymbol 的完整范围（子节点扩展父范围时使用）。 */
function documentSymbolSpan(symbol: vscode.DocumentSymbol): SymbolSpan {
  return {
    startLine: symbol.range.start.line,
    endLine: symbol.range.end.line,
    endCharacter: symbol.range.end.character,
  }
}

export function registerDocumentSymbolProvider(service: SymbolService): vscode.Disposable {
  try {
    if (typeof vscode.languages.registerDocumentSymbolProvider !== 'function') {
      return noopDisposable()
    }
    return vscode.languages.registerDocumentSymbolProvider(
      C_CPP_SELECTOR,
      new SourceInsightDocumentSymbolProvider(service),
    )
  } catch (error) {
    console.error('[code-insight] cannot register document symbol provider', error)
    return noopDisposable()
  }
}
