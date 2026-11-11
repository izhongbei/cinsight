#!/usr/bin/env bash
# 一键发布：校验 → 测试 → 打包 →（可选）发布到 Open VSX / VS Code Marketplace。
#
# 用法：
#   bash scripts/release.sh                         # 只打包 vsix
#   bash scripts/release.sh 0.1.1                   # 升版本 + 测试 + 打包
#   bash scripts/release.sh --channel=ovsx          # 发布到 Open VSX（需 OVSX_PAT）
#   bash scripts/release.sh --channel=vsce          # 发布到 VS Code Marketplace（需 VSCE_PAT）
#   bash scripts/release.sh --skip-tests            # 跳过编译/测试/冒烟
#
# 环境变量：
#   OVSX_PAT   Open VSX 访问令牌（https://open-vsx.org/user-settings/tokens）
#   VSCE_PAT   Azure DevOps / Marketplace PAT
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CHANNEL="vsix"
VERSION=""
SKIP_TESTS=0

usage() {
  sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    --channel=*) CHANNEL="${arg#*=}" ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --help | -h)
      usage
      exit 0
      ;;
    -*)
      echo "未知参数: $arg" >&2
      usage >&2
      exit 1
      ;;
    *) VERSION="$arg" ;;
  esac
done

case "$CHANNEL" in
  vsix | ovsx | vsce) ;;
  *)
    echo "未知渠道: $CHANNEL（可选 vsix | ovsx | vsce）" >&2
    exit 1
    ;;
esac

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "缺少命令: $1" >&2
    exit 1
  }
}

need node
[ -d node_modules ] || {
  echo "请先安装依赖: npm install --cache /tmp/npm-cache" >&2
  exit 1
}

read_json() {
  node -p "const p=require('./package.json'); $1"
}

publisher="$(read_json "p.publisher || ''")"
version="$(read_json 'p.version')"
name="$(read_json 'p.name')"

echo "==> 扩展: $name | publisher: $publisher | version: $version | 渠道: $CHANNEL"

if [ -n "$VERSION" ]; then
  echo "==> 升级版本到 $VERSION"
  npm version "$VERSION" --no-git-tag-version >/dev/null
  version="$(read_json 'p.version')"
  echo "==> 当前版本: $version（记得同步 CHANGELOG.md）"
fi

if [ "$CHANNEL" != "vsix" ] && [ "$publisher" = "local" ]; then
  echo "错误：package.json 的 publisher 仍是 'local'，发布前必须改成真实 publisher / namespace。" >&2
  echo "      Open VSX 的 namespace 必须与 publisher 完全一致。" >&2
  exit 1
fi

if [ "$SKIP_TESTS" -eq 0 ]; then
  echo "==> 编译"
  npm run compile
  echo "==> 单元测试"
  node --test dist/test/*.test.js
  echo "==> 激活冒烟"
  node test/smoke-activate.js
else
  echo "==> 跳过编译/测试/冒烟（--skip-tests）"
  [ -d dist ] || npm run compile
fi

echo "==> 打包 vsix"
./node_modules/.bin/vsce package --no-dependencies --allow-missing-repository >/dev/null
VSIX="${name}-${version}.vsix"
[ -f "$VSIX" ] || {
  echo "打包失败：未找到 $VSIX" >&2
  exit 1
}
echo "==> 产物: $VSIX ($(du -h "$VSIX" | cut -f1), $(unzip -l "$VSIX" | tail -1 | awk '{print $2}') 个文件)"

case "$CHANNEL" in
  vsix)
    echo ""
    echo "完成。分发与安装方式见 PUBLISHING.md 的 A 小节，例如："
    echo "  cursor --install-extension $VSIX --force"
    echo "  code   --install-extension $VSIX --force"
    ;;
  ovsx)
    : "${OVSX_PAT:?请先 export OVSX_PAT=<open-vsx.org token>}"
    echo "==> 校验 Open VSX token"
    npx --yes ovsx verify-pat "$publisher" -p "$OVSX_PAT"
    echo "==> 发布到 Open VSX"
    npx --yes ovsx publish "$VSIX" -p "$OVSX_PAT" --skip-duplicate
    echo "==> 已发布: https://open-vsx.org/extension/$publisher/$name"
    echo "    Cursor 会在其 marketplace 代理完成分析后出现（通常几分钟到数小时）。"
    ;;
  vsce)
    : "${VSCE_PAT:?请先 export VSCE_PAT=<Azure DevOps Marketplace PAT>}"
    echo "==> 发布到 VS Code Marketplace"
    npx --yes vsce publish --packagePath "$VSIX" -p "$VSCE_PAT"
    echo "==> 已发布: https://marketplace.visualstudio.com/items?itemName=$publisher.$name"
    ;;
esac
