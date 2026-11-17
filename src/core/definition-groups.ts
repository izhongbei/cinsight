import type { SymbolEntry, SymbolTable } from '../shared/types'
import { rankDefinitions, type RankContext } from './rank-definitions'

/**
 * 定义候选分组（0.8.0 / B2 + B4，纯逻辑，无 vscode 依赖）。
 *
 * 大仓里同一个函数/结构体有多份内核/驱动副本，内容完全相同的副本对用户没有区分意义。
 * 这里先按 `rankDefinitions` 排序，再把「同一个定义在内容相同的文件里的副本」折叠成一组：
 * 分组键同时包含文件内容哈希与符号身份（`名字 + 种类`），因此：
 *   - 内容相同但符号不同（例如同一文件里的 `struct Foo` 前置声明与定义、或
 *     `typedef struct Bar {} Bar;`）不会被折叠；
 *   - 同一文件里的同名同种类条目（退化输入）永远不会被折叠进一组（guard）；
 *   - 没有内容哈希（旧快照/未知文件/无表）时退化为按文件路径 + 身份分组。
 *
 * 组的代表是组内排名最高的副本，`included` / `conditional` 也都按代表计算；组内副本
 * 全部保留（折叠只影响展示，不丢定义）。`copies` 是组内**不同文件**的数量。
 */

export type { RankContext } from './rank-definitions'

export interface DefinitionGroup {
  /** 同内容哈希 + 同一符号身份 + 不同文件的副本，按 rank 排序 */
  readonly entries: readonly SymbolEntry[]
  /** 组内排名最高的副本（QuickPick/F12 用它定位） */
  readonly representative: SymbolEntry
  /** 代表副本是否被 sourceFile 包含（源文件自身也算包含） */
  readonly included: boolean
  /** 代表副本是否位于条件编译块（#ifdef 等）中 */
  readonly conditional: boolean
  /** 副本覆盖的不同文件数（1 = 唯一） */
  readonly copies: number
}

/** 代表副本是否对当前源文件可见（同一文件或可达 include）。 */
function isIncluded(context: RankContext, file: string): boolean {
  const sourceFile = context.sourceFile
  if (sourceFile === undefined) return false
  if (file === sourceFile) return true
  if (context.table === undefined) return false
  return context.table.isReachable(sourceFile, file)
}

/**
 * 分组键：内容哈希 + 符号身份；没有哈希时按文件路径 + 符号身份。
 * 哈希的 lo/hi 与 kind 都是无 `:` 的整数/枚举字面量，两段各自无歧义。
 */
function groupKey(entry: SymbolEntry, table: SymbolTable | undefined): string {
  const hash = table?.contentHashOf(entry.file)
  const identity = `${entry.name}:${entry.kind}`
  return hash ? `${hash.lo}:${hash.hi}:${identity}` : `file:${entry.file}:${identity}`
}

interface PendingGroup {
  readonly entries: SymbolEntry[]
}

/** 折叠结果 -> 对外 DefinitionGroup（代表 = 组内排名最高者）。 */
function toDefinitionGroup(context: RankContext, pending: PendingGroup): DefinitionGroup {
  const representative: SymbolEntry = pending.entries[0]!
  return {
    entries: pending.entries,
    representative,
    included: isIncluded(context, representative.file),
    conditional: Boolean(representative.condition),
    copies: new Set(pending.entries.map((entry) => entry.file)).size,
  }
}

/**
 * 排序 + 按内容哈希/符号身份分组。组顺序 = 代表副本的排名顺序。
 *
 * 同一文件的两个条目绝不进入同一组（即使内容哈希与符号身份都相同）：`copies` 语义是
 * 「内容相同的不同文件数」，同一文件内的重复条目不是副本，不能虚增计数。
 */
export function groupDefinitions(
  entries: readonly SymbolEntry[],
  context: RankContext,
): DefinitionGroup[] {
  const ranked = rankDefinitions(entries, context)
  // 同一分组键下可能有多个组（同一文件的退化重复只靠 guard 分开），用桶做查找。
  const buckets = new Map<string, PendingGroup[]>()
  // 组在首次创建时按 rank 递增追加，因此 groups 的顺序就是代表副本的排名顺序。
  const groups: PendingGroup[] = []
  for (const entry of ranked) {
    const key = groupKey(entry, context.table)
    let bucket = buckets.get(key)
    if (bucket === undefined) {
      bucket = []
      buckets.set(key, bucket)
    }
    // guard：选择第一个「尚未包含该文件」的组；没有则新开一组。
    let target = bucket.find((group) =>
      group.entries.every((item) => item.file !== entry.file),
    )
    if (target === undefined) {
      target = { entries: [] }
      bucket.push(target)
      groups.push(target)
    }
    target.entries.push(entry)
  }
  return groups.map((group) => toDefinitionGroup(context, group))
}

/**
 * QuickPick / Hover 复用的纯文本标签：`name  ·  included  ·  3 copies  ·  #ifdef FOO`。
 * 缺省部分直接省略（唯一且无条件时只剩名字）；空条件文本视为没有条件，不产生分隔符。
 */
export function formatDefinitionLabel(group: DefinitionGroup): string {
  const parts = [group.representative.name]
  if (group.included) parts.push('included')
  if (group.copies > 1) parts.push(`${group.copies} copies`)
  if (group.conditional) {
    const condition = group.representative.condition
    if (condition === undefined) {
      // 防御外部构造的 group：conditional 为 true 但条件文本缺失
      parts.push('conditional')
    } else if (condition !== '') {
      parts.push(condition)
    }
  }
  return parts.join('  ·  ')
}
