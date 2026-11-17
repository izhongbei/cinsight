/**
 * 调用关系图的数据模型（纯逻辑，不依赖 vscode，可单测）。
 *
 * 结构：中间是当前函数（root），左侧递归展开 callers，右侧递归展开 callees。
 * 规则：
 *  - 节点按 `file:line:name` 去重（全局 seen），天然避免环（A→B→A）；
 *  - 单方向单层最多 100 个子节点、全图最多 300 个节点，超出标记 truncated；
 *  - 展开/折叠只影响该节点的子树，已展开的其他分支保留。
 */
import type { SymbolEntry } from '../shared/types'

export type Direction = 'callers' | 'callees'

export interface GraphNode {
  readonly id: string
  readonly name: string
  readonly file: string
  readonly line: number
  readonly column: number
  readonly kind: SymbolEntry['kind']
}

export interface GraphTree {
  readonly node: GraphNode
  callers: GraphTree[]
  callees: GraphTree[]
  expandedCallers: boolean
  expandedCallees: boolean
  /** 该方向展开过但被截断（子节点过多） */
  truncatedCallers: boolean
  truncatedCallees: boolean
}

export interface CallGraphState {
  readonly root: GraphTree | null
  readonly nodeCount: number
  readonly truncated: boolean
}

export const MAX_NODES = 300
export const MAX_CHILDREN = 100

export function nodeIdOf(entry: SymbolEntry): string {
  return `${entry.file}:${entry.line}:${entry.name}`
}

export function toGraphNode(entry: SymbolEntry): GraphNode {
  return {
    id: nodeIdOf(entry),
    name: entry.name,
    file: entry.file,
    line: entry.line,
    column: entry.column,
    kind: entry.kind,
  }
}

function createTree(entry: SymbolEntry): GraphTree {
  return {
    node: toGraphNode(entry),
    callers: [],
    callees: [],
    expandedCallers: false,
    expandedCallees: false,
    truncatedCallers: false,
    truncatedCallees: false,
  }
}

export class CallGraphModel {
  private rootTree: GraphTree | null = null
  private readonly seen = new Set<string>()

  get root(): GraphTree | null {
    return this.rootTree
  }

  get nodeCount(): number {
    return this.seen.size
  }

  setRoot(entry: SymbolEntry): void {
    this.rootTree = createTree(entry)
    this.seen.clear()
    this.seen.add(this.rootTree.node.id)
  }

  findTree(id: string): GraphTree | undefined {
    if (!this.rootTree) return undefined
    const stack: GraphTree[] = [this.rootTree]
    while (stack.length > 0) {
      const current = stack.pop()!
      if (current.node.id === id) return current
      for (let i = current.callers.length - 1; i >= 0; i--) stack.push(current.callers[i]!)
      for (let i = current.callees.length - 1; i >= 0; i--) stack.push(current.callees[i]!)
    }
    return undefined
  }

  /** 把某节点在某个方向的邻居合并进图；返回新增节点数。 */
  mergeNeighbors(id: string, direction: Direction, entries: readonly SymbolEntry[]): number {
    const tree = this.findTree(id)
    if (!tree) return 0
    const target = direction === 'callers' ? tree.callers : tree.callees
    const seenInDirection = new Set(target.map((child) => child.node.id))
    const selfId = tree.node.id
    let added = 0
    let truncated = false
    for (const entry of entries) {
      const candidate = nodeIdOf(entry)
      if (candidate === selfId) continue
      if (seenInDirection.has(candidate)) continue
      if (this.seen.has(candidate)) continue
      if (target.length >= MAX_CHILDREN || this.seen.size >= MAX_NODES) {
        truncated = true
        break
      }
      this.seen.add(candidate)
      target.push(createTree(entry))
      seenInDirection.add(candidate)
      added++
    }
    if (direction === 'callers') {
      tree.expandedCallers = true
      tree.truncatedCallers = truncated
    } else {
      tree.expandedCallees = true
      tree.truncatedCallees = truncated
    }
    return added
  }

  collapse(id: string, direction: Direction): void {
    const tree = this.findTree(id)
    if (!tree) return
    if (direction === 'callers') {
      for (const child of tree.callers) this.forget(child)
      tree.callers = []
      tree.expandedCallers = false
      tree.truncatedCallers = false
    } else {
      for (const child of tree.callees) this.forget(child)
      tree.callees = []
      tree.expandedCallees = false
      tree.truncatedCallees = false
    }
  }

  private forget(tree: GraphTree): void {
    this.seen.delete(tree.node.id)
    for (const child of tree.callers) this.forget(child)
    for (const child of tree.callees) this.forget(child)
  }

  toState(): CallGraphState {
    return { root: this.rootTree, nodeCount: this.seen.size, truncated: this.seen.size >= MAX_NODES }
  }
}
