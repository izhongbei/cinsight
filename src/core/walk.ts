import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { INDEXED_EXTENSIONS } from '../shared/types'
import type { FileRecord, IndexProgress } from '../shared/types'
import { compileExclude } from './exclude'

const INDEXABLE_EXTENSIONS = new Set<string>(INDEXED_EXTENSIONS)
const PROGRESS_EVERY = 500

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function makeAbortError(): Error {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

/** 只接受契约里列出的 C/C++ 扩展名（大小写敏感，`a.C` 不算）。 */
export function isIndexableFile(filePath: string): boolean {
  return INDEXABLE_EXTENSIONS.has(path.extname(filePath))
}

/** roots 里的路径（可能是绝对路径、`./x`）→ 相对 workspaceRoot 的 posix 路径。 */
function toRelativeRoot(workspaceRoot: string, root: string): string {
  let rel = root
  if (path.isAbsolute(rel)) rel = path.relative(workspaceRoot, rel)
  rel = rel.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  while (rel.startsWith('./')) rel = rel.slice(2)
  if (rel === '.') rel = ''
  return rel.replace(/\/+$/, '')
}

/**
 * 遍历 roots，返回按字典序排序的 C/C++ 文件清单。
 *
 * - `exclude` 相对 workspace 根匹配；目录用「尾部带 `/`」的路径参与匹配，便于剪枝；
 * - 目录名 `.git` 永远跳过；`followSymlinks=false` 时所有符号链接跳过；
 * - 超过 `maxFileSizeKB` 的文件静默跳过（不进入返回值）；
 * - 每 500 个文件回调一次进度，结束时补一次收尾进度；
 * - `signal.aborted` 时抛 `AbortError`。
 */
export async function walkFiles(options: {
  workspaceRoot: string
  roots: readonly string[]
  exclude: readonly string[]
  maxFileSizeKB: number
  followSymlinks: boolean
  signal?: AbortSignal
  onProgress?: (progress: IndexProgress) => void
}): Promise<FileRecord[]> {
  const { workspaceRoot, roots, exclude, maxFileSizeKB, followSymlinks, signal, onProgress } = options
  const isExcluded = compileExclude(exclude)
  const maxBytes = maxFileSizeKB > 0 ? maxFileSizeKB * 1024 : Number.POSITIVE_INFINITY
  const results: FileRecord[] = []
  const seen = new Set<string>()
  const visitedDirs = new Set<string>()
  let done = 0

  const checkAbort = (): void => {
    if (signal?.aborted) throw makeAbortError()
  }
  const report = (currentFile?: string): void => {
    onProgress?.({ phase: 'walk', done, total: 0, currentFile })
  }

  const addFile = (relPath: string, stat: { mtimeMs: number; size: number }): void => {
    if (seen.has(relPath)) return
    seen.add(relPath)
    results.push({ path: relPath, mtimeMs: stat.mtimeMs, size: stat.size })
    done += 1
    if (done % PROGRESS_EVERY === 0) report(relPath)
  }

  const walkDir = async (absDir: string, relDir: string): Promise<void> => {
    checkAbort()
    let entries
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true })
    } catch {
      return // 目录不可读/已消失：跳过而不是中断整次构建
    }

    if (followSymlinks) {
      try {
        const real = await fsp.realpath(absDir)
        if (visitedDirs.has(real)) return // 符号链接目录成环保护
        visitedDirs.add(real)
      } catch {
        return
      }
    }

    for (const entry of entries) {
      checkAbort()
      const name = entry.name
      if (name === '.git') continue

      const childAbs = path.join(absDir, name)
      const childRel = relDir ? `${relDir}/${name}` : name
      const isLink = entry.isSymbolicLink()
      if (isLink && !followSymlinks) continue

      let isDir = entry.isDirectory()
      let isFile = entry.isFile()
      if (isLink && !isDir && !isFile) {
        try {
          const stat = await fsp.stat(childAbs)
          isDir = stat.isDirectory()
          isFile = stat.isFile()
        } catch {
          continue
        }
      }

      if (isDir) {
        if (isExcluded(`${childRel}/`)) continue
        await walkDir(childAbs, childRel)
      } else if (isFile) {
        if (!isIndexableFile(name)) continue
        if (isExcluded(childRel)) continue
        let stat
        try {
          stat = await fsp.stat(childAbs)
        } catch {
          continue
        }
        if (!stat.isFile() || stat.size > maxBytes) continue
        addFile(childRel, stat)
      }
    }
  }

  for (const root of roots) {
    checkAbort()
    const relRoot = toRelativeRoot(workspaceRoot, root)
    const absRoot = relRoot ? path.join(workspaceRoot, relRoot) : workspaceRoot
    await walkDir(absRoot, relRoot)
  }

  results.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  if (done > 0 && done % PROGRESS_EVERY !== 0) report()
  checkAbort()
  return results
}

export { isAbortError }
