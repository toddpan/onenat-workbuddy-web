#!/usr/bin/env node
/** 执行中排队 + steer 立即插话 E2E：node scripts/queue-e2e.mjs */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 18096, STUB_PORT = 18097, PREFIX = '/onenat-workbuddy', BASE = `http://127.0.0.1:${PORT}`
let failures = 0
const check = (n, c, d = '') => { const ok = Boolean(c); if (!ok) failures++; console.log(`${ok ? '  ✅' : '  ❌'} ${n}${d ? ` — ${d}` : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const normalPrompts = [], steers = []
const stub = createServer((req, res) => {
  const url = req.url || ''
  let body = ''
  req.on('data', (c) => { body += c }); req.on('end', () => {
    if (req.method === 'POST' && url === '/api/v1/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, data: { sessionId: 'stub-s1' } })); return
    }
    if (req.method === 'GET' && url === '/api/v1/sessions/stub-s1') {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, data: { sessionId: 'stub-s1', cwd: '/tmp' } })); return
    }
    if (req.method === 'POST' && url === '/api/v1/sessions/stub-s1/prompt-stream') {
      const parsed = (() => { try { return JSON.parse(body) } catch { return {} } })()
      if (parsed.mode === 'steer') {
        steers.push(parsed.prompt || '')
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('event: done\ndata: {}\n\n'); res.end(); return
      }
      normalPrompts.push(parsed.prompt || '')
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('event: delta\ndata: {"delta":"ok"}\n\n')
      setTimeout(() => { // 拖 4s：制造「运行中」窗口供排队/插话
        res.write('event: turn_end\ndata: {}\n\n'); res.write('event: done\ndata: {}\n\n'); res.end()
      }, 4000)
      return
    }
    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Endpoint not found' }))
  })
})

const procs = []
function cleanup() { try { stub.close() } catch {} for (const p of procs) { try { p.kill('SIGKILL') } catch {} } }
process.on('exit', cleanup)
let COOKIE = ''
async function req(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(COOKIE ? { Cookie: COOKIE } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text(); let json; try { json = JSON.parse(text) } catch {}
  return { status: res.status, json }
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'wb-queue-e2e-'))
  console.log('\n== 排队/插话 E2E ==\n')
  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r))
  const server = spawn(process.execPath, [join(ROOT, 'dist', 'server.js'), '--port', String(PORT), '--data', dataDir, '--quiet'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] })
  procs.push(server)
  const t0 = Date.now(); while (Date.now() - t0 < 20000) { try { if ((await fetch(`${BASE}/healthz`)).ok) break } catch {} await sleep(250) }
  const loginRes = await fetch(`${BASE}${PREFIX}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'workbuddy', password: 'ThunderSoft@88' }) })
  COOKIE = (loginRes.headers.get('set-cookie') || '').split(';')[0]
  check('登录', loginRes.ok)

  await req('POST', `${PREFIX}/api/agents`, { name: 'queue-e2e', dshRef: { kind: 'direct', apiBaseUrl: `http://127.0.0.1:${STUB_PORT}/api/v1` }, apiKey: 'stub-key' })
  const taskRes = await req('POST', `${PREFIX}/api/tasks`, { title: 'queue e2e', mode: 'chat' })
  const taskId = taskRes.json?.data?.id
  check('创建节点直发任务', Boolean(taskId))

  // msg1：进入运行中（stub 拖 4s）
  await req('POST', `${PREFIX}/api/tasks/${taskId}/messages`, { message: '第一条' })
  await sleep(1200)
  // msg2：运行中发送 → 应排队
  const r2 = await req('POST', `${PREFIX}/api/tasks/${taskId}/messages`, { message: '第二条（排队）' })
  check('运行中发送 → 排队（queued=true）', r2.json?.queued === true && r2.json?.ok === true, JSON.stringify(r2.json || {}).slice(0, 120))
  const d1 = await req('GET', `${PREFIX}/api/tasks/${taskId}`)
  const qTurn = (d1.json?.data?.turns || []).find((t) => t.queued)
  check('任务详情含 queued 轮次', Boolean(qTurn), qTurn ? qTurn.text : '无')
  check('task.queue 登记 1 条', (d1.json?.data?.queue || []).length === 1)

  // 「立即发送」→ steer 插话
  const now = await req('POST', `${PREFIX}/api/tasks/${taskId}/queue/send`, { turnId: qTurn.id })
  check('queue/send 成功', now.json?.ok === true, JSON.stringify(now.json || {}).slice(0, 100))
  check('stub 收到 steer 插话（含第二条文本）', steers.some((t) => t.includes('第二条')), `steers=${steers.length}`)
  const d2 = await req('GET', `${PREFIX}/api/tasks/${taskId}`)
  check('排队标记已清除', !(d2.json?.data?.turns || []).some((t) => t.queued) && (d2.json?.data?.queue || []).length === 0)

  // 自动补发验证：等首轮结束 → 引擎应把剩余排队补发（此处队列已空，验证不补发即可）
  console.log(failures === 0 ? '\n全部通过 ✅\n' : `\n${failures} 项失败 ❌\n`)
  try { rmSync(dataDir, { recursive: true, force: true }) } catch {}
  cleanup(); process.exit(failures ? 1 : 0)
}
main().catch((e) => { console.error(e); cleanup(); process.exit(1) })
