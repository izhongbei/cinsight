import test from 'node:test'
import assert from 'node:assert/strict'
import { scanGlobals } from '../src/core/scan'

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
