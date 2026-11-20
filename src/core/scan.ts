import type { ScannedInclude, ScannedSymbol } from '../shared/types'

export type { ScannedInclude } from '../shared/types'

/**
 * C 词法剥离 + 符号提取（A）。
 *
 * 输入是调用方用 latin1 解码后的原始字节（1 字节 = 1 字符），行/列均为 0-based。
 * 两步：
 *  1. `stripSources`：单遍状态机把注释、字符串、字符字面量的内容替换为空格（保留 `\r`/`\n`），
 *     支持反斜杠续行（`//` 注释、字符串内的续行）。
 *  2. `scanSource`：先做 `extern "C" {` 透明化、抽取 `#define NAME(` 函数式宏并把预处理逻辑行整行涂白，
 *     再在 `{}` 深度 0 上做「声明符 → 参数表 → 属性 → `{`/`;`」的启发式识别；
 *     同时（v5）索引 struct/union 成员、枚举常量与文件作用域全局变量。
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
const CH_COLON = 58
const CH_EQUALS = 61
const CH_LBRACE = 123
const CH_RBRACE = 125
const CH_LBRACKET = 91
const CH_RBRACKET = 93
const CH_COMMA = 44
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

/** 参数表之后允许出现、需要整体跳过的属性宏（带参数，如 `__aligned(8)`）。 */
const POST_ATTRIBUTES = new Set<string>([
  '__attribute', '__attribute__', '__declspec', 'asm', '__asm', '__asm__', 'typeof',
  '__typeof', '__typeof__', '__extension__', '_Pragma', '__pragma', '_Alignas', 'alignas',
  // 内核常见、带参数的后置属性：不列出来时 `unsigned long mask __aligned(8);` 会因为
  // 括号被当成函数声明符而整条丢弃，或把 `__aligned` 记成名字。
  '__aligned', '__section', '__cacheline_aligned', '__page_aligned_data', '__page_aligned_bss',
  '__alloc_size', '__printf', '__scanf', '__format', '__nonnull', '__counted_by',
  '__designated_init',
])

/**
 * 无参数的声明符后缀属性宏（不穷举）：`static int foo __read_mostly;`、
 * `char *buf __packed;` 里它们是属性而不是名字。
 *
 * 只在**已经有声明符名之后**才跳过，所以 `int __pad;`（字段名本身以 `__` 开头）
 * 仍会把 `__pad` 当名字；另外 `TRAILING_ATTRIBUTES` 之外的 `__xxx` 若位于声明符段
 * 末尾（后面只剩空白）也按属性处理（内核属性宏几乎都以 `__` 开头）。
 */
const TRAILING_ATTRIBUTES = new Set<string>([
  '__read_mostly', '__write_mostly', '__packed', '__maybe_unused', '__used', '__unused',
  '__always_unused', '__must_check', '__deprecated', '__always_inline', '__noinline',
  '__weak', '__visible', '__cold', '__hot', '__user', '__iomem', '__force', '__rcu',
  '__percpu', '__initdata', '__ro_after_init', '__cacheline_aligned_in_smp',
  '__init', '__exit', '__ref', '__refdata', '__devinit', '__devexit',
])

/** 声明符段里从 from 到 end 是否只有空白（判断属性宏是否位于段尾）。 */
function isWhitespaceOnly(text: string, from: number, end: number): boolean {
  for (let i = from; i < end && i < text.length; i++) {
    if (!isWsCode(text.charCodeAt(i))) return false
  }
  return true
}

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

// ---------------------------------------------------------------------------
// include 与条件栈扫描（只认行首预处理指令；注释/字符串内的伪指令忽略）
// ---------------------------------------------------------------------------

const INCLUDE_RE = /^#\s*include\s*(["<])([^">\s]+)[">]/

/**
 * 扫描文件内的 `#include`，返回去掉引号/尖括号的原始路径与 0-based 行号。
 *
 * `stripSources` 会把字符串内容（包括 include 的引号与路径）涂白，不能直接在剥离结果上取路径；
 * 因此先用剥离结果判断该行的「代码位置」是否真的以 `#` 开头（注释/字符串内的伪指令被涂白后不会命中），
 * 再从原始行的同一列解析真实路径（列号在剥离前后一致）。
 * `#elif/#else` 等条件不影响 include 收集。
 */
export function scanIncludes(text: string): ScannedInclude[] {
  return scanIncludesFromStripped(stripSources(text), text)
}

/**
 * 已剥离文本 + 原始文本 → include 列表（调用方可复用同一份 `stripped`）。
 *
 * 剥离会涂白字符串内容（包括 include 的引号与路径），因此 `stripped` 只用于判断该行的
 * 「代码位置」是否真的以 `#` 开头（注释/字符串内的伪指令被涂白后不会命中），真实路径仍
 * 从 `text` 的同一行、同一列解析（剥离保持列号不变）。
 */
export function scanIncludesFromStripped(stripped: string, text: string): ScannedInclude[] {
  const strippedLines = stripped.split('\n')
  const originalLines = text.split('\n')
  const result: ScannedInclude[] = []
  for (let line = 0; line < strippedLines.length; line++) {
    const strippedLine = strippedLines[line]!
    let hash = 0
    while (hash < strippedLine.length && isWsCode(strippedLine.charCodeAt(hash))) hash++
    if (hash >= strippedLine.length || strippedLine.charCodeAt(hash) !== CH_HASH) continue
    const originalLine = originalLines[line]
    if (originalLine === undefined) continue
    const match = INCLUDE_RE.exec(originalLine.slice(hash))
    if (!match) continue
    result.push({ path: match[2]!, line, angled: match[1] === '<' })
  }
  return result
}

export interface ConditionTimeline {
  /** 按行升序：从 line 起 condition 生效；condition undefined = 无条件 */
  readonly changes: ReadonlyArray<{ readonly line: number; readonly condition: string | undefined }>
}

const CONDITION_DIRECTIVE_RE = /^#\s*(if|ifdef|ifndef|elif|else|endif)\b(.*)$/
const INCLUDE_GUARD_IFNDEF_RE = /^#\s*ifndef\s+([A-Za-z_]\w*)$/
const INCLUDE_GUARD_IF_NOT_DEFINED_RE =
  /^#\s*if\s+!\s*defined\s*(?:\(\s*([A-Za-z_]\w*)\s*\)|([A-Za-z_]\w*))$/
const DEFINE_DIRECTIVE_RE = /^#\s*define\s+([A-Za-z_]\w*)\b/
const MAX_CONDITION_DEPTH = 3
const MAX_CONDITION_LENGTH = 120

interface ConditionFrame {
  readonly text: string
  /** 文件级 include guard：格式化时透明（不参与条件文本） */
  readonly guard: boolean
}

/**
 * 文件级 include guard 检测：首条有内容的指令是 `#ifndef NAME` /
 * `#if !defined(NAME)` / `#if !defined NAME`，在同一层出现其他条件指令之前定义了同名宏，
 * 且配对的 `#endif` 之后文件再无内容。
 *
 * 只有这种「覆盖整个文件」的 guard 才透明化；普通 `#ifndef`（无 `#define`、
 * 不覆盖到文件末尾、或同层还有 `#else`/嵌套条件）仍是普通条件块。
 */
function detectIncludeGuard(
  lines: readonly string[],
): { openLine: number; closeLine: number; name: string } | undefined {
  let openLine = -1
  for (let line = 0; line < lines.length; line++) {
    if (lines[line]!.trim() !== '') {
      openLine = line
      break
    }
  }
  if (openLine < 0) return undefined

  const opener = lines[openLine]!.trim()
  let name: string | undefined
  let match = INCLUDE_GUARD_IFNDEF_RE.exec(opener)
  if (match) name = match[1]
  else {
    match = INCLUDE_GUARD_IF_NOT_DEFINED_RE.exec(opener)
    if (match) name = match[1] ?? match[2]
  }
  if (name === undefined) return undefined

  let depth = 1
  let defineLine = -1
  let closeLine = -1
  for (let line = openLine + 1; line < lines.length; line++) {
    const content = lines[line]!.trim()
    if (content === '') continue
    const directiveMatch = CONDITION_DIRECTIVE_RE.exec(content)
    if (directiveMatch) {
      const directive = directiveMatch[1]!
      if (directive === 'endif') {
        depth -= 1
        if (depth === 0) {
          closeLine = line
          break
        }
        continue
      }
      if (directive === 'else' || directive === 'elif') {
        // guard 自身这一层出现 else/elif：不是纯 guard
        if (depth === 1) return undefined
        continue
      }
      // guard 这一层在 #define NAME 之前出现其他条件指令：不是 guard
      if (depth === 1 && defineLine < 0) return undefined
      depth += 1
      continue
    }
    if (depth === 1 && defineLine < 0) {
      const define = DEFINE_DIRECTIVE_RE.exec(content)
      if (define && define[1] === name) defineLine = line
    }
  }
  if (closeLine < 0 || defineLine < 0) return undefined
  // guard 必须覆盖到文件末尾：配对 #endif 之后不能再有代码/指令
  for (let line = closeLine + 1; line < lines.length; line++) {
    if (lines[line]!.trim() !== '') return undefined
  }
  return { openLine, closeLine, name }
}

/** 记录 #if/#ifdef/#ifndef 条件栈的时间线（不求值；未配对 #endif 忽略；文件级 guard 透明）。 */
export function scanConditions(text: string): ConditionTimeline {
  return collectConditions(stripSources(text))
}

/**
 * 已剥离注释/字符串的文本 → 条件时间线。
 * `scanSource`/`scanFileMeta` 复用同一份剥离结果，避免为条件再整文件扫描一遍。
 */
function collectConditions(stripped: string): ConditionTimeline {
  const lines = stripped.split('\n')
  const guard = detectIncludeGuard(lines)
  const stack: ConditionFrame[] = []
  const changes: Array<{ line: number; condition: string | undefined }> = []
  for (let line = 0; line < lines.length; line++) {
    const match = CONDITION_DIRECTIVE_RE.exec(lines[line]!.trim())
    if (!match) continue
    const directive = match[1]!
    const expression = match[2]!.trim()
    if (directive === 'endif') {
      stack.pop()
      changes.push({ line, condition: formatCondition(stack) })
      continue
    }
    // #else/#elif 只切换同一层内的分支，不改变嵌套层级；0.8.0 只标注「处于哪个条件块」，
    // 因而条件文本保留 enclosing #if（与需求中的示例一致：else 分支仍显示外层 #ifdef）。
    if (directive === 'else' || directive === 'elif') continue
    stack.push({
      text: `#${directive} ${expression}`.trim(),
      guard: guard !== undefined && line === guard.openLine,
    })
    changes.push({ line, condition: formatCondition(stack) })
  }
  return { changes }
}

/**
 * 条件栈文本：跳过 include guard 帧，只保留最内层 MAX_CONDITION_DEPTH 层非 guard 条件，超长截断。
 */
function formatCondition(stack: readonly ConditionFrame[]): string | undefined {
  const active = stack.filter((frame) => !frame.guard)
  if (active.length === 0) return undefined
  const joined = active
    .slice(Math.max(0, active.length - MAX_CONDITION_DEPTH))
    .map((frame) => frame.text)
    .join(' && ')
  return joined.length > MAX_CONDITION_LENGTH ? `${joined.slice(0, MAX_CONDITION_LENGTH - 1)}…` : joined
}

export interface FileScanMeta {
  /** 剥掉注释/字符串后的文本，可复用于 `scanSource(text, stripped)` */
  readonly stripped: string
  readonly includes: ScannedInclude[]
  readonly timeline: ConditionTimeline
}

/**
 * 单遍剥离，同时产出 include 列表与条件时间线。
 * 需要符号时把 `stripped` 传给 `scanSource(text, stripped)`，避免同一文件重复剥离。
 */
export function scanFileMeta(text: string): FileScanMeta {
  return scanFileMetaFromStripped(stripSources(text), text)
}

/**
 * 已剥离文本 + 原始文本 → include + 条件时间线。
 *
 * include 路径在剥离结果里已被涂白，仍需要原始文本还原（剥离前后列号一致），
 * 因此这里同时接收 `text`；构建 worker 用「一次 strip + 本函数」代替分别调用
 * `scanSource`/`scanIncludes` 的重剥离路径。
 */
export function scanFileMetaFromStripped(stripped: string, text: string): FileScanMeta {
  return {
    stripped,
    includes: scanIncludesFromStripped(stripped, text),
    timeline: collectConditions(stripped),
  }
}

/** 返回某行生效的条件（时间线二分）。 */
export function conditionAt(timeline: ConditionTimeline, line: number): string | undefined {
  const changes = timeline.changes
  let low = 0
  let high = changes.length - 1
  let condition: string | undefined
  while (low <= high) {
    const mid = (low + high) >>> 1
    if (changes[mid]!.line <= line) {
      condition = changes[mid]!.condition
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return condition
}

function computeLineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === CH_NL) starts.push(i + 1)
  }
  return starts
}

/** offset 所在行号（0-based）。 */
function lineOf(lineStarts: readonly number[], offset: number): number {
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

/** 跳过参数表后面的 `__attribute__((...))`、`__declspec(...)`、`asm(...)`、`__read_mostly` 等。 */
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
    const word = text.slice(j, end)
    if (!POST_ATTRIBUTES.has(word) && !TRAILING_ATTRIBUTES.has(word)) return j
    let p = end
    while (p < n && isWsCode(text.charCodeAt(p))) p++
    if (p >= n || text.charCodeAt(p) !== CH_LPAREN) {
      // 无参数属性（`__read_mostly` / `__maybe_unused`）只有单独一个记号
      if (TRAILING_ATTRIBUTES.has(word)) {
        j = end
        continue
      }
      return j
    }
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


// ---------------------------------------------------------------------------
// 类型符号：struct / union / enum 标签 与 typedef 名字
// ---------------------------------------------------------------------------

/** 跳过空白，返回第一个非空白字符下标。 */
function skipSpaceText(text: string, from: number): number {
  let k = from
  while (k < text.length && isWsCode(text.charCodeAt(k))) k++
  return k
}

/** 从 from 起读一个标识符。 */
function readWordAt(text: string, from: number): { value: string; start: number; end: number } | undefined {
  if (from >= text.length || !isIdentStartCode(text.charCodeAt(from))) return undefined
  let end = from + 1
  while (end < text.length && isIdentCode(text.charCodeAt(end))) end++
  return { value: text.slice(from, end), start: from, end }
}

/** 跳过 `(...)`，返回右括号之后的下标。 */
function skipParenGroup(text: string, from: number): number {
  if (text.charCodeAt(from) !== CH_LPAREN) return from
  const close = matchPair(text, from, CH_LPAREN, CH_RPAREN)
  return close < 0 ? text.length : close + 1
}

/** 跳过 tag 与 `{` 之间的属性修饰（`__attribute__((...))`、`__declspec(...)`、`__packed` 等）。 */
function skipTypeAttributes(text: string, from: number): number {
  let j = from
  for (;;) {
    const k = skipSpaceText(text, j)
    const word = readWordAt(text, k)
    if (!word) return k
    const isPost = POST_ATTRIBUTES.has(word.value)
    const isTrailing = TRAILING_ATTRIBUTES.has(word.value)
    if (!isPost && !isTrailing) return k
    const p = skipSpaceText(text, word.end)
    if (text.charCodeAt(p) === CH_LPAREN) {
      j = skipParenGroup(text, p)
      continue
    }
    // 无参数属性（`struct foo __packed {`）可以直接跳过
    if (isTrailing) {
      j = word.end
      continue
    }
    return k
  }
}

/** 在 typedef 的一个声明符段里找出被声明的名字：`(*name)`、`name(`、最后一个标识符。 */
function declaratorNameIn(text: string, start: number, end: number): { start: number; end: number } | undefined {
  let paren = -1
  for (let i = start; i < end; i++) {
    if (text.charCodeAt(i) === CH_LPAREN) {
      paren = i
      break
    }
  }

  if (paren >= 0) {
    // 函数指针：(*name)
    let k = paren + 1
    while (k < end && isWsCode(text.charCodeAt(k))) k++
    let star = false
    if (text.charCodeAt(k) === CH_STAR) {
      star = true
      k++
      while (k < end && isWsCode(text.charCodeAt(k))) k++
    }
    const word = readWordAt(text, k)
    if (star && word && word.end <= end) {
      const after = skipSpaceText(text, word.end)
      if (text.charCodeAt(after) === CH_RPAREN) return { start: word.start, end: word.end }
    }

    // 函数类型：`typedef int handler(int);` -> `(` 之前的标识符
    let b = paren - 1
    while (b >= start && (isWsCode(text.charCodeAt(b)) || text.charCodeAt(b) === CH_STAR)) b--
    if (b >= start && isIdentCode(text.charCodeAt(b))) {
      let nameStart = b
      while (nameStart > start && isIdentCode(text.charCodeAt(nameStart - 1))) nameStart--
      const name = text.slice(nameStart, b + 1)
      if (!NAMED_KEYWORDS.has(name) && isIdentStartCode(text.charCodeAt(nameStart))) {
        return { start: nameStart, end: b + 1 }
      }
    }
    return undefined
  }

  // 普通声明符：取最后一个非关键字标识符，跳过 `struct tag` 里的 tag
  let candidate: { start: number; end: number } | undefined
  let prevWord = ''
  let i = start
  while (i < end) {
    const code = text.charCodeAt(i)
    if (isIdentStartCode(code)) {
      const word = readWordAt(text, i)!
      const afterStruct = prevWord === 'struct' || prevWord === 'union' || prevWord === 'enum'
      // 声明符之后的属性宏（`typedef ... foo_t __packed;`）不是别名
      const trailingAttribute =
        candidate !== undefined &&
        (TRAILING_ATTRIBUTES.has(word.value) ||
          (word.value.startsWith('__') && isWhitespaceOnly(text, word.end, end)))
      if (!NAMED_KEYWORDS.has(word.value) && !afterStruct && !trailingAttribute) {
        candidate = { start: word.start, end: word.end }
      }
      prevWord = word.value
      i = word.end
      continue
    }
    if (!isWsCode(code)) prevWord = ''
    i++
  }
  return candidate
}

/** 解析 `typedef ...;`：按顶层逗号切分，逐段抽名字（支持匿名 struct 与函数指针）。 */
function extractTypedefSymbols(
  text: string,
  start: number,
  end: number,
  lineStarts: readonly number[],
  out: ScannedSymbol[],
): void {
  const chunks: Array<[number, number]> = []
  let chunkStart = start
  let nest = 0
  for (let i = start; i < end; i++) {
    const code = text.charCodeAt(i)
    if (code === CH_LPAREN || code === CH_LBRACKET || code === CH_LBRACE) nest++
    else if (code === CH_RPAREN || code === CH_RBRACKET || code === CH_RBRACE) {
      if (nest > 0) nest--
    } else if (code === CH_COMMA && nest === 0) {
      chunks.push([chunkStart, i])
      chunkStart = i + 1
    }
  }
  chunks.push([chunkStart, end])

  const endLine = lineOf(lineStarts, end)
  for (const [chunkStartIdx, chunkEnd] of chunks) {
    // 有类型体时，声明符（别名）在配对的 `}` 之后：必须从该 `}` 之后开始找名字，
    // 否则函数指针成员（`typedef struct { int (*cb)(void *); } ssl_sec_t;`）里的
    // `(` 会让体内标识符 `cb` 被误认成 typedef 名，真正的别名反而丢失。
    const declaratorStart = afterInlineTypeBodies(text, chunkStartIdx, chunkEnd)
    if (declaratorStart >= chunkEnd) continue
    const name = declaratorNameIn(text, declaratorStart, chunkEnd)
    if (!name) continue
    const line = lineOf(lineStarts, name.start)
    out.push({
      name: text.slice(name.start, name.end),
      kind: 'typedef',
      line,
      endLine,
      column: name.start - lineStarts[line],
    })
  }
}


/** `typedef struct tag { ... } alias;` 里的 `tag` 也是被定义的 struct，需要单独索引。 */
function extractTaggedTypeFromTypedef(
  text: string,
  start: number,
  end: number,
  lineStarts: readonly number[],
  out: ScannedSymbol[],
): void {
  const keywordAt = skipSpaceText(text, start)
  const keyword = readWordAt(text, keywordAt)
  if (!keyword || (keyword.value !== 'struct' && keyword.value !== 'union' && keyword.value !== 'enum')) {
    return
  }
  const tagAt = skipTypeAttributes(text, keyword.end)
  const tag = readWordAt(text, tagAt)
  if (!tag || NAMED_KEYWORDS.has(tag.value)) return
  const afterTag = skipTypeAttributes(text, tag.end)
  if (text.charCodeAt(afterTag) !== CH_LBRACE) return // `typedef struct foo foo_t;`：不是定义
  const line = lineOf(lineStarts, tag.start)
  out.push({
    name: tag.value,
    kind: keyword.value === 'struct' ? 'struct' : keyword.value === 'union' ? 'union' : 'enum',
    line,
    endLine: lineOf(lineStarts, end),
    column: tag.start - lineStarts[line],
  })
}

/**
 * 深度 0 扫描类型符号：`struct/union/enum NAME { ... }`（定义）、`struct NAME;`（前置声明）、
 * `typedef ... NAME;`（含匿名 struct 与函数指针 typedef）。函数体内的类型不索引。
 */
function scanTypes(text: string, lineStarts: readonly number[]): ScannedSymbol[] {
  const n = text.length
  const symbols: ScannedSymbol[] = []
  let i = 0
  let depth = 0

  while (i < n) {
    const code = text.charCodeAt(i)
    if (code === CH_LBRACE) {
      depth++
      i++
      continue
    }
    if (code === CH_RBRACE) {
      if (depth > 0) depth--
      i++
      continue
    }
    if (depth !== 0 || !isIdentStartCode(code)) {
      i++
      continue
    }

    const word = readWordAt(text, i)!
    const keyword = word.value

    if (keyword === 'struct' || keyword === 'union' || keyword === 'enum') {
      let p = skipTypeAttributes(text, word.end)
      if (text.charCodeAt(p) === CH_LBRACE) {
        // 匿名类型：本体跳过（`typedef ... { ... } alias;` 的别名成员由 scanMembers 处理，§3.2）
        const close = matchPair(text, p, CH_LBRACE, CH_RBRACE)
        i = close < 0 ? n : close + 1
        continue
      }
      const tag = readWordAt(text, p)
      if (!tag || NAMED_KEYWORDS.has(tag.value)) {
        i = word.end
        continue
      }
      const afterTag = skipTypeAttributes(text, tag.end)
      const next = text.charCodeAt(afterTag)
      if (next === CH_LBRACE) {
        const close = matchPair(text, afterTag, CH_LBRACE, CH_RBRACE)
        if (close < 0) {
          i = tag.end
          continue
        }
        const line = lineOf(lineStarts, tag.start)
        symbols.push({
          name: tag.value,
          kind: keyword === 'struct' ? 'struct' : keyword === 'union' ? 'union' : 'enum',
          line,
          endLine: lineOf(lineStarts, close),
          column: tag.start - lineStarts[line],
        })
        i = close + 1
        continue
      }
      if (next === CH_SEMI) {
        const line = lineOf(lineStarts, tag.start)
        symbols.push({
          name: tag.value,
          kind: 'declaration',
          line,
          endLine: line,
          column: tag.start - lineStarts[line],
        })
        i = tag.end
        continue
      }
      // `struct foo *p;` 等使用场景：只跳过 tag，不索引
      i = tag.end
      continue
    }

    if (keyword === 'typedef') {
      let j = word.end
      let nest = 0
      let end = -1
      while (j < n) {
        const c = text.charCodeAt(j)
        if (c === CH_LPAREN || c === CH_LBRACKET || c === CH_LBRACE) nest++
        else if (c === CH_RPAREN || c === CH_RBRACKET || c === CH_RBRACE) {
          if (nest > 0) nest--
        } else if (c === CH_SEMI && nest === 0) {
          end = j
          break
        }
        j++
      }
      if (end < 0) {
        i = word.end
        continue
      }
      extractTaggedTypeFromTypedef(text, word.end, end, lineStarts, symbols)
      extractTypedefSymbols(text, word.end, end, lineStarts, symbols)
      i = end + 1
      continue
    }

    i = word.end
  }

  // v5：成员 / 枚举常量 / 全局变量与本函数共用同一份 clean 文本与行起始表
  return symbols.concat(
    scanMembersFromClean(text, lineStarts),
    scanEnumConstantsFromClean(text, lineStarts),
    scanGlobalsFromClean(text, lineStarts),
  )
}

// ---------------------------------------------------------------------------
// 成员 / 枚举常量 / 全局变量（v5）
// ---------------------------------------------------------------------------

interface NameRange {
  readonly start: number
  readonly end: number
}

/** 在 [start,end) 中找不在 ()/[]/{} 内的第一个 target 字符；找不到返回 -1。 */
function findTopLevelChar(text: string, start: number, end: number, target: number): number {
  let paren = 0
  let bracket = 0
  let brace = 0
  for (let i = start; i < end; i++) {
    const code = text.charCodeAt(i)
    if (code === CH_LPAREN) paren++
    else if (code === CH_RPAREN) {
      if (paren > 0) paren--
    } else if (code === CH_LBRACKET) bracket++
    else if (code === CH_RBRACKET) {
      if (bracket > 0) bracket--
    } else if (code === CH_LBRACE) brace++
    else if (code === CH_RBRACE) {
      if (brace > 0) brace--
    } else if (code === target && paren === 0 && bracket === 0 && brace === 0) {
      return i
    }
  }
  return -1
}

/** 按顶层分隔符切分 [start,end)，返回各段区间（括号/方括号/花括号内的分隔符不切）。 */
function splitTopLevel(
  text: string,
  start: number,
  end: number,
  separator: number,
): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let chunkStart = start
  let paren = 0
  let bracket = 0
  let brace = 0
  for (let i = start; i < end; i++) {
    const code = text.charCodeAt(i)
    if (code === CH_LPAREN) paren++
    else if (code === CH_RPAREN) {
      if (paren > 0) paren--
    } else if (code === CH_LBRACKET) bracket++
    else if (code === CH_RBRACKET) {
      if (bracket > 0) bracket--
    } else if (code === CH_LBRACE) brace++
    else if (code === CH_RBRACE) {
      if (brace > 0) brace--
    } else if (code === separator && paren === 0 && bracket === 0 && brace === 0) {
      ranges.push([chunkStart, i])
      chunkStart = i + 1
    }
  }
  ranges.push([chunkStart, end])
  return ranges
}

/** 段内是否含花括号（内联/匿名 struct/union 成员或初始化器）。 */
function containsBrace(text: string, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    if (text.charCodeAt(i) === CH_LBRACE) return true
  }
  return false
}

/**
 * 跳过段内的内联类型体 `{...}`，返回最后一个 `}` 之后的位置：
 * `union { int x; } u;` 只索引具名成员 `u`，匿名类型体内的成员不产生符号。
 */
function afterInlineTypeBodies(text: string, start: number, end: number): number {
  let i = start
  for (;;) {
    let open = -1
    for (let k = i; k < end; k++) {
      if (text.charCodeAt(k) === CH_LBRACE) {
        open = k
        break
      }
    }
    if (open < 0) return i
    const close = matchPair(text, open, CH_LBRACE, CH_RBRACE)
    if (close < 0 || close >= end) return end
    i = close + 1
  }
}

/** 顶层第一个非属性组的 `(`（`__attribute__((...))` 等整体跳过）；没有返回 -1。 */
function findDeclaratorParen(text: string, start: number, end: number): number {
  let i = start
  while (i < end) {
    const code = text.charCodeAt(i)
    if (isIdentStartCode(code)) {
      const word = readWordAt(text, i)!
      if (POST_ATTRIBUTES.has(word.value)) {
        const p = skipSpaceText(text, word.end)
        if (text.charCodeAt(p) === CH_LPAREN) {
          const close = matchPair(text, p, CH_LPAREN, CH_RPAREN)
          i = close < 0 || close >= end ? end : close + 1
          continue
        }
      }
      i = word.end
      continue
    }
    if (code === CH_LPAREN) return i
    if (code === CH_LBRACKET) {
      // 数组下标里的函数式宏不参与声明符判断
      const close = matchPair(text, i, CH_LBRACKET, CH_RBRACKET)
      i = close < 0 || close >= end ? end : close + 1
      continue
    }
    i++
  }
  return -1
}

/**
 * 从一个声明符段里取出名字：
 * - 函数指针 `int (*cb)(void)` → `cb`
 * - 普通声明符（含多声明符的后续段）→ 最后一个标识符，跳过 `struct/union/enum tag`
 * 属性组与数组下标整体跳过；位域 `:`、初始化器 `=` 之前的部分由调用方先截断。
 * 带括号但不是函数指针形态的段（原型宏等）不产生名字。
 * 声明符之后的属性宏（`__packed` / `__read_mostly` / `__aligned(8)`）不算名字：
 * 已知的无参数属性直接跳过；其他 `__` 前缀记号在已有名字且位于段尾时也按属性处理
 * （`int __pad;` 这种没有前置名字的字段名仍保留）。
 */
function declaratorNameInRange(text: string, start: number, end: number): NameRange | undefined {
  let parenAt = -1
  let candidate: NameRange | undefined
  let prevWord = ''
  let i = start
  while (i < end) {
    const code = text.charCodeAt(i)
    if (isIdentStartCode(code)) {
      const word = readWordAt(text, i)!
      const p = skipSpaceText(text, word.end)
      if (POST_ATTRIBUTES.has(word.value) && text.charCodeAt(p) === CH_LPAREN) {
        i = Math.min(skipParenGroup(text, p), end)
        prevWord = ''
        continue
      }
      const hasCandidate = candidate !== undefined
      if (hasCandidate && (TRAILING_ATTRIBUTES.has(word.value) || POST_ATTRIBUTES.has(word.value))) {
        // 无参数的后置属性宏：`... foo __read_mostly;` / `... buf __packed;`
        i = word.end
        prevWord = ''
        continue
      }
      if (hasCandidate && word.value.startsWith('__')) {
        // 兜底：未列出的内核属性宏。带参数的 `__xxx(...)` 整体跳过；仅在段尾出现的
        // `__xxx`（后面只剩空白）按属性丢弃。
        if (text.charCodeAt(p) === CH_LPAREN) {
          i = Math.min(skipParenGroup(text, p), end)
          prevWord = ''
          continue
        }
        if (isWhitespaceOnly(text, word.end, end)) {
          i = word.end
          prevWord = ''
          continue
        }
      }
      if (parenAt < 0) {
        const isTypeTag = prevWord === 'struct' || prevWord === 'union' || prevWord === 'enum'
        if (!isTypeTag && !NAMED_KEYWORDS.has(word.value)) {
          candidate = { start: word.start, end: word.end }
        }
      }
      prevWord = word.value
      i = word.end
      continue
    }
    if (code === CH_LPAREN) {
      if (parenAt < 0) parenAt = i
      const close = matchPair(text, i, CH_LPAREN, CH_RPAREN)
      i = close < 0 || close >= end ? end : close + 1
      prevWord = ''
      continue
    }
    if (code === CH_LBRACKET) {
      const close = matchPair(text, i, CH_LBRACKET, CH_RBRACKET)
      i = close < 0 || close >= end ? end : close + 1
      prevWord = ''
      continue
    }
    if (!isWsCode(code)) prevWord = ''
    i++
  }
  if (parenAt >= 0) {
    // 只接受函数指针形态 `(*name)`；其余带括号的段（函数声明/原型宏）不算声明符
    let k = parenAt + 1
    while (k < end && isWsCode(text.charCodeAt(k))) k++
    if (text.charCodeAt(k) !== CH_STAR) return undefined
    k++
    while (k < end && isWsCode(text.charCodeAt(k))) k++
    const word = readWordAt(text, k)
    if (!word || word.end > end) return undefined
    let after = skipSpaceText(text, word.end)
    // 函数指针数组：`int (*handlers[4])(void);`
    while (text.charCodeAt(after) === CH_LBRACKET) {
      const bracketClose = matchPair(text, after, CH_LBRACKET, CH_RBRACKET)
      if (bracketClose < 0 || bracketClose >= end) return undefined
      after = skipSpaceText(text, bracketClose + 1)
    }
    if (text.charCodeAt(after) !== CH_RPAREN) return undefined
    return NAMED_KEYWORDS.has(word.value) ? undefined : { start: word.start, end: word.end }
  }
  return candidate
}

/** 压入一个「名字 → 符号」的结果（成员/枚举常量/全局变量共用行号/列号语义）。 */
function pushNamedSymbol(
  text: string,
  name: NameRange,
  kind: ScannedSymbol['kind'],
  parent: string | undefined,
  endLine: number,
  lineStarts: readonly number[],
  out: ScannedSymbol[],
): void {
  const line = lineOf(lineStarts, name.start)
  const symbol: ScannedSymbol = {
    name: text.slice(name.start, name.end),
    kind,
    line,
    endLine,
    column: name.start - lineStarts[line],
  }
  out.push(parent === undefined ? symbol : { ...symbol, parent })
}

/**
 * 关键字之前是否处于同一条 `typedef` 语句（用于匿名类型体的别名成员索引）。
 *
 * 只在 depth 0 调用：从关键字向左找到最近的语句边界（`;`/`{`/`}`），该边界之后的
 * 第一个记号是 `typedef` 时返回 true；`struct { ... } var;` 这类无 typedef 的匿名类型
 * 体返回 false（成员保持不索引，见 §3.2 的已知限制）。
 */
function isTypedefStatementAt(text: string, keywordStart: number): boolean {
  let k = keywordStart - 1
  while (k >= 0) {
    const code = text.charCodeAt(k)
    if (code === CH_SEMI || code === CH_LBRACE || code === CH_RBRACE) break
    k--
  }
  let p = k + 1
  while (p < keywordStart && isWsCode(text.charCodeAt(p))) p++
  const word = readWordAt(text, p)
  return word !== undefined && word.end <= keywordStart && word.value === 'typedef'
}

/**
 * `typedef struct { ... } alias;` 中类型体之后的第一个声明符名（别名）。
 *
 * 多声明符（`} a_t, *b_t;`）取第一个别名作为 parent；属性组（`__attribute__((...))`）
 * 由 `declaratorNameInRange` 整体跳过。找不到语句 `;` 或没有声明符时返回 undefined。
 */
function trailingTypedefAlias(text: string, afterBody: number): string | undefined {
  const end = findStatementSemicolon(text, afterBody)
  if (end < 0) return undefined
  const first = splitTopLevel(text, afterBody, end, CH_COMMA)[0]
  if (first === undefined) return undefined
  const name = declaratorNameInRange(text, first[0], first[1])
  return name === undefined ? undefined : text.slice(name.start, name.end)
}

/** 解析 struct/union 体（`{`/`}` 之间）的成员声明。 */
function collectMembers(
  text: string,
  bodyStart: number,
  bodyEnd: number,
  parent: string,
  lineStarts: readonly number[],
  out: ScannedSymbol[],
): void {
  // 先按顶层的 `;` 切成员声明，再在每条声明内按逗号切声明符
  for (const [statementStart, statementEnd] of splitTopLevel(text, bodyStart, bodyEnd, CH_SEMI)) {
    for (const [chunkStart, chunkEnd] of splitTopLevel(text, statementStart, statementEnd, CH_COMMA)) {
      let cut = chunkEnd
      const colon = findTopLevelChar(text, chunkStart, chunkEnd, CH_COLON)
      if (colon >= 0) cut = Math.min(cut, colon)
      const equals = findTopLevelChar(text, chunkStart, chunkEnd, CH_EQUALS)
      if (equals >= 0) cut = Math.min(cut, equals)
      // 内联/匿名类型体：跳过类型体本身；类型体后面若还有具名成员则照常索引（§3.2）
      const declaratorStart = afterInlineTypeBodies(text, chunkStart, cut)
      if (declaratorStart >= cut) continue
      const name = declaratorNameInRange(text, declaratorStart, cut)
      if (!name) continue
      pushNamedSymbol(text, name, 'member', parent, lineOf(lineStarts, statementEnd), lineStarts, out)
    }
  }
}

/**
 * 扫描 struct/union 定义的成员（仅文件作用域）。
 *
 * 具名类型体（`struct tag { ... }`）的 parent = tag；匿名类型体只有在
 * `typedef struct/union { ... } alias;` 形态下才索引 depth-1 成员，parent = 第一个别名；
 * 没有 typedef 别名的匿名类型体（`struct { int x; } var;`）整体跳过（§3.2 已知限制）。
 */
function scanMembersFromClean(text: string, lineStarts: readonly number[]): ScannedSymbol[] {
  const n = text.length
  const out: ScannedSymbol[] = []
  let i = 0
  let depth = 0
  while (i < n) {
    const code = text.charCodeAt(i)
    if (code === CH_LBRACE) {
      depth++
      i++
      continue
    }
    if (code === CH_RBRACE) {
      if (depth > 0) depth--
      i++
      continue
    }
    if (depth !== 0 || !isIdentStartCode(code)) {
      i++
      continue
    }
    const word = readWordAt(text, i)!
    if (word.value === 'struct' || word.value === 'union') {
      const p = skipTypeAttributes(text, word.end)
      if (text.charCodeAt(p) === CH_LBRACE) {
        // 匿名类型体：仅在 typedef 语句里时用尾部别名作 parent（§3.2）
        const close = matchPair(text, p, CH_LBRACE, CH_RBRACE)
        if (close < 0) {
          i = n
          continue
        }
        if (isTypedefStatementAt(text, word.start)) {
          const alias = trailingTypedefAlias(text, close + 1)
          if (alias !== undefined) collectMembers(text, p + 1, close, alias, lineStarts, out)
        }
        i = close + 1
        continue
      }
      const tag = readWordAt(text, p)
      if (!tag || NAMED_KEYWORDS.has(tag.value)) {
        i = word.end
        continue
      }
      const afterTag = skipTypeAttributes(text, tag.end)
      if (text.charCodeAt(afterTag) !== CH_LBRACE) {
        // `struct tag var;` / `struct tag;`：不是类型定义
        i = tag.end
        continue
      }
      const close = matchPair(text, afterTag, CH_LBRACE, CH_RBRACE)
      if (close < 0) {
        i = tag.end
        continue
      }
      collectMembers(text, afterTag + 1, close, tag.value, lineStarts, out)
      i = close + 1
      continue
    }
    i = word.end
  }
  return out
}

/** 解析 enum 体（`{`/`}` 之间）：逗号分隔，忽略 `= 表达式`。 */
function collectEnumConstants(
  text: string,
  bodyStart: number,
  bodyEnd: number,
  parent: string,
  lineStarts: readonly number[],
  out: ScannedSymbol[],
): void {
  for (const [chunkStart, chunkEnd] of splitTopLevel(text, bodyStart, bodyEnd, CH_COMMA)) {
    let i = skipSpaceText(text, chunkStart)
    // 跳过常量名前的属性宏
    for (;;) {
      const attribute = readWordAt(text, i)
      if (!attribute || !POST_ATTRIBUTES.has(attribute.value)) break
      const p = skipSpaceText(text, attribute.end)
      if (text.charCodeAt(p) !== CH_LPAREN) break
      i = skipSpaceText(text, skipParenGroup(text, p))
    }
    const name = readWordAt(text, i)
    if (!name || name.end > chunkEnd) continue
    // 宏生成的枚举项（如 `CINIT(FILE, LONG) = 1`）不是枚举常量：名字后紧跟 `(`，
    // 而合法枚举常量后面不可能出现 `(`。
    const afterName = skipSpaceText(text, name.end)
    if (afterName < chunkEnd && text.charCodeAt(afterName) === CH_LPAREN) continue
    // endLine 与 name/line 一致：最后一个常量无尾逗号时不能取到结尾 `}` 所在行
    const line = lineOf(lineStarts, name.start)
    pushNamedSymbol(text, name, 'enumConstant', parent, line, lineStarts, out)
  }
}

/** 找从 from 起同层的 `;`（跳过 {}、()、[] 内容）；找不到返回 -1。 */
function findStatementSemicolon(text: string, from: number): number {
  const n = text.length
  let nest = 0
  for (let i = from; i < n; i++) {
    const code = text.charCodeAt(i)
    if (code === CH_LBRACE || code === CH_LPAREN || code === CH_LBRACKET) nest++
    else if (code === CH_RBRACE || code === CH_RPAREN || code === CH_RBRACKET) {
      if (nest > 0) nest--
    } else if (code === CH_SEMI && nest === 0) return i
  }
  return -1
}

/** `typedef enum [tag] { ... } alias;`：常量 parent 优先用 typedef 别名（§3.2）。 */
function collectTypedefEnumConstants(
  text: string,
  start: number,
  end: number,
  lineStarts: readonly number[],
  out: ScannedSymbol[],
): void {
  const keywordAt = skipTypeAttributes(text, skipSpaceText(text, start))
  const enumWord = readWordAt(text, keywordAt)
  if (!enumWord || enumWord.value !== 'enum') return
  let p = skipTypeAttributes(text, enumWord.end)
  let tag: string | undefined
  if (text.charCodeAt(p) !== CH_LBRACE) {
    const tagWord = readWordAt(text, p)
    if (!tagWord || NAMED_KEYWORDS.has(tagWord.value)) return
    tag = tagWord.value
    p = skipTypeAttributes(text, tagWord.end)
  }
  if (text.charCodeAt(p) !== CH_LBRACE) return
  const close = matchPair(text, p, CH_LBRACE, CH_RBRACE)
  if (close < 0 || close >= end) return
  // 别名：`} alias;` 的第一段声明符
  const aliases = splitTopLevel(text, close + 1, end, CH_COMMA)
  const alias = aliases.length > 0 ? declaratorNameInRange(text, aliases[0]![0], aliases[0]![1]) : undefined
  const parent = alias
    ? text.slice(alias.start, alias.end)
    : tag !== undefined
      ? tag
      : '<anonymous>'
  collectEnumConstants(text, p + 1, close, parent, lineStarts, out)
}

/** 扫描枚举定义的常量（仅文件作用域；enum 体里的值表达式忽略）。 */
function scanEnumConstantsFromClean(text: string, lineStarts: readonly number[]): ScannedSymbol[] {
  const n = text.length
  const out: ScannedSymbol[] = []
  let i = 0
  let depth = 0
  while (i < n) {
    const code = text.charCodeAt(i)
    if (code === CH_LBRACE) {
      depth++
      i++
      continue
    }
    if (code === CH_RBRACE) {
      if (depth > 0) depth--
      i++
      continue
    }
    if (depth !== 0 || !isIdentStartCode(code)) {
      i++
      continue
    }
    const word = readWordAt(text, i)!
    if (word.value === 'typedef') {
      const end = findStatementSemicolon(text, word.end)
      if (end < 0) {
        i = word.end
        continue
      }
      collectTypedefEnumConstants(text, word.end, end, lineStarts, out)
      i = end + 1
      continue
    }
    if (word.value === 'enum') {
      const p = skipTypeAttributes(text, word.end)
      if (text.charCodeAt(p) === CH_LBRACE) {
        const close = matchPair(text, p, CH_LBRACE, CH_RBRACE)
        if (close < 0) {
          i = word.end
          continue
        }
        collectEnumConstants(text, p + 1, close, '<anonymous>', lineStarts, out)
        i = close + 1
        continue
      }
      const tag = readWordAt(text, p)
      if (!tag || NAMED_KEYWORDS.has(tag.value)) {
        i = word.end
        continue
      }
      const afterTag = skipTypeAttributes(text, tag.end)
      if (text.charCodeAt(afterTag) !== CH_LBRACE) {
        // `enum tag var;` / `enum tag;`：使用/前置声明
        i = tag.end
        continue
      }
      const close = matchPair(text, afterTag, CH_LBRACE, CH_RBRACE)
      if (close < 0) {
        i = tag.end
        continue
      }
      collectEnumConstants(text, afterTag + 1, close, tag.value, lineStarts, out)
      i = close + 1
      continue
    }
    i = word.end
  }
  return out
}

/** 语句第一个记号。 */
function firstWordIn(text: string, start: number, end: number): string | undefined {
  const at = skipSpaceText(text, start)
  if (at >= end) return undefined
  return readWordAt(text, at)?.value
}

/**
 * K&R 老式函数头的第一个 `;` 是参数声明：`)` 之后（跳过属性）若是类型/标识符，
 * 说明后续语句是参数声明而非全局变量，调用方应跳过它们直到函数体 `{`。
 */
function isKrFunctionHeader(text: string, start: number, end: number): boolean {
  const equals = findTopLevelChar(text, start, end, CH_EQUALS)
  const bound = equals >= 0 ? equals : end
  const paren = findDeclaratorParen(text, start, bound)
  if (paren < 0) return false
  const close = matchPair(text, paren, CH_LPAREN, CH_RPAREN)
  if (close < 0 || close >= bound) return false
  const after = skipPostAttributes(text, close + 1)
  return after < bound && isIdentStartCode(text.charCodeAt(after))
}

/**
 * 语句在 `{` 之前是否为函数声明符（有顶层 `)` 且没有顶层 `=`）。
 *
 * 仅用于区分「返回类型以 struct/union/enum 开头的函数体」与「类型体」：
 * 类型定义（`struct tag {`、`typedef struct {`）的 `{` 之前没有顶层 `)`；
 * 初始化器（`int a[] = {`）在 `{` 之前已有 `=`，由调用方先行排除。
 * 属性组（`__attribute__((...))`）内的括号由 `findDeclaratorParen` 整体跳过，
 * 因此 `struct s __attribute__((packed)) { ... };` 仍按类型体处理。
 */
function isFunctionBodyBrace(text: string, stmtStart: number, braceAt: number): boolean {
  if (findTopLevelChar(text, stmtStart, braceAt, CH_EQUALS) >= 0) return false
  const paren = findDeclaratorParen(text, stmtStart, braceAt)
  if (paren < 0) return false
  const close = matchPair(text, paren, CH_LPAREN, CH_RPAREN)
  return close >= 0 && close < braceAt
}

/** 解析一条文件作用域声明语句的变量名（多声明符）。 */
function collectGlobalDeclaration(
  text: string,
  stmtStart: number,
  declaratorStart: number,
  end: number,
  lineStarts: readonly number[],
  out: ScannedSymbol[],
): void {
  if (firstWordIn(text, stmtStart, end) === 'typedef') return
  // 先按顶层逗号切出完整声明符列表，再逐段在自己的顶层 `=` 处截断：初始化器可能含逗号
  // （`int t[] = {1,2,3}, u = 4;`），不能先按第一个 `=` 把整条语句截断。
  const chunks = splitTopLevel(text, declaratorStart, end, CH_COMMA)
  // 语句级函数声明守卫：首个声明符分隔符（第一个顶层逗号）之前若出现声明符名后的
  // 顶层 `(`，则是函数声明/原型宏，整条跳过；函数指针 `(*name)` 例外，
  // 初始化器 `= f(1)` 里的括号不参与判断。
  const firstEquals = findTopLevelChar(text, chunks[0]![0], chunks[0]![1], CH_EQUALS)
  const firstBound = firstEquals >= 0 ? firstEquals : chunks[0]![1]
  const paren = findDeclaratorParen(text, chunks[0]![0], firstBound)
  if (paren >= 0) {
    const after = skipSpaceText(text, paren + 1)
    const code = after < firstBound ? text.charCodeAt(after) : -1
    if (code !== CH_STAR) return
  }
  for (const [chunkStart, chunkEnd] of chunks) {
    const equals = findTopLevelChar(text, chunkStart, chunkEnd, CH_EQUALS)
    const bound = equals >= 0 ? equals : chunkEnd
    const colon = findTopLevelChar(text, chunkStart, bound, CH_COLON)
    const cut = colon >= 0 ? colon : bound
    if (containsBrace(text, chunkStart, cut)) continue
    const name = declaratorNameInRange(text, chunkStart, cut)
    if (!name) continue
    pushNamedSymbol(text, name, 'variable', undefined, lineOf(lineStarts, end), lineStarts, out)
  }
}

/**
 * 扫描文件作用域全局变量：depth 0、非 typedef、非函数声明、非类型定义体内部；
 * 支持 static/extern/const、指针/数组/多声明符与函数指针变量。
 */
function scanGlobalsFromClean(text: string, lineStarts: readonly number[]): ScannedSymbol[] {
  const n = text.length
  const out: ScannedSymbol[] = []
  let i = 0
  let stmtStart = 0
  let declaratorStart = 0
  let krParams = false
  while (i < n) {
    const code = text.charCodeAt(i)
    if (code === CH_LBRACE) {
      const close = matchPair(text, i, CH_LBRACE, CH_RBRACE)
      if (close < 0) break
      if (findTopLevelChar(text, stmtStart, i, CH_EQUALS) >= 0) {
        // 初始化器 `{...}`：语句继续到 `;`
        i = close + 1
        continue
      }
      if (krParams) {
        krParams = false
        i = close + 1
        stmtStart = i
        declaratorStart = i
        continue
      }
      const first = firstWordIn(text, stmtStart, i)
      if (first === 'struct' || first === 'union' || first === 'enum') {
        if (!isFunctionBodyBrace(text, stmtStart, i)) {
          // 类型体：`struct s { ... } var;` 的 var 在 `}` 之后
          declaratorStart = close + 1
          i = close + 1
          continue
        }
        // 返回类型以类型关键字开头的函数定义（`struct point *make(void) { ... }`）：
        // 跳过函数体并把语句起点前移到 `}` 之后，否则下一条 `;` 语句会按旧的
        // `struct` 分类，使随后的 typedef 被误索引为全局变量（review finding）。
        i = close + 1
        stmtStart = i
        declaratorStart = i
        continue
      }
      if (first === 'typedef') {
        // typedef 的类型体：整条语句在 `;` 处按 typedef 跳过
        i = close + 1
        continue
      }
      // 函数体（或无法识别的顶层块）：整体跳过
      i = close + 1
      stmtStart = i
      declaratorStart = i
      continue
    }
    if (code === CH_SEMI) {
      if (!krParams) {
        collectGlobalDeclaration(text, stmtStart, declaratorStart, i, lineStarts, out)
        if (isKrFunctionHeader(text, declaratorStart, i)) krParams = true
      }
      i++
      stmtStart = i
      declaratorStart = i
      continue
    }
    i++
  }
  return out
}

/** 剥离/宏涂白后的文本 + 行起始表（三新扫描的独立入口共用，语义与 scanSource 一致）。 */
function prepareForDetailScan(text: string): { clean: string; lineStarts: number[] } {
  const prepared = blankExternCAfterStrip(stripSources(blankExternCBlocks(text)))
  const lineStarts = computeLineStarts(prepared)
  const { clean } = extractMacros(prepared, lineStarts)
  return { clean, lineStarts }
}

/**
 * 结构体/联合体成员（v5）：kind='member'。
 *
 * parent：具名类型体用 tag；`typedef struct/union { ... } alias;` 的匿名类型体用第一个
 * 别名；无 typedef 别名的匿名类型体（`struct { int x; } var;`）不产生成员（§3.2）。
 */
export function scanMembers(text: string): ScannedSymbol[] {
  if (text.length === 0) return []
  const { clean, lineStarts } = prepareForDetailScan(text)
  return scanMembersFromClean(clean, lineStarts)
}

/** 枚举常量（v5）：kind='enumConstant'，parent=enum tag 或 typedef 别名。 */
export function scanEnumConstants(text: string): ScannedSymbol[] {
  if (text.length === 0) return []
  const { clean, lineStarts } = prepareForDetailScan(text)
  return scanEnumConstantsFromClean(clean, lineStarts)
}

/** 文件作用域全局变量（v5）：kind='variable'，无 parent。 */
export function scanGlobals(text: string): ScannedSymbol[] {
  if (text.length === 0) return []
  const { clean, lineStarts } = prepareForDetailScan(text)
  return scanGlobalsFromClean(clean, lineStarts)
}

/**
 * 扫描一份 C/C++ 源文本，返回函数定义/声明、函数式宏、struct/union/enum 标签与
 * typedef 名字，以及（v5）成员（`member`）、枚举常量（`enumConstant`）与
 * 文件作用域全局变量（`variable`）；成员/枚举常量带 `parent`（所属类型名）。
 * 行号、列号均为 0-based；`endLine` 为函数体/类型体的配对 `}` 所在行
 * （声明、成员、全局变量、宏与 typedef 等于声明所在行）。
 *
 * `stripped` 可选：调用方已对同一 `text` 调用过 `stripSources`（或 `scanFileMeta`）时传入，
 * 避免整文件重复剥离；缺省时内部自行剥离，行为与旧版一致。
 */
export function scanSource(text: string, stripped?: string): ScannedSymbol[] {
  if (text.length === 0) return []
  const prepared = blankExternCAfterStrip(
    stripped === undefined ? stripSources(blankExternCBlocks(text)) : stripped,
  )
  const lineStarts = computeLineStarts(prepared)
  const timeline = collectConditions(prepared)
  const { clean, macros } = extractMacros(prepared, lineStarts)
  const functions = scanFunctions(clean, lineStarts)
  const types = scanTypes(clean, lineStarts)
  const all = macros.concat(functions, types)
  all.sort((a, b) => {
    if (a.line !== b.line) return a.line - b.line
    if (a.column !== b.column) return a.column - b.column
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
  // 绝大多数文件没有条件编译：无变化时直接返回原数组，避免为每个符号额外分配对象。
  if (timeline.changes.length === 0) return all
  return all.map((symbol) => ({ ...symbol, condition: conditionAt(timeline, symbol.line) }))
}
