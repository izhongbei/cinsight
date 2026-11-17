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
  pendingChanges: 3,
  lastBuild: undefined,
  lastError: undefined,
  kindCounts: { function: 10, declaration: 20, macro: 1, struct: 2, union: 0, enum: 1, typedef: 3 },
  heapUsedBytes: 200 * 1024 * 1024,
  rssBytes: 400 * 1024 * 1024,
  budget: { level: 'ok', symbols: 118_730, files: 6_838, suggestions: [] },
}

test('diagnostics: markdown contains key fields', () => {
  const md = renderDiagnosticsMarkdown(input)
  assert.match(md, /Code Insight index diagnostics/)
  assert.match(md, /118,730/)
  assert.match(md, /6,838/)
  assert.match(md, /symbols\.sidx/)
  assert.match(md, /budget: ok/)
  assert.match(md, /function/)
})

test('diagnostics: missing optional fields render as n/a', () => {
  const md = renderDiagnosticsMarkdown({
    ...input,
    workspaceRoot: undefined,
    snapshotPath: undefined,
    nameIndexPath: undefined,
    builtAt: undefined,
    lastBuild: undefined,
    lastError: undefined,
  })
  assert.match(md, /workspace: n\/a/)
  assert.match(md, /snapshot: n\/a/)
})

test('diagnostics: includes last error and build summary when present', () => {
  const md = renderDiagnosticsMarkdown({
    ...input,
    lastError: 'snapshot load failed',
    lastBuild: {
      files: 6_838, entries: 118_730, added: 1, updated: 2, removed: 0, unchanged: 6_835, skipped: 3,
      durationMs: 6_100, snapshotBytes: 5_000_000, nameIndexBytes: 3_000_000,
    },
  })
  assert.match(md, /snapshot load failed/)
  assert.match(md, /6,100/)
})
