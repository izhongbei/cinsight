/**
 * 调用关系面板的 HTML（纯字符串生成，不依赖 vscode，可单测）。
 * 单视图：Relation（单列紧凑树）；Graph 标签页已在 0.9.6 移除。
 * 静态文案经 escapeHtml，动态内容一律走 textContent；脚本使用 nonce + CSP。
 */

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

/** 嵌入 <script> 的 JSON：转义 `<`（防 </script> 注入）与行分隔符。 */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

export function renderCallGraphHtml(options: RenderOptions): string {
  const { nonce, cspSource, t } = options
  const csp = [
    "default-src 'none'",
    `style-src ${cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ')
  const i18n = {
    callers: t('Callers'),
    callees: t('Callees'),
    setAsRoot: t('Set as root'),
    noCallers: t('No callers'),
    noCallees: t('No callees'),
    loading: t('Loading…'),
    collapse: t('Collapse'),
    expand: t('Expand'),
  }
  const i18nJson = scriptJson(i18n)
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body {
    margin: 0; padding: 0 0 18px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  button { font: inherit; }

  /* ---- Relation header ---- */
  .relation-header {
    position: sticky; top: 0; z-index: 9;
    display: flex; align-items: center; gap: 8px;
    padding: 8px 10px 6px;
    background: var(--vscode-editor-background);
  }
  .root-line { min-width: 0; flex: 1 1 auto; }
  .root-title {
    display: block; font-weight: 600;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .root-meta {
    display: block; margin-top: 1px;
    color: var(--vscode-descriptionForeground); font-size: 11px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .toolbar { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }
  .icon-btn {
    width: 24px; height: 24px; padding: 0;
    display: inline-flex; align-items: center; justify-content: center;
    border: 1px solid transparent; border-radius: 4px;
    background: transparent; color: var(--vscode-icon-foreground, var(--vscode-foreground));
    cursor: pointer; font-size: 14px; line-height: 1;
  }
  .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground, rgba(128,128,128,.15))); }
  .icon-btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }

  /* ---- Relation tree ---- */
  .relation-body { padding: 2px 6px 8px; }
  .relation-section + .relation-section { margin-top: 2px; }
  .section-head {
    display: flex; align-items: center; gap: 5px; width: 100%;
    padding: 4px; border: none; border-radius: 4px;
    background: transparent; color: var(--vscode-foreground);
    cursor: pointer; text-align: left;
  }
  .section-head:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.12)); }
  .section-head:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .section-chevron {
    width: 14px; flex: 0 0 14px; text-align: center;
    color: var(--vscode-descriptionForeground); font-size: 12px;
  }
  .section-title { font-weight: 600; font-size: 12px; }
  .section-loading {
    margin-left: auto; padding-right: 2px;
    color: var(--vscode-descriptionForeground); font-size: 11px;
  }
  .tree-node { min-width: 0; }
  /* 单行行：任何宽度都不换行；名字优先取得宽度，file:line 先收窄、再整体隐藏。 */
  .row {
    position: relative;
    display: flex; flex-wrap: nowrap; align-items: center; gap: 4px;
    padding: 3px 4px; border-radius: 4px;
    cursor: default; outline: none;
  }
  .row:hover, .row:focus-visible { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.12)); }
  .row:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .toggle {
    width: 16px; height: 16px; flex: 0 0 16px; padding: 0;
    border: none; border-radius: 3px; background: transparent;
    color: var(--vscode-descriptionForeground);
    cursor: pointer; font-size: 12px; line-height: 16px; text-align: center;
  }
  .toggle:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.15)); }
  .toggle.placeholder { visibility: hidden; cursor: default; }
  .direction { flex: 0 0 auto; color: var(--vscode-descriptionForeground); font-size: 11px; }
  /* 名字：优先取得宽度，单行省略；只有面板比名字本身还窄时才会出现省略号。 */
  .name {
    flex: 1 1 auto; min-width: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    cursor: pointer;
  }
  .name:hover { color: var(--vscode-textLink-foreground); text-decoration: underline; }
  /* 位置：单行、右对齐；flex-shrink 远大于名字，先收窄省略，窄面板下整体隐藏。 */
  .meta {
    flex: 0 999 auto; min-width: 0; max-width: 45%;
    color: var(--vscode-descriptionForeground); font-size: 11px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .badge { flex: 0 0 auto; font-size: 10px; color: var(--vscode-descriptionForeground); }
  /* 悬停操作：绝对定位，脱离行内 flex 流，平时不占宽度；名字因此优先拿到全部可用宽度。
     默认 opacity:0 + pointer-events:none 不可见不可点，行悬停或焦点在行/按钮上时显示并恢复可点。
     按钮始终留在 DOM 中（可键盘 Tab 到），聚焦时由 :focus-within 显示。 */
  .row-action {
    position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
    opacity: 0; pointer-events: none; transition: opacity .1s;
    padding: 1px 4px; border: none; border-radius: 3px;
    background: transparent; color: var(--vscode-textLink-foreground);
    font-size: 11px; cursor: pointer;
  }
  .row:hover .row-action, .row:focus-within .row-action { opacity: 1; pointer-events: auto; }
  .row-action:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.15)); }
  /* 按钮覆盖行右端时才临时给位置让出空间，平时不预留；文本永不被永久隐藏。 */
  .row:hover .meta, .row:focus-within .meta { padding-right: 70px; }
  .children {
    margin-left: 13px; padding-left: 6px;
    border-left: 1px solid var(--vscode-tree-indentGuidesStroke, rgba(128,128,128,.3));
  }
  /* 深层嵌套：从第 6 层起每级只加 5px 的固定小步进，名字仍有可用宽度（行仍为单行）。 */
  .children.deep { margin-left: 2px; padding-left: 3px; }
  /* 窄面板：位置已无可用宽度时整体隐藏，绝不换到第二行。 */
  @media (max-width: 420px) {
    .row .meta { display: none; }
  }
  .empty { color: var(--vscode-descriptionForeground); font-size: 12px; padding: 3px 4px 3px 24px; }
  .truncated { color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground)); font-size: 11px; padding: 2px 4px 2px 24px; }
  .loading-row { color: var(--vscode-descriptionForeground); font-size: 11px; font-style: italic; padding: 3px 4px 3px 24px; }
  .error { color: var(--vscode-errorForeground); font-size: 12px; padding: 6px 10px 0; }
</style>
</head>
<body>
<main id="relation-view" aria-label="${escapeHtml(t('Relation'))}">
  <header class="relation-header">
    <div class="root-line">
      <span class="root-title" id="relation-root-name"></span>
      <span class="root-meta" id="relation-root-meta"></span>
    </div>
    <div class="toolbar">
      <button class="icon-btn" id="btn-root-from-editor" type="button" data-action="root-from-editor" title="${escapeHtml(t('Use cursor function as root'))}" aria-label="${escapeHtml(t('Use cursor function as root'))}">&#8635;</button>
      <button class="icon-btn" id="btn-collapse-all" type="button" data-action="collapse-all" title="${escapeHtml(t('Collapse all'))}" aria-label="${escapeHtml(t('Collapse all'))}">&#8862;</button>
    </div>
  </header>
  <div class="error" id="relation-error"></div>
  <div class="relation-body">
    <section class="relation-section" data-direction="callers">
      <button class="section-head" id="section-head-callers" type="button" aria-expanded="true" aria-controls="relation-callers">
        <span class="section-chevron" id="section-chevron-callers" aria-hidden="true">&#8722;</span>
        <span class="section-title" id="section-title-callers">${escapeHtml(t('Callers'))} (0)</span>
        <span class="section-loading" id="section-loading-callers" hidden>${escapeHtml(t('Loading…'))}</span>
      </button>
      <div class="section-body" id="relation-callers"></div>
    </section>
    <section class="relation-section" data-direction="callees">
      <button class="section-head" id="section-head-callees" type="button" aria-expanded="true" aria-controls="relation-callees">
        <span class="section-chevron" id="section-chevron-callees" aria-hidden="true">&#8722;</span>
        <span class="section-title" id="section-title-callees">${escapeHtml(t('Callees'))} (0)</span>
        <span class="section-loading" id="section-loading-callees" hidden>${escapeHtml(t('Loading…'))}</span>
      </button>
      <div class="section-body" id="relation-callees"></div>
    </section>
  </div>
</main>
<script nonce="${nonce}">
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const I18N = ${i18nJson};

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function post(message) { vscode.postMessage(message); }
  function openNode(id) { post({ type: 'open', id: id }); }
  function setRootNode(id) { post({ type: 'setRoot', id: id }); }
  function expandNode(id, direction) { post({ type: 'expand', id: id, direction: direction }); }
  function collapseNode(id, direction) { post({ type: 'collapse', id: id, direction: direction }); }

  // ---- 会话内持久化：只保留 Callers/Callees section 折叠状态 ----
  let saved;
  try { saved = vscode.getState ? vscode.getState() : undefined; } catch (e) { saved = undefined; }
  const collapsedSections = {
    callers: !!(saved && saved.collapsedSections && saved.collapsedSections.callers),
    callees: !!(saved && saved.collapsedSections && saved.collapsedSections.callees),
  };
  function persist() {
    try {
      if (vscode.setState) vscode.setState({ collapsedSections: collapsedSections });
    } catch (e) { /* ignore */ }
  }

  function applySectionCollapsed(direction) {
    const body = document.getElementById('relation-' + direction);
    const head = document.getElementById('section-head-' + direction);
    const chevron = document.getElementById('section-chevron-' + direction);
    const collapsed = !!collapsedSections[direction];
    body.hidden = collapsed;
    head.setAttribute('aria-expanded', String(!collapsed));
    chevron.textContent = collapsed ? '+' : '−';
  }
  function toggleSection(direction) {
    collapsedSections[direction] = !collapsedSections[direction];
    applySectionCollapsed(direction);
    persist();
  }

  const directionLabel = { callers: I18N.callers, callees: I18N.callees };
  const directionGlyph = { callers: '←', callees: '→' };
  // 从第 6 层起缩进只加固定小步进（与 CSS .children.deep 对应），保证深层名字宽度。
  const DEEP_INDENT_LEVEL = 6;
  let currentLoadingIds = [];

  function emptyLabel(direction) {
    return direction === 'callers' ? I18N.noCallers : I18N.noCallees;
  }

  function renderNodes(container, children, direction, depth) {
    for (const tree of children) {
      const childList = direction === 'callers' ? tree.callers : tree.callees;
      const expanded = direction === 'callers' ? tree.expandedCallers : tree.expandedCallees;
      const truncated = direction === 'callers' ? tree.truncatedCallers : tree.truncatedCallees;
      const node = el('div', 'tree-node');
      const row = el('div', 'row');
      row.tabIndex = 0;
      row.setAttribute('role', 'treeitem');
      row.setAttribute('aria-expanded', String(!!expanded));
      row.dataset.focusKey = direction + '|' + tree.node.id;

      if (expanded && childList.length > 0) {
        const toggle = el('button', 'toggle', '−');
        toggle.type = 'button';
        toggle.title = I18N.collapse;
        toggle.setAttribute('aria-label', I18N.collapse);
        toggle.addEventListener('click', function (event) {
          event.stopPropagation();
          collapseNode(tree.node.id, direction);
        });
        row.appendChild(toggle);
      } else if (!expanded) {
        const toggle = el('button', 'toggle', '+');
        toggle.type = 'button';
        toggle.title = I18N.expand;
        toggle.setAttribute('aria-label', I18N.expand);
        toggle.addEventListener('click', function (event) {
          event.stopPropagation();
          expandNode(tree.node.id, direction);
        });
        row.appendChild(toggle);
      } else {
        row.appendChild(el('span', 'toggle placeholder', ''));
      }

      row.appendChild(el('span', 'direction', directionGlyph[direction]));

      const name = el('span', 'name', tree.node.name);
      name.title = tree.node.file + ':' + (tree.node.line + 1);
      row.appendChild(name);

      const meta = el('span', 'meta', tree.node.file + ':' + (tree.node.line + 1));
      meta.title = meta.textContent;
      row.appendChild(meta);

      if (currentLoadingIds.indexOf(tree.node.id) >= 0) {
        row.appendChild(el('span', 'badge', '…'));
      } else if (truncated) {
        row.appendChild(el('span', 'badge', '…'));
      }

      const action = el('button', 'row-action', I18N.setAsRoot);
      action.type = 'button';
      action.title = I18N.setAsRoot;
      action.addEventListener('click', function (event) {
        event.stopPropagation();
        setRootNode(tree.node.id);
      });
      row.appendChild(action);

      row.addEventListener('click', function (event) {
        const target = event.target;
        if (target && target.closest && target.closest('.toggle, .row-action')) return;
        if (event.altKey) { setRootNode(tree.node.id); return; }
        if (target && target.closest && target.closest('.name')) openNode(tree.node.id);
      });
      row.addEventListener('keydown', function (event) {
        // 焦点在 toggle / Set as root 按钮上时交给原生按钮处理，避免行处理再触发一次。
        if (event.target && event.target !== row && event.target.closest && event.target.closest('.toggle, .row-action')) {
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          if (event.altKey) setRootNode(tree.node.id);
          else openNode(tree.node.id);
          return;
        }
        if (event.key === 'ArrowRight') {
          if (!expanded) { event.preventDefault(); expandNode(tree.node.id, direction); }
          return;
        }
        if (event.key === 'ArrowLeft') {
          if (expanded) { event.preventDefault(); collapseNode(tree.node.id, direction); }
        }
      });

      node.appendChild(row);

      if (expanded) {
        if (childList.length > 0) {
          const childrenBox = el('div', 'children');
          if (depth + 1 >= DEEP_INDENT_LEVEL) childrenBox.classList.add('deep');
          renderNodes(childrenBox, childList, direction, depth + 1);
          node.appendChild(childrenBox);
          if (truncated) node.appendChild(el('div', 'truncated', '…'));
        } else if (truncated) {
          node.appendChild(el('div', 'truncated', '…'));
        } else {
          node.appendChild(el('div', 'empty', emptyLabel(direction)));
        }
      }
      container.appendChild(node);
    }
  }

  function renderSection(direction, rootTree, loading) {
    const title = document.getElementById('section-title-' + direction);
    const loadingBox = document.getElementById('section-loading-' + direction);
    const body = document.getElementById('relation-' + direction);
    const children = direction === 'callers' ? rootTree.callers : rootTree.callees;
    const expanded = direction === 'callers' ? rootTree.expandedCallers : rootTree.expandedCallees;
    const truncated = direction === 'callers' ? rootTree.truncatedCallers : rootTree.truncatedCallees;
    const fetching = !!loading;
    const count = children ? children.length : 0;
    // 首次加载时还没拿到子节点，用 “–” 占位。
    title.textContent = directionLabel[direction] + ' (' + (fetching && !expanded ? '–' : String(count)) + ')';
    loadingBox.hidden = !fetching;
    body.textContent = '';
    body.hidden = !!collapsedSections[direction];
    if (expanded && count > 0) {
      renderNodes(body, children, direction, 0);
      if (truncated) body.appendChild(el('div', 'truncated', '…'));
    } else if (expanded && truncated) {
      body.appendChild(el('div', 'truncated', '…'));
    } else if (expanded) {
      body.appendChild(el('div', 'empty', emptyLabel(direction)));
    } else if (fetching) {
      body.appendChild(el('div', 'loading-row', I18N.loading));
    } else {
      body.appendChild(el('div', 'empty', '–'));
    }
  }

  function renderRelation(state, loading) {
    const name = document.getElementById('relation-root-name');
    const meta = document.getElementById('relation-root-meta');
    if (!state || !state.root) {
      name.textContent = '';
      meta.textContent = '';
      document.getElementById('relation-callers').textContent = '';
      document.getElementById('relation-callees').textContent = '';
      return;
    }
    name.textContent = state.root.node.name;
    name.title = state.root.node.name;
    meta.textContent = state.root.node.file + ':' + (state.root.node.line + 1);
    meta.title = meta.textContent;
    renderSection('callers', state.root, loading && loading.callers);
    renderSection('callees', state.root, loading && loading.callees);
  }

  let lastState = null;
  let lastLoading = { callers: false, callees: false };
  let lastLoadingIds = [];

  function renderAll() {
    const active = document.activeElement;
    const focusKey = active && active.dataset ? active.dataset.focusKey : undefined;
    applySectionCollapsed('callers');
    applySectionCollapsed('callees');
    renderRelation(lastState, lastLoading);
    if (focusKey) {
      const rows = document.querySelectorAll('.row');
      for (const row of rows) {
        if (row.dataset.focusKey === focusKey) { row.focus(); break; }
      }
    }
  }

  window.addEventListener('message', function (event) {
    const message = event.data || {};
    if (message.type === 'state') {
      lastState = message.state;
      lastLoading = message.loading || { callers: false, callees: false };
      lastLoadingIds = Array.isArray(message.loadingIds) ? message.loadingIds : [];
      currentLoadingIds = lastLoadingIds;
      renderAll();
    } else if (message.type === 'error') {
      const text = message.message || 'error';
      const relationError = document.getElementById('relation-error');
      if (relationError) relationError.textContent = text;
    }
  });

  document.getElementById('section-head-callers').addEventListener('click', function () { toggleSection('callers'); });
  document.getElementById('section-head-callees').addEventListener('click', function () { toggleSection('callees'); });
  document.getElementById('btn-root-from-editor').addEventListener('click', function () { post({ type: 'refresh' }); });
  document.getElementById('btn-collapse-all').addEventListener('click', function () { post({ type: 'collapseAll' }); });

  applySectionCollapsed('callers');
  applySectionCollapsed('callees');
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`
}
