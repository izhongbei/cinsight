import test from 'node:test'
import assert from 'node:assert/strict'
import { scanMembers } from '../src/core/scan'

test('scanMembers: multi declarators, pointer, array, bitfield, function pointer', () => {
  const text = [
    'struct sk_buff {',
    '  int len, *data;',
    '  unsigned char head[16];',
    '  unsigned int flags:3;',
    '  int (*cb)(void *arg);',
    '};',
  ].join('\n')
  const members = scanMembers(text)
  assert.deepEqual(members.map((m) => m.name), ['len', 'data', 'head', 'flags', 'cb'])
  assert.ok(members.every((m) => m.kind === 'member' && m.parent === 'sk_buff'))
})

test('scanMembers: union and anonymous member skipped', () => {
  const text = [
    'union u {',
    '  int a;',
    '  union { int x; int y; };',
    '};',
  ].join('\n')
  const members = scanMembers(text)
  assert.deepEqual(members.map((m) => m.name), ['a'])
  assert.equal(members[0]!.parent, 'u')
})

test('scanMembers: named inline union member kept, its body members skipped', () => {
  const text = ['struct outer {', '  union { int x; int y; } u;', '};'].join('\n')
  const members = scanMembers(text)
  assert.deepEqual(members.map((m) => [m.name, m.parent]), [['u', 'outer']])
})

test('scanMembers: anonymous typedef struct members use the alias as parent (multi declarator)', () => {
  const text = [
    'typedef struct {',
    '  int x, *y;',
    '  char name[8];',
    '} point_t;',
  ].join('\n')
  const members = scanMembers(text)
  assert.deepEqual(
    members.map((m) => [m.name, m.kind, m.parent]),
    [
      ['x', 'member', 'point_t'],
      ['y', 'member', 'point_t'],
      ['name', 'member', 'point_t'],
    ],
  )
})

test('scanMembers: typedef with several aliases uses the first alias as parent', () => {
  const text = 'typedef struct { int a; } a_t, *b_t;'
  assert.deepEqual(scanMembers(text).map((m) => [m.name, m.parent]), [['a', 'a_t']])
})

test('scanMembers: anonymous typedef union members use the alias as parent', () => {
  const text = ['typedef union {', '  int i;', '  float f;', '} value_t;'].join('\n')
  assert.deepEqual(
    scanMembers(text).map((m) => [m.name, m.kind, m.parent]),
    [
      ['i', 'member', 'value_t'],
      ['f', 'member', 'value_t'],
    ],
  )
})

test('scanMembers: anonymous struct without a typedef alias keeps members skipped', () => {
  const text = ['struct { int x; int y; } var;', 'typedef int plain_t;'].join('\n')
  assert.deepEqual(scanMembers(text), [])
})

test('scanMembers: named inline struct member kept, its body members skipped', () => {
  const text = ['struct outer {', '  struct foo { int y; } bar;', '};'].join('\n')
  assert.deepEqual(scanMembers(text).map((m) => [m.name, m.parent]), [['bar', 'outer']])
})

test('scanMembers: tag usages, forward declarations and function-body types are not members', () => {
  const text = [
    'struct opaque;',
    'struct opaque *ptr;',
    'void f(void) {',
    '  struct inner { int x; };',
    '}',
  ].join('\n')
  assert.deepEqual(scanMembers(text), [])
})

test('scanMembers: attributes and struct-typed members keep the declarator name', () => {
  const text = [
    'struct __attribute__((packed)) packed_s {',
    '  struct list_head node;',
    '  int value __attribute__((unused));',
    '};',
  ].join('\n')
  const members = scanMembers(text)
  assert.deepEqual(members.map((m) => [m.name, m.parent]), [
    ['node', 'packed_s'],
    ['value', 'packed_s'],
  ])
})

test('scanMembers: line and column point at the declarator', () => {
  const text = ['struct s {', '    int first;', '  char *second;', '};'].join('\n')
  const members = scanMembers(text)
  assert.deepEqual(
    members.map((m) => [m.name, m.line, m.column, m.endLine]),
    [
      ['first', 1, 8, 1],
      ['second', 2, 8, 2],
    ],
  )
})

test('scanMembers: trailing kernel attribute macros are not member names', () => {
  const text = [
    'struct s {',
    '  int len __read_mostly;',
    '  char *buf __packed;',
    '  unsigned long mask __aligned(8);',
    '  int __pad;',
    '};',
  ].join('\n')
  assert.deepEqual(scanMembers(text).map((m) => m.name), ['len', 'buf', 'mask', '__pad'])
})
