#!/usr/bin/env node
/** task-56: isolated HTTP/MCP + persisted store + live-resolved mock ONENAT/DSH nodes. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createApp } from '../dist/server.js'

const prefix = '/onenat-workbuddy'
const dataDir = await mkdtemp(join(tmpdir(), 'wb-project-execution-'))
const observations = []
const sessions = new Map()
let seq = 0, rpcSeq = 0, checks = 0, app, base, cookie, workerId
const token = 'task56-isolated-token'
const keys = { owner: 'owner-key', executor: 'executor-key' }
const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
const listen = server => new Promise(r => server.listen(0, '127.0.0.1', r))
const nodes = []
async function node(name) {
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part
    let body; try { body = JSON.parse(raw) } catch {}
    const url = new URL(req.url, 'http://mock')
    observations.push({ name, method: req.method, path: url.pathname, query: url.search, body, auth: req.headers.authorization })
    if (req.headers.authorization !== 'Bearer ' + keys[name]) return json(res, { ok: false, error: 'wrong node credential' }, 401)
    if (url.pathname.endsWith('/system/status')) return json(res, { ok: true, data: { name: 'dsh-web-service', version: '0.6.1' } })
    if (url.pathname.endsWith('/workspaces') && req.method === 'GET') return json(res, { ok: true, data: [] })
    if (url.pathname.endsWith('/fs/list')) {
      const path = url.searchParams.get('path') || '/', next = path === '/' ? 'owner' : path === '/owner' ? 'project' : undefined
      return json(res, { ok: true, data: { path, home: '/', entries: next ? [{ name: next, path: (path === '/' ? '' : path) + '/' + next, type: 'dir', hidden: false }] : [], truncated: false } })
    }
    if (url.pathname.endsWith('/fs/mkdir')) return json(res, { ok: true, data: { path: body.path + '/' + body.name } })
    if (url.pathname.endsWith('/sessions') && req.method === 'POST') {
      const id = `session-${name}-${++seq}`
      sessions.set(id, { name, cwd: body.cwd || `/${name}/scratch`, status: 'idle' })
      return json(res, { ok: true, data: { sessionId: id } })
    }
    const match = /\/sessions\/([^/]+)(?:\/(.*))?$/.exec(url.pathname)
    if (match) {
      const session = sessions.get(match[1])
      if (!session || session.name !== name) return json(res, { ok: false, error: 'session missing' }, 404)
      if (match[2] === 'files') return json(res, { ok: true, data: { files: [{ name: '.workbuddy-workspace-remote-v3.mjs', path: `${session.cwd}/.workbuddy-workspace-remote-v3.mjs` }] } })
      if (match[2] === 'permission') return json(res, { ok: true, data: { preset: 'danger-full-access' } })
      if (match[2] === 'prompt-stream') {
        let text = 'mock execution completed'
        if (body.prompt.includes('<<<OBJECTIVE>>>')) {
          assert.ok(workerId)
          text = JSON.stringify({ strategy: 'parallel', subtasks: [{ title: '验证子会话', prompt: '验证项目目录隔离', agentId: workerId, dependsOn: [] }] })
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        return res.end(`event: delta\ndata: ${JSON.stringify({ delta: text })}\n\nevent: turn_end\ndata: {"reason":"stop"}\n\nevent: done\ndata: [DONE]\n\n`)
      }
      if (match[2] === 'history') return json(res, { ok: true, data: { messages: [] } })
      if (!match[2]) return json(res, { ok: true, data: session })
    }
    return json(res, { ok: false, error: 'unsupported mock endpoint' }, 404)
  })
  await listen(server); nodes.push(server)
  return { server, port: server.address().port }
}
const owner = await node('owner'), executor = await node('executor'), drift = await node('executor')
let execPort = executor.port, executorOnline = true
const refs = { owner: { kind: 'mapping', mappingId: 'file-owner' }, executor: { kind: 'mapping', mappingId: 'execution' }, app: { kind: 'app', appId: 'executor-app' } }
const directory = createServer((req, res) => {
  const url = new URL(req.url, 'http://directory')
  if (url.pathname === '/api/v1/resources') return json(res, { tunnels: [
    { id: 'owner', name: 'Owner', online: true, mappings: [{ id: 'file-owner', proto: 'tcp', public_url: `tcp://127.0.0.1:${owner.port}`, local: '127.0.0.1:3080', app: { id: 'owner-app', name: 'DSH', type: 'http-api', skills: [{ name: 'dsh-web-service' }] } }] },
    { id: 'executor', name: 'Executor', online: executorOnline, mappings: [{ id: 'execution', proto: 'tcp', public_url: `tcp://127.0.0.1:${execPort}`, local: '127.0.0.1:3080', app: { id: 'executor-app', name: 'DSH', type: 'http-api', skills: [{ name: 'dsh-web-service' }] } }] },
  ] })
  if (url.pathname.includes('/credentials')) return json(res, { auth_type: 'bearer', apiKey: url.pathname.includes('file-owner') ? keys.owner : keys.executor })
  return json(res, { ok: false }, 404)
})
await listen(directory)
const config = { host: '127.0.0.1', port: 0, prefix, dataDir, onenatBaseUrl: `http://127.0.0.1:${directory.address().port}`, onenatApiKey: 'mock', apiToken: token, autoRefreshMs: 3600000, xiaozhiMcp: '', adminUsername: 'workbuddy', adminPassword: 'workbuddy-admin', quiet: true }
async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const res = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) })
  if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0]
  return { status: res.status, body: await res.json() }
}
async function mcp(name, args) {
  const res = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcSeq, method: 'tools/call', params: { name, arguments: args } }), signal: AbortSignal.timeout(15000) })
  assert.equal(res.status, 200)
  const rpc = await res.json(); assert.ok(rpc.result, JSON.stringify(rpc))
  return JSON.parse(rpc.result.content[0].text)
}
async function boot() {
  app = createApp(config); await listen(app.server)
  base = `http://127.0.0.1:${app.server.address().port}${prefix}`
  cookie = ''; assert.equal((await api('/auth/login', { username: 'workbuddy', password: 'workbuddy-admin' })).status, 200)
}
async function stop() {
  app.store.flush(); await app.close(); await new Promise(r => setTimeout(r, 100)); app = undefined
}
async function done(id) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const task = (await api('/tasks/' + id)).body.data
    if (task && task.status !== 'running' && task.status !== 'draft') return task
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error('task did not settle: ' + id)
}
async function check(name, fn) { await fn(); checks++; console.log('PASS ' + name) }
let projectId, implicitId, explicitId, sessionId
try {
  await boot()
  await check('#1 REST stores owner, credential, root and default execution independently', async () => {
    const p = await api('/projects', { name: 'Execution project', dshRef: refs.owner, apiKey: keys.owner, workspace: '/owner/project', defaultExecutionNodeRef: refs.executor })
    assert.equal(p.status, 200); projectId = p.body.data.id
    await api('/projects/' + projectId, { name: 'Renamed project' }, 'PATCH')
    let saved = app.store.getProject(projectId)
    assert.deepEqual(saved.dshRef, refs.owner); assert.equal(saved.workspace, '/owner/project'); assert.equal(saved.apiKey, keys.owner); assert.deepEqual(saved.defaultExecutionNodeRef, refs.executor)
    assert.equal((await api('/projects/' + projectId, { defaultExecutionNodeRef: null }, 'PUT')).status, 200)
    assert.equal(app.store.getProject(projectId).defaultExecutionNodeRef, undefined)
    await api('/projects/' + projectId, { defaultExecutionNodeRef: refs.executor }, 'PUT')
  })
  await check('#2 REST defaults, explicit override, fork and default mutation preserve task snapshots', async () => {
    const implicit = await api('/tasks', { projectId, title: 'implicit', memberAgentIds: [] })
    const explicit = await api('/tasks', { projectId, title: 'explicit', nodeRef: refs.owner, memberAgentIds: [] })
    assert.equal(implicit.status, 201); assert.equal(explicit.status, 201)
    implicitId = implicit.body.data.id; explicitId = explicit.body.data.id
    assert.deepEqual(implicit.body.data.nodeRef, refs.executor); assert.deepEqual(explicit.body.data.nodeRef, refs.owner)
    await api('/projects/' + projectId, { defaultExecutionNodeRef: refs.owner }, 'PUT')
    const fork = await api('/tasks/' + implicitId + '/fork', {})
    assert.deepEqual(fork.body.data.task.nodeRef, refs.executor)
    assert.deepEqual((await api('/tasks/' + implicitId)).body.data.nodeRef, refs.executor)
    // Legacy tasks without snapshots keep their effective owner node when continuing in the same project.
    const legacy = await api('/tasks', { projectId, memberAgentIds: [] })
    app.store.mutateTask(legacy.body.data.id, t => { delete t.nodeRef })
    await api('/projects/' + projectId, { defaultExecutionNodeRef: refs.executor }, 'PATCH')
    const legacyFork = await api('/tasks/' + legacy.body.data.id + '/fork', {})
    assert.deepEqual(legacyFork.body.data.task.nodeRef, refs.owner)
    assert.equal((await api('/tasks/' + legacy.body.data.id)).body.data.nodeRef, undefined)
  })
  await check('#2 MCP mapping/app/direct overrides are distinct; retries only reuse same execution context', async () => {
    const title = 'same request'
    const direct = { kind: 'direct', apiBaseUrl: `http://127.0.0.1:${execPort}/api/v1` }
    const outputs = []
    // Draft requests avoid executing identical work: only protocol acceptance and dedupe are checked here.
    for (const nodeRef of [refs.owner, refs.app, direct]) {
      const out = await mcp('workbuddy_task_manage', { action: 'create', title, projectId, nodeRef })
      assert.equal(out.ok, true); assert.equal(out.deduped, undefined)
      assert.deepEqual(app.store.getTask(out.taskId).nodeRef, nodeRef); outputs.push(out)
    }
    const retry = await mcp('workbuddy_task_manage', { action: 'create', title, projectId, nodeRef: refs.app })
    assert.equal(retry.taskId, outputs[1].taskId); assert.equal(retry.deduped, true)
    const invalid = await mcp('workbuddy_task_manage', { action: 'create', title: 'invalid', projectId, nodeRef: { kind: 'app' } })
    assert.equal(invalid.ok, false)
    const edited = await mcp('workbuddy_project_manage', { action: 'upsert', project: { id: projectId, defaultExecutionNodeRef: refs.app } })
    assert.equal(edited.ok, true); assert.deepEqual(app.store.getProject(projectId).dshRef, refs.owner)
  })
  await check('#1/#2 disk restart retains both node fields and old task snapshots', async () => {
    await stop()
    const disk = JSON.parse(await readFile(join(dataDir, 'store.json'), 'utf8'))
    const p = disk.projects.find(p => p.id === projectId)
    assert.deepEqual(p.dshRef, refs.owner); assert.deepEqual(p.defaultExecutionNodeRef, refs.app); assert.equal(p.apiKey, keys.owner)
    await boot()
    assert.deepEqual((await api('/tasks/' + implicitId)).body.data.nodeRef, refs.executor)
    assert.deepEqual((await api('/tasks/' + explicitId)).body.data.nodeRef, refs.owner)
  })
  await check('#3 main remote session uses executor scratch; files and credentials still resolve owner', async () => {
    const start = observations.length
    assert.equal((await api('/tasks/' + implicitId + '/messages', { message: '检查项目文件归属' })).status, 202)
    const task = await done(implicitId); assert.equal(task.status, 'completed')
    const binding = task.sessions.__node__; sessionId = binding.remoteSessionId
    assert.equal(binding.nodeRefKey, 'mapping:execution'); assert.equal(sessions.get(sessionId).cwd, '/executor/scratch')
    const calls = observations.slice(start)
    const prompt = calls.find(o => o.path.endsWith('/prompt-stream'))?.body.prompt
    assert.ok(prompt.includes('[项目工作区跨机访问]')); assert.ok(prompt.includes(`127.0.0.1:${owner.port}/api/v1`))
    assert.ok(calls.filter(o => o.path.endsWith('/sessions')).every(o => o.body.cwd !== '/owner/project' && !o.body.workspaceId))
    const files = await api('/agents/fs/list?projectId=' + projectId + '&node=' + encodeURIComponent(JSON.stringify(refs.executor)) + '&path=%2Fowner%2Fproject&all=1')
    assert.equal(files.status, 200)
    assert.ok(observations.some(o => o.name === 'owner' && o.path.endsWith('/fs/list') && o.auth === 'Bearer owner-key'))
    assert.ok(!calls.some(o => o.name === 'executor' && o.path.endsWith('/fs/mkdir')))
  })
  await check('#2 live directory port drift reuses stable-node session and ignores modified project default', async () => {
    execPort = drift.port
    const start = observations.length
    await api('/projects/' + projectId, { defaultExecutionNodeRef: refs.owner }, 'PUT')
    await api('/tasks/' + implicitId + '/messages', { message: '继续同一个执行节点会话' })
    const task = await done(implicitId)
    assert.equal(task.status, 'completed'); assert.equal(task.sessions.__node__.remoteSessionId, sessionId)
    assert.ok(task.sessions.__node__.baseUrl.includes(':' + drift.port)); assert.deepEqual(task.nodeRef, refs.executor)
    assert.ok(observations.slice(start).some(o => o.name === 'executor' && o.path.endsWith('/prompt-stream')))
    assert.ok(!observations.slice(start).some(o => o.name === 'owner' && o.path.endsWith('/prompt-stream')))
  })
  await check('#3 actual planning and child session payloads never use remote project cwd or mkdir', async () => {
    const worker = await api('/agents', { name: 'Isolated worker', dshRef: refs.executor, workDir: '/executor/worker', apiKey: keys.executor })
    assert.equal(worker.status, 200); workerId = worker.body.data.id
    const task = await api('/tasks', { projectId, nodeRef: refs.executor, memberAgentIds: [], message: '@Isolated worker 验证项目隔离' })
    const final = await done(task.body.data.id)
    assert.equal(final.status, 'success')
    const calls = observations.filter(o => o.path.endsWith('/sessions') && o.body?.title?.startsWith('主调度规划'))
    assert.ok(calls.length > 0, 'must actually create planning session')
    assert.ok(calls.every(o => o.name === 'executor' && o.body.cwd === undefined))
    assert.equal(final.sessions[workerId].cwd, '/executor/worker')
    const workerPrompt = observations.find(o => o.path.includes(final.sessions[workerId].remoteSessionId) && o.path.endsWith('/prompt-stream'))?.body.prompt
    assert.ok(workerPrompt.includes('[项目工作区跨机访问]'))
    assert.ok(!observations.some(o => o.name === 'executor' && o.path.endsWith('/fs/mkdir') && o.body.path.startsWith('/owner')))
  })
  await check('#2 offline selected executor fails without moving to owner or creating mirror path', async () => {
    executorOnline = false
    const start = observations.length
    const created = await api('/tasks', { projectId, nodeRef: refs.executor, memberAgentIds: [], message: '离线执行节点验收' })
    const task = await done(created.body.data.id)
    assert.equal(task.status, 'failed'); assert.deepEqual(task.nodeRef, refs.executor)
    assert.ok(!observations.slice(start).some(o => o.path.endsWith('/sessions') || o.path.endsWith('/fs/mkdir')))
  })
  console.log(`PASS task-56 project execution integration: ${checks}/${checks} groups`)
} finally {
  if (app) await stop()
  await Promise.all([directory, ...nodes].map(server => new Promise(r => { server.close(r); server.closeAllConnections() })))
  const target = resolve(dataDir); assert.ok(target.startsWith(join(tmpdir(), 'wb-project-execution-')))
  await rm(target, { recursive: true, force: true })
}
