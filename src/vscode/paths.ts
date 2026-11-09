/**
 * 路径纯函数工具（不依赖 vscode，可在任何 Node 环境使用）。
 *
 * 约定：
 * - `workspaceRoot`：VS Code 工作区第一个文件夹的绝对路径。
 * - 相对路径（rel）：workspace 相对、posix 分隔符，`.` 表示工作区根。
 * - 索引配置里的 root 也是 workspace 相对 posix 路径。
 */
import * as path from 'node:path'

import { INDEXED_EXTENSIONS } from '../shared/types'

const PATH_SEPARATOR = path.sep

/** 反斜杠统一成 `/`。 */
export function toPosix(value: string): string {
  return value.replace(/\\/g, '/')
}

/**
 * 规范化「workspace 相对路径」：去掉 `./` 前缀、多余斜杠、结尾斜杠；
 * 空串与 `.` 都归一为 `.`（表示工作区根）。
 */
export function normalizeRoot(value: string): string {
  let rel = toPosix(value.trim())
  while (rel.startsWith('./')) {
    rel = rel.slice(2)
  }
  rel = rel.replace(/\/{2,}/g, '/')
  while (rel.length > 1 && rel.endsWith('/')) {
    rel = rel.slice(0, -1)
  }
  if (rel === '' || rel === '/') {
    return '.'
  }
  return rel
}

/** 规范化为文件相对路径（不做 `.` 特判，用于查询/展示）。 */
export function normalizeRelative(value: string): string {
  const rel = normalizeRoot(value)
  return rel === '.' ? '' : rel
}

/** 判断扩展名是否属于可索引的 C/C++ 源文件（大小写敏感，与 core 约定一致）。 */
export function isIndexablePath(relPath: string): boolean {
  const lower = relPath.trim()
  if (!lower) {
    return false
  }
  return INDEXED_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/** 绝对路径拼接：root + posix 相对路径。 */
export function joinPath(rootAbs: string, relPath: string): string {
  if (!relPath || relPath === '.') {
    return rootAbs
  }
  return path.join(rootAbs, relPath.split('/').join(PATH_SEPARATOR))
}

/** 绝对路径 -> workspace 相对 posix 路径（可能以 `../` 开头表示在工作区之外）。 */
export function relativePath(rootAbs: string, absPath: string): string {
  const rel = path.relative(rootAbs, absPath)
  return toPosix(rel)
}

/** rel 是否位于 root 之内（root 已规范化；`.` 表示工作区根）。 */
export function isUnderRoot(rootRel: string, relPath: string): boolean {
  const root = normalizeRoot(rootRel)
  const rel = normalizeRoot(relPath)
  if (root === '.') {
    return !rel.startsWith('../') && rel !== '..'
  }
  return rel === root || rel.startsWith(`${root}/`)
}

/** rel 的父目录（posix）；顶层返回空串。 */
export function dirOfRel(relPath: string): string {
  const rel = normalizeRelative(relPath)
  const index = rel.lastIndexOf('/')
  return index < 0 ? '' : rel.slice(0, index)
}

/** rel 的 basename。 */
export function baseName(relPath: string): string {
  const rel = normalizeRelative(relPath)
  const index = rel.lastIndexOf('/')
  return index < 0 ? rel : rel.slice(index + 1)
}

/**
 * 最小 glob 匹配（`*` 段内、`**` 跨目录、`?` 单字符）。
 * 仅作为 core 的 `compileExclude` 尚未就绪/抛错时的兜底，不导出给业务层直接使用。
 */
export function matchesGlobFallback(relPath: string, pattern: string): boolean {
  const rel = normalizeRoot(relPath)
  let pat = toPosix(pattern.trim())
  if (!pat) {
    return false
  }
  if (!pat.startsWith('/') && !pat.includes('/') && !pat.includes('*')) {
    // `build` 这类目录名模式：匹配任意层级的同名目录及其内容
    pat = `**/${pat}/**`
  } else if (!pat.startsWith('/') && !pat.includes('*') && !pat.endsWith('/**')) {
    pat = `${pat.replace(/^\/+/, '')}/**`
  }
  if (pat.startsWith('/')) {
    pat = pat.slice(1)
  }
  const regex = globToRegExp(pat)
  return regex.test(rel) || regex.test(`${rel}/.`)
}

function globToRegExp(pattern: string): RegExp {
  let out = ''
  let index = 0
  while (index < pattern.length) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        // 与 core/exclude.ts 语义保持一致：
        //   模式开头的 `**/` 匹配 0 层或更多层目录；
        //   中间的 `**/` 至少匹配 1 层目录（`a/**/*.c` 不匹配 `a/c.c`）。
        if (pattern[index + 2] === '/') {
          out += index === 0 ? '(?:[^/]+/)*' : '(?:[^/]+/)+'
          index += 3
        } else {
          out += '.*'
          index += 2
        }
      } else {
        out += '[^/]*'
        index += 1
      }
      continue
    }
    if (char === '?') {
      out += '[^/]'
      index += 1
      continue
    }
    out += escapeRegExpChar(char)
    index += 1
  }
  try {
    return new RegExp(`^${out}$`)
  } catch {
    // 极端模式（非法 UTF-8/正则元字符组合）当作用于匹配全部
    return /^.*$/
  }
}

function escapeRegExpChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char
}

/** 兜底排除匹配：先当文件，再当目录（追加 `/.`）各试一次。 */
export function matchesExcludeFallback(relPath: string, patterns: readonly string[], isDir = false): boolean {
  const rel = normalizeRelative(relPath)
  if (!rel) {
    return false
  }
  return patterns.some((pattern) => {
    if (matchesGlobFallback(rel, pattern)) {
      return true
    }
    return isDir && matchesGlobFallback(`${rel}/.`, pattern)
  })
}
