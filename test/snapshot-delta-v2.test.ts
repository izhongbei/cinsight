import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SNAPSHOT_DELTA_VERSION,
  decodeSnapshotDeltaRecords,
  encodeSnapshotDeltaRecord,
  scanSnapshotDeltaEnd,
} from '../src/core/snapshot-delta'
import { KIND_CODES } from '../src/core/symbol-table'
import type { SymbolEntry } from '../src/shared/types'

function entry(overrides: Partial<SymbolEntry> & Pick<SymbolEntry, 'name' | 'line'>): SymbolEntry {
  return {
    kind: 'function',
    file: 'a.c',
    endLine: overrides.line + 1,
    column: 4,
    ...overrides,
  }
}

// ------------------------------------------------------------ v1 buffer 构造

function u8(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(1)
  buffer.writeUInt8(value, 0)
  return buffer
}
function u16(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(2)
  buffer.writeUInt16LE(value, 0)
  return buffer
}
function u32(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(4)
  buffer.writeUInt32LE(value >>> 0, 0)
  return buffer
}
function f64(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(8)
  buffer.writeDoubleLE(value, 0)
  return buffer
}

/** 按 v1 布局手写一条 delta（模拟 0.7.0 写出的旧文件）。 */
function buildV1Delta(
  records: Array<
    | { kind: 'remove'; path: string }
    | { kind: 'set'; path: string; mtimeMs: number; size: number; entries: readonly SymbolEntry[] }
  >,
): Buffer {
  const parts: Buffer[] = [Buffer.from('SIDD', 'latin1'), u32(1)]
  for (const record of records) {
    const pathBytes = Buffer.from(record.path, 'utf8')
    if (record.kind === 'remove') {
      parts.push(u8(1), u32(pathBytes.length), pathBytes)
      continue
    }
    parts.push(u8(0), u32(pathBytes.length), pathBytes, f64(record.mtimeMs), u32(record.size), u32(record.entries.length))
    for (const item of record.entries) {
      const nameBytes = Buffer.from(item.name, 'utf8')
      parts.push(
        u32(nameBytes.length),
        nameBytes,
        u32(item.line),
        u32(item.endLine),
        u16(Math.min(item.column, 0xffff)),
        u8(KIND_CODES[item.kind] ?? 0),
      )
    }
  }
  return Buffer.concat(parts)
}

// ------------------------------------------------------------------- v2 用例

test('snapshot delta v2: set/remove records roundtrip hash, condition and includes', () => {
  assert.equal(SNAPSHOT_DELTA_VERSION, 2)
  const record = {
    kind: 'set' as const,
    path: 'src/a.c',
    mtimeMs: 123.5,
    size: 99,
    contentHashLo: 0xdeadbeef,
    contentHashHi: 0x12345678,
    entries: [
      entry({ name: 'plain', line: 1, file: 'src/a.c' }),
      entry({ name: 'guarded', line: 5, kind: 'struct', endLine: 9, column: 0, file: 'src/a.c', condition: '#ifdef 中文 && LONG' }),
    ],
    includes: ['inc/x.h', 'inc/中文 y.h'],
  }
  const decoded = decodeSnapshotDeltaRecords(encodeSnapshotDeltaRecord(record))
  assert.equal(decoded.length, 1)
  const decodedSet = decoded[0]!
  assert.equal(decodedSet.kind, 'set')
  if (decodedSet.kind !== 'set') throw new Error('unreachable')
  assert.equal(decodedSet.path, 'src/a.c')
  assert.equal(decodedSet.mtimeMs, 123.5)
  assert.equal(decodedSet.size, 99)
  assert.equal(decodedSet.contentHashLo, 0xdeadbeef)
  assert.equal(decodedSet.contentHashHi, 0x12345678)
  assert.deepEqual(decodedSet.includes, ['inc/x.h', 'inc/中文 y.h'])
  assert.deepEqual(decodedSet.entries, record.entries)

  // remove 记录保持原样
  const remove = decodeSnapshotDeltaRecords(encodeSnapshotDeltaRecord({ kind: 'remove', path: 'src/b.c' }))
  assert.deepEqual(remove, [{ kind: 'remove', path: 'src/b.c' }])

  // 无元数据的 set（Task 2 的服务层仍这样写）不应 materialize 可选字段
  const bare = decodeSnapshotDeltaRecords(
    encodeSnapshotDeltaRecord({ kind: 'set', path: 'c.c', mtimeMs: 1, size: 2, entries: [entry({ name: 'only', line: 1 })] }),
  )
  assert.equal(bare.length, 1)
  const bareSet = bare[0]!
  if (bareSet.kind !== 'set') throw new Error('unreachable')
  assert.equal(Object.hasOwn(bareSet, 'includes'), false)
  assert.equal(Object.hasOwn(bareSet, 'contentHashLo'), false)
  assert.equal(Object.hasOwn(bareSet.entries[0]!, 'condition'), false)

  // scanSnapshotDeltaEnd 必须按 v2 布局正确游标（含条件/include 字段）
  const block = encodeSnapshotDeltaRecord(record)
  const scan = scanSnapshotDeltaEnd(block)
  assert.deepEqual(scan, { end: block.length, recordCount: 1, valid: true })
})

test('snapshot delta v2: v1 records are read with default metadata', () => {
  const v1 = buildV1Delta([
    {
      kind: 'set',
      path: 'old/a.c',
      mtimeMs: 5,
      size: 6,
      entries: [entry({ name: 'legacy', line: 3 }), entry({ name: 'legacy_two', line: 7, kind: 'macro' })],
    },
    { kind: 'remove', path: 'old/gone.c' },
  ])
  assert.deepEqual(scanSnapshotDeltaEnd(v1), { end: v1.length, recordCount: 2, valid: true })
  const decoded = decodeSnapshotDeltaRecords(v1)
  assert.equal(decoded.length, 2)
  const set = decoded[0]!
  assert.equal(set.kind, 'set')
  if (set.kind !== 'set') throw new Error('unreachable')
  assert.equal(set.path, 'old/a.c')
  assert.equal(set.mtimeMs, 5)
  assert.equal(set.size, 6)
  assert.deepEqual(set.entries, [
    entry({ name: 'legacy', line: 3, file: 'old/a.c' }),
    entry({ name: 'legacy_two', line: 7, kind: 'macro', file: 'old/a.c' }),
  ])
  // v1 缺失字段取默认：hash 0、condition undefined、includes []
  assert.equal(set.contentHashLo ?? 0, 0)
  assert.equal(set.contentHashHi ?? 0, 0)
  assert.equal(set.entries[0]!.condition, undefined)
  assert.deepEqual(set.includes ?? [], [])
  assert.deepEqual(decoded[1], { kind: 'remove', path: 'old/gone.c' })
})
