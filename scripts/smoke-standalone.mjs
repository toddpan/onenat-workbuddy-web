#!/usr/bin/env node
/**
 * OneNat WorkBuddy — 独立部署模式本地冒烟测试（不依赖 DSH 运行）
 *
 *   node scripts/smoke-standalone.mjs            # 全链路（除真实 LLM 派发）
 *   SMOKE_E2E=1 node scripts/smoke-standalone.mjs # 追加真实派发端到端（需本机 DSH web 在 3080）
 *
 * 做的事：拉起 mock ONENAT + dist/server.js（临时数据目录）→ 打一遍 REST/工具通道/控制台 →
 * 断言结果 → 清理进程与临时目录。退出码非 0 即失败。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.SMOKE_PORT || 18091)
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT || 18080)
const PREFIX = '/onenat-workbuddy'
const BASE = `http://127.0.0.1:${PORT}`
const E2E = process.env.SMOKE_E2E === '1'

const results = []
let failures = 0

function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  if (!ok) failures++
  results.push(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`)
}

let COOKIE = ''

async function req(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(COOKIE ? { Cookie: COOKIE } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: res.status, text, json, headers: res.headers }
}

/** 登录并保存会话 Cookie */
async function login(username, password) {
  const res = await fetch(BASE + `${PREFIX}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  COOKIE = (res.headers.get('set-cookie') || '').split(';')[0]
  let json
  try {
    json = await res.json()
  } catch {
    json = undefined
  }
  return { status: res.status, json }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(cond, label, timeoutMs = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      if (await cond()) return true
    } catch {
      /* retry */
    }
    await sleep(250)
  }
  throw new Error(`等待超时: ${label}`)
}

const procs = []
function spawnJob(name, cmd, args, env = {}) {
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const tag = `[${name}]`
  const lines = []
  child.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean).map((l) => `${tag} ${l}`)))
  child.stderr.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean).map((l) => `${tag} ${l}`)))
  child.logs = lines
  procs.push(child)
  return child
}

function cleanup() {
  for (const p of procs) {
    try {
      p.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  if (!existsSync(join(ROOT, 'dist', 'server.js'))) {
    console.error('缺少 dist/server.js —— 先执行: bash scripts/build-standalone.sh')
    process.exit(1)
  }

  const dataDir = mkdtempSync(join(tmpdir(), 'workbuddy-smoke-'))
  console.log(`\n== OneNat WorkBuddy 独立部署冒烟 ==\n   数据目录 ${dataDir}\n   服务 ${BASE}${PREFIX}\n   模式 ${E2E ? '含真实派发 E2E' : '常规（不含 LLM 派发）'}\n`)

  spawnJob('mock-onenat', process.execPath, [join(ROOT, 'scripts', 'mock-onenat.cjs')], { MOCK_ONENAT_PORT: String(MOCK_PORT) })
  await waitFor(async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/api/v1/resources`, { headers: { Authorization: 'Bearer onk-mock-key-000' } })).ok, 'mock ONENAT 就绪')

  const server = spawnJob('server', process.execPath, [
    join(ROOT, 'dist', 'server.js'),
    '--port', String(PORT),
    '--data', dataDir,
    '--onenat-base-url', `http://127.0.0.1:${MOCK_PORT}`,
    '--onenat-api-key', 'onk-mock-key-000',
  ])
  await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok, 'standalone server 就绪')

  // ---------- 1. 基础可达性 ----------
  const health = await req('GET', '/healthz')
  check('GET /healthz 返回 200/ok', health.status === 200 && health.json?.ok === true)
  check('healthz 标记 standalone', health.json?.standalone === true, `version=${health.json?.version}`)

  const root = await req('GET', '/')
  check('GET / 302 跳转到控制台前缀', root.status === 302 && root.headers.get('location') === `${PREFIX}/`, `location=${root.headers.get('location')}`)

  // ---------- 登录鉴权 ----------
  const anonApi = await req('GET', `${PREFIX}/api/resources`)
  check('未登录访问业务 API 被拒（401）', anonApi.status === 401 && anonApi.json?.authRequired === true)
  const anonConsole = await req('GET', `${PREFIX}/`)
  check('未登录访问控制台返回登录页', anonConsole.status === 200 && anonConsole.text.includes('请登录后使用'))
  const badLogin = await login('workbuddy', 'wrong-password')
  COOKIE = ''
  check('错误密码被拒（401）', badLogin.status === 401)
  const okLogin = await login('workbuddy', 'ThunderSoft@88')
  check('管理员登录成功并下发会话 Cookie', okLogin.status === 200 && okLogin.json?.ok === true && COOKIE.startsWith('wb_session='), `cookie=${COOKIE.slice(0, 18)}…`)
  const me = await req('GET', `${PREFIX}/api/auth/me`)
  check('会话有效（/api/auth/me）', me.status === 200 && me.json?.data?.username === 'workbuddy')
  const authedApi = await req('GET', `${PREFIX}/api/settings`)
  check('登录后业务 API 放行', authedApi.status === 200)
  const logout = await req('POST', `${PREFIX}/api/auth/logout`)
  check('登出成功', logout.status === 200)
  const afterLogout = await req('GET', `${PREFIX}/api/resources`)
  check('登出后 API 重新被拒（401）', afterLogout.status === 401)
  await login('workbuddy', 'ThunderSoft@88')

  const consoleRes = await req('GET', `${PREFIX}/`)
  check('GET 控制台返回 HTML 单页', consoleRes.status === 200 && consoleRes.text.includes('OneNat WorkBuddy') && consoleRes.text.includes('</html>'))

  const notFound = await req('GET', '/nope')
  check('未知路径返回 404 JSON', notFound.status === 404 && notFound.json?.ok === false)

  // ---------- 2. ONENAT 资源目录 ----------
  const refresh = await req('POST', `${PREFIX}/api/resources/refresh`)
  check('ONENAT 资源刷新成功', refresh.status === 200 && refresh.json?.ok === true, `count=${refresh.json?.data?.endpoints?.length}`)
  const resources = await req('GET', `${PREFIX}/api/resources`)
  const eps = resources.json?.data?.endpoints || []
  check('资源目录含 SSH 与 DSH 端点', eps.some((e) => e.kind === 'ssh') && eps.some((e) => e.kind === 'dsh'), `kinds=${[...new Set(eps.map((e) => e.kind))].join(',')}`)
  const liveDsh = eps.find((e) => e.mappingId === 'map-dsh-live')
  check('DSH 端点解析出 /api/v1 Base URL', liveDsh?.baseUrl?.endsWith('/api/v1'), `baseUrl=${liveDsh?.baseUrl}`)
  const resolved = await req('GET', `${PREFIX}/api/resources/mappings/map-dsh-01/resolve`)
  check('单映射解析接口可用', resolved.status === 200 && resolved.json?.data?.mappingId === 'map-dsh-01')

  // ---------- 3. 设置（Key 打码） ----------
  const settings = await req('GET', `${PREFIX}/api/settings`)
  check('设置读取且 API Key 打码', settings.status === 200 && String(settings.json?.data?.onenat?.apiKey || '').includes('…'))

  // ---------- 4. 子智能体 CRUD ----------
  const created = await req('POST', `${PREFIX}/api/agents`, {
    name: '冒烟子智能体',
    dshRef: { kind: 'mapping', mappingId: 'map-dsh-live' },
    systemPrompt: '你是冒烟测试执行者',
    model: '',
  })
  const agentId = created.json?.data?.id
  check('创建子智能体（绑定 ONENAT 映射）', created.status === 200 && Boolean(agentId), `id=${agentId}`)

  const agents = await req('GET', `${PREFIX}/api/agents`)
  check('子智能体列表回读', (agents.json?.data || []).some((a) => a.id === agentId))

  const preview = await req('GET', `${PREFIX}/api/agents/${agentId}/prompt-preview`)
  check('资源提示词预览可用', preview.status === 200 && preview.json?.ok === true, `warnings=${preview.json?.warnings?.length ?? 0}`)

  // ---------- 5. 任务（不触达 LLM 的草稿路径） ----------
  const task = await req('POST', `${PREFIX}/api/tasks`, { title: '冒烟任务', memberAgentIds: [agentId], mode: 'chat' })
  const taskId = task.json?.data?.id
  check('创建任务（draft，不发起 LLM）', [200, 201].includes(task.status) && task.json?.data?.status === 'draft', `id=${taskId} http=${task.status}`)

  const renamed = await req('POST', `${PREFIX}/api/tasks/${taskId}/rename`, { title: '冒烟任务-改名' })
  check('任务重命名', renamed.status === 200 && renamed.json?.data?.title === '冒烟任务-改名')

  const archived = await req('POST', `${PREFIX}/api/tasks/${taskId}/archive`, { archived: true })
  check('任务归档', archived.status === 200)
  const tasks = await req('GET', `${PREFIX}/api/tasks`)
  check('任务列表可读', (tasks.json?.data || []).some((t) => t.id === taskId))

  // ---------- 6. 工具 HTTP 通道 ----------
  const toolList = await req('GET', `${PREFIX}/api/tools`)
  const toolNames = (toolList.json?.tools || []).map((t) => t.name)
  check('工具清单暴露 12 个工具', toolList.status === 200 && toolNames.length === 12 && toolNames.includes('workbuddy_project_manage'), toolNames.join(','))
  check('工具清单含参数 schema', (toolList.json?.tools || []).every((t) => t.parameters && typeof t.parameters === 'object'))

  const toolListCall = await req('POST', `${PREFIX}/api/tools/workbuddy_resource_manage`, { action: 'list' })
  check('工具调用 workbuddy_resource_manage', toolListCall.status === 200 && toolListCall.json?.ok === true && toolListCall.json?.result?.count > 0, `count=${toolListCall.json?.result?.count}`)

  const toolAgents = await req('POST', `${PREFIX}/api/tools/workbuddy_agent_manage`, { action: 'list' })
  check('工具调用 workbuddy_agent_manage', toolAgents.json?.ok === true && toolAgents.json?.result?.agents?.length === 1)

  const toolTasks = await req('POST', `${PREFIX}/api/tools/workbuddy_task_status`, { taskId })
  check('工具调用 workbuddy_task_status（默认摘要，小回包）', toolTasks.json?.ok === true && toolTasks.json?.result?.taskId === taskId && Boolean(toolTasks.json?.result?.status) && !toolTasks.json?.result?.task)
  const toolTasksFull = await req('POST', `${PREFIX}/api/tools/workbuddy_task_status`, { taskId, detail: 'full' })
  check('工具调用 workbuddy_task_status detail=full（完整任务）', toolTasksFull.json?.ok === true && toolTasksFull.json?.result?.task?.id === taskId)

  const toolMissing = await req('POST', `${PREFIX}/api/tools/not_a_tool`, {})
  check('未知工具返回 404', toolMissing.status === 404)

  // SSH 资源池：upsert → list(脱敏) → get(完整) → delete
  const sshUp = await req('POST', `${PREFIX}/api/tools/workbuddy_ssh_resource_manage`, {
    action: 'upsert',
    resource: { name: '冒烟主机', host: '127.0.0.1', port: 22, authType: 'password', username: 'tester', password: 'p@ss-secret' },
  })
  const sshId = sshUp.json?.result?.resource?.id
  check('SSH 资源 upsert（脱敏回显）', sshUp.json?.ok === true && Boolean(sshId) && !JSON.stringify(sshUp.json.result.resource).includes('p@ss-secret'))
  const sshList = await req('POST', `${PREFIX}/api/tools/workbuddy_ssh_resource_manage`, { action: 'list' })
  check('SSH 资源 list 脱敏', JSON.stringify(sshList.json?.result?.resources).includes('****') || !JSON.stringify(sshList.json?.result?.resources).includes('p@ss-secret'))
  const sshGet = await req('POST', `${PREFIX}/api/tools/workbuddy_ssh_resource_manage`, { action: 'get', resourceId: sshId })
  check('SSH 资源 get 返回完整凭据', sshGet.json?.result?.resource?.password === 'p@ss-secret')
  const sshDel = await req('POST', `${PREFIX}/api/tools/workbuddy_ssh_resource_manage`, { action: 'delete', resourceId: sshId })
  check('SSH 资源 delete', sshDel.json?.ok === true && sshDel.json?.result?.deleted === true)

  // ---------- 7. 数据落盘（独立服务的数据目录） ----------
  const storeFile = join(dataDir, 'store.json')
  await waitFor(() => existsSync(storeFile), 'store.json 落盘', 5000)
  const store = JSON.parse(readFileSync(storeFile, 'utf-8'))
  check('数据落盘到 --data 目录', store.agents.length === 1 && store.tasks.length === 1)

  // ---------- 8. 工具令牌保护（第二个实例） ----------
  const PORT2 = PORT + 1
  const dataDir2 = mkdtempSync(join(tmpdir(), 'workbuddy-smoke-token-'))
  spawnJob('server-token', process.execPath, [
    join(ROOT, 'dist', 'server.js'),
    '--port', String(PORT2), '--data', dataDir2, '--quiet',
    '--onenat-base-url', `http://127.0.0.1:${MOCK_PORT}`, '--onenat-api-key', 'onk-mock-key-000',
    '--token', 'secret-token',
  ])
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT2}/healthz`)).ok, '带令牌实例就绪')
  const noToken = await fetch(`http://127.0.0.1:${PORT2}${PREFIX}/api/tools`).then((r) => r.status)
  const withToken = await fetch(`http://127.0.0.1:${PORT2}${PREFIX}/api/tools`, { headers: { Authorization: 'Bearer secret-token' } }).then((r) => r.status)
  check('工具通道无令牌被拒（401）', noToken === 401, `status=${noToken}`)
  check('工具通道携带令牌放行（200）', withToken === 200, `status=${withToken}`)
  const tLogin = await fetch(`http://127.0.0.1:${PORT2}${PREFIX}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'workbuddy', password: 'ThunderSoft@88' }),
  })
  const tCookie = (tLogin.headers.get('set-cookie') || '').split(';')[0]
  const uiNoToken = await fetch(`http://127.0.0.1:${PORT2}${PREFIX}/api/resources`, { headers: { Cookie: tCookie } }).then((r) => r.status)
  check('登录会话可访问业务 API（令牌实例）', uiNoToken === 200, `status=${uiNoToken}`)
  rmSync(dataDir2, { recursive: true, force: true })

  // ---------- 9. 可选：真实派发端到端（LLM + SSE + 远端会话） ----------
  if (E2E) {
    const livePing = await req('POST', `${PREFIX}/api/agents/${agentId}/ping`)
    check('E2E: 子智能体 ping 在线', livePing.json?.data?.ping?.ok === true, JSON.stringify(livePing.json?.data?.ping?.error || livePing.json?.data?.ping?.name))

    const e2eTask = await req('POST', `${PREFIX}/api/tasks`, { title: '冒烟E2E', memberAgentIds: [agentId], mode: 'chat', message: '只回复两个字：收到' })
    const e2eId = e2eTask.json?.data?.id
    check('E2E: 任务创建并进入运行', [200, 201].includes(e2eTask.status) && e2eTask.json?.data?.status === 'running', `id=${e2eId} status=${e2eTask.json?.data?.status}`)

    let finalTask
    await waitFor(async () => {
      const t = await req('GET', `${PREFIX}/api/tasks/${e2eId}`)
      finalTask = t.json?.data
      return finalTask && (finalTask.status === 'completed' || finalTask.status === 'failed') && finalTask.turns?.length > 0
    }, 'E2E 任务结束', 300000)

    const lastTurn = finalTask.turns[finalTask.turns.length - 1]
    check('E2E: 任务完成且产出回复', finalTask.status === 'completed' && String(lastTurn.text || '').length > 0, `status=${finalTask.status} text=${String(lastTurn.text || '').slice(0, 40)}`)
    check('E2E: 远端会话已绑定', Object.values(finalTask.sessions || {}).some((s) => s.remoteSessionId))
  }

  console.log('\n== 结果 ==')
  for (const line of results) console.log(line)
  console.log(`\n${failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`}（共 ${results.length} 项）\n`)
  if (failures !== 0) {
    console.log('--- 服务日志 ---')
    for (const p of procs) for (const l of p.logs.slice(-40)) console.log(l)
  }
  return failures === 0 ? 0 : 1
}

let code = 1
try {
  code = await main()
} catch (err) {
  console.error(`\n❌ 冒烟异常: ${err?.stack || err}`)
  for (const p of procs) for (const l of p.logs.slice(-40)) console.log(l)
} finally {
  cleanup()
}
process.exit(code)
