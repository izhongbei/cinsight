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
   npm run perf                                         # 记录性能（可选）
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

## CI 示例

**GitHub Actions（打 tag 自动发布 Open VSX）**：

```yaml
name: release
on:
  push:
    tags: ['v*']
jobs:
  publish:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: tools/vscode-source-insight
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
          cache-dependency-path: tools/vscode-source-insight/package-lock.json
      - run: npm ci
      - run: node --test dist/test/*.test.js
      - run: node test/smoke-activate.js
      - run: npx ovsx publish -p "$OVSX_PAT" --skip-duplicate
        env:
          OVSX_PAT: ${{ secrets.OVSX_PAT }}
```

**GitLab CI（内网：打 tag 上传 vsix 到 Generic Package Registry）**：

```yaml
release:
  image: node:22
  script:
    - cd tools/vscode-source-insight
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
2. 按 [README 自测清单](README.md#安装后自测清单) 过一遍 10 项（配置索引目录 → F12 → Ctrl+T → Shift+F12 → 调用层次 → 树 → 悬停 → 大纲 → 增量 → 清缓存）。
3. 检查 i18n：中文系统显示中文命令名，英文系统显示英文。
4. 检查 `marketplace` 页面 README 渲染、图标、许可证、仓库链接。
5. 记录体积/启动开销：vsix 约 90KB，激活后才建索引（未配置 roots 时零索引、零后台任务）。
