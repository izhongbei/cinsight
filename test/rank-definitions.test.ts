/**
 * 定义候选排序：同一个名字有多份定义时，离光标最近的排在前面。
 *
 * 0.8.0 增加两个键（低优先级）：被当前源文件 include 的定义最优先；无条件的定义
 * 只在完全同层时压过有条件的（不给条件加权到路径远近之上）。没有 table 时行为与
 * 0.7.0 完全一致。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { rankDefinitions } from '../src/vscode/rank-definitions'
import { createSymbolTable } from '../src/core/symbol-table'
import { SNAPSHOT_VERSION } from '../src/shared/types'
import type { SymbolEntry, SymbolKind, SymbolTable } from '../src/shared/types'

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

function makeTable(
  files: readonly string[],
  entries: readonly SymbolEntry[],
  includes?: ReadonlyMap<string, readonly string[]>,
): SymbolTable {
  const records = files.map((path) => ({ path, mtimeMs: 0, size: 0 }))
  return createSymbolTable(['.'], records, entries, 1, SNAPSHOT_VERSION, { includes })
}

const KERNEL = 'datapath/kernel/linux-5.10/include/linux/skbuff.h'
const KERNEL2 = 'datapath/kernel/linux-rtk/include/linux/skbuff.h'
const SWITCH = 'component/switch/drv/switch_skb.h'
const SWITCH_C = 'component/switch/drv/switch_skb.c'

test('rank: same index root wins over another root', () => {
  const entries = [
    entry(KERNEL, 10),
    entry(KERNEL2, 20),
    entry(SWITCH, 30),
  ]
  const ranked = rankDefinitions(entries, {
    sourceFile: 'component/switch/drv/forward.c',
    roots: ['component/switch', 'datapath/kernel'],
  })
  assert.equal(ranked[0]?.file, SWITCH)
})

test('rank: closer shared path prefix wins inside the same root', () => {
  const entries = [
    entry('component/switch/other/deep/skb.h', 10),
    entry('component/switch/drv/skb.h', 20),
  ]
  const ranked = rankDefinitions(entries, {
    sourceFile: 'component/switch/drv/forward.c',
    roots: ['component/switch'],
  })
  assert.equal(ranked[0]?.file, 'component/switch/drv/skb.h')
})

test('rank: definition beats declaration at the same distance', () => {
  const entries = [
    entry('component/switch/drv/skb.h', 10, 'declaration'),
    entry('component/switch/drv/skb.h', 40, 'struct'),
  ]
  const ranked = rankDefinitions(entries, {
    sourceFile: 'component/switch/drv/forward.c',
    roots: ['component/switch'],
  })
  // 0.8.0 的相对 kind 顺序：struct(1) 在 declaration(5) 之前
  assert.equal(ranked[0]?.kind, 'struct')
})

test('rank: type symbols prefer headers, functions prefer sources', () => {
  const typeEntries = [
    entry('component/switch/drv/skb.c', 10, 'struct'),
    entry('component/switch/drv/skb.h', 20, 'struct'),
  ]
  const rankedTypes = rankDefinitions(typeEntries, {
    sourceFile: 'component/switch/drv/forward.c',
    roots: ['component/switch'],
  })
  assert.equal(rankedTypes[0]?.file, 'component/switch/drv/skb.h')

  const fnEntries = [
    entry('component/switch/drv/fwd.h', 10, 'function', 'fwd_start'),
    entry('component/switch/drv/fwd.c', 20, 'function', 'fwd_start'),
  ]
  const rankedFns = rankDefinitions(fnEntries, {
    sourceFile: 'component/switch/drv/other.c',
    roots: ['component/switch'],
  })
  assert.equal(rankedFns[0]?.file, 'component/switch/drv/fwd.c')
})

test('rank: without context falls back to kind order then path (stable)', () => {
  const entries = [
    entry('b/skb.h', 10, 'declaration'),
    entry('a/skb.h', 20, 'struct'),
    entry('a/skb.c', 5, 'macro'),
  ]
  const ranked = rankDefinitions(entries)
  assert.deepEqual(
    ranked.map((item) => `${item.kind}:${item.file}:${item.line}`),
    ['struct:a/skb.h:20', 'declaration:b/skb.h:10', 'macro:a/skb.c:5'],
  )
})

test('rank: whole-workspace root (.) does not override path proximity', () => {
  const entries = [entry(KERNEL, 10), entry(SWITCH, 20)]
  const ranked = rankDefinitions(entries, {
    sourceFile: 'component/switch/drv/forward.c',
    roots: ['.'],
  })
  assert.equal(ranked[0]?.file, SWITCH)
})

test('rank: identical entries keep their original order', () => {
  const a = entry('component/switch/drv/skb.h', 10)
  const b = entry('component/switch/drv/skb.h', 10)
  const ranked = rankDefinitions([a, b], {
    sourceFile: 'component/switch/drv/forward.c',
    roots: ['component/switch'],
  })
  assert.equal(ranked.length, 2)
  assert.equal(ranked[0], a)
  assert.equal(ranked[1], b)
})

test('rank: empty and single-entry inputs are safe', () => {
  assert.deepEqual(rankDefinitions([]), [])
  const only = entry(SWITCH_C, 1, 'function')
  assert.deepEqual(rankDefinitions([only]), [only])
})

// ---------------------------------------------------------------------------
// 0.8.0：include / 条件
// ---------------------------------------------------------------------------

test('rank: included definition outranks a closer non-included one', () => {
  const source = 'component/switch/drv/forward.c'
  const closer = 'component/switch/drv/deep/skb.h'
  const included = 'datapath/kernel/inc/skb.h'
  const entries = [entry(closer, 10), entry(included, 20)]
  const context = { sourceFile: source, roots: ['.'] }

  // 无表时保持 0.7.0：路径更近的 closer 优先
  assert.equal(rankDefinitions(entries, context)[0]?.file, closer)

  // 有表且源文件直接包含 included：include 键优先级最高
  const table = makeTable([source, closer, included], entries, new Map([[source, [included]]]))
  assert.equal(rankDefinitions(entries, { ...context, table })[0]?.file, included)
})

test('rank: definition in the source file counts as included without an include edge', () => {
  const source = 'component/switch/drv/forward.c'
  const sameFile = entry(source, 10, 'macro', 'fwd_start')
  const otherFile = entry('component/switch/drv/fwd.h', 20, 'struct', 'fwd_start')
  const entries = [sameFile, otherFile]
  const context = { sourceFile: source, roots: ['component/switch'] }

  // 无表：kind 顺序让 struct 胜出
  assert.equal(rankDefinitions(entries, context)[0], otherFile)

  // 有表但没有任何 include 边：同文件定义仍算 included（sourceFile === entry.file）
  const table = makeTable([source, otherFile.file], entries)
  assert.equal(rankDefinitions(entries, { ...context, table })[0], sameFile)
})

test('rank: unconditional definition breaks an exact location tie', () => {
  const conditional = entry(SWITCH, 10, 'struct', 'sk_buff', '#ifdef RTK_MODULE')
  const plain = entry(SWITCH, 10)
  const context = { sourceFile: 'component/switch/drv/forward.c', roots: ['component/switch'] }

  // 除条件外所有键都相同：无条件的排前面（不受输入顺序影响）
  assert.deepEqual(rankDefinitions([conditional, plain], context), [plain, conditional])
  assert.deepEqual(rankDefinitions([plain, conditional], context), [plain, conditional])
})

test('rank: unconditional definition beats a conditional one in a cross-file same layer', () => {
  // 同一层（同 root / 同前缀 / 同 kind / 都是头文件 / 同深度 / 同长度），只有文件与行号
  // 不同：条件键必须在 file/line 稳定性键之前，因此无条件的 b.h 排在条件 a.h 前面。
  const conditional = entry('component/switch/drv/a.h', 10, 'struct', 'sk_buff', '#ifdef RTK_MODULE')
  const plain = entry('component/switch/drv/b.h', 20)
  const context = { sourceFile: 'component/switch/drv/forward.c', roots: ['component/switch'] }

  assert.deepEqual(rankDefinitions([conditional, plain], context), [plain, conditional])
  assert.deepEqual(rankDefinitions([plain, conditional], context), [plain, conditional])
})

test('rank: conditional info never outranks path proximity', () => {
  const nearConditional = entry(
    'component/switch/drv/skb.h',
    10,
    'struct',
    'sk_buff',
    '#ifdef RTK_MODULE',
  )
  const farPlain = entry('component/switch/other/deep/skb.h', 20)
  const ranked = rankDefinitions([farPlain, nearConditional], {
    sourceFile: 'component/switch/drv/forward.c',
    roots: ['component/switch'],
  })
  assert.equal(ranked[0], nearConditional, 'condition is only a same-layer tie-break')
})

test('rank: no table keeps the 0.7.0 ordering', () => {
  const nearConditional = entry(
    'component/switch/drv/skb.h',
    10,
    'struct',
    'sk_buff',
    '#ifdef RTK_MODULE',
  )
  const sameRootOther = entry('component/switch/drv/other/skb.h', 20)
  const otherRoot = entry(KERNEL, 30)
  const entries = [otherRoot, sameRootOther, nearConditional]
  const context = { sourceFile: 'component/switch/drv/forward.c', roots: ['component/switch', 'datapath/kernel'] }

  const withoutTable = rankDefinitions(entries, context)
  const expected = [nearConditional.file, sameRootOther.file, KERNEL]
  assert.deepEqual(
    withoutTable.map((item) => item.file),
    expected,
  )
  // 显式 table: undefined 与「没有 table」等价（无表路径不引入新键改变既有排序）：
  // 直接断言实际排序结果，而不是把同一个调用和自己比较。
  assert.deepEqual(
    rankDefinitions(entries, { ...context, table: undefined }).map((item) => item.file),
    expected,
  )
})
