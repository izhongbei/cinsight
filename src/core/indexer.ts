import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { Worker } from 'node:worker_threads'
import { SNAPSHOT_VERSION } from '../shared/types'
import type {
  BuildOptions,
  BuildSummary,
  FileRecord,
  ReadFileFn,
  ScannedFileResult,
  ScannedInclude,
  ScannedSymbol,
  SymbolEntry,
  SymbolTable,
} from '../shared/types'
import { hashContent64 } from './hash'
import { resolveIncludePaths } from './include-resolve'
import { buildNameIndex, collectIdentifierHashes, loadNameIndex, saveNameIndex } from './nameindex'
import { createSymbolTable } from './symbol-table'
import { scanIncludes, scanSource } from './scan'
import { saveSnapshot } from './store'
import { walkFiles } from './walk'

/**
 * 并行索引构建（A）。
 *
 * 流程：walk → 与旧快照按 `mtimeMs + size` 比对 → 变更文件走 worker 池并行 `scanSource`
 * → 合并 → 可选写盘。worker 不可用/崩溃时自动退化为主线程串行，不中断构建。
 */

const DEFAULT_CONCURRENCY = 4
const WORKER_SCRIPT = path.join(__dirname, 'worker-scan.js')

function makeAbortError(): Error {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw makeAbortError()
}

function normalizeConcurrency(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_CONCURRENCY
  return Math.min(64, Math.max(1, Math.floor(value)))
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * 归一 indexRoot，用于「本次构建 vs 旧快照」比较（规则与 walk 的 `toRelativeRoot` 对齐）：
 * `\`→`/`、折叠重复 `/`、去前导 `./`、`.`→空、去尾部 `/`、绝对路径相对化到 workspaceRoot。
 * 未提供 workspaceRoot（例如没有打开工作区）时不做绝对路径相对化。
 */
function normalizeRootPath(workspaceRoot: string | undefined, root: string): string {
  let rel = root
  if (workspaceRoot !== undefined && path.isAbsolute(rel)) {
    rel = path.relative(workspaceRoot, rel)
  }
  rel = rel.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  while (rel.startsWith('./')) rel = rel.slice(2)
  if (rel === '.') rel = ''
  return rel.replace(/\/+$/, '')
}

function normalizeRoots(workspaceRoot: string | undefined, roots: readonly string[]): string[] {
  return roots.map((root) => normalizeRootPath(workspaceRoot, root))
}

/** 顺序敏感：roots 顺序决定 include 的 root 前缀搜索顺序，顺序变了也要重新解析。 */
function sameRoots(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

/**
 * 归一后顺序敏感的 roots 比较（indexer 与 service.rootsChanged 共用）。
 *
 * - 归一等价（`proj/` vs `proj`、`./proj` vs `proj`、绝对 vs 相对）不算变化；
 * - 仅顺序变化（`['a','b']` vs `['b','a']`）**算**变化 —— include 的 root 前缀搜索顺序
 *   是语义的一部分，必须让调用方重新解析。
 */
export function indexRootsChanged(
  workspaceRoot: string | undefined,
  previous: readonly string[],
  current: readonly string[],
): boolean {
  return !sameRoots(
    normalizeRoots(workspaceRoot, previous),
    normalizeRoots(workspaceRoot, current),
  )
}

/** 组装符号表：文件与符号都做稳定排序，索引查询走 name/file 两个维度。 */
export function createSnapshot(
  roots: readonly string[],
  files: readonly FileRecord[],
  entries: readonly SymbolEntry[],
  includes?: ReadonlyMap<string, readonly string[]>,
): SymbolTable {
  return createSymbolTable(roots, files, entries, Date.now(), SNAPSHOT_VERSION, { includes })
}

// --------------------------------------------------------------- worker pool

interface WorkerReply {
  id: number
  symbols?: ScannedSymbol[]
  hashes?: Uint32Array
  contentHash?: { lo: number; hi: number }
  includes?: ScannedInclude[]
  error?: string
}

class WorkerPool {
  private readonly workers: Worker[] = []
  private readonly queues: number[] = []
  private readonly pending = new Map<
    number,
    { resolve: (result: ScannedFileResult) => void; reject: (error: Error) => void }
  >()
  private nextId = 1
  private failure: Error | undefined
  private closed = false

  constructor(scriptPath: string, size: number) {
    for (let i = 0; i < size; i++) {
      const worker = new Worker(scriptPath)
      worker.on('message', (message: WorkerReply) => this.handleMessage(message))
      worker.on('error', (error) => {
        this.handleFailure(error instanceof Error ? error : new Error(String(error)))
      })
      worker.on('exit', (code) => {
        if (!this.closed && code !== 0) this.handleFailure(new Error(`scan worker exited with code ${code}`))
      })
      this.workers.push(worker)
      this.queues.push(0)
    }
  }

  get size(): number {
    return this.workers.length
  }

  private handleMessage(message: WorkerReply): void {
    const item = this.pending.get(message.id)
    if (!item) return
    this.pending.delete(message.id)
    if (message.error !== undefined) item.reject(new Error(message.error))
    else {
      item.resolve({
        symbols: message.symbols ?? [],
        hashes: message.hashes ?? new Uint32Array(0),
        // worker 始终回传；缺省值仅为协议异常时的防御（数据仅供 0.8.0 后续任务使用）
        contentHash: message.contentHash ?? { lo: 0, hi: 0 },
        includes: message.includes ?? [],
      })
    }
  }

  private handleFailure(error: Error): void {
    if (this.failure) return
    this.failure = error
    for (const item of this.pending.values()) item.reject(error)
    this.pending.clear()
  }

  run(text: string): Promise<ScannedFileResult> {
    if (this.failure) return Promise.reject(this.failure)
    let best = 0
    for (let i = 1; i < this.queues.length; i++) {
      if (this.queues[i] < this.queues[best]) best = i
    }
    const worker = this.workers[best]
    this.queues[best] += 1
    const id = this.nextId++
    return new Promise<ScannedFileResult>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (result) => {
          this.queues[best] -= 1
          resolve(result)
        },
        reject: (error) => {
          this.queues[best] -= 1
          reject(error)
        },
      })
      try {
        worker.postMessage({ id, text })
      } catch (error) {
        this.pending.delete(id)
        this.queues[best] -= 1
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async terminate(): Promise<void> {
    this.closed = true
    await Promise.all(this.workers.map((worker) => worker.terminate().catch(() => undefined)))
  }
}

type PendingParser = {
  pending: readonly FileRecord[]
  readFile: ReadFileFn
  concurrency: number
  signal?: AbortSignal
  finish: (file: FileRecord, result: ScannedFileResult) => void
  finishSkipped: (file: FileRecord) => void
  isDone: (file: FileRecord) => boolean
}

async function dispatchThroughPool(pool: WorkerPool, job: PendingParser): Promise<void> {
  let next = 0
  const runners: Promise<void>[] = []
  for (let i = 0; i < pool.size; i++) {
    runners.push(
      (async () => {
        for (;;) {
          throwIfAborted(job.signal)
          const index = next++
          if (index >= job.pending.length) return
          const file = job.pending[index]
          if (job.isDone(file)) continue
          let text: string
          try {
            text = String(await job.readFile(file.path))
          } catch {
            job.finishSkipped(file)
            continue
          }
          throwIfAborted(job.signal)
          const result = await pool.run(text)
          job.finish(file, result)
        }
      })(),
    )
  }
  await Promise.all(runners)
}

async function parseRemainingSerial(job: PendingParser): Promise<void> {
  for (const file of job.pending) {
    throwIfAborted(job.signal)
    if (job.isDone(file)) continue
    let text: string
    try {
      text = String(await job.readFile(file.path))
    } catch {
      job.finishSkipped(file)
      continue
    }
    throwIfAborted(job.signal)
    job.finish(file, {
      symbols: scanSource(text),
      hashes: collectIdentifierHashes(text),
      contentHash: hashContent64(text),
      includes: scanIncludes(text),
    })
  }
}

/**
 * 建索引：遍历 → 增量比对 → 并行解析 → 组装（可选写快照）。
 * `summary.snapshotBytes` 仅在提供 `snapshotPath` 时非 0。
 */
export async function buildIndex(
  options: BuildOptions & { readFile: ReadFileFn },
): Promise<{ snapshot: SymbolTable; summary: BuildSummary }> {
  const startedAt = Date.now()
  const {
    workspaceRoot,
    roots,
    exclude,
    maxFileSizeKB,
    followSymlinks,
    previous,
    snapshotPath,
    nameIndexPath,
    signal,
    onProgress,
    readFile,
  } = options
  const cap = options.concurrencyCap ?? Number.POSITIVE_INFINITY
  const configuredConcurrency = normalizeConcurrency(Math.min(options.concurrency, cap))

  throwIfAborted(signal)
  const files = await walkFiles({
    workspaceRoot,
    roots,
    exclude,
    maxFileSizeKB,
    followSymlinks,
    signal,
    onProgress,
  })
  throwIfAborted(signal)

  // 大工程自动降并发：以本次实际 walk 到的文件数为准（首次构建 / 清缓存后同样生效，
  // 不再依赖「上一轮文件数」这类外部状态）。concurrencyCap 已在上面的 configuredConcurrency
  // 中先应用，这里按实际文件数再取更小值。
  const downgrade = options.concurrencyDowngrade
  const concurrency =
    downgrade && files.length > downgrade.files
      ? normalizeConcurrency(Math.min(configuredConcurrency, downgrade.concurrency))
      : configuredConcurrency

  // 旧快照按文件建索引（版本不符视为没有旧快照：v4 元数据契约不跨版本复用）。
  //
  // indexRoots 变了同样不能复用：include 边依赖 roots 做前缀解析（相对目录 → 原样 →
  // `<root>/<include>`），复用旧 `includedFiles` 会把「旧 roots 下未命中的空图」带进新
  // 索引。例如 roots 从 proj/src 改成 proj 后，proj/src/a.c 的 #include "inc/x.h" 本应
  // 解析到 proj/inc/x.h，但文件本身没变（mtime/size 相同）会走复用分支。因此 roots 归一
  // 后不一致就当作没有 previous：全部文件重扫、include 图按新 roots 重新解析。
  const rootsChanged =
    previous !== undefined && indexRootsChanged(workspaceRoot, previous.roots, roots)
  const previousV4 =
    previous && !rootsChanged && previous.version === SNAPSHOT_VERSION ? previous : undefined
  const previousFiles = new Map<string, FileRecord>()
  const previousEntries = new Map<string, SymbolEntry[]>()
  if (previousV4) {
    for (const file of previousV4.files) previousFiles.set(file.path, file)
    previousV4.forEachEntry((entry) => {
      const list = previousEntries.get(entry.file)
      if (list) list.push(entry)
      else previousEntries.set(entry.file, [entry])
    })
  }

  // 增量比对：mtimeMs + size 都没变的文件直接复用旧符号。
  //
  // v4 元数据可用性判定（升级路径修复，格式不变）：旧版本（本任务之前的 2ffa868）写出的
  // v4 快照里，文件记录没有内容哈希、include CSR 为空、条目无条件。这种快照「版本号正确」
  // 但元数据全缺，若按 mtime+size 复用它，B1/B2/B4 会一直失效到每个文件被编辑或清缓存。
  // 因此 v4 旧快照里的文件只有「确实带哈希」才算可用于增量复用；无哈希一律当作变更重新
  // 扫描，下一次 build 就会自然补齐哈希、include 边与条件。这里刻意不写日志：升级后首次
  // 全量重扫是预期的一次性修复，不是异常。
  const reused: SymbolEntry[] = []
  const pending: FileRecord[] = []
  const unchanged = new Set<string>()
  for (const file of files) {
    const old = previousFiles.get(file.path)
    const reusable =
      previousV4 !== undefined && previousV4.contentHashOf(file.path) !== undefined
    if (old && reusable && old.mtimeMs === file.mtimeMs && old.size === file.size) {
      unchanged.add(file.path)
      const entries = previousEntries.get(file.path)
      if (entries) reused.push(...entries)
    } else {
      pending.push(file)
    }
  }

  // 解析待处理文件
  const parsed = new Map<string, SymbolEntry[]>()
  const skipped = new Set<string>()
  const total = pending.length
  let done = 0
  const reportParse = (currentFile?: string): void => {
    onProgress?.({ phase: 'parse', done, total, currentFile })
    if (signal?.aborted) throw makeAbortError()
  }
  /** 每个文件的标识符哈希（单遍解析产出，供引用索引复用，不再二次读盘） */
  const parsedHashes = new Map<string, Uint32Array>()
  /** 每个变更文件的原始 include 路径（解析为索引内文件要等 walk 结果与 skipped 集合齐备） */
  const parsedIncludePaths = new Map<string, readonly string[]>()
  /** 每个变更文件的内容哈希（worker/串行扫描同遍产出，零额外 IO） */
  const parsedContentHashes = new Map<string, { lo: number; hi: number }>()
  const finish = (file: FileRecord, result: ScannedFileResult): void => {
    parsedHashes.set(file.path, result.hashes)
    parsedIncludePaths.set(
      file.path,
      result.includes.map((include) => include.path),
    )
    parsedContentHashes.set(file.path, result.contentHash)
    parsed.set(
      file.path,
      result.symbols.map((symbol) => {
        const entry: SymbolEntry = {
          name: symbol.name,
          kind: symbol.kind,
          file: file.path,
          line: symbol.line,
          endLine: symbol.endLine,
          column: symbol.column,
        }
        // 无条件条目不 materialize condition（与 SymbolEntry/快照的旧形状一致）
        if (symbol.condition === undefined || symbol.condition === '') return entry
        return { ...entry, condition: symbol.condition }
      }),
    )
    done += 1
    reportParse(file.path)
  }
  const finishSkipped = (file: FileRecord): void => {
    skipped.add(file.path)
    done += 1
    reportParse(file.path)
  }

  onProgress?.({ phase: 'parse', done: 0, total })

  if (total > 0) {
    const job: PendingParser = {
      pending,
      readFile,
      concurrency,
      signal,
      finish,
      finishSkipped,
      isDone: (file) => parsed.has(file.path) || skipped.has(file.path),
    }
    const workerCount = Math.min(concurrency, total)
    let pool: WorkerPool | undefined
    if (workerCount > 1 && existsSync(WORKER_SCRIPT)) {
      try {
        pool = new WorkerPool(WORKER_SCRIPT, workerCount)
        await dispatchThroughPool(pool, job)
      } catch (error) {
        // worker 创建/崩溃：吞掉错误，下面串行兜底；AbortError 继续上抛
        if (isAbortError(error)) throw error
      } finally {
        await pool?.terminate()
      }
    }
    await parseRemainingSerial(job)
  }

  // 组装统计
  const successfulFiles: FileRecord[] = []
  const successfulPaths = new Set<string>()
  let added = 0
  let updated = 0
  let unchangedCount = 0
  for (const file of files) {
    if (skipped.has(file.path)) continue
    successfulFiles.push(file)
    successfulPaths.add(file.path)
    const old = previousFiles.get(file.path)
    if (!old) added += 1
    else if (unchanged.has(file.path)) unchangedCount += 1
    else updated += 1
  }
  let removed = 0
  for (const oldPath of previousFiles.keys()) {
    if (!successfulPaths.has(oldPath)) removed += 1
  }

  // v4 元数据：未变更文件复用旧表（仅 v4 旧表、且上面的「哈希可用」判定通过才进入
  // unchanged；因此复用到的哈希/include 必然存在）；变更文件用本轮扫描结果。
  // include 只在命中「索引内文件」时建边（skipped 文件不在表里，同样丢弃）。
  const includeContext = { indexedPaths: successfulPaths, roots }
  const includesByFile = new Map<string, readonly string[]>()
  const nextFiles: FileRecord[] = []
  for (const file of successfulFiles) {
    let contentHash: { lo: number; hi: number } | undefined
    let targets: readonly string[]
    if (unchanged.has(file.path) && previousV4) {
      contentHash = previousV4.contentHashOf(file.path)
      targets = previousV4.includedFiles(file.path)
    } else {
      contentHash = parsedContentHashes.get(file.path)
      targets = resolveIncludePaths(file.path, parsedIncludePaths.get(file.path) ?? [], includeContext)
    }
    if (targets.length > 0) includesByFile.set(file.path, targets)
    nextFiles.push(
      contentHash
        ? {
            path: file.path,
            mtimeMs: file.mtimeMs,
            size: file.size,
            contentHashLo: contentHash.lo,
            contentHashHi: contentHash.hi,
          }
        : file,
    )
  }

  const entries: SymbolEntry[] = reused.slice()
  for (const list of parsed.values()) entries.push(...list)
  const snapshot = createSnapshot(roots, nextFiles, entries, includesByFile)

  onProgress?.({ phase: 'save', done: 0, total: 0 })
  let snapshotBytes = 0
  if (snapshotPath) snapshotBytes = await saveSnapshot(snapshotPath, snapshot)

  // 引用加速索引：直接用本次解析同时产出的标识符哈希（单遍构建，不再二次读盘）；
  // 未变更文件复用旧索引切片。
  let nameIndexBytes = 0
  if (nameIndexPath) {
    const previousNameIndex = await loadNameIndex(nameIndexPath)
    const changedPaths = new Set<string>(pending.map((file) => file.path))
    onProgress?.({ phase: 'index', done: 0, total: successfulFiles.length })
    const nameIndex = await buildNameIndex({
      files: successfulFiles,
      previous: previousNameIndex,
      changedPaths,
      changedHashes: parsedHashes,
      readFile,
      signal,
      concurrency: Math.min(64, Math.max(8, concurrency * 8)),
      onProgress: (done, total) => onProgress?.({ phase: 'index', done, total }),
    })
    nameIndexBytes = await saveNameIndex(nameIndexPath, nameIndex)
  }

  const summary: BuildSummary = {
    files: successfulFiles.length,
    entries: entries.length,
    added,
    updated,
    removed,
    unchanged: unchangedCount,
    skipped: skipped.size,
    durationMs: Date.now() - startedAt,
    snapshotBytes,
    concurrency,
    nameIndexBytes,
  }
  return { snapshot, summary }
}
