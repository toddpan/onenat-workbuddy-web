#!/usr/bin/env node
/** @智能体 → 工作区跨机访问指引注入 E2E：node scripts/workspace-inject-e2e.mjs */
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

const prompts = []
const stub = createServer((req, res) => {
  const url = req.url || ''
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    if (req.method === 'POST' && url === '/api/v1/sessions') { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:true, data:{ sessionId:'stub-s1' } })); return }
    if (req.method === 'POST' && url === '/api/v1/sessions/stub-s1/prompt-stream') {
      try { prompts.push(JSON.parse(b).prompt || '') } catch { prompts.push(b) }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('event: delta\ndata: {"delta":"ok"}\n\n'); res.write('event: turn_end\ndata: {}\n\n'); res.write('event: done\ndata: {}\n\n'); res.end(); return
    }
    res.writeHead(404, { 'Content-Type':'application/json' }); res.end(JSON.stringify({ ok:false, error:'Endpoint not found' }))
  })
})

const procs = []
function cleanup() { try { stub.close() } catch {} for (const p of procs) { try { p.kill('SIGKILL') } catch {} } }
process.on('exit', cleanup)
let COOKIE = ''
async function req(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(COOKIE ? { Cookie: COOKIE } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const t = await res.text(); let j; try { j = JSON.parse(t) } catch {}
  return { status: res.status, json: j }
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'wb-ws-inject-e2e-'))
  console.log('\n== 工作区跨机访问注入 E2E ==\n')
  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r))
  const server = spawn(process.execPath, [join(ROOT, 'dist', 'server.js'), '--port', String(PORT), '--data', dataDir, '--quiet'], { cwd: ROOT, stdio: ['ignore','ignore','pipe'] })
  procs.push(server)
  const t0 = Date.now(); while (Date.now() - t0 < 20000) { try { if ((await fetch(`${BASE}/healthz`)).ok) break } catch {} await sleep(250) }
  const loginRes = await fetch(`${BASE}${PREFIX}/api/auth/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username:'workbuddy', password:'ThunderSoft@88' }) })
  COOKIE = (loginRes.headers.get('set-cookie') || '').split(';')[0]
  check('登录', loginRes.ok)

  // 两个智能体：发起方（绑定项目工作区）+ 被提及方
  await req('POST', `${PREFIX}/api/agents`, { name: 'ws-a', dshRef: { kind:'direct', apiBaseUrl:`http://127.0.0.1:${STUB_PORT}/api/v1` }, apiKey:'k', workDir: '/tmp/ws-inject' })
  const b = await req('POST', `${PREFIX}/api/agents`, { name: 'ws-b', dshRef: { kind:'direct', apiBaseUrl:`http://127.0.0.1:${STUB_PORT}/api/v1` }, apiKey:'k' })
  const agents = await req('GET', `${PREFIX}/api/agents`)
  const ids = agents.json.data.filter((a) => a.name === 'ws-a' || a.name === 'ws-b').map((a) => a.id)

  const taskRes = await req('POST', `${PREFIX}/api/tasks`, { title:'ws inject e2e', mode:'chat', memberAgentIds:[ids[0]] })
  const taskId = taskRes.json?.data?.id
  check('创建任务', Boolean(taskId))

  // @ws-b → 应注入发起方工作区指引
  await req('POST', `${PREFIX}/api/tasks/${taskId}/messages`, { message: '@ws-b 帮我看下工作区里的文件' })
  const deadline = Date.now() + 20000
  while (Date.now() < deadline && prompts.length === 0) await sleep(300)
  const p1 = prompts.find((p) => p.includes('@ws-b')) || prompts[0] || ''
  console.log('--- 实际提示词尾部 ---\n' + p1.slice(-700))
  check('提示词含工作区跨机访问段', p1.includes('[项目工作区跨机访问]'))
  check('提示词含发起方工作区路径 /tmp/ws-inject', p1.includes('/tmp/ws-inject'))
  check('提示词含节点下载 URL（/fs/download）', p1.includes('/fs/download?path='))
  check('提示词含浏览目录 URL（/fs/list）与 inline 预览', p1.includes('/fs/list?path=') && p1.includes('inline=1'))
  check('提示词含鉴权头说明', p1.includes('Authorization: Bearer k'))

  console.log(failures === 0 ? '\n全部通过 ✅\n' : `\n${failures} 项失败 ❌\n`)
  try { rmSync(dataDir, { recursive: true, force: true }) } catch {}
  cleanup(); process.exit(failures ? 1 : 0)
}
main().catch((e) => { console.error(e); cleanup(); process.exit(1) })
