# Changelog

## 0.7.0 — 2026-11-17

### English

- **Incremental symbol index**: saving a file no longer rewrites the whole snapshot. The save path appends a KB-sized delta record to `symbols.sidx.delta` (measured **904 B / 1 ms** for a 22-symbol file) and applies it to an in-memory overlay in **O(Δ)** — the column arrays are not rebuilt (measured **<1 ms**, reported as 0 ms). Startup replays `base + delta`; the perf run replayed 1 record with an identical entry count.
- **Automatic compaction** merges deltas back into the base snapshot: above **4 MB** of delta or **500** changed files, after **60 s** idle, and on close. Measured on 118,730 symbols: **47 ms** to write the 5.13 MB base (plus 65 ms to flatten the overlay). `sourceInsight.autoCompact=false` disables the automatic merges; deltas are still appended durably.
- **Index size budget**: new `sourceInsight.maxSymbols` (default 2,000,000) and `sourceInsight.maxFiles` (default 120,000) settings. Exceeding either turns the status bar into a warning; beyond the hard limit of 5,000,000 symbols it turns into an error and a one-shot prompt offers to reconfigure the index roots. Builds over 80,000 actual files automatically downgrade concurrency to 2 workers.
- New command **`Code Insight: Show Index Diagnostics`** (`si.showIndexDiagnostics`): a Markdown report with base/delta sizes, pending changes, per-kind symbol counts, the last build summary, budget status and process memory.
- **Compatibility**: the base snapshot format is still **v3** and unchanged; 0.6.x deltas are replayed after the upgrade, so **no rebuild is needed**. 0.6.x extensions simply ignore the new `.delta` sidecar.
- 206 tests pass.

Measured on 6,838 C/H files / 118,730 symbols (same module set as 0.6.x): build 5.7 s, snapshot load 31 ms, symbol search 5 ms, indexed find-references 2 ms (full scan 1.16 s), callers / callees 5 ms / 1 ms — no regression versus 0.6.x.

### 中文

- **符号索引增量更新**：保存文件不再重写整个快照。保存路径只向 `symbols.sidx.delta` 追加一条 KB 级 delta 记录（22 符号的文件实测 **904 B / 1 ms**），并把它应用到内存 overlay，单文件更新为 **O(Δ)**——不重建列数组（实测 **<1 ms**，输出取整显示为 0 ms）。启动时按 `base + delta` 重放；压测中重放 1 条记录后条目数一致。
- **自动 compaction**：delta 超过 **4 MB** 或累计 **500** 个文件变更、空闲 **60 s**、以及关闭扩展时，把增量合并回 base 快照。118,730 符号实测：写出 5.13 MB base 用 **47 ms**（overlay flatten 另计 65 ms）。`sourceInsight.autoCompact=false` 可关闭自动合并；delta 仍会逐次追加落盘，不丢数据。
- **索引规模预算**：新增 `sourceInsight.maxSymbols`（默认 2,000,000）与 `sourceInsight.maxFiles`（默认 120,000）。超过任一阈值状态栏变为警告；超过 5,000,000 符号的硬上限时变为错误，并一次性提示重新配置索引目录。实际文件数超过 80,000 时构建并发自动降到 2。
- 新命令 **`Code Insight: 索引诊断`**（`si.showIndexDiagnostics`）：Markdown 报告，含 base/delta 体积、待合并变更数、各类符号数、上次构建摘要、预算状态与进程内存。
- **兼容性**：base 快照格式仍为 **v3** 且未改动；0.6.x 的 delta 在升级后会被重放，**无需重建索引**。0.6.x 旧版扩展会忽略新增的 `.delta` 旁路文件。
- 206 个单测通过。

对 6,838 个 C/H 文件 / 118,730 符号实测（与 0.6.x 同一模块集合）：构建 5.7 s、快照加载 31 ms、函数搜索 5 ms、倒排索引查找引用 2 ms（全量扫描 1.16 s）、调用者/被调用者 5 ms / 1 ms——相对 0.6.x 无劣化。

## 0.6.1 — 2026-11-17

### English

- Documentation-only release: README/CHANGELOG entries for the call graph panel (0.6.0 shipped the code).

### 中文

- 仅文档更新：补上调用关系图面板的 README/CHANGELOG 说明（代码在 0.6.0 已发布）。

## 0.6.0 — 2026-11-17

### English

- **New call graph panel** (Source Insight "Relation" style): the current function sits in the middle, **callers on the left, callees on the right**; each node expands/collapses independently and clicking a name jumps to its definition. Cycles are skipped, 100 children per direction and 300 nodes total (with a truncation marker). Expansions reuse the indexed reference scan, so they are typically milliseconds.
- New command `si.showCallGraph` (command palette, C/C++ editor context menu, symbol-view title button).
- 160 tests pass (graph model + generated HTML tests added).

### 中文

- **新增调用关系图面板**（Source Insight 的 Relation 风格）：中间是当前函数，**左边调用者、右边被调用者**；每个节点可单独展开/折叠，点击名字跳到定义。自动跳过环，单方向最多 100 个子节点、全图最多 300 个节点（超出有截断标记）。数据来自索引化引用扫描，展开通常是毫秒级。
- 新命令 `si.showCallGraph`（命令面板、C/C++ 编辑器右键菜单、符号视图标题栏按钮）。
- 160 个单测通过（新增图模型与 HTML 生成测试）。


## 0.5.1 — 2026-11-13

### English

- Documentation-only release: corrected the snapshot format description, memory figures and performance table for the columnar v3 symbol table (0.5.0 shipped the code).

### 中文

- 仅文档更新：修正列式 v3 符号表对应的快照格式说明、内存数字与性能表（代码在 0.5.0 已发布）。

## 0.5.0 — 2026-11-13

### English

- **Columnar symbol table**: symbols are stored as typed arrays (name ids, file ids, lines, end lines, columns, kinds) plus string/lookup tables instead of ~1.5 M JavaScript objects. Heap drops from **~220 MB to ~61 MB** for 1.49 M symbols (**~41 B/symbol**); loading 119k symbols takes ~51 ms.
- Snapshot format v3 (self-describing, with name/file lookup tables); old snapshots are rebuilt automatically once after upgrading.
- Symbol search faster (**4–7 ms** on 119k symbols): scans the name table with a cheap substring prefilter instead of materialising every entry.
- Incremental single-file updates rebuild only the column arrays (no object materialisation).

### 中文

- **列式符号表**：符号改用 TypedArray（名字 id、文件 id、行、结束行、列、种类）+ 字符串表/查找表存储，不再创建约 150 万个 JS 对象。149 万符号的堆占用从 **约 220 MB 降到约 61 MB**（**每符号约 41 B**），11.9 万符号加载约 51 ms。
- 快照格式升级为 v3（自描述，含名字/文件查找表）；升级后旧快照自动重建一次。
- 符号搜索变快（11.9 万符号 **4–7 ms**）：改为扫描名字表 + 便宜的 includes 预筛，不再逐条物化。
- 单文件增量更新只重建列数组（不物化对象）。


## 0.4.1 — 2026-11-13

### English

- **Fix**: the document outline (`Ctrl+Shift+O`) could throw `Invalid arguments` when the index was older than the open document (edited/truncated file, or a definition line beyond the document). Ranges are now clamped and invalid entries are skipped per-symbol, so the outline never fails as a whole.

### 中文

- **修复**：当索引比当前打开的文档旧（文件被编辑/截断，或定义行超出文档范围）时，大纲（`Ctrl+Shift+O`）会抛 `Invalid arguments`。现在对范围做 clamp，并逐条跳过非法符号，大纲不会整体失败。


## 0.4.0 — 2026-11-12

### English

- **Single-pass index build**: the parse worker now returns attribute hashes together with symbols, so the reference index no longer re-reads the sources. Measured on 6,838 files: exactly **1 read per file** (6,838 total), build 6.1 s cold (previously two passes / 2x I/O).
- **Incremental reference index**: saving one file appends a small delta record instead of rewriting the whole index — **743 B / ~1 ms** versus 68 MB / 362 ms on the 68k-file corpus. Deltas are merged back automatically above 4 MB or when VS Code flushes/deactivates.
- **Lazy reference index loading**: the index is now loaded on the first find-references / call-hierarchy request instead of at activation (68k-file corpus: saves ~194 ms activation time and ~69 MB resident memory).
- Crash-safe: a truncated delta tail is ignored, so an interrupted write cannot corrupt the index.
- Snapshot format is unchanged; the reference index keeps its base format and adds a `symbols.names.delta` sidecar (backward compatible, auto-compacted).

### 中文

- **单遍构建**：解析 worker 现在同时返回符号与标识符哈希，引用索引不再二次读源码。6,838 文件实测：**每个文件只读 1 次**（共 6,838 次），冷盘构建 6.1 s（此前读两遍 / 2 倍 I/O）。
- **引用索引增量维护**：保存单个文件只追加一条小 delta 记录，不再重写整个索引——**743 B / 约 1 ms**（68k 文件语料旧实现为 68 MB / 362 ms）。delta 超过 4 MB 或 VS Code 卸载/失焦时自动合并回 base。
- **引用索引惰性加载**：改为首次「查找引用 / 调用层次」时才读盘，激活不再加载（68k 文件语料约省 194 ms 与 69 MB 常驻内存）。
- 崩溃安全：delta 尾部未写完的记录会被忽略，写入中断不会破坏索引。
- 快照格式不变；引用索引保持原 base 格式，新增 `symbols.names.delta` 边车文件（向后兼容，自动 compaction）。


## 0.3.1 — 2026-11-12

### English

- **Smart ordering of same-named definitions**: when a symbol has many definitions (e.g. `sk_buff` has 77 in a workspace with several kernel copies), F12 / hover / call-hierarchy candidates are now ordered by distance from the cursor: same `indexRoots` root first, then shared path prefix, then definition-before-declaration, then header-vs-source preference, with a stable path/line tie-break.
- Measured on a 1,485,811-symbol / 68,184-file workspace: snapshot load 340 ms, name-index load 170 ms, `findByName` 26 ms, symbol search 100 ms, one indexed find-references 63 ms.

### 中文

- **同名定义智能排序**：同一个符号有很多定义时（例如多份内核拷贝的情况下 `sk_buff` 有 77 个），F12 / 悬停 / 调用层次的候选按「离光标远近」排序：同 `indexRoots` 根优先 → 共享路径前缀多优先 → 定义优先于声明 → 类型优先头文件、函数优先源文件 → 最后按路径/行号稳定排序。
- 在 1,485,811 符号 / 68,184 文件的工作区实测：快照加载 340 ms、引用索引加载 170 ms、`findByName` 26 ms、符号搜索 100 ms、一次索引化查找引用 63 ms。


## 0.3.0 — 2026-11-12

### English

- **C type symbols are now indexed**: `struct` / `union` / `enum` tags and `typedef` names (including anonymous-struct and function-pointer typedefs) participate in go-to-definition, find-references, hover, outline and symbol search.
- Forward declarations (`struct foo;`) are indexed as declarations, so the real definition wins in the candidate list.
- Snapshot format bumped to version 2: after upgrading, the index rebuilds once automatically in the background.
- Measured corpus: symbols 98,930 → **118,730** (+19,800 type symbols); snapshot 3.87 → 4.51 MB; reference lookup stays ~8 ms (about 31× faster than a full scan).
- Not covered: struct **members**, plain variables and enum constants — resolving `obj->field` needs type inference.

### 中文

- **C 类型符号进入索引**：`struct` / `union` / `enum` 标签与 `typedef` 名字（含匿名结构体 typedef、函数指针 typedef）现在支持跳转定义、查找引用、悬停、大纲与符号搜索。
- 前置声明（`struct foo;`）按声明索引，候选列表中真正的定义优先。
- 快照格式升到 v2：升级后会自动在后台重建一次索引。
- 实测语料：符号 98,930 → **118,730**（新增 19,800 个类型符号），快照 3.87 → 4.51 MB；引用查询仍约 8 ms（比全量扫描快约 31 倍）。
- 未覆盖：**结构体成员**、普通变量、枚举常量——`obj->field` 的跳转需要类型推导。


## 0.2.0 — 2026-11-12

### English

- **Much faster find-references / call hierarchy**: a per-file identifier hash index (`symbols.names`) narrows each query to the few files that can contain the name. Measured on 6,838 C/H files: **1 candidate file instead of 6,838**, 5 ms instead of 159 ms warm (4.2 s cold) — about 30× faster.
- The index is built with the symbol index in a second high-concurrency pass and maintained incrementally: saving one file refreshes only that file's slice.
- Index storage grows by roughly one third (3.57 MB for the measured corpus); 32-bit hash collisions can add candidate files but never hide a reference.
- Snapshot format unchanged; upgrading rebuilds the reference index once in the background.

### 中文

- **查找引用 / 调用层次大幅提速**：新增「每文件标识符哈希倒排索引」（`symbols.names`），每次查询只读取可能包含该名字的少量文件。6,838 个 C/H 文件实测：**候选文件 1 个（原来要全量 6,838 个）**，热缓存 5 ms（原 159 ms），冷盘 4.2 s → 5 ms，约 30 倍。
- 倒排索引随符号索引一起构建（第二遍高并发 I/O），并支持增量维护：保存单个文件只刷新该文件的切片。
- 索引体积增加约三分之一（实测语料 3.57 MB）；32 位哈希碰撞只会增加候选文件，不会漏报引用。
- 快照格式不变；升级后后台重建一次倒排索引即可。


All notable changes to this project are documented in this file.

本文件记录本项目的所有重要变更（英文在前，中文说明在后 / English first, Chinese below）。

## 0.1.2 — 2026-11-12

### English

Documentation only — no code change, no behaviour change, symbol snapshot format unchanged.

- **Bilingual CHANGELOG** (this file): English first, Chinese below.
- Corrected stale product naming inherited from the first draft (Source Insight → Code Insight, extension ID `cinsight.code-insight`).

### 中文

仅文档变更 —— 无代码改动、无行为变化，索引快照格式不变。

- **CHANGELOG 改为中英双语**（本文件）：英文在前、中文在后。
- 修正初版遗留的旧产品名（Source Insight → Code Insight，扩展 ID `cinsight.code-insight`）。

## 0.1.1 — 2026-11-12

### English

- README is now bilingual (English first, Chinese below) and gains **Privacy & Security** and **Feedback** sections.
- `package.json` gains `repository` / `homepage` / `bugs`: the Open VSX page now shows a Repository link and the README feedback entry works.
- Fully compatible with the 0.1.0 symbol snapshot; no reindex is needed after upgrading.

### 中文

- README 改为中英双语（英文在前、中文在后），新增「隐私与安全」「反馈」章节。
- `package.json` 补充 `repository` / `homepage` / `bugs`：Open VSX 页面显示 Repository 链接，README 反馈入口可用。
- 与 0.1.0 索引快照格式完全兼容，升级后无需重建索引。

## 0.1.0 — 2026-11-11

### English

First release — Source Insight-style code browsing for large C/C++ projects.

- Persistent function symbol index: in-house C lexer and definition detection, parallel workers, binary snapshot, mtime+size incremental updates.
- Go to definition (`F12` / `Ctrl+Click`), falling back to the header prototype when no definition exists.
- Symbol search: `Ctrl+T` (workspace symbols) plus the `Code Insight: Search Function` command.
- Find references (`Shift+F12`) with progress reporting and cancellation.
- Call hierarchy: the native VS Code call hierarchy view (callers / callees) plus command entry points.
- Activity Bar symbol tree: folder → file → function (with signature), loaded on demand.
- Hover signature with definition/declaration location; document outline (`Ctrl+Shift+O`).
- Status bar index state and symbol count; commands to configure roots, rebuild the index and clear the cache.
- Nothing is indexed by default; `.git`, `build`, `tmp` and `node_modules` are excluded by default.
- English and Chinese UI (VS Code l10n, 72 runtime strings).

### 中文

初版 —— 面向大型 C/C++ 工程的 Source Insight 风格代码浏览。

- 持久函数符号索引：自研 C 词法与定义识别，worker 多线程并行，二进制快照，mtime+size 增量更新。
- 跳转定义（`F12` / `Ctrl+Click`），无定义时回退到头文件原型声明。
- 函数搜索：`Ctrl+T`（工作区符号）+ 命令 `Code Insight: 搜索函数`。
- 查找所有引用（`Shift+F12`），支持进度显示与取消。
- 调用关系：VS Code 原生调用层次界面（调用者 / 被调用者）+ 命令入口。
- 活动栏符号树：目录 → 文件 → 函数（带签名摘要），按需加载。
- 悬停签名与定义/声明位置；文档大纲（`Ctrl+Shift+O`）。
- 状态栏索引状态与符号数量；命令：配置索引目录、重建索引、清除缓存。
- 默认不索引任何目录；默认排除 `.git`、`build`、`tmp`、`node_modules`。
- 中英双语界面（VS Code l10n，72 条运行时文案）。
