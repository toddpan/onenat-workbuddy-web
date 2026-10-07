#!/usr/bin/env node
/**
 * @ 项目提及端到端验证（任务聊天输入框 @项目 = 对项目发起任务）：
 *   npm run build && node scripts/project-mention-e2e.mjs
 * 场景：
 *   1. /api/mentions/candidates 含项目候选（type=project）
 *   2.（UI 流程）新建空任务 → 首条消息 @项目 → 任务自动绑定 projectId + 系统轮提示，
 *      主会话在项目节点直发（lastRoute source=node）· 远端会话 cwd=项目工作区 · 提示词含项目指令
 *   3.（工具通道）POST /api/tasks 直接带 @项目 message → 创建即绑定
 *   4.（冲突治理）已绑定项目的任务再 @ 另一项目 → 提示忽略，projectId 不变
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PM_E2E_PORT || 18094)
const STUB_PORT = Number(process.env.PM_E2E_STUB_PORT || 18095)
const PREFIX = '/onenat-workbuddy'
const BASE = `http://127.0.0.1:${PORT}`
const STUB_BASE = `http://127.0.0.1:${STUB_PORT}/api/v1`

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

// ---------------- stub DSH 节点（direct 引用，路径自带 /api/v1 前缀） ----------------
let sessionCounter = 0
const sessions = new Map() // id -> { cwd, title, workspaceId, prompts: [] }
function sessionState(id) {
  if (!sessions.has(id)) sessions.set(id, { cwd: undefined, title: '', workspaceId: undefined, prompts: [] })
  return sessions.get(id)
}

const stub = createServer((req, res) => {
  const url = req.url || ''
  const sid = (url.match(/\/api\/v1\/sessions\/([^/?]+)/) || [])[1]
  const st = sid ? sessionState(sid) : undefined
  let chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = (() => { try { return JSON.parse(Buffer.concat(chunks).toString() || '{}') } catch { return {} } })()
    if (req.method === 'POST' && url === '/api/v1/sessions') {
      sessionCounter++
      const id = `stub-pm-${sessionCounter}`
      const s = sessionState(id)
      s.cwd = body?.cwd
      s.workspaceId = body?.workspaceId
      s.title = body?.title || ''
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, data: { sessionId: id } }))
      return
    }
    if (!sid) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Endpoint not found' })); return }
    if (req.method === 'GET' && url === `/api/v1/sessions/${sid}`) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, data: { sessionId: sid, status: 'idle', cwd: st.cwd || '/tmp/def' } }))
      return
    }
    if (req.method === 'GET' && url.startsWith(`/api/v1/sessions/${sid}/history`)) {
      const lastPrompt = st.prompts[st.prompts.length - 1] || ''
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, data: { messages: [{ role: 'user', content: lastPrompt }, { role: 'assistant', content: 'stub 已完成' }] } }))
      return
    }
    if (req.method === 'PUT' && url === `/api/v1/sessions/${sid}/permission`) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'no permission route' }))
      return
    }
    if (req.method === 'POST' && url === `/api/v1/sessions/${sid}/prompt-stream`) {
      st.prompts.push(body?.prompt || '')
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(`event: delta\ndata: ${JSON.stringify({ delta: 'stub 已按项目上下文完成收集' })}\n\n`)
      res.write(`event: turn_end\ndata: ${JSON.stringify({ reason: 'end_turn' })}\n\n`)
      res.write(`event: done\ndata: [DONE]\n\n`)
      res.end()
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
  const dataDir = mkdtempSync(join(tmpdir(), 'workbuddy-pm-e2e-'))
  console.log(`\n== @项目提及 E2E ==\n`)
  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r))
  const server = spawn(process.execPath, [join(ROOT, 'dist', 'server.js'), '--port', String(PORT), '--data', dataDir, '--quiet'],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] })
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))
  procs.push(server)
  await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok, 'server 就绪')

  const loginRes = await fetch(`${BASE}${PREFIX}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'workbuddy', password: 'ThunderSoft@88' }),
  })
  COOKIE = (loginRes.headers.get('set-cookie') || '').split(';')[0]
  check('登录成功', loginRes.ok)

  // 种两个项目：P1 挂 stub 节点 + 工作区 + 项目指令；P2 用于冲突场景
  const p1 = (await req('POST', `${PREFIX}/api/projects`, {
    name: '网关交付项目',
    dshRef: { kind: 'direct', apiBaseUrl: STUB_BASE },
    workspace: '/tmp/pm-e2e-ws',
    instruction: '网关交付项目专用指令：所有汇报必须带【网关】前缀',
  })).json?.data
  check('项目 P1 创建成功', Boolean(p1?.id), `err=${p1?.error || ''}`)
  const p2 = (await req('POST', `${PREFIX}/api/projects`, {
    name: '备用项目X',
    dshRef: { kind: 'direct', apiBaseUrl: STUB_BASE },
    workspace: '/tmp/pm-e2e-ws-2',
  })).json?.data
  check('项目 P2 创建成功', Boolean(p2?.id))

  // ---- 场景 1：提及候选含项目 ----
  const cand = (await req('GET', `${PREFIX}/api/mentions/candidates`)).json?.data || []
  const p1cand = cand.find((c) => c.type === 'project' && c.id === p1.id)
  check('候选含项目条目（type=project）', Boolean(p1cand), JSON.stringify(p1cand || {}).slice(0, 100))
  check('候选项目 detail 带工作区', String(p1cand?.detail || '').includes('/tmp/pm-e2e-ws'), p1cand?.detail)

  // ---- 场景 2：UI 流程 —— 新建空任务，首条消息 @项目 ----
  const tA = (await req('POST', `${PREFIX}/api/tasks`, { title: '新任务' })).json?.data
  check('空任务创建成功（无节点/无项目/无成员）', Boolean(tA?.id) && !tA.projectId && (tA.memberAgentIds || []).length === 0,
    `id=${tA?.id} projectId=${tA?.projectId} members=${JSON.stringify(tA?.memberAgentIds)}`)
  await req('POST', `${PREFIX}/api/tasks/${tA.id}/messages`, { message: '@网关交付项目 收集磁盘占用并输出报告' })
  await waitFor(async () => {
    const d = await req('GET', `${PREFIX}/api/tasks/${tA.id}`)
    return d.json?.data?.status === 'completed' || d.json?.data?.status === 'failed'
  }, '任务 A 回合结束', 30000)
  const dA = (await req('GET', `${PREFIX}/api/tasks/${tA.id}`)).json.data
  check('任务 A 状态 completed', dA.status === 'completed', `status=${dA.status}`)
  check('@项目已绑定 projectId', dA.projectId === p1.id, `projectId=${dA.projectId}`)
  check('用户轮原文保留 @项目名', (dA.turns || []).some((x) => x.role === 'user' && String(x.text).includes('@网关交付项目')))
  check('系统轮提示已绑定项目', (dA.turns || []).some((x) => x.role === 'system' && String(x.text).includes('已绑定项目「网关交付项目」')))
  check('主会话项目节点直发（lastRoute source=node）', dA.lastRoute?.source === 'node' && dA.lastRoute?.agentId === '__node__',
    JSON.stringify(dA.lastRoute || {}))
  const stubSessions = [...sessions.values()]
  check('远端会话 cwd = 项目工作区', stubSessions.some((s) => s.cwd === '/tmp/pm-e2e-ws'),
    JSON.stringify(stubSessions.map((s) => s.cwd)))
  check('提示词含项目指令（sysPrefix 注入）', stubSessions.some((s) => (s.prompts || []).some((p) => p.includes('网关交付项目专用指令'))))
  check('本轮未拉入任何成员（成员账本仍为空）', (dA.memberAgentIds || []).length === 0, JSON.stringify(dA.memberAgentIds))

  // ---- 场景 3：工具通道 —— create 直接带 @项目 message ----
  const tB = (await req('POST', `${PREFIX}/api/tasks`, { message: '@网关交付项目 生成周报摘要' })).json?.data
  check('create 回执即已绑定项目', tB?.projectId === p1.id, `projectId=${tB?.projectId}`)
  await waitFor(async () => {
    const d = await req('GET', `${PREFIX}/api/tasks/${tB.id}`)
    return d.json?.data?.status === 'completed' || d.json?.data?.status === 'failed'
  }, '任务 B 回合结束', 30000)
  const dB = (await req('GET', `${PREFIX}/api/tasks/${tB.id}`)).json.data
  check('任务 B completed 且 lastRoute=node', dB.status === 'completed' && dB.lastRoute?.source === 'node', `status=${dB.status} route=${JSON.stringify(dB.lastRoute || {})}`)

  // ---- 场景 4：冲突治理 —— 已绑定项目的任务再 @ 另一项目 ----
  await req('POST', `${PREFIX}/api/tasks/${tA.id}/messages`, { message: '@备用项目X 顺便看下内存' })
  await waitFor(async () => {
    const d = await req('GET', `${PREFIX}/api/tasks/${tA.id}`)
    const turns = d.json?.data?.turns || []
    return turns.some((x) => x.role === 'system' && String(x.text).includes('已忽略'))
  }, '冲突提示出现', 30000)
  const dA2 = (await req('GET', `${PREFIX}/api/tasks/${tA.id}`)).json.data
  check('projectId 未被切换（仍为 P1）', dA2.projectId === p1.id, `projectId=${dA2.projectId}`)
  check('冲突提示文案齐全', (dA2.turns || []).some((x) => x.role === 'system' && String(x.text).includes('已绑定项目「网关交付项目」') && String(x.text).includes('中途切换')))

  // ---- 收尾 ----
  try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  console.log(failures === 0 ? '\n🎉 全部通过\n' : `\n💥 ${failures} 项失败\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('E2E 异常:', err)
  process.exit(1)
})
