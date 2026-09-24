/**
 * onenat-workbuddy-web - 任务引擎（多轮聊天 + 编排调度 + SSE 事件枢纽）
 *
 * chat 模式: 单成员直通 —— 复用该成员的长持远端会话（D3），SSE 流式回填聊天窗口
 * orchestrate 模式: LLM Planner 拆解（D4）→ DAG 调度并发/串行派发 → 汇总（§6.3）
 * 所有派发前实时解析 DSH 入口（D1 端口漂移免疫）；远端无 SSE 时自动降级同步+轮询（D5）
 */

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, appendFile, stat, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { PromptResult, DshTarget } from './remote-client.js'
import { DshClient } from './remote-client.js'
import type { AgentResolver } from './resolver.js'
import type { PromptComposer } from './prompt-composer.js'
import { Planner, type PlanDraft } from './planner.js'
import type { OnenatDirectory } from './onenat.js'
import type { WorkStore } from './store.js'
import type { SubtaskLogEntry, AgentResourceBinding, DshRef, ExtractedFileMention, ExtractedMentions, PlanSubtask, Project, SubAgent, TaskEvent, TaskTurn, TurnToolCall, WorkTask } from './types.js'
import type { SshResourceStore } from './ssh-store.js'

/**
 * 节点主会话的伪 agentId：新模型下无 @ 的主会话不绑定任何 sub agent 身份，
 * 直接在任务节点（项目节点/所选节点）上以远端默认形态执行。该 id 仅存在于 task.sessions。
 */
const NODE_AGENT_ID = '__node__'

export interface CreateTaskInput {
  title?: string
  memberAgentIds: string[]
  mode?: 'chat' | 'orchestrate'
  message?: string
  /** 由定时任务派生时记录来源（任务列表/监控屏的 ⏰ 类型标识随任务持久化） */
  scheduleId?: string
  scheduleName?: string
  /** 创建者：'tool' = AI 工具通道（显式指定的成员受保护）/ 'console' = 控制台人工 */
  creator?: 'tool' | 'console'
  /** 所属项目：继承项目节点/工作区/指令/专家/连接器/技能 */
  projectId?: string
  /** 单独任务直接指定执行节点 */
  nodeRef?: DshRef
  /** 任务级连接器（'ssh:<id>' | 'map:<mappingId>' | 'app:<appId>'） */
  connectorIds?: string[]
  /** 任务级技能（/名 手势） */
  skillNames?: string[]
}

/** 取 prompt 尾部片段：降级轮询时供远端 history 定位本次回合的起点 user 消息（注入消息不含用户文本，天然排除） */
function turnFragment(prompt: string): string {
  return prompt.length > 400 ? prompt.slice(-400) : prompt
}

export class TaskEngine {
  private client = new DshClient()
  private sshStore: SshResourceStore | undefined
  private activeJobs = new Map<string, AbortController>()
  private hub = new Map<string, Set<(e: TaskEvent) => void>>()
  /**
   * 资源提示词块缓存：键 = taskId:agentId:agent.updatedAt（改绑定/技能即自动失效），
   * 值 = 块内容 + 合成时间；TTL 5 分钟兜底远端侧变更（技能文件更新等）。
   * 仅用于避免重复合成；直通路径命中后不重发块（靠远端会话历史延续）。
   */
  private blockCache = new Map<string, { block: string; at: number }>()
  private static readonly BLOCK_CACHE_TTL = 5 * 60_000

  private blockCacheKey(taskId: string, agent: { id: string; updatedAt?: number }): string {
    return `${taskId}:${agent.id}:${agent.updatedAt || 0}`
  }

  private blockCacheFresh(taskId: string, agent: { id: string; updatedAt?: number }): { block: string } | null {
    const e = this.blockCache.get(this.blockCacheKey(taskId, agent))
    if (!e || Date.now() - e.at >= TaskEngine.BLOCK_CACHE_TTL) return null
    return { block: e.block }
  }

  constructor(
    private store: WorkStore,
    private directory: OnenatDirectory,
    private resolver: AgentResolver,
    private composer: PromptComposer,
    private planner: Planner,
    sshStore?: SshResourceStore,
  ) {
    this.sshStore = sshStore}

  /** 从用户消息中提取 @子智能体 与 @资源（支持包含空格名称的最长前缀匹配与同名多实体解析） */
  /** 从用户消息中提取 @子智能体、@资源 以及 @文件（支持 @智能体:文件路径、@[智能体:文件路径] 及独立 @文件路径） */
  public extractMentions(text: string): ExtractedMentions {
    const mentionedAgentIds: string[] = []
    const mentionedResourceBindings: AgentResourceBinding[] = []
    const mentionedFiles: ExtractedFileMention[] = []
    const agents = this.store.getAgents()
    const endpoints = this.directory.listEndpoints()

    // 1. 构建候选字典（按名称长度降序排列，优先匹配最长包含空格的完整实体名，如 "SSH Server"）
    interface DictEntry {
      type: 'agent' | 'resource'
      name: string
      data: any
    }
    const dict: DictEntry[] = []

    for (const a of agents) {
      if (a.name) dict.push({ type: 'agent', name: a.name, data: a })
      if (a.id) dict.push({ type: 'agent', name: a.id, data: a })
    }

    for (const ep of endpoints) {
      if (ep.appName) dict.push({ type: 'resource', name: ep.appName, data: ep })
      if (ep.note && ep.note !== ep.appName) dict.push({ type: 'resource', name: ep.note, data: ep })
      if (ep.mappingId) dict.push({ type: 'resource', name: ep.mappingId, data: ep })
      // 支持带环境名的精确定向匹配（例："SSH Server (KB 136 环境)" 或 "SSH Server(KB 136 环境)"）
      if (ep.appName && ep.tunnelName) {
        dict.push({ type: 'resource', name: `${ep.appName} (${ep.tunnelName})`, data: ep })
        dict.push({ type: 'resource', name: `${ep.appName}(${ep.tunnelName})`, data: ep })
      }
    }

    dict.sort((a, b) => b.name.length - a.name.length)

    // 2. 扫描文本中所有的 '@' 索引位置
    let i = 0
    while (i < text.length) {
      if (text[i] === '@') {
        const startPos = i
        const rest = text.slice(i + 1)
        let matched = false

        // 优先检查方括号包裹，如 @[136-执行者:logs/app.log] 或 @[src/index.ts]
        const bracketMatch = /^\[([^\]]+)\]/.exec(rest)
        if (bracketMatch) {
          const inner = bracketMatch[1].trim()
          const colonIdx = inner.indexOf(':') !== -1 ? inner.indexOf(':') : inner.indexOf('：')
          if (colonIdx !== -1) {
            const prefix = inner.slice(0, colonIdx).trim()
            const filePath = inner.slice(colonIdx + 1).trim()
            const matchedAgent = agents.find(
              (a) => a.name.toLowerCase() === prefix.toLowerCase() || a.id.toLowerCase() === prefix.toLowerCase(),
            )
            if (matchedAgent && filePath) {
              const raw = text.slice(startPos, startPos + 1 + bracketMatch[0].length)
              mentionedFiles.push({
                raw,
                agentId: matchedAgent.id,
                agentName: matchedAgent.name,
                path: filePath,
                filename: filePath.split(/[\/\\]/).pop() || filePath,
              })
              if (!mentionedAgentIds.includes(matchedAgent.id)) {
                mentionedAgentIds.push(matchedAgent.id)
              }
              i = startPos + 1 + bracketMatch[0].length
              continue
            }
          } else if (inner.includes('/') || inner.includes('\\') || inner.includes('.')) {
            // 方括号内纯路径 @[src/index.ts]
            const raw = text.slice(startPos, startPos + 1 + bracketMatch[0].length)
            const defaultAgent = agents[0]
            if (defaultAgent) {
              mentionedFiles.push({
                raw,
                agentId: defaultAgent.id,
                agentName: defaultAgent.name,
                path: inner,
                filename: inner.split(/[\/\\]/).pop() || inner,
              })
              if (!mentionedAgentIds.includes(defaultAgent.id)) {
                mentionedAgentIds.push(defaultAgent.id)
              }
              i = startPos + 1 + bracketMatch[0].length
              continue
            }
          }
        }

        // 优先在词典中查找最长前缀匹配（支持名称中含有空格、短横线、中文等）
        for (const entry of dict) {
          if (rest.startsWith(entry.name)) {
            const afterName = rest.slice(entry.name.length)
            // 检查紧随其后是否是冒号 : 或 ：，即 @智能体名:文件路径 形式
            if (entry.type === 'agent' && (afterName.startsWith(':') || afterName.startsWith('：'))) {
              const afterColon = afterName.slice(1)
              const pathMatch = /^([^\s,，。!！?？;；]+)/.exec(afterColon)
              if (pathMatch && pathMatch[1].trim()) {
                const filePath = pathMatch[1].trim()
                const raw = text.slice(startPos, startPos + 1 + entry.name.length + 1 + pathMatch[0].length)
                const a = entry.data
                mentionedFiles.push({
                  raw,
                  agentId: a.id,
                  agentName: a.name,
                  path: filePath,
                  filename: filePath.split(/[\/\\]/).pop() || filePath,
                })
                if (!mentionedAgentIds.includes(a.id)) {
                  mentionedAgentIds.push(a.id)
                }
                matched = true
                i = startPos + raw.length
                break
              }
            }

            matched = true
            i += 1 + entry.name.length // 跳过当前 @ 和名称

            if (entry.type === 'agent') {
              const a = entry.data
              if (!mentionedAgentIds.includes(a.id)) {
                mentionedAgentIds.push(a.id)
              }
            } else if (entry.type === 'resource') {
              const ep = entry.data
              const refKey = ep.mappingId || ep.appId
              // 若有多个同名但不同 mappingId 的资源，查找未注入的同名映射
              const allSameNameEps = endpoints.filter((r) => r.appName === entry.name || r.note === entry.name)
              const unusedEp = allSameNameEps.find(
                (r) =>
                  !mentionedResourceBindings.some(
                    (b) => (b.ref.kind === 'mapping' ? b.ref.mappingId : b.ref.appId) === (r.mappingId || r.appId),
                  ),
              ) || ep

              const targetMappingId = unusedEp.mappingId
              const binding: AgentResourceBinding = {
                ref: targetMappingId
                  ? { kind: 'mapping', mappingId: targetMappingId }
                  : { kind: 'app', appId: unusedEp.appId! },
                alias: unusedEp.appName || unusedEp.note || entry.name,
                credentialMode: unusedEp.kind === 'ssh' ? 'inline' : 'self-fetch',
                skillMode: 'all',
                note: `用户当轮 @${entry.name} 动态指定使用`,
              }
              const bKey = binding.ref.kind === 'mapping' ? binding.ref.mappingId : binding.ref.appId
              if (!mentionedResourceBindings.some((b) => (b.ref.kind === 'mapping' ? b.ref.mappingId : b.ref.appId) === bKey)) {
                mentionedResourceBindings.push(binding)
              }
            }
            break
          }
        }

        if (!matched) {
          // 兜底：若未在已知字典精确匹配，尝试提取紧随的连续非标点单词
          const fallbackMatch = /^([^\s@,，。!！?？;；]+)/.exec(rest)
          if (fallbackMatch) {
            const rawTag = fallbackMatch[1].trim()
            const colonIdx = rawTag.indexOf(':') !== -1 ? rawTag.indexOf(':') : rawTag.indexOf('：')
            if (colonIdx !== -1) {
              const prefix = rawTag.slice(0, colonIdx).trim()
              const filePath = rawTag.slice(colonIdx + 1).trim()
              const matchedAgent = agents.find(
                (a) => a.name.toLowerCase() === prefix.toLowerCase() || a.id.toLowerCase() === prefix.toLowerCase(),
              )
              if (matchedAgent && filePath) {
                const raw = text.slice(startPos, startPos + 1 + fallbackMatch[0].length)
                mentionedFiles.push({
                  raw,
                  agentId: matchedAgent.id,
                  agentName: matchedAgent.name,
                  path: filePath,
                  filename: filePath.split(/[\/\\]/).pop() || filePath,
                })
                if (!mentionedAgentIds.includes(matchedAgent.id)) {
                  mentionedAgentIds.push(matchedAgent.id)
                }
                i = startPos + 1 + fallbackMatch[1].length
                continue
              }
            } else if ((rawTag.startsWith('/') || rawTag.startsWith('./') || rawTag.includes('.')) && (rawTag.includes('/') || rawTag.includes('\\'))) {
              // 独立文件路径 @src/index.ts 或 @/tmp/a.log
              const defaultAgent = agents[0]
              if (defaultAgent) {
                const raw = text.slice(startPos, startPos + 1 + fallbackMatch[0].length)
                mentionedFiles.push({
                  raw,
                  agentId: defaultAgent.id,
                  agentName: defaultAgent.name,
                  path: rawTag,
                  filename: rawTag.split(/[\/\\]/).pop() || rawTag,
                })
                if (!mentionedAgentIds.includes(defaultAgent.id)) {
                  mentionedAgentIds.push(defaultAgent.id)
                }
                i = startPos + 1 + fallbackMatch[1].length
                continue
              }
            }

            i += 1 + fallbackMatch[1].length

            const matchedAgent = agents.find(
              (a) => a.name.toLowerCase() === rawTag.toLowerCase() || a.id.toLowerCase() === rawTag.toLowerCase(),
            )
            if (matchedAgent && !mentionedAgentIds.includes(matchedAgent.id)) {
              mentionedAgentIds.push(matchedAgent.id)
            } else {
              const matchedEp = endpoints.find(
                (r) =>
                  (r.appName && r.appName.toLowerCase() === rawTag.toLowerCase()) ||
                  (r.note && r.note.toLowerCase() === rawTag.toLowerCase()) ||
                  r.mappingId === rawTag,
              )
              if (matchedEp) {
                const binding: AgentResourceBinding = {
                  ref: matchedEp.mappingId
                    ? { kind: 'mapping', mappingId: matchedEp.mappingId }
                    : { kind: 'app', appId: matchedEp.appId! },
                  alias: matchedEp.appName || matchedEp.note || rawTag,
                  credentialMode: matchedEp.kind === 'ssh' ? 'inline' : 'self-fetch',
                  skillMode: 'all',
                  note: `用户当轮 @${rawTag} 动态指定使用`,
                }
                const bKey = binding.ref.kind === 'mapping' ? binding.ref.mappingId : binding.ref.appId
                if (!mentionedResourceBindings.some((b) => (b.ref.kind === 'mapping' ? b.ref.mappingId : b.ref.appId) === bKey)) {
                  mentionedResourceBindings.push(binding)
                }
              }
            }
          } else {
            i++
          }
        }
      } else {
        i++
      }
    }

    return {
      mentionedAgentIds,
      mentionedResourceBindings,
      mentionedFiles: mentionedFiles.length > 0 ? mentionedFiles : undefined,
      cleanText: text,
    }
  }

  // ---------- 事件枢纽 ----------

  public subscribe(taskId: string, fn: (e: TaskEvent) => void): () => void {
    let set = this.hub.get(taskId)
    if (!set) {
      set = new Set()
      this.hub.set(taskId, set)
    }
    set.add(fn)
    return () => {
      set!.delete(fn)
      if (set!.size === 0) this.hub.delete(taskId)
    }
  }

  private globalTaps = new Set<(taskId: string, e: TaskEvent) => void>()

  /** 全局事件旁路（监控采集用）：无论该任务是否有 SSE 订阅者，所有事件都会流经这里 */
  public onTap(fn: (taskId: string, e: TaskEvent) => void): () => void {
    this.globalTaps.add(fn)
    return () => {
      this.globalTaps.delete(fn)
    }
  }

  private emit(taskId: string, event: TaskEvent): void {
    for (const fn of this.globalTaps) {
      try {
        fn(taskId, event)
      } catch {
        /* 单个旁路订阅者异常不影响其他 */
      }
    }
    const set = this.hub.get(taskId)
    if (!set) return
    for (const fn of set) {
      try {
        fn(event)
      } catch {
        /* 单个订阅者异常不影响其他 */
      }
    }
  }

  public isRunning(taskId: string): boolean {
    return this.activeJobs.has(taskId)
  }

  // ---------- 任务生命周期 ----------

  /**
   * 默认成员：调用方未显式指定成员时，任务只归属「主智能体」（Planner 配置的主调度，未配置时自动挑选）。
   *
   * 与消息路径 processUserMessage 的「未 @ 任何子智能体 → 主智能体应答」判定同源。
   * 明确不要退化成「全部子智能体」：那会把一句普通提问扩散成全员编排，
   * 并让一次附件上传把同一个文件扇出到所有节点（每个成员都会被建远端会话）。
   */
  public defaultMemberAgentIds(): string[] {
    const main = this.planner.pickMainAgent()
    return main ? [main.id] : []
  }

  public async createTask(input: CreateTaskInput): Promise<WorkTask> {
    const explicit = Array.isArray(input.memberAgentIds) ? input.memberAgentIds.filter((id) => Boolean(id)) : []
    // 新模型：成员账本 = 参与过的 sub agent（@ 时自动追加），不再预填「主智能体」；
    // 无 @ 的主会话直接在任务节点上执行（processUserMessage → runChatTurn 节点直发）
    const memberAgentIds = explicit.length ? [...new Set(explicit)] : []
    const mode: WorkTask['mode'] = input.mode || (memberAgentIds.length > 1 ? 'orchestrate' : 'chat')
    const task: WorkTask = {
      id: `task-${randomUUID().slice(0, 8)}`,
      title: input.title?.trim() || (input.message ? input.message.slice(0, 30) : '新任务'),
      mode,
      status: 'draft',
      memberAgentIds,
      creator: explicit.length ? (input.creator || 'tool') : 'console',
      turns: [],
      sessions: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...(input.scheduleId ? { scheduleId: input.scheduleId } : {}),
      ...(input.scheduleName ? { scheduleName: input.scheduleName } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.nodeRef ? { nodeRef: input.nodeRef } : {}),
      ...(input.connectorIds?.length ? { connectorIds: input.connectorIds } : {}),
      ...(input.skillNames?.length ? { skillNames: input.skillNames } : {}),
    }
    this.store.upsertTask(task)
    if (input.message?.trim()) {
      await this.sendUserMessage(task.id, input.message.trim())
    }
    return this.store.getTask(task.id)!
  }

  public updateMembers(taskId: string, memberAgentIds: string[]): WorkTask | undefined {
    const ids = Array.isArray(memberAgentIds) ? [...new Set(memberAgentIds.filter((id) => Boolean(id)))] : []
    if (!ids.length) throw new Error('members 需要至少一个非空成员子智能体 ID（memberAgentIds / CLI --agents <id,id>）')
    return this.store.mutateTask(taskId, (task) => {
      if (this.activeJobs.has(taskId)) throw new Error('任务执行中，暂不能变更成员')
      task.memberAgentIds = ids
      task.mode = task.memberAgentIds.length > 1 ? 'orchestrate' : task.mode
      return task
    })
  }

  public async deleteTask(taskId: string): Promise<boolean> {
    await this.cancelTask(taskId, '任务已删除')
    for (const k of [...this.blockCache.keys()]) {
      if (k.startsWith(taskId + ':')) this.blockCache.delete(k)
    }
    return this.store.deleteTask(taskId)
  }

  public async cancelTask(taskId: string, reason = '用户中止'): Promise<void> {
    const ctrl = this.activeJobs.get(taskId)
    if (ctrl) {
      ctrl.abort()
      this.activeJobs.delete(taskId)
    }

    // 中止仍在运行的远端子任务会话
    const task = this.store.getTask(taskId)
    if (task) {
      for (const sub of task.plan?.subtasks || []) {
        if (sub.status === 'running') {
          this.store.mutateSubtask(taskId, sub.id, (s) => {
            s.status = 'failed'
            s.error = reason
            s.completedAt = Date.now()
          })
          const binding = task.sessions[sub.agentId]
          const agent = this.store.getAgent(sub.agentId)
          if (binding && agent) {
            const target = await this.resolveExecTarget(task, sub.agentId).catch(() => undefined)
            if (target?.online) await this.client.cancelSession(target, binding.remoteSessionId).catch(() => {})
          }
          this.emit(taskId, { type: 'subtask_status', subtask: this.store.getTask(taskId)?.plan?.subtasks.find((s) => s.id === sub.id)! })
        }
      }
      // chat 直通会话同样向远端发送中断（仅断本地 SSE 远端会继续跑完）
      const taskAll = this.store.getTask(taskId)
      for (const aid of Object.keys(taskAll?.sessions || {})) {
        const binding = taskAll!.sessions[aid]
        if (!binding) continue
        // 会话可能建在项目节点上，按项目/任务指定节点优先解析；
        // 节点主会话（__node__）无智能体记录，用会话绑定 baseUrl + 任务凭证直发中断
        const ag = this.store.getAgent(aid)
        let tg = ag ? await this.resolveExecTarget(taskAll!, aid).catch(() => undefined) : undefined
        if (!tg && binding.baseUrl) {
          tg = { baseUrl: binding.baseUrl, apiKey: this.taskExec(taskAll!).apiKey, agentId: aid, online: true } as DshTarget & { online: boolean }
        }
        if (tg) await this.client.cancelSession(tg, binding.remoteSessionId).catch(() => {})
      }

      // 若任务当前状态是 running，置为 cancelled 并通知前端
      if (task.status === 'running') {
        this.store.mutateTask(taskId, (t) => {
          t.status = 'cancelled'
          // 将最后一个正在流式的 turn 结束
          for (const turn of t.turns) {
            if (turn.streaming) {
              turn.streaming = false
            }
            if (turn.tools) {
              for (const tool of turn.tools) {
                if (tool.status === 'running') {
                  tool.status = 'error'
                  tool.result = reason
                }
              }
            }
          }
        })
        this.appendSystemTurn(taskId, `⏹ 已停止 — ${reason}`)
        this.emit(taskId, { type: 'task_status', status: 'cancelled' })
        const fresh = this.store.getTask(taskId)!
        this.emit(taskId, { type: 'task_end', task: fresh })
      }
    }
  }

  public async retrySubtask(taskId: string, subtaskId: string): Promise<{ ok: boolean; error?: string }> {
    const task = this.store.getTask(taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    if (this.activeJobs.has(taskId)) return { ok: false, error: '任务正在执行中' }
    const sub = task.plan?.subtasks.find((s) => s.id === subtaskId)
    if (!sub) return { ok: false, error: '子任务不存在' }

    const ctrl = new AbortController()
    this.activeJobs.set(taskId, ctrl)
    this.store.mutateSubtask(taskId, subtaskId, (s) => {
      s.status = 'pending'
      s.error = undefined
      s.result = undefined
    })
    try {
      const agent = this.store.getAgent(sub.agentId)
      if (!agent) {
        this.store.mutateSubtask(taskId, subtaskId, (s) => {
          s.status = 'failed'
          s.error = '子智能体不存在'
        })
        return { ok: false, error: '子智能体不存在' }
      }
      const target = await this.resolveExecTarget(task, sub.agentId)
      if (!target) {
        this.store.mutateSubtask(taskId, subtaskId, (s) => {
          s.status = 'failed'
          s.error = '节点解析失败'
        })
        return { ok: false, error: '节点解析失败' }
      }
      await this.runSubtask(task, this.store.getTask(taskId)!.plan!.subtasks.find((s) => s.id === subtaskId)!, agent, target, [], [], ctrl.signal)
      // 重算汇总
      const fresh = this.store.getTask(taskId)!
      const summary = await this.planner.summarize(fresh.turns[0]?.text || fresh.title, fresh.plan?.subtasks || [], new Map())
      this.store.mutateTask(taskId, (t) => {
        t.summary = summary
        t.status = summary.status
      })
      this.emit(taskId, { type: 'task_end', task: this.store.getTask(taskId)! })
      return { ok: true }
    } finally {
      this.activeJobs.delete(taskId)
    }
  }

  // ---------- 多轮消息入口 ----------

  public async sendUserMessage(taskId: string, text: string): Promise<{ ok: boolean; turn?: TaskTurn; error?: string }> {
    const task = this.store.getTask(taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    if (!text.trim()) return { ok: false, error: '消息为空' }
    if (this.activeJobs.has(taskId)) return { ok: false, error: '上一轮仍在执行中，请稍候或先中止' }

    const turn: TaskTurn = { id: `turn-${randomUUID().slice(0, 8)}`, seq: 0, role: 'user', text: text.trim(), at: Date.now() }
    this.store.appendTurn(taskId, turn)
    this.store.mutateTask(taskId, (t) => {
      t.status = 'running'
    })
    this.emit(taskId, { type: 'turn_start', turn })

    // 提取 @ 提及的智能体与资源
    const mentions = this.extractMentions(text.trim())

    // 若提及了当前任务之外的新智能体，自动纳入任务成员
    if (mentions.mentionedAgentIds.length > 0) {
      this.store.mutateTask(taskId, (t) => {
        let changed = false
        for (const aid of mentions.mentionedAgentIds) {
          if (!t.memberAgentIds.includes(aid)) {
            t.memberAgentIds.push(aid)
            changed = true
          }
        }
        // 仅当明确 @ 了 ≥2 个不同智能体时才视为多智能体协同，升级为编排模式；
        // 恰 @ 1 个智能体保持原模式（直通/单人），避免「@某一智能体」被群成员数放大成跨多智能体流水线
        if (changed && t.memberAgentIds.length > 1 && mentions.mentionedAgentIds.length >= 2) {
          t.mode = 'orchestrate'
        }
      })
    }

    const ctrl = new AbortController()
    this.activeJobs.set(taskId, ctrl)

    // 异步执行，立即返回用户轮次（流式经 SSE 推送）
    void this.processUserMessage(taskId, text.trim(), mentions, ctrl.signal)
      .catch((err) => {
        this.appendSystemTurn(taskId, `⚠️ 引擎异常: ${err?.message || err}`)
      })
      .finally(() => {
        this.activeJobs.delete(taskId)
      })
    return { ok: true, turn }
  }

  private appendSystemTurn(taskId: string, text: string): TaskTurn {
    const turn: TaskTurn = { id: `turn-${randomUUID().slice(0, 8)}`, seq: 0, role: 'system', text, at: Date.now() }
    this.store.appendTurn(taskId, turn)
    this.emit(taskId, { type: 'turn_start', turn })
    this.emit(taskId, { type: 'turn_end', turn })
    return turn
  }

  /** 任务级持久日志（规划器/成员/会话事件），同时推 SSE */
  private taskLog(taskId: string, level: SubtaskLogEntry['level'], msg: string): void {
    this.store.mutateTask(taskId, (t) => {
      if (!t.taskLogs) t.taskLogs = []
      t.taskLogs.push({ ts: Date.now(), level, msg })
    })
    this.emit(taskId, { type: 'log', level, msg })
  }

  /** 供路由写入任务日志（对话配置变更等） */
  public logTask(taskId: string, level: SubtaskLogEntry['level'], msg: string): void {
    this.taskLog(taskId, level, msg)
  }

  private async processUserMessage(taskId: string, text: string, mentions: ExtractedMentions, signal: AbortSignal): Promise<void> {
    const task = this.store.getTask(taskId)
    if (!task) return

    // 智能调度模式判定：
    // 1. 如果用户明确 @ 了子智能体，按提及的智能体定向派发（如果多个则编排，单人则直通）；
    // 2. 如果用户完全没有 @ 任何子智能体（纯提问/咨询/诊断，如“分析为什么连接不上”）：
    //    由【主智能体（Planner / 本地主调度）】直接进行分析与应答（直通 chat 模式），避免强行将诊断性问题拆解分发给故障节点；
    //    注意：主智能体身份每条消息实时解析（planner.pickTarget → settings.planner.agentId），
    //    因此对话过程中切换主智能体后，下一条消息即路由到切换后的智能体（任何任务模式一致）。
    // 3. 主智能体不可用时才回退到任务既有成员。

    const hasExplicitAgentMention = mentions.mentionedAgentIds.length > 0
    // 本轮是否明确 @ 了“恰好一个”智能体 —— 用户只想把这件事交给那一个智能体，
    // 不应被任务已有的多成员/编排模式放大成跨多智能体流水线
    const singleExplicitMention = mentions.mentionedAgentIds.length === 1

    if (!hasExplicitAgentMention) {
      // 新模型：无 @ = 主会话直发任务节点。项目任务=项目配置节点；非项目任务=创建时所选节点。
      // 主会话不绑定任何 sub agent 身份（远端默认形态 + 项目指令），sub agent 通过 @ 在该节点上调用。
      const exec0 = this.taskExec(task)
      if (exec0.dshRef) {
        const nodeTarget = await this.resolver.resolveRef(exec0.dshRef, exec0.apiKey, NODE_AGENT_ID)
        if (!nodeTarget.online || !nodeTarget.baseUrl) {
          this.appendSystemTurn(taskId, `⚠️ 任务节点不可达: ${nodeTarget.error || '解析失败'}`)
          this.store.mutateTask(taskId, (t) => { t.status = 'failed' })
          this.emit(taskId, { type: 'task_status', status: 'failed' })
          return
        }
        const nodeAgent = this.makeNodeAgent(exec0)
        this.store.mutateTask(taskId, (t) => {
          t.lastRoute = { kind: 'chat', agentId: NODE_AGENT_ID, agentName: nodeAgent.name, source: 'node' }
        })
        await this.runChatTurn(taskId, text, mentions, new Map<string, DshTarget>([[NODE_AGENT_ID, nodeTarget]]), signal, NODE_AGENT_ID, nodeAgent)
        const fresh = this.store.getTask(taskId)!
        this.emit(taskId, { type: 'task_end', task: fresh })
        return
      }
      // 兜底：任务未绑定节点（存量任务/未选择节点）→ 默认智能体身份在其自身节点执行（UI 已无主智能体入口）
      const plannerTarget = await this.planner.pickTarget()
      if (!('error' in plannerTarget) && plannerTarget.agent) {
        const pAgent = plannerTarget.agent
        if (task.memberAgentIds.length <= 1 && !task.memberAgentIds.includes(pAgent.id)) {
          this.store.mutateTask(taskId, (t) => { t.memberAgentIds = [pAgent.id] })
        }
        const targetsMap = new Map<string, DshTarget>([[pAgent.id, plannerTarget.target]])
        this.store.mutateTask(taskId, (t) => {
          t.lastRoute = { kind: 'chat', agentId: pAgent.id, agentName: pAgent.name, source: 'main' }
        })
        await this.runChatTurn(taskId, text, mentions, targetsMap, signal, pAgent.id)
        const fresh = this.store.getTask(taskId)!
        this.emit(taskId, { type: 'task_end', task: fresh })
        return
      }
      // 默认智能体不可用 → 落到下方任务既有成员解析（仅存量任务会出现）
    }

    const { targets, issues } = await this.resolver.resolveMembers(task.memberAgentIds)
    for (const issue of issues) {
      this.taskLog(taskId, 'warn', `成员「${issue.name}」不可用: ${issue.error}`)
    }

    // 编排成员在自己绑定的节点上执行（sub agent=远程执行单元）；
    // 自身节点不可达时回退任务节点（项目节点/任务所选节点）
    const execO = this.taskExec(task)
    for (const [aid, t] of targets) {
      if (t?.online && t.baseUrl || !execO.dshRef) continue
      const nt = await this.resolver.resolveRef(execO.dshRef, execO.apiKey, aid).catch(() => undefined)
      if (nt?.online && nt.baseUrl) targets.set(aid, nt)
    }

    // @ 了恰好一个智能体：定向委派——与多 sub agent 编排同构：
    // 子任务在 sub agent 自身绑定节点执行，最终产物（汇总）回任务发起节点
    if (singleExplicitMention && hasExplicitAgentMention) {
      const onlyId = mentions.mentionedAgentIds[0]
      const onlyAgent = this.store.getAgent(onlyId)
      // 记录本轮路由：单人 @ → 定向委派
      this.store.mutateTask(taskId, (t) => {
        t.lastRoute = { kind: 'direct', agentId: onlyId, agentName: onlyAgent?.name || onlyId }
      })
      // 只解析被 @ 的那一个智能体（sub agent 回自身绑定节点，不可达时回退任务节点）
      const singleTarget = await this.resolveExecTarget(task, onlyId)
      if (singleTarget) {
        await this.runDelegatedTurn(taskId, text, mentions, onlyId, singleTarget, signal)
      } else {
        this.appendSystemTurn(taskId, `⚠️ 被 @ 的智能体「${this.store.getAgent(onlyId)?.name || onlyId}」暂不可用（项目节点与自身节点均不可达）`)
        this.store.mutateTask(taskId, (t) => { t.status = 'failed' })
        this.emit(taskId, { type: 'task_status', status: 'failed' })
      }
      const fresh = this.store.getTask(taskId)!
      this.emit(taskId, { type: 'task_end', task: fresh })
      return
    }

    if (targets.size === 0) {
      this.appendSystemTurn(taskId, `⚠️ 没有可用的子智能体成员：\n${issues.map((i) => `- ${i.name}: ${i.error}`).join('\n') || '成员列表为空'}`)
      this.store.mutateTask(taskId, (t) => {
        t.status = 'failed'
      })
      this.emit(taskId, { type: 'task_status', status: 'failed' })
      return
    }

    if (task.mode === 'chat' || targets.size === 1 || (!hasExplicitAgentMention && targets.size > 1)) {
      // 单智能体、直通模式或普通对话：走直通对话
      const targetAgentId = [...targets.keys()][0]
      this.store.mutateTask(taskId, (t) => {
        t.lastRoute = { kind: 'chat', agentId: targetAgentId, agentName: this.store.getAgent(targetAgentId)?.name || targetAgentId }
      })
      await this.runChatTurn(taskId, text, mentions, targets, signal)
    } else {
      // ≥2 个智能体被明确 @ 或任务本就设定为多智能体编排：走流程编排
      this.store.mutateTask(taskId, (t) => {
        t.lastRoute = { kind: 'orchestrate' }
      })
      await this.runOrchestrateTurn(taskId, text, mentions, targets, signal)
    }
    const fresh = this.store.getTask(taskId)!
    this.emit(taskId, { type: 'task_end', task: fresh })
  }

  /**
   * 根据发往的目标智能体（targetAgent），动态转换消息/指令中的 @文件 引用：
   * 1. 若文件属于当前目标智能体本机 -> 转换为本机本地文件路径（相对或绝对路径）；
   * 2. 若文件属于其他远程智能体 -> 转换为可直接通过 HTTP 下载的真实 URL，并生成 [跨节点文件引用] 指引段落（含 curl 下载指令）。
   */
  public async transformFileMentionsForAgent(
    text: string,
    mentions: ExtractedMentions | undefined,
    targetAgent: SubAgent,
    task?: WorkTask,
  ): Promise<{ text: string; extraSections: string[] }> {
    const files = mentions?.mentionedFiles || []
    if (!files.length) return { text, extraSections: [] }

    let resultText = text
    const localFiles: ExtractedFileMention[] = []
    const remoteFiles: Array<{ mention: ExtractedFileMention; downloadUrl: string; authHeader?: string }> = []

    for (const file of files) {
      if (file.agentId === targetAgent.id) {
        // 本地文件：替换 @agent:path 为本地 path
        localFiles.push(file)
        resultText = resultText.split(file.raw).join(file.path)
      } else {
        // 跨节点远程文件：生成下载 URL
        const ownerAgent = this.store.getAgent(file.agentId)
        let downloadUrl = ''
        let authHeader: string | undefined = undefined

        if (ownerAgent) {
          // 文件在会话所在节点（项目任务 = 项目节点），下载 URL 必须同源
          const ownerTarget = await this.resolveExecTarget(task, ownerAgent.id).catch(() => undefined)
          if (ownerTarget?.online && ownerTarget.baseUrl) {
            const base = ownerTarget.baseUrl.replace(/\/+$/, '')
            downloadUrl = `${base}/fs/download?path=${encodeURIComponent(file.path)}`
            if (ownerTarget.apiKey) {
              authHeader = `-H "Authorization: Bearer ${ownerTarget.apiKey}"`
            }
          }
        }

        if (!downloadUrl) {
          // 降级使用工作区代理下载路径
          downloadUrl = `/api/agents/fs/download?agent=${encodeURIComponent(file.agentId)}&path=${encodeURIComponent(file.path)}`
        }

        remoteFiles.push({ mention: file, downloadUrl, authHeader })
        resultText = resultText.split(file.raw).join(`[文件: ${file.filename}](${downloadUrl})`)
      }
    }

    const extraSections: string[] = []

    if (localFiles.length > 0) {
      const lines = localFiles.map(
        (f) => `- 文件「${f.filename}」: 路径为 \`${f.path}\`（位于当前智能体本机工作区，可直接使用文件读取/执行工具）`,
      )
      extraSections.push(`[本地文件清单]:\n${lines.join('\n')}`)
    }

    if (remoteFiles.length > 0) {
      const lines = remoteFiles.map((rf) => {
        const cmd = `curl -s ${rf.authHeader ? rf.authHeader + ' ' : ''}"${rf.downloadUrl}" -o "${rf.mention.filename}"`
        return (
          `- 文件「${rf.mention.filename}」（位于远程智能体「${rf.mention.agentName}」的主机上）:\n` +
          `  下载地址: ${rf.downloadUrl}\n` +
          `  获取指令: ${cmd}\n` +
          `  说明: 该文件位于远程智能体「${rf.mention.agentName}」电脑上，请使用上述指令下载到本地工作区后再行分析。`
        )
      })
      extraSections.push(`[跨节点远程文件清单（需要下载）]:\n${lines.join('\n')}`)
    }

    return { text: resultText, extraSections }
  }

  // ---------- chat 直通 ----------

  private async runChatTurn(
    taskId: string,
    text: string,
    mentions: ExtractedMentions,
    targets: Map<string, DshTarget>,
    signal: AbortSignal,
    overrideAgentId?: string,
    agentOverride?: SubAgent,
  ): Promise<void> {
    const task = this.store.getTask(taskId)!
    // 若显式 @ 了某个可用智能体，优先使用被 @ 的智能体；或使用指定的 overrideAgentId；
    // agentOverride = 节点主会话的「无身份」执行者（不来自 store）
    const preferredId = agentOverride?.id || overrideAgentId || mentions.mentionedAgentIds.find((id) => targets.has(id))
    const agentId = preferredId || task.memberAgentIds.find((id) => targets.has(id)) || [...targets.keys()][0]
    const agent = agentOverride || this.store.getAgent(agentId)!
    const exec = this.taskExec(task)
    // 执行节点由调用方解析（@ sub agent=自身绑定节点；主会话=任务节点），此处不再覆盖
    let target = targets.get(agentId)!

    const session = await this.ensureSession(taskId, agent, target)
    // 凭证刷新/节点重映射后的 target 要传导给后续 prompt/SSE 请求
    if (session.target) target = session.target
    if (!session.ok) {
      this.appendSystemTurn(taskId, `⚠️ 创建远程会话失败（${agent.name}）: ${session.error}`)
      this.store.mutateTask(taskId, (t) => {
        t.status = 'failed'
      })
      this.emit(taskId, { type: 'task_status', status: 'failed' })
      return
    }

    // 首轮消息且标题仍是默认值 → 在任务自身的远端会话内提炼标题。
    // 此前经 /chat/completions 不带 sessionId，dsh-web-service 会另起一个随机会话，
    // 远端节点因此多出「只有一条标题问答」的孤立任务；现在标题问答与任务工单共用同一会话。
    if (this.needsAutoTitle(task) && session.remoteSessionId) {
      const title = await this.planner.generateTitleInSession(target, session.remoteSessionId, text).catch(() => '')
      if (title) {
        this.store.mutateTask(taskId, (t) => {
          t.title = title
        })
        this.emit(taskId, { type: 'task_status', status: this.store.getTask(taskId)?.status || 'running' })
      }
    }

    const turn: TaskTurn = {
      id: `turn-${randomUUID().slice(0, 8)}`,
      seq: 0,
      role: 'agent',
      agentId: agent.id,
      agentName: agent.name,
      text: '',
      streaming: true,
      at: Date.now(),
    }
    this.store.appendTurn(taskId, turn)
    this.emit(taskId, { type: 'turn_start', turn })

    const transformed = await this.transformFileMentionsForAgent(text, mentions, agent, task)
    // 项目指令 + 专家系统提示词 + 项目 SSH 连接器：注入本轮提示词最前（项目上下文）
    const sysPrefix = [exec.instruction, agent.systemPrompt].filter(Boolean).join('\n\n')
    const sshSection = exec.sshConnectors.length
      ? '[项目 SSH 连接器]（已可用 onenat_ssh 工具直接操作，连接信息如下）:\n' + exec.sshConnectors.map((c) => '- ' + c.name + ' → ' + c.host + ':' + c.port).join('\n')
      : ''
    let fullPrompt = transformed.text
    const hasDynamicResources = mentions.mentionedResourceBindings.length > 0 || (mentions.mentionedFiles && mentions.mentionedFiles.length > 0)
    const cachedBlock = hasDynamicResources ? null : this.blockCacheFresh(taskId, agent)

    if (!cachedBlock) {
      const composed = await this.composer.compose(agent, {
        resolvedAt: Date.now(),
        extraResources: [...exec.extraBindings, ...mentions.mentionedResourceBindings],
        extraSkills: exec.skills,
      })
      const block = composed.block
      const extraFileSection = transformed.extraSections.join('\n\n')
      const allPrefixes = [block, extraFileSection].filter(Boolean).join('\n\n')
      const withCtx = [sysPrefix, sshSection, allPrefixes].filter(Boolean).join('\n\n')
      if (withCtx) {
        if (!hasDynamicResources) this.blockCache.set(this.blockCacheKey(taskId, agent), { block, at: Date.now() })
        fullPrompt = `${withCtx}\n\n[当前用户消息]:\n${transformed.text}`
      } else if (!hasDynamicResources) {
        this.blockCache.set(this.blockCacheKey(taskId, agent), { block: '', at: Date.now() })
      }
      for (const w of composed.warnings) this.emit(taskId, { type: 'log', level: 'warn', msg: w })
    } else {
      const extraFileSection = transformed.extraSections.join('\n\n')
      const allPrefixes = [cachedBlock.block, extraFileSection].filter(Boolean).join('\n\n')
      const withCtx = [sysPrefix, sshSection, allPrefixes].filter(Boolean).join('\n\n')
      if (withCtx) {
        fullPrompt = `${withCtx}\n\n[当前用户消息]:\n${transformed.text}`
      }
    }

    // 工具调用过程追踪（对齐 DSH ui-chat turn-process）
    const toolStarts = new Map<string, number>()
    // 单调递增流式序号：客户端按此顺序交错渲染 reasoning/tool/text 块（对齐 DSH assistant-block 序列）
    let streamSeq = 0
    const summarize = (v: any, cap: number): string | undefined => {
      if (v === undefined || v === null) return undefined
      let s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v) } catch { return String(v) } })()
      s = s.trim()
      if (!s) return undefined
      return s.length > cap ? s.slice(0, cap) + '…' : s
    }
    const emitTool = (tool: TurnToolCall) => {
      this.emit(taskId, { type: 'turn_tool', turnId: turn.id, tool, seq: streamSeq++ })
    }

    // 派发处理器抽为变量：空结果自愈时复用同一组回调重发
    const streamHandlers: Parameters<DshClient['streamPrompt']>[3] = {
      onDelta: (delta) => {
        // 内存即时可见 + 磁盘尾随合并：每个 delta 全量写盘会同步阻塞事件循环数毫秒，
        // 长回合累计数秒（详见 WorkStore.scheduleSave），进而拖垮 SSE 收发
        if (!this.store.appendTurnText(taskId, turn.id, delta)) {
          this.store.mutateTask(taskId, (t) => {
            const tt = t.turns.find((x) => x.id === turn.id)
            if (tt) tt.text += delta
          })
        }
        this.emit(taskId, { type: 'turn_delta', turnId: turn.id, delta, seq: streamSeq++ })
      },
      onReasoning: (delta) => {
        this.emit(taskId, { type: 'turn_reasoning', turnId: turn.id, delta, seq: streamSeq++ })
      },
      onToolCall: (info) => {
        const id = String(info.id || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`)
        toolStarts.set(id, Date.now())
        const isAskTool = info.name === 'ask_user_question' || info.name === 'ask-user-question'
        // ask_user_question 的 args 必须完整：截断的 JSON 会让前端交互卡解析失败，用户无法答复
        const tool: TurnToolCall = { id, name: String(info.name || 'unknown'), args: summarize(info.arguments, isAskTool ? 65_536 : 400), status: 'running', at: Date.now() }
        this.store.updateTurn(taskId, turn.id, (tt) => {
          tt.tools = tt.tools || []
          tt.tools.push(tool)
        })
        emitTool(tool)
        this.taskLog(taskId, 'tool', `工具调用: ${tool.name}${tool.args ? ' · ' + tool.args.slice(0, 120) : ''}`)
      },
      onToolResult: (info) => {
        const id = String(info.id || '')
        this.store.updateTurn(taskId, turn.id, (tt) => {
          tt.tools = tt.tools || []
          // 优先按 callId 配对；退化取最后一个执行中的调用（远端 result 事件可能无 name）
          let t = id ? tt.tools.find((x) => x.id === id) : undefined
          if (!t) t = [...tt.tools].reverse().find((x) => x.status === 'running')
          if (!t) return
          const isAskResult = t.name === 'ask_user_question' || t.name === 'ask-user-question'
          t.result = summarize(info.result, isAskResult ? 65_536 : 2000)
          t.status = info.isError ? 'error' : 'done'
          const startedAt = toolStarts.get(t.id)
          if (startedAt) t.ms = Date.now() - startedAt
          emitTool(t)
        })
      },
      onUsage: (usage) => {
        if (usage && typeof usage === 'object') {
          this.store.updateTurn(taskId, turn.id, (tt) => { tt.usage = { ...usage } })
          this.emit(taskId, { type: 'turn_usage', turnId: turn.id, usage, seq: streamSeq++ })
        }
      },
    }

    let result = await this.dispatchWithFallback(target, session.remoteSessionId!, fullPrompt, streamHandlers, signal)
    // 空结果自愈：远端收到指令但零内容零工具（LLM 上游瞬时异常/流丢失）——
    // 自动重发一次；有工具调用的回合绝不重发（避免发飞书等副作用重复执行）
    {
      const turnNow = this.store.getTask(taskId)!.turns.find((x) => x.id === turn.id)
      if (!signal.aborted && !(turnNow?.tools || []).length && !(streamSeq > 1)) {
        this.taskLog(taskId, 'warn', `${agent.name} 本轮无任何内容产出（远端流为空），自动重发一次`)
        result = await this.dispatchWithFallback(target, session.remoteSessionId!, fullPrompt, streamHandlers, signal)
      }
    }

    this.store.updateTurn(taskId, turn.id, (tt) => {
      tt.streaming = false
      // 收尾回填：轮询整轮重建的结果覆盖流式累积；但若流式累积反而更长（对账退化只取到尾部），保留流式版本避免丢内容
      if (result.ok && result.content) {
        if (!tt.text || result.content.length >= tt.text.length) tt.text = result.content
      } else if (!result.ok && !tt.text) tt.text = ''
      if (result.reasoning) tt.reasoning = result.reasoning
      if (result.usage && typeof result.usage === 'object') tt.usage = { ...result.usage }
      // 工具对账：SSE 断流后 tool_result 无法到达，把卡在 running 的工具落为 error 并注明原因，避免永久转圈
      for (const t of tt.tools || []) {
        if (t.status === 'running') {
          t.status = 'error'
          if (!t.result) t.result = '⚠️ SSE 流中断，工具结果未能回传（远端回合已结束，结果未知）'
        }
      }
    })
    const finalTurn = this.store.getTask(taskId)!.turns.find((x) => x.id === turn.id)!
    this.emit(taskId, { type: 'turn_end', turn: finalTurn })

    if (signal.aborted) {
      this.appendSystemTurn(taskId, `⏹ 已停止 — ${agent.name} 的本轮执行已中止`)
      this.store.mutateTask(taskId, (t) => {
        t.status = 'cancelled'
      })
      this.emit(taskId, { type: 'task_status', status: 'cancelled' })
      return
    }

    if (!result.ok && !finalTurn.text) {
      this.appendSystemTurn(taskId, result.error && result.error.includes('中止')
        ? `⏹ 已停止 — ${agent.name} 的本轮生成被中止，可继续追问`
        : `⚠️ 子智能体「${agent.name}」执行失败: ${result.error}`)
    }
    // 重发后仍零内容：显式失败并提示，绝不静默空完成（「没反应」的根源）
    if (result.ok && !finalTurn.text && !(finalTurn.tools || []).length) {
      this.appendSystemTurn(taskId, `⚠️ ${agent.name} 连续两轮未返回任何内容——节点 LLM 上游可能异常，请稍后重发，或用右上角切换器换个任务节点`)
      this.store.mutateTask(taskId, (t) => { t.status = 'failed' })
      this.emit(taskId, { type: 'task_status', status: 'failed' })
      return
    }
    this.store.mutateTask(taskId, (t) => {
      t.status = 'completed'
    })
    this.emit(taskId, { type: 'task_status', status: 'completed' })
  }

  // ---------- orchestrate 编排 ----------

  /**
   * 单 @ 委派的编排式执行（与多 sub agent 编排同构）：
   * 子任务在 sub agent 自身绑定节点执行（专项产物在其节点），
   * 最终产物（汇总）回任务发起节点。跳过规划器——@ 即委派，语义明确，省一次规划 LLM。
   */
  private async runDelegatedTurn(
    taskId: string,
    text: string,
    mentions: ExtractedMentions,
    agentId: string,
    target: DshTarget,
    signal: AbortSignal,
  ): Promise<void> {
    const agent = this.store.getAgent(agentId)
    const sub: PlanSubtask = {
      id: `sub-${randomUUID().slice(0, 8)}`,
      title: (text.replace(/@\S+/g, '').trim() || '执行任务').slice(0, 30),
      prompt: text,
      agentId,
      dependsOn: [],
      status: 'pending',
      logs: [],
    }
    this.store.mutateTask(taskId, (t) => {
      t.plan = { strategy: 'parallel', createdAt: Date.now(), subtasks: [sub] }
    })
    this.emit(taskId, { type: 'plan_update', plan: this.store.getTask(taskId)!.plan! })
    this.taskLog(taskId, 'info', `委派子任务给「${agent?.name || agentId}」（在其绑定节点执行），完成后汇总回任务发起节点`)

    await this.executeDag(taskId, mentions, new Map([[agentId, target]]), signal)

    // 最终产物归属发起节点：汇总在任务节点上执行（节点不可达时回退规划器节点）
    this.appendSystemTurn(taskId, '📊 子任务已完成，正在生成总结报告…')
    const fresh = this.store.getTask(taskId)!
    let summaryNodeTarget: DshTarget | undefined
    const execS = this.taskExec(fresh)
    if (execS.dshRef) {
      const nt = await this.resolver.resolveRef(execS.dshRef, execS.apiKey, 'summary').catch(() => undefined)
      if (nt?.online && nt.baseUrl) summaryNodeTarget = nt
    }
    const summary = await this.planner.summarize(text, fresh.plan?.subtasks || [], new Map([[agentId, target]]), summaryNodeTarget)
    this.store.mutateTask(taskId, (t) => {
      t.summary = summary
      t.status = summary.status
    })
    this.emit(taskId, { type: 'task_status', status: summary.status })
    const summaryTurn: TaskTurn = {
      id: `turn-${randomUUID().slice(0, 8)}`,
      seq: 0,
      role: 'agent',
      agentId: '__planner__',
      agentName: '🎯 总调度汇总',
      text: summary.finalConclusion,
      subtaskIds: [sub.id],
      at: Date.now(),
    }
    this.store.appendTurn(taskId, summaryTurn)
    this.emit(taskId, { type: 'turn_start', turn: summaryTurn })
    this.emit(taskId, { type: 'turn_end', turn: summaryTurn })
    this.store.save()
  }

  private async runOrchestrateTurn(
    taskId: string,
    text: string,
    mentions: ExtractedMentions,
    targets: Map<string, DshTarget>,
    signal: AbortSignal,
  ): Promise<void> {
    const task = this.store.getTask(taskId)!

    // 1. 花名册（资源摘要用轻量解析，不抓技能全文）
    const rosterMembers = task.memberAgentIds
      .map((id) => this.store.getAgent(id))
      .filter((a): a is SubAgent => Boolean(a) && targets.has(a!.id))
      .map((agent) => ({
        agent,
        resourceSummary: (agent.resources || [])
          .map((r) => r.alias || r.ref.kind + ':' + (r.ref.kind === 'mapping' ? r.ref.mappingId : r.ref.appId))
          .join('、'),
      }))

    // 2. LLM 规划（失败兜底静态三段）。
    // 规划消息采用真流式生命周期：turn_start → 思考流(turn_reasoning) 与阶段日志(turn_delta) 增量推送 → 收敛后 turn_end。
    // 此前 appendSystemTurn 立即补发 turn_end，前端把规划消息标记为 settled，主调度的全部思考事件被丢弃，用户只能干等。
    const planTurn: TaskTurn = {
      id: `turn-${randomUUID().slice(0, 8)}`,
      seq: 0,
      role: 'system',
      agentName: '🎯 主调度规划',
      text: '🎯 主调度正在拆解主任务并规划子任务流水线…',
      streaming: true,
      at: Date.now(),
    }
    this.store.appendTurn(taskId, planTurn)
    this.emit(taskId, { type: 'turn_start', turn: planTurn })

    let draft: PlanDraft
    let plannerSeq = 0
    let plannerThinkBuf = ''
    let planTextBuf = planTurn.text
    const stageLines: string[] = []
    let planSettled = false
    const planT0 = Date.now()
    // 阶段日志镜像进规划气泡（▸ 行，实时可读）；任务日志抽屉仍保留全量记录
    const planStage = (msg: string): void => {
      stageLines.push(msg)
      const line = '\n▸ ' + msg
      planTextBuf += line
      this.store.updateTurn(taskId, planTurn.id, (tt) => { tt.text = planTextBuf })
      this.emit(taskId, { type: 'turn_delta', turnId: planTurn.id, delta: line, seq: plannerSeq++ })
    }
    // 收敛规划消息：写入最终结论行 + 阶段日志流水 + 完整思考文本，补发 turn_end
    const settlePlanTurn = (head: string): void => {
      if (planSettled) return
      planSettled = true
      const finalText = head + (stageLines.length ? '\n\n' + stageLines.map((l) => '▸ ' + l).join('\n') : '')
      this.store.updateTurn(taskId, planTurn.id, (tt) => {
        tt.streaming = false
        tt.text = finalText
        tt.reasoning = plannerThinkBuf || undefined
      })
      const finalTurn = this.store.getTask(taskId)!.turns.find((x) => x.id === planTurn.id)
      if (finalTurn) this.emit(taskId, { type: 'turn_end', turn: finalTurn })
    }
    const strategyLabel = (s: PlanDraft['strategy']): string =>
      s === 'sequential' ? '顺序执行' : s === 'dag' ? 'DAG 依赖编排' : '并行协同'

    let planned: Awaited<ReturnType<Planner['planTask']>>
    try {
      planned = await this.planner.planTask(text, rosterMembers, targets, {
        priorityAgentIds: mentions.mentionedAgentIds,
        onLog: (msg, level) => {
          this.taskLog(taskId, level || 'info', `[主调度] ${msg}`)
          planStage(msg)
        },
        onReasoning: (delta) => {
          plannerThinkBuf += delta
          this.store.updateTurn(taskId, planTurn.id, (tt) => { tt.reasoning = plannerThinkBuf })
          this.emit(taskId, { type: 'turn_reasoning', turnId: planTurn.id, delta, seq: plannerSeq++ })
        },
      })
    } catch (err: any) {
      planned = { error: `规划器异常: ${err?.message || err}` }
      this.taskLog(taskId, 'warn', `规划阶段异常: ${err?.message || err}`)
    }
    if ('plan' in planned) {
      draft = planned.plan
      const thinkNote = plannerThinkBuf ? ` · 主调度思考 ${plannerThinkBuf.length} 字` : ''
      settlePlanTurn(`✅ 拆解完成 — ${strategyLabel(draft.strategy)} · ${draft.subtasks.length} 个子任务 · 耗时 ${((Date.now() - planT0) / 1000).toFixed(1)}s${thinkNote}`)
      this.taskLog(taskId, 'info', `规划完成（${planned.plan.strategy}，${planned.plan.subtasks.length} 个子任务）`)
    } else {
      draft = Planner.fallbackPlan(text, rosterMembers)
      settlePlanTurn(`⚠️ LLM 规划不可用（${planned.error}），已回退静态三段拆解`)
      this.taskLog(taskId, 'warn', `规划器不可用（${planned.error}），已回退静态三段拆解`)
      if (planned.raw) {
        this.taskLog(taskId, 'warn', `规划器原始输出（前 500 字）: ${planned.raw.slice(0, 500).replace(/\s+/g, ' ')}`)
      }
    }

    // 3. title 依赖 → 子任务 id 依赖
    const idByTitle = new Map<string, string>()
    const subtasks: PlanSubtask[] = draft.subtasks.map((s) => {
      const id = `sub-${randomUUID().slice(0, 8)}`
      idByTitle.set(s.title, id)
      return {
        id,
        title: s.title,
        prompt: s.prompt,
        agentId: s.agentId,
        dependsOn: [],
        status: 'pending',
        logs: [],
      }
    })
    for (let i = 0; i < draft.subtasks.length; i++) {
      const src = draft.subtasks[i]
      subtasks[i].dependsOn = (src.dependsOn || [])
        .map((t) => idByTitle.get(t))
        .filter((x): x is string => Boolean(x))
    }
    // 成环检测（Kahn）: 有环则全部转 parallel
    if (this.hasCycle(subtasks)) {
      for (const s of subtasks) s.dependsOn = []
      draft.strategy = 'parallel'
      this.emit(taskId, { type: 'log', level: 'warn', msg: '规划依赖成环，已降级为并行执行' })
    }

    this.store.mutateTask(taskId, (t) => {
      t.plan = { strategy: draft.strategy, plannerModel: (planned as any).plannerModel, createdAt: Date.now(), subtasks }
      for (const s of subtasks) t.turns[t.turns.length - 1]?.subtaskIds?.push(s.id)
    })
    // 把 subtaskIds 挂到本轮 user turn 上（上面的 push 因数组为空不生效，这里补挂）
    this.store.mutateTask(taskId, (t) => {
      const lastUser = [...t.turns].reverse().find((x) => x.role === 'user')
      if (lastUser) lastUser.subtaskIds = subtasks.map((s) => s.id)
    })
    this.emit(taskId, { type: 'plan_update', plan: this.store.getTask(taskId)!.plan! })

    // 4. DAG 调度 (透传动态 mentions 资源)
    await this.executeDag(taskId, mentions, targets, signal)

    // 5. 汇总 —— 最终产物归属发起节点：汇总在任务节点上执行（节点不可达时回退规划器节点）
    this.appendSystemTurn(taskId, '📊 所有子任务已完成，主调度正在综合各方产出生成总结报告…')
    const fresh = this.store.getTask(taskId)!
    let summaryNodeTarget: DshTarget | undefined
    const execS = this.taskExec(fresh)
    if (execS.dshRef) {
      const nt = await this.resolver.resolveRef(execS.dshRef, execS.apiKey, 'summary').catch(() => undefined)
      if (nt?.online && nt.baseUrl) summaryNodeTarget = nt
    }
    const summary = await this.planner.summarize(text, fresh.plan?.subtasks || [], targets, summaryNodeTarget)
    this.store.mutateTask(taskId, (t) => {
      t.summary = summary
      t.status = summary.status
    })
    this.emit(taskId, { type: 'task_status', status: summary.status })
    const summaryTurn: TaskTurn = {
      id: `turn-${randomUUID().slice(0, 8)}`,
      seq: 0,
      role: 'agent',
      agentId: '__planner__',
      agentName: '🎯 总调度汇总',
      text: summary.finalConclusion,
      subtaskIds: subtasks.map((s) => s.id),
      at: Date.now(),
    }
    this.store.appendTurn(taskId, summaryTurn)
    this.emit(taskId, { type: 'turn_start', turn: summaryTurn })
    this.emit(taskId, { type: 'turn_end', turn: summaryTurn })
    this.store.save()
  }

  private hasCycle(subtasks: PlanSubtask[]): boolean {
    const indeg = new Map<string, number>()
    const adj = new Map<string, string[]>()
    for (const s of subtasks) {
      indeg.set(s.id, s.dependsOn.length)
      for (const d of s.dependsOn) {
        if (!adj.has(d)) adj.set(d, [])
        adj.get(d)!.push(s.id)
      }
    }
    const queue = subtasks.filter((s) => (indeg.get(s.id) || 0) === 0).map((s) => s.id)
    let visited = 0
    while (queue.length) {
      const id = queue.shift()!
      visited++
      for (const next of adj.get(id) || []) {
        const d = (indeg.get(next) || 0) - 1
        indeg.set(next, d)
        if (d === 0) queue.push(next)
      }
    }
    return visited !== subtasks.length
  }

  private async executeDag(
    taskId: string,
    mentions: ExtractedMentions,
    targets: Map<string, DshTarget>,
    signal: AbortSignal,
  ): Promise<void> {
    for (;;) {
      if (signal.aborted) return
      const task = this.store.getTask(taskId)
      const subs = task?.plan?.subtasks || []
      const pending = subs.filter((s) => s.status === 'pending')
      if (pending.length === 0) break
      const ready = pending.filter((s) => s.dependsOn.every((d) => subs.find((x) => x.id === d)?.status === 'completed'))
      if (ready.length === 0) {
        // 没有可运行的：上游失败/跳过导致 —— 级联跳过全部剩余 pending
        for (const s of pending) {
          this.store.mutateSubtask(taskId, s.id, (x) => {
            x.status = 'skipped'
            x.error = '上游子任务未成功，已跳过'
          })
          this.emit(taskId, { type: 'subtask_status', subtask: this.store.getTask(taskId)!.plan!.subtasks.find((x) => x.id === s.id)! })
        }
        break
      }
      await Promise.all(ready.map((sub) => this.launchSubtask(taskId, sub.id, mentions, targets, signal)))
    }
  }

  private async launchSubtask(
    taskId: string,
    subtaskId: string,
    mentions: ExtractedMentions,
    targets: Map<string, DshTarget>,
    signal: AbortSignal,
  ): Promise<void> {
    const task = this.store.getTask(taskId)
    const sub = task?.plan?.subtasks.find((s) => s.id === subtaskId)
    if (!task || !sub) return
    const agent = this.store.getAgent(sub.agentId)
    const target = targets.get(sub.agentId)
    if (!agent || !target) {
      this.store.mutateSubtask(taskId, subtaskId, (s) => {
        s.status = 'failed'
        s.error = !agent ? '子智能体不存在' : '节点解析失败'
        s.completedAt = Date.now()
      })
      this.emit(taskId, { type: 'subtask_status', subtask: this.store.getTask(taskId)!.plan!.subtasks.find((x) => x.id === subtaskId)! })
      return
    }

    // 上游产出摘要
    const upstream: string[] = []
    for (const depId of sub.dependsOn) {
      const dep = task.plan?.subtasks.find((s) => s.id === depId)
      if (dep?.result?.content) {
        upstream.push(`### 上游子任务《${dep.title}》产出摘要\n${dep.result.content.slice(0, 800)}`)
      }
    }
    await this.runSubtask(task, sub, agent, target, upstream, mentions.mentionedResourceBindings, signal, mentions)
  }

  /** 执行单个子任务（供 DAG 与单项重试共用） */
  private async runSubtask(
    task: WorkTask,
    sub: PlanSubtask,
    agent: SubAgent,
    target: DshTarget,
    upstream: string[],
    extraResources: AgentResourceBinding[],
    signal: AbortSignal,
    mentions?: ExtractedMentions,
  ): Promise<void> {
    const taskId = task.id
    const exec = this.taskExec(task)
    this.store.mutateSubtask(taskId, sub.id, (s) => {
      s.status = 'running'
      s.startedAt = Date.now()
    })
    this.emit(taskId, { type: 'subtask_status', subtask: this.store.getTask(taskId)!.plan!.subtasks.find((x) => x.id === sub.id)! })
    this.emit(taskId, { type: 'log', subtaskId: sub.id, level: 'info', msg: `开始在「${agent.name}」上执行: ${sub.title}` })

    const session = await this.ensureSession(taskId, agent, target, { cwd: exec.workspace, workspace: exec.workspace })
    if (session.target) target = session.target
    if (!session.ok) {
      this.store.mutateSubtask(taskId, sub.id, (s) => {
        s.status = 'failed'
        s.error = `创建远程会话失败: ${session.error}`
        s.completedAt = Date.now()
      })
      this.emit(taskId, { type: 'subtask_status', subtask: this.store.getTask(taskId)!.plan!.subtasks.find((x) => x.id === sub.id)! })
      return
    }
    const subLog = (msg: string, level: SubtaskLogEntry['level'] = 'info'): void => {
      this.store.mutateSubtask(taskId, sub.id, (s) => {
        s.logs.push({ ts: Date.now(), level, msg })
      })
      this.emit(taskId, { type: 'log', subtaskId: sub.id, level, msg })
    }
    subLog(`远程会话${session.reused ? '复用' : '新建'} ${session.remoteSessionId} @ ${target.baseUrl}`)

    const transformed = await this.transformFileMentionsForAgent(sub.prompt, mentions, agent, task)

    const parts: string[] = []
    const hasDynamicResources = (extraResources && extraResources.length > 0) || (mentions?.mentionedFiles && mentions.mentionedFiles.length > 0)
    const cachedBlock = hasDynamicResources ? null : this.blockCacheFresh(taskId, agent)

    if (!cachedBlock) {
      const composed = await this.composer.compose(agent, {
        resolvedAt: Date.now(),
        extraResources: [...exec.extraBindings, ...extraResources],
        extraSkills: exec.skills,
      })
      const block = composed.block
      if (!hasDynamicResources) this.blockCache.set(this.blockCacheKey(taskId, agent), { block, at: Date.now() })
      if (block) parts.push(block)
      for (const w of composed.warnings) this.emit(taskId, { type: 'log', subtaskId: sub.id, level: 'warn', msg: w })
    } else if (cachedBlock.block) {
      parts.push(cachedBlock.block)
    }
    if (transformed.extraSections.length > 0) {
      parts.push(transformed.extraSections.join('\n\n'))
    }
    for (const u of upstream) parts.push(u)
    parts.push(`[当前子任务指令]:\n${transformed.text}`)
    const fullPrompt = parts.join('\n\n')

    let deltaCount = 0
    const dispatchStartedAt = Date.now()
    let firstDeltaLogged = false
    const result = await this.dispatchWithFallback(
      target,
      session.remoteSessionId!,
      fullPrompt,
      {
        onDelta: (delta) => {
          if (!firstDeltaLogged) {
            firstDeltaLogged = true
            subLog(`收到首个增量（等待 ${((Date.now() - dispatchStartedAt) / 1000).toFixed(1)}s），开始流式接收`)
          }
          this.store.mutateSubtask(taskId, sub.id, (s) => {
            s.result = { content: (s.result?.content || '') + delta }
          })
          if (++deltaCount % 25 === 0) this.store.save() // 崩溃恢复粒度
        },
        onLog: (msg, level) => {
          subLog(msg, level || 'info')
        },
      },
      signal,
    )
    const viaText = result.via === 'sse' ? 'SSE 流式' : result.via === 'sync' ? '同步调用' : result.via === 'poll' ? '轮询' : '未知通道'

    this.store.mutateSubtask(taskId, sub.id, (s) => {
      if (result.ok && result.content && result.content.trim()) {
        s.status = 'completed'
        // 防覆盖：轮询整轮重建应比流式累积更完整；若流式版本反而更长（对账退化），保留更长的一份避免丢内容
        const prev = s.result?.content || ''
        s.result = {
          content: result.content.length >= prev.length ? result.content : prev,
          reasoning: result.reasoning || s.result?.reasoning,
        }
      } else if (!result.ok && result.content) {
        // 流式已产出部分内容但最终失败：保留部分产出并标记失败
        s.status = 'failed'
        s.result = { content: result.content }
        s.error = result.error
      } else {
        s.status = 'failed'
        s.error = result.error || (result.content ? '' : '远程节点返回空回答（Provider/Model 可能不可用）')
      }
      s.completedAt = Date.now()
    })
    this.emit(taskId, { type: 'subtask_status', subtask: this.store.getTask(taskId)!.plan!.subtasks.find((x) => x.id === sub.id)! })
    const final = this.store.getTask(taskId)!.plan!.subtasks.find((x) => x.id === sub.id)!
    const elapsed = ((Date.now() - dispatchStartedAt) / 1000).toFixed(1)
    this.emit(taskId, {
      type: 'log',
      subtaskId: sub.id,
      level: final.status === 'completed' ? 'info' : 'error',
      msg: final.status === 'completed'
        ? `子任务完成（${viaText}，用时 ${elapsed}s，${deltaCount} 个增量）：产出 ${final.result?.content?.length || 0} 字符`
        : `子任务失败: ${final.error}`,
    })
    if (final.status === 'completed') subLog(`完成（${viaText}，用时 ${elapsed}s，${deltaCount} 个增量），产出 ${final.result?.content?.length || 0} 字符`)
  }

  // ---------- 会话与派发基建 ----------

  private needsAutoTitle(task: WorkTask): boolean {
    const userTurns = (task.turns || []).filter((t) => t.role === 'user')
    if (userTurns.length !== 1) return false
    return task.title.startsWith('新任务') || task.title.startsWith('未命名任务') || task.title.length <= 6
  }

  /** 工作区列表缓存：baseUrl → { at, workspaces }，60s（避免每次建会话都打一发 /workspaces） */
  private wsCache = new Map<string, { at: number; workspaces: Array<{ id: string; path?: string }> }>()

  /**
   * 按智能体工作目录解析远端工作区 id：精确匹配 path，无匹配时在远端注册同路径工作区
   * （POST /workspaces 按 path 幂等）并使用之。注意 workspaceId 与 cwd 互斥（远端 harness 校验），
   * 因此工作区路径必须与 workDir 完全一致（cwd 由工作区隐含）。
   * 远端不支持 /workspaces（过旧）或未配置 workDir 时返回 undefined —— 退回仅传 cwd 的旧行为。
   */
  private async resolveWorkspaceId(target: DshTarget, wantedCwd: string): Promise<string | undefined> {
    const cached = this.wsCache.get(target.baseUrl)
    let workspaces: Array<{ id: string; path?: string }>
    if (cached && Date.now() - cached.at < 60_000) {
      workspaces = cached.workspaces
    } else {
      const r = await this.client.listWorkspaces(target).catch(() => ({ ok: false as const, workspaces: undefined }))
      workspaces = r.ok && r.workspaces ? r.workspaces : []
      this.wsCache.set(target.baseUrl, { at: Date.now(), workspaces })
    }
    const norm = (v: string) => v.replace(/\/+$/, '')
    const want = norm(wantedCwd)
    for (const ws of workspaces) {
      if (ws.path && norm(ws.path) === want) return ws.id
    }
    // 无匹配工作区 → 在远端注册（幂等），并同步进缓存，后续会话直接命中
    const created = await this.client.ensureWorkspace(target, wantedCwd, wantedCwd.split('/').filter(Boolean).pop() || undefined).catch(() => ({ ok: false as const, id: undefined }))
    if (created.ok && created.id) {
      if (this.wsCache.has(target.baseUrl)) this.wsCache.get(target.baseUrl)!.workspaces.push({ id: created.id, path: wantedCwd })
      return created.id
    }
    return undefined
  }

  /**
   * 主智能体切换后的会话预热对齐（WEB 端「切换主智能体」时调用，fire-and-forget）：
   * 为当前主智能体就地建/对齐远端会话 —— 工作区、工作目录、主调度模型全部随新主智能体走，
   * 用户下一条消息发出时已在正确的工作区里。
   */
  public async prepareMainSession(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId)
    if (!task || task.mode !== 'chat' || this.activeJobs.has(taskId)) return
    const main = this.planner.pickMainAgent()
    if (!main || !task.memberAgentIds.includes(main.id)) return
    const target = await this.resolver.resolve(main).catch(() => undefined)
    if (!target?.online) return
    await this.ensureSession(taskId, main, target).catch(() => {})
  }

  /**
   * 任务执行上下文：项目任务继承项目节点/工作区/指令/连接器/技能；
   * 单独任务可用 nodeRef/connectorIds/skillNames 覆盖；都没有则专家按遗留默认节点执行。
   */
  /**
   * 解析 sub agent 的执行目标节点：sub agent = 绑定在某台 DSH 上的远程执行单元，
   * @ 调用时回到「它自己绑定的节点」执行（workDir/资源/身份同源）；自身节点不可达时
   * 回退任务节点（项目节点/任务所选节点）。节点主会话（__node__）无智能体记录，
   * 只按任务节点解析。所有「建立会话 / 附件上传 / 中止会话 / 文件下载」路径都必须经由本方法。
   */
  public async resolveExecTarget(task: WorkTask | undefined, agentId: string): Promise<DshTarget & { online: boolean; error?: string } | undefined> {
    const agent = this.store.getAgent(agentId)
    if (!agent) return undefined
    const own = await this.resolver.resolve(agent).catch(() => undefined)
    if (own?.online && own.baseUrl) return own
    const exec = task ? this.taskExec(task) : undefined
    if (exec?.dshRef) {
      const nt = await this.resolver.resolveRef(exec.dshRef, exec.apiKey, agentId).catch(() => undefined)
      if (nt?.online && nt.baseUrl) return nt
    }
    return undefined
  }

  /** 主会话的「无身份」执行者：远端节点默认形态 + 项目指令，不注入任何 sub agent 提示词 */
  private makeNodeAgent(exec: { dshRef?: DshRef }): SubAgent {
    const ref = exec.dshRef
    let nodeTitle = ''
    if (ref?.kind === 'mapping') nodeTitle = this.directory.resolveMapping(ref.mappingId)?.tunnelName || ref.mappingId
    else if (ref?.kind === 'app') nodeTitle = this.directory.resolveApp(ref.appId)?.appName || ref.appId
    else if (ref?.kind === 'direct') nodeTitle = ref.apiBaseUrl
    const now = Date.now()
    return {
      id: NODE_AGENT_ID,
      name: nodeTitle ? `${nodeTitle} · 主会话` : '主会话',
      dshRef: ref || { kind: 'direct', apiBaseUrl: '' },
      resources: [],
      skills: [],
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }
  }

  private taskExec(task: WorkTask): {
    project?: Project
    dshRef?: DshRef
    apiKey?: string
    workspace?: string
    instruction?: string
    extraBindings: AgentResourceBinding[]
    sshConnectors: Array<{ id: string; name: string; host: string; port: number }>
    skills: string[]
  } {
    const project = task.projectId ? this.store.getProject(task.projectId) : undefined
    const dshRef = project?.dshRef || task.nodeRef || undefined
    const connectorIds = task.connectorIds?.length ? task.connectorIds : (project?.connectorIds || [])
    const extraBindings: AgentResourceBinding[] = []
    const sshConnectors: Array<{ id: string; name: string; host: string; port: number }> = []
    for (const cid of connectorIds) {
      if (cid.startsWith('ssh:')) {
        const r = this.sshStore?.get(cid.slice(4))
        if (r) sshConnectors.push({ id: r.id, name: r.name, host: r.host, port: r.port })
      } else if (cid.startsWith('map:')) {
        extraBindings.push({ ref: { kind: 'mapping', mappingId: cid.slice(4) }, credentialMode: 'self-fetch', skillMode: 'none' })
      } else if (cid.startsWith('app:')) {
        extraBindings.push({ ref: { kind: 'app', appId: cid.slice(4) }, credentialMode: 'self-fetch', skillMode: 'none' })
      }
    }
    return {
      project,
      dshRef,
      apiKey: project?.apiKey,
      workspace: project?.workspace,
      instruction: project?.instruction,
      extraBindings,
      sshConnectors,
      skills: task.skillNames?.length ? task.skillNames : (project?.skillNames || []),
    }
  }

    private async ensureSession(taskId: string, agent: SubAgent, target: DshTarget, opts?: { cwd?: string; workspace?: string }): Promise<{ ok: boolean; remoteSessionId?: string; reused?: boolean; error?: string; target?: DshTarget }> {
    const task = this.store.getTask(taskId)!
    const exec = this.taskExec(task)
    // 任务/项目工作区只在「执行节点 = 任务节点」时适用（目录属于那台机器）；
    // sub agent 回自身节点执行时，其 workDir 才是有效目录
    const rawCwd = opts?.workspace ?? opts?.cwd ?? exec.workspace
    const execWorkspaceFits = !rawCwd || !(exec.dshRef && exec.dshRef.kind === 'mapping') || (target as any).mappingId === exec.dshRef.mappingId
    const sameNode = (target as any).mappingId
      ? (agent.dshRef.kind === 'mapping' && (target as any).mappingId === agent.dshRef.mappingId)
      : agent.dshRef.kind === 'direct'
    const wantedCwd = (execWorkspaceFits ? rawCwd : undefined) ?? (sameNode ? agent.workDir : undefined) ?? undefined
    const existing = task.sessions[agent.id]
    // 调度模型（模型按钮）只对节点主会话生效；@ 的 sub agent 用自身配置的 model/provider，
    // 不被 planner.model 覆盖（否则 planner 恰好指向它时会用坏上游覆盖好配置——07:17 空回合根因）
    const isMain = agent.id === NODE_AGENT_ID
    const settings = this.store.getSettings()
    const plannerModelSetting = String(settings.planner?.model || '').trim() || undefined

    if (existing?.remoteSessionId && isMain && (existing.plannerModel || undefined) !== plannerModelSetting) {
      // 主智能体的已绑定会话与「模型列表当前选中」不一致（切换过主智能体或模型）→ 就地对齐
      const slash = plannerModelSetting ? plannerModelSetting.indexOf('/') : -1
      const provider = plannerModelSetting && slash >= 0 ? plannerModelSetting.slice(0, slash).trim() || undefined : undefined
      const modelId = plannerModelSetting && slash >= 0 ? plannerModelSetting.slice(slash + 1).trim() || undefined : plannerModelSetting
      const aligned = await this.client.updateSessionModel(target, existing.remoteSessionId, { provider, model: modelId })
      if (aligned.ok) {
        this.store.mutateTask(taskId, (t) => {
          const b = t.sessions[agent.id]
          if (b) b.plannerModel = plannerModelSetting
        })
        this.taskLog(taskId, 'info', `主智能体会话模型已对齐（${agent.name}）: ${plannerModelSetting || '默认模型'}`)
      } else {
        this.taskLog(taskId, 'warn', `主智能体会话模型对齐失败（${agent.name}）: ${aligned.error}`)
      }
    }

    if (existing?.remoteSessionId) {
      // 执行节点变更（用户切换任务节点）→ 旧节点上的会话作废，重建
      const nodeChanged = !!existing.baseUrl && existing.baseUrl.replace(/\/+$/, '') !== target.baseUrl.replace(/\/+$/, '')
      if (nodeChanged) {
        this.taskLog(taskId, 'info', `执行节点变更（${agent.name}）: ${existing.baseUrl} → ${target.baseUrl}，重建远端会话`)
      } else if ((existing.cwd || undefined) !== wantedCwd) {
        // 工作目录已变更 → 旧会话作废，重建
        this.taskLog(taskId, 'info', `工作目录变更（${agent.name}）: ${existing.cwd || '(默认)'} → ${wantedCwd || '(默认)'}，重建远端会话`)
      } else {
        const st = await this.client.getSession(target, existing.remoteSessionId)
        if (st.ok) return { ok: true, remoteSessionId: existing.remoteSessionId, reused: true, target }
        // 远端会话已丢失（重启/清理），重建
        this.taskLog(taskId, 'warn', `远端会话丢失（${agent.name}），正在重建: ${existing.remoteSessionId}`)
      }
    }

    // 若为主智能体且配置了主调度模型，优先采用该模型作为远端会话创建参数
    let targetProvider = agent.provider
    let targetModel = agent.model
    if (isMain && plannerModelSetting) {
      const pm = plannerModelSetting
      const slash = pm.indexOf('/')
      if (slash >= 0) {
        targetProvider = pm.slice(0, slash).trim() || undefined
        targetModel = pm.slice(slash + 1).trim() || undefined
      } else {
        targetModel = pm
      }
    }

    // 工作区对齐：workspaceId 与 cwd 互斥（远端 harness 校验「accepts workspaceId or cwd, not both」）。
    // 解析出工作区时只传 workspaceId（工作区路径即工作目录）；远端无工作区体系时退回传 cwd。
    const workspaceId = wantedCwd ? await this.resolveWorkspaceId(target, wantedCwd).catch(() => undefined) : undefined
    const createPayload = {
      agentPreset: agent.agentPreset,
      provider: targetProvider,
      model: targetModel,
      ...(workspaceId ? { workspaceId } : wantedCwd ? { cwd: wantedCwd } : {}),
    }
    let effTarget = target
    let res = await this.client.createSession(effTarget, `[WorkBuddy] ${task.title}`, createPayload)
    // 401/403 自愈：映射节点的凭证可能解析失败（ONENAT 抖动被静默吞掉）或已轮换 →
    // 强制刷新该映射的实例凭证后重试一次，避免一次凭证抖动导致整轮「创建会话失败」
    if (!res.ok && res.error && /401|403|unauthorized/i.test(res.error) && (effTarget as any).mappingId) {
      const cred = await this.directory.fetchMappingCredentials((effTarget as any).mappingId, true).catch(() => undefined)
      const refreshedKey = cred?.ok ? (cred.apiKey || cred.token || undefined) : undefined
      if (refreshedKey) {
        this.taskLog(taskId, 'info', `节点凭证鉴权失败（${(effTarget as any).mappingId}），已强制刷新凭证重试`)
        effTarget = { ...effTarget, apiKey: refreshedKey }
        res = await this.client.createSession(effTarget, `[WorkBuddy] ${task.title}`, createPayload)
      }
    }
    // 自愈 2：工作目录在目标节点不存在（ENOENT mkdir，如项目 workspace/agent workDir 属于另一台机器）
    // → 去掉目录约束回退远端默认目录重建会话，并在任务日志注明
    let cwdFellBack = false
    if (!res.ok && res.error && /ensure project directory|ENOENT/i.test(res.error) && (workspaceId || wantedCwd)) {
      this.taskLog(taskId, 'warn', `工作目录 ${wantedCwd || '(workspace)'} 在目标节点不可用（目录不存在且无法创建），已回退远端默认目录重建会话`)
      cwdFellBack = true
      const fallbackPayload = { agentPreset: agent.agentPreset, provider: targetProvider, model: targetModel }
      res = await this.client.createSession(effTarget, `[WorkBuddy] ${task.title}`, fallbackPayload)
    }
    // 自愈 3：瞬时失败退避重试（ONENAT 隧道抖动/串端口——无 /root 的机器瞬移、远端重启窗口、5xx）
    if (!res.ok && res.error && /ENOENT|ECONN|EPIPE|EHOST|fetch failed|terminated|HTTP 5\d\d|timed? ?out/i.test(res.error)) {
      this.taskLog(taskId, 'info', `创建会话瞬时失败（${res.error.slice(0, 80)}），1.5s 后自动重试一次`)
      await new Promise((r) => setTimeout(r, 1500))
      res = await this.client.createSession(effTarget, `[WorkBuddy] ${task.title}`, createPayload)
      // 若瞬时失败源于目录（重试带目录又 ENOENT），再走一次目录回退
      if (!res.ok && res.error && /ensure project directory|ENOENT/i.test(res.error) && (workspaceId || wantedCwd) && !cwdFellBack) {
        cwdFellBack = true
        const fallbackPayload = { agentPreset: agent.agentPreset, provider: targetProvider, model: targetModel }
        res = await this.client.createSession(effTarget, `[WorkBuddy] ${task.title}`, fallbackPayload)
      }
    }
    if (workspaceId) {
      this.taskLog(taskId, 'info', `会话已对齐工作区（${agent.name}）: workspace=${workspaceId} · 目录 ${wantedCwd}`)
    }
    if (!res.ok || !res.sessionId) {
      const hint = /401|403|unauthorized/i.test(res.error || '') ? '（节点鉴权失败：请检查 ONENAT 上映射的实例凭证配置）' : ''
      return { ok: false, error: (res.error || '未知') + hint }
    }
    target = effTarget
    this.store.mutateTask(taskId, (t) => {
      t.sessions[agent.id] = { remoteSessionId: res.sessionId!, baseUrl: target.baseUrl, cwd: cwdFellBack ? undefined : (wantedCwd || undefined), plannerModel: isMain ? (plannerModelSetting || '') : undefined, createdAt: Date.now() }
    })
    this.taskLog(taskId, 'info', `远程会话已创建（${agent.name}${targetModel ? ' · 模型 ' + targetModel : ''}${wantedCwd ? ' · 工作目录 ' + wantedCwd : ''}）: ${res.sessionId} @ ${target.baseUrl}`)
    // 校验远端 cwd 生效
    if (wantedCwd) {
      const info = await this.client.getSessionInfo(target, res.sessionId)
      if (!info.ok || !info.cwd) {
        this.taskLog(taskId, 'warn', `远端会话工作目录校验失败（${agent.name}）: 期望 ${wantedCwd}，实际 ${info.cwd || '(未返回)'} — 远端 dsh-web-service 可能过旧`)
      } else if (info.cwd.replace(/\/+$/, '') !== wantedCwd.replace(/\/+$/, '')) {
        this.taskLog(taskId, 'warn', `远端会话 cwd 与配置不一致（${agent.name}）: 期望 ${wantedCwd}，实际 ${info.cwd}`)
      }
    }
    return { ok: true, remoteSessionId: res.sessionId, reused: false, target: effTarget }
  }

  /** SSE 流式优先；不支持降级同步；同步超时转轮询（D5） */
  private async dispatchWithFallback(
    target: DshTarget,
    sessionId: string,
    prompt: string,
    handlers: Parameters<DshClient['streamPrompt']>[3],
    signal: AbortSignal,
  ): Promise<PromptResult> {
    const sse = await this.client.streamPrompt(target, sessionId, prompt, handlers, { signal })
    // 完整收到 turn_end 且有文本：流式结果即整轮内容，直接采用
    if (sse.ok && sse.complete !== false && sse.content) return sse
    // 流完整结束但零文本：远端只发了 usage/turn_end（部分 provider 不推 assistant/chunk text-delta，
    // dsh-web-service 也不把 assistant/message 正文放进流）⇒ 回查 history 对账整轮文本
    if (sse.ok && sse.complete !== false && !sse.content) {
      handlers.onLog?.('流式通道无文本增量（远端未推 delta），改用会话历史对账整轮结果...', 'warn')
      const reconciled = await this.client.reconcileTurn(target, sessionId, turnFragment(prompt), { signal })
      return reconciled.ok ? reconciled : sse
    }
    if (sse.sseUnsupported) {
      handlers.onLog?.('远端不支持 SSE 流式，降级同步等待...', 'warn')
      const sync = await this.client.prompt(target, sessionId, prompt, { signal })
      if (sync.ok) return sync
      if (sync.timedOut) {
        const polled = await this.client.waitForSessionResult(target, sessionId, {
          signal,
          onLog: handlers.onLog,
          promptFragment: turnFragment(prompt),
        })
        return polled
      }
      return sync
    }
    // SSE 断损兜底（D5）：断流时已产出部分内容、或流被提前收掉未收到 turn_end、
    // 或提交后流异常终结 —— 远端回合多半仍在继续，轮询对账拿回完整整轮结果。
    // 网络层错误（fetch failed / 连接被重置 / 静默看门狗断开等）同样兜底：远端回合往往还在跑，
    // 只对齐 /SSE 流/ 前缀会漏掉「零内容 + 网络错误」的形态，导致回复彻底不同步到 UI。
    const networkLike = /fetch failed|terminated|TimeoutError|aborted|socket|ECONN|EPIPE|EHOST|upstream|静默超时|网络/i
    if (!signal.aborted && (sse.content || sse.complete === false || /SSE 流|静默超时/.test(sse.error || '') || networkLike.test(sse.error || ''))) {
      handlers.onLog?.('SSE 流中断/提前结束，转轮询对账整轮结果...', 'warn')
      const polled = await this.client.waitForSessionResult(target, sessionId, {
        signal,
        onLog: handlers.onLog,
        promptFragment: turnFragment(prompt),
      })
      if (polled.ok && polled.content && polled.content.length > (sse.content?.length || 0)) return polled
      return sse
    }
    if (signal.aborted) return { ok: false, error: '已中止' }
    return sse
  }

  // ---------- 附件上传与文件下载 ----------

  /**
   * 附件上传的实际目标集合（与「本轮对话实际路由到的智能体」同源）：
   *
   * 1. 单成员任务 → 该成员；
   * 2. 最近一轮是单目标路由（@一个子智能体 / 直通对话）→ 只给这一个，绝不扇出到本轮没参与的成员；
   * 3. 编排路由且本轮计划已落盘 → 计划里真正参与执行的成员（这是唯一可能多目标的情况，且成员来自真实计划）；
   * 4. 其余（新任务尚未发言 / 无路由记录 / 编排路由但计划缺失）→ 主智能体（defaultMemberAgentIds）。
   *
   * 第 4 条取代了历史实现里「按 task.memberAgentIds 全员扇出」的兜底：
   * 老任务（无 @ 新建时被错误填成全部子智能体）在任何缺少明确路由证据的情况下都只投主智能体，
   * 否则同一个文件会往每个成员节点各建一个远端会话、各写一份。
   * 需要跨节点使用该文件时，消息里的 @文件 引用会按 transformFileMentionsForAgent 生成下载 URL。
   */
  public attachmentTargetAgentIds(task: WorkTask): string[] {
    const members = (task.memberAgentIds || []).filter((id) => Boolean(id))
    if (!members.length) {
      // 新模型：任务只有节点主会话（无成员）→ 附件投到主会话所在节点
      if (task.sessions?.[NODE_AGENT_ID]?.remoteSessionId) return [NODE_AGENT_ID]
      return this.defaultMemberAgentIds()
    }
    if (members.length === 1) return members
    const route = task.lastRoute
    if (route && (route.kind === 'direct' || route.kind === 'chat') && route.agentId && members.includes(route.agentId)) {
      return [route.agentId]
    }
    const planned = [...new Set(
      (task.plan?.subtasks || [])
        .map((s) => s.agentId)
        .filter((id) => Boolean(id) && members.includes(id)),
    )]
    if (route?.kind === 'orchestrate' && planned.length) return planned
    // 没有明确路由证据 → 只投主智能体（主智能体不是成员时退化为第一个成员），绝不整组扇出
    const main = this.defaultMemberAgentIds()
    if (main.length && members.includes(main[0])) return main
    return [members[0]]
  }

  /**
   * 上传附件到「本次实际目标智能体」的远端会话工作区（attachmentTargetAgentIds）。
   * 缺会话的成员会先建会话（ensureSession）；某成员失败不影响其他成员。
   */
  public async uploadAttachments(
    taskId: string,
    files: Array<{ filename: string; data: Buffer; mimeType?: string }>,
  ): Promise<{
    ok: boolean
    error?: string
    results?: Array<{ agentId: string; agentName: string; ok: boolean; error?: string; files?: Array<{ name: string; path: string; size: number }> }>
  }> {
    const task = this.store.getTask(taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    if (!files.length) return { ok: false, error: '没有文件' }
    const targetIds = this.attachmentTargetAgentIds(task)
    const { targets } = await this.resolver.resolveMembers(targetIds)
    // 成员并行分发（串行时多成员 × 隧道延迟叠加，客户端 100% 后长时间无响应）
    const results: Array<{ agentId: string; agentName: string; ok: boolean; error?: string; files?: Array<{ name: string; path: string; size: number }> }> = await Promise.all(
      targetIds.map(async (agentId) => {
        const agent = this.store.getAgent(agentId)
        // 项目任务：附件必须传到会话所在的项目节点（与 ensureSession 同源）
        let target: DshTarget | undefined = (await this.resolveExecTarget(task, agentId)) || targets.get(agentId)
        if (!agent || !target) return { agentId, agentName: agent?.name || agentId, ok: false, error: '节点不可用' }
        const session = await this.ensureSession(taskId, agent, target)
        if (!session.ok || !session.remoteSessionId) {
          return { agentId, agentName: agent.name, ok: false, error: session.error || '会话创建失败' }
        }
        if (session.target) target = session.target
        const up = await this.client.uploadFiles(target, session.remoteSessionId, files)
        if (!up.ok) {
          this.taskLog(taskId, 'error', `附件上传失败（${agent.name}）: ${up.error}`)
          return { agentId, agentName: agent.name, ok: false, error: up.error }
        }
        const saved = up.files || []
        this.taskLog(taskId, 'info', `附件已上传（${agent.name}）: ${saved.map((f) => f.path).join(', ')}`)
        this.store.mutateTask(taskId, (t) => {
          t.attachments = t.attachments || []
          for (const f of saved) {
            t.attachments.push({
              name: f.name,
              path: f.path,
              size: f.size,
              mimeType: f.mimeType,
              agentId,
              agentName: agent.name,
              remoteSessionId: session.remoteSessionId!,
              uploadedAt: Date.now(),
            })
          }
        })
        return { agentId, agentName: agent.name, ok: true, files: saved.map((f) => ({ name: f.name, path: f.path, size: f.size })) }
      }),
    )
    return { ok: true, results }
  }

  // ---------- 分片断点续传上传（浏览器 → 本服务暂存 → complete 时分片中继到成员节点） ----------

  private uploadStagePaths(uploadId: string): { dir: string; part: string; meta: string } | undefined {
    const id = String(uploadId || '').replace(/[^A-Za-z0-9._-]/g, '')
    if (!id || id.length > 120) return undefined
    const dir = join(this.store.dataDir, 'uploads')
    return { dir, part: join(dir, id + '.part'), meta: join(dir, id + '.json') }
  }

  private async stageReceived(part: string): Promise<number> {
    try {
      return (await stat(part)).size
    } catch {
      return 0
    }
  }

  /** 初始化分片上传（顺手清理 24h 前的残留暂存） */
  public async resumableInit(
    taskId: string,
    name: string,
    size: number,
    mimeType?: string,
  ): Promise<{ ok: boolean; uploadId?: string; received?: number; error?: string }> {
    if (!this.store.getTask(taskId)) return { ok: false, error: '任务不存在' }
    const safeName = String(name || '').split(/[\\/]/).pop() || `upload-${Date.now()}`
    const safeSize = Math.max(0, Math.floor(Number(size) || 0))
    if (safeSize > 2 * 1024 * 1024 * 1024) return { ok: false, error: '文件超过 2GB 上限' }
    const uploadId = `up-${randomUUID().replace(/-/g, '').slice(0, 20)}`
    const paths = this.uploadStagePaths(uploadId)!
    try {
      await mkdir(paths.dir, { recursive: true })
      // 残留清理（best-effort）
      try {
        const old = await readdir(paths.dir)
        for (const f of old) {
          const fp = join(paths.dir, f)
          try {
            if (Date.now() - (await stat(fp)).mtimeMs > 24 * 3600_000) await rm(fp, { force: true })
          } catch { /* 单文件失败忽略 */ }
        }
      } catch { /* 目录不存在等 */ }
      await writeFile(paths.part, Buffer.alloc(0))
      await writeFile(paths.meta, JSON.stringify({ taskId, name: safeName, size: safeSize, mimeType: mimeType || undefined, createdAt: Date.now() }))
      return { ok: true, uploadId, received: 0 }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  }

  /** 查询接收进度（断点恢复点；received 以 .part 实际字节数为权威） */
  public async resumableStatus(
    taskId: string,
    uploadId: string,
  ): Promise<{ ok: boolean; name?: string; size?: number; received?: number; error?: string }> {
    const paths = this.uploadStagePaths(uploadId)
    if (!paths) return { ok: false, error: '非法 uploadId' }
    try {
      const meta = JSON.parse(await readFile(paths.meta, 'utf-8'))
      if (meta.taskId !== taskId) return { ok: false, error: '上传会话不属于该任务' }
      return { ok: true, name: meta.name, size: meta.size, received: await this.stageReceived(paths.part) }
    } catch {
      return { ok: false, error: '上传会话不存在或已完成/清理' }
    }
  }

  /** 追加分片（offset 不匹配时返回 OFFSET_MISMATCH + 服务端实际接收量） */
  public async resumableAppend(
    taskId: string,
    uploadId: string,
    chunk: Buffer,
    offset: number,
  ): Promise<{ ok: boolean; received?: number; code?: string; error?: string }> {
    const paths = this.uploadStagePaths(uploadId)
    if (!paths) return { ok: false, error: '非法 uploadId' }
    if (chunk.length === 0) return { ok: false, error: '分片内容为空' }
    const st = await this.resumableStatus(taskId, uploadId)
    if (!st.ok) return { ok: false, error: st.error }
    const received = st.received || 0
    if (offset !== received) return { ok: false, code: 'OFFSET_MISMATCH', received, error: `offset 不匹配：服务端已接收 ${received} 字节` }
    try {
      await appendFile(paths.part, chunk)
      return { ok: true, received: received + chunk.length }
    } catch (err: any) {
      return { ok: false, error: err?.message || String(err) }
    }
  }

  /** 完成并向本次实际目标节点（attachmentTargetAgentIds）分片中继（并行；单个失败保留暂存可重试） */
  public async resumableComplete(taskId: string, uploadId: string): Promise<{
    ok: boolean
    error?: string
    results?: Array<{ agentId: string; agentName: string; ok: boolean; error?: string; files?: Array<{ name: string; path: string; size: number }> }>
  }> {
    const paths = this.uploadStagePaths(uploadId)
    if (!paths) return { ok: false, error: '非法 uploadId' }
    const st = await this.resumableStatus(taskId, uploadId)
    if (!st.ok) return { ok: false, error: st.error }
    const size = st.size || 0
    const received = st.received || 0
    if (size > 0 && received !== size) return { ok: false, error: `文件未传完：已接收 ${received}/${size} 字节` }
    const task = this.store.getTask(taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    const meta = JSON.parse(await readFile(paths.meta, 'utf-8'))
    const handle = await import('node:fs/promises').then((m) => m.open(paths.part, 'r'))
    try {
      const readSlice = async (offset: number, length: number) => {
        const buf = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buf, 0, length, offset)
        return bytesRead === length ? buf : buf.subarray(0, bytesRead)
      }
      const targetIds = this.attachmentTargetAgentIds(task)
      const { targets } = await this.resolver.resolveMembers(targetIds)
      const results = await Promise.all(
        targetIds.map(async (agentId) => {
          const agent = this.store.getAgent(agentId)
          let target: DshTarget | undefined = targets.get(agentId)
          if (!agent || !target) return { agentId, agentName: agent?.name || agentId, ok: false, error: '节点不可用' }
          const session = await this.ensureSession(taskId, agent, target)
          if (!session.ok || !session.remoteSessionId) {
            return { agentId, agentName: agent.name, ok: false, error: session.error || '会话创建失败' }
          }
          if (session.target) target = session.target
          const up = await this.client.uploadFileResumable(
            target,
            session.remoteSessionId,
            { filename: meta.name, mimeType: meta.mimeType, size: received },
            readSlice,
            { chunkSize: 4 * 1024 * 1024 },
          ).catch((e: any) => ({ ok: false as const, error: e?.message || String(e) }))
          // 旧版节点无 resumable 端点 → 降级走原 multipart（≤100MB，与旧接口上限一致）
          let result = up
          if (!up.ok && /Endpoint not found|HTTP 404|404/.test(up.error || '')) {
            if (received <= 100 * 1024 * 1024) {
              const data = await readSlice(0, received)
              result = await this.client.uploadFiles(target, session.remoteSessionId, [{ filename: meta.name, mimeType: meta.mimeType, data }])
            }
          }
          if (!result.ok) {
            this.taskLog(taskId, 'error', `附件分片中继失败（${agent.name}）: ${result.error}`)
            return { agentId, agentName: agent.name, ok: false, error: result.error }
          }
          const saved = result.files || []
          this.taskLog(taskId, 'info', `附件已上传（${agent.name}）: ${saved.map((f) => f.path).join(', ')}`)
          this.store.mutateTask(taskId, (t) => {
            t.attachments = t.attachments || []
            for (const f of saved) {
              t.attachments.push({
                name: f.name,
                path: f.path,
                size: f.size,
                mimeType: f.mimeType,
                agentId,
                agentName: agent.name,
                remoteSessionId: session.remoteSessionId!,
                uploadedAt: Date.now(),
              })
            }
          })
          return { agentId, agentName: agent.name, ok: true, files: saved.map((f) => ({ name: f.name, path: f.path, size: f.size })) }
        }),
      )
      // 全部成员成功才清理暂存；部分失败保留（24h 后由 resumableInit 兜底清理，可重试 complete）
      if (results.every((r) => r.ok)) {
        await rm(paths.part, { force: true })
        await rm(paths.meta, { force: true })
      }
      return { ok: true, results }
    } finally {
      await handle.close().catch(() => {})
    }
  }

  /** 解析下载请求 → 远端流。返回 Response 供 router 转发。 */
  public async prepareFileDownload(
    taskId: string,
    agentId: string | undefined,
    filePath: string,
  ): Promise<{ ok: boolean; res?: any; name?: string; agentName?: string; error?: string }> {
    const task = this.store.getTask(taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    if (!filePath || !filePath.trim()) return { ok: false, error: '缺少 path 参数' }
    let aid = agentId?.trim()
    if (!aid) {
      const bound = Object.keys(task.sessions || {})
      aid = task.memberAgentIds.find((m) => bound.includes(m)) || task.memberAgentIds[0]
    }
    if (!aid) return { ok: false, error: '任务没有成员' }
    const agent = this.store.getAgent(aid)
    if (!agent) return { ok: false, error: `成员不存在: ${aid}` }
    const binding = task.sessions?.[aid]
    if (!binding?.remoteSessionId) return { ok: false, error: `成员「${agent.name}」尚无远端会话（先发送一条消息以建立会话）` }
    const target = await this.resolveExecTarget(task, aid)
    if (!target) return { ok: false, error: '节点不可用' }

    // 绝对路径 → 工作区相对路径（远端 safeJoin 以 cwd 为根解析）
    let rel = filePath.trim().replace(/\\/g, '/')
    const info = await this.client.getSessionInfo(target, binding.remoteSessionId)
    const cwd = info.ok ? info.cwd?.replace(/\/+$/, '') : undefined
    if (cwd && rel.startsWith(cwd)) {
      rel = rel.slice(cwd.length).replace(/^\//, '')
    } else {
      rel = rel.replace(/^\//, '')
    }

    const dl = await this.client.downloadFile(target, binding.remoteSessionId, rel)
    if (!dl.ok) return { ok: false, error: dl.error || '下载失败', agentName: agent.name }
    return { ok: true, res: dl.res, name: dl.name, agentName: agent.name }
  }
}
