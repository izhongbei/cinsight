/**
 * F12 / Ctrl+Click 跳转定义。
 * 光标处单词 -> core.findByName（定义在前、声明在后）-> 排序 + 按内容哈希折叠成组
 * -> 每组只把一个代表 Location 交给 VS Code。
 */
import * as vscode from 'vscode'

import { groupDefinitions } from '../../core/definition-groups'
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
      // 多个同名定义（大仓里常有几十份）时先按「与光标文件的远近」排名，再把内容相同的
      // 副本折叠成组：同一个定义在内容相同的多份内核/驱动拷贝里只出一个代表 Location。
      // 组顺序 = 代表的排名顺序（included > 同索引根 > 共享路径前缀 > 种类 > 条件 > 稳定性）。
      // 分组只在原生 F12 折叠展示；完整候选（含副本）由 si.showDefinitionCandidates 提供。
      const groups = groupDefinitions(entries, {
        sourceFile: sourceFileOf(this.service, document),
        roots: this.service.configuredRoots,
        table: this.service.snapshot,
      })
      return groups.map((group) => entryLocation(this.service, group.representative))
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
