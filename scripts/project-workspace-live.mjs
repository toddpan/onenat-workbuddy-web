#!/usr/bin/env node
/** task-57: opt-in, isolated real-node acceptance; never dispatches a backlog or implementation task. */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { createApp } from '../dist/server.js'
import { OnenatDirectory } from '../dist/onenat.js'
import { DshClient } from '../dist/remote-client.js'

assert.equal(process.env.WORKBUDDY_LIVE_ACCEPTANCE, '1', 'Set WORKBUDDY_LIVE_ACCEPTANCE=1 for real-node tests')
assert.ok(process.env.WORKBUDDY_FILE_NODE && process.env.WORKBUDDY_EXECUTION_NODE, 'Select two authorized mapping IDs from the live directory')
const ownerId = process.env.WORKBUDDY_FILE_NODE, executorId = process.env.WORKBUDDY_EXECUTION_NODE
assert.notEqual(ownerId, executorId)
const childRoute = process.env.WORKBUDDY_LIVE_CHILD_ROUTE || 'dag'
assert.ok(['dag', 'chat', 'public'].includes(childRoute), 'Child route must be dag, chat or public')
const settings = JSON.parse(await readFile(process.env.ONENAT_SETTINGS_FILE || join(homedir(), '.dsh/dsh-onenat/store.json'), 'utf8')).settings.onenat
let directory = new OnenatDirectory(settings.baseUrl, settings.apiKey)
const client = new DshClient()
const tag = 'wb-task57-' + randomBytes(8).toString('hex')
const ownerRoot = '/tmp/' + tag + '-owner', executorRoot = '/tmp/' + tag + '-executor'
const dataDir = await mkdtemp(join(tmpdir(), 'wb-task57-live-'))
const reportPath = process.env.WORKBUDDY_LIVE_REPORT || 'artifacts/task57/live-acceptance.json'
await mkdir('artifacts/task57', { recursive: true })
const expectedHelperSha256 = createHash('sha256').update(await readFile(new URL('./workspace-remote.mjs', import.meta.url))).digest('hex')
const report = { at: new Date().toISOString(), tag, ownerId, executorId, childRoute, ownerRoot, executorRoot, expectedHelperSha256, checks: [], requests: [], toolCalls: [], helperUploads: [], cleanup: [] }
const nativeStreamPrompt = DshClient.prototype.streamPrompt
DshClient.prototype.streamPrompt = function (t, id, prompt, handlers, options) {
  return nativeStreamPrompt.call(this, t, id, prompt, { ...handlers, onToolCall(info) { report.toolCalls.push({ sessionId: id, name: info.name }); handlers?.onToolCall?.(info) } }, options)
}
const knownSecrets = new Set([settings.apiKey])
const redact = text => {
  let value = String(text)
  for (const secret of knownSecrets) if (secret) value = value.split(secret).join('[redacted]')
  return value.replace(/Bearer [A-Za-z0-9._-]+/g, 'Bearer [redacted]').replace(/(?:wba_|dsh_|onk-)[A-Za-z0-9_-]+/g, '[redacted]')
}
const save = () => writeFile(reportPath, redact(JSON.stringify(report, null, 2)))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const before = new Map(), created = [], beforeWorkspaces = new Map()
let app, base, cookie = '', projectId
const nativeFetch = globalThis.fetch
// Record payload metadata only. Never log a prompt, key, or HTTP header.
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url))
  if (u.pathname.endsWith('/api/v1/sessions') && init.method === 'POST') {
    const b = JSON.parse(init.body)
    report.requests.push({ url: String(url), cwd: b.cwd, title: b.title, provider: b.provider, model: b.model })
  }
  if (u.pathname.endsWith('/prompt-stream') && typeof init.body === 'string') {
    const b = JSON.parse(init.body)
    report.requests.push({ url: String(url), promptSha256: sha(b.prompt || ''), workspaceSection: b.prompt?.includes('[项目工作区跨机访问]'), stableOwner: b.prompt?.includes("--node-ref 'mapping:" + ownerId + "'"), helperCurrent: /\.workbuddy-workspace-remote-v3(?:-[1-9]\d*)?\.mjs/.test(b.prompt || '') })
  }
  const res = await nativeFetch(url, init)
  if (/\/sessions\/[^/]+\/files$/.test(u.pathname) && init.body instanceof FormData && init.body.get('files')?.name === '.workbuddy-workspace-remote-v3.mjs') {
    const j = await res.clone().json().catch(() => ({}))
    const helper = init.body.get('files')
    report.helperUploads.push({ sessionId: u.pathname.split('/').at(-2), requestedName: helper.name, requestSha256: sha(Buffer.from(await helper.arrayBuffer())), status: res.status, ok: j.ok === true, files: j.data?.files?.map(f => ({ name: f.name, path: f.path, size: f.size })) })
  }
  if (u.pathname.endsWith('/api/v1/sessions') && init.method === 'POST' && res.ok) {
    const j = await res.clone().json().catch(() => ({}))
    if (j.data?.sessionId) created.push({ base: String(url).replace(/\/sessions$/, ''), id: j.data.sessionId, node: executorId })
  }
  if (childRoute === 'public' && u.pathname.endsWith('/chat/completions') && init.method === 'POST' && res.ok) {
    const j = await res.clone().json().catch(() => ({}))
    if (j.sessionId) created.push({ base: String(url).replace(/\/chat\/completions$/, ''), id: j.sessionId, node: executorId })
  }
  return res
}
async function target(id) {
  await directory.refresh(true)
  const ep = directory.resolveMapping(id)
  assert.ok(ep?.online && ep.baseUrl, 'Live authorized node offline: ' + id)
  const c = await directory.fetchMappingCredentials(id)
  assert.ok(c.ok && (c.apiKey || c.token), 'Authorized credential unavailable: ' + id)
  knownSecrets.add(c.apiKey || c.token)
  return { baseUrl: ep.baseUrl, apiKey: c.apiKey || c.token }
}
async function request(t, path, body, method = body === undefined ? 'GET' : 'POST') {
  const res = await fetch(t.baseUrl + path, { method, headers: { Authorization: 'Bearer ' + t.apiKey, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) })
  const j = await res.json().catch(() => ({}))
  assert.ok(res.ok && j.ok, `${method} ${path}: HTTP ${res.status} ${redact(j.error || '')}`)
  return j.data
}
async function assertAbsent(id, root) {
  assert.match(root, /^\/tmp\/wb-task57-[a-f0-9]{16}-(owner|executor)$/)
  const t = await target(id)
  const res = await fetch(t.baseUrl + '/fs/list?all=1&path=' + encodeURIComponent(root), { headers: { Authorization: 'Bearer ' + t.apiKey }, signal: AbortSignal.timeout(15000) })
  const value = await res.json()
  // DSH 0.6.1 returns 400 with an explicit missing-directory error; auth/network
  // errors and truncated parent listings cannot prove a path is absent.
  assert.ok([400, 404].includes(res.status) && value.ok === false && typeof value.error === 'string' && value.error.includes(root) && /目录不存在|\bENOENT\b/.test(value.error), 'Expected explicit missing path, received HTTP ' + res.status + ': ' + redact(value.error || ''))
  ;(report.absenceChecks ||= []).push({ node: id, path: root, status: res.status, error: redact(value.error) })
  return true
}
const array = (value, key) => Array.isArray(value) ? value : value?.[key] || []
async function download(id, path) {
  const t = await target(id), d = await client.fsDownload(t, path)
  assert.ok(d.ok && d.res, d.error)
  return Buffer.from(await d.res.arrayBuffer())
}
async function api(path, body, method = body === undefined ? 'GET' : 'POST', timeoutMs = 20000) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs) })
  if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0]
  const j = await res.json()
  assert.ok(res.ok && j.ok, path + ': ' + redact(j.error || JSON.stringify(j)))
  return j.data || j
}
async function settle(id) {
  const deadline = Date.now() + 1200000
  while (Date.now() < deadline) {
    const task = app.store.getTask(id)
    if (!app.router.engine.isRunning(id) && !['draft', 'running'].includes(task?.status)) return task
    await new Promise(r => setTimeout(r, 1500))
  }
  await api('/tasks/' + id + '/cancel', {})
  throw Error('Real task timed out: ' + id)
}
async function check(name, fn) {
  try { const evidence = await fn(); report.checks.push({ name, result: 'PASS', evidence }); console.log('PASS ' + name); await save(); return evidence }
  catch (e) { report.checks.push({ name, result: 'FAIL', error: redact(e.message) }); await save(); throw e }
}
const seed = { main: randomBytes(24).toString('hex'), child: randomBytes(24).toString('hex') }
async function verifyLane(lane, final, binding) {
  const diagnosis = { status: final.status, error: final.error, systemTurns: final.turns.filter(t => t.role === 'system').map(t => t.text), lastTurns: final.turns.slice(-2).map(t => ({ role: t.role, text: String(t.text || '').slice(-1500) })), logs: final.taskLogs?.slice(-12).map(log => log.level === 'tool' ? { ts: log.ts, level: log.level, tool: /^工具调用: ([^ ·]+)/.exec(log.msg)?.[1] || 'unknown' } : log) }
  report[lane + 'TaskDiagnosis'] = JSON.parse(redact(JSON.stringify(diagnosis)))
  await save()
  assert.ok(binding?.remoteSessionId, 'No actual executor session: ' + redact(JSON.stringify(diagnosis)))
  const info = await client.getSessionInfo(await target(executorId), binding.remoteSessionId)
  assert.equal(info.cwd, executorRoot)
  const observed = JSON.parse((await download(executorId, executorRoot + '/' + lane + '-result.json')).toString())
  report[lane + 'Observed'] = observed
  await save()
  assert.equal(observed.ok, true, observed.error)
  assert.equal(observed.initialSha256, sha(seed[lane]), 'Read must match independently uploaded random bytes')
  assert.equal(observed.checks.length, 6)
  assert.equal(observed.checks.find(c => c.code === 'CAS_MISMATCH')?.ok, false)
  assert.ok(observed.checks.every(c => c.temporarySessionId && c.sessionCleanup === 'deleted'))
  const ownerBytes = await download(ownerId, ownerRoot + '/' + lane + '.txt')
  assert.equal(sha(ownerBytes), observed.finalSha256, 'Independent owner HTTP read confirms remote write')
  assert.equal(observed.exec.cwd, ownerRoot)
  const built = await download(ownerId, ownerRoot + '/' + lane + '.built')
  assert.equal(sha(built), observed.exec.builtSha256)
  assert.equal(built.toString(), ownerBytes.toString().toUpperCase())
  report[lane + 'Independent'] = { ownerSha256: sha(ownerBytes), builtSha256: sha(built), ownerRootAbsentOnExecutor: await assertAbsent(executorId, ownerRoot) }
  await save() // Preserve independent evidence even when a later injection assertion fails.
  assert.equal(report[lane + 'Independent'].ownerRootAbsentOnExecutor, true)
  const helperPath = binding.workspaceAccessCliPath
  assert.ok(helperPath?.startsWith(executorRoot + '/') && /\/\.workbuddy-workspace-remote-v3(?:-[1-9]\d*)?\.mjs$/.test(helperPath), 'Bound helper must be current and inside isolated executor cwd')
  const helperSha256 = sha(await download(executorId, helperPath))
  assert.equal(helperSha256, expectedHelperSha256, 'Independently downloaded installed helper matches local source')
  assert.ok(report.helperUploads.some(u => u.sessionId === binding.remoteSessionId && u.ok && u.files.some(f => f.path === helperPath)))
  const tools = report.toolCalls.filter(t => t.sessionId === binding.remoteSessionId)
  assert.ok(tools.length, 'Actual command tool event required')
  const dispatched = report.requests.find(r => r.url.includes(binding.remoteSessionId) && r.workspaceSection && r.stableOwner && r.helperCurrent)
  assert.ok(dispatched, 'Automatic stable-reference injection required for this session')
  if (childRoute === 'public') {
    const history = await client.getHistory(await target(executorId), binding.remoteSessionId, 200)
    assert.equal(history.ok, true, history.error)
    const firstUser = history.messages.find(m => m.role === 'user')
    assert.ok(firstUser && typeof firstUser.content === 'string', 'Actual remote history must contain the first user prompt')
    const content = firstUser.content
    const historical = { sessionId: binding.remoteSessionId, seq: firstUser.seq, promptSha256: sha(content), workspaceSection: content.includes('[项目工作区跨机访问]'), stableOwner: content.includes("--node-ref 'mapping:" + ownerId + "'"), helperCurrent: content.includes(helperPath), readOnlyFallback: content.includes('远程操作工具未能安装') }
    ;(report.archivedPrompts ||= []).push(historical)
    await save()
    assert.equal(historical.promptSha256, dispatched.promptSha256, 'Archived first prompt must exactly match the observed dispatched prompt')
    assert.ok(historical.workspaceSection && historical.stableOwner && historical.helperCurrent && !historical.readOnlyFallback)
  }
  return { taskId: final.id, sessionId: binding.remoteSessionId, cwd: info.cwd, helperPath, helperSha256, tools, ...observed, independentOwnerSha256: sha(ownerBytes), independentBuiltSha256: sha(built) }
}
function prompt(lane) {
  // Secrets and the helper path are deliberately absent: the model must use its automatically injected workspace context.
  return `这是 task-57 的隔离运行验收，只执行这个检查，不实现代码、不派发或创建 WorkBuddy/OneNat 任务、不递归发送宿主消息、不询问用户。使用自动注入的 [项目工作区跨机访问] 中的凭证环境变量及已安装 helper；用命令工具运行已上传的 Node 测试驱动（无需读取或改写脚本）：\nnode '${executorRoot}/workspace-roundtrip-live.mjs' '<已注入的新版远程工具绝对路径>' 'mapping:${ownerId}' '${settings.baseUrl}' '${ownerRoot}' '${executorRoot}' '${lane}-result.json' '${lane}'\n把尖括号占位替换为注入段实际工具路径，并将注入段的 WORKBUDDY_WORKSPACE_API_KEY 和 WORKBUDDY_ONENAT_API_KEY 作为环境变量传给 Node。不要在回答中输出凭证。驱动串行执行 list/read/write/stale-CAS/read/exec，每个内部调用可能需要等待远端模型，命令至少允许 15 分钟运行。完成后仅返回 LIVE_ROUNDTRIP 行；失败如实报告。不要自行清理目录或会话，测试控制端负责 finally 清理。`
}
const progress = setInterval(() => console.log('LIVE waiting ' + new Date().toISOString() + ' checks=' + report.checks.length), 15000)
try {
  app = createApp({ host: '127.0.0.1', port: 0, prefix: '/onenat-workbuddy', dataDir, onenatBaseUrl: settings.baseUrl, onenatApiKey: settings.apiKey, apiToken: 'task57-' + tag, autoRefreshMs: 3600000, xiaozhiMcp: '', adminUsername: 'workbuddy', adminPassword: 'workbuddy-admin', quiet: true })
  directory.stopAutoRefresh()
  directory = app.directory // Share the production cache/budget instead of doubling credential requests.
  for (const id of [ownerId, executorId]) {
    const t = await target(id)
    assert.equal((await client.ping(t)).ok, true)
    const models = await request(t, '/models')
    assert.ok(array(models, 'models').some(m => m.provider === 'deepseek-official' && m.id === 'deepseek-v4-flash'))
    before.set(id, new Set(array(await request(t, '/sessions'), 'sessions').map(s => s.id || s.sessionId)))
    beforeWorkspaces.set(id, new Set(array(await request(t, '/workspaces'), 'workspaces').map(w => w.id)))
  }
  await check('real owner/executor isolated fixtures and independent filesystems', async () => {
    const owner = await target(ownerId), executor = await target(executorId)
    assert.equal((await client.fsMkdir(owner, '/tmp', tag + '-owner')).ok, true)
    assert.equal((await client.fsMkdir(executor, '/tmp', tag + '-executor')).ok, true)
    assert.equal((await client.fsUpload(owner, ownerRoot, Object.entries(seed).map(([lane, bytes]) => ({ filename: lane + '.txt', data: Buffer.from(bytes) })))).ok, true)
    assert.equal((await client.fsUpload(executor, executorRoot, [{ filename: 'workspace-roundtrip-live.mjs', data: await readFile(new URL('./workspace-roundtrip-live.mjs', import.meta.url)) }])).ok, true)
    if (childRoute === 'public') {
      // Reproduce a shared-cwd filename collision without precreating any task/session binding.
      const existing = await client.fsUpload(executor, executorRoot, [{ filename: '.workbuddy-workspace-remote-v3.mjs', data: await readFile(new URL('./workspace-remote.mjs', import.meta.url)) }])
      assert.equal(existing.ok, true)
      report.collisionFixture = { taskBindingCreated: false, preexistingHelperSha256: sha(await download(executorId, executorRoot + '/.workbuddy-workspace-remote-v3.mjs')) }
      assert.equal(report.collisionFixture.preexistingHelperSha256, expectedHelperSha256)
    }
    await assertAbsent(executorId, ownerRoot)
    return { ownerRoot, executorRoot, initialHashes: Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, sha(v)])), ownerRootAbsentOnExecutor: true }
  })
  await new Promise(r => app.server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${app.server.address().port}/onenat-workbuddy/api`
  await api('/auth/login', { username: 'workbuddy', password: 'workbuddy-admin' })
  await app.directory.refresh(true)
  assert.ok(app.directory.resolveMapping(ownerId)?.online && app.directory.resolveMapping(executorId)?.online, 'Isolated application catalog must be loaded before dispatch')
  const ownerRef = { kind: 'mapping', mappingId: ownerId }, executorRef = { kind: 'mapping', mappingId: executorId }
  const project = await api('/projects', { name: tag, dshRef: ownerRef, defaultExecutionNodeRef: executorRef, workspace: ownerRoot })
  projectId = project.id
  const mainLane = () => check('AC1/2/3 main without mentions actually runs list/read/write/CAS/exec on owner', async () => {
    const task = await api('/tasks', { projectId, nodeRef: executorRef, memberAgentIds: [], workDir: executorRoot, model: 'deepseek-official/deepseek-v4-flash', message: prompt('main') })
    const final = await settle(task.id)
    report.mainStatus = final.status
    return verifyLane('main', final, final.sessions.__node__)
  })
  const childLane = () => check('AC1/2/3 child via ' + childRoute + ' actually uses the injected remote file and command channel', async () => {
    const agent = await api('/agents', { name: tag + '-child', dshRef: executorRef, workDir: executorRoot, provider: 'deepseek-official', model: 'deepseek-v4-flash' })
    const task = await api('/tasks', { projectId, nodeRef: executorRef, memberAgentIds: [], workDir: executorRoot })
    assert.deepEqual(task.sessions, {}, 'No attachment or session binding may precede first dispatch')
    report.childFirstDispatch = { route: childRoute, sessionsBefore: Object.keys(task.sessions), attachmentsBefore: task.attachments?.length || 0 }
    let final
    if (childRoute === 'public') {
      assert.equal(report.childFirstDispatch.attachmentsBefore, 0)
      assert.equal(report.helperUploads.length, 0, 'No task helper upload or main dispatch may precede the first public child request')
      await api('/planner/config', { model: 'deepseek-official/deepseek-v4-flash' })
      report.childFirstDispatch.entry = 'POST /tasks/:id/messages → sendUserMessage → runOrchestrateTurn → runSubtask'
      await api('/tasks/' + task.id + '/messages', { message: '@' + agent.name + ' ' + prompt('child') })
      final = await settle(task.id)
      assert.equal(final.status, 'success', final.error || final.summary?.overview)
      assert.equal(final.lastRoute?.kind, 'orchestrate')
      assert.equal(final.plan?.subtasks.length, 1, 'Single-@ planner must produce exactly the requested child lane')
      assert.equal(final.plan.subtasks[0].agentId, agent.id)
      assert.equal(final.plan.subtasks[0].status, 'completed', final.plan.subtasks[0].error)
      assert.equal(final.sessions.__node__, undefined, 'Planner session is not a precreated task main binding')
      assert.match(final.sessions[agent.id]?.workspaceAccessCliPath || '', /\/\.workbuddy-workspace-remote-v3-[1-9]\d*\.mjs$/, 'Real automatic child upload must receive a numbered path')
    } else if (childRoute === 'chat') {
      assert.equal(report.childFirstDispatch.attachmentsBefore, 0)
      assert.equal(report.helperUploads.length, 0, 'Chat child goes first; main helper cannot mask initial installation')
      // Current single-@ public routing uses a planner. Call the actual complete
      // chat implementation so this lane proves runChatTurn, not another DAG.
      const engine = app.router.engine
      const stored = app.store.getTask(task.id)
      app.store.mutateTask(task.id, t => { t.memberAgentIds = [agent.id] })
      const text = '@' + agent.name + ' ' + prompt('child')
      const mentions = await engine.extractMentions(text)
      assert.equal(mentions.mentionedFiles, undefined)
      const receiving = await engine.resolveExecTarget(stored, agent.id)
      assert.ok(receiving?.online, 'Child executor must resolve from current directory')
      report.childFirstDispatch.entry = 'TaskEngine.runChatTurn (complete method, actual DSH HTTP)'
      await engine.runChatTurn(task.id, text, mentions, new Map([[agent.id, receiving]]), new AbortController().signal)
      final = app.store.getTask(task.id)
      assert.equal(final.status, 'completed', final.error)
      assert.equal(final.plan, undefined, 'Complete runChatTurn must not create a DAG')
      assert.equal(final.sessions.__node__, undefined, 'No main binding may mask first child dispatch')
    } else {
      app.store.mutateTask(task.id, t => {
        t.memberAgentIds = [agent.id]
        t.plan = { objective: '隔离远程通道验收', strategy: 'parallel', createdAt: Date.now(), subtasks: [{ id: 'verify-remote', title: '远程通道验收', prompt: prompt('child'), agentId: agent.id, dependsOn: [], status: 'pending', logs: [] }] }
      })
      const retry = await app.router.engine.retrySubtask(task.id, 'verify-remote')
      assert.equal(retry.ok, true, retry.error)
      final = app.store.getTask(task.id)
      assert.equal(final.plan.subtasks[0].status, 'completed', final.plan.subtasks[0].error)
    }
    report.childFirstDispatch.sessionsAfter = Object.keys(final.sessions)
    report.childFirstDispatch.planPresent = Boolean(final.plan)
    return verifyLane('child', final, final.sessions[agent.id])
  })
  if (childRoute === 'chat' || childRoute === 'public') { await childLane(); await mainLane() }
  else { await mainLane(); await childLane() }
  await check('files remain only on owner, no leaked helper sessions or coordination files', async () => {
    await assertAbsent(executorId, ownerRoot)
    const owner = await target(ownerId), listing = await client.fsList(owner, ownerRoot, true)
    assert.equal(listing.ok, true)
    assert.ok(!listing.data.entries.some(e => e.name.startsWith('.workspace-remote.') || e.name.startsWith('workbuddy-workspace-worker-') || e.name.startsWith('workbuddy-workspace-result-')))
    const helperSessions = [report.mainObserved, report.childObserved].flatMap(o => o.checks.map(c => c.temporarySessionId))
    assert.equal(new Set(helperSessions).size, 12)
    assert.ok([report.mainObserved, report.childObserved].every(o => o.checks.every(c => c.sessionCleanup === 'deleted')))
    return { ownerFiles: listing.data.entries.map(e => e.name), ownerRootAbsentOnExecutor: true, noRemoteLocks: true, helperSessionsArchived: helperSessions, cleanupEvidence: 'DSH DELETE acknowledged; archived histories may remain readable' }
  })
} catch (e) { report.error = redact(e.message); process.exitCode = 1; console.error('LIVE FAIL: ' + report.error) }
finally {
  clearInterval(progress)
  if (app) {
    for (const task of app.store.getTasks()) if (app.router.engine.isRunning(task.id)) await app.router.engine.cancelTask(task.id).catch(() => {})
    app.store.flush(); await app.close()
  }
  for (const id of [ownerId, executorId]) {
    try {
      const t = await target(id), root = id === ownerId ? ownerRoot : executorRoot
      assert.ok(/^\/tmp\/wb-task57-[a-f0-9]{16}-(owner|executor)$/.test(root))
      assert.equal(root, '/tmp/' + tag + (id === ownerId ? '-owner' : '-executor'))
      const sessions = array(await request(t, '/sessions'), 'sessions')
      for (const s of sessions) {
        const sid = s.id || s.sessionId
        if (before.get(id)?.has(sid)) continue
        const info = await request(t, '/sessions/' + encodeURIComponent(sid))
        if (![ownerRoot, executorRoot].includes(info.cwd) && !created.some(c => c.id === sid)) continue
        await request(t, '/sessions/' + encodeURIComponent(sid) + '/cancel', {})
        await request(t, '/sessions/' + encodeURIComponent(sid), undefined, 'DELETE')
        report.cleanup.push({ node: id, sessionId: sid, removed: true })
      }
      if (childRoute === 'public') {
        // Planner/summarizer sessions are not task bindings and may already be archived.
        for (const item of created.filter(c => c.node === id)) {
          assert.ok(!before.get(id)?.has(item.id), 'Never clean a preexisting session')
          if (report.cleanup.some(c => c.sessionId === item.id && c.removed)) continue
          const fresh = await target(id)
          await request(fresh, '/sessions/' + encodeURIComponent(item.id) + '/cancel', {})
          await request(await target(id), '/sessions/' + encodeURIComponent(item.id), undefined, 'DELETE')
          report.cleanup.push({ node: id, sessionId: item.id, removed: true, source: 'observed planner/summarizer response' })
        }
      }
      const removed = await client.fsRemove(t, root)
      report.cleanup.push({ node: id, directory: root, removed: removed.ok, ...(removed.error ? { error: redact(removed.error) } : {}) })
      assert.equal(removed.ok, true, removed.error)
      const absent = await assertAbsent(id, root)
      report.cleanup.push({ node: id, directory: root, absentWithExplicitHttpError: absent })
      for (const w of array(await request(t, '/workspaces'), 'workspaces')) {
        if ([ownerRoot, executorRoot].includes(w.path) && !beforeWorkspaces.get(id)?.has(w.id)) {
          await request(t, '/workspaces/' + w.id, undefined, 'DELETE')
          report.cleanup.push({ node: id, workspaceId: w.id, removed: true })
        }
      }
    } catch (e) { report.cleanup.push({ node: id, error: redact(e.message) }); process.exitCode = 1 }
  }
  globalThis.fetch = nativeFetch
  DshClient.prototype.streamPrompt = nativeStreamPrompt
  directory.stopAutoRefresh()
  const local = resolve(dataDir)
  assert.ok(local.startsWith(join(tmpdir(), 'wb-task57-live-')))
  await rm(local, { recursive: true, force: true })
  report.finishedAt = new Date().toISOString(); await save()
  console.log(`Live task57: ${report.checks.filter(c => c.result === 'PASS').length}/${report.checks.length}; report ${reportPath}`)
}
