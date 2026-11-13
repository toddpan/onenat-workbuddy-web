/** Stable node/workspace identity. Never compare resolved (port-drifting) endpoints. */
import { posix, win32 } from 'node:path'
import type { DshRef } from './types.js'

export function dshRefKey(ref: DshRef | undefined): string | undefined {
  if (!ref) return undefined
  if (ref.kind === 'mapping') return ref.mappingId?.trim() ? `mapping:${ref.mappingId.trim()}` : undefined
  if (ref.kind === 'app') return ref.appId?.trim() ? `app:${ref.appId.trim()}` : undefined
  const raw = ref.apiBaseUrl?.trim().replace(/\/+$/, '')
  if (!raw) return undefined
  try {
    const url = new URL(raw)
    // URL normalizes scheme/host/default ports, but preserves case-sensitive path and query.
    return `direct:${url.href.replace(/\/+$/, '')}`
  } catch {
    return `direct:${raw}`
  }
}

export function sameDshRef(a: DshRef | undefined, b: DshRef | undefined): boolean {
  const key = dshRefKey(a)
  return key !== undefined && key === dshRefKey(b)
}

/** Lexical remote normalization: no local realpath, symlink or remote OS guesses. */
export function normalizeWorkspacePath(path: string | undefined): string | undefined {
  const raw = path?.trim()
  if (!raw) return undefined
  const windows = /^[a-z]:[\\/]/i.test(raw) || raw.startsWith('\\\\') || raw.startsWith('//')
  const normalized = windows ? win32.normalize(raw).replace(/\\/g, '/') : posix.normalize(raw)
  const root = windows ? win32.parse(win32.normalize(raw)).root.replace(/\\/g, '/') : '/'
  const trimmed = normalized.length > root.length ? normalized.replace(/\/+$/, '') : normalized
  return /^[a-z]:/i.test(trimmed) ? trimmed[0].toUpperCase() + trimmed.slice(1) : trimmed
}

/** A relative directory has no stable meaning on a remote node. Empty retains legacy projects without a root. */
export function validateWorkspacePath(path: string | undefined): void {
  const raw = path?.trim()
  if (!raw) return
  if (raw.includes('\0') || !(
    raw.startsWith('/') || /^[a-z]:[\\/]/i.test(raw) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(raw)
  )) throw new ProjectWorkspacePathError()
}

export class ProjectWorkspacePathError extends Error {
  readonly code = 'PROJECT_WORKSPACE_INVALID'
  readonly status = 400
  constructor() {
    super('项目工作区必须是文件归属节点上的绝对路径（POSIX /、Windows 盘符或 UNC）；可留空')
    this.name = 'ProjectWorkspacePathError'
  }
}

export function sameWorkspace(
  a: { dshRef: DshRef; workspace?: string },
  b: { dshRef: DshRef; workspace?: string },
): boolean {
  const path = normalizeWorkspacePath(a.workspace)
  return path !== undefined && path === normalizeWorkspacePath(b.workspace) && sameDshRef(a.dshRef, b.dshRef)
}

/** A collision is never permission to merge project membership or credentials. */
export class ProjectWorkspaceConflictError extends Error {
  readonly code = 'PROJECT_WORKSPACE_CONFLICT'
  readonly status = 409
  constructor() {
    super('同一归属节点的该工作区已关联其他项目；请使用有权访问的现有项目，不能重复创建或自动合并成员权限')
    this.name = 'ProjectWorkspaceConflictError'
  }
}
