import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMutableIndex, createMutableIndexFromDeltas } from '../src/core/overlay-index'
import { createSymbolTable } from '../src/core/symbol-table'
import { compareSymbolEntries } from '../src/core/symbol-order'
import type { FileRecord, SymbolEntry } from '../src/shared/types'
import { SNAPSHOT_VERSION } from '../src/shared/types'

function entry(name: string, file: string, line: number): SymbolEntry {
  return { name, kind: 'function', file, line, endLine: line + 1, column: 2 }
}

function makeBase(): { base: ReturnType<typeof createSymbolTable>; files: FileRecord[] } {
  const files: FileRecord[] = [
    { path: 'a.c', mtimeMs: 1, size: 10 },
    { path: 'b.c', mtimeMs: 2, size: 20 },
    { path: 'c.h', mtimeMs: 3, size: 30 },
  ]
  const entries: SymbolEntry[] = [
    entry('alpha', 'a.c', 1),
    entry('beta', 'a.c', 5),
    entry('beta', 'b.c', 7),
    entry('gamma', 'b.c', 9),
    entry('delta', 'c.h', 2),
  ]
  return { base: createSymbolTable(['root'], files, entries, 111, SNAPSHOT_VERSION), files }
}

test('overlay: applyFile replaces a file and keeps counts/queries consistent', () => {
  const { base } = makeBase()
  const index = createMutableIndex(base)
  assert.equal(index.entryCount, 5)
  assert.equal(index.pendingChanges, 0)

  index.applyFile({ path: 'a.c', mtimeMs: 9, size: 99 }, [entry('alpha', 'a.c', 1), entry('omega', 'a.c', 4)])
  assert.equal(index.pendingChanges, 1)
  assert.equal(index.entryCount, 5) // a.c 原来 2 条 -> 新 2 条
  assert.deepEqual(index.findByName('beta').map((e) => e.file), ['b.c'])
  assert.deepEqual(index.findByName('omega').map((e) => e.file), ['a.c'])
  assert.deepEqual(index.entriesInFile('a.c').map((e) => e.name), ['alpha', 'omega'])
  assert.deepEqual(index.files.map((f) => f.path), ['a.c', 'b.c', 'c.h'])
  assert.equal(index.files[0]?.mtimeMs, 9)
})

test('overlay: removeFile hides base entries and files', () => {
  const { base } = makeBase()
  const index = createMutableIndex(base)
  assert.equal(index.removeFile('b.c'), true)
  assert.equal(index.removeFile('b.c'), false)
  assert.equal(index.entryCount, 3)
  assert.deepEqual(index.findByName('beta').map((e) => e.file), ['a.c'])
  assert.deepEqual(index.entriesInFile('b.c'), [])
  assert.deepEqual(index.files.map((f) => f.path), ['a.c', 'c.h'])
})

test('overlay: forEachEntry and forEachName include changes without removed files', () => {
  const { base } = makeBase()
  const index = createMutableIndex(base)
  index.removeFile('b.c')
  index.applyFile({ path: 'd.c', mtimeMs: 4, size: 4 }, [entry('epsilon', 'd.c', 1)])

  const names: string[] = []
  index.forEachName((name) => names.push(name))
  assert.deepEqual(names, ['alpha', 'beta', 'delta', 'epsilon'])

  const seen: string[] = []
  index.forEachEntry((e) => seen.push(`${e.file}:${e.name}`))
  assert.deepEqual(seen.sort(), ['a.c:alpha', 'a.c:beta', 'c.h:delta', 'd.c:epsilon'].sort())
})

test('overlay: flatten is equivalent to a full rebuild', () => {
  const { base, files } = makeBase()
  const index = createMutableIndex(base)
  index.applyFile({ path: 'a.c', mtimeMs: 9, size: 99 }, [entry('alpha', 'a.c', 1), entry('omega', 'a.c', 4)])
  index.removeFile('b.c')
  index.applyFile({ path: 'd.c', mtimeMs: 4, size: 4 }, [entry('epsilon', 'd.c', 1)])

  const flat = index.flatten()
  const expected = createSymbolTable(
    flat.roots,
    files.filter((f) => f.path !== 'b.c').concat([{ path: 'd.c', mtimeMs: 4, size: 4 }]).map((f) => f.path === 'a.c' ? { path: 'a.c', mtimeMs: 9, size: 99 } : f),
    [entry('alpha', 'a.c', 1), entry('omega', 'a.c', 4), entry('gamma', 'b.c', 9), entry('delta', 'c.h', 2), entry('epsilon', 'd.c', 1)].filter((e) => e.file !== 'b.c'),
    flat.builtAt,
    flat.version,
  )
  assert.deepEqual(flat.toArray().sort(compareSymbolEntries), expected.toArray().sort(compareSymbolEntries))
  for (const name of ['alpha', 'omega', 'beta', 'gamma', 'delta', 'epsilon']) {
    assert.deepEqual(flat.findByName(name), expected.findByName(name))
  }
  assert.deepEqual(flat.entriesInFile('a.c'), expected.entriesInFile('a.c'))
})

test('overlay: property-ish randomized updates always match a full rebuild', () => {
  let seed = 42
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  for (let round = 0; round < 20; round++) {
    const files: FileRecord[] = []
    const entries: SymbolEntry[] = []
    const names = ['n0', 'n1', 'n2', 'n3']
    for (let i = 0; i < 6; i++) {
      const file = `f${i}.c`
      files.push({ path: file, mtimeMs: i, size: i })
      const count = 1 + Math.floor(random() * 3)
      for (let j = 0; j < count; j++) entries.push(entry(names[(i + j) % names.length]!, file, j))
    }
    const base = createSymbolTable(['root'], files, entries, 1, SNAPSHOT_VERSION)
    const index = createMutableIndex(base)
    const expectedEntries = new Map(entries.map((e) => [`${e.file}:${e.name}:${e.line}`, e]))
    for (let step = 0; step < 5; step++) {
      const target = `f${Math.floor(random() * 6)}.c`
      if (random() < 0.3) {
        index.removeFile(target)
        for (const key of [...expectedEntries.keys()]) if (key.startsWith(target + ':')) expectedEntries.delete(key)
      } else {
        const next = [entry(names[Math.floor(random() * names.length)]!, target, Math.floor(random() * 5))]
        index.applyFile({ path: target, mtimeMs: step, size: step }, next)
        for (const key of [...expectedEntries.keys()]) if (key.startsWith(target + ':')) expectedEntries.delete(key)
        for (const e of next) expectedEntries.set(`${e.file}:${e.name}:${e.line}`, e)
      }
    }
    const flat = index.flatten()
    assert.equal(flat.entryCount, expectedEntries.size, `round ${round}`)
    assert.deepEqual(flat.files.map((f) => f.path), [...new Set([...expectedEntries.values()].map((e) => e.file))].sort())
  }
})

test('overlay: createMutableIndexFromDeltas replays records', () => {
  const { base } = makeBase()
  const index = createMutableIndexFromDeltas(base, [
    { kind: 'set', path: 'a.c', mtimeMs: 9, size: 9, entries: [entry('omega', 'a.c', 1)] },
    { kind: 'remove', path: 'c.h' },
  ])
  assert.deepEqual(index.findByName('alpha'), [])
  assert.deepEqual(index.findByName('omega').map((e) => e.file), ['a.c'])
  assert.deepEqual(index.findByName('delta'), [])
  assert.equal(index.entryCount, 3)
})
