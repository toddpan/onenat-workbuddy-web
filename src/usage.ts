/**
 * onenat-workbuddy-web - Token 消耗明细归因（只读聚合，零台账设计）
 *
 * 数据基础：TaskTurn.usage（逐轮真实 token 账本）+ WorkTask 既有归因字段
 * （scheduleId/scheduleName、projectId、memberAgentIds、creator），无需新建存储。
 *
 * 归因规则（按优先级）：
 *   source: scheduleId → 'schedule'；creator 'console' → 'console'；
 *           creator 'tool' → 'tool'；mode 'orchestrate' → 'orchestrate'；其余 → 'chat'
 *   agent:  逐轮优先取 turn.agentId，缺失回退任务首个 memberAgentIds
 *   project: task.projectId；schedule: task.scheduleId
 *   「其他零散」= 无项目、无定时来源的任务（bySource 里 chat/console/tool 等）
 */

import type { WorkStore } from './store.js'
import type { WorkTask, TaskTurn } from './types.js'

export type UsageSource = 'schedule' | 'chat' | 'orchestrate' | 'console' | 'tool'

export interface UsageRecord {
  at: number
  taskId: string
  taskTitle: string
  turnId: string
  seq: number
  source: UsageSource
  model?: string
  input: number
  output: number
  cacheRead: number
  total: number
  projectId?: string
  projectName?: string
  scheduleId?: string
  scheduleName?: string
  agentId?: string
  agentName?: string
}

export interface UsageGroup {
  key: string
  label: string
  input: number
  output: number
  cacheRead: number
  total: number
  turns: number
  tasks: number
}

export interface UsageSummary {
  from: number
  to: number
  total: { input: number; output: number; cacheRead: number; total: number; turns: number; tasks: number }
  bySource: UsageGroup[]
  byProject: UsageGroup[]
  byAgent: UsageGroup[]
  bySchedule: UsageGroup[]
  /** 任务级小计（供报表首层下钻），按消耗降序 */
  byTask: UsageGroup[]
}

export const SOURCE_LABELS: Record<UsageSource, string> = {
  schedule: '定时任务',
  chat: '普通会话',
  orchestrate: '编排任务',
  console: '控制台',
  tool: 'AI 工具通道',
}

/** token 账本求和：兼容多种字段命名（inputTokens/prompt_tokens/…），与 monitor.usageOf 同源逻辑 */
function usageOf(usage: Record<string, number> | undefined): { input: number; output: number; cacheRead: number } {
  const u = usage || {}
  let input = 0
  let output = 0
  let cacheRead = 0
  for (const [k, v] of Object.entries(u)) {
    if (typeof v !== 'number') continue
    const key = k.toLowerCase()
    if (key.includes('cache') && (key.includes('read') || key.includes('hit'))) cacheRead += v
    else if (key.includes('input') || key.includes('prompt')) input += v
    else if (key.includes('output') || key.includes('completion')) output += v
  }
  return { input, output, cacheRead }
}

function sourceOf(t: WorkTask): UsageSource {
  if (t.scheduleId) return 'schedule'
  if (t.creator === 'console') return 'console'
  if (t.creator === 'tool') return 'tool'
  if (t.mode === 'orchestrate') return 'orchestrate'
  return 'chat'
}

export class UsageService {
  constructor(private store: WorkStore) {}

  /** 展开任务为逐轮用量记录（含归因字段），时间倒序 */
  private collectRecords(from: number, to: number): UsageRecord[] {
    const agents = new Map(this.store.getAgents().map((a) => [a.id, a]))
    const projects = new Map(this.store.getProjects().map((p) => [p.id, p]))
    const out: UsageRecord[] = []
    for (const t of this.store.getTasks()) {
      const source = sourceOf(t)
      const project = t.projectId ? projects.get(t.projectId) : undefined
      const fallbackAgent = t.memberAgentIds?.[0] ? agents.get(t.memberAgentIds[0]) : undefined
      for (const turn of t.turns || []) {
        if (turn.at < from || turn.at > to) continue
        const u = usageOf(turn.usage)
        if (u.input === 0 && u.output === 0 && u.cacheRead === 0) continue
        const agent = (turn.agentId ? agents.get(turn.agentId) : undefined) || fallbackAgent
        out.push({
          at: turn.at,
          taskId: t.id,
          taskTitle: t.title || t.id,
          turnId: turn.id,
          seq: turn.seq,
          source,
          model: t.model,
          input: u.input,
          output: u.output,
          cacheRead: u.cacheRead,
          total: u.input + u.output,
          projectId: t.projectId,
          projectName: project?.name,
          scheduleId: t.scheduleId,
          scheduleName: t.scheduleName,
          agentId: agent?.id || turn.agentId,
          agentName: agent?.name || turn.agentName,
        })
      }
    }
    out.sort((a, b) => b.at - a.at)
    return out
  }

  private groupBy(records: UsageRecord[], keyOf: (r: UsageRecord) => { key: string; label: string } | undefined): UsageGroup[] {
    const map = new Map<string, UsageGroup & { taskIds: Set<string> }>()
    for (const r of records) {
      const k = keyOf(r)
      if (!k) continue
      let g = map.get(k.key)
      if (!g) {
        g = { key: k.key, label: k.label, input: 0, output: 0, cacheRead: 0, total: 0, turns: 0, tasks: 0, taskIds: new Set() }
        map.set(k.key, g)
      }
      g.input += r.input
      g.output += r.output
      g.cacheRead += r.cacheRead
      g.total += r.total
      g.turns += 1
      g.taskIds.add(r.taskId)
    }
    return [...map.values()]
      .map(({ taskIds, ...g }) => ({ ...g, tasks: taskIds.size }))
      .sort((a, b) => b.total - a.total)
  }

  public summary(from: number, to: number): UsageSummary {
    const records = this.collectRecords(from, to)
    const taskIds = new Set(records.map((r) => r.taskId))
    const total = {
      input: records.reduce((s, r) => s + r.input, 0),
      output: records.reduce((s, r) => s + r.output, 0),
      cacheRead: records.reduce((s, r) => s + r.cacheRead, 0),
      total: records.reduce((s, r) => s + r.total, 0),
      turns: records.length,
      tasks: taskIds.size,
    }
    return {
      from,
      to,
      total,
      bySource: this.groupBy(records, (r) => ({ key: r.source, label: SOURCE_LABELS[r.source] })),
      byProject: this.groupBy(records, (r) => r.projectId
        ? { key: r.projectId, label: r.projectName || r.projectId }
        : { key: '__none__', label: '未关联项目' }),
      byAgent: this.groupBy(records, (r) => r.agentId
        ? { key: r.agentId, label: r.agentName || r.agentId }
        : { key: '__none__', label: '未指定智能体' }),
      bySchedule: this.groupBy(records, (r) => r.scheduleId
        ? { key: r.scheduleId, label: r.scheduleName || r.scheduleId }
        : undefined),
      byTask: this.groupBy(records, (r) => ({ key: r.taskId, label: r.taskTitle })),
    }
  }

  public records(opts: {
    from: number
    to: number
    source?: string
    projectId?: string
    agentId?: string
    scheduleId?: string
    taskId?: string
    limit?: number
  }): UsageRecord[] {
    let list = this.collectRecords(opts.from, opts.to)
    if (opts.source) list = list.filter((r) => r.source === opts.source)
    if (opts.projectId) list = list.filter((r) => r.projectId === opts.projectId)
    if (opts.agentId) list = list.filter((r) => r.agentId === opts.agentId)
    if (opts.scheduleId) list = list.filter((r) => r.scheduleId === opts.scheduleId)
    if (opts.taskId) list = list.filter((r) => r.taskId === opts.taskId)
    const limit = Math.min(Math.max(1, opts.limit || 500), 2000)
    return list.slice(0, limit)
  }
}
