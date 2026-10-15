#!/usr/bin/env node
/**
 * 附件 P2P 直传端到端验证（AI 令牌通道）：
 *   node scripts/attachment-ai-token-e2e.mjs
 *
 * 架构（2026-10-14 P2P 重构）：workbuddy 只做控制面——
 *   init 下发 DSH 节点直连配方（地址+apiKey+会话+分片端点模板）→
 *   调用方直连节点（节点 init → 分片 PUT（409 对账）→ 节点 complete 得落盘路径）→
 *   upload_register 登记附件（返回跨节点下载 URL）→ 下载方凭 URL+节点密钥取文件（DSH↔DSH 点对点）。
 * 文件字节全程不经 workbuddy（旧暂存中继已删除）。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.ATT_AI_E2E_PORT || 18096)
const STUB_PORT = Number(process.env.ATT_AI_E2E_STUB_PORT || 18099)
const PREFIX = '/onenat-workbuddy'
const BASE = `http://127.0.0.1:${PORT}`
const AI_TOKEN = 'att-e2e-ai-token'
const NODE_KEY = 'stub-node-key'
const AI_H = { 'X-WorkBuddy-Token': AI_TOKEN, 'Content-Type': 'application/json' }

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

// ---------- stub DSH 节点（模拟 dsh-web-service：会话/直传 resumable/下载） ----------
let sawNodeInit = false, sawNodeComplete = false, sawMultipart = false
const nodeUps = new Map()   // nid -> { name, size, received, chunks: Buffer[] }
const wsFiles = new Map()   // abs path -> Buffer
const SSE_OK = (res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('event: delta\ndata: {"delta":"ok"}\n\n'); res.write('event: turn_end\ndata: {}\n\n'); res.write('event: done\ndata: {}\n\n'); res.end() }

const stub = createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://x')
  const p = u.pathname
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    // CORS 模拟（真实节点已验证支持，浏览器直传依赖）
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept')
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
    // 下载接口要求 Bearer 节点密钥（对齐真实节点）
    if (p === '/api/v1/fs/download' || p.endsWith('/files/download')) {
      if ((req.headers.authorization || '') !== `Bearer ${NODE_KEY}`) return json(401, { ok: false, error: 'Invalid or missing API key' })
      const fp = u.searchParams.get('path') || ''
      const buf = wsFiles.get(fp)
      if (!buf) return json(404, { ok: false, error: 'file not found: ' + fp })
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      res.end(buf)
      return
    }
    // 分片直传协议
    const m = /^\/api\/v1\/sessions\/([^/]+)\/files\/resumable(?:\/([^/]+)(\/complete)?)?$/.exec(p)
    if (m) {
      if (req.method === 'POST' && !m[2]) {
        sawNodeInit = true
        const nid = 'nid-' + String(nodeUps.size + 1).padStart(3, '0')
        nodeUps.set(nid, { name: u.searchParams.get('name') || 'file', size: Number(u.searchParams.get('size')) || 0, received: 0, chunks: [] })
        return json(200, { ok: true, data: { uploadId: nid, received: 0 } })
      }
      if (m[2] && !m[3] && req.method === 'PUT') {
        const up = nodeUps.get(m[2])
        if (!up) return json(404, { ok: false, error: 'no such uploadId' })
        const offset = Number(u.searchParams.get('offset'))
        if (offset !== up.received) return json(409, { ok: false, error: 'offset mismatch', data: { received: up.received } })
        const body = Buffer.concat(chunks)
        up.chunks.push(body); up.received += body.length
        return json(200, { ok: true, data: { received: up.received } })
      }
      if (m[2] && !m[3] && req.method === 'GET') {
        const up = nodeUps.get(m[2])
        if (!up) return json(404, { ok: false, error: 'no such uploadId' })
        return json(200, { ok: true, data: { received: up.received } })
      }
      if (m[2] && m[3] && req.method === 'POST') {
        sawNodeComplete = true
        const up = nodeUps.get(m[2])
        if (!up) return json(404, { ok: false, error: 'no such uploadId' })
        const path = '/ws/' + up.name
        wsFiles.set(path, Buffer.concat(up.chunks))
        return json(200, { ok: true, data: { files: [{ name: up.name, path, size: up.received }] } })
      }
    }
    // 会话与小文件 multipart（uploadAttachments 路径）
    if (req.method === 'POST' && p === '/api/v1/sessions') return json(200, { ok: true, data: { sessionId: 'stub-s1' } })
    if (req.method === 'GET' && p === '/api/v1/sessions/stub-s1') return json(200, { ok: true, data: { sessionId: 'stub-s1', cwd: '/tmp/p2p-ws' } })
    if (req.method === 'POST' && p === '/api/v1/sessions/stub-s1/files') { sawMultipart = true; return json(200, { ok: true, data: { files: [{ name: 'f.bin', path: '/ws/f.bin', size: Buffer.concat(chunks).length }] } }) }
    if (req.method === 'POST' && p === '/api/v1/sessions/stub-s1/prompt-stream') return SSE_OK(res)
    return json(404, { ok: false, error: 'Endpoint not found' })
  })
})

const procs = []
function cleanup() { try { stub.close() } catch {} for (const p of procs) { try { p.kill('SIGKILL') } catch {} } }
process.on('exit', cleanup)

async function req(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...AI_H, ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)),
  })
  const text = await res.text()
  let json; try { json = JSON.parse(text) } catch { json = undefined }
  return { status: res.status, json }
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'workbuddy-p2p-e2e-'))
  console.log(`\n== 附件 P2P 直传 E2E（AI 令牌通道） ==\n`)
  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r))
  const server = spawn(process.execPath, [join(ROOT, 'dist', 'server.js'), '--port', String(PORT), '--data', dataDir, '--token', AI_TOKEN, '--quiet'],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] })
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))
  procs.push(server)
  await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok, 'server 就绪')

  const STUB_BASE = `http://127.0.0.1:${STUB_PORT}/api/v1`

  // 1. 建任务（draft，不带 message）
  const taskRes = await req('POST', `${PREFIX}/api/tasks`, { title: 'p2p e2e', mode: 'chat', nodeRef: { kind: 'direct', apiBaseUrl: STUB_BASE } })
  const taskId = taskRes.json?.data?.id
  check('AI 令牌创建任务', Boolean(taskId), `status=${taskRes.status}`)
  await req('POST', `${PREFIX}/api/tasks/${taskId}/messages`, { message: '建立会话' })
  await sleep(2000)

  // 2. draft 引导 + init 配方
  const draftRes = await req('POST', `${PREFIX}/api/tools/workbuddy_task_manage`, { action: 'create', title: 'e2e-draft-引导', mode: 'chat', nodeRef: { kind: 'direct', apiBaseUrl: STUB_BASE } })
  const draft = draftRes.json?.result
  check('create 不带 message = draft 未执行', draft?.ok === true && draft?.status === 'draft' && draft?.running === false)
  if (draft?.taskId) {
    const dInit = await req('POST', `${PREFIX}/api/tools/workbuddy_file_manage`, { action: 'upload_resumable_init', taskId: draft.taskId, name: 'd.log', size: 1 })
    check('draft 任务 init 无警示且下发直传配方', dInit.json?.result?.taskStatus === 'draft' && !dInit.json?.result?.warning && Boolean(dInit.json?.result?.direct?.baseUrl), JSON.stringify(dInit.json?.result || {}).slice(0, 120))
    await req('DELETE', `${PREFIX}/api/tasks/${draft.taskId}`)
  }

  // 3. init：直传配方
  const CHUNK1 = Buffer.from('p2p-part1;'); const CHUNK2 = Buffer.from('p2p-part2')
  const total = CHUNK1.length + CHUNK2.length
  const initRes = await req('POST', `${PREFIX}/api/tools/workbuddy_file_manage`, { action: 'upload_resumable_init', taskId, name: 'app.log', size: total, mimeType: 'text/plain' })
  const init = initRes.json?.result
  check('init 下发直传配方（baseUrl/sessionId/uploadId）', init?.ok === true && String(init?.direct?.baseUrl).includes(String(STUB_PORT)) && typeof init?.direct?.apiKey === 'string' && Boolean(init?.direct?.sessionId) && String(init?.uploadId || '').startsWith('dup-'),
    JSON.stringify(init || {}).slice(0, 160))
  check('init 端点模板指向节点 resumable 协议', String(init?.direct?.endpoints?.init?.url || '').includes('/files/resumable?name='))
  const upId = init?.uploadId

  // 4. 负例：无令牌 / 超 2GB
  const noAuth = await fetch(`${BASE}${PREFIX}/api/tasks/${taskId}/attachments/direct/init`, { method: 'POST' })
  check('无令牌 direct init 被拒', noAuth.status === 401, `status=${noAuth.status}`)
  const tooBig = await req('POST', `${PREFIX}/api/tools/workbuddy_file_manage`, { action: 'upload_resumable_init', taskId, name: 'huge.log', size: 2 * 1024 * 1024 * 1024 + 1 })
  check('超 2GB init 被拒', tooBig.json?.result?.ok === false && /2GB/.test(tooBig.json?.result?.error || ''))

  // 5. 直连节点上传：节点 init → 分片（409 对账）→ complete
  const nk = { 'Authorization': `Bearer ${init?.direct?.apiKey || ''}`, 'Content-Type': 'application/octet-stream' }
  const nInitRes = await fetch(`${STUB_BASE}/sessions/stub-s1/files/resumable?name=app.log&size=${total}&mimeType=text/plain`, { method: 'POST', headers: { Authorization: `Bearer ${NODE_KEY}` } })
  const nInit = await nInitRes.json()
  const nid = nInit?.data?.uploadId
  check('节点侧 init（直连）', Boolean(nid), JSON.stringify(nInit).slice(0, 100))
  const chunkUrl = `${STUB_BASE}/sessions/stub-s1/files/resumable/${nid}`
  const p1 = await fetch(`${chunkUrl}?offset=0`, { method: 'PUT', headers: nk, body: CHUNK1 })
  check('分片1 直连节点 PUT', p1.ok, `status=${p1.status}`)
  const pBad = await fetch(`${chunkUrl}?offset=0`, { method: 'PUT', headers: nk, body: CHUNK2 })
  const pBadJson = await pBad.json().catch(() => ({}))
  check('offset 不匹配节点回 409（带已收字节）', pBad.status === 409 && pBadJson?.data?.received === CHUNK1.length)
  const p2 = await fetch(`${chunkUrl}?offset=${CHUNK1.length}`, { method: 'PUT', headers: nk, body: CHUNK2 })
  check('分片2 直连节点 PUT', p2.ok)
  const nDone = await (await fetch(`${chunkUrl}/complete`, { method: 'POST', headers: { Authorization: `Bearer ${NODE_KEY}` } })).json()
  const nodePath = nDone?.data?.files?.[0]?.path
  check('节点侧 complete 返回落盘路径', sawNodeComplete && nodePath === '/ws/app.log', JSON.stringify(nDone).slice(0, 120))

  // 6. register 登记附件（返回跨节点下载 URL）
  const reg = await req('POST', `${PREFIX}/api/tools/workbuddy_file_manage`, { action: 'upload_register', taskId, uploadId: upId, path: nodePath, size: total })
  const regR = reg.json?.result
  check('register 登记成功', regR?.ok === true && regR?.attachment?.path === nodePath, JSON.stringify(regR || {}).slice(0, 140))
  check('返回跨节点下载 URL（指向节点 /fs/download）', String(regR?.downloadUrl || '').includes(`/api/v1/fs/download?path=`), regR?.downloadUrl)
  const reReg = await req('POST', `${PREFIX}/api/tools/workbuddy_file_manage`, { action: 'upload_register', taskId, uploadId: upId, path: nodePath })
  check('同 uploadId 二次登记被拒', reReg.json?.result?.ok === false, reReg.json?.result?.error)

  // 7. P2P 跨节点下载（URL + 节点密钥）
  const dl = await fetch(regR.downloadUrl, { headers: { Authorization: `Bearer ${NODE_KEY}` } })
  const dlBuf = Buffer.from(await dl.arrayBuffer())
  check('凭 URL+密钥下载成功且字节一致', dl.status === 200 && dlBuf.equals(Buffer.concat([CHUNK1, CHUNK2])), `status=${dl.status} size=${dlBuf.length}`)
  const dlNoKey = await fetch(regR.downloadUrl)
  check('下载无密钥被拒（401）', dlNoKey.status === 401, `status=${dlNoKey.status}`)
  const detail = await req('GET', `${PREFIX}/api/tasks/${taskId}`)
  const atts = detail.json?.data?.attachments || []
  check('任务附件登记 = 1（含 nodeBaseUrl）', atts.length === 1 && atts[0].nodeBaseUrl?.includes(String(STUB_PORT)) && atts[0].source === 'direct', JSON.stringify(atts).slice(0, 140))

  // 8. 非 draft 警示（任务已执行过一轮）
  const reInit = await req('POST', `${PREFIX}/api/tools/workbuddy_file_manage`, { action: 'upload_resumable_init', taskId, name: 'late.log', size: 1 })
  check('非 draft 任务 init 带警示', typeof reInit.json?.result?.warning === 'string', String(reInit.json?.result?.warning || '').slice(0, 80))

  // 8.5 流式代理回退（浏览器混合内容场景）：文件体直接 POST 给 workbuddy，服务端边收边转发节点（不落盘）
  const init2 = await req('POST', `${PREFIX}/api/tools/workbuddy_file_manage`, { action: 'upload_resumable_init', taskId, name: 'relay.log', size: 10, mimeType: 'text/plain' })
  const up2 = init2.json?.result?.uploadId
  const relay = await fetch(`${BASE}${PREFIX}/api/tasks/${taskId}/attachments/direct/relay?uploadId=${encodeURIComponent(up2)}`, {
    method: 'POST', headers: { 'X-WorkBuddy-Token': AI_TOKEN, 'Content-Type': 'application/octet-stream' }, body: Buffer.from('relaybytes'),
  })
  const relayJson = await relay.json().catch(() => ({}))
  check('流式代理受理成功', relay.status === 200 && relayJson?.data?.accepted === true && (relayJson?.data?.attachment?.path || '').endsWith('/relay.log'), JSON.stringify([relay.status, relayJson?.data?.accepted, relayJson?.data?.attachment?.path]))
  const dl2 = await fetch(relayJson?.data?.attachment?.downloadUrl, { headers: { Authorization: `Bearer ${NODE_KEY}` } })
  const dl2Buf = Buffer.from(await dl2.arrayBuffer())
  check('代理落盘文件可经下载 URL 取回且内容一致', dl2.status === 200 && dl2Buf.toString() === 'relaybytes', `status=${dl2.status}`)
  const detail2 = await req('GET', `${PREFIX}/api/tasks/${taskId}`)
  check('代理与直传附件并存（登记 = 2）', (detail2.json?.data?.attachments || []).length === 2)

  // 9. MCP 通道 init（免会话头宽松模式）
  const mcp = await fetch(`${BASE}${PREFIX}/mcp`, {
    method: 'POST', headers: { ...AI_H, Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workbuddy_file_manage', arguments: { action: 'upload_resumable_init', taskId, name: 'mcp.log', size: 1 } } }),
  })
  const mcpJson = await mcp.json().catch(() => ({}))
  let mcpParsed; try { mcpParsed = JSON.parse(mcpJson?.result?.content?.[0]?.text) } catch {}
  check('MCP 通道 init 返回直传配方', mcp.ok && mcpParsed?.ok === true && Boolean(mcpParsed?.direct?.baseUrl), String(mcpParsed?.error || '').slice(0, 80))

  console.log(failures === 0 ? '\n全部通过 ✅\n' : `\n${failures} 项失败 ❌\n`)
  try { rmSync(dataDir, { recursive: true, force: true }) } catch {}
  cleanup()
  process.exit(failures === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); cleanup(); process.exit(1) })
