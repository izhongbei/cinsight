/**
 * Task 6 单测：引用扫描 + 调用关系。
 * 夹具 test/fixtures/refs/ 四文件小工程（行号见各断言注释），readFile 直接读盘。
 * callersOf 的函数区间来自 scanSource（A 实现）；A 尚未落地时实现会退化为
 * 快照区间，A 落地后会补跑同一组用例验证跨模块集成。
 */
import { test } from 'node:test'
import * as assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'

import type { FileRecord, ReadFileFn, SymbolEntry, SymbolTable } from '../src/shared/types'
import { SNAPSHOT_VERSION } from '../src/shared/types'
import { createMutableIndex } from '../src/core/overlay-index'
import { createSymbolTable } from '../src/core/symbol-table'
import { clearReferenceCache, findReferences } from '../src/core/references'
import { callersOf, calleesOf, clearCallGraphCache } from '../src/core/callgraph'

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

function makeSnapshot(entries: readonly SymbolEntry[], extraFiles: readonly string[] = []): SymbolTable {
  const paths = [...new Set([...entries.map((e) => e.file), ...extraFiles])].sort()
  const files: FileRecord[] = paths.map((p) => ({ path: p, mtimeMs: 0, size: 0 }))
  return createSymbolTable(['.'], files, entries, 1_700_000_000_000 + ++builtSeq, SNAPSHOT_VERSION)
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
function refsSnapshot(extraFiles: readonly string[] = []): SymbolTable {
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

test('calleesOf: 只解析 function，同名成员/全局变量/枚举常量不能冒充被调函数', async () => {
  const text = [
    'void op_apply(void) {',
    '  ops->apply(1);',
    '  ops->notify(2);',
    '  register_cb(apply);',
    '}',
  ].join('\n')
  const snapshot = makeSnapshot([
    makeEntry({ name: 'op_apply', file: 'v.c', line: 0, endLine: 4, column: 5 }),
    // 同一个名字同时是成员 / 全局变量 / 枚举常量 / 函数：只有函数算被调。
    makeEntry({ name: 'apply', kind: 'member', file: 'v.h', line: 0, parent: 'ops_table' }),
    makeEntry({ name: 'apply', kind: 'variable', file: 'v.c', line: 10 }),
    makeEntry({ name: 'apply', kind: 'enumConstant', file: 'v.h', line: 5, parent: 'E' }),
    makeEntry({ name: 'apply', kind: 'function', file: 'impl.c', line: 0 }),
    // 只有成员、没有同名函数的调用（`ops->notify(...)`）必须被忽略。
    makeEntry({ name: 'notify', kind: 'member', file: 'v.h', line: 1, parent: 'ops_table' }),
  ])
  const readFile: ReadFileFn = async (rel) => {
    if (rel === 'v.c') return text
    throw new Error(`ENOENT ${rel}`)
  }

  const callees = await calleesOf(snapshot, 'op_apply', readFile)
  assert.deepEqual(
    callees.map((entry) => [entry.name, entry.kind, entry.file]),
    [['apply', 'function', 'impl.c']],
  )
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

// ---------------------------------------------------------------------------
// 原地增量编辑后的缓存失效
//
// service 现在只保留一个 MutableSymbolIndex 并原地 applyFile/removeFile：快照对象身份
// 不变，所以 references 的结果缓存与 callgraph 的 scanCache 都不会自动失效。
// core 不能反向依赖 vscode，由 service 在每次 commit 后调用这两个 clear 函数。
// 下面两个用例走真实 overlay + readFile，锁定这一契约。
// ---------------------------------------------------------------------------

test('findReferences: overlay 原地编辑后 clearReferenceCache 才能看到新引用', async () => {
  // new.c 的内容由测试注入，模拟编辑后磁盘上出现新引用
  const texts = new Map<string, string>([['new.c', 'void quux(void);\nint caller = 0;\n']])
  const readFile: ReadFileFn = async (rel) => {
    const injected = texts.get(rel)
    return injected !== undefined ? injected : fixtureReadFile(rel)
  }

  const index = createMutableIndex(refsSnapshot())
  // 预热：此刻 quux 不存在，空结果按 snapshotIdentity(index) 写入缓存
  assert.deepEqual(await findReferences(index, 'quux', readFile), [])

  // 原地 applyFile：索引对象身份不变，new.c 的文本与符号同时更新
  index.applyFile({ path: 'new.c', mtimeMs: 1, size: 1 }, [
    makeEntry({ name: 'quux', file: 'new.c', line: 0 }),
  ])
  texts.set('new.c', 'void quux(void);\nint caller = 0;\nvoid user(void) {\n    quux();\n}\n')

  // 未清缓存：identity 未变，仍命中旧的空结果（service 修复前的行为）
  assert.deepEqual(await findReferences(index, 'quux', readFile), [])

  clearReferenceCache()
  const hits = await findReferences(index, 'quux', readFile)
  assert.deepEqual(
    hits.map((h) => `${h.file}:${h.line}:${h.column}`),
    ['new.c:3:4'],
  )
})

test('findReferences: 在途查询遇到 clearReferenceCache 不会把旧结果写回', async () => {
  // 编辑前 1 处引用，编辑后 2 处；延迟第一次读盘，把「编辑 + 清缓存」塞进读盘窗口。
  const before = ['void target(void);', 'void caller(void)', '{', '    target();', '}', ''].join('\n')
  const after = ['void target(void);', 'void caller(void)', '{', '    target();', '    target();', '}', ''].join(
    '\n',
  )
  const texts = new Map<string, string>([['race.c', before]])
  const index = createMutableIndex(
    makeSnapshot([
      makeEntry({ name: 'target', file: 'race.c', line: 0 }),
      makeEntry({ name: 'caller', file: 'race.c', line: 1, endLine: 5 }),
    ]),
  )

  let releaseRead!: () => void
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve
  })
  let readStarted!: () => void
  const started = new Promise<void>((resolve) => {
    readStarted = resolve
  })
  let firstRead = true
  const readFile: ReadFileFn = async (rel) => {
    if (rel !== 'race.c') throw new Error(`ENOENT ${rel}`)
    if (firstRead) {
      firstRead = false
      // 捕获发起读盘这一刻的文本，再在 gate 上等待，模拟慢读盘。
      const captured = texts.get(rel)!
      readStarted()
      await readGate
      return captured
    }
    return texts.get(rel)!
  }

  const inflight = findReferences(index, 'target', readFile)
  await started
  // 读盘在途时编辑 overlay 并清缓存（service 在 commitSnapshot 里正是这个顺序）。
  texts.set('race.c', after)
  index.applyFile({ path: 'race.c', mtimeMs: 2, size: 2 }, [
    makeEntry({ name: 'target', file: 'race.c', line: 0 }),
    makeEntry({ name: 'caller', file: 'race.c', line: 1, endLine: 6 }),
  ])
  clearReferenceCache()
  releaseRead()

  const stale = await inflight
  assert.equal(stale.length, 1, '在途查询本身仍返回它开始时的结果（旧结果允许返回给本查询）')

  // 旧实现会把上面这 1 条结果写回「清空后」的缓存（快照身份未变），下面的查询会命中旧值。
  const fresh = await findReferences(index, 'target', readFile)
  assert.equal(fresh.length, 2, '清缓存后的查询必须看到编辑后的 2 处引用')
})

test('callersOf: 在途查询遇到 clearCallGraphCache 不会把旧函数区间写回', async () => {
  // 命中行不变，只改函数名 caller -> wrapper：只有 scanCache（函数区间）决定归属。
  const before = [
    'void target(void)',
    '{',
    '}',
    'void caller(void)',
    '{',
    '    target();',
    '}',
    '',
  ].join('\n')
  const after = before.replace('void caller(void)', 'void wrapper(void)')
  const texts = new Map<string, string>([['range.c', before]])
  const index = createMutableIndex(
    makeSnapshot([
      makeEntry({ name: 'target', file: 'range.c', line: 0, endLine: 2 }),
      makeEntry({ name: 'caller', file: 'range.c', line: 3, endLine: 6 }),
    ]),
  )

  let releaseRead!: () => void
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve
  })
  let readStarted!: () => void
  const started = new Promise<void>((resolve) => {
    readStarted = resolve
  })
  let reads = 0
  const readFile: ReadFileFn = async (rel) => {
    if (rel !== 'range.c') throw new Error(`ENOENT ${rel}`)
    reads += 1
    // 第 1 次给 findReferences，第 2 次是 rangesForFile 前的读文本——在这里延迟。
    if (reads === 2) {
      const captured = texts.get(rel)!
      readStarted()
      await readGate
      return captured
    }
    return texts.get(rel)!
  }

  const inflight = callersOf(index, 'target', readFile)
  await started
  texts.set('range.c', after)
  index.applyFile({ path: 'range.c', mtimeMs: 2, size: 2 }, [
    makeEntry({ name: 'target', file: 'range.c', line: 0, endLine: 2 }),
    makeEntry({ name: 'wrapper', file: 'range.c', line: 3, endLine: 6 }),
  ])
  clearCallGraphCache()
  releaseRead()

  const stale = await inflight
  assert.equal(stale.length, 1)
  assert.equal(stale[0]?.from?.name, 'caller', '在途查询仍按旧文本归属')

  // 旧实现会把旧文本算出的函数区间写回「清空后」的缓存（快照身份未变），归属仍然是 caller。
  const fresh = await callersOf(index, 'target', readFile)
  assert.equal(fresh.length, 1)
  assert.equal(fresh[0]?.from?.name, 'wrapper', '清缓存后的查询必须按新文本归属')
})

test('callersOf: overlay 原地编辑后 clearCallGraphCache 让函数区间反映新代码', async () => {
  const before = [
    'void handler(void)', // 0
    '{', // 1
    '}', // 2
    'void outer(void)', // 3
    '{', // 4
    '    handler();', // 5
    '}', // 6
    '',
  ].join('\n')
  // 编辑后 handler 扩展到整段（handler 调用变成自递归）；引用命中行/列保持不变，
  // 只有 scanSource 得到的函数区间变了——正好单独暴露 scanCache 的失效问题。
  const after = [
    'void handler(void)', // 0
    '{', // 1
    '    int unused = 0;', // 2
    '    unused++;', // 3
    '    unused++;', // 4
    '    handler();', // 5
    '}', // 6
    '',
  ].join('\n')
  let text = before
  const readFile: ReadFileFn = async (rel) => {
    if (rel === 'a.c') return text
    throw new Error(`ENOENT ${rel}`)
  }

  const base = makeSnapshot([
    makeEntry({ name: 'handler', file: 'a.c', line: 0, endLine: 2 }),
    makeEntry({ name: 'outer', file: 'a.c', line: 3, endLine: 6 }),
  ])
  const index = createMutableIndex(base)

  // 预热 scanCache（a.c 的函数区间来自编辑前的文本）
  const first = await callersOf(index, 'handler', readFile)
  assert.equal(first.length, 1)
  assert.equal(first[0]?.line, 5)
  assert.equal(first[0]?.from?.name, 'outer')

  text = after
  index.applyFile({ path: 'a.c', mtimeMs: 2, size: 2 }, [
    makeEntry({ name: 'handler', file: 'a.c', line: 0, endLine: 6 }),
  ])

  // 未清 callgraph 缓存：仍用旧区间把命中归到 outer（service 修复前的行为）
  const stale = await callersOf(index, 'handler', readFile)
  assert.equal(stale[0]?.from?.name, 'outer')

  clearCallGraphCache()
  const fresh = await callersOf(index, 'handler', readFile)
  assert.equal(fresh[0]?.from?.name, 'handler')
})
