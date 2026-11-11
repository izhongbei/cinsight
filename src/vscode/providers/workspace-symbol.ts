/**
 * Ctrl+T 全局符号搜索（WorkspaceSymbolProvider）。
 * 未配置/未建好索引时返回空数组，不弹错误。
 */
import * as vscode from 'vscode'

import type { SymbolService } from '../service'
import { containerNameOf, entryLocation, noopDisposable, toVscodeSymbolKind } from '../util'

class SourceInsightWorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
  constructor(private readonly service: SymbolService) {}

  provideWorkspaceSymbols(
    query: string,
    token: vscode.CancellationToken,
  ): vscode.SymbolInformation[] {
    try {
      if (token?.isCancellationRequested) {
        return []
      }
      if (!this.service.ready || !this.service.hasRoots) {
        return []
      }
      const entries = this.service.search(query)
      return entries.map(
        (entry) =>
          new vscode.SymbolInformation(
            entry.name,
            toVscodeSymbolKind(entry.kind),
            containerNameOf(entry),
            entryLocation(this.service, entry),
          ),
      )
    } catch (error) {
      console.error('[code-insight] workspace symbol provider failed', error)
      return []
    }
  }
}

export function registerWorkspaceSymbolProvider(service: SymbolService): vscode.Disposable {
  try {
    if (typeof vscode.languages.registerWorkspaceSymbolProvider !== 'function') {
      return noopDisposable()
    }
    return vscode.languages.registerWorkspaceSymbolProvider(
      new SourceInsightWorkspaceSymbolProvider(service),
    )
  } catch (error) {
    console.error('[code-insight] cannot register workspace symbol provider', error)
    return noopDisposable()
  }
}
