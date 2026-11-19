# B3（成员 / 枚举常量 / 全局变量）实现计划（0.9.0）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 索引结构体/联合体成员、枚举常量、文件作用域全局变量；大纲嵌套、按字段名跳转（不推断类型）、search kind 过滤；快照升 v5 自动重建一次；**只本地构建/安装，用户确认前不发布**。

**Architecture:** 在 0.8.0 的 v4 列式表上增加三种 SymbolKind 与每符号 `parent`（字符串表 + parentIds 列）；扫描器新增成员/枚举常量/全局变量提取；delta 升 v3（parent 字段，兼容 v1/v2）；UI 用行区间把成员嵌到类型节点下，字段访问（`.`/`->`）按名字跳转。

**Tech Stack:** TypeScript（CommonJS，零运行时依赖）、node:test、vsce 4.1.0、VS Code API。

**设计文档:** `docs/superpowers/specs/2026-11-19-b3-members-enums-globals-design.md`（冻结契约）

## Global Constraints

- **发布策略**：只本地编译/测试/打包/安装；禁止 tag/publish/workflow；用户说 OK 才发布。
- 零运行时依赖；`src/core/**` 不 import `vscode`。
- `SNAPSHOT_VERSION` 升 **5**（v4 及更早自动丢弃重建）；delta 升 **v3**，**能读 v1/v2**；`symbols.names` 不变。
- 现有 **285** 测试保持通过；每任务跑 `npm test` + `npm run smoke`。
- 中文注释/文档、英文标识符；不出现 "RCIOS"。
- 字段跳转**不做类型推断**，候选上限 50；搜索默认包含新类型但 kind 降权。

---

## 文件结构

| 文件 | 责任 |
|---|---|
| `src/shared/types.ts` | kind 扩展、`SymbolEntry.parent`、`ScannedSymbol.parent`、`SNAPSHOT_VERSION=5`、`SYMBOL_KIND_ORDER` |
| `src/core/scan.ts` | `scanMembers` / `scanEnumConstants` / `scanGlobals`，`scanTypes` 合并新符号 |
| `src/core/symbol-table.ts` | v5 列（parentIds + parents 字符串表）、KIND_CODES 扩展 |
| `src/core/store.ts` | v5 编解码 |
| `src/core/snapshot-delta.ts` | delta v3（parent），读 v1/v2 |
| `src/core/overlay-index.ts` | parent 透传（flatten/delta replay） |
| `src/core/search-query.ts` | **新增** `parseSearchQuery`（@kind 过滤） |
| `src/vscode/field-access.ts` | **新增** `detectMemberAccess`（纯函数） |
| `src/vscode/providers/definition.ts` | 字段访问跳转 |
| `src/vscode/providers/document-symbol.ts` | 成员/枚举嵌套 |
| `src/vscode/providers/hover.ts` | parent/kind 文案 |
| `src/vscode/util.ts` | `toVscodeSymbolKind`/`kindLabel` 三类扩展 |
| `src/vscode/commands.ts` | search 解析 @kind；detail 显示 parent |
| `src/core/index-budget.ts` | 默认 3M / 硬 6M |
| `package.json`/nls/l10n | 默认值、@kind 提示、新 kind 文案 |
| tests | scan-members/scan-enums/scan-globals、v5 store/table、delta-v3、field-access、outline-nest、search-query、e2e/smoke 更新 |
| README/CHANGELOG | 0.9.0 双语文档 |

---

### Task 1: 扫描成员 / 枚举常量 / 全局变量（含 kind 扩展）

**Files:** `src/shared/types.ts`、`src/core/scan.ts`、`src/core/symbol-table.ts`（仅 KIND_CODES）、`test/scan-members.test.ts`、`test/scan-enums.test.ts`、`test/scan-globals.test.ts`；修复因新符号产生而受影响的既有测试（parser/types/types-e2e）

**Interfaces:**
- Produces: `SymbolKind` 新三值；`ScannedSymbol.parent?`；`scanMembers/scanEnumConstants/scanGlobals(text): ScannedSymbol[]`；`KIND_CODES` 扩展（member 7/enumConstant 8/variable 9）

- [ ] **Step 1: 写失败测试**

```ts
// test/scan-members.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { scanMembers } from '../src/core/scan'

test('scanMembers: multi declarators, pointer, array, bitfield, function pointer', () => {
  const text = [
    'struct sk_buff {',
    '  int len, *data;',
    '  unsigned char head[16];',
    '  unsigned int flags:3;',
    '  int (*cb)(void *arg);',
    '};',
  ].join('\n')
  const members = scanMembers(text)
  assert.deepEqual(members.map((m) => m.name), ['len', 'data', 'head', 'flags', 'cb'])
  assert.ok(members.every((m) => m.kind === 'member' && m.parent === 'sk_buff'))
})

test('scanMembers: union and anonymous member skipped', () => {
  const text = [
    'union u {',
    '  int a;',
    '  union { int x; int y; };',
    '};',
  ].join('\n')
  const members = scanMembers(text)
  assert.deepEqual(members.map((m) => m.name), ['a'])
  assert.equal(members[0]!.parent, 'u')
})
```

```ts
// test/scan-enums.test.ts
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
})
```

```ts
// test/scan-globals.test.ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { scanGlobals } from '../src/core/scan'

test('scanGlobals: file-scope variables only, skip functions/typedefs/params', () => {
  const text = [
    'static int counter;',
    'extern const char *g_name;',
    'unsigned char table[16] = {0};',
    'int a, b;',
    'static void helper(int local) { int inner; }',
    'typedef struct { int x; } point_t;',
  ].join('\n')
  const globals = scanGlobals(text)
  assert.deepEqual(globals.map((g) => g.name), ['counter', 'g_name', 'table', 'a', 'b'])
  assert.ok(globals.every((g) => g.kind === 'variable'))
})
```

- [ ] **Step 2: 运行确认失败**
```bash
npm run compile && node --test dist/test/scan-members.test.js dist/test/scan-enums.test.js dist/test/scan-globals.test.js
```
Expected: FAIL（函数/kind 不存在）。

- [ ] **Step 3: 实现**

types.ts：扩展 `SymbolKind`、`ScannedSymbol.parent?`、`SymbolEntry.parent?`、`SNAPSHOT_VERSION=5`、`SYMBOL_KIND_ORDER`（设计 §3.1）。symbol-table.ts 的 `KIND_CODES` 增加三项（member 7、enumConstant 8、variable 9）。

scan.ts 实现要点（复用现有深度/剥离器）：
- 成员：定位 `struct/union` 的 `{...}` 体，depth-1 语句按 `;` 切分；声明符解析：去掉位域 `:expr`、函数指针取 `(*name)`、多声明符按逗号分割（跳过指针/数组修饰）；跳过匿名成员（`struct { ... };`）
- 枚举常量：定位 `enum [tag] { ... }` 体，逗号分隔的标识符；`typedef enum ... } alias;` 的 alias 作为 parent
- 全局变量：depth 0 且不在函数体/类型体内、非 `typedef`、非函数声明（`(` 出现在 `;` 前且非函数指针）的声明语句；提取声明符名（多声明符）
- `scanTypes` 合并三类结果并保持按行排序/去重
- 实现为纯函数，签名 `(text: string) => ScannedSymbol[]`；行号用现有 `lineOf`/行起始表

- [ ] **Step 4: 修正既有测试期望**（新符号会改变 parser/types/types-e2e/indexer 的符号数）：按实际语义更新断言，不改实现去迎合旧数字。
- [ ] **Step 5: 全量测试 + 冒烟**
```bash
npm test && npm run smoke
```
Expected: 285 + 新增约 8 测试 = 约 293 PASS。
- [ ] **Step 6: Commit**

---

### Task 2: 快照 v5 + delta v3（parent 列）

**Files:** `src/shared/types.ts`、`src/core/symbol-table.ts`、`src/core/store.ts`、`src/core/overlay-index.ts`、`src/core/snapshot-delta.ts`；tests：`test/symbol-table-v5.test.ts`、`test/store-v5.test.ts`、`test/snapshot-delta-v3.test.ts`

**Interfaces:**
- Produces: v5 store/table（entryAt 返回 parent）、delta v3 编解码 + v1/v2 兼容读；overlay flatten/replay 保留 parent

- [ ] **Step 1: 写失败测试**：v5 roundtrip（parent 中文/空/长串、重复 parent 去重）；delta v3 roundtrip + v2 记录读兼容（parent undefined）；overlay applyFile 带 parent → flatten 后保留。
- [ ] **Step 2: 实现**

symbol-table.ts：
- `SymbolTableImpl` 列：`parentIds: Uint32Array`、`parents: string[]`
- `entryAt` 返回 `parent: parents[parentIds[i]] || undefined`
- `createSymbolTable` 收集 `entry.parent` 到去重字符串表（0 保留空），写 parentIds
- `getSymbolTableColumns` 返回新列

store.ts：`SNAPSHOT_VERSION=5`；v5 布局 = v4 + `parents` 字符串表 + `parentIds` 列（encode/decode 对称，版本≠5 拒绝）。
snapshot-delta.ts：`SNAPSHOT_DELTA_VERSION=3`；v3 entry 追加 `parentLen u32 | parent utf8`；decode 按布局版本读（v1/v2 无 parent）。
overlay-index.ts：`applyFile` 条目已带 parent；`flatten()` 的 entries 已带 parent（无需特殊处理，确认 `toArray` 保留）；delta replay 保留 parent。
- [ ] **Step 3: 全量测试**（含更新既有 v4 相关断言为 `SNAPSHOT_VERSION` 常量）→ Commit

---

### Task 3: indexer/service 集成 + 预算默认值

**Files:** `src/core/indexer.ts`（无需大改，确认新符号进入快照）、`src/vscode/service.ts`（保存 delta 带 parent）、`src/core/index-budget.ts`、`package.json`/nls、README 设置表、`test/index-budget.test.ts`、`test/indexer.test.ts`、`test/smoke-activate.js`

**Interfaces:** 构建/增量默认包含新符号；`DEFAULT_INDEX_BUDGET = { maxSymbols: 3_000_000, maxFiles: 120_000, hardMaxSymbols: 6_000_000 }`

- [ ] **Step 1: 测试**：indexer 小树含 struct 成员/enum/global → 快照 roundtrip 后能找到 member（kind/parent 正确）；service 保存含成员的文件 → delta v3 → reload 保留；预算边界测试更新（3M/6M）。
- [ ] **Step 2: 实现**：indexer 已消费 `ScannedSymbol` → `SymbolEntry`（确保 parent 透传）；service save 路径 entries 已带 parent（确认 `map` 未丢字段）；预算默认值与 nls/README 同步。
- [ ] **Step 3: 全量 + 冒烟** → Commit

---

### Task 4: UI（大纲嵌套 / 字段跳转 / 悬停 / @kind 搜索）

**Files:** `src/vscode/providers/document-symbol.ts`、`src/vscode/providers/definition.ts`、`src/vscode/providers/hover.ts`、`src/vscode/util.ts`、`src/vscode/commands.ts`、`src/vscode/field-access.ts`（新）、`src/core/search-query.ts`（新）、`src/vscode/rank-definitions.ts`（无需改，确认 kind 顺序来自 shared）、tests：`test/field-access.test.ts`、`test/search-query.test.ts`、`test/outline-nest.test.ts`（纯函数化嵌套逻辑）、smoke 扩展

**Interfaces:**
- `detectMemberAccess(linePrefix): 'member' | undefined`（trimEnd 后以 `.` 或 `->` 结尾）
- `parseSearchQuery(input): { query, kinds? }`（@func/@type/@macro/@member/@enum/@var；未知 @token 保留为文本）
- `buildOutlineTree(entries): OutlineNode[]`（纯函数，便于测试；document-symbol 调它转 DocumentSymbol）

- [ ] **Step 1: 写失败测试**：字段访问三种上下文（`p->f`、`v.f`、`.f =`）、非字段（`a.b` 在函数参数？按实现）、`@member` 过滤、嵌套大纲（struct→成员、enum→常量、多层取最内层、无归属留顶层）。
- [ ] **Step 2: 实现**
  - `core/search-query.ts`：token 解析
  - `vscode/field-access.ts`：`detectMemberAccess`
  - document-symbol：`buildOutlineTree`（core 或 vscode 纯模块）+ 转换；成员 `kind` → `SymbolKind.Field/EnumMember`
  - definition provider：字段访问 → `findByName(word).filter(kind==='member')` → `groupDefinitions`（table）→ 最多 50 → 返回 Locations；无命中回退普通定义
  - hover/util：kind 标签与 parent 文案
  - commands：search 解析 @kind；QuickPick detail 加 parent
  - l10n：新文案种、@kind 提示
- [ ] **Step 3: smoke 扩展**：真实 provider 断言字段跳转、大纲嵌套（mock vscode 的 DocumentSymbol 构造）、search @member 过滤；命令数不变（12）。
- [ ] **Step 4: 全量 + 冒烟** → Commit

---

### Task 5: 文档 / 压测 / 0.9.0 本地打包

**Files:** `scripts/perf-build.js`（新 kind 计数、字段跳转耗时）、`README.md`、`CHANGELOG.md`、`package.json`

- [ ] **Step 1: perf 扩展**：输出 member/enumConstant/variable 计数、快照体积、字段跳转耗时（`findByName` + rank）。
- [ ] **Step 2: 实测**（6,838 文件语料）：构建额外 <20%、快照 <+35%、字段跳转 <5 ms；文档只写实测数字。
- [ ] **Step 3: CHANGELOG 0.9.0 双语**（新索引类型、嵌套大纲、字段跳转、@kind 过滤、v5 自动重建一次、预算默认值调整、测试数）。
- [ ] **Step 4: README 双语**：功能表（成员/枚举/变量、字段跳转）、命令说明（@kind 语法）、设置（新默认值）、限制（不推断类型、字段候选列全部同名成员）。
- [ ] **Step 5: 升版本 0.9.0，本地打包** `bash scripts/release.sh 0.9.0`；验证 vsix；**不 tag/不发布/不安装**（控制者安装）。
- [ ] **Step 6: 全量测试 + Commit**

---

## Self-Review

| 设计需求 | 任务 |
|---|---|
| 三种新 kind + parent | T1/T2 |
| 成员/枚举/全局扫描 | T1 |
| v5 快照 + v3 delta 兼容 | T2 |
| indexer/service 集成 | T3 |
| 预算默认值 | T3 |
| 大纲嵌套 | T4 |
| 字段跳转（不推断类型，≤50） | T4 |
| @kind 搜索过滤 | T4 |
| 悬停 parent/kind | T4 |
| 文档/性能/0.9.0 | T5 |
| 不发布 | Global Constraints |

风险提示：
- T1 会让既有 parser/types 测试的符号数变化，必须在 T1 内更新期望（不改变语义去迎合旧断言）。
- T4 的 DocumentSymbol 嵌套需要 `endLine` 可靠（扫描器已提供）；无法归属的成员留在顶层，避免丢符号。
- `@kind` 解析只影响 UI 命令，核心 `searchSymbols` 接口不变。
- 快照 v5 自动重建一次，用户无需操作。
