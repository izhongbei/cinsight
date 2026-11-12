import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { Worker } from 'node:worker_threads'
import { SNAPSHOT_VERSION } from '../shared/types'
import type {
  BuildOptions,
  BuildSummary,
  FileRecord,
  IndexSnapshot,
  ReadFileFn,
  ScannedFileResult,
  ScannedSymbol,
  SymbolEntry,
} from '../shared/types'
import { buildNameIndex, collectIdentifierHashes, loadNameIndex, saveNameIndex } from './nameindex'
import { scanSource } from './scan'
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

/** 组装快照：files 与 entries 都做稳定排序，entries 按 `(file, line, column)` 有序。 */
export function createSnapshot(
  roots: readonly string[],
  files: readonly FileRecord[],
  entries: readonly SymbolEntry[],
): IndexSnapshot {
  const sortedFiles = [...files].sort((a, b) => compareStrings(a.path, b.path))
  const fileOrder = new Map<string, number>()
  sortedFiles.forEach((file, index) => fileOrder.set(file.path, index))

  const sortedEntries = [...entries].sort((a, b) => {
    const aIndex = fileOrder.get(a.file)
    const bIndex = fileOrder.get(b.file)
    if (aIndex !== undefined && bIndex !== undefined) {
      if (aIndex !== bIndex) return aIndex - bIndex
    } else if (a.file !== b.file) {
      return compareStrings(a.file, b.file)
    }
    if (a.line !== b.line) return a.line - b.line
    if (a.column !== b.column) return a.column - b.column
    if (a.endLine !== b.endLine) return a.endLine - b.endLine
    return compareStrings(a.name, b.name)
  })

  return {
    version: SNAPSHOT_VERSION,
    roots: [...roots],
    builtAt: Date.now(),
    files: sortedFiles,
    entries: sortedEntries,
  }
}

// --------------------------------------------------------------- worker pool

interface WorkerReply {
  id: number
  symbols?: ScannedSymbol[]
  hashes?: Uint32Array
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
    job.finish(file, { symbols: scanSource(text), hashes: collectIdentifierHashes(text) })
  }
}

/**
 * 建索引：遍历 → 增量比对 → 并行解析 → 组装（可选写快照）。
 * `summary.snapshotBytes` 仅在提供 `snapshotPath` 时非 0。
 */
export async function buildIndex(
  options: BuildOptions & { readFile: ReadFileFn },
): Promise<{ snapshot: IndexSnapshot; summary: BuildSummary }> {
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
  const concurrency = normalizeConcurrency(options.concurrency)

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

  // 旧快照按文件建索引（版本不符视为没有旧快照）
  const previousFiles = new Map<string, FileRecord>()
  const previousEntries = new Map<string, SymbolEntry[]>()
  if (previous && previous.version === SNAPSHOT_VERSION) {
    for (const file of previous.files) previousFiles.set(file.path, file)
    for (const entry of previous.entries) {
      const list = previousEntries.get(entry.file)
      if (list) list.push(entry)
      else previousEntries.set(entry.file, [entry])
    }
  }

  // 增量比对：mtimeMs + size 都没变的文件直接复用旧符号
  const reused: SymbolEntry[] = []
  const pending: FileRecord[] = []
  const unchanged = new Set<string>()
  for (const file of files) {
    const old = previousFiles.get(file.path)
    if (old && old.mtimeMs === file.mtimeMs && old.size === file.size) {
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
  const finish = (file: FileRecord, result: ScannedFileResult): void => {
    parsedHashes.set(file.path, result.hashes)
    parsed.set(
      file.path,
      result.symbols.map((symbol) => ({
        name: symbol.name,
        kind: symbol.kind,
        file: file.path,
        line: symbol.line,
        endLine: symbol.endLine,
        column: symbol.column,
      })),
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

  const entries: SymbolEntry[] = reused.slice()
  for (const list of parsed.values()) entries.push(...list)
  const snapshot = createSnapshot(roots, successfulFiles, entries)

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
    nameIndexBytes,
  }
  return { snapshot, summary }
}
