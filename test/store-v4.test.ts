import test from 'node:test'
import assert from 'node:assert/strict'

import { decodeSnapshot, encodeSnapshot } from '../src/core/store'
import { createSymbolTable, getSymbolTableColumns } from '../src/core/symbol-table'
import type { FileRecord, SymbolEntry } from '../src/shared/types'
import { SNAPSHOT_VERSION } from '../src/shared/types'

/** 长条件（中文 + 超 120 字符）：验证条件字符串表按字节长度正确编码/解码。 */
const LONG_CONDITION = '#if defined(中文配置) && ' + 'FEATURE_'.repeat(16) + 'ENABLED'

function entry(overrides: Partial<SymbolEntry> & Pick<SymbolEntry, 'name' | 'file' | 'line'>): SymbolEntry {
  return {
    kind: 'function',
    endLine: overrides.line,
    column: 0,
    ...overrides,
  }
}

function makeTable() {
  const files: FileRecord[] = [
    { path: 'a.c', mtimeMs: 1.5, size: 10, contentHashLo: 0xdeadbeef, contentHashHi: 0x12345678 },
    { path: 'inc/中文 x.h', mtimeMs: 2, size: 20, contentHashLo: 1, contentHashHi: 0xffffffff },
    { path: 'inc/y.h', mtimeMs: 3, size: 30 },
  ]
  const entries: SymbolEntry[] = [
    entry({ name: 'plain', file: 'inc/y.h', line: 2, endLine: 4, column: 4 }),
    entry({ name: 'guarded', file: 'inc/中文 x.h', line: 7, endLine: 9, column: 1, condition: LONG_CONDITION }),
    entry({ name: 'nested', file: 'inc/y.h', line: 11, endLine: 11, column: 2, condition: '#ifdef A && #ifdef B' }),
  ]
  const includes = new Map<string, readonly string[]>([
    ['a.c', ['inc/中文 x.h', 'inc/y.h']],
    ['inc/中文 x.h', ['inc/y.h']],
    ['inc/y.h', []],
  ])
  return createSymbolTable(['.', 'inc'], files, entries, 42, SNAPSHOT_VERSION, { includes })
}

test('store v4: roundtrip keeps content hash, conditions and include edges', () => {
  const table = makeTable()
  const decoded = decodeSnapshot(encodeSnapshot(table))
  assert.ok(decoded, 'v4 snapshot must decode')
  assert.equal(decoded!.version, SNAPSHOT_VERSION)
  assert.equal(decoded!.builtAt, 42)
  assert.deepEqual(decoded!.roots, ['.', 'inc'])
  assert.deepEqual(decoded!.files, table.files, 'file records (含 hash) 原样保留')

  assert.deepEqual(decoded!.contentHashOf('a.c'), { lo: 0xdeadbeef, hi: 0x12345678 })
  assert.deepEqual(decoded!.contentHashOf('inc/中文 x.h'), { lo: 1, hi: 0xffffffff })
  assert.equal(decoded!.contentHashOf('inc/y.h'), undefined)

  // 条件：长中文条件完整保留；无条件条目不应带条件
  assert.equal(decoded!.findByName('guarded')[0]!.condition, LONG_CONDITION)
  assert.equal(decoded!.findByName('nested')[0]!.condition, '#ifdef A && #ifdef B')
  const plain = decoded!.findByName('plain')[0]!
  assert.equal(plain.condition, undefined)
  assert.equal(Object.hasOwn(plain, 'condition'), false)

  // include CSR：多目标顺序保留，空集合保留为空
  assert.deepEqual(decoded!.includedFiles('a.c'), ['inc/中文 x.h', 'inc/y.h'])
  assert.deepEqual(decoded!.includedFiles('inc/中文 x.h'), ['inc/y.h'])
  assert.deepEqual(decoded!.includedFiles('inc/y.h'), [])
  assert.equal(decoded!.isReachable('a.c', 'inc/y.h'), true)
  assert.equal(decoded!.isReachable('inc/y.h', 'a.c'), false)

  assert.deepEqual(
    decoded!.toArray().sort((a, b) => a.name.localeCompare(b.name)),
    table.toArray().sort((a, b) => a.name.localeCompare(b.name)),
  )

  // 构建输出行为未切换前（Task 3 之前）写出的表没有任何 hash/include/condition，
  // 编码/解码必须照常工作，不能因为 0/空值把可选字段 materialize 出来。
  const bareFiles: FileRecord[] = [{ path: 'a.c', mtimeMs: 1, size: 1 }]
  const bareEntries: SymbolEntry[] = [entry({ name: 'alpha', file: 'a.c', line: 1, endLine: 2 })]
  const bare = createSymbolTable(['.'], bareFiles, bareEntries, 7, SNAPSHOT_VERSION)
  const bareDecoded = decodeSnapshot(encodeSnapshot(bare))
  assert.ok(bareDecoded)
  assert.deepEqual(bareDecoded!.files, bareFiles)
  assert.equal(bareDecoded!.contentHashOf('a.c'), undefined)
  assert.deepEqual(bareDecoded!.includedFiles('a.c'), [])
  assert.deepEqual(bareDecoded!.findByName('alpha'), bareEntries)
})

test('store v4: snapshots with a foreign/old version are rejected', () => {
  const encoded = encodeSnapshot(makeTable())
  for (const version of [1, 2, 3, 5]) {
    const patched = Buffer.from(encoded)
    patched.writeUInt32LE(version, 4)
    assert.equal(decodeSnapshot(patched), undefined, `version ${version} must be rejected`)
  }
  // 截断 / 坏 magic 同样拒绝
  assert.equal(decodeSnapshot(encoded.subarray(0, encoded.length - 4)), undefined)
  const badMagic = Buffer.from(encoded)
  badMagic.write('XXXX', 0, 'latin1')
  assert.equal(decodeSnapshot(badMagic), undefined)
})

test('store v4: include CSR must start at offset 0', () => {
  const table = makeTable()
  const columns = getSymbolTableColumns(table)
  assert.ok(columns, 'built-in table exposes columns')
  const encoded = encodeSnapshot(table)
  assert.ok(decodeSnapshot(encoded), 'sanity: valid include CSR decodes')

  // includeOffsets/includeTargets 位于文件末尾；locate includeOffsets[0]
  const includeOffsetsStart = encoded.length - (columns!.includeOffsets.length + columns!.includeTargets.length) * 4
  assert.equal(encoded.readUInt32LE(includeOffsetsStart), 0, 'valid snapshot starts CSR at 0')

  const patched = Buffer.from(encoded)
  patched.writeUInt32LE(1, includeOffsetsStart)
  assert.equal(decodeSnapshot(patched), undefined, 'offset[0] != 0 must be rejected')
})
