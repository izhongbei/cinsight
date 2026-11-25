/**
 * `resolveHighlightColorSpec`：F8 高亮颜色解析。
 *
 * 纯函数测试：本文件不引入任何 vscode mock，模块本身也不依赖 vscode，
 * 因此能直接 import 即证明「无 vscode 依赖」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFINITION_THEME_BACKGROUND,
  DEFINITION_THEME_BORDER,
  REFERENCE_THEME_BACKGROUND,
  REFERENCE_THEME_BORDER,
  resolveHighlightColorSpec,
  type DecorationColorSpec,
} from '../src/vscode/highlight-colors'

const definitionTheme: DecorationColorSpec = {
  themeBackground: DEFINITION_THEME_BACKGROUND,
  themeBorder: DEFINITION_THEME_BORDER,
}

const referenceTheme: DecorationColorSpec = {
  themeBackground: REFERENCE_THEME_BACKGROUND,
  themeBorder: REFERENCE_THEME_BORDER,
}

test('highlight-colors: definition default follows the theme', () => {
  assert.deepEqual(
    resolveHighlightColorSpec({ kind: 'definition' }),
    definitionTheme,
  )
  assert.equal(DEFINITION_THEME_BACKGROUND, 'editor.findMatchBackground')
  assert.equal(DEFINITION_THEME_BORDER, 'editor.findMatchBorder')
})

test('highlight-colors: reference default follows the theme', () => {
  assert.deepEqual(
    resolveHighlightColorSpec({ kind: 'reference' }),
    referenceTheme,
  )
  assert.equal(REFERENCE_THEME_BACKGROUND, 'editor.findMatchHighlightBackground')
  assert.equal(REFERENCE_THEME_BORDER, 'editor.findMatchHighlightBorder')
})

test('highlight-colors: definition override sets background, border and overview ruler', () => {
  assert.deepEqual(
    resolveHighlightColorSpec({
      definitionColor: '#2ea04366',
      referenceColor: 'rgba(255,196,0,0.25)',
      kind: 'definition',
    }),
    {
      backgroundColor: '#2ea04366',
      borderColor: '#2ea04366',
      overviewRulerColor: '#2ea04366',
    },
  )
})

test('highlight-colors: reference override is independent from the definition override', () => {
  assert.deepEqual(
    resolveHighlightColorSpec({
      definitionColor: '#2ea04366',
      referenceColor: 'rgba(255,196,0,0.4)',
      kind: 'reference',
    }),
    {
      backgroundColor: 'rgba(255,196,0,0.4)',
      borderColor: 'rgba(255,196,0,0.4)',
      overviewRulerColor: 'rgba(255,196,0,0.4)',
    },
  )
  // 只有另一类的颜色被覆盖时，本类仍用主题色。
  assert.deepEqual(
    resolveHighlightColorSpec({ definitionColor: '#2ea04366', kind: 'reference' }),
    referenceTheme,
  )
})

test('highlight-colors: whitespace-only and missing overrides fall back to the theme', () => {
  for (const value of ['', '   ', '\t\n ', undefined]) {
    assert.deepEqual(
      resolveHighlightColorSpec({ definitionColor: value, referenceColor: value, kind: 'definition' }),
      definitionTheme,
      `definition fallback for ${JSON.stringify(value)}`,
    )
    assert.deepEqual(
      resolveHighlightColorSpec({ definitionColor: value, referenceColor: value, kind: 'reference' }),
      referenceTheme,
      `reference fallback for ${JSON.stringify(value)}`,
    )
  }
})

test('highlight-colors: override is trimmed before use', () => {
  assert.deepEqual(resolveHighlightColorSpec({ definitionColor: '  #123456  ', kind: 'definition' }), {
    backgroundColor: '#123456',
    borderColor: '#123456',
    overviewRulerColor: '#123456',
  })
})
