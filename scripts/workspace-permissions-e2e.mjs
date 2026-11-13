#!/usr/bin/env node
/** task-59: REST/HTTP-tool/MCP authorization with isolated files and an executing mock DSH. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, realpath, mkdir, writeFile, readFile, readdir, lstat, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createApp } from '../dist/server.js'

const prefix = '/onenat-workbuddy', token = 'task59-isolated-service-token'
const data = await realpath(await mkdtemp(join(tmpdir(), 'wb-workspace-perm-')))
const root = join(data, 'workspace'), sibling = join(data, 'private'), observations = [], sessions = new Map()
await mkdir(root); await mkdir(sibling)
await writeFile(join(root, 'input.txt'), 'original'); await writeFile(join(sibling, 'secret.txt'), 'secret')
await symlink(sibling, join(root, 'escape'))
const sha = s => createHash('sha256').update(s).digest('hex')
const json = (res, body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)) }
const run = file => new Promise((done, reject) => {
  const proc = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''; proc.stderr.on('data', d => { stderr += d }); proc.stdout.resume()
  proc.on('error', reject); proc.on('close', code => code === 0 ? done() : reject(new Error(stderr)))
})
let app, base, nodeBase, checks = 0, modelRuns = 0, sessionSeq = 0, invalidMetadata = false
const node = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://mock'), route = url.pathname, method = req.method
  const chunks = []; for await (const part of req) chunks.push(part)
  const raw = Buffer.concat(chunks), isForm = String(req.headers['content-type'] || '').startsWith('multipart/')
  let body; if (raw.length && !isForm) { try { body = JSON.parse(raw) } catch {} }
  try {
    if (route === '/api/v1/resources') return json(res, { tunnels: [{ id: 'fixture', name: 'fixture', online: true, mappings: [{ id: 'owner-node', public_url: nodeBase, proto: 'http', local: '127.0.0.1:3080', app: { id: 'owner-app', type: 'http-api', name: 'DSH', skills: [{ name: 'dsh-web-service' }] } }] }] })
    if (route.endsWith('/system/status')) return json(res, { ok: true, data: { name: 'permission-node', version: 'test' } })
    if (route.endsWith('/workspaces') || route.endsWith('/models')) return json(res, { ok: true, data: [] })
    observations.push({ route, method })
    if (route.endsWith('/fs/list')) {
      const path = url.searchParams.get('path') || root, entries = []
      for (const name of await readdir(path)) {
        const p = join(path, name)
        try { const s = await lstat(p); entries.push({ name, path: p, type: s.isSymbolicLink() ? 'link' : s.isDirectory() ? 'dir' : 'file', hidden: name.startsWith('.'), size: s.size }) }
        catch (err) { if (err.code !== 'ENOENT') throw err } // other isolated tests may finish under the same OS temp ancestor
      }
      if (invalidMetadata && path === root) entries.push({ name: 'inconsistent', path: join(sibling, 'inconsistent'), type: 'file' })
      return json(res, { ok: true, data: { path, home: '/', parent: dirname(path), entries, truncated: false } })
    }
    if (route.endsWith('/fs/download')) { res.writeHead(200); return res.end(await readFile(url.searchParams.get('path'))) }
    if (route.endsWith('/fs/mkdir')) { await mkdir(join(body.path, body.name)); return json(res, { ok: true, data: { path: join(body.path, body.name), name: body.name } }) }
    if (route.endsWith('/fs/remove')) { await rm(url.searchParams.get('path'), { recursive: true }); return json(res, { ok: true, data: {} }) }
    if (route === '/api/v1/sessions' && method === 'POST') { const sessionId = 'session-' + ++sessionSeq; sessions.set(sessionId, body.cwd || root); return json(res, { ok: true, data: { sessionId } }) }
    const match = /^\/api\/v1\/sessions\/([^/]+)(\/files|\/prompt)?$/.exec(route)
    if (match && sessions.has(match[1])) {
      if (method === 'DELETE') { sessions.delete(match[1]); return json(res, { ok: true, data: {} }) }
      if (match[2] === '/files') {
        const form = await new Response(raw, { headers: { 'Content-Type': req.headers['content-type'] } }).formData()
        const files = []
        for (const file of form.getAll('files')) { const p = join(sessions.get(match[1]), basename(file.name)); await writeFile(p, Buffer.from(await file.arrayBuffer())); files.push({ name: file.name, path: p, size: file.size }) }
        return json(res, { ok: true, data: { files } })
      }
      if (match[2] === '/prompt') {
        const file = body.prompt.match(/uploaded a temporary Node\.js worker to (".*?") for exactly/)
        assert.ok(file); modelRuns++; await run(JSON.parse(file[1]))
        return json(res, { ok: true, data: { content: 'WORKSPACE_REMOTE_READY' } })
      }
      return json(res, { ok: true, data: { status: 'idle', cwd: sessions.get(match[1]) } })
    }
    return json(res, { ok: false, error: 'unsupported mock route' }, 404)
  } catch (e) { return json(res, { ok: false, error: e.message }, e.code === 'ENOENT' ? 404 : 500) }
})
await new Promise(r => node.listen(0, '127.0.0.1', r)); nodeBase = `http://127.0.0.1:${node.address().port}`
process.env.WORKBUDDY_ALLOW_PRIVATE_DIRECT = '1'
const ref = { kind: 'mapping', mappingId: 'owner-node' }
const config = { host: '127.0.0.1', port: 0, prefix, dataDir: join(data, 'store'), onenatBaseUrl: nodeBase, onenatApiKey: 'fixture-directory-key', autoRefreshMs: 3600000, apiToken: token, xiaozhiMcp: '', adminUsername: 'workbuddy', adminPassword: 'workbuddy-admin', quiet: true }
async function api(path, body, cookie = '', method = body === undefined ? 'GET' : 'POST') {
  const res = await fetch(base + '/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) })
  const text = await res.text(); let value; try { value = JSON.parse(text) } catch { value = text }
  return { status: res.status, body: value, cookie: (res.headers.get('set-cookie') || '').split(';')[0] }
}
async function user(email, admin) {
  const invited = await api('/users', { email, displayName: email }, admin); assert.equal(invited.status, 201)
  const invite = new URL(invited.body.data.inviteLink).searchParams.get('token')
  const accepted = await api('/invitations/' + invite, { password: 'Password123', displayName: email }); assert.equal(accepted.status, 200)
  return { cookie: accepted.cookie, id: app.auth.getUserByUsername(email).id }
}
let seq = 0, mcpSession
async function tool(args, cookie, { mcp = false, id = ++seq, service = false } = {}) {
  const res = await fetch(base + (mcp ? '/mcp' : '/api/tools/workbuddy_file_manage'), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(service ? { Authorization: 'Bearer ' + token } : {}), ...(mcp && mcpSession ? { 'Mcp-Session-Id': mcpSession } : {}) }, body: JSON.stringify(mcp ? { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'workbuddy_file_manage', arguments: args } } : args), signal: AbortSignal.timeout(30000) })
  assert.equal(res.status, 200); const out = await res.json()
  return mcp ? JSON.parse(out.result.content[0].text) : out.result
}
async function multipart(path, files, cookie) {
  const body = new FormData(); for (const [name, text] of files) body.append('files', new Blob([text]), name)
  const res = await fetch(base + '/api' + path, { method: 'POST', headers: { Cookie: cookie }, body, signal: AbortSignal.timeout(30000) })
  return { status: res.status, body: await res.json() }
}
async function check(name, fn) { await fn(); checks++; console.log('PASS ' + name) }
async function noIO(fn) { const before = observations.length; await fn(); assert.equal(observations.length, before, 'rejected request reached DSH') }
try {
  app = createApp(config); await new Promise(r => app.server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${app.server.address().port}${prefix}`
  const admin = (await api('/auth/login', { username: 'workbuddy', password: 'workbuddy-admin' })).cookie
  const owner = await user('owner@example.test', admin), member = await user('member@example.test', admin), outsider = await user('outsider@example.test', admin)
  const initialized = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie }, body: JSON.stringify({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 'task59', version: '1' } } }) })
  assert.equal(initialized.status, 200); mcpSession = initialized.headers.get('mcp-session-id'); assert.ok(mcpSession); await initialized.arrayBuffer()
  const p = app.store.upsertProject({ name: 'authorized', dshRef: ref, workspace: root, apiKey: 'fixture-node-secret', owner: owner.id, projectMembers: [{ userId: owner.id, role: 'owner', joinedAt: 1 }, { userId: member.id, role: 'member', joinedAt: 1 }] })
  const privateProject = app.store.upsertProject({ name: 'private', dshRef: ref, workspace: sibling, owner: outsider.id })
  const task = app.store.upsertTask({ id: 'task-workspace', title: 'fixture', mode: 'chat', status: 'draft', projectId: p.id, ownerUserId: owner.id, nodeRef: ref, memberAgentIds: [], turns: [], sessions: {}, createdAt: 1, updatedAt: 1 })
  app.store.upsertTask({ ...task, id: 'task-legacy-owned', ownerUserId: undefined })
  const q = '&projectId=' + p.id, fileArgs = { taskId: task.id }
  await check('HTTP project list/download: owner and member read, outsider denied before IO', async () => {
    for (const actor of [owner, member]) {
      const list = await api('/agents/fs/list?path=' + encodeURIComponent(root) + q, undefined, actor.cookie); assert.equal(list.status, 200, JSON.stringify(list.body)); assert.equal(list.body.data.home, root); assert.equal(list.body.data.parent, undefined)
      const dl = await api('/agents/fs/download?path=' + encodeURIComponent(join(root, 'input.txt')) + q, undefined, actor.cookie); assert.equal(dl.body, 'original')
    }
    await noIO(async () => { for (const action of ['list', 'download']) assert.equal((await api('/agents/fs/' + action + '?path=' + encodeURIComponent(root) + q, undefined, outsider.cookie)).status, 404) })
  })
  await check('REST writes and attachment routes deny members/outsiders before DSH', async () => {
    await noIO(async () => {
      for (const actor of [member, outsider]) {
        const status = actor === member ? 403 : 404
        assert.equal((await api('/agents/fs/mkdir', { projectId: p.id, path: root, name: 'denied' }, actor.cookie)).status, status)
        assert.equal((await api('/agents/fs/remove?path=' + encodeURIComponent(join(root, 'input.txt')) + q, undefined, actor.cookie, 'DELETE')).status, status)
        assert.equal((await api('/agents/fs/upload?path=' + encodeURIComponent(root) + q, {}, actor.cookie)).status, status)
        for (const suffix of ['/attachments', '/attachments/direct/init', '/attachments/direct/register', '/attachments/direct/relay']) {
          const result = await api('/tasks/' + task.id + suffix, {}, actor.cookie); assert.equal(result.status, status)
        }
      }
    })
  })
  await check('generic node/agent file access cannot bypass project scope', async () => {
    const agent = app.store.upsertAgent({ name: 'owner-node-agent', dshRef: ref, workDir: root })
    await noIO(async () => {
      for (const cookie of [member.cookie, outsider.cookie]) for (const query of ['node=' + encodeURIComponent(JSON.stringify(ref)), 'agent=' + agent.id]) {
        for (const action of ['list', 'download']) assert.equal((await api('/agents/fs/' + action + '?' + query + '&path=' + encodeURIComponent(sibling), undefined, cookie)).status, 403)
        assert.equal((await api('/agents/fs/remove?' + query + '&path=' + encodeURIComponent(root), undefined, cookie, 'DELETE')).status, 403)
      }
      assert.equal((await tool({ agent: agent.id, action: 'download', path: join(sibling, 'secret.txt') }, member.cookie)).ok, false)
    })
  })
  await check('HTTP tool and MCP all seven actions enforce project view/edit, including legacy ownerless tasks', async () => {
    await noIO(async () => {
      for (const mcp of [false, true]) for (const taskId of [task.id, 'task-legacy-owned']) for (const action of ['list', 'download', 'mkdir', 'upload', 'delete', 'upload_resumable_init', 'upload_register']) {
        const out = await tool({ taskId, action, path: root, name: 'file.txt', size: '1', contentBase64: 'eA==', uploadId: 'none' }, outsider.cookie, { mcp })
        assert.equal(out.ok, false); assert.ok(!JSON.stringify(out).includes('fixture-node-secret'))
        if (!['list', 'download'].includes(action)) assert.equal((await tool({ taskId, action, path: root, name: 'x', size: '1' }, member.cookie, { mcp })).code, 'WORKSPACE_READ_ONLY')
      }
    })
    for (const mcp of [false, true]) {
      const out = await tool({ ...fileArgs, action: 'download', path: 'input.txt' }, member.cookie, { mcp }); assert.equal(out.ok, true); assert.equal(out.sha256, sha('original'))
    }
  })
  await check('MCP identical RPC id across users and membership revocation never replays content', async () => {
    const args = { ...fileArgs, action: 'download', path: 'input.txt' }, id = 'same-id'
    assert.equal((await tool(args, member.cookie, { mcp: true, id })).content, 'original')
    await noIO(async () => assert.equal((await tool(args, outsider.cookie, { mcp: true, id })).ok, false))
    app.store.upsertProject({ id: p.id, projectMembers: [{ userId: owner.id, role: 'owner', joinedAt: 1 }] })
    await noIO(async () => assert.equal((await tool(args, member.cookie, { mcp: true, id })).ok, false))
    app.store.upsertProject({ id: p.id, projectMembers: [{ userId: member.id, role: 'member', joinedAt: 1 }] })
  })
  await check('lexical traversal and sibling private roots fail before IO; descendant and root symlinks fail closed', async () => {
    for (const path of ['../private/secret.txt', sibling, root + '-other/file', '..\\private\\secret.txt']) await noIO(async () => {
      const out = await tool({ ...fileArgs, action: 'download', path }, owner.cookie); assert.equal(out.ok, false)
    })
    const downloadsBefore = observations.filter(o => o.route.endsWith('/fs/download')).length
    const linked = await tool({ ...fileArgs, action: 'download', path: 'escape/secret.txt' }, owner.cookie); assert.equal(linked.code, 'WORKSPACE_SYMLINK')
    const alias = join(data, 'root-alias'); await symlink(sibling, alias)
    const aliasProject = app.store.upsertProject({ name: 'alias', dshRef: ref, workspace: alias, owner: owner.id })
    const aliasTask = app.store.upsertTask({ ...task, id: 'task-alias', projectId: aliasProject.id })
    assert.equal((await tool({ taskId: aliasTask.id, action: 'download', path: 'secret.txt' }, owner.cookie)).code, 'WORKSPACE_ROOT_UNVERIFIED')
    const ancestorProject = app.store.upsertProject({ name: 'ancestor-link', dshRef: ref, workspace: join(alias, 'subdir'), owner: owner.id })
    const ancestorTask = app.store.upsertTask({ ...task, id: 'task-ancestor', projectId: ancestorProject.id })
    assert.equal((await tool({ taskId: ancestorTask.id, action: 'download', path: 'secret.txt' }, owner.cookie)).code, 'WORKSPACE_ROOT_UNVERIFIED')
    if (process.platform === 'darwin') {
      const macAlias = root.replace(/^\/private\/var\//, '/var/')
      assert.notEqual(macAlias, root)
      const macProject = app.store.upsertProject({ name: 'mac-var-alias', dshRef: ref, workspace: macAlias, owner: owner.id })
      const macTask = app.store.upsertTask({ ...task, id: 'task-mac-var', projectId: macProject.id })
      const out = await tool({ taskId: macTask.id, action: 'download', path: 'input.txt' }, owner.cookie)
      assert.equal(out.code, 'WORKSPACE_ROOT_UNVERIFIED'); assert.match(out.error, /private\/var/)
    }
    assert.equal(observations.filter(o => o.route.endsWith('/fs/download')).length, downloadsBefore)
  })
  await check('inconsistent remote metadata fails closed without downloading content', async () => {
    const downloads = observations.filter(o => o.route.endsWith('/fs/download')).length
    invalidMetadata = true
    try { assert.equal((await tool({ ...fileArgs, action: 'download', path: 'input.txt' }, owner.cookie)).code, 'WORKSPACE_METADATA_INVALID') }
    finally { invalidMetadata = false }
    assert.equal(observations.filter(o => o.route.endsWith('/fs/download')).length, downloads)
  })
  await check('owner creates directories and CAS writes; no version and stale version never overwrite', async () => {
    assert.equal((await tool({ ...fileArgs, action: 'mkdir', name: 'new-dir' }, owner.cookie)).ok, true)
    assert.equal((await tool({ ...fileArgs, action: 'upload', name: 'input.txt', contentBase64: 'eA==' }, owner.cookie)).code, 'VERSION_REQUIRED')
    const updated = await tool({ ...fileArgs, action: 'upload', name: 'input.txt', contentBase64: Buffer.from('updated').toString('base64'), expectedSha256: sha('original') }, owner.cookie)
    assert.equal(updated.ok, true, JSON.stringify(updated)); assert.equal(updated.sha256, sha('updated'))
    const stale = await tool({ ...fileArgs, action: 'upload', name: 'input.txt', contentBase64: 'eA==', expectedSha256: sha('original') }, owner.cookie)
    assert.equal(stale.code, 'CAS_MISMATCH'); assert.equal(await readFile(join(root, 'input.txt'), 'utf8'), 'updated')
    const created = await tool({ ...fileArgs, action: 'upload', name: 'created.txt', contentBase64: 'eA==' }, owner.cookie); assert.equal(created.ok, true)
    assert.equal(sessions.size, 0)
  })
  await check('REST multipart creates, versioned updates, conflicts, concurrent CAS and partial save reporting', async () => {
    const route = '/agents/fs/upload?path=' + encodeURIComponent(root) + q
    const create = await multipart(route, [['http.txt', 'one']], owner.cookie)
    assert.equal(create.status, 200, JSON.stringify(create.body))
    const blind = await multipart(route, [['http.txt', 'bad']], owner.cookie); assert.equal(blind.status, 428); assert.equal(blind.body.code, 'VERSION_REQUIRED')
    assert.equal((await multipart(route + '&expectedSha256=' + sha('one'), [['http.txt', 'two']], owner.cookie)).status, 200)
    const stale = await multipart(route + '&expectedSha256=' + sha('one'), [['http.txt', 'bad']], owner.cookie); assert.equal(stale.status, 409); assert.equal(stale.body.code, 'CAS_MISMATCH')
    const partial = await multipart(route, [['partial.txt', 'saved'], ['http.txt', 'bad']], owner.cookie)
    assert.equal(partial.status, 428); assert.equal(partial.body.partial, true); assert.deepEqual(partial.body.files.map(f => f.name), ['partial.txt']); assert.equal(partial.body.failedFile, 'http.txt')
    assert.equal(await readFile(join(root, 'http.txt'), 'utf8'), 'two')
    const writes = await Promise.all(['A', 'B'].map(content => multipart(route + '&expectedSha256=' + sha('two'), [['http.txt', content]], owner.cookie)))
    assert.deepEqual(writes.map(r => r.status).sort(), [200, 409]); assert.match(await readFile(join(root, 'http.txt'), 'utf8'), /^[AB]$/)
    assert.equal((await api('/agents/fs/mkdir', { projectId: p.id, path: root, name: 'http-dir' }, owner.cookie)).status, 200)
    assert.equal((await api('/agents/fs/remove?path=' + encodeURIComponent(join(root, 'http-dir')) + q, undefined, owner.cookie, 'DELETE')).status, 200)
  })
  await check('project task attachments use scoped CAS, not blind session upload; downloads obey the same root', async () => {
    const route = '/tasks/' + task.id + '/attachments'
    const out = await multipart(route, [['attachment.txt', 'attachment']], owner.cookie); assert.equal(out.status, 200, JSON.stringify(out.body))
    assert.equal((await multipart(route, [['attachment.txt', 'bad']], owner.cookie)).status, 428)
    const partial = await multipart(route, [['saved-attachment.txt', 'saved'], ['attachment.txt', 'bad']], owner.cookie)
    assert.equal(partial.status, 428); assert.equal(partial.body.partial, true)
    assert.ok(app.store.getTask(task.id).attachments.some(a => a.path === join(root, 'saved-attachment.txt')))
    const dl = await api('/tasks/' + task.id + '/files/download?path=attachment.txt', undefined, member.cookie); assert.equal(dl.body, 'attachment')
    await noIO(async () => assert.equal((await api('/tasks/' + task.id + '/files/download?path=../private/secret.txt', undefined, member.cookie)).status, 403))
  })
  await check('MCP successful write replay is idempotent, loses write access after owner revocation', async () => {
    const args = { ...fileArgs, action: 'mkdir', name: 'idempotent' }, options = { mcp: true, id: 'write-id' }
    assert.equal((await tool(args, owner.cookie, options)).ok, true)
    await noIO(async () => assert.equal((await tool(args, owner.cookie, options)).ok, true))
    app.store.upsertProject({ id: p.id, owner: outsider.id, projectMembers: [{ userId: owner.id, role: 'member', joinedAt: 1 }] })
    await noIO(async () => assert.equal((await tool(args, owner.cookie, options)).code, 'WORKSPACE_READ_ONLY'))
    app.store.upsertProject({ id: p.id, owner: owner.id })
  })
  await check('nested private project paths, recursive parent deletion and listing are scoped', async () => {
    const nested = join(root, 'private'); await mkdir(nested); await writeFile(join(nested, 'secret'), 'nested secret')
    const replayArgs = { ...fileArgs, action: 'download', path: 'private/secret' }, replayOptions = { mcp: true, id: 'overlap-read' }
    assert.equal((await tool(replayArgs, owner.cookie, replayOptions)).content, 'nested secret')
    app.store.upsertProject({ name: 'nested-private', dshRef: { kind: 'app', appId: 'owner-app' }, workspace: nested + '/', owner: outsider.id })
    await noIO(async () => assert.equal((await tool(replayArgs, owner.cookie, replayOptions)).code, 'WORKSPACE_PATH_DENIED'))
    await noIO(async () => { assert.equal((await tool({ ...fileArgs, action: 'download', path: 'private/secret' }, owner.cookie)).code, 'WORKSPACE_PATH_DENIED'); assert.equal((await tool({ ...fileArgs, action: 'delete', path: root }, owner.cookie)).ok, false) })
    const list = await tool({ ...fileArgs, action: 'list' }, owner.cookie); assert.ok(!list.data.entries.some(e => e.name === 'private'))
  })
  await check('MCP cached writes bind root/node/task, cached reads rerun current scope', async () => {
    const args = { ...fileArgs, action: 'mkdir', name: 'scope-bound' }, opts = { mcp: true, id: 'scope-write' }
    assert.equal((await tool(args, owner.cookie, opts)).ok, true)
    const alternate = join(data, 'alternate'); await mkdir(alternate); await writeFile(join(alternate, 'input.txt'), 'alternate')
    const read = { ...fileArgs, action: 'download', path: 'input.txt' }, readOpts = { mcp: true, id: 'scope-read' }
    assert.equal((await tool(read, owner.cookie, readOpts)).content, 'updated')
    app.store.upsertProject({ id: p.id, workspace: alternate })
    await noIO(async () => assert.equal((await tool(args, owner.cookie, opts)).code, 'WORKSPACE_SCOPE_CHANGED'))
    assert.equal((await tool(read, owner.cookie, readOpts)).content, 'alternate')
    app.store.upsertProject({ id: p.id, workspace: root, dshRef: { kind: 'app', appId: 'owner-app' } })
    await noIO(async () => assert.equal((await tool(args, owner.cookie, opts)).code, 'WORKSPACE_SCOPE_CHANGED'))
    app.store.upsertProject({ id: p.id, dshRef: ref })
    const taskChanged = { ...fileArgs, action: 'mkdir', name: 'task-bound' }, taskOpts = { mcp: true, id: 'task-scope-write' }
    assert.equal((await tool(taskChanged, owner.cookie, taskOpts)).ok, true)
    app.store.mutateTask(task.id, t => { t.nodeRef = { kind: 'mapping', mappingId: 'different-executor' } })
    await noIO(async () => assert.equal((await tool(taskChanged, owner.cookie, taskOpts)).code, 'WORKSPACE_SCOPE_CHANGED'))
    app.store.mutateTask(task.id, t => { t.nodeRef = ref; t.projectId = privateProject.id })
    await noIO(async () => assert.equal((await tool(read, owner.cookie, readOpts)).ok, false))
    app.store.mutateTask(task.id, t => { t.projectId = p.id })
  })
  await check('admin and service retain explicit node access; legacy project members remain read-only', async () => {
    const generic = { action: 'download', agent: app.store.getAgents()[0].id, path: join(sibling, 'secret.txt') }
    assert.equal((await tool(generic, admin)).content, 'secret')
    assert.equal((await tool(generic, undefined, { service: true })).content, 'secret')
    for (const actor of [admin, undefined]) assert.equal((await tool({ ...fileArgs, action: 'download', path: 'input.txt' }, actor, { service: !actor })).content, 'updated')
    const serviceHeaders = { Authorization: 'Bearer ' + token }
    const serviceTask = await fetch(base + '/api/tasks/' + task.id, { headers: serviceHeaders }); assert.equal(serviceTask.status, 200)
    const serviceDownload = await fetch(base + '/api/tasks/' + task.id + '/files/download?path=input.txt', { headers: serviceHeaders }); assert.equal(serviceDownload.status, 200); assert.equal(await serviceDownload.text(), 'updated')
    assert.equal((await fetch(base + '/api/tasks/' + task.id)).status, 401)
    const legacyRoot = join(data, 'legacy'); await mkdir(legacyRoot); await writeFile(join(legacyRoot, 'input'), 'legacy')
    const legacy = app.store.upsertProject({ name: 'legacy-shared', workspace: legacyRoot, dshRef: ref })
    const legacyTask = app.store.upsertTask({ ...task, id: 'task-open-legacy', projectId: legacy.id, ownerUserId: undefined })
    assert.equal((await tool({ taskId: legacyTask.id, action: 'download', path: 'input' }, outsider.cookie)).content, 'legacy')
    await noIO(async () => assert.equal((await tool({ taskId: legacyTask.id, action: 'mkdir', name: 'denied' }, outsider.cookie)).code, 'WORKSPACE_READ_ONLY'))
  })
  await check('archived project read-only and direct credentials never granted to project owner', async () => {
    await noIO(async () => {
      for (const mcp of [false, true]) assert.equal((await tool({ ...fileArgs, action: 'upload_resumable_init', name: 'x', size: '1' }, owner.cookie, { mcp })).code, 'PROJECT_SCOPE_REQUIRED')
    })
    app.store.upsertProject({ id: p.id, archivedAt: Date.now() })
    await noIO(async () => assert.equal((await tool({ ...fileArgs, action: 'delete', path: 'input.txt' }, owner.cookie)).code, 'PROJECT_ARCHIVED'))
    assert.equal((await tool({ ...fileArgs, action: 'download', path: 'input.txt' }, owner.cookie)).ok, true)
  })
  console.log(JSON.stringify({ ok: true, scenarios: checks, mockWorkerExecutions: modelRuns, nodeRequests: observations.length, activeSessions: sessions.size }))
} finally {
  if (app) { app.store.flush(); await app.close() }
  await new Promise(r => node.close(r))
  const target = resolve(data); assert.ok(target.startsWith(join(await realpath(tmpdir()), 'wb-workspace-perm-')))
  await rm(target, { recursive: true, force: true })
}
