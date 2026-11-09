/**
 * Ctrl+Shift+O 大纲：当前文件里的函数/声明/函数式宏。
 */
import * as vscode from 'vscode'

import type { SymbolService } from '../service'
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
      for (const entry of entries) {
        const startLine = Math.max(0, entry.line)
        const endLine = Math.max(startLine, entry.endLine)
        let endCharacter = entry.column + entry.name.length
        try {
          const lineText = document.lineAt(Math.min(endLine, Math.max(0, document.lineCount - 1))).text
          endCharacter = lineText.length
        } catch {
          // 文档行数不足时退化为名字结束列
        }
        const fullRange = new vscode.Range(startLine, 0, endLine, Math.max(0, endCharacter))
        const selectionRange = new vscode.Range(
          startLine,
          Math.max(0, entry.column),
          startLine,
          Math.max(0, entry.column) + entry.name.length,
        )
        symbols.push(
          new vscode.DocumentSymbol(
            entry.name,
            kindLabel(entry.kind),
            toVscodeSymbolKind(entry.kind),
            fullRange,
            selectionRange,
          ),
        )
      }
      return symbols
    } catch (error) {
      console.error('[source-insight-c] document symbol provider failed', error)
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
    console.error('[source-insight-c] cannot register document symbol provider', error)
    return noopDisposable()
  }
}
