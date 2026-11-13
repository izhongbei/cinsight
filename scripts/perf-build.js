#!/usr/bin/env node
/**
 * 真实仓库压测：对指定目录构建符号索引，并测量搜索/引用/调用图耗时。
 *
 * 用法（在扩展目录下）：
 *   node scripts/perf-build.js plat plugin
 *   node scripts/perf-build.js --query=fopen component plat
 *
 * 输出：文件数、符号数、各阶段耗时、快照体积、关键查询耗时、内存 RSS。
 */
'use strict'

const path = require('node:path')
const fs = require('node:fs')
const fsp = require('node:fs/promises')

const EXT_ROOT = path.resolve(__dirname, '..')
const WORKSPACE_ROOT = path.resolve(EXT_ROOT, '..', '..')

const { buildIndex } = require(path.join(EXT_ROOT, 'dist/src/core/indexer.js'))
const { loadSnapshot, saveSnapshot } = require(path.join(EXT_ROOT, 'dist/src/core/store.js'))
const { searchSymbols, findByName } = require(path.join(EXT_ROOT, 'dist/src/core/query.js'))
const { findReferences, clearReferenceCache } = require(path.join(EXT_ROOT, 'dist/src/core/references.js'))
const {
  appendNameIndexDelta,
  candidatesForName,
  collectIdentifierHashes,
  loadNameIndexWithDelta,
  nameIndexDeltaBytes,
  nameIndexDeltaPath,
} = require(path.join(EXT_ROOT, 'dist/src/core/nameindex.js'))
const { callersOf, calleesOf } = require(path.join(EXT_ROOT, 'dist/src/core/callgraph.js'))
const { readSignature } = require(path.join(EXT_ROOT, 'dist/src/core/signature.js'))
const { DEFAULT_EXCLUDE } = require(path.join(EXT_ROOT, 'dist/src/shared/types.js'))

const args = process.argv.slice(2)
const queryArg = args.find((a) => a.startsWith('--query='))
const roots = args.filter((a) => !a.startsWith('--'))
if (!roots.length) {
  console.error('用法: node scripts/perf-build.js <相对 workspace 的目录...> [--query=<symbol>]')
  process.exit(2)
}

const readCounts = new Map()
const readFile = async (rel) => {
  readCounts.set(rel, (readCounts.get(rel) ?? 0) + 1)
  return fsp.readFile(path.join(WORKSPACE_ROOT, rel), 'latin1')
}
const snapshotPath = path.join('/tmp', 'si-perf-snapshot-' + Date.now() + '.sidx')
const nameIndexPath = path.join('/tmp', 'si-perf-names-' + Date.now() + '.names')

const ms = (start) => Math.round(performance.now() - start)
const mb = (bytes) => (bytes / 1048576).toFixed(2) + ' MB'

async function main() {
  console.log('workspace :', WORKSPACE_ROOT)
  console.log('roots     :', roots.join(', '))
  console.log('')

  const t0 = performance.now()
  let lastPhase = ''
  const result = await buildIndex({
    workspaceRoot: WORKSPACE_ROOT,
    roots,
    exclude: [...DEFAULT_EXCLUDE],
    maxFileSizeKB: 4096,
    concurrency: 4,
    followSymlinks: false,
    readFile,
    snapshotPath,
    nameIndexPath,
    onProgress: (p) => {
      const label = p.phase + (p.phase === 'parse' && p.total ? ` ${p.done}/${p.total}` : '')
      if (label !== lastPhase && (p.phase !== 'parse' || p.done === p.total || p.done % 5000 === 0)) {
        lastPhase = label
        process.stdout.write(`\r  progress: ${label}          `)
      }
    },
  })
  process.stdout.write('\r')
  const total = ms(t0)
  const summary = result.summary
  const snapshotBytes = summary.snapshotBytes || (await fsp.stat(snapshotPath)).size

  console.log('=== build ===')
  console.log('  files        :', summary.files)
  console.log('  symbols      :', summary.entries)
  console.log('  added/updated/removed/unchanged/skipped:',
    summary.added, summary.updated, summary.removed, summary.unchanged, summary.skipped)
  console.log('  duration     :', total, 'ms')
  console.log('  snapshot     :', mb(snapshotBytes))
  console.log('  nameIndex    :', summary.nameIndexBytes ? mb(summary.nameIndexBytes) : 'not built')
  const perFile = [...readCounts.values()]
  const totalReads = perFile.reduce((a, b) => a + b, 0)
  console.log('  reads        :', totalReads, 'total |', perFile.length ? Math.max(...perFile) : 0, 'max per file',
    perFile.length && Math.max(...perFile) === 1 ? '(single-pass ✅)' : '(⚠️ multi-pass)')
  console.log('  rss          :', mb(process.memoryUsage().rss))
  console.log('')

  const tLoad = performance.now()
  const loaded = await loadSnapshot(snapshotPath)
  console.log('=== load snapshot ===')
  console.log('  duration     :', ms(tLoad), 'ms; entries:', loaded ? loaded.entryCount : 'FAILED')
  if (!loaded) throw new Error('snapshot load failed')

  // 单文件增量保存：只追加 delta（与索引总量无关）
  if (summary.nameIndexBytes) {
    const rel = loaded.files[0]?.path
    if (rel) {
      const hashes = collectIdentifierHashes(await readFile(rel))
      const tDelta = performance.now()
      const bytes = await appendNameIndexDelta(nameIndexDeltaPath(nameIndexPath), { kind: 'set', path: rel, hashes })
      console.log('  delta append :', mb(bytes), 'in', ms(tDelta), 'ms (per-file save, no full rewrite)')
      console.log('  delta size   :', mb(await nameIndexDeltaBytes(nameIndexDeltaPath(nameIndexPath))))
    }
  }

  const tName = performance.now()
  const nameIndex = await loadNameIndexWithDelta(nameIndexPath)
  console.log('=== load reference index ===')
  console.log('  duration     :', ms(tName), 'ms;', nameIndex
    ? `files=${nameIndex.filePaths.length} hashes=${nameIndex.hashes.length} size=${mb(require('fs').statSync(nameIndexPath).size)}`
    : 'FAILED')
  console.log('')

  let query = queryArg ? queryArg.slice('--query='.length) : ''
  if (!query) {
    let picked
    loaded.forEachEntry((entry) => {
      if (!picked && entry.kind === 'function' && entry.name.length > 4) picked = entry
    })
    query = picked?.name ?? ''
  }
  console.log('=== query:', query, '===')

  let t = performance.now()
  const found = searchSymbols(loaded, query, { limit: 50 })
  console.log('  searchSymbols:', ms(t), 'ms; hits:', found.length)

  t = performance.now()
  const defs = findByName(loaded, query)
  console.log('  findByName   :', ms(t), 'ms; defs:', defs.length)

  if (defs.length) {
    t = performance.now()
    const sig = await readSignature(readFile, defs[0])
    console.log('  readSignature:', ms(t), 'ms;', JSON.stringify(sig))

    // 全量扫描 vs 倒排索引（各自清缓存后冷跑，结果必须一致）
    clearReferenceCache()
    t = performance.now()
    const refsFull = await findReferences(loaded, query, readFile, { includeDeclaration: false })
    const refsFullMs = ms(t)

    clearReferenceCache()
    const candidates = nameIndex ? candidatesForName(nameIndex, query).length : -1
    t = performance.now()
    const refs = nameIndex
      ? await findReferences(loaded, query, readFile, { includeDeclaration: false, nameIndex })
      : refsFull
    const refsIndexedMs = ms(t)
    console.log('  references   : full scan', refsFullMs, 'ms vs indexed', refsIndexedMs,
      'ms; hits:', refs.length, '| candidate files:', candidates,
      '| speedup:', refsIndexedMs > 0 ? (refsFullMs / refsIndexedMs).toFixed(1) + 'x' : 'n/a')
    if (refs.length !== refsFull.length) throw new Error('indexed references differ from full scan')

    clearReferenceCache()
    t = performance.now()
    const callers = nameIndex
      ? await callersOf(loaded, query, readFile, { nameIndex })
      : await callersOf(loaded, query, readFile)
    console.log('  callers      :', ms(t), 'ms; hits:', callers.length)

    t = performance.now()
    const callees = await calleesOf(loaded, query, readFile)
    console.log('  callees      :', ms(t), 'ms; hits:', callees.length, callees.slice(0, 5).map((c) => c.name).join(', '))

    if (refs.length) {
      t = performance.now()
      const second = await findReferences(loaded, query, readFile, { includeDeclaration: false })
      console.log('  references(2):', ms(t), 'ms; hits:', second.length)
    }
  }

  console.log('')
  console.log('=== memory ===')
  const m = process.memoryUsage()
  console.log('  rss', mb(m.rss), '| heapUsed', mb(m.heapUsed), '| external', mb(m.external))
  console.log('')
  console.log('PERF DONE')
}

main().catch((error) => {
  console.error('PERF FAILED:', error && error.stack ? error.stack : error)
  process.exit(1)
})
