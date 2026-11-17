import test from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendSnapshotDelta,
  appendSnapshotDeltaDetailed,
  compactSnapshot,
  decodeSnapshotDeltaRecords,
  encodeSnapshotDeltaRecord,
  flushSnapshotDeltaAppends,
  readSnapshotDeltas,
  readSnapshotDeltasDetailed,
  scanSnapshotDeltaEnd,
  snapshotDeltaBytes,
  snapshotDeltaPath,
} from '../src/core/snapshot-delta'
import { loadSnapshot } from '../src/core/store'
import { createSymbolTable } from '../src/core/symbol-table'
import { SNAPSHOT_VERSION } from '../src/shared/types'
import type { SymbolEntry } from '../src/shared/types'

function entry(name: string, file: string, line: number): SymbolEntry {
  return { name, kind: 'function', file, line, endLine: line + 1, column: 4 }
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'si-snapdelta-'))
}

test('snapshot delta: set/remove records roundtrip', async () => {
  const dir = await tempDir()
  try {
    const deltaPath = join(dir, 'symbols.sidx.delta')
    const set = {
      kind: 'set' as const,
      path: 'a.c',
      mtimeMs: 123.5,
      size: 42,
      entries: [entry('alpha', 'a.c', 1), entry('beta', 'a.c', 2)],
    }
    const bytes = await appendSnapshotDelta(deltaPath, set)
    assert.ok(bytes > 0)
    const entries = await readSnapshotDeltas(deltaPath)
    assert.equal(entries.length, 1)
    assert.deepEqual(entries[0], set)

    await appendSnapshotDelta(deltaPath, { kind: 'remove', path: 'b.c' })
    const both = await readSnapshotDeltas(deltaPath)
    assert.deepEqual(both.map((r) => r.kind), ['set', 'remove'])
    assert.ok((await snapshotDeltaBytes(deltaPath)) > bytes, 'delta grows after the second record')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('snapshot delta: truncated tail is ignored; bad magic yields []', async () => {
  const dir = await tempDir()
  try {
    const deltaPath = join(dir, 'x.delta')
    await appendSnapshotDelta(deltaPath, { kind: 'remove', path: 'a.c' })
    const size = (await stat(deltaPath)).size
    await truncate(deltaPath, size - 2)
    assert.deepEqual(await readSnapshotDeltas(deltaPath), [])

    await writeFile(deltaPath, Buffer.from('NOPE', 'latin1'))
    assert.deepEqual(await readSnapshotDeltas(deltaPath), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('snapshot delta: encode/decode clamps column to u16', () => {
  const record = {
    kind: 'set' as const,
    path: 'a.c',
    mtimeMs: 1,
    size: 1,
    entries: [{ ...entry('x', 'a.c', 0), column: 70_000 }],
  }
  const decoded = decodeSnapshotDeltaRecords(encodeSnapshotDeltaRecord(record))
  assert.equal(decoded[0]?.kind, 'set')
  if (decoded[0]?.kind === 'set') assert.equal(decoded[0].entries[0]?.column, 0xffff)
})

test('snapshot delta: compact writes the base and removes the delta', async () => {
  const dir = await tempDir()
  try {
    const basePath = join(dir, 'symbols.sidx')
    const table = createSymbolTable(
      ['root'],
      [{ path: 'a.c', mtimeMs: 1, size: 1 }],
      [entry('alpha', 'a.c', 1)],
      1,
      SNAPSHOT_VERSION,
    )
    await appendSnapshotDelta(snapshotDeltaPath(basePath), {
      kind: 'set',
      path: 'b.c',
      mtimeMs: 2,
      size: 2,
      entries: [entry('beta', 'b.c', 3)],
    })
    const result = await compactSnapshot(basePath, table)
    assert.ok(result.baseBytes > 0)
    assert.equal(result.deltaTruncated, true)

    const loaded = await loadSnapshot(basePath)
    assert.ok(loaded)
    assert.equal(loaded!.entryCount, 1)
    assert.equal(await snapshotDeltaBytes(snapshotDeltaPath(basePath)), 0)
    assert.deepEqual(await readSnapshotDeltas(snapshotDeltaPath(basePath)), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('snapshot delta: compaction keeps a delta whose size changed since flatten', async () => {
  const dir = await tempDir()
  try {
    const basePath = join(dir, 'symbols.sidx')
    const table = createSymbolTable(
      ['root'],
      [{ path: 'a.c', mtimeMs: 1, size: 1 }],
      [entry('alpha', 'a.c', 1)],
      1,
      SNAPSHOT_VERSION,
    )
    const deltaPath = snapshotDeltaPath(basePath)
    await appendSnapshotDelta(deltaPath, {
      kind: 'set',
      path: 'b.c',
      mtimeMs: 2,
      size: 2,
      entries: [entry('beta', 'b.c', 3)],
    })
    const expected = await snapshotDeltaBytes(deltaPath)
    assert.ok(expected > 0)

    // 另一个窗口在 flatten 之后追加了记录：大小与预期不符，delta 必须保留。
    const conflicted = await compactSnapshot(basePath, table, { expectedDeltaBytes: expected + 1 })
    assert.ok(conflicted.baseBytes > 0)
    assert.equal(conflicted.deltaTruncated, false)
    assert.equal(conflicted.deltaKeptConflict, true)
    assert.equal(await snapshotDeltaBytes(deltaPath), expected, 'changed delta survives the compaction')
    assert.deepEqual(
      (await readSnapshotDeltas(deltaPath)).map((record) => record.kind),
      ['set'],
      'kept delta is still decodable',
    )

    // 大小与预期一致：正常删除 delta，base 仍是本次写入的整表。
    const clean = await compactSnapshot(basePath, table, { expectedDeltaBytes: expected })
    assert.equal(clean.deltaTruncated, true)
    assert.equal(clean.deltaKeptConflict, false)
    assert.equal(await snapshotDeltaBytes(deltaPath), 0, 'matching delta is removed')
    const loaded = await loadSnapshot(basePath)
    assert.ok(loaded)
    assert.equal(loaded!.entryCount, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('snapshot delta: torn record tail is truncated before append so later records stay decodable', async () => {
  const dir = await tempDir()
  try {
    const deltaPath = join(dir, 'torn-tail.delta')
    const first = {
      kind: 'set' as const,
      path: 'a.c',
      mtimeMs: 1.5,
      size: 10,
      entries: [entry('alpha', 'a.c', 1), entry('beta', 'a.c', 2)],
    }
    const second = { kind: 'remove' as const, path: 'b.c' }
    await appendSnapshotDelta(deltaPath, first)
    await appendSnapshotDelta(deltaPath, second)
    // 把最后一条记录撕掉 3 字节：first 完整，second 残缺。
    await truncate(deltaPath, (await stat(deltaPath)).size - 3)
    const third = {
      kind: 'set' as const,
      path: 'c.c',
      mtimeMs: 3.5,
      size: 30,
      entries: [entry('gamma', 'c.c', 3)],
    }
    await appendSnapshotDelta(deltaPath, third)
    // 两条「完整」记录都还能解码：残缺的 second 被截掉，third 不受影响。
    assert.deepEqual(await readSnapshotDeltas(deltaPath), [first, third])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('snapshot delta: partial header is replaced by append', async () => {
  const dir = await tempDir()
  try {
    const deltaPath = join(dir, 'torn-header.delta')
    await writeFile(deltaPath, Buffer.from('SID', 'latin1'))
    const record = {
      kind: 'set' as const,
      path: 'a.c',
      mtimeMs: 1,
      size: 1,
      entries: [entry('alpha', 'a.c', 1)],
    }
    const bytes = await appendSnapshotDelta(deltaPath, record)
    assert.equal(bytes, encodeSnapshotDeltaRecord(record).length)
    assert.deepEqual(await readSnapshotDeltas(deltaPath), [record])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('snapshot delta: wrong version prefix is replaced by append', async () => {
  const dir = await tempDir()
  try {
    const deltaPath = join(dir, 'wrong-version.delta')
    const bogus = Buffer.alloc(16)
    bogus.write('SIDD', 0, 'latin1')
    bogus.writeUInt32LE(2, 4)
    bogus.writeUInt8(0, 8)
    bogus.writeUInt32LE(3, 9)
    bogus.write('old', 13, 'utf8')
    await writeFile(deltaPath, bogus)
    const record = { kind: 'remove' as const, path: 'new.c' }
    const bytes = await appendSnapshotDelta(deltaPath, record)
    assert.equal(bytes, encodeSnapshotDeltaRecord(record).length)
    assert.deepEqual(await readSnapshotDeltas(deltaPath), [record])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('snapshot delta: bad magic with valid length is replaced by append', async () => {
  const dir = await tempDir()
  try {
    const deltaPath = join(dir, 'bad-magic.delta')
    await writeFile(deltaPath, Buffer.alloc(16, 0xab))
    const record = {
      kind: 'set' as const,
      path: 'ok.c',
      mtimeMs: 2,
      size: 2,
      entries: [entry('ok', 'ok.c', 2)],
    }
    await appendSnapshotDelta(deltaPath, record)
    assert.deepEqual(await readSnapshotDeltas(deltaPath), [record])
    assert.equal(await snapshotDeltaBytes(deltaPath), encodeSnapshotDeltaRecord(record).length)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('snapshot delta: concurrent first appends are serialized', async () => {
  const dir = await tempDir()
  try {
    const deltaPath = join(dir, 'race.delta')
    const records = Array.from({ length: 8 }, (_, index) => ({
      kind: 'set' as const,
      path: `f${index}.c`,
      mtimeMs: index,
      size: index + 1,
      entries: [entry(`sym${index}`, `f${index}.c`, index + 1)],
    }))
    await Promise.all(records.map((record) => appendSnapshotDelta(deltaPath, record)))
    assert.deepEqual(await readSnapshotDeltas(deltaPath), records)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('snapshot delta: flush waits for in-flight appends and leaves the lock map empty', async () => {
  const dir = await tempDir()
  try {
    const deltaPath = join(dir, 'flush.delta')
    const records = Array.from({ length: 12 }, (_, index) => ({
      kind: 'set' as const,
      path: `flush${index}.c`,
      mtimeMs: index + 0.5,
      size: index + 1,
      entries: [entry(`flushSym${index}`, `flush${index}.c`, index + 1)],
    }))
    // 不 await：全部在途，flush 必须等到它们全部落盘。
    for (const record of records) void appendSnapshotDelta(deltaPath, record)
    await flushSnapshotDeltaAppends()
    assert.deepEqual(await readSnapshotDeltas(deltaPath), records)

    // flush 之后锁链已清空（map 为空）：新的 append 立刻可用且可解码。
    const extra = { kind: 'remove' as const, path: 'after-flush.c' }
    await appendSnapshotDelta(deltaPath, extra)
    assert.deepEqual(await readSnapshotDeltas(deltaPath), [...records, extra])

    // 没有在途 append 时 flush 也必须安全返回（不抛错）。
    await flushSnapshotDeltaAppends()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('snapshot delta: unreadable existing delta is not overwritten', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('EACCES cannot be enforced when running as root')
    return
  }
  const dir = await tempDir()
  const deltaPath = join(dir, 'eacces.delta')
  try {
    const first = { kind: 'remove' as const, path: 'a.c' }
    await appendSnapshotDelta(deltaPath, first)
    const before = await readFile(deltaPath)
    // 0o200：不可读但可写。旧实现会把 EACCES 当成「文件不存在」而继续 append，
    // 从而在有效记录后插入第二个头（数据不可解码）；修复后必须直接 reject。
    await chmod(deltaPath, 0o200)
    await assert.rejects(appendSnapshotDelta(deltaPath, { kind: 'remove', path: 'b.c' }))
    await chmod(deltaPath, 0o600)
    assert.deepEqual(await readFile(deltaPath), before, 'unreadable delta must not be rewritten')
  } finally {
    await chmod(deltaPath, 0o600).catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
  }
})

// --------------------------------------------------- offset-only tail scanner

test('snapshot delta: scanSnapshotDeltaEnd returns end/recordCount for three records', async () => {
  const dir = await tempDir()
  try {
    const deltaPath = join(dir, 'scan.delta')
    const records = [
      {
        kind: 'set' as const,
        path: 'a.c',
        mtimeMs: 1.5,
        size: 10,
        entries: [entry('alpha', 'a.c', 1), entry('beta', 'a.c', 2)],
      },
      { kind: 'remove' as const, path: 'b.c' },
      {
        kind: 'set' as const,
        path: 'c.c',
        mtimeMs: 3.5,
        size: 30,
        entries: [entry('gamma', 'c.c', 3)],
      },
    ]
    for (const record of records) await appendSnapshotDelta(deltaPath, record)
    const buffer = await readFile(deltaPath)
    const scan = scanSnapshotDeltaEnd(buffer)
    assert.equal(scan.valid, true)
    assert.equal(scan.recordCount, 3)
    assert.equal(scan.end, buffer.length)

    // 撕裂最后 3 字节：只应数出前两条完整记录，end 落在第三条之前。
    const torn = scanSnapshotDeltaEnd(buffer.subarray(0, buffer.length - 3))
    assert.equal(torn.valid, true)
    assert.equal(torn.recordCount, 2)
    assert.ok(torn.end < buffer.length - 3)

    // 坏 magic / 版本不符：valid=false，end=0（整个文件都必须重建）。
    assert.deepEqual(scanSnapshotDeltaEnd(Buffer.from('NOPE', 'latin1')), {
      end: 0,
      recordCount: 0,
      valid: false,
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('snapshot delta: append over a populated delta keeps all records decodable', async () => {
  const dir = await tempDir()
  try {
    const deltaPath = join(dir, 'populated.delta')
    const records = Array.from({ length: 3 }, (_, index) => ({
      kind: 'set' as const,
      path: `f${index}.c`,
      mtimeMs: index + 0.5,
      size: index,
      entries: [entry(`sym${index}`, `f${index}.c`, index)],
    }))
    for (let index = 0; index < records.length; index++) {
      const result = await appendSnapshotDeltaDetailed(deltaPath, records[index]!)
      assert.equal(result.reset, false)
      assert.equal(result.recordCount, index + 1, `record count after append #${index + 1}`)
      assert.equal(result.size, (await stat(deltaPath)).size, 'reported size matches stat')
    }
    // 追加后的文件仍能完整解码（offset 扫描 + 追加没有破坏前面的记录）。
    assert.deepEqual(await readSnapshotDeltas(deltaPath), records)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('snapshot delta: detailed read drops the tail from the first corrupt record', async () => {
  const dir = await tempDir()
  try {
    const deltaPath = join(dir, 'corrupt-middle.delta')
    const records = [
      { kind: 'remove' as const, path: 'a.c' },
      { kind: 'remove' as const, path: 'b.c' },
      { kind: 'remove' as const, path: 'c.c' },
    ]
    const encoded = records.map((record) => encodeSnapshotDeltaRecord(record))
    const buffer = Buffer.concat([
      encoded[0]!,
      encoded[1]!.subarray(8),
      encoded[2]!.subarray(8),
    ])
    // 把第二条记录的 kind 字节改成非法值：解码必须停在第一条，尾部全部丢弃。
    buffer.writeUInt8(9, encoded[0]!.length)
    await writeFile(deltaPath, buffer)

    const detailed = await readSnapshotDeltasDetailed(deltaPath)
    assert.equal(detailed.error, undefined)
    assert.deepEqual(detailed.records, [records[0]])
    assert.equal(detailed.droppedBytes, buffer.length - encoded[0]!.length)
    assert.deepEqual(await readSnapshotDeltas(deltaPath), [records[0]])

    // 坏 magic：整个文件不可解码，droppedBytes 为文件大小。
    await writeFile(deltaPath, Buffer.alloc(32, 0xab))
    assert.deepEqual(await readSnapshotDeltasDetailed(deltaPath), { records: [], droppedBytes: 32 })

    // ENOENT 不是错误：空 delta 是正常状态。
    assert.deepEqual(await readSnapshotDeltasDetailed(join(dir, 'missing.delta')), {
      records: [],
      droppedBytes: 0,
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('snapshot delta: detailed read reports unreadable file as error, not decode loss', async (t) => {
  if (process.getuid?.() === 0) {
    t.skip('EACCES cannot be enforced when running as root')
    return
  }
  const dir = await tempDir()
  const deltaPath = join(dir, 'unreadable.delta')
  try {
    await appendSnapshotDelta(deltaPath, { kind: 'remove', path: 'a.c' })
    await chmod(deltaPath, 0o200)
    const detailed = await readSnapshotDeltasDetailed(deltaPath)
    assert.deepEqual(detailed.records, [])
    assert.equal(detailed.droppedBytes, 0)
    assert.ok(detailed.error && /EACCES|permission/i.test(detailed.error), `error=${detailed.error}`)
  } finally {
    await chmod(deltaPath, 0o600).catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
  }
})
