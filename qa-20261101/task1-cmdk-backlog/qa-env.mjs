#!/usr/bin/env node
/**
 * TASK-1「backlog 条目接入 ⌘K 全局检索」浏览器端验收环境编排（独立 QA，非 smoke）
 *
 * 改造自 scripts/qa-backlog-entry.mjs（只复制、不改原文件），新增：
 *   - 第二个可达项目 C（同 stub 节点、另一 workspace、init + 2 条待办）→ 验证跨项目命中
 *   - 可达但未初始化 backlog 的项目 D（同一 stub 节点）→ 其条目（不存在）不得进 ⌘K
 *   - 「不可达节点」项目 B：先在同一 stub 上 init + 建条目，再把 dshRef 改成黑洞地址 →
 *     条目物理存在但 overview 中 nodeStatus=unreachable → 不得进 ⌘K
 *   - 「归档」项目 E：先 init + 建条目，再归档 → overview 中 nodeStatus=archived → 不得进 ⌘K
 *   - 「慢节点」项目 S：指向 18122（所有 /fs/* 请求延迟 SLOW_MS）且不 init →
 *     使 GET /api/backlog/overview 耗时约 2×SLOW_MS，用于验证「面板打开不被 overview 阻塞 +
 *     返回后「待办」组自动补入（懒加载）」
 *
 * 组成（端口可用 --port/--stub-port/--slow-port/--mock-port 覆盖）：
 *   - stub DSH 节点      :18121  内存 FS + 即完成会话（两端口共享同一份内存 FS）
 *   - 慢速 stub DSH 节点 :18122  同一实现，/api/v1/fs/* 延迟 --slow-ms（默认 2500ms）
 *   - mock ONENAT        :18125  spawn scripts/mock-onenat.cjs
 *   - 真实服务端        :18120   node dist/server.js --port 18120 --data <临时目录> \
 *                               --onenat-base-url http://127.0.0.1:18125 --onenat-api-key onk-mock-key-000
 *
 * 运行：
 *   node qa-20261101/task1-cmdk-backlog/qa-env.mjs            # 起环境并保持运行，ready 后写 state 文件
 *   node qa-20261101/task1-cmdk-backlog/qa-env.mjs --check    # 只做 API 层种子自检，随后清理退出
 *   SIGTERM/SIGINT/Ctrl-C 会 kill 所有子进程并删除临时数据目录（含 state 文件）
 *
 * 输出：ready 时打印 `QA_READY {json}`，并把同一份 JSON 写到 --state（默认 /tmp/task1-cmdk-qa-state.json），
 *       供 ego-browser 脚本读取（ego-browser 脚本不继承 shell 环境变量）。
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argv = process.argv.slice(2)
const argOf = (flag, dflt) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const PORT = Number(argOf('--port', '18120'))
const STUB_PORT = Number(argOf('--stub-port', '18121'))
const SLOW_PORT = Number(argOf('--slow-port', '18122'))
const MOCK_PORT = Number(argOf('--mock-port', '18125'))
const SLOW_MS = Number(argOf('--slow-ms', '2500'))
const STATE_PATH = argOf('--state', '/tmp/task1-cmdk-qa-state.json')
const CHECK_ONLY = argv.includes('--check')
const PREFIX = '/onenat-workbuddy'
const BASE = `http://127.0.0.1:${PORT}`
const STUB_BASE = `http://127.0.0.1:${STUB_PORT}/api/v1`
const SLOW_BASE = `http://127.0.0.1:${SLOW_PORT}/api/v1`
const ONENAT_KEY = 'onk-mock-key-000'
const ONENAT_BASE = `http://127.0.0.1:${MOCK_PORT}`

// 各项目 workspace（stub 内存 FS，互不影响；都不落真实磁盘）
const WS_A = '/tmp/task1-ws-a'   // 可达：3 条不同状态待办
const WS_C = '/tmp/task1-ws-c'   // 可达：第二个项目，2 条待办（跨项目）
const WS_D = '/tmp/task1-ws-d'   // 可达但未初始化 backlog（不 mkdir → 不 init）
const WS_B = '/tmp/task1-ws-b'   // 先可达 init+建条目，随后 dshRef 改成黑洞 → unreachable
const WS_E = '/tmp/task1-ws-e'   // 先可达 init+建条目，随后归档 → archived
const WS_S = '/tmp/task1-ws-s'   // 慢节点（不 init，仅制造 overview 延迟）

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

function makeStubHandler(opts = {}) {
  const slowMs = Number(opts.slowMs || 0)
  return (req, res) => {
    const url = req.url || ''
    // 慢节点：只延迟 fs/*（overview 走 readConfig → fs/download 与 fs/list），每次延迟 slowMs
    const isFs = url.startsWith('/api/v1/fs/')
    const delay = slowMs && isFs ? slowMs : 0
    const run = () => {
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
        // 节点连通性 ping（直连路径先探活）
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
    }
    if (delay) setTimeout(run, delay)
    else run()
  }
}
const stub = createServer(makeStubHandler({ slowMs: 0 }))
const slowStub = createServer(makeStubHandler({ slowMs: SLOW_MS }))

// ---------------- 子进程管理 ----------------
const procs = []
const dataDirs = []
let cleaned = false
function cleanup() {
  if (cleaned) return
  cleaned = true
  try { stub.close() } catch { /* ignore */ }
  try { slowStub.close() } catch { /* ignore */ }
  for (const p of procs) {
    try { process.kill(-p.pid, 'SIGKILL') } catch { /* group not created */ }
    try { p.kill('SIGKILL') } catch { /* ignore */ }
  }
  for (const d of dataDirs) { try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ } }
  try { rmSync(STATE_PATH, { force: true }) } catch { /* ignore */ }
  log('\n[qa] 环境已清理（stub / slow-stub / server / mock ONENAT / 临时数据目录）')
}
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
async function createProject(name, apiBase, workspace) {
  const r = await req('POST', `${PREFIX}/api/projects`, { name, dshRef: { kind: 'direct', apiBaseUrl: apiBase }, workspace })
  return r.json?.data
}
async function initBacklog(pid) {
  const r = await req('POST', `${PREFIX}/api/projects/${pid}/backlog/init`, { sample: false, updateInstruction: true })
  return r.json
}
async function addItem(pid, title, status, labels, description) {
  const created = await req('POST', `${PREFIX}/api/projects/${pid}/backlog/items`, {
    title, description: description || `${title}（TASK-1 ⌘K QA 造数）`, acceptance: ['可从 ⌘K 检索到'], labels: labels || [], priority: 'medium',
  })
  const itemId = created.json?.data?.itemId
  if (!itemId) return { ok: false, error: created.json?.error || 'no itemId' }
  const put = await req('PUT', `${PREFIX}/api/projects/${pid}/backlog/items/${itemId}`, { status })
  return { ok: created.json?.ok === true && put.json?.ok === true, itemId, error: put.json?.error || '' }
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'workbuddy-task1-qa-'))
  dataDirs.push(dataDir)
  log(`\n== TASK-1 ⌘K backlog 浏览器验收环境（server:${PORT} stub:${STUB_PORT} slow:${SLOW_PORT} mock:${MOCK_PORT} slowMs:${SLOW_MS}）==\n`)
  log(`[qa] 临时数据目录 ${dataDir}`)

  // 1) stub DSH（快 / 慢两个端口共享内存 FS）
  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r))
  await new Promise((r) => slowStub.listen(SLOW_PORT, '127.0.0.1', r))
  log(`[qa] stub DSH 已监听 http://127.0.0.1:${STUB_PORT}/api/v1（快）与 :${SLOW_PORT}（fs 延迟 ${SLOW_MS}ms）`)

  // 2) mock ONENAT
  const mock = spawn(process.execPath, [join(ROOT, 'scripts', 'mock-onenat.cjs')], {
    cwd: ROOT,
    env: { ...process.env, MOCK_ONENAT_PORT: String(MOCK_PORT), MOCK_ONENAT_KEY: ONENAT_KEY },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  procs.push(mock)
  mock.stderr.on('data', (d) => process.stderr.write(`[mock-onenat] ${d}`))
  await waitFor(async () => (await fetch(`${ONENAT_BASE}/api/v1/resources`, { headers: { Authorization: `Bearer ${ONENAT_KEY}` } })).ok, 'mock ONENAT 就绪')
  log(`[qa] mock ONENAT 已就绪 ${ONENAT_BASE}`)

  // 3) 真实服务端（dist/server.js，QA 不重新 build）
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
  check('登录成功（workbuddy）', loginRes.ok && COOKIE.length > 0, `status=${loginRes.status}`)

  // 5) 项目 A：可达 stub + 3 条不同状态待办
  const projA = await createProject('TASK1 验收项目A', STUB_BASE, WS_A)
  check('项目 A 创建', Boolean(projA?.id), projA?.id ? `id=${projA.id}` : '')
  check('项目 A backlog 初始化', (await initBacklog(projA.id))?.ok === true)
  let listA = (await req('GET', `${PREFIX}/api/projects/${projA.id}/backlog`)).json?.data
  const statuses = listA?.statuses || ['To Do', 'In Progress', 'Done']
  check('backlog 配置就绪（statuses）', Boolean(listA?.initialized) && statuses.length >= 3, statuses.join(' / '))
  const aItems = [
    { title: '接入 cmdk 全局检索入口', status: statuses[0], labels: ['cmdk', 'qa'] },
    { title: '跨项目命中校验', status: statuses[1] || statuses[0], labels: ['cmdk'] },
    { title: '已完成历史待办', status: statuses[2] || statuses[0], labels: ['cmdk'] },
  ]
  const aIds = []
  for (const it of aItems) {
    const r = await addItem(projA.id, it.title, it.status, it.labels)
    if (r.ok) aIds.push(r.itemId)
    check(`A 待办「${it.title}」置状态 ${it.status}`, r.ok, r.error || `itemId=${r.itemId}`)
  }

  // 6) 项目 C：同一可达 stub、另一 workspace + 2 条待办（跨项目命中）
  const projC = await createProject('TASK1 跨项目C', STUB_BASE, WS_C)
  check('项目 C 创建（第二可达项目）', Boolean(projC?.id), projC?.id ? `id=${projC.id}` : '')
  check('项目 C backlog 初始化', (await initBacklog(projC.id))?.ok === true)
  const cItems = [
    { title: '跨项目同名编号条目', status: statuses[0], labels: ['cross'] },
    { title: '跨项目独有标题片段', status: statuses[1] || statuses[0], labels: ['cross'] },
  ]
  const cIds = []
  for (const it of cItems) {
    const r = await addItem(projC.id, it.title, it.status, it.labels)
    if (r.ok) cIds.push(r.itemId)
    check(`C 待办「${it.title}」置状态 ${it.status}`, r.ok, r.error || `itemId=${r.itemId}`)
  }

  // 7) 项目 D：可达但未初始化 backlog（不 mkdir、不 init）
  const projD = await createProject('TASK1 未初始化项目', STUB_BASE, WS_D)
  check('项目 D 创建（可达但未初始化 backlog）', Boolean(projD?.id), projD?.id ? `id=${projD.id}` : '')

  // 8) 项目 B：先 init+建条目，再把节点改成黑洞 → overview 中 unreachable，条目不得进 ⌘K
  const projB = await createProject('TASK1 不可达项目', STUB_BASE, WS_B)
  check('项目 B 创建（暂可达）', Boolean(projB?.id), projB?.id ? `id=${projB.id}` : '')
  check('项目 B backlog 初始化', (await initBacklog(projB.id))?.ok === true)
  const bItem = await addItem(projB.id, '不可达节点残留待办', statuses[0], ['ghost'])
  check('项目 B 残留条目创建', bItem.ok, bItem.error || `itemId=${bItem.itemId}`)
  const bPatch = await req('PUT', `${PREFIX}/api/projects/${projB.id}`, {
    name: 'TASK1 不可达项目', workspace: WS_B, dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:1/api/v1' },
  })
  check('项目 B 节点改为黑洞地址（→ unreachable）', bPatch.json?.ok === true, bPatch.json?.error || '')

  // 9) 项目 E：先 init+建条目，再归档 → overview 中 archived，条目不得进 ⌘K
  const projE = await createProject('TASK1 归档项目', STUB_BASE, WS_E)
  check('项目 E 创建（暂可达）', Boolean(projE?.id), projE?.id ? `id=${projE.id}` : '')
  check('项目 E backlog 初始化', (await initBacklog(projE.id))?.ok === true)
  const eItem = await addItem(projE.id, '归档项目残留待办', statuses[0], ['ghost'])
  check('项目 E 残留条目创建', eItem.ok, eItem.error || `itemId=${eItem.itemId}`)
  const eArchive = await req('POST', `${PREFIX}/api/projects/${projE.id}/archive`, {})
  check('项目 E 归档', eArchive.json?.ok === true, eArchive.json?.error || '')

  // 10) 项目 S：慢节点（fs 延迟）且不 init → 只用于给 overview 制造延迟
  const projS = await createProject('TASK1 慢节点项目', SLOW_BASE, WS_S)
  check('项目 S 创建（慢节点，未初始化）', Boolean(projS?.id), projS?.id ? `id=${projS.id}` : '')

  // 11) overview 语义自检（含慢节点耗时测量）
  const t0 = Date.now()
  const overview = (await req('GET', `${PREFIX}/api/backlog/overview`)).json?.data || []
  const overviewMs = Date.now() - t0
  const oA = overview.find((x) => x.projectId === projA.id)
  const oC = overview.find((x) => x.projectId === projC.id)
  const oD = overview.find((x) => x.projectId === projD.id)
  const oB = overview.find((x) => x.projectId === projB.id)
  const oE = overview.find((x) => x.projectId === projE.id)
  const oS = overview.find((x) => x.projectId === projS.id)
  check('overview：A ok/initialized/3 条', oA?.nodeStatus === 'ok' && oA?.initialized === true && (oA?.items?.length || 0) === 3, `items=${oA?.items?.length}`)
  check('overview：C ok/initialized/2 条', oC?.nodeStatus === 'ok' && oC?.initialized === true && (oC?.items?.length || 0) === 2, `items=${oC?.items?.length}`)
  check('overview：D ok 但 initialized=false', oD?.nodeStatus === 'ok' && oD?.initialized === false && (oD?.items?.length || 0) === 0)
  check('overview：B nodeStatus=unreachable（条目不返回）', oB?.nodeStatus === 'unreachable' && (oB?.items?.length || 0) === 0, `status=${oB?.nodeStatus}`)
  check('overview：E nodeStatus=archived（条目不返回）', oE?.nodeStatus === 'archived' && (oE?.items?.length || 0) === 0, `status=${oE?.nodeStatus}`)
  check('overview：S 慢节点 ok 但未初始化', oS?.nodeStatus === 'ok' && oS?.initialized === false, `status=${oS?.nodeStatus} init=${oS?.initialized}`)
  check(`overview 总耗时被慢节点拖慢（>= ${Math.round(SLOW_MS * 1.6)}ms）`, overviewMs >= SLOW_MS * 1.6, `overviewMs=${overviewMs}`)
  const expectedCmdkItems = (oA?.items?.length || 0) + (oC?.items?.length || 0)
  check('⌘K 可见待办条目数 = A+C = 5（排除 D/B/E/S）', expectedCmdkItems === 5, `n=${expectedCmdkItems}`)

  const state = {
    baseUrl: `${BASE}${PREFIX}/`,
    origin: BASE,
    prefix: PREFIX,
    ports: { server: PORT, stub: STUB_PORT, slowStub: SLOW_PORT, mockOnenat: MOCK_PORT },
    slowMs: SLOW_MS,
    overviewMs,
    statuses,
    projectA: { id: projA.id, name: projA.name, workspace: WS_A, itemIds: aIds, items: aItems.map((x, i) => ({ ...x, itemId: aIds[i] })) },
    projectC: { id: projC.id, name: projC.name, workspace: WS_C, itemIds: cIds, items: cItems.map((x, i) => ({ ...x, itemId: cIds[i] })) },
    projectD: { id: projD.id, name: projD.name, workspace: WS_D },
    projectB: { id: projB.id, name: projB.name, workspace: WS_B, itemId: bItem.itemId },
    projectE: { id: projE.id, name: projE.name, workspace: WS_E, itemId: eItem.itemId },
    projectS: { id: projS.id, name: projS.name, workspace: WS_S },
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
