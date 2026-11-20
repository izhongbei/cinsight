import test from 'node:test'
import assert from 'node:assert/strict'

import { createMutableIndex } from '../src/core/overlay-index'
import { createSymbolTable, getSymbolTableColumns } from '../src/core/symbol-table'
import { SNAPSHOT_VERSION } from '../src/shared/types'
import type { FileRecord, SymbolEntry } from '../src/shared/types'

/** 长 parent（中文 + 超 200 字节）：验证 parent 字符串表按字节长度正确编码/解码。 */
const LONG_PARENT = '类型_' + 'LongParent'.repeat(20)

function entry(overrides: Partial<SymbolEntry> & Pick<SymbolEntry, 'name' | 'file' | 'line'>): SymbolEntry {
  return {
    kind: 'function',
    endLine: overrides.line,
    column: 0,
    ...overrides,
  }
}

test('symbol table v5: parent 列去重并保留中文/长串，查询 API 暴露 parent', () => {
  const files: FileRecord[] = [
    { path: 'src/a.c', mtimeMs: 1, size: 1 },
    { path: 'inc/中文.h', mtimeMs: 2, size: 2 },
  ]
  const entries: SymbolEntry[] = [
    entry({ name: 'len', kind: 'member', file: 'src/a.c', line: 1, parent: 'sk_buff' }),
    entry({ name: 'data', kind: 'member', file: 'src/a.c', line: 2, parent: 'sk_buff' }),
    entry({ name: 'E_A', kind: 'enumConstant', file: 'inc/中文.h', line: 1, parent: '枚举类型' }),
    entry({ name: 'E_B', kind: 'enumConstant', file: 'inc/中文.h', line: 2, parent: LONG_PARENT }),
    entry({ name: 'glob', kind: 'variable', file: 'src/a.c', line: 9 }),
    // 空串与 undefined 同义：都落在 0 号（无 parent），不应新增表项
    entry({ name: 'empty_parent', kind: 'member', file: 'inc/中文.h', line: 5, parent: '' }),
  ]
  const table = createSymbolTable(['.'], files, entries, 1, SNAPSHOT_VERSION)
  const columns = getSymbolTableColumns(table)
  assert.ok(columns, 'built-in table exposes columns')
  assert.equal(columns!.parents[0], '', 'parent 表 0 号固定为空串')
  assert.equal(columns!.parents.length, 4, '重复 parent 只保留一份；undefined/空串共用 0 号')
  for (const parent of ['sk_buff', '枚举类型', LONG_PARENT]) {
    assert.ok(columns!.parents.includes(parent), `parent 表缺少 ${parent}`)
  }
  assert.equal(columns!.parentIds.length, entries.length)
  assert.equal(
    columns!.parentIds.filter((id) => id === 0).length,
    2,
    'variable 与空串 parent 的 parentId 都是 0',
  )

  assert.equal(table.findByName('len')[0]!.parent, 'sk_buff')
  assert.equal(table.findByName('data')[0]!.parent, 'sk_buff')
  assert.equal(table.findByName('E_A')[0]!.parent, '枚举类型')
  assert.equal(table.findByName('E_A')[0]!.kind, 'enumConstant')
  assert.equal(table.findByName('E_B')[0]!.parent, LONG_PARENT)
  assert.equal(table.findByName('E_B')[0]!.kind, 'enumConstant')

  // 无 parent 的条目不能 materialize 出 parent 属性（与旧快照/序列化形状一致）
  for (const name of ['glob', 'empty_parent']) {
    const item = table.findByName(name)[0]!
    assert.equal(item.parent, undefined)
    assert.equal(Object.hasOwn(item, 'parent'), false)
  }

  assert.deepEqual(
    table.entriesInFile('inc/中文.h').map((item) => [item.name, item.parent]),
    [
      ['E_A', '枚举类型'],
      ['E_B', LONG_PARENT],
      ['empty_parent', undefined],
    ],
  )

  const parentsByName = new Map<string, string | undefined>()
  table.forEachEntry((item) => {
    if (item.name === 'len' || item.name === 'glob') parentsByName.set(item.name, item.parent)
  })
  assert.equal(parentsByName.get('len'), 'sk_buff')
  assert.equal(parentsByName.get('glob'), undefined)

  const materialized = table.toArray()
  assert.equal(materialized.find((item) => item.name === 'data')!.parent, 'sk_buff')
  assert.equal(materialized.find((item) => item.name === 'glob')!.parent, undefined)
})

test('symbol table v5: overlay applyFile/toArray/flatten 保留 parent', () => {
  const base = createSymbolTable(
    ['.'],
    [{ path: 'src/a.c', mtimeMs: 1, size: 1 }],
    [entry({ name: 'base_member', kind: 'member', file: 'src/a.c', line: 1, parent: 'base_t' })],
    1,
    SNAPSHOT_VERSION,
  )
  const index = createMutableIndex(base)
  index.applyFile({ path: 'src/b.c', mtimeMs: 2, size: 2 }, [
    entry({ name: 'b_member', kind: 'member', file: 'src/b.c', line: 1, parent: '点_t' }),
    entry({ name: 'b_global', kind: 'variable', file: 'src/b.c', line: 5 }),
  ])

  assert.equal(index.findByName('b_member')[0]!.parent, '点_t')
  assert.equal(index.entriesInFile('src/b.c')[0]!.parent, '点_t')
  assert.equal(index.toArray().find((item) => item.name === 'b_member')!.parent, '点_t')
  const overlayGlobal = index.findByName('b_global')[0]!
  assert.equal(overlayGlobal.parent, undefined)
  assert.equal(Object.hasOwn(overlayGlobal, 'parent'), false)

  const flat = index.flatten()
  assert.equal(flat.findByName('base_member')[0]!.parent, 'base_t')
  assert.equal(flat.findByName('b_member')[0]!.parent, '点_t')
  assert.equal(flat.findByName('b_global')[0]!.parent, undefined)
  const flatColumns = getSymbolTableColumns(flat)
  assert.ok(flatColumns)
  assert.ok(flatColumns!.parents.includes('base_t'))
  assert.ok(flatColumns!.parents.includes('点_t'))

  // flatten 的条目集合（含 parent）与 overlay 视图完全一致
  const signature = (items: readonly SymbolEntry[]) =>
    items.map((item) => [item.name, item.kind, item.parent] as const).sort((a, b) =>
      a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
    )
  assert.deepEqual(signature(flat.toArray()), signature(index.toArray()))
})
