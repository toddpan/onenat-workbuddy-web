/**
 * onenat-workbuddy-web - 专家团协作合同（ExpertTeam 运行时注入）
 *
 * 团队合同结构与协作规范移植自 dsh-agency-agents（Apache-2.0，MichengAI）的
 * ExpertTeam / executeTeam / MEMBER_HANDOFF / TEAM_PROMPTS：
 *  - workbuddy 的「主理人」由主调度（Planner）承担，不引入团长智能体 —— 与其
 *    「主会话担任主理人」同构：团队合同拆成三份注入 —— 规划（主调度规则）、
 *    派工（成员提示词的 [专家团协作] 段）、汇总（核对要点）；
 *  - 成员结果按五段式回传（结论/证据/风险/建议/交接），交叉核验由汇总阶段完成；
 *  - coverage 只反映成员返回情况，不代表质量验收通过。
 */

import type { ExpertTeam, ExpertTeamMember, PlanSubtask, SubAgent, TeamCoverage } from './types.js'

/** 团队配置字段长度上限（对齐 dsh-agency-agents teamInputSchema 的量级） */
export const TEAM_LIMITS = {
  name: 40,
  description: 160,
  goal: 2000,
  constraints: 2000,
  deliveryRequirements: 2000,
  members: { min: 2, max: 8 },
  duty: 100,
  instructions: 2000,
  coordinatorPrompt: 4000,
} as const

/** 成员回传规范（五段式，移植 MEMBER_HANDOFF；「主理人」改称「主调度」） */
export const MEMBER_HANDOFF = [
  '结论：只回答自己分工内的问题；需要决策时给出明确建议。',
  '证据与定位：列出资料路径、段落、来源或计算方法；没有实际执行的检索和测试必须注明。',
  '风险与条件：说明影响、触发条件、假设和可能推翻结论的证据。',
  '建议与验收：给出可执行行动、优先级及完成标准。',
  '交接给主调度：列出需与其他成员职责核对的具体问题、缺失资料和未覆盖内容；没有则明确说明。',
] as const

export interface TeamInputParts {
  name: string
  description?: string
  goal: string
  constraints?: string
  deliveryRequirements?: string
  members: ExpertTeamMember[]
  coordinatorPrompt?: string
  enabled: boolean
}

/**
 * 校验并规范化团队输入（控制台/AI 工具通道共用）。
 * getAgent 用于校验成员引用的子智能体存在；返回规范化后的字段或中文错误信息。
 */
export function parseTeamInput(
  raw: any,
  ctx: { getAgent(id: string): SubAgent | undefined; teams: ExpertTeam[]; currentId?: string },
): { ok: true; value: TeamInputParts } | { ok: false; error: string } {
  const trim = (v: unknown): string => String(v ?? '').trim()
  const name = trim(raw?.name)
  if (!name) return { ok: false, error: '团队名称不能为空' }
  if (Array.from(name).length > TEAM_LIMITS.name) return { ok: false, error: `团队名称不能超过 ${TEAM_LIMITS.name} 字` }
  if (/[@\r\n\0]/.test(name)) return { ok: false, error: '团队名称不能包含 @ 或换行' }
  const clash = ctx.teams.find((t) => t.id !== ctx.currentId && t.name === name)
  if (clash) return { ok: false, error: `团队名称与既有团队「${clash.name}」重复` }
  const goal = trim(raw?.goal)
  if (!goal) return { ok: false, error: '共同目标不能为空' }
  for (const [key, limit] of [['description', TEAM_LIMITS.description], ['goal', TEAM_LIMITS.goal], ['constraints', TEAM_LIMITS.constraints], ['deliveryRequirements', TEAM_LIMITS.deliveryRequirements], ['coordinatorPrompt', TEAM_LIMITS.coordinatorPrompt]] as const) {
    const v = trim(raw?.[key])
    if (Array.from(v).length > limit) return { ok: false, error: `「${key}」不能超过 ${limit} 字` }
  }
  const membersRaw = Array.isArray(raw?.members) ? raw.members : []
  if (membersRaw.length < TEAM_LIMITS.members.min || membersRaw.length > TEAM_LIMITS.members.max) {
    return { ok: false, error: `成员数量需为 ${TEAM_LIMITS.members.min}~${TEAM_LIMITS.members.max} 人` }
  }
  const members: ExpertTeamMember[] = []
  const seen = new Set<string>()
  for (const m of membersRaw) {
    const agentId = trim(m?.agentId)
    if (!agentId) return { ok: false, error: '成员未选择子智能体' }
    if (seen.has(agentId)) return { ok: false, error: '成员子智能体重复' }
    if (!ctx.getAgent(agentId)) return { ok: false, error: `成员子智能体不存在: ${agentId}` }
    seen.add(agentId)
    const duty = trim(m?.duty)
    if (!duty) return { ok: false, error: `成员「${ctx.getAgent(agentId)!.name}」的职责分工不能为空` }
    if (Array.from(duty).length > TEAM_LIMITS.duty) return { ok: false, error: `成员「${ctx.getAgent(agentId)!.name}」的职责分工不能超过 ${TEAM_LIMITS.duty} 字` }
    const instructions = trim(m?.instructions)
    if (Array.from(instructions).length > TEAM_LIMITS.instructions) return { ok: false, error: `成员「${ctx.getAgent(agentId)!.name}」的执行指示不能超过 ${TEAM_LIMITS.instructions} 字` }
    members.push({ agentId, duty, ...(instructions ? { instructions } : {}) })
  }
  const opt = (v: unknown): string | undefined => trim(v) || undefined
  return {
    ok: true,
    value: {
      name,
      description: opt(raw?.description),
      goal,
      constraints: opt(raw?.constraints),
      deliveryRequirements: opt(raw?.deliveryRequirements),
      members,
      coordinatorPrompt: opt(raw?.coordinatorPrompt),
      enabled: raw?.enabled === undefined ? true : Boolean(raw.enabled),
    },
  }
}

/** 团队成员元信息（按 agentId 索引），供花名册/派工/汇总查 duty 与 instructions */
export function teamMemberIndex(team: ExpertTeam): Map<string, ExpertTeamMember> {
  return new Map(team.members.map((m) => [m.agentId, m]))
}

/**
 * 派工提示词的 [专家团协作] 段（移植 executeTeam 成员 prompt 组装结构）：
 * 共同目标/约束/交付要求 + 全员职责边界 + 自己的分工与指示 + 独立并行声明 + 五段回传格式。
 * 注入位置：紧跟 [执行者角色] 之后、任务合同之前。
 */
export function teamMemberContract(team: ExpertTeam, member: ExpertTeamMember, agents: Map<string, SubAgent>): string {
  const agentName = (id: string): string => agents.get(id)?.name || id
  const lines = [
    `[专家团协作]（本次任务在专家团「${team.name}」合同下执行）:`,
    `共同目标: ${team.goal}`,
    team.constraints?.trim() ? `共同约束: ${team.constraints.trim()}` : '',
    team.deliveryRequirements?.trim() ? `共同交付要求: ${team.deliveryRequirements.trim()}` : '',
    '职责边界（全队分工，只做分内职责；上游产出是素材，不替队友判断）:',
    ...team.members.map((m) => `- ${agentName(m.agentId)}: ${m.duty}`),
    `你的分工: ${member.duty}`,
    member.instructions?.trim() ? `你的执行指示: ${member.instructions.trim()}` : '',
    '本次为团队并行分析：不得假设已收到其他成员的结果；需要交叉核验的事项写进「交接给主调度」，不自行转派或等待队友。',
    '回传格式:',
    ...MEMBER_HANDOFF.map((l) => `- ${l}`),
  ]
  return lines.filter(Boolean).join('\n')
}

/**
 * 主调度规划注入（planTask）：团队契约块 + 派工规则。
 * 要求拆解覆盖各成员职责、子任务 prompt 自包含成员分工，交叉核验交给汇总。
 */
export function teamPlannerBrief(team: ExpertTeam, agents: Map<string, SubAgent>): string {
  const agentName = (id: string): string => agents.get(id)?.name || id
  const lines = [
    '# 专家团协作契约（本次以专家团模式拆解）',
    `团队: ${team.name}${team.description?.trim() ? ` —— ${team.description.trim()}` : ''}`,
    `共同目标: ${team.goal}`,
    team.constraints?.trim() ? `共同约束: ${team.constraints.trim()}` : '',
    team.deliveryRequirements?.trim() ? `共同交付要求: ${team.deliveryRequirements.trim()}` : '',
    '成员分工（职责边界，花名册中的「团队职责」即来源于此）:',
    ...team.members.map((m) => `- ${agentName(m.agentId)}(id=${m.agentId}): ${m.duty}`),
    '拆解规则: 优先让每个成员承担与其职责匹配的子任务，职责未覆盖时补齐；给每个子任务的 prompt 必须自包含并写明该成员的职责边界、共同交付要求与回传格式（结论/证据/风险/建议/交接给主调度）；跨职责交叉核验交给汇总阶段，不要安排成员互相等待队友产出。',
  ]
  if (team.coordinatorPrompt?.trim()) lines.push(`主理人补充规则（优先遵守）:\n${team.coordinatorPrompt.trim()}`)
  return lines.filter(Boolean).join('\n\n')
}

/** 汇总核对注入（summarize）：对照职责核对覆盖、处理分歧、标注缺口 */
export function teamSummarizeGuidance(team: ExpertTeam, agents: Map<string, SubAgent>): string {
  const agentName = (id: string): string => agents.get(id)?.name || id
  const lines = [
    '# 专家团核对要点（成员产出是待核对材料，不是最终结论）',
    `共同目标: ${team.goal}`,
    team.deliveryRequirements?.trim() ? `共同交付要求: ${team.deliveryRequirements.trim()}` : '',
    '成员职责与产出对照:',
    ...team.members.map((m) => `- ${agentName(m.agentId)}（${m.duty}）`),
    '汇总规则: 对照各成员职责核对其产出是否覆盖分工；成员结论有分歧时比较证据质量并说明采信理由，不为追求一致而抹平分歧；引用同一来源不算独立交叉验证；失败/未覆盖成员的职责缺口如实标注，不编造其结论。',
  ]
  if (team.coordinatorPrompt?.trim()) lines.push(`主理人补充规则（优先遵守）:\n${team.coordinatorPrompt.trim()}`)
  return lines.filter(Boolean).join('\n\n')
}

/** 覆盖度报告（对齐 executeTeam coverage：只反映成员返回情况，不代表质量验收通过） */
export function buildCoverage(subtasks: PlanSubtask[], team: ExpertTeam | undefined, agents: Map<string, SubAgent>): TeamCoverage {
  const completed = subtasks.filter((s) => s.status === 'completed').length
  const total = subtasks.length
  const dutyByAgent = team ? teamMemberIndex(team) : new Map<string, ExpertTeamMember>()
  const missing = subtasks
    .filter((s) => s.status !== 'completed')
    .map((s) => ({
      title: s.title,
      agentId: s.agentId,
      agentName: agents.get(s.agentId)?.name || s.agentId,
      ...(dutyByAgent.get(s.agentId)?.duty ? { duty: dutyByAgent.get(s.agentId)!.duty } : {}),
      ...(s.error ? { error: s.error } : {}),
    }))
  return {
    status: completed === total ? 'complete' : completed > 0 ? 'partial' : 'failed',
    completed,
    total,
    missing,
  }
}
