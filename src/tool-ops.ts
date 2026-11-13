/**
 * onenat-workbuddy-web - Tool Ops（宿主无关的工具能力层）
 *
 * 独立 WEB 服务：由 src/server.ts 暴露为 HTTP 工具通道 GET/POST /api/tools[/:name]。
 * 本文件严禁 import 任何 DSH / cordis 包，保证独立部署零依赖 DSH。
 */

import { createHash, randomUUID } from 'node:crypto'

import { DshClient } from './remote-client.js'
import type { OnenatDirectory } from './onenat.js'
import type { TaskEngine } from './engine.js'
import type { AgentResolver } from './resolver.js'
import type { PromptComposer } from './prompt-composer.js'
import type { Orchestrator } from './orchestrator.js'
import type { MonitorService } from './monitor.js'
import type { WorkStore } from './store.js'
import { isNodeAbsolutePath, WORK_DIR_NOT_ABSOLUTE_MSG } from './store.js'
import type { SshResourceStore } from './ssh-store.js'
import type { ScheduleRunner } from './scheduler.js'
import { normalizeRule, nextRun, ruleText } from './scheduler.js'
import { execOnSshResource, maskSshResource, normalizeSshResource, testSshResource } from './ssh-resources.js'
import { GroupStore, GroupStoreError, normalizeGroupRoom } from './groups.js'
import { normalizeDshRef } from './router.js'
import { dshRefKey, sameDshRef, ProjectWorkspaceConflictError, ProjectWorkspacePathError } from './workspace.js'
import { canAccessProject, canAccessResource, canUseAgent, canViewTask, type PermSession } from './perm.js'
import { requireProjectFiles, requireNodeFiles, projectFilePath, workspaceChild, requireWorkspacePath, checkWorkspaceFsPath, writeProjectFile, WorkspaceFileError } from './workspace-files.js'
import type { Project } from './types.js'
import type { ExpertRegistry } from './expert-registry.js'
import { BUILTIN_TEAMS, parseTeamInput } from './expert-teams.js'
import { projectDefaultAgentIds, projectDefaultAgentIdsFromInput } from './types.js'
import { createBacklogManageTool } from './backlog-tool.js'
import { taskPreflight } from './task-preflight.js'
import { taskReadFields, taskChatTargets, ledgerMessages } from './task-read.js'
import { toolInputSchema, validateToolArgs } from './tool-contracts.js'
import { normalizeToolResult, toolFailure } from './tool-errors.js'
import { ProjectAgents } from './project-agents.js'
import { queryProjects, compactProject } from './project-query.js'
import { queryMonitorOverview } from './monitor-query.js'

import { createCapabilitiesTool } from './capabilities.js'
import { toolActionPolicy, toolAnnotations } from './tool-policy.js'
import { TOOL_OUTPUT_SCHEMA } from './tool-output.js'

export type ToolParamType = 'string' | 'json'

export interface ToolParamDef {
  type: ToolParamType
  description: string
}

/**
 * 工具调用上下文（通道能力声明）。
 *
 * 存在的理由：不同宿主能承受的阻塞时长差别巨大 ——
 *  - HTTP 工具通道（AI 技能 / wb.mjs）可以安心阻塞几分钟，`wait` 就是同步等结果；
 *  - 小智等 MCP 宿主等不住长调用（历史上正是长阻塞/大回包把会话打断，平台重发整轮请求 → 同一任务被建三遍），
 *    因此 MCP 通道 maxBlockMs 很小，长任务一律「立即回执 + 下次轮询取结果」。
 */
export interface ToolCallContext {
  /** 调用通道：mcp（小智等 MCP 宿主）/ http（工具通道 REST） */
  channel: 'mcp' | 'http'
  /** 调用方标识（MCP 接入点 id / http） */
  callerId?: string
  /** JSON-RPC id（MCP 通道，便于与平台侧日志对齐） */
  rpcId?: string | number | null
  /** 本通道单次调用允许阻塞的最长时间（毫秒）；0 = 不允许阻塞 */
  maxBlockMs: number
  /**
   * 本次请求的访问基址（scheme://host[/prefix]，反代场景按 x-forwarded-* 推导）。
   * 工具需要回传「调用方可直接访问」的绝对端点时优先用它（如大文件分片上传）——
   * consoleUrl 是服务端自视角，反代/公网入口下对调用方不可达。
   */
  requestBase?: string
  /**
   * 调用方仅持 AI 令牌（无控制台登录会话）：低信任通道。
   * 安全基线（task-51 V7）：AI 令牌禁止读取 SSH 明文凭据、禁止经 SSH 通道任意 exec。
   */
  aiTokenOnly?: boolean
  /** Server-authenticated observational credential; never sourced from tool arguments. */
  readOnly?: boolean
  /** Validated console identity, supplied by the server; never accepted from tool arguments. */
  session?: PermSession
}

/** 默认上下文：HTTP 工具通道（AI 技能）按老行为可长阻塞 */
export const HTTP_TOOL_CTX: ToolCallContext = { channel: 'http', maxBlockMs: 600_000 }

function ctxOf(ctx?: ToolCallContext): ToolCallContext {
  return ctx && typeof ctx.maxBlockMs === 'number' ? ctx : HTTP_TOOL_CTX
}

/** AI 令牌（低信任）调用 SSH 高危操作时的统一拒绝（task-51 V7 安全基线） */
function denyAiTokenSsh(action: string, resourceId: string): string {
  console.warn(`[安全审计] AI 令牌尝试 SSH ${action} 已拒绝（resource=${resourceId || 'unknown'}）`)
  return JSON.stringify({
    ok: false, code: 'PERMISSION_DENIED',
    error: `AI 令牌无权执行 SSH ${action}（安全基线：AI 令牌禁止读取 SSH 明文凭据与远程执行；请在控制台登录后操作）`,
    denied: 'ai-token-ssh-guard',
  })
}

/** 数值区间收敛 */
function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min
  return Math.min(Math.max(n, min), max)
}

/** 文本预览（列表/摘要回包统一截断，避免把整段日志塞进 MCP 单帧） */
function preview(text: unknown, max: number): string {
  const s = String(text ?? '')
  return s.length > max ? `${s.slice(0, max)}…（共 ${s.length} 字，已截断）` : s
}

/** create 幂等指纹：同项目/执行节点下，同内容（标题+正文+成员+模式）在窗口内重复到达 → 复用既有任务 */
const CREATE_DEDUP_WINDOW_MS = 120_000
const createDedupe = new Map<string, { at: number; taskId: string }>()

/** send 幂等窗口：同任务 + 同正文在窗口内重复到达 → 忽略重复投递（同样是「整轮重跑」的副产物） */
const SEND_DEDUP_WINDOW_MS = 60_000
const sendDedupe = new Map<string, number>()

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex')
}

function pruneSendDedupe(): void {
  const now = Date.now()
  for (const [k, at] of sendDedupe) {
    if (now - at > SEND_DEDUP_WINDOW_MS) sendDedupe.delete(k)
  }
}

function createFingerprint(title: unknown, message: unknown, memberIds: string[], mode: unknown, projectId: string | undefined, nodeKey: string | undefined, chatAgentId?: string, teamId?: string): string {
  const material = [String(title ?? '').trim(), String(message ?? '').trim(), [...memberIds].sort().join(','), String(mode ?? ''), projectId || '', nodeKey || '', chatAgentId || '', teamId || ''].join('\u0001')
  return createHash('sha1').update(material).digest('hex')
}

/** 近似重试去重窗口（模型换措辞重发同一条指令）：5 分钟 */
const CREATE_FUZZY_WINDOW_MS = 5 * 60_000

/** 取消息首句并规范化：按 。！？!? 切第一段、去空白、截 80 字；不足 8 字返回空（不参与近似去重） */
function firstSentenceKey(text: unknown): string {
  const first = String(text ?? '').trim().split(/[。！？!?]/)[0] || ''
  const key = first.replace(/\s+/g, '').slice(0, 80)
  return key.length >= 8 ? key : ''
}

/** 异步追问登记表：MCP 通道不阻塞等回复，回复状态由后续 task_chat 查询 */
const followupState = new Map<string, { at: number; status: 'running' | 'done' | 'error'; preview?: string; error?: string; ms?: number }>()
const FOLLOWUP_KEEP_MS = 15 * 60_000

function pruneFollowups(): void {
  const now = Date.now()
  for (const [k, v] of followupState) {
    if (v.status !== 'running' && now - v.at > FOLLOWUP_KEEP_MS) followupState.delete(k)
  }
}

export interface WorkBuddyToolDef {
  name: string
  description: string
  parameters: Record<string, ToolParamDef>
  /** Shared model-facing contract; execution validates this contract on every channel. */
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations?: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
  execute(args: Record<string, any>, ctx?: ToolCallContext): Promise<string>
  /** Optional authorization check before replaying a cached MCP result (not a model-facing parameter). */
  canReplay?(args: Record<string, any>, ctx: ToolCallContext, result: string): boolean
  /** 声明后：AI 令牌（无登录身份）调用本工具的全部 action 在参数校验之前一律拒绝（先身份后校验，契约 §3） */
  denyAiToken?: boolean
}

export interface ToolOpsDeps {
  store: WorkStore
  directory: OnenatDirectory
  resolver: AgentResolver
  composer: PromptComposer
  planner: Orchestrator
  engine: TaskEngine
  sshStore: SshResourceStore
  /** 协作群存储（group_manage 用）：server.ts 单例装配（裁定 A）注入；未装配时该工具返回错误，不做懒建兜底（防双实例互相覆盖） */
  groupsStore?: GroupStore
  /** 监控服务（monitor_read 用；未装配时该工具返回错误） */
  monitor?: MonitorService
  /** 调度器（schedule_manage 的 run 手动触发用） */
  scheduler?: ScheduleRunner
  /** 统一专家注册表（expert_manage 用；未装配时该工具返回错误） */
  expertRegistry?: ExpertRegistry
  /** 控制台地址（回显给调用方，便于人接手查看 UI） */
  consoleUrl: string
  serverVersion?: string
  /**
   * 签名下载令牌服务（task-54：超大任务详情回传聊天内容下载 URL 用）。
   * 仅需 downloadToken(id, ttlMs) 签发 `exp.sig` 形态的 HMAC 短期令牌；
   * 服务端校验复用同一实现（router 的 chat-export 端点），id 形态固定为 `chat-export:<taskId>`。
   */
  downloadTokens?: { downloadToken(id: string, ttlMs?: number): string }
}

/** 解析工具入参（HTTP 通道过来的是对象，模型通道过来的可能是 JSON 字符串） */
function asJson(value: unknown): any {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return undefined
    }
  }
  return value
}

export function createWorkBuddyToolDefs(deps: ToolOpsDeps): WorkBuddyToolDef[] {
  const { store, directory, resolver, composer, planner, engine, sshStore, groupsStore, consoleUrl } = deps
  const client = new DshClient()

  /**
   * 超大任务详情降级阈值（task-54）：detail:"full" 序列化后超过该字节数时不回全文，
   * 改回「摘要 + chatDownloadUrl」，调用方再 GET /api/tasks/:id/chat-export 取完整聊天内容。
   * 取 32KB：低于 MCP 单帧上限 64KB（MAX_RESULT_BYTES），给 JSON.stringify 的缩进与信封留余量。
   */
  const TASK_FULL_OVERSIZE_BYTES = 32 * 1024
  const CHAT_EXPORT_TOKEN_TTL_MS = 10 * 60_000

  // 1. 资源目录（只读透传 ONENAT）
  const resourceManage: WorkBuddyToolDef = {
    name: 'workbuddy_resource_manage',
    description:
      '查询 OneNat 隧道资源目录（SSH / DSH / HTTP 应用，公网入口实时解析）：list 列出全部资源、dsh 只列 DSH 算力节点、resolve 解析单个映射当前入口、refresh 强制刷新',
    parameters: {
      action: { type: 'string', description: '操作: list / dsh / resolve / refresh' },
      mappingId: { type: 'string', description: '映射 ID（resolve 操作用）' },
    },
    async execute(args) {
      const action = args.action || 'list'
      try {
        if (action === 'refresh') {
          const snap = await directory.refresh(true)
          return JSON.stringify({ ok: true, fetchedAt: snap.fetchedAt, count: directory.listEndpoints().length })
        }
        if (action === 'resolve') {
          await directory.refresh(true)
          const ep = directory.resolveMapping(String(args.mappingId || ''))
          return JSON.stringify({ ok: Boolean(ep), ...(ep ? {} : { code: 'NOT_FOUND', field: 'mappingId', error: '资源不存在' }), endpoint: ep }, null, 2)
        }
        await directory.refresh(false)
        const endpoints = action === 'dsh' ? directory.listDshEndpoints() : directory.listEndpoints()
        return JSON.stringify(
          {
            ok: true,
            fetchedAt: directory.current()?.fetchedAt,
            count: endpoints.length,
            endpoints: endpoints.map((e) => ({
              mappingId: e.mappingId,
              name: e.appName ?? e.note,
              kind: e.kind,
              online: e.online,
              entry: e.kind === 'ssh' ? `ssh -p ${e.port} @${e.host}` : e.baseUrl || `${e.proto}://${e.host}:${e.port}`,
              tunnel: e.tunnelName,
              skills: e.appSkills?.map((s) => s.name),
            })),
            consoleUrl,
          },
          null,
          2,
        )
      } catch (err: any) {
        return JSON.stringify({ ok: false, error: err?.message || String(err) })
      }
    },
  }

  // 2. 子智能体管理
  const agentManage: WorkBuddyToolDef = {
    name: 'workbuddy_agent_manage',
    description:
      '管理 WorkBuddy 子智能体（绑定 ONENAT 上 DSH 实体，端口漂移免疫）: list / upsert / delete / ping / preview（资源提示词预览）/ models（远端可用模型）/ presets（远端预设）/ enable / disable；projects 查询正式关联与历史参与项目，link_project/unlink_project 幂等关联/解除。',
    parameters: {
      action: { type: 'string', description: '操作: list / upsert / delete / ping / preview / models / presets / enable / disable' },
      agent: {
        type: 'json',
        description:
          '子智能体配置（upsert 用）: { id?, name, dshRef: {kind:"mapping",mappingId} | {kind:"app",appId} | {kind:"direct",apiBaseUrl}, apiKey?, agentPreset?, provider?, model?, systemPrompt?, workDir?, resources?: [{ref:{kind:"mapping",mappingId}, alias?, credentialMode:"inline|self-fetch|omit", skillMode:"all|none|{names}", note?}] }',
      },
      agentId: { type: 'string', description: '目标 BOT 稳定 ID（除 list/upsert 外必填）' },
      projectId: { type: 'string', description: 'link_project/unlink_project 必填项目 ID；需要登录身份及项目管理权。projects 查询已关联与历史实际参与项目，关联不授予访问权。' },
    },
    async execute(args, ctx) {
      const action = args.action || 'list'
      if (['projects', 'link_project', 'unlink_project'].includes(action)) {
        try {
          const service = new ProjectAgents(store)
          const data = action === 'projects' ? service.forAgent(String(args.agentId || ''), ctx)
            : service.change(String(args.projectId || ''), String(args.agentId || ''), action === 'link_project', ctx)
          return JSON.stringify({ ok: true, data })
        } catch (err: any) { return JSON.stringify({ ok: false, status: err.status || 400, code: err.code, error: err.message }) }
      }
      if (action === 'list') {
        const agents = store.getAgents().map((a) => ({ ...a, apiKey: a.apiKey ? '***' : undefined }))
        return JSON.stringify({ ok: true, agents, consoleUrl }, null, 2)
      }
      if (action === 'upsert') {
        const agent: any = asJson(args.agent)
        if (!agent?.name) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: '缺少 name' })
        const dshRef = normalizeDshRef(agent.dshRef || (agent.apiBaseUrl ? { kind: 'direct', apiBaseUrl: agent.apiBaseUrl } : undefined))
        if ('error' in dshRef) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', field: 'dshRef', error: dshRef.error })
        // 工作目录与 HTTP 通道同规则：POSIX / Windows 盘符 / UNC 均可，纯相对路径拒绝
        const workDirIn = String(agent?.workDir ?? '').trim()
        if (workDirIn && !isNodeAbsolutePath(workDirIn)) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', field: 'agent.workDir', error: WORK_DIR_NOT_ABSOLUTE_MSG })
        const saved = store.upsertAgent({ ...agent, dshRef })
        return JSON.stringify({ ok: true, message: '子智能体已保存', agent: { ...saved, apiKey: saved.apiKey ? '***' : undefined } }, null, 2)
      }
      const id = String(args.agentId || '')
      const agent = store.getAgent(id)
      if (action === 'delete') {
        return JSON.stringify({ ok: true, deleted: store.deleteAgent(id) })
      }
      if (action === 'enable' || action === 'disable') {
        if (!agent) return JSON.stringify({ ok: false, code: 'NOT_FOUND', error: '子智能体不存在' })
        store.mutateAgent(id, (a) => { a.enabled = action === 'enable' })
        return JSON.stringify({ ok: true, agentId: id, enabled: action === 'enable' })
      }
      if (!agent) return JSON.stringify({ ok: false, code: 'NOT_FOUND', error: '子智能体不存在' })
      if (action === 'ping') {
        const { target, ping } = await resolver.resolveWithPing(agent)
        return JSON.stringify({ ok: true, agent: agent.name, ping, resolved: target?.baseUrl }, null, 2)
      }
      if (action === 'preview') {
        await directory.refresh(true).catch(() => {})
        const composed = await composer.compose(agent, { resolvedAt: Date.now(), mask: true })
        return JSON.stringify({ ok: true, resourceBlock: composed.block, warnings: composed.warnings }, null, 2)
      }
      if (action === 'models' || action === 'presets') {
        const target = await resolver.resolve(agent)
        if (!target.online) return JSON.stringify({ ok: false, code: 'NODE_OFFLINE', error: target.error || '节点不可达' })
        if (action === 'models') {
          const r = await client.getModels(target)
          return JSON.stringify({ ok: r.ok, code: r.code, status: r.status, agent: agent.name, models: r.models, defaultModel: r.defaultModel, error: r.error }, null, 2)
        }
        const r = await client.getPresets(target)
        return JSON.stringify({ ok: r.ok, code: r.code, status: r.status, agent: agent.name, presets: r.presets, error: r.error }, null, 2)
      }
      return JSON.stringify({ ok: false, code: 'INVALID_PARAM', field: 'action', error: `不支持的 action: ${action}` })
    },
  }

  // 3. 任务管理
  const taskManage: WorkBuddyToolDef = {
    name: 'workbuddy_task_manage',
    description:
      '管理 WorkBuddy 任务会话（每任务一个聊天窗口，多轮对话）: list / preflight（只读预检，不创建/执行；返回角色候选、节点、文件工作区与权限边界）/ create（可带首条消息立即发起，**立即回执不等待执行**）/ send（多轮发言）/ wait（查看进度快照；HTTP 通道可同步等结果，MCP 通道不阻塞）/ delete / members / cancel。list 支持 keyword 关键词过滤（匹配任务 ID/标题，任务多时先用它缩小范围）。' +
      '发起约定：① 先 project_manage list 判断归属，能确定项目就带 projectId 从项目发起（上下文全继承）；' +
      '② 需求有歧义先向用户问清再 create——任务里的子智能体/专家一律无人值守执行，不会反问澄清；' +
      '③ 在 message 里用 @ 派活：@子智能体名（回其绑定节点执行，@ 多个=编排）、@专家名、@专家团名（按团队合同展开成员编排）、@项目名（对项目发起任务：未绑定项目的任务自动绑定该项目，节点/工作区/项目指令全继承）、@资源名（注入连接信息）；用 @ 时 memberAgentIds 可省略。' +
      '④ 你自己是某个子智能体时，create 建议带 creatorAgentId=<自己的 ID>——新任务自动继承你绑定的技能（否则创建者的技能不会注入新任务的派发提示词）;' +
      '⑤ 要带大文件（日志 ≤2GB）必须四步走，防止任务先于文件开跑：① create **不带 message**（任务保持 draft 不执行，拿到 taskId）→ ② workbuddy_file_manage {action:"upload_resumable_init", taskId, name, size} 按返回的节点直连配方直连 DSH 上传（POST init → PUT 分片 → POST complete 得落盘路径）→ ③ file_manage {action:"upload_register", taskId, uploadId, path} 登记附件 → ④ 本工具 {action:"send", taskId, message:"引用附件路径的指令"} 开始分析；' +
      '⚠ create 带 message 会立即开始执行——附件还没上传任务就已开跑，执行者拿不到文件；不要在 message 里写「文件随后上传」，必须先传完再 send；' +
      '重要：创建后不要重复 create 同一任务（重复内容 2 分钟内会被自动去重复用既有任务），要进度请用 wait 或 workbuddy_task_status 轮询',
    parameters: {
      action: { type: 'string', description: '操作: list / preflight / create / send / wait / delete / members / cancel' },
      taskId: { type: 'string', description: '任务 ID（send/wait/delete/members/cancel 用；preflight 可传以预检已有任务下一轮）' },
      keyword: { type: 'string', description: 'list 可选，关键词过滤：对任务 ID 与标题做大小写不敏感的包含匹配，只返回命中任务；不传返回全部' },
      title: { type: 'string', description: '任务标题（create 可选）' },
      memberAgentIds: { type: 'json', description: '成员 ID 数组，HTTP/MCP 传原生数组或 JSON 字符串，如 ["agent-xxx"]（create/send/preflight 可选；members 必填非空）。非空数组作为本轮显式定向意图，与 @稳定ID 走相同规划规则；members 只修改账本。用 agent_manage list/monitor overview 发现稳定 id' },
      mode: { type: 'string', description: 'create/preflight 可选 chat 或 orchestrate；chatAgentId 新建硬绑定必须显式 chat。send 仅作为路由断言，不修改模式。未绑定任务沿用既有规划规则' },
      chatAgentId: { type: 'string', description: 'create 持久绑定 BOT，必须显式 mode:chat；send 仅断言既有绑定，不可给旧任务新增或换绑；preflight 同步检查。成员可省略或仅同一 ID，冲突路由拒绝执行；绑定离线失败，不回退' },
      teamId: { type: 'string', description: 'create/send/preflight 显式专家团路由 ID；不可与 chatAgentId 硬绑定同时使用' },
      message: { type: 'string', description: '消息内容（create 可选首条消息；send 必填）。派活写法：@子智能体名 / @专家名 / @专家团名 / @项目名 / @资源名（名称须与列表完全一致）；指令要自包含：目标、路径参数、验收标准——执行者拿不到你们的对话上下文' },
      nodeRef: { type: 'json', description: 'create 可选，主会话执行节点：{kind:"mapping",mappingId:"…"}、{kind:"app",appId:"…"} 或 {kind:"direct",apiBaseUrl:"…"}。不传则快照项目默认执行节点，再回退文件归属节点；子智能体使用自身绑定节点' },
      projectId: { type: 'string', description: 'create 可选，归属项目 ID（workbuddy_project_manage list 取得）。发起前先判项目归属：能定项目必带此参——项目任务继承文件归属工作区/指令/默认协作成员及默认执行节点；nodeRef 可覆盖执行节点，创建时快照' },
      creatorAgentId: { type: 'string', description: 'create 可选，调用方自身在 WorkBuddy 的子智能体 ID（workbuddy_agent_manage list 取得）。传入后新任务自动继承你绑定的技能（/技能名 手势注入到派发提示词），否则创建者的技能不会进入新任务的提示词' },
      timeoutMs: { type: 'string', description: 'wait 最长同步等待毫秒（HTTP 通道默认 120000 上限 600000；MCP 通道默认 0=立即回执，最多 20000）' },
    },
    async execute(args, rawCtx) {
      const ctx = ctxOf(rawCtx)
      const action = args.action || 'list'
      if (action === 'list') {
        // keyword 过滤（task-53）：对 id/title 做大小写不敏感包含匹配；不传则回全量（向后兼容）
        const keyword = String(args.keyword || '').trim().toLowerCase()
        const tasks = store.getTasks()
          .filter((t) => !keyword || t.id.toLowerCase().includes(keyword) || t.title.toLowerCase().includes(keyword))
          .map((t) => ({
            id: t.id,
            title: t.title,
            mode: t.mode,
            chatAgentId: t.chatAgentId,
            status: t.status,
            running: engine.isRunning(t.id),
            members: t.memberAgentIds,
            turns: t.turns.length,
            updatedAt: t.updatedAt,
          }))
        return JSON.stringify({ ok: true, ...(keyword ? { keyword: args.keyword, matched: tasks.length } : {}), tasks, consoleUrl }, null, 2)
      }
      // Validate dispatch intent before create/dedup/send can mutate state or deliver messages.
      let checkedMembers: string[] | undefined
      let mentions: Awaited<ReturnType<TaskEngine['extractMentions']>> | undefined
      if (['create', 'send', 'preflight', 'members'].includes(action)) {
        if (args.memberAgentIds !== undefined) {
          const ids = asJson(args.memberAgentIds)
          if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id.trim())) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: 'memberAgentIds 必须是非空字符串 ID 数组（允许 create/preflight 显式空数组）' })
          checkedMembers = [...new Set(ids.map(id => id.trim()))]
          const missing = checkedMembers.filter(id => !store.getAgent(id))
          if (missing.length) return JSON.stringify({ ok: false, code: 'AGENT_NOT_FOUND', error: '成员 ID 不存在', memberAgentIds: missing })
        }
        if (args.mode !== undefined && !['chat', 'orchestrate'].includes(args.mode)) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: 'mode 必须是 chat 或 orchestrate' })
        const task = args.taskId ? store.getTask(String(args.taskId)) : undefined
        if ((action === 'send' || action === 'preflight' && args.taskId) && (!task || ctx.session && !canViewTask(ctx.session, task, { projects: store.getProjects() }))) return JSON.stringify({ ok: false, code: 'TASK_NOT_FOUND', error: '任务不存在' })
        if (!task && args.chatAgentId) {
          const agent = store.getAgent(String(args.chatAgentId))
          if (!agent || !canUseAgent(ctx.session, agent, { projects: store.getProjects() })) return JSON.stringify({ ok: false, code: 'AGENT_NOT_FOUND', error: 'BOT 不存在或无权使用' })
        }
        try {
          if (String(args.message || '').trim() || action === 'preflight') mentions = await engine.extractMentions(String(args.message || ''))
          if (action !== 'members') engine.validateChatBinding({ chatAgentId: args.chatAgentId, mode: args.mode, memberAgentIds: checkedMembers, teamId: args.teamId }, mentions, task)
          if (!task && args.chatAgentId && mentions?.mentionedProjectId && mentions.mentionedProjectId !== args.projectId) throw Object.assign(new Error('直聊请通过 projectId 明确项目上下文'), { code: 'INVALID_PARAM' })
        } catch (err: any) {
          // Whitelist fields: a candidate must never leak agent keys or resource credentials.
          return JSON.stringify({ ok: false, code: typeof err?.code === 'string' ? err.code : 'MENTION_ERROR', error: err?.message || '提及解析失败', candidates: Array.isArray(err?.candidates) ? err.candidates.map((c: any) => ({ id: c.id, name: c.name, type: c.type })) : undefined, nextAction: '用 message 中的 @稳定ID 指派；成员 ID 可从 agent_manage list / monitor overview 查询' })
        }
        const ids = [...new Set([args.projectId, task?.projectId, mentions?.mentionedProjectId].filter(Boolean).map(String))]
        for (const id of ids) {
          const project = store.getProject(id)
          if (!project || ctx.session && !canAccessProject(ctx.session, project, 'view')) return JSON.stringify({ ok: false, code: 'PROJECT_NOT_FOUND', error: '项目不存在或无权访问' })
        }
      }
      if (action === 'preflight') {
        const nodeRef = args.nodeRef == null ? undefined : normalizeDshRef(asJson(args.nodeRef))
        if (nodeRef && 'error' in nodeRef) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: nodeRef.error })
        const overview = deps.monitor?.peekOverview()
        return JSON.stringify(await taskPreflight(store, engine, { task: args.taskId ? store.getTask(String(args.taskId)) : undefined, projectId: args.projectId, nodeRef, memberAgentIds: checkedMembers, mode: args.mode, chatAgentId: args.chatAgentId, teamId: args.teamId }, mentions!, overview), null, 2)
      }
      if (action === 'create') {
        const memberIds = checkedMembers
        const explicit = Array.isArray(memberIds) ? memberIds.filter(Boolean) : []
        const projectId = args.projectId ? String(args.projectId) : undefined
        // 归属项目校验（提前失败，避免建出无节点上下文的任务）
        const project = projectId ? store.getProject(projectId) : undefined
        if (projectId && !project) {
          return JSON.stringify({ ok: false, code: 'NOT_FOUND', field: 'projectId', error: `项目不存在: ${projectId}（用 workbuddy_project_manage {action:"list"} 查看可用项目）` }, null, 2)
        }
        const nodeRef = args.nodeRef == null ? undefined : normalizeDshRef(asJson(args.nodeRef))
        if (nodeRef && 'error' in nodeRef) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', field: 'nodeRef', error: nodeRef.error })
        const executionRef = nodeRef || project?.defaultExecutionNodeRef || project?.dshRef

        // ① 业务级幂等：同内容重复到达（平台重投/整轮重跑、AI 误重发）→ 复用既有任务，不再建第二个
        const fp = createFingerprint(args.title, args.message, explicit, args.mode, projectId, dshRefKey(executionRef), args.chatAgentId, args.teamId)
        const hit = createDedupe.get(fp)
        if (hit) {
          const existing = store.getTask(hit.taskId)
          if (existing && Date.now() - hit.at <= CREATE_DEDUP_WINDOW_MS) {
            engine.logTask(existing.id, 'warn', `工具通道重复 create 命中幂等（${Math.round((Date.now() - hit.at) / 1000)}s 内同内容），已复用既有任务，未新建`)
            return JSON.stringify({
              ok: true,
              taskId: existing.id,
              deduped: true,
              reused: true,
              title: existing.title,
              status: existing.status,
              running: engine.isRunning(existing.id),
              receipt: '同一请求在去重窗口内重复到达，已复用既有任务（未新建）',
              nextAction: `用 workbuddy_task_status {taskId:"${existing.id}"} 查询进度；不要再重复 create`,
              consoleUrl,
            }, null, 2)
          }
          createDedupe.delete(fp)
        }

        // ② 近似重试兜底：模型重试时常改措辞（实测「具体要求：」→「任务步骤：」，指纹 22 字符处即分叉），
        //    精确指纹拦不住；改用「首句意图 + 5 分钟窗口」识别同一次指令的重复创建。
        //    首句 = 第一条 user 消息按 。！？!? 切分的第一段（规范化空白）；≥8 字符才参与，避免超短句误合。
        //    仅作用于 AI 工具通道（控制台人工创建走 REST，不受影响）。
        if (args.message && String(args.message).trim()) {
          const sentKey = firstSentenceKey(String(args.message))
          if (sentKey) {
            const now = Date.now()
            const fuzzy = store.getTasks().find((t) => {
              if (t.chatAgentId !== args.chatAgentId || t.teamId !== args.teamId || args.mode !== undefined && t.mode !== args.mode) return false
              if (explicit.length && [...t.memberAgentIds].sort().join(',') !== [...explicit].sort().join(',')) return false
              if (now - t.createdAt > CREATE_FUZZY_WINDOW_MS || t.projectId !== projectId) return false
              const existingRef = t.nodeRef || (t.projectId ? store.getProject(t.projectId)?.dshRef : undefined)
              if (executionRef || existingRef) {
                if (!sameDshRef(executionRef, existingRef)) return false
              }
              const fu = (t.turns || []).find((x) => x.role === 'user')
              return fu ? firstSentenceKey(fu.text) === sentKey : false
            })
            if (fuzzy) {
              engine.logTask(fuzzy.id, 'warn', `工具通道近似 create 命中首句去重（${Math.round((now - fuzzy.createdAt) / 1000)}s 内同首句），已复用既有任务，未新建`)
              return JSON.stringify({
                ok: true,
                taskId: fuzzy.id,
                deduped: true,
                reused: true,
                approximate: true,
                title: fuzzy.title,
                status: fuzzy.status,
                running: engine.isRunning(fuzzy.id),
                receipt: '近 5 分钟内已创建过同首句意图的任务（措辞略有差异），已复用既有任务（未新建）',
                nextAction: `用 workbuddy_task_status {taskId:"${fuzzy.id}"} 查询进度；若确需新建请在提示中明确说明`,
                consoleUrl,
              }, null, 2)
            }
          }
        }

        // 创建者身份：AI 通过工具通道创建任务时声明自身子智能体 ID → 继承其绑定技能（/手势注入派发提示词）。
        // 没有这层继承，工具创建的任务若无 @ 成员会落到节点主会话（skills: []），创建者技能完全丢失。
        const creatorAgentId = args.creatorAgentId ? String(args.creatorAgentId).trim() : ''
        const creatorAgent = creatorAgentId ? store.getAgent(creatorAgentId) : undefined
        if (creatorAgentId && !creatorAgent) {
          return JSON.stringify({ ok: false, code: 'NOT_FOUND', field: 'creatorAgentId', error: `创建者子智能体不存在: ${creatorAgentId}（用 workbuddy_agent_manage {action:"list"} 查看可用 ID）` }, null, 2)
        }
        const inheritedSkills = [...new Set(creatorAgent?.skills || [])]
        const task = await engine.createTask({
          title: args.title,
          // 未显式提供成员时传 undefined：引擎按来源继承（团队名册 / 项目 defaultAgentIds）；
          // 显式空数组保留「确实不要成员」的意图，不被默认成员覆盖
          ...(Array.isArray(memberIds) ? { memberAgentIds: explicit } : {}),
          mode: args.mode,
          chatAgentId: args.chatAgentId,
          teamId: args.teamId,
          message: args.message,
          creator: 'tool',
          ...(projectId ? { projectId } : {}),
          ...(inheritedSkills.length ? { skillNames: inheritedSkills } : {}),
          ...(nodeRef ? { nodeRef } : {}),
        })
        createDedupe.set(fp, { at: Date.now(), taskId: task.id })
        // ② 立即回执：执行是异步的（流式进度走 SSE / 轮询），这里绝不等待首轮跑完
        const withMessage = Boolean(String(args.message || '').trim())
        return JSON.stringify({
          ok: true,
          accepted: true,
          taskId: task.id,
          title: task.title,
          mode: task.mode,
          chatAgentId: task.chatAgentId,
          status: task.status,
          running: engine.isRunning(task.id),
          members: task.memberAgentIds,
          ...(withMessage
            ? {
                receipt: '任务已受理并开始执行（异步）' + (inheritedSkills.length ? '；已继承创建者绑定技能: ' + inheritedSkills.join(', ') : ''),
                nextAction: `进度用 workbuddy_task_status {taskId:"${task.id}"} 轮询，或 workbuddy_task_manage {action:"wait", taskId:"${task.id}"} 取快照；不要重复 create`,
              }
            : {
                receipt: '任务已创建（draft 草稿态，尚未开始执行）——正适合先传附件再启动',
                nextAction: `带附件流程：workbuddy_file_manage {action:"upload_resumable_init", taskId:"${task.id}", name:"<文件名>", size:<字节数>} → 按节点直连配方直传 → {action:"upload_register"} 登记 → 本工具 {action:"send", taskId:"${task.id}", message:"引用附件路径的分析指令"} 开始执行；无附件可直接 send`,
              }),
          ...(inheritedSkills.length ? { inheritedSkills } : {}),
          consoleUrl,
        }, null, 2)
      }
      const taskId = String(args.taskId || '')
      if (action === 'send') {
        if (!args.message) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: '缺少 message' })
        const text = String(args.message)
        // 同任务 + 同正文的重复投递（平台整轮重跑）直接忽略，避免重复派发同一句话
        const fp = sha1(JSON.stringify([taskId, text, checkedMembers?.slice().sort(), args.chatAgentId, args.mode, args.teamId]))
        const lastAt = sendDedupe.get(fp)
        if (lastAt && Date.now() - lastAt <= SEND_DEDUP_WINDOW_MS) {
          return JSON.stringify({
            ok: true,
            deduped: true,
            receipt: `同一条消息在 ${Math.round(SEND_DEDUP_WINDOW_MS / 1000)}s 内重复到达，已忽略重复投递`,
            nextAction: `用 workbuddy_task_status {taskId:"${taskId}"} 查询上一轮进度`,
          }, null, 2)
        }
        sendDedupe.set(fp, Date.now())
        pruneSendDedupe()
        const out = await engine.sendUserMessage(taskId, text, { memberAgentIds: checkedMembers, chatAgentId: args.chatAgentId, mode: args.mode, teamId: args.teamId })
        return JSON.stringify({
          ...out,
          accepted: out.ok,
          receipt: out.ok ? '消息已投递（异步执行中）' : undefined,
          nextAction: out.ok ? `用 workbuddy_task_status {taskId:"${taskId}"} 轮询回复` : undefined,
        }, null, 2)
      }
      if (action === 'wait') {
        const task0 = store.getTask(taskId)
        if (!task0) return JSON.stringify({ ok: false, code: 'NOT_FOUND', error: '任务不存在' })
        const requested = Number(args.timeoutMs)
        // 通道能力决定阻塞预算：MCP 默认 0（立即快照），显式给 timeoutMs 也最多到通道上限
        const budget = ctx.channel === 'mcp'
          ? (Number.isFinite(requested) && requested > 0 ? Math.min(requested, Math.max(ctx.maxBlockMs, 0)) : 0)
          : clamp(Number.isFinite(requested) && requested > 0 ? requested : 120_000, 5_000, Math.max(ctx.maxBlockMs, 600_000))
        const deadline = Date.now() + budget
        while (engine.isRunning(taskId) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 2_000))
        }
        const task = store.getTask(taskId)!
        const stillRunning = engine.isRunning(taskId)
        return JSON.stringify({
          ok: true,
          timedOut: stillRunning && budget > 0,
          turns: task.turns.length,
          waitedMs: budget - Math.max(deadline - Date.now(), 0),
          ...taskReadFields(task, stillRunning),
          nextAction: stillRunning
            ? `任务仍在执行：不要长阻塞、不要重复 create，用 workbuddy_task_status {taskId:"${taskId}"} 轮询进度`
            : '任务已结束，可读取 summary/lastReply 或 workbuddy_task_evaluate 取汇总',
          consoleUrl,
        }, null, 2)
      }
      if (action === 'delete') return JSON.stringify({ ok: true, deleted: await engine.deleteTask(taskId) })
      if (action === 'cancel') {
        await engine.cancelTask(taskId)
        return JSON.stringify({ ok: true })
      }
      if (action === 'members') {
        const memberIds = checkedMembers
        if (!Array.isArray(memberIds) || !memberIds.some((id) => Boolean(id))) {
          return JSON.stringify({ ok: false, error: 'members 需要 memberAgentIds（至少一个非空成员子智能体 ID）：HTTP 传数组或 JSON 字符串，CLI 用 --agents <id,id>' })
        }
        const t = engine.updateMembers(taskId, memberIds)
        return JSON.stringify({ ok: Boolean(t), ...(t ? {} : { code: 'NOT_FOUND', error: '任务不存在' }), task: t }, null, 2)
      }
      return JSON.stringify({ ok: false, code: 'INVALID_PARAM', field: 'action', error: `不支持的 action: ${action}` })
    },
  }

  // 4. 任务状态
  const taskStatus: WorkBuddyToolDef = {
    name: 'workbuddy_task_status',
    description:
      '查询 WorkBuddy 任务进度: 任务状态、编排计划（子任务列表与状态）、汇总结论。默认返回摘要（小回包，适合 MCP/语音等窄通道）；detail:"full" 返回完整轮次与日志——超大任务（>32KB）会自动降级为「摘要 + chatDownloadUrl 聊天内容下载 URL」（token 10 分钟有效，GET 该 URL 取完整内容）',
    parameters: {
      taskId: { type: 'string', description: '任务 ID（缺省列出全部任务概览）' },
      detail: { type: 'string', description: 'summary（默认，摘要）/ full（完整任务对象，含全部轮次与日志，回包很大）' },
    },
    async execute(args, rawCtx) {
      if (!args.taskId) {
        return JSON.stringify({
          ok: true,
          tasks: store.getTasks().map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            running: engine.isRunning(t.id),
            subtasks: t.plan?.subtasks.length || 0,
          })),
        }, null, 2)
      }
      const task = store.getTask(String(args.taskId))
      if (!task) return JSON.stringify({ ok: false, code: 'NOT_FOUND', error: '任务不存在' })
      if (String(args.detail || 'summary') === 'full') {
        // task-54：超大任务不直回全文——先量化字节，>32KB 时降级为「摘要 + 聊天内容下载 URL」
        const fullJson = JSON.stringify({ ok: true, ...taskReadFields(task, engine.isRunning(task.id)), task })
        const bytes = Buffer.byteLength(fullJson)
        if (bytes > TASK_FULL_OVERSIZE_BYTES && deps.downloadTokens) {
          const token = deps.downloadTokens.downloadToken(`chat-export:${task.id}`, CHAT_EXPORT_TOKEN_TTL_MS)
          const base = (ctxOf(rawCtx).requestBase || consoleUrl).replace(/\/+$/, '')
          const userTurns = task.turns.filter((t) => t.role === 'user')
          engine.logTask(task.id, 'info', `task_status full 回包 ${(bytes / 1024).toFixed(0)}KB 超 ${TASK_FULL_OVERSIZE_BYTES / 1024}KB 阈值，已降级为下载 URL（10 分钟内有效）`)
          return JSON.stringify({
            ok: true,
            oversized: true,
            bytes,
            thresholdBytes: TASK_FULL_OVERSIZE_BYTES,
            mode: task.mode,
            members: task.memberAgentIds,
            turns: task.turns.length,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            lastUserMessage: preview(userTurns[userTurns.length - 1]?.text, 200),
            plan: task.plan
              ? {
                  strategy: task.plan.strategy,
                  completed: (task.plan.subtasks || []).filter((s) => s.status === 'completed').length,
                  subtasks: (task.plan.subtasks || []).map((s) => ({ id: s.id, agentId: s.agentId, title: preview(s.title, 40), status: s.status })),
                }
              : undefined,
            ...taskReadFields(task, engine.isRunning(task.id)),
            clipped: true,
            chatDownloadUrl: `${base}/api/tasks/${encodeURIComponent(task.id)}/chat-export?token=${encodeURIComponent(token)}&format=json`,
            chatDownloadUrlMarkdown: `${base}/api/tasks/${encodeURIComponent(task.id)}/chat-export?token=${encodeURIComponent(token)}&format=markdown`,
            downloadTokenTtlMs: CHAT_EXPORT_TOKEN_TTL_MS,
            hint: `任务完整内容 ${(bytes / 1024).toFixed(0)}KB 超过单帧安全阈值，已降级：GET chatDownloadUrl（无需额外鉴权头，token 10 分钟内有效，过期重调本接口取新 URL）即可下载完整任务聊天内容（format=json 或 markdown）`,
          }, null, 2)
        }
        return JSON.stringify({ ok: true, ...taskReadFields(task, engine.isRunning(task.id)), task }, null, 2)
      }
      const userTurns = task.turns.filter((t) => t.role === 'user')
      return JSON.stringify({
        ok: true,
        mode: task.mode,
        members: task.memberAgentIds,
        turns: task.turns.length,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        lastUserMessage: preview(userTurns[userTurns.length - 1]?.text, 200),
        plan: task.plan
          ? {
              strategy: task.plan.strategy,
              completed: (task.plan.subtasks || []).filter((s) => s.status === 'completed').length,
              subtasks: (task.plan.subtasks || []).map((s) => ({
                id: s.id,
                agentId: s.agentId,
                title: preview(s.title, 40),
                status: s.status,
                error: s.error ? preview(s.error, 120) : undefined,
              })),
            }
          : undefined,
        ...taskReadFields(task, engine.isRunning(task.id)),
        hint: '需要完整轮次/工具日志请传 detail:"full"（回包很大）或用控制台',
      }, null, 2)
    },
  }

  // 5. 任务聊天（远端会话记录 / 追问）
  const taskChat: WorkBuddyToolDef = {
    name: 'workbuddy_task_chat',
    description:
      '读取任务聊天；默认主会话，多成员无主会话时返回 targets 供选择。source 区分 remote_history 与 platform_ledger；远端为空或不可达但平台有回复时带 fallback 解释。默认最近 20 条并标记 clipped；' +
      '带 followupMessage 时向远端会话追问：HTTP 通道同步等回复，MCP 通道立即回执、用下一次不带 followupMessage 的调用取结果',
    parameters: {
      taskId: { type: 'string', description: '任务 ID' },
      subtaskId: { type: 'string', description: '可选：子任务 ID 或成员 agentId；省略优先主会话，多个成员无主会话时返回 targets；__node__ 仍可显式指定主会话' },
      followupMessage: { type: 'string', description: '可选的追问消息；MCP 通道为异步投递（立即回执），HTTP 通道同步等待回复' },
      maxMessages: { type: 'string', description: '最多返回最近多少条消息（默认 20，上限 200）' },
      maxTextChars: { type: 'string', description: '单条消息正文截断字数（默认 2000，上限 20000；full=true 时不截断）' },
      full: { type: 'string', description: 'true = 不做条数/字数裁剪（回包很大，MCP 通道可能超上限，慎用）' },
    },
    async execute(args, rawCtx) {
      const ctx = ctxOf(rawCtx)
      const task = store.getTask(String(args.taskId || ''))
      if (!task || (ctx.session && !canViewTask(ctx.session, task, { projects: store.getProjects() }))) return JSON.stringify({ ok: false, code: 'NOT_FOUND', error: '任务不存在' })
      const common = taskReadFields(task, engine.isRunning(task.id))
      const targets = taskChatTargets(task)
      let subId = String(args.subtaskId || '')
      if (!subId) {
        // Prefer an actual main binding; multiple member sessions require explicit selection.
        if (task.sessions.__node__) subId = '__node__'
        else if (targets.length === 1) subId = targets[0].id
        else if (!targets.length) subId = '__node__'
        else return JSON.stringify({ ok: false, ...common, code: 'CHAT_TARGET_REQUIRED', error: '存在多个会话目标，请指定 subtaskId', targets })
      }
      const sub = task.plan?.subtasks.find((s) => s.id === subId)
      const agentId = sub?.agentId || subId
      const binding = task.sessions[agentId]
      const sessionId = sub ? sub.remoteSessionId : binding?.remoteSessionId
      const agent = store.getAgent(agentId)
      if (!agent && agentId !== '__node__' && !sub && !binding) return JSON.stringify({ ok: false, ...common, code: 'CHAT_TARGET_NOT_FOUND', targets, error: `未找到会话目标「${subId}」` })
      let target: Awaited<ReturnType<TaskEngine['resolveExecTarget']>>
      let remoteError: string | undefined
      if (sessionId) {
        try { target = await engine.resolveExecTarget(task, agentId) } catch (err: any) { remoteError = String(err?.message || err) }
      }
      if (args.followupMessage && (!sessionId || !target?.online)) return JSON.stringify({ ok: false, ...common, code: !sessionId ? 'SESSION_EXPIRED' : 'NODE_OFFLINE', error: remoteError || target?.error || '该成员尚未创建远程会话或绑定节点不可达' })
      const client = new DshClient()
      const stateKey = `${task.id}:${agentId}:${sessionId || ''}`
      if (args.followupMessage) {
        const msg = String(args.followupMessage)
        // MCP 通道：异步投递，立即回执（绝不阻塞等远端跑完——那正是宿主断链的诱因）
        if (ctx.channel === 'mcp') {
          const running = followupState.get(stateKey)
          if (running?.status === 'running') {
            return JSON.stringify({
              ok: true,
              accepted: false,
              taskId: task.id,
              agentId,
              followup: running,
              receipt: '上一条追问仍在执行中，本次未投递',
              nextAction: `用 workbuddy_task_chat {taskId:"${task.id}", subtaskId:"${agentId}"} 取结果后再追问`,
            }, null, 2)
          }
          followupState.set(stateKey, { at: Date.now(), status: 'running' })
          engine.logTask(task.id, 'info', `追问已投递（异步）→ ${agent?.name || '节点主会话'}：${preview(msg, 80)}`)
          const startedAt = Date.now()
          void client.prompt(target!, sessionId!, msg, { timeoutMs: 1_800_000 })
            .then((reply) => {
              followupState.set(stateKey, {
                at: Date.now(),
                status: reply.ok ? 'done' : 'error',
                preview: reply.ok ? preview(reply.content, 400) : undefined,
                error: reply.ok ? undefined : reply.error,
                ms: Date.now() - startedAt,
              })
              engine.logTask(task.id, reply.ok ? 'info' : 'warn', reply.ok ? '追问回复已就绪（用 task_chat 取全文）' : `追问失败：${preview(reply.error, 120)}`)
            })
            .catch((err) => {
              followupState.set(stateKey, { at: Date.now(), status: 'error', error: String(err?.message || err), ms: Date.now() - startedAt })
            })
            .finally(() => pruneFollowups())
          return JSON.stringify({
            ok: true,
            accepted: true,
            taskId: task.id,
            agentId,
            followup: { status: 'running' },
            receipt: '追问已投递（异步执行中）',
            nextAction: `稍后用 workbuddy_task_chat {taskId:"${task.id}", subtaskId:"${agentId}"}（不带 followupMessage）取结果`,
          }, null, 2)
        }
        const reply = await client.prompt(target!, sessionId!, msg, {
          timeoutMs: clamp(ctx.maxBlockMs || 120_000, 5_000, 120_000),
        })
        return JSON.stringify({ ok: reply.ok, code: reply.code, status: reply.status, reply: preview(reply.content, 8000), error: reply.error }, null, 2)
      }
      // 读聊天记录：条数 + 单条字数 + 总字节三重收敛（回包过大是 MCP 会话被打断的头号原因）
      const full = String(args.full || '') === 'true'
      const maxMessages = full ? 200 : clamp(Number(args.maxMessages) || 20, 1, 200)
      const maxTextChars = full ? 0 : clamp(Number(args.maxTextChars) || 2_000, 200, 20_000)
      const hist = sessionId && target?.online
        ? await client.getHistory(target, sessionId, maxMessages).catch((err: any) => ({ ok: false, error: String(err?.message || err), messages: [] }))
        : { ok: false, error: remoteError || target?.error || '绑定的会话节点不可达或尚无远端会话', messages: [] }
      const remote = hist.messages || []
      const ledger = ledgerMessages(task, agentId, sub?.id)
      const fallback = !hist.ok || !remote.length
        ? { reason: !sessionId ? 'remote_session_missing' : !hist.ok ? 'remote_history_unavailable' : 'remote_history_empty', error: hist.ok ? undefined : hist.error, explanation: '远端历史不可用或为空；平台账本独立记录已收到的回复，不据此判断消息丢失。' }
        : undefined
      const source = fallback && ledger.length ? 'platform_ledger' : 'remote_history'
      if (!hist.ok && !ledger.length) return JSON.stringify({ ok: false, ...common, agentId, targets, source: 'none', code: !sessionId ? 'SESSION_EXPIRED' : !target?.online ? 'NODE_OFFLINE' : ('code' in hist && hist.code) || 'REMOTE_HISTORY_UNAVAILABLE', error: hist.error, fallback, messages: [] })
      const all = source === 'platform_ledger' ? ledger : remote
      const pick = full ? all : all.slice(-maxMessages)
      const messages: any[] = []
      let bytes = 0
      let clipped = all.length > pick.length
      for (const m of [...pick].reverse()) {
        let item: any = m
        if (!full) {
          item = { ...m }
          const text = typeof m?.content === 'string' ? m.content : undefined
          if (text !== undefined && text.length > maxTextChars) {
            item.content = `${text.slice(0, maxTextChars)}…（截断，原文 ${text.length} 字）`
            clipped = true
          }
        }
        let size = Buffer.byteLength(JSON.stringify(item))
        // Keep the newest reply even when multi-byte text alone exceeds the budget.
        if (!full && size > 32 * 1024 && !messages.length && typeof item.content === 'string') {
          item = { ...item }
          let lo = 0, hi = item.content.length
          const text = item.content
          while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2)
            if (Buffer.byteLength(JSON.stringify({ ...item, content: `${text.slice(0, mid)}…（字节预算截断）` })) <= 32 * 1024) lo = mid
            else hi = mid - 1
          }
          item.content = `${text.slice(0, lo)}…（字节预算截断）`
          size = Buffer.byteLength(JSON.stringify(item))
          clipped = true
        }
        if (!full && bytes + size > 32 * 1024) {
          clipped = true
          break
        }
        bytes += size
        messages.unshift(item)
      }
      const followup = followupState.get(stateKey)
      return JSON.stringify({
        ok: true,
        ...common,
        agentId,
        source,
        targets,
        fallback,
        emptyReason: !all.length ? '远端会话没有消息，平台也没有该目标的回复记录' : undefined,
        sessionId,
        remoteHistory: { ok: hist.ok, returned: remote.length, ...('totalMessages' in hist ? { totalMessages: hist.totalMessages } : {}), ...('totalEvents' in hist ? { totalEvents: hist.totalEvents } : {}), ...('hasMore' in hist ? { hasMore: hist.hasMore } : {}) },
        returned: messages.length,
        fetched: all.length,
        clipped: clipped || common.clipped || Boolean('hasMore' in hist && hist.hasMore),
        followup: followup ? followup : undefined,
        messages,
        hint: clipped ? '内容已裁剪；需要更多请调大 maxMessages/maxTextChars，或传 full:"true"（回包很大）' : undefined,
      }, null, 2)
    },
  }

  // 6. 汇总评估
  const taskEvaluate: WorkBuddyToolDef = {
    name: 'workbuddy_task_evaluate',
    description: '对 WorkBuddy 编排任务重新评估并生成/刷新汇总报告（success/partial_success/failed + 各子任务要点 + 最终结论）',
    parameters: { taskId: { type: 'string', description: '任务 ID' } },
    async execute(args) {
      const task = store.getTask(String(args.taskId || ''))
      if (!task?.plan) return JSON.stringify({ ok: false, code: 'NOT_FOUND', error: '任务不存在或无编排计划' })
      const summary = task.summary
      return JSON.stringify({
        ok: true,
        running: engine.isRunning(task.id),
        taskId: task.id,
        status: summary?.status,
        summary: typeof summary === 'string' ? preview(summary, 2000) : summary,
      }, null, 2)
    },
  }

  // 7. SSH 资源池
  const sshResourceManage: WorkBuddyToolDef = {
    name: 'workbuddy_ssh_resource_manage',
    description:
      '管理 WorkBuddy 本地 SSH 连接资源池（补充 ONENAT 之外的直连主机）: list(脱敏) / get(取完整凭据) / upsert / delete / test(真实连接测试) / exec(远程执行命令)',
    parameters: {
      action: { type: 'string', description: '操作: list / get / upsert / delete / test / exec' },
      resource: { type: 'json', description: 'SSH 资源对象（upsert 用）: { id?, name, host, port?, authType: "password"|"key", username, password?, privateKey?, passphrase?, description?, tags? }' },
      resourceId: { type: 'string', description: '资源 ID（get/delete/test/exec 用；test/exec 也接受 name）' },
      command: { type: 'string', description: 'exec 要执行的 shell 命令' },
      timeoutMs: { type: 'string', description: '超时毫秒（默认 exec 30000）' },
    },
    async execute(args, rawCtx) {
      const action = args.action || 'list'
      if (action === 'list') return JSON.stringify({ ok: true, resources: sshStore.list().map(maskSshResource) }, null, 2)
      if (action === 'upsert') {
        const input: any = asJson(args.resource)
        const existing = input?.id ? sshStore.get(input.id) : undefined
        try {
          const saved = sshStore.upsert(normalizeSshResource(input, existing))
          return JSON.stringify({ ok: true, resource: maskSshResource(saved) }, null, 2)
        } catch (err: any) {
          return JSON.stringify({ ok: false, error: err?.message })
        }
      }
      const key = String(args.resourceId || '')
      const r = sshStore.get(key) || sshStore.list().find((x) => x.name === key)
      if (!r) return JSON.stringify({ ok: false, code: 'NOT_FOUND', error: 'SSH 资源不存在' })
      // 安全基线（task-51 V7）：AI 令牌是低信任调用方——
      //  ① get 返回明文凭据 → 拒绝；② exec 可在远端主机任意执行命令 → 拒绝。
      // 两者均需控制台登录会话（人工二次授权）方可操作。
      if (ctxOf(rawCtx).aiTokenOnly) {
        if (action === 'get') return denyAiTokenSsh('get(明文凭据读取)', r.id)
        if (action === 'exec') return denyAiTokenSsh('exec(远程命令执行)', r.id)
      }
      const session = ctxOf(rawCtx).session
      const resourceAction = action === 'get' ? 'reveal' : action === 'delete' ? 'manage' : 'use'
      if (session && !canAccessResource(session, r, resourceAction, { projects: store.getProjects() })) {
        return JSON.stringify({ ok: false, code: 'PERMISSION_DENIED', error: '无权访问该 SSH 资源' })
      }
      if (action === 'get') return JSON.stringify({ ok: true, resource: r }, null, 2)
      if (action === 'delete') return JSON.stringify({ ok: true, deleted: sshStore.delete(r.id) })
      if (action === 'test') {
        const result = await testSshResource(r, Number(args.timeoutMs) || 8000)
        sshStore.update(r.id, { lastTestedAt: result.testedAt, lastTestOk: result.ok, lastTestError: result.ok ? undefined : result.error })
        return JSON.stringify({ ok: true, result }, null, 2)
      }
      if (action === 'exec') {
        if (!args.command) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: '缺少 command' })
        // 通道能力决定单次阻塞上限：MCP 宿主等不住长命令（长阻塞 → 断链 → 平台重发整轮请求）
        const ctx = ctxOf(rawCtx)
        const cap = ctx.channel === 'mcp' ? clamp(ctx.maxBlockMs, 1_000, 20_000) : 60_000
        const timeoutMs = clamp(Number(args.timeoutMs) || (ctx.channel === 'mcp' ? 10_000 : 30_000), 1_000, cap)
        const result = await execOnSshResource(r, String(args.command), timeoutMs)
        return JSON.stringify({
          ok: result.ok,
          ...(result.ok ? {} : { code: 'EXECUTION_FAILED', error: result.error, retryable: false }),
          result: { ...result, timeoutMs },
        }, null, 2)
      }
      return JSON.stringify({ ok: false, code: 'INVALID_PARAM', field: 'action', error: `不支持的 action: ${action}` })
    },
  }

  // 7.5 协作群（契约 docs/groups-web-sync-plan-2026-11-11.md §3；与 REST /api/groups 共用 server.ts 注入的同一 GroupStore 单例，禁止旁路直改 JSON）
  const groupManage: WorkBuddyToolDef = {
    name: 'workbuddy_group_manage',
    description:
      '管理协作群（每用户隔离，AI 令牌不可访问）: list/get/create/update/delete 群 CRUD、sections/add_section/rename_section/remove_section 首页分组、rounds/add_round 历史讨论轮、mark_read 已读落位；幂等语义与 REST /api/groups 一致（upsert 保位覆盖/追加末尾、delete 幂等清轮表、分组重名幂等、重命名冲突 SECTION_CONFLICT、已读单调）',
    denyAiToken: true,
    parameters: {
      action: { type: 'string', description: '操作: list / get / create / update / delete / sections / add_section / rename_section / remove_section / rounds / add_round / mark_read' },
      roomId: { type: 'string', description: '群 ID（get/update/delete/rounds/add_round/mark_read 用）' },
      room: { type: 'json', description: '群对象：create 传完整 GroupRoom（缺 id 服务端生成 UUID）；update 传部分字段（缺省字段保留原值；id/createdBy/createdAt 服务端权威会被覆盖）' },
      name: { type: 'string', description: '分组名（add_section/remove_section 用）' },
      old: { type: 'string', description: '原分组名（rename_section 用）' },
      to: { type: 'string', description: '新分组名（rename_section 用；新名已存在或旧名不存在 → SECTION_CONFLICT）' },
      taskId: { type: 'string', description: '历史轮 orchestrate 任务 ID（add_round 用；同 taskId 去重幂等）' },
      lastReadSeq: { type: 'string', description: '已读位点（mark_read 用；非负整数，取 max 单调不回退）' },
      compact: { type: 'string', description: 'list 传 true 返回精简视图（省 notice/permissionOverride 等长字段）' },
    },
    async execute(args, rawCtx) {
      // 双保险（外层 wrapper 已按 denyAiToken 先于参数校验拒绝；此处防绕过直达 execute）
      const ctx = ctxOf(rawCtx)
      if (ctx.aiTokenOnly) {
        console.warn(`[安全审计] AI 令牌尝试群操作 ${args.action || 'list'} 已拒绝（ai-token-group-guard）`)
        return JSON.stringify({ ok: false, code: 'AI_TOKEN_DENIED', status: 403, error: 'AI 令牌无权访问协作群（群数据按登录用户隔离，无共享桶；请在控制台登录后操作）', denied: 'ai-token-group-guard' })
      }
      if (!groupsStore) return JSON.stringify(normalizeToolResult({ ok: false, code: 'INTERNAL_ERROR', status: 500, error: 'GroupStore 未装配（server.ts 单例注入缺失）' }, { tool: 'workbuddy_group_manage', args }))
      const uid = ctx.session?.userId
      if (!uid) return JSON.stringify(normalizeToolResult({ ok: false, code: 'UNAUTHORIZED', status: 401, error: '群功能需要控制台登录身份（群数据按用户隔离，无共享桶）', nextAction: '在控制台登录后重试' }, { tool: 'workbuddy_group_manage', args }))
      // PermSession 类型只含 userId/role；HTTP 通道注入的会话运行时携带 username（登录用户名），工具通道缺失时回退 userId
      const username = (ctx.session as { username?: string } | undefined)?.username || uid
      const action = String(args.action || 'list')
      const notFound = () => JSON.stringify(normalizeToolResult({ ok: false, code: 'NOT_FOUND', status: 404, error: '群不存在', nextAction: '用 list 查看当前登录用户可见的群（每用户隔离，跨用户不可见）' }, { tool: 'workbuddy_group_manage', args }), null, 2)
      try {
        switch (action) {
          case 'list': {
            const rooms = groupsStore.list(uid)
            const compact = /^true$/i.test(String(args.compact || '').trim())
            const data = compact
              ? rooms.map((r) => ({ id: r.id, name: r.name, section: r.section, archived: r.archived, unreadCount: r.unreadCount, lastReadSeq: r.lastReadSeq, memberAgentIds: r.memberAgentIds, channelRef: r.channelRef, activeProjectId: r.activeProjectId }))
              : rooms
            return JSON.stringify({ ok: true, rooms: data }, null, 2)
          }
          case 'get': {
            const room = groupsStore.get(uid, String(args.roomId || ''))
            if (!room) return notFound()
            return JSON.stringify({ ok: true, room }, null, 2)
          }
          case 'create': {
            const input = asJson(args.room)
            const bodyId = typeof input?.id === 'string' ? input.id.trim() : ''
            const existing = bodyId ? groupsStore.get(uid, bodyId) : undefined
            const room = normalizeGroupRoom(input, undefined, { id: existing?.id ?? (bodyId || randomUUID()), now: Date.now(), createdAt: existing?.createdAt, createdBy: existing?.createdBy ?? username, prevLastReadSeq: existing?.lastReadSeq })
            return JSON.stringify({ ok: true, room: groupsStore.upsert(uid, room) }, null, 2)
          }
          case 'update': {
            const existing = groupsStore.get(uid, String(args.roomId || ''))
            if (!existing) return notFound()
            const room = normalizeGroupRoom(asJson(args.room), existing, { id: existing.id, now: Date.now(), createdAt: existing.createdAt, createdBy: existing.createdBy, prevLastReadSeq: existing.lastReadSeq })
            return JSON.stringify({ ok: true, room: groupsStore.upsert(uid, room) }, null, 2)
          }
          case 'delete':
            return JSON.stringify({ ok: true, deleted: groupsStore.delete(uid, String(args.roomId || '')) }, null, 2)
          case 'sections':
            return JSON.stringify({ ok: true, sections: groupsStore.sections(uid) }, null, 2)
          case 'add_section':
            return JSON.stringify({ ok: true, ...groupsStore.addSection(uid, args.name) }, null, 2)
          case 'rename_section': {
            const r = groupsStore.renameSection(uid, args.old, args.to)
            return JSON.stringify({ ok: true, renamed: true, sections: r.sections }, null, 2)
          }
          case 'remove_section':
            return JSON.stringify({ ok: true, ...groupsStore.removeSection(uid, args.name) }, null, 2)
          case 'rounds': {
            const roomId = String(args.roomId || '')
            if (!groupsStore.get(uid, roomId)) return notFound()
            return JSON.stringify({ ok: true, rounds: groupsStore.rounds(uid, roomId) }, null, 2)
          }
          case 'add_round': {
            const roomId = String(args.roomId || '')
            if (!groupsStore.get(uid, roomId)) return notFound()
            return JSON.stringify({ ok: true, ...groupsStore.addRound(uid, roomId, args.taskId) }, null, 2)
          }
          case 'mark_read': {
            const roomId = String(args.roomId || '')
            if (!groupsStore.get(uid, roomId)) return notFound()
            const seq = Number(args.lastReadSeq)
            if (!Number.isSafeInteger(seq) || seq < 0) return JSON.stringify(normalizeToolResult({ ok: false, code: 'INVALID_PARAM', field: 'lastReadSeq', error: 'lastReadSeq 必须是非负整数', nextAction: '先 get 取当前 lastReadSeq，再传不小于它的非负整数（单调不回退）' }, { tool: 'workbuddy_group_manage', args }), null, 2)
            return JSON.stringify({ ok: true, room: groupsStore.markRead(uid, roomId, seq) }, null, 2)
          }
          default:
            return JSON.stringify({ ok: false, code: 'INVALID_PARAM', field: 'action', error: `不支持的 action: ${action}` })
        }
      } catch (err) {
        const e = err as any
        const code = e instanceof GroupStoreError ? e.code : 'INTERNAL_ERROR'
        const status = code === 'SECTION_CONFLICT' ? 409 : code === 'INVALID_PARAM' ? 400 : 500
        const nextAction = code === 'SECTION_CONFLICT'
          ? 'rename_section 要求旧分组存在且新分组不存在；先用 sections 查看现有分组'
          : code === 'STORE_UNHEALTHY'
            ? '群存储文件损坏处于保护态（拒绝写入保现场）；请联系管理员人工检查数据文件'
            : code === 'STORE_WRITE_FAILED'
              ? '落盘失败（磁盘满/权限），请检查存储目录后重试'
              : code === 'INTERNAL_ERROR' ? '意外异常，请携带操作与参数联系管理员排查' : '修正参数后重试；字段口径见群契约 §1'
        return JSON.stringify(normalizeToolResult({ ok: false, code, status, error: e?.message || String(err), nextAction }, { tool: 'workbuddy_group_manage', args }), null, 2)
      }
    },
  }

  // 8. 监控大屏读取
  const monitorRead: WorkBuddyToolDef = {
    name: 'workbuddy_monitor_read',
    description:
      '读取 WorkBuddy 监控大屏数据（一眼看全局运行态势）: overview（KPI/智能体在线忙闲/任务一句话状态/资源调用/告警）/ events（最近事件流，可增量拉取）/ history（近 N 天小时快照趋势）/ task（单任务当前活动与最近对话摘要）',
    parameters: {
      action: { type: 'string', description: '操作: overview / events / history / task' },
      projectId: { type: 'string', description: 'overview 限定项目 ID；省略查看全局' },
      section: { type: 'string', description: 'overview 所需部分，逗号分隔：kpi,agents,nodes,tasks,schedules,sshPool,alerts,events；省略全部' },
      compact: { type: 'string', description: 'overview 紧凑摘要，默认 true；false 展开所选部分详情' },
      limit: { type: 'string', description: 'overview 每部分条数默认30；events默认50；整数1–200，裁剪见metadata' },
      since: { type: 'string', description: 'events 只返回该毫秒时间戳之后的事件（增量轮询用）' },
      days: { type: 'string', description: 'history 天数（默认 7，最大 30）' },
      taskId: { type: 'string', description: 'task 操作的目标任务 ID' },
    },
    async execute(args, ctx) {
      if (ctx?.session && ctx.session.role !== 'admin') return JSON.stringify({ ok: false, status: 403, error: '仅平台管理员可查看监控大屏' })
      const monitor = deps.monitor
      if (!monitor) return JSON.stringify({ ok: false, code: 'SERVICE_UNAVAILABLE', error: '监控服务未装配' })
      const action = args.action || 'overview'
      if (action === 'overview') {
        const ov = await monitor.getOverview()
        try {
          const result = queryMonitorOverview(ov, { ...args, compact: args.compact ?? 'true' }, {
            projects: store.getProjects().filter(p => !ctx?.session || canAccessProject(ctx.session, p, 'view')),
            tasks: store.getTasks().filter(t => !ctx?.session || canViewTask(ctx.session, t, { projects: store.getProjects() })),
          })
          return JSON.stringify({ ok: true, ...result, consoleUrl })
        } catch (err: any) {
          return JSON.stringify({ ok: false, status: err.status || 400, code: 'INVALID_PARAMS', error: err.message })
        }
      }
      if (action === 'events') {
        const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200)
        const since = Number(args.since) || 0
        const events = monitor.getRecentEvents(limit).filter((e) => !since || e.at > since)
        return JSON.stringify({ ok: true, count: events.length, events, consoleUrl }, null, 2)
      }
      if (action === 'history') {
        const days = Math.min(Math.max(Number(args.days) || 7, 1), 30)
        return JSON.stringify({ ok: true, days: monitor.readHistory(days) }, null, 2)
      }
      if (action === 'task') {
        const task = store.getTask(String(args.taskId || ''))
        if (!task) return JSON.stringify({ ok: false, code: 'NOT_FOUND', error: '任务不存在' })
        const ov = await monitor.getOverview()
        const view = ov.tasks.find((x) => x.id === task.id)
        const lastTurns = (task.turns || []).slice(-4).map((t) => ({
          role: t.role,
          agentName: t.agentName,
          at: t.at,
          text: String(t.text || '').slice(0, 500),
          tools: (t.tools || []).map((x) => ({ name: x.name, status: x.status, ms: x.ms })),
        }))
        return JSON.stringify({ ok: true, view, plan: task.plan, summary: task.summary, lastTurns, consoleUrl }, null, 2)
      }
      return JSON.stringify({ ok: false, code: 'INVALID_PARAM', field: 'action', error: `不支持的 action: ${action}` })
    },
  }

  // 9. 定时任务管理
  const scheduleManage: WorkBuddyToolDef = {
    name: 'workbuddy_schedule_manage',
    description:
      '管理 WorkBuddy 定时任务（按规则把固定任务文本派发给一个或多个子智能体，Host 侧调度）: list / get（含执行记录）/ upsert / delete / toggle（启停）/ run（手动立即触发一次）',
    parameters: {
      action: { type: 'string', description: '操作: list / get / upsert / delete / toggle / run' },
      schedule: {
        type: 'json',
        description:
          '定时任务配置（upsert 用）: { id?, name, agentIds: [子智能体ID], message: 固定任务文本, rule: {kind:"daily",times:["09:00","18:00"]} | {kind:"weekly",days:[1-5],time:"09:00"} | {kind:"hourly",minute:30} | {kind:"monthly",days:[1,15],time:"09:00"} | {kind:"interval",minutes:60} | {kind:"once",at:毫秒时间戳}, enabled? }',
      },
      scheduleId: { type: 'string', description: '定时任务 ID（get/delete/toggle/run 用）' },
    },
    async execute(args) {
      const action = args.action || 'list'
      const summarize = (s: any) => ({
        id: s.id, name: s.name, agentIds: s.agentIds, message: s.message.slice(0, 120),
        rule: s.rule, ruleText: ruleText(s.rule), enabled: s.enabled,
        nextRunAt: s.nextRunAt, lastRunAt: s.lastRunAt, totalRuns: s.totalRuns || 0, successRuns: s.successRuns || 0,
        runCount: (s.runs || []).length,
      })
      if (action === 'list') {
        return JSON.stringify({ ok: true, schedules: store.getSchedules().map(summarize), consoleUrl }, null, 2)
      }
      if (action === 'upsert') {
        const input = asJson(args.schedule)
        if (!input?.name || !String(input.name).trim()) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: '缺少 name' })
        const agentIds: string[] = Array.isArray(input.agentIds) ? input.agentIds.map(String) : []
        if (!agentIds.length) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: 'agentIds 至少一个子智能体' })
        for (const aid of agentIds) {
          if (!store.getAgent(aid)) return JSON.stringify({ ok: false, code: 'NOT_FOUND', field: 'agentId', error: `子智能体不存在: ${aid}` })
        }
        if (!String(input.message || '').trim()) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: '缺少 message（固定任务文本）' })
        let rule
        try {
          rule = normalizeRule(input.rule)
        } catch (err: any) {
          return JSON.stringify({ ok: false, code: 'INVALID_PARAM', field: 'schedule.rule', error: err?.message || '规则非法' })
        }
        const existing = input.id ? store.getSchedule(String(input.id)) : undefined
        const enabled = input.enabled === undefined ? (existing?.enabled ?? true) : Boolean(input.enabled)
        const saved = store.upsertSchedule({
          ...(input.id ? { id: String(input.id) } : {}),
          name: String(input.name).trim(),
          description: input.description ? String(input.description) : undefined,
          agentIds,
          message: String(input.message),
          rule,
          enabled,
          nextRunAt: enabled ? nextRun(rule, Date.now()) : undefined,
        })
        return JSON.stringify({ ok: true, message: '定时任务已保存', schedule: summarize(saved) }, null, 2)
      }
      const id = String(args.scheduleId || '')
      const s = store.getSchedule(id)
      if (!s) return JSON.stringify({ ok: false, code: 'NOT_FOUND', error: '定时任务不存在' })
      if (action === 'get') {
        return JSON.stringify({ ok: true, schedule: { ...summarize(s), description: s.description, runs: (s.runs || []).slice(0, 10) } }, null, 2)
      }
      if (action === 'delete') {
        return JSON.stringify({ ok: true, deleted: store.deleteSchedule(id) })
      }
      if (action === 'toggle') {
        const enabled = !s.enabled
        store.mutateSchedule(id, (t) => {
          t.enabled = enabled
          t.nextRunAt = enabled ? nextRun(t.rule, Date.now()) : undefined
        })
        return JSON.stringify({ ok: true, schedule: summarize(store.getSchedule(id)!) })
      }
      if (action === 'run') {
        if (!deps.scheduler) return JSON.stringify({ ok: false, code: 'SERVICE_UNAVAILABLE', error: '调度器未装配' })
        const run = await deps.scheduler.fire(id, true)
        return JSON.stringify({ ok: Boolean(run), run }, null, 2)
      }
      return JSON.stringify({ ok: false, code: 'INVALID_PARAM', field: 'action', error: `不支持的 action: ${action}` })
    },
  }

  // 10. 主调度（规划器）管理
  const plannerManage: WorkBuddyToolDef = {
    name: 'workbuddy_planner_manage',
    description:
      '查看与设置 WorkBuddy 主调度: 主任务拆解默认在任务发起节点（主 DSH）执行，无需指定拆解器智能体（agentId 仅作节点不可达时的兜底，空串=自动挑选）、主调度模型在此设置。action: get（当前配置）/ set（修改）/ options（候选子智能体清单 + 当前节点可用模型列表）',
    parameters: {
      action: { type: 'string', description: '操作: get / set / options' },
      agentId: { type: 'string', description: 'set 用：兜底拆解子智能体 ID（仅任务节点不可达时使用）；空串 = 自动挑选' },
      model: { type: 'string', description: 'set 用：主调度模型（provider/model-id，如 deepseek/deepseek-v3）；空串 = 默认模型' },
    },
    async execute(args) {
      const action = args.action || 'get'
      const settings = store.getSettings()
      if (action === 'get') {
        const main = planner.pickMainAgent()
        return JSON.stringify({ ok: true, planner: settings.planner, effectiveMainAgent: main ? { id: main.id, name: main.name, model: [main.provider, main.model].filter(Boolean).join('/') } : undefined }, null, 2)
      }
      if (action === 'set') {
        const hasAgent = typeof args.agentId === 'string'
        const hasModel = typeof args.model === 'string'
        if (!hasAgent && !hasModel) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: '至少提供 agentId 或 model（空串=恢复默认）' })
        const agentId = hasAgent ? (String(args.agentId).trim() || undefined) : undefined
        if (agentId && !store.getAgent(agentId)) return JSON.stringify({ ok: false, code: 'NOT_FOUND', field: 'agentId', error: `子智能体不存在: ${agentId}` })
        const model = hasModel ? (String(args.model).trim() || undefined) : undefined
        store.updateSettings({ planner: { ...(hasAgent ? { agentId } : {}), ...(hasModel ? { model } : {}) } } as any)
        return JSON.stringify({ ok: true, planner: store.getSettings().planner, message: '主调度配置已更新' })
      }
      if (action === 'options') {
        const picked = await planner.plannerTarget()
        let models: Array<{ provider: string; id: string; name?: string; isDefault?: boolean }> = []
        let modelError: string | undefined
        if (picked.baseUrl) {
          const target = { baseUrl: picked.baseUrl, online: true, resolvedAt: new Date().toISOString(), mappingId: '', apiKey: picked.apiKey }
          const r = await client.getModels(target as any)
          models = r.models || []
          if (!r.ok) modelError = r.error || '模型目录获取失败'
        }
        return JSON.stringify({
          ok: true,
          agents: store.getAgents().map((a) => ({ id: a.id, name: a.name, enabled: a.enabled !== false })),
          models: models.map((m) => ({ provider: m.provider, id: m.id, name: m.name, isDefault: m.isDefault })),
          current: { agentId: picked.agentId, auto: picked.auto !== false, model: settings.planner.model },
          error: picked.error,
          modelError,
        }, null, 2)
      }
      return JSON.stringify({ ok: false, code: 'INVALID_PARAM', field: 'action', error: `不支持的 action: ${action}` })
    },
  }

  // Replay authorization is bound to the root/node/task that actually executed the request.
  const fileReplayScopes = new Map<string, { at: number; fingerprint: string }>()
  const fileReplayKey = (args: Record<string, any>, ctx: ToolCallContext) => JSON.stringify([ctx.callerId, ctx.rpcId, ctx.session?.userId, args])
  const fileScopeFingerprint = (args: Record<string, any>, project?: Project) => {
    const task = args.taskId ? store.getTask(String(args.taskId)) : undefined
    const agent = args.agent ? store.getAgent(String(args.agent)) : undefined
    return JSON.stringify([project?.id, project?.workspace, project?.dshRef, task?.projectId, task?.nodeRef, task?.workDir, agent?.dshRef, agent?.workDir])
  }

  function fileScope(args: Record<string, any>, ctx: ToolCallContext): Project | undefined {
    const write = !['list', 'download'].includes(args.action || 'list')
    if (args.taskId) {
      const task = store.getTask(String(args.taskId))
      if (!task || (ctx.session && !canViewTask(ctx.session, task, { projects: store.getProjects() }))) throw new WorkspaceFileError(404, 'TASK_NOT_FOUND', '任务不存在')
      if (task.projectId) {
        const project = store.getProject(task.projectId)
        requireProjectFiles(ctx.session, project, write)
        if (args.agent && args.agent !== '__node__') throw new WorkspaceFileError(400, 'PROJECT_FILE_TARGET', '项目文件固定使用文件归属节点，请省略 agent')
        if (['upload_resumable_init', 'upload_register'].includes(args.action)) requireNodeFiles(ctx.session)
        return project
      }
    }
    requireNodeFiles(ctx.session)
    return undefined
  }

  // 11. 远端工作区文件管理
  const fileManage: WorkBuddyToolDef = {
    name: 'workbuddy_file_manage',
    description:
      '管理远端工作区文件: list（列目录）/ mkdir / upload（base64 内容 ≤1MB，或给 http(s) URL 由服务器拉取 ≤10MB）/ download（返回 utf8 文本或 base64，≤8MB）/ delete / upload_resumable_init + upload_register（大文件 P2P 直传，最大 2GB：init 下发 DSH 节点的 API 地址+密钥+会话与分片端点，调用方直连节点上传，不经本服务中转）。' +
      '项目文件请传 taskId，固定访问项目文件归属节点和根目录：成员可读，owner/admin 可写，归档只读；download 返回 sha256，upload 更新须带 expectedSha256，冲突不覆盖。agent/非项目节点文件及直传凭据仅管理员或服务令牌可用。' +
      '大文件场景（日志等）标准顺序：① task_manage create **不带 message**（任务 draft 不执行）→ ② upload_resumable_init 拿节点直连配方 → 直连节点：POST 节点 init → PUT 分片 → POST 节点 complete 得落盘路径 → ③ upload_register 登记附件（返回跨节点下载 URL+密钥）→ ④ task_manage {action:"send"} 引用路径（多成员协作时附 URL+密钥让其它节点自行下载）才开始执行',
    parameters: {
      action: { type: 'string', description: '操作: list / mkdir / upload / download / delete / upload_resumable_init / upload_register' },
      agent: { type: 'string', description: '子智能体 ID（与 taskId 二选一；__node__ 或缺省且给了 taskId 时按任务节点解析）' },
      taskId: { type: 'string', description: '任务 ID（操作任务/项目节点主会话工作区用；与 agent 二选一；upload_resumable_init/upload_register 必填，任务需已创建）' },
      path: { type: 'string', description: '路径（绝对路径，或相对其工作目录；list 缺省 = 工作目录；upload 缺省 = 上传到工作目录；upload_register 用：节点 complete 返回的落盘路径）' },
      name: { type: 'string', description: 'mkdir 的新目录名 / upload 的文件名（upload_resumable_init 用：落盘文件名）' },
      size: { type: 'string', description: 'upload_resumable_init 用：文件字节大小（最大 2GB）' },
      mimeType: { type: 'string', description: 'upload_resumable_init 可选：MIME 类型' },
      uploadId: { type: 'string', description: 'upload_register 用：upload_resumable_init 返回的直传会话 ID' },
      contentBase64: { type: 'string', description: 'upload 方式一：文件内容 base64（解码后 ≤1MB）' },
      url: { type: 'string', description: 'upload 方式二：http(s) 文件地址，由服务器拉取（≤10MB）' },
      encoding: { type: 'string', description: 'download 返回编码：auto（默认，文本 utf8 / 二进制 base64）或 base64' },
      expectedSha256: { type: 'string', description: 'upload 更新已有项目文件必填：download 返回的 sha256；省略仅可创建新文件；冲突后重新读取' },
    },
    canReplay(args, ctx, result) {
      try {
        const project = fileScope(args, ctx)
        // Reads are fresh: nested workspace ACLs and file contents can change independently of the task.
        if (['list', 'download'].includes(args.action || 'list')) return false
        const prior = fileReplayScopes.get(fileReplayKey(args, ctx))
        if (!prior || Date.now() - prior.at > 10 * 60_000 || prior.fingerprint !== fileScopeFingerprint(args, project)) return false
        if (project && !['upload_resumable_init', 'upload_register'].includes(args.action)) {
          let path = projectFilePath(project, args.path ? String(args.path) : undefined)
          if (['upload', 'mkdir'].includes(args.action)) path = workspaceChild(path, String(args.name || ''))
          requireWorkspacePath(ctx.session, project, store.getProjects(), directory, path, true, args.action === 'delete')
        }
        return JSON.parse(result).ok === true
      } catch { return false }
    },
    async execute(args, rawCtx) {
      const ctx = ctxOf(rawCtx)
      const action = args.action || 'list'
      let project: Project | undefined
      try { project = fileScope(args, ctx) } catch (err) { return JSON.stringify({ ok: false, code: (err as WorkspaceFileError).code, error: (err as Error).message }) }
      if (ctx.channel === 'mcp' && ctx.rpcId != null && !['list', 'download'].includes(action)) {
        for (const [key, value] of fileReplayScopes) if (Date.now() - value.at > 10 * 60_000) fileReplayScopes.delete(key)
        const replayKey = fileReplayKey(args, ctx), fingerprint = fileScopeFingerprint(args, project)
        const prior = fileReplayScopes.get(replayKey)
        if (prior && prior.fingerprint !== fingerprint) return JSON.stringify({ ok: false, code: 'WORKSPACE_SCOPE_CHANGED', error: '请求的项目/节点/工作区已变更；请重新检查后使用新的 RPC ID' })
        fileReplayScopes.set(replayKey, { at: Date.now(), fingerprint })
        if (fileReplayScopes.size > 1000) fileReplayScopes.delete(fileReplayScopes.keys().next().value!)
      }
      // 大文件 P2P 直传（≤2GB）：本服务只当下发节点直连配方的控制面，文件字节客户端直连 DSH 节点；
      // JSON-RPC 单帧装不下 2GB，分片 PUT / 节点 complete / register 凭据都由调用方直发 HTTP
      if (action === 'upload_resumable_init' || action === 'upload_register') {
        const tid = String(args.taskId || '').trim()
        if (!tid) return JSON.stringify({ ok: false, error: '缺少 taskId（先用 workbuddy_task_manage {action:"create"} 建任务，再往该任务上传）' })
        const task0 = store.getTask(tid)
        if (!task0) return JSON.stringify({ ok: false, code: 'NOT_FOUND', field: 'taskId', error: `任务不存在: ${tid}（用 workbuddy_task_manage {action:"list"} 查看可用任务）` })
        const base = String(ctx.requestBase || consoleUrl).replace(/\/$/, '')
        const enc = encodeURIComponent
        if (action === 'upload_resumable_init') {
          const size = Number(args.size)
          if (!Number.isFinite(size) || size <= 0) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: '缺少或非法 size（文件字节大小）' })
          const out = await engine.directUploadInit(tid, String(args.name || ''), size, args.mimeType ? String(args.mimeType) : undefined)
          if (!out.ok) return JSON.stringify(out, null, 2)
          const t = out.target!
          const nodeEp = (tail: string) => `${t.baseUrl}/sessions/${enc(t.sessionId)}/files/resumable${tail}`
          const chunkUrl = nodeEp(`/${enc('<nodeUploadId>')}`)
          // 任务状态回显 + 非 draft 警示：AI 常犯「create 带 message 已开跑才想起传附件」——
          // 执行者此刻已开始工作，附件传完也读不到；正确流程是 draft → 传附件 → send 启动
          const taskStatus = task0.status
          const notDraftHint = taskStatus !== 'draft'
            ? { warning: `任务当前状态 ${taskStatus}（已在执行或已结束，大概率是 create 带了 message）——本次上传执行者很可能读不到。推荐流程：create 不带 message（draft）→ 传附件 → task_manage send 引用路径启动` }
            : {}
          return JSON.stringify({
            ok: true,
            taskId: tid,
            taskStatus,
            ...notDraftHint,
            uploadId: out.uploadId,
            name: out.name,
            size: out.size,
            targetAgent: { agentId: t.agentId, agentName: t.agentName, sessionId: t.sessionId },
            direct: {
              baseUrl: t.baseUrl,
              ...(t.intranetBaseUrl ? { baseUrlIntranet: t.intranetBaseUrl } : {}),
              apiKey: t.apiKey,
              sessionId: t.sessionId,
              auth: `所有节点请求带 Authorization: Bearer ${t.apiKey}（两套基址通用）`,
              ...(t.intranetBaseUrl ? {
                intranetHint: 'baseUrlIntranet 是该节点的内网/本机基址（natpass 隧道 local 端），**有歧义**——每个节点的本机端都长这样，仅当「你所处的机器/内网恰好能通向该节点」时才可用且快得多。判定不靠猜：轻量预判可 GET baseUrlIntranet/api/v1/ping（机器指纹，免会话），返回 macs 与本机网卡 MAC（ip link/ifconfig）有交集即该节点就在本机；权威确认仍用 endpoints.init（会话作用域，sessionId 只有目标任务节点认识），返回 uploadId 即证明通向的就是目标任务节点，可全程走内网；404/401/超时则改用 baseUrl（公网隧道）。两套端点除基址外完全一致',
              } : {}),
              endpoints: {
                init: { method: 'POST', url: nodeEp(`?name=${enc(out.name!)}&size=${out.size}`) + (args.mimeType ? `&mimeType=${enc(String(args.mimeType))}` : ''), desc: '节点侧初始化 → 返回 data.uploadId（nodeUploadId）' },
                chunk: { method: 'PUT', url: chunkUrl.replace('<nodeUploadId>', '<nodeUploadId>') + '?offset=<已传字节数>', body: '原始分片字节（建议 4MB/片，顺序追加；offset 必须等于节点已接收字节数，409 时 GET status 对账）' },
                status: { method: 'GET', url: chunkUrl, desc: '查询节点已接收字节数（断点续传对账用）' },
                complete: { method: 'POST', url: `${chunkUrl}/complete`, desc: '节点侧完成 → 返回 data.files[0].path（工作区落盘绝对路径）' },
              },
              example: [
                `# ① 初始化（拿 nodeUploadId）`,
                `curl -X POST -H "Authorization: Bearer ${t.apiKey}" "${nodeEp(`?name=${enc(out.name!)}&size=${out.size}`)}"`,
                `# ② 顺序 PUT 分片（每片 4MB，offset=已传字节数）`,
                `curl -X PUT -H "Authorization: Bearer ${t.apiKey}" --data-binary @chunk.bin "${chunkUrl}?offset=0"`,
                `# ③ 完成（拿落盘路径）`,
                `curl -X POST -H "Authorization: Bearer ${t.apiKey}" "${chunkUrl}/complete"`,
                `# ④ 回本服务登记（把 ③ 返回的 path 填入 path 参数）`,
                `curl -X POST -H "Authorization: Bearer <AI令牌>" -H "Content-Type: application/json" -d '{"uploadId":"${out.uploadId}","path":"<③的path>"}" "${base}/api/tasks/${enc(tid)}/attachments/direct/register"`,
              ].join('\n'),
            },
            registerHint: { action: 'upload_register', taskId: tid, uploadId: out.uploadId, path: '<节点 complete 返回的 files[0].path>' },
            notes: 'P2P 直传：文件字节直连 DSH 节点，不经本服务。节点 complete 成功后必须调 upload_register 登记（否则任务附件列表/其它成员看不到该文件）。多成员协作：register 返回 downloadUrl + 节点密钥，把它们写进 send 的 message，其它节点的成员自行 curl 下载。任务仍是 draft 未执行——登记后再 send 才开始分析',
            consoleUrl,
          }, null, 2)
        }
        // upload_register：凭节点侧落盘路径登记附件
        const out = await engine.directUploadRegister(tid, String(args.uploadId || ''), String(args.path || ''), Number(args.size) || 0, args.mimeType ? String(args.mimeType) : undefined)
        if (!out.ok) return JSON.stringify(out, null, 2)
        const a = out.attachment!
        return JSON.stringify({
          ok: true,
          taskId: tid,
          attachment: { name: a.name, path: a.path, size: a.size },
          downloadUrl: a.downloadUrl,
          ...(out.downloadUrlIntranet ? { downloadUrlIntranet: out.downloadUrlIntranet, downloadUrlIntranetHint: '同节点的内网/本机下载基址——下载方与该节点同机/同内网时优先用（同样需密钥头；同机判定可 GET <基址>/api/v1/ping 比对返回 macs 与本机网卡 MAC；是否真通向目标节点以能取到文件为准，失败用 downloadUrl）' } : {}),
          downloadAuth: '跨节点下载需带节点密钥头：Authorization: Bearer <init 返回的 apiKey>（DSH 下载接口不支持 query 密钥）',
          example: `curl -H "Authorization: Bearer <节点apiKey>" -o ${a.name} "${a.downloadUrl}"`,
          multiAgentHint: '多成员协作：把 downloadUrl 与节点 apiKey 写进 workbuddy_task_manage {action:"send"} 的 message，其它节点的成员用它下载文件',
          nextAction: `任务仍是 draft 未执行：用 workbuddy_task_manage {action:"send", taskId:"${tid}", message:"附件已就位（路径 ${a.path}${a.downloadUrl ? '，跨节点下载 ' + a.downloadUrl : ''}），请分析…"} 开始`,
          consoleUrl,
        }, null, 2)
      }
      // 目标解析优先级：① agent 命中子智能体 → 其节点 + workDir；② taskId（或 agent=__node__）→ 任务/项目文件归属节点 + 项目 workspace
      const agentId = String(args.agent || '').trim()
      const task = String(args.taskId || '').trim() ? store.getTask(String(args.taskId).trim()) : undefined
      if (args.taskId && String(args.taskId).trim() && !task) return JSON.stringify({ ok: false, code: 'NOT_FOUND', field: 'taskId', error: `任务不存在: ${args.taskId}` })
      const agent = agentId && agentId !== '__node__' ? store.getAgent(agentId) : undefined
      if (agentId && agentId !== '__node__' && !agent) return JSON.stringify({ ok: false, code: 'NOT_FOUND', error: '子智能体不存在' })
      if (!agent && !task) return JSON.stringify({ ok: false, error: '缺少 agent（子智能体 ID）或 taskId（任务 ID，操作任务/项目文件归属工作区）：二者至少给一个' })
      let target: Awaited<ReturnType<typeof resolver.resolve>>
      let workDir = '.'
      if (agent) {
        target = await resolver.resolve(agent)
        workDir = agent.workDir || '.'
      } else {
        if (!task) return JSON.stringify({ ok: false, error: '缺少 agent（子智能体 ID）或 taskId（任务 ID）' })
        const workspace = engine.taskWorkspaceExec(task)
        const t = workspace.dshRef ? await resolver.resolveRef(workspace.dshRef, workspace.apiKey, 'task-workspace').catch(() => undefined) : await engine.resolveExecTarget(task, '__node__').catch(() => undefined)
        if (!t || !t.online || !t.baseUrl) return JSON.stringify({ ok: false, code: 'NODE_OFFLINE', error: t?.error || '任务节点不可达' })
        target = t as typeof target
        workDir = workspace.workspace || '.'
      }
      if (!target.online || !target.baseUrl) return JSON.stringify({ ok: false, code: 'NODE_OFFLINE', error: target.error || '节点不可达' })
      const checkedPath = async (input?: string, absent = false, recursive = false) => {
        if (!project) return { path: input || workDir, exists: true, listing: undefined }
        const path = projectFilePath(project, input)
        requireWorkspacePath(ctx.session, project, store.getProjects(), directory, path, !['list', 'download'].includes(action), recursive)
        return { path, ...await checkWorkspaceFsPath(client, target, project, path, absent) }
      }
      try {
      const workDirRef = workDir
      if (action === 'list') {
        const checked = await checkedPath(args.path)
        const out = checked.listing ? { ok: true, data: checked.listing } : await client.fsList(target, String(args.path || '') || workDirRef || undefined)
        if (out.ok && out.data && project) out.data.entries = out.data.entries.filter(entry => { try { requireWorkspacePath(ctx.session, project!, store.getProjects(), directory, entry.path, false); return true } catch { return false } })
        return JSON.stringify(out, null, 2)
      }
      if (action === 'mkdir') {
        if (!args.name) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: '缺少 name（新目录名）' })
        const parent = project ? projectFilePath(project, args.path) : String(args.path || '') || workDir
        if (project) await checkedPath(workspaceChild(parent, String(args.name)), true)
        const out = await client.fsMkdir(target, parent, String(args.name))
        return JSON.stringify(out, null, 2)
      }
      if (action === 'upload') {
        const filename = String(args.name || '').trim()
        if (!filename) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: '缺少 name（文件名）' })
        let data: Buffer
        if (args.contentBase64) {
          data = Buffer.from(String(args.contentBase64), 'base64')
          if (!data.length) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: 'contentBase64 无效' })
          if (data.length > 1024 * 1024) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: 'base64 内容解码后超过 1MB' })
        } else if (args.url) {
          const res = await fetch(String(args.url), { signal: AbortSignal.timeout(clamp(ctx.maxBlockMs || 30_000, 5_000, 30_000)) }).catch(() => undefined)
          if (!res || !res.ok) return JSON.stringify({ ok: false, error: `URL 拉取失败: ${res?.status || '网络错误'}` })
          data = Buffer.from(await res.arrayBuffer())
          if (data.length > 10 * 1024 * 1024) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: 'URL 文件超过 10MB' })
        } else {
          return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: 'upload 需要 contentBase64 或 url 之一' })
        }
        if (project) {
          const path = workspaceChild(projectFilePath(project, args.path), filename)
          const checked = await checkedPath(path, true)
          if (checked.exists && !args.expectedSha256) throw new WorkspaceFileError(428, 'VERSION_REQUIRED', '更新已有文件必须携带读取时的 expectedSha256')
          const out = await writeProjectFile(project, target, directory, path, data, args.expectedSha256)
          return JSON.stringify({ ...out, ...(out.ok ? { files: [{ name: filename, path, size: data.length, sha256: out.sha256 }] } : {}) })
        }
        const out = await client.fsUpload(target, String(args.path || '') || workDir, [{ filename, data }])
        return JSON.stringify(out, null, 2)
      }
      if (action === 'download') {
        const p = String(args.path || '')
        if (!p) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: '缺少 path（文件路径）' })
        const checked = await checkedPath(p)
        const out = await client.fsDownload(target, checked.path)
        if (!out.ok || !out.res) return JSON.stringify({ ok: false, code: out.code, status: out.status, error: out.error })
        const buf = Buffer.from(await out.res.arrayBuffer())
        // MCP 宿主单帧过大会被断链：窄通道只回小文件，大文件引导到控制台
        const downloadCap = ctx.channel === 'mcp' ? 512 * 1024 : 8 * 1024 * 1024
        if (buf.length > downloadCap) {
          return JSON.stringify({
            ok: false,
            error: `文件 ${(buf.length / 1024 / 1024).toFixed(2)}MB 超过当前通道上限 ${(downloadCap / 1024).toFixed(0)}KB`,
            hint: ctx.channel === 'mcp'
              ? 'MCP/语音通道回包过大会导致会话被宿主断开，请在控制台下载，或先切分文件后再取'
              : '请在控制台下载',
          })
        }
        const forced = String(args.encoding || 'auto')
        const isBinary = buf.includes(0)
        const useBase64 = forced === 'base64' || (forced === 'auto' && isBinary)
        return JSON.stringify({
          ok: true,
          name: out.name,
          size: buf.length,
          sha256: createHash('sha256').update(buf).digest('hex'),
          encoding: useBase64 ? 'base64' : 'utf8',
          content: useBase64 ? buf.toString('base64') : buf.toString('utf-8'),
        }, null, 2)
      }
      if (action === 'delete') {
        const p = String(args.path || '')
        if (!p) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: '缺少 path' })
        const checked = await checkedPath(p, false, true)
        if (project && checked.path === projectFilePath(project)) throw new WorkspaceFileError(403, 'WORKSPACE_ROOT_PROTECTED', '不能删除项目工作区根目录')
        const out = await client.fsRemove(target, checked.path)
        return JSON.stringify(out, null, 2)
      }
      return JSON.stringify({ ok: false, code: 'INVALID_PARAM', field: 'action', error: `不支持的 action: ${action}` })
      } catch (err) { return JSON.stringify({ ok: false, code: (err as WorkspaceFileError).code, error: (err as Error).message }) }
    },
  }

  // 13. ask 答复：答复任务里挂起的 ask_user_question 提问（远端交互卡）
  const askClient = new DshClient()
  const taskAskAnswer: WorkBuddyToolDef = {
    name: 'workbuddy_task_ask_answer',
    description:
      '答复 WorkBuddy 任务里挂起的 ask_user_question 提问（远端交互卡）。流程：先用 workbuddy_task_status(detail:"full") 或 workbuddy_task_chat ' +
      '找到提问成员与其 questions 的 id/选项 id，再用本工具提交答复；agentId 缺省时自动探测最近一个未答复提问的成员（含节点主会话 __node__）。' +
      '无人值守与语音场景关键：任务提问得不到答复会一直挂起。',
    parameters: {
      taskId: { type: 'string', description: '任务 ID' },
      answers: { type: 'json', description: '答复数组 [{id:"提问id", selected:["选项id"], custom:"自定义文本（可选）"}]；提问 id 与选项 id 见提问卡 arguments 里的 questions 字段' },
      agentId: { type: 'string', description: '可选：答复目标成员 ID；缺省自动探测最近挂起提问的成员' },
    },
    async execute(args) {
      const taskId = String(args.taskId || '').trim()
      const task = store.getTask(taskId)
      if (!task) return JSON.stringify({ ok: false, code: 'NOT_FOUND', field: 'taskId', error: `任务不存在: ${taskId}` })
      let agentId = String(args.agentId || '').trim()
      if (!agentId) {
        const turns = task.turns || []
        for (let i = turns.length - 1; i >= 0; i--) {
          const ask = (turns[i].tools || []).find((t) => (t.name === 'ask_user_question' || t.name === 'ask-user-question') && t.status === 'running')
          if (ask) { agentId = turns[i].agentId || '__node__'; break }
        }
      }
      if (!agentId) return JSON.stringify({ ok: false, code: 'INVALID_STATE', error: '任务里没有找到挂起的 ask_user_question 提问（先用 task_status detail=full 查看工具列表确认）' })
      const binding = task.sessions?.[agentId]
      if (!binding?.remoteSessionId) return JSON.stringify({ ok: false, error: '该成员在任务中没有远端会话绑定', code: 'NO_SESSION' })
      const agent = store.getAgent(agentId)
      const target = await engine.resolveExecTarget(task, agentId).catch(() => undefined)
      if (!target || !target.online || !target.baseUrl) {
        return JSON.stringify({ ok: false, code: 'NODE_OFFLINE', error: (target as any)?.error || '成员节点当前不可达' })
      }
      const answers = asJson(args.answers)
      if (!Array.isArray(answers) || !answers.length) return JSON.stringify({ ok: false, error: 'answers 必须是非空数组 [{id, selected, custom?}]' })
      const r = await askClient.answerQuestion(target, binding.remoteSessionId, answers)
      if (!r.ok) {
        return JSON.stringify({ ok: false, code: r.code, status: r.status, error: r.error || '答复提交失败', ...(r.supported !== undefined ? { supported: r.supported } : {}) })
      }
      return JSON.stringify({ ok: true, data: { answered: answers.length, agentId, taskId, consoleUrl } })
    },
  }

  // 12. 项目管理（项目 = 节点 + 工作区 + 指令 + 可@ sub agent + 连接器 + 技能 的可复用上下文）
  const projectManage: WorkBuddyToolDef = {
    name: 'workbuddy_project_manage',
    description:
      '管理 WorkBuddy 项目：list / get / upsert / delete。项目把「文件归属节点(DSH) + 工作目录 + 可选默认执行节点 + 项目指令 + 默认协作成员 + 连接器 + 技能」捆绑成一个可复用上下文；' +
      'task_manage create 带 projectId 即创建项目工作台任务（自动继承全部上下文，主会话在默认执行节点执行，task.nodeRef 可覆盖）。' +
      'defaultAgentIds 是项目默认协作成员（创建任务时服务端自动继承，可随时 @ 其他成员补充；不限制 @，也不自动全员派工）。' +
      'agents 查询已关联与历史实际参与 BOT；link_agent/unlink_agent 幂等修改单条关联，需要登录身份与项目管理权，关联不授予文件、节点或 BOT 使用权限。',
    parameters: {
      action: { type: 'string', description: '操作: list / get / upsert / delete' },
      projectId: { type: 'string', description: '项目 ID（get/delete/agents/link_agent/unlink_agent 用）' },
      agentId: { type: 'string', description: 'BOT 稳定 ID（link_agent/unlink_agent 必填）' },
      name: { type: 'string', description: 'list 项目名包含匹配，忽略大小写' },
      workspace: { type: 'string', description: 'list 工作目录包含匹配，忽略大小写' },
      keyword: { type: 'string', description: 'list 按ID/名称/工作目录/指令/技能搜索；空白分词全部命中' },
      limit: { type: 'string', description: 'list 每页数量，默认20，整数1–200' },
      offset: { type: 'string', description: 'list 起始偏移，默认0；按nextOffset续取' },
      compact: { type: 'string', description: 'list true返回ID/名称/节点引用/目录/成员ID/任务数，详情用get；默认false' },
      project: {
        type: 'json',
        description:
          'upsert 用: {name:"<项目名>", dshRef:{kind:"mapping", mappingId:"<DSH 映射 ID>"}, defaultExecutionNodeRef:<可选DSH引用或null清除>, workspace:"<工作目录>", instruction:"<项目指令>", ' +
          'defaultAgentIds:["<sub agent ID>",...], connectorIds:["ssh:<id>"|"map:<mappingId>",...], skillNames:["<技能名>",...]}' +
          '（编辑时带 id；defaultAgentIds = 项目默认协作成员，非 @ 白名单；传 [] 清空）',
      },
    },
    canReplay(args, ctx, result) {
      // Reads/errors must reflect current visibility. Replay successful writes only while still authorized.
      const action = String(args.action || 'list')
      const out = asJson(result)
      if (!out?.ok || (action !== 'upsert' && action !== 'delete')) return false
      if (!ctx.session) return true
      const id = action === 'upsert' ? out.project?.id : out.deleted
      const p = id ? store.getProject(String(id)) : undefined
      if (!p) return action === 'delete'
      return canAccessProject(ctx.session, p, 'edit') && (action === 'delete' || !p.archivedAt)
    },
    async execute(args, ctx) {
      const action = args.action || 'list'
      // Console requests carry user permissions. AI-token channels retain their existing service scope.
      const session = ctx?.session
      const canView = (p: import('./types.js').Project) => !session || canAccessProject(session, p, 'view')
      const canEdit = (p: import('./types.js').Project) => !session || canAccessProject(session, p, 'edit')
      if (['agents', 'link_agent', 'unlink_agent'].includes(action)) {
        try {
          const service = new ProjectAgents(store)
          const data = action === 'agents' ? service.forProject(String(args.projectId || ''), ctx)
            : service.change(String(args.projectId || ''), String(args.agentId || ''), action === 'link_agent', ctx)
          return JSON.stringify({ ok: true, data })
        } catch (err: any) { return JSON.stringify({ ok: false, status: err.status || 400, code: err.code, error: err.message }) }
      }
      if (action === 'list') {
        let query: ReturnType<typeof queryProjects>
        try { query = queryProjects(store.getProjects().filter(canView), args) }
        catch (err: any) { return JSON.stringify({ ok: false, status: err.status || 400, code: 'INVALID_PARAMS', error: err.message }) }
        const visibleTasks = store.getTasks().filter(t => !session || canViewTask(session, t, { projects: store.getProjects() }))
        const projects = query.rows.map((p) => {
          const taskCount = visibleTasks.filter(t => t.projectId === p.id).length
          if (query.compact) return compactProject(p, taskCount)
          const nodeTitle = p.dshRef.kind === 'direct'
            ? p.dshRef.apiBaseUrl
            : (p.dshRef.kind === 'mapping'
              ? (directory.resolveMapping(p.dshRef.mappingId)?.tunnelName || p.dshRef.mappingId)
              : (directory.resolveApp(p.dshRef.appId)?.appName || p.dshRef.appId))
          return {
            id: p.id,
            name: p.name,
            dshRef: p.dshRef,
            defaultExecutionNodeRef: p.defaultExecutionNodeRef,
            nodeTitle: nodeTitle || '(未配置节点)',
            workspace: p.workspace || '',
            defaultAgentIds: projectDefaultAgentIds(p),
            experts: projectDefaultAgentIds(p).map((id) => ({ id, name: store.getAgent(id)?.name || id })),
            skillNames: p.skillNames,
            connectorIds: p.connectorIds,
            taskCount,
          }
        })
        return JSON.stringify({
          ok: true,
          projects,
          ...query.metadata,
          usage: '发项目任务: workbuddy_task_manage {action:"create", projectId:"<项目ID>", message:"<指令>（可 @ sub agent）"} —— 节点/工作区/指令自动继承，无需再传',
        }, null, 2)
      }
      if (action === 'get') {
        const p = store.getProject(String(args.projectId || ''))
        if (!p || !canView(p)) return JSON.stringify({ ok: false, code: 'NOT_FOUND', error: '项目不存在', status: 404 }, null, 2)
        const { apiKey, ...project } = p
        return JSON.stringify({ ok: true, project: session ? project : p }, null, 2)
      }
      if (action === 'upsert') {
        const body = asJson(args.project)
        if (!body || typeof body !== 'object') return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: 'upsert 需要 project 参数（JSON）' }, null, 2)
        const existing = body.id ? store.getProject(String(body.id)) : undefined
        const name = String(body.name ?? existing?.name ?? '').trim()
        if (!name) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: '缺少项目名称 name' }, null, 2)
        if (existing && !canView(existing)) return JSON.stringify({ ok: false, code: 'NOT_FOUND', error: '项目不存在', status: 404 })
        if (existing && !canEdit(existing)) return JSON.stringify({ ok: false, code: 'PERMISSION_DENIED', error: '仅项目 owner 或平台管理员可编辑项目', status: 403 })
        if (existing?.archivedAt) return JSON.stringify({ ok: false, code: 'INVALID_STATE', error: '项目已归档（只读），请先恢复再编辑', status: 400 })
        const refInput = body.dshRef ?? existing?.dshRef
        const dshRef = normalizeDshRef(refInput)
        if ('error' in dshRef) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', field: 'dshRef', error: dshRef.error + '（形如 {kind:"mapping", mappingId:"<DSH 映射 ID>"}，映射 ID 用 workbuddy_resource_manage {action:"dsh"} 查询）' }, null, 2)
        const executionRef = body.defaultExecutionNodeRef == null ? undefined : normalizeDshRef(body.defaultExecutionNodeRef)
        if (executionRef && 'error' in executionRef) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', field: 'project.defaultExecutionNodeRef', error: executionRef.error })
        // defaultAgentIds 为 canonical；旧字段 expertIds 兼容别名（store 层镜像）
        const defaultAgentIds = projectDefaultAgentIdsFromInput(body)
        if (defaultAgentIds !== undefined && ctxOf(ctx).aiTokenOnly) return JSON.stringify({ ok: false, code: 'PERMISSION_DENIED', status: 403, error: '关联修改需要控制台登录身份' })
        try { new ProjectAgents(store).validateAgents(defaultAgentIds || [], ctxOf(ctx)) }
        catch (err: any) { return JSON.stringify({ ok: false, code: err.code, status: err.status, error: err.message }) }
        try {
          const saved = store.upsertProject({
            id: body.id ? String(body.id) : undefined,
            ...(!existing && session?.userId ? { owner: session.userId, projectMembers: [{ userId: session.userId, role: 'owner' as const, joinedAt: Date.now() }] } : {}),
            name,
            dshRef,
            apiKey: body.apiKey !== undefined ? String(body.apiKey) : undefined,
            ...('defaultExecutionNodeRef' in body ? { defaultExecutionNodeRef: executionRef as import('./types.js').DshRef | undefined } : {}),
            workspace: body.workspace !== undefined ? String(body.workspace) : undefined,
            instruction: body.instruction !== undefined ? String(body.instruction) : undefined,
            ...(defaultAgentIds !== undefined ? { defaultAgentIds } : {}),
            connectorIds: Array.isArray(body.connectorIds) ? body.connectorIds.map(String) : (existing?.connectorIds || []),
            skillNames: Array.isArray(body.skillNames) ? body.skillNames.map(String) : (existing?.skillNames || []),
          })
          const { apiKey, ...project } = saved
          return JSON.stringify({
            ok: true,
            project: session ? project : saved,
            usage: `发项目任务: workbuddy_task_manage {action:"create", projectId:"${saved.id}", message:"…"}`,
          }, null, 2)
        } catch (err) {
          if (err instanceof ProjectWorkspaceConflictError || err instanceof ProjectWorkspacePathError) return JSON.stringify({ ok: false, error: err.message, code: err.code, status: err.status })
          throw err
        }
      }
      if (action === 'delete') {
        const p = store.getProject(String(args.projectId || ''))
        if (!p || !canView(p)) return JSON.stringify({ ok: false, code: 'NOT_FOUND', error: '项目不存在', status: 404 })
        if (!canEdit(p)) return JSON.stringify({ ok: false, code: 'PERMISSION_DENIED', error: '仅项目 owner 或平台管理员可删除项目', status: 403 })
        store.deleteProject(p.id)
        return JSON.stringify({ ok: true, deleted: p.id }, null, 2)
      }
      return JSON.stringify({ ok: false, code: 'INVALID_PARAM', field: 'action', error: `不支持的 action: ${action}` })
    },
  }

  // 14. 专家库管理（roster + builtin + 用户自建的统一注册表）
  const expertManage: WorkBuddyToolDef = {
    name: 'workbuddy_expert_manage',
    description:
      '管理 WorkBuddy 专家库（名册 + 内置 + 用户自建统一视图）: list（分页，domain/skill 过滤）/ get（完整提示词档案）/ search（元数据 + prompt 正文全文检索）/ create / update / delete（仅用户自建可写，builtin/名册只读）。' +
      '专家的用法：task_manage create 的 message 里 @专家名 即委派（@ 多个 = 编排；@专家团名按团队合同展开成员）；' +
      '内置/名册专家要「改」时，用 create 建一个同领域的用户专家替代（copy-on-write），id 不可与其冲突',
    parameters: {
      action: { type: 'string', description: '操作: list / get / search / create / update / delete' },
      expertId: { type: 'string', description: '专家 ID（get / delete 用）' },
      domain: { type: 'string', description: 'list 可选：按分区过滤（如 team / user）' },
      skill: { type: 'string', description: 'list 可选：关键词过滤（name/描述/tags，大小写不敏感）' },
      query: { type: 'string', description: 'search 必填：全文检索关键词（元数据 + prompt 正文）' },
      limit: { type: 'string', description: 'list 可选：单页数量（默认 50，最大 200）' },
      offset: { type: 'string', description: 'list 可选：翻页偏移（默认 0）' },
      expert: {
        type: 'json',
        description:
          'create/update 用: {id:"<小写中划线 slug>", name?, description?, icon?, division?, tags?:["..."], ' +
          'systemPrompt:"<职责与约束提示词>", executionPrompt?, role?}（create 时 id 与 systemPrompt 必填；update 只需带 id + 要改的字段）',
      },
    },
    async execute(args) {
      const registry = deps.expertRegistry
      if (!registry) return JSON.stringify({ ok: false, code: 'SERVICE_UNAVAILABLE', error: '专家注册表未装配' })
      const action = args.action || 'list'
      try {
        if (action === 'list') {
          const idx = await registry.index()
          let experts = args.skill ? await registry.search(String(args.skill)) : [...idx.divisions.flatMap((d) => d.experts)]
          if (args.domain) experts = experts.filter((e) => e.division === String(args.domain))
          const total = experts.length
          const limit = clamp(Number(args.limit) || 50, 1, 200)
          const offset = Math.max(Number(args.offset) || 0, 0)
          return JSON.stringify(
            {
              ok: true,
              total,
              offset,
              limit,
              divisions: idx.divisions.map((d) => ({ division: d.division, divisionZh: d.divisionZh, count: d.count })),
              experts: experts.slice(offset, offset + limit).map((e) => ({
                id: e.id, name: e.name, division: e.division, source: e.source, icon: e.icon, description: e.description,
              })),
              usage: '完整档案用 get；派活在 task_manage create 的 message 里写 @专家名；翻页用 offset',
            },
            null,
            2,
          )
        }
        if (action === 'get') {
          const id = String(args.expertId || '').trim()
          if (!id) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: '缺少 expertId' }, null, 2)
          if (!await registry.get(id)) return JSON.stringify({ ok: false, code: 'NOT_FOUND', field: 'expertId', error: '专家不存在' })
          const profile = await registry.getProfile(id)
          return JSON.stringify({ ok: true, expert: profile }, null, 2)
        }
        if (action === 'search') {
          const q = String(args.query || '').trim().toLowerCase()
          if (!q) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: 'search 需要 query 参数' }, null, 2)
          const all = [...(await registry.index()).divisions.flatMap((d) => d.experts)]
          const out: Array<Record<string, unknown>> = []
          for (const e of all) {
            if (out.length >= 50) break
            const hay = [e.name, e.nameEn, e.description, e.descriptionEn, ...(e.tags ?? [])]
              .filter((v): v is string => typeof v === 'string').join('\n').toLowerCase()
            if (hay.includes(q)) { out.push({ ...e, matchedIn: 'metadata' }); continue }
            try {
              const p = await registry.getProfile(e.id)
              if (`${p.systemPrompt}\n${p.executionPrompt ?? ''}`.toLowerCase().includes(q)) out.push({ ...e, matchedIn: 'prompt' })
            } catch { /* 档案缺失的跳过 */ }
          }
          return JSON.stringify({ ok: true, total: out.length, experts: out, usage: 'matchedIn=prompt 的命中在正文里，完整提示词用 get' }, null, 2)
        }
        if (action === 'create' || action === 'update') {
          const body = asJson(args.expert)
          if (!body || typeof body !== 'object') return JSON.stringify({ ok: false, error: `${action} 需要 expert 参数（JSON）` }, null, 2)
          const id = String(body.id ?? '').trim()
          if (!id) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: '缺少专家 id（小写字母/数字中划线 slug，如 my-reviewer）' }, null, 2)
          const payload: Record<string, unknown> = { id }
          for (const k of ['name', 'description', 'icon', 'division', 'systemPrompt', 'executionPrompt', 'role']) {
            if (typeof body[k] === 'string') payload[k] = body[k]
          }
          if (Array.isArray(body.tags)) payload.tags = body.tags.map(String)
          if (action === 'create') {
            if (typeof body.systemPrompt !== 'string' || !body.systemPrompt.trim()) {
              return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: 'create 需要 systemPrompt（职责与约束提示词）' }, null, 2)
            }
            if (await registry.get(id)) return JSON.stringify({ ok: false, code: 'CONFLICT', field: 'expert.id', error: '专家 ID 已存在' })
            const saved = await registry.createExpert(payload as any)
            return JSON.stringify({ ok: true, message: '专家已创建（source=user，可再 update/delete）', expert: saved }, null, 2)
          }
          const existing = await registry.get(id)
          if (!existing) return JSON.stringify({ ok: false, code: 'NOT_FOUND', field: 'expert.id', error: '专家不存在' })
          if (!await registry.isEditable(id)) return JSON.stringify({ ok: false, code: 'PERMISSION_DENIED', error: '内置/名册专家只读' })
          const saved = await registry.updateExpert(id, payload as any)
          return JSON.stringify({ ok: true, message: '专家已更新', expert: saved }, null, 2)
        }
        if (action === 'delete') {
          const id = String(args.expertId || '').trim()
          if (!id) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: '缺少 expertId' }, null, 2)
          const ok = await registry.deleteExpert(id)
          if (!ok) {
            const exists = await registry.get(id)
            return JSON.stringify(
              { ok: false, code: exists ? 'PERMISSION_DENIED' : 'NOT_FOUND', error: exists ? '内置/名册专家只读，不可删除；要调整请创建同领域用户专家替代。' : '专家不存在。' },
              null,
              2,
            )
          }
          return JSON.stringify({ ok: true, deleted: id }, null, 2)
        }
        return JSON.stringify({ ok: false, code: 'INVALID_PARAM', field: 'action', error: `不支持的 action: ${action}` })
      } catch (err: any) {
        return JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2)
      }
    },
  }

  // consoleUrl 回显统一跟随调用方：服务端自视角（127.0.0.1:3081）在反代/公网入口下对调用方不可达，
  // 通道层带 requestBase 时把响应里的 consoleUrl 字符串整体替换为调用方基址（小智等无请求上下文通道保持原样）

  // 15. 专家团管理（内置 5 团只读；自定义团 CRUD + 启停）
  const teamManage: WorkBuddyToolDef = {
    name: 'workbuddy_team_manage',
    description:
      '管理 WorkBuddy 专家团（合同式多成员协作单元）: list（全部团队+成员职责）/ get（单个团队含合同全文）/ upsert（创建或整体更新，内置团只读）/ delete（仅自定义团）/ toggle（启停）。' +
      '用法：task_manage create 的 message 里 @团队名 即按团队合同全员编排；发任务前先用 list 确认团名与成员职责，避免猜名字',
    parameters: {
      action: { type: 'string', description: '操作: list / get / upsert / delete / toggle' },
      teamId: { type: 'string', description: '团队 ID（get / delete / toggle 用；list 可见）' },
      team: {
        type: 'json',
        description:
          'upsert 用: {id?(带 id=整体更新), name, goal, description?, constraints?, deliveryRequirements?, coordinatorPrompt?, templateId?(general|product|technical|content|data|research), enabled?, members:[{agentId?|expertId?, duty, instructions?}]}' +
          '（成员 2~8 人，duty 必填；expertId 引用专家库角色，执行时动态实例化在任务节点；agentId 引用既有子智能体，跑各自绑定节点）',
      },
    },
    async execute(args) {
      const action = args.action || 'list'
      try {
        if (action === 'list') {
          const all = store.getTeams()
          return JSON.stringify({
            ok: true,
            total: all.length,
            teams: all.map((t) => ({
              id: t.id,
              name: t.name,
              builtin: Boolean(t.builtin),
              enabled: t.enabled !== false,
              templateId: t.templateId || 'general',
              description: t.description,
              goal: t.goal,
              members: t.members.map((m) => ({ key: m.agentId || m.expertId, kind: m.agentId ? 'agent' : 'expert', duty: m.duty })),
            })),
            usage: '发任务：task_manage create 的 message 写 @团队名（按合同全员编排）；内置团 team-builtin-* 只读，可复制后改',
          }, null, 2)
        }
        if (action === 'get') {
          const id = String(args.teamId || '').trim()
          if (!id) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: '缺少 teamId' }, null, 2)
          const t = store.getTeams().find((x) => x.id === id)
          if (!t) return JSON.stringify({ ok: false, code: 'NOT_FOUND', field: 'teamId', error: `团队不存在: ${id}` }, null, 2)
          return JSON.stringify({ ok: true, team: t }, null, 2)
        }
        if (action === 'upsert') {
          const body = asJson(args.team)
          if (!body || typeof body !== 'object') return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: 'upsert 需要 team 参数（JSON）' }, null, 2)
          if (body.id && BUILTIN_TEAMS.some((t) => t.id === String(body.id))) {
            return JSON.stringify({ ok: false, code: 'PERMISSION_DENIED', error: '内置专家团只读；要改请不带 id 新建一个自定义团（复制成员后修改）' }, null, 2)
          }
          const parsed = await parseTeamInput(body, {
            getAgent: (id) => store.getAgent(id),
            getExpert: async (id) => await deps.expertRegistry?.get(id).catch(() => undefined),
            teams: store.getTeams(),
            currentId: body.id ? String(body.id) : undefined,
          })
          if (!parsed.ok) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', field: 'team', error: parsed.error }, null, 2)
          const saved = store.upsertTeam({ ...parsed.value, id: body.id || undefined })
          return JSON.stringify({ ok: true, team: saved, usage: '@团队名 发起全员编排' }, null, 2)
        }
        if (action === 'delete') {
          const id = String(args.teamId || '').trim()
          if (!id) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: '缺少 teamId' }, null, 2)
          if (BUILTIN_TEAMS.some((t) => t.id === id)) return JSON.stringify({ ok: false, code: 'PERMISSION_DENIED', error: '内置专家团只读，不可删除' }, null, 2)
          const ok = store.deleteTeam(id)
          return JSON.stringify(ok ? { ok: true, deleted: id } : { ok: false, code: 'NOT_FOUND', error: '团队不存在' }, null, 2)
        }
        if (action === 'toggle') {
          const id = String(args.teamId || '').trim()
          if (!id) return JSON.stringify({ ok: false, code: 'INVALID_PARAM', error: '缺少 teamId' }, null, 2)
          const t = store.getTeams().find((x) => x.id === id)
          if (!t) return JSON.stringify({ ok: false, code: 'NOT_FOUND', field: 'teamId', error: `团队不存在: ${id}` }, null, 2)
          if (t.builtin) return JSON.stringify({ ok: false, code: 'PERMISSION_DENIED', error: '内置专家团始终可用，不可停用' }, null, 2)
          const saved = store.upsertTeam({ ...t, enabled: t.enabled === false })
          return JSON.stringify({ ok: true, team: { id: saved.id, name: saved.name, enabled: saved.enabled !== false } }, null, 2)
        }
        return JSON.stringify({ ok: false, code: 'INVALID_PARAM', field: 'action', error: `不支持的 action: ${action}` }, null, 2)
      } catch (err: any) {
        return JSON.stringify({ ok: false, error: err?.message || String(err) }, null, 2)
      }
    },
  }

  // 16. backlog 待办管理（Backlog.md 兼容：项目工作区 backlog/tasks/*.md 的门面，契约见
  // docs/design-backlog-mcp-tool.md）。派发/聚合复用 backlog-service，与 HTTP 看板同一条写路径。
  const backlogManage = createBacklogManageTool({
    store,
    resolver,
    engine,
    client,
    nodeTitle: (p) => {
      const ref = p.dshRef
      if (ref.kind === 'mapping') return directory.resolveMapping(ref.mappingId)?.tunnelName || ref.mappingId
      if (ref.kind === 'app') return directory.resolveApp(ref.appId)?.appName || ref.appId
      return ref.apiBaseUrl
    },
  })

  const defs: WorkBuddyToolDef[] = [resourceManage, agentManage, taskManage, taskStatus, taskChat, taskEvaluate, taskAskAnswer, sshResourceManage, groupManage, monitorRead, scheduleManage, plannerManage, fileManage, projectManage, expertManage, teamManage, backlogManage]
  defs.push(createCapabilitiesTool(() => defs, deps.serverVersion))
  return defs.map((def) => ({
    ...def,
    inputSchema: toolInputSchema(def.name, def.parameters),
    outputSchema: TOOL_OUTPUT_SCHEMA,
    annotations: toolAnnotations(def.name),
    execute: async (args: Record<string, any>, ctx?: ToolCallContext) => {
      // 身份先于参数校验（契约 §3/裁定⑤）：声明 denyAiToken 的工具对 AI 令牌（无登录身份）的全部 action 一律拒绝
      if (def.denyAiToken && ctxOf(ctx).aiTokenOnly) {
        console.warn(`[安全审计] tool=${def.name} action=${(args && args.action) || ''} ai-token denied (ai-token-group-guard)`)
        return JSON.stringify({ ok: false, code: 'AI_TOKEN_DENIED', status: 403, error: 'AI 令牌无权访问该能力（数据按控制台登录用户隔离，无共享桶；请在控制台登录后操作）', denied: 'ai-token-group-guard' })
      }
      const checked = validateToolArgs(def.name, args)
      if (checked.errors.length) {
        return JSON.stringify(normalizeToolResult({
          ok: false, code: 'INVALID_PARAM',
          error: checked.errors.map((e) => `${e.path}: ${e.message}`).join('；'),
          errors: checked.errors,
          ...(checked.warnings.length ? { paramWarnings: checked.warnings } : {}),
        }, { tool: def.name, args: checked.args }))
      }
      const policy = toolActionPolicy(def.name, checked.args, ctxOf(ctx))
      if (!policy.allowed) {
        console.warn(`[安全审计] tool=${def.name} action=${policy.action} policy=${ctx?.readOnly ? 'read-only' : 'identity'} denied`)
        return JSON.stringify(toolFailure('PERMISSION_DENIED', policy.reason || '无权执行此操作', { action: policy.action, risk: policy.risk, ...(checked.warnings.length ? { paramWarnings: checked.warnings } : {}) }))
      }
      let result: Record<string, any>
      try {
        result = JSON.parse(await def.execute(checked.args, ctx))
      } catch (err: any) {
        // Unhandled failures have an uncertain write outcome; do not expose raw exceptions/credentials.
        result = toolFailure(typeof err?.code === 'string' ? err.code : 'EXECUTION_FAILED', '工具执行失败', { status: err?.status })
      }
      result = normalizeToolResult(result, { tool: def.name, args: checked.args })
      if (checked.warnings.length) result.paramWarnings = [...(Array.isArray(result.paramWarnings) ? result.paramWarnings : []), ...checked.warnings]
      const out = JSON.stringify(result)
      const pub = String(ctx?.requestBase || '').replace(/\/+$/, '')
      return pub && consoleUrl && out.includes(consoleUrl) ? String(out).split(consoleUrl).join(pub) : out
    },
  }))
}
