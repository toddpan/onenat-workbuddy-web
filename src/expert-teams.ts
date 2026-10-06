/**
 * onenat-workbuddy-web - 专家团协作合同（ExpertTeam 运行时注入）
 *
 * 团队合同结构与协作规范移植自 dsh-agency-agents（Apache-2.0，MichengAI）的
 * ExpertTeam / executeTeam / MEMBER_HANDOFF / TEAM_METHODS / BUILTIN_TEAMS：
 *  - workbuddy 的「主理人」由主调度（Planner）承担，不引入团长智能体 —— 与其
 *    「主会话担任主理人」同构：团队合同拆成三份注入 —— 规划（主调度规则）、
 *    派工（成员提示词的 [专家团协作] 段）、汇总（核对要点）；
 *  - 全整集成（2026-10）：恢复五段回传规范（MEMBER_HANDOFF）、6 领域主理人模板
 *    （TEAM_METHODS：准备材料/验收清单/专属汇总）、coverage 覆盖度报告，
 *    并种子内置 5 个专家团（成员引用专家库角色，编排时动态实例化在任务节点）；
 *  - 成员两种引用：agentId（既有子智能体，跑各自绑定节点）/ expertId（专家库
 *    角色，动态实例化在任务发起节点，persona 用专家档案提示词，不落持久实体）。
 */

import type { ExpertTeam, ExpertTeamMember, SubAgent, TeamTemplateId } from './types.js'
import { teamMemberKey } from './types.js'

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

/** 合法领域模板（general = 通用兜底，自定义团可缺省） */
export const TEAM_TEMPLATE_IDS: readonly TeamTemplateId[] = ['general', 'product', 'technical', 'content', 'data', 'research']

export interface TeamInputParts {
  name: string
  description?: string
  goal: string
  constraints?: string
  deliveryRequirements?: string
  members: ExpertTeamMember[]
  coordinatorPrompt?: string
  templateId?: TeamTemplateId
  enabled: boolean
}

/** 成员名解析回调：键 = teamMemberKey（agentId 或 expert-<expertId>）；查不到时返回键本身 */
export type MemberNameResolver = (key: string) => string

// ============================================================================
// ---------- 协作规范（移植 dsh-agency-agents team-collaboration.ts，中文单语） ----------
// ============================================================================

/** 成员五段回传规范：结论 / 证据与定位 / 风险与条件 / 建议与验收 / 交接给主理人 */
export const MEMBER_HANDOFF = [
  '结论：只回答自己的分工问题；需要决策时给出明确建议。',
  '证据与定位：列出资料路径、段落、来源或计算方法；没有执行的检索和测试必须注明。',
  '风险与条件：说明影响、触发条件、假设和可能推翻结论的证据。',
  '建议与验收：给出可执行行动、优先级及完成标准。',
  '交接给主调度：列出需与其他职责核对的具体问题、缺失资料和未覆盖内容；没有则明确说明。',
] as const

/** 领域主理人方法：任务准备材料 / 核验清单 / 专属汇总规范（主调度注入） */
export const TEAM_METHODS: Record<TeamTemplateId, {
  preparation: readonly string[]
  reviewChecklist: readonly string[]
  synthesis: string
}> = {
  general: {
    preparation: [
      '要解决的问题与最终决策',
      '已有资料及可访问位置',
      '范围、约束、输出形式和未知项',
    ],
    reviewChecklist: [
      '结论是否对应用户目标，并有可定位的依据',
      '是否区分事实、假设、建议和未覆盖范围',
      '行动是否明确优先级、执行条件及验收方式',
    ],
    synthesis: '交付总体结论、依据与限制、必要分歧、优先级行动及待确认事项。',
  },
  product: {
    preparation: [
      '目标用户、核心场景和待解决问题',
      '现有方案、用户反馈与需求证据',
      '首版边界、资源约束及成功指标',
    ],
    reviewChecklist: [
      '必须做、建议做、暂缓是否有用户价值和实施约束依据',
      '体验问题是否对应具体使用步骤，反馈与假设是否分开',
      '推荐范围是否形成可验收的最小交付方案，是否标出成本未知项',
    ],
    synthesis: '以同一需求项对齐价值、体验和可行性；交付首版范围表（需求、优先级、依据、代价、验收指标），说明保留和暂缓理由。价值高但成本未知时建议先验证，不编造排期。',
  },
  technical: {
    preparation: [
      '改动目标、现有架构及接口/数据流材料',
      '部署环境、权限边界和依赖约束',
      '兼容性、性能目标与可运行的测试条件',
    ],
    reviewChecklist: [
      '风险是否给出位置、触发条件、影响和验证方式',
      '是否区分已复现问题、潜在风险和未验证项',
      '每项阻断风险是否有最小修复建议和对应回归用例',
    ],
    synthesis: '按同一组件或接口关联架构问题、安全风险和验收用例；交付风险清单（严重度、位置、触发条件、影响、修复、验证）及放行条件。未经执行的测试只能列为计划。',
  },
  content: {
    preparation: [
      '目标受众、平台、账号定位与内容目标',
      '主题、已知事实、可用素材及出处',
      '篇幅/形式、风格、时间范围和不可涉及的内容',
    ],
    reviewChecklist: [
      '每个选题是否有明确受众价值、独特角度及可用证据',
      '标题与核心论点是否得到素材支持，缺口是否标记',
      '推荐是否包含平台适配、可执行大纲和可观察的效果指标',
    ],
    synthesis: '按同一选题对齐内容角度、传播理由和证据状态；交付选题排序表、推荐标题与大纲、素材缺口和发布后观察指标。不以传播潜力替代事实核验，不承诺流量。',
  },
  data: {
    preparation: [
      '业务问题、数据来源及可读取的文件/表',
      '字段、单位、时间窗口、样本、去重规则和指标分母',
      '对比基准、已知质量问题及期望交付形式',
    ],
    reviewChecklist: [
      '比较结论是否使用一致的时间、单位、样本和分母',
      '关键数字是否可由来源、计算过程或查询复核',
      '图表是否使用已验证字段和数值，是否标记质量限制及相关性边界',
    ],
    synthesis: '先核对质量与统计口径，再采纳业务结论和图表建议。成员口径不一致时不能平均数值或强行合并；交付口径说明、关键指标与异常、可复核依据、图表方案及行动。数据不够时仅给分析计划。',
  },
  research: {
    preparation: [
      '研究问题、决策用途及比较对象',
      '地区、时间范围、比较维度和可用来源',
      '已有判断、关键假设以及希望验证的反证',
    ],
    reviewChecklist: [
      '来源是否可追溯，日期和口径是否适用，同源转述是否去重',
      '趋势推断是否有驱动因素、反证和成立条件',
      '方案是否按一致维度比较，推荐是否说明代价与可推翻条件',
    ],
    synthesis: '建立来源—论点对应关系，再对齐趋势判断和方案取舍；交付核心结论、证据表、方案比较、反证与待研究问题。不把多次转述算独立验证，不用虚假的精确概率掩盖不确定性。',
  },
}

/** 团队生效的领域方法：自定义模板缺省时落 general，专属模板不暗中叠加到其他领域 */
export function effectiveTeamMethod(team: Pick<ExpertTeam, 'templateId'>) {
  return TEAM_METHODS[team.templateId ?? 'general']
}

// ============================================================================
// ---------- 输入校验（控制台/AI 工具通道共用） ----------
// ============================================================================

/**
 * 校验并规范化团队输入（控制台/AI 工具通道共用）。
 * getAgent 用于校验子智能体成员存在；getExpert 用于校验专家库成员存在（专家库索引惰性加载，故本函数异步）。
 * 返回规范化后的字段或中文错误信息。
 */
export async function parseTeamInput(
  raw: any,
  ctx: { getAgent(id: string): SubAgent | undefined; getExpert(id: string): Promise<{ name: string } | undefined>; teams: ExpertTeam[]; currentId?: string },
): Promise<{ ok: true; value: TeamInputParts } | { ok: false; error: string }> {
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
    const expertId = trim(m?.expertId)
    if (agentId && expertId) return { ok: false, error: '成员只能选择一种来源：子智能体或专家库' }
    if (!agentId && !expertId) return { ok: false, error: '成员未选择子智能体或专家库角色' }
    const key = teamMemberKey({ agentId: agentId || undefined, expertId: expertId || undefined })
    if (seen.has(key)) return { ok: false, error: '成员重复' }
    let memberName = ''
    if (agentId) {
      const agent = ctx.getAgent(agentId)
      if (!agent) return { ok: false, error: `成员子智能体不存在: ${agentId}` }
      memberName = agent.name
    } else {
      const expert = await ctx.getExpert(expertId).catch(() => undefined)
      if (!expert) return { ok: false, error: `专家库中不存在该角色: ${expertId}` }
      memberName = expert.name
    }
    seen.add(key)
    const duty = trim(m?.duty)
    if (!duty) return { ok: false, error: `成员「${memberName}」的职责分工不能为空` }
    if (Array.from(duty).length > TEAM_LIMITS.duty) return { ok: false, error: `成员「${memberName}」的职责分工不能超过 ${TEAM_LIMITS.duty} 字` }
    const instructions = trim(m?.instructions)
    if (Array.from(instructions).length > TEAM_LIMITS.instructions) return { ok: false, error: `成员「${memberName}」的执行指示不能超过 ${TEAM_LIMITS.instructions} 字` }
    members.push(agentId ? { agentId, duty, ...(instructions ? { instructions } : {}) } : { expertId, duty, ...(instructions ? { instructions } : {}) })
  }
  const opt = (v: unknown): string | undefined => trim(v) || undefined
  const templateIdRaw = trim(raw?.templateId) as TeamTemplateId
  const templateId = templateIdRaw && TEAM_TEMPLATE_IDS.includes(templateIdRaw) ? templateIdRaw : undefined
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
      ...(templateId ? { templateId } : {}),
      enabled: raw?.enabled === undefined ? false : Boolean(raw.enabled),
    },
  }
}

/** 团队成员元信息（按成员键索引），供花名册/派工/汇总查 duty 与 instructions */
export function teamMemberIndex(team: ExpertTeam): Map<string, ExpertTeamMember> {
  return new Map(team.members.map((m) => [teamMemberKey(m), m]))
}

// ============================================================================
// ---------- 三份合同注入（规划 / 派工 / 汇总） ----------
// ============================================================================

/**
 * 派工提示词的 [专家团协作] 段（移植 executeTeam 成员 prompt 组装结构）：
 * 共同目标/约束/交付要求 + 全员职责边界 + 自己的分工与指示 + 独立并行声明 + 五段回传格式。
 * 注入位置：紧跟 [执行者角色] 之后、任务合同之前。
 */
export function teamMemberContract(team: ExpertTeam, member: ExpertTeamMember, nameOf: MemberNameResolver): string {
  const lines = [
    `[专家团协作]（本次任务在专家团「${team.name}」合同下执行）:`,
    `共同目标: ${team.goal}`,
    team.constraints?.trim() ? `共同约束: ${team.constraints.trim()}` : '',
    team.deliveryRequirements?.trim() ? `共同交付要求: ${team.deliveryRequirements.trim()}` : '',
    '职责边界（全队分工，只做分内职责；上游产出是素材，不替队友判断）:',
    ...team.members.map((m) => `- ${nameOf(teamMemberKey(m))}: ${m.duty}`),
    `你的分工: ${member.duty}`,
    member.instructions?.trim() ? `你的执行指示: ${member.instructions.trim()}` : '',
    '本次为团队并行分析：不得假设已收到其他成员的结果；结果汇总与交叉核验由主调度完成，不自行转派或等待队友。',
    '回传格式（按以下五段组织产出）:',
    ...MEMBER_HANDOFF.map((l, i) => `${i + 1}. ${l}`),
  ]
  return lines.filter(Boolean).join('\n')
}

/**
 * 主调度规划注入（planTask）：团队契约块 + 领域准备材料 + 拆解规则 + 验收清单。
 * 要求拆解覆盖各成员职责、子任务 prompt 自包含成员分工，交叉核验交给汇总。
 */
export function teamPlannerBrief(team: ExpertTeam, nameOf: MemberNameResolver): string {
  const method = effectiveTeamMethod(team)
  const lines = [
    '# 专家团协作契约（本次以专家团模式拆解）',
    `团队: ${team.name}${team.description?.trim() ? ` —— ${team.description.trim()}` : ''}`,
    `共同目标: ${team.goal}`,
    team.constraints?.trim() ? `共同约束: ${team.constraints.trim()}` : '',
    team.deliveryRequirements?.trim() ? `共同交付要求: ${team.deliveryRequirements.trim()}` : '',
    '成员分工（职责边界，花名册中的「团队职责」即来源于此）:',
    ...team.members.map((m) => `- ${nameOf(teamMemberKey(m))}(id=${teamMemberKey(m)}): ${m.duty}`),
    '拆解规则: 优先让每个成员承担与其职责匹配的子任务，职责未覆盖时补齐；给每个子任务的 prompt 必须自包含并写明该成员的职责边界与共同交付要求；跨职责交叉核验交给汇总阶段，不要安排成员互相等待队友产出。',
    '主调度任务准备（拆解前自检材料是否充分，缺关键信息时列为假设而非虚构）:',
    ...method.preparation.map((l) => `- ${l}`),
    `汇总阶段验收清单（供主调度核验成员产出，不注入成员提示词）:\n${method.reviewChecklist.map((l) => `- ${l}`).join('\n')}`,
    `专属汇总规范: ${method.synthesis}`,
  ]
  if (team.coordinatorPrompt?.trim()) lines.push(`主理人补充规则（优先遵守）:\n${team.coordinatorPrompt.trim()}`)
  return lines.filter(Boolean).join('\n\n')
}

/** 汇总核对注入（summarize）：领域验收清单 + 对照职责核对覆盖 + 处理分歧 + 标注缺口 */
export function teamSummarizeGuidance(team: ExpertTeam, nameOf: MemberNameResolver): string {
  const method = effectiveTeamMethod(team)
  const lines = [
    '# 专家团核对要点（成员产出是待核对材料，不是最终结论）',
    `共同目标: ${team.goal}`,
    team.deliveryRequirements?.trim() ? `共同交付要求: ${team.deliveryRequirements.trim()}` : '',
    '成员职责与产出对照:',
    ...team.members.map((m) => `- ${nameOf(teamMemberKey(m))}（${m.duty}）`),
    '验收清单（逐项核对后再下结论；无法核实的内容标为待验证）:',
    ...method.reviewChecklist.map((l) => `- ${l}`),
    '汇总规则: 对照各成员职责核对其产出是否覆盖分工；成员结论有分歧时比较证据质量并说明采信理由，不为追求一致而抹平分歧；引用同一来源不算独立交叉验证；失败/未覆盖成员的职责缺口如实标注，不编造其结论；coverage 只代表成员返回覆盖情况，不代表结论已通过验证。',
    `专属汇总规范: ${method.synthesis}`,
  ]
  if (team.coordinatorPrompt?.trim()) lines.push(`主理人补充规则（优先遵守）:\n${team.coordinatorPrompt.trim()}`)
  return lines.filter(Boolean).join('\n\n')
}

// ============================================================================
// ---------- 内置专家团种子（移植 dsh-agency-agents BUILTIN_TEAMS，成员指向专家库） ----------
// ============================================================================

/** 内置团成员（专家库角色 + 职责 + 执行指示） */
const builtinMember = (expertId: string, duty: string, instructions: string): ExpertTeamMember => ({ expertId, duty, instructions })

const BUILTIN_TEAM_CONSTRAINTS = '仅进行分析评审；依据不足时明确说明，不擅自修改或发布。'

const builtinTeam = (
  id: string,
  name: string,
  description: string,
  templateId: TeamTemplateId,
  goal: string,
  deliveryRequirements: string,
  members: ExpertTeamMember[],
): ExpertTeam => ({
  id: `team-builtin-${id}`,
  name,
  description,
  goal,
  constraints: BUILTIN_TEAM_CONSTRAINTS,
  deliveryRequirements,
  members,
  templateId,
  builtin: true,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
})

/** 内置 5 团：成员全部引用专家库角色（assets/experts），编排时动态实例化在任务节点 */
export const BUILTIN_TEAMS: readonly ExpertTeam[] = [
  builtinTeam(
    'product',
    '产品方案评审团',
    '适合需求评审、方案比较与迭代规划。结合用户价值、使用体验和实现成本，明确首版范围、功能优先级及下一步行动。',
    'product',
    '从价值、体验和可行性评估产品方案。',
    '优先级与行动清单',
    [
      builtinMember('product-manager', '需求价值与优先级', '检查目标用户、核心问题和需求范围，按同一需求项列出必须做、建议做和暂缓事项、价值依据及成功指标。区分反馈与假设；将体验证据缺口交接给主调度对照研究意见，将成本未知项对照架构意见，不代替队友判断。'),
      builtinMember('design-ux-researcher', '用户需求与体验障碍', '按用户完成任务的实际步骤定位体验障碍，说明受影响人群、已有反馈及未经验证的假设。为每个障碍给出低成本验证方法和验收信号；将影响需求优先级的问题交接给主调度，不替代产品排期和技术估算。'),
      builtinMember('engineering-software-architect', '实现成本与技术约束', '按需求项分析实现范围、已有能力、外部依赖和技术约束，提出最小交付路径及备选方案。说明成本判断依据与未知项，不编造工期；交接可能改变需求范围或用户流程的技术限制。'),
    ],
  ),
  builtinTeam(
    'technical',
    '技术方案评审团',
    '适合架构设计评审与交付前检查。从架构、安全和质量三个角度定位风险，给出最小修改建议与可执行的验收清单。',
    'technical',
    '检查架构、安全风险与验收边界。',
    '风险与验收清单',
    [
      builtinMember('engineering-software-architect', '架构与扩展性', '沿组件、接口和数据流检查职责边界、依赖、兼容性及可维护性。每个发现给出位置、触发条件、影响和最小修改方案；标记需主调度对照安全意见与回归用例的变更点，不宣称未执行的测试通过。'),
      builtinMember('security-appsec-engineer', '权限与安全风险', '沿输入入口、权限检查和敏感数据流识别风险，给出位置、攻击前提、影响及最小修复建议。区分已验证漏洞、设计风险和材料缺口；交接应阻断放行的条件及需要质量角色覆盖的验证场景。'),
      builtinMember('testing-reality-checker', '验收边界与质量', '依据现有方案独立列出正常、异常、边界、兼容与回滚场景，逐项写明前置条件、操作和预期结果。区分实际执行结果与建议用例；交接需主调度结合架构和安全发现补充的覆盖点，不假设已经拿到队友报告。'),
    ],
  ),
  builtinTeam(
    'content',
    '内容选题策划团',
    '适合选题规划与内容方向筛选。结合受众需求、平台传播特点和素材依据，提出选题、标题与大纲，标明需要补充的事实材料。',
    'content',
    '找到值得写、适合传播的内容方向。',
    '选题与内容大纲',
    [
      builtinMember('marketing-content-creator', '选题角度与表达', '围绕同一主题及已提供的候选方向，按目标受众价值提出有区分度的选题、标题、大纲和开头。每个核心论点关联已有素材或标记待补；交接需核实的事实及需要传播意见确认的平台表达，不编造案例。'),
      builtinMember('marketing-growth-hacker', '人群与传播策略', '围绕已提供的主题或候选方向分析目标人群、平台使用场景、点击与分享动机，给出包装建议和可观察指标。说明推荐依据及平台限制，不承诺流量；将夸大标题或素材不足的风险交给主调度核对。'),
      builtinMember('research-synthesist', '素材依据与事实缺口', '为已提供主题、素材及核心论点建立事实—出处对应表，检查来源、日期、引用语境和可用范围。区分已支持、待核实与不宜使用的论点，列出补证方向；没有收到创作结果时不要声称已核验其新标题或大纲。'),
    ],
  ),
  builtinTeam(
    'data',
    '数据分析诊断团',
    '适合指标复盘、异常排查与报表分析。先核对数据质量和统计口径，再解释业务变化，给出分析结论、图表方案及待验证问题。',
    'data',
    '核对数据口径，发现问题并解释结果。',
    '分析结论与图表建议',
    [
      builtinMember('engineering-data-engineer', '数据质量与统计口径', '检查字段、时间窗口、单位、样本、缺失值、重复记录和指标分母，输出可供主调度核对的口径表及质量问题。说明问题对哪些指标有影响、哪些比较不能成立；材料不足时列出所需字段，不虚构清洗或查询结果。'),
      builtinMember('support-analytics-reporter', '业务指标与异常', '围绕业务问题分析指标与异常，每个关键数值附数据来源、时间、单位、分母及计算方式。明确质量假设和替代解释，不把相关性当因果性；交接需主调度对照质量报告确认的口径，未核实前使用条件性结论。'),
      builtinMember('engineering-data-visualization-engineer', '图表与结果表达', '依据实际可用字段与业务问题提出图表方案，明确横纵轴、单位、聚合方式、对比基准和必要标注。说明可能误读的尺度或样本问题；未收到已核验数值时只提供方案，不编造图表数据，将口径依赖交接给主调度。'),
    ],
  ),
  builtinTeam(
    'research',
    '专题研究专家团',
    '适合专题调研、趋势判断与方案决策。梳理可信来源、变化因素和不同方案的利弊，形成有依据的建议，并说明争议与适用条件。',
    'research',
    '梳理证据、趋势与不同方案的取舍。',
    '研究结论与证据来源',
    [
      builtinMember('research-synthesist', '证据可信度与来源', '围绕研究问题建立论点—来源—日期—适用范围证据表，优先一手资料，区分同源转述和独立来源。指出冲突、过时信息与尚无依据的判断；交接趋势或方案比较应遵守的证据边界，无法检索时明确资料范围。'),
      builtinMember('product-trend-researcher', '变化与驱动因素', '分析指定时间与地区内的变化方向、驱动因素和替代解释，区分事实、趋势推断及情景假设。每项判断关联证据并给出反证或失效条件；交接需要主调度核查的时效和口径，不凭同源重复报道增强确信。'),
      builtinMember('specialized-strategy-duel-agent', '竞争方案与取舍', '基于用户决策目标使用一致维度比较备选方案，说明适用条件、收益、成本、风险及可逆性。给出推荐及可能推翻它的证据，不编造精确评分；将关键假设交接给主调度对照来源与趋势意见。'),
    ],
  ),
]
