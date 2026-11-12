import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanSource } from '../src/core/scan'
import type { ScannedSymbol } from '../src/shared/types'

function pick(symbols: ScannedSymbol[]) {
  return symbols.map((s) => ({
    name: s.name,
    kind: s.kind,
    line: s.line,
    endLine: s.endLine,
    column: s.column,
  }))
}

// ------------------------------------------------------- basic definitions

test('parser: single line function definition', () => {
  assert.deepEqual(pick(scanSource('int foo(int a) { return a; }')), [
    { name: 'foo', kind: 'function', line: 0, endLine: 0, column: 4 },
  ])
})

test('parser: multi-line signature keeps name line and closing brace line', () => {
  const text = [
    'static int',
    'foo(',
    '  const char *name,',
    '  u32 flags',
    ')',
    '{',
    '  return 0;',
    '}',
  ].join('\n')
  // 名字在第 1 行；函数体结束（配对 } 所在行）在第 7 行。
  assert.deepEqual(pick(scanSource(text)), [
    { name: 'foo', kind: 'function', line: 1, endLine: 7, column: 0 },
  ])
})

test('parser: declaration and definition of the same name both indexed', () => {
  const text = 'int foo(void);\nint foo(void) { return 0; }'
  assert.deepEqual(pick(scanSource(text)), [
    { name: 'foo', kind: 'declaration', line: 0, endLine: 0, column: 4 },
    { name: 'foo', kind: 'function', line: 1, endLine: 1, column: 4 },
  ])
})

// -------------------------------------------------------------- interference

test('parser: block comment content is ignored', () => {
  const text = '/* int fake(void) { } */\nint real(void) { return 0; }'
  assert.deepEqual(pick(scanSource(text)), [
    { name: 'real', kind: 'function', line: 1, endLine: 1, column: 4 },
  ])
})

test('parser: multi-line block comment keeps line numbers stable', () => {
  const text = ['int a;', '/* comment', '   int fake(void) { }', '*/', 'int real(void) { }'].join('\n')
  assert.deepEqual(pick(scanSource(text)), [
    { name: 'real', kind: 'function', line: 4, endLine: 4, column: 4 },
  ])
})

test('parser: string literals do not produce symbols', () => {
  assert.deepEqual(scanSource('char *s = "int fake(void) { }";'), [])
})

test('parser: escaped quotes inside string literals', () => {
  const text = 'char *s = "a\\"b int fake(void) { }"; int ok(void) { return 0; }'
  assert.deepEqual(pick(scanSource(text)), [
    { name: 'ok', kind: 'function', line: 0, endLine: 0, column: text.indexOf('ok') },
  ])
})

test('parser: line comment continuation with backslash', () => {
  const text = '// comment \\\nint fake(void) { }\nint real(void) { return 0; }'
  assert.deepEqual(pick(scanSource(text)), [
    { name: 'real', kind: 'function', line: 2, endLine: 2, column: 4 },
  ])
})

test('parser: preprocessor lines are not scanned for functions', () => {
  const text = ['#ifdef FOO', '#include <a.h>', '#endif', 'int real(void) { }'].join('\n')
  assert.deepEqual(pick(scanSource(text)), [
    { name: 'real', kind: 'function', line: 3, endLine: 3, column: 4 },
  ])
})

test('parser: #define inside a block comment is not a macro', () => {
  const text = ['/*', '#define FAKE(x) x', '*/', 'int real(void) { }'].join('\n')
  assert.deepEqual(pick(scanSource(text)), [
    { name: 'real', kind: 'function', line: 3, endLine: 3, column: 4 },
  ])
})

// ------------------------------------------------------------ declarations

test('parser: header prototype is a declaration', () => {
  assert.deepEqual(pick(scanSource('extern int api_open(const char *path);')), [
    { name: 'api_open', kind: 'declaration', line: 0, endLine: 0, column: 11 },
  ])
})

test('parser: function pointer parameter does not leak the parameter name', () => {
  const text = 'void reg(int (*cb)(void *ctx), void *arg) { }'
  assert.deepEqual(pick(scanSource(text)), [
    { name: 'reg', kind: 'function', line: 0, endLine: 0, column: 5 },
  ])
})

test('parser: __attribute__ after the parameter list', () => {
  const text = [
    'static int __init foo(void) __attribute__((unused));',
    'int bar(void) __attribute__((noreturn)) { while(1); }',
  ].join('\n')
  assert.deepEqual(pick(scanSource(text)), [
    { name: 'foo', kind: 'declaration', line: 0, endLine: 0, column: 18 },
    { name: 'bar', kind: 'function', line: 1, endLine: 1, column: 4 },
  ])
})

test('parser: multi-line __attribute__ between params and body', () => {
  const text = ['int bar(void)', '    __attribute__((noreturn))', '{', '    while (1) { }', '}'].join('\n')
  assert.deepEqual(pick(scanSource(text)), [
    { name: 'bar', kind: 'function', line: 0, endLine: 4, column: 4 },
  ])
})

test('parser: variadic prototype', () => {
  assert.deepEqual(pick(scanSource('int log_fmt(const char *fmt, ...);')), [
    { name: 'log_fmt', kind: 'declaration', line: 0, endLine: 0, column: 4 },
  ])
})

test('parser: return type on its own line with pointer star', () => {
  const text = ['unsigned char  *', 'var_lookup(struct variable *vp,', '           int exact)', '{', '    return 0;', '}'].join('\n')
  assert.deepEqual(pick(scanSource(text)), [
    { name: 'var_lookup', kind: 'function', line: 1, endLine: 5, column: 0 },
  ])
})

// ------------------------------------------------------------------- macros

test('parser: function-like macro', () => {
  const text = '#define MAX(a,b) ((a)>(b)?(a):(b))'
  assert.deepEqual(pick(scanSource(text)), [
    { name: 'MAX', kind: 'macro', line: 0, endLine: 0, column: 8 },
  ])
})

test('parser: multi-line function-like macro ends on last continuation line', () => {
  const text = '#define CALL(x) \\\n  do { f(x); } while(0)'
  assert.deepEqual(pick(scanSource(text)), [{ name: 'CALL', kind: 'macro', line: 0, endLine: 1, column: 8 }])
})

test('parser: three line macro and following function are both correct', () => {
  const text = [
    '#define LONG(a) \\',
    '  do { \\',
    '    a; \\',
    '  } while (0)',
    'int after(void) { return 0; }',
  ].join('\n')
  assert.deepEqual(pick(scanSource(text)), [
    { name: 'LONG', kind: 'macro', line: 0, endLine: 3, column: 8 },
    { name: 'after', kind: 'function', line: 4, endLine: 4, column: 4 },
  ])
})

test('parser: object-like macros are not indexed', () => {
  assert.deepEqual(scanSource('#define VALUE 42\n#define SPACED (x)'), [])
})

test('parser: macro body braces do not break depth tracking', () => {
  const text = '#define REPEAT(x) do { x; } while (0)\nint real(void) { return 0; }'
  assert.deepEqual(pick(scanSource(text)), [
    { name: 'REPEAT', kind: 'macro', line: 0, endLine: 0, column: 8 },
    { name: 'real', kind: 'function', line: 1, endLine: 1, column: 4 },
  ])
})

// -------------------------------------------------------------- K&R / depth

test('parser: K&R style definition is recognised', () => {
  const text = ['int old_style(a, b)', 'int a;', 'int b;', '{', '  return a + b;', '}'].join('\n')
  assert.deepEqual(pick(scanSource(text)), [
    { name: 'old_style', kind: 'function', line: 0, endLine: 5, column: 4 },
  ])
})

test('parser: nested braces do not break the outer end line', () => {
  const text = ['int outer(void) {', '  if (x) { y(); }', '  while (1) { { } }', '  return 0;', '}'].join('\n')
  assert.deepEqual(pick(scanSource(text)), [
    { name: 'outer', kind: 'function', line: 0, endLine: 4, column: 4 },
  ])
})

test('parser: body symbols are not indexed', () => {
  const text = ['int a(void) { return 0; }', 'int b(void) {', '  return a();', '}'].join('\n')
  assert.deepEqual(pick(scanSource(text)), [
    { name: 'a', kind: 'function', line: 0, endLine: 0, column: 4 },
    { name: 'b', kind: 'function', line: 1, endLine: 3, column: 4 },
  ])
})

// ------------------------------------------------------------ false positives

test('parser: control flow and operators are not symbols', () => {
  const text = ['if (x) { }', 'for (;;) {}', 'sizeof(x)', 'return (a+b);'].join('\n')
  assert.deepEqual(scanSource(text), [])
})

test('parser: struct/union definitions are type symbols, not function symbols', () => {
  const text = ['struct s { int a; };', 'struct t { void (*cb)(int); };', 'union u { int x; long y; };'].join('\n')
  assert.deepEqual(
    scanSource(text).map((symbol) => [symbol.name, symbol.kind]),
    [
      ['s', 'struct'],
      ['t', 'struct'],
      ['u', 'union'],
    ],
  )
})

test('parser: calls inside top level initialisers are not definitions', () => {
  const text = ['static int x = foo(1);', 'int arr[] = { bar(2) };', 'void (*fp)(void) = baz;'].join('\n')
  assert.deepEqual(scanSource(text), [])
})

test('parser: typedef of a function type is a typedef symbol, not a function', () => {
  const text = 'typedef int func_t(int);\ntypedef void (*handler_t)(int);'
  assert.deepEqual(
    scanSource(text).map((symbol) => [symbol.name, symbol.kind]),
    [
      ['func_t', 'typedef'],
      ['handler_t', 'typedef'],
    ],
  )
})

test('parser: prototype macros like __P((...)) are not declarations', () => {
  const text = [
    'static int dhcp_add_dnslist __P((struct dnsinfo *, struct dnsinfo **));',
    'extern void dhcp_get_server_dns __P((char *, char *, char *, char *, char *));',
    'int wrapped LDAP_P((int a));',
  ].join('\n')
  assert.deepEqual(scanSource(text), [])
})

// ------------------------------------------------------------- real patterns

test('parser: extern "C" block does not hide definitions', () => {
  const text = [
    '#ifdef __cplusplus',
    'extern          "C" {',
    '#endif',
    'static inline int helper(int x) { return x; }',
    '#ifdef __cplusplus',
    '}',
    '#endif',
  ].join('\n')
  assert.deepEqual(pick(scanSource(text)), [
    { name: 'helper', kind: 'function', line: 3, endLine: 3, column: 18 },
  ])
})

test('parser: CRLF line endings', () => {
  const text = 'int foo(void) {\r\n  return 0;\r\n}\r\n'
  assert.deepEqual(pick(scanSource(text)), [{ name: 'foo', kind: 'function', line: 0, endLine: 2, column: 4 }])
})

test('parser: empty and whitespace-only input', () => {
  assert.deepEqual(scanSource(''), [])
  assert.deepEqual(scanSource('   \n\t\n'), [])
})

test('parser: comments between name and parameter list are tolerated', () => {
  const text = 'int foo /* name */ (int a) { return a; }'
  assert.deepEqual(pick(scanSource(text)), [
    { name: 'foo', kind: 'function', line: 0, endLine: 0, column: 4 },
  ])
})

test('parser: column is 0-based and points at the identifier', () => {
  const text = '    static inline int  indented_name(void) { return 0; }'
  const symbols = scanSource(text)
  assert.equal(symbols.length, 1)
  assert.equal(symbols[0].name, 'indented_name')
  assert.equal(symbols[0].column, text.indexOf('indented_name'))
})
