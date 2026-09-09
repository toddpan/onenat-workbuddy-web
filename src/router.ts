/**
 * @dsh-external/onenat-workbuddy - HTTP Router & API Dispatcher
 *
 * 路由表见设计文档 §9。SSE 网关: GET /api/tasks/:id/stream
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { OnenatDirectory } from './onenat.js'
import { OnenatDirectory as Dir } from './onenat.js'
import type { TaskEngine } from './engine.js'
import type { AgentResolver } from './resolver.js'
import type { PromptComposer } from './prompt-composer.js'
import type { Planner } from './planner.js'
import type { WorkStore } from './store.js'
import { DshClient } from './remote-client.js'
import { SshInputError, execOnSshResource, maskSshResource, normalizeSshResource, testSshResource } from './ssh-resources.js'
import type { SshResourceStore } from './ssh-store.js'
import type { DshRef, SubAgent, WorkTask } from './types.js'
import { renderWebUi } from './web-ui.js'

export class WorkBuddyRouter {
  private client = new DshClient()

  constructor(
    private store: WorkStore,
    private directory: OnenatDirectory,
    private resolver: AgentResolver,
    private composer: PromptComposer,
    private planner: Planner,
    private engine: TaskEngine,
    private sshStore: SshResourceStore,
  ) {}

  private sendJson(res: ServerResponse, statusCode: number, data: any): void {
    res.statusCode = statusCode
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.end(JSON.stringify(data))
  }

  private async parseBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve) => {
      let body = ''
      req.on('data', (c) => {
        body += c
      })
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {})
        } catch {
          resolve({})
        }
      })
      req.on('error', () => resolve({}))
    })
  }

  private startSse(res: ServerResponse): void {
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
    res.setHeader('Cache-Control', 'no-cache, no-transform')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders?.()
  }

  /** 任务列表摘要（不含 turns/taskLogs/子任务日志全文） */
  private taskSummary(t: WorkTask) {
    const turns = t.turns || []
    const last = turns[turns.length - 1]
    return {
      id: t.id,
      title: t.title,
      mode: t.mode,
      status: t.status,
      running: this.engine.isRunning(t.id),
      memberAgentIds: t.memberAgentIds,
      lastRoute: t.lastRoute,
      createdAt: t.createdAt,
      archivedAt: t.archivedAt,
      turnsCount: turns.length,
      lastPreview: last ? String(last.text || '').slice(0, 120) : '',
      plan: t.plan
        ? {
            strategy: t.plan.strategy,
            subtasks: (t.plan.subtasks || []).map((x) => ({ id: x.id, title: x.title, status: x.status, agentId: x.agentId, error: x.error })),
          }
        : undefined,
      summary: t.summary ? { status: t.summary.status, finalConclusion: t.summary.finalConclusion } : undefined,
      attachmentsCount: (t.attachments || []).length,
    }
  }

  public async dispatch(req: IncomingMessage, res: ServerResponse, prefix: string): Promise<boolean> {
    const rawUrl = req.url || '/'
    const method = (req.method || 'GET').toUpperCase()
    if (method === 'OPTIONS') {
      res.statusCode = 204
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
      res.end()
      return true
    }
    const urlObj = new URL(rawUrl, 'http://localhost')
    const pathname = urlObj.pathname
    if (!pathname.startsWith(prefix)) return false
    const p = pathname.slice(prefix.length) || '/'

    // ---------- 控制台 ----------
    if (method === 'GET' && (p === '' || p === '/' || p === '/console')) {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(renderWebUi(prefix))
      return true
    }

    // ---------- 资源目录 ----------
    if (p === '/api/resources' && method === 'GET') {
      try {
        const snap = await this.directory.refresh(false)
        this.sendJson(res, 200, {
          ok: true,
          data: {
            fetchedAt: snap.fetchedAt,
            configured: this.directory.configured,
            baseUrl: this.directory.endpoint,
            endpoints: this.directory.listEndpoints(),
          },
        })
      } catch (err: any) {
        this.sendJson(res, 200, { ok: false, error: err?.message || String(err), data: { configured: this.directory.configured, endpoints: [] } })
      }
      return true
    }
    if (p === '/api/resources/refresh' && method === 'POST') {
      try {
        const snap = await this.directory.refresh(true)
        this.sendJson(res, 200, { ok: true, data: { fetchedAt: snap.fetchedAt, endpoints: this.directory.listEndpoints() } })
      } catch (err: any) {
        this.sendJson(res, 502, { ok: false, error: err?.message || String(err) })
      }
      return true
    }
    const resolveMatch = /^\/api\/resources\/mappings\/([^/]+)\/resolve$/.exec(p)
    if (resolveMatch && method === 'GET') {
      try {
        await this.directory.refresh(true)
      } catch {
        /* 用现有快照回答 */
      }
      const ep = this.directory.resolveMapping(decodeURIComponent(resolveMatch[1]))
      if (!ep) {
        this.sendJson(res, 404, { ok: false, error: '映射不存在（请先刷新资源目录）' })
        return true
      }
      this.sendJson(res, 200, { ok: true, data: ep })
      return true
    }

    // ---------- 设置 ----------
    if (p === '/api/settings' && method === 'GET') {
      const s = this.store.getSettings()
      this.sendJson(res, 200, { ok: true, data: { ...s, onenat: { ...s.onenat, apiKey: s.onenat.apiKey ? s.onenat.apiKey.slice(0, 8) + '…' : '' } } })
      return true
    }
    if (p === '/api/settings' && (method === 'POST' || method === 'PUT')) {
      const body = await this.parseBody(req)
      const patch: any = {}
      if (body.onenat) {
        patch.onenat = { ...body.onenat }
        if (typeof body.onenat.apiKey === 'string' && body.onenat.apiKey.endsWith('…')) delete patch.onenat.apiKey // 打码值不覆盖
      }
      if (body.planner) patch.planner = body.planner
      const updated = this.store.updateSettings(patch)
      this.directory.configure(updated.onenat.baseUrl, updated.onenat.apiKey)
      this.directory.startAutoRefresh(updated.onenat.autoRefreshMs)
      this.sendJson(res, 200, { ok: true, data: { ...updated, onenat: { ...updated.onenat, apiKey: updated.onenat.apiKey ? updated.onenat.apiKey.slice(0, 8) + '…' : '' } } })
      return true
    }

    // ---------- 子智能体 ----------
    if (p === '/api/agents' && method === 'GET') {
      this.sendJson(res, 200, { ok: true, data: this.store.getAgents() })
      return true
    }
    if (p === '/api/agents' && method === 'POST') {
      const body = await this.parseBody(req)
      // 部分更新：带 id 时 dshRef 缺省回退已有值
      const fallback = body?.id ? this.store.getAgent(String(body.id)) : undefined
      const dshRef = normalizeDshRef(body.dshRef ?? fallback?.dshRef)
      if ('error' in dshRef) {
        this.sendJson(res, 400, { ok: false, error: dshRef.error })
        return true
      }
      const workDir = String(body?.workDir ?? '').trim()
      if (workDir && !workDir.startsWith('/')) {
        this.sendJson(res, 400, { ok: false, error: '工作目录必须是绝对路径（以 / 开头）' })
        return true
      }
      const saved = this.store.upsertAgent({ ...(body as any), dshRef: dshRef as DshRef })
      this.sendJson(res, 200, { ok: true, data: saved })
      return true
    }
    // 远端目录浏览（子智能体工作目录选择器）
    if (p === '/api/agents/fs/list' && method === 'GET') {
      const url = new URL(req.url || '/', 'http://localhost')
      const agent = this.store.getAgent(String(url.searchParams.get('agent') || ''))
      if (!agent) {
        this.sendJson(res, 404, { ok: false, error: 'Agent not found' })
        return true
      }
      const target = await this.resolver.resolve(agent)
      if (!target.online || !target.baseUrl) {
        this.sendJson(res, 502, { ok: false, error: target.error || '节点不可达' })
        return true
      }
      const dirPath = url.searchParams.get('path') || undefined
      const out = await this.client.fsList(target, dirPath || undefined)
      this.sendJson(res, out.ok ? 200 : 400, out.ok ? out : { ok: false, error: out.error })
      return true
    }
    if (p === '/api/agents/fs/mkdir' && method === 'POST') {
      const body = await this.parseBody(req)
      const agent = this.store.getAgent(String(body?.agent || ''))
      if (!agent) {
        this.sendJson(res, 404, { ok: false, error: 'Agent not found' })
        return true
      }
      const target = await this.resolver.resolve(agent)
      if (!target.online || !target.baseUrl) {
        this.sendJson(res, 502, { ok: false, error: target.error || '节点不可达' })
        return true
      }
      const out = await this.client.fsMkdir(target, String(body?.path || ''), String(body?.name || ''))
      this.sendJson(res, out.ok ? 200 : out.error?.includes('已存在') ? 409 : 400, out.ok ? out : { ok: false, error: out.error })
      return true
    }
    const agentMatch = /^\/api\/agents\/([^/]+)$/.exec(p)
    if (agentMatch && method === 'DELETE') {
      const id = decodeURIComponent(agentMatch[1])
      this.sendJson(res, 200, { ok: true, data: { deleted: this.store.deleteAgent(id) } })
      return true
    }
    if (agentMatch && method === 'GET') {
      const agent = this.store.getAgent(decodeURIComponent(agentMatch[1]))
      if (!agent) {
        this.sendJson(res, 404, { ok: false, error: 'Agent not found' })
        return true
      }
      this.sendJson(res, 200, { ok: true, data: agent })
      return true
    }
    const pingMatch = /^\/api\/agents\/([^/]+)\/ping$/.exec(p)
    if (pingMatch && method === 'POST') {
      const agent = this.store.getAgent(decodeURIComponent(pingMatch[1]))
      if (!agent) {
        this.sendJson(res, 404, { ok: false, error: 'Agent not found' })
        return true
      }
      const { target, ping } = await this.resolver.resolveWithPing(agent)
      this.sendJson(res, 200, {
        ok: true,
        data: {
          ping,
          resolved: target ? { baseUrl: target.baseUrl, mappingId: target.mappingId, resolvedAt: target.resolvedAt } : undefined,
        },
      })
      return true
    }
    const modelsMatch = /^\/api\/agents\/([^/]+)\/models$/.exec(p)
    if (modelsMatch && method === 'GET') {
      const agent = this.store.getAgent(decodeURIComponent(modelsMatch[1]))
      if (!agent) {
        this.sendJson(res, 404, { ok: false, error: 'Agent not found' })
        return true
      }
      const target = await this.resolver.resolve(agent)
      if (!target.online) {
        this.sendJson(res, 200, { ok: false, error: target.error, data: { models: [] } })
        return true
      }
      this.sendJson(res, 200, { ok: true, data: await this.client.getModels(target) })
      return true
    }
    const presetsMatch = /^\/api\/agents\/([^/]+)\/presets$/.exec(p)
    if (presetsMatch && method === 'GET') {
      const agent = this.store.getAgent(decodeURIComponent(presetsMatch[1]))
      if (!agent) {
        this.sendJson(res, 404, { ok: false, error: 'Agent not found' })
        return true
      }
      const target = await this.resolver.resolve(agent)
      if (!target.online) {
        this.sendJson(res, 200, { ok: false, error: target.error, data: { presets: [] } })
        return true
      }
      this.sendJson(res, 200, { ok: true, data: await this.client.getPresets(target) })
      return true
    }
    const previewMatch = /^\/api\/agents\/([^/]+)\/prompt-preview$/.exec(p)
    if (previewMatch && method === 'GET') {
      const agent = this.store.getAgent(decodeURIComponent(previewMatch[1]))
      if (!agent) {
        this.sendJson(res, 404, { ok: false, error: 'Agent not found' })
        return true
      }
      try {
        await this.directory.refresh(true)
      } catch {
        /* 无网时用缓存 */
      }
      const composed = await this.composer.compose(agent, { resolvedAt: Date.now(), mask: true })
      this.sendJson(res, 200, {
        ok: true,
        data: {
          systemPrompt: agent.systemPrompt || '',
          resourceBlock: composed.block,
          resources: composed.resources,
          warnings: composed.warnings,
          full: [agent.systemPrompt, composed.block].filter(Boolean).join('\n\n'),
        },
      })
      return true
    }

    // 表单直连测试（direct 引用用）
    if (p === '/api/dsh-test' && method === 'POST') {
      const body = await this.parseBody(req)
      if (!body.apiBaseUrl) {
        this.sendJson(res, 400, { ok: false, error: '缺少 apiBaseUrl' })
        return true
      }
      this.sendJson(res, 200, { ok: true, data: await this.client.ping({ baseUrl: body.apiBaseUrl, apiKey: body.apiKey }) })
      return true
    }

    // ---------- 提及与联想候选数据 (@ Mentions Directory) ----------
    if (p === '/api/mentions/candidates' && method === 'GET') {
      const candidates: Array<{
        type: 'agent' | 'resource'
        id: string
        name: string
        kind?: string
        detail?: string
        meta?: any
      }> = []

      // 1. 子智能体
      const agents = this.store.getAgents()
      for (const a of agents) {
        if (a.enabled !== false) {
          candidates.push({
            type: 'agent',
            id: a.id,
            name: a.name,
            kind: 'agent',
            detail: `${a.dshRef.kind} · ${a.model ? String(a.model).split('/').pop() : '默认模型'}`,
            meta: { agentId: a.id, description: a.description },
          })
        }
      }

      // 2. ONENAT 映射与应用资源
      const endpoints = this.directory.listEndpoints()
      for (const ep of endpoints) {
        const name = ep.appName || ep.note || `mapping:${ep.mappingId}`
        candidates.push({
          type: 'resource',
          id: ep.mappingId,
          name,
          kind: ep.kind || 'unknown',
          detail: `${(ep.kind || '').toUpperCase()} · ${ep.tunnelName || ''} · ${ep.online ? '在线' : '离线'}`,
          meta: { mappingId: ep.mappingId, kind: ep.kind, online: ep.online },
        })
      }

      // 3. 本地 SSH 资源池
      const sshs = this.sshStore.list()
      for (const s of sshs) {
        if (!candidates.some(c => c.id === s.id || c.name === s.name)) {
          candidates.push({
            type: 'resource',
            id: s.id,
            name: s.name,
            kind: 'ssh',
            detail: `SSH · ${s.username}@${s.host}:${s.port || 22} · ${s.description || '本地直连'}`,
            meta: { sshId: s.id, kind: 'ssh' },
          })
        }
      }

      this.sendJson(res, 200, { ok: true, data: candidates })
      return true
    }

    // ---------- 任务会话 ----------
    if (p === '/api/tasks' && method === 'GET') {
      const tasks = this.store.getTasks()
      // 列表只返回摘要（完整 turns/taskLogs 随任务增长可达数 MB，且 SSE 每个事件都会刷新列表，
      // 全量返回会占满浏览器并发连接，导致切换会话时单任务请求长时间排队）
      this.sendJson(res, 200, { ok: true, data: tasks.map((t) => this.taskSummary(t)) })
      return true
    }
    if (p === '/api/tasks' && method === 'POST') {
      const body = await this.parseBody(req)
      // 若未指定成员，自动使用全部可用子智能体或默认主智能体
      if (!Array.isArray(body.memberAgentIds) || body.memberAgentIds.length === 0) {
        const allAgents = this.store.getAgents()
        body.memberAgentIds = allAgents.map(a => a.id)
      }
      try {
        const task = await this.engine.createTask(body)
        this.sendJson(res, 201, { ok: true, data: task })
      } catch (err: any) {
        this.sendJson(res, 400, { ok: false, error: err?.message || String(err) })
      }
      return true
    }
    const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(p)
    if (taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1])
      if (method === 'GET') {
        const task = this.store.getTask(taskId)
        if (!task) {
          this.sendJson(res, 404, { ok: false, error: 'Task not found' })
          return true
        }
        // taskLogs 前端未使用（日志抽屉走子任务日志 + SSE），剔除以减小载荷
        const { taskLogs: _drop, ...rest } = task as any
        this.sendJson(res, 200, { ok: true, data: { ...rest, running: this.engine.isRunning(taskId) } })
        return true
      }
      if (method === 'DELETE') {
        const ok = await this.engine.deleteTask(taskId)
        this.sendJson(res, 200, { ok: true, data: { deleted: ok } })
        return true
      }
      if (method === 'PATCH' || method === 'PUT') {
        const body = await this.parseBody(req)
        try {
          if (Array.isArray(body.memberAgentIds)) {
            this.engine.updateMembers(taskId, body.memberAgentIds)
          }
          if (typeof body.title === 'string') {
            this.store.mutateTask(taskId, (t) => {
              t.title = body.title.trim() || t.title
            })
          }
          this.sendJson(res, 200, { ok: true, data: this.store.getTask(taskId) })
        } catch (err: any) {
          this.sendJson(res, 400, { ok: false, error: err?.message })
        }
        return true
      }
    }
    const msgMatch = /^\/api\/tasks\/([^/]+)\/messages$/.exec(p)
    if (msgMatch && method === 'POST') {
      const taskId = decodeURIComponent(msgMatch[1])
      const body = await this.parseBody(req)
      const out = await this.engine.sendUserMessage(taskId, String(body.message || ''))
      this.sendJson(res, out.ok ? 202 : 400, out)
      return true
    }
    // 重命名会话（对齐 DSH web 的 session.rename 动词）
    const renameMatch = /^\/api\/tasks\/([^/]+)\/rename$/.exec(p)
    if (renameMatch && method === 'POST') {
      const taskId = decodeURIComponent(renameMatch[1])
      const body = await this.parseBody(req)
      const title = String(body?.title || '').trim()
      if (!title) {
        this.sendJson(res, 400, { ok: false, error: '标题不能为空' })
        return true
      }
      const updated = this.store.mutateTask(taskId, (t) => {
        t.title = title
        return t
      })
      if (!updated) this.sendJson(res, 404, { ok: false, error: 'Task not found' })
      else this.sendJson(res, 200, { ok: true, data: updated })
      return true
    }
    // 归档/取消归档（对齐 DSH web 的 archiveSession：幂等，仅列表隐藏，不改数据）
    const archiveMatch = /^\/api\/tasks\/([^/]+)\/archive$/.exec(p)
    if (archiveMatch && method === 'POST') {
      const taskId = decodeURIComponent(archiveMatch[1])
      const body = await this.parseBody(req)
      const archived = Boolean(body?.archived)
      const updated = this.store.mutateTask(taskId, (t) => {
        t.archivedAt = archived ? (t.archivedAt || Date.now()) : undefined
        return t
      })
      if (!updated) this.sendJson(res, 404, { ok: false, error: 'Task not found' })
      else this.sendJson(res, 200, { ok: true, data: updated })
      return true
    }
    // 附件上传（multipart）→ 转发到各成员远端会话工作区
    const attachMatch = /^\/api\/tasks\/([^/]+)\/attachments$/.exec(p)
    if (attachMatch && method === 'POST') {
      const taskId = decodeURIComponent(attachMatch[1])
      const contentType = String(req.headers['content-type'] || '')
      const raw = await readRawBuffer(req, 100 * 1024 * 1024)
      if (raw.length === 0) {
        this.sendJson(res, 400, { ok: false, error: '请求体为空：请以 multipart/form-data 上传文件' })
        return true
      }
      let files: Array<{ filename: string; data: Buffer; mimeType?: string }>
      if (/^multipart\/form-data/i.test(contentType)) {
        files = parseMultipartFiles(raw, contentType)
        if (!files.length) {
          this.sendJson(res, 400, { ok: false, error: 'multipart 请求中未找到带 filename 的文件字段' })
          return true
        }
      } else {
        const url = new URL(req.url || '/', 'http://localhost')
        const rawName = (url.searchParams.get('filename') || String(req.headers['x-filename'] || '')).trim()
        files = [{ filename: sanitizeUploadName(rawName || `upload-${Date.now()}`), data: raw, mimeType: contentType }]
      }
      try {
        const result = await this.engine.uploadAttachments(taskId, files)
        if (!result.ok) this.sendJson(res, 404, { ok: false, error: result.error })
        else this.sendJson(res, 200, { ok: true, data: result })
      } catch (err: any) {
        this.sendJson(res, 500, { ok: false, error: err?.message || String(err) })
      }
      return true
    }
    // 会话工作区文件下载（代理成员远端 DSH，支持 AI 回复中的绝对/相对路径）
    const dlMatch = /^\/api\/tasks\/([^/]+)\/files\/download$/.exec(p)
    if (dlMatch && method === 'GET') {
      const taskId = decodeURIComponent(dlMatch[1])
      const url = new URL(req.url || '/', 'http://localhost')
      const agent = url.searchParams.get('agent') || undefined
      const filePath = url.searchParams.get('path') || ''
      try {
        const dl = await this.engine.prepareFileDownload(taskId, agent, filePath)
        if (!dl.ok || !dl.res?.body) {
          this.sendJson(res, 404, { ok: false, error: dl.error || '下载失败' })
          return true
        }
        const name = (dl.name || 'download').split(/[\\/]/).pop() || 'download'
        res.statusCode = 200
        res.setHeader('Content-Type', dl.res.headers.get('content-type') || 'application/octet-stream')
        const len = dl.res.headers.get('content-length')
        if (len) res.setHeader('Content-Length', len)
        const ascii = name.replace(/[^\x20-\x7e]/g, '_') || 'download'
        res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`)
        const nodeStream = Readable.fromWeb(dl.res.body as any)
        nodeStream.pipe(res)
        nodeStream.on('error', () => res.destroy())
      } catch (err: any) {
        if (!res.headersSent) this.sendJson(res, 500, { ok: false, error: err?.message || String(err) })
        else res.destroy()
      }
      return true
    }
    const streamMatch = /^\/api\/tasks\/([^/]+)\/stream$/.exec(p)
    if (streamMatch && method === 'GET') {
      const taskId = decodeURIComponent(streamMatch[1])
      this.startSse(res)
      res.write(`event: connected\ndata: ${JSON.stringify({ taskId, at: Date.now() })}\n\n`)
      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': hb\n\n')
      }, 15_000)
      const unsubscribe = this.engine.subscribe(taskId, (e) => {
        if (res.writableEnded) return
        try {
          res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
        } catch {
          /* 客户端断开时由 close 清理 */
        }
      })
      req.on('close', () => {
        clearInterval(heartbeat)
        unsubscribe()
      })
      return true
    }
    const cancelMatch = /^\/api\/tasks\/([^/]+)\/cancel$/.exec(p)
    if (cancelMatch && method === 'POST') {
      await this.engine.cancelTask(decodeURIComponent(cancelMatch[1]))
      this.sendJson(res, 200, { ok: true })
      return true
    }
    // 主调度（Planner）配置：指定子智能体（默认自动挑本地）+ 主调度模型（聊天窗可选）
    if (p === '/api/planner/options' && method === 'GET') {
      const settings = this.store.getSettings()
      const picked = await this.planner.plannerTarget()
      let models: Array<{ provider: string; id: string; name?: string; isDefault?: boolean }> = []
      const providers: string[] = []
      if (picked.baseUrl) {
        const target = { baseUrl: picked.baseUrl, online: true, resolvedAt: new Date().toISOString(), mappingId: '' }
        const mr = await this.client.getModels(target as any)
        models = mr.models || []
        for (const m of models) if (m.provider && !providers.includes(m.provider)) providers.push(m.provider)
      }
      this.sendJson(res, 200, {
        ok: true,
        data: {
          agents: this.store.getAgents().map(a => ({ id: a.id, name: a.name })),
          models: models.map(m => ({ provider: m.provider, id: m.id, name: m.name, isDefault: m.isDefault })),
          providers,
          current: { agentId: picked.agentId, auto: picked.auto !== false, model: settings.planner.model },
          source: picked.source,
          error: picked.error,
        },
      })
      return true
    }
    if (p === '/api/planner/config' && method === 'POST') {
      const body = await this.parseBody(req)
      const hasAgent = body && typeof body.agentId === 'string'
      const hasModel = body && typeof body.model === 'string'
      const agentId = hasAgent ? (String(body.agentId).trim() || undefined) : undefined
      const model = hasModel ? (String(body.model).trim() || undefined) : undefined
      this.store.updateSettings({
        planner: {
          ...(hasAgent ? { agentId } : {}),
          ...(hasModel ? { model } : {}),
        },
      } as any)
      const s = this.store.getSettings()
      this.sendJson(res, 200, { ok: true, data: { agentId: s.planner.agentId, model: s.planner.model } })
      return true
    }
    const retryMatch = /^\/api\/tasks\/([^/]+)\/subtasks\/([^/]+)\/retry$/.exec(p)
    if (retryMatch && method === 'POST') {
      const out = await this.engine.retrySubtask(decodeURIComponent(retryMatch[1]), decodeURIComponent(retryMatch[2]))
      this.sendJson(res, out.ok ? 200 : 400, out)
      return true
    }
    const chatMatch = /^\/api\/tasks\/([^/]+)\/subtasks\/([^/]+)\/chat$/.exec(p)
    if (chatMatch && method === 'GET') {
      const out = await this.subtaskChat(decodeURIComponent(chatMatch[1]), decodeURIComponent(chatMatch[2]))
      this.sendJson(res, 200, { ok: out.ok, data: out })
      return true
    }
    const followupMatch = /^\/api\/tasks\/([^/]+)\/subtasks\/([^/]+)\/followup$/.exec(p)
    if (followupMatch && method === 'POST') {
      const taskId = decodeURIComponent(followupMatch[1])
      const subtaskId = decodeURIComponent(followupMatch[2])
      const body = await this.parseBody(req)
      if (!body.message) {
        this.sendJson(res, 400, { ok: false, error: '缺少 message' })
        return true
      }
      const out = await this.subtaskFollowup(taskId, subtaskId, String(body.message))
      this.sendJson(res, 200, out)
      return true
    }
    const summaryMatch = /^\/api\/tasks\/([^/]+)\/summary$/.exec(p)
    if (summaryMatch && method === 'POST') {
      const taskId = decodeURIComponent(summaryMatch[1])
      const task = this.store.getTask(taskId)
      if (!task?.plan) {
        this.sendJson(res, 404, { ok: false, error: '任务不存在或无编排计划' })
        return true
      }
      const targets = new Map<string, { baseUrl: string; apiKey?: string }>()
      const { targets: resolved } = await this.resolver.resolveMembers(task.memberAgentIds)
      for (const [k, v] of resolved) targets.set(k, v)
      const summary = await this.planner.summarize(task.turns.find((t) => t.role === 'user')?.text || task.title, task.plan.subtasks, targets)
      this.store.mutateTask(taskId, (t) => {
        t.summary = summary
        if (!this.engine.isRunning(taskId)) t.status = summary.status
      })
      this.sendJson(res, 200, { ok: true, data: this.store.getTask(taskId) })
      return true
    }

    // ---------- SSH 资源池（本地补充资源，沿袭 orchestrator） ----------
    if (p === '/api/ssh-resources' && method === 'GET') {
      this.sendJson(res, 200, { ok: true, data: this.sshStore.list().map(maskSshResource) })
      return true
    }
    if (p === '/api/ssh-resources' && method === 'POST') {
      const body = await this.parseBody(req)
      try {
        const existing = body.id ? this.sshStore.get(body.id) : undefined
        const saved = this.sshStore.upsert(normalizeSshResource(body, existing))
        this.sendJson(res, 200, { ok: true, data: maskSshResource(saved) })
      } catch (err: any) {
        this.sendJson(res, 400, { ok: false, error: err instanceof SshInputError ? err.message : err?.message })
      }
      return true
    }
    const sshMatch = /^\/api\/ssh-resources\/([^/]+)$/.exec(p)
    if (sshMatch) {
      const sshId = decodeURIComponent(sshMatch[1])
      if (method === 'GET') {
        const r = this.sshStore.get(sshId)
        this.sendJson(res, r ? 200 : 404, r ? { ok: true, data: r } : { ok: false, error: 'not found' })
        return true
      }
      if (method === 'DELETE') {
        this.sendJson(res, 200, { ok: true, data: { deleted: this.sshStore.delete(sshId) } })
        return true
      }
    }
    const sshTestMatch = /^\/api\/ssh-resources\/([^/]+)\/test$/.exec(p)
    if (sshTestMatch && method === 'POST') {
      const r = this.sshStore.get(decodeURIComponent(sshTestMatch[1]))
      if (!r) {
        this.sendJson(res, 404, { ok: false, error: 'not found' })
        return true
      }
      const result = await testSshResource(r, 8000)
      this.sshStore.update(r.id, {
        lastTestedAt: result.testedAt,
        lastTestOk: result.ok,
        lastTestError: result.ok ? undefined : result.error,
      })
      this.sendJson(res, 200, { ok: true, data: result })
      return true
    }
    const sshExecMatch = /^\/api\/ssh-resources\/([^/]+)\/exec$/.exec(p)
    if (sshExecMatch && method === 'POST') {
      const r = this.sshStore.get(decodeURIComponent(sshExecMatch[1]))
      if (!r) {
        this.sendJson(res, 404, { ok: false, error: 'not found' })
        return true
      }
      const body = await this.parseBody(req)
      if (!body.command) {
        this.sendJson(res, 400, { ok: false, error: '缺少 command' })
        return true
      }
      this.sendJson(res, 200, { ok: true, data: await execOnSshResource(r, String(body.command), Number(body.timeoutMs) || 30000) })
      return true
    }

    return false
  }

  private async subtaskChat(taskId: string, subtaskId: string): Promise<{ ok: boolean; source?: string; note?: string; messages?: any[]; error?: string }> {
    const task = this.store.getTask(taskId)
    const sub = task?.plan?.subtasks.find((s) => s.id === subtaskId)
    if (!task || !sub) return { ok: false, error: '子任务不存在' }
    // 兜底视图：远端不可达/记录缺失时，用本地缓存的指令与产出还原对话
    const localFallback = (note: string): { ok: boolean; source: string; note: string; messages: any[] } => {
      const messages: any[] = [{ role: 'user', content: sub.prompt, time: sub.startedAt || task.createdAt }]
      if (sub.result?.content) messages.push({ role: 'assistant', content: sub.result.content, time: sub.completedAt, local: true })
      return { ok: true, source: 'local', note, messages }
    }
    // 会话绑定存在 task.sessions[agentId]（引擎写入），sub.remoteSessionId 仅作旧数据兜底
    const remoteSessionId = task.sessions?.[sub.agentId]?.remoteSessionId || sub.remoteSessionId
    if (!remoteSessionId) return localFallback('该子任务尚未创建远程会话，以下为本地缓存记录')
    const agent = this.store.getAgent(sub.agentId)
    if (!agent) return { ok: false, error: '子智能体不存在' }
    const target = await this.resolver.resolve(agent)
    if (!target.online) return localFallback(`远端节点当前不可达（${target.error}），以下为本地缓存记录`)
    const hist = await this.client.getHistory(target, remoteSessionId)
    if (!hist.ok) return localFallback(`远端会话记录读取失败（${hist.error}），以下为本地缓存记录`)
    // 过滤 harness 注入的上下文噪音（system-reminder / runtime-context 快照），只留业务对话
    const isNoise = (m: any): boolean => {
      const c = typeof m?.content === 'string' ? m.content : ''
      return c.startsWith('<system-reminder>') || c.startsWith('Current runtime context.') || c.startsWith('<system>')
    }
    const messages = (hist.messages || []).filter((m: any) => !isNoise(m))
    // 旧版远端 dsh-web-service 的 history 可能缺 assistant 消息 —— 用本地缓存产出补齐
    const hasAssistant = messages.some((m) => m?.role === 'assistant' && String(m?.content || '').trim())
    if (!hasAssistant && sub.result?.content) {
      messages.push({ role: 'assistant', content: sub.result.content, time: sub.completedAt, local: true })
    }
    if (!messages.some((m) => m?.role === 'user')) {
      messages.unshift({ role: 'user', content: sub.prompt, time: sub.startedAt || task.createdAt })
    }
    return {
      ok: true,
      source: hasAssistant ? 'remote' : 'mixed',
      note: hasAssistant ? undefined : '远端 history 未返回助手回复（旧版 dsh-web-service），已用本地缓存补齐',
      messages,
    }
  }

  private async subtaskFollowup(taskId: string, subtaskId: string, message: string): Promise<{ ok: boolean; reply?: string; error?: string }> {
    const task = this.store.getTask(taskId)
    const sub = task?.plan?.subtasks.find((s) => s.id === subtaskId)
    if (!task || !sub) return { ok: false, error: '子任务不存在' }
    const session = task.sessions?.[sub.agentId]
    const remoteSessionId = session?.remoteSessionId || sub.remoteSessionId
    if (!remoteSessionId) return { ok: false, error: '子任务尚未创建远程会话' }
    const agent = this.store.getAgent(sub.agentId)
    if (!agent) return { ok: false, error: '子智能体不存在' }
    const target = await this.resolver.resolve(agent)
    if (!target.online) return { ok: false, error: target.error }
    const res = await this.client.prompt(target, remoteSessionId, message, { timeoutMs: 120_000 })
    if (res.ok) return { ok: true, reply: res.content }
    return { ok: false, error: res.error }
  }
}

/** 校验并归一 dshRef 输入 */
export function normalizeDshRef(input: any): DshRef | { error: string } {
  if (!input || typeof input !== 'object') return { error: '缺少 dshRef（DSH 实体引用）' }
  if (input.kind === 'mapping' && input.mappingId) return { kind: 'mapping', mappingId: String(input.mappingId) }
  if (input.kind === 'app' && input.appId) return { kind: 'app', appId: String(input.appId) }
  if (input.kind === 'direct' && input.apiBaseUrl) return { kind: 'direct', apiBaseUrl: String(input.apiBaseUrl) }
  return { error: 'dshRef 不合法: 需要 {kind: mapping|app|direct, ...}' }
}

// ---------- 附件上传辅助 ----------

/** 读取原始请求体（Buffer，带大小上限） */
function readRawBuffer(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (c: Buffer) => {
      total += c.length
      if (total > maxBytes) {
        req.destroy()
        reject(new Error(`Payload too large (> ${maxBytes} bytes)`))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sanitizeUploadName(raw: string): string {
  let name = String(raw || '').split(/[\\/]/).pop() || ''
  // eslint-disable-next-line no-control-regex
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  if (!name || name === '.' || name === '..') name = `file-${Date.now()}`
  if (name.length > 180) {
    const ext = name.slice(name.lastIndexOf('.')).slice(0, 16)
    name = name.slice(0, 180 - ext.length) + ext
  }
  return name
}

/** 最小 multipart 解析：提取所有带 filename 的文件字段 */
function parseMultipartFiles(buffer: Buffer, contentType: string): Array<{ filename: string; data: Buffer; mimeType?: string }> {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  if (!m) return []
  const delim = Buffer.from('--' + (m[1] || m[2]).trim())
  const files: Array<{ filename: string; data: Buffer; mimeType?: string }> = []
  let pos = buffer.indexOf(delim)
  while (pos >= 0) {
    const start = pos + delim.length
    if (buffer.slice(start, start + 2).toString('utf-8') === '--') break
    const headStart = start + 2
    const headEnd = buffer.indexOf('\r\n\r\n', headStart)
    if (headEnd < 0) break
    const headerBlock = buffer.slice(headStart, headEnd).toString('utf-8')
    const bodyStart = headEnd + 4
    const next = buffer.indexOf(delim, bodyStart)
    if (next < 0) break
    let bodyEnd = next
    if (buffer.slice(bodyEnd - 2, bodyEnd).toString('utf-8') === '\r\n') bodyEnd -= 2
    let filename: string | undefined
    let mimeType: string | undefined
    for (const line of headerBlock.split('\r\n')) {
      const colon = line.indexOf(':')
      if (colon < 0) continue
      const key = line.slice(0, colon).trim()
      const value = line.slice(colon + 1).trim()
      if (/^content-disposition$/i.test(key)) {
        const fnStar = /filename\*=([^;\r\n]+)/i.exec(value)?.[1]
        if (fnStar) {
          const decoded = /^([^']*)''(.*)$/.exec(fnStar.trim())
          const v = decoded ? decoded[2] : fnStar.trim()
          filename = safeDecode(v)
        }
        if (!filename) {
          const fn = /filename="([^"]*)"/i.exec(value)?.[1] ?? /filename=([^;\r\n]+)/i.exec(value)?.[1]
          if (fn !== undefined) filename = safeDecode(fn)
        }
      } else if (/^content-type$/i.test(key)) {
        mimeType = value
      }
    }
    if (filename && buffer.slice(bodyStart, bodyEnd).length > 0) {
      files.push({ filename: sanitizeUploadName(filename), data: buffer.slice(bodyStart, bodyEnd), mimeType })
    }
    pos = next
  }
  return files
}

function safeDecode(v: string): string {
  const t = v.trim().replace(/^"|"$/g, '')
  try {
    return decodeURIComponent(t)
  } catch {
    return t
  }
}
