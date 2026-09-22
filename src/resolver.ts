/**
 * onenat-workbuddy-web - 子智能体运行时解析器（D1 端口漂移免疫）
 *
 * SubAgent.dshRef（稳定 ID）→ ResolvedDshTarget（当下 baseUrl + apiKey）
 * 每次派发前调用，绝不缓存公网 URL。
 */

import type { WorkStore } from './store.js'
import { OnenatDirectory } from './onenat.js'
import { DshClient } from './remote-client.js'
import type { ResolvedDshTarget, SubAgent } from './types.js'

export class AgentResolver {
  constructor(
    private store: WorkStore,
    private directory: OnenatDirectory,
  ) {}

  /**
   * 按节点引用（dshRef 形状）解析执行目标 —— 专家与节点解耦的基础：
   * 项目/任务指定执行节点，专家只携带角色配置；agentId 仅作标识回传。
   */
  public async resolveRef(dshRef: import('./types.js').DshRef, apiKey?: string, agentId = 'node'): Promise<ResolvedDshTarget> {
    const base: ResolvedDshTarget = {
      baseUrl: '',
      agentId,
      resolvedAt: Date.now(),
      online: false,
    }
    try {
      await this.directory.refresh(true)
    } catch (err: any) {
      // 直连实体（apiBaseUrl 固定）不依赖 ONENAT 目录：刷新失败不阻断解析，
      // 否则 ONENAT 抖动会把本地直连的主智能体也判成不可达（模型目录/消息路由全部失效）。
      if (dshRef.kind !== 'direct') {
        return { ...base, error: `ONENAT 资源刷新失败: ${err?.message || err}` }
      }
    }

    let endpointBaseUrl: string | undefined
    let mappingId: string | undefined
    let credMappingId: string | undefined

    if (dshRef.kind === 'direct') {
      endpointBaseUrl = dshRef.apiBaseUrl
    } else if (dshRef.kind === 'mapping') {
      const ep = this.directory.resolveMapping(dshRef.mappingId)
      if (!ep) return { ...base, error: `映射 ${dshRef.mappingId} 已不存在（请重新绑定 DSH 节点）` }
      if (!ep.online || !ep.baseUrl) {
        return { ...base, mappingId: ep.mappingId, error: `映射「${ep.tunnelName}/${ep.note || ep.mappingId}」当前离线或不可达` }
      }
      endpointBaseUrl = ep.baseUrl
      mappingId = ep.mappingId
      credMappingId = ep.mappingId
    } else {
      const ep = this.directory.resolveApp(dshRef.appId)
      if (!ep) return { ...base, error: `应用 ${dshRef.appId} 未绑定任何映射或已删除` }
      if (!ep.online || !ep.baseUrl) {
        return { ...base, mappingId: ep.mappingId, error: `应用「${ep.appName || dshRef.appId}」当前离线` }
      }
      endpointBaseUrl = ep.baseUrl
      mappingId = ep.mappingId
      credMappingId = ep.mappingId
    }

    // API Key: 显式配置优先；否则经映射凭证接口解析（Bearer 型）
    let key = apiKey?.trim() || undefined
    if (!key && credMappingId) {
      const cred = await this.directory.fetchMappingCredentials(credMappingId)
      if (cred.ok) key = cred.apiKey || cred.token || undefined
      // 凭证不可用不阻断：公网 DSH 可能无需鉴权，由 ping 阶段暴露问题
    }

    return {
      baseUrl: endpointBaseUrl.replace(/\/+$/, ''),
      apiKey: key,
      agentId,
      mappingId,
      resolvedAt: Date.now(),
      online: true,
    }
  }

  /** 解析单个专家：节点取专家的遗留默认绑定（兼容旧数据；新模型由项目/任务指定节点） */
  public async resolve(agent: SubAgent): Promise<ResolvedDshTarget> {
    return this.resolveRef(agent.dshRef, agent.apiKey, agent.id)
  }

  /** 解析 + 探活（/system/status），返回带健康信息的目标 */
  public async resolveWithPing(agent: SubAgent): Promise<{ target?: ResolvedDshTarget; ping?: { ok: boolean; name?: string; version?: string; providers?: string[]; error?: string } }> {
    const target = await this.resolve(agent)
    if (!target.online || !target.baseUrl) return { ping: { ok: false, error: target.error } }
    const ping = await new DshClient().ping(target)
    return { target, ping }
  }

  /** 任务成员批量解析；返回成功目标 + 问题清单（离线成员跳过不阻断） */
  public async resolveMembers(agentIds: string[]): Promise<{ targets: Map<string, ResolvedDshTarget>; issues: Array<{ agentId: string; name: string; error: string }> }> {
    const targets = new Map<string, ResolvedDshTarget>()
    const issues: Array<{ agentId: string; name: string; error: string }> = []
    for (const id of agentIds) {
      const agent = this.store.getAgent(id)
      if (!agent) {
        issues.push({ agentId: id, name: id, error: '子智能体不存在（可能已被删除）' })
        continue
      }
      if (!agent.enabled) {
        issues.push({ agentId: id, name: agent.name, error: '子智能体已被停用' })
        continue
      }
      const target = await this.resolve(agent)
      if (!target.online || !target.baseUrl) {
        issues.push({ agentId: id, name: agent.name, error: target.error || '解析失败' })
        continue
      }
      targets.set(id, target)
    }
    return { targets, issues }
  }
}
