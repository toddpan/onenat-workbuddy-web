#!/usr/bin/env node
/** task-92 HTTP contract regression. Build separately, then: node scripts/bot-display-e2e.mjs */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.BOT_DISPLAY_E2E_PORT || 18099)
const PREFIX = '/onenat-workbuddy/api'
const BASE = `http://127.0.0.1:${PORT}`
const REF = { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:1' }
const results = []
let failures = 0
let child
let dataDir
let verifiedDataDir
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const equal = (a, b) => { try { assert.deepStrictEqual(a, b); return true } catch { return false } }
function check(name, condition, detail = '') {
  if (!condition) failures++
  const line = `${condition ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`
  results.push(line)
  console.log(line)
}
function requireOk(response, name, status = 200) {
  assert.equal(response.status, status, `${name}: HTTP ${response.status}`)
  assert.equal(response.json?.ok, true, `${name}: ${JSON.stringify(response.json)}`)
  return response.json.data
}
async function request(method, path, body, cookie = '') {
  const response = await fetch(`${BASE}${PREFIX}${path}`, {
    method, redirect: 'manual', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json
  try { json = JSON.parse(text) } catch { /* assertion reports non-JSON response */ }
  return { status: response.status, json, cookie: (response.headers.get('set-cookie') || '').split(';')[0] }
}
async function portAvailable() {
  assert.ok(Number.isInteger(PORT) && PORT > 0 && PORT <= 65535, 'Invalid BOT_DISPLAY_E2E_PORT')
  const probe = createServer()
  await new Promise((resolveReady, reject) => {
    probe.once('error', reject)
    probe.listen(PORT, '127.0.0.1', resolveReady)
  })
  await new Promise((resolveClosed, reject) => probe.close((error) => error ? reject(error) : resolveClosed()))
}
async function start() {
  await portAvailable()
  child = spawn(process.execPath, [join(ROOT, 'dist/server.js'), '--port', String(PORT), '--data', dataDir, '--quiet'], {
    cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let spawnError
  child.once('error', (error) => { spawnError = error })
  child.stdout.on('data', (data) => { if (process.env.VERBOSE) console.log(`[server] ${data}`) })
  child.stderr.on('data', (data) => { if (process.env.VERBOSE) console.error(`[server] ${data}`) })
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError
    assert.equal(child.exitCode, null, 'Test server exited before readiness')
    try {
      if ((await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) return
    } catch { /* retry until ready */ }
    await pause(100)
  }
  throw new Error('Test server did not become ready within 20 seconds')
}
async function cleanup() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, 'exit')
    child.kill('SIGKILL')
    await stopped
  }
  // Only remove the exact mkdtemp directory whose absolute real path we checked at creation.
  if (dataDir && verifiedDataDir && existsSync(dataDir) && realpathSync(dataDir) === verifiedDataDir) {
    rmSync(verifiedDataDir, { recursive: true, force: true })
  }
}
const store = () => JSON.parse(readFileSync(join(dataDir, 'store.json'), 'utf8'))
async function persisted(name, predicate) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try { if (predicate(store())) { check(name, true); return } } catch { /* pending atomic save */ }
    await pause(50)
  }
  check(name, false, 'store.json did not match within 5 seconds')
}
function projection(name, profile) {
  const shape = profile && equal(Object.keys(profile).sort(), ['description', 'display', 'id', 'name'])
    && typeof profile.id === 'string' && typeof profile.name === 'string' && typeof profile.description === 'string'
    && profile.display && equal(Object.keys(profile.display).sort(), ['expertise', 'quickActions', 'welcomeMessage'])
    && typeof profile.display.expertise === 'string' && typeof profile.display.welcomeMessage === 'string'
    && Array.isArray(profile.display.quickActions)
    && profile.display.quickActions.every((a) => a && equal(Object.keys(a).sort(), ['label', 'text'])
      && typeof a.label === 'string' && typeof a.text === 'string')
  check(name, Boolean(shape), shape ? '' : JSON.stringify(profile))
}
async function main() {
  assert.ok(existsSync(join(ROOT, 'dist/server.js')), 'Missing dist/server.js; ask the main agent to build first')
  dataDir = mkdtempSync(join(tmpdir(), 'wb-bot-display-'))
  verifiedDataDir = realpathSync(dataDir)
  const legacy = (id, name, extra = {}) => ({
    id, name, dshRef: REF, apiKey: 'private-legacy-key', systemPrompt: 'private-legacy-prompt',
    enabled: true, createdAt: Date.now(), updatedAt: Date.now(), ...extra,
  })
  writeFileSync(join(dataDir, 'store.json'), JSON.stringify({
    agents: [legacy('legacy-empty', '旧助手'), legacy('legacy-description', '旧介绍助手', { description: '存量描述' })],
    tasks: [], schedules: [], projects: [], teams: [], settings: {},
  }))
  await start()
  const adminLogin = await request('POST', '/auth/login', { username: 'workbuddy', password: 'workbuddy-admin' })
  requireOk(adminLogin, 'admin login')
  const admin = adminLogin.cookie
  assert.ok(admin, 'Admin session cookie missing')
  async function invite(email) {
    const invited = requireOk(await request('POST', '/users', { email, displayName: email }, admin), 'invite', 201)
    const token = new URL(invited.inviteLink).searchParams.get('token')
    assert.ok(token, 'Invitation token missing')
    const accepted = await request('POST', `/invitations/${token}`, { password: 'Passw0rd123', displayName: email })
    requireOk(accepted, 'accept invitation')
    assert.ok(accepted.cookie, 'User session cookie missing')
    return accepted.cookie
  }
  const alice = await invite('bot-alice@example.com')
  const bob = await invite('bot-bob@example.com')
  const profile = async (id, cookie = alice) => requireOk(await request('GET', `/agents/${id}/profile`, undefined, cookie), `profile ${id}`)
  const list = async (cookie) => {
    const rows = requireOk(await request('GET', '/agents/profiles', undefined, cookie), 'profile list')
    assert.ok(Array.isArray(rows), 'Profile list data must be an array')
    return rows
  }
  const patch = (id, display, cookie = alice) => request('POST', '/agents', { id, display }, cookie)
  for (const [identity, cookie] of [['admin', admin], ['owner', alice], ['other user', bob]]) {
    const rows = await list(cookie)
    check(`${identity}: legacy list visible`, rows.some((a) => a.id === 'legacy-empty'))
    rows.forEach((a) => projection(`${identity}: list fixed projection ${a.id}`, a))
    const old = await profile('legacy-empty', cookie)
    projection(`${identity}: legacy detail fixed projection`, old)
    check(`${identity}: no-description legacy defaults`, equal(old, {
      id: 'legacy-empty', name: '旧助手', description: '',
      display: { expertise: '', welcomeMessage: '你好，我是旧助手。你想先聊些什么？', quickActions: [] },
    }))
    check(`${identity}: legacy expertise uses description`, (await profile('legacy-description', cookie)).display.expertise === '存量描述')
  }
  check('Missing agent returns 404', (await request('GET', '/agents/missing/profile', undefined, alice)).status === 404)
  check('Legacy write by normal user denied', (await patch('legacy-empty', { expertise: '侵入' })).status === 403)
  requireOk(await patch('legacy-empty', { expertise: '管理员声明' }, admin), 'admin legacy edit')
  check('Admin may edit legacy display', (await profile('legacy-empty', bob)).display.expertise === '管理员声明')
  const configured = { expertise: '整理需求', welcomeMessage: '欢迎开始', quickActions: [
    { label: '第二步', text: '先执行这个建议' }, { label: '第一步', text: '然后考虑这个建议' },
  ] }
  const created = requireOk(await request('POST', '/agents', {
    name: 'Alice 私有助手', dshRef: REF, description: '描述回退',
    apiKey: 'private-owner-key', systemPrompt: 'private-owner-prompt', executionPrompt: 'private-execution-prompt',
    provider: 'private-provider', model: 'private-model', workDir: '/private-workspace',
    permission: 'danger-full-access', skills: ['private-skill'], resources: [],
    display: { expertise: '  整理需求\n', welcomeMessage: '\t欢迎开始  ', quickActions: [
      { label: ' 第二步 ', text: ' 先执行这个建议 ' }, { label: ' 第一步 ', text: ' 然后考虑这个建议 ' },
    ] },
  }, alice), 'owner creates agent')
  const id = created.id
  assert.ok(id, 'Created agent id missing')
  check('Ordinary owner creates trimmed display and preserves order', equal((await profile(id)).display, configured))
  const adminCreated = requireOk(await request('POST', '/agents', {
    name: 'Admin 私有助手', dshRef: REF, display: { expertise: '管理员新建' },
  }, admin), 'admin creates agent')
  check('Admin creates display', (await profile(adminCreated.id, admin)).display.expertise === '管理员新建')
  check('Cross-account detail hidden as 404', (await request('GET', `/agents/${id}/profile`, undefined, bob)).status === 404)
  check('Cross-account list hides private agents', !(await list(bob)).some((a) => [id, adminCreated.id].includes(a.id)))
  check('Cross-account write denied', (await patch(id, { expertise: '跨账号修改' }, bob)).status === 403)
  check('Same-name reuse cannot bypass management permission', (await request('POST', '/agents', {
    name: 'Alice 私有助手', dshRef: REF, display: { expertise: '绕过' },
  }, bob)).status === 403)
  for (const [identity, cookie] of [['owner', alice], ['admin', admin]]) {
    projection(`${identity}: private detail projection excludes all execution/secret fields`, await profile(id, cookie))
    ;(await list(cookie)).forEach((a) => projection(`${identity}: list projection ${a.id}`, a))
  }
  const project = requireOk(await request('POST', '/projects', { name: '展示共享项目', dshRef: REF, defaultAgentIds: [id] }, alice), 'owner creates project')
  requireOk(await request('POST', `/projects/${project.id}/members`, { username: 'bot-bob@example.com' }, alice), 'add project member')
  // New defaultAgentIds relationships do not grant access to a private BOT (task-89).
  check('Project association alone keeps private profile hidden', (await request('GET', `/agents/${id}/profile`, undefined, bob)).status === 404)
  check('Project association alone keeps private profile out of list', !(await list(bob)).some((a) => a.id === id))
  requireOk(await request('POST', '/agents', { id, sharedProjectIds: [project.id] }, alice), 'owner explicitly shares agent with project')
  check('Project member can read shared profile', equal((await profile(id, bob)).display, configured))
  check('Project member list includes shared profile', (await list(bob)).some((a) => a.id === id))
  projection('Project member receives only public display fields', await profile(id, bob))
  check('Project sharing does not allow display writes', (await patch(id, { welcomeMessage: '成员改写' }, bob)).status === 403)
  requireOk(await patch(id, { welcomeMessage: '管理员修改' }, admin), 'admin edits owner agent')
  check('Admin edit retains other display fields', equal((await profile(id)).display, { ...configured, welcomeMessage: '管理员修改' }))
  requireOk(await patch(id, { expertise: 'owner 修改' }), 'owner field patch')
  let expected = { ...configured, expertise: 'owner 修改', welcomeMessage: '管理员修改' }
  check('Owner object patch preserves omitted fields', equal((await profile(id)).display, expected))
  requireOk(await request('POST', '/agents', { id, description: '更新后的描述' }, alice), 'old client update')
  check('Old client omitting display preserves configuration', equal((await profile(id)).display, expected))
  requireOk(await patch(id, {}), 'empty patch')
  check('Empty object patch preserves configuration', equal((await profile(id)).display, expected))
  const replacement = [{ label: '<b>纯文本</b>', text: '<script>alert(1)</script>\n请先让我编辑' }]
  requireOk(await patch(id, { quickActions: replacement }), 'replace quick actions')
  expected = { ...expected, quickActions: replacement }
  check('Actions replace entire array and retain plain text', equal((await profile(id)).display, expected))
  requireOk(await patch(id, { quickActions: [] }), 'clear action group')
  check('Empty actions clear entire group', equal((await profile(id)).display.quickActions, []))
  requireOk(await patch(id, { expertise: ' \n ', welcomeMessage: '\t ' }), 'clear optional strings')
  check('Empty optional strings restore defaults', equal((await profile(id)).display, {
    expertise: '更新后的描述', welcomeMessage: '你好，我是Alice 私有助手。你想先聊些什么？', quickActions: [],
  }))
  await persisted('Cleared strings removed from stored configuration', (s) => {
    const d = s.agents.find((a) => a.id === id)?.display
    return d && !Object.hasOwn(d, 'expertise') && !Object.hasOwn(d, 'welcomeMessage')
  })
  const boundary = {
    expertise: '😀'.repeat(1000), welcomeMessage: '𠮷'.repeat(500), quickActions: [
      { label: '😀'.repeat(40), text: '𠮷'.repeat(2000) },
      { label: 'e\u0301'.repeat(20), text: '组合字符边界' }, { label: '第三条', text: '顺序保持' },
    ],
  }
  requireOk(await patch(id, boundary), 'unicode exact boundaries')
  check('Unicode code-point maxima and three actions accepted', equal((await profile(id)).display, boundary))
  const invalid = [
    ['display string', 'text'], ['display number', 1], ['display boolean', false], ['display array', []],
    ['display unknown field', { unknown: true }],
    ['expertise type', { expertise: 1 }], ['expertise null', { expertise: null }],
    ['welcome type', { welcomeMessage: false }], ['welcome null', { welcomeMessage: null }],
    ['expertise 1001 code points', { expertise: '😀'.repeat(1001) }],
    ['welcome 501 code points', { welcomeMessage: '𠮷'.repeat(501) }],
    ['actions null', { quickActions: null }], ['actions object', { quickActions: {} }],
    ['actions string', { quickActions: 'abc' }],
    ['four actions', { quickActions: Array.from({ length: 4 }, () => ({ label: 'a', text: 'b' })) }],
    ['action unknown field', { quickActions: [{ label: 'a', text: 'b', execute: true }] }],
    ...[null, [], 'x', 2, false].map((action) => [`action type ${JSON.stringify(action)}`, { quickActions: [action] }]),
    ...['label', 'text'].flatMap((field) => [undefined, null, 1, false, {}, [], '', ' \n\t '].map((value) => [
      `${field} invalid ${JSON.stringify(value)}`, { quickActions: [{ label: 'a', text: 'b', [field]: value }] },
    ])),
    ['label 41 code points', { quickActions: [{ label: '😀'.repeat(41), text: 'x' }] }],
    ['text 2001 code points', { quickActions: [{ label: 'a', text: '𠮷'.repeat(2001) }] }],
    ['combining sequences count separately', { quickActions: [{ label: 'e\u0301'.repeat(21), text: 'x' }] }],
    ['invalid later field cannot partially update', { expertise: '不应保存', quickActions: [{ label: ' ', text: 'x' }] }],
  ]
  for (const [name, display] of invalid) {
    const response = await patch(id, display)
    check(`Reject ${name}`, response.status === 400 && response.json?.ok === false, `HTTP ${response.status}`)
    check(`Rejected ${name} leaves stored view intact`, equal((await profile(id)).display, boundary))
  }
  // Optional read-disk persistence seam is authorized by task-92. Never modify the live store.
  await persisted('Normalized Unicode configuration persisted', (s) => equal(s.agents.find((a) => a.id === id)?.display, boundary))
  requireOk(await patch(id, null), 'clear all display')
  check('Null clears display and restores all fallbacks', equal((await profile(id)).display, {
    expertise: '更新后的描述', welcomeMessage: '你好，我是Alice 私有助手。你想先聊些什么？', quickActions: [],
  }))
  await persisted('Null clear persisted as no configured display', (s) => !s.agents.find((a) => a.id === id)?.display)
  requireOk(await patch(id, { expertise: '持久化专长', welcomeMessage: '持久化欢迎', quickActions: replacement }), 'restore display')
  await persisted('Final configuration persisted', (s) => equal(s.agents.find((a) => a.id === id)?.display, {
    expertise: '持久化专长', welcomeMessage: '持久化欢迎', quickActions: replacement,
  }))
  const cookies = [admin, alice, bob]
  const tasks = async () => Promise.all(cookies.map(async (cookie) => requireOk(await request('GET', '/tasks', undefined, cookie), 'task snapshot')))
  const before = await tasks()
  const diskBefore = store().tasks
  for (const cookie of cookies) {
    for (const row of await list(cookie)) {
      projection('Read-only list remains an allowlisted projection', row)
      const detail = await profile(row.id, cookie)
      projection('Read-only detail remains an allowlisted projection', detail)
      // Local selection copies text into an editor model. It deliberately issues no HTTP request.
      const editorValue = detail.display.quickActions[0]?.text ?? ''
      if (row.id === id) check('Local selection uses action text verbatim', editorValue === replacement[0].text)
    }
  }
  check('Reads and local text selection do not create tasks/send messages (all identities)', equal(await tasks(), before))
  check('Reads and local selection leave persisted tasks unchanged', equal(store().tasks, diskBefore))
  requireOk(await request('PATCH', `/projects/${project.id}`, { defaultAgentIds: [] }, alice), 'remove project association')
  check('Removing project association preserves explicitly shared detail', (await profile(id, bob)).display.expertise === '持久化专长')
  check('Removing project association preserves explicitly shared list entry', (await list(bob)).some((a) => a.id === id))
  requireOk(await request('POST', '/agents', { id, sharedProjectIds: [] }, alice), 'owner revokes explicit project sharing')
  check('Unsharing removes profile detail visibility', (await request('GET', `/agents/${id}/profile`, undefined, bob)).status === 404)
  check('Unsharing removes profile list visibility', !(await list(bob)).some((a) => a.id === id))
  console.log(`\n${results.length} checks, ${failures} failures. Port=${PORT}; persistence verified from temporary store.json.`)
  if (failures) process.exitCode = 1
}
process.once('SIGINT', () => { if (child) child.kill('SIGKILL'); process.exitCode = 1 })
try { await main() } catch (error) { console.error('BOT display E2E failed:', error); process.exitCode = 1 } finally { await cleanup() }
