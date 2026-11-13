import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkBuddyMcpServer } from '../dist/mcp-server.js'

async function fixture(t, options = {}) {
  const dir = options.dataDir || mkdtempSync(join(tmpdir(), 'wb-session-test-'))
  if (!options.dataDir) t.after(() => rmSync(dir, { recursive: true, force: true }))
  let executions = 0
  const logs = []
  const mcp = new WorkBuddyMcpServer({ serverName: 'test', serverVersion: '1', dataDir: dir,
    sessionMax: options.sessionMax || 200, log: line => logs.push(line),
    getTools: () => [{ name: options.toolName || 'workbuddy_task_manage', description: 'test', parameters: {},
      ...(options.canReplay ? { canReplay: options.canReplay } : {}),
      execute: async (_args, ctx) => { options.observeContext?.(ctx); executions++; await new Promise(resolve => setImmediate(resolve)); return options.result ? options.result(executions) : JSON.stringify({ ok: true, taskCreated: true, taskId: `task-${executions}` }) } }],
  })
  const server = http.createServer((req, res) => mcp.handleRequest(req, res, req.method, {
    session: { userId: req.headers['x-test-user'] || 'user-1', username: 'test', role: 'admin' },
    readOnly: req.headers['x-test-readonly'] === 'true',
  }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  async function rpc(method, sid, params = {}, id = 1, headers = {}) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}`, { method: 'POST', headers: {
      'content-type': 'application/json', ...(sid ? { 'mcp-session-id': sid } : {}), ...headers,
    }, body: JSON.stringify({ jsonrpc: '2.0', method, id, params }) })
    const body = await response.json()
    return { body, sid: response.headers.get('mcp-session-id') }
  }
  return { mcp, rpc, dir, logs, executions: () => executions }
}
const create = { name: 'workbuddy_task_manage', arguments: { action: 'create', title: 'once' } }

test('expired initialize succeeds, replaces old id and gives reset metadata', async t => {
  const f = await fixture(t)
  const r = await f.rpc('initialize', 'expired-session')
  assert.ok(r.body.result, JSON.stringify(r.body))
  assert.ok(r.sid && r.sid !== 'expired-session')
  assert.equal(r.body.result.sessionReset, true)
  assert.ok(r.body.result.previousSessionIdDigest)
})

test('unknown session transparently resumes methods and notifications; idle and LRU do not break it', async t => {
  const f = await fixture(t, { sessionMax: 1 })
  assert.ok((await f.rpc('tools/list', 'old-id')).body.result.tools)
  const initial = JSON.parse(readFileSync(join(f.dir, 'mcp-sessions.json'), 'utf8'))
  assert.ok(initial.sessions.some(s => s.id === 'old-id'))
  await f.rpc('initialize')
  assert.ok((await f.rpc('ping', 'old-id')).body.result)
  assert.ok(f.logs.some(line => line.includes('LRU')))
  assert.equal(f.mcp.getStatus().sessions, 1)
})

test('session timestamps survive server reconstruction; idle persisted session revives', async t => {
  const f = await fixture(t)
  const init = await f.rpc('initialize')
  const path = join(f.dir, 'mcp-sessions.json')
  assert.equal(statSync(path).mode & 0o777, 0o600)
  const disk = JSON.parse(readFileSync(path, 'utf8'))
  const prior = disk.sessions.find(s => s.id === init.sid)
  prior.lastAt = Date.now() - 31 * 60_000
  writeFileSync(path, JSON.stringify(disk))
  const next = await fixture(t, { dataDir: f.dir })
  assert.ok((await next.rpc('tools/list', init.sid)).body.result.tools)
  const revived = JSON.parse(readFileSync(path, 'utf8')).sessions.find(s => s.id === init.sid)
  assert.equal(revived.createdAt, prior.createdAt)
  assert.ok(revived.lastAt > prior.lastAt)
})

test('write replay survives new session and new rpc id, concurrent retries execute once, identities separate', async t => {
  const f = await fixture(t)
  const results = await Promise.all([f.rpc('tools/call', 'old', create, 1), f.rpc('tools/call', 'new', create, 2)])
  assert.equal(f.executions(), 1)
  assert.deepEqual(results[0].body.result, results[1].body.result)
  assert.equal(results[1].body.id, 2)
  await f.rpc('tools/call', 'another', { arguments: { title: 'once', action: 'create' }, name: create.name }, 3)
  assert.equal(f.executions(), 1)
  await f.rpc('tools/call', 'another', create, 4, { 'x-test-user': 'user-2' })
  assert.equal(f.executions(), 2)
})

test('session metadata persistence does not retain business responses or credentials', async t => {
  const f = await fixture(t)
  const first = await f.rpc('tools/call', 'before-restart', create)
  assert.ok(first.body.result, JSON.stringify(first.body))
  assert.equal(f.executions(), 1)
  const disk = JSON.parse(readFileSync(join(f.dir, 'mcp-sessions.json'), 'utf8'))
  assert.deepEqual(disk.replays, [])
  assert.ok(!JSON.stringify(disk).includes('task-1'))
})

test('tool-local scope guard uses stable write identity across changed RPC ids', async t => {
  let executionRpcId
  const f = await fixture(t, { observeContext: ctx => { executionRpcId = ctx.rpcId }, canReplay: (_args, ctx) => ctx.rpcId === executionRpcId })
  await f.rpc('tools/call', 'old', create, 1)
  const retry = await f.rpc('tools/call', 'new', create, 999)
  assert.equal(retry.body.id, 999)
  assert.equal(f.executions(), 1)
})

test('failed writes can recover while partial-write receipts prevent duplicate creates', async t => {
  const f = await fixture(t, { result: count => JSON.stringify(count === 1 ? { ok: false, code: 'NODE_OFFLINE', error: 'offline' } : { ok: true, taskId: 'created' }) })
  await f.rpc('tools/call', 'old', create, 1)
  const success = await f.rpc('tools/call', 'new', create, 2)
  assert.equal(success.body.result.isError, false)
  assert.equal(f.executions(), 2)
  const partial = await fixture(t, { result: () => JSON.stringify({ ok: false, code: 'WRITEBACK_FAILED', error: 'writeback', taskCreated: true, taskId: 'created' }) })
  await partial.rpc('tools/call', 'old', create, 1)
  await partial.rpc('tools/call', 'new', create, 2)
  assert.equal(partial.executions(), 1)
})

test('full status and refresh/probe queries stay fresh across new rpc ids', async t => {
  for (const [name, args] of [['workbuddy_task_status', { detail: 'full' }], ['workbuddy_resource_manage', { action: 'resolve', mappingId: 'm' }], ['workbuddy_agent_manage', { action: 'ping', agentId: 'a' }]]) {
    const f = await fixture(t, { toolName: name })
    await f.rpc('tools/call', 'same', { name, arguments: args }, 10)
    await f.rpc('tools/call', 'same', { name, arguments: args }, 11)
    assert.equal(f.executions(), 2, name)
  }
})

test('read polls with new rpc ids stay fresh; canReplay hook can reject stale object authorization', async t => {
  let allowed = true
  const f = await fixture(t, { canReplay: () => allowed })
  await f.rpc('tools/call', 'old', create, 1)
  allowed = false
  await f.rpc('tools/call', 'new', create, 2)
  assert.equal(f.executions(), 2)
  allowed = true
  const read = { name: create.name, arguments: { action: 'list' } }
  await f.rpc('tools/call', 'old', read, 10)
  await f.rpc('tools/call', 'old', read, 11)
  assert.equal(f.executions(), 4)
  await f.rpc('tools/call', 'old', read, 11)
  assert.equal(f.executions(), 4)
  await f.rpc('tools/call', 'other-client', read, 11)
  assert.equal(f.executions(), 5, 'independent clients may reuse RPC ids without stale read replay')
})
