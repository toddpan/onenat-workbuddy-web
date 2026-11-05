/**
 * 统一权限判定（src/perm.ts）单测。
 *
 * 对应设计：docs/design-user-project-management.md §10 权限模型扩展。
 * 合同要点：
 *   - 存量宽容模式：无 owner / ownerUserId 缺省 = **全员可见可用**；
 *     但写面（改/删/取明文）**仅管理员** —— 线上事故回归点；
 *   - 隔离模式：成员可见，改类动作按 owner / allowMemberInvite 开关；
 *   - 敏感资源：取明文与改删仅归属人 + admin；
 *   - 智能体：非归属人只拿到脱敏视图（无 apiKey / 提示词）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canAccessProject,
  canManageAgent,
  canManageOwned,
  canManageResource,
  canManageSchedule,
  canManageTask,
  canUseAgent,
  canUseResource,
  canViewAgent,
  canViewResource,
  canViewSchedule,
  canViewTask,
  maskAgentForViewer,
  projectBindsResource,
  projectIsolated,
  visibleTasks,
  type PermContext,
  type PermProjectLike,
  type PermSession,
} from './perm.js'

const admin: PermSession = { userId: 'usr-admin', role: 'admin' }
const alice: PermSession = { userId: 'usr-alice', role: 'user' }
const bob: PermSession = { userId: 'usr-bob', role: 'user' }
const carol: PermSession = { userId: 'usr-carol', role: 'user' }

/** 隔离项目：alice 是 owner，bob 是普通成员 */
const isolatedProject: PermProjectLike = {
  id: 'proj-1',
  owner: 'usr-alice',
  projectMembers: [
    { userId: 'usr-alice', role: 'owner', joinedAt: 1 },
    { userId: 'usr-bob', role: 'member', joinedAt: 2 },
  ],
}

/** 存量项目：无 owner、无成员（宽容模式） */
const legacyProject: PermProjectLike = { id: 'proj-legacy' }

// ---------- 项目权限 ----------

test('存量项目走宽容模式：登录用户可看，非 admin 不可改', () => {
  assert.equal(projectIsolated(legacyProject), false)
  assert.equal(canAccessProject(alice, legacyProject, 'view'), true)
  assert.equal(canAccessProject(alice, legacyProject, 'edit'), false)
  assert.equal(canAccessProject(admin, legacyProject, 'edit'), true)
  assert.equal(canAccessProject(alice, legacyProject, 'manageMembers'), false)
})

test('隔离项目：成员可见，非成员不可见', () => {
  assert.equal(canAccessProject(bob, isolatedProject, 'view'), true)
  assert.equal(canAccessProject(carol, isolatedProject, 'view'), false)
  assert.equal(canAccessProject(alice, isolatedProject, 'view'), true)
})

test('隔离项目：改类动作仅 owner（+admin）', () => {
  assert.equal(canAccessProject(alice, isolatedProject, 'edit'), true)
  assert.equal(canAccessProject(bob, isolatedProject, 'edit'), false)
  assert.equal(canAccessProject(bob, isolatedProject, 'manageMembers'), false)
  assert.equal(canAccessProject(bob, isolatedProject, 'delete'), false)
  assert.equal(canAccessProject(admin, isolatedProject, 'manageMembers'), true)
  assert.equal(canAccessProject(admin, isolatedProject, 'delete'), true)
})

test('邀请：默认仅 owner；allowMemberInvite 打开后普通成员可邀请', () => {
  assert.equal(canAccessProject(bob, isolatedProject, 'invite'), false)
  assert.equal(canAccessProject(alice, isolatedProject, 'invite'), true)
  const openProject: PermProjectLike = { ...isolatedProject, allowMemberInvite: true }
  assert.equal(canAccessProject(bob, openProject, 'invite'), true)
  assert.equal(canAccessProject(carol, openProject, 'invite'), false)
})

test('未登录一律无项目权限', () => {
  assert.equal(canAccessProject(undefined, isolatedProject, 'view'), false)
  assert.equal(canAccessProject(undefined, legacyProject, 'view'), false)
})

// ---------- 资源权限 ----------

test('无归属人的 SSH 资源（存量）：全员可见可用，但写面仅管理员', () => {
  const legacyRes = { id: 'ssh-1' }
  assert.equal(canViewResource(carol, legacyRes), true)
  assert.equal(canUseResource(carol, legacyRes), true)
  // 写面收紧：普通用户不得改/删/取明文（线上事故：普通用户删掉了存量资源）
  assert.equal(canManageResource(carol, legacyRes), false)
  assert.equal(canManageResource(admin, legacyRes), true)
})

test('有归属人的 SSH 资源：他人不可见不可用', () => {
  const res = { id: 'ssh-2', ownerUserId: 'usr-alice' }
  assert.equal(canViewResource(alice, res), true)
  assert.equal(canUseResource(alice, res), true)
  assert.equal(canManageResource(alice, res), true)
  assert.equal(canViewResource(bob, res), false)
  assert.equal(canUseResource(bob, res), false)
  assert.equal(canManageResource(bob, res), false)
})

test('项目绑定共享：成员可使用该资源，但不可取明文、不可改删', () => {
  const res = { id: 'ssh-3', ownerUserId: 'usr-alice' }
  const ctx: PermContext = {
    projects: [{ ...isolatedProject, connectorIds: ['ssh:ssh-3'] }],
  }
  assert.equal(projectBindsResource(ctx.projects![0], 'ssh-3'), true)
  assert.equal(canViewResource(bob, res, ctx), true)
  assert.equal(canUseResource(bob, res, ctx), true)
  assert.equal(canManageResource(bob, res), false)
  // 不在项目里的第三人仍然不可见
  assert.equal(canViewResource(carol, res, ctx), false)
})

test('visibility=shared：全员只读可见，但不可使用', () => {
  const res = { id: 'ssh-4', ownerUserId: 'usr-alice', visibility: 'shared' as const }
  assert.equal(canViewResource(carol, res), true)
  assert.equal(canUseResource(carol, res), false)
  assert.equal(canManageResource(carol, res), false)
})

test('admin 对有归属的资源全权限', () => {
  const res = { id: 'ssh-5', ownerUserId: 'usr-alice' }
  assert.equal(canViewResource(admin, res), true)
  assert.equal(canUseResource(admin, res), true)
  assert.equal(canManageResource(admin, res), true)
})

// ---------- 智能体权限 ----------

test('无归属人的子智能体（存量）：全员可见可用，但改/删仅管理员', () => {
  const agent = { id: 'agent-1' }
  assert.equal(canViewAgent(carol, agent), true)
  assert.equal(canUseAgent(carol, agent), true)
  // 回归：普通用户不得删除/改写存量（无归属）子智能体 —— 线上曾发生数据丢失
  assert.equal(canManageAgent(carol, agent), false)
  assert.equal(canManageAgent(bob, agent), false)
  assert.equal(canManageAgent(admin, agent), true)
})

test('有归属人的子智能体：他人不可见、不可改，但可被项目绑定成员 @', () => {
  const agent = { id: 'agent-2', ownerUserId: 'usr-alice' }
  assert.equal(canViewAgent(alice, agent), true)
  assert.equal(canManageAgent(alice, agent), true)
  assert.equal(canViewAgent(carol, agent), false)
  assert.equal(canUseAgent(carol, agent), false)
  assert.equal(canManageAgent(carol, agent), false)

  const ctx: PermContext = { projects: [{ ...isolatedProject, defaultAgentIds: ['agent-2'] }] }
  assert.equal(canUseAgent(bob, agent, ctx), true)
  assert.equal(canViewAgent(bob, agent, ctx), true)
  assert.equal(canManageAgent(bob, agent), false)
})

test('宽容模式项目（无 owner 无成员）绑定的默认协作成员：全员可见可用（线上 alita 事故回归）', () => {
  // 场景：admin 在新建的 DSH 节点（alita）下创建智能体，并加入宽容模式项目的 defaultAgentIds。
  // 旧实现只认 isProjectMember，而宽容模式项目没有成员 → 项目对所有人可见、
  // 项目里的默认协作成员却谁都看不到，用户表现为「@ 能看到节点但看不到节点下的智能体」。
  const lenientProject: PermProjectLike = { id: 'proj-lenient', defaultAgentIds: ['agent-alita'] }
  const agent = { id: 'agent-alita', ownerUserId: 'usr-admin' }
  const ctx: PermContext = { projects: [lenientProject] }
  assert.equal(canViewAgent(bob, agent, ctx), true, '普通用户应能看到宽容模式项目绑定的智能体')
  assert.equal(canUseAgent(bob, agent, ctx), true, '普通用户应能 @ 该智能体')
  assert.equal(canUseAgent(carol, agent, ctx), true)
  assert.equal(canManageAgent(bob, agent), false, '可见可用不等于可管')
  // 未被任何项目绑定、也不属于自己 → 仍严格不可见（不放宽）
  assert.equal(canViewAgent(bob, { id: 'agent-other', ownerUserId: 'usr-admin' }, ctx), false)
})

test('sharedProjectIds 显式共享：项目成员可 @ 不可改', () => {
  const agent = { id: 'agent-3', ownerUserId: 'usr-alice', sharedProjectIds: ['proj-1'] }
  const ctx: PermContext = { projects: [isolatedProject] }
  assert.equal(canUseAgent(bob, agent, ctx), true)
  assert.equal(canUseAgent(carol, agent, ctx), false)
  assert.equal(canManageAgent(bob, agent), false)
})

test('脱敏视图：非归属人看不到 apiKey / 提示词，且不改动原对象', () => {
  const agent = {
    id: 'agent-4',
    ownerUserId: 'usr-alice',
    apiKey: 'sk-secret',
    systemPrompt: '内部提示词',
    executionPrompt: '执行指导',
    name: '甲',
  }
  const masked = maskAgentForViewer(agent, bob)
  assert.equal((masked as any).apiKey, undefined)
  assert.equal((masked as any).systemPrompt, undefined)
  assert.equal((masked as any).executionPrompt, undefined)
  assert.equal(masked.name, '甲')
  // 原记录不被修改
  assert.equal(agent.apiKey, 'sk-secret')
  // 归属人与 admin 看到完整视图
  assert.equal(maskAgentForViewer(agent, alice).apiKey, 'sk-secret')
  assert.equal(maskAgentForViewer(agent, admin).apiKey, 'sk-secret')
})

// ---------- §11 任务权限 ----------

test('任务：无归属（存量/AI 通道）全员可见，管理仅 admin', () => {
  const legacyTask = { id: 'task-legacy' }
  assert.equal(canViewTask(alice, legacyTask), true)
  assert.equal(canViewTask(bob, legacyTask), true)
  assert.equal(canManageTask(alice, legacyTask), false)
  assert.equal(canManageTask(admin, legacyTask), true)
})

test('任务：私有任务（无项目绑定）仅归属人与 admin 可见', () => {
  const task = { id: 'task-1', ownerUserId: 'usr-alice' }
  assert.equal(canViewTask(alice, task), true)
  assert.equal(canViewTask(bob, task), false)
  assert.equal(canViewTask(admin, task), true)
  // 不可见者自然无管理权
  assert.equal(canManageTask(bob, task), false)
})

test('任务：绑定项目后项目成员可见（含项目 owner），但管理仍仅任务归属人', () => {
  const ctx: PermContext = { projects: [isolatedProject] }
  const task = { id: 'task-2', ownerUserId: 'usr-alice', projectId: 'proj-1' }
  // bob 是项目成员 → 可见可聊
  assert.equal(canViewTask(bob, task, ctx), true)
  // carol 不是成员 → 不可见
  assert.equal(canViewTask(carol, task, ctx), false)
  // bob 可见但不可管理（生命周期归任务归属人）
  assert.equal(canManageTask(bob, task), false)
  assert.equal(canManageTask(alice, task), true)
  // 项目绑定指向宽容项目时：非成员也无路径（宽容项目本就全员可见，绑定不额外放行任务管理）
  const legacyCtx: PermContext = { projects: [legacyProject] }
  const t2 = { id: 'task-3', ownerUserId: 'usr-alice', projectId: 'proj-legacy' }
  assert.equal(canViewTask(bob, t2, legacyCtx), false)
})

test('任务：列表过滤 visibleTasks 隐藏不可见条目', () => {
  const ctx: PermContext = { projects: [isolatedProject] }
  const list = [
    { id: 'a', ownerUserId: 'usr-alice', projectId: 'proj-1' },
    { id: 'b', ownerUserId: 'usr-carol' },
    { id: 'c' },
  ]
  const seenBob = visibleTasks(list as any, bob, ctx).map((t) => t.id)
  assert.deepEqual(seenBob, ['a', 'c'])
  const seenAdmin = visibleTasks(list as any, admin, ctx).map((t) => t.id)
  assert.deepEqual(seenAdmin, ['a', 'b', 'c'])
})

// ---------- §11 定时任务权限 ----------

test('定时任务：存量全员可见但管理仅 admin；有归属仅归属人可见', () => {
  const legacy = { id: 'sched-legacy' }
  assert.equal(canViewSchedule(alice, legacy), true)
  assert.equal(canManageSchedule(alice, legacy), false)
  assert.equal(canManageSchedule(admin, legacy), true)
  const owned = { id: 'sched-1', ownerUserId: 'usr-alice' }
  assert.equal(canViewSchedule(alice, owned), true)
  assert.equal(canViewSchedule(bob, owned), false)
  assert.equal(canManageSchedule(bob, owned), false)
  assert.equal(canManageSchedule(alice, owned), true)
})

// ---------- §11 归属条目（库条目 / 用户专家） ----------

test('库条目/专家：存量管理仅 admin；有归属仅归属人+admin', () => {
  const legacyEntry = { id: 'lib-legacy' }
  assert.equal(canManageOwned(alice, legacyEntry), false)
  assert.equal(canManageOwned(admin, legacyEntry), true)
  const owned = { id: 'lib-1', ownerUserId: 'usr-alice' }
  assert.equal(canManageOwned(alice, owned), true)
  assert.equal(canManageOwned(bob, owned), false)
  assert.equal(canManageOwned(admin, owned), true)
})

test('任务/定时任务/条目：未登录一律无权', () => {
  const anon = undefined
  assert.equal(canViewTask(anon, { id: 't', ownerUserId: 'usr-alice' }), false)
  assert.equal(canViewTask(anon, { id: 't' }), false)
  assert.equal(canManageTask(anon, { id: 't' }), false)
  assert.equal(canViewSchedule(anon, { id: 's' }), false)
  assert.equal(canManageSchedule(anon, { id: 's' }), false)
  assert.equal(canManageOwned(anon, { id: 'e' }), false)
})
