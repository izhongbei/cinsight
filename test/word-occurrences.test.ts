/**
 * `findWordOccurrences`：F8 高亮的纯 core 位置检索。
 * 重点覆盖注释/字符串/字符字面量排除、整词边界与同一行多次出现。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { findWordOccurrences } from '../src/core/word-occurrences'

function positions(text: string, word = 'foo'): Array<[number, number]> {
  return findWordOccurrences(text, word).map((occurrence) => [occurrence.line, occurrence.column])
}

test('word-occurrences: finds whole-word matches in normal code', () => {
  const text = ['int foo(int x) {', '  return foo(x);', '}'].join('\n')
  assert.deepEqual(positions(text), [
    [0, 4],
    [1, 9],
  ])
})

test('word-occurrences: ignores line comments (including trailing ones)', () => {
  const text = ['// foo is not code', 'int foo; // foo again', '/* foo */ int foo;'].join('\n')
  assert.deepEqual(positions(text), [
    [1, 4],
    [2, 14],
  ])
})

test('word-occurrences: ignores block comments across lines', () => {
  const text = ['/*', ' foo', '*/', 'int foo;', 'int x; /* foo', '   foo */ foo();'].join('\n')
  assert.deepEqual(positions(text), [
    [3, 4],
    [5, 10],
  ])
})

test('word-occurrences: ignores string and character literals', () => {
  const text = [
    'const char *s = "foo";',
    "char c = 'foo';",
    'char *t = "a\\"foo";',
    'int foo;',
  ].join('\n')
  assert.deepEqual(positions(text), [[3, 4]])
})

test('word-occurrences: finds names on macro definition lines', () => {
  const text = ['#define NAME foo', 'int x = NAME; /* foo */', '#define FOO(x) ((x) + foo)'].join(
    '\n',
  )
  assert.deepEqual(positions(text), [
    [0, 13],
    [2, 22],
  ])
})

test('word-occurrences: honours word boundaries', () => {
  const text = ['foo foobar', '_foo foo1 1foo foo_bar', 'FOO foo Foo', 'foo'].join('\n')
  assert.deepEqual(positions(text), [
    [0, 0],
    [2, 4],
    [3, 0],
  ])
})

test('word-occurrences: is case-sensitive', () => {
  assert.deepEqual(positions('FOO Foo fOo foo', 'foo'), [[0, 12]])
  assert.deepEqual(positions('FOO Foo foo', 'FOO'), [[0, 0]])
})

test('word-occurrences: reports every occurrence on one line', () => {
  const text = 'foo + foo + foo; foo2\n'
  assert.deepEqual(positions(text), [
    [0, 0],
    [0, 6],
    [0, 12],
  ])
})

test('word-occurrences: counts tabs as one column and keeps CRLF line numbers', () => {
  assert.deepEqual(positions('\tfoo\tfoo\n'), [
    [0, 1],
    [0, 5],
  ])
  assert.deepEqual(positions('int foo;\r\nfoo();\r\n'), [
    [0, 4],
    [1, 0],
  ])
})

test('word-occurrences: handles an empty or absent word', () => {
  assert.deepEqual(findWordOccurrences('int foo;', ''), [])
  assert.deepEqual(findWordOccurrences('', 'foo'), [])
  assert.deepEqual(findWordOccurrences('int bar;', 'foo'), [])
})

test('word-occurrences: matches a definition that sits inside #ifdef code', () => {
  const text = ['#ifdef CFG_FOO', 'int foo(void);', '#endif', '// foo'].join('\n')
  assert.deepEqual(positions(text), [[1, 4]])
})

test('word-occurrences: comments/strings never shift subsequent columns', () => {
  const text = '"foo" /* foo */ foo'
  assert.deepEqual(positions(text), [[0, 16]])
})
