# Code Insight

> Code navigation for large C/C++ codebases: an independent, persistent and incrementally updated function symbol index — no `compile_commands.json`, no clangd, no external tools.

On codebases with more than a hundred thousand C/H files (measured on **121,606 files / 2.6 GB / 1.08 M function definitions**), IntelliSense-style indexing is slow and often incomplete because of complex build configurations. Code Insight parses the sources itself and keeps its own symbol database, so go-to-definition, symbol search and find-references answer from the local index in milliseconds.

[中文说明](#中文说明) · [GitHub](https://github.com/izhongbei/cinsight)

## Features

| Feature | How to use |
|---|---|
| **Go to definition** | `F12` / `Ctrl+Click` on a call or a type name; falls back to the header prototype / forward declaration when no definition exists |
| **Type navigation** | `struct` / `union` / `enum` tags and `typedef` names (anonymous structs and function-pointer typedefs included) are indexed like functions |
| **Smart candidate order** | When a name has many definitions (multiple kernel/driver copies), `F12` / hover / call hierarchy list the one closest to your cursor first (same index root, then shared path prefix) |
| **Include-aware jump** | Definitions reachable from the current file through the resolved `#include` graph are listed first — a **soft** ordering: candidates are reordered, never dropped |
| **Duplicate folding** | Files with identical content (same 64-bit content hash) plus the same name and kind are folded into one `F12` location; `Show Definition Candidates` expands every copy |
| **Conditional annotations** | Symbols inside `#if` / `#ifdef` / `#ifndef` blocks show the raw condition text in candidates, hover and list details (the text is not evaluated; conventional file-level include guards are transparent) |
| **Symbol search** | `Ctrl+T` (native *Go to Symbol in Workspace*) or `Code Insight: Search Function` (lists signature and location) |
| **Find references** | `Shift+F12`; progress, cancellable, results cached |
| **Call hierarchy** | `Code Insight: Show Callers / Show Callees`, plus the native VS Code call hierarchy view |
| **Call graph panel** | `Code Insight: Show Call Graph` opens a Source-Insight-style relation panel: the current function in the middle, **callers on the left, callees on the right**, expandable node by node, click a name to jump |
| **Symbol tree** | The **Code Insight** icon in the Activity Bar: folders → files → functions (with signature), loaded on demand |
| **Hover signature** | Hover a function name to see `return type name(params)` and its definition/declaration location |
| **Document outline** | `Ctrl+Shift+O` lists the functions of the current file |
| **Index diagnostics** | `Code Insight: Show Index Diagnostics` opens a Markdown report with base/delta sizes, pending changes, per-kind symbol counts, the last build summary, budget status and memory |
| **Index management** | Status bar shows index state and function count; commands to configure roots, rebuild, clear cache |

## Installation

From [Open VSX](https://open-vsx.org/extension/cinsight/code-insight) (Cursor, VSCodium and VS Code all work):

```bash
cursor --install-extension cinsight.code-insight
code   --install-extension cinsight.code-insight
```

VS Code users can also install from the Marketplace (same code; the ID differs because the Marketplace requires globally unique extension name and display name):

```bash
code --install-extension cinsight.insight-c
```

Or search for **Code Insight** in the Extensions view.

Offline install: download the `code-insight-<version>.vsix` for the release you want (for example `code-insight-0.8.0.vsix`) and run

```bash
code   --install-extension code-insight-0.8.0.vsix
cursor --install-extension code-insight-0.8.0.vsix
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
| Show Definition Candidates | `si.showDefinitionCandidates` |
| Find References | `si.findReferences` |
| Show Callers | `si.showCallers` |
| Show Callees | `si.showCallees` |
| Show Call Graph | `si.showCallGraph` |
| Show Index Diagnostics | `si.showIndexDiagnostics` |
| Clear Index Cache | `si.clearCache` |

The editor context menu offers go-to-definition, find-references and callers/callees in C/C++ files; the view title bar offers search, rebuild and configure.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `sourceInsight.indexRoots` | `[]` | Directories to index (workspace-relative); empty = nothing indexed |
| `sourceInsight.exclude` | `["**/.git/**","**/build/**","**/tmp/**","**/node_modules/**"]` | Excluded globs (`*`, `**`, `?`) |
| `sourceInsight.maxFileSizeKB` | `4096` | Skip source files larger than this |
| `sourceInsight.concurrency` | `4` | Worker threads used while building the index |
| `sourceInsight.maxSymbols` | `2000000` | Warn (status bar) when the index has more symbols than this |
| `sourceInsight.maxFiles` | `120000` | Warn (status bar) when the index has more files than this |
| `sourceInsight.autoCompact` | `true` | Merge index deltas back into the base snapshot on idle / after many changes / on close. When `false` automatic merges are deferred (deltas are still appended durably), but a safety compaction still runs at 5,000 changed files or a 32 MB delta; queries may slow down with a large overlay. While a shared-storage symbols-delta conflict is active, automatic compaction (including this safety cap) stays off until the window is reloaded |
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
                        compact symbol table (functions / prototypes / macros / struct / union / enum / typedef)
                                                     │
                                       binary snapshot symbols.sidx (extension storage)
                                                     ▼
                    definition / references / hover / outline / workspace symbols / call hierarchy
```

- The parser works on bytes so line and column numbers stay stable. A single-pass state machine blanks comments, string literals and `#define` continuations, then detects definitions and declarations at file scope ("type + name + balanced parentheses + `{`/`;`") and matches braces to get each function body range.
- The snapshot is a **columnar** binary format (format v4: string tables + typed arrays + name/file/condition lookup tables, a 64-bit content hash per file, an include-edge CSR and a condition id per symbol). 118,730 symbols load in 31 ms. The 0.5.x v3 table measured ~41 B of heap per symbol; v4 adds a 4 B condition id per symbol and 8 B of content hash per file. Unchanged files reuse their previous symbols; a v3 snapshot is rebuilt once automatically after upgrading.
- Saving a file is **incremental**: the extension appends a KB-sized delta record (`symbols.sidx.delta`) and applies it to an in-memory overlay in O(Δ), instead of rewriting the snapshot or rebuilding the column arrays (measured **~1 KB / 1 ms** appended with the v2 delta and **<1 ms** overlay update for a 22-symbol file; 0.7.0's v1 delta measured 904 B). The write is **O(Δ) in bytes**, not in time: each append validates the delta tail with an offset-only scan (no `SymbolEntry` decode), cached when only this process writes — measured **0.11 ms avg** steady-state, **0.74 ms** near a 4.09 MB delta (0.44 ms in the pre-fix saved run), and **5.48 ms** for a cold read + scan of a 4.17 MB tail (5.06 ms pre-fix; post-fix saved run). At startup saved deltas are replayed on top of the base snapshot; deltas over **4 MB** or **500** changed files, after **60 s** idle, and on close are compacted back into the base (measured **45 ms** for a 5.78 MB base with 118,730 symbols in the saved post-fix run; 56 ms pre-fix). `sourceInsight.autoCompact=false` only defers these merges: a safety compaction still runs at **5,000** changed files or a **32 MB** delta, except while a shared-storage delta conflict is active. The base format is now v4: a v3 snapshot is rebuilt once automatically after upgrading (no manual action), and unchanged files are reused after that.
- A per-file **identifier hash index** (`symbols.names`, ~3.6 MB for 6,838 files) makes find-references read only the files that can contain the identifier instead of the whole tree: measured **1 candidate file vs 6,838**, **1–2 ms vs 162 ms** for a full scan on the saved post-fix warm-cache run (the pre-fix run measured 158 ms). 32-bit collisions can add candidate files but never hide a reference, because each candidate is verified by exact word-boundary matching.
- The index is built in **one pass**: the parse worker strips comments/strings **once** per file and reuses that text for symbols, identifier hashes and the raw `#include` list; the 64-bit content hash runs on the raw text. Each source file is read exactly once, and include targets are then resolved against the indexed file set.
- The reference index is loaded **lazily** on the first find-references / call-hierarchy request (saves ~194 ms and ~69 MB at activation on a 68k-file corpus) and updated **incrementally**: saving a file appends a <1 KB delta record instead of rewriting the index, and deltas are merged back automatically.
- References and call relationships are scanned on demand: content prefilter first, then exact word-boundary matching; callers are derived from the line hit, callees only parse the target function body.
- No third-party runtime dependency; fully offline.

## Performance

Measured on a module set of **6,838 C/H files / 75 MB**:

| Metric | 0.8.0 result |
|---|---|
| Symbols | 118,730 (incl. 19,800 type symbols) |
| Include graph | 34,538 raw `#include` directives → 6,820 resolved edges in the indexed roots (**19.7%**, per-file de-duplicated; 3,027 files; system headers and out-of-root targets add no edge) |
| Conditional symbols | 27,967 / 118,730 (**23.6%**) record a condition; 2,070 distinct texts (conventional file-level include guards suppressed; 78,199 / 65.9% before suppression) |
| Content hashes | 6,838 / 6,838 files (64-bit) |
| Index build, single strip (4 workers) | 1.71–1.89 s typical warm (median ~1.84 s; 1.97–2.13 s before the single-strip fix; saved canonical run 1.89 s). Cold was not re-measured after the fix; the pre-fix 0.8.0 cold run was 6.6 s. 0.7.0 had no cold run on this machine — its documented cold range is 5.7–6.5 s (warm 1.5–1.6 s) |
| Snapshot size / load (columnar v4) | 5.78 MB / 31 ms in the saved post-fix run (28 ms pre-fix; 0.7.0: 5.13 MB, **+12.7%**, within the <15% target) |
| Hashing / include scan cost | 101 ms for 74.9 MB hashed (742 MB/s); 0.67 s raw include scan + 0.13 s resolution (single-threaded, page-warm; 105 ms / 713 MB/s, 0.71 s + 0.14 s pre-fix) |
| Definition ranking + grouping (`F12`) | rank avg ~0.52 ms / group avg ~0.84 ms on the hottest name (470 definitions); cold first call 2.62 ms; warm max observed 3.03 ms |
| Per-file save (incremental symbol index) | ~1 KB / <1 ms appended (v2 delta; 0.7.0's v1 measured 904 B); overlay update <1 ms (22-symbol file) |
| Delta append tail validation | 0.44–0.74 ms at a 4.09 MB delta (warm cache); 5.48 ms cold in the saved post-fix run (5.06 ms pre-fix; read + offset scan of a 4.17 MB tail, no entry decode) |
| Delta compaction (118,730 symbols) | 45 ms to write a 5.78 MB base in the saved post-fix run (56 ms pre-fix) |
| Symbol search (limit 50) | 4–5 ms |
| Exact name lookup | <1 ms |
| Signature reconstruction (first read) | 1–10 ms (page-cache dependent; the 0.7.0 run measured 56 ms) |
| Find references, full scan | 162 ms in the saved post-fix warm-cache run (158 ms pre-fix; cold not re-measured in 0.8.0) |
| Find references, **indexed** | **1–2 ms** (1 candidate file out of 6,838) |
| Reference index size / load (lazy, first use) | 3.57 MB / 15 ms in the saved post-fix run (17 ms pre-fix; 68k-file corpus: 69 MB / ~194 ms) |
| Per-file save (incremental reference index) | ~1 ms, <1 KB appended |
| Callers / callees | 6 ms / 1 ms in the saved post-fix run (5 ms / 0 ms pre-fix) |
| Snapshot-resident memory (after load) | ~76 MB vs 72.5 MB for 0.7.0 (**+3 MB**) |
| Peak RSS during build | 441–478 MB in the post-fix runs (canonical saved run 461.5 MB); interleaved A/B runs: 0.8.0 539–588 MB vs 0.7.0 452–509 MB |

- **Budget check (0.8.0):** snapshot growth is **+12.7%**, within the <15% target; loaded-index memory meets <+20 MB (+3 MB); build-time RSS was 441–478 MB in the post-fix runs (canonical saved run 461.5 MB), but the interleaved A/B runs measured 539–588 MB vs 452–509 MB for 0.7.0, so this is not a consistent win. F12 ranking/grouping averages ~0.52 ms rank / ~0.84 ms group, but the cold first call took 2.62 ms and the warm max observed was 3.03 ms. The single-strip refactor cut the warm build by ~8–13% (~0.2 s) and worker scan-pipeline CPU by ~32%, but the warm build is still **~15–20%** slower than 0.7.0 (1.71–1.89 s typical vs 1.5–1.6 s), so the <10% target is not met. The residual is not redundant stripping: it is the 0.8.0 scan work (one strip, condition/include parsing, content hash, condition ids and the larger snapshot write), partly hidden at 4 workers by main-thread dispatch/message overhead.
- 0.7.0 values were measured in an earlier run and differ by run and cache state; the warm-cache 0.7.0 numbers quoted above come from interleaved runs on the same machine against a temporary 0.7.0 worktree.
- Indexing `plat` alone (5,573 files / 57.5 MB): 74,194 symbols, 0.8–1.2 s with a warm cache, 0.5 s for an unchanged incremental rebuild.
- A single-threaded scan of all 121,606 files (2.6 GB) takes ~157 s; configure `indexRoots` per module so you only index what you actually browse.

> Find-references and call relationships first narrow the candidate set through the per-file identifier index, then read and lex only those files. The index is built once with the symbol index (the parse worker returns hashes, content hashes and include directives in the same pass) and maintained incrementally: saving one file only refreshes that file's slice. Results are cached per snapshot.

## Known limitations

- Heuristic parsing, not a full C front end: functions produced by macro expansion, old K&R parameter lists and unusual function-pointer forms may be missed (header prototypes still let you jump).
- Indexed symbols: functions, function prototypes, function-like macros, `struct`/`union`/`enum` tags and `typedef` names. **Struct members, plain variables and enum constants are not indexed** — jumping to `obj->field` would need type inference.
- **Conditional text is not evaluated**: definitions of the same name in different `#if` branches all appear as candidates, and the annotation shows the raw `#if`/`#ifdef` stack rather than the branch a given build takes. Conventional file-level include guards (`#ifndef NAME` + `#define NAME` … final `#endif`, or `#if !defined(NAME)` / `#if !defined NAME`) are transparent; an `#ifndef` without that `#define`, with a same-depth `#else`/conditional before it, or that does not cover the whole file still counts as a condition.
- **`#else` / `#elif` branches are not distinguished**: a definition inside such a branch displays the enclosing condition text, the same as the `#if` branch.
- **Ranking is soft**: include-visible definitions are preferred but never filtered; a same-named definition that no indexed file includes still appears after the included ones.
- **Include edges are resolved when a file is scanned** and reused for unchanged files: after adding or restoring headers (branch switch, `git checkout`) run **Rebuild Index** or save the includer to refresh its edges. The index cannot discover newly appearing targets for files whose mtime/size did not change, because raw `#include` directives are not stored in the snapshot.
- **Angled includes use the same heuristic as quoted ones**: `#include <x.h>` is resolved with the same directory → as-is → `indexRoots` search (the quote/angle flag is not stored in the snapshot), so a sibling file with a matching name inside the roots can be treated as included. This only affects the **soft** ranking — no candidate is dropped.
- **Duplicate folding only applies to identical content**: files must share the same 64-bit content hash (plus the same name and kind); the same code with different whitespace, line endings or comments keeps separate entries.
- Reference scanning is textual (with comment/string stripping), not semantic; same-named but unrelated symbols match too; first searches on huge roots are bound by disk throughput.
- Single-root workspaces only (the first workspace folder); `indexRoots` must be workspace-relative.
- **Multiple windows on the same workspace share the index** (`context.storageUri`). The shared-storage safety check covers the **symbols delta** (`symbols.sidx.delta`) only; the reference-index delta (`symbols.names.delta`) is still deleted on rebuild/compaction. If another window appends to the symbols delta, this window re-checks its size right before deleting it, keeps that delta, and disables automatic compaction for the rest of the process lifetime to protect the other window's records — so the 5,000-change / 32 MB safety cap does not run in that state. Concurrent windows may see stale results until the index is reloaded; **reload the window to recover**. **One window per workspace is recommended for now.**
- The reference index adds roughly one third to on-disk index storage; identifiers are stored as 32-bit hashes, so collisions can only add candidate files (they are verified before reporting).
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
| **跳转定义** | 光标在函数调用或类型名处按 `F12` / `Ctrl+Click`；无定义时回退到头文件原型 / 前置声明 |
| **类型跳转** | `struct` / `union` / `enum` 标签与 `typedef` 名字（含匿名结构体、函数指针 typedef）和函数一样进索引 |
| **候选智能排序** | 同名有很多定义时（多份内核/驱动拷贝），`F12` / 悬停 / 调用层次会把「离光标最近」的排在前面（同索引根 → 共享路径前缀） |
| **include 感知跳转** | 当前文件经已解析 `#include` 图可达的定义排在前面——**软排序**：只重排、不丢候选 |
| **重复副本折叠** | 内容完全相同（64 位内容哈希一致）且名字/种类相同的文件在 `F12` 中折叠为一个位置；`显示定义候选`（`si.showDefinitionCandidates`）可展开每个副本 |
| **条件编译标注** | `#if` / `#ifdef` / `#ifndef` 块内的符号在候选、悬停与列表详情中显示原始条件文本（不求值；传统文件级 include guard 透明） |
| **函数搜索** | `Ctrl+T`（原生"转到工作区中的符号"）或命令 `Code Insight: 搜索函数`（列出签名与位置） |
| **查找所有引用** | `Shift+F12`；带进度、可取消，结果缓存 |
| **调用关系** | 命令 `Code Insight: 显示调用者 / 显示被调用者`，也可用 VS Code 原生调用层次界面逐层展开 |
| **调用关系图** | 命令 `Code Insight: 调用关系图` 打开 Source Insight 风格的关系面板：中间当前函数，**左调用者、右被调用者**，可逐层展开、点击名字跳转 |
| **侧边栏符号窗口** | 左侧活动栏的「Code Insight」图标 → 目录 → 文件 → 函数（带签名摘要），按需加载 |
| **悬停签名** | 悬停函数名显示 `返回类型 函数名(参数)` 与定义/声明位置 |
| **文档大纲** | `Ctrl+Shift+O` 列出当前文件函数 |
| **索引诊断** | 命令 `Code Insight: 索引诊断` 打开 Markdown 报告：base/delta 体积、待合并变更、各类符号数、上次构建摘要、预算状态与内存占用 |
| **索引管理** | 状态栏显示索引状态与函数数量；命令：配置索引目录、重建索引、清除缓存 |

## 安装

从 [Open VSX](https://open-vsx.org/extension/cinsight/code-insight) 安装（Cursor、VSCodium、VS Code 均可用）：

```bash
cursor --install-extension cinsight.code-insight
code   --install-extension cinsight.code-insight
```

VS Code 用户也可从 Marketplace 安装（同一份代码；因 Marketplace 要求扩展名与显示名全局唯一，ID 不同）：

```bash
code --install-extension cinsight.insight-c
```

或在扩展面板搜索 **Code Insight** 后安装。

离线安装：下载与版本对应的 `code-insight-<version>.vsix`（例如 `code-insight-0.8.0.vsix`）后执行

```bash
code   --install-extension code-insight-0.8.0.vsix
cursor --install-extension code-insight-0.8.0.vsix
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
| `sourceInsight.maxSymbols` | `2000000` | 符号数超过该值时状态栏警告 |
| `sourceInsight.maxFiles` | `120000` | 文件数超过该值时状态栏警告 |
| `sourceInsight.autoCompact` | `true` | 空闲 / 累计变更较多 / 关闭时把索引增量合并回 base。`false` 时自动合并被推迟（delta 仍逐次追加，不丢数据），但到达安全上限（累计 5000 个文件变更或 32 MB delta）时仍会强制合并一次；overlay 很大时查询可能变慢。共享存储的符号 delta 冲突期间，自动 compaction（含该安全上限）会停用，直到重新加载窗口 |
| `sourceInsight.searchLimit` | `200` | 单次搜索返回上限 |
| `sourceInsight.autoReindexOnSave` | `true` | 保存/新建/删除文件时增量重解析 |
| `sourceInsight.enableCallHierarchy` | `true` | 注册原生调用层次 Provider |
| `sourceInsight.followSymlinks` | `false` | 是否跟随符号链接 |

修改 `indexRoots` / `exclude` / `maxFileSizeKB` 后建议执行一次 **重建索引**。

## 工作原理

- 解析器按字节工作，行号列号稳定；单遍状态机剥离注释、字符串、`#define` 续行，在文件作用域按"类型 + 名字 + 平衡括号 + `{`/`;`"判定定义与声明，并做花括号配对得到函数体范围。
- 快照为**列式**二进制格式（v4：字符串表 + TypedArray + 名字/文件/条件查找表，每文件 64 位内容哈希、include 边 CSR、每符号条件 id）；118,730 符号加载约 **31 ms**（0.5.x 的 v3 表实测每符号约 41 B 堆占用；v4 每符号多 4 B 条件 id、每文件多 8 B 内容哈希）。未变化的文件直接复用旧符号；v3 快照升级后会自动重建一次。
- 保存文件是**增量**的：只向 `symbols.sidx.delta` 追加一条 KB 级 delta 记录，并在内存 overlay 上做 O(Δ) 更新，不再重写快照、也不重建列数组（22 符号文件实测追加 **约 1 KB / 1 ms**（v2 delta；0.7.0 的 v1 为 904 B）、overlay 更新 **<1 ms**）。写入成本是「**O(Δ) 字节**，但不是 O(Δ) 时间」：每次追加只按记录长度偏移扫描 delta 尾部（不解码 `SymbolEntry`），且只在仅本进程写入时命中缓存——实测稳态均值 **0.11 ms**、4.09 MB delta 附近 **0.74 ms**（修复前保存运行 0.44 ms）、冷启动读 + 扫描 4.17 MB 尾部 **5.48 ms**（修复前 5.06 ms；保存的修复后运行）。启动时把已保存的 delta 重放在 base 快照之上；delta 超过 **4 MB** 或累计 **500** 个文件变更、空闲 **60 s** 以及关闭时合并回 base（118,730 符号实测写出 5.78 MB base 用 **45 ms**（保存的修复后运行；修复前 56 ms））。`sourceInsight.autoCompact=false` 只推迟这些合并：到达 **5,000** 个文件变更或 **32 MB** delta 的安全上限时仍会强制合并一次（共享存储 delta 冲突期间除外）。base 格式已升为 v4：v3 快照升级后自动重建一次（无需手动操作），之后未变化文件照常复用。
- 每个文件的**标识符哈希倒排索引**（`symbols.names`，6,838 文件约 3.6 MB）让查找引用只读可能包含该名字的文件：实测**候选文件 1 个 vs 6,838 个**，保存的修复后热缓存运行 **1–2 ms vs 全量扫描 162 ms**（修复前运行 158 ms）。32 位哈希碰撞只会多出候选文件，不会漏报——候选文件仍按词边界精确校验。
- 索引**单遍构建**：解析 worker 对每个文件只剥离注释/字符串一次，符号、标识符哈希与原始 `#include` 列表共用该结果，64 位内容哈希按原始文本计算；每个源码文件只读一次，include 目标随后按索引内文件集合解析。
- 引用索引**惰性加载**（首次查找引用/调用层次才读盘；68k 文件语料约省 194 ms 与 69 MB），并**增量维护**：保存一个文件只追加 <1 KB 的 delta 记录，超阈值自动合并回 base。
- 引用与调用关系先用「每文件标识符倒排索引」缩小候选集，只对候选文件读盘并做词法剥离与词边界精确匹配。
- 无第三方运行时依赖，离线可用。

## 性能

对 **6,838 个 C/H 文件 / 75 MB** 的模块集合实测（0.8.0）：符号 **118,730**；include 图 **34,538 条原始指令 → 索引根内 6,820 条边**（3,027 个文件）；**27,967 / 118,730（23.6%）** 个符号带条件标注（2,070 种文本；传统文件级保护宏已透明，抑制前为 78,199 / 65.9%）；建索引（单遍剥离，4 workers）热缓存典型 **1.71–1.89 s**（中位数约 1.84 s；保存的基准运行 1.89 s；单遍剥离修复前 1.97–2.13 s）；修复后未重测冷盘，修复前 0.8.0 首次冷盘 **6.6 s**；0.7.0 在本机没有冷盘运行，其文档冷盘区间为 5.7–6.5 s（热缓存 1.5–1.6 s）；快照 **5.78 MB / 加载 31 ms**（保存的修复后运行；修复前 28 ms；0.7.0 为 5.13 MB，**+12.7%**，已进入 <15% 目标内）；内容哈希 74.9 MB 用 **101 ms**（742 MB/s），原始 include 扫描单线程 **0.67 s** + 解析 **0.13 s**（保存的修复后运行；修复前 105 ms / 713 MB/s、0.71 s + 0.14 s）；F12 排序+分组在最热名字（470 个定义）上平均 **rank 约 0.52 ms / group 约 0.84 ms**、首次冷调用 **2.62 ms**、热路径最大观测 **3.03 ms**；函数搜索 4–5 ms；按名查找 <1 ms；签名重建 1–10 ms；**查找引用：倒排索引 1–2 ms，全量扫描 162 ms（保存的修复后运行；修复前 158 ms；0.8.0 冷盘未重测）**；调用者/被调用者 6 ms / 1 ms（保存的修复后运行；修复前 5 ms / 0 ms）；保存单文件约 **1 KB / <1 ms**（v2 delta），compaction **45 ms** 写出 5.78 MB base（保存的修复后运行；修复前 56 ms）；加载后快照常驻内存 **约 76 MB**（0.7.0 为 72.5 MB，+3 MB），构建期 RSS **441–478 MB**（保存的修复后基准 461.5 MB；0.8.0 交替 A/B 实测 539–588 MB vs 0.7.0 452–509 MB）。0.7.0 的数字来自不同轮次，会随缓存状态与运行波动。

**预算核对**：快照增长 **+12.7%**，满足 <15%；F12 排序/分组均值约 rank 0.52 ms / group 0.84 ms，但最坏名字（470 个定义）首次冷调用为 2.62 ms、热路径最大观测 3.03 ms，**<2 ms 热路径预算未达成**；加载后的索引内存满足 <+20 MB，构建期 RSS 在修复后各轮为 441–478 MB（保存的基准运行 461.5 MB），不再整体高于 0.7.0 区间 452–509 MB，但交替 A/B 轮仍达 539–588 MB；单遍剥离让热缓存构建快约 **8–13%（约 0.2 s）**、worker 扫描流水线 CPU 降约 **32%**，但仍比 0.7.0 慢 **约 15–20%**（典型 1.71–1.89 s vs 1.5–1.6 s），**<10% 目标未达成**。残余开销不再是重复剥离，而是 0.8.0 新增扫描本身（一次剥离、条件/include 解析、内容哈希、条件 id 与更大的快照写入），且 4 workers 时部分被主线程派发/消息开销掩盖。

## 已知限制

- 启发式解析：宏展开生成的函数、K&R 老式参数表、极端函数指针写法可能漏识别（头文件原型可兜底跳转）。
- 已索引：函数、函数原型、函数式宏、`struct`/`union`/`enum` 标签与 `typedef` 名字。**结构体成员、普通变量、枚举常量暂不索引**——`obj->field` 的跳转需要类型推导。
- **条件文本不求值**：同一名字在多个 `#if` 分支的定义都会出现在候选里，标注显示原始 `#if`/`#ifdef` 栈，而不是某次构建实际走的分支。传统文件级 include guard（`#ifndef NAME` + `#define NAME` … 文件末尾 `#endif`，或 `#if !defined(NAME)` / `#if !defined NAME`）透明；无同名 `#define`、同层提前出现其他条件、或未覆盖整个文件的 `#ifndef` 仍算条件。
- **`#else` / `#elif` 分支不区分**：这类分支里的定义同样显示外层条件文本，与 `#if` 分支一致。
- **排序是软排序**：已包含的定义优先，但不过滤；没有任何索引内文件包含的同名定义仍会排在后面。
- **include 边在扫描文件时解析**，未变化的文件复用旧边：新增或恢复头文件（切分支、`git checkout`）后请执行 **重建索引** 或保存 includer 来刷新它的边。文件的 mtime/size 未变化时，索引无法发现新出现的目标，因为快照里不保存原始 `#include` 指令。
- **尖括号 include 与引号形式使用同一套启发式**：`#include <x.h>` 同样按「相对目录 → 原样 → `indexRoots`」解析（快照不保存引号/尖括号标记），因此索引根内同名的兄弟文件可能被当作已包含。这只影响**软排序**，不会丢弃候选。
- **重复副本折叠只对内容完全相同生效**：必须 64 位内容哈希一致（且名字/种类相同）；仅空白/换行/注释不同的相同代码不会折叠。
- 引用扫描是文本级（已剥离注释/字符串），不是语义级；首次在大仓库上受磁盘吞吐限制。
- 只支持单根工作区（取第一个 workspace folder）；`indexRoots` 必须是工作区内相对路径。
- **同一个工作区打开多个窗口会共享同一份索引**（`context.storageUri`）。共享存储安全检查只覆盖**符号 delta**（`symbols.sidx.delta`）；引用索引 delta（`symbols.names.delta`）在 rebuild/compaction 时仍会被删除。若另一个窗口也在追加符号 delta，本窗口会在删除前重新核对大小，保留该 delta，并在本次进程生命周期内禁用自动 compaction（保护对方的记录），因此此时不会触发 5,000 个文件变更 / 32 MB 的安全上限。并发窗口可能看到过期结果，直到重新加载索引——**重新加载窗口即可恢复**。目前建议**一个工作区只开一个窗口**。
- 倒排索引会让索引占用增加约三分之一；标识符以 32 位哈希存储，碰撞只会增加候选文件（命中前仍精确校验），不会漏报。

## 隐私与安全

- **纯本地运行**：不联网、不上报数据、不收集遥测。
- 只读取 `sourceInsight.indexRoots` 内的 C/C++ 源码，快照写入扩展自己的存储目录。
- 不执行被索引的代码，不调用外部工具（不依赖 ctags / clangd / compile_commands.json）。
- 不修改工作区文件。

## 反馈

问题与建议请提交到 <https://github.com/izhongbei/cinsight/issues>。

## License

MIT
