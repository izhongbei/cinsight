import type { SymbolEntry, SymbolKind, SymbolTable } from '../shared/types'
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
export function searchSymbols(
  table: SymbolTable,
  query: string,
  options: { limit?: number; kinds?: readonly SymbolKind[] } = {},
): SymbolEntry[] {
  const trimmed = query.trim()
  if (trimmed.length === 0) return []
  const lowerQuery = trimmed.toLowerCase()
  const limit = Math.max(0, options.limit ?? DEFAULT_SEARCH_LIMIT)
  if (limit === 0) return []
  const kinds = options.kinds && options.kinds.length > 0 ? new Set(options.kinds) : undefined
  const matches: Array<{ entry: SymbolEntry; weight: number }> = []
  const candidateCap = limit * 40

  table.forEachName((name, start, end) => {
    if (matches.length >= candidateCap) return
    const weight = nameWeight(name, lowerQuery)
    if (weight < 0) return
    for (let index = start; index < end && matches.length < candidateCap; index++) {
      const entry = table.entryAt(index)
      if (kinds && !kinds.has(entry.kind)) continue
      matches.push({ entry, weight })
    }
  })

  matches.sort((a, b) => {
    if (a.weight !== b.weight) return a.weight - b.weight
    const kindCompare = compareEntries(a.entry, b.entry)
    if (kindCompare !== 0) return kindCompare
    return compareStrings(a.entry.name, b.entry.name)
  })
  return matches.slice(0, limit).map((item) => item.entry)
}

/** 0=完全相等，1=前缀，2=子词/驼峰，3=子串，-1=不匹配。 */
function nameWeight(name: string, lowerQuery: string): number {
  const lowerName = name.toLowerCase()
  if (lowerName === lowerQuery) return 0
  if (lowerName.startsWith(lowerQuery)) return 1
  // 先做便宜的 includes 预筛，命中后才计算子词/驼峰（1.5M 符号下差别明显）
  if (!lowerName.includes(lowerQuery)) return -1
  if (isSubwordMatch(name, lowerName, lowerQuery)) return 2
  return 3
}

function isSubwordMatch(name: string, lowerName: string, lowerQuery: string): boolean {
  const parts = lowerName.split(/[^a-z0-9]+/).filter((part) => part.length > 0)
  if (parts.some((part) => part.startsWith(lowerQuery))) return true
  const camel = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  return camel.split(/[^a-z0-9]+/).some((part) => part.startsWith(lowerQuery))
}

export function findByName(table: SymbolTable, name: string): SymbolEntry[] {
  if (name.length === 0) return []
  return table.findByName(name).sort(compareEntries)
}

export function entriesInFile(table: SymbolTable, file: string): SymbolEntry[] {
  if (file.length === 0) return []
  return table.entriesInFile(file)
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 种类顺序 -> 文件 -> 行 -> 列 -> 名字（与 v1 行为一致）。 */
function compareEntries(a: SymbolEntry, b: SymbolEntry): number {
  const kindOrder = SYMBOL_KIND_ORDER[a.kind] - SYMBOL_KIND_ORDER[b.kind]
  if (kindOrder !== 0) return kindOrder
  if (a.name.length !== b.name.length) return a.name.length - b.name.length
  if (a.name !== b.name) return compareStrings(a.name, b.name)
  if (a.file !== b.file) return compareStrings(a.file, b.file)
  if (a.line !== b.line) return a.line - b.line
  if (a.column !== b.column) return a.column - b.column
  if (a.endLine !== b.endLine) return a.endLine - b.endLine
  return compareStrings(a.name, b.name)
}
