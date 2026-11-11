# Source Insight C — VS Code 扩展设计

日期：2026-11-09
状态：已批准（用户确认全部功能 A–F，索引目录手动配置，VS Code ≥ 1.90）

## 1. 目标

把 Source Insight 的核心体验搬进 VS Code，面向十几万文件级的大型嵌入式 C 工程（实测 12.1 万 C/H 文件、2.6 GB、108 万函数定义），不依赖编译数据库、clangd 或任何外部工具：

1. **A 跳转定义**：F12 / Ctrl+Click 从调用点跳到函数定义（无定义时跳头文件原型）。
2. **B 函数搜索**：按名字模糊搜索全工程函数（Ctrl+T / 命令面板），显示签名与位置，回车跳转。
3. **C 查找引用**：Shift+F12 列出函数被调用/引用的所有位置。
4. **D 调用关系**：原生 Call Hierarchy（被调用者 / 调用者，可逐层展开）。
5. **E 侧边栏符号窗口**：Activity Bar 新增容器，树形「目录 → 文件 → 函数（签名）」懒加载，可过滤。
6. **F 悬停 + 大纲**：悬停显示函数签名与定义/声明位置；Ctrl+Shift+O 大纲列出当前文件函数。

非目标（v1 不做）：结构体/枚举/变量/宏的完整语义索引、跨工程持久共享索引、预处理器条件分支求值、语义级重载解析。

## 2. 关键决策

| 决策 | 结论 | 理由 |
|---|---|---|
| 平台 | VS Code 扩展（`engines: ^1.90.0`） | 用户指定 |
| 解析引擎 | 自研字节级 C 词法 + 启发式定义识别，零外部依赖 | 离线、可单测、不受编译配置影响；实测全量 157 s 单线程，可并行 |
| 索引范围 | **默认空**，用户用命令「配置索引目录」手动选择；`exclude` 默认跳过 `.git/build/tmp/node_modules` | 用户选择「全部手动配置」 |
| 索引形式 | 内存符号表 + 二进制快照（globalStorage） | 1M 符号 ≈ 20–30 MB，加载 <300 ms |
| 引用/调用图 | 按需扫描（文件名预筛 + 内容预筛），结果按查询名缓存 | 避免常驻巨型倒排索引 |
| 调用关系 UI | 原生 `CallHierarchyProvider` | 复用 VS Code 成熟 UI，不重复造轮子 |
| 符号搜索 UI | 原生 `WorkspaceSymbolProvider`（Ctrl+T）+ QuickPick 命令 | 两种入口，符合 VS Code 习惯 |
| 工程位置 | `tools/vscode-source-insight/`（独立 git 仓库，不改动固件仓库文件） | 不污染固件仓库 |
| 语言 | TypeScript → CommonJS → `dist/` | 接口可被编译器校验，团队并行开发 |

## 3. 架构

```
扩展宿主 (Node, TypeScript)                                VS Code UI 层
┌──────────────────────────────────────────┐   ┌─────────────────────────────────┐
│ src/core/  纯逻辑（禁止 import 'vscode'）   │   │ src/vscode/providers/           │
│  exclude.ts   glob 排除匹配               │   │  definition.ts    F12           │
│  walk.ts      目录遍历 + 文件清单           │   │  references.ts    Shift+F12     │
│  scan.ts      C 解析：函数/声明/宏           │   │  hover.ts         悬停签名        │
│  store.ts     二进制快照 + 增量            │   │  document-symbol.ts 大纲          │
│  worker-scan.ts  worker 入口              │   │  workspace-symbol.ts Ctrl+T      │
│  indexer.ts   worker 池 + 进度 + 取消      │   │  call-hierarchy.ts 调用层次        │
│  query.ts     搜索 / 按名查找 / 排序        │   ├─────────────────────────────────┤
│  signature.ts 签名重建（多行、去注释）       │   │ src/vscode/views/symbols-tree.ts │
│  references.ts 引用扫描                    │   │ src/vscode/commands.ts           │
│  callgraph.ts callers/callees             │   │ src/vscode/service.ts  索引服务    │
└──────────────────────────────────────────┘   │ src/vscode/extension.ts 激活入口    │
                                                └─────────────────────────────────┘
                          src/shared/types.ts  两侧共享的唯一类型契约
```

`core/` 不依赖 VS Code API，因此可用 `node:test` 直接测；`vscode/` 只做协议转换与 UI。

## 4. 数据模型（src/shared/types.ts）

```ts
export type SymbolKind = 'function' | 'declaration' | 'macro'
export interface SymbolEntry {
  name: string        // 函数名
  kind: SymbolKind
  file: string        // 相对 workspace 根的 posix 路径
  line: number        // 0-based 定义首行（函数名所在行）
  endLine: number     // 0-based 函数体结束行；声明/宏等于 line
  column: number      // 0-based 名字起始列
}
export interface FileRecord { path: string; mtimeMs: number; size: number }
export interface IndexSnapshot {
  version: number; roots: string[]; builtAt: number
  files: FileRecord[]; entries: SymbolEntry[]
}
```

快照二进制布局（`store.ts`，小端）：

```
magic  "SIDX" (4B) | version u32 | builtAt u32 | fileCount u32 | entryCount u32
rootsLen u32 | rootsJson utf8
string table: count u32, 每个 [len u32, utf8 bytes]
files: [stringId u32, mtimeMs f64, size u32] × fileCount
entries: [nameId u32, fileIdx u32, line u32, endLine u32, col u16, kind u8, pad u8] × entryCount
```

`entries` 按 `(fileIdx, line)` 排序，便于按文件过滤与二分。

## 5. 解析算法（scan.ts）

输入：文件原始字节（`latin1` 解码，保证 1 字节 = 1 字符、行列号稳定）。输出：`ScannedSymbol[]`。

1. **词法剥离**：单遍状态机，把 `/* */`、`//`、字符串 `"..."`、字符 `'...'` 的内容替换为空格（保留换行以维持行号），支持反斜杠续行。
2. **深度 0 定义识别**：跟踪 `{}` 深度（忽略字符串/注释内）。在深度 0，遇到 `IDENT (` 且其前一个有效记号属于「类型/修饰符/指针/`*`」序列（排除 `if/for/while/switch/return/sizeof/else/do`、`=`、`,`、`.`、`->`、`(` 等），则：
   - 括号平衡匹配到 `)`；
   - 跳过空白与 `__attribute__((...))`、`__asm__(...)` 等属性宏；
   - 下一个非空字符是 `{` → **函数定义**，`endLine` = 配对 `}` 所在行；是 `;` → **声明**（kind=declaration）。函数体内容不索引。
3. **函数式宏**：`#define NAME(`（`NAME` 紧跟左括号，中间无空格）→ kind=macro，`endLine` = 反斜杠续行的最后一行。
4. **多行签名**：名称所在行记为 `line`，括号平衡跨行天然支持。
5. 过滤误报：名字为 C 关键字（`if/for/...`）、出现在 `#` 预处理行上、或名字在 `sizeof(`/`__attribute__((` 之后的，丢弃。

已知局限（文档化）：宏展开生成的函数、K&R 老式参数表、函数指针赋值的极端写法可能漏识别；声明索引可兜底。

## 6. 索引服务

### 6.1 构建（indexer.ts）
- `walk.ts` 按 `roots` 遍历，应用 `exclude`（默认 `**/.git/**`、`**/build/**`、`**/tmp/**`、`**/node_modules/**`，用户可改），只收 `.c .h .cc .cpp .hpp .hh .inl`，跳过 >`maxFileSizeKB` 文件与符号链接（可配置跟随）。
- 文件清单与旧快照按 `mtimeMs + size` 比对，只重解析变更/新增文件；删除文件从索引移除。
- 解析并行：`worker_threads` 池（默认 `min(4, cpus)`），worker 执行 `scanSource`，主线程合并；worker 不可用时退化单线程。
- 进度：`onProgress({phase:'walk'|'parse'|'save', done, total, currentFile})`；支持 `AbortSignal` 取消。
- 完成：写快照，返回 `BuildSummary { files, entries, added, updated, removed, durationMs, snapshotBytes }`。

### 6.2 查询（query.ts）
- `searchSymbols(snapshot, query, limit)`：大小写不敏感的子串匹配；排序权重：完全相等 > 前缀 > 驼峰/下划线子词 > 子串；同权重按名字长度、`kind`（function 优先）、路径排序。返回 `SymbolEntry[]`。
- `findByName(snapshot, name)`：精确名查找，返回定义在前、声明在后。
- `entriesInFile(snapshot, file)`：按文件取符号，供大纲/树视图。
- 复杂度：全表扫描 + 线性过滤，1M 条 <100 ms；搜索框侧加 120 ms 防抖。

### 6.3 引用与调用图（references.ts / callgraph.ts）
- `findReferences(snapshot, name, readFile, opts)`：
  1. 候选文件 = 内容含 `name` 的文件（并发读、`Buffer.indexOf` 预筛，命中才做精确 `\bname\b` 定位）；
  2. 精确行/列用词法剥离后的等价文本定位（避免注释/字符串误报）；
  3. 排除 `name` 自己的定义/声明行；
  4. 返回 `ReferenceHit { file, line, column, preview }`，按文件排序，支持 `AbortSignal` 与进度回调；结果按 `name` 缓存在内存（LRU ≤64 项）。
- `callersOf(snapshot, name, ...)`：引用扫描后，把每个命中位置归到「包含该行的函数区间」；命中在多个文件同名函数时按文件定位。
- `calleesOf(snapshot, name, readFile)`：读取定义文件，截取 `[line, endLine]` 函数体，词法剥离后匹配 `IDENT(`，去掉关键字/宏定义自身，`findByName` 解析为 `SymbolEntry[]`（去重、保持出现顺序）。

### 6.4 签名与悬停（signature.ts）
- `readSignature(readFile, entry)`：从 `entry.line` 起读，拼接直到括号平衡后的 `{`/`;`（最多 20 行），去注释、压缩空白 → 单行签名，例如 `static int foo(const char *name, u32 flags)`。
- Hover 内容：代码块（ts/c）+ `定义: 路径:行` + 若有声明追加 `声明: 路径:行` + 简短操作提示（F12 / Shift+F12）。

## 7. VS Code 集成

### 7.1 激活与命令
`activationEvents`：`onLanguage:c`、`onLanguage:cpp`、`onView:si.symbols`、全部 `onCommand:*`。
命令（id 前缀 `si.`）：

| 命令 | 说明 |
|---|---|
| `si.configureRoots` | 多选目录（QuickPick 列出 workspace 一级/二级目录 + 浏览按钮）写入 `indexRoots` |
| `si.rebuildIndex` | 重建索引（带进度、可取消） |
| `si.searchSymbol` | QuickPick 搜索函数并跳转 |
| `si.gotoDefinition` | 当前光标位置跳定义 |
| `si.findReferences` | 当前光标位置查找引用 |
| `si.showCallers` / `si.showCallees` | 原生调用层次入口 |
| `si.openSymbolAt` | 内部：由树/QuickPick 打开位置 |
| `si.clearCache` | 清空索引与缓存 |

### 7.2 Provider 行为
- `DefinitionProvider`：取光标处单词（`\w+`，允许 `->`/`.` 后成员与函数指针）→ `findByName`；无定义返回声明；多候选全部返回（VS Code 原生选择列表）。
- `ReferenceProvider`：`findReferences`，`includeDeclaration=false`（声明由定义提供）；首次扫描显示 `withProgress`，结果缓存。
- `WorkspaceSymbolProvider`：`searchSymbols` 上限 `searchLimit`（默认 200），返回 `SymbolInformation`（容器名 = 目录）。
- `DocumentSymbolProvider`：`entriesInFile` → `DocumentSymbol`（函数用 `SymbolKind.Function`）。
- `HoverProvider`：`readSignature` + 位置。
- `CallHierarchyProvider`：`prepareCallHierarchy` 用定义项；`provideCallHierarchyIncomingCalls` = `callersOf`；`OutgoingCalls` = `calleesOf`。用 `document.uri` + `Position` 构造。

### 7.3 侧边栏
`contributes.viewsContainers.activitybar`：id `sourceInsight`，图标 `resources/icon.svg`。
`contributes.views.sourceInsight`：`si.symbols`（TreeView，`si-tree`）。
- 根节点 = 已索引根目录；子节点按目录/文件懒加载；文件节点显示索引内函数（名称 + 签名摘要）。
- 视图标题栏按钮：搜索、重建索引、配置目录。
- `TreeDataProvider` 用 `getChildren(element)` 按需计算；文件节点上限 `searchLimit` 条并提示「还有 N 个…」。
- 未配置索引：`viewsWelcome` 显示说明 + 「配置索引目录」按钮。

### 7.4 状态栏
右侧 item：`$(symbol-function) SI 索引: 12.3 万函数` / `索引中 45%` / `未配置`；点击 → `si.rebuildIndex` 或 `si.configureRoots`。

### 7.5 配置项（contributes.configuration）
| 键 | 类型 | 默认 |
|---|---|---|
| `sourceInsight.indexRoots` | string[] | `[]` |
| `sourceInsight.exclude` | string[] | `["**/.git/**","**/build/**","**/tmp/**","**/node_modules/**"]` |
| `sourceInsight.maxFileSizeKB` | number | 4096 |
| `sourceInsight.concurrency` | number | 4 |
| `sourceInsight.searchLimit` | number | 200 |
| `sourceInsight.autoReindexOnSave` | boolean | true |
| `sourceInsight.enableCallHierarchy` | boolean | true |
| `sourceInsight.followSymlinks` | boolean | false |

配置变更：`indexRoots/exclude/maxFileSizeKB` 变化 → 提示重建；其余实时生效。

### 7.6 文件监听
`workspace.createFileSystemWatcher` 监听 `**/*.{c,h,cc,cpp,hpp,hh,inl}`；create/change 防抖 800 ms 入队重解析；delete 从索引移除；索引构建期间事件排队，构建结束后统一处理。

## 8. 错误处理

- 未配置索引：不报错，状态栏「未配置」，视图欢迎页引导。
- 文件读/解析失败：计入 `BuildSummary.skipped`，输出面板 `Source Insight` 通道记录前 50 条。
- worker 崩溃：捕获 `error` 事件，重试一次后退化单线程，日志告警。
- 快照损坏/版本不符：删除后全量重建，不弹错误。
- 搜索/引用期间取消：`CancellationToken` → `AbortSignal`，安静结束。
- 解析编码：字节级 latin1 解析；展示用 `TextDecoder('utf-8', {fatal:false})` 兜底。
- 大仓库保护：符号数 > 500 万时状态栏提示并建议缩小 `indexRoots`。

## 9. 性能目标

| 场景 | 目标 | 实测基线（原型） |
|---|---|---|
| 建索引 5.9 万文件（排除内核） | ≤ 40 s（4 worker） | 单线程 157 s / 12.1 万文件 |
| 快照加载 | < 500 ms | — |
| 符号搜索（1M 条） | < 100 ms | — |
| 单文件增量重解析 | < 50 ms | — |
| 引用扫描（1.3 GB） | < 3 s，可取消 | — |
| 快照体积 | ≤ 30 MB / 100 万符号 | — |

## 10. 测试与交付

- `node:test` 单测（编译后 `node --test dist/test`）：
  - `parser.test.ts`：多行签名、注释/字符串干扰、`#define` 续行、函数指针参数、`__attribute__`、K&R、嵌套括号、声明与定义区分、误报排除。
  - `walk-exclude.test.ts`：glob 匹配、根目录、大小上限、符号链接。
  - `store.test.ts`：二进制 roundtrip、增量替换、损坏快照容错、版本不符。
  - `query.test.ts`：排序权重、大小写、limit。
  - `refs-callgraph.test.ts`：引用预筛精确性、注释内不误报、callers 区间归属、callees 顺序去重。
  - `integration-smoke.js`（Lead）：mock `vscode` 模块，`require('dist/vscode/extension.js')` 并 `activate()`，断言命令/Provider 注册齐全、无异常。
- 真实仓库压测脚本 `scripts/perf-build.js`：对配置的目录建索引，输出文件数/符号数/耗时/快照体积。
- 打包：`npx @vscode/vsce package` → `source-insight-c-0.1.0.vsix`；校验 vsix 内文件清单。
- 本机无 `code` CLI：界面交互由用户在真实 VS Code 安装 vsix 后按 README 清单验收；本仓库交付单测 + 压测数据 + vsix。

## 11. 风险

| 风险 | 缓解 |
|---|---|
| 启发式解析漏函数 | 声明索引兜底 + 单测夹具 + 后续可插 ctags（`SymbolSource` 接口） |
| 超大仓库内存 | 默认不索引、符号表紧凑数组、`>500 万符号`告警 |
| 引用扫描慢 | 内容预筛 + 并发 + 结果缓存 + 可取消 + withProgress |
| 无 VS Code 环境验证 | mock harness 激活冒烟测试 + 用户自测清单 |

## 12. 目录结构

```
tools/vscode-source-insight/
├─ package.json  package.nls.json  package.nls.zh-cn.json
├─ tsconfig.json  .vscodeignore  .gitignore  LICENSE  README.md  CHANGELOG.md
├─ resources/icon.svg  resources/icon.png
├─ l10n/bundle.l10n.json  l10n/bundle.l10n.zh-cn.json
├─ src/shared/types.ts
├─ src/core/{exclude,walk,scan,store,worker-scan,indexer,query,signature,references,callgraph}.ts
├─ src/vscode/{extension,service,config,commands,status,quickpick}.ts
├─ src/vscode/providers/{definition,references,hover,document-symbol,workspace-symbol,call-hierarchy}.ts
├─ src/vscode/views/symbols-tree.ts
├─ test/{parser,walk-exclude,store,query,refs-callgraph}.test.ts
├─ test/smoke-activate.js
└─ scripts/perf-build.js
```
