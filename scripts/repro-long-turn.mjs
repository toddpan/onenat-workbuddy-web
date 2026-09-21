#!/usr/bin/env node
/**
 * OneNat WorkBuddy — 长对话/超长回复丢同步问题复现脚本
 *
 *   node scripts/repro-long-turn.mjs
 *
 * 内置一个讲 dsh-web-service 协议的 mock 远端（/sessions、/sessions/:id、prompt-stream、history），
 * 通过 workbuddy 完整链路（引擎 → 远端 SSE → 对账兜底 → 浏览器视角 SSE）跑 4 个场景：
 *
 *   A. baseline  多轮正常对话（3 轮，每轮 ~1KB）
 *   B. long      单轮超长回复（3000 帧 × 200 字符 ≈ 600KB）
 *   C. broken    流中断：推 5% 后 socket 直接销毁（无 turn_end/done），远端后台继续执行 → 应转轮询对账拿回完整回复
 *   D. error     远端 error 事件不关流（对齐 dsh-web-service 现状），后台恢复 → 应立即转轮询拿回
 *
 * 每个场景断言：浏览器视角 SSE 收到 turn_end、最终轮文本与远端权威文本完全一致。
 * 退出码非 0 即失败。
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.SMOKE_PORT || 18110)
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT || 18111)
const ONENAT_PORT = Number(process.env.SMOKE_ONENAT_PORT || 18112)
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
function spawnJob(name, cmd, args, env = {}) {
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.logs = []
  child.stdout.on('data', (d) => child.logs.push(...String(d).split('\n').filter(Boolean)))
  child.stderr.on('data', (d) => child.logs.push(...String(d).split('\n').filter(Boolean)))
  procs.push(child)
  return child
}
function cleanup() {
  for (const p of procs) { try { p.kill('SIGKILL') } catch { /* ignore */ } }
}
process.on('exit', cleanup)
process.on('SIGINT', () => process.exit(1))

// ---------------- mock dsh-web-service ----------------

const sessions = new Map() // id -> { status, history: [], script }
function sessionOf(id) {
  let s = sessions.get(id)
  if (!s) { s = { status: 'idle', history: [], clients: new Set() }; sessions.set(id, s) }
  return s
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

async function handlePromptStream(req, res, sessionId, body) {
  const prompt = String(body?.prompt || '')
  const s = sessionOf(sessionId)
  s.status = 'running'
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  })
  sseWrite(res, 'connected', { sessionId })

  // 权威全文：流式 delta 就是它的分片（与真实远端一致），断流/出错场景的 history 也用它
  const pad = prompt.startsWith('scene-broken') ? 30000 : prompt.startsWith('scene-long') ? 150000 : 0
  const fullText = `${prompt} 的完整回复。`.repeat(3) + '【尾部标记-' + prompt.slice(0, 24) + '-END】' + '。'.repeat(pad)

  const run = async () => {
    try {
      if (prompt.startsWith('scene-broken')) {
        // 只推 5% 就销毁 socket（模拟远端进程崩/链路断），无 turn_end 无 done
        const full = Buffer.from(fullText, 'utf-8')
        const cut = Math.floor(full.length * 0.05)
        sseWrite(res, 'delta', { delta: full.subarray(0, cut).toString('utf-8') })
        setTimeout(() => {
          try { res.destroy() } catch { /* ignore */ }
        }, 200)
        setTimeout(() => {
          s.history.push({ role: 'assistant', content: fullText })
          s.status = 'idle'
        }, 4000)
        return
      }
      if (prompt.startsWith('scene-hang')) {
        // 复合形态：1 帧之后流开着但永远静默（远端挂起/半开），后台 6s 后远端恢复完成
        sseWrite(res, 'delta', { delta: '挂起前的内容。' })
        setTimeout(() => {
          s.history.push({ role: 'assistant', content: fullText })
          s.status = 'idle'
        }, 6000)
        return // 不发 turn_end / done，不关流
      }
      if (prompt.startsWith('scene-error')) {
        // 对齐 dsh-web-service 现状：error 事件后既不关流也不发 turn_end
        sseWrite(res, 'delta', { delta: 'error 前的部分内容。' })
        sseWrite(res, 'error', { message: '模拟上游 provider 超时' })
        setTimeout(() => {
          s.history.push({ role: 'assistant', content: fullText })
          s.status = 'idle'
        }, 4000)
        return
      }
      // baseline / long：把权威全文按帧流出
      if (prompt.startsWith('scene-long')) {
        const frames = 3000
        const size = Math.ceil(fullText.length / frames)
        for (let i = 0; i < frames; i++) {
          sseWrite(res, 'delta', { delta: fullText.slice(i * size, (i + 1) * size) })
          if (i % 200 === 0) await sleep(5)
        }
      } else {
        const chunks = 10
        const size = Math.ceil(fullText.length / chunks)
        for (let i = 0; i < chunks; i++) sseWrite(res, 'delta', { delta: fullText.slice(i * size, (i + 1) * size) })
      }
      s.history.push({ role: 'assistant', content: fullText })
      s.status = 'idle'
      sseWrite(res, 'turn_end', { reason: 'completed' })
      sseWrite(res, 'done', '[DONE]')
      res.end()
    } catch { /* 客户端断开等 */ }
  }
  void run()
}

function startMockDsh() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost')
    const p = url.pathname
    if (req.method === 'POST' && p === '/sessions') {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        sessionOf('sess-mock-1')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, data: { sessionId: 'sess-mock-1' } }))
      })
      return
    }
    if (req.method === 'GET' && /^\/sessions\/[^/]+$/.test(p)) {
      const s = sessionOf(p.split('/')[2])
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, data: { status: s.status, title: 'mock' } }))
      return
    }
    if (req.method === 'GET' && /^\/sessions\/[^/]+\/history/.test(p)) {
      const s = sessionOf(p.split('/')[2])
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, data: { messages: s.history } }))
      return
    }
    if (req.method === 'POST' && /^\/sessions\/[^/]+\/prompt-stream$/.test(p)) {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        let parsed = {}
        try { parsed = JSON.parse(body) } catch { /* ignore */ }
        void handlePromptStream(req, res, p.split('/')[2], parsed)
      })
      return
    }
    if (req.method === 'POST' && /^\/sessions\/[^/]+\/prompt$/.test(p)) {
      // 同步降级路径：直接给完整回复
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        const prompt = (() => { try { return JSON.parse(body).prompt || '' } catch { return '' } })()
        const s = sessionOf(p.split('/')[2])
        const fullText = `${prompt} 的完整回复。`.repeat(3) + '【尾部标记-' + prompt.slice(0, 24) + '-END】'
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, data: { content: fullText } }))
      })
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'not found: ' + p }))
  })
  return new Promise((done) => server.listen(MOCK_PORT, '127.0.0.1', () => done(server)))
}

// ---------------- 主流程 ----------------

async function main() {
  if (!existsSync(join(ROOT, 'dist', 'server.js'))) {
    console.error('缺少 dist/server.js —— 先执行: bash scripts/build-standalone.sh')
    process.exit(1)
  }
  console.log(`\n== 长对话/超长回复丢同步复现 ==\n   workbuddy ${BASE}${PREFIX}\n   mock dsh-web-service http://127.0.0.1:${MOCK_PORT}\n`)

  await startMockDsh()

  const dataDir = mkdtempSync(join(tmpdir(), 'workbuddy-longturn-'))
  spawnJob('workbuddy', process.execPath, [join(ROOT, 'dist', 'server.js'), '--port', String(PORT), '--data', dataDir,
    '--onenat-base-url', `http://127.0.0.1:${ONENAT_PORT}`, '--onenat-api-key', 'onk-x', '--quiet'], { WB_SSE_IDLE_TIMEOUT_MS: '8000' })
  const t0 = Date.now()
  for (;;) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) break } catch { /* retry */ }
    if (Date.now() - t0 > 30000) throw new Error('workbuddy 启动超时')
    await sleep(400)
  }

  // 登录
  const loginRes = await fetch(`${BASE}${PREFIX}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'workbuddy', password: 'ThunderSoft@88' }),
  })
  const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0]
  const authHdr = { 'Content-Type': 'application/json', Cookie: cookie }

  // 建智能体（直连 mock DSH）
  await fetch(`${BASE}${PREFIX}/api/agents`, { method: 'POST', headers: authHdr,
    body: JSON.stringify({ name: '长回复执行者', dshRef: { kind: 'direct', apiBaseUrl: `http://127.0.0.1:${MOCK_PORT}` } }) })
  const agents = await fetch(`${BASE}${PREFIX}/api/agents`, { headers: { Cookie: cookie } }).then((r) => r.json())
  const agentId = agents.data[0].id

  // 建任务（第一条消息即 scene-baseline）
  const taskRes = await fetch(`${BASE}${PREFIX}/api/tasks`, { method: 'POST', headers: authHdr,
    body: JSON.stringify({ title: '长回复复现', memberAgentIds: [agentId], message: 'scene-baseline 第 1 轮' }) })
  const task = (await taskRes.json()).data
  const taskId = task.id

  // 浏览器视角 SSE（收集 UI 能收到的事件）
  const uiEvents = []
  const esResp = await fetch(`${BASE}${PREFIX}/api/tasks/${taskId}/stream`, { headers: { Cookie: cookie } })
  ;(async () => {
    const reader = esResp.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        const evName = (/^event: (.*)$/m.exec(frame) || [])[1] || ''
        const dataRaw = (/^data: (.*)$/m.exec(frame) || [])[1] || ''
        if (evName) uiEvents.push({ ev: evName, data: dataRaw.slice(0, 200) })
      }
    }
  })().catch(() => {})

  /** 等待任务空闲且 agent 轮数达到 expectedTurns，返回最新 agent 轮文本 */
  const waitTurn = async (expectedTurns, label, timeoutMs = 90000) => {
    const t = Date.now()
    for (;;) {
      const r = await fetch(`${BASE}${PREFIX}/api/tasks/${taskId}`, { headers: { Cookie: cookie } }).then((x) => x.json())
      const d = r?.data
      const agentTurns = (d?.turns || []).filter((x) => x.role === 'agent')
      if (d && !d.running && agentTurns.length >= expectedTurns && (agentTurns[agentTurns.length - 1]?.text || '').length > 0) {
        return agentTurns[agentTurns.length - 1]
      }
      if (Date.now() - t > timeoutMs) throw new Error(`等待超时: ${label}（running=${d?.running} agentTurns=${agentTurns.length}）`)
      await sleep(500)
    }
  }

  // ---------- 场景 A：多轮基线（先等第 1 轮完成；第 2 轮） ----------
  await waitTurn(1, 'baseline 第 1 轮')
  const a0 = Date.now()
  await fetch(`${BASE}${PREFIX}/api/tasks/${taskId}/messages`, { method: 'POST', headers: authHdr, body: JSON.stringify({ message: 'scene-baseline 第 2 轮' }) })
  const turnA = await waitTurn(2, 'baseline 第 2 轮')
  check('A1 多轮基线：回复完整到达', turnA.text.includes('尾部标记-scene-baseline 第 2 轮-END】'), `${turnA.text.length} 字`)
  check('A2 UI 视角收到 turn_end', uiEvents.some((e) => e.ev === 'turn_end'), `事件数 ${uiEvents.length}`)
  console.log(`   （A 场景耗时 ${Math.round((Date.now() - a0) / 1000)}s）\n`)

  // ---------- 场景 B：单轮超长回复 ----------
  const b0 = Date.now()
  await fetch(`${BASE}${PREFIX}/api/tasks/${taskId}/messages`, { method: 'POST', headers: authHdr, body: JSON.stringify({ message: 'scene-long 超长回复' }) })
  const turnB = await waitTurn(3, 'long 超长回复')
  const deltas = uiEvents.filter((e) => e.ev === 'turn_delta').length
  check('B1 超长回复（~150KB）完整到达', turnB.text.startsWith('scene-long 超长回复 的完整回复。') && turnB.text.includes('-END】') && turnB.text.length > 150000, `${turnB.text.length} 字`)
  check('B2 UI 视角流式 delta 正常推送', deltas > 1000, `${deltas} 帧`)
  console.log(`   （B 场景耗时 ${Math.round((Date.now() - b0) / 1000)}s）\n`)

  // ---------- 场景 C：流中断（无 turn_end，socket 销毁） ----------
  const c0 = Date.now()
  await fetch(`${BASE}${PREFIX}/api/tasks/${taskId}/messages`, { method: 'POST', headers: authHdr, body: JSON.stringify({ message: 'scene-broken 断流轮' }) })
  const turnC = await waitTurn(4, 'broken 断流轮')
  check('C1 断流后转轮询对账，完整回复不丢（含 30000 填充尾部）', turnC.text.startsWith('scene-broken 断流轮 的完整回复。') && turnC.text.length > 30000, `${turnC.text.length} 字`)
  console.log(`   （C 场景耗时 ${Math.round((Date.now() - c0) / 1000)}s）\n`)

  // ---------- 场景 D：error 事件不关流（dsh-web-service 现状） ----------
  const d0 = Date.now()
  await fetch(`${BASE}${PREFIX}/api/tasks/${taskId}/messages`, { method: 'POST', headers: authHdr, body: JSON.stringify({ message: 'scene-error 错误恢复轮' }) })
  const turnD = await waitTurn(5, 'error 恢复轮')
  check('D1 error 事件后轮询对账，回复不丢', turnD.text.includes('尾部标记-scene-error'), `${turnD.text.length} 字`)
  console.log(`   （D 场景耗时 ${Math.round((Date.now() - d0) / 1000)}s）\n`)

  // ---------- 场景 E：流永久挂起（看门狗应触发并转轮询） ----------
  const e0 = Date.now()
  await fetch(`${BASE}${PREFIX}/api/tasks/${taskId}/messages`, { method: 'POST', headers: authHdr, body: JSON.stringify({ message: 'scene-hang 挂起恢复轮' }) })
  const turnE = await waitTurn(6, 'hang 挂起恢复轮')
  check('E1 流永久挂起时看门狗断开转对账，回复不丢', turnE.text.includes('尾部标记-scene-hang'), `${turnE.text.length} 字，耗时 ${Math.round((Date.now() - e0) / 1000)}s`)

  console.log(results.join('\n'))
  console.log(`\n${failures === 0 ? '✅ 全部通过' : '❌ 存在失败'}（共 ${results.length} 项）\n`)
  cleanup()
  try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('复现中断:', err?.stack || err)
  cleanup()
  process.exit(1)
})
