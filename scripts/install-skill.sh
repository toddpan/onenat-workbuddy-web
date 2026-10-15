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

BASE_URL="" TOKEN="" TARGET_DIR="" UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --base-url) BASE_URL="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --dir) TARGET_DIR="${2:-}"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help)
      sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'
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
SELFTEST="" SELFTEST_RC=0
if command -v node >/dev/null 2>&1 && [ -n "$FIRST_WB" ]; then
  # set -e 下用 `|| RC=$?` 形式：命令非 0 时脚本不会中断，且 $? 仍是 node 的退出码
  SELFTEST="$(node "$FIRST_WB" tools 2>&1)" || SELFTEST_RC=$?
  if [ "$SELFTEST_RC" = "0" ]; then
    echo "$SELFTEST"
  else
    echo "$SELFTEST" >&2
  fi
else
  echo "  ⚠️ 未找到 node，跳过 wb.mjs 自检（wb.mjs 需要 Node ≥ 18）"
fi
MCP_SELFTEST="" MCP_SELFTEST_RC=0
if command -v python3 >/dev/null 2>&1 && [ -n "$FIRST_MCP" ]; then
  MCP_SELFTEST="$(bash "$FIRST_MCP" tools 2>&1)" || MCP_SELFTEST_RC=$?
  if [ "$MCP_SELFTEST_RC" = "0" ]; then
    echo "$MCP_SELFTEST"
  else
    echo "$MCP_SELFTEST" >&2
  fi
else
  echo "  ⚠️ 未找到 python3，跳过 wbmcp.sh 自检（wbmcp.sh 需要 curl + python3）"
fi

installed_note() {
  echo ""
  echo "✅ 安装完成（${#TARGETS[@]} 个技能目录 × 2 套技能）"
  for d in "${TARGETS[@]}"; do
    echo "  技能: $d/onenat-workbuddy/SKILL.md（HTTP 通道；子技能分块文档在 skills/ 子目录，按需读取）"
    echo "        $d/workbuddy-mcp/SKILL.md（MCP 通道；MCP 原生宿主按其内 mcpServers 条目注册）"
  done
  echo "  脚本: ${FIRST_WB}（HTTP 通道）/ ${FIRST_MCP}（MCP 通道，AI 可直接命令行调用）"
  echo "  配置: ${CFG}（600 权限，两通道共用；也可用环境变量 WORKBUDDY_BASE_URL / WORKBUDDY_TOKEN 覆盖）"
  echo ""
  echo "  快速验证: ${FIRST_WB} monitor overview  或  bash ${FIRST_MCP} tools"
}

if [ "$SELFTEST_RC" = "0" ] && [ "$MCP_SELFTEST_RC" = "0" ]; then
  installed_note
  exit 0
fi

# 自检失败：先打印「文件已安装」，再按失败原因分别提示（区分本地环境 / 鉴权 / 网络）
# 退出码约定：
#   本地环境限制（如 /tmp 不可写）→ 退出 0：安装动作本身成功，仅自检受环境限制，不让 CI 误判安装失败
#   鉴权 / 网络 / 其他 → 退出 1：文件已装好，但连通性存疑，CI 应感知并提示人工检查
SELFTEST_ALL="$SELFTEST
${MCP_SELFTEST:-}"
case "$SELFTEST_ALL" in
  *Permission*denied*|*ENOENT*|*EACCES*|*cannot*write*|*No*such*file*)
    echo ""
    echo "⚠️ 自检未通过：本地环境限制（例如 ${TMPDIR:-/tmp} 不可写或 node/python3 异常），与 --base-url/--token 无关"
    echo "   文件已安装（安装动作成功），请在正常环境手动验证: ${FIRST_WB} tools"
    installed_note
    exit 0
    ;;
  *鉴权失败*|*"HTTP 401"*|*"HTTP 403"*|*Unauthorized*|*Invalid*or*missing*API*key*)
    echo ""
    echo "✅ 文件已安装（${#TARGETS[@]} 个技能目录，清单见下）"
    installed_note
    echo "" >&2
    echo "❌ 自检失败：鉴权被拒（APIKEY 无效/过期，或 --base-url 指向了错误的服务地址）" >&2
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
