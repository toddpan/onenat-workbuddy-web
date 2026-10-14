#!/usr/bin/env node
/**
 * 附件 P2P 直传端到端验证（控制台会话通道）：
 *   node scripts/attachment-e2e.mjs
 * 流程：登录 → 节点直发任务 → REST direct/init 拿节点直连配方 → 直连节点分片上传 →
 *       节点 complete 得落盘路径 → direct/register 登记 → 任务附件含跨节点下载 URL → 凭 URL+密钥下载比对。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.ATT_E2E_PORT || 18094)
const STUB_PORT = Number(process.env.ATT_E2E_STUB_PORT || 18098)
const PREFIX = '/onenat-workbuddy'
const BASE = `http://127.0.0.1:${PORT}`
const NODE_KEY = 'stub-node-key'

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  if (!ok) failures++
  console.log(`${ok ? '  ✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
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

let sawNodeComplete = false
const nodeUps = new Map()
const wsFiles = new Map()
const stub = createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://x')
  const p = u.pathname
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (p === '/api/v1/fs/download') {
      if ((req.headers.authorization || '') !== `Bearer ${NODE_KEY}`) return json(401, { ok: false, error: 'auth' })
      const buf = wsFiles.get(u.searchParams.get('path') || '')
      if (!buf) return json(404, { ok: false, error: 'not found' })
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(buf); return
    }
    const m = /^\/api\/v1\/sessions\/([^/]+)\/files\/resumable(?:\/([^/]+)(\/complete)?)?$/.exec(p)
    if (m) {
      if (req.method === 'POST' && !m[2]) {
        const nid = 'nid-' + String(nodeUps.size + 1).padStart(3, '0')
        nodeUps.set(nid, { name: u.searchParams.get('name') || 'file', received: 0, chunks: [] })
        return json(200, { ok: true, data: { uploadId: nid, received: 0 } })
      }
      if (m[2] && !m[3] && req.method === 'PUT') {
        const up = nodeUps.get(m[2]); if (!up) return json(404, { ok: false, error: 'no such' })
        const offset = Number(u.searchParams.get('offset'))
        if (offset !== up.received) return json(409, { ok: false, data: { received: up.received } })
        const body = Buffer.concat(chunks); up.chunks.push(body); up.received += body.length
        return json(200, { ok: true, data: { received: up.received } })
      }
      if (m[2] && m[3] && req.method === 'POST') {
        sawNodeComplete = true
        const up = nodeUps.get(m[2]); if (!up) return json(404, { ok: false, error: 'no such' })
        const path = '/ws/' + up.name
        wsFiles.set(path, Buffer.concat(up.chunks))
        return json(200, { ok: true, data: { files: [{ name: up.name, path, size: up.received }] } })
      }
    }
    if (req.method === 'POST' && p === '/api/v1/sessions') return json(200, { ok: true, data: { sessionId: 'stub-s1' } })
    if (req.method === 'GET' && p === '/api/v1/sessions/stub-s1') return json(200, { ok: true, data: { sessionId: 'stub-s1', cwd: '/tmp/att-ws' } })
    if (req.method === 'POST' && p === '/api/v1/sessions/stub-s1/prompt-stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('event: delta\ndata: {"delta":"ok"}\n\n'); res.write('event: turn_end\ndata: {}\n\n'); res.write('event: done\ndata: {}\n\n'); res.end(); return
    }
    return json(404, { ok: false, error: 'Endpoint not found' })
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
  console.log(`\n== 附件 P2P 直传 E2E（控制台会话） ==\n`)
  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r))
  const server = spawn(process.execPath, [join(ROOT, 'dist', 'server.js'), '--port', String(PORT), '--data', dataDir, '--quiet'],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] })
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))
  procs.push(server)
  await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok, 'server 就绪')

  const loginRes = await fetch(`${BASE}${PREFIX}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'workbuddy', password: 'workbuddy-admin' }),
  })
  COOKIE = (loginRes.headers.get('set-cookie') || '').split(';')[0]
  check('登录成功', loginRes.ok)

  const taskRes = await req('POST', `${PREFIX}/api/tasks`, { title: 'p2p console e2e', mode: 'chat', nodeRef: { kind: 'direct', apiBaseUrl: `http://127.0.0.1:${STUB_PORT}/api/v1` } })
  const taskId = taskRes.json?.data?.id
  check('创建节点直发任务', Boolean(taskId))
  await req('POST', `${PREFIX}/api/tasks/${taskId}/messages`, { message: '建立会话' })
  await sleep(2000)

  const init = await req('POST', `${PREFIX}/api/tasks/${taskId}/attachments/direct/init`, { name: 'test.bin', size: 5, mimeType: 'application/octet-stream' })
  const d = init.json?.data
  check('direct/init 下发直传配方', init.json?.ok === true && String(d?.target?.baseUrl || '').includes(String(STUB_PORT)) && typeof d?.target?.apiKey === 'string' && Boolean(d?.target?.sessionId), JSON.stringify(init.json || {}).slice(0, 140))

  const nk = { Authorization: `Bearer ${NODE_KEY}`, 'Content-Type': 'application/octet-stream' }
  const nInit = await (await fetch(`${d.target.baseUrl}/sessions/${d.target.sessionId}/files/resumable?name=test.bin&size=5`, { method: 'POST', headers: { Authorization: `Bearer ${NODE_KEY}` } })).json()
  const nid = nInit?.data?.uploadId
  const chunkUrl = `${d.target.baseUrl}/sessions/${d.target.sessionId}/files/resumable/${nid}`
  await fetch(`${chunkUrl}?offset=0`, { method: 'PUT', headers: nk, body: Buffer.from('hello') })
  const nDone = await (await fetch(`${chunkUrl}/complete`, { method: 'POST', headers: { Authorization: `Bearer ${NODE_KEY}` } })).json()
  const nodePath = nDone?.data?.files?.[0]?.path
  check('直连节点分片上传+complete', sawNodeComplete && nodePath === '/ws/test.bin', JSON.stringify(nDone).slice(0, 120))

  const reg = await req('POST', `${PREFIX}/api/tasks/${taskId}/attachments/direct/register`, { uploadId: d.uploadId, path: nodePath, size: 5 })
  check('register 登记成功', reg.json?.ok === true && Boolean(reg.json?.data?.attachment?.downloadUrl), JSON.stringify(reg.json || {}).slice(0, 140))

  const detail = await req('GET', `${PREFIX}/api/tasks/${taskId}`)
  const atts = detail.json?.data?.attachments || []
  check('任务附件登记 = 1（含节点定位）', atts.length === 1 && atts[0].source === 'direct' && atts[0].nodeBaseUrl?.includes(String(STUB_PORT)))

  const dl = await fetch(reg.json.data.attachment.downloadUrl, { headers: { Authorization: `Bearer ${NODE_KEY}` } })
  const dlBuf = Buffer.from(await dl.arrayBuffer())
  check('跨节点下载（URL+密钥）内容一致', dl.status === 200 && dlBuf.toString() === 'hello', `status=${dl.status}`)

  console.log(failures === 0 ? '\n全部通过 ✅\n' : `\n${failures} 项失败 ❌\n`)
  try { rmSync(dataDir, { recursive: true, force: true }) } catch {}
  cleanup()
  process.exit(failures === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); cleanup(); process.exit(1) })
