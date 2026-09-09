/**
 * @dsh-external/onenat-workbuddy - LLM Planner（D4）
 *
 * 目标: 用规划器模型按子智能体花名册把主任务拆解为子任务图（并行/串行/DAG），
 *       并在全部子任务结束后综合产出生成汇总结论。
 * 规划器目标解析: 调用指定的子智能体完成拆解；未配置或已失效时自动挑选（本地子智能体优先，否则列表第一个）。
 * 任何失败回退静态三段拆解，保证任务永不卡死在规划阶段。
 */

import type { Context } from 'cordis'
import { DshClient, type DshTarget } from './remote-client.js'
import type { AgentResolver } from './resolver.js'
import type { WorkStore } from './store.js'
import type { PlanSubtask, SubAgent, TaskSummary } from './types.js'

export interface PlannerMember {
  agent: SubAgent
  resourceSummary: string
}

export interface PlanDraft {
  strategy: 'parallel' | 'sequential' | 'dag'
  subtasks: Array<{ title: string; prompt: string; agentId: string; dependsOn: string[] }>
}

export class Planner {
  private client = new DshClient()
  private selfBaseUrl: string

  constructor(
    private store: WorkStore,
    private resolver: AgentResolver,
    ctx?: Context,
  ) {
    const webServer = ctx?.get?.('webServer') as any
    const port = webServer?.port || 3080
    this.selfBaseUrl = `http://127.0.0.1:${port}/api/v1`
  }

  /** 解析规划器调用目标 */
  /** 自动挑选规划器子智能体：优先名字/引用指向本地的，否则列表第一个 */
  public pickDefaultAgent(): SubAgent | undefined {
    const agents = this.store.getAgents()
    if (!agents.length) return undefined
    const byName = agents.find(a => /本地|local/i.test(a.name))
    const byRef = agents.find(a => a.dshRef.kind === 'direct' && /127\.0\.0\.1|localhost/i.test(String(a.dshRef.apiBaseUrl || '')))
    return byName || byRef || agents[0]
  }

  /** 解析规划器调用目标 —— 配置的子智能体；未配置时自动挑选默认（本地优先） */
  public async pickTarget(_memberTargets?: Map<string, DshTarget>): Promise<{ target: DshTarget; source: string; agent: SubAgent; auto: boolean } | { error: string }> {
    const settings = this.store.getSettings()
    let agent = settings.planner.agentId ? this.store.getAgent(settings.planner.agentId) : undefined
    // 配置的 agentId 失效（agent 已删除/重建）同样视为自动挑选
    const auto = !agent
    if (!agent) {
      agent = this.pickDefaultAgent()
      if (!agent) return { error: '没有可用的子智能体作为主调度（请先在子智能体页创建）' }
    }
    const target = await this.resolver.resolve(agent)
    if (!target.online || !target.baseUrl) return { error: `规划器子智能体「${agent.name}」不可用: ${target.error}` }
    return { target, source: agent.name + (auto ? '（自动）' : ''), agent, auto }
  }

  /** LLM 拆解主任务 */
  /** 主调度目标信息（聊天窗「模式/模型」选项拉取用） */
  /** 规划器目标信息（设置页/聊天窗选项拉取用）：实际生效的子智能体与入口 */
  public async plannerTarget(): Promise<{ source: string; baseUrl?: string; agentId?: string; auto?: boolean; error?: string }> {
    const picked = await this.pickTarget()
    if ('error' in picked) {
      // 失败时也给出自动挑选结果，供设置页显示默认值
      const d = this.pickDefaultAgent()
      return { source: '', agentId: d?.id, auto: true, error: picked.error }
    }
    return { source: picked.source, baseUrl: picked.target.baseUrl, agentId: picked.agent.id, auto: picked.auto }
  }

  public async planTask(
    objective: string,
    members: PlannerMember[],
    memberTargets: Map<string, DshTarget>,
    opts?: { priorityAgentIds?: string[] },
  ): Promise<{ plan: PlanDraft; plannerModel?: string } | { error: string; raw?: string }> {
    const picked = await this.pickTarget(memberTargets)
    if ('error' in picked) return { error: picked.error }

    const roster = members
      .map((m, i) => {
        const a = m.agent
        const role = a.systemPrompt ? a.systemPrompt.replace(/\s+/g, ' ').slice(0, 120) : '通用执行者'
        const isPriority = opts?.priorityAgentIds?.includes(a.id)
        return `${i + 1}. id=${a.id} 名称=${a.name}${isPriority ? ' 【用户显式 @ 重点指定】' : ''} 角色=${role}${m.resourceSummary ? ` 可用资源=${m.resourceSummary}` : ''}`
      })
      .join('\n')

    const priorityHint = opts?.priorityAgentIds?.length
      ? `\n重要约束: 用户在本轮消息中显式 @ 指定了子智能体（${members.filter(m => opts.priorityAgentIds!.includes(m.agent.id)).map(m => `${m.agent.name}(id=${m.agent.id})`).join('、')}），请务必将核心执行子任务分配给该智能体！\n`
      : ''

    // 注意: dsh-web-service /chat/completions 只提交最后一条 user 消息（system 角色被忽略），
    // 因此 JSON 契约、花名册与目标必须合并在单条 user 消息里。
    const user = [
      '你是多智能体任务规划器。你的唯一产出是一份 JSON 计划，绝对不要亲自执行或回答主任务本身。',
      '把主任务拆解为若干子任务，分配给给定的子智能体成员执行。输出严格 JSON（可包在 ```json 围栏中，除此之外不要有任何多余文本）:',
      '{"strategy":"parallel|sequential|dag","subtasks":[{"title":"简短标题","prompt":"给该子智能体的完整执行指令（自包含，含验收标准）","agentId":"成员 id","dependsOn":["依赖的子任务标题，无则空数组"]}]}',
      '规则: agentId 必须逐字取自花名册中的 id; 每个成员可被分配 0~2 个子任务; 子任务数量 2~6 个;',
      'prompt 必须自包含（执行者看不到本规划过程）; strategy=parallel 全部同时执行, sequential 按 dependsOn 链式, dag 有部分依赖。',
      priorityHint,
      '# 主任务目标（仅用于拆解，不要回答它）',
      objective,
      '',
      '# 子智能体花名册',
      roster,
    ].filter(Boolean).join('\n')

    // 主调度模型：设置页/聊天窗选择的 provider/model 透传给 /chat/completions
    const plannerModel = this.store.getSettings().planner.model || undefined
    const res = await this.client.chat(picked.target, [{ role: 'user', content: user }], { model: plannerModel })
    if (!res.ok || !res.content) return { error: `规划器调用失败: ${res.error}`, raw: res.content }

    const parsed = this.parsePlanJson(res.content)
    if (!parsed) return { error: '规划器输出无法解析为合法 JSON', raw: res.content }

    // 校验与修复
    const ids = new Set(members.map((m) => m.agent.id))
    const subtasks = parsed.subtasks
      .filter((s) => s && s.title && s.prompt && ids.has(s.agentId))
      .map((s) => ({ ...s, dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.filter((d) => typeof d === 'string') : [] }))
    if (subtasks.length === 0) {
      const unknownIds = [...new Set(parsed.subtasks.map((s: any) => s?.agentId).filter((a: any) => typeof a === 'string' && !ids.has(a)))]
      return { error: `规划器未产出任何合法子任务（未知 agentId: ${unknownIds.join(', ') || '无'}；成员: ${[...ids].join(', ')}）`, raw: res.content }
    }
    // dependsOn 拓扑修复: 去掉未知引用；成环时清空依赖
    const known = new Set<string>()
    for (const s of subtasks) {
      s.dependsOn = s.dependsOn.filter((d) => known.has(d))
      known.add(`${s.title}`) // 以 title 作为规划期依赖引用键（与 parsePlanJson 的 refKey 对齐）
    }
    const strategy: PlanDraft['strategy'] = parsed.strategy === 'sequential' || parsed.strategy === 'dag' ? parsed.strategy : 'parallel'
    return { plan: { strategy, subtasks }, plannerModel: optionsModel(picked.target) }
  }

  /** 解析模型输出里的 JSON（容忍 ```json 围栏与前后杂文） */
  private parsePlanJson(text: string): PlanDraft | undefined {
    const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
    const raw = (fenced ? fenced[1] : text).trim()
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end <= start) return undefined
    try {
      const obj = JSON.parse(raw.slice(start, end + 1))
      if (!obj || !Array.isArray(obj.subtasks)) return undefined
      return {
        strategy: obj.strategy,
        subtasks: obj.subtasks.map((s: any) => ({
          title: String(s.title || ''),
          prompt: String(s.prompt || ''),
          agentId: String(s.agentId || ''),
          dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.map(String) : [],
        })),
      }
    } catch {
      return undefined
    }
  }

  /** 静态三段兜底拆解（沿袭 dsh-remote-orchestrator） */
  public static fallbackPlan(objective: string, members: PlannerMember[]): PlanDraft {
    const n = members.length
    if (n === 1) {
      return {
        strategy: 'sequential',
        subtasks: [{ title: '完整执行与验证', prompt: `请完成以下任务目标，并详细输出执行过程与最终验证结果：\n${objective}`, agentId: members[0].agent.id, dependsOn: [] }],
      }
    }
    const subtasks: PlanDraft['subtasks'] = [
      {
        title: '阶段一：需求分析与方案规划',
        prompt: `作为方案规划专家，请针对以下总目标进行深入的技术选型、可行性分析与关键拆解规划：\n${objective}`,
        agentId: members[0].agent.id,
        dependsOn: [],
      },
      {
        title: '阶段二：核心执行与具体实施',
        prompt: `作为核心执行工程师，请针对以下总目标落实具体实现，产出核心方案、代码或详细交付内容：\n${objective}`,
        agentId: members[1 % n].agent.id,
        dependsOn: [],
      },
    ]
    if (n >= 3) {
      subtasks.push({
        title: '阶段三：质量审查与优化建议',
        prompt: `作为质检与安全审查员，请对上述总目标及其执行方案进行边界测试、安全审查与性能优化推演：\n${objective}`,
        agentId: members[2 % n].agent.id,
        dependsOn: [],
      })
    }
    return { strategy: 'parallel', subtasks }
  }

  /** 综合各子任务产出生成汇总（LLM 结论 + 静态兜底） */
  public async summarize(objective: string, subtasks: PlanSubtask[], memberTargets: Map<string, DshTarget>): Promise<TaskSummary> {
    const completed = subtasks.filter((s) => s.status === 'completed').length
    const failed = subtasks.filter((s) => s.status === 'failed').length
    const total = subtasks.length
    const finalStatus: TaskSummary['status'] = completed === total ? 'success' : completed > 0 ? 'partial_success' : 'failed'

    const subtaskSummaries = subtasks.map((s) => {
      let keyPoints = ''
      if (s.result?.content) {
        keyPoints = s.result.content.slice(0, 300).trim() + (s.result.content.length > 300 ? '…' : '')
      } else if (s.error) keyPoints = `执行异常: ${s.error}`
      else keyPoints = '未产出有效内容'
      return { id: s.id, title: s.title, status: s.status, keyPoints }
    })

    let finalConclusion = ''
    const picked = await this.pickTarget(memberTargets)
    if ('target' in picked) {
      const digest = subtasks
        .map((s) => `## ${s.title} [${s.status}]\n${(s.result?.content || s.error || '').slice(0, 1200)}`)
        .join('\n\n')
      const res = await this.client.chat(
        picked.target,
        [
          {
            role: 'user',
            content: [
              '你是多智能体协作的总调度。综合各子任务的产出发给用户一份简明的中文汇总：先给总体结论（2-3 句），再分点列出各子任务关键产出，最后给出下一步建议。直接输出汇总正文，不要使用工具。',
              `# 主任务`,
              objective,
              `# 各子任务产出`,
              digest,
            ].join('\n'),
          },
        ],
        { timeoutMs: 180_000 },
      )
      if (res.ok && res.content) finalConclusion = res.content.trim()
    }
    if (!finalConclusion) {
      finalConclusion =
        finalStatus === 'success'
          ? `所有 ${total} 个子任务均已顺利完成，总目标达成。`
          : finalStatus === 'partial_success'
            ? `部分子任务完成（${completed}/${total}），${failed} 个失败，请查看对应子任务日志排查。`
            : `全部子任务执行失败（0/${total}），请检查子智能体节点连通性与配置。`
    }

    return {
      status: finalStatus,
      overview: `主任务拆解为 ${total} 个子任务，成功 ${completed} 个，失败 ${failed} 个。`,
      subtaskSummaries,
      finalConclusion,
      completedAt: Date.now(),
    }
  }

  /**
   * 自动根据第一条用户消息生成简短有意义的会话标题（参考 DSH session-title 策略）
   * 优先使用 LLM 生成 4~12 字标题；失败则优雅降级截取前缀
   */
  public async generateTitle(firstUserMessage: string): Promise<string> {
    const raw = firstUserMessage.replace(/@[^\s@,，。!！?？:：;；]+/g, '').replace(/\s+/g, ' ').trim()
    const fallback = raw.length > 20 ? raw.slice(0, 20) + '…' : (raw || '未命名任务')

    try {
      const picked = await this.pickTarget()
      if (!('target' in picked)) return fallback

      const res = await this.client.chat(
        picked.target,
        [
          {
            role: 'user',
            content: [
              '你是一个会话标题提炼专家。请根据以下用户发送的第一条消息，提炼一个简明扼要的中文任务标题。',
              '要求：',
              '1. 长度控制在 4 到 12 个汉字之间；',
              '2. 必须直接返回标题文本，严禁包含任何标点符号、引号、前缀、Markdown 或多余解释；',
              '3. 突出核心动作与业务对象。',
              '',
              `用户消息: ${raw}`,
            ].join('\n'),
          },
        ],
        { timeoutMs: 15_000 },
      )

      if (res.ok && res.content) {
        let title = res.content.trim().replace(/^["'《「『【]+|["'》」』】]+$/g, '').trim()
        // 去除可能的多行
        title = title.split(/[\r\n]/)[0].trim()
        if (title.length >= 2 && title.length <= 30) {
          return title
        }
      }
    } catch {
      // 忽略 LLM 异常，安全回退
    }

    return fallback
  }
}

function optionsModel(_target: DshTarget): string | undefined {
  return undefined // 规划器模型名由远端默认模型决定，暂不透传
}
