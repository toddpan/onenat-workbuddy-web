#!/usr/bin/env node
/**
 * OneNat WorkBuddy — 监控大屏功能冒烟测试（独立部署模式，不依赖真实 LLM）
 *
 *   node scripts/smoke-monitor.mjs
 *
 * 覆盖：
 *   1. 访问控制：未登录 API 401 / 未登录投屏页回登录页
 *   2. /api/monitor/overview 聚合形状：kpi / agents / tasks / schedules / events / alerts
 *   3. 任务类型识别：draft 任务 → 💬 直通对话 + 「等待发送」
 *   4. 定时任务：创建后出现在 overview.schedules（启用 + 下次触发），手动触发 → schedule_fired 事件
 *   5. 条件断言：若本机 3080 有真实 DSH（map-dsh-live），派生任务在 overview 中标记 ⏰ 定时任务
 *   6. /api/monitor/history 结构（7 天窗口）
 *   7. 投屏页 /monitor 与控制台「监控大屏」入口渲染
 *   8. 事件落盘目录 <data>/monitor/ 创建
 *
 * 退出码非 0 即失败。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.SMOKE_PORT || 18095)
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT || 18084)
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

async function req(method, path, body, raw = false) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(COOKIE ? { Cookie: COOKIE } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (raw) return { status: res.status, text: await res.text(), res }
  let json
  try {
    json = await res.json()
  } catch {
    json = undefined
  }
  return { status: res.status, json }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** overview 有 3s 聚合缓存：变更后轮询等待期望状态出现（最长 8s） */
async function waitOverview(pred, label) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < 8000) {
    last = (await req('GET', `${PREFIX}/api/monitor/overview`)).json?.data
    try {
      if (last && pred(last)) return last
    } catch { /* retry */ }
    await sleep(500)
  }
  return last
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

async function main() {
  if (!existsSync(join(ROOT, 'dist', 'server.js'))) {
    console.error('缺少 dist/server.js —— 先执行: bash scripts/build-standalone.sh')
    process.exit(1)
  }

  console.log(`\n== OneNat WorkBuddy 监控大屏冒烟 ==\n   服务 ${BASE}${PREFIX}\n`)

  const dataDir = mkdtempSync(join(tmpdir(), 'workbuddy-mon-smoke-'))
  console.log(`   数据目录 ${dataDir}\n`)
  spawnJob('mock-onenat', process.execPath, [join(ROOT, 'scripts', 'mock-onenat.cjs')], { MOCK_ONENAT_PORT: String(MOCK_PORT) })
  spawnJob('server', process.execPath, [
    join(ROOT, 'dist', 'server.js'),
    '--port', String(PORT),
    '--data', dataDir,
    '--onenat-base-url', `http://127.0.0.1:${MOCK_PORT}`,
    '--onenat-api-key', 'onk-mock-key-000',
    '--quiet',
  ])
  const t0 = Date.now()
  while (Date.now() - t0 < 30000) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break
    } catch { /* retry */ }
    await sleep(400)
  }

  // ---------- 1. 访问控制 ----------
  const anonApi = await req('GET', `${PREFIX}/api/monitor/overview`)
  check('未登录访问监控 API → 401', anonApi.status === 401, `status=${anonApi.status}`)
  const anonPage = await req('GET', `${PREFIX}/monitor`, undefined, true)
  check('未登录访问投屏页 → 登录页', anonPage.status === 200 && anonPage.text.includes('登录'), `status=${anonPage.status}`)
  check('登录成功', await login('workbuddy', 'ThunderSoft@88'))

  // ---------- 2. overview 形状 ----------
  const ov = await req('GET', `${PREFIX}/api/monitor/overview`)
  const data = ov.json?.data
  check('overview 返回 ok', ov.json?.ok === true && Boolean(data), `status=${ov.status}`)
  check('kpi 字段齐全', Boolean(
    data?.kpi && ['agentsTotal', 'agentsOnline', 'agentsBusy', 'tasksRunning', 'tasksCompletedToday', 'tasksFailedToday',
      'tokensInputToday', 'tokensOutputToday', 'cacheReadToday', 'toolCallsToday', 'schedulesTotal', 'schedulesEnabled']
      .every((k) => typeof data.kpi[k] === 'number'),
  ))
  check('agents/tasks/schedules/events/alerts 数组齐全', Boolean(
    Array.isArray(data?.agents) && Array.isArray(data?.tasks) && Array.isArray(data?.schedules)
    && Array.isArray(data?.events) && Array.isArray(data?.alerts) && Array.isArray(data?.sshPool),
  ))

  // ---------- 3. 子智能体出现在监控里 ----------
  const a1 = await req('POST', `${PREFIX}/api/agents`, { name: '监控执行者甲', dshRef: { kind: 'mapping', mappingId: 'map-dsh-live' } })
  const a2 = await req('POST', `${PREFIX}/api/agents`, { name: '监控执行者乙', dshRef: { kind: 'mapping', mappingId: 'map-dsh-01' }, resources: [{ ref: { kind: 'mapping', mappingId: 'map-ssh-01' }, credentialMode: 'self-fetch', skillMode: 'none' }] })
  const id1 = a1.json?.data?.id
  const id2 = a2.json?.data?.id
  check('准备 2 个子智能体', Boolean(id1) && Boolean(id2), `${id1} / ${id2}`)
  const ov2 = await waitOverview((d) => (d?.agents || []).length === 2, 'agents 出现')
  const mAgents = ov2?.agents || []
  check('overview.agents 含 2 个智能体', mAgents.length === 2, `len=${mAgents.length}`)
  const agentB = mAgents.find((x) => x.id === id2)
  check('智能体携带绑定资源视图（在线状态 + 入口）', Boolean(agentB?.resources?.length >= 1 && typeof agentB.resources[0].online === 'boolean' && 'endpoint' in agentB.resources[0]), JSON.stringify(agentB?.resources?.[0]?.name || ''))
  check('智能体健康字段（online/enabled/busy）', mAgents.every((x) => typeof x.online === 'boolean' && typeof x.enabled === 'boolean' && typeof x.busy === 'boolean'))

  // ---------- 4. draft 任务 → 💬 直通对话 ----------
  const t1 = await req('POST', `${PREFIX}/api/tasks`, { title: '监控冒烟任务', memberAgentIds: [id1] })
  const taskId = t1.json?.data?.id
  check('创建 draft 任务', Boolean(taskId), `id=${taskId}`)
  const ov3 = await waitOverview((d) => (d?.tasks || []).some((x) => x.id === taskId), 'draft 任务出现')
  const mTask = (ov3?.tasks || []).find((x) => x.id === taskId)
  check('任务出现在监控列表', Boolean(mTask))
  check('draft 任务类型 = 💬 直通对话', mTask?.type === 'chat' && mTask?.typeIcon === '💬' && mTask?.typeLabel === '直通对话', JSON.stringify({ type: mTask?.type, icon: mTask?.typeIcon }))
  check('draft 任务 headline = 等待发送', mTask?.headline === '等待发送', mTask?.headline)
  check('任务活动结构（phase/turnCount）', typeof mTask?.activity?.phase === 'string' && typeof mTask?.activity?.turnCount === 'number')

  // ---------- 5. 定时任务视图 + 手动触发事件 ----------
  const sch = await req('POST', `${PREFIX}/api/schedules`, {
    name: '监控冒烟定时',
    agentIds: [id1],
    message: '汇报当前状态',
    rule: { kind: 'daily', times: ['23:59'] },
  })
  const schedId = sch.json?.data?.id
  check('创建定时任务', Boolean(schedId))
  const ov4 = await waitOverview((d) => (d?.schedules || []).some((x) => x.id === schedId), '定时任务出现')
  const mSched = (ov4?.schedules || []).find((x) => x.id === schedId)
  check('定时任务出现在监控（启用 + 下次触发 + 规则文案）', Boolean(mSched?.enabled && mSched?.nextRunAt && mSched?.ruleText), JSON.stringify({ rule: mSched?.ruleText, next: mSched?.nextRunAt }))
  check('kpi.schedulesEnabled = 1 且 nextScheduleName 正确', ov4?.kpi?.schedulesEnabled === 1 && ov4?.kpi?.nextScheduleName === '监控冒烟定时', `next=${ov4?.kpi?.nextScheduleName}`)
  const fire = await req('POST', `${PREFIX}/api/schedules/${schedId}/run`)
  check('手动触发定时任务', fire.json?.ok === true, `status=${fire.status}`)
  await sleep(800)
  const ev = (await req('GET', `${PREFIX}/api/monitor/events?limit=50`)).json?.data
  const fired = (ev || []).find((x) => x.kind === 'schedule_fired')
  check('事件流出现 schedule_fired（含人类可读 msg）', Boolean(fired && /监控冒烟定时/.test(fired.msg)), fired?.msg || '(无)')
  const ov5 = await waitOverview((d) => (d?.tasks || []).some((x) => x.title.includes('监控冒烟定时')), '派生任务出现')
  const firedTask = (ov5?.tasks || []).find((x) => x.title.includes('监控冒烟定时'))
  if (firedTask?.scheduleId === schedId) {
    check('派生任务标记为 ⏰ 定时任务（scheduleId 关联）', firedTask.type === 'schedule' && firedTask.typeIcon === '⏰' && firedTask.scheduleName === '监控冒烟定时', `type=${firedTask.type}`)
  } else {
    console.log('  ⏭️  跳过「派生任务 ⏰ 标记」断言（本机无在线 DSH，派发未产生任务会话）')
  }

  // ---------- 5b. 定时关联持久化 + 标题前缀兜底（回归：调度删除/滚窗后类型丢失） ----------
  await req('DELETE', `${PREFIX}/api/schedules/${schedId}`)
  const ovDel = await waitOverview((d) => !(d?.schedules || []).some((x) => x.id === schedId), '调度删除生效')
  if (firedTask?.id) {
    const persisted = await waitOverview((d) => {
      const x = (d?.tasks || []).find((y) => y.id === firedTask.id)
      return x && x.type === 'schedule'
    }, '持久化 ⏰ 标识')
    const pTask = (persisted?.tasks || []).find((x) => x.id === firedTask.id)
    check('调度删除后派生任务仍为 ⏰ 定时任务（scheduleId 持久化）', pTask?.type === 'schedule' && pTask?.typeIcon === '⏰', `type=${pTask?.type}`)
  }
  await req('PATCH', `${PREFIX}/api/tasks/${taskId}`, { title: '⏰ 历史定时任务' })
  const ovPre = await waitOverview((d) => (d?.tasks || []).some((x) => x.id === taskId && x.type === 'schedule'), '标题前缀兜底')
  const pre = (ovPre?.tasks || []).find((x) => x.id === taskId)
  check('标题 ⏰ 前缀兜底识别（无任何关联信息的历史任务）', pre?.type === 'schedule' && pre?.scheduleName === '历史定时任务', `type=${pre?.type} name=${pre?.scheduleName}`)
  await req('PATCH', `${PREFIX}/api/tasks/${taskId}`, { title: '监控冒烟任务' })
  await waitOverview((d) => (d?.tasks || []).some((x) => x.id === taskId && x.type === 'chat'), '恢复 chat 类型')

  // ---------- 6. 历史快照结构 ----------
  const hist = (await req('GET', `${PREFIX}/api/monitor/history?days=7`)).json?.data
  check('history 返回 7 天窗口', Array.isArray(hist?.days) && hist.days.length === 7, `len=${hist?.days?.length}`)
  check('history 每天含 date + snapshots 数组', (hist?.days || []).every((d) => typeof d.date === 'string' && Array.isArray(d.snapshots)))

  // ---------- 7. 页面渲染 ----------
  const proj = await req('GET', `${PREFIX}/monitor`, undefined, true)
  check('投屏页渲染（暗色监控大屏）', proj.status === 200 && proj.text.includes('WorkBuddy 智能体监控大屏') && proj.text.includes('monitor/overview'))
  const consolePage = await req('GET', `${PREFIX}/`, undefined, true)
  check('控制台含「监控大屏」页签', consolePage.status === 200 && consolePage.text.includes('data-v="monitor"') && consolePage.text.includes('view-monitor'))

  // ---------- 8. 落盘目录 ----------
  check('事件落盘目录 <data>/monitor 已创建', existsSync(join(dataDir, 'monitor')))

  // ---------- 9. 删除任务后从监控消失 ----------
  await req('DELETE', `${PREFIX}/api/tasks/${taskId}`)
  const ov6 = await waitOverview((d) => !(d?.tasks || []).some((x) => x.id === taskId), '任务消失')
  check('删除任务后监控列表不再包含', !(ov6?.tasks || []).some((x) => x.id === taskId))

  console.log('\n' + results.join('\n'))
  console.log(`\n${failures === 0 ? '✅ 全部通过' : '❌ 存在失败'}（共 ${results.length} 项）\n`)
  cleanup()
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch { /* ignore */ }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('冒烟中断:', err?.stack || err)
  cleanup()
  process.exit(1)
})
