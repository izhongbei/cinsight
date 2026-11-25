/**
 * 读取 / 监听 `sourceInsight.*` 配置。
 *
 * package.json 里已冻结的 14 个配置键（全部在这里读取，配置默认值以 package.json 为准，
 * 这里再兜一层默认值，保证 mock 环境（getConfiguration 只返回空对象）也能工作）。
 */
import * as vscode from 'vscode'

import { DEFAULT_INDEX_BUDGET } from '../core/index-budget'
import { DEFAULT_EXCLUDE } from '../shared/types'
import { normalizeRoot } from './paths'

export const CONFIG_SECTION = 'sourceInsight'

/**
 * package.json contributes.configuration 里的完整配置键（冻结，只读）。
 * 用完整字面量集中在这里，既方便 grep 自查，也避免各处手写字符串。
 */
export const CONFIG_KEYS = {
  indexRoots: 'sourceInsight.indexRoots',
  exclude: 'sourceInsight.exclude',
  maxFileSizeKB: 'sourceInsight.maxFileSizeKB',
  concurrency: 'sourceInsight.concurrency',
  maxSymbols: 'sourceInsight.maxSymbols',
  maxFiles: 'sourceInsight.maxFiles',
  autoCompact: 'sourceInsight.autoCompact',
  searchLimit: 'sourceInsight.searchLimit',
  treeSymbolLimit: 'sourceInsight.treeSymbolLimit',
  autoReindexOnSave: 'sourceInsight.autoReindexOnSave',
  enableCallHierarchy: 'sourceInsight.enableCallHierarchy',
  followSymlinks: 'sourceInsight.followSymlinks',
  highlightDefinitionColor: 'sourceInsight.highlightDefinitionColor',
  highlightReferenceColor: 'sourceInsight.highlightReferenceColor',
} as const

/** 与 package.json contributes.configuration 一一对应。 */
export interface SiConfig {
  readonly indexRoots: readonly string[]
  readonly exclude: readonly string[]
  readonly maxFileSizeKB: number
  readonly concurrency: number
  /** 符号数预算：超过时状态栏警告并提示缩小索引目录 */
  readonly maxSymbols: number
  /** 文件数预算：超过时状态栏警告并提示缩小索引目录 */
  readonly maxFiles: number
  /**
   * 自动 compaction：空闲 / 累计变更较多 / 关闭时把 delta 合并回 base。
   * 关闭后仍逐次追加 delta（不丢数据），auto 合并被推迟；但到达硬安全上限
   * （5000 个 overlay 文件变更或 32 MB delta）时仍会强制合并一次，避免查询变慢。
   * 共享存储的符号 delta 冲突期间自动 compaction（含该上限）停用，需重载恢复。
   * 显式重建索引不受影响。
   */
  readonly autoCompact: boolean
  readonly searchLimit: number
  /** 符号树里每个文件最多显示的符号数（与 searchLimit 独立） */
  readonly treeSymbolLimit: number
  readonly autoReindexOnSave: boolean
  readonly enableCallHierarchy: boolean
  readonly followSymlinks: boolean
  /** F8 定义高亮颜色（CSS 颜色）；空 = 跟随主题 */
  readonly highlightDefinitionColor: string
  /** F8 引用高亮颜色（CSS 颜色）；空 = 跟随主题 */
  readonly highlightReferenceColor: string
}

export interface ConfigChangeSummary {
  /** indexRoots / exclude / maxFileSizeKB / concurrency / followSymlinks 变化：需要重建索引 */
  readonly affectsIndex: boolean
  /** enableCallHierarchy 变化：需要重新注册原生调用层次 Provider */
  readonly affectsCallHierarchy: boolean
  /** highlightDefinitionColor / highlightReferenceColor 变化：只需重建高亮装饰类型 */
  readonly affectsHighlight: boolean
  /** 任何 sourceInsight 配置变化 */
  readonly affectsAnything: boolean
}

const DEFAULT_MAX_FILE_SIZE_KB = 4096
const DEFAULT_CONCURRENCY = 4
const DEFAULT_SEARCH_LIMIT = 200
const DEFAULT_TREE_SYMBOL_LIMIT = 2000

/** 依次尝试多种读取方式，任何异常都退化为默认值。 */
function rawGet<T>(fullKey: string, fallback: T): T {
  const shortKey = fullKey.startsWith(`${CONFIG_SECTION}.`)
    ? fullKey.slice(CONFIG_SECTION.length + 1)
    : fullKey
  try {
    const section = vscode.workspace.getConfiguration(CONFIG_SECTION)
    const direct = section?.get<T>(shortKey)
    if (direct !== undefined && direct !== null) {
      return direct
    }
    const byFullKey = section?.get<T>(fullKey)
    if (byFullKey !== undefined && byFullKey !== null) {
      return byFullKey
    }
  } catch {
    // mock / 无 workspace 场景：继续尝试下一种方式
  }
  try {
    const root = vscode.workspace.getConfiguration()
    const value = root?.get<T>(fullKey)
    if (value !== undefined && value !== null) {
      return value
    }
  } catch {
    // ignore
  }
  return fallback
}

function toStringArray(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) {
    return [...fallback]
  }
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
}

function toNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** 颜色配置：规范化首尾空白，非字符串当空（= 跟随主题）。 */
function toColor(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** 读取全部配置（每次调用都重新读取，保证配置变更实时生效）。 */
export function readConfig(): SiConfig {
  const roots = toStringArray(rawGet(CONFIG_KEYS.indexRoots, []), []).map(normalizeRoot)
  const exclude = toStringArray(rawGet(CONFIG_KEYS.exclude, [...DEFAULT_EXCLUDE]), DEFAULT_EXCLUDE)
  return {
    indexRoots: Array.from(new Set(roots)),
    exclude: exclude.length > 0 ? exclude : [...DEFAULT_EXCLUDE],
    maxFileSizeKB: toNumber(
      rawGet(CONFIG_KEYS.maxFileSizeKB, DEFAULT_MAX_FILE_SIZE_KB),
      DEFAULT_MAX_FILE_SIZE_KB,
      1,
      1_048_576,
    ),
    concurrency: toNumber(rawGet(CONFIG_KEYS.concurrency, DEFAULT_CONCURRENCY), DEFAULT_CONCURRENCY, 1, 64),
    maxSymbols: toNumber(
      rawGet(CONFIG_KEYS.maxSymbols, DEFAULT_INDEX_BUDGET.maxSymbols),
      DEFAULT_INDEX_BUDGET.maxSymbols,
      1,
      1_000_000_000,
    ),
    maxFiles: toNumber(
      rawGet(CONFIG_KEYS.maxFiles, DEFAULT_INDEX_BUDGET.maxFiles),
      DEFAULT_INDEX_BUDGET.maxFiles,
      1,
      10_000_000,
    ),
    autoCompact: toBoolean(rawGet(CONFIG_KEYS.autoCompact, true), true),
    searchLimit: toNumber(rawGet(CONFIG_KEYS.searchLimit, DEFAULT_SEARCH_LIMIT), DEFAULT_SEARCH_LIMIT, 1, 10_000),
    treeSymbolLimit: toNumber(
      rawGet(CONFIG_KEYS.treeSymbolLimit, DEFAULT_TREE_SYMBOL_LIMIT),
      DEFAULT_TREE_SYMBOL_LIMIT,
      1,
      100_000,
    ),
    autoReindexOnSave: toBoolean(rawGet(CONFIG_KEYS.autoReindexOnSave, true), true),
    enableCallHierarchy: toBoolean(rawGet(CONFIG_KEYS.enableCallHierarchy, true), true),
    followSymlinks: toBoolean(rawGet(CONFIG_KEYS.followSymlinks, false), false),
    highlightDefinitionColor: toColor(rawGet(CONFIG_KEYS.highlightDefinitionColor, '')),
    highlightReferenceColor: toColor(rawGet(CONFIG_KEYS.highlightReferenceColor, '')),
  }
}

function affects(e: vscode.ConfigurationChangeEvent | undefined, key: string): boolean {
  try {
    if (typeof e?.affectsConfiguration === 'function') {
      return e.affectsConfiguration(`${CONFIG_SECTION}.${key}`)
    }
  } catch {
    // ignore
  }
  // 事件对象缺少 affectsConfiguration（mock）：保守地认为任何配置变化都影响自己
  return true
}

/** 监听全部 sourceInsight 配置项；summary 告诉调用方需要做什么。 */
export function onDidChangeConfig(
  listener: (change: ConfigChangeSummary) => void,
): vscode.Disposable {
  const noop: vscode.Disposable = { dispose: () => undefined }
  try {
    if (typeof vscode.workspace.onDidChangeConfiguration !== 'function') {
      return noop
    }
    return vscode.workspace.onDidChangeConfiguration((e) => {
      const rootKeys = ['indexRoots', 'exclude', 'maxFileSizeKB', 'concurrency', 'followSymlinks'] as const
      const anyAffected = (): boolean => {
        const allKeys: readonly string[] = [
          ...rootKeys,
          'searchLimit',
          'treeSymbolLimit',
          'autoReindexOnSave',
          'enableCallHierarchy',
          'maxSymbols',
          'maxFiles',
          'autoCompact',
          'highlightDefinitionColor',
          'highlightReferenceColor',
        ]
        return allKeys.some((key) => affects(e, key))
      }
      if (!anyAffected()) {
        return
      }
      try {
        listener({
          affectsIndex: rootKeys.some((key) => affects(e, key)),
          affectsCallHierarchy: affects(e, 'enableCallHierarchy'),
          // 高亮颜色不影响索引内容，只需重建装饰类型。
          affectsHighlight:
            affects(e, 'highlightDefinitionColor') || affects(e, 'highlightReferenceColor'),
          affectsAnything: true,
        })
      } catch (error) {
        console.error('[code-insight] config change listener failed', error)
      }
    })
  } catch (error) {
    console.error('[code-insight] cannot listen to configuration changes', error)
    return noop
  }
}

/**
 * `si.configureRoots` 自己会询问「是否重建」，此时配置变更事件不应再弹一次同样的提示。
 * 用一个短时间窗抑制重复提示。
 */
let suppressPromptUntil = 0

export function suppressRebuildPrompt(durationMs = 3000): void {
  suppressPromptUntil = Date.now() + durationMs
}

export function isRebuildPromptSuppressed(): boolean {
  return Date.now() < suppressPromptUntil
}
