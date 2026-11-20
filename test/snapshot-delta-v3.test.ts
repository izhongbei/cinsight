import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMutableIndexFromDeltas } from '../src/core/overlay-index'
import {
  SNAPSHOT_DELTA_VERSION,
  appendSnapshotDeltaDetailed,
  decodeSnapshotDeltaRecords,
  encodeSnapshotDeltaRecord,
  readSnapshotDeltasDetailed,
  scanSnapshotDeltaEnd,
} from '../src/core/snapshot-delta'
import type { SnapshotDeltaSetRecord } from '../src/core/snapshot-delta'
import { createSymbolTable, getSymbolTableColumns, KIND_CODES } from '../src/core/symbol-table'
import { SNAPSHOT_VERSION } from '../src/shared/types'
import type { FileRecord, SymbolEntry } from '../src/shared/types'

const LONG_PARENT = '类型_' + 'LongParent'.repeat(20)

function entry(overrides: Partial<SymbolEntry> & Pick<SymbolEntry, 'name' | 'line'>): SymbolEntry {
  return {
    kind: 'function',
    file: 'a.c',
    endLine: overrides.line + 1,
    column: 4,
    ...overrides,
  }
}

// --------------------------------------------------- v1 / v2 旧文件构造 ----

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

type LegacyEntry = Pick<SymbolEntry, 'name' | 'kind' | 'line' | 'endLine' | 'column' | 'condition'>
type LegacyRecord =
  | { readonly kind: 'remove'; readonly path: string }
  | {
      readonly kind: 'set'
      readonly path: string
      readonly mtimeMs: number
      readonly size: number
      readonly entries: readonly LegacyEntry[]
      readonly includes?: readonly string[]
      readonly contentHashLo?: number
      readonly contentHashHi?: number
    }

/** 按 v1 布局手写一条 delta（0.7.0 写出的旧文件：无 condition/hash/include）。 */
function buildV1Delta(records: readonly LegacyRecord[]): Buffer {
  const parts: Buffer[] = [Buffer.from('SIDD', 'latin1'), u32(1)]
  for (const record of records) {
    const pathBytes = Buffer.from(record.path, 'utf8')
    if (record.kind === 'remove') {
      parts.push(u8(1), u32(pathBytes.length), pathBytes)
      continue
    }
    parts.push(
      u8(0),
      u32(pathBytes.length),
      pathBytes,
      f64(record.mtimeMs),
      u32(record.size),
      u32(record.entries.length),
    )
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

/** 按 v2 布局手写一条 delta（0.8.0 写出的旧文件：有 condition/hash/include，无 parent）。 */
function buildV2Delta(records: readonly LegacyRecord[]): Buffer {
  const parts: Buffer[] = [Buffer.from('SIDD', 'latin1'), u32(2)]
  for (const record of records) {
    const pathBytes = Buffer.from(record.path, 'utf8')
    if (record.kind === 'remove') {
      parts.push(u8(1), u32(pathBytes.length), pathBytes)
      continue
    }
    const includes = record.includes ?? []
    parts.push(
      u8(0),
      u32(pathBytes.length),
      pathBytes,
      f64(record.mtimeMs),
      u32(record.size),
      u32(record.contentHashLo ?? 0),
      u32(record.contentHashHi ?? 0),
      u32(record.entries.length),
    )
    for (const item of record.entries) {
      const nameBytes = Buffer.from(item.name, 'utf8')
      const condition =
        item.condition === undefined || item.condition === '' ? undefined : Buffer.from(item.condition, 'utf8')
      parts.push(
        u32(nameBytes.length),
        nameBytes,
        u32(item.line),
        u32(item.endLine),
        u16(Math.min(item.column, 0xffff)),
        u8(KIND_CODES[item.kind] ?? 0),
        u32(condition?.length ?? 0),
      )
      if (condition) parts.push(condition)
    }
    parts.push(u32(includes.length))
    for (const includePath of includes) {
      const bytes = Buffer.from(includePath, 'utf8')
      parts.push(u32(bytes.length), bytes)
    }
  }
  return Buffer.concat(parts)
}

// ------------------------------------------------------------- v3 用例 ----

test('snapshot delta v3: set/remove records roundtrip parent（中文/长串/无 parent）', () => {
  assert.equal(SNAPSHOT_DELTA_VERSION, 3)
  const record: SnapshotDeltaSetRecord = {
    kind: 'set',
    path: 'src/a.c',
    mtimeMs: 123.5,
    size: 99,
    contentHashLo: 0xdeadbeef,
    contentHashHi: 0x12345678,
    entries: [
      entry({ name: 'sk_buff_len', kind: 'member', line: 1, file: 'src/a.c', parent: 'sk_buff' }),
      entry({ name: 'sk_buff_data', kind: 'member', line: 2, file: 'src/a.c', parent: 'sk_buff' }),
      entry({ name: 'COLOR_RED', kind: 'enumConstant', line: 5, endLine: 5, column: 0, file: 'src/a.c', parent: '枚举类型', condition: '#ifdef 中文' }),
      entry({ name: 'COLOR_BLUE', kind: 'enumConstant', line: 6, endLine: 6, column: 0, file: 'src/a.c', parent: LONG_PARENT }),
      entry({ name: 'global_count', kind: 'variable', line: 9, file: 'src/a.c' }),
    ],
    includes: ['inc/x.h', 'inc/中文 y.h'],
  }
  const block = encodeSnapshotDeltaRecord(record)
  const decoded = decodeSnapshotDeltaRecords(block)
  assert.deepEqual(decoded, [record])
  const decodedSet = decoded[0]!
  if (decodedSet.kind !== 'set') throw new Error('unreachable')
  assert.equal(decodedSet.entries[0]!.parent, 'sk_buff')
  assert.equal(decodedSet.entries[2]!.parent, '枚举类型')
  assert.equal(decodedSet.entries[3]!.parent, LONG_PARENT)
  // 无 parent 的条目不能 materialize 出 parent 属性（与旧数据形状一致）
  assert.equal(decodedSet.entries[4]!.parent, undefined)
  assert.equal(Object.hasOwn(decodedSet.entries[4]!, 'parent'), false)

  // remove 记录保持原样
  assert.deepEqual(decodeSnapshotDeltaRecords(encodeSnapshotDeltaRecord({ kind: 'remove', path: 'src/b.c' })), [
    { kind: 'remove', path: 'src/b.c' },
  ])

  // offset 扫描器必须按 v3 的 parent 字段（在 kind 之后、condition 之前）推进
  assert.deepEqual(scanSnapshotDeltaEnd(block), { end: block.length, recordCount: 1, valid: true })
})

test('snapshot delta v3: v2 记录仍可读，parent 为 undefined', () => {
  const v2 = buildV2Delta([
    {
      kind: 'set',
      path: 'old/a.c',
      mtimeMs: 5,
      size: 6,
      contentHashLo: 0x11111111,
      contentHashHi: 0x22222222,
      entries: [
        entry({ name: 'legacy', line: 3, file: 'old/a.c' }),
        entry({ name: 'guarded', line: 7, kind: 'macro', endLine: 7, file: 'old/a.c', condition: '#ifdef OLD' }),
      ],
      includes: ['inc/old.h'],
    },
    { kind: 'remove', path: 'old/gone.c' },
  ])
  assert.deepEqual(scanSnapshotDeltaEnd(v2), { end: v2.length, recordCount: 2, valid: true })
  const decoded = decodeSnapshotDeltaRecords(v2)
  assert.equal(decoded.length, 2)
  const set = decoded[0]!
  if (set.kind !== 'set') throw new Error('unreachable')
  assert.equal(set.path, 'old/a.c')
  assert.equal(set.contentHashLo, 0x11111111)
  assert.equal(set.contentHashHi, 0x22222222)
  assert.deepEqual(set.includes, ['inc/old.h'])
  assert.equal(set.entries[1]!.condition, '#ifdef OLD')
  for (const item of set.entries) {
    assert.equal(item.parent, undefined)
    assert.equal(Object.hasOwn(item, 'parent'), false)
  }
  assert.deepEqual(decoded[1], { kind: 'remove', path: 'old/gone.c' })
})

test('snapshot delta v3: v1 记录仍可读，parent/condition 均为 undefined', () => {
  const v1 = buildV1Delta([
    {
      kind: 'set',
      path: 'old/a.c',
      mtimeMs: 5,
      size: 6,
      entries: [entry({ name: 'legacy', line: 3, file: 'old/a.c' }), entry({ name: 'legacy_two', line: 7, kind: 'macro', file: 'old/a.c' })],
    },
    { kind: 'remove', path: 'old/gone.c' },
  ])
  assert.deepEqual(scanSnapshotDeltaEnd(v1), { end: v1.length, recordCount: 2, valid: true })
  const decoded = decodeSnapshotDeltaRecords(v1)
  assert.equal(decoded.length, 2)
  const set = decoded[0]!
  if (set.kind !== 'set') throw new Error('unreachable')
  assert.deepEqual(set.entries, [
    entry({ name: 'legacy', line: 3, file: 'old/a.c' }),
    entry({ name: 'legacy_two', line: 7, kind: 'macro', file: 'old/a.c' }),
  ])
  for (const item of set.entries) assert.equal(Object.hasOwn(item, 'parent'), false)
  assert.equal(Object.hasOwn(set, 'includes'), false)
  assert.deepEqual(decoded[1], { kind: 'remove', path: 'old/gone.c' })
})

test('snapshot delta v3: append/read 保留 parent；v2 文件追加时整体重置为 v3', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'si-delta-v3-'))
  try {
    const deltaPath = join(dir, 'symbols.sidx.delta')
    const records: SnapshotDeltaSetRecord[] = [
      {
        kind: 'set',
        path: 'src/a.c',
        mtimeMs: 42.25,
        size: 321,
        contentHashLo: 0x0badf00d,
        contentHashHi: 0xfeedface,
        entries: [
          entry({ name: 'sk_buff_len', kind: 'member', line: 1, file: 'src/a.c', parent: 'sk_buff' }),
          entry({ name: 'COLOR_RED', kind: 'enumConstant', line: 9, endLine: 9, column: 0, file: 'src/a.c', parent: '枚举' }),
          entry({ name: 'global_count', kind: 'variable', line: 12, file: 'src/a.c' }),
        ],
        includes: ['inc/x.h', 'inc/中 文.h'],
      },
      {
        kind: 'set',
        path: 'src/b.c',
        mtimeMs: 43,
        size: 4,
        entries: [entry({ name: 'other', line: 1, file: 'src/b.c', parent: LONG_PARENT })],
        includes: [],
      },
    ]
    for (const record of records) {
      const appended = await appendSnapshotDeltaDetailed(deltaPath, record)
      assert.equal(appended.reset, false)
    }
    const read = await readSnapshotDeltasDetailed(deltaPath)
    assert.equal(read.error, undefined)
    assert.equal(read.droppedBytes, 0)
    assert.deepEqual(read.records, records)

    // 回放 delta 时必须保留 parent（overlay → flatten 都不能丢）
    const base = createSymbolTable(
      ['.'],
      [{ path: 'src/a.c', mtimeMs: 1, size: 1 } satisfies FileRecord],
      [entry({ name: 'stale', line: 1, file: 'src/a.c' })],
      1,
      SNAPSHOT_VERSION,
    )
    const index = createMutableIndexFromDeltas(base, read.records)
    assert.equal(index.findByName('sk_buff_len')[0]!.parent, 'sk_buff')
    const flat = index.flatten()
    assert.equal(flat.findByName('sk_buff_len')[0]!.parent, 'sk_buff')
    assert.equal(flat.findByName('COLOR_RED')[0]!.parent, '枚举')
    assert.equal(flat.findByName('other')[0]!.parent, LONG_PARENT)
    assert.equal(flat.findByName('global_count')[0]!.parent, undefined)
    const flatColumns = getSymbolTableColumns(flat)
    assert.ok(flatColumns!.parents.includes('sk_buff'))

    // 写入 v1/v2 旧头：追加时必须整体重写为 v3（旧记录布局与新记录不能混排）
    for (const legacy of [
      buildV2Delta([{ kind: 'set', path: 'src/a.c', mtimeMs: 1, size: 1, entries: [entry({ name: 'legacy', line: 1, file: 'src/a.c' })] }]),
      buildV1Delta([{ kind: 'set', path: 'src/a.c', mtimeMs: 1, size: 1, entries: [entry({ name: 'legacy', line: 1, file: 'src/a.c' })] }]),
    ]) {
      const legacyPath = join(dir, 'legacy.delta')
      await writeFile(legacyPath, legacy)
      const reset = await appendSnapshotDeltaDetailed(legacyPath, records[0]!)
      assert.equal(reset.reset, true)
      assert.equal(reset.recordCount, 1)
      const legacyRead = await readSnapshotDeltasDetailed(legacyPath)
      assert.deepEqual(legacyRead.records, [records[0]])
      assert.equal(legacyRead.droppedBytes, 0)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('snapshot delta v3: 尾部扫描器与 v3 步长一致（多条记录/撕裂尾部）', () => {
  const first: SnapshotDeltaSetRecord = {
    kind: 'set',
    path: 'a.c',
    mtimeMs: 1.5,
    size: 10,
    entries: [
      entry({ name: 'alpha', line: 1, file: 'a.c', parent: '类型A' }),
      entry({ name: 'beta', line: 2, file: 'a.c', parent: LONG_PARENT }),
    ],
    includes: [],
  }
  const second: SnapshotDeltaSetRecord = {
    kind: 'set',
    path: 'b.c',
    mtimeMs: 3.5,
    size: 30,
    entries: [entry({ name: 'gamma', line: 3, file: 'b.c' })],
    includes: [],
  }
  const firstBlock = encodeSnapshotDeltaRecord(first)
  const secondBlock = encodeSnapshotDeltaRecord(second)
  const buffer = Buffer.concat([firstBlock, secondBlock.subarray(8)])
  assert.deepEqual(scanSnapshotDeltaEnd(buffer), { end: buffer.length, recordCount: 2, valid: true })
  assert.deepEqual(decodeSnapshotDeltaRecords(buffer), [first, second])

  // 撕裂最后 3 字节：只数出第一条完整记录，end 落在第二条之前
  const torn = buffer.subarray(0, buffer.length - 3)
  assert.deepEqual(scanSnapshotDeltaEnd(torn), { end: firstBlock.length, recordCount: 1, valid: true })

  // parent 长度前缀被破坏（指向缓冲区外）：该记录及其后尾部全部丢弃
  const corrupted = Buffer.from(buffer)
  // second 记录体：header(8) + kind(1) + pathLen(4) + path + mtime(8) + size(4) + hash(8)
  //   + entryCount(4) + nameLen(4) + name + line(4) + endLine(4) + column(2) + kind(1)
  //   -> 紧接着是 parentLen(4)
  const secondPathBytes = Buffer.byteLength('b.c', 'utf8')
  const secondNameBytes = Buffer.byteLength('gamma', 'utf8')
  const secondParentLenOffset =
    firstBlock.length + 1 + 4 + secondPathBytes + 8 + 4 + 8 + 4 + 4 + secondNameBytes + 4 + 4 + 2 + 1
  corrupted.writeUInt32LE(0xfffffff0, secondParentLenOffset)
  assert.equal(corrupted.readUInt32LE(secondParentLenOffset), 0xfffffff0)
  assert.deepEqual(scanSnapshotDeltaEnd(corrupted), { end: firstBlock.length, recordCount: 1, valid: true })
  assert.deepEqual(decodeSnapshotDeltaRecords(corrupted), [first])
})
