/**
 * onenat-workbuddy-web - HTTP Router & API Dispatcher
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
import type { ScheduleRunner } from './scheduler.js'
import { normalizeRule, nextRun, ruleText } from './scheduler.js'
import { SCHEDULE_TEMPLATES } from './schedule-templates.js'
import type { AuthService } from './auth.js'
import type { XiaozhiMcpClient } from './xiaozhi-mcp.js'
import type { DshRef, Project, SubAgent, WorkTask, ScheduledTask } from './types.js'
import type { MonitorService } from './monitor.js'
import { renderWebUi } from './web-ui.js'
import { renderMonitorUi } from './monitor-ui.js'
import { formatDateVersion, parseDateVersion, readPackageVersion } from './date-version.js'

/** 单个成员会话的「任务清单 + 运行时长」取数结果（/api/tasks/:id/todos 聚合用） */
interface MemberTodos {
  agentId: string
  agentName: string
  ok: boolean
  supported?: boolean
  error?: string
  todos?: Array<{ content: string; status: string }>
  running?: boolean
  elapsedMs?: number
  turnStartedAt?: number | null
  turnEndedAt?: number | null
  updatedAt?: number | null
  turns?: number
}

export class WorkBuddyRouter {
  private client = new DshClient()
  private version = formatDateVersion(readPackageVersion())

  constructor(
    private store: WorkStore,
    private directory: OnenatDirectory,
    private resolver: AgentResolver,
    private composer: PromptComposer,
    private planner: Planner,
    private engine: TaskEngine,
    private sshStore: SshResourceStore,
    private scheduler?: ScheduleRunner,
    private monitor?: MonitorService,
    private auth?: AuthService,
    private xiaozhi?: XiaozhiMcpClient,
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

  // ---------- 小智接入点辅助 ----------

  private xiaozhiEndpoints(): import('./types.js').XiaozhiEndpoint[] {
    return [...(this.store.getSettings().xiaozhi?.endpoints || [])]
  }

  private xiaozhiListWithStatus(list: import('./types.js').XiaozhiEndpoint[]) {
    const statusMap = new Map((this.xiaozhi?.listStatus() || []).map((s) => [s.id, s]))
    return list.map((e) => ({ ...e, connected: Boolean(statusMap.get(e.id)?.connected), stats: statusMap.get(e.id)?.stats }))
  }

  private saveXiaozhiEndpoints(list: import('./types.js').XiaozhiEndpoint[]): void {
    this.store.updateSettings({ xiaozhi: { endpoints: list } } as any)
    this.xiaozhi?.configureAll(list)
  }

  // ---------- 项目辅助 ----------

  private projectSummary(proj: Project) {
    const nodeTitle = proj.dshRef.kind === 'direct'
      ? proj.dshRef.apiBaseUrl
      : (proj.dshRef.kind === 'mapping'
        ? (this.directory.resolveMapping(proj.dshRef.mappingId)?.tunnelName || proj.dshRef.mappingId)
        : (this.directory.resolveApp(proj.dshRef.appId)?.appName || proj.dshRef.appId))
    return {
      id: proj.id,
      name: proj.name,
      dshRef: proj.dshRef,
      nodeTitle: nodeTitle || '(未配置节点)',
      workspace: proj.workspace || '',
      instructionPreview: (proj.instruction || '').slice(0, 120),
      expertIds: proj.expertIds,
      experts: proj.expertIds.map((id) => ({ id, name: this.store.getAgent(id)?.name || id })),
      connectorIds: proj.connectorIds,
      skillNames: proj.skillNames,
      createdAt: proj.createdAt,
      updatedAt: proj.updatedAt,
    }
  }

  /** 创建/更新项目（校验名称与节点；专家必须存在） */
  private upsertProjectFromInput(body: any): Project {
    const name = String(body?.name || '').trim()
    if (!name) throw new Error('缺少项目名称')
    const dshRef = body?.dshRef ? (body.dshRef as DshRef) : undefined
    const existing = body?.id ? this.store.getProject(String(body.id)) : undefined
    const finalRef = dshRef || existing?.dshRef
    if (!finalRef) throw new Error('缺少项目 DSH 节点（dshRef）')
    const expertIds = Array.isArray(body?.expertIds) ? body.expertIds.map(String) : (existing?.expertIds || [])
    for (const eid of expertIds) {
      if (!this.store.getAgent(eid)) throw new Error(`专家不存在: ${eid}`)
    }
    return this.store.upsertProject({
      id: body?.id ? String(body.id) : undefined,
      name,
      dshRef: finalRef,
      apiKey: body?.apiKey !== undefined ? String(body.apiKey) : undefined,
      workspace: body?.workspace !== undefined ? String(body.workspace) : undefined,
      instruction: body?.instruction !== undefined ? String(body.instruction) : undefined,
      expertIds,
      connectorIds: Array.isArray(body?.connectorIds) ? body.connectorIds.map(String) : (existing?.connectorIds || []),
      skillNames: Array.isArray(body?.skillNames) ? body.skillNames.map(String) : (existing?.skillNames || []),
    })
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
      projectId: t.projectId || undefined,
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

  // ---------- 定时任务辅助 ----------

  /** 校验 + 保存（create/update 共用） */
  private upsertScheduleFromInput(body: any): ScheduledTask {
    const name = String(body?.name || '').trim()
    if (!name) throw new Error('缺少名称')
    const agentIds = Array.isArray(body?.agentIds) ? Array.from(new Set((body.agentIds as any[]).map(String))) : []
    for (const aid of agentIds) {
      if (!this.store.getAgent(aid)) throw new Error(`子智能体不存在: ${aid}`)
    }
    const nodeMappingId = String(body?.nodeMappingId || '').trim()
    if (nodeMappingId && !this.directory.resolveMapping(nodeMappingId)) throw new Error(`DSH 节点不存在: ${nodeMappingId}`)
    // 新模型：节点必填（任务在节点上直发，@ sub agent 写在指令里）；兼容仅含 agentIds 的旧客户端
    if (!nodeMappingId && !agentIds.length) throw new Error('至少指定一个 DSH 节点（或在指令中 @ 子智能体）')
    const message = String(body?.message || '').trim()
    if (!message) throw new Error('任务文本不能为空')
    const existing = body?.id ? this.store.getSchedule(String(body.id)) : undefined
    const rule = normalizeRule(body?.rule ?? existing?.rule)
    // 编辑时保留触发历史；规则/启停变化后重算下次触发点
    const enabled = body?.enabled === undefined ? (existing?.enabled ?? true) : Boolean(body.enabled)
    const nextRunAt = enabled ? nextRun(rule, Date.now()) : undefined
    return this.store.upsertSchedule({
      id: body?.id ? String(body.id) : undefined,
      name,
      description: body?.description ? String(body.description) : undefined,
      agentIds,
      ...(nodeMappingId ? { nodeMappingId } : {}),
      message,
      rule,
      enabled,
      nextRunAt,
      ...(existing ? { runs: existing.runs, lastRunAt: existing.lastRunAt, createdAt: existing.createdAt, totalRuns: existing.totalRuns, successRuns: existing.successRuns } : {}),
    })
  }

  /** 列表摘要：剔除 runs（历史走详情） */
  private scheduleSummary(s: ScheduledTask) {
    const agents = s.agentIds.map((aid) => this.store.getAgent(aid)).filter(Boolean) as SubAgent[]
    const nodeTitle = s.nodeMappingId ? (this.directory.resolveMapping(s.nodeMappingId)?.tunnelName || s.nodeMappingId) : ''
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      agentIds: s.agentIds,
      agents: agents.map((a) => ({ id: a.id, name: a.name, enabled: a.enabled !== false })),
      nodeMappingId: s.nodeMappingId,
      nodeTitle,
      messagePreview: s.message.slice(0, 120),
      rule: s.rule,
      ruleText: ruleText(s.rule),
      enabled: s.enabled,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      lastRunAt: s.lastRunAt,
      nextRunAt: s.nextRunAt,
      runCount: (s.runs || []).length,
      totalRuns: s.totalRuns || 0,
      successRuns: s.successRuns || 0,
    }
  }

  /** 详情：全量 runs，并把每次派发关联到当前任务会话状态（供前端跳转会话回看） */
  private scheduleDetail(s: ScheduledTask) {
    return {
      ...this.scheduleSummary(s),
      message: s.message,
      runs: (s.runs || []).map((r) => ({
        id: r.id,
        triggeredAt: r.triggeredAt,
        manual: r.manual === true,
        durationMs: r.durationMs,
        items: r.items.map((it) => {
          const task = it.taskId ? this.store.getTask(it.taskId) : undefined
          return {
            ...it,
            taskStatus: task?.status,
            taskRunning: task ? this.engine.isRunning(task.id) : false,
          }
        }),
      })),
    }
  }

  /** 任务实时统计缓存：taskId → { at, result }；3s TTL 防止轮询打穿远端 */
  private statsCache = new Map<string, { at: number; result: { httpStatus: number; payload: any } }>()
  private statsInflight = new Map<string, Promise<{ httpStatus: number; payload: any }>>()

  /**
   * 聚合任务下所有成员远端会话的实时统计（字段语义对齐 DSH web StatsLine）：
   * 轮/步、LLM 与工具调用墙钟、首 token 均值与解码吞吐、缓存命中、token 账本。
   * 成员离线或远端版本过低（无 stats 接口）时跳过该成员，不阻断整体。
   */
  private async getTaskStats(taskId: string): Promise<{ httpStatus: number; payload: any }> {
    const cached = this.statsCache.get(taskId)
    if (cached && Date.now() - cached.at < 3000) return cached.result
    const inflight = this.statsInflight.get(taskId)
    if (inflight) return inflight
    const job = (async () => {
      const task = this.store.getTask(taskId)
      if (!task) {
        return { httpStatus: 404, payload: { ok: false, error: 'Task not found' } }
      }
      const bindings = Object.entries(task.sessions || {})
      const empty = {
        turns: 0, steps: 0, llmMs: 0, toolMs: 0,
        ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0,
        inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
      }
      const results = await Promise.all(bindings.map(async ([agentId, binding]) => {
        try {
          // 节点主会话（__node__）无智能体记录：按任务节点解析
          const agent = this.store.getAgent(agentId)
          const target = agent
            ? await this.resolver.resolve(agent)
            : await this.engine.resolveExecTarget(task, agentId)
          if (!target || !target.online || !target.baseUrl) return null
          const r = await this.client.getSessionStats(target, binding.remoteSessionId)
          if (!r.ok || !r.stats) return { agentId, ok: false, supported: r.supported !== false, error: r.error }
          return { agentId, ok: true, supported: true, stats: r.stats }
        } catch (err: any) {
          return { agentId, ok: false, supported: true, error: err?.message }
        }
      }))
      const totals = { ...empty }
      let sessionsOk = 0
      let sessionsTotal = 0
      let supported = false
      for (const r of results) {
        if (!r) continue
        sessionsTotal += 1
        if (r.ok) {
          supported = true
          sessionsOk += 1
          const st = r.stats
          if (st) {
            for (const k of Object.keys(empty) as Array<keyof typeof empty>) {
              totals[k] += st[k] || 0
            }
          }
        } else if (r.supported) {
          supported = true
        }
      }
      // 无绑定（纯本地 DSH 任务）或全部成员远端过旧时不支持
      if (bindings.length === 0) supported = false
      const payload = {
        ok: true,
        data: {
          taskId,
          supported,
          sessionsOk,
          sessionsTotal,
          stats: supported ? totals : undefined,
        },
      }
      const result = { httpStatus: 200, payload }
      this.statsCache.set(taskId, { at: Date.now(), result })
      return result
    })()
    this.statsInflight.set(taskId, job)
    try {
      return await job
    } finally {
      this.statsInflight.delete(taskId)
    }
  }

  /** 任务清单缓存：taskId → { at, result }；2s TTL（清单随 todo_write 步进变化，需要更灵敏） */
  private todosCache = new Map<string, { at: number; result: { httpStatus: number; payload: any } }>()
  private todosInflight = new Map<string, Promise<{ httpStatus: number; payload: any }>>()

  /**
   * 任务的「任务清单 + 运行时长」：读远端 DSH 会话的 todo_write 投影
   * （dsh-web-service ≥ 0.1.8 `GET /sessions/:id/todos`）。
   *
   * 取数顺序：主智能体会话优先（清单语义上属于主调度的计划），主智能体没有清单时
   * 回退到第一个有清单的成员；都没有清单时返回主智能体（或首个可达成员）的
   * running/elapsedMs，让前端仍能展示运行时长。
   */
  private async getTaskTodos(taskId: string): Promise<{ httpStatus: number; payload: any }> {
    const cached = this.todosCache.get(taskId)
    if (cached && Date.now() - cached.at < 2000) return cached.result
    const inflight = this.todosInflight.get(taskId)
    if (inflight) return inflight
    const job = (async () => {
      const task = this.store.getTask(taskId)
      if (!task) {
        return { httpStatus: 404, payload: { ok: false, error: 'Task not found' } }
      }
      const memberIds = Object.keys(task.sessions || {})
      const mainAgent = this.planner.pickMainAgent()
      const mainId = mainAgent && memberIds.includes(mainAgent.id) ? mainAgent.id : ''
      // 主智能体优先，其余成员按绑定顺序兜底
      const ordered = [...(mainId ? [mainId] : []), ...memberIds.filter((id) => id !== mainId)]
      if (ordered.length === 0) {
        const result = {
          httpStatus: 200,
          payload: {
            ok: true,
            data: {
              taskId, supported: false, agentId: '', agentName: '',
              todos: [], counts: { completed: 0, inProgress: 0, pending: 0 },
              running: false, elapsedMs: 0, turnStartedAt: null, turnEndedAt: null, updatedAt: null, turns: 0,
              members: [],
            },
          },
        }
        this.todosCache.set(taskId, { at: Date.now(), result })
        return result
      }
      const results = await Promise.all(ordered.map(async (agentId): Promise<MemberTodos> => {
        const agent = this.store.getAgent(agentId)
        const binding = task.sessions[agentId]
        const agentName = agent?.name || (agentId === '__node__' ? '主会话' : agentId)
        try {
          if (!binding?.remoteSessionId) return { agentId, agentName, ok: false, supported: true, error: '成员会话未建立' }
          // 节点主会话（__node__）无智能体记录：按任务节点解析
          const target = agent
            ? await this.resolver.resolve(agent)
            : await this.engine.resolveExecTarget(task, agentId)
          if (!target || !target.online || !target.baseUrl) return { agentId, agentName, ok: false, supported: true, error: (target as any)?.error || '节点离线' }
          const r = await this.client.getSessionTodos(target, binding.remoteSessionId)
          if (!r.ok) return { agentId, agentName, ok: false, supported: r.supported !== false, error: r.error }
          return {
            agentId, agentName, ok: true, supported: true,
            todos: r.todos || [], running: !!r.running, elapsedMs: r.elapsedMs || 0,
            turnStartedAt: r.turnStartedAt ?? null, turnEndedAt: r.turnEndedAt ?? null,
            updatedAt: r.updatedAt ?? null, turns: r.turns || 0,
          }
        } catch (err: any) {
          return { agentId, agentName, ok: false, supported: true, error: err?.message }
        }
      }))
      const supported = results.some((r) => r.ok || r.supported)
      // 选主：有清单的最靠前成员 → 否则主智能体（若有远端会话）→ 否则首个可达成员
      const withTodos = results.find((r) => r.ok && r.todos && r.todos.length > 0)
      const mainResult = mainId ? results.find((r) => r.agentId === mainId) : undefined
      const pick = withTodos
        || (mainResult && mainResult.ok ? mainResult : undefined)
        || results.find((r) => r.ok)
      const todos = (pick?.todos || []).map((x) => ({
        content: x.content,
        status: x.status === 'in_progress' || x.status === 'completed' ? x.status : 'pending',
      }))
      const data = {
        taskId,
        supported,
        agentId: pick?.agentId || '',
        agentName: pick?.agentName || '',
        todos,
        counts: {
          completed: todos.filter((x) => x.status === 'completed').length,
          inProgress: todos.filter((x) => x.status === 'in_progress').length,
          pending: todos.filter((x) => x.status === 'pending').length,
        },
        running: !!(pick?.ok && pick.running),
        elapsedMs: pick?.ok ? pick.elapsedMs || 0 : 0,
        turnStartedAt: pick?.turnStartedAt ?? null,
        turnEndedAt: pick?.turnEndedAt ?? null,
        updatedAt: pick?.updatedAt ?? null,
        turns: pick?.turns || 0,
        serverTime: Date.now(),
        members: results.map((r) => ({
          agentId: r.agentId, agentName: r.agentName, ok: r.ok,
          count: r.ok ? (r.todos?.length || 0) : 0,
          error: r.ok ? undefined : r.error,
        })),
      }
      const result = { httpStatus: 200, payload: { ok: true, data } }
      this.todosCache.set(taskId, { at: Date.now(), result })
      return result
    })()
    this.todosInflight.set(taskId, job)
    try {
      return await job
    } finally {
      this.todosInflight.delete(taskId)
    }
  }

  /** 技能目录缓存：taskId|q → { at, result }（10s TTL；技能变更低频，前端每次触发带 q 过滤） */
  private skillsCache = new Map<string, { at: number; result: { httpStatus: number; payload: any } }>()
  private skillsInflight = new Map<string, Promise<{ httpStatus: number; payload: any }>>()

  /**
   * 聚合任务成员的技能目录（对齐 harness "/" 触发源的 skills/list）：
   * 按技能名去重合并各成员目录，标注该技能在哪些成员可用。
   * 成员已有远端会话 → 会话作用域目录（/sessions/:id/skills，按会话 cwd）；
   * 尚无会话（新建任务未派发）→ 回退成员默认技能根（GET /skills?cwd=workDir，与新会话目录一致）。
   * 远端不可达的成员跳过；全部不可用（supported=false）时前端隐藏 "/" 弹层
   * （不影响手输 /name——宿主手势注入仍然生效）。
   */
  private async getTaskSkills(taskId: string, q: string): Promise<{ httpStatus: number; payload: any }> {
    const key = taskId + '|' + q.toLowerCase()
    const cached = this.skillsCache.get(key)
    if (cached && Date.now() - cached.at < 10_000) return cached.result
    const inflight = this.skillsInflight.get(key)
    if (inflight) return inflight
    const job = (async () => {
      const task = this.store.getTask(taskId)
      if (!task) {
        return { httpStatus: 404, payload: { ok: false, error: 'Task not found' } }
      }
      const memberIds = task.memberAgentIds?.length ? task.memberAgentIds : Object.keys(task.sessions || {})
      const perMember = await Promise.all(memberIds.map(async (agentId) => {
        try {
          const agent = this.store.getAgent(agentId)
          const agentName = agent?.name || (agentId === '__node__' ? '主会话' : agentId)
          if (!agent && agentId !== '__node__') return null
          // 节点主会话（__node__）无智能体记录：按任务节点解析（仅会话作用域，无默认技能根回退）
          const target = agent
            ? await this.resolver.resolve(agent)
            : await this.engine.resolveExecTarget(task, agentId)
          if (!target || !target.online || !target.baseUrl) return { agentId, agentName, ok: false, supported: true, skills: [] }
          const binding = task.sessions?.[agentId]
          if (binding?.remoteSessionId) {
            const r = await this.client.getSessionSkills(target, binding.remoteSessionId, q)
            if (!r.ok) return { agentId, agentName, ok: false, supported: r.supported !== false, skills: [] }
            return { agentId, agentName, ok: true, supported: true, skills: r.skills || [] }
          }
          // 无会话绑定：回退默认技能根（cwd 用成员工作目录，等价新会话目录）
          const r = await this.client.listSkills(target, { cwd: agent?.workDir || undefined, search: q || undefined })
          if (!r.ok) return { agentId, agentName, ok: false, supported: r.unsupported !== true, skills: [] }
          return { agentId, agentName, ok: true, supported: true, skills: r.skills || [] }
        } catch {
          return null
        }
      }))
      const byName = new Map<string, { name: string; description?: string; whenToUse?: string; modelInvocable?: boolean; userInvocable?: boolean; agents: string[] }>()
      let sessionsOk = 0
      let sessionsTotal = 0
      let supported = false
      for (const r of perMember) {
        if (!r) continue
        sessionsTotal += 1
        if (!r.supported) continue
        supported = true
        if (!r.ok) continue
        sessionsOk += 1
        for (const sk of r.skills) {
          if (!sk?.name) continue
          const existing = byName.get(sk.name)
          if (existing) {
            if (!existing.agents.includes(r.agentName)) existing.agents.push(r.agentName)
            if (!existing.description && sk.description) existing.description = sk.description
          } else {
            byName.set(sk.name, {
              name: sk.name,
              description: sk.description,
              whenToUse: sk.whenToUse,
              modelInvocable: sk.modelInvocable !== false,
              userInvocable: sk.userInvocable !== false,
              agents: [r.agentName],
            })
          }
        }
      }
      const skills = [...byName.values()]
        .sort((a, b) => a.name.localeCompare(b.name))
      const result = {
        httpStatus: 200,
        payload: {
          ok: true,
          data: { taskId, q, supported, sessionsOk, sessionsTotal, count: skills.length, skills },
        },
      }
      this.skillsCache.set(key, { at: Date.now(), result })
      return result
    })()
    this.skillsInflight.set(key, job)
    try {
      return await job
    } finally {
      this.skillsInflight.delete(key)
    }
  }

  public async dispatch(req: IncomingMessage, res: ServerResponse, prefix: string, opts?: { auth?: boolean }): Promise<boolean> {
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
      res.end(renderWebUi(prefix, { ...opts, version: this.version }))
      return true
    }

    // ---------- 监控投屏页（独立暗色全屏） ----------
    if (method === 'GET' && (p === '/monitor' || p === '/monitor/')) {
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('Cache-Control', 'no-store')
      res.end(renderMonitorUi(prefix, this.version))
      return true
    }

    // ---------- 小智 MCP 接入（语音助手页，多实例管理；控制台会话） ----------
    if (p === '/api/xiaozhi/status' && method === 'GET') {
      const statusMap = new Map((this.xiaozhi?.listStatus() || []).map((s) => [s.id, s]))
      const endpoints = (this.store.getSettings().xiaozhi?.endpoints || []).map((e) => ({
        ...e,
        connected: Boolean(statusMap.get(e.id)?.connected),
        stats: statusMap.get(e.id)?.stats,
      }))
      this.sendJson(res, 200, { ok: true, data: { configured: endpoints.some((e) => e.enabled), endpoints } })
      return true
    }
    if (p === '/api/xiaozhi/endpoints' && method === 'POST') {
      const body = await this.parseBody(req)
      const endpoint = String(body?.endpoint || '').trim()
      if (!/^wss?:\/\//.test(endpoint)) {
        this.sendJson(res, 400, { ok: false, error: '接入点必须是 ws:// 或 wss:// 地址' })
        return true
      }
      const list = [...(this.store.getSettings().xiaozhi?.endpoints || [])]
      const id = String(body?.id || '') || `xz-${Math.random().toString(36).slice(2, 8)}`
      const name = String(body?.name || '').trim() || undefined
      const enabled = body?.enabled === undefined ? true : Boolean(body.enabled)
      const idx = list.findIndex((e) => e.id === id)
      const entry = { id, ...(name ? { name } : {}), endpoint, enabled } as import('./types.js').XiaozhiEndpoint
      if (idx >= 0) list[idx] = { ...list[idx], ...entry }
      else list.push(entry)
      this.saveXiaozhiEndpoints(list)
      this.sendJson(res, 200, { ok: true, data: { endpoint: entry, endpoints: this.xiaozhiListWithStatus(list) } })
      return true
    }
    const xzDelMatch = /^\/api\/xiaozhi\/endpoints\/([^/]+)$/.exec(p)
    if (xzDelMatch && method === 'DELETE') {
      const id = decodeURIComponent(xzDelMatch[1])
      const list = (this.store.getSettings().xiaozhi?.endpoints || []).filter((e) => e.id !== id)
      this.saveXiaozhiEndpoints(list)
      this.sendJson(res, 200, { ok: true, data: { deleted: true, endpoints: this.xiaozhiListWithStatus(list) } })
      return true
    }

    // ---------- 项目（列表/创建/详情/修改/删除） ----------
    if (p === '/api/projects' && method === 'GET') {
      this.sendJson(res, 200, { ok: true, data: this.store.getProjects().map((proj) => this.projectSummary(proj)) })
      return true
    }
    if (p === '/api/projects' && method === 'POST') {
      const body = await this.parseBody(req)
      try {
        const saved = this.upsertProjectFromInput(body)
        this.sendJson(res, 200, { ok: true, data: this.projectSummary(saved) })
      } catch (err: any) {
        this.sendJson(res, 400, { ok: false, error: err?.message || String(err) })
      }
      return true
    }
    const projMatch = /^\/api\/projects\/([^/]+)$/.exec(p)
    if (projMatch) {
      const id = decodeURIComponent(projMatch[1])
      const proj = this.store.getProject(id)
      if (method === 'GET') {
        if (!proj) { this.sendJson(res, 404, { ok: false, error: '项目不存在' }); return true }
        this.sendJson(res, 200, { ok: true, data: this.projectSummary(proj) })
        return true
      }
      if (method === 'DELETE') {
        this.sendJson(res, 200, { ok: true, data: { deleted: this.store.deleteProject(id) } })
        return true
      }
      if (method === 'PATCH' || method === 'PUT') {
        const body = await this.parseBody(req)
        try {
          const saved = this.upsertProjectFromInput({ ...body, id })
          this.sendJson(res, 200, { ok: true, data: this.projectSummary(saved) })
        } catch (err: any) {
          this.sendJson(res, 400, { ok: false, error: err?.message || String(err) })
        }
        return true
      }
    }

    // ---------- 监控大屏（只读聚合） ----------
    if (this.monitor && p === '/api/monitor/overview' && method === 'GET') {
      try {
        const data = await this.monitor.getOverview()
        this.sendJson(res, 200, { ok: true, data })
      } catch (err: any) {
        this.sendJson(res, 500, { ok: false, error: err?.message || String(err) })
      }
      return true
    }
    if (this.monitor && p === '/api/monitor/events' && method === 'GET') {
      const url = new URL(req.url || '/', 'http://localhost')
      const limit = Number(url.searchParams.get('limit') || 200)
      this.sendJson(res, 200, { ok: true, data: this.monitor.getRecentEvents(limit) })
      return true
    }
    if (this.monitor && p === '/api/monitor/history' && method === 'GET') {
      const url = new URL(req.url || '/', 'http://localhost')
      const days = Number(url.searchParams.get('days') || 7)
      this.sendJson(res, 200, { ok: true, data: { days: this.monitor.readHistory(days) } })
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

    // ---------- 定时任务 ----------
    if (p === '/api/schedule-templates' && method === 'GET') {
      this.sendJson(res, 200, { ok: true, data: SCHEDULE_TEMPLATES })
      return true
    }
    if (p === '/api/schedules' && method === 'GET') {
      const list = this.store.getSchedules().map((s) => this.scheduleSummary(s))
      this.sendJson(res, 200, { ok: true, data: list })
      return true
    }
    if (p === '/api/schedules' && method === 'POST') {
      const body = await this.parseBody(req)
      try {
        const saved = this.upsertScheduleFromInput(body)
        this.sendJson(res, 200, { ok: true, data: this.scheduleSummary(saved) })
      } catch (err: any) {
        this.sendJson(res, 400, { ok: false, error: err?.message || String(err) })
      }
      return true
    }
    const schedMatch = /^\/api\/schedules\/([^/]+)$/.exec(p)
    if (schedMatch) {
      const id = decodeURIComponent(schedMatch[1])
      if (method === 'GET') {
        const s = this.store.getSchedule(id)
        if (!s) {
          this.sendJson(res, 404, { ok: false, error: '定时任务不存在' })
          return true
        }
        this.sendJson(res, 200, { ok: true, data: this.scheduleDetail(s) })
        return true
      }
      if (method === 'DELETE') {
        const ok = this.store.deleteSchedule(id)
        this.sendJson(res, 200, { ok: true, data: { deleted: ok } })
        return true
      }
      if (method === 'PATCH' || method === 'PUT') {
        const body = await this.parseBody(req)
        try {
          const saved = this.upsertScheduleFromInput({ ...body, id })
          this.sendJson(res, 200, { ok: true, data: this.scheduleSummary(saved) })
        } catch (err: any) {
          this.sendJson(res, 400, { ok: false, error: err?.message || String(err) })
        }
        return true
      }
    }
    const schedToggleMatch = /^\/api\/schedules\/([^/]+)\/toggle$/.exec(p)
    if (schedToggleMatch && method === 'POST') {
      const id = decodeURIComponent(schedToggleMatch[1])
      const s = this.store.getSchedule(id)
      if (!s) {
        this.sendJson(res, 404, { ok: false, error: '定时任务不存在' })
        return true
      }
      const enabled = !s.enabled
      this.store.mutateSchedule(id, (t) => {
        t.enabled = enabled
        t.nextRunAt = enabled ? nextRun(t.rule, Date.now()) : undefined
      })
      this.sendJson(res, 200, { ok: true, data: this.scheduleSummary(this.store.getSchedule(id)!) })
      return true
    }
    const schedRunMatch = /^\/api\/schedules\/([^/]+)\/run$/.exec(p)
    if (schedRunMatch && method === 'POST') {
      const id = decodeURIComponent(schedRunMatch[1])
      if (!this.store.getSchedule(id)) {
        this.sendJson(res, 404, { ok: false, error: '定时任务不存在' })
        return true
      }
      if (!this.scheduler) {
        this.sendJson(res, 500, { ok: false, error: '调度器未装配' })
        return true
      }
      try {
        const run = await this.scheduler.fire(id, true)
        this.sendJson(res, 200, { ok: true, data: run })
      } catch (err: any) {
        this.sendJson(res, 500, { ok: false, error: err?.message || String(err) })
      }
      return true
    }

    // ---------- 版本信息 ----------
    if (p === '/api/version' && method === 'GET') {
      const parts = parseDateVersion(this.version)
      this.sendJson(res, 200, {
        ok: true,
        data: {
          version: this.version,
          name: 'onenat-workbuddy-web',
          scheme: parts ? 'date' : 'unknown',
          ...(parts ? { year: parts.year, month: parts.month, day: parts.day } : {}),
          buildDate: new Date().toISOString(),
        },
      })
      return true
    }

    // ---------- 设置 ----------
    if (p === '/api/settings' && method === 'GET') {
      const s = this.store.getSettings()
      this.sendJson(res, 200, { ok: true, data: { ...s, onenat: { ...s.onenat, apiKey: s.onenat.apiKey ? s.onenat.apiKey.slice(0, 8) + '…' : '' }, aiToken: this.auth?.getAiToken() || '' } })
      return true
    }
    // AI APIKEY 重置（仅登录会话；旧令牌立即失效，无需重启）
    if (p === '/api/settings/ai-token/reset' && method === 'POST') {
      if (!this.auth) {
        this.sendJson(res, 500, { ok: false, error: '认证服务未装配' })
        return true
      }
      const token = this.auth.resetAiToken()
      this.sendJson(res, 200, { ok: true, data: { token } })
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
      if (body.xiaozhi) patch.xiaozhi = body.xiaozhi
      const updated = this.store.updateSettings(patch)
      this.directory.configure(updated.onenat.baseUrl, updated.onenat.apiKey)
      this.directory.startAutoRefresh(updated.onenat.autoRefreshMs)
      // 小智 MCP 接入点变更即时生效（免重启；兼容旧 {endpoint} 与新 {endpoints[]} 两种形状）
      if (patch.xiaozhi) {
        const list = Array.isArray(updated.xiaozhi?.endpoints) && updated.xiaozhi?.endpoints.length
          ? updated.xiaozhi.endpoints
          : (typeof updated.xiaozhi?.endpoint === 'string' && updated.xiaozhi.endpoint
              ? [{ id: 'xz-default', endpoint: updated.xiaozhi.endpoint, enabled: true }]
              : [])
        this.xiaozhi?.configureAll(list as any)
      }
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
    // 远端目录浏览与工作区文件管理
    if (p === '/api/agents/fs/list' && method === 'GET') {
      const url = new URL(req.url || '/', 'http://localhost')
      // 项目工作目录浏览：node=<dshRef JSON>（与 agent 参数二选一）
      const nodeParam = url.searchParams.get('node') || ''
      let target: any = null
      if (nodeParam) {
        let nref: any
        try { nref = JSON.parse(nodeParam) } catch { this.sendJson(res, 400, { ok: false, error: 'node 参数非法（需 dshRef JSON）' }); return true }
        target = await this.resolver.resolveRef(nref, undefined, 'project-node')
        if (!target.online || !target.baseUrl) {
          this.sendJson(res, 502, { ok: false, error: target.error || '节点不可达' })
          return true
        }
      } else {
        const agentId = String(url.searchParams.get('agent') || '')
        const agent = this.store.getAgent(agentId)
        if (!agent) {
          this.sendJson(res, 404, { ok: false, error: 'Agent not found' })
          return true
        }
        target = await this.resolver.resolve(agent)
        if (!target.online || !target.baseUrl) {
          this.sendJson(res, 502, { ok: false, error: target.error || '节点不可达' })
          return true
        }
      }
      const dirPath = url.searchParams.get('path') || undefined
      const all = url.searchParams.get('all') === '1' || url.searchParams.get('all') === 'true'
      const out = await this.client.fsList(target, dirPath || undefined, all)
      this.sendJson(res, out.ok ? 200 : 400, out.ok ? out : { ok: false, error: out.error })
      return true
    }
    if (p === '/api/agents/fs/download' && method === 'GET') {
      const url = new URL(req.url || '/', 'http://localhost')
      const agentId = String(url.searchParams.get('agent') || '')
      const agent = this.store.getAgent(agentId)
      if (!agent) {
        this.sendJson(res, 404, { ok: false, error: 'Agent not found' })
        return true
      }
      const target = await this.resolver.resolve(agent)
      if (!target.online || !target.baseUrl) {
        this.sendJson(res, 502, { ok: false, error: target.error || '节点不可达' })
        return true
      }
      const filePath = String(url.searchParams.get('path') || '').trim()
      if (!filePath) {
        this.sendJson(res, 400, { ok: false, error: '缺少 path 参数' })
        return true
      }
      const inline = url.searchParams.get('inline') === '1'
      const out = await this.client.fsDownload(target, filePath, inline)
      if (!out.ok || !out.res?.body) {
        this.sendJson(res, 404, { ok: false, error: out.error || '文件下载失败' })
        return true
      }
      const name = out.name || 'file'
      res.statusCode = 200
      const ct = out.res.headers.get('content-type') || 'application/octet-stream'
      const cl = out.res.headers.get('content-length')
      res.setHeader('Content-Type', ct)
      if (cl) res.setHeader('Content-Length', cl)
      res.setHeader('X-Content-Type-Options', 'nosniff')
      const asciiFallback = name.replace(/[^\x20-\x7e]/g, '_') || 'download'
      res.setHeader(
        'Content-Disposition',
        `${inline ? 'inline' : 'attachment'}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      )
      Readable.fromWeb(out.res.body as any).pipe(res)
      return true
    }
    if (p === '/api/agents/fs/upload' && method === 'POST') {
      const url = new URL(req.url || '/', 'http://localhost')
      const agentId = String(url.searchParams.get('agent') || '')
      const destDir = String(url.searchParams.get('path') || '').trim()
      const agent = this.store.getAgent(agentId)
      if (!agent) {
        this.sendJson(res, 404, { ok: false, error: 'Agent not found' })
        return true
      }
      if (!destDir) {
        this.sendJson(res, 400, { ok: false, error: '缺少目标目录 path' })
        return true
      }
      const target = await this.resolver.resolve(agent)
      if (!target.online || !target.baseUrl) {
        this.sendJson(res, 502, { ok: false, error: target.error || '节点不可达' })
        return true
      }
      const contentType = String(req.headers['content-type'] || '')
      const raw = await readRawBuffer(req, UPLOAD_MAX_BYTES)
      if (raw.length === 0) {
        this.sendJson(res, 400, { ok: false, error: '请求体为空' })
        return true
      }
      let files: Array<{ filename: string; data: Buffer; mimeType?: string }> = []
      if (/^multipart\/form-data/i.test(contentType)) {
        files = parseMultipartFiles(raw, contentType)
      } else {
        const rawName = (url.searchParams.get('filename') || String(req.headers['x-filename'] || '')).trim()
        files = [{ filename: sanitizeUploadName(rawName || `upload-${Date.now()}`), data: raw, mimeType: contentType }]
      }
      const out = await this.client.fsUpload(target, destDir, files)
      this.sendJson(res, out.ok ? 200 : 400, out.ok ? out : { ok: false, error: out.error })
      return true
    }
    if (p === '/api/agents/fs/remove' && (method === 'DELETE' || method === 'POST')) {
      const url = new URL(req.url || '/', 'http://localhost')
      const body = method === 'POST' ? await this.parseBody(req) : null
      const agentId = String(url.searchParams.get('agent') || body?.agent || '')
      const targetPath = String(url.searchParams.get('path') || body?.path || '').trim()
      const agent = this.store.getAgent(agentId)
      if (!agent) {
        this.sendJson(res, 404, { ok: false, error: 'Agent not found' })
        return true
      }
      if (!targetPath) {
        this.sendJson(res, 400, { ok: false, error: '缺少 path 参数' })
        return true
      }
      const target = await this.resolver.resolve(agent)
      if (!target.online || !target.baseUrl) {
        this.sendJson(res, 502, { ok: false, error: target.error || '节点不可达' })
        return true
      }
      const out = await this.client.fsRemove(target, targetPath)
      this.sendJson(res, out.ok ? 200 : 400, out.ok ? out : { ok: false, error: out.error })
      return true
    }
    if (p === '/api/agents/fs/mkdir' && method === 'POST') {
      const body = await this.parseBody(req)
      // 项目工作目录浏览：node=<dshRef JSON>（与 agent 参数二选一）
      if (body?.node) {
        // 兼容字符串 JSON 与对象两种形态
        const nref = typeof body.node === 'string' ? (() => { try { return JSON.parse(body.node) } catch { return null } })() : body.node
        if (!nref || !nref.kind) { this.sendJson(res, 400, { ok: false, error: 'node 参数非法（需 dshRef JSON）' }); return true }
        const nt = await this.resolver.resolveRef(nref, undefined, 'project-node')
        if (!nt.online || !nt.baseUrl) { this.sendJson(res, 502, { ok: false, error: nt.error || '节点不可达' }); return true }
        const outM = await this.client.fsMkdir(nt, String(body?.path || ''), String(body?.name || ''))
        this.sendJson(res, outM.ok ? 200 : 400, outM.ok ? outM : { ok: false, error: outM.error })
        return true
      }
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
    // ---- 技能管理（技能中心，目标节点 = 当前编辑的子智能体） ----
    // 列出该节点已安装技能
    const skillsMatch = /^\/api\/agents\/([^/]+)\/skills$/.exec(p)
    if (skillsMatch && method === 'GET') {
      const aid = decodeURIComponent(skillsMatch[1])
      const url = new URL(req.url || '/', 'http://localhost')
      const agent = this.store.getAgent(aid)
      if (!agent) {
        this.sendJson(res, 404, { ok: false, error: 'Agent not found' })
        return true
      }
      const target = await this.resolver.resolve(agent)
      if (!target.online) {
        this.sendJson(res, 200, { ok: false, error: target.error, data: { skills: [], bindings: agent.skills || [] } })
        return true
      }
      const r = await this.client.listSkills(target, {
        root: url.searchParams.get('root') || undefined,
        cwd: url.searchParams.get('cwd') || agent.workDir || undefined,
        search: url.searchParams.get('search') || undefined,
      })
      if (r.unsupported) {
        this.sendJson(res, 200, { ok: false, error: r.error, data: { skills: [], bindings: agent.skills || [], unsupported: true } })
        return true
      }
      this.sendJson(res, 200, { ok: true, data: { ...r, bindings: agent.skills || [] } })
      return true
    }
    // 读取绑定技能
    const bindingsMatch = /^\/api\/agents\/([^/]+)\/skills\/bindings$/.exec(p)
    if (bindingsMatch && method === 'GET') {
      const aid = decodeURIComponent(bindingsMatch[1])
      const agent = this.store.getAgent(aid)
      if (!agent) {
        this.sendJson(res, 404, { ok: false, error: 'Agent not found' })
        return true
      }
      this.sendJson(res, 200, { ok: true, data: { bindings: agent.skills || [] } })
      return true
    }
    if (bindingsMatch && method === 'POST') {
      const aid = decodeURIComponent(bindingsMatch[1])
      const agent = this.store.getAgent(aid)
      if (!agent) {
        this.sendJson(res, 404, { ok: false, error: 'Agent not found' })
        return true
      }
      const body = await this.parseBody(req)
      const skills = Array.isArray(body?.skills) ? body.skills.map((s: any) => String(s)).filter(Boolean) : []
      this.store.mutateAgent(aid, (a) => { a.skills = skills })
      this.sendJson(res, 200, { ok: true, data: { bindings: skills } })
      return true
    }
    // 上传技能压缩包到该节点
    const uploadMatch = /^\/api\/agents\/([^/]+)\/skills\/upload$/.exec(p)
    if (uploadMatch && method === 'POST') {
      const aid = decodeURIComponent(uploadMatch[1])
      const agent = this.store.getAgent(aid)
      if (!agent) {
        this.sendJson(res, 404, { ok: false, error: 'Agent not found' })
        return true
      }
      const target = await this.resolver.resolve(agent)
      if (!target.online) {
        this.sendJson(res, 200, { ok: false, error: target.error })
        return true
      }
      const contentType = String(req.headers['content-type'] || '')
      const raw = await readRawBuffer(req, UPLOAD_MAX_BYTES)
      if (raw.length === 0) {
        this.sendJson(res, 400, { ok: false, error: '请求体为空：请以 multipart/form-data 上传技能压缩包' })
        return true
      }
      const parts = parseMultipartParts(raw, contentType)
      const file = parts.find((p) => p.filename !== undefined && p.data.length > 0)
      const fields: Record<string, string> = {}
      for (const p of parts) {
        if (p.name !== undefined && p.filename === undefined) fields[p.name] = p.data.toString('utf-8')
      }
      if (!file) {
        this.sendJson(res, 400, { ok: false, error: 'multipart 中未找到技能压缩包文件字段' })
        return true
      }
      const r = await this.client.uploadSkill(target, { filename: file.filename || 'skill.zip', data: file.data }, {
        root: fields.root || undefined,
        name: fields.name || undefined,
        cwd: fields.cwd || agent.workDir || undefined,
      })
      if (r.unsupported) this.sendJson(res, 200, { ok: false, error: r.error, data: { unsupported: true } })
      else if (!r.ok) this.sendJson(res, 200, { ok: false, error: r.error })
      else this.sendJson(res, 200, { ok: true, data: r })
      return true
    }
    // 技能详情/正文（预览 + 下载）
    const skillPreviewMatch = /^\/api\/agents\/([^/]+)\/skills\/preview$/.exec(p)
    if (skillPreviewMatch && method === 'GET') {
      const aid = decodeURIComponent(skillPreviewMatch[1])
      const agent = this.store.getAgent(aid)
      if (!agent) {
        this.sendJson(res, 404, { ok: false, error: 'Agent not found' })
        return true
      }
      const url = new URL(req.url || '/', 'http://localhost')
      const name = (url.searchParams.get('name') || '').trim()
      if (!name) {
        this.sendJson(res, 400, { ok: false, error: '缺少 name 参数' })
        return true
      }
      const target = await this.resolver.resolve(agent)
      if (!target.online) {
        this.sendJson(res, 200, { ok: false, error: target.error })
        return true
      }
      const r = await this.client.getSkill(target, name, {
        root: url.searchParams.get('root') || undefined,
        cwd: url.searchParams.get('cwd') || agent.workDir || undefined,
      })
      if (r.unsupported) this.sendJson(res, 200, { ok: false, error: r.error, data: { unsupported: true } })
      else if (!r.ok) this.sendJson(res, 200, { ok: false, error: r.error })
      else this.sendJson(res, 200, { ok: true, data: r.skill })
      return true
    }
    // 删除技能
    const skillDelMatch = /^\/api\/agents\/([^/]+)\/skills\/([^/]+)$/.exec(p)
    if (skillDelMatch && method === 'DELETE') {
      const aid = decodeURIComponent(skillDelMatch[1])
      const name = decodeURIComponent(skillDelMatch[2])
      const agent = this.store.getAgent(aid)
      if (!agent) {
        this.sendJson(res, 404, { ok: false, error: 'Agent not found' })
        return true
      }
      const url = new URL(req.url || '/', 'http://localhost')
      const target = await this.resolver.resolve(agent)
      if (!target.online) {
        this.sendJson(res, 200, { ok: false, error: target.error })
        return true
      }
      const r = await this.client.deleteSkill(target, name, {
        root: url.searchParams.get('root') || undefined,
        cwd: url.searchParams.get('cwd') || agent.workDir || undefined,
      })
      if (!r.ok) this.sendJson(res, 200, { ok: false, error: r.error })
      else this.sendJson(res, 200, { ok: true, data: { name } })
      return true
    }
    // 下载技能 SKILL.md 全文（代理 text/markdown）
    const skillDlMatch = /^\/api\/agents\/([^/]+)\/skills\/([^/]+)\/download$/.exec(p)
    if (skillDlMatch && method === 'GET') {
      const aid = decodeURIComponent(skillDlMatch[1])
      const name = decodeURIComponent(skillDlMatch[2])
      const agent = this.store.getAgent(aid)
      if (!agent) {
        this.sendJson(res, 404, { ok: false, error: 'Agent not found' })
        return true
      }
      const url = new URL(req.url || '/', 'http://localhost')
      const target = await this.resolver.resolve(agent)
      if (!target.online) {
        this.sendJson(res, 200, { ok: false, error: target.error })
        return true
      }
      const r = await this.client.downloadSkillArchive(target, name, {
        root: url.searchParams.get('root') || undefined,
        cwd: url.searchParams.get('cwd') || agent.workDir || undefined,
      })
      if (r.unsupported) this.sendJson(res, 200, { ok: false, error: r.error, data: { unsupported: true } })
      else if (!r.ok || !r.res?.body) this.sendJson(res, 200, { ok: false, error: r.error || '下载失败' })
      else {
        const ascii = name.replace(/[^\x20-\x7e]/g, '_') || 'skill'
        res.statusCode = 200
        res.setHeader('Content-Type', r.res.headers.get('content-type') || 'application/gzip')
        const len = r.res.headers.get('content-length')
        if (len) res.setHeader('Content-Length', len)
        res.setHeader('Content-Disposition', `attachment; filename="${ascii}.tgz"`)
        res.setHeader('Cache-Control', 'no-store')
        const stream = Readable.fromWeb(r.res.body as any)
        stream.on('error', () => res.destroy())
        stream.pipe(res)
      }
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
      const url = new URL(req.url || '/', 'http://localhost')
      const mask = url.searchParams.get('mask') === '0' ? false : true
      const composed = await this.composer.compose(agent, { resolvedAt: Date.now(), mask })
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
      // 可选 ?projectId= 过滤（项目工作台只看本项目任务）
      const urlTasks = new URL(req.url || '/', 'http://localhost')
      const projectFilter = urlTasks.searchParams.get('projectId') || ''
      const allTasks = this.store.getTasks()
      const tasks = projectFilter ? allTasks.filter((t) => t.projectId === projectFilter) : allTasks
      // 列表只返回摘要（完整 turns/taskLogs 随任务增长可达数 MB，且 SSE 每个事件都会刷新列表，
      // 全量返回会占满浏览器并发连接，导致切换会话时单任务请求长时间排队）
      this.sendJson(res, 200, { ok: true, data: tasks.map((t) => this.taskSummary(t)) })
      return true
    }
    if (p === '/api/tasks' && method === 'POST') {
      const body = await this.parseBody(req)
      // 未指定成员时不在此处兜底：默认成员的唯一权威是 engine.createTask → defaultMemberAgentIds（主智能体）。
      // 历史实现曾在此填「全部可用子智能体」，导致无 @ 新建的任务变成全员编排，附件随之上传扇出到所有节点。
      try {
        const task = await this.engine.createTask({ ...body, creator: body.creator || 'tool' })
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
    // 任务实时统计：聚合各成员远端会话的轮/步/耗时/吞吐/token 账本（3s 缓存 + 并发去重）
    const statsMatch = /^\/api\/tasks\/([^/]+)\/stats$/.exec(p)
    if (statsMatch && method === 'GET') {
      const taskId = decodeURIComponent(statsMatch[1])
      const out = await this.getTaskStats(taskId)
      this.sendJson(res, out.httpStatus, out.payload)
      return true
    }
    // 任务清单 + 运行时长：远端 DSH 会话的 todo_write 投影（主智能体优先，2s 缓存 + 并发去重）
    const todosMatch = /^\/api\/tasks\/([^/]+)\/todos$/.exec(p)
    if (todosMatch && method === 'GET') {
      const taskId = decodeURIComponent(todosMatch[1])
      const out = await this.getTaskTodos(taskId)
      this.sendJson(res, out.httpStatus, out.payload)
      return true
    }
    // 输入框 "/" 技能候选：聚合各成员会话作用域技能目录（按名去重，标注可用成员）
    const taskSkillsMatch = /^\/api\/tasks\/([^/]+)\/skills$/.exec(p)
    if (taskSkillsMatch && method === 'GET') {
      const taskId = decodeURIComponent(taskSkillsMatch[1])
      const q = (urlObj.searchParams.get('q') || '').trim()
      const out = await this.getTaskSkills(taskId, q)
      this.sendJson(res, out.httpStatus, out.payload)
      return true
    }
    // ask_user_question 挂起问题的答复回传（成员会话 → 远端宿主 waterfall 桥）
    const askAnswerMatch = /^\/api\/tasks\/([^/]+)\/ask-answer$/.exec(p)
    if (askAnswerMatch && method === 'POST') {
      const taskId = decodeURIComponent(askAnswerMatch[1])
      const body = await this.parseBody(req)
      const task = this.store.getTask(taskId)
      if (!task) {
        this.sendJson(res, 404, { ok: false, error: 'Task not found' })
        return true
      }
      const agentId = String(body?.agentId || '')
      const binding = task.sessions?.[agentId]
      if (!binding?.remoteSessionId) {
        this.sendJson(res, 400, { ok: false, error: '该成员在任务中没有远端会话绑定', code: 'NO_SESSION' })
        return true
      }
      const agent = this.store.getAgent(agentId)
      if (!agent) {
        this.sendJson(res, 404, { ok: false, error: 'Agent not found' })
        return true
      }
      const target = await this.resolver.resolve(agent)
      if (!target.online || !target.baseUrl) {
        this.sendJson(res, 502, { ok: false, error: target.error || '成员节点当前不可达' })
        return true
      }
      const answers = Array.isArray(body?.answers) ? body.answers : []
      const r = await this.client.answerQuestion(target, binding.remoteSessionId, answers)
      if (!r.ok) {
        this.sendJson(res, 502, { ok: false, error: r.error || '答复提交失败', supported: r.supported })
        return true
      }
      this.sendJson(res, 200, { ok: true, data: { answered: answers.length } })
      return true
    }
    // 更新任务执行会话的模型（PUT /sessions/:id 透传到远端 DSH）
    // body: { agentId, provider?, model?, reasoningEffort? }；model 为空 = 清除覆盖回退默认
    const sessionModelMatch = /^\/api\/tasks\/([^/]+)\/session-model$/.exec(p)
    if (sessionModelMatch && method === 'PUT') {
      const taskId = decodeURIComponent(sessionModelMatch[1])
      const body = await this.parseBody(req)
      const task = this.store.getTask(taskId)
      if (!task) {
        this.sendJson(res, 404, { ok: false, error: 'Task not found' })
        return true
      }
      // 未指定 agentId 时默认作用于「当前主智能体」（与聊天窗模型切换语义一致）
      const agentId = String(body?.agentId || '') || this.planner.pickMainAgent()?.id || ''
      const binding = task.sessions?.[agentId]
      if (!agentId || !binding?.remoteSessionId) {
        this.sendJson(res, 400, { ok: false, error: '该成员在任务中没有远端会话绑定', code: 'NO_SESSION' })
        return true
      }
      const agent = this.store.getAgent(agentId)
      if (!agent) {
        this.sendJson(res, 404, { ok: false, error: 'Agent not found' })
        return true
      }
      const target = await this.resolver.resolve(agent)
      if (!target.online || !target.baseUrl) {
        this.sendJson(res, 502, { ok: false, error: target.error || '成员节点当前不可达' })
        return true
      }
      const r = await this.client.updateSessionModel(target, binding.remoteSessionId, {
        provider: typeof body?.provider === 'string' && body.provider ? body.provider : undefined,
        model: typeof body?.model === 'string' && body.model ? body.model : undefined,
        reasoningEffort: typeof body?.reasoningEffort === 'string' && body.reasoningEffort ? body.reasoningEffort : undefined,
      })
      if (!r.ok) {
        this.sendJson(res, 502, { ok: false, error: r.error || '更新会话模型失败' })
        return true
      }
      this.sendJson(res, 200, { ok: true, data: { selected: r.selected } })
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
      const raw = await readRawBuffer(req, UPLOAD_MAX_BYTES)
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
    // 分片断点续传上传（init / status+chunk / complete）
    const resumInitMatch = /^\/api\/tasks\/([^/]+)\/attachments\/resumable\/init$/.exec(p)
    if (resumInitMatch && method === 'POST') {
      const taskId = decodeURIComponent(resumInitMatch[1])
      const body = await this.parseBody(req)
      const result = await this.engine.resumableInit(taskId, String(body?.name || ''), Number(body?.size) || 0, body?.mimeType ? String(body.mimeType) : undefined)
      this.sendJson(res, result.ok ? 200 : 400, { ok: result.ok, data: result.ok ? { uploadId: result.uploadId, received: result.received } : undefined, error: result.error })
      return true
    }
    const resumChunkMatch = /^\/api\/tasks\/([^/]+)\/attachments\/resumable\/([^/]+)$/.exec(p)
    if (resumChunkMatch && (method === 'GET' || method === 'PUT')) {
      const taskId = decodeURIComponent(resumChunkMatch[1])
      const uploadId = decodeURIComponent(resumChunkMatch[2])
      if (method === 'GET') {
        const st = await this.engine.resumableStatus(taskId, uploadId)
        this.sendJson(res, st.ok ? 200 : 404, { ok: st.ok, data: st.ok ? { name: st.name, size: st.size, received: st.received } : undefined, error: st.error })
        return true
      }
      const url = new URL(req.url || '/', 'http://localhost')
      const offset = Number(url.searchParams.get('offset'))
      const raw = await readRawBuffer(req, 8 * 1024 * 1024)
      const result = await this.engine.resumableAppend(taskId, uploadId, raw, offset)
      if (result.ok) {
        this.sendJson(res, 200, { ok: true, data: { received: result.received } })
      } else {
        this.sendJson(res, result.code === 'OFFSET_MISMATCH' ? 409 : 400, { ok: false, error: result.error, data: { received: result.received } })
      }
      return true
    }
    const resumDoneMatch = /^\/api\/tasks\/([^/]+)\/attachments\/resumable\/([^/]+)\/complete$/.exec(p)
    if (resumDoneMatch && method === 'POST') {
      const taskId = decodeURIComponent(resumDoneMatch[1])
      const uploadId = decodeURIComponent(resumDoneMatch[2])
      try {
        const result = await this.engine.resumableComplete(taskId, uploadId)
        if (!result.ok) this.sendJson(res, 409, { ok: false, error: result.error })
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
      let modelError: string | undefined
      if (picked.baseUrl) {
        // 必须带上解析出的 apiKey：远程 DSH 节点的 /models 需要鉴权，无 key 会 401 → 列表静默变空
        const target = { baseUrl: picked.baseUrl, online: true, resolvedAt: new Date().toISOString(), mappingId: '', apiKey: picked.apiKey }
        const mr = await this.client.getModels(target as any)
        models = mr.models || []
        if (!mr.ok) modelError = mr.error || '模型目录获取失败'
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
          modelError,
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

      // 语义约定（与需求一致）：
      //  1) 「模型列表选中的模型」是主智能体的运行时模型，切换主智能体时不重置 —— 发消息与
      //     新建会话都按该选中值建/对齐远端会话（engine.ensureSession）；
      //  2) 模型切换只写 settings.planner.model，不改写主智能体自身 provider/model 配置 ——
      //     「智能体默认模型」与「用户选中的模型」是两个概念，后者不得污染前者
      //     （@ 子智能体仍按各自配置的模型执行）。

      // 主智能体切换 → 同步任务成员账本，让侧栏列表立即显示切换后的智能体（不必刷新页面）：
      //  1. 正在打开的会话（body.taskId）：单成员 chat 任务直接跟随主智能体（与 engine
      //     processUserMessage 的「无 @ → 当前主智能体」路由判定同源，提前落账只为 UI 一致）；
      //  2. 还没有任何消息的单成员 chat 草稿：成员绑定尚无意义，一并归到新的主智能体。
      // 多成员编排任务与已有历史的其他会话不动，避免篡改历史归属。
      const currentMain = this.planner.pickMainAgent()
      const openedTaskId = typeof body?.taskId === 'string' ? String(body.taskId).trim() : ''
      const syncedTasks: ReturnType<WorkBuddyRouter['taskSummary']>[] = []
      const switchedTaskIds: string[] = []
      if (hasAgent && currentMain) {
        for (const t of this.store.getTasks()) {
          if (t.mode !== 'chat' || t.memberAgentIds.length > 1) continue
          const isOpened = t.id === openedTaskId
          const isEmptyDraft = !(t.turns || []).some((x) => x.role === 'user')
          if (!isOpened && !isEmptyDraft) continue
          if (t.memberAgentIds[0] === currentMain.id) continue
          this.store.mutateTask(t.id, (x) => { x.memberAgentIds = [currentMain.id] })
          switchedTaskIds.push(t.id)
          const fresh = this.store.getTask(t.id)
          if (fresh) syncedTasks.push(this.taskSummary(fresh))
        }
        // 工作区/会话随主智能体切换：预热对齐新主智能体的远端会话（工作区、工作目录、主调度模型），
        // 用户下一条消息发出时已在正确的工作区里（异步执行，不阻塞切换响应）
        for (const tid of switchedTaskIds) {
          void this.engine.prepareMainSession(tid).catch(() => {})
        }
      }

      const s = this.store.getSettings()
      this.sendJson(res, 200, {
        ok: true,
        data: {
          agentId: s.planner.agentId,
          model: s.planner.model,
          resolvedAgentId: currentMain?.id,
          resolvedAgentName: currentMain?.name,
          tasks: syncedTasks,
        },
      })
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
/** 上传类请求体统一上限：2GB（大文件请走 resumable 分片接口，避免整包驻留内存） */
const UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024

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

/** 最小 multipart 解析：提取「文件字段 + 普通字段」两步（技能上传用，含 root/name/cwd） */
function parseMultipartParts(buffer: Buffer, contentType: string): Array<{ name?: string; filename?: string; data: Buffer; mimeType?: string }> {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  if (!m) return []
  const delim = Buffer.from('--' + (m[1] || m[2]).trim())
  const parts: Array<{ name?: string; filename?: string; data: Buffer; mimeType?: string }> = []
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
    const data = buffer.slice(bodyStart, bodyEnd)
    let fieldName: string | undefined
    let filename: string | undefined
    let mimeType: string | undefined
    for (const line of headerBlock.split('\r\n')) {
      const colon = line.indexOf(':')
      if (colon < 0) continue
      const key = line.slice(0, colon).trim()
      const value = line.slice(colon + 1).trim()
      if (/^content-disposition$/i.test(key)) {
        fieldName = /(?:^|;\s*)name="([^"]*)"/i.exec(value)?.[1] ?? fieldName
        const fn = /filename="([^"]*)"/i.exec(value)?.[1] ?? /filename=([^;\r\n]+)/i.exec(value)?.[1]
        if (fn !== undefined) filename = safeDecode(fn)
      } else if (/^content-type$/i.test(key)) {
        mimeType = value
      }
    }
    parts.push({ name: fieldName, filename, data, mimeType })
    pos = next
  }
  return parts
}
