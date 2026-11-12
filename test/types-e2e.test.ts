/**
 * 类型符号端到端：索引 → 快照 → 查询，确认 struct/union/enum/typedef 能被查到并可跳转。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile as readFileAsync, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildIndex } from '../src/core/indexer'
import { loadSnapshot, saveSnapshot } from '../src/core/store'
import { entriesInFile, findByName, searchSymbols } from '../src/core/query'
import type { ReadFileFn } from '../src/shared/types'

const TYPES_H = `#ifndef TYPES_H
#define TYPES_H

struct point {
    int x;
    int y;
};

typedef struct point point_t;

typedef struct {
    int width;
    int height;
} size_t2;

typedef void (*callback_t)(int code, void *ctx);

enum color { COLOR_RED, COLOR_GREEN };

union value {
    int i;
    float f;
};

#endif
`

const USE_C = `#include "types.h"

struct point origin;
point_t scale(point_t p);
callback_t register_cb(callback_t cb);
`

async function makeFixture(): Promise<{ root: string; readFile: ReadFileFn }> {
  const root = await mkdtemp(join(tmpdir(), 'si-types-e2e-'))
  await mkdir(join(root, 'inc'), { recursive: true })
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'inc/types.h'), TYPES_H, 'utf8')
  await writeFile(join(root, 'src/use.c'), USE_C, 'utf8')
  const readFile: ReadFileFn = async (rel) => readFileAsync(join(root, rel), 'latin1')
  return { root, readFile }
}

test('types e2e: struct/union/enum/typedef are indexed, searchable and navigable', async () => {
  const fixture = await makeFixture()
  try {
    const result = await buildIndex({
      workspaceRoot: fixture.root,
      roots: ['.'],
      exclude: [],
      maxFileSizeKB: 4096,
      concurrency: 1,
      followSymlinks: false,
      readFile: fixture.readFile,
    })
    const snapshot = result.snapshot

    // 1) 定义按名字查到，并带文件/行号
    const point = findByName(snapshot, 'point').find((entry) => entry.kind === 'struct')
    assert.ok(point, 'struct point indexed')
    assert.equal(point?.file, 'inc/types.h')
    assert.equal(point?.line, 3)

    const pointT = findByName(snapshot, 'point_t').find((entry) => entry.kind === 'typedef')
    assert.ok(pointT, 'typedef point_t indexed')
    assert.equal(pointT?.file, 'inc/types.h')

    const sizeT2 = findByName(snapshot, 'size_t2').find((entry) => entry.kind === 'typedef')
    assert.ok(sizeT2, 'anonymous struct typedef size_t2 indexed')

    const callbackT = findByName(snapshot, 'callback_t').find((entry) => entry.kind === 'typedef')
    assert.ok(callbackT, 'function pointer typedef indexed')

    const color = findByName(snapshot, 'color').find((entry) => entry.kind === 'enum')
    assert.ok(color, 'enum color indexed')

    const value = findByName(snapshot, 'value').find((entry) => entry.kind === 'union')
    assert.ok(value, 'union value indexed')

    // 2) 类型也能被符号搜索命中（Ctrl+T）
    const hits = searchSymbols(snapshot, 'point', { limit: 20 })
    assert.ok(hits.some((entry) => entry.name === 'point' && entry.kind === 'struct'))
    assert.ok(hits.some((entry) => entry.name === 'point_t' && entry.kind === 'typedef'))

    // 3) 文档大纲数据包含类型
    const headerSymbols = entriesInFile(snapshot, 'inc/types.h').map((entry) => entry.name)
    for (const name of ['point', 'point_t', 'size_t2', 'callback_t', 'color', 'value']) {
      assert.ok(headerSymbols.includes(name), `${name} in outline data`)
    }

    // 4) 快照 roundtrip 保留 kind
    const snapshotPath = join(fixture.root, 'types.sidx')
    await saveSnapshot(snapshotPath, snapshot)
    const loaded = await loadSnapshot(snapshotPath)
    assert.ok(loaded, 'snapshot loads')
    const loadedKinds = new Map(loaded!.entries.map((entry) => [`${entry.file}:${entry.name}`, entry.kind]))
    assert.equal(loadedKinds.get('inc/types.h:point'), 'struct')
    assert.equal(loadedKinds.get('inc/types.h:point_t'), 'typedef')
    assert.equal(loadedKinds.get('inc/types.h:color'), 'enum')
    assert.equal(loadedKinds.get('inc/types.h:value'), 'union')

    // 5) 使用处（struct point origin;）不会被误索引成定义
    const useSymbols = entriesInFile(snapshot, 'src/use.c').map((entry) => entry.name)
    assert.ok(!useSymbols.includes('point'), 'usage is not a definition')
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})
