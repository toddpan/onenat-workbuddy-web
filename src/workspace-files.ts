/** Project file authorization and path checks shared by REST and tool channels. */
import { posix, win32 } from 'node:path'
import type { DshClient, DshTarget } from './remote-client.js'
import type { DshRef, Project } from './types.js'
import type { OnenatDirectory } from './onenat.js'
import { canAccessProject, isPlatformAdmin, type PermSession } from './perm.js'
import { dshRefKey, normalizeWorkspacePath, sameDshRef, validateWorkspacePath } from './workspace.js'

export class WorkspaceFileError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message) }
}

export function requireProjectFiles(session: PermSession | undefined, project: Project | undefined, write = false): asserts project is Project {
  if (!project || (session && !canAccessProject(session, project, 'view'))) throw new WorkspaceFileError(404, 'PROJECT_NOT_FOUND', '项目不存在')
  if (write && session && !canAccessProject(session, project, 'edit')) throw new WorkspaceFileError(403, 'WORKSPACE_READ_ONLY', '仅项目 owner 或管理员可写入项目工作区')
  if (write && project.archivedAt) throw new WorkspaceFileError(403, 'PROJECT_ARCHIVED', '归档项目工作区只读')
  if (!project.workspace) throw new WorkspaceFileError(400, 'WORKSPACE_REQUIRED', '项目未配置文件工作区')
  validateWorkspacePath(project.workspace)
}

/** A node-wide API key cannot be attenuated to a user's project membership. */
export function requireNodeFiles(session?: PermSession): void {
  if (session && !isPlatformAdmin(session)) throw new WorkspaceFileError(403, 'PROJECT_SCOPE_REQUIRED', '节点级文件和直传凭据仅管理员可用；请通过 projectId 或项目 taskId 访问授权工作区')
}

const pathsFor = (root: string) => /^[a-z]:[\\/]/i.test(root) || root.startsWith('\\\\') || root.startsWith('//') ? win32 : posix
export function workspaceContains(root: string, target: string): boolean {
  const paths = pathsFor(root)
  const rel = paths.relative(root, target)
  return !rel || (rel !== '..' && !rel.startsWith('..' + paths.sep) && !paths.isAbsolute(rel))
}

export function projectFilePath(project: Project, input?: string): string {
  const root = normalizeWorkspacePath(project.workspace)
  if (!root) throw new WorkspaceFileError(400, 'WORKSPACE_REQUIRED', '项目未配置文件工作区')
  const value = input || '.'
  if (value.includes('\0') || (pathsFor(root) === posix && value.includes('\\')) || (pathsFor(root) === win32 && value.replace(/^[a-z]:/i, '').includes(':'))) throw new WorkspaceFileError(400, 'WORKSPACE_PATH_INVALID', '非法工作区路径')
  const resolved = normalizeWorkspacePath(pathsFor(root).resolve(root, value))!
  if (!workspaceContains(root, resolved)) throw new WorkspaceFileError(403, 'OUTSIDE_WORKSPACE', '路径超出项目工作区')
  if (pathsFor(root).relative(root, resolved).split(/[\\/]/).some(p => p.startsWith('.workspace-remote.'))) throw new WorkspaceFileError(403, 'RESERVED_PATH', '不能访问工作区协作锁或临时文件')
  return resolved
}

export function workspaceChild(parent: string, name: string): string {
  if (!name || name === '.' || name === '..' || /[\\/\0:]/.test(name)) throw new WorkspaceFileError(400, 'WORKSPACE_NAME_INVALID', '名称必须是单个文件或目录名')
  return pathsFor(parent).join(parent, name)
}

function nodeAliases(ref: DshRef, directory: OnenatDirectory): Set<string> {
  const keys = new Set([dshRefKey(ref)])
  for (const ep of directory.listEndpoints()) {
    if ((ref.kind === 'mapping' && ep.mappingId === ref.mappingId) || (ref.kind === 'app' && ep.appId === ref.appId) ||
        (ref.kind === 'direct' && ep.baseUrl && sameDshRef(ref, { kind: 'direct', apiBaseUrl: ep.baseUrl }))) {
      keys.add(`mapping:${ep.mappingId}`)
      if (ep.baseUrl) keys.add(dshRefKey({ kind: 'direct', apiBaseUrl: ep.baseUrl }))
    }
  }
  return new Set([...keys].filter((key): key is string => Boolean(key)))
}

/** Even an overlapping project root or an app/direct alias must not grant another project's files. */
export function requireWorkspacePath(session: PermSession | undefined, project: Project, projects: Project[], directory: OnenatDirectory, target: string, write: boolean, recursive = false): void {
  if (!session || isPlatformAdmin(session)) return
  const keys = nodeAliases(project.dshRef, directory)
  for (const other of projects) {
    if (other.id === project.id || !other.workspace || ![...nodeAliases(other.dshRef, directory)].some(k => keys.has(k))) continue
    const otherRoot = normalizeWorkspacePath(other.workspace)!
    if (!workspaceContains(otherRoot, target) && !(recursive && workspaceContains(target, otherRoot))) continue
    if (!canAccessProject(session, other, write ? 'edit' : 'view') || (write && other.archivedAt)) throw new WorkspaceFileError(403, 'WORKSPACE_PATH_DENIED', '该路径不在当前授权范围内')
  }
}

type Listing = NonNullable<Awaited<ReturnType<DshClient['fsList']>>['data']>
/** Fail closed on missing link metadata; never trust lexical containment alone. */
export async function checkWorkspaceFsPath(client: DshClient, target: DshTarget, project: Project, filePath: string, allowAbsent = false): Promise<{ listing?: Listing; exists: boolean }> {
  const root = projectFilePath(project)
  const paths = pathsFor(root)
  const list = async (dir: string): Promise<Listing> => {
    const out = await client.fsList(target, dir, true)
    if (!out.ok || !out.data) throw new WorkspaceFileError(502, 'WORKSPACE_CHECK_FAILED', out.error || '无法核验远端工作区路径')
    if (normalizeWorkspacePath(out.data.path) !== normalizeWorkspacePath(dir)) throw new WorkspaceFileError(403, 'WORKSPACE_PATH_CHANGED', '远端目录路径与请求不一致')
    if (!Array.isArray(out.data.entries) || out.data.entries.some(e => !e || typeof e.name !== 'string' || !e.name || e.name === '.' || e.name === '..' || /[\\/\0]/.test(e.name) || typeof e.path !== 'string' || normalizeWorkspacePath(e.path) !== normalizeWorkspacePath(paths.join(dir, e.name)))) throw new WorkspaceFileError(502, 'WORKSPACE_METADATA_INVALID', '远端文件元数据不完整或路径不一致')
    return out.data
  }
  // Verify the configured root itself too; an intermediate link may point at another private project.
  const parsedRoot = paths.parse(root).root
  let ancestor = parsedRoot
  for (const part of paths.relative(parsedRoot, root).split(paths.sep).filter(Boolean)) {
    const parent = await list(ancestor)
    const entry = parent.entries.find(e => e.name === part)
    const next = normalizeWorkspacePath(paths.join(ancestor, part))!
    if (!entry || entry.type !== 'dir' || normalizeWorkspacePath(entry.path) !== next) throw new WorkspaceFileError(403, 'WORKSPACE_ROOT_UNVERIFIED', '项目根目录含符号链接或无法核验的父目录；请使用节点真实绝对路径（如 macOS /private/var，而非 /var）')
    ancestor = next
  }
  let current = root, listing = await list(root)
  const parts = paths.relative(root, filePath).split(paths.sep).filter(Boolean)
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i], next = normalizeWorkspacePath(paths.join(current, name))!
    const entry = listing.entries.find(e => e.name === name)
    if (!entry) {
      if (allowAbsent && i === parts.length - 1 && !listing.truncated) return { exists: false }
      throw new WorkspaceFileError(404, 'WORKSPACE_PATH_NOT_FOUND', '工作区路径不存在或无法完整核验')
    }
    if (normalizeWorkspacePath(entry.path) !== next || !['dir', 'file'].includes(entry.type || '')) throw new WorkspaceFileError(403, 'WORKSPACE_SYMLINK', '不允许访问符号链接或无法核验类型的工作区路径')
    if (entry.type === 'file') {
      if (i !== parts.length - 1) throw new WorkspaceFileError(400, 'WORKSPACE_NOT_DIRECTORY', '父路径不是目录')
      return { exists: true }
    }
    current = next
    listing = await list(current)
  }
  return { exists: true, listing: { ...listing, home: root, parent: current === root ? undefined : normalizeWorkspacePath(paths.dirname(current)) } }
}

/** Reuse the remote worker's lock + read-version CAS + atomic rename. No blind HTTP overwrite. */
export async function writeProjectFile(project: Project, target: DshTarget & { mappingId?: string }, directory: OnenatDirectory, path: string, data: Buffer, expectedSha256?: string): Promise<{ ok: boolean; code?: string; error?: string; sha256?: string }> {
  const moduleUrl = new URL('../scripts/workspace-remote.mjs', import.meta.url).href
  const { remote } = await import(moduleUrl)
  const { randomBytes } = await import('node:crypto')
  const nodeRef = target.mappingId ? `mapping:${target.mappingId}` : project.dshRef.kind === 'mapping' ? `mapping:${project.dshRef.mappingId}` : undefined
  if (project.dshRef.kind !== 'direct' && !nodeRef) throw new WorkspaceFileError(502, 'NODE_IDENTITY_REQUIRED', '文件归属节点缺少稳定 mapping 身份')
  return remote({ operation: 'write', root: project.workspace, path, nonce: randomBytes(24).toString('hex'), contentBase64: data.toString('base64'), ...(expectedSha256 ? { expectedSha256 } : { expectAbsent: true }) }, {
    ...(nodeRef ? { nodeRef, onenatBase: directory.endpoint, onenatApiKey: directory.key } : { base: target.baseUrl }), apiKey: target.apiKey,
  })
}
