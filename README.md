# Code Insight

> 面向大型 C/C++ 工程的代码导航扩展：自建**独立、持久、可增量更新**的函数符号索引，不依赖编译数据库、clangd 或任何外部工具。

十几万文件级的嵌入式固件仓库（实测 **121,606 个 C/H 文件、2.6 GB、108 万个函数定义**）往往编译配置复杂、工程庞大，靠 IntelliSense 建索引慢且经常不完整。Code Insight 自己解析源码并维护符号库，跳转、搜索、引用都走本地索引，毫秒级响应。

## 功能

| 功能 | 入口 |
|---|---|
| **跳转定义** | 光标在函数调用处按 `F12` / `Ctrl+Click`；无定义时回退到头文件原型声明 |
| **函数搜索** | `Ctrl+T`（VS Code 原生"转到工作区中的符号"）或命令 `Code Insight: 搜索函数`（列出签名与位置） |
| **查找所有引用** | `Shift+F12`；带进度、可取消，结果缓存 |
| **调用关系** | 命令 `Code Insight: 显示调用者 / 显示被调用者`；还可使用 VS Code 原生调用层次界面逐层展开 |
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

或在扩展面板搜索 **Code Insight** 后点击安装。

离线安装：下载 `code-insight-0.1.0.vsix` 后

```bash
code   --install-extension code-insight-0.1.0.vsix
cursor --install-extension code-insight-0.1.0.vsix
# 或 Ctrl+Shift+P → Extensions: Install from VSIX...
```

要求宿主 **VS Code ≥ 1.90**（Cursor 3.x 满足）。无需安装 C/C++ 扩展即可使用——内置 C/C++ 语法高亮已足够提供语言标识。

## 首次使用

1. 打开你的 C 工程目录（`File → Open Folder`）。
2. 命令面板执行 **`Code Insight: 配置索引目录`**，勾选要索引的目录（例如 `component`、`plat`、`plugin`）。
3. 确认重建，右下角状态栏显示进度；完成后显示 `$(symbol-function) <符号数> 个函数`。
4. 打开任意 `.c` 文件，把光标放到函数调用上按 `F12`。

> 默认**不索引任何目录**——由你显式选择，避免误索引内核副本、第三方库、构建产物等无关代码。默认排除 `.git`、`build`、`tmp`、`node_modules`。

## 命令

| 命令 | ID |
|---|---|
| 配置索引目录 / Configure Index Roots | `si.configureRoots` |
| 重建索引 / Rebuild Index | `si.rebuildIndex` |
| 搜索函数 / Search Function | `si.searchSymbol` |
| 跳转定义 / Go to Definition | `si.gotoDefinition` |
| 查找所有引用 / Find References | `si.findReferences` |
| 显示调用者 / Show Callers | `si.showCallers` |
| 显示被调用者 / Show Callees | `si.showCallees` |
| 清除索引缓存 / Clear Index Cache | `si.clearCache` |

在 C/C++ 文件的右键菜单中提供跳转定义、查找引用、显示调用者/被调用者；活动栏视图标题栏提供搜索、重建、配置目录按钮。

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

修改 `indexRoots` / `exclude` / `maxFileSizeKB` 后建议执行一次 **重建索引**（扩展会提示）。

## 工作原理

```
源码目录 ──遍历──> 文件清单 ──mtime+size 增量──> 变更文件
                                                   │
                             worker_threads ×N ────┤ 词法剥离 + 定义识别
                                                   ▼
                                  紧凑符号表（函数定义 / 原型声明 / 函数式宏）
                                                   │
                                    二进制快照 symbols.sidx（扩展存储目录）
                                                   ▼
                  定义 / 引用 / 悬停 / 大纲 / 工作区符号 / 调用层次
```

- 解析器按字节工作，行号列号稳定；单遍状态机剥离注释、字符串、`#define` 续行，在文件作用域按"类型 + 名字 + 平衡括号 + `{`/`;`"判定定义与声明，并做花括号配对得到函数体范围。
- 快照为二进制格式（字符串表 + 紧凑整数数组），约 **20–30 MB / 100 万符号**，启动加载 < 500 ms；文件未变化则直接复用旧符号。
- 引用与调用关系按需扫描：先按文件内容预筛，再按词边界精确匹配；调用者用命中行反推所在函数，被调用者只解析目标函数的行区间。
- 无第三方运行时依赖，离线可用。

## 性能

对一个 **6,838 个 C/H 文件 / 75 MB** 的模块集合实测：

| 指标 | 实测 |
|---|---|
| 符号总数 | 98,930 |
| 建索引（4 worker，冷缓存） | 6.5 s |
| 快照体积 / 加载 | 3.87 MB / 28 ms |
| 函数搜索（limit 50） | 11 ms |
| 精确按名查找 | 8 ms |
| 签名重建（首次读文件） | 56 ms |
| 查找引用（首次，全文扫描 75 MB） | 4.2 s（缓存后 0 ms） |
| 调用者 / 被调用者 | 14 ms / 13 ms |
| 进程内存（含建索引） | 约 335 MB |

- 只索引 `plat`（5,573 文件 / 57.5 MB）：74,194 符号，热缓存下建索引 0.8–1.2 s，不变增量重建 0.5 s。
- 全量 12 万文件（2.6 GB）单线程扫描约 157 s；建议按模块配置 `indexRoots`，只索引你真正浏览的代码。

> 查找引用与调用关系是**按需全文扫描**：先用内容预筛，只对候选文件做词法剥离。在慢速网络盘上大目录首次会较慢，但带进度、可取消，结果有缓存。

## 已知限制

- 启发式解析，不做完整 C 语法分析：宏展开生成的函数、K&R 老式参数表、极端函数指针写法可能漏识别（头文件原型声明可兜底跳转）。
- 只索引函数、函数原型与函数式宏；结构体/枚举/变量的跳转不在当前范围。
- 不做预处理分支求值，同一名字在多个 `#if` 分支的定义会同时出现在候选里（可在原生候选列表中选择）。
- 引用扫描是文本级 + 词法剥离，不是语义级；同名不同类型会一起命中；首次在大仓库上受磁盘吞吐限制。
- 只支持单根工作区（取第一个 workspace folder）；`indexRoots` 必须是工作区内相对路径。
- 依赖 C/C++ 语言标识（`.c`/`.h` 以 `c`/`cpp` 打开即可，内置语法高亮满足）。

## 隐私与安全

- **纯本地运行**：不联网、不上报数据、不收集遥测。
- 只读取你在 `sourceInsight.indexRoots` 中配置的 C/C++ 源码；符号快照写入扩展自己的存储目录。
- 不执行被索引的代码，不调用外部工具（不依赖 ctags / clangd / compile_commands.json）。
- 不修改工作区文件：扩展只读源码、只写自己的快照。

## 反馈

问题与建议请提交到扩展仓库的 Issues（地址见 `package.json` 的 `repository` 字段）。

## License

MIT
