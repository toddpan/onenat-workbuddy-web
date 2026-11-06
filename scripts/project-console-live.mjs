#!/usr/bin/env node
/** Opt-in task-58 live console fixture. Only random temporary remote files and isolated local data. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createApp } from '../dist/server.js'
import { OnenatDirectory } from '../dist/onenat.js'
import { DshClient } from '../dist/remote-client.js'
assert.equal(process.env.WORKBUDDY_LIVE_ACCEPTANCE, '1', 'Opt in with WORKBUDDY_LIVE_ACCEPTANCE=1')
const output = resolve('artifacts/task58/live')
await mkdir(output, { recursive: true })
const settings = JSON.parse(await readFile(join(homedir(), '.dsh/dsh-onenat/store.json'), 'utf8')).settings.onenat
const directory = new OnenatDirectory(settings.baseUrl, settings.apiKey)
const client = new DshClient()
const ownerId = process.env.WORKBUDDY_FILE_NODE || '6cc2987d'
const execId = process.env.WORKBUDDY_EXECUTION_NODE || '5602f2c2'
const refs = { owner: { kind: 'mapping', mappingId: ownerId }, executor: { kind: 'mapping', mappingId: execId } }
const tag = 'wb-task58-' + randomBytes(8).toString('hex')
const ownerRoot = '/tmp/' + tag + '-owner', executionRoot = '/tmp/' + tag + '-execution'
const dataDir = await mkdtemp(join(tmpdir(), 'wb-task58-live-'))
const marker = 'Task58 owner only ' + randomBytes(18).toString('hex')
const report = { at: new Date().toISOString(), tag, refs, ownerRoot, executionRoot, markerSha256: createHash('sha256').update(marker).digest('hex'), checks: [], cleanup: [] }
const save = () => writeFile(join(output, 'fixture-report.json'), JSON.stringify(report, null, 2))
let app, control, stopping = false
const before = new Map()
const json = (res, body, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
async function target(id) {
  await directory.refresh(true)
  const endpoint = directory.resolveMapping(id)
  assert.ok(endpoint?.online && endpoint.baseUrl, 'Node unavailable: ' + id)
  const cred = await directory.fetchMappingCredentials(id)
  assert.ok(cred.ok && (cred.apiKey || cred.token), 'Credentials unavailable: ' + id)
  return { baseUrl: endpoint.baseUrl, apiKey: cred.apiKey || cred.token }
}
async function request(id, path, body, method = body === undefined ? 'GET' : 'POST') {
  const t = await target(id)
  const response = await fetch(t.baseUrl + path, { method, headers: { Authorization: 'Bearer ' + t.apiKey, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20000) })
  const j = await response.json()
  assert.ok(response.ok && j.ok, method + ' ' + path + ': ' + response.status)
  return j.data
}
async function cleanup() {
  if (stopping) return; stopping = true
  const tasks = app?.store.getTasks() || []
  for (const task of tasks) for (const binding of Object.values(task.sessions || {})) {
    const id = task.nodeRef?.mappingId
    if (!id || !binding.remoteSessionId) continue
    try { await request(id, '/sessions/' + binding.remoteSessionId, undefined, 'DELETE'); report.cleanup.push({ sessionId: binding.remoteSessionId, removed: true }) }
    catch (e) { report.cleanup.push({ sessionId: binding.remoteSessionId, error: e.message }) }
  }
  if (app) await app.close()
  for (const [id, root] of [[ownerId, ownerRoot], [execId, executionRoot]]) {
    assert.ok(root.startsWith('/tmp/' + tag + '-') && /^wb-task58-[a-f0-9]{16}$/.test(tag))
    try {
      const result = await client.fsRemove(await target(id), root)
      report.cleanup.push({ node: id, path: root, removed: result.ok, ...(result.ok ? {} : { error: result.error }) })
      for (const workspace of await request(id, '/workspaces')) {
        if ([ownerRoot, executionRoot].includes(workspace.path) && !before.get(id)?.has(workspace.id)) {
          await request(id, '/workspaces/' + workspace.id, undefined, 'DELETE')
          report.cleanup.push({ workspaceId: workspace.id, removed: true })
        }
      }
    } catch (e) { report.cleanup.push({ node: id, error: e.message }) }
  }
  if (control) await new Promise(r => { control.close(r); control.closeAllConnections() })
  directory.stopAutoRefresh()
  const absolute = resolve(dataDir); assert.ok(absolute.startsWith(join(tmpdir(), 'wb-task58-live-')))
  await rm(absolute, { recursive: true, force: true })
  report.cleanup.push({ localDataRemoved: true })
  await save()
  console.log('Live console fixture cleaned; report ' + join(output, 'fixture-report.json'))
}
try {
  for (const id of [ownerId, execId]) {
    const t = await target(id)
    assert.equal((await client.ping(t, { timeoutMs: 10000 })).ok, true)
    const models = await request(id, '/models')
    assert.ok((Array.isArray(models) ? models : models.models).some(m => m.provider === 'deepseek-official' && m.id === 'deepseek-v4-flash'))
    before.set(id, new Set((await request(id, '/workspaces')).map(w => w.id)))
  }
  report.checks.push({ name: 'live directory/auth/models on owner and execution', result: 'PASS' })
  const owner = await target(ownerId), exec = await target(execId)
  assert.equal((await client.fsMkdir(owner, '/tmp', tag + '-owner')).ok, true)
  assert.equal((await client.fsMkdir(exec, '/tmp', tag + '-execution')).ok, true)
  assert.equal((await client.fsMkdir(owner, ownerRoot, 'backlog')).ok, true)
  assert.equal((await client.fsMkdir(owner, ownerRoot + '/backlog', 'tasks')).ok, true)
  for (const [dir, name, text] of [[ownerRoot, 'README.md', marker], [ownerRoot + '/backlog', 'config.yml', 'project_name: Task58 live\nstatuses: [To Do, In Progress, Done]\ndefault_status: To Do\ntask_prefix: task\n'], [ownerRoot + '/backlog/tasks', 'task-1 - Live owner.md', '---\nid: task-1\ntitle: Task58 live owner-only backlog\nstatus: To Do\n---\n\n## Description\nOnly an isolated acceptance fixture.\n\n## Acceptance Criteria\n<!-- AC:BEGIN -->\n- [ ] #1 Owner access\n<!-- AC:END -->\n']]) {
    assert.equal((await client.fsUpload(await target(ownerId), dir, [{ filename: name, data: Buffer.from(text) }])).ok, true)
  }
  const absent = await client.fsList(await target(execId), ownerRoot, true)
  assert.equal(absent.ok, false, 'owner root must not exist on executor')
  app = createApp({ host: '127.0.0.1', port: 0, prefix: '/onenat-workbuddy', dataDir, onenatBaseUrl: settings.baseUrl, onenatApiKey: settings.apiKey, apiToken: 'task58-isolated-' + tag, autoRefreshMs: 3600000, xiaozhiMcp: '', adminUsername: 'workbuddy', adminPassword: 'workbuddy-admin', quiet: true })
  await new Promise(r => app.server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${app.server.address().port}/onenat-workbuddy`
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'workbuddy', password: 'workbuddy-admin' }) })
  const cookie = login.headers.get('set-cookie').split(';')[0]
  const created = await fetch(base + '/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name: 'Task58 real console', dshRef: refs.owner, defaultExecutionNodeRef: refs.executor, workspace: ownerRoot, expertIds: [] }) })
  const project = (await created.json()).data; assert.ok(project?.id)
  control = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture')
      if (url.pathname === '/isolate-draft' && req.method === 'POST') {
        let raw = ''; for await (const c of req) raw += c
        const { taskId } = JSON.parse(raw), task = app.store.getTask(taskId)
        assert.ok(task && task.status === 'draft' && task.projectId === project.id && task.nodeRef?.mappingId === execId)
        app.store.upsertTask({ ...task, workDir: executionRoot })
        return json(res, { ok: true, workDir: executionRoot })
      }
      if (url.pathname === '/evidence') {
        const result = []
        for (const task of app.store.getTasks()) {
          const binding = task.sessions?.__node__
          result.push({ id: task.id, status: task.status, projectId: task.projectId, nodeRef: task.nodeRef, workDir: task.workDir, remoteSessionId: binding?.remoteSessionId, ...(binding && { remote: await client.getSessionInfo(await target(execId), binding.remoteSessionId) }), replies: task.turns?.filter(t => t.role === 'agent').map(t => t.text) })
        }
        return json(res, { tasks: result, markerSha256: report.markerSha256 })
      }
      if (url.pathname === '/stop' && req.method === 'POST') { json(res, { ok: true }); setImmediate(() => cleanup().then(() => process.exit(report.cleanup.some(c => c.error || c.removed === false) ? 1 : 0))); return }
      return json(res, { ok: false }, 404)
    } catch (e) { return json(res, { ok: false, error: e.message }, 500) }
  })
  await new Promise(r => control.listen(0, '127.0.0.1', r))
  const info = { base, controlBase: `http://127.0.0.1:${control.address().port}`, projectId: project.id, root: ownerRoot, executionRoot, refs }
  await writeFile(join(output, 'fixture.json'), JSON.stringify(info, null, 2))
  await save(); console.log(JSON.stringify(info))
  process.on('SIGTERM', () => cleanup().then(() => process.exit(0)))
  process.on('SIGINT', () => cleanup().then(() => process.exit(0)))
} catch (e) { report.error = e.message; await cleanup(); throw e }
