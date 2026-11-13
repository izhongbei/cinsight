import test from 'node:test'
import assert from 'node:assert/strict'

import { clampSymbolRanges } from '../src/vscode/symbol-ranges'

function lineLengths(lengths: number[], line: number): number {
  return lengths[line] ?? 0
}

const entry = (line: number, endLine: number, column: number, name = 'demo'): {
  name: string
  line: number
  endLine: number
  column: number
} => ({ name, line, endLine, column })

test('ranges: normal single-line symbol', () => {
  const ranges = clampSymbolRanges(entry(2, 2, 4), 10, (l) => lineLengths([0, 0, 20, 0], l))
  assert.ok(ranges)
  assert.equal(ranges!.startLine, 2)
  assert.equal(ranges!.endLine, 2)
  assert.equal(ranges!.selectionStart, 4)
  assert.equal(ranges!.selectionEnd, 8)
  assert.equal(ranges!.endCharacter, 20)
})

test('ranges: multi-line symbol ends at the last document line', () => {
  const ranges = clampSymbolRanges(entry(1, 99, 2), 5, (l) => lineLengths([0, 10, 5, 5, 7], l))
  assert.ok(ranges)
  assert.equal(ranges!.endLine, 4)
  assert.equal(ranges!.endCharacter, 7)
})

test('ranges: stale entry beyond the document is skipped', () => {
  assert.equal(clampSymbolRanges(entry(50, 60, 0), 10, () => 10), undefined)
  assert.equal(clampSymbolRanges(entry(-1, 0, 0), 10, () => 10), undefined)
})

test('ranges: endLine before line is clamped to the selection line', () => {
  const ranges = clampSymbolRanges(entry(3, 1, 2), 10, (l) => lineLengths([0, 0, 0, 30], l))
  assert.ok(ranges)
  assert.equal(ranges!.endLine, 3)
  assert.ok(ranges!.endCharacter >= ranges!.selectionEnd)
})

test('ranges: column beyond the line is clamped to the line length', () => {
  const ranges = clampSymbolRanges(entry(2, 2, 99, 'abcdef'), 10, (l) => lineLengths([0, 0, 5], l))
  assert.ok(ranges)
  assert.equal(ranges!.selectionStart, 5)
  assert.equal(ranges!.selectionEnd, 5)
  assert.equal(ranges!.endCharacter, 5)
})

test('ranges: empty document or non-finite input is skipped', () => {
  assert.equal(clampSymbolRanges(entry(0, 0, 0), 0, () => 0), undefined)
  assert.equal(clampSymbolRanges(entry(Number.NaN, 0, 0), 5, () => 0), undefined)
})
