import test from 'node:test'
import assert from 'node:assert/strict'

import { clampSymbolRanges, extendRangesOverChildren } from '../src/vscode/symbol-ranges'

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

test('ranges: parent range extends to cover children, selection stays on the alias line', () => {
  // typedef 别名行（3）在成员（1、2）下方：完整范围覆盖成员，selection 仍在别名行。
  const alias = clampSymbolRanges(entry(3, 3, 2, 'point_t'), 5, (l) => lineLengths([14, 8, 8, 10, 0], l))!
  const x = clampSymbolRanges(entry(1, 1, 6, 'x'), 5, (l) => lineLengths([14, 8, 8, 10, 0], l))!
  const y = clampSymbolRanges(entry(2, 2, 6, 'y'), 5, (l) => lineLengths([14, 8, 8, 10, 0], l))!
  const extended = extendRangesOverChildren(alias, [x, y])
  assert.equal(extended.startLine, 1)
  assert.equal(extended.endLine, 3)
  assert.equal(extended.selectionStart, alias.selectionStart)
  assert.equal(alias.startLine, 3, 'original alias ranges are not mutated')
  // 没有子节点或子节点完全在父范围内时原样返回（同一对象）
  assert.equal(extendRangesOverChildren(alias, []), alias)
  assert.equal(extendRangesOverChildren(alias, [alias]), alias)
})
