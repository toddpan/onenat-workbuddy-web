#!/usr/bin/env node
/**
 * AI 令牌通道大文件附件（≤2GB 分片直传）端到端验证：
 *   node scripts/attachment-ai-token-e2e.mjs
 *
 * 验证面（全程不带登录 Cookie，只用 AI 令牌）：
 *   1. AI 令牌可建任务（POST /api/tasks）
 *   2. 工具通道 workbuddy_file_manage {action:"upload_resumable_init"} 下发分片端点
 *   3. AI 令牌直发分片 PUT / status GET / complete POST（此前开放面未放行 resumable 子路径）
 *   4. complete 后文件中继到节点工作区并登记 task.attachments
 *   5. MCP JSON-RPC 通道同样可调 upload_resumable_init（免会话头宽松模式）
 *   6. 负例：无令牌 401 / 超 2GB init 拒绝 / offset 不匹配 409
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

let sawFileUpload = false
let uploadedSize = 0
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
      res.end(JSON.stringify({ ok: true, data: { sessionId: 'stub-s1', cwd: '/tmp/att-ai-ws' } }))
      return
    }
    // complete 对旧版节点（无 /files/resumable）的 multipart 降级路径
    if (req.method === 'POST' && url === '/api/v1/sessions/stub-s1/files') {
      sawFileUpload = true
      const body = Buffer.concat(chunks)
      const m = /filename="([^"]+)"/.exec(body.toString('utf-8')) || []
      uploadedSize = body.length
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, data: { files: [{ name: m[1] || 'file.bin', path: m[1] || 'file.bin', size: uploadedSize }] } }))
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
  const dataDir = mkdtempSync(join(tmpdir(), 'workbuddy-att-ai-e2e-'))
  console.log(`\n== AI 令牌大文件附件（分片直传 ≤2GB）E2E ==\n`)
  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r))
  const server = spawn(process.execPath, [join(ROOT, 'dist', 'server.js'), '--port', String(PORT), '--data', dataDir, '--token', AI_TOKEN, '--quiet'],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] })
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))
  procs.push(server)
  await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok, 'server 就绪')

  // 1. AI 令牌建任务（节点直发）
  const taskRes = await req('POST', `${PREFIX}/api/tasks`, {
    title: 'att-ai e2e', mode: 'chat',
    nodeRef: { kind: 'direct', apiBaseUrl: `http://127.0.0.1:${STUB_PORT}/api/v1` },
  })
  const taskId = taskRes.json?.data?.id
  check('AI 令牌创建任务', Boolean(taskId), `status=${taskRes.status} err=${taskRes.json?.error || ''}`)
  await req('POST', `${PREFIX}/api/tasks/${taskId}/messages`, { message: '建立会话' })
  await sleep(2000)

  // 1.5 工具通道 create 不带 message → draft 草稿态 + 「先传附件再 send」引导回执
  const draftRes = await req('POST', `${PREFIX}/api/tools/workbuddy_task_manage`, { action: 'create', title: 'e2e-draft-引导', mode: 'chat' })
  const draft = draftRes.json?.result
  check('create 不带 message = draft 未执行', draft?.ok === true && draft?.status === 'draft' && draft?.running === false, JSON.stringify(draft || {}).slice(0, 140))
  check('draft 回执引导先传附件再 send', /draft/.test(draft?.receipt || '') && /upload_resumable_init/.test(draft?.nextAction || ''), String(draft?.nextAction || '').slice(0, 120))
  if (draft?.taskId) {
    const draftInit = await req('POST', `${PREFIX}/api/tools/workbuddy_file_manage`, { action: 'upload_resumable_init', taskId: draft.taskId, name: 'draft.log', size: 1 })
    check('draft 任务 init 无警示', draftInit.json?.result?.taskStatus === 'draft' && !draftInit.json?.result?.warning, JSON.stringify(draftInit.json?.result || {}).slice(0, 100))
    await req('DELETE', `${PREFIX}/api/tasks/${draft.taskId}`)
  }

  // 2. 工具通道 upload_resumable_init
  const CHUNK1 = Buffer.from('hello-log-part1;')
  const CHUNK2 = Buffer.from('hello-log-part2')
  const total = CHUNK1.length + CHUNK2.length
  const initRes = await req('POST', `${PREFIX}/api/tools/workbuddy_file_manage`, {
    action: 'upload_resumable_init', taskId, name: 'app.log', size: total, mimeType: 'text/plain',
  })
  const init = initRes.json?.result
  check('工具通道 init 成功', init?.ok === true && Boolean(init?.uploadId), `status=${initRes.status} ${JSON.stringify(initRes.json || {}).slice(0, 160)}`)
  check('init 返回分片大小上限 8MB', init?.chunkBytes === 8 * 1024 * 1024)
  check('init 回显任务状态', typeof init?.taskStatus === 'string' && init.taskStatus !== 'draft', `taskStatus=${init?.taskStatus}`)
  check('非 draft 任务 init 带警示', typeof init?.warning === 'string' && /draft/.test(init.warning), String(init?.warning || '').slice(0, 100))
  check('init 下发 chunk/complete 端点', Boolean(init?.endpoints?.chunk?.url) && String(init?.endpoints?.complete?.url || '').endsWith('/complete'),
    JSON.stringify(init?.endpoints || {}).slice(0, 200))
  check('端点带服务前缀', String(init?.endpoints?.chunk?.url || '').includes(`${PREFIX}/api/tasks/`))
  check('端点跟随请求基址（非 consoleUrl 本地视角）', String(init?.endpoints?.chunk?.url || '').startsWith(`${BASE}${PREFIX}/api/tasks/`), init?.endpoints?.chunk?.url)
  const uploadId = init?.uploadId
  const chunkUrl = `${PREFIX}/api/tasks/${taskId}/attachments/resumable/${uploadId}`

  // 3. 负例：无令牌被拒
  const noAuth = await fetch(`${BASE}${chunkUrl}?offset=0`, { method: 'PUT', body: CHUNK1 })
  check('无令牌分片 PUT 被拒', noAuth.status === 401, `status=${noAuth.status}`)

  // 4. AI 令牌分片直传（两片 + 错误 offset 对账）
  const put1 = await fetch(`${BASE}${chunkUrl}?offset=0`, { method: 'PUT', headers: { 'X-WorkBuddy-Token': AI_TOKEN }, body: CHUNK1 })
  check('分片1 PUT 成功', put1.ok, `status=${put1.status}`)
  const putBad = await fetch(`${BASE}${chunkUrl}?offset=0`, { method: 'PUT', headers: { 'X-WorkBuddy-Token': AI_TOKEN }, body: CHUNK2 })
  const putBadJson = await putBad.json().catch(() => ({}))
  check('offset 不匹配回 409', putBad.status === 409 && putBadJson?.data?.received === CHUNK1.length, `status=${putBad.status} received=${putBadJson?.data?.received}`)
  const st = await req('GET', chunkUrl)
  check('status GET 已接收字节数', st.json?.data?.received === CHUNK1.length && st.json?.data?.name === 'app.log', JSON.stringify(st.json || {}).slice(0, 120))
  const put2 = await fetch(`${BASE}${chunkUrl}?offset=${CHUNK1.length}`, { method: 'PUT', headers: { 'X-WorkBuddy-Token': AI_TOKEN }, body: CHUNK2 })
  check('分片2 PUT 成功', put2.ok, `status=${put2.status}`)

  // 5. 工具通道 upload_resumable_status
  const stTool = await req('POST', `${PREFIX}/api/tools/workbuddy_file_manage`, { action: 'upload_resumable_status', taskId, uploadId })
  check('工具通道 status 对账', stTool.json?.result?.received === total, JSON.stringify(stTool.json?.result || {}).slice(0, 120))

  // 6. complete：异步受理（立即返回 accepted/relaying）→ 轮询任务附件确认后台中继落盘
  const done = await req('POST', `${chunkUrl}/complete`, {})
  check('complete 异步受理', done.json?.ok === true && done.json?.data?.accepted === true && done.json?.data?.relaying === true, `status=${done.status} ${JSON.stringify(done.json || {}).slice(0, 140)}`)
  let atts = []
  for (let i = 0; i < 40 && !atts.length; i++) {
    await new Promise(r => setTimeout(r, 500))
    const d = await req('GET', `${PREFIX}/api/tasks/${taskId}`)
    atts = (d.json?.data?.attachments || []).filter(a => a.name === 'app.log')
  }
  check('后台中继落盘（附件登记 = 1）', atts.length === 1, JSON.stringify(atts).slice(0, 140))
  check('返回落盘路径', Boolean(atts[0]?.path), atts[0]?.path)
  check('stub 节点收到文件', sawFileUpload && uploadedSize > 0, `uploadedSize=${uploadedSize}`)

  // 6.5 防重入：成功后重复 complete 不得产生第二份附件（中继锁的最终态校验）
  const reDone = await req('POST', `${chunkUrl}/complete`, {})
  check('成功后重复 complete 被拒（暂存已清）', reDone.status === 409 && /不存在|清理|中继/.test(reDone.json?.error || ''), `status=${reDone.status} err=${reDone.json?.error}`)

  // 7. 负例：超 2GB init 拒绝
  const tooBig = await req('POST', `${PREFIX}/api/tools/workbuddy_file_manage`, {
    action: 'upload_resumable_init', taskId, name: 'huge.log', size: 2 * 1024 * 1024 * 1024 + 1,
  })
  check('超 2GB init 被拒', tooBig.json?.result?.ok === false && /2GB/.test(tooBig.json?.result?.error || ''), JSON.stringify(tooBig.json?.result || {}).slice(0, 120))

  // 8. MCP JSON-RPC 通道同工具（免会话头宽松模式）
  const mcp = await fetch(`${BASE}${PREFIX}/mcp`, {
    method: 'POST',
    headers: { ...AI_H, Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workbuddy_file_manage', arguments: { action: 'upload_resumable_status', taskId, uploadId: 'nonexistent' } } }),
  })
  const mcpJson = await mcp.json().catch(() => ({}))
  const mcpText = mcpJson?.result?.content?.[0]?.text
  let mcpParsed; try { mcpParsed = JSON.parse(mcpText) } catch { mcpParsed = undefined }
  check('MCP 通道可调 upload_resumable_status', mcp.ok && mcpParsed?.ok === false && /不存在/.test(mcpParsed?.error || ''), `status=${mcp.status} ${String(mcpText).slice(0, 120)}`)

  console.log(failures === 0 ? '\n全部通过 ✅\n' : `\n${failures} 项失败 ❌\n`)
  try { rmSync(dataDir, { recursive: true, force: true }) } catch {}
  cleanup()
  process.exit(failures === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); cleanup(); process.exit(1) })
