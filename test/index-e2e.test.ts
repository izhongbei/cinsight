import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMutableIndex, createMutableIndexFromDeltas } from '../src/core/overlay-index'
import {
  appendSnapshotDelta,
  compactSnapshot,
  readSnapshotDeltas,
  snapshotDeltaPath,
} from '../src/core/snapshot-delta'
import { createSymbolTable } from '../src/core/symbol-table'
import { loadSnapshot } from '../src/core/store'
import { SNAPSHOT_VERSION } from '../src/shared/types'
import type { SymbolEntry } from '../src/shared/types'

function entry(name: string, file: string, line: number): SymbolEntry {
  return { name, kind: 'function', file, line, endLine: line + 1, column: 2 }
}

test('index e2e: save -> delta -> reload -> compaction keeps the same symbol set', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'si-index-e2e-'))
  try {
    const basePath = join(dir, 'symbols.sidx')
    const base = createSymbolTable(
      ['root'],
      [{ path: 'a.c', mtimeMs: 1, size: 1 }],
      [entry('alpha', 'a.c', 1)],
      1,
      SNAPSHOT_VERSION,
    )
    await compactSnapshot(basePath, base) // 写 base

    const index = createMutableIndex((await loadSnapshot(basePath))!)
    index.applyFile({ path: 'b.c', mtimeMs: 2, size: 2 }, [entry('beta', 'b.c', 3)])
    index.applyFile({ path: 'a.c', mtimeMs: 2, size: 2 }, [entry('alpha', 'a.c', 2), entry('gamma', 'a.c', 5)])
    await appendSnapshotDelta(snapshotDeltaPath(basePath), {
      kind: 'set', path: 'b.c', mtimeMs: 2, size: 2, entries: [entry('beta', 'b.c', 3)],
    })
    await appendSnapshotDelta(snapshotDeltaPath(basePath), {
      kind: 'set', path: 'a.c', mtimeMs: 2, size: 2, entries: [entry('alpha', 'a.c', 2), entry('gamma', 'a.c', 5)],
    })

    // 模拟重载：base + delta
    const reloadedBase = (await loadSnapshot(basePath))!
    const records = await readSnapshotDeltas(snapshotDeltaPath(basePath))
    const reloaded = createMutableIndexFromDeltas(reloadedBase, records)
    assert.equal(reloaded.entryCount, 3)
    assert.deepEqual(reloaded.findByName('gamma').map((e) => e.file), ['a.c'])

    // compaction 后直接读 base 即可得到同样结果
    await compactSnapshot(basePath, reloaded.flatten())
    const compacted = (await loadSnapshot(basePath))!
    assert.equal(compacted.entryCount, 3)
    assert.deepEqual(compacted.findByName('gamma').map((e) => e.line), [5])
    assert.deepEqual(await readSnapshotDeltas(snapshotDeltaPath(basePath)), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('index e2e: changes that arrive during compaction survive(service order)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'si-index-race-'))
  try {
    const basePath = join(dir, 'symbols.sidx')
    const base = createSymbolTable(
      ['root'],
      [{ path: 'a.c', mtimeMs: 1, size: 1 }],
      [entry('alpha', 'a.c', 1)],
      1,
      SNAPSHOT_VERSION,
    )
    await compactSnapshot(basePath, base)
    const index = createMutableIndex((await loadSnapshot(basePath))!)

    // 模拟 service.compactNow：先 flatten，写入期间又有 B 到达（进入 deferred），写完后回放
    const flat = index.flatten()
    index.applyFile({ path: 'b.c', mtimeMs: 2, size: 2 }, [entry('beta', 'b.c', 3)]) // 写入期间到达
    await compactSnapshot(basePath, flat) // 只包含 A
    await appendSnapshotDelta(snapshotDeltaPath(basePath), {
      kind: 'set', path: 'b.c', mtimeMs: 2, size: 2, entries: [entry('beta', 'b.c', 3)],
    }) // deferred 回放

    const reloaded = createMutableIndexFromDeltas(
      (await loadSnapshot(basePath))!,
      await readSnapshotDeltas(snapshotDeltaPath(basePath)),
    )
    assert.deepEqual(reloaded.findByName('alpha').map((e) => e.file), ['a.c'])
    assert.deepEqual(reloaded.findByName('beta').map((e) => e.file), ['b.c'], 'change during compaction must not be lost')
    assert.equal(reloaded.entryCount, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
