/**
 * 跨层唯一数据契约：core（无 vscode 依赖）与 vscode 层都只依赖本文件。
 * 所有结构只读，避免一侧意外修改另一侧状态。
 */

export type SymbolKind = 'function' | 'declaration' | 'macro'

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

export type IndexPhase = 'walk' | 'parse' | 'save'

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

export type ReadFileFn = (relativePath: string) => Promise<string>

export const SNAPSHOT_VERSION = 1
export const INDEXED_EXTENSIONS = ['.c', '.h', '.cc', '.cpp', '.hpp', '.hh', '.inl'] as const
export const DEFAULT_EXCLUDE = [
  '**/.git/**',
  '**/build/**',
  '**/tmp/**',
  '**/node_modules/**',
] as const
export const SYMBOL_KIND_ORDER: Record<SymbolKind, number> = {
  function: 0,
  declaration: 1,
  macro: 2,
}
export const MAX_SYMBOLS_WARNING = 5_000_000
