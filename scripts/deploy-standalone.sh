#!/bin/bash
# onenat-workbuddy-web - 独立服务标准部署脚本（本地构建 → 冒烟 → 上传 → 备份替换 → 重启 → 验证）
#
# 用法:
#   scripts/deploy-standalone.sh user@host [--port 22] [--key ~/.ssh/id_rsa] [--skip-smoke] [--files a.js,b.js]
#
# 行为:
#   1. npm run build（页面内联脚本语法关卡内置）
#   2. npm run smoke:mcp（可用 --skip-smoke 跳过；默认再跑 smoke:monitor）
#   3. 计算 dist/*.js 与远端 md5 差异，只上传有变化的文件（全量一致则直接退出）
#   4. 远端：变更文件逐一备份为 dist.bak-<ts>-<file> → 覆盖 → node --check → systemctl restart onenat-workbuddy
#   5. 验证 healthz / {prefix}/monitor / MCP 匿名 401（fail-closed）
#
# 依赖: 本地 sshpass（密码登录时）或 SSH 私钥；远端 systemd 单元名默认 onenat-workbuddy（UNIT 可覆盖）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TARGET="" SSH_PORT=22 SSH_KEY="" SKIP_SMOKE=0 FILES=""
UNIT="${UNIT:-onenat-workbuddy}"
PREFIX="${PREFIX:-/onenat-workbuddy}"
PORT="${PORT:-3081}"
REMOTE_DIR="${REMOTE_DIR:-/opt/onenat-workbuddy/dist}"

while [ $# -gt 0 ]; do
  case "$1" in
    --port) SSH_PORT="$2"; shift 2 ;;
    --key) SSH_KEY="-i $2"; shift 2 ;;
    --skip-smoke) SKIP_SMOKE=1; shift ;;
    --files) FILES="$2"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) TARGET="$1"; shift ;;
  esac
done
[ -n "$TARGET" ] || { echo "用法: $0 user@host [选项]"; exit 2; }

ssh_wrap() {
  if [ -n "${SSHPASS:-}" ]; then sshpass -e ssh -p "$SSH_PORT" $SSH_KEY -o StrictHostKeyChecking=accept-new "$TARGET" "$@"
  else ssh -p "$SSH_PORT" $SSH_KEY -o StrictHostKeyChecking=accept-new "$TARGET" "$@"; fi
}
scp_wrap() {
  if [ -n "${SSHPASS:-}" ]; then SSHPASS="$SSHPASS" sshpass -e scp -P "$SSH_PORT" $SSH_KEY -o StrictHostKeyChecking=accept-new "$@"
  else scp -P "$SSH_PORT" $SSH_KEY -o StrictHostKeyChecking=accept-new "$@"; fi
}

echo "=== 1/5 构建 ==="
npm run build

if [ "$SKIP_SMOKE" != 1 ]; then
  echo "=== 2/5 冒烟 ==="
  npm run smoke:mcp
  npm run smoke:monitor
else
  echo "=== 2/5 冒烟（跳过）==="
fi

echo "=== 3/5 计算 dist 差异 ==="
# 差异计算只按文件名对齐，再比较哈希（macOS md5 -q 与 Linux md5sum 输出格式不同，勿用整行 comm）
LOCAL_HASHES="$(cd dist && md5 -q *.js | paste -d' ' - <(/bin/ls *.js) | sort -k2,2)"
REMOTE_HASHES="$(ssh_wrap "cd $REMOTE_DIR && md5sum *.js | awk '{print \$1\" \"\$2}' | sort -k2,2")"
# awk 按文件名 join：远端不存在或哈希不同即视为变更
CHANGED="$(awk 'NR==FNR{h[$2]=$1;next} h[$2]!=$1{print $2}' <(echo "$REMOTE_HASHES") <(echo "$LOCAL_HASHES"))"
if [ -n "$FILES" ]; then
  # 显式指定文件（逗号分隔），跳过差异计算
  CHANGED="$(echo "$FILES" | tr ',' ' ')"
fi
if [ -z "$CHANGED" ]; then
  # dist 无漂移时仍需检查附属目录（assets/experts、dist/mcp）是否漂移
  LOCAL_ASSET_INDEX="$(md5 -q assets/experts/index.json 2>/dev/null || true)"
  REMOTE_ASSET_INDEX="$(ssh_wrap "md5sum $REMOTE_DIR/../assets/experts/index.json 2>/dev/null | awk '{print \$1}' || true")"
  MCP_DRIFT=0
  if ls dist/mcp/*.js >/dev/null 2>&1; then
    REMOTE_MCP_HASHES0="$(ssh_wrap "cd $REMOTE_DIR/mcp 2>/dev/null && md5sum *.js | awk '{print \$1}' | sort || true")"
    [ "$(cd dist/mcp && md5 -q *.js | sort)" != "$REMOTE_MCP_HASHES0" ] && MCP_DRIFT=1
  fi
  if [ -z "$LOCAL_ASSET_INDEX" ] || [ "$LOCAL_ASSET_INDEX" != "$REMOTE_ASSET_INDEX" ] || [ "$MCP_DRIFT" = 1 ]; then
    echo "dist 无漂移，但附属目录（assets/experts / dist/mcp）有差异，继续部署。"
  else
    echo "dist 与附属目录均与远端一致，无需部署。"
    exit 0
  fi
fi
# comm 输出为换行分隔；后续 tar/远端 for 循环按空白分词，统一压平为空格分隔
CHANGED="$(echo "$CHANGED" | tr '\n' ' ')"
echo "变更文件: $CHANGED"

echo "=== 4/5 上传 + 远端备份替换 ==="
TARBALL="/tmp/wb-deploy-$(date +%Y%m%d-%H%M%S).tgz"
tar -czf "$TARBALL" -C dist $CHANGED
scp_wrap "$TARBALL" "$TARGET:/tmp/wb-deploy.tgz"
ssh_wrap "set -e; TS=\$(date +%Y%m%d-%H%M%S); cd $REMOTE_DIR; for f in $CHANGED; do [ -f \$f ] && cp -a \$f dist.bak-\$TS-\$f || true; done; tar -xzf /tmp/wb-deploy.tgz --exclude='._*'; for f in $CHANGED; do node --check \$f; done; rm -f /tmp/wb-deploy.tgz"

# --- 附属目录同步：dist/mcp/*.js 与 assets/experts/（差异计算只覆盖 dist/*.js，需单独处理）---
echo "=== 4.5/5 同步附属目录（dist/mcp、assets/experts）==="
EXTRA_TARBALL="/tmp/wb-extra-$(date +%Y%m%d-%H%M%S).tgz"
EXTRA_NEEDED=0
if ls dist/mcp/*.js >/dev/null 2>&1; then
  REMOTE_MCP_HASHES="$(ssh_wrap "cd $REMOTE_DIR/mcp 2>/dev/null && md5sum *.js | awk '{print \$1\" \"\$2}' | sort -k2,2 || true")"
  LOCAL_MCP_HASHES="$(cd dist/mcp && md5 -q *.js | paste -d' ' - <(/bin/ls *.js) | sort -k2,2)"
  MCP_CHANGED="$(awk 'NR==FNR{h[$2]=$1;next} h[$2]!=$1{print $2}' <(echo "$REMOTE_MCP_HASHES") <(echo "$LOCAL_MCP_HASHES"))"
  if [ -n "$MCP_CHANGED" ]; then
    EXTRA_NEEDED=1
    tar -czf "$EXTRA_TARBALL" -C dist mcp
    echo "dist/mcp 变更: $MCP_CHANGED"
  fi
fi
LOCAL_ASSET_INDEX="$(md5 -q assets/experts/index.json 2>/dev/null || true)"
REMOTE_ASSET_INDEX="$(ssh_wrap "md5sum $REMOTE_DIR/../assets/experts/index.json 2>/dev/null | awk '{print \$1}' || true")"
if [ -n "$LOCAL_ASSET_INDEX" ] && [ "$LOCAL_ASSET_INDEX" != "$REMOTE_ASSET_INDEX" ]; then
  EXTRA_NEEDED=1
  tar -czf "$EXTRA_TARBALL" -C assets experts
  echo "assets/experts 有变更"
fi
if [ "$EXTRA_NEEDED" = 1 ]; then
  scp_wrap "$EXTRA_TARBALL" "$TARGET:/tmp/wb-extra.tgz"
  ssh_wrap "set -e; cd $REMOTE_DIR/..; tar -xzf /tmp/wb-extra.tgz --exclude='._*'; rm -f /tmp/wb-extra.tgz"
  NEED_RESTART=1
fi
rm -f "$TARBALL" "$EXTRA_TARBALL"
ssh_wrap "systemctl restart $UNIT; sleep 2; systemctl is-active $UNIT"

echo "=== 5/5 部署后验证 ==="
HEALTH="$(ssh_wrap "curl -s http://127.0.0.1:$PORT/healthz")"
echo "$HEALTH" | grep -q '"ok":true' || { echo "❌ healthz 异常: $HEALTH"; exit 1; }
echo "$HEALTH"
CODE="$(ssh_wrap "curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:$PORT$PREFIX/mcp -H 'Content-Type: application/json' -d '{}'")"
[ "$CODE" = "401" ] || { echo "❌ MCP 匿名应答 $CODE（期望 401 fail-closed）"; exit 1; }
echo "✅ 部署完成：$(echo "$CHANGED" | wc -w | tr -d ' ') 个文件已更新，healthz/MCP 验证通过（回滚点: $REMOTE_DIR/dist.bak-<ts>-<file>）"
