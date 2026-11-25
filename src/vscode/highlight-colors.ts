/**
 * F8 符号高亮的颜色解析（纯函数，**不依赖 vscode**，便于单测）。
 *
 * 默认颜色跟随 VS Code 主题：直接使用主题色 ID，由 `new vscode.ThemeColor(id)` 交给宿主
 * 按当前明/暗主题着色；配置了自定义 CSS 颜色时三处颜色（背景/边框/概览标尺）统一用该颜色。
 * 空字符串或纯空白视为「未配置」，仍使用主题色。
 */

/** 装饰类型需要的颜色：字符串 = 固定 CSS 颜色；theme* = 主题色 ID（由调用方转成 ThemeColor）。 */
export interface DecorationColorSpec {
  readonly backgroundColor?: string
  readonly borderColor?: string
  readonly overviewRulerColor?: string
  readonly themeBackground?: string
  readonly themeBorder?: string
}

/** 定义出现的默认主题色：与编辑器「查找匹配」同色，随主题变化。 */
export const DEFINITION_THEME_BACKGROUND = 'editor.findMatchBackground'
export const DEFINITION_THEME_BORDER = 'editor.findMatchBorder'

/** 引用出现的默认主题色：与编辑器「查找匹配高亮」同色，随主题变化。 */
export const REFERENCE_THEME_BACKGROUND = 'editor.findMatchHighlightBackground'
export const REFERENCE_THEME_BORDER = 'editor.findMatchHighlightBorder'

export interface HighlightColorOptions {
  /** `sourceInsight.highlightDefinitionColor` 的原始值；空 = 用主题色。 */
  readonly definitionColor?: string
  /** `sourceInsight.highlightReferenceColor` 的原始值；空 = 用主题色。 */
  readonly referenceColor?: string
  readonly kind: 'definition' | 'reference'
}

/** 去掉首尾空白；空串 / 非字符串都返回 undefined，表示没有有效覆盖。 */
function normalizeColor(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * 解析某一类高亮的颜色规格：
 * - 覆盖值是有效字符串：背景 / 边框 / 概览标尺都用它；
 * - 否则返回该类的主题色 ID（定义 -> findMatch*，引用 -> findMatchHighlight*）。
 */
export function resolveHighlightColorSpec(options: HighlightColorOptions): DecorationColorSpec {
  const override = normalizeColor(
    options.kind === 'definition' ? options.definitionColor : options.referenceColor,
  )
  if (override !== undefined) {
    return {
      backgroundColor: override,
      borderColor: override,
      overviewRulerColor: override,
    }
  }
  return options.kind === 'definition'
    ? { themeBackground: DEFINITION_THEME_BACKGROUND, themeBorder: DEFINITION_THEME_BORDER }
    : { themeBackground: REFERENCE_THEME_BACKGROUND, themeBorder: REFERENCE_THEME_BORDER }
}
