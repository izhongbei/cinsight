/**
 * 状态栏：`$(symbol-function) SI: 123,456 functions` / `$(sync~spin) SI: Indexing 45%` / 未配置。
 *
 * 点击行为：未配置 -> si.configureRoots；其余 -> si.rebuildIndex。
 * 大仓库保护：符号数 > MAX_SYMBOLS_WARNING 时用警告色并提示缩小 indexRoots。
 */
import * as vscode from 'vscode'

import { MAX_SYMBOLS_WARNING } from '../shared/types'
import { onDidChangeConfig, readConfig } from './config'
import type { SymbolService } from './service'

const PRIORITY = 100

export class StatusBarController implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem | undefined
  private readonly disposables: vscode.Disposable[] = []
  private disposed = false

  constructor(private readonly service: SymbolService) {
    let item: vscode.StatusBarItem | undefined
    try {
      if (typeof vscode.window.createStatusBarItem === 'function') {
        const alignment =
          (vscode.StatusBarAlignment as unknown as Record<string, number> | undefined)?.Right ?? 2
        item = vscode.window.createStatusBarItem(
          alignment as unknown as vscode.StatusBarAlignment,
          PRIORITY,
        )
      }
    } catch (error) {
      console.error('[source-insight-c] cannot create status bar item', error)
      item = undefined
    }
    this.item = item
    if (this.item) {
      try {
        this.disposables.push(this.service.onDidChange(() => this.update()))
        this.disposables.push(this.service.onProgress(() => this.update()))
        this.disposables.push(onDidChangeConfig(() => this.update()))
      } catch (error) {
        console.error('[source-insight-c] status bar listeners failed', error)
      }
    }
    this.update()
    try {
      this.item?.show()
    } catch (error) {
      console.error('[source-insight-c] cannot show status bar item', error)
    }
  }

  update(): void {
    if (this.disposed || !this.item) {
      return
    }
    try {
      const service = this.service
      const config = readConfig()
      if (!service.hasRoots || config.indexRoots.length === 0) {
        this.item.text = vscode.l10n.t('$(info) SI: Index not configured')
        this.item.tooltip = markdown(
          vscode.l10n.t('Pick the C/C++ directories to index to enable navigation.'),
        )
        this.item.command = 'si.configureRoots'
        this.item.backgroundColor = undefined
        return
      }
      if (service.building) {
        const progress = service.progress
        if (progress && progress.total > 0) {
          const percent = Math.min(
            100,
            Math.max(0, Math.floor((progress.done / progress.total) * 100)),
          )
          this.item.text = vscode.l10n.t('$(sync~spin) SI: Indexing {0}%', String(percent))
        } else {
          this.item.text = vscode.l10n.t('$(sync~spin) SI: Indexing…')
        }
        this.item.tooltip = markdown(vscode.l10n.t('Building the Source Insight index…'))
        this.item.command = 'si.rebuildIndex'
        this.item.backgroundColor = undefined
        return
      }
      if (service.ready) {
        const symbols = service.entryCount
        const files = service.fileCount
        const tooManySymbols = symbols > MAX_SYMBOLS_WARNING
        const formatted = formatNumber(symbols)
        this.item.text = tooManySymbols
          ? vscode.l10n.t('$(warning) SI: {0} functions', formatted)
          : vscode.l10n.t('$(symbol-function) SI: {0} functions', formatted)
        const lines: string[] = [
          vscode.l10n.t('Files: {0}', formatNumber(files)),
          vscode.l10n.t('Symbols: {0}', formatted),
        ]
        if (service.builtAt) {
          lines.push(
            vscode.l10n.t('Built: {0}', new Date(service.builtAt).toLocaleString()),
          )
        }
        if (service.snapshotPath) {
          lines.push(vscode.l10n.t('Snapshot: {0}', service.snapshotPath))
        }
        if (tooManySymbols) {
          lines.push(
            vscode.l10n.t(
              'More than {0} symbols are indexed. Consider narrowing sourceInsight.indexRoots.',
              formatNumber(MAX_SYMBOLS_WARNING),
            ),
          )
        }
        lines.push(vscode.l10n.t('Click to rebuild the index.'))
        this.item.tooltip = markdown(lines.join('\n\n'))
        this.item.command = 'si.rebuildIndex'
        this.item.backgroundColor = undefined
        if (tooManySymbols) {
          try {
            const themeColor = vscode.ThemeColor as unknown as
              | (new (id: string) => vscode.ThemeColor)
              | undefined
            if (typeof themeColor === 'function') {
              this.item.backgroundColor = new themeColor('statusBarItem.warningBackground')
            }
          } catch {
            // 主题色不可用时忽略
          }
        }
        return
      }
      if (service.lastError) {
        this.item.text = vscode.l10n.t('$(error) SI: Index failed')
        this.item.tooltip = markdown(service.lastError)
        this.item.command = 'si.rebuildIndex'
        return
      }
      this.item.text = vscode.l10n.t('$(sync) SI: Index not built')
      this.item.tooltip = markdown(vscode.l10n.t('Click to build the Source Insight index.'))
      this.item.command = 'si.rebuildIndex'
    } catch (error) {
      console.error('[source-insight-c] status bar update failed', error)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const disposable of this.disposables) {
      try {
        disposable.dispose()
      } catch {
        // ignore
      }
    }
    this.disposables.length = 0
    try {
      this.item?.dispose()
    } catch {
      // ignore
    }
  }
}

export function createStatusBar(service: SymbolService): StatusBarController {
  return new StatusBarController(service)
}

function formatNumber(value: number): string {
  try {
    return value.toLocaleString('en-US')
  } catch {
    return String(value)
  }
}

function markdown(text: string): string | vscode.MarkdownString {
  try {
    if (typeof vscode.MarkdownString === 'function') {
      return new vscode.MarkdownString(text)
    }
  } catch {
    // ignore
  }
  return text
}
