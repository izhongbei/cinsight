/**
 * 索引服务：core（纯 Node 逻辑）与 VS Code 层的唯一桥。
 *
 * 职责：
 * - 快照路径（context.storageUri 优先，回退 globalStorageUri）下的 symbols.sidx 加载/保存；
 * - 构建 / 重建索引（withProgress + CancellationToken -> AbortSignal，写盘，fire onDidChange）；
 * - 单文件增量更新 / 删除（文件监听器回调）；
 * - Provider 查询入口（search / definitions / fileSymbols / references / callers / callees / signature）。
 *
 * 容错约定：任何 core 抛错都在本层捕获并写日志，绝不让异常冒到 VS Code UI；
 * 未配置 `sourceInsight.indexRoots` 时一切查询返回空、构建直接返回 undefined（不报错）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'

import { callersOf, calleesOf, clearCallGraphCache } from '../core/callgraph'
import { hashContent64 } from '../core/hash'
import { DEFAULT_INDEX_BUDGET, evaluateBudget, type BudgetReport } from '../core/index-budget'
import { resolveIncludePaths } from '../core/include-resolve'
import { buildIndex } from '../core/indexer'
import { createMutableIndex, createMutableIndexFromDeltas, type MutableSymbolIndex } from '../core/overlay-index'
import {
  appendSnapshotDeltaDetailed,
  compactSnapshot,
  flushSnapshotDeltaAppends,
  readSnapshotDeltasDetailed,
  removeSnapshotDelta,
  snapshotDeltaBytes,
  snapshotDeltaPath,
} from '../core/snapshot-delta'
import { entriesInFile, findByName, searchSymbols } from '../core/query'
import { findReferences, clearReferenceCache } from '../core/references'
import { readSignature } from '../core/signature'
import { scanIncludes, scanSource } from '../core/scan'
import {
  appendNameIndexDelta,
  collectIdentifierHashes,
  compactNameIndex,
  loadNameIndexWithDelta,
  nameIndexDeltaBytes,
  nameIndexDeltaPath,
  removeFileIndex,
  removeNameIndexDelta,
  upsertFileIndex,
} from '../core/nameindex'
import { loadSnapshot } from '../core/store'
import { compileExclude } from '../core/exclude'
import {
  SNAPSHOT_VERSION,
  type BuildOptions,
  type BuildSummary,
  type CallerHit,
  type FileRecord,
  type IndexProgress,
  type SymbolKind,
  type SymbolTable,
  type NameIndexData,
  type ReadFileFn,
  type ReferenceHit,
  type SymbolEntry,
} from '../shared/types'
import { readConfig, type SiConfig } from './config'
import { SimpleEmitter } from './emitter'
import { createLogger, type Logger } from './log'
import {
  isIndexablePath,
  isUnderRoot,
  joinPath,
  matchesExcludeFallback,
  normalizeRelative,
  normalizeRoot,
  relativePath,
} from './paths'
import {
  executeCommand,
  isAbortError,
  showWarningMessage,
  withProgress,
  type ProgressLike,
} from './util'

const SNAPSHOT_FILE_NAME = 'symbols.sidx'
const NAME_INDEX_FILE_NAME = 'symbols.names'
/** delta 超过该大小时合并回 base（写一次 base、清空 delta） */
const NAME_INDEX_COMPACT_BYTES = 4 * 1024 * 1024
/** 符号表 delta 超过 4MB 或累计 500 个文件变更时 compaction */
const SNAPSHOT_COMPACT_BYTES = 4 * 1024 * 1024
const SNAPSHOT_COMPACT_CHANGES = 500
/**
 * 硬安全上限：`sourceInsight.autoCompact=false` 时也强制 compaction。
 * 关闭自动合并只应「推迟」合并，不能让 overlay/delta 无限增长拖慢所有查询。
 */
const SNAPSHOT_OVERLAY_HARD_CHANGES = 5_000
const SNAPSHOT_DELTA_HARD_BYTES = 32 * 1024 * 1024
/** 空闲 60s 后 compaction（unref，不阻止退出） */
const SNAPSHOT_IDLE_COMPACT_MS = 60_000
const SIGNATURE_CACHE_CHAR_BUDGET = 8 * 1024 * 1024
const MAX_TRACKED_CACHE_FILES = 256

/**
 * 一次单文件变更：overlay 内存应用与 delta v2 追加共用同一载体。
 * `includes` 是**已解析到索引内**的目标路径，v2 set 记录里是权威值。
 */
interface SnapshotChange {
  readonly path: string
  readonly file: FileRecord
  readonly entries: readonly SymbolEntry[]
  readonly includes: readonly string[]
  readonly remove: boolean
}
/**
 * 大工程按实际文件数自动降并发：walk 到超过 80k 文件时并发最多 2。
 * 这是默认值，service 传给 `buildIndex` 的 `concurrencyDowngrade`。
 */
const CONCURRENCY_DOWNGRADE = { files: 80_000, concurrency: 2 } as const

/**
 * stat 单个文件的字节数。
 * 诊断只读路径：文件不存在（ENOENT）/不可访问时返回 0 且不写日志，避免打开报告刷警告。
 */
async function statBytesOrZero(filePath: string | undefined): Promise<number> {
  if (!filePath) {
    return 0
  }
  try {
    return (await fs.promises.stat(filePath)).size
  } catch {
    return 0
  }
}

export class SymbolService implements vscode.Disposable {
  /** 索引首次构建完成 / 增量更新 / 清缓存后触发（树、状态栏、调用层次依赖它刷新）。 */
  readonly onDidChange: vscode.Event<void>
  /** 构建进度（状态栏显示百分比用；构建结束后不再触发）。 */
  readonly onProgress: vscode.Event<IndexProgress>

  private readonly changeEmitter = new SimpleEmitter<void>()
  private readonly progressEmitter = new SimpleEmitter<IndexProgress>()
  private readonly disposables: vscode.Disposable[] = []
  private readonly logger: Logger
  private readonly workspaceRootValue: string | undefined
  private readonly snapshotPathValue: string | undefined
  private readonly nameIndexPathValue: string | undefined

  private snapshotValue: SymbolTable | undefined
  /** 当前快照的 mutable 视图（base + overlay），增量更新只改它。 */
  private mutableValue: MutableSymbolIndex | undefined
  /** 串行化 delta 追加（compaction 前需要 await 它） */
  private appendChain: Promise<void> = Promise.resolve()
  /** 在途 compaction：flush 需要 await；重复调用复用同一 promise，避免并发 compaction */
  private compactPromise: Promise<void> | undefined
  /** compaction 进行中：新变更先入 deferred，写完 base 后回放，避免被 compaction 吞掉 */
  private compacting = false
  /**
   * 整表代际号：build / clearCache / loadFromDisk / compaction swap 都会替换整个索引对象。
   * compaction 在 quiesce 前捕获它，若中途变化说明本次结果已过期，必须放弃（不能写旧 base、
   * 也不能把旧内存索引换回来）。
   */
  private indexEpoch = 0
  private deferredDuringCompaction: SnapshotChange[] = []
  private nameIndexValue: NameIndexData | undefined
  /** 引用索引是否已加载进内存（惰性加载：只在首次查引用/调用层次时读盘） */
  private nameIndexLoadedValue = false
  private nameIndexLoadPromise: Promise<NameIndexData | undefined> | undefined
  private lastSummaryValue: BuildSummary | undefined
  /** 最近一次构建/加载后评估的索引规模预算（状态栏警告用） */
  private budgetReportValue: BudgetReport | undefined
  /** 预算报告的评估输入签名：符号/文件数或阈值变化时 getter 重新评估，避免状态栏读到过期阈值 */
  private budgetReportKey: string | undefined
  /** `exceeded` 一次性提示标记：每次「进入 exceeded」只弹一次，回到 ok / 清缓存后重置 */
  private budgetPromptedValue = false
  private lastErrorValue: string | undefined
  private progressValue: IndexProgress | undefined
  private buildingValue = false
  private disposed = false
  private generation = 0
  private compactTimer: ReturnType<typeof setTimeout> | undefined
  private clearRequested = false
  /**
   * 本进程预期的 delta 大小 / 完整记录数（load、append、compaction、clear 时更新）。
   * 两个窗口共享 `context.storageUri` 时，另一个进程可能也在追加；compaction 写 base
   * 前先 stat 对比，大小不符就放弃本次 compaction，避免删掉对方尚未重放的记录。
   */
  private expectedDeltaBytes: number | undefined
  private expectedDeltaRecords = 0
  /** 本次进程已确认 delta 里混入其他进程的记录：不再自动 compaction（必须重载后才会重放它们）。 */
  private deltaConflict = false
  /** 最近一次加载 delta 时遇到的读错误 / 被丢弃尾部字节的说明（诊断报告用）。 */
  private deltaWarningValue: string | undefined
  private excludeCache: { readonly key: string; readonly matches: (relPath: string) => boolean } | undefined
  /**
   * 保存路径 include 解析用的「索引内文件路径」集合缓存（B1）。
   * 整表替换（build / load / compaction swap）时按快照身份重建（O(n) 一次），
   * 单文件增删时由 commitSnapshot 增量维护，保证每次保存仍是 O(Δ)。
   */
  private indexedPathsCache: { readonly snapshot: SymbolTable; readonly paths: Set<string> } | undefined

  /** 签名/树视图用的文件文本缓存（按字符总量封顶，避免大仓库撑爆内存）。 */
  private readonly textCache = new Map<string, string>()
  private textCacheChars = 0

  private readonly readFileBound: ReadFileFn = (relPath) => this.readFile(relPath)

  private constructor(context: vscode.ExtensionContext | undefined, logger: Logger) {
    this.logger = logger
    this.workspaceRootValue = resolveWorkspaceRoot()
    this.snapshotPathValue = resolveSnapshotPath(context)
    this.nameIndexPathValue = this.snapshotPathValue
      ? path.join(path.dirname(this.snapshotPathValue), NAME_INDEX_FILE_NAME)
      : undefined
    this.onDidChange = this.changeEmitter.event
    this.onProgress = this.progressEmitter.event
    if (!this.workspaceRootValue) {
      this.logger.warn('no workspace folder; index is disabled until a folder is opened')
    }
    if (!this.snapshotPathValue) {
      this.logger.warn('no storage URI available; index will not be persisted')
    }
    if (!this.nameIndexPathValue) {
      this.logger.warn('reference name index disabled: no storage path')
    }
  }

  /**
   * 创建服务并从磁盘恢复快照。
   * 任何一步失败都不抛：退化为一台「无索引」服务。
   */
  static async create(
    context: vscode.ExtensionContext | undefined,
    logger?: Logger,
  ): Promise<SymbolService> {
    const effectiveLogger = logger ?? createLogger()
    const service = new SymbolService(context, effectiveLogger)
    await service.loadFromDisk()
    return service
  }

  // ---- 状态 ----

  get snapshot(): SymbolTable | undefined {
    return this.snapshotValue
  }

  get ready(): boolean {
    return this.snapshotValue !== undefined
  }

  get building(): boolean {
    return this.buildingValue
  }

  get entryCount(): number {
    return this.snapshotValue?.entryCount ?? 0
  }

  get fileCount(): number {
    return this.snapshotValue?.files.length ?? 0
  }

  /** 引用索引文件路径（symbols.names）；无存储目录时为 undefined。 */
  get nameIndexPath(): string | undefined {
    return this.nameIndexPathValue
  }

  /** 引用索引是否已惰性加载进内存。 */
  get nameIndexLoaded(): boolean {
    return this.nameIndexLoadedValue
  }

  /** overlay 中尚未合并进 base 的文件变更数。 */
  get pendingChanges(): number {
    return this.mutableValue?.pendingChanges ?? 0
  }

  /** 当前快照 delta 文件字节数（诊断用，不触发写盘）。 */
  async deltaBytes(): Promise<number> {
    return this.snapshotPathValue ? snapshotDeltaBytes(snapshotDeltaPath(this.snapshotPathValue)) : 0
  }

  /** 上次加载 delta 时的恢复警告（读失败 / 丢弃损坏尾部）；正常时为 undefined。 */
  get deltaWarning(): string | undefined {
    return this.deltaWarningValue
  }

  /** 快照 base 文件（symbols.sidx）字节数；文件缺失或未配置存储路径时为 0。 */
  async snapshotBytes(): Promise<number> {
    return statBytesOrZero(this.snapshotPathValue)
  }

  /** 引用索引 base 文件（symbols.names）字节数；文件缺失或未配置存储路径时为 0。 */
  async nameIndexBytes(): Promise<number> {
    return statBytesOrZero(this.nameIndexPathValue)
  }

  /** 按符号类型统计条目数（诊断用；仅遍历一次列式存储）。 */
  kindCounts(): Record<SymbolKind, number> {
    const counts: Record<SymbolKind, number> = {
      function: 0, declaration: 0, macro: 0, struct: 0, union: 0, enum: 0, typedef: 0,
    }
    this.snapshotValue?.forEachEntry((entry) => { counts[entry.kind] += 1 })
    return counts
  }

  get builtAt(): number | undefined {
    return this.snapshotValue?.builtAt
  }

  get lastSummary(): BuildSummary | undefined {
    return this.lastSummaryValue
  }

  /** 索引规模预算报告；未构建/未加载时为 undefined。 */
  get budgetReport(): BudgetReport | undefined {
    const snapshot = this.snapshotValue
    if (!snapshot) {
      return undefined
    }
    const key = this.budgetKey(snapshot.entryCount, snapshot.files.length, readConfig())
    if (!this.budgetReportValue || this.budgetReportKey !== key) {
      // 配置阈值或符号/文件数变了：静默重算（不刷日志，状态栏会频繁读取）。
      return this.evaluateIndexBudget(snapshot.entryCount, snapshot.files.length, false)
    }
    return this.budgetReportValue
  }

  get lastError(): string | undefined {
    return this.lastErrorValue
  }

  get progress(): IndexProgress | undefined {
    return this.progressValue
  }

  get workspaceRoot(): string | undefined {
    return this.workspaceRootValue
  }

  get snapshotPath(): string | undefined {
    return this.snapshotPathValue
  }

  /** 配置里规范化后的索引目录（`.` 表示工作区根）。 */
  get configuredRoots(): readonly string[] {
    return readConfig().indexRoots.map(normalizeRoot)
  }

  get hasRoots(): boolean {
    return this.configuredRoots.length > 0 && this.workspaceRootValue !== undefined
  }

  get config(): SiConfig {
    return readConfig()
  }

  /** 快照里的 roots 和当前配置是否不一致（配置改了但尚未重建）。 */
  rootsChanged(): boolean {
    const snapshot = this.snapshotValue
    if (!snapshot) {
      return true
    }
    const current = [...this.configuredRoots].sort().join('\u0000')
    const stored = [...snapshot.roots].map(normalizeRoot).sort().join('\u0000')
    return current !== stored
  }

  // ---- 查询入口（Provider / 命令使用） ----

  search(query: string, limit?: number): SymbolEntry[] {
    const snapshot = this.snapshotValue
    if (!snapshot || !query || !query.trim()) {
      return []
    }
    try {
      const effectiveLimit = limit ?? Math.max(1, readConfig().searchLimit)
      return searchSymbols(snapshot, query, { limit: effectiveLimit })
    } catch (error) {
      this.logger.error('searchSymbols failed', error)
      return []
    }
  }

  definitions(name: string): SymbolEntry[] {
    const snapshot = this.snapshotValue
    if (!snapshot || !name) {
      return []
    }
    try {
      return findByName(snapshot, name)
    } catch (error) {
      this.logger.error('findByName failed', error)
      return []
    }
  }

  fileSymbols(relPath: string): SymbolEntry[] {
    const snapshot = this.snapshotValue
    if (!snapshot || !relPath) {
      return []
    }
    try {
      return entriesInFile(snapshot, normalizeRelative(relPath))
    } catch (error) {
      this.logger.error('entriesInFile failed', error)
      return []
    }
  }

  async references(name: string, token?: vscode.CancellationToken): Promise<ReferenceHit[]> {
    const snapshot = this.snapshotValue
    if (!snapshot || !name) {
      return []
    }
    const title = vscode.l10n.t('Finding references to "{0}"…', name)
    return this.queryWithProgress<ReferenceHit[]>(
      title,
      async (signal, report) =>
        findReferences(snapshot, name, this.readFileBound, {
          nameIndex: await this.ensureNameIndex(),
          signal,
          onProgress: report,
        }),
      token,
      [],
    )
  }

  async callers(name: string, token?: vscode.CancellationToken): Promise<CallerHit[]> {
    const snapshot = this.snapshotValue
    if (!snapshot || !name) {
      return []
    }
    const title = vscode.l10n.t('Finding callers of "{0}"…', name)
    return this.queryWithProgress<CallerHit[]>(
      title,
      async (signal, report) =>
        callersOf(snapshot, name, this.readFileBound, {
          nameIndex: await this.ensureNameIndex(),
          signal,
          onProgress: report,
        }),
      token,
      [],
    )
  }

  async callees(name: string, token?: vscode.CancellationToken): Promise<SymbolEntry[]> {
    const snapshot = this.snapshotValue
    if (!snapshot || !name) {
      return []
    }
    const title = vscode.l10n.t('Finding callees of "{0}"…', name)
    return this.queryWithProgress<SymbolEntry[]>(
      title,
      async (signal) => calleesOf(snapshot, name, this.readFileBound, { signal }),
      token,
      [],
    )
  }

  async signature(entry: SymbolEntry): Promise<string | undefined> {
    if (!entry) {
      return undefined
    }
    try {
      const signature = await readSignature((relPath) => this.readFileCached(relPath), entry)
      return signature
    } catch (error) {
      if (!isAbortError(error)) {
        this.logger.error(`readSignature failed for ${entry.file}:${entry.line + 1}`, error)
      }
      return undefined
    }
  }

  /** 以 latin1 读取工作区相对文件（保持 1 字节 = 1 字符的行列语义）。 */
  async readFile(relPath: string): Promise<string> {
    const absolutePath = this.toAbsolute(relPath)
    try {
      return await fs.promises.readFile(absolutePath, 'latin1')
    } catch (error) {
      this.logger.error(`cannot read file ${relPath}`, error)
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  // ---- 路径换算 ----

  toAbsolute(relPath: string): string {
    const root = this.workspaceRootValue
    if (!root) {
      return relPath
    }
    return joinPath(root, normalizeRelative(relPath))
  }

  toRelative(absPath: string): string {
    const root = this.workspaceRootValue
    if (!root) {
      return normalizeRelative(absPath)
    }
    try {
      return relativePath(root, absPath)
    } catch (error) {
      this.logger.error(`cannot make ${absPath} workspace-relative`, error)
      return normalizeRelative(absPath)
    }
  }

  /** watcher 用：该绝对路径是否属于索引范围（扩展名 + roots）。 */
  shouldTrack(absPath: string): boolean {
    if (!this.workspaceRootValue || !this.hasRoots) {
      return false
    }
    const rel = this.toRelative(absPath)
    if (!rel || rel.startsWith('../') || rel === '..') {
      return false
    }
    if (!isIndexablePath(rel)) {
      return false
    }
    if (!this.isUnderRoots(rel)) {
      return false
    }
    return !this.isExcluded(rel)
  }

  /** 排除匹配：优先用 core 的 compileExclude，core 尚未就绪时退化为本地 glob。 */
  isExcluded(relPath: string, isDir = false): boolean {
    const patterns = readConfig().exclude
    const key = patterns.join('\u0000')
    try {
      if (!this.excludeCache || this.excludeCache.key !== key) {
        this.excludeCache = { key, matches: compileExclude(patterns) }
      }
      const rel = normalizeRelative(relPath)
      if (this.excludeCache.matches(rel)) {
        return true
      }
      return isDir ? this.excludeCache.matches(`${rel}/.`) : false
    } catch (error) {
      this.excludeCache = undefined
      this.logger.warn('compileExclude unavailable, using fallback glob matcher', error)
      return matchesExcludeFallback(relPath, patterns, isDir)
    }
  }

  // ---- 构建 ----

  /** 未配置 roots 时返回 undefined；已就绪且 roots 未变时也返回 undefined。 */
  async ensureBuilt(token?: vscode.CancellationToken): Promise<BuildSummary | undefined> {
    if (!this.hasRoots) {
      return undefined
    }
    if (this.ready && !this.rootsChanged()) {
      return undefined
    }
    return this.build(false, token)
  }

  /** 强制重建（复用 mtime+size 未变文件的符号，等价于增量刷新）。 */
  async rebuild(token?: vscode.CancellationToken): Promise<BuildSummary | undefined> {
    if (!this.hasRoots) {
      return undefined
    }
    return this.build(true, token)
  }

  private async build(forced: boolean, token?: vscode.CancellationToken): Promise<BuildSummary | undefined> {
    if (this.disposed || !this.hasRoots) {
      return undefined
    }
    if (this.buildingValue) {
      this.logger.warn('index build already running; request ignored')
      return undefined
    }
    const workspaceRoot = this.workspaceRootValue
    if (!workspaceRoot) {
      return undefined
    }
    const config = readConfig()
    const roots = this.resolveBuildRoots(config)
    if (roots.length === 0) {
      this.logger.warn('no usable index roots after normalization')
      return undefined
    }

    this.buildingValue = true
    this.lastErrorValue = undefined
    this.progressValue = { phase: 'walk', done: 0, total: 0 }
    this.progressEmitter.fire(this.progressValue)
    this.changeEmitter.fire()

    // 串行化 base 写者：build 自己的 base 写在 buildIndex 里，若此时还有 compaction 在
    // compactSnapshot 中，它的 rename/清 delta 可能落在 build 的写之后，用旧 flat 覆盖新 base。
    // compaction 从不等待 build（只通过 stale() 观察 buildingValue 提前放弃），不会死锁；
    // 失败仅记日志，不能阻断本次重建。
    const inFlightCompaction = this.compactPromise
    if (inFlightCompaction) {
      try {
        await inFlightCompaction
      } catch (error) {
        this.logger.warn('in-flight compaction failed before rebuild', error)
      }
    }

    const generation = this.generation
    const title = forced
      ? vscode.l10n.t('Rebuilding Code Insight index…')
      : vscode.l10n.t('Building Code Insight index…')

    let summary: BuildSummary | undefined
    try {
      summary = await withProgress(title, async (progress, progressToken) => {
        const controller = new AbortController()
        const tokenDisposables: vscode.Disposable[] = []
        const cancel = (): void => controller.abort()
        try {
          tokenDisposables.push(progressToken.onCancellationRequested(cancel))
        } catch {
          // ignore
        }
        if (token) {
          try {
            tokenDisposables.push(token.onCancellationRequested(cancel))
          } catch {
            // ignore
          }
        }
        let lastPhase: string | undefined
        let lastDone = 0
        try {
          await this.ensureStorageDir()
          const options: BuildOptions & { readFile: ReadFileFn } = {
            workspaceRoot,
            roots,
            exclude: config.exclude,
            maxFileSizeKB: config.maxFileSizeKB,
            concurrency: config.concurrency,
            // 按 walkFiles 的实际文件数降并发（首次构建/清缓存后也生效；summary 回填实际值）
            concurrencyDowngrade: CONCURRENCY_DOWNGRADE,
            followSymlinks: config.followSymlinks,
            previous: this.snapshotValue,
            snapshotPath: this.snapshotPathValue,
            nameIndexPath: this.nameIndexPathValue,
            signal: controller.signal,
            readFile: this.readFileBound,
            onProgress: (p: IndexProgress) => {
              this.progressValue = p
              this.progressEmitter.fire(p)
              this.reportBuildProgress(progress, p, lastPhase, lastDone, (phase, done) => {
                lastPhase = phase
                lastDone = done
              })
            },
          }
          await this.compactNameIndexIfNeeded(true)
          const result = await buildIndex(options)
          if (this.clearRequested || generation !== this.generation || this.disposed) {
            // 构建期间用户清空了缓存：丢弃本次结果，并把 buildIndex 可能刚写下的快照删掉
            this.clearRequested = false
            await this.removeSnapshotFile()
            return undefined
          }
          if (controller.signal.aborted) {
            // 用户取消：保留旧快照（如果存在），不提交半成品
            return undefined
          }
          this.mutableValue = createMutableIndex(result.snapshot)
          this.snapshotValue = this.mutableValue
          // 整表已替换：旧的「索引内路径集合」缓存（O(文件数) 的 Set）没有意义了，
          // 立即释放；下一次保存按新快照身份重建。
          this.indexedPathsCache = undefined
          // 全新索引：代际 +1，让在途 compaction 作废，并清掉 identity-keyed 查询缓存
          this.indexEpoch += 1
          clearReferenceCache()
          clearCallGraphCache()
          // build 期间可能有 compaction abort 补写的 delta 追加在途：先等它们落盘，
          // 后面的 removeSnapshotDelta 才不会因为「先删后写」把旧索引记录留到新 base 上。
          await this.appendChain
          this.appendChain = Promise.resolve()
          this.deferredDuringCompaction = []
          this.compacting = false
          if (this.snapshotPathValue) {
            const deltaPath = snapshotDeltaPath(this.snapshotPathValue)
            const actualDeltaBytes = await snapshotDeltaBytes(deltaPath)
            const ours =
              !this.deltaConflict &&
              (this.expectedDeltaBytes === undefined || actualDeltaBytes === this.expectedDeltaBytes)
            if (actualDeltaBytes > 0 && !ours) {
              // 另一个窗口在本进程加载后追加过记录：新 base 虽然更新，但对方尚未重放的记录
              // 不能删（保留后下次加载会重放；对已存在于新 base 的文件是幂等的）。
              this.logger.warn(
                `snapshot delta changed by another window (${actualDeltaBytes} B, expected ` +
                  `${this.expectedDeltaBytes} B); keeping it after rebuild`,
              )
              this.expectedDeltaBytes = actualDeltaBytes
              this.deltaConflict = true
            } else {
              await removeSnapshotDelta(deltaPath)
              this.expectedDeltaBytes = 0
              this.expectedDeltaRecords = 0
              this.deltaConflict = false
              this.deltaWarningValue = undefined
            }
          }
          // 构建已经写出新的 base；丢弃内存副本，下次查引用时惰性加载
          this.nameIndexValue = undefined
          this.nameIndexLoadedValue = false
          this.nameIndexLoadPromise = undefined
          if (this.nameIndexPathValue) {
            await removeNameIndexDelta(nameIndexDeltaPath(this.nameIndexPathValue))
          }
          this.lastSummaryValue = result.summary
          this.textCache.clear()
          this.textCacheChars = 0
          this.evaluateIndexBudget(result.summary.entries, result.summary.files)
          return this.lastSummaryValue
        } finally {
          for (const disposable of tokenDisposables) {
            try {
              disposable.dispose()
            } catch {
              // ignore
            }
          }
        }
      })

      if (summary) {
        this.logger.info(
          `index ready: files=${summary.files} entries=${summary.entries} added=${summary.added} ` +
            `updated=${summary.updated} removed=${summary.removed} skipped=${summary.skipped} ` +
            `concurrency=${summary.concurrency ?? '?'} ` +
            `duration=${summary.durationMs}ms bytes=${summary.snapshotBytes}`,
        )
        if (summary.concurrency !== undefined && summary.concurrency < config.concurrency) {
          this.logger.info(
            `build concurrency downgraded: ${config.concurrency} -> ${summary.concurrency} ` +
              `(actual files=${summary.files})`,
          )
        }
        this.changeEmitter.fire()
      }
      return summary
    } catch (error) {
      if (isAbortError(error)) {
        this.logger.info('index build cancelled')
        return undefined
      }
      this.lastErrorValue = error instanceof Error ? error.message : String(error)
      this.logger.error('index build failed', error)
      this.changeEmitter.fire()
      return undefined
    } finally {
      this.buildingValue = false
      this.progressValue = undefined
      if (!this.disposed) {
        this.changeEmitter.fire()
      }
    }
  }

  private reportBuildProgress(
    progress: ProgressLike,
    p: IndexProgress,
    lastPhase: string | undefined,
    lastDone: number,
    update: (phase: string, done: number) => void,
  ): void {
    try {
      if (p.phase === 'walk') {
        progress.report({
          message:
            p.total > 0
              ? vscode.l10n.t('Scanning files… {0}/{1}', p.done, p.total)
              : vscode.l10n.t('Scanning files…'),
        })
        return
      }
      if (p.phase === 'index') {
        progress.report({
          message:
            p.total > 0
              ? vscode.l10n.t('Building reference index… {0}/{1}', p.done, p.total)
              : vscode.l10n.t('Building reference index…'),
        })
        return
      }
      if (p.phase === 'save') {
        progress.report({ message: vscode.l10n.t('Saving index…') })
        return
      }
      // parse：按完成比例推进进度条
      const total = Math.max(1, p.total)
      let increment = 0
      if (lastPhase === 'parse' && p.done > lastDone) {
        increment = Math.max(0, Math.min(100, ((p.done - lastDone) / total) * 100))
      }
      update('parse', p.done)
      progress.report({
        increment,
        message: vscode.l10n.t('Parsing {0}/{1} files…', p.done, p.total),
      })
    } catch {
      // 进度上报失败不能影响构建
    }
  }

  /**
   * 评估索引规模预算（构建完成 / 从磁盘加载后各一次）。
   * 阈值来自 `sourceInsight.maxSymbols` / `maxFiles`（硬上限固定 DEFAULT_INDEX_BUDGET.hardMaxSymbols）；
   * 超限只记日志 + 由状态栏提示缩小 indexRoots，不改变索引行为。
   */
  private evaluateIndexBudget(symbols: number, files: number, log = true): BudgetReport {
    const config = readConfig()
    const report = evaluateBudget({
      symbols,
      files,
      budget: {
        maxSymbols: config.maxSymbols,
        maxFiles: config.maxFiles,
        hardMaxSymbols: DEFAULT_INDEX_BUDGET.hardMaxSymbols,
      },
    })
    this.budgetReportValue = report
    this.budgetReportKey = this.budgetKey(symbols, files, config)
    if (log && report.level !== 'ok') {
      this.logger.warn(`index budget ${report.level}: ${report.message ?? ''}`)
    }
    this.maybePromptExceededBudget(report)
    return report
  }

  /**
   * `exceeded` 一次性提示：每次进入 exceeded 只弹一次（非阻塞），按钮动作执行
   * `si.configureRoots`；`warn` 不弹（只由状态栏 tooltip / 背景色提示）。
   * 回到 `ok` 或 clearCache 时重置，允许下一次重新提示。
   */
  private maybePromptExceededBudget(report: BudgetReport): void {
    if (report.level === 'ok') {
      this.budgetPromptedValue = false
      return
    }
    if (report.level !== 'exceeded' || this.budgetPromptedValue || this.disposed) {
      return
    }
    this.budgetPromptedValue = true
    const label = vscode.l10n.t('Reconfigure Index Roots')
    const message = report.message ?? vscode.l10n.t('The Code Insight index exceeds its size budget.')
    void showWarningMessage(message, label)
      .then((answer) => {
        if (answer === label) {
          return executeCommand('si.configureRoots')
        }
        return undefined
      })
      .catch((error) => {
        this.logger.warn('budget warning prompt failed', error)
      })
  }

  /** 预算评估输入签名（符号数/文件数 + 可配置阈值）。 */
  private budgetKey(symbols: number, files: number, config: SiConfig): string {
    return `${symbols}\u0000${files}\u0000${config.maxSymbols}\u0000${config.maxFiles}`
  }

  /** 配置里的 roots -> 规范化后的 workspace 相对 posix roots。 */
  private resolveBuildRoots(config: SiConfig): string[] {
    const workspaceRoot = this.workspaceRootValue
    const result: string[] = []
    for (const rawRoot of config.indexRoots) {
      const root = normalizeRoot(rawRoot)
      if (!root) {
        continue
      }
      if (!path.isAbsolute(root)) {
        result.push(root)
        continue
      }
      if (!workspaceRoot) {
        continue
      }
      const rel = relativePath(workspaceRoot, root)
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        this.logger.warn(`index root outside workspace ignored: ${rawRoot}`)
        continue
      }
      result.push(normalizeRoot(rel === '' ? '.' : rel))
    }
    return Array.from(new Set(result))
  }

  // ---- 增量更新（文件监听器使用） ----

  async updateFile(absPath: string): Promise<void> {
    try {
      if (this.disposed || this.buildingValue || !this.snapshotValue || !this.hasRoots) {
        return
      }
      if (!this.shouldTrack(absPath)) {
        return
      }
      const rel = normalizeRelative(this.toRelative(absPath))
      const stat = await fs.promises.stat(absPath)
      if (!stat.isFile()) {
        return
      }
      const config = readConfig()
      if (stat.size > config.maxFileSizeKB * 1024) {
        await this.removeFile(absPath)
        return
      }
      const text = await this.readFile(rel)
      const symbols = scanSource(text)
      const entries: SymbolEntry[] = symbols.map((symbol) => {
        const entry: SymbolEntry = {
          name: symbol.name,
          kind: symbol.kind,
          file: rel,
          line: symbol.line,
          endLine: symbol.endLine,
          column: symbol.column,
        }
        // 无条件条目不 materialize condition（与快照/v4 契约的旧形状一致）
        if (symbol.condition === undefined || symbol.condition === '') return entry
        return { ...entry, condition: symbol.condition }
      })
      // 单遍产出：保存的文本已读入，哈希与 include 文本都从这份内存文本算，零额外 IO；
      // include 目标只在「当前索引内」解析（不读、不扫其他文件），未命中的丢弃。
      const contentHash = hashContent64(text)
      const file: FileRecord = {
        path: rel,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        contentHashLo: contentHash.lo,
        contentHashHi: contentHash.hi,
      }
      const includes = this.resolveSavedIncludes(rel, text)
      this.commitSnapshot(rel, entries, file, includes)
      await this.refreshNameIndexForFile(rel, text)
      this.logger.info(`incremental update: ${rel} (${entries.length} symbols, ${includes.length} includes)`)
    } catch (error) {
      if (!isAbortError(error)) {
        this.logger.error(`updateFile failed: ${absPath}`, error)
      }
    }
  }

  /**
   * 保存路径的 include 解析（B1）：把已扫描出的原始 include 路径映射到当前索引内文件。
   * 只做内存查表，不读盘；替换 `indexedPathsCache` 的成本仅在整表替换后出现一次。
   */
  private resolveSavedIncludes(relPath: string, text: string): readonly string[] {
    const rawIncludes = scanIncludes(text)
    if (rawIncludes.length === 0) return []
    const indexedPaths = this.indexedPathSet()
    const snapshot = this.snapshotValue
    if (!indexedPaths || !snapshot) return []
    return resolveIncludePaths(
      relPath,
      rawIncludes.map((include) => include.path),
      { indexedPaths, roots: snapshot.roots },
    )
  }

  /** 索引内文件路径集合（按快照身份缓存；单文件增删由 commitSnapshot 增量维护）。 */
  private indexedPathSet(): ReadonlySet<string> | undefined {
    const snapshot = this.snapshotValue
    if (!snapshot) return undefined
    const cached = this.indexedPathsCache
    if (cached && cached.snapshot === snapshot) return cached.paths
    const paths = new Set(snapshot.files.map((file) => file.path))
    this.indexedPathsCache = { snapshot, paths }
    return paths
  }

  async removeFile(absPath: string): Promise<void> {
    try {
      if (this.disposed || this.buildingValue || !this.snapshotValue) {
        return
      }
      const rel = normalizeRelative(this.toRelative(absPath))
      if (!rel || rel.startsWith('../')) {
        return
      }
      const snapshot = this.snapshotValue
      const existed =
        snapshot.files.some((record) => record.path === rel) ||
        snapshot.entriesInFile(rel).length > 0
      if (!existed) {
        return
      }
      this.commitSnapshot(rel, [], { path: rel, mtimeMs: 0, size: 0 }, [], true)
      await this.removeNameIndexForFile(rel)
      this.logger.info(`incremental remove: ${rel}`)
    } catch (error) {
      this.logger.error(`removeFile failed: ${absPath}`, error)
    }
  }

  private commitSnapshot(
    relPath: string,
    entries: readonly SymbolEntry[],
    file: FileRecord,
    includes: readonly string[],
    remove = false,
  ): void {
    // 签名缓存以工作区相对路径为 key：文件刚被保存/删除，必须让下一次签名重读磁盘，
    // 否则 hover / 树视图会继续显示旧函数签名（缓存命中时不会校验 mtime）。
    const cachedText = this.textCache.get(relPath)
    if (cachedText !== undefined) {
      this.textCache.delete(relPath)
      this.textCacheChars -= cachedText.length
    }
    const index = this.mutableValue
    if (!index) {
      this.snapshotValue = undefined
      return
    }
    if (remove) {
      if (!index.removeFile(relPath)) return
      this.indexedPathsCache?.paths.delete(relPath)
    } else {
      index.applyFile(file, entries)
      // v4 include 边：overlay 记录整体替换该文件的旧边（即使保存后没有任何 include，
      // 也必须以空数组覆盖，否则查询会继续走 base 的旧边）。
      index.applyIncludes(relPath, includes)
      this.indexedPathsCache?.paths.add(relPath)
    }
    this.snapshotValue = index
    this.lastSummaryValue = undefined
    // overlay 是原地修改：索引对象身份不变，identity-keyed 的引用/调用图缓存不会自动失效。
    // core 不依赖 vscode，只能在 service 这一层显式清（否则增量编辑后仍返回旧结果）。
    clearReferenceCache()
    clearCallGraphCache()
    this.changeEmitter.fire()

    const change: SnapshotChange = {
      path: relPath,
      file,
      entries,
      includes,
      remove,
    }
    if (this.compacting) {
      this.deferredDuringCompaction.push(change)
    } else {
      this.enqueueAppend(change)
    }
    void this.scheduleCompaction()
  }

  /** 追加 delta 串行化：失败只记日志，chain 永不 reject，保证后续 append 可继续。 */
  private enqueueAppend(change: SnapshotChange): void {
    this.appendChain = this.appendChain
      .then(() => this.appendDelta(change))
      .catch((error) => this.logger.warn('append snapshot delta failed', error))
  }

  private async appendDelta(change: SnapshotChange): Promise<void> {
    const snapshotPath = this.snapshotPathValue
    if (!snapshotPath) return
    const result = await appendSnapshotDeltaDetailed(
      snapshotDeltaPath(snapshotPath),
      change.remove
        ? { kind: 'remove', path: change.path }
        : {
            kind: 'set',
            path: change.path,
            mtimeMs: change.file.mtimeMs,
            size: change.file.size,
            contentHashLo: change.file.contentHashLo,
            contentHashHi: change.file.contentHashHi,
            entries: change.entries,
            // v2：include 数组是权威值（空数组表示「该文件没有任何 include」），
            // 必须显式传数组，否则重放时无法与 v1 的「未知」区分。
            includes: change.includes,
          },
    )
    // 追加结果里带上了文件中的完整记录数：若比「我们已知的 + 这次」多，说明另一个窗口
    // 也追加过记录（它们的变更不在本进程内存里），之后绝不能 compaction 删掉它们。
    if (
      this.expectedDeltaBytes !== undefined &&
      !result.reset &&
      result.recordCount !== this.expectedDeltaRecords + 1
    ) {
      if (!this.deltaConflict) {
        this.logger.warn(
          `snapshot delta contains records from another window ` +
            `(expected ${this.expectedDeltaRecords + 1}, found ${result.recordCount}); ` +
            'automatic compaction disabled until reload',
        )
      }
      this.deltaConflict = true
    }
    this.expectedDeltaBytes = result.size
    this.expectedDeltaRecords = result.recordCount
  }

  /**
   * 惰性加载引用索引（base + delta 合并）。首次查引用/调用层次才读盘：
   * 68k 文件索引实测省下激活时 194ms 与 69MB 常驻内存。
   */
  private async ensureNameIndex(): Promise<NameIndexData | undefined> {
    const nameIndexPath = this.nameIndexPathValue
    if (!nameIndexPath) {
      return undefined
    }
    if (this.nameIndexLoadedValue) {
      return this.nameIndexValue
    }
    if (!this.nameIndexLoadPromise) {
      this.nameIndexLoadPromise = (async () => {
        try {
          const started = Date.now()
          const loaded = await loadNameIndexWithDelta(nameIndexPath)
          this.nameIndexValue = loaded
          this.nameIndexLoadedValue = true
          this.logger.info(
            `reference index loaded lazily in ${Date.now() - started}ms` +
              (loaded ? ` (${loaded.filePaths.length} files)` : ' (missing)'),
          )
          return loaded
        } catch (error) {
          this.logger.warn('cannot load reference index', error)
          return undefined
        } finally {
          this.nameIndexLoadPromise = undefined
        }
      })()
    }
    return this.nameIndexLoadPromise
  }

  /**
   * 增量维护：只往 delta 文件追加一条 KB 级记录，不重写整个索引。
   * 索引未加载时也无需加载，直接追加。
   */
  private async refreshNameIndexForFile(relPath: string, text: string): Promise<void> {
    const nameIndexPath = this.nameIndexPathValue
    if (!nameIndexPath) {
      return
    }
    try {
      const hashes = collectIdentifierHashes(text)
      if (this.nameIndexLoadedValue && this.nameIndexValue) {
        this.nameIndexValue = upsertFileIndex(this.nameIndexValue, relPath, hashes)
      }
      await appendNameIndexDelta(nameIndexDeltaPath(nameIndexPath), {
        kind: 'set',
        path: relPath,
        hashes,
      })
      await this.compactNameIndexIfNeeded()
    } catch (error) {
      this.logger.warn('name index update failed', error)
    }
  }

  private async removeNameIndexForFile(relPath: string): Promise<void> {
    const nameIndexPath = this.nameIndexPathValue
    if (!nameIndexPath) {
      return
    }
    try {
      if (this.nameIndexLoadedValue && this.nameIndexValue) {
        this.nameIndexValue = removeFileIndex(this.nameIndexValue, relPath)
      }
      await appendNameIndexDelta(nameIndexDeltaPath(nameIndexPath), {
        kind: 'remove',
        path: relPath,
        hashes: new Uint32Array(0),
      })
      await this.compactNameIndexIfNeeded()
    } catch (error) {
      this.logger.warn('name index removal failed', error)
    }
  }

  /** delta 超过阈值（或 force）时合并回 base 并清空 delta。 */
  private async compactNameIndexIfNeeded(force = false): Promise<void> {
    const nameIndexPath = this.nameIndexPathValue
    if (!nameIndexPath) {
      return
    }
    try {
      const deltaBytes = await nameIndexDeltaBytes(nameIndexDeltaPath(nameIndexPath))
      if (!force && deltaBytes < NAME_INDEX_COMPACT_BYTES) {
        return
      }
      if (deltaBytes === 0 && !force) {
        return
      }
      const merged = await this.ensureNameIndex()
      if (!merged) {
        return
      }
      const started = Date.now()
      await compactNameIndex(nameIndexPath, merged)
      this.logger.info(
        `reference index compacted (${deltaBytes} delta bytes) in ${Date.now() - started}ms`,
      )
    } catch (error) {
      this.logger.warn('reference index compaction failed', error)
    }
  }

  private async removeNameIndexFile(): Promise<void> {
    const nameIndexPath = this.nameIndexPathValue
    if (!nameIndexPath) {
      return
    }
    this.nameIndexValue = undefined
    this.nameIndexLoadedValue = false
    this.nameIndexLoadPromise = undefined
    for (const target of [nameIndexPath, nameIndexDeltaPath(nameIndexPath)]) {
      try {
        await fs.promises.unlink(target)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code
        if (code !== 'ENOENT') {
          this.logger.warn(`cannot remove index file ${target}`, error)
        }
      }
    }
  }

  /** 硬安全上限：overlay 变更数或 delta 字节数过大时必须合并（与 autoCompact 无关）。 */
  private exceedsSafetyCap(pendingChanges: number, deltaBytes: number): boolean {
    return (
      pendingChanges >= SNAPSHOT_OVERLAY_HARD_CHANGES ||
      deltaBytes >= SNAPSHOT_DELTA_HARD_BYTES
    )
  }

  /** 阈值/空闲触发 compaction（写 base + 清 delta），不再每次保存全量写盘。 */
  private async scheduleCompaction(): Promise<void> {
    const snapshotPath = this.snapshotPathValue
    if (!snapshotPath || this.disposed || this.compacting) return
    const config = readConfig()
    if (this.deltaConflict) return
    try {
      const index = this.mutableValue
      if (!index) return
      const deltaBytes = await snapshotDeltaBytes(snapshotDeltaPath(snapshotPath))
      const pendingChanges = index.pendingChanges
      const safety = this.exceedsSafetyCap(pendingChanges, deltaBytes)
      if (!config.autoCompact) {
        // autoCompact=false：关闭空闲/累计变更合并，delta 仍逐次 append 落盘；
        // 但到达硬安全上限时必须强制合并，避免 overlay 无限增长拖慢所有查询。
        if (!safety) return
        this.logger.warn(
          `autoCompact disabled: safety compaction at ${pendingChanges} changed files / ` +
            `${deltaBytes} delta bytes`,
        )
        await this.compactNow()
        return
      }
      const shouldCompact =
        safety || deltaBytes >= SNAPSHOT_COMPACT_BYTES || pendingChanges >= SNAPSHOT_COMPACT_CHANGES
      if (!shouldCompact) {
        this.armIdleCompaction()
        return
      }
      await this.compactNow()
    } catch (error) {
      this.logger.warn('snapshot compaction scheduling failed', error)
    }
  }

  private armIdleCompaction(): void {
    if (this.compactTimer) clearTimeout(this.compactTimer)
    if (!this.snapshotPathValue) return
    // autoCompact 关闭时不再排空闲合并（delta 继续逐次 append，不丢数据）。
    if (!readConfig().autoCompact) return
    this.compactTimer = setTimeout(() => {
      this.compactTimer = undefined
      // 定时器可能是在 autoCompact=true 时排下的：触发时重新读配置，关闭则跳过。
      if (!readConfig().autoCompact) return
      void this.compactNow()
    }, SNAPSHOT_IDLE_COMPACT_MS)
    try {
      this.compactTimer.unref?.()
    } catch {
      // ignore
    }
  }

  /**
   * compaction 入口：同一时刻只允许一个 compaction。
   * 已在运行时直接复用其 promise（flush 依赖它等待在途 compaction 完成），
   * 结束后（成功/放弃/失败）再按需重新排期，接住 compaction 期间到达的变更。
   */
  private compactNow(): Promise<void> {
    const running = this.compactPromise
    if (running) return running
    if (!this.snapshotPathValue || !this.mutableValue) {
      return Promise.resolve()
    }
    const settled = this.runCompaction()
    const promise: Promise<void> = settled
      // 终止性 catch：compactPromise 永不 reject，idle timer / dispose 里的 `void compactNow()`
      // 以及 flush 的 await 都不会产生 unhandled rejection（runCompaction 内部已记录日志）。
      .catch((error) => {
        this.logger.warn('snapshot compaction failed', error)
      })
      .finally(() => {
        if (this.compactPromise === promise) {
          this.compactPromise = undefined
        }
      })
      .then(() => undefined)
    this.compactPromise = promise
    // 必须在 compactPromise 清空之后再重排（.finally 先注册，所以它的回调先跑）；
    // 失败（false）不重排：避免持续失败时形成热重试，下一次提交会重新触发调度。
    void settled.then(
      (shouldReschedule) => {
        if (shouldReschedule) this.rescheduleAfterCompaction()
      },
      () => undefined,
    )
    return promise
  }

  /**
   * compaction abort 路径统一收尾 deferred（**只补追加，不重放**）。
   *
   * deferred 里的变更在进入列表时已经 apply 到当时的 live mutable 索引内存里，只是
   * delta 追加被 compaction 推迟。abort 后若该索引仍是 live（build 取消/失败等），
   * 只需补一次 `enqueueAppend` 保证崩溃后不丢，**绝不能重新 apply**：旧记录可能比
   * 已经合入新 base 的更新编辑更旧，重放会把内存/磁盘回退成旧值。
   *
   * 若 live 索引已被替换或清空（build 成功、clearCache、loadFromDisk、另一次 swap），
   * 新整表快照/删除已经覆盖这些变更，直接丢弃即可。
   */
  private settleDeferredOnAbort(index: MutableSymbolIndex | undefined): void {
    const deferred = this.deferredDuringCompaction
    if (deferred.length === 0) return
    this.deferredDuringCompaction = []
    if (index === undefined || this.mutableValue !== index) return
    for (const change of deferred) {
      this.enqueueAppend(change)
    }
  }

  /**
   * 实际 compaction。顺序很关键（否则会丢记录）：
   *   1. 等所有在途 delta 追加落盘（appendChain + flushSnapshotDeltaAppends）
   *   2. 进入 compacting 状态：新变更先入 deferred，不写 delta
   *   3. flatten 当前 overlay（包含此前全部变更）→ 原子写 base（saveSnapshot）→ 清 delta
   *   4. 换成基于新 base 的 mutable index，回放 deferred（内存 + delta），退出 compacting
   *
   * 每个 await 之后都校验 epoch / mutable 身份 / building：build、clearCache、loadFromDisk
   * 已经换掉整张表时，本次捕获的 flat 属于旧表，既不能写盘，也不能把旧索引换回内存。
   *
   * 返回值表示结束后是否需要重排（success/abort 为 true；失败为 false，避免热重试）。
   */
  private async runCompaction(): Promise<boolean> {
    const snapshotPath = this.snapshotPathValue
    const index = this.mutableValue
    if (!snapshotPath || !index) return true
    const epoch = this.indexEpoch
    this.compacting = true
    const stale = (): boolean =>
      this.indexEpoch !== epoch || this.mutableValue !== index || this.buildingValue
    try {
      await this.appendChain
      if (stale()) {
        this.settleDeferredOnAbort(index)
        return true
      }
      await flushSnapshotDeltaAppends()
      if (stale()) {
        this.settleDeferredOnAbort(index)
        return true
      }
      const deltaPath = snapshotDeltaPath(snapshotPath)
      const deltaBytes = await snapshotDeltaBytes(deltaPath)
      if (stale()) {
        this.settleDeferredOnAbort(index)
        return true
      }
      // 共享 storage 的另一个窗口可能刚追加了记录：大小与预期不符（或已经确认混入对方
      // 记录）时，绝不能写 base 后删除 delta——那会静默丢掉对方尚未重放的变更。
      if (
        this.deltaConflict ||
        (this.expectedDeltaBytes !== undefined && deltaBytes !== this.expectedDeltaBytes)
      ) {
        if (!this.deltaConflict) {
          this.deltaConflict = true
          this.logger.warn(
            `snapshot delta changed by another window (${deltaBytes} B, expected ` +
              `${this.expectedDeltaBytes} B); compaction skipped to keep its records`,
          )
          this.armIdleCompaction()
        }
        this.settleDeferredOnAbort(index)
        return false
      }
      if (index.pendingChanges === 0 && deltaBytes === 0) {
        // 无内容可合并，但仍走统一收尾（空列表时是 no-op），与其余 abort 分支语义一致。
        this.settleDeferredOnAbort(index)
        return true
      }
      const flat = index.flatten()
      // 写 base 前最后一次校验：重建/清缓存之后不能再把旧 flat 写成 base。
      if (stale()) {
        this.settleDeferredOnAbort(index)
        return true
      }
      const started = Date.now()
      const { baseBytes, deltaTruncated, deltaKeptConflict } = await compactSnapshot(
        snapshotPath,
        flat,
        { expectedDeltaBytes: this.expectedDeltaBytes },
      )
      if (deltaKeptConflict) {
        // 写 base 与删除 delta 之间另一个窗口追加了记录：delta 必须保留（下次加载会重放）。
        // 预期状态保持原样（不归零），并禁用本进程后续自动 compaction，直到重载。
        this.deltaConflict = true
        const actualDeltaBytes = await snapshotDeltaBytes(deltaPath)
        this.logger.warn(
          `snapshot delta changed during compaction (${actualDeltaBytes} B, expected ` +
            `${this.expectedDeltaBytes} B); keeping it and disabling automatic compaction ` +
            'until reload',
        )
      } else {
        // delta 已被合并进新 base 并删除：本进程的预期归零，恢复警告随损坏 delta 一起消失；
        // 后续 deferred 追加会重新累计。
        this.expectedDeltaBytes = 0
        this.expectedDeltaRecords = 0
        this.deltaConflict = false
        this.deltaWarningValue = undefined
      }
      // 写盘期间整表被替换（rebuild / clearCache / 再次 load）：放弃 swap，保留新索引。
      if (stale()) {
        if (this.mutableValue === undefined) {
          // 索引已被清空（clearCache）：写盘可能落在删除之后，删掉这份过期 base，避免复活。
          // 只能删文件：unlink 的 await 窗口里 rebuild 可能已装回新的 live 索引，
          // 复用 removeSnapshotFile() 会把新索引/deferred 一起清空。
          await this.removeSnapshotFilesOnly()
        }
        // 写盘落地后 abort 同样要排空 deferred：旧记录不能留到下一次 compaction 重放。
        this.settleDeferredOnAbort(index)
        return true
      }
      this.logger.info(
        `snapshot compacted: ${baseBytes} bytes in ${Date.now() - started}ms` +
          (deltaTruncated ? ' (delta cleared)' : ''),
      )

      const next = createMutableIndex(flat)
      const deferred = this.deferredDuringCompaction
      this.deferredDuringCompaction = []
      this.mutableValue = next
      this.snapshotValue = next
      // 整表换新（flat 身份变了）：旧的路径集合缓存随之释放，避免继续占着上一代 Set。
      this.indexedPathsCache = undefined
      // 成功换表：代际 +1，任何更早捕获旧索引的 compaction 都随之作废。
      this.indexEpoch += 1
      for (const change of deferred) {
        if (change.remove) next.removeFile(change.path)
        else {
          next.applyFile(change.file, change.entries)
          // include 边一并回放到换表后的 overlay（flat 里没有这些迟到变更的边）
          next.applyIncludes(change.path, change.includes)
        }
        this.enqueueAppend(change)
      }
      await this.appendChain
      // 回放期间 await 让出事件循环，可能又有变更落入新的 deferred。这里再排空一次：
      // 否则这些变更只改了内存、delta 没写盘，崩溃后会丢失。
      while (this.deferredDuringCompaction.length > 0) {
        const late = this.deferredDuringCompaction
        this.deferredDuringCompaction = []
        for (const change of late) {
          if (change.remove) next.removeFile(change.path)
          else {
            next.applyFile(change.file, change.entries)
            next.applyIncludes(change.path, change.includes)
          }
          this.enqueueAppend(change)
        }
        await this.appendChain
      }
      return true
    } catch (error) {
      this.logger.warn('snapshot compaction failed', error)
      // 与 settleDeferredOnAbort 语义对齐：只有捕获的索引仍 live 时才重新入队为普通 append
      //（内存索引不动），整表已被替换/清空时直接丢弃，避免旧索引记录被追加到新 base 的 delta。
      this.settleDeferredOnAbort(index)
      return false
    } finally {
      this.compacting = false
    }
  }

  /**
   * compaction 结束后重排：compaction 期间到达的变更需要再走一次调度（可能触发下一次
   * compaction，也可能只是 arm idle timer），不能在 compacting 状态里就地 re-arm。
   */
  private rescheduleAfterCompaction(): void {
    if (this.disposed || this.buildingValue) return
    const index = this.mutableValue
    if (!index) return
    if (index.pendingChanges > 0) {
      void this.scheduleCompaction()
      return
    }
    const snapshotPath = this.snapshotPathValue
    if (!snapshotPath) return
    void snapshotDeltaBytes(snapshotDeltaPath(snapshotPath))
      .then((bytes) => {
        if (bytes > 0 && !this.disposed && !this.buildingValue && !this.compacting) {
          void this.scheduleCompaction()
        }
      })
      .catch(() => undefined)
  }

  /** 只删除 base + delta 文件，不动内存状态（stale-abort 路径专用）。 */
  private async removeSnapshotFilesOnly(): Promise<void> {
    const snapshotPath = this.snapshotPathValue
    if (!snapshotPath) return
    for (const target of [snapshotPath, snapshotDeltaPath(snapshotPath)]) {
      try {
        await fs.promises.unlink(target)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code
        if (code !== 'ENOENT') this.logger.warn(`cannot remove index file ${target}`, error)
      }
    }
  }

  /** 删除快照文件与 delta（清缓存 / 构建期间清缓存的竞态兜底），并清空内存索引状态。 */
  private async removeSnapshotFile(): Promise<void> {
    if (!this.snapshotPathValue) return
    // 先等在途 append 落盘再删文件：否则删除后落地的 append 会在磁盘上「复活」一条
    // 属于旧索引的 delta（下次启动被重放到已清空的 base 上）。
    await this.appendChain
    await this.removeSnapshotFilesOnly()
    this.appendChain = Promise.resolve()
    this.snapshotValue = undefined
    this.mutableValue = undefined
    // 索引已清空：路径集合缓存不再对应任何活表，直接释放。
    this.indexedPathsCache = undefined
    this.deferredDuringCompaction = []
    this.expectedDeltaBytes = 0
    this.expectedDeltaRecords = 0
    this.deltaConflict = false
    this.deltaWarningValue = undefined
  }

  /**
   * deactivate 前把 overlay 合并回 base（顺带清空 delta），并把引用索引 delta 合并回 base。
   *
   * `sourceInsight.autoCompact=false` 时只等待已排队的 delta 追加落盘（不丢数据），
   * 不发起新的快照/引用索引 compaction（合并留给用户重新启用后或显式重建）。
   */
  async flush(): Promise<void> {
    if (this.compactTimer) {
      clearTimeout(this.compactTimer)
      this.compactTimer = undefined
    }
    await this.appendChain
    // 先等在途 compaction：否则 flush 返回时仍可能有写盘在途（与 autoCompact 无关）。
    await this.compactPromise
    if (!readConfig().autoCompact) {
      const snapshotPath = this.snapshotPathValue
      const pendingChanges = this.mutableValue?.pendingChanges ?? 0
      const deltaBytes = snapshotPath
        ? await snapshotDeltaBytes(snapshotDeltaPath(snapshotPath))
        : 0
      if (!this.exceedsSafetyCap(pendingChanges, deltaBytes)) {
        this.logger.info('autoCompact disabled; delta appended, snapshot compaction skipped')
        return
      }
      // 关闭自动合并只推迟合并：到达硬上限时关闭路径也要合并，避免下次启动重放超大 delta。
      this.logger.warn(
        `autoCompact disabled: safety compaction at ${pendingChanges} changed files / ` +
          `${deltaBytes} delta bytes`,
      )
    }
    await this.compactNow()
    await this.compactNameIndexIfNeeded(true)
  }

  /** 清空内存索引 + 删除快照文件（"清除索引缓存"命令）。 */
  async clearCache(): Promise<void> {
    this.generation += 1
    // 整表作废：代际 +1 让在途 compaction 的 stale 检查立即失败；同时清 identity-keyed 查询缓存。
    this.indexEpoch += 1
    clearReferenceCache()
    clearCallGraphCache()
    this.clearRequested = this.buildingValue
    this.snapshotValue = undefined
    this.lastSummaryValue = undefined
    this.budgetReportValue = undefined
    this.budgetReportKey = undefined
    this.budgetPromptedValue = false
    this.lastErrorValue = undefined
    this.progressValue = undefined
    this.textCache.clear()
    this.textCacheChars = 0
    this.excludeCache = undefined
    this.mutableValue = undefined
    // 整表清空：释放「索引内路径集合」缓存（可能仍有最后一次保存留下的 O(文件数) Set）。
    this.indexedPathsCache = undefined
    // 等在途 delta 追加落盘后再重置 chain：否则删除文件后到达的 append 会把旧记录写回，
    // 形成下次启动会被重放的「幽灵 delta」。
    await this.appendChain
    this.appendChain = Promise.resolve()
    this.deferredDuringCompaction = []
    this.compacting = false
    this.expectedDeltaBytes = 0
    this.expectedDeltaRecords = 0
    this.deltaConflict = false
    this.deltaWarningValue = undefined
    if (this.compactTimer) {
      clearTimeout(this.compactTimer)
      this.compactTimer = undefined
    }
    this.nameIndexValue = undefined
    await this.removeSnapshotFile()
    await this.removeNameIndexFile()
    if (!this.disposed) {
      this.changeEmitter.fire()
    }
  }

  private async loadFromDisk(): Promise<void> {
    const snapshotPath = this.snapshotPathValue
    if (!snapshotPath) {
      return
    }
    const deltaPath = snapshotDeltaPath(snapshotPath)
    try {
      const snapshot = await loadSnapshot(snapshotPath)
      if (!snapshot) {
        // 没有 base 时 delta 无法重放：只记录当前大小，交给下一次 build 正常清理。
        this.expectedDeltaBytes = await snapshotDeltaBytes(deltaPath)
        this.expectedDeltaRecords = 0
        return
      }
      if (!Array.isArray(snapshot.files) || typeof snapshot.entryCount !== 'number') {
        this.logger.warn('snapshot has invalid shape; ignored')
        this.expectedDeltaBytes = await snapshotDeltaBytes(deltaPath)
        this.expectedDeltaRecords = 0
        return
      }
      // 升级路径：本任务之前（2ffa868）写出的 v4 快照版本号正确，但文件记录没有内容哈希、
      // include CSR 为空、条目无条件。接受它会让 B1/B2/B4 一直失效到每个文件被编辑或清缓存。
      // 因此「有文件但至少一个文件没有哈希」视为旧的无效 v4：删掉 base + 无法独立重放的
      // delta，交给 ensureBuilt() 重建。重建后的快照每个成功入表文件都带哈希
      //（hashContent64 对空内容也非 0/0），所以下一次加载不会再命中这里，不会循环。
      const legacyWithoutMetadata =
        snapshot.files.length > 0 &&
        snapshot.files.some((file) => snapshot.contentHashOf(file.path) === undefined)
      if (legacyWithoutMetadata) {
        this.logger.warn('legacy v4 snapshot without v4 metadata; rebuilding')
        for (const target of [snapshotPath, deltaPath]) {
          try {
            await fs.promises.unlink(target)
          } catch {
            // 文件可能已不存在：删除失败不影响重建
          }
        }
        this.expectedDeltaBytes = 0
        this.expectedDeltaRecords = 0
        this.deltaConflict = false
        this.deltaWarningValue = undefined
        return
      }
      const deltaResult = await readSnapshotDeltasDetailed(deltaPath)
      // 记录本进程看到的 delta 状态：之后 compaction 写 base 前用它判断文件是否被另一个窗口改过。
      const deltaBytesOnDisk = await snapshotDeltaBytes(deltaPath)
      this.expectedDeltaBytes = deltaBytesOnDisk
      this.expectedDeltaRecords = deltaResult.records.length
      this.deltaConflict = false
      if (deltaResult.error || deltaResult.droppedBytes > 0) {
        // 头部非法（SIDD/版本不符）时整个文件都不可解码：droppedBytes 等于文件大小且没有
        // 任何有效记录。这与「尾部写到一半被截断」是两种不同的损坏，恢复提示要区分开。
        const corruptedWholeFile =
          deltaResult.records.length === 0 &&
          deltaResult.droppedBytes === deltaBytesOnDisk &&
          deltaBytesOnDisk > 0
        const detail = deltaResult.error
          ? `cannot read snapshot delta: ${deltaResult.error}`
          : corruptedWholeFile
            ? `ignored a corrupted snapshot delta (${deltaResult.droppedBytes} bytes, no valid records)`
            : `dropped ${deltaResult.droppedBytes} bytes of an incomplete snapshot delta tail`
        this.deltaWarningValue = detail
        this.logger.warn(`snapshot delta recovery: ${detail}`)
      } else {
        this.deltaWarningValue = undefined
      }
      this.mutableValue = createMutableIndexFromDeltas(snapshot, deltaResult.records)
      this.snapshotValue = this.mutableValue
      // 新载入的整表：代际 +1，并清掉可能仍指向旧表身份的查询缓存
      this.indexEpoch += 1
      clearReferenceCache()
      clearCallGraphCache()
      // 引用索引惰性加载：只在首次查引用/调用层次时读盘
      this.nameIndexValue = undefined
      this.nameIndexLoadedValue = false
      // 磁盘加载的索引也要评估预算：否则重启后大索引用不到警告（旧实现直接比较 live entryCount）。
      this.evaluateIndexBudget(this.entryCount, this.fileCount)
      this.logger.info(
        `snapshot loaded: files=${snapshot.files.length} entries=${snapshot.entryCount} ` +
          `delta=${deltaResult.records.length} records builtAt=${new Date(snapshot.builtAt).toISOString()}`,
      )
    } catch (error) {
      // 快照损坏/版本不符：删除 base 和无法重放的 orphan delta，等待重建，不弹错误（spec §8）
      this.logger.warn('snapshot load failed; will rebuild on demand', error)
      for (const target of [snapshotPath, deltaPath]) {
        try {
          await fs.promises.unlink(target)
        } catch {
          // ignore
        }
      }
      this.expectedDeltaBytes = 0
      this.expectedDeltaRecords = 0
      this.deltaConflict = false
    }
  }

  private async ensureStorageDir(): Promise<void> {
    const snapshotPath = this.snapshotPathValue
    if (!snapshotPath) {
      return
    }
    try {
      await fs.promises.mkdir(path.dirname(snapshotPath), { recursive: true })
    } catch (error) {
      this.logger.warn(`cannot create storage directory for ${snapshotPath}`, error)
    }
  }

  private async readFileCached(relPath: string): Promise<string> {
    const cached = this.textCache.get(relPath)
    if (cached !== undefined) {
      this.textCache.delete(relPath)
      this.textCache.set(relPath, cached)
      return cached
    }
    const text = await this.readFile(relPath)
    this.textCache.set(relPath, text)
    this.textCacheChars += text.length
    while (
      (this.textCacheChars > SIGNATURE_CACHE_CHAR_BUDGET || this.textCache.size > MAX_TRACKED_CACHE_FILES) &&
      this.textCache.size > 1
    ) {
      const oldestKey = this.textCache.keys().next().value as string | undefined
      if (oldestKey === undefined) {
        break
      }
      const oldest = this.textCache.get(oldestKey) ?? ''
      this.textCache.delete(oldestKey)
      this.textCacheChars -= oldest.length
    }
    return text
  }

  private isUnderRoots(relPath: string): boolean {
    const rel = normalizeRelative(relPath)
    if (!rel || rel.startsWith('../')) {
      return false
    }
    return this.configuredRoots.some((root) => isUnderRoot(root, rel))
  }

  /** 通用查询包装：withProgress + CancellationToken -> AbortSignal，异常吞掉返回 fallback。 */
  private async queryWithProgress<T>(
    title: string,
    work: (signal: AbortSignal, report: (done: number, total: number) => void) => Promise<T>,
    token: vscode.CancellationToken | undefined,
    fallback: T,
  ): Promise<T> {
    try {
      return await withProgress<T>(title, async (progress, progressToken) => {
        const controller = new AbortController()
        const disposables: vscode.Disposable[] = []
        try {
          disposables.push(progressToken.onCancellationRequested(() => controller.abort()))
        } catch {
          // ignore
        }
        if (token) {
          try {
            disposables.push(token.onCancellationRequested(() => controller.abort()))
          } catch {
            // ignore
          }
        }
        const report = (done: number, total: number): void => {
          try {
            progress.report({
              message:
                total > 0
                  ? vscode.l10n.t('Scanned {0}/{1} files…', done, total)
                  : vscode.l10n.t('Scanning files…'),
            })
          } catch {
            // ignore
          }
        }
        try {
          const result = await work(controller.signal, report)
          return result
        } catch (error) {
          if (isAbortError(error)) {
            return fallback
          }
          this.logger.error(`${title} failed`, error)
          return fallback
        } finally {
          for (const disposable of disposables) {
            try {
              disposable.dispose()
            } catch {
              // ignore
            }
          }
        }
      })
    } catch (error) {
      this.logger.error(`${title} failed`, error)
      return fallback
    }
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.disposed = true
    this.generation += 1
    if (this.compactTimer) {
      clearTimeout(this.compactTimer)
      this.compactTimer = undefined
    }
    // deactivate 已先 await flush()；这里只对尚未合并的变更做尽力而为的落盘（不检查 disposed）。
    // autoCompact=false 时关闭路径同样不合并 base：delta 已由 appendChain 追加落盘。
    if (this.mutableValue && this.mutableValue.pendingChanges > 0 && readConfig().autoCompact) {
      void this.compactNow()
    }
    for (const disposable of this.disposables) {
      try {
        disposable.dispose()
      } catch {
        // ignore
      }
    }
    this.disposables.length = 0
    this.changeEmitter.dispose()
    this.progressEmitter.dispose()
  }
}

/** 取第一个 workspace folder 作为工作区根（多根工作区暂不支持，见 README 已知限制）。 */
function resolveWorkspaceRoot(): string | undefined {
  try {
    const folders = vscode.workspace.workspaceFolders
    if (folders && folders.length > 0) {
      const fsPath = folders[0]?.uri?.fsPath
      if (typeof fsPath === 'string' && fsPath) {
        return fsPath
      }
    }
  } catch (error) {
    console.error('[code-insight] cannot read workspace folders', error)
  }
  try {
    const legacyRootPath = (vscode.workspace as unknown as { rootPath?: unknown }).rootPath
    if (typeof legacyRootPath === 'string' && legacyRootPath) {
      return legacyRootPath
    }
  } catch {
    // ignore
  }
  return undefined
}

/** context.storageUri 优先，回退 globalStorageUri；都没有则返回 undefined（仅内存索引）。 */
function resolveSnapshotPath(context: vscode.ExtensionContext | undefined): string | undefined {
  try {
    const storage = context?.storageUri ?? context?.globalStorageUri
    const fsPath = extractFsPath(storage)
    if (!fsPath) {
      return undefined
    }
    return path.join(fsPath, SNAPSHOT_FILE_NAME)
  } catch (error) {
    console.error('[code-insight] cannot resolve storage URI', error)
    return undefined
  }
}

function extractFsPath(uri: unknown): string | undefined {
  if (!uri) {
    return undefined
  }
  if (typeof uri === 'string') {
    return uri || undefined
  }
  try {
    const fsPath = (uri as { fsPath?: unknown }).fsPath
    if (typeof fsPath === 'string' && fsPath) {
      return fsPath
    }
  } catch {
    // ignore
  }
  try {
    const uriPath = (uri as { path?: unknown }).path
    if (typeof uriPath === 'string' && uriPath) {
      return uriPath
    }
  } catch {
    // ignore
  }
  return undefined
}
