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
  readonly pendingChanges: number
  readonly kindCounts: Readonly<Record<SymbolKind, number>>
  readonly lastBuild: BuildSummary | undefined
  readonly lastError: string | undefined
  readonly heapUsedBytes: number
  readonly rssBytes: number
  readonly budget: BudgetReport
}

const MB = 1024 * 1024

function number(value: number): string {
  return value.toLocaleString('en-US')
}

function bytes(value: number): string {
  if (value >= MB) return `${(value / MB).toFixed(2)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${value} B`
}

function n(value: string | undefined): string {
  return value ?? 'n/a'
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
  lines.push(`- builtAt: ${input.builtAt ? new Date(input.builtAt).toISOString() : 'n/a'}`)
  lines.push(`- pending changes (overlay): ${number(input.pendingChanges)}`)
  lines.push(`- kinds: ${Object.entries(input.kindCounts).map(([kind, count]) => `${kind}=${number(count)}`).join(', ')}`)
  lines.push('')
  lines.push('## Storage')
  lines.push('')
  lines.push(`- snapshot: ${n(input.snapshotPath)} (${bytes(input.snapshotBytes)})`)
  lines.push(`- snapshot delta: ${bytes(input.deltaBytes)}`)
  lines.push(`- reference index: ${n(input.nameIndexPath)} (${bytes(input.nameIndexBytes)}, ${input.nameIndexLoaded ? 'loaded' : 'lazy'})`)
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
    lines.push('')
    lines.push('## Last error')
    lines.push('')
    lines.push('```')
    lines.push(input.lastError)
    lines.push('```')
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
