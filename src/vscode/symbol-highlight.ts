/**
 * F8 符号高亮控制器（Source Insight 风格）。
 *
 * 行为：
 * - `toggle()`：光标处整词 -> 高亮当前文件内全部出现（忽略注释/字符串/字符字面量）；
 *   同一词再按一次 F8 清除。定义出现用绿色、其余引用用黄色。
 * - `next()` / `prev()`：在出现位置之间前后跳转（首尾循环）并 reveal 到视野中央。
 * - 状态栏：`$(symbol) <word> · N in file / M index refs`，M 由索引引用异步补齐（未就绪显示 …）。
 * - 清除条件：F8 切换、活动编辑器换成别的文档、文档关闭；文档编辑 150 ms 防抖后按同一词重扫。
 *
 * 所有 vscode API 都做了容错：极简宿主（mock/旧版本）缺少装饰/状态栏/事件 API 时
 * 只是退化为「不高亮」，绝不让异常冒到命令层。
 */
import * as vscode from 'vscode'

import { findWordOccurrences, type WordOccurrence } from '../core/word-occurrences'
import { onDidChangeConfig, readConfig } from './config'
import { resolveHighlightColorSpec, type DecorationColorSpec } from './highlight-colors'
import { sourceFileOf } from './providers/definition'
import type { SymbolService } from './service'
import {
  currentWord,
  executeCommand,
  showInformationMessage,
  type WordHit,
} from './util'

/** 文档编辑后重新扫描的防抖时间。 */
export const HIGHLIGHT_DEBOUNCE_MS = 150

/** 与 status.ts 的状态栏项同优先级，但靠右排在它后面。 */
const STATUS_PRIORITY = 100

/** 命令可订阅的上下文键：F3/Shift+F3 只在有高亮时接管。 */
export const HIGHLIGHT_CONTEXT_KEY = 'si.highlightActive'

export interface SymbolHighlighter extends vscode.Disposable {
  /** F8：高亮光标处整词；同一词再次调用则清除。 */
  toggle(): void
  /** F3：跳到当前文件内的下一个出现位置（循环）。 */
  next(): void
  /** Shift+F3：跳到上一个出现位置（循环）。 */
  prev(): void
  /** 清除高亮、状态栏与上下文键。 */
  clear(): void
}

function occurrenceKey(line: number, column: number): string {
  return `${line}:${column}`
}

class SymbolHighlighterController implements SymbolHighlighter {
  // 颜色配置变化时重建，故不是 readonly。
  private definitionDecoration: vscode.TextEditorDecorationType | undefined
  private referenceDecoration: vscode.TextEditorDecorationType | undefined
  private readonly statusItem: vscode.StatusBarItem | undefined
  private readonly disposables: vscode.Disposable[] = []

  private activeWordValue: string | undefined
  private activeUri: string | undefined
  /** 最近一次应用装饰的编辑器：清除时要显式清空它（visibleTextEditors 可能不含它）。 */
  private activeEditorRef: vscode.TextEditor | undefined
  private occurrences: WordOccurrence[] = []
  private definitionKeys = new Set<string>()
  /** 索引引用数文案；异步查询完成前是 `…`。 */
  private referenceText = '…'
  /** 词/会话代号：过期的异步引用结果直接丢弃。 */
  private generation = 0
  private debounceTimer: ReturnType<typeof setTimeout> | undefined
  private tokenSource: vscode.CancellationTokenSource | undefined
  private disposed = false

  constructor(private readonly service: SymbolService) {
    // 默认跟随主题（ThemeColor），配置了颜色覆盖时用固定 CSS 颜色。
    this.recreateDecorations()
    this.statusItem = createStatusItem()
    this.subscribeEvents()
  }

  // ---- 命令入口 ----

  toggle(): void {
    if (this.disposed) {
      return
    }
    const hit = currentWord()
    if (!hit) {
      if (this.activeWordValue !== undefined) {
        // 光标已不在词上时 F8 视为「关闭高亮」，比强行报错更符合直觉。
        this.clear()
        return
      }
      void showInformationMessage(
        vscode.l10n.t('Put the cursor on a symbol to highlight all its occurrences in the file.'),
      )
      return
    }
    if (this.activeWordValue === hit.word && this.activeUri === hit.document.uri.toString()) {
      this.clear()
      return
    }
    this.activate(hit)
  }

  next(): void {
    this.move(true)
  }

  prev(): void {
    this.move(false)
  }

  clear(): void {
    if (this.disposed) {
      return
    }
    const wasActive = this.activeWordValue !== undefined
    this.activeWordValue = undefined
    this.activeUri = undefined
    this.occurrences = []
    this.definitionKeys.clear()
    this.referenceText = '…'
    this.generation += 1
    this.cancelQuery()
    this.cancelDebounce()
    this.clearDecorations()
    try {
      this.statusItem?.hide()
    } catch (error) {
      console.error('[code-insight] cannot hide highlight status bar item', error)
    }
    if (wasActive) {
      this.setContext(false)
    }
  }

  dispose(): void {
    if (this.disposed) {
      return
    }
    this.clear()
    this.disposed = true
    for (const disposable of this.disposables) {
      try {
        disposable.dispose()
      } catch {
        // ignore
      }
    }
    this.disposables.length = 0
    this.disposeDecorationTypes()
    try {
      this.statusItem?.dispose()
    } catch {
      // ignore
    }
  }

  // ---- 颜色 / 装饰类型 ----

  /**
   * 按当前配置重建定义/引用两个装饰类型。
   * `ThemeColor` 由宿主按明/暗主题解析，所以主题切换无需监听；只有颜色配置变化时才重建。
   */
  private recreateDecorations(): void {
    this.disposeDecorationTypes()
    let definitionColor = ''
    let referenceColor = ''
    try {
      const config = readConfig()
      definitionColor = config.highlightDefinitionColor
      referenceColor = config.highlightReferenceColor
    } catch (error) {
      console.error('[code-insight] cannot read highlight colors', error)
    }
    this.definitionDecoration = createDecorationType(
      resolveHighlightColorSpec({ definitionColor, referenceColor, kind: 'definition' }),
    )
    this.referenceDecoration = createDecorationType(
      resolveHighlightColorSpec({ definitionColor, referenceColor, kind: 'reference' }),
    )
  }

  private disposeDecorationTypes(): void {
    try {
      this.definitionDecoration?.dispose()
    } catch {
      // ignore
    }
    try {
      this.referenceDecoration?.dispose()
    } catch {
      // ignore
    }
    this.definitionDecoration = undefined
    this.referenceDecoration = undefined
  }

  // ---- 激活 / 应用装饰 ----

  private activate(hit: WordHit): void {
    const editor = vscode.window.activeTextEditor
    if (!editor) {
      return
    }
    this.activeWordValue = hit.word
    this.activeUri = hit.document.uri.toString()
    this.activeEditorRef = editor
    this.referenceText = '…'
    this.definitionKeys = this.collectDefinitionKeys(hit.word, hit.document)
    const generation = ++this.generation
    this.cancelQuery()
    this.refreshDecorations()
    this.setContext(true)
    void this.loadReferenceCount(hit.word, generation)
  }

  /**
   * 重新扫描当前文档并应用装饰。
   * 文档编辑防抖、next/prev 前都会调用；活动编辑器已不是高亮文档时只清装饰，状态保留到
   * onDidChangeActiveTextEditor 统一 clear。
   */
  private refreshDecorations(): void {
    const word = this.activeWordValue
    if (!word || this.disposed) {
      return
    }
    const editor = this.currentEditor()
    if (!editor) {
      this.occurrences = []
      this.clearDecorations()
      this.updateStatusText()
      return
    }
    this.activeEditorRef = editor
    let text = ''
    try {
      text = editor.document.getText()
    } catch (error) {
      console.error('[code-insight] cannot read active document for highlight', error)
      text = ''
    }
    const occurrences = findWordOccurrences(text, word)
    this.occurrences = occurrences
    if (!this.definitionDecoration || !this.referenceDecoration) {
      this.updateStatusText()
      return
    }
    const definitions: vscode.Range[] = []
    const references: vscode.Range[] = []
    for (const occurrence of occurrences) {
      const range = new vscode.Range(
        occurrence.line,
        occurrence.column,
        occurrence.line,
        occurrence.column + word.length,
      )
      if (this.definitionKeys.has(occurrenceKey(occurrence.line, occurrence.column))) {
        definitions.push(range)
      } else {
        references.push(range)
      }
    }
    this.applyDecorations(editor, this.definitionDecoration, definitions)
    this.applyDecorations(editor, this.referenceDecoration, references)
    this.updateStatusText()
  }

  /** 收集「当前文件内」的定义出现位置（file/line/column 与索引定义精确匹配）。 */
  private collectDefinitionKeys(word: string, document: vscode.TextDocument): Set<string> {
    const keys = new Set<string>()
    const relative = sourceFileOf(this.service, document)
    if (!relative) {
      return keys
    }
    try {
      for (const entry of this.service.definitions(word)) {
        if (entry.file === relative) {
          keys.add(occurrenceKey(entry.line, entry.column))
        }
      }
    } catch (error) {
      console.error('[code-insight] highlight definition lookup failed', error)
    }
    return keys
  }

  private applyDecorations(
    editor: vscode.TextEditor,
    type: vscode.TextEditorDecorationType,
    ranges: vscode.Range[],
  ): void {
    try {
      editor.setDecorations(type, ranges)
    } catch (error) {
      console.error('[code-insight] cannot apply symbol highlight decorations', error)
    }
  }

  private clearDecorations(): void {
    const editors: vscode.TextEditor[] = []
    const seen = new Set<vscode.TextEditor>()
    const push = (editor: vscode.TextEditor | undefined): void => {
      if (editor && !seen.has(editor)) {
        seen.add(editor)
        editors.push(editor)
      }
    }
    push(this.activeEditorRef)
    try {
      push(vscode.window.activeTextEditor)
    } catch {
      // ignore
    }
    try {
      for (const editor of vscode.window.visibleTextEditors ?? []) {
        push(editor)
      }
    } catch {
      // ignore
    }
    for (const editor of editors) {
      if (this.definitionDecoration) {
        this.applyDecorations(editor, this.definitionDecoration, [])
      }
      if (this.referenceDecoration) {
        this.applyDecorations(editor, this.referenceDecoration, [])
      }
    }
    this.activeEditorRef = undefined
  }

  // ---- 状态栏 ----

  private updateStatusText(): void {
    if (this.disposed || !this.statusItem) {
      return
    }
    const word = this.activeWordValue
    if (word === undefined) {
      return
    }
    try {
      this.statusItem.text = vscode.l10n.t(
        '$(symbol) {0} · {1} in file / {2} index refs',
        word,
        String(this.occurrences.length),
        this.referenceText,
      )
      this.statusItem.tooltip = vscode.l10n.t(
        'All occurrences in the active file; comments and strings are ignored. F3 / Shift+F3 jump between matches, F8 clears.',
      )
      this.statusItem.command = 'si.highlightSymbol'
      this.statusItem.show()
    } catch (error) {
      console.error('[code-insight] cannot update highlight status bar item', error)
    }
  }

  /**
   * 索引引用数（全仓，不是本文件）：异步、可取消，词变化后用 generation 丢弃过期结果。
   * 查询期间显示 `…`，失败退化为 0。
   */
  private async loadReferenceCount(word: string, generation: number): Promise<void> {
    const token = this.newQueryToken()
    let count = 0
    try {
      const references = await this.service.references(word, token)
      if (this.disposed || generation !== this.generation || this.activeWordValue !== word) {
        return
      }
      count = references.length
    } catch (error) {
      if (this.disposed || generation !== this.generation || this.activeWordValue !== word) {
        return
      }
      count = 0
    }
    this.referenceText = String(count)
    this.updateStatusText()
  }

  // ---- next / prev ----

  private move(forward: boolean): void {
    if (this.disposed || this.activeWordValue === undefined) {
      return
    }
    const editor = this.currentEditor()
    if (!editor) {
      this.clear()
      return
    }
    // 编辑后可能还在防抖窗口内：先同步重扫，保证跳转基于最新文本。
    this.refreshDecorations()
    const word = this.activeWordValue
    if (!word || this.occurrences.length === 0) {
      return
    }
    // 光标/选中区参考点：选中的匹配区间 forward 用末尾（继续向后），backward 用开头
    // （避免 Shift+F3 在当前匹配的 selection 末尾又被算成「下一个」而原地打转）。
    const position = selectionReference(editor, forward)
    let target: WordOccurrence | undefined
    if (forward) {
      target = this.occurrences.find(
        (occurrence) =>
          occurrence.line > position.line ||
          (occurrence.line === position.line && occurrence.column > position.character),
      )
      if (!target) {
        target = this.occurrences[0]
      }
    } else {
      for (let index = this.occurrences.length - 1; index >= 0; index--) {
        const occurrence = this.occurrences[index]
        if (
          occurrence.line < position.line ||
          (occurrence.line === position.line && occurrence.column < position.character)
        ) {
          target = occurrence
          break
        }
      }
      if (!target) {
        target = this.occurrences[this.occurrences.length - 1]
      }
    }
    if (!target) {
      return
    }
    const start = new vscode.Position(target.line, target.column)
    const end = new vscode.Position(target.line, target.column + word.length)
    try {
      editor.selection = createSelection(start, end)
    } catch (error) {
      console.error('[code-insight] cannot select highlight occurrence', error)
    }
    try {
      editor.revealRange(new vscode.Range(start, end), revealType())
    } catch (error) {
      console.error('[code-insight] cannot reveal highlight occurrence', error)
    }
  }

  // ---- 事件 / 生命周期 ----

  private subscribeEvents(): void {
    // 两个高亮颜色配置变化：重建装饰类型并重新应用当前高亮（不重新查询索引引用数）。
    try {
      this.disposables.push(
        onDidChangeConfig((change) => {
          if (this.disposed || !change.affectsHighlight) {
            return
          }
          this.recreateDecorations()
          if (this.activeWordValue !== undefined) {
            this.refreshDecorations()
          }
        }),
      )
    } catch (error) {
      console.error('[code-insight] cannot subscribe highlight color changes', error)
    }
    try {
      if (typeof vscode.window.onDidChangeActiveTextEditor === 'function') {
        this.disposables.push(
          vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (this.activeUri === undefined) {
              return
            }
            const uri = editor?.document?.uri?.toString()
            if (uri !== this.activeUri) {
              this.clear()
            }
          }),
        )
      }
    } catch (error) {
      console.error('[code-insight] cannot subscribe active editor changes', error)
    }
    try {
      if (typeof vscode.workspace.onDidCloseTextDocument === 'function') {
        this.disposables.push(
          vscode.workspace.onDidCloseTextDocument((document) => {
            if (this.activeUri !== undefined && document?.uri?.toString() === this.activeUri) {
              this.clear()
            }
          }),
        )
      }
    } catch (error) {
      console.error('[code-insight] cannot subscribe document close', error)
    }
    try {
      if (typeof vscode.workspace.onDidChangeTextDocument === 'function') {
        this.disposables.push(
          vscode.workspace.onDidChangeTextDocument((event) => {
            if (
              this.activeUri !== undefined &&
              event?.document?.uri?.toString() === this.activeUri
            ) {
              this.scheduleRefresh()
            }
          }),
        )
      }
    } catch (error) {
      console.error('[code-insight] cannot subscribe document changes', error)
    }
  }

  private scheduleRefresh(): void {
    if (this.disposed) {
      return
    }
    this.cancelDebounce()
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined
      this.refreshDecorations()
    }, HIGHLIGHT_DEBOUNCE_MS)
    try {
      this.debounceTimer.unref?.()
    } catch {
      // 某些宿主不提供 unref
    }
  }

  private cancelDebounce(): void {
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = undefined
    }
  }

  private currentEditor(): vscode.TextEditor | undefined {
    if (this.activeUri === undefined) {
      return undefined
    }
    try {
      const editor = vscode.window.activeTextEditor
      if (editor && editor.document?.uri?.toString() === this.activeUri) {
        return editor
      }
    } catch {
      // ignore
    }
    return undefined
  }

  private setContext(active: boolean): void {
    void executeCommand('setContext', HIGHLIGHT_CONTEXT_KEY, active)
  }

  private newQueryToken(): vscode.CancellationToken | undefined {
    this.cancelQuery()
    try {
      const ctor = (
        vscode as unknown as {
          CancellationTokenSource?: new () => vscode.CancellationTokenSource
        }
      ).CancellationTokenSource
      if (typeof ctor === 'function') {
        const source = new ctor()
        this.tokenSource = source
        return source.token
      }
    } catch (error) {
      console.error('[code-insight] cannot create cancellation token for highlight', error)
    }
    return undefined
  }

  private cancelQuery(): void {
    const source = this.tokenSource
    this.tokenSource = undefined
    try {
      source?.cancel()
    } catch {
      // ignore
    }
    try {
      source?.dispose()
    } catch {
      // ignore
    }
  }
}

/** 创建 F8 高亮控制器；扩展激活时创建一次，命令层共享同一实例。 */
export function createSymbolHighlighter(service: SymbolService): SymbolHighlighter {
  return new SymbolHighlighterController(service)
}

// ---- vscode 容错辅助 ----

/**
 * 主题色 ID -> `ThemeColor`；宿主缺少 ThemeColor（极简 mock/旧版本）时退化为普通字符串，
 * 仍能高亮，只是不再随主题变化。
 */
function themeColorOrId(id: string | undefined): vscode.ThemeColor | string | undefined {
  if (id === undefined) {
    return undefined
  }
  try {
    const ctor = (vscode as unknown as { ThemeColor?: new (id: string) => vscode.ThemeColor })
      .ThemeColor
    if (typeof ctor === 'function') {
      return new ctor(id)
    }
  } catch (error) {
    console.error('[code-insight] cannot create ThemeColor for highlight', error)
  }
  return id
}

/** 把纯颜色规格转成装饰类型选项：字符串覆盖优先，否则用主题色。 */
function decorationOptions(spec: DecorationColorSpec): vscode.DecorationRenderOptions {
  const background = spec.backgroundColor ?? themeColorOrId(spec.themeBackground)
  const border = spec.borderColor ?? themeColorOrId(spec.themeBorder)
  const overview = spec.overviewRulerColor ?? themeColorOrId(spec.themeBorder)
  const options: vscode.DecorationRenderOptions = { borderRadius: '2px' }
  if (background !== undefined) {
    options.backgroundColor = background
  }
  if (border !== undefined) {
    options.borderColor = border
    options.borderWidth = '1px'
    options.borderStyle = 'solid'
  }
  if (overview !== undefined) {
    options.overviewRulerColor = overview
  }
  return options
}

function createDecorationType(
  spec: DecorationColorSpec,
): vscode.TextEditorDecorationType | undefined {
  try {
    if (typeof vscode.window.createTextEditorDecorationType !== 'function') {
      return undefined
    }
    return vscode.window.createTextEditorDecorationType(decorationOptions(spec))
  } catch (error) {
    console.error('[code-insight] cannot create highlight decoration type', error)
    return undefined
  }
}

function createStatusItem(): vscode.StatusBarItem | undefined {
  try {
    if (typeof vscode.window.createStatusBarItem !== 'function') {
      return undefined
    }
    const alignment =
      (vscode.StatusBarAlignment as unknown as Record<string, number> | undefined)?.Right ?? 2
    return vscode.window.createStatusBarItem(
      alignment as unknown as vscode.StatusBarAlignment,
      STATUS_PRIORITY,
    )
  } catch (error) {
    console.error('[code-insight] cannot create highlight status bar item', error)
    return undefined
  }
}

/** 跳转参考点：向前取选中区末尾，向后取开头；空选时两者相同。 */
function selectionReference(editor: vscode.TextEditor, forward: boolean): vscode.Position {
  try {
    const selection = editor.selection
    if (selection) {
      const reference = forward ? selection.end : selection.start
      if (reference) {
        return reference
      }
      if (selection.active) {
        return selection.active
      }
    }
  } catch {
    // ignore
  }
  return new vscode.Position(0, 0)
}

/** `vscode.Selection` 在 mock/极简宿主可能不存在：退化为同时带 anchor/active 的 Range。 */
function createSelection(start: vscode.Position, end: vscode.Position): vscode.Selection {
  try {
    const ctor = (
      vscode as unknown as {
        Selection?: new (anchor: vscode.Position, active: vscode.Position) => vscode.Selection
      }
    ).Selection
    if (typeof ctor === 'function') {
      const selection = new ctor(start, end)
      if (selection && selection.active) {
        return selection
      }
    }
  } catch {
    // 继续走 Range 兜底
  }
  return {
    anchor: start,
    active: end,
    start,
    end,
    isEmpty: start.line === end.line && start.character === end.character,
  } as unknown as vscode.Selection
}

function revealType(): vscode.TextEditorRevealType {
  try {
    const types = vscode.TextEditorRevealType as unknown as Record<string, number> | undefined
    const inCenter = types?.InCenter
    if (typeof inCenter === 'number') {
      return inCenter as unknown as vscode.TextEditorRevealType
    }
  } catch {
    // ignore
  }
  return 2 as unknown as vscode.TextEditorRevealType
}
