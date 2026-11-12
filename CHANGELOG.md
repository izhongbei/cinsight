# Changelog

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
