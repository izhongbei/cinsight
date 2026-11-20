/**
 * B3 Task 4：字段访问上下文识别（`src/vscode/field-access.ts`）。
 *
 * 输入是「光标所在单词左侧的整行文本」；函数只做词法判断，不解析表达式类型。
 */
import { test } from 'node:test'
import * as assert from 'node:assert/strict'

import { detectMemberAccess } from '../src/vscode/field-access'

test('detectMemberAccess: pointer and value member access', () => {
  assert.equal(detectMemberAccess('skb->'), 'member')
  assert.equal(detectMemberAccess('sk_buff->'), 'member')
  assert.equal(detectMemberAccess('dev.'), 'member')
  assert.equal(detectMemberAccess('\tdev.'), 'member')
})

test('detectMemberAccess: whitespace after the operator is ignored', () => {
  assert.equal(detectMemberAccess('skb->  '), 'member')
  assert.equal(detectMemberAccess('dev.\t'), 'member')
})

test('detectMemberAccess: designated initializer `.field = x`', () => {
  // `.field = x` 初始化：光标在 field 左侧只有 `.`
  assert.equal(detectMemberAccess('.'), 'member')
  assert.equal(detectMemberAccess('\t.'), 'member')
  assert.equal(detectMemberAccess('{ .'), 'member')
})

test('detectMemberAccess: chained / parenthesized access', () => {
  assert.equal(detectMemberAccess('((struct sk_buff *)p)->'), 'member')
  assert.equal(detectMemberAccess('a.b.'), 'member')
})

test('detectMemberAccess: number literals are not member access', () => {
  assert.equal(detectMemberAccess('1.'), undefined)
  assert.equal(detectMemberAccess('x = 2.'), undefined)
  assert.equal(detectMemberAccess('value[3].'), 'member')
})

test('detectMemberAccess: variadic ellipsis is not member access', () => {
  assert.equal(detectMemberAccess('...'), undefined)
  assert.equal(detectMemberAccess('foo(...'), undefined)
})

test('detectMemberAccess: other prefixes are not member access', () => {
  assert.equal(detectMemberAccess(''), undefined)
  assert.equal(detectMemberAccess('   '), undefined)
  assert.equal(detectMemberAccess('foo'), undefined)
  assert.equal(detectMemberAccess('p->field'), undefined)
  assert.equal(detectMemberAccess('foo('), undefined)
  assert.equal(detectMemberAccess('a->b,'), undefined)
  assert.equal(detectMemberAccess('x + '), undefined)
})
