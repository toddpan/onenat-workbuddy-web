#!/usr/bin/env node
/**
 * OneNat WorkBuddy — 小智 MCP 接入冒烟测试
 *
 *   node scripts/smoke-xiaozhi-mcp.mjs
 *
 * 方式：内置一个最小 RFC6455 WebSocket 服务端（模拟小智平台 MCP 插件，JSON-RPC 2024-11-05），
 * workbuddy 服务以 --xiaozhi-mcp 连入。平台侧行为对齐真实平台：连接建立后主动下发 initialize，
 * 随后 tools/list；并按需发 ping / tools/call。覆盖：
 *   1. initialize 握手（serverInfo=onenat-workbuddy + notifications/initialized）
 *   2. tools/list 动态映射工具通道（11 个工具，inputSchema 含 action required）
 *   3. ping 应答（id 原样回显）
 *   4. tools/call 真实调用（planner/monitor/未知工具 isError）
 *   5. /api/xiaozhi/status 状态联动
 *   6. 设置保存接入点 → 动态停用 / 重新配置 → 自动重连握手（免重启）
 *
 * 退出码非 0 即失败。
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.SMOKE_PORT || 18100)
const WS_PORT = Number(process.env.SMOKE_WS_PORT || 18101)
const MOCK_PORT = Number(process.env.SMOKE_MOCK_PORT || 18088)
const PREFIX = '/onenat-workbuddy'
const BASE = `http://127.0.0.1:${PORT}`

const results = []
let failures = 0

function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  if (!ok) failures++
  results.push(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const procs = []
function spawnJob(name, cmd, args, env = {}) {
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const lines = []
  child.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)))
  child.stderr.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)))
  child.logs = lines
  procs.push(child)
  return child
}

function cleanup() {
  for (const p of procs) {
    try {
      p.kill('SIGKILL')
    } catch { /* ignore */ }
  }
}
process.on('exit', cleanup)
process.on('SIGINT', () => process.exit(1))

// ---------- 最小 RFC6455 WebSocket 服务端（文本帧即可） ----------

function encodeTextFrame(str) {
  const payload = Buffer.from(str, 'utf-8')
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.from([0x81, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

function decodeFrames(buffer) {
  // 处理跨 chunk 粘包/半包，返回 { frames, rest }
  const frames = []
  let buf = buffer
  for (;;) {
    if (buf.length < 2) break
    const opcode = buf[0] & 0x0f
    const masked = (buf[1] & 0x80) !== 0
    let len = buf[1] & 0x7f
    let offset = 2
    if (len === 126) {
      if (buf.length < 4) break
      len = buf.readUInt16BE(2)
      offset = 4
    } else if (len === 127) {
      if (buf.length < 10) break
      len = Number(buf.readBigUInt64BE(2))
      offset = 10
    }
    const maskLen = masked ? 4 : 0
    if (buf.length < offset + maskLen + len) break
    let payload = buf.subarray(offset + maskLen, offset + maskLen + len)
    if (masked) {
      const mask = buf.subarray(offset, offset + 4)
      const un = Buffer.alloc(len)
      for (let i = 0; i < len; i++) un[i] = payload[i] ^ mask[i % 4]
      payload = un
    }
    if (opcode === 0x1) frames.push(payload.toString('utf-8'))
    buf = buf.subarray(offset + maskLen + len)
  }
  return { frames, rest: buf }
}

/**
 * 启动模拟小智平台：连接建立后下发 initialize（id=1）；
 * 收到客户端 initialize 应答后补发 notifications/initialized + tools/list（id=2）。
 * 返回 { send, onWire } —— send 发平台消息；onWire 订阅客户端来的每条消息。
 */
async function startMockPlatform() {
  const wireListeners = []
  const sockets = []
  let send = () => {}
  const server = createServer()
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    send = (m) => socket.write(encodeTextFrame(m))
    sockets.push(socket)
    socket.on('close', () => {
      const i = sockets.indexOf(socket)
      if (i >= 0) sockets.splice(i, 1)
    })
    // 平台主动下发 initialize（对齐 xiaozhi-esp32-mcp：设备端应答）
    send(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'xiaozhi-mock', version: '0.0.1' } },
    }))
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      const { frames, rest } = decodeFrames(buf)
      buf = rest
      for (const f of frames) {
        let msg
        try { msg = JSON.parse(f) } catch { continue }
        for (const fn of wireListeners) fn(msg)
        // 客户端 initialize 应答到达 → 平台继续 tools/list
        if (msg.id === 1 && msg.result?.serverInfo) {
          send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))
          send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))
        }
      }
    })
  })
  await new Promise((done) => {
    server.listen(WS_PORT, '127.0.0.1', () => done(null))
  })
  return {
    send: (m) => send(m),
    onWire: (fn) => wireListeners.push(fn),
    /** 模拟平台侧直接掐断连接（历史故障：每轮工具调用后会话被断，重连后重发同一请求） */
    closeAll: () => sockets.forEach((s) => { try { s.destroy() } catch { /* ignore */ } }),
  }
}

async function main() {
  if (!existsSync(join(ROOT, 'dist', 'server.js'))) {
    console.error('缺少 dist/server.js —— 先执行: bash scripts/build-standalone.sh')
    process.exit(1)
  }

  console.log(`\n== OneNat WorkBuddy 小智 MCP 接入冒烟 ==\n   服务 ${BASE}${PREFIX}\n   模拟平台 ws://127.0.0.1:${WS_PORT}/mcp\n`)

  const platform = await startMockPlatform()
  const received = []
  platform.onWire((m) => received.push(m))

  /** 等待客户端某条应答出现 */
  const waitForWire = async (pred, label, timeoutMs = 10000) => {
    const t0 = Date.now()
    for (;;) {
      const hit = received.find(pred)
      if (hit) return hit
      if (Date.now() - t0 > timeoutMs) throw new Error('等待超时: ' + label)
      await sleep(200)
    }
  }

  /** 平台发起一次请求并等待客户端应答 */
  const request = async (method, params) => {
    const id = Math.floor(Math.random() * 1e9)
    const p = waitForWire((m) => m.id === id && (m.result !== undefined || m.error !== undefined), `应答 ${method}`)
    platform.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    return p
  }
  const callTool = (name, args) => request('tools/call', { name, arguments: args })

  const dataDir = mkdtempSync(join(tmpdir(), 'workbuddy-xiaozhi-'))
  spawnJob('mock-onenat', process.execPath, [join(ROOT, 'scripts', 'mock-onenat.cjs')], { MOCK_ONENAT_PORT: String(MOCK_PORT) })
  spawnJob('server', process.execPath, [join(ROOT, 'dist', 'server.js'), '--port', String(PORT), '--data', dataDir,
    '--onenat-base-url', `http://127.0.0.1:${MOCK_PORT}`, '--onenat-api-key', 'onk-mock-key-000', '--quiet',
    '--xiaozhi-mcp', `ws://127.0.0.1:${WS_PORT}/mcp`])

  const t0 = Date.now()
  for (;;) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break
    } catch { /* retry */ }
    if (Date.now() - t0 > 30000) throw new Error('服务启动超时')
    await sleep(400)
  }

  // ---------- 1. initialize 握手 ----------
  const initResp = await waitForWire((m) => m.id === 1 && m.result?.serverInfo, 'initialize 应答')
  check('initialize 应答 serverInfo=onenat-workbuddy · 协议 2024-11-05', initResp.result?.serverInfo?.name === 'onenat-workbuddy' && initResp.result?.protocolVersion === '2024-11-05', JSON.stringify(initResp.result?.serverInfo))
  await waitForWire((m) => m.method === 'notifications/initialized', 'notifications/initialized')
  check('握手后发送 notifications/initialized', true)

  // ---------- 2. tools/list ----------
  const listResp = await waitForWire((m) => m.id === 2 && m.result?.tools, 'tools/list 应答')
  const tools = listResp.result?.tools || []
  const toolNames = tools.map((t) => t.name)
  check('tools/list 动态映射 11 个工具', toolNames.length === 11, toolNames.join(','))
  const schema = tools.find((t) => t.name === 'workbuddy_task_manage')?.inputSchema
  check('inputSchema 由参数表生成（action required）', Boolean(schema?.properties?.action) && Array.isArray(schema?.required) && schema.required.includes('action'))

  // ---------- 3. ping ----------
  const pingResp = await request('ping', {})
  check('ping 应答 id 原样回显 result={}', pingResp.id && JSON.stringify(pingResp.result) === '{}')

  // ---------- 4. tools/call 真实调用 ----------
  const plannerCall = await callTool('workbuddy_planner_manage', { action: 'get' })
  check('tools/call → planner_manage get 真实执行', plannerCall.result?.isError === false && (plannerCall.result?.content?.[0]?.text || '').includes('"planner"'))
  const monitorCall = await callTool('workbuddy_monitor_read', { action: 'overview' })
  check('tools/call → monitor_read overview', monitorCall.result?.isError === false && (monitorCall.result?.content?.[0]?.text || '').includes('"kpi"'))
  const badCall = await callTool('workbuddy_no_such_tool', {})
  check('未知工具 → isError=true', badCall.result?.isError === true && (badCall.result?.content?.[0]?.text || '').includes('工具不存在'))

  // ---------- 4b. 幂等 / 立即回执 / 非阻塞（回归「一次请求建出三个任务」） ----------
  /** 平台用固定 id 发起请求（同 id 重投用于验证幂等回放）；priorCount = 已收到的同 id 应答数 */
  const requestWithId = async (id, method, params, priorCount = 0) => {
    const p = (async () => {
      const t = Date.now()
      for (;;) {
        const hits = received.filter((m) => m.id === id && (m.result !== undefined || m.error !== undefined))
        if (hits.length > priorCount) return hits[hits.length - 1]
        if (Date.now() - t > 10000) throw new Error(`等待超时: 应答 ${method}#${id}`)
        await sleep(200)
      }
    })()
    platform.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    return p
  }
  const textOf = (resp) => resp?.result?.content?.[0]?.text || ''
  const jsonOf = (resp) => { try { return JSON.parse(textOf(resp)) } catch { return {} } }

  // 先备一个执行者。
  // 注意：这里刻意用「直连死端口」而不是 mock 的 map-dsh-live —— 后者指向真实的本地 DSH(3080)，
  // 本段会真的带 message 建任务并派发，不能把冒烟流量打到真实实例上。
  const agentUp = jsonOf(await callTool('workbuddy_agent_manage', { action: 'upsert', agent: { name: '小智冒烟执行者', dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:9' } } }))
  const agentId = agentUp?.agent?.id
  check('准备：upsert 子智能体（幂等回归用）', Boolean(agentId), String(agentId))

  // ① 同 id + 同参数重投 → 原样回放，绝不第二次执行（平台侧重投/重连重发的主要防线）
  const replayId = 900001
  // 标题刻意 >6 字：避免命中「首轮消息后自动提炼标题」的分支，保证按标题断言稳定
  const createArgs = { action: 'create', title: '幂等回归验证任务标题', message: '幂等回归任务内容', memberAgentIds: [agentId] }
  const firstCall = await requestWithId(replayId, 'tools/call', { name: 'workbuddy_task_manage', arguments: createArgs }, 0)
  const firstJson = jsonOf(firstCall)
  const createdTaskId = firstJson?.taskId
  const secondCall = await requestWithId(replayId, 'tools/call', { name: 'workbuddy_task_manage', arguments: createArgs }, 1)
  check('同 id 同参数重投 → 原样回放（未重复执行）', textOf(firstCall) === textOf(secondCall) && Boolean(createdTaskId), `taskId=${createdTaskId}`)
  check('create 立即回执（accepted + taskId，不回全量 task）', firstJson?.accepted === true && Boolean(createdTaskId) && firstJson?.task === undefined && typeof firstJson?.nextAction === 'string')

  // ② 不同 id、同内容（模拟平台整轮重跑换新 id）→ 业务级去重复用既有任务
  const dupResp = jsonOf(await callTool('workbuddy_task_manage', createArgs))
  check('同内容不同 id（<2min）→ 复用既有任务不新建', dupResp?.deduped === true && dupResp?.taskId === createdTaskId, `taskId=${dupResp?.taskId}`)

  // ③ 换措辞重试（模型重生成参数：首句相同、中段措辞不同）→ 首句去重复用，仍不新建
  const reworded = await requestWithId(900100, 'tools/call', { name: 'workbuddy_task_manage', arguments: {
    action: 'create', title: '幂等回归验证任务（换措辞版）',
    message: '幂等回归任务内容。步骤一：核对清单；步骤二：输出结果报告。',
    memberAgentIds: [agentId],
  } })
  const rewordedJson = jsonOf(reworded)
  const rewordedTaskId = rewordedJson?.taskId
  check('换措辞重试（同首句 <5min）→ 首句去重复用既有任务', rewordedJson?.deduped === true && rewordedTaskId === createdTaskId && rewordedJson?.approximate === true, `taskId=${rewordedTaskId}`)
  // ④ 不同首句 = 真正的新任务 → 正常创建（不被误合并）
  const fresh = await requestWithId(900200, 'tools/call', { name: 'workbuddy_task_manage', arguments: {
    action: 'create', title: '另一个真实新任务', message: '查询当前节点磁盘剩余空间并汇报。',
    memberAgentIds: [agentId],
  } })
  const freshJson = jsonOf(fresh)
  check('不同首句的新任务正常创建（不被近似去重误合并）', freshJson?.deduped === undefined && Boolean(freshJson?.taskId) && freshJson?.taskId !== createdTaskId, `taskId=${freshJson?.taskId}`)

  // ③ 任务列表：重复投递只应落一个
  const taskListResp = jsonOf(await callTool('workbuddy_task_manage', { action: 'list' }))
  const sameTitle = (taskListResp?.tasks || []).filter((t) => t.title === createArgs.title)
  check('重复投递只落一个任务', sameTitle.length === 1, `count=${sameTitle.length}`)
  const sameTitleIds = sameTitle.map((t) => t.id)
  check('去重后仍是同一个任务 id', sameTitleIds.length === 1 && sameTitleIds[0] === createdTaskId, sameTitleIds.join(','))

  // ③b 同任务同正文重复 send（整轮重跑的另一种形态）→ 去重忽略
  const sendArgs = { action: 'send', taskId: createdTaskId, message: '重复投递回归消息' }
  await callTool('workbuddy_task_manage', sendArgs)
  const sendDup = jsonOf(await callTool('workbuddy_task_manage', sendArgs))
  check('同任务同正文重复 send → 去重忽略', sendDup?.deduped === true, JSON.stringify(sendDup).slice(0, 120))

  // ④ wait 在 MCP 通道不阻塞：立即快照 + 明确的 nextAction（长任务异步化的核心约定）
  const waitT0 = Date.now()
  const waitResp = jsonOf(await callTool('workbuddy_task_manage', { action: 'wait', taskId: createdTaskId }))
  const waitMs = Date.now() - waitT0
  check('MCP 通道 wait 不阻塞（<3s，快照 + nextAction）', waitMs < 3000 && waitResp?.ok === true && typeof waitResp?.nextAction === 'string', `${waitMs}ms`)

  // ⑤ 单帧上限兜底：超大结果 → 结构化「结果过大」（仍是合法 JSON，不让宿主拿到半截正文）
  const bigCreate = jsonOf(await callTool('workbuddy_task_manage', {
    action: 'create', title: '超大结果回归', message: 'X'.repeat(120 * 1024), memberAgentIds: [agentId],
  }))
  const bigStatus = await callTool('workbuddy_task_status', { taskId: bigCreate?.taskId, detail: 'full' })
  const bigJson = jsonOf(bigStatus)
  check('超大结果被单帧上限替换为结构化提示', bigJson?.truncated === true && bigStatus.result?.isError === true, textOf(bigStatus).slice(0, 120))

  // ⑥ task_status 默认摘要（窄通道不发全量轮次）
  const sumResp = await callTool('workbuddy_task_status', { taskId: createdTaskId })
  const sumJson = jsonOf(sumResp)
  check('task_status 默认摘要（无全量 task，含进度字段）', sumJson?.taskId === createdTaskId && sumJson?.task === undefined && Boolean(sumJson?.status))

  // ⑦ 真实故障形态：会话被平台掐断 → 自动重连 → 重发同一条请求 → 仍是幂等回放，不新建任务
  const helloCount = () => received.filter((m) => m.id === 1 && m.result?.serverInfo).length
  const hellosBefore = helloCount()
  const replayHitsBefore = received.filter((m) => m.id === replayId && m.result !== undefined).length
  platform.closeAll()
  const tReconnect = Date.now()
  for (;;) {
    if (helloCount() > hellosBefore) break
    if (Date.now() - tReconnect > 15000) throw new Error('断链后重连握手超时')
    await sleep(200)
  }
  check('连接被掐断后自动重连并重新握手', helloCount() > hellosBefore, `${Date.now() - tReconnect}ms`)
  const replayed = await requestWithId(replayId, 'tools/call', { name: 'workbuddy_task_manage', arguments: createArgs }, replayHitsBefore)
  check('重连后重发同一条请求 → 原样回放（未重复执行）', textOf(replayed) === textOf(firstCall) && jsonOf(replayed)?.taskId === createdTaskId)
  const listAfterReconnect = jsonOf(await callTool('workbuddy_task_manage', { action: 'list' }))
  check('断链重连 + 重投后仍只有一个任务', (listAfterReconnect?.tasks || []).filter((t) => t.title === createArgs.title).length === 1)

  // ---------- 5. 状态接口（控制台会话） ----------
  const loginRes = await fetch(`${BASE}${PREFIX}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'workbuddy', password: 'ThunderSoft@88' }),
  })
  const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0]
  const authHdr = { 'Content-Type': 'application/json', Cookie: cookie }
  const status = await fetch(`${BASE}${PREFIX}/api/xiaozhi/status`, { headers: { Cookie: cookie } }).then((r) => r.json())
  check('/api/xiaozhi/status 已连接（种子接入点）', status?.data?.configured === true && status?.data?.endpoints?.length === 1 && status?.data?.endpoints?.[0]?.connected === true, JSON.stringify(status?.data))
  const st0 = status?.data?.endpoints?.[0]?.stats
  check('/api/xiaozhi/status 暴露调用/丢弃/幂等统计', typeof st0?.calls === 'number' && st0.calls > 0 && typeof st0?.dropped === 'number' && typeof st0?.replays === 'number' && st0.replays >= 1, JSON.stringify(st0))
  check('统计包含最近一次工具调用与断线留痕字段', Boolean(st0?.lastTool?.name) && st0.lastTool.delivered === true, JSON.stringify(st0?.lastTool))
  check('断线 code/reason 已留痕', typeof st0?.lastClose?.code === 'number' && Number(st0.lastClose.code) > 0, JSON.stringify(st0?.lastClose))

  // ---------- 6. 多实例：追加第二个接入点 → 两路同时连接 ----------
  received.length = 0
  const add2 = await fetch(`${BASE}${PREFIX}/api/xiaozhi/endpoints`, {
    method: 'POST', headers: authHdr,
    body: JSON.stringify({ name: '第二台小智', endpoint: `ws://127.0.0.1:${WS_PORT}/mcp` }),
  }).then((r) => r.json())
  const secondId = add2?.data?.endpoint?.id
  check('添加第二个接入点（服务端生成 id）', Boolean(secondId), secondId)
  await waitForWire((m) => m.id === 1 && m.result?.serverInfo, '第二路握手', 10000)
  await sleep(500)
  const statusMulti = await fetch(`${BASE}${PREFIX}/api/xiaozhi/status`, { headers: { Cookie: cookie } }).then((r) => r.json())
  const conns = (statusMulti?.data?.endpoints || []).filter((e) => e.connected)
  check('两个接入点同时连接', conns.length === 2, JSON.stringify(statusMulti?.data?.endpoints?.map((e) => ({ id: e.id, connected: e.connected }))))

  // ---------- 7. 停用 / 删除（即时生效） ----------
  await fetch(`${BASE}${PREFIX}/api/xiaozhi/endpoints`, {
    method: 'POST', headers: authHdr,
    body: JSON.stringify({ id: 'xz-default', endpoint: `ws://127.0.0.1:${WS_PORT}/mcp`, enabled: false }),
  })
  await sleep(800)
  const status4 = await fetch(`${BASE}${PREFIX}/api/xiaozhi/status`, { headers: { Cookie: cookie } }).then((r) => r.json())
  const first = (status4?.data?.endpoints || []).find((e) => e.id === 'xz-default')
  check('停用接入点 → 状态停用且断开（免重启）', first?.enabled === false && first?.connected === false, JSON.stringify(first))
  const del = await fetch(`${BASE}${PREFIX}/api/xiaozhi/endpoints/${secondId}`, { method: 'DELETE', headers: { Cookie: cookie } }).then((r) => r.json())
  const status5 = await fetch(`${BASE}${PREFIX}/api/xiaozhi/status`, { headers: { Cookie: cookie } }).then((r) => r.json())
  check('删除接入点 → 列表移除', del?.ok === true && (status5?.data?.endpoints || []).every((e) => e.id !== secondId))
  check('非法接入点被拒（非 ws 地址）', (await fetch(`${BASE}${PREFIX}/api/xiaozhi/endpoints`, {
    method: 'POST', headers: authHdr, body: JSON.stringify({ endpoint: 'http://x.example' }),
  })).status === 400)

  console.log('\n' + results.join('\n'))
  console.log(`\n${failures === 0 ? '✅ 全部通过' : '❌ 存在失败'}（共 ${results.length} 项）\n`)
  cleanup()
  try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  process.exit(failures === 0 ? 0 : 1)
}

void randomUUID
main().catch((err) => {
  console.error('冒烟中断:', err?.stack || err)
  cleanup()
  process.exit(1)
})
