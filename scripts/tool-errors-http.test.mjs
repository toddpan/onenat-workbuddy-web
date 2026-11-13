import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { WorkBuddyMcpServer } from '../dist/mcp-server.js'

// Isolated HTTP transport fixture for outcomes unavailable from normal business tools.
// Real HTTP API + MCP business validation share the smoke-mcp-server fixture.
async function fixture(run) {
  let writes = 0
  const transport = new WorkBuddyMcpServer({
    serverName: 'transport-error-test', serverVersion: '1', log() {},
    getTools: () => [
      { name: 'throw_error', execute: async () => { throw new Error('opaque execution failure') } },
      { name: 'coded_error', execute: async () => { throw Object.assign(new Error('opaque offline'), { code: 'NODE_OFFLINE' }) } },
      { name: 'legacy_error', execute: async () => JSON.stringify({ ok: false, code: 'INVALID_PARAMS', error: 'opaque validation failure', errors: [{ path: 'projectId', message: 'required' }] }) },
      { name: 'workbuddy_task_manage', execute: async () => {
        writes++
        return JSON.stringify({ ok: true, taskCreated: true, deduped: false, taskId: 'task-created-once', status: 'draft', running: false, padding: 'x'.repeat(200000) })
      } },
    ],
  })
  const server = http.createServer((req, res) => {
    transport.handleRequest(req, res, req.method).catch((err) => { res.statusCode = 500; res.end(String(err)) })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const request = async (body, headers = {}) => {
    const response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) })
    return { status: response.status, json: await response.json() }
  }
  const call = async (name, id = name) => {
    const response = await request({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: { action: 'create' } } })
    assert.equal(response.status, 200)
    assert.equal(response.json.result.isError, true)
    return JSON.parse(response.json.result.content[0].text)
  }
  try { await run({ request, call, transport, writes: () => writes }) }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
}

function contract(result, code) {
  assert.equal(result.ok, false)
  assert.equal(result.code, code)
  assert.equal(typeof result.message, 'string')
  assert.ok(result.message)
  assert.equal(typeof result.retryable, 'boolean')
  assert.equal(typeof result.recovery?.kind, 'string')
}

test('MCP HTTP missing tool, thrown failures and normalized legacy result', async () => {
  await fixture(async ({ call }) => {
    const missing = await call('missing_tool')
    contract(missing, 'TOOL_NOT_FOUND')
    assert.equal(missing.retryable, false)
    assert.equal(missing.recovery.kind, 'stop')
    contract(await call('throw_error'), 'INTERNAL_ERROR')
    const offline = await call('coded_error')
    contract(offline, 'NODE_OFFLINE')
    assert.equal(offline.retryable, false)
    const invalid = await call('legacy_error')
    contract(invalid, 'INVALID_PARAM')
    assert.equal(invalid.field, 'projectId')
    assert.equal(invalid.recovery.kind, 'correct_parameters')
  })
})

test('MCP oversize keeps write receipt and replay avoids duplicate side effects', async () => {
  await fixture(async ({ call, writes }) => {
    const result = await call('workbuddy_task_manage', 'write-once')
    contract(result, 'RESULT_TOO_LARGE')
    assert.equal(result.retryable, false)
    assert.equal(result.taskCreated, true)
    assert.equal(result.deduped, false)
    assert.equal(result.taskId, 'task-created-once')
    assert.equal(result.status, 'draft')
    assert.equal(result.running, false)
    assert.deepEqual(result.recovery, { kind: 'poll', tool: 'workbuddy_task_status', arguments: { taskId: 'task-created-once', detail: 'summary' } })
    assert.equal(result.padding, undefined)
    assert.deepEqual(await call('workbuddy_task_manage', 'write-once'), result)
    assert.equal(writes(), 1)
  })
})

test('JSON-RPC errors retain numeric codes and add recovery contract in data', async () => {
  await fixture(async ({ request }) => {
    for (const [body, headers, numeric, code] of [
      ['{invalid-json', {}, -32700, 'PARSE_ERROR'],
      [[], {}, -32600, 'INVALID_REQUEST'],
      [{ jsonrpc: '2.0', id: 1, method: 'missing/method' }, {}, -32601, 'METHOD_NOT_FOUND'],
    ]) {
      const response = await request(body, headers)
      assert.equal(response.json.error.code, numeric)
      contract(response.json.error.data, code)
      assert.equal(response.json.error.data.retryable, false)

    }
  })
})
