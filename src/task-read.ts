import type { WorkTask } from './types.js'

/** Public fields shared by wait/status/chat; task remains available on legacy full responses. */
export function taskReadFields(task: WorkTask, running: boolean) {
  const last = task.turns.filter(t => t.role === 'agent').at(-1)?.text || ''
  const summary = String(task.summary ?? '')
  const clip = (s: string, n: number) => s.length > n ? `${s.slice(0, n)}…（共 ${s.length} 字，已截断）` : s
  return {
    taskId: task.id, title: task.title, status: task.status, running,
    chatAgentId: task.chatAgentId || null,
    route: task.lastRoute ? { kind: task.lastRoute.kind, agentId: task.lastRoute.agentId, agentName: task.lastRoute.agentName, source: task.lastRoute.source } : null,
    summary: clip(summary, 800), lastReply: clip(last, 800), source: 'platform_ledger',
    clipped: summary.length > 800 || last.length > 800,
  }
}

/** Explicit choices prevent a multi-member task from silently selecting another conversation. */
export function taskChatTargets(task: WorkTask) {
  const targets = Object.keys(task.sessions).map(id => ({ id, kind: id === '__node__' ? 'main' : 'member', agentId: id }))
  for (const sub of task.plan?.subtasks || []) targets.push({ id: sub.id, kind: 'subtask', agentId: sub.agentId })
  for (const id of task.memberAgentIds) if (!targets.some(t => t.id === id)) targets.push({ id, kind: 'member', agentId: id })
  return targets
}

export function ledgerMessages(task: WorkTask, agentId: string, subtaskId?: string) {
  if (subtaskId) {
    const sub = task.plan?.subtasks.find(s => s.id === subtaskId)
    // A subtask result is scoped to that subtask, unlike its member's shared session.
    return sub?.result?.content ? [{ role: 'assistant', content: sub.result.content, subtaskId: sub.id }] : []
  }
  return task.turns.filter(t => t.role === 'agent' && (t.agentId === agentId || !t.agentId && agentId === '__node__' && Object.keys(task.sessions).every(id => id === '__node__') && !task.memberAgentIds.length))
    .map(t => ({ role: 'assistant', content: t.text, seq: t.seq, time: t.at, turnId: t.id, agentId }))
}
