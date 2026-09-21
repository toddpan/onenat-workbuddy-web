/**
 * onenat-workbuddy-web - Tool Ops（宿主无关的工具能力层）
 *
 * 独立 WEB 服务：由 src/server.ts 暴露为 HTTP 工具通道 GET/POST /api/tools[/:name]。
 * 本文件严禁 import 任何 DSH / cordis 包，保证独立部署零依赖 DSH。
 */

import { createHash } from 'node:crypto'

import { DshClient } from './remote-client.js'
import type { OnenatDirectory } from './onenat.js'
import type { TaskEngine } from './engine.js'
import type { AgentResolver } from './resolver.js'
import type { PromptComposer } from './prompt-composer.js'
import type { Planner } from './planner.js'
import type { MonitorService } from './monitor.js'
import type { WorkStore } from './store.js'
import type { SshResourceStore } from './ssh-store.js'
import type { ScheduleRunner } from './scheduler.js'
import { normalizeRule, nextRun, ruleText } from './scheduler.js'
import { execOnSshResource, maskSshResource, normalizeSshResource, testSshResource } from './ssh-resources.js'
import { normalizeDshRef } from './router.js'

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
}

/** 默认上下文：HTTP 工具通道（AI 技能）按老行为可长阻塞 */
export const HTTP_TOOL_CTX: ToolCallContext = { channel: 'http', maxBlockMs: 600_000 }

function ctxOf(ctx?: ToolCallContext): ToolCallContext {
  return ctx && typeof ctx.maxBlockMs === 'number' ? ctx : HTTP_TOOL_CTX
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

/** create 幂等指纹：同内容（标题+正文+成员+模式）在窗口内重复到达 → 复用既有任务 */
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

function createFingerprint(title: unknown, message: unknown, memberIds: string[], mode: unknown): string {
  const material = [String(title ?? '').trim(), String(message ?? '').trim(), [...memberIds].sort().join(','), String(mode ?? '')].join('\u0001')
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
  execute(args: Record<string, any>, ctx?: ToolCallContext): Promise<string>
}

export interface ToolOpsDeps {
  store: WorkStore
  directory: OnenatDirectory
  resolver: AgentResolver
  composer: PromptComposer
  planner: Planner
  engine: TaskEngine
  sshStore: SshResourceStore
  /** 监控服务（monitor_read 用；未装配时该工具返回错误） */
  monitor?: MonitorService
  /** 调度器（schedule_manage 的 run 手动触发用） */
  scheduler?: ScheduleRunner
  /** 控制台地址（回显给调用方，便于人接手查看 UI） */
  consoleUrl: string
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
  const { store, directory, resolver, composer, planner, engine, sshStore, consoleUrl } = deps
  const client = new DshClient()

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
          return JSON.stringify({ ok: Boolean(ep), endpoint: ep }, null, 2)
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
      '管理 WorkBuddy 子智能体（绑定 ONENAT 上 DSH 实体，端口漂移免疫）: list / upsert / delete / ping / preview（资源提示词预览）/ models（远端可用模型）/ presets（远端预设）/ enable / disable',
    parameters: {
      action: { type: 'string', description: '操作: list / upsert / delete / ping / preview / models / presets / enable / disable' },
      agent: {
        type: 'json',
        description:
          '子智能体配置（upsert 用）: { id?, name, dshRef: {kind:"mapping",mappingId} | {kind:"app",appId} | {kind:"direct",apiBaseUrl}, apiKey?, agentPreset?, provider?, model?, systemPrompt?, workDir?, resources?: [{ref:{kind:"mapping",mappingId}, alias?, credentialMode:"inline|self-fetch|omit", skillMode:"all|none|{names}", note?}] }',
      },
      agentId: { type: 'string', description: '目标子智能体 ID（delete/ping/preview/models/presets/enable/disable 用）' },
    },
    async execute(args) {
      const action = args.action || 'list'
      if (action === 'list') {
        const agents = store.getAgents().map((a) => ({ ...a, apiKey: a.apiKey ? '***' : undefined }))
        return JSON.stringify({ ok: true, agents, consoleUrl }, null, 2)
      }
      if (action === 'upsert') {
        const agent: any = asJson(args.agent)
        if (!agent?.name) return JSON.stringify({ ok: false, error: '缺少 name' })
        const dshRef = normalizeDshRef(agent.dshRef || (agent.apiBaseUrl ? { kind: 'direct', apiBaseUrl: agent.apiBaseUrl } : undefined))
        if ('error' in dshRef) return JSON.stringify({ ok: false, error: dshRef.error })
        const saved = store.upsertAgent({ ...agent, dshRef })
        return JSON.stringify({ ok: true, message: '子智能体已保存', agent: { ...saved, apiKey: saved.apiKey ? '***' : undefined } }, null, 2)
      }
      const id = String(args.agentId || '')
      const agent = store.getAgent(id)
      if (action === 'delete') {
        return JSON.stringify({ ok: true, deleted: store.deleteAgent(id) })
      }
      if (action === 'enable' || action === 'disable') {
        if (!agent) return JSON.stringify({ ok: false, error: '子智能体不存在' })
        store.mutateAgent(id, (a) => { a.enabled = action === 'enable' })
        return JSON.stringify({ ok: true, agentId: id, enabled: action === 'enable' })
      }
      if (!agent) return JSON.stringify({ ok: false, error: '子智能体不存在' })
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
        if (!target.online) return JSON.stringify({ ok: false, error: target.error || '节点不可达' })
        if (action === 'models') {
          const r = await client.getModels(target)
          return JSON.stringify({ ok: r.ok, agent: agent.name, models: r.models, defaultModel: r.defaultModel, error: r.error }, null, 2)
        }
        const r = await client.getPresets(target)
        return JSON.stringify({ ok: r.ok, agent: agent.name, presets: r.presets, error: r.error }, null, 2)
      }
      return JSON.stringify({ ok: false, error: `不支持的 action: ${action}` })
    },
  }

  // 3. 任务管理
  const taskManage: WorkBuddyToolDef = {
    name: 'workbuddy_task_manage',
    description:
      '管理 WorkBuddy 任务会话（每任务一个聊天窗口，多轮对话）: list / create（可带首条消息立即发起，**立即回执不等待执行**）/ send（多轮发言）/ wait（查看进度快照；HTTP 通道可同步等结果，MCP 通道不阻塞）/ delete / members / cancel。' +
      '重要：创建后不要重复 create 同一任务（重复内容 2 分钟内会被自动去重复用既有任务），要进度请用 wait 或 workbuddy_task_status 轮询',
    parameters: {
      action: { type: 'string', description: '操作: list / create / send / wait / delete / members / cancel' },
      taskId: { type: 'string', description: '任务 ID（send/wait/delete/members/cancel 用）' },
      title: { type: 'string', description: '任务标题（create 可选）' },
      memberAgentIds: { type: 'json', description: '成员子智能体 ID 数组（create 可省略：省略即只归属主智能体；members 必填且非空）' },
      mode: { type: 'string', description: '模式: chat（单成员直通）或 orchestrate（多成员编排），缺省按成员数推断' },
      message: { type: 'string', description: '消息内容（create 可选首条消息；send 必填）' },
      timeoutMs: { type: 'string', description: 'wait 最长同步等待毫秒（HTTP 通道默认 120000 上限 600000；MCP 通道默认 0=立即回执，最多 20000）' },
    },
    async execute(args, rawCtx) {
      const ctx = ctxOf(rawCtx)
      const action = args.action || 'list'
      if (action === 'list') {
        const tasks = store.getTasks().map((t) => ({
          id: t.id,
          title: t.title,
          mode: t.mode,
          status: t.status,
          running: engine.isRunning(t.id),
          members: t.memberAgentIds,
          turns: t.turns.length,
          updatedAt: t.updatedAt,
        }))
        return JSON.stringify({ ok: true, tasks, consoleUrl }, null, 2)
      }
      if (action === 'create') {
        const memberIds: string[] = asJson(args.memberAgentIds)
        const explicit = Array.isArray(memberIds) ? memberIds.filter(Boolean) : []

        // ① 业务级幂等：同内容重复到达（平台重投/整轮重跑、AI 误重发）→ 复用既有任务，不再建第二个
        const fp = createFingerprint(args.title, args.message, explicit, args.mode)
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
              if (now - t.createdAt > CREATE_FUZZY_WINDOW_MS) return false
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

        const task = await engine.createTask({
          title: args.title,
          memberAgentIds: explicit,
          mode: args.mode,
          message: args.message,
          creator: 'tool',
        })
        createDedupe.set(fp, { at: Date.now(), taskId: task.id })
        // ② 立即回执：执行是异步的（流式进度走 SSE / 轮询），这里绝不等待首轮跑完
        return JSON.stringify({
          ok: true,
          accepted: true,
          taskId: task.id,
          title: task.title,
          mode: task.mode,
          status: task.status,
          running: engine.isRunning(task.id),
          members: task.memberAgentIds,
          receipt: '任务已受理并开始执行（异步）',
          nextAction: `进度用 workbuddy_task_status {taskId:"${task.id}"} 轮询，或 workbuddy_task_manage {action:"wait", taskId:"${task.id}"} 取快照；不要重复 create`,
          consoleUrl,
        }, null, 2)
      }
      const taskId = String(args.taskId || '')
      if (action === 'send') {
        if (!args.message) return JSON.stringify({ ok: false, error: '缺少 message' })
        const text = String(args.message)
        // 同任务 + 同正文的重复投递（平台整轮重跑）直接忽略，避免重复派发同一句话
        const fp = sha1(`${taskId}\u0001${text}`)
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
        const out = await engine.sendUserMessage(taskId, text)
        return JSON.stringify({
          ...out,
          accepted: out.ok,
          receipt: out.ok ? '消息已投递（异步执行中）' : undefined,
          nextAction: out.ok ? `用 workbuddy_task_status {taskId:"${taskId}"} 轮询回复` : undefined,
        }, null, 2)
      }
      if (action === 'wait') {
        const task0 = store.getTask(taskId)
        if (!task0) return JSON.stringify({ ok: false, error: '任务不存在' })
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
        const agentTurns = task.turns.filter((t) => t.role === 'agent')
        const lastReply = agentTurns.length ? preview(agentTurns[agentTurns.length - 1].text, 800) : ''
        return JSON.stringify({
          ok: true,
          timedOut: stillRunning && budget > 0,
          taskId,
          title: task.title,
          status: task.status,
          running: stillRunning,
          turns: task.turns.length,
          waitedMs: budget - Math.max(deadline - Date.now(), 0),
          summary: preview(task.summary, 800),
          lastReply,
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
        const memberIds = asJson(args.memberAgentIds)
        if (!Array.isArray(memberIds) || !memberIds.some((id) => Boolean(id))) {
          return JSON.stringify({ ok: false, error: 'members 需要 memberAgentIds（至少一个非空成员子智能体 ID）：HTTP 传数组或 JSON 字符串，CLI 用 --agents <id,id>' })
        }
        const t = engine.updateMembers(taskId, memberIds)
        return JSON.stringify({ ok: Boolean(t), task: t }, null, 2)
      }
      return JSON.stringify({ ok: false, error: `不支持的 action: ${action}` })
    },
  }

  // 4. 任务状态
  const taskStatus: WorkBuddyToolDef = {
    name: 'workbuddy_task_status',
    description:
      '查询 WorkBuddy 任务进度: 任务状态、编排计划（子任务列表与状态）、汇总结论。默认返回摘要（小回包，适合 MCP/语音等窄通道）；detail:"full" 才返回完整轮次与日志（回包很大）',
    parameters: {
      taskId: { type: 'string', description: '任务 ID（缺省列出全部任务概览）' },
      detail: { type: 'string', description: 'summary（默认，摘要）/ full（完整任务对象，含全部轮次与日志，回包很大）' },
    },
    async execute(args) {
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
      if (!task) return JSON.stringify({ ok: false, error: '任务不存在' })
      if (String(args.detail || 'summary') === 'full') {
        return JSON.stringify({ ok: true, running: engine.isRunning(task.id), task }, null, 2)
      }
      const agentTurns = task.turns.filter((t) => t.role === 'agent')
      const userTurns = task.turns.filter((t) => t.role === 'user')
      return JSON.stringify({
        ok: true,
        running: engine.isRunning(task.id),
        taskId: task.id,
        title: task.title,
        mode: task.mode,
        status: task.status,
        members: task.memberAgentIds,
        turns: task.turns.length,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        // 最近一轮实际由谁处理：member = 任务指定成员；main = 主智能体（改派）。让调用方看清「先回执 A、实际 B」的情况
        route: task.lastRoute
          ? { kind: task.lastRoute.kind, agentId: task.lastRoute.agentId, agentName: task.lastRoute.agentName, source: task.lastRoute.source }
          : undefined,
        lastUserMessage: preview(userTurns[userTurns.length - 1]?.text, 200),
        lastReply: preview(agentTurns[agentTurns.length - 1]?.text, 600),
        summary: preview(task.summary, 800),
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
        hint: '需要完整轮次/工具日志请传 detail:"full"（回包很大）或用控制台',
      }, null, 2)
    },
  }

  // 5. 任务聊天（远端会话记录 / 追问）
  const taskChat: WorkBuddyToolDef = {
    name: 'workbuddy_task_chat',
    description:
      '查看 WorkBuddy 任务中某个子任务（或成员会话）在远端 DSH 的聊天记录（默认最近 20 条 + 单条截断，可 maxMessages/maxTextChars 调整）；' +
      '带 followupMessage 时向远端会话追问：HTTP 通道同步等回复，MCP 通道立即回执、用下一次不带 followupMessage 的调用取结果',
    parameters: {
      taskId: { type: 'string', description: '任务 ID' },
      subtaskId: { type: 'string', description: '子任务 ID（编排任务的子任务）或成员 agentId（chat 模式）' },
      followupMessage: { type: 'string', description: '可选的追问消息；MCP 通道为异步投递（立即回执），HTTP 通道同步等待回复' },
      maxMessages: { type: 'string', description: '最多返回最近多少条消息（默认 20，上限 200）' },
      maxTextChars: { type: 'string', description: '单条消息正文截断字数（默认 2000，上限 20000；full=true 时不截断）' },
      full: { type: 'string', description: 'true = 不做条数/字数裁剪（回包很大，MCP 通道可能超上限，慎用）' },
    },
    async execute(args, rawCtx) {
      const ctx = ctxOf(rawCtx)
      const task = store.getTask(String(args.taskId || ''))
      if (!task) return JSON.stringify({ ok: false, error: '任务不存在' })
      const subId = String(args.subtaskId || '')
      if (!subId) return JSON.stringify({ ok: false, error: '缺少 subtaskId（子任务 ID 或成员 agentId）：先 workbuddy_task_status 看子任务/成员列表' })
      const sub = task.plan?.subtasks.find((s) => s.id === subId)
      const agentId = sub?.agentId || subId
      const binding = task.sessions[agentId]
      const agent = store.getAgent(agentId)
      if (!agent) return JSON.stringify({ ok: false, error: `未找到 ID「${subId}」对应的子任务或成员子智能体：请用 workbuddy_task_status {taskId:"${task.id}", detail:"full"} 查看该任务的子任务 ID / 成员 agentId，再用其作为 subtaskId` })
      if (!binding?.remoteSessionId) return JSON.stringify({ ok: false, error: '该成员尚未创建远程会话' })
      const target = await resolver.resolve(agent)
      if (!target.online) return JSON.stringify({ ok: false, error: target.error })
      const client = new DshClient()
      const stateKey = `${task.id}:${agentId}`
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
          engine.logTask(task.id, 'info', `追问已投递（异步）→ ${agent.name}：${preview(msg, 80)}`)
          const startedAt = Date.now()
          void client.prompt(target, binding.remoteSessionId, msg, { timeoutMs: 1_800_000 })
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
        const reply = await client.prompt(target, binding.remoteSessionId, msg, {
          timeoutMs: clamp(ctx.maxBlockMs || 120_000, 5_000, 120_000),
        })
        return JSON.stringify({ ok: reply.ok, reply: preview(reply.content, 8000), error: reply.error }, null, 2)
      }
      // 读聊天记录：条数 + 单条字数 + 总字节三重收敛（回包过大是 MCP 会话被打断的头号原因）
      const full = String(args.full || '') === 'true'
      const maxMessages = full ? 200 : clamp(Number(args.maxMessages) || 20, 1, 200)
      const maxTextChars = full ? 0 : clamp(Number(args.maxTextChars) || 2_000, 200, 20_000)
      const hist = await client.getHistory(target, binding.remoteSessionId, maxMessages)
      if (!hist.ok) return JSON.stringify({ ok: false, error: hist.error })
      const all = hist.messages || []
      const pick = full ? all : all.slice(-maxMessages)
      const messages: any[] = []
      let bytes = 0
      let clipped = all.length > pick.length
      for (const m of pick) {
        let item: any = m
        if (!full) {
          item = { ...m }
          const text = typeof m?.content === 'string' ? m.content : undefined
          if (text !== undefined && text.length > maxTextChars) {
            item.content = `${text.slice(0, maxTextChars)}…（截断，原文 ${text.length} 字）`
            clipped = true
          }
        }
        const size = Buffer.byteLength(JSON.stringify(item))
        // 总字节闸门：超过 32KB 就从最旧的开始丢
        if (!full && bytes + size > 32 * 1024) {
          clipped = true
          break
        }
        bytes += size
        messages.push(item)
      }
      const followup = followupState.get(stateKey)
      return JSON.stringify({
        ok: true,
        taskId: task.id,
        agentId,
        sessionId: binding.remoteSessionId,
        returned: messages.length,
        fetched: all.length,
        clipped,
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
      if (!task?.plan) return JSON.stringify({ ok: false, error: '任务不存在或无编排计划' })
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
      if (!r) return JSON.stringify({ ok: false, error: 'SSH 资源不存在' })
      if (action === 'get') return JSON.stringify({ ok: true, resource: r }, null, 2)
      if (action === 'delete') return JSON.stringify({ ok: true, deleted: sshStore.delete(r.id) })
      if (action === 'test') {
        const result = await testSshResource(r, Number(args.timeoutMs) || 8000)
        sshStore.update(r.id, { lastTestedAt: result.testedAt, lastTestOk: result.ok, lastTestError: result.ok ? undefined : result.error })
        return JSON.stringify({ ok: true, result }, null, 2)
      }
      if (action === 'exec') {
        if (!args.command) return JSON.stringify({ ok: false, error: '缺少 command' })
        // 通道能力决定单次阻塞上限：MCP 宿主等不住长命令（长阻塞 → 断链 → 平台重发整轮请求）
        const ctx = ctxOf(rawCtx)
        const cap = ctx.channel === 'mcp' ? clamp(ctx.maxBlockMs, 1_000, 20_000) : 60_000
        const timeoutMs = clamp(Number(args.timeoutMs) || (ctx.channel === 'mcp' ? 10_000 : 30_000), 1_000, cap)
        const result = await execOnSshResource(r, String(args.command), timeoutMs)
        const timedOut = !result.ok && /超时/.test(String(result.error || ''))
        return JSON.stringify({
          ok: true,
          result: { ...result, timeoutMs },
          hint: timedOut ? '命令未在通道预算内结束：请改成后台执行（nohup … &）后分段查询，或用控制台执行' : undefined,
        }, null, 2)
      }
      return JSON.stringify({ ok: false, error: `不支持的 action: ${action}` })
    },
  }

  // 8. 监控大屏读取
  const monitorRead: WorkBuddyToolDef = {
    name: 'workbuddy_monitor_read',
    description:
      '读取 WorkBuddy 监控大屏数据（一眼看全局运行态势）: overview（KPI/智能体在线忙闲/任务一句话状态/资源调用/告警）/ events（最近事件流，可增量拉取）/ history（近 N 天小时快照趋势）/ task（单任务当前活动与最近对话摘要）',
    parameters: {
      action: { type: 'string', description: '操作: overview / events / history / task' },
      limit: { type: 'string', description: 'events 返回条数（默认 50，最大 200）' },
      since: { type: 'string', description: 'events 只返回该毫秒时间戳之后的事件（增量轮询用）' },
      days: { type: 'string', description: 'history 天数（默认 7，最大 30）' },
      taskId: { type: 'string', description: 'task 操作的目标任务 ID' },
    },
    async execute(args) {
      const monitor = deps.monitor
      if (!monitor) return JSON.stringify({ ok: false, error: '监控服务未装配' })
      const action = args.action || 'overview'
      if (action === 'overview') {
        const ov = await monitor.getOverview()
        return JSON.stringify({ ...ov, events: ov.events.slice(0, 20), consoleUrl }, null, 2)
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
        if (!task) return JSON.stringify({ ok: false, error: '任务不存在' })
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
      return JSON.stringify({ ok: false, error: `不支持的 action: ${action}` })
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
        if (!input?.name || !String(input.name).trim()) return JSON.stringify({ ok: false, error: '缺少 name' })
        const agentIds: string[] = Array.isArray(input.agentIds) ? input.agentIds.map(String) : []
        if (!agentIds.length) return JSON.stringify({ ok: false, error: 'agentIds 至少一个子智能体' })
        for (const aid of agentIds) {
          if (!store.getAgent(aid)) return JSON.stringify({ ok: false, error: `子智能体不存在: ${aid}` })
        }
        if (!String(input.message || '').trim()) return JSON.stringify({ ok: false, error: '缺少 message（固定任务文本）' })
        let rule
        try {
          rule = normalizeRule(input.rule)
        } catch (err: any) {
          return JSON.stringify({ ok: false, error: err?.message || '规则非法' })
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
      if (!s) return JSON.stringify({ ok: false, error: '定时任务不存在' })
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
        if (!deps.scheduler) return JSON.stringify({ ok: false, error: '调度器未装配' })
        const run = await deps.scheduler.fire(id, true)
        return JSON.stringify({ ok: Boolean(run), run }, null, 2)
      }
      return JSON.stringify({ ok: false, error: `不支持的 action: ${action}` })
    },
  }

  // 10. 主调度（规划器）管理
  const plannerManage: WorkBuddyToolDef = {
    name: 'workbuddy_planner_manage',
    description:
      '查看与设置 WorkBuddy 主调度: 主任务拆解由哪个子智能体完成（agentId，空串=自动挑选）、主调度使用哪个模型。action: get（当前配置）/ set（修改）/ options（候选子智能体清单 + 当前节点可用模型列表）',
    parameters: {
      action: { type: 'string', description: '操作: get / set / options' },
      agentId: { type: 'string', description: 'set 用：拆解子智能体 ID；空串 = 自动挑选' },
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
        if (!hasAgent && !hasModel) return JSON.stringify({ ok: false, error: '至少提供 agentId 或 model（空串=恢复默认）' })
        const agentId = hasAgent ? (String(args.agentId).trim() || undefined) : undefined
        if (agentId && !store.getAgent(agentId)) return JSON.stringify({ ok: false, error: `子智能体不存在: ${agentId}` })
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
      return JSON.stringify({ ok: false, error: `不支持的 action: ${action}` })
    },
  }

  // 11. 远端工作区文件管理
  const fileManage: WorkBuddyToolDef = {
    name: 'workbuddy_file_manage',
    description:
      '管理子智能体远端工作区文件（在其 DSH 节点上，工作目录为该智能体 workDir）: list（列目录）/ mkdir / upload（base64 内容 ≤1MB，或给 http(s) URL 由服务器拉取 ≤10MB）/ download（返回 utf8 文本或 base64，≤8MB）/ delete',
    parameters: {
      action: { type: 'string', description: '操作: list / mkdir / upload / download / delete' },
      agent: { type: 'string', description: '子智能体 ID' },
      path: { type: 'string', description: '路径（绝对路径，或相对其工作目录；list 缺省 = 工作目录；upload 缺省 = 上传到工作目录）' },
      name: { type: 'string', description: 'mkdir 的新目录名 / upload 的文件名' },
      contentBase64: { type: 'string', description: 'upload 方式一：文件内容 base64（解码后 ≤1MB）' },
      url: { type: 'string', description: 'upload 方式二：http(s) 文件地址，由服务器拉取（≤10MB）' },
      encoding: { type: 'string', description: 'download 返回编码：auto（默认，文本 utf8 / 二进制 base64）或 base64' },
    },
    async execute(args, rawCtx) {
      const ctx = ctxOf(rawCtx)
      const action = args.action || 'list'
      const agent = store.getAgent(String(args.agent || ''))
      if (!agent) return JSON.stringify({ ok: false, error: '子智能体不存在' })
      const target = await resolver.resolve(agent)
      if (!target.online || !target.baseUrl) return JSON.stringify({ ok: false, error: target.error || '节点不可达' })
      const workDir = agent.workDir || '.'
      if (action === 'list') {
        const out = await client.fsList(target, String(args.path || '') || agent.workDir || undefined)
        return JSON.stringify(out, null, 2)
      }
      if (action === 'mkdir') {
        if (!args.name) return JSON.stringify({ ok: false, error: '缺少 name（新目录名）' })
        const out = await client.fsMkdir(target, String(args.path || '') || workDir, String(args.name))
        return JSON.stringify(out, null, 2)
      }
      if (action === 'upload') {
        const filename = String(args.name || '').trim()
        if (!filename) return JSON.stringify({ ok: false, error: '缺少 name（文件名）' })
        let data: Buffer
        if (args.contentBase64) {
          data = Buffer.from(String(args.contentBase64), 'base64')
          if (!data.length) return JSON.stringify({ ok: false, error: 'contentBase64 无效' })
          if (data.length > 1024 * 1024) return JSON.stringify({ ok: false, error: 'base64 内容解码后超过 1MB' })
        } else if (args.url) {
          const res = await fetch(String(args.url), { signal: AbortSignal.timeout(clamp(ctx.maxBlockMs || 30_000, 5_000, 30_000)) }).catch(() => undefined)
          if (!res || !res.ok) return JSON.stringify({ ok: false, error: `URL 拉取失败: ${res?.status || '网络错误'}` })
          data = Buffer.from(await res.arrayBuffer())
          if (data.length > 10 * 1024 * 1024) return JSON.stringify({ ok: false, error: 'URL 文件超过 10MB' })
        } else {
          return JSON.stringify({ ok: false, error: 'upload 需要 contentBase64 或 url 之一' })
        }
        const out = await client.fsUpload(target, String(args.path || '') || workDir, [{ filename, data }])
        return JSON.stringify(out, null, 2)
      }
      if (action === 'download') {
        const p = String(args.path || '')
        if (!p) return JSON.stringify({ ok: false, error: '缺少 path（文件路径）' })
        const out = await client.fsDownload(target, p)
        if (!out.ok || !out.res) return JSON.stringify({ ok: false, error: out.error })
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
          encoding: useBase64 ? 'base64' : 'utf8',
          content: useBase64 ? buf.toString('base64') : buf.toString('utf-8'),
        }, null, 2)
      }
      if (action === 'delete') {
        const p = String(args.path || '')
        if (!p) return JSON.stringify({ ok: false, error: '缺少 path' })
        const out = await client.fsRemove(target, p)
        return JSON.stringify(out, null, 2)
      }
      return JSON.stringify({ ok: false, error: `不支持的 action: ${action}` })
    },
  }

  return [resourceManage, agentManage, taskManage, taskStatus, taskChat, taskEvaluate, sshResourceManage, monitorRead, scheduleManage, plannerManage, fileManage]
}
