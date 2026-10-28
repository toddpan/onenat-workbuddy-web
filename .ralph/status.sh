#!/usr/bin/env bash
# 一屏看循环状态：进程、指标、最近事件、监工最近判断。
cd "$(dirname "$0")/.."
R=.ralph
alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null && echo "运行中 pid $(cat "$1")" || echo "未运行"; }
echo "循环：$(alive "$R/loop.pid") · 监工：$(alive "$R/supervisor.pid")"
[ -f "$R/STOP" ] && echo "STOP：$(cat "$R/STOP")"
[ -f "$R/PAUSE" ] && echo "PAUSE：$(cat "$R/PAUSE")"
echo; node "$R/lib.mjs" summary
echo; echo "── 最近事件"; tail -n 12 "$R/loop.log" 2>/dev/null
echo; echo "── 监工最近报告"; tail -n 8 "$R/supervisor/reports.md" 2>/dev/null || echo "（暂无）"
echo; echo "── 给工人的指示"; cat "$R/supervisor/notes.md" 2>/dev/null || echo "（无）"
