# 发布 Code Insight

三种渠道，按用途选一个或多个：

| 渠道 | 谁能用 | 审核/成本 | 适用 |
|---|---|---|---|
| **A. VSIX 分发** | VS Code、Cursor 都能装 | 无审核，免费 | 内部团队、不想公开 |
| **B. Open VSX** | Cursor（官方指定）、VS Code forks（VSCodium/Theia/Gitpod 等） | 免费，无人工审核，自动扫描 | **想公开发布、覆盖 Cursor** |
| **C. VS Code Marketplace** | 只覆盖微软官方 VS Code | 需 Azure DevOps 账号 + PAT，有扫描 | 想覆盖 VS Code 用户 |

> 关键事实：**Cursor 不消费微软 Marketplace**，它使用 [Open VSX](https://open-vsx.org) 并经自己的 marketplace 代理（`marketplace.cursorapi.com`）做恶意软件/供应链分析后才提供安装（见 [Cursor 扩展文档](https://cursor.com/help/customization/extensions)）。所以"在 Cursor 里能搜到并一键安装"只等于"发布到 Open VSX"；否则只能发 VSIX 手动安装。

---

## 0. 发布前必须改的东西（三个渠道都要）

```bash
cd tools/vscode-source-insight
```

1. **`publisher` 不能是 `local`**。改成你的组织/个人 ID（Open VSX 的 namespace 必须与它完全一致）：
   ```jsonc
   // package.json
   "publisher": "cinsight",
   "repository": { "type": "git", "url": "https://git.example.com/tools/vscode-source-insight" },
   "homepage": "https://git.example.com/tools/vscode-source-insight",
   "bugs": { "url": "https://git.example.com/tools/vscode-source-insight/issues" }
   ```
   `repository` 缺失时 `vsce package` 需要 `--allow-missing-repository`；README 中的相对链接也依赖 `repository` 或 `--baseContentUrl` 才能正确显示。

2. **版本与 CHANGELOG 对齐**：`version` 递增，`CHANGELOG.md` 写清本版变更。

3. **发布前验证**（`scripts/release.sh` 会自动跑前面三步）：
   ```bash
   npm run compile && node --test dist/test/*.test.js   # 104/104
   node test/smoke-activate.js                          # SMOKE OK
   npm run perf -- plat                                  # 记录性能（可选，须传目录）
   npx vsce ls                                          # 确认打包文件清单（应为 39 个文件、~90KB）
   ```

4. **商标**：displayName 已定为中性的 **Code Insight**，不冒用 Source Dynamics 的产品名；README/描述里的 "Source Insight-style / 参考 Source Insight" 属于描述性引用（nominative use），公开发布时可以保留，也可以改成 "Source-Insight-like"。

5. 图标/许可已就绪：`resources/icon.png`（128×128）、`LICENSE`（MIT）、中英双语 `package.nls*.json`。

---

## A. VSIX 分发（内部团队，推荐先走这条）

```bash
npm run package
# 产物：code-insight-<version>.vsix
```

**分发**（任选其一）：

- 共享盘 / 内网静态目录：把 vsix 放到 `http://intranet/tools/`。
- GitLab Generic Package Registry：
  ```bash
  curl --header "JOB-TOKEN: $CI_JOB_TOKEN" \
       --upload-file code-insight-0.1.0.vsix \
       "$CI_API_V4_URL/projects/$CI_PROJECT_ID/packages/generic/code-insight/0.1.0/code-insight-0.1.0.vsix"
  ```
- Nexus / Artifactory 的 raw/通用仓库：
  ```bash
  curl -u "$NEXUS_USER:$NEXUS_PASS" --upload-file code-insight-0.1.0.vsix \
       "https://nexus.example.com/repository/raw-releases/code-insight/0.1.0/"
  ```

**安装**（分发给同事时给这条命令）：

```bash
# VS Code
code   --install-extension code-insight-0.1.0.vsix --force
# Cursor
cursor --install-extension code-insight-0.1.0.vsix --force
# 或 GUI：Ctrl+Shift+P → Extensions: Install from VSIX...
```

**升级**：sideload 的扩展**不会自动更新**（不走 gallery），需要发新版 vsix 并重跑安装命令。可以给团队一个更新脚本：

```bash
curl -fsSL http://intranet/tools/code-insight-latest.vsix -o /tmp/si.vsix && \
  (command -v cursor >/dev/null && cursor --install-extension /tmp/si.vsix --force || \
   code --install-extension /tmp/si.vsix --force)
```

**企业管控**：Cursor 团队版可在 Team settings 用 *Allowed extensions* 按 publisher/扩展 ID 放行（见 [Cursor 文档](https://cursor.com/help/customization/extensions)）；VS Code 企业版可用内部 gallery（改 product.json，需企业分发版）。

---

## B. 发布到 Open VSX（Cursor 用户可搜索安装）

1. 用 GitHub 账号登录 <https://open-vsx.org>。
2. 创建 namespace（等于 `package.json` 的 `publisher`）：
   ```bash
   npx ovsx create-namespace cinsight -p <token>
   # 首次发布时也可以直接在网站上认领 namespace
   ```
3. 生成访问令牌：<https://open-vsx.org/user-settings/tokens> → 新建 token。
4. 校验 token 与 namespace 匹配：
   ```bash
   npx ovsx verify-pat cinsight -p "$OVSX_PAT"
   ```
5. 发布（脚本会先跑测试+打包）：
   ```bash
   export OVSX_PAT=<token>
   npm run publish:ovsx
   # 等价于：
   # npx vsce package --no-dependencies
   # npx ovsx publish code-insight-0.1.0.vsix -p "$OVSX_PAT" --skip-duplicate
   ```
6. 验证：
   ```bash
   npx ovsx show cinsight.code-insight
   # 页面：https://open-vsx.org/extension/cinsight/code-insight
   ```
   Cursor 侧：Open VSX 收录后，经由 Cursor 代理分析（通常几分钟到数小时）才出现在 Cursor 的扩展搜索里；期间可用 VSIX 安装。
7. 升级：改 `version` + `CHANGELOG`，重跑第 5 步；`--skip-duplicate` 让 CI 重跑不会因版本已存在而失败。
8. 撤版：
   ```bash
   npx ovsx unpublish cinsight.code-insight@0.1.0 -p "$OVSX_PAT"
   ```

> Open VSX 上架的扩展由 Open VSX 签名；Cursor 企业版若开启 *Require Extension Signature Verification*，从 Open VSX 安装的版本才能通过校验（手工 sideload 的 vsix 不满足）。

---

## C. 发布到 VS Code Marketplace（仅 VS Code 用户）

1. 注册 Azure DevOps 组织（免费），生成 PAT：*User settings → Personal access tokens*，Scopes 选 **Marketplace → Manage**（这是发布扩展需要的权限）。
2. 打开 <https://marketplace.visualstudio.com/manage>，创建 publisher，ID 与 `package.json` 的 `publisher` 一致。
3. 登录并发布：
   ```bash
   npx vsce login cinsight          # 交互式粘贴 PAT
   # 或直接：
   export VSCE_PAT=<pat>
   npm run publish:vsce
   # 等价于：npx vsce publish --packagePath code-insight-0.1.0.vsix -p "$VSCE_PAT"
   ```
4. 验证：`https://marketplace.visualstudio.com/items?itemName=cinsight.code-insight`；首次发布可能被扫描/挂起一段时间。
5. `vsce publish minor|patch` / `--packagePath` 均可；撤版用 `npx vsce unpublish cinsight.code-insight`。

> 注意：发给 Cursor 用户无效——Cursor 只认 Open VSX / VSIX。

---

## 一键脚本

```bash
# 只打包（内部 vsix 分发）
npm run release

# 升版本 + 测试 + 打包（不发）
npm run release -- 0.1.1

# 发布到 Open VSX
OVSX_PAT=xxx npm run publish:ovsx

# 发布到 VS Code Marketplace
VSCE_PAT=xxx npm run publish:vsce

# 跳过测试（不建议）
npm run release -- --channel=vsix --skip-tests
```

脚本行为：校验 `node_modules` 与 `publisher` 是否为 `local` → 可选 `npm version` → `tsc` → 104 个单测 → 激活冒烟 → `vsce package` → 按 `--channel` 调用 `ovsx` / `vsce` 发布 → 打印下一步链接。

---

## CI 自动发布（已配好）

仓库内已有 **`.github/workflows/publish.yml`**：`push` tag `v*` 或手动 `workflow_dispatch` 时执行

1. `npm ci` → `npm test`（137 个单测）→ 激活冒烟 → `vsce package` → 上传 vsix artifact
2. **Open VSX**：`npx ovsx publish code-insight-*.vsix -p "$OVSX_PAT" --skip-duplicate`
   （Cursor / VS Code forks 用户）
3. **VS Code Marketplace**：`npx @vscode/vsce@4.1.0 publish --oidc`
   （OIDC Trusted Publishing，**不存任何长期密钥**；Azure DevOps 的全局 PAT 将于 2026-12-01 退役）

两个渠道各自独立、按配置自动跳过。

### 一次性配置

**A. Open VSX（Secret）**
1. 在 <https://open-vsx.org/user-settings/tokens> 生成 token
2. 仓库 → Settings → Secrets and variables → Actions → **New repository secret**
   - Name: `OVSX_PAT`，Value: 上面的 token

**B. VS Code Marketplace（OIDC，可选）**
1. <https://marketplace.visualstudio.com/manage> 创建 publisher，**ID 必须是 `cinsight`**（与 `package.json` 的 `publisher` 一致）
2. 该 publisher → **Trusted Publishing** → **Create**：
   - Repository owner: `izhongbei`
   - Repository: `cinsight`
   - Workflow: `publish.yml`
   - Environment: 留空
3. 仓库 → Settings → Secrets and variables → Actions → **Variables** → New repository variable
   - Name: `ENABLE_MARKETPLACE`，Value: `true`
   > 不配置这个变量时 Marketplace 步骤会被跳过，不会让 Open VSX 发布失败。

### 发布一个新版本

```bash
# 1) 本地升版本、跑测试、打包（可选，CI 会重新打包）
npm run release -- 0.3.2
# 2) 提交 + 打 tag + 推送（推 tag 即触发自动发布）
git add -A && git commit -m "release: 0.3.2"
git tag v0.3.2
git push origin master --tags
```

也可以不推 tag：Actions → **publish** → **Run workflow**，用当前 `package.json` 的版本发布（适合第一次试跑）。

### 手动/本地发布（CI 之外，兜底）

```bash
# Open VSX
OVSX_PAT=xxx npm run publish:ovsx
# Marketplace（2026-12-01 前仍可用 PAT；之后用上面的 OIDC）
VSCE_PAT=xxx npm run publish:vsce
```

**GitLab CI（内网：打 tag 上传 vsix 到 Generic Package Registry）**：

```yaml
release:
  image: node:22
  script:
    - npm ci
    - npm run compile
    - node --test dist/test/*.test.js
    - node test/smoke-activate.js
    - npx vsce package --no-dependencies --allow-missing-repository
    - |
      curl --header "JOB-TOKEN: $CI_JOB_TOKEN" \
           --upload-file "code-insight-$(node -p "require('./package.json').version").vsix" \
           "$CI_API_V4_URL/projects/$CI_PROJECT_ID/packages/generic/code-insight/$(node -p "require('./package.json').version")/"
  rules:
    - if: $CI_COMMIT_TAG
```

---

## 发布后自检

1. 干净环境安装：`cursor --install-extension <vsix>`（或从市场搜索）→ 重启 → 左侧出现「Source Insight」图标。
2. 按下面「发布后自测清单」过一遍 10 项。
3. 检查 i18n：中文系统显示中文命令名，英文系统显示英文。
4. 检查 `marketplace` 页面 README 渲染、图标、许可证、仓库链接。
5. 记录体积/启动开销：vsix 约 90KB，激活后才建索引（未配置 roots 时零索引、零后台任务）。

---

## 本地开发

```bash
npm install              # 安装构建/测试依赖
npm run compile          # tsc -> dist/
npm test                 # 编译 + 104 个 node:test 单元测试
npm run smoke            # mock vscode 激活冒烟（无需真实编辑器）
npm run perf -- plat     # 对指定目录建索引并测查询耗时（必填相对 workspace 的目录）
npm run package          # 生成 code-insight-<version>.vsix
```

目录结构、设计文档与实施计划在 `docs/superpowers/` 下；核心逻辑（`src/core/`）不依赖 vscode API，可直接用 node 测试。

> README 是面向使用者的市场页，**不要把发布/开发/CI 这类内容写回 README**；它们属于本文件。

## 发布后自测清单

在干净环境（未装过本扩展）安装后逐项验证：

1. 首次打开 C 工程 → 左侧出现「Code Insight」图标，视图显示引导页。
2. 执行"配置索引目录"，只勾一个中等目录 → 状态栏出现进度，结束后显示函数数量。
3. 打开该目录下任意 `.c`，光标放在跨文件调用的函数名上按 `F12` → 跳到定义文件对应行。
4. `Ctrl+T` 输入函数名片段 → 结果列表含文件与行，回车跳转。
5. 在函数调用处 `Shift+F12` → 找到调用点列表。
6. 命令"显示调用者 / 显示被调用者" → 列出对应函数。
7. 悬停函数名 → 出现签名与 `定义: 路径:行`。
8. 左侧符号树展开目录/文件 → 显示函数，点击跳转。
9. 修改并保存一个 `.c` 文件，等 1 秒 → 新函数能被 `Ctrl+T` 搜到（增量索引）。
10. 命令"清除索引缓存" → 状态栏回到未配置/索引为空。
