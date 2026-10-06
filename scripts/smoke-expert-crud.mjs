#!/usr/bin/env node
/** 冒烟：专家 CRUD API + MCP（expert.*）端到端验证（独立临时数据目录，不碰正式数据）。 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PORT = 3891
const BASE = `http://127.0.0.1:${PORT}/onenat-workbuddy`
const dataDir = mkdtempSync(join(tmpdir(), 'wb-expert-smoke-'))
process.env.DSH_HOME = dataDir
const child = spawn(process.execPath, ['dist/server.js', '--port', String(PORT), '--quiet'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
let logs = ''
child.stdout.on('data', (d) => { logs += d })
child.stderr.on('data', (d) => { logs += d })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function up() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`)
      if (r.ok) return
    } catch {}
    await wait(200)
  }
  throw new Error('server not up\n' + logs)
}

let cookie = ''
async function api(path, opts = {}) {
  const r = await fetch(BASE + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(opts.headers || {}) },
  })
  const setCookie = r.headers.get('set-cookie')
  if (setCookie) cookie = setCookie.split(';')[0]
  let body = null
  try { body = await r.json() } catch {}
  return { status: r.status, body }
}

async function mcp(method, params, id = 1) {
  const r = await fetch(`${BASE}/api/experts/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  })
  return { status: r.status, body: await r.json() }
}

let failed = 0
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ' ' + extra}`)
  if (!cond) failed++
}

try {
  await up()
  const login = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'workbuddy', password: 'ThunderSoft@88' }) })
  check('login', login.status === 200, JSON.stringify(login))

  // --- API CRUD ---
  let r = await api('/api/experts', { method: 'POST', body: JSON.stringify({ kind: 'expert', id: 'smoke-reviewer', name: '冒烟评审员', description: '冒烟测试专家', tags: ['smoke'], systemPrompt: '你是评审员。', executionPrompt: '输出 PASS/FAIL。' }) })
  check('POST create expert', r.status === 200 && r.body.ok && r.body.data.source === 'user', JSON.stringify(r.body))

  r = await api('/api/experts?domain=user')
  check('GET list filter domain=user', r.status === 200 && r.body.data.experts.some((e) => e.id === 'smoke-reviewer'))

  r = await api('/api/experts/smoke-reviewer/profile')
  check('GET profile', r.status === 200 && r.body.data.systemPrompt === '你是评审员。')

  r = await api('/api/experts/smoke-reviewer', { method: 'PUT', body: JSON.stringify({ name: '冒烟评审员v2', description: '更新后的简介', systemPrompt: '你是资深评审员。' }) })
  check('PUT update expert', r.status === 200 && r.body.data.name === '冒烟评审员v2' && r.body.data.systemPrompt === '你是资深评审员。')

  // builtin 只读
  r = await api('/api/experts?domain=team')
  const builtinId = (r.body?.data?.experts || []).find((e) => e.source === 'builtin')?.id
  if (builtinId) {
    let rr = await api(`/api/experts/${builtinId}`, { method: 'PUT', body: JSON.stringify({ name: 'hack' }) })
    check('PUT builtin → 403', rr.status === 403, String(rr.status))
    rr = await api(`/api/experts/${builtinId}`, { method: 'DELETE' })
    check('DELETE builtin → 403', rr.status === 403, String(rr.status))
  } else { check('builtin expert present', false, 'no builtin in team division') }

  // 旧语义 POST（一键建子智能体）不受影响：缺 dshRef → 400 而非误建专家
  r = await api('/api/experts', { method: 'POST', body: JSON.stringify({ id: 'smoke-reviewer' }) })
  check('legacy POST without dshRef → 400', r.status === 400, JSON.stringify(r.body))

  // --- MCP ---
  r = await mcp('initialize', { protocolVersion: '2024-11-05', clientInfo: { name: 'smoke', version: '0' } })
  check('mcp initialize', r.status === 200 && r.body.result?.serverInfo?.name === 'workbuddy-expert-registry', JSON.stringify(r.body))

  r = await mcp('tools/list', {})
  const names = (r.body?.result?.tools || []).map((t) => t.name)
  check('mcp tools/list', ['expert.list', 'expert.get', 'expert.create', 'expert.update', 'expert.delete', 'expert.search'].every((n) => names.includes(n)), names.join(','))

  r = await mcp('tools/call', { name: 'expert.list', arguments: { domain: 'user' } })
  check('mcp expert.list', r.body?.result?.content?.[0]?.text?.includes('smoke-reviewer'), '')

  r = await mcp('tools/call', { name: 'expert.get', arguments: { id: 'smoke-reviewer' } })
  check('mcp expert.get', r.body?.result?.content?.[0]?.text?.includes('资深评审员'), '')

  r = await mcp('tools/call', { name: 'expert.search', arguments: { query: '资深评审' } })
  check('mcp expert.search (prompt full-text)', r.body?.result?.content?.[0]?.text?.includes('smoke-reviewer'), '')

  r = await mcp('tools/call', { name: 'expert.update', arguments: { id: 'smoke-reviewer', description: 'mcp 更新' } })
  check('mcp expert.update', r.body?.result?.content?.[0]?.text?.includes('mcp 更新'), '')

  r = await mcp('tools/call', { name: 'expert.delete', arguments: { id: 'smoke-reviewer' } })
  check('mcp expert.delete', r.body?.result?.content?.[0]?.text?.includes('"deleted"') || r.body?.result?.content?.[0]?.text?.includes('true'), r.body?.result?.content?.[0]?.text?.slice(0, 120))

  r = await mcp('tools/call', { name: 'expert.get', arguments: { id: 'smoke-reviewer' } })
  check('mcp expert.get after delete → error', r.body?.result?.isError === true, '')

  // 未鉴权访问 MCP 应被门禁拦下
  const savedCookie = cookie; cookie = ''
  r = await mcp('tools/list', {})
  check('mcp unauthenticated blocked', r.status === 401 || r.body?.error, JSON.stringify(r.body).slice(0, 100))
  cookie = savedCookie
} catch (err) {
  failed++
  console.error('SMOKE ERROR:', err?.message || err, '\n', logs.slice(-2000))
} finally {
  child.kill('SIGTERM')
  await wait(300)
  rmSync(dataDir, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
