import test from 'node:test'
import assert from 'node:assert/strict'

import { escapeHtml, renderCallGraphHtml } from '../src/vscode/call-graph-html'

const options = {
  cspSource: 'vscode-resource://test',
  nonce: 'nonce-abc123',
  t: (message: string) => message,
}

test('call graph html: includes CSP, nonce, Relation/Graph tabs and the graph columns', () => {
  const html = renderCallGraphHtml(options)
  assert.match(html, /Content-Security-Policy/)
  assert.match(html, /script-src 'nonce-nonce-abc123'/)
  assert.match(html, /style-src vscode-resource:\/\/test 'unsafe-inline'/)
  assert.match(html, /data-tab="relation"/)
  assert.match(html, /data-tab="graph"/)
  assert.match(html, /id="tab-relation"/)
  assert.match(html, /id="tab-graph"/)
  assert.match(html, /id="relation-root-name"/)
  assert.match(html, /id="section-title-callers"/)
  assert.match(html, /id="section-title-callees"/)
  // Graph tab keeps the 0.9.4 three-column DOM so its JS/CSS stays unchanged.
  assert.match(html, /id="callers"/)
  assert.match(html, /id="root"/)
  assert.match(html, /id="callees"/)
  assert.match(html, /acquireVsCodeApi/)
  assert.match(html, /postMessage\(\{ type: 'ready' \}\)/)
})

test('call graph html: relation toolbar, sections and localized labels are present', () => {
  const html = renderCallGraphHtml(options)
  for (const label of [
    'Relation',
    'Graph',
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

test('call graph html: contains the Relation and Graph message protocol handlers', () => {
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
