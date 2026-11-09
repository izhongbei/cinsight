/**
 * Task 6 单测：引用扫描 + 调用关系。
 * 夹具 test/fixtures/refs/ 四文件小工程（行号见各断言注释），readFile 直接读盘。
 * callersOf 的函数区间来自 scanSource（A 实现）；A 尚未落地时实现会退化为
 * snapshot.entries 区间，A 落地后会补跑同一组用例验证跨模块集成。
 */
import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { FileRecord, ReadFileFn, SymbolEntry, IndexSnapshot } from '../src/shared/types'
import { findReferences } from '../src/core/references'
import { callersOf, calleesOf } from '../src/core/callgraph'

const FIXTURE_ROOT = path.join(__dirname, '..', '..', 'test', 'fixtures', 'refs')

/** fixture 相对路径 → 磁盘内容（与扩展里的 latin1/UTF-8 读取等价，夹具全 ASCII）。 */
function fixtureReadFile(relativePath: string): Promise<string> {
  const abs = path.join(FIXTURE_ROOT, relativePath)
  return Promise.resolve(fs.readFileSync(abs, 'utf8'))
}

function makeEntry(partial: Partial<SymbolEntry> & { name: string }): SymbolEntry {
  const line = partial.line ?? 0
  return {
    name: partial.name,
    kind: partial.kind ?? 'function',
    file: partial.file ?? 'main.c',
    line,
    endLine: partial.endLine ?? line,
    column: partial.column ?? 0,
  }
}

let builtSeq = 0

function makeSnapshot(entries: readonly SymbolEntry[], extraFiles: readonly string[] = []): IndexSnapshot {
  const paths = [...new Set([...entries.map((e) => e.file), ...extraFiles])].sort()
  const files: FileRecord[] = paths.map((p) => ({ path: p, mtimeMs: 0, size: 0 }))
  return { version: 1, roots: ['.'], builtAt: 1_700_000_000_000 + ++builtSeq, files, entries }
}

/**
 * main.c 行号（0-based）：
 *   2  int bar(void)           3  {            4  helper();
 *   5  int a = foo(1);         6  int b = foo(2);   7  return a + b;   8 }
 *   10 int baz(void)           11 {           12 foo() 只在注释里
 *   13 foo() 只在字符串里       14 printf(...) 15 MAX(1, 2);
 * other.c：0 void helper(void)  1 {  2 }  3 (空)  4 int standalone = foo(3);
 * impl.c： 0 int foo(int x)（定义）   api.h：3 extern int foo(int x);（声明）
 */
function refsSnapshot(extraFiles: readonly string[] = []): IndexSnapshot {
  return makeSnapshot(
    [
      makeEntry({ name: 'foo', file: 'impl.c', line: 0, endLine: 3, column: 4 }),
      makeEntry({ name: 'foo', kind: 'declaration', file: 'api.h', line: 3, column: 11 }),
      makeEntry({ name: 'bar', file: 'main.c', line: 2, endLine: 8, column: 4 }),
      makeEntry({ name: 'baz', file: 'main.c', line: 10, endLine: 17, column: 4 }),
      makeEntry({ name: 'helper', file: 'other.c', line: 0, endLine: 2, column: 5 }),
    ],
    extraFiles,
  )
}

// ---------------------------------------------------------------------------
// findReferences
// ---------------------------------------------------------------------------

test('findReferences: 命中 3 处、排除定义/声明行、按 file/line/column 稳定排序', async () => {
  const hits = await findReferences(refsSnapshot(), 'foo', fixtureReadFile)

  assert.deepEqual(
    hits.map((h) => `${h.file}:${h.line}:${h.column}`),
    ['main.c:5:12', 'main.c:6:12', 'other.c:4:17'],
  )
  assert.equal(hits[0]?.preview, 'int a = foo(1);')
  assert.equal(hits[2]?.preview, 'int standalone = foo(3);')
  // 定义行与声明行默认不返回
  assert.ok(!hits.some((h) => h.file === 'impl.c'))
  assert.ok(!hits.some((h) => h.file === 'api.h'))
})

test('findReferences: 注释/字符串中的名字不算引用', async () => {
  const hits = await findReferences(refsSnapshot(), 'foo', fixtureReadFile)
  const inMain = hits.filter((h) => h.file === 'main.c').map((h) => h.line)

  assert.deepEqual(inMain, [5, 6])
  // main.c 12/13 行分别是注释和字符串，不得命中
  assert.ok(!inMain.includes(12))
  assert.ok(!inMain.includes(13))
})

test('findReferences: 词边界精确匹配，foobar/foo_bar 不误报', async () => {
  const text = [
    'int foobar(void);',
    'int foo_bar(void);',
    'int foo(void);',
    'void caller(void) {',
    '    foobar();',
    '    foo_bar();',
    '    foo();',
    '}',
    '',
  ].join('\n')

  const snapshot = makeSnapshot([makeEntry({ name: 'foo', file: 'v.c', line: 2 })])
  const readFile: ReadFileFn = async (rel) => {
    if (rel === 'v.c') return text
    throw new Error(`ENOENT ${rel}`)
  }

  // v.c:2 是本快照里 foo 的声明行，includeDeclaration=false 时被排除。
  const hits = await findReferences(snapshot, 'foo', readFile)
  assert.deepEqual(
    hits.map((h) => `${h.line}:${h.column}`),
    ['6:4'],
  )

  // 词边界：foobar / foo_bar 的定义行与调用行都不命中。
  const withDecl = await findReferences(snapshot, 'foo', readFile, { includeDeclaration: true })
  assert.deepEqual(
    withDecl.map((h) => `${h.line}:${h.column}`),
    ['2:4', '6:4'],
  )
})

test('findReferences: 同一行多次出现按列号全部返回', async () => {
  const text = ['void foo(void);', 'void caller(void)', '{', '    foo(foo(1));', '}', ''].join('\n')
  const snapshot = makeSnapshot([makeEntry({ name: 'foo', file: 'v.c', line: 0 })])
  const readFile: ReadFileFn = async (rel) => {
    if (rel === 'v.c') return text
    throw new Error(`ENOENT ${rel}`)
  }

  const hits = await findReferences(snapshot, 'foo', readFile)
  assert.deepEqual(
    hits.map((h) => `${h.line}:${h.column}`),
    ['3:4', '3:8'],
  )
})

test('findReferences: CRLF 行尾不破坏行号/列号/preview', async () => {
  const text = 'int foo(void);\r\nvoid caller(void)\r\n{\r\n    foo();\r\n}\r\n'
  const snapshot = makeSnapshot([makeEntry({ name: 'foo', file: 'v.c', line: 0 })])
  const readFile: ReadFileFn = async (rel) => {
    if (rel === 'v.c') return text
    throw new Error(`ENOENT ${rel}`)
  }

  const hits = await findReferences(snapshot, 'foo', readFile)
  assert.deepEqual(
    hits.map((h) => `${h.line}:${h.column}`),
    ['3:4'],
  )
  assert.equal(hits[0]?.preview, 'foo();')
})

test('findReferences: includeDeclaration:true 包含声明行（也含定义行）', async () => {
  const hits = await findReferences(refsSnapshot(), 'foo', fixtureReadFile, {
    includeDeclaration: true,
  })

  assert.ok(hits.some((h) => h.file === 'api.h' && h.line === 3 && h.column === 11))
  assert.ok(hits.some((h) => h.file === 'impl.c' && h.line === 0 && h.column === 4))
  assert.deepEqual(
    hits.map((h) => `${h.file}:${h.line}`),
    ['api.h:3', 'impl.c:0', 'main.c:5', 'main.c:6', 'other.c:4'],
  )
})

test('findReferences: readFile 失败的文件被跳过，不影响其它命中', async () => {
  const readFile: ReadFileFn = async (rel) => {
    if (rel === 'broken.c') throw new Error('EACCES')
    return fixtureReadFile(rel)
  }
  const hits = await findReferences(refsSnapshot(['broken.c']), 'foo', readFile)

  assert.deepEqual(
    hits.map((h) => `${h.file}:${h.line}:${h.column}`),
    ['main.c:5:12', 'main.c:6:12', 'other.c:4:17'],
  )
})

test('findReferences: onProgress 至少回调一次且 done===total', async () => {
  const calls: [number, number][] = []
  await findReferences(refsSnapshot(), 'foo', fixtureReadFile, {
    onProgress: (done, total) => calls.push([done, total]),
  })

  assert.ok(calls.length >= 1)
  const last = calls[calls.length - 1]!
  assert.equal(last[0], 4)
  assert.equal(last[1], 4)
})

test('findReferences: 结果按快照缓存，同一快照重复查询不再读盘', async () => {
  const snapshot = refsSnapshot()
  const first = await findReferences(snapshot, 'foo', fixtureReadFile)

  const mustNotRead: ReadFileFn = async () => {
    throw new Error('cache miss: 不该再次读盘')
  }
  const second = await findReferences(snapshot, 'foo', mustNotRead)

  assert.deepEqual(
    second.map((h) => `${h.file}:${h.line}:${h.column}`),
    first.map((h) => `${h.file}:${h.line}:${h.column}`),
  )
})

test('findReferences: 预取消的 signal 抛 AbortError', async () => {
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    findReferences(refsSnapshot(), 'foo', fixtureReadFile, { signal: controller.signal }),
    (error: Error) => {
      assert.equal(error.name, 'AbortError')
      return true
    },
  )
})

test('findReferences: 扫描中途取消会抛 AbortError', async () => {
  const controller = new AbortController()
  const snapshot = refsSnapshot()
  const readFile: ReadFileFn = async (rel) => {
    const text = await fixtureReadFile(rel)
    controller.abort() // 第一个文件读完即取消
    return text
  }

  await assert.rejects(
    findReferences(snapshot, 'foo', readFile, { signal: controller.signal }),
    (error: Error) => {
      assert.equal(error.name, 'AbortError')
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// callersOf
// ---------------------------------------------------------------------------

test('callersOf: 命中归到包含该行的函数，顶层命中 from 为 undefined', async () => {
  const hits = await callersOf(refsSnapshot(), 'foo', fixtureReadFile)

  assert.deepEqual(
    hits.map((h) => `${h.file}:${h.line}:${h.column}`),
    ['main.c:5:12', 'main.c:6:12', 'other.c:4:17'],
  )

  const barHit = hits.find((h) => h.file === 'main.c' && h.line === 5)
  assert.ok(barHit)
  assert.equal(barHit.from?.name, 'bar')
  assert.equal(barHit.from?.file, 'main.c')
  assert.equal(barHit.from?.line, 2)

  const topLevelHit = hits.find((h) => h.file === 'other.c')
  assert.ok(topLevelHit)
  assert.equal(topLevelHit.from, undefined)
})

test('callersOf: referenceHit 字段完整', async () => {
  const hits = await callersOf(refsSnapshot(), 'foo', fixtureReadFile)
  const first = hits[0]!

  assert.equal(typeof first.file, 'string')
  assert.equal(typeof first.line, 'number')
  assert.equal(typeof first.column, 'number')
  assert.equal(typeof first.preview, 'string')
})

test('callersOf: signal 取消抛 AbortError', async () => {
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    callersOf(refsSnapshot(), 'foo', fixtureReadFile, { signal: controller.signal }),
    (error: Error) => {
      assert.equal(error.name, 'AbortError')
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// calleesOf
// ---------------------------------------------------------------------------

test('calleesOf: 按出现顺序、重复调用去重、自身不算被调', async () => {
  const callees = await calleesOf(refsSnapshot(), 'bar', fixtureReadFile)

  assert.deepEqual(
    callees.map((e) => e.name),
    ['helper', 'foo'],
  )
  const foo = callees.find((e) => e.name === 'foo')
  assert.equal(foo?.file, 'impl.c')
  assert.equal(foo?.line, 0)
})

test('calleesOf: 被调函数在索引中无定义时忽略（printf/未定义宏）', async () => {
  assert.deepEqual(await calleesOf(refsSnapshot(), 'baz', fixtureReadFile), [])
})

test('calleesOf: 名字不存在或只有声明定义时返回 []', async () => {
  assert.deepEqual(await calleesOf(refsSnapshot(), 'missing', fixtureReadFile), [])
  // foo 有定义；用一个只有声明、没有定义的符号验证兜底
  const snapshot = makeSnapshot([
    makeEntry({ name: 'only_decl', kind: 'declaration', file: 'api.h', line: 0 }),
  ])
  assert.deepEqual(await calleesOf(snapshot, 'only_decl', fixtureReadFile), [])
})

test('calleesOf: 函数体内注释/字符串里的调用不算被调', async () => {
  // baz 的注释与字符串里都有 foo()，但都不应出现
  const callees = await calleesOf(refsSnapshot(), 'baz', fixtureReadFile)
  assert.ok(!callees.some((e) => e.name === 'foo'))
})

test('calleesOf: signal 取消抛 AbortError', async () => {
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    calleesOf(refsSnapshot(), 'bar', fixtureReadFile, { signal: controller.signal }),
    (error: Error) => {
      assert.equal(error.name, 'AbortError')
      return true
    },
  )
})
