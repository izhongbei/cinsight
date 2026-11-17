# B1 + B2 + B4 —— 定义解析准确度设计（0.8.0）

日期：2026-11-17
状态：已与用户确认设计（待 spec 评审后进入计划）
范围：0.8.0（B3 变量/成员索引放 0.9.0）
前置：0.7.0（列式 v3 符号表 + base/delta + overlay + 预算 + 诊断，本地已装、未发布）

## 1. 目标与用户决策

用户已确认：

| 项 | 决策 |
|---|---|
| 分批 | 0.8.0 = B1 + B2 + B4；B3 独立版本 |
| B1 include 图 | **软排序 + 标注**（不硬过滤，解析不到 include 也不丢候选） |
| B2 多副本 | 按**文件内容哈希**相同折叠（显示 “N copies”，可展开） |
| B4 条件分支 | 记录并显示条件文本，**无条件的定义优先**，不求值宏 |

要解决的问题（现状）：

- 大工程里同一函数/结构体有多份内核/驱动副本，F12 出现几十上百个同名候选（实测 `sk_buff` 77 个），只能靠路径远近猜。
- 无法判断某个候选是否被当前源文件真正包含。
- 结构体/宏在 `#ifdef` 分支里重复定义时，候选没有配置语境信息。

## 2. 架构选择

采用**快照 v4**（`SNAPSHOT_VERSION = 4`）：在现有列式 base 上新增三类数据：

1. 每文件**内容哈希**（64 位 FNV-1a，扫描时同一遍读取计算）
2. 每文件**include 边**（已解析到索引内文件的目标，CSR 存储）
3. 每符号**条件栈文本**（id 指向条件字符串表；空 = 无条件）

配套：SIDD delta 升级 v2（新增哈希/include/条件字段，读取兼容 v1）；`symbols.names` 不变。

升级行为：v2/v3 旧快照版本不匹配 → 自动丢弃并重建一次（现有机制）；无需用户操作。

## 3. 冻结接口契约

### 3.1 扫描（`src/core/hash.ts`、`src/core/scan.ts`）

```ts
/** 64 位 FNV-1a（lo/hi 双 32 位，避免 BigInt 开销与 32 位碰撞风险） */
export function hashContent64(text: string): { lo: number; hi: number }

export interface ScannedInclude {
  readonly path: string        // 去掉引号/尖括号后的原始路径
  readonly line: number
  readonly angled: boolean     // #include <...>
}

/** 扫描 #include（行首预处理指令；忽略注释/字符串内的伪指令） */
export function scanIncludes(text: string): ScannedInclude[]

/** 每个符号条件栈文本（最内层 ≤3 层，以 " && " 连接，截断 120 字符；无则 undefined） */
export interface ScannedSymbol {
  name: string
  kind: SymbolKind
  line: number
  endLine: number
  column: number
  condition?: string
}
```

`ScannedFileResult` 扩展：

```ts
export interface ScannedFileResult {
  symbols: ScannedSymbol[]
  hashes: Uint32Array
  contentHash: { lo: number; hi: number }
  includes: ScannedInclude[]
}
```

### 3.2 符号表 v4（`src/shared/types.ts`、`src/core/symbol-table.ts`）

```ts
export interface FileRecord {
  readonly path: string
  readonly mtimeMs: number
  readonly size: number
  /** 内容哈希（v4 起必填；旧数据迁移时为 {0,0}） */
  readonly contentHashLo?: number
  readonly contentHashHi?: number
}

export interface SymbolEntry {
  // ...原有字段
  /** 条件栈文本；undefined/'' = 无条件 */
  readonly condition?: string
}

export interface SymbolTable {
  // ...原有方法
  /** 该文件直接包含的索引内文件路径（已解析；未解析的不返回） */
  includedFiles(file: string): readonly string[]
  /** fromFile 是否直接或传递包含 toFile（BFS + 缓存；深度上限 64） */
  isReachable(fromFile: string, toFile: string): boolean
  /** 该文件的内容哈希（lo/hi）；无哈希返回 undefined */
  contentHashOf(file: string): { lo: number; hi: number } | undefined
}
```

实现约束：
- `includedFiles` 走 CSR（`includeOffsets: Uint32Array[fileCount+1]`, `includeTargets: Uint32Array`）
- `isReachable` 每次查询 BFS（出边数小），结果按 `fromFile` 缓存在表实例内（Map，随表替换失效）
- `entriesInFile`/`findByName` 返回的 `SymbolEntry` 带 `condition`
- overlay 版本实现同样契约：overlay 文件用自己记录的 include 边/哈希；未变更文件走 base

### 3.3 快照 v4 二进制布局（`src/core/store.ts`）

在 v3 头部（magic/version/builtAt/fileCount/entryCount/nameCount/rootsLen/rootsJson）之后：

```
files:   [pathLen u32, path utf8, mtime f64, size u32, hashLo u32, hashHi u32] × fileCount
names:   同 v3
conditions: count u32 + [len u32, utf8] × count        // 条件字符串表
entries 列: nameIds, fileIndexes, lines, endLines, columns, kinds, conditionIds u32 × entryCount
nameOffsets / fileEntryOffsets / fileEntryIndexes       // 同 v3
includeOffsets u32[fileCount+1] | includeTargets u32[edgeCount]
```

`FILE_HEADER` 不变（32B），`SNAPSHOT_VERSION = 4`；旧版本自动重建。

### 3.4 delta v2（`src/core/snapshot-delta.ts`）

`SNAPSHOT_DELTA_VERSION = 2`；record 扩展：

```
set 记录: path | mtime f64 | size u32 | hashLo u32 | hashHi u32 | entryCount u32
          | entry* (name, line, endLine, column, kind, conditionLen u32 | condition utf8)
          | includeCount u32 | include* (pathLen u32 | path utf8)
```

读取 v1 记录：缺失字段取默认（hash {0,0}、condition undefined、includes []），可安全重放。

### 3.5 解析与排序（`src/vscode/rank-definitions.ts`、新 `src/core/definition-groups.ts`）

```ts
export interface RankContext {
  sourceFile: string | undefined
  roots: readonly string[]
  table?: SymbolTable
}

export function rankDefinitions(entries: readonly SymbolEntry[], context: RankContext): SymbolEntry[]

export interface DefinitionGroup {
  readonly entries: readonly SymbolEntry[]   // 同内容哈希的副本，按 rank 排序
  readonly representative: SymbolEntry
  readonly included: boolean                 // 代表副本是否被 sourceFile 包含
  readonly conditional: boolean
}
export function groupDefinitions(
  entries: readonly SymbolEntry[],
  context: RankContext,
): DefinitionGroup[]
```

排序键（从高到低）：
1. `table.isReachable(sourceFile, entry.file)` → 最高
2. 现有规则：同 indexRoots 根 → 共享路径前缀 → kind 顺序 → 头文件/源文件偏好 → 深度/长度 → file/line
3. **无条件条目优先于有条件条目**（条件信息仅作同层 tie-break）
4. 解析不到 include / 无表时退化为原排序（不劣化）

### 3.6 展示

- **原生 F12**：返回排序后的**分组代表**（同内容哈希只出一个 Location），所以 `sk_buff` 从 77 个降到少数几组；分组不可在原生 picker 展开。
- **新命令 `si.showDefinitionCandidates`**（“显示定义候选”）：QuickPick 展示全部组，label 示例：
  `sk_buff  · included  · 3 copies  · ../../include/linux/skbuff.h:533`
  选中组后若多副本，再弹二级 QuickPick 选具体副本；`conditional` 组显示 `#ifdef RTK_MODULE`。
- **Hover**：签名 + `included by current file` / `not included` / `N identical copies` / `conditional: #ifdef ...` 一行说明。
- 现有 Search/Callers/Callees 列表的 detail 里追加 `included` / `conditional` 标注（复用同一格式化函数）。

## 4. 构建与增量

1. worker 扫描返回 `contentHash/includes/condition`（同一遍读，零额外 IO）
2. 主线程：`path → fileIndex` 映射；对每个文件解析 include（相对目录 → 尝试原样 / 相对源文件目录 / 各 indexRoots 前缀），命中索引内文件才建边；未命中忽略（不报错）
3. `createSymbolTable` v4 组装哈希/条件/CSR
4. 单文件保存：overlay `applyFile(file, entries)` + `applyIncludes(file, includes)`；delta v2 记录哈希/条件/include；O(Δ) 不变
5. compaction：flatten 保留三类数据；delta 清空

## 5. 兼容

| 升级路径 | 行为 |
|---|---|
| 0.7.0 (v3) → 0.8.0 (v4) | 自动重建一次（版本号不匹配） |
| 0.8.0 内 delta v1 → v2 | 读取兼容 v1 默认值 |
| `symbols.names` 引用索引 | 格式不变，无需重建 |

## 6. 测试与验收

单元（新增）：
- `hashContent64`：已知向量、空串、长文本、lo/hi 稳定
- `scanIncludes`：引号/尖括号、注释里的伪 include、行首缩进、多行 `#if` 里的 include
- 条件栈：`#if/#ifdef/#ifndef/#elif/#else/#endif` 嵌套、未配对 `#endif` 降级、截断
- include 解析：相对路径、indexRoots 搜索、未命中跳过、循环 include（A↔B）不挂
- v4 store roundtrip（哈希/条件/边全字段）、旧版本拒绝
- delta v2 roundtrip（含 include/条件/哈希）、v1 记录兼容
- overlay：applyIncludes、includedFiles 合并、isReachable 经过 overlay 边、flatten 等价
- 排序：included > 未包含、无条件 > 有条件、无表退化、分组折叠（内容哈希相同/不同）
- e2e：真实小树（a.c 包含 inc/x.h；x.h 有同名定义两份副本；`#ifdef` 分支）验证 F12 分组代表 + QuickPick 标注

验收（6,838 文件语料）：
- 构建额外耗时 < 10%（基线 5.7–6.5 s）
- 快照体积增加 < 15%（基线 5.13 MB）
- F12 排序额外耗时 < 2 ms；`showDefinitionCandidates` 打开 < 100 ms
- 内存增加 < 20 MB
- 现有 213 测试保持通过（v4 迁移相关测试更新）

## 7. 风险与回滚

| 风险 | 缓解 |
|---|---|
| include 解析在超大工程大量未命中 | 软排序：未命中不改变现有顺序，只影响"命中可提升" |
| 条件栈文本过长/嵌套异常 | 只取最内层 3 层、截断 120 字符；未配对时标记 unknown |
| 64 位哈希碰撞 | 64 位 FNV 在 10 万文件规模碰撞概率可忽略；折叠只影响展示，不丢定义（组内副本全部保留） |
| v4 重建一次 | 自动；索引是缓存，可安全重建 |
| 快照变大 | 限制在 15% 预算内；超出则条件只存最内层 1 层（降级） |

## 8. 不做什么（YAGNI）

- 不实现 C 预处理器求值、不做 `#include` 宏展开
- 不做函数内局部变量/参数索引、不做 `obj->field` 类型推导（B3 及以后）
- 不改引用索引格式、不改搜索排序规则
- 不实现跨工作区共享缓存
