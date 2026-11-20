import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_INDEX_BUDGET, evaluateBudget } from '../src/core/index-budget'

const BUDGET = DEFAULT_INDEX_BUDGET

test('budget: v5 default thresholds (3M symbols / 120k files / 6M hard max)', () => {
  assert.deepEqual(DEFAULT_INDEX_BUDGET, {
    maxSymbols: 3_000_000,
    maxFiles: 120_000,
    hardMaxSymbols: 6_000_000,
  })
})

test('budget: ok below thresholds', () => {
  const report = evaluateBudget({ symbols: 100, files: 10, budget: BUDGET })
  assert.equal(report.level, 'ok')
  assert.deepEqual(report.suggestions, [])
})

test('budget: symbols === maxSymbols is still ok (strict > boundary)', () => {
  const report = evaluateBudget({ symbols: BUDGET.maxSymbols, files: 10, budget: BUDGET })
  assert.equal(report.level, 'ok')
  assert.equal(report.message, undefined)
  assert.deepEqual(report.suggestions, [])
})

test('budget: warn between max and hard max', () => {
  const report = evaluateBudget({ symbols: BUDGET.maxSymbols + 1, files: 10, budget: BUDGET })
  assert.equal(report.level, 'warn')
  assert.ok(report.message?.includes('3,000,000'))
  assert.ok(report.suggestions.length > 0)
})

test('budget: symbols === hardMaxSymbols is still warn (strict > boundary)', () => {
  const report = evaluateBudget({ symbols: BUDGET.hardMaxSymbols, files: 10, budget: BUDGET })
  assert.equal(report.level, 'warn')
  assert.ok(report.message?.includes('3,000,000'))
  assert.ok(report.suggestions.some((s) => s.includes('indexRoots')))
})

test('budget: exceeded above hard max', () => {
  const report = evaluateBudget({ symbols: BUDGET.hardMaxSymbols + 1, files: 10, budget: BUDGET })
  assert.equal(report.level, 'exceeded')
  assert.ok(report.message?.includes('hard maximum 6,000,000'))
  assert.ok(report.suggestions.some((s) => s.includes('indexRoots')))
})

test('budget: files-only breach over maxFiles is warn (not exceeded)', () => {
  const report = evaluateBudget({ symbols: 1, files: BUDGET.maxFiles + 1, budget: BUDGET })
  assert.equal(report.level, 'warn')
  assert.ok(report.message?.includes('120,001 files (budget 120,000)'))
})

test('budget: exceeded wins even when files also breach the files budget', () => {
  // 设计文档只为符号数定义硬上限；文件数只有 maxFiles（warn）。
  // 这里覆盖优先级：符号超标 -> exceeded，即使 files 同时超 maxFiles 也不能降级成 warn。
  const report = evaluateBudget({
    symbols: BUDGET.hardMaxSymbols + 1,
    files: BUDGET.maxFiles + 1,
    budget: BUDGET,
  })
  assert.equal(report.level, 'exceeded')
  assert.ok(report.message?.includes('hard maximum'))
  assert.ok(!report.message?.includes('files (budget'))
  assert.ok(report.suggestions.some((s) => s.includes('indexRoots')))
})
