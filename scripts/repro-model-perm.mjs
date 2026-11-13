#!/usr/bin/env node
/**
 * 复现：普通用户任务输入框选模型/模式预设不可用
 *   node scripts/repro-model-perm.mjs
 *
 * 链路：stub DSH（/models /presets /sessions）→ mock ONENAT（map-dsh-live → stub）→
 *       workbuddy server → 管理员邀请普通用户 alice → alice 走选模型全链路断言。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DSH_PORT = 18071
const MOCK_PORT = 18072
const PORT = 18073
const PREFIX = '/onenat-workbuddy'
const BASE = `http://127.0.0.1:${PORT}`

const results = []
let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  if (!ok) failures++
  results.push(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  console.log(results[results.length - 1])
}

async function req(method, path, body, cookie = '') {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = undefined }
  return { status: res.status, json, cookie: (res.headers.get('set-cookie') || '').split(';')[0] }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const procs = []
function spawnJob(name, args, env = {}) {
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (d) => { if (process.env.VERBOSE) console.log(`[${name}]`, String(d)) })
  child.stderr.on('data', (d) => console.error(`[${name}]`, String(d)))
  procs.push(child)
}
function cleanup() { for (const p of procs) { try { p.kill('SIGKILL') } catch { /* ignore */ } } }
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(1) })

// ---------- stub DSH：提供模型目录 / 模式预设 / 会话 ----------
function stubDsh() {
  const s = http.createServer((reqq, res) => {
    const p = reqq.url || ''
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
    if (p.startsWith('/api/v1/models')) return json(200, { ok: true, data: { models: [{ provider: 'stub', id: 'm1', name: 'Stub M1', isDefault: true }], defaultModel: { provider: 'stub', model: 'm1' } } })
    if (p.startsWith('/api/v1/presets')) return json(200, { ok: true, data: { presets: [{ id: 'sandbox', name: '沙箱', description: 'sandbox' }, { id: 'never', name: 'never', description: 'approval=never' }] } })
    if (p.startsWith('/api/v1/sessions') && reqq.method === 'POST') return json(201, { ok: true, data: { id: 'sess-1', sessionId: 'sess-1' } })
    if (p.startsWith('/api/v1/sessions') && reqq.method === 'PUT') return json(200, { ok: true, data: {} })
    if (p.startsWith('/api/v1/sessions')) return json(200, { ok: true, data: {} })
    if (p.startsWith('/api/v1/chat/completions')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ id: 'c1', choices: [{ message: { role: 'assistant', content: 'stub' } }] }))
    }
    return json(200, { ok: true, data: {} })
  })
  s.listen(DSH_PORT)
  return s
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'wb-model-perm-'))
  stubDsh()
  spawnJob('mock-onenat', [join(ROOT, 'scripts', 'mock-onenat.cjs')], { MOCK_ONENAT_PORT: String(MOCK_PORT), DSH_WEB_PORT: String(DSH_PORT) })
  await sleep(400)
  spawnJob('server', [join(ROOT, 'dist', 'server.js'), '--port', String(PORT), '--data', dataDir,
    '--onenat-base-url', `http://127.0.0.1:${MOCK_PORT}`, '--onenat-api-key', 'onk-mock-key-000', '--quiet'],
    { WORKBUDDY_ALLOW_PRIVATE_DIRECT: '1' })
  const t0 = Date.now()
  let up = false
  while (Date.now() - t0 < 20000) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) { up = true; break } } catch { /* retry */ }
    await sleep(200)
  }
  if (!up) throw new Error('服务未就绪')

  try {
    // 管理员登录 + 建 agent + 邀请普通用户
    const admin = await req('POST', `${PREFIX}/api/auth/login`, { username: 'workbuddy', password: 'workbuddy-admin' })
    const adminCookie = admin.cookie || ''
    const agent = await req('POST', `${PREFIX}/api/agents`, { name: '模型复现智能体', dshRef: { kind: 'mapping', mappingId: 'map-dsh-live' }, systemPrompt: 'stub' }, adminCookie)
    check('管理员建子智能体（绑定 mock 节点）', [200, 201].includes(agent.status), `status=${agent.status}`)

    const inv = await req('POST', `${PREFIX}/api/users`, { email: 'alice@example.com', displayName: '爱丽丝' }, adminCookie)
    const inviteToken = new URL(inv.json?.data?.inviteLink || 'http://x/?token=').searchParams.get('token') || ''
    const accept = await req('POST', `${PREFIX}/api/invitations/${inviteToken}`, { password: 'Passw0rd123', displayName: '爱丽丝' })
    const aliceCookie = accept.cookie || ''
    check('普通用户 alice 激活登录', Boolean(aliceCookie), `status=${accept.status}`)

    // ① 模型目录（composer 加载的第一步）
    const opts = await req('GET', `${PREFIX}/api/planner/options?node=map-dsh-live`, undefined, aliceCookie)
    const models = opts.json?.data?.models || []
    check('① alice 拉模型目录 /planner/options', opts.status === 200 && models.length > 0,
      `status=${opts.status} models=${models.length} modelError=${opts.json?.data?.modelError || ''}`)

    // ② 模式预设候选
    const nodeRef = encodeURIComponent(JSON.stringify({ kind: 'mapping', mappingId: 'map-dsh-live' }))
    const pr = await req('GET', `${PREFIX}/api/agents/presets?node=${nodeRef}`, undefined, aliceCookie)
    check('② alice 拉模式预设 /agents/presets', pr.status === 200 && (pr.json?.data?.presets || []).length > 0,
      `status=${pr.status} presets=${(pr.json?.data?.presets || []).length} err=${pr.json?.error || pr.json?.data?.error || ''}`)

    // ③ alice 自己建任务 → 切模型 / 切预设（taskForManage 链路）
    const tk = await req('POST', `${PREFIX}/api/tasks`, { title: 'alice 自己的任务', nodeRef: { kind: 'mapping', mappingId: 'map-dsh-live' }, mode: 'chat', message: '你好' }, aliceCookie)
    const taskId = tk.json?.data?.id || ''
    check('③ alice 创建自己的任务', [200, 201].includes(tk.status) && Boolean(taskId), `status=${tk.status} id=${taskId}`)
    if (taskId) {
      await sleep(1500) // 等远端会话建立（stub）
      const sm = await req('PUT', `${PREFIX}/api/tasks/${taskId}/session-model`, { provider: 'stub', model: 'm1' }, aliceCookie)
      check('③a alice 切换自己任务的模型', sm.status === 200, `status=${sm.status} err=${sm.json?.error || ''} code=${sm.json?.code || ''}`)
      const sp = await req('PUT', `${PREFIX}/api/tasks/${taskId}/session-preset`, { preset: 'sandbox' }, aliceCookie)
      check('③b alice 切换自己任务的沙箱预设', sp.status === 200 && sp.json?.data?.saved === true, `status=${sp.status} err=${sp.json?.error || ''}`)
    }

    // ④ 存量/无归属任务：alice 可见但切模型会怎样（期望应明确，而非 404 Task not found）
    const leg = await req('POST', `${PREFIX}/api/tasks`, { title: '存量无归属任务', nodeRef: { kind: 'mapping', mappingId: 'map-dsh-live' }, mode: 'chat' }, adminCookie)
    const legId = leg.json?.data?.id || ''
    if (legId) {
      const v = await req('GET', `${PREFIX}/api/tasks/${legId}`, undefined, aliceCookie)
      const sm = await req('PUT', `${PREFIX}/api/tasks/${legId}/session-model`, { provider: 'stub', model: 'm1' }, aliceCookie)
      check('④ alice 对他人私有任务不可见/不可选（404 防枚举）', v.status === 404 && sm.status === 404,
        `view=${v.status} put=${sm.status} err=${sm.json?.error || ''}`)
    }

    console.log(failures ? `\n${failures} 项失败` : '\n全部通过')
  } finally {
    cleanup()
    try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

main().catch((e) => { console.error(e); cleanup(); process.exit(1) })
