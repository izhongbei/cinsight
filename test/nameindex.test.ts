import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildNameIndex,
  candidatesForName,
  collectIdentifierHashes,
  decodeNameIndex,
  encodeNameIndex,
  hashIdentifier,
  loadNameIndex,
  removeFileIndex,
  saveNameIndex,
  upsertFileIndex,
} from '../src/core/nameindex'
import type { FileRecord, NameIndexData } from '../src/shared/types'

function fileRecord(path: string, index: number): FileRecord {
  return { path, mtimeMs: 1000 + index, size: 100 + index }
}

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

function sliceOf(data: NameIndexData, path: string): number[] {
  const index = data.filePaths.indexOf(path)
  assert.ok(index >= 0, `missing file ${path}`)
  return Array.from(data.hashes.subarray(data.offsets[index]!, data.offsets[index + 1]!))
}

test('nameindex: hashIdentifier is deterministic and case sensitive', () => {
  assert.equal(hashIdentifier('foo'), hashIdentifier('foo'))
  assert.notEqual(hashIdentifier('foo'), hashIdentifier('Foo'))
  assert.notEqual(hashIdentifier('foo'), hashIdentifier('bar'))
  const value = hashIdentifier('main')
  assert.ok(value >= 0 && value <= 0xffffffff, 'hash is a uint32')
})

test('nameindex: collectIdentifierHashes strips comments and strings, dedupes and sorts', () => {
  const text = [
    '/* fake_func(1) */',
    '// another_func(2)',
    'int real_func(void) {',
    '  char *s = "string_token";',
    '  return real_func();',
    '}',
  ].join('\n')
  const hashes = Array.from(collectIdentifierHashes(text))
  const expected = new Set([
    hashIdentifier('int'),
    hashIdentifier('real_func'),
    hashIdentifier('void'),
    hashIdentifier('char'),
    hashIdentifier('s'),
    hashIdentifier('return'),
  ])
  // 去重后数量一致
  assert.equal(new Set(hashes).size, hashes.length)
  // 升序
  assert.deepEqual([...hashes].sort((a, b) => a - b), hashes)
  for (const name of ['fake_func', 'another_func', 'string_token']) {
    assert.ok(!hashes.includes(hashIdentifier(name)), `${name} must be stripped`)
  }
  for (const hash of expected) assert.ok(hashes.includes(hash), 'expected identifier present')
})

test('nameindex: encode/decode roundtrip preserves files, offsets and hashes', () => {
  const data = dataFrom([
    ['a.c', 'int alpha(void) { return beta(); }'],
    ['b.h', 'int beta(void);'],
    ['c.c', 'void gamma(void) { beta(); alpha(); }'],
  ])
  const decoded = decodeNameIndex(encodeNameIndex(data))
  assert.ok(decoded)
  assert.deepEqual([...decoded.filePaths], [...data.filePaths])
  assert.deepEqual(Array.from(decoded.offsets), Array.from(data.offsets))
  assert.deepEqual(Array.from(decoded.hashes), Array.from(data.hashes))
})

test('nameindex: decode rejects corrupt input and wrong version', () => {
  assert.equal(decodeNameIndex(Buffer.alloc(4)), undefined)
  assert.equal(decodeNameIndex(Buffer.from('NOTHING-AT-ALL-1234', 'latin1')), undefined)

  const good = encodeNameIndex(dataFrom([['a.c', 'int a;']]))
  const wrongVersion = Buffer.from(good)
  wrongVersion.writeUInt32LE(999, 4)
  assert.equal(decodeNameIndex(wrongVersion), undefined)

  const truncated = good.subarray(0, good.length - 4)
  assert.equal(decodeNameIndex(truncated), undefined)
})

test('nameindex: candidatesForName returns only files containing the identifier', () => {
  const data = dataFrom([
    ['a.c', 'int alpha(void) { return beta(); }'],
    ['b.c', 'int beta(void) { return 0; }'],
    ['c.c', 'void gamma(void) { }'],
  ])
  assert.deepEqual(candidatesForName(data, 'beta'), [0, 1])
  assert.deepEqual(candidatesForName(data, 'alpha'), [0])
  assert.deepEqual(candidatesForName(data, 'gamma'), [2])
  assert.deepEqual(candidatesForName(data, 'missing_symbol'), [])
  // 注释里的名字不产生候选
  const commented = dataFrom([['d.c', '/* only_in_comment */\nint x;']])
  assert.deepEqual(candidatesForName(commented, 'only_in_comment'), [])
})

test('nameindex: upsert and remove keep other files intact', () => {
  const data = dataFrom([
    ['a.c', 'int alpha;'],
    ['b.c', 'int beta;'],
    ['c.c', 'int gamma;'],
  ])
  const replaced = upsertFileIndex(data, 'b.c', collectIdentifierHashes('int delta;'))
  assert.deepEqual(candidatesForName(replaced, 'delta'), [1])
  assert.deepEqual(candidatesForName(replaced, 'beta'), [])
  assert.deepEqual(candidatesForName(replaced, 'alpha'), [0])
  assert.deepEqual(candidatesForName(replaced, 'gamma'), [2])

  const appended = upsertFileIndex(replaced, 'd.c', collectIdentifierHashes('int epsilon;'))
  assert.deepEqual(appended.filePaths, ['a.c', 'b.c', 'c.c', 'd.c'])
  assert.deepEqual(candidatesForName(appended, 'epsilon'), [3])

  const removed = removeFileIndex(appended, 'b.c')
  assert.deepEqual(removed.filePaths, ['a.c', 'c.c', 'd.c'])
  assert.deepEqual(candidatesForName(removed, 'alpha'), [0])
  assert.deepEqual(candidatesForName(removed, 'gamma'), [1])
  assert.deepEqual(candidatesForName(removed, 'delta'), [])
})

test('nameindex: buildNameIndex reuses unchanged files and re-reads changed ones', async () => {
  const texts = new Map([
    ['a.c', 'int alpha(void) { return 0; }'],
    ['b.c', 'int beta(void) { return alpha(); }'],
  ])
  const files = [fileRecord('a.c', 0), fileRecord('b.c', 1)]
  let reads: string[] = []
  const readFile = async (path: string): Promise<string> => {
    reads.push(path)
    const text = texts.get(path)
    if (text === undefined) throw new Error('missing ' + path)
    return text
  }

  const first = await buildNameIndex({ files, changedPaths: new Set(['a.c', 'b.c']), readFile })
  assert.deepEqual(reads, ['a.c', 'b.c'])
  assert.deepEqual(candidatesForName(first, 'alpha'), [0, 1])

  reads = []
  const second = await buildNameIndex({
    files,
    previous: first,
    changedPaths: new Set(['b.c']),
    readFile,
  })
  assert.deepEqual(reads, ['b.c'], 'only the changed file is read again')
  assert.deepEqual(candidatesForName(second, 'alpha'), [0, 1])

  // 变更文件不再包含 alpha 后，候选随之更新
  texts.set('b.c', 'int beta(void) { return 1; }')
  reads = []
  const third = await buildNameIndex({
    files,
    previous: second,
    changedPaths: new Set(['b.c']),
    readFile,
  })
  assert.deepEqual(reads, ['b.c'])
  assert.deepEqual(candidatesForName(third, 'alpha'), [0])
  assert.deepEqual(candidatesForName(third, 'beta'), [1])
})

test('nameindex: buildNameIndex tolerates unreadable files and aborts on signal', async () => {
  const files = [fileRecord('ok.c', 0), fileRecord('missing.c', 1)]
  const readFile = async (path: string): Promise<string> => {
    if (path === 'missing.c') throw new Error('nope')
    return 'int fine;'
  }
  const data = await buildNameIndex({
    files,
    changedPaths: new Set(['ok.c', 'missing.c']),
    readFile,
  })
  assert.deepEqual(candidatesForName(data, 'fine'), [0])
  assert.equal(sliceOf(data, 'missing.c').length, 0)

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    buildNameIndex({ files, previous: data, changedPaths: new Set(), readFile, signal: controller.signal }),
    (error: unknown) => (error as Error).name === 'AbortError',
  )
})

test('nameindex: save/load roundtrip on disk and corrupt file handling', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'si-nameindex-'))
  try {
    const data = dataFrom([
      ['x.c', 'int one;'],
      ['y.c', 'int two;'],
    ])
    const path = join(dir, 'symbols.names')
    const bytes = await saveNameIndex(path, data)
    assert.ok(bytes > 0)
    const loaded = await loadNameIndex(path)
    assert.ok(loaded)
    assert.deepEqual([...loaded.filePaths], ['x.c', 'y.c'])
    assert.deepEqual(candidatesForName(loaded, 'two'), [1])

    await writeFile(path, Buffer.from('garbage'), 'latin1')
    assert.equal(await loadNameIndex(path), undefined)
    assert.equal(await loadNameIndex(join(dir, 'does-not-exist.names')), undefined)
    void readFile
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
