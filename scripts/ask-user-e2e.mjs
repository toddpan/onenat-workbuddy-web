#!/usr/bin/env node
/**
 * ask_user_question 挂起治理端到端验证：
 *   npm run build && WB 目标 node scripts/ask-user-e2e.mjs
 * 场景：
 *   1-4（stub-ask1，有答复桥）：挂起 → 秒级终结等待答复 → 自由文本答复桥解锁 → 续跑全文回填
 *      → 二次挂起再次等待 → 停止自动解挂批次
 *   5（stub-ask2，无答复桥：/questions 404）：悬停不可桥接 → 监视窗结束即表面化问题内容 +
 *      中止远端悬停回合（cancelSession）→ 会话回 idle，用户下一条消息作新指令执行
 * 复现线上两种真实卡死形态（brain 批次挂 67 分钟 / 公司笔记本批次不可见悬停）。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.ASK_E2E_PORT || 18096)
const STUB_PORT = Number(process.env.ASK_E2E_STUB_PORT || 18099)
const PREFIX = '/onenat-workbuddy'
const BASE = `http://127.0.0.1:${PORT}`

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  if (!ok) failures++
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond, label, timeoutMs = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try { if (await cond()) return } catch { /* retry */ }
    await sleep(300)
  }
  throw new Error(`等待超时: ${label}`)
}

// ---------------- stub DSH 节点（多会话 · ask 挂起状态机） ----------------
// stub-ask1: 有答复桥（/questions + /answers）；stub-ask2: 旧节点（/questions 404，不可桥接）
const Q1 = [
  { id: 'weekly_source', question: '周报在哪里获取？', header: '周报来源', options: [{ label: '发我文件', description: '最直接' }], multiSelect: false },
  { id: 'diagram_format', question: '架构图用什么格式？', header: '架构图格式', options: [{ label: 'Mermaid', description: '可维护' }], multiSelect: false },
]
const Q2 = [{ id: 'confirm_step', question: '确认继续执行第二步？', header: '确认', options: [{ label: '继续', description: '继续' }], multiSelect: false }]
const Q3 = [{ id: 'implement', question: '按哪个方案实现？', header: '实现方案', options: [{ label: '方案A', description: '可选参数' }], multiSelect: false }]
const RESUME_TEXT = '收到答复：周报先跳过，以下是其余内容的完整总结……（stub 续跑产出）'

let sessionCounter = 0
const sessions = new Map()
function sessionState(id) {
  if (!sessions.has(id)) sessions.set(id, { parked: false, batches: [], history: [], cancelHit: false })
  return sessions.get(id)
}

const stub = createServer((req, res) => {
  const url = req.url || ''
  const sid = (url.match(/\/api\/v1\/sessions\/([^/?]+)/) || [])[1]
  const st = sid ? sessionState(sid) : undefined
  const unbridged = sid === 'stub-ask2'
  let chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = (() => { try { return JSON.parse(Buffer.concat(chunks).toString() || '{}') } catch { return {} } })()
    if (req.method === 'POST' && url === '/api/v1/sessions') {
      sessionCounter++
      const id = `stub-ask${sessionCounter}`
      sessionState(id)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, data: { sessionId: id } }))
      return
    }
    if (!sid) { res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'Endpoint not found' })); return }
    if (req.method === 'GET' && url === `/api/v1/sessions/${sid}`) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, data: { sessionId: sid, status: st.parked ? 'running' : 'idle', cwd: '/tmp/ask-ws' } }))
      return
    }
    if (req.method === 'GET' && url === `/api/v1/sessions/${sid}/questions`) {
      // stub-ask2 = 旧节点形态：无 /questions 路由
      if (unbridged) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Endpoint not found' })); return }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, data: { sessionId: sid, bridge: 'stub', count: st.batches.length, batches: st.batches } }))
      return
    }
    if (req.method === 'POST' && url === `/api/v1/sessions/${sid}/answers`) {
      const answers = Array.isArray(body?.answers) ? body.answers : []
      st.answeredLog = (st.answeredLog || []).concat([answers])
      st.batches = []
      st.parked = false
      st.history.push({ role: 'user', content: answers[0]?.custom || '' })
      st.history.push({ role: 'assistant', content: RESUME_TEXT })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, data: { sessionId: sid, answered: answers.length } }))
      return
    }
    if (req.method === 'POST' && url === `/api/v1/sessions/${sid}/cancel`) {
      st.cancelHit = true
      st.parked = false
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, data: { cancelled: true } }))
      return
    }
    if (req.method === 'GET' && url.startsWith(`/api/v1/sessions/${sid}/history`)) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, data: { messages: st.history } }))
      return
    }
    if (req.method === 'POST' && url === `/api/v1/sessions/${sid}/prompt-stream`) {
      const promptN = (st.promptCount = (st.promptCount || 0) + 1)
      st.history.push({ role: 'user', content: body?.prompt || '' })
      const questions = sid === 'stub-ask1' ? (promptN === 1 ? Q1 : Q2) : Q3
      if (!unbridged) st.batches = [{ batchId: `batch-${sid}-${promptN}`, at: Date.now(), questions }]
      st.parked = true
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`event: tool_call\ndata: ${JSON.stringify({ id: `tool-${promptN}`, name: 'ask_user_question', arguments: JSON.stringify({ questions }) })}\n\n`)
      // 挂起：不再发任何帧（真实远端此刻悬停在工具内部，状态恒 running）
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'Endpoint not found' }))
  })
})

const procs = []
function cleanup() { try { stub.close() } catch {} for (const p of procs) { try { p.kill('SIGKILL') } catch {} } }
process.on('exit', cleanup)

let COOKIE = ''
async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(COOKIE ? { Cookie: COOKIE } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json; try { json = JSON.parse(text) } catch { json = undefined }
  return { status: res.status, json }
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'workbuddy-ask-e2e-'))
  console.log(`\n== ask_user_question 挂起治理 E2E ==\n`)
  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r))
  const server = spawn(process.execPath, [join(ROOT, 'dist', 'server.js'), '--port', String(PORT), '--data', dataDir, '--quiet'],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, WB_ASK_WATCH_WINDOW_MS: '4000' } })
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))
  procs.push(server)
  await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok, 'server 就绪')

  const loginRes = await fetch(`${BASE}${PREFIX}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'workbuddy', password: 'ThunderSoft@88' }),
  })
  COOKIE = (loginRes.headers.get('set-cookie') || '').split(';')[0]
  check('登录成功', loginRes.ok)

  const taskRes = await req('POST', `${PREFIX}/api/tasks`, {
    title: 'ask e2e', mode: 'chat',
    nodeRef: { kind: 'direct', apiBaseUrl: `http://127.0.0.1:${STUB_PORT}/api/v1` },
  })
  const taskId = taskRes.json?.data?.id
  check('创建节点直发任务', Boolean(taskId), `err=${taskRes.json?.error || ''}`)

  // ---- 场景 1：远端 ask 挂起（桥可见）→ 回合快速终结等待答复 ----
  const t0 = Date.now()
  await req('POST', `${PREFIX}/api/tasks/${taskId}/messages`, { message: '请整理项目情况，周报位置请确认' })
  await waitFor(async () => {
    const d = await req('GET', `${PREFIX}/api/tasks/${taskId}`)
    const turn = (d.json?.data?.turns || []).find((x) => x.role === 'agent')
    return turn && turn.streaming === false
  }, '挂起回合终结', 25000)
  const dt = Date.now() - t0
  check(`挂起回合快速终结（${(dt / 1000).toFixed(1)}s < 25s，修复前为 10min+30min）`, dt < 25000)
  let d1 = (await req('GET', `${PREFIX}/api/tasks/${taskId}`)).json.data
  const agentTurn1 = (d1.turns || []).find((x) => x.role === 'agent')
  const askTool = (agentTurn1?.tools || []).find((x) => x.name === 'ask_user_question')
  check('ask 工具保持 running（答复卡/桥可用）', askTool?.status === 'running', `status=${askTool?.status}`)
  check('ask 工具带等待提示', String(askTool?.result || '').includes('等待用户答复'))
  check('task.pendingAsk 已记录（含 2 题）', d1.pendingAsk?.questions?.length === 2, JSON.stringify(d1.pendingAsk || {}).slice(0, 120))
  check('系统提示告知可直接回复作答', (d1.turns || []).some((x) => x.role === 'system' && String(x.text).includes('直接在下方输入回复')))
  check('任务状态落 completed（非 running 假死）', d1.status === 'completed', `status=${d1.status}`)

  // ---- 场景 2：自由文本答复 → 自动走 /answers 桥 + 续跑全文回填 ----
  await req('POST', `${PREFIX}/api/tasks/${taskId}/messages`, { message: '周报先不用管了，直接总结其余内容' })
  await waitFor(async () => {
    const d = await req('GET', `${PREFIX}/api/tasks/${taskId}`)
    const turns = d.json?.data?.turns || []
    const lastAgent = [...turns].reverse().find((x) => x.role === 'agent')
    return lastAgent && lastAgent.streaming === false && String(lastAgent.text || '').length > 0
  }, '续跑回合出全文', 40000)
  const d2 = (await req('GET', `${PREFIX}/api/tasks/${taskId}`)).json.data
  const lastAgent2 = [...d2.turns].reverse().find((x) => x.role === 'agent')
  check('续跑产出回填到回合', String(lastAgent2.text || '').includes('stub 续跑产出'), String(lastAgent2.text || '').slice(0, 60))
  check('答复经 /answers 桥且 custom=用户消息', (sessionState('stub-ask1').answeredLog || []).at(-1)?.some((a) => a.id === 'weekly_source' && String(a.custom || '').includes('周报先不用管了')),
    JSON.stringify((sessionState('stub-ask1').answeredLog || []).at(-1) || []).slice(0, 120))
  check('旧挂起 ask 工具落 done', askToolOf(d2, 1)?.status === 'done', `status=${askToolOf(d2, 1)?.status} result=${String(askToolOf(d2, 1)?.result || '').slice(0, 40)}`)
  check('task.pendingAsk 已清除', !d2.pendingAsk)
  check('系统提示「答复已提交」', d2.turns.some((x) => x.role === 'system' && String(x.text).includes('答复提交给挂起的提问')))
  check('未向挂起会话发新 prompt（promptCount 仍为 1）', sessionState('stub-ask1').promptCount === 1, `promptCount=${sessionState('stub-ask1').promptCount}`)

  // ---- 场景 3：再次挂起可再次等待（连环提问） ----
  await req('POST', `${PREFIX}/api/tasks/${taskId}/messages`, { message: '继续第二步' })
  await waitFor(async () => {
    const d = await req('GET', `${PREFIX}/api/tasks/${taskId}`)
    return Boolean(d.json?.data?.pendingAsk)
  }, '二次挂起记录', 25000)
  const d3 = (await req('GET', `${PREFIX}/api/tasks/${taskId}`)).json.data
  check('二次挂起 pendingAsk=confirm_step', d3.pendingAsk?.questions?.[0]?.id === 'confirm_step', JSON.stringify(d3.pendingAsk || {}).slice(0, 100))

  // ---- 场景 4：停止自动解挂挂起批次 ----
  await req('POST', `${PREFIX}/api/tasks/${taskId}/cancel`, {})
  await sleep(2500)
  check('停止后挂起批次已解挂', sessionState('stub-ask1').batches.length === 0, `count=${sessionState('stub-ask1').batches.length}`)
  check('解挂答复为中止文案', (sessionState('stub-ask1').answeredLog || []).at(-1)?.some((a) => String(a.custom || '').includes('用户已中止')), JSON.stringify((sessionState('stub-ask1').answeredLog || []).at(-1) || []).slice(0, 100))

  // ---- 场景 5：不可桥接悬停（无 /questions 的旧节点形态）→ 监视窗结束表面化 + 中止远端回合 ----
  const t5 = Date.now()
  const task2Res = await req('POST', `${PREFIX}/api/tasks`, {
    title: 'ask e2e unbridged', mode: 'chat',
    nodeRef: { kind: 'direct', apiBaseUrl: `http://127.0.0.1:${STUB_PORT}/api/v1` },
  })
  const taskId2 = task2Res.json?.data?.id
  check('创建第二个任务（将命中 stub-ask2 旧节点形态）', Boolean(taskId2))
  await req('POST', `${PREFIX}/api/tasks/${taskId2}/messages`, { message: '按哪个方案实现？请确认' })
  await waitFor(async () => {
    const d = await req('GET', `${PREFIX}/api/tasks/${taskId2}`)
    const turn = (d.json?.data?.turns || []).find((x) => x.role === 'agent')
    return turn && turn.streaming === false
  }, '不可桥接悬停回合终结', 30000)
  const dt5 = Date.now() - t5
  check(`不可桥接悬停快速终结（${(dt5 / 1000).toFixed(1)}s < 30s，窗口 4s + 中止）`, dt5 < 30000)
  const d5 = (await req('GET', `${PREFIX}/api/tasks/${taskId2}`)).json.data
  const turn5 = (d5.turns || []).find((x) => x.role === 'agent')
  const ask5 = (turn5?.tools || []).find((x) => x.name === 'ask_user_question')
  check('ask 工具落 error（桥不可达，不再转圈）', ask5?.status === 'error', `status=${ask5?.status} result=${String(ask5?.result || '').slice(0, 50)}`)
  check('系统提示含问题内容与回复指引', (d5.turns || []).some((x) => x.role === 'system' && String(x.text).includes('未接入答复桥') && String(x.text).includes('按哪个方案实现')))
  check('远端悬停回合已被中止（cancelSession）', sessionState('stub-ask2').cancelHit === true)
  check('会话回 idle（下一条消息可作新指令直接执行）', sessionState('stub-ask2').parked === false)
  check('未记录 pendingAsk（答复桥触达不了，回复走新指令语义）', !d5.pendingAsk)
  check('任务状态 completed（非 running 假死）', d5.status === 'completed', `status=${d5.status}`)

  console.log(failures === 0 ? '\n全部通过 ✅\n' : `\n${failures} 项失败 ❌\n`)
  try { rmSync(dataDir, { recursive: true, force: true }) } catch {}
  cleanup()
  process.exit(failures === 0 ? 0 : 1)
}

/** 第 n 个 agent 回合里的 ask 工具（1=首轮挂起回合） */
function askToolOf(detail, nth) {
  const agentTurns = (detail.turns || []).filter((x) => x.role === 'agent')
  const t = agentTurns[nth - 1]
  return (t?.tools || []).find((x) => x.name === 'ask_user_question')
}

main().catch((e) => { console.error(e); cleanup(); process.exit(1) })
