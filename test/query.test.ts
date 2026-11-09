/**
 * Task 5 单测：符号搜索排序 / 按名查找 / 按文件查询 / 签名重建。
 * 只用内存构造的 snapshot 与虚拟 readFile，不依赖 A 的 indexer 是否已落地。
 */
import { test } from 'node:test'
import * as assert from 'node:assert/strict'

import type { ReadFileFn, SymbolEntry, IndexSnapshot, SymbolKind } from '../src/shared/types'
import { entriesInFile, findByName, searchSymbols } from '../src/core/query'
import { readSignature, readSignatureAtLine } from '../src/core/signature'

/** builtAt 单调递增：避免模块级结果缓存跨用例串味。 */
let builtSeq = 0

function makeEntry(partial: Partial<SymbolEntry> & { name: string }): SymbolEntry {
  const line = partial.line ?? 0
  return {
    name: partial.name,
    kind: partial.kind ?? 'function',
    file: partial.file ?? 'src/a.c',
    line,
    endLine: partial.endLine ?? line,
    column: partial.column ?? 0,
  }
}

function makeSnapshot(entries: readonly SymbolEntry[]): IndexSnapshot {
  const files = [...new Set(entries.map((e) => e.file))].map((path) => ({
    path,
    mtimeMs: 0,
    size: 0,
  }))
  return { version: 1, roots: ['src'], builtAt: 1_700_000_000_000 + ++builtSeq, files, entries }
}

function names(entries: readonly SymbolEntry[]): string[] {
  return entries.map((e) => e.name)
}

function virtualReadFile(files: Record<string, string>): ReadFileFn {
  return async (rel: string) => {
    const text = files[rel]
    if (text === undefined) throw new Error(`ENOENT: ${rel}`)
    return text
  }
}

// ---------------------------------------------------------------------------
// searchSymbols
// ---------------------------------------------------------------------------

test('searchSymbols: 完全相等 > 前缀 > 子词 > 子串，同权重按 kind/名字长度/名字/文件/行', () => {
  // 注意：计划 Task 5 用例 1 写的期望顺序 [foo, foo_bar, foobar, ...] 与
  // Behavior 中「同权重按名字长度升序」矛盾（foobar 长度 6 < foo_bar 长度 7）。
  // 这里按计划 Behavior 的显式排序键断言：weight、kind、name.length、name、file、line。
  const snap = makeSnapshot([
    makeEntry({ name: 'xfoo', file: 'src/b.c', line: 9 }),
    makeEntry({ name: 'my_foo', file: 'src/a.c', line: 5 }),
    makeEntry({ name: 'foobar', file: 'src/a.c', line: 3 }),
    makeEntry({ name: 'foo_bar', file: 'src/a.c', line: 2 }),
    makeEntry({ name: 'foo', file: 'src/a.c', line: 1 }),
  ])

  assert.deepEqual(names(searchSymbols(snap, 'foo')), [
    'foo', // 完全相等 weight 0
    'foobar', // 前缀 weight 1，长度 6
    'foo_bar', // 前缀 weight 1，长度 7
    'my_foo', // 下划线子词 weight 2
    'xfoo', // 普通子串 weight 3
  ])
})

test('searchSymbols: 驼峰/下划线子词优先于普通子串', () => {
  const snap = makeSnapshot([
    makeEntry({ name: 'xfoo', file: 'src/a.c', line: 1 }),
    makeEntry({ name: 'my_foo', file: 'src/a.c', line: 2 }),
    makeEntry({ name: 'myFoo', file: 'src/a.c', line: 3 }),
  ])

  // myFoo / my_foo 都是子词命中 weight 2，再按名字长度升序（5 < 6）。
  assert.deepEqual(names(searchSymbols(snap, 'foo')), ['myFoo', 'my_foo', 'xfoo'])
})

test('searchSymbols: 大小写不敏感且 query 去首尾空白', () => {
  const snap = makeSnapshot([makeEntry({ name: 'foo' })])

  assert.deepEqual(names(searchSymbols(snap, 'FOO')), ['foo'])
  assert.deepEqual(names(searchSymbols(snap, '  FoO  ')), ['foo'])
})

test('searchSymbols: kinds 过滤与 limit', () => {
  const snap = makeSnapshot([
    makeEntry({ name: 'foo', kind: 'declaration', file: 'a.h', line: 2 }),
    makeEntry({ name: 'foo', kind: 'function', file: 'b.c', line: 3 }),
    makeEntry({ name: 'foo_bar', kind: 'function', file: 'c.c', line: 1 }),
    makeEntry({ name: 'fooBaz', kind: 'function', file: 'd.c', line: 1 }),
  ])

  assert.deepEqual(names(searchSymbols(snap, 'foo', { kinds: ['declaration'] })), ['foo'])
  assert.equal(searchSymbols(snap, 'foo', { kinds: ['declaration'] })[0]?.kind, 'declaration')

  const limited = searchSymbols(snap, 'foo', { limit: 2 })
  assert.equal(limited.length, 2)
  // 同 weight 0 的 function 先于 declaration。
  assert.deepEqual(
    limited.map((e) => `${e.kind}:${e.file}`),
    ['function:b.c', 'declaration:a.h'],
  )

  assert.deepEqual(searchSymbols(snap, 'foo', { limit: 0 }), [])
})

test('searchSymbols: 空 query 返回空数组', () => {
  const snap = makeSnapshot([makeEntry({ name: 'foo' })])

  assert.deepEqual(searchSymbols(snap, ''), [])
  assert.deepEqual(searchSymbols(snap, '   '), [])
})

test('searchSymbols: 同 weight 同 kind 按 file、line 升序', () => {
  const snap = makeSnapshot([
    makeEntry({ name: 'foo', file: 'src/z.c', line: 1 }),
    makeEntry({ name: 'foo', file: 'src/a.c', line: 9 }),
    makeEntry({ name: 'foo', file: 'src/a.c', line: 2 }),
  ])

  assert.deepEqual(
    searchSymbols(snap, 'foo').map((e) => `${e.file}:${e.line}`),
    ['src/a.c:2', 'src/a.c:9', 'src/z.c:1'],
  )
})

// ---------------------------------------------------------------------------
// findByName / entriesInFile
// ---------------------------------------------------------------------------

test('findByName: 精确名、定义在前声明次之宏最后、其余按 file/line', () => {
  const snap = makeSnapshot([
    makeEntry({ name: 'foo', kind: 'macro', file: 'z.h', line: 1 }),
    makeEntry({ name: 'foo', kind: 'declaration', file: 'b.h', line: 7 }),
    makeEntry({ name: 'foo', kind: 'function', file: 'a.c', line: 3 }),
    makeEntry({ name: 'foo', kind: 'declaration', file: 'a.h', line: 5 }),
    makeEntry({ name: 'foobar' }),
  ])

  const found = findByName(snap, 'foo')
  assert.deepEqual(
    found.map((e) => `${e.kind}:${e.file}:${e.line}`),
    ['function:a.c:3', 'declaration:a.h:5', 'declaration:b.h:7', 'macro:z.h:1'],
  )

  assert.deepEqual(findByName(snap, 'FOO'), [])
  assert.deepEqual(findByName(snap, 'missing'), [])
})

test('entriesInFile: 只含该文件且按行号升序', () => {
  const snap = makeSnapshot([
    makeEntry({ name: 'c', file: 'src/b.c', line: 10 }),
    makeEntry({ name: 'a', file: 'src/b.c', line: 2 }),
    makeEntry({ name: 'b', file: 'src/b.c', line: 7 }),
    makeEntry({ name: 'other', file: 'src/c.c', line: 1 }),
  ])

  const inFile = entriesInFile(snap, 'src/b.c')
  assert.deepEqual(names(inFile), ['a', 'b', 'c'])
  assert.deepEqual(inFile.map((e) => e.line), [2, 7, 10])

  assert.deepEqual(entriesInFile(snap, 'src/none.c'), [])
})

// ---------------------------------------------------------------------------
// readSignature / readSignatureAtLine
// ---------------------------------------------------------------------------

test('readSignature: 多行签名拼成单行、去注释、压缩空白、去掉末尾 {', async () => {
  const text = 'static int foo(\n  const char *name, /* 参数 */\n  u32 flags)\n{\n  return 0;\n}\n'
  const sig = await readSignature(
    virtualReadFile({ 'src/a.c': text }),
    makeEntry({ name: 'foo', file: 'src/a.c', line: 0, endLine: 5, column: 11 }),
  )

  assert.equal(sig, 'static int foo(const char *name, u32 flags)')
})

test('readSignature: 声明以 ; 结束，签名不含分号', async () => {
  const text = 'extern int api_open(const char *path);\n\nint api_open(const char *path)\n{\n  return 0;\n}\n'
  const sig = await readSignature(
    virtualReadFile({ 'src/a.c': text }),
    makeEntry({ name: 'api_open', kind: 'declaration', file: 'src/a.c', line: 0 }),
  )

  assert.equal(sig, 'extern int api_open(const char *path)')
})

test('readSignature: __attribute__ 保留到 { 之前才停', async () => {
  const text = 'int bar(void) __attribute__((noreturn))\n{\n  while (1) {}\n}\n'
  const sig = await readSignature(
    virtualReadFile({ 'src/a.c': text }),
    makeEntry({ name: 'bar', file: 'src/a.c', line: 0, endLine: 3, column: 4 }),
  )

  assert.equal(sig, 'int bar(void) __attribute__((noreturn))')
})

test('readSignature: 函数式宏按续行拼接并去掉续行反斜杠', async () => {
  const text = '#define MAX(a,b) \\\n  ((a)>(b)?(a):(b))\n'
  const sig = await readSignature(
    virtualReadFile({ 'src/a.c': text }),
    makeEntry({ name: 'MAX', kind: 'macro', file: 'src/a.c', line: 0, endLine: 1, column: 8 }),
  )

  assert.equal(sig, '#define MAX(a,b) ((a)>(b)?(a):(b))')
})

test('readSignature: 文件读失败返回 undefined 而不抛', async () => {
  const failing: ReadFileFn = async () => {
    throw new Error('boom')
  }
  const sig = await readSignature(
    failing,
    makeEntry({ name: 'foo', file: 'src/missing.c', line: 0 }),
  )

  assert.equal(sig, undefined)
})

test('readSignature: 行号越界返回 undefined', async () => {
  const sig = await readSignature(
    virtualReadFile({ 'src/a.c': 'int foo(void) {}\n' }),
    makeEntry({ name: 'foo', file: 'src/a.c', line: 99 }),
  )

  assert.equal(sig, undefined)
})

test('readSignature: 最多拼接 20 行，超长不无限读', async () => {
  const lines = ['int foo(']
  for (let i = 0; i < 40; i++) lines.push(`  int arg${i},`)
  lines.push('  int last)')
  lines.push('{')
  lines.push('}')
  const sig = await readSignature(
    virtualReadFile({ 'src/a.c': lines.join('\n') + '\n' }),
    makeEntry({ name: 'foo', file: 'src/a.c', line: 0, endLine: lines.length - 1 }),
  )

  // 20 行内没有出现 { 或 ;，无法完成签名 → undefined。
  assert.equal(sig, undefined)
})

test('readSignatureAtLine: 从给定行找首个 IDENT( 并重建签名', async () => {
  const files = {
    'src/a.h': '#include <x.h>\nextern int api_open(const char *path, int flags);\n',
    'src/b.c': '\nint foo(int a)\n{\n  return a;\n}\n',
  }
  const readFile = virtualReadFile(files)

  assert.equal(
    await readSignatureAtLine(readFile, 'src/a.h', 1),
    'extern int api_open(const char *path, int flags)',
  )
  assert.equal(await readSignatureAtLine(readFile, 'src/b.c', 1), 'int foo(int a)')
  // 该行没有任何 IDENT( → undefined。
  assert.equal(await readSignatureAtLine(readFile, 'src/a.h', 0), undefined)
  // 行号越界 → undefined。
  assert.equal(await readSignatureAtLine(readFile, 'src/b.c', 99), undefined)
})
