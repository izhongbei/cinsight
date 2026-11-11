# Code Insight

> Code navigation for large C/C++ codebases: an independent, persistent and incrementally updated function symbol index — no `compile_commands.json`, no clangd, no external tools.

On codebases with more than a hundred thousand C/H files (measured on **121,606 files / 2.6 GB / 1.08 M function definitions**), IntelliSense-style indexing is slow and often incomplete because of complex build configurations. Code Insight parses the sources itself and keeps its own symbol database, so go-to-definition, symbol search and find-references answer from the local index in milliseconds.

[中文说明](#中文说明) · [GitHub](https://github.com/izhongbei/cinsight)

## Features

| Feature | How to use |
|---|---|
| **Go to definition** | `F12` / `Ctrl+Click` on a call; falls back to the header prototype when no definition exists |
| **Symbol search** | `Ctrl+T` (native *Go to Symbol in Workspace*) or `Code Insight: Search Function` (lists signature and location) |
| **Find references** | `Shift+F12`; progress, cancellable, results cached |
| **Call hierarchy** | `Code Insight: Show Callers / Show Callees`, plus the native VS Code call hierarchy view |
| **Symbol tree** | The **Code Insight** icon in the Activity Bar: folders → files → functions (with signature), loaded on demand |
| **Hover signature** | Hover a function name to see `return type name(params)` and its definition/declaration location |
| **Document outline** | `Ctrl+Shift+O` lists the functions of the current file |
| **Index management** | Status bar shows index state and function count; commands to configure roots, rebuild, clear cache |

## Installation

From **Open VSX** (works in VS Code, Cursor, VSCodium, …):

```bash
code   --install-extension cinsight.code-insight
cursor --install-extension cinsight.code-insight
```

Or search for **Code Insight** in the Extensions view.

Offline install: download `code-insight-0.1.0.vsix` and run

```bash
code   --install-extension code-insight-0.1.0.vsix
cursor --install-extension code-insight-0.1.0.vsix
# or: Ctrl+Shift+P → Extensions: Install from VSIX...
```

Requires a host with **VS Code ≥ 1.90** (Cursor 3.x qualifies). No C/C++ extension is required — the built-in C/C++ grammar already provides the language id.

## Getting started

1. Open your C project folder (`File → Open Folder`).
2. Run **`Code Insight: Configure Index Roots`** and pick the directories to index (e.g. `component`, `plat`, `plugin`).
3. Confirm the rebuild; the status bar shows progress, then `$(symbol-function) <count> functions`.
4. Open any `.c` file, put the cursor on a function call and press `F12`.

> Nothing is indexed by default — you choose explicitly, so kernel copies, vendor libraries and build output stay out. `.git`, `build`, `tmp` and `node_modules` are excluded by default.

## Commands

| Command | ID |
|---|---|
| Configure Index Roots | `si.configureRoots` |
| Rebuild Index | `si.rebuildIndex` |
| Search Function | `si.searchSymbol` |
| Go to Definition | `si.gotoDefinition` |
| Find References | `si.findReferences` |
| Show Callers | `si.showCallers` |
| Show Callees | `si.showCallees` |
| Clear Index Cache | `si.clearCache` |

The editor context menu offers go-to-definition, find-references and callers/callees in C/C++ files; the view title bar offers search, rebuild and configure.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `sourceInsight.indexRoots` | `[]` | Directories to index (workspace-relative); empty = nothing indexed |
| `sourceInsight.exclude` | `["**/.git/**","**/build/**","**/tmp/**","**/node_modules/**"]` | Excluded globs (`*`, `**`, `?`) |
| `sourceInsight.maxFileSizeKB` | `4096` | Skip source files larger than this |
| `sourceInsight.concurrency` | `4` | Worker threads used while building the index |
| `sourceInsight.searchLimit` | `200` | Maximum results per search |
| `sourceInsight.autoReindexOnSave` | `true` | Re-parse a file when it is saved, created or deleted |
| `sourceInsight.enableCallHierarchy` | `true` | Also register the native call hierarchy provider |
| `sourceInsight.followSymlinks` | `false` | Follow symbolic links while walking roots |

After changing `indexRoots` / `exclude` / `maxFileSizeKB`, run **Rebuild Index** (the extension prompts you).

## How it works

```
sources ──walk──> file list ──mtime+size delta──> changed files
                                                     │
                              worker_threads ×N ─────┤ lexing + definition detection
                                                     ▼
                        compact symbol table (definitions / prototypes / function-like macros)
                                                     │
                                       binary snapshot symbols.sidx (extension storage)
                                                     ▼
                    definition / references / hover / outline / workspace symbols / call hierarchy
```

- The parser works on bytes so line and column numbers stay stable. A single-pass state machine blanks comments, string literals and `#define` continuations, then detects definitions and declarations at file scope ("type + name + balanced parentheses + `{`/`;`") and matches braces to get each function body range.
- The snapshot is a binary format (string table + compact integer arrays), roughly **20–30 MB per million symbols**, loaded in under 500 ms; unchanged files reuse their previous symbols.
- References and call relationships are scanned on demand: content prefilter first, then exact word-boundary matching; callers are derived from the line hit, callees only parse the target function body.
- No third-party runtime dependency; fully offline.

## Performance

Measured on a module set of **6,838 C/H files / 75 MB**:

| Metric | Result |
|---|---|
| Symbols | 98,930 |
| Index build (4 workers, cold cache) | 6.5 s |
| Snapshot size / load | 3.87 MB / 28 ms |
| Symbol search (limit 50) | 11 ms |
| Exact name lookup | 8 ms |
| Signature reconstruction (first read) | 56 ms |
| Find references (first call, full scan of 75 MB) | 4.2 s (cached afterwards: 0 ms) |
| Callers / callees | 14 ms / 13 ms |
| Process memory (including index build) | ~335 MB |

- Indexing `plat` alone (5,573 files / 57.5 MB): 74,194 symbols, 0.8–1.2 s with a warm cache, 0.5 s for an unchanged incremental rebuild.
- A single-threaded scan of all 121,606 files (2.6 GB) takes ~157 s; configure `indexRoots` per module so you only index what you actually browse.

> Find-references and call relationships scan file contents on demand: a content prefilter decides which files get lexed. On slow network drives the first search over a big root can take a while, but it reports progress, can be cancelled and caches its results.

## Known limitations

- Heuristic parsing, not a full C front end: functions produced by macro expansion, old K&R parameter lists and unusual function-pointer forms may be missed (header prototypes still let you jump).
- Only functions, function prototypes and function-like macros are indexed; struct/enum/variable navigation is out of scope for now.
- No preprocessor branch evaluation: definitions of the same name in different `#if` branches all appear as candidates (pick one in the native list).
- Reference scanning is textual (with comment/string stripping), not semantic; same-named but unrelated symbols match too; first searches on huge roots are bound by disk throughput.
- Single-root workspaces only (the first workspace folder); `indexRoots` must be workspace-relative.
- Requires the C/C++ language id (`.c`/`.h` opened as `c`/`cpp`, which the built-in grammar provides).

## Privacy and security

- **Runs entirely locally**: no network access, no telemetry, no data collection.
- Reads only the C/C++ sources under `sourceInsight.indexRoots`; the symbol snapshot is written to the extension's own storage.
- Never executes the indexed code and never invokes external tools (no ctags / clangd / `compile_commands.json`).
- Never modifies workspace files: sources are read-only for this extension.

## Feedback

Please open an issue at <https://github.com/izhongbei/cinsight/issues>.

## License

MIT

---

# 中文说明

> 面向大型 C/C++ 工程的代码导航扩展：自建**独立、持久、可增量更新**的函数符号索引，不依赖编译数据库、clangd 或任何外部工具。

十几万文件级的仓库（实测 **121,606 个 C/H 文件、2.6 GB、108 万个函数定义**）往往编译配置复杂、工程庞大，靠 IntelliSense 建索引慢且经常不完整。Code Insight 自己解析源码并维护符号库，跳转、搜索、引用都走本地索引，毫秒级响应。

## 功能

| 功能 | 入口 |
|---|---|
| **跳转定义** | 光标在函数调用处按 `F12` / `Ctrl+Click`；无定义时回退到头文件原型声明 |
| **函数搜索** | `Ctrl+T`（原生"转到工作区中的符号"）或命令 `Code Insight: 搜索函数`（列出签名与位置） |
| **查找所有引用** | `Shift+F12`；带进度、可取消，结果缓存 |
| **调用关系** | 命令 `Code Insight: 显示调用者 / 显示被调用者`，也可用 VS Code 原生调用层次界面逐层展开 |
| **侧边栏符号窗口** | 左侧活动栏的「Code Insight」图标 → 目录 → 文件 → 函数（带签名摘要），按需加载 |
| **悬停签名** | 悬停函数名显示 `返回类型 函数名(参数)` 与定义/声明位置 |
| **文档大纲** | `Ctrl+Shift+O` 列出当前文件函数 |
| **索引管理** | 状态栏显示索引状态与函数数量；命令：配置索引目录、重建索引、清除缓存 |

## 安装

从 **Open VSX** 安装（VS Code、Cursor、VSCodium 等均适用）：

```bash
code   --install-extension cinsight.code-insight
cursor --install-extension cinsight.code-insight
```

或在扩展面板搜索 **Code Insight** 后安装。

离线安装：下载 `code-insight-0.1.0.vsix` 后执行

```bash
code   --install-extension code-insight-0.1.0.vsix
cursor --install-extension code-insight-0.1.0.vsix
```

要求宿主 **VS Code ≥ 1.90**（Cursor 3.x 满足），无需另装 C/C++ 扩展。

## 首次使用

1. 打开你的 C 工程目录（`File → Open Folder`）。
2. 命令面板执行 **`Code Insight: 配置索引目录`**，勾选要索引的目录（例如 `component`、`plat`、`plugin`）。
3. 确认重建，状态栏显示进度，完成后显示 `$(symbol-function) <符号数> 个函数`。
4. 打开任意 `.c` 文件，光标放到函数调用上按 `F12`。

> 默认**不索引任何目录**，由你显式选择，避免误索引内核副本、第三方库和构建产物。默认排除 `.git`、`build`、`tmp`、`node_modules`。

## 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `sourceInsight.indexRoots` | `[]` | 要索引的目录（相对 workspace 根），空 = 不索引 |
| `sourceInsight.exclude` | `["**/.git/**","**/build/**","**/tmp/**","**/node_modules/**"]` | 排除的 glob（`*` / `**` / `?`） |
| `sourceInsight.maxFileSizeKB` | `4096` | 超过该大小的源文件跳过 |
| `sourceInsight.concurrency` | `4` | 建索引的 worker 线程数 |
| `sourceInsight.searchLimit` | `200` | 单次搜索返回上限 |
| `sourceInsight.autoReindexOnSave` | `true` | 保存/新建/删除文件时增量重解析 |
| `sourceInsight.enableCallHierarchy` | `true` | 注册原生调用层次 Provider |
| `sourceInsight.followSymlinks` | `false` | 是否跟随符号链接 |

修改 `indexRoots` / `exclude` / `maxFileSizeKB` 后建议执行一次 **重建索引**。

## 工作原理

- 解析器按字节工作，行号列号稳定；单遍状态机剥离注释、字符串、`#define` 续行，在文件作用域按"类型 + 名字 + 平衡括号 + `{`/`;`"判定定义与声明，并做花括号配对得到函数体范围。
- 快照为二进制格式，约 **20–30 MB / 100 万符号**，加载 < 500 ms；未变化的文件直接复用旧符号。
- 引用与调用关系按需扫描：先用文件内容预筛，再按词边界精确匹配。
- 无第三方运行时依赖，离线可用。

## 性能

对 **6,838 个 C/H 文件 / 75 MB** 的模块集合实测：符号 98,930；建索引 6.5 s（4 worker，冷缓存）；快照 3.87 MB / 加载 28 ms；函数搜索 11 ms；按名查找 8 ms；签名重建 56 ms；查找引用首次 4.2 s（缓存后 0 ms）；调用者/被调用者 14 ms / 13 ms；进程内存约 335 MB。

## 已知限制

- 启发式解析：宏展开生成的函数、K&R 老式参数表、极端函数指针写法可能漏识别（头文件原型可兜底跳转）。
- 只索引函数、函数原型与函数式宏；结构体/枚举/变量跳转不在当前范围。
- 不做预处理分支求值，同一名字在多个 `#if` 分支的定义都会出现在候选里。
- 引用扫描是文本级（已剥离注释/字符串），不是语义级；首次在大仓库上受磁盘吞吐限制。
- 只支持单根工作区（取第一个 workspace folder）；`indexRoots` 必须是工作区内相对路径。

## 隐私与安全

- **纯本地运行**：不联网、不上报数据、不收集遥测。
- 只读取 `sourceInsight.indexRoots` 内的 C/C++ 源码，快照写入扩展自己的存储目录。
- 不执行被索引的代码，不调用外部工具（不依赖 ctags / clangd / compile_commands.json）。
- 不修改工作区文件。

## 反馈

问题与建议请提交到 <https://github.com/izhongbei/cinsight/issues>。

## License

MIT
