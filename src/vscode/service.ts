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

import { callersOf, calleesOf } from '../core/callgraph'
import { buildIndex, createSnapshot } from '../core/indexer'
import { entriesInFile, findByName, searchSymbols } from '../core/query'
import { findReferences } from '../core/references'
import { readSignature } from '../core/signature'
import { scanSource } from '../core/scan'
import { loadSnapshot, saveSnapshot } from '../core/store'
import { compileExclude } from '../core/exclude'
import {
  SNAPSHOT_VERSION,
  type BuildOptions,
  type BuildSummary,
  type CallerHit,
  type FileRecord,
  type IndexProgress,
  type IndexSnapshot,
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
import { isAbortError, withProgress, type ProgressLike } from './util'

const SNAPSHOT_FILE_NAME = 'symbols.sidx'
const SAVE_DEBOUNCE_MS = 3000
const SIGNATURE_CACHE_CHAR_BUDGET = 8 * 1024 * 1024
const MAX_TRACKED_CACHE_FILES = 256

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

  private snapshotValue: IndexSnapshot | undefined
  private lastSummaryValue: BuildSummary | undefined
  private lastErrorValue: string | undefined
  private progressValue: IndexProgress | undefined
  private buildingValue = false
  private disposed = false
  private generation = 0
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private pendingSave = false
  private clearRequested = false
  private excludeCache: { readonly key: string; readonly matches: (relPath: string) => boolean } | undefined

  /** 签名/树视图用的文件文本缓存（按字符总量封顶，避免大仓库撑爆内存）。 */
  private readonly textCache = new Map<string, string>()
  private textCacheChars = 0

  private readonly readFileBound: ReadFileFn = (relPath) => this.readFile(relPath)

  private constructor(context: vscode.ExtensionContext | undefined, logger: Logger) {
    this.logger = logger
    this.workspaceRootValue = resolveWorkspaceRoot()
    this.snapshotPathValue = resolveSnapshotPath(context)
    this.onDidChange = this.changeEmitter.event
    this.onProgress = this.progressEmitter.event
    if (!this.workspaceRootValue) {
      this.logger.warn('no workspace folder; index is disabled until a folder is opened')
    }
    if (!this.snapshotPathValue) {
      this.logger.warn('no storage URI available; index will not be persisted')
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

  get snapshot(): IndexSnapshot | undefined {
    return this.snapshotValue
  }

  get ready(): boolean {
    return this.snapshotValue !== undefined
  }

  get building(): boolean {
    return this.buildingValue
  }

  get entryCount(): number {
    return this.snapshotValue?.entries.length ?? 0
  }

  get fileCount(): number {
    return this.snapshotValue?.files.length ?? 0
  }

  get builtAt(): number | undefined {
    return this.snapshotValue?.builtAt
  }

  get lastSummary(): BuildSummary | undefined {
    return this.lastSummaryValue
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
        findReferences(snapshot, name, this.readFileBound, { signal, onProgress: report }),
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
      async (signal, report) => callersOf(snapshot, name, this.readFileBound, { signal, onProgress: report }),
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
            followSymlinks: config.followSymlinks,
            previous: this.snapshotValue,
            snapshotPath: this.snapshotPathValue,
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
          this.snapshotValue = result.snapshot
          this.lastSummaryValue = result.summary
          this.textCache.clear()
          this.textCacheChars = 0
          // buildIndex 约定：snapshotPath 提供时自己写盘并回填 snapshotBytes；
          // 若 A 的实现尚未落地，这里兜底写盘，保证快照不丢。
          if (this.snapshotPathValue && result.summary.snapshotBytes === 0 && result.snapshot.entries.length >= 0) {
            try {
              const bytes = await saveSnapshot(this.snapshotPathValue, result.snapshot)
              this.lastSummaryValue = { ...result.summary, snapshotBytes: bytes }
            } catch (error) {
              this.logger.warn('snapshot fallback save failed', error)
            }
          }
          return this.lastSummaryValue ?? result.summary
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
            `duration=${summary.durationMs}ms bytes=${summary.snapshotBytes}`,
        )
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
      const entries: SymbolEntry[] = symbols.map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        file: rel,
        line: symbol.line,
        endLine: symbol.endLine,
        column: symbol.column,
      }))
      this.commitSnapshot(rel, entries, stat.mtimeMs, stat.size)
      this.logger.info(`incremental update: ${rel} (${entries.length} symbols)`)
    } catch (error) {
      if (!isAbortError(error)) {
        this.logger.error(`updateFile failed: ${absPath}`, error)
      }
    }
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
        snapshot.entries.some((entry) => entry.file === rel)
      if (!existed) {
        return
      }
      this.commitSnapshot(rel, [], 0, 0, true)
      this.logger.info(`incremental remove: ${rel}`)
    } catch (error) {
      this.logger.error(`removeFile failed: ${absPath}`, error)
    }
  }

  private commitSnapshot(
    relPath: string,
    entries: readonly SymbolEntry[],
    mtimeMs: number,
    size: number,
    remove = false,
  ): void {
    const snapshot = this.snapshotValue
    if (!snapshot) {
      return
    }
    let files: FileRecord[] = snapshot.files.filter((record) => record.path !== relPath)
    if (!remove) {
      files.push({ path: relPath, mtimeMs, size })
    }
    const keptEntries = snapshot.entries.filter((entry) => entry.file !== relPath)
    const allEntries = remove ? keptEntries : [...keptEntries, ...entries]
    this.snapshotValue = this.snapshotSafe([...snapshot.roots], files, allEntries)
    this.lastSummaryValue = undefined
    this.changeEmitter.fire()
    this.scheduleSave()
  }

  /** core.createSnapshot 尚未就绪时的本地兜底（保证增量更新不丢失顺序语义）。 */
  private snapshotSafe(
    roots: readonly string[],
    files: readonly FileRecord[],
    entries: readonly SymbolEntry[],
  ): IndexSnapshot {
    try {
      return createSnapshot(roots, files, entries)
    } catch (error) {
      this.logger.warn('createSnapshot unavailable, using local fallback', error)
    }
    const sortedFiles = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const sortedEntries = [...entries].sort((a, b) => {
      if (a.file !== b.file) {
        return a.file < b.file ? -1 : 1
      }
      if (a.line !== b.line) {
        return a.line - b.line
      }
      return a.column - b.column
    })
    return {
      version: SNAPSHOT_VERSION,
      roots: [...roots],
      builtAt: Date.now(),
      files: sortedFiles,
      entries: sortedEntries,
    }
  }

  private scheduleSave(): void {
    if (!this.snapshotPathValue || this.disposed) {
      return
    }
    this.pendingSave = true
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined
      void this.saveNow()
    }, SAVE_DEBOUNCE_MS)
    try {
      this.saveTimer.unref?.()
    } catch {
      // ignore
    }
  }

  private async saveNow(): Promise<void> {
    if (this.disposed) {
      return
    }
    await this.persistNow()
  }

  /** 实际落盘（dispose 时也允许尽力而为地写一次，因此不检查 disposed）。 */
  private async persistNow(): Promise<void> {
    const snapshot = this.snapshotValue
    const snapshotPath = this.snapshotPathValue
    if (!snapshot || !snapshotPath) {
      this.pendingSave = false
      return
    }
    try {
      await this.ensureStorageDir()
      const bytes = await saveSnapshot(snapshotPath, snapshot)
      this.pendingSave = false
      this.logger.info(`snapshot saved: ${bytes} bytes`)
    } catch (error) {
      this.logger.warn('save snapshot failed', error)
    }
  }

  /** 删除快照文件（清缓存 / 构建期间清缓存的竞态兜底）。 */
  private async removeSnapshotFile(): Promise<void> {
    const snapshotPath = this.snapshotPathValue
    if (!snapshotPath) {
      return
    }
    try {
      await fs.promises.unlink(snapshotPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code !== 'ENOENT') {
        this.logger.warn('cannot remove snapshot file', error)
      }
    }
  }

  /** deactivate 前把防抖中的增量快照落盘。 */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    if (this.pendingSave) {
      await this.persistNow()
    }
  }

  /** 清空内存索引 + 删除快照文件（"清除索引缓存"命令）。 */
  async clearCache(): Promise<void> {
    this.generation += 1
    this.clearRequested = this.buildingValue
    this.snapshotValue = undefined
    this.lastSummaryValue = undefined
    this.lastErrorValue = undefined
    this.progressValue = undefined
    this.textCache.clear()
    this.textCacheChars = 0
    this.excludeCache = undefined
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    this.pendingSave = false
    await this.removeSnapshotFile()
    if (!this.disposed) {
      this.changeEmitter.fire()
    }
  }

  private async loadFromDisk(): Promise<void> {
    const snapshotPath = this.snapshotPathValue
    if (!snapshotPath) {
      return
    }
    try {
      const snapshot = await loadSnapshot(snapshotPath)
      if (!snapshot) {
        return
      }
      if (!Array.isArray(snapshot.files) || !Array.isArray(snapshot.entries)) {
        this.logger.warn('snapshot has invalid shape; ignored')
        return
      }
      this.snapshotValue = snapshot
      this.logger.info(
        `snapshot loaded: files=${snapshot.files.length} entries=${snapshot.entries.length} ` +
          `builtAt=${new Date(snapshot.builtAt).toISOString()}`,
      )
    } catch (error) {
      // 快照损坏/版本不符：删除后等待重建，不弹错误（spec §8）
      this.logger.warn('snapshot load failed; will rebuild on demand', error)
      try {
        await fs.promises.unlink(snapshotPath)
      } catch {
        // ignore
      }
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
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    if (this.pendingSave) {
      void this.persistNow()
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
