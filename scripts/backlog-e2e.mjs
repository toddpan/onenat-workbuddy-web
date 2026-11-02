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
 *   9. 未完成事项采集（简版：任务账本 + 工作区代码/文档扫描）
 *  10. 任务查询能力（契约 docs/design-backlog-query-filters.md §2/§3/§4/§5）：
 *      REST 过滤（status/excludeStatus/priority/type/labels/assignee/unassigned/milestone/parent/search）
 *      + 排序/切窗/计数/facets/window/就绪派生字段 + 非法参数 400 INVALID_QUERY；
 *      overview 逐项目过滤 + summary/facets + openOnly + matched=0 项目保留；
 *      工具通道 filter 新字段 + matched/window/counts/facets + view readiness
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
      const clean = dir.replace(/\/+$/, '')
      if (!fsDirs.has(clean)) return json(200, { ok: false, error: `no such file or directory: ${dir}` })
      const prefix = clean + '/'
      // 真实 DSH 节点语义（QA 20261031 实测）：无 all=1 时含文件目录也返回空 entries
      if (!/[?&]all=1/.test(url)) return json(200, { ok: true, data: { path: dir, home: '', entries: [], truncated: false } })
      // 与真实节点对齐：entries 含子目录（type=dir）与文件元数据（size/mtime）；采集器 BFS 依赖 dir 条目下钻
      const dirEntries = [...fsDirs]
        .filter((d) => d !== clean && d.startsWith(prefix) && !d.slice(prefix.length).includes('/'))
        .map((d) => ({ name: d.slice(prefix.length), path: d, type: 'dir', mtime: 1700000000000, hidden: false }))
      const fileEntries = [...fsFiles.keys()]
        .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
        .map((k) => ({ name: k.slice(prefix.length), path: k, type: 'file', size: String(fsFiles.get(k) || '').length, mtime: 1700000000000, hidden: false }))
      return json(200, { ok: true, data: { path: dir, home: '', entries: dirEntries.concat(fileEntries), truncated: false } })
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
    { cwd: ROOT, env: { ...process.env, WORKBUDDY_TOKEN: TOKEN, WORKBUDDY_ALLOW_PRIVATE_DIRECT: '1' }, stdio: ['ignore', 'ignore', 'pipe'] })
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

  // ================= 9. 未完成事项采集（简版：任务账本 + 工作区代码/文档扫描） =================
  console.log('\n  -- 未完成事项采集（简版） --')
  const p4 = (await req('POST', `${PREFIX}/api/projects`, {
    name: '采集演示项目', dshRef: { kind: 'direct', apiBaseUrl: STUB_BASE }, workspace: '/tmp/bl-e2e-ws4',
  })).json?.data
  check('采集：P4 创建', Boolean(p4?.id))
  check('采集：backlog 初始化成功', (await req('POST', `${PREFIX}/api/projects/${p4.id}/backlog/init`, {})).json?.ok === true)
  const putWs = (p, text) => { ensureDir(p.split('/').slice(0, -1).join('/')); fsFiles.set(p, text) }
  putWs('/tmp/bl-e2e-ws4/src/auth.ts', 'export const a = 1\n// TODO 补充刷新 token 的并发保护\n')
  putWs('/tmp/bl-e2e-ws4/docs/design.md', '# 设计\n- [ ] 灰度回滚验证\n')
  putWs('/tmp/bl-e2e-ws4/node_modules/dep/index.js', '// TODO 依赖里的标记不应采\n')
  putWs('/tmp/bl-e2e-ws4/backlog/tasks/task-99 - 自身.md', '- [ ] backlog 自身条目不应采\n')
  const pv = (await req('POST', `${PREFIX}/api/projects/${p4.id}/backlog/collect`, { mode: 'preview' })).json?.data
  const pvCands = pv?.candidates || []
  const pvPaths = pvCands.map((c) => c.filePath)
  check('采集预览：发现代码 TODO + 文档未勾选（2 条；排除 node_modules / backlog 自身）',
    pvCands.length === 2 && pvPaths.includes('src/auth.ts') && pvPaths.includes('docs/design.md') && !pvPaths.some((p) => String(p).includes('node_modules')),
    `candidates=${JSON.stringify(pvPaths)} stats=${JSON.stringify(pv?.stats)}`)
  const pvKeys = pvCands.map((c) => c.key)
  const made = (await req('POST', `${PREFIX}/api/projects/${p4.id}/backlog/collect`, { mode: 'create', keys: pvKeys })).json?.data
  check('采集落盘：按 keys 创建 2 条待办', made?.created?.length === 2, made?.error || '')
  const list4 = (await req('GET', `${PREFIX}/api/projects/${p4.id}/backlog`)).json?.data
  const autoItems = (list4?.items || []).filter((x) => Array.isArray(x.labels) && x.labels.includes('auto-collect'))
  const codeItem = autoItems.find((x) => x.labels.includes('source-code'))
  const docItem = autoItems.find((x) => x.labels.includes('source-doc'))
  check('采集条目：labels 正确（auto-collect + source-code / source-doc）',
    autoItems.length === 2 && Boolean(codeItem) && Boolean(docItem), `items=${autoItems.length}`)
  check('采集条目：sourceKeys 从正文解析（去重锚点）', autoItems.every((x) => Array.isArray(x.sourceKeys) && x.sourceKeys.length === 1))
  const codeRaw = codeItem ? (await req('GET', `${PREFIX}/api/projects/${p4.id}/backlog/items/${codeItem.itemId}`)).json?.data?.raw : ''
  check('采集条目：正文带 wb:source 标记 + 验收清单', /<!-- wb:source=code:[0-9a-f]{16} -->/.test(codeRaw) && /AC:BEGIN/.test(codeRaw))
  const pv2 = (await req('POST', `${PREFIX}/api/projects/${p4.id}/backlog/collect`, { mode: 'preview' })).json?.data
  check('采集幂等：再次预览 0 条新候选（已登记被跳过）',
    (pv2?.candidates || []).length === 0 && (pv2?.stats?.skippedKnown || 0) >= 2,
    `candidates=${(pv2?.candidates || []).length} skippedKnown=${pv2?.stats?.skippedKnown}`)
  const made2 = (await req('POST', `${PREFIX}/api/projects/${p4.id}/backlog/collect`, { mode: 'create' })).json?.data
  check('采集幂等：重复 create 不产生新条目', (made2?.created || []).length === 0)
  await req('POST', `${PREFIX}/api/projects/${p4.id}/archive`)
  const archCollect = await req('POST', `${PREFIX}/api/projects/${p4.id}/backlog/collect`, { mode: 'preview' })
  check('采集：归档项目被拒（只读拦截）', archCollect.status === 400, `status=${archCollect.status}`)
  await req('POST', `${PREFIX}/api/projects/${p4.id}/restore`)

  // ================= 10. 任务查询能力（docs/design-backlog-query-filters.md §2/§3/§4/§5） =================
  // 只在 stub 内存 FS 上验证「查询 → 过滤 → 排序 → 切窗 → 分面 → 就绪判定」链路，不改既有段落。
  // 造数据：初始化拿到 config.yml 后直接写入 Backlog.md 兼容 frontmatter（type/milestone/parent_task_id
  // 是本次新增字段；直写文件让测试与 create 接口是否已透传这些字段解耦）。
  console.log('\n  -- 任务查询能力（REST / overview / 工具通道） --')
  const WS5 = '/tmp/bl-e2e-ws5'
  const p5 = (await req('POST', `${PREFIX}/api/projects`, {
    name: '查询能力项目', dshRef: { kind: 'direct', apiBaseUrl: STUB_BASE }, workspace: WS5,
  })).json?.data
  check('查询：P5 创建', Boolean(p5?.id), p5?.id || '')
  check('查询：P5 backlog 初始化', (await req('POST', `${PREFIX}/api/projects/${p5.id}/backlog/init`, {})).json?.ok === true)

  // 语料设计（6 条，覆盖全部查询维度；created_date 递增 → 默认 createdAt 倒序可断言）：
  //   task-201 To Do    / high   / bug     / [backend,api] / alice          / M-1 / 无依赖            → 就绪
  //   task-202 In Prog. / medium / feature / [frontend,api]/ bob            / M-1 / 依赖 task-201(未完成) → 阻塞
  //   task-203 Done     / low    / chore   / [backend]     / 未指派         / M-2 / 无依赖            → 终态（既不就绪也不阻塞）
  //   task-204 To Do    / high   / bug     / [backend,api] / alice@example  / M-2 / parent=task-201 / 无依赖 → 就绪
  //   task-205 To Do    / medium / feature / [frontend,api]/ 未指派         / M-1 / parent=task-201 / 依赖 task-203(已完成) → 就绪
  //   task-206 To Do    / low    / docs    / [docs]        / carol          /  —  / 依赖 task-999(不存在) → 阻塞（fail-closed）
  const CORPUS = [
    { n: 201, title: '登录接口优化', status: 'To Do', priority: 'high', type: 'bug', labels: ['backend', 'api'], assignees: ['alice'], milestone: 'M-1', desc: '排查登录超时并加入重试', created: '2026-10-01T00:00:00Z' },
    { n: 202, title: '看板刷新', status: 'In Progress', priority: 'medium', type: 'feature', labels: ['frontend', 'api'], assignees: ['bob'], milestone: 'M-1', deps: ['task-201'], desc: '看板自动刷新链路', created: '2026-10-02T00:00:00Z' },
    { n: 203, title: '旧日志清理', status: 'Done', priority: 'low', type: 'chore', labels: ['backend'], assignees: [], milestone: 'M-2', desc: '清理旧日志文件', created: '2026-10-03T00:00:00Z' },
    { n: 204, title: '支付回调', status: 'To Do', priority: 'high', type: 'bug', labels: ['backend', 'api'], assignees: ['alice@example.com'], milestone: 'M-2', parent: 'task-201', desc: '支付回调幂等处理', created: '2026-10-04T00:00:00Z' },
    { n: 205, title: '搜索框防抖', status: 'To Do', priority: 'medium', type: 'feature', labels: ['frontend', 'api'], assignees: [], milestone: 'M-1', parent: 'task-201', deps: ['task-203'], desc: '搜索框输入防抖 300ms', created: '2026-10-05T00:00:00Z' },
    { n: 206, title: '文档补充', status: 'To Do', priority: 'low', type: 'docs', labels: ['docs'], assignees: ['carol'], deps: ['task-999'], desc: '补充文档章节', created: '2026-10-06T00:00:00Z' },
  ]
  // Backlog.md 兼容 frontmatter（块列表字段空值写成 `key:` 后无子项，与 createItem 产物一致）
  const taskMarkdown = (s) => [
    '---',
    `id: task-${s.n}`,
    `title: '${s.title}'`,
    `status: '${s.status}'`,
    'assignee:',
    ...(s.assignees || []).map((a) => `  - ${a}`),
    `created_date: '${s.created}'`,
    `updated_date: '${s.created}'`,
    ...(s.priority ? [`priority: ${s.priority}`] : []),
    ...(s.type ? [`type: ${s.type}`] : []),
    ...(s.milestone ? [`milestone: '${s.milestone}'`] : []),
    ...(s.parent ? [`parent_task_id: ${s.parent}`] : []),
    'labels:',
    ...(s.labels || []).map((l) => `  - ${l}`),
    'dependencies:',
    ...(s.deps || []).map((d) => `  - ${d}`),
    `ordinal: ${s.n * 1000}`,
    '---',
    '',
    '## Description',
    '',
    '<!-- SECTION:DESCRIPTION:BEGIN -->',
    s.desc,
    '<!-- SECTION:DESCRIPTION:END -->',
    '',
    '## Acceptance Criteria',
    '<!-- AC:BEGIN -->',
    '- [ ] #1 验收项',
    '<!-- AC:END -->',
    '',
  ].join('\n')
  for (const spec of CORPUS) putWs(`${WS5}/backlog/tasks/task-${spec.n} - ${spec.title}.md`, taskMarkdown(spec))

  // ---- 断言辅助 ----
  const idsOf = (rows) => asArray(rows).map((x) => String(x?.itemId || ''))
  const sameSet = (rows, want) => {
    const got = idsOf(rows).map((x) => x.toLowerCase()).sort().join(',')
    return got === want.map((x) => String(x).toLowerCase()).sort().join(',')
  }
  const sameOrder = (rows, want) => idsOf(rows).join(',') === want.join(',')
  const facetCount = (facets, dim, value) => {
    const hit = asArray(facets?.[dim]).find((v) => String(v?.value || '').toLowerCase() === String(value).toLowerCase())
    return hit ? hit.count : 0
  }
  const bl = async (pairs = []) => {
    const qs = new URLSearchParams(pairs).toString()
    const r = await req('GET', `${PREFIX}/api/projects/${p5.id}/backlog${qs ? `?${qs}` : ''}`)
    return { status: r.status, json: r.json, data: r.json?.data }
  }

  // ---------- 10.1 全量列表：计数 / window / facets / 派生字段 / 新字段 ----------
  const full = await bl()
  const fullItems = asArray(full.data?.items)
  check('查询REST：全量 total=6 / matched=6 / items=6',
    full.status === 200 && full.data?.total === 6 && full.data?.matched === 6 && fullItems.length === 6,
    `status=${full.status} total=${full.data?.total} matched=${full.data?.matched} items=${fullItems.length}`)
  check('查询REST：默认排序沿用 createdAt 倒序（最新 task-206 在最前）',
    idsOf(fullItems)[0] === 'task-206', `ids=${idsOf(fullItems).join(',')}`)
  check('查询REST：window 未截断（skip=0 / total=6 / nextSkip=null / cut=false）',
    full.data?.window?.skip === 0 && full.data?.window?.total === 6 && full.data?.window?.nextSkip === null && full.data?.window?.cut === false,
    JSON.stringify(full.data?.window || null))
  check('查询REST：counts 正确（open=5 / done=1 / ready=3 / blocked=2 / unassigned=2）',
    full.data?.counts?.open === 5 && full.data?.counts?.done === 1 && full.data?.counts?.ready === 3
      && full.data?.counts?.blocked === 2 && full.data?.counts?.unassigned === 2,
    JSON.stringify(full.data?.counts || null))
  check('查询REST：回包剥离 searchText（检索语料不得外泄）',
    fullItems.every((x) => x.searchText === undefined),
    fullItems.filter((x) => x.searchText !== undefined).map((x) => x.itemId).join(',') || 'ok')
  const it204 = fullItems.find((x) => x.itemId === 'task-204')
  check('查询REST：条目带 type / milestone / parentTaskId 查询字段（task-204）',
    it204?.type === 'bug' && it204?.milestone === 'M-2' && String(it204?.parentTaskId || '').toLowerCase() === 'task-201',
    `type=${it204?.type} milestone=${it204?.milestone} parent=${it204?.parentTaskId}`)
  const fullFacets = full.data?.facets || {}
  check('查询REST：facets.statuses 计数正确（To Do=4 / In Progress=1 / Done=1）',
    facetCount(fullFacets, 'statuses', 'To Do') === 4
      && facetCount(fullFacets, 'statuses', 'In Progress') === 1
      && facetCount(fullFacets, 'statuses', 'Done') === 1,
    JSON.stringify(fullFacets.statuses || []))
  check('查询REST：facets.priorities / types 计数正确（high=2,medium=2,low=2；bug=2,feature=2,chore=1,docs=1）',
    facetCount(fullFacets, 'priorities', 'high') === 2 && facetCount(fullFacets, 'priorities', 'medium') === 2
      && facetCount(fullFacets, 'priorities', 'low') === 2 && facetCount(fullFacets, 'types', 'bug') === 2
      && facetCount(fullFacets, 'types', 'feature') === 2 && facetCount(fullFacets, 'types', 'chore') === 1
      && facetCount(fullFacets, 'types', 'docs') === 1,
    `priorities=${JSON.stringify(fullFacets.priorities || [])} types=${JSON.stringify(fullFacets.types || [])}`)
  check('查询REST：facets.labels / assignees / milestones 计数正确（api=4,backend=3；M-1=3,M-2=2）',
    facetCount(fullFacets, 'labels', 'api') === 4 && facetCount(fullFacets, 'labels', 'backend') === 3
      && facetCount(fullFacets, 'labels', 'frontend') === 2 && facetCount(fullFacets, 'labels', 'docs') === 1
      && asArray(fullFacets.assignees).length === 4
      && facetCount(fullFacets, 'milestones', 'M-1') === 3 && facetCount(fullFacets, 'milestones', 'M-2') === 2,
    `labels=${JSON.stringify(fullFacets.labels || [])} milestones=${JSON.stringify(fullFacets.milestones || [])}`)

  // ---------- 10.2 ready / blocked 判定（doc §3 四条规则） ----------
  const byId = {}
  for (const it of fullItems) byId[it.itemId] = it
  check('查询REST：ready 语义——无依赖 → 就绪（task-201）',
    byId['task-201']?.isReady === true && byId['task-201']?.blocked === false,
    `isReady=${byId['task-201']?.isReady} blocked=${byId['task-201']?.blocked}`)
  check('查询REST：ready 语义——依赖未完成 → 阻塞 + blockingDependencies（task-202 ← task-201）',
    byId['task-202']?.blocked === true && byId['task-202']?.isReady === false
      && asArray(byId['task-202']?.blockingDependencies).some((d) => String(d).toLowerCase() === 'task-201'),
    `blocked=${byId['task-202']?.blocked} blocking=${JSON.stringify(byId['task-202']?.blockingDependencies)}`)
  check('查询REST：ready 语义——依赖已完成 → 就绪（task-205 ← task-203 Done）',
    byId['task-205']?.isReady === true && byId['task-205']?.blocked === false,
    `isReady=${byId['task-205']?.isReady}`)
  check('查询REST：ready 语义——依赖不存在 → 阻塞 + missingDependencies（task-206 ← task-999，fail-closed）',
    byId['task-206']?.blocked === true && byId['task-206']?.isReady === false
      && asArray(byId['task-206']?.missingDependencies).some((d) => String(d).toLowerCase() === 'task-999'),
    `blocked=${byId['task-206']?.blocked} missing=${JSON.stringify(byId['task-206']?.missingDependencies)}`)
  check('查询REST：ready 语义——终态既不就绪也不阻塞（task-203 Done）',
    byId['task-203']?.isReady === false && byId['task-203']?.blocked === false,
    `isReady=${byId['task-203']?.isReady} blocked=${byId['task-203']?.blocked}`)
  const readyOnly = await bl([['ready', '1']])
  check('查询REST：ready=1 → 3 条（task-201/204/205）',
    readyOnly.data?.matched === 3 && sameSet(readyOnly.data?.items, ['task-201', 'task-204', 'task-205']),
    `matched=${readyOnly.data?.matched} ids=${idsOf(readyOnly.data?.items).join(',')}`)
  const blockedOnly = await bl([['blocked', '1']])
  check('查询REST：blocked=1 → 2 条（task-202/206）',
    blockedOnly.data?.matched === 2 && sameSet(blockedOnly.data?.items, ['task-202', 'task-206']),
    `matched=${blockedOnly.data?.matched} ids=${idsOf(blockedOnly.data?.items).join(',')}`)

  // ---------- 10.3 过滤维度：status / excludeStatus / priority / type / labels / assignee / unassigned / milestone / parent / search ----------
  const stMulti = await bl([['status', 'To Do'], ['status', 'Done']])
  check('查询REST：status 多值（重复参数）→ 5 条',
    stMulti.data?.matched === 5 && sameSet(stMulti.data?.items, ['task-201', 'task-203', 'task-204', 'task-205', 'task-206']),
    `matched=${stMulti.data?.matched} ids=${idsOf(stMulti.data?.items).join(',')}`)
  const stComma = await bl([['status', 'To Do,In Progress']])
  check('查询REST：status 多值（逗号分隔）→ 5 条（大小写/空白不敏感）',
    stComma.data?.matched === 5 && sameSet(stComma.data?.items, ['task-201', 'task-202', 'task-204', 'task-205', 'task-206']),
    `matched=${stComma.data?.matched} ids=${idsOf(stComma.data?.items).join(',')}`)
  const exStatus = await bl([['excludeStatus', 'Done']])
  check('查询REST：excludeStatus=Done → 5 条且不含 Done',
    exStatus.data?.matched === 5 && sameSet(exStatus.data?.items, ['task-201', 'task-202', 'task-204', 'task-205', 'task-206'])
      && asArray(exStatus.data?.items).every((x) => x.status !== 'Done'),
    `matched=${exStatus.data?.matched} ids=${idsOf(exStatus.data?.items).join(',')}`)
  const exWins = await bl([['status', 'To Do,In Progress'], ['excludeStatus', 'In Progress']])
  check('查询REST：status + excludeStatus 同时给 → 排除优先（4 条，无 In Progress）',
    exWins.data?.matched === 4 && sameSet(exWins.data?.items, ['task-201', 'task-204', 'task-205', 'task-206']),
    `matched=${exWins.data?.matched} ids=${idsOf(exWins.data?.items).join(',')}`)
  const byPri = await bl([['priority', 'high']])
  check('查询REST：priority=high → 2 条（task-201/204）',
    byPri.data?.matched === 2 && sameSet(byPri.data?.items, ['task-201', 'task-204']),
    `matched=${byPri.data?.matched} ids=${idsOf(byPri.data?.items).join(',')}`)
  const byType = await bl([['type', 'bug']])
  check('查询REST：type=bug → 2 条（task-201/204）',
    byType.data?.matched === 2 && sameSet(byType.data?.items, ['task-201', 'task-204']),
    `matched=${byType.data?.matched} ids=${idsOf(byType.data?.items).join(',')}`)
  const labAll = await bl([['labels', 'backend,api']])
  check('查询REST：labels=backend,api（默认 AND）→ 2 条（task-201/204）',
    labAll.data?.matched === 2 && sameSet(labAll.data?.items, ['task-201', 'task-204']),
    `matched=${labAll.data?.matched} ids=${idsOf(labAll.data?.items).join(',')}`)
  const labAny = await bl([['labels', 'backend,docs'], ['labelMatch', 'any']])
  check('查询REST：labels + labelMatch=any → 4 条（任一标签命中）',
    labAny.data?.matched === 4 && sameSet(labAny.data?.items, ['task-201', 'task-203', 'task-204', 'task-206']),
    `matched=${labAny.data?.matched} ids=${idsOf(labAny.data?.items).join(',')}`)
  const byAssignee = await bl([['assignee', 'alice']])
  check('查询REST：assignee=alice（包含匹配，忽略大小写/@）→ 2 条（alice 与 alice@example.com）',
    byAssignee.data?.matched === 2 && sameSet(byAssignee.data?.items, ['task-201', 'task-204']),
    `matched=${byAssignee.data?.matched} ids=${idsOf(byAssignee.data?.items).join(',')}`)
  const unassigned = await bl([['unassigned', '1']])
  check('查询REST：unassigned=1 → 2 条（task-203/205）',
    unassigned.data?.matched === 2 && sameSet(unassigned.data?.items, ['task-203', 'task-205']),
    `matched=${unassigned.data?.matched} ids=${idsOf(unassigned.data?.items).join(',')}`)
  const byMilestone = await bl([['milestone', 'M-2']])
  check('查询REST：milestone=M-2 → 2 条（task-203/204）',
    byMilestone.data?.matched === 2 && sameSet(byMilestone.data?.items, ['task-203', 'task-204']),
    `matched=${byMilestone.data?.matched} ids=${idsOf(byMilestone.data?.items).join(',')}`)
  const byMilestoneNum = await bl([['milestone', '2']])
  check('查询REST：milestone 数字别名（2 ≡ M-2）→ 2 条',
    byMilestoneNum.data?.matched === 2 && sameSet(byMilestoneNum.data?.items, ['task-203', 'task-204']),
    `matched=${byMilestoneNum.data?.matched} ids=${idsOf(byMilestoneNum.data?.items).join(',')}`)
  const byParent = await bl([['parent', 'TASK-201']])
  check('查询REST：parent=TASK-201（id 归一化）→ 2 条（task-204/205）',
    byParent.data?.matched === 2 && sameSet(byParent.data?.items, ['task-204', 'task-205']),
    `matched=${byParent.data?.matched} ids=${idsOf(byParent.data?.items).join(',')}`)
  const bySearch = await bl([['search', '幂等']])
  const searchHit = asArray(bySearch.data?.items)[0]
  check('查询REST：search=幂等 → 仅正文命中 1 条（task-204，标题「支付回调」不含该词）',
    bySearch.data?.matched === 1 && searchHit?.itemId === 'task-204' && !/幂等/.test(String(searchHit?.title || '')),
    `matched=${bySearch.data?.matched} ids=${idsOf(bySearch.data?.items).join(',')} title=${searchHit?.title}`)
  const bySearchMulti = await bl([['search', '登录 重试']])
  check('查询REST：search 空白切词 AND（登录 + 重试）→ 1 条（task-201）',
    bySearchMulti.data?.matched === 1 && idsOf(bySearchMulti.data?.items)[0] === 'task-201',
    `matched=${bySearchMulti.data?.matched} ids=${idsOf(bySearchMulti.data?.items).join(',')}`)

  // ---------- 10.4 排序 / 切窗 / 计数 ----------
  // 窗口语义（doc §2：limit = 排序后**硬截断**；maxCount = skip 之后的**分页窗口大小**；二者不是别名）
  const limitHard = await bl([['sort', 'id'], ['order', 'asc'], ['limit', '3']])
  check('查询REST：limit=3（硬截断）→ task-201/202/203，窗口耗尽（nextSkip=null / cut=false）',
    sameOrder(limitHard.data?.items, ['task-201', 'task-202', 'task-203'])
      && limitHard.data?.window?.skip === 0 && limitHard.data?.window?.total === 6
      && limitHard.data?.window?.nextSkip === null && limitHard.data?.window?.cut === false
      && limitHard.data?.matched === 6,
    `ids=${idsOf(limitHard.data?.items).join(',')} window=${JSON.stringify(limitHard.data?.window || null)}`)
  const maxCountPage1 = await bl([['maxCount', '3'], ['sort', 'id'], ['order', 'asc']])
  check('查询REST：maxCount=3&skip=0（分页窗口）→ 第 1 页 3 条 + nextSkip=3/cut=true',
    sameOrder(maxCountPage1.data?.items, ['task-201', 'task-202', 'task-203'])
      && maxCountPage1.data?.window?.nextSkip === 3 && maxCountPage1.data?.window?.cut === true
      && maxCountPage1.data?.window?.total === 6,
    `ids=${idsOf(maxCountPage1.data?.items).join(',')} window=${JSON.stringify(maxCountPage1.data?.window || null)}`)
  const maxCountPage2 = await bl([['maxCount', '3'], ['skip', '3'], ['sort', 'id'], ['order', 'asc']])
  check('查询REST：maxCount=3&skip=3 → 第 2 页 task-204/205/206 + nextSkip=null/cut=true',
    sameOrder(maxCountPage2.data?.items, ['task-204', 'task-205', 'task-206'])
      && maxCountPage2.data?.window?.skip === 3 && maxCountPage2.data?.window?.nextSkip === null
      && maxCountPage2.data?.window?.cut === true,
    `ids=${idsOf(maxCountPage2.data?.items).join(',')} window=${JSON.stringify(maxCountPage2.data?.window || null)}`)
  const skipNoCap = await bl([['sort', 'id'], ['order', 'asc'], ['skip', '4']])
  check('查询REST：skip=4（无 maxCount）→ task-205/206 + nextSkip=null/cut=true（窗口省略了前 4 条）',
    sameOrder(skipNoCap.data?.items, ['task-205', 'task-206'])
      && skipNoCap.data?.window?.skip === 4 && skipNoCap.data?.window?.nextSkip === null && skipNoCap.data?.window?.cut === true,
    `ids=${idsOf(skipNoCap.data?.items).join(',')} window=${JSON.stringify(skipNoCap.data?.window || null)}`)
  const limitThenWindow = await bl([['limit', '3'], ['maxCount', '5'], ['skip', '2'], ['sort', 'id'], ['order', 'asc']])
  check('查询REST：limit=3&maxCount=5&skip=2 → limit 先硬截断再切窗（只剩 task-203，证明 limit≠maxCount 别名）',
    sameOrder(limitThenWindow.data?.items, ['task-203'])
      && limitThenWindow.data?.window?.skip === 2 && limitThenWindow.data?.window?.nextSkip === null
      && limitThenWindow.data?.window?.cut === true,
    `ids=${idsOf(limitThenWindow.data?.items).join(',')} window=${JSON.stringify(limitThenWindow.data?.window || null)}`)
  // 注意：priority 的 order 沿用 TASK-SORT-2 既有语义（asc=高→低，与 backlog-query.test.ts 一致）
  const sortPriAsc = await bl([['sort', 'priority'], ['order', 'asc']])
  check('查询REST：sort=priority&order=asc → 高→低（high,medium,low 各两条，同权重按 id 升序）',
    sameOrder(sortPriAsc.data?.items, ['task-201', 'task-204', 'task-202', 'task-205', 'task-203', 'task-206']),
    `ids=${idsOf(sortPriAsc.data?.items).join(',')}`)
  const sortPriDesc = await bl([['sort', 'priority'], ['order', 'desc']])
  check('查询REST：sort=priority&order=desc → 低→高（同权重内按 id 倒序）',
    sameOrder(sortPriDesc.data?.items, ['task-206', 'task-203', 'task-205', 'task-202', 'task-204', 'task-201']),
    `ids=${idsOf(sortPriDesc.data?.items).join(',')}`)
  const countOnly = await bl([['count', '1']])
  check('查询REST：count=1 → items=[] 且计数照常（matched=6）',
    asArray(countOnly.data?.items).length === 0 && countOnly.data?.matched === 6 && countOnly.data?.total === 6,
    `items=${asArray(countOnly.data?.items).length} matched=${countOnly.data?.matched}`)
  const echo = await bl([['status', 'To Do'], ['limit', '2']])
  check('查询REST：query 回显解析结果（status 数组 / limit 数值）',
    asArray(echo.data?.query?.status).some((s) => String(s).toLowerCase() === 'to do') && echo.data?.query?.limit === 2,
    JSON.stringify(echo.data?.query || null))

  // ---------- 10.5 非法参数 → 400 INVALID_QUERY（doc §4.1） ----------
  const badLimit = await bl([['limit', '0']])
  check('查询REST：limit=0 → 400 + ok:false + code=INVALID_QUERY',
    badLimit.status === 400 && badLimit.json?.ok === false && badLimit.json?.code === 'INVALID_QUERY',
    `status=${badLimit.status} code=${badLimit.json?.code}`)
  const badSkip = await bl([['skip', '-1']])
  check('查询REST：skip=-1 → 400 + code=INVALID_QUERY',
    badSkip.status === 400 && badSkip.json?.code === 'INVALID_QUERY',
    `status=${badSkip.status} code=${badSkip.json?.code}`)
  const badNum = await bl([['limit', 'abc']])
  check('查询REST：limit=abc（非数字）→ 400 + code=INVALID_QUERY',
    badNum.status === 400 && badNum.json?.code === 'INVALID_QUERY',
    `status=${badNum.status} code=${badNum.json?.code}`)
  const badMutual = await bl([['assignee', 'alice'], ['unassigned', '1']])
  check('查询REST：assignee + unassigned 互斥 → 400 + code=INVALID_QUERY',
    badMutual.status === 400 && badMutual.json?.ok === false && badMutual.json?.code === 'INVALID_QUERY',
    `status=${badMutual.status} code=${badMutual.json?.code}`)

  // ---------- 10.6 overview：逐项目过滤 + summary/facets + openOnly + matched=0 保留 ----------
  const ov = async (pairs = []) => {
    const r = await req('GET', `${PREFIX}/api/backlog/overview?${new URLSearchParams(pairs).toString()}`)
    return { status: r.status, json: r.json, data: r.json?.data }
  }
  const ovP5 = await ov([['projectIds', p5.id]])
  const qOvRows = asArray(ovP5.data)
  const row5 = qOvRows.find((x) => x?.projectId === p5.id)
  check('overview：projectIds 生效（仅返回 P5 一个项目分组，nodeStatus=ok）',
    ovP5.status === 200 && ovP5.json?.ok === true && qOvRows.length === 1 && row5?.nodeStatus === 'ok',
    `status=${ovP5.status} rows=${qOvRows.length} node=${row5?.nodeStatus}`)
  check('overview：逐项目 total/matched（6/6，未过滤总数与过滤命中数分离）',
    row5?.total === 6 && row5?.matched === 6, `total=${row5?.total} matched=${row5?.matched}`)
  check('overview：逐项目计数 open/done/ready/blocked（5/1/3/2）',
    row5?.open === 5 && row5?.done === 1 && row5?.ready === 3 && row5?.blocked === 2,
    `open=${row5?.open} done=${row5?.done} ready=${row5?.ready} blocked=${row5?.blocked}`)
  check('overview：逐项目 facets 存在且 statuses 计数正确（To Do=4）',
    facetCount(row5?.facets, 'statuses', 'To Do') === 4,
    JSON.stringify(row5?.facets?.statuses || []))
  check('overview：信封 summary 正确（projects=1 / total=6 / matched=6 / open=5 / ready=3 / blocked=2 / unreachable=0）',
    ovP5.json?.summary?.projects === 1 && ovP5.json?.summary?.total === 6 && ovP5.json?.summary?.matched === 6
      && ovP5.json?.summary?.open === 5 && ovP5.json?.summary?.ready === 3
      && ovP5.json?.summary?.blocked === 2 && ovP5.json?.summary?.unreachable === 0,
    JSON.stringify(ovP5.json?.summary || null))
  check('overview：信封 facets 为项目并集（statuses 含 To Do=4）',
    facetCount(ovP5.json?.facets, 'statuses', 'To Do') === 4,
    JSON.stringify(ovP5.json?.facets?.statuses || []))
  const ovOpen = await ov([['projectIds', p5.id], ['openOnly', '1']])
  const row5Open = asArray(ovOpen.data).find((x) => x?.projectId === p5.id)
  check('overview：openOnly=1 逐项目排除已完成（P5 matched=5 / 无 Done 条目）',
    row5Open?.matched === 5 && asArray(row5Open?.items).length === 5
      && asArray(row5Open?.items).every((x) => x.status !== 'Done'),
    `matched=${row5Open?.matched} items=${asArray(row5Open?.items).length}`)
  const ovSearch = await ov([['projectIds', p5.id], ['search', '幂等']])
  const row5Search = asArray(ovSearch.data).find((x) => x?.projectId === p5.id)
  check('overview：查询参数生效 + query 回显（search=幂等 → P5 matched=1 / task-204）',
    row5Search?.matched === 1 && sameSet(row5Search?.items, ['task-204']) && ovSearch.json?.query?.search === '幂等',
    `matched=${row5Search?.matched} ids=${idsOf(row5Search?.items).join(',')} query=${JSON.stringify(ovSearch.json?.query || null)}`)
  const ovNone = await ov([['search', '绝不存在关键词xyz']])
  const rowsNone = asArray(ovNone.data)
  const row5None = rowsNone.find((x) => x?.projectId === p5.id)
  check('overview：matched=0 的项目仍返回（5 个项目分组都在，P5 matched=0 且 items=[]，保留失败隔离语义）',
    ovNone.status === 200 && rowsNone.length === 5 && row5None?.matched === 0 && asArray(row5None?.items).length === 0,
    `rows=${rowsNone.length} p5.matched=${row5None?.matched} items=${asArray(row5None?.items).length}`)

  // ---------- 10.7 工具通道：filter 新字段 + 回包字段 + view readiness ----------
  const t5list = async (filter) => (await tool('list', { projectId: p5.id, filter })).result
  const tlStatus = await t5list({ status: ['To Do'], priority: ['high'] })
  check('tools list：filter.status 多值 + priority 组合 → 2 条（task-201/204）',
    tlStatus?.ok === true && tlStatus?.matched === 2 && sameSet(tlStatus?.items, ['task-201', 'task-204']),
    `matched=${tlStatus?.matched} ids=${idsOf(tlStatus?.items).join(',')}`)
  check('tools list：回包带 total/counts/window/facets（total=6 / ready=3 / window.total=命中数 2 / facets.statuses 3 项）',
    tlStatus?.total === 6 && tlStatus?.counts?.ready === 3 && tlStatus?.counts?.blocked === 2
      && tlStatus?.window?.total === 2 && asArray(tlStatus?.facets?.statuses).length === 3,
    `total=${tlStatus?.total} counts=${JSON.stringify(tlStatus?.counts || null)} window=${JSON.stringify(tlStatus?.window || null)}`)
  check('tools list：条目带 isReady/blocked 派生字段',
    asArray(tlStatus?.items).every((x) => typeof x?.isReady === 'boolean' && typeof x?.blocked === 'boolean'),
    JSON.stringify(asArray(tlStatus?.items).map((x) => ({ itemId: x?.itemId, isReady: x?.isReady, blocked: x?.blocked }))))
  const tlReady = await t5list({ ready: true })
  check('tools list：filter.ready=true → 3 条（task-201/204/205）',
    tlReady?.ok === true && tlReady?.matched === 3 && sameSet(tlReady?.items, ['task-201', 'task-204', 'task-205']),
    `matched=${tlReady?.matched} ids=${idsOf(tlReady?.items).join(',')}`)
  const tlBlocked = await t5list({ blocked: true })
  check('tools list：filter.blocked=true → 2 条（task-202/206）',
    tlBlocked?.ok === true && tlBlocked?.matched === 2 && sameSet(tlBlocked?.items, ['task-202', 'task-206']),
    `matched=${tlBlocked?.matched} ids=${idsOf(tlBlocked?.items).join(',')}`)
  const tlEx = await t5list({ excludeStatus: ['Done'], type: ['bug'] })
  check('tools list：filter.excludeStatus + type → 2 条（bug 且非 Done）',
    tlEx?.ok === true && tlEx?.matched === 2 && sameSet(tlEx?.items, ['task-201', 'task-204']),
    `matched=${tlEx?.matched} ids=${idsOf(tlEx?.items).join(',')}`)
  const tlAny = await t5list({ labels: ['backend', 'docs'], labelMatch: 'any' })
  check('tools list：filter.labels + labelMatch=any → 4 条',
    tlAny?.ok === true && tlAny?.matched === 4 && sameSet(tlAny?.items, ['task-201', 'task-203', 'task-204', 'task-206']),
    `matched=${tlAny?.matched} ids=${idsOf(tlAny?.items).join(',')}`)
  const tlMs = await t5list({ milestone: 'M-1' })
  check('tools list：filter.milestone=M-1 → 3 条（task-201/202/205）',
    tlMs?.ok === true && tlMs?.matched === 3 && sameSet(tlMs?.items, ['task-201', 'task-202', 'task-205']),
    `matched=${tlMs?.matched} ids=${idsOf(tlMs?.items).join(',')}`)
  const tlParent = await t5list({ parent: 'TASK-201' })
  check('tools list：filter.parent=TASK-201（id 归一化）→ 2 条（task-204/205）',
    tlParent?.ok === true && tlParent?.matched === 2 && sameSet(tlParent?.items, ['task-204', 'task-205']),
    `matched=${tlParent?.matched} ids=${idsOf(tlParent?.items).join(',')}`)
  const tlSearch = await t5list({ search: '幂等' })
  check('tools list：filter.search 正文命中 → 1 条（task-204）',
    tlSearch?.ok === true && tlSearch?.matched === 1 && sameSet(tlSearch?.items, ['task-204']),
    `matched=${tlSearch?.matched} ids=${idsOf(tlSearch?.items).join(',')}`)
  const tlWindow = await t5list({ sort: 'id', order: 'asc', maxCount: 2, skip: 2 })
  check('tools list：sort=id + maxCount/skip 分页窗口（task-203/204；window.nextSkip=4/cut=true）',
    tlWindow?.ok === true && sameOrder(tlWindow?.items, ['task-203', 'task-204'])
      && tlWindow?.window?.skip === 2 && tlWindow?.window?.nextSkip === 4 && tlWindow?.window?.cut === true,
    `ids=${idsOf(tlWindow?.items).join(',')} window=${JSON.stringify(tlWindow?.window || null)}`)
  const tlLimit = await t5list({ limit: 2 })
  check('tools list：filter.limit=2（硬截断）→ 2 条 + window.total=6 / nextSkip=null / cut=false',
    tlLimit?.ok === true && asArray(tlLimit?.items).length === 2
      && tlLimit?.window?.total === 6 && tlLimit?.window?.nextSkip === null && tlLimit?.window?.cut === false,
    `items=${asArray(tlLimit?.items).length} window=${JSON.stringify(tlLimit?.window || null)}`)
  const tlCount = await t5list({ count: true })
  check('tools list：filter.count=true → items=[] 且 matched=6（只计数）',
    tlCount?.ok === true && asArray(tlCount?.items).length === 0 && tlCount?.matched === 6,
    `items=${asArray(tlCount?.items).length} matched=${tlCount?.matched}`)
  const tlBadLimit = await t5list({ limit: 0 })
  check('tools list：filter.limit=0 → ok:false（数值非法）',
    tlBadLimit?.ok === false && /limit/.test(String(tlBadLimit?.error || '')),
    `error=${String(tlBadLimit?.error || '').slice(0, 100)}`)
  const tlBadMutual = await t5list({ assignee: 'alice', unassigned: true })
  check('tools list：filter.assignee + unassigned 互斥 → ok:false',
    tlBadMutual?.ok === false && /assignee|unassigned/.test(String(tlBadMutual?.error || '')),
    `error=${String(tlBadMutual?.error || '').slice(0, 100)}`)
  const v5ready = viewItem(await tool('view', { projectId: p5.id, itemId: 'task-204' }))
  check('tools view：带 readiness（task-204 isReady=true / blocked=false）',
    v5ready?.isReady === true && v5ready?.blocked === false,
    `isReady=${v5ready?.isReady} blocked=${v5ready?.blocked}`)
  const v5blocked = viewItem(await tool('view', { projectId: p5.id, itemId: 'task-202' }))
  check('tools view：被阻塞条目带 blockingDependencies（task-202 ← task-201）',
    v5blocked?.blocked === true
      && asArray(v5blocked?.blockingDependencies).some((d) => String(d).toLowerCase() === 'task-201'),
    `blocked=${v5blocked?.blocked} blocking=${JSON.stringify(v5blocked?.blockingDependencies || null)}`)
  // 工具通道 overview：逐项目计数为**扁平字段**（Lead 2026-11-02 契约确认：与 REST §4.2 一致，不套 counts 对象）
  const tOv = (await tool('overview', { filter: { projectIds: [p5.id] } })).result
  const tOvRows = pickedArray(tOv, ['projects', 'overview'])
  const tRow5 = tOvRows.find((x) => x?.projectId === p5.id)
  check('tools overview：projectIds 生效 + 逐项目 matched（默认剔除已完成 → 5 / open=5 / done=1）',
    tOv?.ok === true && tOvRows.length === 1 && tRow5?.matched === 5
      && tRow5?.open === 5 && tRow5?.done === 1,
    `rows=${tOvRows.length} matched=${tRow5?.matched} open=${tRow5?.open} done=${tRow5?.done}`)
  check('tools overview：逐项目 readiness 计数（扁平字段 ready=3 / blocked=2）',
    tRow5?.ready === 3 && tRow5?.blocked === 2,
    `ready=${tRow5?.ready} blocked=${tRow5?.blocked}`)
  check('tools overview：信封 summary（projects=1 / total=6 / matched=5 / open=5 / ready=3 / blocked=2）+ facets.statuses',
    tOv?.summary?.projects === 1 && tOv?.summary?.total === 6 && tOv?.summary?.matched === 5
      && tOv?.summary?.open === 5 && tOv?.summary?.ready === 3 && tOv?.summary?.blocked === 2
      && facetCount(tOv?.facets, 'statuses', 'To Do') === 4,
    `summary=${JSON.stringify(tOv?.summary || null)} facets=${JSON.stringify(tOv?.facets?.statuses || [])}`)
  const tOvAll = (await tool('overview', { filter: { projectIds: [p5.id], includeDone: true } })).result
  const tRow5All = pickedArray(tOvAll, ['projects', 'overview']).find((x) => x?.projectId === p5.id)
  check('tools overview：includeDone=true 含已完成（matched=6）',
    tOvAll?.ok === true && tRow5All?.matched === 6,
    `matched=${tRow5All?.matched}`)
  const tOvSearch = (await tool('overview', { filter: { projectIds: [p5.id], search: '幂等' } })).result
  const tRow5Search = pickedArray(tOvSearch, ['projects', 'overview']).find((x) => x?.projectId === p5.id)
  check('tools overview：filter.search 生效（matched=1 / task-204）',
    tOvSearch?.ok === true && tRow5Search?.matched === 1 && sameSet(tRow5Search?.items, ['task-204']),
    `matched=${tRow5Search?.matched} ids=${idsOf(tRow5Search?.items).join(',')}`)
  const tSearchNoFilter = await tool('search', { projectId: p5.id })
  check('tools search：缺 filter.search 仍 ok:false（查询段共用同一契约）',
    tSearchNoFilter.result?.ok === false && /filter\.search|search/.test(String(tSearchNoFilter.result?.error || '')),
    `error=${String(tSearchNoFilter.result?.error || '').slice(0, 100)}`)

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
