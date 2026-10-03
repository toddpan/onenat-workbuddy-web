#!/usr/bin/env node
/**
 * OneNat WorkBuddy — 对外 MCP Server 接口冒烟测试（不依赖 DSH / ONENAT 真实环境）
 *
 *   npm run smoke:mcp
 *
 * 验收面：拉起 mock ONENAT + dist/server.js（临时数据目录 + AI 令牌）→ 走一遍标准 MCP
 * Streamable HTTP 全链路 → 断言 → 清理。退出码非 0 即失败。
 *
 * 覆盖：
 *  1. 鉴权：无令牌访问 /mcp → 401；错误令牌 → 401
 *  2. GET /mcp → 405（无服务端主动推送）；DELETE /mcp → 204 会话结束
 *  3. initialize 握手：协议版本 / serverInfo / Mcp-Session-Id 签发；SSE Accept 下以 event-stream 回包
 *  4. tools/list：与工具通道全量同步（数量一致、同名、inputSchema 存在）
 *  5. tools/call：真实调用 workbuddy_task_manage(list) 结构化回包；未知工具 → isError
 *  6. 幂等回放：同会话 + 同 JSON-RPC id + 同参数重复投递 → 不重复执行（/api/mcp/status 的 replays 递增）
 *  7. 未知方法 → -32601；会话校验：假会话 id → -32001
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.SMOKE_MCP_PORT || 18095)
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT || 18080)
const PREFIX = '/onenat-workbuddy'
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = 'smoke-mcp-token-0123456789abcdef'

const results = []
let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  if (!ok) failures++
  results.push(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function rawReq(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = undefined }
  return { status: res.status, text, json, headers: res.headers }
}

const authHeaders = (extra = {}) => ({ Authorization: `Bearer ${TOKEN}`, ...extra })

async function waitFor(cond, label, timeoutMs = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try { if (await cond()) return true } catch { /* retry */ }
    await sleep(200)
  }
  throw new Error(`等待超时: ${label}`)
}

// ---------------------------------------------------------------- 启动 mock ONENAT + 服务

const mock = spawn('node', [join(ROOT, 'scripts/mock-onenat.cjs')], {
  env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
  stdio: 'ignore',
})
const dataDir = mkdtempSync(join(tmpdir(), 'wb-mcp-smoke-'))
const app = spawn('node', [join(ROOT, 'dist/server.js'), '--port', String(PORT), '--quiet'], {
  env: {
    ...process.env,
    WORKBUDDY_HOME: dataDir,
    WORKBUDDY_TOKEN: TOKEN,
    ONENAT_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    ONENAT_API_KEY: 'smoke-mock-key',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let appLog = ''
app.stdout.on('data', (c) => { appLog += c })
app.stderr.on('data', (c) => { appLog += c })

async function main() {
  await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok, 'server up')
  await waitFor(async () => {
    const s = await rawReq('GET', `${PREFIX}/api/mcp/status`, undefined, authHeaders())
    return s.status === 200
  }, 'mcp status endpoint')

  console.log('\n== MCP Server 冒烟 ==\n')

  // 1. 鉴权
  const noAuth = await rawReq('POST', `${PREFIX}/mcp`, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  check('鉴权：无令牌 POST /mcp → 401', noAuth.status === 401, `status=${noAuth.status}`)
  const badAuth = await rawReq('POST', `${PREFIX}/mcp`, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { Authorization: 'Bearer wrong-token' })
  check('鉴权：错误令牌 POST /mcp → 401', badAuth.status === 401, `status=${badAuth.status}`)

  // 2. GET /mcp → 405
  const getMcp = await rawReq('GET', `${PREFIX}/mcp`, undefined, authHeaders())
  check('传输：GET /mcp → 405（无服务端推送）', getMcp.status === 405, `status=${getMcp.status}`)

  // 3. initialize 握手（JSON）
  const init = await rawReq('POST', `${PREFIX}/mcp`, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke-mcp', version: '0.0.1' } },
  }, authHeaders())
  const sessionId = init.headers.get('mcp-session-id') || ''
  check('initialize：200 + JSON-RPC result', init.status === 200 && init.json?.result, `status=${init.status}`)
  check('initialize：protocolVersion=2024-11-05', init.json?.result?.protocolVersion === '2024-11-05', String(init.json?.result?.protocolVersion))
  check('initialize：serverInfo.name=onenat-workbuddy', init.json?.result?.serverInfo?.name === 'onenat-workbuddy', String(init.json?.result?.serverInfo?.name))
  check('initialize：签发 Mcp-Session-Id', Boolean(sessionId), sessionId.slice(0, 8) + '…')
  check('initialize：capabilities.tools 开放', init.json?.result?.capabilities?.tools?.listChanged === false)

  // initialize（SSE Accept）→ text/event-stream 单帧回包
  const sseRes = await fetch(BASE + `${PREFIX}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...authHeaders() },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'sse-1', method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 'sse-client' } } }),
  })
  const sseText = await sseRes.text()
  const sseIsSse = (sseRes.headers.get('content-type') || '').includes('text/event-stream')
  const ssePayload = (() => { try { return JSON.parse(sseText.split('data: ')[1]) } catch { return undefined } })()
  check('initialize：SSE Accept → text/event-stream 回包', sseIsSse && ssePayload?.result?.serverInfo?.name === 'onenat-workbuddy', `ct=${sseRes.headers.get('content-type')}`)

  // 4. tools/list（需要会话头）
  const list = await rawReq('POST', `${PREFIX}/mcp`, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, authHeaders({ 'Mcp-Session-Id': sessionId }))
  const tools = list.json?.result?.tools || []
  const httpList = await rawReq('GET', `${PREFIX}/api/tools`, undefined, authHeaders())
  const httpTools = httpList.json?.tools || []
  check('tools/list：200 + 非空', list.status === 200 && tools.length > 0, `${tools.length} 个工具`)
  check('tools/list：与 HTTP 工具通道全量同步', tools.length === httpTools.length && httpTools.every((t) => tools.some((m) => m.name === t.name)), `mcp=${tools.length} http=${httpTools.length}`)
  check('tools/list：inputSchema 为 object 且含 required=[action]', tools.every((t) => t.inputSchema?.type === 'object' && Array.isArray(t.inputSchema?.required) && t.inputSchema.required.includes('action')))
  check('tools/list：会话管理工具在列（task_manage/task_chat/task_status）', ['workbuddy_task_manage', 'workbuddy_task_chat', 'workbuddy_task_status'].every((n) => tools.some((t) => t.name === n)))

  // 5. tools/call：真实调用（任务列表，无需真实 LLM）
  const call = await rawReq('POST', `${PREFIX}/mcp`, {
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'workbuddy_task_manage', arguments: { action: 'list' } },
  }, authHeaders({ 'Mcp-Session-Id': sessionId }))
  const callText = call.json?.result?.content?.[0]?.text || ''
  let callParsed
  try { callParsed = JSON.parse(callText) } catch { /* ignore */ }
  check('tools/call：200 + content[0].type=text', call.status === 200 && call.json?.result?.content?.[0]?.type === 'text')
  check('tools/call：workbuddy_task_manage(list) 结构化成功', callParsed?.ok === true, `isError=${call.json?.result?.isError} 前缀=${callText.slice(0, 60)}`)
  check('tools/call：isError=false', call.json?.result?.isError === false)

  // 未知工具 → isError
  const badCall = await rawReq('POST', `${PREFIX}/mcp`, {
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'workbuddy_not_exist', arguments: {} },
  }, authHeaders({ 'Mcp-Session-Id': sessionId }))
  check('tools/call：未知工具 → isError=true', badCall.json?.result?.isError === true, String(badCall.json?.result?.isError))

  // 6. 幂等回放：同会话 + 同 id + 同参数重复投递
  const replayPayload = { jsonrpc: '2.0', id: 'rp-1', method: 'tools/call', params: { name: 'workbuddy_task_manage', arguments: { action: 'list' } } }
  const r1 = await rawReq('POST', `${PREFIX}/mcp`, replayPayload, authHeaders({ 'Mcp-Session-Id': sessionId }))
  const statusMid = await rawReq('GET', `${PREFIX}/api/mcp/status`, undefined, authHeaders())
  const replaysMid = statusMid.json?.mcp?.replays ?? -1
  const r2 = await rawReq('POST', `${PREFIX}/mcp`, replayPayload, authHeaders({ 'Mcp-Session-Id': sessionId }))
  const statusEnd = await rawReq('GET', `${PREFIX}/api/mcp/status`, undefined, authHeaders())
  const replaysEnd = statusEnd.json?.mcp?.replays ?? -1
  check('幂等回放：重复投递应答一致', r1.status === 200 && r2.status === 200 && r2.json?.result?.content?.[0]?.text === r1.json?.result?.content?.[0]?.text)
  check('幂等回放：replays 计数递增（未重复执行）', replaysEnd === replaysMid + 1, `before=${replaysMid} after=${replaysEnd}`)
  check('状态端点：/api/mcp/status 暴露统计', typeof statusEnd.json?.mcp?.calls === 'number' && statusEnd.json?.mcp?.endpoint?.endsWith('/mcp'))

  // 7. 未知方法 / 假会话 / DELETE
  const unknown = await rawReq('POST', `${PREFIX}/mcp`, { jsonrpc: '2.0', id: 9, method: 'resources/read', params: { uri: 'file:///x' } }, authHeaders({ 'Mcp-Session-Id': sessionId }))
  check('未知方法：resources/read → -32000 未开放', unknown.json?.error?.code === -32000, JSON.stringify(unknown.json?.error))
  const notFound = await rawReq('POST', `${PREFIX}/mcp`, { jsonrpc: '2.0', id: 10, method: 'no/such/method' }, authHeaders({ 'Mcp-Session-Id': sessionId }))
  check('未知方法：-32601 Method not found', notFound.json?.error?.code === -32601)
  const fakeSession = await rawReq('POST', `${PREFIX}/mcp`, { jsonrpc: '2.0', id: 11, method: 'tools/list' }, authHeaders({ 'Mcp-Session-Id': 'not-a-real-session' }))
  check('会话校验：假会话 → -32001 要求重新 initialize', fakeSession.json?.error?.code === -32001)
  const del = await rawReq('DELETE', `${PREFIX}/mcp`, undefined, authHeaders({ 'Mcp-Session-Id': sessionId }))
  check('DELETE /mcp：204 会话结束', del.status === 204, `status=${del.status}`)
  const afterDel = await rawReq('POST', `${PREFIX}/mcp`, { jsonrpc: '2.0', id: 12, method: 'tools/list' }, authHeaders({ 'Mcp-Session-Id': sessionId }))
  check('DELETE 后旧会话失效 → -32001', afterDel.json?.error?.code === -32001, `status=${afterDel.status}`)

  console.log(results.join('\n'))
  console.log(`\n== 结果：${results.length - failures}/${results.length} 通过 ==\n`)
  if (failures > 0) {
    console.log(`--- 服务日志（尾部）---\n${appLog.split('\n').slice(-40).join('\n')}`)
  }
  process.exitCode = failures > 0 ? 1 : 0
}

main().catch((err) => {
  console.error(`冒烟失败: ${err?.stack || err}`)
  console.log(`--- 服务日志（尾部）---\n${appLog.split('\n').slice(-40).join('\n')}`)
  process.exitCode = 1
}).finally(() => {
  app.kill('SIGTERM')
  mock.kill('SIGTERM')
  setTimeout(() => {
    try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }, 500)
})
