/**
 * @dsh-external/onenat-workbuddy - 任务引擎（多轮聊天 + 编排调度 + SSE 事件枢纽）
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
import type { SubtaskLogEntry } from './types.js'
import type { AgentResourceBinding, ExtractedMentions, PlanSubtask, SubAgent, TaskEvent, TaskTurn, TurnToolCall, WorkTask } from './types.js'

export interface CreateTaskInput {
  title?: string
  memberAgentIds: string[]
  mode?: 'chat' | 'orchestrate'
  message?: string
}

/** 取 prompt 尾部片段：降级轮询时供远端 history 定位本次回合的起点 user 消息（注入消息不含用户文本，天然排除） */
function turnFragment(prompt: string): string {
  return prompt.length > 400 ? prompt.slice(-400) : prompt
}

export class TaskEngine {
  private client = new DshClient()
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
  ) {}

  /** 从用户消息中提取 @子智能体 与 @资源（支持包含空格名称的最长前缀匹配与同名多实体解析） */
  public extractMentions(text: string): ExtractedMentions {
    const mentionedAgentIds: string[] = []
    const mentionedResourceBindings: AgentResourceBinding[] = []
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
        const rest = text.slice(i + 1)
        let matched = false

        // 优先在词典中查找最长前缀匹配（支持名称中含有空格、短横线、中文等）
        for (const entry of dict) {
          if (rest.startsWith(entry.name)) {
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
          const fallbackMatch = /^([^\s@,，。!！?？:：;；]+)/.exec(rest)
          if (fallbackMatch) {
            const rawTag = fallbackMatch[1].trim()
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

  private emit(taskId: string, event: TaskEvent): void {
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

  public async createTask(input: CreateTaskInput): Promise<WorkTask> {
    if (!input.memberAgentIds?.length) throw new Error('至少指定一个子智能体成员')
    const mode: WorkTask['mode'] = input.mode || (input.memberAgentIds.length > 1 ? 'orchestrate' : 'chat')
    const task: WorkTask = {
      id: `task-${randomUUID().slice(0, 8)}`,
      title: input.title?.trim() || (input.message ? input.message.slice(0, 30) : '新任务'),
      mode,
      status: 'draft',
      memberAgentIds: [...input.memberAgentIds],
      turns: [],
      sessions: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    this.store.upsertTask(task)
    if (input.message?.trim()) {
      await this.sendUserMessage(task.id, input.message.trim())
    }
    return this.store.getTask(task.id)!
  }

  public updateMembers(taskId: string, memberAgentIds: string[]): WorkTask | undefined {
    return this.store.mutateTask(taskId, (task) => {
      if (this.activeJobs.has(taskId)) throw new Error('任务执行中，暂不能变更成员')
      task.memberAgentIds = [...memberAgentIds]
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
            const target = await this.resolver.resolve(agent).catch(() => undefined)
            if (target?.online) await this.client.cancelSession(target, binding.remoteSessionId).catch(() => {})
          }
          this.emit(taskId, { type: 'subtask_status', subtask: this.store.getTask(taskId)?.plan?.subtasks.find((s) => s.id === sub.id)! })
        }
      }
      // chat 直通会话同样向远端发送中断（仅断本地 SSE 远端会继续跑完）
      const taskAll = this.store.getTask(taskId)
      for (const aid of Object.keys(taskAll?.sessions || {})) {
        const binding = taskAll!.sessions[aid]
        const ag = this.store.getAgent(aid)
        if (!binding || !ag) continue
        const tg = await this.resolver.resolve(ag).catch(() => undefined)
        if (tg?.online) await this.client.cancelSession(tg, binding.remoteSessionId).catch(() => {})
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
      const { targets } = await this.resolver.resolveMembers([sub.agentId])
      const target = targets.get(sub.agentId)
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

    // 若是第一轮用户消息且任务还是默认标题，异步自动提炼生成更精准的会话标题
    if (task.turns.filter((t) => t.role === 'user').length === 1 && (task.title.startsWith('新任务') || task.title.startsWith('未命名任务') || task.title.length <= 6)) {
      void this.planner.generateTitle(text.trim()).then((autoTitle) => {
        if (autoTitle && autoTitle !== task.title) {
          this.store.mutateTask(taskId, (t) => {
            t.title = autoTitle
          })
          this.emit(taskId, { type: 'task_status', status: this.store.getTask(taskId)?.status || 'running' })
        }
      }).catch(() => {})
    }

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
    // 3. 只有当任务本身是 orchestrate 模式且有多成员、并且用户没有被强制走主智能体时才走编排。

    const hasExplicitAgentMention = mentions.mentionedAgentIds.length > 0
    // 本轮是否明确 @ 了“恰好一个”智能体 —— 用户只想把这件事交给那一个智能体，
    // 不应被任务已有的多成员/编排模式放大成跨多智能体流水线
    const singleExplicitMention = mentions.mentionedAgentIds.length === 1

    if (!hasExplicitAgentMention && task.mode === 'orchestrate') {
      // 未指定智能体时，优先由主智能体进行分析应答
      const plannerTarget = await this.planner.pickTarget()
      if (!('error' in plannerTarget) && plannerTarget.agent) {
        const pAgent = plannerTarget.agent
        const targetsMap = new Map<string, DshTarget>([[pAgent.id, plannerTarget.target]])
        await this.runChatTurn(taskId, text, mentions, targetsMap, signal, pAgent.id)
        const fresh = this.store.getTask(taskId)!
        this.emit(taskId, { type: 'task_end', task: fresh })
        return
      }
    }

    const { targets, issues } = await this.resolver.resolveMembers(task.memberAgentIds)
    for (const issue of issues) {
      this.taskLog(taskId, 'warn', `成员「${issue.name}」不可用: ${issue.error}`)
    }

    // @ 了恰好一个智能体：定向直通该智能体（即使任务本身是多成员编排任务）
    if (singleExplicitMention && hasExplicitAgentMention) {
      const onlyId = mentions.mentionedAgentIds[0]
      const onlyAgent = this.store.getAgent(onlyId)
      // 记录本轮路由：单人 @ → 定向直通
      this.store.mutateTask(taskId, (t) => {
        t.lastRoute = { kind: 'direct', agentId: onlyId, agentName: onlyAgent?.name || onlyId }
      })
      // 只解析被 @ 的那一个智能体
      const single = await this.resolver.resolveMembers([onlyId])
      const singleTarget = single.targets.get(onlyId)
      if (singleTarget) {
        await this.runChatTurn(taskId, text, mentions, new Map([[onlyId, singleTarget]]), signal)
      } else {
        const err = single.issues.find((x) => x.agentId === onlyId)?.error || '该智能体不可用'
        this.appendSystemTurn(taskId, `⚠️ 被 @ 的智能体「${this.store.getAgent(onlyId)?.name || onlyId}」暂不可用: ${err}`)
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

  // ---------- chat 直通 ----------

  private async runChatTurn(
    taskId: string,
    text: string,
    mentions: ExtractedMentions,
    targets: Map<string, DshTarget>,
    signal: AbortSignal,
    overrideAgentId?: string,
  ): Promise<void> {
    const task = this.store.getTask(taskId)!
    // 若显式 @ 了某个可用智能体，优先使用被 @ 的智能体；或使用指定的 overrideAgentId
    const preferredId = overrideAgentId || mentions.mentionedAgentIds.find((id) => targets.has(id))
    const agentId = preferredId || task.memberAgentIds.find((id) => targets.has(id)) || [...targets.keys()][0]
    const agent = this.store.getAgent(agentId)!
    const target = targets.get(agentId)!

    const session = await this.ensureSession(taskId, agent, target)
    if (!session.ok) {
      this.appendSystemTurn(taskId, `⚠️ 创建远程会话失败（${agent.name}）: ${session.error}`)
      this.store.mutateTask(taskId, (t) => {
        t.status = 'failed'
      })
      this.emit(taskId, { type: 'task_status', status: 'failed' })
      return
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

    let fullPrompt = text
    const hasDynamicResources = mentions.mentionedResourceBindings.length > 0
    const cachedBlock = hasDynamicResources ? null : this.blockCacheFresh(taskId, agent)

    if (!cachedBlock) {
      const composed = await this.composer.compose(agent, {
        resolvedAt: Date.now(),
        extraResources: mentions.mentionedResourceBindings,
      })
      const block = composed.block
      if (block) {
        if (!hasDynamicResources) this.blockCache.set(this.blockCacheKey(taskId, agent), { block, at: Date.now() })
        fullPrompt = `${block}\n\n[当前用户消息]:\n${text}`
      } else if (!hasDynamicResources) {
        this.blockCache.set(this.blockCacheKey(taskId, agent), { block: '', at: Date.now() })
      }
      for (const w of composed.warnings) this.emit(taskId, { type: 'log', level: 'warn', msg: w })
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

    const result = await this.dispatchWithFallback(
      target,
      session.remoteSessionId!,
      fullPrompt,
      {
        onDelta: (delta) => {
          this.store.mutateTask(taskId, (t) => {
            const tt = t.turns.find((x) => x.id === turn.id)
            if (tt) tt.text += delta
          })
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
      },
      signal,
    )

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
    this.store.mutateTask(taskId, (t) => {
      t.status = 'completed'
    })
    this.emit(taskId, { type: 'task_status', status: 'completed' })
  }

  // ---------- orchestrate 编排 ----------

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

    // 5. 汇总
    this.appendSystemTurn(taskId, '📊 所有子任务已完成，主调度正在综合各方产出生成总结报告…')
    const fresh = this.store.getTask(taskId)!
    const summary = await this.planner.summarize(text, fresh.plan?.subtasks || [], targets)
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
    await this.runSubtask(task, sub, agent, target, upstream, mentions.mentionedResourceBindings, signal)
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
  ): Promise<void> {
    const taskId = task.id
    this.store.mutateSubtask(taskId, sub.id, (s) => {
      s.status = 'running'
      s.startedAt = Date.now()
    })
    this.emit(taskId, { type: 'subtask_status', subtask: this.store.getTask(taskId)!.plan!.subtasks.find((x) => x.id === sub.id)! })
    this.emit(taskId, { type: 'log', subtaskId: sub.id, level: 'info', msg: `开始在「${agent.name}」上执行: ${sub.title}` })

    const session = await this.ensureSession(taskId, agent, target)
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

    const parts: string[] = []
    const hasDynamicResources = extraResources && extraResources.length > 0
    const cachedBlock = hasDynamicResources ? null : this.blockCacheFresh(taskId, agent)

    if (!cachedBlock) {
      const composed = await this.composer.compose(agent, {
        resolvedAt: Date.now(),
        extraResources,
      })
      const block = composed.block
      if (!hasDynamicResources) this.blockCache.set(this.blockCacheKey(taskId, agent), { block, at: Date.now() })
      if (block) parts.push(block)
      for (const w of composed.warnings) this.emit(taskId, { type: 'log', subtaskId: sub.id, level: 'warn', msg: w })
    } else if (cachedBlock.block) {
      parts.push(cachedBlock.block)
    }
    for (const u of upstream) parts.push(u)
    parts.push(`[当前子任务指令]:\n${sub.prompt}`)
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

  private async ensureSession(taskId: string, agent: SubAgent, target: DshTarget): Promise<{ ok: boolean; remoteSessionId?: string; reused?: boolean; error?: string }> {
    const task = this.store.getTask(taskId)!
    const wantedCwd = agent.workDir || undefined
    const existing = task.sessions[agent.id]
    if (existing?.remoteSessionId) {
      if ((existing.cwd || undefined) !== wantedCwd) {
        // 工作目录已变更 → 旧会话作废，重建
        this.taskLog(taskId, 'info', `工作目录变更（${agent.name}）: ${existing.cwd || '(默认)'} → ${wantedCwd || '(默认)'}，重建远端会话`)
      } else {
        const st = await this.client.getSession(target, existing.remoteSessionId)
        if (st.ok) return { ok: true, remoteSessionId: existing.remoteSessionId, reused: true }
        // 远端会话已丢失（重启/清理），重建
        this.taskLog(taskId, 'warn', `远端会话丢失（${agent.name}），正在重建: ${existing.remoteSessionId}`)
      }
    }
    const res = await this.client.createSession(target, `[WorkBuddy] ${task.title}`, {
      agentPreset: agent.agentPreset,
      provider: agent.provider,
      model: agent.model,
      cwd: agent.workDir,
    })
    if (!res.ok || !res.sessionId) return { ok: false, error: res.error }
    this.store.mutateTask(taskId, (t) => {
      t.sessions[agent.id] = { remoteSessionId: res.sessionId!, baseUrl: target.baseUrl, cwd: agent.workDir || undefined, createdAt: Date.now() }
    })
    this.taskLog(taskId, 'info', `远程会话已创建（${agent.name}${agent.workDir ? ' · 工作目录 ' + agent.workDir : ''}）: ${res.sessionId} @ ${target.baseUrl}`)
    // 校验远端 cwd 生效
    if (agent.workDir) {
      const info = await this.client.getSessionInfo(target, res.sessionId)
      if (!info.ok || !info.cwd) {
        this.taskLog(taskId, 'warn', `远端会话工作目录校验失败（${agent.name}）: 期望 ${agent.workDir}，实际 ${info.cwd || '(未返回)'} — 远端 dsh-web-service 可能过旧`)
      } else if (info.cwd.replace(/\/+$/, '') !== agent.workDir.replace(/\/+$/, '')) {
        this.taskLog(taskId, 'warn', `远端会话 cwd 与配置不一致（${agent.name}）: 期望 ${agent.workDir}，实际 ${info.cwd}`)
      }
    }
    return { ok: true, remoteSessionId: res.sessionId, reused: false }
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
    // 或提交后流异常终结 —— 远端回合多半仍在继续，轮询对账拿回完整整轮结果
    if (!signal.aborted && (sse.content || sse.complete === false || /SSE 流/.test(sse.error || ''))) {
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
   * 上传附件到任务各成员的远端会话工作区（chat 模式即唯一成员）。
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
    const { targets } = await this.resolver.resolveMembers(task.memberAgentIds)
    // 成员并行分发（串行时多成员 × 隧道延迟叠加，客户端 100% 后长时间无响应）
    const results: Array<{ agentId: string; agentName: string; ok: boolean; error?: string; files?: Array<{ name: string; path: string; size: number }> }> = await Promise.all(
      task.memberAgentIds.map(async (agentId) => {
        const agent = this.store.getAgent(agentId)
        const target = targets.get(agentId)
        if (!agent || !target) return { agentId, agentName: agent?.name || agentId, ok: false, error: '节点不可用' }
        const session = await this.ensureSession(taskId, agent, target)
        if (!session.ok || !session.remoteSessionId) {
          return { agentId, agentName: agent.name, ok: false, error: session.error || '会话创建失败' }
        }
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

  /** 完成并向各成员节点分片中继（成员并行；单成员失败保留暂存可重试） */
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
      const { targets } = await this.resolver.resolveMembers(task.memberAgentIds)
      const results = await Promise.all(
        task.memberAgentIds.map(async (agentId) => {
          const agent = this.store.getAgent(agentId)
          const target = targets.get(agentId)
          if (!agent || !target) return { agentId, agentName: agent?.name || agentId, ok: false, error: '节点不可用' }
          const session = await this.ensureSession(taskId, agent, target)
          if (!session.ok || !session.remoteSessionId) {
            return { agentId, agentName: agent.name, ok: false, error: session.error || '会话创建失败' }
          }
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
  ): Promise<{ ok: boolean; res?: Response; name?: string; agentName?: string; error?: string }> {
    const task = this.store.getTask(taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    if (!filePath?.trim()) return { ok: false, error: '缺少 path 参数' }
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
    const { targets } = await this.resolver.resolveMembers([aid])
    const target = targets.get(aid)
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
