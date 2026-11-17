import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SNAPSHOT_DELTA_VERSION,
  appendSnapshotDeltaDetailed,
  decodeSnapshotDeltaRecords,
  encodeSnapshotDeltaRecord,
  readSnapshotDeltasDetailed,
  scanSnapshotDeltaEnd,
} from '../src/core/snapshot-delta'
import type { SnapshotDeltaSetRecord } from '../src/core/snapshot-delta'
import { createMutableIndexFromDeltas } from '../src/core/overlay-index'
import { createSymbolTable, KIND_CODES } from '../src/core/symbol-table'
import { SNAPSHOT_VERSION } from '../src/shared/types'
import type { FileRecord, SymbolEntry } from '../src/shared/types'

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

/** base 里 a.c 有一条 include 边 a.c -> inc/x.h，用于验证 replay 的覆盖/保留语义。 */
function makeBaseWithInclude(): ReturnType<typeof createSymbolTable> {
  const files: FileRecord[] = [
    { path: 'a.c', mtimeMs: 1, size: 10, contentHashLo: 11, contentHashHi: 12 },
    { path: 'inc/x.h', mtimeMs: 2, size: 20, contentHashLo: 21, contentHashHi: 22 },
  ]
  const entries: SymbolEntry[] = [
    entry({ name: 'alpha', line: 1, file: 'a.c' }),
    entry({ name: 'x', line: 1, file: 'inc/x.h' }),
  ]
  const includes = new Map<string, readonly string[]>([['a.c', ['inc/x.h']]])
  return createSymbolTable(['.'], files, entries, 1, SNAPSHOT_VERSION, { includes })
}

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

  // v2 set 的 includeCount 总是权威值：没写 include 也要 materialize 成 []，
  // 否则重放时无法区分「现在没有 include」与 v1 的「include 未知」。
  // hash/condition 缺失仍按旧形状省略可选属性。
  const bare = decodeSnapshotDeltaRecords(
    encodeSnapshotDeltaRecord({ kind: 'set', path: 'c.c', mtimeMs: 1, size: 2, entries: [entry({ name: 'only', line: 1 })] }),
  )
  assert.equal(bare.length, 1)
  const bareSet = bare[0]!
  if (bareSet.kind !== 'set') throw new Error('unreachable')
  assert.equal(Object.hasOwn(bareSet, 'includes'), true)
  assert.deepEqual(bareSet.includes, [])
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
  // v1 缺失字段：hash 取 0、condition undefined；includes 字段必须缺失（v1 没有 include
  // 信息，不能当作权威的空数组，否则回放会误清 base 边）。
  assert.equal(set.contentHashLo ?? 0, 0)
  assert.equal(set.contentHashHi ?? 0, 0)
  assert.equal(set.entries[0]!.condition, undefined)
  assert.equal(Object.hasOwn(set, 'includes'), false)
  assert.deepEqual(decoded[1], { kind: 'remove', path: 'old/gone.c' })
})

test('snapshot delta v2: explicit empty includes roundtrips as []', () => {
  const record: SnapshotDeltaSetRecord = {
    kind: 'set',
    path: 'empty.c',
    mtimeMs: 7,
    size: 8,
    entries: [entry({ name: 'none', line: 1, file: 'empty.c' })],
    includes: [],
  }
  const block = encodeSnapshotDeltaRecord(record)
  const decoded = decodeSnapshotDeltaRecords(block)
  assert.equal(decoded.length, 1)
  const set = decoded[0]!
  if (set.kind !== 'set') throw new Error('unreachable')
  // 「显式空」必须在解码后仍然可见，不能被省略成「未知」
  assert.equal(Object.hasOwn(set, 'includes'), true)
  assert.deepEqual(set.includes, [])
  assert.deepEqual(scanSnapshotDeltaEnd(block), { end: block.length, recordCount: 1, valid: true })
})

test('snapshot delta v2: replay of empty includes clears stale base edges', () => {
  const base = makeBaseWithInclude()
  assert.deepEqual(base.includedFiles('a.c'), ['inc/x.h'])
  assert.equal(base.isReachable('a.c', 'inc/x.h'), true)

  // v2 记录：a.c 现在没有任何 include
  const records = decodeSnapshotDeltaRecords(
    encodeSnapshotDeltaRecord({
      kind: 'set',
      path: 'a.c',
      mtimeMs: 9,
      size: 90,
      entries: [entry({ name: 'alpha', line: 1 })],
      includes: [],
    }),
  )
  const index = createMutableIndexFromDeltas(base, records)
  assert.deepEqual(index.includedFiles('a.c'), [], 'stale base edge must be cleared')
  assert.equal(index.isReachable('a.c', 'inc/x.h'), false)

  // compaction 走 flatten：清空后的边必须写进新 base，而不是回退到旧边
  const flat = index.flatten()
  assert.deepEqual(flat.includedFiles('a.c'), [])
  assert.equal(flat.isReachable('a.c', 'inc/x.h'), false)

  // base 本身不可变：旧表仍保留原边
  assert.deepEqual(base.includedFiles('a.c'), ['inc/x.h'])
})

test('snapshot delta v2: append/read roundtrip keeps hash, per-entry conditions and includes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'si-delta-v2-'))
  try {
    const deltaPath = join(dir, 'symbols.sidx.delta')
    const record: SnapshotDeltaSetRecord = {
      kind: 'set',
      path: 'src/a.c',
      mtimeMs: 42.25,
      size: 321,
      contentHashLo: 0x0badf00d,
      contentHashHi: 0xfeedface,
      entries: [
        entry({ name: 'plain', line: 1, file: 'src/a.c' }),
        entry({ name: 'guarded', line: 9, kind: 'macro', endLine: 9, column: 0, file: 'src/a.c', condition: '#if defined(A) && B' }),
        entry({ name: 'chinese', line: 12, file: 'src/a.c', condition: '#ifdef 中文' }),
      ],
      includes: ['inc/x.h', 'inc/中 文.h'],
    }
    const appended = await appendSnapshotDeltaDetailed(deltaPath, record)
    assert.equal(appended.reset, false)
    assert.equal(appended.recordCount, 1)

    const read = await readSnapshotDeltasDetailed(deltaPath)
    assert.equal(read.error, undefined)
    assert.equal(read.droppedBytes, 0)
    assert.deepEqual(read.records, [record])

    const decoded = read.records[0]!
    if (decoded.kind !== 'set') throw new Error('unreachable')
    assert.equal(decoded.contentHashLo, 0x0badf00d)
    assert.equal(decoded.contentHashHi, 0xfeedface)
    assert.deepEqual(decoded.includes, ['inc/x.h', 'inc/中 文.h'])
    assert.deepEqual(
      decoded.entries.map((item) => item.condition),
      [undefined, '#if defined(A) && B', '#ifdef 中文'],
    )
    assert.deepEqual(decoded.entries, record.entries)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('snapshot delta v2: v1 replay leaves base include edges unchanged', () => {
  const base = makeBaseWithInclude()
  const v1 = buildV1Delta([
    { kind: 'set', path: 'a.c', mtimeMs: 5, size: 6, entries: [entry({ name: 'legacy', line: 3 })] },
  ])
  const decoded = decodeSnapshotDeltaRecords(v1)
  assert.equal(decoded.length, 1)
  const set = decoded[0]!
  if (set.kind !== 'set') throw new Error('unreachable')
  assert.equal(Object.hasOwn(set, 'includes'), false)

  const index = createMutableIndexFromDeltas(base, decoded)
  // v1 记录照常替换条目，但 include 信息未知：base 边必须原样保留
  assert.deepEqual(index.entriesInFile('a.c').map((item) => item.name), ['legacy'])
  assert.deepEqual(index.includedFiles('a.c'), ['inc/x.h'])
  assert.equal(index.isReachable('a.c', 'inc/x.h'), true)
})

test('snapshot delta v2: out-of-range condition length drops records from there on', () => {
  const condition = '#ifdef LONG_CONDITION'
  const encoded = encodeSnapshotDeltaRecord({
    kind: 'set',
    path: 'b.c',
    mtimeMs: 1,
    size: 2,
    entries: [entry({ name: 'guarded', line: 2, file: 'b.c', condition })],
    includes: [],
  })
  // set 记录布局（header 之后）：kind(1)+pathLen(4)+path + mtime(8)+size(4)+hashLo/Hi(8)
  //   + entryCount(4) + [nameLen(4)+name+line(4)+endLine(4)+column(2)+kind(1)]
  //   -> 紧接着是 conditionLen(4)
  const pathBytes = Buffer.byteLength('b.c', 'utf8')
  const nameBytes = Buffer.byteLength('guarded', 'utf8')
  const conditionLengthOffset =
    8 + 1 + 4 + pathBytes + 8 + 4 + 4 + 4 + 4 + 4 + nameBytes + 4 + 4 + 2 + 1
  assert.equal(encoded.readUInt32LE(conditionLengthOffset), Buffer.byteLength(condition, 'utf8'))

  const corrupted = Buffer.from(encoded)
  corrupted.writeUInt32LE(0xfffffff0, conditionLengthOffset)
  const good = encodeSnapshotDeltaRecord({ kind: 'remove', path: 'gone.c' })
  const buffer = Buffer.concat([good, corrupted])
  // 越界记录及其后的尾部全部丢弃，之前的完整记录保留（与撕裂尾部同一恢复策略）
  assert.deepEqual(decodeSnapshotDeltaRecords(buffer), [{ kind: 'remove', path: 'gone.c' }])
  assert.deepEqual(scanSnapshotDeltaEnd(buffer), { end: good.length, recordCount: 1, valid: true })

  // 条件正文本身被截断（长度前缀合法但字节不足）同样丢弃该记录
  const truncated = encoded.subarray(0, encoded.length - 3)
  assert.deepEqual(decodeSnapshotDeltaRecords(truncated), [])
})
