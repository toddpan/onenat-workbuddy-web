/** Pure monitor projection shared by HTTP and tools. The caller supplies an ACL-filtered scope. */
import type { AgentMonitor, MonitorOverview, NodeMonitor, TaskMonitor } from './monitor.js'
import type { DshRef, Project, WorkTask } from './types.js'
import { projectDefaultAgentIds } from './types.js'
import { dshRefKey } from './workspace.js'
import { sumUsageSince } from './token-stats.js'

export const MONITOR_SECTIONS = ['kpi', 'agents', 'nodes', 'tasks', 'schedules', 'sshPool', 'alerts', 'events'] as const
export type MonitorSection = typeof MONITOR_SECTIONS[number]
export interface MonitorQueryOptions {
  projectId?: string
  section?: string
  compact?: boolean | string
  limit?: string | number
}
export interface MonitorQueryScope { projects: Project[]; tasks: WorkTask[] }
export interface MonitorArrayMetadata { total: number; returned: number; hasMore: boolean }
export interface MonitorQueryMetadata {
  projectId?: string
  compact: boolean
  limit: number
  /** Array sizes before/after projection; nested paths are included when truncated. */
  sections: Record<string, MonitorArrayMetadata>
  /** Totals describe this snapshot, not the full historical event/alert store. */
  totalSource: 'overviewSnapshot'
  omittedFields: string[]
  truncatedFields: string[]
}
export type MonitorQueryResult = { at: number; metadata?: MonitorQueryMetadata }
  & Partial<Omit<MonitorOverview, 'at' | 'kpi' | 'agents' | 'nodes' | 'tasks'>>
  & { kpi?: Partial<MonitorOverview['kpi']>; agents?: Partial<AgentMonitor>[]; nodes?: Partial<NodeMonitor>[]; tasks?: (Partial<TaskMonitor> & { projectId?: string; nodeId?: string })[] }

export class MonitorQueryError extends Error {
  constructor(message: string, public readonly status: 400 | 404) { super(message); this.name = 'MonitorQueryError' }
}

function parseOptions(options: MonitorQueryOptions | undefined) {
  if (options === undefined) return undefined
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new MonitorQueryError('options must be an object', 400)
  const { projectId, section, compact, limit } = options
  if (projectId !== undefined && (typeof projectId !== 'string' || !projectId.trim())) throw new MonitorQueryError('projectId must be a non-empty string', 400)
  if (section !== undefined && (typeof section !== 'string' || !section.trim())) throw new MonitorQueryError('section must be a comma-separated section list', 400)
  const sections = section === undefined ? [...MONITOR_SECTIONS] : [...new Set(section.split(',').map((s) => s.trim()))]
  if (sections.some((s) => !MONITOR_SECTIONS.includes(s as MonitorSection))) throw new MonitorQueryError(`Invalid monitor section: ${section}`, 400)
  if (compact !== undefined && typeof compact !== 'boolean' && compact !== 'true' && compact !== 'false') throw new MonitorQueryError('compact must be true or false', 400)
  if (limit !== undefined && (typeof limit !== 'number' && typeof limit !== 'string' || typeof limit === 'string' && !/^\d+$/.test(limit))) throw new MonitorQueryError('limit must be a positive integer', 400)
  const count = limit === undefined ? 30 : Number(limit)
  if (!Number.isSafeInteger(count) || count < 1 || count > 200) throw new MonitorQueryError('limit must be an integer from 1 to 200', 400)
  if (projectId === undefined && section === undefined && compact === undefined && limit === undefined) return undefined
  return { projectId: projectId?.trim(), sections: sections as MonitorSection[], compact: compact === true || compact === 'true', limit: Math.min(count, 200) }
}

/** Include actual referenced members, including previous sessions and plan participants. */
function taskAgentIds(task: WorkTask): string[] {
  return [...new Set([
    ...task.memberAgentIds, ...Object.keys(task.sessions || {}),
    ...(task.plan?.subtasks.map((s) => s.agentId) || []),
    ...(task.expertMembers?.map((a) => a.id) || []),
    ...(task.lastRoute?.agentId ? [task.lastRoute.agentId] : []),
  ].filter((id): id is string => Boolean(id) && id !== '__node__'))]
}

function nodeKeys(ref: DshRef | undefined): string[] {
  const key = dshRefKey(ref)
  return key ? [key, ...(ref?.kind === 'mapping' ? [ref.mappingId.trim()] : [])] : []
}
function taskNodeKeys(task: WorkTask, project: Project): Set<string> {
  const session = task.sessions?.['__node__']
  // Persisted session identity is authoritative after app remapping; URLs are never identity evidence.
  if (session?.resolvedMappingId) return new Set([session.resolvedMappingId, `mapping:${session.resolvedMappingId}`])
  if (session?.nodeRefKey) return new Set([session.nodeRefKey, ...(session.nodeRefKey.startsWith('mapping:') ? [session.nodeRefKey.slice(8)] : [])])
  return new Set(nodeKeys(task.nodeRef ?? project.defaultExecutionNodeRef ?? project.dshRef))
}
function matchesNode(node: NodeMonitor, keys: Set<string>): boolean {
  return keys.has(node.key) || Boolean(node.mappingId && (keys.has(node.mappingId) || keys.has(`mapping:${node.mappingId}`)))
}

export function queryMonitorOverview(overview: MonitorOverview, options: MonitorQueryOptions | undefined, scope: MonitorQueryScope): MonitorQueryResult {
  const query = parseOptions(options)
  // Legacy consumers get the exact shape and ordering, with no new metadata or default truncation.
  if (!query) return overview
  const project = query.projectId === undefined ? undefined : scope.projects.find((p) => p.id === query.projectId)
  if (query.projectId !== undefined && !project) throw new MonitorQueryError(`Project not found: ${query.projectId}`, 404)
  const metadata: MonitorQueryMetadata = { ...(project ? { projectId: project.id } : {}), compact: query.compact, limit: query.limit, totalSource: 'overviewSnapshot', sections: {}, omittedFields: [], truncatedFields: [] }
  const omit = (path: string) => { if (!metadata.omittedFields.includes(path)) metadata.omittedFields.push(path) }
  const tasks = scope.tasks.filter((t) => !project || t.projectId === project.id)
  const taskMap = new Map(tasks.map((t) => [t.id, t]))
  const taskIds = new Set(taskMap.keys())
  const members = new Map(tasks.map((t) => [t.id, taskAgentIds(t)]))
  const agentIds = new Set([...(project ? projectDefaultAgentIds(project) : []), ...[...members.values()].flat()])
  const dayStart = new Date(overview.at); dayStart.setHours(0, 0, 0, 0)
  const since = dayStart.getTime()
  const taskViews = (overview.tasks ?? []).filter((t) => !project || taskIds.has(t.id)).map((t) => ({
    ...t, ...(taskMap.get(t.id)?.projectId ? { projectId: taskMap.get(t.id)!.projectId } : {}),
    ...(taskMap.get(t.id)?.nodeRef ? { nodeId: dshRefKey(taskMap.get(t.id)!.nodeRef) } : {}),
    ...(project ? { agentIds: members.get(t.id) || [] } : {}),
  }))
  const runningIds = new Set(taskViews.filter((t) => t.running).map((t) => t.id))
  const connectorIds = new Set([...(project?.connectorIds || []), ...tasks.flatMap((t) => t.connectorIds || [])])
  const agents = (overview.agents ?? []).filter((a) => !project || agentIds.has(a.id)).map((a) => {
    if (!project) return a
    const mine = tasks.filter((t) => members.get(t.id)?.includes(a.id))
    const running = mine.filter((t) => runningIds.has(t.id))
    const { live, currentActivity, lastActiveAt, resources, ...safe } = a
    omit('agents.currentActivity')
    if (live && !taskIds.has(live.taskId)) omit('agents.live')
    // busy remains the actual dispatch state; counts and KPI below are project-scoped.
    return { ...safe, busy: a.busy, runningCount: running.length, taskCount: mine.length,
      ...(mine.length ? { lastActiveAt: Math.max(...mine.map((t) => t.updatedAt)) } : {}),
      ...(live && taskIds.has(live.taskId) ? { live } : {}),
      resources: resources.filter((r) => connectorIds.has(r.ref) || r.inUse.some((u) => taskIds.has(u.taskId))).map((r) => ({ ...r, inUse: r.inUse.filter((u) => taskIds.has(u.taskId)) })),
    }
  })
  const relatedNodes = new Set(project ? [...nodeKeys(project.dshRef), ...nodeKeys(project.defaultExecutionNodeRef), ...tasks.flatMap((t) => [...taskNodeKeys(t, project)])] : [])
  const nodes = (overview.nodes ?? []).filter((n) => !project || matchesNode(n, relatedNodes)).map((n) => {
    if (!project) return n
    const mine = tasks.filter((t) => t.status !== 'draft' && matchesNode(n, taskNodeKeys(t, project)))
    const running = mine.filter((t) => runningIds.has(t.id))
    const last = [...mine].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    const current = running[0]
    const { currentActivity, currentTaskId, lastTaskTitle, lastActivityAt, model, ...safe } = n
    omit('nodes.model'); omit('nodes.currentActivity')
    return { ...safe, runningCount: running.length, tasksTotal: mine.length, tasksToday: mine.filter((t) => t.createdAt >= since).length,
      ...(last ? { lastActivityAt: last.updatedAt, lastTaskTitle: last.title } : {}), ...(current ? { currentTaskId: current.id } : {}) }
  })
  const usage = sumUsageSince(tasks, since)
  const kpi: Partial<MonitorOverview['kpi']> = project ? {
    agentsTotal: agents.length, agentsOnline: agents.filter((a) => a.online).length,
    agentsBusy: agents.filter((a) => a.runningCount > 0).length, agentsDisabled: agents.filter((a) => !a.enabled).length,
    tasksRunning: runningIds.size,
    tasksCompletedToday: tasks.filter((t) => t.updatedAt >= since && (t.status === 'completed' || t.status === 'success')).length,
    tasksFailedToday: tasks.filter((t) => t.updatedAt >= since && t.status === 'failed').length,
    tokensInputToday: usage.tokensIn, tokensOutputToday: usage.tokensOut, cacheReadToday: usage.cacheRead, toolCallsToday: usage.toolCalls,
  } : overview.kpi
  if (project) for (const key of Object.keys(overview.kpi ?? {})) if (!(key in kpi)) omit(`kpi.${key}`)
  // A schedule spawning a project task does not make the schedule's other runs project-owned.
  if (project) omit('schedules.*')
  const sections = {
    kpi, agents, nodes, tasks: taskViews,
    schedules: project ? [] : overview.schedules ?? [],
    sshPool: project ? (overview.sshPool ?? []).filter((r) => connectorIds.has(`ssh:${r.id}`) || connectorIds.has(r.id)).map((r) => ({ ...r, inUse: r.inUse.filter((u) => taskIds.has(u.taskId)) })) : overview.sshPool ?? [],
    alerts: (overview.alerts ?? []).filter((a) => !project || a.refType === 'task' && Boolean(a.refId && taskIds.has(a.refId)) || a.refType === 'agent' && Boolean(a.refId && agentIds.has(a.refId))).map((a) => {
      // Task alerts may aggregate same-title failures across projects in the source overview.
      if (project && a.refType === 'task') return { ...a, msg: `任务「${taskMap.get(a.refId!)!.title}」失败` }
      return a
    }),
    events: (overview.events ?? []).filter((e) => !project || (e.taskId ? taskIds.has(e.taskId) : Boolean(e.agentId && agentIds.has(e.agentId)))),
  }
  const compactKeys: Partial<Record<MonitorSection, string[]>> = {
    agents: ['id', 'name', 'nodeId', 'enabled', 'online', 'busy', 'runningCount', 'taskCount'],
    nodes: ['key', 'name', 'mappingId', 'online', 'runningCount', 'tasksTotal', 'tasksToday', 'currentTaskId'],
    tasks: ['id', 'title', 'projectId', 'nodeId', 'status', 'running', 'agentIds', 'updatedAt'],
    schedules: ['id', 'name', 'enabled', 'nextRunAt', 'lastRunOk'],
    sshPool: ['id', 'name', 'ok', 'lastTestedAt'],
  }
  function projectValue(value: unknown, path: string): unknown {
    if (Array.isArray(value)) {
      if (MONITOR_SECTIONS.includes(path as MonitorSection) || value.length > query!.limit) {
        metadata.sections[path] = { total: value.length, returned: Math.min(value.length, query!.limit), hasMore: value.length > query!.limit }
      }
      return value.slice(0, query!.limit).map((v, index) => projectValue(v, `${path}[${index}]`))
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      const keys = query!.compact ? compactKeys[path as MonitorSection] || compactKeys[path.replace(/\[\d+\]$/, '') as MonitorSection] : undefined
      for (const [key, item] of Object.entries(value)) {
        if (keys && !keys.includes(key)) { omit(`${path.replace(/\[\d+\]/g, '[]')}.${key}`); continue }
        out[key] = projectValue(item, `${path}.${key}`)
      }
      return out
    }
    if (query!.compact && typeof value === 'string' && /\.(name|title|msg|description|headline|currentActivity|error)$/.test(path) && value.length > 100) {
      if (!metadata.truncatedFields.includes(path)) metadata.truncatedFields.push(path)
      return `${value.slice(0, 99)}…`
    }
    return value
  }
  const result: Record<string, unknown> = { at: overview.at }
  for (const section of query.sections) result[section] = projectValue(sections[section], section)
  // Metadata describes only requested sections, keeping a single-section response small.
  metadata.omittedFields = metadata.omittedFields.filter((path) => query.sections.includes(path.split(/[.[]/, 1)[0] as MonitorSection))
  result.metadata = metadata
  return result as MonitorQueryResult
}
