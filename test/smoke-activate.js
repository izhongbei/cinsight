#!/usr/bin/env node
/**
 * 用 mock 的 `vscode` 模块加载编译产物并执行 activate()，验证：
 *  - extension.js 可加载、activate 不抛异常
 *  - 所有 package.json 声明的命令都被注册
 *  - 语言 Provider 注册数量符合预期
 *  - 预算状态栏（warn/exceeded 颜色）与 exceeded 一次性提示（含按钮动作）
 *  - F8 符号高亮：装饰/状态栏/F3 跳转/编辑防抖/编辑器切换清除
 *  - autoCompact=false 时 flush/dispose 只保证 delta 落盘、不写 base
 *  - deactivate() 不抛异常
 *
 * 本机没有 VS Code CLI，因此这是唯一的自动化"扩展宿主"验收。
 * 运行：node test/smoke-activate.js
 */
'use strict'

const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const EXT_ROOT = path.resolve(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(EXT_ROOT, 'package.json'), 'utf8'))

// ---------------------------------------------------------------------------
// 最小 vscode mock
// ---------------------------------------------------------------------------
const registrations = {
  commands: [],
  providers: [],
  treeViews: [],
  statusBar: 0,
  /** 创建过的状态栏 item（status.ts 会直接改这些字段，用来断言颜色/图标） */
  statusBarItems: [],
  /** vscode.window.showWarningMessage 调用记录 */
  warnings: [],
  /** vscode.commands.executeCommand 调用记录 */
  executedCommands: [],
  /** vscode.window.showQuickPick 调用记录（items/options），用于断言候选/副本两级列表 */
  quickPicks: [],
  /** vscode.window.createQuickPick 创建的输入型 QuickPick（搜索命令断言用） */
  customQuickPicks: [],
  /** 按调用顺序消费的 QuickPick 应答（函数 = 自定义选择，number = 下标；缺省选第一项） */
  quickPickResponses: [],
  /** vscode.workspace.openTextDocument + showTextDocument 打开过的文档（openLocation 断言） */
  openedDocuments: [],
  /** vscode.window.showInformationMessage 调用记录 */
  informationMessages: [],
  /** showWarningMessage 的返回值（模拟用户点击按钮） */
  warningChoice: undefined,
  /** createTextEditorDecorationType 创建过的装饰类型（F8 高亮断言用） */
  decorations: [],
  /** 活动编辑器/文档编辑/文档关闭 事件监听器（冒烟里手动触发以模拟宿主） */
  activeEditorListeners: [],
  documentChangeListeners: [],
  documentCloseListeners: [],
  /** onDidChangeConfiguration 监听器（颜色配置变更断言用） */
  configurationListeners: [],
  /** createWebviewPanel 创建过的面板（Relation 面板断言用） */
  webviewPanels: [],
  /** 面板 webview.postMessage 消息（state/error） */
  webviewMessages: [],
  /** 面板 webview.onDidReceiveMessage 监听器（模拟 webview 发消息） */
  webviewMessageListeners: [],
}
const disposables = []

function disposable(label) {
  const d = { label, dispose() {} }
  disposables.push(d)
  return d
}

class EventEmitter {
  constructor() {
    this.listeners = new Set()
    this.event = (listener) => {
      this.listeners.add(listener)
      return { dispose: () => this.listeners.delete(listener) }
    }
  }
  fire(value) {
    for (const listener of this.listeners) listener(value)
  }
  dispose() {
    this.listeners.clear()
  }
}

class CancellationTokenSource {
  constructor() {
    this.token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }
  }
  cancel() {
    this.token.isCancellationRequested = true
  }
  dispose() {}
}

const SymbolKind = {
  File: 0, Module: 1, Namespace: 2, Package: 3, Class: 4, Method: 5, Property: 6,
  Field: 7, Constructor: 8, Enum: 9, Interface: 10, Function: 11, Variable: 12,
  Constant: 13, String: 14, Number: 15, Boolean: 16, Array: 17, Object: 18,
  Key: 19, Null: 20, EnumMember: 21, Struct: 22, Event: 23, Operator: 24,
  TypeParameter: 25,
}

class Position {
  constructor(line, character) {
    this.line = line
    this.character = character
  }
  isEqual(other) {
    return this.line === other.line && this.character === other.character
  }
  isBefore(other) {
    return this.line < other.line || (this.line === other.line && this.character < other.character)
  }
  translate(lineDelta = 0, characterDelta = 0) {
    return new Position(this.line + lineDelta, this.character + characterDelta)
  }
}
Position.prototype.with = function (change) {
  return new Position(change.line ?? this.line, change.character ?? this.character)
}

class Range {
  constructor(startOrStartLine, startCharOrEndLine, endLineOrUndefined, endChar) {
    if (typeof startOrStartLine === 'number') {
      this.start = new Position(startOrStartLine, startCharOrEndLine)
      this.end = new Position(endLineOrUndefined ?? startOrStartLine, endChar ?? startCharOrEndLine)
    } else {
      this.start = startOrStartLine
      this.end = startCharOrEndLine
    }
  }
  get isEmpty() {
    return this.start.isEqual(this.end)
  }
}

class Selection {
  constructor(anchor, active) {
    this.anchor = anchor
    this.active = active
  }
  get start() {
    return this.anchor.isBefore(this.active) ? this.anchor : this.active
  }
  get end() {
    return this.anchor.isBefore(this.active) ? this.active : this.anchor
  }
  get isEmpty() {
    return this.anchor.isEqual(this.active)
  }
}

class Location {
  constructor(uri, rangeOrPosition) {
    this.uri = uri
    this.range = rangeOrPosition instanceof Range ? rangeOrPosition : new Range(rangeOrPosition, rangeOrPosition)
  }
}

class SymbolInformation {
  constructor(name, kind, containerName, location) {
    this.name = name
    this.kind = kind
    this.containerName = containerName
    this.location = location
  }
}

class DocumentSymbol {
  constructor(name, detail, kind, range, selectionRange) {
    this.name = name
    this.detail = detail
    this.kind = kind
    this.range = range
    this.selectionRange = selectionRange
    this.children = []
  }
}

class CallHierarchyItem {
  constructor(kind, name, detail, uri, range, selectionRange) {
    Object.assign(this, { kind, name, detail, uri, range, selectionRange })
  }
}
class CallHierarchyIncomingCall {
  constructor(from, fromRanges) {
    this.from = from
    this.fromRanges = fromRanges
  }
}
class CallHierarchyOutgoingCall {
  constructor(to, fromRanges) {
    this.to = to
    this.fromRanges = fromRanges
  }
}

class MarkdownString {
  constructor(value = '') {
    this.value = value
    this.isTrusted = false
  }
  appendMarkdown(value) {
    this.value += value
    return this
  }
  appendCodeblock(value, language) {
    this.value += '\n```' + (language || '') + '\n' + value + '\n```\n'
    return this
  }
}

class Hover {
  constructor(contents, range) {
    this.contents = Array.isArray(contents) ? contents : [contents]
    this.range = range
  }
}

class TreeItem {
  constructor(labelOrUri, collapsibleState) {
    this.label = labelOrUri
    this.collapsibleState = collapsibleState ?? 0
    this.contextValue = undefined
    this.command = undefined
    this.description = undefined
    this.iconPath = undefined
    this.tooltip = undefined
  }
}

const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 }

class ThemeIcon {
  constructor(id, color) {
    this.id = id
    this.color = color
  }
}
class ThemeColor {
  constructor(id) {
    this.id = id
  }
}

class TextDocument {
  constructor(uri, text) {
    this.uri = uri
    this.fileName = uri.fsPath
    this.languageId = 'c'
    this.version = 1
    this.lineCount = text.split('\n').length
    this._lines = text.split('\n')
    this.isDirty = false
    this.isUntitled = false
  }
  getText(range) {
    if (!range) return this._lines.join('\n')
    const slice = this._lines.slice(range.start.line, range.end.line + 1)
    return slice.join('\n')
  }
  lineAt(lineOrPosition) {
    const line = typeof lineOrPosition === 'number' ? lineOrPosition : lineOrPosition.line
    const text = this._lines[line] ?? ''
    return {
      lineNumber: line,
      text,
      range: new Range(line, 0, line, text.length),
      rangeIncludingLineBreak: new Range(line, 0, line, text.length + 1),
      firstNonWhitespaceCharacterIndex: text.search(/\S/),
      isEmptyOrWhitespace: !/\S/.test(text),
    }
  }
  getWordRangeAtPosition(position, regex) {
    const line = this._lines[position.line] ?? ''
    const re = new RegExp(regex ? regex.source : '[A-Za-z_][A-Za-z0-9_]*', 'g')
    let m
    while ((m = re.exec(line))) {
      if (m.index <= position.character && position.character <= m.index + m[0].length) {
        return new Range(position.line, m.index, position.line, m.index + m[0].length)
      }
      if (m.index > position.character) break
      if (m[0].length === 0) re.lastIndex++
    }
    return undefined
  }
  positionAt(offset) {
    const before = this._lines.slice(0, -1)
    void before
    const upto = this.getText().slice(0, offset).split('\n')
    return new Position(upto.length - 1, upto[upto.length - 1].length)
  }
}

function uriFromPath(p) {
  const fsPath = path.resolve(p)
  return {
    scheme: 'file',
    fsPath,
    path: fsPath,
    authority: '',
    query: '',
    fragment: '',
    toString: () => 'file://' + fsPath,
    with: (change) => Object.assign({}, uriFromPath(change.path ?? fsPath), change),
  }
}

const Uri = {
  file: (p) => uriFromPath(p),
  parse: (s) => uriFromPath(s.replace(/^file:\/\//, '')),
  joinPath: (base, ...parts) => uriFromPath(path.join(base.fsPath ?? base.path, ...parts)),
}

const configurationValues = {
  indexRoots: [],
  exclude: ['**/.git/**', '**/build/**', '**/tmp/**', '**/node_modules/**'],
  maxFileSizeKB: 4096,
  concurrency: 2,
  maxSymbols: 3000000,
  maxFiles: 120000,
  autoCompact: true,
  searchLimit: 200,
  treeSymbolLimit: 2000,
  autoReindexOnSave: true,
  enableCallHierarchy: true,
  followSymlinks: false,
  highlightDefinitionColor: '',
  highlightReferenceColor: '',
}

const workspaceFolder = { uri: uriFromPath(EXT_ROOT), name: 'smoke', index: 0 }

function getConfiguration(section) {
  const prefix = section ? section + '.' : ''
  const get = (key, fallback) => {
    const full = prefix + key
    // configurationValues 用短键（maxSymbols 等）；同时容忍完整键，模拟真实
    // getConfiguration(section).get('maxSymbols') / getConfiguration().get('sourceInsight.maxSymbols')
    const short = full.startsWith('sourceInsight.')
      ? full.slice('sourceInsight.'.length)
      : full
    if (full in configurationValues) return configurationValues[full]
    if (short in configurationValues) return configurationValues[short]
    return fallback
  }
  return {
    get,
    has: (key) => prefix + key in configurationValues,
    inspect: () => undefined,
    update: () => Promise.resolve(),
  }
}

const outputChannels = []
const vscode = {
  version: '1.90.0',
  EventEmitter,
  CancellationTokenSource,
  Disposable: class Disposable {
    constructor(fn) {
      this._fn = fn
    }
    static from(...items) {
      return new vscode.Disposable(() => items.forEach((i) => i && i.dispose && i.dispose()))
    }
    dispose() {
      if (this._fn) this._fn()
    }
  },
  Uri,
  Position,
  Range,
  Selection,
  Location,
  SymbolInformation,
  DocumentSymbol,
  CallHierarchyItem,
  CallHierarchyIncomingCall,
  CallHierarchyOutgoingCall,
  MarkdownString,
  Hover,
  TreeItem,
  TreeItemCollapsibleState,
  ThemeIcon,
  ThemeColor,
  SymbolKind,
  CompletionItem: class CompletionItem {},
  SnippetString: class SnippetString {},
  TextEdit: { replace: () => ({}) },
  WorkspaceEdit: class WorkspaceEdit {},
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
  FileChangeType: { Created: 1, Changed: 2, Deleted: 3 },
  RelativePattern: class RelativePattern {
    constructor(base, pattern) {
      this.base = base
      this.pattern = pattern
    }
  },
  TextEditorRevealType: { InCenter: 2 },
  languages: {
    registerDefinitionProvider: (selector, provider) => {
      registrations.providers.push(['definition', selector, provider])
      return disposable('definition')
    },
    registerReferenceProvider: (selector, provider) => {
      registrations.providers.push(['references', selector, provider])
      return disposable('references')
    },
    registerHoverProvider: (selector, provider) => {
      registrations.providers.push(['hover', selector, provider])
      return disposable('hover')
    },
    registerDocumentSymbolProvider: (selector, provider) => {
      registrations.providers.push(['documentSymbol', selector, provider])
      return disposable('documentSymbol')
    },
    registerWorkspaceSymbolProvider: (provider) => {
      registrations.providers.push(['workspaceSymbol', undefined, provider])
      return disposable('workspaceSymbol')
    },
    registerCallHierarchyProvider: (selector, provider) => {
      registrations.providers.push(['callHierarchy', selector, provider])
      return disposable('callHierarchy')
    },
  },
  commands: {
    registerCommand: (id, handler) => {
      registrations.commands.push([id, handler])
      return disposable('command:' + id)
    },
    registerTextEditorCommand: (id, handler) => {
      registrations.commands.push([id, handler])
      return disposable('textEditorCommand:' + id)
    },
    executeCommand: async (command, ...args) => {
      registrations.executedCommands.push([command, ...args])
      return undefined
    },
    getCommands: async () => registrations.commands.map(([id]) => id),
  },
  window: {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    onDidChangeActiveTextEditor: (listener) => {
      if (typeof listener === 'function') registrations.activeEditorListeners.push(listener)
      return disposable('onDidChangeActiveTextEditor')
    },
    onDidChangeVisibleTextEditors: () => disposable('onDidChangeVisibleTextEditors'),
    onDidChangeTextEditorSelection: () => disposable('onDidChangeTextEditorSelection'),
    createTreeView: (id, options) => {
      registrations.treeViews.push([id, options])
      return { dispose() {}, visible: true, onDidChangeVisibility: () => disposable('vis') }
    },
    registerTreeDataProvider: (id) => {
      registrations.treeViews.push([id, undefined])
      return disposable('treeDataProvider')
    },
    createTextEditorDecorationType: (options) => {
      const type = {
        options,
        disposed: false,
        dispose() {
          type.disposed = true
        },
      }
      registrations.decorations.push(type)
      return type
    },
    createWebviewPanel: (viewType, title, showOptions, options) => {
      const webview = {
        cspSource: 'vscode-resource://smoke',
        html: '',
        options,
        postMessage: async (message) => {
          registrations.webviewMessages.push(message)
          return true
        },
        onDidReceiveMessage: (listener) => {
          registrations.webviewMessageListeners.push(listener)
          return disposable('webviewMessage')
        },
      }
      const panel = {
        viewType,
        title,
        viewColumn: 2,
        webview,
        revealed: 0,
        disposed: false,
        reveal() {
          panel.revealed += 1
        },
        onDidDispose: () => disposable('webviewDispose'),
        dispose() {
          panel.disposed = true
        },
      }
      void showOptions
      registrations.webviewPanels.push(panel)
      return panel
    },
    createStatusBarItem: () => {
      registrations.statusBar += 1
      const item = {
        text: '',
        tooltip: undefined,
        command: undefined,
        backgroundColor: undefined,
        visible: false,
        show() {
          item.visible = true
        },
        hide() {
          item.visible = false
        },
        dispose() {},
      }
      registrations.statusBarItems.push(item)
      return item
    },
    createQuickPick: () => {
      // 模拟真实宿主的输入过滤：输入框的原始值会重新过滤已设置 items 的可见列表，
      // 只有 `alwaysShow: true` 的条目能绕过（动态搜索靠它保住自己的排名结果）。
      const hostVisibleItems = () => {
        const value = String(quickPick.value ?? '').trim().toLowerCase()
        if (!value) return quickPick._allItems
        return quickPick._allItems.filter((item) => {
          if (!item) return false
          if (item.alwaysShow) return true
          const fields = [item.label]
          if (quickPick.matchOnDescription) fields.push(item.description)
          if (quickPick.matchOnDetail) fields.push(item.detail)
          return fields.some(
            (field) => typeof field === 'string' && field.toLowerCase().includes(value),
          )
        })
      }
      const quickPick = {
        _allItems: [],
        value: '',
        get items() {
          // 读取到的是宿主过滤之后用户真正看到的候选（模拟 VS Code QuickPick）
          return hostVisibleItems()
        },
        set items(next) {
          quickPick._allItems = Array.isArray(next) ? next : []
        },
        /** 未经过滤的原始 items（调试/断言用） */
        get allItems() {
          return quickPick._allItems
        },
        placeholder: '',
        matchOnDescription: false,
        matchOnDetail: false,
        ignoreFocusOut: false,
        selectedItems: [],
        _onChange: undefined,
        _onAccept: undefined,
        _onHide: undefined,
        onDidChangeValue: (listener) => {
          quickPick._onChange = (value) => {
            quickPick.value = value
            listener(value)
          }
          return disposable('quickPickValue')
        },
        onDidAccept: (listener) => {
          quickPick._onAccept = listener
          return disposable('quickPickAccept')
        },
        onDidHide: (listener) => {
          quickPick._onHide = listener
          return disposable('quickPickHide')
        },
        show: () => {
          registrations.customQuickPicks.push(quickPick)
        },
        hide: () => {
          if (quickPick._onHide) quickPick._onHide()
        },
        dispose: () => {},
      }
      return quickPick
    },
    createOutputChannel: (name) => {
      const channel = {
        name,
        append() {},
        appendLine() {},
        replace() {},
        clear() {},
        show() {},
        hide() {},
        dispose() {},
        info() {},
        warn() {},
        error() {},
        debug() {},
        trace() {},
        logLevel: 0,
        onDidChangeLogLevel: () => disposable('logLevel'),
      }
      outputChannels.push(channel)
      return channel
    },
    withProgress: async (_options, task) => task({ report: () => {} }, { isCancellationRequested: false }),
    showInformationMessage: async (message) => {
      registrations.informationMessages.push(message)
      return undefined
    },
    showWarningMessage: async (message, ...items) => {
      registrations.warnings.push({ message, items })
      return registrations.warningChoice
    },
    showErrorMessage: async () => undefined,
    showQuickPick: async (items, options) => {
      if (!Array.isArray(items)) return undefined
      registrations.quickPicks.push({ items, options })
      const responder = registrations.quickPickResponses.shift()
      if (typeof responder === 'function') return responder(items, options)
      if (typeof responder === 'number') return items[responder]
      return items[0]
    },
    showInputBox: async () => undefined,
    showTextDocument: async (document) => {
      if (document && document.uri) registrations.openedDocuments.push(document)
      return {
        document: document && document.getText ? document : new TextDocument(Uri.file('/tmp/x.c'), ''),
        selection: undefined,
        revealRange: () => {},
      }
    },
    activeColorTheme: { kind: 2 },
    onDidChangeActiveColorTheme: () => disposable('theme'),
    tabGroups: { all: [], onDidChangeTabs: () => disposable('tabs'), close: async () => true },
  },
  workspace: {
    workspaceFolders: [workspaceFolder],
    rootPath: EXT_ROOT,
    name: 'smoke',
    isTrusted: true,
    onDidChangeConfiguration: (listener) => {
      if (typeof listener === 'function') registrations.configurationListeners.push(listener)
      return disposable('onDidChangeConfiguration')
    },
    onDidSaveTextDocument: () => disposable('onDidSaveTextDocument'),
    onDidChangeTextDocument: (listener) => {
      if (typeof listener === 'function') registrations.documentChangeListeners.push(listener)
      return disposable('onDidChangeTextDocument')
    },
    onDidChangeWorkspaceFolders: () => disposable('onDidChangeWorkspaceFolders'),
    onDidOpenTextDocument: () => disposable('onDidOpenTextDocument'),
    onDidCloseTextDocument: (listener) => {
      if (typeof listener === 'function') registrations.documentCloseListeners.push(listener)
      return disposable('onDidCloseTextDocument')
    },
    onDidCreateFiles: () => disposable('onDidCreateFiles'),
    onDidDeleteFiles: () => disposable('onDidDeleteFiles'),
    onDidRenameFiles: () => disposable('onDidRenameFiles'),
    getConfiguration,
    getWorkspaceFolder: () => workspaceFolder,
    asRelativePath: (p) => path.relative(EXT_ROOT, typeof p === 'string' ? p : p.fsPath),
    createFileSystemWatcher: () => ({
      onDidCreate: () => disposable('watchCreate'),
      onDidChange: () => disposable('watchChange'),
      onDidDelete: () => disposable('watchDelete'),
      dispose() {},
    }),
    fs: {
      readFile: async () => new Uint8Array(0),
      writeFile: async () => undefined,
      stat: async () => ({ type: 1, ctime: 0, mtime: 0, size: 0 }),
      readDirectory: async () => [],
      createDirectory: async () => undefined,
      delete: async () => undefined,
    },
    openTextDocument: async (p) => {
      let text = ''
      try {
        const fsPath = typeof p === 'string' ? p : (p.fsPath ?? p.path)
        text = fs.readFileSync(fsPath, 'utf8')
      } catch {
        text = ''
      }
      const fsPath = typeof p === 'string' ? path.resolve(p) : (p.fsPath ?? p.path)
      return new TextDocument(Uri.file(fsPath), text)
    },
    findFiles: async () => [],
    textDocuments: [],
    updateWorkspaceFolders: () => true,
    applyEdit: async () => true,
  },
  env: {
    appName: 'Visual Studio Code',
    language: 'zh-cn',
    machineId: 'smoke',
    sessionId: 'smoke',
    isTelemetryEnabled: false,
    remoteName: undefined,
    uiKind: 1,
    onDidChangeTelemetryEnabled: () => disposable('telemetry'),
    openExternal: async () => true,
    clipboard: { readText: async () => '', writeText: async () => undefined },
  },
  l10n: {
    t: (message, ...args) => {
      if (!args.length) return message
      let i = 0
      return message.replace(/\{(\d+)\}/g, (_, n) => String(args[Number(n)] ?? ''))
    },
  },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
  LogLevel: { Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 },
}

// 未知属性兜底：返回可调用/可当对象的占位，避免 activate 因新 API 崩掉
const vscodeProxy = new Proxy(vscode, {
  get(target, key) {
    if (key in target) return target[key]
    if (typeof key !== 'string') return undefined
    const stub = function () {}
    stub.__mock = key
    target[key] = stub
    return stub
  },
})

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeProxy
  return originalLoad.call(this, request, parent, isMain)
}

const extensionPath = EXT_ROOT
const storagePath = path.join(EXT_ROOT, '.smoke-storage')
fs.mkdirSync(storagePath, { recursive: true })
const storageUri = Uri.file(storagePath)

const memento = () => {
  const store = new Map()
  return {
    get: (key, fallback) => (store.has(key) ? store.get(key) : fallback),
    update: async (key, value) => void store.set(key, value),
    keys: () => [...store.keys()],
    setKeysForSync: () => {},
  }
}

const context = {
  subscriptions: [],
  extensionPath,
  extensionUri: Uri.file(extensionPath),
  storageUri,
  globalStorageUri: Uri.file(path.join(storagePath, 'global')),
  globalStoragePath: path.join(storagePath, 'global'),
  logUri: Uri.file(path.join(storagePath, 'log')),
  extensionMode: 3,
  workspaceState: memento(),
  globalState: memento(),
  secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
  environmentVariableCollection: { replace: () => {}, append: () => {}, prepend: () => {} },
  asAbsolutePath: (p) => path.join(extensionPath, p),
  extension: { id: 'cinsight.code-insight', packageJSON: pkg },
}

const smokeLogger = { info() {}, warn() {}, error() {} }

function lastStatusItem() {
  return registrations.statusBarItems[registrations.statusBarItems.length - 1]
}

function tooltipText(item) {
  return item.tooltip && typeof item.tooltip === 'object' ? item.tooltip.value : String(item.tooltip)
}

/**
 * 预算状态栏 + exceeded 一次性提示。
 * 用真实 SymbolService 模拟「已加载大快照」：直接换掉 snapshotValue，
 * 让 budgetReport getter 按新的符号数重算（内部会触发一次性提示）。
 */
async function checkBudgetUi() {
  const dist = path.join(EXT_ROOT, 'dist')
  const { SymbolService } = require(path.join(dist, 'src/vscode/service.js'))
  const { createStatusBar } = require(path.join(dist, 'src/vscode/status.js'))

  const previousRoots = configurationValues.indexRoots
  configurationValues.indexRoots = ['src']
  registrations.warningChoice = 'Reconfigure Index Roots'
  const warningBaseline = registrations.warnings.length
  const commandBaseline = registrations.executedCommands.length
  const service = await SymbolService.create(undefined, smokeLogger)
  service.snapshotValue = {
    entryCount: 3_000_001,
    files: [],
    builtAt: Date.now(),
    roots: ['src'],
  }
  try {
    const controller = createStatusBar(service)
    const item = lastStatusItem()

    // warn：warning 图标 + warning 背景色，且不弹提示
    assert.match(item.text, /^\$\(warning\) /, 'warn status uses $(warning) icon')
    assert.equal(item.backgroundColor?.id, 'statusBarItem.warningBackground')
    assert.match(tooltipText(item), /Index is large/)
    assert.equal(registrations.warnings.length - warningBaseline, 0, 'warn must not prompt')

    // exceeded：error 图标 + error 背景色 + 恰好一次提示（带按钮）
    service.snapshotValue.entryCount = 6_000_001
    controller.update()
    assert.match(item.text, /^\$\(error\) /, 'exceeded status uses $(error) icon')
    assert.equal(item.backgroundColor?.id, 'statusBarItem.errorBackground')
    assert.equal(registrations.warnings.length - warningBaseline, 1, 'exceeded prompts exactly once')
    const warning = registrations.warnings[warningBaseline]
    assert.ok(warning.items.includes('Reconfigure Index Roots'), 'prompt has reconfigure button')
    assert.match(warning.message, /hard maximum 6,000,000/, 'prompt carries budget message')

    // 再次 update（同一轮 exceeded）不应重复提示
    controller.update()
    assert.equal(registrations.warnings.length - warningBaseline, 1, 'no duplicate prompt')

    // 点击按钮 -> 执行 si.configureRoots（非阻塞）
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(
      registrations.executedCommands
        .slice(commandBaseline)
        .some(([id]) => id === 'si.configureRoots'),
      'reconfigure button executes si.configureRoots',
    )

    // 回到 ok：恢复普通图标 + 无背景色，并重置一次性标记
    service.snapshotValue.entryCount = 100
    controller.update()
    assert.match(item.text, /^\$\(symbol-function\) /, 'ok status restores normal icon')
    assert.equal(item.backgroundColor, undefined, 'ok status clears background color')

    // 再次 exceeded：重置后应再次提示
    service.snapshotValue.entryCount = 6_000_001
    controller.update()
    assert.equal(
      registrations.warnings.length - warningBaseline,
      2,
      'prompt resets after returning to ok',
    )

    controller.dispose()
  } finally {
    configurationValues.indexRoots = previousRoots
    registrations.warningChoice = undefined
    service.dispose()
  }
}

/**
 * service.rootsChanged()：必须与 indexer 共用「归一 + 顺序敏感」比较。
 * 归一等价写法（`proj/`、`./proj`）不提示重建；仅顺序变化必须提示（include 前缀优先级）。
 */
async function checkRootsChanged() {
  const dist = path.join(EXT_ROOT, 'dist')
  const { SymbolService } = require(path.join(dist, 'src/vscode/service.js'))

  const previousRoots = configurationValues.indexRoots
  const service = await SymbolService.create(undefined, smokeLogger)
  const snapshotWithRoots = (roots) => ({
    roots,
    files: [],
    entryCount: 0,
    builtAt: Date.now(),
    contentHashOf: () => undefined,
    includedFiles: () => [],
    isReachable: () => false,
    forEachEntry: () => {},
  })
  try {
    // 归一等价：不提示重建
    for (const configured of [['proj/'], ['./proj']]) {
      configurationValues.indexRoots = configured
      service.snapshotValue = snapshotWithRoots(['proj'])
      assert.equal(
        service.rootsChanged(),
        false,
        `${configured[0]} is normalized-equivalent to proj and must not prompt a rebuild`,
      )
    }

    // 顺序变化：必须提示重建（include 的 root 前缀搜索顺序是语义）
    configurationValues.indexRoots = ['b', 'a']
    service.snapshotValue = snapshotWithRoots(['a', 'b'])
    assert.equal(service.rootsChanged(), true, 'order-only change must prompt a rebuild')

    // 内容变化 / 无快照：提示重建
    configurationValues.indexRoots = ['proj']
    service.snapshotValue = snapshotWithRoots(['other'])
    assert.equal(service.rootsChanged(), true, 'different roots prompt a rebuild')
    service.snapshotValue = undefined
    assert.equal(service.rootsChanged(), true, 'missing snapshot prompts a rebuild')
  } finally {
    configurationValues.indexRoots = previousRoots
    service.dispose()
  }
}

/**
 * autoCompact=false：flush 只 await 已排队的 delta 追加，不写 base。
 * 模拟 service 状态并替换 compactNow/compactNameIndexIfNeeded 计数。
 */
async function checkAutoCompactFlush() {
  const dist = path.join(EXT_ROOT, 'dist')
  const { SymbolService } = require(path.join(dist, 'src/vscode/service.js'))

  const previousAutoCompact = configurationValues.autoCompact
  const testDir = path.join(storagePath, 'auto-compact-flush')
  const snapshotPath = path.join(testDir, 'symbols.sidx')
  fs.rmSync(testDir, { recursive: true, force: true })
  configurationValues.autoCompact = false

  const service = await SymbolService.create(undefined, smokeLogger)
  service.snapshotPathValue = snapshotPath
  service.mutableValue = { pendingChanges: 3 }
  let appendAwaited = false
  let compactCalls = 0
  let nameCompactCalls = 0
  service.appendChain = Promise.resolve().then(() => {
    appendAwaited = true
  })
  service.compactNow = async () => {
    compactCalls += 1
  }
  service.compactNameIndexIfNeeded = async () => {
    nameCompactCalls += 1
  }

  try {
    await service.flush()
    assert.equal(appendAwaited, true, 'flush awaits pending delta appends')
    assert.equal(compactCalls, 0, 'autoCompact=false flush must not compact')
    assert.equal(nameCompactCalls, 0, 'autoCompact=false flush must not compact name index')
    assert.equal(fs.existsSync(snapshotPath), false, 'flush must not write a base')

    // autoCompact=true：显式 flush 仍然 compaction
    configurationValues.autoCompact = true
    await service.flush()
    assert.equal(compactCalls, 1, 'autoCompact=true flush compacts')
    assert.equal(nameCompactCalls, 1, 'autoCompact=true flush compacts name index')

    // autoCompact=false 但到达硬安全上限：仍要强制 compaction（overlay 无界会拖慢查询）
    configurationValues.autoCompact = false
    service.mutableValue = { pendingChanges: 5000 }
    await service.flush()
    assert.equal(compactCalls, 2, 'safety cap compacts even when autoCompact=false')

    // dispose 同样受 autoCompact 门控：未到上限时关闭后不再 compaction
    service.mutableValue = { pendingChanges: 1 }
    service.dispose()
    assert.equal(compactCalls, 2, 'dispose must not compact when autoCompact=false')
  } finally {
    configurationValues.autoCompact = previousAutoCompact
    service.mutableValue = undefined
    service.dispose()
    fs.rmSync(testDir, { recursive: true, force: true })
  }
}

/** 记录日志，供 service 级检查断言 warn 内容。 */
function capturingLogger() {
  const entries = []
  const logger = {
    entries,
    info: (message) => entries.push(['info', message]),
    warn: (message) => entries.push(['warn', message]),
    error: (message) => entries.push(['error', message]),
    show() {},
    dispose() {},
  }
  return logger
}

/**
 * 有界等待 delta 追加落盘。
 *
 * `updateFile` / `removeFile` 只把 append 排进 service 的 appendChain，快照 delta 的写入
 * 是异步的；直接读会偶发读到 0 条或半条记录（时序依赖）。这里轮询到谓词成立或超时失败，
 * 不改变任何生产逻辑。
 */
async function waitForDeltaRecords(deltaPath, readSnapshotDeltas, predicate, label) {
  const deadline = Date.now() + 2000
  let records = []
  for (;;) {
    records = await readSnapshotDeltas(deltaPath)
    if (predicate(records)) return records
    if (Date.now() >= deadline) {
      assert.fail(`${label}: timed out waiting for delta append (records=${records.length})`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/**
 * v5：service 构建/保存/重载后成员/枚举常量/全局变量的 kind 与 parent 不丢。
 * parent 缺失时 SymbolEntry 不应 materialize 出该属性（与快照/delta 契约一致）。
 */
function assertSavedParentSymbols(symbols, label) {
  const one = (name) => {
    const found = symbols.find((entry) => entry.name === name)
    assert.ok(found, `${label}: ${name} should be indexed`)
    return found
  }
  const member = one('a')
  assert.equal(member.kind, 'member', `${label}: member kind`)
  assert.equal(member.parent, 's', `${label}: member parent`)
  for (const name of ['E_A', 'E_B']) {
    const constant = one(name)
    assert.equal(constant.kind, 'enumConstant', `${label}: enum constant kind`)
    assert.equal(constant.parent, 'E', `${label}: enum constant parent`)
  }
  const global = one('g')
  assert.equal(global.kind, 'variable', `${label}: global kind`)
  assert.equal(global.parent, undefined, `${label}: global has no parent`)
  assert.equal(Object.hasOwn(global, 'parent'), false, `${label}: global must not materialize parent`)
}

/**
 * 临时 workspace + 独立 storage -> 建索引 -> 通过公开的 updateFile 保存一个改动
 * -> 断言 delta 落盘（含 hash/include/condition/parent 元数据）-> 不 compaction 直接重载（delta 重放）
 * -> flush（compaction）-> 重新 create service -> 符号/include/哈希/条件/parent 仍在。
 *
 * 这里也覆盖 Task 2 review 指出的时序风险：保存路径写的 delta v3 set 记录必须带
 * includes/哈希/条件/parent，否则「base + delta 重放」会清空 include 边或丢条件/parent。
 */
async function checkServiceRoundTrip() {
  const dist = path.join(EXT_ROOT, 'dist')
  const { SymbolService } = require(path.join(dist, 'src/vscode/service.js'))
  const { snapshotDeltaBytes, snapshotDeltaPath, readSnapshotDeltas } = require(
    path.join(dist, 'src/core/snapshot-delta.js'),
  )
  const { hashContent64 } = require(path.join(dist, 'src/core/hash.js'))

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-smoke-roundtrip-'))
  const workspace = path.join(dir, 'ws')
  const storage = path.join(dir, 'storage')
  fs.mkdirSync(workspace, { recursive: true })
  fs.mkdirSync(storage, { recursive: true })
  const sourceFile = path.join(workspace, 'a.c')
  fs.mkdirSync(path.join(workspace, 'inc'), { recursive: true })
  fs.writeFileSync(path.join(workspace, 'inc', 'x.h'), '#ifndef X_H\n#define X_H\nstruct sk_buff { int len; };\n#endif\n', 'utf8')
  fs.writeFileSync(path.join(workspace, 'inc', 'y.h'), '#ifndef Y_H\n#define Y_H\nstruct sock { int fd; };\n#endif\n', 'utf8')
  const initialText = '#include "inc/x.h"\nint alpha(void) { return 1; }\n'
  fs.writeFileSync(sourceFile, initialText, 'utf8')

  const previousFolders = vscode.workspace.workspaceFolders
  const previousRoots = configurationValues.indexRoots
  const previousAutoCompact = configurationValues.autoCompact
  vscode.workspace.workspaceFolders = [{ uri: Uri.file(workspace), name: 'roundtrip', index: 0 }]
  configurationValues.indexRoots = ['.']
  configurationValues.autoCompact = true

  const context = { storageUri: Uri.file(storage) }
  const snapshotPath = path.join(storage, 'symbols.sidx')
  const deltaPath = snapshotDeltaPath(snapshotPath)
  const logger = capturingLogger()
  let service
  let replayed
  let reloaded
  try {
    service = await SymbolService.create(context, logger)
    const summary = await service.rebuild()
    assert.ok(summary, 'service rebuild returns a summary')
    assert.equal(service.ready, true)
    assert.deepEqual(service.fileSymbols('a.c').map((e) => e.name), ['alpha'])
    // 构建路径（indexer: ScannedSymbol → SymbolEntry）也必须透传 v5 parent
    const builtHeaderSymbols = service.fileSymbols('inc/x.h')
    const builtMember = builtHeaderSymbols.find((entry) => entry.name === 'len')
    assert.ok(builtMember, 'build indexes struct members')
    assert.equal(builtMember.kind, 'member', 'build keeps member kind')
    assert.equal(builtMember.parent, 'sk_buff', 'build keeps member parent')
    // 构建路径也写 v4 元数据：include 边 + 内容哈希
    assert.deepEqual(service.snapshot.includedFiles('a.c'), ['inc/x.h'], 'build resolves include edges')
    assert.equal(service.snapshot.isReachable('a.c', 'inc/x.h'), true)
    assert.deepEqual(service.snapshot.contentHashOf('a.c'), hashContent64(initialText))
    assert.equal(await snapshotDeltaBytes(deltaPath), 0, 'fresh build has no delta')

    // 走真实的公开保存路径（文件监听器最终也是调用 updateFile）。
    // 保存后文件新增 include inc/y.h、v5 成员/枚举/全局与一个 #ifdef 符号：
    // 直接验证 applyIncludes/条件/哈希与 parent 透传。
    const savedText = [
      '#include "inc/x.h"',
      '#include "inc/y.h"',
      'struct s { int a; };',
      'typedef enum { E_A, E_B } E;',
      'int g;',
      'int beta(void) { return 2; }',
      '#ifdef RTK_MODULE',
      'int guarded(void) { return 3; }',
      '#endif',
      '',
    ].join('\n')
    fs.writeFileSync(sourceFile, savedText, 'utf8')
    const future = new Date(Date.now() + 1000)
    fs.utimesSync(sourceFile, future, future)
    await service.updateFile(sourceFile)

    const savedSymbols = service.fileSymbols('a.c')
    assert.deepEqual(savedSymbols.map((e) => e.name), ['s', 'a', 'E_A', 'E_B', 'E', 'g', 'beta', 'guarded'])
    assertSavedParentSymbols(savedSymbols, 'save overlay')
    assert.equal(savedSymbols.find((e) => e.name === 'guarded').condition, '#ifdef RTK_MODULE', 'condition in overlay')
    assert.deepEqual(service.snapshot.includedFiles('a.c'), ['inc/x.h', 'inc/y.h'], 'save applies overlay include edges')
    assert.equal(service.snapshot.isReachable('a.c', 'inc/y.h'), true)
    assert.deepEqual(service.snapshot.contentHashOf('a.c'), hashContent64(savedText), 'save records content hash')
    // delta 追加走 appendChain 异步排队：有界轮询到记录可读，去掉「读得太早」的时序依赖
    const records = await waitForDeltaRecords(
      deltaPath,
      readSnapshotDeltas,
      (list) => list.length >= 1 && list[0]?.path === 'a.c',
      'save delta append',
    )
    assert.equal(records.length, 1, 'one delta record for one save')
    assert.equal(records[0]?.kind, 'set')
    const savedEntries = records[0]?.entries ?? []
    assert.deepEqual(savedEntries.map((e) => e.name), ['s', 'a', 'E_A', 'E_B', 'E', 'g', 'beta', 'guarded'])
    assert.equal(savedEntries.find((e) => e.name === 'a')?.parent, 's', 'delta v3 carries member parent')
    assert.equal(savedEntries.find((e) => e.name === 'E_B')?.parent, 'E', 'delta v3 carries enum parent')
    assert.equal(savedEntries.find((e) => e.name === 'g')?.parent, undefined, 'delta v3 global has no parent')
    assert.deepEqual(records[0]?.includes, ['inc/x.h', 'inc/y.h'], 'delta v3 record carries include targets')
    assert.equal(records[0]?.contentHashLo, hashContent64(savedText).lo, 'delta v3 record carries hash lo')
    assert.equal(records[0]?.contentHashHi, hashContent64(savedText).hi, 'delta v3 record carries hash hi')

    // 时序风险：不 compaction 直接重载 = base + delta 重放。元数据必须全部从 v3 记录还原。
    replayed = await SymbolService.create(context, logger)
    assert.equal(replayed.ready, true, 'service loads base + delta')
    const replayedSymbols = replayed.fileSymbols('a.c')
    assert.deepEqual(replayedSymbols.map((e) => e.name), ['s', 'a', 'E_A', 'E_B', 'E', 'g', 'beta', 'guarded'], 'symbols survive delta replay')
    assertSavedParentSymbols(replayedSymbols, 'delta replay')
    assert.equal(replayedSymbols.find((e) => e.name === 'guarded').condition, '#ifdef RTK_MODULE', 'condition survives delta replay')
    assert.deepEqual(replayed.snapshot.includedFiles('a.c'), ['inc/x.h', 'inc/y.h'], 'include edges survive delta replay')
    assert.equal(replayed.snapshot.isReachable('a.c', 'inc/y.h'), true)
    assert.deepEqual(replayed.snapshot.contentHashOf('a.c'), hashContent64(savedText), 'hash survives delta replay')

    await service.flush()
    assert.equal(await snapshotDeltaBytes(deltaPath), 0, 'flush compacts the delta into the base')

    // 真实重载（base，无 delta）：符号/include/哈希/条件必须在重启后仍然存在。
    reloaded = await SymbolService.create(context, logger)
    assert.equal(reloaded.ready, true, 'reloaded service loads the snapshot')
    const reloadedSymbols = reloaded.fileSymbols('a.c')
    assert.deepEqual(reloadedSymbols.map((e) => e.name), ['s', 'a', 'E_A', 'E_B', 'E', 'g', 'beta', 'guarded'], 'symbols survive reload')
    assertSavedParentSymbols(reloadedSymbols, 'reload')
    assert.equal(reloadedSymbols.find((e) => e.name === 'guarded').condition, '#ifdef RTK_MODULE', 'condition survives compaction')
    assert.deepEqual(reloaded.snapshot.includedFiles('a.c'), ['inc/x.h', 'inc/y.h'], 'include edges survive compaction')
    assert.equal(reloaded.snapshot.isReachable('a.c', 'inc/y.h'), true)
    assert.deepEqual(reloaded.snapshot.contentHashOf('a.c'), hashContent64(savedText), 'hash survives compaction')
    assert.equal(reloaded.deltaWarning, undefined, 'clean delta has no recovery warning')

    // 坏 magic：整个 delta 不可解码 -> 提示用 corrupted 措辞；成功 compaction 后提示清除。
    fs.writeFileSync(deltaPath, Buffer.alloc(32, 0xab))
    const corrupted = await SymbolService.create(context, logger)
    try {
      assert.equal(corrupted.ready, true, 'base still loads with a corrupted delta')
      assert.ok(
        /ignored a corrupted snapshot delta/.test(corrupted.deltaWarning ?? ''),
        `corrupted whole-delta warning: ${corrupted.deltaWarning}`,
      )
      assert.ok(
        !/incomplete snapshot delta tail/.test(corrupted.deltaWarning ?? ''),
        'corrupted whole-file delta is not reported as a torn tail',
      )
      await corrupted.flush()
      assert.equal(corrupted.deltaWarning, undefined, 'successful compaction clears the recovery warning')
    } finally {
      corrupted.dispose()
    }
  } finally {
    try {
      service?.dispose()
      replayed?.dispose()
      reloaded?.dispose()
    } finally {
      vscode.workspace.workspaceFolders = previousFolders
      configurationValues.indexRoots = previousRoots
      configurationValues.autoCompact = previousAutoCompact
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

/**
 * 升级路径：本任务之前（2ffa868）写出的 v4 快照版本号仍是 v4，但文件记录没有哈希、
 * include CSR 为空、条目无条件。loadFromDisk 必须把它当作无效快照丢弃（警告 + 删 base
 * 和 delta），ensureBuilt 重建后元数据齐全；重建后的快照还能正常加载（不会反复重建）。
 */
async function checkLegacySnapshotUpgrade() {
  const dist = path.join(EXT_ROOT, 'dist')
  const { SymbolService } = require(path.join(dist, 'src/vscode/service.js'))
  const { snapshotDeltaPath, appendSnapshotDelta, snapshotDeltaBytes } = require(
    path.join(dist, 'src/core/snapshot-delta.js'),
  )
  const { encodeSnapshot } = require(path.join(dist, 'src/core/store.js'))
  const { createSymbolTable } = require(path.join(dist, 'src/core/symbol-table.js'))
  const { SNAPSHOT_VERSION } = require(path.join(dist, 'src/shared/types.js'))

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-smoke-legacy-v4-'))
  const workspace = path.join(dir, 'ws')
  const storage = path.join(dir, 'storage')
  fs.mkdirSync(path.join(workspace, 'inc'), { recursive: true })
  fs.mkdirSync(storage, { recursive: true })
  fs.writeFileSync(path.join(workspace, 'a.c'), '#include "inc/x.h"\nint alpha(void) { return 1; }\n', 'utf8')
  fs.writeFileSync(
    path.join(workspace, 'inc', 'x.h'),
    '#ifndef X_H\n#define X_H\nstruct sk_buff { int len; };\n#endif\n',
    'utf8',
  )

  const snapshotPath = path.join(storage, 'symbols.sidx')
  const deltaPath = snapshotDeltaPath(snapshotPath)
  const legacyFileRecord = (rel) => {
    const stat = fs.statSync(path.join(workspace, rel))
    return { path: rel, mtimeMs: stat.mtimeMs, size: stat.size } // 无 contentHashLo/Hi
  }
  const legacy = createSymbolTable(
    ['.'],
    ['a.c', 'inc/x.h'].map(legacyFileRecord),
    [
      { name: 'alpha', kind: 'function', file: 'a.c', line: 2, endLine: 2, column: 5 },
      { name: 'sk_buff', kind: 'struct', file: 'inc/x.h', line: 3, endLine: 3, column: 8 },
    ],
    1,
    SNAPSHOT_VERSION,
  )
  assert.equal(legacy.contentHashOf('a.c'), undefined, 'legacy fixture has no content hash')
  assert.deepEqual(legacy.includedFiles('a.c'), [], 'legacy fixture has no include edges')
  fs.writeFileSync(snapshotPath, encodeSnapshot(legacy))

  // 旧 delta 必须真的存在，否则下面「legacy delta deleted」断言是空的（fixture 从来没写过
  // delta，断言永远通过）。先写一条可解码的 v2 记录，再验证 loadFromDisk 会把它一起删掉。
  await appendSnapshotDelta(deltaPath, {
    kind: 'set',
    path: 'a.c',
    mtimeMs: 1,
    size: 2,
    entries: [{ name: 'alpha', kind: 'function', file: 'a.c', line: 2, endLine: 2, column: 5 }],
    includes: ['inc/x.h'],
  })
  assert.ok((await snapshotDeltaBytes(deltaPath)) > 0, 'legacy delta fixture is written')

  const previousFolders = vscode.workspace.workspaceFolders
  const previousRoots = configurationValues.indexRoots
  vscode.workspace.workspaceFolders = [{ uri: Uri.file(workspace), name: 'legacy', index: 0 }]
  configurationValues.indexRoots = ['.']
  const context = { storageUri: Uri.file(storage) }
  const logger = capturingLogger()
  let service
  let reloaded
  try {
    service = await SymbolService.create(context, logger)
    // 旧快照被丢弃：内存里没有（也绝不能有）没有边的表
    assert.equal(service.ready, false, 'legacy v4 snapshot is discarded on load')
    assert.equal(service.snapshot, undefined, 'no table without v4 metadata is accepted')
    assert.ok(
      logger.entries.some(
        ([level, message]) =>
          level === 'warn' && message === 'legacy v4 snapshot without v4 metadata; rebuilding',
      ),
      `legacy v4 warning logged: ${JSON.stringify(logger.entries)}`,
    )
    assert.equal(fs.existsSync(snapshotPath), false, 'legacy base deleted')
    assert.equal(fs.existsSync(deltaPath), false, 'legacy delta deleted')

    const summary = await service.ensureBuilt()
    assert.ok(summary, 'ensureBuilt rebuilds after a discarded legacy snapshot')
    assert.equal(service.ready, true, 'rebuild path entered')
    assert.deepEqual(service.snapshot.includedFiles('a.c'), ['inc/x.h'], 'rebuild produces include edges')
    assert.equal(service.snapshot.isReachable('a.c', 'inc/x.h'), true)
    assert.ok(service.snapshot.contentHashOf('a.c'), 'rebuild records content hashes')

    // 重建后的快照（带哈希）再次加载必须成功：证明该修复不会每次启动都重建
    reloaded = await SymbolService.create(context, logger)
    assert.equal(reloaded.ready, true, 'metadata-complete rebuilt snapshot reloads')
    assert.deepEqual(reloaded.snapshot.includedFiles('a.c'), ['inc/x.h'], 'reloaded snapshot keeps edges')
  } finally {
    try {
      service?.dispose()
      reloaded?.dispose()
    } finally {
      vscode.workspace.workspaceFolders = previousFolders
      configurationValues.indexRoots = previousRoots
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

/**
 * 保存路径的 include 权威语义与 removeFile 的缓存维护：
 *  - 保存后没有任何 include 时，delta v3 记录必须是显式 `[]`（不是缺省字段），
 *    「base + delta」重放与 compaction 后的 base 都必须清掉旧边；
 *  - removeFile 必须同时清 overlay 边与「索引内路径集合」缓存中的该文件。
 */
async function checkIncludeRemovalAndRemoveFile() {
  const dist = path.join(EXT_ROOT, 'dist')
  const { SymbolService } = require(path.join(dist, 'src/vscode/service.js'))
  const { readSnapshotDeltas, snapshotDeltaBytes, snapshotDeltaPath } = require(
    path.join(dist, 'src/core/snapshot-delta.js'),
  )
  const { hashContent64 } = require(path.join(dist, 'src/core/hash.js'))

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-smoke-include-removal-'))
  const workspace = path.join(dir, 'ws')
  const storage = path.join(dir, 'storage')
  fs.mkdirSync(path.join(workspace, 'inc'), { recursive: true })
  fs.mkdirSync(storage, { recursive: true })
  const sourceFile = path.join(workspace, 'a.c')
  fs.writeFileSync(path.join(workspace, 'inc', 'x.h'), '#ifndef X_H\n#define X_H\nint x(void);\n#endif\n', 'utf8')
  fs.writeFileSync(sourceFile, '#include "inc/x.h"\nint alpha(void) { return 1; }\n', 'utf8')

  const previousFolders = vscode.workspace.workspaceFolders
  const previousRoots = configurationValues.indexRoots
  vscode.workspace.workspaceFolders = [{ uri: Uri.file(workspace), name: 'removal', index: 0 }]
  configurationValues.indexRoots = ['.']

  const context = { storageUri: Uri.file(storage) }
  const snapshotPath = path.join(storage, 'symbols.sidx')
  const deltaPath = snapshotDeltaPath(snapshotPath)
  const logger = capturingLogger()
  let service
  let replayed
  let reloaded
  try {
    service = await SymbolService.create(context, logger)
    await service.rebuild()
    assert.deepEqual(service.snapshot.includedFiles('a.c'), ['inc/x.h'], 'build has include edges')

    // 保存为「没有任何 include」：overlay 边必须立刻清空，delta v3 记录必须是显式 []
    const noIncludeText = 'int beta(void) { return 2; }\n'
    fs.writeFileSync(sourceFile, noIncludeText, 'utf8')
    const future = new Date(Date.now() + 1000)
    fs.utimesSync(sourceFile, future, future)
    await service.updateFile(sourceFile)
    assert.deepEqual(service.snapshot.includedFiles('a.c'), [], 'save clears overlay include edges')
    const records = await waitForDeltaRecords(
      deltaPath,
      readSnapshotDeltas,
      (list) => list.length >= 1 && list[0]?.path === 'a.c',
      'include removal delta',
    )
    assert.equal(records.length, 1, 'one delta record for the include-removing save')
    assert.equal(records[0]?.kind, 'set')
    assert.deepEqual(records[0]?.includes, [], 'removing all includes writes explicit []')

    // 不 compaction 直接重载：base 里的旧边必须被空数组（权威值）覆盖
    replayed = await SymbolService.create(context, logger)
    assert.equal(replayed.ready, true)
    assert.deepEqual(replayed.snapshot.includedFiles('a.c'), [], 'explicit [] clears base edges on replay')
    assert.equal(replayed.snapshot.isReachable('a.c', 'inc/x.h'), false)
    assert.deepEqual(replayed.snapshot.contentHashOf('a.c'), hashContent64(noIncludeText))

    // compaction 后再重载：base 里的旧边已消失
    await service.flush()
    assert.equal(await snapshotDeltaBytes(deltaPath), 0, 'flush compacts the include-removal delta')
    reloaded = await SymbolService.create(context, logger)
    assert.equal(reloaded.ready, true)
    assert.deepEqual(reloaded.snapshot.includedFiles('a.c'), [], 'cleared include edges survive reload')
    assert.equal(reloaded.snapshot.isReachable('a.c', 'inc/x.h'), false)

    // removeFile：缓存路径集合与 overlay 边一并清理
    const withIncludeAgain = '#include "inc/x.h"\nint gamma(void) { return 3; }\n'
    fs.writeFileSync(sourceFile, withIncludeAgain, 'utf8')
    const later = new Date(Date.now() + 3000)
    fs.utimesSync(sourceFile, later, later)
    await reloaded.updateFile(sourceFile)
    assert.ok(reloaded.indexedPathsCache, 'include save materializes the indexed path cache')
    assert.equal(reloaded.indexedPathsCache.paths.has('a.c'), true)
    assert.deepEqual(reloaded.snapshot.includedFiles('a.c'), ['inc/x.h'])
    await reloaded.removeFile(sourceFile)
    assert.equal(reloaded.indexedPathsCache.paths.has('a.c'), false, 'removeFile drops cached path')
    assert.deepEqual(reloaded.snapshot.includedFiles('a.c'), [], 'removeFile drops cached include edges')
    assert.deepEqual(reloaded.fileSymbols('a.c'), [])
  } finally {
    try {
      service?.dispose()
      replayed?.dispose()
      reloaded?.dispose()
    } finally {
      vscode.workspace.workspaceFolders = previousFolders
      configurationValues.indexRoots = previousRoots
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

/**
 * 多窗口共享 storage 的冲突路径：另一个进程在我们加载后追加 delta，
 * 本进程 compaction / rebuild 都不得删除对方的记录（base 保持不动、delta 保留）。
 */
async function checkDeltaConflict() {
  const dist = path.join(EXT_ROOT, 'dist')
  const { SymbolService } = require(path.join(dist, 'src/vscode/service.js'))
  const { appendSnapshotDelta, readSnapshotDeltas, snapshotDeltaBytes, snapshotDeltaPath } = require(
    path.join(dist, 'src/core/snapshot-delta.js'),
  )

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-smoke-delta-conflict-'))
  const workspace = path.join(dir, 'ws')
  const storage = path.join(dir, 'storage')
  fs.mkdirSync(workspace, { recursive: true })
  fs.mkdirSync(storage, { recursive: true })
  const sourceFile = path.join(workspace, 'a.c')
  fs.writeFileSync(sourceFile, 'int alpha(void) { return 1; }\n', 'utf8')

  const previousFolders = vscode.workspace.workspaceFolders
  const previousRoots = configurationValues.indexRoots
  const previousAutoCompact = configurationValues.autoCompact
  vscode.workspace.workspaceFolders = [{ uri: Uri.file(workspace), name: 'conflict', index: 0 }]
  configurationValues.indexRoots = ['.']
  configurationValues.autoCompact = true

  const context = { storageUri: Uri.file(storage) }
  const snapshotPath = path.join(storage, 'symbols.sidx')
  const deltaPath = snapshotDeltaPath(snapshotPath)
  const logger = capturingLogger()
  let service
  try {
    service = await SymbolService.create(context, logger)
    await service.rebuild()
    const baseBefore = fs.statSync(snapshotPath)

    // 模拟另一个窗口（同一 workspace 的另一个扩展宿主）在我们加载后追加一条记录。
    await appendSnapshotDelta(deltaPath, {
      kind: 'set',
      path: 'other.c',
      mtimeMs: 1,
      size: 2,
      entries: [{ name: 'other', kind: 'function', file: 'other.c', line: 0, endLine: 1, column: 0 }],
    })
    assert.ok((await snapshotDeltaBytes(deltaPath)) > 0)

    // 本进程自己的保存（走公开 updateFile），之后 flush 想 compaction。
    fs.writeFileSync(sourceFile, 'int gamma(void) { return 3; }\n', 'utf8')
    const future = new Date(Date.now() + 1000)
    fs.utimesSync(sourceFile, future, future)
    await service.updateFile(sourceFile)
    await service.flush()

    const baseAfterFlush = fs.statSync(snapshotPath)
    assert.equal(baseAfterFlush.size, baseBefore.size, 'conflict aborts compaction: base size unchanged')
    assert.equal(baseAfterFlush.mtimeMs, baseBefore.mtimeMs, 'conflict aborts compaction: base not rewritten')
    const recordsAfterFlush = await readSnapshotDeltas(deltaPath)
    assert.ok(recordsAfterFlush.length >= 2, 'foreign and local delta records are kept')
    assert.ok(
      recordsAfterFlush.some((record) => record.path === 'other.c'),
      'other window record is still on disk',
    )
    assert.ok(
      logger.entries.some(
        ([level, message]) =>
          level === 'warn' &&
          /another (window|process)/.test(message) &&
          /(compaction|records)/.test(message),
      ),
      'conflict is logged',
    )

    // rebuild 成功同样不能删掉对方的 delta（新 base 更新，但对方记录必须保留）。
    await service.rebuild()
    assert.ok(
      (await snapshotDeltaBytes(deltaPath)) > 0,
      'rebuild keeps a delta written by another window',
    )
    assert.ok(
      (await readSnapshotDeltas(deltaPath)).some((record) => record.path === 'other.c'),
      'other window record survives rebuild',
    )
  } finally {
    try {
      service?.dispose()
    } finally {
      vscode.workspace.workspaceFolders = previousFolders
      configurationValues.indexRoots = previousRoots
      configurationValues.autoCompact = previousAutoCompact
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

/**
 * si.showDefinitionCandidates（B1/B2/B4）：
 *  - 组 label 在 vscode 层用 l10n 组装（included/not included / N copies / 条件）；
 *  - 多副本组选中后弹二级 QuickPick 选具体副本，再 openLocation；
 *  - 单副本组直接打开，不弹二级；
 *  - 无定义时不弹 QuickPick，只显示信息提示。
 *
 * 用 dist 的 createSymbolTable 构造确定性快照（include 边 + 内容哈希 + #ifdef 条件），
 * 再用假的 service 调用真实的 registerCommands 处理器：不依赖扩展激活期间的索引状态。
 */
async function checkDefinitionCandidatesCommand() {
  const dist = path.join(EXT_ROOT, 'dist')
  const { registerCommands } = require(path.join(dist, 'src/vscode/commands.js'))
  const { createSymbolTable } = require(path.join(dist, 'src/core/symbol-table.js'))
  const { SNAPSHOT_VERSION } = require(path.join(dist, 'src/shared/types.js'))

  const workspaceRoot = EXT_ROOT
  const sourceFile = 'src/main.c'
  const a = { name: 'sk_buff', kind: 'struct', file: 'vendor/a/include/skbuff.h', line: 10, endLine: 10, column: 0 }
  const b = { name: 'sk_buff', kind: 'struct', file: 'vendor/b/include/skbuff.h', line: 20, endLine: 20, column: 0 }
  const c = {
    name: 'sk_buff',
    kind: 'struct',
    file: 'vendor/c/include/skbuff.h',
    line: 30,
    endLine: 30,
    column: 0,
    condition: '#ifdef RTK_MODULE',
  }
  const fileRecord = (rel, hash) => ({
    path: rel,
    mtimeMs: 0,
    size: 0,
    contentHashLo: hash.lo,
    contentHashHi: hash.hi,
  })
  const table = createSymbolTable(
    ['.'],
    [
      fileRecord(sourceFile, { lo: 1, hi: 1 }),
      fileRecord(a.file, { lo: 11, hi: 22 }),
      fileRecord(b.file, { lo: 11, hi: 22 }),
      fileRecord(c.file, { lo: 33, hi: 44 }),
    ],
    [a, b, c],
    1,
    SNAPSHOT_VERSION,
    { includes: new Map([[sourceFile, [a.file]]]) },
  )

  const definitions = [a, b, c]
  const service = {
    configuredRoots: ['.'],
    snapshot: table,
    workspaceRoot,
    definitions: (name) => definitions.filter((entry) => entry.name === name),
    signature: async () => undefined,
    toRelative: (absPath) => path.relative(workspaceRoot, absPath).split(path.sep).join('/'),
    toAbsolute: (relPath) => path.join(workspaceRoot, relPath),
  }

  const document = new TextDocument(
    Uri.file(path.join(workspaceRoot, sourceFile)),
    'struct sk_buff *skb;\n',
  )
  const previousEditor = vscode.window.activeTextEditor
  vscode.window.activeTextEditor = { document, selection: { active: new Position(0, 10) } }
  const quickPickBaseline = registrations.quickPicks.length
  const openedBaseline = registrations.openedDocuments.length
  const infoBaseline = registrations.informationMessages.length
  const commands = registerCommands(undefined, service)
  try {
    const handler = [...registrations.commands]
      .reverse()
      .find(([id]) => id === 'si.showDefinitionCandidates')[1]

    // 多副本组：第一级选组 -> 二级选副本 -> 打开副本位置
    registrations.quickPickResponses.push(
      (items) => items.find((item) => item.label.includes('included') && item.label.includes('2 copies')),
      (items) => items[1],
    )
    await handler()
    assert.equal(
      registrations.quickPicks.length - quickPickBaseline,
      2,
      'multi-copy group opens exactly two QuickPicks',
    )
    const groupCall = registrations.quickPicks[quickPickBaseline]
    const copyCall = registrations.quickPicks[quickPickBaseline + 1]
    const labels = groupCall.items.map((item) => item.label)
    assert.ok(
      labels.some((label) => label.includes('included') && label.includes('2 copies')),
      `group label carries included + copies: ${JSON.stringify(labels)}`,
    )
    assert.ok(
      labels.some((label) => label.includes('#ifdef RTK_MODULE')),
      `conditional group label: ${JSON.stringify(labels)}`,
    )
    const multiGroup = groupCall.items.find((item) => item.label.includes('2 copies'))
    assert.equal(
      multiGroup.description,
      'vendor/a/include/skbuff.h:11',
      'group description is the representative file:line (1-based)',
    )
    assert.equal(multiGroup.detail, 'Struct', 'group detail is the symbol kind')
    assert.deepEqual(
      copyCall.items.map((item) => item.label),
      ['vendor/a/include/skbuff.h:11', 'vendor/b/include/skbuff.h:21'],
      'copy list is file:line for every copy',
    )
    assert.deepEqual(
      registrations.openedDocuments.slice(openedBaseline).map((doc) => doc.uri.fsPath),
      [path.join(workspaceRoot, b.file)],
      'picking a copy opens that copy',
    )

    // 单副本组：选中后直接打开，不再弹二级列表
    const openedAfterMulti = registrations.openedDocuments.length
    const quickPicksBeforeSingle = registrations.quickPicks.length
    registrations.quickPickResponses.push(
      (items) => items.find((item) => item.label.includes('#ifdef RTK_MODULE')),
    )
    await handler()
    assert.equal(
      registrations.quickPicks.length - quickPicksBeforeSingle,
      1,
      'single-copy group opens no second QuickPick',
    )
    assert.deepEqual(
      registrations.openedDocuments.slice(openedAfterMulti).map((doc) => doc.uri.fsPath),
      [path.join(workspaceRoot, c.file)],
      'single-copy group opens the representative',
    )

    // F12 Provider：同一个内容哈希组只出一个代表 Location，顺序 = 分组/排名顺序
    const { registerDefinitionProvider } = require(
      path.join(dist, 'src/vscode/providers/definition.js'),
    )
    const definitionProviderDisposable = registerDefinitionProvider(service)
    try {
      const definitionProvider = registrations.providers
        .filter(([kind]) => kind === 'definition')
        .pop()[2]
      const locations = await definitionProvider.provideDefinition(
        document,
        new Position(0, 10),
        { isCancellationRequested: false },
      )
      assert.ok(Array.isArray(locations), 'definition provider returns locations')
      assert.deepEqual(
        locations.map((location) => location.uri.fsPath),
        [path.join(workspaceRoot, a.file), path.join(workspaceRoot, c.file)],
        'F12 returns one Location per content group, in group order',
      )
    } finally {
      definitionProviderDisposable.dispose()
    }

    // Hover：签名后追加分组说明（included/not included、N copies、conditional）
    const { registerHoverProvider } = require(path.join(dist, 'src/vscode/providers/hover.js'))
    const hoverProviderDisposable = registerHoverProvider(service)
    try {
      const hoverProvider = registrations.providers
        .filter(([kind]) => kind === 'hover')
        .pop()[2]
      const hover = await hoverProvider.provideHover(document, new Position(0, 10), {
        isCancellationRequested: false,
      })
      assert.ok(hover, 'hover provider returns a Hover')
      const markdown = hover.contents[0].value
      assert.match(markdown, /included by this file/, 'hover marks the group as included')
      assert.match(markdown, /2 identical copies/, 'hover reports identical copies')
    } finally {
      hoverProviderDisposable.dispose()
    }

    // 条件分支：只返回条件组时 hover 标注 not included + conditional: #ifdef
    const conditionalService = { ...service, definitions: () => [c] }
    const conditionalHoverDisposable = registerHoverProvider(conditionalService)
    try {
      const hoverProvider = registrations.providers
        .filter(([kind]) => kind === 'hover')
        .pop()[2]
      const hover = await hoverProvider.provideHover(document, new Position(0, 10), {
        isCancellationRequested: false,
      })
      assert.ok(hover, 'conditional hover returns a Hover')
      const markdown = hover.contents[0].value
      assert.match(markdown, /not included/, 'hover marks a non-included group')
      assert.match(markdown, /conditional: #ifdef RTK_MODULE/, 'hover shows the condition text')
    } finally {
      conditionalHoverDisposable.dispose()
    }

    // 同文件定义：inclusion 不能写「included by this file」，应为「in this file」
    const sameFileEntry = {
      name: 'sk_buff',
      kind: 'function',
      file: sourceFile,
      line: 5,
      endLine: 5,
      column: 0,
    }
    const sameFileService = { ...service, definitions: () => [sameFileEntry] }
    const sameFileHoverDisposable = registerHoverProvider(sameFileService)
    try {
      const hoverProvider = registrations.providers
        .filter(([kind]) => kind === 'hover')
        .pop()[2]
      const hover = await hoverProvider.provideHover(document, new Position(0, 10), {
        isCancellationRequested: false,
      })
      assert.ok(hover, 'same-file hover returns a Hover')
      const markdown = hover.contents[0].value
      assert.doesNotMatch(
        markdown,
        /included by this file/,
        'same-file definition is not described as included by itself',
      )
      assert.match(markdown, /in this file/, 'same-file definition says it lives in this file')
    } finally {
      sameFileHoverDisposable.dispose()
    }

    // si.gotoDefinition：与 F12 相同的分组上下文，多组时一组一行，多副本组走二级选择
    const gotoHandler = [...registrations.commands]
      .reverse()
      .find(([id]) => id === 'si.gotoDefinition')[1]
    const gotoQuickPicksBefore = registrations.quickPicks.length
    const gotoOpenedBefore = registrations.openedDocuments.length
    registrations.quickPickResponses.push(
      (items) => items.find((item) => item.label.includes('2 copies')),
      (items) => items[1],
    )
    await gotoHandler()
    assert.equal(
      registrations.quickPicks.length - gotoQuickPicksBefore,
      2,
      'gotoDefinition opens group + copy QuickPicks for a multi-copy group',
    )
    const gotoGroupCall = registrations.quickPicks[gotoQuickPicksBefore]
    assert.equal(
      gotoGroupCall.items.length,
      2,
      'gotoDefinition shows one entry per content group (2 groups)',
    )
    const gotoMultiGroup = gotoGroupCall.items.find((item) => item.label.includes('2 copies'))
    assert.ok(gotoMultiGroup, 'gotoDefinition group label marks identical copies')
    assert.equal(
      gotoMultiGroup.description,
      'vendor/a/include/skbuff.h:11',
      'gotoDefinition group description is representative file:line',
    )
    assert.equal(gotoMultiGroup.detail, 'Struct', 'gotoDefinition group detail is the kind')
    assert.deepEqual(
      registrations.openedDocuments.slice(gotoOpenedBefore).map((doc) => doc.uri.fsPath),
      [path.join(workspaceRoot, b.file)],
      'gotoDefinition copy sub-picker opens the picked copy',
    )

    // 单组：直接打开代表位置，不弹组选择
    const gotoSingleService = { ...service, definitions: () => [a] }
    const gotoSingleCommands = registerCommands(undefined, gotoSingleService)
    try {
      const gotoSingleHandler = [...registrations.commands]
        .reverse()
        .find(([id]) => id === 'si.gotoDefinition')[1]
      const quickPicksBeforeSingle = registrations.quickPicks.length
      const openedBeforeSingle = registrations.openedDocuments.length
      await gotoSingleHandler()
      assert.equal(
        registrations.quickPicks.length,
        quickPicksBeforeSingle,
        'gotoDefinition single group opens directly, no QuickPick',
      )
      assert.deepEqual(
        registrations.openedDocuments.slice(openedBeforeSingle).map((doc) => doc.uri.fsPath),
        [path.join(workspaceRoot, a.file)],
        'gotoDefinition single group opens the representative',
      )
    } finally {
      gotoSingleCommands.dispose()
    }

    // 单组多副本：必须弹副本选择（与 CHANGELOG 一致），不能直接跳到代表副本
    const gotoCopyService = { ...service, definitions: () => [a, b] }
    const gotoCopyCommands = registerCommands(undefined, gotoCopyService)
    try {
      const gotoCopyHandler = [...registrations.commands]
        .reverse()
        .find(([id]) => id === 'si.gotoDefinition')[1]
      const quickPicksBeforeCopy = registrations.quickPicks.length
      const openedBeforeCopy = registrations.openedDocuments.length
      registrations.quickPickResponses.push((items) => items[1])
      await gotoCopyHandler()
      assert.equal(
        registrations.quickPicks.length - quickPicksBeforeCopy,
        1,
        'gotoDefinition single multi-copy group opens exactly the copy picker',
      )
      const copyCall = registrations.quickPicks[quickPicksBeforeCopy]
      assert.deepEqual(
        copyCall.items.map((item) => item.label),
        ['vendor/a/include/skbuff.h:11', 'vendor/b/include/skbuff.h:21'],
        'single-group copy picker lists every identical copy',
      )
      assert.deepEqual(
        registrations.openedDocuments.slice(openedBeforeCopy).map((doc) => doc.uri.fsPath),
        [path.join(workspaceRoot, b.file)],
        'single multi-copy group opens the picked copy, not the representative',
      )
    } finally {
      gotoCopyCommands.dispose()
    }

    // 无定义：保持信息提示，不弹 QuickPick
    const gotoNoneService = { ...service, definitions: () => [] }
    const gotoNoneCommands = registerCommands(undefined, gotoNoneService)
    try {
      const gotoNoneHandler = [...registrations.commands]
        .reverse()
        .find(([id]) => id === 'si.gotoDefinition')[1]
      const quickPicksBeforeNone = registrations.quickPicks.length
      const infoBeforeNone = registrations.informationMessages.length
      await gotoNoneHandler()
      assert.equal(
        registrations.quickPicks.length,
        quickPicksBeforeNone,
        'gotoDefinition no definitions opens no QuickPick',
      )
      assert.ok(
        registrations.informationMessages
          .slice(infoBeforeNone)
          .some((message) => /No definition found/.test(message)),
        'gotoDefinition no definitions shows an information message',
      )
    } finally {
      gotoNoneCommands.dispose()
    }

    // zh-cn 标签：组 label 用 l10n 组装，显示 包含/未包含/副本/条件
    const zhBundle = JSON.parse(
      fs.readFileSync(path.join(EXT_ROOT, 'l10n/bundle.l10n.zh-cn.json'), 'utf8'),
    )
    const originalTranslate = vscode.l10n.t
    vscode.l10n.t = (message, ...args) => {
      const template = zhBundle[message] ?? message
      return args.length
        ? template.replace(/\{(\d+)\}/g, (_, n) => String(args[Number(n)] ?? ''))
        : template
    }
    try {
      const zhBaseline = registrations.quickPicks.length
      registrations.quickPickResponses.push(
        (items) => items.find((item) => item.label.includes('2 份副本')),
        (items) => items[0],
      )
      await handler()
      const zhLabels = registrations.quickPicks[zhBaseline].items.map((item) => item.label)
      assert.ok(
        zhLabels.some((label) => label.includes('包含') && label.includes('2 份副本')),
        `zh group label shows 包含 + 副本: ${JSON.stringify(zhLabels)}`,
      )
      assert.ok(
        zhLabels.some(
          (label) => label.includes('未包含') && label.includes('条件编译：#ifdef RTK_MODULE'),
        ),
        `zh conditional label shows 未包含 + 条件: ${JSON.stringify(zhLabels)}`,
      )
    } finally {
      vscode.l10n.t = originalTranslate
      registrations.quickPickResponses.length = 0
    }

    // 无定义：不弹 QuickPick，给信息提示（不抛异常）
    const noDefinitionService = { ...service, definitions: () => [] }
    const noDefinitionCommands = registerCommands(undefined, noDefinitionService)
    try {
      const quickPicksBeforeNone = registrations.quickPicks.length
      const noDefinitionHandler = [...registrations.commands]
        .reverse()
        .find(([id]) => id === 'si.showDefinitionCandidates')[1]
      await noDefinitionHandler()
      assert.equal(
        registrations.quickPicks.length,
        quickPicksBeforeNone,
        'no definitions opens no QuickPick',
      )
      assert.ok(
        registrations.informationMessages
          .slice(infoBaseline)
          .some((message) => /No definition found/.test(message)),
        'no definitions shows an information message',
      )
    } finally {
      noDefinitionCommands.dispose()
    }
  } finally {
    commands.dispose()
    vscode.window.activeTextEditor = previousEditor
    registrations.quickPickResponses.length = 0
  }
}

/**
 * 列表注记（设计 §3.6）：
 *  - si.searchSymbol / si.showCallers / si.showCallees 的 QuickPick detail 在既有文本后追加
 *    `included` / `not included`，条件条目再追加 `conditional: <条件>`；
 *  - 无活动编辑器时省略 inclusion（只保留条件注记）；
 *  - 共享纯 helper 用 zh-cn bundle 文本验证注记组合。
 */
async function checkListAnnotations() {
  const dist = path.join(EXT_ROOT, 'dist')
  const { registerCommands } = require(path.join(dist, 'src/vscode/commands.js'))
  const { createSymbolTable } = require(path.join(dist, 'src/core/symbol-table.js'))
  const { SNAPSHOT_VERSION } = require(path.join(dist, 'src/shared/types.js'))
  const { includedFor, listAnnotationParts } = require(
    path.join(dist, 'src/vscode/list-annotations.js'),
  )

  const workspaceRoot = EXT_ROOT
  const sourceFile = 'src/main.c'
  const headerFile = 'inc/a.h'
  const otherFile = 'drv/b.c'
  const makeEntry = (name, file, line, condition) => {
    const base = { name, kind: 'function', file, line, endLine: line, column: 0 }
    return condition ? { ...base, condition } : base
  }
  const includedFn = makeEntry('included_fn', headerFile, 5)
  const ordinaryFn = makeEntry('ordinary_fn', otherFile, 7)
  const conditionalFn = makeEntry('conditional_fn', headerFile, 9, '#ifdef RTK_MODULE')
  const table = createSymbolTable(
    ['.'],
    [sourceFile, headerFile, otherFile].map((file) => ({ path: file, mtimeMs: 0, size: 0 })),
    [includedFn, ordinaryFn, conditionalFn],
    1,
    SNAPSHOT_VERSION,
    { includes: new Map([[sourceFile, [headerFile]]]) },
  )
  const service = {
    configuredRoots: ['.'],
    snapshot: table,
    workspaceRoot,
    definitions: () => [],
    search: () => [includedFn, ordinaryFn, conditionalFn],
    callers: async () => [
      {
        file: headerFile,
        line: 20,
        column: 0,
        preview: 'call_cond();',
        from: makeEntry('caller_fn', headerFile, 15, '#ifdef RTK_MODULE'),
      },
      {
        file: otherFile,
        line: 30,
        column: 0,
        preview: 'call_plain();',
        from: undefined,
      },
    ],
    callees: async () => [includedFn, conditionalFn],
    signature: async () => undefined,
    toRelative: (absPath) => path.relative(workspaceRoot, absPath).split(path.sep).join('/'),
    toAbsolute: (relPath) => path.join(workspaceRoot, relPath),
  }

  // 共享纯 helper：inclusion 判定 + 注记组合（zh-cn bundle 文本）
  const zhBundle = JSON.parse(
    fs.readFileSync(path.join(EXT_ROOT, 'l10n/bundle.l10n.zh-cn.json'), 'utf8'),
  )
  const zhText = {
    included: zhBundle['included'],
    notIncluded: zhBundle['not included'],
    conditional: zhBundle['conditional: {0}'],
  }
  assert.equal(includedFor(table, sourceFile, headerFile), true, 'included header is reachable')
  assert.equal(includedFor(table, sourceFile, otherFile), false, 'unrelated file is not reachable')
  assert.equal(includedFor(undefined, sourceFile, headerFile), undefined, 'no table omits inclusion')
  assert.equal(includedFor(table, undefined, headerFile), undefined, 'no source file omits inclusion')
  assert.deepEqual(listAnnotationParts(true, undefined, zhText), ['包含'])
  assert.deepEqual(listAnnotationParts(false, undefined, zhText), ['未包含'])
  assert.deepEqual(
    listAnnotationParts(false, '#ifdef RTK_MODULE', zhText),
    ['未包含', '条件编译：#ifdef RTK_MODULE'],
  )
  assert.deepEqual(listAnnotationParts(undefined, '#ifdef X', zhText), ['条件编译：#ifdef X'])
  assert.deepEqual(listAnnotationParts(undefined, undefined, zhText), [])

  const document = new TextDocument(
    Uri.file(path.join(workspaceRoot, sourceFile)),
    'included_fn();\n',
  )
  const previousEditor = vscode.window.activeTextEditor
  const customBaseline = registrations.customQuickPicks.length
  const commands = registerCommands(undefined, service)
  try {
    vscode.window.activeTextEditor = { document, selection: { active: new Position(0, 2) } }

    // si.searchSymbol：输入后 items.detail = kind + inclusion + conditional
    const searchHandler = [...registrations.commands]
      .reverse()
      .find(([id]) => id === 'si.searchSymbol')[1]
    const searchPending = searchHandler()
    const searchPick = registrations.customQuickPicks[customBaseline]
    assert.ok(searchPick, 'searchSymbol creates an editable QuickPick')
    searchPick._onChange('fn')
    await new Promise((resolve) => setTimeout(resolve, 180))
    assert.deepEqual(
      searchPick.items.map((item) => item.label),
      ['included_fn', 'ordinary_fn', 'conditional_fn'],
      'searchSymbol keeps candidate order',
    )
    assert.deepEqual(
      searchPick.items.map((item) => item.detail),
      [
        'Function · included',
        'Function · not included',
        'Function · included · conditional: #ifdef RTK_MODULE',
      ],
      'searchSymbol details append inclusion + conditional',
    )
    searchPick.selectedItems = [searchPick.items[0]]
    searchPick._onAccept()
    await searchPending

    // si.showCallers：detail = preview + inclusion + conditional（from.condition）
    const callerHandler = [...registrations.commands]
      .reverse()
      .find(([id]) => id === 'si.showCallers')[1]
    const callerBaseline = registrations.quickPicks.length
    await callerHandler()
    assert.deepEqual(
      registrations.quickPicks[callerBaseline].items.map((item) => item.detail),
      [
        'call_cond(); · included · conditional: #ifdef RTK_MODULE',
        'call_plain(); · not included',
      ],
      'showCallers details append inclusion + conditional',
    )

    // si.showCallees：detail = kind + inclusion + conditional（entry.condition）
    const calleeHandler = [...registrations.commands]
      .reverse()
      .find(([id]) => id === 'si.showCallees')[1]
    const calleeBaseline = registrations.quickPicks.length
    await calleeHandler()
    assert.deepEqual(
      registrations.quickPicks[calleeBaseline].items.map((item) => item.detail),
      [
        'Function · included',
        'Function · included · conditional: #ifdef RTK_MODULE',
      ],
      'showCallees details append inclusion + conditional',
    )

    // 无活动编辑器：省略 inclusion，只保留条件注记
    vscode.window.activeTextEditor = undefined
    const noEditorPending = searchHandler()
    const noEditorPick = registrations.customQuickPicks[registrations.customQuickPicks.length - 1]
    noEditorPick._onChange('fn')
    await new Promise((resolve) => setTimeout(resolve, 180))
    assert.deepEqual(
      noEditorPick.items.map((item) => item.detail),
      ['Function', 'Function', 'Function · conditional: #ifdef RTK_MODULE'],
      'no active editor omits inclusion but keeps conditional',
    )
    noEditorPick.selectedItems = [noEditorPick.items[0]]
    noEditorPick._onAccept()
    await noEditorPending
  } finally {
    commands.dispose()
    vscode.window.activeTextEditor = previousEditor
    registrations.quickPickResponses.length = 0
  }
}

/**
 * I1：调用层次必须与 F12/悬停共享同一份 include 感知排序。用真实的 call-hierarchy
 * provider 验证「被当前文件包含、但路径更远」的定义排在「更近但未被包含」的定义之前。
 * provider 漏传 `table` 时 include 键不参与，closer 会排到前面，因此这条断言能抓住回归。
 */
async function checkCallHierarchyIncludeAware() {
  const dist = path.join(EXT_ROOT, 'dist')
  const { registerCallHierarchyProvider } = require(
    path.join(dist, 'src/vscode/providers/call-hierarchy.js'),
  )
  const { createSymbolTable } = require(path.join(dist, 'src/core/symbol-table.js'))
  const { SNAPSHOT_VERSION } = require(path.join(dist, 'src/shared/types.js'))

  const workspaceRoot = EXT_ROOT
  const sourceFile = 'src/main.c'
  const included = {
    name: 'sk_buff',
    kind: 'struct',
    file: 'vendor/a/include/skbuff.h',
    line: 10,
    endLine: 10,
    column: 0,
  }
  const closer = {
    name: 'sk_buff',
    kind: 'struct',
    file: 'src/skbuff.h',
    line: 3,
    endLine: 3,
    column: 0,
  }
  const table = createSymbolTable(
    ['.'],
    [sourceFile, included.file, closer.file].map((file) => ({ path: file, mtimeMs: 0, size: 0 })),
    [included, closer],
    1,
    SNAPSHOT_VERSION,
    { includes: new Map([[sourceFile, [included.file]]]) },
  )
  const service = {
    configuredRoots: ['.'],
    snapshot: table,
    // 故意把「更近但未被包含」的定义放在前面：只有 include 表参与时它才会被压后
    definitions: () => [closer, included],
    toRelative: (absPath) => path.relative(workspaceRoot, absPath).split(path.sep).join('/'),
    toAbsolute: (relPath) => path.join(workspaceRoot, relPath),
  }
  const document = new TextDocument(
    Uri.file(path.join(workspaceRoot, sourceFile)),
    'struct sk_buff *skb;\n',
  )
  const disposable = registerCallHierarchyProvider(service)
  try {
    const provider = registrations.providers
      .filter(([kind]) => kind === 'callHierarchy')
      .pop()[2]
    const items = await provider.prepareCallHierarchy(document, new Position(0, 10), {
      isCancellationRequested: false,
    })
    assert.ok(Array.isArray(items) && items.length === 2, 'call hierarchy returns both items')
    assert.deepEqual(
      items.map((item) => item.detail),
      [included.file, closer.file],
      'call hierarchy orders an included definition before a closer-but-not-included one',
    )
  } finally {
    disposable.dispose()
  }
}

/**
 * B3 Task 4（字段跳转 / 大纲嵌套 / 悬停归属 / @kind 搜索）：
 * 用真实 provider + 真实 createSymbolTable（+ 真实 searchSymbols）验证 v5 新符号的 UI 行为。
 * fake service 只提供查询入口（definitions/fileSymbols/search/snapshot/路径换算），
 * 这样断言覆盖的是编译产物里的真实逻辑，而不是测试内自造的排序。
 */
async function checkMemberSymbolUi() {
  const dist = path.join(EXT_ROOT, 'dist')
  const { registerCommands } = require(path.join(dist, 'src/vscode/commands.js'))
  const { registerDefinitionProvider } = require(
    path.join(dist, 'src/vscode/providers/definition.js'),
  )
  const { registerDocumentSymbolProvider } = require(
    path.join(dist, 'src/vscode/providers/document-symbol.js'),
  )
  const { registerHoverProvider } = require(path.join(dist, 'src/vscode/providers/hover.js'))
  const { createSymbolTable } = require(path.join(dist, 'src/core/symbol-table.js'))
  const { searchSymbols } = require(path.join(dist, 'src/core/query.js'))
  const { SNAPSHOT_VERSION } = require(path.join(dist, 'src/shared/types.js'))
  const { kindLabel, memberPhrase } = require(path.join(dist, 'src/vscode/util.js'))

  const workspaceRoot = EXT_ROOT
  const sourceFile = 'src/main.c'
  const headerFile = 'inc/skbuff.h'
  const entries = [
    { name: 'sk_buff', kind: 'struct', file: headerFile, line: 0, endLine: 3, column: 7 },
    { name: 'len', kind: 'member', file: headerFile, line: 1, endLine: 1, column: 6, parent: 'sk_buff' },
    { name: 'data', kind: 'member', file: headerFile, line: 2, endLine: 2, column: 7, parent: 'sk_buff' },
    { name: 'E', kind: 'enum', file: headerFile, line: 4, endLine: 7, column: 12 },
    { name: 'E_A', kind: 'enumConstant', file: headerFile, line: 5, endLine: 5, column: 1, parent: 'E' },
    { name: 'E_B', kind: 'enumConstant', file: headerFile, line: 6, endLine: 6, column: 1, parent: 'E' },
    { name: 'g', kind: 'variable', file: headerFile, line: 8, endLine: 8, column: 4 },
    { name: 'f', kind: 'function', file: headerFile, line: 9, endLine: 9, column: 4 },
    // 同名全局变量：用来证明字段访问只落到成员、普通 F12 仍能看到全部候选
    { name: 'len', kind: 'variable', file: sourceFile, line: 0, endLine: 0, column: 4 },
  ]
  const table = createSymbolTable(
    ['.'],
    [sourceFile, headerFile].map((file) => ({ path: file, mtimeMs: 0, size: 0 })),
    entries,
    1,
    SNAPSHOT_VERSION,
    { includes: new Map([[sourceFile, [headerFile]]]) },
  )
  const entryByName = (name) => entries.filter((entry) => entry.name === name)
  const service = {
    configuredRoots: ['.'],
    snapshot: table,
    workspaceRoot,
    definitions: (name) => entryByName(name),
    fileSymbols: (relPath) => table.entriesInFile(relPath),
    search: (query, limit, kinds) => searchSymbols(table, query, { limit: limit ?? 200, kinds }),
    signature: async (entry) => `int ${entry.name};`,
    toRelative: (absPath) => path.relative(workspaceRoot, absPath).split(path.sep).join('/'),
    toAbsolute: (relPath) => path.join(workspaceRoot, relPath),
  }
  const headerText = [
    'struct sk_buff {',
    '\tint len;',
    '\tchar *data;',
    '};',
    'typedef enum E {',
    '\tE_A,',
    '\tE_B',
    '} E;',
    'int g;',
    'int f(void) { return 0; }',
  ].join('\n')
  const headerDocument = new TextDocument(
    Uri.file(path.join(workspaceRoot, headerFile)),
    headerText,
  )
  const cancelToken = { isCancellationRequested: false }

  // ---- 枚举常量的英文标签统一：kindLabel 与无 parent 的 memberPhrase 都用 "Enum Constant" ----
  assert.equal(kindLabel('enumConstant'), 'Enum Constant', 'kindLabel uses one enum constant label')
  const bareEnumConstant = {
    name: 'BARE',
    kind: 'enumConstant',
    file: headerFile,
    line: 0,
    endLine: 0,
    column: 0,
  }
  assert.equal(
    memberPhrase(bareEnumConstant),
    'Enum Constant',
    'parentless enum constant reuses the same label',
  )
  assert.equal(
    memberPhrase({ ...bareEnumConstant, parent: 'E' }, 'enum'),
    'enumerator of enum E',
    'hover phrase for an enum constant with a parent is unchanged',
  )

  // ---- 字段跳转：p->f / v.f / .f = 都只解析到 kind='member' ----
  const definitionDisposable = registerDefinitionProvider(service)
  try {
    const provider = registrations.providers
      .filter(([kind]) => kind === 'definition')
      .pop()[2]
    const contexts = [
      ['skb->len;', 7, 'p->field'],
      ['v.len;', 3, 'v.field'],
      ['.len = 1;', 2, '.field designated initializer'],
    ]
    for (const [lineText, position, label] of contexts) {
      const document = new TextDocument(Uri.file(path.join(workspaceRoot, sourceFile)), lineText + '\n')
      const locations = await provider.provideDefinition(document, new Position(0, position), cancelToken)
      assert.ok(Array.isArray(locations), `${label}: definition provider returns locations`)
      assert.equal(locations.length, 1, `${label}: resolves to the single member candidate`)
      assert.equal(
        locations[0].uri.fsPath,
        path.join(workspaceRoot, headerFile),
        `${label}: jumps to the header holding the member`,
      )
      assert.equal(locations[0].range.start.line, 1, `${label}: jumps to the member line`)
    }

    // 无成员命中：回退普通定义流程（`p->g` 落到全局变量 g）
    const fallbackDocument = new TextDocument(
      Uri.file(path.join(workspaceRoot, sourceFile)),
      'p->g;\n',
    )
    const fallback = await provider.provideDefinition(
      fallbackDocument,
      new Position(0, 3),
      cancelToken,
    )
    assert.ok(Array.isArray(fallback) && fallback.length === 1, 'field access without member falls back')
    assert.equal(fallback[0].range.start.line, 8, 'fallback jumps to the global variable declaration')
  } finally {
    definitionDisposable.dispose()
  }

  // ---- 字段跳转候选上限：60 个成员候选只交出前 50 个（MAX_FIELD_CANDIDATES） ----
  const cappedEntries = Array.from({ length: 60 }, (_, index) => ({
    name: 'dup',
    kind: 'member',
    file: `inc/dup-${String(index).padStart(2, '0')}.h`,
    line: index,
    endLine: index,
    column: 4,
  }))
  const cappedService = {
    ...service,
    definitions: (name) => (name === 'dup' ? cappedEntries : []),
  }
  const cappedDisposable = registerDefinitionProvider(cappedService)
  try {
    const cappedProvider = registrations.providers
      .filter(([kind]) => kind === 'definition')
      .pop()[2]
    const cappedDocument = new TextDocument(
      Uri.file(path.join(workspaceRoot, sourceFile)),
      'p->dup;\n',
    )
    const capped = await cappedProvider.provideDefinition(
      cappedDocument,
      new Position(0, 3),
      cancelToken,
    )
    assert.ok(Array.isArray(capped), 'capped field jump returns locations')
    assert.equal(capped.length, 50, 'field jump caps member candidates at 50')
  } finally {
    cappedDisposable.dispose()
  }

  // ---- 大纲嵌套：struct 成员 / enum 常量挂到类型下，global 与函数留顶层 ----
  const documentSymbolDisposable = registerDocumentSymbolProvider(service)
  try {
    const provider = registrations.providers
      .filter(([kind]) => kind === 'documentSymbol')
      .pop()[2]
    const symbols = provider.provideDocumentSymbols(headerDocument, cancelToken)
    assert.deepEqual(
      symbols.map((symbol) => symbol.name),
      ['sk_buff', 'E', 'g', 'f'],
      'outline keeps types/globals/functions at the top level',
    )
    const structSymbol = symbols[0]
    assert.deepEqual(
      structSymbol.children.map((child) => child.name),
      ['len', 'data'],
      'struct members are nested under the struct',
    )
    assert.equal(structSymbol.children[0].kind, SymbolKind.Field, 'member uses SymbolKind.Field')
    assert.equal(structSymbol.children[0].detail, 'Member', 'member detail is the kind label')
    assert.equal(structSymbol.children[0].range.start.line, 1, 'nested member keeps its own range')
    const enumSymbol = symbols[1]
    assert.deepEqual(
      enumSymbol.children.map((child) => child.name),
      ['E_A', 'E_B'],
      'enum constants are nested under the enum',
    )
    assert.equal(enumSymbol.children[0].kind, SymbolKind.EnumMember, 'enum constant uses SymbolKind.EnumMember')
    assert.equal(symbols[2].kind, SymbolKind.Variable, 'global uses SymbolKind.Variable')
    assert.deepEqual(symbols[2].children, [], 'global has no children')
    assert.deepEqual(symbols[3].children, [], 'function has no children')
  } finally {
    documentSymbolDisposable.dispose()
  }

  // ---- 匿名 typedef 类型体：父节点完整范围覆盖成员，selectionRange 留在别名行 ----
  const aliasFile = 'inc/point.h'
  const aliasEntries = [
    { name: 'point_t', kind: 'typedef', file: aliasFile, line: 3, endLine: 3, column: 2 },
    { name: 'x', kind: 'member', file: aliasFile, line: 1, endLine: 1, column: 6, parent: 'point_t' },
    { name: 'y', kind: 'member', file: aliasFile, line: 2, endLine: 2, column: 6, parent: 'point_t' },
  ]
  const aliasTable = createSymbolTable(
    ['.'],
    [{ path: aliasFile, mtimeMs: 0, size: 0 }],
    aliasEntries,
    1,
    SNAPSHOT_VERSION,
  )
  const aliasService = {
    ...service,
    snapshot: aliasTable,
    fileSymbols: (relPath) => aliasTable.entriesInFile(relPath),
  }
  const aliasDocument = new TextDocument(
    Uri.file(path.join(workspaceRoot, aliasFile)),
    ['typedef struct {', '  int x;', '  int y;', '} point_t;'].join('\n'),
  )
  const aliasDisposable = registerDocumentSymbolProvider(aliasService)
  try {
    const provider = registrations.providers
      .filter(([kind]) => kind === 'documentSymbol')
      .pop()[2]
    const symbols = provider.provideDocumentSymbols(aliasDocument, cancelToken)
    assert.equal(symbols.length, 1, 'anonymous typedef body yields one top-level node')
    const point = symbols[0]
    assert.deepEqual(point.children.map((child) => child.name), ['x', 'y'])
    assert.equal(point.range.start.line, 1, 'parent full range starts at the first member')
    assert.equal(point.range.end.line, 3, 'parent full range ends on the alias line')
    assert.equal(
      point.selectionRange.start.line,
      3,
      'selectionRange stays on the alias line so go-to-symbol lands on point_t',
    )
  } finally {
    aliasDisposable.dispose()
  }

  // ---- 悬停：成员/枚举常量/全局变量补归属行，且不破坏原有分组/位置行 ----
  const hoverDisposable = registerHoverProvider(service)
  try {
    const provider = registrations.providers
      .filter(([kind]) => kind === 'hover')
      .pop()[2]
    const memberHover = await provider.provideHover(headerDocument, new Position(1, 6), cancelToken)
    assert.ok(memberHover, 'member hover returns a Hover')
    const memberMarkdown = memberHover.contents[0].value
    assert.match(memberMarkdown, /member of struct sk_buff/, 'member hover shows the parent struct')
    assert.match(memberMarkdown, /in this file/, 'member hover keeps the inclusion summary line')

    const enumHover = await provider.provideHover(headerDocument, new Position(5, 2), cancelToken)
    assert.ok(enumHover, 'enum constant hover returns a Hover')
    assert.match(
      enumHover.contents[0].value,
      /enumerator of enum E/,
      'enum constant hover shows the parent enum',
    )

    const variableHover = await provider.provideHover(headerDocument, new Position(8, 5), cancelToken)
    assert.ok(variableHover, 'global hover returns a Hover')
    assert.match(variableHover.contents[0].value, /\n\nvariable\n\n/, 'global hover is marked variable')
  } finally {
    hoverDisposable.dispose()
  }

  // ---- si.searchSymbol：@member / @var 过滤 + detail 显示 kind+parent ----
  const previousEditor = vscode.window.activeTextEditor
  const customBaseline = registrations.customQuickPicks.length
  const commands = registerCommands(undefined, service)
  try {
    vscode.window.activeTextEditor = {
      document: headerDocument,
      selection: { active: new Position(1, 6) },
    }
    const handler = [...registrations.commands]
      .reverse()
      .find(([id]) => id === 'si.searchSymbol')[1]
    const pending = handler()
    const pick = registrations.customQuickPicks[customBaseline]
    assert.ok(pick, 'searchSymbol creates an editable QuickPick')

    pick._onChange('@member le')
    await new Promise((resolve) => setTimeout(resolve, 180))
    assert.deepEqual(
      pick.items.map((item) => item.label),
      ['len'],
      '@member filters out the same-name global variable',
    )
    assert.match(
      pick.items[0].detail,
      /member of struct sk_buff/,
      'member QuickPick detail shows kind + parent',
    )
    // 宿主会用输入框原始值（含 @member）重新过滤 items；动态搜索必须 alwaysShow
    assert.ok(
      pick.allItems.length > 0 &&
        pick.allItems.every((item) => item.alwaysShow === true),
      'dynamic search items carry alwaysShow to bypass the host filter',
    )

    // 只输入 @kind（没有名字）时不能只留一个空列表：placeHolder 要提示继续输入，
    // 且过滤种类仍保留（继续输入后按该种类搜索，见下面的 @member len）。
    pick._onChange('@member')
    await new Promise((resolve) => setTimeout(resolve, 180))
    assert.deepEqual(pick.items.map((item) => item.label), [], '@kind-only keeps the list empty')
    assert.match(
      String(pick.placeholder),
      /Type a name after @member/,
      '@kind-only shows a placeholder hint',
    )

    pick._onChange('@member le')
    await new Promise((resolve) => setTimeout(resolve, 180))
    assert.deepEqual(
      pick.items.map((item) => item.label),
      ['len'],
      '@member + name still applies the selected kind after the hint',
    )

    pick._onChange('@var le')
    // 输入变化同步清空旧结果：防抖窗口内快速回车不会接受上一轮查询的首选
    assert.deepEqual(
      pick.items.map((item) => item.label),
      [],
      'searchSymbol clears the previous items synchronously before the debounce fires',
    )
    await new Promise((resolve) => setTimeout(resolve, 180))
    assert.deepEqual(
      pick.items.map((item) => item.label),
      ['len'],
      '@var returns the global variable of the same name',
    )
    assert.match(pick.items[0].detail, /^Variable/, '@var detail keeps the plain kind label')

    pick._onChange('@type sk')
    await new Promise((resolve) => setTimeout(resolve, 180))
    assert.deepEqual(
      pick.items.map((item) => item.label),
      ['sk_buff'],
      '@type filters to type symbols',
    )

    // @enum 端到端：经过真实 QuickPick（含宿主过滤）仍能看到枚举常量
    pick._onChange('@enum E_')
    await new Promise((resolve) => setTimeout(resolve, 180))
    assert.deepEqual(
      pick.items.map((item) => item.label),
      ['E_A', 'E_B'],
      '@enum searches enum constants through the real QuickPick path',
    )
    assert.match(
      pick.items[0].detail,
      /enumerator of enum E/,
      '@enum detail shows the parent enum',
    )

    pick._onChange('E_')
    await new Promise((resolve) => setTimeout(resolve, 180))
    assert.deepEqual(
      pick.items.map((item) => item.label),
      ['E_A', 'E_B'],
      'without @kind the search keeps candidate order (distinct names make order observable)',
    )

    pick.selectedItems = [pick.items[0]]
    pick._onAccept()
    await pending
  } finally {
    commands.dispose()
    vscode.window.activeTextEditor = previousEditor
    registrations.quickPickResponses.length = 0
  }
}

/**
 * F8 符号高亮（0.9.3）：目标文件内整词装饰、注释/字符串排除、状态栏 `N in file / M index refs`、
 * F3/Shift+F3 前后跳转与首尾循环、编辑防抖重扫、文档关闭/编辑器切换清除、setContext 上下文键。
 */
async function checkSymbolHighlight() {
  const dist = path.join(EXT_ROOT, 'dist')
  const { registerCommands } = require(path.join(dist, 'src/vscode/commands.js'))
  const { findWordOccurrences } = require(path.join(dist, 'src/core/word-occurrences.js'))

  const sourceFile = 'src/highlight.c'
  const documentText = [
    '#include <stdio.h>',
    '// foo in a line comment',
    'int foo(int x) { return foo(x - 1); }',
    'const char *s = "foo";',
    '/* foo in a block comment */',
    'int foobar = foo(1);   /* foo */',
    "char c = 'f';",
    '#define USE_FOO foo + 1',
  ].join('\n')
  const document = new TextDocument(Uri.file(path.join(EXT_ROOT, sourceFile)), documentText)
  const definition = {
    name: 'foo',
    kind: 'function',
    file: sourceFile,
    line: 2,
    endLine: 2,
    column: 4,
  }
  const indexReferences = [
    { file: sourceFile, line: 2, column: 4, preview: 'foo' },
    { file: sourceFile, line: 5, column: 13, preview: 'foo' },
    { file: 'src/other.c', line: 9, column: 0, preview: 'foo' },
  ]
  const service = {
    configuredRoots: ['.'],
    workspaceRoot: EXT_ROOT,
    definitions: (name) => (name === 'foo' ? [definition] : []),
    references: async (name) => (name === 'foo' ? indexReferences : []),
    toRelative: (absPath) => path.relative(EXT_ROOT, absPath).split(path.sep).join('/'),
    toAbsolute: (relPath) => path.join(EXT_ROOT, relPath),
  }

  const makeEditor = (doc, cursor) => {
    const editor = {
      document: doc,
      viewColumn: 1,
      selection: new Selection(cursor, cursor),
      visibleRanges: [new Range(0, 0, doc.lineCount, 0)],
      decorations: new Map(),
      revealed: [],
      setDecorations(type, ranges) {
        editor.decorations.set(type, Array.isArray(ranges) ? ranges.slice() : [])
      },
      revealRange(range, revealType) {
        editor.revealed.push({ range, revealType })
      },
    }
    return editor
  }
  const editor = makeEditor(document, new Position(2, 4))

  const DEFINITION_THEME = 'editor.findMatchBackground'
  const DEFINITION_BORDER = 'editor.findMatchBorder'
  const REFERENCE_THEME = 'editor.findMatchHighlightBackground'
  const REFERENCE_BORDER = 'editor.findMatchHighlightBorder'
  // 扩展激活时已创建自己的两个装饰类型；只在本检查创建的类型里按背景色找。
  // 颜色配置变化会重建类型并追加到 registrations.decorations，故取最后一个匹配项。
  const decorationBaseline = registrations.decorations.length
  const backgroundId = (options) => {
    const background = options && options.backgroundColor
    if (typeof background === 'string') return background
    if (background && typeof background === 'object' && typeof background.id === 'string') {
      return background.id
    }
    return undefined
  }
  const decorationType = (background) => {
    const candidates = registrations.decorations.slice(decorationBaseline)
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      if (backgroundId(candidates[index].options) === background) return candidates[index]
    }
    return undefined
  }
  const decorationRanges = (background) => {
    const type = decorationType(background)
    assert.ok(type, `decoration type with background ${background} exists`)
    assert.ok(type.options.overviewRulerColor, 'decoration type has overviewRulerColor')
    return editor.decorations.get(type) ?? []
  }
  const starts = (ranges) => ranges.map((range) => [range.start.line, range.start.character])
  // 默认颜色必须是 ThemeColor（跟随主题），而不是固定字符串。
  const assertThemeSpec = (background, border, label) => {
    const type = decorationType(background)
    assert.ok(type, `${label}: decoration type exists`)
    assert.equal(type.options.backgroundColor.id, background, `${label}: background follows the theme`)
    assert.equal(type.options.borderColor.id, border, `${label}: border follows the theme`)
    assert.equal(
      type.options.overviewRulerColor.id,
      border,
      `${label}: overview ruler follows the theme`,
    )
    assert.equal(type.options.borderWidth, '1px', `${label}: borderWidth`)
    assert.equal(type.options.borderStyle, 'solid', `${label}: borderStyle`)
    return type
  }
  const fireConfigurationChange = (keys) => {
    const event = {
      affectsConfiguration: (key) => keys.includes(key),
    }
    for (const listener of registrations.configurationListeners.slice()) {
      listener(event)
    }
  }

  const previousEditor = vscode.window.activeTextEditor
  const previousVisible = vscode.window.visibleTextEditors
  const statusBaseline = registrations.statusBarItems.length
  vscode.window.activeTextEditor = editor
  vscode.window.visibleTextEditors = [editor]
  const commands = registerCommands(undefined, service)
  const handler = (id) =>
    [...registrations.commands].reverse().find(([command]) => command === id)[1]
  const contextCalls = () =>
    registrations.executedCommands.filter(
      ([command, key]) => command === 'setContext' && key === 'si.highlightActive',
    )
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20))
  try {
    // ---- F8 激活：定义/引用使用主题 find-match 色；注释/字符串/字符字面量里的 foo 都不算 ----
    await handler('si.highlightSymbol')()
    await tick()

    assert.deepEqual(
      findWordOccurrences(documentText, 'foo').map((occurrence) => [
        occurrence.line,
        occurrence.column,
      ]),
      [
        [2, 4],
        [2, 24],
        [5, 13],
        [7, 16],
      ],
      'occurrence scan skips comments/strings and keeps macro-line code',
    )
    assertThemeSpec(DEFINITION_THEME, DEFINITION_BORDER, 'definition default')
    assertThemeSpec(REFERENCE_THEME, REFERENCE_BORDER, 'reference default')
    assert.deepEqual(
      starts(decorationRanges(DEFINITION_THEME)),
      [[2, 4]],
      'definition occurrence uses the theme colour',
    )
    assert.deepEqual(
      starts(decorationRanges(REFERENCE_THEME)),
      [
        [2, 24],
        [5, 13],
        [7, 16],
      ],
      'references use the theme colour; occurrences inside comments/strings are not decorated',
    )

    assert.equal(registrations.statusBarItems.length, statusBaseline + 1, 'one highlight status item')
    const item = registrations.statusBarItems[registrations.statusBarItems.length - 1]
    assert.equal(item.visible, true, 'highlight status item is shown')
    assert.equal(item.command, 'si.highlightSymbol', 'clicking the item toggles the highlight')
    assert.match(item.text, /foo · 4 in file/, 'status shows the in-file count')
    assert.match(item.text, /3 index refs/, 'status shows the async index reference count')
    assert.deepEqual(
      contextCalls().pop(),
      ['setContext', 'si.highlightActive', true],
      'activation sets si.highlightActive=true',
    )

    // ---- 再按 F8：清除装饰/状态栏/上下文键 ----
    await handler('si.highlightSymbol')()
    await tick()
    assert.deepEqual(decorationRanges(DEFINITION_THEME), [], 'toggle off clears definition decorations')
    assert.deepEqual(decorationRanges(REFERENCE_THEME), [], 'toggle off clears reference decorations')
    assert.equal(item.visible, false, 'toggle off hides the status item')
    assert.deepEqual(
      contextCalls().pop(),
      ['setContext', 'si.highlightActive', false],
      'toggle off sets si.highlightActive=false',
    )

    // ---- 再次激活后 F3 / Shift+F3 跳转（含首尾循环） ----
    editor.selection = new Selection(new Position(2, 4), new Position(2, 4))
    await handler('si.highlightSymbol')()
    await tick()
    assert.equal(decorationRanges(DEFINITION_THEME).length, 1, 're-activation restores decorations')

    await handler('si.nextOccurrence')()
    assert.equal(editor.selection.start.line, 2, 'next stays on the current line')
    assert.equal(editor.selection.start.character, 24, 'next selects the following occurrence')
    assert.equal(editor.selection.active.character, 27, 'selection active sits at the match end')
    await handler('si.prevOccurrence')()
    assert.equal(editor.selection.start.character, 4, 'prev selects the definition again')
    assert.ok(editor.revealed.length > 0, 'jumping reveals the occurrence')
    assert.equal(editor.revealed[editor.revealed.length - 1].revealType, 2, 'reveal uses InCenter')

    editor.selection = new Selection(new Position(7, 16), new Position(7, 16))
    await handler('si.nextOccurrence')()
    assert.deepEqual(
      [editor.selection.start.line, editor.selection.start.character],
      [2, 4],
      'next wraps from the last occurrence to the first',
    )
    await handler('si.prevOccurrence')()
    assert.deepEqual(
      [editor.selection.start.line, editor.selection.start.character],
      [7, 16],
      'prev wraps from the first occurrence to the last',
    )

    // ---- 文档编辑 150 ms 防抖后按同一词重扫 ----
    document._lines[5] = 'int foobar = 0;'
    document.version += 1
    for (const listener of registrations.documentChangeListeners) {
      listener({ document, contentChanges: [] })
    }
    assert.equal(decorationRanges(REFERENCE_THEME).length, 3, 'decorations wait for the debounce')
    await new Promise((resolve) => setTimeout(resolve, 220))
    assert.equal(decorationRanges(REFERENCE_THEME).length, 2, 'debounced rescan drops the edited-out reference')
    assert.equal(decorationRanges(DEFINITION_THEME).length, 1, 'debounced rescan keeps the definition')
    assert.match(item.text, /foo · 3 in file/, 'status in-file count follows the rescan')

    // ---- 颜色配置变化：重建装饰类型并重新应用当前高亮（不重建索引、不重查引用数） ----
    const previousDefinitionColor = configurationValues.highlightDefinitionColor
    const previousReferenceColor = configurationValues.highlightReferenceColor
    const definitionTypeBefore = decorationType(DEFINITION_THEME)
    const referenceTypeBefore = decorationType(REFERENCE_THEME)
    const CUSTOM_DEFINITION = '#2ea04366'
    const CUSTOM_REFERENCE = 'rgba(255,196,0,0.4)'
    const informationBaseline = registrations.informationMessages.length
    configurationValues.highlightDefinitionColor = CUSTOM_DEFINITION
    configurationValues.highlightReferenceColor = CUSTOM_REFERENCE
    fireConfigurationChange([
      'sourceInsight.highlightDefinitionColor',
      'sourceInsight.highlightReferenceColor',
    ])
    const customDefinitionType = decorationType(CUSTOM_DEFINITION)
    const customReferenceType = decorationType(CUSTOM_REFERENCE)
    assert.ok(customDefinitionType, 'custom definition decoration type created')
    assert.ok(customReferenceType, 'custom reference decoration type created')
    assert.equal(customDefinitionType.options.borderColor, CUSTOM_DEFINITION, 'custom definition border')
    assert.equal(
      customDefinitionType.options.overviewRulerColor,
      CUSTOM_DEFINITION,
      'custom definition overview ruler',
    )
    assert.equal(customDefinitionType.options.borderWidth, '1px', 'custom definition borderWidth')
    assert.equal(customDefinitionType.options.borderStyle, 'solid', 'custom definition borderStyle')
    assert.equal(definitionTypeBefore.disposed, true, 'old definition decoration type disposed')
    assert.equal(referenceTypeBefore.disposed, true, 'old reference decoration type disposed')
    assert.deepEqual(
      starts(editor.decorations.get(customDefinitionType) ?? []),
      [[2, 4]],
      'custom definition colour re-applies the definition',
    )
    assert.deepEqual(
      starts(editor.decorations.get(customReferenceType) ?? []),
      [
        [2, 24],
        [7, 16],
      ],
      'custom reference colour re-applies the references',
    )
    assert.equal(item.visible, true, 'highlight stays active after a colour change')
    assert.match(item.text, /foo · 3 in file/, 'colour change keeps the current in-file count')
    assert.equal(
      registrations.informationMessages.length,
      informationBaseline,
      'colour change does not mark the index as needing a rebuild',
    )

    // 恢复空配置 -> 回到主题色，仍然保持高亮。
    configurationValues.highlightDefinitionColor = previousDefinitionColor
    configurationValues.highlightReferenceColor = previousReferenceColor
    fireConfigurationChange([
      'sourceInsight.highlightDefinitionColor',
      'sourceInsight.highlightReferenceColor',
    ])
    const restoredDefinitionType = assertThemeSpec(
      DEFINITION_THEME,
      DEFINITION_BORDER,
      'restored definition',
    )
    assert.equal(
      customDefinitionType.disposed,
      true,
      'custom definition decoration type disposed after reset',
    )
    assert.deepEqual(
      starts(editor.decorations.get(restoredDefinitionType) ?? []),
      [[2, 4]],
      'theme colour is re-applied after resetting the override',
    )
    assert.deepEqual(
      starts(decorationRanges(REFERENCE_THEME)),
      [
        [2, 24],
        [7, 16],
      ],
      'theme reference colour is re-applied after resetting the override',
    )

    // ---- 文档关闭：清除 ----
    for (const listener of registrations.documentCloseListeners) {
      listener(document)
    }
    await tick()
    assert.deepEqual(decorationRanges(DEFINITION_THEME), [], 'closing the document clears decorations')
    assert.equal(item.visible, false, 'closing the document hides the status item')
    assert.deepEqual(
      contextCalls().pop(),
      ['setContext', 'si.highlightActive', false],
      'closing the document clears si.highlightActive',
    )

    // ---- 活动编辑器切到别的文档：清除 ----
    await handler('si.highlightSymbol')()
    await tick()
    assert.equal(decorationRanges(DEFINITION_THEME).length, 1, 'highlight is active before the editor switch')
    const otherDocument = new TextDocument(
      Uri.file(path.join(EXT_ROOT, 'src/highlight-other.c')),
      'int bar;\n',
    )
    const otherEditor = makeEditor(otherDocument, new Position(0, 4))
    vscode.window.activeTextEditor = otherEditor
    vscode.window.visibleTextEditors = [otherEditor]
    for (const listener of registrations.activeEditorListeners) {
      listener(otherEditor)
    }
    await tick()
    assert.deepEqual(decorationRanges(DEFINITION_THEME), [], 'editor switch clears definition decorations')
    assert.deepEqual(decorationRanges(REFERENCE_THEME), [], 'editor switch clears reference decorations')
    assert.equal(item.visible, false, 'editor switch hides the status item')
    assert.deepEqual(
      contextCalls().pop(),
      ['setContext', 'si.highlightActive', false],
      'editor switch clears si.highlightActive',
    )
  } finally {
    commands.dispose()
    vscode.window.activeTextEditor = previousEditor
    vscode.window.visibleTextEditors = previousVisible
  }
}

async function checkSymbolTreeLimits() {
  const { SymbolsTreeProvider } = require(
    path.join(EXT_ROOT, 'dist/src/vscode/views/symbols-tree.js'),
  )
  const makeService = (entries, treeSymbolLimit) => ({
    ready: true,
    config: { treeSymbolLimit, searchLimit: 200 },
    fileSymbols: (rel) => (rel === 'inc/big.h' ? entries : []),
    onDidChange: () => ({ dispose() {} }),
    onProgress: () => ({ dispose() {} }),
  })
  const makeSymbols = (count) =>
    Array.from({ length: count }, (_, index) => ({
      name: `sym_${index}`,
      kind: 'function',
      file: 'inc/big.h',
      line: index,
      endLine: index,
      column: 0,
    }))

  // 0.8.0 的 200 搜索上限曾截断 B3 之后变大的头文件（最大的头 199 -> 479 个符号）；
  // 树的上限默认 2000，必须与 searchLimit 独立。
  const bigTree = new SymbolsTreeProvider(makeService(makeSymbols(479), 2000))
  try {
    const children = bigTree.getChildren({ kind: 'file', rel: 'inc/big.h' })
    assert.equal(children.length, 479, 'symbol tree shows all 479 symbols of a real-size header')
    assert.ok(
      children.every((child) => child.kind === 'symbol'),
      'no overflow node below the tree cap',
    )
    const firstItem = bigTree.getTreeItem(children[0])
    assert.equal(firstItem.description, ':1 · Function', 'tree row is `:line · kind` (no signature)')
  } finally {
    bigTree.dispose()
  }

  // 超过上限才出现提示节点，且提示文本明确告诉用户调大 treeSymbolLimit。
  const cappedTree = new SymbolsTreeProvider(makeService(makeSymbols(2100), 2000))
  try {
    const children = cappedTree.getChildren({ kind: 'file', rel: 'inc/big.h' })
    assert.equal(children.length, 2001, 'cap renders treeSymbolLimit symbols + one overflow node')
    assert.equal(
      children.filter((child) => child.kind === 'symbol').length,
      2000,
      'symbol nodes stop at treeSymbolLimit',
    )
    const more = children[children.length - 1]
    assert.equal(more.kind, 'more', 'overflow node is a MoreNode')
    assert.equal(more.remaining, 100, 'overflow node counts the hidden symbols')
    const moreItem = cappedTree.getTreeItem(more)
    assert.match(
      String(moreItem.label),
      /… and 100 more \(raise sourceInsight\.treeSymbolLimit\)/,
      'overflow node tells the user to raise treeSymbolLimit',
    )
  } finally {
    cappedTree.dispose()
  }
}

/**
 * Relation 面板：mock webview 面板，验证 HTML 单视图（无 Graph 标签页）、
 * 双向自动展开、展开/折叠、setRoot 不跳编辑器、open 跳转与 collapseAll。
 */
async function checkCallGraphRelationPanel() {
  const dist = path.join(EXT_ROOT, 'dist')
  const { showCallGraph, CallGraphPanel } = require(path.join(
    dist,
    'src/vscode/views/call-graph-panel.js',
  ))
  const { nodeIdOf } = require(path.join(dist, 'src/vscode/call-graph-model.js'))
  CallGraphPanel.disposeCurrent()

  const entry = (name, line) => ({ name, kind: 'function', file: 'src/main.c', line, endLine: line + 1, column: 0 })
  const rootEntry = entry('root_fn', 10)
  const callerA = entry('caller_a', 5)
  const callerB = entry('caller_b', 6)
  const calleeA = entry('callee_a', 20)
  const callerOfA = entry('caller_of_a', 2)
  const deepCallee = entry('deep_callee', 30)
  const service = {
    workspaceRoot: EXT_ROOT,
    configuredRoots: ['.'],
    toAbsolute: (file) => path.join(EXT_ROOT, file),
    definitions: () => [rootEntry],
    callers: async (name) => {
      if (name === 'root_fn') return [{ from: callerA }, { from: callerB }, { from: callerA }]
      if (name === 'caller_a') return [{ from: callerOfA }]
      return []
    },
    callees: async (name) => {
      if (name === 'root_fn') return [calleeA]
      if (name === 'callee_a') return [deepCallee]
      return []
    },
  }

  const panel = await showCallGraph(service, rootEntry)
  assert.ok(panel, 'relation panel instance')
  assert.equal(registrations.webviewPanels.length, 1, 'one webview panel created')
  const created = registrations.webviewPanels[0]
  const html = created.webview.html
  for (const token of [
    'Relation',
    'id="section-title-callers"',
    'id="section-title-callees"',
    'Use cursor function as root',
    'Collapse all',
    'No callers',
    'No callees',
    'Set as root',
    "type: 'setRoot'",
    "type: 'collapseAll'",
  ]) {
    assert.ok(html.includes(token), `relation html contains ${token}`)
  }
  for (const token of [
    'tab-strip',
    'role="tablist"',
    'tab-btn-graph',
    'data-tab="graph"',
    'id="tab-graph"',
    'id="columns"',
  ]) {
    assert.ok(!html.includes(token), `relation html has no Graph tab marker ${token}`)
  }
  // 0.9.7 修正：关系行固定单行；名字优先，file:line 先收窄省略、窄面板下整体隐藏。
  assert.match(html, /\.row\s*\{[^}]*flex-wrap:\s*nowrap/, 'relation row never wraps')
  assert.ok(
    !/\.row\s*\{[^}]*flex-wrap:\s*wrap/.test(html),
    'relation row is not a wrapping flex row',
  )
  const nameRule = (html.match(/\.name\s*\{([^}]*)\}/) || [])[1] || ''
  assert.match(nameRule, /flex:\s*1 1 auto/, 'name takes the remaining row width')
  assert.match(nameRule, /min-width:\s*0/, 'name may shrink only on a panel narrower than itself')
  assert.match(nameRule, /white-space:\s*nowrap/, 'name stays on one line')
  assert.match(nameRule, /text-overflow:\s*ellipsis/, 'name ellipsizes only when the panel is too narrow')
  assert.ok(!nameRule.includes('overflow-wrap'), 'name has no overflow-wrap rule')
  assert.ok(!nameRule.includes('word-break'), 'name has no word-break rule')
  assert.ok(!nameRule.includes('white-space: normal'), 'name never wraps')
  const metaRule = (html.match(/\.meta\s*\{([^}]*)\}/) || [])[1] || ''
  assert.match(metaRule, /text-overflow:\s*ellipsis/, 'location truncates with an ellipsis')
  assert.match(metaRule, /max-width:\s*45%/, 'location is capped at 45% of the row')
  assert.match(metaRule, /min-width:\s*0/, 'location can collapse completely')
  assert.match(metaRule, /white-space:\s*nowrap/, 'location stays on one line')
  const flexShrinkOf = (rule) => {
    const explicit = /flex-shrink:\s*(\d+)/.exec(rule)
    if (explicit) return Number(explicit[1])
    const shorthand = /flex:\s*\d+\s+(\d+)/.exec(rule)
    return shorthand ? Number(shorthand[1]) : NaN
  }
  assert.ok(
    flexShrinkOf(metaRule) > flexShrinkOf(nameRule),
    'location shrinks before the name',
  )
  const narrowRule =
    (html.match(/@media \(max-width: 420px\)\s*\{([\s\S]*?)\n  \}/) || [])[1] || ''
  assert.match(narrowRule, /\.meta\s*\{[^}]*display:\s*none/, 'narrow panel hides the location')
  assert.ok(!html.includes('@container'), 'no container-query fallback')
  assert.ok(!/flex-basis:\s*100%/.test(html), 'location never moves to its own line')
  assert.ok(!html.includes('container-type'), 'no inline-size container for row layout')
  assert.ok(!html.includes('class="leading"'), 'no wrapping sub-row in the markup')
  assert.ok(!html.includes("el('div', 'leading')"), 'no wrapping sub-row in the render code')
  assert.ok(!/\.leading\s*\{/.test(html), 'no wrapping sub-row CSS')
  assert.match(html, /\.children\.deep\s*\{/, 'deep nesting caps the visual indentation')
  // 0.9.8：悬停 “Set as root” 脱离行内 flex 流（绝对定位），不再为每行预留 ~66px。
  assert.match(html, /\.row\s*\{[^}]*position:\s*relative/, 'row is the containing block for the action')
  const actionRule = (html.match(/^  \.row-action\s*\{([^}]*)\}/m) || [])[1] || ''
  assert.match(actionRule, /position:\s*absolute/, 'hover action is absolutely positioned')
  assert.ok(!/flex/.test(actionRule), 'hover action is out of the row flex flow (no flex rules)')
  assert.ok(!/margin-left:\s*auto/.test(actionRule), 'hover action does not reserve space via margin')
  assert.match(actionRule, /opacity:\s*0/, 'hover action is hidden by default')
  assert.match(actionRule, /pointer-events:\s*none/, 'hidden action is not clickable')
  assert.match(actionRule, /right:\s*4px/, 'action is anchored to the row right edge')
  const actionHoverRule =
    (html.match(/\.row:hover \.row-action[^{]*\{([^}]*)\}/) || [])[1] || ''
  assert.match(actionHoverRule, /opacity:\s*1/, 'row hover reveals the action')
  assert.match(actionHoverRule, /pointer-events:\s*auto/, 'revealed action is clickable')
  assert.match(html, /\.row:focus-within \.row-action/, 'keyboard focus reveals the action')
  assert.ok(!/^  \.row-action\s*\{[^}]*flex:/m.test(html), 'action never takes flex width')
  assert.ok(!/padding-right/.test(metaRule), 'location reserves no right padding by default')
  assert.match(
    html,
    /\.row:hover \.meta[^{]*\{[^}]*padding-right:\s*70px/,
    'location yields width only while the action is visible',
  )
  assert.ok(html.includes('name.title = tree.node.file'), 'name keeps the full file:line tooltip')
  assert.ok(html.includes('meta.title = meta.textContent'), 'location keeps the full path tooltip')
  assert.equal(created.title, 'Call Graph: root_fn', 'panel title keeps the current root name')

  const latestState = () => {
    for (let i = registrations.webviewMessages.length - 1; i >= 0; i--) {
      const message = registrations.webviewMessages[i]
      if (message && message.type === 'state') return message
    }
    return undefined
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

  let state = latestState().state
  assert.equal(state.root.node.name, 'root_fn')
  assert.equal(state.root.callers.length, 2, 'callers auto-expanded and deduped')
  assert.equal(state.root.callees.length, 1, 'callees auto-expanded')

  const listener = registrations.webviewMessageListeners[0]
  listener({ type: 'ready' })
  await tick()
  assert.equal(latestState().state.root.node.name, 'root_fn', 'ready resends the current state')

  listener({ type: 'expand', id: nodeIdOf(calleeA), direction: 'callees' })
  await tick()
  state = latestState().state
  const calleeTree = state.root.callees.find((tree) => tree.node.id === nodeIdOf(calleeA))
  assert.equal(calleeTree.callees.length, 1, 'nested callee expansion loads one more level')
  assert.equal(latestState().loading.callees, false, 'per-direction loading flag clears')

  listener({ type: 'collapseAll' })
  await tick()
  state = latestState().state
  assert.equal(state.root.callees.length, 1, 'collapseAll keeps root direct callees')
  assert.equal(state.root.callees[0].callees.length, 0, 'collapseAll drops nested callees')
  assert.equal(state.root.callers.length, 2, 'collapseAll keeps root direct callers')

  const openedBefore = registrations.openedDocuments.length
  listener({ type: 'setRoot', id: nodeIdOf(callerA) })
  await tick()
  state = latestState().state
  assert.equal(created.title, 'Call Graph: caller_a', 'setRoot updates the panel title')
  assert.equal(state.root.node.name, 'caller_a', 'setRoot re-roots to the clicked node')
  assert.equal(state.root.callers.length, 1, 'setRoot auto-expands callers')
  assert.equal(state.root.callees.length, 0, 'setRoot auto-expands callees')
  assert.equal(
    registrations.openedDocuments.length,
    openedBefore,
    'setRoot never opens/moves the editor',
  )

  listener({ type: 'open', id: nodeIdOf(callerOfA) })
  await tick()
  assert.equal(
    registrations.openedDocuments.length,
    openedBefore + 1,
    'clicking a name opens the definition in an editor group',
  )

  listener({ type: 'collapse', id: nodeIdOf(callerA), direction: 'callers' })
  await tick()
  assert.equal(latestState().state.root.callers.length, 0, 'collapse clears the expanded direction')

  CallGraphPanel.disposeCurrent()
  assert.equal(created.disposed, true, 'panel dispose is forwarded to the host panel')
}

async function main() {
  const extension = require(path.join(EXT_ROOT, 'dist/src/vscode/extension.js'))
  assert.equal(typeof extension.activate, 'function', 'extension.activate must be a function')

  await extension.activate(context)
  // 等待 activate 内部的异步初始化（index/service 加载快照）稳定
  await new Promise((resolve) => setTimeout(resolve, 150))

  const expectedCommands = pkg.contributes.commands.map((c) => c.command).sort()
  const registered = [...new Set(registrations.commands.map(([id]) => id))].sort()
  const missing = expectedCommands.filter((id) => !registered.includes(id))
  assert.deepEqual(missing, [], `missing registered commands: ${missing.join(', ')}`)

  // package.json 声明 15 个命令（0.9.3 新增 F8 高亮/下一个/上一个），必须全部注册
  assert.equal(expectedCommands.length, 15, 'package.json declares 15 commands')
  assert.equal(registered.length, 15, 'all 15 declared commands are registered')

  const providerKinds = new Set(registrations.providers.map(([kind]) => kind))
  for (const kind of ['definition', 'references', 'hover', 'documentSymbol', 'workspaceSymbol', 'callHierarchy']) {
    assert.ok(providerKinds.has(kind), `missing provider: ${kind}`)
  }

  assert.ok(registrations.treeViews.some(([id]) => id === 'si.symbols'), 'si.symbols tree view')
  assert.ok(registrations.statusBar >= 1, 'status bar item')

  await checkBudgetUi()
  await checkRootsChanged()
  await checkAutoCompactFlush()
  await checkServiceRoundTrip()
  await checkLegacySnapshotUpgrade()
  await checkIncludeRemovalAndRemoveFile()
  await checkDeltaConflict()
  await checkDefinitionCandidatesCommand()
  await checkListAnnotations()
  await checkCallHierarchyIncludeAware()
  await checkMemberSymbolUi()
  await checkSymbolHighlight()
  await checkSymbolTreeLimits()
  await checkCallGraphRelationPanel()

  await extension.deactivate()
  for (const item of context.subscriptions) {
    // VS Code 会自动 dispose；这里只验证它们可被 dispose
    if (item && typeof item.dispose === 'function') item.dispose()
  }

  console.log('SMOKE OK')
  console.log('  commands:', registered.length, '->', registered.join(', '))
  console.log('  providers:', [...providerKinds].join(', '))
  console.log('  tree views:', registrations.treeViews.map(([id]) => id).join(', '))
  console.log('  status bar items:', registrations.statusBar)
  console.log('  output channels:', outputChannels.map((c) => c.name).join(', '))
  console.log('  subscriptions:', context.subscriptions.length)
  console.log('  budget UI: warn/warning color, exceeded/error color, one-shot reconfigure prompt OK')
  console.log('  rootsChanged: normalized-equivalent roots stay silent, order-only change prompts OK')
  console.log('  autoCompact=false: flush/dispose skip compaction, delta append awaited OK')
  console.log('  service round trip: updateFile -> delta v3 (hash/includes/condition/parent) -> replay -> compaction -> reload OK')
  console.log('  legacy v4 snapshot: discarded on load, rebuilt with hash/include/condition metadata OK')
  console.log('  include removal: explicit [] in delta, base edges cleared on replay/reload, removeFile drops cached path/edges OK')
  console.log('  shared-storage conflict: compaction/rebuild keep the other window delta OK')
  console.log('  definition candidates: included/copies/#ifdef labels, copy sub-picker, direct open OK')
  console.log('  F12 grouping + hover annotation: one Location per content group, included/copies/conditional OK')
  console.log('  gotoDefinition grouping: one entry per group, copy sub-picker, single group direct open, no-def message OK')
  console.log('  hover same-file wording: "in this file", never "included by this file" OK')
  console.log('  list annotations: search/callers/callees append included/not included + conditional OK')
  console.log('  zh-cn labels: 包含/未包含/副本/条件 OK')
  console.log('  call hierarchy include-aware: included definition ranks before a closer non-included one OK')
  console.log('  gotoDefinition single multi-copy group: copy picker (not direct representative) OK')
  console.log('  member symbols: field jump (p->f/v.f/.f=) only member + fallback, outline nesting, hover parent, @kind search OK')
  console.log('  symbol tree cap: 479-symbol header fully rendered, overflow hint only beyond treeSymbolLimit (@kind-only placeholder hint OK)')
  console.log('  F8 symbol highlight: theme-aware ThemeColor defaults, custom colour override reload without index rebuild, decorations exclude comments+strings, status in-file/index counts, F3 toggle/wrap, debounce rescan, close+editor-switch clear, si.highlightActive OK')
  console.log('  call graph relation panel: single Relation tree view (no Graph tab), single-line rows (name prioritized, location truncates then hides on narrow panels, deep indent capped), absolutely-positioned hover action outside the flex flow (no width reserved, revealed on hover/focus, location padded only while visible), auto-expanded callers/callees, nested expand, collapseAll, setRoot without editor jump, open/collapse OK')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('SMOKE FAILED:', error && error.stack ? error.stack : error)
    process.exit(1)
  })
