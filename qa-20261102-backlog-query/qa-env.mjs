#!/usr/bin/env node
/**
 * Backlog 查询能力（docs/design-backlog-query-filters.md）浏览器验收环境编排（Lead 自用，非 smoke）
 *
 * 组成：
 *   - stub DSH 节点（内存 FS + 即完成会话）      :18141
 *   - mock ONENAT                                :18142（scripts/mock-onenat.cjs）
 *   - 真实服务端 dist/server.js --data <临时目录> :18140
 *
 * 造数（直接写 Backlog.md 兼容 frontmatter 到 stub 内存 FS，覆盖查询全维度）：
 *   项目 A「查询验收项目A」10 条：status 三态、priority、type、labels、assignee、milestone、
 *     project(组件)、parent_task_id、dependencies（完成/未完成/缺失）、正文检索词。
 *   项目 B「查询验收项目B」3 条：用于 overview 跨项目聚合 + matched=0 场景。
 *
 * 运行：
 *   node qa-20261102-backlog-query/qa-env.mjs            # 起环境并保持运行（写 state）
 *   node qa-20261102-backlog-query/qa-env.mjs --check    # 只做 API 层种子自检后退出
 * 停止：Ctrl-C / SIGTERM（自动 kill 子进程 + 删临时目录）
 * 输出：state JSON（默认 /tmp/backlog-query-qa-state.json），供 ego-browser 脚本读取。
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
const PORT = Number(argOf('--port', '18140'))
const STUB_PORT = Number(argOf('--stub-port', '18141'))
const MOCK_PORT = Number(argOf('--mock-port', '18142'))
const STATE_PATH = argOf('--state', '/tmp/backlog-query-qa-state.json')
const CHECK_ONLY = argv.includes('--check')
const PREFIX = '/onenat-workbuddy'
const BASE = `http://127.0.0.1:${PORT}`
const STUB_BASE = `http://127.0.0.1:${STUB_PORT}/api/v1`
const ONENAT_KEY = 'onk-mock-key-000'
const ONENAT_BASE = `http://127.0.0.1:${MOCK_PORT}`

const WS_A = '/tmp/blq-qa-ws-a'
const WS_B = '/tmp/blq-qa-ws-b'
const STATUSES = ['To Do', 'In Progress', 'Done']

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

function makeStubHandler() {
  return (req, res) => {
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
        if (!/[?&]all=1/.test(url)) return json(200, { ok: true, data: { path: dir, home: '', entries: [], truncated: false } })
        const prefix = dir.replace(/\/+$/, '') + '/'
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
          let fname = nm[1]
          // 真实 DSH 节点语义：已存在同名文件生成 -1 副本而非覆盖
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
}
const stub = createServer(makeStubHandler())

// ---------------- 造数：直接写 Backlog.md 兼容文件 ----------------
const CONFIG_YML = `project_name: "blq-qa"
default_status: "To Do"
statuses: ["To Do", "In Progress", "Done"]
labels: []
date_format: yyyy-mm-dd
default_editor: "vi"
auto_open_browser: false
default_port: 6420
task_prefix: task
`

/** 造一条待办的 markdown（frontmatter 覆盖查询全维度） */
function taskMd(o) {
  const lines = ['---', `id: ${o.id}`, `title: ${JSON.stringify(o.title)}`, `status: ${o.status}`]
  lines.push('assignee:')
  for (const a of o.assignees || []) lines.push(`  - ${a}`)
  lines.push(`created_date: '${o.created || '2026-11-01T00:00:00Z'}'`)
  lines.push(`updated_date: '${o.updated || '2026-11-01T00:00:00Z'}'`)
  lines.push('labels:')
  for (const l of o.labels || []) lines.push(`  - ${l}`)
  lines.push('dependencies:')
  for (const d of o.dependencies || []) lines.push(`  - ${d}`)
  if (o.priority) lines.push(`priority: ${o.priority}`)
  if (o.type) lines.push(`type: ${o.type}`)
  if (o.milestone) lines.push(`milestone: ${o.milestone}`)
  if (o.project) lines.push(`project: ${o.project}`)
  if (o.parent) lines.push(`parent_task_id: ${o.parent}`)
  if (o.ordinal !== undefined) lines.push(`ordinal: ${o.ordinal}`)
  lines.push('---', '', '## Description', '', '<!-- SECTION:DESCRIPTION:BEGIN -->', o.desc || '', '<!-- SECTION:DESCRIPTION:END -->', '')
  lines.push('## Acceptance Criteria', '<!-- AC:BEGIN -->', '- [ ] #1 验收项 A', '- [x] #2 验收项 B', '<!-- AC:END -->', '')
  return lines.join('\n')
}

function seedWorkspace(ws, items) {
  ensureDir(ws)
  ensureDir(`${ws}/backlog`)
  ensureDir(`${ws}/backlog/tasks`)
  fsFiles.set(`${ws}/backlog/config.yml`, CONFIG_YML)
  for (const it of items) {
    const fileName = `${it.id} - ${String(it.title).replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '-').slice(0, 60)}.md`
    fsFiles.set(`${ws}/backlog/tasks/${fileName}`, taskMd(it))
  }
}

const ITEMS_A = [
  { id: 'task-1', title: '登录接口联调', status: 'To Do', priority: 'high', type: 'feature', labels: ['backend', 'p0'], assignees: ['@alice'], milestone: 'M-1', project: 'web', ordinal: 1000, desc: '需要对接 token 过期刷新与登录失败重试。' },
  { id: 'task-2', title: '支付回调幂等', status: 'In Progress', priority: 'medium', type: 'feature', labels: ['backend'], assignees: ['bob'], milestone: 'M-2', project: 'api', ordinal: 2000, desc: '支付回调重复推送要幂等处理。' },
  { id: 'task-3', title: '修复崩溃栈', status: 'Done', priority: 'low', type: 'bug', labels: ['frontend'], milestone: 'M-1', ordinal: 3000, desc: '首页崩溃栈 NullPointer。' },
  { id: 'task-4', title: '依赖未完成的改造', status: 'To Do', priority: 'high', type: 'enhancement', labels: ['backend', 'p0'], dependencies: ['task-2'], milestone: 'M-2', project: 'api', ordinal: 4000, desc: '依赖支付回调先完成。' },
  { id: 'task-5', title: '依赖已完成即可开工', status: 'To Do', priority: 'medium', type: 'chore', labels: ['ops'], dependencies: ['task-3'], ordinal: 5000, desc: '依赖崩溃修复完成。' },
  { id: 'task-6', title: '依赖缺失的待办', status: 'To Do', type: 'task', labels: ['risk'], dependencies: ['task-404'], ordinal: 6000, desc: '依赖条目已删除。' },
  { id: 'task-7', title: '子任务：文档补充', status: 'In Progress', type: 'docs', labels: ['docs'], assignees: ['@alice'], parent: 'task-10', milestone: 'M-3', ordinal: 7000, desc: '父任务 task-10 的子任务。' },
  { id: 'task-8', title: '无标签无指派的散件事项', status: 'To Do', type: 'task', ordinal: 8000, desc: '未指派、无标签、无里程碑。' },
  { id: 'task-9', title: '已完成的历史事项', status: 'Done', priority: 'medium', type: 'bug', labels: ['backend'], assignees: ['bob'], milestone: 'M-2', ordinal: 9000, desc: '历史已完成。' },
  { id: 'task-10', title: '父任务：文档体系', status: 'In Progress', priority: 'low', type: 'docs', labels: ['docs'], milestone: 'M-3', ordinal: 10000, desc: '文档体系父任务。' },
]

const ITEMS_B = [
  { id: 'task-1', title: 'B 项目：日志采集', status: 'To Do', priority: 'high', type: 'chore', labels: ['ops'], assignees: ['@alice'], milestone: 'M-1', ordinal: 1000, desc: '日志采集脚本。' },
  { id: 'task-2', title: 'B 项目：告警去噪', status: 'Done', type: 'feature', labels: ['ops'], ordinal: 2000, desc: '告警去噪已完成。' },
  { id: 'task-3', title: 'B 项目：容量评估', status: 'To Do', type: 'spike', labels: ['ops', 'p0'], ordinal: 3000, desc: '容量评估 spike。' },
  // 分页验收（>50 条）：看板 pageSize=50，第 2 页靠「显示更多」→ maxCount/skip 窗口
  ...Array.from({ length: 60 }, (_, i) => ({
    id: 'task-' + (i + 4),
    title: '批量分页条目 ' + String(i + 1).padStart(2, '0'),
    status: i % 3 === 0 ? 'Done' : i % 3 === 1 ? 'In Progress' : 'To Do',
    type: 'task',
    labels: ['bulk'],
    ordinal: (i + 4) * 1000,
    desc: '用于验证 maxCount/skip 分页窗口的批量条目。',
  })),
]

// ---------------- 子进程管理 ----------------
const procs = []
const dataDirs = []
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
async function createProject(name, workspace) {
  const r = await req('POST', `${PREFIX}/api/projects`, { name, dshRef: { kind: 'direct', apiBaseUrl: STUB_BASE }, workspace })
  return r.json?.data
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'workbuddy-blq-qa-'))
  dataDirs.push(dataDir)
  log(`\n== Backlog 查询能力浏览器验收环境（server:${PORT} stub:${STUB_PORT} mock:${MOCK_PORT}）==\n`)
  log(`[qa] 临时数据目录 ${dataDir}`)

  seedWorkspace(WS_A, ITEMS_A)
  seedWorkspace(WS_B, ITEMS_B)
  log(`[qa] 已造数：A=${ITEMS_A.length} 条 / B=${ITEMS_B.length} 条（stub 内存 FS）`)

  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r))
  log(`[qa] stub DSH 已监听 ${STUB_BASE}`)

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

  const server = spawn(process.execPath, [
    join(ROOT, 'dist', 'server.js'), '--port', String(PORT), '--data', dataDir, '--quiet',
    '--onenat-base-url', ONENAT_BASE, '--onenat-api-key', ONENAT_KEY,
  ], {
    cwd: ROOT,
    // 直连 stub 节点是 127.0.0.1：与 scripts/backlog-e2e.mjs 一致显式放行（生产默认拒绝私网直连）
    env: { ...process.env, WORKBUDDY_ALLOW_PRIVATE_DIRECT: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  })
  procs.push(server)
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))
  await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok, 'server 就绪')
  log(`[qa] server 已就绪 ${BASE}${PREFIX}/`)

  const loginRes = await fetch(`${BASE}${PREFIX}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'workbuddy', password: 'workbuddy-admin' }),
  })
  COOKIE = (loginRes.headers.get('set-cookie') || '').split(';')[0]
  check('登录成功（workbuddy）', loginRes.ok && COOKIE.length > 0, `status=${loginRes.status}`)

  const projA = await createProject('查询验收项目A', WS_A)
  const projB = await createProject('查询验收项目B', WS_B)
  check('项目 A/B 创建', Boolean(projA?.id) && Boolean(projB?.id), `A=${projA?.id} B=${projB?.id}`)

  // API 层种子自检（只验与 UI 强相关的几条，详细断言在 scripts/backlog-e2e.mjs）
  const listA = (await req('GET', `${PREFIX}/api/projects/${projA.id}/backlog`)).json
  check('A 列表：initialized + 10 条 + statuses 3', listA?.ok === true && listA?.data?.initialized === true && listA?.data?.items?.length === 10 && (listA?.data?.statuses || []).length === 3, `items=${listA?.data?.items?.length}`)
  const readyQ = (await req('GET', `${PREFIX}/api/projects/${projA.id}/backlog?ready=1`)).json
  check('A ready=1：命中就绪条目', readyQ?.ok === true && Array.isArray(readyQ?.data?.items) && readyQ.data.items.every((it) => it.isReady === true), `n=${readyQ?.data?.items?.length}`)
  const facetQ = (await req('GET', `${PREFIX}/api/projects/${projA.id}/backlog`)).json
  check('A facets：labels/priorities/types/milestones 有值', Boolean(facetQ?.data?.facets?.labels?.length) && Boolean(facetQ?.data?.facets?.priorities?.length) && Boolean(facetQ?.data?.facets?.types?.length) && Boolean(facetQ?.data?.facets?.milestones?.length))
  check('A 回包不含 searchText', !JSON.stringify(facetQ || {}).includes('searchText'))
  const ov = (await req('GET', `${PREFIX}/api/backlog/overview?openOnly=1`)).json
  const ovA = (ov?.data || []).find((x) => x.projectId === projA.id)
  const ovB = (ov?.data || []).find((x) => x.projectId === projB.id)
  check('overview：A/B 分组在列 + summary/openOnly', Boolean(ovA) && Boolean(ovB) && ov?.summary && (ovA?.matched || 0) > 0, `A.matched=${ovA?.matched}`)

  const state = {
    baseUrl: `${BASE}${PREFIX}/`,
    origin: BASE,
    prefix: PREFIX,
    ports: { server: PORT, stub: STUB_PORT, mockOnenat: MOCK_PORT },
    statuses: STATUSES,
    projectA: { id: projA?.id, name: projA?.name, workspace: WS_A, total: ITEMS_A.length },
    projectB: { id: projB?.id, name: projB?.name, workspace: WS_B, total: ITEMS_B.length },
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
