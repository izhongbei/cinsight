import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { hashContent64 } from '../src/core/hash'
import { buildIndex } from '../src/core/indexer'
import { loadSnapshot } from '../src/core/store'
import { createSymbolTable } from '../src/core/symbol-table'
import { DEFAULT_EXCLUDE, SNAPSHOT_VERSION } from '../src/shared/types'
import type { BuildOptions, FileRecord, ReadFileFn, SymbolEntry, SymbolTable } from '../src/shared/types'

/**
 * indexer 集成：真实小树 → buildIndex 写 v4 快照 → 重新 loadSnapshot，
 * 验证 include 边（直接/传递）、内容哈希、`#ifdef` 条件都落到磁盘并能读回。
 */

const A_C = [
  '#include "inc/x.h"',
  'int alpha(void) { return 0; }',
  '#ifdef RTK_MODULE',
  'int guarded(void) { return 1; }',
  '#endif',
  '',
].join('\n')

const X_H = [
  '#ifndef X_H',
  '#define X_H',
  '#include "y.h"',
  '#ifdef RTK_MODULE',
  'struct conditional_t { int enabled; };',
  '#endif',
  '#endif',
  '',
].join('\n')

const Y_H = ['#ifndef Y_H', '#define Y_H', 'struct sk_buff { int len; };', '#endif', ''].join('\n')

const OTHER_C = 'int unrelated(void) { return 0; }\n'

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

function makeOptions(dir: string): BuildOptions & { readFile: ReadFileFn } {
  return {
    workspaceRoot: dir,
    roots: ['.'],
    exclude: [...DEFAULT_EXCLUDE],
    maxFileSizeKB: 4096,
    concurrency: 1,
    followSymlinks: false,
    readFile: async (rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8'),
  }
}

/** src/a.c -> inc/x.h -> inc/y.h，外加一个无关的 other.c。 */
function makeIncludeTree(): string {
  const dir = tempDir('si-indexer-includes-')
  writeFiles(dir, {
    'src/a.c': A_C,
    'inc/x.h': X_H,
    'inc/y.h': Y_H,
    'other.c': OTHER_C,
  })
  return dir
}

test('indexer includes: v4 snapshot keeps include edges, content hash and conditions', async () => {
  const dir = makeIncludeTree()
  try {
    const snapshotPath = path.join(dir, 'storage', 'symbols.sidx')
    const result = await buildIndex({ ...makeOptions(dir), snapshotPath })
    assert.equal(result.summary.files, 4)

    // 内存表与磁盘表都必须有 include 边（save/load 不得丢 v4 元数据）
    const loaded = await loadSnapshot(snapshotPath)
    assert.ok(loaded, 'v4 snapshot must reload')
    assert.equal(loaded!.version, SNAPSHOT_VERSION)
    for (const table of [result.snapshot, loaded!]) {
      assert.deepEqual(table.includedFiles('src/a.c'), ['inc/x.h'])
      assert.deepEqual(table.includedFiles('inc/x.h'), ['inc/y.h'])
      assert.deepEqual(table.includedFiles('inc/y.h'), [])
      assert.equal(table.isReachable('src/a.c', 'inc/x.h'), true)
      assert.equal(table.isReachable('src/a.c', 'inc/y.h'), true, 'transitive include edge')
      assert.equal(table.isReachable('src/a.c', 'other.c'), false)
      assert.equal(table.isReachable('other.c', 'inc/x.h'), false)
      // 相对目录候选：inc/x.h 里的 "y.h" → inc/y.h
      assert.deepEqual(table.contentHashOf('src/a.c'), hashContent64(A_C))
      assert.deepEqual(table.contentHashOf('other.c'), hashContent64(OTHER_C))
    }

    // 条件随条目写入 v4：无条件条目仍保持旧形状（不 materialize condition）
    const guarded = loaded!.findByName('guarded')
    assert.equal(guarded.length, 1)
    assert.equal(guarded[0]!.condition, '#ifdef RTK_MODULE')
    const conditional = loaded!.findByName('conditional_t')
    assert.equal(conditional.length, 1)
    // 头文件 include guard + 内层 #ifdef：条件栈按最内层 3 层以 " && " 连接
    assert.equal(conditional[0]!.condition, '#ifndef X_H && #ifdef RTK_MODULE')
    assert.equal(Object.hasOwn(loaded!.findByName('alpha')[0]!, 'condition'), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('indexer includes: unchanged rebuild reuses hash/include/condition without reading sources', async () => {
  const dir = makeIncludeTree()
  try {
    const first = await buildIndex(makeOptions(dir))
    const second = await buildIndex({
      ...makeOptions(dir),
      previous: first.snapshot,
      readFile: async () => {
        throw new Error('unchanged files must not be re-read')
      },
    })
    assert.equal(second.summary.unchanged, 4)
    assert.equal(second.summary.updated, 0)
    assert.deepEqual(second.snapshot.includedFiles('src/a.c'), ['inc/x.h'])
    assert.deepEqual(second.snapshot.includedFiles('inc/x.h'), ['inc/y.h'])
    assert.equal(second.snapshot.isReachable('src/a.c', 'inc/y.h'), true)
    assert.deepEqual(second.snapshot.contentHashOf('src/a.c'), hashContent64(A_C))
    assert.equal(second.snapshot.findByName('guarded')[0]!.condition, '#ifdef RTK_MODULE')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('indexer includes: changed file re-resolves edges and recomputes its hash', async () => {
  const dir = makeIncludeTree()
  try {
    const first = await buildIndex(makeOptions(dir))
    const target = path.join(dir, 'src', 'a.c')
    const nextText = ['#include "inc/y.h"', 'int alpha(void) { return 5; }', ''].join('\n')
    fs.writeFileSync(target, nextText, 'utf8')
    const future = new Date(Date.now() + 5000)
    fs.utimesSync(target, future, future)

    const second = await buildIndex({ ...makeOptions(dir), previous: first.snapshot })
    assert.equal(second.summary.updated, 1)
    assert.equal(second.summary.unchanged, 3)
    assert.deepEqual(second.snapshot.includedFiles('src/a.c'), ['inc/y.h'], 'stale edge replaced')
    assert.equal(second.snapshot.isReachable('src/a.c', 'inc/x.h'), false)
    assert.deepEqual(second.snapshot.contentHashOf('src/a.c'), hashContent64(nextText))
    assert.equal(second.snapshot.findByName('guarded').length, 0, 'removed conditional symbol gone')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('indexer includes: previous snapshot of another version is not reused', async () => {
  const dir = makeIncludeTree()
  try {
    const first = await buildIndex(makeOptions(dir))
    const foreign = {
      ...first.snapshot,
      version: SNAPSHOT_VERSION - 1,
      includedFiles: () => [] as readonly string[],
      contentHashOf: () => undefined,
    }
    const second = await buildIndex({
      ...makeOptions(dir),
      previous: foreign as unknown as typeof first.snapshot,
    })
    // 版本不符 → 全部按新文件重建（added），不能继承旧元数据
    assert.equal(second.summary.added, 4)
    assert.equal(second.summary.unchanged, 0)
    assert.deepEqual(second.snapshot.includedFiles('src/a.c'), ['inc/x.h'])
    assert.deepEqual(second.snapshot.contentHashOf('src/a.c'), hashContent64(A_C))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 2ffa868 写出的 v4 快照形状：文件记录只有 walk 的 path/mtime/size（无内容哈希）、
 * include CSR 为空、条目无条件。版本号仍是 v4，所以「同版本但元数据缺失」必须被识别。
 */
function legacyV4Snapshot(dir: string): SymbolTable {
  const files: FileRecord[] = ['src/a.c', 'inc/x.h', 'inc/y.h', 'other.c'].map((rel) => {
    const stat = fs.statSync(path.join(dir, rel))
    return { path: rel, mtimeMs: stat.mtimeMs, size: stat.size }
  })
  const entries: SymbolEntry[] = [
    { name: 'alpha', kind: 'function', file: 'src/a.c', line: 2, endLine: 2, column: 5 },
    // 旧快照不记录条件：guarded / conditional_t 的 #ifdef 信息丢失
    { name: 'guarded', kind: 'function', file: 'src/a.c', line: 4, endLine: 4, column: 5 },
    { name: 'conditional_t', kind: 'struct', file: 'inc/x.h', line: 5, endLine: 6, column: 8 },
    { name: 'sk_buff', kind: 'struct', file: 'inc/y.h', line: 3, endLine: 3, column: 8 },
    { name: 'unrelated', kind: 'function', file: 'other.c', line: 1, endLine: 1, column: 5 },
  ]
  return createSymbolTable(['.'], files, entries, 1, SNAPSHOT_VERSION)
}

test('indexer includes: legacy v4 previous without metadata is re-scanned and repaired', async () => {
  const dir = makeIncludeTree()
  try {
    const previous = legacyV4Snapshot(dir)
    // 前提：旧记录确实没有 v4 元数据（否则本用例证明不了任何事）
    assert.equal(previous.contentHashOf('src/a.c'), undefined)
    assert.deepEqual(previous.includedFiles('src/a.c'), [])
    assert.equal(previous.findByName('guarded')[0]!.condition, undefined)

    let reads = 0
    const snapshotPath = path.join(dir, 'storage', 'symbols.sidx')
    const result = await buildIndex({
      ...makeOptions(dir),
      previous,
      snapshotPath,
      readFile: async (rel: string) => {
        reads += 1
        return fs.readFileSync(path.join(dir, rel), 'utf8')
      },
    })

    // 元数据缺失的旧记录不能被 mtime+size 复用：4 个文件必须全部重读（不是沿用旧条目）
    assert.equal(reads, 4, 'legacy files must be re-read')
    assert.equal(result.summary.files, 4)
    assert.equal(result.summary.unchanged, 0)
    assert.equal(result.summary.updated, 4)

    // 重建后的内存表与磁盘快照都补齐哈希 / include 边 / 条件
    const loaded = await loadSnapshot(snapshotPath)
    assert.ok(loaded, 'rebuilt v4 snapshot must reload')
    for (const table of [result.snapshot, loaded!]) {
      assert.deepEqual(table.contentHashOf('src/a.c'), hashContent64(A_C))
      assert.deepEqual(table.contentHashOf('other.c'), hashContent64(OTHER_C))
      assert.deepEqual(table.includedFiles('src/a.c'), ['inc/x.h'])
      assert.deepEqual(table.includedFiles('inc/x.h'), ['inc/y.h'])
      assert.equal(table.isReachable('src/a.c', 'inc/y.h'), true)
    }
    assert.equal(loaded!.findByName('guarded')[0]!.condition, '#ifdef RTK_MODULE')
    assert.equal(
      loaded!.findByName('conditional_t')[0]!.condition,
      '#ifndef X_H && #ifdef RTK_MODULE',
    )

    // 修复后的快照（带哈希）才允许真正的增量复用：不再读源码
    const repaired = await buildIndex({
      ...makeOptions(dir),
      previous: loaded!,
      readFile: async () => {
        throw new Error('metadata-complete snapshot must be reused without reading sources')
      },
    })
    assert.equal(repaired.summary.unchanged, 4)
    assert.deepEqual(repaired.snapshot.includedFiles('src/a.c'), ['inc/x.h'])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('indexer includes: absolute include never creates an edge to a same-named workspace file', async () => {
  const dir = tempDir('si-indexer-absolute-include-')
  try {
    writeFiles(dir, {
      // 根目录文件最危险：dirname('.') + /etc/passwd.h 会归一成工作区里的 etc/passwd.h
      'a.c': ['#include "/etc/passwd.h"', 'int alpha(void) { return 0; }', ''].join('\n'),
      'etc/passwd.h': 'int root_only(void);\n',
      'inc/x.h': 'int x(void);\n',
    })
    const result = await buildIndex(makeOptions(dir))
    // 工作区里确实有 etc/passwd.h，但绝对 include 不能解析成它
    assert.equal(result.snapshot.isReachable('a.c', 'etc/passwd.h'), false)
    assert.deepEqual(result.snapshot.includedFiles('a.c'), [])
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
