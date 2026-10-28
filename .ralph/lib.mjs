#!/usr/bin/env node
// Ralph 循环与监工共用的确定性工具：台账记录、指标汇总、任务计数。
// 用法：
//   node .ralph/lib.mjs record <kind:worker|supervisor> <iter> <json输出文件> <开始epoch秒> <开始HEAD>
//   node .ralph/lib.mjs metrics            → 打印 JSON 指标
//   node .ralph/lib.mjs summary            → 打印人读摘要
//   node .ralph/lib.mjs pending            → 打印待做任务数（[ ]）
//   node .ralph/lib.mjs total-cost         → 打印累计花费（USD，工人+监工）
import { readFileSync, appendFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const RALPH = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(RALPH)
const LEDGER = join(RALPH, 'ledger.jsonl')

function readJsonl(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)] } catch { return [] }
  })
}

function git(...args) {
  try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim() } catch { return '' }
}

function todoCounts() {
  const text = existsSync(join(ROOT, 'TODO.md')) ? readFileSync(join(ROOT, 'TODO.md'), 'utf8') : ''
  const count = (mark) => (text.match(new RegExp('^- \\[' + mark + '\\] \\*\\*', 'gm')) || []).length
  const ids = (mark) => [...text.matchAll(new RegExp('^- \\[' + mark + '\\] \\*\\*([^*]+)\\*\\*', 'gm'))].map((m) => m[1])
  return { done: count('x'), pending: count(' '), blocked: count('!'), deferred: count('~'), blockedIds: ids('!'), doneIds: ids('x') }
}

function record([kind, iter, outFile, startSec, startHead]) {
  let out = {}
  try { out = JSON.parse(readFileSync(outFile, 'utf8')) } catch { out = { is_error: true, result: '（无法解析 claude 输出，见 .err 日志）' } }
  const result = String(out.result || '')
  const lastLine = result.trim().split('\n').pop() || ''
  const m = /^(RALPH_DONE|RALPH_BLOCKED|RALPH_IDLE)\b\s*(\S*)/.exec(lastLine.trim())
  const marker = m ? m[1] : (out.is_error ? 'ERROR' : 'NO_MARKER')
  const head = git('rev-parse', '--short', 'HEAD')
  const counts = todoCounts()
  const u = out.usage || {}
  const row = {
    kind, iter: Number(iter), at: new Date().toISOString(),
    durationSec: Math.round(Date.now() / 1000 - Number(startSec)),
    marker, task: m ? m[2] : '', subtype: out.subtype || '', isError: Boolean(out.is_error),
    costUsd: Number(out.total_cost_usd || 0), numTurns: Number(out.num_turns || 0),
    tokens: { input: u.input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 },
    headBefore: startHead, headAfter: head, committed: Boolean(startHead && head && startHead !== head),
    todo: { done: counts.done, pending: counts.pending, blocked: counts.blocked },
  }
  // 工人声称完成，但 TODO 没标 [x] 或没有新提交 → 记为可疑，监工会看到
  if (kind === 'worker' && marker === 'RALPH_DONE' && (!row.committed || !counts.doneIds.includes(row.task))) row.suspect = true
  appendFileSync(LEDGER, JSON.stringify(row) + '\n')
  process.stdout.write(marker + (row.task ? ' ' + row.task : '') + (row.suspect ? ' SUSPECT' : '') + '\n')
}

function metrics() {
  const rows = readJsonl(LEDGER)
  const workers = rows.filter((r) => r.kind === 'worker')
  const sum = (list, f) => list.reduce((a, r) => a + f(r), 0)
  const workerCost = sum(workers, (r) => r.costUsd)
  const supervisorCost = sum(rows.filter((r) => r.kind === 'supervisor'), (r) => r.costUsd)
  const counts = todoCounts()
  let noCommitStreak = 0
  for (let i = workers.length - 1; i >= 0 && !workers[i].committed; i--) noCommitStreak++
  const doneRows = workers.filter((r) => r.marker === 'RALPH_DONE' && r.committed)
  const costPerDone = doneRows.length ? sum(doneRows, (r) => r.costUsd) / doneRows.length : null
  const last = rows[rows.length - 1]
  return {
    iterations: workers.length,
    costUsd: { worker: +workerCost.toFixed(4), supervisor: +supervisorCost.toFixed(4), total: +(workerCost + supervisorCost).toFixed(4) },
    costPerDoneTask: costPerDone === null ? null : +costPerDone.toFixed(4),
    projectedRemainingUsd: costPerDone === null ? null : +(costPerDone * counts.pending).toFixed(2),
    avgDurationSec: workers.length ? Math.round(sum(workers, (r) => r.durationSec) / workers.length) : null,
    tokens: {
      input: sum(rows, (r) => r.tokens?.input || 0), cacheWrite: sum(rows, (r) => r.tokens?.cacheWrite || 0),
      cacheRead: sum(rows, (r) => r.tokens?.cacheRead || 0), output: sum(rows, (r) => r.tokens?.output || 0),
    },
    noCommitStreak,
    suspects: workers.filter((r) => r.suspect).map((r) => ({ iter: r.iter, task: r.task })),
    markers: workers.reduce((a, r) => { a[r.marker] = (a[r.marker] || 0) + 1; return a }, {}),
    minutesSinceLastRow: last ? Math.round((Date.now() - Date.parse(last.at)) / 60000) : null,
    todo: counts,
    lastWorkers: workers.slice(-5).map((r) => ({ iter: r.iter, marker: r.marker, task: r.task, costUsd: r.costUsd, turns: r.numTurns, sec: r.durationSec, committed: r.committed })),
  }
}

function summary() {
  const m = metrics()
  const lines = [
    `迭代 ${m.iterations} 次 · 任务 完成 ${m.todo.done} / 待做 ${m.todo.pending} / 阻塞 ${m.todo.blocked}${m.todo.blockedIds.length ? '（' + m.todo.blockedIds.join(', ') + '）' : ''}`,
    `花费 $${m.costUsd.total}（工人 $${m.costUsd.worker} · 监工 $${m.costUsd.supervisor}）· 每完成一个任务 $${m.costPerDoneTask ?? '-'} · 预计剩余 $${m.projectedRemainingUsd ?? '-'}`,
    `token 输入 ${m.tokens.input} · 缓存写 ${m.tokens.cacheWrite} · 缓存读 ${m.tokens.cacheRead} · 输出 ${m.tokens.output}`,
    `连续无提交 ${m.noCommitStreak} 次 · 可疑完成 ${m.suspects.length} 次 · 距上次记录 ${m.minutesSinceLastRow ?? '-'} 分钟`,
    `最近：${m.lastWorkers.map((r) => `#${r.iter} ${r.marker} ${r.task} $${r.costUsd.toFixed(2)} ${r.turns}轮 ${r.sec}s${r.committed ? '' : ' 无提交'}`).join(' | ') || '无'}`,
  ]
  process.stdout.write(lines.join('\n') + '\n')
}

const [cmd, ...rest] = process.argv.slice(2)
if (cmd === 'record') record(rest)
else if (cmd === 'metrics') process.stdout.write(JSON.stringify(metrics(), null, 2) + '\n')
else if (cmd === 'summary') summary()
else if (cmd === 'pending') process.stdout.write(String(todoCounts().pending) + '\n')
else if (cmd === 'total-cost') process.stdout.write(String(metrics().costUsd.total) + '\n')
else { process.stderr.write('未知命令: ' + cmd + '\n'); process.exit(2) }
