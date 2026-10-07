/**
 * onenat-workbuddy-web - WorkBuddyMcpServer: 对外提供标准 MCP Server 接口（Streamable HTTP）
 *
 * 与 xiaozhi-mcp.ts（本端作为 MCP 客户端连小智）互补：本模块让 WorkBuddy 自己成为 MCP Server，
 * 任意外部智能体（DSH / Claude / Cursor / 其它 Agent 框架）用标准 MCP 协议即可完成
 * 会话管理（任务创建 / 多轮聊天 / 状态跟踪 / 追问）与平台管理（子智能体 / 资源 / SSH / 定时任务 / 规划器 / 文件）。
 *
 * 协议要点（MCP 2024-11-05 / Streamable HTTP 传输）：
 *  - POST {prefix}/mcp        单条或批量 JSON-RPC；Accept 含 text/event-stream 时以 SSE 帧回包（兼容严格客户端），否则回 JSON
 *  - GET  {prefix}/mcp        服务端不主动推送 → 按规范回 405（客户端回退 POST 轮询语义）
 *  - DELETE {prefix}/mcp      客户端显式结束会话 → 204
 *  - Mcp-Session-Id           initialize 时签发，后续请求校验回带；会话在内存中带 TTL
 *  - 方法：initialize / notifications/initialized / ping / tools/list / tools/call；
 *          prompts/list 与 resources/list 回空集（未开放，明示 capabilities）
 *
 * 与小智客户端同源的可靠性约定（防「一次请求建出多个任务」）：
 *  1. 幂等回放：同会话 + 同 JSON-RPC id + 同参数 → TTL 内直接回放上次应答，不重复执行副作用；
 *  2. 长任务不阻塞：工具层拿到 maxBlockMs = MCP_SERVER_MAX_BLOCK_MS（比小智的 20s 宽，HTTP 宿主等得住），
 *     超时仍走「立即回执 + 下次轮询取结果」；
 *  3. 单帧上限兜底：结果超过 MAX_RESULT_BYTES 换成结构化「结果过大」提示；
 *  4. 回包可观测：调用数 / 失败 / 幂等命中 / 超限 / 会话数全部入 getStatus()。
 *
 * 工具来源：每次 tools/list 动态读取工具通道定义（getTools()），与 HTTP 通道、小智通道永远同步 —— 全量开放，零维护成本。
 */
import { randomUUID } from 'node:crypto'
import type http from 'node:http'

import { argBrief, MAX_RESULT_BYTES, replayKey, toolDefToInputSchema } from './xiaozhi-mcp.js'
import type { ToolCallContext, WorkBuddyToolDef } from './tool-ops.js'

const MCP_PROTOCOL_VERSION = '2024-11-05'

/**
 * MCP Server 通道单次调用允许阻塞的最长时间。
 * 走标准 MCP 的是智能体宿主（非语音平台），能承受比小智更长的阻塞；但为防某客户端
 * 短超时后重发整轮请求造成重复副作用，仍显著低于 HTTP 通道的 600s，且工具层自带
 * create/send 幂等去重兜底。超时的活一律「立即回执 + 下次轮询取结果」。
 */
export const MCP_SERVER_MAX_BLOCK_MS = 120_000

/** 会话空闲 TTL：超过未收到任何请求的会话回收（客户端应重新 initialize） */
const SESSION_TTL_MS = 30 * 60_000
const SESSION_MAX = 200

/** 幂等回放窗口（与小智客户端同参对齐） */
const REPLAY_TTL_MS = 10 * 60_000
const REPLAY_MAX_ENTRIES = 300

/** 超过该耗时的调用打一条 warn */
const SLOW_CALL_WARN_MS = 30_000

export interface WorkBuddyMcpDeps {
  serverName: string
  serverVersion: string
  /** 工具通道定义（每次 tools/list 动态读取，与 HTTP / 小智通道保持同步） */
  getTools(): WorkBuddyToolDef[]
  log(msg: string): void
}

export interface McpServerStats {
  sessions: number
  calls: number
  failures: number
  replays: number
  oversize: number
  batches: number
  startedAt: number
  lastCallAt?: number
  lastTool?: { name: string; session: string; at: number; ms: number; bytes: number; replayed?: boolean }
}

interface McpSession {
  id: string
  createdAt: number
  lastAt: number
  clientInfo?: { name?: string; version?: string }
}

interface JsonRpcMessage {
  jsonrpc?: string
  id?: unknown
  method?: string
  params?: any
  result?: unknown
  error?: unknown
}

export class WorkBuddyMcpServer {
  private sessions = new Map<string, McpSession>()
  /** 幂等回放缓存：key → 上次应答对象（原样重发，调用方拿到的应答完全一致） */
  private replays = new Map<string, { at: number; result: JsonRpcMessage }>()
  private stats: McpServerStats = {
    sessions: 0, calls: 0, failures: 0, replays: 0, oversize: 0, batches: 0,
    startedAt: Date.now(),
  }

  constructor(private deps: WorkBuddyMcpDeps) {}

  /** 运行状态（诊断 / 冒烟用） */
  public getStatus(): McpServerStats {
    this.pruneSessions()
    return { ...this.stats, sessions: this.sessions.size }
  }

  /**
   * 处理一条 MCP HTTP 请求（server.ts 挂载于 {prefix}/mcp；鉴权已由 server.ts 完成）。
   * 返回 true 表示请求已应答。
   */
  public async handleRequest(req: http.IncomingMessage, res: http.ServerResponse, method: string): Promise<boolean> {
    if (method === 'DELETE') {
      const sid = String(req.headers['mcp-session-id'] || '')
      if (sid && this.sessions.delete(sid)) this.deps.log(`MCP Server：会话 ${sid.slice(0, 8)}… 已由客户端显式结束`)
      res.statusCode = 204
      res.end()
      return true
    }
    if (method === 'GET') {
      // 服务端不主动推送（无订阅能力）：按 Streamable HTTP 规范拒绝 GET，客户端回退 POST
      res.statusCode = 405
      res.setHeader('Allow', 'POST, DELETE')
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'SSE listen 未开放：本服务无服务端主动推送，请使用 POST 提交 JSON-RPC' } }))
      return true
    }
    if (method !== 'POST') {
      res.statusCode = 405
      res.setHeader('Allow', 'POST, GET, DELETE')
      res.end()
      return true
    }

    let body: unknown
    try {
      body = await readBody(req)
    } catch (err: any) {
      this.replyJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: `JSON 解析失败: ${err?.message || err}` } })
      return true
    }

    // 批量：MCP 规范允许 JSON-RPC batch（空 batch → 单条 error）
    const items = Array.isArray(body) ? body : [body]
    if (Array.isArray(body)) this.stats.batches += 1
    if (!items.length) {
      this.replyJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: 空 batch' } })
      return true
    }

    const sessionId = String(req.headers['mcp-session-id'] || '') || undefined
    const responses: JsonRpcMessage[] = []
    let sawNotification = false
    let needsInitHandshake = false
    for (const item of items) {
      const r = await this.dispatch(item, sessionId)
      if (r === undefined) sawNotification = true
      else {
        responses.push(r)
        if ((r as any)?._initOk) needsInitHandshake = true
      }
    }

    // initialize：签发会话并通过 Mcp-Session-Id 返回
    if (needsInitHandshake) {
      const fresh = this.issueSession()
      res.setHeader('Mcp-Session-Id', fresh)
      for (const r of responses) delete (r as any)._initOk
    }

    if (!responses.length) {
      // 纯通知：202 无内容（规范允许）
      if (sawNotification) { res.statusCode = 202; res.end() }
      else { res.statusCode = 400; this.replyJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }) }
      return true
    }

    const payload: unknown = Array.isArray(body) ? responses : responses[0]
    // 严格客户端声明只收 SSE → 以单帧 SSE 回包（Streamable HTTP 允许「HTTP 应答流」）
    const accept = String(req.headers.accept || '')
    if (accept.includes('text/event-stream')) this.replySse(res, payload)
    else this.replyJson(res, 200, payload)
    return true
  }

  /** 单条 JSON-RPC 分发；通知（无 id）返回 undefined */
  private async dispatch(msg: JsonRpcMessage, sessionId: string | undefined): Promise<JsonRpcMessage | undefined> {
    const id = msg?.id
    const rpcMethod = String(msg?.method || '')
    const isResponse = rpcMethod === '' && (msg?.result !== undefined || msg?.error !== undefined)
    if (isResponse) return undefined // 客户端对本服务请求的应答（本服务不主动请求，静默忽略）

    // 通知：无 id 且有 method
    const isNotification = id === undefined || id === null
    try {
      if (rpcMethod === 'notifications/initialized' || rpcMethod === 'notifications/cancelled' || rpcMethod === 'notifications/roots/list_changed') {
        return undefined
      }
      if (isNotification) return undefined

      const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result } as JsonRpcMessage)
      const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } } as JsonRpcMessage)

      if (rpcMethod === 'initialize') {
        const p = msg?.params || {}
        const clientVersion = String(p?.protocolVersion || '')
        const session = sessionId ? this.sessions.get(sessionId) : undefined
        if (sessionId && !session) {
          // 会话过期/未知：让客户端重新握手（协议要求 404，但在 JSON-RPC 层给明确错误更友好）
          return fail(-32001, `未知或已过期的 MCP 会话（${sessionId.slice(0, 8)}…），请重新 initialize`)
        }
        this.stats.lastCallAt = Date.now()
        this.deps.log(`MCP Server：initialize 握手 client=${p?.clientInfo?.name || '?'} v${p?.clientInfo?.version || '?'} protocol=${clientVersion || 'default'}`)
        return {
          ...reply({
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: {
              tools: { listChanged: false },
              prompts: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
            },
            serverInfo: { name: this.deps.serverName, version: this.deps.serverVersion },
          }),
          _initOk: true,
        } as JsonRpcMessage
      }

      // initialize 之外的方法要求已建立会话（宽松模式：未带会话头的简单客户端也放行，仅记日志）
      if (sessionId) {
        const s = this.sessions.get(sessionId)
        if (!s) return fail(-32001, '未知或已过期的 MCP 会话，请重新 initialize')
        s.lastAt = Date.now()
      }

      if (rpcMethod === 'ping') return reply({})

      if (rpcMethod === 'prompts/list') return reply({ prompts: [] })
      if (rpcMethod === 'prompts/get') return fail(-32000, '本服务未开放 prompts')
      if (rpcMethod === 'resources/list' || rpcMethod === 'resources/templates/list') return reply({ resources: [], resourceTemplates: [] })
      if (rpcMethod === 'resources/read') return fail(-32000, '本服务未开放 resources（请使用 tools/call 的 workbuddy_file_manage / workbuddy_task_manage）')

      if (rpcMethod === 'tools/list') {
        const tools = this.deps.getTools().map((def) => ({
          name: def.name,
          description: def.description,
          inputSchema: toolDefToInputSchema(def),
        }))
        return reply({ tools })
      }

      if (rpcMethod === 'tools/call') return await this.handleToolCall(msg, sessionId || 'anonymous')
      return fail(-32601, `Method not found: ${rpcMethod}`)
    } catch (err: any) {
      if (isNotification) return undefined
      return { jsonrpc: '2.0', id, error: { code: -32603, message: err?.message || String(err) } } as JsonRpcMessage
    }
  }

  /** tools/call：幂等回放 → 进程内执行 → 单帧上限兜底 → 记账（与小智客户端同构） */
  private async handleToolCall(msg: JsonRpcMessage, sessionId: string): Promise<JsonRpcMessage> {
    const id = msg?.id
    const name = String(msg?.params?.name || '')
    const args = (msg?.params?.arguments || {}) as Record<string, any>
    this.stats.calls += 1
    this.stats.lastCallAt = Date.now()

    // ① 幂等回放：同会话 + 同 id + 同参数 = 客户端侧重投/整轮重跑，直接回放原应答，不再执行副作用
    const key = replayKey(`mcp:${sessionId}`, id, 'tools/call', msg?.params)
    if (key) {
      const hit = this.replays.get(key)
      if (hit && Date.now() - hit.at <= REPLAY_TTL_MS) {
        this.stats.replays += 1
        const r = hit.result as JsonRpcMessage
        if (this.stats.lastTool) this.stats.lastTool = { ...this.stats.lastTool, replayed: true }
        this.deps.log(`MCP Server：工具调用 ${name} 命中幂等回放（会话 ${sessionId.slice(0, 8)}…，id=${id}），未重复执行`)
        return { ...r, id }
      }
    }

    const def = this.deps.getTools().find((x) => x.name === name)
    let text: string
    let isError = false
    const startedAt = Date.now()
    if (!def) {
      text = JSON.stringify({ ok: false, error: `工具不存在: ${name}`, available: this.deps.getTools().map((t) => t.name) })
      isError = true
    } else {
      const ctx: ToolCallContext = { channel: 'mcp', callerId: `mcp:${sessionId}`, rpcId: (id ?? null) as any, maxBlockMs: MCP_SERVER_MAX_BLOCK_MS }
      try {
        text = await def.execute(args, ctx)
      } catch (err: any) {
        text = JSON.stringify({ ok: false, error: err?.message || String(err) })
        isError = true
      }
    }
    const ms = Date.now() - startedAt

    // ② 单帧上限兜底：超大结果换成结构化提示（保留可解析 JSON）
    let bytes = Buffer.byteLength(text)
    if (bytes > MAX_RESULT_BYTES) {
      this.stats.oversize += 1
      this.deps.log(`MCP Server：工具 ${name} 结果 ${(bytes / 1024).toFixed(0)}KB 超过单帧上限 ${(MAX_RESULT_BYTES / 1024).toFixed(0)}KB，已替换为「结果过大」提示`)
      text = JSON.stringify({
        ok: false,
        error: `结果过大：${(bytes / 1024).toFixed(0)}KB 超过 MCP 单帧上限 ${(MAX_RESULT_BYTES / 1024).toFixed(0)}KB`,
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

    const result = { content: [{ type: 'text', text }], isError }
    const brief = argBrief(args)
    this.deps.log(
      `MCP Server：工具调用 ${name}${isError ? '（失败）' : ''} 会话=${sessionId.slice(0, 8)}… id=${id ?? '-'}${brief ? ` ${brief}` : ''}` +
      ` → ${(bytes / 1024).toFixed(1)}KB / ${ms}ms`,
    )
    if (isError) this.stats.failures += 1
    this.stats.lastTool = { name, session: sessionId, at: startedAt, ms, bytes }

    // ③ 缓存回放应答
    if (key) {
      this.replays.set(key, { at: Date.now(), result: { jsonrpc: '2.0', id, result } })
      this.pruneReplays()
    }
    if (ms >= SLOW_CALL_WARN_MS) {
      this.deps.log(`MCP Server：⚠ 工具 ${name} 阻塞 ${ms}ms（客户端短超时重发会造成重复副作用；长任务请走「立即回执 + 轮询」）`)
    }
    return { jsonrpc: '2.0', id, result }
  }

  private issueSession(): string {
    this.pruneSessions()
    const id = randomUUID()
    this.sessions.set(id, { id, createdAt: Date.now(), lastAt: Date.now() })
    while (this.sessions.size > SESSION_MAX) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastAt - b.lastAt)[0]
      if (!oldest) break
      this.sessions.delete(oldest.id)
      this.dropReplays(`mcp:${oldest.id}`)
    }
    this.stats.sessions = this.sessions.size
    return id
  }

  private pruneSessions(): void {
    const now = Date.now()
    for (const [id, s] of this.sessions) {
      if (now - s.lastAt > SESSION_TTL_MS) {
        this.sessions.delete(id)
        this.dropReplays(`mcp:${id}`)
      }
    }
  }

  private dropReplays(prefix: string): void {
    for (const k of [...this.replays.keys()]) {
      if (k.startsWith(`${prefix}|`)) this.replays.delete(k)
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

  private replyJson(res: http.ServerResponse, status: number, payload: unknown): void {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify(payload))
  }

  /** 严格 SSE 客户端兼容：单帧 message 事件携带完整应答后关流 */
  private replySse(res: http.ServerResponse, payload: unknown): void {
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Connection', 'close')
    res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`)
    res.end()
  }
}

function readBody(req: http.IncomingMessage, limit = 8 * 1024 * 1024): Promise<unknown> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        req.destroy()
        fail(new Error(`请求体超过 ${limit} 字节上限`))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8')
        done(body ? JSON.parse(body) : {})
      } catch (err: any) {
        fail(err)
      }
    })
    req.on('error', () => fail(new Error('请求流中断')))
  })
}
