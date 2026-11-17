import test from 'node:test'
import assert from 'node:assert/strict'

import { createMutableIndex } from '../src/core/overlay-index'
import { createSymbolTable } from '../src/core/symbol-table'
import type { FileRecord, SymbolEntry } from '../src/shared/types'
import { SNAPSHOT_VERSION } from '../src/shared/types'

function entry(name: string, file: string, line: number): SymbolEntry {
  return { name, kind: 'function', file, line, endLine: line + 1, column: 2 }
}

function makeBase(): ReturnType<typeof createSymbolTable> {
  const files: FileRecord[] = [
    { path: 'a.c', mtimeMs: 1, size: 10, contentHashLo: 1, contentHashHi: 2 },
    { path: 'b.c', mtimeMs: 2, size: 20, contentHashLo: 3, contentHashHi: 4 },
    { path: 'inc/x.h', mtimeMs: 3, size: 30, contentHashLo: 5, contentHashHi: 6 },
    { path: 'inc/y.h', mtimeMs: 4, size: 40, contentHashLo: 7, contentHashHi: 8 },
  ]
  const entries: SymbolEntry[] = [
    entry('alpha', 'a.c', 1),
    entry('beta', 'b.c', 2),
    entry('x', 'inc/x.h', 3),
    entry('y', 'inc/y.h', 4),
  ]
  const includes = new Map<string, readonly string[]>([
    ['a.c', ['inc/x.h']],
    ['b.c', ['inc/y.h']],
    ['inc/x.h', ['inc/y.h']],
    ['inc/y.h', []],
  ])
  return createSymbolTable(['.'], files, entries, 111, SNAPSHOT_VERSION, { includes })
}

test('overlay: applyIncludes overrides base edges and merges with unchanged base files', () => {
  const index = createMutableIndex(makeBase())
  // 未改动：走 base 边
  assert.deepEqual(index.includedFiles('a.c'), ['inc/x.h'])
  assert.deepEqual(index.includedFiles('b.c'), ['inc/y.h'])
  assert.equal(index.isReachable('a.c', 'inc/y.h'), true) // a.c -> inc/x.h -> inc/y.h

  index.applyIncludes('a.c', ['inc/y.h'])
  assert.deepEqual(index.includedFiles('a.c'), ['inc/y.h'])
  assert.deepEqual(index.includedFiles('b.c'), ['inc/y.h'], '未 applyIncludes 的文件仍走 base')
  assert.equal(index.isReachable('a.c', 'inc/y.h'), true)
  assert.equal(index.isReachable('a.c', 'inc/x.h'), false, 'overlay 边替换 base 边，而不是叠加')

  // 新文件的 overlay 边与 base 边一起参与 BFS
  index.applyFile({ path: 'new.c', mtimeMs: 9, size: 90, contentHashLo: 9, contentHashHi: 10 }, [entry('n', 'new.c', 1)])
  index.applyIncludes('new.c', ['a.c'])
  assert.equal(index.isReachable('new.c', 'inc/y.h'), true)
  assert.deepEqual(index.includedFiles('new.c'), ['a.c'])

  // 删除文件后不再可达，include 查询退化为空
  index.removeFile('a.c')
  assert.deepEqual(index.includedFiles('a.c'), [])
  assert.equal(index.isReachable('new.c', 'inc/y.h'), false)
  assert.equal(index.isReachable('b.c', 'inc/y.h'), true)
})

test('overlay: flatten preserves include edges and hashes equivalently', () => {
  const base = makeBase()
  const index = createMutableIndex(base)
  index.applyIncludes('a.c', ['inc/y.h'])
  index.applyFile(
    { path: 'a.c', mtimeMs: 9, size: 90, contentHashLo: 42, contentHashHi: 43 },
    [entry('alpha', 'a.c', 1), entry('omega', 'a.c', 4)],
  )
  index.applyIncludes('b.c', [])
  index.applyFile({ path: 'new.c', mtimeMs: 5, size: 50, contentHashLo: 52, contentHashHi: 53 }, [entry('n', 'new.c', 2)])
  index.applyIncludes('new.c', ['a.c'])
  index.removeFile('inc/x.h')

  // contentHashOf：overlay 记录优先，未改文件走 base，删除 / 无 hash 返回 undefined
  assert.deepEqual(index.contentHashOf('a.c'), { lo: 42, hi: 43 })
  assert.deepEqual(index.contentHashOf('b.c'), { lo: 3, hi: 4 })
  assert.equal(index.contentHashOf('inc/x.h'), undefined)
  assert.equal(index.contentHashOf('missing.c'), undefined)

  const flat = index.flatten()
  assert.equal(flat.version, index.version)
  assert.deepEqual(flat.files, index.files)
  assert.deepEqual(flat.includedFiles('a.c'), ['inc/y.h'])
  assert.deepEqual(flat.includedFiles('b.c'), [])
  assert.deepEqual(flat.includedFiles('new.c'), ['a.c'])
  assert.deepEqual(flat.includedFiles('inc/x.h'), [])
  assert.deepEqual(flat.contentHashOf('a.c'), { lo: 42, hi: 43 })
  assert.deepEqual(flat.contentHashOf('new.c'), { lo: 52, hi: 53 })
  assert.equal(flat.contentHashOf('inc/x.h'), undefined)
  assert.equal(flat.isReachable('new.c', 'inc/y.h'), true) // new.c -> a.c -> inc/y.h
  assert.equal(flat.isReachable('b.c', 'inc/y.h'), false)
  assert.deepEqual(flat.findByName('omega').map((e) => e.file), ['a.c'])

  // flatten 与「把合并后的 files/entries/includes 再建一次表」完全等价
  const rebuilt = createSymbolTable(
    flat.roots,
    flat.files,
    flat.toArray(),
    flat.builtAt,
    flat.version,
    {
      includes: new Map(
        flat.files
          .map((file) => [file.path, flat.includedFiles(file.path)] as const)
          .filter(([, targets]) => targets.length > 0),
      ),
    },
  )
  assert.deepEqual(rebuilt.toArray().sort((a, b) => a.name.localeCompare(b.name)), flat.toArray().sort((a, b) => a.name.localeCompare(b.name)))
  for (const file of flat.files) assert.deepEqual(rebuilt.includedFiles(file.path), flat.includedFiles(file.path))
})
