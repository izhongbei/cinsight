/** 索引规模预算：超过阈值要显式提示，避免静默吃内存。 */

export interface IndexBudget {
  readonly maxSymbols: number
  readonly maxFiles: number
  readonly hardMaxSymbols: number
}

export const DEFAULT_INDEX_BUDGET: IndexBudget = {
  maxSymbols: 3_000_000,
  maxFiles: 120_000,
  hardMaxSymbols: 6_000_000,
}

export type BudgetLevel = 'ok' | 'warn' | 'exceeded'

export interface BudgetReport {
  readonly level: BudgetLevel
  readonly symbols: number
  readonly files: number
  readonly message?: string
  readonly suggestions: readonly string[]
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US')
}

export function evaluateBudget(input: {
  readonly symbols: number
  readonly files: number
  readonly budget: IndexBudget
}): BudgetReport {
  const { symbols, files, budget } = input
  const base = { symbols, files }
  const suggestions: string[] = [
    'Narrow sourceInsight.indexRoots to the modules you actually work on.',
    'Exclude duplicated kernel/vendor copies via sourceInsight.exclude (e.g. **/linux-*/**).',
  ]
  if (symbols > budget.hardMaxSymbols) {
    return {
      ...base,
      level: 'exceeded',
      message: `Index has ${formatNumber(symbols)} symbols (hard maximum ${formatNumber(budget.hardMaxSymbols)}).`,
      suggestions,
    }
  }
  if (symbols > budget.maxSymbols || files > budget.maxFiles) {
    const reason =
      symbols > budget.maxSymbols
        ? `${formatNumber(symbols)} symbols (budget ${formatNumber(budget.maxSymbols)})`
        : `${formatNumber(files)} files (budget ${formatNumber(budget.maxFiles)})`
    return { ...base, level: 'warn', message: `Index is large: ${reason}.`, suggestions }
  }
  return { ...base, level: 'ok', suggestions: [] }
}
