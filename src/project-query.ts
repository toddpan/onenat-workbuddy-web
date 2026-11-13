import type { Project } from './types.js'
import { projectDefaultAgentIds } from './types.js'

export interface ProjectListOptions {
  name?: unknown; workspace?: unknown; keyword?: unknown
  limit?: unknown; offset?: unknown; compact?: unknown
}
export function queryError(message: string, status = 400): Error & { status: number } {
  return Object.assign(new Error(message), { status })
}
export function queryBoolean(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null) return fallback
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  throw queryError('compact 必须为 true 或 false')
}
export function queryInteger(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined || value === null) return fallback
  if (!/^[0-9]+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    throw queryError(`${name} 必须为 ${min}–${max} 的整数`)
  }
  return Number(value)
}
/** Caller supplies only authorized projects; filtering/counting never includes hidden rows. */
export function queryProjects(projects: Project[], options: ProjectListOptions, defaultLimit = 20) {
  const text = (v: unknown) => String(v ?? '').trim().toLocaleLowerCase()
  const name = text(options.name), workspace = text(options.workspace)
  const words = text(options.keyword).split(/\s+/).filter(Boolean)
  const matched = projects.filter(p => (!name || text(p.name).includes(name))
    && (!workspace || text(p.workspace).includes(workspace))
    && words.every(word => text([p.id, p.name, p.workspace, p.instruction, ...(p.skillNames || [])].join(' ')).includes(word)))
  const limit = queryInteger(options.limit, defaultLimit, 1, 200, 'limit')
  const offset = queryInteger(options.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset')
  const compact = queryBoolean(options.compact)
  const rows = matched.slice(offset, offset + limit)
  const hasMore = offset + rows.length < matched.length
  return {
    rows, compact,
    metadata: { total: matched.length, offset, limit, returnedCount: rows.length, hasMore,
      nextOffset: hasMore ? offset + rows.length : null, truncated: hasMore || offset > 0,
      ...(compact ? { compact: true, omittedFields: ['instruction', 'experts', 'skillNames', 'connectorIds', 'nodeTitle'], detailAction: 'workbuddy_project_manage get' } : {}) },
  }
}
export function compactProject(p: Project, taskCount: number) {
  return { id: p.id, name: p.name, dshRef: p.dshRef, defaultExecutionNodeRef: p.defaultExecutionNodeRef,
    workspace: p.workspace || '', defaultAgentIds: projectDefaultAgentIds(p), taskCount }
}
