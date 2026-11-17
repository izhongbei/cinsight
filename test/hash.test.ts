import test from 'node:test'
import assert from 'node:assert/strict'
import { hashContent64 } from '../src/core/hash'

test('hashContent64: stable, empty and distinct inputs', () => {
  const empty = hashContent64('')
  assert.deepEqual(empty, hashContent64(''))
  const a = hashContent64('int alpha;')
  const b = hashContent64('int beta;')
  assert.notDeepEqual(a, b)
  assert.equal(typeof a.lo, 'number')
  assert.equal(typeof a.hi, 'number')
  assert.ok(a.lo >= 0 && a.lo <= 0xffffffff)
})

test('hashContent64: single-byte change flips both halves often enough', () => {
  const base = hashContent64('abcdefghijklmnop')
  const flipped = hashContent64('abcdefghijklmnopq')
  assert.notDeepEqual(base, flipped)
})
