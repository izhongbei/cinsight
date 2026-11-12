/**
 * 引用加速索引的端到端验证：同一工程分别用「全量扫描」和「倒排索引」查引用，
 * 结果必须完全一致，而索引路径读取的文件数应显著更少。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile as readFileAsync, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildIndex } from '../src/core/indexer'
import { loadNameIndex } from '../src/core/nameindex'
import { clearReferenceCache, findReferences } from '../src/core/references'
import { callersOf } from '../src/core/callgraph'
import type { ReadFileFn } from '../src/shared/types'

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

const UTIL_H = `int util_scale(int value, int factor);
`

const OTHER_C = `int unrelated(void)
{
    return 7;
}
`

async function makeFixture(): Promise<{ root: string; readFile: ReadFileFn; reads: string[] }> {
  const root = await mkdtemp(join(tmpdir(), 'si-nameindex-e2e-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src/main.c'), MAIN_C, 'utf8')
  await writeFile(join(root, 'src/util.c'), UTIL_C, 'utf8')
  await writeFile(join(root, 'src/util.h'), UTIL_H, 'utf8')
  await writeFile(join(root, 'src/other.c'), OTHER_C, 'utf8')
  const reads: string[] = []
  const readFile: ReadFileFn = async (rel) => {
    reads.push(rel)
    return readFileAsync(join(root, rel), 'latin1')
  }
  return { root, readFile, reads }
}

test('nameindex e2e: indexed references match full scan and read fewer files', async () => {
  const fixture = await makeFixture()
  try {
    const nameIndexPath = join(fixture.root, 'symbols.names')
    const result = await buildIndex({
      workspaceRoot: fixture.root,
      roots: ['.'],
      exclude: ['**/build/**'],
      maxFileSizeKB: 4096,
      concurrency: 1,
      followSymlinks: false,
      readFile: fixture.readFile,
      nameIndexPath,
    })
    const snapshot = result.snapshot
    assert.ok(result.summary.nameIndexBytes && result.summary.nameIndexBytes > 0, 'name index written')
    const nameIndex = await loadNameIndex(nameIndexPath)
    assert.ok(nameIndex, 'name index loads')

    // 1) 全量扫描
    clearReferenceCache()
    fixture.reads.length = 0
    const full = await findReferences(snapshot, 'util_scale', fixture.readFile, {
      includeDeclaration: false,
    })
    const fullReads = fixture.reads.length

    // 2) 倒排索引
    clearReferenceCache()
    fixture.reads.length = 0
    const indexed = await findReferences(snapshot, 'util_scale', fixture.readFile, {
      includeDeclaration: false,
      nameIndex,
    })
    const indexedReads = fixture.reads.length

    assert.deepEqual(indexed, full, 'same hits as full scan')
    assert.deepEqual(
      indexed.map((hit) => `${hit.file}:${hit.line}:${hit.column}`),
      full.map((hit) => `${hit.file}:${hit.line}:${hit.column}`),
    )
    assert.ok(indexedReads < fullReads, `indexed should read fewer files (${indexedReads} < ${fullReads})`)
    assert.ok(indexedReads <= 3, 'only files containing the identifier are read')

    // 3) 索引里不存在的标识符：直接返回空，且不读任何文件
    clearReferenceCache()
    fixture.reads.length = 0
    const missing = await findReferences(snapshot, 'not_a_real_symbol_xyz', fixture.readFile, {
      nameIndex,
    })
    assert.deepEqual(missing, [])
    assert.equal(fixture.reads.length, 0, 'no file reads for identifiers absent from the index')

    // 4) callers 走索引后结果一致
    clearReferenceCache()
    const callersIndexed = await callersOf(snapshot, 'compute', fixture.readFile, { nameIndex })
    clearReferenceCache()
    const callersFull = await callersOf(snapshot, 'compute', fixture.readFile, {})
    assert.deepEqual(
      callersIndexed.map((hit) => hit.from?.name ?? '<top>'),
      callersFull.map((hit) => hit.from?.name ?? '<top>'),
    )
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})
