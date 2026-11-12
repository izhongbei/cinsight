import type {
  CallerHit,
  IndexSnapshot,
  ReadFileFn,
  ReferenceHit,
  ScannedSymbol,
  SymbolEntry,
} from '../shared/types'
import { scanSource } from './scan'
import { findByName } from './query'
import { findReferences, snapshotIdentity, throwIfAborted } from './references'
import type { ReferenceOptions } from './references'
import { stripSources } from './signature'

/**
 * callersOf：先做引用扫描，再把每个命中行归属到「包含该行」的函数区间
 * （scanSource 结果按文件缓存 ≤500 项；扫描器异常时退化为快照 entries 区间）。
 * calleesOf：只截取 [line, endLine] 函数体，剥离注释/字符串后匹配 `IDENT(`，
 * 排除关键字/函数名自身/预处理行，用 findByName 回查索引，按出现顺序去重。
 */

const SCAN_CACHE_LIMIT = 500

/** scanSource 结果缓存：key = snapshotId|file。 */
const scanCache = new Map<string, readonly ScannedSymbol[]>()

const C_KEYWORDS = new Set([
  'auto',
  'break',
  'case',
  'char',
  'const',
  'continue',
  'default',
  'do',
  'double',
  'else',
  'enum',
  'extern',
  'float',
  'for',
  'goto',
  'if',
  'inline',
  'int',
  'long',
  'register',
  'restrict',
  'return',
  'short',
  'signed',
  'sizeof',
  'static',
  'struct',
  'switch',
  'typedef',
  'union',
  'unsigned',
  'void',
  'volatile',
  'while',
  '_Bool',
  '_Complex',
  '_Imaginary',
  '_Alignas',
  '_Alignof',
  '_Atomic',
  '_Generic',
  '_Noreturn',
  '_Static_assert',
  '_Thread_local',
  'alignof',
  'defined',
  'offsetof',
  'typeof',
  '__typeof__',
  '__attribute__',
  '__attribute',
  '__declspec',
  '__asm__',
  '__asm',
  '__volatile__',
  'asm',
  'static_assert',
  'alignas',
  'thread_local',
])

function scanCacheGet(key: string): readonly ScannedSymbol[] | undefined {
  return scanCache.get(key)
}

function scanCacheSet(key: string, symbols: readonly ScannedSymbol[]): void {
  scanCache.set(key, symbols)
  while (scanCache.size > SCAN_CACHE_LIMIT) {
    const oldest = scanCache.keys().next()
    if (oldest.done) break
    scanCache.delete(oldest.value)
  }
}

/** 取某文件的函数区间；优先用 scanSource（含未被索引的最新代码），异常时回退快照。 */
function rangesForFile(
  snapshot: IndexSnapshot,
  file: string,
  text: string,
): readonly ScannedSymbol[] {
  const key = `${snapshotIdentity(snapshot)}|${file}`
  const cached = scanCacheGet(key)
  if (cached !== undefined) return cached

  let ranges: readonly ScannedSymbol[]
  try {
    ranges = scanSource(text)
  } catch {
    // 扫描器不可用时退回索引里的函数区间，callers 仍可归属。
    ranges = snapshot.entries
      .filter((entry) => entry.file === file && entry.kind === 'function')
      .map((entry) => ({
        name: entry.name,
        kind: entry.kind,
        line: entry.line,
        endLine: entry.endLine,
        column: entry.column,
      }))
  }
  scanCacheSet(key, ranges)
  return ranges
}

/** 命中行所属函数：line 落在 [line, endLine] 内；多个时取起点最靠后（最内层）。 */
function containingFunction(
  ranges: readonly ScannedSymbol[],
  file: string,
  hitLine: number,
): SymbolEntry | undefined {
  let best: ScannedSymbol | undefined
  for (const symbol of ranges) {
    if (symbol.kind !== 'function') continue
    if (symbol.line > hitLine || hitLine > symbol.endLine) continue
    if (
      best === undefined ||
      symbol.line > best.line ||
      (symbol.line === best.line && symbol.endLine < best.endLine)
    ) {
      best = symbol
    }
  }
  if (best === undefined) return undefined
  return {
    name: best.name,
    kind: best.kind,
    file,
    line: best.line,
    endLine: best.endLine,
    column: best.column,
  }
}

type TextCache = Map<string, Promise<string | undefined>>

function readTextCached(
  readFile: ReadFileFn,
  file: string,
  cache: TextCache,
): Promise<string | undefined> {
  let pending = cache.get(file)
  if (pending === undefined) {
    pending = (async (): Promise<string | undefined> => {
      try {
        return await readFile(file)
      } catch {
        return undefined
      }
    })()
    cache.set(file, pending)
  }
  return pending
}

export async function callersOf(
  snapshot: IndexSnapshot,
  name: string,
  readFile: ReadFileFn,
  options: ReferenceOptions = {},
): Promise<CallerHit[]> {
  throwIfAborted(options.signal)

  const references: ReferenceHit[] = await findReferences(snapshot, name, readFile, {
    nameIndex: options.nameIndex,
    signal: options.signal,
    onProgress: options.onProgress,
    includeDeclaration: options.includeDeclaration ?? false,
  })

  const byFile = new Map<string, ReferenceHit[]>()
  for (const hit of references) {
    const bucket = byFile.get(hit.file)
    if (bucket === undefined) byFile.set(hit.file, [hit])
    else bucket.push(hit)
  }

  const textCache: TextCache = new Map()
  const result: CallerHit[] = []
  for (const [file, hits] of byFile) {
    throwIfAborted(options.signal)
    const text = await readTextCached(readFile, file, textCache)
    const ranges = text === undefined ? [] : rangesForFile(snapshot, file, text)
    for (const hit of hits) {
      result.push({ ...hit, from: containingFunction(ranges, file, hit.line) })
    }
  }
  return result
}

export async function calleesOf(
  snapshot: IndexSnapshot,
  name: string,
  readFile: ReadFileFn,
  options: { signal?: AbortSignal } = {},
): Promise<SymbolEntry[]> {
  throwIfAborted(options.signal)

  const definitions = findByName(snapshot, name).filter((entry) => entry.kind === 'function')
  if (definitions.length === 0) return []

  const textCache: TextCache = new Map()
  const callees: SymbolEntry[] = []
  const seen = new Set<string>()

  for (const definition of definitions) {
    throwIfAborted(options.signal)
    if (definition.endLine < definition.line) continue

    const text = await readTextCached(readFile, definition.file, textCache)
    if (text === undefined) continue

    const lines = text.split('\n')
    const lastLine = Math.min(definition.endLine, lines.length - 1)
    if (lastLine < definition.line) continue

    // 只截取函数体区间，避免全文件重复解析。
    const body = stripSources(lines.slice(definition.line, lastLine + 1).join('\n'))
    const callPattern = /([A-Za-z_]\w*)\s*\(/g

    let match = callPattern.exec(body)
    while (match !== null) {
      throwIfAborted(options.signal)
      const calleeName = match[1]!

      if (calleeName === name || C_KEYWORDS.has(calleeName)) {
        match = callPattern.exec(body)
        continue
      }

      // 预处理行（行首 #）里的匹配不算函数体调用。
      const lineStart = body.lastIndexOf('\n', match.index) + 1
      if (/^\s*#/.test(body.slice(lineStart, match.index))) {
        match = callPattern.exec(body)
        continue
      }

      // 回查索引：宏/系统函数/未索引名字直接忽略。
      const target = findByName(snapshot, calleeName).find((entry) => entry.kind !== 'macro')
      if (target !== undefined) {
        const key = `${target.file}|${target.line}|${target.name}`
        if (!seen.has(key)) {
          seen.add(key)
          callees.push(target)
        }
      }

      match = callPattern.exec(body)
    }
  }

  return callees
}
