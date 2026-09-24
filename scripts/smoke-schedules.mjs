#!/usr/bin/env node
/**
 * OneNat WorkBuddy — 定时任务功能冒烟测试（独立部署模式，不依赖真实 LLM）
 *
 *   node scripts/smoke-schedules.mjs
 *
 * 覆盖：
 *   1. 规则→下次触发点计算（daily / weekly / interval / once，Host 本地时区）
 *   2. 定时任务 REST API（创建/校验拒绝/列表/详情/更新/启停/删除）
 *   3. 手动立即执行：多子智能体各自派生任务会话 + 触发记录（manual 标记）
 *   4. 定时自动触发：
 *      - once（未来 2s）：tick 到期触发且自动停用（nextRunAt 清空）
 *      - interval 1min：到期自动触发，nextRunAt 顺延
 *   5. 调度器持久化：重启服务后 nextRunAt 恢复、触发历史保留
 *
 * 退出码非 0 即失败。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.SMOKE_PORT || 18093)
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT || 18082)
const PREFIX = '/onenat-workbuddy'
const BASE = `http://127.0.0.1:${PORT}`

const results = []
let failures = 0

function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  if (!ok) failures++
  results.push(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`)
}

let COOKIE = ''

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(COOKIE ? { Cookie: COOKIE } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let json
  try {
    json = await res.json()
  } catch {
    json = undefined
  }
  return { status: res.status, json }
}

async function login(username, password) {
  const res = await fetch(BASE + `${PREFIX}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  COOKIE = (res.headers.get('set-cookie') || '').split(';')[0]
  return res.ok
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond, label, timeoutMs = 60000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await cond()) return Date.now() - t0
    } catch {
      /* retry */
    }
    await sleep(500)
  }
  throw new Error(`等待超时: ${label}`)
}

const procs = []
function spawnJob(name, cmd, args, env = {}) {
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const lines = []
  child.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)))
  child.stderr.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)))
  child.logs = lines
  procs.push(child)
  return child
}

function cleanup() {
  for (const p of procs) {
    try {
      p.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
}
process.on('exit', cleanup)
process.on('SIGINT', () => process.exit(1))

const ts = (n) => new Date(n).toLocaleString('zh-CN', { hour12: false })

async function main() {
  if (!existsSync(join(ROOT, 'dist', 'server.js'))) {
    console.error('缺少 dist/server.js —— 先执行: bash scripts/build-standalone.sh')
    process.exit(1)
  }

  console.log(`\n== OneNat WorkBuddy 定时任务冒烟 ==\n   服务 ${BASE}${PREFIX}\n`)

  // ---------- 1. 规则计算（直接调用编译产物） ----------
  const { nextRun, normalizeRule } = await import(resolve(ROOT, 'dist', 'scheduler.js').replace('file://', ''))
  const from = new Date('2026-09-10T15:00:00').getTime() // 周四
  const r1 = nextRun({ kind: 'daily', times: ['09:00', '18:30'] }, from)
  check('daily 多时刻取下一个未来点', r1 === new Date('2026-09-10T18:30:00').getTime(), `→ ${ts(r1)}`)
  const r2 = nextRun({ kind: 'weekly', days: [1], time: '08:00' }, from)
  check('weekly 跳到下周一', r2 === new Date('2026-09-14T08:00:00').getTime(), `→ ${ts(r2)}`)
  const r3 = nextRun({ kind: 'interval', minutes: 30 }, from)
  check('interval = from + N 分钟', r3 === from + 30 * 60_000, `→ ${ts(r3)}`)
  check('once 已过期 → undefined', nextRun({ kind: 'once', at: from - 1 }, from) === undefined)
  check('once 未来 → 原时刻', nextRun({ kind: 'once', at: from + 5 }, from) === from + 5)
  check('daily 非法时刻被拒', (() => { try { normalizeRule({ kind: 'daily', times: ['25:00'] }); return false } catch { return true } })())
  check('interval 0 分钟被拒', (() => { try { normalizeRule({ kind: 'interval', minutes: 0 }); return false } catch { return true } })())

  // ---------- 1b. 新增规则 hourly / monthly + ruleText ----------
  const { ruleText } = await import(resolve(ROOT, 'dist', 'scheduler.js').replace('file://', ''))
  const rh = nextRun({ kind: 'hourly', minute: 0 }, from)
  check('hourly 取下一个整点', rh === new Date('2026-09-10T16:00:00').getTime(), `→ ${ts(rh)}`)
  const rh2 = nextRun({ kind: 'hourly', minute: 30 }, from)
  check('hourly 半点在当小时内', rh2 === new Date('2026-09-10T15:30:00').getTime(), `→ ${ts(rh2)}`)
  const rm = nextRun({ kind: 'monthly', days: [1, 15], time: '08:00' }, from)
  check('monthly 跳到下个勾选日（9/15）', rm === new Date('2026-09-15T08:00:00').getTime(), `→ ${ts(rm)}`)
  const rm2 = nextRun({ kind: 'monthly', days: [31], time: '08:00' }, from)
  check('monthly 31 号在 9 月自动跳过（→10/31）', rm2 === new Date('2026-10-31T08:00:00').getTime(), `→ ${ts(rm2)}`)
  check('hourly 非法分钟被拒', (() => { try { normalizeRule({ kind: 'hourly', minute: 60 }); return false } catch { return true } })())
  check('monthly 空日期被拒', (() => { try { normalizeRule({ kind: 'monthly', days: [], time: '08:00' }); return false } catch { return true } })())
  check('monthly 日期越界被拒', (() => { try { normalizeRule({ kind: 'monthly', days: [0, 32], time: '08:00' }); return false } catch { return true } })())
  check('ruleText hourly', ruleText({ kind: 'hourly', minute: 0 }) === '每小时的第 0 分', ruleText({ kind: 'hourly', minute: 0 }))
  check('ruleText weekly 工作日', ruleText({ kind: 'weekly', days: [1, 2, 3, 4, 5], time: '9:00' }) === '每工作日 9:00', ruleText({ kind: 'weekly', days: [1, 2, 3, 4, 5], time: '9:00' }))
  check('ruleText monthly', ruleText({ kind: 'monthly', days: [1, 15], time: '08:00' }) === '每月 1、15 号 08:00', ruleText({ kind: 'monthly', days: [1, 15], time: '08:00' }))
  check('ruleText interval 小时/天归一', ruleText({ kind: 'interval', minutes: 90 }) === '每 90 分钟' && ruleText({ kind: 'interval', minutes: 120 }) === '每 2 小时' && ruleText({ kind: 'interval', minutes: 1440 }) === '每 1 天')

  // ---------- 2. 启动 mock ONENAT + standalone server ----------
  const dataDir = mkdtempSync(join(tmpdir(), 'workbuddy-sched-smoke-'))
  console.log(`   数据目录 ${dataDir}\n`)
  spawnJob('mock-onenat', process.execPath, [join(ROOT, 'scripts', 'mock-onenat.cjs')], { MOCK_ONENAT_PORT: String(MOCK_PORT) })
  const startServer = () =>
    spawnJob('server', process.execPath, [
      join(ROOT, 'dist', 'server.js'),
      '--port', String(PORT),
      '--data', dataDir,
      '--onenat-base-url', `http://127.0.0.1:${MOCK_PORT}`,
      '--onenat-api-key', 'onk-mock-key-000',
      '--quiet',
    ])
  let server = startServer()
  await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok, 'standalone server 就绪')
  await login('workbuddy', 'ThunderSoft@88')

  // ---------- 3. 准备两个子智能体 ----------
  const a1 = await req('POST', `${PREFIX}/api/agents`, { name: '执行者甲', dshRef: { kind: 'mapping', mappingId: 'map-dsh-live' } })
  const a2 = await req('POST', `${PREFIX}/api/agents`, { name: '执行者乙', dshRef: { kind: 'mapping', mappingId: 'map-dsh-01' } })
  const id1 = a1.json?.data?.id
  const id2 = a2.json?.data?.id
  check('准备 2 个子智能体', Boolean(id1) && Boolean(id2), `${id1} / ${id2}`)

  // ---------- 4. 创建 + 入参校验 ----------
  // 新语义：无 @ 子智能体 = 主 DSH 直发（运行时回退首个在线 DSH），允许创建
  const bad1 = await req('POST', `${PREFIX}/api/schedules`, { name: '坏-无成员', agentIds: [], message: 'x', rule: { kind: 'interval', minutes: 5 } })
  check('无子智能体允许创建（主 DSH 直发语义）', bad1.status === 200 && Boolean(bad1.json?.data?.id), `status=${bad1.status}`)
  const bad1Del = await req('DELETE', `${PREFIX}/api/schedules/${bad1.json?.data?.id || ''}`)
  const bad2 = await req('POST', `${PREFIX}/api/schedules`, { name: '坏-未知成员', agentIds: ['agent-nope'], message: 'x', rule: { kind: 'interval', minutes: 5 } })
  check('未知子智能体被拒（400）', bad2.status === 400 && /不存在/.test(bad2.json?.error || ''))
  const bad3 = await req('POST', `${PREFIX}/api/schedules`, { name: '坏-空文本', agentIds: [id1], message: '  ', rule: { kind: 'interval', minutes: 5 } })
  check('空任务文本被拒（400）', bad3.status === 400 && /任务文本/.test(bad3.json?.error || ''))
  const bad4 = await req('POST', `${PREFIX}/api/schedules`, { name: '坏-过去时刻', agentIds: [id1], message: 'x', rule: { kind: 'once', at: Date.now() - 60_000 } })
  check('once 过去时刻被拒（400）', bad4.status === 400 && /未来/.test(bad4.json?.error || ''))

  const sched = await req('POST', `${PREFIX}/api/schedules`, {
    name: '冒烟定时任务',
    description: '冒烟',
    agentIds: [id1, id2],
    message: '定时冒烟：请回复收到',
    rule: { kind: 'interval', minutes: 1 },
    enabled: true,
  })
  const sid = sched.json?.data?.id
  check('创建定时任务成功', sched.status === 200 && Boolean(sid), `id=${sid}`)
  const firstNext = sched.json?.data?.nextRunAt
  check('创建后返回 nextRunAt（≈60s 后）', typeof firstNext === 'number' && firstNext > Date.now() + 30_000 && firstNext < Date.now() + 90_000, `→ ${ts(firstNext)}`)

  const dup = await req('POST', `${PREFIX}/api/schedules`, { id: sid, name: '冒烟定时任务-改名', agentIds: [id1], message: '改后文本', rule: { kind: 'daily', times: ['07:30'] }, enabled: true })
  check('带 id 更新（改名/改规则）', dup.status === 200 && dup.json?.data?.name === '冒烟定时任务-改名' && dup.json?.data?.rule?.kind === 'daily')

  // ---------- 5b. 模板 + 摘要统计/自然语言规则 ----------
  const tpl = await req('GET', `${PREFIX}/api/schedule-templates`)
  check('内置模板接口可用（≥4 个）', tpl.status === 200 && (tpl.json?.data || []).length >= 4 && (tpl.json.data).every((t) => t.name && t.message && t.rule), `${tpl.json?.data?.length} 个`)
  check('摘要含 ruleText / totalRuns / successRuns', typeof dup.json?.data?.ruleText === 'string' && dup.json?.data?.totalRuns === 0 && dup.json?.data?.successRuns === 0, `ruleText=${dup.json?.data?.ruleText}`)
  const badHourly = await req('POST', `${PREFIX}/api/schedules`, { name: '坏 hourly', agentIds: [id1], message: 'x', rule: { kind: 'hourly', minute: 99 } })
  check('hourly 非法分钟 API 被拒（400）', badHourly.status === 400)
  await req('POST', `${PREFIX}/api/schedules`, { id: sid, name: '冒烟定时任务', agentIds: [id1, id2], message: '定时冒烟：请回复收到', rule: { kind: 'interval', minutes: 1 }, enabled: true })

  // ---------- 5. 手动立即执行（多智能体派发） ----------
  const runRes = await req('POST', `${PREFIX}/api/schedules/${sid}/run`)
  const run = runRes.json?.data
  check('手动触发返回 run', runRes.status === 200 && Boolean(run?.id))
  check('单任务派发：每个目标子智能体各占一条派发项且指向同一会话', (run?.items || []).length === 2 && run.items.every((i) => Boolean(i.taskId)) && new Set(run.items.map((i) => i.taskId)).size === 1, run?.items?.map((i) => `${i.agentName}→${i.taskId}`).join(' , '))
  const manualFlag = run?.manual === true
  check('触发记录标记 manual=true', manualFlag)
  const detail1 = await req('GET', `${PREFIX}/api/schedules/${sid}`)
  check('详情回读触发记录', (detail1.json?.data?.runs || []).length === 1)
  check('详情联查任务会话状态', (detail1.json?.data?.runs?.[0]?.items || []).every((i) => typeof i.taskStatus === 'string'), detail1.json?.data?.runs?.[0]?.items?.map((i) => i.taskStatus).join(','))
  check('详情包含完整任务文本', detail1.json?.data?.message === '定时冒烟：请回复收到')
  check('触发后统计计数 +1（totalRuns/successRuns）', detail1.json?.data?.totalRuns === 1 && detail1.json?.data?.successRuns === 1, `total=${detail1.json?.data?.totalRuns} ok=${detail1.json?.data?.successRuns}`)
  check('派发项记录尝试次数 attempts', (detail1.json?.data?.runs?.[0]?.items || []).every((i) => i.attempts >= 1))
  check('触发记录含耗时 durationMs', typeof detail1.json?.data?.runs?.[0]?.durationMs === 'number')
  const tasksAfter = await req('GET', `${PREFIX}/api/tasks`)
  const schedTasks = (tasksAfter.json?.data || []).filter((t) => (t.title || '').includes('冒烟定时任务'))
  check('派生的任务出现在任务列表（⏰ 标题，单任务）', schedTasks.length >= 1, schedTasks.map((t) => t.id).join(','))

  // ---------- 6. 启停 ----------
  const off = await req('POST', `${PREFIX}/api/schedules/${sid}/toggle`)
  check('停用后 nextRunAt 清空', off.json?.data?.enabled === false && off.json?.data?.nextRunAt == null)
  const on = await req('POST', `${PREFIX}/api/schedules/${sid}/toggle`)
  check('重新启用后重算 nextRunAt', on.json?.data?.enabled === true && typeof on.json?.data?.nextRunAt === 'number')

  // ---------- 7. once 自动触发 + 自动停用（等 tick，≤45s） ----------
  const onceSched = await req('POST', `${PREFIX}/api/schedules`, {
    name: '冒烟一次性',
    agentIds: [id1],
    message: '一次性冒烟',
    rule: { kind: 'once', at: Date.now() + 2_000 },
    enabled: true,
  })
  const onceId = onceSched.json?.data?.id
  const onceFired = await waitFor(async () => {
    const d = await req('GET', `${PREFIX}/api/schedules/${onceId}`)
    return (d.json?.data?.runs || []).length > 0
  }, 'once 定时自动触发', 60_000).catch(() => 0)
  check('once 到期自动触发（Host tick）', Boolean(onceFired), `耗时 ${Number(onceFired) / 1000}s`)
  const onceDetail = await req('GET', `${PREFIX}/api/schedules/${onceId}`)
  check('once 触发后自动停用', onceDetail.json?.data?.enabled === false && onceDetail.json?.data?.nextRunAt == null)
  check('once 触发记录非 manual', onceDetail.json?.data?.runs?.[0]?.manual === false)

  // ---------- 8. interval 1min 自动触发 + nextRunAt 顺延（≤110s） ----------
  const before = await req('GET', `${PREFIX}/api/schedules/${sid}`)
  const runCount0 = before.json?.data?.runCount
  const next0 = before.json?.data?.nextRunAt
  const fired = await waitFor(async () => {
    const d = await req('GET', `${PREFIX}/api/schedules/${sid}`)
    return (d.json?.data?.runCount || 0) >= runCount0 + 1
  }, 'interval 定时自动触发', 120_000).catch(() => 0)
  check('interval 到期自动触发（≤120s）', Boolean(fired), `耗时 ${Number(fired) / 1000}s`)
  const after = await req('GET', `${PREFIX}/api/schedules/${sid}`)
  const autoRun = (after.json?.data?.runs || []).find((r) => r.id !== before.json?.data?.runs?.[0]?.id)
  check('自动触发记录非 manual', autoRun ? autoRun.manual === false : false)
  const next1 = after.json?.data?.nextRunAt
  check('触发后 nextRunAt 顺延一个周期', typeof next1 === 'number' && next1 > Date.now(), `→ ${ts(next1)}`)

  // ---------- 9. 重启持久化：历史保留 + nextRunAt 恢复 ----------
  const runsBeforeRestart = after.json?.data?.runCount
  try {
    server.kill('SIGKILL')
  } catch {
    /* ignore */
  }
  await sleep(500)
  server = startServer()
  await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok, 'server 重启就绪')
  COOKIE = ''
  await login('workbuddy', 'ThunderSoft@88')
  const afterRestart = await req('GET', `${PREFIX}/api/schedules/${sid}`)
  check('重启后触发历史保留', afterRestart.json?.data?.runCount === runsBeforeRestart, `${runsBeforeRestart} 条`)
  check('重启后 nextRunAt 恢复且在未来', typeof afterRestart.json?.data?.nextRunAt === 'number' && afterRestart.json.data.nextRunAt > Date.now())
  const onceAfterRestart = await req('GET', `${PREFIX}/api/schedules/${onceId}`)
  check('重启后 once 保持停用', onceAfterRestart.json?.data?.enabled === false)

  // ---------- 10. 删除 ----------
  const del = await req('DELETE', `${PREFIX}/api/schedules/${sid}`)
  const delOnce = await req('DELETE', `${PREFIX}/api/schedules/${onceId}`)
  const listAfterDel = await req('GET', `${PREFIX}/api/schedules`)
  const delExtra = await req('DELETE', `${PREFIX}/api/schedules/${bad1.json?.data?.id || ''}`)
  check('删除定时任务', del.json?.data?.deleted === true && delOnce.json?.data?.deleted === true && (listAfterDel.json?.data || []).length === 0)

  // ---------- 结果 ----------
  console.log('\n== 定时任务冒烟结果 ==')
  for (const line of results) console.log(line)
  const passed = results.filter((l) => l.startsWith('  ✅')).length
  console.log(`\n${failures === 0 ? '✅ ALL PASS' : '❌ FAILED'} — ${passed}/${results.length}\n`)

  rmSync(dataDir, { recursive: true, force: true })
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('冒烟中断:', err?.message || err)
  process.exit(1)
})
