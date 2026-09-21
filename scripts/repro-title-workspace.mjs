#!/usr/bin/env node
/**
 * OneNat WorkBuddy — 标题生成复用任务会话 + 工作区对齐 验证脚本
 *
 *   node scripts/repro-title-workspace.mjs
 *
 * mock DSH 带工作区体系（GET /workspaces、POST /sessions 透传 workspaceId、/chat/completions 记录 sessionId）。
 * 覆盖：
 *   1. 首轮消息 → 远端只创建 1 个会话；标题在该会话内生成（chat 带 sessionId），任务标题被更新
 *   2. 建会话携带正确 workspaceId（按 agent.workDir 最长前缀解析）
 *   3. 第二轮消息 → 不新建会话、不再触发标题问答
 *   4. WEB 切换主智能体 → 新主智能体的会话按其工作区预热创建
 *
 * 退出码非 0 即失败。
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.SMOKE_PORT || 18114)
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT || 18115)
const ONENAT_PORT = Number(process.env.SMOKE_ONENAT_PORT || 18116)
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const procs = []
function spawnJob(cmd, args, env = {}) {
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.logs = []
  child.stdout.on('data', (d) => child.logs.push(...String(d).split('\n').filter(Boolean)))
  child.stderr.on('data', (d) => child.logs.push(...String(d).split('\n').filter(Boolean)))
  procs.push(child)
  return child
}
function cleanup() { for (const p of procs) { try { p.kill('SIGKILL') } catch { /* */ } } }
process.on('exit', cleanup)
process.on('SIGINT', () => process.exit(1))

// ---------------- mock dsh-web-service（带工作区） ----------------

const state = {
  sessionCreates: [],   // POST /sessions 的 body
  chatCalls: [],        // POST /chat/completions 的 body
  workspaceRegisters: [], // POST /workspaces 的 body
  workspaces: [
    { id: 'ws-alpha', path: '/workspace/alpha', title: 'Alpha 工作区' },
    { id: 'ws-beta', path: '/workspace/beta', title: 'Beta 工作区' },
  ],
  sessions: new Map(),  // id -> { status, history }
  nextId: 1,
}
function sessionOf(id) {
  let s = state.sessions.get(id)
  if (!s) { s = { status: 'idle', history: [] }; state.sessions.set(id, s) }
  return s
}
function json(res, code, data) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
function readBody(req) {
  return new Promise((done) => {
    let b = ''
    req.on('data', (c) => { b += c })
    req.on('end', () => { try { done(JSON.parse(b)) } catch { done({}) } })
  })
}

function startMockDsh() {
  const server = createServer(async (req, res) => {
    const p = (req.url || '/').split('?')[0]
    if (req.method === 'GET' && p === '/workspaces') {
      return json(res, 200, { ok: true, data: state.workspaces })
    }
    if (req.method === 'POST' && p === '/workspaces') {
      const body = await readBody(req)
      state.workspaceRegisters.push(body)
      let ws = state.workspaces.find((w) => w.path === body.path)
      if (!ws) {
        ws = { id: 'ws-reg-' + (state.workspaces.length + 1), path: body.path, title: body.title || '' }
        state.workspaces.push(ws)
      }
      return json(res, 201, { ok: true, data: ws })
    }
    if (req.method === 'POST' && p === '/sessions') {
      const body = await readBody(req)
      state.sessionCreates.push(body)
      const id = `sess-${state.nextId++}`
      sessionOf(id)
      return json(res, 201, { ok: true, data: { sessionId: id, workspaceId: body.workspaceId } })
    }
    if (req.method === 'POST' && p === '/chat/completions') {
      const body = await readBody(req)
      state.chatCalls.push(body)
      const isTitle = JSON.stringify(body.messages || []).includes('标题提炼')
      const content = isTitle ? '整理测试文档' : '收到。'
      if (body.sessionId) {
        const s = sessionOf(body.sessionId)
        s.history.push({ role: 'user', content: JSON.stringify(body.messages) })
        s.history.push({ role: 'assistant', content })
      }
      return json(res, 200, { ok: true, choices: [{ message: { role: 'assistant', content } }], sessionId: body.sessionId })
    }
    if (req.method === 'POST' && /\/prompt-stream$/.test(p)) {
      const body = await readBody(req)
      const id = p.split('/')[2]
      const s = sessionOf(id)
      s.status = 'running'
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const fullText = `${String(body.prompt || '').slice(0, 20)} 的回复。`
      res.write(`event: delta\ndata: ${JSON.stringify({ delta: fullText })}\n\n`)
      s.history.push({ role: 'assistant', content: fullText })
      s.status = 'idle'
      res.write('event: turn_end\ndata: {"reason":"completed"}\n\n')
      res.write('event: done\ndata: "[DONE]"\n\n')
      res.end()
      return
    }
    if (req.method === 'GET' && /^\/sessions\/[^/]+$/.test(p)) {
      const s = sessionOf(p.split('/')[2])
      return json(res, 200, { ok: true, data: { status: s.status } })
    }
    if (req.method === 'GET' && /\/history/.test(p)) {
      const s = sessionOf(p.split('/')[2])
      return json(res, 200, { ok: true, data: { messages: s.history } })
    }
    json(res, 404, { ok: false, error: 'not found: ' + p })
  })
  return new Promise((done) => server.listen(MOCK_PORT, '127.0.0.1', () => done(server)))
}

async function main() {
  console.log(`\n== 标题生成复用会话 + 工作区对齐 验证 ==\n   workbuddy ${BASE}${PREFIX}\n   mock dsh http://127.0.0.1:${MOCK_PORT}\n`)

  await startMockDsh()
  const dataDir = mkdtempSync(join(tmpdir(), 'workbuddy-title-ws-'))
  spawnJob('node', [join(ROOT, 'dist', 'server.js'), '--port', String(PORT), '--data', dataDir,
    '--onenat-base-url', `http://127.0.0.1:${ONENAT_PORT}`, '--onenat-api-key', 'onk-x', '--quiet'])
  const t0 = Date.now()
  for (;;) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) break } catch { /* */ }
    if (Date.now() - t0 > 30000) throw new Error('workbuddy 启动超时')
    await sleep(400)
  }
  const lr = await fetch(`${BASE}${PREFIX}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'workbuddy', password: 'ThunderSoft@88' }) })
  const cookie = (lr.headers.get('set-cookie') || '').split(';')[0]
  const H = { 'Content-Type': 'application/json', Cookie: cookie }

  // 两个智能体：工作区 alpha（workDir 在其子目录）/ beta
  await fetch(`${BASE}${PREFIX}/api/agents`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'Alpha 主智能体', dshRef: { kind: 'direct', apiBaseUrl: `http://127.0.0.1:${MOCK_PORT}` }, workDir: '/workspace/alpha/sub' }) })
  await fetch(`${BASE}${PREFIX}/api/agents`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'Beta 备选智能体', dshRef: { kind: 'direct', apiBaseUrl: `http://127.0.0.1:${MOCK_PORT}` }, workDir: '/workspace/beta' }) })
  const agents = await fetch(`${BASE}${PREFIX}/api/agents`, { headers: { Cookie: cookie } }).then((r) => r.json())
  const alpha = agents.data.find((a) => a.name === 'Alpha 主智能体')
  const beta = agents.data.find((a) => a.name === 'Beta 备选智能体')

  // ---------- 场景 1：首轮消息 → 1 个会话 + 标题在会话内生成 + 工作区正确 ----------
  const tr = await fetch(`${BASE}${PREFIX}/api/tasks`, { method: 'POST', headers: H, body: JSON.stringify({ title: '新任务', memberAgentIds: [alpha.id], message: '帮我整理测试文档' }) }).then((r) => r.json())
  const taskId = tr.data.id
  for (let i = 0; i < 40; i++) {
    const t = await fetch(`${BASE}${PREFIX}/api/tasks/${taskId}`, { headers: { Cookie: cookie } }).then((r) => r.json())
    if (!t.data.running && (t.data.turns || []).some((x) => x.role === 'agent')) break
    await sleep(400)
  }
  check('远端只创建了 1 个会话（标题不再另起会话）', state.sessionCreates.length === 1, `count=${state.sessionCreates.length}`)
  check('workDir 无精确匹配工作区 → 自动注册并携带 workspaceId（cwd 不再同传）', String(state.sessionCreates[0]?.workspaceId || '').startsWith('ws-reg-') && state.sessionCreates[0]?.cwd === undefined, JSON.stringify(state.sessionCreates[0]))
  check('自动注册请求携带 workDir 路径', state.workspaceRegisters.some((w) => w.path === '/workspace/alpha/sub'), JSON.stringify(state.workspaceRegisters))
  const task1 = await fetch(`${BASE}${PREFIX}/api/tasks/${taskId}`, { headers: { Cookie: cookie } }).then((r) => r.json())
  check('任务标题已被会话内问答更新', task1.data?.title === '整理测试文档', task1.data?.title)
  const createdSessionId = 'sess-1'
  check('标题问答发生在任务自身会话内（chat 带 sessionId）', state.chatCalls.length === 1 && state.chatCalls[0]?.sessionId === createdSessionId && JSON.stringify(state.chatCalls[0]?.messages || []).includes('标题提炼'), JSON.stringify(state.chatCalls[0]?.sessionId))

  // ---------- 场景 2：第二轮消息 → 不新建会话、不再触发标题 ----------
  await fetch(`${BASE}${PREFIX}/api/tasks/${taskId}/messages`, { method: 'POST', headers: H, body: JSON.stringify({ message: '继续补充第二章' }) })
  for (let i = 0; i < 40; i++) {
    const t = await fetch(`${BASE}${PREFIX}/api/tasks/${taskId}`, { headers: { Cookie: cookie } }).then((r) => r.json())
    const at = (t.data.turns || []).filter((x) => x.role === 'agent')
    if (!t.data.running && at.length >= 2) break
    await sleep(400)
  }
  check('第二轮不新建会话', state.sessionCreates.length === 1, `count=${state.sessionCreates.length}`)
  check('第二轮不触发标题问答', state.chatCalls.length === 1, `chatCalls=${state.chatCalls.length}`)

  // ---------- 场景 3：WEB 切换主智能体 → 新主智能体会话按其工作区预热创建 ----------
  state.sessionCreates.length = 0
  await fetch(`${BASE}${PREFIX}/api/planner/config`, { method: 'POST', headers: H, body: JSON.stringify({ agentId: beta.id, taskId }) })
  await sleep(2500)
  const task3 = await fetch(`${BASE}${PREFIX}/api/tasks/${taskId}`, { headers: { Cookie: cookie } }).then((r) => r.json())
  check('切换主智能体后成员账本跟随', task3.data?.memberAgentIds?.[0] === beta.id, JSON.stringify(task3.data?.memberAgentIds))
  check('切换后新主智能体会话按其工作区预热创建', state.sessionCreates.some((x) => x.workspaceId === 'ws-beta'), JSON.stringify(state.sessionCreates))

  // ---------- 场景 4：workDir 无匹配工作区 → 自动注册并使用 ----------
  await fetch(`${BASE}${PREFIX}/api/agents`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'Gamma 新工作区智能体', dshRef: { kind: 'direct', apiBaseUrl: `http://127.0.0.1:${MOCK_PORT}` }, workDir: '/workspace/gamma/deep' }) })
  const agents4 = await fetch(`${BASE}${PREFIX}/api/agents`, { headers: { Cookie: cookie } }).then((r) => r.json())
  const gamma = agents4.data.find((a) => a.name === 'Gamma 新工作区智能体')
  state.sessionCreates.length = 0
  state.workspaceRegisters.length = 0
  await fetch(`${BASE}${PREFIX}/api/planner/config`, { method: 'POST', headers: H, body: JSON.stringify({ agentId: gamma.id, taskId }) })
  await sleep(2500)
  const reg = state.workspaceRegisters.find((w) => w.path === '/workspace/gamma/deep')
  check('无匹配工作区 → 自动在远端注册（POST /workspaces 携带 path）', Boolean(reg), JSON.stringify(state.workspaceRegisters))
  check('新会话携带自动注册的 workspaceId', state.sessionCreates.some((x) => x.workspaceId === 'ws-reg-4'), JSON.stringify(state.sessionCreates))

  console.log('\n' + results.join('\n'))
  console.log(`\n${failures === 0 ? '✅ 全部通过' : '❌ 存在失败'}（共 ${results.length} 项）\n`)
  cleanup()
  try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* */ }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => { console.error('验证中断:', err?.stack || err); cleanup(); process.exit(1) })
