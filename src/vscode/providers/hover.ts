/**
 * 悬停签名：代码块（c）+ 分组说明（是否被当前文件包含 / 副本数 / 条件编译）
 * + 定义位置 + 声明位置 + 操作提示。
 *
 * 分组说明与 F12 / si.showDefinitionCandidates 使用同一份 `groupDefinitions` 结果，
 * 因此包含/副本/条件的判定一致；具体措辞由本文件按悬停场景单独本地化组织。
 */
import * as vscode from 'vscode'

import { groupDefinitions, type DefinitionGroup } from '../../core/definition-groups'
import type { SymbolService } from '../service'
import { rankDefinitions } from '../rank-definitions'
import { getWordAt, memberPhrase, noopDisposable, parentKindOf } from '../util'
import { C_CPP_SELECTOR, sourceFileOf } from './definition'

/**
 * 把分组折叠信息压成一行（只列适用的部分）：悬停保持简洁。
 *
 * 定义就在当前文件时说明「in this file」：同文件不代表「被当前文件包含」，
 * 不能沿用 included by this file。
 */
function summarizeGroup(group: DefinitionGroup, sourceFile: string | undefined): string {
  const parts: string[] = []
  if (group.representative.file === sourceFile) {
    parts.push(vscode.l10n.t('in this file'))
  } else if (group.included) {
    parts.push(vscode.l10n.t('included by this file'))
  } else {
    parts.push(vscode.l10n.t('not included'))
  }
  if (group.copies > 1) {
    parts.push(vscode.l10n.t('{0} identical copies', String(group.copies)))
  }
  const condition = group.representative.condition
  if (condition) {
    parts.push(vscode.l10n.t('conditional: {0}', condition))
  }
  return parts.join(' · ')
}

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
      const sourceFile = sourceFileOf(this.service, document)
      const context = {
        sourceFile,
        roots: this.service.configuredRoots,
        table: this.service.snapshot,
      }
      const group = groupDefinitions(entries, context)[0]
      if (!group) {
        return undefined
      }
      const best = group.representative
      const signature = (await this.service.signature(best)) ?? best.name

      const sections: string[] = []
      sections.push(`\`\`\`c\n${signature}\n\`\`\``)
      // 成员/枚举常量/全局变量：签名后补一行归属（B3 §3.7）；其他种类保持原样。
      const phrase = memberPhrase(best, parentKindOf(best, this.service.snapshot))
      if (phrase) {
        sections.push(phrase)
      }
      sections.push(summarizeGroup(group, sourceFile))
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
