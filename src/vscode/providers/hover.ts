/**
 * 悬停签名：代码块（c）+ 定义位置 + 声明位置 + 操作提示。
 */
import * as vscode from 'vscode'

import type { SymbolEntry } from '../../shared/types'
import type { SymbolService } from '../service'
import { rankDefinitions } from '../rank-definitions'
import { getWordAt, noopDisposable } from '../util'
import { C_CPP_SELECTOR, sourceFileOf } from './definition'

class SourceInsightHoverProvider implements vscode.HoverProvider {
  constructor(private readonly service: SymbolService) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
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
      const context = {
        sourceFile: sourceFileOf(this.service, document),
        roots: this.service.configuredRoots,
      }
      const ranked = rankDefinitions(entries, context)
      const best = ranked[0] as SymbolEntry
      const signature = (await this.service.signature(best)) ?? best.name

      const sections: string[] = []
      sections.push(`\`\`\`c\n${signature}\n\`\`\``)
      sections.push(
        vscode.l10n.t('Definition: {0}:{1}', best.file, String(best.line + 1)),
      )
      const declaration = rankDefinitions(
        entries.filter(
          (entry) =>
            entry.kind === 'declaration' &&
            !(entry.file === best.file && entry.line === best.line),
        ),
        context,
      )[0]
      if (declaration) {
        sections.push(
          vscode.l10n.t('Declaration: {0}:{1}', declaration.file, String(declaration.line + 1)),
        )
      }
      sections.push(
        vscode.l10n.t('Press F12 to go to the definition, Shift+F12 to find references.'),
      )

      const markdown = new vscode.MarkdownString(sections.join('\n\n'))
      return new vscode.Hover(markdown, hit.range)
    } catch (error) {
      console.error('[code-insight] hover provider failed', error)
      return undefined
    }
  }
}

/** 定义优先于声明；同为定义时取路径/行号最小的，保证悬停稳定。 */

export function registerHoverProvider(service: SymbolService): vscode.Disposable {
  try {
    if (typeof vscode.languages.registerHoverProvider !== 'function') {
      return noopDisposable()
    }
    return vscode.languages.registerHoverProvider(
      C_CPP_SELECTOR,
      new SourceInsightHoverProvider(service),
    )
  } catch (error) {
    console.error('[code-insight] cannot register hover provider', error)
    return noopDisposable()
  }
}
