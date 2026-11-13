import type { FileRecord, SymbolEntry, SymbolKind, SymbolTable } from '../shared/types'

/**
 * 列式符号表实现：
 *   - 字符串表：文件路径、符号名（去重）
 *   - 列数组：nameId / fileIdx / line / endLine / column / kind（TypedArray）
 *   - nameOffsets：按名字排序后每个名字的条目区间（findByName 二分）
 *   - fileEntryOffsets/fileEntryIndexes：按文件分组的条目索引（entriesInFile 直接切片）
 *
 * 相比对象数组（149 万 × 约 150B），这里每符号约 19B + 字符串表，实测启发式降到 1/4 以下。
 */

export const KIND_CODES: Record<SymbolKind, number> = {
  function: 0,
  declaration: 1,
  macro: 2,
  struct: 3,
  union: 4,
  enum: 5,
  typedef: 6,
}

const KIND_NAMES: readonly SymbolKind[] = [
  'function',
  'declaration',
  'macro',
  'struct',
  'union',
  'enum',
  'typedef',
]

export interface SymbolTableColumns {
  readonly names: readonly string[]
  readonly nameOffsets: Uint32Array
  readonly nameIds: Uint32Array
  readonly fileIndexes: Uint32Array
  readonly lines: Uint32Array
  readonly endLines: Uint32Array
  readonly columns: Uint16Array
  readonly kinds: Uint8Array
  readonly fileEntryOffsets: Uint32Array
  readonly fileEntryIndexes: Uint32Array
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 在升序字符串表中二分查找。 */
function binarySearchString(values: readonly string[], target: string): number {
  let low = 0
  let high = values.length - 1
  while (low <= high) {
    const mid = (low + high) >>> 1
    const cmp = compareStrings(values[mid]!, target)
    if (cmp === 0) return mid
    if (cmp < 0) low = mid + 1
    else high = mid - 1
  }
  return -1
}

class SymbolTableImpl implements SymbolTable {
  readonly version: number
  readonly roots: readonly string[]
  readonly builtAt: number
  readonly files: readonly FileRecord[]
  readonly entryCount: number
  readonly fileCount: number
  readonly columns: SymbolTableColumns

  private readonly fileIndexByPath: Map<string, number>

  constructor(options: {
    version: number
    roots: readonly string[]
    builtAt: number
    files: readonly FileRecord[]
    columns: SymbolTableColumns
  }) {
    this.version = options.version
    this.roots = options.roots
    this.builtAt = options.builtAt
    this.files = options.files
    this.columns = options.columns
    this.entryCount = options.columns.nameIds.length
    this.fileCount = options.files.length
    this.fileIndexByPath = new Map(options.files.map((file, index) => [file.path, index]))
  }

  entryAt(index: number): SymbolEntry {
    if (index < 0 || index >= this.entryCount) {
      throw new RangeError(`symbol index out of range: ${index}`)
    }
    const columns = this.columns
    const fileIndex = columns.fileIndexes[index]!
    return {
      name: this.nameAt(index),
      kind: KIND_NAMES[columns.kinds[index]!] ?? 'function',
      file: this.files[fileIndex]?.path ?? '',
      line: columns.lines[index]!,
      endLine: columns.endLines[index]!,
      column: columns.columns[index]!,
    }
  }

  private nameAt(entryIndex: number): string {
    const columns = this.columns
    const nameId = columns.nameIds[entryIndex]!
    return columns.names[nameId] ?? ''
  }

  findByName(name: string): SymbolEntry[] {
    const columns = this.columns
    const nameId = binarySearchString(columns.names, name)
    if (nameId < 0) return []
    const start = columns.nameOffsets[nameId]!
    const end = columns.nameOffsets[nameId + 1]!
    const result: SymbolEntry[] = []
    for (let index = start; index < end; index++) result.push(this.entryAt(index))
    return result
  }

  entriesInFile(file: string): SymbolEntry[] {
    const fileIndex = this.fileIndexByPath.get(file)
    if (fileIndex === undefined) return []
    const columns = this.columns
    const start = columns.fileEntryOffsets[fileIndex]!
    const end = columns.fileEntryOffsets[fileIndex + 1]!
    const result: SymbolEntry[] = []
    for (let i = start; i < end; i++) {
      const entryIndex = columns.fileEntryIndexes[i]!
      result.push(this.entryAt(entryIndex))
    }
    result.sort((a, b) => a.line - b.line || a.column - b.column || compareStrings(a.name, b.name))
    return result
  }

  forEachEntry(callback: (entry: SymbolEntry) => void): void {
    for (let index = 0; index < this.entryCount; index++) callback(this.entryAt(index))
  }

  forEachName(callback: (name: string, start: number, end: number) => void): void {
    const columns = this.columns
    for (let nameId = 0; nameId < columns.names.length; nameId++) {
      const start = columns.nameOffsets[nameId]!
      const end = columns.nameOffsets[nameId + 1]!
      if (start === end) continue
      callback(columns.names[nameId]!, start, end)
    }
  }

  toArray(): SymbolEntry[] {
    const result: SymbolEntry[] = new Array(this.entryCount)
    for (let index = 0; index < this.entryCount; index++) result[index] = this.entryAt(index)
    return result
  }
}

/** 从对象条目构建列式符号表（构建期/测试用）。 */
export function createSymbolTable(
  roots: readonly string[],
  files: readonly FileRecord[],
  entries: readonly SymbolEntry[],
  builtAt: number,
  version: number,
): SymbolTable {
  const sortedFiles = [...files].sort((a, b) => compareStrings(a.path, b.path))
  const fileIndexByPath = new Map(sortedFiles.map((file, index) => [file.path, index]))

  const names = Array.from(new Set(entries.map((entry) => entry.name))).sort(compareStrings)
  const nameIdByName = new Map(names.map((name, index) => [name, index]))

  const ordered = entries
    .map((entry) => ({
      entry,
      nameId: nameIdByName.get(entry.name) ?? 0,
      fileIndex: fileIndexByPath.get(entry.file) ?? 0,
    }))
    .sort(
      (a, b) =>
        a.nameId - b.nameId ||
        a.fileIndex - b.fileIndex ||
        a.entry.line - b.entry.line ||
        a.entry.column - b.entry.column ||
        a.entry.endLine - b.entry.endLine,
    )

  const entryCount = ordered.length
  const nameIds = new Uint32Array(entryCount)
  const fileIndexes = new Uint32Array(entryCount)
  const lines = new Uint32Array(entryCount)
  const endLines = new Uint32Array(entryCount)
  const columns = new Uint16Array(entryCount)
  const kinds = new Uint8Array(entryCount)

  const nameOffsets = new Uint32Array(names.length + 1)
  const fileCounts = new Uint32Array(Math.max(sortedFiles.length, 1))

  for (let index = 0; index < entryCount; index++) {
    const item = ordered[index]!
    nameIds[index] = item.nameId
    fileIndexes[index] = item.fileIndex
    lines[index] = item.entry.line
    endLines[index] = item.entry.endLine
    columns[index] = Math.min(item.entry.column, 0xffff)
    kinds[index] = KIND_CODES[item.entry.kind] ?? 0
    nameOffsets[item.nameId] = nameOffsets[item.nameId]! + 1
    fileCounts[item.fileIndex] = fileCounts[item.fileIndex]! + 1
  }
  // nameOffsets 计数 -> 偏移
  let running = 0
  for (let nameId = 0; nameId <= names.length; nameId++) {
    const count = nameOffsets[nameId]!
    nameOffsets[nameId] = running
    running += count
  }
  // 上面循环会把最后一个位置写成 running；修正为条目总数
  nameOffsets[names.length] = entryCount

  // fileEntryOffsets/fileEntryIndexes：按 (line, column) 排好
  const fileEntryOffsets = new Uint32Array(sortedFiles.length + 1)
  let fileTotal = 0
  for (let fileIndex = 0; fileIndex < sortedFiles.length; fileIndex++) {
    fileEntryOffsets[fileIndex] = fileTotal
    fileTotal += fileCounts[fileIndex]!
  }
  fileEntryOffsets[sortedFiles.length] = fileTotal

  const fileEntryIndexes = new Uint32Array(entryCount)
  const fileCursors = new Uint32Array(sortedFiles.length)
  for (let fileIndex = 0; fileIndex < sortedFiles.length; fileIndex++) {
    fileCursors[fileIndex] = fileEntryOffsets[fileIndex]!
  }
  const fileOrdered: number[][] = Array.from({ length: sortedFiles.length }, () => [])
  for (let index = 0; index < entryCount; index++) {
    fileOrdered[fileIndexes[index]!]!.push(index)
  }
  for (let fileIndex = 0; fileIndex < sortedFiles.length; fileIndex++) {
    const list = fileOrdered[fileIndex]!
    list.sort(
      (a, b) =>
        lines[a]! - lines[b]! || columns[a]! - columns[b]! || nameIds[a]! - nameIds[b]!,
    )
    for (const entryIndex of list) {
      fileEntryIndexes[fileCursors[fileIndex]!] = entryIndex
      fileCursors[fileIndex] = fileCursors[fileIndex]! + 1
    }
  }

  return new SymbolTableImpl({
    version,
    roots: [...roots],
    builtAt,
    files: sortedFiles,
    columns: {
      names,
      nameOffsets,
      nameIds,
      fileIndexes,
      lines,
      endLines,
      columns,
      kinds,
      fileEntryOffsets,
      fileEntryIndexes,
    },
  })
}

/** 从列数组直接恢复（快照解码路径，零对象分配）。 */
export function symbolTableFromColumns(options: {
  version: number
  roots: readonly string[]
  builtAt: number
  files: readonly FileRecord[]
  columns: SymbolTableColumns
}): SymbolTable {
  return new SymbolTableImpl(options)
}

/** 取出内部列数组（快照编码用）；外部实现返回 undefined。 */
export function getSymbolTableColumns(table: SymbolTable): SymbolTableColumns | undefined {
  return table instanceof SymbolTableImpl ? table.columns : undefined
}

// ---------------------------------------------------------------------------
// 增量更新：在列式数据上直接重建（不 materialize 全部条目），供单文件保存/删除使用
// ---------------------------------------------------------------------------

/** 合并旧名字表与新增名字（均升序）；remap[oldId] = newId（单调）。 */
function mergeNameTables(
  oldNames: readonly string[],
  newNames: readonly string[],
): { names: string[]; remap: Uint32Array } {
  const extra = Array.from(new Set(newNames)).sort(compareStrings)
  const names: string[] = []
  const remap = new Uint32Array(oldNames.length)
  let oldIndex = 0
  let extraIndex = 0
  while (oldIndex < oldNames.length || extraIndex < extra.length) {
    const oldName = oldNames[oldIndex]
    const extraName = extra[extraIndex]
    if (extraName === undefined || (oldName !== undefined && compareStrings(oldName, extraName) <= 0)) {
      remap[oldIndex] = names.length
      names.push(oldName!)
      if (extraName !== undefined && oldName === extraName) extraIndex++
      oldIndex++
    } else {
      names.push(extraName)
      extraIndex++
    }
  }
  return { names, remap }
}

function findNameId(names: readonly string[], target: string): number {
  let low = 0
  let high = names.length - 1
  while (low <= high) {
    const mid = (low + high) >>> 1
    const cmp = compareStrings(names[mid]!, target)
    if (cmp === 0) return mid
    if (cmp < 0) low = mid + 1
    else high = mid - 1
  }
  return -1
}

function removeFileFromColumns(
  oldColumns: SymbolTableColumns,
  fileIndex: number,
  nameRemap: Uint32Array,
  newNamesLength: number,
  extraEntries: readonly {
    nameId: number
    fileIndex: number
    line: number
    endLine: number
    column: number
    kindCode: number
  }[],
): {
  nameIds: Uint32Array
  fileIndexes: Uint32Array
  lines: Uint32Array
  endLines: Uint32Array
  columns: Uint16Array
  kinds: Uint8Array
  counts: Uint32Array
} {
  const sortedExtra = [...extraEntries].sort((a, b) => a.nameId - b.nameId)
  let oldRemaining = 0
  for (let index = 0; index < oldColumns.nameIds.length; index++) {
    if (oldColumns.fileIndexes[index] !== fileIndex) oldRemaining += 1
  }
  const total = oldRemaining + sortedExtra.length
  const nameIds = new Uint32Array(total)
  const fileIndexes = new Uint32Array(total)
  const lines = new Uint32Array(total)
  const endLines = new Uint32Array(total)
  const columns = new Uint16Array(total)
  const kinds = new Uint8Array(total)
  const counts = new Uint32Array(newNamesLength)

  let out = 0
  let oldIndex = 0
  let extraIndex = 0
  while (out < total) {
    while (
      oldIndex < oldColumns.nameIds.length &&
      oldColumns.fileIndexes[oldIndex] === fileIndex
    ) {
      oldIndex++
    }
    const oldNameId =
      oldIndex < oldColumns.nameIds.length
        ? nameRemap[oldColumns.nameIds[oldIndex]!]!
        : Number.MAX_SAFE_INTEGER
    const extra = sortedExtra[extraIndex]
    if (extra !== undefined && extra.nameId <= oldNameId) {
      nameIds[out] = extra.nameId
      fileIndexes[out] = extra.fileIndex
      lines[out] = extra.line
      endLines[out] = extra.endLine
      columns[out] = Math.min(extra.column, 0xffff)
      kinds[out] = extra.kindCode
      counts[extra.nameId] = counts[extra.nameId]! + 1
      extraIndex++
    } else {
      nameIds[out] = oldNameId
      fileIndexes[out] = oldColumns.fileIndexes[oldIndex]!
      lines[out] = oldColumns.lines[oldIndex]!
      endLines[out] = oldColumns.endLines[oldIndex]!
      columns[out] = oldColumns.columns[oldIndex]!
      kinds[out] = oldColumns.kinds[oldIndex]!
      counts[oldNameId] = counts[oldNameId]! + 1
      oldIndex++
    }
    out++
  }
  return { nameIds, fileIndexes, lines, endLines, columns, kinds, counts }
}

function buildLookupIndexes(
  names: readonly string[],
  nameIds: Uint32Array,
  fileIndexes: Uint32Array,
  lines: Uint32Array,
  columns: Uint16Array,
  fileCount: number,
  counts: Uint32Array,
): {
  nameOffsets: Uint32Array
  fileEntryOffsets: Uint32Array
  fileEntryIndexes: Uint32Array
} {
  const entryCount = nameIds.length
  const nameOffsets = new Uint32Array(names.length + 1)
  let running = 0
  for (let nameId = 0; nameId < names.length; nameId++) {
    nameOffsets[nameId] = running
    running += counts[nameId]!
  }
  nameOffsets[names.length] = running
  if (running !== entryCount) throw new Error(`symbol table name offsets mismatch: ${running} != ${entryCount}`)

  const fileCounts = new Uint32Array(Math.max(fileCount, 1))
  for (let index = 0; index < entryCount; index++) {
    fileCounts[fileIndexes[index]!] = fileCounts[fileIndexes[index]!]! + 1
  }
  const fileEntryOffsets = new Uint32Array(fileCount + 1)
  let fileRunning = 0
  for (let fileIndex = 0; fileIndex < fileCount; fileIndex++) {
    fileEntryOffsets[fileIndex] = fileRunning
    fileRunning += fileCounts[fileIndex]!
  }
  fileEntryOffsets[fileCount] = fileRunning

  const buckets: number[][] = Array.from({ length: fileCount }, () => [])
  for (let index = 0; index < entryCount; index++) buckets[fileIndexes[index]!]!.push(index)
  const fileEntryIndexes = new Uint32Array(entryCount)
  let cursor = 0
  for (let fileIndex = 0; fileIndex < fileCount; fileIndex++) {
    const bucket = buckets[fileIndex]!
    bucket.sort(
      (a, b) => lines[a]! - lines[b]! || columns[a]! - columns[b]! || nameIds[a]! - nameIds[b]!,
    )
    for (const entryIndex of bucket) {
      fileEntryIndexes[cursor++] = entryIndex
    }
  }
  return { nameOffsets, fileEntryOffsets, fileEntryIndexes }
}

function assembleTable(
  table: SymbolTable,
  files: readonly FileRecord[],
  names: readonly string[],
  merged: ReturnType<typeof removeFileFromColumns>,
): SymbolTable {
  const indexes = buildLookupIndexes(
    names,
    merged.nameIds,
    merged.fileIndexes,
    merged.lines,
    merged.columns,
    files.length,
    merged.counts,
  )
  return symbolTableFromColumns({
    version: table.version,
    roots: [...table.roots],
    builtAt: Date.now(),
    files: [...files],
    columns: {
      names: [...names],
      nameOffsets: indexes.nameOffsets,
      nameIds: merged.nameIds,
      fileIndexes: merged.fileIndexes,
      lines: merged.lines,
      endLines: merged.endLines,
      columns: merged.columns,
      kinds: merged.kinds,
      fileEntryOffsets: indexes.fileEntryOffsets,
      fileEntryIndexes: indexes.fileEntryIndexes,
    },
  })
}

/** 用新条目替换/新增一个文件（服务层单文件保存）。 */
export function upsertFileInTable(
  table: SymbolTable,
  fileRecord: FileRecord,
  entries: readonly SymbolEntry[],
): SymbolTable {
  const oldColumns = getSymbolTableColumns(table)
  if (!oldColumns) {
    const nextFiles = table.files.filter((file) => file.path !== fileRecord.path)
    nextFiles.push(fileRecord)
    const nextEntries = table.toArray().filter((entry) => entry.file !== fileRecord.path)
    nextEntries.push(...entries)
    return createSymbolTable(table.roots, nextFiles, nextEntries, Date.now(), table.version)
  }

  const oldFileIndex = table.files.findIndex((file) => file.path === fileRecord.path)
  const nextFiles = [...table.files]
  let nextFileIndex: number
  if (oldFileIndex >= 0) {
    nextFiles[oldFileIndex] = fileRecord
    nextFileIndex = oldFileIndex
  } else {
    nextFiles.push(fileRecord)
    nextFileIndex = nextFiles.length - 1
  }

  const { names, remap } = mergeNameTables(oldColumns.names, entries.map((entry) => entry.name))
  const extraEntries = entries.map((entry) => ({
    nameId: findNameId(names, entry.name),
    fileIndex: nextFileIndex,
    line: entry.line,
    endLine: entry.endLine,
    column: entry.column,
    kindCode: KIND_CODES[entry.kind] ?? 0,
  }))
  const merged = removeFileFromColumns(oldColumns, oldFileIndex, remap, names.length, extraEntries)
  return assembleTable(table, nextFiles, names, merged)
}

/** 从表中删除一个文件（服务层删除文件）。 */
export function removeFileFromTable(table: SymbolTable, filePath: string): SymbolTable {
  const oldColumns = getSymbolTableColumns(table)
  const fileIndex = table.files.findIndex((file) => file.path === filePath)
  if (!oldColumns || fileIndex < 0) return table
  const nextFiles = table.files.filter((_, index) => index !== fileIndex)
  const remap = new Uint32Array(oldColumns.names.length).map((_, index) => index)
  const merged = removeFileFromColumns(oldColumns, fileIndex, remap, oldColumns.names.length, [])
  return assembleTable(table, nextFiles, oldColumns.names, merged)
}
