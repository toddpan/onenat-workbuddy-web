#!/usr/bin/env node
/**
 * OneNat WorkBuddy — AI 技能接入冒烟测试（鉴权 / 新工具 / 安装脚本 / wb.mjs）
 *
 *   node scripts/smoke-ai-skill.mjs
 *
 * 覆盖：
 *   1. fail-closed：未配置令牌 → 工具通道与 AI 开放面一律 401
 *   2. --token 种子 + Bearer 放行；令牌面之外（如 /api/settings）403
 *   3. 设置页 APIKEY：GET /api/settings 含 aiToken；重置后旧令牌失效、新令牌生效（无需重启）
 *   4. 新工具：monitor_read / schedule_manage（CRUD+run）/ planner_manage（get/set/options）/ task wait（超时路径）
 *   5. install-skill.sh / install/SKILL.md / install/wb.mjs 公开端点
 *   6. wb.mjs 实跑（monitor overview / tools）+ file download --out
 *   7. 文件工具参数校验（upload 缺内容来源 → 明确报错）
 *
 * 退出码非 0 即失败。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.SMOKE_PORT || 18097)
const PORT2 = Number(process.env.SMOKE_PORT2 || 18098)
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT || 18086)
const PREFIX = '/onenat-workbuddy'
const BASE = `http://127.0.0.1:${PORT}`
const BASE2 = `http://127.0.0.1:${PORT2}`

const results = []
let failures = 0

function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  if (!ok) failures++
  results.push(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
    } catch { /* ignore */ }
  }
}
process.on('exit', cleanup)
process.on('SIGINT', () => process.exit(1))

async function waitHealth(base) {
  const t0 = Date.now()
  while (Date.now() - t0 < 30000) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return
    } catch { /* retry */ }
    await sleep(400)
  }
  throw new Error('服务启动超时: ' + base)
}

async function tool(base, token, name, args) {
  const res = await fetch(`${base}${PREFIX}/api/tools/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(args || {}),
  })
  let json
  try { json = await res.json() } catch { json = {} }
  return { status: res.status, json }
}

function runNode(args, env = {}) {
  return new Promise((resolveP) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => resolveP({ code, out, err }))
  })
}

async function main() {
  if (!existsSync(join(ROOT, 'dist', 'server.js'))) {
    console.error('缺少 dist/server.js —— 先执行: bash scripts/build-standalone.sh')
    process.exit(1)
  }

  console.log(`\n== OneNat WorkBuddy AI 技能接入冒烟 ==\n   实例A ${BASE}（无令牌，验证 fail-closed）\n   实例B ${BASE2}（--token 种子）\n`)

  const dataDirA = mkdtempSync(join(tmpdir(), 'workbuddy-ai-a-'))
  const dataDirB = mkdtempSync(join(tmpdir(), 'workbuddy-ai-b-'))
  spawnJob('mock-onenat', process.execPath, [join(ROOT, 'scripts', 'mock-onenat.cjs')], { MOCK_ONENAT_PORT: String(MOCK_PORT) })
  spawnJob('server-a', process.execPath, [join(ROOT, 'dist', 'server.js'), '--port', String(PORT), '--data', dataDirA,
    '--onenat-base-url', `http://127.0.0.1:${MOCK_PORT}`, '--onenat-api-key', 'onk-mock-key-000', '--quiet'])
  spawnJob('server-b', process.execPath, [join(ROOT, 'dist', 'server.js'), '--port', String(PORT2), '--data', dataDirB,
    '--onenat-base-url', `http://127.0.0.1:${MOCK_PORT}`, '--onenat-api-key', 'onk-mock-key-000', '--quiet', '--token', 'seed-token-123'])
  await waitHealth(BASE)
  await waitHealth(BASE2)

  // ---------- 1. fail-closed ----------
  const anonTools = await fetch(`${BASE}${PREFIX}/api/tools`).then((r) => r.status)
  check('未配置令牌：工具通道拒绝（401）', anonTools === 401, `status=${anonTools}`)
  const anonMonitor = await fetch(`${BASE}${PREFIX}/api/monitor/overview`).then((r) => r.status)
  check('未配置令牌：监控接口拒绝（401）', anonMonitor === 401, `status=${anonMonitor}`)
  const noTok = await tool(BASE, '', 'workbuddy_monitor_read', { action: 'overview' })
  check('未配置令牌：带空 Bearer 调工具被拒（401）', noTok.status === 401, `status=${noTok.status}`)

  // ---------- 2. --token 种子实例 B ----------
  const badTok = await tool(BASE2, 'wrong-token', 'workbuddy_monitor_read', { action: 'overview' })
  check('错误令牌被拒（401）', badTok.status === 401, `status=${badTok.status}`)
  const okTok = await tool(BASE2, 'seed-token-123', 'workbuddy_monitor_read', { action: 'overview' })
  check('种子令牌放行 monitor_read', okTok.status === 200 && okTok.json?.ok === true && okTok.json?.result?.kpi, `status=${okTok.status}`)
  const toolsList = await fetch(`${BASE2}${PREFIX}/api/tools`, { headers: { Authorization: 'Bearer seed-token-123' } }).then((r) => r.json())
  const toolNames = (toolsList.tools || []).map((t) => t.name)
  check('工具清单 12 个（含 project_manage）', toolNames.length === 12 && toolNames.includes('workbuddy_project_manage'), toolNames.join(','))
  check('新工具齐全', ['workbuddy_monitor_read', 'workbuddy_schedule_manage', 'workbuddy_planner_manage', 'workbuddy_file_manage'].every((n) => toolNames.includes(n)))
  // project_manage 全链路：upsert → list → create 带projectId → delete
  const projUpsert = await tool(BASE2, 'seed-token-123', 'workbuddy_project_manage', { action: 'upsert', project: { name: '冒烟测试项目', dshRef: { kind: 'mapping', mappingId: 'mock-dsh-live' } } })
  const projId = projUpsert.json?.result?.project?.id
  check('project upsert 创建成功', projUpsert.json?.ok === true && Boolean(projId), JSON.stringify(projUpsert.json).slice(0, 120))
  const projList = await tool(BASE2, 'seed-token-123', 'workbuddy_project_manage', { action: 'list' })
  check('project list 含新项目', projList.json?.result?.projects?.some((p) => p.id === projId), '')
  const projTask = await tool(BASE2, 'seed-token-123', 'workbuddy_task_manage', { action: 'create', projectId: projId, title: '项目任务冒烟', message: '冒烟：项目任务创建（不 @ 任何人）' })
  check('task create 带 projectId 受理', projTask.json?.result?.accepted === true && projTask.json?.result?.taskId, JSON.stringify(projTask.json).slice(0, 140))
  const projDel = await tool(BASE2, 'seed-token-123', 'workbuddy_project_manage', { action: 'delete', projectId: projId })
  check('project delete 清理成功', projDel.json?.result?.ok === true, '')
  const settingsViaToken = await fetch(`${BASE2}${PREFIX}/api/settings`, { headers: { Authorization: 'Bearer seed-token-123' } }).then((r) => r.status)
  check('令牌面之外（/api/settings）拒绝（403）', settingsViaToken === 403, `status=${settingsViaToken}`)

  // ---------- 3. 设置页 APIKEY ----------
  // 登录实例 B 管理员
  const loginRes = await fetch(`${BASE2}${PREFIX}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'workbuddy', password: 'ThunderSoft@88' }),
  })
  const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0]
  const settings = await fetch(`${BASE2}${PREFIX}/api/settings`, { headers: { Cookie: cookie } }).then((r) => r.json())
  check('settings 返回 aiToken（种子值）', settings?.data?.aiToken === 'seed-token-123', settings?.data?.aiToken)
  const reset = await fetch(`${BASE2}${PREFIX}/api/settings/ai-token/reset`, { method: 'POST', headers: { Cookie: cookie } }).then((r) => r.json())
  const newToken = reset?.data?.token
  check('重置生成 wbk- 前缀新令牌', typeof newToken === 'string' && newToken.startsWith('wbk-'), newToken)
  const oldTok = await tool(BASE2, 'seed-token-123', 'workbuddy_monitor_read', {})
  check('旧令牌立即失效（401）', oldTok.status === 401, `status=${oldTok.status}`)
  const newTok = await tool(BASE2, newToken, 'workbuddy_monitor_read', {})
  check('新令牌立即生效（无需重启）', newTok.status === 200, `status=${newTok.status}`)

  // ---------- 4. 新工具功能 ----------
  const T = (name, args) => tool(BASE2, newToken, name, args)
  await T('workbuddy_agent_manage', { action: 'upsert', agent: { name: '技能执行者', dshRef: { kind: 'mapping', mappingId: 'map-dsh-live' } } })
  const agentsR = await T('workbuddy_agent_manage', { action: 'list' })
  const agentId = agentsR.json?.result?.agents?.[0]?.id
  check('agent list（密钥脱敏）', Boolean(agentId) && agentsR.json?.result?.agents?.[0]?.apiKey === undefined, agentId)
  const enableR = await T('workbuddy_agent_manage', { action: 'disable', agentId })
  check('agent disable/enable', enableR.json?.ok === true && enableR.json?.result?.enabled === false
    && (await T('workbuddy_agent_manage', { action: 'enable', agentId })).json?.result?.enabled === true)

  const schedUpsert = await T('workbuddy_schedule_manage', { action: 'upsert', schedule: { name: 'AI冒烟定时', agentIds: [agentId], message: '执行巡检', rule: { kind: 'interval', minutes: 30 } } })
  const schedId = schedUpsert.json?.result?.schedule?.id
  check('schedule upsert（含 nextRunAt）', Boolean(schedId) && Boolean(schedUpsert.json?.result?.schedule?.nextRunAt), schedId)
  const schedRun = await T('workbuddy_schedule_manage', { action: 'run', scheduleId: schedId })
  check('schedule run 手动触发', schedRun.json?.ok === true, JSON.stringify(schedRun.json?.result?.run?.items || []).slice(0, 80))
  const schedList = await T('workbuddy_schedule_manage', { action: 'list' })
  check('schedule list', schedList.json?.result?.schedules?.some((s) => s.id === schedId))
  check('schedule delete', (await T('workbuddy_schedule_manage', { action: 'delete', scheduleId: schedId })).json?.result?.deleted === true)

  const plannerGet = await T('workbuddy_planner_manage', { action: 'get' })
  check('planner get', plannerGet.json?.ok === true && 'planner' in plannerGet.json?.result)
  const plannerSet = await T('workbuddy_planner_manage', { action: 'set', agentId, model: 'deepseek/deepseek-v3' })
  check('planner set', plannerSet.json?.ok === true && plannerSet.json?.result?.planner?.agentId === agentId && plannerSet.json?.result?.planner?.model === 'deepseek/deepseek-v3')
  const plannerOpts = await T('workbuddy_planner_manage', { action: 'options' })
  check('planner options（候选+当前）', plannerOpts.json?.ok === true && Array.isArray(plannerOpts.json?.result?.agents) && plannerOpts.json?.result?.current)

  // task wait：draft 任务不会运行 → 应立即返回 timedOut=false、status=draft
  const taskCreate = await T('workbuddy_task_manage', { action: 'create', title: 'AI冒烟任务', memberAgentIds: [agentId] })
  const taskId = taskCreate.json?.result?.taskId
  check('task create', Boolean(taskId), taskId)
  const waitR = await T('workbuddy_task_manage', { action: 'wait', taskId, timeoutMs: 6000 })
  check('task wait（非运行任务立即返回）', waitR.json?.ok === true && waitR.json?.result?.timedOut === false && waitR.json?.result?.status === 'draft', `status=${waitR.json?.result?.status}`)
  const monitorTask = await T('workbuddy_monitor_read', { action: 'task', taskId })
  check('monitor task（视图+活动）', monitorTask.json?.ok === true && monitorTask.json?.result?.view?.type === 'chat')
  const eventsR = await T('workbuddy_monitor_read', { action: 'events', limit: 10 })
  check('monitor events', eventsR.json?.ok === true && Array.isArray(eventsR.json?.result?.events))
  const historyR = await T('workbuddy_monitor_read', { action: 'history', days: 3 })
  check('monitor history', historyR.json?.ok === true && historyR.json?.result?.days?.length === 3)

  // ---------- 5. 文件工具参数校验（无远端 DSH 时 upload 应明确报错而不是 500） ----------
  const fileNoSrc = await T('workbuddy_file_manage', { action: 'upload', agent: agentId, name: 'x.txt' })
  check('file upload 缺内容来源 → 明确报错', fileNoSrc.json?.result?.ok === false && /contentBase64|url/.test(fileNoSrc.json?.result?.error || ''), fileNoSrc.json?.result?.error)
  const fileBadAgent = await T('workbuddy_file_manage', { action: 'list', agent: 'no-such' })
  check('file 工具未知智能体 → 明确报错', fileBadAgent.json?.result?.ok === false)

  // ---------- 6. 安装资源端点 ----------
  const sh = await fetch(`${BASE2}${PREFIX}/install-skill.sh`).then((r) => r.text())
  check('install-skill.sh 可下载', sh.includes('install-skill.sh') || sh.includes('WorkBuddy'), `len=${sh.length}`)
  check('install-skill.sh 含用法与卸载', sh.includes('--base-url') && sh.includes('--uninstall'))
  const skillMd = await fetch(`${BASE2}${PREFIX}/install/SKILL.md`).then((r) => r.text())
  check('install/SKILL.md 可下载（v2 含新工具）', skillMd.includes('workbuddy_monitor_read') && skillMd.includes('workbuddy_planner_manage'))
  const wbMjs = await fetch(`${BASE2}${PREFIX}/install/wb.mjs`).then((r) => r.text())
  check('install/wb.mjs 可下载', wbMjs.includes('WORKBUDDY_BASE_URL') && wbMjs.includes('workbuddy_file_manage'))

  // ---------- 7. wb.mjs 实跑（对实例 B） ----------
  const env = { WORKBUDDY_BASE_URL: `${BASE2}${PREFIX}`, WORKBUDDY_TOKEN: newToken }
  const wb = join(ROOT, 'skills', 'onenat-workbuddy', 'scripts', 'wb.mjs')
  const wbTools = await runNode([wb, 'tools'], env)
  check('wb.mjs tools 连通自检', wbTools.code === 0 && wbTools.out.includes('workbuddy_monitor_read'), wbTools.out.split('\n')[0])
  const wbMon = await runNode([wb, 'monitor', 'overview'], env)
  check('wb.mjs monitor overview', wbMon.code === 0 && wbMon.out.includes('"kpi"'))
  const wbBad = await runNode([wb, 'monitor', 'overview'], { WORKBUDDY_BASE_URL: `${BASE2}${PREFIX}`, WORKBUDDY_TOKEN: 'wrong' })
  check('wb.mjs 错误令牌友好报错', wbBad.code !== 0 && wbBad.err.includes('鉴权失败'))
  const wbHelp = await runNode([wb, 'help'], {})
  check('wb.mjs help（未配置也可见）', wbHelp.code === 0 && wbHelp.out.includes('monitor'))

  console.log('\n' + results.join('\n'))
  console.log(`\n${failures === 0 ? '✅ 全部通过' : '❌ 存在失败'}（共 ${results.length} 项）\n`)
  cleanup()
  for (const d of [dataDirA, dataDirB]) {
    try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('冒烟中断:', err?.stack || err)
  cleanup()
  process.exit(1)
})
