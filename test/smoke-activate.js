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
    showInformationMessage: async () => undefined,
    showWarningMessage: async (message, ...items) => {
      registrations.warnings.push({ message, items })
      return registrations.warningChoice
    },
    showErrorMessage: async () => undefined,
    showQuickPick: async (items) => (Array.isArray(items) ? items[0] : undefined),
    showInputBox: async () => undefined,
    showTextDocument: async (document) => ({
      document: document && document.getText ? document : new TextDocument(Uri.file('/tmp/x.c'), ''),
      selection: undefined,
      revealRange: () => {},
    }),
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
 * 真实 service 级 round trip（不 stub 状态机）：
 * 临时 workspace + 独立 storage -> 建索引 -> 通过公开的 updateFile 保存一个改动
 * -> 断言 delta 落盘 -> flush（compaction）-> 重新 create service -> 符号仍在。
 */
async function checkServiceRoundTrip() {
  const dist = path.join(EXT_ROOT, 'dist')
  const { SymbolService } = require(path.join(dist, 'src/vscode/service.js'))
  const { snapshotDeltaBytes, snapshotDeltaPath, readSnapshotDeltas } = require(
    path.join(dist, 'src/core/snapshot-delta.js'),
  )

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'si-smoke-roundtrip-'))
  const workspace = path.join(dir, 'ws')
  const storage = path.join(dir, 'storage')
  fs.mkdirSync(workspace, { recursive: true })
  fs.mkdirSync(storage, { recursive: true })
  const sourceFile = path.join(workspace, 'a.c')
  fs.writeFileSync(sourceFile, 'int alpha(void) { return 1; }\n', 'utf8')

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
  let reloaded
  try {
    service = await SymbolService.create(context, logger)
    const summary = await service.rebuild()
    assert.ok(summary, 'service rebuild returns a summary')
    assert.equal(service.ready, true)
    assert.deepEqual(service.fileSymbols('a.c').map((e) => e.name), ['alpha'])
    assert.equal(await snapshotDeltaBytes(deltaPath), 0, 'fresh build has no delta')

    // 走真实的公开保存路径（文件监听器最终也是调用 updateFile）。
    fs.writeFileSync(sourceFile, 'int beta(void) { return 2; }\n', 'utf8')
    const future = new Date(Date.now() + 1000)
    fs.utimesSync(sourceFile, future, future)
    await service.updateFile(sourceFile)

    assert.deepEqual(service.fileSymbols('a.c').map((e) => e.name), ['beta'])
    assert.ok((await snapshotDeltaBytes(deltaPath)) > 0, 'incremental save appends a delta record')
    const records = await readSnapshotDeltas(deltaPath)
    assert.equal(records.length, 1, 'one delta record for one save')
    assert.equal(records[0]?.kind, 'set')
    assert.deepEqual(records[0]?.entries?.map((e) => e.name), ['beta'])

    await service.flush()
    assert.equal(await snapshotDeltaBytes(deltaPath), 0, 'flush compacts the delta into the base')

    // 真实重载（base，无 delta）：符号必须在重启后仍然存在。
    reloaded = await SymbolService.create(context, logger)
    assert.equal(reloaded.ready, true, 'reloaded service loads the snapshot')
    assert.deepEqual(reloaded.fileSymbols('a.c').map((e) => e.name), ['beta'], 'symbol survives reload')
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

  // package.json 中声明了哪些命令，就至少注册哪些
  assert.ok(registered.length >= expectedCommands.length, 'command count')

  const providerKinds = new Set(registrations.providers.map(([kind]) => kind))
  for (const kind of ['definition', 'references', 'hover', 'documentSymbol', 'workspaceSymbol', 'callHierarchy']) {
    assert.ok(providerKinds.has(kind), `missing provider: ${kind}`)
  }

  assert.ok(registrations.treeViews.some(([id]) => id === 'si.symbols'), 'si.symbols tree view')
  assert.ok(registrations.statusBar >= 1, 'status bar item')

  await checkBudgetUi()
  await checkAutoCompactFlush()
  await checkServiceRoundTrip()
  await checkDeltaConflict()

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
  console.log('  autoCompact=false: flush/dispose skip compaction, delta append awaited OK')
  console.log('  service round trip: updateFile -> delta -> flush -> reload keeps the symbol OK')
  console.log('  shared-storage conflict: compaction/rebuild keep the other window delta OK')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('SMOKE FAILED:', error && error.stack ? error.stack : error)
    process.exit(1)
  })
