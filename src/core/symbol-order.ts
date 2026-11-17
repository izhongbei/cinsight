import { SYMBOL_KIND_ORDER } from '../shared/types'
import type { SymbolEntry } from '../shared/types'

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 与 v1 行为一致：kind 顺序 → 名字长度 → 名字 → 文件 → 行 → 列 → 结束行。 */
export function compareSymbolEntries(a: SymbolEntry, b: SymbolEntry): number {
  const kindOrder = SYMBOL_KIND_ORDER[a.kind] - SYMBOL_KIND_ORDER[b.kind]
  if (kindOrder !== 0) return kindOrder
  if (a.name.length !== b.name.length) return a.name.length - b.name.length
  if (a.name !== b.name) return compareStrings(a.name, b.name)
  if (a.file !== b.file) return compareStrings(a.file, b.file)
  if (a.line !== b.line) return a.line - b.line
  if (a.column !== b.column) return a.column - b.column
  return a.endLine - b.endLine
}
