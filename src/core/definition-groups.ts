import type { SymbolEntry, SymbolTable } from '../shared/types'
import { rankDefinitions } from '../vscode/rank-definitions'

/**
 * 定义候选分组（0.8.0 / B2 + B4，纯逻辑，无 vscode 依赖）。
 *
 * 大仓里同一个函数/结构体有多份内核/驱动副本，内容完全相同的副本对用户没有区分意义。
 * 这里先按 `rankDefinitions` 排序，再按「文件内容哈希（lo:hi）」把内容相同的副本折叠成
 * 一组：组的代表就是排名最高的副本，`included` / `conditional` 也都按代表计算；组内副本
 * 全部保留（折叠只影响展示，不丢定义）。
 *
 * 没有内容哈希（旧快照/未知文件/无表）时退化为「按文件路径」分组，语义与 0.7.0 一致。
 */

/**
 * 分组/排序上下文。
 *
 * 注意：`rankDefinitions` 自己的 `RankContext` 允许省略 `roots`（无上下文排序），这里
 * 要求显式给出（分组总是发生在有配置上下文的 UI 路径上）。
 */
export interface RankContext {
  /** 光标所在文件的 workspace 相对 posix 路径 */
  readonly sourceFile?: string
  /** 配置的索引根（workspace 相对 posix 路径） */
  readonly roots: readonly string[]
  /** 符号表（include 图 / 内容哈希）；缺省时不做 include 加权、按文件分组 */
  readonly table?: SymbolTable
}

export interface DefinitionGroup {
  /** 同内容哈希的副本，按 rank 排序 */
  readonly entries: readonly SymbolEntry[]
  /** 组内排名最高的副本（QuickPick/F12 用它定位） */
  readonly representative: SymbolEntry
  /** 代表副本是否被 sourceFile 包含（源文件自身也算包含） */
  readonly included: boolean
  /** 代表副本是否位于条件编译块（#ifdef 等）中 */
  readonly conditional: boolean
  /** 内容相同的副本数（1 = 唯一） */
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
 * 分组键：内容哈希相同 → 同一组；没有哈希 → 按文件路径，避免把不同内容的文件错误折叠。
 * 哈希的 lo/hi 拼成字符串（两段各自无 `:`，不存在歧义）。
 */
function groupKey(entry: SymbolEntry, table: SymbolTable | undefined): string {
  const hash = table?.contentHashOf(entry.file)
  return hash ? `${hash.lo}:${hash.hi}` : `file:${entry.file}`
}

/**
 * 排序 + 按内容哈希分组。组顺序 = 代表副本的排名顺序（Map 保持首次插入顺序）。
 */
export function groupDefinitions(
  entries: readonly SymbolEntry[],
  context: RankContext,
): DefinitionGroup[] {
  const ranked = rankDefinitions(entries, context)
  const groups = new Map<string, SymbolEntry[]>()
  for (const entry of ranked) {
    const key = groupKey(entry, context.table)
    const list = groups.get(key)
    if (list) list.push(entry)
    else groups.set(key, [entry])
  }
  return [...groups.values()].map((groupEntries) => {
    const representative: SymbolEntry = groupEntries[0]!
    return {
      entries: groupEntries,
      representative,
      included: isIncluded(context, representative.file),
      conditional: Boolean(representative.condition),
      copies: groupEntries.length,
    }
  })
}

/**
 * QuickPick / Hover 复用的纯文本标签：`name  ·  included  ·  3 copies  ·  #ifdef FOO`。
 * 缺省部分直接省略（唯一且无条件时只剩名字）。
 */
export function formatDefinitionLabel(group: DefinitionGroup): string {
  const parts = [group.representative.name]
  if (group.included) parts.push('included')
  if (group.copies > 1) parts.push(`${group.copies} copies`)
  if (group.conditional) parts.push(group.representative.condition ?? 'conditional')
  return parts.join('  ·  ')
}
