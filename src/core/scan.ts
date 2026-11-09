import type { ScannedSymbol } from '../shared/types'

/**
 * C 词法剥离 + 符号提取（A）。
 *
 * 输入是调用方用 latin1 解码后的原始字节（1 字节 = 1 字符），行/列均为 0-based。
 * 两步：
 *  1. `stripSources`：单遍状态机把注释、字符串、字符字面量的内容替换为空格（保留 `\r`/`\n`），
 *     支持反斜杠续行（`//` 注释、字符串内的续行）。
 *  2. `scanSource`：先做 `extern "C" {` 透明化、抽取 `#define NAME(` 函数式宏并把预处理逻辑行整行涂白，
 *     再在 `{}` 深度 0 上做「声明符 → 参数表 → 属性 → `{`/`;`」的启发式识别。
 *
 * 已知局限：宏展开产生的函数、`__attribute__` 位于函数名之前、C++ 模板/命名空间、
 * `typedef int f(int);` 之外的复杂函数指针、K&R 极端写法可能漏识别；文件作用域上
 * `static SOME_MACRO(x);` 形式的宏调用可能被误判为 declaration。
 */

const CH_TAB = 9
const CH_NL = 10
const CH_VT = 11
const CH_FF = 12
const CH_CR = 13
const CH_SPACE = 32
const CH_DQUOTE = 34
const CH_HASH = 35
const CH_SQUOTE = 39
const CH_STAR = 42
const CH_LPAREN = 40
const CH_RPAREN = 41
const CH_SEMI = 59
const CH_LBRACE = 123
const CH_RBRACE = 125
const CH_SLASH = 47
const CH_BACKSLASH = 92
const CH_UNDERSCORE = 95

function isWsCode(code: number): boolean {
  return (
    code === CH_SPACE ||
    code === CH_TAB ||
    code === CH_CR ||
    code === CH_NL ||
    code === CH_FF ||
    code === CH_VT
  )
}

function isDigitCode(code: number): boolean {
  return code >= 48 && code <= 57
}

function isIdentStartCode(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === CH_UNDERSCORE
}

function isIdentCode(code: number): boolean {
  return isIdentStartCode(code) || isDigitCode(code)
}

/** 作为「函数名」出现时一律排除的 C 关键字/内建名。 */
const NAMED_KEYWORDS = new Set<string>([
  // 控制/语句
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'return', 'goto',
  'break', 'continue', 'sizeof', 'typedef', 'defined', 'offsetof', '_Generic',
  '_Static_assert', 'static_assert', 'alignof', 'alignas',
  // 类型/修饰符
  'auto', 'char', 'const', 'double', 'enum', 'extern', 'float', 'inline', 'int', 'long',
  'register', 'restrict', 'short', 'signed', 'static', 'struct', 'union', 'unsigned',
  'void', 'volatile', '_Alignas', '_Alignof', '_Atomic', '_Bool', '_Complex',
  '_Imaginary', '_Noreturn', '_Thread_local',
  // 编译器扩展
  '__attribute', '__attribute__', '__declspec', '__asm', '__asm__', 'asm', '__inline',
  '__inline__', '__typeof', '__typeof__', 'typeof', '__extension__', '__const',
  '__const__', '__volatile', '__volatile__', '__signed__', '__unsigned__', '_Pragma',
  '__pragma', '__restrict', '__restrict__', '__aligned', '__builtin_offsetof',
])

/** 出现在候选名之前即说明这是表达式/调用而不是声明符的记号。 */
const CONTROL_KEYWORDS = new Set<string>([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'return', 'goto',
  'break', 'continue', 'sizeof', 'typedef', 'defined', 'offsetof', '_Generic',
  '_Static_assert', 'static_assert', 'alignof', '__attribute', '__attribute__',
  '__declspec', 'asm', '__asm', '__asm__', 'typeof', '__typeof', '__typeof__',
  '_Alignof', '_Pragma', '__pragma', '__extension__', '__builtin_offsetof',
])

/** 参数表之后允许出现、需要整体跳过的属性宏。 */
const POST_ATTRIBUTES = new Set<string>([
  '__attribute', '__attribute__', '__declspec', 'asm', '__asm', '__asm__', 'typeof',
  '__typeof', '__typeof__', '__extension__', '_Pragma', '__pragma', '_Alignas', 'alignas',
])

function makeSpaces(text: string): string {
  return text.replace(/[^\r\n]/g, ' ')
}

/** `extern "C" {` / `extern "C++" {` 是 C++ 兼容包裹，对深度透明化。 */
const EXTERN_C_RAW = /\bextern\s*"C(?:\+\+)?"\s*\{/g
/** 注释被剥掉后 `extern "C" /* x *\/ {` 会变成 `extern       {`，同样透明化。 */
const EXTERN_C_STRIPPED = /\bextern\s*\{/g

function blankExternCBlocks(text: string): string {
  return text.replace(EXTERN_C_RAW, (match) => makeSpaces(match))
}

function blankExternCAfterStrip(text: string): string {
  return text.replace(EXTERN_C_STRIPPED, (match) => makeSpaces(match))
}

/**
 * 把注释、字符串、字符字面量的内容替换为空格（保留换行以维持行号）。
 */
export function stripSources(text: string): string {
  const n = text.length
  const pieces: string[] = []
  let copied = 0
  let i = 0

  const pushCode = (end: number): void => {
    if (end > copied) pieces.push(text.slice(copied, end))
  }
  const pushBlank = (start: number, end: number): void => {
    if (end > start) pieces.push(makeSpaces(text.slice(start, end)))
    copied = end
  }

  while (i < n) {
    const code = text.charCodeAt(i)
    if (code === CH_SLASH && text.charCodeAt(i + 1) === CH_STAR) {
      // 块注释
      pushCode(i)
      let j = i + 2
      let close = -1
      while (j + 1 < n) {
        if (text.charCodeAt(j) === CH_STAR && text.charCodeAt(j + 1) === CH_SLASH) {
          close = j
          break
        }
        j++
      }
      const regionEnd = close >= 0 ? close + 2 : n
      pushBlank(i, regionEnd)
      i = regionEnd
      continue
    }
    if (code === CH_SLASH && text.charCodeAt(i + 1) === CH_SLASH) {
      // 行注释：反斜杠续行时延续到下一行
      pushCode(i)
      let j = i + 2
      while (j < n) {
        if (text.charCodeAt(j) === CH_NL) {
          let k = j - 1
          if (k >= i && text.charCodeAt(k) === CH_CR) k--
          if (k >= i && text.charCodeAt(k) === CH_BACKSLASH) {
            j++
            continue
          }
          break
        }
        j++
      }
      pushBlank(i, j)
      i = j
      continue
    }
    if (code === CH_DQUOTE || code === CH_SQUOTE) {
      // 字符串/字符字面量
      pushCode(i)
      const quote = code
      let j = i + 1
      let closed = false
      while (j < n) {
        const c = text.charCodeAt(j)
        if (c === CH_BACKSLASH) {
          j += j + 1 < n ? 2 : 1
          continue
        }
        if (c === quote) {
          j++
          closed = true
          break
        }
        if (c === CH_NL) break // 未闭合：止于行尾，容错继续
        j++
      }
      pushBlank(i, j)
      i = j
      continue
    }
    i++
  }
  pushCode(n)
  return pieces.join('')
}

function computeLineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === CH_NL) starts.push(i + 1)
  }
  return starts
}

/** offset 所在行号（0-based）。 */
function lineOf(lineStarts: number[], offset: number): number {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStarts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

function blankRanges(text: string, ranges: ReadonlyArray<readonly [number, number]>): string {
  if (ranges.length === 0) return text
  const pieces: string[] = []
  let copied = 0
  for (const [start, end] of ranges) {
    if (start > copied) pieces.push(text.slice(copied, start))
    pieces.push(makeSpaces(text.slice(start, end)))
    copied = end
  }
  if (copied < text.length) pieces.push(text.slice(copied))
  return pieces.join('')
}

/** 行内容（去掉行尾 `\r`）是否以反斜杠结尾（续行）。 */
function endsWithContinuation(content: string): boolean {
  let end = content.length
  if (end > 0 && content.charCodeAt(end - 1) === CH_CR) end--
  return end > 0 && content.charCodeAt(end - 1) === CH_BACKSLASH
}

/**
 * 抽取函数式宏 `#define NAME(`，并把所有预处理逻辑行整行涂白
 * （避免 `{`/`}`/`(` 等影响后续深度与声明符判断）。
 */
function extractMacros(
  text: string,
  lineStarts: readonly number[],
): { clean: string; macros: ScannedSymbol[] } {
  const n = text.length
  const macros: ScannedSymbol[] = []
  const ranges: Array<[number, number]> = []
  let li = 0

  while (li < lineStarts.length) {
    const lineStart = lineStarts[li]
    if (lineStart >= n) break
    const contentEnd = li + 1 < lineStarts.length ? lineStarts[li + 1] - 1 : n

    let p = lineStart
    while (p < contentEnd && isWsCode(text.charCodeAt(p))) p++
    if (p >= contentEnd || text.charCodeAt(p) !== CH_HASH) {
      li++
      continue
    }

    // 逻辑行终点：行尾反斜杠续行
    let lastLine = li
    while (lastLine + 1 < lineStarts.length) {
      const end = lineStarts[lastLine + 1] - 1
      if (!endsWithContinuation(text.slice(lineStarts[lastLine], end))) break
      lastLine++
    }

    // 解析 `# define NAME(`（NAME 与 `(` 之间不能有空白）
    let q = p + 1
    while (q < contentEnd && isWsCode(text.charCodeAt(q))) q++
    const directiveStart = q
    while (q < contentEnd && isIdentCode(text.charCodeAt(q))) q++
    const directive = text.slice(directiveStart, q)
    if (directive === 'define') {
      let r = q
      while (r < contentEnd && isWsCode(text.charCodeAt(r))) r++
      if (r < contentEnd && isIdentStartCode(text.charCodeAt(r))) {
        const nameStart = r
        let nameEnd = r + 1
        while (nameEnd < contentEnd && isIdentCode(text.charCodeAt(nameEnd))) nameEnd++
        if (nameEnd < contentEnd && text.charCodeAt(nameEnd) === CH_LPAREN) {
          macros.push({
            name: text.slice(nameStart, nameEnd),
            kind: 'macro',
            line: li,
            endLine: lastLine,
            column: nameStart - lineStart,
          })
        }
      }
    }

    const blankEnd = lastLine + 1 < lineStarts.length ? lineStarts[lastLine + 1] : n
    ranges.push([lineStart, blankEnd])
    li = lastLine + 1
  }

  return { clean: blankRanges(text, ranges), macros }
}

/** 从 open 位置的 openCode 找到配对 closeCode；未配对返回 -1。 */
function matchPair(text: string, open: number, openCode: number, closeCode: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === openCode) depth++
    else if (code === closeCode) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** 跳过参数表后面的 `__attribute__((...))`、`__declspec(...)`、`asm(...)` 等。 */
function skipPostAttributes(text: string, from: number): number {
  const n = text.length
  let j = from
  for (;;) {
    let k = j
    while (k < n && isWsCode(text.charCodeAt(k))) k++
    j = k
    if (j >= n || !isIdentStartCode(text.charCodeAt(j))) return j
    let end = j + 1
    while (end < n && isIdentCode(text.charCodeAt(end))) end++
    if (!POST_ATTRIBUTES.has(text.slice(j, end))) return j
    let p = end
    while (p < n && isWsCode(text.charCodeAt(p))) p++
    if (p >= n || text.charCodeAt(p) !== CH_LPAREN) return j
    const close = matchPair(text, p, CH_LPAREN, CH_RPAREN)
    if (close < 0) return j
    j = close + 1
  }
}

/** K&R 参数声明之后找函数体 `{`（限窗口，避免把后续无关代码吞进来）。 */
function findBodyBrace(text: string, from: number): number {
  const n = text.length
  const limit = Math.min(n, from + 8192)
  let parens = 0
  let lines = 0
  for (let i = from; i < limit; i++) {
    const code = text.charCodeAt(i)
    if (code === CH_NL) {
      lines++
      if (lines > 64) return -1
    } else if (code === CH_LPAREN) {
      parens++
    } else if (code === CH_RPAREN) {
      if (parens > 0) parens--
    } else if (code === CH_LBRACE && parens === 0) {
      return i
    }
  }
  return -1
}

/** 顶层 item 的第一个记号是否是 `typedef`（`typedef int f(int);` 是函数类型，不是函数）。 */
function firstWordIsTypedef(text: string, stmtStart: number, limit: number): boolean {
  let k = stmtStart
  while (k < limit && isWsCode(text.charCodeAt(k))) k++
  const start = k
  while (k < limit && isIdentCode(text.charCodeAt(k))) k++
  return k > start && text.slice(start, k) === 'typedef'
}

/** 候选名之前必须是「类型/修饰符/指针」而非运算符、调用括号等。 */
function isDeclaratorContext(text: string, nameStart: number, stmtStart: number): boolean {
  let k = nameStart - 1
  while (k >= 0 && isWsCode(text.charCodeAt(k))) k--
  if (k < 0) return false
  const code = text.charCodeAt(k)
  if (isIdentCode(code)) {
    let start = k
    while (start > 0 && isIdentCode(text.charCodeAt(start - 1))) start--
    if (start === stmtStart && text.slice(start, k + 1) === 'typedef') return false
    const word = text.slice(start, k + 1)
    if (isDigitCode(word.charCodeAt(0))) return false
    if (CONTROL_KEYWORDS.has(word)) return false
    return true
  }
  return code === CH_STAR
}

/** 深度 0 扫描：函数定义 / 声明。 */
function scanFunctions(text: string, lineStarts: number[]): ScannedSymbol[] {
  const n = text.length
  const symbols: ScannedSymbol[] = []
  let i = 0
  let depth = 0
  let stmtStart = 0

  while (i < n) {
    const code = text.charCodeAt(i)

    if (code === CH_LBRACE) {
      depth++
      i++
      continue
    }
    if (code === CH_RBRACE) {
      if (depth > 0) depth--
      if (depth === 0) stmtStart = i + 1
      i++
      continue
    }
    if (code === CH_SEMI && depth === 0) {
      stmtStart = i + 1
      i++
      continue
    }

    if (!isIdentStartCode(code)) {
      i++
      continue
    }

    const nameStart = i
    let nameEnd = i + 1
    while (nameEnd < n && isIdentCode(text.charCodeAt(nameEnd))) nameEnd++
    const name = text.slice(nameStart, nameEnd)
    i = nameEnd

    if (depth !== 0) continue
    if (NAMED_KEYWORDS.has(name)) continue

    // 名字后允许跨行空白，但必须紧跟 `(`
    let open = nameEnd
    while (open < n && isWsCode(text.charCodeAt(open))) open++
    if (open >= n || text.charCodeAt(open) !== CH_LPAREN) continue
    // 参数表第一个有效字符就是 `(`：GNU `__P((...))` / `LDAP_P((...))` 这类原型宏调用，不是声明符
    let firstParam = open + 1
    while (firstParam < n && isWsCode(text.charCodeAt(firstParam))) firstParam++
    if (firstParam < n && text.charCodeAt(firstParam) === CH_LPAREN) continue
    if (firstWordIsTypedef(text, stmtStart, nameStart)) continue
    if (!isDeclaratorContext(text, nameStart, stmtStart)) continue

    const close = matchPair(text, open, CH_LPAREN, CH_RPAREN)
    if (close < 0) continue

    const line = lineOf(lineStarts, nameStart)
    const column = nameStart - lineStarts[line]

    let j = skipPostAttributes(text, close + 1)
    const suffix = j < n ? text.charCodeAt(j) : -1

    if (suffix === CH_LBRACE) {
      const bodyEnd = matchPair(text, j, CH_LBRACE, CH_RBRACE)
      if (bodyEnd < 0) {
        i = close + 1
        continue
      }
      symbols.push({ name, kind: 'function', line, endLine: lineOf(lineStarts, bodyEnd), column })
      i = bodyEnd + 1
      stmtStart = bodyEnd + 1
      depth = 0
      continue
    }

    if (suffix === CH_SEMI) {
      symbols.push({ name, kind: 'declaration', line, endLine: line, column })
      i = j + 1
      stmtStart = j + 1
      continue
    }

    // K&R 老式参数表：`)` 之后是参数声明，再之后才是 `{`
    if (suffix >= 0 && (isIdentStartCode(suffix) || suffix === CH_STAR)) {
      const braceAt = findBodyBrace(text, j)
      if (braceAt >= 0) {
        const bodyEnd = matchPair(text, braceAt, CH_LBRACE, CH_RBRACE)
        if (bodyEnd >= 0) {
          symbols.push({ name, kind: 'function', line, endLine: lineOf(lineStarts, bodyEnd), column })
          i = bodyEnd + 1
          stmtStart = bodyEnd + 1
          depth = 0
          continue
        }
      }
    }

    // 后缀形态不认识：从参数表之后继续，避免漏掉后面的定义
    i = close + 1
  }

  return symbols
}

/**
 * 扫描一份 C/C++ 源文本，返回函数定义、声明与函数式宏。
 * 行号、列号均为 0-based；`endLine` 为函数体配对 `}` 所在行（声明/宏等于 `line`）。
 */
export function scanSource(text: string): ScannedSymbol[] {
  if (text.length === 0) return []
  const prepared = blankExternCAfterStrip(stripSources(blankExternCBlocks(text)))
  const lineStarts = computeLineStarts(prepared)
  const { clean, macros } = extractMacros(prepared, lineStarts)
  const functions = scanFunctions(clean, lineStarts)
  const all = macros.concat(functions)
  all.sort((a, b) => {
    if (a.line !== b.line) return a.line - b.line
    if (a.column !== b.column) return a.column - b.column
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
  return all
}
