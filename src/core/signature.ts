import type { ReadFileFn, SymbolEntry } from '../shared/types'

/**
 * 签名重建：从定义行开始拼接（最多 20 行），用与 scan 等价的「词法剥离」把
 * 注释/字符串内容替换为空格（保留换行），再在括号平衡的 `{` 或 `;` 处截断，
 * 最后压缩空白成单行。`stripSources` 同时供 references/callgraph 复用。
 */

const MAX_SIGNATURE_LINES = 20

/**
 * 把注释 / 字符串 / 字符字面量内容替换为空格，换行原样保留。
 * 因此剥离后文本与原文「行号、列号、长度」完全一致，可在其上做精确位置匹配。
 */
export function stripSources(text: string): string {
  const length = text.length
  let out = ''
  let copied = 0
  let i = 0

  while (i < length) {
    const code = text.charCodeAt(i)

    // '/'
    if (code === 47) {
      const next = text.charCodeAt(i + 1)
      if (next === 47 || next === 42) {
        out += text.slice(copied, i)
        const end = next === 47 ? skipLineComment(text, i) : skipBlockComment(text, i)
        out += maskRegion(text, i, end)
        copied = end
        i = end
        continue
      }
      i++
      continue
    }

    // '"' 或 '\''
    if (code === 34 || code === 39) {
      out += text.slice(copied, i)
      const end = skipQuoted(text, i, code)
      out += maskRegion(text, i, end)
      copied = end
      i = end
      continue
    }

    i++
  }

  out += text.slice(copied)
  return out
}

function skipLineComment(text: string, start: number): number {
  let i = start + 2
  while (i < text.length) {
    if (text.charCodeAt(i) === 10) {
      // 反斜杠续行：注释延续到下一行
      if (text.charCodeAt(i - 1) === 92) {
        i++
        continue
      }
      break
    }
    i++
  }
  return i
}

function skipBlockComment(text: string, start: number): number {
  let i = start + 2
  while (i < text.length) {
    if (text.charCodeAt(i) === 42 && text.charCodeAt(i + 1) === 47) return i + 2
    i++
  }
  return text.length
}

function skipQuoted(text: string, start: number, quoteCode: number): number {
  let i = start + 1
  while (i < text.length) {
    const code = text.charCodeAt(i)
    if (code === 92) {
      i += 2
      continue
    }
    if (code === quoteCode) return i + 1
    if (code === 10) return i // 未闭合字面量止于行尾
    i++
  }
  return text.length
}

/** 把 [start, end) 区间替换为等长空格，保留 '\n'。 */
function maskRegion(text: string, start: number, end: number): string {
  const region = text.slice(start, end)
  if (region.indexOf('\n') < 0) return ' '.repeat(region.length)
  return region.replace(/[^\n]/g, ' ')
}

/** 压缩空白为单空格，并去掉括号内侧多余空白。 */
function normalizeSignature(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
}

/**
 * 在剥离后的文本里定位括号平衡的 `{` 或 `;`，返回签名截断位置；找不到返回 -1。
 */
function findSignatureEnd(stripped: string): number {
  let depth = 0
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i]
    if (ch === '(') {
      depth++
    } else if (ch === ')') {
      if (depth > 0) depth--
    } else if (depth === 0) {
      if (ch === '{' || ch === ';') return i
    }
  }
  return -1
}

/** 从 lines[startLine] 起拼接签名；读不到合法签名返回 undefined。 */
function buildSignature(lines: readonly string[], startLine: number): string | undefined {
  const endLine = Math.min(lines.length, startLine + MAX_SIGNATURE_LINES)
  const raw = lines.slice(startLine, endLine).join('\n')
  const stripped = stripSources(raw)
  const end = findSignatureEnd(stripped)
  if (end < 0) return undefined
  const signature = normalizeSignature(stripped.slice(0, end))
  return signature.length > 0 ? signature : undefined
}

/** 函数式宏：按续行拼成一行，去掉行尾续行反斜杠。 */
function buildMacroSignature(lines: readonly string[], entry: SymbolEntry): string | undefined {
  const endLine = Math.min(lines.length, Math.max(entry.line, entry.endLine) + 1)
  const raw = lines
    .slice(entry.line, endLine)
    .map((line) => line.replace(/\\\s*$/, ''))
    .join(' ')
  const signature = normalizeSignature(stripSources(raw))
  return signature.length > 0 ? signature : undefined
}

async function readText(readFile: ReadFileFn, file: string): Promise<string | undefined> {
  try {
    return await readFile(file)
  } catch {
    return undefined
  }
}

export async function readSignature(
  readFile: ReadFileFn,
  entry: SymbolEntry,
): Promise<string | undefined> {
  const text = await readText(readFile, entry.file)
  if (text === undefined) return undefined
  const lines = text.split('\n')
  if (entry.line < 0 || entry.line >= lines.length) return undefined
  if (entry.kind === 'macro') return buildMacroSignature(lines, entry)
  return buildSignature(lines, entry.line)
}

const IDENT_CALL = /[A-Za-z_]\w*\s*\(/

export async function readSignatureAtLine(
  readFile: ReadFileFn,
  file: string,
  line: number,
): Promise<string | undefined> {
  const text = await readText(readFile, file)
  if (text === undefined) return undefined
  const lines = text.split('\n')
  if (line < 0 || line >= lines.length) return undefined
  // 该行必须真的出现 `IDENT(`，否则不当作签名行（悬停兜底用）。
  if (!IDENT_CALL.test(stripSources(lines[line]!))) return undefined
  return buildSignature(lines, line)
}
