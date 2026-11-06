#!/usr/bin/env node
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const observations = { owner: [], executor: [] }
const json = (res, data, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)) }
async function stub(name) {
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part
    let body; try { body = JSON.parse(raw) } catch {}
    observations[name].push({ method: req.method, url: req.url, body, raw, auth: req.headers.authorization })
    const url = new URL(req.url, 'http://stub')
    if (url.pathname.endsWith('/system/status')) return json(res, { ok: true, data: { version: 'test', name } })
    if (url.pathname.endsWith('/workspaces')) return json(res, { ok: true, data: [] })
    if (url.pathname.endsWith('/fs/list')) {
      const path = url.searchParams.get('path') || '/', name = path === '/' ? 'owner' : path === '/owner' ? 'project' : undefined
      const entries = name ? [{ name, path: (path === '/' ? '' : path) + '/' + name, type: 'dir', hidden: false }] : []
      return json(res, { ok: true, data: { path, home: '/', entries, truncated: false } })
    }
    if (url.pathname.endsWith('/sessions') && req.method === 'POST') return json(res, { ok: true, data: { sessionId: name + '-session' } })
    if (/\/sessions\/[^/]+\/files$/.test(url.pathname)) return json(res, { ok: true, data: { files: [{ name: '.workbuddy-workspace-remote-v3.mjs', path: '/executor-scratch/.workbuddy-workspace-remote-v3.mjs' }] } })
    if (url.pathname.endsWith('/prompt-stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end('event: delta\ndata: {"delta":"ok"}\n\nevent: turn_end\ndata: {"reason":"stop"}\n\nevent: done\ndata: [DONE]\n\n'); return
    }
    if (/\/sessions\/[^/]+$/.test(url.pathname)) return json(res, { ok: true, data: { cwd: '/executor-scratch', status: 'idle' } })
    return json(res, { ok: false, error: 'unsupported in test' }, 404)
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { server, base: `http://127.0.0.1:${server.address().port}/api/v1` }
}
const owner = await stub('owner'), executor = await stub('executor')
const data = await mkdtemp(join(tmpdir(), 'wb-workspace-e2e-'))
const portServer = createServer(); portServer.listen(0, '127.0.0.1'); await once(portServer, 'listening'); const port = portServer.address().port; await new Promise(r => portServer.close(r))
const proc = spawn(process.execPath, ['dist/server.js', '--port', String(port), '--data', data, '--quiet'], { env: { ...process.env, WORKBUDDY_ALLOW_PRIVATE_DIRECT: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
let logs = ''; proc.stdout.on('data', chunk => { logs += chunk }); proc.stderr.on('data', chunk => { logs += chunk })
const base = `http://127.0.0.1:${port}/onenat-workbuddy/api`
let cookie = ''
async function api(path, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0]
  return { status: response.status, json: await response.json() }
}
async function until(fn) {
  const end = Date.now() + 20000
  while (Date.now() < end) { try { const value = await fn(); if (value) return value } catch {} await new Promise(r => setTimeout(r, 100)) }
  throw new Error('condition timed out\n' + logs.slice(-3000))
}
try {
  await until(async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).ok)
  assert.equal((await api('/auth/login', { username: 'workbuddy', password: 'workbuddy-admin' })).status, 200)
  const ownerRef = { kind: 'direct', apiBaseUrl: owner.base }, execRef = { kind: 'direct', apiBaseUrl: executor.base }
  const p = await api('/projects', { name: 'shared-workspace', dshRef: ownerRef, workspace: '/owner/project', apiKey: 'owner-key' })
  assert.equal(p.status, 200)
  const projectId = p.json.data.id
  const duplicate = await api('/projects', { name: 'duplicate', dshRef: ownerRef, workspace: '/owner/project/' })
  assert.equal(duplicate.status, 409, 'duplicate project must conflict')
  const other = await api('/projects', { name: 'different-node-same-path', dshRef: execRef, workspace: '/owner/project' })
  assert.equal(other.status, 200, 'same path on another node is distinct')
  const t = await api('/tasks', { title: 'remote project main', projectId, nodeRef: execRef, memberAgentIds: [], message: '读取项目文件' })
  assert.equal(t.status, 201)
  const prompt = await until(() => observations.executor.find(x => x.url.endsWith('/prompt-stream'))?.body?.prompt)
  assert.ok(prompt.includes('[项目工作区跨机访问]'), 'main receives workspace access without @')
  assert.ok(prompt.includes(owner.base), 'workspace points to owner')
  assert.ok(prompt.includes('owner-key'), 'owner credential paired with owner address')
  const created = observations.executor.find(x => x.url.endsWith('/sessions') && x.method === 'POST')
  assert.notEqual(created.body.cwd, '/owner/project', 'remote path must never be passed as local cwd')
  assert.ok(observations.executor.some(x => /\/sessions\/[^/]+\/files$/.test(x.url)), 'helper uploaded to execution session')
  assert.ok(!observations.executor.some(x => x.url.includes('/fs/mkdir') && x.raw.includes('/owner/project')), 'no empty project mirror directory')
  const files = await api('/agents/fs/list?projectId=' + projectId + '&node=' + encodeURIComponent(JSON.stringify(execRef)) + '&path=%2Fowner%2Fproject&all=1')
  assert.equal(files.status, 200)
  assert.ok(observations.owner.some(x => x.url.includes('/fs/list?') && x.auth === 'Bearer owner-key'), 'project files use owner node and owner credentials even with conflicting node query')
  assert.ok(!observations.executor.some(x => x.url.includes('/fs/list?')), 'project files never list execution node')
  const missingFiles = await api('/agents/fs/list?projectId=proj-missing&path=%2Fowner%2Fproject')
  assert.equal(missingFiles.status, 404)
  await api('/projects/' + projectId, { defaultExecutionNodeRef: ownerRef }, 'PUT')
  const saved = await api('/tasks/' + t.json.data.id)
  assert.deepEqual(saved.json.data.nodeRef, execRef, 'existing task remains pinned')
  console.log('PASS project workspace e2e: duplicate conflict, distinct owner, remote main, helper upload, cwd isolation, task snapshot')
} finally {
  proc.kill('SIGTERM')
  await Promise.race([once(proc, 'exit'), new Promise(r => setTimeout(r, 3000))])
  if (proc.exitCode === null) proc.kill('SIGKILL')
  await Promise.all([new Promise(r => owner.server.close(r)), new Promise(r => executor.server.close(r))])
  const resolved = await import('node:path').then(m => m.resolve(data))
  assert.ok(resolved.startsWith(join(tmpdir(), 'wb-workspace-e2e-')))
  await rm(resolved, { recursive: true, force: true })
}
