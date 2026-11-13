#!/usr/bin/env node
/**
 * TASK-8 浏览器端验收环境编排（独立 QA，非 smoke）
 *
 * 用途：一键起 TASK-8「进入工作台」验收所需的真实进程环境，并造好数据；随后由
 *       ego-browser（人工/AI 驱动的真实 Chromium）对该环境做浏览器端断言与截图。
 *
 * 组成（端口可用 --port/--stub-port/--mock-port 覆盖）：
 *   - stub DSH 节点 :18121  内存 FS + 即完成会话（语义对齐 scripts/backlog-e2e.mjs）
 *   - mock ONENAT   :18125  spawn scripts/mock-onenat.cjs（MOCK_ONENAT_PORT/KEY 环境变量）
 *   - 真实服务端    :18120  node dist/server.js --port 18120 --data <临时目录> \
 *                            --onenat-base-url http://127.0.0.1:18125 --onenat-api-key onk-mock-key-000
 *
 * 造数：
 *   项目 A「TASK8 验收项目A」 dshRef=direct(:18121) workspace=/tmp/task8-ws
 *     → POST /backlog/init → 建 3 条不同状态待办（To Do / In Progress / Done 取 config statuses）
 *   项目 B「TASK8 不可达项目」 dshRef=direct(http://127.0.0.1:1/api/v1) workspace=/tmp/task8-ws-b
 *     → overview 中 nodeStatus=unreachable（离线按钮仍可用场景）
 *
 * 运行：
 *   node scripts/qa-backlog-entry.mjs            # 起环境并保持运行，ready 后写 state 文件
 *   node scripts/qa-backlog-entry.mjs --check    # 只做 API 层种子自检（不起浏览器），随后退出
 *   SIGTERM/SIGINT/Ctrl-C 会 kill 所有子进程并删除临时数据目录（含 state 文件）
 *
 * 输出：ready 时打印 `QA_READY {json}`，并把同一份 JSON 写到 --state（默认 /tmp/task8-qa-state.json），
 *       供 ego-browser 脚本读取（ego-browser 脚本不继承 shell 环境变量）。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const argOf = (flag, dflt) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const PORT = Number(argOf('--port', '18120'))
const STUB_PORT = Number(argOf('--stub-port', '18121'))
const MOCK_PORT = Number(argOf('--mock-port', '18125'))
const STATE_PATH = argOf('--state', '/tmp/task8-qa-state.json')
const CHECK_ONLY = argv.includes('--check')
const PREFIX = '/onenat-workbuddy'
const BASE = `http://127.0.0.1:${PORT}`
const STUB_BASE = `http://127.0.0.1:${STUB_PORT}/api/v1`
const ONENAT_KEY = 'onk-mock-key-000'
const ONENAT_BASE = `http://127.0.0.1:${MOCK_PORT}`
const WS_A = '/tmp/task8-ws'
const WS_B = '/tmp/task8-ws-b'

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  if (!ok) failures++
  log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  return ok
}
async function waitFor(cond, label, timeoutMs = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try { if (await cond()) return true } catch { /* retry */ }
    await sleep(250)
  }
  throw new Error(`等待超时: ${label}`)
}

// ---------------- stub DSH 节点：内存 FS + 即完成会话 ----------------
const fsFiles = new Map() // 绝对路径 -> 内容
const fsDirs = new Set()
function ensureDir(p) {
  const parts = String(p).split('/').filter(Boolean)
  for (let i = 1; i <= parts.length; i++) fsDirs.add('/' + parts.slice(0, i).join('/'))
}
let sessionCounter = 0
const sessions = new Map()

const stub = createServer((req, res) => {
  const url = req.url || ''
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString()
    const body = (() => { try { return JSON.parse(raw || '{}') } catch { return {} } })()
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }

    if (req.method === 'GET' && url.startsWith('/api/v1/fs/list')) {
      const dir = decodeURIComponent((url.match(/[?&]path=([^&]*)/) || [])[1] || '')
      if (!fsDirs.has(dir.replace(/\/+$/, ''))) return json(200, { ok: false, error: `no such file or directory: ${dir}` })
      const prefix = dir.replace(/\/+$/, '') + '/'
      // 真实 DSH 节点语义：无 all=1 时含文件目录也返回空 entries
      if (!/[?&]all=1/.test(url)) return json(200, { ok: true, data: { path: dir, home: '', entries: [], truncated: false } })
      const entries = [...fsFiles.keys()]
        .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
        .map((k) => ({ name: k.slice(prefix.length), path: k, type: 'file', hidden: false }))
      return json(200, { ok: true, data: { path: dir, home: '', entries, truncated: false } })
    }
    if (req.method === 'GET' && url.startsWith('/api/v1/fs/download')) {
      const fp = decodeURIComponent((url.match(/[?&]path=([^&]*)/) || [])[1] || '')
      if (!fsFiles.has(fp)) return json(404, { ok: false, error: 'no such file' })
      res.writeHead(200, { 'Content-Type': 'text/markdown' })
      res.end(fsFiles.get(fp))
      return
    }
    if (req.method === 'POST' && url.startsWith('/api/v1/fs/upload')) {
      const dir = decodeURIComponent((url.match(/[?&]path=([^&]*)/) || [])[1] || '')
      const ct = req.headers['content-type'] || ''
      const bm = /boundary=(.+)$/.exec(ct)
      if (!bm) return json(400, { ok: false, error: 'no boundary' })
      const boundary = '--' + bm[1].trim()
      const segs = raw.split(boundary).slice(1, -1)
      const saved = []
      for (const seg of segs) {
        const idx = seg.indexOf('\r\n\r\n')
        if (idx < 0) continue
        const head = seg.slice(0, idx)
        let content = seg.slice(idx + 4)
        if (content.endsWith('\r\n')) content = content.slice(0, -2)
        const nm = /filename="([^"]*)"/.exec(head)
        if (!nm) continue
        // 真实 DSH 节点语义：已存在同名文件生成 -1 副本而非覆盖
        let fname = nm[1]
        if (fsFiles.has(`${dir.replace(/\/+$/, '')}/${fname}`)) {
          const m = /^(.*?)(\.[^.]+)?$/.exec(fname)
          fname = `${m[1]}-1${m[2] || ''}`
        }
        const p = `${dir.replace(/\/+$/, '')}/${fname}`
        ensureDir(dir)
        fsFiles.set(p, content)
        saved.push(p)
      }
      if (!saved.length) return json(400, { ok: false, error: 'no files parsed' })
      return json(200, { ok: true, data: { files: saved.map((p) => ({ name: p.split('/').pop(), path: p, size: 0 })) } })
    }
    if (req.method === 'POST' && url.startsWith('/api/v1/fs/mkdir')) {
      const parent = String(body?.path || '')
      const name = String(body?.name || '')
      const p = `${parent.replace(/\/+$/, '')}/${name}`
      if (fsDirs.has(p)) return json(200, { ok: false, error: 'directory already exists' })
      ensureDir(p)
      return json(200, { ok: true, data: { path: p, name } })
    }
    if (req.method === 'DELETE' && url.startsWith('/api/v1/fs/remove')) {
      const fp = decodeURIComponent((url.match(/[?&]path=([^&]*)/) || [])[1] || '')
      if (!fsFiles.delete(fp)) return json(404, { ok: false, error: 'no such file' })
      return json(200, { ok: true })
    }
    // 节点连通性 ping（直发路径先探活）——项目 A 的 nodeStatus=ok 依赖这里
    if (req.method === 'GET' && url.startsWith('/api/v1/system/status')) {
      return json(200, { ok: true, data: { status: 'ok', version: 'stub' } })
    }
    const sid = (url.match(/\/api\/v1\/sessions\/([^/?]+)/) || [])[1]
    if (req.method === 'POST' && url === '/api/v1/sessions') {
      sessionCounter++
      const id = `stub-bl-${sessionCounter}`
      sessions.set(id, { prompts: [] })
      return json(200, { ok: true, data: { sessionId: id } })
    }
    if (sid && sessions.has(sid)) {
      const st = sessions.get(sid)
      if (req.method === 'GET' && url === `/api/v1/sessions/${sid}`) return json(200, { ok: true, data: { sessionId: sid, status: 'idle', cwd: WS_A } })
      if (req.method === 'GET' && url.startsWith(`/api/v1/sessions/${sid}/history`)) {
        const last = st.prompts[st.prompts.length - 1] || ''
        return json(200, { ok: true, data: { messages: [{ role: 'user', content: last }, { role: 'assistant', content: 'stub 已完成' }] } })
      }
      if (req.method === 'POST' && url.startsWith(`/api/v1/sessions/${sid}/prompt-stream`)) {
        st.prompts.push(body?.prompt || '')
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(`event: delta\ndata: ${JSON.stringify({ delta: 'stub 完成' })}\n\n`)
        res.write(`event: turn_end\ndata: ${JSON.stringify({ reason: 'end_turn' })}\n\n`)
        res.write(`event: done\ndata: [DONE]\n\n`)
        res.end()
        return
      }
    }
    json(404, { ok: false, error: 'Endpoint not found' })
  })
})

// ---------------- 子进程管理 ----------------
const procs = []
let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  try { stub.close() } catch { /* ignore */ }
  for (const p of procs) {
    try { process.kill(-p.pid, 'SIGKILL') } catch { /* group not created */ }
    try { p.kill('SIGKILL') } catch { /* ignore */ }
  }
  for (const d of dataDirs) { try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
  try { rmSync(STATE_PATH, { force: true }) } catch { /* ignore */ }
  log('\n[qa] 环境已清理（stub / server / mock ONENAT / 临时数据目录）')
}
const dataDirs = []
process.on('exit', cleanup)
process.on('SIGTERM', () => { cleanup(); process.exit(0) })
process.on('SIGINT', () => { cleanup(); process.exit(0) })

let COOKIE = ''
async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(COOKIE ? { Cookie: COOKIE } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed; try { parsed = JSON.parse(text) } catch { parsed = undefined }
  return { status: res.status, json: parsed }
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'workbuddy-task8-qa-'))
  dataDirs.push(dataDir)
  log(`\n== TASK-8 浏览器验收环境（server:${PORT} stub:${STUB_PORT} mock:${MOCK_PORT}）==\n`)
  log(`[qa] 临时数据目录 ${dataDir}`)

  // 1) stub DSH
  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r))
  log(`[qa] stub DSH 节点已监听 http://127.0.0.1:${STUB_PORT}/api/v1`)

  // 2) mock ONENAT
  const mock = spawn(process.execPath, [join(ROOT, 'scripts', 'mock-onenat.cjs')], {
    cwd: ROOT,
    env: { ...process.env, MOCK_ONENAT_PORT: String(MOCK_PORT), MOCK_ONENAT_KEY: ONENAT_KEY },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  procs.push(mock)
  mock.stderr.on('data', (d) => process.stderr.write(`[mock-onenat] ${d}`))
  // mock 的路由是精确匹配（query 不参与路由），鉴权走 Authorization: Bearer
  await waitFor(async () => (await fetch(`${ONENAT_BASE}/api/v1/resources`, { headers: { Authorization: `Bearer ${ONENAT_KEY}` } })).ok, 'mock ONENAT 就绪')
  log(`[qa] mock ONENAT 已就绪 ${ONENAT_BASE}`)

  // 3) 真实服务端（dist/server.js）
  const server = spawn(process.execPath, [
    join(ROOT, 'dist', 'server.js'), '--port', String(PORT), '--data', dataDir, '--quiet',
    '--onenat-base-url', ONENAT_BASE, '--onenat-api-key', ONENAT_KEY,
  ], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], detached: true })
  procs.push(server)
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))
  await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok, 'server 就绪')
  log(`[qa] server 已就绪 ${BASE}${PREFIX}/`)

  // 4) 登录（默认管理员）
  const loginRes = await fetch(`${BASE}${PREFIX}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'workbuddy', password: 'workbuddy-admin' }),
  })
  COOKIE = (loginRes.headers.get('set-cookie') || '').split(';')[0]
  check('登录成功（workbuddy）', loginRes.ok, `status=${loginRes.status}`)

  // 5) 项目 A：可达 stub 节点 + 3 条不同状态待办
  const projA = (await req('POST', `${PREFIX}/api/projects`, {
    name: 'TASK8 验收项目A',
    dshRef: { kind: 'direct', apiBaseUrl: STUB_BASE },
    workspace: WS_A,
  })).json?.data
  check('项目 A 创建', Boolean(projA?.id), projA?.id ? `id=${projA.id}` : '')
  const initRes = await req('POST', `${PREFIX}/api/projects/${projA.id}/backlog/init`, { sample: false, updateInstruction: true })
  check('项目 A backlog 初始化', initRes.json?.ok === true, initRes.json?.error || '')
  let listA = (await req('GET', `${PREFIX}/api/projects/${projA.id}/backlog`)).json?.data
  const statuses = listA?.statuses || ['To Do', 'In Progress', 'Done']
  check('backlog 配置就绪（statuses）', Boolean(listA?.initialized) && statuses.length >= 3, statuses.join(' / '))

  const seedItems = [
    { title: '实现「进入工作台」按钮', priority: 'high', status: statuses[0], labels: ['task8', 'qa'] },
    { title: '离线项目入口可用性验证', priority: 'medium', status: statuses[1] || statuses[0], labels: ['task8'] },
    { title: '历史已完成待办示例', priority: 'low', status: statuses[2] || statuses[0], labels: ['task8'] },
  ]
  const itemIds = []
  for (const it of seedItems) {
    const created = await req('POST', `${PREFIX}/api/projects/${projA.id}/backlog/items`, {
      title: it.title, description: `${it.title}（TASK-8 QA 造数）`, acceptance: ['可点击'], labels: it.labels, priority: it.priority,
    })
    const itemId = created.json?.data?.itemId
    if (itemId) {
      itemIds.push(itemId)
      const put = await req('PUT', `${PREFIX}/api/projects/${projA.id}/backlog/items/${itemId}`, { status: it.status })
      check(`待办「${it.title}」创建并置状态 ${it.status}`, created.json?.ok === true && put.json?.ok === true, put.json?.error || '')
    } else {
      check(`待办「${it.title}」创建`, false, created.json?.error || '')
    }
  }

  // 6) 项目 B：不可达节点（离线按钮仍可用场景）
  const projB = (await req('POST', `${PREFIX}/api/projects`, {
    name: 'TASK8 不可达项目',
    dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:1/api/v1' },
    workspace: WS_B,
  })).json?.data
  check('项目 B（不可达节点）创建', Boolean(projB?.id), projB?.id ? `id=${projB.id}` : '')

  // 7) 聚合总览语义自检：A 正常、B 隔离
  const overview = (await req('GET', `${PREFIX}/api/backlog/overview`)).json?.data || []
  const oA = overview.find((x) => x.projectId === projA.id)
  const oB = overview.find((x) => x.projectId === projB.id)
  check('overview：项目 A nodeStatus=ok 且有 3 条待办', oA?.nodeStatus === 'ok' && (oA?.items?.length || 0) === 3, `items=${oA?.items?.length}`)
  check('overview：项目 B nodeStatus=unreachable（离线分组）', oB?.nodeStatus === 'unreachable', `status=${oB?.nodeStatus}`)

  const state = {
    baseUrl: `${BASE}${PREFIX}/`,
    origin: BASE,
    prefix: PREFIX,
    ports: { server: PORT, stub: STUB_PORT, mockOnenat: MOCK_PORT },
    projectA: { id: projA.id, name: projA.name, workspace: WS_A, itemIds },
    projectB: { id: projB.id, name: projB.name, workspace: WS_B },
    statuses,
    dataDir,
    startedAt: new Date().toISOString(),
  }
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8')
  log(`\n[qa] 造数完成，state 已写入 ${STATE_PATH}`)
  log(`QA_READY ${JSON.stringify(state)}`)

  if (CHECK_ONLY) {
    log(`\n== 种子自检结果：${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`} ==\n`)
    cleanup()
    process.exit(failures === 0 ? 0 : 1)
  }
  log('\n[qa] 环境保持运行中（SIGTERM/SIGINT 退出并清理）。等待浏览器验收…')
  await new Promise(() => {})
}

main().catch((err) => {
  console.error('[qa] 环境启动失败:', err)
  cleanup()
  process.exit(1)
})
