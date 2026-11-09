/**
 * 一个与 `vscode.Event` / `vscode.Disposable` 完全签名兼容的极小事件发射器。
 *
 * 之所以不用 `vscode.EventEmitter`：
 * - 集成冒烟测试用 mock `vscode` 模块，EventEmitter 可能只是最小实现；
 * - `Event<T>` 在 VS Code API 里就是一个函数类型，自实现不会改变行为。
 */
import type * as vscode from 'vscode'

export class SimpleEmitter<T> implements vscode.Disposable {
  private readonly listeners = new Set<(event: T) => unknown>()
  private disposed = false

  readonly event: vscode.Event<T> = (listener, thisArgs, disposables) => {
    if (this.disposed) {
      return { dispose: () => undefined }
    }
    const bound = ((thisArgs ? listener.bind(thisArgs) : listener) as unknown) as (event: T) => unknown
    this.listeners.add(bound)
    const disposable: vscode.Disposable = {
      dispose: (): void => {
        this.listeners.delete(bound)
      },
    }
    if (Array.isArray(disposables)) {
      disposables.push(disposable)
    }
    return disposable
  }

  fire(event: T): void {
    if (this.disposed) {
      return
    }
    for (const listener of [...this.listeners]) {
      try {
        listener(event)
      } catch (error) {
        console.error('[source-insight-c] event listener failed', error)
      }
    }
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }
}
