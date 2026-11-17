import test from 'node:test'
import assert from 'node:assert/strict'

import { escapeHtml, renderCallGraphHtml } from '../src/vscode/call-graph-html'

const options = {
  cspSource: 'vscode-resource://test',
  nonce: 'nonce-abc123',
  t: (message: string) => message,
}

test('call graph html: includes CSP, nonce and three columns', () => {
  const html = renderCallGraphHtml(options)
  assert.match(html, /Content-Security-Policy/)
  assert.match(html, /script-src 'nonce-nonce-abc123'/)
  assert.match(html, /style-src vscode-resource:\/\/test 'unsafe-inline'/)
  assert.match(html, /id="callers"/)
  assert.match(html, /id="root"/)
  assert.match(html, /id="callees"/)
  assert.match(html, /acquireVsCodeApi/)
  assert.match(html, /postMessage\(\{ type: 'ready' \}\)/)
})

test('call graph html: escapes translated labels', () => {
  const html = renderCallGraphHtml({
    ...options,
    t: (message: string) => (message === 'Callers' ? '<img onerror=alert(1)>' : message),
  })
  assert.ok(!html.includes('<img onerror'), 'raw HTML from translations must be escaped')
  assert.match(html, /&lt;img onerror/)
})

test('escapeHtml: escapes all dangerous characters', () => {
  assert.equal(escapeHtml(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;\'&lt;/a&gt;')
})

test('call graph html: contains the message protocol handlers', () => {
  const html = renderCallGraphHtml(options)
  for (const type of ['expand', 'collapse', 'open', 'refresh']) {
    assert.ok(html.includes(`type: '${type}'`), `handler for ${type}`)
  }
  assert.ok(html.includes('document.getElementById'), 'renders into the panel DOM')
})
