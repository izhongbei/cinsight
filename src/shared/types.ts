/**
 * 跨层唯一数据契约：core（无 vscode 依赖）与 vscode 层都只依赖本文件。
 * 所有结构只读，避免一侧意外修改另一侧状态。
 */

export type SymbolKind =
  | 'function'
  | 'declaration'
  | 'macro'
  | 'struct'
  | 'union'
  | 'enum'
  | 'typedef'
  // v5 新增：结构体/联合体成员、枚举常量、文件作用域全局变量
  | 'member'
  | 'enumConstant'
  | 'variable'

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
  /** 定义所在行生效的条件栈文本；undefined/'' = 无条件（B4） */
  readonly condition?: string
  /** 成员/枚举常量的父类型名；无父级为 undefined（v5） */
  readonly parent?: string
}

export interface FileRecord {
  readonly path: string
  readonly mtimeMs: number
  readonly size: number
  /** 64 位内容哈希的低 32 位（v4 起可用；缺失 = 未记录，按 0 读） */
  readonly contentHashLo?: number
  /** 64 位内容哈希的高 32 位（v4 起可用；缺失 = 未记录，按 0 读） */
  readonly contentHashHi?: number
}

/**
 * 只读符号表（列式存储，替代 v1/v2 的对象数组）：
 * 149 万符号的堆占用从约 220MB 降到约 50MB，加载更快。
 * 调用方只通过方法访问，entryAt/forEachEntry 才 materialize 单个 SymbolEntry。
 */
export interface SymbolTable {
  readonly version: number
  readonly roots: readonly string[]
  readonly builtAt: number
  readonly entryCount: number
  readonly fileCount: number
  readonly files: readonly FileRecord[]
  entryAt(index: number): SymbolEntry
  findByName(name: string): SymbolEntry[]
  entriesInFile(file: string): SymbolEntry[]
  forEachEntry(callback: (entry: SymbolEntry) => void): void
  /** 遍历去重后的名字（升序）；条目通过 findByName 获取。 */
  forEachName(callback: (name: string) => void): void
  /** 测试/兼容用：物化全部条目（生产路径不应调用） */
  toArray(): SymbolEntry[]
  /** 该文件直接包含的索引内文件路径（已解析；未解析的不返回）（B1） */
  includedFiles(file: string): readonly string[]
  /** fromFile 是否直接或传递包含 toFile（BFS + 缓存；深度上限 64）（B1） */
  isReachable(fromFile: string, toFile: string): boolean
  /** 该文件的内容哈希（lo/hi）；无哈希返回 undefined（B2） */
  contentHashOf(file: string): { lo: number; hi: number } | undefined
}

/** 一条已扫描到的 `#include`（路径去掉引号/尖括号；行号为 0-based）。 */
export interface ScannedInclude {
  readonly path: string
  readonly line: number
  /** true = `#include <...>`，false = `#include "..."` */
  readonly angled: boolean
}

/** worker 单遍解析结果：符号 + 该文件标识符哈希 + 内容哈希 + include 列表（避免二次读盘） */
export interface ScannedFileResult {
  readonly symbols: readonly ScannedSymbol[]
  readonly hashes: Uint32Array
  /** 64 位内容哈希（两个 32 位分量），用于多副本折叠与增量复用 */
  readonly contentHash: { readonly lo: number; readonly hi: number }
  /** 文件内的 `#include` 原始路径（未解析；Task 3 再映射到索引内文件） */
  readonly includes: readonly ScannedInclude[]
}

export interface ScannedSymbol {
  readonly name: string
  readonly kind: SymbolKind
  readonly line: number
  readonly endLine: number
  readonly column: number
  /** 定义所在行生效的条件栈文本；undefined = 无条件（B4） */
  readonly condition?: string
  /** 成员/枚举常量的父类型名；无父级为 undefined（v5） */
  readonly parent?: string
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
  /** 构建并发上限（大工程自动降级用） */
  readonly concurrencyCap?: number
  /**
   * 按「实际 walk 到的文件数」自动降并发：文件数 > files 时把并发降到
   * `min(options.concurrency, 降级并发)`，首次构建 / 清缓存后同样生效。
   * 与 `concurrencyCap` 同时存在时先应用 cap、再按实际文件数降级（取更小值）。
   */
  readonly concurrencyDowngrade?: {
    readonly files: number
    readonly concurrency: number
  }
  readonly followSymlinks: boolean
  readonly previous?: SymbolTable
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
  /**
   * 本次构建实际生效的并发（`concurrency` 经 `concurrencyCap` 与
   * `concurrencyDowngrade` 计算后的值；构建日志用）。
   */
  readonly concurrency?: number
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

export const SNAPSHOT_VERSION = 5
export const NAME_INDEX_VERSION = 1
export const INDEXED_EXTENSIONS = ['.c', '.h', '.cc', '.cpp', '.hpp', '.hh', '.inl'] as const
export const DEFAULT_EXCLUDE = [
  '**/.git/**',
  '**/build/**',
  '**/tmp/**',
  '**/node_modules/**',
] as const
/**
 * 搜索排序：函数/类型/声明/宏 在前，成员/枚举常量/变量 在后（v5）。
 *
 * 既有 kind 的相对顺序锁定为 0.8.0（802f981）的 `function/struct/union/enum/typedef/
 * declaration/macro`，v5 新增的三类追加在尾部；不要因为文档措辞调整既有 kind 的序号。
 */
export const SYMBOL_KIND_ORDER: Record<SymbolKind, number> = {
  function: 0,
  struct: 1,
  union: 2,
  enum: 3,
  typedef: 4,
  declaration: 5,
  macro: 6,
  member: 7,
  enumConstant: 8,
  variable: 9,
}
