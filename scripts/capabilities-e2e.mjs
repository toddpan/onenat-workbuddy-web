#!/usr/bin/env node
/** task-88: isolated capability/read-only integration checks. Build first, then run this file. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.CAPABILITIES_PORT || 18196)
const MOCK_PORT = Number(process.env.CAPABILITIES_MOCK_PORT || 18197)
const PREFIX = '/onenat-workbuddy'
const BASE = `http://127.0.0.1:${PORT}${PREFIX}`
const TOKEN = 'capabilities-e2e-normal-token-0123456789'
const READONLY_TOKEN = 'capabilities-e2e-readonly-token-9876543210'
let app
let appLog = ''
let home
let checks = 0
let rpcId = 0
const sessions = []
const outputSchemas = new Map()
// Validate the JSON Schema keywords used by the public output envelope, not just field presence.
function validateOutput(schema, value, path = '$') {
  assert.ok(schema && typeof schema === 'object', `${path}: missing output schema`)
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
  if (schema.type) assert.ok((Array.isArray(schema.type) ? schema.type : [schema.type]).includes(type), `${path}: expected ${schema.type}, got ${type}`)
  if (schema.enum) assert.ok(schema.enum.some(entry => JSON.stringify(entry) === JSON.stringify(value)), `${path}: invalid enum`)
  if (type === 'object') {
    for (const key of schema.required || []) assert.ok(Object.hasOwn(value, key), `${path}.${key}: missing required property`)
    for (const [key, entry] of Object.entries(value)) {
      if (schema.properties?.[key]) validateOutput(schema.properties[key], entry, `${path}.${key}`)
      else if (schema.additionalProperties === false) assert.fail(`${path}.${key}: unexpected property`)
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') validateOutput(schema.additionalProperties, entry, `${path}.${key}`)
    }
  }
  if (type === 'array' && schema.items) value.forEach((entry, index) => validateOutput(schema.items, entry, `${path}[${index}]`))
}
function checkStructured(name, structured, original) {
  validateOutput(outputSchemas.get(name), structured)
  check(`${name} structured envelope validates against published outputSchema`, typeof structured.contractVersion === 'string' && structured.ok === (original.ok !== false))
  check(`${name} structured data preserves legacy result`, JSON.stringify(structured.data) === JSON.stringify(original))
}
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms))
const check = (label, condition, detail = '') => {
  assert.ok(condition, `${label}${detail ? `: ${detail}` : ''}`)
  console.log(`PASS ${label}`)
  checks++
}

// Intentionally no real DSH/SSH endpoints: no test may reach a developer's remote node.
const mock = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (req.headers.authorization !== 'Bearer capabilities-mock-key') {
    res.writeHead(403)
    return res.end(JSON.stringify({ error: 'mock authentication required' }))
  }
  if (req.url === '/api/v1/resources') return res.end(JSON.stringify({ base_url: `http://127.0.0.1:${MOCK_PORT}`, tunnels: [] }))
  if (req.url === '/api/v1/apps') return res.end(JSON.stringify({ ok: true, data: [] }))
  res.writeHead(404)
  res.end(JSON.stringify({ error: 'isolated mock: no remote resources' }))
})

async function request(token, method, path, body, extraHeaders = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method, redirect: 'manual', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let json
  try { json = JSON.parse(text) } catch { /* fail at the assertion with the original response */ }
  return { status: response.status, json, text, headers: response.headers }
}
async function rpc(token, session, method, params, id = ++rpcId) {
  return request(token, 'POST', '/mcp', { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }, session ? { 'Mcp-Session-Id': session } : {})
}
async function initialize(token) {
  const response = await rpc(token, undefined, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'capabilities-e2e', version: '1' } })
  const session = response.headers.get('mcp-session-id')
  check('MCP initialize succeeds', response.status === 200 && response.json?.result?.serverInfo && session)
  sessions.push({ token, session })
  return session
}
async function invoke(channel, token, session, name, args, id) {
  if (channel === 'http') {
    const response = await request(token, 'POST', `/api/tools/${name}`, args)
    check(`HTTP ${name} returns tool envelope`, response.status === 200 && response.json?.tool === name, response.text.slice(0, 300))
    checkStructured(name, response.json.structuredContent, response.json.result)
    return response.json.result
  }
  const response = await rpc(token, session, 'tools/call', { name, arguments: args }, id)
  const envelope = response.json?.result
  const content = envelope?.content?.find(part => part.type === 'text')
  let parsed
  try { parsed = JSON.parse(content?.text || '') } catch { /* assertion below */ }
  check(`MCP ${name} retains JSON text compatibility`, response.status === 200 && parsed && content.type === 'text', response.text.slice(0, 300))
  checkStructured(name, envelope.structuredContent, parsed)
  check(`MCP ${name} isError matches business status`, envelope.isError === (parsed.ok === false))
  return parsed
}
const action = (capabilities, name, value) => capabilities.tools?.find(tool => tool.name === name)?.actions?.find(entry => entry.action === value)

async function main() {
  assert.ok(existsSync(join(ROOT, 'dist/server.js')), 'Build first: npm run build')
  await new Promise((resolveListen, reject) => { mock.once('error', reject); mock.listen(MOCK_PORT, '127.0.0.1', resolveListen) })
  home = realpathSync(mkdtempSync(join(tmpdir(), 'wb-capabilities-e2e-')))
  app = spawn(process.execPath, [join(ROOT, 'dist/server.js'), '--port', String(PORT), '--quiet'], {
    cwd: ROOT,
    env: { ...process.env, WORKBUDDY_HOME: home, WORKBUDDY_TOKEN: TOKEN, WORKBUDDY_READONLY_TOKEN: READONLY_TOKEN, ONENAT_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, ONENAT_API_KEY: 'capabilities-mock-key' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  app.stdout.on('data', chunk => { appLog = (appLog + chunk).slice(-24000) })
  app.stderr.on('data', chunk => { appLog = (appLog + chunk).slice(-24000) })
  let startupError
  app.once('error', error => { startupError = error })
  const deadline = Date.now() + 25000
  let ready = false
  while (Date.now() < deadline) {
    if (startupError) throw startupError
    assert.equal(app.exitCode, null, 'test server exited before startup')
    try {
      const response = await request(TOKEN, 'GET', '/api/tools')
      if (response.status === 200 && Array.isArray(response.json?.tools)) { ready = true; break }
    } catch { /* startup */ }
    await delay(150)
  }
  assert.ok(ready, 'server startup timed out')
  const published = await request(TOKEN, 'GET', '/api/tools')
  for (const tool of published.json?.tools || []) outputSchemas.set(tool.name, tool.outputSchema)
  check('published output schemas are available for validating every invocation', outputSchemas.size >= 17)
  const normalSession = await initialize(TOKEN)
  const readonlySession = await initialize(READONLY_TOKEN)
  let draftId
  for (const channel of ['http', 'mcp']) {
    const normal = await invoke(channel, TOKEN, normalSession, 'workbuddy_capabilities', {})
    const readonly = await invoke(channel, READONLY_TOKEN, readonlySession, 'workbuddy_capabilities', {})
    check(`${channel} discovery has versions, identity, limits and waiting`, normal.ok === true && normal.contractVersion && normal.knowledgeVersion && normal.serverVersion && normal.identity?.type === 'ai-token' && normal.limits?.mcpResultBytes > 0 && normal.waiting?.channel === channel)
    check(`${channel} readonly capability identity is trusted`, readonly.identity?.type === 'read-only-experience' && readonly.policy?.readOnly === true)
    check(`${channel} capability explains object ACL ceiling`, /ACL|object/i.test(readonly.policy?.authorization || ''))
    check(`${channel} readonly create ceiling denied, ordinary AI unchanged`, action(readonly, 'workbuddy_task_manage', 'create')?.allowed === false && action(normal, 'workbuddy_task_manage', 'create')?.allowed === true)
    check(`${channel} SSH exec denied for both tokens`, action(normal, 'workbuddy_ssh_resource_manage', 'exec')?.allowed === false && action(readonly, 'workbuddy_ssh_resource_manage', 'exec')?.allowed === false)
    check(`${channel} wait remains readable`, action(readonly, 'workbuddy_task_manage', 'wait')?.allowed === true)
    const resource = readonly.resources?.[0]
    check(`${channel} capability exposes versioned operation resources`, typeof resource?.uri === 'string' && Boolean(resource.name))
    const knowledge = await invoke(channel, READONLY_TOKEN, readonlySession, 'workbuddy_capabilities', { resource: resource.uri })
    check(`${channel} operation resource readable without execution`, knowledge.ok === true && knowledge.resource?.uri === resource.uri && typeof knowledge.resource?.text === 'string')
    const draft = await invoke(channel, TOKEN, normalSession, 'workbuddy_task_manage', { action: 'create', title: `task-88 ${channel} isolated draft`, memberAgentIds: [] })
    check(`${channel} ordinary AI can create non-running draft`, draft.ok === true && draft.status === 'draft' && draft.running === false && typeof draft.taskId === 'string')
    draftId ||= draft.taskId
    const attempts = [
      ['task create', 'workbuddy_task_manage', { action: 'create', title: 'readonly forbidden draft', memberAgentIds: [] }],
      ['chat followup', 'workbuddy_task_chat', { taskId: draftId, followupMessage: 'never execute' }],
      ['restore question', 'workbuddy_task_ask_answer', { taskId: draftId, answers: [{ id: 'nonexistent', selected: ['yes'] }] }],
      ['SSH exec', 'workbuddy_ssh_resource_manage', { action: 'exec', resourceId: 'nonexistent', command: 'true' }],
      ['upload', 'workbuddy_file_manage', { action: 'upload', taskId: draftId, name: 'never.txt', contentBase64: 'bmV2ZXI=' }],
      ['refresh', 'workbuddy_resource_manage', { action: 'refresh' }],
      ['forged context', 'workbuddy_task_manage', { action: 'create', title: 'readonly forged context', memberAgentIds: [], readOnly: false, aiTokenOnly: false, session: { role: 'admin' } }],
    ]
    for (const [label, name, args] of attempts) {
      const denied = await invoke(channel, READONLY_TOKEN, readonlySession, name, args)
      check(`${channel} readonly ${label} denied before business action`, denied.ok === false && denied.code === 'PERMISSION_DENIED', JSON.stringify(denied).slice(0, 300))
    }
    const malformed = await invoke(channel, TOKEN, normalSession, 'workbuddy_task_manage', { action: 'create', memberAgentIds: {} })
    check(`${channel} structured schema rejects object instead of array`, malformed.ok === false && Array.isArray(malformed.errors) && malformed.errors.some(error => error.path === 'memberAgentIds'))
  }

  const httpList = await request(READONLY_TOKEN, 'GET', '/api/tools')
  const mcpList = await rpc(READONLY_TOKEN, readonlySession, 'tools/list')
  const tools = mcpList.json?.result?.tools || []
  check('HTTP and MCP publish matching input/output schemas and annotations', tools.length > 0 && tools.length === httpList.json?.tools?.length && tools.every(tool => {
    const http = httpList.json.tools.find(candidate => candidate.name === tool.name)
    return tool.inputSchema?.type === 'object' && tool.outputSchema?.type === 'object' && typeof tool.annotations?.readOnlyHint === 'boolean' && JSON.stringify(http?.inputSchema) === JSON.stringify(tool.inputSchema) && JSON.stringify(http?.outputSchema) === JSON.stringify(tool.outputSchema) && JSON.stringify(http?.annotations) === JSON.stringify(tool.annotations)
  }))
  check('task member IDs publish native array schema', tools.find(tool => tool.name === 'workbuddy_task_manage')?.inputSchema?.properties?.memberAgentIds?.items?.type === 'string')
  const resources = await rpc(READONLY_TOKEN, readonlySession, 'resources/list')
  const resource = resources.json?.result?.resources?.[0]
  check('MCP resources/list exposes operation knowledge', typeof resource?.uri === 'string')
  const readResource = await rpc(READONLY_TOKEN, readonlySession, 'resources/read', { uri: resource.uri })
  check('MCP resources/read returns text', readResource.json?.result?.contents?.[0]?.uri === resource.uri && typeof readResource.json.result.contents[0].text === 'string')

  for (const path of ['/api/tasks', '/api/schedules', '/api/planner']) {
    const denied = await request(READONLY_TOKEN, 'POST', path, { title: 'readonly REST bypass', model: 'never' }, { 'X-WorkBuddy-ReadOnly': 'false' })
    check(`readonly REST bypass ${path} denied`, denied.status === 403)
  }
  const logoutDenied = await request(READONLY_TOKEN, 'POST', '/api/auth/logout', {})
  check('readonly auth/logout denied before public auth route', logoutDenied.status === 403)
  const login = await request(TOKEN, 'POST', '/api/auth/login', { username: 'workbuddy', password: 'workbuddy-admin' })
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0]
  check('isolated administrator login yields console cookie', login.status === 200 && login.json?.ok === true && cookie.includes('='))
  const mixedCapability = await request(READONLY_TOKEN, 'POST', '/api/tools/workbuddy_capabilities', {}, { Cookie: cookie })
  checkStructured('workbuddy_capabilities', mixedCapability.json?.structuredContent, mixedCapability.json?.result)
  check('administrator cookie cannot override readonly capability identity', mixedCapability.json?.result?.identity?.type === 'read-only-experience' && mixedCapability.json?.result?.policy?.readOnly === true)
  const mixedCreate = await request(READONLY_TOKEN, 'POST', '/api/tools/workbuddy_task_manage', { action: 'create', title: 'forbidden cookie override', memberAgentIds: [] }, { Cookie: cookie })
  checkStructured('workbuddy_task_manage', mixedCreate.json?.structuredContent, mixedCreate.json?.result)
  check('administrator cookie plus readonly token still cannot create task', mixedCreate.status === 200 && mixedCreate.json?.result?.ok === false && mixedCreate.json?.result?.code === 'PERMISSION_DENIED')
  // The same mixed credentials must remain attenuated on MCP, including an existing admin-capable session.
  const mixedMcpCapability = await request(READONLY_TOKEN, 'POST', '/mcp', { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'workbuddy_capabilities', arguments: {} } }, { Cookie: cookie, 'Mcp-Session-Id': normalSession })
  const mixedMcp = mixedMcpCapability.json?.result?.structuredContent
  validateOutput(outputSchemas.get('workbuddy_capabilities'), mixedMcp)
  check('MCP administrator cookie cannot override readonly identity', mixedMcp.data?.identity?.type === 'read-only-experience' && mixedMcp.data?.policy?.readOnly === true)
  const mixedMcpCreate = await request(READONLY_TOKEN, 'POST', '/mcp', { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'workbuddy_task_manage', arguments: { action: 'create', title: 'forbidden MCP cookie override', memberAgentIds: [] } } }, { Cookie: cookie, 'Mcp-Session-Id': normalSession })
  const mixedMcpDenied = mixedMcpCreate.json?.result?.structuredContent
  validateOutput(outputSchemas.get('workbuddy_task_manage'), mixedMcpDenied)
  check('MCP administrator cookie plus readonly token cannot create task', mixedMcpCreate.json?.result?.isError === true && mixedMcpDenied.data?.code === 'PERMISSION_DENIED')
  const replayArgs = { action: 'create', title: 'task-88 replay isolation draft', memberAgentIds: [] }
  const first = await invoke('mcp', TOKEN, normalSession, 'workbuddy_task_manage', replayArgs, 'same-principal-switch-rpc')
  check('ordinary MCP write primes replay entry', first.ok === true && first.status === 'draft')
  const before = await request(TOKEN, 'GET', '/api/mcp/status')
  const deniedReplay = await invoke('mcp', READONLY_TOKEN, normalSession, 'workbuddy_task_manage', replayArgs, 'same-principal-switch-rpc')
  const after = await request(TOKEN, 'GET', '/api/mcp/status')
  check('same MCP session/rpc/arguments cannot replay success across readonly boundary', deniedReplay.ok === false && deniedReplay.code === 'PERMISSION_DENIED')
  check('readonly denied replay does not increment replay hits', typeof before.json?.mcp?.replays === 'number' && before.json.mcp.replays === after.json?.mcp?.replays)
  const tasks = await invoke('http', TOKEN, normalSession, 'workbuddy_task_status', {})
  check('only three authorized drafts exist; no readonly writes or remote execution', tasks.ok === true && tasks.tasks?.length === 3 && tasks.tasks.every(task => task.status === 'draft' && task.running === false))
  console.log(`\nCapabilities E2E: ${checks} checks passed`)
}

async function cleanup() {
  for (const entry of sessions) {
    try { await request(entry.token, 'DELETE', '/mcp', undefined, { 'Mcp-Session-Id': entry.session }) } catch { /* server may already be gone */ }
  }
  if (app && app.exitCode === null) {
    const closed = once(app, 'close').catch(() => {})
    app.kill('SIGTERM')
    const timer = setTimeout(() => app.kill('SIGKILL'), 2000)
    await closed
    clearTimeout(timer)
  }
  if (mock.listening) await new Promise(resolveClose => mock.close(resolveClose))
  // Delete only the canonical temporary directory this invocation created.
  if (home) {
    const parent = realpathSync(tmpdir())
    assert.equal(dirname(home), parent)
    assert.ok(home.startsWith(join(parent, 'wb-capabilities-e2e-')))
    rmSync(home, { recursive: true, force: true })
  }
}
main().catch(error => {
  console.error(error.stack || error)
  console.error(`Service log (tail):\n${appLog.slice(-12000)}`)
  process.exitCode = 1
}).finally(cleanup)
