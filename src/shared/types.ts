/**
 * 跨层唯一数据契约：core（无 vscode 依赖）与 vscode 层都只依赖本文件。
 * 所有结构只读，避免一侧意外修改另一侧状态。
 */

export type SymbolKind =
  | 'function'
  | 'struct'
  | 'union'
  | 'enum'
  | 'typedef'
  | 'declaration'
  | 'macro'

export interface SymbolEntry {
  readonly name: string
  readonly kind: SymbolKind
  /** workspace 相对 posix 路径 */
  readonly file: string
  /** 0-based 定义首行（函数名所在行） */
  readonly line: number
  /** 0-based 函数体结束行；声明/宏等于 line */
  readonly endLine: number
  /** 0-based 名字起始列 */
  readonly column: number
}

export interface FileRecord {
  readonly path: string
  readonly mtimeMs: number
  readonly size: number
}

export interface IndexSnapshot {
  readonly version: number
  readonly roots: readonly string[]
  readonly builtAt: number
  readonly files: readonly FileRecord[]
  readonly entries: readonly SymbolEntry[]
}

export interface ScannedSymbol {
  readonly name: string
  readonly kind: SymbolKind
  readonly line: number
  readonly endLine: number
  readonly column: number
}

export type IndexPhase = 'walk' | 'parse' | 'index' | 'save'

export interface IndexProgress {
  readonly phase: IndexPhase
  readonly done: number
  readonly total: number
  readonly currentFile?: string
}

export interface BuildOptions {
  readonly workspaceRoot: string
  readonly roots: readonly string[]
  readonly exclude: readonly string[]
  readonly maxFileSizeKB: number
  readonly concurrency: number
  readonly followSymlinks: boolean
  readonly previous?: IndexSnapshot
  /** 提供时 buildIndex 负责把快照写盘并回填 summary.snapshotBytes */
  readonly snapshotPath?: string
  /** 提供时 buildIndex 同时构建引用加速索引并写盘，回填 summary.nameIndexBytes */
  readonly nameIndexPath?: string
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: IndexProgress) => void
}

export interface BuildSummary {
  readonly files: number
  readonly entries: number
  readonly added: number
  readonly updated: number
  readonly removed: number
  readonly unchanged: number
  readonly skipped: number
  readonly durationMs: number
  readonly snapshotBytes: number
  /** 引用加速索引写入字节数；未构建时为 0/undefined */
  readonly nameIndexBytes?: number
}

export interface ReferenceHit {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly preview: string
}

export interface CallerHit extends ReferenceHit {
  /** 命中点所在函数；文件顶层等无法归属时为 undefined */
  readonly from: SymbolEntry | undefined
}

/**
 * 引用加速用的「标识符倒排索引」：按文件存放该文件出现过的所有标识符的 32 位哈希
 * （去重、升序）。查询时对每个文件的切片做二分查找即可得到候选文件，避免全量读盘。
 * 32 位哈希可能碰撞，只会带来额外候选文件（读取后再按词边界精确匹配），不会漏报。
 */
export interface NameIndexData {
  /** 与快照 files 同序的工作区相对 posix 路径 */
  readonly filePaths: readonly string[]
  /** offsets[i]..offsets[i+1] 是第 i 个文件在 hashes 中的切片 */
  readonly offsets: Uint32Array
  /** 所有文件标识符哈希，按文件分段、段内升序 */
  readonly hashes: Uint32Array
}

export type ReadFileFn = (relativePath: string) => Promise<string>

export const SNAPSHOT_VERSION = 2
export const NAME_INDEX_VERSION = 1
export const INDEXED_EXTENSIONS = ['.c', '.h', '.cc', '.cpp', '.hpp', '.hh', '.inl'] as const
export const DEFAULT_EXCLUDE = [
  '**/.git/**',
  '**/build/**',
  '**/tmp/**',
  '**/node_modules/**',
] as const
export const SYMBOL_KIND_ORDER: Record<SymbolKind, number> = {
  function: 0,
  struct: 1,
  union: 2,
  enum: 3,
  typedef: 4,
  declaration: 5,
  macro: 6,
}
export const MAX_SYMBOLS_WARNING = 5_000_000
