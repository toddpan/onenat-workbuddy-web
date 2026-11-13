#!/usr/bin/env bash
# =============================================================
# OneNat WorkBuddy — SKILL 一键安装脚本（双通道：HTTP + MCP）
#
# 由 WorkBuddy 服务端提供（GET <前缀>/install-skill.sh），
# 本脚本不含任何秘密：APIKEY 由安装者在参数里传入，只写入本机配置文件。
#
# 一次安装两套技能（同源工具、同一份配置 ~/.workbuddy-skill.json）：
#   - onenat-workbuddy   HTTP 工具通道技能（wb.mjs 命令行直连 + 子技能分块文档）
#   - workbuddy-mcp      MCP 通道技能（wbmcp.sh 客户端直连 /mcp；MCP 原生宿主按 SKILL 内
#                        的 mcpServers 条目注册，脚本通道作为无 MCP 宿主的等价兜底）
#
# 默认安装到本机全部 AI 技能目录（DSH / ZCode / Claude / agents，已存在或不存在都会创建安装）；
# 用 --dir 可只装到指定目录（支持别名 dsh / zcode / claude / agents 或任意路径）。
#
# 用法:
#   curl -fsSL http://<host>:3081/onenat-workbuddy/install-skill.sh | bash -s -- \
#     --base-url http://<host>:3081/onenat-workbuddy --token wbk-xxxx [--dir dsh|zcode|claude|agents|路径]
#
# 参数:
#   --base-url <url>   WorkBuddy 服务地址（含前缀，必填）
#   --token <apikey>   AI APIKEY（控制台「设置 → AI 接入」生成，必填）
#   --dir <path|别名>   只装到指定技能目录；别名: dsh / zcode / claude / agents。缺省 = 全部 AI 目录
#   --uninstall         卸载（删除全部已装文件与本机配置）
# =============================================================
set -euo pipefail

# 帮助正文内联在本脚本里：`curl ... | bash -s --` 管道安装时 $0 是 bash 而非脚本文件，
# 用 sed 读 "$0" 会失败（task-104），因此不再依赖脚本路径。
usage() {
  cat <<'USAGE'
OneNat WorkBuddy — SKILL 一键安装脚本（双通道：HTTP + MCP）

由 WorkBuddy 服务端提供（GET <前缀>/install-skill.sh），
本脚本不含任何秘密：APIKEY 由安装者在参数里传入，只写入本机配置文件。

一次安装两套技能（同源工具、同一份配置 ~/.workbuddy-skill.json）：
  - onenat-workbuddy   HTTP 工具通道技能（wb.mjs 命令行直连 + 子技能分块文档）
  - workbuddy-mcp      MCP 通道技能（wbmcp.sh 客户端直连 /mcp；MCP 原生宿主按 SKILL 内
                       的 mcpServers 条目注册，脚本通道作为无 MCP 宿主的等价兜底）

装到 DSH 技能目录时，额外把 MCP 注册写进 ~/.dsh/profiles/*/cordis.patch.yml
（DSH 不解析 mcpServers JSON，只认 dsh-mcp-client 插件条目；不注册则 MCP 工具不会出现）。
注册幂等、可重复安装；--uninstall 会一并拆除。patch 是启动期加载，需重启 DSH 生效。

默认安装到本机全部 AI 技能目录（DSH / ZCode / Claude / agents，已存在或不存在都会创建安装）；
用 --dir 可只装到指定目录（支持别名 dsh / zcode / claude / agents 或任意路径）。

用法:
  curl -fsSL http://<host>:3081/onenat-workbuddy/install-skill.sh | bash -s -- \
    --base-url http://<host>:3081/onenat-workbuddy --token wbk-xxxx [--dir dsh|zcode|claude|agents|路径]

参数:
  --base-url <url>   WorkBuddy 服务地址（含前缀，必填）
  --token <apikey>   AI APIKEY（控制台「设置 → AI 接入」生成，必填）
  --dir <path|别名>   只装到指定技能目录；别名: dsh / zcode / claude / agents。缺省 = 全部 AI 目录
  --uninstall         卸载（删除全部已装文件、本机配置与安装报告）
  -h, --help          显示本帮助

环境变量:
  HOME                配置与默认技能目录的基准（配置写入 $HOME/.workbuddy-skill.json）
  WORKBUDDY_CONFIG    wb.mjs / wbmcp.sh 读取的配置路径覆盖（默认 $HOME/.workbuddy-skill.json）
USAGE
}

BASE_URL="" TOKEN="" TARGET_DIR="" UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --base-url) BASE_URL="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --dir) TARGET_DIR="${2:-}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help)
      usage
      exit 0 ;;
    *) echo "未知参数: $1（--help 查看用法）" >&2; exit 1 ;;
  esac
done

# 去尾斜杠
BASE_URL="${BASE_URL%/}"

resolve_dir() {
  case "$1" in
    ""|dsh) printf '%s' "$HOME/.dsh/skills" ;;
    zcode) printf '%s' "$HOME/.zcode/skills" ;;
    claude) printf '%s' "$HOME/.claude/skills" ;;
    agents) printf '%s' "$HOME/.agents/skills" ;;
    *) printf '%s' "$1" ;;
  esac
}

CFG="$HOME/.workbuddy-skill.json"
REPORT="$HOME/.workbuddy-install-report.json"

# ---------- DSH MCP 注册 ----------
# DSH 不解析 mcpServers JSON，只认 profile 的 cordis.patch.yml 里的 dsh-mcp-client 插件条目。
# 不注册的后果：技能装上了，但 MCP 工具在 DSH 里根本不会出现（只剩脚本通道）。
# 注册块用标记注释包裹，重装时先剥旧块再追加，保证幂等；--uninstall 时整块移除。
DSH_MCP_MARK_BEGIN='# >>> onenat-workbuddy-mcp (managed by install-skill.sh) >>>'
DSH_MCP_MARK_END='# <<< onenat-workbuddy-mcp <<<'

# 从 patch 中剥掉本脚本管理的块（标记行本身也不保留）
strip_dsh_mcp_block() {
  awk -v b="$DSH_MCP_MARK_BEGIN" -v e="$DSH_MCP_MARK_END" '
    $0==b {skip=1; next}
    $0==e {skip=0; next}
    !skip {print}
  ' "$1"
}

# 为单个 profile 的 cordis.patch.yml 注册 MCP。
# 返回码：0=已注册，1=跳过（已存在同地址注册 / 不是数组），2=失败。
register_dsh_mcp_one() {
  local patch="$1" url="$2" token="$3"
  local profile="$(basename "$(dirname "$1")")" cand="" c tmp tok
  [ -f "$patch" ] || return 1
  # 同一 profile 内 serverName 必须唯一，重复会让 DSH 启动报错。
  # 已有同地址注册 → 不重复注册；但令牌可能已过期，需提醒核对。
  if grep -qF "$url" "$patch"; then
    echo "  · profile ${profile}：已有同地址 MCP 注册，跳过（避免 serverName 冲突）；若令牌已重置，请手工更新该条目的 Authorization"
    return 1
  fi
  for c in onenat onenat-workbuddy workbuddy; do
    if ! grep -qE "serverName:[[:space:]]*['\"]?$c['\"]?[[:space:]]*$" "$patch"; then cand="$c"; break; fi
  done
  if [ -z "$cand" ]; then
    echo "  ⚠️ profile ${profile}：候选 serverName 都被占用，未注册（请手工指定一个唯一名字）" >&2
    return 2
  fi
  # patch 顶层必须是数组，追加 '- insert:' 才合法
  if [ -s "$patch" ] && ! grep -q '^- ' "$patch"; then
    echo "  ⚠️ profile ${profile}：cordis.patch.yml 顶层不是数组，未自动注册（请手工添加条目）" >&2
    return 2
  fi
  cp "$patch" "$patch.bak-workbuddy-mcp" 2>/dev/null || true
  tmp="$patch.tmp.$$" tok="$token"
  tok="${tok//\'/\'\'}"   # YAML 单引号串里单引号需转义
  if ! strip_dsh_mcp_block "$patch" > "$tmp"; then rm -f "$tmp"; return 2; fi
  {
    printf '\n%s\n' "$DSH_MCP_MARK_BEGIN"
    cat <<EOF
- insert:
    - id: onenat-workbuddy-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: $cand
        transport: streamable-http
        url: '$url'
        headers:
          Authorization: Bearer '$tok'
EOF
    printf '%s\n' "$DSH_MCP_MARK_END"
  } >> "$tmp"
  mv "$tmp" "$patch"
  echo "  ✓ profile ${profile}：已注册 MCP（serverName=$cand）；patch 启动期加载，需重启 DSH 生效"
  return 0
}

# 移除所有 profile 里的本脚本注册块
unregister_dsh_mcp_all() {
  local patch tmp
  for patch in "$HOME/.dsh/profiles/"*/cordis.patch.yml; do
    [ -f "$patch" ] || continue
    if grep -qF "$DSH_MCP_MARK_BEGIN" "$patch"; then
      tmp="$patch.tmp.$$"
      if strip_dsh_mcp_block "$patch" > "$tmp"; then
        mv "$tmp" "$patch"
        echo "✓ 已移除 DSH MCP 注册：$patch"
      else
        rm -f "$tmp"
      fi
    fi
    rm -f "$patch.bak-workbuddy-mcp"
  done
}

# ---------- 卸载（全部目录） ----------
if [ "$UNINSTALL" = "1" ]; then
  for d in "$(resolve_dir dsh)" "$(resolve_dir zcode)" "$(resolve_dir claude)" "$(resolve_dir agents)"; do
    [ -e "$d/onenat-workbuddy" ] && rm -rf "$d/onenat-workbuddy" && echo "✓ 已移除 $d/onenat-workbuddy"
    [ -e "$d/workbuddy-mcp" ] && rm -rf "$d/workbuddy-mcp" && echo "✓ 已移除 $d/workbuddy-mcp"
  done
  if [ -n "$TARGET_DIR" ]; then
    rd="$(resolve_dir "$TARGET_DIR")"
    [ -e "$rd/onenat-workbuddy" ] && rm -rf "$rd/onenat-workbuddy"
    [ -e "$rd/workbuddy-mcp" ] && rm -rf "$rd/workbuddy-mcp"
  fi
  rm -f "$CFG"
  echo "✓ 已卸载配置 $CFG"
  # 安装报告必须一并清除：残留 filesInstalled/verified=true 会让后来的人和 AI 误判「已安装且验证通过」（task-105）
  rm -f "$REPORT"
  echo "✓ 已清除安装报告 $REPORT"
  # DSH 的 MCP 注册块也要拆：留着会让 DSH 指向一个已卸载的技能
  unregister_dsh_mcp_all
  exit 0
fi

# ---------- 参数校验 ----------
if [ -z "$BASE_URL" ]; then
  echo "缺少 --base-url（例: http://127.0.0.1:3081/onenat-workbuddy）" >&2
  exit 1
fi
if [ -z "$TOKEN" ]; then
  echo "缺少 --token（到 WorkBuddy 控制台「设置 → AI 接入」生成）" >&2
  exit 1
fi

command -v curl >/dev/null 2>&1 || { echo "需要 curl" >&2; exit 1; }

# ---------- 目标目录（缺省 = 全部 AI） ----------
if [ -n "$TARGET_DIR" ]; then
  TARGETS=("$(resolve_dir "$TARGET_DIR")")
else
  TARGETS=("$(resolve_dir dsh)" "$(resolve_dir zcode)" "$(resolve_dir claude)" "$(resolve_dir agents)")
fi

# ---------- 下载安装到每个目录（两套技能） ----------
FIRST_WB="" FIRST_MCP=""
for d in "${TARGETS[@]}"; do
  echo "▸ 安装到 $d"
  # ① HTTP 工具通道技能
  mkdir -p "$d/onenat-workbuddy/scripts" "$d/onenat-workbuddy/skills"
  curl -fsSL --max-time 30 "$BASE_URL/install/SKILL.md" -o "$d/onenat-workbuddy/SKILL.md"
  curl -fsSL --max-time 30 "$BASE_URL/install/wb.mjs" -o "$d/onenat-workbuddy/scripts/wb.mjs"
  chmod +x "$d/onenat-workbuddy/scripts/wb.mjs" 2>/dev/null || true
  [ -z "$FIRST_WB" ] && FIRST_WB="$d/onenat-workbuddy/scripts/wb.mjs"
  # 子技能分块文档（主 SKILL 路由表按需引用；拉不到不影响主 SKILL 可用性）
  MANIFEST="$(curl -fsSL --max-time 30 "$BASE_URL/install/skills.json")" || MANIFEST=""
  if [ -n "$MANIFEST" ]; then
    # 从清单 JSON 抽文件名（无需 jq）
    for s in $(printf '%s' "$MANIFEST" | tr ',[]" ' '\n' | grep -E '^[a-z0-9-]+\.md$' || true); do
      if curl -fsSL --max-time 30 "$BASE_URL/install/skills/$s" -o "$d/onenat-workbuddy/skills/$s"; then
        echo "  + onenat-workbuddy/skills/$s"
      else
        echo "  ⚠️ 子技能 $s 下载失败（主 SKILL 仍可用）" >&2
      fi
    done
  else
    echo "  ⚠️ 子技能清单拉取失败，仅安装主 SKILL" >&2
  fi
  # ② MCP 通道技能（wbmcp.sh 脚本直连；MCP 原生宿主按 SKILL 内条目注册 mcpServers）
  mkdir -p "$d/workbuddy-mcp/scripts"
  curl -fsSL --max-time 30 "$BASE_URL/install/mcp/SKILL.md" -o "$d/workbuddy-mcp/SKILL.md"
  curl -fsSL --max-time 30 "$BASE_URL/install/wbmcp.sh" -o "$d/workbuddy-mcp/scripts/wbmcp.sh"
  chmod +x "$d/workbuddy-mcp/scripts/wbmcp.sh" 2>/dev/null || true
  [ -z "$FIRST_MCP" ] && FIRST_MCP="$d/workbuddy-mcp/scripts/wbmcp.sh"
  echo "  + workbuddy-mcp/SKILL.md + scripts/wbmcp.sh"
done

# ---------- 写配置（仅本机，600 权限；wb.mjs 与 wbmcp.sh 共用） ----------
printf '{\n  "baseUrl": "%s",\n  "token": "%s",\n  "installedAt": %s\n}\n' \
  "$BASE_URL" "$TOKEN" "$(date +%s000)" > "$CFG"
chmod 600 "$CFG"

# ---------- 连通性自检（跑一次即可） ----------
# 注意：自检输出直接捕获到变量，不落盘——/tmp 不可写的沙箱（Termux 等）也能通过。
echo "▸ 连通性自检（HTTP 通道 wb.mjs + MCP 通道 wbmcp.sh）"
SELFTEST="" SELFTEST_RC=1
HTTP_STATUS=skipped
if command -v node >/dev/null 2>&1 && [ -n "$FIRST_WB" ]; then
  # set -e 下用 `|| RC=$?` 形式：命令非 0 时脚本不会中断，且 $? 仍是 node 的退出码
  SELFTEST_RC=0
  SELFTEST="$(node "$FIRST_WB" tools 2>&1)" || SELFTEST_RC=$?
  HTTP_STATUS=failed
  if [ "$SELFTEST_RC" = "0" ]; then
    HTTP_STATUS=passed
    echo "$SELFTEST"
  else
    echo "$SELFTEST" >&2
  fi
else
  echo "  ⚠️ 未找到 node，跳过 wb.mjs 自检（wb.mjs 需要 Node ≥ 18）"
fi
MCP_SELFTEST='{"handshake":"skipped","tools/list":"skipped","ping":"skipped"}' MCP_SELFTEST_RC=1
if command -v python3 >/dev/null 2>&1 && [ -n "$FIRST_MCP" ]; then
  MCP_SELFTEST_RC=0
  MCP_SELFTEST="$(bash "$FIRST_MCP" probe)" || MCP_SELFTEST_RC=$?
  if [ "$MCP_SELFTEST_RC" = "0" ]; then
    echo "$MCP_SELFTEST"
  else
    echo "$MCP_SELFTEST" >&2
  fi
else
  echo "  ⚠️ 未找到 python3，跳过 wbmcp.sh 自检（wbmcp.sh 需要 curl + python3）"
fi

# 安装报告不包含令牌；持久化实际检查结果，供人和 AI 复查。
if command -v python3 >/dev/null 2>&1; then
  (umask 077; python3 -c '
import json,sys
try: probes=json.loads(sys.argv[4])
except ValueError: probes={"handshake":"failed","tools/list":"skipped","ping":"skipped"}
with open(sys.argv[1],"w") as f:
    json.dump({"baseUrl":sys.argv[2],"filesInstalled":True,"http":sys.argv[3],"mcp":probes,"verified":sys.argv[3]=="passed" and all(probes.get(k)=="passed" for k in ("handshake","tools/list","ping")),"tokenExpiresAt":None,"tokenExpiryPolicy":"never"},f,ensure_ascii=False,indent=2)
' "$REPORT" "$BASE_URL" "$HTTP_STATUS" "$MCP_SELFTEST")
  echo "  安装报告: $REPORT"
else
  echo '  安装报告: 无法写入 JSON（缺少 python3）；探针未验证' >&2
fi

# ---------- DSH MCP 注册（仅当装到 DSH 技能目录、且 MCP 通道自检通过） ----------
# 服务不通时注册了也没用，所以放在自检之后。
DSH_SKILL_DIR="$(resolve_dir dsh)"
DSH_TARGETED=0
for d in "${TARGETS[@]}"; do [ "$d" = "$DSH_SKILL_DIR" ] && DSH_TARGETED=1; done
if [ "$DSH_TARGETED" = "1" ] && [ "$MCP_SELFTEST_RC" = "0" ]; then
  echo ""
  echo "▸ 注册 DSH MCP（DSH 不解析 mcpServers JSON，需写入 profile 的 cordis.patch.yml）"
  DSH_PATCH_FOUND=0
  for patch in "$HOME/.dsh/profiles/"*/cordis.patch.yml; do
    [ -f "$patch" ] || continue
    DSH_PATCH_FOUND=1
    register_dsh_mcp_one "$patch" "$BASE_URL/mcp" "$TOKEN" || true
  done
  if [ "$DSH_PATCH_FOUND" = "0" ]; then
    echo "  · 未找到 $HOME/.dsh/profiles/*/cordis.patch.yml（本机没有 DSH profile？），跳过；DSH 用户需手工注册，见技能 SKILL.md"
  fi
fi

installed_note() {
  echo ""
  echo "文件已安装（${#TARGETS[@]} 个技能目录 × 2 套技能）；HTTP=${HTTP_STATUS}，MCP=${MCP_SELFTEST}"
  for d in "${TARGETS[@]}"; do
    echo "  技能: $d/onenat-workbuddy/SKILL.md（HTTP 通道；子技能分块文档在 skills/ 子目录，按需读取）"
    echo "        $d/workbuddy-mcp/SKILL.md（MCP 通道；MCP 原生宿主按其内 mcpServers 条目注册）"
  done
  [ "$DSH_TARGETED" = "1" ] && echo "  DSH: MCP 注册见上方「注册 DSH MCP」输出（已装则跳过；改完需重启 DSH）"
  echo "  脚本: ${FIRST_WB}（HTTP 通道）/ ${FIRST_MCP}（MCP 通道，AI 可直接命令行调用）"
  echo "  配置: ${CFG}（600 权限，两通道共用；也可用环境变量 WORKBUDDY_BASE_URL / WORKBUDDY_TOKEN 覆盖）"
  echo ""
  echo "  令牌永久有效（无 TTL）；仅显式重置令牌后旧令牌失效。MCP 会话续期不改变令牌。"
  echo "  快速验证: ${FIRST_WB} monitor overview  或  bash ${FIRST_MCP} probe"
}

if [ "$SELFTEST_RC" = "0" ] && [ "$MCP_SELFTEST_RC" = "0" ]; then
  installed_note
  exit 0
fi

# 自检失败：先打印「文件已安装」，再按失败原因分别提示（区分本地环境 / 鉴权 / 网络）
# 退出码约定：
#   任一探针失败或依赖缺失 → 退出 1：文件可能已安装，但尚未验证可用。
SELFTEST_ALL="$SELFTEST
${MCP_SELFTEST:-}"
case "$SELFTEST_ALL" in
  *Permission*denied*|*ENOENT*|*EACCES*|*cannot*write*|*No*such*file*)
    echo ""
    echo "⚠️ 自检未通过：本地环境限制（例如 ${TMPDIR:-/tmp} 不可写或 node/python3 异常），与 --base-url/--token 无关"
    echo "   文件已安装（安装动作成功），请在正常环境手动验证: ${FIRST_WB} tools"
    installed_note
    exit 1
    ;;
  *鉴权失败*|*"HTTP 401"*|*"HTTP 403"*|*Unauthorized*|*Invalid*or*missing*API*key*)
    echo ""
    echo "✅ 文件已安装（${#TARGETS[@]} 个技能目录，清单见下）"
    installed_note
    echo "" >&2
    echo "❌ 自检失败：鉴权被拒（APIKEY 无效/已重置，或 --base-url 指向了错误的服务地址）" >&2
    echo "   APIKEY 在控制台「设置 → AI 接入」生成；修正后手动验证: ${FIRST_WB} tools" >&2
    exit 1
    ;;
  *网络错误*|*ECONNREFUSED*|*ENOTFOUND*|*EAI_AGAIN*|*超时*|*timeout*|*Connection*refused*)
    echo ""
    echo "✅ 文件已安装（${#TARGETS[@]} 个技能目录，清单见下）"
    installed_note
    echo "" >&2
    echo "❌ 自检失败：连不上服务（网络/地址问题）——请检查 --base-url 是否可达" >&2
    echo "   修正后手动验证: ${FIRST_WB} tools" >&2
    exit 1
    ;;
  *)
    echo ""
    echo "✅ 文件已安装（${#TARGETS[@]} 个技能目录，清单见下）"
    installed_note
    echo "" >&2
    echo "❌ 自检失败（原因见上方输出）：请检查 --base-url 与 --token 是否正确，或手动运行 ${FIRST_WB} tools 排查" >&2
    exit 1
    ;;
esac
