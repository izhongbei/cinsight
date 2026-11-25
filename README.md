# Code Insight

> Code navigation for large C/C++ codebases: an independent, persistent and incrementally updated symbol index (functions, types, members, enum constants and globals) — no `compile_commands.json`, no clangd, no external tools.

On codebases with more than a hundred thousand C/H files (measured on **121,606 files / 2.6 GB / 1.08 M function definitions**), IntelliSense-style indexing is slow and often incomplete because of complex build configurations. Code Insight parses the sources itself and keeps its own symbol database, so go-to-definition, symbol search and find-references answer from the local index in milliseconds.

[中文说明](#中文说明) · [GitHub](https://github.com/izhongbei/cinsight)

## Features

| Feature | How to use |
|---|---|
| **Go to definition** | `F12` / `Ctrl+Click` on a call or a type name; falls back to the header prototype / forward declaration when no definition exists |
| **Type navigation** | `struct` / `union` / `enum` tags and `typedef` names (anonymous structs and function-pointer typedefs included) are indexed like functions |
| **Member, enum and global symbols** | Struct/union members, enum constants and file-scope globals are indexed with their parent type; hover and list details show `member of struct sk_buff`, `enumerator of enum E` or `variable` |
| **Field jump** | `F12` on `p->field`, `v.field` or `.field =` jumps to the member definition with that name — a lexical lookup, **no type inference**: every same-name member is a candidate (ranked by include/distance, capped at 50, duplicate-folded), and no member match falls back to the normal definition |
| **Smart candidate order** | When a name has many definitions (multiple kernel/driver copies), `F12` / hover / call hierarchy list the one closest to your cursor first (same index root, then shared path prefix) |
| **Include-aware jump** | Definitions reachable from the current file through the resolved `#include` graph are listed first — a **soft** ordering: candidates are reordered, never dropped |
| **Duplicate folding** | Files with identical content (same 64-bit content hash) plus the same name and kind are folded into one `F12` location; `Show Definition Candidates` expands every copy |
| **Conditional annotations** | Symbols inside `#if` / `#ifdef` / `#ifndef` blocks show the raw condition text in candidates, hover and list details (the text is not evaluated; conventional file-level include guards are transparent) |
| **Symbol search** | `Ctrl+T` (native *Go to Symbol in Workspace*) or `Code Insight: Search Symbols` (lists name, `file:line` location and kind/parent — no signature; accepts `@func` / `@type` / `@macro` / `@member` / `@enum` / `@var` filters) |
| **Find references** | `Shift+F12`; progress, cancellable, results cached |
| **Symbol highlight (F8)** | `F8` on a name highlights every occurrence in the **current file** — by default definitions and references use the active theme's find-match colours (`editor.findMatch*` / `editor.findMatchHighlight*`) and follow light/dark theme switches automatically; `F3` / `Shift+F3` jump to the next / previous occurrence (wrapping around) and `F8` again clears. Comments, strings and character literals are ignored, so only real code matches. The status bar shows `N in file / M index refs`, and decorations follow edits (150 ms debounce). The `F8` binding is scoped to C/C++ editors, so it overrides *Next Problem* only there; `F3` / `Shift+F3` are taken over only while a highlight is active |
| **Call hierarchy** | `Code Insight: Show Callers / Show Callees`, plus the native VS Code call hierarchy view |
| **Call graph panel** | `Code Insight: Show Call Graph` opens a Source-Insight-style **Relation** panel: a compact single-column tree with collapsible **Callers (N)** and **Callees (N)** sections, plus a **Graph** tab with the three-column callers/current/callees view. Click a name to open its definition in the editor group; **Set as root** (hover action or Alt+click) re-roots the panel and auto-loads both directions |
| **Symbol tree** | The **Code Insight** icon in the Activity Bar: folders → files → symbols (`:line · kind`; hover shows the signature), loaded on demand. Each file shows up to `sourceInsight.treeSymbolLimit` symbols (default 2000, independent of the search limit); beyond that an overflow hint suggests raising it |
| **Hover signature** | Hover a function name to see `return type name(params)` and its definition/declaration location; members/enum constants/globals get their parent/kind line |
| **Document outline** | `Ctrl+Shift+O` lists functions, types and — nested under their type — members and enum constants |
| **Index diagnostics** | `Code Insight: Show Index Diagnostics` opens a Markdown report with base/delta sizes, pending changes, per-kind symbol counts, the last build summary, budget status and memory |
| **Index management** | Status bar shows index state and symbol count; commands to configure roots, rebuild, clear cache |

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

Offline install: download the `code-insight-<version>.vsix` for the release you want (for example `code-insight-0.9.0.vsix`) and run

```bash
code   --install-extension code-insight-0.9.0.vsix
cursor --install-extension code-insight-0.9.0.vsix
# or: Ctrl+Shift+P → Extensions: Install from VSIX...
```

Requires a host with **VS Code ≥ 1.90** (Cursor 3.x qualifies). No C/C++ extension is required — the built-in C/C++ grammar already provides the language id.

## Getting started

1. Open your C project folder (`File → Open Folder`).
2. Run **`Code Insight: Configure Index Roots`** and pick the directories to index (e.g. `component`, `plat`, `plugin`).
3. Confirm the rebuild; the status bar shows progress, then `$(symbol-function) <count> symbols`.
4. Open any `.c` file, put the cursor on a function call and press `F12`.

> Nothing is indexed by default — you choose explicitly, so kernel copies, vendor libraries and build output stay out. `.git`, `build`, `tmp` and `node_modules` are excluded by default. Directories that are symbolic links are listed in the picker too (marked `(symlink)`); choosing one indexes its target, and a Browse selection made through the target's real path is mapped back to the workspace-relative path.

## Commands

| Command | ID |
|---|---|
| Configure Index Roots | `si.configureRoots` |
| Rebuild Index | `si.rebuildIndex` |
| Search Symbols | `si.searchSymbol` |
| Go to Definition | `si.gotoDefinition` |
| Show Definition Candidates | `si.showDefinitionCandidates` |
| Find References | `si.findReferences` |
| Show Callers | `si.showCallers` |
| Show Callees | `si.showCallees` |
| Show Call Graph | `si.showCallGraph` |
| Show Index Diagnostics | `si.showIndexDiagnostics` |
| Highlight Symbol | `si.highlightSymbol` |
| Next Occurrence | `si.nextOccurrence` |
| Previous Occurrence | `si.prevOccurrence` |
| Clear Index Cache | `si.clearCache` |

The editor context menu offers go-to-definition, find-references and callers/callees in C/C++ files; the view title bar offers search, rebuild and configure.

### Call graph panel

`Show Call Graph` opens a panel titled `Call Graph: <name>` with two tabs. **Relation** (default) is a compact single-column tree with collapsible **Callers (N)** and **Callees (N)** sections; expanding a node inside a section keeps that direction (the callers of a caller, the callees of a callee). Clicking a name opens its definition in an editor group and never changes the root or moves the panel. **Set as root** — the hover action on a row, or Alt+click — re-roots the panel to that node and auto-loads its callers and callees without a code jump. The toolbar re-roots from the function under the cursor and collapses every nested expansion. **Graph** keeps the three-column callers/current/callees view and its click-to-jump/expand behaviour. Empty sections show `No callers` / `No callees`; the existing per-direction (100) and total (300) caps, cycle skipping and deduplication still apply.

`F8` (`Highlight Symbol`) is contributed for C/C++ editors only; while a highlight is active, `F3` / `Shift+F3` are bound to `si.nextOccurrence` / `si.prevOccurrence`. Outside a C/C++ editor — or outside an active highlight — the VS Code defaults (*Next Problem*, *Find Next*) still apply. Clicking the highlight status bar item toggles the highlight off.

### `@kind` search filters

The Search Symbols input box accepts optional kind filters: `@func`, `@type` (struct / union / enum / typedef), `@macro`, `@member`, `@enum` (enum constants) and `@var` (file-scope globals). Multiple filters are OR-ed, matching is case-insensitive, whitespace is normalised, and an unknown `@token` stays in the query text. Examples: `@member len`, `@var len`, `@type sk`, `@enum E_`. The command id stays `si.searchSymbol`; `@func` matches the `function` kind only (prototypes and forward declarations use the separate `declaration` kind and have no dedicated token).

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `sourceInsight.indexRoots` | `[]` | Directories to index (workspace-relative); empty = nothing indexed |
| `sourceInsight.exclude` | `["**/.git/**","**/build/**","**/tmp/**","**/node_modules/**"]` | Excluded globs (`*`, `**`, `?`) |
| `sourceInsight.maxFileSizeKB` | `4096` | Skip source files larger than this |
| `sourceInsight.concurrency` | `4` | Worker threads used while building the index |
| `sourceInsight.maxSymbols` | `3000000` | Warn (status bar) when the index has more symbols than this; above the hard maximum of `6000000` the status bar shows an error and a one-shot prompt offers to narrow the roots |
| `sourceInsight.maxFiles` | `120000` | Warn (status bar) when the index has more files than this |
| `sourceInsight.autoCompact` | `true` | Merge index deltas back into the base snapshot on idle / after many changes / on close. When `false` automatic merges are deferred (deltas are still appended durably), but a safety compaction still runs at 5,000 changed files or a 32 MB delta; queries may slow down with a large overlay. While a shared-storage symbols-delta conflict is active, automatic compaction (including this safety cap) stays off until the window is reloaded |
| `sourceInsight.searchLimit` | `200` | Maximum results per search |
| `sourceInsight.treeSymbolLimit` | `2000` | Maximum symbols shown per file in the symbol tree (independent of `searchLimit`) |
| `sourceInsight.autoReindexOnSave` | `true` | Re-parse a file when it is saved, created or deleted |
| `sourceInsight.enableCallHierarchy` | `true` | Also register the native call hierarchy provider |
| `sourceInsight.followSymlinks` | `false` | Follow symbolic links while walking roots |
| `sourceInsight.highlightDefinitionColor` | `""` | CSS colour for the F8 *definition* highlight (e.g. `#2ea04366` / `rgba(46,160,67,0.25)`); applies to background, border and overview ruler. Empty = theme's `editor.findMatchBackground` / `editor.findMatchBorder` |
| `sourceInsight.highlightReferenceColor` | `""` | CSS colour for the F8 *reference* highlight (e.g. `#ffc40066` / `rgba(255,196,0,0.25)`). Empty = theme's `editor.findMatchHighlightBackground` / `editor.findMatchHighlightBorder` |

After changing `indexRoots` / `exclude` / `maxFileSizeKB`, run **Rebuild Index** (the extension prompts you). The two highlight colours never affect the index: they only rebuild the decorations and re-apply the active highlight immediately.

The `6,000,000` hard symbol budget is **advisory only** (status-bar error plus a one-shot prompt; indexing is not refused). It is deliberately kept: v5 stores ~27 B per symbol plus shared string tables, so the cap is a memory-pressure signal rather than a hard limit.

## How it works

```
sources ──walk──> file list ──mtime+size delta──> changed files
                                                     │
                              worker_threads ×N ─────┤ lexing + definition detection
                                                     ▼
                        compact symbol table (functions / prototypes / macros / types / typedefs / members / enum constants / globals)
                                                     │
                                       binary snapshot symbols.sidx (extension storage)
                                                     ▼
                    definition / references / hover / outline / workspace symbols / call hierarchy
```

- The parser works on bytes so line and column numbers stay stable. A single-pass state machine blanks comments, string literals and `#define` continuations, then detects definitions and declarations at file scope ("type + name + balanced parentheses + `{`/`;`") and matches braces to get each function body range.
- The snapshot is a **columnar** binary format (format v5: string tables + typed arrays + name/file/condition/parent lookup tables, a 64-bit content hash per file, an include-edge CSR, and a condition id plus a parent id per symbol). **206,430 symbols load in 40 ms** in the saved 0.9.0 run (the 0.8.0 v4 snapshot: 118,730 symbols / 31 ms). v5 adds a 4 B parent id per symbol on top of v4's 4 B condition id and 8 B content hash per file; unchanged files reuse their previous symbols. A v4 snapshot is **rebuilt once automatically** after upgrading — no manual action.
- Saving a file is **incremental**: the extension appends a KB-sized delta record (`symbols.sidx.delta`) and applies it to an in-memory overlay in O(Δ), instead of rewriting the snapshot or rebuilding the column arrays (0.9.0 measured **1.1 KB / 1 ms** appended with the v3 delta and **<1 ms** overlay update for a 23-symbol file). The write is **O(Δ) in bytes**, not in time: each append validates the delta tail with an offset-only scan (no `SymbolEntry` decode), cached when only this process writes — measured **0.10 ms avg** steady-state, **0.51 ms** near a 4.13 MB delta and **7.30 ms** for a cold read + scan of a 4.22 MB tail in the saved run (0.8.0: 0.11 / 0.74 / 5.48 ms). At startup saved deltas are replayed on top of the base snapshot; deltas over **4 MB** or **500** changed files, after **60 s** idle, and on close are compacted back into the base (0.9.0 measured **60 ms** for a 10.16 MB base with 206,430 symbols; 0.8.0: 45 ms for 5.78 MB). `sourceInsight.autoCompact=false` only defers these merges: a safety compaction still runs at **5,000** changed files or a **32 MB** delta, except while a shared-storage delta conflict is active. The base format is now v5: a v4 snapshot is rebuilt once automatically after upgrading (no manual action), and unchanged files are reused after that.
- A per-file **identifier hash index** (`symbols.names`, ~3.6 MB for 6,838 files) makes find-references read only the files that can contain the identifier instead of the whole tree: measured **1 candidate file vs 6,838**, **1–2 ms vs 144 ms** for a full scan in the 0.9.0 saved run (0.8.0 saved run: 162 ms). 32-bit collisions can add candidate files but never hide a reference, because each candidate is verified by exact word-boundary matching.
- The index is built in **one pass**: the parse worker strips comments/strings **once** per file and reuses that text for symbols, identifier hashes and the raw `#include` list; the 64-bit content hash runs on the raw text. Each source file is read exactly once, and include targets are then resolved against the indexed file set.
- The reference index is loaded **lazily** on the first find-references / call-hierarchy request (saves ~194 ms and ~69 MB at activation on a 68k-file corpus) and updated **incrementally**: saving a file appends a <1 KB delta record instead of rewriting the index, and deltas are merged back automatically.
- References and call relationships are scanned on demand: content prefilter first, then exact word-boundary matching; callers are derived from the line hit, callees only parse the target function body.
- No third-party runtime dependency; fully offline.

## Performance

Measured on a module set of **6,838 C/H files / 75 MB** (0.9.0 saved warm run; 0.8.0 history in parentheses):

| Metric | 0.9.0 result (0.8.0 history) |
|---|---|
| Symbols | **206,430**: 51,165 members + 26,936 enum constants + 9,510 globals = 87,611 new-kind symbols, **+87,700 vs 0.8.0** (the extra 89 are existing-kind count changes from B3 scan/typedef fixes); 78,101 carry a `parent` (37.8% of all symbols — every member and enum constant), 9,002 distinct parent names (0.8.0: 118,730 symbols, no members/enums/globals) |
| Include graph | 34,538 raw `#include` directives → 6,820 resolved edges in the indexed roots (**19.7%**, per-file de-duplicated; 3,027 files; system headers and out-of-root targets add no edge; unchanged vs 0.8.0) |
| Conditional symbols | 40,890 / 206,430 (**19.8%**) record a condition; 2,309 distinct texts (0.8.0: 27,967 / 118,730 = 23.6%, 2,070 texts). The ratio is lower because the new members/enums/globals are mostly unconditional; the absolute count grew by 12,923 |
| Content hashes | 6,838 / 6,838 files (64-bit; unchanged vs 0.8.0) |
| Index build, single strip (4 workers) | **2.14 s** canonical warm run; interleaved A/B runs **2.14–2.45 s (median ~2.24 s)** vs **1.64–1.85 s (median ~1.68 s)** for 0.8.0 on the same corpus — **+34%** total, parse phase **median 1.86 s vs 1.38 s (+35%)**. The <20% build-overhead target is **not met**. 0.8.0 history: 1.71–1.89 s typical (median ~1.84 s; 1.97–2.13 s before the single-strip fix) |
| Snapshot size / load (columnar v5) | **10.16 MB / 40 ms** in the saved run (0.8.0 v4: 5.78 MB / 31 ms) — **+75.8%**, above the <35% target. The growth is the 87,611 new symbols at 27 B each, the larger name table and the new parent table (186.6 KB) |
| Hashing / include scan cost | **102 ms** for 74.9 MB hashed (**737 MB/s**); **672 ms** raw include scan + **121 ms** resolution (single-threaded, page-warm; 0.8.0 history: 101 ms / 742 MB/s, 0.67 s + 0.13 s) |
| Definition ranking + grouping (`F12`) | rank avg **0.91 ms** / group avg **1.38 ms** on the hottest name (`public`, 1,001 definitions); cold first call 4.61 ms; warm max observed 1.14 ms rank / 2.50 ms group (0.8.0: ~0.52 ms / ~0.84 ms on a 470-definition name) |
| **Field jump (`->` / `.`)** | **0.94 ms avg / 1.22 ms max** on the hottest member name (`public`, 1,001 member definitions, top-50 cap; `findByName` + kind filter + rank + group) — within the **<5 ms** target |
| Per-file save (incremental symbol index) | **1.1 KB / 1 ms** appended (v3 delta); overlay update **<1 ms** (23-symbol file; 0.8.0: ~1 KB v2 delta) |
| Delta append tail validation | **0.10 ms avg** steady-state; **0.51 ms** at a 4.13 MB delta (warm cache); **7.30 ms** cold read + offset scan of a 4.22 MB tail (0.8.0: 0.11 / 0.74 / 5.48 ms) |
| Delta compaction (206,430 symbols) | **60 ms** to write a 10.16 MB base in the saved run (0.8.0: 45 ms for 5.78 MB) |
| Symbol search (limit 50) | **8 ms** (0.8.0: 4–5 ms) |
| Exact name lookup | <1 ms |
| Signature reconstruction (first read) | 1 ms in the saved run (page-cache dependent; 0.8.0: 1–10 ms) |
| Find references, full scan | 144 ms in the saved run (0.8.0 saved run: 162 ms) |
| Find references, **indexed** | **1–2 ms** (1 candidate file out of 6,838) |
| Reference index size / load (lazy, first use) | 3.57 MB / **19 ms** (0.8.0: 3.57 MB / 15 ms; 68k-file corpus: 69 MB / ~194 ms) |
| Callers / callees | 7 ms / 0 ms (0.8.0: 6 ms / 1 ms) |
| Snapshot-resident memory (after load) | **~84 MB** vs **~75 MB** for the 0.8.0 v4 snapshot measured the same way (**+9 MB, +12%**) |
| Peak RSS during build | 544 MB in the saved run; 463–544 MB across runs (0.8.0 canonical saved run: 461.5 MB) |

- **Budget check (0.9.0):** the **field-jump <5 ms** target is met (0.94 ms avg / 1.22 ms max on a 1,001-definition member name). The **snapshot <+35%** target is **not met**: 10.16 MB vs 5.78 MB (+75.8%), driven by 87,611 new symbols. The **build overhead <20%** target is **not met**: interleaved A/B medians 2.24 s vs 1.68 s (+34%), with the extra cost in the parse phase (median 1.86 s vs 1.38 s) where the three new scans run over the same stripped text. Loaded-snapshot memory grew by ~9 MB (+12%). F12 ranking/grouping rose to ~0.91 ms rank / ~1.38 ms group because the hottest name now has 1,001 definitions (members named `public`) instead of 470; the warm group max was 2.50 ms.
- 0.8.0 history: snapshot 5.78 MB (+12.7% vs 0.7.0, within the <15% target), load 31 ms, build 1.71–1.89 s typical, search 4–5 ms, indexed find-references 1–2 ms (full scan 162 ms), ranking ~0.52 ms rank / ~0.84 ms group on the 470-definition hottest name, loaded memory ~76 MB. 0.7.0 measured 5.13 MB / 72.5 MB and a 1.5–1.6 s warm build.
- Indexing `plat` alone (5,573 files / 57.5 MB): 74,194 symbols in 0.8.0; 0.9.0 adds members/enums/globals on top and was not re-measured separately.
- A single-threaded scan of all 121,606 files (2.6 GB) takes ~157 s; configure `indexRoots` per module so you only index what you actually browse.

> Find-references and call relationships first narrow the candidate set through the per-file identifier index, then read and lex only those files. The index is built once with the symbol index (the parse worker returns hashes, content hashes and include directives in the same pass) and maintained incrementally: saving one file only refreshes that file's slice. Results are cached per snapshot.

## Known limitations

- Heuristic parsing, not a full C front end: functions produced by macro expansion, old K&R parameter lists and unusual function-pointer forms may be missed (header prototypes still let you jump).
- Indexed symbols: functions, function prototypes, function-like macros, `struct`/`union`/`enum` tags, `typedef` names, struct/union members, enum constants and file-scope globals. **Function-local variables and parameters are not indexed.**
- **Field jump does not infer types**: `p->field` / `v.field` is a lexical check (`.`, `->` immediately before the cursor word) followed by a name lookup of *all* members named `field` in the index — same-name members of unrelated structs are candidates too, ordered by the normal include/distance ranking and capped at 50. A `.`/`->` inside a string or comment can trigger the lookup; when no member matches, the normal definition path runs.
- **`@func` filters the `function` kind only**: prototypes and `struct foo;` forward declarations are stored as `declaration`, so they have no dedicated `@kind` token and are matched by the unfiltered query text.
- **Attribute after a type body**: in `typedef struct { ... } __attribute__((packed)) foo_t;` the `foo_t` typedef *symbol* is still missed (alias extraction is not attribute-aware); its members are still indexed with `foo_t` as `parent`.
- **Anonymous type bodies**: members of an anonymous `struct`/`union` body are indexed with the first typedef alias as `parent`; without an alias they are skipped. An anonymous enum without a typedef uses `<anonymous>` as parent. Members of a named inline nested type body are only indexed as the outer member, not recursively.
- **Conditional text is not evaluated**: definitions of the same name in different `#if` branches all appear as candidates, and the annotation shows the raw `#if`/`#ifdef` stack rather than the branch a given build takes. Conventional file-level include guards (`#ifndef NAME` + `#define NAME` … final `#endif`, or `#if !defined(NAME)` / `#if !defined NAME`) are transparent; an `#ifndef` without that `#define`, with a same-depth `#else`/conditional before it, or that does not cover the whole file still counts as a condition. The same guard suppression applies to the new member / enum-constant / global symbols.
- **`#else` / `#elif` branches are not distinguished**: a definition inside such a branch displays the enclosing condition text, the same as the `#if` branch.
- **Ranking is soft**: include-visible definitions are preferred but never filtered; a same-named definition that no indexed file includes still appears after the included ones.
- **Include edges are resolved when a file is scanned** and reused for unchanged files: after adding or restoring headers (branch switch, `git checkout`) run **Rebuild Index** or save the includer to refresh its edges. The index cannot discover newly appearing targets for files whose mtime/size did not change, because raw `#include` directives are not stored in the snapshot.
- **Angled includes use the same heuristic as quoted ones**: `#include <x.h>` is resolved with the same directory → as-is → `indexRoots` search (the quote/angle flag is not stored in the snapshot), so a sibling file with a matching name inside the roots can be treated as included. This only affects the **soft** ranking — no candidate is dropped.
- **Duplicate folding only applies to identical content**: files must share the same 64-bit content hash (plus the same name and kind); the same code with different whitespace, line endings or comments keeps separate entries.
- Reference scanning is textual (with comment/string stripping), not semantic; same-named but unrelated symbols match too; first searches on huge roots are bound by disk throughput.
- **Single-root workspaces only**: only the first workspace folder is indexed and `indexRoots` is resolved against it, so multi-root workspaces (`.code-workspace`, common with SSH Remote) index just the first folder. Workaround: open a parent folder that contains all the roots as a single-folder workspace, or use one window per folder. Multi-root support is planned for a later release.
- **Symlinked directories are supported as index roots.** The *Configure Index Roots* picker lists directories that are symbolic links (marked `(symlink)`) but never recurses into them, so the workspace never escapes through an unexpected link; selecting one indexes its target (the OS follows a root link even when it is the root itself). Browse selections made through a target's real path outside the workspace are mapped back to the workspace-relative `<symlink>/<suffix>` path when the target is reachable through a top-level or one-level-deep directory symlink; only genuinely unmappable paths are skipped with a warning. `sourceInsight.followSymlinks` still controls whether symlinks *nested inside* the indexed tree are traversed.
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

> 面向大型 C/C++ 工程的代码导航扩展：自建**独立、持久、可增量更新**的符号索引（函数、类型、成员、枚举常量与全局变量），不依赖编译数据库、clangd 或任何外部工具。

十几万文件级的仓库（实测 **121,606 个 C/H 文件、2.6 GB、108 万个函数定义**）往往编译配置复杂、工程庞大，靠 IntelliSense 建索引慢且经常不完整。Code Insight 自己解析源码并维护符号库，跳转、搜索、引用都走本地索引，毫秒级响应。

## 功能

| 功能 | 入口 |
|---|---|
| **跳转定义** | 光标在函数调用或类型名处按 `F12` / `Ctrl+Click`；无定义时回退到头文件原型 / 前置声明 |
| **类型跳转** | `struct` / `union` / `enum` 标签与 `typedef` 名字（含匿名结构体、函数指针 typedef）和函数一样进索引 |
| **成员 / 枚举 / 全局符号** | 结构体/联合体成员、枚举常量与文件作用域全局变量带父类型进索引；悬停与列表详情显示 `member of struct sk_buff` / `enumerator of enum E` / `variable` |
| **字段跳转** | 在 `p->field`、`v.field`、`.field =` 上按 `F12` 跳到同名成员定义——纯词法判断、**不做类型推导**：所有同名成员都是候选（按 include/距离排序，上限 50，重复副本折叠），无成员命中时回退普通定义 |
| **候选智能排序** | 同名有很多定义时（多份内核/驱动拷贝），`F12` / 悬停 / 调用层次会把「离光标最近」的排在前面（同索引根 → 共享路径前缀） |
| **include 感知跳转** | 当前文件经已解析 `#include` 图可达的定义排在前面——**软排序**：只重排、不丢候选 |
| **重复副本折叠** | 内容完全相同（64 位内容哈希一致）且名字/种类相同的文件在 `F12` 中折叠为一个位置；`显示定义候选`（`si.showDefinitionCandidates`）可展开每个副本 |
| **条件编译标注** | `#if` / `#ifdef` / `#ifndef` 块内的符号在候选、悬停与列表详情中显示原始条件文本（不求值；传统文件级 include guard 透明） |
| **符号搜索** | `Ctrl+T`（原生"转到工作区中的符号"）或命令 `Code Insight: 搜索符号`（列出名字、位置（`file:line`）与种类/parent——不含签名；支持 `@func` / `@type` / `@macro` / `@member` / `@enum` / `@var` 过滤） |
| **查找所有引用** | `Shift+F12`；带进度、可取消，结果缓存 |
| **符号高亮（F8）** | 在名字上按 `F8` 高亮它在**当前文件**中的全部出现——默认定义与引用都使用当前主题的 find-match 颜色（`editor.findMatch*` / `editor.findMatchHighlight*`），切换明/暗主题时自动跟随；`F3` / `Shift+F3` 跳到下一个 / 上一个匹配（首尾循环），再按 `F8` 清除。注释、字符串与字符字面量会被忽略，只高亮真实代码；状态栏显示 `N in file / M index refs`，编辑后 150 ms 防抖重扫。`F8` 只在 C/C++ 编辑器内生效（仅在那里覆盖「下一个问题」），`F3` / `Shift+F3` 只在有高亮时接管 |
| **调用关系** | 命令 `Code Insight: 显示调用者 / 显示被调用者`，也可用 VS Code 原生调用层次界面逐层展开 |
| **调用关系图** | 命令 `Code Insight: 调用关系图` 打开 Source Insight 风格的关系面板：默认 **Relation** 标签页为单列紧凑树，含 **调用者 / 被调用者** 两个可折叠 section，可逐层展开；**Graph** 标签页保留中间当前函数、左调用者、右被调用者的三列视图。点击名字在代码编辑器组打开定义；**设为根**（悬停操作或 Alt+点击）以该节点为根并自动加载双向 |
| **侧边栏符号窗口** | 左侧活动栏的「Code Insight」图标 → 目录 → 文件 → 符号（显示 `:line · 种类`；签名见悬停），按需加载；每个文件最多显示 `sourceInsight.treeSymbolLimit` 个符号（默认 2000，与搜索上限独立），超出时显示提示并建议调大该值 |
| **悬停签名** | 悬停函数名显示 `返回类型 函数名(参数)` 与定义/声明位置；成员/枚举常量/全局变量额外显示 parent/种类 |
| **文档大纲** | `Ctrl+Shift+O` 列出当前文件的函数、类型，以及嵌套在类型下的成员与枚举常量 |
| **索引诊断** | 命令 `Code Insight: 索引诊断` 打开 Markdown 报告：base/delta 体积、待合并变更、各类符号数、上次构建摘要、预算状态与内存占用 |
| **索引管理** | 状态栏显示索引状态与符号数量；命令：配置索引目录、重建索引、清除缓存 |

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

离线安装：下载与版本对应的 `code-insight-<version>.vsix`（例如 `code-insight-0.9.0.vsix`）后执行

```bash
code   --install-extension code-insight-0.9.0.vsix
cursor --install-extension code-insight-0.9.0.vsix
```

要求宿主 **VS Code ≥ 1.90**（Cursor 3.x 满足），无需另装 C/C++ 扩展。

## 首次使用

1. 打开你的 C 工程目录（`File → Open Folder`）。
2. 命令面板执行 **`Code Insight: 配置索引目录`**，勾选要索引的目录（例如 `component`、`plat`、`plugin`）。
3. 确认重建，状态栏显示进度，完成后显示 `$(symbol-function) <符号数> 个符号`。
4. 打开任意 `.c` 文件，光标放到函数调用上按 `F12`。

> 默认**不索引任何目录**，由你显式选择，避免误索引内核副本、第三方库和构建产物。默认排除 `.git`、`build`、`tmp`、`node_modules`。符号链接目录同样会出现在选择列表中（标注 `(symlink)`）：选中后索引其目标；用 Browse 对话框选中目标的真实路径时，也会映射回工作区内相对路径。

## 命令

| 命令 | ID |
|---|---|
| 配置索引目录 | `si.configureRoots` |
| 重建索引 | `si.rebuildIndex` |
| 搜索符号 | `si.searchSymbol` |
| 跳转定义 | `si.gotoDefinition` |
| 显示定义候选 | `si.showDefinitionCandidates` |
| 查找所有引用 | `si.findReferences` |
| 显示调用者 | `si.showCallers` |
| 显示被调用者 | `si.showCallees` |
| 调用关系图 | `si.showCallGraph` |
| 索引诊断 | `si.showIndexDiagnostics` |
| 高亮符号 | `si.highlightSymbol` |
| 下一个匹配 | `si.nextOccurrence` |
| 上一个匹配 | `si.prevOccurrence` |
| 清除索引缓存 | `si.clearCache` |

编辑器右键菜单在 C/C++ 文件中提供跳转定义、查找引用与调用者/被调用者；符号视图标题栏提供搜索、重建与配置。

### 调用关系面板

`显示调用关系图` 打开标题为 `调用关系图：<名字>` 的面板，包含两个标签页。**Relation**（默认）是单列紧凑树，分 **调用者 (N)** 与 **被调用者 (N)** 两个可折叠 section；在某个 section 内展开节点时保持同一方向（调用者的调用者、被调用者的被调用者）。单击名字会在代码编辑器组打开定义，**不会改变根、也不会移动面板**；**设为根**（行上的悬停操作，或 Alt+点击）会把该节点设为新根，并自动加载它的调用者与被调用者，且不跳转代码。工具栏支持「以光标处函数为根」和「全部折叠」。**Graph** 标签页保留原有三列视图（左调用者 / 中当前函数 / 右被调用者）及其点击跳转、展开/折叠行为。空 section 显示 `无调用者` / `无被调用者`；原有的单方向（100）与全图（300）上限、跳过环、去重逻辑保持不变。

`F8`（高亮符号）只在 C/C++ 编辑器中注册；有高亮时 `F3` / `Shift+F3` 绑定到 `si.nextOccurrence` / `si.prevOccurrence`。在其他语言、或没有活动高亮时，仍使用 VS Code 默认的「下一个问题」/「查找下一个」。点击高亮状态栏项可关闭高亮。

### `@kind` 搜索过滤

符号搜索输入框支持可选的种类过滤词：`@func`、`@type`（struct / union / enum / typedef）、`@macro`、`@member`、`@enum`（枚举常量）、`@var`（文件作用域全局变量）。多个过滤词取并集、大小写不敏感、空白会归一；未知的 `@token` 原样保留在查询文本里。示例：`@member len`、`@var len`、`@type sk`、`@enum E_`。命令 id 仍为 `si.searchSymbol`；`@func` 只匹配 `function`，函数原型与 `struct foo;` 前置声明属于单独的 `declaration` 种类，没有专用过滤词。

## 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `sourceInsight.indexRoots` | `[]` | 要索引的目录（相对 workspace 根），空 = 不索引 |
| `sourceInsight.exclude` | `["**/.git/**","**/build/**","**/tmp/**","**/node_modules/**"]` | 排除的 glob（`*` / `**` / `?`） |
| `sourceInsight.maxFileSizeKB` | `4096` | 超过该大小的源文件跳过 |
| `sourceInsight.concurrency` | `4` | 建索引的 worker 线程数 |
| `sourceInsight.maxSymbols` | `3000000` | 符号数超过该值时状态栏警告；超过硬上限 `6000000` 时状态栏报错并一次性提示缩小索引目录 |
| `sourceInsight.maxFiles` | `120000` | 文件数超过该值时状态栏警告 |
| `sourceInsight.autoCompact` | `true` | 空闲 / 累计变更较多 / 关闭时把索引增量合并回 base。`false` 时自动合并被推迟（delta 仍逐次追加，不丢数据），但到达安全上限（累计 5000 个文件变更或 32 MB delta）时仍会强制合并一次；overlay 很大时查询可能变慢。共享存储的符号 delta 冲突期间，自动 compaction（含该安全上限）会停用，直到重新加载窗口 |
| `sourceInsight.searchLimit` | `200` | 单次搜索返回上限 |
| `sourceInsight.treeSymbolLimit` | `2000` | 符号树中每个文件最多显示的符号数（与 `searchLimit` 独立） |
| `sourceInsight.autoReindexOnSave` | `true` | 保存/新建/删除文件时增量重解析 |
| `sourceInsight.enableCallHierarchy` | `true` | 注册原生调用层次 Provider |
| `sourceInsight.followSymlinks` | `false` | 是否跟随符号链接 |
| `sourceInsight.highlightDefinitionColor` | `""` | F8 高亮中「定义」出现的 CSS 颜色（如 `#2ea04366` / `rgba(46,160,67,0.25)`），同时作用于背景、边框与概览标尺；空 = 跟随主题 `editor.findMatchBackground` / `editor.findMatchBorder` |
| `sourceInsight.highlightReferenceColor` | `""` | F8 高亮中「引用」出现的 CSS 颜色（如 `#ffc40066` / `rgba(255,196,0,0.25)`）；空 = 跟随主题 `editor.findMatchHighlightBackground` / `editor.findMatchHighlightBorder` |

修改 `indexRoots` / `exclude` / `maxFileSizeKB` 后建议执行一次 **重建索引**。两个高亮颜色不影响索引：只重建装饰类型并立即重新应用当前高亮。

`6000000` 符号硬上限只是**告警阈值**（状态栏报错 + 一次性提示，不会拒绝建索引），刻意保留：v5 每符号约 27 B（另加共享字符串表），它用于提示内存压力而不是硬性限制。

## 工作原理

- 解析器按字节工作，行号列号稳定；单遍状态机剥离注释、字符串、`#define` 续行，在文件作用域按"类型 + 名字 + 平衡括号 + `{`/`;`"判定定义与声明，并做花括号配对得到函数体范围。
- 快照为**列式**二进制格式（v5：字符串表 + TypedArray + 名字/文件/条件/parent 查找表，每文件 64 位内容哈希、include 边 CSR、每符号条件 id 与 parent id）。保存的 0.9.0 运行中 **206,430 符号加载约 40 ms**（0.8.0 的 v4 快照：118,730 符号 / 31 ms）。v5 在 v4 的每符号 4 B 条件 id、每文件 8 B 内容哈希之外，再增加每符号 4 B parent id。未变化的文件直接复用旧符号；v4 快照升级后会自动重建一次（无需手动操作）。
- 保存文件是**增量**的：只向 `symbols.sidx.delta` 追加一条 KB 级 delta 记录，并在内存 overlay 上做 O(Δ) 更新，不再重写快照、也不重建列数组（0.9.0 实测 23 符号文件追加 **1.1 KB / 1 ms**（v3 delta）、overlay 更新 **<1 ms**）。写入成本是「**O(Δ) 字节**，但不是 O(Δ) 时间」：每次追加只按记录长度偏移扫描 delta 尾部（不解码 `SymbolEntry`），且只在仅本进程写入时命中缓存——实测稳态均值 **0.10 ms**、4.13 MB delta 附近 **0.51 ms**、冷启动读 + 扫描 4.22 MB 尾部 **7.30 ms**（0.8.0：0.11 / 0.74 / 5.48 ms）。启动时把已保存的 delta 重放在 base 快照之上；delta 超过 **4 MB** 或累计 **500** 个文件变更、空闲 **60 s** 以及关闭时合并回 base（0.9.0 实测 206,430 符号写出 10.16 MB base 用 **60 ms**；0.8.0：118,730 符号 / 5.78 MB 用 45 ms）。`sourceInsight.autoCompact=false` 只推迟这些合并：到达 **5,000** 个文件变更或 **32 MB** delta 的安全上限时仍会强制合并一次（共享存储 delta 冲突期间除外）。base 格式已升为 v5：v4 快照升级后自动重建一次（无需手动操作），之后未变化文件照常复用。
- 每个文件的**标识符哈希倒排索引**（`symbols.names`，6,838 文件约 3.6 MB）让查找引用只读可能包含该名字的文件：实测**候选文件 1 个 vs 6,838 个**，0.9.0 保存运行 **1–2 ms vs 全量扫描 144 ms**（0.8.0 保存运行 162 ms）。32 位哈希碰撞只会多出候选文件，不会漏报——候选文件仍按词边界精确校验。
- 索引**单遍构建**：解析 worker 对每个文件只剥离注释/字符串一次，符号、标识符哈希与原始 `#include` 列表共用该结果，64 位内容哈希按原始文本计算；每个源码文件只读一次，include 目标随后按索引内文件集合解析。
- 引用索引**惰性加载**（首次查找引用/调用层次才读盘；68k 文件语料约省 194 ms 与 69 MB），并**增量维护**：保存一个文件只追加 <1 KB 的 delta 记录，超阈值自动合并回 base。
- 引用与调用关系先用「每文件标识符倒排索引」缩小候选集，只对候选文件读盘并做词法剥离与词边界精确匹配。
- 无第三方运行时依赖，离线可用。

## 性能

对 **6,838 个 C/H 文件 / 75 MB** 的模块集合实测（0.9.0 保存的热缓存运行；括号内为 0.8.0 历史）：

| 指标 | 0.9.0 结果（0.8.0 历史） |
|---|---|
| 符号 | **206,430**：成员 51,165 + 枚举常量 26,936 + 全局变量 9,510 = 87,611 个新增种类符号，相对 0.8.0 **+87,700**（多出的 89 个来自 B3 扫描/typedef 修复导致的既有种类数量变化）；78,101 个带 `parent`（占全部符号 37.8%，所有成员与枚举常量都有），9,002 种 parent 名（0.8.0：118,730 符号，无成员/枚举/全局） |
| include 图 | 34,538 条原始 `#include` 指令 → 索引根内 6,820 条边（**19.7%**，按文件去重；3,027 个文件；系统头文件与根外目标不建边；与 0.8.0 相同） |
| 条件符号 | 40,890 / 206,430（**19.8%**）带条件标注，2,309 种文本（0.8.0：27,967 / 118,730 = 23.6%，2,070 种文本）。比例下降是因为新增的成员/枚举/全局大多无条件；带条件的绝对数量增加了 12,923 个 |
| 内容哈希 | 6,838 / 6,838 个文件（64 位；与 0.8.0 相同） |
| 建索引（单遍剥离，4 workers） | 保存运行 **2.14 s**；交替 A/B 运行 **2.14–2.45 s（中位数约 2.24 s）**，同语料 0.8.0 为 **1.64–1.85 s（中位数约 1.68 s）**——总计 **+34%**，parse 阶段 **中位数 1.86 s vs 1.38 s（+35%）**。**<20% 的构建开销目标未达成**。0.8.0 历史：热缓存典型 1.71–1.89 s（中位数约 1.84 s；单遍剥离修复前 1.97–2.13 s） |
| 快照体积 / 加载（列式 v5） | 保存运行 **10.16 MB / 40 ms**（0.8.0 v4：5.78 MB / 31 ms）——**+75.8%**，超过 <35% 目标。增长来自 87,611 个新符号（每符号 27 B）、更大的名字表与新增的 parent 表（186.6 KB） |
| 哈希 / include 扫描成本 | 74.9 MB 内容哈希 **102 ms**（**737 MB/s**）；原始 include 扫描单线程 **672 ms** + 解析 **121 ms**（页缓存热；0.8.0 历史：101 ms / 742 MB/s、0.67 s + 0.13 s） |
| 定义排序 + 分组（`F12`） | 最热名字（`public`，1,001 个定义）上 rank 均值 **0.91 ms** / group 均值 **1.38 ms**；首次冷调用 4.61 ms；热路径最大观测 rank 1.14 ms / group 2.50 ms（0.8.0：470 个定义时 rank 约 0.52 ms / group 约 0.84 ms） |
| **字段跳转（`->` / `.`）** | 最热成员名（`public`，1,001 个成员定义，截断 50）上 **均值 0.94 ms / 最大 1.22 ms**（`findByName` + kind 过滤 + rank + group）——满足 **<5 ms** 目标 |
| 保存单文件（增量符号索引） | 追加 **1.1 KB / 1 ms**（v3 delta）；overlay 更新 **<1 ms**（23 符号文件；0.8.0：约 1 KB v2 delta） |
| delta 尾部校验 | 稳态均值 **0.10 ms**；4.13 MB delta 附近 **0.51 ms**（热缓存）；冷读 + 偏移扫描 4.22 MB 尾部 **7.30 ms**（0.8.0：0.11 / 0.74 / 5.48 ms） |
| delta compaction（206,430 符号） | 保存运行写出 10.16 MB base 用 **60 ms**（0.8.0：5.78 MB / 45 ms） |
| 符号搜索（上限 50） | **8 ms**（0.8.0：4–5 ms） |
| 按名精确查找 | <1 ms |
| 签名重建（首次读取） | 保存运行 1 ms（与页缓存有关；0.8.0：1–10 ms） |
| 查找引用，全量扫描 | 保存运行 144 ms（0.8.0 保存运行 162 ms） |
| 查找引用，**倒排索引** | **1–2 ms**（候选文件 1 个 / 6,838 个） |
| 引用索引体积 / 加载（惰性，首次使用） | 3.57 MB / **19 ms**（0.8.0：3.57 MB / 15 ms；68k 文件语料：69 MB / 约 194 ms） |
| 调用者 / 被调用者 | 7 ms / 0 ms（0.8.0：6 ms / 1 ms） |
| 加载后快照常驻内存 | **约 84 MB**，同法测得 0.8.0 v4 快照约 **75 MB**（**+9 MB，+12%**） |
| 构建期峰值 RSS | 保存运行 544 MB；各轮 463–544 MB（0.8.0 保存的基准运行 461.5 MB） |

- **预算核对（0.9.0）**：**字段跳转 <5 ms** 目标达成（1,001 个成员定义的最热名字上均值 0.94 ms / 最大 1.22 ms）。**快照 <+35%** 目标**未达成**：10.16 MB vs 5.78 MB（+75.8%），由 87,611 个新符号推动。**构建开销 <20%** 目标**未达成**：交替 A/B 中位数 2.24 s vs 1.68 s（+34%），额外成本在 parse 阶段（中位数 1.86 s vs 1.38 s），即三趟新扫描运行在同一份剥离文本上。加载后快照常驻内存增加约 9 MB（+12%）。F12 排序/分组升至 rank 约 0.91 ms / group 约 1.38 ms，因为最热名字现在有 1,001 个定义（名为 `public` 的成员）而不是 470 个；热路径 group 最大观测 2.50 ms。
- 0.8.0 历史：快照 5.78 MB（相对 0.7.0 为 +12.7%，在 <15% 目标内）、加载 31 ms、构建典型 1.71–1.89 s、搜索 4–5 ms、倒排索引查找引用 1–2 ms（全量 162 ms）、最热名字（470 个定义）上 rank 约 0.52 ms / group 约 0.84 ms、加载后内存约 76 MB。0.7.0 实测 5.13 MB / 72.5 MB、热缓存构建 1.5–1.6 s。
- 单独索引 `plat`（5,573 文件 / 57.5 MB）：0.8.0 为 74,194 符号；0.9.0 在此基础上增加成员/枚举/全局，未单独重测。
- 全量 121,606 个文件（2.6 GB）单线程扫描约 157 s；建议按模块配置 `indexRoots`，只索引实际浏览的目录。

> 查找引用与调用关系先用「每文件标识符倒排索引」缩小候选集，只对候选文件读盘并做词法剥离与词边界精确匹配。索引随符号索引一次构建（解析 worker 在同一次扫描中返回哈希、内容哈希与 include 指令），并增量维护：保存一个文件只刷新该文件的切片。结果按快照缓存。

## 已知限制

- 启发式解析：宏展开生成的函数、K&R 老式参数表、极端函数指针写法可能漏识别（头文件原型可兜底跳转）。
- 已索引：函数、函数原型、函数式宏、`struct`/`union`/`enum` 标签、`typedef` 名字、结构体/联合体成员、枚举常量与文件作用域全局变量。**函数内局部变量与参数不索引。**
- **字段跳转不推断类型**：`p->field` / `v.field` 只是词法判断（光标词前是否紧跟 `.` / `->`），再按名字查找索引中**所有**同名成员——不相关结构体的同名成员同样是候选，按既有 include/距离软排序，上限 50。字符串或注释里的 `.`/`->` 也可能触发该查找；没有成员命中时回退普通定义路径。
- **`@func` 只匹配 `function` 种类**：函数原型与 `struct foo;` 前置声明属于 `declaration` 种类，没有专用 `@kind` 过滤词，只能用不带过滤词的查询匹配。
- **类型体之后带属性**：`typedef struct { ... } __attribute__((packed)) foo_t;` 仍会丢失 `foo_t` 的 typedef **符号**（别名提取未做属性感知）；成员仍以 `foo_t` 作为 `parent` 正常索引。
- **匿名类型体**：匿名 `struct`/`union` 体的成员以第一个 typedef 别名作为 `parent` 索引；没有别名时跳过。无 typedef 的匿名 enum 以 `<anonymous>` 为 parent。具名内联嵌套类型的内部成员不会递归索引，只索引外层成员。
- **条件文本不求值**：同一名字在多个 `#if` 分支的定义都会出现在候选里，标注显示原始 `#if`/`#ifdef` 栈，而不是某次构建实际走的分支。传统文件级 include guard（`#ifndef NAME` + `#define NAME` … 文件末尾 `#endif`，或 `#if !defined(NAME)` / `#if !defined NAME`）透明；无同名 `#define`、同层提前出现其他条件、或未覆盖整个文件的 `#ifndef` 仍算条件。该保护宏抑制同样适用于新增的成员/枚举常量/全局变量。
- **`#else` / `#elif` 分支不区分**：这类分支里的定义同样显示外层条件文本，与 `#if` 分支一致。
- **排序是软排序**：已包含的定义优先，但不过滤；没有任何索引内文件包含的同名定义仍会排在后面。
- **include 边在扫描文件时解析**，未变化的文件复用旧边：新增或恢复头文件（切分支、`git checkout`）后请执行 **重建索引** 或保存 includer 来刷新它的边。文件的 mtime/size 未变化时，索引无法发现新出现的目标，因为快照里不保存原始 `#include` 指令。
- **尖括号 include 与引号形式使用同一套启发式**：`#include <x.h>` 同样按「相对目录 → 原样 → `indexRoots`」解析（快照不保存引号/尖括号标记），因此索引根内同名的兄弟文件可能被当作已包含。这只影响**软排序**，不会丢弃候选。
- **重复副本折叠只对内容完全相同生效**：必须 64 位内容哈希一致（且名字/种类相同）；仅空白/换行/注释不同的相同代码不会折叠。
- 引用扫描是文本级（已剥离注释/字符串），不是语义级；首次在大仓库上受磁盘吞吐限制。
- **只支持单根工作区**：只索引第一个 workspace folder，`indexRoots` 相对它解析；因此多根工作区（`.code-workspace`，SSH Remote 场景常见）只会索引第一个文件夹。绕过方式：把包含所有根目录的父文件夹作为单个工作区打开，或每个文件夹单独开一个窗口。多根支持计划在后续版本提供。
- **支持把符号链接目录作为索引根。** *配置索引目录* 会列出指向目录的符号链接（标注 `(symlink)`），但不会递归进入链接，避免通过意外链接逃出工作区；选中后索引其目标（根本身是符号链接时，操作系统会跟随根链接）。用 Browse 对话框在目标真实路径（工作区外）下选择时，只要目标能通过顶层或下一层目录符号链接到达，就会映射回工作区内 `<链接名>/<后缀>` 路径；只有确实无法映射的路径才会告警跳过。`sourceInsight.followSymlinks` 仍然只控制是否遍历索引树**内部嵌套**的符号链接。
- **同一个工作区打开多个窗口会共享同一份索引**（`context.storageUri`）。共享存储安全检查只覆盖**符号 delta**（`symbols.sidx.delta`）；引用索引 delta（`symbols.names.delta`）在 rebuild/compaction 时仍会被删除。若另一个窗口也在追加符号 delta，本窗口会在删除前重新核对大小，保留该 delta，并在本次进程生命周期内禁用自动 compaction（保护对方的记录），因此此时不会触发 5,000 个文件变更 / 32 MB 的安全上限。并发窗口可能看到过期结果，直到重新加载索引——**重新加载窗口即可恢复**。目前建议**一个工作区只开一个窗口**。
- 倒排索引会让索引占用增加约三分之一；标识符以 32 位哈希存储，碰撞只会增加候选文件（命中前仍精确校验），不会漏报。
- 需要 C/C++ 语言标识（`.c`/`.h` 以 `c`/`cpp` 打开，内置语法即可提供）。

## 隐私与安全

- **纯本地运行**：不联网、不上报数据、不收集遥测。
- 只读取 `sourceInsight.indexRoots` 内的 C/C++ 源码，快照写入扩展自己的存储目录。
- 不执行被索引的代码，不调用外部工具（不依赖 ctags / clangd / compile_commands.json）。
- 不修改工作区文件。

## 反馈

问题与建议请提交到 <https://github.com/izhongbei/cinsight/issues>。

## License

MIT
