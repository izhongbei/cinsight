/**
 * 调用关系图面板（Source Insight Relation 风格）：
 *   左列 = callers（谁调用我），中列 = 当前函数，右列 = callees（我调用了谁）。
 * 节点可逐层展开/折叠、点击名字跳到定义；数据来自 `service.callers/callees`
 * （底层走引用倒排索引，通常是毫秒级）。
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
import { currentWord, openLocation } from '../util'

interface WebviewMessage {
  readonly type: 'ready' | 'expand' | 'collapse' | 'open' | 'refresh' | 'newRoot'
  readonly id?: string
  readonly direction?: Direction
}

export class CallGraphPanel implements vscode.Disposable {
  private static current: CallGraphPanel | undefined
  private readonly model = new CallGraphModel()
  private readonly disposables: vscode.Disposable[] = []
  private busy = false

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

  private async resetTo(root: SymbolEntry): Promise<void> {
    this.model.setRoot(root)
    this.panel.title = vscode.l10n.t('Call Graph: {0}', root.name)
    await this.expandDirection(nodeIdOf(root), 'callers', { notify: false })
    await this.expandDirection(nodeIdOf(root), 'callees', { notify: false })
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
        case 'open': {
          const tree = message.id ? this.model.findTree(message.id) : undefined
          if (tree) {
            await openLocation(this.service, tree.node.file, tree.node.line, tree.node.column)
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
    this.busy = true
    this.sendState()
    try {
      if (direction === 'callees') {
        const entries = await this.service.callees(name)
        this.model.mergeNeighbors(id, 'callees', entries)
      } else {
        const hits = await this.service.callers(name)
        const entries = hits
          .map((hit) => hit.from)
          .filter((entry): entry is SymbolEntry => entry !== undefined)
        this.model.mergeNeighbors(id, 'callers', entries)
      }
    } finally {
      this.busy = false
      this.sendState()
    }
    void options
  }

  private sendState(): void {
    const state: CallGraphState = this.model.toState()
    void this.panel.webview.postMessage({ type: 'state', state, busy: this.busy, rootName: state.root?.node.name })
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

function resolveEntryUnderCursor(service: SymbolService): SymbolEntry | undefined {
  const hit = currentWord()
  if (!hit) return undefined
  const entries = service.definitions(hit.word)
  return entries[0]
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderHtml(webview: vscode.Webview): string {
  const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ')
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 0 8px 16px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  header {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    padding: 10px 0 8px; position: sticky; top: 0; z-index: 2;
    background: var(--vscode-editor-background);
    border-bottom: 1px solid var(--vscode-widget-border, rgba(128,128,128,.3));
  }
  header .title { font-weight: 600; }
  header .hint { color: var(--vscode-descriptionForeground); font-size: 12px; }
  button {
    font: inherit; cursor: pointer; border-radius: 4px;
    border: 1px solid var(--vscode-button-border, transparent);
    background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.18));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    padding: 2px 8px;
  }
  button:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,.3)); }
  button.primary {
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  #columns { display: flex; gap: 18px; align-items: flex-start; padding-top: 10px; }
  .column { flex: 1 1 0; min-width: 160px; }
  .column > .column-title {
    font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
    color: var(--vscode-descriptionForeground); margin: 0 0 6px 4px;
  }
  .tree { list-style: none; margin: 0; padding: 0; }
  .tree ul { list-style: none; margin: 0 0 0 12px; padding: 0;
    border-left: 1px solid var(--vscode-tree-indentGuidesStroke, rgba(128,128,128,.35)); }
  .node { padding: 2px 0; }
  .row { display: flex; align-items: center; gap: 4px; border-radius: 4px; padding: 1px 4px; }
  .row:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.12)); }
  .toggle {
    width: 16px; height: 16px; line-height: 14px; text-align: center; padding: 0;
    border: none; background: transparent; color: var(--vscode-descriptionForeground);
    font-size: 12px;
  }
  .toggle:hover { background: transparent; color: var(--vscode-foreground); }
  .name { cursor: pointer; color: var(--vscode-textLink-foreground); white-space: nowrap; }
  .name:hover { text-decoration: underline; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .root .name { font-weight: 700; color: var(--vscode-foreground); cursor: default; text-decoration: none; }
  .badge { font-size: 10px; color: var(--vscode-descriptionForeground); }
  .empty { color: var(--vscode-descriptionForeground); font-size: 12px; padding: 4px; }
  .truncated { color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground)); font-size: 11px; padding-left: 20px; }
  #status { position: fixed; right: 12px; bottom: 10px; font-size: 12px; color: var(--vscode-descriptionForeground); }
  #error { color: var(--vscode-errorForeground); font-size: 12px; padding: 6px 0; }
</style>
</head>
<body>
<header>
  <span class="title" id="root-name"></span>
  <span class="hint" id="root-meta"></span>
  <button class="primary" data-action="refresh" title="${escapeHtml(vscode.l10n.t('Rebuild the graph from the function under the cursor'))}">${escapeHtml(vscode.l10n.t('Refresh'))}</button>
  <span class="hint">${escapeHtml(vscode.l10n.t('Click a name to jump · + to expand · − to collapse'))}</span>
</header>
<div id="error"></div>
<div id="columns">
  <div class="column"><div class="column-title">${escapeHtml(vscode.l10n.t('Callers'))}</div><div id="callers"></div></div>
  <div class="column"><div class="column-title">${escapeHtml(vscode.l10n.t('Current function'))}</div><div id="root"></div></div>
  <div class="column"><div class="column-title">${escapeHtml(vscode.l10n.t('Callees'))}</div><div id="callees"></div></div>
</div>
<div id="status"></div>
<script nonce="${nonce}">
(function () {
  const vscode = acquireVsCodeApi();
  const COLORS = {};
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function renderTree(tree, direction, isRoot) {
    const wrap = el('div', 'node' + (isRoot ? ' root' : ''));
    const row = el('div', 'row');
    const children = direction === 'callers' ? tree.callers : direction === 'callees' ? tree.callees : [];
    const expanded = direction === 'callers' ? tree.expandedCallers : direction === 'callees' ? tree.expandedCallees : false;
    const truncated = direction === 'callers' ? tree.truncatedCallers : direction === 'callees' ? tree.truncatedCallees : false;

    if (!isRoot) {
      const toggle = el('button', 'toggle', '');
      if (expanded) {
        toggle.textContent = '−';
        toggle.title = vscode._t ? vscode._t('Collapse') : 'Collapse';
        toggle.addEventListener('click', () => vscode.postMessage({ type: 'collapse', id: tree.node.id, direction }));
      } else {
        toggle.textContent = '+';
        toggle.addEventListener('click', () => vscode.postMessage({ type: 'expand', id: tree.node.id, direction }));
      }
      row.appendChild(toggle);
    } else {
      row.appendChild(el('span', 'toggle', ''));
    }

    const name = el('span', 'name', tree.node.name);
    if (!isRoot) {
      name.title = tree.node.file + ':' + (tree.node.line + 1);
      name.addEventListener('click', () => vscode.postMessage({ type: 'open', id: tree.node.id }));
    } else {
      name.title = tree.node.file + ':' + (tree.node.line + 1);
    }
    row.appendChild(name);
    row.appendChild(el('span', 'meta', tree.node.file + ':' + (tree.node.line + 1)));
    if (truncated) row.appendChild(el('span', 'badge', '…'));
    wrap.appendChild(row);

    if (children.length > 0) {
      const list = el('ul', 'tree');
      for (const child of children) {
        const item = el('li', '');
        item.appendChild(renderTree(child, direction, false));
        list.appendChild(item);
      }
      wrap.appendChild(list);
    } else if (expanded && children.length === 0 && truncated) {
      wrap.appendChild(el('div', 'truncated', '…'));
    }
    return wrap;
  }
  function render(state, busy) {
    const rootName = document.getElementById('root-name');
    const rootMeta = document.getElementById('root-meta');
    const rootBox = document.getElementById('root');
    const callersBox = document.getElementById('callers');
    const calleesBox = document.getElementById('callees');
    rootBox.textContent = '';
    callersBox.textContent = '';
    calleesBox.textContent = '';
    if (!state || !state.root) {
      rootBox.appendChild(el('div', 'empty', 'No function selected.'));
      return;
    }
    rootName.textContent = state.root.node.name;
    rootMeta.textContent = state.root.node.file + ':' + (state.root.node.line + 1);
    rootBox.appendChild(renderTree(state.root, 'root', true));
    renderSide(callersBox, state.root.callers, 'callers', state.root.expandedCallers, state.root.truncatedCallers);
    renderSide(calleesBox, state.root.callees, 'callees', state.root.expandedCallees, state.root.truncatedCallees);
    document.getElementById('status').textContent = busy
      ? 'Loading…'
      : state.truncated ? 'Graph truncated (' + state.nodeCount + ' nodes)' : state.nodeCount + ' nodes';
  }
  function renderSide(box, children, direction, expanded, truncated) {
    if (!children || children.length === 0) {
      if (expanded && truncated) box.appendChild(el('div', 'truncated', '…'));
      else if (expanded) box.appendChild(el('div', 'empty', 'none'));
      else box.appendChild(el('div', 'empty', '−'));
      return;
    }
    const list = el('ul', 'tree');
    for (const child of children) {
      const item = el('li', '');
      item.appendChild(renderTree(child, direction, false));
      list.appendChild(item);
    }
    box.appendChild(list);
    if (truncated) box.appendChild(el('div', 'truncated', '…'));
  }
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'state') {
      render(message.state, message.busy);
    } else if (message.type === 'error') {
      const errorBox = document.getElementById('error');
      errorBox.textContent = message.message || 'error';
    }
  });
  document.querySelectorAll('[data-action="refresh"]').forEach((button) => {
    button.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  });
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`
}

export function showCallGraph(service: SymbolService, entry?: SymbolEntry): Promise<CallGraphPanel | undefined> {
  return CallGraphPanel.show(service, entry)
}
