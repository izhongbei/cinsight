import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { hashContent64 } from '../src/core/hash'
import { buildIndex } from '../src/core/indexer'
import { loadSnapshot } from '../src/core/store'
import { DEFAULT_EXCLUDE, SNAPSHOT_VERSION } from '../src/shared/types'
import type { BuildOptions, ReadFileFn } from '../src/shared/types'

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
