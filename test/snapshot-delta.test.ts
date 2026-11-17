import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendSnapshotDelta,
  compactSnapshot,
  decodeSnapshotDeltaRecords,
  encodeSnapshotDeltaRecord,
  readSnapshotDeltas,
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
