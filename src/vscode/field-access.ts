/**
 * 字段访问上下文识别（B3 §3.6）：F12 时判断光标词是否紧跟 `.` / `->`。
 *
 * 纯词法判断，不做类型推断：返回 'member' 只表示「这里语法上是成员访问」，
 * 具体候选仍由 DefinitionProvider 从符号表里按 kind='member' 过滤，找不到再回退普通定义。
 *
 * 刻意保持简单（不解析字符串/注释/宏）：
 *  - 去尾部空白后以 `->` 或 `.` 结尾即命中；
 *  - `.` 前面的字符是数字时不算（`1.`、`2.5` 这类数字字面量）；
 *  - 连续的 `..` / `...` 不算（可变参数省略号）。
 */

const MEMBER_OPERATOR = '->'

export function detectMemberAccess(linePrefix: string): 'member' | undefined {
  const trimmed = (typeof linePrefix === 'string' ? linePrefix : '').replace(/\s+$/, '')
  if (trimmed.endsWith(MEMBER_OPERATOR)) {
    return 'member'
  }
  if (!trimmed.endsWith('.')) {
    return undefined
  }
  // `...` / `..` 是省略号，不是成员访问
  if (trimmed.endsWith('..')) {
    return undefined
  }
  const beforeDot = trimmed.charAt(trimmed.length - 2)
  // `1.` 这类数字字面量不是成员访问
  if (beforeDot >= '0' && beforeDot <= '9') {
    return undefined
  }
  return 'member'
}
