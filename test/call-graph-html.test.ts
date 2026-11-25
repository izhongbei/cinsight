import test from 'node:test'
import assert from 'node:assert/strict'

import { escapeHtml, renderCallGraphHtml } from '../src/vscode/call-graph-html'

const options = {
  cspSource: 'vscode-resource://test',
  nonce: 'nonce-abc123',
  t: (message: string) => message,
}

test('call graph html: includes CSP, nonce and the single Relation view', () => {
  const html = renderCallGraphHtml(options)
  assert.match(html, /Content-Security-Policy/)
  assert.match(html, /script-src 'nonce-nonce-abc123'/)
  assert.match(html, /style-src vscode-resource:\/\/test 'unsafe-inline'/)
  assert.match(html, /id="relation-view"/)
  assert.match(html, /id="relation-root-name"/)
  assert.match(html, /id="section-title-callers"/)
  assert.match(html, /id="section-title-callees"/)
  assert.match(html, /acquireVsCodeApi/)
  assert.match(html, /postMessage\(\{ type: 'ready' \}\)/)
})

test('call graph html: no Graph tab, tab strip or three-column graph DOM remains', () => {
  const html = renderCallGraphHtml(options)
  for (const token of [
    'data-tab="graph"',
    'data-tab="relation"',
    'id="tab-graph"',
    'id="tab-btn-graph"',
    'id="tab-btn-relation"',
    'class="tab-strip"',
    'role="tablist"',
    'id="columns"',
    'class="column"',
  ]) {
    assert.ok(!html.includes(token), `graph tab token removed: ${token}`)
  }
  // 关系树的行渲染使用 relation-* id；三列图专用的 id 不应再出现。
  assert.ok(!/id="callers"/.test(html), 'graph callers column removed')
  assert.ok(!/id="root"/.test(html), 'graph root column removed')
  assert.ok(!/id="callees"/.test(html), 'graph callees column removed')
})

test('call graph html: relation toolbar, sections and localized labels are present', () => {
  const html = renderCallGraphHtml(options)
  for (const label of [
    'Relation',
    'Callers',
    'Callees',
    'Set as root',
    'Use cursor function as root',
    'Collapse all',
    'No callers',
    'No callees',
    'Loading…',
  ]) {
    assert.ok(html.includes(label), `label ${label}`)
  }
  assert.match(html, /data-action="root-from-editor"/)
  assert.match(html, /data-action="collapse-all"/)
})

test('call graph html: graph-only labels are not shipped any more', () => {
  const html = renderCallGraphHtml(options)
  for (const label of [
    '>Graph<',
    'Current function',
    'Click a name to jump',
    'Rebuild the graph',
    'No function selected.',
    'Graph truncated',
    '{0} nodes',
  ]) {
    assert.ok(!html.includes(label), `graph-only label removed: ${label}`)
  }
})

test('call graph html: escapes translated labels in markup', () => {
  const html = renderCallGraphHtml({
    ...options,
    t: (message: string) => (message === 'Callers' ? '<img onerror=alert(1)>' : message),
  })
  assert.ok(!html.includes('<img onerror'), 'raw HTML from translations must be escaped')
  assert.match(html, /&lt;img onerror/)
})

test('call graph html: escapes translated labels embedded in the script JSON', () => {
  const payload = '</script><script>alert(1)</script>'
  const html = renderCallGraphHtml({
    ...options,
    t: (message: string) => (message === 'Set as root' ? payload : message),
  })
  assert.ok(!html.includes(payload), 'script payload must not appear verbatim')
  assert.ok(html.includes('\\u003c/script>'), 'script JSON escapes <')
})

test('escapeHtml: escapes all dangerous characters', () => {
  assert.equal(escapeHtml(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;\'&lt;/a&gt;')
})

test('call graph html: contains the Relation message protocol handlers', () => {
  const html = renderCallGraphHtml(options)
  for (const type of [
    'ready',
    'expand',
    'collapse',
    'open',
    'refresh',
    'setRoot',
    'collapseAll',
  ]) {
    assert.ok(html.includes(`type: '${type}'`), `handler for ${type}`)
  }
  assert.ok(html.includes('document.getElementById'), 'renders into the panel DOM')
  assert.ok(html.includes('textContent'), 'all dynamic text goes through textContent')
})
