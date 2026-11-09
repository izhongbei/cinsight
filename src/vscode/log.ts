/**
 * 「Source Insight」输出通道日志。
 *
 * 约定（spec §8）：
 * - 文件读/解析失败等错误写入输出面板，错误类消息最多记录 50 条，避免大仓库刷屏；
 * - 无论输出通道是否可用，都同步打 `console.error`，便于问题定位与冒烟测试观察；
 * - 输出通道创建失败（mock 环境）时静默退化为 console。
 */
import * as vscode from 'vscode'

const MAX_CHANNEL_ERRORS = 50

export interface Logger {
  info(message: string): void
  warn(message: string, error?: unknown): void
  error(message: string, error?: unknown): void
  show(): void
  dispose(): void
}

export function createLogger(): Logger {
  let channel: vscode.OutputChannel | undefined
  try {
    if (typeof vscode.window.createOutputChannel === 'function') {
      channel = vscode.window.createOutputChannel(vscode.l10n.t('Source Insight'))
    }
  } catch (error) {
    console.error('[source-insight-c] cannot create output channel', error)
  }

  let errorCount = 0

  const write = (level: 'info' | 'warn' | 'error', message: string): void => {
    const line = `[${new Date().toISOString()}] [${level}] ${message}`
    if (level === 'error') {
      console.error('[source-insight-c]', message)
    } else if (level === 'warn') {
      console.warn('[source-insight-c]', message)
    }
    if (!channel) {
      return
    }
    if (level === 'error') {
      if (errorCount >= MAX_CHANNEL_ERRORS) {
        return
      }
      errorCount += 1
    }
    try {
      channel.appendLine(line)
    } catch {
      // 输出通道不可用时忽略
    }
  }

  const format = (message: string, error?: unknown): string => {
    if (error === undefined) {
      return message
    }
    if (error instanceof Error) {
      return `${message}: ${error.name}: ${error.message}`
    }
    try {
      return `${message}: ${String(error)}`
    } catch {
      return message
    }
  }

  return {
    info: (message: string): void => write('info', message),
    warn: (message: string, error?: unknown): void => write('warn', format(message, error)),
    error: (message: string, error?: unknown): void => write('error', format(message, error)),
    show: (): void => {
      try {
        channel?.show()
      } catch {
        // ignore
      }
    },
    dispose: (): void => {
      try {
        channel?.dispose()
      } catch {
        // ignore
      }
      channel = undefined
    },
  }
}
