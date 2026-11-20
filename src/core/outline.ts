/**
 * 大纲嵌套（B3 §3.7）：纯函数，便于单测；`providers/document-symbol.ts` 只负责转成
 * `vscode.DocumentSymbol`。
 *
 * 规则：
 *  - `struct`/`union`/`enum` 是可归属容器（类型自身始终留在顶层，嵌套类型不折叠）；
 *  - `member`/`enumConstant` 挂到**行区间包含它**的最内层容器下（同文件多个同名类型
 *    因此按行区间各归各的）；
 *  - 行区间匹配不到时按 `entry.parent` 名字兜底（也接受 typedef 别名：匿名类型体
 *    `typedef struct { ... } foo_t;` 的成员 parent 就是别名）；
 *  - 仍然无法归属的成员/常量，以及全局变量等其他符号，一律留在顶层。
 */
import type { SymbolEntry } from '../shared/types'

export interface OutlineNode {
  readonly entry: SymbolEntry
  readonly children: readonly OutlineNode[]
}

/** 行区间归属只看具名类型体。 */
const CONTAINER_KINDS = new Set<SymbolEntry['kind']>(['struct', 'union', 'enum'])

/** 名字兜底额外接受 typedef（匿名类型体成员 parent = 别名）。 */
const NAME_PARENT_KINDS = new Set<SymbolEntry['kind']>(['struct', 'union', 'enum', 'typedef'])

/** 只有这两类符号会被嵌套，其余符号始终是顶层节点。 */
const CHILD_KINDS = new Set<SymbolEntry['kind']>(['member', 'enumConstant'])

interface MutableNode {
  readonly entry: SymbolEntry
  readonly children: MutableNode[]
}

function spanOf(entry: SymbolEntry): number {
  return Math.max(0, entry.endLine - entry.line)
}

/**
 * 包含 child 的最内层容器。
 *
 * 先比区间跨度（最小者最内层）。跨度相同时（典型：同一行定义多个类型，
 * `struct foo { int a; }; struct bar { int b; };`）不能只按文件顺序：
 * 优先取名字等于 `child.parent` 的容器，其次取起点离 child 最近的前置容器，
 * 最后才按文件顺序（保持稳定）。
 */
function innermostContainer(
  child: SymbolEntry,
  containers: readonly SymbolEntry[],
): SymbolEntry | undefined {
  let best: SymbolEntry | undefined
  let bestSpan = Number.POSITIVE_INFINITY
  for (const container of containers) {
    if (container.line > child.line || child.endLine > container.endLine) {
      continue
    }
    const span = spanOf(container)
    if (best === undefined || span < bestSpan) {
      best = container
      bestSpan = span
      continue
    }
    if (span > bestSpan) {
      continue
    }
    // 同跨度：名字与 parent 一致者优先（v5 同文件同名类型也能各归各的）。
    const named = child.parent !== undefined && container.name === child.parent
    const bestNamed = child.parent !== undefined && best.name === child.parent
    if (named !== bestNamed) {
      if (named) {
        best = container
      }
      continue
    }
    // 再按「最近的前置起点」；起点也相同则保持文件顺序。
    if (container.line > best.line) {
      best = container
    }
  }
  return best
}

/** 行区间匹配不到时按 parent 名字兜底：优先取 child 之前最近的一个同名类型。 */
function parentByName(
  child: SymbolEntry,
  candidates: readonly SymbolEntry[],
): SymbolEntry | undefined {
  if (!child.parent) {
    return undefined
  }
  const named = candidates.filter((candidate) => candidate.name === child.parent)
  if (named.length === 0) {
    return undefined
  }
  let best: SymbolEntry | undefined
  for (const candidate of named) {
    if (candidate.line <= child.line && (!best || candidate.line > best.line)) {
      best = candidate
    }
  }
  return best ?? named[0]
}

export function buildOutlineTree(entries: readonly SymbolEntry[]): OutlineNode[] {
  const containers = entries.filter((entry) => CONTAINER_KINDS.has(entry.kind))
  const nameParents = entries.filter((entry) => NAME_PARENT_KINDS.has(entry.kind))

  const nodes = new Map<SymbolEntry, MutableNode>()
  for (const entry of entries) {
    nodes.set(entry, { entry, children: [] })
  }

  // 先算归属再挂接：不依赖父类型在 entries 中出现的先后顺序。
  const parentOf = new Map<SymbolEntry, SymbolEntry>()
  for (const entry of entries) {
    if (!CHILD_KINDS.has(entry.kind)) {
      continue
    }
    const parent = innermostContainer(entry, containers) ?? parentByName(entry, nameParents)
    if (parent) {
      parentOf.set(entry, parent)
    }
  }

  const roots: MutableNode[] = []
  for (const entry of entries) {
    const node = nodes.get(entry)
    if (!node) {
      continue
    }
    const parent = parentOf.get(entry)
    const parentNode = parent ? nodes.get(parent) : undefined
    if (parentNode) {
      parentNode.children.push(node)
      continue
    }
    roots.push(node)
  }
  return roots
}
