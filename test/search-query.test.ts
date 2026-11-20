/**
 * B3 Task 4：搜索过滤词解析（`src/core/search-query.ts`）。
 *
 * 支持的 token：@func / @type / @macro / @member / @enum / @var；
 * 多个 token 取并集；未识别的 @token 原样留在查询文本里（用户可能真的在搜含 @ 的名字）。
 */
import { test } from 'node:test'
import * as assert from 'node:assert/strict'

import { parseSearchQuery } from '../src/core/search-query'

test('parseSearchQuery: plain text is trimmed, no kind filter', () => {
  assert.deepEqual(parseSearchQuery('  sk_buff  '), { query: 'sk_buff' })
  assert.deepEqual(parseSearchQuery(''), { query: '' })
  assert.deepEqual(parseSearchQuery('   '), { query: '' })
})

test('parseSearchQuery: @member removes the token and keeps the text', () => {
  assert.deepEqual(parseSearchQuery('@member len'), { query: 'len', kinds: ['member'] })
})

test('parseSearchQuery: @enum maps to enum constants', () => {
  assert.deepEqual(parseSearchQuery('@enum E_A'), {
    query: 'E_A',
    kinds: ['enumConstant'],
  })
})

test('parseSearchQuery: @type covers struct/union/enum/typedef', () => {
  assert.deepEqual(parseSearchQuery('@type sk_buff'), {
    query: 'sk_buff',
    kinds: ['struct', 'union', 'enum', 'typedef'],
  })
})

test('parseSearchQuery: @func / @macro / @var map to a single kind', () => {
  assert.deepEqual(parseSearchQuery('@func init'), { query: 'init', kinds: ['function'] })
  assert.deepEqual(parseSearchQuery('@macro MAX'), { query: 'MAX', kinds: ['macro'] })
  assert.deepEqual(parseSearchQuery('@var counter'), { query: 'counter', kinds: ['variable'] })
})

test('parseSearchQuery: multiple tokens are a union, duplicates removed', () => {
  assert.deepEqual(parseSearchQuery('@func @macro foo'), {
    query: 'foo',
    kinds: ['function', 'macro'],
  })
  assert.deepEqual(parseSearchQuery('@func @func foo'), {
    query: 'foo',
    kinds: ['function'],
  })
})

test('parseSearchQuery: tokens are case-insensitive', () => {
  assert.deepEqual(parseSearchQuery('@MEMBER len'), { query: 'len', kinds: ['member'] })
})

test('parseSearchQuery: unknown @token stays in the query text', () => {
  assert.deepEqual(parseSearchQuery('@bogus foo'), { query: '@bogus foo' })
  assert.deepEqual(parseSearchQuery('foo @memberish'), { query: 'foo @memberish' })
})

test('parseSearchQuery: token-only input yields an empty query with kinds', () => {
  assert.deepEqual(parseSearchQuery('@member'), { query: '', kinds: ['member'] })
})

test('parseSearchQuery: internal whitespace is normalized to single spaces', () => {
  assert.deepEqual(parseSearchQuery('  @member   len  '), { query: 'len', kinds: ['member'] })
  assert.deepEqual(parseSearchQuery('  foo   bar  '), { query: 'foo bar' })
})
