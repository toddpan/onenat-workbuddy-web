#!/usr/bin/env bash
# =============================================================
# OneNat WorkBuddy — SKILL 一键安装脚本
#
# 由 WorkBuddy 服务端提供（GET /onenat-workbuddy/install-skill.sh），
# 本脚本不含任何秘密：APIKEY 由安装者在参数里传入，只写入本机配置文件。
#
# 默认安装到本机全部 AI 技能目录（DSH / ZCode / Claude，已存在或不存在都会创建安装）；
# 用 --dir 可只装到指定目录（支持别名 dsh / zcode / claude 或任意路径）。
#
# 用法:
#   curl -fsSL http://<host>:3081/onenat-workbuddy/install-skill.sh | bash -s -- \
#     --base-url http://<host>:3081/onenat-workbuddy --token wbk-xxxx [--dir dsh|zcode|claude|路径]
#
# 参数:
#   --base-url <url>   WorkBuddy 服务地址（含前缀，必填）
#   --token <apikey>   AI APIKEY（控制台「设置 → AI 接入」生成，必填）
#   --dir <path|别名>   只装到指定技能目录；别名: dsh / zcode / claude。缺省 = 全部 AI 目录
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
      sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'
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
    *) printf '%s' "$1" ;;
  esac
}

CFG="$HOME/.workbuddy-skill.json"

# ---------- 卸载（全部目录） ----------
if [ "$UNINSTALL" = "1" ]; then
  for d in "$(resolve_dir dsh)" "$(resolve_dir zcode)" "$(resolve_dir claude)"; do
    [ -e "$d/onenat-workbuddy" ] && rm -rf "$d/onenat-workbuddy" && echo "✓ 已移除 $d/onenat-workbuddy"
  done
  if [ -n "$TARGET_DIR" ] && [ -e "$(resolve_dir "$TARGET_DIR")/onenat-workbuddy" ]; then
    rm -rf "$(resolve_dir "$TARGET_DIR")/onenat-workbuddy"
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
  TARGETS=("$(resolve_dir dsh)" "$(resolve_dir zcode)" "$(resolve_dir claude)")
fi

# ---------- 下载安装到每个目录 ----------
FIRST_WB=""
for d in "${TARGETS[@]}"; do
  echo "▸ 安装到 $d"
  mkdir -p "$d/onenat-workbuddy/scripts"
  curl -fsSL --max-time 30 "$BASE_URL/install/SKILL.md" -o "$d/onenat-workbuddy/SKILL.md"
  curl -fsSL --max-time 30 "$BASE_URL/install/wb.mjs" -o "$d/onenat-workbuddy/scripts/wb.mjs"
  chmod +x "$d/onenat-workbuddy/scripts/wb.mjs" 2>/dev/null || true
  [ -z "$FIRST_WB" ] && FIRST_WB="$d/onenat-workbuddy/scripts/wb.mjs"
done

# ---------- 写配置（仅本机，600 权限） ----------
printf '{\n  "baseUrl": "%s",\n  "token": "%s",\n  "installedAt": %s\n}\n' \
  "$BASE_URL" "$TOKEN" "$(date +%s000)" > "$CFG"
chmod 600 "$CFG"

# ---------- 连通性自检（跑一次即可） ----------
# 注意：自检输出直接捕获到变量，不落盘——/tmp 不可写的沙箱（Termux 等）也能通过。
echo "▸ 连通性自检"
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
  echo "  ⚠️ 未找到 node，跳过自检（wb.mjs 需要 Node ≥ 18）"
fi

installed_note() {
  echo ""
  echo "✅ 安装完成（${#TARGETS[@]} 个技能目录）"
  for d in "${TARGETS[@]}"; do
    echo "  技能: $d/onenat-workbuddy/SKILL.md"
  done
  echo "  脚本: ${FIRST_WB}（AI 可直接命令行调用）"
  echo "  配置: ${CFG}（600 权限；也可用环境变量 WORKBUDDY_BASE_URL / WORKBUDDY_TOKEN 覆盖）"
  echo ""
  echo "  快速验证: ${FIRST_WB} monitor overview"
}

if [ "$SELFTEST_RC" = "0" ]; then
  installed_note
  exit 0
fi

# 自检失败：先打印「文件已安装」，再按失败原因分别提示（区分本地环境 / 鉴权 / 网络）
# 退出码约定：
#   本地环境限制（如 /tmp 不可写）→ 退出 0：安装动作本身成功，仅自检受环境限制，不让 CI 误判安装失败
#   鉴权 / 网络 / 其他 → 退出 1：文件已装好，但连通性存疑，CI 应感知并提示人工检查
case "$SELFTEST" in
  *Permission*denied*|*ENOENT*|*EACCES*|*cannot*write*|*No*such*file*)
    echo ""
    echo "⚠️ 自检未通过：本地环境限制（例如 ${TMPDIR:-/tmp} 不可写或 node 异常），与 --base-url/--token 无关"
    echo "   文件已安装（安装动作成功），请在正常环境手动验证: ${FIRST_WB} tools"
    installed_note
    exit 0
    ;;
  *鉴权失败*|*"HTTP 401"*|*"HTTP 403"*)
    echo ""
    echo "✅ 文件已安装（${#TARGETS[@]} 个技能目录，清单见下）"
    installed_note
    echo "" >&2
    echo "❌ 自检失败：鉴权被拒（APIKEY 无效/过期，或 --base-url 指向了错误的服务地址）" >&2
    echo "   APIKEY 在控制台「设置 → AI 接入」生成；修正后手动验证: ${FIRST_WB} tools" >&2
    exit 1
    ;;
  *网络错误*|*ECONNREFUSED*|*ENOTFOUND*|*EAI_AGAIN*|*超时*|*timeout*)
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
