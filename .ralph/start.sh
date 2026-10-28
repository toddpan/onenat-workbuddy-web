#!/usr/bin/env bash
# 启动 Ralph 循环 + 监工（都在后台，nohup，关闭终端不影响）。
# 用法：.ralph/start.sh            # 默认参数
#       BUDGET_USD=40 SUPERVISE_EVERY_MIN=15 .ralph/start.sh
set -euo pipefail
cd "$(dirname "$0")/.."
R=.ralph
BRANCH="${RALPH_BRANCH:-feat/exec-place-ux}"

if [ -f "$R/loop.pid" ] && kill -0 "$(cat "$R/loop.pid")" 2>/dev/null; then
  echo "循环已在运行（pid $(cat "$R/loop.pid")）"; exit 1
fi
# 已跟踪文件必须干净，否则第一轮工人会在别人的改动上继续；
# 已有的未跟踪文件（如 image.png）不阻塞，loop.sh 会把它们记为基线、不当作工人的残留
if [ -n "$(git status --porcelain --untracked-files=no -- . ':!.ralph' ':!TODO.md')" ]; then
  echo "工作区有未提交改动，请先处理："; git status --short --untracked-files=no -- . ':!.ralph' ':!TODO.md'; exit 1
fi
if [ "$(git branch --show-current)" != "$BRANCH" ]; then
  git switch "$BRANCH" 2>/dev/null || git switch -c "$BRANCH"
fi
# TODO.md 与 .ralph 的流程文件入库（台账/日志/pid 由 .ralph/.gitignore 排除）
git add TODO.md .ralph/.gitignore .ralph/PROMPT.md .ralph/SUPERVISOR.md .ralph/progress.md .ralph/*.sh .ralph/lib.mjs
git diff --cached --quiet || git commit -m "chore(ralph): TODO 与循环/监工脚本

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"

rm -f "$R/STOP" "$R/PAUSE"
chmod +x "$R"/*.sh
nohup "$R/loop.sh" >> "$R/loop.out" 2>&1 &
sleep 2
nohup "$R/supervise.sh" >> "$R/supervisor.out" 2>&1 &
echo "已启动：循环 pid $(cat "$R/loop.pid" 2>/dev/null || echo '?') · 监工 pid $!"
echo "查看：.ralph/status.sh    停止：touch .ralph/STOP"
