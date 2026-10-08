/**
 * onenat-workbuddy-web - HTTP Router & API Dispatcher
 *
 * 路由表见设计文档 §9。SSE 网关: GET /api/tasks/:id/stream
 *
 * 专家统一 API（Phase 4 收敛，数据层 ExpertRegistry）：
 *   GET  /api/experts        统一专家列表；支持 ?domain=<division> 按分区过滤、?skill=<关键词> 检索（可叠加）
 *   GET  /api/experts/:id    单个专家元数据详情（404 = 不存在）
 *   POST /api/experts        由专家档案一键创建/更新子智能体（body: { id, dshRef, name?, ... })
 * Phase 5 清理：旧双写兼容端点（/api/agents/expert-templates、/api/experts/roster*）已删除，
 * 前端统一走 /api/experts*。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { OnenatDirectory } from './onenat.js'
import { OnenatDirectory as Dir } from './onenat.js'
import type { TaskEngine } from './engine.js'
import type { AgentResolver } from './resolver.js'
import type { PromptComposer } from './prompt-composer.js'
import type { Orchestrator } from './orchestrator.js'
import type { WorkStore } from './store.js'
import { DshClient } from './remote-client.js'
import { SshInputError, execOnSshResource, maskSshResource, normalizeSshResource, testSshResource } from './ssh-resources.js'
import type { SshResourceStore } from './ssh-store.js'
import type { ScheduleRunner } from './scheduler.js'
import { normalizeRule, nextRun, ruleText } from './scheduler.js'
import { SCHEDULE_TEMPLATES } from './schedule-templates.js'
import { expertPersona } from './expert-registry.js'
import { ExpertRegistry } from './expert-registry.js'
import { UserExpertStore } from './expert-store.js'
import { parseTeamInput, BUILTIN_TEAMS } from './expert-teams.js'
import type { AuthService } from './auth.js'
import { UsageService } from './usage.js'
import type { XiaozhiMcpClient } from './xiaozhi-mcp.js'
import type { DshRef, Project, SubAgent, WorkTask, ScheduledTask } from './types.js'
import type { MonitorService } from './monitor.js'
import { SkillPluginLibrary, buildSkillInstallPrompt, buildPluginInstallPrompt, buildPluginExportPrompt, extractExportedPaths } from './library.js'
import type { LibKind } from './library.js'
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
  /** 内置专家名册（The Agency persona 快照），根目录可用 WORKBUDDY_EXPERT_ROOT 覆盖 */
  private registry = new ExpertRegistry()

  constructor(
    private store: WorkStore,
    private directory: OnenatDirectory,
    private resolver: AgentResolver,
    private composer: PromptComposer,
    private planner: Orchestrator,
    private engine: TaskEngine,
    private sshStore: SshResourceStore,
    private scheduler?: ScheduleRunner,
    private monitor?: MonitorService,
    private auth?: AuthService,
    private xiaozhi?: XiaozhiMcpClient,
    private library?: SkillPluginLibrary,
  ) {
    // 用户自建专家层：数据落 <dataDir>/user-experts.json，与只读资产层合并为统一视图
    this.registry.attachUserStore(new UserExpertStore(store.dataDir))
  }

  /** 统一专家注册表（供 MCP Server 等外部挂载点复用同一份数据与缓存）。 */
  public get expertRegistry(): ExpertRegistry {
    return this.registry
  }

  /** 插件导出任务的回收结果缓存（taskId → 已拉取结果），保证 poll 幂等 */
  private pluginImportDone = new Map<string, { ok: boolean; imported?: any[]; failed?: Array<{ file: string; error: string }>; error?: string }>()
  /** Token 消耗明细归因（只读聚合，懒初始化避免与参数属性初始化顺序耦合） */
  private usageSvc?: UsageService
  private get usage(): UsageService {
    if (!this.usageSvc) this.usageSvc = new UsageService(this.store)
    return this.usageSvc
  }
  /** 插件导出任务的来源节点（taskId → dshRef + 展示名）：poll 回拉时按节点取 /fs，不再依赖子智能体 */
  private pluginImportRefs = new Map<string, { ref: DshRef; label: string }>()

  /** DSH 节点展示名（映射节点取隧道名/应用名；直连取 baseUrl） */
  private nodeLabelOf(ref: DshRef): string {
    if (ref.kind === 'mapping') {
      const m = this.directory.resolveMapping(ref.mappingId)
      return m?.tunnelName || m?.appName || ref.mappingId
    }
    if (ref.kind === 'app') {
      const a = this.directory.resolveApp(ref.appId)
      return a?.appName || ref.appId
    }
    return String(ref.apiBaseUrl || '直连节点')
  }

  /** 生成给 DSH 用的库文件下载链接：优先用配置的公网基址，否则按请求头推断 */
  private externalBase(req: IncomingMessage, prefix: string): string {
    const configured = this.library?.publicBaseUrl()
    if (configured) return configured
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http'
    const host = String(req.headers.host || 'localhost')
    return `${proto}://${host}${prefix}`
  }

  /** 插件导出任务收尾：从任务轮次解析 tgz 绝对路径，经远端 /fs/download 拉回入库 */
  private async pullExportedPlugins(taskId: string, agent: SubAgent): Promise<{ ok: boolean; imported?: any[]; failed?: Array<{ file: string; error: string }>; error?: string }> {
    return this.pullExportedPluginsInner(taskId, () => this.resolver.resolve(agent), agent.name)
  }

  /** nodeRef 直发路径的回拉：按发起时记录的来源节点取 /fs，不依赖子智能体 */
  private async pullExportedPluginsByRef(taskId: string, ref: DshRef, label: string): Promise<{ ok: boolean; imported?: any[]; failed?: Array<{ file: string; error: string }>; error?: string }> {
    return this.pullExportedPluginsInner(taskId, () => this.resolver.resolveRef(ref, undefined, 'library-node'), label)
  }

  private async pullExportedPluginsInner(
    taskId: string,
    resolveTarget: () => Promise<any>,
    sourceLabel: string,
  ): Promise<{ ok: boolean; imported?: any[]; failed?: Array<{ file: string; error: string }>; error?: string }> {
    if (!this.library) return { ok: false, error: '库未启用' }
    const task = this.store.getTask(taskId)
    if (!task) return { ok: false, error: '导出任务不存在' }
    const texts = task.turns.filter((t) => t.role === 'agent' || t.role === 'system').map((t) => t.text || '')
    const paths = extractExportedPaths(texts.join('\n'))
    if (!paths.length) return { ok: false, error: '导出任务已完成，但未从其汇报中解析到 tgz 路径（可到任务会话查看节点执行情况）' }
    const target = await resolveTarget()
    if (!target.online) return { ok: false, error: target.error || '节点不可达，无法拉取导出文件' }
    const seen = new Set(this.library.list('plugin').map((e) => `${e.filename}:${e.size}`))
    const imported: any[] = []
    const failed: Array<{ file: string; error: string }> = []
    for (const p of paths) {
      try {
        const dl = await this.client.fsDownload(target, p)
        if (!dl.ok || !dl.res) {
          failed.push({ file: p, error: dl.error || '下载失败' })
          continue
        }
        const buf = Buffer.from(await dl.res.arrayBuffer())
        const filename = p.split('/').pop() || 'plugin.tgz'
        if (seen.has(`${filename}:${buf.length}`)) continue
        imported.push(await this.library.add('plugin', { filename, data: buf }, 'import', sourceLabel))
        seen.add(`${filename}:${buf.length}`)
      } catch (err: any) {
        failed.push({ file: p, error: err?.message || String(err) })
      }
    }
    return { ok: true, imported, failed }
  }

  private sendJson(res: ServerResponse, statusCode: number, data: any): void {
    res.statusCode = statusCode
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
    res.end(JSON.stringify(data))
  }

  /**
   * 解析 fs 通道目标节点：优先 node=<dshRef JSON>（项目工作区浏览，无需子智能体），
   * 否则回退 agent=<id>（子智能体所在节点）。三个返回字段与 list/mkdir 既有行为一致。
   */
  private async resolveFsTarget(url: URL, fallbackAgentId?: string): Promise<{ ok: true; target: any } | { ok: false; status: number; error: string }> {
    const nodeParam = url.searchParams.get('node') || ''
    if (nodeParam) {
      let nref: any
      try { nref = JSON.parse(nodeParam) } catch { return { ok: false, status: 400, error: 'node 参数非法（需 dshRef JSON）' } }
      const target = await this.resolver.resolveRef(nref, undefined, 'project-node')
      if (!target.online || !target.baseUrl) return { ok: false, status: 502, error: target.error || '节点不可达' }
      return { ok: true, target }
    }
    const agent = this.store.getAgent(String(url.searchParams.get('agent') || fallbackAgentId || ''))
    if (!agent) return { ok: false, status: 404, error: 'Agent not found' }
    const target = await this.resolver.resolve(agent)
    if (!target.online || !target.baseUrl) return { ok: false, status: 502, error: target.error || '节点不可达' }
    return { ok: true, target }
  }

  private async parseBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => {
        chunks.push(c)
      })
      req.on('end', () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8')
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
      instruction: proj.instruction || '',
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
      pendingAsk: Boolean(t.pendingAsk),
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
    const model = String(body?.model || '').trim()
    if (model && !model.includes('/')) throw new Error('模型格式应为 provider/model（如 zai-coding-cn/glm-5.3-flash），留空跟随全局调度模型')
    // 新模型：无 @ 子智能体 = 主 DSH 直发（节点可为空，运行时回退首个在线 DSH）；
    // 有 agentIds 时校验归属
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
      // 显式传入（含空串=清除）才写；未传保持原值
      ...(body && 'nodeMappingId' in body ? { nodeMappingId: nodeMappingId || '' } : {}),
      ...(body && 'model' in body ? { model: model || '' } : {}),
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
      model: s.model,
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

    // ---------- Token 消耗明细报表（只读归因聚合） ----------
    if (p === '/api/usage/tokens/summary' && method === 'GET') {
      const url = new URL(req.url || '/', 'http://localhost')
      const { from, to } = parseUsageRange(url)
      this.sendJson(res, 200, { ok: true, data: this.usage.summary(from, to) })
      return true
    }
    if (p === '/api/usage/tokens/records' && method === 'GET') {
      const url = new URL(req.url || '/', 'http://localhost')
      const { from, to } = parseUsageRange(url)
      const q = url.searchParams
      this.sendJson(res, 200, {
        ok: true,
        data: this.usage.records({
          from,
          to,
          source: q.get('source') || undefined,
          projectId: q.get('projectId') || undefined,
          agentId: q.get('agentId') || undefined,
          scheduleId: q.get('scheduleId') || undefined,
          taskId: q.get('taskId') || undefined,
          limit: Number(q.get('limit') || 500),
        }),
      })
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
    // ---------- 按节点拉取可用模型列表（定时任务/运行配置的执行模型选择） ----------
    if (p === '/api/dsh-models' && method === 'GET') {
      const mappingId = String(urlObj.searchParams.get('node') || '').trim()
      const ep = mappingId ? this.directory.resolveMapping(mappingId) : undefined
      if (!mappingId || !ep) {
        this.sendJson(res, 200, { ok: false, error: '节点不存在: ' + mappingId })
        return true
      }
      if (!ep.online || !ep.baseUrl) {
        this.sendJson(res, 200, { ok: false, error: `节点「${ep.tunnelName || mappingId}」当前离线` })
        return true
      }
      const cred = await this.directory.fetchMappingCredentials(mappingId).catch(() => undefined)
      const key = cred?.ok ? (cred.apiKey || cred.token || undefined) : undefined
      const client = new DshClient()
      const r = await client.getModels({ baseUrl: ep.baseUrl, apiKey: key })
      this.sendJson(res, 200, { ok: r.ok, nodeTitle: ep.tunnelName || mappingId, models: r.models, defaultModel: r.defaultModel, error: r.error })
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

    // ---------- 专家（统一 API，Phase 4 收敛；数据层 ExpertRegistry） ----------
    // GET /api/experts —— 统一专家列表；?domain= 按分区过滤、?skill= 关键词检索（name/描述/tags，大小写不敏感）
    if (p === '/api/experts' && method === 'GET') {
      const url = new URL(req.url || '/', 'http://localhost')
      const domain = String(url.searchParams.get('domain') || '').trim()
      const skill = String(url.searchParams.get('skill') || '').trim()
      let experts = skill ? await this.registry.search(skill) : [...(await this.registry.index()).divisions.flatMap((d) => d.experts)]
      if (domain) experts = experts.filter((e) => e.division === domain)
      this.sendJson(res, 200, { ok: true, data: { total: experts.length, experts } })
      return true
    }
    // GET /api/experts/:id —— 单个专家详情（元数据 + 完整档案 systemPrompt/executionPrompt/role，
    // Phase 5 起承载原 /api/experts/roster/detail 的预填能力）
    const expertMatch = /^\/api\/experts\/([^/]+)$/.exec(p)
    if (expertMatch && method === 'GET') {
      const id = decodeURIComponent(expertMatch[1])
      if (!(await this.registry.get(id))) {
        this.sendJson(res, 404, { ok: false, error: '专家不存在' })
        return true
      }
      const profile = await this.registry.getProfile(id)
      this.sendJson(res, 200, { ok: true, data: profile })
      return true
    }
    // GET /api/experts/:id/profile —— 完整提示词内容（systemPrompt/executionPrompt/locales）；
    // 与 GET /api/experts/:id 同构（后者历史上就返回完整档案，为兼容前端预填保留），此路径为显式语义别名。
    const expertProfileMatch = /^\/api\/experts\/([^/]+)\/profile$/.exec(p)
    if (expertProfileMatch && method === 'GET') {
      const id = decodeURIComponent(expertProfileMatch[1])
      if (!(await this.registry.get(id))) {
        this.sendJson(res, 404, { ok: false, error: '专家不存在' })
        return true
      }
      try {
        const profile = await this.registry.getProfile(id)
        this.sendJson(res, 200, { ok: true, data: profile })
      } catch (err: any) {
        this.sendJson(res, 404, { ok: false, error: err?.message || '专家档案缺失' })
      }
      return true
    }
    // PUT /api/experts/:id —— 更新用户自建专家（元数据 + 提示词）；builtin/roster 只读 → 403
    const expertUpdateMatch = /^\/api\/experts\/([^/]+)$/.exec(p)
    if (expertUpdateMatch && method === 'PUT') {
      const id = decodeURIComponent(expertUpdateMatch[1])
      if (!(await this.registry.get(id))) {
        this.sendJson(res, 404, { ok: false, error: '专家不存在' })
        return true
      }
      if (!(await this.registry.isEditable(id))) {
        this.sendJson(res, 403, { ok: false, error: '内置/名册专家为只读，仅用户创建的专家可编辑' })
        return true
      }
      const body = await this.parseBody(req)
      try {
        const saved = await this.registry.updateExpert(id, {
          name: body?.name,
          nameEn: body?.nameEn,
          icon: body?.icon,
          division: body?.division,
          divisionZh: body?.divisionZh,
          description: body?.description,
          descriptionEn: body?.descriptionEn,
          tags: Array.isArray(body?.tags) ? body.tags.map(String) : undefined,
          systemPrompt: typeof body?.systemPrompt === 'string' ? body.systemPrompt : undefined,
          executionPrompt: typeof body?.executionPrompt === 'string' ? body.executionPrompt : undefined,
          role: typeof body?.role === 'string' ? body.role : undefined,
        })
        this.sendJson(res, 200, { ok: true, data: saved })
      } catch (err: any) {
        this.sendJson(res, 400, { ok: false, error: err?.message || '更新专家失败' })
      }
      return true
    }
    // DELETE /api/experts/:id —— 删除用户自建专家；builtin/roster 只读 → 403
    if (expertUpdateMatch && method === 'DELETE') {
      const id = decodeURIComponent(expertUpdateMatch[1])
      if (!(await this.registry.get(id))) {
        this.sendJson(res, 404, { ok: false, error: '专家不存在' })
        return true
      }
      if (!(await this.registry.isEditable(id))) {
        this.sendJson(res, 403, { ok: false, error: '内置/名册专家为只读，仅用户创建的专家可删除' })
        return true
      }
      const deleted = await this.registry.deleteExpert(id)
      this.sendJson(res, deleted ? 200 : 404, deleted ? { ok: true, data: { deleted: true } } : { ok: false, error: '专家不存在' })
      return true
    }
    // POST /api/experts —— 双语义分发：
    // ① body 带 systemPrompt（或 kind==='expert'）→ 创建/更新「用户自建专家」（source=user，存 user-experts.json）；
    // ② 其余 → 旧语义：由专家档案一键创建/更新子智能体（body 必带 { id, dshRef }，upsert 落 store.upsertAgent）。
    if (p === '/api/experts' && method === 'POST') {
      const body = await this.parseBody(req)
      if (body?.kind === 'expert' || typeof body?.systemPrompt === 'string') {
        try {
          const saved = await this.registry.createExpert({
            id: String(body.id ?? body.expertId ?? '').trim(),
            name: body.name,
            nameEn: body.nameEn,
            icon: body.icon,
            division: body.division,
            divisionZh: body.divisionZh,
            description: body.description,
            descriptionEn: body.descriptionEn,
            tags: Array.isArray(body.tags) ? body.tags.map(String) : undefined,
            systemPrompt: String(body.systemPrompt ?? ''),
            executionPrompt: typeof body.executionPrompt === 'string' ? body.executionPrompt : undefined,
            role: typeof body.role === 'string' ? body.role : undefined,
          })
          this.sendJson(res, 200, { ok: true, data: saved })
        } catch (err: any) {
          this.sendJson(res, 400, { ok: false, error: err?.message || '创建专家失败' })
        }
        return true
      }
      const expertId = String(body?.id ?? body?.expertId ?? '').trim()
      if (!expertId) {
        this.sendJson(res, 400, { ok: false, error: '缺少 id（专家标识）' })
        return true
      }
      let profile
      try {
        profile = await this.registry.getProfile(expertId)
      } catch (err: any) {
        this.sendJson(res, 404, { ok: false, error: err?.message || '专家不存在' })
        return true
      }
      const fallback = body?.agentId ? this.store.getAgent(String(body.agentId)) : undefined
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
      const saved = this.store.upsertAgent({
        ...(fallback ?? {}),
        ...(body ?? {}),
        id: body?.agentId || `expert-${profile.id}`,
        name: String(body?.name ?? profile.name),
        role: profile.role || profile.name,
        systemPrompt: profile.systemPrompt,
        executionPrompt: profile.executionPrompt,
        dshRef: dshRef as DshRef,
        workDir: workDir || undefined,
        enabled: body?.enabled ?? true,
      })
      this.sendJson(res, 200, { ok: true, data: { agent: saved, expert: profile } })
      return true
    }
    // ---------- 子智能体 ----------
    if (p === '/api/agents' && method === 'GET') {
      this.sendJson(res, 200, { ok: true, data: this.store.getAgents() })
      return true
    }
    // ---------- 专家团（合同式团队：共同目标/约束/交付要求 + 成员分工） ----------
    if (p === '/api/teams' && method === 'GET') {
      this.sendJson(res, 200, { ok: true, data: this.store.getTeams() })
      return true
    }
    if (p === '/api/teams' && method === 'POST') {
      const body = await this.parseBody(req)
      // 内置团只读：带内置 id 的保存请求拒绝（前端「复制」流程发送的是无 id 的新团）
      if (body?.id && BUILTIN_TEAMS.some((t) => t.id === String(body.id))) {
        this.sendJson(res, 400, { ok: false, error: '内置专家团只读，请复制为自定义团队后修改。' })
        return true
      }
      const parsed = await parseTeamInput(body, {
        getAgent: (id) => this.store.getAgent(id),
        getExpert: async (id) => await this.expertRegistry.get(id).catch(() => undefined),
        teams: this.store.getTeams(),
        currentId: body?.id ? String(body.id) : undefined,
      })
      if (!parsed.ok) {
        this.sendJson(res, 400, { ok: false, error: parsed.error })
        return true
      }
      // 语义：无 id 新建；带 id 更新既有团队（成员/合同字段整体替换）
      const saved = this.store.upsertTeam({ ...parsed.value, id: body?.id || undefined })
      this.sendJson(res, 200, { ok: true, data: saved })
      return true
    }
    const teamMatch = /^\/api\/teams\/([^/]+)$/.exec(p)
    if (teamMatch) {
      const teamId = decodeURIComponent(teamMatch[1])
      if (method === 'GET') {
        const team = this.store.getTeam(teamId)
        this.sendJson(res, team ? 200 : 404, team ? { ok: true, data: team } : { ok: false, error: '专家团不存在' })
        return true
      }
      if (method === 'DELETE') {
        this.sendJson(res, 200, { ok: true, data: { deleted: this.store.deleteTeam(teamId) } })
        return true
      }
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
      const targetRes = await this.resolveFsTarget(url)
      if (!targetRes.ok) {
        this.sendJson(res, targetRes.status, { ok: false, error: targetRes.error })
        return true
      }
      const target = targetRes.target
      const dirPath = url.searchParams.get('path') || undefined
      const all = url.searchParams.get('all') === '1' || url.searchParams.get('all') === 'true'
      const out = await this.client.fsList(target, dirPath || undefined, all)
      this.sendJson(res, out.ok ? 200 : 400, out.ok ? out : { ok: false, error: out.error })
      return true
    }
    if (p === '/api/agents/fs/download' && method === 'GET') {
      const url = new URL(req.url || '/', 'http://localhost')
      const targetRes = await this.resolveFsTarget(url)
      if (!targetRes.ok) {
        this.sendJson(res, targetRes.status, { ok: false, error: targetRes.error })
        return true
      }
      const target = targetRes.target
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
      const destDir = String(url.searchParams.get('path') || '').trim()
      const targetRes = await this.resolveFsTarget(url)
      if (!targetRes.ok) {
        this.sendJson(res, targetRes.status, { ok: false, error: targetRes.error })
        return true
      }
      const target = targetRes.target
      if (!destDir) {
        this.sendJson(res, 400, { ok: false, error: '缺少目标目录 path' })
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
      const targetPath = String(url.searchParams.get('path') || body?.path || '').trim()
      const targetRes = await this.resolveFsTarget(url, body?.agent)
      if (!targetRes.ok) {
        this.sendJson(res, targetRes.status, { ok: false, error: targetRes.error })
        return true
      }
      const target = targetRes.target
      if (!targetPath) {
        this.sendJson(res, 400, { ok: false, error: '缺少 path 参数' })
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
    // 按节点拉模型目录（新建智能体尚未保存时 / 聊天框模型切换用）：node=<dshRef JSON>。
    // 注意必须放在下方 agentMatch（/api/agents/:id）之前，否则 "models" 会被当成 agentId
    const nodeModelsMatch = p === '/api/agents/models' && method === 'GET'
    if (nodeModelsMatch) {
      const url = new URL(req.url || '/', 'http://localhost')
      const targetRes = await this.resolveFsTarget(url)
      if (!targetRes.ok) {
        this.sendJson(res, targetRes.status, { ok: false, error: targetRes.error, data: { models: [] } })
        return true
      }
      const mr = await this.client.getModels(targetRes.target)
      this.sendJson(res, 200, { ok: mr.ok, error: mr.error, data: { models: mr.models || [], defaultModel: mr.defaultModel } })
      return true
    }
    // 按节点拉模式预设候选（新建智能体尚未保存时）：node=<dshRef JSON>。与 models?node= 同语义、同排序约束
    const nodePresetsMatch = p === '/api/agents/presets' && method === 'GET'
    if (nodePresetsMatch) {
      const url = new URL(req.url || '/', 'http://localhost')
      const targetRes = await this.resolveFsTarget(url)
      if (!targetRes.ok) {
        this.sendJson(res, targetRes.status, { ok: false, error: targetRes.error, data: { presets: [] } })
        return true
      }
      const pr = await this.client.getPresets(targetRes.target)
      this.sendJson(res, 200, { ok: pr.ok, error: pr.error, data: { presets: pr.presets || [] } })
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
    // 任务节点模型目录（聊天输入框模型切换弹层用）：按任务/项目绑定节点解析
    const taskModelsMatch = /^\/api\/tasks\/([^/]+)\/models$/.exec(p)
    if (taskModelsMatch && method === 'GET') {
      const task = this.store.getTask(decodeURIComponent(taskModelsMatch[1]))
      if (!task) {
        this.sendJson(res, 404, { ok: false, error: 'Task not found' })
        return true
      }
      // __node__（节点主会话）无 store 记录 → resolveExecTarget 按任务/项目节点解析（公开方法）
      const target = await this.engine.resolveExecTarget(task, '__node__').catch(() => undefined)
      if (!target?.online || !target?.baseUrl) {
        this.sendJson(res, 200, { ok: false, error: (target as any)?.error || '任务节点不可达', data: { models: [] } })
        return true
      }
      const mr = await this.client.getModels(target)
      this.sendJson(res, 200, { ok: mr.ok, error: mr.error, data: { models: mr.models || [], defaultModel: mr.defaultModel } })
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
    // ---------- 技能与插件库（平台级：入库 / 下载 / 安装任务 / 从节点导入） ----------
    if (this.library) {
      const libOverviewMatch = /^\/api\/library\/overview$/.exec(p)
      if (libOverviewMatch && method === 'GET') {
        this.sendJson(res, 200, {
          ok: true,
          data: {
            skills: this.library.list('skill'),
            plugins: this.library.list('plugin'),
            installs: this.library.syncInstalls().slice(0, 30),
            publicBaseUrl: this.library.publicBaseUrl() || '',
          },
        })
        return true
      }
      const libUploadMatch = /^\/api\/library\/(skill|plugin)\/upload$/.exec(p)
      if (libUploadMatch && method === 'POST') {
        const kind = libUploadMatch[1] as LibKind
        const contentType = String(req.headers['content-type'] || '')
        const raw = await readRawBuffer(req, 200 * 1024 * 1024)
        const parts = parseMultipartParts(raw, contentType)
        const files = parts.filter((pt) => pt.filename !== undefined && pt.data.length > 0)
        if (!files.length) {
          this.sendJson(res, 400, { ok: false, error: 'multipart 中未找到压缩包文件字段' })
          return true
        }
        const imported: any[] = []
        const failed: Array<{ filename: string; error: string }> = []
        for (const f of files) {
          try {
            imported.push(await this.library.add(kind, { filename: f.filename || 'archive.bin', data: f.data }, 'upload'))
          } catch (err: any) {
            failed.push({ filename: f.filename || '?', error: err?.message || String(err) })
          }
        }
        this.sendJson(res, 200, { ok: failed.length === 0, data: { imported, failed } })
        return true
      }
      const libSettingsMatch = /^\/api\/library\/settings$/.exec(p)
      if (libSettingsMatch && method === 'POST') {
        const body = await this.parseBody(req)
        this.library.setPublicBaseUrl(String(body?.publicBaseUrl || ''))
        this.sendJson(res, 200, { ok: true, data: { publicBaseUrl: this.library.publicBaseUrl() || '' } })
        return true
      }
      const libDelMatch = /^\/api\/library\/(skill|plugin)\/([^/]+)$/.exec(p)
      if (libDelMatch && method === 'DELETE') {
        const ok = this.library.remove(decodeURIComponent(libDelMatch[2]))
        if (!ok) this.sendJson(res, 404, { ok: false, error: '条目不存在' })
        else this.sendJson(res, 200, { ok: true })
        return true
      }
      const libDlMatch = /^\/api\/library\/(skill|plugin)\/([^/]+)\/download$/.exec(p)
      if (libDlMatch && method === 'GET') {
        const entry = this.library.get(decodeURIComponent(libDlMatch[2]))
        const buf = entry ? this.library.readFile(entry.id) : undefined
        if (!entry || !buf) {
          this.sendJson(res, 404, { ok: false, error: '条目不存在' })
          return true
        }
        const ascii = entry.filename.replace(/[^\x20-\x7e]/g, '_')
        res.statusCode = 200
        res.setHeader('Content-Type', entry.filename.toLowerCase().endsWith('.zip') ? 'application/zip' : 'application/gzip')
        res.setHeader('Content-Length', String(buf.length))
        res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(entry.filename)}`)
        res.setHeader('Cache-Control', 'no-store')
        res.end(buf)
        return true
      }
      const libInstallMatch = /^\/api\/library\/(skill|plugin)\/([^/]+)\/install$/.exec(p)
      if (libInstallMatch && method === 'POST') {
        const kind = libInstallMatch[1] as LibKind
        const entry = this.library.get(decodeURIComponent(libInstallMatch[2]))
        if (!entry || entry.kind !== kind) {
          this.sendJson(res, 404, { ok: false, error: '条目不存在' })
          return true
        }
        const body = await this.parseBody(req)
        // 新模型：安装目标 = DSH 主节点（nodeRefs）。技能/插件都在节点级生效，
        // 向节点直发主会话任务（engine nodeRef，无需子智能体）。
        const nodeRefs: DshRef[] = Array.isArray(body?.nodeRefs)
          ? body.nodeRefs.map((r: any) => r as DshRef).filter((r: DshRef) => r && typeof r === 'object' && typeof (r as any).kind === 'string')
          : []
        if (nodeRefs.length) {
          const base = this.externalBase(req, prefix)
          const url = `${base}/library/file/${kind}/${entry.id}?token=${this.library.downloadToken(entry.id)}`
          const label = kind === 'skill' ? '技能' : '插件'
          const prompt = kind === 'skill' ? buildSkillInstallPrompt(entry, url) : buildPluginInstallPrompt(entry, url)
          const byNode = new Map<string, DshRef>()
          for (const ref of nodeRefs) {
            const key = ref.kind === 'mapping' ? `m:${ref.mappingId}` : ref.kind === 'app' ? `a:${ref.appId}` : `d:${(ref as any).apiBaseUrl}`
            if (!byNode.has(key)) byNode.set(key, ref)
          }
          const targets: Array<{ agentId: string; agentName: string; taskId: string }> = []
          const dispatchFailed: Array<{ agent: string; error: string }> = []
          for (const [key, ref] of byNode) {
            const nodeLabel = this.nodeLabelOf(ref)
            try {
              const task = await this.engine.createTask({
                title: `安装${label}「${entry.name}」→ ${nodeLabel}`,
                nodeRef: ref,
                message: prompt,
                creator: 'console',
              })
              targets.push({ agentId: key, agentName: nodeLabel, taskId: task.id })
            } catch (err: any) {
              dispatchFailed.push({ agent: nodeLabel, error: err?.message || String(err) })
            }
          }
          const record = targets.length ? this.library.createInstall(kind, entry, targets) : undefined
          this.sendJson(res, 200, {
            ok: targets.length > 0,
            data: { record, targets, dispatchFailed },
          })
          return true
        }
        // 兼容旧调用（工具通道/旧客户端）：agentIds → 按其所在节点去重派发
        const agentIds: string[] = Array.isArray(body?.agentIds) ? body.agentIds.map((s: any) => String(s)).filter(Boolean) : []
        if (!agentIds.length) {
          this.sendJson(res, 400, { ok: false, error: '缺少 nodeRefs（安装目标 DSH 主节点）' })
          return true
        }
        // 目标按节点去重：同节点多个智能体只需安装一次（技能/插件都在节点级生效），取该节点首个智能体执行任务
        const nodeKeyOf = (a: SubAgent) => a.dshRef.kind === 'mapping' ? `m:${a.dshRef.mappingId}` : a.dshRef.kind === 'app' ? `a:${a.dshRef.appId}` : `d:${a.dshRef.apiBaseUrl}`
        const byNode = new Map<string, SubAgent>()
        const missing: string[] = []
        for (const aid of agentIds) {
          const agent = this.store.getAgent(aid)
          if (!agent) { missing.push(aid); continue }
          const k = nodeKeyOf(agent)
          if (!byNode.has(k)) byNode.set(k, agent)
        }
        if (!byNode.size) {
          this.sendJson(res, 400, { ok: false, error: '安装目标均不存在' })
          return true
        }
        const base = this.externalBase(req, prefix)
        const url = `${base}/library/file/${kind}/${entry.id}?token=${this.library.downloadToken(entry.id)}`
        const label = kind === 'skill' ? '技能' : '插件'
        const prompt = kind === 'skill' ? buildSkillInstallPrompt(entry, url) : buildPluginInstallPrompt(entry, url)
        const targets: Array<{ agentId: string; agentName: string; taskId: string }> = []
        const dispatchFailed: Array<{ agent: string; error: string }> = []
        for (const agent of byNode.values()) {
          try {
            const task = await this.engine.createTask({
              title: `安装${label}「${entry.name}」→ ${agent.name}`,
              memberAgentIds: [agent.id],
              message: prompt,
              creator: 'console',
            })
            targets.push({ agentId: agent.id, agentName: agent.name, taskId: task.id })
          } catch (err: any) {
            dispatchFailed.push({ agent: agent.name, error: err?.message || String(err) })
          }
        }
        const record = targets.length ? this.library.createInstall(kind, entry, targets) : undefined
        this.sendJson(res, 200, {
          ok: targets.length > 0,
          data: { record, targets, dispatchFailed, ...(missing.length ? { missing } : {}) },
        })
        return true
      }
      const libInstallsMatch = /^\/api\/library\/installs$/.exec(p)
      if (libInstallsMatch && method === 'GET') {
        this.sendJson(res, 200, { ok: true, data: { installs: this.library.syncInstalls().slice(0, 30) } })
        return true
      }
      // 从节点导入技能：按 DSH 主节点（nodeRef）直接拉远端 /skills/:name/archive 归档入库（只读，不发任务）
      const libImpSkillMatch = /^\/api\/library\/import\/skills$/.exec(p)
      if (libImpSkillMatch && method === 'POST') {
        const body = await this.parseBody(req)
        const nodeRef = body?.nodeRef && typeof body.nodeRef === 'object' ? (body.nodeRef as DshRef) : undefined
        const legacyAgent = this.store.getAgent(String(body?.agentId || ''))
        if (!nodeRef && !legacyAgent) {
          this.sendJson(res, 404, { ok: false, error: '缺少 nodeRef（来源 DSH 主节点）' })
          return true
        }
        const names: string[] = Array.isArray(body?.names) ? body.names.map((s: any) => String(s)).filter(Boolean) : []
        if (!names.length) {
          this.sendJson(res, 400, { ok: false, error: '缺少 names（要导入的技能名）' })
          return true
        }
        const target = nodeRef
          ? await this.resolver.resolveRef(nodeRef, undefined, 'library-node')
          : await this.resolver.resolve(legacyAgent!)
        if (!target.online) {
          this.sendJson(res, 200, { ok: false, error: target.error || '节点不可达' })
          return true
        }
        const sourceLabel = nodeRef ? this.nodeLabelOf(nodeRef) : legacyAgent!.name
        const imported: any[] = []
        const skipped: Array<{ name: string; reason: string }> = []
        const existing = new Set(this.library.list('skill').map((e) => e.name))
        for (const name of names) {
          if (existing.has(name)) {
            skipped.push({ name, reason: '库中已有同名技能' })
            continue
          }
          const r = await this.client.downloadSkillArchive(target, name, { cwd: legacyAgent?.workDir || undefined })
          if (!r.ok || !r.res) {
            skipped.push({ name, reason: r.error || '下载失败' })
            continue
          }
          try {
            const buf = Buffer.from(await r.res.arrayBuffer())
            imported.push(await this.library.add('skill', { filename: r.name || `${name}.tgz`, data: buf }, 'import', sourceLabel))
            existing.add(name)
          } catch (err: any) {
            skipped.push({ name, reason: err?.message || '入库失败' })
          }
        }
        this.sendJson(res, 200, { ok: true, data: { imported, skipped } })
        return true
      }
      // 从节点导入插件：向选中的 DSH 主节点发起主会话导出任务（npm pack），平台随后经 /fs 拉回
      const libImpPluginMatch = /^\/api\/library\/import\/plugins$/.exec(p)
      if (libImpPluginMatch && method === 'POST') {
        const body = await this.parseBody(req)
        const nodeRef = body?.nodeRef && typeof body.nodeRef === 'object' ? (body.nodeRef as DshRef) : undefined
        const legacyAgent = this.store.getAgent(String(body?.agentId || ''))
        if (!nodeRef && !legacyAgent) {
          this.sendJson(res, 404, { ok: false, error: '缺少 nodeRef（来源 DSH 主节点）' })
          return true
        }
        const nodeLabel = nodeRef ? this.nodeLabelOf(nodeRef) : legacyAgent!.name
        const task = nodeRef
          ? await this.engine.createTask({
            title: `导出插件 ← ${nodeLabel}`,
            nodeRef,
            message: buildPluginExportPrompt(),
            creator: 'console',
          })
          : await this.engine.createTask({
            title: `导出插件 ← ${legacyAgent!.name}`,
            memberAgentIds: [legacyAgent!.id],
            message: buildPluginExportPrompt(),
            creator: 'console',
          })
        if (nodeRef) this.pluginImportRefs.set(task.id, { ref: nodeRef, label: nodeLabel })
        this.sendJson(res, 200, {
          ok: true,
          data: { taskId: task.id, ...(nodeRef ? { nodeLabel } : { agentId: legacyAgent!.id }) },
        })
        return true
      }
      const libImpPollMatch = /^\/api\/library\/import\/plugins\/poll$/.exec(p)
      if (libImpPollMatch && method === 'GET') {
        const url = new URL(req.url || '/', 'http://localhost')
        const taskId = url.searchParams.get('taskId') || ''
        const cached = this.pluginImportDone.get(taskId)
        if (cached) {
          this.sendJson(res, 200, { ok: true, data: { done: true, ...cached } })
          return true
        }
        const task = this.store.getTask(taskId)
        if (!task) {
          this.sendJson(res, 200, { ok: true, data: { done: true, error: '导出任务不存在' } })
          return true
        }
        if (task.status === 'draft' || task.status === 'running' || this.engine.isRunning(taskId)) {
          this.sendJson(res, 200, { ok: true, data: { done: false, status: task.status } })
          return true
        }
        // 回拉目标：优先取发起时记录的来源节点（nodeRef 直发路径）；再回退任务自带的 nodeRef
        //（服务重启后 pluginImportRefs 内存表会丢，任务实体上仍有）；最后回退 agentId（旧路径）
        const stashed = this.pluginImportRefs.get(taskId) || (task.nodeRef ? { ref: task.nodeRef, label: this.nodeLabelOf(task.nodeRef) } : undefined)
        const legacyAgent = this.store.getAgent(url.searchParams.get('agentId') || '')
        if (!stashed && !legacyAgent) {
          this.sendJson(res, 200, { ok: true, data: { done: true, error: '来源节点缺失' } })
          return true
        }
        const result = stashed
          ? await this.pullExportedPluginsByRef(taskId, stashed.ref, stashed.label)
          : await this.pullExportedPlugins(taskId, legacyAgent!)
        // 只缓存成功结果；失败（如路径解析为空、节点瞬时不可达）不缓存，下次 poll 可重试
        if (result.ok) this.pluginImportDone.set(taskId, result)
        this.sendJson(res, 200, { ok: true, data: { done: true, ...result } })
        return true
      }
      // 节点已装技能清单（从节点导入技能的选择来源；node = dshRef JSON）
      const libNodeSkillsMatch = /^\/api\/library\/nodes\/skills$/.exec(p)
      if (libNodeSkillsMatch && method === 'GET') {
        const url = new URL(req.url || '/', 'http://localhost')
        let nref: any
        try { nref = JSON.parse(url.searchParams.get('node') || '') } catch { /* below */ }
        if (!nref || typeof nref !== 'object') {
          this.sendJson(res, 400, { ok: false, error: 'node 参数非法（需 dshRef JSON）' })
          return true
        }
        const target = await this.resolver.resolveRef(nref as DshRef, undefined, 'library-node')
        if (!target.online) {
          this.sendJson(res, 200, { ok: false, error: target.error || '节点不可达', data: { skills: [] } })
          return true
        }
        const r = await this.client.listSkills(target, {
          root: url.searchParams.get('root') || undefined,
          search: url.searchParams.get('search') || undefined,
        })
        if (r.unsupported) {
          this.sendJson(res, 200, { ok: false, error: r.error, data: { skills: [], unsupported: true } })
          return true
        }
        this.sendJson(res, 200, { ok: true, data: { skills: r.skills, count: r.count, root: r.root } })
        return true
      }
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
          role: agent.role || '',
          executionPrompt: agent.executionPrompt || '',
          resourceBlock: composed.block,
          resources: composed.resources,
          warnings: composed.warnings,
          full: [expertPersona(agent), composed.block].filter(Boolean).join('\n\n'),
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
        type: 'agent' | 'resource' | 'team' | 'expert' | 'project'
        id: string
        name: string
        kind?: string
        detail?: string
        meta?: any
      }> = []

      // 0. 项目：@项目名 → 对该项目发起任务（未绑定项目的任务自动绑定，节点/工作区/项目指令/技能全继承）
      for (const pr of this.store.getProjects()) {
        candidates.push({
          type: 'project',
          id: pr.id,
          name: pr.name,
          kind: 'project',
          detail: `项目 · ${pr.workspace || '未设工作目录'}${pr.expertIds.length ? ` · ${pr.expertIds.length} 名专家` : ''}`,
          meta: { projectId: pr.id, workspace: pr.workspace, expertCount: pr.expertIds.length },
        })
      }

      // 1. 专家团（含内置种子团）：@团队名 → 本轮消息按团队合同发起编排
      for (const t of this.store.getTeams()) {
        if (t.enabled === false) continue
        candidates.push({
          type: 'team',
          id: t.id,
          name: t.name,
          kind: 'team',
          detail: `专家团 · ${t.members.length} 名成员${t.builtin ? ' · 内置' : ''}`,
          meta: { teamId: t.id, description: t.description, builtin: Boolean(t.builtin) },
        })
      }

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

      // 4. 专家库角色：@单个专家 → 定向直派（动态实例化在任务节点）；@多个专家 → 并行编排
      {
        const experts = await this.expertRegistry.search('').catch(() => [])
        for (const e of experts) {
          if (!candidates.some(c => c.type === 'expert' && c.id === e.id)) {
            candidates.push({
              type: 'expert',
              id: e.id,
              name: e.name,
              kind: 'expert',
              detail: `专家 · ${e.divisionZh || e.division}`,
              meta: { expertId: e.id, description: e.description, icon: e.icon },
            })
          }
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
        // 默认剔除 taskLogs 以减小载荷；轨迹视图通过 ?withLogs=1 显式携带（日志进轨迹账本）
        const withLogs = new URL(req.url || '/', 'http://x').searchParams.get('withLogs') === '1'
        const { taskLogs: _drop, ...rest } = task as any
        this.sendJson(res, 200, {
          ok: true,
          data: {
            ...(withLogs ? { taskLogs: task.taskLogs ?? [] } : {}),
            ...rest,
            running: this.engine.isRunning(taskId),
          },
        })
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
      // teamId = composer 专家团选择器显式指定的本轮团队意图（@团队名 提及在引擎内解析）
      const teamId = String(body?.teamId || '').trim()
      const out = await this.engine.sendUserMessage(taskId, String(body.message || ''), teamId ? { teamId } : undefined)
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
      // 节点主会话（__node__）无 store 记录：按任务节点解析答复目标
      const agent = this.store.getAgent(agentId)
      const target = agent
        ? await this.resolver.resolve(agent)
        : await this.engine.resolveExecTarget(task, agentId)
      if (!target || !target.online || !target.baseUrl) {
        this.sendJson(res, 502, { ok: false, error: (target as any)?.error || '成员节点当前不可达' })
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
      // 未指定 agentId 时：优先任务的主会话（__node__），否则当前主智能体（与聊天窗模型切换语义一致）
      const agentId = String(body?.agentId || '') || (task.sessions?.['__node__']?.remoteSessionId ? '__node__' : this.planner.pickMainAgent()?.id || '')
      const binding = task.sessions?.[agentId]
      if (!agentId || !binding?.remoteSessionId) {
        this.sendJson(res, 400, { ok: false, error: '该成员在任务中没有远端会话绑定', code: 'NO_SESSION' })
        return true
      }
      // 节点主会话（__node__）无 store 记录：按任务节点解析
      const agent = this.store.getAgent(agentId)
      const target = agent
        ? await this.resolver.resolve(agent)
        : await this.engine.resolveExecTarget(task, agentId)
      if (!target || !target.online || !target.baseUrl) {
        this.sendJson(res, 502, { ok: false, error: (target as any)?.error || '成员节点当前不可达' })
        return true
      }
      const r = await this.client.updateSessionModel(target, binding.remoteSessionId, {
        provider: typeof body?.provider === 'string' && body.provider ? body.provider : undefined,
        model: typeof body?.model === 'string' && body.model ? body.model : undefined,
        reasoningEffort: typeof body?.reasoningEffort === 'string' && body.reasoningEffort ? body.reasoningEffort : undefined,
        agentPreset: typeof body?.agentPreset === 'string' ? body.agentPreset : undefined,
      })
      if (!r.ok) {
        this.sendJson(res, 502, { ok: false, error: r.error || '更新会话模型失败' })
        return true
      }
      this.sendJson(res, 200, { ok: true, data: { selected: r.selected, presetApplied: r.preset ? r.preset.applied : undefined } })
      return true
    }
    // 任务执行会话的模式预设（agentPreset）：任务级持久化（task > 智能体实体 > 远端默认 cordis）
    // + 尽力对当前远端会话即时生效（宿主不支持运行时切 preset → applied=false，仅持久化，新会话生效）
    const sessionPresetMatch = /^\/api\/tasks\/([^/]+)\/session-preset$/.exec(p)
    if (sessionPresetMatch && method === 'PUT') {
      const taskId = decodeURIComponent(sessionPresetMatch[1])
      const body = await this.parseBody(req)
      const task = this.store.getTask(taskId)
      if (!task) {
        this.sendJson(res, 404, { ok: false, error: 'Task not found' })
        return true
      }
      const preset = String(body?.preset || '').trim()
      this.store.mutateTask(taskId, (t): WorkTask => {
        if (preset) t.agentPreset = preset
        else delete t.agentPreset
        return t
      })
      // 尽力即时生效：主会话（__node__）优先，否则主智能体（与 session-model 语义一致）
      const agentId = task.sessions?.['__node__']?.remoteSessionId ? '__node__' : this.planner.pickMainAgent()?.id || ''
      const binding = agentId ? task.sessions?.[agentId] : undefined
      if (!binding?.remoteSessionId) {
        this.sendJson(res, 200, { ok: true, data: { applied: false, reason: 'no-session', saved: true } })
        return true
      }
      const agent = this.store.getAgent(agentId)
      const target = agent
        ? await this.resolver.resolve(agent)
        : await this.engine.resolveExecTarget(task, agentId)
      if (!target || !target.online || !target.baseUrl) {
        this.sendJson(res, 200, { ok: true, data: { applied: false, reason: 'node-offline', saved: true } })
        return true
      }
      const r = await this.client.updateSessionModel(target, binding.remoteSessionId, { agentPreset: preset })
      this.sendJson(res, 200, {
        ok: true,
        data: { applied: r.ok ? r.preset?.applied !== false : false, reason: r.ok ? r.preset?.reason : r.error, saved: true },
      })
      return true
    }
    // 回读任务执行会话当前的模型选择 + 模式预设（聊天窗回显；无会话时回任务级落点）
    const sessionModelGetMatch = /^\/api\/tasks\/([^/]+)\/session-model$/.exec(p)
    if (sessionModelGetMatch && method === 'GET') {
      const taskId = decodeURIComponent(sessionModelGetMatch[1])
      const task = this.store.getTask(taskId)
      if (!task) {
        this.sendJson(res, 404, { ok: false, error: 'Task not found' })
        return true
      }
      const agentId = task.sessions?.['__node__']?.remoteSessionId ? '__node__' : this.planner.pickMainAgent()?.id || ''
      const binding = agentId ? task.sessions?.[agentId] : undefined
      if (!binding?.remoteSessionId) {
        this.sendJson(res, 200, {
          ok: true,
          data: { session: null, taskModel: task.model || '', taskReasoningEffort: task.reasoningEffort || '', taskAgentPreset: task.agentPreset || '' },
        })
        return true
      }
      const agent = this.store.getAgent(agentId)
      const target = agent
        ? await this.resolver.resolve(agent)
        : await this.engine.resolveExecTarget(task, agentId)
      if (!target || !target.online || !target.baseUrl) {
        this.sendJson(res, 200, {
          ok: true,
          data: { session: null, taskModel: task.model || '', taskReasoningEffort: task.reasoningEffort || '', taskAgentPreset: task.agentPreset || '' },
        })
        return true
      }
      const r = await this.client.getSessionDetail(target, binding.remoteSessionId)
      this.sendJson(res, 200, {
        ok: true,
        data: {
          session: r.ok ? r.session ?? null : null,
          taskModel: task.model || '',
          taskReasoningEffort: task.reasoningEffort || '',
          taskAgentPreset: task.agentPreset || '',
        },
      })
      return true
    }
    // 任务节点的模式预设候选（聊天窗预设切换的数据源）：与 tasks/:id/models 同语义
    const taskPresetsMatch = /^\/api\/tasks\/([^/]+)\/presets$/.exec(p)
    if (taskPresetsMatch && method === 'GET') {
      const task = this.store.getTask(decodeURIComponent(taskPresetsMatch[1]))
      if (!task) {
        this.sendJson(res, 404, { ok: false, error: 'Task not found' })
        return true
      }
      const target = await this.engine.resolveExecTarget(task, '__node__').catch(() => undefined)
      if (!target?.online || !target?.baseUrl) {
        this.sendJson(res, 200, { ok: false, error: (target as any)?.error || '任务节点不可达', data: { presets: [] } })
        return true
      }
      const pr = await this.client.getPresets(target)
      this.sendJson(res, 200, { ok: pr.ok, error: pr.error, data: { presets: pr.presets || [] } })
      return true
    }
    // 任务级模型（无远端会话时的模型选择落点）：engine ensureSession 的 plannerModelSetting
    // 优先读 task.model，下一轮建会话即生效；也会作为模型回退自愈的目标模型
    const taskModelMatch = /^\/api\/tasks\/([^/]+)\/model$/.exec(p)
    if (taskModelMatch && method === 'PUT') {
      const body = await this.parseBody(req)
      const updated = this.store.mutateTask(decodeURIComponent(taskModelMatch[1]), (t): WorkTask => {
        const m = String(body?.model || '').trim()
        if (m) t.model = m
        else delete t.model
        // 任务级推理强度与 model 同存同清：建会话时随 createPayload 透传
        const eff = String(body?.reasoningEffort || '').trim()
        if (eff) t.reasoningEffort = eff
        else delete t.reasoningEffort
        return t
      })
      if (!updated) this.sendJson(res, 404, { ok: false, error: 'Task not found' })
      else this.sendJson(res, 200, { ok: true, data: { model: updated.model || '', reasoningEffort: updated.reasoningEffort || '' } })
      return true
    }
    // 任务级运行权限：优先于智能体实体默认 permission（空串 = 清除覆盖，回退实体默认/全部权限）。
    // 保存后立即经 PUT /sessions/:id/permission 原生下发到该任务所有已存在的远端会话
    // （harness permissionPresets：真实切换沙箱模式 + 审批策略，不再靠提示词注入）
    const taskPermissionMatch = /^\/api\/tasks\/([^/]+)\/permission$/.exec(p)
    if (taskPermissionMatch && method === 'PUT') {
      const body = await this.parseBody(req)
      const taskId = decodeURIComponent(taskPermissionMatch[1])
      const updated = this.store.mutateTask(taskId, (t): WorkTask => {
        const perm = String(body?.permission || '').trim()
        if (perm) t.permission = perm
        else delete t.permission
        return t
      })
      if (!updated) {
        this.sendJson(res, 404, { ok: false, error: 'Task not found' })
        return true
      }
      const applied = await this.engine.applyTaskPermission(taskId)
        .catch((e: any) => [{ agentId: '*', ok: false, error: e?.message || String(e) }])
      this.sendJson(res, 200, { ok: true, data: { permission: updated.permission || '', applied } })
      return true
    }
    // App「AI 控制台」模型透传（登录会话）：节点凭证由服务端持有，App 不接触节点 Key
    if (p === '/api/console/chat' && method === 'POST') {
      const body = await this.parseBody(req)
      const out = await this.engine.consoleChat({
        messages: Array.isArray(body?.messages) ? body.messages : [],
        tools: Array.isArray(body?.tools) ? body.tools : [],
        model: typeof body?.model === 'string' ? body.model : undefined,
      })
      this.sendJson(res, out.ok ? 200 : 502, out)
      return true
    }
    // 队列「立即发送」：按 turnId 取出排队消息 → 运行中 steer 插话，否则立即派发
    const queueSendMatch = /^\/api\/tasks\/([^/]+)\/queue\/send$/.exec(p)
    if (queueSendMatch && method === 'POST') {
      const body = await this.parseBody(req)
      const out = await this.engine.sendQueuedNow(decodeURIComponent(queueSendMatch[1]), String(body?.turnId || ''))
      this.sendJson(res, out.ok ? 200 : 400, out)
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
/** Token 报表时间范围：range=today|7d|30d 或 from/to（epoch ms），默认今日 */
function parseUsageRange(url: URL): { from: number; to: number } {
  const to = Number(url.searchParams.get('to') || 0) || Date.now()
  const range = url.searchParams.get('range') || 'today'
  let from = Number(url.searchParams.get('from') || 0)
  if (!from) {
    if (range === 'today') {
      const d = new Date(to)
      d.setHours(0, 0, 0, 0)
      from = d.getTime()
    } else {
      const days = range === '30d' ? 30 : range === '7d' ? 7 : Math.max(1, Number(range.replace(/[^0-9]/g, '')) || 1)
      from = to - days * 86_400_000
    }
  }
  return { from, to }
}

export function normalizeDshRef(input: any): DshRef | { error: string } {  if (!input || typeof input !== 'object') return { error: '缺少 dshRef（DSH 实体引用）' }
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
