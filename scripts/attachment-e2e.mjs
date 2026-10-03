#!/usr/bin/env node
/**
 * 附件上传（节点直发任务 __node__ 目标）端到端验证：
 *   node scripts/attachment-e2e.mjs
 * 复现原 bug：无成员任务发消息建立 __node__ 会话后上传附件，
 * 修复前 complete 返回 results 空 → 客户端拿不到路径；修复后应 ok 且文件登记。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.ATT_E2E_PORT || 18094)
const STUB_PORT = Number(process.env.ATT_E2E_STUB_PORT || 18098)
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

let sawFileUpload = false
const stub = createServer((req, res) => {
  const url = req.url || ''
  let chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    if (req.method === 'POST' && url === '/api/v1/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, data: { sessionId: 'stub-s1' } }))
      return
    }
    if (req.method === 'GET' && url === '/api/v1/sessions/stub-s1') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, data: { sessionId: 'stub-s1', cwd: '/tmp/att-ws' } }))
      return
    }
    if (req.method === 'POST' && url === '/api/v1/sessions/stub-s1/files') {
      sawFileUpload = true
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, data: { files: [{ name: 'test.bin', path: 'test.bin', size: 5 }] } }))
      return
    }
    if (req.method === 'POST' && url === '/api/v1/sessions/stub-s1/prompt-stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('event: delta\ndata: {"delta":"ok"}\n\n')
      res.write('event: turn_end\ndata: {}\n\n')
      res.write('event: done\ndata: {}\n\n')
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
async function req(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(COOKIE ? { Cookie: COOKIE } : {}), ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)),
  })
  const text = await res.text()
  let json; try { json = JSON.parse(text) } catch { json = undefined }
  return { status: res.status, json }
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'workbuddy-att-e2e-'))
  console.log(`\n== 附件上传 E2E（__node__ 节点直发） ==\n`)
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

  // 无成员、节点直发任务（对齐线上主会话形态）
  const taskRes = await req('POST', `${PREFIX}/api/tasks`, {
    title: 'att e2e', mode: 'chat',
    nodeRef: { kind: 'direct', apiBaseUrl: `http://127.0.0.1:${STUB_PORT}/api/v1` },
  })
  const taskId = taskRes.json?.data?.id
  check('创建节点直发任务', Boolean(taskId), `status=${taskRes.status} err=${taskRes.json?.error || ''}`)
  const detail0 = await req('GET', `${PREFIX}/api/tasks/${taskId}`)
  const memberIds = detail0.json?.data?.memberAgentIds || []
  console.log(`   memberAgentIds=${JSON.stringify(memberIds)}（应为空，否则走不到 __node__ 分支）`)

  // 发一条消息建立 __node__ 会话
  await req('POST', `${PREFIX}/api/tasks/${taskId}/messages`, { message: '建立会话' })
  await sleep(2500)
  const detail1 = await req('GET', `${PREFIX}/api/tasks/${taskId}`)
  const hasNode = Boolean(detail1.json?.data?.sessions?.__node__?.remoteSessionId)
  check('__node__ 会话已建立', hasNode, JSON.stringify(Object.keys(detail1.json?.data?.sessions || {})))
  if (!hasNode) { console.log('\n❌ 前置条件不满足，无法验证 __node__ 上传\n'); cleanup(); process.exit(1) }

  // 分片上传附件
  const init = await req('POST', `${PREFIX}/api/tasks/${taskId}/attachments/resumable/init`, { name: 'test.bin', size: 5, mimeType: 'application/octet-stream' })
  const uploadId = init.json?.data?.uploadId
  check('resumable init', Boolean(uploadId), JSON.stringify(init.json || {}).slice(0, 120))
  const putRes = await fetch(`${BASE}${PREFIX}/api/tasks/${taskId}/attachments/resumable/${uploadId}?offset=0`, {
    method: 'PUT', headers: { Cookie: COOKIE, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('hello'),
  })
  check('resumable chunk', putRes.ok, `status=${putRes.status}`)
  const done = await req('POST', `${PREFIX}/api/tasks/${taskId}/attachments/resumable/${uploadId}/complete`, {})
  const results = done.json?.data?.results || []
  check('complete 返回非空 results（原 bug 为空）', results.length > 0, JSON.stringify(done.json || {}).slice(0, 160))
  check('上传结果 ok=true', results[0]?.ok === true, `error=${results[0]?.error || ''}`)
  check('返回文件路径', Boolean(results[0]?.files?.[0]?.path), JSON.stringify(results[0]?.files || []))
  check('stub 节点确实收到文件上传请求', sawFileUpload)
  const detail2 = await req('GET', `${PREFIX}/api/tasks/${taskId}`)
  check('任务附件登记 = 1', (detail2.json?.data?.attachments || []).length === 1)

  console.log(failures === 0 ? '\n全部通过 ✅\n' : `\n${failures} 项失败 ❌\n`)
  try { rmSync(dataDir, { recursive: true, force: true }) } catch {}
  cleanup()
  process.exit(failures === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); cleanup(); process.exit(1) })
