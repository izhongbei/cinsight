/**
 * 原生 Call Hierarchy（右键「显示调用层次」）。
 * incoming = core.callersOf；outgoing = core.calleesOf。
 */
import * as vscode from 'vscode'

import type { SymbolEntry } from '../../shared/types'
import type { SymbolService } from '../service'
import { getWordAt, noopDisposable, toVscodeSymbolKind } from '../util'
import { rankDefinitions } from '../rank-definitions'
import { C_CPP_SELECTOR, sourceFileOf } from './definition'

class SourceInsightCallHierarchyProvider implements vscode.CallHierarchyProvider {
  constructor(private readonly service: SymbolService) {}

  async prepareCallHierarchy(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.CallHierarchyItem[] | undefined> {
    try {
      if (token?.isCancellationRequested) {
        return undefined
      }
      const hit = getWordAt(document, position)
      if (!hit) {
        return undefined
      }
      const entries = rankDefinitions(this.service.definitions(hit.word), {
        sourceFile: sourceFileOf(this.service, document),
        roots: this.service.configuredRoots,
      })
      if (entries.length === 0) {
        return undefined
      }
      const items: vscode.CallHierarchyItem[] = []
      for (const entry of entries.slice(0, 20)) {
        const item = this.toItem(entry)
        if (item) {
          items.push(item)
        }
      }
      return items.length > 0 ? items : undefined
    } catch (error) {
      console.error('[code-insight] prepareCallHierarchy failed', error)
      return undefined
    }
  }

  async provideCallHierarchyIncomingCalls(
    item: vscode.CallHierarchyItem,
    token: vscode.CancellationToken,
  ): Promise<vscode.CallHierarchyIncomingCall[]> {
    try {
      const callers = await this.service.callers(item.name, token)
      const result: vscode.CallHierarchyIncomingCall[] = []
      for (const caller of callers) {
        if (!caller.from) {
          continue
        }
        const fromItem = this.toItem(caller.from)
        if (!fromItem) {
          continue
        }
        const range = new vscode.Range(
          Math.max(0, caller.line),
          Math.max(0, caller.column),
          Math.max(0, caller.line),
          Math.max(0, caller.column) + item.name.length,
        )
        result.push(new vscode.CallHierarchyIncomingCall(fromItem, [range]))
      }
      return result
    } catch (error) {
      console.error('[code-insight] provideCallHierarchyIncomingCalls failed', error)
      return []
    }
  }

  async provideCallHierarchyOutgoingCalls(
    item: vscode.CallHierarchyItem,
    token: vscode.CancellationToken,
  ): Promise<vscode.CallHierarchyOutgoingCall[]> {
    try {
      const callees = await this.service.callees(item.name, token)
      const result: vscode.CallHierarchyOutgoingCall[] = []
      for (const callee of callees) {
        const toItem = this.toItem(callee)
        if (!toItem) {
          continue
        }
        // core 只返回被调符号、不返回调用点；用被调符号的定义范围作为 fromRange 近似
        const range = new vscode.Range(
          Math.max(0, callee.line),
          Math.max(0, callee.column),
          Math.max(0, callee.line),
          Math.max(0, callee.column) + callee.name.length,
        )
        result.push(new vscode.CallHierarchyOutgoingCall(toItem, [range]))
      }
      return result
    } catch (error) {
      console.error('[code-insight] provideCallHierarchyOutgoingCalls failed', error)
      return []
    }
  }

  private toItem(entry: SymbolEntry): vscode.CallHierarchyItem | undefined {
    try {
      const startLine = Math.max(0, entry.line)
      const endLine = Math.max(startLine, entry.endLine)
      const uri = vscode.Uri.file(this.service.toAbsolute(entry.file))
      const range = new vscode.Range(startLine, 0, endLine, 0)
      const selectionRange = new vscode.Range(
        startLine,
        Math.max(0, entry.column),
        startLine,
        Math.max(0, entry.column) + entry.name.length,
      )
      return new vscode.CallHierarchyItem(
        toVscodeSymbolKind(entry.kind),
        entry.name,
        entry.file,
        uri,
        range,
        selectionRange,
      )
    } catch (error) {
      console.error('[code-insight] cannot build CallHierarchyItem', error)
      return undefined
    }
  }
}

export function registerCallHierarchyProvider(service: SymbolService): vscode.Disposable {
  try {
    if (typeof vscode.languages.registerCallHierarchyProvider !== 'function') {
      return noopDisposable()
    }
    return vscode.languages.registerCallHierarchyProvider(
      C_CPP_SELECTOR,
      new SourceInsightCallHierarchyProvider(service),
    )
  } catch (error) {
    console.error('[code-insight] cannot register call hierarchy provider', error)
    return noopDisposable()
  }
}
