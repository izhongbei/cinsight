import type { FileRecord, SymbolEntry, SymbolTable } from '../shared/types'
import { compareStrings, compareSymbolEntries } from './symbol-order'
import { createSymbolTable } from './symbol-table'
import type { SnapshotDeltaRecord } from './snapshot-delta'

/**
 * overlay 索引：在只读的 base 符号表之上叠加「单文件变更层」。
 *
 * 设计目标：applyFile/removeFile 只处理被改文件（O(Δ)），查询时过滤掉被覆盖/删除文件
 * 的 base 条目再合并 overlay 条目；需要完整表时用 flatten() 一次性重建。
 *
 * 计数不变量：entryCount = base.entryCount - 被隐藏的 base 条目数 + overlay 条目数。
 */

export interface OverlayFileSlot {
  readonly file: FileRecord
  readonly entries: readonly SymbolEntry[]
}

export interface MutableSymbolIndex extends SymbolTable {
  readonly base: SymbolTable
  applyFile(file: FileRecord, entries: readonly SymbolEntry[]): void
  removeFile(file: string): boolean
  readonly pendingChanges: number
  pendingPaths(): string[]
  flatten(): SymbolTable
}

class MutableIndex implements MutableSymbolIndex {
  private readonly changed = new Map<string, OverlayFileSlot | 'removed'>()
  private readonly basePaths: Set<string>
  /**
   * base 中被 overlay 隐藏的条目按名字计数：用于 forEachName 过滤「条目已被全部隐藏」的名字，
   * 避免 full rebuild 才一致的语义在这里退化（只处理被改文件，保持 O(Δ)）。
   */
  private readonly hiddenBaseNameCounts = new Map<string, number>()
  private overlayEntryCount = 0
  private removedBaseEntryCount = 0
  private filesCache: readonly FileRecord[] | undefined
  private materializedCache: SymbolEntry[] | undefined

  constructor(readonly base: SymbolTable) {
    this.basePaths = new Set(base.files.map((file) => file.path))
  }

  get version(): number {
    return this.base.version
  }

  get roots(): readonly string[] {
    return this.base.roots
  }

  get builtAt(): number {
    return this.base.builtAt
  }

  get entryCount(): number {
    return this.base.entryCount - this.removedBaseEntryCount + this.overlayEntryCount
  }

  get fileCount(): number {
    return this.files.length
  }

  get pendingChanges(): number {
    return this.changed.size
  }

  get files(): readonly FileRecord[] {
    if (!this.filesCache) {
      const merged: FileRecord[] = []
      for (const file of this.base.files) {
        const slot = this.changed.get(file.path)
        if (slot === 'removed') continue
        merged.push(slot ? slot.file : file)
      }
      for (const [filePath, slot] of this.changed) {
        if (slot === 'removed' || this.basePaths.has(filePath)) continue
        merged.push(slot.file)
      }
      merged.sort((a, b) => compareStrings(a.path, b.path))
      this.filesCache = merged
    }
    return this.filesCache
  }

  /** 记录某个 base 文件被隐藏的条目名；返回被隐藏的条目数。 */
  private hideBaseEntries(filePath: string): number {
    const entries = this.base.entriesInFile(filePath)
    for (const entry of entries) {
      this.hiddenBaseNameCounts.set(entry.name, (this.hiddenBaseNameCounts.get(entry.name) ?? 0) + 1)
    }
    return entries.length
  }

  private invalidate(): void {
    this.filesCache = undefined
    this.materializedCache = undefined
  }

  applyFile(file: FileRecord, entries: readonly SymbolEntry[]): void {
    const previous = this.changed.get(file.path)
    if (previous === 'removed') {
      // base 条目在首次 remove 时已计入 removedBaseEntryCount，这里不再重复减
    } else if (previous) {
      this.overlayEntryCount -= previous.entries.length
    } else {
      this.removedBaseEntryCount += this.hideBaseEntries(file.path)
    }
    this.changed.set(file.path, { file, entries: [...entries] })
    this.overlayEntryCount += entries.length
    this.invalidate()
  }

  removeFile(file: string): boolean {
    const previous = this.changed.get(file)
    if (previous === 'removed') return false
    if (previous) {
      this.overlayEntryCount -= previous.entries.length
    } else {
      if (!this.basePaths.has(file)) return false
      this.removedBaseEntryCount += this.hideBaseEntries(file)
    }
    this.changed.set(file, 'removed')
    this.invalidate()
    return true
  }

  entriesInFile(file: string): SymbolEntry[] {
    const slot = this.changed.get(file)
    if (slot === 'removed') return []
    // 与 SymbolTableImpl.entriesInFile 保持同一顺序：行 → 列 → 名字。
    if (slot) return [...slot.entries].sort((a, b) => a.line - b.line || a.column - b.column || compareStrings(a.name, b.name))
    return this.base.entriesInFile(file)
  }

  findByName(name: string): SymbolEntry[] {
    const result: SymbolEntry[] = []
    for (const entry of this.base.findByName(name)) {
      if (this.changed.has(entry.file)) continue
      result.push(entry)
    }
    for (const slot of this.changed.values()) {
      if (slot === 'removed') continue
      for (const entry of slot.entries) if (entry.name === name) result.push(entry)
    }
    return result.sort(compareSymbolEntries)
  }

  forEachName(callback: (name: string) => void): void {
    const overlayNames = new Set<string>()
    for (const slot of this.changed.values()) {
      if (slot === 'removed') continue
      for (const entry of slot.entries) overlayNames.add(entry.name)
    }
    if (overlayNames.size === 0 && this.hiddenBaseNameCounts.size === 0) {
      this.base.forEachName(callback)
      return
    }
    const extra = [...overlayNames].sort(compareStrings)
    let extraIndex = 0
    this.base.forEachName((name) => {
      while (extraIndex < extra.length && compareStrings(extra[extraIndex]!, name) < 0) {
        callback(extra[extraIndex++]!)
      }
      const inExtra = extraIndex < extra.length && extra[extraIndex] === name
      if (inExtra) extraIndex += 1
      const hidden = this.hiddenBaseNameCounts.get(name)
      // 名字的全部 base 条目都被隐藏时，只有 overlay 同名条目能把它补回来
      if (hidden === undefined || inExtra || this.base.findByName(name).length > hidden) {
        callback(name)
      }
    })
    while (extraIndex < extra.length) callback(extra[extraIndex++]!)
  }

  forEachEntry(callback: (entry: SymbolEntry) => void): void {
    this.base.forEachEntry((entry) => {
      if (!this.changed.has(entry.file)) callback(entry)
    })
    for (const slot of this.changed.values()) {
      if (slot === 'removed') continue
      for (const entry of slot.entries) callback(entry)
    }
  }

  private materialized(): SymbolEntry[] {
    if (!this.materializedCache) {
      const result: SymbolEntry[] = []
      this.base.forEachEntry((entry) => {
        if (!this.changed.has(entry.file)) result.push(entry)
      })
      for (const slot of this.changed.values()) {
        if (slot === 'removed') continue
        for (const entry of slot.entries) result.push(entry)
      }
      this.materializedCache = result
    }
    return this.materializedCache
  }

  entryAt(index: number): SymbolEntry {
    const array = this.materialized()
    if (index < 0 || index >= array.length) {
      throw new RangeError(`symbol index out of range: ${index}`)
    }
    return array[index]!
  }

  toArray(): SymbolEntry[] {
    return [...this.materialized()]
  }

  pendingPaths(): string[] {
    return [...this.changed.keys()].sort(compareStrings)
  }

  flatten(): SymbolTable {
    return createSymbolTable(this.roots, this.files, this.toArray(), Date.now(), this.version)
  }
}

export function createMutableIndex(base: SymbolTable): MutableSymbolIndex {
  return new MutableIndex(base)
}

export function createMutableIndexFromDeltas(
  base: SymbolTable,
  records: readonly SnapshotDeltaRecord[],
): MutableSymbolIndex {
  const index = new MutableIndex(base)
  for (const record of records) {
    if (record.kind === 'remove') {
      index.removeFile(record.path)
    } else {
      index.applyFile({ path: record.path, mtimeMs: record.mtimeMs, size: record.size }, record.entries)
    }
  }
  return index
}
