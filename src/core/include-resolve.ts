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
 *   ——索引内文件都是 workspace 相对 posix 路径，这类候选不可能命中，显式跳过更清晰。
 */

export interface IncludeResolutionContext {
  /** 索引内文件路径集合（workspace 相对 posix 路径） */
  readonly indexedPaths: ReadonlySet<string>
  /** 索引根（workspace 相对 posix 路径；`.` 表示工作区根） */
  readonly roots: readonly string[]
}

/** 反斜杠归一为 `/`（Windows 风格 include / 路径与平台无关地比较）。 */
function toPosix(value: string): string {
  return value.replace(/\\/g, '/')
}

/** 只有 workspace 相对、非 `.`/`..`/绝对路径的候选才可能是索引内文件。 */
function isWorkspaceRelative(candidate: string): boolean {
  return (
    candidate !== '' &&
    candidate !== '.' &&
    candidate !== '..' &&
    !candidate.startsWith('../') &&
    !path.posix.isAbsolute(candidate)
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
  if (include === '') return undefined
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
    const rooted = consider(path.posix.join(toPosix(root), include))
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
