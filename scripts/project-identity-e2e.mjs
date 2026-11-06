#!/usr/bin/env node
/** task-55: real HTTP/MCP routes with isolated persisted data, mock DSH/ONENAT, no model dispatch. */
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createApp } from '../dist/server.js'

const prefix = '/onenat-workbuddy'
const token = 'task55-isolated-service-token'
const dataDir = await mkdtemp(join(tmpdir(), 'wb-project-identity-'))
const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
const prompts = []
let sessionSeq = 0
const node = createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part
  let body; try { body = JSON.parse(raw) } catch {}
  const url = new URL(req.url, 'http://stub')
  if (url.pathname === '/api/v1/resources') return json(res, { tunnels: [] })
  if (url.pathname.endsWith('/system/status')) return json(res, { ok: true, data: { version: 'test', name: 'identity-node' } })
  if (url.pathname.endsWith('/workspaces') || url.pathname.endsWith('/models')) return json(res, { ok: true, data: [] })
  if (url.pathname.endsWith('/sessions') && req.method === 'POST') return json(res, { ok: true, data: { sessionId: `session-${++sessionSeq}` } })
  if (url.pathname.endsWith('/prompt-stream')) {
    prompts.push(body.prompt)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    return res.end('event: delta\ndata: {"delta":"analysis mocked; callback tested separately"}\n\nevent: turn_end\ndata: {"reason":"stop"}\n\nevent: done\ndata: [DONE]\n\n')
  }
  if (url.pathname.endsWith('/history')) return json(res, { ok: true, data: { messages: [] } })
  if (/\/sessions\/[^/]+$/.test(url.pathname)) return json(res, { ok: true, data: { status: 'idle', cwd: '/tmp' } })
  return json(res, { ok: false, error: 'unsupported mock endpoint' }, 404)
})
await new Promise(r => node.listen(0, '127.0.0.1', r))
const nodeBase = `http://127.0.0.1:${node.address().port}`
const ref = { kind: 'direct', apiBaseUrl: nodeBase + '/api/v1' }
const legacyProject = (id, workspace, extra = {}) => ({ id, name: id, dshRef: ref, workspace, expertIds: [], connectorIds: [], skillNames: [], createdAt: 1, updatedAt: 1, ...extra })
const legacy = [
  legacyProject('proj-legacy-visible', '/legacy/shared/'),
  legacyProject('proj-legacy-hidden', '/legacy/./shared', { owner: 'usr-legacy-secret', projectMembers: [{ userId: 'usr-legacy-secret', role: 'owner', joinedAt: 2 }], createdAt: 2, apiKey: 'legacy-key' }),
  legacyProject('proj-members-only', '/legacy/members/', { projectMembers: [{ userId: 'usr-old-owner', role: 'owner', joinedAt: 1 }, { userId: 'usr-old-member', role: 'member', joinedAt: 2 }], visibility: 'private' }),
  legacyProject('proj-unowned', '/legacy/unowned/'),
]
await writeFile(join(dataDir, 'store.json'), JSON.stringify({ projects: legacy, tasks: [{ id: 'task-legacy', title: 'old', status: 'draft', mode: 'chat', projectId: 'proj-legacy-hidden', memberAgentIds: [], turns: [], sessions: {}, createdAt: 1, updatedAt: Date.now() }], settings: {} }))
process.env.WORKBUDDY_ALLOW_PRIVATE_DIRECT = '1'
const config = { host: '127.0.0.1', port: 0, prefix, dataDir, onenatBaseUrl: nodeBase, onenatApiKey: 'mock', autoRefreshMs: 3600000, apiToken: token, xiaozhiMcp: '', adminUsername: 'workbuddy', adminPassword: 'workbuddy-admin', quiet: true }
let app, base
let checks = 0
async function check(name, fn) { await fn(); checks++; console.log(`PASS ${name}`) }
async function boot() {
  app = createApp(config)
  await new Promise(r => app.server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${app.server.address().port}${prefix}`
}
async function api(path, body, cookie = '', method = body === undefined ? 'GET' : 'POST') {
  const res = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) })
  return { status: res.status, body: await res.json(), cookie: (res.headers.get('set-cookie') || '').split(';')[0] }
}
let rpcSeq = 0
async function mcp(args, cookie = '', { rpcId = ++rpcSeq, sessionId = 'task55-shared-session', service = false } = {}) {
  // Omit unknown session header: MCP supports stateless calls; initialize returns a real session when needed.
  const headers = { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(service ? { Authorization: `Bearer ${token}` } : {}) }
  if (sessionId !== 'task55-shared-session') headers['Mcp-Session-Id'] = sessionId
  const response = await fetch(base + '/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name: 'workbuddy_project_manage', arguments: args } }), signal: AbortSignal.timeout(15000) })
  assert.equal(response.status, 200)
  const rpc = await response.json()
  assert.ok(rpc.result, JSON.stringify(rpc))
  return { body: JSON.parse(rpc.result.content[0].text), isError: rpc.result.isError }
}
function assertConflict(out, privateProject) {
  assert.equal(out.ok, false)
  assert.equal(out.code, 'PROJECT_WORKSPACE_CONFLICT')
  assert.deepEqual(Object.keys(out).sort().filter(k => k !== 'status'), ['code', 'error', 'ok'])
  if (privateProject) for (const value of [privateProject.id, privateProject.name, privateProject.owner, privateProject.apiKey, privateProject.instruction].filter(Boolean)) assert.ok(!JSON.stringify(out).includes(value), `conflict leaks ${value}`)
}
async function user(email, admin) {
  const invite = await api('/users', { email, displayName: email }, admin)
  assert.equal(invite.status, 201, JSON.stringify(invite.body))
  const inviteToken = new URL(invite.body.data.inviteLink).searchParams.get('token')
  const accepted = await api('/invitations/' + inviteToken, { password: 'Password123', displayName: email })
  assert.equal(accepted.status, 200)
  return { cookie: accepted.cookie, id: app.auth.getUserByUsername(email).id }
}
async function importStart(path, cookie) {
  const count = prompts.length
  const result = await api('/projects/import', { nodeRef: ref, workspacePath: path, name: 'analysis' }, cookie)
  assert.equal(result.status, 200)
  assert.equal(result.body.ok, true, JSON.stringify(result.body))
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const prompt = prompts.slice(count).find(p => p.includes(path))
    if (prompt) {
      const url = prompt.match(/http:\/\/127\.0\.0\.1:\d+\/onenat-workbuddy\/api\/projects\/import-create\?token=[a-zA-Z0-9-]+/)
      assert.ok(url, 'import task must include callback')
      return url[0]
    }
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error('import prompt missing')
}
async function callback(url, path, name = 'import-result', cookie = '') {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify({ node: ref.apiBaseUrl, workspace: path, name, instruction: 'must-not-overwrite-existing', defaultAgentIds: [], connectorIds: [], skillNames: [] }), signal: AbortSignal.timeout(15000) })
  return { status: res.status, body: await res.json() }
}
async function stop() {
  if (!app) return
  app.store.flush()
  await app.close()
  // Wait for WorkStore's in-flight temp writes before removing the isolated directory.
  await new Promise(r => setTimeout(r, 100))
  app = undefined
}
try {
  await boot()
  let admin = (await api('/auth/login', { username: 'workbuddy', password: 'workbuddy-admin' })).cookie
  assert.ok(admin)
  const alice = await user('task55-alice@example.com', admin)
  const bob = await user('task55-bob@example.com', admin)
  let privateProject
  await check('REST create canonicalizes root; same node conflicts, other nodes stay distinct', async () => {
    const created = await api('/projects', { name: 'task55-private', dshRef: ref, workspace: '/repo/./private/', apiKey: 'task55-secret', instruction: 'private instructions' }, alice.cookie)
    assert.equal(created.status, 200)
    privateProject = { ...created.body.data, apiKey: 'task55-secret' }
    assert.equal(privateProject.workspace, '/repo/private')
    assert.equal(privateProject.owner, alice.id)
    const out = await api('/projects', { name: 'duplicate', dshRef: ref, workspace: '/repo/private/sub/../' }, bob.cookie)
    assert.equal(out.status, 409); assertConflict(out.body, privateProject)
    const other = await api('/projects', { name: 'other node', dshRef: { kind: 'mapping', mappingId: 'other-node' }, workspace: '/repo/private' }, bob.cookie)
    assert.equal(other.status, 200)
    const moved = await api('/projects/' + other.body.data.id, { name: 'bad move', dshRef: ref }, bob.cookie, 'PATCH')
    assert.equal(moved.status, 409); assertConflict(moved.body, privateProject)
    assert.deepEqual(app.store.getProject(other.body.data.id).dshRef, { kind: 'mapping', mappingId: 'other-node' })
    assert.equal((await api('/projects/' + privateProject.id, undefined, bob.cookie)).status, 404)
  })
  await check('REST POST/PATCH/PUT and MCP reject rebind atomically; archive keeps identity reserved', async () => {
    const other = (await api('/projects', { name: 'other root', dshRef: ref, workspace: '/other' }, bob.cookie)).body.data
    const before = structuredClone(app.store.getProject(other.id))
    for (const method of ['POST', 'PATCH', 'PUT']) {
      const out = await api(method === 'POST' ? '/projects' : '/projects/' + other.id, { id: other.id, name: 'overwrite', workspace: '/repo/private/' }, bob.cookie, method)
      assert.equal(out.status, 409); assertConflict(out.body, privateProject)
      assert.deepEqual(app.store.getProject(other.id), before)
    }
    const m = await mcp({ action: 'upsert', project: { id: other.id, name: 'overwrite', workspace: '/repo/private/./' } }, bob.cookie)
    assert.equal(m.isError, true); assertConflict(m.body, privateProject)
    assert.deepEqual(app.store.getProject(other.id), before)
    await api('/projects/' + privateProject.id + '/archive', {}, alice.cookie)
    const conflict = await api('/projects', { name: 'dup archived', dshRef: ref, workspace: '/repo/private' }, bob.cookie)
    assert.equal(conflict.status, 409)
    await api('/projects/' + privateProject.id + '/restore', {}, alice.cookie)
  })
  await check('MCP/HTTP tool user identity, hidden IDs, member permissions and service conflicts', async () => {
    const list = await mcp({ action: 'list' }, bob.cookie)
    assert.ok(!list.body.projects.some(p => p.id === privateProject.id))
    for (const action of ['get', 'upsert', 'delete']) {
      const out = await mcp({ action, projectId: privateProject.id, project: { id: privateProject.id, name: 'attack' } }, bob.cookie)
      assert.deepEqual(out.body, { ok: false, error: '项目不存在', status: 404 })
    }
    const http = await api('/tools/workbuddy_project_manage', { action: 'get', projectId: privateProject.id }, bob.cookie)
    assert.equal(http.body.result.status, 404)
    const service = await mcp({ action: 'upsert', project: { name: 'duplicate', dshRef: ref, workspace: '/repo/private/' } }, '', { service: true })
    assertConflict(service.body, privateProject)
    const createArgs = { action: 'upsert', project: { name: 'MCP owned', dshRef: ref, workspace: '/mcp-owned' } }
    const created = await mcp(createArgs, bob.cookie, { rpcId: 'create-once' })
    assert.equal(created.body.project.owner, bob.id)
    const replay = await mcp(createArgs, bob.cookie, { rpcId: 'create-once' })
    assert.deepEqual(replay.body, created.body, 'authorized write retries must remain idempotent')
    const crossUser = await mcp(createArgs, alice.cookie, { rpcId: 'create-once' })
    assertConflict(crossUser.body, created.body.project)
    const createdId = created.body.project.id
    assert.equal((await api('/projects/' + createdId + '/members', { userId: alice.id }, bob.cookie)).status, 200)
    assert.equal((await api('/projects/' + createdId + '/ownership-transfer', { targetMemberId: alice.id }, bob.cookie)).status, 200)
    await api('/projects/' + createdId + '/members/' + bob.id, undefined, alice.cookie, 'DELETE')
    const lostWrite = await mcp(createArgs, bob.cookie, { rpcId: 'create-once' })
    assertConflict(lostWrite.body, created.body.project)
    await api('/projects/' + privateProject.id + '/members', { userId: bob.id }, alice.cookie)
    const visible = await mcp({ action: 'get', projectId: privateProject.id }, bob.cookie, { rpcId: 'same-get' })
    assert.equal(visible.body.ok, true); assert.equal(visible.body.project.apiKey, undefined)
    const denied = await mcp({ action: 'upsert', project: { id: privateProject.id, name: 'member overwrite' } }, bob.cookie)
    assert.equal(denied.body.status, 403)
    await api('/projects/' + privateProject.id + '/members/' + bob.id, undefined, alice.cookie, 'DELETE')
    const revoked = await mcp({ action: 'get', projectId: privateProject.id }, bob.cookie, { rpcId: 'same-get' })
    assert.equal(revoked.body.status, 404, 'same RPC ID must recheck membership instead of replaying private content')
  })
  await check('import preflight reuses visible project only, normalized roots and hidden conflicts', async () => {
    const before = structuredClone(app.store.getProject(privateProject.id))
    const out = await api('/projects/import', { nodeRef: ref, workspacePath: '/repo/private/./' }, alice.cookie)
    assert.equal(out.body.data.reused, true)
    assert.equal(out.body.data.projectId, privateProject.id)
    const denied = await api('/projects/import', { nodeRef: ref, workspacePath: '/repo/private' }, bob.cookie)
    assert.equal(denied.status, 409); assertConflict(denied.body, privateProject)
    const legacyReuse = await api('/projects/import', { nodeRef: ref, workspacePath: '/legacy/shared' }, bob.cookie)
    assert.equal(legacyReuse.body.data.projectId, 'proj-legacy-visible', 'hidden duplicate must not shadow accessible legacy project')
    assert.deepEqual(app.store.getProject(privateProject.id), before)
    for (const workspacePath of ['relative/repo', 'C:repo']) assert.equal((await api('/projects/import', { nodeRef: ref, workspacePath }, bob.cookie)).status, 400)
    assert.equal((await api('/projects/import', { nodeRef: { kind: 'mapping', mappingId: ' ' }, workspacePath: '/x' }, bob.cookie)).status, 400)
  })
  await check('import callback concurrent with normal create is idempotent and never overwrites ACL/config', async () => {
    const url = await importStart('/race-visible', alice.cookie)
    const created = await api('/projects', { name: 'normal winner', dshRef: ref, workspace: '/race-visible', instruction: 'original' }, alice.cookie)
    const before = structuredClone(app.store.getProject(created.body.data.id))
    const out = await callback(url, '/race-visible/./')
    assert.equal(out.status, 200); assert.equal(out.body.data.projectId, before.id)
    assert.deepEqual(app.store.getProject(before.id), before)
    assert.equal((await callback(url, '/race-visible')).status, 403, 'callback token consumed once')
    const freshUrl = await importStart('/fresh-import', bob.cookie)
    const fresh = await callback(freshUrl, '/fresh-import')
    assert.equal(fresh.status, 200)
    assert.equal(app.store.getProject(fresh.body.data.projectId).owner, bob.id)
    assert.equal(app.store.getProjectsForWorkspace(ref, '/fresh-import').length, 1)
  })
  await check('import callback rejects hidden race even with admin cookie; admin initiator retains admin permissions', async () => {
    const url = await importStart('/race-private', bob.cookie)
    const created = await api('/projects', { name: 'private race winner', dshRef: ref, workspace: '/race-private' }, alice.cookie)
    const before = structuredClone(app.store.getProject(created.body.data.id))
    const denied = await callback(url, '/race-private', 'attack', admin)
    assert.equal(denied.status, 409); assertConflict(denied.body, before)
    assert.deepEqual(app.store.getProject(before.id), before)
    const adminUrl = await importStart('/race-admin', admin)
    const winner = await api('/projects', { name: 'alice winner', dshRef: ref, workspace: '/race-admin' }, alice.cookie)
    const out = await callback(adminUrl, '/race-admin')
    assert.equal(out.status, 200); assert.equal(out.body.data.projectId, winner.body.data.id)
  })
  await check('callback rechecks disabled initiator and revoked membership', async () => {
    const url = await importStart('/race-revoked', bob.cookie)
    const winner = await api('/projects', { name: 'private winner', dshRef: ref, workspace: '/race-revoked' }, alice.cookie)
    await api('/projects/' + winner.body.data.id + '/members', { userId: bob.id }, alice.cookie)
    await api('/projects/' + winner.body.data.id + '/members/' + bob.id, undefined, alice.cookie, 'DELETE')
    assert.equal((await callback(url, '/race-revoked')).status, 409)
    const disabledUrl = await importStart('/disabled-import', bob.cookie)
    const u = app.auth.getUserById(bob.id)
    u.status = 'disabled'
    assert.equal((await callback(disabledUrl, '/disabled-import')).status, 403)
    assert.equal(app.store.getProjectsForWorkspace(ref, '/disabled-import').length, 0)
    u.status = 'active'
  })
  await check('legacy POST edits preserve ownerless members and unowned ACLs; duplicates remain separate', async () => {
    for (const id of ['proj-members-only', 'proj-unowned']) {
      const before = structuredClone(app.store.getProject(id))
      const out = await api('/projects', { id, name: 'legacy renamed' }, admin)
      assert.equal(out.status, 200)
      assert.equal(app.store.getProject(id).owner, before.owner)
      assert.deepEqual(app.store.getProject(id).projectMembers, before.projectMembers)
      assert.equal(app.store.getProject(id).workspace, before.workspace)
    }
    assert.equal((await api('/projects', { id: 'proj-unowned', name: 'claim' }, bob.cookie)).status, 403)
    assert.equal(app.store.getProjectsForWorkspace(ref, '/legacy/shared').length, 2)
    const out = await api('/projects', { name: 'third', dshRef: ref, workspace: '/legacy/shared' }, admin)
    assert.equal(out.status, 409)
  })
  await check('interleaved request bodies cannot borrow admin identity; concurrent creates have one winner', async () => {
    // Start a slow user body, let an admin request run, then finish the body: reproduces the old shared session field bug.
    const target = new URL(base + '/api/projects')
    const payload = JSON.stringify({ id: 'proj-unowned', name: 'borrowed-admin' })
    const pending = httpRequest(target, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Cookie: bob.cookie } })
    const finished = new Promise((resolveResult, reject) => {
      pending.on('response', async res => { let text = ''; for await (const c of res) text += c; resolveResult({ status: res.statusCode, text }) })
      pending.on('error', reject)
    })
    pending.write(payload.slice(0, 1))
    await new Promise(r => setTimeout(r, 30))
    await api('/projects', undefined, admin)
    pending.end(payload.slice(1))
    assert.equal((await finished).status, 403)
    assert.notEqual(app.store.getProject('proj-unowned').name, 'borrowed-admin')
    // A logout while an HTTP tool body arrives must not reinterpret the original user as a service caller.
    const tempCookie = (await api('/auth/login', { username: 'task55-bob@example.com', password: 'Password123' })).cookie
    const toolPayload = JSON.stringify({ action: 'upsert', project: { id: privateProject.id, name: 'logout-service-bypass' } })
    const toolReq = httpRequest(new URL(base + '/api/tools/workbuddy_project_manage'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(toolPayload), Cookie: tempCookie } })
    const toolFinished = new Promise((resolveResult, reject) => {
      toolReq.on('response', async res => { let text = ''; for await (const c of res) text += c; resolveResult({ status: res.statusCode, body: JSON.parse(text) }) })
      toolReq.on('error', reject)
    })
    toolReq.write(toolPayload.slice(0, 1))
    await new Promise(r => setTimeout(r, 30))
    await api('/auth/logout', {}, tempCookie)
    toolReq.end(toolPayload.slice(1))
    assert.equal((await toolFinished).body.result.status, 404)
    assert.equal(app.store.getProject(privateProject.id).name, privateProject.name)
    const results = await Promise.all([alice.cookie, bob.cookie].map(cookie => api('/projects', { name: 'racer', dshRef: ref, workspace: '/concurrent' }, cookie)))
    assert.deepEqual(results.map(x => x.status).sort(), [200, 409])
    assert.equal(app.store.getProjectsForWorkspace(ref, '/concurrent').length, 1)
  })
  await check('restart preserves duplicate legacy projects, ACLs, credentials and existing task project IDs', async () => {
    const before = JSON.parse(JSON.stringify(app.store.getProjects()))
    await stop()
    const disk = JSON.parse(await readFile(join(dataDir, 'store.json'), 'utf8'))
    assert.equal(disk.projects.filter(p => ['proj-legacy-visible', 'proj-legacy-hidden'].includes(p.id)).length, 2)
    await boot()
    assert.deepEqual(app.store.getProjects(), before)
    assert.equal(app.store.getTask('task-legacy').projectId, 'proj-legacy-hidden')
    assert.equal(app.store.getProject('proj-legacy-hidden').apiKey, 'legacy-key')
    admin = (await api('/auth/login', { username: 'workbuddy', password: 'workbuddy-admin' })).cookie
    const out = await api('/projects', { name: 'after restart', dshRef: ref, workspace: '/repo/private/./' }, admin)
    assert.equal(out.status, 409)
  })
  console.log(`PASS task-55 project identity e2e: ${checks}/${checks} scenarios`)
} finally {
  await stop()
  await new Promise(r => node.close(r))
  const resolved = resolve(dataDir)
  assert.ok(resolved.startsWith(join(tmpdir(), 'wb-project-identity-')))
  await rm(resolved, { recursive: true, force: true })
}
