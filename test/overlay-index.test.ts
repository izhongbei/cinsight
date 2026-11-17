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
    const expectedFiles = new Map(files.map((file) => [file.path, file]))
    const dropFile = (file: string): void => {
      expectedFiles.delete(file)
      for (const key of [...expectedEntries.keys()]) {
        if (key.startsWith(file + ':')) expectedEntries.delete(key)
      }
    }
    for (let step = 0; step < 5; step++) {
      // 0..6：目标可以是不在 base 里的 f6.c（新文件），也覆盖删除后再新建。
      const target = `f${Math.floor(random() * 7)}.c`
      if (random() < 0.3) {
        index.removeFile(target)
        dropFile(target)
      } else {
        const count = 1 + Math.floor(random() * 2)
        const next: SymbolEntry[] = []
        for (let index = 0; index < count; index++) {
          next.push(entry(names[Math.floor(random() * names.length)]!, target, index))
        }
        index.applyFile({ path: target, mtimeMs: step, size: step }, next)
        dropFile(target)
        expectedFiles.set(target, { path: target, mtimeMs: step, size: step })
        for (const e of next) expectedEntries.set(`${e.file}:${e.name}:${e.line}`, e)
      }
    }
    const flat = index.flatten()
    const expected = createSymbolTable(
      ['root'],
      [...expectedFiles.values()],
      [...expectedEntries.values()],
      flat.builtAt,
      flat.version,
    )
    // 逐条比较内容（不只是计数）：flatten 必须与全量重建完全一致。
    assert.equal(flat.entryCount, expectedEntries.size, `round ${round}`)
    assert.deepEqual(flat.files, expected.files, `round ${round} file records`)
    assert.deepEqual(
      flat.toArray().sort(compareSymbolEntries),
      expected.toArray().sort(compareSymbolEntries),
      `round ${round} entries`,
    )
    for (const name of new Set(expected.toArray().map((e) => e.name))) {
      assert.deepEqual(
        flat.findByName(name).sort(compareSymbolEntries),
        expected.findByName(name).sort(compareSymbolEntries),
        `round ${round} name ${name}`,
      )
    }
    for (const file of new Set([...expectedFiles.keys(), ...flat.files.map((f) => f.path)])) {
      assert.deepEqual(
        flat.entriesInFile(file),
        expected.entriesInFile(file),
        `round ${round} entriesInFile(${file})`,
      )
    }
  }
})

test('overlay: entriesInFile orders overlay slots by line, column, then name', () => {
  const { base } = makeBase()
  const index = createMutableIndex(base)
  // 故意乱序：line 10 在最前、line 2 在后；同一行内含列 / 名字并列。
  const withColumn = (name: string, file: string, line: number, column: number): SymbolEntry => ({
    name,
    kind: 'function',
    file,
    line,
    endLine: line + 1,
    column,
  })
  const overlayEntries = [
    withColumn('alpha', 'x.c', 10, 2),
    withColumn('zeta', 'x.c', 2, 5),
    withColumn('mid', 'x.c', 5, 7),
    withColumn('omega', 'x.c', 5, 3),
    withColumn('beta', 'x.c', 5, 3),
  ]
  index.applyFile({ path: 'x.c', mtimeMs: 1, size: 1 }, overlayEntries)

  const expected = ['zeta', 'beta', 'omega', 'mid', 'alpha']
  assert.deepEqual(index.entriesInFile('x.c').map((e) => e.name), expected)
  // 与 flatten / 全量重建产出的顺序一致（同一个 SymbolTable 契约）。
  const flat = index.flatten()
  assert.deepEqual(index.entriesInFile('x.c'), flat.entriesInFile('x.c'))
  const rebuilt = createSymbolTable(flat.roots, flat.files, flat.toArray(), flat.builtAt, flat.version)
  assert.deepEqual(index.entriesInFile('x.c'), rebuilt.entriesInFile('x.c'))
})

test('overlay: applyFile snapshots the caller entries array', () => {
  const { base } = makeBase()
  const index = createMutableIndex(base)
  const overlayEntries = [entry('omega', 'a.c', 4)]
  index.applyFile({ path: 'a.c', mtimeMs: 9, size: 99 }, overlayEntries)
  overlayEntries.push(entry('alpha', 'a.c', 1))

  assert.equal(index.entryCount, 4) // 仍按 apply 时的 1 条条目计数
  assert.deepEqual(index.entriesInFile('a.c').map((e) => e.name), ['omega'])
  assert.deepEqual(index.flatten().entriesInFile('a.c').map((e) => e.name), ['omega'])
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
