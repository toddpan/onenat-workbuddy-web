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
import { Orchestrator, buildCompletionRequirement, buildTaskContract, buildUpstreamDigests, buildUpstreamSection, sanitizeEngineInstruction, type PlanDraft } from './orchestrator.js'
import type { OnenatDirectory } from './onenat.js'
import type { WorkStore } from './store.js'
import type { SubtaskLogEntry, AgentResourceBinding, DshRef, ExtractedFileMention, ExtractedMentions, ExpertTeam, PlanSubtask, Project, ResolvedDshTarget, SubAgent, TaskEvent, TaskTurn, TurnToolCall, WorkTask } from './types.js'
import { teamMemberKey, EXPERT_AGENT_ID_PREFIX } from './types.js'
import type { SshResourceStore } from './ssh-store.js'
import { expertPersona, type ExpertRegistry, type ExpertProfile } from './expert-registry.js'
import { teamMemberContract } from './expert-teams.js'

/**
 * 节点主会话的伪 agentId：新模型下无 @ 的主会话不绑定任何 sub agent 身份，
 * 直接在任务节点（项目节点/所选节点）上以远端默认形态执行。该 id 仅存在于 task.sessions。
 */
const NODE_AGENT_ID = '__node__'

/** 未配置任务级/智能体级运行权限时的默认值：全部权限（沙箱不限 + 无审批） */
const DEFAULT_PERMISSION = 'danger-full-access'

/** 任务标题 = 用户首条消息的前 30 字（空白折叠）；空消息回落占位符。不再用 LLM 提炼标题。 */
function titleFromMessage(message: string | undefined): string {
  const raw = (message || '').replace(/\s+/g, ' ').trim()
  return raw ? raw.slice(0, 30) : '新任务'
}

export interface CreateTaskInput {
  title?: string
  /** 成员智能体；nodeRef 直发主会话任务时可省略（engine 内部以 __node__ 虚拟执行者直连节点） */
  memberAgentIds?: string[]
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
  /** 任务级模型（provider/model）：定时任务实例配置；主会话（__node__）优先于全局调度模型 */
  model?: string
  /** 专家团任务：按团队合同展开成员并注入规划/派工/汇总（memberAgentIds 未显式给定时以团队名册为准） */
  teamId?: string
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

  /** interaction 进键：同一任务内聊天直发（attended）与编排子任务（unattended）的交互守卫不同，不能共用缓存块 */
  private blockCacheKey(taskId: string, agent: { id: string; updatedAt?: number }, interaction: 'attended' | 'unattended' = 'unattended'): string {
    return `${taskId}:${agent.id}:${agent.updatedAt || 0}:${interaction}`
  }

  private blockCacheFresh(taskId: string, agent: { id: string; updatedAt?: number }, interaction: 'attended' | 'unattended' = 'unattended'): { block: string } | null {
    const e = this.blockCache.get(this.blockCacheKey(taskId, agent, interaction))
    if (!e || Date.now() - e.at >= TaskEngine.BLOCK_CACHE_TTL) return null
    return { block: e.block }
  }

  constructor(
    private store: WorkStore,
    private directory: OnenatDirectory,
    private resolver: AgentResolver,
    private composer: PromptComposer,
    private planner: Orchestrator,
    sshStore?: SshResourceStore,
    /** 专家库注册表（专家团专家成员的 persona 来源）；构造后也可经 attachExperts 注入 */
    private experts?: ExpertRegistry,
  ) {
    this.sshStore = sshStore}

  /** 延迟注入专家库注册表（server.ts 中 router 持有同一实例，构造顺序晚于引擎） */
  public attachExperts(registry: ExpertRegistry): void {
    this.experts = registry
  }

  /** 从用户消息中提取 @子智能体、@资源、@专家团 与 @专家库角色（支持 @智能体:文件路径、@[智能体:文件路径] 及独立 @文件路径） */
  public async extractMentions(text: string): Promise<ExtractedMentions> {
    const mentionedAgentIds: string[] = []
    const mentionedResourceBindings: AgentResourceBinding[] = []
    const mentionedFiles: ExtractedFileMention[] = []
    let mentionedTeamId: string | undefined
    const mentionedExpertIds: string[] = []
    let mentionedExpertAmbiguous: string | undefined
    let mentionedProjectId: string | undefined
    const agents = this.store.getAgents()
    const endpoints = this.directory.listEndpoints()

    // 1. 构建候选词典（按名称长度降序排列，优先匹配最长包含空格的完整实体名，如 "SSH Server"）
    interface DictEntry {
      type: 'agent' | 'resource' | 'team' | 'expert' | 'project'
      name: string
      data: any
    }
    const dict: DictEntry[] = []

    for (const a of agents) {
      if (a.name) dict.push({ type: 'agent', name: a.name, data: a })
      if (a.id) dict.push({ type: 'agent', name: a.id, data: a })
    }

    // 专家团（含内置种子团）也可被 @：命中后本轮消息按该团队合同发起编排
    for (const t of this.store.getTeams()) {
      if (t.enabled !== false && t.name) dict.push({ type: 'team', name: t.name, data: t })
    }

    // 项目也可被 @：@项目名 → 对该项目发起任务（未绑定项目的任务自动绑定，节点/工作区/项目指令/技能全继承）
    for (const pr of this.store.getProjects()) {
      if (pr.name) dict.push({ type: 'project', name: pr.name, data: pr })
    }

    // 专家库角色可被 @：单个 → 定向直派（动态实例化在任务节点），多个 → 并行编排。
    // 词典含中英文名；同名多专家收进同一词条，未带 #id 命中时拒绝召唤（@名称#id 可精确直派；
    // 子智能体/团队同名时按词典顺序优先命中）。
    if (this.experts) {
      const expertList = await this.experts.search('').catch(() => [])
      const byName = new Map<string, { name: string; experts: any[] }>()
      for (const e of expertList) {
        for (const nm of [e.name, e.nameEn]) {
          const key = String(nm || '').trim().toLowerCase()
          if (!key) continue
          const hit = byName.get(key)
          if (hit) hit.experts.push(e)
          else byName.set(key, { name: String(nm).trim(), experts: [e] })
        }
      }
      for (const { name, experts } of byName.values()) {
        dict.push({ type: 'expert', name, data: experts.length === 1 ? experts[0] : experts })
      }
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
            } else if (entry.type === 'team') {
              const tm = entry.data as { id: string }
              if (!mentionedTeamId) mentionedTeamId = tm.id
            } else if (entry.type === 'project') {
              const pr = entry.data as { id: string }
              if (!mentionedProjectId) mentionedProjectId = pr.id
            } else if (entry.type === 'expert') {
              const e = entry.data
              // @名称#id：客户端选人时携带唯一 id（专家库 roster/builtin/user 三来源存在同名），
              // 命中词条内任一专家 id 即精确直派，不再触发同名歧义拒绝；id 不匹配时回退原语义。
              const pool: any[] = Array.isArray(e) ? e : [e]
              const hash = /^#([^\s@,，。!！?？;；]+)/.exec(afterName)
              const exact = hash ? pool.find((x) => String(x?.id) === hash[1]) : undefined
              if (exact) {
                if (!mentionedExpertIds.includes(exact.id)) {
                  mentionedExpertIds.push(exact.id)
                }
                i += hash![0].length // 额外消费「#id」
              } else if (Array.isArray(e)) {
                // 同名多专家且未带有效 #id：拒绝召唤，避免召唤到错误角色
                mentionedExpertAmbiguous = entry.name
              } else if (!mentionedExpertIds.includes(e.id)) {
                mentionedExpertIds.push(e.id)
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
      ...(mentionedTeamId ? { mentionedTeamId } : {}),
      ...(mentionedExpertIds.length ? { mentionedExpertIds } : {}),
      ...(mentionedExpertAmbiguous ? { mentionedExpertAmbiguous } : {}),
      ...(mentionedProjectId ? { mentionedProjectId } : {}),
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

  /**
   * 启动自愈：服务重启会丢失全部执行上下文（activeJobs/SSE），但 running 状态已持久化——
   * 不处理的话这些任务永远卡在「运行中」成为僵尸。启动时统一标记失败并附系统说明。
   * （远端 DSH 会话可能仍在跑，其产出以远端会话为准；后续消息可基于 task.nodeRef/项目重新发起）
   */
  public recoverInterruptedTasks(): number {
    let n = 0
    for (const t of this.store.getTasks()) {
      if (t.status !== 'running') continue
      this.store.mutateTask(t.id, (x) => {
        x.status = 'failed'
        for (const turn of x.turns) {
          if (turn.streaming) turn.streaming = false
        }
      })
      this.appendSystemTurn(t.id, '⚠️ 服务重启导致本轮执行中断，任务已标记为失败；远端可能仍产生过部分结果，如需请重发消息')
      n++
    }
    if (n > 0) console.log(`[onenat-workbuddy] 启动自愈：${n} 个因重启中断的任务已标记为失败`)
    return n
  }

  public async createTask(input: CreateTaskInput): Promise<WorkTask> {
    const explicit = Array.isArray(input.memberAgentIds) ? input.memberAgentIds.filter((id) => Boolean(id)) : []
    // 专家团任务：团队名册是成员账本的默认来源（显式传入的 memberAgentIds 优先，teamId 仅作合同标记保留）
    const team = input.teamId ? this.store.getTeam(input.teamId) : undefined
    if (input.teamId && !team) throw new Error(`专家团不存在: ${input.teamId}`)
    if (team && team.enabled === false) throw new Error(`专家团「${team.name}」已停用，请先在子智能体页启用`)
    let memberAgentIds = explicit.length ? [...new Set(explicit)] : []
    let expertMembers: WorkTask['expertMembers'] = undefined
    if (team && !explicit.length) {
      // 团队名册展开：agentId 成员校验存在，expertId 成员登记为动态成员（编排时实例化在任务节点）
      const expanded = await this.expandTeamRoster(team)
      const missingAgents = team.members
        .filter((m) => m.agentId)
        .map((m) => ({ m, agent: this.store.getAgent(m.agentId!) }))
        .filter((x) => !x.agent || x.agent.enabled === false)
      if (missingAgents.length) {
        throw new Error(`专家团「${team.name}」成员不可用: ${missingAgents.map((x) => x.agent?.name || x.m.agentId).join('、')}（不存在或已停用）`)
      }
      const missingExperts = team.members.filter((m) => m.expertId && !expanded.expertMembers.some((e) => e.id === teamMemberKey(m)))
      if (missingExperts.length) {
        throw new Error(`专家团「${team.name}」专家成员不可用: ${missingExperts.map((m) => m.expertId).join('、')}（专家库中不存在）`)
      }
      memberAgentIds = expanded.agentIds
      expertMembers = expanded.expertMembers.length ? expanded.expertMembers : undefined
    }
    // 新模型：成员账本 = 参与过的 sub agent（@ 时自动追加），不再预填「主智能体」；
    // 无 @ 的主会话直接在任务节点上执行（processUserMessage → runChatTurn 节点直发）
    const totalMembers = memberAgentIds.length + (expertMembers?.length || 0)
    const mode: WorkTask['mode'] = input.mode || (totalMembers > 1 ? 'orchestrate' : 'chat')
    const task: WorkTask = {
      id: `task-${randomUUID().slice(0, 8)}`,
      title: input.title?.trim() || titleFromMessage(input.message),
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
      ...(input.model ? { model: input.model } : {}),
      ...(input.connectorIds?.length ? { connectorIds: input.connectorIds } : {}),
      ...(input.skillNames?.length ? { skillNames: input.skillNames } : {}),
      ...(team ? { teamId: team.id } : {}),
      ...(expertMembers?.length ? { expertMembers } : {}),
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
          const agent = await this.resolveMemberAgent(task, sub.agentId)
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
        if (tg && binding.remoteSessionId) await this.client.cancelSession(tg, binding.remoteSessionId).catch(() => {})
        // 远端 cancel 实测解不开 ask_user_question 挂起批次（批次仍登记、run 仍悬停）——
        // 停止时同步解挂：提交中止答复让挂起的 run 收尾，会话恢复可用（否则下一条消息
        // 经 followup 排队在挂起 run 后面永不被处理，表现为「停了还是卡」）。
        if (tg && binding.remoteSessionId) {
          const pq = await this.client.listPendingQuestions(tg, binding.remoteSessionId).catch(() => undefined)
          if (pq?.ok && (pq.count || 0) > 0) {
            const answers = (pq.batches || [])
              .flatMap((b) => b.questions || [])
              .filter((q) => q?.id)
              .map((q) => ({ id: String(q.id), selected: [] as string[], custom: '［用户已中止］停止当前执行：立即收尾，简要总结已完成的进展，不要继续新的动作。' }))
            if (answers.length) {
              const ar = await this.client.answerQuestion(tg, binding.remoteSessionId, answers).catch(() => ({ ok: false } as const))
              if (ar.ok) this.taskLog(taskId, 'info', '挂起提问已随停止自动答复，远端会话解除挂起')
            }
          }
        }
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
      const agent = await this.resolveMemberAgent(task, sub.agentId)
      if (!agent) {
        this.store.mutateSubtask(taskId, subtaskId, (s) => {
          s.status = 'failed'
          s.error = '成员不存在（子智能体已删除或专家档案缺失）'
        })
        return { ok: false, error: '成员不存在' }
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

  public async sendUserMessage(taskId: string, text: string, opts?: { teamId?: string }): Promise<{ ok: boolean; turn?: TaskTurn; queued?: boolean; error?: string }> {
    const task = this.store.getTask(taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    if (!text.trim()) return { ok: false, error: '消息为空' }
    // 执行中 → 排队：登记为 queued 轮次，本轮结束后自动补发（queue/send 可立即插话）
    if (this.activeJobs.has(taskId)) {
      const turn: TaskTurn = { id: `turn-${randomUUID().slice(0, 8)}`, seq: 0, role: 'user', text: text.trim(), at: Date.now(), queued: true }
      this.store.appendTurn(taskId, turn)
      this.store.mutateTask(taskId, (t) => {
        t.queue = t.queue || []
        t.queue.push({ text: text.trim(), at: Date.now(), turnId: turn.id, ...(opts?.teamId ? { teamId: opts.teamId } : {}) })
      })
      return { ok: true, queued: true, turn }
    }

    const turn: TaskTurn = { id: `turn-${randomUUID().slice(0, 8)}`, seq: 0, role: 'user', text: text.trim(), at: Date.now() }
    this.store.appendTurn(taskId, turn)
    this.store.mutateTask(taskId, (t) => {
      t.status = 'running'
    })
    this.emit(taskId, { type: 'turn_start', turn })

    // 提取 @ 提及的智能体与资源（@专家团 / @专家库角色 也在其中）
    const mentions = await this.extractMentions(text.trim())

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

    // @专家库角色：登记为任务动态成员（expert-<id> 伪 id，不落子智能体实体）
    const mentionedExpertIds = mentions.mentionedExpertIds || []
    if (mentions.mentionedExpertAmbiguous) {
      this.appendSystemTurn(taskId, `⚠️ 专家库中存在多个同名角色「${mentions.mentionedExpertAmbiguous}」，已拒绝召唤；请改用 @名称#id 指定具体专家、使用子智能体或指定其他专家`)
    }
    if (mentionedExpertIds.length) {
      const added: Array<{ id: string; name: string }> = []
      for (const eid of mentionedExpertIds) {
        const pseudo = EXPERT_AGENT_ID_PREFIX + eid
        if (task.expertMembers?.some((m) => m.id === pseudo)) continue
        const ex = await this.experts?.get(eid).catch(() => undefined)
        if (!ex) {
          this.appendSystemTurn(taskId, `⚠️ 专家「${eid}」不在专家库中，已忽略`)
          continue
        }
        added.push({ id: pseudo, name: ex.name })
      }
      if (added.length) {
        this.store.mutateTask(taskId, (t) => {
          const merged = new Map([...(t.expertMembers || []).map((m) => [m.id, m] as const), ...added.map((m) => [m.id, m] as const)])
          t.expertMembers = [...merged.values()]
        })
        this.taskLog(taskId, 'info', `@专家 ${added.map((m) => m.name).join('、')} 已加入任务（动态成员）`)
      }
      // @ 实体总数 ≥2（智能体 + 专家）与 @ 多个专家同样视为编排意图
      if (mentions.mentionedAgentIds.length + mentionedExpertIds.length >= 2) {
        this.store.mutateTask(taskId, (t) => { t.mode = 'orchestrate' })
      }
    }

    // @项目：对项目发起任务 —— 任务尚未绑定项目时自动绑定，节点/工作目录/项目指令/技能全部自动继承
    // （与 create 带 projectId 同语义，后续无 @ 消息也在项目节点直发）；已绑定其他项目则提示并忽略，不支持中途切换
    if (mentions.mentionedProjectId) {
      const mentioned = this.store.getProject(mentions.mentionedProjectId)
      if (!mentioned) {
        this.appendSystemTurn(taskId, `⚠️ 项目「${mentions.mentionedProjectId}」不存在，已忽略该 @ 项目提及`)
      } else if (task.projectId === mentioned.id) {
        // 已是本项目：noop
      } else if (task.projectId) {
        const current = this.store.getProject(task.projectId)
        this.appendSystemTurn(taskId, `⚠️ 任务已绑定项目「${current?.name || task.projectId}」，@项目「${mentioned.name}」已忽略（任务不支持中途切换项目）`)
      } else {
        this.store.mutateTask(taskId, (t) => { t.projectId = mentioned.id })
        this.taskLog(taskId, 'info', `@项目「${mentioned.name}」：任务已绑定该项目，节点、工作目录、项目指令与技能自动继承`)
        this.appendSystemTurn(taskId, `📁 已绑定项目「${mentioned.name}」——本轮起任务在该项目上下文执行（节点、工作目录、项目指令、可@ 专家自动继承）`)
      }
    }

    const ctrl = new AbortController()
    this.activeJobs.set(taskId, ctrl)

    // 异步执行，立即返回用户轮次（流式经 SSE 推送）
    void this.processUserMessage(taskId, text.trim(), mentions, ctrl.signal, opts)
      .catch((err) => {
        this.appendSystemTurn(taskId, `⚠️ 引擎异常: ${err?.message || err}`)
      })
      .finally(() => {
        this.activeJobs.delete(taskId)
        void this.flushMessageQueue(taskId)
      })
    return { ok: true, turn }
  }

  /** 轮次收尾：补发排队消息（FIFO，逐条）；轮次排队标记随之清除 */
  private async flushMessageQueue(taskId: string) {
    await new Promise((r) => setTimeout(r, 800)) // 等状态落定
    const task = this.store.getTask(taskId)
    const next = task?.queue?.[0]
    if (!next) return
    this.store.mutateTask(taskId, (t) => {
      t.queue = (t.queue || []).filter((q) => q.turnId !== next.turnId)
      const turn = t.turns.find((x) => x.id === next.turnId)
      if (turn) delete turn.queued
    })
    await this.sendUserMessage(taskId, next.text, next.teamId ? { teamId: next.teamId } : undefined).catch(() => undefined)
  }

  /**
   * 「立即发送」：steer 插话 —— 把文本注入正在运行的远端回合（不新开轮次）。
   * 目标会话：优先节点主会话（__node__），其次最近路由的成员会话，再次任意绑定会话。
   */
  public async steerTaskMessage(taskId: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const task = this.store.getTask(taskId)
    if (!task) return { ok: false, error: '任务不存在' }
    const entries = Object.entries(task.sessions || {}).filter(([, b]) => b.remoteSessionId)
    if (!entries.length) return { ok: false, error: '任务尚无远端会话，无法插话' }
    const pick =
      entries.find(([k]) => k === '__node__') ||
      entries.find(([k]) => k === task.lastRoute?.agentId) ||
      entries[0]
    const [agentId, binding] = pick
    const agent = this.store.getAgent(agentId)
    const target = agent ? await this.resolver.resolve(agent) : await this.resolveExecTarget(task, agentId)
    if (!target || !target.online || !target.baseUrl) return { ok: false, error: '节点不可达' }
    const r = await this.client.steerSession(target, binding.remoteSessionId!, text)
    if (!r.ok) return { ok: false, error: r.error }
    this.taskLog(taskId, 'info', `已插话到运行中回合（${agent?.name || agentId}）`)
    return { ok: true }
  }

  /** 队列「立即发送」：按 turnId 取出排队消息 → 运行中则插话，否则立即派发 */
  public async sendQueuedNow(taskId: string, turnId: string): Promise<{ ok: boolean; error?: string }> {
    const task = this.store.getTask(taskId)
    const entry = task?.queue?.find((q) => q.turnId === turnId)
    if (!entry) return { ok: false, error: '排队消息不存在或已发送' }
    this.store.mutateTask(taskId, (t) => {
      t.queue = (t.queue || []).filter((q) => q.turnId !== turnId)
      const turn = t.turns.find((x) => x.id === turnId)
      if (turn) delete turn.queued
    })
    if (this.activeJobs.has(taskId)) return await this.steerTaskMessage(taskId, entry.text)
    return await this.sendUserMessage(taskId, entry.text)
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

  private async processUserMessage(taskId: string, text: string, mentions: ExtractedMentions, signal: AbortSignal, opts?: { teamId?: string }): Promise<void> {
    let task = this.store.getTask(taskId)
    if (!task) return

    // 消息级专家团意图（composer 选择器显式传入 / @团队名 提及）：
    // 命中后把团队固化为任务语义（teamId/mode/成员账本），本轮起按团队合同编排；
    // 后续无 @ 消息延续团队编排，与「创建团队任务」同构（对齐插件「一次任务只使用一个专家团」）。
    const messageTeamId = opts?.teamId || mentions.mentionedTeamId
    if (messageTeamId) {
      const team = this.store.getTeam(messageTeamId)
      if (!team || team.enabled === false) {
        this.appendSystemTurn(taskId, `⚠️ 专家团「${team?.name || messageTeamId}」不存在或已停用，本轮按普通路由执行`)
      } else if (team.id !== task.teamId) {
        const expanded = await this.expandTeamRoster(team, taskId)
        this.store.mutateTask(taskId, (t) => {
          t.teamId = team.id
          t.mode = 'orchestrate'
          t.memberAgentIds = [...new Set([...t.memberAgentIds, ...expanded.agentIds])]
          const merged = new Map([...(t.expertMembers || []).map((m) => [m.id, m] as const), ...expanded.expertMembers.map((m) => [m.id, m] as const)])
          t.expertMembers = [...merged.values()]
        })
        task = this.store.getTask(taskId)
        this.taskLog(taskId, 'info', `专家团「${team.name}」已接管本轮编排（${expanded.agentIds.length} 名子智能体成员 + ${expanded.expertMembers.length} 名专家库成员）`)
      }
    }
    if (!task) return

    // 标题仍是占位（工单创建时无消息）→ 直接取首条用户消息前缀作标题。
    // 放在路由判定前：不依赖远端可达；也彻底不再向远端会话下发标题提炼提示词
    // （旧路径的内部指令问答会残留在会话历史顶部、污染任务上下文）。
    if (this.needsAutoTitle(task)) {
      const autoTitle = titleFromMessage(text)
      if (autoTitle !== '新任务') {
        this.store.mutateTask(taskId, (t) => {
          t.title = autoTitle
        })
        this.emit(taskId, { type: 'task_status', status: this.store.getTask(taskId)?.status || 'running' })
      }
    }

    // 智能调度模式判定：
    // 1. 如果用户明确 @ 了子智能体，按提及的智能体定向派发（如果多个则编排，单人则直通）；
    // 2. 如果用户完全没有 @ 任何子智能体（纯提问/咨询/诊断，如“分析为什么连接不上”）：
    //    由【主智能体（Planner / 本地主调度）】直接进行分析与应答（直通 chat 模式），避免强行将诊断性问题拆解分发给故障节点；
    //    注意：主智能体身份每条消息实时解析（planner.pickTarget → settings.planner.agentId），
    //    因此对话过程中切换主智能体后，下一条消息即路由到切换后的智能体（任何任务模式一致）。
    // 3. 主智能体不可用时才回退到任务既有成员。

    const hasExplicitAgentMention = mentions.mentionedAgentIds.length > 0
    const mentionedExpertIds = mentions.mentionedExpertIds || []
    // 本轮是否明确 @ 了“恰好一个”智能体 —— 用户只想把这件事交给那一个智能体，
    // 不应被任务已有的多成员/编排模式放大成跨多智能体流水线
    const singleExplicitMention = mentions.mentionedAgentIds.length === 1
    // 专家团任务：团队合同（团队名册 + 分工）是任务的主语义，无 @ 的消息也按合同走编排，
    // 不落入「无 @ = 主会话直发」——否则团队任务的目标会被单智能体消化，合同形同虚设。
    // 本轮显式携带团队意图（@团队/选择器）时，团队语义优先于 @ 智能体（对齐插件：团队提及即整体委派）；
    // @专家 / @智能体 都视为显式定向意图，不触发团队合同。
    const teamOrchestrate = Boolean(task.teamId) && task.mode === 'orchestrate' && (!hasExplicitAgentMention && !mentionedExpertIds.length || Boolean(messageTeamId))

    if (!hasExplicitAgentMention && !mentionedExpertIds.length && !teamOrchestrate) {
      // 新模型：无 @ = 主会话直发任务节点。项目任务=项目配置节点；非项目任务=创建时所选节点。
      // 主会话不绑定任何 sub agent 身份（远端默认形态 + 项目指令），sub agent 通过 @ 在该节点上调用。
      // （@专家库角色 视为显式定向意图，跳过本分支进入下方的直派/编排路由）
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

    // 专家团专家成员（含消息 @专家 登记的动态成员）：实例化在任务节点，
    // 任务未绑定节点时回退主调度节点（resolveExpertNodeTarget）
    const expertMembersAll = task.expertMembers || []
    if (expertMembersAll.length) {
      const expertNode = await this.resolveExpertNodeTarget(task, taskId)
      for (const em of expertMembersAll) {
        if (targets.has(em.id)) continue
        const expertAgent = await this.resolveMemberAgent(task, em.id)
        if (!expertAgent) {
          this.taskLog(taskId, 'warn', `专家成员「${em.name}」档案不可用（专家资产缺失？），本轮跳过`)
          continue
        }
        if (expertNode?.online && expertNode.baseUrl) targets.set(expertAgent.id, expertNode)
        else this.taskLog(taskId, 'warn', `专家成员「${em.name}」执行节点不可达，本轮无法执行`)
      }
    }

    // @ 了恰好一个智能体：定向委派——与多 sub agent 编排同构：
    // 子任务在 sub agent 自身绑定节点执行，最终产物（汇总）回任务发起节点
    // @ 了恰好一个专家库角色：定向直派——动态实例化在任务节点（或主调度回退节点），
    // persona 用专家档案，不落持久实体（对齐 dsh-agency-agents summon_expert 语义）。
    // （本轮显式携带团队意图时团队语义优先，不落入单人直派）
    const singleAgentMention = !messageTeamId && singleExplicitMention && hasExplicitAgentMention && !mentionedExpertIds.length
    const singleExpertMention = !messageTeamId && !hasExplicitAgentMention && mentionedExpertIds.length === 1
    if (singleAgentMention || singleExpertMention) {
      const onlyId = singleAgentMention ? mentions.mentionedAgentIds[0] : EXPERT_AGENT_ID_PREFIX + mentionedExpertIds[0]
      const onlyAgent = await this.resolveMemberAgent(task, onlyId)
      // 记录本轮路由：单人 @ → 定向委派/直派
      this.store.mutateTask(taskId, (t) => {
        t.lastRoute = { kind: 'direct', agentId: onlyId, agentName: onlyAgent?.name || onlyId }
      })
      // 解析执行目标：子智能体回自身绑定节点（不可达时回退任务节点）；专家在任务节点/主调度回退节点
      const singleTarget = singleAgentMention
        ? await this.resolveExecTarget(task, onlyId)
        : await this.resolveExpertNodeTarget(task, taskId)
      if (singleTarget && onlyAgent) {
        await this.runDelegatedTurn(taskId, text, mentions, onlyId, singleTarget, signal)
      } else {
        this.appendSystemTurn(taskId, `⚠️ 被 @ 的成员「${onlyAgent?.name || onlyId}」暂不可用（${!onlyAgent ? '成员不存在或档案缺失' : '节点不可达'}）`)
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

    if (!teamOrchestrate && (task.mode === 'chat' || targets.size === 1 || (!hasExplicitAgentMention && !mentionedExpertIds.length && targets.size > 1))) {
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
    const extraSections: string[] = []
    // 工作区跨机访问注入（@智能体 即触发，需在 files 早退之前）
    // @智能体 → 注入发起方项目工作区的跨机访问指引：
    // 让异机智能体可通过节点 URL 下载/浏览/预览工作区内任意文件（不限消息中点名的文件）
    const mentionedAgentCount = mentions?.mentionedAgentIds?.length || 0
    if (mentionedAgentCount > 0 && task) {
      const exec0 = this.taskExec(task)
      // 工作区来源与节点必须【配对】：工作区在哪台机器，URL 就指向哪台节点的文件服务
      const nodeSess = task.sessions?.['__node__']
      const member0 = task.memberAgentIds[0] ? this.store.getAgent(task.memberAgentIds[0]) : undefined
      const member0Binding = task.memberAgentIds[0] ? task.sessions?.[task.memberAgentIds[0]] : undefined
      let ws = ''
      let base = ''
      let nodeApiKey: string | undefined = exec0.apiKey
      if (exec0.workspace) {
        ws = exec0.workspace
        const t = exec0.dshRef ? await this.resolver.resolveRef(exec0.dshRef, exec0.apiKey, '__node__').catch(() => undefined) : undefined
        if (t?.baseUrl) { base = t.baseUrl; nodeApiKey = t.apiKey } else if (nodeSess?.baseUrl) base = nodeSess.baseUrl
      } else if (nodeSess?.cwd) {
        ws = nodeSess.cwd
        const t = exec0.dshRef ? await this.resolver.resolveRef(exec0.dshRef, exec0.apiKey, '__node__').catch(() => undefined) : undefined
        if (t?.baseUrl) { base = t.baseUrl; nodeApiKey = t.apiKey } else if (nodeSess.baseUrl) base = nodeSess.baseUrl
      } else if (member0Binding?.cwd) {
        ws = member0Binding.cwd
        const m = member0 ? await this.resolver.resolve(member0).catch(() => undefined) : undefined
        if (m?.baseUrl) { base = m.baseUrl; nodeApiKey = m.apiKey } else if (member0Binding.baseUrl) base = member0Binding.baseUrl
      } else if (member0?.workDir) {
        ws = member0.workDir
        const m = await this.resolver.resolve(member0).catch(() => undefined)
        if (m?.baseUrl) { base = m.baseUrl; nodeApiKey = m.apiKey }
      }
      if (ws && base) {
        const auth = nodeApiKey ? ` -H "Authorization: Bearer ${nodeApiKey}"` : ''
        extraSections.push([
          '[项目工作区跨机访问]（消息 @ 了你 —— 如需读取发起方工作区内的任意文件，用以下远程访问方式）:',
          `- 工作区路径: \`${ws}\`（若与你在同一台机器，可直接按该绝对路径读取文件）`,
          `- 下载文件: curl${auth} "${base}/fs/download?path=<URL编码后的文件绝对路径>" -o <保存文件名>`,
          `- 预览文本文件: 在下载命令的 URL 末尾追加 &inline=1`,
          `- 浏览目录: curl${auth} "${base}/fs/list?path=<URL编码后的目录绝对路径>"`,
          `- 重要: path 必须是【绝对路径】（= 工作区路径 + "/" + 文件名；不支持相对路径），且需 URL 编码（空格→%20 等）`,
          `- 示例: 下载工作区根目录下的 a.txt → curl${auth} "${base}/fs/download?path=${encodeURIComponent(ws + '/a.txt')}" -o a.txt`,
        ].join('\n'))
      }
    }

    const files = mentions?.mentionedFiles || []
    if (!files.length) return { text, extraSections }

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
  // NOTE: workspace-access injection appended below (see injectWorkspaceAccess)

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

    // ask_user_question 挂起预检：远端 run 被提问挂起时悬停在工具内部 —— 向其发新 prompt
    // 只会经 followup 排队在挂起 run 之后永不被处理（表现为回合静默到 SSE 超时再对账半小时）。
    // 此时用户的自由文本消息就是答复：走 /answers 桥解锁挂起的 run 并追踪续跑，而不是发新 prompt。
    if (session.remoteSessionId) {
      const handled = await this.answerPendingAndResume(taskId, text, agent, target, session.remoteSessionId, signal).catch(() => false)
      if (handled) return
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
    // 运行权限：已在 ensureSession 经 PUT /sessions/:id/permission 原生生效；仅旧版节点才降级写进提示词
    const permLine = this.permissionPromptLine(this.store.getTask(taskId) || task, agent)
    // 项目指令 + 专家人格（角色声明/职责约束/执行指导，见 expert-templates）+ 项目 SSH 连接器：注入本轮提示词最前（项目上下文）
    // 主会话（__node__）是远端节点本体，不是团队成员：不注入成员人格（否则会被要求"不做转派"而禁用自身的子智能体/团队能力）。
    // 其余智能体在聊天直发路径是与用户直接对话（direct），不是被主调度派工的成员。
    const persona = agent.id === NODE_AGENT_ID ? '' : expertPersona(agent, 'direct')
    // 值守模式：定时任务派生的会话无人值守；成员/子智能体会话一律无人值守 ——
    // ask_user_question 会让远程 DSH 会话停下来等待人工答复，且子智能体深层的提问
    // 无法透传回 WorkBuddy UI（交互卡只渲染在直发轮次），导致整条链路挂死。
    // 只有节点主会话（用户无 @ 直发）才是与用户面对面的有人值守对话，允许提问确认。
    const isNodeMain = agent.id === NODE_AGENT_ID && !task.scheduleId
    const interaction: 'attended' | 'unattended' = isNodeMain ? 'attended' : 'unattended'
    const sysPrefix = [exec.instruction, persona, permLine].filter(Boolean).join('\n\n')
    const sshSection = exec.sshConnectors.length
      ? '[项目 SSH 连接器]（已可用 onenat_ssh 工具直接操作，连接信息如下）:\n' + exec.sshConnectors.map((c) => '- ' + c.name + ' → ' + c.host + ':' + c.port).join('\n')
      : ''
    let fullPrompt = transformed.text
    const hasDynamicResources = mentions.mentionedResourceBindings.length > 0 || (mentions.mentionedFiles && mentions.mentionedFiles.length > 0)
    const cachedBlock = hasDynamicResources ? null : this.blockCacheFresh(taskId, agent, interaction)

    if (!cachedBlock) {
      const composed = await this.composer.compose(agent, {
        resolvedAt: Date.now(),
        extraResources: [...exec.extraBindings, ...mentions.mentionedResourceBindings],
        extraSkills: exec.skills,
        interaction,
      })
      const block = composed.block
      const extraFileSection = transformed.extraSections.join('\n\n')
      const allPrefixes = [block, extraFileSection].filter(Boolean).join('\n\n')
      const withCtx = [sysPrefix, sshSection, allPrefixes].filter(Boolean).join('\n\n')
      if (withCtx) {
        if (!hasDynamicResources) this.blockCache.set(this.blockCacheKey(taskId, agent, interaction), { block, at: Date.now() })
        fullPrompt = `${withCtx}\n\n[当前用户消息]:\n${transformed.text}`
      } else if (!hasDynamicResources) {
        this.blockCache.set(this.blockCacheKey(taskId, agent, interaction), { block: '', at: Date.now() })
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
    // ask_user_question 挂起监视：tool_call 后轮询远端挂起批次（S1/S3）。
    // streamCtrl 只断流（区别于任务级 signal）；attended 命中 → 快速终结回合等待答复，不再走 10min 静默 + 30min 对账黑洞。
    const streamCtrl = new AbortController()
    signal.addEventListener('abort', () => streamCtrl.abort(), { once: true })
    const askWatch = { fired: false, mode: 'bridge' as 'bridge' | 'unbridged' }
    const pushAskToolUpdate = () => {
      const tt = this.store.getTask(taskId)?.turns.find((x) => x.id === turn.id)
      const t = [...(tt?.tools || [])].reverse().find((x) => x.name === 'ask_user_question' || x.name === 'ask-user-question')
      if (t) emitTool({ ...t })
    }
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
        // ask 提问挂起监视：命中批次时 attended 快速终结等待答复 / unattended 自动保守答复解锁
        if (isAskTool && !askWatch.fired && session.remoteSessionId) {
          void this.watchPendingAsk(taskId, agent, target, session.remoteSessionId, turn.id, interaction, streamCtrl, askWatch, pushAskToolUpdate)
      }
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

    let result = await this.dispatchWithFallback(target, session.remoteSessionId!, fullPrompt, streamHandlers, streamCtrl.signal)
    // 空结果自愈：远端收到指令但零内容零工具（LLM 上游瞬时异常/流丢失）——
    // 自动重发一次；有工具调用的回合绝不重发（避免发飞书等副作用重复执行）；
    // ask 挂起终结的回合也绝不重发（重发只会经 followup 排队在挂起 run 后面，制造孤儿消息）
    if (!askWatch.fired) {
      const turnNow = this.store.getTask(taskId)!.turns.find((x) => x.id === turn.id)
      if (!signal.aborted && !(turnNow?.tools || []).length && !(streamSeq > 1)) {
        this.taskLog(taskId, 'warn', `${agent.name} 本轮无任何内容产出（远端流为空），自动重发一次`)
        result = await this.dispatchWithFallback(target, session.remoteSessionId!, fullPrompt, streamHandlers, streamCtrl.signal)
      }
    }

    // ask 挂起终结（桥可见）：远端在等用户答复 —— 回合立即收尾（ask 工具保持 running 供答复卡/桥使用），
    // 任务状态落 completed + pendingAsk 标记；用户回复将由 answerPendingAndResume 路由到答复桥。
    if (askWatch.fired && !signal.aborted && askWatch.mode === 'bridge') {
      this.finalizeWaitingAskTurn(taskId, turn.id, agent)
      this.store.mutateTask(taskId, (t) => { t.status = 'completed' })
      this.emit(taskId, { type: 'task_status', status: 'completed' })
      return
    }
    // ask 挂起终结（桥不可见）：批次未登记进 /questions（被浏览器应答器持走/归属失败/节点过旧），
    // 答复桥无法触达 —— 表面化问题内容并中止远端悬停回合（cancelSession 实测可解此形态），
    // 用户下一条消息作为新指令在已空闲的会话上直接执行。
    if (askWatch.fired && !signal.aborted && askWatch.mode === 'unbridged') {
      await this.finalizeUnbridgedAskTurn(taskId, turn.id, agent, target, session.remoteSessionId!)
      this.store.mutateTask(taskId, (t) => { t.status = 'completed' })
      this.emit(taskId, { type: 'task_status', status: 'completed' })
      return
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

  // ---------- ask_user_question 挂起治理 ----------
  // 远端 ask_user_question 会把 run 悬停在工具内部等待答复：会话状态恒 running、
  // 后续 prompt 经 followup 排队永不被处理、远端 cancel 也解不开批次（线上实测）。
  // 治理三板斧：派发中检测（watchPendingAsk）→ 自由文本答复桥（answerPendingAndResume）→ 停止时解挂（cancelTask）。

  private static readonly ASK_WAIT_HINT = '🔔 远端助手有提问等待你答复 —— 直接在下方输入回复发送即可（自由文本将自动作为问题答复提交）；也可以点问题卡片里的选项作答'

  private static readonly UNATTENDED_AUTO_ANSWER =
    '（无人值守自动答复）无法等待人工输入：请按任务既定目标继续执行，参数取保守默认值，并在最终产出中显式列出本答复所做的假设。'

  /**
   * ask 挂起监视：ask_user_question 的 tool_call 后轮询远端挂起批次。
   * - attended（节点主会话）：命中 → 记录 task.pendingAsk、断流快速终结回合（不再 10min 静默 + 30min 对账）；
   * - unattended（成员/编排/定时）：命中 → 自动提交保守默认答复解锁执行链（流不中断，tool_result 照常回传）；
   *   答复失败也要快速终结（挂起会话只会越等越死）。
   */
  private async watchPendingAsk(
    taskId: string,
    agent: SubAgent | { name: string; id: string },
    target: DshTarget,
    sessionId: string,
    turnId: string,
    interaction: 'attended' | 'unattended',
    streamCtrl: AbortController,
    askWatch: { fired: boolean; mode: 'bridge' | 'unbridged' },
    onPush: () => void,
  ): Promise<void> {
    const windowMs = Number(process.env.WB_ASK_WATCH_WINDOW_MS || 60_000)
    const deadline = Date.now() + windowMs
    while (Date.now() < deadline) {
      if (askWatch.fired || streamCtrl.signal.aborted) return
      await new Promise((r) => setTimeout(r, 2_000))
      if (askWatch.fired || streamCtrl.signal.aborted) return
      const pq = await this.client.listPendingQuestions(target, sessionId).catch(() => undefined)
      if (askWatch.fired || streamCtrl.signal.aborted) return
      // 桥快路径：批次已登记（count>0）——attended 等待答复 / unattended 自动保守答复
      if (pq?.ok && pq.supported && (pq.count || 0) > 0) {
        const questions = (pq.batches || []).flatMap((b) => b.questions || [])
        if (interaction === 'unattended') {
          const answers = questions.filter((q) => q?.id).map((q) => ({ id: String(q.id), selected: [] as string[], custom: TaskEngine.UNATTENDED_AUTO_ANSWER }))
          const r = answers.length
            ? await this.client.answerQuestion(target, sessionId, answers).catch((e: any) => ({ ok: false, error: e?.message || '答复失败' }))
            : { ok: false, error: '挂起问题缺少 id，无法桥接答复' }
          if (r.ok) {
            this.taskLog(taskId, 'warn', '无人值守会话出现挂起提问，已自动按保守默认答复解锁执行链')
            return // 流继续：工具已 resolve，后续 tool_result/turn_end 照常
          }
          this.taskLog(taskId, 'error', `无人值守挂起提问自动答复失败: ${(r as any).error} —— 快速终结以免整链挂死`)
        } else {
          askWatch.fired = true
          askWatch.mode = 'bridge'
          this.store.mutateTask(taskId, (t) => {
            t.pendingAsk = { agentId: agent.id, sessionId, batchId: pq.batches?.[0]?.batchId, questions, turnId, at: Date.now() }
          })
          this.store.updateTurn(taskId, turnId, (tt) => {
            const t = [...(tt.tools || [])].reverse().find((x) => x.name === 'ask_user_question' || x.name === 'ask-user-question')
            if (t && t.status === 'running') t.result = '⏳ 等待用户答复（回复即答复）'
          })
          onPush()
          streamCtrl.abort()
          return
        }
      }
      // ask 工具已结束（tool_result 到达 / 正常完成）→ 无需治理
      if (!this.askToolStillRunning(taskId, turnId)) return
    }
    // 窗口结束 ask 工具仍 running：远端悬停在提问上，但批次不可桥接 ——
    // 实测形态：批次被浏览器应答器持走 / waterfall 归属失败（/questions count=0）或节点过旧（无路由）。
    // 此时答复桥触达不了，唯一可靠杠杆是 cancelSession 中止悬停回合（公司笔记本节点实测 running→idle）。
    if (streamCtrl.signal.aborted || !this.askToolStillRunning(taskId, turnId)) return
    askWatch.fired = true
    askWatch.mode = 'unbridged'
    streamCtrl.abort()
  }

  /** ask 工具是否仍处于 running（未收到 tool_result） */
  private askToolStillRunning(taskId: string, turnId: string): boolean {
    const t = this.store.getTask(taskId)?.turns.find((x) => x.id === turnId)
    const ask = [...(t?.tools || [])].reverse().find((x) => x.name === 'ask_user_question' || x.name === 'ask-user-question')
    return ask?.status === 'running'
  }

  /** 从 ask 工具 args 提取人类可读的问题摘要（供不可桥接悬停时的系统提示） */
  private summarizeAskQuestions(taskId: string, turnId: string): string {
    const t = this.store.getTask(taskId)?.turns.find((x) => x.id === turnId)
    const ask = [...(t?.tools || [])].reverse().find((x) => x.name === 'ask_user_question' || x.name === 'ask-user-question')
    try {
      const parsed = JSON.parse(ask?.args || '{}')
      const qs = Array.isArray(parsed?.questions) ? parsed.questions : []
      const lines = qs.map((q: any) => {
        const opts = Array.isArray(q.options) ? q.options.map((o: any) => o?.label).filter(Boolean).join('/') : ''
        return `· ${q?.header ? q.header + '：' : ''}${q?.question || q?.id || ''}${opts ? `（选项：${opts}）` : ''}`
      })
      return lines.join('\n').slice(0, 600)
    } catch {
      return (ask?.args || '').slice(0, 400)
    }
  }

  /**
   * 不可桥接悬停的收尾：表面化问题内容 + 中止远端悬停回合（会话转 idle），
   * 用户下一条消息作为新指令直接执行（会话已空闲，不再排队在悬停 run 后面）。
   */
  private async finalizeUnbridgedAskTurn(
    taskId: string,
    turnId: string,
    agent: { name: string },
    target: DshTarget,
    sessionId: string,
  ): Promise<void> {
    const questionText = this.summarizeAskQuestions(taskId, turnId)
    this.store.updateTurn(taskId, turnId, (tt) => {
      tt.streaming = false
      for (const t of tt.tools || []) {
        if (t.status !== 'running') continue
        t.status = 'error'
        t.result = t.name === 'ask_user_question' || t.name === 'ask-user-question'
          ? '⚠️ 提问未接入答复桥（远端批次不可见），悬停回合已中止——请直接回复你的选择作为新指令'
          : '⚠️ 远端回合挂起等待用户答复，本工具结果未知'
      }
    })
    const finalTurn = this.store.getTask(taskId)?.turns.find((x) => x.id === turnId)
    if (finalTurn) this.emit(taskId, { type: 'turn_end', turn: finalTurn })
    this.appendSystemTurn(taskId,
      `🔔 远端助手发起过提问，但该提问未接入答复桥，已中止悬停回合（会话已就绪）。\n提问内容：\n${questionText}\n—— 请把你的选择/答案直接作为新消息发送，将作为新指令继续执行。`)
    this.taskLog(taskId, 'warn', `ask 提问不可桥接（批次不可见），已中止 ${agent.name} 的悬停回合`)
    await this.client.cancelSession(target, sessionId).catch(() => {})
  }

  /** 挂起等待的回合收尾：streaming=false；ask 工具保持 running（答复卡/答复桥依赖），其余 running 工具落 error */
  private finalizeWaitingAskTurn(taskId: string, turnId: string, agent: { name: string }): void {
    this.store.updateTurn(taskId, turnId, (tt) => {
      tt.streaming = false
      for (const t of tt.tools || []) {
        if (t.status !== 'running') continue
        if (t.name === 'ask_user_question' || t.name === 'ask-user-question') {
          if (!t.result) t.result = '⏳ 等待用户答复（回复即答复）'
        } else {
          t.status = 'error'
          t.result = '⚠️ 远端回合挂起等待用户答复，本工具结果未知'
        }
      }
    })
    const finalTurn = this.store.getTask(taskId)?.turns.find((x) => x.id === turnId)
    if (finalTurn) this.emit(taskId, { type: 'turn_end', turn: finalTurn })
    this.appendSystemTurn(taskId, TaskEngine.ASK_WAIT_HINT)
    this.taskLog(taskId, 'warn', `远端会话被 ask_user_question 挂起，回合已收尾等待答复（${agent.name}）`)
  }

  /**
   * 派发前的挂起预检 + 自由文本答复桥：会话有挂起提问时，用户消息按 custom 答复提交 /answers
   * 解锁挂起的 run，然后追踪续跑（轮询状态 + 挂起重查 + history 对账），全程不发新 prompt。
   * 返回 true = 已按答复桥处理（调用方直接 return）；false = 无挂起/桥不可用，走常规派发。
   */
  private async answerPendingAndResume(
    taskId: string,
    text: string,
    agent: SubAgent | { name: string; id: string },
    target: DshTarget,
    sessionId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const pq = await this.client.listPendingQuestions(target, sessionId).catch(() => undefined)
    if (!pq?.ok || !pq.supported || !(pq.count || 0)) return false
    const questions = (pq.batches || []).flatMap((b) => b.questions || [])
    const answers = questions.filter((q) => q?.id).map((q) => ({ id: String(q.id), selected: [] as string[], custom: text }))
    if (!answers.length) {
      this.appendSystemTurn(taskId, '⚠️ 远端会话有挂起提问但问题缺少 id，无法桥接答复；请到 web 端问题卡片作答，或停止后重试')
      return false
    }
    const r = await this.client.answerQuestion(target, sessionId, answers)
    if (!r.ok) {
      // 批次已消失（竞态：远端刚自行解挂/被取消）→ 回常规派发；真失败 → 明确告警后仍回常规派发（S6 兜底快速失败）
      this.taskLog(taskId, 'warn', `答复桥提交失败（${r.error}），转常规派发`)
      return false
    }

    // 已记录的挂起 ask 工具落 done（前端交互卡随任务刷新关闭）
    const task0 = this.store.getTask(taskId)
    if (task0?.pendingAsk) {
      this.store.updateTurn(taskId, task0.pendingAsk.turnId, (tt) => {
        const t = [...(tt.tools || [])].reverse().find((x) => (x.name === 'ask_user_question' || x.name === 'ask-user-question') && x.status === 'running')
        if (t) {
          t.status = 'done'
          t.result = '✅ 已答复: ' + text.slice(0, 500)
        }
      })
      this.store.mutateTask(taskId, (t) => { delete t.pendingAsk })
    }
    this.appendSystemTurn(taskId, `📨 已把你的消息作为答复提交给挂起的提问（${answers.length} 题），远端回合恢复执行，正在追踪续跑…`)
    this.taskLog(taskId, 'info', `答复已提交（${agent.name} · ${answers.length} 题），追踪续跑`)

    // 续跑追踪回合：远端 run 从挂起点继续，产出不再经过新 prompt —— 轮询状态直至非 running，
    // 期间再次挂起（连环提问）按等待语义收尾；stop 可中止。
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

    // 追踪上限与远端 prompt 超时同窗（30min）：真实无人/有人大任务恢复后可能继续跑工具数十分钟
    const deadline = Date.now() + 30 * 60_000
    let pendingAgain = false
    let ran = false
    while (Date.now() < deadline && !signal.aborted) {
      await new Promise((res) => setTimeout(res, 5_000))
      if (signal.aborted) break
      const pq2 = await this.client.listPendingQuestions(target, sessionId).catch(() => undefined)
      if (pq2?.ok && pq2.supported && (pq2.count || 0) > 0) {
        pendingAgain = true
        break
      }
      const st = await this.client.getSession(target, sessionId).catch(() => undefined)
      if (!st?.ok) continue
      if (st.status && st.status !== 'running') { ran = true; break }
      ran = true
    }

    if (signal.aborted) {
      this.store.updateTurn(taskId, turn.id, (tt) => { tt.streaming = false })
      const finalTurn = this.store.getTask(taskId)?.turns.find((x) => x.id === turn.id)
      if (finalTurn) this.emit(taskId, { type: 'turn_end', turn: finalTurn })
      this.appendSystemTurn(taskId, `⏹ 已停止 — ${agent.name} 的续跑追踪已中止（远端可能仍在执行）`)
      this.store.mutateTask(taskId, (t) => { t.status = 'cancelled' })
      this.emit(taskId, { type: 'task_status', status: 'cancelled' })
      return true
    }

    if (pendingAgain) {
      const pq3 = await this.client.listPendingQuestions(target, sessionId).catch(() => undefined)
      const questions = (pq3?.batches || []).flatMap((b) => b.questions || [])
      this.store.mutateTask(taskId, (t) => {
        t.pendingAsk = { agentId: agent.id, sessionId, batchId: pq3?.batches?.[0]?.batchId, questions, turnId: turn.id, at: Date.now() }
      })
      this.finalizeWaitingAskTurn(taskId, turn.id, agent)
      this.store.mutateTask(taskId, (t) => { t.status = 'completed' })
      this.emit(taskId, { type: 'task_status', status: 'completed' })
      return true
    }

    // 对账整轮：挂起 run 恢复后的产出在其原回合内，从 history 取最后一条助手回复
    const reconciled = await this.client.reconcileTurn(target, sessionId, turnFragment(text), { signal }).catch(() => undefined)
    this.taskLog(taskId, reconciled?.ok ? 'info' : 'warn',
      `续跑对账${reconciled?.ok ? `成功（${String(reconciled.content || '').length} 字）` : `未取到内容: ${reconciled?.error || '调用异常'}`}`)
    this.store.updateTurn(taskId, turn.id, (tt) => {
      tt.streaming = false
      if (reconciled?.ok && reconciled.content) tt.text = reconciled.content
      else if (!ran) tt.text = '（远端续跑仍在执行，本轮追踪已达 30 分钟上限 —— 稍后发任意消息即可查询进度并取回结果）'
      else tt.text = tt.text || '（远端续跑已结束，未返回新内容）'
      if (reconciled?.usage && typeof reconciled.usage === 'object') tt.usage = { ...reconciled.usage }
    })
    const finalTurn = this.store.getTask(taskId)?.turns.find((x) => x.id === turn.id)
    if (finalTurn) this.emit(taskId, { type: 'turn_end', turn: finalTurn })
    this.store.mutateTask(taskId, (t) => { t.status = 'completed' })
    this.emit(taskId, { type: 'task_status', status: 'completed' })
    return true
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
    // 成员解析：子智能体实体优先，expert-<expertId> 伪 id 解析为任务级临时专家（@单专家直派）
    const agent = await this.resolveMemberAgent(this.store.getTask(taskId)!, agentId)
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

    // 专家团任务：团队合同注入规划与派工（teamId 失效时按普通编排降级并记录）
    const team = task.teamId ? this.store.getTeam(task.teamId) : undefined
    if (task.teamId && !team) this.taskLog(taskId, 'warn', `专家团 ${task.teamId} 已不存在，本次按普通编排执行`)

    // 1. 花名册（资源摘要用轻量解析，不抓技能全文）：
    //    子智能体成员 + 专家库动态成员（expert-<expertId> 伪 id，persona 在派工时按档案展开）
    const agentById = new Map<string, SubAgent>()
    for (const a of this.store.getAgents()) agentById.set(a.id, a)
    for (const em of task.expertMembers || []) {
      const expertAgent = await this.resolveMemberAgent(task, em.id)
      if (expertAgent) agentById.set(expertAgent.id, expertAgent)
      else this.taskLog(taskId, 'warn', `专家成员「${em.name}」档案不可用，已从规划花名册剔除`)
    }
    const rosterKeys = [...task.memberAgentIds, ...(task.expertMembers || []).map((m) => m.id)]
    const rosterMembers = rosterKeys
      .map((id) => agentById.get(id))
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

    let planned: Awaited<ReturnType<Orchestrator['planTask']>>
    try {
      // 规划在任务发起节点（主 DSH）执行 —— 节点模型下无需单独指定拆解器智能体；不可达时回退 pickTarget 链
      const execForPlan = this.taskExec(task)
      const planNodeTarget = execForPlan.dshRef
        ? await this.resolver.resolveRef(execForPlan.dshRef, execForPlan.apiKey, 'planner').catch(() => undefined)
        : undefined
      planned = await this.planner.planTask(text, rosterMembers, targets, {
        priorityAgentIds: mentions.mentionedAgentIds,
        taskNodeTarget: planNodeTarget && planNodeTarget.online && planNodeTarget.baseUrl ? planNodeTarget : undefined,
        ...(team ? { team, nameOf: (key: string) => this.memberNameOf(task, key) } : {}),
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
      draft = Orchestrator.fallbackPlan(text, rosterMembers)
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
        ...(s.objective ? { objective: s.objective } : {}),
        ...(s.acceptance?.length ? { acceptance: s.acceptance } : {}),
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
    const summary = await this.planner.summarize(text, fresh.plan?.subtasks || [], targets, summaryNodeTarget, team ? { team, nameOf: (key: string) => this.memberNameOf(fresh, key) } : undefined)
    this.store.mutateTask(taskId, (t) => {
      t.summary = summary
      t.status = summary.status
    })
    this.emit(taskId, { type: 'task_status', status: summary.status })
    // 成员覆盖度并入汇总文本（移植 dsh-agency-agents coverage 语义：返回覆盖 ≠ 验收通过）
    const cov = summary.coverage
    const coverageText = cov && cov.total > 0
      ? `\n\n📋 成员覆盖度: ${cov.status === 'complete' ? '全部覆盖' : cov.status === 'partial' ? '部分覆盖' : '无有效产出'}（${cov.completed}/${cov.total}）` +
        (cov.missing.length ? `\n${cov.missing.map((m) => `- ${m.name}${m.duty ? `（${m.duty}）` : ''}: ${m.error || '未返回'}`).join('\n')}` : '')
      : ''
    const summaryTurn: TaskTurn = {
      id: `turn-${randomUUID().slice(0, 8)}`,
      seq: 0,
      role: 'agent',
      agentId: '__planner__',
      agentName: '🎯 总调度汇总',
      text: summary.finalConclusion + coverageText,
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
    // 成员解析：子智能体实体优先，expert-<expertId> 伪 id 解析为任务级临时专家
    const agent = await this.resolveMemberAgent(task, sub.agentId)
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

    // 上游产出摘要（预算截断 + 中和伪造段头，逻辑在 orchestrator.buildUpstreamDigests）
    const upstream = buildUpstreamDigests(task.plan?.subtasks, sub.dependsOn)
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
    let activeSession = session
    const subLog = (msg: string, level: SubtaskLogEntry['level'] = 'info'): void => {
      this.store.mutateSubtask(taskId, sub.id, (s) => {
        s.logs.push({ ts: Date.now(), level, msg })
      })
      this.emit(taskId, { type: 'log', subtaskId: sub.id, level, msg })
    }
    subLog(`远程会话${session.reused ? '复用' : '新建'} ${session.remoteSessionId} @ ${target.baseUrl}`)

    const transformed = await this.transformFileMentionsForAgent(sub.prompt, mentions, agent, task)

    const parts: string[] = []
    // 远程会话创建接口不收 systemPrompt，聊天直发路径靠 sysPrefix 注入角色；编排/直派子任务在此对等注入，
    // 否则执行者拿不到自己的角色定义，只能靠子任务指令自猜身份。
    // 专家人格（expertPersona）：角色声明 + 职责约束（systemPrompt）+ 执行指导（executionPrompt）。
    parts.push(`[执行者角色]（你的身份、职责与约束）:\n${expertPersona(agent)}`)
    // 专家团合同段（移植 dsh-agency-agents executeTeam 成员提示词结构）：共同目标/约束/交付要求 +
    // 全员职责边界 + 自己的分工与执行指示 + 五段回传格式；紧跟执行者角色，先于任务合同。
    const team = task.teamId ? this.store.getTeam(task.teamId) : undefined
    const teamMember = team?.members.find((m) => teamMemberKey(m) === agent.id)
    if (team && teamMember) {
      parts.push(teamMemberContract(team, teamMember, (key) => this.memberNameOf(task, key)))
    }
    const hasDynamicResources = (extraResources && extraResources.length > 0) || (mentions?.mentionedFiles && mentions.mentionedFiles.length > 0)
    const cachedBlock = hasDynamicResources ? null : this.blockCacheFresh(taskId, agent, 'unattended')

    if (!cachedBlock) {
      const composed = await this.composer.compose(agent, {
        resolvedAt: Date.now(),
        extraResources: [...exec.extraBindings, ...extraResources],
        extraSkills: exec.skills,
        interaction: 'unattended',
      })
      const block = composed.block
      if (!hasDynamicResources) this.blockCache.set(this.blockCacheKey(taskId, agent, 'unattended'), { block, at: Date.now() })
      if (block) parts.push(block)
      for (const w of composed.warnings) this.emit(taskId, { type: 'log', subtaskId: sub.id, level: 'warn', msg: w })
    } else if (cachedBlock.block) {
      parts.push(cachedBlock.block)
    }
    if (transformed.extraSections.length > 0) {
      parts.push(transformed.extraSections.join('\n\n'))
    }
    // 上游产出注入（防注入声明在 orchestrator.buildUpstreamSection）
    const upstreamSection = buildUpstreamSection(upstream)
    if (upstreamSection) parts.push(upstreamSection)
    // 任务合同（移植 dsh-agent-teams assignmentPrompt 契约结构）：目标 + 验收标准，执行者须逐条对照
    const contract = buildTaskContract(sub)
    if (contract) parts.push(contract)
    // 运行权限：原生接口已生效则不注入；旧版节点降级为提示词声明
    const permLine = this.permissionPromptLine(this.store.getTask(taskId) || task, agent)
    if (permLine) parts.push(permLine)
    // 规划器可能把用户素材原样抄进子任务指令：中和其中伪造的引擎段头与围栏（orchestrator.sanitizeEngineInstruction）
    const instr = sanitizeEngineInstruction(transformed.text, agent)
    parts.push(`[当前子任务指令]:\n${instr}`)
    parts.push(buildCompletionRequirement(sub))
    const fullPrompt = parts.join('\n\n')

    let deltaCount = 0
    const dispatchStartedAt = Date.now()
    let firstDeltaLogged = false
    // 派发处理器抽为工厂：模型回退重试时重置计数器后复用同一组回调
    const makeHandlers = (): Parameters<DshClient['streamPrompt']>[3] => ({
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
    })
    let result = await this.dispatchWithFallback(target, activeSession.remoteSessionId!, fullPrompt, makeHandlers(), signal)

    // 模型回退自愈：sub agent 自带 provider/model 首轮零产出（含对账后 ok=true 但整轮无文本——
    // 远端轮次 error 结束时对账也拿不到内容）→ 丢弃该会话，按调度模型重建重试一次。
    // 路由语义不变，只换执行模型；有部分产出或已中止不重试。
    let fellBackToDefault = false
    const firstRoundEmpty = !(result.content && result.content.trim())
    const plannerModel = String(task.model || this.store.getSettings().planner?.model || '').trim() || undefined
    if (firstRoundEmpty && !signal.aborted && (agent.provider || agent.model)) {
      const ownModel = `${agent.provider || '(默认)'}/${agent.model || '(默认)'}`
      this.store.mutateTask(taskId, (t) => { delete t.sessions[agent.id] })
      this.store.mutateSubtask(taskId, sub.id, (s) => { s.result = undefined })
      const retried = await this.ensureSession(taskId, agent, target, { cwd: exec.workspace, workspace: exec.workspace, modelOverride: 'default' })
      if (retried.target) target = retried.target
      if (retried.ok && retried.remoteSessionId) {
        activeSession = retried
        deltaCount = 0
        firstDeltaLogged = false
        fellBackToDefault = true
        subLog(`首轮无产出（${ownModel} 上游可能不可用），已按调度模型${plannerModel ? `「${plannerModel}」` : '（节点默认）'}回退重试`)
        result = await this.dispatchWithFallback(target, retried.remoteSessionId, fullPrompt, makeHandlers(), signal)
      }
    }
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
        const baseErr = result.error || (result.content ? '' : '远程节点返回空回答（Provider/Model 可能不可用）')
        s.error = fellBackToDefault
          ? `${baseErr}（${agent.provider || '(默认)'}/${agent.model || '(默认)'} 与节点默认模型均无产出）`
          : baseErr
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
    // 仅占位标题需要回填；显式指定的短标题（含创建时截断的短消息）是用户可见的真实输入，不覆盖
    return task.title.startsWith('新任务') || task.title.startsWith('未命名任务')
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
    // sub agent：自身绑定节点优先（远程执行单元本义）
    const agent = this.store.getAgent(agentId)
    if (agent) {
      const own = await this.resolver.resolve(agent).catch(() => undefined)
      if (own?.online && own.baseUrl) return own
    }
    // 节点主会话（__node__，无 store 记录）或自身节点不可达：按任务/项目节点解析
    const exec = task ? this.taskExec(task) : undefined
    if (exec?.dshRef) {
      const nt = await this.resolver.resolveRef(exec.dshRef, exec.apiKey, agentId).catch(() => undefined)
      if (nt?.online && nt.baseUrl) return nt
    }
    return undefined
  }

  /**
   * 任务级运行权限变更后立即下发：遍历任务已绑定的全部远端会话，经原生接口切换。
   * 未建会话的成员无需处理——下一次 ensureSession 建会话时自动按期望权限下发。
   */
  public async applyTaskPermission(taskId: string): Promise<Array<{ agentId: string; ok: boolean; preset?: string; error?: string }>> {
    const task = this.store.getTask(taskId)
    if (!task) return []
    const out: Array<{ agentId: string; ok: boolean; preset?: string; error?: string }> = []
    for (const [agentId, binding] of Object.entries(task.sessions || {})) {
      if (!binding?.remoteSessionId) continue
      const agent = this.store.getAgent(agentId) ?? (agentId === NODE_AGENT_ID ? this.makeNodeAgent(this.taskExec(task)) : undefined)
      if (!agent) continue
      const target = await this.resolveExecTarget(task, agentId)
      if (!target) { out.push({ agentId, ok: false, error: '节点不可达' }); continue }
      const want = this.desiredPermission(task, agent)
      const r = await this.client.setSessionPermission(target, binding.remoteSessionId, want)
      if (r.ok) {
        this.store.mutateTask(taskId, (t) => {
          const b = t.sessions[agentId]
          if (b && b.remoteSessionId === binding.remoteSessionId) b.permission = want
        })
        this.taskLog(taskId, 'info', `运行权限已原生切换（${agent.name}）: ${r.preset || want}` + (r.sandbox ? ` · sandbox=${r.sandbox}` : ''))
        out.push({ agentId, ok: true, preset: r.preset || want })
      } else {
        // 失败/不支持：清除已下发标记，下一轮派发走提示词降级兜底
        this.store.mutateTask(taskId, (t) => { const b = t.sessions[agentId]; if (b) delete b.permission })
        out.push({ agentId, ok: false, error: r.error })
      }
    }
    return out
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

  // ---------- 专家团专家成员（动态实例化，移植 dsh-agency-agents spawnTeammate 语义） ----------

  /**
   * 任务级临时专家执行者：persona = 专家档案提示词，绑定任务发起节点（主 DSH），
   * 不落子智能体实体（用完即散，对齐插件「成员不持久化」的边界）。
   */
  private makeExpertAgent(task: WorkTask, profile: ExpertProfile): SubAgent {
    const exec = this.taskExec(task)
    return {
      id: EXPERT_AGENT_ID_PREFIX + profile.id,
      name: profile.name,
      dshRef: exec.dshRef || { kind: 'direct', apiBaseUrl: '' },
      role: profile.role?.trim() || profile.description,
      systemPrompt: profile.systemPrompt,
      executionPrompt: profile.executionPrompt,
      description: profile.description,
      resources: [],
      skills: [],
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    }
  }

  /**
   * 成员解析：子智能体实体优先；expert-<expertId> 伪 id 解析为任务级临时专家。
   * 仅当该 id 已登记在 task.expertMembers 时才实例化（防止伪 id 撞名真实智能体被误解析）。
   */
  private async resolveMemberAgent(task: WorkTask, id: string): Promise<SubAgent | undefined> {
    const direct = this.store.getAgent(id)
    if (direct) return direct
    if (!id.startsWith(EXPERT_AGENT_ID_PREFIX) || !task.expertMembers?.some((m) => m.id === id)) return undefined
    const expertId = id.slice(EXPERT_AGENT_ID_PREFIX.length)
    const profile = await this.experts?.getProfile(expertId).catch(() => undefined)
    if (!profile) return undefined
    return this.makeExpertAgent(task, profile)
  }

  /**
   * 专家动态成员的执行节点：任务发起节点优先；
   * 任务未绑定节点（团队卡「发任务」/普通会话 @专家）时回退规划器主智能体的节点——
   * 纯专家场景没有自带节点的 agent 成员，无回退会因 targets 为空而失败。
   */
  private async resolveExpertNodeTarget(task: WorkTask, taskId?: string): Promise<ResolvedDshTarget | undefined> {
    const exec = this.taskExec(task)
    if (exec.dshRef) {
      const nt = await this.resolver.resolveRef(exec.dshRef, exec.apiKey, '__expert__').catch(() => undefined)
      if (nt?.online && nt.baseUrl) return nt
    }
    const fallback = await this.planner.pickTarget().catch(() => ({ error: '无可用节点' }) as { error: string })
    if (!('error' in fallback) && fallback.target?.baseUrl) {
      if (taskId) this.taskLog(taskId, 'info', `任务未绑定节点，专家成员回退到主调度节点（${fallback.source}）执行`)
      return {
        baseUrl: fallback.target.baseUrl,
        ...(fallback.target.apiKey ? { apiKey: fallback.target.apiKey } : {}),
        agentId: fallback.agent?.id || '__expert__',
        resolvedAt: Date.now(),
        online: true,
      }
    }
    return undefined
  }

  /** 成员展示名（花名册/派工/汇总/前端兜底共用）：子智能体名 → 专家动态成员名 → 键本身 */
  private memberNameOf(task: WorkTask, key: string): string {
    return this.store.getAgent(key)?.name || task.expertMembers?.find((m) => m.id === key)?.name || key
  }

  /**
   * 团队名册展开：agentId 成员校验存在（缺失仅告警跳过），expertId 成员经专家库解析展示名。
   * 供 createTask（团队任务）与消息级 @团队（固化团队语义）共用。
   */
  private async expandTeamRoster(team: ExpertTeam, taskId?: string): Promise<{ agentIds: string[]; expertMembers: Array<{ id: string; name: string }>; issues: string[] }> {
    const agentIds: string[] = []
    const expertMembers: Array<{ id: string; name: string }> = []
    const issues: string[] = []
    for (const m of team.members) {
      if (m.agentId) {
        const agent = this.store.getAgent(m.agentId)
        if (!agent || agent.enabled === false) {
          issues.push(`成员子智能体「${agent?.name || m.agentId}」不存在或已停用`)
          continue
        }
        agentIds.push(m.agentId)
      } else if (m.expertId) {
        const expert = await this.experts?.get(m.expertId).catch(() => undefined)
        if (!expert) {
          issues.push(`专家库角色「${m.expertId}」不存在（专家资产缺失？）`)
          continue
        }
        expertMembers.push({ id: teamMemberKey(m), name: expert.name })
      }
    }
    if (taskId) {
      for (const issue of issues) this.taskLog(taskId, 'warn', `专家团「${team.name}」${issue}`)
    }
    return { agentIds, expertMembers, issues }
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

    /** 在目标节点逐级创建目录（mkdir -p 语义）；已存在的层级静默跳过；任一级失败返回 false */
    private async ensureRemoteDir(target: DshTarget, absPath: string): Promise<boolean> {
      if (!absPath.startsWith('/')) return false
      const parts = absPath.split('/').filter(Boolean)
      let cur = ''
      for (const p of parts) {
        const parent = cur || '/'
        cur = cur + '/' + p
        const r = await this.client.fsMkdir(target, parent, p).catch(() => ({ ok: false, error: 'mkdir 异常' }))
        if (!r.ok && !/exist|已存在|EEXIST/i.test(r.error || '')) return false
      }
      return true
    }

    private async ensureSession(taskId: string, agent: SubAgent, target: DshTarget, opts?: { cwd?: string; workspace?: string; modelOverride?: 'default' }): Promise<{ ok: boolean; remoteSessionId?: string; reused?: boolean; error?: string; target?: DshTarget }> {
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
    // 任务级模型（定时任务实例配置）优先于全局调度模型（模型按钮）
    const plannerModelSetting = String(task.model || settings.planner?.model || '').trim() || undefined

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
        if (st.ok) {
          await this.syncSessionPermission(taskId, agent, target, existing.remoteSessionId)
          return { ok: true, remoteSessionId: existing.remoteSessionId, reused: true, target }
        }
        // 远端会话已丢失（重启/清理），重建
        this.taskLog(taskId, 'warn', `远端会话丢失（${agent.name}），正在重建: ${existing.remoteSessionId}`)
      }
    }

    // 若为主智能体且配置了主调度模型，优先采用该模型作为远端会话创建参数
    let targetProvider = agent.provider
    let targetModel = agent.model
    if (opts?.modelOverride === 'default') {
      // 模型回退自愈（runSubtask）：agent 自带模型上游失败后重建会话。
      // 回退目标 = 调度模型（任务级/全局 planner 选中值）——不是「不带模型」：节点默认模型
      // 本身也可能就是坏的（实测 KB136 defaultModel 指向不可用的 qwen38）。调度模型也空时才用节点默认。
      const pm = plannerModelSetting || ''
      const slash = pm.indexOf('/')
      targetProvider = slash >= 0 ? pm.slice(0, slash).trim() || undefined : undefined
      targetModel = slash >= 0 ? pm.slice(slash + 1).trim() : (pm.trim() || undefined)
    } else if (isMain && plannerModelSetting) {
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
      // 模式预设优先级：任务级（聊天窗切换持久化）> 智能体实体 > 远端默认 cordis
      agentPreset: task.agentPreset || agent.agentPreset,
      provider: targetProvider,
      model: targetModel,
      reasoningEffort: task.reasoningEffort,
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
    // 自愈 2：工作目录在目标节点不存在（ENOENT mkdir）→ 先逐级创建（mkdir -p 语义，
    // 项目 workspace / 智能体 workDir 绑定的目录由此保证存在），再按原目录重建会话；
    // 创建失败才回退远端默认目录，并在任务日志注明
    let cwdFellBack = false
    if (!res.ok && res.error && /ensure project directory|ENOENT/i.test(res.error) && (workspaceId || wantedCwd)) {
      if (wantedCwd && wantedCwd.startsWith('/')) {
        const created = await this.ensureRemoteDir(effTarget, wantedCwd)
        if (created) {
          this.taskLog(taskId, 'info', `工作目录 ${wantedCwd} 在目标节点不存在，已自动创建，按原目录重建会话`)
          res = await this.client.createSession(effTarget, `[WorkBuddy] ${task.title}`, createPayload)
        }
      }
      if (!res.ok && res.error && /ensure project directory|ENOENT/i.test(res.error)) {
        this.taskLog(taskId, 'warn', `工作目录 ${wantedCwd || '(workspace)'} 无法自动创建，已回退远端默认目录重建会话`)
        cwdFellBack = true
        const fallbackPayload = { agentPreset: task.agentPreset || agent.agentPreset, provider: targetProvider, model: targetModel, reasoningEffort: task.reasoningEffort }
        res = await this.client.createSession(effTarget, `[WorkBuddy] ${task.title}`, fallbackPayload)
      }
    }
    // 自愈 3：瞬时失败退避重试（ONENAT 隧道抖动/串端口——无 /root 的机器瞬移、远端重启窗口、5xx）
    if (!res.ok && res.error && /ENOENT|ECONN|EPIPE|EHOST|fetch failed|terminated|HTTP 5\d\d|timed? ?out/i.test(res.error)) {
      this.taskLog(taskId, 'info', `创建会话瞬时失败（${res.error.slice(0, 80)}），1.5s 后自动重试一次`)
      await new Promise((r) => setTimeout(r, 1500))
      res = await this.client.createSession(effTarget, `[WorkBuddy] ${task.title}`, createPayload)
      // 若瞬时失败源于目录（重试带目录又 ENOENT），先尝试创建目录，失败再回退
      if (!res.ok && res.error && /ensure project directory|ENOENT/i.test(res.error) && (workspaceId || wantedCwd) && !cwdFellBack) {
        if (wantedCwd && wantedCwd.startsWith('/')) {
          const created = await this.ensureRemoteDir(effTarget, wantedCwd)
          if (created) {
            this.taskLog(taskId, 'info', `工作目录 ${wantedCwd} 在目标节点不存在，已自动创建，按原目录重建会话`)
            res = await this.client.createSession(effTarget, `[WorkBuddy] ${task.title}`, createPayload)
          }
        }
        if (!res.ok && res.error && /ensure project directory|ENOENT/i.test(res.error)) {
          cwdFellBack = true
          const fallbackPayload = { agentPreset: task.agentPreset || agent.agentPreset, provider: targetProvider, model: targetModel, reasoningEffort: task.reasoningEffort }
          res = await this.client.createSession(effTarget, `[WorkBuddy] ${task.title}`, fallbackPayload)
        }
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
    await this.syncSessionPermission(taskId, agent, effTarget, res.sessionId)
    return { ok: true, remoteSessionId: res.sessionId, reused: false, target: effTarget }
  }

  /** 期望运行权限：任务级 > 智能体实体 > 默认全部权限 */
  private desiredPermission(task: WorkTask, agent: SubAgent): string {
    return (task.permission || agent.permission || DEFAULT_PERMISSION).trim() || DEFAULT_PERMISSION
  }

  /** 节点是否不支持原生权限接口（旧版 dsh-web-service）；按 baseUrl 缓存，避免每轮重复探测 */
  private permissionUnsupported = new Map<string, number>()

  /**
   * 运行权限原生下发：PUT /sessions/:id/permission（harness permissionPresets，真实切换沙箱+审批）。
   * 已下发且与期望一致时跳过；节点不支持时记录并降级为提示词注入（见 permissionPromptLine）。
   */
  private async syncSessionPermission(taskId: string, agent: SubAgent, target: DshTarget, remoteSessionId: string): Promise<void> {
    const task = this.store.getTask(taskId)
    if (!task) return
    const want = this.desiredPermission(task, agent)
    const binding = task.sessions[agent.id]
    if (binding?.remoteSessionId === remoteSessionId && binding.permission === want) return
    const base = target.baseUrl.replace(/\/+$/, '')
    const unsupportedAt = this.permissionUnsupported.get(base)
    if (unsupportedAt && Date.now() - unsupportedAt < 10 * 60_000) return
    const r = await this.client.setSessionPermission(target, remoteSessionId, want)
    if (r.ok) {
      this.permissionUnsupported.delete(base)
      this.store.mutateTask(taskId, (t) => {
        const b = t.sessions[agent.id]
        if (b && b.remoteSessionId === remoteSessionId) b.permission = want
      })
      this.taskLog(taskId, 'info', `运行权限已原生生效（${agent.name}）: ${r.preset || want}` + (r.sandbox ? ` · sandbox=${r.sandbox}` : '') + (r.approval ? ` · approval=${r.approval}` : ''))
    } else if (!r.supported) {
      this.permissionUnsupported.set(base, Date.now())
      this.taskLog(taskId, 'warn', `远端节点不支持原生运行权限接口（${agent.name}）：${r.error}；已降级为提示词声明，请升级该节点 dsh-web-service ≥ 0.3.1`)
    } else {
      this.taskLog(taskId, 'warn', `运行权限下发失败（${agent.name}）: ${r.error}`)
    }
  }

  /**
   * 仅在原生下发未生效时才把权限写进提示词（降级兜底）；原生已生效则不再注入上下文。
   */
  private permissionPromptLine(task: WorkTask, agent: SubAgent): string {
    const want = this.desiredPermission(task, agent)
    const b = task.sessions[agent.id]
    if (b?.permission === want) return ''
    return `[运行权限]: ${want}`
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
      // 挂起防御：远端被 ask_user_question 挂起时会话状态恒为 running，下面的轮询只会空转满额超时
      // （实测表现 = 静默 10min + 对账 30min 的假 running）。先查一次挂起批次，命中立即快速失败。
      const parked = await this.client.listPendingQuestions(target, sessionId).catch(() => undefined)
      if (parked?.ok && (parked.count || 0) > 0) {
        handlers.onLog?.('远端会话被提问挂起（pending ask），不转入长轮询 —— 等待答复桥解锁', 'warn')
        return { ok: false, content: sse.content, reasoning: sse.reasoning, complete: false, error: '远端会话挂起等待提问答复', pendingAsk: true }
      }
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
  /**
   * App「AI 控制台」模型透传：服务端持节点凭证，App 只需登录会话。
   * 目标节点 = 默认主智能体绑定节点（与任务派发同源）；tools 由 App 经 MCP tools/list 获取后透传。
   */
  public async consoleChat(input: {
    messages: Array<Record<string, any>>
    tools?: Array<Record<string, any>>
    model?: string
  }): Promise<{ ok: boolean; message?: Record<string, any>; node?: string; error?: string }> {
    const messages = Array.isArray(input.messages) ? input.messages : []
    if (!messages.length) return { ok: false, error: '缺少 messages' }
    const mainId = this.defaultMemberAgentIds()[0]
    const agent = mainId ? this.store.getAgent(mainId) : undefined
    if (!agent) return { ok: false, error: '没有可用的主智能体（先在「子智能体」页创建）' }
    const target = await this.resolver.resolve(agent)
    if (!target || !target.online || !target.baseUrl) {
      return { ok: false, error: (target as any)?.error || '主智能体节点当前不可达' }
    }
    const r = await this.client.chatWithTools(
      target,
      messages,
      Array.isArray(input.tools) ? input.tools : [],
      { model: input.model?.trim() || undefined, timeoutMs: 120_000 },
    )
    if (!r.ok) return { ok: false, error: r.error || '节点模型调用失败', node: target.baseUrl }
    return { ok: true, message: r.message, node: target.baseUrl }
  }

  public attachmentTargetAgentIds(task: WorkTask): string[] {
    // 专家团专家成员（expert-<expertId> 伪 id）同样接收附件投递（会话建在任务节点，工作区同源）
    const members = [...(task.memberAgentIds || []).filter((id) => Boolean(id)), ...(task.expertMembers || []).map((m) => m.id)]
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
    // 项目任务且配置了项目工作区：附件统一落到「项目节点 + 项目工作区」（走主会话通道），
    // 不投成员自身节点（成员 workDir 在别的机器上，投过去 [附件] 路径与会话工作区对不上，读不到）
    const exec = this.taskExec(task)
    const projectWs = exec.workspace?.trim() || ''
    const targetIds = exec.dshRef && projectWs ? [NODE_AGENT_ID] : this.attachmentTargetAgentIds(task)
    const { targets } = await this.resolver.resolveMembers(targetIds)
    // 成员并行分发（串行时多成员 × 隧道延迟叠加，客户端 100% 后长时间无响应）
    const results: Array<{ agentId: string; agentName: string; ok: boolean; error?: string; files?: Array<{ name: string; path: string; size: number }> }> = await Promise.all(
      targetIds.map(async (agentId) => {
        // 节点直发任务（无成员）目标为伪成员 __node__：store 无记录，用节点伪实体兜底，
        // 否则 getAgent 返回 undefined → 整个上传被误判「节点不可用」静默丢弃（附件只留下文件名占位）；
        // 专家团专家成员（expert-<expertId>）经注册表动态实例化
        const agent = await this.resolveMemberAgent(task, agentId)
          ?? (agentId === NODE_AGENT_ID ? this.makeNodeAgent(this.taskExec(task)) : undefined)
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
      // 与 uploadAttachments 同规则：项目任务 + 项目工作区 → 统一落项目节点主会话（cwd = 项目工作区）
      const exec = this.taskExec(task)
      const projectWs = exec.workspace?.trim() || ''
      const targetIds = exec.dshRef && projectWs ? [NODE_AGENT_ID] : this.attachmentTargetAgentIds(task)
      const { targets } = await this.resolver.resolveMembers(targetIds)
      const results = await Promise.all(
        targetIds.map(async (agentId) => {
          // 节点直发任务（无成员）目标为伪成员 __node__：store 无记录，用节点伪实体兜底，
          // targets 解析不到时退回 resolveExecTarget（与会话创建同源）；专家成员经注册表动态实例化
          const agent = await this.resolveMemberAgent(task, agentId)
            ?? (agentId === NODE_AGENT_ID ? this.makeNodeAgent(this.taskExec(task)) : undefined)
          let target: DshTarget | undefined = targets.get(agentId) || (await this.resolveExecTarget(task, agentId))
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
