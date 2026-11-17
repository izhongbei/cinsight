import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_INDEX_BUDGET, evaluateBudget } from '../src/core/index-budget'

test('budget: ok below thresholds', () => {
  const report = evaluateBudget({ symbols: 100, files: 10, budget: DEFAULT_INDEX_BUDGET })
  assert.equal(report.level, 'ok')
  assert.deepEqual(report.suggestions, [])
})

test('budget: warn between max and hard max', () => {
  const report = evaluateBudget({ symbols: DEFAULT_INDEX_BUDGET.maxSymbols + 1, files: 10, budget: DEFAULT_INDEX_BUDGET })
  assert.equal(report.level, 'warn')
  assert.ok(report.message?.includes('2,000,000'))
  assert.ok(report.suggestions.length > 0)
})

test('budget: exceeded above hard max', () => {
  const report = evaluateBudget({ symbols: DEFAULT_INDEX_BUDGET.hardMaxSymbols + 1, files: 10, budget: DEFAULT_INDEX_BUDGET })
  assert.equal(report.level, 'exceeded')
  assert.ok(report.suggestions.some((s) => s.includes('indexRoots')))
})

test('budget: files threshold also triggers warn', () => {
  const report = evaluateBudget({ symbols: 1, files: DEFAULT_INDEX_BUDGET.maxFiles + 1, budget: DEFAULT_INDEX_BUDGET })
  assert.equal(report.level, 'warn')
})
