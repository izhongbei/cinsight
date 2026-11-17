import test from 'node:test'
import assert from 'node:assert/strict'
import { conditionAt, scanConditions, scanSource } from '../src/core/scan'

test('scanConditions: nested ifdef with else/elif/endif', () => {
  const text = [
    '#ifdef A',            // 0
    'int x;',              // 1
    '#else',               // 2
    '#if defined(B) || C', // 3
    'int y;',              // 4
    '#endif',              // 5
    '#endif',              // 6
    'int z;',              // 7
  ].join('\n')
  const timeline = scanConditions(text)
  assert.equal(conditionAt(timeline, 1), '#ifdef A')
  assert.equal(conditionAt(timeline, 4), '#ifdef A && #if defined(B) || C')
  assert.equal(conditionAt(timeline, 7), undefined)
})

test('scanConditions: unmatched endif degrades without throwing', () => {
  const timeline = scanConditions('#endif\nint x;\n')
  assert.equal(conditionAt(timeline, 1), undefined)
})

test('scanConditions: long condition text is truncated', () => {
  const long = '#if ' + 'X && '.repeat(60) + 'Y'
  const timeline = scanConditions(`${long}\nint q;\n`)
  const condition = conditionAt(timeline, 1)
  assert.ok(condition && condition.length <= 120)
})

test('scanConditions: keeps only the innermost three nesting levels', () => {
  const text = [
    '#if A',
    '#if B',
    '#if C',
    '#if D',
    'int x;',
    '#endif',
    '#endif',
    '#endif',
    '#endif',
  ].join('\n')
  assert.equal(conditionAt(scanConditions(text), 4), '#if B && #if C && #if D')
})

test('scanSource: attaches condition per symbol and ignores fake directives in comments/strings', () => {
  const text = [
    '#ifdef REAL_CONFIG',
    'int inside_guard(void) { return 1; }',
    '#endif',
    '// #ifdef COMMENT_FAKE',
    'int after_comment(void) { return 2; }',
    'static const char *tag = "#ifdef STRING_FAKE";',
    'int after_string(void) { return 3; }',
  ].join('\n')
  const symbols = scanSource(text)
  const byName = new Map(symbols.map((symbol) => [symbol.name, symbol]))
  assert.equal(byName.get('inside_guard')?.condition, '#ifdef REAL_CONFIG')
  assert.equal(byName.get('after_comment')?.condition, undefined)
  assert.equal(byName.get('after_string')?.condition, undefined)
})
