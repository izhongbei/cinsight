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
const {
  createMutableIndex,
  createMutableIndexFromDeltas,
} = require(path.join(EXT_ROOT, 'dist/src/core/overlay-index.js'))
const {
  appendSnapshotDelta,
  compactSnapshot,
  flushSnapshotDeltaAppends,
  readSnapshotDeltas,
  snapshotDeltaBytes,
  snapshotDeltaPath,
} = require(path.join(EXT_ROOT, 'dist/src/core/snapshot-delta.js'))
const { DEFAULT_EXCLUDE } = require(path.join(EXT_ROOT, 'dist/src/shared/types.js'))
const { getSymbolTableColumns } = require(path.join(EXT_ROOT, 'dist/src/core/symbol-table.js'))
const { groupDefinitions } = require(path.join(EXT_ROOT, 'dist/src/core/definition-groups.js'))
const { rankDefinitions } = require(path.join(EXT_ROOT, 'dist/src/core/rank-definitions.js'))
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)

/**
 * 0.8.0 新增指标的独立子进程：读同一批源码，统计原始 `#include` 数、解析命中数、
 * 内容哈希与 include 扫描的单线程 CPU 成本。
 *
 * 放在子进程里的理由：这段是**额外**的全语料扫描（构建本身已经扫过一遍），如果在主进程
 * 里跑会把字符串/剥离结果留在 V8 堆上，抬高后面打印的 RSS，让「内存」指标失真。子进程
 * 的分配随退出释放，主进程的构建/加载内存保持可比。
 */
const GRAPH_CHILD_SCRIPT = String.raw`
'use strict'
const path = require('node:path')
const fsp = require('node:fs/promises')
const extRoot = process.argv[1]
const snapshotPath = process.argv[2]
const workspaceRoot = process.argv[3]
const { loadSnapshot } = require(path.join(extRoot, 'dist/src/core/store.js'))
const { getSymbolTableColumns } = require(path.join(extRoot, 'dist/src/core/symbol-table.js'))
const { scanIncludes } = require(path.join(extRoot, 'dist/src/core/scan.js'))
const { hashContent64 } = require(path.join(extRoot, 'dist/src/core/hash.js'))
const { resolveIncludePaths } = require(path.join(extRoot, 'dist/src/core/include-resolve.js'))
const hrtime = process.hrtime.bigint

async function forEachConcurrent(items, limit, worker) {
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      await worker(items[index])
    }
  }))
}

async function main() {
  const table = await loadSnapshot(snapshotPath)
  if (!table) throw new Error('graph child: snapshot load failed')
  const columns = getSymbolTableColumns(table)
  const indexedPaths = new Set(table.files.map((file) => file.path))
  const context = { indexedPaths, roots: table.roots }
  let bytes = 0
  let directives = 0
  let filesWithIncludes = 0
  let resolvedDirectives = 0
  let scanNs = 0n
  let resolveNs = 0n
  let hashNs = 0n
  const startedAt = performance.now()
  await forEachConcurrent(table.files, 16, async (file) => {
    const text = await fsp.readFile(path.join(workspaceRoot, file.path), 'latin1')
    bytes += text.length
    let start = hrtime()
    const includes = scanIncludes(text)
    scanNs += hrtime() - start
    directives += includes.length
    if (includes.length > 0) filesWithIncludes += 1
    start = hrtime()
    resolvedDirectives += resolveIncludePaths(file.path, includes.map((include) => include.path), context).length
    resolveNs += hrtime() - start
    start = hrtime()
    hashContent64(text)
    hashNs += hrtime() - start
  })
  const toMs = (value) => Number(value) / 1e6
  return {
    files: table.files.length,
    bytes,
    directives,
    filesWithIncludes,
    resolvedDirectives,
    tableEdges: columns ? columns.includeTargets.length : 0,
    scanMs: toMs(scanNs),
    resolveMs: toMs(resolveNs),
    hashMs: toMs(hashNs),
    passMs: performance.now() - startedAt,
  }
}

main()
  .then((result) => process.stdout.write(JSON.stringify(result)))
  .catch((error) => {
    console.error(error && error.stack ? error.stack : error)
    process.exit(1)
  })
`

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
const size = (bytes) =>
  bytes >= 1048576 ? mb(bytes) : bytes >= 1024 ? (bytes / 1024).toFixed(1) + ' KB' : bytes + ' B'

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

  // v4 元数据（直接从构建好的内存表读，不额外读盘）：include 边、条件符号、内容哈希
  const columns = getSymbolTableColumns(result.snapshot)
  let includeEdgeCount = 0
  if (columns) {
    includeEdgeCount = columns.includeTargets.length
    let filesWithIncludes = 0
    for (let fileIndex = 0; fileIndex < result.snapshot.fileCount; fileIndex++) {
      if (columns.includeOffsets[fileIndex + 1] > columns.includeOffsets[fileIndex]) filesWithIncludes += 1
    }
    let conditionalEntries = 0
    for (let index = 0; index < columns.conditionIds.length; index++) {
      if (columns.conditionIds[index] !== 0) conditionalEntries += 1
    }
    let hashedFiles = 0
    for (let fileIndex = 0; fileIndex < result.snapshot.fileCount; fileIndex++) {
      if (columns.contentHashLo[fileIndex] !== 0 || columns.contentHashHi[fileIndex] !== 0) hashedFiles += 1
    }
    const percent = (part, whole) => (whole > 0 ? ((part / whole) * 100).toFixed(1) + '%' : 'n/a')
    console.log('=== v4 metadata (built table) ===')
    console.log('  include edges :', includeEdgeCount, 'resolved |', filesWithIncludes, 'files with edges')
    console.log('  conditions    :', conditionalEntries, '/', columns.conditionIds.length,
      'symbols conditional (' + percent(conditionalEntries, columns.conditionIds.length) + ') |',
      Math.max(0, columns.conditions.length - 1), 'distinct texts')
    console.log('  content hashes:', hashedFiles, '/', result.snapshot.fileCount, 'files')
    console.log('')

    // 快照体积构成（与 store.encodeSnapshot 的布局逐项对齐，便于核对增长来源）
    const rootsBytes = Buffer.byteLength(JSON.stringify(result.snapshot.roots), 'utf8')
    const headerBytes = 32 + rootsBytes
    let fileBytes = 0
    for (const file of result.snapshot.files) {
      fileBytes += 4 + Buffer.byteLength(file.path, 'utf8') + 20
    }
    let nameBytes = 0
    for (const name of columns.names) nameBytes += 4 + Buffer.byteLength(name, 'utf8')
    let conditionBytes = 4
    for (const condition of columns.conditions) conditionBytes += 4 + Buffer.byteLength(condition, 'utf8')
    const symbolColumnBytes = columns.nameIds.length * 23
    const offsetBytes =
      (columns.names.length + 1) * 4 +
      (result.snapshot.fileCount + 1) * 4 +
      columns.nameIds.length * 4 +
      (result.snapshot.fileCount + 1) * 4
    const includeBytes = includeEdgeCount * 4
    const compositionBytes =
      headerBytes + fileBytes + nameBytes + conditionBytes + symbolColumnBytes + offsetBytes + includeBytes
    console.log('=== snapshot composition (v4) ===')
    console.log('  header+roots :', size(headerBytes))
    console.log('  file records :', size(fileBytes),
      '(' + result.snapshot.fileCount + ' paths + 64-bit content hash)')
    console.log('  name table   :', size(nameBytes), '(' + columns.names.length + ' names)')
    console.log('  conditions   :', size(conditionBytes), '(' + Math.max(0, columns.conditions.length - 1) + ' distinct texts)')
    console.log('  symbol cols  :', size(symbolColumnBytes), '(' + columns.nameIds.length + ' entries x 23 B)')
    console.log('  offsets      :', size(offsetBytes), '(name/file/entry lookup arrays)')
    console.log('  include CSR  :', size(includeBytes), '(' + includeEdgeCount + ' edges)')
    console.log('  total        :', size(compositionBytes), compositionBytes === snapshotBytes
      ? '(matches snapshot ✅)'
      : '(⚠️ differs from snapshot ' + size(snapshotBytes) + ')')
    console.log('')
  }

  // include 图/内容哈希的额外指标：子进程读同一批源码（不污染主进程内存）
  {
    const tChild = performance.now()
    const { stdout } = await execFileAsync(
      process.execPath,
      ['-e', GRAPH_CHILD_SCRIPT, EXT_ROOT, snapshotPath, WORKSPACE_ROOT],
      { maxBuffer: 16 * 1024 * 1024 },
    )
    const graph = JSON.parse(stdout)
    const childMs = performance.now() - tChild
    const rawPct =
      graph.directives > 0 ? ((graph.tableEdges / graph.directives) * 100).toFixed(1) + '%' : 'n/a'
    const parity = graph.tableEdges === graph.resolvedDirectives
    console.log('=== include graph / hashing (v4, extra child-process pass) ===')
    console.log('  raw includes :', graph.directives, 'directives in', graph.filesWithIncludes, 'of', graph.files,
      'files |', (graph.bytes / 1048576).toFixed(1), 'MB')
    console.log('  resolved     :', graph.tableEdges, '/', graph.directives,
      'directives (' + rawPct + '; per-file de-duplicated)', '| resolver parity:',
      parity ? 'yes ✅' : 'NO (' + graph.resolvedDirectives + ' vs ' + graph.tableEdges + ') ⚠️')
    console.log('  scan cost    :', graph.scanMs.toFixed(0), 'ms raw include scan |', graph.resolveMs.toFixed(0),
      'ms resolution |', graph.hashMs.toFixed(0), 'ms content hash (single-thread child, page-warm)')
    console.log('  hash rate    :', (graph.bytes / 1048576 / (graph.hashMs / 1000)).toFixed(0), 'MB/s;',
      ((graph.hashMs / total) * 100).toFixed(1) + '% of this build wall time')
    console.log('  child pass   :', graph.passMs.toFixed(0), 'ms (read+scan+resolve+hash);', childMs.toFixed(0),
      'ms incl. spawn/load (main-process RSS unaffected)')
    console.log('')
  }

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

  // 增量符号索引：overlay apply（O(Δ)，不重建列）+ snapshot delta 追加 + compaction
  {
    const target = loaded.files.find((file) => loaded.entriesInFile(file.path).length > 0)
    if (target) {
      const targetEntries = loaded.entriesInFile(target.path)
      const deltaPath = snapshotDeltaPath(snapshotPath)
      const index = createMutableIndex(loaded)

      const tApply = performance.now()
      index.applyFile({ path: target.path, mtimeMs: Date.now(), size: target.size }, targetEntries)
      const applyMs = ms(tApply)

      const tDelta = performance.now()
      const bytes = await appendSnapshotDelta(deltaPath, {
        kind: 'set',
        path: target.path,
        mtimeMs: Date.now(),
        size: target.size,
        entries: targetEntries,
      })
      const deltaMs = ms(tDelta)
      const deltaBytes = await snapshotDeltaBytes(deltaPath)

      // base + delta 重放校验：条目数必须与 overlay 一致
      const records = await readSnapshotDeltas(deltaPath)
      const replayed = createMutableIndexFromDeltas(loaded, records)

      const tFlatten = performance.now()
      const flat = index.flatten()
      const flattenMs = ms(tFlatten)
      await flushSnapshotDeltaAppends()

      const tCompact = performance.now()
      const { baseBytes, deltaTruncated } = await compactSnapshot(snapshotPath, flat)
      const compactMs = ms(tCompact)
      const afterCompact = await snapshotDeltaBytes(deltaPath)

      console.log('=== incremental symbol index ===')
      console.log('  target       :', target.path, `(${targetEntries.length} symbols)`)
      console.log('  overlay apply:', applyMs, 'ms; pending:', index.pendingChanges,
        applyMs < 5 ? '(✅ <5 ms)' : '(⚠️ >=5 ms)')
      console.log('  delta append :', size(bytes), 'in', deltaMs, 'ms',
        bytes < 10 * 1024 ? '(✅ <10 KB)' : '(⚠️ >=10 KB)')
      console.log('  delta size   :', size(deltaBytes))
      console.log('  replay check :', records.length, 'records; entries match:',
        replayed.entryCount === index.entryCount ? 'yes ✅' : `NO (${replayed.entryCount} vs ${index.entryCount}) ⚠️`)
      console.log('  flatten      :', flattenMs, 'ms; entries:', flat.entryCount)
      console.log('  compaction   :', compactMs, 'ms; base', mb(baseBytes),
        deltaTruncated ? '(delta cleared ✅)' : '(no delta ⚠️)')
      console.log('  delta after  :', size(afterCompact))
    }
  }

  // 快照 delta 追加成本：稳态（缓存命中，只 stat）vs 4MB 附近 vs 冷启动（读 + 只按长度扫描）
  {
    const scaleBase = path.join('/tmp', 'si-perf-delta-scale-' + Date.now() + '.sidx')
    const scaleDelta = snapshotDeltaPath(scaleBase)
    const coldBase = path.join('/tmp', 'si-perf-delta-cold-' + Date.now() + '.sidx')
    const coldDelta = snapshotDeltaPath(coldBase)
    const COMPACT_THRESHOLD = 4 * 1024 * 1024
    const smallRecord = {
      kind: 'set',
      path: 'scale.c',
      mtimeMs: Date.now(),
      size: 1024,
      entries: Array.from({ length: 22 }, (_, index) => ({
        name: `scale_sym_${index}`,
        kind: 'function',
        file: 'scale.c',
        line: index,
        endLine: index + 1,
        column: 0,
      })),
    }
    const fillerRecord = {
      kind: 'set',
      path: 'filler.c',
      mtimeMs: Date.now(),
      size: 4096,
      entries: Array.from({ length: 2500 }, (_, index) => ({
        name: `filler_sym_${index}`,
        kind: 'function',
        file: 'filler.c',
        line: index,
        endLine: index + 1,
        column: 0,
      })),
    }
    try {
      const timings = []
      for (let index = 0; index < 10; index++) {
        const start = performance.now()
        await appendSnapshotDelta(scaleDelta, smallRecord)
        timings.push(performance.now() - start)
      }
      const firstMs = timings[0]
      const rest = timings.slice(1)
      const restAvg = rest.reduce((sum, value) => sum + value, 0) / rest.length
      const restMax = Math.max(...rest)

      let size = await snapshotDeltaBytes(scaleDelta)
      let grown = 0
      while (size < COMPACT_THRESHOLD) {
        await appendSnapshotDelta(scaleDelta, fillerRecord)
        size = await snapshotDeltaBytes(scaleDelta)
        grown += 1
      }
      const startWarm = performance.now()
      await appendSnapshotDelta(scaleDelta, fillerRecord)
      const warmNearThresholdMs = performance.now() - startWarm
      const nearThresholdSize = await snapshotDeltaBytes(scaleDelta)

      // 复制到新路径 -> 进程内没有尾部缓存 -> 必须读盘 + offset 扫描（一次性恢复成本）
      await fsp.copyFile(scaleDelta, coldDelta)
      const startCold = performance.now()
      await appendSnapshotDelta(coldDelta, fillerRecord)
      const coldScanMs = performance.now() - startCold
      const coldSize = await snapshotDeltaBytes(coldDelta)

      const fixed = (value) => value.toFixed(2)
      console.log('=== snapshot delta append scaling ===')
      console.log('  appends      : 10 to a fresh delta (offset scan + tail cache)')
      console.log('  first append :', fixed(firstMs), 'ms (new file)')
      console.log('  appends 2..10:', fixed(restAvg), 'ms avg |', fixed(restMax), 'ms max',
        restMax < 5 ? '(✅ warm appends <5 ms)' : '(⚠️ warm appends >=5 ms)')
      console.log('  grow to cap  :', grown, 'x 64KB records ->', size.toFixed(2), 'bytes')
      console.log('  near threshold:', fixed(warmNearThresholdMs), 'ms for append at',
        (nearThresholdSize / 1048576).toFixed(2), 'MB (warm cache)')
      console.log('  cold tail scan:', fixed(coldScanMs), 'ms for append at',
        (coldSize / 1048576).toFixed(2), 'MB (read + offset scan, no entry decode)')
      console.log('')
    } finally {
      await fsp.rm(scaleDelta, { force: true })
      await fsp.rm(coldDelta, { force: true })
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

  // 0.8.0 定义排序/分组：取「定义数最多」的名字，在真实 include 上下文中测 F12 路径
  {
    const loadedColumns = getSymbolTableColumns(loaded)
    if (loadedColumns && loadedColumns.names.length > 0) {
      let hotName = ''
      let hotCount = 0
      for (let nameId = 0; nameId < loadedColumns.names.length; nameId++) {
        const count = loadedColumns.nameOffsets[nameId + 1] - loadedColumns.nameOffsets[nameId]
        if (count > hotCount) {
          hotCount = count
          hotName = loadedColumns.names[nameId]
        }
      }
      if (hotName !== '' && hotCount > 1) {
        const hotDefs = loaded.findByName(hotName)
        const defFiles = new Set(hotDefs.map((entry) => entry.file))
        // 选一个「直接 include 了最多定义文件」的真实源文件当光标文件；没有就退回第一个定义文件
        let sourceFile = hotDefs[0].file
        let bestHits = 0
        for (const file of loaded.files) {
          const targets = loaded.includedFiles(file.path)
          if (targets.length === 0) continue
          let hits = 0
          for (const target of targets) if (defFiles.has(target)) hits += 1
          if (hits > bestHits) {
            bestHits = hits
            sourceFile = file.path
          }
        }
        const context = { sourceFile, roots: loaded.roots, table: loaded }
        const tGroupCold = performance.now()
        const groups = groupDefinitions(hotDefs, context)
        const groupColdMs = performance.now() - tGroupCold
        const runs = 20
        let rankTotal = 0
        let rankMax = 0
        for (let run = 0; run < runs; run++) {
          const start = performance.now()
          rankDefinitions(hotDefs, context)
          const duration = performance.now() - start
          rankTotal += duration
          if (duration > rankMax) rankMax = duration
        }
        let groupTotal = 0
        let groupMax = 0
        for (let run = 0; run < runs; run++) {
          const start = performance.now()
          groupDefinitions(hotDefs, context)
          const duration = performance.now() - start
          groupTotal += duration
          if (duration > groupMax) groupMax = duration
        }
        let multiCopyGroups = 0
        let maxCopies = 0
        let includedReps = 0
        let conditionalReps = 0
        let entriesKept = 0
        for (const group of groups) {
          entriesKept += group.entries.length
          if (group.copies > 1) multiCopyGroups += 1
          if (group.copies > maxCopies) maxCopies = group.copies
          if (group.included) includedReps += 1
          if (group.conditional) conditionalReps += 1
        }
        console.log('=== definition ranking / grouping (fresh table, hot name) ===')
        console.log('  hot name     :', hotName, '(' + hotDefs.length, 'definitions in', defFiles.size, 'files)')
        console.log('  cursor file  :', sourceFile, '(directly includes', bestHits, 'definition files)')
        console.log('  group first  :', groupColdMs.toFixed(2), 'ms (cold include cache)',
          groupColdMs < 2 ? '(✅ <2 ms)' : '(⚠️ >=2 ms)')
        console.log('  rank warm    :', (rankTotal / runs).toFixed(2), 'ms avg |', rankMax.toFixed(2),
          'ms max (' + runs + 'x)')
        console.log('  group warm   :', (groupTotal / runs).toFixed(2), 'ms avg |', groupMax.toFixed(2),
          'ms max (' + runs + 'x)')
        console.log('  groups       :', groups.length, '| multi-copy:', multiCopyGroups, '| max copies:', maxCopies,
          '| included reps:', includedReps, '| conditional reps:', conditionalReps)
        console.log('  preserved    :', entriesKept === hotDefs.length
          ? 'all ' + hotDefs.length + ' definitions kept ✅'
          : '⚠️ ' + entriesKept + '/' + hotDefs.length)
        console.log('')
      }
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
