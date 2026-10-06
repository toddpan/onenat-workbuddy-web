/**
 * onenat-workbuddy-web - ExpertMcpServer: 专家库 MCP Server（Streamable HTTP）
 *
 * 挂载于 {prefix}/api/experts/mcp（server.ts，鉴权与其它 /api 一致），
 * 让任意外部智能体（DSH / Claude / Cursor 等）经标准 MCP 协议读写专家库：
 *   expert.list    列出专家（domain/skill 过滤）
 *   expert.get     单个专家完整档案
 *   expert.create  创建用户专家（source=user）
 *   expert.update  更新用户专家（builtin/roster 只读）
 *   expert.delete  删除用户专家（builtin/roster 只读）
 *   expert.search  全文检索（元数据 + prompt 正文）
 *
 * 协议实现说明：项目保持「零运行时依赖」设计（package.json 无 dependencies），
 * 故与 src/mcp-server.ts 一致采用自研 Streamable HTTP JSON-RPC 实现（MCP 2024-11-05），
 * 而非引入 @modelcontextprotocol/sdk —— 线上协议兼容标准 MCP 客户端。
 */
import { randomUUID } from 'node:crypto'
import type http from 'node:http'

import type { ExpertRegistry } from '../expert-registry.js'

const MCP_PROTOCOL_VERSION = '2024-11-05'

/** 单帧结果上限（超大列表截断为提示）。 */
const MAX_RESULT_BYTES = 512 * 1024

interface JsonRpcMessage {
  jsonrpc?: string
  id?: unknown
  method?: string
  params?: any
}

interface ExpertTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute(args: Record<string, any>): Promise<unknown>
}

export class ExpertMcpServer {
  constructor(private registry: ExpertRegistry, private log: (msg: string) => void = () => {}) {}

  /** 处理一条 MCP HTTP 请求；返回 true 表示已应答。无会话态（stateless），免握手负担。 */
  public async handleRequest(req: http.IncomingMessage, res: http.ServerResponse, method: string): Promise<boolean> {
    if (method === 'DELETE') {
      res.statusCode = 204
      res.end()
      return true
    }
    if (method === 'GET') {
      res.statusCode = 405
      res.setHeader('Allow', 'POST, DELETE')
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'SSE listen 未开放：请使用 POST 提交 JSON-RPC' } }))
      return true
    }
    if (method !== 'POST') {
      res.statusCode = 405
      res.setHeader('Allow', 'POST, GET, DELETE')
      res.end()
      return true
    }
    let msg: JsonRpcMessage
    const replyRaw = (status: number, payload: unknown) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(payload))
    }
    try {
      msg = JSON.parse(await readBody(req)) as JsonRpcMessage
    } catch (err: any) {
      replyRaw(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: `JSON 解析失败: ${err?.message || err}` } })
      return true
    }
    const id = msg?.id
    const rpcMethod = String(msg?.method || '')
    const isNotification = id === undefined || id === null
    if (rpcMethod === 'notifications/initialized' || (isNotification && rpcMethod)) {
      res.statusCode = 202
      res.end()
      return true
    }
    const reply = (result: unknown): true => {
      replyRaw(200, { jsonrpc: '2.0', id, result })
      return true
    }
    const fail = (code: number, message: string): true => {
      replyRaw(200, { jsonrpc: '2.0', id, error: { code, message } })
      return true
    }
    try {
      if (rpcMethod === 'initialize') {
        return reply({
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'workbuddy-expert-registry', version: '1.0.0' },
        })
      }
      if (rpcMethod === 'ping') return reply({})
      if (rpcMethod === 'tools/list') return reply({ tools: this.tools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
      if (rpcMethod === 'tools/call') {
        const name = String(msg?.params?.name || '')
        const args = (msg?.params?.arguments || {}) as Record<string, any>
        const tool = this.tools().find((t) => t.name === name)
        if (!tool) {
          return reply({ content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `工具不存在: ${name}` }) }], isError: true })
        }
        const startedAt = Date.now()
        let text: string
        let isError = false
        try {
          text = JSON.stringify({ ok: true, data: await tool.execute(args) }, null, 2)
        } catch (err: any) {
          text = JSON.stringify({ ok: false, error: err?.message || String(err) })
          isError = true
        }
        if (Buffer.byteLength(text) > MAX_RESULT_BYTES) {
          text = JSON.stringify({ ok: false, error: '结果过大，请缩小查询范围（用 domain/skill 过滤或分页）' })
          isError = true
        }
        this.log(`Expert MCP：${name}${isError ? '（失败）' : ''} ${JSON.stringify(args).slice(0, 120)} → ${text.length}B / ${Date.now() - startedAt}ms`)
        return reply({ content: [{ type: 'text', text }], isError })
      }
      return fail(-32601, `Method not found: ${rpcMethod}`)
    } catch (err: any) {
      if (isNotification) {
        res.statusCode = 202
        res.end()
        return true
      }
      return fail(-32603, err?.message || String(err))
    }
  }

  private tools(): ExpertTool[] {
    const reg = this.registry
    const requireText = (v: unknown, field: string): string => {
      const s = typeof v === 'string' ? v.trim() : ''
      if (!s) throw new Error(`缺少必填参数: ${field}`)
      return s
    }
    return [
      {
        name: 'expert.list',
        description: '列出专家库（含用户自建）；可选 domain=分区过滤、skill=关键词过滤（name/描述/tags）',
        inputSchema: {
          type: 'object',
          properties: {
            domain: { type: 'string', description: '按分区过滤（如 team / user）' },
            skill: { type: 'string', description: '关键词过滤（大小写不敏感子串）' },
          },
        },
        execute: async (args) => {
          let experts = args.skill ? await reg.search(String(args.skill)) : [...(await reg.index()).divisions.flatMap((d) => d.experts)]
          if (args.domain) experts = experts.filter((e) => e.division === String(args.domain))
          return { total: experts.length, experts }
        },
      },
      {
        name: 'expert.get',
        description: '获取单个专家完整档案（元数据 + systemPrompt/executionPrompt）',
        inputSchema: { type: 'object', properties: { id: { type: 'string', description: '专家标识' } }, required: ['id'] },
        execute: async (args) => reg.getProfile(requireText(args.id, 'id')),
      },
      {
        name: 'expert.create',
        description: '创建用户自建专家（id 需为小写中划线 slug；systemPrompt 必填；builtin/名册 id 不可占用）',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '专家标识（小写字母/数字中划线）' },
            name: { type: 'string', description: '展示名' },
            description: { type: 'string', description: '简介' },
            icon: { type: 'string', description: '图标 emoji' },
            division: { type: 'string', description: '分区（默认 user）' },
            tags: { type: 'array', items: { type: 'string' }, description: '标签' },
            systemPrompt: { type: 'string', description: '职责与约束提示词（必填）' },
            executionPrompt: { type: 'string', description: '执行指导（可选）' },
            role: { type: 'string', description: '正式角色名（可选）' },
          },
          required: ['id', 'systemPrompt'],
        },
        execute: async (args) => {
          const saved = await reg.createExpert({
            id: requireText(args.id, 'id'),
            name: args.name,
            description: args.description,
            icon: args.icon,
            division: args.division,
            tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
            systemPrompt: requireText(args.systemPrompt, 'systemPrompt'),
            executionPrompt: typeof args.executionPrompt === 'string' ? args.executionPrompt : undefined,
            role: typeof args.role === 'string' ? args.role : undefined,
          })
          this.registry.invalidate()
          return saved
        },
      },
      {
        name: 'expert.update',
        description: '更新用户自建专家（元数据 + 提示词）；builtin/名册专家只读会报错',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '专家标识' },
            name: { type: 'string' },
            description: { type: 'string' },
            icon: { type: 'string' },
            division: { type: 'string' },
            tags: { type: 'array', items: { type: 'string' } },
            systemPrompt: { type: 'string' },
            executionPrompt: { type: 'string' },
            role: { type: 'string' },
          },
          required: ['id'],
        },
        execute: async (args) => {
          const id = requireText(args.id, 'id')
          const patch: Record<string, unknown> = { id }
          for (const k of ['name', 'description', 'icon', 'division', 'systemPrompt', 'executionPrompt', 'role']) {
            if (typeof args[k] === 'string') patch[k] = args[k]
          }
          if (Array.isArray(args.tags)) patch.tags = args.tags.map(String)
          const saved = await reg.updateExpert(id, patch)
          this.registry.invalidate()
          return saved
        },
      },
      {
        name: 'expert.delete',
        description: '删除用户自建专家；builtin/名册专家只读会报错',
        inputSchema: { type: 'object', properties: { id: { type: 'string', description: '专家标识' } }, required: ['id'] },
        execute: async (args) => {
          const id = requireText(args.id, 'id')
          const ok = await reg.deleteExpert(id)
          if (!ok) {
            const exists = await reg.get(id)
            throw new Error(exists ? '内置/名册专家为只读，不可删除。' : '专家不存在。')
          }
          this.registry.invalidate()
          return { deleted: true, id }
        },
      },
      {
        name: 'expert.search',
        description: '全文检索专家：元数据（name/描述/tags）+ prompt 正文（systemPrompt/executionPrompt）',
        inputSchema: { type: 'object', properties: { query: { type: 'string', description: '检索关键词' } }, required: ['query'] },
        execute: async (args) => {
          const q = requireText(args.query, 'query').toLowerCase()
          const all = [...(await reg.index()).divisions.flatMap((d) => d.experts)]
          const hitIds = new Set(all.filter((e) => {
            const hay = [e.name, e.nameEn, e.description, e.descriptionEn, ...(e.tags ?? [])].filter((v): v is string => typeof v === 'string').join('\n').toLowerCase()
            return hay.includes(q)
          }).map((e) => e.id))
          const out = []
          for (const e of all) {
            if (hitIds.has(e.id)) {
              out.push(e)
              continue
            }
            // 正文检索：仅对命中正文的返回完整档案（数量可控）
            try {
              const p = await reg.getProfile(e.id)
              if (`${p.systemPrompt}\n${p.executionPrompt ?? ''}`.toLowerCase().includes(q)) out.push(p)
            } catch { /* 档案缺失的跳过 */ }
          }
          return { total: out.length, experts: out }
        },
      },
    ]
  }
}

function readBody(req: http.IncomingMessage, limit = 2 * 1024 * 1024): Promise<string> {
  return new Promise((done, fail) => {
    let body = ''
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        req.destroy()
        fail(new Error(`请求体超过 ${limit} 字节上限`))
        return
      }
      body += c
    })
    req.on('end', () => done(body))
    req.on('error', () => fail(new Error('请求流中断')))
  })
}
