import test from 'node:test'
import assert from 'node:assert/strict'
import { scanEnumConstants } from '../src/core/scan'

test('scanEnumConstants: values ignored, typedef alias as parent', () => {
  const text = [
    'typedef enum rtk_mode {',
    '  RTK_MODE_A = 1,',
    '  RTK_MODE_B,',
    '} rtk_mode_t;',
    'enum plain { P1, P2 };',
  ].join('\n')
  const constants = scanEnumConstants(text)
  assert.deepEqual(constants.map((c) => [c.name, c.parent]), [
    ['RTK_MODE_A', 'rtk_mode_t'],
    ['RTK_MODE_B', 'rtk_mode_t'],
    ['P1', 'plain'],
    ['P2', 'plain'],
  ])
  assert.ok(constants.every((c) => c.kind === 'enumConstant'))
  // endLine 指向枚举常量自身所在行，而不是最后的 `}` 行（最后一个常量无尾逗号）
  assert.deepEqual(constants.map((c) => [c.name, c.line, c.endLine]), [
    ['RTK_MODE_A', 1, 1],
    ['RTK_MODE_B', 2, 2],
    ['P1', 4, 4],
    ['P2', 4, 4],
  ])
})

test('scanEnumConstants: macro-generated enumerators are skipped, normal ones kept', () => {
  const text = [
    'typedef enum {',
    '  CINIT(FILE, LONG) = 1,',
    '  CINIT(URL, OBJECT) = 2,',
    '  PLAIN_A = 3,',
    '  PLAIN_B',
    '} CURLoption;',
  ].join('\n')
  assert.deepEqual(scanEnumConstants(text).map((c) => [c.name, c.parent, c.endLine]), [
    ['PLAIN_A', 'CURLoption', 3],
    ['PLAIN_B', 'CURLoption', 4],
  ])
})

test('scanEnumConstants: anonymous enum uses typedef alias or <anonymous>', () => {
  const text = ['typedef enum { A1, A2 } anon_t;', 'enum { B1, B2 };'].join('\n')
  assert.deepEqual(scanEnumConstants(text).map((c) => [c.name, c.parent]), [
    ['A1', 'anon_t'],
    ['A2', 'anon_t'],
    ['B1', '<anonymous>'],
    ['B2', '<anonymous>'],
  ])
})

test('scanEnumConstants: value expressions with commas/parens do not leak names', () => {
  const text = [
    'enum flags {',
    '  FLAG_A = (1 << 0),',
    '  FLAG_B = MACRO(1, 2),',
    '  FLAG_C = sizeof(int),',
    '};',
  ].join('\n')
  assert.deepEqual(scanEnumConstants(text).map((c) => c.name), ['FLAG_A', 'FLAG_B', 'FLAG_C'])
})

test('scanEnumConstants: enum inside function body is ignored; tag parent without typedef', () => {
  const text = ['void f(void) {', '  enum local { L1 };', '}', 'enum outer { O1 };'].join('\n')
  assert.deepEqual(scanEnumConstants(text).map((c) => [c.name, c.parent, c.line]), [
    ['O1', 'outer', 3],
  ])
})

test('scanEnumConstants: endLine stays on the enumerator line without a trailing comma', () => {
  const text = ['enum e {', '  E1,', '  E2', '};'].join('\n')
  assert.deepEqual(scanEnumConstants(text).map((c) => [c.name, c.line, c.endLine]), [
    ['E1', 1, 1],
    ['E2', 2, 2],
  ])
})
