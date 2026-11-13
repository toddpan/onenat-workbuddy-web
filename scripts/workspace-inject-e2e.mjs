#!/usr/bin/env node
/** @智能体 → 工作区跨机访问指引注入 E2E（场景①，docs/design-cross-node-file-passing.md）
 *  A. 无项目任务：成员 workDir 降级来源（编排派工 prompt 注入）
 *  B. 项目任务：项目 workspace 主路径（生产最主要形态）
 *  C. chat 直发：多 @ 走 runChatTurn 注入点
 *  运行：npm run smoke:ws-inject（需先 npm run build） */
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
const sse = (res, text) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write(`event: delta\ndata: {"delta":${JSON.stringify(text)}}\n\n`)
  res.write('event: turn_end\ndata: {}\n\n'); res.write('event: done\ndata: {}\n\n'); res.end()
}
const handleNode = (req, res) => {
  const url = req.url || ''
  let b = ''; req.on('data', (c) => b += c); req.on('end', () => {
    if (req.method === 'GET' && url === '/system/status') { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:true, data:{ name:'stub', version:'1', port: STUB_PORT } })); return }
    if (req.method === 'POST' && url === '/fs/mkdir') { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:true, data:{ path:'', name:'' } })); return }
    if (req.method === 'POST' && url === '/api/v1/sessions') { res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ ok:true, data:{ sessionId:`stub-s${prompts.length + 1}` } })); return }
    if (req.method === 'POST' && url.endsWith('/prompt-stream')) {
      let prompt = ''; try { prompt = JSON.parse(b).prompt || '' } catch {}
      prompts.push(prompt)
      sse(res, 'ok')
      return
    }
    res.writeHead(404, { 'Content-Type':'application/json' }); res.end(JSON.stringify({ ok:false, error:'Endpoint not found' }))
  })
}
const stub = createServer(handleNode), remoteStub = createServer(handleNode)
let remoteBase = ''

const procs = []
function cleanup() { try { stub.close(); remoteStub.close() } catch {} for (const p of procs) { try { p.kill('SIGKILL') } catch {} } }
process.on('exit', cleanup)
let COOKIE = ''
async function req(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(COOKIE ? { Cookie: COOKIE } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const t = await res.text(); let j; try { j = JSON.parse(t) } catch {}
  return { status: res.status, json: j }
}
/** 等待自 offset 起出现满足条件的 prompt，返回该批 prompts（超时返回已有部分） */
async function waitForPrompt(offset, test, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = prompts.slice(offset).find(test)
    if (hit !== undefined) return prompts.slice(offset)
    await sleep(300)
  }
  return prompts.slice(offset)
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'wb-ws-inject-e2e-'))
  console.log('\n== 工作区跨机访问注入 E2E（场景① 三路径） ==\n')
  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r))
  await new Promise((r) => remoteStub.listen(0, '127.0.0.1', r))
  remoteBase = `http://127.0.0.1:${remoteStub.address().port}/api/v1`
  const server = spawn(process.execPath, [join(ROOT, 'dist', 'server.js'), '--port', String(PORT), '--data', dataDir, '--quiet'], { cwd: ROOT, env: { ...process.env, WORKBUDDY_ALLOW_PRIVATE_DIRECT: '1' }, stdio: ['ignore','ignore','pipe'] })
  procs.push(server)
  const t0 = Date.now(); while (Date.now() - t0 < 20000) { try { if ((await fetch(`${BASE}/healthz`)).ok) break } catch {} await sleep(250) }
  const loginRes = await fetch(`${BASE}${PREFIX}/api/auth/login`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ username:'workbuddy', password:'workbuddy-admin' }) })
  COOKIE = (loginRes.headers.get('set-cookie') || '').split(';')[0]
  check('登录', loginRes.ok)

  // 两个智能体：发起方（绑定 workDir）+ 被提及方（无 workDir，逼出降级/项目来源）
  await req('POST', `${PREFIX}/api/agents`, { name: 'ws-a', dshRef: { kind:'direct', apiBaseUrl:`http://127.0.0.1:${STUB_PORT}/api/v1` }, apiKey:'k', workDir: '/tmp/ws-inject' })
  await req('POST', `${PREFIX}/api/agents`, { name: 'ws-b', dshRef: { kind:'direct', apiBaseUrl: remoteBase }, apiKey:'k' })
  const agents = await req('GET', `${PREFIX}/api/agents`)
  const idA = agents.json.data.find((a) => a.name === 'ws-a')?.id
  const idB = agents.json.data.find((a) => a.name === 'ws-b')?.id
  check('两个智能体就绪', Boolean(idA && idB))

  // ---------- 场景 A：无项目任务，@ws-b → 工作区来源降级到成员 workDir（编排派工 prompt） ----------
  console.log('\n[场景 A] 无项目任务 · 成员 workDir 降级来源 · 编排派工注入')
  const tA = await req('POST', `${PREFIX}/api/tasks`, { title:'ws inject A', mode:'chat', memberAgentIds:[idA] })
  const offA = prompts.length
  await req('POST', `${PREFIX}/api/tasks/${tA.json?.data?.id}/messages`, { message: '@ws-b 帮我看下工作区里的文件' })
  // 单 @ 也会先经 LLM 规划（规划 prompt 含 @ws-b），带工作区注入段的是随后的成员派发 prompt
  const batchA = await waitForPrompt(offA, (p) => p.includes('[项目工作区跨机访问]'))
  const pA = batchA.find((p) => p.includes('[项目工作区跨机访问]')) || ''
  check('提示词含工作区跨机访问段', Boolean(pA))
  check('提示词含发起方工作区路径 /tmp/ws-inject', pA.includes('/tmp/ws-inject'))
  check('提示词含节点下载 URL（/fs/download）', pA.includes('/fs/download?path='))
  check('提示词含浏览目录 URL（/fs/list）与 inline 预览', pA.includes('/fs/list?path=') && pA.includes('inline=1'))
  check('提示词含鉴权头说明', pA.includes('Authorization: Bearer k'))
  check('明确绝对路径要求（不支持相对路径）', pA.includes('必须是【绝对路径】'))
  check('示例含 URL 编码后的绝对路径', pA.includes(encodeURIComponent('/tmp/ws-inject/a.txt')))

  // ---------- 场景 B：项目任务，项目 workspace 主路径（生产最主要形态） ----------
  console.log('\n[场景 B] 项目任务 · 项目 workspace 主路径')
  const projRes = await req('POST', `${PREFIX}/api/projects`, { name: 'ws-inject-proj', dshRef: { kind:'direct', apiBaseUrl:`http://127.0.0.1:${STUB_PORT}/api/v1` }, apiKey:'k', workspace: '/tmp/ws-proj-inject' })
  const projId = projRes.json?.data?.id
  check('创建项目（含工作区）', Boolean(projId))
  const tB = await req('POST', `${PREFIX}/api/tasks`, { title:'ws inject B', projectId: projId, memberAgentIds:[idA] })
  const offB = prompts.length
  await req('POST', `${PREFIX}/api/tasks/${tB.json?.data?.id}/messages`, { message: '@ws-a 看下项目工作区里的文件' })
  const batchB = await waitForPrompt(offB, (p) => p.includes('[项目工作区]'))
  const pB = batchB.find((p) => p.includes('[项目工作区]')) || ''
  check('同节点提示词含本地项目工作区段', Boolean(pB))
  check('注入的是项目工作区路径（主路径优先）', pB.includes('/tmp/ws-proj-inject'))
  check('不误用其他成员 workDir 路径', Boolean(pB) && !pB.includes('/tmp/ws-inject'))
  check('同节点明确本地操作，无需远程绕行', pB.includes('位于当前执行节点') && !pB.includes('写入和命令执行不可用'))
  check('同节点不注入不必要的文件节点凭证', !pB.includes('Authorization: Bearer k'))

  // ---------- 场景 C：chat 直发（多 @ → runChatTurn 注入点） ----------
  console.log('\n[场景 C] chat 模式多 @ · 直发路径 runChatTurn 注入')
  const tC = await req('POST', `${PREFIX}/api/tasks`, { title:'ws inject C', mode:'chat', memberAgentIds:[idA, idB] })
  const offC = prompts.length
  await req('POST', `${PREFIX}/api/tasks/${tC.json?.data?.id}/messages`, { message: '@ws-a @ws-b 都看下工作区' })
  const batchC = await waitForPrompt(offC, (p) => p.includes('正在与用户直接对话'))
  const pC = batchC.find((p) => p.includes('正在与用户直接对话')) || ''
  check('直发 prompt 已派发（首个成员）', Boolean(pC))
  check('同节点直发提示词含本地工作区指引', pC.includes('[项目工作区]') && pC.includes('位于当前执行节点'))
  check('直发提示词含成员 workDir 路径', pC.includes('/tmp/ws-inject'))
  check('同节点直发不重复下发文件节点凭据', !pC.includes('Authorization: Bearer k'))

  console.log(failures === 0 ? '\n全部通过 ✅\n' : `\n${failures} 项失败 ❌\n`)
  try { rmSync(dataDir, { recursive: true, force: true }) } catch {}
  cleanup(); process.exit(failures ? 1 : 0)
}
main().catch((e) => { console.error(e); cleanup(); process.exit(1) })
