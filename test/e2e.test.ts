/**
 * Lead 的跨模块集成测试：把 walk → scan → index → snapshot → query → refs → callgraph
 * 串起来在临时目录里跑一遍，验证各队友模块的契约能对上。
 *
 * 运行：npm test（或 node --test dist/test/e2e.test.js）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildIndex } from '../src/core/indexer'
import { loadSnapshot, saveSnapshot } from '../src/core/store'
import { entriesInFile, findByName, searchSymbols } from '../src/core/query'
import { readSignature } from '../src/core/signature'
import { findReferences } from '../src/core/references'
import { callersOf, calleesOf } from '../src/core/callgraph'
import type { IndexSnapshot, ReadFileFn } from '../src/shared/types'

const MAIN_C = `#include "util.h"

static int helper(int x)
{
    return x + 1;
}

int compute(int base)
{
    int value = helper(base);
    return util_scale(value, 2);
}

int entry(void)
{
    return compute(3);
}
`

const UTIL_C = `#include "util.h"

int util_scale(int value, int factor)
{
    return value * factor;
}
`

const UTIL_H = `#ifndef UTIL_H
#define UTIL_H

int util_scale(int value, int factor);

#endif
`

interface Fixture {
  root: string
  readFile: ReadFileFn
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'si-e2e-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src/main.c'), MAIN_C, 'utf8')
  await writeFile(join(root, 'src/util.c'), UTIL_C, 'utf8')
  await writeFile(join(root, 'src/util.h'), UTIL_H, 'utf8')
  // 默认排除目录里的文件不应被索引
  await mkdir(join(root, 'build'), { recursive: true })
  await writeFile(join(root, 'build/generated.c'), 'int generated(void) { return 0; }\n', 'utf8')
  const readFile: ReadFileFn = (rel) => {
    return import('node:fs/promises').then((fs) => fs.readFile(join(root, rel), 'latin1'))
  }
  return { root, readFile }
}

async function buildFixtureSnapshot(fixture: Fixture): Promise<IndexSnapshot> {
  const result = await buildIndex({
    workspaceRoot: fixture.root,
    roots: ['.'],
    exclude: ['**/build/**'],
    maxFileSizeKB: 4096,
    concurrency: 1,
    followSymlinks: false,
    readFile: fixture.readFile,
  })
  return result.snapshot
}

test('end-to-end: index, query, jump, references and call graph', async () => {
  const fixture = await makeFixture()
  try {
    const snapshot = await buildFixtureSnapshot(fixture)

    // 索引结果：3 个文件，排除 build/
    assert.equal(snapshot.files.length, 3, 'indexed files')
    assert.ok(snapshot.entries.length >= 4, 'symbol entries')

    // 符号搜索
    const hits = searchSymbols(snapshot, 'compute')
    assert.equal(hits[0]?.name, 'compute')
    assert.equal(hits[0]?.file, 'src/main.c')

    // 精确查找 + 声明兜底
    const scaleDefs = findByName(snapshot, 'util_scale')
    assert.ok(scaleDefs.length >= 2, 'util_scale has definition and declaration')
    assert.equal(scaleDefs.filter((entry) => entry.kind === 'function').length, 1)
    assert.equal(scaleDefs[0]?.kind, 'function')

    // 按文件列出（文档大纲数据）
    const mainSymbols = entriesInFile(snapshot, 'src/main.c')
    assert.deepEqual(
      mainSymbols.map((entry) => entry.name),
      ['helper', 'compute', 'entry'],
    )

    // 签名重建
    const compute = findByName(snapshot, 'compute').find((entry) => entry.kind === 'function')
    assert.ok(compute, 'compute definition')
    const signature = await readSignature(fixture.readFile, compute)
    assert.match(signature ?? '', /int\s+compute\s*\(\s*int\s+base\s*\)/)

    // 引用（排除定义行）
    const refs = await findReferences(snapshot, 'compute', fixture.readFile, { includeDeclaration: false })
    assert.equal(refs.length, 1, 'compute referenced once from entry()')
    assert.equal(refs[0]?.file, 'src/main.c')
    assert.equal(refs[0]?.line, 15, 'call site line is 0-based 15')

    // 调用关系
    const callers = await callersOf(snapshot, 'compute', fixture.readFile)
    assert.equal(callers.length, 1)
    assert.equal(callers[0]?.from?.name, 'entry')

    const callees = await calleesOf(snapshot, 'compute', fixture.readFile)
    assert.deepEqual(callees.map((entry) => entry.name), ['helper', 'util_scale'])

    // 快照 roundtrip
    const snapshotPath = join(fixture.root, 'out.sidx')
    const bytes = await saveSnapshot(snapshotPath, snapshot)
    assert.ok(bytes > 0)
    const loaded = await loadSnapshot(snapshotPath)
    assert.ok(loaded, 'snapshot loads')
    assert.equal(loaded?.entries.length, snapshot.entries.length)
    assert.deepEqual(searchSymbols(loaded!, 'entry').map((entry) => entry.name), ['entry'])
    assert.equal(loaded?.entries[0]?.kind, 'function')
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('end-to-end: incremental rebuild only re-parses changed files', async () => {
  const fixture = await makeFixture()
  try {
    const first = await buildFixtureSnapshot(fixture)

    const second = await buildIndex({
      workspaceRoot: fixture.root,
      roots: ['.'],
      exclude: ['**/build/**'],
      maxFileSizeKB: 4096,
      concurrency: 1,
      followSymlinks: false,
      readFile: fixture.readFile,
      previous: first,
    })
    assert.equal(second.summary.updated, 0)
    assert.equal(second.summary.added, 0)

    // 修改 util.c：新增一个函数
    const { writeFile: wf } = await import('node:fs/promises')
    await wf(
      join(fixture.root, 'src/util.c'),
      UTIL_C + '\nint util_extra(int value)\n{\n    return value;\n}\n',
      'utf8',
    )
    const third = await buildIndex({
      workspaceRoot: fixture.root,
      roots: ['.'],
      exclude: ['**/build/**'],
      maxFileSizeKB: 4096,
      concurrency: 1,
      followSymlinks: false,
      readFile: fixture.readFile,
      previous: second.snapshot,
    })
    assert.equal(third.summary.updated, 1, 'only util.c re-parsed')
    assert.ok(findByName(third.snapshot, 'util_extra').length >= 1, 'new function indexed')
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})
