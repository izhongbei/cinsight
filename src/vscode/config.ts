/**
 * 读取 / 监听 `sourceInsight.*` 配置。
 *
 * package.json 里已冻结的 8 个配置键（全部在这里读取，配置默认值以 package.json 为准，
 * 这里再兜一层默认值，保证 mock 环境（getConfiguration 只返回空对象）也能工作）。
 */
import * as vscode from 'vscode'

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
  searchLimit: 'sourceInsight.searchLimit',
  autoReindexOnSave: 'sourceInsight.autoReindexOnSave',
  enableCallHierarchy: 'sourceInsight.enableCallHierarchy',
  followSymlinks: 'sourceInsight.followSymlinks',
} as const

/** 与 package.json contributes.configuration 一一对应。 */
export interface SiConfig {
  readonly indexRoots: readonly string[]
  readonly exclude: readonly string[]
  readonly maxFileSizeKB: number
  readonly concurrency: number
  readonly searchLimit: number
  readonly autoReindexOnSave: boolean
  readonly enableCallHierarchy: boolean
  readonly followSymlinks: boolean
}

export interface ConfigChangeSummary {
  /** indexRoots / exclude / maxFileSizeKB / concurrency / followSymlinks 变化：需要重建索引 */
  readonly affectsIndex: boolean
  /** enableCallHierarchy 变化：需要重新注册原生调用层次 Provider */
  readonly affectsCallHierarchy: boolean
  /** 任何 sourceInsight 配置变化 */
  readonly affectsAnything: boolean
}

const DEFAULT_MAX_FILE_SIZE_KB = 4096
const DEFAULT_CONCURRENCY = 4
const DEFAULT_SEARCH_LIMIT = 200

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
    searchLimit: toNumber(rawGet(CONFIG_KEYS.searchLimit, DEFAULT_SEARCH_LIMIT), DEFAULT_SEARCH_LIMIT, 1, 10_000),
    autoReindexOnSave: toBoolean(rawGet(CONFIG_KEYS.autoReindexOnSave, true), true),
    enableCallHierarchy: toBoolean(rawGet(CONFIG_KEYS.enableCallHierarchy, true), true),
    followSymlinks: toBoolean(rawGet(CONFIG_KEYS.followSymlinks, false), false),
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
          'autoReindexOnSave',
          'enableCallHierarchy',
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
          affectsAnything: true,
        })
      } catch (error) {
        console.error('[source-insight-c] config change listener failed', error)
      }
    })
  } catch (error) {
    console.error('[source-insight-c] cannot listen to configuration changes', error)
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
