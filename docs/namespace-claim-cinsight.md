# Open VSX namespace 认领申请（cinsight）

> **状态：已提交** — `EclipseFdn/open-vsx.org` issue **#15538**（Claiming namespace cinsight）。
> 审核通过后即可用 `cinsight.code-insight` 发布；`package.json` 的 `publisher` 已固定为 `cinsight`。

> 用途：在 https://github.com/EclipseFdn/open-vsx.org/issues/new?template=claim-namespace-ownership.yml
> 提交 issues 时按模板字段填写。尖括号 `<...>` 是待你替换的部分。

## Namespace

cinsight

## Extension(s)

- `code-insight` — **Code Insight**：面向大型 C/C++ 工程的代码导航扩展（函数符号索引、跳转定义、查找引用、调用层次、符号树）。

## Account information

- GitHub account / org: `<你的 GitHub 用户名或组织>`
- Eclipse Foundation account: `<你的 accounts.eclipse.org 用户名/邮箱>`
- Open VSX login: `<你登录 open-vsx.org 用的 GitHub 账号>`

> 如果 namespace 与 GitHub 组织同名，请说明你是该组织管理员（附组织页面链接）。

## Why this namespace

我们计划在同一命名空间下发布一组开发者工具扩展（当前为 Code Insight）。使用 `cinsight` 作为统一、中性的发布者标识，避免与个人账号绑定。

## Evidence of ownership / association

- Repository: `<仓库 URL>`
- Package/bundle metadata: `package.json` 中 `"publisher": "cinsight"`，扩展 ID 为 `cinsight.code-insight`
- Homepage / project page: `<项目主页或内网页面（如有）>`

## Confirmation

- 该 namespace 当前未在 Open VSX 注册（`https://open-vsx.org/api/cinsight` 返回 `Namespace not found`）。
- 我们未发现该名称存在冲突的商标或既有发布者；如有需要可提供补充说明。
- 同意遵守 [Open VSX Publisher Agreement](https://open-vsx.org/documents/publisher-agreement-v1.1.md)。

---

## 备选方案（不想等审核时）

Open VSX 的 namespace 认领需要人工审核。若想立即发布：

1. 把 `package.json` 的 `publisher` 改成你 GitHub 登录名（例如 `zhangsan`），扩展 ID 变为 `zhangsan.code-insight`；
2. `npm run release` 重新打包；
3. 在 https://open-vsx.org/publish 拖入新 vsix —— 该 namespace 随你的账号自动拥有，无需审核；
4. 之后 `cinsight` 审核通过，再发一版迁移（旧 ID 可 `ovsx unpublish` 下架或保留）。

> 注：Open VSX 的 `publisher` 必须与 namespace 完全一致，改 publisher 时**必须重新打包**，不能只改名。
