/**
 * 调用关系图的 HTML（纯字符串生成，不依赖 vscode，可单测）。
 * 所有代码内容都经 escapeHtml / textContent 处理；脚本使用 nonce + CSP。
 */
import type { CallGraphState } from './call-graph-model'

export interface RenderOptions {
  readonly cspSource: string
  readonly nonce: string
  /** 翻译函数（由 vscode.l10n.t 注入） */
  readonly t: (message: string, ...args: unknown[]) => string
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function renderCallGraphHtml(options: RenderOptions): string {
  const { nonce, cspSource, t } = options
  const csp = [
    "default-src 'none'",
    `style-src ${cspSource} 'unsafe-inline'`,
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
  <button class="primary" data-action="refresh" title="${escapeHtml(t('Rebuild the graph from the function under the cursor'))}">${escapeHtml(t('Refresh'))}</button>
  <span class="hint">${escapeHtml(t('Click a name to jump · + to expand · − to collapse'))}</span>
</header>
<div id="error"></div>
<div id="columns">
  <div class="column"><div class="column-title">${escapeHtml(t('Callers'))}</div><div id="callers"></div></div>
  <div class="column"><div class="column-title">${escapeHtml(t('Current function'))}</div><div id="root"></div></div>
  <div class="column"><div class="column-title">${escapeHtml(t('Callees'))}</div><div id="callees"></div></div>
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

