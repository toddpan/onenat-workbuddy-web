#!/usr/bin/env node
/** task-87: isolated HTTP / MCP / wbmcp.sh project and monitor query contract.
 * Build first: bash scripts/build-standalone.sh
 * Run: node scripts/project-monitor-regression.mjs
 * No production URL or credentials are read. Only a temporary data directory is written.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { scryptSync } from 'node:crypto'
import { existsSync, mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PREFIX = '/onenat-workbuddy'
const TOKEN = 'task87-isolated-token-0123456789abcdef'
const SCRIPT = join(ROOT, 'skills/workbuddy-mcp/scripts/wbmcp.sh')
const sections = ['kpi', 'agents', 'nodes', 'tasks', 'schedules', 'sshPool', 'alerts', 'events']
const compactProjectKeys = ['id', 'name', 'dshRef', 'defaultExecutionNodeRef', 'workspace', 'defaultAgentIds', 'taskCount']
const bytes = []
const results = []
let app, mock, dataDir, scriptTmpDir, base, appLog = '', rpcId = 0
let failures = 0
const wait = (ms) => new Promise((done) => setTimeout(done, ms))

function check(label, predicate, detail = '') {
  results.push({ label, ok: Boolean(predicate) })
  if (!predicate) failures++
  console.log(`${predicate ? 'PASS' : 'FAIL'} ${label}${!predicate && detail ? `: ${detail.slice(0, 700)}` : ''}`)
}
function record(label, wire, business) {
  bytes.push({ label, responseBytes: Buffer.byteLength(wire), businessBytes: Buffer.byteLength(JSON.stringify(business) || '') })
}
async function listen(server) {
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  return server.address().port
}
async function request(path, { method = 'GET', body, cookie, token = TOKEN, headers = {} } = {}) {
  const res = await fetch(base + PREFIX + path, {
    method, signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { /* a failed contract is reported by assertions */ }
  return { status: res.status, text, json, headers: res.headers }
}
async function login(username) {
  const response = await request('/api/auth/login', { method: 'POST', body: { username, password: 'isolated-password' }, token: '' })
  assert.equal(response.status, 200, `login ${username}: ${response.text}`)
  return response.headers.get('set-cookie').split(';')[0]
}
async function initialize(cookie) {
  const response = await request('/mcp', { method: 'POST', cookie, body: { jsonrpc: '2.0', id: ++rpcId, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'task87-regression', version: '1' } } } })
  assert.equal(response.status, 200)
  assert.ok(response.json?.result, response.text)
  return response.headers.get('mcp-session-id')
}
async function runScript(name, args) {
  return new Promise((done, reject) => {
    const child = spawn('bash', [SCRIPT, 'call', name, JSON.stringify(args)], {
      cwd: ROOT, env: { ...process.env, TMPDIR: scriptTmpDir, WORKBUDDY_CONFIG: join(dataDir, 'no-config'), WORKBUDDY_BASE_URL: base + PREFIX, WORKBUDDY_TOKEN: TOKEN, WORKBUDDY_TIMEOUT_SECONDS: '15' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', (part) => { stdout += part })
    child.stderr.on('data', (part) => { stderr += part })
    child.once('error', reject)
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000)
    child.once('close', (code) => {
      clearTimeout(timer)
      let result
      try { result = JSON.parse(stdout) } catch { /* assertions report invalid stdout */ }
      check(`script ${name} JSON / exit agreement`, Boolean(result) && (result.ok === false ? code > 0 : code === 0), `${code}: ${stdout} ${stderr}`)
      done({ result, text: stdout })
    })
  })
}
async function invoke(channel, name, args, session) {
  let result, text
  if (channel === 'script') ({ result, text } = await runScript(name, args))
  else if (channel === 'tool-http') {
    const response = await request(`/api/tools/${name}`, { method: 'POST', body: args })
    check(`tool-http ${name} transport`, response.status === 200 && response.json?.tool === name, response.text)
    result = response.json?.result; text = response.text
  } else {
    const response = await request('/mcp', { method: 'POST', headers: { 'Mcp-Session-Id': session }, body: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } } })
    const envelope = response.json?.result
    try { result = JSON.parse(envelope?.content?.[0]?.text) } catch { /* assertion below */ }
    check(`mcp ${name} transport / isError`, response.status === 200 && Boolean(result) && envelope.isError === (result.ok === false), response.text)
    text = response.text
  }
  record(`${channel} ${name} ${JSON.stringify(args)}`, text || '', result)
  return result
}
function pageCheck(label, value, list, { total, offset, limit, count, more }) {
  check(label, value?.ok === true && Array.isArray(list) && list.length === count && value.total === total && value.offset === offset && value.limit === limit && value.returnedCount === count && value.hasMore === more && value.nextOffset === (more ? offset + count : null) && value.truncated === (more || offset > 0), JSON.stringify(value))
}
function projectCompact(label, projects) {
  check(label, projects?.every((project) => compactProjectKeys.every((key) => Object.hasOwn(project, key)) && Object.keys(project).every((key) => compactProjectKeys.includes(key))) === true, JSON.stringify(projects))
}
function fixture(mockPort) {
  const now = Date.now()
  const dshRef = { kind: 'direct', apiBaseUrl: `http://127.0.0.1:${mockPort}` }
  const agents = Array.from({ length: 19 }, (_, i) => ({ id: `a${String(i).padStart(2, '0')}`, name: `Agent ${String(i).padStart(2, '0')}`, dshRef, resources: [], enabled: true, systemPrompt: 'FIXTURE_PRIVATE_PROMPT '.repeat(100), createdAt: now, updatedAt: now }))
  const projects = Array.from({ length: 28 }, (_, i) => ({
    id: `p${String(i).padStart(2, '0')}`, name: `${i < 5 ? 'Alpha' : 'Beta'} project ${String(i).padStart(2, '0')}`,
    dshRef, defaultExecutionNodeRef: dshRef, workspace: `/fixture/${i < 5 ? 'alpha' : 'beta'}/p${String(i).padStart(2, '0')}`,
    instruction: 'FIXTURE_PRIVATE_INSTRUCTION '.repeat(200), defaultAgentIds: i === 0 ? ['a00', 'a01'] : [agents[i % 19].id], expertIds: [], connectorIds: [], skillNames: [],
    owner: 'usr-admin', visibility: 'private', projectMembers: [{ userId: 'usr-admin', role: 'owner', joinedAt: now }, ...(i === 0 ? [{ userId: 'usr-user', role: 'member', joinedAt: now }] : [])], createdAt: now + i, updatedAt: now + i,
  }))
  const tasks = projects.flatMap((project) => Array.from({ length: 3 }, (_, i) => ({ id: `${project.id}-t${i}`, title: `${project.id} draft ${i}`, mode: 'chat', status: 'draft', memberAgentIds: project.defaultAgentIds, projectId: project.id, nodeRef: dshRef, sessions: {}, turns: [], createdAt: now + i, updatedAt: now + i })))
  writeFileSync(join(dataDir, 'store.json'), JSON.stringify({ agents, projects, tasks, schedules: [], teams: [], settings: { onenat: { baseUrl: `http://127.0.0.1:${mockPort}`, apiKey: 'isolated-mock', autoRefreshMs: 60000 }, planner: {}, xiaozhi: {}, archive: { taskArchiveDays: 7 } } }))
  writeFileSync(join(dataDir, 'auth.json'), JSON.stringify({ users: ['admin', 'user'].map((role) => {
    const salt = `task87-${role}-salt`
    return { id: `usr-${role}`, username: role, role, status: 'active', salt, hash: scryptSync('isolated-password', salt, 64).toString('hex'), createdAt: now }
  }) }))
}

async function main() {
  assert.ok(existsSync(join(ROOT, 'dist/server.js')), 'Build first: bash scripts/build-standalone.sh')
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'wb-project-monitor-regression-')))
  // Keep wbmcp.sh's fixed session filename isolated from other tests/users.
  scriptTmpDir = mkdtempSync(join(dataDir, 'script-tmp-'))
  mock = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    const path = new URL(req.url, 'http://localhost').pathname
    const data = path === '/api/v1/resources' ? { tunnels: [] } : path === '/healthz' ? { ok: true } : { ok: true, data: [], models: [], presets: [] }
    res.end(JSON.stringify(data))
  })
  const mockPort = await listen(mock)
  fixture(mockPort)
  const reservation = createServer()
  const port = await listen(reservation)
  await new Promise((done) => reservation.close(done))
  base = `http://127.0.0.1:${port}`
  app = spawn(process.execPath, [join(ROOT, 'dist/server.js'), '--port', String(port), '--data', dataDir, '--token', TOKEN, '--onenat-base-url', `http://127.0.0.1:${mockPort}`, '--onenat-api-key', 'isolated-mock', '--quiet'], {
    cwd: ROOT, env: { ...process.env, WORKBUDDY_HOME: dataDir, WORKBUDDY_TOKEN: TOKEN, ONENAT_BASE_URL: `http://127.0.0.1:${mockPort}`, ONENAT_API_KEY: 'isolated-mock' }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  app.stdout.on('data', (part) => { appLog += part })
  app.stderr.on('data', (part) => { appLog += part })
  const deadline = Date.now() + 30000
  let ready = false
  while (Date.now() < deadline && app.exitCode === null) {
    try { ready = (await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) })).ok } catch { /* startup */ }
    if (ready) break
    await wait(150)
  }
  assert.ok(ready, `isolated server did not start: ${appLog}`)
  console.log(`Isolated fixture: 28 projects / 19 agents / 84 draft tasks; ${base}; data=${dataDir}`)
  const session = await initialize()
  const adminCookie = await login('admin')
  const userCookie = await login('user')
  const tools = await request('/mcp', { method: 'POST', headers: { 'Mcp-Session-Id': session }, body: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/list' } })
  record('MCP tools/list', tools.text, tools.json?.result)
  const definitions = tools.json?.result?.tools || []
  check('tools/list advertises query parameters', ['name', 'workspace', 'keyword', 'limit', 'offset', 'compact'].every((key) => definitions.find((t) => t.name === 'workbuddy_project_manage')?.inputSchema?.properties?.[key]) && ['projectId', 'section', 'compact', 'limit'].every((key) => definitions.find((t) => t.name === 'workbuddy_monitor_read')?.inputSchema?.properties?.[key]))

  const serviceProjects = await request('/api/projects?limit=20')
  check('service-token HTTP projects preserves existing private-project visibility', serviceProjects.json?.total === 0 && serviceProjects.json?.data?.length === 0, serviceProjects.text)
  const legacyProjects = await request('/api/projects', { cookie: adminCookie })
  record('HTTP projects legacy', legacyProjects.text, legacyProjects.json)
  check('HTTP projects no query preserves all 28 full records', legacyProjects.json?.data?.length === 28 && legacyProjects.json.data.every((p) => typeof p.instruction === 'string'))
  const httpCases = [
    ['name=Alpha&compact=true&limit=2&offset=2', { total: 5, offset: 2, limit: 2, count: 2, more: true }],
    ['workspace=%2Ffixture%2Falpha&limit=10', { total: 5, offset: 0, limit: 10, count: 5, more: false }],
    ['keyword=does-not-exist&limit=5', { total: 0, offset: 0, limit: 5, count: 0, more: false }],
    ['limit=20&offset=20', { total: 28, offset: 20, limit: 20, count: 8, more: false }],
    ['limit=20&offset=99', { total: 28, offset: 99, limit: 20, count: 0, more: false }],
  ]
  for (const [query, expected] of httpCases) {
    const response = await request(`/api/projects?${query}`, { cookie: adminCookie })
    pageCheck(`HTTP project ${query}`, response.json, response.json?.data, expected)
    if (query.includes('compact=true')) projectCompact('HTTP project compact exact fields', response.json?.data)
  }
  for (const channel of ['tool-http', 'mcp', 'script']) {
    const project = (args) => invoke(channel, 'workbuddy_project_manage', { action: 'list', ...args }, session)
    const defaultPage = await project({})
    pageCheck(`${channel} project default bounded page`, defaultPage, defaultPage?.projects, { total: 28, offset: 0, limit: 20, count: 20, more: true })
    const filtered = await project({ name: 'Alpha', workspace: '/fixture/alpha', keyword: 'project', compact: true, limit: 2, offset: 2 })
    pageCheck(`${channel} project combined filters/page`, filtered, filtered?.projects, { total: 5, offset: 2, limit: 2, count: 2, more: true })
    projectCompact(`${channel} project compact exact fields`, filtered?.projects)
    check(`${channel} project compact omission disclosure`, Array.isArray(filtered?.omittedFields) && filtered.omittedFields.includes('instruction') && Boolean(filtered.detailAction), JSON.stringify(filtered))
    const empty = await project({ keyword: 'does-not-exist' })
    pageCheck(`${channel} project no match`, empty, empty?.projects, { total: 0, offset: 0, limit: 20, count: 0, more: false })
    const outside = await project({ limit: 20, offset: 99 })
    pageCheck(`${channel} project offset beyond end`, outside, outside?.projects, { total: 28, offset: 99, limit: 20, count: 0, more: false })
    const fullProject = await project({ name: 'Alpha project 00', compact: false })
    check(`${channel} project full mode preserves legacy summary fields`, fullProject?.projects?.length === 1 && typeof fullProject.projects[0].nodeTitle === 'string' && Array.isArray(fullProject.projects[0].experts) && Array.isArray(fullProject.projects[0].skillNames) && Array.isArray(fullProject.projects[0].connectorIds), JSON.stringify(fullProject).slice(0, 500))
    const last = await project({ limit: 20, offset: 20 })
    pageCheck(`${channel} project final page`, last, last?.projects, { total: 28, offset: 20, limit: 20, count: 8, more: false })
    const maximum = await project({ limit: 200 })
    check(`${channel} project maximum 200 accepted`, maximum?.ok === true && maximum.projects?.length === 28 && maximum.limit === 200)
    for (const args of [{ limit: 0 }, { limit: 201 }, { limit: 1.5 }, { offset: -1 }, { compact: 'invalid' }]) {
      const invalid = await project(args)
      check(`${channel} project invalid ${JSON.stringify(args)}`, invalid?.ok === false && invalid.code === 'INVALID_PARAM' && invalid.legacyCode === 'INVALID_PARAMS' && invalid.status === 400, JSON.stringify(invalid))
    }
    const overview = (args) => invoke(channel, 'workbuddy_monitor_read', { action: 'overview', ...args }, session)
    const normal = await overview({})
    check(`${channel} monitor defaults compact`, normal?.ok === true && normal.metadata?.compact === true, JSON.stringify(normal).slice(0, 400))
    const scoped = await overview({ projectId: 'p00', section: 'agents,tasks', compact: true, limit: 2 })
    checkMonitor(`${channel} monitor scoped/capped`, scoped)
    const small = await overview({ projectId: 'p00', section: 'agents,tasks', compact: true })
    check(`${channel} single-project compact business target <2048 bytes`, Buffer.byteLength(JSON.stringify(small)) < 2048, `${Buffer.byteLength(JSON.stringify(small))} bytes`)
    const missing = await overview({ projectId: 'missing-project', section: 'tasks' })
    check(`${channel} unknown project fails 404`, missing?.ok === false && missing.status === 404, JSON.stringify(missing))
    for (const args of [{ section: 'invalid' }, { limit: 0 }, { limit: 201 }, { compact: 'invalid' }]) {
      const invalid = await overview(args)
      check(`${channel} monitor invalid ${JSON.stringify(args)}`, invalid?.ok === false && invalid.code === 'INVALID_PARAM' && invalid.legacyCode === 'INVALID_PARAMS' && invalid.status === 400, JSON.stringify(invalid))
    }
  }
  const legacy = await request('/api/monitor/overview')
  record('HTTP monitor legacy full', legacy.text, legacy.json)
  check('HTTP monitor no query preserves full sections/19 agents', legacy.json?.data?.agents?.length === 19 && sections.every((key) => Object.hasOwn(legacy.json.data, key)) && legacy.json.data.agents.every((a) => Array.isArray(a.resources)))
  const scoped = await request('/api/monitor/overview?projectId=p00&section=agents,tasks&compact=true&limit=2')
  record('HTTP monitor scoped compact', scoped.text, scoped.json)
  checkMonitor('HTTP monitor scoped/capped', scoped.json?.data)
  const smallHttp = await request('/api/monitor/overview?projectId=p00&section=agents,tasks&compact=true')
  record('HTTP monitor single-project compact common', smallHttp.text, smallHttp.json)
  check('HTTP single-project compact response target <2048 bytes', Buffer.byteLength(smallHttp.text) < 2048, `${Buffer.byteLength(smallHttp.text)} bytes`)
  for (const path of ['/api/projects?limit=0', '/api/projects?offset=-1', '/api/projects?compact=nope', '/api/monitor/overview?section=invalid', '/api/monitor/overview?limit=0', '/api/monitor/overview?compact=nope']) {
    const invalid = await request(path)
    check(`HTTP invalid ${path}`, invalid.status === 400 && invalid.json?.ok === false, invalid.text)
  }
  const missing = await request('/api/monitor/overview?projectId=missing-project')
  check('HTTP monitor missing project 404', missing.status === 404, missing.text)
  const userProjects = await request('/api/projects?compact=true&limit=20', { cookie: userCookie })
  pageCheck('ordinary user project pagination counts only visible project', userProjects.json, userProjects.json?.data, { total: 1, offset: 0, limit: 20, count: 1, more: false })
  const hidden = await request('/api/projects?name=Beta&limit=20', { cookie: userCookie })
  pageCheck('ordinary user cannot discover private projects via filter', hidden.json, hidden.json?.data, { total: 0, offset: 0, limit: 20, count: 0, more: false })
  for (const query of ['', '?projectId=p00&section=agents,tasks&compact=true', '?projectId=p01&section=tasks']) {
    const denied = await request(`/api/monitor/overview${query}`, { cookie: userCookie })
    check(`ordinary user monitor HTTP remains 403 ${query}`, denied.status === 403, denied.text)
  }
  const deniedTool = await request('/api/tools/workbuddy_monitor_read', { method: 'POST', cookie: userCookie, body: { action: 'overview', projectId: 'p00', section: 'agents,tasks' } })
  check('ordinary user monitor HTTP tool remains forbidden', deniedTool.status === 403 || deniedTool.json?.result?.ok === false && deniedTool.json.result.status === 403, deniedTool.text)
  const userSession = await initialize(userCookie)
  const deniedMcp = await request('/mcp', { method: 'POST', cookie: userCookie, headers: { 'Mcp-Session-Id': userSession }, body: { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'workbuddy_monitor_read', arguments: { action: 'overview', projectId: 'p00', section: 'tasks' } } } })
  let denial
  try { denial = JSON.parse(deniedMcp.json?.result?.content?.[0]?.text) } catch { /* assertion */ }
  check('ordinary user monitor MCP tool remains forbidden', deniedMcp.status === 403 || denial?.ok === false && denial.status === 403, deniedMcp.text)
  const admin = await request('/api/monitor/overview?projectId=p00&section=tasks&compact=false', { cookie: adminCookie })
  check('admin session monitor remains authorized', admin.status === 200 && admin.json?.data?.tasks?.length === 3, admin.text)
}
function checkMonitor(label, overview) {
  const meta = overview?.metadata
  check(label, overview?.agents?.length === 2 && overview?.tasks?.length === 2 && overview.agents.every((a) => ['a00', 'a01'].includes(a.id)) && overview.tasks.every((t) => t.id.startsWith('p00-')) && sections.filter((s) => !['agents', 'tasks'].includes(s)).every((s) => !Object.hasOwn(overview, s)) && meta?.projectId === 'p00' && meta?.compact === true && meta?.limit === 2 && meta?.sections?.tasks?.total === 3 && meta.sections.tasks.returned === 2 && meta.sections.tasks.hasMore === true && Array.isArray(meta.truncatedFields) && Array.isArray(meta.omittedFields) && meta.omittedFields.length > 0, JSON.stringify(overview))
}
async function cleanup() {
  if (app && app.exitCode === null) {
    app.kill('SIGTERM')
    await Promise.race([new Promise((done) => app.once('exit', done)), wait(2000)])
    if (app.exitCode === null) { app.kill('SIGKILL'); await new Promise((done) => app.once('exit', done)) }
  }
  if (mock?.listening) await new Promise((done) => mock.close(done))
  // Verify the absolute target is the exact temporary directory created by this run.
  if (dataDir && resolve(dataDir) === dataDir && realpathSync(dataDir) === dataDir && dirname(dataDir) === realpathSync(tmpdir()) && dataDir.includes('/wb-project-monitor-regression-')) rmSync(dataDir, { recursive: true, force: true })
}
main().catch((error) => { failures++; console.error(error.stack || error); console.error(appLog.slice(-5000)) }).finally(async () => {
  console.log('\nResponse bytes (UTF-8; wire includes transport envelope; business is compact JSON):')
  for (const row of bytes) console.log(JSON.stringify(row))
  console.log(`\n${results.length - results.filter((r) => !r.ok).length}/${results.length} assertions passed; failures=${failures}`)
  await cleanup()
  process.exitCode = failures ? 1 : 0
})
