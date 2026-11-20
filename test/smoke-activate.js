#!/usr/bin/env node
/**
 * 用 mock 的 `vscode` 模块加载编译产物并执行 activate()，验证：
 *  - extension.js 可加载、activate 不抛异常
 *  - 所有 package.json 声明的命令都被注册
 *  - 语言 Provider 注册数量符合预期
 *  - 预算状态栏（warn/exceeded 颜色）与 exceeded 一次性提示（含按钮动作）
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
  maxSymbols: 2000000,
  maxFiles: 120000,
  autoCompact: true,
  searchLimit: 200,
  autoReindexOnSave: true,
  enableCallHierarchy: true,
  followSymlinks: false,
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
    onDidChangeActiveTextEditor: () => disposable('onDidChangeActiveTextEditor'),
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
    createStatusBarItem: () => {
      registrations.statusBar += 1
      const item = {
        text: '',
        tooltip: undefined,
        command: undefined,
        backgroundColor: undefined,
        show() {},
        hide() {},
        dispose() {},
      }
      registrations.statusBarItems.push(item)
      return item
    },
    createQuickPick: () => {
      const quickPick = {
        items: [],
        placeholder: '',
        matchOnDescription: false,
        matchOnDetail: false,
        ignoreFocusOut: false,
        selectedItems: [],
        _onChange: undefined,
        _onAccept: undefined,
        _onHide: undefined,
        onDidChangeValue: (listener) => {
          quickPick._onChange = listener
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
      void listener
      return disposable('onDidChangeConfiguration')
    },
    onDidSaveTextDocument: () => disposable('onDidSaveTextDocument'),
    onDidChangeTextDocument: () => disposable('onDidChangeTextDocument'),
    onDidChangeWorkspaceFolders: () => disposable('onDidChangeWorkspaceFolders'),
    onDidOpenTextDocument: () => disposable('onDidOpenTextDocument'),
    onDidCloseTextDocument: () => disposable('onDidCloseTextDocument'),
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
    entryCount: 2_500_000,
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
    service.snapshotValue.entryCount = 6_000_000
    controller.update()
    assert.match(item.text, /^\$\(error\) /, 'exceeded status uses $(error) icon')
    assert.equal(item.backgroundColor?.id, 'statusBarItem.errorBackground')
    assert.equal(registrations.warnings.length - warningBaseline, 1, 'exceeded prompts exactly once')
    const warning = registrations.warnings[warningBaseline]
    assert.ok(warning.items.includes('Reconfigure Index Roots'), 'prompt has reconfigure button')
    assert.match(warning.message, /hard maximum 5,000,000/, 'prompt carries budget message')

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
    service.snapshotValue.entryCount = 6_000_000
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
 * 真实 service 级 round trip（不 stub 状态机）：
 * 临时 workspace + 独立 storage -> 建索引 -> 通过公开的 updateFile 保存一个改动
 * -> 断言 delta 落盘（含 hash/include/condition 元数据）-> 不 compaction 直接重载（delta 重放）
 * -> flush（compaction）-> 重新 create service -> 符号/include/哈希/条件仍在。
 *
 * 这里也覆盖 Task 2 review 指出的时序风险：保存路径写的 delta v3 set 记录必须带
 * includes/哈希/条件，否则「base + delta 重放」会清空 include 边或丢条件。
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
    // 构建路径也写 v4 元数据：include 边 + 内容哈希
    assert.deepEqual(service.snapshot.includedFiles('a.c'), ['inc/x.h'], 'build resolves include edges')
    assert.equal(service.snapshot.isReachable('a.c', 'inc/x.h'), true)
    assert.deepEqual(service.snapshot.contentHashOf('a.c'), hashContent64(initialText))
    assert.equal(await snapshotDeltaBytes(deltaPath), 0, 'fresh build has no delta')

    // 走真实的公开保存路径（文件监听器最终也是调用 updateFile）。
    // 保存后文件新增 include inc/y.h 与一个 #ifdef 符号：直接验证 applyIncludes/条件/哈希。
    const savedText = [
      '#include "inc/x.h"',
      '#include "inc/y.h"',
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
    assert.deepEqual(savedSymbols.map((e) => e.name), ['beta', 'guarded'])
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
    assert.deepEqual(records[0]?.entries?.map((e) => e.name), ['beta', 'guarded'])
    assert.deepEqual(records[0]?.includes, ['inc/x.h', 'inc/y.h'], 'delta v3 record carries include targets')
    assert.equal(records[0]?.contentHashLo, hashContent64(savedText).lo, 'delta v3 record carries hash lo')
    assert.equal(records[0]?.contentHashHi, hashContent64(savedText).hi, 'delta v3 record carries hash hi')

    // 时序风险：不 compaction 直接重载 = base + delta 重放。元数据必须全部从 v3 记录还原。
    replayed = await SymbolService.create(context, logger)
    assert.equal(replayed.ready, true, 'service loads base + delta')
    const replayedSymbols = replayed.fileSymbols('a.c')
    assert.deepEqual(replayedSymbols.map((e) => e.name), ['beta', 'guarded'], 'symbols survive delta replay')
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
    assert.deepEqual(reloadedSymbols.map((e) => e.name), ['beta', 'guarded'], 'symbols survive reload')
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

  // package.json 声明 12 个命令（0.8.0 新增 si.showDefinitionCandidates），必须全部注册
  assert.equal(expectedCommands.length, 12, 'package.json declares 12 commands')
  assert.equal(registered.length, 12, 'all 12 declared commands are registered')

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
  console.log('  service round trip: updateFile -> delta v3 (hash/includes/condition) -> replay -> compaction -> reload OK')
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
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('SMOKE FAILED:', error && error.stack ? error.stack : error)
    process.exit(1)
  })
