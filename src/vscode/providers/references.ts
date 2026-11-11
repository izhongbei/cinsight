/**
 * Shift+F12 查找引用。
 * withProgress + 可取消由 SymbolService.references 内部保证；本 Provider 只做协议转换。
 */
import * as vscode from 'vscode'

import type { SymbolService } from '../service'
import { getWordAt, noopDisposable } from '../util'
import { C_CPP_SELECTOR } from './definition'

class SourceInsightReferenceProvider implements vscode.ReferenceProvider {
  constructor(private readonly service: SymbolService) {}

  async provideReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.ReferenceContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.Location[]> {
    try {
      if (token?.isCancellationRequested) {
        return []
      }
      const hit = getWordAt(document, position)
      if (!hit) {
        return []
      }
      // 定义/声明行由 core 的 includeDeclaration=false 排除
      const hits = await this.service.references(hit.word, token)
      if (token?.isCancellationRequested) {
        return []
      }
      return hits.map(
        (reference) =>
          new vscode.Location(
            vscode.Uri.file(this.service.toAbsolute(reference.file)),
            new vscode.Position(Math.max(0, reference.line), Math.max(0, reference.column)),
          ),
      )
    } catch (error) {
      console.error('[rcios-insight] references provider failed', error)
      return []
    }
  }
}

export function registerReferenceProvider(service: SymbolService): vscode.Disposable {
  try {
    if (typeof vscode.languages.registerReferenceProvider !== 'function') {
      return noopDisposable()
    }
    return vscode.languages.registerReferenceProvider(
      C_CPP_SELECTOR,
      new SourceInsightReferenceProvider(service),
    )
  } catch (error) {
    console.error('[rcios-insight] cannot register reference provider', error)
    return noopDisposable()
  }
}
