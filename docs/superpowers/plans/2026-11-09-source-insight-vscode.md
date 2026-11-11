# Source Insight C — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个可直接安装的 VS Code 扩展 `.vsix`，为大型 C 工程提供 Source Insight 风格的函数跳转、搜索、引用、调用关系、侧边栏符号窗口、悬停与大纲。

**Architecture:** `src/core/` 是无 `vscode` 依赖的纯 Node 逻辑（词法解析 → 紧凑符号表 → 二进制快照；引用/调用图按需扫描磁盘），可用 `node:test` 单测；`src/vscode/` 只做 VS Code 协议转换（Provider、TreeView、命令、状态栏、配置）。两半通过 `src/shared/types.ts` 的只读数据结构通信。

**Tech Stack:** TypeScript 5（CommonJS → `dist/`）、VS Code Extension API 1.90+、Node 24（`node:test`、`worker_threads`）、`@vscode/vsce` 打包。运行时零第三方依赖。

## Global Constraints

- `engines.vscode` 固定 `^1.90.0`。
- `src/core/**` 与 `src/shared/**` 禁止 `import * as vscode` / `from 'vscode'`（单测与集成冒烟都靠这条）。
- 所有用户可见字符串必须经 `vscode.l10n.t(...)`，英文原文作为 key；`package.json` 里的标题/描述走 `%key%` + `package.nls.json`、`package.nls.zh-cn.json`。
- 运行时不得引入第三方 npm 依赖（`dependencies` 为空）；`devDependencies` 仅构建/测试用。
- 索引/解析用 `latin1` 字节语义保持行列号稳定；仅展示文本用 UTF-8。
- 每个任务先写失败测试再实现（TDD），提交信息用 `feat:` / `test:` / `fix:`。
- 工作目录：`/mnt/data/br_v4.35_develop_feature_hisi_20260825/tools/vscode-source-insight`（独立 git 仓库）。
- 编译命令：`npx tsc -p .`；单测命令：`npm test`（= 编译 + `node --test dist/test`）。
- 不得修改固件工程源码；不得写入扩展目录以外的工作区文件。

## File Map

| 文件 | 责任 | 所有者 |
|---|---|---|
| `package.json`, `tsconfig.json`, `.vscodeignore`, `package.nls*.json` | 清单、编译、i18n、命令/配置/视图声明 | Lead |
| `src/shared/types.ts` | 唯一跨层数据契约 | Lead（冻结，他人只读） |
| `src/core/exclude.ts` | glob 排除匹配 | A |
| `src/core/walk.ts` | 文件遍历 + 清单 | A |
| `src/core/scan.ts` | C 词法剥离 + 符号提取 | A |
| `src/core/worker-scan.ts` | worker 线程入口 | A |
| `src/core/indexer.ts` | worker 池、增量、快照保存 | A |
| `test/parser.test.ts`, `test/walk-exclude.test.ts`, `test/indexer.test.ts` | A 的测试 | A |
| `src/core/query.ts` | 搜索/按名/按文件查询 | C |
| `src/core/signature.ts` | 签名重建 | C |
| `src/core/references.ts` | 引用扫描 | C |
| `src/core/callgraph.ts` | callers/callees | C |
| `test/query.test.ts`, `test/refs-callgraph.test.ts` | C 的测试 | C |
| `src/vscode/extension.ts` | activate/deactivate | B |
| `src/vscode/config.ts` | 配置读取 | B |
| `src/vscode/service.ts` | 索引服务（core ↔ vscode 桥） | B |
| `src/vscode/commands.ts` | 命令注册 | B |
| `src/vscode/status.ts` | 状态栏 | B |
| `src/vscode/quickpick.ts` | 符号 QuickPick | B |
| `src/vscode/providers/*.ts` | 6 个 Provider | B |
| `src/vscode/views/symbols-tree.ts` | 侧边栏树 | B |
| `test/smoke-activate.js` | mock vscode 激活冒烟 | Lead |
| `README.md`, `CHANGELOG.md`, `LICENSE`, `resources/icon.*` | 交付文档与资源 | Lead |
| `scripts/perf-build.js` | 真实仓库压测 | Lead |

## Interfaces（冻结契约）

`src/shared/types.ts` 完整内容（Lead 提供，所有任务以此为唯一类型来源）：

```ts
export type SymbolKind = 'function' | 'declaration' | 'macro'

export interface SymbolEntry {
  readonly name: string
  readonly kind: SymbolKind
  /** workspace 相对 posix 路径 */
  readonly file: string
  /** 0-based 定义首行 */
  readonly line: number
  /** 0-based 函数体结束行；声明/宏等于 line */
  readonly endLine: number
  /** 0-based 名字起始列 */
  readonly column: number
}

export interface FileRecord {
  readonly path: string
  readonly mtimeMs: number
  readonly size: number
}

export interface IndexSnapshot {
  readonly version: number
  readonly roots: readonly string[]
  readonly builtAt: number
  readonly files: readonly FileRecord[]
  readonly entries: readonly SymbolEntry[]
}

export interface ScannedSymbol {
  readonly name: string
  readonly kind: SymbolKind
  readonly line: number
  readonly endLine: number
  readonly column: number
}

export type IndexPhase = 'walk' | 'parse' | 'save'

export interface IndexProgress {
  readonly phase: IndexPhase
  readonly done: number
  readonly total: number
  readonly currentFile?: string
}

export interface BuildOptions {
  readonly workspaceRoot: string
  readonly roots: readonly string[]
  readonly exclude: readonly string[]
  readonly maxFileSizeKB: number
  readonly concurrency: number
  readonly followSymlinks: boolean
  readonly previous?: IndexSnapshot
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: IndexProgress) => void
}

export interface BuildSummary {
  readonly files: number
  readonly entries: number
  readonly added: number
  readonly updated: number
  readonly removed: number
  readonly unchanged: number
  readonly skipped: number
  readonly durationMs: number
  readonly snapshotBytes: number
}

export interface ReferenceHit {
  readonly file: string
  readonly line: number
  readonly column: number
  readonly preview: string
}

export interface CallerHit extends ReferenceHit {
  /** 命中点所在的函数；文件顶层等无法归属时为 undefined */
  readonly from: SymbolEntry | undefined
}

export type ReadFileFn = (relativePath: string) => Promise<string>

export const SNAPSHOT_VERSION = 1
export const INDEXED_EXTENSIONS = ['.c', '.h', '.cc', '.cpp', '.hpp', '.hh', '.inl'] as const
export const DEFAULT_EXCLUDE = ['**/.git/**', '**/build/**', '**/tmp/**', '**/node_modules/**'] as const
export const SYMBOL_KIND_ORDER: Record<SymbolKind, number> = { function: 0, declaration: 1, macro: 2 }
```

各模块导出的函数签名（必须一字不差）：

```ts
// src/core/exclude.ts
export function compileExclude(patterns: readonly string[]): (relPath: string) => boolean
export function matchesGlob(relPath: string, pattern: string): boolean

// src/core/walk.ts
export function isIndexableFile(path: string): boolean
export function walkFiles(options: {
  workspaceRoot: string
  roots: readonly string[]
  exclude: readonly string[]
  maxFileSizeKB: number
  followSymlinks: boolean
  signal?: AbortSignal
  onProgress?: (progress: IndexProgress) => void
}): Promise<FileRecord[]>

// src/core/scan.ts
export function scanSource(text: string): ScannedSymbol[]

// src/core/store.ts
export async function loadSnapshot(file: string): Promise<IndexSnapshot | undefined>
export async function saveSnapshot(file: string, snapshot: IndexSnapshot): Promise<number>

// src/core/indexer.ts
export function createSnapshot(
  roots: readonly string[],
  files: readonly FileRecord[],
  entries: readonly SymbolEntry[],
): IndexSnapshot
export async function buildIndex(options: BuildOptions & { readFile: ReadFileFn }): Promise<{
  snapshot: IndexSnapshot
  summary: BuildSummary
}>

// src/core/query.ts
export function searchSymbols(
  snapshot: IndexSnapshot,
  query: string,
  options?: { limit?: number; kinds?: readonly SymbolKind[] },
): SymbolEntry[]
export function findByName(snapshot: IndexSnapshot, name: string): SymbolEntry[]
export function entriesInFile(snapshot: IndexSnapshot, file: string): SymbolEntry[]

// src/core/signature.ts
export async function readSignature(readFile: ReadFileFn, entry: SymbolEntry): Promise<string | undefined>
export async function readSignatureAtLine(
  readFile: ReadFileFn,
  file: string,
  line: number,
): Promise<string | undefined>

// src/core/references.ts
export interface ReferenceOptions {
  readonly signal?: AbortSignal
  readonly onProgress?: (done: number, total: number) => void
  readonly includeDeclaration?: boolean
}
export async function findReferences(
  snapshot: IndexSnapshot,
  name: string,
  readFile: ReadFileFn,
  options?: ReferenceOptions,
): Promise<ReferenceHit[]>

// src/core/callgraph.ts
export async function callersOf(
  snapshot: IndexSnapshot,
  name: string,
  readFile: ReadFileFn,
  options?: ReferenceOptions,
): Promise<CallerHit[]>
export async function calleesOf(
  snapshot: IndexSnapshot,
  name: string,
  readFile: ReadFileFn,
  options?: { signal?: AbortSignal },
): Promise<SymbolEntry[]>
```

---

### Task 1: 工程脚手架与契约（Lead，先于所有队友完成）

**Files:** Create `package.json`, `tsconfig.json`, `.vscodeignore`, `src/shared/types.ts`, 以及 `src/core/*.ts` 与 `src/vscode/*.ts` 的**可编译占位实现**（正确签名 + `throw new Error('not implemented')`），保证 `npx tsc -p .` 全绿后队友再接手各自文件。

**Steps:**

- [ ] 写 `package.json`（命令、配置、视图、菜单、`engines.vscode: ^1.90.0`、`main: ./dist/src/vscode/extension.js`、`node --test dist/test` 脚本）。
- [ ] 写 `tsconfig.json`：`target ES2022`、`module commonjs`、`rootDir "."`、`outDir "dist"`、`strict true`、`skipLibCheck true`、`types ["node"]`、`include ["src/**/*.ts","test/**/*.ts"]`。
- [ ] 写 `src/shared/types.ts`（上面完整内容）。
- [ ] `npm install -D typescript@^5 @types/node@^22 @types/vscode@^1.90.0 @vscode/vsce@^3`。
- [ ] 写占位实现，`npx tsc -p .` 通过；`npx vsce package --no-dependencies` 可产出空壳 vsix（验证清单合法）。
- [ ] `git add -A && git commit -m "feat: scaffold source-insight-c extension"`。

---

### Task 2: glob 排除 + 文件遍历（A）

**Files:** Create `src/core/exclude.ts`, `src/core/walk.ts`, `test/walk-exclude.test.ts`。

**Interfaces:** Consumes `types.ts`（`FileRecord`、`IndexProgress`、`INDEXED_EXTENSIONS`）。Produces `compileExclude`、`matchesGlob`、`isIndexableFile`、`walkFiles`。

**Behavior:**
- `matchesGlob`：支持 `**`（跨目录）、`*`（段内）、`?`；模式以 `/` 开头时按 workspace 根锚定；不含 `**` 的目录模式如 `build` 也匹配任意层级的该目录（实现为追加 `/**`）。大小写敏感（Linux）。
- `compileExclude(patterns)` 返回函数，空模式永远 `false`。
- `walkFiles`：对每个 root 递归 `readdir(withFileTypes)`，跳过 `.git`；`followSymlinks=false` 时忽略 `Dirent.isSymbolicLink()`；`maxFileSizeKB` 超限跳过（计入 skipped 不可见，直接不返回）；只返回 `isIndexableFile` 的文件；相对路径用 `posix` 分隔符；结果按路径字典序排序；每 500 个文件回调一次 `onProgress({phase:'walk',done,total:0,currentFile})`；`signal?.aborted` 时抛 `AbortError`（`new Error('aborted'); error.name='AbortError'`）。

**Tests（先写失败）:**
1. `matchesGlob('proj/build/a.c','**/build/**') === true`；`matchesGlob('proj/src/a.c','**/build/**') === false`。
2. `matchesGlob('a/b/c.c','a/**/*.c') === true`；`matchesGlob('a/c.c','a/**/*.c') === false`（`**/` 至少一层）。
3. `matchesGlob('x/tmp/y.h','**/tmp/**') === true`。
4. `compileExclude([])('any/path.c') === false`。
5. `isIndexableFile('a.c')===true`、`'a.C'===false`、`'a.txt'===false`、`'a.hpp'===true`。
6. `walkFiles` 用 `test/fixtures/walk/` 小树（含 `sub/a.c`、`sub/b.h`、`sub/skip.txt`、`build/c.c`、`tmp/d.h`）：断言返回 `['sub/a.c','sub/b.h']`（exclude 默认可跳过 build/tmp）。
7. 超大文件（> maxFileSizeKB）被跳过。
8. AbortSignal 取消后 reject 且 `error.name==='AbortError'`。

**Verify:** `npm test -- --test-name-pattern=walk` 通过；`npx tsc -p .` 无错。
**Commit:** `feat: file walking with glob excludes`

---

### Task 3: C 词法剥离与符号提取（A）

**Files:** Create `src/core/scan.ts`, `test/parser.test.ts`, `test/fixtures/c/*.c|h`。

**Interfaces:** Produces `scanSource(text: string): ScannedSymbol[]`；Consumes `types.ts`。

**Behavior（按 spec §5）:**
1. 单遍状态机 `stripSources(text)`：把注释、字符串、字符字面量内容替换为空格（保留 `\n`），支持 `\` 续行。
2. 深度 0 扫描：维护 `{}` 深度；预处理行（行首 `#`）上的匹配全部忽略，但 `#define NAME(` 单独识别为 macro（`endLine` 取续行末尾）。
3. 函数定义/声明判定：`IDENT` 紧跟 `(`，其左侧上下文（同一深度 0 的连续记号）最后一段是「类型标识符/修饰符/`*`」而非运算符/关键字 → 括号平衡 → 跳过 `__attribute__((...))`/`__declspec(...)`/`asm(...)` → 下一非空字符 `{` 为定义（`endLine` = 配对 `}` 行）、`;` 为声明。
4. 排除 C 关键字集合 `if/for/while/switch/return/sizeof/do/else/case/goto/typedef/struct/union/enum` 以及 `sizeof(`、`__attribute__((`、`typeof(`。
5. `column` = 名字在行内的 0-based 字符偏移。

**Tests（先写失败），每条一个 fixture 或内联字符串:**
1. 单行定义：`int foo(int a) { return a; }` → function，`line=0,endLine=0,column=4`。
2. 多行签名：`static int\nfoo(\n  const char *name,\n  u32 flags\n)\n{\n  return 0;\n}` → function，`line=1,endLine=6`，签名解析不误判。
3. 注释干扰：`/* int fake(void) { } */\nint real(void) { return 0; }` → 只有 `real`。
4. 字符串干扰：`char *s = "int fake(void) { }";` → 无符号。
5. 头文件原型：`extern int api_open(const char *path);` → declaration，`endLine===line`。
6. 函数指针参数：`void reg(int (*cb)(void *ctx), void *arg) { }` → 只有一个 `reg`，不产生 `cb` 定义。
7. `__attribute__`：`static int __init foo(void) __attribute__((unused));`（声明）与 `int bar(void) __attribute__((noreturn)) { while(1); }`（定义）。
8. 函数式宏：`#define MAX(a,b) ((a)>(b)?(a):(b))` → macro；多行续行 `#define CALL(x) \\\n  do { f(x); } while(0)` → macro `endLine` 为最后一行。
9. K&R 定义：`int old_style(a, b)\nint a;\nint b;\n{\n  return a + b;\n}` → 至少识别 `old_style`（允许不识别参数声明行）。
10. 嵌套括号/花括号：函数体内 `if (x) { y(); }` 不影响外层 `endLine`。
11. 误报排除：`if (x) { }`、`for (;;) {}`、`sizeof(x)`、`return (a+b);` 均不产生符号。
12. 结构体定义 `struct s { int a; };` 不产生函数符号。

**Verify:** `npm test -- --test-name-pattern=parser`；并 `node -e` 对 `plat/` 抽 100 个文件跑 `scanSource` 不抛异常（脚本临时命令即可）。
**Commit:** `feat: c lexer and symbol scanner`

---

### Task 4: 二进制快照 + 索引构建器（A）

**Files:** Create `src/core/store.ts`, `src/core/worker-scan.ts`, `src/core/indexer.ts`, `test/indexer.test.ts`。

**Interfaces:** Produces `loadSnapshot`、`saveSnapshot`、`createSnapshot`、`buildIndex`（签名见上）。Consumes `scanSource`、`walkFiles`、`types.ts`。

**Behavior:**
- 快照二进制布局按 spec §4；`loadSnapshot` 对 magic/version/长度不合法返回 `undefined`（不抛）；`saveSnapshot` 原子写（写 `.tmp` 再 `rename`），返回字节数。
- `buildIndex`：
  1. `walkFiles`（phase='walk'）。
  2. 与 `options.previous` 按 `mtimeMs+size` 比对：新增/变更文件入待解析队列，未变文件直接复用旧 `SymbolEntry`，消失文件丢弃。
  3. 待解析文件用 worker 池并行（`concurrency`，默认 4）：主线程 `new Worker(path.join(__dirname,'worker-scan.js'))`，消息 `{id, text}` / 回复 `{id, symbols}`；worker 内 `scanSource`。**worker 创建/运行失败时自动退化为主线程串行**并继续，不中断构建。
  4. 每完成一个文件回调 `onProgress({phase:'parse', done, total, currentFile})`，并对 AbortSignal 响应（抛 `AbortError`）。
  5. 写快照由调用方（service）负责；`buildIndex` 内部最后 phase='save' 后返回 `{snapshot, summary}`，`summary.snapshotBytes` 用 `saveSnapshot` 结果需由调用方填写 → 约定 `buildIndex` 不写盘，`summary.snapshotBytes=0`，由 B 的 service 写盘后回填（或 A 在 buildIndex 加 `snapshotPath?: string` 选项并据此写盘；**选择后者**：`BuildOptions` 增加可选 `snapshotPath`，提供时 buildIndex 写盘并回填字节数）。
- `readFile`: 由调用方注入，签名 `(relativePath) => Promise<string>`，实现用 `latin1` 读。

**Tests（先写失败）:**
1. 快照 roundtrip：构造 3 文件 5 符号 → `saveSnapshot` → `loadSnapshot` 全字段相等、`version===SNAPSHOT_VERSION`。
2. 损坏快照：写随机 100 字节 → `loadSnapshot` 返回 `undefined`。
3. 版本不符：手写 magic + version=999 → `undefined`。
4. `createSnapshot` 的 `entries` 按 `(file,line)` 排序、`builtAt` 为数字。
5. `buildIndex` 用 `test/fixtures/walk` 小树：首次 `added=2, updated=0`，symbol 数正确；第二次同参数 `added=0, updated=0, unchanged=2`。
6. 修改其中一个文件 `mtimeMs` 与内容后重建：`updated=1`。
7. 删除文件后重建：`removed=1`，其符号消失。
8. `concurrency:1` 与 `concurrency:4` 结果一致（符号集合相等）。
9. 注入 `readFile` 抛错的文件被跳过且 `skipped>=1`，构建仍成功。
10. AbortSignal 中止 → reject `AbortError`。

**Verify:** `npm test -- --test-name-pattern=indexer`；`npx tsc -p .`。
**Commit:** `feat: binary symbol snapshot and parallel index builder`

---

### Task 5: 搜索与签名（C）

**Files:** Create `src/core/query.ts`, `src/core/signature.ts`, `test/query.test.ts`。

**Interfaces:** Produces `searchSymbols`、`findByName`、`entriesInFile`、`readSignature`、`readSignatureAtLine`（签名见上）。测试可用 `createSnapshot` 构造数据（A 提供；若未就绪，先本地 `makeSnapshot` 辅助函数，A 落地后替换）。

**Behavior:**
- `searchSymbols`：query 去空白、大小写不敏感；空 query 返回 `[]`；权重依次为 完全相等 0、前缀 1、子词/驼峰命中 2、子串 3；同权重按 `[kind 顺序, name 长度, name, file, line]` 升序；`kinds` 过滤；默认 `limit=200`。
- `findByName`：精确名（大小写敏感），definition 在前、declaration 次之、macro 最后，再按 file/line。
- `entriesInFile`：按文件过滤，按 line 升序。
- `readSignature`：从 `entry.line` 起最多 20 行拼接到括号平衡后的 `{` 或 `;`；用与 scan 相同的剥离逻辑（导出 `stripSources` 供复用，若 A 未导出则由 C 在 signature.ts 内实现最小版本）；压缩连续空白为单空格、去掉行尾 `{`/`;` 后的内容；找不到时返回 `undefined`。
- `readSignatureAtLine`：给定文件与行，找该行内首个 `IDENT(` 并取签名；用于悬停兜底。

**Tests（先写失败）:**
1. 排序：`[foo, foo_bar, foobar, my_foo, xfoo]` 搜 `foo` → `foo, foo_bar, foobar, my_foo, xfoo`。
2. 大小写：搜 `FOO` 命中 `foo`。
3. `kinds` 过滤与 `limit`。
4. 空 query 返回 `[]`。
5. `findByName` 定义在声明前；无匹配返回 `[]`。
6. `entriesInFile` 行号升序且只含该文件。
7. `readSignature` 对多行签名返回单行 `static int foo(const char *name, u32 flags)`；定义行含 `__attribute__` 时该属性保留但不截断（属性在 `)` 与 `{` 之间，实现需读到这里再停）。
8. `readSignature` 对不存在的文件返回 `undefined`（不抛）。

**Verify:** `npm test -- --test-name-pattern=query`。
**Commit:** `feat: symbol search and signature extraction`

---

### Task 6: 引用扫描与调用关系（C）

**Files:** Create `src/core/references.ts`, `src/core/callgraph.ts`, `test/refs-callgraph.test.ts`。

**Interfaces:** Produces `findReferences`、`callersOf`、`calleesOf`；Consumes `query.findByName`、`scanSource`（如需解析函数体，可导出 `stripSources`）。

**Behavior:**
- `findReferences`：遍历 `snapshot.files`，并发（默认 8，`Promise.all` 分批）读文件；`text.indexOf(name) < 0` 直接跳过；命中文件用正则 `(?<![\w$])name(?![\w$])` 逐行定位（列 = `match.index`）；`preview` = 该行 `trim()` 后截断 200 字符；`includeDeclaration=false` 时排除与 `snapshot.entries` 中同名符号同 `file+line` 的位置；按 `(file,line,column)` 排序；每 500 文件回调 `onProgress`；响应 `signal`。
- `callersOf`：先 `findReferences(..., includeDeclaration:false)`，对每个命中文件用 `scanSource`（缓存 per file）找到包含该行的 function 区间（`line <= hit.line <= endLine`，取最内层），生成 `CallerHit.from`。
- `calleesOf`：对 `findByName` 的每个 function 定义，读文件、截取 `[line,endLine]` 行区间、剥离后匹配 `([A-Za-z_]\w*)\s*\(`；排除关键字、排除函数名自身与 `#define` 行；用 `findByName` 解析为 `SymbolEntry`；按出现顺序去重；`endLine<line` 或文件读失败返回 `[]`。
- 内部缓存：`scanSource` per file 用 `Map<string, ScannedSymbol[]>`（模块级，LRU 简单实现 ≤500 项）。

**Tests（先写失败，用 `test/fixtures/refs/` 三文件夹具）:**
1. `findReferences` 命中 3 处、排除定义行、结果排序稳定。
2. 注释/字符串中的名字不算引用（`/* foo() */`、`"foo()"` 不计入）。
3. `includeDeclaration:true` 包含声明行。
4. `callersOf` 返回 `from` 正确（`bar` 调用 `foo` → `from.name==='bar'`），顶层调用返回 `from===undefined`。
5. `calleesOf('bar')` 返回 `foo`、按出现顺序去重（重复调用只出现一次）。
6. `calleesOf` 对被调函数无定义时忽略（宏/系统函数）。
7. `signal.aborted` 时 reject `AbortError`。
8. 引用扫描 progress 回调总次数 ≥1。

**Verify:** `npm test -- --test-name-pattern='ref|call'`。
**Commit:** `feat: reference scanning and call graph`

---

### Task 7: 索引服务 + 配置 + 六个 Provider（B）

**Files:** Create `src/vscode/config.ts`, `src/vscode/service.ts`, `src/vscode/providers/{definition,references,hover,document-symbol,workspace-symbol,call-hierarchy}.ts`, `src/vscode/extension.ts`。

**Interfaces:** Consumes core 的 `buildIndex/loadSnapshot/saveSnapshot/searchSymbols/findByName/entriesInFile/readSignature/findReferences/callersOf/calleesOf`；Produces `SymbolService`（供 Task 8 消费）：

```ts
// src/vscode/service.ts
export class SymbolService implements vscode.Disposable {
  static create(context: vscode.ExtensionContext): Promise<SymbolService>
  readonly onDidChange: vscode.Event<void>          // 索引完成/增量更新后触发
  get snapshot(): IndexSnapshot | undefined
  get ready(): boolean
  get building(): boolean
  ensureBuilt(token?: vscode.CancellationToken): Promise<BuildSummary | undefined>
  rebuild(token?: vscode.CancellationToken): Promise<BuildSummary | undefined>
  updateFile(absPath: string): Promise<void>        // 供 watcher 调用
  removeFile(absPath: string): Promise<void>
  search(query: string, limit?: number): SymbolEntry[]
  definitions(name: string): SymbolEntry[]
  fileSymbols(rel: string): SymbolEntry[]
  references(name: string, token?: vscode.CancellationToken): Promise<ReferenceHit[]>
  callers(name: string, token?: vscode.CancellationToken): Promise<CallerHit[]>
  callees(name: string, token?: vscode.CancellationToken): Promise<SymbolEntry[]>
  signature(entry: SymbolEntry): Promise<string | undefined>
  readFile(rel: string): Promise<string>
  toAbsolute(rel: string): string
  toRelative(abs: string): string
  dispose(): void
}
```

**Behavior:**
- `config.ts`：`readConfig()` 返回 `{indexRoots, exclude, maxFileSizeKB, concurrency, searchLimit, autoReindexOnSave, enableCallHierarchy, followSymlinks}`，types 见 spec §7.5；`onDidChange` 监听 `workspace.getConfiguration('sourceInsight')`。
- `service.ts`：快照文件 `context.storageUri ?? context.globalStorageUri` 下 `symbols.sidx`；激活时尝试 `loadSnapshot`；`ensureBuilt` 在未配置 roots 时返回 `undefined`（不报错）；构建用 `withProgress` 由调用方包裹（service 只接受 `onProgress` 回调），写盘后回填 `snapshotBytes`；`onDidChange` 在构建完成与 `updateFile` 后 fire；watcher 由 extension.ts 建，回调 service。
- `DefinitionProvider`：`document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/)` → `definitions`；空则 `undefined`；多个返回全部 `Location`。
- `ReferenceProvider`：`withProgress` 调 `references`；`includeDeclaration=false`。
- `HoverProvider`：`definitions`/`findByName` 命中 → Markdown：`\`\`\`c\n<signature>\n\`\`\`` + `定义: <rel>:<line+1>`（+ 声明位置），`range` 为单词；未命中返回 `undefined`。
- `DocumentSymbolProvider`：`fileSymbols` → `new vscode.DocumentSymbol(name, kindLabel, SymbolKind.Function, range(line..endLine), range(name))`。
- `WorkspaceSymbolProvider`：`search(query, searchLimit)` → `new vscode.SymbolInformation(name, kind, containerName=dirname(file), new Location(uri, pos))`；未配置/未建好返回 `[]`。
- `CallHierarchyProvider`：`prepareCallHierarchy` 用定义；`incomingCalls` → `callers` → `{from: item, to: this, fromRanges:[...]}`；`outgoingCalls` → `callees`；`enableCallHierarchy=false` 时不注册。
- `extension.ts`：`activate` 创建 service、注册 6 个 Provider + `onDidChange` 触发的 `workspaceSymbolProvider` 自动刷新无需处理；注册文件监听（防抖 800 ms）与命令（Task 8 提供 `registerCommands(service, treeProvider?)`）；`deactivate` dispose。

**Tests:** 无单测（依赖 vscode API），由 Lead 的 smoke harness 覆盖 `activate()` 不抛错、命令/Provider 注册数量。

**Verify:** `npx tsc -p .`；`node test/smoke-activate.js`（Lead 提供；若尚未存在，先跳过，Task 9 补）。
**Commit:** `feat: vscode index service and language providers`

---

### Task 8: 侧边栏树 + 命令 + 状态栏 + QuickPick（B）

**Files:** Create `src/vscode/views/symbols-tree.ts`, `src/vscode/commands.ts`, `src/vscode/status.ts`, `src/vscode/quickpick.ts`；Modify `src/vscode/extension.ts` 注册它们。

**Interfaces:** Consumes `SymbolService`；Produces `registerCommands(context, service): vscode.Disposable`、`SymbolsTreeProvider`、`createStatusBar(context, service)`。

**Behavior:**
- `si.symbols` TreeView：根 = service 配置的 roots（相对路径）；目录节点懒展开（`fs.readdir`）；文件节点 `collapsibleState=Collapsed`；文件内函数节点 label=`name`，description=`signature 摘要`（截断 60 字符），icon `$(symbol-method)`；`getTreeItem` vsCode 元素 `command: {command:'si.openSymbolAt', arguments:[file,line,column]}`；视图欢迎页（`viewsWelcome`）在 `service.ready===false` 时显示「配置索引目录」按钮。
- `commands.ts` 实现 spec §7.1 全部命令：
  - `si.configureRoots`：`showQuickPick(canPickMany)` 列出 workspace 一级目录（`fs.readdir(workspaceRoot,{withFileTypes:true})` 过滤目录、隐藏 `.git`）+ 「浏览…」；选中写入 `workspace.getConfiguration('sourceInsight').update('indexRoots', selected, Workspace)`；随后询问是否立即重建（`showInformationMessage` 是/否）。
  - `si.rebuildIndex`：`withProgress` + `service.rebuild`，完成后 `showInformationMessage` 输出 summary（文件/符号/耗时）。
  - `si.searchSymbol`：`quickpick.ts` 的 `showSymbolQuickPick(service)`——输入即搜（120 ms 防抖）、`MatchOnDescription=true`、`description=file:line`、`detail=signature`；接受后 `openSymbolAt`。
  - `si.gotoDefinition`/`si.findReferences`：取当前编辑器单词，调用 `vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, position)` 等价逻辑（直接查 service 更简单：跳转用定义列表，多候选 `showQuickPick`）。
  - `si.showCallers`/`si.showCallees`：`vscode.commands.executeCommand('vscode.showCallHierarchy')` 需要光标在调用处；更可靠：取单词后自建 CallHierarchyItem 并以 `vscode.commands.executeCommand('vscode.callHierarchy.show')`？——**采用简单可靠实现**：走 service 查询，结果用 QuickPick 列表跳转（与 `si.searchSymbol` 同 UI），命令名仍为 showCallers/showCallees；`enableCallHierarchy` 时同时注册原生 Provider 供右键使用。
  - `si.openSymbolAt`：`window.showTextDocument(uri, {selection: new Range(pos,pos), preview:false})`。
  - `si.clearCache`：删除快照文件 + 清空内存索引。
- `status.ts`：`StatusBarItem` 右对齐、优先级 100；未配置 → `$(info) SI: 未配置索引`；构建中 → `$(sync~spin) SI: 索引中 45%`；完成 → `$(symbol-function) SI: 123456 函数`；`command` 分别指向 configure/rebuild。
- 所有字符串 `vscode.l10n.t('...')`。

**Tests:** 无单测；smoke harness 断言命令全部注册。
**Verify:** `npx tsc -p .` + smoke。
**Commit:** `feat: symbols tree, commands and status bar`

---

### Task 9: 集成、冒烟、打包与真实仓库压测（Lead）

**Files:** Create `test/smoke-activate.js`, `scripts/perf-build.js`, `README.md`, `CHANGELOG.md`, `LICENSE`, `resources/icon.svg|png`, `l10n/bundle.l10n*.json`；Modify `package.json`（`contributes` 最终版）。

**Steps:**
- [ ] `test/smoke-activate.js`：`Module._load` 拦截 `vscode` 返回内存 mock（`commands.registerCommand`、`languages.register*Provider`、`window.createTreeView`、`window.createStatusBarItem`、`workspace.getConfiguration`、`l10n.t`、`Uri`、`EventEmitter`、`Range/Position/Location/SymbolInformation/MarkdownString` 等最小实现），`require('../dist/src/vscode/extension.js').activate(ctx)`，断言：命令数、Provider 数、`dispose` 不抛。
- [ ] `scripts/perf-build.js`：对参数目录跑 `buildIndex` + `saveSnapshot`，打印文件数/符号数/耗时/快照 MB/内存 RSS。
- [ ] `resources/icon.svg` + 生成 `resources/icon.png`（PIL 可用）。
- [ ] `package.nls.json` / `package.nls.zh-cn.json`：displayName、description、命令标题、配置项描述、视图标题、欢迎页文案。
- [ ] `README.md`：功能、安装（`code --install-extension source-insight-c-0.1.0.vsix`）、首次使用（配置索引目录）、配置说明、自测清单、已知限制。
- [ ] 全量验证：`npm test`、`npm run smoke`、`npx vsce package --no-dependencies`，`unzip -l` 校验 vsix 内容。
- [ ] 真实仓库压测：对 `component` + `plat` 跑 perf-build，记录数据到 README。
- [ ] `git add -A && git commit`。

---

## Self-Review

- 覆盖检查：spec §1 A–F → Task 3/5/6（core）+ Task 7/8（UI）；§6 索引 → Task 2/3/4；§7 配置/命令/视图 → Task 7/8；§9 测试交付 → Task 9；§11 风险对应实现（worker 退化、快照容错、默认不索引）。
- 占位符检查：无 TBD；每个任务含测试用例与验收命令。
- 类型一致性：`SymbolEntry`/`ReferenceHit`/`CallerHit`/`BuildSummary` 在 Task 4/5/6/7 中用法一致；`buildIndex` 的 `snapshotPath` 选项已在 Task 4 明确。
