# Source Insight C

> 参考 Source Insight 的 VS Code 代码导航扩展：为大型 C/C++ 工程建立**独立、持久、可增量更新**的函数符号索引，不依赖编译数据库、clangd 或任何外部工具。

面向的场景：像 `rcios/` 这样的嵌入式固件仓库（实测 **121,606 个 C/H 文件、2.6 GB、108 万个函数定义**），编译配置复杂、工程庞大，靠 IntelliSense 建索引慢且经常不完整。Source Insight C 自己解析源码并维护符号库，跳转/搜索/引用都走本地索引，毫秒级响应。

## 功能

| 功能 | 入口 |
|---|---|
| **跳转定义** | 光标在函数调用处按 `F12` / `Ctrl+Click`；无定义时回退到头文件原型声明 |
| **函数搜索** | `Ctrl+T`（VS Code 原生"转到工作区中的符号"）或命令 `Source Insight: 搜索函数`（QuickPick，显示签名与位置） |
| **查找所有引用** | `Shift+F12`；带进度、可取消，结果缓存 |
| **调用关系** | 右键 → `Source Insight: 显示调用者 / 显示被调用者`；开启 `enableCallHierarchy` 后还支持 VS Code 原生调用层次（可交互逐层展开） |
| **侧边栏符号窗口** | 左侧 Activity Bar 的「Source Insight」图标 → 目录 → 文件 → 函数（签名摘要），懒加载 |
| **悬停签名** | 悬停函数名显示 `返回类型 函数名(参数)` + 定义/声明位置 |
| **文档大纲** | `Ctrl+Shift+O` 列出当前文件函数 |
| **索引管理** | 状态栏显示索引状态/函数数量；命令：配置索引目录、重建索引、清除索引缓存 |

## 安装

本仓库已构建好 `source-insight-c-0.1.0.vsix`：

```bash
# VS Code
code --install-extension source-insight-c-0.1.0.vsix
# Cursor（基于 VS Code 1.128，已验证可安装）
cursor --install-extension source-insight-c-0.1.0.vsix
```

或在编辑器里 `Ctrl+Shift+P` → `Extensions: Install from VSIX...` 选择该文件。要求宿主 **VS Code ≥ 1.90**（Cursor 3.x 满足）。

## 首次使用

1. 打开你的 C 工程目录（`File → Open Folder`）。
2. 命令面板执行 **`Source Insight: 配置索引目录`**，勾选要索引的目录（例如 `rcios/component`、`rcios/plat`、`rcios/plugin`）。
3. 选择后确认重建，右下角状态栏显示进度；完成后显示 `$(symbol-function) SI: <符号数> 函数`。
4. 打开任意 `.c` 文件，把光标放到函数调用上按 `F12`。

> 默认**不索引任何目录**——由你显式选择，避免误索引 `datapath/kernel`（Linux 内核副本，1.3 GB）这类无关代码。默认排除 `.git`、`build`、`tmp`、`node_modules`。

## 命令

| 命令（中文 / English） | ID |
|---|---|
| 配置索引目录 / Configure Index Roots | `si.configureRoots` |
| 重建索引 / Rebuild Index | `si.rebuildIndex` |
| 搜索函数 / Search Function | `si.searchSymbol` |
| 跳转定义 / Go to Definition | `si.gotoDefinition` |
| 查找所有引用 / Find References | `si.findReferences` |
| 显示调用者 / Show Callers | `si.showCallers` |
| 显示被调用者 / Show Callees | `si.showCallees` |
| 清除索引缓存 / Clear Index Cache | `si.clearCache` |

## 配置

| 配置项 | 默认 | 说明 |
|---|---|---|
| `sourceInsight.indexRoots` | `[]` | 要索引的目录（相对 workspace 根），空 = 不索引 |
| `sourceInsight.exclude` | `["**/.git/**","**/build/**","**/tmp/**","**/node_modules/**"]` | 排除的 glob（支持 `*` / `**` / `?`） |
| `sourceInsight.maxFileSizeKB` | `4096` | 超过该大小的源文件跳过 |
| `sourceInsight.concurrency` | `4` | 建索引的 worker 线程数 |
| `sourceInsight.searchLimit` | `200` | 单次搜索返回上限 |
| `sourceInsight.autoReindexOnSave` | `true` | 保存/新建/删除文件时增量重解析 |
| `sourceInsight.enableCallHierarchy` | `true` | 注册原生调用层次 Provider |
| `sourceInsight.followSymlinks` | `false` | 是否跟随符号链接 |

配置变更后建议执行一次 **重建索引**（`indexRoots`/`exclude`/`maxFileSizeKB` 变化会提示）。

## 工作原理

```
源码目录 ──walk──> 文件清单 ──mtime+size 增量──> 变更文件
                                                   │
                              worker_threads ×N ────┤ scanSource（C 词法 + 定义识别）
                                                   ▼
                                   紧凑符号表（函数定义 / 原型声明 / 函数式宏）
                                                   │
                                    二进制快照 symbols.sidx（扩展存储目录）
                                                   ▼
               Provider：定义 / 引用 / 悬停 / 大纲 / 工作区符号 / 调用层次
```

- 解析器按字节（latin1）工作，行号列号稳定；单遍状态机剥离注释、字符串、`#define` 续行，深度 0 处按"类型 + 名字 + 平衡括号 + `{`/`;`"判定定义与声明，并做花括号配对得到函数体范围。
- 快照为二进制格式（字符串表 + `Int32` 数组），约 **20–30 MB / 100 万符号**，启动时加载 < 500 ms；文件未变则直接复用旧符号。
- 引用与调用关系按需扫描磁盘：先按文件内容 `indexOf` 预筛，再按词边界精确匹配；`callers` 用命中行反推所在函数，`callees` 只解析目标函数的行区间。
- 无第三方运行时依赖；离线可用。

## 性能（本仓库实测，2026-11-09）

`npm run perf` 在 `rcios/plat` + `rcios/plugin`（6,838 文件 / 75 MB）上的真实数据：

| 指标 | 实测 |
|---|---|
| 符号总数 | **98,930**（function 31,776 / declaration 33,523 / macro 8,895 的比例由 `rcios/plat` 单库测得） |
| 建索引（4 worker，含冷盘读） | **6.5 s** |
| 快照体积 / 加载 | **3.87 MB** / **28 ms** |
| 符号搜索（`searchSymbols`，limit 50） | **11 ms** |
| 精确按名查找 | 8 ms |
| 签名重建（首次读文件） | 56 ms |
| 查找引用（首次，全文扫描 75 MB） | 4.2 s（结果缓存后 0 ms） |
| 调用者 / 被调用者（命中引用缓存） | 14 ms / 13 ms |
| 进程 RSS（含建索引） | 335 MB |

其它规模参考：

| 场景 | 数据 |
|---|---|
| 仅 `rcios/plat`（5,573 文件 / 57.5 MB） | 74,194 符号；4 worker 热缓存 **0.8–1.2 s**，不变增量重建 0.5 s，快照 3.06 MB / 加载 18 ms |
| 全量 `rcios/`（121,606 文件 / 2.6 GB）原型扫描 | 单线程 157 s（40–60 s 可并行化）；建议按模块配置 `indexRoots` |
| 本机文件系统吞吐 | 约 **22 MB/s**（`/mnt/data` 慢速挂载，`rg` 全扫同量数据 14 s）——引用扫描受此限制 |

> 引用扫描/调用者是**按需全文扫描**（先用 `indexOf` 预筛，只对候选文件做词法剥离），
> 在慢速网络盘上的大根目录首次会较慢，但带进度、可取消、结果有 LRU 缓存。
> 想要毫秒级引用，可后续加"索引期建调用名倒排索引"（v1 未做，见路线图）。

## 已知限制

- 启发式解析，不做完整 C 语法分析：宏展开生成的函数、K&R 老式参数表、极端函数指针写法可能漏识别（头文件原型声明可兜底跳转）。
- 只索引函数、函数原型与函数式宏；结构体/枚举/变量的跳转不在 v1 范围。
- 不做预处理分支求值，同一名字在多个 `#if` 分支的定义会同时出现在候选里（VS Code 原生候选列表可让你选择）。
- 引用扫描是文本级 + 词法剥离，不是语义级；同名不同类型会一起命中；首次在大仓库上受磁盘吞吐限制（见性能小节）。
- 只支持单根工作区（取第一个 workspace folder）；`indexRoots` 必须是工作区内相对路径。
- 快照约 41 B/符号（100 万符号 ≈ 41 MB），略高于设计目标 30 MB。
- 依赖 C/C++ 语言标识（`.c`/`.h` 需以 `c`/`cpp` languageId 打开；VS Code/Cursor 内置 C/C++ 语法高亮即满足，无需 cpptools）。
- 本机无 `code` CLI，界面交互需在你的 VS Code 安装后人工验收（见下）。

## 安装后自测清单

1. 首次打开 C 工程 → 左侧出现「Source Insight」图标，视图显示引导页。
2. 执行"配置索引目录"，只勾一个中等目录（如 `rcios/plat`）→ 状态栏出现进度，结束后显示函数数量。
3. 打开 `rcios/plat/` 下任意 `.c`，光标放在一个跨文件调用的函数名上按 `F12` → 跳到定义文件对应行。
4. `Ctrl+T` 输入函数名片段 → 结果列表含文件与行，回车跳转。
5. 在函数声明处 `Shift+F12` → 找到调用点列表。
6. 右键函数 →"显示被调用者"→ 列出它调用的函数；"显示调用者"→ 列出调用它的函数。
7. 悬停函数名 → 出现签名与 `定义: 路径:行`。
8. 左侧符号树展开目录/文件 → 显示函数，点击跳转。
9. 修改并保存一个 `.c` 文件，等 1 秒 → 新函数随即能被 `Ctrl+T` 搜到（增量索引）。
10. 命令"清除索引缓存" → 状态栏回到未配置/索引为空。

## 开发

```bash
npm install          # 安装构建依赖（本机用 --cache 规避只读 ~/.npm）
npm run compile      # tsc -> dist/
npm test             # 编译 + node:test 单元测试
npm run smoke        # mock vscode 激活冒烟（无需真实 VS Code）
npm run perf          # 对真实仓库建索引并测查询耗时
npm run package      # 生成 source-insight-c-0.1.0.vsix
```

目录结构见 `docs/superpowers/specs/2026-11-09-source-insight-vscode-design.md`。

## License

MIT
