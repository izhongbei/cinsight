import { SYMBOL_KIND_ORDER, type SymbolEntry, type SymbolTable } from '../shared/types'

/**
 * 定义候选排序：同一个名字在大仓里常有几十份定义（多份内核/驱动拷贝），
 * 直接按路径字典序排会让 F12 候选列表很吵。这里按「与光标所在文件的远近」排序：
 *
 *  0. 被光标所在文件（直接或传递）include 的定义最优先（0.8.0 / B1）；源文件里的定义
 *     天然算 included，因此不需要为它在表里建自环边；
 *  1. 同一个索引根（indexRoots 条目）内的候选优先 —— 你在 component/switch 里点，
 *     就优先跳 component/switch 下的定义，而不是另一棵 datapath 内核树里的同名定义；
 *  2. 与源文件共享的路径前缀段数越多越优先（同目录 > 同模块 > 同树）；
 *  3. 符号种类顺序（定义类优先于 declaration/macro）；
 *  4. 类型符号优先头文件，函数优先源文件；
 *  5. 路径层级更浅、路径更短者优先；
 *  6. 最后按文件/行号保证稳定排序（同一文件内按行号）；
 *  7. 以上全部相同时，无条件定义压过 `#ifdef` 里的定义（0.8.0 / B4，仅作同层
 *     tie-break：条件信息永远不能盖过路径远近）。
 *
 * 无上下文（没有光标文件）时退化为「种类 → 路径」的稳定顺序；没有 `table` 时
 * include 键完全不参与，排序结果与 0.7.0 一致（不劣化）。
 */
export interface RankContext {
  /** 光标所在文件的 workspace 相对 posix 路径 */
  readonly sourceFile?: string
  /** 配置的索引根（workspace 相对 posix 路径） */
  readonly roots?: readonly string[]
  /** 符号表（提供 include 图的 isReachable；缺省时不做 include 加权） */
  readonly table?: SymbolTable
}

const HEADER_RE = /\.(?:h|hh|hpp|hxx|inl)$/i

const TYPE_KINDS = new Set<SymbolEntry['kind']>(['struct', 'union', 'enum', 'typedef'])

function pathSegments(file: string): string[] {
  return file.split('/').filter((part) => part.length > 0)
}

function commonPrefixSegments(a: readonly string[], b: readonly string[]): number {
  const limit = Math.min(a.length, b.length)
  // 最后一段是文件名，不参与「同目录」判断
  const max = Math.max(0, limit - 1)
  let count = 0
  while (count < max && a[count] === b[count]) count++
  return count
}

/** 包含该文件的最长索引根（没有则 undefined）。 */
function rootOf(file: string, roots: readonly string[]): string | undefined {
  let best: string | undefined
  for (const rawRoot of roots) {
    const root = rawRoot.replace(/^\.\/+/, '').replace(/\/+$/, '')
    if (root === '' || root === '.') {
      // 整工作区作为根：任何文件都属于它
      if (best === undefined) best = ''
      continue
    }
    if (file === root || file.startsWith(root + '/')) {
      if (best === undefined || root.length > best.length) best = root
    }
  }
  return best
}

function extensionPreference(entry: SymbolEntry): number {
  const header = HEADER_RE.test(entry.file)
  if (TYPE_KINDS.has(entry.kind)) return header ? 0 : 1
  if (entry.kind === 'function') return header ? 1 : 0
  return 0
}

interface Scored {
  readonly entry: SymbolEntry
  readonly index: number
  /** 0 = 被当前源文件包含（或就在源文件里），1 = 未包含 */
  readonly notIncluded: number
  readonly sameRoot: number
  readonly sharedSegments: number
  readonly kindOrder: number
  readonly extensionPreference: number
  readonly depth: number
  readonly length: number
  /** 0 = 无条件，1 = 处于 #ifdef 等条件块（仅作同层 tie-break） */
  readonly conditional: number
}

/** 判断条目是否被光标文件包含；源文件自身也算 included（不加表内自环边）。 */
function isIncluded(entry: SymbolEntry, context: RankContext): boolean {
  const sourceFile = context.sourceFile
  if (sourceFile === undefined) return false
  if (entry.file === sourceFile) return true
  return context.table !== undefined && context.table.isReachable(sourceFile, entry.file)
}

export function rankDefinitions(
  entries: readonly SymbolEntry[],
  context: RankContext = {},
): SymbolEntry[] {
  if (entries.length <= 1) return [...entries]

  const sourceSegments = context.sourceFile ? pathSegments(context.sourceFile) : []
  const sourceRoot = context.sourceFile ? rootOf(context.sourceFile, context.roots ?? []) : undefined
  const hasRootContext = sourceRoot !== undefined
  // include 键只在同时有源文件与表时参与：无表/无光标时完全退化为 0.7.0 的排序。
  const hasIncludeContext = context.sourceFile !== undefined && context.table !== undefined

  const scored: Scored[] = entries.map((entry, index) => {
    const entrySegments = pathSegments(entry.file)
    const entryRoot = hasRootContext ? rootOf(entry.file, context.roots ?? []) : undefined
    const sameRoot = hasRootContext ? (entryRoot === sourceRoot ? 0 : 1) : 0
    return {
      entry,
      index,
      notIncluded: hasIncludeContext && !isIncluded(entry, context) ? 1 : 0,
      sameRoot,
      sharedSegments: sourceSegments.length > 0 ? -commonPrefixSegments(entrySegments, sourceSegments) : 0,
      kindOrder: SYMBOL_KIND_ORDER[entry.kind] ?? 99,
      extensionPreference: extensionPreference(entry),
      depth: entrySegments.length,
      length: entry.file.length,
      conditional: entry.condition !== undefined && entry.condition !== '' ? 1 : 0,
    }
  })

  scored.sort((a, b) => {
    if (a.notIncluded !== b.notIncluded) return a.notIncluded - b.notIncluded
    if (a.sameRoot !== b.sameRoot) return a.sameRoot - b.sameRoot
    if (a.sharedSegments !== b.sharedSegments) return a.sharedSegments - b.sharedSegments
    if (a.kindOrder !== b.kindOrder) return a.kindOrder - b.kindOrder
    if (a.extensionPreference !== b.extensionPreference) {
      return a.extensionPreference - b.extensionPreference
    }
    if (a.depth !== b.depth) return a.depth - b.depth
    if (a.length !== b.length) return a.length - b.length
    if (a.entry.file !== b.entry.file) return a.entry.file < b.entry.file ? -1 : 1
    if (a.entry.line !== b.entry.line) return a.entry.line - b.entry.line
    // 条件只在「既有规则完全同层」时生效（不同文件/行号仍按稳定顺序）
    if (a.conditional !== b.conditional) return a.conditional - b.conditional
    return a.index - b.index
  })

  return scored.map((item) => item.entry)
}
