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
 *   8. 工具通道 workbuddy_backlog_manage（契约 docs/design-backlog-mcp-tool.md，Bearer 令牌）：
 *      projects / config / list（search+labels 过滤）/ search（描述正文命中）/ view /
 *      create / edit（含 acceptAdd、note、非法 status）/ delete（二次确认 + force）/
 *      dispatch（DEPS_BLOCKED + force + itemIds 批量部分失败）/ overview（P2 不可达失败隔离）/
 *      retry-writeback / 归档项目写操作被拒
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
// 工具通道 AI APIKEY：未配置令牌时服务端 fail-closed 拒绝一切工具调用，
// 因此拉起 dist/server.js 时必须用 env WORKBUDDY_TOKEN 播种（与 smoke-mcp-server.mjs 一致）
const TOKEN = process.env.BL_E2E_TOKEN || 'bl-e2e-tool-token-0123456789abcdef'

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

// ---------------- 工具通道（workbuddy_backlog_manage）调用封装 ----------------
// 契约唯一权威：docs/design-backlog-mcp-tool.md。
// HTTP 工具通道统一回包 {ok:true, tool, result}（工具自身结果在 result；工具抛错时服务端回
// {ok:false, tool, error}，无 result 键，此时直接把回包当结果用）。MCP 通道同源，只是外面再包一层 content[0].text。
const TOOL_NAME = 'workbuddy_backlog_manage'
async function tool(action, args = {}) {
  const res = await fetch(`${BASE}${PREFIX}/api/tools/${TOOL_NAME}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ action, ...args }),
  })
  const text = await res.text()
  let json; try { json = JSON.parse(text) } catch { json = undefined }
  const hasResult = json && typeof json === 'object' && Object.prototype.hasOwnProperty.call(json, 'result')
  return { status: res.status, json, result: hasResult ? json.result : json }
}
const asArray = (v) => (Array.isArray(v) ? v : [])
/** 列表类 action 的数组字段：契约未硬点名 key，按实现约定（projects/items/results）取值 */
function pickedArray(result, keys) {
  for (const k of keys) if (Array.isArray(result?.[k])) return result[k]
  return []
}
/** create/view 回包里的 itemId（契约：itemId 服务端分配，`<task_prefix>-<n>`） */
function pickItemId(res) {
  const r = res?.result || {}
  return r.itemId || r.item?.itemId || r.created?.itemId || r.item?.id
}
/** dispatch 回包里的 WorkBuddy 任务 ID */
function pickTaskId(res) {
  const r = res?.result || {}
  return r.taskId || r.task?.id || r.task?.taskId
}
/** view 回包里的待办字段（契约：字段 + 完整 Markdown 原文 + 关联任务） */
function viewItem(res) {
  const r = res?.result || {}
  return r.item || (r.itemId ? r : undefined)
}
function viewRaw(res) {
  const r = res?.result || {}
  return String(r.raw || r.item?.raw || '')
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'workbuddy-backlog-e2e-'))
  console.log(`\n== Backlog 集成 E2E ==\n`)
  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r))
  const server = spawn(process.execPath, [join(ROOT, 'dist', 'server.js'), '--port', String(PORT), '--data', dataDir, '--quiet'],
    { cwd: ROOT, env: { ...process.env, WORKBUDDY_TOKEN: TOKEN }, stdio: ['ignore', 'ignore', 'pipe'] })
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
  // 真实 DSH 节点同名上传会生成 -1 副本：重复 init 不得重传 config.yml（否则目录被 config-1.yml 污染）
  const dupConfigs = [...fsFiles.keys()].filter((k) => /\/backlog\/(config-1|config-2)(\.yml)?$/.test(k))
  check('重复初始化不产生 config-N.yml 副本', dupConfigs.length === 0, dupConfigs.join(','))
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

  // ================= 8. 工具通道 workbuddy_backlog_manage =================
  // 契约：docs/design-backlog-mcp-tool.md（工具签名/12 action/入参/返回/错误码唯一权威）。
  console.log('\n  -- 工具通道 workbuddy_backlog_manage --')

  // 8.0 令牌门禁：未配置令牌时工具通道 fail-closed；这里反向验证 WORKBUDDY_TOKEN 已生效
  const bareTool = await fetch(`${BASE}${PREFIX}/api/tools/${TOOL_NAME}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'projects' }),
  })
  check('工具通道：无令牌 → 401（WORKBUDDY_TOKEN 生效）', bareTool.status === 401, `status=${bareTool.status}`)

  // 8.1 projects：返回项目列表且含已初始化的 P1
  const toolProjects = await tool('projects')
  const projectRows = pickedArray(toolProjects.result, ['projects', 'items'])
  const p1Row = projectRows.find((x) => x?.id === p1.id)
  check('tools projects：返回项目列表且 P1 在列（initialized=true）',
    toolProjects.result?.ok === true && Boolean(p1Row) && p1Row?.initialized === true,
    `projects=${projectRows.length} initialized=${p1Row?.initialized}`)
  check('tools projects：P1 未归档且带 workspace/name', p1Row?.archived === false && p1Row?.workspace === '/tmp/bl-e2e-ws' && Boolean(p1Row?.name))

  // 8.2 config：statuses(3)/defaultStatus/taskPrefix
  const toolConfig = await tool('config', { projectId: p1.id })
  const cfgRes = toolConfig.result || {}
  check('tools config：statuses 3 个 / defaultStatus / taskPrefix',
    cfgRes.ok === true && asArray(cfgRes.statuses).length === 3 && Boolean(cfgRes.defaultStatus) && cfgRes.taskPrefix === 'task',
    `statuses=${JSON.stringify(cfgRes.statuses)} default=${cfgRes.defaultStatus} prefix=${cfgRes.taskPrefix}`)
  const cfgDefaultStatus = cfgRes.defaultStatus

  // 8.3 list：条目 + statuses + total；filter.search 命中；filter.labels 过滤
  const toolList = await tool('list', { projectId: p1.id })
  const listRes = toolList.result || {}
  const listItems = asArray(listRes.items)
  check('tools list：返回条目 + statuses + total',
    listRes.ok === true && listItems.length >= 1 && asArray(listRes.statuses).length === 3 && listRes.total === listItems.length,
    `items=${listItems.length} total=${listRes.total}`)
  const listHit = await tool('list', { projectId: p1.id, filter: { search: '集成验证' } })
  const listHitItems = asArray(listHit.result?.items)
  check('tools list：filter.search 命中（标题）',
    listHit.result?.ok === true && listHitItems.some((x) => x.itemId === itemId) && listHitItems.every((x) => /集成验证/.test(`${x.title || ''}${(x.labels || []).join(' ')}`)),
    `hit=${listHitItems.map((x) => x.itemId).join(',')}`)
  const listLabelled = await tool('list', { projectId: p1.id, filter: { labels: ['e2e'] } })
  const labelledItems = asArray(listLabelled.result?.items)
  check('tools list：filter.labels=["e2e"] 过滤（全部命中 label）',
    listLabelled.result?.ok === true && labelledItems.length >= 1 && labelledItems.every((x) => asArray(x.labels).includes('e2e')) && labelledItems.some((x) => x.itemId === itemId),
    `items=${labelledItems.length}`)
  const maxNumBefore = Math.max(0, ...listItems.map((x) => Number(/-(\d+)$/.exec(String(x.itemId || ''))?.[1])).filter((n) => Number.isFinite(n)))

  // 8.4 search：按描述正文命中（与 list 的差异点 —— 描述里的词也能搜到）
  const toolSearch = await tool('search', { projectId: p1.id, filter: { search: '端到端' } })
  const searchItems = asArray(toolSearch.result?.items)
  check('tools search：按描述正文命中（描述里的词也能搜到）',
    toolSearch.result?.ok === true && searchItems.some((x) => x.itemId === itemId),
    `items=${searchItems.map((x) => x.itemId).join(',')}`)
  check('tools search：命中的不是标题词（标题不含「端到端」）', !/端到端/.test(String(listItems.find((x) => x.itemId === itemId)?.title || '')))
  // 契约 §3「search 需 filter.search」：缺参不得静默返回全量
  const searchNoFilter = await tool('search', { projectId: p1.id })
  check('tools search：缺 filter.search → ok:false（契约要求必填）',
    searchNoFilter.result?.ok === false && /filter\.search|search/.test(String(searchNoFilter.result?.error || '')),
    `error=${String(searchNoFilter.result?.error || '').slice(0, 100)}`)

  // 8.5 view：完整 raw（frontmatter + AC 段标记）
  const toolView = await tool('view', { projectId: p1.id, itemId })
  const viewItemRow = viewItem(toolView)
  const viewRawText = viewRaw(toolView)
  check('tools view：返回字段 + 完整 raw（frontmatter 与 AC 段标记）',
    toolView.result?.ok === true && viewItemRow?.itemId === itemId && /^---/.test(viewRawText) && /<!-- AC:BEGIN -->/.test(viewRawText),
    `rawLen=${viewRawText.length}`)
  check('tools view：raw 含描述正文（段标记原样保留）', /端到端链路验证/.test(viewRawText) && /<!-- SECTION:DESCRIPTION:BEGIN -->/.test(viewRawText))

  // 8.6 create：itemId 递增、status=defaultStatus、acceptance 计数正确
  const toolCreate = await tool('create', {
    projectId: p1.id,
    item: { title: '工具通道新建待办', description: '工具通道建单验证', labels: ['tool-e2e'], acceptance: ['验收项一', '验收项二'] },
  })
  const newId = pickItemId(toolCreate)
  const newNum = Number(/-(\d+)$/.exec(String(newId || ''))?.[1])
  check('tools create：新建成功且 itemId 递增（max+1）',
    toolCreate.result?.ok === true && Boolean(newId) && newNum === maxNumBefore + 1,
    `id=${newId} maxBefore=${maxNumBefore}`)
  const newView = await tool('view', { projectId: p1.id, itemId: newId })
  const newItem = viewItem(newView)
  check('tools create：status=defaultStatus 且 acceptance 计数正确（view 复核）',
    newView.result?.ok === true && newItem?.status === cfgDefaultStatus && newItem?.acceptance?.total === 2 && newItem?.acceptance?.done === 0,
    `status=${newItem?.status} acceptance=${JSON.stringify(newItem?.acceptance)}`)

  // 8.7 edit：status/priority/labels/acceptance/description + acceptAdd + note；view 复核；非法 status 被拒
  const toolEdit = await tool('edit', {
    projectId: p1.id,
    itemId: newId,
    item: {
      status: 'In Progress',
      priority: 'High',
      labels: ['tool-e2e', 'edited'],
      acceptance: ['验收项一（改）', '验收项二（改）', '验收项三'],
      acceptAdd: ['验收项四（追加）'],
      description: '编辑后的描述正文',
      note: { title: '人工备注', lines: ['这是一条工具通道追加的执行记录'] },
    },
  })
  const editView = await tool('view', { projectId: p1.id, itemId: newId })
  const editItem = viewItem(editView)
  const editRaw = viewRaw(editView)
  check('tools edit：edit 回包 ok=true', toolEdit.result?.ok === true, toolEdit.result?.error || '')
  check('tools edit：status/priority/labels 生效（view 复核）',
    editItem?.status === 'In Progress' && editItem?.priority === 'High'
      && asArray(editItem?.labels).includes('edited') && asArray(editItem?.labels).includes('tool-e2e'),
    `status=${editItem?.status} pri=${editItem?.priority} labels=${JSON.stringify(editItem?.labels)}`)
  check('tools edit：acceptance 替换 + acceptAdd 追加（共 4 项）',
    editItem?.acceptance?.total === 4 && editItem?.acceptance?.done === 0,
    `acceptance=${JSON.stringify(editItem?.acceptance)}`)
  check('tools edit：description 替换 + note 追加执行记录（view raw 复核）',
    /编辑后的描述正文/.test(editRaw) && /人工备注/.test(editRaw) && /工具通道追加的执行记录/.test(editRaw))
  const badStatus = await tool('edit', { projectId: p1.id, itemId: newId, item: { status: '不存在的状态' } })
  check('tools edit：非法 status → ok:false + code=INVALID_STATUS + error 列出可选值',
    badStatus.result?.ok === false && badStatus.result?.code === 'INVALID_STATUS'
      && asArray(badStatus.result?.statuses).length === 3
      && /非法|可选/.test(String(badStatus.result?.error || '')) && /To Do/.test(String(badStatus.result?.error || '')),
    `code=${badStatus.result?.code} error=${String(badStatus.result?.error || '').slice(0, 100)}`)

  // 8.8 delete：无 force → 二次确认提示；force=true → 删除成功且再 view 不存在
  const delNoForce = await tool('delete', { projectId: p1.id, itemId: newId })
  check('tools delete：不带 force → ok:false + code=CONFIRM_REQUIRED（二次确认提示）',
    delNoForce.result?.ok === false && delNoForce.result?.code === 'CONFIRM_REQUIRED'
      && /force|确认/.test(String(delNoForce.result?.error || '')),
    `code=${delNoForce.result?.code} error=${String(delNoForce.result?.error || '').slice(0, 100)}`)
  const delForced = await tool('delete', { projectId: p1.id, itemId: newId, force: 'true' })
  check('tools delete：force="true" → 删除成功', delForced.result?.ok === true, delForced.result?.error || '')
  const afterDeleteView = await tool('view', { projectId: p1.id, itemId: newId })
  check('tools delete：再 view 返回不存在（200 + ok:false + code=NOT_FOUND）',
    afterDeleteView.status === 200 && afterDeleteView.result?.ok === false
      && afterDeleteView.result?.code === 'NOT_FOUND' && /不存在/.test(String(afterDeleteView.result?.error || '')),
    `status=${afterDeleteView.status} code=${afterDeleteView.result?.code}`)

  // 8.9 dispatch：依赖未完成 → DEPS_BLOCKED；force → taskId；itemIds 批量逐条结果
  const blocker = await tool('create', { projectId: p1.id, item: { title: '工具通道阻塞项', description: '供依赖阻止断言使用' } })
  const blockerId = pickItemId(blocker)
  const dependent = await tool('create', { projectId: p1.id, item: { title: '工具通道依赖项', description: '依赖阻塞项', dependencies: [blockerId] } })
  const dependentId = pickItemId(dependent)
  check('tools dispatch（前置）：阻塞项/依赖项创建成功', Boolean(blockerId) && Boolean(dependentId), `blocker=${blockerId} dependent=${dependentId}`)
  const depsBlocked = await tool('dispatch', { projectId: p1.id, itemId: dependentId })
  check('tools dispatch：依赖未完成 → ok:false + code=DEPS_BLOCKED',
    depsBlocked.result?.ok === false && depsBlocked.result?.code === 'DEPS_BLOCKED' && asArray(depsBlocked.result?.blocked).length >= 1,
    `code=${depsBlocked.result?.code} blocked=${JSON.stringify(depsBlocked.result?.blocked)}`)
  const forcedDispatch = await tool('dispatch', { projectId: p1.id, itemId: dependentId, force: 'true' })
  const toolTaskId = pickTaskId(forcedDispatch)
  check('tools dispatch：force="true" → 返回 taskId', forcedDispatch.result?.ok === true && Boolean(toolTaskId), `taskId=${toolTaskId}`)
  const batchDispatch = await tool('dispatch', { projectId: p1.id, itemIds: [blockerId, 'task-999999'] })
  const batchEntries = pickedArray(batchDispatch.result, ['results', 'items', 'dispatched'])
  check('tools dispatch：itemIds 批量返回逐条结果（部分失败不整体报错）',
    batchDispatch.result?.ok === true && batchEntries.length === 2
      && batchEntries.some((e) => e?.ok === true) && batchEntries.some((e) => e?.ok === false),
    `entries=${JSON.stringify(batchEntries.map((e) => ({ itemId: e?.itemId, ok: e?.ok })))}`)

  // 8.10 overview：跨项目聚合，P2 不可达失败隔离
  // 注意：overview 默认只返回未完成项（契约 §6 includeDone 默认 false），而派发/终态回写是异步的，
  // 若按默认断言「items>=1」会随回写完成时机抖动（实测两次分别 3/1）；故显式 includeDone:"true" 断言全量聚合。
  const toolOverview = await tool('overview', { filter: { includeDone: true } })
  const ovRows = pickedArray(toolOverview.result, ['projects', 'overview'])
  const ovP1 = ovRows.find((x) => x?.projectId === p1.id)
  const ovP2 = ovRows.find((x) => x?.projectId === p2.id)
  check('tools overview：P1 正常聚合（nodeStatus=ok + 全量条目）',
    toolOverview.result?.ok === true && ovP1?.nodeStatus === 'ok'
      && asArray(ovP1?.items).length >= 3 && ovP1?.total === asArray(ovP1?.items).length,
    `items=${asArray(ovP1?.items).length} total=${ovP1?.total}`)
  check('tools overview：P2 不可达时失败隔离（P1 正常、P2 带 error、summary.unreachable=1）',
    ovP2?.nodeStatus === 'unreachable' && Boolean(ovP2?.error) && ovP1?.nodeStatus === 'ok'
      && toolOverview.result?.summary?.projects === 2 && toolOverview.result?.summary?.unreachable === 1,
    `P2=${ovP2?.nodeStatus} err=${String(ovP2?.error || '').slice(0, 60)} summary=${JSON.stringify(toolOverview.result?.summary)}`)

  // 8.11 retry-writeback：对已回写任务重试 → ok:true
  const toolRetry = await tool('retry-writeback', { taskId })
  check('tools retry-writeback：对已回写任务重试 → ok:true', toolRetry.result?.ok === true, toolRetry.result?.error || '')

  // 8.12 归档项目：写类 action 被拒、读类放行
  await req('POST', `${PREFIX}/api/projects/${p1.id}/archive`)
  const archCreate = await tool('create', { projectId: p1.id, item: { title: '归档后不应成功（工具通道）' } })
  check('tools 归档：create 被拒（写操作一律拒绝）',
    archCreate.result?.ok === false && archCreate.result?.code === 'PROJECT_ARCHIVED' && /归档|archived/i.test(String(archCreate.result?.error || '')),
    `code=${archCreate.result?.code} error=${String(archCreate.result?.error || '').slice(0, 100)}`)
  const archEdit = await tool('edit', { projectId: p1.id, itemId: dependentId, item: { priority: 'Low' } })
  check('tools 归档：edit 被拒（写操作一律拒绝）',
    archEdit.result?.ok === false && archEdit.result?.code === 'PROJECT_ARCHIVED',
    `code=${archEdit.result?.code}`)
  const archConfig = await tool('config', { projectId: p1.id })
  check('tools 归档：config 读操作放行', archConfig.result?.ok === true)
  await req('POST', `${PREFIX}/api/projects/${p1.id}/restore`)

  // 8.13 init：工具通道初始化（补全覆盖契约 §3 的全部 12 个 action；放末尾，避免影响前面 projects/overview 断言）
  const p3 = (await req('POST', `${PREFIX}/api/projects`, {
    name: '工具通道初始化项目',
    dshRef: { kind: 'direct', apiBaseUrl: STUB_BASE },
    workspace: '/tmp/bl-e2e-ws3',
  })).json?.data
  check('tools init（前置）：P3 创建成功', Boolean(p3?.id))
  const toolInit = await tool('init', { projectId: p3.id, sample: 'true' })
  check('tools init：初始化成功（initialized=true / statuses 3 个 / 带示例待办）',
    toolInit.result?.ok === true && toolInit.result?.initialized === true && asArray(toolInit.result?.statuses).length === 3 && Boolean(toolInit.result?.sampleItemId),
    `initialized=${toolInit.result?.initialized} sample=${toolInit.result?.sampleItemId}`)
  const toolInitAgain = await tool('init', { projectId: p3.id })
  check('tools init：重复初始化幂等（ok=true）', toolInitAgain.result?.ok === true)
  const toolInitList = await tool('list', { projectId: p3.id })
  check('tools init：初始化后可 list 到示例待办', toolInitList.result?.ok === true && asArray(toolInitList.result?.items).length === 1,
    `items=${asArray(toolInitList.result?.items).length}`)

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
