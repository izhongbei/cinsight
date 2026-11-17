# 增量索引（Overlay + Delta）、规模预算与诊断 —— 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把单文件保存从「O(n) 重建符号表 + 全量写 60MB 快照」改成「O(Δ) overlay 更新 + KB 级 delta 落盘」，并补上索引规模预算（C1）与一键诊断（C2）；全程只本地构建/安装，**用户确认前不发布**。

**Architecture:** 磁盘上 `symbols.sidx` 保持 v3 列式 base 不变，新增 append-only 的 `symbols.sidx.delta`；内存中用只读 base + overlay（`Map<path, slot|removed>`）叠加查询，阈值/空闲/关闭时 `flatten()` 成新 base 并原子写盘、清空 delta。查询路径通过 `SymbolTable` v2 契约统一，overlay 为空时走 base 快路径，性能不回退。

**Tech Stack:** TypeScript（CommonJS，零运行时依赖）、node:test、vsce 4.1.0、VS Code API（webview 不涉及本计划）。

**设计文档:** `docs/superpowers/specs/2026-11-17-index-incremental-overlay-diagnostics-design.md`（接口契约来源，实现必须与之一致）

## Global Constraints

- **发布策略**：本计划所有任务只做本地编译/测试/打包/安装；**禁止** `git push --tags`、`publish:ovsx`、`publish:vsce`、触发 publish workflow；发版必须等用户明确说 OK。
- 零运行时依赖（`package.json` 的 `dependencies` 保持为空；只允许 devDependencies）。
- `src/core/**` 不 import `vscode`；`src/shared/types.ts` 不放实现逻辑。
- 快照 base 格式保持 **v3**（`SNAPSHOT_VERSION` 不动）；新增 delta 文件必须自带 magic/version，损坏/截断可安全忽略。
- 现有 160 个测试必须保持通过；每个任务结束跑 `npm test` + `npm run smoke`。
- 中文注释与文档、英文代码标识符；不出现 "RCIOS" 字样。
- 文件写入用 `fs/promises`；原子写用 `.tmp` + rename；错误只记日志不抛到 UI。

---

## 文件结构（新增/修改总览）

| 文件 | 责任 |
|---|---|
| `src/core/symbol-order.ts` | **新增** 共享排序比较器（kind→name.length→name→file→line→col→endLine）与字符串比较 |
| `src/core/snapshot-delta.ts` | **新增** delta 编解码、追加、读取、compaction、路径/字节数 |
| `src/core/overlay-index.ts` | **新增** `MutableSymbolIndex`：base + overlay，apply/remove/合并查询/flatten |
| `src/core/index-budget.ts` | **新增** 预算评估（ok/warn/exceeded + 建议） |
| `src/core/diagnostics.ts` | **新增** `DiagnosticsInput` + Markdown 报告渲染 |
| `src/shared/types.ts` | 修改：`SymbolTable.forEachName` 签名；`BuildOptions.concurrencyCap?`；预算默认常量 |
| `src/core/query.ts` | 修改：适配 `forEachName(name)`；改用 `symbol-order` 比较器 |
| `src/core/indexer.ts` | 修改：应用 `concurrencyCap`；构建成功返回 base 表（已是 `SymbolTable`） |
| `src/vscode/service.ts` | 修改：加载 base+delta→mutable；保存/删除走 overlay+delta；compaction 调度；诊断 getters |
| `src/vscode/status.ts` | 修改：预算警告替代写死的 `MAX_SYMBOLS_WARNING` |
| `src/vscode/commands.ts` | 修改：注册 `si.showIndexDiagnostics` |
| `src/vscode/util.ts` | 修改（如需要）：诊断命令的文档打开 helper |
| `package.json` / `package.nls*.json` / `l10n/*` | 新增配置项与命令文案 |
| `test/*.test.ts` | 新增 4 个测试文件；修改 query 等受影响测试 |
| `README.md` / `CHANGELOG.md` | 文档（版本号在 T7 统一处理） |

---

### Task 1: 契约迁移 —— `SymbolTable` v2 + 共享比较器

**Files:**
- Create: `src/core/symbol-order.ts`
- Modify: `src/shared/types.ts:34-60`（`SymbolTable` 接口）、`src/core/query.ts`（`searchSymbols`/`findByName` 及本地比较器）、`src/core/symbol-table.ts`（`forEachName` 实现）
- Test: `test/symbol-order.test.ts`（新增）、`test/query.test.ts`（现有，保持通过）

**Interfaces:**
- Consumes: 现有 `SymbolTable`/`SymbolEntry`/`SYMBOL_KIND_ORDER`
- Produces:
  - `compareStrings(a: string, b: string): number`
  - `compareSymbolEntries(a: SymbolEntry, b: SymbolEntry): number`
  - `SymbolTable.forEachName(callback: (name: string) => void): void`（**签名变更**，后续任务依赖）
  - `query.searchSymbols(table, query, options)` 行为不变

- [ ] **Step 1: 写失败的测试（symbol-order + 新 forEachName 语义）**

```ts
// test/symbol-order.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'

import { compareStrings, compareSymbolEntries } from '../src/core/symbol-order'
import { createSymbolTable } from '../src/core/symbol-table'
import { SNAPSHOT_VERSION } from '../src/shared/types'
import type { SymbolEntry } from '../src/shared/types'

function entry(name: string, file: string, line: number, kind: SymbolEntry['kind'] = 'function'): SymbolEntry {
  return { name, kind, file, line, endLine: line, column: 0 }
}

test('symbol order: kind first, then name length, then name, file, line', () => {
  const values = [
    entry('zeta', 'a.c', 1),
    entry('alpha', 'b.c', 2),
    entry('beta', 'a.c', 3),
    entry('gamma', 'a.c', 4, 'declaration'),
  ]
  values.sort(compareSymbolEntries)
  assert.deepEqual(values.map((v) => `${v.kind}:${v.name}`), [
    'function:beta',   // 4 chars
    'function:zeta',   // 4 chars -> file/name tie-break
    'function:alpha',
    'declaration:gamma',
  ])
})

test('symbol order: compareStrings compares lexicographically', () => {
  assert.ok(compareStrings('a.c', 'b.c') < 0)
  assert.equal(compareStrings('x', 'x'), 0)
  assert.ok(compareStrings('b', 'a') > 0)
})

test('SymbolTable.forEachName yields deduplicated sorted names', () => {
  const table = createSymbolTable(
    ['root'],
    [
      { path: 'a.c', mtimeMs: 1, size: 1 },
      { path: 'b.c', mtimeMs: 1, size: 1 },
    ],
    [entry('beta', 'a.c', 1), entry('alpha', 'a.c', 2), entry('alpha', 'b.c', 3)],
    123,
    SNAPSHOT_VERSION,
  )
  const names: string[] = []
  table.forEachName((name) => names.push(name))
  assert.deepEqual(names, ['alpha', 'beta'])
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npm run compile
node --test dist/test/symbol-order.test.js
```
Expected: FAIL —— `Cannot find module '../src/core/symbol-order'`（编译错误）。

- [ ] **Step 3: 实现 `src/core/symbol-order.ts`**

```ts
import { SYMBOL_KIND_ORDER } from '../shared/types'
import type { SymbolEntry } from '../shared/types'

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** 与 v1 行为一致：kind 顺序 → 名字长度 → 名字 → 文件 → 行 → 列 → 结束行。 */
export function compareSymbolEntries(a: SymbolEntry, b: SymbolEntry): number {
  const kindOrder = SYMBOL_KIND_ORDER[a.kind] - SYMBOL_KIND_ORDER[b.kind]
  if (kindOrder !== 0) return kindOrder
  if (a.name.length !== b.name.length) return a.name.length - b.name.length
  if (a.name !== b.name) return compareStrings(a.name, b.name)
  if (a.file !== b.file) return compareStrings(a.file, b.file)
  if (a.line !== b.line) return a.line - b.line
  if (a.column !== b.column) return a.column - b.column
  return a.endLine - b.endLine
}
```

- [ ] **Step 4: 修改 `SymbolTable.forEachName` 契约与实现**

`src/shared/types.ts`：把 `forEachName(callback: (name: string, start: number, end: number) => void): void` 改为：

```ts
  /** 遍历去重后的名字（升序）；条目通过 findByName 获取。 */
  forEachName(callback: (name: string) => void): void
```

`src/core/symbol-table.ts` 的 `forEachName` 改为：

```ts
  forEachName(callback: (name: string) => void): void {
    const columns = this.columns
    for (let nameId = 0; nameId < columns.names.length; nameId++) {
      const start = columns.nameOffsets[nameId]!
      const end = columns.nameOffsets[nameId + 1]!
      if (start === end) continue
      callback(columns.names[nameId]!)
    }
  }
```

- [ ] **Step 5: 让 `query.ts` 适配新签名并复用比较器**

`src/core/query.ts` 顶部 import 改为：

```ts
import type { SymbolEntry, SymbolKind, SymbolTable } from '../shared/types'
import { compareStrings, compareSymbolEntries } from './symbol-order'
```

删除文件尾部的本地 `compareStrings` / `compareEntries` 两个函数（`searchSymbols` 里的 `compareEntries` 调用改为 `compareSymbolEntries`）。

`searchSymbols` 循环体改为：

```ts
  table.forEachName((name) => {
    if (matches.length >= candidateCap) return
    const weight = nameWeight(name, lowerQuery)
    if (weight < 0) return
    for (const entry of table.findByName(name)) {
      if (kinds && !kinds.has(entry.kind)) continue
      matches.push({ entry, weight })
      if (matches.length >= candidateCap) break
    }
  })
```

`findByName` 保持 `table.findByName(name).sort(compareSymbolEntries)`。

- [ ] **Step 6: 全量测试 + 冒烟，确认无回归**

```bash
npm test
npm run smoke
node --test dist/test/symbol-order.test.js
```
Expected: `symbol-order` 3 个测试 PASS；`npm test` 163 PASS 0 FAIL；smoke 输出 `SMOKE OK`。

- [ ] **Step 7: Commit**

```bash
git add src/core/symbol-order.ts src/shared/types.ts src/core/symbol-table.ts src/core/query.ts test/symbol-order.test.ts
git commit -m "refactor: SymbolTable v2 (name-only forEachName) + shared symbol comparators"
```

---

### Task 2: 快照 delta 编解码与 compaction

**Files:**
- Create: `src/core/snapshot-delta.ts`
- Test: `test/snapshot-delta.test.ts`

**Interfaces:**
- Consumes: `SymbolEntry`/`SymbolTable`；`KIND_CODES`（`src/core/symbol-table.ts`）；`saveSnapshot`（`src/core/store.ts`）
- Produces:
  - `snapshotDeltaPath(basePath: string): string`
  - `encodeSnapshotDeltaRecord(record: SnapshotDeltaRecord): Buffer`
  - `decodeSnapshotDeltaRecords(buffer: Buffer): SnapshotDeltaRecord[]`
  - `appendSnapshotDelta(deltaPath, record): Promise<number>`
  - `readSnapshotDeltas(deltaPath): Promise<SnapshotDeltaRecord[]>`
  - `snapshotDeltaBytes(deltaPath): Promise<number>`
  - `removeSnapshotDelta(deltaPath): Promise<void>`
  - `compactSnapshot(basePath, table): Promise<{ baseBytes: number; deltaTruncated: boolean }>`

- [ ] **Step 1: 写失败的测试**

```ts
// test/snapshot-delta.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendSnapshotDelta,
  compactSnapshot,
  decodeSnapshotDeltaRecords,
  encodeSnapshotDeltaRecord,
  readSnapshotDeltas,
  snapshotDeltaBytes,
  snapshotDeltaPath,
} from '../src/core/snapshot-delta'
import { loadSnapshot } from '../src/core/store'
import { createSymbolTable } from '../src/core/symbol-table'
import { SNAPSHOT_VERSION } from '../src/shared/types'
import type { SymbolEntry } from '../src/shared/types'

function entry(name: string, file: string, line: number): SymbolEntry {
  return { name, kind: 'function', file, line, endLine: line + 1, column: 4 }
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'si-snapdelta-'))
}

test('snapshot delta: set/remove records roundtrip', async () => {
  const dir = await tempDir()
  try {
    const deltaPath = join(dir, 'symbols.sidx.delta')
    const set = {
      kind: 'set' as const,
      path: 'a.c',
      mtimeMs: 123.5,
      size: 42,
      entries: [entry('alpha', 'a.c', 1), entry('beta', 'a.c', 2)],
    }
    const bytes = await appendSnapshotDelta(deltaPath, set)
    assert.ok(bytes > 0)
    const entries = await readSnapshotDeltas(deltaPath)
    assert.equal(entries.length, 1)
    assert.deepEqual(entries[0], set)

    await appendSnapshotDelta(deltaPath, { kind: 'remove', path: 'b.c' })
    const both = await readSnapshotDeltas(deltaPath)
    assert.deepEqual(both.map((r) => r.kind), ['set', 'remove'])
    assert.ok((await snapshotDeltaBytes(deltaPath)) > bytes, 'delta grows after the second record')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('snapshot delta: truncated tail is ignored; bad magic yields []', async () => {
  const dir = await tempDir()
  try {
    const deltaPath = join(dir, 'x.delta')
    await appendSnapshotDelta(deltaPath, { kind: 'remove', path: 'a.c' })
    const size = (await stat(deltaPath)).size
    await truncate(deltaPath, size - 2)
    assert.deepEqual(await readSnapshotDeltas(deltaPath), [])

    await writeFile(deltaPath, Buffer.from('NOPE', 'latin1'))
    assert.deepEqual(await readSnapshotDeltas(deltaPath), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('snapshot delta: encode/decode clamps column to u16', () => {
  const record = {
    kind: 'set' as const,
    path: 'a.c',
    mtimeMs: 1,
    size: 1,
    entries: [{ ...entry('x', 'a.c', 0), column: 70_000 }],
  }
  const decoded = decodeSnapshotDeltaRecords(encodeSnapshotDeltaRecord(record))
  assert.equal(decoded[0]?.kind, 'set')
  if (decoded[0]?.kind === 'set') assert.equal(decoded[0].entries[0]?.column, 0xffff)
})

test('snapshot delta: compact writes the base and removes the delta', async () => {
  const dir = await tempDir()
  try {
    const basePath = join(dir, 'symbols.sidx')
    const table = createSymbolTable(
      ['root'],
      [{ path: 'a.c', mtimeMs: 1, size: 1 }],
      [entry('alpha', 'a.c', 1)],
      1,
      SNAPSHOT_VERSION,
    )
    await appendSnapshotDelta(snapshotDeltaPath(basePath), {
      kind: 'set',
      path: 'b.c',
      mtimeMs: 2,
      size: 2,
      entries: [entry('beta', 'b.c', 3)],
    })
    const result = await compactSnapshot(basePath, table)
    assert.ok(result.baseBytes > 0)
    assert.equal(result.deltaTruncated, true)

    const loaded = await loadSnapshot(basePath)
    assert.ok(loaded)
    assert.equal(loaded!.entryCount, 1)
    assert.equal(await snapshotDeltaBytes(snapshotDeltaPath(basePath)), 0)
    assert.deepEqual(await readSnapshotDeltas(snapshotDeltaPath(basePath)), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npm run compile
```
Expected: FAIL —— `Cannot find module '../src/core/snapshot-delta'`。

- [ ] **Step 3: 实现 `src/core/snapshot-delta.ts`**

```ts
import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import * as path from 'node:path'

import type { SymbolEntry, SymbolTable } from '../shared/types'
import { saveSnapshot } from './store'
import { KIND_CODES } from './symbol-table'

export const SNAPSHOT_DELTA_MAGIC = 'SIDD'
export const SNAPSHOT_DELTA_VERSION = 1
const HEADER_BYTES = 8
const KIND_NAMES = ['function', 'declaration', 'macro', 'struct', 'union', 'enum', 'typedef'] as const

export type SnapshotDeltaRecord =
  | {
      readonly kind: 'set'
      readonly path: string
      readonly mtimeMs: number
      readonly size: number
      readonly entries: readonly SymbolEntry[]
    }
  | { readonly kind: 'remove'; readonly path: string }

export function snapshotDeltaPath(basePath: string): string {
  return `${basePath}.delta`
}

export function encodeSnapshotDeltaRecord(record: SnapshotDeltaRecord): Buffer {
  const pathBytes = Buffer.from(record.path, 'utf8')
  const header = 1 + 4 + pathBytes.length
  if (record.kind === 'remove') {
    const buffer = Buffer.allocUnsafe(header)
    buffer.writeUInt8(1, 0)
    buffer.writeUInt32LE(pathBytes.length, 1)
    pathBytes.copy(buffer, 5)
    return buffer
  }
  let entryBytes = 0
  const encoded = record.entries.map((entry) => {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    entryBytes += 4 + nameBytes.length + 4 + 4 + 2 + 1
    return { entry, nameBytes }
  })
  const buffer = Buffer.allocUnsafe(header + 8 + 4 + 4 + entryBytes)
  let offset = 0
  buffer.writeUInt8(0, offset)
  offset += 1
  buffer.writeUInt32LE(pathBytes.length, offset)
  offset += 4
  pathBytes.copy(buffer, offset)
  offset += pathBytes.length
  buffer.writeDoubleLE(record.mtimeMs, offset)
  offset += 8
  buffer.writeUInt32LE(Math.min(record.size ?? 0, 0xffffffff), offset)
  offset += 4
  buffer.writeUInt32LE(encoded.length, offset)
  offset += 4
  for (const { entry, nameBytes } of encoded) {
    buffer.writeUInt32LE(nameBytes.length, offset)
    offset += 4
    nameBytes.copy(buffer, offset)
    offset += nameBytes.length
    buffer.writeUInt32LE(entry.line, offset)
    offset += 4
    buffer.writeUInt32LE(entry.endLine, offset)
    offset += 4
    buffer.writeUInt16LE(Math.min(entry.column, 0xffff), offset)
    offset += 2
    buffer.writeUInt8(KIND_CODES[entry.kind] ?? 0, offset)
    offset += 1
  }
  return buffer
}

export function decodeSnapshotDeltaRecords(buffer: Buffer): SnapshotDeltaRecord[] {
  if (buffer.length < HEADER_BYTES) return []
  if (buffer.toString('latin1', 0, 4) !== SNAPSHOT_DELTA_MAGIC) return []
  if (buffer.readUInt32LE(4) !== SNAPSHOT_DELTA_VERSION) return []
  const records: SnapshotDeltaRecord[] = []
  let offset = HEADER_BYTES
  while (offset < buffer.length) {
    const recordStart = offset
    if (offset + 5 > buffer.length) break
    const kind = buffer.readUInt8(offset)
    const pathLength = buffer.readUInt32LE(offset + 1)
    offset += 5
    if (offset + pathLength > buffer.length) break
    const filePath = buffer.toString('utf8', offset, offset + pathLength)
    offset += pathLength
    if (kind === 1) {
      records.push({ kind: 'remove', path: filePath })
      continue
    }
    if (kind !== 0) break
    if (offset + 16 > buffer.length) { offset = recordStart; break }
    const mtimeMs = buffer.readDoubleLE(offset)
    offset += 8
    const size = buffer.readUInt32LE(offset)
    offset += 4
    const entryCount = buffer.readUInt32LE(offset)
    offset += 4
    const entries: SymbolEntry[] = []
    let truncated = false
    for (let index = 0; index < entryCount; index++) {
      if (offset + 4 > buffer.length) { truncated = true; break }
      const nameLength = buffer.readUInt32LE(offset)
      offset += 4
      if (offset + nameLength + 4 + 4 + 2 + 1 > buffer.length) { truncated = true; break }
      const name = buffer.toString('utf8', offset, offset + nameLength)
      offset += nameLength
      const line = buffer.readUInt32LE(offset)
      offset += 4
      const endLine = buffer.readUInt32LE(offset)
      offset += 4
      const column = buffer.readUInt16LE(offset)
      offset += 2
      const kindCode = buffer.readUInt8(offset)
      offset += 1
      entries.push({
        name,
        kind: KIND_NAMES[kindCode] ?? 'function',
        file: filePath,
        line,
        endLine,
        column,
      })
    }
    if (truncated) break
    records.push({ kind: 'set', path: filePath, mtimeMs, size, entries })
  }
  return records
}

export async function appendSnapshotDelta(
  deltaPath: string,
  record: SnapshotDeltaRecord,
): Promise<number> {
  let existing = 0
  try {
    existing = (await stat(deltaPath)).size
  } catch {
    existing = 0
  }
  const recordBuffer = encodeSnapshotDeltaRecord(record)
  let written = recordBuffer.length
  if (existing === 0) {
    const header = Buffer.alloc(HEADER_BYTES)
    header.write(SNAPSHOT_DELTA_MAGIC, 0, 'latin1')
    header.writeUInt32LE(SNAPSHOT_DELTA_VERSION, 4)
    await mkdir(path.dirname(deltaPath), { recursive: true })
    await appendFile(deltaPath, header)
    written += HEADER_BYTES
  }
  await appendFile(deltaPath, recordBuffer)
  return written
}

export async function readSnapshotDeltas(deltaPath: string): Promise<SnapshotDeltaRecord[]> {
  try {
    return decodeSnapshotDeltaRecords(await readFile(deltaPath))
  } catch {
    return []
  }
}

export async function snapshotDeltaBytes(deltaPath: string): Promise<number> {
  try {
    return (await stat(deltaPath)).size
  } catch {
    return 0
  }
}

export async function removeSnapshotDelta(deltaPath: string): Promise<void> {
  await unlink(deltaPath).catch(() => undefined)
}

/** 把当前表写成新 base，并删除 delta（原子写：store.saveSnapshot 内部 .tmp+rename）。 */
export async function compactSnapshot(
  basePath: string,
  table: SymbolTable,
): Promise<{ baseBytes: number; deltaTruncated: boolean }> {
  const baseBytes = await saveSnapshot(basePath, table)
  const deltaPath = snapshotDeltaPath(basePath)
  const had = (await snapshotDeltaBytes(deltaPath)) > 0
  await removeSnapshotDelta(deltaPath)
  return { baseBytes, deltaTruncated: had }
}
```

> 注意：`encodeSnapshotDeltaRecord` 里 `record.size ?? 0` 对 remove 不适用，但 remove 分支不读该字段；实现时若 TS 报错，改为 `record.kind === 'set' ? record.size : 0`。

- [ ] **Step 4: 运行测试确认通过**

```bash
npm run compile
node --test dist/test/snapshot-delta.test.js
```
Expected: 4 PASS。

- [ ] **Step 5: 全量测试**

```bash
npm test
```
Expected: 163 PASS 0 FAIL。

- [ ] **Step 6: Commit**

```bash
git add src/core/snapshot-delta.ts test/snapshot-delta.test.ts
git commit -m "feat: append-only snapshot delta codec + compaction"
```

---

### Task 3: Overlay 索引（O(Δ) 单文件更新）

**Files:**
- Create: `src/core/overlay-index.ts`
- Test: `test/overlay-index.test.ts`

**Interfaces:**
- Consumes: `SymbolTable`/`FileRecord`/`SymbolEntry`；`compareStrings`/`compareSymbolEntries`；`createSymbolTable`
- Produces:
  - `interface OverlayFileSlot { file: FileRecord; entries: readonly SymbolEntry[] }`
  - `interface MutableSymbolIndex extends SymbolTable { applyFile; removeFile; pendingChanges; pendingPaths(); flatten(); base }`
  - `createMutableIndex(base: SymbolTable): MutableSymbolIndex`
  - `createMutableIndexFromDeltas(base, records: readonly SnapshotDeltaRecord[]): MutableSymbolIndex`

- [ ] **Step 1: 写失败的测试（含属性测试）**

```ts
// test/overlay-index.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMutableIndex, createMutableIndexFromDeltas } from '../src/core/overlay-index'
import { createSymbolTable } from '../src/core/symbol-table'
import { compareSymbolEntries } from '../src/core/symbol-order'
import type { FileRecord, SymbolEntry } from '../src/shared/types'
import { SNAPSHOT_VERSION } from '../src/shared/types'

function entry(name: string, file: string, line: number): SymbolEntry {
  return { name, kind: 'function', file, line, endLine: line + 1, column: 2 }
}

function makeBase(): { base: ReturnType<typeof createSymbolTable>; files: FileRecord[] } {
  const files: FileRecord[] = [
    { path: 'a.c', mtimeMs: 1, size: 10 },
    { path: 'b.c', mtimeMs: 2, size: 20 },
    { path: 'c.h', mtimeMs: 3, size: 30 },
  ]
  const entries: SymbolEntry[] = [
    entry('alpha', 'a.c', 1),
    entry('beta', 'a.c', 5),
    entry('beta', 'b.c', 7),
    entry('gamma', 'b.c', 9),
    entry('delta', 'c.h', 2),
  ]
  return { base: createSymbolTable(['root'], files, entries, 111, SNAPSHOT_VERSION), files }
}

test('overlay: applyFile replaces a file and keeps counts/queries consistent', () => {
  const { base } = makeBase()
  const index = createMutableIndex(base)
  assert.equal(index.entryCount, 5)
  assert.equal(index.pendingChanges, 0)

  index.applyFile({ path: 'a.c', mtimeMs: 9, size: 99 }, [entry('alpha', 'a.c', 1), entry('omega', 'a.c', 4)])
  assert.equal(index.pendingChanges, 1)
  assert.equal(index.entryCount, 5) // a.c 原来 2 条 -> 新 2 条
  assert.deepEqual(index.findByName('beta').map((e) => e.file), ['b.c'])
  assert.deepEqual(index.findByName('omega').map((e) => e.file), ['a.c'])
  assert.deepEqual(index.entriesInFile('a.c').map((e) => e.name), ['alpha', 'omega'])
  assert.deepEqual(index.files.map((f) => f.path), ['a.c', 'b.c', 'c.h'])
  assert.equal(index.files[0]?.mtimeMs, 9)
})

test('overlay: removeFile hides base entries and files', () => {
  const { base } = makeBase()
  const index = createMutableIndex(base)
  assert.equal(index.removeFile('b.c'), true)
  assert.equal(index.removeFile('b.c'), false)
  assert.equal(index.entryCount, 3)
  assert.deepEqual(index.findByName('beta').map((e) => e.file), ['a.c'])
  assert.deepEqual(index.entriesInFile('b.c'), [])
  assert.deepEqual(index.files.map((f) => f.path), ['a.c', 'c.h'])
})

test('overlay: forEachEntry and forEachName include changes without removed files', () => {
  const { base } = makeBase()
  const index = createMutableIndex(base)
  index.removeFile('b.c')
  index.applyFile({ path: 'd.c', mtimeMs: 4, size: 4 }, [entry('epsilon', 'd.c', 1)])

  const names: string[] = []
  index.forEachName((name) => names.push(name))
  assert.deepEqual(names, ['alpha', 'beta', 'delta', 'epsilon'])

  const seen: string[] = []
  index.forEachEntry((e) => seen.push(`${e.file}:${e.name}`))
  assert.deepEqual(seen.sort(), ['a.c:alpha', 'a.c:beta', 'c.h:delta', 'd.c:epsilon'].sort())
})

test('overlay: flatten is equivalent to a full rebuild', () => {
  const { base, files } = makeBase()
  const index = createMutableIndex(base)
  index.applyFile({ path: 'a.c', mtimeMs: 9, size: 99 }, [entry('alpha', 'a.c', 1), entry('omega', 'a.c', 4)])
  index.removeFile('b.c')
  index.applyFile({ path: 'd.c', mtimeMs: 4, size: 4 }, [entry('epsilon', 'd.c', 1)])

  const flat = index.flatten()
  const expected = createSymbolTable(
    flat.roots,
    files.filter((f) => f.path !== 'b.c').concat([{ path: 'd.c', mtimeMs: 4, size: 4 }]).map((f) => f.path === 'a.c' ? { path: 'a.c', mtimeMs: 9, size: 99 } : f),
    [entry('alpha', 'a.c', 1), entry('omega', 'a.c', 4), entry('gamma', 'b.c', 9), entry('delta', 'c.h', 2), entry('epsilon', 'd.c', 1)].filter((e) => e.file !== 'b.c'),
    flat.builtAt,
    flat.version,
  )
  assert.deepEqual(flat.toArray().sort(compareSymbolEntries), expected.toArray().sort(compareSymbolEntries))
  for (const name of ['alpha', 'omega', 'beta', 'gamma', 'delta', 'epsilon']) {
    assert.deepEqual(flat.findByName(name), expected.findByName(name))
  }
  assert.deepEqual(flat.entriesInFile('a.c'), expected.entriesInFile('a.c'))
})

test('overlay: property-ish randomized updates always match a full rebuild', () => {
  let seed = 42
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  for (let round = 0; round < 20; round++) {
    const files: FileRecord[] = []
    const entries: SymbolEntry[] = []
    const names = ['n0', 'n1', 'n2', 'n3']
    for (let i = 0; i < 6; i++) {
      const file = `f${i}.c`
      files.push({ path: file, mtimeMs: i, size: i })
      const count = 1 + Math.floor(random() * 3)
      for (let j = 0; j < count; j++) entries.push(entry(names[(i + j) % names.length]!, file, j))
    }
    const base = createSymbolTable(['root'], files, entries, 1, SNAPSHOT_VERSION)
    const index = createMutableIndex(base)
    const expectedEntries = new Map(entries.map((e) => [`${e.file}:${e.name}:${e.line}`, e]))
    for (let step = 0; step < 5; step++) {
      const target = `f${Math.floor(random() * 6)}.c`
      if (random() < 0.3) {
        index.removeFile(target)
        for (const key of [...expectedEntries.keys()]) if (key.startsWith(target + ':')) expectedEntries.delete(key)
      } else {
        const next = [entry(names[Math.floor(random() * names.length)]!, target, Math.floor(random() * 5))]
        index.applyFile({ path: target, mtimeMs: step, size: step }, next)
        for (const key of [...expectedEntries.keys()]) if (key.startsWith(target + ':')) expectedEntries.delete(key)
        for (const e of next) expectedEntries.set(`${e.file}:${e.name}:${e.line}`, e)
      }
    }
    const flat = index.flatten()
    assert.equal(flat.entryCount, expectedEntries.size, `round ${round}`)
    assert.deepEqual(flat.files.map((f) => f.path), [...new Set([...expectedEntries.values()].map((e) => e.file))].sort())
  }
})

test('overlay: createMutableIndexFromDeltas replays records', () => {
  const { base } = makeBase()
  const index = createMutableIndexFromDeltas(base, [
    { kind: 'set', path: 'a.c', mtimeMs: 9, size: 9, entries: [entry('omega', 'a.c', 1)] },
    { kind: 'remove', path: 'c.h' },
  ])
  assert.deepEqual(index.findByName('alpha'), [])
  assert.deepEqual(index.findByName('omega').map((e) => e.file), ['a.c'])
  assert.deepEqual(index.findByName('delta'), [])
  assert.equal(index.entryCount, 3)
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npm run compile
```
Expected: FAIL —— 找不到 `../src/core/overlay-index`。

- [ ] **Step 3: 实现 `src/core/overlay-index.ts`**

```ts
import type { FileRecord, SymbolEntry, SymbolTable } from '../shared/types'
import { compareStrings, compareSymbolEntries } from './symbol-order'
import { createSymbolTable } from './symbol-table'
import type { SnapshotDeltaRecord } from './snapshot-delta'

export interface OverlayFileSlot {
  readonly file: FileRecord
  readonly entries: readonly SymbolEntry[]
}

export interface MutableSymbolIndex extends SymbolTable {
  readonly base: SymbolTable
  applyFile(file: FileRecord, entries: readonly SymbolEntry[]): void
  removeFile(file: string): boolean
  readonly pendingChanges: number
  pendingPaths(): string[]
  flatten(): SymbolTable
}

class MutableIndex implements MutableSymbolIndex {
  private readonly changed = new Map<string, OverlayFileSlot | 'removed'>()
  private readonly basePaths: Set<string>
  private readonly baseEntryCounts = new Map<string, number>()
  private overlayEntryCount = 0
  private removedBaseEntryCount = 0
  private filesCache: readonly FileRecord[] | undefined
  private materializedCache: SymbolEntry[] | undefined

  constructor(readonly base: SymbolTable) {
    this.basePaths = new Set(base.files.map((file) => file.path))
  }

  get version(): number { return this.base.version }
  get roots(): readonly string[] { return this.base.roots }
  get builtAt(): number { return this.base.builtAt }
  get entryCount(): number {
    return this.base.entryCount - this.removedBaseEntryCount + this.overlayEntryCount
  }
  get fileCount(): number { return this.files.length }
  get pendingChanges(): number { return this.changed.size }

  get files(): readonly FileRecord[] {
    if (!this.filesCache) {
      const merged: FileRecord[] = []
      for (const file of this.base.files) {
        const slot = this.changed.get(file.path)
        if (slot === 'removed') continue
        merged.push(slot ? slot.file : file)
      }
      for (const [filePath, slot] of this.changed) {
        if (slot === 'removed' || this.basePaths.has(filePath)) continue
        merged.push(slot.file)
      }
      merged.sort((a, b) => compareStrings(a.path, b.path))
      this.filesCache = merged
    }
    return this.filesCache
  }

  private baseCountOf(filePath: string): number {
    const cached = this.baseEntryCounts.get(filePath)
    if (cached !== undefined) return cached
    const count = this.base.entriesInFile(filePath).length
    this.baseEntryCounts.set(filePath, count)
    return count
  }

  private invalidate(): void {
    this.filesCache = undefined
    this.materializedCache = undefined
  }

  applyFile(file: FileRecord, entries: readonly SymbolEntry[]): void {
    const previous = this.changed.get(file.path)
    if (previous === 'removed') {
      // base 条目已经计入 removedBaseEntryCount，这里不再重复减
    } else if (previous) {
      this.overlayEntryCount -= previous.entries.length
    } else {
      this.removedBaseEntryCount += this.baseCountOf(file.path)
    }
    this.changed.set(file.path, { file, entries })
    this.overlayEntryCount += entries.length
    this.invalidate()
  }

  removeFile(file: string): boolean {
    const previous = this.changed.get(file)
    if (previous === 'removed') return false
    if (previous) {
      this.overlayEntryCount -= previous.entries.length
    } else {
      if (!this.basePaths.has(file)) return false
      this.removedBaseEntryCount += this.baseCountOf(file)
    }
    this.changed.set(file, 'removed')
    this.invalidate()
    return true
  }

  entriesInFile(file: string): SymbolEntry[] {
    const slot = this.changed.get(file)
    if (slot === 'removed') return []
    if (slot) return [...slot.entries].sort(compareSymbolEntries)
    return this.base.entriesInFile(file)
  }

  findByName(name: string): SymbolEntry[] {
    const result: SymbolEntry[] = []
    for (const entry of this.base.findByName(name)) {
      if (this.changed.has(entry.file)) continue
      result.push(entry)
    }
    for (const slot of this.changed.values()) {
      if (slot === 'removed') continue
      for (const entry of slot.entries) if (entry.name === name) result.push(entry)
    }
    return result.sort(compareSymbolEntries)
  }

  forEachName(callback: (name: string) => void): void {
    const overlayNames = new Set<string>()
    for (const slot of this.changed.values()) {
      if (slot === 'removed') continue
      for (const entry of slot.entries) overlayNames.add(entry.name)
    }
    const extra = [...overlayNames].sort(compareStrings)
    let extraIndex = 0
    this.base.forEachName((name) => {
      while (extraIndex < extra.length && compareStrings(extra[extraIndex]!, name) < 0) {
        callback(extra[extraIndex++]!)
      }
      if (extra[extraIndex] === name) extraIndex++
      callback(name)
    })
    while (extraIndex < extra.length) callback(extra[extraIndex++]!)
  }

  forEachEntry(callback: (entry: SymbolEntry) => void): void {
    this.base.forEachEntry((entry) => {
      if (!this.changed.has(entry.file)) callback(entry)
    })
    for (const slot of this.changed.values()) {
      if (slot === 'removed') continue
      for (const entry of slot.entries) callback(entry)
    }
  }

  entryAt(index: number): SymbolEntry {
    return this.toArray()[index]!
  }

  toArray(): SymbolEntry[] {
    if (!this.materializedCache) {
      const result: SymbolEntry[] = []
      this.base.forEachEntry((entry) => {
        if (!this.changed.has(entry.file)) result.push(entry)
      })
      for (const slot of this.changed.values()) {
        if (slot === 'removed') continue
        for (const entry of slot.entries) result.push(entry)
      }
      this.materializedCache = result
    }
    return [...this.materializedCache]
  }

  pendingPaths(): string[] {
    return [...this.changed.keys()].sort(compareStrings)
  }

  flatten(): SymbolTable {
    return createSymbolTable(this.roots, this.files, this.toArray(), Date.now(), this.version)
  }
}

export function createMutableIndex(base: SymbolTable): MutableSymbolIndex {
  return new MutableIndex(base)
}

export function createMutableIndexFromDeltas(
  base: SymbolTable,
  records: readonly SnapshotDeltaRecord[],
): MutableSymbolIndex {
  const index = new MutableIndex(base)
  for (const record of records) {
    if (record.kind === 'remove') {
      index.removeFile(record.path)
    } else {
      index.applyFile({ path: record.path, mtimeMs: record.mtimeMs, size: record.size }, record.entries)
    }
  }
  return index
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npm run compile
node --test dist/test/overlay-index.test.js
```
Expected: 6 PASS（含属性测试）。

- [ ] **Step 5: 全量测试**

```bash
npm test
```
Expected: 169 PASS 0 FAIL。

- [ ] **Step 6: Commit**

```bash
git add src/core/overlay-index.ts test/overlay-index.test.ts
git commit -m "feat: mutable overlay symbol index (O(delta) single-file updates)"
```

---

### Task 4: Service 集成（base + delta 加载、overlay 保存、compaction 调度）

**Files:**
- Modify: `src/vscode/service.ts`（字段、`loadFromDisk`、`commitSnapshot`、`scheduleSave`→`scheduleCompaction`、`persistNow`→`compactNow`、`flush`、`clearCache`、`build` 成功分支、`removeSnapshotFile`）
- Test: `test/index-e2e.test.ts`（新增；不依赖 vscode，直接验证 core 组合路径）

**Interfaces:**
- Consumes: Task 1-3 的 `SymbolTable` v2、`MutableSymbolIndex`、`snapshot-delta` API
- Produces: `SymbolService` 行为变化（对外 API 不变）：`snapshotValue: SymbolTable` 实际是 `MutableSymbolIndex`；新增私有 `mutableValue?: MutableSymbolIndex`、`compactTimer`；`commitSnapshot` 走 overlay + `appendSnapshotDelta`

- [ ] **Step 1: 写失败的端到端测试（core 组合，证明 base+overlay+delta 等价于全量重建）**

```ts
// test/index-e2e.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMutableIndex } from '../src/core/overlay-index'
import {
  appendSnapshotDelta,
  compactSnapshot,
  readSnapshotDeltas,
  snapshotDeltaPath,
} from '../src/core/snapshot-delta'
import { createSymbolTable } from '../src/core/symbol-table'
import { loadSnapshot } from '../src/core/store'
import { SNAPSHOT_VERSION } from '../src/shared/types'
import type { SymbolEntry } from '../src/shared/types'

function entry(name: string, file: string, line: number): SymbolEntry {
  return { name, kind: 'function', file, line, endLine: line + 1, column: 2 }
}

test('index e2e: save -> delta -> reload -> compaction keeps the same symbol set', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'si-index-e2e-'))
  try {
    const basePath = join(dir, 'symbols.sidx')
    const base = createSymbolTable(
      ['root'],
      [{ path: 'a.c', mtimeMs: 1, size: 1 }],
      [entry('alpha', 'a.c', 1)],
      1,
      SNAPSHOT_VERSION,
    )
    await compactSnapshot(basePath, base) // 写 base

    const index = createMutableIndex((await loadSnapshot(basePath))!)
    index.applyFile({ path: 'b.c', mtimeMs: 2, size: 2 }, [entry('beta', 'b.c', 3)])
    index.applyFile({ path: 'a.c', mtimeMs: 2, size: 2 }, [entry('alpha', 'a.c', 2), entry('gamma', 'a.c', 5)])
    await appendSnapshotDelta(snapshotDeltaPath(basePath), {
      kind: 'set', path: 'b.c', mtimeMs: 2, size: 2, entries: [entry('beta', 'b.c', 3)],
    })
    await appendSnapshotDelta(snapshotDeltaPath(basePath), {
      kind: 'set', path: 'a.c', mtimeMs: 2, size: 2, entries: [entry('alpha', 'a.c', 2), entry('gamma', 'a.c', 5)],
    })

    // 模拟重载：base + delta
    const reloadedBase = (await loadSnapshot(basePath))!
    const records = await readSnapshotDeltas(snapshotDeltaPath(basePath))
    const reloaded = createMutableIndexFromDeltas(reloadedBase, records)
    assert.equal(reloaded.entryCount, 3)
    assert.deepEqual(reloaded.findByName('gamma').map((e) => e.file), ['a.c'])

    // compaction 后直接读 base 即可得到同样结果
    await compactSnapshot(basePath, reloaded.flatten())
    const compacted = (await loadSnapshot(basePath))!
    assert.equal(compacted.entryCount, 3)
    assert.deepEqual(compacted.findByName('gamma').map((e) => e.line), [5])
    assert.deepEqual(await readSnapshotDeltas(snapshotDeltaPath(basePath)), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
```

> 注意 import `createMutableIndexFromDeltas` 与 `snapshotDeltaPath`；若 TS 顺序告警按 ESLint/tsc 提示调整。

- [ ] **Step 2: 运行确认失败**

```bash
npm run compile
node --test dist/test/index-e2e.test.js
```
Expected: 该测试是 core 组合的契约回归测试（T3 完成后即可通过）；若通过，记录通过结果并继续 Step 3，service 改造的正确性由 Step 7 的 smoke + 手动验证覆盖。不要为了让测试失败而修改生产代码。

- [ ] **Step 3: 改造 service 字段与加载路径**

在 `src/vscode/service.ts` 顶部 import 增加：

```ts
import {
  appendSnapshotDelta,
  compactSnapshot,
  readSnapshotDeltas,
  removeSnapshotDelta,
  snapshotDeltaBytes,
  snapshotDeltaPath,
} from '../core/snapshot-delta'
import { createMutableIndex, createMutableIndexFromDeltas, type MutableSymbolIndex } from '../core/overlay-index'
```

删除 `import { removeFileFromTable, upsertFileInTable } from '../core/symbol-table'`（不再使用）。

字段区新增（`snapshotValue` 附近）：

```ts
  private mutableValue: MutableSymbolIndex | undefined
  private compactTimer: ReturnType<typeof setTimeout> | undefined
```

`loadFromDisk()` 中，`this.snapshotValue = snapshot` 改为：

```ts
      const records = await readSnapshotDeltas(snapshotDeltaPath(snapshotPath))
      this.mutableValue = createMutableIndexFromDeltas(snapshot, records)
      this.snapshotValue = this.mutableValue
```

并更新日志：`entries=${snapshot.entryCount}` 与 `delta=${records.length} records`（可加在 `snapshot loaded:` 行）。

- [ ] **Step 4: 改造 `commitSnapshot`（overlay + delta）**

```ts
  private commitSnapshot(
    relPath: string,
    entries: readonly SymbolEntry[],
    mtimeMs: number,
    size: number,
    remove = false,
  ): void {
    const index = this.mutableValue
    if (!index) {
      this.snapshotValue = undefined
      return
    }
    if (remove) {
      if (!index.removeFile(relPath)) return
    } else {
      index.applyFile({ path: relPath, mtimeMs, size }, entries)
    }
    this.snapshotValue = index
    this.lastSummaryValue = undefined
    this.changeEmitter.fire()
    void this.appendDelta(relPath, entries, mtimeMs, size, remove)
    void this.scheduleCompaction()
  }

  private async appendDelta(
    relPath: string,
    entries: readonly SymbolEntry[],
    mtimeMs: number,
    size: number,
    remove: boolean,
  ): Promise<void> {
    const snapshotPath = this.snapshotPathValue
    if (!snapshotPath) return
    try {
      await appendSnapshotDelta(
        snapshotDeltaPath(snapshotPath),
        remove
          ? { kind: 'remove', path: relPath }
          : { kind: 'set', path: relPath, mtimeMs, size, entries },
      )
    } catch (error) {
      this.logger.warn('append snapshot delta failed', error)
    }
  }
```

- [ ] **Step 5: 用 compaction 替换全量保存**

删除 `private scheduleSave()`、`private async saveNow()`、`private async persistNow()` 三个方法；新增：

```ts
  /** 阈值/空闲触发 compaction（写 base + 清 delta），不再每次保存全量写盘。 */
  private async scheduleCompaction(): Promise<void> {
    const snapshotPath = this.snapshotPathValue
    if (!snapshotPath || this.disposed) return
    try {
      const index = this.mutableValue
      if (!index) return
      const deltaBytes = await snapshotDeltaBytes(snapshotDeltaPath(snapshotPath))
      const shouldCompact =
        deltaBytes >= SNAPSHOT_COMPACT_BYTES || index.pendingChanges >= SNAPSHOT_COMPACT_CHANGES
      if (!shouldCompact) {
        this.armIdleCompaction()
        return
      }
      await this.compactNow()
    } catch (error) {
      this.logger.warn('snapshot compaction scheduling failed', error)
    }
  }

  private armIdleCompaction(): void {
    if (this.compactTimer) clearTimeout(this.compactTimer)
    if (!this.snapshotPathValue) return
    this.compactTimer = setTimeout(() => {
      this.compactTimer = undefined
      void this.compactNow()
    }, SNAPSHOT_IDLE_COMPACT_MS)
    try {
      this.compactTimer.unref?.()
    } catch {
      // ignore
    }
  }

  /** 实际 compaction：flatten + 原子写 base + 清空 delta 与 overlay。 */
  private async compactNow(): Promise<void> {
    const snapshotPath = this.snapshotPathValue
    const index = this.mutableValue
    if (!snapshotPath || !index) return
    if (index.pendingChanges === 0 && (await snapshotDeltaBytes(snapshotDeltaPath(snapshotPath))) === 0) {
      return
    }
    try {
      await this.ensureStorageDir()
      const flat = index.flatten()
      const started = Date.now()
      const { baseBytes, deltaTruncated } = await compactSnapshot(snapshotPath, flat)
      this.mutableValue = createMutableIndex(flat)
      this.snapshotValue = this.mutableValue
      this.logger.info(
        `snapshot compacted: ${baseBytes} bytes in ${Date.now() - started}ms` +
          (deltaTruncated ? ' (delta cleared)' : ''),
      )
    } catch (error) {
      this.logger.warn('snapshot compaction failed', error)
    }
  }
```

常量（`NAME_INDEX_COMPACT_BYTES` 附近）：

```ts
/** 符号表 delta 超过 4MB 或累计 500 个文件变更时 compaction */
const SNAPSHOT_COMPACT_BYTES = 4 * 1024 * 1024
const SNAPSHOT_COMPACT_CHANGES = 500
/** 空闲 60s 后 compaction（unref，不阻止退出） */
const SNAPSHOT_IDLE_COMPACT_MS = 60_000
```

- [ ] **Step 6: 更新 `flush`、`clearCache`、构建成功分支、`removeSnapshotFile`**

`flush()` 改为：

```ts
  async flush(): Promise<void> {
    if (this.compactTimer) {
      clearTimeout(this.compactTimer)
      this.compactTimer = undefined
    }
    await this.compactNow()
    await this.compactNameIndexIfNeeded(true)
  }
```

`clearCache()` 中 `await this.removeSnapshotFile()` 前加上：

```ts
    this.mutableValue = undefined
    if (this.compactTimer) {
      clearTimeout(this.compactTimer)
      this.compactTimer = undefined
    }
```

`removeSnapshotFile()` 同时删除 delta：

```ts
  private async removeSnapshotFile(): Promise<void> {
    const snapshotPath = this.snapshotPathValue
    if (!snapshotPath) return
    for (const target of [snapshotPath, snapshotDeltaPath(snapshotPath)]) {
      try {
        await fs.promises.unlink(target)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code
        if (code !== 'ENOENT') this.logger.warn(`cannot remove index file ${target}`, error)
      }
    }
    this.snapshotValue = undefined
    this.mutableValue = undefined
  }
```

构建成功分支（0.4.0 起有 `removeNameIndexDelta` 的段落）改为：

```ts
          this.mutableValue = createMutableIndex(result.snapshot)
          this.snapshotValue = this.mutableValue
          if (this.snapshotPathValue) {
            await removeSnapshotDelta(snapshotDeltaPath(this.snapshotPathValue))
          }
```

同时删除旧的 `this.snapshotValue = ...` 与 `result.summary.snapshotBytes === 0` 兜底写盘逻辑（构建已写 base）。

- [ ] **Step 7: 编译 + 全量测试 + 冒烟**

```bash
npm test
npm run smoke
node --test dist/test/index-e2e.test.js
```
Expected: 170 PASS 0 FAIL；smoke `SMOKE OK`；e2e PASS。

- [ ] **Step 8: Commit**

```bash
git add src/vscode/service.ts test/index-e2e.test.ts
git commit -m "feat: service uses overlay + snapshot delta with compaction (no full rewrite per save)"
```

---

### Task 5: C1 —— 索引规模预算与内存保护

**Files:**
- Create: `src/core/index-budget.ts`
- Modify: `src/shared/types.ts`（`BuildOptions.concurrencyCap?`）、`src/core/indexer.ts`（应用 cap）、`src/vscode/service.ts`（build 时传 cap + 预算警告）、`src/vscode/status.ts`（预算替代 `MAX_SYMBOLS_WARNING`）、`package.json`/`package.nls.json`/`package.nls.zh-cn.json`（配置项）
- Test: `test/index-budget.test.ts`

**Interfaces:**
- Consumes: `BuildSummary`
- Produces:
  - `interface IndexBudget { maxSymbols; maxFiles; hardMaxSymbols }`
  - `const DEFAULT_INDEX_BUDGET: IndexBudget`
  - `interface BudgetReport { level: 'ok'|'warn'|'exceeded'; symbols; files; message?; suggestions }`
  - `evaluateBudget(input: { symbols: number; files: number; budget: IndexBudget }): BudgetReport`
  - 配置键：`sourceInsight.maxSymbols`（2000000）、`sourceInsight.maxFiles`（120000）、`sourceInsight.autoCompact`（true）

- [ ] **Step 1: 写失败的测试**

```ts
// test/index-budget.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_INDEX_BUDGET, evaluateBudget } from '../src/core/index-budget'

test('budget: ok below thresholds', () => {
  const report = evaluateBudget({ symbols: 100, files: 10, budget: DEFAULT_INDEX_BUDGET })
  assert.equal(report.level, 'ok')
  assert.deepEqual(report.suggestions, [])
})

test('budget: warn between max and hard max', () => {
  const report = evaluateBudget({ symbols: DEFAULT_INDEX_BUDGET.maxSymbols + 1, files: 10, budget: DEFAULT_INDEX_BUDGET })
  assert.equal(report.level, 'warn')
  assert.ok(report.message?.includes('2,000,000'))
  assert.ok(report.suggestions.length > 0)
})

test('budget: exceeded above hard max', () => {
  const report = evaluateBudget({ symbols: DEFAULT_INDEX_BUDGET.hardMaxSymbols + 1, files: 10, budget: DEFAULT_INDEX_BUDGET })
  assert.equal(report.level, 'exceeded')
  assert.ok(report.suggestions.some((s) => s.includes('indexRoots')))
})

test('budget: files threshold also triggers warn', () => {
  const report = evaluateBudget({ symbols: 1, files: DEFAULT_INDEX_BUDGET.maxFiles + 1, budget: DEFAULT_INDEX_BUDGET })
  assert.equal(report.level, 'warn')
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npm run compile
node --test dist/test/index-budget.test.js
```
Expected: FAIL —— 找不到模块。

- [ ] **Step 3: 实现 `src/core/index-budget.ts`**

```ts
/** 索引规模预算：超过阈值要显式提示，避免静默吃内存。 */

export interface IndexBudget {
  readonly maxSymbols: number
  readonly maxFiles: number
  readonly hardMaxSymbols: number
}

export const DEFAULT_INDEX_BUDGET: IndexBudget = {
  maxSymbols: 2_000_000,
  maxFiles: 120_000,
  hardMaxSymbols: 5_000_000,
}

export type BudgetLevel = 'ok' | 'warn' | 'exceeded'

export interface BudgetReport {
  readonly level: BudgetLevel
  readonly symbols: number
  readonly files: number
  readonly message?: string
  readonly suggestions: readonly string[]
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US')
}

export function evaluateBudget(input: {
  readonly symbols: number
  readonly files: number
  readonly budget: IndexBudget
}): BudgetReport {
  const { symbols, files, budget } = input
  const base = { symbols, files }
  const suggestions: string[] = [
    'Narrow sourceInsight.indexRoots to the modules you actually work on.',
    'Exclude duplicated kernel/vendor copies via sourceInsight.exclude (e.g. **/linux-*/**).',
  ]
  if (symbols > budget.hardMaxSymbols) {
    return {
      ...base,
      level: 'exceeded',
      message: `Index has ${formatNumber(symbols)} symbols (hard maximum ${formatNumber(budget.hardMaxSymbols)}).`,
      suggestions,
    }
  }
  if (symbols > budget.maxSymbols || files > budget.maxFiles) {
    const reason =
      symbols > budget.maxSymbols
        ? `${formatNumber(symbols)} symbols (budget ${formatNumber(budget.maxSymbols)})`
        : `${formatNumber(files)} files (budget ${formatNumber(budget.maxFiles)})`
    return { ...base, level: 'warn', message: `Index is large: ${reason}.`, suggestions }
  }
  return { ...base, level: 'ok', suggestions: [] }
}
```

- [ ] **Step 4: 接入配置、状态栏、并发降级**

`package.json` `contributes.configuration.properties` 增加（保持英文 key，默认值如下）：

```json
"sourceInsight.maxSymbols": {
  "type": "number",
  "default": 2000000,
  "description": "%config.maxSymbols.description%"
},
"sourceInsight.maxFiles": {
  "type": "number",
  "default": 120000,
  "description": "%config.maxFiles.description%"
},
"sourceInsight.autoCompact": {
  "type": "boolean",
  "default": true,
  "description": "%config.autoCompact.description%"
}
```

`package.nls.json` / `package.nls.zh-cn.json` 增加三条 `config.maxSymbols.description` 等文案（中文："符号数超过该值时提示缩小索引目录"）。

`src/shared/types.ts` 的 `BuildOptions` 增加：

```ts
  /** 构建并发上限（大工程自动降级用） */
  readonly concurrencyCap?: number
```

`src/core/indexer.ts` 中 `const concurrency = normalizeConcurrency(options.concurrency)` 改为：

```ts
  const cap = options.concurrencyCap ?? Number.POSITIVE_INFINITY
  const concurrency = normalizeConcurrency(Math.min(options.concurrency, cap))
```

`src/vscode/service.ts` 构建调用处（`buildIndex({...})`）增加：

```ts
            concurrencyCap:
              this.lastSummaryValue && this.lastSummaryValue.files > 80_000 ? 2 : undefined,
```

构建完成后（写 summary 后）评估预算：

```ts
          const report = evaluateBudget({
            symbols: result.summary.entries,
            files: result.summary.files,
            budget: {
              maxSymbols: this.configValue('maxSymbols', DEFAULT_INDEX_BUDGET.maxSymbols),
              maxFiles: this.configValue('maxFiles', DEFAULT_INDEX_BUDGET.maxFiles),
              hardMaxSymbols: DEFAULT_INDEX_BUDGET.hardMaxSymbols,
            },
          })
          this.budgetReportValue = report
          if (report.level !== 'ok') {
            this.logger.warn(`index budget ${report.level}: ${report.message ?? ''}`)
          }
```

新增字段 `private budgetReportValue: BudgetReport | undefined` 与 getter `get budgetReport(): BudgetReport | undefined`。

`src/vscode/status.ts` 用 `service.budgetReport` 替代直接比较 `MAX_SYMBOLS_WARNING`：

- `const tooManySymbols = symbols > MAX_SYMBOLS_WARNING` → `const tooManySymbols = report?.level === 'exceeded'`
- tooltip 追加 `report?.message` 与建议首条。

- [ ] **Step 5: 测试 + 冒烟**

```bash
npm test
npm run smoke
```
Expected: 174 PASS 0 FAIL；smoke OK（状态栏 mock 需能读取 `budgetReport` getter，smoke 已 mock service；若 smoke 报错，按现有 mock 模式补 `budgetReport: undefined`）。

- [ ] **Step 6: Commit**

```bash
git add src/core/index-budget.ts src/shared/types.ts src/core/indexer.ts src/vscode/service.ts src/vscode/status.ts package.json package.nls.json package.nls.zh-cn.json test/index-budget.test.ts
git commit -m "feat: index size budget + concurrency downgrade + status warning"
```

---

### Task 6: C2 —— 索引诊断命令

**Files:**
- Create: `src/core/diagnostics.ts`
- Modify: `src/vscode/service.ts`（诊断 getters）、`src/vscode/commands.ts`、`package.json`/`package.nls*.json`、`l10n/bundle.l10n.zh-cn.json`
- Test: `test/diagnostics.test.ts`

**Interfaces:**
- Consumes: `SymbolTable`、`BuildSummary`、`BudgetReport`
- Produces:
  - `interface DiagnosticsInput { extensionVersion; workspaceRoot?; roots; snapshotPath?; snapshotBytes; deltaBytes; nameIndexPath?; nameIndexBytes; nameIndexLoaded; entryCount; fileCount; builtAt?; pendingChanges; lastBuild?; lastError?; kindCounts; heapUsedBytes; rssBytes; budget }`
  - `renderDiagnosticsMarkdown(input): string`
- Service getters（新增）：
  ```ts
  get snapshotPath(): string | undefined
  get nameIndexPath(): string | undefined
  get nameIndexLoaded(): boolean
  get pendingChanges(): number
  get builtAt(): number | undefined
  get lastSummary(): BuildSummary | undefined
  get lastError(): string | undefined
  async deltaBytes(): Promise<number>
  kindCounts(): Record<SymbolKind, number>
  ```

- [ ] **Step 1: 写失败的测试**

```ts
// test/diagnostics.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'

import { renderDiagnosticsMarkdown } from '../src/core/diagnostics'
import type { DiagnosticsInput } from '../src/core/diagnostics'

const input: DiagnosticsInput = {
  extensionVersion: '0.7.0',
  workspaceRoot: '/work',
  roots: ['component', 'datapath'],
  snapshotPath: '/storage/symbols.sidx',
  snapshotBytes: 5_000_000,
  deltaBytes: 4_096,
  nameIndexPath: '/storage/symbols.names',
  nameIndexBytes: 3_000_000,
  nameIndexLoaded: false,
  entryCount: 118_730,
  fileCount: 6_838,
  builtAt: 1_700_000_000_000,
  pendingChanges: 3,
  lastBuild: undefined,
  lastError: undefined,
  kindCounts: { function: 10, declaration: 20, macro: 1, struct: 2, union: 0, enum: 1, typedef: 3 },
  heapUsedBytes: 200 * 1024 * 1024,
  rssBytes: 400 * 1024 * 1024,
  budget: { level: 'ok', symbols: 118_730, files: 6_838, suggestions: [] },
}

test('diagnostics: markdown contains key fields', () => {
  const md = renderDiagnosticsMarkdown(input)
  assert.match(md, /Code Insight index diagnostics/)
  assert.match(md, /118,730/)
  assert.match(md, /6,838/)
  assert.match(md, /symbols\.sidx/)
  assert.match(md, /budget: ok/)
  assert.match(md, /function/)
})

test('diagnostics: missing optional fields render as n\/a', () => {
  const md = renderDiagnosticsMarkdown({
    ...input,
    workspaceRoot: undefined,
    snapshotPath: undefined,
    nameIndexPath: undefined,
    builtAt: undefined,
    lastBuild: undefined,
    lastError: undefined,
  })
  assert.match(md, /workspace: n\/a/)
  assert.match(md, /snapshot: n\/a/)
})

test('diagnostics: includes last error and build summary when present', () => {
  const md = renderDiagnosticsMarkdown({
    ...input,
    lastError: 'snapshot load failed',
    lastBuild: {
      files: 6_838, entries: 118_730, added: 1, updated: 2, removed: 0, unchanged: 6_835, skipped: 3,
      durationMs: 6_100, snapshotBytes: 5_000_000, nameIndexBytes: 3_000_000,
    },
  })
  assert.match(md, /snapshot load failed/)
  assert.match(md, /6,100/)
})
```

- [ ] **Step 2: 运行确认失败**

```bash
npm run compile
node --test dist/test/diagnostics.test.js
```
Expected: FAIL —— 找不到模块。

- [ ] **Step 3: 实现 `src/core/diagnostics.ts`**

```ts
import type { BuildSummary, SymbolKind } from '../shared/types'
import type { BudgetReport } from './index-budget'

export interface DiagnosticsInput {
  readonly extensionVersion: string
  readonly workspaceRoot: string | undefined
  readonly roots: readonly string[]
  readonly snapshotPath: string | undefined
  readonly snapshotBytes: number
  readonly deltaBytes: number
  readonly nameIndexPath: string | undefined
  readonly nameIndexBytes: number
  readonly nameIndexLoaded: boolean
  readonly entryCount: number
  readonly fileCount: number
  readonly builtAt: number | undefined
  readonly pendingChanges: number
  readonly kindCounts: Readonly<Record<SymbolKind, number>>
  readonly lastBuild: BuildSummary | undefined
  readonly lastError: string | undefined
  readonly heapUsedBytes: number
  readonly rssBytes: number
  readonly budget: BudgetReport
}

const MB = 1024 * 1024

function number(value: number): string {
  return value.toLocaleString('en-US')
}

function bytes(value: number): string {
  if (value >= MB) return `${(value / MB).toFixed(2)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${value} B`
}

function n(value: string | undefined): string {
  return value ?? 'n/a'
}

export function renderDiagnosticsMarkdown(input: DiagnosticsInput): string {
  const lines: string[] = []
  lines.push('# Code Insight index diagnostics')
  lines.push('')
  lines.push(`- extension: ${input.extensionVersion}`)
  lines.push(`- workspace: ${n(input.workspaceRoot)}`)
  lines.push(`- roots: ${input.roots.length ? input.roots.join(', ') : 'n/a'}`)
  lines.push(`- budget: ${input.budget.level}${input.budget.message ? ` — ${input.budget.message}` : ''}`)
  lines.push('')
  lines.push('## Index')
  lines.push('')
  lines.push(`- symbols: ${number(input.entryCount)}`)
  lines.push(`- files: ${number(input.fileCount)}`)
  lines.push(`- builtAt: ${input.builtAt ? new Date(input.builtAt).toISOString() : 'n/a'}`)
  lines.push(`- pending changes (overlay): ${number(input.pendingChanges)}`)
  lines.push(`- kinds: ${Object.entries(input.kindCounts).map(([kind, count]) => `${kind}=${number(count)}`).join(', ')}`)
  lines.push('')
  lines.push('## Storage')
  lines.push('')
  lines.push(`- snapshot: ${n(input.snapshotPath)} (${bytes(input.snapshotBytes)})`)
  lines.push(`- snapshot delta: ${bytes(input.deltaBytes)}`)
  lines.push(`- reference index: ${n(input.nameIndexPath)} (${bytes(input.nameIndexBytes)}, ${input.nameIndexLoaded ? 'loaded' : 'lazy'})`)
  lines.push('')
  lines.push('## Last build')
  lines.push('')
  if (input.lastBuild) {
    const b = input.lastBuild
    lines.push(`- duration: ${number(b.durationMs)} ms`)
    lines.push(`- files/entries: ${number(b.files)} / ${number(b.entries)}`)
    lines.push(`- added/updated/removed/unchanged/skipped: ${b.added}/${b.updated}/${b.removed}/${b.unchanged}/${b.skipped}`)
  } else {
    lines.push('- n/a')
  }
  lines.push('')
  lines.push('## Process')
  lines.push('')
  lines.push(`- heap used: ${bytes(input.heapUsedBytes)}`)
  lines.push(`- RSS: ${bytes(input.rssBytes)}`)
  if (input.lastError) {
    lines.push('')
    lines.push('## Last error')
    lines.push('')
    lines.push('```')
    lines.push(input.lastError)
    lines.push('```')
  }
  if (input.budget.suggestions.length > 0) {
    lines.push('')
    lines.push('## Suggestions')
    lines.push('')
    for (const suggestion of input.budget.suggestions) lines.push(`- ${suggestion}`)
  }
  lines.push('')
  return lines.join('\n')
}
```

- [ ] **Step 4: service getters + 命令注册**

`src/vscode/service.ts` 新增 getters（位置：`get fileCount()` 附近）：

```ts
  get snapshotPath(): string | undefined { return this.snapshotPathValue }
  get nameIndexPath(): string | undefined { return this.nameIndexPathValue }
  get nameIndexLoaded(): boolean { return this.nameIndexLoadedValue }
  get pendingChanges(): number { return this.mutableValue?.pendingChanges ?? 0 }
  get lastSummaryPublic(): BuildSummary | undefined { return this.lastSummaryValue }
  get lastErrorPublic(): string | undefined { return this.lastErrorValue }
  async deltaBytes(): Promise<number> {
    return this.snapshotPathValue ? snapshotDeltaBytes(snapshotDeltaPath(this.snapshotPathValue)) : 0
  }
  kindCounts(): Record<SymbolKind, number> {
    const counts: Record<SymbolKind, number> = {
      function: 0, declaration: 0, macro: 0, struct: 0, union: 0, enum: 0, typedef: 0,
    }
    this.snapshotValue?.forEachEntry((entry) => { counts[entry.kind] += 1 })
    return counts
  }
```

> 若 `nameIndexLoaded` 字段名不同（当前是 `private nameIndexLoaded = false`），getter 用 `this.nameIndexLoaded` 会与 getter 同名冲突 —— 实现时把字段改名为 `nameIndexLoadedValue`，并同步 4 处引用。

`src/vscode/commands.ts` 注册新命令：

```ts
  add('si.showIndexDiagnostics', async () => {
    await showIndexDiagnostics(service)
  })
```

并在 `commands.ts` 内实现：

```ts
import { renderDiagnosticsMarkdown } from '../core/diagnostics'
import { evaluateBudget, DEFAULT_INDEX_BUDGET } from '../core/index-budget'

async function showIndexDiagnostics(service: SymbolService): Promise<void> {
  const budgetReport =
    service.budgetReport ??
    evaluateBudget({ symbols: service.entryCount, files: service.fileCount, budget: DEFAULT_INDEX_BUDGET })
  const content = renderDiagnosticsMarkdown({
    extensionVersion: extensionVersion(),
    workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    roots: service.configRoots(),
    snapshotPath: service.snapshotPath,
    snapshotBytes: service.lastSummaryPublic?.snapshotBytes ?? 0,
    deltaBytes: await service.deltaBytes(),
    nameIndexPath: service.nameIndexPath,
    nameIndexBytes: service.lastSummaryPublic?.nameIndexBytes ?? 0,
    nameIndexLoaded: service.nameIndexLoaded,
    entryCount: service.entryCount,
    fileCount: service.fileCount,
    builtAt: service.builtAt,
    pendingChanges: service.pendingChanges,
    kindCounts: service.kindCounts(),
    lastBuild: service.lastSummaryPublic,
    lastError: service.lastErrorPublic,
    heapUsedBytes: process.memoryUsage().heapUsed,
    rssBytes: process.memoryUsage().rss,
    budget: budgetReport,
  })
  const document = await vscode.workspace.openTextDocument({ content, language: 'markdown' })
  await vscode.window.showTextDocument(document, { preview: false })
}
```

> `extensionVersion()` 用 `vscode.extensions.getExtension('cinsight.code-insight')?.packageJSON.version ?? 'unknown'`；`service.configRoots()` 若不存在，用 `vscode.workspace.getConfiguration('sourceInsight').get<string[]>('indexRoots') ?? []`。

`package.json` 命令数组加：

```json
{ "command": "si.showIndexDiagnostics", "title": "%command.showIndexDiagnostics.title%", "category": "%command.category%" }
```

nls：`"command.showIndexDiagnostics.title": "Show Index Diagnostics"` / `"索引诊断"`。

- [ ] **Step 5: 测试 + 冒烟**

```bash
npm test
npm run smoke
node --test dist/test/diagnostics.test.js
```
Expected: 177 PASS 0 FAIL；smoke OK（命令数 11）。

- [ ] **Step 6: Commit**

```bash
git add src/core/diagnostics.ts src/vscode/service.ts src/vscode/commands.ts package.json package.nls.json package.nls.zh-cn.json test/diagnostics.test.ts l10n/bundle.l10n.zh-cn.json
git commit -m "feat: index diagnostics command (markdown report)"
```

---

### Task 7: 性能验证、文档、本地安装（不发布）

**Files:**
- Modify: `scripts/perf-build.js`（报告 delta/overlay 指标）、`README.md`、`CHANGELOG.md`、`package.json`（版本）
- No new tests（复用现有 + 手动验证）

**Interfaces:**
- Consumes: Task 1-6 全部
- Produces: 本地 `code-insight-0.7.0.vsix` + 安装到用户 Cursor；**不推送 tag/不发布**

- [ ] **Step 1: 扩展 perf 脚本指标**

在构建段之后追加测量（伪代码，实现时按现有风格写入）：

```js
// 单文件增量：overlay apply（不重建列）
const index = createMutableIndex(loaded)
const tApply = performance.now()
index.applyFile({ path: rel, mtimeMs: Date.now(), size: 1 }, loaded.entriesInFile(rel))
console.log('  overlay apply:', ms(tApply), 'ms; pending:', index.pendingChanges)
// delta 追加
const tDelta = performance.now()
const bytes = await appendSnapshotDelta(snapshotDeltaPath(snapshotPath), { kind: 'set', path: rel, mtimeMs: Date.now(), size: 1, entries: loaded.entriesInFile(rel) })
console.log('  snapshot delta:', bytes, 'B in', ms(tDelta), 'ms')
// compaction
const tCompact = performance.now()
const flat = index.flatten()
const res = await compactSnapshot(snapshotPath, flat)
console.log('  compaction:', ms(tCompact), 'ms;', mb(res.baseBytes))
```

- [ ] **Step 2: 真实仓库两档压测**

```bash
node scripts/perf-build.js rcios/plugin rcios/plat --query=_aaa_admin_user_name_check
```
Expected（记录进 CHANGELOG）：
- overlay apply < 5 ms
- snapshot delta 写入 < 10 KB / < 10 ms
- 搜索/引用相对 0.6.x 不劣化 >10%

- [ ] **Step 3: 更新 CHANGELOG / README（0.7.0）**

CHANGELOG 0.7.0（中英双语）：
- 增量索引：保存文件只追加 KB 级 delta；内存 overlay，单文件更新 O(Δ)
- 启动时 base + delta 重放；阈值/空闲/关闭自动 compaction
- 索引规模预算：`maxSymbols`/`maxFiles` 警告、构建并发自动降级
- 新命令 `Code Insight: 索引诊断`
- 兼容：快照 base 仍为 v3；升级后无需重建（旧 delta 会重放）

README：性能表更新（保存写入、overlay 更新耗时）、配置表新增三键、命令表新增诊断命令。

- [ ] **Step 4: 版本升级 + 本地打包（不发布）**

```bash
bash scripts/release.sh 0.7.0
```
Expected：`单元测试` 全绿、`激活冒烟` OK、产物 `code-insight-0.7.0.vsix`。

- [ ] **Step 5: 安装到本地 Cursor**

```bash
cursor --install-extension code-insight-0.7.0.vsix --force
python3 -c "
import json,os
for e in json.load(open(os.path.expanduser('~/.cursor/extensions/extensions.json'))):
    if 'code-insight' in str((e.get('identifier') or {}).get('id','')): print(e.get('version'))
"
```
Expected：`0.7.0`。

- [ ] **Step 6: 提交（不推 tag）**

```bash
git add -A
git commit -m "feat: incremental symbol index (overlay + delta), size budget, diagnostics (0.7.0)"
git log --oneline | head -3
```
**禁止** `git push origin master --tags`、`publish:*`、workflow_dispatch。

---

## Self-Review

| 设计需求 | 任务 |
|---|---|
| A1 delta 持久化 / compaction / 阈值 | Task 2 + Task 4（Step 4-6） |
| A4 overlay O(Δ) 查询合并 / flatten | Task 3 + Task 4 |
| 接口契约（SymbolTable v2、delta、overlay、budget、diagnostics） | Task 1/2/3/5/6 的 Interfaces 段 |
| C1 预算/并发降级/状态栏 | Task 5 |
| C2 诊断命令 | Task 6 |
| 兼容（base v3 不变、旧扩展忽略 delta） | Task 2（文件名旁路）+ Task 4（加载时 delta 不存在即空） |
| 测试（单元 + 属性 + e2e） | 每个任务 Step 1-4；总计 +17 测试（160→177） |
| 性能验收（apply<5ms、delta<10KB、compaction<3s） | Task 7 Step 2 |
| 发布策略（只本地、不发布） | Global Constraints + Task 7 Step 6 |

潜在风险提示：
- Task 4 中 `nameIndexLoaded` 字段/getter 同名冲突，需按 Step 4 注释改名。
- Task 4 删除 `persistNow/saveNow/scheduleSave` 时，注意 `build()` 成功分支里的 `pendingSave` 引用一并清理。
- Task 6 的 `showIndexDiagnostics` 中 `snapshotBytes` 取值逻辑简化：直接用 `lastSummaryPublic?.snapshotBytes ?? 0`，实现时以该简化版为准（上面的三元写法只是为了防御，可简化）。
