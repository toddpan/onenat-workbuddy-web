#!/usr/bin/env node
/**
 * App「AI 控制台」模型透传 + MCP 工具循环 端到端验证：
 *   node scripts/console-e2e.mjs
 * stub 节点 /chat/completions：首轮返回 tool_call(workbuddy_monitor_read)，
 * 收到 tool 结果后返回最终文本 —— 复刻 App agent-loop 将经历的两轮交互。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 18095, STUB_PORT = 18097, PREFIX = '/onenat-workbuddy', BASE = `http://127.0.0.1:${PORT}`
let failures = 0
const check = (n, c, d = '') => { const ok = Boolean(c); if (!ok) failures++; console.log(`${ok ? '  ✅' : '  ❌'} ${n}${d ? ` — ${d}` : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond, label, timeoutMs = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) { try { if (await cond()) return } catch {} await sleep(250) }
  throw new Error(`等待超时: ${label}`)
}

const chatCalls = []
const stub = createServer((req, res) => {
  const url = req.url || ''
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    if (req.method === 'POST' && url === '/api/v1/chat/completions') {
      let msgs = []
      try { msgs = JSON.parse(body)?.messages || [] } catch {}
      chatCalls.push(msgs)
      const last = msgs[msgs.length - 1]
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (last?.role !== 'tool') {
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'workbuddy_monitor_read', arguments: '{"section":"kpi"}' } },
        ] } }] }))
      } else {
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '当前在线 0/0，任务 0 个。' } }] }))
      }
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
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(COOKIE ? { Cookie: COOKIE } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await res.text(); let json; try { json = JSON.parse(text) } catch {}
  return { status: res.status, json }
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'workbuddy-console-e2e-'))
  console.log('\n== AI 控制台 E2E ==\n')
  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r))
  const server = spawn(process.execPath, [join(ROOT, 'dist', 'server.js'), '--port', String(PORT), '--data', dataDir, '--quiet'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] })
  procs.push(server)
  await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok, 'server 就绪')
  const loginRes = await fetch(`${BASE}${PREFIX}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'workbuddy', password: 'ThunderSoft@88' }) })
  COOKIE = (loginRes.headers.get('set-cookie') || '').split(';')[0]
  check('登录成功', loginRes.ok)

  // 建主智能体（绑 stub 节点）作为控制台的模型来源
  const agentRes = await req('POST', `${PREFIX}/api/agents`, { name: 'console-e2e', dshRef: { kind: 'direct', apiBaseUrl: `http://127.0.0.1:${STUB_PORT}/api/v1` }, apiKey: 'stub-key' })
  check('创建主智能体', agentRes.json?.ok === true, JSON.stringify(agentRes.json || {}).slice(0, 100))

  // MCP：initialize + tools/list（AI 令牌？无令牌时用登录 Cookie 也可 —— 控制台用登录态）
  const init = await req('POST', `${PREFIX}/mcp`, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'wb-app-console', version: '1.0' } } })
  check('MCP initialize', init.json?.result?.serverInfo?.name === 'onenat-workbuddy', JSON.stringify(init.json?.result?.serverInfo || init.json?.error || {}))
  const list = await req('POST', `${PREFIX}/mcp`, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  const tools = list.json?.result?.tools || []
  check('MCP tools/list ≥ 12 个工具', tools.length >= 12, `count=${tools.length}: ${tools.map((t) => t.name).join(',').slice(0, 120)}`)

  // 控制台透传（OpenAI tools 格式）
  const openaiTools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }))
  const c1 = await req('POST', `${PREFIX}/api/console/chat`, { messages: [ { role: 'system', content: '你是全局控制助手' }, { role: 'user', content: '看一下运行监控' } ], tools: openaiTools })
  check('console/chat 首轮透传', c1.json?.ok === true, JSON.stringify(c1.json || {}).slice(0, 140))
  const tc = c1.json?.message?.tool_calls?.[0]
  check('模型产出 tool_call = workbuddy_monitor_read', tc?.function?.name === 'workbuddy_monitor_read', JSON.stringify(tc || {}).slice(0, 140))

  // App 侧经 MCP 执行工具 → 回填 tool 结果续轮
  const call = await req('POST', `${PREFIX}/mcp`, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'workbuddy_monitor_read', arguments: JSON.parse(tc.function.arguments || '{}') } })
  const toolOk = call.json?.result?.content?.[0]?.text !== undefined
  check('MCP tools/call 执行监控读取', toolOk, String(call.json?.result?.content?.[0]?.text || call.json?.error || '').slice(0, 100))
  const c2 = await req('POST', `${PREFIX}/api/console/chat`, { messages: [
    { role: 'system', content: '你是全局控制助手' }, { role: 'user', content: '看一下运行监控' },
    c1.json.message,
    { role: 'tool', tool_call_id: 'call-1', content: String(call.json?.result?.content?.[0]?.text || '') },
  ], tools: openaiTools })
  check('工具结果回填后模型给出最终答案', c2.json?.ok === true && /在线/.test(c2.json?.message?.content || ''), c2.json?.message?.content || c2.json?.error || '')
  check('stub 节点收到两轮对话', chatCalls.length === 2)

  console.log(failures === 0 ? '\n全部通过 ✅\n' : `\n${failures} 项失败 ❌\n`)
  try { rmSync(dataDir, { recursive: true, force: true }) } catch {}
  cleanup(); process.exit(failures === 0 ? 0 : 1)
}
main().catch((e) => { console.error(e); cleanup(); process.exit(1) })
