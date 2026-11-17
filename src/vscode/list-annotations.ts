/**
 * QuickPick 列表项的分组注记（设计 §3.6）：`included` / `not included`，条件条目再追加
 * `conditional: <条件文本>`。纯逻辑、无 vscode 依赖：调用方传入 l10n 后的文本模板，
 * 因此 core 的英文 formatter 与 vscode 层本地化展示互不影响。
 */
import type { SymbolTable } from '../shared/types'

/** 注记用到的本地化文本；`conditional` 是含 `{0}` 占位符的模板。 */
export interface ListAnnotationText {
  readonly included: string
  readonly notIncluded: string
  readonly conditional: string
}

/**
 * 文件是否对 sourceFile 可见（同一文件或可达 include）。
 * 缺少 sourceFile / table 时返回 undefined，调用方据此省略 inclusion 注记。
 */
export function includedFor(
  table: SymbolTable | undefined,
  sourceFile: string | undefined,
  file: string,
): boolean | undefined {
  if (sourceFile === undefined || table === undefined) {
    return undefined
  }
  if (file === sourceFile) {
    return true
  }
  try {
    return table.isReachable(sourceFile, file)
  } catch {
    return false
  }
}

/**
 * 组装列表注记（按固定顺序：inclusion -> conditional）。
 * `included === undefined` 时不输出 inclusion；空条件文本视为无条件。
 */
export function listAnnotationParts(
  included: boolean | undefined,
  condition: string | undefined,
  text: ListAnnotationText,
): string[] {
  const parts: string[] = []
  if (included !== undefined) {
    parts.push(included ? text.included : text.notIncluded)
  }
  const trimmed = condition?.trim()
  if (trimmed) {
    parts.push(text.conditional.replace('{0}', trimmed))
  }
  return parts
}
