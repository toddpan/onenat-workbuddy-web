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
import { AsyncLocalStorage } from 'node:async_hooks'
import { TaskHistory, TaskHistoryError } from './task-history.js'
import { TaskActivity } from './task-activity.js'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import type { OnenatDirectory } from './onenat.js'
import { OnenatDirectory as Dir } from './onenat.js'
import type { TaskEngine } from './engine.js'
import { validateToolArgs } from './tool-contracts.js'

/** Match tool/MCP routing validation without dropping REST-only task fields. */
function taskRouteArgs(body: Record<string, any>, action: 'create' | 'send', taskId?: string) {
  const route = Object.fromEntries(['chatAgentId', 'mode', 'memberAgentIds', 'teamId', 'nodeRef', 'projectId'].filter(key => body[key] !== undefined).map(key => [key, body[key]]))
  const checked = validateToolArgs('workbuddy_task_manage', { ...route, action, ...(action === 'send' ? { taskId, message: body.message } : {}) })
  if (checked.errors.length) throw Object.assign(new Error(checked.errors.map(e => `${e.path}: ${e.message}`).join('；')), { code: 'INVALID_PARAM' })
  const { action: _action, message: _message, taskId: _taskId, ...args } = checked.args
  return args
}
import type { AgentResolver } from './resolver.js'
import type { PromptComposer } from './prompt-composer.js'
import { interactionGuard } from './prompt-composer.js'
import type { Orchestrator } from './orchestrator.js'
import type { WorkStore } from './store.js'
import { isNodeAbsolutePath, WORK_DIR_NOT_ABSOLUTE_MSG } from './store.js'
import { agentDisplayProfile, mergeAgentDisplay } from './agent-display.js'
import { normalizeWorkspacePath, validateWorkspacePath, ProjectWorkspaceConflictError } from './workspace.js'
import { requireProjectFiles, requireNodeFiles, projectFilePath, workspaceChild, requireWorkspacePath, checkWorkspaceFsPath, writeProjectFile, WorkspaceFileError } from './workspace-files.js'
import { DshClient, type RemoteModelEntry } from './remote-client.js'
import {
  backlogInstructionSnippet,
  createItem,
  deleteItem,
  encodeFrontmatter,
  findItem,
  initBacklog,
  listBacklog,
  normalizeItemId,
  readItem,
  replaceAcceptance,
  replaceDescription,
  writeItem,
} from './backlog.js'
import {
  dispatchBacklogItem,
  listBacklogWithTasks,
  mergeBacklogFacets,
  overviewBacklog,
  stripBacklogItemSearchText,
  stripBacklogSearchText,
  summarizeBacklogOverview,
  type BacklogDispatchResult,
} from './backlog-service.js'
import { applyBacklogQuery, parseBacklogQuery } from './backlog-query.js'
import { applyProjectCollect, previewProjectCollect } from './backlog-collect.js'
import { SshInputError, execOnSshResource, maskSshResource, normalizeSshResource, testSshResource } from './ssh-resources.js'
import type { SshResourceStore } from './ssh-store.js'
import { GroupStore, GroupStoreError, normalizeGroupRoom } from './groups.js'
import type { ScheduleRunner } from './scheduler.js'
import { normalizeRule, nextRun, ruleText } from './scheduler.js'
import { SCHEDULE_TEMPLATES } from './schedule-templates.js'
import { expertPersona, buildExpertSource } from './expert-registry.js'
import { ExpertRegistry } from './expert-registry.js'
import { UserExpertStore } from './expert-store.js'
import { parseTeamInput, BUILTIN_TEAMS } from './expert-teams.js'
import type { AuthService, SessionInfo } from './auth.js'
import type { MailService, RateLimiter } from './mail.js'
import type { AuditLog } from './audit.js'
import { UsageService } from './usage.js'
import type { XiaozhiMcpClient } from './xiaozhi-mcp.js'
import type { DshRef, Project, SubAgent, WorkTask, ScheduledTask } from './types.js'
import { NODE_AGENT_ID, MAIN_AGENT_LABEL, projectDefaultAgentIds, projectDefaultAgentIdsFromInput } from './types.js'
import {
  canAccessProject,
  canManageAgent,
  canManageOwned,
  canManageResource,
  canManageSchedule,
  canManageTask,
  canUseResource,
  canUseAgent,
  canViewAgent,
  canViewResource,
  canViewSchedule,
  canViewTask,
  maskAgentForViewer,
  visibleTasks,
  type PermContext,
} from './perm.js'
import type { MonitorService } from './monitor.js'
import { ProjectAgents } from './project-agents.js'
import { queryProjects, compactProject } from './project-query.js'
import { queryMonitorOverview } from './monitor-query.js'
import { SkillPluginLibrary, buildSkillInstallPrompt, buildPluginInstallPrompt, buildPluginExportPrompt, buildPluginListExportPrompt, buildProjectImportPrompt, extractExportedPaths } from './library.js'
import type { LibKind } from './library.js'
import { requestPublicBase } from './mcp-server.js'
import { buildAiInstallPayload, normalizeInstallBase } from './ai-install.js'
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
  private historyIndex?: TaskHistory
  private version = formatDateVersion(readPackageVersion())
  /** GET /api/resources 微缓存：折叠多标签页秒级轮询风暴（节点状态 1.5s 粒度足够） */
  private resourcesCache: { at: number; body: string } | undefined
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
    private mail?: MailService,
    private auditLog?: AuditLog,
    private limiter?: RateLimiter,
    private groupsStore?: GroupStore,
  ) {
    // 用户自建专家层：数据落 <dataDir>/user-experts.json，与只读资产层合并为统一视图
    this.registry.attachUserStore(new UserExpertStore(store.dataDir))
  }

  /** 统一专家注册表（供 MCP Server 等外部挂载点复用同一份数据与缓存）。 */
  public get expertRegistry(): ExpertRegistry {
    return this.registry
  }

  /** 协作群存储（断言注入：server.ts 单例装配（裁定 A）或测试注入；懒建兜底已拆除——双实例会互相覆盖丢数据） */
  private get groupStore(): GroupStore {
    if (!this.groupsStore) throw new Error('GroupStore 未装配：server.ts 必须注入单例实例（裁定 A）')
    return this.groupsStore
  }

  /** Request-local identity: concurrent parsing/remote calls must never overwrite another user's permissions. */
  private requestContext = new AsyncLocalStorage<{ session?: SessionInfo }>()
  private get session(): SessionInfo | undefined {
    return this.requestContext.getStore()?.session
  }

  private isPlatformAdmin(): boolean {
    return this.session?.role === 'admin'
  }

  /**
   * 全局配置/聚合面门禁（§11 矩阵：设置/监控/语音助手/库设置等全局面仅管理员）。
   * 浏览器会话非 admin → 拦；AI 工具通道（无用户身份、server.ts 白名单内）保持服务级开放
   * ——token→用户绑定属遗留项，通道硬化见 tool-ops.ts aiTokenOnly。
   */
  private isAdminOrServiceChannel(): boolean {
    return !this.session || this.isPlatformAdmin()
  }

  /** 全局面门禁拒绝响应（配合 isAdminOrServiceChannel 使用） */
  private denyNotAdmin(res: ServerResponse, what: string): void {
    this.sendJson(res, 403, { ok: false, error: `仅平台管理员可${what}` })
  }

  /** 项目是否启用成员隔离（存量项目无 owner 且无成员 → 宽容模式，登录用户可见） */
  private static projectIsolated(proj: Project): boolean {
    return Boolean(proj.owner || (proj.projectMembers && proj.projectMembers.length))
  }

  /** 项目是否可见：宽容模式（无 owner 且无成员）对登录用户可见；隔离模式仅成员/admin */
  private canSeeProject(proj: Project): boolean {
    if (!WorkBuddyRouter.projectIsolated(proj)) return true
    return canAccessProject(this.session, proj, 'view')
  }

  /** 是否项目 owner（含平台管理员）：统一走 perm.ts 的 canAccessProject，避免散落判定 */
  private isProjectOwner(proj: Project): boolean {
    return canAccessProject(this.session, proj, 'manageMembers')
  }

  /**
   * §11 任务取用辅助：取任务并做可见性判定（不可见与不存在统一 404，防枚举）。
   * 聊天/流/附件/goal-plan/subtasks/stats 等 view 级入口用 taskForView；
   * 改名/删除/归档/成员/模型预设/permission/queue 等管理入口用 taskForManage。
   */
  private taskForView(taskId: string): WorkTask | undefined {
    const task = this.store.getTask(taskId)
    if (!task || (this.session && !canViewTask(this.session, task, this.permContext()))) return undefined
    return task
  }

  /** 任务管理权取用：不可见/不存在返回 undefined（统一 404），存在但无管理权返回 'forbidden' */
  private taskForManage(taskId: string): { task?: WorkTask; forbidden?: boolean } {
    const task = this.store.getTask(taskId)
    if (!task || !canViewTask(this.session, task, this.permContext())) return {}
    if (!canManageTask(this.session, task)) return { forbidden: true }
    return { task }
  }

  /**
   * 权限判定上下文（§10）：项目集合 —— 资源/智能体的「项目绑定共享」判定依据。
   * 判定逻辑统一在 perm.ts，路由层只调用，不散落 if。
   */
  private permContext(): PermContext {
    return { projects: this.store.getProjects() }
  }

  /** 专家团脱敏：非归属人看不到主理人补充规则（私有配置） */
  private maskTeamForViewer<T extends { id: string; ownerUserId?: string; coordinatorPrompt?: string }>(
    team: T,
    session: SessionInfo | undefined,
  ): T {
    if (!team.ownerUserId) return team
    if (this.isPlatformAdmin()) return team
    if (team.ownerUserId === session?.userId) return team
    const clone: Record<string, unknown> = { ...(team as unknown as Record<string, unknown>) }
    delete clone.coordinatorPrompt
    return clone as unknown as T
  }

  /**
   * backlog 待办 → WorkTask 一键派发（B4，docs/design-backlog-integration.md §6.1）。
   * 实现在 backlog-service（工具通道复用同一段派发+回写关联逻辑，避免分叉）。
   */
  private async dispatchBacklogItem(
    proj: Project,
    target: any,
    workspace: string,
    itemId: string,
    opts: { force?: boolean; instruction?: string } = {},
  ): Promise<BacklogDispatchResult> {
    return dispatchBacklogItem({ client: this.client, engine: this.engine }, proj, target, workspace, itemId, { ...opts, ownerUserId: this.session?.userId })
  }

  /** 发送用户邀请邮件：结果随响应返回（sent/status/error）供 UI 提示；失败不抛错，inviteLink 仍可手动复制 */
  private async sendInviteEmail(to: string, displayName: string | undefined, inviteLink: string, expiresAt: number) {
    if (!this.mail || !to) return { sent: false, status: 'mock' as const, error: this.mail ? '收件邮箱缺失' : '邮件服务不可用' }
    const r = await this.mail.sendInviteMail({ to, displayName, inviteLink, expiresAt, attempts: 2, timeoutMs: 8000 })
    return { sent: r.ok, status: r.status, error: r.error }
  }

  /** 审计（B-03）：关键操作落 audit-log；未装配实例时静默跳过 */
  private audit(action: string, targetType: string, targetId: string, detail?: string) {
    this.auditLog?.record({
      actorId: this.session?.userId || 'system',
      actorName: this.session?.displayName || this.session?.username,
      action, targetType, targetId, detail,
    })
  }

  /** 邮件类接口限流（B-04）：IP+动作+目标邮箱 5 次/小时；超限返回 true */
  private mailLimited(req: IncomingMessage, action: string, email: string): boolean {
    if (!this.limiter) return false
    const ip = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()
    return this.limiter.hit(`${ip}|${action}|${String(email || '').trim().toLowerCase()}`)
  }

  /** 项目归档只读校验：归档态拒绝变更类操作 */
  private static archivedBlocked(proj: Project): boolean {
    return Boolean(proj.archivedAt)
  }

  /** 插件导出任务的回收结果缓存（taskId → 已拉取结果），保证 poll 幂等 */
  private pluginImportDone = new Map<string, { ok: boolean; imported?: any[]; failed?: Array<{ file: string; error: string }>; error?: string }>()
  /** Token 消耗明细归因（只读聚合，懒初始化避免与参数属性初始化顺序耦合） */
  private usageSvc?: UsageService
  private get usage(): UsageService {
    if (!this.usageSvc) this.usageSvc = new UsageService(this.store)
    return this.usageSvc
  }
  /** 插件导出任务的来源节点（taskId → dshRef + 展示名 + 插件家族）：poll 回拉时按节点取 /fs，不再依赖子智能体 */
  private pluginImportRefs = new Map<string, { ref: DshRef; label: string; family?: string }>()

  /** 项目导入上传令牌（token → 待入库信息）；2 小时未收到上传自动作废 */
  private pendingProjectImports = new Map<string, {
    importId: string
    ownerUserId?: string
    name: string
    path: string
    nodeRef: DshRef
    nodeLabel: string
    taskId: string
    at: number
  }>()

  /** 引擎家族探测汇总（dsh/zcode；探测失败或不可判=unknown，调用方按「不设限」处理） */
  private async engineFamilyOfRef(ref: DshRef | undefined): Promise<string> {
    let ep: any = undefined
    try {
      if (!ref) return 'unknown'
      if (ref.kind === 'mapping') ep = this.directory.resolveMapping(ref.mappingId)
      else if (ref.kind === 'app') ep = this.directory.resolveApp(ref.appId)
      else return 'unknown'
    } catch {
      return 'unknown'
    }
    if (!ep || !ep.baseUrl || !ep.online) return 'unknown'
    let info = this.directory.engineInfoOf(ep.mappingId)
    if (!info || Date.now() - info.probedAt > 90_000 || info.engine === 'unknown') {
      try { info = await this.directory.probeEngine(ep, { force: true }) } catch { info = undefined }
    }
    return info?.engine && info.engine !== 'unknown' ? info.engine : 'unknown'
  }

  /** DSH 节点展示名（映射节点取应用名（含端口后缀）；直连取 baseUrl） */
  private nodeLabelOf(ref: DshRef): string {
    if (ref.kind === 'mapping') {
      const m = this.directory.resolveMapping(ref.mappingId)
      return m?.appName || ref.mappingId
    }
    if (ref.kind === 'app') {
      const a = this.directory.resolveApp(ref.appId)
      return a?.appName || ref.appId
    }
    return String(ref.apiBaseUrl || '直连节点')
  }

  /** 节点稳定键（随 DshRef 种类取 id），用于下发给节点智能体做载荷一致性校验，与 nodeLabel 的展示名区分 */
  private nodeKeyOf(ref: DshRef): string {
    if (ref.kind === 'mapping') return ref.mappingId
    if (ref.kind === 'app') return ref.appId
    return String(ref.apiBaseUrl || '')
  }

  /** 按当前 HTTP 请求头推断访问基址（浏览器地址栏视角）：反代场景优先 x-forwarded-* */
  private requestBase(req: IncomingMessage, prefix: string): string {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http'
    const host = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim() || String(req.headers.host || 'localhost')
    return `${proto}://${host}${prefix}`
  }

  /** 生成给 DSH 用的库文件下载链接：优先用配置的公网基址，否则按请求头推断 */
  private externalBase(req: IncomingMessage, prefix: string): string {
    const configured = this.library?.publicBaseUrl()
    if (configured) return configured
    return this.requestBase(req, prefix)
  }

  /** 插件导出任务收尾：从任务轮次解析 tgz 绝对路径，经远端 /fs/download 拉回入库 */
  private async pullExportedPlugins(taskId: string, agent: SubAgent): Promise<{ ok: boolean; imported?: any[]; failed?: Array<{ file: string; error: string }>; error?: string }> {
    return this.pullExportedPluginsInner(taskId, () => this.resolver.resolve(agent), agent.name)
  }

  /** nodeRef 直发路径的回拉：按发起时记录的来源节点取 /fs，不依赖子智能体 */
  private async pullExportedPluginsByRef(taskId: string, ref: DshRef, label: string, family?: string): Promise<{ ok: boolean; imported?: any[]; failed?: Array<{ file: string; error: string }>; error?: string }> {
    return this.pullExportedPluginsInner(taskId, () => this.resolver.resolveRef(ref, undefined, 'library-node'), label, family)
  }

  private async pullExportedPluginsInner(
    taskId: string,
    resolveTarget: () => Promise<any>,
    sourceLabel: string,
    family?: string,
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
        imported.push(await this.library.add('plugin', { filename, data: buf }, 'import', sourceLabel, family, this.session?.userId))
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

  /** 端点列表附带引擎探测档案（有则带，无则原样 —— 探测是异步后台过程） */
  private attachEngine(endpoints: ReturnType<OnenatDirectory['listEndpoints']>): ReturnType<OnenatDirectory['listEndpoints']> {
    return endpoints.map((e) => {
      const eng = this.directory.engineInfoOf(e.mappingId)
      return eng ? { ...e, engine: eng } : e
    })
  }

  /**
   * 解析 fs 通道目标节点：优先 node=<dshRef JSON>（项目工作区浏览，无需子智能体），
   * 否则回退 agent=<id>（子智能体所在节点）。三个返回字段与 list/mkdir 既有行为一致。
   */
  private async resolveFsTarget(url: URL, fallbackAgentId?: string, fileAction?: 'read' | 'write'): Promise<{ ok: true; target: any; project?: Project } | { ok: false; status: number; error: string }> {
    const projectId = url.searchParams.get('projectId') || ''
    if (projectId) {
      const project = this.store.getProject(projectId)
      if (!project || (this.session && !this.canSeeProject(project))) return { ok: false, status: 404, error: '项目不存在' }
      if (fileAction) requireProjectFiles(this.session, project, fileAction === 'write')
      const target = await this.resolver.resolveRef(project.dshRef, project.apiKey, 'project-workspace')
      if (!target.online || !target.baseUrl) return { ok: false, status: 502, error: target.error || '文件归属节点不可达' }
      return { ok: true, target, project }
    }
    if (fileAction) requireNodeFiles(this.session)
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

  /** Authorize paths before remote file IO, then reject remote descendant links. */
  private async projectFsPath(scope: { target: any; project?: Project }, input: string | undefined, write = false, absent = false, recursive = false) {
    if (!scope.project) return { path: input || '', exists: true, listing: undefined }
    const path = projectFilePath(scope.project, input)
    requireWorkspacePath(this.session, scope.project, this.store.getProjects(), this.directory, path, write, recursive)
    const checked = await checkWorkspaceFsPath(this.client, scope.target, scope.project, path, absent)
    return { path, ...checked }
  }

  /** Preserve completed saves if a later file conflicts or its remote outcome is uncertain. */
  private async saveProjectUploads(scope: { target: any; project: Project }, dir: string, files: Array<{ filename: string; data: Buffer }>, expectedSha256?: string) {
    const saved: Array<{ name: string; path: string; size: number; sha256?: string }> = []
    let currentName: string | undefined
    try {
      if (!files.length) throw new WorkspaceFileError(400, 'FILES_REQUIRED', '未找到上传文件')
      const names = new Set<string>()
      for (const file of files) {
        workspaceChild(projectFilePath(scope.project, dir), file.filename)
        if (names.has(file.filename)) throw new WorkspaceFileError(400, 'DUPLICATE_FILENAME', '同一批次不能包含重复文件名')
        names.add(file.filename)
      }
      for (const file of files) {
        currentName = file.filename
        const path = workspaceChild(projectFilePath(scope.project, dir), file.filename)
        const checked = await this.projectFsPath(scope, path, true, true)
        if (checked.exists && (!expectedSha256 || files.length !== 1)) throw new WorkspaceFileError(428, 'VERSION_REQUIRED', '同名文件未覆盖：更新须先读取并携带 expectedSha256，每次只更新一个文件')
        const out = await writeProjectFile(scope.project, scope.target, this.directory, path, file.data, expectedSha256)
        if (!out.ok) return { status: out.code === 'CAS_MISMATCH' ? 409 : 400, body: { ...out, files: saved, partial: saved.length > 0, failedFile: currentName } }
        saved.push({ name: file.filename, path, size: file.data.length, sha256: out.sha256 })
      }
      return { status: 200, body: { ok: true, files: saved } }
    } catch (err) {
      const status = err instanceof WorkspaceFileError ? err.status : 502
      const code = err instanceof WorkspaceFileError ? err.code : 'WORKSPACE_UPLOAD_FAILED'
      return { status, body: { ok: false, code, error: (err as Error).message || '远端上传失败', files: saved, partial: saved.length > 0, failedFile: currentName } }
    }
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
        ? (this.directory.resolveMapping(proj.dshRef.mappingId)?.appName || proj.dshRef.mappingId)
        : (this.directory.resolveApp(proj.dshRef.appId)?.appName || proj.dshRef.appId))
    return {
      id: proj.id,
      name: proj.name,
      dshRef: proj.dshRef,
      defaultExecutionNodeRef: proj.defaultExecutionNodeRef,
      nodeTitle: nodeTitle || '(未配置节点)',
      workspace: proj.workspace || '',
      instruction: proj.instruction || '',
      instructionPreview: (proj.instruction || '').slice(0, 120),
      expertIds: proj.expertIds,
      defaultAgentIds: projectDefaultAgentIds(proj),
      experts: projectDefaultAgentIds(proj).map((id) => ({ id, name: this.store.getAgent(id)?.name || id })),
      connectorIds: proj.connectorIds,
      skillNames: proj.skillNames,
      owner: proj.owner,
      ownerInfo: proj.owner ? this.auth?.describeUser(proj.owner) || null : null,
      allowMemberInvite: proj.allowMemberInvite === true,
      projectMembers: (proj.projectMembers || []).map((m) => ({ ...m, userInfo: this.auth?.describeUser(m.userId) || null })),
      isolated: WorkBuddyRouter.projectIsolated(proj),
      archived: Boolean(proj.archivedAt),
      archivedAt: proj.archivedAt,
      importedFrom: proj.importedFrom,
      createdAt: proj.createdAt,
      updatedAt: proj.updatedAt,
    }
  }

  /** 创建/更新项目（校验名称与节点；默认协作成员必须存在；defaultAgentIds 为 canonical，expertIds 兼容别名） */
  private upsertProjectFromInput(body: any): Project {
    const existing = body?.id ? this.store.getProject(String(body.id)) : undefined
    const name = String(body?.name ?? existing?.name ?? '').trim()
    if (!name) throw new Error('缺少项目名称')
    const dshRef = body?.dshRef ? (body.dshRef as DshRef) : undefined
    if (existing && !this.canSeeProject(existing)) throw Object.assign(new Error('项目不存在'), { status: 404 })
    if (existing && !this.isProjectOwner(existing)) throw Object.assign(new Error('仅项目 owner 或平台管理员可编辑项目'), { status: 403 })
    if (existing && WorkBuddyRouter.archivedBlocked(existing)) throw new Error('项目已归档（只读），请先恢复再编辑')
    const finalRef = dshRef || existing?.dshRef
    if (!finalRef) throw new Error('缺少项目 DSH 节点（dshRef）')
    const checkedRef = normalizeDshRef(finalRef)
    if ('error' in checkedRef) throw new Error(checkedRef.error)
    const executionRef = body?.defaultExecutionNodeRef == null ? undefined : normalizeDshRef(body.defaultExecutionNodeRef)
    if (executionRef && 'error' in executionRef) throw new Error(executionRef.error)
    // 显式传入（含 []）即生效并写 canonical；未传时保留既有值。expertIds 传入时视为同一字段的旧写法。
    const defaultAgentIds = projectDefaultAgentIdsFromInput(body)
    new ProjectAgents(this.store).validateAgents(defaultAgentIds || [], { session: this.session })
    return this.store.upsertProject({
      id: body?.id ? String(body.id) : undefined,
      name,
      dshRef: checkedRef,
      ...(body?.defaultExecutionNodeRef !== undefined ? { defaultExecutionNodeRef: executionRef as DshRef | undefined } : {}),
      apiKey: body?.apiKey !== undefined ? String(body.apiKey) : undefined,
      workspace: body?.workspace !== undefined ? String(body.workspace) : undefined,
      instruction: body?.instruction !== undefined ? String(body.instruction) : undefined,
      ...(defaultAgentIds !== undefined ? { defaultAgentIds } : {}),
      connectorIds: Array.isArray(body?.connectorIds) ? body.connectorIds.map(String) : (existing?.connectorIds || []),
      skillNames: Array.isArray(body?.skillNames) ? body.skillNames.map(String) : (existing?.skillNames || []),
      ...(body?.allowMemberInvite !== undefined ? { allowMemberInvite: Boolean(body.allowMemberInvite) } : {}),
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
      chatAgentId: t.chatAgentId,
      status: t.status,
      projectId: t.projectId || undefined,
      // §11：前端按钮门控依据（canManageTaskUi 与服务端同口径）
      ownerUserId: t.ownerUserId,
      running: this.engine.isRunning(t.id),
      pendingAsk: Boolean(t.pendingAsk),
      memberAgentIds: t.memberAgentIds,
      // 任务节点：会话头部节点选择器按它回显（否则列表壳/E2E 下显示的是「新任务默认节点」，与实际执行节点不符）
      nodeRef: t.nodeRef,
      lastRoute: t.lastRoute,
      scheduleId: t.scheduleId || undefined,
      workDir: t.workDir || undefined,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
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
  private upsertScheduleFromInput(body: any, opts: { ownerUserId?: string } = {}): ScheduledTask {
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
    const workDir = String(body?.workDir || '').trim()
    if (workDir && !isNodeAbsolutePath(workDir)) throw new Error(WORK_DIR_NOT_ABSOLUTE_MSG)
    const skills = Array.isArray(body?.skills)
      ? Array.from(new Set((body.skills as any[]).map((s) => String(s).trim()).filter(Boolean)))
      : []
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
      ...(body && 'workDir' in body ? { workDir } : {}),
      ...(body && 'skills' in body ? { skills } : {}),
      message,
      rule,
      enabled,
      nextRunAt,
      // §11：归属仅在创建时由服务端会话写入（AI 工具通道无会话 → 缺省宽容模式）
      ...(opts.ownerUserId ? { ownerUserId: opts.ownerUserId } : {}),
      ...(existing ? { runs: existing.runs, lastRunAt: existing.lastRunAt, createdAt: existing.createdAt, totalRuns: existing.totalRuns, successRuns: existing.successRuns } : {}),
    })
  }

  /** 列表摘要：剔除 runs（历史走详情） */
  private scheduleSummary(s: ScheduledTask) {
    const agents = s.agentIds.map((aid) => this.store.getAgent(aid)).filter(Boolean) as SubAgent[]
    const nodeTitle = s.nodeMappingId ? (this.directory.resolveMapping(s.nodeMappingId)?.appName || s.nodeMappingId) : ''
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      agentIds: s.agentIds,
      // §11：前端按钮门控依据（canManageScheduleUi 与服务端同口径）
      ownerUserId: s.ownerUserId,
      agents: agents.map((a) => ({ id: a.id, name: a.name, enabled: a.enabled !== false })),
      nodeMappingId: s.nodeMappingId,
      nodeTitle,
      model: s.model,
      workDir: s.workDir || '',
      skills: s.skills || [],
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
          const target = await this.engine.resolveExecTarget(task, agentId)
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
      let unsupportedError = ''
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
        } else if (!unsupportedError) {
          unsupportedError = r.error || ''
        }
      }
      // 无绑定（纯本地 DSH 任务）或全部成员远端过旧时不支持
      if (bindings.length === 0) supported = false
      // 不支持时给出准确原因：no_session = 还没有远端会话（前端不提示）；offline = 成员节点全部离线；unsupported = 远端版本过低
      let reasonCode: 'no_session' | 'offline' | 'unsupported' | undefined
      let reason: string | undefined
      if (!supported) {
        if (bindings.length === 0) {
          reasonCode = 'no_session'
          reason = '任务尚未在远端节点建立会话'
        } else if (sessionsTotal === 0) {
          reasonCode = 'offline'
          reason = '成员所在节点离线，暂时无法读取统计'
        } else {
          reasonCode = 'unsupported'
          reason = unsupportedError || '远端 dsh-web-service 版本过低，不含统计接口'
        }
      }
      // 按成员拆分（S2-1）：合并口径 stats 保持不变（向后兼容），另带 members[] 供 Token 面板分行展示
      const okByAgent = new Map(results.filter((x): x is NonNullable<typeof x> => Boolean(x)).map((x) => [x.agentId, x]))
      const projForLabel = task.projectId ? this.store.getProject(task.projectId) : undefined
      const members = bindings.map(([agentId]) => {
        const agent = this.store.getAgent(agentId)
        const ref = agent?.dshRef || task.nodeRef || projForLabel?.dshRef
        const hit = okByAgent.get(agentId)
        return {
          agentId,
          name: agent?.name || '主会话',
          nodeLabel: ref ? this.nodeLabelOf(ref) : '',
          model: agent?.model || task.model || '',
          stats: hit && hit.ok ? hit.stats : undefined,
        }
      })
      const payload = {
        ok: true,
        data: {
          taskId,
          supported,
          sessionsOk,
          sessionsTotal,
          stats: supported ? totals : undefined,
          members,
          ...(reasonCode ? { reasonCode, reason } : {}),
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
   * 解析任务「主会话」的远端定位：主智能体优先，其次按绑定顺序首个已建会话的成员。
   * 返回 { error } 表示任务不存在或尚无可用远端会话。
   */
  private async resolveTaskMainSession(taskId: string): Promise<{
    target?: any; remoteSessionId?: string; agentId?: string; error?: string; httpStatus?: number
  }> {
    const task = this.store.getTask(taskId)
    if (!task) return { error: 'Task not found', httpStatus: 404 }
    const memberIds = Object.keys(task.sessions || {})
    const mainAgent = this.planner.pickMainAgent()
    const mainId = mainAgent && memberIds.includes(mainAgent.id) ? mainAgent.id : ''
    const ordered = [...(mainId ? [mainId] : []), ...memberIds.filter((id) => id !== mainId)]
    for (const agentId of ordered) {
      const binding = task.sessions[agentId]
      if (!binding?.remoteSessionId) continue
      const agent = this.store.getAgent(agentId)
      try {
        const target = await this.engine.resolveExecTarget(task, agentId).catch(() => undefined)
        if (!target || !target.online || !target.baseUrl) continue
        return { target, remoteSessionId: binding.remoteSessionId, agentId }
      } catch { /* 下一个成员 */ }
    }
    return { error: '任务尚无可用的远端会话（先发一条消息建立会话后重试）', httpStatus: 409 }
  }

  /** 节点引擎标签缓存（baseUrl → 5 分钟）：能力不支持时附带真实版本，避免「版本过低」误判 */
  private nodeEngineCache = new Map<string, { at: number; label: string }>()

  /** 探测节点引擎名/版本（短超时 + 缓存）；失败返回空串，不阻断能力探测 */
  private async nodeEngineLabel(target: { baseUrl: string; apiKey?: string }): Promise<string> {
    const key = String(target.baseUrl || '')
    if (!key) return ''
    const hit = this.nodeEngineCache.get(key)
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.label
    const p = await this.client.ping(target, { timeoutMs: 3000 }).catch(() => undefined)
    const label = p?.ok ? `${p.name || 'dsh-web-service'}${p.version ? ' v' + p.version : ''}` : ''
    if (label) this.nodeEngineCache.set(key, { at: Date.now(), label })
    return label
  }

  /**
   * 任务级会话协作接口（goal / plan / compact）：等价 GUI 斜杠命令的远程入口。
   * 操作任务主会话（见 resolveTaskMainSession）；远端需要 dsh-web-service ≥ 0.3.9。
   * 语义约定：**能力探测（GET）** 不支持时返回 200 + supported:false（reason 为准确原因）；
   * **动作调用（PUT/POST）** 不支持时返回 501（表示这次操作无法执行）。
   */
  private async handleTaskCollab(
    taskId: string,
    kind: 'goal' | 'plan' | 'compact',
    method: string,
    body: any,
  ): Promise<{ httpStatus: number; payload: any }> {
    const main = await this.resolveTaskMainSession(taskId)
    if (main.error || !main.target || !main.remoteSessionId) {
      return { httpStatus: main.httpStatus || 404, payload: { ok: false, error: main.error } }
    }
    const target = main.target
    const sid = main.remoteSessionId
    try {
      if (kind === 'goal') {
        if (method === 'GET') {
          const r = await this.client.getGoal(target, sid)
          // 能力探测：不支持不是请求失败。返回 200 + supported:false（带准确原因），
          // 避免客户端/监控把“节点未装载目标服务”记成 HTTP 501 故障。
          if (r.supported === false) return { httpStatus: 200, payload: { ok: true, supported: false, data: { supported: false, reason: r.error, goal: null } } }
          if (!r.ok) return { httpStatus: 409, payload: { ok: false, error: r.error, supported: true } }
          return { httpStatus: 200, payload: { ok: true, supported: true, data: { supported: true, goal: r.goal ?? null } } }
        }
        if (method === 'POST') {
          const objective = typeof body?.objective === 'string' ? body.objective.trim() : ''
          if (!objective) return { httpStatus: 400, payload: { ok: false, error: 'objective 不能为空' } }
          const r = await this.client.createGoal(target, sid, objective, typeof body?.maxGoalRounds === 'number' ? body.maxGoalRounds : undefined)
          return { httpStatus: r.ok ? 200 : r.supported === false ? 501 : 409, payload: r.ok ? { ok: true, data: { goal: r.goal } } : { ok: false, error: r.error, supported: r.supported } }
        }
        // PUT：生命周期操作
        const action = String(body?.action || '')
        if (!['edit', 'pause', 'resume', 'complete', 'blocked', 'clear', 'disarm'].includes(action)) {
          return { httpStatus: 400, payload: { ok: false, error: 'action 必须是 edit | pause | resume | complete | blocked | clear | disarm' } }
        }
        const req: Record<string, unknown> = { action }
        if (action === 'edit' || action === 'blocked' || body?.ref) {
          if (body?.objective !== undefined) req.objective = body.objective
          if (body?.maxGoalRounds !== undefined) req.maxGoalRounds = body.maxGoalRounds
          if (body?.blockedReason !== undefined) req.blockedReason = body.blockedReason
          if (body?.ref !== undefined) req.ref = body.ref
        }
        const r = await this.client.updateGoal(target, sid, req)
        return { httpStatus: r.ok ? 200 : r.supported === false ? 501 : 409, payload: r.ok ? { ok: true, data: r.data } : { ok: false, error: r.error, supported: r.supported } }
      }
      if (kind === 'plan') {
        if (method === 'GET') {
          const r = await this.client.getPlan(target, sid)
          // 计划模式能力探测：节点未装载 planMode 服务时返回 200 + supported:false + 实际版本，
          // 不再用 501（旧行为会让日志/监控误判成部署故障，也被误读成“版本过低”）。
          if (r.supported === false) {
            const engine = await this.nodeEngineLabel(target)
            const reason = r.error + (engine ? `（当前节点 ${engine}）` : '')
            return { httpStatus: 200, payload: { ok: true, supported: false, data: { supported: false, reason, engine, active: false, pending: false } } }
          }
          if (!r.ok) return { httpStatus: 409, payload: { ok: false, error: r.error, supported: true } }
          return { httpStatus: 200, payload: { ok: true, supported: true, data: { supported: true, active: !!r.active, pending: !!r.pending } } }
        }
        if (typeof body?.active !== 'boolean') {
          return { httpStatus: 400, payload: { ok: false, error: 'active (boolean) 必填' } }
        }
        const r = await this.client.setPlan(target, sid, body.active)
        return { httpStatus: r.ok ? 200 : r.supported === false ? 501 : 409, payload: r.ok ? { ok: true, data: { active: r.active, pending: r.pending, transition: r.transition } } : { ok: false, error: r.error, supported: r.supported } }
      }
      // compact
      const r = await this.client.compactSession(target, sid)
      return { httpStatus: r.ok ? 200 : r.supported === false ? 501 : 409, payload: r.ok ? { ok: true, data: { compacted: !!r.compacted, message: r.message } } : { ok: false, error: r.error, supported: r.supported } }
    } catch (err: any) {
      return { httpStatus: 502, payload: { ok: false, error: err?.message || '远端调用失败' } }
    }
  }

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
          const target = await this.engine.resolveExecTarget(task, agentId)
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
          const target = await this.engine.resolveExecTarget(task, agentId)
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

  public async dispatch(req: IncomingMessage, res: ServerResponse, prefix: string, opts?: { auth?: boolean; session?: SessionInfo }): Promise<boolean> {
    return this.requestContext.run({ session: opts?.session }, async () => {
      try { return await this.dispatchRequest(req, res, prefix, opts) }
      catch (err) {
        if (!(err instanceof WorkspaceFileError)) throw err
        this.sendJson(res, err.status, { ok: false, code: err.code, error: err.message })
        return true
      }
    })
  }

  private async dispatchRequest(req: IncomingMessage, res: ServerResponse, prefix: string, opts?: { auth?: boolean; session?: SessionInfo }): Promise<boolean> {
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

    // ---------- 小智 MCP 接入（语音助手页，多实例管理；§11 全局接入点配置仅平台管理员） ----------
    if (p === '/api/xiaozhi/status' && method === 'GET') {
      if (!this.isAdminOrServiceChannel()) { this.denyNotAdmin(res, '管理语音助手接入'); return true }
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
      if (!this.isAdminOrServiceChannel()) { this.denyNotAdmin(res, '管理语音助手接入'); return true }
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
      if (!this.isAdminOrServiceChannel()) { this.denyNotAdmin(res, '管理语音助手接入'); return true }
      const id = decodeURIComponent(xzDelMatch[1])
      const list = (this.store.getSettings().xiaozhi?.endpoints || []).filter((e) => e.id !== id)
      this.saveXiaozhiEndpoints(list)
      this.sendJson(res, 200, { ok: true, data: { deleted: true, endpoints: this.xiaozhiListWithStatus(list) } })
      return true
    }

    // ---------- 项目（列表/创建/详情/修改/删除） ----------
    if (p === '/api/projects' && method === 'GET') {
      // scope 视图（P-02）：owned=我拥有的；joined=我是成员的；all=平台管理员看全部；缺省=可见列表
      const url = new URL(req.url || '/', 'http://localhost')
      const scope = (url.searchParams.get('scope') || '').trim()
      let list = this.store.getProjects().filter((proj) => this.canSeeProject(proj))
      if (scope === 'owned') {
        list = list.filter((proj) => this.isProjectOwner(proj))
      } else if (scope === 'joined') {
        const uid = this.session?.userId
        list = list.filter((proj) => Boolean(uid && (proj.projectMembers || []).some((m) => m.userId === uid)))
      } else if (scope === 'all') {
        if (!this.isPlatformAdmin()) { this.sendJson(res, 403, { ok: false, error: '仅平台管理员可查看全部项目' }); return true }
      }
      try {
        const q = url.searchParams
        const options = Object.fromEntries(['name', 'workspace', 'keyword', 'limit', 'offset', 'compact'].filter(k => q.has(k)).map(k => [k, q.get(k)]))
        // Existing console consumers expect the complete array without query options.
        if (!Object.keys(options).length) {
          this.sendJson(res, 200, { ok: true, data: list.map(proj => this.projectSummary(proj)) })
        } else {
          const query = queryProjects(list, options)
          const tasks = this.store.getTasks().filter(t => !this.session || canViewTask(this.session, t, this.permContext()))
          const data = query.rows.map(proj => query.compact
            ? compactProject(proj, tasks.filter(t => t.projectId === proj.id).length)
            : this.projectSummary(proj))
          this.sendJson(res, 200, { ok: true, data, ...query.metadata })
        }
      } catch (err: any) {
        this.sendJson(res, err.status || 400, { ok: false, error: err.message, code: 'INVALID_PARAMS' })
      }
      return true
    }
    if (p === '/api/projects' && method === 'POST') {
      const body = await this.parseBody(req)
      try {
        const existing = body?.id ? this.store.getProject(String(body.id)) : undefined
        const saved = this.upsertProjectFromInput(body)
        this.audit(existing ? 'project.update' : 'project.create', 'project', saved.id, saved.name)
        // Only a new project gets the creator's ACL. Editing a legacy project must not claim it or replace members.
        if (!existing && this.session?.userId) {
          const finalized = this.store.upsertProject({
            id: saved.id,
            owner: this.session.userId,
            projectMembers: [{ userId: this.session.userId, role: 'owner', joinedAt: Date.now() }],
          })
          this.sendJson(res, 200, { ok: true, data: this.projectSummary(finalized) })
          return true
        }
        this.sendJson(res, 200, { ok: true, data: this.projectSummary(saved) })
      } catch (err: any) {
        this.sendJson(res, err?.status || 400, { ok: false, error: err?.message || String(err), ...(err?.code ? { code: err.code } : {}) })
      }
      return true
    }
    // ---------- 项目：从远程 DSH 导入（发分析任务 → 节点智能体分析项目 → 回调平台接口自动建项目） ----------
    if (p === '/api/projects/import' && method === 'POST') {
      const body = await this.parseBody(req)
      const nodeRef = normalizeDshRef(body?.nodeRef)
      const wsPath = normalizeWorkspacePath(String(body?.workspacePath || ''))
      if ('error' in nodeRef || !wsPath) {
        this.sendJson(res, 400, { ok: false, error: '缺少合法 nodeRef（来源 DSH 主节点）或 workspacePath（远端工作区路径）' })
        return true
      }
      try { validateWorkspacePath(wsPath) } catch (err: any) {
        this.sendJson(res, err.status, { ok: false, code: err.code, error: err.message })
        return true
      }
      const matches = this.store.getProjectsForWorkspace(nodeRef, wsPath)
      if (matches.length) {
        const existing = matches.find((proj) => this.canSeeProject(proj))
        if (!existing) { this.sendJson(res, 409, { ok: false, code: 'PROJECT_WORKSPACE_CONFLICT', error: new ProjectWorkspaceConflictError().message }); return true }
        this.sendJson(res, 200, { ok: true, data: { projectId: existing.id, project: this.projectSummary(existing), reused: true } })
        return true
      }
      const name = String(body?.name || '').trim() || wsPath.split('/').filter(Boolean).pop() || '导入项目'
      const target = await this.resolver.resolveRef(nodeRef, undefined, 'project-import').catch((err: any) => ({ online: false, error: err?.message || String(err) }))
      if (!target.online) {
        this.sendJson(res, 200, { ok: false, error: target.error || '来源节点不可达' })
        return true
      }
      const importId = 'pimp-' + randomUUID().slice(0, 8)
      const token = randomUUID() + randomUUID()
      // 回调地址跟随发起导入的浏览器访问地址（不使用库里配置的公网基址，避免跨站点写死）
      const base = this.requestBase(req, prefix)
      const createUrl = `${base}/api/projects/import-create?token=${token}`
      const nodeLabel = this.nodeLabelOf(nodeRef)
      // 候选清单：专家（子智能体）+ 连接器（SSH 池 / ONENAT 映射），供节点智能体按项目性质挑选（禁止编造 ID）
      const expertCandidates = this.store.getAgents().map((a) => ({ id: a.id, name: a.name, role: a.role || '' }))
      const connectorCandidates = [
        ...this.sshStore.list().map((s) => ({ id: `ssh:${s.id}`, label: `${s.name}（${s.host}）` })),
        ...this.directory.listEndpoints().filter((e) => e.kind !== 'dsh' && e.mappingId).map((e) => ({ id: `map:${e.mappingId}`, label: e.appName || e.note || e.mappingId! })),
      ]
      let task
      try {
        task = await this.engine.createTask({
          title: `分析并导入项目「${name}」→ 平台（${nodeLabel}）`,
          nodeRef,
          message: buildProjectImportPrompt({ name, path: wsPath, createUrl, nodeLabel, nodeKey: this.nodeKeyOf(nodeRef), importId, experts: expertCandidates, connectors: connectorCandidates }),
          creator: 'console',
          ownerUserId: this.session?.userId,
        })
      } catch (err: any) {
        this.sendJson(res, 200, { ok: false, error: err?.message || '发起导入任务失败' })
        return true
      }
      // 记录待入库令牌；节点分析完成回调（见 import-create）据此创建云端项目
      for (const [k, v] of this.pendingProjectImports) {
        if (Date.now() - v.at > 2 * 60 * 60 * 1000) this.pendingProjectImports.delete(k)
      }
      this.pendingProjectImports.set(token, { importId, ownerUserId: this.session?.userId, name, path: wsPath, nodeRef, nodeLabel, taskId: task.id, at: Date.now() })
      this.sendJson(res, 200, { ok: true, data: { taskId: task.id, importId, nodeLabel } })
      return true
    }
    // 项目创建端点（公开，靠一次性 token 鉴权）：节点智能体分析完远程项目后，按推断的表单内容调此接口建项目
    if (p === '/api/projects/import-create' && method === 'POST') {
      const token = String(urlObj.searchParams.get('token') || '').trim()
      const pending = token ? this.pendingProjectImports.get(token) : undefined
      if (!pending || Date.now() - pending.at > 2 * 60 * 60 * 1000) {
        if (token) this.pendingProjectImports.delete(token)
        this.sendJson(res, 403, { ok: false, error: '导入令牌无效或已过期（2 小时有效，请在平台重新发起导入）' })
        return true
      }
      const body = await this.parseBody(req).catch(() => null as any)
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        this.sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象：{node, workspace, name, instruction, expertIds, connectorIds, skillNames, summary}' })
        return true
      }
      // 防串号校验（载荷必须带与导入令牌一致的 node/workspace，提示词已预填）：同机并发导入可能互相
      // 覆盖载荷文件，比对不符即 409 拒收，避免把 A 项目的表单写进 B 项目（2026-10-18 线上事故）
      const normPath = normalizeWorkspacePath
      const bodyNode = String(body.node || '').trim()
      const bodyWorkspace = String(body.workspace || '').trim()
      if (bodyNode !== this.nodeKeyOf(pending.nodeRef) || normPath(bodyWorkspace) !== normPath(pending.path)) {
        this.sendJson(res, 409, { ok: false, error: `载荷校验不一致（载荷 node=${bodyNode || '缺失'} workspace=${bodyWorkspace || '缺失'}；本任务应为 node=${this.nodeKeyOf(pending.nodeRef)} workspace=${pending.path}）——这份载荷可能被同机并发导入任务覆盖，请用本任务专属文件名 /tmp/wb-import-<导入ID> 重写载荷后重试` })
        return true
      }
      const name = String(body.name || '').trim() || pending.name
      if (!name) {
        this.sendJson(res, 400, { ok: false, error: '缺少项目名（name）' })
        return true
      }
      // 候选白名单过滤：节点智能体可能推断出不存在的 ID，宁缺毋滥（截断时在响应里告知）
      const agentIds = new Set(this.store.getAgents().map((a) => a.id))
      const expertIds = (Array.isArray(body.defaultAgentIds) ? body.defaultAgentIds : Array.isArray(body.expertIds) ? body.expertIds : []).map(String).filter((id: string) => agentIds.has(id))
      const validConns = new Set<string>()
      for (const s of this.sshStore.list()) validConns.add(`ssh:${s.id}`)
      for (const e of this.directory.listEndpoints()) {
        if (e.mappingId) validConns.add(`map:${e.mappingId}`)
        if (e.appId) validConns.add(`app:${e.appId}`)
      }
      const connectorIds = (Array.isArray(body.connectorIds) ? body.connectorIds : []).map((x: any) => String(x).trim()).filter((id: string) => validConns.has(id))
      const skillNames: string[] = []
      if (Array.isArray(body.skillNames)) {
        for (const raw of body.skillNames) {
          const s = String(raw).trim().replace(/^\//, '')
          if (s && !skillNames.includes(s) && skillNames.length < 20) skillNames.push(s)
        }
      }
      const instruction = String(body.instruction || '').trim().slice(0, 6000) || (String(body.summary || '').trim() ? `项目概述：${String(body.summary).trim()}` : undefined)
      // Callback identity comes from the import initiator, never the current request's cookie.
      // Re-read account role/status and membership so revocation while analysis ran takes effect.
      const user = pending.ownerUserId ? this.auth?.getUserById(pending.ownerUserId) : undefined
      if (pending.ownerUserId && user?.status !== 'active') {
        this.sendJson(res, 403, { ok: false, error: '发起导入的用户已不可用，请重新登录后发起导入' })
        return true
      }
      const matches = this.store.getProjectsForWorkspace(pending.nodeRef, pending.path)
      const existing = matches.find((pr) => !pending.ownerUserId || canAccessProject(user ? { userId: user.id, role: user.role } : undefined, pr, 'view'))
      if (matches.length && !existing) {
        this.sendJson(res, 409, { ok: false, code: 'PROJECT_WORKSPACE_CONFLICT', error: new ProjectWorkspaceConflictError().message })
        return true
      }
      const project = existing || this.store.upsertProject({
        ...(pending.ownerUserId ? { owner: pending.ownerUserId, projectMembers: [{ userId: pending.ownerUserId, role: 'owner' as const, joinedAt: Date.now() }] } : {}),
        name,
        dshRef: pending.nodeRef,
        workspace: pending.path,
        instruction,
        defaultAgentIds: expertIds,
        connectorIds,
        skillNames,
        importedFrom: { sourceNode: pending.nodeLabel, sourcePath: pending.path, taskId: pending.taskId, at: Date.now() },
      })
      const dropped = {
        expertIds: Math.max(0, (Array.isArray(body.expertIds) ? body.expertIds.length : 0) - expertIds.length),
        connectorIds: Math.max(0, (Array.isArray(body.connectorIds) ? body.connectorIds.length : 0) - connectorIds.length),
      }
      this.pendingProjectImports.delete(token)
      this.sendJson(res, 200, { ok: true, data: { projectId: project.id, name: project.name, workspace: project.workspace, node: pending.nodeRef, nodeLabel: pending.nodeLabel, updated: Boolean(existing), dropped } })
      return true
    }
    // Both orientations share one service and the same project-owned relationship list.
    const projectBots = /^\/api\/projects\/([^/]+)\/agents(?:\/([^/]+))?$/.exec(p)
    const botProjects = /^\/api\/agents\/([^/]+)\/projects(?:\/([^/]+))?$/.exec(p)
    if (projectBots || botProjects) {
      const relations = new ProjectAgents(this.store)
      const actor = { session: this.session }
      try {
        const projectId = decodeURIComponent(projectBots?.[1] || botProjects?.[2] || '')
        const agentId = decodeURIComponent(botProjects?.[1] || projectBots?.[2] || '')
        if (method === 'GET' && !(projectBots?.[2] || botProjects?.[2])) {
          this.sendJson(res, 200, { ok: true, data: projectBots ? relations.forProject(projectId, actor) : relations.forAgent(agentId, actor) })
        } else if ((method === 'PUT' || method === 'DELETE') && projectId && agentId) {
          const data = relations.change(projectId, agentId, method === 'PUT', actor)
          this.audit(method === 'PUT' ? 'project.bot.link' : 'project.bot.unlink', 'project', projectId, agentId)
          this.sendJson(res, 200, { ok: true, data })
        } else this.sendJson(res, 405, { ok: false, error: '使用 GET 查询或 PUT/DELETE 修改单条关联' })
      } catch (err: any) {
        this.sendJson(res, err.status || 400, { ok: false, code: err.code, error: err.message })
      }
      return true
    }
    const projMatch = /^\/api\/projects\/([^/]+)$/.exec(p)
    if (projMatch) {
      const id = decodeURIComponent(projMatch[1])
      const proj = this.store.getProject(id)
      // 防枚举：成员隔离项目对非成员一律 404（不泄露存在性）
      if (proj && !this.canSeeProject(proj)) { this.sendJson(res, 404, { ok: false, error: '项目不存在' }); return true }
      if (method === 'GET') {
        if (!proj) { this.sendJson(res, 404, { ok: false, error: '项目不存在' }); return true }
        this.sendJson(res, 200, { ok: true, data: this.projectSummary(proj) })
        return true
      }
      if (method === 'DELETE') {
        if (proj && !this.isProjectOwner(proj)) {
          this.sendJson(res, 403, { ok: false, error: '仅项目 owner 或平台管理员可删除项目' })
          return true
        }
        this.audit('project.delete', 'project', id, proj?.name)
        this.sendJson(res, 200, { ok: true, data: { deleted: this.store.deleteProject(id) } })
        return true
      }
      if (method === 'PATCH' || method === 'PUT') {
        if (proj && !this.isProjectOwner(proj)) {
          this.sendJson(res, 403, { ok: false, error: '仅项目 owner 或平台管理员可编辑项目' })
          return true
        }
        if (proj && WorkBuddyRouter.archivedBlocked(proj)) {
          this.sendJson(res, 400, { ok: false, error: '项目已归档（只读），请先恢复再编辑' })
          return true
        }
        const body = await this.parseBody(req)
        try {
          const saved = this.upsertProjectFromInput({ ...body, id })
          this.sendJson(res, 200, { ok: true, data: this.projectSummary(saved) })
        } catch (err: any) {
          this.sendJson(res, err?.status || 400, { ok: false, error: err?.message || String(err), ...(err?.code ? { code: err.code } : {}) })
        }
        return true
      }
    }

    // ---------- 项目成员管理（人类用户成员；与 expertIds 智能体成员区分） ----------
    const projMembersMatch = /^\/api\/projects\/([^/]+)\/members(?:\/([^/]+))?$/.exec(p)
    if (projMembersMatch) {
      const proj = this.store.getProject(decodeURIComponent(projMembersMatch[1]))
      if (!proj || !this.canSeeProject(proj)) { this.sendJson(res, 404, { ok: false, error: '项目不存在' }); return true }
      const canManage = this.isProjectOwner(proj) || WorkBuddyRouter.projectIsolated(proj) === false
      const listMembers = () => (proj.projectMembers || []).map((m) => ({ ...m, userInfo: this.auth?.describeUser(m.userId) || null }))
      if (projMembersMatch[2]) {
        const targetUserId = decodeURIComponent(projMembersMatch[2])
        if (method === 'DELETE') {
          if (!WorkBuddyRouter.projectIsolated(proj)) { this.sendJson(res, 400, { ok: false, error: '该项目未启用成员管理' }); return true }
          if (WorkBuddyRouter.archivedBlocked(proj)) { this.sendJson(res, 400, { ok: false, error: '项目已归档（只读），请先恢复再操作成员' }); return true }
          const isSelf = this.session?.userId === targetUserId
          if (!canManage && !isSelf) { this.sendJson(res, 403, { ok: false, error: '仅项目 owner 或平台管理员可移除成员' }); return true }
          const target = (proj.projectMembers || []).find((m) => m.userId === targetUserId)
          if (!target) { this.sendJson(res, 404, { ok: false, error: '成员不存在' }); return true }
          // 最后一个 owner 不可移除/退出，需先转让（防呆）
          const owners = (proj.projectMembers || []).filter((m) => m.role === 'owner')
          if (target.role === 'owner' && owners.length <= 1) {
            this.sendJson(res, 422, { ok: false, error: '不能移除最后一个 owner：请先将其他成员升级为 owner' })
            return true
          }
          const saved = this.store.upsertProject({
            id: proj.id,
            projectMembers: (proj.projectMembers || []).filter((m) => m.userId !== targetUserId),
          })
          this.audit('project.member.remove', 'project', proj.id, `${targetUserId}${isSelf ? '（自行退出）' : ''}`)
          this.sendJson(res, 200, { ok: true, data: { removed: targetUserId, members: saved.projectMembers } })
          return true
        }
        if (method === 'PUT') {
          // 改成员角色（P-06）：owner/平台管理员；保留至少 1 名 owner
          if (!WorkBuddyRouter.projectIsolated(proj)) { this.sendJson(res, 400, { ok: false, error: '该项目未启用成员管理' }); return true }
          if (WorkBuddyRouter.archivedBlocked(proj)) { this.sendJson(res, 400, { ok: false, error: '项目已归档（只读），请先恢复再操作成员' }); return true }
          if (!this.isProjectOwner(proj)) { this.sendJson(res, 403, { ok: false, error: '仅项目 owner 或平台管理员可变更成员角色' }); return true }
          const body = await this.parseBody(req)
          const role: 'owner' | 'member' = body?.role === 'owner' ? 'owner' : 'member'
          const target = (proj.projectMembers || []).find((m) => m.userId === targetUserId)
          if (!target) { this.sendJson(res, 404, { ok: false, error: '成员不存在' }); return true }
          if (target.role === role) { this.sendJson(res, 200, { ok: true, data: { members: proj.projectMembers } }); return true }
          const owners = (proj.projectMembers || []).filter((m) => m.role === 'owner')
          if (target.role === 'owner' && role === 'member' && owners.length <= 1) {
            this.sendJson(res, 422, { ok: false, error: '不能降级最后一个 owner：请先将其他成员升级为 owner' })
            return true
          }
          const saved = this.store.upsertProject({
            id: proj.id,
            projectMembers: (proj.projectMembers || []).map((m) => (m.userId === targetUserId ? { ...m, role } : m)),
          })
          this.audit('project.member.role', 'project', proj.id, `${targetUserId} → ${role}`)
          this.sendJson(res, 200, { ok: true, data: { members: saved.projectMembers } })
          return true
        }
      } else {
        if (method === 'GET') {
          this.sendJson(res, 200, { ok: true, data: { members: listMembers(), isolated: WorkBuddyRouter.projectIsolated(proj) } })
          return true
        }
        if (method === 'POST') {
          if (!WorkBuddyRouter.projectIsolated(proj) && !canManage) { this.sendJson(res, 403, { ok: false, error: '仅项目 owner 或平台管理员可添加成员' }); return true }
          if (!this.isProjectOwner(proj)) { this.sendJson(res, 403, { ok: false, error: '仅项目 owner 或平台管理员可添加成员' }); return true }
          if (WorkBuddyRouter.archivedBlocked(proj)) { this.sendJson(res, 400, { ok: false, error: '项目已归档（只读），请先恢复再添加成员' }); return true }
          const body = await this.parseBody(req)
          const raw = String(body?.userId || body?.username || '').trim()
          const user = this.auth ? (raw.startsWith('usr-') ? this.auth.getUserById(raw) : (this.auth.getUserByUsername(raw) || this.auth.describeUser(raw) && this.auth.getUserById(this.auth.describeUser(raw)!.id))) : undefined
          if (!user) { this.sendJson(res, 404, { ok: false, error: '用户不存在（仅已激活账号可作为项目成员）' }); return true }
          if (user.status !== 'active') { this.sendJson(res, 400, { ok: false, error: '该用户尚未激活（invited/disabled）' }); return true }
          if ((proj.projectMembers || []).some((m) => m.userId === user.id)) { this.sendJson(res, 409, { ok: false, error: '该用户已是项目成员' }); return true }
          const role: 'owner' | 'member' = body?.role === 'owner' ? 'owner' : 'member'
          const saved = this.store.upsertProject({
            id: proj.id,
            owner: proj.owner || (role === 'owner' ? user.id : undefined),
            projectMembers: [...(proj.projectMembers || []), { userId: user.id, role, joinedAt: Date.now(), invitedBy: this.session?.userId }],
          })
          this.audit('project.member.add', 'project', proj.id, `${user.id}（${role}）`)
          this.sendJson(res, 200, { ok: true, data: { members: saved.projectMembers } })
          return true
        }
      }
    }

    // ---------- 项目归档/恢复（P-08，owner 或平台管理员） ----------
    const projArchiveMatch = /^\/api\/projects\/([^/]+)\/(archive|restore)$/.exec(p)
    if (projArchiveMatch && method === 'POST') {
      const proj = this.store.getProject(decodeURIComponent(projArchiveMatch[1]))
      if (!proj || !this.canSeeProject(proj)) { this.sendJson(res, 404, { ok: false, error: '项目不存在' }); return true }
      if (!this.isProjectOwner(proj)) { this.sendJson(res, 403, { ok: false, error: '仅项目 owner 或平台管理员可归档/恢复项目' }); return true }
      const kind = projArchiveMatch[2]
      if (kind === 'archive' && proj.archivedAt) { this.sendJson(res, 400, { ok: false, error: '项目已处于归档态' }); return true }
      if (kind === 'restore' && !proj.archivedAt) { this.sendJson(res, 400, { ok: false, error: '项目未处于归档态' }); return true }
      const saved = this.store.upsertProject({ id: proj.id, archivedAt: kind === 'archive' ? Date.now() : null })
      this.audit(kind === 'archive' ? 'project.archive' : 'project.restore', 'project', proj.id, proj.name)
      this.sendJson(res, 200, { ok: true, data: this.projectSummary(saved) })
      return true
    }

    // ---------- owner 转让（P-07）：当前 owner → 目标成员；请求者是成员则同步降为 member ----------
    const projTransferMatch = /^\/api\/projects\/([^/]+)\/ownership-transfer$/.exec(p)
    if (projTransferMatch && method === 'POST') {
      const proj = this.store.getProject(decodeURIComponent(projTransferMatch[1]))
      if (!proj || !this.canSeeProject(proj)) { this.sendJson(res, 404, { ok: false, error: '项目不存在' }); return true }
      if (!this.isProjectOwner(proj)) { this.sendJson(res, 403, { ok: false, error: '仅项目 owner 或平台管理员可转让项目' }); return true }
      if (WorkBuddyRouter.archivedBlocked(proj)) { this.sendJson(res, 400, { ok: false, error: '项目已归档（只读），请先恢复再转让' }); return true }
      const body = await this.parseBody(req)
      const targetUserId = String(body?.targetMemberId || '').trim()
      const target = (proj.projectMembers || []).find((m) => m.userId === targetUserId)
      if (!target) { this.sendJson(res, 404, { ok: false, error: '目标成员不存在' }); return true }
      if (target.role === 'owner' && proj.owner === targetUserId) { this.sendJson(res, 400, { ok: false, error: '该成员已是项目 owner' }); return true }
      const members = (proj.projectMembers || []).map((m) => {
        if (m.userId === targetUserId) return { ...m, role: 'owner' as const }
        // 请求者是普通成员身份的 owner（且项目仅此一个 owner）时，转让后降为 member
        if (m.userId === this.session?.userId && m.role === 'owner') return { ...m, role: 'member' as const }
        return m
      })
      const saved = this.store.upsertProject({ id: proj.id, owner: targetUserId, projectMembers: members })
      this.audit('project.ownership.transfer', 'project', proj.id, `→ ${targetUserId}`)
      this.sendJson(res, 200, { ok: true, data: this.projectSummary(saved) })
      return true
    }

    // ---------- 项目邮件邀请管理（P-04/09，owner 或平台管理员） ----------
    const projInviteMatch = /^\/api\/projects\/([^/]+)\/invitations(?:\/([^/]+)\/(resend|revoke))?$/.exec(p)
    if (projInviteMatch) {
      const proj = this.store.getProject(decodeURIComponent(projInviteMatch[1]))
      if (!proj || !this.canSeeProject(proj)) { this.sendJson(res, 404, { ok: false, error: '项目不存在' }); return true }
      // 邀请创建：owner / 平台管理员 / 开启「成员可邀请」开关的 member（§10.2 allowMemberInvite）
      // 邀请列表与重发/撤销：仍限 owner / 平台管理员
      const isInviteCreate = method === 'POST' && !projInviteMatch[2]
      const inviteAllowed = isInviteCreate
        ? canAccessProject(this.session, proj, 'invite')
        : this.isProjectOwner(proj)
      if (!inviteAllowed) {
        this.sendJson(res, 403, {
          ok: false,
          error: isInviteCreate
            ? '仅项目 owner、平台管理员，或开启「成员可邀请」的成员可邀请他人'
            : '仅项目 owner 或平台管理员可管理项目邀请',
        })
        return true
      }
      const sendProjectInviteMail = async (email: string, role: 'owner' | 'member', token: string) => {
        const inviteLink = `${this.requestBase(req, prefix)}/project-invite?token=${token}`
        if (!this.mail) return { sent: false, status: 'mock' as const, error: '邮件服务不可用', inviteLink }
        const r = await this.mail.sendProjectInviteMail({
          to: email, projectName: proj.name, inviterName: this.session?.displayName || this.session?.username || '',
          role, inviteLink, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000, attempts: 2, timeoutMs: 8000,
        })
        return { sent: r.ok, status: r.status, error: r.error, inviteLink }
      }
      if (projInviteMatch[2]) {
        const invId = decodeURIComponent(projInviteMatch[2])
        if (projInviteMatch[3] === 'resend' && method === 'POST') {
          if (WorkBuddyRouter.archivedBlocked(proj)) { this.sendJson(res, 400, { ok: false, error: '项目已归档（只读）' }); return true }
          const token = this.auth?.resendProjectInvite(proj.id, invId)
          if (!token) { this.sendJson(res, 404, { ok: false, error: '仅待处理邀请可重发' }); return true }
          const inv = (this.auth?.listProjectInvites(proj.id) || []).find((x) => x.id === invId)
          const email = await sendProjectInviteMail(inv?.email || '', inv?.role || 'member', token)
          this.audit('project.invite.resend', 'project', proj.id, inv?.email)
          this.sendJson(res, 200, { ok: true, data: { inviteLink: email.inviteLink, email: { sent: email.sent, status: email.status, error: email.error } } })
          return true
        }
        if (projInviteMatch[3] === 'revoke' && method === 'POST') {
          const ok = this.auth?.revokeProjectInvite(proj.id, invId)
          if (!ok) { this.sendJson(res, 404, { ok: false, error: '仅待处理邀请可撤销' }); return true }
          this.audit('project.invite.revoke', 'project', proj.id, invId)
          this.sendJson(res, 200, { ok: true })
          return true
        }
      } else {
        if (method === 'GET') {
          const list = (this.auth?.listProjectInvites(proj.id) || []).map((x) => ({ ...x, inviterInfo: x.invitedBy ? this.auth?.describeUser(x.invitedBy) || null : null }))
          this.sendJson(res, 200, { ok: true, data: { invitations: list } })
          return true
        }
        if (method === 'POST') {
          if (WorkBuddyRouter.archivedBlocked(proj)) { this.sendJson(res, 400, { ok: false, error: '项目已归档（只读），请先恢复再邀请成员' }); return true }
          const body = await this.parseBody(req)
          const emailRaw = String(body?.email || '').trim()
          const role: 'owner' | 'member' = body?.role === 'owner' ? 'owner' : 'member'
          if (this.mailLimited(req, 'project_invite', emailRaw)) { this.sendJson(res, 429, { ok: false, error: '邀请过于频繁，请 1 小时后再试' }); return true }
          // 已是该邮箱的 active 账号且已在成员中 → 409；pending 已存在 → 409（统一令牌表内校验）
          const existingUser = this.auth?.describeUser(emailRaw) || undefined
          const existingFull = existingUser ? this.auth?.getUserById(existingUser.id) : undefined
          if (existingFull && (proj.projectMembers || []).some((m) => m.userId === existingFull.id)) {
            this.sendJson(res, 409, { ok: false, error: '该用户已是项目成员，无需邀请' }); return true
          }
          const result = this.auth?.createProjectInvite(proj.id, emailRaw, role, this.session?.userId || '')
          if (!result) { this.sendJson(res, 503, { ok: false, error: '认证服务不可用' }); return true }
          if ('conflict' in result) { this.sendJson(res, 409, { ok: false, error: result.conflict }); return true }
          const email = await sendProjectInviteMail(emailRaw, role, result.token)
          this.audit('project.invite.send', 'project', proj.id, `${emailRaw}（${role}）`)
          this.sendJson(res, 201, { ok: true, data: { email: emailRaw, role, emailSent: email.sent, emailStatus: email.status, emailError: email.error, inviteLink: email.inviteLink, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 } })
          return true
        }
      }
    }

    // ---------- Backlog 集成（B1-B7，docs/design-backlog-integration.md §5.2/§6/§7.3） ----------
    // 全部过既有鉴权（外层 dispatch）+ 项目可见性门（canSeeProject）；写操作过归档只读拦截（P-08 语义同 /api/tasks）。
    if (p === '/api/backlog/overview' && method === 'GET') {
      // 聚合与失败隔离逻辑收敛在 backlog-service（工具通道 overview 复用同一实现）；
      // 查询契约见 docs/design-backlog-query-filters.md §4.2：data 仍是项目分组数组（向后兼容），
      // 信封额外带 query / summary / facets。默认不排除已完成（openOnly 才按各项目 statuses 排除）。
      const q = new URL(req.url || '/', 'http://localhost').searchParams
      const parsed = parseBacklogQuery(q)
      if (parsed.errors.length) {
        this.sendJson(res, 400, { ok: false, error: parsed.errors.join('；'), code: 'INVALID_QUERY', errors: parsed.errors })
        return true
      }
      const visible = this.store.getProjects().filter((pr) => this.canSeeProject(pr))
      // projectIds 先筛项目（项目作用域）；条目过滤由 service 逐项目按各自 statuses 应用
      const scoped = parsed.query.projectIds?.length
        ? visible.filter((pr) => parsed.query.projectIds!.includes(pr.id))
        : visible
      const data = await overviewBacklog(
        { client: this.client, store: this.store, resolver: this.resolver },
        scoped,
        { query: parsed.query },
      )
      this.sendJson(res, 200, {
        ok: true,
        data,
        query: parsed.query,
        summary: summarizeBacklogOverview(data),
        facets: mergeBacklogFacets(data.map((row) => row.facets)),
      })
      return true
    }

    if (p.startsWith('/api/projects/') && p.includes('/backlog')) {
      const segs = p.split('/').filter(Boolean) // ['api','projects',<id>,'backlog',...]
      const proj = this.store.getProject(segs[2])
      if (!proj || !this.canSeeProject(proj)) { this.sendJson(res, 404, { ok: false, error: '项目不存在或不可见' }); return true }
      const rest = segs.slice(4)
      const projectId = proj.id
      const readOnly = Boolean(proj.archivedAt)
      const rejectArchived = () => {
        this.sendJson(res, 400, { ok: false, error: '项目已归档（只读），请先恢复再操作 backlog' })
      }
      const nodeCtx = async (): Promise<{ ok: true; target: any; workspace: string } | { ok: false; status: number; error: string }> => {
        if (!proj.workspace) return { ok: false, status: 400, error: '项目未配置工作目录（workspace），无法使用 backlog' }
        const target = await this.resolver.resolveRef(proj.dshRef, proj.apiKey, 'project-backlog')
        if (!target.online || !target.baseUrl) return { ok: false, status: 502, error: target.error || '节点不可达' }
        return { ok: true, target, workspace: proj.workspace }
      }
      try {
        // GET 列表（读：归档项目也允许只读查看）；查询契约见 docs/design-backlog-query-filters.md §4.1：
        // 先取全量条目（ready/blocked 判依赖需要全量语料），再用查询引擎过滤/排序/切窗。
        // 旧参数 ?orderBy=&order= 由 parseBacklogQuery 归一为 sort/order，继续可用。
        if (rest.length === 0 && method === 'GET') {
          const ctx = await nodeCtx()
          if (!ctx.ok) { this.sendJson(res, ctx.status, { ok: false, error: ctx.error }); return true }
          const parsed = parseBacklogQuery(new URL(req.url || '/', 'http://localhost').searchParams)
          if (parsed.errors.length) {
            this.sendJson(res, 400, { ok: false, error: parsed.errors.join('；'), code: 'INVALID_QUERY', errors: parsed.errors })
            return true
          }
          const list = await listBacklogWithTasks(
            { client: this.client, store: this.store },
            ctx.target,
            ctx.workspace,
            projectId,
          )
          const result = applyBacklogQuery(list.items, parsed.query, { statuses: list.config.statuses })
          this.sendJson(res, 200, {
            ok: true,
            data: {
              ...list,
              // 覆盖 list.items：过滤/排序/切窗后的条目（带 isReady 等派生字段，searchText 已剥离）
              items: stripBacklogSearchText(result.items),
              total: result.total,
              matched: result.matched,
              counts: result.counts,
              window: result.window,
              facets: result.facets,
              query: parsed.query,
              archived: readOnly,
              statuses: list.config.statuses,
              defaultStatus: list.config.defaultStatus,
              instructionSnippet: backlogInstructionSnippet(),
            },
          })
          return true
        }
        // POST 未完成事项采集（简版：A 任务账本 + B 工作区代码/文档确定性扫描）
        // mode=preview（缺省）：只算候选、不写节点；mode=create：按 keys 落盘为 backlog 待办（keys 省略 = 全建）。
        // 幂等靠条目正文 sourceKey 对账 —— 重复点击不会重复登记；docs/design-backlog-auto-collect.md
        if (rest.length === 1 && rest[0] === 'collect' && method === 'POST') {
          if (readOnly) { rejectArchived(); return true }
          const body = await this.parseBody(req)
          const mode = body?.mode === 'create' ? 'create' : 'preview'
          const ctx = await nodeCtx()
          if (!ctx.ok) { this.sendJson(res, ctx.status, { ok: false, error: ctx.error }); return true }
          if (mode === 'preview') {
            const data = await previewProjectCollect(this.client, this.store, proj, ctx.target, ctx.workspace)
            this.audit('backlog.collect.preview', 'project', projectId, `candidates=${data.candidates.length}`)
            this.sendJson(res, 200, { ok: true, data })
            return true
          }
          const keys = Array.isArray(body?.keys) ? body.keys.map(String).filter(Boolean) : undefined
          const data = await applyProjectCollect(this.client, this.store, proj, ctx.target, ctx.workspace, keys)
          this.audit('backlog.collect', 'project', projectId, `created=${data.created.length}/${data.candidates}`)
          this.sendJson(res, 200, { ok: true, data })
          return true
        }
        // POST 初始化（途径 A，幂等）
        if (rest.length === 1 && rest[0] === 'init' && method === 'POST') {
          if (readOnly) { rejectArchived(); return true }
          const body = await this.parseBody(req)
          const ctx = await nodeCtx()
          if (!ctx.ok) { this.sendJson(res, ctx.status, { ok: false, error: ctx.error }); return true }
          const out = await initBacklog(this.client, ctx.target, ctx.workspace, { projectName: proj.name, sample: Boolean(body?.sample) })
          if (body?.updateInstruction && !`${proj.instruction || ''}`.includes('## Backlog 待办协作约定')) {
            this.store.upsertProject({ id: projectId, instruction: `${proj.instruction ? proj.instruction + '\n\n' : ''}${backlogInstructionSnippet()}` } as any)
          }
          this.audit('backlog.init', 'project', projectId, `sample=${Boolean(body?.sample)}`)
          this.sendJson(res, 200, { ok: true, data: out })
          return true
        }
        // POST 新建
        if (rest.length === 1 && rest[0] === 'items' && method === 'POST') {
          if (readOnly) { rejectArchived(); return true }
          const body = await this.parseBody(req)
          if (!String(body?.title || '').trim()) { this.sendJson(res, 400, { ok: false, error: '标题必填' }); return true }
          const ctx = await nodeCtx()
          if (!ctx.ok) { this.sendJson(res, ctx.status, { ok: false, error: ctx.error }); return true }
          const item = await createItem(this.client, ctx.target, ctx.workspace, {
            title: String(body.title).trim(),
            description: body.description ? String(body.description) : undefined,
            acceptance: Array.isArray(body.acceptance) ? body.acceptance.map(String).filter(Boolean) : undefined,
            labels: Array.isArray(body.labels) ? body.labels.map(String).filter(Boolean) : undefined,
            dependencies: Array.isArray(body.dependencies) ? body.dependencies.map(String).filter(Boolean) : undefined,
            assignees: Array.isArray(body.assignees) ? body.assignees.map(String).filter(Boolean) : undefined,
            priority: body.priority ? String(body.priority) : undefined,
            dueDate: body.dueDate ? String(body.dueDate) : undefined,
          })
          this.audit('backlog.create', 'project', projectId, item.itemId)
          this.sendJson(res, 201, { ok: true, data: item })
          return true
        }
        // POST 批量派发
        if (rest.length === 1 && rest[0] === 'dispatch-batch' && method === 'POST') {
          if (readOnly) { rejectArchived(); return true }
          const body = await this.parseBody(req)
          const itemIds = Array.isArray(body?.itemIds) ? body.itemIds.map(String) : []
          if (!itemIds.length) { this.sendJson(res, 400, { ok: false, error: 'itemIds 不能为空' }); return true }
          const ctx = await nodeCtx()
          if (!ctx.ok) { this.sendJson(res, ctx.status, { ok: false, error: ctx.error }); return true }
          const results: Array<{ itemId: string; ok: boolean; taskId?: string; error?: string }> = []
          for (const itemId of itemIds) {
            try {
              const r = await this.dispatchBacklogItem(proj, ctx.target, ctx.workspace, itemId, { force: Boolean(body?.force) })
              results.push({ itemId, ok: true, taskId: r.task.id })
            } catch (err: any) {
              results.push({ itemId, ok: false, error: String(err?.message || err).slice(0, 200) })
            }
          }
          this.audit('backlog.dispatch-batch', 'project', projectId, `${results.filter((r) => r.ok).length}/${results.length}`)
          this.sendJson(res, 200, { ok: true, data: results })
          return true
        }
        // /items/<itemId>[/<action>]
        if (rest.length >= 2 && rest[0] === 'items') {
          const itemId = decodeURIComponent(rest[1])
          const action = rest[2] || ''
          const ctx = await nodeCtx()
          if (!ctx.ok) { this.sendJson(res, ctx.status, { ok: false, error: ctx.error }); return true }
          const found = await findItem(this.client, ctx.target, ctx.workspace, itemId)
          if (!found) { this.sendJson(res, 404, { ok: false, error: `待办 ${itemId} 不存在` }); return true }
          const { item } = found
          if (!action && method === 'GET') {
            const raw = await readItem(this.client, ctx.target, ctx.workspace, item.fileName)
            const linked = this.store.getTasks()
              .filter((t) => t.backlogRef?.projectId === projectId && normalizeItemId(t.backlogRef!.itemId) === normalizeItemId(item.itemId))
              .sort((a, b) => b.updatedAt - a.updatedAt)
            this.sendJson(res, 200, {
              ok: true,
              // searchText 是服务端检索语料，任何回包都不得携带
              data: { item: stripBacklogItemSearchText(item), raw, statuses: found.list.config.statuses, tasks: linked.map((t) => ({ id: t.id, status: t.status, summaryStatus: t.summary?.status || '', summary: t.summary ? { overview: t.summary.overview, finalConclusion: t.summary.finalConclusion, completedAt: t.summary.completedAt } : null, writebackFailed: t.backlogWritebackFailed || null, updatedAt: t.updatedAt })) },
            })
            return true
          }
          if (!action && (method === 'PUT' || method === 'PATCH')) {
            if (readOnly) { rejectArchived(); return true }
            const body = await this.parseBody(req)
            const raw = await readItem(this.client, ctx.target, ctx.workspace, item.fileName)
            let next = encodeFrontmatter(raw, {
              title: body?.title !== undefined ? String(body.title).trim() : undefined,
              status: body?.status !== undefined ? String(body.status) : undefined,
              priority: body?.priority !== undefined ? String(body.priority) : undefined,
              dueDate: body?.dueDate !== undefined ? String(body.dueDate) : undefined,
              ordinal: body?.ordinal !== undefined ? Number(body.ordinal) : undefined,
              labels: Array.isArray(body?.labels) ? body.labels.map(String).filter(Boolean) : undefined,
              dependencies: Array.isArray(body?.dependencies) ? body.dependencies.map(String).filter(Boolean) : undefined,
              assignees: Array.isArray(body?.assignees) ? body.assignees.map(String).filter(Boolean) : undefined,
            })
            if (typeof body?.description === 'string') next = replaceDescription(next, body.description)
            if (Array.isArray(body?.acceptance)) next = replaceAcceptance(next, body.acceptance.map(String))
            await writeItem(this.client, ctx.target, ctx.workspace, item.fileName, () => next, { base: raw })
            this.audit('backlog.edit', 'project', projectId, item.itemId)
            this.sendJson(res, 200, { ok: true, data: { itemId: item.itemId } })
            return true
          }
          if (!action && method === 'DELETE') {
            if (readOnly) { rejectArchived(); return true }
            await deleteItem(this.client, ctx.target, ctx.workspace, item.fileName)
            this.audit('backlog.delete', 'project', projectId, item.itemId)
            this.sendJson(res, 200, { ok: true })
            return true
          }
          if (action === 'dispatch' && method === 'POST') {
            if (readOnly) { rejectArchived(); return true }
            const body = await this.parseBody(req)
            const r = await this.dispatchBacklogItem(proj, ctx.target, ctx.workspace, item.itemId, { force: Boolean(body?.force), instruction: body?.instruction ? String(body.instruction) : undefined })
            this.audit('backlog.dispatch', 'project', projectId, `${item.itemId} → ${r.task.id}`)
            this.sendJson(res, 200, { ok: true, data: r })
            return true
          }
        }
        // POST 重试回写：/backlog/retry-writeback/<taskId>
        if (rest.length === 2 && rest[0] === 'retry-writeback' && method === 'POST') {
          if (readOnly) { rejectArchived(); return true }
          const task = this.store.getTask(rest[1])
          if (!task || task.backlogRef?.projectId !== projectId) { this.sendJson(res, 404, { ok: false, error: '任务不存在或无 backlog 来源' }); return true }
          try {
            await this.engine.runBacklogWriteback(task)
            this.sendJson(res, 200, { ok: true })
          } catch (err: any) {
            // 统一走引擎的失败记账：失败标记 + 退避计数推进（TASK-2 补偿器共用同一退避序列）
            this.engine.recordWritebackFailure(task.id, err)
            this.sendJson(res, 502, { ok: false, error: String(err?.message || err).slice(0, 300) })
          }
          return true
        }
      } catch (err: any) {
        const conflict = err?.name === 'BacklogConflictError'
        this.sendJson(res, conflict ? 409 : err?.status && Number(err.status) >= 400 ? Number(err.status) : 400, { ok: false, error: String(err?.message || err), code: conflict ? 'CONFLICT' : err?.code || undefined })
        return true
      }
    }

    // ---------- 审计日志查询（B-03，平台管理员） ----------
    if (p === '/api/audit-log' && method === 'GET') {
      if (!this.isPlatformAdmin()) { this.sendJson(res, 403, { ok: false, error: '需要管理员权限' }); return true }
      const url = new URL(req.url || '/', 'http://localhost')
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100))
      this.sendJson(res, 200, { ok: true, data: this.auditLog?.list(limit) || [] })
      return true
    }

    // ---------- 用户管理（平台管理员） ----------
    if (p === '/api/users' && method === 'GET') {
      if (!this.isPlatformAdmin()) { this.sendJson(res, 403, { ok: false, error: '需要管理员权限' }); return true }
      const url = new URL(req.url || '/', 'http://localhost')
      this.sendJson(res, 200, { ok: true, data: this.auth?.listUsers({
        status: url.searchParams.get('status') || undefined,
        role: url.searchParams.get('role') || undefined,
        q: url.searchParams.get('q') || undefined,
      }) || [] })
      return true
    }
    if (p === '/api/users/lookup' && method === 'GET') {
      // 登录用户可用：添加项目成员时的用户搜索（仅最小字段）
      const url = new URL(req.url || '/', 'http://localhost')
      const q = (url.searchParams.get('q') || '').trim().toLowerCase()
      const all = this.auth?.listActiveUsers() || []
      const filtered = q ? all.filter((u) => u.username.toLowerCase().includes(q) || (u.displayName || '').toLowerCase().includes(q)) : all
      this.sendJson(res, 200, { ok: true, data: filtered.slice(0, 50).map((u) => ({ id: u.id, username: u.username, displayName: u.displayName })) })
      return true
    }
    if (p === '/api/users' && method === 'POST') {
      if (!this.isPlatformAdmin()) { this.sendJson(res, 403, { ok: false, error: '需要管理员权限' }); return true }
      const body = await this.parseBody(req)
      const emailRaw = String(body?.email || '')
      if (this.mailLimited(req, 'user_invite', emailRaw)) { this.sendJson(res, 429, { ok: false, error: '邀请过于频繁，请 1 小时后再试' }); return true }
      const result = this.auth?.createUserInvite(emailRaw, String(body?.displayName || ''))
      if (!result) { this.sendJson(res, 503, { ok: false, error: '认证服务不可用' }); return true }
      if ('conflict' in result) { this.sendJson(res, 409, { ok: false, error: result.conflict }); return true }
      this.audit('user.invite', 'user', result.user.id, result.user.username)
      const inviteLink = `${this.requestBase(req, prefix)}/invite?token=${result.token}`
      // 邀请邮件自动发送（已配置 SMTP 时）；失败/mock 不阻塞创建，inviteLink 始终返回供手动发送
      const email = await this.sendInviteEmail(result.user.username, result.user.displayName, inviteLink, Date.now() + 72 * 60 * 60 * 1000)
      this.sendJson(res, 201, { ok: true, data: { userId: result.user.id, username: result.user.username, inviteLink, email, expiresAt: Date.now() + 72 * 60 * 60 * 1000 } })
      return true
    }
    if (p === '/api/users/mail-status' && method === 'GET') {
      if (!this.isPlatformAdmin()) { this.sendJson(res, 403, { ok: false, error: '需要管理员权限' }); return true }
      this.sendJson(res, 200, { ok: true, data: this.mail?.status() || { configured: false, recent: [] } })
      return true
    }
    // 个人资料（U-12）：改自己的显示名（改邮箱涉及验证，暂不开放）
    if (p === '/api/users/me/profile' && method === 'PUT') {
      const body = await this.parseBody(req)
      const uid = this.session?.userId
      if (!uid) { this.sendJson(res, 401, { ok: false, error: '未登录' }); return true }
      const ok = this.auth?.setDisplayName(uid, String(body?.displayName || ''))
      if (!ok) { this.sendJson(res, 404, { ok: false, error: '用户不存在' }); return true }
      const u = this.auth?.getUserById(uid)
      this.audit('user.profile.update', 'user', uid, String(body?.displayName || ''))
      this.sendJson(res, 200, { ok: true, data: { id: u?.id, username: u?.username, displayName: u?.displayName } })
      return true
    }
    const userActionMatch = /^\/api\/users\/([^/]+)(?:\/([a-z-]+))?$/.exec(p)
    if (userActionMatch) {
      if (!this.isPlatformAdmin()) { this.sendJson(res, 403, { ok: false, error: '需要管理员权限' }); return true }
      const userId = decodeURIComponent(userActionMatch[1])
      const action = userActionMatch[2]
      if (!action && method === 'PUT') {
        const body = await this.parseBody(req)
        if (body?.displayName !== undefined) this.auth?.setDisplayName(userId, String(body.displayName))
        if (body?.role !== undefined) {
          const r = this.auth?.setRole(userId, body.role === 'admin' ? 'admin' : 'user')
          if (r && !r.ok) { this.sendJson(res, 422, { ok: false, error: r.error }); return true }
          if (r?.ok) this.audit('user.role', 'user', userId, body.role === 'admin' ? 'admin' : 'user')
        }
        const u = this.auth?.getUserById(userId)
        if (!u) { this.sendJson(res, 404, { ok: false, error: '用户不存在' }); return true }
        this.sendJson(res, 200, { ok: true, data: { id: u.id, username: u.username, displayName: u.displayName, role: u.role, status: u.status } })
        return true
      }
      if (action === 'resend-invite' && method === 'POST') {
        const token = this.auth?.resendInvite(userId)
        if (!token) { this.sendJson(res, 404, { ok: false, error: '仅 invited 用户可重发邀请' }); return true }
        const inviteLink = `${this.requestBase(req, prefix)}/invite?token=${token}`
        const target = this.auth?.getUserById(userId)
        const email = await this.sendInviteEmail(target?.username || '', target?.displayName, inviteLink, Date.now() + 72 * 60 * 60 * 1000)
        this.sendJson(res, 200, { ok: true, data: { inviteLink, email } })
        return true
      }
      if (action === 'revoke-invite' && method === 'POST') {
        const ok = this.auth?.revokeUserInvite(userId)
        if (!ok) { this.sendJson(res, 404, { ok: false, error: '仅 invited 用户可撤销邀请' }); return true }
        this.audit('user.invite.revoke', 'user', userId)
        this.sendJson(res, 200, { ok: true })
        return true
      }
      if ((action === 'disable' || action === 'enable') && method === 'POST') {
        const r = this.auth?.setUserStatus(userId, action === 'disable' ? 'disabled' : 'active')
        if (!r) { this.sendJson(res, 503, { ok: false, error: '认证服务不可用' }); return true }
        if (!r.ok) { this.sendJson(res, 422, { ok: false, error: r.error }); return true }
        this.audit(action === 'disable' ? 'user.disable' : 'user.enable', 'user', userId)
        this.sendJson(res, 200, { ok: true })
        return true
      }
      if (!action && method === 'DELETE') {
        const r = this.auth?.softDeleteUser(userId)
        if (!r) { this.sendJson(res, 503, { ok: false, error: '认证服务不可用' }); return true }
        if (!r.ok) { this.sendJson(res, 422, { ok: false, error: r.error }); return true }
        this.audit('user.delete', 'user', userId)
        this.sendJson(res, 200, { ok: true })
        return true
      }
    }

    // ---------- 监控大屏（只读聚合；§11 仅平台管理员，AI 工具通道白名单内保持开放） ----------
    if (this.monitor && p === '/api/monitor/overview' && method === 'GET') {
      if (!this.isAdminOrServiceChannel()) { this.denyNotAdmin(res, '查看监控大屏'); return true }
      try {
        const overview = await this.monitor.getOverview()
        const q = new URL(req.url || '/', 'http://localhost').searchParams
        const options = Object.fromEntries(['projectId', 'section', 'compact', 'limit'].filter(k => q.has(k)).map(k => [k, q.get(k)]))
        const data = queryMonitorOverview(overview, options, {
          projects: this.store.getProjects().filter(p => !this.session || this.canSeeProject(p)),
          tasks: this.store.getTasks().filter(t => !this.session || canViewTask(this.session, t, this.permContext())),
        })
        this.sendJson(res, 200, { ok: true, data })
      } catch (err: any) {
        this.sendJson(res, err.status || 500, { ok: false, error: err?.message || String(err) })
      }
      return true
    }
    if (this.monitor && p === '/api/monitor/events' && method === 'GET') {
      if (!this.isAdminOrServiceChannel()) { this.denyNotAdmin(res, '查看监控大屏'); return true }
      const url = new URL(req.url || '/', 'http://localhost')
      const limit = Number(url.searchParams.get('limit') || 200)
      this.sendJson(res, 200, { ok: true, data: this.monitor.getRecentEvents(limit) })
      return true
    }
    if (this.monitor && p === '/api/monitor/history' && method === 'GET') {
      if (!this.isAdminOrServiceChannel()) { this.denyNotAdmin(res, '查看监控大屏'); return true }
      const url = new URL(req.url || '/', 'http://localhost')
      const days = Number(url.searchParams.get('days') || 7)
      this.sendJson(res, 200, { ok: true, data: { days: this.monitor.readHistory(days) } })
      return true
    }

    // ---------- Token 消耗明细报表（只读归因聚合；§11 全局报表仅管理员） ----------
    if (p === '/api/usage/tokens/summary' && method === 'GET') {
      if (!this.isAdminOrServiceChannel()) { this.denyNotAdmin(res, '查看全局 Token 用量'); return true }
      const url = new URL(req.url || '/', 'http://localhost')
      const { from, to } = parseUsageRange(url)
      this.sendJson(res, 200, { ok: true, data: this.usage.summary(from, to) })
      return true
    }
    if (p === '/api/usage/tokens/records' && method === 'GET') {
      // 带 taskId = 任务内「Token 明细」（S2-1，日常功能）：随任务可见性（§11 canViewTask）；
      // 不带 taskId = 跨用户全局报表，仅平台管理员
      const isPerTask = Boolean(new URL(req.url || '/', 'http://localhost').searchParams.get('taskId'))
      if (isPerTask) {
        const tid = new URL(req.url || '/', 'http://localhost').searchParams.get('taskId') || ''
        if (!this.taskForView(tid)) { this.sendJson(res, 404, { ok: false, error: 'Task not found' }); return true }
      } else if (!this.isAdminOrServiceChannel()) {
        this.denyNotAdmin(res, '查看全局 Token 用量')
        return true
      }
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
        // 微缓存 1.5s：多标签页秒级轮询（实测 2-3 次/秒）共享同一响应，
        // probeAllDsh 也随之折叠 —— 否则轮询风暴会放大引擎探测与凭证预算消耗
        const cached = this.resourcesCache
        if (cached && Date.now() - cached.at < 1500) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(cached.body)
          return true
        }
        const snap = await this.directory.refresh(false)
        // 后台预热引擎探测（TTL 内不重复打节点）；响应不等它 —— 首屏拿到 endpoints，
        // 探测完成后前端经 /api/resources/probe 增量补 engine 字段
        void this.directory.probeAllDsh().catch(() => {})
        const body = JSON.stringify({
          ok: true,
          data: {
            fetchedAt: snap.fetchedAt,
            configured: this.directory.configured,
            baseUrl: this.directory.endpoint,
            endpoints: this.attachEngine(this.directory.listEndpoints()),
          },
        })
        this.resourcesCache = { at: Date.now(), body }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(body)
      } catch (err: any) {
        this.sendJson(res, 200, { ok: false, error: err?.message || String(err), data: { configured: this.directory.configured, endpoints: [] } })
      }
      return true
    }
    if (p === '/api/resources/refresh' && method === 'POST') {
      try {
        this.resourcesCache = undefined
        const snap = await this.directory.refresh(true)
        this.sendJson(res, 200, { ok: true, data: { fetchedAt: snap.fetchedAt, endpoints: this.attachEngine(this.directory.listEndpoints()) } })
      } catch (err: any) {
        this.sendJson(res, 502, { ok: false, error: err?.message || String(err) })
      }
      return true
    }
    // 引擎探测：对全部 DSH 映射探引擎身份/健康/默认模型（force=true 绕过 TTL）。
    // 前端打开节点下拉时调用（默认 TTL 门控），探测后按 mappingId 合并回 state.resources
    if (p === '/api/resources/probe' && method === 'POST') {
      try {
        const body = await this.parseBody(req).catch(() => ({} as any))
        const eps = this.directory.listDshEndpoints()
        const infos = await Promise.all(eps.map((ep) => this.directory.probeEngine(ep, { force: Boolean(body?.force) }).catch((err) => ({ engine: 'unknown' as const, reachable: false, error: err?.message || '探测失败', probedAt: Date.now() }))))
        this.sendJson(res, 200, {
          ok: true,
          data: {
            engines: eps.map((ep, i) => ({ mappingId: ep.mappingId, appName: ep.appName, tunnelName: ep.tunnelName, engine: infos[i] })),
          },
        })
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
        this.sendJson(res, 200, { ok: false, error: `节点「${ep.appName || mappingId}」当前离线` })
        return true
      }
      const cred = await this.directory.fetchMappingCredentials(mappingId).catch(() => undefined)
      const key = cred?.ok ? (cred.apiKey || cred.token || undefined) : undefined
      const client = new DshClient()
      const r = await client.getModels({ baseUrl: ep.baseUrl, apiKey: key })
      this.sendJson(res, 200, { ok: r.ok, nodeTitle: ep.appName || mappingId, models: r.models, defaultModel: r.defaultModel, error: r.error })
      return true
    }
    // ---------- 按节点拉取远端工作区列表（项目「从远程 DSH 导入」的数据源） ----------
    if (p === '/api/dsh-workspaces' && method === 'GET') {
      const mappingId = String(urlObj.searchParams.get('node') || '').trim()
      const ep = mappingId ? this.directory.resolveMapping(mappingId) : undefined
      if (!mappingId || !ep) {
        this.sendJson(res, 200, { ok: false, error: '节点不存在: ' + mappingId })
        return true
      }
      if (!ep.online || !ep.baseUrl) {
        this.sendJson(res, 200, { ok: false, error: `节点「${ep.appName || mappingId}」当前离线` })
        return true
      }
      const cred = await this.directory.fetchMappingCredentials(mappingId).catch(() => undefined)
      const key = cred?.ok ? (cred.apiKey || cred.token || undefined) : undefined
      const client = new DshClient()
      const r = await client.listWorkspaces({ baseUrl: ep.baseUrl, apiKey: key })
      this.sendJson(res, 200, {
        ok: r.ok,
        nodeTitle: ep.appName || mappingId,
        workspaces: r.workspaces,
        error: r.error,
      })
      return true
    }
    if (p === '/api/schedules' && method === 'GET') {
      // §11：列表按可见性过滤（归属人/admin；存量=全员）
      const list = this.store.getSchedules().filter((s) => canViewSchedule(this.session, s)).map((s) => this.scheduleSummary(s))
      this.sendJson(res, 200, { ok: true, data: list })
      return true
    }
    if (p === '/api/schedules' && method === 'POST') {
      const body = await this.parseBody(req)
      try {
        const saved = this.upsertScheduleFromInput(body, { ownerUserId: this.session?.userId })
        this.audit('schedule.create', 'schedule', saved.id, saved.name)
        this.sendJson(res, 200, { ok: true, data: this.scheduleSummary(saved) })
      } catch (err: any) {
        this.sendJson(res, 400, { ok: false, error: err?.message || String(err) })
      }
      return true
    }
    // ---------- 定时任务 Ping 探活 / 提示词预览（表单即时快照，未保存也可用） ----------
    if (p === '/api/schedules/ping' && method === 'POST') {
      const body = await this.parseBody(req)
      const nodeMappingId = String(body?.nodeMappingId || '').trim()
      const agentIds = Array.isArray(body?.agentIds) ? (body.agentIds as any[]).map(String) : []
      try {
        await this.directory.refresh(true)
      } catch {
        /* 无网时用缓存 */
      }
      type PingResult = { ok: boolean; name?: string; version?: string; error?: string }
      const out: { nodeTitle?: string; nodePing?: PingResult; agents: Array<{ id: string; name: string; ping: PingResult }> } = { agents: [] }
      if (nodeMappingId) {
        const ep = this.directory.resolveMapping(nodeMappingId)
        out.nodeTitle = ep?.appName || nodeMappingId
        const target = await this.resolver.resolveRef({ kind: 'mapping', mappingId: nodeMappingId }, undefined, 'schedule-node')
        out.nodePing = target.online && target.baseUrl
          ? await this.client.ping(target)
          : { ok: false, error: target.error || '节点不可达' }
      }
      for (const aid of agentIds) {
        const a = this.store.getAgent(aid)
        if (!a) {
          out.agents.push({ id: aid, name: aid, ping: { ok: false, error: '子智能体不存在' } })
          continue
        }
        const { ping } = await this.resolver.resolveWithPing(a)
        out.agents.push({ id: a.id, name: a.name, ping: ping || { ok: false, error: '解析失败' } })
      }
      this.sendJson(res, 200, { ok: true, data: out })
      return true
    }
    if (p === '/api/schedules/prompt-preview' && method === 'POST') {
      // 请求体 = 定时任务表单的即时快照（未保存也可预览）；不落库、不校验调度规则
      const body = await this.parseBody(req)
      const message = String(body?.message || '').trim()
      if (!message) {
        this.sendJson(res, 400, { ok: false, error: '任务文本为空，无法预览派发提示词' })
        return true
      }
      const nodeMappingId = String(body?.nodeMappingId || '').trim()
      const workDir = String(body?.workDir || '').trim()
      const model = String(body?.model || '').trim()
      const skills = Array.isArray(body?.skills)
        ? Array.from(new Set((body.skills as any[]).map((s) => String(s).trim()).filter(Boolean)))
        : []
      try {
        await this.directory.refresh(true)
      } catch {
        /* 无网时用缓存 */
      }
      const nodeRef: DshRef | undefined = nodeMappingId ? { kind: 'mapping', mappingId: nodeMappingId } : undefined
      // 主会话注入块：对齐 engine.runChatTurn 真实派发（定时任务 = 无人值守 + extraSkills=实例技能）
      const now = Date.now()
      const nodeAgent: SubAgent = {
        id: NODE_AGENT_ID,
        name: MAIN_AGENT_LABEL,
        role: '主智能体（任务发起节点主会话）',
        dshRef: nodeRef || { kind: 'direct', apiBaseUrl: '' },
        resources: [],
        skills: [],
        enabled: true,
        createdAt: now,
        updatedAt: now,
      }
      const mainComposed = await this.composer.compose(nodeAgent, { resolvedAt: now, mask: true, extraSkills: skills, interaction: 'unattended' })
      // 被 @ 的子智能体：与真实派发同源（extractMentions），注入块含各自资源绑定 + 实例技能
      const agentsOut: Array<{ id: string; name: string; role: string; resourceBlock: string; warnings: string[] }> = []
      let mentionError: string | undefined
      try {
        const mentions = await this.engine.extractMentions(message)
        for (const aid of mentions.mentionedAgentIds) {
          const a = this.store.getAgent(aid)
          if (!a) continue
          const c = await this.composer.compose(a, { resolvedAt: now, mask: true, extraSkills: skills, interaction: 'unattended' })
          agentsOut.push({ id: a.id, name: a.name, role: a.role || '', resourceBlock: c.block, warnings: c.warnings })
        }
      } catch (err: any) {
        mentionError = err?.message || String(err)
      }
      this.sendJson(res, 200, {
        ok: true,
        data: {
          message,
          nodeTitle: nodeMappingId ? (this.directory.resolveMapping(nodeMappingId)?.appName || nodeMappingId) : '',
          model,
          workDir,
          skills,
          guard: interactionGuard('unattended'),
          main: { resourceBlock: mainComposed.block, warnings: mainComposed.warnings },
          agents: agentsOut,
          mentionError,
        },
      })
      return true
    }
    const schedMatch = /^\/api\/schedules\/([^/]+)$/.exec(p)
    if (schedMatch) {
      const id = decodeURIComponent(schedMatch[1])
      if (method === 'GET') {
        const s = this.store.getSchedule(id)
        // §11：不可见按 404 处理（防枚举）
        if (!s || !canViewSchedule(this.session, s)) {
          this.sendJson(res, 404, { ok: false, error: '定时任务不存在' })
          return true
        }
        this.sendJson(res, 200, { ok: true, data: this.scheduleDetail(s) })
        return true
      }
      if (method === 'DELETE') {
        const s = this.store.getSchedule(id)
        if (!s) {
          this.sendJson(res, 404, { ok: false, error: '定时任务不存在' })
          return true
        }
        // §11：编辑/删除/toggle/run 仅归属人+admin（存量=仅 admin）；不可见统一 404 防枚举
        if (!canViewSchedule(this.session, s)) {
          this.sendJson(res, 404, { ok: false, error: '定时任务不存在' })
          return true
        }
        if (!canManageSchedule(this.session, s)) {
          this.sendJson(res, 403, { ok: false, error: '仅归属人或管理员可删除该定时任务' })
          return true
        }
        const ok = this.store.deleteSchedule(id)
        if (ok) this.audit('schedule.delete', 'schedule', id, s.name)
        this.sendJson(res, 200, { ok: true, data: { deleted: ok } })
        return true
      }
      if (method === 'PATCH' || method === 'PUT') {
        const s = this.store.getSchedule(id)
        if (!s) {
          this.sendJson(res, 404, { ok: false, error: '定时任务不存在' })
          return true
        }
        if (!canViewSchedule(this.session, s)) {
          this.sendJson(res, 404, { ok: false, error: '定时任务不存在' })
          return true
        }
        if (!canManageSchedule(this.session, s)) {
          this.sendJson(res, 403, { ok: false, error: '仅归属人或管理员可编辑该定时任务' })
          return true
        }
        const body = await this.parseBody(req)
        try {
          const saved = this.upsertScheduleFromInput({ ...body, id })
          this.audit('schedule.update', 'schedule', id, saved.name)
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
      if (!canViewSchedule(this.session, s)) {
        this.sendJson(res, 404, { ok: false, error: '定时任务不存在' })
        return true
      }
      if (!canManageSchedule(this.session, s)) {
        this.sendJson(res, 403, { ok: false, error: '仅归属人或管理员可启停该定时任务' })
        return true
      }
      const enabled = !s.enabled
      this.audit('schedule.toggle', 'schedule', id, `${s.name} → ${enabled ? '启用' : '停用'}`)
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
      const sched = this.store.getSchedule(id)
      if (!sched) {
        this.sendJson(res, 404, { ok: false, error: '定时任务不存在' })
        return true
      }
      // §11：手动 run 会派生任务消耗资源，归管理面（仅归属人+admin）
      if (!canViewSchedule(this.session, sched)) {
        this.sendJson(res, 404, { ok: false, error: '定时任务不存在' })
        return true
      }
      if (!canManageSchedule(this.session, sched)) {
        this.sendJson(res, 403, { ok: false, error: '仅归属人或管理员可手动触发该定时任务' })
        return true
      }
      if (!this.scheduler) {
        this.sendJson(res, 500, { ok: false, error: '调度器未装配' })
        return true
      }
      try {
        const run = await this.scheduler.fire(id, true)
        this.audit('schedule.run', 'schedule', id, `${sched.name}（手动触发）`)
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
      const maskedOnenat = { ...s.onenat, apiKey: s.onenat.apiKey ? s.onenat.apiKey.slice(0, 8) + '…' : '' }
      // §11：全局凭证面收敛——AI 工具通道 token 与小智接入点凭证仅平台管理员可见；
      // 其余非敏感配置（base/默认模型/归档天数等）保留给普通用户页面展示
      const data: Record<string, unknown> = this.isAdminOrServiceChannel()
        ? { ...s, onenat: maskedOnenat, aiToken: this.auth?.getAiToken() || '' }
        : { ...s, onenat: maskedOnenat, aiToken: '', xiaozhi: undefined }
      this.sendJson(res, 200, { ok: true, data })
      return true
    }
    // AI 接入安装提示词：服务端统一来源（Web 控制台与安卓客户端共用同一份正文，禁止客户端另拼）
    // 仅控制台登录会话；AI 令牌不在开放面内（由 server.ts 门禁统一回 403）
    if (p === '/api/ai/install-prompt' && method === 'GET') {
      const urlObj = new URL(req.url || '/', 'http://localhost')
      const rawBase = urlObj.searchParams.get('base')
      let base: string
      if (rawBase === null) {
        // 未指定：按本次请求头推导调用方视角基址（反代优先 x-forwarded-*），去尾部 `/`
        base = requestPublicBase(req, prefix).replace(/\/+$/, '')
      } else {
        const normalized = normalizeInstallBase(rawBase)
        if (!normalized) {
          this.sendJson(res, 400, { ok: false, error: 'base 参数非法：需为 http(s):// 绝对地址（长度 ≤512，无控制字符）' })
          return true
        }
        base = normalized
      }
      const token = this.auth?.getAiToken() || ''
      this.sendJson(res, 200, { ok: true, data: buildAiInstallPayload(base, token) })
      return true
    }
    // AI APIKEY 重置（仅平台管理员；旧令牌立即失效，无需重启）
    if (p === '/api/settings/ai-token/reset' && method === 'POST') {
      if (!this.isAdminOrServiceChannel()) { this.denyNotAdmin(res, '重置 AI 接入令牌'); return true }
      if (!this.auth) {
        this.sendJson(res, 500, { ok: false, error: '认证服务未装配' })
        return true
      }
      const token = this.auth.resetAiToken()
      this.audit('settings.ai-token.reset', 'settings', 'ai-token')
      this.sendJson(res, 200, { ok: true, data: { token } })
      return true
    }
    if (p === '/api/settings' && (method === 'POST' || method === 'PUT')) {
      if (!this.isAdminOrServiceChannel()) { this.denyNotAdmin(res, '修改全局设置'); return true }
      const body = await this.parseBody(req)
      const patch: any = {}
      if (body.onenat) {
        patch.onenat = { ...body.onenat }
        if (typeof body.onenat.apiKey === 'string' && body.onenat.apiKey.endsWith('…')) delete patch.onenat.apiKey // 打码值不覆盖
      }
      if (body.planner) patch.planner = body.planner
      if (body.xiaozhi) patch.xiaozhi = body.xiaozhi
      if (body.archive) {
        const days = Math.floor(Number(body.archive?.taskArchiveDays))
        if (!Number.isFinite(days) || days < 0 || days > 36_500) {
          this.sendJson(res, 400, { ok: false, error: '自动归档天数需为 0–36500 的整数（0 = 关闭自动归档）' })
          return true
        }
        patch.archive = { taskArchiveDays: days }
      }
      const updated = this.store.updateSettings(patch)
      this.directory.configure(updated.onenat.baseUrl, updated.onenat.apiKey)
      this.directory.startAutoRefresh(updated.onenat.autoRefreshMs)
      this.resourcesCache = undefined
      // 小智 MCP 接入点变更即时生效（免重启；兼容旧 {endpoint} 与新 {endpoints[]} 两种形状）
      if (patch.xiaozhi) {
        const list = Array.isArray(updated.xiaozhi?.endpoints) && updated.xiaozhi?.endpoints.length
          ? updated.xiaozhi.endpoints
          : (typeof updated.xiaozhi?.endpoint === 'string' && updated.xiaozhi.endpoint
              ? [{ id: 'xz-default', endpoint: updated.xiaozhi.endpoint, enabled: true }]
              : [])
        this.xiaozhi?.configureAll(list as any)
      }
      // 归档天数变更即时生效：不等下一轮 30 分钟周期扫描（天数收窄时立刻归档超期任务；0 = sweep 直接跳过）
      if (patch.archive) void this.store.archiveSweep()
      this.audit('settings.update', 'settings', 'global', Object.keys(patch).join(','))
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
      const entry = await this.registry.get(id)
      if (!entry) {
        this.sendJson(res, 404, { ok: false, error: '专家不存在' })
        return true
      }
      if (!(await this.registry.isEditable(id))) {
        this.sendJson(res, 403, { ok: false, error: '内置/名册专家为只读，仅用户创建的专家可编辑' })
        return true
      }
      // §11：用户专家条目按归属管理（归属人+admin；存量=仅 admin）；花名册查看/召唤全员不变
      if (!canManageOwned(this.session, entry)) {
        this.sendJson(res, 403, { ok: false, error: '仅专家归属人或管理员可编辑该专家' })
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
      const entry = await this.registry.get(id)
      if (!entry) {
        this.sendJson(res, 404, { ok: false, error: '专家不存在' })
        return true
      }
      if (!(await this.registry.isEditable(id))) {
        this.sendJson(res, 403, { ok: false, error: '内置/名册专家为只读，仅用户创建的专家可删除' })
        return true
      }
      // §11：用户专家条目按归属管理（归属人+admin；存量=仅 admin）
      if (!canManageOwned(this.session, entry)) {
        this.sendJson(res, 403, { ok: false, error: '仅专家归属人或管理员可删除该专家' })
        return true
      }
      const deleted = await this.registry.deleteExpert(id)
      if (deleted) this.audit('expert.delete', 'expert', id, entry.name)
      this.sendJson(res, deleted ? 200 : 404, deleted ? { ok: true, data: { deleted: true } } : { ok: false, error: '专家不存在' })
      return true
    }
    // POST /api/experts/:id/instantiate —— 显式语义：由专家档案实例化/更新子智能体
    // （id 来自 URL，body 不携带 systemPrompt，不会被误路由到「创建专家」分支）
    const expertInstantiateMatch = /^\/api\/experts\/([^/]+)\/instantiate$/.exec(p)
    if (expertInstantiateMatch && method === 'POST') {
      return this.instantiateExpertFromRequest(req, res, decodeURIComponent(expertInstantiateMatch[1]))
    }
    // POST /api/experts —— 双语义分发（旧客户端兼容）：
    // ① body 带 systemPrompt（或 kind==='expert'）→ 创建「用户自建专家」（source=user，存 user-experts.json）；
    // ② 其余 → 由专家档案一键创建/更新子智能体（body 必带 { id, dshRef }；来源快照服务端权威记录）
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
          }, { ownerUserId: this.session?.userId })
          this.audit('expert.create', 'expert', saved.id, saved.name)
          this.sendJson(res, 200, { ok: true, data: saved })
        } catch (err: any) {
          this.sendJson(res, 400, { ok: false, error: err?.message || '创建专家失败' })
        }
        return true
      }
      return this.instantiateExpertFromRequest(req, res, String(body?.id ?? body?.expertId ?? '').trim(), body)
    }
    // ---------- 子智能体 ----------
    // Display-only DTOs use an allowlist for every viewer, including administrators.
    if (p === '/api/agents/profiles' && method === 'GET') {
      const ctx = this.permContext()
      const profiles = this.store.getAgents()
        .filter((a) => canViewAgent(this.session, a, ctx))
        .map(agentDisplayProfile)
      this.sendJson(res, 200, { ok: true, data: profiles })
      return true
    }
    const agentProfileMatch = /^\/api\/agents\/([^/]+)\/profile$/.exec(p)
    if (agentProfileMatch && method === 'GET') {
      const agent = this.store.getAgent(decodeURIComponent(agentProfileMatch[1]))
      if (!agent || !canViewAgent(this.session, agent, this.permContext())) {
        this.sendJson(res, 404, { ok: false, error: 'Agent not found' })
        return true
      }
      this.sendJson(res, 200, { ok: true, data: agentDisplayProfile(agent) })
      return true
    }
    if (p === '/api/agents' && method === 'GET') {
      // 权限（§10.4）：非归属人看到的是脱敏视图（无 apiKey / 提示词），不可见条目直接隐藏
      const ctx = this.permContext()
      const agents = this.store.getAgents()
        .filter((a) => canViewAgent(this.session, a, ctx))
        .map((a) => maskAgentForViewer(a, this.session))
      this.sendJson(res, 200, { ok: true, data: agents })
      return true
    }
    // ---------- 专家团（合同式团队：共同目标/约束/交付要求 + 成员分工） ----------
    if (p === '/api/teams' && method === 'GET') {
      // 专家团是「公共花名册」：全员可见可用，仅归属人/admin 可改删（§10.4）
      const teams = this.store.getTeams().map((t) => this.maskTeamForViewer(t, this.session))
      this.sendJson(res, 200, { ok: true, data: teams })
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
      // 权限（§10.4）：他人归属的专家团不可改；归属人由服务端权威写入
      const existingTeam = body?.id ? this.store.getTeam(String(body.id)) : undefined
      if (existingTeam && !canManageAgent(this.session, existingTeam)) {
        this.sendJson(res, 403, { ok: false, error: '无权修改该专家团（仅归属人或管理员可改）' })
        return true
      }
      // 归属：新建 = 当前用户；更新既有（存量无归属）保持原状，不静默转为个人私有
      const ownerUserId = existingTeam
        ? existingTeam.ownerUserId
        : this.session?.userId
      // 语义：无 id 新建；带 id 更新既有团队（成员/合同字段整体替换）
      const saved = this.store.upsertTeam({ ...parsed.value, id: body?.id || undefined, ownerUserId })
      this.sendJson(res, 200, { ok: true, data: saved })
      return true
    }
    const teamMatch = /^\/api\/teams\/([^/]+)$/.exec(p)
    if (teamMatch) {
      const teamId = decodeURIComponent(teamMatch[1])
      if (method === 'GET') {
        const team = this.store.getTeam(teamId)
        if (!team) {
          this.sendJson(res, 404, { ok: false, error: '专家团不存在' })
          return true
        }
        this.sendJson(res, 200, { ok: true, data: this.maskTeamForViewer(team, this.session) })
        return true
      }
      if (method === 'DELETE') {
        const team = this.store.getTeam(teamId)
        if (!team) {
          this.sendJson(res, 404, { ok: false, error: '专家团不存在' })
          return true
        }
        if (!canManageAgent(this.session, team)) {
          this.sendJson(res, 403, { ok: false, error: '无权删除该专家团（仅归属人或管理员可删）' })
          return true
        }
        this.sendJson(res, 200, { ok: true, data: { deleted: this.store.deleteTeam(teamId) } })
        return true
      }
    }
    if (p === '/api/agents' && method === 'POST') {
      const body = await this.parseBody(req)
      // 部分更新：带 id 时 dshRef 缺省回退已有值
      const fallback = body?.id ? this.store.getAgent(String(body.id)) : undefined
      // 权限（§10.4）：他人归属的子智能体不可改；归属人由服务端权威写入（不接受客户端传入）
      if (fallback && !canManageAgent(this.session, fallback)) {
        this.sendJson(res, 403, { ok: false, error: '无权修改该子智能体（仅归属人或管理员可改）' })
        return true
      }
      if ((!fallback || Object.prototype.hasOwnProperty.call(body, 'name')) && (typeof body.name !== 'string' || !body.name.trim())) {
        this.sendJson(res, 400, { ok: false, code: 'INVALID_PARAM', field: 'name', error: 'name 必须是非空字符串' })
        return true
      }
      // 归属人：更新沿用原归属；复用同名条目时保留原归属；真正新建 = 当前用户
      const dshRef = normalizeDshRef(body.dshRef ?? fallback?.dshRef)
      if ('error' in dshRef) {
        this.sendJson(res, 400, { ok: false, error: dshRef.error })
        return true
      }
      // 新建时 store 会按「同名 + 同 DSH 实体」复用既有条目（防双击重复）；复用他人归属的
      // 智能体等于改他人资产，必须先过权限（§10.4）；复用时保留原归属，不转移 owner
      let reuseTarget: SubAgent | undefined
      if (!fallback) {
        const nameRaw = String(body?.name ?? '').trim()
        reuseTarget = nameRaw ? this.store.findAgentByNameAndRef(nameRaw, dshRef as DshRef) : undefined
        if (reuseTarget && !canManageAgent(this.session, reuseTarget)) {
          this.sendJson(res, 403, { ok: false, error: '同名子智能体已存在且归属他人，请改名或联系管理员' })
          return true
        }
      }
      try {
        mergeAgentDisplay(body.display, (fallback || reuseTarget)?.display)
      } catch (err: any) {
        this.sendJson(res, 400, { ok: false, error: err.message })
        return true
      }
      // 归属：新建 = 当前用户；更新既有（存量无归属）保持「无归属」原状，
      // 不得因管理员编辑一次就把共享存量资产静默变成其个人私有资产。
      const ownerUserId = fallback?.ownerUserId
        ?? reuseTarget?.ownerUserId
        ?? (fallback || reuseTarget ? undefined : this.session?.userId)
      const workDir = String(body?.workDir ?? '').trim()
      if (workDir && !isNodeAbsolutePath(workDir)) {
        this.sendJson(res, 400, { ok: false, error: WORK_DIR_NOT_ABSOLUTE_MSG })
        return true
      }
      // expertSource 是服务端权威打的来源快照：① 客户端显式带时校验专家存在才保留（防伪造来源）；
      // ② fromExpertId（由子智能体页「专家名册预填」流程携带）→ 复制人格并权威记录来源
      if (body?.expertSource) {
        const sid = String(body.expertSource.expertId ?? '').trim()
        const ex = sid ? await this.expertRegistry.get(sid).catch(() => undefined) : undefined
        if (!ex) delete body.expertSource
      }
      const fromExpertId = String(body?.fromExpertId ?? '').trim()
      if (fromExpertId) {
        const profile = await this.expertRegistry.getProfile(fromExpertId).catch(() => undefined)
        if (profile) {
          body.systemPrompt = profile.systemPrompt
          body.executionPrompt = profile.executionPrompt
          body.expertSource = buildExpertSource({ id: profile.id, name: profile.name, role: profile.role, systemPrompt: profile.systemPrompt, executionPrompt: profile.executionPrompt })
        } else {
          this.sendJson(res, 404, { ok: false, error: `专家不存在: ${fromExpertId}` })
          return true
        }
        delete body.fromExpertId
      }
      const saved = this.store.upsertAgent({
        ...(body as any),
        dshRef: dshRef as DshRef,
        ownerUserId,
        sharedProjectIds: Array.isArray(body?.sharedProjectIds)
          ? body.sharedProjectIds.map(String).filter(Boolean)
          : fallback?.sharedProjectIds,
      })
      this.sendJson(res, 200, { ok: true, data: saved })
      return true
    }
    // 远端目录浏览与工作区文件管理
    if (p === '/api/agents/fs/list' && method === 'GET') {
      const url = new URL(req.url || '/', 'http://localhost')
      const targetRes = await this.resolveFsTarget(url, undefined, 'read')
      if (!targetRes.ok) {
        this.sendJson(res, targetRes.status, { ok: false, error: targetRes.error })
        return true
      }
      const target = targetRes.target
      const dirPath = url.searchParams.get('path') || undefined
      const all = url.searchParams.get('all') === '1' || url.searchParams.get('all') === 'true'
      const checked = await this.projectFsPath(targetRes, dirPath)
      const out = checked.listing ? { ok: true, data: checked.listing } : await this.client.fsList(target, dirPath || undefined, all)
      if (out.ok && out.data && targetRes.project) {
        out.data.entries = out.data.entries.filter(entry => {
          try { requireWorkspacePath(this.session, targetRes.project!, this.store.getProjects(), this.directory, entry.path, false); return true } catch { return false }
        })
      }
      this.sendJson(res, out.ok ? 200 : 400, out.ok ? out : { ok: false, error: out.error })
      return true
    }
    if (p === '/api/agents/fs/download' && method === 'GET') {
      const url = new URL(req.url || '/', 'http://localhost')
      const targetRes = await this.resolveFsTarget(url, undefined, 'read')
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
      const checked = await this.projectFsPath(targetRes, filePath)
      const out = await this.client.fsDownload(target, checked.path, inline)
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
      const targetRes = await this.resolveFsTarget(url, undefined, 'write')
      if (!targetRes.ok) {
        this.sendJson(res, targetRes.status, { ok: false, error: targetRes.error })
        return true
      }
      const target = targetRes.target
      if (!destDir) {
        this.sendJson(res, 400, { ok: false, error: '缺少目标目录 path' })
        return true
      }
      await this.projectFsPath(targetRes, destDir, true)
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
      if (targetRes.project) {
        const out = await this.saveProjectUploads({ target, project: targetRes.project }, destDir, files, url.searchParams.get('expectedSha256') || undefined)
        this.sendJson(res, out.status, out.body)
        return true
      }
      const out = await this.client.fsUpload(target, destDir, files)
      this.sendJson(res, out.ok ? 200 : 400, out.ok ? out : { ok: false, error: out.error })
      return true
    }
    if (p === '/api/agents/fs/remove' && (method === 'DELETE' || method === 'POST')) {
      const url = new URL(req.url || '/', 'http://localhost')
      const body = method === 'POST' ? await this.parseBody(req) : null
      const targetPath = String(url.searchParams.get('path') || body?.path || '').trim()
      if (body?.projectId && !url.searchParams.has('projectId')) url.searchParams.set('projectId', String(body.projectId))
      const targetRes = await this.resolveFsTarget(url, body?.agent, 'write')
      if (!targetRes.ok) {
        this.sendJson(res, targetRes.status, { ok: false, error: targetRes.error })
        return true
      }
      const target = targetRes.target
      if (!targetPath) {
        this.sendJson(res, 400, { ok: false, error: '缺少 path 参数' })
        return true
      }
      const checked = await this.projectFsPath(targetRes, targetPath, true, false, true)
      if (targetRes.project && checked.path === projectFilePath(targetRes.project)) throw new WorkspaceFileError(403, 'WORKSPACE_ROOT_PROTECTED', '不能删除项目工作区根目录')
      const out = await this.client.fsRemove(target, checked.path)
      this.sendJson(res, out.ok ? 200 : 400, out.ok ? out : { ok: false, error: out.error })
      return true
    }
    if (p === '/api/agents/fs/mkdir' && method === 'POST') {
      const body = await this.parseBody(req)
      const requestUrl = new URL(req.url || '/', 'http://localhost')
      if (body?.projectId) requestUrl.searchParams.set('projectId', String(body.projectId))
      if (requestUrl.searchParams.has('projectId')) {
        const result = await this.resolveFsTarget(requestUrl, undefined, 'write')
        if (!result.ok) { this.sendJson(res, result.status, { ok: false, error: result.error }); return true }
        const parent = projectFilePath(result.project!, String(body?.path || ''))
        const child = workspaceChild(parent, String(body?.name || ''))
        await this.projectFsPath(result, child, true, true)
        const out = await this.client.fsMkdir(result.target, parent, String(body?.name || ''))
        this.sendJson(res, out.ok ? 200 : 400, out.ok ? out : { ok: false, error: out.error })
        return true
      }
      requireNodeFiles(this.session)
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
      const agent = this.store.getAgent(id)
      if (!agent) {
        this.sendJson(res, 404, { ok: false, error: 'Agent not found' })
        return true
      }
      if (!canManageAgent(this.session, agent)) {
        this.sendJson(res, 403, { ok: false, error: '无权删除该子智能体（仅归属人或管理员可删）' })
        return true
      }
      this.audit('agent.delete', 'agent', id, agent.name)
      this.sendJson(res, 200, { ok: true, data: { deleted: this.store.deleteAgent(id) } })
      return true
    }
    if (agentMatch && method === 'GET') {
      const agent = this.store.getAgent(decodeURIComponent(agentMatch[1]))
      if (!agent || !canViewAgent(this.session, agent, this.permContext())) {
        this.sendJson(res, 404, { ok: false, error: 'Agent not found' })
        return true
      }
      this.sendJson(res, 200, { ok: true, data: maskAgentForViewer(agent, this.session) })
      return true
    }
    const pingMatch = /^\/api\/agents\/([^/]+)\/ping$/.exec(p)
    if (pingMatch && method === 'POST') {
      const agent = this.store.getAgent(decodeURIComponent(pingMatch[1]))
      if (!agent) {
        this.sendJson(res, 404, { ok: false, error: 'Agent not found' })
        return true
      }
      const observedAt = performance.now()
      const { target, ping } = await this.resolver.resolveWithPing(agent)
      this.monitor?.observeAgentHealth(agent, { online: ping?.ok === true, error: ping?.error, baseUrl: target?.baseUrl }, observedAt)
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
      const task = this.taskForView(decodeURIComponent(taskModelsMatch[1]))
      if (!task) {
        this.sendJson(res, 404, { ok: false, error: 'Task not found' })
        return true
      }
      // __node__（节点主会话）无 store 记录 → resolveExecTarget 按任务/项目节点解析（公开方法）
      const target = await this.engine.resolveExecTarget(task, task.chatAgentId || '__node__').catch(() => undefined)
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
      if (!agent || !canViewAgent(this.session, agent, this.permContext())) {
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
      if (!agent || !canViewAgent(this.session, agent, this.permContext())) {
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
      // §11：技能绑定是智能体配置面，与管理动作同权（仅归属人/admin；存量=仅 admin）
      if (!canManageAgent(this.session, agent)) {
        this.sendJson(res, 403, { ok: false, error: '仅归属人或管理员可修改该智能体的技能绑定' })
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
      // §11：向智能体节点上传技能 = 管理动作（同 canManageAgent 口径）
      if (!canManageAgent(this.session, agent)) {
        this.sendJson(res, 403, { ok: false, error: '仅归属人或管理员可向该智能体上传技能' })
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
      if (!agent || !canViewAgent(this.session, agent, this.permContext())) {
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
      // §11：删除节点上的技能文件 = 管理动作（同 canManageAgent 口径）
      if (!canManageAgent(this.session, agent)) {
        this.sendJson(res, 403, { ok: false, error: '仅归属人或管理员可删除该智能体的技能' })
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
      if (!agent || !canViewAgent(this.session, agent, this.permContext())) {
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
            imported.push(await this.library.add(kind, { filename: f.filename || 'archive.bin', data: f.data }, 'upload', undefined, undefined, this.session?.userId))
          } catch (err: any) {
            failed.push({ filename: f.filename || '?', error: err?.message || String(err) })
          }
        }
        this.sendJson(res, 200, { ok: failed.length === 0, data: { imported, failed } })
        return true
      }
      const libSettingsMatch = /^\/api\/library\/settings$/.exec(p)
      if (libSettingsMatch && method === 'POST') {
        if (!this.isAdminOrServiceChannel()) { this.denyNotAdmin(res, '修改库共享基址'); return true }
        const body = await this.parseBody(req)
        this.library.setPublicBaseUrl(String(body?.publicBaseUrl || ''))
        this.sendJson(res, 200, { ok: true, data: { publicBaseUrl: this.library.publicBaseUrl() || '' } })
        return true
      }
      const libDelMatch = /^\/api\/library\/(skill|plugin)\/([^/]+)$/.exec(p)
      if (libDelMatch && method === 'DELETE') {
        const libId = decodeURIComponent(libDelMatch[2])
        const entry = this.library.get(libId)
        // §11：条目删除仅归属人+admin（存量=仅 admin）；查看/下载/安装保持全员
        if (!entry) {
          this.sendJson(res, 404, { ok: false, error: '条目不存在' })
          return true
        }
        if (!canManageOwned(this.session, entry)) {
          this.sendJson(res, 403, { ok: false, error: '仅条目归属人或管理员可删除该条目' })
          return true
        }
        const ok = this.library.remove(libId)
        if (ok) this.audit('library.delete', 'library', libId, entry ? `${libDelMatch[1]}:${entry.name}` : libDelMatch[1])
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
                ownerUserId: this.session?.userId,
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
              ownerUserId: this.session?.userId,
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
            imported.push(await this.library.add('skill', { filename: r.name || `${name}.tgz`, data: buf }, 'import', sourceLabel, undefined, this.session?.userId))
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
            ownerUserId: this.session?.userId,
          })
          : await this.engine.createTask({
            title: `导出插件 ← ${legacyAgent!.name}`,
            memberAgentIds: [legacyAgent!.id],
            message: buildPluginExportPrompt(),
            creator: 'console',
            ownerUserId: this.session?.userId,
          })
        if (nodeRef) this.pluginImportRefs.set(task.id, { ref: nodeRef, label: nodeLabel, family: 'dsh' })
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
          ? await this.pullExportedPluginsByRef(taskId, stashed.ref, stashed.label, stashed.family)
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

      // 节点已装插件清单（从节点导入插件的选择来源；node = dshRef JSON，agentId = 目标 AGENT（适用性匹配））
      // 家族匹配：插件 family 必须等于目标 AGENT 引擎家族（dsh/zcode），否则该条标 applicable=false（UI 禁选）。
      // agentId 缺省=不适用过滤（全部返回，applicable=true）。
      const libNodePluginsMatch = /^\/api\/library\/nodes\/plugins$/.exec(p)
      if (libNodePluginsMatch && method === 'GET') {
        const url = new URL(req.url || '/', 'http://localhost')
        let nref: any
        try { nref = JSON.parse(url.searchParams.get('node') || '') } catch { /* below */ }
        if (!nref || typeof nref !== 'object') {
          this.sendJson(res, 400, { ok: false, error: 'node 参数非法（需 dshRef JSON）' })
          return true
        }
        const nodeRef = nref as DshRef
        const target = await this.resolver.resolveRef(nodeRef, undefined, 'library-node')
        if (!target.online) {
          this.sendJson(res, 200, { ok: false, error: target.error || '节点不可达', data: { plugins: [] } })
          return true
        }
        const r = await this.client.listPlugins(target)
        if (r.unsupported) {
          this.sendJson(res, 200, { ok: false, error: r.error, data: { plugins: [], unsupported: true } })
          return true
        }
        if (!r.ok || !r.plugins) {
          this.sendJson(res, 200, { ok: false, error: r.error || '读取插件清单失败', data: { plugins: [] } })
          return true
        }
        // 目标 AGENT 引擎家族（缺省不限）
        const agent = this.store.getAgent(url.searchParams.get('agentId') || '')
        const agentRef = (agent as any)?.dshRef as DshRef | undefined
        const agentEngine = url.searchParams.get('agentId') ? await this.engineFamilyOfRef(agentRef && agentRef.kind ? agentRef : nodeRef) : ''
        const items = (r.plugins || []).map((pl) => {
          const family = pl.family || r.family || 'unknown'
          const convertible = agentEngine && agentEngine !== 'unknown'
            ? family === agentEngine || family === 'unknown'
            : true
          return { ...pl, family, applicable: convertible }
        })
        this.sendJson(res, 200, {
          ok: true,
          data: {
            plugins: items,
            count: items.length,
            family: r.family,
            profile: r.profile,
            agentId: agent?.id,
            agentName: agent?.name,
            agentEngine: agentEngine || undefined,
          },
        })
        return true
      }

      // 按清单从节点导入插件（新版流程：节点 /plugins 清单 → 勾选 → 节点对 sourcePath 打包 → /fs 回拉入库）
      const libImpListMatch = /^\/api\/library\/import\/plugins\/list$/.exec(p)
      if (libImpListMatch && method === 'POST') {
        const body = await this.parseBody(req)
        const nodeRef = body?.nodeRef && typeof body.nodeRef === 'object' ? (body.nodeRef as DshRef) : undefined
        if (!nodeRef) {
          this.sendJson(res, 400, { ok: false, error: '缺少 nodeRef（来源节点）' })
          return true
        }
        const items: Array<{ name: string; sourcePath: string; version?: string }> =
          Array.isArray(body?.items)
            ? body.items
              .map((it: any) => ({ name: String(it?.name || ''), sourcePath: String(it?.sourcePath || ''), version: it?.version ? String(it.version) : undefined }))
              .filter((it: any) => it.name && it.sourcePath)
            : []
        if (!items.length) {
          this.sendJson(res, 400, { ok: false, error: '缺少 items（需从 /library/nodes/plugins 清单中读取，含 name+sourcePath）' })
          return true
        }
        // 适用性兜底校验：指定目标 AGENT 时其引擎家族必须与请求家族一致（家族缺省时以 agent 引擎家族为准）
        const agent = this.store.getAgent(String(body?.agentId || ''))
        const requestedFamily = String(body?.family || '').toLowerCase() || undefined
        const agentRef = (agent as any)?.dshRef as DshRef | undefined
        const agentEngine = agent ? await this.engineFamilyOfRef(agentRef && agentRef.kind ? agentRef : nodeRef) : 'unknown'
        if (agent && agentEngine !== 'unknown' && requestedFamily && requestedFamily !== agentEngine) {
          this.sendJson(res, 400, {
            ok: false,
            error: `插件家族 ${requestedFamily} 与目标 AGENT 引擎家族 ${agentEngine} 不匹配（请按该 AGENT 重新读取适用清单）`,
          })
          return true
        }
        const family = (agentEngine && agentEngine !== 'unknown' ? agentEngine : requestedFamily) || (await this.engineFamilyOfRef(nodeRef)) || 'dsh'
        const nodeLabel = this.nodeLabelOf(nodeRef)
        const task = await this.engine.createTask({
          title: `导出插件 ← ${nodeLabel}（${items.length} 项）`,
          nodeRef,
          message: buildPluginListExportPrompt(items),
          creator: 'console',
          ownerUserId: this.session?.userId,
        })
        this.pluginImportRefs.set(task.id, { ref: nodeRef, label: nodeLabel, family })
        this.sendJson(res, 200, {
          ok: true,
          data: { taskId: task.id, nodeLabel, family, count: items.length },
        })
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
      // §11：预览返回 systemPrompt/executionPrompt 原文（私有配置），与管理动作同权
      // ——能 @ 但非归属人的成员走 maskAgentForViewer 脱敏视图，不走本接口读提示词；
      // 不可见的智能体统一 404 防枚举，可见但非归属人 403
      if (!canViewAgent(this.session, agent, this.permContext())) {
        this.sendJson(res, 404, { ok: false, error: 'Agent not found' })
        return true
      }
      if (!canManageAgent(this.session, agent)) {
        this.sendJson(res, 403, { ok: false, error: '仅归属人或管理员可预览该智能体的提示词' })
        return true
      }
      try {
        await this.directory.refresh(true)
      } catch {
        /* 无网时用缓存 */
      }
      const url = new URL(req.url || '/', 'http://localhost')
      const mask = url.searchParams.get('mask') === '0' ? false : true
      // 与真实派发对齐：预览也要注入项目/任务级技能（extraSkills），否则预览看不到 [已装载技能] 全量
      const extraSkills = [
        ...(() => {
          const projId = url.searchParams.get('projectId') || ''
          return projId ? (this.store.getProject(projId)?.skillNames || []) : []
        })(),
        ...(url.searchParams.get('skillNames') || '').split(',').map((s) => s.trim()).filter(Boolean),
      ]
      const composed = await this.composer.compose(agent, { resolvedAt: Date.now(), mask, extraSkills })
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
      // §11：仅列出本人可见的项目（成员/宽容模式），防止实体泄露
      for (const pr of this.store.getProjects()) {
        if (!this.canSeeProject(pr)) continue
        candidates.push({
          type: 'project',
          id: pr.id,
          name: pr.name,
          kind: 'project',
          detail: `项目 · ${pr.workspace || '未设工作目录'}${projectDefaultAgentIds(pr).length ? ` · ${projectDefaultAgentIds(pr).length} 名默认协作成员` : ''}`,
          meta: { projectId: pr.id, workspace: pr.workspace, expertCount: projectDefaultAgentIds(pr).length },
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

      // 1. 子智能体（§11：仅列出本人可见可 @ 的条目，与 /api/agents 列表同口径）
      const agents = this.store.getAgents()
      for (const a of agents) {
        if (a.enabled !== false && canViewAgent(this.session, a, this.permContext())) {
          candidates.push({
            type: 'agent',
            id: a.id,
            name: a.name,
            kind: 'agent',
            // P5-1：@ 菜单显示执行位置（🖥 节点名 · 模型）
            detail: `🖥 ${this.nodeLabelOf(a.dshRef) || a.dshRef.kind} · ${a.model ? String(a.model).split('/').pop() : '默认模型'}`,
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

      // 3. 本地 SSH 资源池（§11：仅列出本人可见条目，与 /api/ssh-resources 同口径）
      const sshs = this.sshStore.list()
      for (const s of sshs) {
        if (!canViewResource(this.session, s, this.permContext())) continue
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
              // P5-1：专家在本任务节点执行，如实标注
              detail: `专家 · ${e.divisionZh || e.division} · 在本任务节点执行`,
              meta: { expertId: e.id, description: e.description, icon: e.icon },
            })
          }
        }
      }

      this.sendJson(res, 200, { ok: true, data: candidates })
      return true
    }

    // ---------- 活动态与按用户阅读位置 ----------
    const readActivity = p.match(/^\/api\/tasks\/([^/]+)\/read$/)
    if (p === '/api/activity' && method === 'GET' || readActivity && method === 'POST') {
      try {
        const activity = new TaskActivity(this.store, id => this.engine.isRunning(id))
        const data = readActivity
          ? activity.read(decodeURIComponent(readActivity[1]), await this.parseBody(req), this.session)
          : activity.list(new URL(req.url || '/', 'http://localhost').searchParams, this.session)
        res.setHeader('Cache-Control', 'no-store')
        this.sendJson(res, 200, { ok: true, data })
      } catch (err) {
        if (!(err instanceof TaskHistoryError)) throw err
        this.sendJson(res, err.status, { ok: false, code: err.code, error: err.message })
      }
      return true
    }

    // ---------- 任务会话 ----------
    if (p === '/api/tasks/history' && method === 'GET') {
      try {
        this.historyIndex ||= new TaskHistory(this.store)
        const data = this.historyIndex.list(new URL(req.url || '/', 'http://localhost').searchParams, this.session)
        res.setHeader('Cache-Control', 'no-store')
        this.sendJson(res, 200, { ok: true, data })
      } catch (err) {
        if (!(err instanceof TaskHistoryError)) throw err
        this.sendJson(res, err.status, { ok: false, code: err.code, error: err.message })
      }
      return true
    }
    if (p === '/api/tasks' && method === 'GET') {
      // 可选 ?projectId= 过滤（项目工作台只看本项目任务）
      const urlTasks = new URL(req.url || '/', 'http://localhost')
      const projectFilter = urlTasks.searchParams.get('projectId') || ''
      const allTasks = this.store.getTasks()
      // §11：列表按可见性过滤（归属人/admin/项目成员；存量与 AI 通道任务=全员）
      const ctxTasks = this.permContext()
      const scoped = visibleTasks(allTasks, this.session, ctxTasks)
      const tasks = projectFilter ? scoped.filter((t) => t.projectId === projectFilter) : scoped
      // 列表只返回摘要（完整 turns/taskLogs 随任务增长可达数 MB，且 SSE 每个事件都会刷新列表，
      // 全量返回会占满浏览器并发连接，导致切换会话时单任务请求长时间排队）
      this.sendJson(res, 200, { ok: true, data: tasks.map((t) => this.taskSummary(t)) })
      return true
    }
    if (p === '/api/tasks' && method === 'POST') {
      const body = await this.parseBody(req)
      // 归档项目只读（P-08）：不接受新任务
      if (body?.projectId) {
        const proj = this.store.getProject(String(body.projectId))
        if (proj?.archivedAt) { this.sendJson(res, 400, { ok: false, error: '项目已归档（只读），请先恢复再发起任务' }); return true }
      }
      // 未指定成员时不在此处兜底：默认成员的唯一权威是 engine.createTask → defaultMemberAgentIds（主智能体）。
      // 历史实现曾在此填「全部可用子智能体」，导致无 @ 新建的任务变成全员编排，附件随之上传扇出到所有节点。
      try {
        // §11：归属=当前会话用户（服务端权威，忽略 body 注入）；AI 工具通道无会话 → 缺省宽容模式
        const routeArgs = taskRouteArgs(body, 'create')
        if (routeArgs.chatAgentId) {
          const agent = this.store.getAgent(String(routeArgs.chatAgentId))
          if (!agent || !canUseAgent(this.session, agent, this.permContext())) {
            this.sendJson(res, 404, { ok: false, code: 'AGENT_NOT_FOUND', error: 'BOT 不存在或无权使用' })
            return true
          }
        }
        const task = await this.engine.createTask({
          ...body,
          ...routeArgs,
          ownerUserId: this.session?.userId,
          creator: body.creator || 'tool',
        })
        this.sendJson(res, 201, { ok: true, data: task })
      } catch (err: any) {
        this.sendJson(res, 400, { ok: false, error: err?.message || String(err) })
      }
      return true
    }
    // 批量归档管理（归档管理页）：op=restore 批量恢复 / delete 批量删除；仅作用于已归档（archivedAt 非空）会话。
    // 范围：不传 projectId = 全部；projectId: null = 仅未分组会话；字符串 = 指定项目；ids 可再限定到指定清单。
    if (p === '/api/tasks/bulk-archive' && method === 'POST') {
      const body = await this.parseBody(req)
      const op = String(body?.op || '')
      const hasProjectScope = body !== null && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'projectId')
      const projectId = hasProjectScope ? (body.projectId || null) : undefined
      const ids = Array.isArray(body?.ids) ? new Set(body.ids.map(String)) : null
      // §11：批量恢复/删除逐条校验管理权（仅归属人+admin；存量=仅 admin），无权条目静默跳过
      const scoped = (t: WorkTask) =>
        (!hasProjectScope || (projectId ? t.projectId === projectId : !t.projectId))
        && (!ids || ids.has(t.id))
        && canManageTask(this.session, t)
      if (op === 'restore') {
        const restored = this.store.bulkUnarchive(scoped)
        this.sendJson(res, 200, { ok: true, data: { restored } })
        return true
      }
      if (op === 'delete') {
        const deleted = await this.engine.bulkDeleteArchived(scoped)
        this.audit('task.bulk_delete', 'task', projectId || 'unassigned', `批量删除已归档任务 ${deleted} 条`)
        this.sendJson(res, 200, { ok: true, data: { deleted } })
        return true
      }
      this.sendJson(res, 400, { ok: false, error: 'op 需为 restore（批量恢复）或 delete（批量删除）' })
      return true
    }
    const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(p)
    if (taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1])
      if (method === 'GET') {
        // §11：不可见按 404 处理（防枚举；归属人/admin/项目成员可见）
        const task = this.taskForView(taskId)
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
        const m = this.taskForManage(taskId)
        if (!m.task) {
          this.sendJson(res, m.forbidden ? 403 : 404, { ok: false, error: m.forbidden ? '仅任务归属人或管理员可删除任务' : 'Task not found' })
          return true
        }
        const ok = await this.engine.deleteTask(taskId)
        if (ok) this.audit('task.delete', 'task', taskId, m.task.title)
        this.sendJson(res, 200, { ok: true, data: { deleted: ok } })
        return true
      }
      if (method === 'PATCH' || method === 'PUT') {
        const m = this.taskForManage(taskId)
        if (!m.task) {
          this.sendJson(res, m.forbidden ? 403 : 404, { ok: false, error: m.forbidden ? '仅任务归属人或管理员可编辑任务' : 'Task not found' })
          return true
        }
        const body = await this.parseBody(req)
        try {
          const route = taskRouteArgs({ ...body, message: 'validate task update' }, 'send', taskId)
          if (route.teamId !== undefined) throw Object.assign(new Error('任务更新不支持修改 teamId；请创建新任务'), { code: 'INVALID_PARAM' })
          this.engine.validateChatBinding(route, undefined, m.task)
          if (route.memberAgentIds !== undefined) {
            this.engine.updateMembers(taskId, route.memberAgentIds)
          }
          if (typeof body.title === 'string') {
            this.store.mutateTask(taskId, (t) => {
              t.title = body.title.trim() || t.title
            })
          }
          this.sendJson(res, 200, { ok: true, data: this.store.getTask(taskId) })
        } catch (err: any) {
          this.sendJson(res, 400, { ok: false, code: err?.code || 'INVALID_PARAM', error: err?.message })
        }
        return true
      }
    }
    const msgMatch = /^\/api\/tasks\/([^/]+)\/messages$/.exec(p)
    if (msgMatch && method === 'POST') {
      const taskId = decodeURIComponent(msgMatch[1])
      // §11：发消息 = view 级协作动作（可见即可聊）
      if (!this.taskForView(taskId)) {
        this.sendJson(res, 404, { ok: false, error: 'Task not found' })
        return true
      }
      const body = await this.parseBody(req)
      try {
        const opts = taskRouteArgs(body, 'send', taskId)
        const out = await this.engine.sendUserMessage(taskId, String(body.message || ''), opts)
        this.sendJson(res, out.ok ? 202 : 400, out)
      } catch (err: any) {
        this.sendJson(res, 400, { ok: false, code: err?.code || 'INVALID_PARAM', error: err?.message || String(err) })
      }
      return true
    }
    // 跨节点续接（P4-1）：新任务带最近对话原文草稿（不调用 LLM），双向链接原任务
    const forkMatch = /^\/api\/tasks\/([^/]+)\/fork$/.exec(p)
    if (forkMatch && method === 'POST') {
      const taskId = decodeURIComponent(forkMatch[1])
      // §11：fork = view 级动作；新任务归属 fork 人
      if (!this.taskForView(taskId)) {
        this.sendJson(res, 404, { ok: false, error: 'Task not found' })
        return true
      }
      const body = await this.parseBody(req)
      try {
        const out = await this.engine.forkTask(taskId, {
          nodeRef: body?.nodeRef && typeof body.nodeRef === 'object' ? (body.nodeRef as DshRef) : undefined,
          projectId: body?.projectId === null ? null : body?.projectId ? String(body.projectId) : undefined,
          ownerUserId: this.session?.userId,
        })
        this.sendJson(res, 200, { ok: true, data: out })
      } catch (err: any) {
        this.sendJson(res, 400, { ok: false, error: err?.message || String(err) })
      }
      return true
    }
    // 任务实时统计：聚合各成员远端会话的轮/步/耗时/吞吐/token 账本（3s 缓存 + 并发去重）
    const statsMatch = /^\/api\/tasks\/([^/]+)\/stats$/.exec(p)
    if (statsMatch && method === 'GET') {
      const taskId = decodeURIComponent(statsMatch[1])
      if (!this.taskForView(taskId)) { this.sendJson(res, 404, { ok: false, error: 'Task not found' }); return true }
      const out = await this.getTaskStats(taskId)
      this.sendJson(res, out.httpStatus, out.payload)
      return true
    }
    // 任务清单 + 运行时长：远端 DSH 会话的 todo_write 投影（主智能体优先，2s 缓存 + 并发去重）
    const todosMatch = /^\/api\/tasks\/([^/]+)\/todos$/.exec(p)
    if (todosMatch && method === 'GET') {
      const taskId = decodeURIComponent(todosMatch[1])
      if (!this.taskForView(taskId)) { this.sendJson(res, 404, { ok: false, error: 'Task not found' }); return true }
      const out = await this.getTaskTodos(taskId)
      this.sendJson(res, out.httpStatus, out.payload)
      return true
    }
    // 输入框 "/" 技能候选：聚合各成员会话作用域技能目录（按名去重，标注可用成员）
    const taskSkillsMatch = /^\/api\/tasks\/([^/]+)\/skills$/.exec(p)
    if (taskSkillsMatch && method === 'GET') {
      const taskId = decodeURIComponent(taskSkillsMatch[1])
      if (!this.taskForView(taskId)) { this.sendJson(res, 404, { ok: false, error: 'Task not found' }); return true }
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
      // §11：答复挂起问题 = view 级协作动作
      const task = this.taskForView(taskId)
      if (!task) {
        this.sendJson(res, 404, { ok: false, error: 'Task not found' })
        return true
      }
      // agentId 兜底：前端 turnMeta 缺失时依次回退挂起提问记录的成员、节点主会话（__node__），
      // 避免直通对话下因空 agentId 直接 400 卡死答复链路
      const agentId = String(body?.agentId || '') || task.pendingAsk?.agentId || '__node__'
      const binding = task.sessions?.[agentId]
      if (!binding?.remoteSessionId) {
        this.sendJson(res, 400, { ok: false, error: '该成员在任务中没有远端会话绑定', code: 'NO_SESSION' })
        return true
      }
      // 节点主会话（__node__）无 store 记录：按任务节点解析答复目标
      const target = await this.engine.resolveExecTarget(task, agentId)
      if (!target || !target.online || !target.baseUrl) {
        this.sendJson(res, 502, { ok: false, error: (target as any)?.error || '成员节点当前不可达' })
        return true
      }
      const answers = Array.isArray(body?.answers) ? body.answers : []
      const r = await this.client.answerQuestion(target, binding.remoteSessionId, answers)
      if (!r.ok) {
        // 提交失败 → 先对账：若远端批次已消失（超时/会话结束），清理残留 pendingAsk 并收敛提问卡，而不是永远挂着
        const reaped = await this.engine.reapStalePendingAsk(taskId).catch(() => false)
        if (reaped) {
          this.sendJson(res, 200, { ok: true, data: { answered: 0, stale: true } })
          return true
        }
        this.sendJson(res, 502, { ok: false, error: r.error || '答复提交失败', supported: r.supported })
        return true
      }
      // 本地落账（与 engine.answerPendingAndResume 对齐）：把挂起的 ask 工具落 done 并清除 pendingAsk，
      // 否则任务刷新后问题卡回退为「等待答复」态、可被重复作答（线上"假答复卡/卡死"缺陷的配套修复）
      const task0 = this.store.getTask(taskId)
      if (task0) {
        const summary = answers
          .map((a: any) => [Array.isArray(a?.selected) ? a.selected.join(' / ') : '', String(a?.custom || '')].filter(Boolean).join('｜'))
          .filter(Boolean)
          .join('；')
          .slice(0, 480)
        const settleAskTool = (turnId: string) => {
          if (!turnId) return
          this.store.updateTurn(taskId, turnId, (tt) => {
            const t = [...(tt.tools || [])].reverse().find((x) => (x.name === 'ask_user_question' || x.name === 'ask-user-question') && x.status === 'running')
            if (t) {
              t.status = 'done'
              t.result = '✅ 已答复: ' + (summary || '（用户已在问题卡片作答）')
              t.awaiting = false
            }
          })
        }
        if (task0.pendingAsk?.turnId) {
          settleAskTool(task0.pendingAsk.turnId)
        } else {
          const turns = [...(this.store.getTask(taskId)?.turns || [])].reverse()
          for (const tn of turns) {
            if ((tn.tools || []).some((x) => (x.name === 'ask_user_question' || x.name === 'ask-user-question') && x.status === 'running')) {
              settleAskTool(tn.id)
              break
            }
          }
        }
        if (task0.pendingAsk) this.store.mutateTask(taskId, (t) => { delete t.pendingAsk })
      }
      // 续跑追踪：卡片答复回传成功后，远端 run 从挂起点继续 —— 必须有人接收续跑产出，
      // 否则任务直接「完成」却没有最终结果（与自由文本答复桥同一套追踪/对账）
      this.engine.trackAskResumeAfterCardAnswer(taskId, agentId, target, binding.remoteSessionId)
      this.sendJson(res, 200, { ok: true, data: { answered: answers.length } })
      return true
    }
    // 更新任务执行会话的模型（PUT /sessions/:id 透传到远端 DSH）
    // body: { agentId, provider?, model?, reasoningEffort? }；model 为空 = 清除覆盖回退默认
    const sessionModelMatch = /^\/api\/tasks\/([^/]+)\/session-model$/.exec(p)
    if (sessionModelMatch && method === 'PUT') {
      const taskId = decodeURIComponent(sessionModelMatch[1])
      const body = await this.parseBody(req)
      // 会话模型/预设 = 任务可见即可选（用户决策 2026-11-04：选模型/沙箱全员放开，仅按任务可见性；
      // 不再走 taskForManage——存量/无归属任务曾因此对普通用户误报 404 Task not found）
      const task = this.taskForView(taskId)
      if (!task) {
        this.sendJson(res, 404, { ok: false, error: 'Task not found' })
        return true
      }
      // 未指定 agentId 时：优先任务的主会话（__node__），否则当前主智能体（与聊天窗模型切换语义一致）
      if (task.chatAgentId && body?.agentId !== undefined && body.agentId !== task.chatAgentId) {
        this.sendJson(res, 400, { ok: false, code: 'INVALID_PARAM', error: 'agentId 与任务直聊绑定冲突' })
        return true
      }
      const agentId = task.chatAgentId || String(body?.agentId || '') || (task.sessions?.['__node__']?.remoteSessionId ? '__node__' : this.planner.pickMainAgent()?.id || '')
      const binding = task.sessions?.[agentId]
      if (!agentId || !binding?.remoteSessionId) {
        this.sendJson(res, 400, { ok: false, error: '该成员在任务中没有远端会话绑定', code: 'NO_SESSION' })
        return true
      }
      // 主/子会话均按绑定的稳定节点身份实时解析，不使用旧公网地址。
      const target = await this.engine.resolveExecTarget(task, agentId)
      if (!target || !target.online || !target.baseUrl) {
        this.sendJson(res, 502, { ok: false, error: (target as any)?.error || '成员节点当前不可达' })
        return true
      }
      let provider = typeof body?.provider === 'string' && body.provider ? body.provider : undefined
      let model = typeof body?.model === 'string' && body.model ? body.model : undefined
      let defaultModel: { provider: string; model: string; reasoningEffort?: string } | undefined
      // 显式「恢复节点默认」：远端 PUT /sessions/:id 传空 model 不会清除覆盖（会把字段忽略），
      // 必须先解析节点默认 provider/model，再显式下发，否则按钮显示默认但会话仍跑旧模型。
      const wantsDefault = body !== null && typeof body === 'object'
        && Object.prototype.hasOwnProperty.call(body, 'model')
        && !model && !provider
      if (wantsDefault) {
        const def = await this.client.getModels(target)
        const dm = def.ok
          ? (def.defaultModel || def.models.find((m) => m.isDefault))
          : undefined
        if (!dm || !dm.provider || !dm.model) {
          const why = def.ok ? '' : `（${def.error || '模型目录不可用'}）`
          this.sendJson(res, 502, { ok: false, error: `无法解析节点默认模型${why}，请改选具体模型` })
          return true
        }
        provider = dm.provider
        model = dm.model
        defaultModel = { provider: dm.provider, model: dm.model, reasoningEffort: def.defaultModel?.reasoningEffort || (dm as any).reasoningEffort }
      }
      // 前置校验（仅显式指定 provider+model 时）：所选模型必须存在于目标节点模型目录。
      // 跨引擎/跨节点的已保存选择会被远端拒绝——ZCode 引擎对该场景的报错是
      // 「Provider Registry 中不存在 Model: [object Object]」，天书且无法定位，故本地拦截给可读提示。
      // 目录不可用（节点临时不可达等）时放行，由远端兜底，避免误伤。
      if (provider && model && !wantsDefault) {
        const cat = await this.client.getModels(target)
        if (cat.ok && cat.models.length && !cat.models.some((m) => m.provider === provider && m.id === model)) {
          const nodeLabel = (target as any)?.mappingId
            ? this.directory.resolveMapping(String((target as any).mappingId))?.appName || String((target as any).mappingId)
            : '当前节点'
          this.sendJson(res, 400, {
            ok: false,
            code: 'MODEL_NOT_IN_CATALOG',
            error: `模型 ${provider}/${model} 不在节点「${nodeLabel}」的模型目录中（跨引擎或跨节点的已保存选择），请另选该节点目录内的模型，或点「主调度默认模型」恢复节点默认`,
          })
          return true
        }
      }
      const r = await this.client.updateSessionModel(target, binding.remoteSessionId, {
        provider,
        model,
        reasoningEffort: typeof body?.reasoningEffort === 'string' && body.reasoningEffort
          ? body.reasoningEffort
          : defaultModel?.reasoningEffort,
        agentPreset: typeof body?.agentPreset === 'string' ? body.agentPreset : undefined,
      })
      if (!r.ok) {
        this.sendJson(res, 502, { ok: false, error: r.error || '更新会话模型失败' })
        return true
      }
      if (task.chatAgentId) this.store.mutateTask(taskId, t => {
        if (provider && model) t.model = `${provider}/${model}`
        const effort = typeof body?.reasoningEffort === 'string' ? body.reasoningEffort : defaultModel?.reasoningEffort
        if (effort) t.reasoningEffort = effort
        else if (body?.reasoningEffort !== undefined || provider && model) delete t.reasoningEffort
        if (typeof body?.agentPreset === 'string') {
          if (body.agentPreset) t.agentPreset = body.agentPreset
          else delete t.agentPreset
        }
      })
      this.sendJson(res, 200, {
        ok: true,
        data: { selected: r.selected, presetApplied: r.preset ? r.preset.applied : undefined, defaultModel },
      })
      return true
    }
    // 任务执行会话的模式预设（agentPreset）：任务级持久化（task > 智能体实体 > 远端默认 cordis）
    // + 尽力对当前远端会话即时生效（宿主不支持运行时切 preset → applied=false，仅持久化，新会话生效）
    const sessionPresetMatch = /^\/api\/tasks\/([^/]+)\/session-preset$/.exec(p)
    if (sessionPresetMatch && method === 'PUT') {
      const taskId = decodeURIComponent(sessionPresetMatch[1])
      const body = await this.parseBody(req)
      // 会话预设同 session-model：任务可见即可选（全员放开，仅按可见性）
      const task = this.taskForView(taskId)
      if (!task) {
        this.sendJson(res, 404, { ok: false, error: 'Task not found' })
        return true
      }
      if (task.chatAgentId && body?.agentId !== undefined && body.agentId !== task.chatAgentId) {
        this.sendJson(res, 400, { ok: false, code: 'INVALID_PARAM', error: 'agentId 与任务直聊绑定冲突' })
        return true
      }
      const preset = String(body?.preset || '').trim()
      this.store.mutateTask(taskId, (t): WorkTask => {
        if (preset) t.agentPreset = preset
        else delete t.agentPreset
        return t
      })
      // 尽力即时生效：主会话（__node__）优先，否则主智能体（与 session-model 语义一致）
      const agentId = task.chatAgentId || (task.sessions?.['__node__']?.remoteSessionId ? '__node__' : this.planner.pickMainAgent()?.id || '')
      const binding = agentId ? task.sessions?.[agentId] : undefined
      if (!binding?.remoteSessionId) {
        this.sendJson(res, 200, { ok: true, data: { applied: false, reason: 'no-session', saved: true } })
        return true
      }
      const target = await this.engine.resolveExecTarget(task, agentId)
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
      const task = this.taskForView(taskId)
      if (!task) {
        this.sendJson(res, 404, { ok: false, error: 'Task not found' })
        return true
      }
      const agentId = task.chatAgentId || (task.sessions?.['__node__']?.remoteSessionId ? '__node__' : this.planner.pickMainAgent()?.id || '')
      const binding = agentId ? task.sessions?.[agentId] : undefined
      if (!binding?.remoteSessionId) {
        this.sendJson(res, 200, {
          ok: true,
          data: { session: null, taskModel: task.model || '', taskReasoningEffort: task.reasoningEffort || '', taskAgentPreset: task.agentPreset || '' },
        })
        return true
      }
      const target = await this.engine.resolveExecTarget(task, agentId)
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
      const task = this.taskForView(decodeURIComponent(taskPresetsMatch[1]))
      if (!task) {
        this.sendJson(res, 404, { ok: false, error: 'Task not found' })
        return true
      }
      const target = await this.engine.resolveExecTarget(task, task.chatAgentId || '__node__').catch(() => undefined)
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
      // §11：任务级模型/推理强度 = manage 级
      const mm = this.taskForManage(decodeURIComponent(taskModelMatch[1]))
      if (!mm.task) { this.sendJson(res, mm.forbidden ? 403 : 404, { ok: false, error: mm.forbidden ? '仅任务归属人或管理员可切换模型' : 'Task not found' }); return true }
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
      // §11：运行权限（沙箱/审批策略）= manage 级
      const pm = this.taskForManage(taskId)
      if (!pm.task) { this.sendJson(res, pm.forbidden ? 403 : 404, { ok: false, error: pm.forbidden ? '仅任务归属人或管理员可修改运行权限' : 'Task not found' }); return true }
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
    // 运行权限回读：读任务主会话的 harness 权限（preset/sandbox/approval/available），
    // 供聊天窗「🔒 权限」入口展示与选择；旧节点无该路由 → supported=false，前端隐藏入口。
    if (taskPermissionMatch && method === 'GET') {
      const taskId = decodeURIComponent(taskPermissionMatch[1])
      const task = this.taskForView(taskId)
      if (!task) {
        this.sendJson(res, 404, { ok: false, error: 'Task not found' })
        return true
      }
      const main = await this.resolveTaskMainSession(taskId)
      if (main.error || !main.target || !main.remoteSessionId) {
        this.sendJson(res, main.httpStatus || 409, {
          ok: false,
          error: main.error || '任务尚无可用的远端会话（先发一条消息建立会话后重试）',
          supported: true,
        })
        return true
      }
      const r = await this.client.getSessionPermission(main.target, main.remoteSessionId)
      if (r.supported === false) {
        this.sendJson(res, 501, { ok: false, error: r.error || '远端节点不支持运行权限接口', supported: false })
        return true
      }
      if (!r.ok) {
        this.sendJson(res, 409, { ok: false, error: r.error || '读取运行权限失败', supported: true })
        return true
      }
      this.sendJson(res, 200, {
        ok: true,
        data: {
          preset: r.preset || '',
          sandbox: r.sandbox || '',
          approval: r.approval || '',
          available: r.available || [],
          taskPermission: task.permission || '',
          agentId: main.agentId,
        },
      })
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
      // §11：队列管理 = manage 级
      const qm = this.taskForManage(decodeURIComponent(queueSendMatch[1]))
      if (!qm.task) { this.sendJson(res, qm.forbidden ? 403 : 404, { ok: false, error: qm.forbidden ? '仅任务归属人或管理员可操作消息队列' : 'Task not found' }); return true }
      const body = await this.parseBody(req)
      const out = await this.engine.sendQueuedNow(decodeURIComponent(queueSendMatch[1]), String(body?.turnId || ''))
      this.sendJson(res, out.ok ? 200 : 400, out)
      return true
    }
    // 队列「编辑」：更新排队消息文本（排队条目 + 对应排队轮次）
    const queueUpdateMatch = /^\/api\/tasks\/([^/]+)\/queue\/update$/.exec(p)
    if (queueUpdateMatch && method === 'POST') {
      const qm = this.taskForManage(decodeURIComponent(queueUpdateMatch[1]))
      if (!qm.task) { this.sendJson(res, qm.forbidden ? 403 : 404, { ok: false, error: qm.forbidden ? '仅任务归属人或管理员可操作消息队列' : 'Task not found' }); return true }
      const body = await this.parseBody(req)
      const out = this.engine.updateQueuedMessage(decodeURIComponent(queueUpdateMatch[1]), String(body?.turnId || ''), String(body?.text || ''))
      this.sendJson(res, out.ok ? 200 : 400, out)
      return true
    }
    // 队列「删除」：移出队列并删除该排队轮次
    const queueDeleteMatch = /^\/api\/tasks\/([^/]+)\/queue\/delete$/.exec(p)
    if (queueDeleteMatch && method === 'POST') {
      const qm = this.taskForManage(decodeURIComponent(queueDeleteMatch[1]))
      if (!qm.task) { this.sendJson(res, qm.forbidden ? 403 : 404, { ok: false, error: qm.forbidden ? '仅任务归属人或管理员可操作消息队列' : 'Task not found' }); return true }
      const body = await this.parseBody(req)
      const out = this.engine.deleteQueuedMessage(decodeURIComponent(queueDeleteMatch[1]), String(body?.turnId || ''))
      this.sendJson(res, out.ok ? 200 : 400, out)
      return true
    }
    // 重命名会话（对齐 DSH web 的 session.rename 动词）
    const renameMatch = /^\/api\/tasks\/([^/]+)\/rename$/.exec(p)
    if (renameMatch && method === 'POST') {
      const taskId = decodeURIComponent(renameMatch[1])
      // §11：改名 = manage 级
      const rm = this.taskForManage(taskId)
      if (!rm.task) { this.sendJson(res, rm.forbidden ? 403 : 404, { ok: false, error: rm.forbidden ? '仅任务归属人或管理员可重命名任务' : 'Task not found' }); return true }
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
      // §11：归档/恢复 = manage 级
      const am = this.taskForManage(taskId)
      if (!am.task) { this.sendJson(res, am.forbidden ? 403 : 404, { ok: false, error: am.forbidden ? '仅任务归属人或管理员可归档任务' : 'Task not found' }); return true }
      const body = await this.parseBody(req)
      const archived = Boolean(body?.archived)
      const updated = this.store.mutateTask(taskId, (t) => {
        t.archivedAt = archived ? (t.archivedAt || Date.now()) : undefined
        return t
      })
      if (updated) this.audit(archived ? 'task.archive' : 'task.restore', 'task', taskId, updated.title)
      if (!updated) this.sendJson(res, 404, { ok: false, error: 'Task not found' })
      else this.sendJson(res, 200, { ok: true, data: updated })
      return true
    }
    // 附件上传（multipart）→ 转发到各成员远端会话工作区
    const attachMatch = /^\/api\/tasks\/([^/]+)\/attachments$/.exec(p)
    if (attachMatch && method === 'POST') {
      const taskId = decodeURIComponent(attachMatch[1])
      const task = this.taskForView(taskId)
      if (!task) { this.sendJson(res, 404, { ok: false, error: 'Task not found' }); return true }
      if (task.projectId) requireProjectFiles(this.session, this.store.getProject(task.projectId), true)
      else requireNodeFiles(this.session)
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
      if (task.projectId) {
        const url = new URL(req.url || '/', 'http://localhost')
        url.searchParams.set('projectId', task.projectId)
        const scope = await this.resolveFsTarget(url, undefined, 'write')
        if (!scope.ok) { this.sendJson(res, scope.status, { ok: false, error: scope.error }); return true }
        const out = await this.saveProjectUploads({ target: scope.target, project: scope.project! }, projectFilePath(scope.project!), files, url.searchParams.get('expectedSha256') || undefined)
        if (out.body.files.length) {
          this.store.mutateTask(taskId, t => { t.attachments = [...(t.attachments || []), ...out.body.files.map(f => ({ name: f.name, path: f.path, size: f.size, agentId: '__node__', agentName: '项目文件', remoteSessionId: '', nodeBaseUrl: scope.target.baseUrl, source: 'relay' as const, uploadedAt: Date.now() }))] })
        }
        if (out.body.ok) {
          this.sendJson(res, 200, { ok: true, data: { ok: true, results: [{ agentId: '__node__', agentName: '项目文件', ok: true, files: out.body.files }] } })
        } else this.sendJson(res, out.status, out.body)
        return true
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
    // 附件 P2P 直传（控制面）：init 下发 DSH 节点直连配方（地址+密钥+会话+分片端点模板），
    // 客户端直传节点并在节点侧 complete，register 凭落盘路径登记附件（含跨节点下载 URL）
    const directInitMatch = /^\/api\/tasks\/([^/]+)\/attachments\/direct\/init$/.exec(p)
    if (directInitMatch && method === 'POST') {
      const taskId = decodeURIComponent(directInitMatch[1])
      const task = this.taskForView(taskId)
      if (!task) { this.sendJson(res, 404, { ok: false, error: 'Task not found' }); return true }
      if (task.projectId) requireProjectFiles(this.session, this.store.getProject(task.projectId), true)
      requireNodeFiles(this.session)
      const body = await this.parseBody(req)
      const result = await this.engine.directUploadInit(taskId, String(body?.name || ''), Number(body?.size) || 0, body?.mimeType ? String(body.mimeType) : undefined)
      this.sendJson(res, result.ok ? 200 : 400, { ok: result.ok, data: result.ok ? result : undefined, error: result.error })
      return true
    }
    const directRegMatch = /^\/api\/tasks\/([^/]+)\/attachments\/direct\/register$/.exec(p)
    if (directRegMatch && method === 'POST') {
      const taskId = decodeURIComponent(directRegMatch[1])
      const task = this.taskForView(taskId)
      if (!task) { this.sendJson(res, 404, { ok: false, error: 'Task not found' }); return true }
      if (task.projectId) requireProjectFiles(this.session, this.store.getProject(task.projectId), true)
      requireNodeFiles(this.session)
      const body = await this.parseBody(req)
      const result = await this.engine.directUploadRegister(
        taskId,
        String(body?.uploadId || ''),
        String(body?.path || ''),
        Number(body?.size) || 0,
        body?.mimeType ? String(body.mimeType) : undefined,
      )
      this.sendJson(res, result.ok ? 200 : 400, { ok: result.ok, data: result.ok ? result : undefined, error: result.error })
      return true
    }
    // 附件流式代理回退：浏览器 https 页面无法直连 http 节点（混合内容拦截）→ 文件体 PUT 给本端点，
    // 服务端边收边以 4MB 分片写入节点 resumable 会话（纯管道不落盘），完成后自动登记附件。
    // ⚠ 裸流端点：请求体不进 parseBody，必须先于任何会消费 body 的通用处理
    const directRelayMatch = /^\/api\/tasks\/([^/]+)\/attachments\/direct\/relay$/.exec(p)
    if (directRelayMatch && method === 'POST') {
      const taskId = decodeURIComponent(directRelayMatch[1])
      const task = this.taskForView(taskId)
      if (!task) { this.sendJson(res, 404, { ok: false, error: 'Task not found' }); return true }
      if (task.projectId) requireProjectFiles(this.session, this.store.getProject(task.projectId), true)
      requireNodeFiles(this.session)
      const url = new URL(req.url || '/', 'http://localhost')
      const uploadId = String(url.searchParams.get('uploadId') || '')
      try {
        const result = await this.engine.directUploadRelay(taskId, uploadId, req)
        this.sendJson(res, result.ok ? 200 : 400, { ok: result.ok, data: result.ok ? result : undefined, error: result.error })
      } catch (err: any) {
        this.sendJson(res, 500, { ok: false, error: err?.message || String(err) })
      }
      return true
    }
    // 会话工作区文件下载（代理成员远端 DSH，支持 AI 回复中的绝对/相对路径）
    const dlMatch = /^\/api\/tasks\/([^/]+)\/files\/download$/.exec(p)
    if (dlMatch && method === 'GET') {
      const taskId = decodeURIComponent(dlMatch[1])
      // §11：任务工作区文件下载随任务可见性
      const task = this.taskForView(taskId)
      if (!task) { this.sendJson(res, 404, { ok: false, error: 'Task not found' }); return true }
      const url = new URL(req.url || '/', 'http://localhost')
      const agent = url.searchParams.get('agent') || undefined
      const filePath = url.searchParams.get('path') || ''
      let projectDownload: Awaited<ReturnType<DshClient['fsDownload']>> | undefined
      if (task.projectId) {
        url.searchParams.set('projectId', task.projectId)
        const scope = await this.resolveFsTarget(url, undefined, 'read')
        if (!scope.ok) { this.sendJson(res, scope.status, { ok: false, error: scope.error }); return true }
        const checked = await this.projectFsPath(scope, filePath)
        projectDownload = await this.client.fsDownload(scope.target, checked.path)
      } else requireNodeFiles(this.session)
      try {
        const dl = projectDownload || await this.engine.prepareFileDownload(taskId, agent, filePath)
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
      // §11：SSE 事件流随任务可见性（此前仅登录门禁，任何用户可订阅任意任务流）
      if (!this.taskForView(taskId)) {
        this.sendJson(res, 404, { ok: false, error: 'Task not found' })
        return true
      }
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
      // §11：取消 = view 级 —— 前端「⏹ 停止生成」按钮走本路由，属会话协作动作
      //（停止当前轮 ≠ 删除任务；任务本体仍在），可见即可停，与发消息同权
      if (!this.taskForView(decodeURIComponent(cancelMatch[1]))) { this.sendJson(res, 404, { ok: false, error: 'Task not found' }); return true }
      const out = await this.engine.cancelTask(decodeURIComponent(cancelMatch[1]))
      // warnings = 远端中断未确认项（节点不可达/会话消失/旧版无 cancel）：本地已停，但如实告知
      this.sendJson(res, 200, {
        ok: true,
        data: { warnings: out.warnings },
        ...(out.warnings.length ? { warning: out.warnings.join('；') } : {}),
      })
      return true
    }
    // ---- 会话协作状态：goal / plan / compact（需要远端 dsh-web-service ≥ 0.3.9）----
    const collabMatch = /^\/api\/tasks\/([^/]+)\/(goal|plan|compact)$/.exec(p)
    if (collabMatch) {
      const taskId = decodeURIComponent(collabMatch[1])
      const kind = collabMatch[2]
      // §11：协作状态读写 = view 级（可见即可读写 goal/plan/compact）
      if (!this.taskForView(taskId)) { this.sendJson(res, 404, { ok: false, error: 'Task not found' }); return true }
      const allowed = (kind === 'goal' && (method === 'GET' || method === 'POST' || method === 'PUT'))
        || (kind === 'plan' && (method === 'GET' || method === 'PUT'))
        || (kind === 'compact' && method === 'POST')
      if (allowed) {
        const body = method === 'GET' ? {} : await this.parseBody(req).catch(() => ({}))
        const out = await this.handleTaskCollab(taskId, kind, method, body)
        this.sendJson(res, out.httpStatus, out.payload)
        return true
      }
    }
    // 主调度（Planner）配置：指定子智能体（默认自动挑本地）+ 主调度模型（聊天窗可选）
    if (p === '/api/planner/options' && method === 'GET') {
      const settings = this.store.getSettings()
      const picked = await this.planner.plannerTarget()
      let models: RemoteModelEntry[] = []
      let defaultModel: { provider?: string; model?: string; reasoningEffort?: string } | undefined
      const providers: string[] = []
      let modelError: string | undefined
      // 调度模型作用于「任务节点的主会话」（engine.ensureSession isMain 分支）——
      // 模型目录应跟随所选任务节点（?node=<mappingId>），而不是主智能体所在节点：
      // 两个节点是不同引擎时注册表互不相通（DSH 的 zai-coding-cn 在 ZCode 节点不存在）
      const url = new URL(req.url || '/', 'http://localhost')
      let nodeMappingId = (url.searchParams.get('node') || '').trim()
      let nodeSource: string | undefined
      let nodeError: string | undefined
      // 显式节点/任务解析失败时不得回退到规划器节点，否则会把其他 DSH 的目录冒充当前节点。
      const hasCatalogTarget = Boolean(nodeMappingId || url.searchParams.get('taskId')?.trim())
      let modelsBaseUrl = hasCatalogTarget ? undefined : picked.baseUrl
      let modelsApiKey = hasCatalogTarget ? undefined : picked.apiKey
      // taskId 权威模式：任务内的模型目录由服务端按任务/项目绑定节点解析（项目 dshRef 优先，
      // 与 engine.taskExec 同口径）。前端自己猜节点（node=）会因项目清单未加载/权限过滤而回退到
      // 所选执行位置，导致目录显示成另一个节点的引擎注册表（真实缺陷 2026-11-06：brain 项目
      // 任务里弹出了公司笔记本的模型目录）。带 taskId 时 node= 仅作展示回显，不再作为数据源。
      const taskIdQ = (url.searchParams.get('taskId') || '').trim()
      if (taskIdQ) {
        if (!this.taskForView(taskIdQ)) { this.sendJson(res, 404, { ok: false, error: 'Task not found' }); return true }
        const task = this.store.getTask(taskIdQ)
        const taskRef = task ? this.engine.taskExec(task).dshRef : undefined
        nodeMappingId = taskRef?.kind === 'mapping' ? taskRef.mappingId : ''
        const target = task
          ? await this.engine.resolveExecTarget(task, '__node__').catch(() => undefined)
          : undefined
        if (target?.online && target.baseUrl) {
          modelsBaseUrl = target.baseUrl
          modelsApiKey = target.apiKey
          nodeMappingId = (target as any).mappingId || nodeMappingId
          const ep = nodeMappingId ? this.directory.resolveMapping(nodeMappingId) : undefined
          nodeSource = ep?.appName || ep?.tunnelName || nodeMappingId || '直连节点'
        } else if (task && !this.engine.taskExec(task).dshRef) {
          // 存量未绑定任务实际由规划器执行（engine.executeTask 同口径），这不是离线节点回退。
          modelsBaseUrl = picked.baseUrl
          modelsApiKey = picked.apiKey
          nodeMappingId = ''
          nodeSource = picked.source
          if (!modelsBaseUrl) modelError = picked.error || '任务执行节点不可达'
        } else {
          nodeError = (target as any)?.error || '任务节点不可达'
          modelError = nodeError
        }
      }
      if (nodeMappingId && !taskIdQ) {
        // 与 Android 的 /agents/models 使用同一解析器：刷新映射入口并只取本节点凭证。
        const target = await this.resolver.resolveRef({ kind: 'mapping', mappingId: nodeMappingId }, undefined, 'model-catalog').catch(() => undefined)
        if (!target?.online || !target.baseUrl) {
          nodeError = target?.error || '节点不可达'
          modelError = nodeError
        } else {
          modelsBaseUrl = target.baseUrl
          modelsApiKey = target.apiKey
          const ep = this.directory.resolveMapping(nodeMappingId)
          nodeSource = ep?.appName || ep?.tunnelName || nodeMappingId
        }
      }
      if (modelsBaseUrl) {
        // 必须带上解析出的 apiKey：远程 DSH 节点的 /models 需要鉴权，无 key 会 401 → 列表静默变空
        const target = { baseUrl: modelsBaseUrl, online: true, resolvedAt: new Date().toISOString(), mappingId: nodeMappingId || '', apiKey: modelsApiKey }
        const mr = await this.client.getModels(target as any)
        models = mr.ok ? mr.models || [] : []
        defaultModel = mr.ok ? mr.defaultModel : undefined
        if (!mr.ok && !modelError) modelError = mr.error || '模型目录获取失败'
        for (const m of models) if (m.provider && !providers.includes(m.provider)) providers.push(m.provider)
      }
      this.sendJson(res, 200, {
        ok: true,
        data: {
          agents: this.store.getAgents().map(a => ({ id: a.id, name: a.name })),
          models,
          defaultModel,
          providers,
          current: { agentId: picked.agentId, auto: picked.auto !== false, model: settings.planner.model },
          source: picked.source,
          error: picked.error,
          modelError,
          node: nodeMappingId || undefined,
          nodeSource,
          nodeError,
        },
      })
      return true
    }
    if (p === '/api/planner/config' && method === 'POST') {
      const body = await this.parseBody(req)
      // §11 分流：带 taskId = 任务会话内主智能体切换/成员账本同步（全员日常操作）；
      // 不带 taskId = 全局规划器/默认模型配置（设置页入口），仅平台管理员
      if (!body?.taskId && !this.isAdminOrServiceChannel()) { this.denyNotAdmin(res, '修改全局规划器配置'); return true }
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
      // §11：子任务重试/追问/会话查看 = view 级（可见即可协作）
      if (!this.taskForView(decodeURIComponent(retryMatch[1]))) { this.sendJson(res, 404, { ok: false, error: 'Task not found' }); return true }
      const out = await this.engine.retrySubtask(decodeURIComponent(retryMatch[1]), decodeURIComponent(retryMatch[2]))
      this.sendJson(res, out.ok ? 200 : 400, out)
      return true
    }
    const chatMatch = /^\/api\/tasks\/([^/]+)\/subtasks\/([^/]+)\/chat$/.exec(p)
    if (chatMatch && method === 'GET') {
      if (!this.taskForView(decodeURIComponent(chatMatch[1]))) { this.sendJson(res, 404, { ok: false, error: 'Task not found' }); return true }
      const out = await this.subtaskChat(decodeURIComponent(chatMatch[1]), decodeURIComponent(chatMatch[2]))
      this.sendJson(res, 200, { ok: out.ok, data: out })
      return true
    }
    const followupMatch = /^\/api\/tasks\/([^/]+)\/subtasks\/([^/]+)\/followup$/.exec(p)
    if (followupMatch && method === 'POST') {
      const taskId = decodeURIComponent(followupMatch[1])
      if (!this.taskForView(taskId)) { this.sendJson(res, 404, { ok: false, error: 'Task not found' }); return true }
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
      const task = this.taskForView(taskId)
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

    // ---------- 协作群（契约 docs/groups-web-sync-plan-2026-11-11.md §2；每用户 scope 隔离，v1 无共享群） ----------
    // 身份只取 session.userId（review P13：调用方身份绝不可来自请求体）；无登录身份一律 401，不落共享桶（review P5）
    const groupUser = (): string | undefined => {
      const uid = this.session?.userId
      if (!uid) this.sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', error: '群功能需要登录身份' })
      return uid
    }
    // 存储错误码 → HTTP：SECTION_CONFLICT→409；INVALID_PARAM→400；STORE_*/意外异常→500 不得压 400（W1-6/契约 §2 写口严格口径）
    const groupFail = (err: unknown): void => {
      const e = err as any
      const code = e instanceof GroupStoreError ? e.code : 'INTERNAL_ERROR'
      const status = code === 'SECTION_CONFLICT' ? 409 : code === 'INVALID_PARAM' ? 400 : 500
      this.sendJson(res, status, { ok: false, code, error: e?.message || String(err) })
    }
    if (p === '/api/groups' && method === 'GET') {
      const uid = groupUser()
      if (!uid) return true
      this.sendJson(res, 200, { ok: true, data: this.groupStore.list(uid) })
      return true
    }
    if (p === '/api/groups' && method === 'POST') {
      const uid = groupUser()
      if (!uid) return true
      const body = await this.parseBody(req)
      try {
        // POST = 整实体 create/upsert（缺 id 服务端生成）；同 id 覆盖时保 createdAt/createdBy（服务端权威，review P10）
        const bodyId = typeof body?.id === 'string' ? body.id.trim() : ''
        const existing = bodyId ? this.groupStore.get(uid, bodyId) : undefined
        const id = existing?.id ?? bodyId ?? ''
        const room = normalizeGroupRoom(body, undefined, {
          id: id || randomUUID(),
          now: Date.now(),
          createdAt: existing?.createdAt,
          createdBy: existing?.createdBy ?? (this.session?.username || uid),
          prevLastReadSeq: existing?.lastReadSeq,
        })
        this.sendJson(res, 200, { ok: true, data: this.groupStore.upsert(uid, room) })
      } catch (err) {
        groupFail(err)
      }
      return true
    }
    const groupMatch = /^\/api\/groups\/([^/]+)$/.exec(p)
    if (groupMatch) {
      const uid = groupUser()
      if (!uid) return true
      const roomId = decodeURIComponent(groupMatch[1])
      const existing = this.groupStore.get(uid, roomId)
      if (method === 'GET') {
        if (!existing) { this.sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: '群不存在' }); return true }
        this.sendJson(res, 200, { ok: true, data: existing })
        return true
      }
      if (method === 'PUT') {
        // PUT = 部分字段更新：mergeBase=existing 后走 upsert 幂等语义；不存在 → 404（lead 裁定②）
        if (!existing) { this.sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: '群不存在' }); return true }
        const body = await this.parseBody(req)
        try {
          const room = normalizeGroupRoom(body, existing, {
            id: existing.id,
            now: Date.now(),
            createdAt: existing.createdAt,
            createdBy: existing.createdBy,
            prevLastReadSeq: existing.lastReadSeq,
          })
          this.sendJson(res, 200, { ok: true, data: this.groupStore.upsert(uid, room) })
        } catch (err) {
          groupFail(err)
        }
        return true
      }
      if (method === 'DELETE') {
        // 不存在静默幂等（200 deleted:false）；级联清 rounds 孤儿键（契约 §1）
        const deleted = this.groupStore.delete(uid, roomId)
        if (deleted) this.audit('group.delete', 'group', roomId, existing?.name)
        this.sendJson(res, 200, { ok: true, data: { deleted } })
        return true
      }
    }
    if (p === '/api/group-sections' && method === 'GET') {
      const uid = groupUser()
      if (!uid) return true
      this.sendJson(res, 200, { ok: true, data: this.groupStore.sections(uid) })
      return true
    }
    if (p === '/api/group-sections' && method === 'POST') {
      const uid = groupUser()
      if (!uid) return true
      const body = await this.parseBody(req)
      try {
        this.sendJson(res, 200, { ok: true, data: this.groupStore.addSection(uid, body?.name) })
      } catch (err) {
        groupFail(err)
      }
      return true
    }
    const groupSectionMatch = /^\/api\/group-sections\/([^/]+)$/.exec(p)
    if (groupSectionMatch) {
      const uid = groupUser()
      if (!uid) return true
      const name = decodeURIComponent(groupSectionMatch[1])
      if (method === 'PUT') {
        const body = await this.parseBody(req)
        try {
          const r = this.groupStore.renameSection(uid, name, body?.to)
          this.sendJson(res, 200, { ok: true, data: r })
        } catch (err) {
          groupFail(err)
        }
        return true
      }
      if (method === 'DELETE') {
        // 空白名 400（lead 裁定③）；不存在有效名静默幂等；级联 rooms.section 置 ""
        try {
          this.sendJson(res, 200, { ok: true, data: this.groupStore.removeSection(uid, name) })
        } catch (err) {
          groupFail(err)
        }
        return true
      }
    }
    const groupRoundsMatch = /^\/api\/groups\/([^/]+)\/rounds$/.exec(p)
    if (groupRoundsMatch) {
      const uid = groupUser()
      if (!uid) return true
      const roomId = decodeURIComponent(groupRoundsMatch[1])
      if (method === 'GET') {
        if (!this.groupStore.get(uid, roomId)) { this.sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: '群不存在' }); return true }
        this.sendJson(res, 200, { ok: true, data: this.groupStore.rounds(uid, roomId) })
        return true
      }
      if (method === 'POST') {
        if (!this.groupStore.get(uid, roomId)) { this.sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: '群不存在' }); return true }
        const body = await this.parseBody(req)
        const taskId = typeof body?.taskId === 'string' ? body.taskId.trim() : ''
        if (!taskId) { this.sendJson(res, 400, { ok: false, code: 'INVALID_PARAM', error: 'taskId 必须是非空字符串' }); return true }
        this.sendJson(res, 200, { ok: true, data: this.groupStore.addRound(uid, roomId, taskId) })
        return true
      }
    }
    const groupReadMatch = /^\/api\/groups\/([^/]+)\/read$/.exec(p)
    if (groupReadMatch && method === 'POST') {
      const uid = groupUser()
      if (!uid) return true
      const roomId = decodeURIComponent(groupReadMatch[1])
      if (!this.groupStore.get(uid, roomId)) { this.sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: '群不存在' }); return true }
      const body = await this.parseBody(req)
      const seq = body?.lastReadSeq
      if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) {
        this.sendJson(res, 400, { ok: false, code: 'INVALID_PARAM', error: 'lastReadSeq 必须是非负整数' })
        return true
      }
      // markRead 存储层同步读-改-写，单调不回退（契约 §1；review P8）
      this.sendJson(res, 200, { ok: true, data: this.groupStore.markRead(uid, roomId, seq) })
      return true
    }

    // ---------- SSH 资源池（本地补充资源，沿袭 orchestrator） ----------
    // 权限（§10.3）：归属人/平台 admin/项目绑定成员可见可用；取明文与改删仅归属人+admin
    if (p === '/api/ssh-resources' && method === 'GET') {
      const ctx = this.permContext()
      const list = this.sshStore.list().filter((r) => canViewResource(this.session, r, ctx))
      this.sendJson(res, 200, { ok: true, data: list.map(maskSshResource) })
      return true
    }
    if (p === '/api/ssh-resources' && method === 'POST') {
      const body = await this.parseBody(req)
      try {
        const existing = body.id ? this.sshStore.get(String(body.id)) : undefined
        if (existing && !canManageResource(this.session, existing)) {
          this.sendJson(res, 403, { ok: false, error: '无权修改该 SSH 资源（仅归属人或管理员可改）' })
          return true
        }
        // 归属人由服务端权威写入：新建 = 当前用户；更新 = 保持原归属（不接受客户端传入）。
        // 存量资源（无归属）保持无归属 —— 管理员编辑一次不得把它变成个人私有资产。
        const ownerUserId = existing
          ? existing.ownerUserId
          : this.session?.userId
        const saved = this.sshStore.upsert(normalizeSshResource({ ...body, ownerUserId }, existing))
        this.sendJson(res, 200, { ok: true, data: maskSshResource(saved) })
      } catch (err: any) {
        this.sendJson(res, 400, { ok: false, error: err instanceof SshInputError ? err.message : err?.message })
      }
      return true
    }
    const sshMatch = /^\/api\/ssh-resources\/([^/]+)$/.exec(p)
    if (sshMatch) {
      const sshId = decodeURIComponent(sshMatch[1])
      const r = this.sshStore.get(sshId)
      if (method === 'GET') {
        if (!r || !canViewResource(this.session, r, this.permContext())) {
          this.sendJson(res, 404, { ok: false, error: 'not found' })
          return true
        }
        // 明文凭据仅归属人/管理员可见；其余成员拿到脱敏视图
        const canManage = canManageResource(this.session, r)
        this.sendJson(res, 200, { ok: true, data: canManage ? r : maskSshResource(r) })
        return true
      }
      if (method === 'DELETE') {
        if (!r) {
          this.sendJson(res, 404, { ok: false, error: 'not found' })
          return true
        }
        if (!canManageResource(this.session, r)) {
          this.sendJson(res, 403, { ok: false, error: '无权删除该 SSH 资源（仅归属人或管理员可删）' })
          return true
        }
        this.audit('ssh-resource.delete', 'ssh-resource', sshId, r.name)
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
      if (!canUseResource(this.session, r, this.permContext())) {
        this.sendJson(res, 403, { ok: false, error: '无权使用该 SSH 资源' })
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
      if (!canUseResource(this.session, r, this.permContext())) {
        this.sendJson(res, 403, { ok: false, error: '无权使用该 SSH 资源' })
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
      if (sub.result?.content) messages.push({ role: 'assistant', content: sub.result.content, time: sub.completedAt, model: sub.model, local: true })
      return { ok: true, source: 'local', note, messages }
    }
    // A legacy subtask session ID alone cannot identify the physical node that created it.
    const remoteSessionId = task.sessions?.[sub.agentId]?.remoteSessionId
    if (!remoteSessionId) return localFallback('缺少远程会话节点绑定，以下为本地缓存记录')
    // 子任务执行者：子智能体实体或任务节点主会话伪成员（__node__，主智能体自留子任务）；
    // resolveExecTarget 两者通吃（实体成员回自身绑定节点，__node__ 走任务节点）
    const isNodeMain = sub.agentId === NODE_AGENT_ID
    if (!isNodeMain && !this.store.getAgent(sub.agentId)) return { ok: false, error: '子智能体不存在' }
    const target = await this.engine.resolveExecTarget(task, sub.agentId)
    if (!target?.online) return localFallback('远端节点当前不可达，以下为本地缓存记录')
    const hist = await this.client.getHistory(target, remoteSessionId)
    if (!hist.ok) return localFallback(`远端会话记录读取失败（${hist.error}），以下为本地缓存记录`)
    // 过滤 harness 注入的上下文噪音（system-reminder / runtime-context 快照），只留业务对话
    const isNoise = (m: any): boolean => {
      const c = typeof m?.content === 'string' ? m.content : ''
      return c.startsWith('<system-reminder>') || c.startsWith('Current runtime context.') || c.startsWith('<system>')
    }
    const messages = (hist.messages || []).filter((m: any) => !isNoise(m))
    // 远端 history 不带模型标注：子任务记录有实际模型时按会话粒度补齐（子任务会话内模型通常一致；缺记录时不编造）
    if (sub.model) {
      for (const m of messages) {
        if (m?.role === 'assistant' && !m.model) m.model = sub.model
      }
    }
    // 旧版远端 dsh-web-service 的 history 可能缺 assistant 消息 —— 用本地缓存产出补齐
    const hasAssistant = messages.some((m) => m?.role === 'assistant' && String(m?.content || '').trim())
    if (!hasAssistant && sub.result?.content) {
      messages.push({ role: 'assistant', content: sub.result.content, time: sub.completedAt, model: sub.model, local: true })
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
    const remoteSessionId = session?.remoteSessionId
    if (!remoteSessionId) return { ok: false, error: '子任务缺少远程会话节点绑定，不能向当前节点发送旧会话 ID' }
    // 执行者：子智能体实体或任务节点主会话伪成员（__node__，主智能体自留子任务）；
    // resolveExecTarget 两者通吃（实体成员回自身绑定节点，__node__ 走任务节点）
    const isNodeMain = sub.agentId === NODE_AGENT_ID
    if (!isNodeMain && !this.store.getAgent(sub.agentId)) return { ok: false, error: '子智能体不存在' }
    const target = await this.engine.resolveExecTarget(task, sub.agentId)
    if (!target?.online) return { ok: false, error: target?.error || '节点不可达' }
    const res = await this.client.prompt(target, remoteSessionId, message, { timeoutMs: 120_000 })
    if (res.ok) return { ok: true, reply: res.content }
    return { ok: false, error: res.error }
  }

  /**
   * 由专家档案实例化子智能体（POST /api/experts 旧语义 + POST /api/experts/:id/instantiate 共用）：
   * persona（role/systemPrompt/executionPrompt）从档案复制为快照——之后用户在子智能体上独立编辑，
   * 不会随档案自动同步；expertSource 由服务端权威生成（revision = 本次写入人格内容哈希），
   * 供 UI/排查识别「已落后于源档案」。
   */
  private async instantiateExpertFromRequest(
    req: IncomingMessage,
    res: ServerResponse,
    expertIdFromUrl: string,
    legacyBody?: { id?: string; expertId?: string },
  ): Promise<boolean> {
    const body = legacyBody ?? await this.parseBody(req)
    const expertId = String(expertIdFromUrl || ((body?.id ?? body?.expertId) ?? '')).trim()
    if (!expertId) {
      this.sendJson(res, 400, { ok: false, error: '缺少专家标识（URL /:id 或 body.id）' })
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
    if (workDir && !isNodeAbsolutePath(workDir)) {
      this.sendJson(res, 400, { ok: false, error: WORK_DIR_NOT_ABSOLUTE_MSG })
      return true
    }
    const saved = this.store.upsertAgent({
      ...(fallback ?? {}),
      ...(body ?? {}),
      // 兜底 id 仅为 upsertAgent 的内部提示（新实体 id 由 store 随机生成 agent-…），避免持久实体占用
      // expert- 前缀命名空间（该前缀是存量动态专家伪 id 域；新伪 id 前缀见 types.ts EXPERT_AGENT_ID_PREFIX）
      id: body?.agentId || `agent-${expertId}`,
      name: String(body?.name ?? profile.name),
      role: profile.role || profile.name,
      systemPrompt: profile.systemPrompt,
      executionPrompt: profile.executionPrompt,
      expertSource: buildExpertSource({ id: profile.id, name: profile.name, role: profile.role, systemPrompt: profile.systemPrompt, executionPrompt: profile.executionPrompt }),
      dshRef: dshRef as DshRef,
      workDir: workDir || undefined,
      enabled: body?.enabled ?? true,
    } as Partial<SubAgent>)
    this.sendJson(res, 200, { ok: true, data: { agent: saved, expert: profile } })
    return true
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

export function normalizeDshRef(input: any): DshRef | { error: string } {
  if (!input || typeof input !== 'object') return { error: '缺少 dshRef（DSH 实体引用）' }
  const mappingId = String(input.mappingId || '').trim()
  const appId = String(input.appId || '').trim()
  const apiBaseUrl = String(input.apiBaseUrl || '').trim()
  if (input.kind === 'mapping' && mappingId) return { kind: 'mapping', mappingId }
  if (input.kind === 'app' && appId) return { kind: 'app', appId }
  if (input.kind === 'direct' && apiBaseUrl) return { kind: 'direct', apiBaseUrl }
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
