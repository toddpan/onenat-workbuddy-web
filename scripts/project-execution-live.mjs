#!/usr/bin/env node
/** Opt-in task-56 live acceptance. Isolated WorkBuddy data; only temporary remote fixtures. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { createApp } from '../dist/server.js'
import { OnenatDirectory } from '../dist/onenat.js'
import { DshClient } from '../dist/remote-client.js'

assert.equal(process.env.WORKBUDDY_LIVE_ACCEPTANCE, '1', 'Set WORKBUDDY_LIVE_ACCEPTANCE=1 to run real-node acceptance')
const settings = JSON.parse(await readFile(process.env.ONENAT_SETTINGS_FILE || join(homedir(), '.dsh/dsh-onenat/store.json'), 'utf8')).settings.onenat
const ownerId = process.env.WORKBUDDY_FILE_NODE || '6cc2987d'
const executionId = process.env.WORKBUDDY_EXECUTION_NODE || '5602f2c2'
assert.notEqual(ownerId, executionId)
const dataDir = await mkdtemp(join(tmpdir(), 'wb-task56-live-'))
const tag = 'wb-task56-' + randomBytes(8).toString('hex')
const ownerRoot = '/tmp/' + tag + '-owner', executionRoot = '/tmp/' + tag + '-executor'
const marker = 'owner-only-' + randomBytes(18).toString('hex')
const markerSha = createHash('sha256').update(marker).digest('hex')
const report = { at: new Date().toISOString(), tag, nodes: { owner: ownerId, execution: executionId }, checks: [], requests: [], cleanup: [] }
const reportPath = 'artifacts/task56/live-acceptance.json'
await mkdir('artifacts/task56', { recursive: true })
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2))
const directory = new OnenatDirectory(settings.baseUrl, settings.apiKey)
const client = new DshClient()
const sessions = [], workspacesBefore = new Map()
const nativeFetch = globalThis.fetch
const redact = text => String(text).replace(/(?:wba_|dsh_|onk-)[A-Za-z0-9_-]+/g, '[redacted]')
let app, base, cookie = '', projectId
// Observe payloads without storing prompts/credentials. Production transport still uses the original fetch.
globalThis.fetch = async (url, init = {}) => {
  const path = new URL(String(url)).pathname
  if (/\/api\/v1\/sessions$/.test(path) && init.method === 'POST' && typeof init.body === 'string') {
    const b = JSON.parse(init.body)
    report.requests.push({ url: String(url), cwd: b.cwd, workspaceId: b.workspaceId, title: b.title })
  }
  const response = await nativeFetch(url, init)
  if (/\/api\/v1\/sessions$/.test(path) && init.method === 'POST' && response.ok) {
    const j = await response.clone().json().catch(() => ({}))
    if (j.data?.sessionId) {
      const record = { base: String(url).replace(/\/sessions$/, ''), id: j.data.sessionId }
      if (!sessions.some(s => s.id === record.id && s.base === record.base)) sessions.push(record)
    }
  }
  return response
}
async function target(id) {
  await directory.refresh(true)
  const ep = directory.resolveMapping(id)
  assert.ok(ep?.online && ep.baseUrl, 'live ONENAT node must be online: ' + id)
  const cred = await directory.fetchMappingCredentials(id)
  assert.ok(cred.ok && (cred.apiKey || cred.token), 'authorized credentials unavailable: ' + id)
  return { baseUrl: ep.baseUrl, apiKey: cred.apiKey || cred.token }
}
async function request(t, path, body, method = body === undefined ? 'GET' : 'POST') {
  const res = await fetch(t.baseUrl + path, { method, headers: { Authorization: `Bearer ${t.apiKey}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(12000) })
  const j = await res.json().catch(() => ({}))
  assert.ok(res.ok && j.ok, `${method} ${path}: ${res.status} ${redact(j.error || '')}`)
  return j.data
}
async function api(path, body, method = body === undefined ? 'GET' : 'POST', timeoutMs = 15000) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) })
  if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0]
  const j = await res.json(); assert.ok(res.ok && j.ok, `${path}: ${redact(j.error || JSON.stringify(j))}`)
  return j.data || j
}
async function settle(id, deadline = Date.now() + 240000) {
  let notedAt = 0
  while (Date.now() < deadline) {
    const task = app.store.getTask(id)
    if (task && task.status !== 'running' && task.status !== 'draft') return task
    if (Date.now() - notedAt > 15000) { console.log('live waiting', id, task?.status); notedAt = Date.now() }
    await new Promise(r => setTimeout(r, 2000))
  }
  await api('/tasks/' + id + '/cancel', {})
  throw new Error('live task timed out: ' + id)
}
async function check(name, fn) {
  try { const evidence = await fn(); report.checks.push({ name, result: 'PASS', evidence }); console.log('PASS ' + name); await save() }
  catch (error) { report.checks.push({ name, result: 'FAIL', error: redact(error.message) }); await save(); throw error }
}
try {
  let owner = await target(ownerId), executor = await target(executionId)
  for (const [id, t] of [[ownerId, owner], [executionId, executor]]) {
    assert.equal((await client.ping(t, { timeoutMs: 6000 })).ok, true)
    const catalog = await request(t, '/models')
    const models = Array.isArray(catalog) ? catalog : catalog.models
    assert.ok(models.some(m => m.provider === 'deepseek-official' && m.id === 'deepseek-v4-flash'), 'requested test model must exist')
    const before = await request(t, '/workspaces')
    workspacesBefore.set(id, new Set((Array.isArray(before) ? before : before.workspaces || []).map(w => w.id)))
  }
  await check('real owner fixture and different executor filesystem', async () => {
    assert.equal((await client.fsMkdir(owner, '/tmp', tag + '-owner')).ok, true)
    assert.equal((await client.fsMkdir(executor, '/tmp', tag + '-executor')).ok, true)
    const created = await client.createSession(owner, '[task56 fixture] ' + tag, { cwd: ownerRoot, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    assert.ok(created.ok && created.sessionId, created.error)
    assert.equal((await client.uploadFiles(owner, created.sessionId, [{ filename: 'marker.txt', data: Buffer.from(marker) }])).ok, true)
    const absent = await client.fsList(executor, ownerRoot, true)
    assert.equal(absent.ok, false, 'owner path must be absent on execution machine')
    return { ownerRoot, executionRoot, markerSha, ownerPathAbsentOnExecutor: true }
  })
  app = createApp({ host: '127.0.0.1', port: 0, prefix: '/onenat-workbuddy', dataDir, onenatBaseUrl: settings.baseUrl, onenatApiKey: settings.apiKey, apiToken: 'task56-' + tag, autoRefreshMs: 3600000, xiaozhiMcp: '', adminUsername: 'workbuddy', adminPassword: 'workbuddy-admin', quiet: true })
  await new Promise(r => app.server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${app.server.address().port}/onenat-workbuddy/api`
  await api('/auth/login', { username: 'workbuddy', password: 'workbuddy-admin' })
  const ownerRef = { kind: 'mapping', mappingId: ownerId }, execRef = { kind: 'mapping', mappingId: executionId }
  const p = await api('/projects', { name: tag, dshRef: ownerRef, defaultExecutionNodeRef: execRef, workspace: ownerRoot })
  projectId = p.id
  let mainId, mainSession
  const prompt = '这是 task-56 验收，仅执行只读检查，不修改文件、不派发任务、不调用 WorkBuddy/OneNat 工具。请用命令工具运行 Node.js 获取 process.cwd()；然后使用 [项目工作区跨机访问] 提供的文件归属节点 HTTP 接口下载 marker.txt（无需远程模型会话），计算 SHA256。返回一行 JSON，字段 cwd、marker、sha256。必须真实执行，失败如实报告。'
  await check('real main session on selected execution node reads owner file', async () => {
    const task = await api('/tasks', { projectId, nodeRef: execRef, memberAgentIds: [], model: 'deepseek-official/deepseek-v4-flash', workDir: executionRoot, message: prompt })
    mainId = task.id
    const final = await settle(mainId)
    report.mainTaskStatus = final.status
    const binding = final.sessions.__node__; assert.ok(binding)
    mainSession = binding.remoteSessionId
    executor = await target(executionId)
    const info = await client.getSessionInfo(executor, mainSession)
    assert.equal(info.cwd, executionRoot)
    assert.equal(binding.nodeRefKey, 'mapping:' + executionId)
    const replies = final.turns.filter(t => t.role === 'agent').map(t => t.text).join('\n')
    report.mainReply = redact(replies)
    const tools = final.turns.flatMap(t => t.tools || []).map(t => ({ name: t.name, status: t.status }))
    assert.ok(tools.length, 'model must actually call command tool')
    assert.ok(replies.includes(marker) && replies.includes(markerSha), 'reply must match independently uploaded bytes and SHA256')
    assert.ok(!report.requests.some(r => r.url.startsWith(executor.baseUrl) && r.cwd === ownerRoot))
    return { taskId: mainId, sessionId: mainSession, cwd: info.cwd, tools, markerSha }
  })
  await check('default edit keeps old remote session while new task uses new default', async () => {
    await api('/projects/' + projectId, { defaultExecutionNodeRef: ownerRef }, 'PATCH')
    assert.deepEqual(app.store.getTask(mainId).nodeRef, execRef)
    await api('/tasks/' + mainId + '/messages', { message: '仅运行 Node.js 打印 process.cwd()，不得修改文件或派发任务。' })
    const final = await settle(mainId)
    assert.equal(final.sessions.__node__.remoteSessionId, mainSession)
    assert.deepEqual(final.nodeRef, execRef)
    const next = await api('/tasks', { projectId, memberAgentIds: [] })
    assert.deepEqual(next.nodeRef, ownerRef)
    const fileList = await api('/agents/fs/list?projectId=' + projectId + '&path=' + encodeURIComponent(ownerRoot) + '&all=1')
    assert.ok(fileList.entries.some(e => e.name === 'marker.txt'))
    return { oldTaskId: mainId, oldSessionId: mainSession, oldNode: final.nodeRef, newTaskId: next.id, newNode: next.nodeRef }
  })
  await check('real child session keeps its own node cwd and reads owner file', async () => {
    const worker = await api('/agents', { name: tag + '-worker', dshRef: execRef, workDir: executionRoot, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    const task = await api('/tasks', { projectId, nodeRef: execRef, memberAgentIds: [] })
    // Exercise the actual child dispatch path with a bounded deterministic plan, avoiding a second implementation/planner task.
    app.store.mutateTask(task.id, t => {
      t.memberAgentIds = [worker.id]
      t.plan = { objective: '只读节点验收', strategy: 'parallel', createdAt: Date.now(), subtasks: [{ id: 'verify-child', title: '只读节点验收', prompt, agentId: worker.id, dependsOn: [], status: 'pending', logs: [] }] }
    })
    const retry = api('/tasks/' + task.id + '/subtasks/verify-child/retry', {}, 'POST', 300000)
    // Observe the asynchronous remote run while the retry route finishes its summary.
    retry.catch(() => {})
    const deadline = Date.now() + 240000
    let final
    while (Date.now() < deadline) {
      final = app.store.getTask(task.id)
      const status = final.plan.subtasks[0].status
      if (status === 'completed' || status === 'failed') break
      await new Promise(r => setTimeout(r, 2000))
    }
    await retry
    const sub = final.plan.subtasks[0]
    report.childResult = redact(sub.result?.content || sub.error || '')
    assert.equal(sub.status, 'completed', sub.error)
    const binding = final.sessions[worker.id]; assert.ok(binding)
    executor = await target(executionId)
    const info = await client.getSessionInfo(executor, binding.remoteSessionId)
    assert.equal(info.cwd, executionRoot); assert.equal(binding.nodeRefKey, 'mapping:' + executionId)
    assert.ok(sub.result.content.includes(marker) && sub.result.content.includes(markerSha))
    return { taskId: task.id, sessionId: binding.remoteSessionId, cwd: info.cwd, markerSha }
  })
  executor = await target(executionId)
  assert.equal((await client.fsList(executor, ownerRoot, true)).ok, false)
  report.ownerPathAbsentOnExecutorAfter = true
} catch (error) {
  report.error = redact(error.message); process.exitCode = 1; console.error('LIVE FAIL: ' + report.error)
} finally {
  // Only test-created sessions/directories are eligible for cleanup; no global settings change.
  if (app) {
    for (const t of app.store.getTasks()) if (t.status === 'running') await api('/tasks/' + t.id + '/cancel', {}).catch(() => {})
    app.store.flush(); await app.close()
  }
  for (const id of [ownerId, executionId]) {
    try {
      const t = await target(id)
      const own = id === ownerId, root = own ? ownerRoot : executionRoot
      const expected = '/tmp/' + tag + (own ? '-owner' : '-executor')
      assert.equal(root, expected); assert.ok(/^\/tmp\/wb-task56-[a-f0-9]{16}-(owner|executor)$/.test(root))
      for (const s of sessions.filter(s => s.base === t.baseUrl)) {
        try { await request(t, '/sessions/' + s.id, undefined, 'DELETE'); report.cleanup.push({ sessionId: s.id, deleted: true }) }
        catch (e) { report.cleanup.push({ sessionId: s.id, deleted: false, error: redact(e.message) }) }
      }
      const removed = await client.fsRemove(t, root)
      report.cleanup.push({ node: id, testDirectory: root, removed: removed.ok, ...(removed.error ? { error: redact(removed.error) } : {}) })
      const current = await request(t, '/workspaces')
      for (const w of Array.isArray(current) ? current : current.workspaces || []) {
        if ([ownerRoot, executionRoot].includes(w.path) && !workspacesBefore.get(id)?.has(w.id)) {
          await request(t, '/workspaces/' + w.id, undefined, 'DELETE')
          report.cleanup.push({ workspaceId: w.id, removed: true })
        }
      }
    } catch (error) { report.cleanup.push({ node: id, error: redact(error.message) }) }
  }
  globalThis.fetch = nativeFetch
  directory.stopAutoRefresh()
  await save()
  await new Promise(r => setTimeout(r, 100))
  const targetPath = resolve(dataDir); assert.ok(targetPath.startsWith(join(tmpdir(), 'wb-task56-live-')))
  await rm(targetPath, { recursive: true, force: true })
  console.log(`Live acceptance: ${report.checks.filter(c => c.result === 'PASS').length}/${report.checks.length} checks passed; report ${reportPath}`)
}
