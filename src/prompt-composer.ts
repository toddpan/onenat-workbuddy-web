/**
 * @dsh-external/onenat-workbuddy - 资源提示词合成引擎（D2 资源即提示词）
 *
 * 派发子任务时，把子智能体绑定的 ONENAT 资源（SSH / DSH / HTTP 应用）的
 * 「连接入口 + 凭证 + 技能全文」合成为结构化提示词块，注入子智能体上下文。
 * 输出协议见设计文档 §6.2。
 */

import type { OnenatDirectory } from './onenat.js'
import type { AgentResourceBinding, SubAgent } from './types.js'

const SKILL_INLINE_LIMIT = 8 * 1024

export interface ComposeContext {
  /** 派发时刻的时间戳标记（写进提示词，提醒 AI 端口是实况） */
  resolvedAt: number
  /** 脱敏预览模式（UI 提示词预览用：凭证打码、技能截断更狠） */
  mask?: boolean
}

export interface ComposeResult {
  block: string
  resources: Array<{ alias: string; kind: string; online: boolean; error?: string }>
  warnings: string[]
}

export class PromptComposer {
  constructor(private directory: OnenatDirectory) {}

  public async compose(agent: SubAgent, ctx: ComposeContext): Promise<ComposeResult> {
    const warnings: string[] = []
    const resources: ComposeResult['resources'] = []
    const sections: string[] = []

    for (const binding of agent.resources || []) {
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
      const title = `资源: ${alias} (${ep.kind.toUpperCase()})  [${ep.tunnelName}]`
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
      parts.push('[资源使用约定]:')
      parts.push('1. 使用任何资源前先读对应技能文件，技能与你的猜测冲突时以技能为准；技能没提的能力不要臆造；')
      parts.push('2. 连接被拒/超时视为端口可能已漂移，向调度方报告一次即可，不要反复重试或探测；')
      parts.push('3. 凭证仅限本任务使用，不得写入脚本文件、不得转发给第三方。')
    }

    return { block: parts.join('\n'), resources, warnings }
  }
}
