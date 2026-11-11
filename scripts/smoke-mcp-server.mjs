#!/usr/bin/env node
/**
 * OneNat WorkBuddy — 对外 MCP Server 接口冒烟测试（不依赖 DSH / ONENAT 真实环境）
 *
 *   npm run smoke:mcp
 *
 * 验收面：拉起 mock ONENAT + dist/server.js（临时数据目录 + AI 令牌）→ 走一遍标准 MCP
 * Streamable HTTP 全链路 → 断言 → 清理。退出码非 0 即失败。
 *
 * 覆盖：
 *  1. 鉴权：无令牌访问 /mcp → 401；错误令牌 → 401
 *  2. GET /mcp → 405（无服务端主动推送）；DELETE /mcp → 204 会话结束
 *  3. initialize 握手：协议版本 / serverInfo / Mcp-Session-Id 签发；SSE Accept 下以 event-stream 回包
 *  4. tools/list：与工具通道全量同步（数量一致、同名、inputSchema 存在）；含 workbuddy_backlog_manage
 *  5. tools/call：真实调用 workbuddy_task_manage(list) 结构化回包；未知工具 → isError
 *     tools/call：workbuddy_backlog_manage(projects) 返回可解析 JSON 且 ok=true（无项目环境为空数组）
 *  6. 幂等回放：同会话 + 同 JSON-RPC id + 同参数重复投递 → 不重复执行（/api/mcp/status 的 replays 递增）
 *  7. 未知方法 → -32601；会话校验：假会话 id → -32001
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.SMOKE_MCP_PORT || 18095)
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT || 18080)
const PREFIX = '/onenat-workbuddy'
const BASE = `http://127.0.0.1:${PORT}`
const TOKEN = 'smoke-mcp-token-0123456789abcdef'

const results = []
let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  if (!ok) failures++
  results.push(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function rawReq(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = undefined }
  return { status: res.status, text, json, headers: res.headers }
}

const authHeaders = (extra = {}) => ({ Authorization: `Bearer ${TOKEN}`, ...extra })

async function waitFor(cond, label, timeoutMs = 20000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try { if (await cond()) return true } catch { /* retry */ }
    await sleep(200)
  }
  throw new Error(`等待超时: ${label}`)
}

// ---------------------------------------------------------------- 启动 mock ONENAT + 服务

const mock = spawn('node', [join(ROOT, 'scripts/mock-onenat.cjs')], {
  env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
  stdio: 'ignore',
})
const dataDir = mkdtempSync(join(tmpdir(), 'wb-mcp-smoke-'))
// wbmcp.sh 缓存固定名称的 session 文件；独立 TMPDIR 避免读写开发者真实会话。
const scriptTmpDir = mkdtempSync(join(dataDir, 'script-tmp-'))
const scriptPath = join(ROOT, 'skills/workbuddy-mcp/scripts/wbmcp.sh')
const app = spawn('node', [join(ROOT, 'dist/server.js'), '--port', String(PORT), '--quiet'], {
  env: {
    ...process.env,
    WORKBUDDY_HOME: dataDir,
    WORKBUDDY_TOKEN: TOKEN,
    ONENAT_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    ONENAT_API_KEY: 'smoke-mock-key',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let appLog = ''
app.stdout.on('data', (c) => { appLog += c })
app.stderr.on('data', (c) => { appLog += c })

async function main() {
  await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok, 'server up')
  await waitFor(async () => {
    const s = await rawReq('GET', `${PREFIX}/api/mcp/status`, undefined, authHeaders())
    return s.status === 200
  }, 'mcp status endpoint')

  console.log('\n== MCP Server 冒烟 ==\n')

  // 1. 鉴权
  const noAuth = await rawReq('POST', `${PREFIX}/mcp`, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  check('鉴权：无令牌 POST /mcp → 401', noAuth.status === 401, `status=${noAuth.status}`)
  const badAuth = await rawReq('POST', `${PREFIX}/mcp`, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { Authorization: 'Bearer wrong-token' })
  check('鉴权：错误令牌 POST /mcp → 401', badAuth.status === 401, `status=${badAuth.status}`)

  // 2. GET /mcp → 405
  const getMcp = await rawReq('GET', `${PREFIX}/mcp`, undefined, authHeaders())
  check('传输：GET /mcp → 405（无服务端推送）', getMcp.status === 405, `status=${getMcp.status}`)

  // 3. initialize 握手（JSON）
  const init = await rawReq('POST', `${PREFIX}/mcp`, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke-mcp', version: '0.0.1' } },
  }, authHeaders())
  const sessionId = init.headers.get('mcp-session-id') || ''
  check('initialize：200 + JSON-RPC result', init.status === 200 && init.json?.result, `status=${init.status}`)
  check('initialize：protocolVersion=2024-11-05', init.json?.result?.protocolVersion === '2024-11-05', String(init.json?.result?.protocolVersion))
  check('initialize：serverInfo.name=onenat-workbuddy', init.json?.result?.serverInfo?.name === 'onenat-workbuddy', String(init.json?.result?.serverInfo?.name))
  check('initialize：签发 Mcp-Session-Id', Boolean(sessionId), sessionId.slice(0, 8) + '…')
  check('initialize：capabilities.tools 开放', init.json?.result?.capabilities?.tools?.listChanged === false)

  // initialize（SSE Accept）→ text/event-stream 单帧回包
  const sseRes = await fetch(BASE + `${PREFIX}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...authHeaders() },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'sse-1', method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 'sse-client' } } }),
  })
  const sseText = await sseRes.text()
  const sseIsSse = (sseRes.headers.get('content-type') || '').includes('text/event-stream')
  const ssePayload = (() => { try { return JSON.parse(sseText.split('data: ')[1]) } catch { return undefined } })()
  check('initialize：SSE Accept → text/event-stream 回包', sseIsSse && ssePayload?.result?.serverInfo?.name === 'onenat-workbuddy', `ct=${sseRes.headers.get('content-type')}`)

  // 4. tools/list（需要会话头）
  const list = await rawReq('POST', `${PREFIX}/mcp`, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, authHeaders({ 'Mcp-Session-Id': sessionId }))
  const tools = list.json?.result?.tools || []
  const httpList = await rawReq('GET', `${PREFIX}/api/tools`, undefined, authHeaders())
  const httpTools = httpList.json?.tools || []
  check('tools/list：200 + 非空', list.status === 200 && tools.length > 0, `${tools.length} 个工具`)
  check('tools/list：与 HTTP 工具通道全量同步', tools.length === httpTools.length && httpTools.every((t) => tools.some((m) => m.name === t.name)), `mcp=${tools.length} http=${httpTools.length}`)
  check('tools/list：HTTP inputSchema 与 MCP 完全同源', httpTools.length === tools.length && tools.length >= 16 && httpTools.every((t) => JSON.stringify(t.inputSchema) === JSON.stringify(tools.find((m) => m.name === t.name)?.inputSchema)))
  const noActionTools = ['workbuddy_task_status', 'workbuddy_task_chat', 'workbuddy_task_evaluate', 'workbuddy_task_ask_answer', 'workbuddy_capabilities']
  const schemaOf = (name) => tools.find((t) => t.name === name)?.inputSchema
  const propertyOf = (name, field) => schemaOf(name)?.properties?.[field]
  const variants = (schema) => [schema, ...(schema?.anyOf || []), ...(schema?.oneOf || [])].filter(Boolean)
  const hasType = (schema, type) => variants(schema).some((s) => s.type === type || Array.isArray(s.type) && s.type.includes(type))
  function schemaErrors(schema, path = '$') {
    if (!schema || typeof schema !== 'object') return [`${path}: missing schema`]
    const errors = []
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => !Object.hasOwn(schema.properties || {}, key)))) errors.push(`${path}: required not in properties`)
    if (hasType(schema, 'array') && schema.type === 'array' && !schema.items) errors.push(`${path}: array missing items`)
    for (const [key, child] of Object.entries(schema.properties || {})) errors.push(...schemaErrors(child, `${path}.${key}`))
    if (schema.items && typeof schema.items === 'object') errors.push(...schemaErrors(schema.items, `${path}[]`))
    for (const keyword of ['anyOf', 'oneOf', 'allOf']) for (const [i, child] of (schema[keyword] || []).entries()) errors.push(...schemaErrors(child, `${path}.${keyword}[${i}]`))
    return errors
  }
  const invalidSchemas = tools.flatMap((t) => schemaErrors(t.inputSchema).map((e) => `${t.name} ${e}`))
  check('tools/list：全部 object schema，required 均属于 properties（含嵌套）', tools.length >= 16 && tools.every((t) => t.inputSchema?.type === 'object') && invalidSchemas.length === 0, invalidSchemas.join('; '))
  check('tools/list：无 action 工具不声明或要求 action', noActionTools.every((n) => schemaOf(n) && !Object.hasOwn(schemaOf(n).properties || {}, 'action') && !(schemaOf(n).required || []).includes('action')))
  check('tools/list：其余工具声明并要求 action', tools.filter((t) => !noActionTools.includes(t.name)).every((t) => t.inputSchema?.properties?.action && t.inputSchema.required?.includes('action')))
  for (const [name, field] of [['workbuddy_task_manage', 'memberAgentIds'], ['workbuddy_task_ask_answer', 'answers'], ['workbuddy_backlog_manage', 'itemIds']]) {
    const array = variants(propertyOf(name, field)).find((s) => s.type === 'array')
    const itemType = field === 'answers' ? 'object' : 'string'
    check(`tools/list：${name}.${field} 原生 array + ${itemType} items`, array?.items?.type === itemType)
    if (field === 'answers') check('tools/list：answers[].id 必填，selected 为字符串数组', array?.items?.required?.includes('id') && array.items.properties?.id?.type === 'string' && array.items.properties?.selected?.type === 'array' && array.items.properties.selected.items?.type === 'string')
  }
  for (const [name, field] of [['workbuddy_project_manage', 'project'], ['workbuddy_schedule_manage', 'schedule'], ['workbuddy_team_manage', 'team'], ['workbuddy_task_manage', 'nodeRef']]) {
    check(`tools/list：${name}.${field} 具有结构化对象定义`, variants(propertyOf(name, field)).some((s) => hasType(s, 'object') && (Object.keys(s.properties || {}).length > 0 || [...(s.oneOf || []), ...(s.anyOf || [])].some((v) => Object.keys(v.properties || {}).length > 0))))
  }
  check('tools/list：会话管理工具在列（task_manage/task_chat/task_status）', ['workbuddy_task_manage', 'workbuddy_task_chat', 'workbuddy_task_status'].every((n) => tools.some((t) => t.name === n)))
  check('tools/list：含 backlog 工具 workbuddy_backlog_manage', tools.some((t) => t.name === 'workbuddy_backlog_manage'))

  // 5. tools/call：真实调用（任务列表，无需真实 LLM）
  const call = await rawReq('POST', `${PREFIX}/mcp`, {
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'workbuddy_task_manage', arguments: { action: 'list' } },
  }, authHeaders({ 'Mcp-Session-Id': sessionId }))
  const callText = call.json?.result?.content?.[0]?.text || ''
  let callParsed
  try { callParsed = JSON.parse(callText) } catch { /* ignore */ }
  check('tools/call：200 + content[0].type=text', call.status === 200 && call.json?.result?.content?.[0]?.type === 'text')
  check('tools/call：workbuddy_task_manage(list) 结构化成功', callParsed?.ok === true, `isError=${call.json?.result?.isError} 前缀=${callText.slice(0, 60)}`)
  check('tools/call：isError=false', call.json?.result?.isError === false)

  // 5b. tools/call：backlog 工具（该环境无项目 → projects 应为空数组，空数组同样是 ok:true）
  const backlogCall = await rawReq('POST', `${PREFIX}/mcp`, {
    jsonrpc: '2.0', id: 'bl-1', method: 'tools/call',
    params: { name: 'workbuddy_backlog_manage', arguments: { action: 'projects' } },
  }, authHeaders({ 'Mcp-Session-Id': sessionId }))
  const backlogText = backlogCall.json?.result?.content?.[0]?.text || ''
  let backlogParsed
  try { backlogParsed = JSON.parse(backlogText) } catch { /* ignore */ }
  check('tools/call：backlog projects 返回可解析 JSON 且 ok=true',
    backlogCall.json?.result?.isError === false && backlogParsed?.ok === true,
    `isError=${backlogCall.json?.result?.isError} 前缀=${backlogText.slice(0, 80)}`)
  check('tools/call：无项目环境 projects 为空数组', Array.isArray(backlogParsed?.projects) && backlogParsed.projects.length === 0,
    `projects=${JSON.stringify(backlogParsed?.projects)?.slice(0, 80)}`)

  // task-82：同一参数通过 HTTP、原生 MCP、实际 bash 客户端，统一剥传输信封。
  let contractRpcId = 100
  async function invoke(channel, name, args) {
    if (channel === 'http') {
      const response = await rawReq('POST', `${PREFIX}/api/tools/${name}`, args, authHeaders())
      check(`跨通道 HTTP ${name}：200 工具信封`, response.status === 200 && response.json?.ok === true && response.json?.tool === name, response.text.slice(0, 160))
      return response.json?.result
    }
    if (channel === 'mcp') {
      const response = await rawReq('POST', `${PREFIX}/mcp`, {
        jsonrpc: '2.0', id: ++contractRpcId, method: 'tools/call', params: { name, arguments: args },
      }, authHeaders({ 'Mcp-Session-Id': sessionId }))
      const envelope = response.json?.result
      let result
      try { result = JSON.parse(envelope?.content?.[0]?.text || '') } catch { /* assertion below */ }
      check(`跨通道 MCP ${name}：文本 JSON + isError 对齐`, response.status === 200 && envelope?.content?.[0]?.type === 'text' && result && envelope.isError === (result.ok === false), response.text.slice(0, 160))
      return result
    }
    return await new Promise((resolveCall) => {
      const child = spawn('bash', [scriptPath, 'call', name, JSON.stringify(args)], {
        cwd: ROOT,
        env: { ...process.env, TMPDIR: scriptTmpDir, WORKBUDDY_BASE_URL: BASE + PREFIX, WORKBUDDY_TOKEN: TOKEN },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = '', stderr = '', spawnError = ''
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.on('error', (err) => { spawnError = String(err) })
      const timeout = setTimeout(() => child.kill('SIGKILL'), 20000)
      child.on('close', (code) => {
        clearTimeout(timeout)
        let result
        try { result = JSON.parse(stdout) } catch { /* assertion below */ }
        // 脚本将工具业务失败映射为非零退出，stdout 仍保留原始结构化结果。
        check(`跨通道 bash ${name}：JSON 与退出状态对齐`, result && (result.ok === false ? Number.isInteger(code) && code > 0 : code === 0), `${spawnError} exit=${code} stdout=${stdout.slice(0, 160)} stderr=${stderr.slice(-160)}`)
        resolveCall(result)
      })
    })
  }
  const channels = ['http', 'mcp', 'bash']
  const missingProject = 'project-task82-missing'
  const draftArgs = { action: 'create', title: 'task-82 isolated cross-channel draft', memberAgentIds: [] }
  let draftId
  for (const channel of channels) {
    const created = await invoke(channel, 'workbuddy_task_manage', draftArgs)
    check(`${channel}：create 无 message + memberAgentIds:[] 保持 draft`, created?.ok === true && created.status === 'draft' && created.running === false && typeof created.taskId === 'string', JSON.stringify(created))
    if (!draftId && created?.taskId) draftId = created.taskId
    check(`${channel}：相同合法 create 样例复用同一 draft`, Boolean(draftId) && created?.taskId === draftId)
  }
  for (const channel of channels) {
    const overview = await invoke(channel, 'workbuddy_task_status', {})
    check(`${channel}：status {} 无 action/taskId 返回任务概览`, overview?.ok === true && Array.isArray(overview.tasks) && overview.tasks.some((task) => task.id === draftId && task.status === 'draft' && task.running === false), JSON.stringify(overview))
    const status = await invoke(channel, 'workbuddy_task_status', { taskId: draftId || 'task-task82-missing', detail: 'full' })
    check(`${channel}：status 无 action，draft 无成员、无执行轮次`, status?.ok === true && status.running === false && status.task?.status === 'draft' && Array.isArray(status.task?.memberAgentIds) && status.task.memberAgentIds.length === 0 && Array.isArray(status.task?.turns) && status.task.turns.length === 0, String(JSON.stringify(status)).slice(0, 240))
    const answer = await invoke(channel, 'workbuddy_task_ask_answer', { taskId: draftId || 'task-task82-missing', answers: [{ id: 'q-task82', selected: ['choice-1'], custom: 'smoke' }] })
    check(`${channel}：answers 原生数组到达本地业务（无挂起提问）`, answer?.ok === false && answer.code !== 'INVALID_PARAMS' && /没有找到挂起/.test(answer.error || ''), JSON.stringify(answer))
    const dispatch = await invoke(channel, 'workbuddy_backlog_manage', { action: 'dispatch', projectId: missingProject, itemIds: ['TASK-82'] })
    check(`${channel}：dispatch itemIds 原生数组到达业务 NOT_FOUND`, dispatch?.ok === false && dispatch.code === 'NOT_FOUND' && (dispatch.error || '').includes(missingProject), JSON.stringify(dispatch))
    // 兼容旧客户端 JSON strings，仍须执行同样的结构验证。
    const legacy = await invoke(channel, 'workbuddy_backlog_manage', { action: 'dispatch', projectId: missingProject, itemIds: '["TASK-82"]' })
    check(`${channel}：legacy JSON array string 到达业务 NOT_FOUND`, legacy?.ok === false && legacy.code === 'NOT_FOUND', JSON.stringify(legacy))
    const warnings = await invoke(channel, 'workbuddy_task_manage', { action: 'list', task82Unknown: 'ignored', task82OtherUnknown: 'ignored too' })
    check(`${channel}：未知字段 warnings:string[] 且调用成功`, warnings?.ok === true && Array.isArray(warnings.paramWarnings) && warnings.paramWarnings.length >= 2 && warnings.paramWarnings.every((warning) => typeof warning === 'string'), String(JSON.stringify(warnings)).slice(0, 240))
  }
  const invalidCases = [
    { label: 'memberAgentIds 对象不能冒充数组', tool: 'workbuddy_task_manage', args: { action: 'create', memberAgentIds: {} }, path: 'memberAgentIds' },
    { label: 'answers 对象不能冒充数组', tool: 'workbuddy_task_ask_answer', args: { taskId: draftId || 'task-task82-missing', answers: {} }, path: 'answers' },
    { label: 'itemIds 对象不能冒充数组', tool: 'workbuddy_backlog_manage', args: { action: 'dispatch', projectId: missingProject, itemIds: {} }, path: 'itemIds' },
    { label: 'project 数组不能冒充对象', tool: 'workbuddy_project_manage', args: { action: 'upsert', project: [] }, path: 'project' },
    { label: 'answers 嵌套必填 id', tool: 'workbuddy_task_ask_answer', args: { taskId: draftId || 'task-task82-missing', answers: [{ selected: [] }] }, path: 'answers.0.id' },
    { label: 'nodeRef mapping 分支必填 mappingId', tool: 'workbuddy_task_manage', args: { action: 'create', nodeRef: { kind: 'mapping' } }, path: 'nodeRef.mappingId' },
    { label: '未知 action', tool: 'workbuddy_task_manage', args: { action: 'task82-unknown' }, path: 'action' },
    { label: 'send 分支缺 taskId', tool: 'workbuddy_task_manage', args: { action: 'send', message: 'never executed' }, path: 'taskId' },
    { label: 'send 分支缺 message', tool: 'workbuddy_task_manage', args: { action: 'send', taskId: draftId || 'task-task82-missing' }, path: 'message' },
    { label: 'dispatch 分支缺 itemId/itemIds', tool: 'workbuddy_backlog_manage', args: { action: 'dispatch', projectId: missingProject }, path: 'itemId' },
  ]
  const normalizedPath = (path) => path.replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1').replace(/^\//, '').replace(/\//g, '.')
  for (const sample of invalidCases) {
    for (const channel of channels) {
      const result = await invoke(channel, sample.tool, sample.args)
      check(`${channel}：${sample.label} → INVALID_PARAMS + 字段错误`, result?.ok === false && result.code === 'INVALID_PARAM' && Array.isArray(result.errors) && result.errors.length > 0 && result.errors.every((error) => typeof error.path === 'string' && typeof error.message === 'string' && error.message.length > 0) && result.errors.some((error) => normalizedPath(error.path) === sample.path) && (result.paramWarnings === undefined || Array.isArray(result.paramWarnings) && result.paramWarnings.every((warning) => typeof warning === 'string')), JSON.stringify(result))
    }
  }
  // task-86：缺参和真实不存在必须可区分，恢复步骤不能盲目重试写操作。
  const errorContract = (result) => result?.ok === false && typeof result.code === 'string' && typeof result.message === 'string' && result.message.length > 0 && typeof result.retryable === 'boolean' && typeof result.recovery?.kind === 'string'
  const errorCases = [
    { label: '缺 projectId', tool: 'workbuddy_backlog_manage', args: { action: 'list' }, code: 'INVALID_PARAM', field: 'projectId' },
    { label: '缺 taskId', tool: 'workbuddy_task_manage', args: { action: 'send', message: 'never executed' }, code: 'INVALID_PARAM', field: 'taskId' },
    { label: '真实项目不存在', tool: 'workbuddy_backlog_manage', args: { action: 'list', projectId: missingProject }, code: 'NOT_FOUND' },
    { label: '真实任务不存在', tool: 'workbuddy_task_status', args: { taskId: 'task-task86-missing' }, code: 'NOT_FOUND' },
  ]
  for (const sample of errorCases) {
    for (const channel of ['http', 'mcp']) {
      const result = await invoke(channel, sample.tool, sample.args)
      check(`${channel}：${sample.label} → ${sample.code} + 恢复契约`, errorContract(result) && result.code === sample.code && result.retryable === false && (sample.field ? result.field === sample.field && result.recovery.kind === 'correct_parameters' && result.recovery.fields?.includes(sample.field) : result.recovery.kind === 'stop'), JSON.stringify(result))
    }
  }
  // 所有样例完成后仍仅有那一个本地 draft，证明非法调用与 dispatch 没有暗中派活。
  const finalTasks = await invoke('http', 'workbuddy_task_status', {})
  check('跨通道：测试仅创建一个未运行 draft，无自动派活', finalTasks?.ok === true && finalTasks.tasks?.length === 1 && finalTasks.tasks[0].id === draftId && finalTasks.tasks[0].status === 'draft' && finalTasks.tasks[0].running === false, JSON.stringify(finalTasks))

  // 未知工具 → isError
  const badCall = await rawReq('POST', `${PREFIX}/mcp`, {
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'workbuddy_not_exist', arguments: {} },
  }, authHeaders({ 'Mcp-Session-Id': sessionId }))
  check('tools/call：未知工具 → isError=true', badCall.json?.result?.isError === true, String(badCall.json?.result?.isError))
  const missingTool = JSON.parse(badCall.json?.result?.content?.[0]?.text || '{}')
  check('tools/call：未知工具 → TOOL_NOT_FOUND + stop', errorContract(missingTool) && missingTool.code === 'TOOL_NOT_FOUND' && missingTool.retryable === false && missingTool.recovery.kind === 'stop', JSON.stringify(missingTool))

  // 6. 幂等回放：同会话 + 同 id + 同参数重复投递
  const replayPayload = { jsonrpc: '2.0', id: 'rp-1', method: 'tools/call', params: { name: 'workbuddy_task_manage', arguments: { action: 'list' } } }
  const r1 = await rawReq('POST', `${PREFIX}/mcp`, replayPayload, authHeaders({ 'Mcp-Session-Id': sessionId }))
  const statusMid = await rawReq('GET', `${PREFIX}/api/mcp/status`, undefined, authHeaders())
  const replaysMid = statusMid.json?.mcp?.replays ?? -1
  const r2 = await rawReq('POST', `${PREFIX}/mcp`, replayPayload, authHeaders({ 'Mcp-Session-Id': sessionId }))
  const statusEnd = await rawReq('GET', `${PREFIX}/api/mcp/status`, undefined, authHeaders())
  const replaysEnd = statusEnd.json?.mcp?.replays ?? -1
  check('幂等回放：重复投递应答一致', r1.status === 200 && r2.status === 200 && r2.json?.result?.content?.[0]?.text === r1.json?.result?.content?.[0]?.text)
  check('幂等回放：replays 计数递增（未重复执行）', replaysEnd === replaysMid + 1, `before=${replaysMid} after=${replaysEnd}`)
  check('状态端点：/api/mcp/status 暴露统计', typeof statusEnd.json?.mcp?.calls === 'number' && statusEnd.json?.mcp?.endpoint?.endsWith('/mcp'))

  // 7. 未知方法 / 假会话 / DELETE
  const unknown = await rawReq('POST', `${PREFIX}/mcp`, { jsonrpc: '2.0', id: 9, method: 'resources/read', params: { uri: 'file:///x' } }, authHeaders({ 'Mcp-Session-Id': sessionId }))
  check('未知方法：resources/read → -32000 未开放', unknown.json?.error?.code === -32000, JSON.stringify(unknown.json?.error))
  const notFound = await rawReq('POST', `${PREFIX}/mcp`, { jsonrpc: '2.0', id: 10, method: 'no/such/method' }, authHeaders({ 'Mcp-Session-Id': sessionId }))
  check('未知方法：-32601 Method not found', notFound.json?.error?.code === -32601)
  const fakeSession = await rawReq('POST', `${PREFIX}/mcp`, { jsonrpc: '2.0', id: 11, method: 'tools/list' }, authHeaders({ 'Mcp-Session-Id': 'not-a-real-session' }))
  check('会话校验：假会话 → -32001 要求重新 initialize', fakeSession.json?.error?.code === -32001)
  check('JSON-RPC：未知方法保留 numeric code，data 含统一错误', errorContract(notFound.json?.error?.data) && notFound.json.error.data.code === 'METHOD_NOT_FOUND' && notFound.json.error.data.retryable === false)
  check('JSON-RPC：过期会话恢复只重新握手', errorContract(fakeSession.json?.error?.data) && fakeSession.json.error.data.code === 'SESSION_EXPIRED' && fakeSession.json.error.data.recovery.kind === 'call' && fakeSession.json.error.data.recovery.tool === 'initialize' && fakeSession.json.error.data.retryable === false)
  const del = await rawReq('DELETE', `${PREFIX}/mcp`, undefined, authHeaders({ 'Mcp-Session-Id': sessionId }))
  check('DELETE /mcp：204 会话结束', del.status === 204, `status=${del.status}`)
  const afterDel = await rawReq('POST', `${PREFIX}/mcp`, { jsonrpc: '2.0', id: 12, method: 'tools/list' }, authHeaders({ 'Mcp-Session-Id': sessionId }))
  check('DELETE 后旧会话失效 → -32001', afterDel.json?.error?.code === -32001, `status=${afterDel.status}`)

  console.log(results.join('\n'))
  console.log(`\n== 结果：${results.length - failures}/${results.length} 通过 ==\n`)
  if (failures > 0) {
    console.log(`--- 服务日志（尾部）---\n${appLog.split('\n').slice(-40).join('\n')}`)
  }
  process.exitCode = failures > 0 ? 1 : 0
}

main().catch((err) => {
  console.error(`冒烟失败: ${err?.stack || err}`)
  console.log(`--- 服务日志（尾部）---\n${appLog.split('\n').slice(-40).join('\n')}`)
  process.exitCode = 1
}).finally(() => {
  app.kill('SIGTERM')
  mock.kill('SIGTERM')
  setTimeout(() => {
    try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }, 500)
})
