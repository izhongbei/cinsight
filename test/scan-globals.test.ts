import test from 'node:test'
import assert from 'node:assert/strict'
import { scanGlobals, scanSource } from '../src/core/scan'

test('scanGlobals: file-scope variables only, skip functions/typedefs/params', () => {
  const text = [
    'static int counter;',
    'extern const char *g_name;',
    'unsigned char table[16] = {0};',
    'int a, b;',
    'static void helper(int local) { int inner; }',
    'typedef struct { int x; } point_t;',
  ].join('\n')
  const globals = scanGlobals(text)
  assert.deepEqual(globals.map((g) => g.name), ['counter', 'g_name', 'table', 'a', 'b'])
  assert.ok(globals.every((g) => g.kind === 'variable' && g.parent === undefined))
})

test('scanGlobals: function pointers, attributes and initialisers keep the declared name', () => {
  const text = [
    'void (*fp)(void) = baz;',
    'static const char *names[] = { "a", "b" };',
    'int value __attribute__((unused));',
    'static int x = foo(1);',
    'int (*handlers[4])(void);',
  ].join('\n')
  assert.deepEqual(scanGlobals(text).map((g) => g.name), ['fp', 'names', 'value', 'x', 'handlers'])
})

test('scanGlobals: struct usages are variables, forward declarations are not', () => {
  const text = [
    'struct point origin;',
    'struct opaque;',
    'struct opaque *handle;',
    'enum color current;',
  ].join('\n')
  assert.deepEqual(scanGlobals(text).map((g) => [g.name, g.line]), [
    ['origin', 0],
    ['handle', 2],
    ['current', 3],
  ])
})

test('scanGlobals: every initialised declarator in a multi-declarator statement is indexed', () => {
  const text = [
    'int a = 1, b = 2;',
    'static const int x = 1, y = 2, *z;',
    'static u32 g_A = 0, g_B = 0, g_C = 0;',
    'int t[] = {1,2,3}, u = 4;',
    'int p = f(1, 2), q = 3;',
    'int f(int a, int b);',
  ].join('\n')
  assert.deepEqual(scanGlobals(text).map((g) => [g.name, g.line, g.endLine]), [
    ['a', 0, 0],
    ['b', 0, 0],
    ['x', 1, 1],
    ['y', 1, 1],
    ['z', 1, 1],
    ['g_A', 2, 2],
    ['g_B', 2, 2],
    ['g_C', 2, 2],
    ['t', 3, 3],
    ['u', 3, 3],
    ['p', 4, 4],
    ['q', 4, 4],
  ])
})

test('scanGlobals: extern/const/static and multi-line declarations', () => {
  const text = [
    'static const unsigned int',
    'g_limit = 10;',
    'extern int errno;',
    'const char *const g_names[2] = { 0 };',
  ].join('\n')
  assert.deepEqual(scanGlobals(text).map((g) => [g.name, g.line, g.endLine]), [
    ['g_limit', 1, 1],
    ['errno', 2, 2],
    ['g_names', 3, 3],
  ])
})

test('scanGlobals: typedef after a struct-returning definition is not indexed', () => {
  const text = 'struct point *make(void) { return 0; }\ntypedef int foo_t;'
  assert.deepEqual(scanGlobals(text), [])
  // scanSource：typedef foo_t 只出现一次，且不产生伪造的 variable foo_t
  const symbols = scanSource(text)
  assert.ok(symbols.some((s) => s.name === 'make' && s.kind === 'function'))
  assert.deepEqual(symbols.filter((s) => s.name === 'foo_t').map((s) => s.kind), ['typedef'])
  assert.deepEqual(symbols.filter((s) => s.kind === 'variable'), [])
})

test('scanGlobals: typedef variants after struct/union/enum-returning definitions', () => {
  const cases: Array<{ head: string; tail: string; typedefs: string[] }> = [
    {
      head: 'struct point *make(void) { return 0; }',
      tail: 'typedef int a_t, b_t;',
      typedefs: ['a_t', 'b_t'],
    },
    {
      head: 'union value *make(void) { return 0; }',
      tail: 'typedef enum { X } E;',
      typedefs: ['E'],
    },
    {
      head: 'enum color get(void) { return 0; }',
      tail: 'typedef void (*cb_t)(int);',
      typedefs: ['cb_t'],
    },
  ]
  for (const { head, tail, typedefs } of cases) {
    const text = `${head}\n${tail}`
    assert.deepEqual(scanGlobals(text), [], `typedef 之后的函数定义不应产生全局变量：${tail}`)
    const symbols = scanSource(text)
    assert.deepEqual(symbols.filter((s) => s.kind === 'variable'), [])
    assert.deepEqual(symbols.filter((s) => s.kind === 'typedef').map((s) => s.name), typedefs)
  }
})

test('scanGlobals: real globals after a struct-returning definition are still indexed', () => {
  const text = [
    'struct point *make(void) { return 0; }',
    'int g;',
    'static struct point *origin;',
    'struct point *make2(void) { return 0; } int h;',
  ].join('\n')
  assert.deepEqual(scanGlobals(text).map((g) => [g.name, g.line]), [
    ['g', 1],
    ['origin', 2],
    ['h', 3],
  ])
})

test('scanGlobals: locals inside a struct-returning body are still ignored', () => {
  const text = [
    'enum color get(void) {',
    '  typedef int inner_t;',
    '  struct local { int x; } v;',
    '  int local_var = 1;',
    '  return 0;',
    '}',
    'typedef int foo_t;',
    'int g;',
  ].join('\n')
  assert.deepEqual(scanGlobals(text).map((g) => g.name), ['g'])
})

test('scanGlobals: mixed function declarator and variables in one statement', () => {
  // 当前语义：函数声明符自身跳过，但同语句的普通声明符仍索引（语句级整条跳过已不再成立）
  assert.deepEqual(scanGlobals('int a, f(void);').map((g) => g.name), ['a'])
  assert.deepEqual(scanGlobals('int (*fp)(void), x;').map((g) => g.name), ['fp', 'x'])
})

test('scanGlobals: trailing kernel attribute macros are not the declared name', () => {
  const text = [
    'static int foo __read_mostly;',
    'char *buf __packed;',
    'unsigned long mask __aligned(8);',
    'static int tagged __section(".data");',
    'static int plain;',
  ].join('\n')
  const globals = scanGlobals(text)
  assert.deepEqual(globals.map((g) => [g.name, g.kind, g.line]), [
    ['foo', 'variable', 0],
    ['buf', 'variable', 1],
    ['mask', 'variable', 2],
    ['tagged', 'variable', 3],
    ['plain', 'variable', 4],
  ])
  // 以 __ 开头的真实变量名（没有前置声明符名）仍然保留
  assert.deepEqual(scanGlobals('int __pad;').map((g) => g.name), ['__pad'])
})
