/**
 * 符号搜索的过滤词解析（B3 §3.5）：`si.searchSymbol` 输入里的 `@kind` token。
 *
 * 约定：
 *  - `@func` / `@type` / `@macro` / `@member` / `@enum` / `@var` 是过滤词，大小写不敏感；
 *  - `@type` 覆盖 struct/union/enum/typedef，`@enum` 指枚举常量（枚举类型走 `@type`）；
 *  - 多个过滤词取并集（同一 kind 只出现一次，顺序按 token 出现顺序）；
 *  - 未识别的 `@token` 不是过滤词，原样留在查询文本里（名字里确实可能有 `@`）；
 *  - 查询文本按空白切分后重新用单个空格连接，首尾空白被去掉。
 *
 * 纯函数、无 vscode 依赖：命令层解析后把 kinds 交给 core 的 `searchSymbols`。
 */
import type { SymbolKind } from '../shared/types'

export interface ParsedSearchQuery {
  /** 去掉过滤词后的查询文本 */
  readonly query: string
  /** 过滤词对应的 kind 并集；未指定过滤词时为 undefined */
  readonly kinds?: readonly SymbolKind[]
}

/** 过滤词 -> kind 列表（`@type` 展开成四类类型符号）。 */
const TOKEN_KINDS: Readonly<Record<string, readonly SymbolKind[]>> = {
  '@func': ['function'],
  '@type': ['struct', 'union', 'enum', 'typedef'],
  '@macro': ['macro'],
  '@member': ['member'],
  '@enum': ['enumConstant'],
  '@var': ['variable'],
}

export function parseSearchQuery(input: string): ParsedSearchQuery {
  const words = (typeof input === 'string' ? input : '')
    .split(/\s+/)
    .filter((word) => word.length > 0)
  const kinds: SymbolKind[] = []
  const text: string[] = []
  for (const word of words) {
    const mapped = TOKEN_KINDS[word.toLowerCase()]
    if (!mapped) {
      text.push(word)
      continue
    }
    for (const kind of mapped) {
      if (!kinds.includes(kind)) {
        kinds.push(kind)
      }
    }
  }
  const query = text.join(' ')
  return kinds.length > 0 ? { query, kinds } : { query }
}
