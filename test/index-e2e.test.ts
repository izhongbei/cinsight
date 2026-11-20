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
import type { SymbolEntry, SymbolTable } from '../src/shared/types'

function entry(name: string, file: string, line: number): SymbolEntry {
  return { name, kind: 'function', file, line, endLine: line + 1, column: 2 }
}

/** v5 新符号的 parent 经 delta v3 重放/压缩后必须保留。 */
function assertSavedParents(table: SymbolTable): void {
  const one = (name: string): SymbolEntry => {
    const hits = table.findByName(name)
    assert.ok(hits.length > 0, `${name} should be indexed`)
    return hits[0]!
  }
  const member = one('a')
  assert.equal(member.kind, 'member')
  assert.equal(member.parent, 's')
  const constant = one('E_A')
  assert.equal(constant.kind, 'enumConstant')
  assert.equal(constant.parent, 'E')
  const global = one('g')
  assert.equal(global.kind, 'variable')
  assert.equal(global.parent, undefined)
  assert.equal(Object.hasOwn(global, 'parent'), false)
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

test('index e2e: delta v3 append -> reload keeps member/enumConstant parent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'si-index-parent-e2e-'))
  try {
    const basePath = join(dir, 'symbols.sidx')
    const base = createSymbolTable(
      ['root'],
      [{ path: 'base.c', mtimeMs: 1, size: 1 }],
      [entry('alpha', 'base.c', 1)],
      1,
      SNAPSHOT_VERSION,
    )
    await compactSnapshot(basePath, base)

    // 保存路径写出的 delta v3 set 记录：成员/枚举常量带 parent，全局变量无 parent。
    const saved: SymbolEntry[] = [
      { name: 'a', kind: 'member', file: 'types.h', line: 1, endLine: 1, column: 2, parent: 's' },
      { name: 'E_A', kind: 'enumConstant', file: 'types.h', line: 2, endLine: 2, column: 2, parent: 'E' },
      { name: 'g', kind: 'variable', file: 'types.h', line: 3, endLine: 3, column: 0 },
    ]
    await appendSnapshotDelta(snapshotDeltaPath(basePath), {
      kind: 'set',
      path: 'types.h',
      mtimeMs: 2,
      size: 42,
      entries: saved,
    })
    const records = await readSnapshotDeltas(snapshotDeltaPath(basePath))
    assert.equal(records.length, 1, 'one delta record for one save')

    // 重载（base + delta v3 重放）：parent 从记录还原。
    const replayed = createMutableIndexFromDeltas((await loadSnapshot(basePath))!, records)
    assertSavedParents(replayed)
    assertSavedParents(replayed.flatten())

    // compaction 后 base 快照本身也保留 parent。
    await compactSnapshot(basePath, replayed.flatten())
    assertSavedParents((await loadSnapshot(basePath))!)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
