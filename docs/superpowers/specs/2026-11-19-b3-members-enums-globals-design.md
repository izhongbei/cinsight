# B3 —— 成员 / 枚举常量 / 全局变量索引（0.9.0）设计

日期：2026-11-19
状态：设计已与用户确认（待 spec 评审 → 计划 → SDD）
前置：0.8.0（v4 快照 + include 图 + 条件标注，已发布）

## 1. 用户决策（已确认）

| 项 | 决策 |
|---|---|
| 符号范围 | 结构体/联合体**成员**、**枚举常量**、**文件作用域全局变量**；不做函数内局部变量/参数 |
| 成员展示 | 大纲**嵌套**在 struct/union 下；搜索包含成员；`p->field` / `v.field` 上 F12 **按字段名跳转**，不做类型推断 |
| 噪音控制 | 搜索默认包含全部，kind 排序降权；支持 `@func/@type/@macro/@member/@enum/@var` 过滤；字段跳转候选上限 50 |

## 2. 架构

沿用 0.8.0 的列式快照 + base/delta/overlay：

- `SymbolKind` 增加 `member` / `enumConstant` / `variable`
- 每个条目新增可选 `parent`（成员→struct/union 名；枚举常量→enum 名或 typedef 别名；全局变量无）
- 快照升 **v5**（新增 parent 字符串表 + parentIds 列）；**自动重建一次**
- delta 升 **v3**（每个 entry 增加 parent 字符串；读取兼容 v1/v2）
- `symbols.names` 引用索引格式不变

## 3. 冻结接口契约

### 3.1 类型（`src/shared/types.ts`）

```ts
export type SymbolKind =
  | 'function' | 'declaration' | 'macro'
  | 'struct' | 'union' | 'enum' | 'typedef'
  | 'member' | 'enumConstant' | 'variable'   // v5 新增

export interface SymbolEntry {
  // ...原有字段
  /** 成员/枚举常量的父类型名；无父级为 undefined */
  readonly parent?: string
}

export interface ScannedSymbol {
  // ...原有字段（含 condition）
  readonly parent?: string
}

export const SNAPSHOT_VERSION = 5

/**
 * 搜索排序：既有 kind 沿用 0.8.0 的相对顺序（function → struct → union → enum →
 * typedef → declaration → macro），v5 新增三类追加在尾部。
 */
export const SYMBOL_KIND_ORDER: Record<SymbolKind, number> = {
  function: 0, struct: 1, union: 2, enum: 3, typedef: 4, declaration: 5, macro: 6,
  member: 7, enumConstant: 8, variable: 9,
}
```

### 3.2 扫描（`src/core/scan.ts`）

```ts
/** 结构体/联合体成员（type body depth-1 内的声明符名） */
export function scanMembers(text: string): ScannedSymbol[]      // kind='member', parent=<tag>
/** 枚举常量（enum body 内标识符） */
export function scanEnumConstants(text: string): ScannedSymbol[] // kind='enumConstant', parent=<tag|typedef>
/** 文件作用域变量（depth 0 的声明/定义，排除函数声明/typedef/类型体内部） */
export function scanGlobals(text: string): ScannedSymbol[]      // kind='variable'
```

实现约束：
- 成员支持：多声明符 `int a, *b;`、数组、函数指针 `int (*cb)(void);`、位域 `a:3`
- 成员 parent：具名类型体（`struct tag { ... }`）用 tag；匿名类型体**仅在带 typedef 别名时**索引 depth-1 成员（`typedef struct { int x; int y; } point_t;` → parent = `point_t`，`typedef union { ... } value_t;` 同理），多个别名取第一个（`} a_t, *b_t;` → `a_t`）；**无别名的匿名类型体**（`struct { int x; } var;`）成员跳过（已知限制），函数体内的匿名类型体同样跳过
- 具名内联成员 `struct outer { struct foo { int y; } bar; };` 只索引成员 `bar`，其内层成员不索引
- 枚举常量：忽略 `= 表达式`；`typedef enum {A,B} Foo;` 的 parent 用 `Foo`（无 typedef 时用 tag；匿名且无 typedef 时 parent = 文件名无关的 `<anonymous>`）
- 全局变量：`static`/`extern`/`const` 修饰、指针/数组/多声明符支持；跳过 `typedef`、函数声明（已有 declaration/function）、宏
- 行号/结束行语义与现有符号一致（`line` = 声明符所在行）

### 3.3 符号表 / 存储（v5）

`SymbolTable` 契约不变（`SymbolEntry.parent` 随 `entryAt/findByName/entriesInFile/forEachEntry/toArray` 返回）。`SymbolTableImpl` 新增列：

```
parentIds u32[entryCount]          // 0 = 无 parent
parents: string[]                  // 字符串表，0 = ''
```

快照 v5 布局（v4 之后追加）：

```
files: 同 v4（hash）
names: 同 v4
conditions: 同 v4
parents: count u32 + [len u32, utf8] × count
entries 列: nameIds, fileIndexes, lines, endLines, columns, kinds, conditionIds, parentIds
nameOffsets / fileEntryOffsets / fileEntryIndexes
includeOffsets / includeTargets  （同 v4）
```

`createSymbolTable(roots, files, entries, builtAt, version, options?)` 的 entries 已带 `parent`，无需新参数。

### 3.4 delta v3（`src/core/snapshot-delta.ts`）

`SNAPSHOT_DELTA_VERSION = 3`；set 记录每个 entry 追加 `parentLen u32 | parent utf8`（无 parent 写 0）。读取：
- v3：读 parent
- v2/v1：parent 缺失 = undefined；其余字段按现有兼容逻辑
- 追加到 v1/v2 文件时整体重写为 v3（现有 reset 语义）

### 3.5 搜索过滤（`src/core/search-query.ts`，新）

```ts
export interface ParsedSearchQuery {
  readonly query: string                     // 去掉 @token 后的文本
  readonly kinds?: readonly SymbolKind[]     // 未指定则 undefined
}
/** 支持 @func @type @macro @member @enum @var；未知 @token 原样保留在 query */
export function parseSearchQuery(input: string): ParsedSearchQuery
```

`si.searchSymbol` 先解析再调用 `searchSymbols(table, parsed.query, { kinds: parsed.kinds, limit })`；QuickPick detail 显示 kind + parent（如 `member of struct sk_buff`）。

### 3.6 字段跳转（`src/vscode/field-access.ts`，纯函数）

```ts
/** 光标词左侧（去尾部空白）以 '.' 或 '->' 结尾时返回 'member'，否则 undefined */
export function detectMemberAccess(linePrefix: string): 'member' | undefined
```

DefinitionProvider：
1. 取当前词与 `linePrefix`；`detectMemberAccess` 命中 → `table.findByName(word).filter(kind === 'member')`
2. 候选用现有 `rankDefinitions`（include/同根软排序），上限 50，再做 group/代表
3. 无命中 → 回退现有普通定义逻辑

### 3.7 大纲嵌套 / 悬停

- DocumentSymbolProvider：`entriesInFile` 中 `struct/union/enum` 为顶层节点；`member`/`enumConstant` 挂到满足 `type.line <= child.line && child.endLine <= type.endLine` 的**最内层**类型下；匹配不到时按 `entry.parent` 名字兜底；无法归属则留在顶层
- Hover：`member of struct Foo` / `enumerator of enum Bar` / `variable`；沿用现有签名/位置行
- `toVscodeSymbolKind`/`kindLabel` 增加三类：Field(17)/EnumMember(20)/Variable(13)（VS Code `SymbolKind` 数值）

### 3.8 预算默认值

符号数增加，`DEFAULT_INDEX_BUDGET` 调整为：
- `maxSymbols: 3_000_000`
- `maxFiles: 120_000`（不变）
- `hardMaxSymbols: 6_000_000`

同步 `package.json` 默认值、nls 文案、README 设置表、预算测试边界。

## 4. 兼容

| 升级路径 | 行为 |
|---|---|
| 0.8.0 (v4) → 0.9.0 (v5) | 自动重建一次（版本不匹配） |
| delta v2/v1 → v3 | 读取兼容；下次追加重写为 v3 |
| `symbols.names` | 不变，无需重建 |

## 5. 验收

- 扫描正确性：成员（多声明符/函数指针/位域/数组）、枚举常量、全局变量（extern/static/const）各 ≥4 用例；匿名 typedef 类型体用别名作 parent，无别名的匿名类型体成员跳过
- 大纲：嵌套结构正确（结构体→成员、enum→常量、多层嵌套取最内层）；同文件多个同名类型按行区间归属
- 字段跳转：`p->field`、`v.field`、`.field = x` 初始化三种上下文；无成员命中回退普通定义；候选 ≤50
- 搜索：`@member/@enum/@var` 过滤；默认排序中函数/类型在成员/变量前
- 性能（6,838 文件语料）：构建额外 < 20%；快照 < +35%；字段跳转 < 5 ms；F12 不劣化
- 现有 285 测试保持；新增 ~20 测试

## 6. 不做（YAGNI）

- 函数内局部变量/参数、`obj->field` 类型推断（后续版本）
- 成员专用引用聚合
- C++ namespace/class

## 7. 已知限制

- 类型体之后先出现 `__attribute__((...))` 再出现别名时（`typedef struct { ... } __attribute__((packed)) foo_t;`），别名 `foo_t` 的 typedef 符号仍会丢失；成员仍以该别名作为 parent（`trailingTypedefAlias` 属性感知，`extractTypedefSymbols` 的别名提取未做属性感知）。
