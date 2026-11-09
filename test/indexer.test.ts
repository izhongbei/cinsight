import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createSnapshot, buildIndex } from '../src/core/indexer'
import { loadSnapshot, saveSnapshot } from '../src/core/store'
import { DEFAULT_EXCLUDE, SNAPSHOT_VERSION } from '../src/shared/types'
import type {
  BuildOptions,
  FileRecord,
  IndexProgress,
  ReadFileFn,
  SymbolEntry,
} from '../src/shared/types'

const FIXTURES = path.resolve(__dirname, '..', '..', 'test', 'fixtures')
type BuildAllOptions = BuildOptions & { readFile: ReadFileFn }

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, content, 'utf8')
  }
}

/** 两文件小树：sub/a.c 两个定义，sub/b.h 两个声明。 */
function makeTree(): string {
  const dir = tempDir('si-indexer-')
  writeFiles(dir, {
    'sub/a.c': 'int alpha(void) { return 1; }\nstatic int beta(int x) { return x; }\n',
    'sub/b.h': 'extern int alpha(void);\nint gamma(void);\n',
  })
  return dir
}

function makeOptions(dir: string): BuildAllOptions {
  return {
    workspaceRoot: dir,
    roots: ['.'],
    exclude: [...DEFAULT_EXCLUDE],
    maxFileSizeKB: 4096,
    concurrency: 2,
    followSymlinks: false,
    readFile: async (rel: string) => fs.readFileSync(path.join(dir, rel), 'latin1'),
  }
}

function entryKey(e: SymbolEntry): string {
  return `${e.file}|${e.line}|${e.column}|${e.kind}|${e.name}|${e.endLine}`
}

function entryKeys(entries: readonly SymbolEntry[]): string[] {
  return entries.map(entryKey).sort()
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function makeFileRecords(dir: string, n: number): FileRecord[] {
  const records: FileRecord[] = []
  for (let i = 0; i < n; i++) {
    records.push({ path: `dir${i}/file${i}.c`, mtimeMs: 1_700_000_000_000 + i * 1.5, size: 100 + i })
  }
  return records
}

function makeEntries(files: readonly FileRecord[], n: number): SymbolEntry[] {
  const entries: SymbolEntry[] = []
  for (let i = 0; i < n; i++) {
    const file = files[i % files.length]
    entries.push({
      name: `sym_${i}`,
      kind: i % 3 === 0 ? 'declaration' : 'function',
      file: file.path,
      line: i * 2,
      endLine: i % 3 === 0 ? i * 2 : i * 2 + 1,
      column: i,
    })
  }
  return entries
}

// ------------------------------------------------------------------- store

test('indexer/store: binary snapshot roundtrip preserves every field', async () => {
  const dir = tempDir('si-store-')
  try {
    const files = makeFileRecords(dir, 3)
    const entries = makeEntries(files, 5)
    const snapshot = createSnapshot(['rcios/plat', 'rcios/component'], files, entries)
    const file = path.join(dir, 'nested', 'symbols.sidx')
    const bytes = await saveSnapshot(file, snapshot)
    assert.ok(bytes > 20, `expected snapshot bytes, got ${bytes}`)
    assert.equal(fs.statSync(file).size, bytes)
    const loaded = await loadSnapshot(file)
    assert.ok(loaded, 'snapshot should load')
    assert.deepEqual(loaded, snapshot)
    assert.equal(loaded!.version, SNAPSHOT_VERSION)
    assert.deepEqual([...loaded!.roots], ['rcios/plat', 'rcios/component'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('indexer/store: empty snapshot roundtrip', async () => {
  const dir = tempDir('si-store-empty-')
  try {
    const snapshot = createSnapshot([], [], [])
    const file = path.join(dir, 'empty.sidx')
    await saveSnapshot(file, snapshot)
    const loaded = await loadSnapshot(file)
    assert.deepEqual(loaded, snapshot)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('indexer/store: corrupted snapshot returns undefined', async () => {
  const dir = tempDir('si-store-bad-')
  try {
    const file = path.join(dir, 'bad.sidx')
    fs.writeFileSync(file, crypto.randomBytes(100))
    assert.equal(await loadSnapshot(file), undefined)

    const valid = createSnapshot(['r'], makeFileRecords(dir, 2), makeEntries(makeFileRecords(dir, 2), 3))
    const good = path.join(dir, 'good.sidx')
    await saveSnapshot(good, valid)
    const buf = fs.readFileSync(good)
    fs.writeFileSync(path.join(dir, 'truncated.sidx'), buf.subarray(0, 10))
    assert.equal(await loadSnapshot(path.join(dir, 'truncated.sidx')), undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('indexer/store: version mismatch returns undefined', async () => {
  const dir = tempDir('si-store-version-')
  try {
    const file = path.join(dir, 'v999.sidx')
    const buf = Buffer.alloc(100)
    buf.write('SIDX', 0, 'latin1')
    buf.writeUInt32LE(999, 4)
    buf.writeUInt32LE(0, 8)
    buf.writeUInt32LE(0, 12)
    buf.writeUInt32LE(0, 16)
    buf.writeUInt32LE(2, 20)
    buf.write('[]', 24, 'utf8')
    buf.writeUInt32LE(0, 26)
    fs.writeFileSync(file, buf)
    assert.equal(await loadSnapshot(file), undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('indexer/store: missing snapshot returns undefined', async () => {
  const dir = tempDir('si-store-missing-')
  try {
    assert.equal(await loadSnapshot(path.join(dir, 'nope.sidx')), undefined)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('indexer/store: saveSnapshot leaves no temp file behind', async () => {
  const dir = tempDir('si-store-atomic-')
  try {
    const snapshot = createSnapshot(['r'], makeFileRecords(dir, 1), [])
    await saveSnapshot(path.join(dir, 'a.sidx'), snapshot)
    await saveSnapshot(path.join(dir, 'a.sidx'), snapshot)
    assert.deepEqual(fs.readdirSync(dir), ['a.sidx'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ----------------------------------------------------------- createSnapshot

test('indexer: createSnapshot sorts entries by (file, line) and stamps version', () => {
  const files: FileRecord[] = [
    { path: 'c/d.c', mtimeMs: 3, size: 30 },
    { path: 'a/a.c', mtimeMs: 1, size: 10 },
    { path: 'b/b.h', mtimeMs: 2, size: 20 },
  ]
  const entries: SymbolEntry[] = [
    { name: 'z_last', kind: 'function', file: 'c/d.c', line: 5, endLine: 6, column: 0 },
    { name: 'a_second', kind: 'function', file: 'a/a.c', line: 9, endLine: 10, column: 2 },
    { name: 'a_first', kind: 'declaration', file: 'a/a.c', line: 1, endLine: 1, column: 0 },
    { name: 'b_one', kind: 'macro', file: 'b/b.h', line: 2, endLine: 4, column: 8 },
  ]
  const snapshot = createSnapshot(['root'], files, entries)
  assert.equal(snapshot.version, SNAPSHOT_VERSION)
  assert.equal(typeof snapshot.builtAt, 'number')
  assert.deepEqual(snapshot.files.map((f) => f.path), ['a/a.c', 'b/b.h', 'c/d.c'])
  assert.deepEqual(
    snapshot.entries.map((e) => `${e.file}:${e.line}:${e.name}`),
    ['a/a.c:1:a_first', 'a/a.c:9:a_second', 'b/b.h:2:b_one', 'c/d.c:5:z_last'],
  )
})

// --------------------------------------------------------------- buildIndex

test('indexer: first build indexes fixture tree, second reuses unchanged files', async () => {
  const root = path.join(FIXTURES, 'walk')
  const first = await buildIndex(makeOptions(root))
  assert.equal(first.summary.files, 2)
  assert.equal(first.summary.added, 2)
  assert.equal(first.summary.updated, 0)
  assert.equal(first.summary.removed, 0)
  assert.equal(first.summary.unchanged, 0)
  assert.equal(first.summary.skipped, 0)
  assert.equal(first.summary.snapshotBytes, 0)
  assert.deepEqual(first.snapshot.entries.map((e) => e.name).sort(), ['fixture_a', 'fixture_b'])
  assert.deepEqual([...first.snapshot.roots], ['.'])

  // 第二次构建：未变文件不应再被读取
  const second = await buildIndex({
    ...makeOptions(root),
    previous: first.snapshot,
    readFile: async () => {
      throw new Error('unchanged files must not be re-read')
    },
  })
  assert.equal(second.summary.added, 0)
  assert.equal(second.summary.updated, 0)
  assert.equal(second.summary.removed, 0)
  assert.equal(second.summary.unchanged, 2)
  assert.deepEqual(entryKeys(second.snapshot.entries), entryKeys(first.snapshot.entries))
})

test('indexer: buildIndex reports progress phases', async () => {
  const dir = makeTree()
  try {
    const phases: string[] = []
    const events: IndexProgress[] = []
    await buildIndex({
      ...makeOptions(dir),
      onProgress: (p: IndexProgress) => {
        events.push(p)
        phases.push(p.phase)
      },
    })
    assert.ok(phases.includes('walk'), `phases=${phases.join(',')}`)
    assert.ok(phases.includes('parse'), `phases=${phases.join(',')}`)
    assert.ok(phases.includes('save'), `phases=${phases.join(',')}`)
    const parseEvents = events.filter((e) => e.phase === 'parse')
    assert.ok(parseEvents.length >= 2, 'one parse progress event per file expected')
    assert.equal(parseEvents[parseEvents.length - 1].done, 2)
    assert.equal(parseEvents[parseEvents.length - 1].total, 2)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('indexer: modified file is re-parsed as updated', async () => {
  const dir = makeTree()
  try {
    const first = await buildIndex(makeOptions(dir))
    assert.equal(first.snapshot.entries.length, 4)
    const target = path.join(dir, 'sub/a.c')
    fs.writeFileSync(target, 'int delta(void) { return 2; }\n', 'utf8')
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(target, future, future)
    const second = await buildIndex({ ...makeOptions(dir), previous: first.snapshot })
    assert.equal(second.summary.updated, 1)
    assert.equal(second.summary.unchanged, 1)
    assert.equal(second.summary.added, 0)
    assert.equal(second.summary.removed, 0)
    const names = second.snapshot.entries.map((e) => e.name).sort()
    assert.deepEqual(names, ['alpha', 'delta', 'gamma'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('indexer: deleted file is removed from the snapshot', async () => {
  const dir = makeTree()
  try {
    const first = await buildIndex(makeOptions(dir))
    fs.unlinkSync(path.join(dir, 'sub/b.h'))
    const second = await buildIndex({ ...makeOptions(dir), previous: first.snapshot })
    assert.equal(second.summary.removed, 1)
    assert.equal(second.summary.files, 1)
    assert.deepEqual(second.snapshot.files.map((f) => f.path), ['sub/a.c'])
    assert.deepEqual(second.snapshot.entries.map((e) => e.name).sort(), ['alpha', 'beta'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('indexer: concurrency 1 and concurrency 4 produce identical results', async () => {
  const dir = makeTree()
  try {
    const serial = await buildIndex({ ...makeOptions(dir), concurrency: 1 })
    const parallel = await buildIndex({ ...makeOptions(dir), concurrency: 4 })
    assert.deepEqual(entryKeys(parallel.snapshot.entries), entryKeys(serial.snapshot.entries))
    assert.deepEqual(
      parallel.snapshot.files.map((f) => f.path),
      serial.snapshot.files.map((f) => f.path),
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('indexer: unreadable file is skipped and build still succeeds', async () => {
  const dir = makeTree()
  try {
    const result = await buildIndex({
      ...makeOptions(dir),
      readFile: async (rel: string) => {
        if (rel.includes('b.h')) throw new Error('boom')
        return fs.readFileSync(path.join(dir, rel), 'latin1')
      },
    })
    assert.equal(result.summary.skipped, 1)
    assert.equal(result.summary.files, 1)
    assert.deepEqual(result.snapshot.files.map((f) => f.path), ['sub/a.c'])
    assert.deepEqual(result.snapshot.entries.map((e) => e.name).sort(), ['alpha', 'beta'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('indexer: empty roots produce an empty snapshot', async () => {
  const dir = tempDir('si-indexer-empty-')
  try {
    const result = await buildIndex({ ...makeOptions(dir), roots: [] })
    assert.equal(result.summary.files, 0)
    assert.equal(result.summary.entries, 0)
    assert.deepEqual(result.snapshot.files, [])
    assert.deepEqual(result.snapshot.entries, [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('indexer: snapshotPath writes snapshot and fills snapshotBytes', async () => {
  const dir = makeTree()
  try {
    const snapshotPath = path.join(dir, 'storage', 'symbols.sidx')
    const result = await buildIndex({ ...makeOptions(dir), snapshotPath })
    assert.ok(result.summary.snapshotBytes > 0)
    assert.equal(fs.statSync(snapshotPath).size, result.summary.snapshotBytes)
    const loaded = await loadSnapshot(snapshotPath)
    assert.deepEqual(loaded, result.snapshot)
    assert.deepEqual(fs.readdirSync(path.dirname(snapshotPath)), ['symbols.sidx'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('indexer: pre-aborted signal rejects with AbortError', async () => {
  const dir = makeTree()
  try {
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(buildIndex({ ...makeOptions(dir), signal: controller.signal }), isAbortError)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('indexer: abort during parse rejects with AbortError', async () => {
  const dir = makeTree()
  try {
    const controller = new AbortController()
    await assert.rejects(
      buildIndex({
        ...makeOptions(dir),
        signal: controller.signal,
        onProgress: (p: IndexProgress) => {
          if (p.phase === 'parse' && p.done >= 1) controller.abort()
        },
      }),
      isAbortError,
    )
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
