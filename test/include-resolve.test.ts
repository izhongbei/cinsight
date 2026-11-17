import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveIncludePath, resolveIncludePaths } from '../src/core/include-resolve'

/**
 * include 解析纯函数：
 *   候选顺序 = 相对当前文件目录 → include 原样 → 各 indexRoot 前缀；
 *   只有命中「索引内文件集合」才算解析成功，未命中返回 undefined（调用方丢弃）。
 * 路径一律按 posix 规则比较（workspace 相对），因此 Windows 反斜杠输入也必须安全。
 */

function context(paths: readonly string[], roots: readonly string[] = ['.']): {
  indexedPaths: ReadonlySet<string>
  roots: readonly string[]
} {
  return { indexedPaths: new Set(paths), roots }
}

test('include-resolve: relative to the including file directory wins first', () => {
  // src/a.c 里的 "x.h" → src/x.h
  assert.equal(
    resolveIncludePath('src/a.c', 'x.h', context(['src/a.c', 'src/x.h', 'x.h'])),
    'src/x.h',
  )
  // 子目录：src/deep/a.c 里的 "../x.h" → src/x.h
  assert.equal(
    resolveIncludePath('src/deep/a.c', '../x.h', context(['src/deep/a.c', 'src/x.h'])),
    'src/x.h',
  )
})

test('include-resolve: index-root relative path resolves as-is', () => {
  // 常见的工程写法：src/a.c 引用 inc/x.h（真实文件在 workspace 根下的 inc/x.h）
  assert.equal(
    resolveIncludePath('src/a.c', 'inc/x.h', context(['src/a.c', 'inc/x.h'])),
    'inc/x.h',
  )
})

test('include-resolve: root-prefixed candidates cover per-root search paths', () => {
  // include 写了 "inc/x.h"，真实文件在 proj/inc/x.h（indexRoot = proj）
  assert.equal(
    resolveIncludePath('proj/src/a.c', 'inc/x.h', context(['proj/src/a.c', 'proj/inc/x.h'], ['proj'])),
    'proj/inc/x.h',
  )
  // 多个 root 时按 roots 顺序取第一个命中
  assert.equal(
    resolveIncludePath(
      'other/a.c',
      'inc/x.h',
      context(['other/a.c', 'proj/inc/x.h', 'vendor/inc/x.h'], ['proj', 'vendor']),
    ),
    'proj/inc/x.h',
  )
})

test('include-resolve: candidate precedence is dir → as-is → roots', () => {
  // 三个候选都存在时必须按约定顺序取相对目录者
  const ctx = context(['src/a.c', 'src/x.h', 'x.h', 'proj/x.h'], ['proj'])
  assert.equal(resolveIncludePath('src/a.c', 'x.h', ctx), 'src/x.h')
  // 去掉相对目录候选后取 as-is，而不是 root 前缀
  assert.equal(resolveIncludePath('src/a.c', 'x.h', context(['src/a.c', 'x.h', 'proj/x.h'], ['proj'])), 'x.h')
  // 只有根前缀候选时命中它
  assert.equal(resolveIncludePath('src/a.c', 'x.h', context(['src/a.c', 'proj/x.h'], ['proj'])), 'proj/x.h')
})

test('include-resolve: unresolved includes are dropped, never guessed', () => {
  assert.equal(resolveIncludePath('src/a.c', 'missing.h', context(['src/a.c', 'inc/x.h'])), undefined)
  // 目录的路径不算文件
  assert.equal(resolveIncludePath('src/a.c', 'src', context(['src/a.c', 'src/x.h'])), undefined)
  // 空路径
  assert.equal(resolveIncludePath('src/a.c', '', context(['src/a.c'])), undefined)
  assert.equal(resolveIncludePath('src/a.c', '   ', context(['src/a.c'])), undefined)
})

test('include-resolve: escaping and absolute paths cannot hit workspace-relative files', () => {
  const ctx = context(['src/a.c', 'a.c', 'inc/x.h'])
  // ../../a.c 归一化后仍是 workspace 内路径，可以命中
  assert.equal(resolveIncludePath('src/deep/a.c', '../../a.c', ctx), 'a.c')
  // 逃出工作区：`../` 归一化结果带前导 ..，索引里不可能有，直接未命中
  assert.equal(resolveIncludePath('a.c', '../../../etc/passwd', ctx), undefined)
  // 系统绝对路径
  assert.equal(resolveIncludePath('a.c', '/usr/include/stdio.h', ctx), undefined)
})

test('include-resolve: windows separators are normalized to posix', () => {
  // include 文本用反斜杠（Windows 风格）：与正斜杠等价
  assert.equal(
    resolveIncludePath('src/a.c', 'inc\\x.h', context(['src/a.c', 'inc/x.h'])),
    'inc/x.h',
  )
  // fromFile 本身带反斜杠也不会产生 "src\\inc/x.h" 这类混合路径
  assert.equal(
    resolveIncludePath('src\\a.c', 'inc/x.h', context(['src/a.c', 'src/inc/x.h'])),
    'src/inc/x.h',
  )
  // 根前缀候选同样归一化
  assert.equal(
    resolveIncludePath('a.c', '.\\inc\\x.h', context(['a.c', 'inc/x.h'])),
    'inc/x.h',
  )
})

test('include-resolve: batch helper preserves include order and dedupes targets', () => {
  const ctx = context(['src/a.c', 'src/x.h', 'inc/y.h', 'inc/x.h'])
  assert.deepEqual(
    resolveIncludePaths('src/a.c', ['x.h', 'inc/y.h', 'missing.h', 'inc\\x.h', 'x.h'], ctx),
    ['src/x.h', 'inc/y.h', 'inc/x.h'],
  )
  // 没有任何命中时返回空数组
  assert.deepEqual(resolveIncludePaths('src/a.c', ['missing.h'], ctx), [])
  assert.deepEqual(resolveIncludePaths('src/a.c', [], ctx), [])
})
