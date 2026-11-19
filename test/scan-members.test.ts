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
