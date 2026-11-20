/**
 * B3 Task 4：大纲嵌套纯函数（`src/core/outline.ts`）。
 *
 * 规则（设计 §3.7）：struct/union/enum 是容器；member/enumConstant 挂到行区间包含
 * 它的最内层容器；匹配不到区间时按 `entry.parent` 名字兜底；仍无法归属的条目留顶层。
 */
import { test } from 'node:test'
import * as assert from 'node:assert/strict'

import { buildOutlineTree, type OutlineNode } from '../src/core/outline'
import type { SymbolEntry, SymbolKind } from '../src/shared/types'

function entry(
  name: string,
  kind: SymbolKind,
  line: number,
  endLine = line,
  parent?: string,
): SymbolEntry {
  const base: SymbolEntry = { name, kind, file: 'inc/a.h', line, endLine, column: 0 }
  return parent === undefined ? base : { ...base, parent }
}

function names(nodes: readonly OutlineNode[]): string[] {
  return nodes.map((node) => node.entry.name)
}

function childrenOf(nodes: readonly OutlineNode[], name: string): string[] {
  const node = nodes.find((candidate) => candidate.entry.name === name)
  assert.ok(node, `outline node ${name} should exist`)
  return names(node.children)
}

test('buildOutlineTree: nests struct members and enum constants', () => {
  const tree = buildOutlineTree([
    entry('sk_buff', 'struct', 0, 3),
    entry('len', 'member', 1, 1, 'sk_buff'),
    entry('data', 'member', 2, 2, 'sk_buff'),
    entry('E', 'enum', 5, 7),
    entry('E_A', 'enumConstant', 6, 6, 'E'),
    entry('g', 'variable', 9),
    entry('f', 'function', 11),
  ])
  assert.deepEqual(names(tree), ['sk_buff', 'E', 'g', 'f'])
  assert.deepEqual(childrenOf(tree, 'sk_buff'), ['len', 'data'])
  assert.deepEqual(childrenOf(tree, 'E'), ['E_A'])
  assert.deepEqual(childrenOf(tree, 'g'), [])
})

test('buildOutlineTree: picks the innermost containing type', () => {
  const tree = buildOutlineTree([
    entry('outer', 'struct', 0, 20),
    entry('inner', 'struct', 5, 10),
    entry('inner_member', 'member', 7, 7, 'outer'), // 行区间更精确地落在 inner 内
    entry('outer_member', 'member', 15, 15, 'outer'),
  ])
  // 类型自身始终留在顶层（嵌套类型不折叠进外层类型）
  assert.deepEqual(names(tree), ['outer', 'inner'])
  assert.deepEqual(childrenOf(tree, 'outer'), ['outer_member'])
  assert.deepEqual(childrenOf(tree, 'inner'), ['inner_member'])
})

test('buildOutlineTree: falls back to the parent name when no range contains it', () => {
  const tree = buildOutlineTree([
    entry('sk_buff', 'struct', 0, 2),
    entry('len', 'member', 10, 10, 'sk_buff'),
  ])
  assert.deepEqual(names(tree), ['sk_buff'])
  assert.deepEqual(childrenOf(tree, 'sk_buff'), ['len'])
})

test('buildOutlineTree: unattachable symbols stay at the top level', () => {
  const tree = buildOutlineTree([
    entry('orphan', 'member', 0, 0, 'missing'),
    entry('anonymous_member', 'member', 1, 1),
    entry('E_A', 'enumConstant', 2, 2),
  ])
  assert.deepEqual(names(tree), ['orphan', 'anonymous_member', 'E_A'])
})

test('buildOutlineTree: globals and functions stay top level inside a type range', () => {
  const tree = buildOutlineTree([
    entry('s', 'struct', 0, 10),
    entry('g', 'variable', 3, 3),
    entry('f', 'function', 11, 12),
  ])
  assert.deepEqual(names(tree), ['s', 'g', 'f'])
  assert.deepEqual(childrenOf(tree, 's'), [])
})

test('buildOutlineTree: typedef alias is a fallback parent for anonymous type bodies', () => {
  const tree = buildOutlineTree([
    entry('foo_t', 'typedef', 0, 3),
    entry('a', 'member', 1, 1, 'foo_t'),
  ])
  assert.deepEqual(names(tree), ['foo_t'])
  assert.deepEqual(childrenOf(tree, 'foo_t'), ['a'])
})

test('buildOutlineTree: same-name types in one file are matched by range', () => {
  const tree = buildOutlineTree([
    entry('s', 'struct', 0, 3),
    entry('s', 'struct', 10, 13),
    entry('a', 'member', 11, 11, 's'),
  ])
  assert.deepEqual(names(tree), ['s', 's'])
  // 成员按行区间归到第二个同名类型下，第一个同名类型没有子节点
  assert.deepEqual(childrenOf(tree, 's'), [])
  const second = tree[1]
  assert.ok(second)
  assert.deepEqual(second.children.map((node) => node.entry.name), ['a'])
})

test('buildOutlineTree: same-line type definitions nest by parent name, not file order', () => {
  const tree = buildOutlineTree([
    entry('foo', 'struct', 0, 0),
    entry('a', 'member', 0, 0, 'foo'),
    entry('bar', 'struct', 0, 0),
    entry('b', 'member', 0, 0, 'bar'),
  ])
  assert.deepEqual(names(tree), ['foo', 'bar'])
  assert.deepEqual(childrenOf(tree, 'foo'), ['a'])
  // 区间跨度/起点都相同：必须按 child.parent 归到 bar，而不是文件里先出现的 foo
  assert.deepEqual(childrenOf(tree, 'bar'), ['b'])
})

test('buildOutlineTree: empty input yields an empty outline', () => {
  assert.deepEqual(buildOutlineTree([]), [])
})
