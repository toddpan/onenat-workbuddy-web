/**
 * @dsh-external/onenat-workbuddy - 资源提示词合成引擎（D2 资源即提示词）
 *
 * 派发子任务时，把子智能体绑定的 ONENAT 资源（SSH / DSH / HTTP 应用）的
 * 「连接入口 + 凭证 + 技能全文」合成为结构化提示词块，注入子智能体上下文。
 * 输出协议见设计文档 §6.2。
 */

import type { OnenatDirectory } from './onenat.js'
import type { AgentResourceBinding, SubAgent } from './types.js'
import { DshClient, type DshTarget } from './remote-client.js'
import type { AgentResolver } from './resolver.js'

const SKILL_INLINE_LIMIT = 8 * 1024
const MAX_BOUND_SKILLS = 8
/** 命中目标节点后按候选根顺序定位绑定技能（project 用 workDir 作 cwd） */
const SKILL_ROOTS: Array<{ root: string; needsCwd?: boolean }> = [
  { root: 'user-dsh' },
  { root: 'project', needsCwd: true },
  { root: 'user-agents' },
]

export interface ComposeContext {
  /** 派发时刻的时间戳标记（写进提示词，提醒 AI 端口是实况） */
  resolvedAt: number
  /** 脱敏预览模式（UI 提示词预览用：凭证打码、技能截断更狠） */
  mask?: boolean
  /** 用户本轮通过 @ 动态提及注入的临时资源列表 */
  extraResources?: AgentResourceBinding[]
}

export interface ComposeResult {
  block: string
  resources: Array<{ alias: string; kind: string; online: boolean; error?: string }>
  warnings: string[]
}

export class PromptComposer {
  constructor(private directory: OnenatDirectory, private resolver: AgentResolver) {}

  private client = new DshClient()

  public async compose(agent: SubAgent, ctx: ComposeContext): Promise<ComposeResult> {
    const warnings: string[] = []
    const resources: ComposeResult['resources'] = []
    const sections: string[] = []

    // 合并静态资源与动态 @ 注入的资源（按 ref.mappingId/appId 去重）
    const allBindings: AgentResourceBinding[] = [...(agent.resources || [])]
    const existingRefKeys = new Set(allBindings.map(b => b.ref.kind === 'mapping' ? b.ref.mappingId : b.ref.appId))

    for (const extra of ctx.extraResources || []) {
      const k = extra.ref.kind === 'mapping' ? extra.ref.mappingId : extra.ref.appId
      if (!existingRefKeys.has(k)) {
        existingRefKeys.add(k)
        allBindings.push(extra)
      }
    }

    for (const binding of allBindings) {
      const isDynamic = !(agent.resources || []).some(b => (b.ref.kind === 'mapping' ? b.ref.mappingId : b.ref.appId) === (binding.ref.kind === 'mapping' ? binding.ref.mappingId : binding.ref.appId))
      const ep =
        binding.ref.kind === 'mapping'
          ? this.directory.resolveMapping(binding.ref.mappingId)
          : this.directory.resolveApp(binding.ref.appId)

      const alias = binding.alias || ep?.appName || ep?.note || binding.ref.kind + ':' + (binding.ref.kind === 'mapping' ? binding.ref.mappingId : binding.ref.appId)
      if (!ep) {
        resources.push({ alias, kind: 'unknown', online: false, error: '资源已不存在' })
        warnings.push(`资源「${alias}」在 ONENAT 中已不存在，已跳过`)
        continue
      }
      if (!ep.online) {
        resources.push({ alias, kind: ep.kind, online: false, error: '离线' })
        warnings.push(`资源「${alias}」当前离线，本次未注入（如需使用请检查 ONENAT 客户端）`)
        continue
      }

      const lines: string[] = []
      const title = `资源: ${alias} (${ep.kind.toUpperCase()})  [${ep.tunnelName}]` + (isDynamic ? ' 【用户当轮 @ 动态指定】' : '')
      if (ep.kind === 'ssh') {
        const cred = binding.credentialMode === 'inline' ? await this.directory.fetchMappingCredentials(ep.mappingId) : undefined
        const user = cred?.username || 'root'
        lines.push(`- 连接: ssh -o StrictHostKeyChecking=accept-new -p ${ep.port} ${user}@${ep.host}`)
        if (binding.credentialMode === 'inline') {
          if (cred?.ok && cred.password) {
            lines.push(`- 凭证: 密码 \`${ctx.mask ? '********（已打码）' : cred.password}\`（※ 不要写入脚本或输出）`)
          } else if (cred && !cred.ok) {
            lines.push(`- 凭证: 内联获取失败（${cred.error}）；可用下方凭证接口自取`)
            warnings.push(`资源「${alias}」凭证内联失败: ${cred.error}`)
          }
        } else if (binding.credentialMode === 'self-fetch') {
          lines.push(`- 凭证: 经 OneNat 凭证接口自取（限速 5 次/分）:`)
          lines.push(`  curl -H "Authorization: Bearer <ONENAT_API_KEY>" ${this.directory.endpoint}/api/v1/mappings/${ep.mappingId}/credentials`)
          lines.push(`  （下方 [平台接入] 段提供 ONENAT_API_KEY）`)
        }
      } else if (ep.baseUrl) {
        lines.push(`- 入口: ${ep.baseUrl}`)
        if (binding.credentialMode === 'self-fetch') {
          lines.push(`- 凭证: 经 OneNat 凭证接口自取（限速 5 次/分）:`)
          lines.push(`  curl -H "Authorization: Bearer <ONENAT_API_KEY>" ${this.directory.endpoint}/api/v1/mappings/${ep.mappingId}/credentials`)
        }
      } else {
        lines.push(`- 入口: ${ep.proto}://${ep.host}:${ep.port ?? '?'}（raw TCP，按实际协议使用）`)
      }
      if (binding.note) lines.push(`- 用途: ${binding.note}`)
      if (ep.note && ep.note !== binding.note) lines.push(`- 映射备注: ${ep.note}`)

      // 技能注入
      const skills = ep.appSkills || []
      const mode = binding.skillMode
      const picked = mode === 'all' ? skills : Array.isArray(mode) ? skills.filter((s) => (mode as { names: string[] }).names.includes(s.name)) : []
      if (mode === 'none') {
        if (skills.length > 0) {
          lines.push(`- 技能清单（按需下载后先读再用）: ${skills.map((s) => s.name).join(', ')}`)
          for (const s of skills) lines.push(`  curl -s "${s.url}"`)
        }
      } else {
        for (const s of picked) {
          try {
            let text = await this.directory.fetchSkillText(s.url, ctx.mask ? 4 * 1024 : SKILL_INLINE_LIMIT)
            if (ctx.mask && text.length > 4 * 1024) text = text.slice(0, 4 * 1024) + '\n…(预览截断)'
            lines.push(`- 技能《${s.name}》全文:`)
            lines.push('<skill-doc>')
            lines.push(text.trim())
            lines.push('</skill-doc>')
          } catch (err: any) {
            lines.push(`- 技能《${s.name}》下载失败（${err?.message || err}）: ${s.url}`)
            warnings.push(`资源「${alias}」技能 ${s.name} 下载失败`)
          }
        }
        const rest = skills.filter((s) => !picked.includes(s))
        if (rest.length > 0) lines.push(`- 其余技能（按需下载）: ${rest.map((s) => s.name).join(', ')}`)
      }

      sections.push(`### ${title}\n${lines.join('\n')}`)
      resources.push({ alias, kind: ep.kind, online: true })
    }

    const parts: string[] = []
    if (sections.length > 0) {
      parts.push('[可用资源清单]（由 OneNat 平台注入；公网端口为本次派发时刻实况，勿缓存，失效后向调度方报告而非反复重试）:')
      parts.push('')
      parts.push(...sections)
    }
    if (agent.resources?.some((r: AgentResourceBinding) => r.credentialMode === 'self-fetch')) {
      parts.push('')
      parts.push(`[平台接入] ONENAT API（只读，用于自取凭证/技能）:`)
      parts.push(`- Base: ${this.directory.endpoint}`)
      parts.push(`- API Key: ${ctx.mask ? 'onk-****（预览打码）' : this.directory.key}`)
    }
    if (sections.length > 0) {
      parts.push('')
      parts.push('[资源与任务约定]:')
      parts.push('1. 使用任何资源前先读对应技能文件，技能与你的猜测冲突时以技能为准；技能没提的能力不要臆造；')
      parts.push('2. 连接被拒/超时视为端口可能已漂移，向调度方报告一次即可，不要反复重试或探测；')
      parts.push('3. 凭证仅限本任务使用，不得写入脚本文件、不得转发给第三方；')
      parts.push('4. 【交互与执行】：若需要用户确认目标，可调用 ask_user_question 工具抛出结构化选项；用户确认答复后请立即执行目标任务，避免重复确认。')
    }

    // 子智能体绑定的技能：会话自动装载（注入 <skill_content> 全文）
    const boundSkills = agent.skills || []
    if (boundSkills.length > 0 && !ctx.mask) {
      const target = await this.resolveTarget(agent)
      if (target) {
        const skillWarnings: string[] = []
        const skillBlocks = await this.fetchAgentSkills(target, boundSkills, agent, skillWarnings)
        if (skillBlocks.length > 0) {
          parts.push('')
          parts.push('[已装载技能]（当前子智能体绑定的技能，已注入全文，请直接遵循，无需再调用 skill 工具）:')
          parts.push(...skillBlocks)
        }
        for (const w of skillWarnings) {
          if (!warnings.includes(w)) warnings.push(w)
        }
      }
    } else if (boundSkills.length > 0 && ctx.mask) {
      parts.push('')
      parts.push(`[已绑定技能]（预览打码，共 ${boundSkills.length} 个: ${boundSkills.join('、')}）`)
    }

    return { block: parts.join('\n'), resources, warnings }
  }

  /** 解析子智能体目标节点（baseUrl/apiKey）；不可达返回 undefined */
  private async resolveTarget(agent: SubAgent): Promise<DshTarget | undefined> {
    try {
      const t = await this.resolver.resolve(agent)
      if (!t.online || !t.baseUrl) return undefined
      return { baseUrl: t.baseUrl, apiKey: t.apiKey }
    } catch {
      return undefined
    }
  }

  /** 拉取绑定技能的 <skill_content> 块（超限截断；按候选根定位） */
  private async fetchAgentSkills(target: DshTarget, boundSkills: string[], agent: SubAgent, warnings: string[]): Promise<string[]> {
    const blocks: string[] = []
    const seen = new Set<string>()
    for (const name of boundSkills.slice(0, MAX_BOUND_SKILLS)) {
      if (seen.has(name)) continue
      seen.add(name)
      const content = await this.fetchSkillBody(target, name, agent.workDir)
      if (content === undefined) {
        warnings.push(`绑定技能「${name}」未在目标节点找到（已跳过注入）`)
        continue
      }
      const safe = content.length > SKILL_INLINE_LIMIT ? `${content.slice(0, SKILL_INLINE_LIMIT)}\n…(技能正文超限截断)` : content
      blocks.push(renderSkillContent(name, safe))
    }
    return blocks
  }

  /** 按候选根依次尝试获取技能全文（project 用 workDir 作 cwd） */
  private async fetchSkillBody(target: DshTarget, name: string, workDir?: string): Promise<string | undefined> {
    for (const { root, needsCwd } of SKILL_ROOTS) {
      const res = await this.client.getSkillBody(target, name, {
        root,
        ...(needsCwd ? { cwd: workDir || undefined } : {}),
      })
      if (res.ok && res.content) return res.content
      if (res.unsupported) return undefined
      // 404（不在此根）→ 试下一个根
    }
    return undefined
  }
}

/** 渲染与 DSH `renderSkillContent` 同构的 <skill_content> 块（技能全文注入用）。 */
function renderSkillContent(name: string, content: string): string {
  const escaped = name.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return [
    `<skill_content name="${escaped}">`,
    '<skill_resources>',
    'Resources for this skill are managed by OneNat WorkBuddy.',
    'Load referenced resources only as needed.',
    '</skill_resources>',
    '',
    '<skill_instructions>',
    content,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}
