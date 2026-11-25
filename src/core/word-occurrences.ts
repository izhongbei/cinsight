/**
 * 单文件内的「整词」出现位置（F8 符号高亮用，纯 Node，不依赖 vscode）。
 *
 * 复用 `stripSources` 把注释、字符串与字符字面量涂成空格（长度与行数不变），
 * 然后在剥离结果上做整词检索；命中位置再回原始文本校验一次，保证位置列号
 * 属于原始文本（剥离与原文本逐字符同长，列号一一对应）。
 *
 * 词字符集合固定为 `[A-Za-z0-9_]`（与 C 标识符一致）：`foo` 不会命中
 * `foobar`、`_foo`、`foo1`，大小写敏感。
 */
import { stripSources } from './scan'

export interface WordOccurrence {
  /** 0-based 行号 */
  readonly line: number
  /** 0-based 列号（UTF-16 code unit，与 VS Code 的 Position.character 一致） */
  readonly column: number
}

function isWordCharCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || // 0-9
    (code >= 65 && code <= 90) || // A-Z
    (code >= 97 && code <= 122) || // a-z
    code === 95 // _
  )
}

/**
 * 找出 `word` 在 `text` 中作为完整标识符出现的全部位置（按出现顺序）。
 *
 * 注释 / 字符串 / 字符字面量内部的伪出现会被忽略；`#define` 等预处理行属于代码，
 * 其中的名字照常命中。`word` 为空时返回空数组。
 */
export function findWordOccurrences(text: string, word: string): WordOccurrence[] {
  return findWordOccurrencesInStripped(text, stripSources(text), word)
}

/**
 * 已剥离文本版本：调用方（例如高亮控制器）可复用同一份 `stripSources` 结果。
 *
 * `stripped` 必须由 `stripSources(text)` 得到（同长、同换行）；否则边界/位置不可靠。
 */
export function findWordOccurrencesInStripped(
  text: string,
  stripped: string,
  word: string,
): WordOccurrence[] {
  if (!word) {
    return []
  }
  const occurrences: WordOccurrence[] = []
  const length = stripped.length
  let searchFrom = 0
  let line = 0
  let lineStart = 0
  let scanned = 0
  // indexOf 是原生实现，比逐字符状态机快得多；整词/涂白校验只在候选命中处做。
  for (;;) {
    const index = stripped.indexOf(word, searchFrom)
    if (index < 0) {
      break
    }
    searchFrom = index + 1
    if (index + word.length > length) {
      break
    }
    if (index > 0 && isWordCharCode(stripped.charCodeAt(index - 1))) {
      continue
    }
    if (index + word.length < length && isWordCharCode(stripped.charCodeAt(index + word.length))) {
      continue
    }
    // 命中区间必须逐字符与原文一致：注释/字符串被涂白后此校验必然失败。
    if (!text.startsWith(word, index)) {
      continue
    }
    // 只有被接受的候选才推进行号统计，跳过的候选不影响结果。
    while (scanned < index) {
      if (stripped.charCodeAt(scanned) === 10) {
        line++
        lineStart = scanned + 1
      }
      scanned++
    }
    occurrences.push({ line, column: index - lineStart })
  }
  return occurrences
}
