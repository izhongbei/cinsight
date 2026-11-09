#!/usr/bin/env node
/**
 * 用 mock 的 `vscode` 模块加载编译产物并执行 activate()，验证：
 *  - extension.js 可加载、activate 不抛异常
 *  - 所有 package.json 声明的命令都被注册
 *  - 语言 Provider 注册数量符合预期
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

const EXT_ROOT = path.resolve(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(EXT_ROOT, 'package.json'), 'utf8'))

// ---------------------------------------------------------------------------
// 最小 vscode mock
// ---------------------------------------------------------------------------
const registrations = { commands: [], providers: [], treeViews: [], statusBar: 0 }
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
    return full in configurationValues ? configurationValues[full] : fallback
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
    executeCommand: async () => undefined,
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
      return {
        text: '', tooltip: undefined, command: undefined, show() {}, hide() {}, dispose() {},
      }
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
    showWarningMessage: async () => undefined,
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
  extension: { id: 'local.source-insight-c', packageJSON: pkg },
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
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('SMOKE FAILED:', error && error.stack ? error.stack : error)
    process.exit(1)
  })
