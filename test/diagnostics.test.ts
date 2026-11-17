import test from 'node:test'
import assert from 'node:assert/strict'

import { renderDiagnosticsMarkdown } from '../src/core/diagnostics'
import type { DiagnosticsInput } from '../src/core/diagnostics'

const input: DiagnosticsInput = {
  extensionVersion: '0.7.0',
  workspaceRoot: '/work',
  roots: ['component', 'datapath'],
  snapshotPath: '/storage/symbols.sidx',
  snapshotBytes: 5_000_000,
  deltaBytes: 4_096,
  nameIndexPath: '/storage/symbols.names',
  nameIndexBytes: 3_000_000,
  nameIndexLoaded: false,
  entryCount: 118_730,
  fileCount: 6_838,
  builtAt: 1_700_000_000_000,
  rootsChanged: false,
  pendingChanges: 3,
  lastBuild: undefined,
  lastError: undefined,
  kindCounts: { function: 10, declaration: 20, macro: 1, struct: 2, union: 0, enum: 1, typedef: 3 },
  heapUsedBytes: 200 * 1024 * 1024,
  rssBytes: 400 * 1024 * 1024,
  budget: { level: 'ok', symbols: 118_730, files: 6_838, suggestions: [] },
}

test('diagnostics: reports real storage sizes and index fields', () => {
  const md = renderDiagnosticsMarkdown(input)
  assert.match(md, /^# Code Insight index diagnostics$/m)
  assert.match(md, /- extension: 0\.7\.0/)
  assert.match(md, /- workspace: \/work/)
  assert.match(md, /- roots: component, datapath/)
  assert.match(md, /- budget: ok/)
  // Index 段
  assert.match(md, /- symbols: 118,730/)
  assert.match(md, /- files: 6,838/)
  assert.match(md, /- builtAt: 2023-11-14T22:13:20\.000Z/)
  assert.match(md, /- pending changes \(overlay\): 3/)
  assert.match(md, /- kinds: function=10, declaration=20, macro=1, struct=2, union=0, enum=1, typedef=3/)
  // Storage 段：base/delta/引用索引都按 provider 传入的真实字节数渲染
  assert.match(md, /- snapshot: \/storage\/symbols\.sidx \(4\.77 MB\)/)
  assert.match(md, /- snapshot delta: 4\.0 KB/)
  assert.match(md, /- reference index: \/storage\/symbols\.names \(2\.86 MB, lazy\)/)
  // Process 段
  assert.match(md, /- heap used: 200\.00 MB/)
  assert.match(md, /- RSS: 400\.00 MB/)
  // 任何缺失字段都不应把 JS 的 undefined 泄漏到文档里
  assert.doesNotMatch(md, /undefined/)
  assert.doesNotMatch(md, /roots changed since the last build/)
})

test('diagnostics: reference index loaded flag renders loaded', () => {
  const md = renderDiagnosticsMarkdown({ ...input, nameIndexLoaded: true })
  assert.match(md, /- reference index: \/storage\/symbols\.names \(2\.86 MB, loaded\)/)
})

test('diagnostics: missing paths render bare n/a without a (0 B) suffix', () => {
  const md = renderDiagnosticsMarkdown({
    ...input,
    workspaceRoot: undefined,
    snapshotPath: undefined,
    snapshotBytes: 0,
    nameIndexPath: undefined,
    nameIndexBytes: 0,
    builtAt: undefined,
    lastBuild: undefined,
    lastError: undefined,
  })
  assert.match(md, /- workspace: n\/a/)
  assert.match(md, /- builtAt: n\/a/)
  assert.match(md, /^- snapshot: n\/a$/m)
  assert.match(md, /^- reference index: n\/a$/m)
  assert.doesNotMatch(md, /snapshot: n\/a \(/)
  assert.doesNotMatch(md, /reference index: n\/a \(/)
})

test('diagnostics: configured but missing files render n/a size, not 0 B', () => {
  const md = renderDiagnosticsMarkdown({ ...input, snapshotBytes: 0, nameIndexBytes: 0 })
  assert.match(md, /^- snapshot: \/storage\/symbols\.sidx \(n\/a\)$/m)
  assert.match(md, /^- reference index: \/storage\/symbols\.names \(n\/a, lazy\)$/m)
  assert.doesNotMatch(md, /snapshot: .*\(0 B\)/)
})

test('diagnostics: error text containing triple backticks cannot break the document', () => {
  const error = 'snapshot load failed:\n```\nconst broken = true\n```\nstill failing'
  const md = renderDiagnosticsMarkdown({
    ...input,
    lastError: error,
    budget: { ...input.budget, suggestions: ['Narrow roots.'] },
  })
  // 错误原文保留（内含 ```），但用 ~~~ 围栏包住，围栏恰好一对
  assert.ok(md.includes(error))
  assert.equal((md.match(/^~~~$/gm) ?? []).length, 2)
  const lines = md.split('\n')
  const open = lines.indexOf('~~~')
  const close = lines.indexOf('~~~', open + 1)
  assert.ok(open > 0 && close > open, 'error fence is well-formed')
  assert.match(lines[open + 1] ?? '', /^snapshot load failed:$/)
  assert.ok(lines.slice(open + 1, close).includes('```'), 'inner ``` stays inside the fence')
  // 错误块之后的章节仍是文档结构的一部分
  assert.match(md, /## Suggestions/)
  assert.ok(md.indexOf('## Suggestions') > lines.slice(0, close + 1).join('\n').length)
})

test('diagnostics: error text containing tilde fences gets a longer fence', () => {
  const error = 'weird ~~~ inside\n~~~\nstill inside'
  const md = renderDiagnosticsMarkdown({ ...input, lastError: error })
  assert.equal((md.match(/^~~~~$/gm) ?? []).length, 2)
  assert.ok(md.includes(error))
  const lines = md.split('\n')
  const open = lines.indexOf('~~~~')
  const close = lines.indexOf('~~~~', open + 1)
  assert.ok(open > 0 && close > open, 'longer fence is well-formed')
  assert.ok(lines.slice(open + 1, close).includes('~~~'), 'inner ~~~ stays inside the fence')
})

test('diagnostics: invalid builtAt renders n/a and never throws', () => {
  for (const builtAt of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e300]) {
    let md = ''
    assert.doesNotThrow(() => {
      md = renderDiagnosticsMarkdown({ ...input, builtAt })
    })
    assert.match(md, /- builtAt: n\/a/)
  }
})

test('diagnostics: byte formatting does not round 1048575 B to 1024.0 KB', () => {
  const md = renderDiagnosticsMarkdown({
    ...input,
    snapshotBytes: 1_048_575,
    heapUsedBytes: 1_048_575,
  })
  assert.doesNotMatch(md, /1024\.0 KB/)
  assert.match(md, /- snapshot: \/storage\/symbols\.sidx \(1\.00 MB\)/)
  assert.match(md, /- heap used: 1\.00 MB/)
  // 阈值以下仍按 KB 渲染
  const mdBelow = renderDiagnosticsMarkdown({ ...input, deltaBytes: 1_048_063 })
  assert.match(mdBelow, /- snapshot delta: 1023\.5 KB/)
})

test('diagnostics: roots-changed note appears only when the flag is set', () => {
  const md = renderDiagnosticsMarkdown({ ...input, rootsChanged: true })
  assert.match(md, /- note: roots changed since the last build — counts may be stale/)
  const mdUnchanged = renderDiagnosticsMarkdown({ ...input, rootsChanged: false })
  assert.doesNotMatch(mdUnchanged, /roots changed since the last build/)
})

test('diagnostics: includes last build summary when present', () => {
  const md = renderDiagnosticsMarkdown({
    ...input,
    lastError: 'snapshot load failed',
    lastBuild: {
      files: 6_838, entries: 118_730, added: 1, updated: 2, removed: 0, unchanged: 6_835, skipped: 3,
      durationMs: 6_100, snapshotBytes: 5_000_000, nameIndexBytes: 3_000_000,
    },
  })
  assert.match(md, /## Last build/)
  assert.match(md, /- duration: 6,100 ms/)
  assert.match(md, /- files\/entries: 6,838 \/ 118,730/)
  assert.match(md, /- added\/updated\/removed\/unchanged\/skipped: 1\/2\/0\/6835\/3/)
  assert.match(md, /## Last error/)
  assert.match(md, /snapshot load failed/)
})
