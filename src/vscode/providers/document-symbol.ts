/**
 * Ctrl+Shift+O 大纲：当前文件里的函数/声明/函数式宏。
 */
import * as vscode from 'vscode'

import type { SymbolService } from '../service'
import { clampSymbolRanges } from '../symbol-ranges'
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
      const symbols: vscode.DocumentSymbol[] = []
      const lineCount = document.lineCount
      const lineLength = (line: number): number => {
        try {
          return document.lineAt(line).text.length
        } catch {
          return 0
        }
      }
      for (const entry of entries) {
        // 索引可能比当前文档旧（文件被改动过）：clamp 后仍越界的条目直接跳过
        const ranges = clampSymbolRanges(entry, lineCount, lineLength)
        if (!ranges) continue
        try {
          symbols.push(
            new vscode.DocumentSymbol(
              entry.name,
              kindLabel(entry.kind),
              toVscodeSymbolKind(entry.kind),
              new vscode.Range(ranges.startLine, 0, ranges.endLine, ranges.endCharacter),
              new vscode.Range(ranges.startLine, ranges.selectionStart, ranges.startLine, ranges.selectionEnd),
            ),
          )
        } catch (error) {
          // 单条符号异常不应让整个大纲失败
          console.error(`[code-insight] skip invalid document symbol ${entry.name}`, error)
        }
      }
      return symbols
    } catch (error) {
      console.error('[code-insight] document symbol provider failed', error)
      return []
    }
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
