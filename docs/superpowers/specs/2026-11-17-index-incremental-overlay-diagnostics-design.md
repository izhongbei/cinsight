# 增量索引（Overlay + Delta）、规模预算与诊断 —— 设计文档

日期：2026-11-17
状态：待用户确认（确认前不实现、不发布）
关联版本：0.7.0
前置：0.6.1（列式 TypedArray 符号表 v3、引用索引 delta、单遍构建）

## 1. 背景与问题（基于实测）

| 指标 | 现状（实测） | 问题 |
|---|---|---|
| 单文件保存触发的符号表重建 `upsertFileInTable` | 119k 符号 **50 ms**；按线性外推 149 万符号 **≈600 ms** | 每次保存都 O(n) 重建所有列 + 重建每文件桶 |
| 快照落盘 `saveSnapshot` | 5.13 MB / **113 ms**（119k 符号）；149 万符号约 **62 MB / ≈1.4 s** | 每次保存（防抖 3s）重写整个快照 |
| 引用索引维护 | 已优化为 **743 B / 1 ms**（delta 追加） | 符号表仍在拖后腿 |
| 大工程构建内存/时间 | 68k 文件 / 149 万符号，构建分钟级；解析峰值约 220 MB 对象 | 无预算提示、无诊断手段 |
| 用户自诊断能力 | 只能看状态栏符号数 | OOM/慢时无法定位（索引多大、跳过多少文件、各阶段耗时） |

目标（A1 + A4 + C1 + C2）：

1. **A1**：符号快照改为 base + 增量 delta 持久化，单文件保存的磁盘写入从 ~62 MB 降到 **< 10 KB**，合并（compaction）延迟到空闲/关闭/构建完成时。
2. **A4**：内存中改为 **base 列式表 + overlay**，单文件更新从 O(n) 降到 **O(Δ)**（目标 < 5 ms，无论总符号数）。
3. **C1**：索引规模预算与内存保护：超过阈值给出明确提示与一键收敛入口；构建期按规模自动降并发；超限不静默。
4. **C2**：`Code Insight: 索引诊断` 命令，输出可复制 Markdown：规模、体积、耗时、跳过原因、overlay 状态、进程内存、预算状态。

非目标：跨工作区共享缓存（A3）、include 图（B1）、构建期流式列式解析（A2）、成员/变量索引（B3）。

## 2. 总体设计

```
磁盘：symbols.sidx (v3 base, 只在 compaction/构建时写)
      symbols.sidx.delta (新：追加式记录，单文件 KB 级)
      symbols.names / symbols.names.delta (引用索引，已实现)

内存：SymbolIndex = BaseTable(v3 列式, 只读) + Overlay(Map<path, FileSlot>, removedSet)
      findByName / entriesInFile / files / forEachName 在两层上合并
      ↓ 触发条件（delta 大小 / 空闲 / 关闭 / 重建完成）
      compaction：flatten() → 新 BaseTable（原子写）→ 清空 delta 与 overlay
```

## 3. 接口契约（冻结）

> 实现必须严格按此签名；`src/shared/types.ts` 与新增 `src/core/overlay-index.ts`、`src/core/snapshot-delta.ts` 以此为准。

### 3.1 SymbolTable v2（`src/shared/types.ts`）

```ts
export interface SymbolTable {
  readonly version: number
  readonly roots: readonly string[]
  readonly builtAt: number
  readonly entryCount: number
  readonly fileCount: number
  readonly files: readonly FileRecord[]
  entryAt(index: number): SymbolEntry
  findByName(name: string): SymbolEntry[]
  entriesInFile(file: string): SymbolEntry[]
  /** 仅遍历去重后的名字（不再提供索引区间；配合 findByName 使用） */
  forEachName(callback: (name: string) => void): void
  /** 全量遍历（诊断/索引器用；overlay 需包含变更） */
  forEachEntry(callback: (entry: SymbolEntry) => void): void
  toArray(): SymbolEntry[]
}
```

变更点：`forEachName(callback: (name, start, end))` → `(name)`；`query.searchSymbols` 改为：先 `forEachName` 过滤名字，命中后 `findByName(name)` 取条目（命中数受 limit 约束，成本可控）。

### 3.2 Overlay 索引（新文件 `src/core/overlay-index.ts`）

```ts
export interface OverlayFileSlot {
  readonly file: FileRecord
  readonly entries: readonly SymbolEntry[]
}

export interface MutableSymbolIndex extends SymbolTable {
  /** 单文件增量更新：O(Δ)，不重建 base 列 */
  applyFile(file: FileRecord, entries: readonly SymbolEntry[]): void
  /** 删除文件；返回是否真的存在 */
  removeFile(file: string): boolean
  /** 已变更文件数（含删除） */
  readonly pendingChanges: number
  /** 变更文件路径（持久化 delta 时使用） */
  pendingPaths(): string[]
  /** 折叠成紧凑 SymbolTable（compaction） */
  flatten(): SymbolTable
  /** 仅 base 层（用于写盘前判断是否需要 compaction） */
  readonly base: SymbolTable
}

export function createMutableIndex(base: SymbolTable): MutableSymbolIndex
export function createMutableIndexFromDeltas(
  base: SymbolTable,
  records: readonly SnapshotDeltaRecord[],
): MutableSymbolIndex
```

语义约束：
- `files` 返回合并后的文件列表（base 去掉 removed，叠加 overlay，按 path 升序；惰性缓存，变更时失效）。
- `entryCount = base.entryCount - 被替换/删除文件的 base 条目数 + overlay 条目数`（O(Δ) 维护计数）。
- `findByName`：base 结果中剔除 removed/被替换文件的条目，再并入 overlay 同名条目，按现有排序规则返回。
- `entriesInFile`：overlay 命中优先；removed 返回 `[]`。
- `forEachName`：base 名字 + overlay 名字的归并去重（overlay 通常 ≤ 数百个文件，成本可控）。
- `forEachEntry`：base 条目跳过 removed/被替换文件，再追加 overlay 条目。
- `flatten()`：单遍 O(n) 合并（复用现有列式构造逻辑），产出新 SymbolTable；调用后 overlay 清空。

### 3.3 快照 delta（新文件 `src/core/snapshot-delta.ts`）

```ts
export type SnapshotDeltaRecord =
  | { kind: 'set'; path: string; mtimeMs: number; size: number; entries: readonly SymbolEntry[] }
  | { kind: 'remove'; path: string }

export function snapshotDeltaPath(basePath: string): string // `${basePath}.delta`
export async function appendSnapshotDelta(deltaPath: string, record: SnapshotDeltaRecord): Promise<number>
export async function readSnapshotDeltas(deltaPath: string): Promise<SnapshotDeltaRecord[]>
export async function compactSnapshot(
  basePath: string,
  table: SymbolTable,
): Promise<{ baseBytes: number; deltaTruncated: boolean }>
export async function removeSnapshotDelta(deltaPath: string): Promise<void>
export async function snapshotDeltaBytes(deltaPath: string): Promise<number>
```

二进制格式（小端，可安全截断；尾部半条记录忽略）：

```
magic "SIDD" (4B) | version u32 (=1) | record*
record: kind u8 (0=set, 1=remove) | pathLen u32 | path utf8
        [set] mtimeMs f64 | size u32 | entryCount u32 | entry*
        entry: nameLen u32 | name utf8 | line u32 | endLine u32 | column u16 | kindCode u8
```

加载顺序：`loadSnapshot(base)` → `readSnapshotDeltas()` → `createMutableIndexFromDeltas()`；base 缺失但 delta 存在时视为损坏，整体丢弃（索引可重建）。

### 3.4 规模预算（`src/core/index-budget.ts`）

```ts
export interface IndexBudget {
  readonly maxSymbols: number        // 默认 2_000_000
  readonly maxFiles: number          // 默认 120_000
  readonly hardMaxSymbols: number    // 默认 5_000_000（现有 MAX_SYMBOLS_WARNING）
}
export type BudgetLevel = 'ok' | 'warn' | 'exceeded'
export interface BudgetReport {
  readonly level: BudgetLevel
  readonly symbols: number
  readonly files: number
  readonly message?: string
  readonly suggestions: readonly string[]   // 如 "缩小 indexRoots"、"排除 kernel/vendor 副本"
}
export function evaluateBudget(input: {
  symbols: number
  files: number
  budget: IndexBudget
}): BudgetReport
```

配置项（`package.json` contributes.configuration 新增）：

| 键 | 默认 | 说明 |
|---|---|---|
| `sourceInsight.maxSymbols` | `2000000` | 超过时状态栏警告 + 提示缩小索引目录 |
| `sourceInsight.maxFiles` | `120000` | 同上 |
| `sourceInsight.autoCompact` | `true` | 空闲/关闭时自动 compaction |

构建期行为（C1）：
- 构建完成（或增量更新后）调用 `evaluateBudget`；`warn/exceeded` 时状态栏变警告色，tooltip 给出规模与建议；`exceeded` 额外弹一次提示（带「重新配置索引目录」按钮）。
- `concurrency` 按 `files` 自动下调：`files > 80k → max 2`（减少峰值内存），日志记录实际值。
- 已存在的问题保留：`maxFileSizeKB` 跳过超大文件。

### 3.5 诊断（`src/core/diagnostics.ts` + `src/vscode/commands.ts`）

```ts
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
  readonly table: SymbolTable | undefined
  readonly pendingChanges: number
  readonly lastBuild: BuildSummary | undefined
  readonly lastError: string | undefined
  readonly skippedFiles: number
  readonly heapUsedBytes: number
  readonly rssBytes: number
  readonly budget: BudgetReport
  readonly kindCounts: Readonly<Record<SymbolKind, number>>
}
export function renderDiagnosticsMarkdown(input: DiagnosticsInput): string
```

命令 `si.showIndexDiagnostics`：生成 Markdown → 新建 untitled 文档展示（同时写一份到 `Output → Code Insight` 便于复制）；含「重建索引」「配置索引根」快捷提示（文本形式，不弹窗）。

## 4. 生命周期

| 时机 | 行为 |
|---|---|
| 激活 | 读 base + delta → overlay（O(Δ)）；引用索引仍惰性加载 |
| 保存文件 | overlay.applyFile + 追加 snapshot delta（KB 级）+ 追加 name-index delta（已有） |
| 删除文件 | overlay.removeFile + 追加 delta |
| 构建/重建 | 构建完成 → 写新 base → 删除 delta + 重建 overlay（空） |
| 空闲/关闭 | `deltaBytes > 4 MB` 或 `pendingChanges > 500` 或 `flush()` → compaction（写 base + 清 delta） |
| 清缓存 | 删除 base + delta + name index，重置内存 |

## 5. 兼容与迁移

- 快照 base 格式保持 **v3 不变**（旧 v3 base 直接可用；更早版本仍按版本号自动重建）。
- delta 是新增旁路文件：旧版本扩展看到 `symbols.sidx.delta` 会忽略（未知文件不影响），因此**双向兼容**（降级会丢增量，重建即可）。
- 不升 `SNAPSHOT_VERSION`；`snapshot-delta` 自带版本号。

## 6. 测试与验收指标

单元测试（新增）：
- overlay：apply/remove/files 合并、findByName 层叠、entriesInFile 优先级、forEachName 去重、flatten 等价性（与 createSymbolTable 结果逐条相等）。
- delta：追加/读取/截断容错/损坏 magic 忽略/compaction 后 base 与 delta 一致。
- budget：ok/warn/exceeded 边界与建议文案。
- diagnostics：Markdown 包含关键字段、无 undefined、跳过原因聚合。
- 回归：全部现有 160 个测试保持通过（query 等改为新 `forEachName` 签名）。

性能验收（真实仓库 6,838 文件 / 68,184 文件两档）：

| 指标 | 目标 |
|---|---|
| 单文件更新（applyFile） | **< 5 ms**（1.49M 符号也成立） |
| 单文件保存磁盘写入 | **< 10 KB**（delta 记录） |
| 激活加载（base + delta） | ≤ 现状 + 20 ms |
| compaction（1.49M 符号） | < 3 s，且只在空闲/关闭触发 |
| 搜索/引用性能 | 不劣化 >10%（overlay 为空时走 base 快路径） |

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| overlay 合并逻辑出错导致查询不一致 | 属性测试：对随机文件集合，overlay 结果必须等于"整体重建"结果（flatten 后逐条比较） |
| delta 文件损坏/截断 | 尾部记录忽略；magic/版本不符整体丢弃并重建 |
| compaction 期间用户编辑 | compaction 在防抖/空闲时执行，执行前快照 overlay 版本号，写盘后只清空已落盘部分 |
| 接口变更影响面 | 一次任务内完成 types/query/references/callgraph/service/tests 迁移，CI 全绿才继续 |
| 降级到旧扩展 | delta 被忽略，行为退化为丢失增量（索引可重建），不崩溃 |

回滚策略：保留 `snapshotDeltaPath` 开关（常量），关闭时服务走旧的"全量 saveSnapshot"路径；overlay 可用 `createMutableIndex` 直接包 base（不做增量），保证可快速回退。

## 8. 实施任务拆分

| 任务 | 内容 | 文件 |
|---|---|---|
| T1 | 契约落地：`SymbolTable` v2（forEachName 签名）、`SnapshotDeltaRecord` 等类型；全链路迁移并保持 160 测试绿 | `shared/types.ts`、`core/query.ts`、`test/*` |
| T2 | overlay：`createMutableIndex` / apply/remove/合并查询 / flatten + 属性测试 | `core/overlay-index.ts`、`test/overlay-index.test.ts` |
| T3 | snapshot delta：编码/解码/截断容错/compaction + 测试 | `core/snapshot-delta.ts`、`test/snapshot-delta.test.ts` |
| T4 | service 集成：保存/删除走 overlay + delta；空闲/关闭 compaction；清缓存/构建路径；`flush` | `vscode/service.ts` |
| T5 | C1 预算：`index-budget.ts` + 配置项 + 状态栏警告 + 构建并发降级 + 一次性提示 | `core/index-budget.ts`、`vscode/status.ts`、`vscode/service.ts`、`package.json`、l10n |
| T6 | C2 诊断命令 + Markdown 渲染 + 测试 + 文档 | `core/diagnostics.ts`、`vscode/commands.ts`、`test/diagnostics.test.ts`、README/CHANGELOG |
| T7 | 性能验证：真实仓库两档跑 perf；确认验收指标；本地安装试用（**不发布**） | `scripts/perf-build.js` |

交付方式：按发布策略，仅本地构建 + 安装试用，用户确认后再发版。

## 9. 待确认问题

1. 预算默认值（2M 符号 / 120k 文件）是否合适？你的大工作区 149 万符号，会落在 warn 区间（提示但不阻塞）。
2. compaction 触发阈值（delta 4 MB / 变更 500 文件 / 空闲 60 s / 关闭时）是否接受？
3. 诊断命令输出到 untitled Markdown 文档，还是只写 Output 通道？（建议 Markdown，便于复制反馈）
