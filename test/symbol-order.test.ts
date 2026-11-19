import test from 'node:test'
import assert from 'node:assert/strict'

import { compareStrings, compareSymbolEntries } from '../src/core/symbol-order'
import { createSymbolTable } from '../src/core/symbol-table'
import { SNAPSHOT_VERSION, SYMBOL_KIND_ORDER } from '../src/shared/types'
import type { SymbolEntry } from '../src/shared/types'

function entry(name: string, file: string, line: number, kind: SymbolEntry['kind'] = 'function'): SymbolEntry {
  return { name, kind, file, line, endLine: line, column: 0 }
}

test('symbol order: SYMBOL_KIND_ORDER keeps the 0.8.0 relative order, v5 kinds appended', () => {
  // 控制器决定：既有 kind 的相对顺序锁定为 0.8.0（802f981），新 kind 只追加在尾部；
  // 这里逐值断言，防止后续文档/重构再次把 declaration 提前到类型符号之前。
  assert.deepEqual(SYMBOL_KIND_ORDER, {
    function: 0,
    struct: 1,
    union: 2,
    enum: 3,
    typedef: 4,
    declaration: 5,
    macro: 6,
    member: 7,
    enumConstant: 8,
    variable: 9,
  })
})

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
