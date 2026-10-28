#!/usr/bin/env bash
# 定时唤醒的监工：每 SUPERVISE_EVERY_MIN 分钟检查一次。
# 没有新进展时只做零成本心跳，有新记录或异常时才唤醒 LLM 监工。
set -uo pipefail
cd "$(dirname "$0")/.."
R=.ralph
mkdir -p "$R/supervisor" "$R/logs"

EVERY_MIN="${SUPERVISE_EVERY_MIN:-20}"
SUP_MODEL="${SUPERVISOR_MODEL:-sonnet}"
BUDGET_USD="${BUDGET_USD:-60}"
PER_TASK_WARN_USD="${PER_TASK_WARN_USD:-4}"
ITER_TIMEOUT_SEC="${ITER_TIMEOUT_SEC:-2400}"
FORCE_EVERY="${SUPERVISE_FORCE_EVERY:-3}"   # 即使无新进展，每 N 次心跳也唤醒一次 LLM

ALLOWED='Read,Grep,Glob,Bash(node .ralph/lib.mjs:*),Bash(git log:*),Bash(git show:*),Bash(git diff:*),Bash(git status:*),Bash(tail:*),Bash(head:*),Bash(wc:*),Bash(grep:*),Write(.ralph/supervisor/**),Edit(.ralph/supervisor/**),Write(.ralph/PAUSE),Write(.ralph/STOP)'

log() { printf '%s [监工] %s\n' "$(date '+%F %T')" "$*" | tee -a "$R/loop.log"; }
notify() { command -v osascript >/dev/null && osascript -e "display notification \"$1\" with title \"Ralph 监工\"" >/dev/null 2>&1 || true; }

echo $$ > "$R/supervisor.pid"
trap 'rm -f "$R/supervisor.pid"' EXIT
log "▶ 监工启动 pid=$$ 间隔=${EVERY_MIN}分钟 模型=$SUP_MODEL"

seen_rows=-1; idle=0
sup_iter=$(grep -c '"kind":"supervisor"' "$R/ledger.jsonl" 2>/dev/null || true); sup_iter=${sup_iter:-0}
while :; do
  loop_alive=no
  [ -f "$R/loop.pid" ] && kill -0 "$(cat "$R/loop.pid")" 2>/dev/null && loop_alive=yes
  rows=$(grep -c '"kind":"worker"' "$R/ledger.jsonl" 2>/dev/null || true); rows=${rows:-0}
  since=$(node "$R/lib.mjs" metrics | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).minutesSinceLastRow ?? 0))")

  reason=""
  [ "$rows" != "$seen_rows" ] && reason="新记录"
  [ "$loop_alive" = no ] && [ ! -f "$R/STOP" ] && [ "$rows" -gt 0 ] && reason="循环进程不存活"
  [ "$loop_alive" = yes ] && [ "$since" -gt $(( ITER_TIMEOUT_SEC / 60 + 10 )) ] && reason="超过 ${since} 分钟无新记录"
  idle=$((idle + 1)); [ -z "$reason" ] && [ "$idle" -ge "$FORCE_EVERY" ] && reason="定期巡检"

  if [ -z "$reason" ]; then
    log "♡ 心跳：无新进展（循环存活=$loop_alive，距上次记录 ${since} 分钟），跳过 LLM"
  else
    idle=0; seen_rows=$rows; sup_iter=$((sup_iter + 1))
    out="$R/logs/supervisor-$(printf '%03d' "$sup_iter").json"
    ctx="## 本次唤醒上下文
- 时间：$(date '+%F %T')；唤醒原因：$reason
- 循环进程存活：$loop_alive；STOP 文件：$([ -f "$R/STOP" ] && echo 有 || echo 无)；PAUSE 文件：$([ -f "$R/PAUSE" ] && echo 有 || echo 无)
- 预算：\$$BUDGET_USD；每任务成本告警线：\$$PER_TASK_WARN_USD"
    start_sec=$(date +%s)
    claude -p "$(cat "$R/SUPERVISOR.md")

$ctx" --model "$SUP_MODEL" --output-format json --max-turns 25 \
      --allowedTools "$ALLOWED" > "$out" 2> "${out%.json}.err"
    res=$(node "$R/lib.mjs" record supervisor "$sup_iter" "$out" "$start_sec" "$(git rev-parse --short HEAD)")
    verdict=$(node -e "try{const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).result||'';console.log((r.trim().split('\n').pop()||'').trim())}catch{console.log('SUPERVISOR_ERROR')}" "$out")
    log "◎ 巡检（$reason）：$verdict"
    case "$verdict" in
      SUPERVISOR_OK) ;;
      *) notify "$verdict：$(tail -n 6 "$R/supervisor/reports.md" 2>/dev/null | grep '问题' | head -c 120)" ;;
    esac
  fi

  # 循环已结束（STOP 或进程退出且无待做任务）时，做完最后一次巡检就退出
  if [ "$loop_alive" = no ] && { [ -f "$R/STOP" ] || [ "$(node "$R/lib.mjs" pending)" -eq 0 ]; } && [ -z "$reason" ]; then
    log "■ 循环已结束，监工退出"; node "$R/lib.mjs" summary | tee -a "$R/loop.log"; exit 0
  fi
  sleep $(( EVERY_MIN * 60 ))
done
