import type { TaskEngine } from './engine.js'
import type { WorkStore } from './store.js'
import type { DshRef, WorkTask } from './types.js'
import { projectDefaultAgentIds } from './types.js'

/** Public identity only: direct endpoints can contain credentials/query tokens. */
export function publicNode(ref?: DshRef) {
  if (!ref) return null
  if (ref.kind === 'mapping') return { kind: ref.kind, nodeId: `mapping:${ref.mappingId}` }
  if (ref.kind === 'app') return { kind: ref.kind, nodeId: `app:${ref.appId}` }
  try { return { kind: ref.kind, nodeId: `direct:${new URL(ref.apiBaseUrl).origin}` } }
  catch { return { kind: ref.kind, nodeId: 'direct:unknown' } }
}

/** Snapshot-only preview. Never resolve/probe a remote node or invoke the planner. */
export async function taskPreflight(store: WorkStore, engine: TaskEngine, input: {
  task?: WorkTask; projectId?: string; nodeRef?: DshRef; memberAgentIds?: string[]; mode?: 'chat' | 'orchestrate'; chatAgentId?: string; teamId?: string
}, mentions: Awaited<ReturnType<TaskEngine['extractMentions']>>, overview?: { agents?: any[]; nodes?: any[] }) {
  engine.validateChatBinding(input, mentions, input.task)
  const chatAgentId = input.task?.chatAgentId || input.chatAgentId
  if (!input.task && chatAgentId && mentions.mentionedProjectId && mentions.mentionedProjectId !== input.projectId) throw Object.assign(new Error('直聊请通过 projectId 明确项目上下文'), { code: 'INVALID_PARAM' })
  const projectId = input.task?.projectId || input.projectId || mentions.mentionedProjectId
  const project = projectId ? store.getProject(projectId) : undefined
  const snapshot = input.task ? { ...input.task } : {
    projectId, nodeRef: input.nodeRef || project?.defaultExecutionNodeRef || project?.dshRef,
    memberAgentIds: chatAgentId ? [chatAgentId] : input.memberAgentIds ?? projectDefaultAgentIds(project).filter(id => store.getAgent(id)?.enabled !== false && store.getAgent(id)),
    mode: input.mode || 'chat', chatAgentId,
  } as WorkTask
  // First @project bind preserves an explicit task execution node (engine.sendUserMessage).
  if (!snapshot.projectId && project) {
    snapshot.projectId = project.id
    snapshot.nodeRef ||= project.defaultExecutionNodeRef || project.dshRef
  }
  const exec = engine.taskExec(snapshot)
  const warnings: string[] = []
  const agents = overview?.agents || []
  const nodes = overview?.nodes || []
  const health = (ref?: DshRef) => {
    const node = publicNode(ref)
    const observed = node ? nodes.find(n => n.key === node.nodeId || n.id === node.nodeId || n.nodeId === node.nodeId || ref?.kind === 'mapping' && n.mappingId === ref.mappingId) : undefined
    if (observed?.online === false) warnings.push(`节点 ${node?.nodeId} 离线（监控快照）`)
    if (observed?.runningCount > 0) warnings.push(`节点 ${node?.nodeId} 忙碌（监控快照，不代表不能接收任务）`)
    return node
  }
  const hasExplicit = Boolean(input.memberAgentIds?.length || mentions.mentionedAgentIds.length || mentions.mentionedExpertIds?.length || mentions.mentionedTeamId || mentions.mentionedProjectId)
  // engine.sendUserMessage bridges the first unmentioned team draft message to its contract.
  const teamId = input.teamId || mentions.mentionedTeamId || (!hasExplicit && input.task?.teamId && !input.task.turns.some(t => t.role === 'user') ? input.task.teamId : undefined)
  const team = teamId ? store.getTeam(teamId) : undefined
  if (input.task?.projectId && mentions.mentionedProjectId && input.task.projectId !== mentions.mentionedProjectId) warnings.push('任务已绑定项目，其他 @项目提及将被忽略；不会切换文件归属')
  if (input.task && (input.nodeRef || input.projectId || input.mode)) warnings.push('已有任务预检沿用其节点/项目/模式快照；这些创建参数不会修改已有任务')
  const ids = chatAgentId ? [chatAgentId] : [...new Set([...(input.memberAgentIds || []), ...mentions.mentionedAgentIds, ...(team?.members.flatMap(m => m.agentId ? [m.agentId] : []) || [])])]
  const roles = ids.map(id => {
    const agent = store.getAgent(id)
    const observed = agents.find(a => a.id === id)
    // Unobserved is unknown, not offline. Explicit failed observations stay false.
    const state = observed?.healthObserved === false ? { ...observed, online: null } : observed
    if (state?.online === false) warnings.push(chatAgentId ? `直聊 BOT ${id} 离线（监控快照）；执行不可用时失败，不回退任务节点或其他 BOT` : `成员 ${id} 离线；引擎可能回退任务节点，实际节点待运行时解析`)
    if (state?.busy) warnings.push(`成员 ${id} 忙碌（监控快照）`)
    if (!agent && chatAgentId) warnings.push(`直聊 BOT ${id} 已缺失；不可执行，不回退任务节点或其他 BOT`)
    if (agent?.enabled === false) warnings.push(chatAgentId ? `直聊 BOT ${id} 已停用；不可执行，不回退任务节点或其他 BOT` : `成员 ${id} 已停用`)
    return { id, name: agent?.name || id, kind: 'agent', executionNode: health(agent?.dshRef), online: state?.online ?? null, busy: state?.busy ?? null, ...(chatAgentId ? { configured: Boolean(agent), enabled: agent?.enabled !== false && Boolean(agent) } : {}) }
  })
  const expertIds = [...new Set([...(mentions.mentionedExpertIds || []), ...(team?.members.flatMap(m => m.expertId ? [m.expertId] : []) || [])])]
  for (const id of expertIds) roles.push({ id, name: id, kind: 'expert', executionNode: publicNode(exec.dshRef), online: null, busy: null })
  const planned = roles.length > 0 || Boolean(teamId)
  if (!overview) warnings.push('未装配监控快照，在线/忙闲未知；未主动探活')
  if (!exec.dshRef && !chatAgentId) warnings.push('未绑定任务节点：主调度及存量成员回退取决于运行时可用性，未解析')
  if (input.task && engine.isRunning(input.task.id)) warnings.push('任务正在执行；send 将排队，预检不预言出队时路由')
  return {
    ok: true, readOnly: true, projectId: projectId || null,
    route: chatAgentId ? 'agent-chat' : planned ? 'orchestrate' : exec.dshRef ? 'node-chat' : 'runtime-fallback',
    chatAgentId: chatAgentId || null,
    planning: chatAgentId ? '持久硬绑定 BOT 直聊：跳过规划；不可用时失败，不回退。roles 是本轮执行者，roster 仅为成员账本' : planned ? '未规划：显式提及触发主调度规划，以下为候选角色及其绑定节点，非最终子任务执行分配' : '无显式角色提及：主会话执行；成员账本不等于本轮派工',
    roles: planned ? roles : [{ id: '__node__', name: '主会话', kind: 'node', executionNode: publicNode(exec.dshRef) }],
    roster: snapshot.memberAgentIds,
    executionNode: health(chatAgentId ? store.getAgent(chatAgentId)?.dshRef : exec.dshRef),
    files: { node: publicNode(exec.workspaceDshRef), workspace: exec.workspace || null },
    permissionBoundary: { readOnly: true, createsTask: false, remoteCommands: false, grantsAccess: false, credentialsReturned: false, projectFiles: project ? (project.archivedAt ? 'archived-read-only' : 'existing-project-permissions') : 'existing-node-permissions', note: '仅预览既有权限；不授权文件访问/跨节点执行，不包含凭据；实际执行仍受原有权限与可达性检查' },
    monitorSnapshotAt: (overview as { at?: number } | undefined)?.at ?? null,
    warnings: [...new Set(warnings)],
  }
}
