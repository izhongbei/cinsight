/**
 * 引用索引的增量 delta：单文件保存只追加 KB 级记录，不重写整个索引。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendNameIndexDelta,
  applyNameIndexDeltas,
  candidatesForName,
  collectIdentifierHashes,
  compactNameIndex,
  loadNameIndex,
  loadNameIndexWithDelta,
  nameIndexDeltaBytes,
  nameIndexDeltaPath,
  readNameIndexDeltas,
  saveNameIndex,
} from '../src/core/nameindex'
import type { NameIndexData } from '../src/shared/types'

function dataFrom(files: readonly [string, string][]): NameIndexData {
  const slices = files.map(([, text]) => collectIdentifierHashes(text))
  const filePaths = files.map(([path]) => path)
  const offsets = new Uint32Array(filePaths.length + 1)
  let total = 0
  for (let i = 0; i < slices.length; i++) {
    offsets[i] = total
    total += slices[i]!.length
  }
  offsets[filePaths.length] = total
  const hashes = new Uint32Array(total)
  let cursor = 0
  for (const slice of slices) {
    hashes.set(slice, cursor)
    cursor += slice.length
  }
  return { filePaths, offsets, hashes }
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'si-delta-'))
}

test('delta: append + read roundtrip keeps order and hashes', async () => {
  const dir = await tempDir()
  try {
    const deltaPath = join(dir, 'symbols.names.delta')
    const first = collectIdentifierHashes('int alpha;')
    const second = collectIdentifierHashes('int beta;')
    const bytes1 = await appendNameIndexDelta(deltaPath, { kind: 'set', path: 'a.c', hashes: first })
    const bytes2 = await appendNameIndexDelta(deltaPath, { kind: 'remove', path: 'b.c', hashes: new Uint32Array(0) })
    assert.ok(bytes1 > 0 && bytes2 > 0, 'both records are appended')
    const entries = await readNameIndexDeltas(deltaPath)
    assert.equal(entries.length, 2)
    assert.equal(entries[0]?.kind, 'set')
    assert.equal(entries[0]?.path, 'a.c')
    assert.deepEqual(Array.from(entries[0]!.hashes), Array.from(first))
    assert.equal(entries[1]?.kind, 'remove')
    assert.equal((await nameIndexDeltaBytes(deltaPath)), bytes1 + bytes2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('delta: apply sets and removes over a base index', async () => {
  const base = dataFrom([
    ['a.c', 'int alpha;'],
    ['b.c', 'int beta;'],
  ])
  const delta = [
    { kind: 'set' as const, path: 'c.c', hashes: collectIdentifierHashes('int gamma;') },
    { kind: 'remove' as const, path: 'a.c', hashes: new Uint32Array(0) },
    { kind: 'set' as const, path: 'b.c', hashes: collectIdentifierHashes('int delta;') },
  ]
  const merged = applyNameIndexDeltas(base, delta)
  assert.ok(merged)
  assert.deepEqual([...merged!.filePaths].sort(), ['b.c', 'c.c'])
  assert.deepEqual(candidatesForName(merged!, 'delta'), [0])
  assert.deepEqual(candidatesForName(merged!, 'gamma'), [1])
  assert.deepEqual(candidatesForName(merged!, 'alpha'), [])
  assert.deepEqual(candidatesForName(merged!, 'beta'), [])
})

test('delta: applying deltas without a base still yields an index', () => {
  const merged = applyNameIndexDeltas(undefined, [
    { kind: 'set', path: 'x.c', hashes: collectIdentifierHashes('int xvar;') },
  ])
  assert.ok(merged)
  assert.deepEqual(merged!.filePaths, ['x.c'])
  assert.deepEqual(candidatesForName(merged!, 'xvar'), [0])
})

test('delta: loadNameIndexWithDelta merges base and delta files', async () => {
  const dir = await tempDir()
  try {
    const basePath = join(dir, 'symbols.names')
    await saveNameIndex(basePath, dataFrom([
      ['a.c', 'int alpha;'],
      ['b.c', 'int beta;'],
    ]))
    const deltaPath = nameIndexDeltaPath(basePath)
    await appendNameIndexDelta(deltaPath, { kind: 'set', path: 'new.c', hashes: collectIdentifierHashes('int fresh;') })
    await appendNameIndexDelta(deltaPath, { kind: 'remove', path: 'a.c', hashes: new Uint32Array(0) })

    const merged = await loadNameIndexWithDelta(basePath)
    assert.ok(merged)
    assert.deepEqual([...merged!.filePaths].sort(), ['b.c', 'new.c'])
    assert.deepEqual(candidatesForName(merged!, 'fresh'), [1])
    assert.deepEqual(candidatesForName(merged!, 'alpha'), [])
    // base 本身未被修改
    const base = await loadNameIndex(basePath)
    assert.deepEqual([...base!.filePaths].sort(), ['a.c', 'b.c'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('delta: truncated tail is tolerated; corrupt header yields no entries', async () => {
  const dir = await tempDir()
  try {
    const deltaPath = join(dir, 'symbols.names.delta')
    await appendNameIndexDelta(deltaPath, { kind: 'set', path: 'a.c', hashes: collectIdentifierHashes('int alpha;') })
    const size = (await stat(deltaPath)).size
    await truncate(deltaPath, size - 3) // 模拟写一半崩溃
    const recovered = await readNameIndexDeltas(deltaPath)
    assert.equal(recovered.length, 0, 'partial trailing record is ignored')

    await writeFile(deltaPath, Buffer.from('XXXX-broken', 'latin1'))
    assert.deepEqual(await readNameIndexDeltas(deltaPath), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('delta: compact writes merged base and truncates the delta', async () => {
  const dir = await tempDir()
  try {
    const basePath = join(dir, 'symbols.names')
    const deltaPath = nameIndexDeltaPath(basePath)
    const original = dataFrom([['a.c', 'int alpha;']])
    await saveNameIndex(basePath, original)
    await appendNameIndexDelta(deltaPath, { kind: 'set', path: 'b.c', hashes: collectIdentifierHashes('int beta;') })
    const merged = await loadNameIndexWithDelta(basePath)
    assert.ok(merged)

    const result = await compactNameIndex(basePath, merged!)
    assert.ok(result.baseBytes > 0)
    assert.equal(result.deltaTruncated, true)
    assert.equal(await nameIndexDeltaBytes(deltaPath), 0, 'delta truncated to empty')

    const reloaded = await loadNameIndexWithDelta(basePath)
    assert.deepEqual([...reloaded!.filePaths].sort(), ['a.c', 'b.c'])
    assert.deepEqual(candidatesForName(reloaded!, 'beta'), [1])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('delta: loading with a missing base still applies sets', async () => {
  const dir = await tempDir()
  try {
    const basePath = join(dir, 'missing.names')
    await appendNameIndexDelta(nameIndexDeltaPath(basePath), {
      kind: 'set',
      path: 'a.c',
      hashes: collectIdentifierHashes('int lonely;'),
    })
    const merged = await loadNameIndexWithDelta(basePath)
    assert.ok(merged)
    assert.deepEqual(candidatesForName(merged!, 'lonely'), [0])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
