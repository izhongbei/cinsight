import type { IndexSnapshot, SymbolEntry, SymbolKind } from '../shared/types'
import { SYMBOL_KIND_ORDER } from '../shared/types'

/**
 * 符号搜索 / 按名查找 / 按文件查询。
 *
 * 排序键（严格按计划 Task 5）：
 *   权重：完全相等(0) > 前缀(1) > 子词/驼峰(2) > 普通子串(3)
 *   同权重：kind 顺序（function→declaration→macro）、名字长度、名字、文件、行
 * 全表线性过滤 + 只对命中项排序：1M 符号表下通常 <100ms。
 */

const DEFAULT_SEARCH_LIMIT = 200

/** 0 = 完全相等，1 = 前缀，2 = 子词/驼峰，3 = 普通子串；找不到返回 undefined。 */
function matchWeight(name: string, needle: string): number | undefined {
  const lower = name.toLowerCase()
  if (lower === needle) return 0
  if (lower.startsWith(needle)) return 1

  // 子词 / 驼峰命中：needle 出现在下划线、大小写交界处。
  let from = 0
  while (from <= lower.length - needle.length) {
    const at = lower.indexOf(needle, from)
    if (at < 0) break
    if (isWordStart(name, at)) return 2
    from = at + 1
  }

  return lower.includes(needle) ? 3 : undefined
}

function isWordStart(name: string, index: number): boolean {
  if (index === 0) return true
  const prev = name[index - 1]
  const current = name[index]
  if (prev === '_') return true
  // camelCase：小写→大写
  if (isLower(prev) && isUpper(current)) return true
  // 连续大写缩写尾部（HTTPRequest → Request）
  const next = name[index + 1]
  if (isUpper(prev) && isUpper(current) && next !== undefined && isLower(next)) return true
  return false
}

function isUpper(ch: string): boolean {
  return ch >= 'A' && ch <= 'Z'
}

function isLower(ch: string): boolean {
  return ch >= 'a' && ch <= 'z'
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function compareKind(a: SymbolEntry, b: SymbolEntry): number {
  return SYMBOL_KIND_ORDER[a.kind] - SYMBOL_KIND_ORDER[b.kind]
}

function compareEntryLocation(a: SymbolEntry, b: SymbolEntry): number {
  return compareStrings(a.file, b.file) || a.line - b.line
}

export function searchSymbols(
  snapshot: IndexSnapshot,
  query: string,
  options?: { limit?: number; kinds?: readonly SymbolKind[] },
): SymbolEntry[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return []

  const limit = options?.limit ?? DEFAULT_SEARCH_LIMIT
  if (limit <= 0) return []

  const kinds = options?.kinds ? new Set<SymbolKind>(options.kinds) : undefined

  const matches: { entry: SymbolEntry; weight: number }[] = []
  for (const entry of snapshot.entries) {
    if (kinds !== undefined && !kinds.has(entry.kind)) continue
    const weight = matchWeight(entry.name, needle)
    if (weight !== undefined) matches.push({ entry, weight })
  }

  matches.sort((a, b) => {
    if (a.weight !== b.weight) return a.weight - b.weight
    const byKind = compareKind(a.entry, b.entry)
    if (byKind !== 0) return byKind
    const byLength = a.entry.name.length - b.entry.name.length
    if (byLength !== 0) return byLength
    return compareStrings(a.entry.name, b.entry.name) || compareEntryLocation(a.entry, b.entry)
  })

  const result: SymbolEntry[] = []
  const end = Math.min(limit, matches.length)
  for (let i = 0; i < end; i++) result.push(matches[i]!.entry)
  return result
}

export function findByName(snapshot: IndexSnapshot, name: string): SymbolEntry[] {
  const result: SymbolEntry[] = []
  for (const entry of snapshot.entries) {
    if (entry.name === name) result.push(entry)
  }
  result.sort((a, b) => compareKind(a, b) || compareEntryLocation(a, b))
  return result
}

export function entriesInFile(snapshot: IndexSnapshot, file: string): SymbolEntry[] {
  const result: SymbolEntry[] = []
  for (const entry of snapshot.entries) {
    if (entry.file === file) result.push(entry)
  }
  result.sort((a, b) => a.line - b.line || a.column - b.column)
  return result
}
