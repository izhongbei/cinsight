import test from 'node:test'
import assert from 'node:assert/strict'
import { collectIdentifierHashes } from '../src/core/nameindex'
import {
  scanConditions,
  scanFileMeta,
  scanFileMetaFromStripped,
  scanIncludes,
  scanSource,
  stripSources,
} from '../src/core/scan'

/**
 * 同时包含注释/字符串伪指令、include、guard 内嵌套条件、else 分支、extern "C" 包裹与 typedef：
 * 旧的「每个 helper 各自 strip」路径与新的「strip 一次 + 复用」路径必须完全一致。
 */
const TRICKY = [
  '/* license: #include "fake.h" #ifdef FAKE */', // 0
  '#ifndef TRICKY_GUARD_H', // 1
  '#define TRICKY_GUARD_H', // 2
  'extern "C" {', // 3
  '#include "local.h"', // 4
  '  #  include <sys/types.h>', // 5
  '#ifdef FOO', // 6
  'static const char *s = "#include <string-fake.h>";', // 7
  '// #include "line-fake.h"', // 8
  'int guarded_fn(int a) { return a; }', // 9
  '#else', // 10
  'int other_fn(void) { return 2; }', // 11
  '#endif', // 12
  'char *c = "not #ifdef";', // 13
  '#if !defined(BAR) || defined(BAZ)', // 14
  'typedef struct node { int v; } node_t;', // 15
  '#endif /* BAR */', // 16
  'int tail_fn(void);', // 17
  '}', // 18
  '#endif /* TRICKY_GUARD_H */', // 19
].join('\n')

test('single-strip scan matches the double-strip helpers exactly', () => {
  const stripped = stripSources(TRICKY)

  // 旧路径：每个 helper 内部各自 strip
  const oldSymbols = scanSource(TRICKY)
  const oldIncludes = scanIncludes(TRICKY)
  const oldTimeline = scanConditions(TRICKY)

  // 新路径：只 strip 一次，符号与元数据共用
  const newSymbols = scanSource(TRICKY, stripped)
  const meta = scanFileMetaFromStripped(stripped, TRICKY)

  assert.deepEqual(newSymbols, oldSymbols)
  assert.deepEqual(meta.includes, oldIncludes)
  assert.deepEqual(meta.timeline, oldTimeline)
  assert.deepEqual(scanFileMeta(TRICKY), meta)
  // 标识符哈希也可复用同一份 stripped（worker 的第三条剥离路径）
  assert.deepEqual(collectIdentifierHashes(TRICKY, stripped), collectIdentifierHashes(TRICKY))
})

test('single-strip fixture really exercises comments, strings, guard and inner conditions', () => {
  const meta = scanFileMeta(TRICKY)
  // 字符串/注释里的伪 include 不能出现，真实 include 的路径与行号保留
  assert.deepEqual(meta.includes, [
    { path: 'local.h', line: 4, angled: false },
    { path: 'sys/types.h', line: 5, angled: true },
  ])
  const byName = new Map(scanSource(TRICKY).map((symbol) => [symbol.name, symbol]))
  // guard 帧透明，guard 内层 #ifdef 仍保留（else 分支沿用同一外层条件）
  assert.equal(byName.get('guarded_fn')?.condition, '#ifdef FOO')
  assert.equal(byName.get('other_fn')?.condition, '#ifdef FOO')
  assert.equal(byName.get('tail_fn')?.condition, undefined)
  assert.equal(byName.get('node_t')?.condition, '#if !defined(BAR) || defined(BAZ)')
})
