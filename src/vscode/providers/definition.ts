/**
 * F12 / Ctrl+Click 跳转定义。
 * 光标处单词 -> core.findByName（定义在前、声明在后）-> 全部 Location 交给 VS Code。
 */
import * as vscode from 'vscode'

import { rankDefinitions } from '../rank-definitions'
import type { SymbolService } from '../service'
import { entryLocation, getWordAt, noopDisposable } from '../util'

export const C_CPP_SELECTOR: vscode.DocumentSelector = [
  { language: 'c' },
  { language: 'cpp' },
]

class SourceInsightDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly service: SymbolService) {}

  provideDefinition(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): vscode.ProviderResult<vscode.Definition | vscode.LocationLink[]> {
    try {
      if (token?.isCancellationRequested) {
        return undefined
      }
      const hit = getWordAt(document, position)
      if (!hit) {
        return undefined
      }
      const entries = this.service.definitions(hit.word)
      if (entries.length === 0) {
        return undefined
      }
      // 多个同名定义（大仓里常有几十份）时，把「离光标最近」的排在前面：
      // 同一索引根 > 共享路径前缀 > 定义优先 > 头文件/源文件偏好
      const ranked = rankDefinitions(entries, {
        sourceFile: sourceFileOf(this.service, document),
        roots: this.service.configuredRoots,
      })
      return ranked.map((entry) => entryLocation(this.service, entry))
    } catch (error) {
      console.error('[code-insight] definition provider failed', error)
      return undefined
    }
  }
}

/** 光标所在文件的 workspace 相对路径（无法换算时 undefined）。 */
export function sourceFileOf(
  service: SymbolService,
  document: vscode.TextDocument | undefined,
): string | undefined {
  try {
    const fsPath = document?.uri?.fsPath
    if (!fsPath) return undefined
    const relative = service.toRelative(fsPath)
    return relative && !relative.startsWith('../') ? relative.replace(/\\/g, '/') : undefined
  } catch {
    return undefined
  }
}

export function registerDefinitionProvider(service: SymbolService): vscode.Disposable {
  try {
    if (typeof vscode.languages.registerDefinitionProvider !== 'function') {
      return noopDisposable()
    }
    return vscode.languages.registerDefinitionProvider(
      C_CPP_SELECTOR,
      new SourceInsightDefinitionProvider(service),
    )
  } catch (error) {
    console.error('[code-insight] cannot register definition provider', error)
    return noopDisposable()
  }
}
