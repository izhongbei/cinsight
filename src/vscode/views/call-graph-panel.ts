/**
 * 调用关系面板（Source Insight Relation 风格）：
 *   单视图 Relation：单列紧凑树，Callers / Callees 两个可折叠 section。
 * 节点可逐层展开/折叠、点击名字跳到定义；Set as root 重建根并自动展开双向。
 * 数据来自 `service.callers/callees`（底层走引用倒排索引，通常是毫秒级）。
 */
import * as vscode from 'vscode'

import {
  CallGraphModel,
  type CallGraphState,
  type Direction,
  type GraphTree,
  nodeIdOf,
} from '../call-graph-model'
import type { SymbolService } from '../service'
import type { SymbolEntry } from '../../shared/types'
import { renderCallGraphHtml } from '../call-graph-html'
import { currentWord, findVisibleEditorColumn, openLocation } from '../util'

interface WebviewMessage {
  readonly type:
    | 'ready'
    | 'expand'
    | 'collapse'
    | 'open'
    | 'refresh'
    | 'newRoot'
    | 'setRoot'
    | 'collapseAll'
  readonly id?: string
  readonly direction?: Direction
}

export class CallGraphPanel implements vscode.Disposable {
  private static current: CallGraphPanel | undefined
  private readonly model = new CallGraphModel()
  private readonly disposables: vscode.Disposable[] = []
  /** 按方向计数：callers / callees 可以同时加载（Relation 两个 section 各自显示 loading）。 */
  private readonly loadingCounts = { callers: 0, callees: 0 }
  /** 正在展开的节点，供行内显示省略号。 */
  private readonly loadingIds = new Map<string, number>()
  /** re-root 的代次：旧请求返回时若根已变化，丢弃结果。 */
  private generation = 0

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly service: SymbolService,
  ) {
    this.panel.webview.html = renderCallGraphHtml({
      cspSource: this.panel.webview.cspSource,
      nonce: `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`,
      t: (message: string, ...args: unknown[]) =>
        (vscode.l10n.t as (m: string, ...rest: unknown[]) => string)(message, ...args),
    })
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message: WebviewMessage) => {
        void this.handleMessage(message)
      }),
      this.panel.onDidDispose(() => this.dispose()),
    )
  }

  /** 打开（或复用）面板；root 取当前光标处函数的定义。 */
  static async show(service: SymbolService, explicit?: SymbolEntry): Promise<CallGraphPanel | undefined> {
    const root = explicit ?? resolveEntryUnderCursor(service)
    if (!root) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('No function found under the cursor. Put the cursor on a function name and run the command again.'),
      )
      return undefined
    }
    if (CallGraphPanel.current) {
      CallGraphPanel.current.panel.reveal(vscode.ViewColumn.Beside, true)
      await CallGraphPanel.current.resetTo(root)
      return CallGraphPanel.current
    }
    const panel = vscode.window.createWebviewPanel(
      'si.callGraph',
      vscode.l10n.t('Call Graph: {0}', root.name),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    )
    const instance = new CallGraphPanel(panel, service)
    CallGraphPanel.current = instance
    await instance.resetTo(root)
    return instance
  }

  static disposeCurrent(): void {
    CallGraphPanel.current?.dispose()
  }

  private get busy(): boolean {
    return this.loadingCounts.callers > 0 || this.loadingCounts.callees > 0
  }

  private async resetTo(root: SymbolEntry): Promise<void> {
    this.generation++
    this.model.setRoot(root)
    this.panel.title = vscode.l10n.t('Call Graph: {0}', root.name)
    const id = nodeIdOf(root)
    // Relation 面板默认同时展开 callers/callees；setRoot 也走这里（不跳编辑器）。
    await this.expandDirection(id, 'callers', { notify: false })
    await this.expandDirection(id, 'callees', { notify: false })
    this.sendState()
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'ready':
          this.sendState()
          break
        case 'refresh':
        case 'newRoot': {
          const entry = resolveEntryUnderCursor(this.service)
          if (entry) await this.resetTo(entry)
          break
        }
        case 'setRoot': {
          if (!message.id) break
          const tree = this.model.findTree(message.id)
          if (!tree) break
          // 用节点重建 SymbolEntry，直接重置模型；不会打开/移动编辑器。
          await this.resetTo(entryOf(tree))
          break
        }
        case 'open': {
          const tree = message.id ? this.model.findTree(message.id) : undefined
          if (tree) {
            // 面板通常在 ViewColumn.Beside；不能在同一组打开，否则会把面板顶掉/重排。
            // 优先跳到已经打开该文件的代码组，否则跳到与面板不同的另一组。
            const visibleColumn = findVisibleEditorColumn(this.service, tree.node.file)
            const panelColumn = this.panel.viewColumn
            const fallback =
              panelColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One
            // 可见编辑器不能和面板同组（否则会把面板挤掉），同组时改用另一组。
            const targetColumn =
              visibleColumn !== undefined && visibleColumn !== panelColumn
                ? visibleColumn
                : fallback
            await openLocation(
              this.service,
              tree.node.file,
              tree.node.line,
              tree.node.column,
              false,
              targetColumn,
            )
          }
          break
        }
        case 'expand':
          if (message.id && message.direction) {
            await this.expandDirection(message.id, message.direction, { notify: true })
          }
          break
        case 'collapse':
          if (message.id && message.direction) {
            this.model.collapse(message.id, message.direction)
            this.sendState()
          }
          break
        case 'collapseAll':
          this.model.collapseAll()
          this.sendState()
          break
        default:
          break
      }
    } catch (error) {
      console.error('[code-insight] call graph action failed', error)
      this.panel.webview.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async expandDirection(
    id: string,
    direction: Direction,
    options: { notify: boolean },
  ): Promise<void> {
    const tree = this.model.findTree(id)
    if (!tree) return
    const name = tree.node.name
    const generation = this.generation
    this.beginLoading(id, direction)
    this.sendState()
    try {
      if (direction === 'callees') {
        const entries = await this.service.callees(name)
        if (generation === this.generation) {
          this.model.mergeNeighbors(id, 'callees', entries)
        }
      } else {
        const hits = await this.service.callers(name)
        const entries = hits
          .map((hit) => hit.from)
          .filter((entry): entry is SymbolEntry => entry !== undefined)
        if (generation === this.generation) {
          this.model.mergeNeighbors(id, 'callers', entries)
        }
      }
    } finally {
      this.endLoading(id, direction)
      this.sendState()
    }
    void options
  }

  private beginLoading(id: string, direction: Direction): void {
    this.loadingCounts[direction]++
    this.loadingIds.set(id, (this.loadingIds.get(id) ?? 0) + 1)
  }

  private endLoading(id: string, direction: Direction): void {
    this.loadingCounts[direction] = Math.max(0, this.loadingCounts[direction] - 1)
    const count = (this.loadingIds.get(id) ?? 0) - 1
    if (count <= 0) this.loadingIds.delete(id)
    else this.loadingIds.set(id, count)
  }

  private sendState(): void {
    const state: CallGraphState = this.model.toState()
    void this.panel.webview.postMessage({
      type: 'state',
      state,
      busy: this.busy,
      loading: {
        callers: this.loadingCounts.callers > 0,
        callees: this.loadingCounts.callees > 0,
      },
      loadingIds: [...this.loadingIds.keys()],
      rootName: state.root?.node.name,
    })
    if (state.root) {
      this.panel.title = vscode.l10n.t('Call Graph: {0}', state.root.node.name)
    }
  }

  dispose(): void {
    if (CallGraphPanel.current === this) CallGraphPanel.current = undefined
    for (const disposable of this.disposables.splice(0)) {
      try {
        disposable.dispose()
      } catch {
        // ignore
      }
    }
    try {
      this.panel.dispose()
    } catch {
      // ignore
    }
  }
}

function entryOf(tree: GraphTree): SymbolEntry {
  return {
    name: tree.node.name,
    kind: tree.node.kind,
    file: tree.node.file,
    line: tree.node.line,
    endLine: tree.node.line,
    column: tree.node.column,
  }
}

function resolveEntryUnderCursor(service: SymbolService): SymbolEntry | undefined {
  const hit = currentWord()
  if (!hit) return undefined
  const entries = service.definitions(hit.word)
  return entries[0]
}

export function showCallGraph(service: SymbolService, entry?: SymbolEntry): Promise<CallGraphPanel | undefined> {
  return CallGraphPanel.show(service, entry)
}
