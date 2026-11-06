#!/usr/bin/env node
/** task-58 isolated browser fixture. No production data or real remote execution. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createApp } from '../dist/server.js'

const output = resolve(process.env.WORKBUDDY_CONSOLE_ARTIFACTS || 'artifacts/task58/mock')
await mkdir(output, { recursive: true })
const dataDir = await mkdtemp(join(tmpdir(), 'wb-task58-console-'))
const observations = []
const sessions = new Map()
let seq = 0, app
const control = { ownerOnline: true, extraOnline: false }
const root = '/owner/project'
const taskName = 'task-1 - Owner backlog.md'
const texts = {
  [root + '/README.md']: '# Owner-only project\nTask-58 file owner evidence.\n',
  [root + '/backlog/config.yml']: 'project_name: Task58 Console\nstatuses: [To Do, In Progress, Done]\ndefault_status: To Do\ntask_prefix: task\n',
  [root + '/backlog/tasks/' + taskName]: '---\nid: task-1\ntitle: Owner-only backlog\nstatus: To Do\ncreated_date: 2026-11-06\n---\n\n## Description\n\n<!-- SECTION:DESCRIPTION:BEGIN -->\nOwner backlog evidence.\n<!-- SECTION:DESCRIPTION:END -->\n\n## Acceptance Criteria\n<!-- AC:BEGIN -->\n- [ ] #1 Owner evidence\n<!-- AC:END -->\n',
}
const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
const listen = server => new Promise(r => server.listen(0, '127.0.0.1', r))
const servers = []
async function node(name) {
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    let body; try { body = JSON.parse(raw) } catch {}
    const url = new URL(req.url, 'http://mock')
    const key = name + '-key'
    const authorized = req.headers.authorization === 'Bearer ' + key
    observations.push({ name, method: req.method, path: url.pathname, query: url.search, authorized, ...(body && { body: url.pathname.endsWith('/prompt-stream') ? { promptReceived: true } : body }) })
    if (!authorized) return json(res, { ok: false, error: 'wrong node credential' }, 401)
    if (url.pathname.endsWith('/system/status')) return json(res, { ok: true, data: { name: 'dsh-web-service', version: '0.6.1' } })
    if (url.pathname.endsWith('/models/default')) return json(res, { ok: true, data: { provider: 'mock', model: 'console' } })
    if (url.pathname.endsWith('/models')) return json(res, { ok: true, data: [{ provider: 'mock', id: 'console', name: 'Console mock', isDefault: true }] })
    if (url.pathname.endsWith('/agent-presets')) return json(res, { ok: true, data: { presets: [] } })
    if (url.pathname.endsWith('/workspaces')) return json(res, { ok: true, data: [] })
    if (url.pathname.endsWith('/fs/list')) {
      const path = url.searchParams.get('path') || root
      let entries = []
      if (name === 'owner') {
        const directories = { [root]: ['backlog'], [root + '/backlog']: ['tasks'] }
        entries = Object.entries(texts).filter(([p]) => p.slice(0, p.lastIndexOf('/')) === path).map(([p, text]) => ({ name: p.split('/').pop(), path: p, type: 'file', size: text.length }))
        entries.push(...(directories[path] || []).map(n => ({ name: n, path: path + '/' + n, type: 'dir' })))
      } else entries = [{ name: 'EXECUTOR_ONLY.txt', path: path + '/EXECUTOR_ONLY.txt', type: 'file', size: 1 }]
      return json(res, { ok: true, data: { path, home: '/owner', entries, truncated: false } })
    }
    if (url.pathname.endsWith('/fs/download')) {
      const text = name === 'owner' ? texts[url.searchParams.get('path')] : undefined
      if (text === undefined) return json(res, { ok: false, error: 'not found' }, 404)
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(text)
    }
    if (url.pathname.endsWith('/sessions') && req.method === 'POST') {
      const sessionId = `session-${name}-${++seq}`
      sessions.set(sessionId, { name, cwd: body.cwd || '/' + name + '/scratch', status: 'idle' })
      return json(res, { ok: true, data: { sessionId } })
    }
    const m = /\/sessions\/([^/]+)(?:\/(.*))?$/.exec(url.pathname)
    if (m) {
      const session = sessions.get(m[1])
      if (!session || session.name !== name) return json(res, { ok: false, error: 'session not found' }, 404)
      if (m[2] === 'files') return json(res, { ok: true, data: { files: [{ name: '.workbuddy-workspace-remote-v2.mjs', path: session.cwd + '/.workbuddy-workspace-remote-v2.mjs' }] } })
      if (m[2] === 'permission') return json(res, { ok: true, data: { preset: 'danger-full-access' } })
      if (m[2] === 'history') return json(res, { ok: true, data: { messages: [] } })
      if (m[2] === 'prompt-stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        return res.end('event: delta\ndata: {"delta":"Task58 mock reply from ' + name + '"}\n\nevent: turn_end\ndata: {"reason":"stop"}\n\nevent: done\ndata: [DONE]\n\n')
      }
      if (!m[2]) return json(res, { ok: true, data: session })
    }
    return json(res, { ok: false, error: 'unsupported fixture endpoint' }, 404)
  })
  await listen(server); servers.push(server)
  return server.address().port
}
const ownerPort = await node('owner'), executorPort = await node('executor')
const refs = { owner: { kind: 'mapping', mappingId: 'file-owner' }, executor: { kind: 'mapping', mappingId: 'execution' } }
const directory = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://mock-directory')
  if (url.pathname === '/observations') return json(res, { observations, tasks: app?.store.getTasks().map(t => ({ id: t.id, projectId: t.projectId, nodeRef: t.nodeRef, status: t.status })), control })
  if (url.pathname === '/stop' && req.method === 'POST') {
    json(res, { ok: true }); setImmediate(() => stop().then(() => process.exit(0))); return
  }
  if (url.pathname === '/control' && req.method === 'POST') {
    let raw = ''; for await (const c of req) raw += c
    Object.assign(control, JSON.parse(raw)); return json(res, control)
  }
  if (req.headers.authorization !== 'Bearer fixture-key') return json(res, { error: 'unauthorized' }, 401)
  if (url.pathname === '/api/v1/resources') {
    const tunnel = (id, name, port, online) => ({ id, name, online, mappings: [{ id, proto: 'tcp', public_url: `tcp://127.0.0.1:${port}`, local: '127.0.0.1:3080', app: { id: id + '-app', name: 'DSH', type: 'http-api', skills: [{ name: 'dsh-web-service' }] } }] })
    return json(res, { tunnels: [tunnel('file-owner', 'Files owner', ownerPort, control.ownerOnline), tunnel('execution', 'Execution node', executorPort, true), tunnel('offline', 'Offline node', executorPort, false), ...(control.extraOnline ? [tunnel('new-execution', 'New online node', executorPort, true)] : [])] })
  }
  if (url.pathname.includes('/credentials')) return json(res, { auth_type: 'bearer', apiKey: url.pathname.includes('file-owner') ? 'owner-key' : 'executor-key' })
  return json(res, { error: 'not found' }, 404)
})
await listen(directory); servers.push(directory)
const directoryBase = `http://127.0.0.1:${directory.address().port}`
app = createApp({ host: '127.0.0.1', port: 0, prefix: '/onenat-workbuddy', dataDir, onenatBaseUrl: directoryBase, onenatApiKey: 'fixture-key', apiToken: 'fixture-api-token', autoRefreshMs: 3600000, xiaozhiMcp: '', adminUsername: 'workbuddy', adminPassword: 'workbuddy-admin', quiet: true })
await listen(app.server)
const base = `http://127.0.0.1:${app.server.address().port}/onenat-workbuddy`
let cookie = ''
async function api(path, body) {
  const res = await fetch(base + '/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) }, body: JSON.stringify(body) })
  if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0]
  const j = await res.json(); assert.ok(res.ok && j.ok, JSON.stringify(j)); return j.data
}
await api('/auth/login', { username: 'workbuddy', password: 'workbuddy-admin' })
const project = await api('/projects', { name: 'Task58 Console', dshRef: refs.owner, defaultExecutionNodeRef: refs.executor, workspace: root, instruction: 'Task58 isolated UI evidence', expertIds: [] })
const info = { base, directoryBase, projectId: project.id, root, refs }
await writeFile(join(output, 'fixture.json'), JSON.stringify(info, null, 2))
console.log(JSON.stringify(info))
let stopping = false
async function stop() {
  if (stopping) return; stopping = true
  await writeFile(join(output, 'requests.json'), JSON.stringify({ observations, tasks: app.store.getTasks().map(t => ({ id: t.id, projectId: t.projectId, nodeRef: t.nodeRef, status: t.status })), control }, null, 2))
  await app.close()
  await Promise.all(servers.map(s => new Promise(r => { s.close(r); s.closeAllConnections() })))
  const absolute = resolve(dataDir)
  assert.ok(absolute.startsWith(join(tmpdir(), 'wb-task58-console-')))
  await rm(absolute, { recursive: true, force: true })
  console.log('Task58 fixture stopped; isolated data removed')
}
process.on('SIGTERM', () => { stop().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) }) })
process.on('SIGINT', () => { stop().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) }) })
