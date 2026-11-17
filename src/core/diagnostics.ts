/** 索引诊断 Markdown 报告：纯函数（无 vscode / fs 依赖），便于单测。 */
import type { BuildSummary, SymbolKind } from '../shared/types'
import type { BudgetReport } from './index-budget'

export interface DiagnosticsInput {
  readonly extensionVersion: string
  readonly workspaceRoot: string | undefined
  readonly roots: readonly string[]
  readonly snapshotPath: string | undefined
  readonly snapshotBytes: number
  readonly deltaBytes: number
  readonly nameIndexPath: string | undefined
  readonly nameIndexBytes: number
  readonly nameIndexLoaded: boolean
  readonly entryCount: number
  readonly fileCount: number
  readonly builtAt: number | undefined
  /** 配置里的 roots 与快照中记录的不一致（计数可能已过期）。 */
  readonly rootsChanged?: boolean
  readonly pendingChanges: number
  readonly kindCounts: Readonly<Record<SymbolKind, number>>
  readonly lastBuild: BuildSummary | undefined
  readonly lastError: string | undefined
  /** 加载 delta 时的恢复警告（读失败或丢弃损坏尾部）；正常时为 undefined。 */
  readonly deltaWarning?: string
  readonly heapUsedBytes: number
  readonly rssBytes: number
  readonly budget: BudgetReport
}

const MB = 1024 * 1024
/**
 * KB 上限的阈值：1023.5 KB。
 * 否则 1048575 B 会被 toFixed(1) 显示成 `1024.0 KB`（尺寸进位不跨单位）。
 */
const KB_ROUND_UP_BYTES = 1024 * 1023.5

function number(value: number): string {
  return value.toLocaleString('en-US')
}

function bytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return 'n/a'
  if (value >= KB_ROUND_UP_BYTES) return `${(value / MB).toFixed(2)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${value} B`
}

function n(value: string | undefined): string {
  return value ?? 'n/a'
}

/** 时间戳渲染：NaN / Infinity / 超出 Date 范围时返回 n/a，绝不抛 RangeError。 */
function isoTime(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'n/a'
  try {
    return date.toISOString()
  } catch {
    return 'n/a'
  }
}

/** 取 text 中字符 char 的最长连续长度（用于生成长于内容的围栏）。 */
function longestRun(text: string, char: string): number {
  let longest = 0
  let current = 0
  for (const ch of text) {
    if (ch === char) {
      current += 1
      if (current > longest) longest = current
    } else {
      current = 0
    }
  }
  return longest
}

/**
 * 选择一个比内容里最长 `~` 串还长的 `~` 围栏。
 * 用 `~` 而不是 ``` 是为了让错误文本里的 ``` 不会截断文档；文本里若含 ~ 串则继续加长。
 */
function errorFence(text: string): string {
  return '~'.repeat(Math.max(3, longestRun(text, '~') + 1))
}

/** 存储文件行：路径缺失渲染 `n/a`；文件缺失（0 字节）时尺寸渲染 `n/a`，不显示 `0 B`。 */
function storageLine(
  label: string,
  filePath: string | undefined,
  sizeBytes: number,
  suffix = '',
): string {
  if (!filePath) return `- ${label}: n/a`
  const size = sizeBytes > 0 ? bytes(sizeBytes) : 'n/a'
  return `- ${label}: ${filePath} (${size}${suffix})`
}

export function renderDiagnosticsMarkdown(input: DiagnosticsInput): string {
  const lines: string[] = []
  lines.push('# Code Insight index diagnostics')
  lines.push('')
  lines.push(`- extension: ${input.extensionVersion}`)
  lines.push(`- workspace: ${n(input.workspaceRoot)}`)
  lines.push(`- roots: ${input.roots.length ? input.roots.join(', ') : 'n/a'}`)
  lines.push(`- budget: ${input.budget.level}${input.budget.message ? ` — ${input.budget.message}` : ''}`)
  lines.push('')
  lines.push('## Index')
  lines.push('')
  lines.push(`- symbols: ${number(input.entryCount)}`)
  lines.push(`- files: ${number(input.fileCount)}`)
  lines.push(`- builtAt: ${isoTime(input.builtAt)}`)
  if (input.rootsChanged) {
    lines.push('- note: roots changed since the last build — counts may be stale')
  }
  lines.push(`- pending changes (overlay): ${number(input.pendingChanges)}`)
  lines.push(`- kinds: ${Object.entries(input.kindCounts).map(([kind, count]) => `${kind}=${number(count)}`).join(', ')}`)
  lines.push('')
  lines.push('## Storage')
  lines.push('')
  lines.push(storageLine('snapshot', input.snapshotPath, input.snapshotBytes))
  lines.push(`- snapshot delta: ${bytes(input.deltaBytes)}`)
  if (input.deltaWarning) {
    // 单行渲染：fs 错误文本可能带换行，压平避免破坏 Markdown 列表结构。
    lines.push(`- warning (delta recovery): ${input.deltaWarning.replace(/\s+/g, ' ').trim()}`)
  }
  lines.push(
    storageLine(
      'reference index',
      input.nameIndexPath,
      input.nameIndexBytes,
      `, ${input.nameIndexLoaded ? 'loaded' : 'lazy'}`,
    ),
  )
  lines.push('')
  lines.push('## Last build')
  lines.push('')
  if (input.lastBuild) {
    const b = input.lastBuild
    lines.push(`- duration: ${number(b.durationMs)} ms`)
    lines.push(`- files/entries: ${number(b.files)} / ${number(b.entries)}`)
    lines.push(`- added/updated/removed/unchanged/skipped: ${b.added}/${b.updated}/${b.removed}/${b.unchanged}/${b.skipped}`)
  } else {
    lines.push('- n/a')
  }
  lines.push('')
  lines.push('## Process')
  lines.push('')
  lines.push(`- heap used: ${bytes(input.heapUsedBytes)}`)
  lines.push(`- RSS: ${bytes(input.rssBytes)}`)
  if (input.lastError) {
    const fence = errorFence(input.lastError)
    lines.push('')
    lines.push('## Last error')
    lines.push('')
    lines.push(fence)
    lines.push(input.lastError)
    lines.push(fence)
  }
  if (input.budget.suggestions.length > 0) {
    lines.push('')
    lines.push('## Suggestions')
    lines.push('')
    for (const suggestion of input.budget.suggestions) lines.push(`- ${suggestion}`)
  }
  lines.push('')
  return lines.join('\n')
}
