# Changelog

## 0.1.1

- README 改为中英双语（英文在前、中文在后），补充隐私与安全、反馈章节。
- package.json 补充 `repository` / `homepage` / `bugs`：Open VSX 页面显示 Repository 链接，README 反馈入口可用。
- 与 0.1.0 索引快照格式完全兼容，升级后无需重建索引。

## 0.1.0 (Code Insight)

- 定名 **Code Insight**（扩展 ID `cinsight.code-insight`）。
- 补齐运行时中文语言包 `l10n/bundle.l10n.zh-cn.json`（72 条文案）。

初版，参考 Source Insight 的核心代码浏览体验：

- 函数符号索引：自研 C 词法/定义识别，worker 多线程并行，二进制快照持久化，mtime+size 增量更新。
- 跳转定义（F12 / Ctrl+Click），无定义时回退到头文件原型声明。
- 函数搜索：Ctrl+T（Workspace Symbol）+ `Source Insight: 搜索函数` QuickPick。
- 查找所有引用（Shift+F12），支持取消与进度。
- 调用关系：原生 Call Hierarchy（调用者 / 被调用者）+ QuickPick 两种入口。
- 左侧 Activity Bar「Source Insight」符号树：目录 → 文件 → 函数（签名摘要），懒加载。
- 悬停签名与定义/声明位置；文档大纲（Ctrl+Shift+O）。
- 状态栏索引状态与符号数量；命令：配置索引目录、重建索引、清除索引缓存。
- 默认不索引任何目录，由用户显式配置；默认排除 `.git`/`build`/`tmp`/`node_modules`。
- 中英双语（VS Code l10n）。
