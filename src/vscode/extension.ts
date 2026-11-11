/**
 * 扩展激活入口。
 *
 * activate():
 *   1. 创建输出通道日志 + SymbolService（恢复磁盘快照，无快照则等配置/后台构建）；
 *   2. 注册 6 个语言 Provider（Call Hierarchy 受 enableCallHierarchy 控制）、符号树、状态栏；
 *   3. 注册 9 个命令、C/C++ 文件监听（防抖 800 ms）、配置变更监听；
 *   4. 已配置 indexRoots 时后台构建索引（withProgress 可取消）。
 *
 * 容错：storageUri / 输出通道 / 无 workspace folder / mock vscode（集成冒烟）都不允许抛错。
 */
import * as vscode from 'vscode'

import { isRebuildPromptSuppressed, onDidChangeConfig, readConfig } from './config'
import { registerCommands } from './commands'
import { createLogger, type Logger } from './log'
import { registerCallHierarchyProvider } from './providers/call-hierarchy'
import { registerDefinitionProvider } from './providers/definition'
import { registerDocumentSymbolProvider } from './providers/document-symbol'
import { registerHoverProvider } from './providers/hover'
import { registerReferenceProvider } from './providers/references'
import { registerWorkspaceSymbolProvider } from './providers/workspace-symbol'
import { SymbolService } from './service'
import { createStatusBar } from './status'
import { executeCommand, showInformationMessage } from './util'
import { SymbolsTreeProvider, type SiTreeNode } from './views/symbols-tree'
import { createFileWatcher } from './watcher'

const VIEW_ID = 'si.symbols'

interface Runtime {
  disposed: boolean
  dispose(): void
}

let runtime: Runtime | undefined
let activeService: SymbolService | undefined

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  if (runtime) {
    return
  }
  const logger = createLogger()
  const disposables: vscode.Disposable[] = []
  const add = (disposable: vscode.Disposable | undefined): void => {
    if (!disposable) {
      return
    }
    disposables.push(disposable)
    try {
      context?.subscriptions?.push(disposable)
    } catch (error) {
      console.error('[rcios-insight] cannot push disposable to context', error)
    }
  }
  const current: Runtime = {
    disposed: false,
    dispose: (): void => {
      if (current.disposed) {
        return
      }
      current.disposed = true
      for (const disposable of [...disposables].reverse()) {
        try {
          disposable.dispose()
        } catch (error) {
          console.error('[rcios-insight] dispose failed', error)
        }
      }
      disposables.length = 0
    },
  }
  runtime = current

  try {
    const service = await SymbolService.create(context, logger)
    activeService = service
    add(service)

    const tree = new SymbolsTreeProvider(service)
    add(tree)

    let view: vscode.TreeView<SiTreeNode> | undefined
    try {
      if (typeof vscode.window.createTreeView === 'function') {
        view = vscode.window.createTreeView(VIEW_ID, {
          treeDataProvider: tree,
          showCollapseAll: true,
        })
        add(view)
      } else {
        logger.warn('createTreeView unavailable; symbol tree is disabled')
      }
    } catch (error) {
      logger.error('cannot create symbol tree view', error)
    }

    add(registerDefinitionProvider(service))
    add(registerReferenceProvider(service))
    add(registerHoverProvider(service))
    add(registerDocumentSymbolProvider(service))
    add(registerWorkspaceSymbolProvider(service))

    // 原生 Call Hierarchy 受 sourceInsight.enableCallHierarchy 控制，支持运行时开关
    let callHierarchyDisposable: vscode.Disposable | undefined
    const syncCallHierarchy = (): void => {
      try {
        const enabled = readConfig().enableCallHierarchy
        if (enabled && !callHierarchyDisposable) {
          callHierarchyDisposable = registerCallHierarchyProvider(service)
        } else if (!enabled && callHierarchyDisposable) {
          const disposable = callHierarchyDisposable
          callHierarchyDisposable = undefined
          disposable.dispose()
        }
      } catch (error) {
        logger.error('cannot synchronize call hierarchy provider', error)
      }
    }
    syncCallHierarchy()
    add({
      dispose: (): void => {
        try {
          callHierarchyDisposable?.dispose()
        } catch {
          // ignore
        }
        callHierarchyDisposable = undefined
      },
    })

    const status = createStatusBar(service)
    add(status)

    add(registerCommands(context, service))
    add(createFileWatcher(service, logger))

    const updateViewMessage = (): void => {
      if (!view) {
        return
      }
      try {
        if (service.building) {
          view.message = vscode.l10n.t('Building the RCIOS Insight index…')
        } else if (!service.hasRoots) {
          view.message = undefined
        } else if (!service.ready) {
          view.message = vscode.l10n.t('Index not built yet. Run "Rebuild Index".')
        } else {
          view.message = undefined
        }
      } catch (error) {
        logger.error('cannot update tree view message', error)
      }
    }
    add(service.onDidChange(updateViewMessage))
    add(service.onProgress(updateViewMessage))
    updateViewMessage()

    add(
      onDidChangeConfig((change) => {
        syncCallHierarchy()
        tree.refresh()
        status.update()
        updateViewMessage()
        if (change.affectsIndex) {
          void promptRebuildAfterConfigChange(service, logger)
        }
      }),
    )

    if (service.hasRoots) {
      void buildInBackground(service, logger)
    }

    logger.info('RCIOS Insight activated')
  } catch (error) {
    logger.error('activation failed', error)
  }
}

export async function deactivate(): Promise<void> {
  const service = activeService
  activeService = undefined
  // 先 flush 防抖中的增量快照，再释放 service（dispose 之后不再写盘）
  try {
    await service?.flush()
  } catch (error) {
    console.error('[rcios-insight] cannot flush snapshot during deactivate', error)
  }
  const current = runtime
  runtime = undefined
  current?.dispose()
}

async function buildInBackground(service: SymbolService, logger: Logger): Promise<void> {
  try {
    const summary = await service.ensureBuilt()
    if (summary) {
      logger.info(
        `background index build finished: files=${summary.files} entries=${summary.entries} ` +
          `duration=${summary.durationMs}ms`,
      )
    }
  } catch (error) {
    logger.error('background index build failed', error)
  }
}

async function promptRebuildAfterConfigChange(
  service: SymbolService,
  logger: Logger,
): Promise<void> {
  try {
    if (isRebuildPromptSuppressed() || !service.hasRoots) {
      return
    }
    const rebuildLabel = vscode.l10n.t('Rebuild')
    const answer = await showInformationMessage(
      vscode.l10n.t('RCIOS Insight index settings changed. Rebuild the index now?'),
      rebuildLabel,
      vscode.l10n.t('Later'),
    )
    if (answer === rebuildLabel) {
      await executeCommand('si.rebuildIndex')
    }
  } catch (error) {
    logger.error('rebuild prompt failed', error)
  }
}
