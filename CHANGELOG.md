# Changelog

## 0.9.0 — 2026-11-20

### English

- **Struct/union members, enum constants and file-scope globals are now indexed.** Three new symbol kinds (`member`, `enumConstant`, `variable`) and an optional `parent` (member → struct/union tag, enum constant → enum tag or typedef alias, globals have none). On the measured corpus this adds **87,611 symbols** (51,165 members, 26,936 enum constants, 9,510 globals); every member and enum constant carries a parent (78,101 symbols, 9,002 distinct parent names).
- **Nested document outline.** Members and enum constants are shown under their type — the innermost enclosing `struct`/`union`/`enum` range, with a fallback to the `parent` name so anonymous typedef bodies work; symbols that cannot be attached stay at the top level instead of disappearing. Outline kinds map to VS Code `Field` / `EnumMember` / `Variable`.
- **Field jump.** `F12` on `p->field`, `v.field` or `.field =` now jumps to the member definition with that name. The check is lexical (a `.` / `->` immediately before the cursor word) and deliberately **does not infer types**: every same-name member in the index is a candidate, ordered by the existing include/distance ranking, capped at 50 and duplicate-folded; with no member match it falls back to the normal definition, so same-name members of unrelated structs can appear as candidates.
- **Hover parent / kind.** Hover and list details show `member of struct X`, `enumerator of enum X` or `variable` in addition to the existing signature / location / inclusion annotations.
- **`@kind` filters in Search Symbols.** The search box accepts `@func`, `@type` (struct/union/enum/typedef), `@macro`, `@member`, `@enum` and `@var`; multiple filters are OR-ed, matching is case-insensitive and unknown `@tokens` stay in the query. The command is renamed **`Code Insight: Search Symbols`** / **搜索符号** (id `si.searchSymbol` unchanged), since it now searches every kind.
- **Snapshot v5 and delta v3.** Snapshot v5 adds a parent string table and a parent id per symbol; a v4 snapshot is **rebuilt once automatically after upgrading** (no manual action) and unchanged files are reused afterwards. Delta v3 stores the parent per entry and still reads v1/v2 delta files; appending to an old delta rewrites it as v3, as before.
- **Budget defaults raised.** `sourceInsight.maxSymbols` 2,000,000 → **3,000,000**, hard maximum 5,000,000 → **6,000,000**; `maxFiles` stays 120,000.
- **Measured performance (6,838 C/H files).** 206,430 symbols (**+87,700 vs 0.8.0**: 87,611 from the new kinds plus 89 residual existing-kind changes from B3 scan/typedef fixes) and a **10.16 MB** snapshot (0.8.0: 118,730 symbols / 5.78 MB, **+75.8%**, above the <35% target); warm build **2.14 s** canonical and **2.14–2.45 s** in interleaved A/B runs vs **1.64–1.85 s** for 0.8.0 (**+34%**, above the <20% target; parse phase median 1.86 s vs 1.38 s); field jump **0.94 ms avg / 1.22 ms max** on the hottest member name (1,001 definitions, capped at 50) — within the **<5 ms** target; snapshot load 40 ms; symbol search **8 ms**; indexed find-references 1–2 ms (full scan 144 ms); callers/callees 7 ms / 0 ms; snapshot-resident memory ~84 MB vs ~75 MB (+9 MB); build RSS 544 MB. Conditional symbols are 40,890 / 206,430 (**19.8%**, 2,309 distinct texts) — the ratio is lower than 0.8.0's 23.6% because most new symbols are unconditional.
- **Scan edge cases.** Macro-generated enum entries such as `CINIT(FILE, LONG) = 1` are skipped instead of being indexed as enum constants; the conventional file-level include-guard suppression applies to the new kinds too (enum constants inside a standard guard carry no condition). The known `typedef struct { ... } __attribute__((packed)) alias;` limitation is unchanged: the alias typedef symbol is still lost, while its members are indexed with the alias as parent.
- **Final-review fixes.** The symbol tree now has its own per-file cap, `sourceInsight.treeSymbolLimit` (default 2000, independent of `sourceInsight.searchLimit`), so B3-grown headers (for example 199 → 479 symbols) are no longer truncated and the overflow node suggests raising the setting. Anonymous typedef bodies extend the parent outline range over their members (breadcrumbs / sticky scroll), trailing kernel attribute macros (`__read_mostly`, `__packed`, `__aligned(...)`, `__section(...)`) no longer become the declared name, and typing only `@member` with no name now shows a "Type a name after @member" hint.
- 358 tests pass.

### 中文

- **结构体/联合体成员、枚举常量与文件作用域全局变量进入索引**：新增 `member` / `enumConstant` / `variable` 三种符号种类，以及可选的 `parent`（成员 → struct/union 标签；枚举常量 → enum 标签或 typedef 别名；全局变量无 parent）。实测语料新增 **87,611 个符号**（成员 51,165、枚举常量 26,936、全局变量 9,510）；所有成员与枚举常量都带 parent（共 78,101 个，9,002 种 parent 名）。
- **大纲嵌套**：成员与枚举常量挂在所属类型下——取最内层 `struct`/`union`/`enum` 区间，区间不匹配时按 `parent` 名字兜底（匿名 typedef 类型体因此可用）；无法归属的符号留在顶层而不是丢失。大纲种类映射到 VS Code 的 `Field` / `EnumMember` / `Variable`。
- **字段跳转**：在 `p->field`、`v.field`、`.field =` 上按 `F12` 跳到同名成员定义。判断是词法级的（光标词前紧跟 `.` / `->`），**刻意不做类型推导**：索引里所有同名成员都是候选，按既有 include/距离软排序，上限 50 并折叠重复副本；没有成员命中时回退普通定义，因此不相关结构体的同名成员也可能出现。
- **悬停 parent / kind**：悬停与列表详情在原有签名/位置/包含标注之外，显示 `member of struct X`、`enumerator of enum X` 或 `variable`。
- **搜索支持 `@kind` 过滤**：输入框支持 `@func`、`@type`（struct/union/enum/typedef）、`@macro`、`@member`、`@enum`、`@var`；多个过滤词取并集、大小写不敏感，未知 `@token` 原样保留在查询里。命令更名为 **`Code Insight: 搜索符号`** / **Search Symbols**（命令 id `si.searchSymbol` 不变），因为它现在搜索所有种类。
- **快照 v5 与 delta v3**：快照 v5 新增 parent 字符串表与每符号 parent id；v4 快照升级后**自动重建一次**（无需手动操作），之后未变化文件照常复用。delta v3 每个条目保存 parent，并仍可读取 v1/v2 delta；向旧 delta 追加时按原有语义整体重写为 v3。
- **预算默认值上调**：`sourceInsight.maxSymbols` 2,000,000 → **3,000,000**，硬上限 5,000,000 → **6,000,000**；`maxFiles` 保持 120,000。
- **实测性能（6,838 个 C/H 文件）**：206,430 个符号（相对 0.8.0 **+87,700**：新增种类 87,611 个，另加 B3 扫描/typedef 修复带来的既有种类 89 个残差），快照 **10.16 MB**（0.8.0：118,730 符号 / 5.78 MB，**+75.8%**，超过 <35% 目标）；热缓存构建保存运行 **2.14 s**、交替 A/B **2.14–2.45 s**，0.8.0 为 **1.64–1.85 s**（**+34%**，超过 <20% 目标；parse 阶段中位数 1.86 s vs 1.38 s）；字段跳转在最热成员名（1,001 个定义，截断 50）上 **均值 0.94 ms / 最大 1.22 ms**，满足 **<5 ms** 目标；快照加载 40 ms；符号搜索 **8 ms**；倒排索引查找引用 1–2 ms（全量扫描 144 ms）；调用者/被调用者 7 ms / 0 ms；加载后快照常驻内存约 84 MB vs 约 75 MB（+9 MB）；构建期 RSS 544 MB。条件符号 40,890 / 206,430（**19.8%**，2,309 种文本）——比例低于 0.8.0 的 23.6%，因为新增符号大多无条件。
- **扫描边界**：`CINIT(FILE, LONG) = 1` 这类宏生成的枚举项会被跳过，不再伪造成枚举常量；传统文件级 include guard 抑制同样作用于新种类（标准 guard 内的枚举常量不带条件）。已知的 `typedef struct { ... } __attribute__((packed)) alias;` 限制不变：别名 typedef 符号仍会丢失，但其成员仍以该别名作为 parent 索引。
- **最终评审修复**：符号树改用独立于 `sourceInsight.searchLimit` 的每文件上限 `sourceInsight.treeSymbolLimit`（默认 2000），B3 之后变大的头文件（例如 199 → 479 个符号）不再被截断，溢出节点会提示调大该设置。匿名 typedef 类型体的父节点完整范围扩展到成员（breadcrumbs / sticky scroll 因此可见），声明符末尾的内核属性宏（`__read_mostly`、`__packed`、`__aligned(...)`、`__section(...)`）不再被当成名字；只输入 `@member`（后面没有名字）时会显示「请在 @member 后输入名字」提示。
- 358 个单测通过。

## 0.8.0 — 2026-11-17

### English

- **Include-aware candidate ranking.** When a name has several definitions, `F12`, hover, call hierarchy, `si.gotoDefinition` and `si.showDefinitionCandidates` now list definitions reachable from the current file through the resolved `#include` graph first. This is a **soft** ranking: candidates are reordered, never filtered — a definition that no indexed file includes still appears after the included ones. The include graph is built in the same scan pass (on the measured corpus 34,538 raw `#include` directives produced 6,820 edges inside the two indexed roots; system headers and files outside the roots simply add no edge).
- **Duplicate folding.** Definitions that are byte-identical (same 64-bit content hash) and have the same name and kind are folded into one F12 location. `si.showDefinitionCandidates` shows one item per group and opens a second-level copy picker for every identical copy. Folding changes presentation only — no definition is dropped — and only identical-content files fold (whitespace or line-ending changes keep them separate). On the measured corpus the hottest name (`START_TEST`, 470 definitions) had no identical copies, so folding was a no-op there; it targets duplicated kernel/driver trees.
- **Conditional annotations.** Each symbol records the raw enclosing `#if`/`#ifdef`/`#ifndef` stack text (up to 3 levels / 120 chars). Candidate labels, hover and search/callers/callees details show it as `conditional: ...`, and an unconditional definition wins the tie-break inside the same path-proximity layer. The text is **display-only and never evaluated**. A conventional file-level include guard is **transparent**: when the first meaningful directive is `#ifndef NAME` (or `#if !defined(NAME)` / `#if !defined NAME`), the same macro is defined at that depth before any other conditional directive, and the matching `#endif` ends the file, that frame is not recorded; inner non-guard conditionals inside the guard still are. On the measured corpus 27,967 of 118,730 symbols (23.6%) carry a condition, 2,070 distinct texts — down from 78,199 (65.9%) before guard suppression.
- **New command `Code Insight: Show Definition Candidates` (`si.showDefinitionCandidates`)** — an annotated QuickPick of definition groups (`included` / `not included`, `N copies`, `conditional: ...`) with an expandable copy picker; also available in the C/C++ editor context menu.
- **Consistent lists and goto.** `si.gotoDefinition` uses the same grouping and ranking as F12 (one entry per group, copy sub-picker). Symbol search, callers and callees append the same inclusion/conditional annotations to their details without reordering rows.
- **Snapshot v4.** The snapshot now stores a 64-bit content hash per file, the include CSR, the condition string table and a condition id per symbol. A v3 snapshot fails the version check and is **rebuilt once automatically after upgrading — no manual action**; unchanged files are then reused as usual. Snapshots that already say v4 but lack the metadata (written by an early build) are detected and rescanned once.
- **Single-strip parse (build/worker path).** The file text is stripped of comments/strings **once per file** on the build/worker path; symbol extraction, identifier hashes, include scanning and condition metadata all reuse that stripped text instead of stripping again in each helper. Content hash still runs on the raw text (one cheap pass). This removes two redundant full-file strips from the worker path. The incremental save path (`service.ts`) still calls `scanSource`, `scanIncludes` and `collectIdentifierHashes` separately — three strips of the one saved file — but that path handles a single small file, so it is not the build-path cost this change targets.
- **Measured performance.** On 6,838 C/H files / 118,730 symbols: snapshot 5.78 MB (0.7.0: 5.13 MB, **+12.7%**, now within the <15% target), load 31 ms in the saved post-fix run (28 ms pre-fix), search 4–5 ms, indexed find-references 1–2 ms (full scan 162 ms in the saved post-fix run; 158 ms pre-fix), callers / callees 6 ms / 1 ms in the saved post-fix run (5 ms / 0 ms pre-fix), ranking+grouping **~0.52 ms rank / ~0.84 ms group average** on the 470-definition hottest name (cold first call 2.62 ms; warm max observed 3.03 ms), content hash 101 ms for 74.9 MB (742 MB/s; 105 ms / 713 MB/s pre-fix), raw include scan 0.67 s single-threaded plus 0.13 s resolution (0.71 s + 0.14 s pre-fix). Warm-cache builds after the single-strip fix measured **1.71–1.89 s typical (median ~1.84 s; saved canonical run 1.89 s)** vs **1.97–2.13 s before** (0.7.0: 1.5–1.6 s). A/B in-process build phase: parse 1.40–1.60 s vs 1.63–1.78 s before (0.7.0: 1.17–1.23 s). The first cold run before the fix was 6.6 s; cold-cache runs were not repeated after the fix (they require dropping the page cache), and 0.7.0 had no cold run on this machine — its documented cold range is 5.7–6.5 s. Snapshot-resident memory after load is ~76 MB vs 72.5 MB (+3 MB); build RSS was 441–478 MB in the post-fix runs (canonical saved run 461.5 MB; interleaved A/B runs 539–588 MB vs 452–509 MB for 0.7.0).
- **Budget check:** snapshot growth is now **+12.7%**, within the <15% target; loaded-index memory meets <+20 MB. Build-time RSS was 441–478 MB in the post-fix runs (canonical saved run 461.5 MB), at or below the 0.7.0 range 452–509 MB, with the cold first run higher as previously documented; the interleaved A/B runs were 539–588 MB, so this is not a consistent win. F12 ranking/grouping averages ~0.52 ms rank / ~0.84 ms group, but the cold first call was 2.62 ms and the warm max observed was 3.03 ms, so the <2 ms warm maximum is **not met**. Single-strip reuse cut the warm build by ~8–13% (~0.2 s) and the worker scan pipeline CPU by ~32%, but the warm build remains **~15–20% slower than 0.7.0** (1.71–1.89 s typical vs 1.5–1.6 s), so the <10% target is **not met**. The residual is no longer redundant stripping: it is the 0.8.0 scan work itself (one strip, condition/include parsing, content hash, condition ids and the larger snapshot write), partly hidden at 4 workers by main-thread dispatch/message overhead.
- 285 tests pass.

### 中文

- **include 感知的候选排序**：同名多定义时，`F12`、悬停、调用层次、`si.gotoDefinition` 与 `si.showDefinitionCandidates` 会把当前文件经已解析 `#include` 图**可达**的定义排在前面。这是**软排序**：只重排、不过滤——没有任何索引内文件包含的定义仍会排在已包含的候选之后。include 图在同一次扫描中构建（实测语料 34,538 条原始 `#include` 指令，在两个索引根内得到 6,820 条边；系统头文件与根外文件不建边）。
- **重复副本折叠**：字节完全相同（64 位内容哈希相同）且名字/种类相同的定义在 F12 中折叠为一个位置；`si.showDefinitionCandidates` 每组显示一条，并可打开二级副本选择列出全部相同副本。折叠只改变展示、**不删除任何定义**，且只对内容完全相同的文件生效（空白或换行差异不会折叠）。实测最热名字（`START_TEST`，470 个定义）没有内容相同的副本，因此该语料上折叠未生效；它面向内核/驱动的多份拷贝。
- **条件编译标注**：每个符号记录其所在的原始 `#if`/`#ifdef`/`#ifndef` 栈文本（最多 3 层、120 字符）。候选标签、悬停与搜索/调用者/被调用者详情显示 `条件编译：...`；同一路径远近层内，无条件定义优先。该文本**只用于展示、不求值**。传统文件级 include guard 是**透明的**：若首条有内容的指令是 `#ifndef NAME`（或 `#if !defined(NAME)` / `#if !defined NAME`），同名宏在该层、任何其他条件指令之前定义，且配对的 `#endif` 是文件最后一条有内容的指令，则该帧不记录；guard 内层的非 guard 条件仍保留。实测 118,730 个符号中有 27,967 个（23.6%）带条件，共 2,070 种文本——抑制 guard 前为 78,199 个（65.9%）。
- **新命令 `Code Insight: 显示定义候选`（`si.showDefinitionCandidates`）**：带标注的定义分组 QuickPick（`包含` / `未包含`、`N 份副本`、`条件编译：...`），支持展开副本选择；C/C++ 编辑器右键菜单也可用。
- **列表与跳转一致**：`si.gotoDefinition` 与 F12 使用相同的分组与排序（每组一条、多副本组进入二级选择）。符号搜索、调用者、被调用者在详情中追加相同的包含/条件标注，且不重排结果。
- **快照 v4**：快照新增每文件 64 位内容哈希、include CSR、条件字符串表与每符号条件 id。v3 快照会因版本不匹配而被**在升级后自动重建一次——无需手动操作**；之后未变化的文件照常复用。已经是 v4 但缺少元数据的旧快照（早期构建写出）也会被识别并重扫一次。
- **单遍剥离（构建/worker 路径）**：构建/worker 路径上每个文件只剥离一次注释/字符串；符号提取、标识符哈希、include 扫描与条件元数据共用这份剥离结果，不再由各 helper 重复剥离。内容哈希仍按原始文本计算（一次廉价遍历）。worker 路径因此少做两次整文件剥离。增量保存路径（`service.ts`）仍分别调用 `scanSource`、`scanIncludes` 与 `collectIdentifierHashes`，即对保存的单个文件做三次剥离；但该路径只处理一个小文件，不是本次优化针对的构建路径开销。
- **实测性能**：对 6,838 个 C/H 文件 / 118,730 符号：快照 5.78 MB（0.7.0 为 5.13 MB，**+12.7%**，已进入 <15% 目标内），加载 31 ms（保存的修复后运行；修复前 28 ms），搜索 4–5 ms，倒排索引查找引用 1–2 ms（全量扫描 162 ms，保存的修复后运行；修复前 158 ms），调用者/被调用者 6 ms / 1 ms（保存的修复后运行；修复前 5 ms / 0 ms）；最热名字（470 个定义）的排序+分组平均 **rank 约 0.52 ms / group 约 0.84 ms**（首次冷调用 2.62 ms；热路径最大观测 3.03 ms），内容哈希 74.9 MB 用 101 ms（742 MB/s；修复前 105 ms / 713 MB/s），原始 include 扫描单线程 0.67 s + 解析 0.13 s（修复前 0.71 s + 0.14 s）。单遍剥离修复后热缓存构建实测 **1.71–1.89 s（中位数约 1.84 s；保存的基准运行 1.89 s）**，修复前为 **1.97–2.13 s**（0.7.0 为 1.5–1.6 s）。进程内 A/B 构建实测 parse 阶段 1.40–1.60 s vs 修复前 1.63–1.78 s（0.7.0：1.17–1.23 s）。修复前首次冷构建 6.6 s；修复后未重测冷盘（需清空页缓存），且 0.7.0 在本机没有冷盘运行，其文档冷盘区间为 5.7–6.5 s。加载后快照常驻内存约 76 MB vs 72.5 MB（+3 MB）；构建 RSS 在修复后各轮为 441–478 MB（保存的基准运行 461.5 MB；0.8.0 交替 A/B 轮 539–588 MB vs 0.7.0 452–509 MB）。
- **预算核对**：快照增长 **+12.7%**，进入 <15% 目标内；加载后的索引内存满足 <+20 MB。构建期 RSS 在修复后各轮为 441–478 MB（保存的基准运行 461.5 MB；441 低于 0.7.0 区间 452–509 MB，452–478 落在区间内），冷盘首轮更高（如先前记录）；交替 A/B 轮达 539–588 MB，因此不是稳定的改善。F12 排序/分组均值约 rank 0.52 ms / group 0.84 ms，但首次冷调用为 2.62 ms、热路径最大观测 3.03 ms，**<2 ms 热路径预算未达成**。单遍剥离让热缓存构建快约 **8–13%（约 0.2 s）**，worker 扫描流水线 CPU 降约 **32%**；但热缓存构建仍比 0.7.0 慢 **约 15–20%**（典型 1.71–1.89 s vs 1.5–1.6 s），**<10% 目标未达成**。残余开销不再是重复剥离，而是 0.8.0 新增扫描本身（一次剥离、条件/include 解析、内容哈希、条件 id 与更大的快照写入），且 4 workers 时部分被主线程派发/消息开销掩盖。
- 285 个单测通过。

## 0.7.0 — 2026-11-17

### English

- **Incremental symbol index**: saving a file no longer rewrites the whole snapshot. The save path appends a KB-sized delta record to `symbols.sidx.delta` (measured **904 B / 1 ms** for a 22-symbol file) and applies it to an in-memory overlay in **O(Δ)** — the column arrays are not rebuilt (measured **<1 ms**). The write is **O(Δ) in bytes, not in time**: each append validates the delta tail with an offset-only scan (no `SymbolEntry` decode), cached when only this process writes. Measured appends: first **0.47 ms**, **0.11 ms avg** steady-state, **0.44 ms** at a 4.09 MB delta (warm cache), and **4.32 ms** cold (read + scan of a 4.17 MB tail). Startup replays `base + delta`; the perf run replayed 1 record with an identical entry count.
- **Automatic compaction** merges deltas back into the base snapshot: above **4 MB** of delta or **500** changed files, after **60 s** idle, and on close. Measured on 118,730 symbols: **47 ms** to write the 5.13 MB base (plus 65 ms to flatten the overlay). `sourceInsight.autoCompact=false` only defers the automatic merges; deltas are still appended durably, and a **safety compaction** still runs at **5,000** changed files or a **32 MB** delta (queries may slow down with a large overlay).
- **Index size budget**: new `sourceInsight.maxSymbols` (default 2,000,000) and `sourceInsight.maxFiles` (default 120,000) settings. Exceeding either turns the status bar into a warning; beyond the hard limit of 5,000,000 symbols it turns into an error and a one-shot prompt offers to reconfigure the index roots. Builds over 80,000 actual files automatically downgrade concurrency to 2 workers.
- New command **`Code Insight: Show Index Diagnostics`** (`si.showIndexDiagnostics`): a Markdown report with base/delta sizes, pending changes, per-kind symbol counts, the last build summary, budget status and process memory. Delta read errors / dropped corrupt tails now produce a recovery warning there (and in the log).
- **Shared storage safety**: multiple windows on the same workspace share one index. The service tracks the size/record count it expects for the **symbols delta** (`symbols.sidx.delta`) and re-checks its size right before deleting it during compaction. If another window appended to it, the delta is kept (compaction and post-rebuild cleanup are skipped) and automatic compaction is disabled for the rest of the process lifetime to protect the other window's records — so the 5,000-change / 32 MB safety cap does not run in that state; reload the window to recover. This check does not cover the reference-index delta (`symbols.names.delta`), which is still deleted on rebuild/compaction. Concurrent windows may show stale results until reload; one window per workspace is recommended for now.
- **Compatibility**: the base snapshot format is still **v3** and unchanged. The "deltas are replayed" note refers only to the **reference index** (`symbols.names.delta`, already written by 0.6.x). 0.6.x wrote no symbol delta (`symbols.sidx.delta`), so a 0.6.x v3 symbol base loads as-is and **no rebuild is needed**; 0.6.x extensions simply ignore the new sidecar.
- 213 tests pass.

Measured on 6,838 C/H files / 118,730 symbols (same module set as 0.6.x): build 5.7 s, snapshot load 31 ms, symbol search 5 ms, indexed find-references 2 ms (full scan 1.16 s), callers / callees 5 ms / 1 ms — no regression versus 0.6.x.

### 中文

- **符号索引增量更新**：保存文件不再重写整个快照。保存路径只向 `symbols.sidx.delta` 追加一条 KB 级 delta 记录（22 符号的文件实测 **904 B / 1 ms**），并把它应用到内存 overlay，单文件更新为 **O(Δ)**——不重建列数组（实测 **<1 ms**）。写入成本是「**O(Δ) 字节**，但不是 O(Δ) 时间」：每次追加只按长度偏移扫描 delta 尾部（不解码 `SymbolEntry`），且只在仅本进程写入时命中缓存。实测追加：首次 **0.47 ms**、稳态均值 **0.11 ms**、4.09 MB delta 且缓存命中 **0.44 ms**、冷启动（读 + 扫描 4.17 MB 尾部）**4.32 ms**。启动时按 `base + delta` 重放；压测中重放 1 条记录后条目数一致。
- **自动 compaction**：delta 超过 **4 MB** 或累计 **500** 个文件变更、空闲 **60 s**、以及关闭扩展时，把增量合并回 base 快照。118,730 符号实测：写出 5.13 MB base 用 **47 ms**（overlay flatten 另计 65 ms）。`sourceInsight.autoCompact=false` 只推迟自动合并：delta 仍会逐次追加落盘，但到达**硬安全上限**（累计 **5,000** 个文件变更或 **32 MB** delta）时仍会强制合并一次（overlay 很大时查询可能变慢）。
- **索引规模预算**：新增 `sourceInsight.maxSymbols`（默认 2,000,000）与 `sourceInsight.maxFiles`（默认 120,000）。超过任一阈值状态栏变为警告；超过 5,000,000 符号的硬上限时变为错误，并一次性提示重新配置索引目录。实际文件数超过 80,000 时构建并发自动降到 2。
- 新命令 **`Code Insight: 索引诊断`**（`si.showIndexDiagnostics`）：Markdown 报告，含 base/delta 体积、待合并变更数、各类符号数、上次构建摘要、预算状态与进程内存。delta 读失败 / 损坏尾部被丢弃时，报告与日志会显示恢复警告。
- **共享存储安全**：同一工作区的多个窗口共享同一份索引。service 会记录**符号 delta**（`symbols.sidx.delta`）的预期大小/记录数，并在 compaction 删除前重新核对大小；若另一个窗口追加过记录，则保留该 delta（compaction 与 rebuild 后的清理都会跳过），并在本次进程生命周期内禁用自动 compaction 以保护对方记录——因此此时不会触发 5,000 个文件变更 / 32 MB 的安全上限；重新加载窗口即可恢复。该检查不覆盖引用索引 delta（`symbols.names.delta`），后者在 rebuild/compaction 时仍会被删除。并发窗口可能看到过期结果，直到重新加载——目前建议一个工作区只开一个窗口。
- **兼容性**：base 快照格式仍为 **v3** 且未改动。「delta 会被重放」只针对**引用索引**（`symbols.names.delta`，0.6.x 已存在）。0.6.x 没有写过符号 delta（`symbols.sidx.delta`），因此 0.6.x 的 v3 符号 base 可直接加载，**无需重建索引**；0.6.x 旧版扩展会忽略新增的旁路文件。
- 213 个单测通过。

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
