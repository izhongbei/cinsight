import test from 'node:test'
import assert from 'node:assert/strict'

import { decodeSnapshot, encodeSnapshot } from '../src/core/store'
import { createSymbolTable, getSymbolTableColumns } from '../src/core/symbol-table'
import { SNAPSHOT_VERSION } from '../src/shared/types'
import type { FileRecord, SymbolEntry } from '../src/shared/types'

/** 长 parent（中文 + 超 200 字节）。 */
const LONG_PARENT = '类型_' + 'LongParent'.repeat(20)

/**
 * v5 entry 列每条的定长字节：
 * nameId/fileIndex/line/endLine(u32×4) + column(u16) + kind(u8) + conditionId(u32) + parentId(u32)
 */
const ENTRY_BYTES = 4 + 4 + 4 + 4 + 2 + 1 + 4 + 4
/** parentId 之前每条的定长字节（nameId..conditionId）。 */
const ENTRY_BYTES_BEFORE_PARENT_ID = 4 + 4 + 4 + 4 + 2 + 1 + 4

function entry(overrides: Partial<SymbolEntry> & Pick<SymbolEntry, 'name' | 'file' | 'line'>): SymbolEntry {
  return {
    kind: 'function',
    endLine: overrides.line,
    column: 0,
    ...overrides,
  }
}

function makeTable() {
  const files: FileRecord[] = [
    { path: 'src/a.c', mtimeMs: 1.5, size: 10, contentHashLo: 0xdeadbeef, contentHashHi: 0x12345678 },
    { path: 'inc/中文 x.h', mtimeMs: 2, size: 20, contentHashLo: 1, contentHashHi: 0xffffffff },
    { path: 'inc/y.h', mtimeMs: 3, size: 30 },
  ]
  const entries: SymbolEntry[] = [
    entry({ name: 'sk_buff_len', kind: 'member', file: 'src/a.c', line: 1, endLine: 1, column: 4, parent: 'sk_buff' }),
    entry({ name: 'sk_buff_data', kind: 'member', file: 'src/a.c', line: 2, endLine: 2, column: 4, parent: 'sk_buff' }),
    entry({ name: 'COLOR_RED', kind: 'enumConstant', file: 'inc/中文 x.h', line: 7, endLine: 7, column: 1, parent: '枚举类型', condition: '#ifdef 中文' }),
    entry({ name: 'COLOR_BLUE', kind: 'enumConstant', file: 'inc/中文 x.h', line: 8, endLine: 8, column: 1, parent: LONG_PARENT }),
    entry({ name: 'global_count', kind: 'variable', file: 'inc/y.h', line: 3, endLine: 3, column: 0 }),
    entry({ name: 'plain', kind: 'function', file: 'inc/y.h', line: 11, endLine: 11, column: 2 }),
  ]
  const includes = new Map<string, readonly string[]>([
    ['src/a.c', ['inc/中文 x.h', 'inc/y.h']],
    ['inc/中文 x.h', ['inc/y.h']],
    ['inc/y.h', []],
  ])
  return createSymbolTable(['.', 'inc'], files, entries, 42, SNAPSHOT_VERSION, { includes })
}

/**
 * 定位编码后 parentIds 列的起始偏移：
 * 尾部固定是 nameOffsets / fileEntryOffsets / fileEntryIndexes / includeOffsets / includeTargets，
 * 往前推 entry 列起点，再加 parentId 之前的列宽。
 */
function locateParentIdsStart(
  encoded: Buffer,
  columns: NonNullable<ReturnType<typeof getSymbolTableColumns>>,
): number {
  const entryCount = columns.nameIds.length
  const tailLengths =
    columns.nameOffsets.length +
    columns.fileEntryOffsets.length +
    columns.fileEntryIndexes.length +
    columns.includeOffsets.length +
    columns.includeTargets.length
  const entriesStart = encoded.length - tailLengths * 4 - entryCount * ENTRY_BYTES
  return entriesStart + entryCount * ENTRY_BYTES_BEFORE_PARENT_ID
}

test('store v5: parent 字符串表与 parentIds 列完整 roundtrip', () => {
  const table = makeTable()
  const columns = getSymbolTableColumns(table)
  assert.ok(columns, 'built-in table exposes columns')
  const encoded = encodeSnapshot(table)
  const decoded = decodeSnapshot(encoded)
  assert.ok(decoded, 'v5 snapshot must decode')
  assert.equal(decoded!.version, SNAPSHOT_VERSION)
  assert.equal(decoded!.builtAt, 42)
  assert.deepEqual(decoded!.roots, ['.', 'inc'])
  assert.deepEqual(decoded!.files, table.files, 'file records（含 hash）原样保留')

  // parent 表与 parentIds 列对称：去重表 + 每条 id
  const decodedColumns = getSymbolTableColumns(decoded!)
  assert.ok(decodedColumns)
  assert.deepEqual(decodedColumns!.parents, columns!.parents)
  assert.deepEqual(decodedColumns!.parentIds, columns!.parentIds)
  assert.equal(decodedColumns!.parents[0], '')
  assert.ok(decodedColumns!.parents.includes('sk_buff'))
  assert.ok(decodedColumns!.parents.includes('枚举类型'))
  assert.ok(decodedColumns!.parents.includes(LONG_PARENT))

  // 所有既有列（name/line/endLine/column/kind/condition/hash/include）保持不变
  assert.deepEqual(decoded!.toArray(), table.toArray())
  assert.equal(decoded!.findByName('sk_buff_len')[0]!.parent, 'sk_buff')
  assert.equal(decoded!.findByName('COLOR_RED')[0]!.parent, '枚举类型')
  assert.equal(decoded!.findByName('COLOR_RED')[0]!.condition, '#ifdef 中文')
  assert.equal(decoded!.findByName('COLOR_BLUE')[0]!.parent, LONG_PARENT)
  const variable = decoded!.findByName('global_count')[0]!
  assert.equal(variable.kind, 'variable')
  assert.equal(variable.parent, undefined)
  assert.equal(Object.hasOwn(variable, 'parent'), false)

  assert.deepEqual(decoded!.contentHashOf('src/a.c'), { lo: 0xdeadbeef, hi: 0x12345678 })
  assert.deepEqual(decoded!.includedFiles('src/a.c'), ['inc/中文 x.h', 'inc/y.h'])
  assert.deepEqual(decoded!.includedFiles('inc/y.h'), [])
  assert.equal(decoded!.isReachable('src/a.c', 'inc/y.h'), true)
})

test('store v5: 版本号不等于 SNAPSHOT_VERSION 的快照被拒绝', () => {
  const encoded = encodeSnapshot(makeTable())
  for (const version of [1, 2, 3, 4, 6]) {
    const patched = Buffer.from(encoded)
    patched.writeUInt32LE(version, 4)
    assert.equal(decodeSnapshot(patched), undefined, `version ${version} must be rejected`)
  }
  const truncated = encodeSnapshot(makeTable()).subarray(0, encoded.length - 4)
  assert.equal(decodeSnapshot(truncated), undefined, '截断的快照必须拒绝')
})

test('store v5: parentId 越界按损坏快照拒绝', () => {
  const table = makeTable()
  const columns = getSymbolTableColumns(table)
  assert.ok(columns)
  const encoded = encodeSnapshot(table)
  const parentIdsStart = locateParentIdsStart(encoded, columns!)
  const entryCount = columns!.nameIds.length

  // 先确认定位到的列与编码前一致（否则下面的越界断言证明不了任何事）
  for (let index = 0; index < entryCount; index++) {
    assert.equal(encoded.readUInt32LE(parentIdsStart + index * 4), columns!.parentIds[index])
  }

  const outOfRange = Buffer.from(encoded)
  outOfRange.writeUInt32LE(columns!.parents.length, parentIdsStart)
  assert.equal(decodeSnapshot(outOfRange), undefined, 'parentId >= parentCount 必须拒绝')

  const huge = Buffer.from(encoded)
  huge.writeUInt32LE(0xffffffff, parentIdsStart)
  assert.equal(decodeSnapshot(huge), undefined, 'parentId 0xffffffff 必须拒绝')
})
