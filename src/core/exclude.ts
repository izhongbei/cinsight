/**
 * Glob 排除匹配（A）。
 *
 * 语义（大小写敏感，路径均为相对 workspace 根的 posix 路径）：
 * - `*`  段内任意字符（不跨 `/`）；`?` 段内单字符（不跨 `/`）。
 * - `**` 跨目录任意字符；`**\/` 作为完整路径段时：
 *     位于模式开头的 `**\/` 可匹配 0 层或更多层目录（`**\/build/**` 能匹配根目录下的 `build/a.c`）；
 *     位于模式中间的 `**\/` 至少匹配 1 层目录（`a/**\/*.c` 不匹配 `a/c.c`，与计划 Task 2 用例 2 一致）。
 * - 以 `/` 开头的模式锚定在 workspace 根；否则可命中任意层级。
 * - 不含 `**` 的模式同时按「该路径本身」和「该目录下全部内容」匹配，
 *   因此字面目录模式 `build` 等价于排除任意层级的 `build` 目录及其子树。
 */
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g

function escapeRegExp(ch: string): string {
  return ch.replace(REGEX_SPECIAL, '\\$&')
}

/** 统一成 posix 分隔符、去掉重复 `/` 与前导 `./`。 */
function normalizePath(value: string): string {
  let out = value.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  while (out.startsWith('./')) out = out.slice(2)
  return out
}

/** 把 glob（已去掉锚定 `/`、已归一化）转成正则体。 */
function globBody(pattern: string): string {
  let out = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          // 开头的 **/ 允许 0 层；中间的 **/ 至少 1 层
          out += i === 0 ? '(?:[^/]+/)*' : '(?:[^/]+/)+'
          i += 3
          continue
        }
        out += '.*'
        i += 2
        continue
      }
      out += '[^/]*'
      i += 1
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      i += 1
      continue
    }
    if (ch === '/') {
      out += '/'
      i += 1
      continue
    }
    out += escapeRegExp(ch)
    i += 1
  }
  return out
}

/** 一个用户模式对应的一个或多个正则（不含 `**` 时额外生成目录子树形式）。 */
function patternRegexps(rawPattern: string): RegExp[] {
  let pattern = normalizePath(rawPattern.trim())
  while (pattern.endsWith('/')) pattern = pattern.slice(0, -1)
  if (pattern === '') return []

  const anchored = pattern.startsWith('/')
  const core = anchored ? pattern.slice(1) : pattern
  if (core === '') return []

  const bodies = [globBody(core)]
  if (!core.includes('**')) bodies.push(globBody(core) + '/.*')

  return bodies.map((body) => {
    const prefix = anchored ? '^' : '^(?:.*/)?'
    return new RegExp(`${prefix}${body}$`)
  })
}

/** 判断相对路径是否命中单个 glob 模式。 */
export function matchesGlob(relPath: string, pattern: string): boolean {
  const path = normalizePath(relPath)
  return patternRegexps(pattern).some((regexp) => regexp.test(path))
}

/** 预编译排除模式；返回的函数为 true 表示该路径应被排除。 */
export function compileExclude(patterns: readonly string[]): (relPath: string) => boolean {
  const regexps = patterns.flatMap((pattern) => patternRegexps(pattern))
  if (regexps.length === 0) return () => false
  return (relPath: string) => {
    const path = normalizePath(relPath)
    return regexps.some((regexp) => regexp.test(path))
  }
}
