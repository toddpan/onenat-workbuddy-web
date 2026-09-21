/**
 * onenat-workbuddy-web - XiaozhiMcpClient: 把工作台工具注册到小智平台（MCP over WebSocket，多实例）
 *
 * 协议对齐 xiaozhi-esp32-mcp（ESP32 WebSocketMCP 客户端库）：
 *  - 本服务作为 MCP 客户端主动连接各小智平台的 MCP 接入点（ws:// / wss://），支持多个同时接入；
 *  - 平台下发 JSON-RPC：initialize / tools/list / tools/call / ping，本端应答；
 *  - initialize 应答 protocolVersion 2024-11-05 + serverInfo，并补发 notifications/initialized；
 *  - tools/list 动态映射 HTTP 工具通道的全部工具（名称/描述/参数 schema 自动生成，与通道永远同步）；
 *  - tools/call 直接调用工具定义（进程内，免 HTTP/鉴权跳转），结果按 MCP content 规范回包；
 *  - 每条连接独立断线指数退避重连（1s → 60s）。
 *
 * 可靠性约定（防止「一次请求建出多个任务」这类重复副作用）：
 *  1. 幂等回放：同接入点 + 同 JSON-RPC id + 同参数 → 直接回放上次应答（TTL 10 分钟），不重复执行；
 *  2. 长任务不阻塞：传给工具层的 maxBlockMs ≤ MCP_MAX_BLOCK_MS，超时的活一律「立即回执 + 下次轮询取结果」；
 *  3. 回包可观测：结果字节数 / 耗时 / 是否真正送达 / 断线 code+reason 全部入日志，并汇总到 /api/xiaozhi/status；
 *  4. 单帧上限：结果超过 MAX_RESULT_BYTES 时改回结构化「结果过大」提示，避免超大 WS 帧把会话打崩（历史故障模式）。
 */
import { createHash } from 'node:crypto'

import { WebSocket } from 'undici'

import type { WorkBuddyToolDef } from './tool-ops.js'
import type { XiaozhiEndpoint } from './types.js'

const INITIAL_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 60_000

/** 幂等回放窗口：同 id + 同参数的重复投递直接回放，不再执行副作用 */
const REPLAY_TTL_MS = 10 * 60_000
const REPLAY_MAX_ENTRIES = 300

/**
 * MCP 通道单次调用允许阻塞的最长时间。
 * 平台侧等不住长阻塞调用（历史上正是长回包/超时把会话打断，平台随即重发整轮请求 → 任务被建三遍），
 * 因此长任务必须走「立即回执 + 轮询取结果」，这里给一个保守上限。
 */
export const MCP_MAX_BLOCK_MS = 20_000

/** 单条工具结果的字节上限（超过改为结构化提示；小智侧对超大消息的处理不可控） */
export const MAX_RESULT_BYTES = 64 * 1024

/** 超过该耗时的调用打一条 warn（便于提前发现「平台等不住」的调用） */
const SLOW_CALL_WARN_MS = 8_000

export interface XiaozhiMcpDeps {
  serverName: string
  serverVersion: string
  /** 工具通道定义（每次 tools/list 动态读取，保持同步） */
  getTools(): WorkBuddyToolDef[]
  log(msg: string): void
}

/** 单接入点运行统计（诊断用：调用/丢弃/幂等命中/断线原因） */
export interface XiaozhiConnStats {
  calls: number
  failures: number
  /** 工具结果因连接已断而丢弃的次数（平台侧会看到「调用无应答」） */
  dropped: number
  /** 幂等回放命中次数（重复投递被拦下，未产生第二次副作用） */
  replays: number
  /** 结果超限被替换为「结果过大」提示的次数 */
  oversize: number
  connectedAt?: number
  lastCallAt?: number
  lastClose?: { code: number; reason: string; at: number }
  lastTool?: { name: string; at: number; ms: number; bytes: number; delivered: boolean; replayed?: boolean }
}

interface XiaozhiConn {
  id: string
  endpoint: string
  enabled: boolean
  ws: WebSocket | null
  connected: boolean
  closedByUs: boolean
  backoff: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  stats: XiaozhiConnStats
}

/** 工具通道参数表 → MCP inputSchema（json 型参数用 object，模型可直接给结构化参数） */
export function toolDefToInputSchema(def: WorkBuddyToolDef): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  for (const [name, p] of Object.entries(def.parameters || {})) {
    properties[name] = {
      type: p.type === 'json' ? 'object' : p.type || 'string',
      description: p.description,
      ...(p.type === 'json' ? { additionalProperties: true } : {}),
    }
  }
  return { type: 'object', properties, required: ['action'] }
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex')
}

/** 幂等键 = 接入点 + JSON-RPC id + 方法/参数指纹（同 id 不同参数不会被误回放） */
export function replayKey(connId: string, rpcId: unknown, method: string, params: unknown): string | undefined {
  if (rpcId === undefined || rpcId === null) return undefined
  let payload: string
  try {
    payload = JSON.stringify(params ?? {})
  } catch {
    payload = String(params)
  }
  return `${connId}|${String(rpcId)}|${sha1(`${method}\u0001${payload}`).slice(0, 20)}`
}

/**
 * 调用参数摘要（只记安全的标量参数值；其它参数只记「键名 + 字节数 + 指纹」）。
 * 目的：既能定位问题，又不会把 SSH 密码 / 文件内容 / 任务正文写进日志。
 */
export function argBrief(args: Record<string, any> | undefined): string {
  if (!args || typeof args !== 'object') return ''
  const safeKeys = [
    'action', 'taskId', 'subtaskId', 'agentId', 'scheduleId', 'resourceId', 'mappingId',
    'detail', 'mode', 'encoding', 'limit', 'days', 'since', 'maxMessages', 'timeoutMs', 'blockMs',
  ]
  const parts: string[] = []
  for (const k of safeKeys) {
    const v = args[k]
    if (v === undefined || v === null || v === '') continue
    parts.push(`${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
  }
  const rest = Object.keys(args).filter((k) => !safeKeys.includes(k) && args[k] !== undefined && args[k] !== null && args[k] !== '')
  if (rest.length) {
    let bytes = 0
    try {
      bytes = Buffer.byteLength(JSON.stringify(Object.fromEntries(rest.map((k) => [k, args[k]]))))
    } catch { /* ignore */ }
    parts.push(`payload=[${rest.join(',')}] ${bytes}B`)
  }
  return parts.join(' ')
}

export class XiaozhiMcpClient {
  private conns = new Map<string, XiaozhiConn>()
  /** 幂等回放缓存：key → 上次回包原文（原样重发，平台侧拿到的应答完全一致） */
  private replays = new Map<string, { at: number; frame: string }>()

  constructor(private deps: XiaozhiMcpDeps) {}

  /** 全部接入点运行状态（含调用/丢弃/幂等/断线诊断） */
  public listStatus(): Array<{ id: string; endpoint: string; enabled: boolean; connected: boolean; stats: XiaozhiConnStats }> {
    return [...this.conns.values()].map((c) => ({
      id: c.id,
      endpoint: c.endpoint,
      enabled: c.enabled,
      connected: c.connected,
      stats: { ...c.stats },
    }))
  }

  /**
   * 按接入点列表对账（增/删/改即生效）：保留未变更连接，停用/移除的断开，新增/变更的（重）连。
   */
  public configureAll(endpoints: XiaozhiEndpoint[]): void {
    const wanted = new Map<string, XiaozhiEndpoint>()
    for (const e of endpoints || []) {
      if (e?.id && e.endpoint) wanted.set(String(e.id), { ...e, id: String(e.id), endpoint: String(e.endpoint), enabled: e.enabled !== false })
    }
    // 移除不再存在/被停用/端点变更的连接（端点变更的删掉重建，避免复用旧地址记录）
    for (const [id, conn] of this.conns) {
      const w = wanted.get(id)
      if (!w || !w.enabled || w.endpoint !== conn.endpoint) {
        this.teardown(id)
        if (!w || w.endpoint !== conn.endpoint) {
          this.conns.delete(id)
          this.dropReplays(id)
        }
      }
    }
    // 新增 / 更新
    for (const w of wanted.values()) {
      const existing = this.conns.get(w.id)
      if (!existing) {
        const conn: XiaozhiConn = {
          id: w.id,
          endpoint: w.endpoint,
          enabled: true,
          ws: null,
          connected: false,
          closedByUs: false,
          backoff: INITIAL_BACKOFF_MS,
          reconnectTimer: null,
          stats: { calls: 0, failures: 0, dropped: 0, replays: 0, oversize: 0 },
        }
        this.conns.set(w.id, conn)
        if (w.enabled) this.connect(conn)
        else conn.enabled = false
      } else if (w.enabled && !existing.enabled) {
        existing.enabled = true
        existing.closedByUs = false
        this.connect(existing)
      } else {
        existing.enabled = w.enabled
      }
    }
  }

  /** 停止全部连接 */
  public stop(): void {
    for (const id of [...this.conns.keys()]) this.teardown(id)
  }

  private teardown(id: string): void {
    const conn = this.conns.get(id)
    if (!conn) return
    conn.closedByUs = true
    conn.enabled = false
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer)
      conn.reconnectTimer = null
    }
    if (conn.ws) {
      try {
        conn.ws.close(1000, 'reconfigure')
      } catch { /* ignore */ }
      conn.ws = null
    }
    conn.connected = false
    conn.backoff = INITIAL_BACKOFF_MS
  }

  private dropReplays(connId: string): void {
    for (const k of [...this.replays.keys()]) {
      if (k.startsWith(`${connId}|`)) this.replays.delete(k)
    }
  }

  private pruneReplays(): void {
    const now = Date.now()
    for (const [k, v] of this.replays) {
      if (now - v.at > REPLAY_TTL_MS) this.replays.delete(k)
    }
    while (this.replays.size > REPLAY_MAX_ENTRIES) {
      const oldest = this.replays.keys().next().value
      if (oldest === undefined) break
      this.replays.delete(oldest)
    }
  }

  private connect(conn: XiaozhiConn): void {
    if (!conn.endpoint) return
    conn.closedByUs = false
    conn.enabled = true
    this.deps.log(`小智 MCP 接入[${conn.id}]：连接 ${conn.endpoint}`)
    let ws: WebSocket
    try {
      ws = new WebSocket(conn.endpoint)
    } catch (err: any) {
      this.deps.log(`小智 MCP 接入[${conn.id}]：地址非法 ${err?.message || err}`)
      this.scheduleReconnect(conn)
      return
    }
    conn.ws = ws
    ws.addEventListener('open', () => {
      if (conn.ws !== ws) return
      conn.connected = true
      conn.backoff = INITIAL_BACKOFF_MS
      conn.stats.connectedAt = Date.now()
      this.deps.log(`小智 MCP 接入[${conn.id}]：已连接，等待平台 initialize / tools/list`)
    })
    ws.addEventListener('message', (ev: any) => {
      if (conn.ws !== ws) return
      const data = typeof ev?.data === 'string' ? ev.data : String(ev?.data || '')
      void this.handleMessage(data, conn)
    })
    ws.addEventListener('close', (ev: any) => {
      if (conn.ws !== ws) return
      conn.connected = false
      conn.ws = null
      // 断线原因必须留痕：历史上「每轮都在同一个工具调用后断链」只能靠 code/reason 复盘
      const code = Number(ev?.code ?? 0)
      const reason = String(ev?.reason || '')
      conn.stats.lastClose = { code, reason, at: Date.now() }
      if (!conn.closedByUs) {
        this.deps.log(`小智 MCP 接入[${conn.id}]：连接断开（code=${code}${reason ? ` reason=${reason}` : ''}），准备重连`)
        this.scheduleReconnect(conn)
      } else {
        this.deps.log(`小智 MCP 接入[${conn.id}]：连接已关闭（本地主动，code=${code}）`)
      }
    })
    ws.addEventListener('error', (ev: any) => {
      if (conn.ws !== ws) return
      conn.stats.failures += 1
      this.deps.log(`小智 MCP 接入[${conn.id}]：连接错误 ${((ev as any)?.error && (ev as any).error.message) || ''}`.trim())
    })
  }

  private scheduleReconnect(conn: XiaozhiConn): void {
    if (conn.reconnectTimer || !conn.enabled) return
    conn.reconnectTimer = setTimeout(() => {
      conn.reconnectTimer = null
      if (!conn.closedByUs && conn.enabled) this.connect(conn)
    }, conn.backoff)
    conn.backoff = Math.min(conn.backoff * 2, MAX_BACKOFF_MS)
  }

  /**
   * 处理一条平台下发消息并应答（与传输层解耦，便于测试直接驱动）。
   * 未识别/无 id 的通知静默忽略。
   */
  public async handleMessage(raw: string, conn: XiaozhiConn): Promise<void> {
    const send = (message: unknown): boolean => {
      if (!conn.ws || !conn.connected) return false
      try {
        conn.ws.send(typeof message === 'string' ? message : JSON.stringify(message))
        return true
      } catch (err: any) {
        this.deps.log(`小智 MCP 接入[${conn.id}]：发送失败 ${err?.message || err}`)
        return false
      }
    }
    let msg: any
    try {
      msg = JSON.parse(raw)
    } catch {
      this.deps.log(`小智 MCP 接入[${conn.id}]：收到非 JSON 消息，忽略`)
      return
    }
    const method = String(msg?.method || '')
    const id = msg?.id
    try {
      if (method === 'ping') {
        send({ jsonrpc: '2.0', id, result: {} })
        return
      }
      if (method === 'initialize') {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              experimental: {},
              prompts: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
              tools: { listChanged: false },
            },
            serverInfo: { name: this.deps.serverName, version: this.deps.serverVersion },
          },
        })
        send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        this.deps.log(`小智 MCP 接入[${conn.id}]：已完成 initialize 握手`)
        return
      }
      if (method === 'tools/list') {
        const tools = this.deps.getTools().map((def) => ({
          name: def.name,
          description: def.description,
          inputSchema: toolDefToInputSchema(def),
        }))
        send({ jsonrpc: '2.0', id, result: { tools } })
        this.deps.log(`小智 MCP 接入[${conn.id}]：应答 tools/list（${tools.length} 个工具）`)
        return
      }
      if (method === 'tools/call') {
        await this.handleToolCall(conn, msg, send)
        return
      }
      if (id !== undefined && id !== null) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
      }
    } catch (err: any) {
      if (id !== undefined && id !== null) {
        send({ jsonrpc: '2.0', id, error: { code: -32603, message: err?.message || String(err) } })
      }
    }
  }

  /** tools/call：幂等回放 → 进程内执行 → 单帧上限兜底 → 回包并记账 */
  private async handleToolCall(conn: XiaozhiConn, msg: any, send: (m: unknown) => boolean): Promise<void> {
    const id = msg?.id
    const name = String(msg?.params?.name || '')
    const args = (msg?.params?.arguments || {}) as Record<string, any>
    conn.stats.calls += 1
    conn.stats.lastCallAt = Date.now()

    // ① 幂等回放：同接入点 + 同 id + 同参数 = 平台侧重投/整轮重跑，直接回放原应答，不再执行副作用
    const key = replayKey(conn.id, id, 'tools/call', msg?.params)
    if (key) {
      const hit = this.replays.get(key)
      if (hit && Date.now() - hit.at <= REPLAY_TTL_MS) {
        const delivered = send(hit.frame)
        conn.stats.replays += 1
        if (!delivered) conn.stats.dropped += 1
        if (conn.stats.lastTool) conn.stats.lastTool = { ...conn.stats.lastTool, replayed: true, delivered }
        this.deps.log(`小智 MCP 接入[${conn.id}]：工具调用 ${name} 命中幂等回放（id=${id}，${Math.round((Date.now() - hit.at) / 1000)}s 前的同参数请求），未重复执行`)
        return
      }
    }

    const def = this.deps.getTools().find((x) => x.name === name)
    let text: string
    let isError = false
    const startedAt = Date.now()
    if (!def) {
      text = JSON.stringify({ ok: false, error: `工具不存在: ${name}` })
      isError = true
    } else {
      try {
        text = await def.execute(args, { channel: 'mcp', callerId: conn.id, rpcId: (id ?? null) as any, maxBlockMs: MCP_MAX_BLOCK_MS })
      } catch (err: any) {
        text = JSON.stringify({ ok: false, error: err?.message || String(err) })
        isError = true
      }
    }
    const ms = Date.now() - startedAt

    // ② 单帧上限兜底：超大结果换成结构化提示（保留可解析 JSON，别让宿主拿到半截正文）
    let bytes = Buffer.byteLength(text)
    if (bytes > MAX_RESULT_BYTES) {
      conn.stats.oversize += 1
      this.deps.log(`小智 MCP 接入[${conn.id}]：工具 ${name} 结果 ${(bytes / 1024).toFixed(0)}KB 超过单帧上限 ${(MAX_RESULT_BYTES / 1024).toFixed(0)}KB，已替换为「结果过大」提示`)
      text = JSON.stringify({
        ok: false,
        error: `结果过大：${(bytes / 1024).toFixed(0)}KB 超过 MCP 单帧上限 ${(MAX_RESULT_BYTES / 1024).toFixed(0)}KB（超大回包会导致本会话被宿主断开）`,
        truncated: true,
        hint: '请缩小查询范围：task_status 用默认摘要、task_chat 用 maxMessages/maxTextChars 分页、文件改用控制台下载',
      }, null, 2)
      isError = true
      bytes = Buffer.byteLength(text)
    }

    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && parsed.ok === false) isError = true
    } catch { /* 非 JSON 结果按成功回 */ }

    const frame = JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError } })
    const delivered = send(frame)
    if (!delivered) {
      conn.stats.dropped += 1
      this.deps.log(`小智 MCP 接入[${conn.id}]：工具 ${name} 结果未送达（连接已断开，${bytes}B 被丢弃）——平台侧会看到本次调用无应答，可能重发整轮请求`)
    }
    if (isError) conn.stats.failures += 1
    conn.stats.lastTool = { name, at: startedAt, ms, bytes, delivered }

    // ③ 记录 + 缓存回放应答
    if (key) {
      this.replays.set(key, { at: Date.now(), frame })
      this.pruneReplays()
    }
    const brief = argBrief(args)
    this.deps.log(
      `小智 MCP 接入[${conn.id}]：工具调用 ${name}${isError ? '（失败）' : ''} id=${id ?? '-'}${brief ? ` ${brief}` : ''}` +
      ` → ${(bytes / 1024).toFixed(1)}KB / ${ms}ms / ${delivered ? '已回包' : '回包丢弃'}`,
    )
    if (ms >= SLOW_CALL_WARN_MS) {
      this.deps.log(`小智 MCP 接入[${conn.id}]：⚠ 工具 ${name} 阻塞 ${ms}ms（平台侧久等易判超时断链，长任务请走「立即回执 + 轮询」）`)
    }
  }
}
