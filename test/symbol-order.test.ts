import test from 'node:test'
import assert from 'node:assert/strict'

import { compareStrings, compareSymbolEntries } from '../src/core/symbol-order'
import { createSymbolTable } from '../src/core/symbol-table'
import { SNAPSHOT_VERSION } from '../src/shared/types'
import type { SymbolEntry } from '../src/shared/types'

function entry(name: string, file: string, line: number, kind: SymbolEntry['kind'] = 'function'): SymbolEntry {
  return { name, kind, file, line, endLine: line, column: 0 }
}

test('symbol order: kind first, then name length, then name, file, line', () => {
  const values = [
    entry('zeta', 'a.c', 1),
    entry('alpha', 'b.c', 2),
    entry('beta', 'a.c', 3),
    entry('gamma', 'a.c', 4, 'declaration'),
  ]
  values.sort(compareSymbolEntries)
  assert.deepEqual(values.map((v) => `${v.kind}:${v.name}`), [
    'function:beta',   // 4 chars
    'function:zeta',   // 4 chars -> file/name tie-break
    'function:alpha',
    'declaration:gamma',
  ])
})

test('symbol order: compareStrings compares lexicographically', () => {
  assert.ok(compareStrings('a.c', 'b.c') < 0)
  assert.equal(compareStrings('x', 'x'), 0)
  assert.ok(compareStrings('b', 'a') > 0)
})

test('SymbolTable.forEachName yields deduplicated sorted names', () => {
  const table = createSymbolTable(
    ['root'],
    [
      { path: 'a.c', mtimeMs: 1, size: 1 },
      { path: 'b.c', mtimeMs: 1, size: 1 },
    ],
    [entry('beta', 'a.c', 1), entry('alpha', 'a.c', 2), entry('alpha', 'b.c', 3)],
    123,
    SNAPSHOT_VERSION,
  )
  const names: string[] = []
  table.forEachName((name) => names.push(name))
  assert.deepEqual(names, ['alpha', 'beta'])
})
