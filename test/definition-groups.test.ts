/**
 * 定义候选分组（B2 + B4）：
 *   - 内容哈希相同的文件视为同一份定义的多副本，折叠为一组（组内保持 rank 顺序）；
 *   - 代表 = 组内排名最高者；included / conditional 都按代表计算；
 *   - 无表时退化为「按文件」分组，不引入 include / 条件让排序或分组劣化。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  formatDefinitionLabel,
  groupDefinitions,
  type DefinitionGroup,
} from '../src/core/definition-groups'
import { createSymbolTable } from '../src/core/symbol-table'
import { SNAPSHOT_VERSION } from '../src/shared/types'
import type {
  FileRecord,
  SymbolEntry,
  SymbolKind,
  SymbolTable,
} from '../src/shared/types'

function entry(
  file: string,
  line: number,
  kind: SymbolKind = 'struct',
  name = 'sk_buff',
  condition?: string,
): SymbolEntry {
  const base: SymbolEntry = { name, kind, file, line, endLine: line, column: 0 }
  return condition === undefined ? base : { ...base, condition }
}

function file(path: string, hash?: { lo: number; hi: number }): FileRecord {
  const base: FileRecord = { path, mtimeMs: 0, size: 0 }
  return hash ? { ...base, contentHashLo: hash.lo, contentHashHi: hash.hi } : base
}

function makeTable(
  files: readonly FileRecord[],
  entries: readonly SymbolEntry[],
  includes?: ReadonlyMap<string, readonly string[]>,
): SymbolTable {
  return createSymbolTable(['.'], files, entries, 1, SNAPSHOT_VERSION, { includes })
}

test('definition groups: identical content hashes collapse across different paths', () => {
  const a = entry('vendor/a/include/linux/skbuff.h', 10)
  const b = entry('vendor/b/include/linux/skbuff.h', 20)
  const c = entry('vendor/c/include/linux/skbuff.h', 30)
  const table = makeTable(
    [
      file('src/main.c', { lo: 1, hi: 1 }),
      file(a.file, { lo: 11, hi: 22 }),
      file(b.file, { lo: 11, hi: 22 }),
      file(c.file, { lo: 33, hi: 44 }),
    ],
    [a, b, c],
  )

  const groups = groupDefinitions([a, b, c], {
    sourceFile: 'src/main.c',
    roots: ['vendor'],
    table,
  })

  assert.equal(groups.length, 2, 'two distinct contents')
  assert.equal(groups[0]!.copies, 2)
  assert.deepEqual(
    groups[0]!.entries.map((item) => item.file),
    [a.file, b.file],
    'identical copies keep rank order inside the group',
  )
  assert.equal(groups[0]!.representative, groups[0]!.entries[0], 'representative is the top-ranked copy')
  assert.equal(groups[1]!.copies, 1)
  assert.equal(groups[1]!.representative.file, c.file)
})

test('definition groups: representative is the highest-ranked copy and drives included', () => {
  const source = 'vendor/app/main.c'
  const includedCopy = entry('inc/skb.h', 10)
  const siblingCopy = entry('vendor/linux/include/skbuff.h', 20)
  const unrelated = entry('other/skbuff.h', 30)
  const table = makeTable(
    [
      file(source, { lo: 1, hi: 1 }),
      file(includedCopy.file, { lo: 7, hi: 7 }),
      file(siblingCopy.file, { lo: 7, hi: 7 }),
      file(unrelated.file, { lo: 8, hi: 8 }),
    ],
    [includedCopy, siblingCopy, unrelated],
    new Map([[source, [includedCopy.file]]]),
  )

  const groups = groupDefinitions([siblingCopy, unrelated, includedCopy], {
    sourceFile: source,
    roots: ['vendor'],
    table,
  })

  const identical = groups.find((group) => group.copies === 2)
  assert.ok(identical, 'identical copies are folded into one group')
  // included 优先于「同 root / 更近路径」：代表是被当前源文件包含的副本
  assert.equal(identical!.representative.file, includedCopy.file)
  assert.equal(identical!.included, true)
  assert.equal(identical!.conditional, false)
  const notIncluded = groups.find((group) => group.copies === 1)
  assert.ok(notIncluded)
  assert.equal(notIncluded!.representative.file, unrelated.file)
  assert.equal(notIncluded!.included, false)
})

test('definition groups: conditional tracks the representative, not any copy', () => {
  const source = 'a/main.c'
  const plain = entry('a/x.h', 10)
  const conditionalCopy = entry('b/x.h', 10, 'struct', 'sk_buff', '#ifdef RTK_MODULE')
  const onlyConditional = entry('c/y.h', 10, 'struct', 'sk_buff', '#ifndef Y_H')
  const table = makeTable(
    [
      file(source, { lo: 1, hi: 1 }),
      file('a/x.h', { lo: 2, hi: 2 }),
      file('b/x.h', { lo: 2, hi: 2 }),
      file('c/y.h', { lo: 3, hi: 3 }),
    ],
    [plain, conditionalCopy, onlyConditional],
  )

  const groups = groupDefinitions([conditionalCopy, onlyConditional, plain], {
    sourceFile: source,
    roots: ['.'],
    table,
  })

  assert.equal(groups.length, 2)
  // 同哈希组里代表是无条件的 a/x.h：即使副本 b/x.h 在 #ifdef 里，组仍不算 conditional
  assert.equal(groups[0]!.copies, 2)
  assert.equal(groups[0]!.representative.file, 'a/x.h')
  assert.equal(groups[0]!.conditional, false)
  assert.equal(groups[1]!.representative.file, 'c/y.h')
  assert.equal(groups[1]!.conditional, true)
})

test('definition groups: a definition in the source file is included without an include edge', () => {
  const source = 'src/main.c'
  const sameFile = entry(source, 10)
  const otherFile = entry('src/skb.h', 20)
  const table = makeTable(
    [file(source, { lo: 1, hi: 1 }), file(otherFile.file, { lo: 2, hi: 2 })],
    [sameFile, otherFile],
  )

  const groups = groupDefinitions([otherFile, sameFile], {
    sourceFile: source,
    roots: ['.'],
    table,
  })
  const sameGroup = groups.find((group) => group.representative.file === source)
  const otherGroup = groups.find((group) => group.representative.file === otherFile.file)
  assert.equal(sameGroup?.included, true, 'source file definition counts as included')
  assert.equal(otherGroup?.included, false, 'no include edge means not included')
})

test('definition groups: without a table groups fall back to one group per file', () => {
  const line5 = entry('a/skb.h', 5)
  const line9 = entry('a/skb.h', 9)
  const elsewhere = entry('b/skb.h', 3)
  const groups = groupDefinitions([line9, elsewhere, line5], {
    sourceFile: 'a/main.c',
    roots: ['a'],
  })

  assert.equal(groups.length, 2, 'no hash information: file path is the fallback key')
  assert.equal(groups[0]!.copies, 2)
  assert.deepEqual(
    groups[0]!.entries.map((item) => `${item.file}:${item.line}`),
    ['a/skb.h:5', 'a/skb.h:9'],
    'fallback groups still follow rank order',
  )
  assert.equal(groups[0]!.included, false, 'no table never claims included')
  assert.equal(groups[1]!.representative.file, 'b/skb.h')
})

test('definition groups: files with an unknown hash also group by path', () => {
  const a5 = entry('a/x.h', 5)
  const a9 = entry('a/x.h', 9)
  const b = entry('b/y.h', 5)
  const table = makeTable([file('a/x.h'), file('b/y.h')], [a5, a9, b])

  const groups = groupDefinitions([a5, a9, b], { roots: ['.'], table })
  assert.equal(groups.length, 2)
  assert.equal(groups[0]!.copies, 2)
  assert.equal(groups[0]!.representative.file, 'a/x.h')
})

test('definition label: composes only the present parts', () => {
  const representative = entry('a/x.h', 10, 'struct', 'sk_buff', '#ifdef RTK_MODULE')
  const base: DefinitionGroup = {
    entries: [representative],
    representative,
    included: false,
    conditional: false,
    copies: 1,
  }
  assert.equal(formatDefinitionLabel(base), 'sk_buff')
  assert.equal(formatDefinitionLabel({ ...base, included: true }), 'sk_buff  ·  included')
  assert.equal(formatDefinitionLabel({ ...base, copies: 3 }), 'sk_buff  ·  3 copies')
  assert.equal(
    formatDefinitionLabel({ ...base, included: true, copies: 3, conditional: true }),
    'sk_buff  ·  included  ·  3 copies  ·  #ifdef RTK_MODULE',
  )
  // conditional 为 true 但条件文本缺失时回退为 "conditional"（防御外部构造的 group）
  assert.equal(
    formatDefinitionLabel({ ...base, representative: entry('a/x.h', 10), conditional: true }),
    'sk_buff  ·  conditional',
  )
})

test('definition groups: empty input is safe', () => {
  assert.deepEqual(groupDefinitions([], { roots: ['.'] }), [])
})
