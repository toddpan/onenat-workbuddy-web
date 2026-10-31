#!/usr/bin/env node
/**
 * Backlog 集成端到端验证（B1-B4/B7 后端闭环）：
 *   npm run build && node scripts/backlog-e2e.mjs
 *
 * 场景（stub DSH 节点内存 FS）：
 *   1. GET backlog 未初始化 → POST init（含示例）→ 列表/配置就绪；重复 init 幂等
 *   2. 新建待办（依赖 task-1）→ 编辑 → 详情正文与段标记保留
 *   3. 派发：依赖未完成默认 409 阻止（D5）→ force 派发成功 → 待办置进行中 + 派发记录 + backlogRef 关联
 *   4. 任务终态自动回写：stub 会话即时完成 → summary success → 待办自动置 Done + 派发执行（成功）记录
 *   5. 失败隔离：P2 指向不可达节点，overview 中 P1 正常渲染
 *   6. 归档项目只读：写操作被拒
 *   7. 重试回写端点幂等可用；删除待办
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.BL_E2E_PORT || 18102)
const STUB_PORT = Number(process.env.BL_E2E_STUB_PORT || 18103)
const PREFIX = '/onenat-workbuddy'
const BASE = `http://127.0.0.1:${PORT}`
const STUB_BASE = `http://127.0.0.1:${STUB_PORT}/api/v1`

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

// ---------------- stub DSH 节点：内存 FS + 即完成会话 ----------------
const fsFiles = new Map() // 绝对路径 -> 内容
const fsDirs = new Set()
function ensureDir(p) {
  const parts = p.split('/').filter(Boolean)
  for (let i = 1; i <= parts.length; i++) fsDirs.add('/' + parts.slice(0, i).join('/'))
}
let sessionCounter = 0
const sessions = new Map()

const stub = createServer((req, res) => {
  const url = req.url || ''
  let chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString()
    const body = (() => { try { return JSON.parse(raw || '{}') } catch { return {} } })()
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }

    // /fs/list?path=...
    if (req.method === 'GET' && url.startsWith('/api/v1/fs/list')) {
      const dir = decodeURIComponent((url.match(/[?&]path=([^&]*)/) || [])[1] || '')
      if (!fsDirs.has(dir.replace(/\/+$/, ''))) return json(200, { ok: false, error: `no such file or directory: ${dir}` })
      const prefix = dir.replace(/\/+$/, '') + '/'
      // 真实 DSH 节点语义（QA 20261031 实测）：无 all=1 时含文件目录也返回空 entries
      if (!/[?&]all=1/.test(url)) return json(200, { ok: true, data: { path: dir, home: '', entries: [], truncated: false } })
      const entries = [...fsFiles.keys()]
        .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
        .map((k) => ({ name: k.slice(prefix.length), path: k, type: 'file', hidden: false }))
      return json(200, { ok: true, data: { path: dir, home: '', entries, truncated: false } })
    }
    // /fs/download?path=...
    if (req.method === 'GET' && url.startsWith('/api/v1/fs/download')) {
      const fp = decodeURIComponent((url.match(/[?&]path=([^&]*)/) || [])[1] || '')
      if (!fsFiles.has(fp)) return json(404, { ok: false, error: 'no such file' })
      res.writeHead(200, { 'Content-Type': 'text/markdown' })
      res.end(fsFiles.get(fp))
      return
    }
    // /fs/upload?path=<dir>（multipart：按 content-type boundary 正规解析文本段）
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
        // 真实 DSH 节点语义：已存在文件名生成 -1 副本而非覆盖（QA 20261031 实测）
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
    // /fs/mkdir
    if (req.method === 'POST' && url.startsWith('/api/v1/fs/mkdir')) {
      const parent = String(body?.path || '')
      const name = String(body?.name || '')
      const p = `${parent.replace(/\/+$/, '')}/${name}`
      if (fsDirs.has(p)) return json(200, { ok: false, error: 'directory already exists' })
      ensureDir(p)
      return json(200, { ok: true, data: { path: p, name } })
    }
    // /fs/remove?path=...
    if (req.method === 'DELETE' && url.startsWith('/api/v1/fs/remove')) {
      const fp = decodeURIComponent((url.match(/[?&]path=([^&]*)/) || [])[1] || '')
      if (!fsFiles.delete(fp)) return json(404, { ok: false, error: 'no such file' })
      return json(200, { ok: true })
    }
    // 节点连通性 ping（直发路径先探活）
    if (req.method === 'GET' && url.startsWith('/api/v1/system/status')) {
      return json(200, { ok: true, data: { status: 'ok', version: 'stub' } })
    }
    // 会话（派发任务直发主会话）
    const sid = (url.match(/\/api\/v1\/sessions\/([^/?]+)/) || [])[1]
    if (req.method === 'POST' && url === '/api/v1/sessions') {
      sessionCounter++
      const id = `stub-bl-${sessionCounter}`
      sessions.set(id, { prompts: [] })
      return json(200, { ok: true, data: { sessionId: id } })
    }
    if (sid && sessions.has(sid)) {
      const st = sessions.get(sid)
      if (req.method === 'GET' && url === `/api/v1/sessions/${sid}`) return json(200, { ok: true, data: { sessionId: sid, status: 'idle', cwd: '/tmp/bl-e2e-ws' } })
      if (req.method === 'GET' && url.startsWith(`/api/v1/sessions/${sid}/history`)) {
        const last = st.prompts[st.prompts.length - 1] || ''
        return json(200, { ok: true, data: { messages: [{ role: 'user', content: last }, { role: 'assistant', content: 'stub 已完成待办对应工作' }] } })
      }
      if (req.method === 'POST' && url.startsWith(`/api/v1/sessions/${sid}/prompt-stream`)) {
        st.prompts.push(body?.prompt || '')
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write(`event: delta\ndata: ${JSON.stringify({ delta: 'stub 完成待办工作' })}\n\n`)
        res.write(`event: turn_end\ndata: ${JSON.stringify({ reason: 'end_turn' })}\n\n`)
        res.write(`event: done\ndata: [DONE]\n\n`)
        res.end()
        return
      }
      if (req.method === 'PUT' && url === `/api/v1/sessions/${sid}/permission`) return json(404, { ok: false, error: 'no permission route' })
    }
    if (process.env.BL_DEBUG) console.log(`[stub] 404 ${req.method} ${url}`)
    json(404, { ok: false, error: 'Endpoint not found' })
  })
})

const procs = []
function cleanup() { try { stub.close() } catch {} for (const p of procs) { try { p.kill('SIGKILL') } catch {} } }
process.on('exit', cleanup)

let COOKIE = ''
async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(COOKIE ? { Cookie: COOKIE } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json; try { json = JSON.parse(text) } catch { json = undefined }
  return { status: res.status, json }
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'workbuddy-backlog-e2e-'))
  console.log(`\n== Backlog 集成 E2E ==\n`)
  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r))
  const server = spawn(process.execPath, [join(ROOT, 'dist', 'server.js'), '--port', String(PORT), '--data', dataDir, '--quiet'],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] })
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))
  procs.push(server)
  await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok, 'server 就绪')

  const loginRes = await fetch(`${BASE}${PREFIX}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'workbuddy', password: 'workbuddy-admin' }),
  })
  COOKIE = (loginRes.headers.get('set-cookie') || '').split(';')[0]
  check('登录成功', loginRes.ok)

  // P1：stub 节点 + 工作区
  const p1 = (await req('POST', `${PREFIX}/api/projects`, {
    name: 'Backlog 演示项目',
    dshRef: { kind: 'direct', apiBaseUrl: STUB_BASE },
    workspace: '/tmp/bl-e2e-ws',
  })).json?.data
  check('项目 P1 创建', Boolean(p1?.id))

  // 1. 未初始化 → init（含示例）→ 幂等
  let list = (await req('GET', `${PREFIX}/api/projects/${p1.id}/backlog`)).json?.data
  check('初始未初始化', list?.initialized === false, `err=${list ? '' : 'no data'}`)
  const init1 = await req('POST', `${PREFIX}/api/projects/${p1.id}/backlog/init`, { sample: true, updateInstruction: true })
  check('一键初始化成功（含示例待办）', init1.json?.ok === true, init1.json?.error || '')
  const projAfter = (await req('GET', `${PREFIX}/api/projects`)).json?.data?.find((x) => x.id === p1.id)
  check('项目指令已追加协作约定（B6）', /Backlog 待办协作约定/.test(projAfter?.instruction || ''))
  const init2 = await req('POST', `${PREFIX}/api/projects/${p1.id}/backlog/init`, {})
  check('重复初始化幂等', init2.json?.ok === true)
  list = (await req('GET', `${PREFIX}/api/projects/${p1.id}/backlog`)).json?.data
  check('列表就绪：initialized + statuses + 示例 1 条', list?.initialized === true && list?.statuses?.length === 3 && list?.items?.length === 1, `items=${list?.items?.length}`)
  const sampleId = list?.items?.[0]?.itemId

  // 2. 新建（依赖 sample）→ 编辑 → 详情
  const created = await req('POST', `${PREFIX}/api/projects/${p1.id}/backlog/items`, {
    title: '集成验证待办', description: '端到端链路验证', acceptance: ['CLI 建待办成功', '派发回写成功'],
    labels: ['e2e'], dependencies: [sampleId],
  })
  check('新建待办成功', created.json?.ok === true, created.json?.error || '')
  const itemId = created.json?.data?.itemId
  const edited = await req('PUT', `${PREFIX}/api/projects/${p1.id}/backlog/items/${itemId}`, { priority: 'high', labels: ['e2e', 'p1'] })
  check('编辑待办成功', edited.json?.ok === true, edited.json?.error || '')
  const detail = (await req('GET', `${PREFIX}/api/projects/${p1.id}/backlog/items/${itemId}`)).json?.data
  check('详情：frontmatter 修改生效 + 段标记保留 + 自定义内容不洗', /priority: high/.test(detail?.raw || '') && /AC:BEGIN/.test(detail?.raw || '') && /端到端链路验证/.test(detail?.raw || ''))

  // 3. 依赖阻止 → 强制派发 → 置进行中
  const blocked = await req('POST', `${PREFIX}/api/projects/${p1.id}/backlog/items/${itemId}/dispatch`, {})
  check('依赖未完成派发被阻止（D5）', blocked.status === 409 && blocked.json?.code === 'DEPS_BLOCKED', `status=${blocked.status}`)
  const dispatched = await req('POST', `${PREFIX}/api/projects/${p1.id}/backlog/items/${itemId}/dispatch`, { force: true })
  const taskId = dispatched.json?.data?.task?.id
  check('强制派发成功且生成任务', dispatched.json?.ok === true && Boolean(taskId), dispatched.json?.error || '')
  list = (await req('GET', `${PREFIX}/api/projects/${p1.id}/backlog`)).json?.data
  const dispatchedItem = list?.items?.find((x) => x.itemId === itemId)
  check('待办置进行中 + 派发记录 + 任务关联徽标', dispatchedItem?.status === 'In Progress' && dispatchedItem?.tasks?.length === 1, `status=${dispatchedItem?.status}`)

  // 4. 终态自动回写（stub 会话即时完成 → success → Done）
  await waitFor(async () => {
    const d = (await req('GET', `${PREFIX}/api/projects/${p1.id}/backlog/items/${itemId}`)).json?.data
    return d?.item?.status === 'Done' && /派发执行（成功）/.test(d?.raw || '')
  }, '终态自动回写').then(() => {
    console.log('  ✅ 任务终态自动回写：待办置 Done + 执行记录追加')
  }).catch(async () => {
    const t = (await req('GET', `${PREFIX}/api/tasks/${taskId}`)).json?.data
    console.log(`  [debug] task status=${t?.status} turns=${t?.turns?.length}`)
    for (const log of (t?.taskLogs || []).slice(-5)) console.log(`  [debug] log[${log.level}] ${String(log.message).slice(0, 220)}`)
    const lastTurn = t?.turns?.[t.turns.length - 1]
    console.log(`  [debug] lastTurn role=${lastTurn?.role} text=${String(lastTurn?.text || '').slice(0, 200)}`)
    check('任务终态自动回写：待办置 Done + 执行记录追加', false, '回写未在超时内完成')
  })
  const retry = await req('POST', `${PREFIX}/api/projects/${p1.id}/backlog/retry-writeback/${taskId}`, {})
  check('重试回写端点可用（幂等）', retry.json?.ok === true, retry.json?.error || '')

  // 5. 失败隔离：P2 不可达节点
  const p2 = (await req('POST', `${PREFIX}/api/projects`, {
    name: '不可达项目', dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:1/api/v1' }, workspace: '/tmp/bl-e2e-ws2',
  })).json?.data
  const overview = (await req('GET', `${PREFIX}/api/backlog/overview`)).json?.data
  const o1 = overview?.find((x) => x.projectId === p1.id)
  const o2 = overview?.find((x) => x.projectId === p2.id)
  check('overview：P1 正常聚合', o1?.nodeStatus === 'ok' && (o1?.items?.length || 0) >= 2, `items=${o1?.items?.length}`)
  check('overview：P2 不可达被隔离（B7）', o2?.nodeStatus === 'unreachable' && o1?.nodeStatus === 'ok')

  // 6. 归档只读
  await req('POST', `${PREFIX}/api/projects/${p1.id}/archive`)
  const archivedWrite = await req('POST', `${PREFIX}/api/projects/${p1.id}/backlog/items`, { title: '归档后不应成功' })
  check('归档项目写操作被拒', archivedWrite.status === 400, `status=${archivedWrite.status}`)
  const archivedRead = await req('GET', `${PREFIX}/api/projects/${p1.id}/backlog`)
  check('归档项目仍可只读查看', archivedRead.json?.ok === true)
  await req('POST', `${PREFIX}/api/projects/${p1.id}/restore`)

  // 7. 删除待办
  const del = await req('DELETE', `${PREFIX}/api/projects/${p1.id}/backlog/items/${sampleId}`)
  const afterDel = (await req('GET', `${PREFIX}/api/projects/${p1.id}/backlog`)).json?.data
  check('删除待办生效', del.json?.ok === true && !afterDel?.items?.some((x) => x.itemId === sampleId))

  console.log(`\n== 结果：${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`} ==\n`)
  cleanup()
  try { rmSync(dataDir, { recursive: true, force: true }) } catch {}
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('E2E 异常:', err)
  cleanup()
  process.exit(1)
})
