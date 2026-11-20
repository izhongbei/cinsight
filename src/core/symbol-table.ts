import type { FileRecord, SymbolEntry, SymbolKind, SymbolTable } from '../shared/types'

/**
 * 列式符号表实现（v5）：
 *   - 字符串表：文件路径、符号名（去重）、条件栈文本（去重，0 号为 ''）、
 *     parent 类型名（去重，0 号为 ''）
 *   - 列数组：nameId / fileIdx / line / endLine / column / kind / conditionId / parentId（TypedArray）
 *   - nameOffsets：按名字排序后每个名字的条目区间（findByName 二分）
 *   - fileEntryOffsets/fileEntryIndexes：按文件分组的条目索引（entriesInFile 直接切片）
 *   - contentHashLo/Hi：按 fileIndex 的内容哈希（0/0 = 未记录）
 *   - includeOffsets/includeTargets：include 图 CSR（已解析到索引内文件的边）
 *
 * 相比对象数组（149 万 × 约 150B），这里每符号约 23B + 字符串表，实测启发式降到 1/4 以下。
 */

export const KIND_CODES: Record<SymbolKind, number> = {
  function: 0,
  declaration: 1,
  macro: 2,
  struct: 3,
  union: 4,
  enum: 5,
  typedef: 6,
  // v5 新增（仅编码扩展；parent 列由 Task 2 加入布局）
  member: 7,
  enumConstant: 8,
  variable: 9,
}

/** kinds 列的编码 → SymbolKind 映射（与 KIND_CODES 互逆；delta 也用同一份）。 */
export const KIND_NAMES: readonly SymbolKind[] = [
  'function',
  'declaration',
  'macro',
  'struct',
  'union',
  'enum',
  'typedef',
  'member',
  'enumConstant',
  'variable',
]

/** isReachable 的 BFS 深度上限（防异常 include 环/超深链拖死查询）。 */
const MAX_INCLUDE_DEPTH = 64

/** 空 include 结果共享同一只读数组（避免每次查询分配）。 */
const NO_INCLUDES: readonly string[] = Object.freeze([])

export interface SymbolTableColumns {
  readonly names: readonly string[]
  readonly nameOffsets: Uint32Array
  readonly nameIds: Uint32Array
  readonly fileIndexes: Uint32Array
  readonly lines: Uint32Array
  readonly endLines: Uint32Array
  readonly columns: Uint16Array
  readonly kinds: Uint8Array
  /** 条件字符串表：0 号固定为 ''（表示无条件） */
  readonly conditions: readonly string[]
  /** 每个条目的条件 id（0 = 无条件） */
  readonly conditionIds: Uint32Array
  /** parent 字符串表：0 号固定为 ''（表示无 parent） */
  readonly parents: readonly string[]
  /** 每个条目的 parent id（0 = 无 parent）；成员/枚举常量指向父类型名 */
  readonly parentIds: Uint32Array
  readonly fileEntryOffsets: Uint32Array
  readonly fileEntryIndexes: Uint32Array
  /** 按 fileIndex 的内容哈希（lo/hi；0/0 = 未记录） */
  readonly contentHashLo: Uint32Array
  readonly contentHashHi: Uint32Array
  /** include CSR：offsets[fileIndex]..offsets[fileIndex+1] 是 includeTargets 切片 */
  readonly includeOffsets: Uint32Array
  /** include 目标（fileIndex），按来源文件分段 */
  readonly includeTargets: Uint32Array
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
  /**
   * isReachable 的闭包缓存（按 fromFile 路径）：表实例不可变，缓存随表替换自然失效。
   * 大工程里同一源文件的多次定义查询共享一次 BFS。
   */
  private readonly reachableCache = new Map<string, ReadonlySet<string>>()

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
    const conditionId = columns.conditionIds[index]!
    const condition = conditionId === 0 ? undefined : columns.conditions[conditionId]
    const parentId = columns.parentIds[index]!
    const parent = parentId === 0 ? undefined : columns.parents[parentId]
    return {
      name: this.nameAt(index),
      kind: KIND_NAMES[columns.kinds[index]!] ?? 'function',
      file: this.files[fileIndex]?.path ?? '',
      line: columns.lines[index]!,
      endLine: columns.endLines[index]!,
      column: columns.columns[index]!,
      // 无条件/无 parent 的条目不 materialize 可选属性（deepEqual / 序列化保持旧形状）
      ...(condition !== undefined && condition !== '' ? { condition } : {}),
      ...(parent !== undefined && parent !== '' ? { parent } : {}),
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

  forEachName(callback: (name: string) => void): void {
    const columns = this.columns
    for (let nameId = 0; nameId < columns.names.length; nameId++) {
      const start = columns.nameOffsets[nameId]!
      const end = columns.nameOffsets[nameId + 1]!
      if (start === end) continue
      callback(columns.names[nameId]!)
    }
  }

  toArray(): SymbolEntry[] {
    const result: SymbolEntry[] = new Array(this.entryCount)
    for (let index = 0; index < this.entryCount; index++) result[index] = this.entryAt(index)
    return result
  }

  includedFiles(file: string): readonly string[] {
    const fileIndex = this.fileIndexByPath.get(file)
    if (fileIndex === undefined) return NO_INCLUDES
    const columns = this.columns
    const start = columns.includeOffsets[fileIndex]!
    const end = columns.includeOffsets[fileIndex + 1]!
    if (start === end) return NO_INCLUDES
    const result: string[] = []
    for (let i = start; i < end; i++) {
      const target = this.files[columns.includeTargets[i]!]
      if (target) result.push(target.path)
    }
    return result
  }

  isReachable(fromFile: string, toFile: string): boolean {
    const fromIndex = this.fileIndexByPath.get(fromFile)
    if (fromIndex === undefined) return false
    let reachable = this.reachableCache.get(fromFile)
    if (!reachable) {
      reachable = this.computeReachable(fromIndex)
      this.reachableCache.set(fromFile, reachable)
    }
    return reachable.has(toFile)
  }

  /** 从 fileIndex 出发的 BFS 闭包（含经环回到自身的文件；深度上限 64）。 */
  private computeReachable(fromIndex: number): ReadonlySet<string> {
    const columns = this.columns
    const visited = new Set<number>()
    let frontier: number[] = [fromIndex]
    for (let depth = 0; depth < MAX_INCLUDE_DEPTH && frontier.length > 0; depth++) {
      const next: number[] = []
      for (const fileIndex of frontier) {
        const start = columns.includeOffsets[fileIndex]!
        const end = columns.includeOffsets[fileIndex + 1]!
        for (let i = start; i < end; i++) {
          const target = columns.includeTargets[i]!
          if (visited.has(target)) continue
          visited.add(target)
          next.push(target)
        }
      }
      frontier = next
    }
    const paths = new Set<string>()
    for (const fileIndex of visited) {
      const file = this.files[fileIndex]
      if (file) paths.add(file.path)
    }
    return paths
  }

  contentHashOf(file: string): { lo: number; hi: number } | undefined {
    const fileIndex = this.fileIndexByPath.get(file)
    if (fileIndex === undefined) return undefined
    const lo = this.columns.contentHashLo[fileIndex]!
    const hi = this.columns.contentHashHi[fileIndex]!
    if (lo === 0 && hi === 0) return undefined
    return { lo, hi }
  }
}

export interface CreateSymbolTableOptions {
  /**
   * 文件 → 已解析到索引内的 include 目标路径（B1）。
   * 不在 `files` 里的目标会被忽略（未命中不建边）。
   */
  readonly includes?: ReadonlyMap<string, readonly string[]>
}

/** 从对象条目构建列式符号表（构建期/测试用）。 */
export function createSymbolTable(
  roots: readonly string[],
  files: readonly FileRecord[],
  entries: readonly SymbolEntry[],
  builtAt: number,
  version: number,
  options: CreateSymbolTableOptions = {},
): SymbolTable {
  const sortedFiles = [...files].sort((a, b) => compareStrings(a.path, b.path))
  const fileIndexByPath = new Map(sortedFiles.map((file, index) => [file.path, index]))

  const names = Array.from(new Set(entries.map((entry) => entry.name))).sort(compareStrings)
  const nameIdByName = new Map(names.map((name, index) => [name, index]))

  // 条件字符串表：0 号固定为 ''（无条件），其余去重升序（快照编码结果稳定）。
  const conditionValues = new Set<string>()
  for (const entry of entries) {
    if (entry.condition !== undefined && entry.condition !== '') conditionValues.add(entry.condition)
  }
  const conditions: readonly string[] = [
    '',
    ...Array.from(conditionValues).sort(compareStrings),
  ]
  const conditionIdByValue = new Map(conditions.map((condition, index) => [condition, index]))

  // parent 字符串表：0 号固定为 ''（无 parent），其余去重升序（快照编码结果稳定）。
  const parentValues = new Set<string>()
  for (const entry of entries) {
    if (entry.parent !== undefined && entry.parent !== '') parentValues.add(entry.parent)
  }
  const parents: readonly string[] = ['', ...Array.from(parentValues).sort(compareStrings)]
  const parentIdByValue = new Map(parents.map((parent, index) => [parent, index]))

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
  const conditionIds = new Uint32Array(entryCount)
  const parentIds = new Uint32Array(entryCount)

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
    const condition = item.entry.condition
    conditionIds[index] =
      condition === undefined || condition === '' ? 0 : conditionIdByValue.get(condition) ?? 0
    const parent = item.entry.parent
    parentIds[index] = parent === undefined || parent === '' ? 0 : parentIdByValue.get(parent) ?? 0
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

  // 内容哈希列（未设置 = 0/0）
  const contentHashLo = new Uint32Array(sortedFiles.length)
  const contentHashHi = new Uint32Array(sortedFiles.length)
  for (let fileIndex = 0; fileIndex < sortedFiles.length; fileIndex++) {
    const file = sortedFiles[fileIndex]!
    contentHashLo[fileIndex] = file.contentHashLo ?? 0
    contentHashHi[fileIndex] = file.contentHashHi ?? 0
  }

  // include CSR：每文件去重、保持 options 中给出的顺序
  const includeOffsets = new Uint32Array(sortedFiles.length + 1)
  const includeTargets: number[] = []
  if (options.includes) {
    for (let fileIndex = 0; fileIndex < sortedFiles.length; fileIndex++) {
      includeOffsets[fileIndex] = includeTargets.length
      const targets = options.includes.get(sortedFiles[fileIndex]!.path)
      if (!targets) continue
      const seen = new Set<number>()
      for (const targetPath of targets) {
        const targetIndex = fileIndexByPath.get(targetPath)
        if (targetIndex === undefined || seen.has(targetIndex)) continue
        seen.add(targetIndex)
        includeTargets.push(targetIndex)
      }
    }
  }
  includeOffsets[sortedFiles.length] = includeTargets.length

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
      conditions,
      conditionIds,
      parents,
      parentIds,
      fileEntryOffsets,
      fileEntryIndexes,
      contentHashLo,
      contentHashHi,
      includeOffsets,
      includeTargets: Uint32Array.from(includeTargets),
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
// 单文件增删的兼容 API（**当前无生产调用方**；服务层已改用 overlay-index）
//
// 实现方式是完全物化 + 整表重建：先 forEachEntry 把全部 SymbolEntry materialize 成对象
// 数组，再交给 createSymbolTable 重算所有列、名字/文件分桶与 include CSR。时间与内存都是
// O(n)（149 万符号约 600ms），**不是**列式增量快路径。保留导出只为兼容旧的 core 使用方；
// 新代码请用 overlay-index 的 applyFile/removeFile + flatten（O(Δ)）。
// ---------------------------------------------------------------------------

/**
 * 收集表中的 include 边（路径 → 目标），`keep` 给定时同时过滤掉已不存在的文件/目标。
 * v4 元数据在重建时必须随文件保留，否则单文件增删会静默丢掉 include 图。
 */
function collectIncludes(
  table: SymbolTable,
  keep: ReadonlySet<string>,
): Map<string, readonly string[]> {
  const includes = new Map<string, readonly string[]>()
  for (const file of table.files) {
    if (!keep.has(file.path)) continue
    const targets = table.includedFiles(file.path).filter((target) => keep.has(target))
    if (targets.length > 0) includes.set(file.path, targets)
  }
  return includes
}

/**
 * 兼容 API（当前无生产调用方）：用新条目替换/新增一个文件。
 * 代价：forEachEntry 物化全部条目后整表 createSymbolTable 重建，O(n) 时间 + O(n) 临时对象。
 */
export function upsertFileInTable(
  table: SymbolTable,
  fileRecord: FileRecord,
  entries: readonly SymbolEntry[],
): SymbolTable {
  const nextFiles = table.files.filter((file) => file.path !== fileRecord.path)
  nextFiles.push(fileRecord)
  const nextEntries: SymbolEntry[] = []
  table.forEachEntry((entry) => {
    if (entry.file !== fileRecord.path) nextEntries.push(entry)
  })
  nextEntries.push(...entries)
  const keep = new Set(nextFiles.map((file) => file.path))
  return createSymbolTable(table.roots, nextFiles, nextEntries, Date.now(), table.version, {
    includes: collectIncludes(table, keep),
  })
}

/**
 * 兼容 API（当前无生产调用方）：从表中删除一个文件。
 * 代价同上：物化全部保留条目后整表重建，O(n)；文件不存在时原样返回。
 */
export function removeFileFromTable(table: SymbolTable, filePath: string): SymbolTable {
  if (!table.files.some((file) => file.path === filePath)) return table
  const nextFiles = table.files.filter((file) => file.path !== filePath)
  const nextEntries: SymbolEntry[] = []
  table.forEachEntry((entry) => {
    if (entry.file !== filePath) nextEntries.push(entry)
  })
  const keep = new Set(nextFiles.map((file) => file.path))
  return createSymbolTable(table.roots, nextFiles, nextEntries, Date.now(), table.version, {
    includes: collectIncludes(table, keep),
  })
}
