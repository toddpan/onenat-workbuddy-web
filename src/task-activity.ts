import { createHash } from 'node:crypto'
import type { WorkStore } from './store.js'
import type { WorkTask } from './types.js'
import { canAccessProject, canViewTask, type PermSession } from './perm.js'
import { taskParticipation, TaskHistoryError } from './task-history.js'

export type ActivityState = 'waiting_reply' | 'running' | 'completed' | 'failed' | 'cancelled' | 'draft' | 'unknown'
const emptyCounts = () => ({ total: 0, waitingReply: 0, running: 0, completed: 0, failed: 0, unread: 0 })
type Counts = ReturnType<typeof emptyCounts>

/** The same live ACL as the task-90 index, including private legacy project tasks. */
export function visibleActivityTask(store: WorkStore, task: WorkTask, session: PermSession): boolean {
  const project = task.projectId ? store.getProject(task.projectId) : undefined
  return canViewTask(session, task, { projects: store.getProjects() })
    && (project ? canAccessProject(session, project) : !task.projectId || session.role === 'admin' || task.ownerUserId === session.userId)
}

export class TaskActivity {
  constructor(private store: WorkStore, private running: (id: string) => boolean = () => false, private now = Date.now) {}

  private principal(session?: PermSession): PermSession & { userId: string } {
    if (!session?.userId) throw new TaskHistoryError(403, 'PERMISSION_DENIED', '活动与阅读位置需要绑定用户的登录身份')
    return session as PermSession & { userId: string }
  }

  private row(task: WorkTask, session: PermSession & { userId: string }) {
    const pendingAsk = task.pendingAsk?.questions?.length ? {
      agentId: task.pendingAsk.agentId, turnId: task.pendingAsk.turnId, at: task.pendingAsk.at,
    } : null
    const running = this.running(task.id)
    const state: ActivityState = pendingAsk ? 'waiting_reply' : running ? 'running'
      : ['completed', 'success', 'partial_success'].includes(task.status) ? 'completed'
      : task.status === 'failed' ? 'failed' : task.status === 'cancelled' ? 'cancelled'
      : task.status === 'draft' ? 'draft' : 'unknown'
    // Exclude updatedAt, connection probes, token/log churn and read receipts. Include
    // content and question identity so equal timestamps and same-length edits still advance.
    const signature = createHash('sha256').update(JSON.stringify({ state, status: task.status,
      turns: task.turns.map(t => ({ id: t.id, seq: t.seq, role: t.role, agentId: t.agentId,
        text: t.text, reasoning: t.reasoning, streaming: t.streaming, queued: t.queued,
        tools: t.tools?.map(tool => ({ id: tool.id, name: tool.name, args: tool.args, result: tool.result,
          status: tool.status, awaiting: tool.awaiting })) })), summary: task.summary, pendingAsk: task.pendingAsk,
      subtasks: task.plan?.subtasks.map(s => ({ id: s.id, status: s.status, result: s.result })),
    })).digest('hex')
    const activityVersion = this.store.observeTaskActivity(task.id, signature)
    const readVersion = this.store.taskReadVersion(session.userId, task.id)
    const candidates = new Set([task.chatAgentId, ...Object.keys(task.sessions || {}),
      ...task.turns.map(t => t.agentId), ...(task.plan?.subtasks.map(s => s.agentId) || []),
      task.lastRoute?.agentId, pendingAsk?.agentId].filter((id): id is string => Boolean(id)))
    const agentIds = [...candidates].filter(id => id !== '__node__' && (taskParticipation(task, id) || pendingAsk?.agentId === id)).sort()
    return { taskId: task.id, agentId: task.chatAgentId || pendingAsk?.agentId || null, agentIds,
      projectId: task.projectId || null, activityVersion, readVersion, unread: activityVersion > readVersion,
      state, status: task.status, running, pendingAsk, updatedAt: task.updatedAt }
  }

  list(params: URLSearchParams, identity?: PermSession) {
    const session = this.principal(identity)
    for (const key of params.keys()) if (!['taskId', 'agentId', 'projectId'].includes(key)) throw new TaskHistoryError(400, 'INVALID_PARAM', `未知活动参数 ${key}`)
    const taskId = params.get('taskId'), agentId = params.get('agentId'), projectId = params.get('projectId')
    const visible = this.store.getTasks().filter(t => visibleActivityTask(this.store, t, session))
    if (taskId && !visible.some(t => t.id === taskId)) throw new TaskHistoryError(404, 'NOT_FOUND', '任务不存在')
    if (projectId) {
      const project = this.store.getProject(projectId)
      if (project ? !canAccessProject(session, project) : !visible.some(t => t.projectId === projectId)) throw new TaskHistoryError(404, 'NOT_FOUND', '项目不存在')
    }
    const items = visible.filter(t => {
      const p = t.projectId ? this.store.getProject(t.projectId) : undefined
      return (!taskId || t.id === taskId) && (!projectId || t.projectId === projectId)
        && (taskId || !t.archivedAt && (!t.projectId || p && !p.archivedAt))
    }).map(t => this.row(t, session)).filter(t => !agentId || t.agentIds.includes(agentId))
    const counts = emptyCounts(), agents = new Map<string, Counts>(), projects = new Map<string, Counts>()
    const add = (c: Counts, row: typeof items[number]) => {
      c.total++; if (row.unread) c.unread++
      if (row.state === 'waiting_reply') c.waitingReply++
      else if (row.state === 'running') c.running++
      else if (row.state === 'completed') c.completed++
      else if (row.state === 'failed') c.failed++
    }
    for (const row of items) {
      add(counts, row)
      for (const id of row.agentIds) { if (!agents.has(id)) agents.set(id, emptyCounts()); add(agents.get(id)!, row) }
      if (row.projectId) { if (!projects.has(row.projectId)) projects.set(row.projectId, emptyCounts()); add(projects.get(row.projectId)!, row) }
    }
    return { snapshotAt: this.now(), snapshotVersion: this.store.activityClock, source: 'task_ledger', items, counts,
      agents: [...agents].map(([agentId, counts]) => ({ agentId, counts })),
      projects: [...projects].map(([projectId, counts]) => ({ projectId, counts })) }
  }

  read(taskId: string, body: unknown, identity?: PermSession) {
    const session = this.principal(identity)
    const task = this.store.getTask(taskId)
    if (!task || !visibleActivityTask(this.store, task, session)) throw new TaskHistoryError(404, 'NOT_FOUND', '任务不存在')
    const row = this.row(task, session)
    const version = (body as { activityVersion?: unknown } | null)?.activityVersion
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1 || version > row.activityVersion) throw new TaskHistoryError(400, 'INVALID_PARAM', 'activityVersion 必须为已展示的有效活动版本')
    const readVersion = this.store.markTaskRead(session.userId, taskId, version)
    return { taskId, readVersion, activityVersion: row.activityVersion, unread: readVersion < row.activityVersion }
  }
}
