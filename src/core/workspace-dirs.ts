/**
 * 工作区目录发现（纯 fs/path，不依赖 vscode）。
 *
 * - `listCandidateDirectories`：`si.configureRoots` 的 QuickPick 候选。规则与原实现
 *   一致（跳过点目录、`.git`/`node_modules`/`out`/`dist` 等、深度 ≤ 2），另外把
 *   **符号链接目录**也作为候选（`symlink: true`），但**不递归进入**符号链接，
 *   避免逃出工作区或陷入无限链接树。
 * - `mapOutsidePathToWorkspace`：Browse 对话框可能返回符号链接目标的真实绝对路径
 *   （在工作区之外）。这里扫描工作区内（顶层 + 下一层）指向目录的符号链接，把它们
 *   的 realpath 与目标路径做包含判断，映射回 `<symlinkName>/<suffix>` 形式的工作区
 *   相对 posix 路径。
 */
import type { Dirent } from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

/** 与原 QuickPick 实现一致的目录跳过集合（另外所有 `.` 开头的名字都跳过）。 */
const SKIP_DIR_NAMES = new Set(['.git', 'node_modules', '.vscode', '.svn', '.hg', 'out', 'dist'])
const DEFAULT_MAX_DEPTH = 2
/** 向上寻找已存在祖先时的最大层数，仅用于防御异常输入。 */
const MAX_ANCESTOR_LOOKUP = 64

export interface WorkspaceDirectoryCandidate {
  /** 工作区相对 posix 路径，例如 `modules/private`。 */
  readonly path: string
  /** true 表示这是一个指向目录的符号链接（不会递归展开）。 */
  readonly symlink: boolean
}

function shouldSkipName(name: string): boolean {
  return name.startsWith('.') || SKIP_DIR_NAMES.has(name)
}

function normalizeDepth(maxDepth: number): number {
  if (!Number.isFinite(maxDepth)) return DEFAULT_MAX_DEPTH
  return Math.max(1, Math.floor(maxDepth))
}

function toPosix(value: string): string {
  return value.replace(/\\/g, '/')
}

/** root 内的相对 posix 路径（'' 表示根本身）；不在 root 下返回 undefined。 */
function relativeWithin(root: string, target: string): string | undefined {
  const rel = path.relative(root, target)
  if (rel === '') return ''
  if (path.isAbsolute(rel)) return undefined
  const first = rel.split(path.sep)[0]
  if (first === '..') return undefined
  return toPosix(rel)
}

async function realPathOrUndefined(target: string): Promise<string | undefined> {
  try {
    return await fsp.realpath(target)
  } catch {
    return undefined
  }
}

/**
 * 目标路径的候选形态：原样；存在时取 realpath；尚不存在时取「最近的已存在祖先的
 * realpath + 剩余后缀」。这样即使所选目录还没创建，也能按符号链接目标映射。
 */
async function pathVariants(target: string): Promise<string[]> {
  const variants = [target]
  const real = await realPathOrUndefined(target)
  if (real) {
    if (real !== target) variants.push(real)
    return variants
  }
  let current = target
  const suffix: string[] = []
  for (let i = 0; i < MAX_ANCESTOR_LOOKUP; i++) {
    const parent = path.dirname(current)
    if (parent === current) break
    suffix.unshift(path.basename(current))
    current = parent
    const ancestorReal = await realPathOrUndefined(current)
    if (ancestorReal) {
      variants.push(path.join(ancestorReal, ...suffix))
      break
    }
  }
  return variants
}

/**
 * 判断 Dirent 是否指向目录的符号链接。
 *
 * 先 `lstat` 确认链接本身，再 `stat` 跟随链接确认目标是目录；断链、权限不足或
 * 目标不是目录都返回 false（静默跳过，不影响其余候选）。
 */
async function isDirectorySymlink(absolute: string, entry: Dirent): Promise<boolean> {
  if (!entry.isSymbolicLink()) return false
  try {
    const linkStat = await fsp.lstat(absolute)
    if (!linkStat.isSymbolicLink()) return false
    const targetStat = await fsp.stat(absolute)
    return targetStat.isDirectory()
  } catch {
    return false
  }
}

async function readDirEntries(absolute: string): Promise<Dirent[] | undefined> {
  try {
    return await fsp.readdir(absolute, { withFileTypes: true })
  } catch {
    return undefined // 不可读/已消失：跳过
  }
}

/**
 * 列出工作区内可作为索引根的目录（深度 ≤ `maxDepth`，默认 2）。
 *
 * 普通目录会继续向下递归；指向目录的符号链接只作为候选返回（`symlink: true`），
 * 不会递归进入（否则可能索引到工作区外或陷入链接环）。
 */
export async function listCandidateDirectories(
  workspaceRoot: string,
  maxDepth = DEFAULT_MAX_DEPTH,
): Promise<WorkspaceDirectoryCandidate[]> {
  const root = path.resolve(workspaceRoot)
  const limit = normalizeDepth(maxDepth)
  const result: WorkspaceDirectoryCandidate[] = []

  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > limit) return
    const absolute = rel ? path.join(root, rel.split('/').join(path.sep)) : root
    const entries = await readDirEntries(absolute)
    if (!entries) return
    for (const entry of entries) {
      if (shouldSkipName(entry.name)) continue
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      const childAbs = path.join(absolute, entry.name)
      if (entry.isDirectory()) {
        result.push({ path: childRel, symlink: false })
        await walk(childRel, depth + 1)
        continue
      }
      if (await isDirectorySymlink(childAbs, entry)) {
        result.push({ path: childRel, symlink: true })
      }
    }
  }

  await walk('', 1)
  result.sort((a, b) => a.path.localeCompare(b.path))
  return result
}

/**
 * 收集工作区内（顶层 + 下一层）指向目录的符号链接及其 realpath。
 *
 * 与候选列表使用相同的跳过规则和深度；不递归进入符号链接目录。
 */
async function collectSymlinkDirectories(
  root: string,
  maxDepth: number,
  onFound: (rel: string, real: string) => void,
): Promise<void> {
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return
    const absolute = rel ? path.join(root, rel.split('/').join(path.sep)) : root
    const entries = await readDirEntries(absolute)
    if (!entries) return
    for (const entry of entries) {
      if (shouldSkipName(entry.name)) continue
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      const childAbs = path.join(absolute, entry.name)
      if (entry.isDirectory()) {
        await walk(childRel, depth + 1)
        continue
      }
      if (!(await isDirectorySymlink(childAbs, entry))) continue
      const real = await realPathOrUndefined(childAbs)
      if (real) onFound(childRel, real)
    }
  }
  await walk('', 1)
}

/**
 * 把绝对路径映射为工作区相对 posix 路径（根目录返回 ''）。
 *
 * 先按词法判断是否在工作区内（普通目录选择的常规路径）；若不在，则扫描工作区内
 * 指向目录的符号链接（顶层 + 下一层），用 realpath 判断目标是否落在链接目标之下，
 * 命中则返回 `<symlinkName>/<suffix>`。例如 `private -> /outside/private` 时
 * `/outside/private/sub` 映射为 `private/sub`。无法映射时返回 undefined。
 *
 * 工作区根本身也可能是符号链接，因此同时接受它的 realpath。
 */
export async function mapOutsidePathToWorkspace(
  workspaceRoot: string,
  absPath: string,
): Promise<string | undefined> {
  const root = path.resolve(workspaceRoot)
  const target = path.isAbsolute(absPath) ? path.resolve(absPath) : path.resolve(root, absPath)
  const candidates: Array<{ prefix: string; real: string }> = []

  const addRoot = async (prefix: string, dir: string): Promise<void> => {
    const real = (await realPathOrUndefined(dir)) ?? dir
    candidates.push({ prefix, real })
  }

  await addRoot('', root)
  const rootReal = await realPathOrUndefined(root)
  if (rootReal && rootReal !== root) candidates.push({ prefix: '', real: rootReal })

  await collectSymlinkDirectories(root, DEFAULT_MAX_DEPTH, (rel, real) => {
    candidates.push({ prefix: rel, real })
  })

  const variants = await pathVariants(target)
  let mapped: string | undefined
  for (const candidate of candidates) {
    for (const variant of variants) {
      const rel = relativeWithin(candidate.real, variant)
      if (rel === undefined) continue
      const value = candidate.prefix
        ? rel
          ? `${candidate.prefix}/${rel}`
          : candidate.prefix
        : rel
      // 同一个目标可能有多个符号链接（例如顶层与嵌套链接）：取最短映射，
      // 结果稳定且优先使用更浅的链接名。
      if (mapped === undefined || value.length < mapped.length) mapped = value
    }
  }
  return mapped
}
