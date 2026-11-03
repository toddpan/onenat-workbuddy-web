/**
 * 统一权限判定（docs/design-user-project-management.md §10 权限模型扩展）
 *
 * 四层模型：
 *   1. 平台角色：user.role = admin | user —— 管「人」（用户生命周期、全局设置、审计）
 *   2. 项目成员：Project.owner + Project.projectMembers —— 管「业务上下文」
 *   3. 资源所有权：SshResource.ownerUserId —— 管「敏感资源」（SSH 凭据等）
 *   4. 智能体归属：SubAgent.ownerUserId —— 管「子智能体/专家/专家团」
 *
 * §11 归属扩展（同一宽容口径）：WorkTask.ownerUserId（创建者私有 + 项目成员共享）、
 * ScheduledTask.ownerUserId、库条目/用户专家 ownerUserId —— 列表与使用全员开放，
 * 生命周期管理（删/改/归档/run）仅归属人 + admin；存量（无归属）管理仅 admin。
 *
 * 核心原则：**默认最小可见，显式共享**。
 * 存量数据走宽容模式（owner/ownerUserId 缺省 = 所有人可用），保证零迁移成本；
 * 宽容判定集中在本文件，路由层只调用这里的函数，不散落 if。
 *
 * 纯函数、无 IO，便于单测（src/perm.test.ts）。
 */

import type { ProjectMember } from './types.js'

/** 平台角色（与 auth.ts UserRole 对齐） */
export type PlatformRole = 'admin' | 'user'

/** 判定所需的会话信息（router 注入的 SessionInfo / SessionInfo 的子集） */
export interface PermSession {
  userId?: string
  role?: PlatformRole
}

/** 项目判定所需的最小字段集 */
export interface PermProjectLike {
  id: string
  owner?: string
  projectMembers?: ProjectMember[]
  visibility?: 'private' | 'team' | 'public'
  /** 普通 member 是否可邀请他人入项 */
  allowMemberInvite?: boolean
  /** 连接器引用：'ssh:<资源id>' | 'map:<mappingId>' | 'app:<appId>' */
  connectorIds?: string[]
  /** 默认协作子智能体（引用 SubAgent.id） */
  defaultAgentIds?: string[]
}

/** 资源判定所需的最小字段集 */
export interface PermResourceLike {
  id: string
  ownerUserId?: string
  visibility?: 'private' | 'shared'
}

/** 智能体判定所需的最小字段集 */
export interface PermAgentLike {
  id: string
  ownerUserId?: string
  sharedProjectIds?: string[]
}

/** 项目级动作 */
export type ProjectAction =
  | 'view'        // 查看项目与项目内内容
  | 'edit'        // 编辑项目元信息
  | 'manageMembers' // 增删成员 / 改角色 / 转让 owner
  | 'invite'      // 邀请他人入项
  | 'archive'     // 归档 / 恢复
  | 'delete'      // 删除（软删）

/** 资源级动作 */
export type ResourceAction =
  | 'view'   // 列表/详情可见（脱敏）
  | 'use'    // 实际使用（exec / test / 上传）
  | 'reveal' // 取回明文凭据
  | 'manage' // 新建 / 修改 / 删除

/** 权限判定上下文：需要项目集合才能判定「项目绑定共享」 */
export interface PermContext {
  /** 当前可见/相关的项目集合（用于资源与智能体的项目绑定判定） */
  projects?: PermProjectLike[]
}

// ---------- 基础判定 ----------

/** 是否平台管理员（admin 不自动穿透项目内容，仅在显式动作上放行） */
export function isPlatformAdmin(session?: PermSession | null): boolean {
  return session?.role === 'admin'
}

/** 项目是否启用成员隔离：无 owner 且无成员 = 存量宽容模式（所有登录用户可见） */
export function projectIsolated(proj: PermProjectLike): boolean {
  return Boolean(proj.owner || (proj.projectMembers && proj.projectMembers.length))
}

/** 是否项目成员（owner 也算成员） */
export function isProjectMember(proj: PermProjectLike, userId?: string): boolean {
  if (!userId) return false
  if (proj.owner === userId) return true
  return Boolean(proj.projectMembers?.some((m) => m.userId === userId))
}

/** 是否项目 owner（owner 字段或成员角色 owner） */
export function isProjectOwner(proj: PermProjectLike, userId?: string): boolean {
  if (!userId) return false
  if (proj.owner === userId) return true
  return Boolean(proj.projectMembers?.some((m) => m.userId === userId && m.role === 'owner'))
}

// ---------- 项目权限 ----------

/**
 * 项目动作判定（§10.2）。
 * - 宽容模式（无 owner 且无成员）：登录用户可看，改类动作仅 admin。
 * - 隔离模式：成员可看；edit/manageMembers/archive/delete 仅 owner（+admin）；
 *   invite 由 owner 或 allowMemberInvite 开关放开给 member。
 */
export function canAccessProject(
  session: PermSession | null | undefined,
  proj: PermProjectLike,
  action: ProjectAction = 'view',
): boolean {
  if (!session?.userId) return false
  const uid = session.userId

  if (!projectIsolated(proj)) {
    // 宽容模式：存量项目不启用成员隔离
    if (action === 'view') return true
    return isPlatformAdmin(session)
  }

  if (isPlatformAdmin(session)) return true
  if (!isProjectMember(proj, uid)) return false
  if (action === 'view') return true

  const owner = isProjectOwner(proj, uid)
  switch (action) {
    case 'edit':
    case 'manageMembers':
    case 'archive':
    case 'delete':
      return owner
    case 'invite':
      return owner || proj.allowMemberInvite === true
    default:
      return false
  }
}

// ---------- 资源权限（SSH 资源池等） ----------

/** 项目是否绑定了该资源（'ssh:<id>' 形式的连接器引用） */
export function projectBindsResource(proj: PermProjectLike, resourceId: string): boolean {
  return Boolean(proj.connectorIds?.some((c) => c === `ssh:${resourceId}` || c === resourceId))
}

/** 用户所属项目里是否有绑定了该资源的项目（= 该资源已共享给用户） */
function boundToUserProject(
  session: PermSession | null | undefined,
  res: PermResourceLike,
  ctx?: PermContext,
): boolean {
  const uid = session?.userId
  if (!uid) return false
  return Boolean(
    ctx?.projects?.some(
      (p) => projectBindsResource(p, res.id) && (isProjectMember(p, uid) || isPlatformAdmin(session)),
    ),
  )
}

/**
 * 资源可见性判定（§10.3）。
 * - 无 ownerUserId（存量）：全员可见可用（宽容模式）。
 * - 有归属人：归属人 / admin / 项目绑定成员 → 可见且可用；
 *   visibility='shared' 时额外对全部登录用户只读可见（不可使用、不可取明文）。
 */
export function canViewResource(
  session: PermSession | null | undefined,
  res: PermResourceLike,
  ctx?: PermContext,
): boolean {
  if (!res.ownerUserId) return true
  if (!session?.userId) return false
  if (isPlatformAdmin(session)) return true
  if (res.ownerUserId === session.userId) return true
  if (res.visibility === 'shared') return true
  return boundToUserProject(session, res, ctx)
}

/** 资源可用性判定：归属人 / admin / 项目绑定成员 */
export function canUseResource(
  session: PermSession | null | undefined,
  res: PermResourceLike,
  ctx?: PermContext,
): boolean {
  if (!res.ownerUserId) return true
  if (!session?.userId) return false
  if (isPlatformAdmin(session)) return true
  if (res.ownerUserId === session.userId) return true
  return boundToUserProject(session, res, ctx)
}

/**
 * 资源管理判定（新建/修改/删除/取回明文凭据）：
 * - 有归属人：仅归属人与 admin。
 * - 存量（无归属人）：**仅 admin**。
 *   存量数据的「本来归谁」已无法追溯，若对所有登录用户放开写面，等于「谁都能改/删/看明文」
 *   （线上事故：普通用户删掉了存量子智能体）。故存量保持「可见/可用全员、写面仅管理员」。
 */
export function canManageResource(
  session: PermSession | null | undefined,
  res: PermResourceLike,
): boolean {
  if (!session?.userId) return false
  if (isPlatformAdmin(session)) return true
  if (!res.ownerUserId) return false
  return res.ownerUserId === session.userId
}

/** 资源动作统一入口 */
export function canAccessResource(
  session: PermSession | null | undefined,
  res: PermResourceLike,
  action: ResourceAction,
  ctx?: PermContext,
): boolean {
  switch (action) {
    case 'view':
      return canViewResource(session, res, ctx)
    case 'use':
      return canUseResource(session, res, ctx)
    case 'reveal':
    case 'manage':
      return canManageResource(session, res)
    default:
      return false
  }
}

// ---------- 智能体权限（子智能体 / 专家 / 专家团） ----------

/** 用户所属项目里是否绑定了该智能体（defaultAgentIds 或 sharedProjectIds） */
function boundToUserProjectAgent(
  session: PermSession | null | undefined,
  agent: PermAgentLike,
  ctx?: PermContext,
): boolean {
  const uid = session?.userId
  if (!uid) return false
  return Boolean(
    ctx?.projects?.some((p) => {
      if (!isProjectMember(p, uid) && !isPlatformAdmin(session)) return false
      if (agent.sharedProjectIds?.length && agent.sharedProjectIds.includes(p.id)) return true
      return Boolean(p.defaultAgentIds?.includes(agent.id))
    }),
  )
}

/**
 * 智能体可用性（能 @ 即能派工）：归属人 / admin / 项目绑定成员。
 * 无归属人（存量）：全员可用（宽容模式）。
 */
export function canUseAgent(
  session: PermSession | null | undefined,
  agent: PermAgentLike,
  ctx?: PermContext,
): boolean {
  if (!agent.ownerUserId) return true
  if (!session?.userId) return false
  if (isPlatformAdmin(session)) return true
  if (agent.ownerUserId === session.userId) return true
  return boundToUserProjectAgent(session, agent, ctx)
}

/**
 * 智能体管理判定（改/删/查看私有配置）：
 * - 有归属人：仅归属人与 admin。
 * - 存量（无归属人）：**仅 admin**。同 canManageResource —— 存量写面不能对全员放开，
 *   否则普通用户可删除/改写他人（且不可回滚）的子智能体。
 */
export function canManageAgent(
  session: PermSession | null | undefined,
  agent: PermAgentLike,
): boolean {
  if (!session?.userId) return false
  if (isPlatformAdmin(session)) return true
  if (!agent.ownerUserId) return false
  return agent.ownerUserId === session.userId
}

/** 非归属人不可见的智能体私有字段（§10.4：apiKey / 提示词属归属人私有配置） */
export const AGENT_PRIVATE_FIELDS = ['apiKey', 'systemPrompt', 'executionPrompt'] as const

/**
 * 智能体脱敏：非归属人看到的是「可用但不可读配置」的视图。
 * 返回新对象，不改动存储中的原始记录。
 */
export function maskAgentForViewer<T extends PermAgentLike>(
  agent: T,
  session: PermSession | null | undefined,
): T {
  if (canManageAgent(session, agent)) return agent
  const clone: Record<string, unknown> = { ...(agent as unknown as Record<string, unknown>) }
  for (const field of AGENT_PRIVATE_FIELDS) delete clone[field]
  return clone as unknown as T
}

/** 智能体列表过滤：保留本人可见且可用的条目（不可见者直接隐藏，避免暴露存在性） */
export function visibleAgents<T extends PermAgentLike>(
  agents: T[],
  session: PermSession | null | undefined,
  ctx?: PermContext,
): T[] {
  return agents.filter((a) => canViewAgent(session, a, ctx))
}

/** 智能体可见性（列表展示）：归属人 / admin / 项目绑定成员 / 显式 shared */
export function canViewAgent(
  session: PermSession | null | undefined,
  agent: PermAgentLike,
  ctx?: PermContext,
): boolean {
  if (!agent.ownerUserId) return true
  if (!session?.userId) return false
  if (isPlatformAdmin(session)) return true
  if (agent.ownerUserId === session.userId) return true
  return boundToUserProjectAgent(session, agent, ctx)
}

// ---------- 任务权限（§11：任务跟随创建者 + 项目成员共享） ----------

/** 任务判定所需的最小字段集 */
export interface PermTaskLike {
  id: string
  ownerUserId?: string
  projectId?: string
}

/**
 * 任务可见性（未登录一律无权；登录后）：
 * - 无归属（存量 / AI 工具通道创建）：全员可见（宽容模式）。
 * - 有归属：归属人 / admin /（projectId 指向隔离项目时的项目成员，owner 也算成员）。
 */
export function canViewTask(
  session: PermSession | null | undefined,
  task: PermTaskLike,
  ctx?: PermContext,
): boolean {
  if (!session?.userId) return false
  if (!task.ownerUserId) return true
  if (isPlatformAdmin(session)) return true
  if (task.ownerUserId === session.userId) return true
  const proj = task.projectId ? ctx?.projects?.find((p) => p.id === task.projectId) : undefined
  return Boolean(proj && projectIsolated(proj) && isProjectMember(proj, session.userId))
}

/** 任务列表过滤：保留本人可见条目（不可见者直接隐藏，避免暴露存在性） */
export function visibleTasks<T extends PermTaskLike>(
  tasks: T[],
  session: PermSession | null | undefined,
  ctx?: PermContext,
): T[] {
  return tasks.filter((t) => canViewTask(session, t, ctx))
}

/**
 * 任务管理判定（改名/删除/归档/批量归档/编辑成员/模型预设/permission 配置/queue）：
 * - 有归属：仅归属人与 admin（项目成员可看可聊，但不动他人任务的生命周期）。
 * - 存量（无归属）：**仅 admin**（同 canManageResource 口径：存量写面不对全员放开）。
 */
export function canManageTask(
  session: PermSession | null | undefined,
  task: PermTaskLike,
): boolean {
  if (!session?.userId) return false
  if (isPlatformAdmin(session)) return true
  if (!task.ownerUserId) return false
  return task.ownerUserId === session.userId
}

// ---------- 定时任务权限 ----------

/** 定时任务判定所需的最小字段集 */
export interface PermScheduleLike {
  id: string
  ownerUserId?: string
}

/** 定时任务可见性（未登录一律无权；登录后）：无归属（存量）= 全员；有归属 = 归属人 / admin */
export function canViewSchedule(
  session: PermSession | null | undefined,
  sched: PermScheduleLike,
): boolean {
  if (!session?.userId) return false
  if (!sched.ownerUserId) return true
  return isPlatformAdmin(session) || sched.ownerUserId === session.userId
}

/**
 * 定时任务管理（编辑/删除/toggle/手动 run——run 会派生任务消耗资源，归管理面）：
 * - 有归属：仅归属人与 admin；存量（无归属）：仅 admin。
 */
export function canManageSchedule(
  session: PermSession | null | undefined,
  sched: PermScheduleLike,
): boolean {
  return canManageTask(session, sched)
}

// ---------- 归属条目（库条目 / 用户专家） ----------

/** 库条目（LibEntry）与用户专家（Expert）共用的归属判定最小字段集 */
export interface PermOwnedLike {
  id: string
  ownerUserId?: string
}

/**
 * 归属条目管理判定（库条目删除 / 专家编辑与删除）：
 * - 有归属：仅归属人与 admin；存量（无归属）：仅 admin。
 * 查看/使用（下载、安装、@召唤）保持全员开放，不在此列。
 */
export function canManageOwned(
  session: PermSession | null | undefined,
  entry: PermOwnedLike,
): boolean {
  return canManageTask(session, entry)
}
