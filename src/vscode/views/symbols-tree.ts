/**
 * 侧边栏符号树：Activity Bar「Code Insight」容器里的 `si.symbols` 视图。
 *
 * 结构：已配置的索引根目录 -> 目录（懒加载）-> 文件 -> 文件内函数（签名摘要/悬停）。
 * 未配置索引时 getChildren() 返回空数组，VS Code 自动显示 package.json 里的 viewsWelcome 引导。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'

import type { SymbolEntry } from '../../shared/types'
import type { SymbolService } from '../service'
import { SimpleEmitter } from '../emitter'
import { baseName, isIndexablePath, normalizeRelative } from '../paths'
import { kindLabel } from '../util'

export interface RootNode {
  readonly kind: 'root'
  readonly rel: string
}

export interface DirectoryNode {
  readonly kind: 'dir'
  readonly rel: string
}

export interface FileNode {
  readonly kind: 'file'
  readonly rel: string
}

export interface SymbolNode {
  readonly kind: 'symbol'
  readonly rel: string
  readonly entry: SymbolEntry
}

export interface MoreNode {
  readonly kind: 'more'
  readonly rel: string
  readonly remaining: number
}

export type SiTreeNode = RootNode | DirectoryNode | FileNode | SymbolNode | MoreNode

// VS Code 枚举值：None=0, Collapsed=1, Expanded=2。
// 不在模块顶层直接读 `vscode.TreeItemCollapsibleState`，避免极简 mock 环境下 import 即崩。
function collapsibleState(name: 'None' | 'Collapsed' | 'Expanded'): vscode.TreeItemCollapsibleState {
  try {
    const states = vscode.TreeItemCollapsibleState as unknown as
      | Record<string, vscode.TreeItemCollapsibleState>
      | undefined
    const value = states?.[name]
    if (typeof value === 'number') {
      return value
    }
  } catch {
    // ignore
  }
  return ({ None: 0, Collapsed: 1, Expanded: 2 } as const)[name] as unknown as vscode.TreeItemCollapsibleState
}

const COLLAPSED = collapsibleState('Collapsed')
const EXPANDED = collapsibleState('Expanded')
const NONE = collapsibleState('None')

export class SymbolsTreeProvider implements vscode.TreeDataProvider<SiTreeNode>, vscode.Disposable {
  readonly onDidChangeTreeData: vscode.Event<SiTreeNode | undefined | void>

  private readonly emitter = new SimpleEmitter<SiTreeNode | undefined | void>()
  private readonly disposables: vscode.Disposable[] = []

  constructor(private readonly service: SymbolService) {
    this.onDidChangeTreeData = this.emitter.event
    this.disposables.push(this.service.onDidChange(() => this.refresh()))
    this.disposables.push(this.service.onProgress(() => this.refresh()))
  }

  refresh(): void {
    this.emitter.fire(undefined)
  }

  getTreeItem(element: SiTreeNode): vscode.TreeItem {
    try {
      switch (element.kind) {
        case 'root':
          return this.rootItem(element)
        case 'dir':
          return this.directoryItem(element)
        case 'file':
          return this.fileItem(element)
        case 'symbol':
          return this.symbolItem(element)
        case 'more':
          return this.moreItem(element)
        default:
          return new vscode.TreeItem('')
      }
    } catch (error) {
      console.error('[code-insight] getTreeItem failed', error)
      return new vscode.TreeItem(String((element as { rel?: string } | undefined)?.rel ?? ''))
    }
  }

  getChildren(element?: SiTreeNode): vscode.ProviderResult<SiTreeNode[]> {
    try {
      if (!element) {
        return this.rootNodes()
      }
      if (element.kind === 'root' || element.kind === 'dir') {
        return this.listDirectory(element.rel)
      }
      if (element.kind === 'file') {
        return this.fileChildren(element.rel)
      }
      return []
    } catch (error) {
      console.error('[code-insight] getChildren failed', error)
      return []
    }
  }

  async resolveTreeItem(
    item: vscode.TreeItem,
    element: SiTreeNode,
    token: vscode.CancellationToken,
  ): Promise<vscode.TreeItem> {
    try {
      if (element.kind !== 'symbol' || token?.isCancellationRequested) {
        return item
      }
      const signature = await this.service.signature(element.entry)
      if (signature) {
        item.tooltip = signature
      }
    } catch (error) {
      console.error('[code-insight] resolveTreeItem failed', error)
    }
    return item
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      try {
        disposable.dispose()
      } catch {
        // ignore
      }
    }
    this.disposables.length = 0
    this.emitter.dispose()
  }

  // ---- 节点构造 ----

  private rootNodes(): SiTreeNode[] {
    if (!this.service.hasRoots) {
      return []
    }
    return this.service.configuredRoots.map((rel) => ({ kind: 'root', rel }))
  }

  private rootItem(node: RootNode): vscode.TreeItem {
    const workspaceRoot = this.service.workspaceRoot
    const label =
      node.rel === '.'
        ? workspaceRoot
          ? baseName(workspaceRoot.split(path.sep).join('/')) || workspaceRoot
          : vscode.l10n.t('Workspace')
        : node.rel
    const item = new vscode.TreeItem(label, EXPANDED)
    item.id = `si-root:${node.rel}`
    item.contextValue = 'siRoot'
    item.iconPath = new vscode.ThemeIcon('folder')
    item.description =
      node.rel === '.' ? vscode.l10n.t('workspace root') : vscode.l10n.t('index root')
    item.tooltip = this.service.toAbsolute(node.rel)
    return item
  }

  private directoryItem(node: DirectoryNode): vscode.TreeItem {
    const item = new vscode.TreeItem(baseName(node.rel), COLLAPSED)
    item.id = `si-dir:${node.rel}`
    item.contextValue = 'siDirectory'
    item.iconPath = new vscode.ThemeIcon('folder')
    item.tooltip = node.rel
    return item
  }

  private fileItem(node: FileNode): vscode.TreeItem {
    const item = new vscode.TreeItem(baseName(node.rel), COLLAPSED)
    item.id = `si-file:${node.rel}`
    item.contextValue = 'siFile'
    item.tooltip = node.rel
    try {
      item.resourceUri = vscode.Uri.file(this.service.toAbsolute(node.rel))
    } catch (error) {
      console.error('[code-insight] cannot set file resourceUri', error)
    }
    return item
  }

  private symbolItem(node: SymbolNode): vscode.TreeItem {
    const entry = node.entry
    const item = new vscode.TreeItem(entry.name, NONE)
    item.id = `si-symbol:${entry.file}:${entry.line}:${entry.column}`
    item.contextValue = 'siSymbol'
    item.description = `:${entry.line + 1} · ${kindLabel(entry.kind)}`
    item.iconPath = new vscode.ThemeIcon(entry.kind === 'macro' ? 'symbol-constant' : 'symbol-method')
    item.command = {
      command: 'si.openSymbolAt',
      title: vscode.l10n.t('Open Symbol'),
      arguments: [entry.file, entry.line, entry.column],
    }
    item.tooltip = `${entry.file}:${entry.line + 1}`
    return item
  }

  private moreItem(node: MoreNode): vscode.TreeItem {
    const item = new vscode.TreeItem(vscode.l10n.t('… and {0} more', String(node.remaining)), NONE)
    item.contextValue = 'siMore'
    item.iconPath = new vscode.ThemeIcon('ellipsis')
    return item
  }

  // ---- 懒加载 ----

  private async listDirectory(relDir: string): Promise<SiTreeNode[]> {
    const rel = normalizeRelative(relDir)
    if (!rel && relDir !== '.') {
      return []
    }
    const dirRel = relDir === '.' ? '.' : rel
    const absolute = this.service.toAbsolute(dirRel)
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(absolute, { withFileTypes: true })
    } catch (error) {
      console.error(`[code-insight] cannot list ${absolute}`, error)
      return []
    }
    const directories: SiTreeNode[] = []
    const files: SiTreeNode[] = []
    for (const entry of entries) {
      const name = entry.name
      if (!name || name.startsWith('.')) {
        continue
      }
      const childRel = dirRel === '.' ? name : `${dirRel}/${name}`
      if (entry.isDirectory()) {
        if (this.service.isExcluded(childRel, true)) {
          continue
        }
        directories.push({ kind: 'dir', rel: childRel })
        continue
      }
      if (!entry.isFile() || !isIndexablePath(name)) {
        continue
      }
      if (this.service.isExcluded(childRel)) {
        continue
      }
      files.push({ kind: 'file', rel: childRel })
    }
    const byName = (a: SiTreeNode, b: SiTreeNode): number => {
      const left = a.kind === 'more' ? '' : baseName(a.rel)
      const right = b.kind === 'more' ? '' : baseName(b.rel)
      return left.localeCompare(right)
    }
    directories.sort(byName)
    files.sort(byName)
    return [...directories, ...files]
  }

  private fileChildren(relFile: string): SiTreeNode[] {
    if (!this.service.ready) {
      return []
    }
    const rel = normalizeRelative(relFile)
    const entries = this.service.fileSymbols(rel)
    if (entries.length === 0) {
      return []
    }
    const limit = Math.max(1, this.service.config.searchLimit)
    const nodes: SiTreeNode[] = entries.slice(0, limit).map((entry) => ({
      kind: 'symbol',
      rel,
      entry,
    }))
    if (entries.length > limit) {
      nodes.push({ kind: 'more', rel, remaining: entries.length - limit })
    }
    return nodes
  }
}
