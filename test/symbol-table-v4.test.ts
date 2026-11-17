import test from 'node:test'
import assert from 'node:assert/strict'

import { createSymbolTable } from '../src/core/symbol-table'
import type { FileRecord, SymbolEntry } from '../src/shared/types'
import { SNAPSHOT_VERSION } from '../src/shared/types'

test('symbol table v4: includes, reachability and content hash', () => {
  const files: FileRecord[] = [
    { path: 'a.c', mtimeMs: 1, size: 1, contentHashLo: 11, contentHashHi: 12 },
    { path: 'inc/x.h', mtimeMs: 1, size: 1, contentHashLo: 21, contentHashHi: 22 },
    { path: 'inc/y.h', mtimeMs: 1, size: 1, contentHashLo: 31, contentHashHi: 32 },
  ]
  const includes = new Map<string, readonly string[]>([
    ['a.c', ['inc/x.h']],
    ['inc/x.h', ['inc/y.h']],
    ['inc/y.h', []],
  ])
  const entries: SymbolEntry[] = [
    { name: 'x', kind: 'function', file: 'inc/y.h', line: 1, endLine: 1, column: 0, condition: '#ifdef X' },
  ]
  const table = createSymbolTable(['.'], files, entries, 1, SNAPSHOT_VERSION, { includes })
  assert.deepEqual(table.includedFiles('a.c'), ['inc/x.h'])
  assert.equal(table.isReachable('a.c', 'inc/y.h'), true)
  assert.equal(table.isReachable('inc/y.h', 'a.c'), false)
  assert.deepEqual(table.contentHashOf('a.c'), { lo: 11, hi: 12 })
  assert.equal(table.contentHashOf('missing.c'), undefined)
  assert.equal(table.entriesInFile('inc/y.h')[0]!.condition, '#ifdef X')
})

test('symbol table v4: include cycles terminate, unresolved targets are ignored, condition is optional', () => {
  const files: FileRecord[] = [
    { path: 'a.c', mtimeMs: 1, size: 1 },
    { path: 'b.h', mtimeMs: 1, size: 1 },
    { path: 'c.h', mtimeMs: 1, size: 1 },
  ]
  const includes = new Map<string, readonly string[]>([
    ['a.c', ['b.h', 'not-in-index.h']],
    ['b.h', ['a.c']],
  ])
  const entries: SymbolEntry[] = [
    { name: 'plain', kind: 'function', file: 'a.c', line: 1, endLine: 2, column: 0 },
    { name: 'guarded', kind: 'struct', file: 'a.c', line: 5, endLine: 9, column: 0, condition: '#ifdef G' },
  ]
  const table = createSymbolTable(['.'], files, entries, 1, SNAPSHOT_VERSION, { includes })
  // 未解析的目标（不在 files 里）不建边
  assert.deepEqual(table.includedFiles('a.c'), ['b.h'])
  // A ↔ B 循环必须终止，且互相可达
  assert.equal(table.isReachable('a.c', 'b.h'), true)
  assert.equal(table.isReachable('a.c', 'a.c'), true)
  assert.equal(table.isReachable('a.c', 'c.h'), false)
  // 无 include 记录 / 未知文件的查询退化为空
  assert.deepEqual(table.includedFiles('c.h'), [])
  assert.deepEqual(table.includedFiles('unknown.c'), [])
  assert.equal(table.isReachable('unknown.c', 'a.c'), false)
  // 未记录哈希的文件返回 undefined
  assert.equal(table.contentHashOf('a.c'), undefined)
  // 条件：有则返回文本；无则连属性都不 materialize（与旧快照形状一致）
  assert.equal(table.findByName('guarded')[0]!.condition, '#ifdef G')
  const plain = table.findByName('plain')[0]!
  assert.equal(plain.condition, undefined)
  assert.equal(Object.hasOwn(plain, 'condition'), false)
  assert.equal(table.entriesInFile('a.c')[1]!.condition, '#ifdef G')
})
