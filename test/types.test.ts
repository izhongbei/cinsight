/**
 * 类型符号（struct / union / enum 标签、typedef 名字）的解析与可跳转性测试。
 * 覆盖匿名结构体、函数指针 typedef、多重声明符、前置声明、属性宏、成员不索引等。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { scanSource } from '../src/core/scan'

function summarize(text: string): Array<[string, string, number, number]> {
  return scanSource(text).map((symbol) => [symbol.name, symbol.kind, symbol.line, symbol.endLine])
}

test('types: struct definition with body', () => {
  assert.deepEqual(summarize('struct point {\n  int x;\n  int y;\n};'), [['point', 'struct', 0, 3]])
})

test('types: union and enum definitions', () => {
  assert.deepEqual(summarize('union value { int i; float f; };'), [['value', 'union', 0, 0]])
  assert.deepEqual(summarize('enum color { RED, GREEN, BLUE };'), [['color', 'enum', 0, 0]])
})

test('types: forward declaration is indexed as declaration, usage is not', () => {
  const text = ['struct opaque;', 'struct opaque *ptr;', 'struct opaque **fn(struct opaque *);'].join('\n')
  assert.deepEqual(
    scanSource(text).map((symbol) => [symbol.name, symbol.kind, symbol.line]),
    [
      ['opaque', 'declaration', 0],
      ['fn', 'declaration', 2],
    ],
  )
})

test('types: typedef of anonymous struct', () => {
  assert.deepEqual(summarize('typedef struct {\n  int a;\n} foo_t;'), [['foo_t', 'typedef', 2, 2]])
})

test('types: typedef alias of a tagged struct', () => {
  assert.deepEqual(
    summarize('typedef struct bar {\n  int a;\n} bar_t;'),
    [
      ['bar', 'struct', 0, 2],
      ['bar_t', 'typedef', 2, 2],
    ],
  )
})

test('types: function pointer typedef', () => {
  assert.deepEqual(
    summarize('typedef void (*handler_t)(int code, void *ctx);'),
    [['handler_t', 'typedef', 0, 0]],
  )
})

test('types: typedef of a function type', () => {
  assert.deepEqual(summarize('typedef int compare_fn(const void *a, const void *b);'), [['compare_fn', 'typedef', 0, 0]])
})

test('types: multiple declarators in one typedef', () => {
  assert.deepEqual(
    summarize('typedef unsigned int u32, *pu32, u32_arr[4];'),
    [
      ['u32', 'typedef', 0, 0],
      ['pu32', 'typedef', 0, 0],
      ['u32_arr', 'typedef', 0, 0],
    ],
  )
})

test('types: struct with attribute between tag and body', () => {
  assert.deepEqual(
    summarize('struct __attribute__((packed)) packed_s {\n  int a;\n};'),
    [['packed_s', 'struct', 0, 2]],
  )
})

test('types: members are not indexed as symbols', () => {
  const text = 'struct ctx {\n  int state;\n  void *data;\n  void (*cb)(int);\n};'
  assert.deepEqual(
    scanSource(text).map((symbol) => symbol.name),
    ['ctx'],
  )
})

test('types: types declared inside function bodies are not indexed', () => {
  const text = 'void f(void) {\n  struct inner { int a; };\n  typedef int local_t;\n}'
  assert.deepEqual(
    scanSource(text).map((symbol) => [symbol.name, symbol.kind]),
    [['f', 'function']],
  )
})

test('types: comments and strings mentioning struct/typedef are ignored', () => {
  const text = ['/* struct fake { int a; }; */', 'const char *s = "typedef int fake_t;";', 'struct real { int a; };'].join('\n')
  assert.deepEqual(
    scanSource(text).map((symbol) => symbol.name),
    ['real'],
  )
})

test('types: macro lines do not confuse type scanning', () => {
  const text = ['#define DECLARE(n) struct n { int a; }', 'struct real_s { int a; };'].join('\n')
  assert.deepEqual(
    scanSource(text).map((symbol) => [symbol.name, symbol.kind]),
    [
      ['DECLARE', 'macro'],
      ['real_s', 'struct'],
    ],
  )
})

test('types: typedef ending on its own line reports the semicolon line as endLine', () => {
  assert.deepEqual(
    summarize('typedef struct {\n  int a;\n} multi_line_t\n;'),
    [['multi_line_t', 'typedef', 2, 3]],
  )
})
