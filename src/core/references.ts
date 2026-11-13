import type { FileRecord, NameIndexData, ReadFileFn, ReferenceHit, SymbolTable } from '../shared/types'
import { candidatesForName } from './nameindex'
import { stripSources } from './signature'

/**
 * 引用扫描：读快照中的每个文件，先做内容 `indexOf(name)` 预筛，只对候选文件
 * 做词法剥离 + 词边界精确定位（注释/字符串里的同名标识符不算引用），
 * 排除同名符号的定义/声明行，并发读取（默认 8），支持 AbortSignal 与进度回调。
 * 结果按 name 做小型 LRU 缓存（≤64 项，键含快照对象身份，重建索引后自动失效）。
 */

export interface ReferenceOptions {
  /** 提供了倒排索引时只读取可能包含该标识符的文件（数量级加速） */
  readonly nameIndex?: NameIndexData
  readonly signal?: AbortSignal
  readonly onProgress?: (done: number, total: number) => void
  readonly includeDeclaration?: boolean
}

const DEFAULT_CONCURRENCY = 8
const PROGRESS_INTERVAL = 500
const RESULT_CACHE_LIMIT = 64

/**
 * 快照身份：同一 IndexSnapshot 对象复用同一缓存键；重建出的新对象即使
 * builtAt 相同（同一毫秒内）也不会命中旧缓存。
 */
const snapshotIds = new WeakMap<SymbolTable, number>()
let nextSnapshotId = 0

export function snapshotIdentity(snapshot: SymbolTable): number {
  let id = snapshotIds.get(snapshot)
  if (id === undefined) {
    id = ++nextSnapshotId
    snapshotIds.set(snapshot, id)
  }
  return id
}

/** 结果缓存：key = snapshotId|includeDeclaration|name → 已排序结果。 */
const resultCache = new Map<string, readonly ReferenceHit[]>()

/** 清空引用结果缓存（测试与压测用于对比冷启动耗时）。 */
export function clearReferenceCache(): void {
  resultCache.clear()
}

export function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError()
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function makePreview(line: string): string {
  return line.trim().slice(0, 200)
}

function cacheGet(key: string): readonly ReferenceHit[] | undefined {
  return resultCache.get(key)
}

function cacheSet(key: string, hits: readonly ReferenceHit[]): void {
  resultCache.set(key, hits)
  while (resultCache.size > RESULT_CACHE_LIMIT) {
    const oldest = resultCache.keys().next()
    if (oldest.done) break
    resultCache.delete(oldest.value)
  }
}

/** 同 file 内同名符号（定义/声明/宏）的行号集合，includeDeclaration=false 时排除。 */
function declarationLinesByName(snapshot: SymbolTable, name: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>()
  for (const entry of snapshot.findByName(name)) {
    if (entry.name !== name) continue
    let lines = result.get(entry.file)
    if (lines === undefined) {
      lines = new Set<number>()
      result.set(entry.file, lines)
    }
    lines.add(entry.line)
  }
  return result
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined)
    return Promise.reject(abortError())
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

export async function findReferences(
  snapshot: SymbolTable,
  name: string,
  readFile: ReadFileFn,
  options: ReferenceOptions = {},
): Promise<ReferenceHit[]> {
  throwIfAborted(options.signal)
  if (name.length === 0) return []

  const includeDeclaration = options.includeDeclaration === true
  const cacheKey = `${snapshotIdentity(snapshot)}|${includeDeclaration ? 1 : 0}|${name}`
  const cached = cacheGet(cacheKey)
  if (cached !== undefined) return [...cached]

  const excludedLines = includeDeclaration
    ? undefined
    : declarationLinesByName(snapshot, name)

  // 有倒排索引时：先用哈希索引得到候选文件，未命中直接返回空（索引覆盖所有标识符，
  // 注释/字符串中的文本本来就不算引用），命中则只读这些文件。
  let files: readonly FileRecord[] = snapshot.files
  if (options.nameIndex) {
    const nameIndex = options.nameIndex
    const candidateIndexes = candidatesForName(nameIndex, name)
    if (candidateIndexes.length === 0) {
      cacheSet(cacheKey, [])
      return []
    }
    const byPath = new Map<string, FileRecord>(snapshot.files.map((record) => [record.path, record]))
    const narrowed: FileRecord[] = []
    for (const candidate of candidateIndexes) {
      const path = nameIndex.filePaths[candidate]
      if (path === undefined) continue
      const record = byPath.get(path)
      if (record !== undefined) narrowed.push(record)
    }
    files = narrowed
  }
  const total = files.length
  const concurrency = Math.min(DEFAULT_CONCURRENCY, Math.max(total, 1))

  const hits: ReferenceHit[] = []
  let nextIndex = 0
  let done = 0

  const reportProgress = (force: boolean): void => {
    if (options.onProgress === undefined) return
    if (!force && done % PROGRESS_INTERVAL !== 0) return
    options.onProgress(done, total)
  }

  const worker = async (): Promise<void> => {
    while (true) {
      throwIfAborted(options.signal)
      const index = nextIndex++
      if (index >= total) return

      const file = files[index]!.path
      let text: string | undefined
      try {
        text = await readFile(file)
      } catch {
        text = undefined
      }
      throwIfAborted(options.signal)

      done++
      reportProgress(done === total)
      if (text === undefined) continue

      // 1) 内容预筛：绝大多数文件在这里被跳过，不进入词法剥离。
      if (text.indexOf(name) < 0) continue

      // 2) 词法剥离（注释/字符串内容变空格，行列号与原文一致）。
      const stripped = stripSources(text)
      const originalLines = text.split('\n')
      const strippedLines = stripped.split('\n')
      const excluded = excludedLines?.get(file)
      const boundary = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`, 'g')

      for (let line = 0; line < strippedLines.length; line++) {
        if (excluded !== undefined && excluded.has(line)) continue
        const lineText = strippedLines[line]!
        boundary.lastIndex = 0
        let match = boundary.exec(lineText)
        while (match !== null) {
          hits.push({
            file,
            line,
            column: match.index,
            preview: makePreview(originalLines[line] ?? ''),
          })
          match = boundary.exec(lineText)
        }
      }
    }
  }

  const workers: Promise<void>[] = []
  for (let i = 0; i < concurrency; i++) workers.push(worker())

  const all = Promise.all(workers)
  if (options.signal !== undefined) {
    await raceAbort(all, options.signal)
  } else {
    await all
  }

  hits.sort(
    (a, b) =>
      (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line || a.column - b.column,
  )
  cacheSet(cacheKey, hits)
  return [...hits]
}
