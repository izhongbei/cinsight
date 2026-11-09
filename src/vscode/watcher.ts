/**
 * C/C++ 源文件监听：
 * - 只监听可索引扩展名（`**\/*.{c,h,cc,cpp,hpp,hh,inl}`）；
 * - create/change 防抖 800 ms 后调用 service.updateFile，delete 调用 service.removeFile；
 * - 索引构建期间事件排队，构建结束后统一处理；
 * - `sourceInsight.autoReindexOnSave=false` 时不处理任何事件（用户可用「重建索引」手动刷新）。
 */
import * as vscode from 'vscode'

import { readConfig } from './config'
import type { Logger } from './log'
import type { SymbolService } from './service'
import { noopDisposable } from './util'

export const WATCH_GLOB = '**/*.{c,h,cc,cpp,hpp,hh,inl}'
export const WATCH_DEBOUNCE_MS = 800

type PendingAction = 'update' | 'remove'

export function createFileWatcher(
  service: SymbolService,
  logger: Logger,
): vscode.Disposable {
  try {
    if (typeof vscode.workspace.createFileSystemWatcher !== 'function') {
      logger.warn('createFileSystemWatcher unavailable; automatic reindex on save is disabled')
      return noopDisposable()
    }
    const watcher = vscode.workspace.createFileSystemWatcher(WATCH_GLOB)
    if (!watcher) {
      return noopDisposable()
    }

    const pending = new Map<string, PendingAction>()
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false

    const schedule = (): void => {
      if (disposed) {
        return
      }
      if (timer) {
        clearTimeout(timer)
      }
      timer = setTimeout(flush, WATCH_DEBOUNCE_MS)
      try {
        timer.unref?.()
      } catch {
        // ignore
      }
    }

    const enqueue = (uri: vscode.Uri | undefined, action: PendingAction): void => {
      try {
        if (disposed) {
          return
        }
        if (!readConfig().autoReindexOnSave) {
          return
        }
        const fsPath = uri?.fsPath
        if (typeof fsPath !== 'string' || !fsPath) {
          return
        }
        if (action === 'update' && !service.shouldTrack(fsPath)) {
          return
        }
        pending.set(fsPath, action)
        schedule()
      } catch (error) {
        logger.error('file watcher enqueue failed', error)
      }
    }

    const flush = (): void => {
      timer = undefined
      if (disposed) {
        return
      }
      if (service.building) {
        // 构建期间不落盘：保持排队，构建结束后再统一处理
        schedule()
        return
      }
      const batch = [...pending.entries()]
      pending.clear()
      if (batch.length === 0) {
        return
      }
      void (async (): Promise<void> => {
        for (const [fsPath, action] of batch) {
          if (disposed) {
            return
          }
          try {
            if (action === 'remove') {
              await service.removeFile(fsPath)
            } else {
              await service.updateFile(fsPath)
            }
          } catch (error) {
            logger.error(`file watcher ${action} failed: ${fsPath}`, error)
          }
        }
      })()
    }

    const eventDisposables: vscode.Disposable[] = []
    const subscribe = (event: vscode.Event<vscode.Uri> | undefined, action: PendingAction): void => {
      try {
        if (typeof event === 'function') {
          eventDisposables.push(event((uri) => enqueue(uri, action)))
        }
      } catch (error) {
        logger.error(`cannot subscribe file watcher ${action} event`, error)
      }
    }
    subscribe(watcher.onDidCreate, 'update')
    subscribe(watcher.onDidChange, 'update')
    subscribe(watcher.onDidDelete, 'remove')

    return {
      dispose: (): void => {
        disposed = true
        if (timer) {
          clearTimeout(timer)
          timer = undefined
        }
        pending.clear()
        for (const disposable of eventDisposables) {
          try {
            disposable.dispose()
          } catch {
            // ignore
          }
        }
        eventDisposables.length = 0
        try {
          watcher.dispose()
        } catch {
          // ignore
        }
      },
    }
  } catch (error) {
    console.error('[source-insight-c] cannot create file system watcher', error)
    return noopDisposable()
  }
}
