/**
 * 把索引里的 SymbolEntry 换算成 VS Code 的 DocumentSymbol 范围。
 *
 * 索引可能比当前文档"旧"（文件在索引后被编辑/截断，或用户打开了另一个同名文件），
 * 这时 entry.line 可能超出文档行数、endLine 可能小于 line、列号可能超出行长。
 * 直接用这些值构造 Range/DocumentSymbol 会抛 "Invalid arguments"（Cursor 日志里
 * document-symbol.js:69 的 29 次异常就是这个原因）。这里统一做 clamp 并保证
 * fullRange 一定包含 selectionRange，越界条目直接跳过。
 */
export interface SymbolRanges {
  readonly startLine: number
  readonly endLine: number
  readonly endCharacter: number
  readonly selectionStart: number
  readonly selectionEnd: number
}

/** 完整范围三元组（父范围扩展只看这三个字段）。 */
export interface SymbolSpan {
  readonly startLine: number
  readonly endLine: number
  readonly endCharacter: number
}

export interface SymbolRangeInput {
  readonly name: string
  readonly line: number
  readonly endLine: number
  readonly column: number
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low
  return Math.min(Math.max(value, low), high)
}

export function clampSymbolRanges(
  entry: SymbolRangeInput,
  lineCount: number,
  lineLength: (line: number) => number,
): SymbolRanges | undefined {
  if (!Number.isFinite(lineCount) || lineCount <= 0) return undefined
  if (!Number.isFinite(entry.line) || entry.line < 0 || entry.line >= lineCount) return undefined

  const startLine = Math.floor(entry.line)
  const endLine = clamp(Math.floor(entry.endLine), startLine, lineCount - 1)
  const startLineLength = Math.max(0, lineLength(startLine))
  const selectionStart = clamp(Math.floor(entry.column), 0, startLineLength)
  const selectionEnd = clamp(selectionStart + entry.name.length, selectionStart, startLineLength)
  const endCharacter =
    endLine === startLine
      ? Math.max(selectionEnd, startLineLength)
      : Math.max(0, lineLength(endLine))

  return { startLine, endLine, endCharacter, selectionStart, selectionEnd }
}

/**
 * 让父节点的完整范围覆盖所有子节点（selectionRange 由调用方保留原值）。
 *
 * 典型场景：`typedef struct { int x; int y; } point_t;` 的 typedef 条目在别名行
 * （`}` 之后），成员行却在它上方；父范围只取别名行时，大纲/breadcrumbs/sticky
 * scroll 看不到父节点。这里把 startLine/endLine 扩展到子节点区间，别名行的
 * selectionRange 不变。没有扩展时原样返回，避免无意义的对象分配。
 */
export function extendRangesOverChildren<T extends SymbolSpan>(
  parent: T,
  children: readonly SymbolSpan[],
): T {
  if (children.length === 0) return parent
  let startLine = parent.startLine
  let endLine = parent.endLine
  let endCharacter = parent.endCharacter
  for (const child of children) {
    if (child.startLine < startLine) startLine = child.startLine
    if (child.endLine > endLine) {
      endLine = child.endLine
      endCharacter = child.endCharacter
    } else if (child.endLine === endLine && child.endCharacter > endCharacter) {
      endCharacter = child.endCharacter
    }
  }
  if (
    startLine === parent.startLine &&
    endLine === parent.endLine &&
    endCharacter === parent.endCharacter
  ) {
    return parent
  }
  return { ...parent, startLine, endLine, endCharacter }
}
