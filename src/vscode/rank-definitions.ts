import { SYMBOL_KIND_ORDER, type SymbolEntry } from '../shared/types'

/**
 * 定义候选排序：同一个名字在大仓里常有几十份定义（多份内核/驱动拷贝），
 * 直接按路径字典序排会让 F12 候选列表很吵。这里按「与光标所在文件的远近」排序：
 *
 *  1. 同一个索引根（indexRoots 条目）内的候选优先 —— 你在 component/switch 里点，
 *     就优先跳 component/switch 下的定义，而不是另一棵 datapath 内核树里的同名定义；
 *  2. 与源文件共享的路径前缀段数越多越优先（同目录 > 同模块 > 同树）；
 *  3. 符号种类顺序（定义类优先于 declaration/macro）；
 *  4. 类型符号优先头文件，函数优先源文件；
 *  5. 路径层级更浅、路径更短者优先；
 *  6. 最后按文件/行号保证稳定排序（同一文件内按行号）。
 *
 * 无上下文（没有光标文件）时退化为「种类 → 路径」的稳定顺序。
 */
export interface RankContext {
  /** 光标所在文件的 workspace 相对 posix 路径 */
  readonly sourceFile?: string
  /** 配置的索引根（workspace 相对 posix 路径） */
  readonly roots?: readonly string[]
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
  readonly sameRoot: number
  readonly sharedSegments: number
  readonly kindOrder: number
  readonly extensionPreference: number
  readonly depth: number
  readonly length: number
}

export function rankDefinitions(
  entries: readonly SymbolEntry[],
  context: RankContext = {},
): SymbolEntry[] {
  if (entries.length <= 1) return [...entries]

  const sourceSegments = context.sourceFile ? pathSegments(context.sourceFile) : []
  const sourceRoot = context.sourceFile ? rootOf(context.sourceFile, context.roots ?? []) : undefined
  const hasRootContext = sourceRoot !== undefined

  const scored: Scored[] = entries.map((entry, index) => {
    const entrySegments = pathSegments(entry.file)
    const entryRoot = hasRootContext ? rootOf(entry.file, context.roots ?? []) : undefined
    const sameRoot = hasRootContext ? (entryRoot === sourceRoot ? 0 : 1) : 0
    return {
      entry,
      index,
      sameRoot,
      sharedSegments: sourceSegments.length > 0 ? -commonPrefixSegments(entrySegments, sourceSegments) : 0,
      kindOrder: SYMBOL_KIND_ORDER[entry.kind] ?? 99,
      extensionPreference: extensionPreference(entry),
      depth: entrySegments.length,
      length: entry.file.length,
    }
  })

  scored.sort((a, b) => {
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
    return a.index - b.index
  })

  return scored.map((item) => item.entry)
}
