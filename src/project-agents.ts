/** BOT/project relationships. Projects own the only relationship list; tasks are history only. */
import type { WorkStore } from './store.js'
import { projectDefaultAgentIds, type Project, type WorkTask } from './types.js'
import { canAccessProject, canUseAgent, canViewTask, type PermSession } from './perm.js'

export class ProjectAgentError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}
const fail = (status: number, code: string, message: string): never => { throw new ProjectAgentError(status, code, message) }
export interface RelationshipActor { session?: PermSession; aiTokenOnly?: boolean; readOnly?: boolean }

export class ProjectAgents {
  constructor(private store: WorkStore) {}
  private visible(p: Project, actor: RelationshipActor): boolean {
    return Boolean(actor.session?.userId && canAccessProject(actor.session, p))
  }
  private requireReader(actor: RelationshipActor): void {
    if (!actor.session?.userId || actor.aiTokenOnly) fail(403, 'PERMISSION_DENIED', '关联查询需要控制台登录身份')
  }
  private project(id: string, actor: RelationshipActor): Project {
    const p = this.store.getProject(id)
    if (!p || !this.visible(p, actor)) return fail(404, 'NOT_FOUND', '项目不存在')
    return p
  }
  /** Validate BEFORE writing new defaults, so a proposed relationship cannot authorize itself. */
  validateAgents(ids: string[], actor: RelationshipActor): void {
    for (const id of ids) {
      const a = this.store.getAgent(id)
      if (!a || (actor.session && !canUseAgent(actor.session, a, { projects: this.store.getProjects() }))) {
        fail(404, 'NOT_FOUND', 'BOT 不存在或不可使用')
      }
    }
  }
  private used(task: WorkTask): string[] {
    // Defaults copied into memberAgentIds are candidates, not proof of actual participation.
    return [...new Set([
      ...Object.keys(task.sessions || {}).filter(id => id !== '__node__'),
      ...(task.turns || []).map(t => t.agentId || '').filter(Boolean),
      ...(task.plan?.subtasks || []).map(s => s.agentId).filter(Boolean),
    ])]
  }
  private tasks(actor: RelationshipActor): WorkTask[] {
    return this.store.getTasks().filter(t => !actor.session || canViewTask(actor.session, t, { projects: this.store.getProjects() }))
  }
  private bot(id: string) {
    const a = this.store.getAgent(id)
    return { agentId: id, name: a?.name || id, status: !a ? 'deleted' : a.enabled === false ? 'disabled' : 'available' }
  }
  forProject(id: string, actor: RelationshipActor = {}) {
    this.requireReader(actor)
    const p = this.project(id, actor)
    const linked = projectDefaultAgentIds(p)
    const tasks = this.tasks(actor).filter(t => t.projectId === id)
    const historical = [...new Set(tasks.flatMap(t => this.used(t)))].filter(a => !linked.includes(a))
    return { projectId: id, projectStatus: p.archivedAt ? 'archived' : 'active',
      linked: linked.map(a => this.bot(a)),
      historical: historical.map(a => ({ ...this.bot(a), taskCount: tasks.filter(t => this.used(t).includes(a)).length })) }
  }
  forAgent(id: string, actor: RelationshipActor = {}) {
    this.requireReader(actor)
    const a = this.store.getAgent(id)
    // Deleted IDs may still be queried through visible project/task history, without exposing private BOT config.
    const projects = this.store.getProjects().filter(p => this.visible(p, actor))
    const tasks = this.tasks(actor)
    if (a && actor.session && !canUseAgent(actor.session, a, { projects: this.store.getProjects() })) fail(404, 'NOT_FOUND', 'BOT 不存在或不可使用')
    const linked = projects.filter(p => projectDefaultAgentIds(p).includes(id))
    const historical = projects.filter(p => !linked.includes(p) && tasks.some(t => t.projectId === p.id && this.used(t).includes(id)))
    if (!a && !linked.length && !historical.length) fail(404, 'NOT_FOUND', 'BOT 不存在')
    const summary = (p: Project) => ({ projectId: p.id, name: p.name, status: p.archivedAt ? 'archived' : 'active' })
    return { ...this.bot(id), linked: linked.map(summary), historical: historical.map(p => ({ ...summary(p), taskCount: tasks.filter(t => t.projectId === p.id && this.used(t).includes(id)).length })) }
  }
  change(projectId: string, agentId: string, link: boolean, actor: RelationshipActor = {}) {
    if (!projectId || !agentId) fail(400, 'INVALID_PARAM', '需要 projectId 与 agentId')
    if (actor.readOnly || actor.aiTokenOnly || !actor.session?.userId) fail(403, 'PERMISSION_DENIED', '关联修改需要控制台登录身份')
    // No await between fresh read, ACL validation and mutation: serialized atomically within this process.
    const p = this.project(projectId, actor)
    if (actor.session && !canAccessProject(actor.session, p, 'edit')) fail(403, 'PERMISSION_DENIED', '仅项目 owner 或管理员可修改关联')
    if (p.archivedAt) fail(409, 'INVALID_STATE', '项目已归档，请先恢复')
    if (link) this.validateAgents([agentId], actor)
    const ids = projectDefaultAgentIds(p)
    const changed = link ? !ids.includes(agentId) : ids.includes(agentId)
    if (changed) this.store.upsertProject({ id: p.id, defaultAgentIds: link ? [...ids, agentId] : ids.filter(id => id !== agentId) })
    return { projectId, agentId, linked: link, changed }
  }
}
