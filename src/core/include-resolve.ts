import * as path from 'node:path'

/**
 * `#include` 路径 → 索引内文件路径的纯解析（core 层，无 vscode 依赖，可被
 * indexer（全量构建）与 service（单文件保存）共用）。
 *
 * 候选顺序（第一个命中 `indexedPaths` 者胜出）：
 *   1. 相对当前文件目录：`dirname(fromFile)/<include>`
 *   2. include 原样（工程里常见的「从工作区根/源码根写全路径」）
 *   3. 相对每个 indexRoot：`<root>/<include>`
 *
 * 语义约定：
 * - **未命中直接返回 undefined**（调用方丢弃）：软排序设计下解析不到 include 不报错、
 *   也不影响符号本身；
 * - 路径比较一律使用 posix 规则，且先把 `\` 归一为 `/`：Windows 风格的 include 文本
 *   与 `\` 分隔的 fromFile 在任意平台上语义一致；
 * - 候选经 `path.posix.normalize`（折叠 `a/../b`），并拒绝含前导 `..` 或绝对路径的候选
 *   ——索引内文件都是 workspace 相对 posix 路径，这类候选不可能命中，显式跳过更清晰；
 * - include 文本本身是绝对路径（`/x`、`C:/x`、`\\server\x`）时直接未命中，不构造候选
 *   ——避免「系统头文件路径」被归一成工作区同名相对路径而造出假边。
 */

export interface IncludeResolutionContext {
  /** 索引内文件路径集合（workspace 相对 posix 路径） */
  readonly indexedPaths: ReadonlySet<string>
  /** 索引根（workspace 相对 posix 路径；`.` 表示工作区根） */
  readonly roots: readonly string[]
}

/** Windows 盘符绝对路径（`C:/x`）；posix 规则只把前导 `/` 当绝对路径。 */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:\//

/** UNC 绝对路径（`//server/share/x`，反斜杠已归一为 `/`）。 */
const UNC_ABSOLUTE = /^\/\/[^/]/

/** 反斜杠归一为 `/`（Windows 风格 include / 路径与平台无关地比较）。 */
function toPosix(value: string): string {
  return value.replace(/\\/g, '/')
}

/**
 * include 文本本身是否绝对路径。
 *
 * 绝对 include（`/etc/passwd`、`C:/...`、`\\server\share`）在真实工程里表示系统/编译器
 * 搜索路径下的文件，绝不等价于工作区里的同名相对路径。必须在构造候选**之前**拒绝：
 * 否则 `src/a.c` 里的 `/etc/passwd` 会被 dir 候选归一成 `src/etc/passwd`，甚至在根目录
 * 文件里归一成 `etc/passwd`，从而对工作区里恰好存在的 `etc/passwd` 造出假边。
 */
function isAbsoluteInclude(include: string): boolean {
  return path.posix.isAbsolute(include) || WINDOWS_ABSOLUTE.test(include)
}

/**
 * 归一 indexRoot，规则与 walk 的 `toRelativeRoot` 对齐（walk 无 workspaceRoot 可相对化时
 * 的等价部分）：`\`→`/`、折叠重复 `/`、去前导 `./`、去尾部 `/`。
 * 绝对 root 保持绝对（拼出的候选会被 isWorkspaceRelative 拒绝，不会误命中工作区路径）。
 */
function normalizeRoot(root: string): string {
  let rel = toPosix(root).trim().replace(/\/{2,}/g, '/')
  while (rel.startsWith('./')) rel = rel.slice(2)
  return rel.replace(/\/+$/, '')
}

/**
 * 只有 workspace 相对、非 `.`/`..`/绝对路径的候选才可能是索引内文件。
 *
 * 候选已经过 `toPosix`（`\`→`/`）与 `path.posix.normalize`，所以这里还要显式拒绝
 * 两种「posix 规则看不出来」的 Windows 绝对形式：
 * - 盘符：`C:/x` 不是 posix 绝对路径，若照收会去匹配索引里恰好叫 `C:` 的目录；
 * - UNC：`//server/share` 在部分实现里被折叠成 `/server/share`（后者已由
 *   `path.posix.isAbsolute` 拒绝），这里再挡一次归一后仍保留双斜杠的形式。
 */
function isWorkspaceRelative(candidate: string): boolean {
  return (
    candidate !== '' &&
    candidate !== '.' &&
    candidate !== '..' &&
    !candidate.startsWith('../') &&
    !path.posix.isAbsolute(candidate) &&
    !WINDOWS_ABSOLUTE.test(candidate) &&
    !UNC_ABSOLUTE.test(candidate)
  )
}

/**
 * 解析单个 include；返回命中的索引内文件路径，未命中返回 undefined。
 */
export function resolveIncludePath(
  fromFile: string,
  includePath: string,
  context: IncludeResolutionContext,
): string | undefined {
  const include = toPosix(includePath).trim()
  if (include === '' || isAbsoluteInclude(include)) return undefined
  const from = toPosix(fromFile)
  const dir = path.posix.dirname(from)

  // 候选去重（例如 roots 里的 `.` 与「原样」候选重复），顺序即优先级。
  const seen = new Set<string>()
  const consider = (candidate: string): string | undefined => {
    const normalized = path.posix.normalize(candidate)
    if (seen.has(normalized)) return undefined
    seen.add(normalized)
    if (!isWorkspaceRelative(normalized)) return undefined
    return context.indexedPaths.has(normalized) ? normalized : undefined
  }

  const relative = consider(path.posix.join(dir, include))
  if (relative !== undefined) return relative
  const asIs = consider(include)
  if (asIs !== undefined) return asIs
  for (const root of context.roots) {
    const rooted = consider(path.posix.join(normalizeRoot(root), include))
    if (rooted !== undefined) return rooted
  }
  return undefined
}

/**
 * 批量解析一个文件里的 include 列表：保持首次出现顺序、按目标去重、丢弃未命中。
 * （同一目标的重复 `#include` 只会增加无意义的边。）
 */
export function resolveIncludePaths(
  fromFile: string,
  includePaths: Iterable<string>,
  context: IncludeResolutionContext,
): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  for (const includePath of includePaths) {
    const target = resolveIncludePath(fromFile, includePath, context)
    if (target === undefined || seen.has(target)) continue
    seen.add(target)
    result.push(target)
  }
  return result
}
