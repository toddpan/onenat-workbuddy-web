#!/usr/bin/env bash
# Ralph 循环：每轮用全新上下文的 claude -p 完成 TODO.md 里的一个任务。
# 熔断：.ralph/STOP（停止）/ .ralph/PAUSE（暂停等待删除）/ 预算 / 迭代上限 / 连续无提交 / 单轮超时。
set -uo pipefail
cd "$(dirname "$0")/.."
R=.ralph
mkdir -p "$R/logs"

WORKER_MODEL="${WORKER_MODEL:-opus}"
BUDGET_USD="${BUDGET_USD:-60}"            # 工人+监工累计花费上限
MAX_ITER="${MAX_ITER:-40}"
ITER_TIMEOUT_SEC="${ITER_TIMEOUT_SEC:-2400}"
WORKER_MAX_TURNS="${WORKER_MAX_TURNS:-80}"
MAX_NO_COMMIT="${MAX_NO_COMMIT:-3}"       # 连续 N 轮无提交即停
BRANCH="${RALPH_BRANCH:-feat/exec-place-ux}"

ALLOWED='Read,Edit,Write,Glob,Grep,Bash(npm run build),Bash(npm run typecheck),Bash(npm run smoke),Bash(npm run smoke:*),Bash(npm run test:unit),Bash(grep:*),Bash(rg:*),Bash(sed -n:*),Bash(tail:*),Bash(head:*),Bash(wc:*),Bash(ls:*),Bash(node --check:*),Bash(git status:*),Bash(git diff:*),Bash(git log:*),Bash(git show:*),Bash(git add:*),Bash(git commit:*)'
DENIED='Bash(git push:*),Bash(git reset:*),Bash(git checkout:*),Bash(git clean:*),Bash(git rebase:*),Bash(rm:*),Bash(npm install:*),Bash(npm i:*),WebFetch,WebSearch'

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$R/loop.log"; }
notify() { command -v osascript >/dev/null && osascript -e "display notification \"$1\" with title \"Ralph 循环\"" >/dev/null 2>&1 || true; }
# 任何退出都留下 STOP（含原因）：监工据此判断「正常结束」，不会把已停的循环当异常反复唤醒 LLM
stop() { log "■ 停止：$1"; [ -f "$R/STOP" ] || echo "$1" > "$R/STOP"; notify "停止：$1"; rm -f "$R/loop.pid"; exit "${2:-0}"; }

command -v claude >/dev/null || stop "找不到 claude CLI" 1
[ "$(git branch --show-current)" = "$BRANCH" ] || stop "当前分支不是 $BRANCH（先运行 .ralph/start.sh）" 1
echo $$ > "$R/loop.pid"
trap 'rm -f "$R/loop.pid"' EXIT
# 启动时已存在的未跟踪文件记为基线：每轮的脏检查只关心「已跟踪文件的改动 + 新出现的未跟踪文件」
untracked() { git ls-files --others --exclude-standard -- . ':!.ralph' | sort; }
untracked > "$R/untracked.baseline"

# grep -c 无匹配时输出 0 且返回 1，不能用 `|| echo 0`（会得到 "0\n0"）
iter=$(grep -c '"kind":"worker"' "$R/ledger.jsonl" 2>/dev/null || true); iter=${iter:-0}
log "▶ 循环启动 pid=$$ 模型=$WORKER_MODEL 预算=\$$BUDGET_USD 已有迭代=$iter"

while :; do
  [ -f "$R/STOP" ] && stop "检测到 STOP：$(head -c 300 "$R/STOP")"
  while [ -f "$R/PAUSE" ]; do
    [ -f "$R/STOP" ] && break
    log "⏸ 已暂停：$(head -c 300 "$R/PAUSE")（删除 .ralph/PAUSE 继续）"; sleep 60
  done
  [ -f "$R/STOP" ] && continue

  pending=$(node "$R/lib.mjs" pending)
  [ "$pending" -eq 0 ] && stop "TODO 已无待做任务"
  [ "$iter" -ge "$MAX_ITER" ] && stop "达到迭代上限 $MAX_ITER"
  cost=$(node "$R/lib.mjs" total-cost)
  node -e "process.exit(+process.argv[1] >= +process.argv[2] ? 0 : 1)" "$cost" "$BUDGET_USD" && stop "累计花费 \$$cost 达到预算 \$$BUDGET_USD"
  streak=$(node "$R/lib.mjs" metrics | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).noCommitStreak))")
  [ "$streak" -ge "$MAX_NO_COMMIT" ] && stop "连续 $streak 轮无提交（疑似原地打转）"

  iter=$((iter + 1))
  out="$R/logs/iter-$(printf '%03d' "$iter").json"
  start_sec=$(date +%s); head_before=$(git rev-parse --short HEAD)
  log "→ 第 $iter 轮开始（待做 $pending · 已花 \$$cost）"

  claude -p "$(cat "$R/PROMPT.md")" \
    --model "$WORKER_MODEL" --output-format json --max-turns "$WORKER_MAX_TURNS" \
    --permission-mode acceptEdits --allowedTools "$ALLOWED" --disallowedTools "$DENIED" \
    > "$out" 2> "${out%.json}.err" &
  cpid=$!
  while kill -0 "$cpid" 2>/dev/null; do
    if [ $(( $(date +%s) - start_sec )) -ge "$ITER_TIMEOUT_SEC" ]; then
      log "⏱ 第 $iter 轮超时 ${ITER_TIMEOUT_SEC}s，终止"; kill "$cpid" 2>/dev/null; sleep 5; kill -9 "$cpid" 2>/dev/null; break
    fi
    sleep 10
  done
  wait "$cpid" 2>/dev/null

  res=$(node "$R/lib.mjs" record worker "$iter" "$out" "$start_sec" "$head_before")
  log "← 第 $iter 轮结束：$res"
  case "$res" in
    RALPH_IDLE*) stop "工人报告无可做任务（剩余任务均阻塞或依赖未满足）" ;;
    *SUSPECT*) log "⚠ 第 $iter 轮声称完成但没有提交或未勾选，交给监工核查" ;;
  esac
  # 工作区残留未提交改动时不进入下一轮，避免下一轮在脏状态上继续
  dirty="$(git status --porcelain --untracked-files=no -- . ':!.ralph'; untracked | comm -13 "$R/untracked.baseline" - | sed 's/^/?? /')"
  if [ -n "$dirty" ]; then
    echo "第 $iter 轮结束后工作区有未提交改动，需人工检查：$(printf '%s\n' "$dirty" | head -5 | tr '\n' ' ')" > "$R/PAUSE"
    log "⏸ 工作区不干净，已自动暂停"; notify "工作区不干净，已暂停"
  fi
done
