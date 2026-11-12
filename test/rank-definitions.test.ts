/**
 * 定义候选排序：同一个名字有多份定义时，离光标最近的排在前面。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { rankDefinitions } from '../src/vscode/rank-definitions'
import type { SymbolEntry, SymbolKind } from '../src/shared/types'

function entry(
  file: string,
  line: number,
  kind: SymbolKind = 'struct',
  name = 'sk_buff',
): SymbolEntry {
  return { name, kind, file, line, endLine: line, column: 0 }
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
