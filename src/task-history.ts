import { createHmac, randomBytes } from 'node:crypto'
import type { WorkStore } from './store.js'
import type { WorkTask } from './types.js'
import { canAccessProject, canUseAgent, canViewTask, type PermSession } from './perm.js'

export class TaskHistoryError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}
const fail = (status: number, code: string, text: string): never => { throw new TaskHistoryError(status, code, text) }
const statuses = new Set(['draft', 'running', 'completed', 'failed', 'partial_success', 'success', 'cancelled'])

/** Candidate/default member lists do not prove execution. Binding also includes zero-turn drafts. */
export function taskParticipation(t: WorkTask, agentId: string): 'direct' | 'participant' | undefined {
  if (t.chatAgentId === agentId) return 'direct'
  if (Object.hasOwn(t.sessions || {}, agentId) || t.turns.some(x => x.agentId === agentId)
    || t.plan?.subtasks.some(x => x.agentId === agentId) || t.lastRoute?.agentId === agentId) return 'participant'
  return undefined
}
function activity(t: WorkTask): number {
  return Math.max(t.updatedAt, t.createdAt, ...t.turns.slice(-1).map(x => x.endedAt || x.at))
}
interface Query { agentId: string; projectId: string; participation: string; status: string; archived: string; limit: number }
interface Snapshot { principal: string; query: Query; ids: string[]; at: number }

/** Bounded process-local query snapshots: immutable ordering, live ACL and live response fields. */
export class TaskHistory {
  private secret = randomBytes(32)
  private snapshots = new Map<string, Snapshot>()
  constructor(private store: WorkStore, private now = Date.now) {}
  private signature(value: string) { return createHmac('sha256', this.secret).update(value).digest('base64url') }
  private visible(t: WorkTask, session: PermSession): boolean {
    const p = t.projectId ? this.store.getProject(t.projectId) : undefined
    // A legacy ownerless task cannot bypass an existing private project's ACL.
    return canViewTask(session, t, { projects: this.store.getProjects() })
      && (p ? canAccessProject(session, p) : !t.projectId || session.role === 'admin' || t.ownerUserId === session.userId)
  }
  private row(t: WorkTask, q: Query, session: PermSession) {
    const p = t.projectId ? this.store.getProject(t.projectId) : undefined
    const a = q.agentId ? this.store.getAgent(q.agentId) : undefined
    const participation = q.agentId ? taskParticipation(t, q.agentId)! : null
    const reason = !t.chatAgentId ? 'unbound_task' : q.agentId && participation !== 'direct' ? 'collaboration'
      : t.projectId && !p ? 'project_deleted' : p?.archivedAt ? 'project_archived'
      : !this.store.getAgent(t.chatAgentId) ? 'agent_deleted'
      : this.store.getAgent(t.chatAgentId)?.enabled === false ? 'agent_disabled'
      : !canUseAgent(session, this.store.getAgent(t.chatAgentId)!, { projects: this.store.getProjects() }) ? 'agent_forbidden' : null
    const summary = t.summary?.finalConclusion || t.summary?.overview || t.turns.at(-1)?.text || ''
    return { taskId: t.id, title: t.title, projectId: t.projectId || null,
      project: p ? { projectId: p.id, name: p.name, status: p.archivedAt ? 'archived' : 'active' }
        : t.projectId ? { projectId: t.projectId, name: t.projectSnapshot?.name || null, status: 'deleted' } : null,
      projectSnapshot: t.projectSnapshot || null,
      status: t.status, createdAt: t.createdAt, updatedAt: t.updatedAt, lastActivityAt: activity(t),
      archivedAt: t.archivedAt || null, participation, chatAgentId: t.chatAgentId || null,
      agentStatus: q.agentId ? !a ? 'deleted' : a.enabled === false ? 'disabled' : 'available' : null,
      canContinueDirect: reason === null, continuationReason: reason,
      summary: summary.slice(0, 800), summaryTruncated: summary.length > 800 }
  }
  list(params: URLSearchParams, session?: PermSession) {
    if (!session?.userId) return fail(403, 'PERMISSION_DENIED', '历史索引需要绑定用户的登录身份')
    const principal = JSON.stringify([session.userId, session.role || ''])
    const now = this.now()
    for (const [id, s] of this.snapshots) if (now - s.at >= 15 * 60_000) this.snapshots.delete(id)
    let key: string, offset = 0, snapshot: Snapshot
    const cursor = params.get('cursor')
    if (cursor) {
      const parts = cursor.split('.')
      const value = parts.slice(0, 2).join('.')
      if (parts.length !== 3 || this.signature(value) !== parts[2] || !/^\d+$/.test(parts[1])) return fail(400, 'INVALID_CURSOR', '分页游标无效')
      key = parts[0]; offset = Number(parts[1])
      const saved = this.snapshots.get(key)
      if (!saved || saved.principal !== principal) return fail(410, 'CURSOR_EXPIRED', '分页已过期，请重新查询')
      snapshot = saved
      for (const [name, value] of params) {
        if (name === 'cursor') continue
        if (!(name in snapshot.query) || String(snapshot.query[name as keyof Query]) !== value) return fail(400, 'INVALID_CURSOR', '续页查询参数必须保持不变')
      }
    } else {
      const rawLimit = params.get('limit') ?? '50'
      if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 200) return fail(400, 'INVALID_PARAM', 'limit 必须为 1 到 200 的整数')
      const q: Query = { agentId: params.get('agentId') || '', projectId: params.get('projectId') || '', participation: params.get('participation') || 'all', status: params.get('status') || '', archived: params.get('archived') || 'all', limit: Number(rawLimit) }
      if (!['all', 'direct', 'participant'].includes(q.participation) || !['all', 'active', 'archived'].includes(q.archived) || q.status && !q.status.split(',').every(s => statuses.has(s)) || !q.agentId && q.participation !== 'all') return fail(400, 'INVALID_PARAM', '历史查询条件无效')
      const tasks = this.store.getTasks().filter(t => this.visible(t, session))
      if (q.projectId) {
        const p = this.store.getProject(q.projectId)
        if (p ? !canAccessProject(session, p) : !tasks.some(t => t.projectId === q.projectId)) return fail(404, 'NOT_FOUND', '项目不存在')
      }
      // Historical participation does not grant BOT configuration/use access, but permits discovery of visible task history.
      if (q.agentId && !tasks.some(t => taskParticipation(t, q.agentId))) {
        const a = this.store.getAgent(q.agentId)
        if (!a || !canUseAgent(session, a, { projects: this.store.getProjects() })) return fail(404, 'NOT_FOUND', 'BOT 不存在')
      }
      const selected = tasks.filter(t => (!q.projectId || t.projectId === q.projectId)
        && (!q.agentId || taskParticipation(t, q.agentId) && (q.participation === 'all' || taskParticipation(t, q.agentId) === q.participation))
        && (!q.status || q.status.split(',').includes(t.status))
        && (q.archived === 'all' || Boolean(t.archivedAt) === (q.archived === 'archived')))
      selected.sort((a, b) => activity(b) - activity(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      key = randomBytes(18).toString('base64url')
      snapshot = { principal, query: q, ids: selected.map(t => t.id), at: now }
      if (selected.length > q.limit) {
        const owned = [...this.snapshots.values()].filter(s => s.principal === principal).length
        if (owned >= 10 || this.snapshots.size >= 1000) return fail(429, 'HISTORY_QUERY_LIMIT', '历史查询过多，请复用现有游标或稍后重试')
        this.snapshots.set(key, snapshot)
      }
    }
    const rows = []
    while (offset < snapshot.ids.length && rows.length < snapshot.query.limit) {
      const task = this.store.getTask(snapshot.ids[offset++])
      if (!task || !this.visible(task, session) || snapshot.query.projectId && task.projectId !== snapshot.query.projectId
        || snapshot.query.agentId && !taskParticipation(task, snapshot.query.agentId)) continue
      rows.push(this.row(task, snapshot.query, session))
    }
    const more = offset < snapshot.ids.length
    const value = `${key}.${offset}`
    return { items: rows, nextCursor: more ? `${value}.${this.signature(value)}` : null, hasMore: more,
      snapshotAt: snapshot.at, expiresAt: snapshot.at + 15 * 60_000, sort: 'lastActivityAt_desc_taskId_asc', source: 'task_ledger' }
  }
}
