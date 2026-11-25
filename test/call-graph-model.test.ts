import test from 'node:test'
import assert from 'node:assert/strict'

import { CallGraphModel, MAX_CHILDREN, nodeIdOf } from '../src/vscode/call-graph-model'
import type { SymbolEntry } from '../src/shared/types'

function entry(name: string, line: number, file = 'src/main.c'): SymbolEntry {
  return { name, kind: 'function', file, line, endLine: line + 1, column: 4 }
}

test('call graph: root, expand callees and callers, dedupe by file:line:name', () => {
  const model = new CallGraphModel()
  model.setRoot(entry('root_fn', 10))
  assert.equal(model.nodeCount, 1)

  const addedCallees = model.mergeNeighbors(nodeIdOf(entry('root_fn', 10)), 'callees', [
    entry('a', 20),
    entry('b', 30),
    entry('a', 20),
  ])
  assert.equal(addedCallees, 2, 'duplicate callee collapsed')

  const addedCallers = model.mergeNeighbors(nodeIdOf(entry('root_fn', 10)), 'callers', [entry('caller', 5)])
  assert.equal(addedCallers, 1)

  const state = model.toState()
  assert.equal(state.nodeCount, 4)
  assert.equal(state.root?.callees.length, 2)
  assert.equal(state.root?.callers.length, 1)
  assert.equal(state.root?.expandedCallees, true)
})

test('call graph: cycles are not expanded', () => {
  const model = new CallGraphModel()
  model.setRoot(entry('a', 1))
  model.mergeNeighbors(nodeIdOf(entry('a', 1)), 'callees', [entry('b', 10)])
  model.mergeNeighbors(nodeIdOf(entry('b', 10)), 'callees', [entry('a', 1)])
  const b = model.findTree(nodeIdOf(entry('b', 10)))
  assert.deepEqual(b?.callees, [], 'back edge to the root is skipped')
})

test('call graph: collapse removes the subtree and re-allows expansion', () => {
  const model = new CallGraphModel()
  model.setRoot(entry('a', 1))
  model.mergeNeighbors(nodeIdOf(entry('a', 1)), 'callees', [entry('b', 10)])
  model.mergeNeighbors(nodeIdOf(entry('b', 10)), 'callees', [entry('c', 20)])
  assert.equal(model.nodeCount, 3)

  model.collapse(nodeIdOf(entry('b', 10)), 'callees')
  assert.equal(model.nodeCount, 2, 'collapsed subtree is forgotten')
  assert.deepEqual(model.findTree(nodeIdOf(entry('b', 10)))?.callees, [])

  // 重新展开可以再次加入 c
  const again = model.mergeNeighbors(nodeIdOf(entry('b', 10)), 'callees', [entry('c', 20)])
  assert.equal(again, 1)
})

test('call graph: per-direction child cap marks truncation', () => {
  const model = new CallGraphModel()
  model.setRoot(entry('a', 1))
  const many: SymbolEntry[] = []
  for (let i = 0; i < MAX_CHILDREN + 20; i++) many.push(entry(`fn_${i}`, 100 + i))
  model.mergeNeighbors(nodeIdOf(entry('a', 1)), 'callees', many)
  const tree = model.findTree(nodeIdOf(entry('a', 1)))
  assert.equal(tree?.callees.length, MAX_CHILDREN)
  assert.equal(tree?.truncatedCallees, true)
})

test('call graph: collapseAll collapses nested subtrees but keeps direct neighbours', () => {
  const model = new CallGraphModel()
  model.setRoot(entry('root', 1))
  model.mergeNeighbors(nodeIdOf(entry('root', 1)), 'callers', [entry('caller_a', 5), entry('caller_b', 6)])
  model.mergeNeighbors(nodeIdOf(entry('caller_a', 5)), 'callers', [entry('caller_of_a', 2)])
  model.mergeNeighbors(nodeIdOf(entry('root', 1)), 'callees', [entry('callee_a', 10)])
  model.mergeNeighbors(nodeIdOf(entry('callee_a', 10)), 'callees', [entry('deep', 20)])
  model.collapseAll()

  const state = model.toState()
  const root = model.findTree(nodeIdOf(entry('root', 1)))
  assert.equal(root?.callers.length, 2, 'root direct callers stay visible')
  assert.equal(root?.callees.length, 1, 'root direct callees stay visible')
  assert.deepEqual(model.findTree(nodeIdOf(entry('caller_a', 5)))?.callers, [])
  assert.deepEqual(model.findTree(nodeIdOf(entry('callee_a', 10)))?.callees, [])
  assert.equal(state.nodeCount, 4, 'nested nodes are forgotten')
})

test('call graph: setRoot resets the graph', () => {
  const model = new CallGraphModel()
  model.setRoot(entry('a', 1))
  model.mergeNeighbors(nodeIdOf(entry('a', 1)), 'callees', [entry('b', 10)])
  model.setRoot(entry('x', 50))
  const state = model.toState()
  assert.equal(state.nodeCount, 1)
  assert.equal(state.root?.node.name, 'x')
})
