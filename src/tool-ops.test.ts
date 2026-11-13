/**
 * tool-ops 单元测试（task-53 / task-54）。
 *
 * 覆盖：
 *  1. task_manage list keyword 过滤（task-53）：按 ID / 标题大小写不敏感包含匹配；
 *     不传 keyword 回全量（向后兼容），回包带 matched 计数。
 *  2. task_status detail:"full" 超大任务降级（task-54）：>32KB 回「摘要 + chatDownloadUrl」
 *     而非全文；≤32KB 行为不变；下载令牌用真实 HMAC 实现（SkillPluginLibrary）签发与校验，
 *     错误任务 ID 的令牌不可用、可校验通过正确 ID。
 *
 * 运行：npm run test:unit（engine/store 等依赖全部以 stub 注入，无网络）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 测试进程内禁止构造函数自带的 30s 启动归档扫描（对齐 store.test 做法）
process.env.WORKBUDDY_ARCHIVE_BOOT_DELAY_MS = '3600000'

import { createWorkBuddyToolDefs } from './tool-ops.js'
import { GroupStore } from './groups.js'
import { WorkStore } from './store.js'
import { SkillPluginLibrary } from './library.js'
import { DshClient, type DshTarget } from './remote-client.js'
import type { WorkTask } from './types.js'
import { publicNode } from './task-preflight.js'
import { normalizeToolResult } from './tool-errors.js'

/** 最小 TaskEngine stub：list/taskStatus 的运行态与审计日志。 */
const engineStub = { validateChatBinding: () => {}, isRunning: (_id: string) => false, logTask: () => {}, extractMentions: async () => ({ mentionedAgentIds: [], mentionedExpertIds: [] }) } as any

function makeTask(partial: Partial<WorkTask>): WorkTask {
  const now = Date.now()
  return {
    id: partial.id || `task-${Math.random().toString(36).slice(2, 10)}`,
    title: partial.title || '测试任务',
    mode: 'chat',
    status: partial.status || 'completed',
    memberAgentIds: [],
    turns: partial.turns || [{ id: 't1', seq: 1, role: 'user' as const, at: Date.now(), text: '你好' }],
    sessions: {},
    taskLogs: [],
    summary: partial.summary,
    createdAt: now,
    updatedAt: now,
    ...partial,
  } as WorkTask
}

function setup(tasks: WorkTask[], engine: any = engineStub, monitor?: any) {
  const dataDir = mkdtempSync(join(tmpdir(), 'wb-toolops-test-'))
  const store = new WorkStore(join(dataDir, 'store.json'))
  for (const t of tasks) store.upsertTask(t)
  const library = new SkillPluginLibrary(dataDir, store, () => {})
  const tools = createWorkBuddyToolDefs({
    store,
    directory: {} as any,
    resolver: {} as any,
    composer: {} as any,
    planner: {} as any,
    engine,
    monitor,
    sshStore: {} as any,
    consoleUrl: 'http://127.0.0.1:1/wb',
    downloadTokens: library,
  })
  const byName = (name: string) => tools.find((t) => t.name === name)!
  return { store, library, byName, cleanup: async () => {
    store.flush()
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(dataDir.startsWith(join(tmpdir(), 'wb-toolops-test-')))
    rmSync(dataDir, { recursive: true, force: true })
  } }
}

test('task-86: field errors, stable categories, safe retries and credential-free recovery', async () => {
  const fixture = setup([])
  try {
    for (const [name, args, field] of [
      ['project_manage', { action: 'get' }, 'projectId'],
      ['task_manage', { action: 'wait' }, 'taskId'],
      ['task_chat', {}, 'taskId'],
    ] as const) {
      const result = JSON.parse(await fixture.byName(`workbuddy_${name}`).execute({ ...args, typo: 'ignored' }))
      assert.equal(result.code, 'INVALID_PARAM')
      assert.equal(result.field, field)
      assert.equal(result.message, result.error)
      assert.equal(result.retryable, false)
      assert.ok(result.paramWarnings.length)
      assert.deepEqual(result.recovery.fields, [field])
    }
    const missing = JSON.parse(await fixture.byName('workbuddy_project_manage').execute({ action: 'get', projectId: 'absent' }))
    assert.equal(missing.code, 'NOT_FOUND')
    assert.equal(missing.retryable, false)
    const offline = normalizeToolResult({ ok: false, code: 'NODE_OFFLINE', error: 'arbitrary text' }, { tool: 'workbuddy_task_chat', args: { taskId: 't', apiKey: 'secret' } })
    assert.equal(offline.retryable, true)
    assert.equal(offline.retryAfterMs, 2000)
    assert.deepEqual(offline.recovery.arguments, { taskId: 't' })
    assert.deepEqual(normalizeToolResult(offline, { tool: 'workbuddy_task_chat', args: { taskId: 't' } }), offline)
    for (const args of [{ action: 'create' }, { action: 'send', taskId: 't' }]) {
      const failed = normalizeToolResult({ ok: false, code: 'NODE_OFFLINE', retryable: true, error: 'Bearer super-secret onk-private', apiKey: 'secret' }, { tool: 'workbuddy_task_manage', args })
      assert.equal(failed.retryable, false)
      assert.equal(failed.retryAfterMs, undefined)
      assert.equal(failed.recovery.kind, 'stop')
      assert.ok(!JSON.stringify(failed).includes('super-secret'))
      assert.ok(!JSON.stringify(failed).includes('onk-private'))
      assert.equal(failed.apiKey, '[REDACTED]')
    }
    const created = normalizeToolResult({ ok: false, code: 'WRITEBACK_FAILED', taskCreated: true, taskId: 'created', retryable: true, error: 'writeback' }, { tool: 'workbuddy_backlog_manage', args: { action: 'dispatch' } })
    assert.equal(created.retryable, false)
    assert.equal(created.recovery.tool, 'workbuddy_task_status')
    assert.deepEqual(created.recovery.arguments, { taskId: 'created' })
    for (const [code, category] of [['PERMISSION_DENIED', 'PERMISSION_DENIED'], ['SESSION_EXPIRED', 'SESSION_EXPIRED'], ['EXECUTION_FAILED', 'EXECUTION_FAILED']]) {
      const failure = normalizeToolResult({ ok: false, code, error: '相同描述' })
      assert.equal(failure.category, category)
    }
  } finally { await fixture.cleanup() }
})

test('task-59: 聊天工具历史与追问使用绑定节点，离线与无权限在 IO 前拒绝', async () => {
  const calls: Array<{ base: string; sessionId: string }> = []
  let online = true, memberId = ''
  const engine = { ...engineStub, resolveExecTarget: async (_task: WorkTask, agentId: string) => {
    assert.ok(['__node__', memberId].includes(agentId))
    return online ? { online: true, baseUrl: 'http://original-node:300' } : undefined
  } }
  const task = makeTask({ id: 'task-bound-chat', ownerUserId: 'alice', sessions: {
    __node__: { remoteSessionId: 'main-session', baseUrl: 'http://obsolete:100', nodeRefKey: 'mapping:physical-a', createdAt: 1 },
    member: { remoteSessionId: 'member-session', baseUrl: 'http://obsolete:100', nodeRefKey: 'mapping:physical-a', createdAt: 1 },
  } })
  const fixture = setup([task], engine)
  const history = DshClient.prototype.getHistory, prompt = DshClient.prototype.prompt
  DshClient.prototype.getHistory = async (target: DshTarget, sessionId: string) => {
    calls.push({ base: target.baseUrl, sessionId }); return { ok: true, messages: [{ role: 'assistant', content: 'original history' }] }
  }
  DshClient.prototype.prompt = async (target: DshTarget, sessionId: string) => {
    calls.push({ base: target.baseUrl, sessionId }); return { ok: true, content: 'original reply' }
  }
  try {
    memberId = fixture.store.upsertAgent({ name: 'changed entity', dshRef: { kind: 'mapping', mappingId: 'different-node' } }).id
    fixture.store.mutateTask(task.id, t => { t.sessions[memberId] = t.sessions.member; delete t.sessions.member })
    const tool = fixture.byName('workbuddy_task_chat'), args = { taskId: task.id, subtaskId: memberId }
    const ctx = { channel: 'http' as const, maxBlockMs: 1000, session: { userId: 'alice', role: 'user' as const } }
    assert.equal(JSON.parse(await tool.execute(args, ctx)).messages[0].content, 'original history')
    assert.equal(JSON.parse(await tool.execute({ ...args, followupMessage: 'continue' }, ctx)).reply, 'original reply')
    assert.equal(JSON.parse(await tool.execute({ ...args, subtaskId: '__node__' }, ctx)).sessionId, 'main-session')
    assert.deepEqual(calls, [
      { base: 'http://original-node:300', sessionId: 'member-session' },
      { base: 'http://original-node:300', sessionId: 'member-session' },
      { base: 'http://original-node:300', sessionId: 'main-session' },
    ])
    online = false
    assert.equal(JSON.parse(await tool.execute(args, ctx)).ok, false)
    assert.equal(JSON.parse(await tool.execute({ ...args, followupMessage: 'offline' }, ctx)).ok, false)
    online = true
    assert.equal(JSON.parse(await tool.execute(args, { ...ctx, session: { userId: 'bob', role: 'user' } })).ok, false)
    assert.equal(calls.length, 3)
  } finally {
    DshClient.prototype.getHistory = history; DshClient.prototype.prompt = prompt
    await fixture.cleanup()
  }
})

test('task-85: completed main task defaults to main and explains empty remote history with ledger reply', async () => {
  const task = makeTask({ id: 'empty-remote', sessions: { __node__: { remoteSessionId: 'session', baseUrl: 'http://old', createdAt: 1 } }, turns: [{ id: 'reply', seq: 1, role: 'agent', agentId: '__node__', text: 'WB_AI_UX_20261108_OK', at: 1 }] })
  const f = setup([task], { ...engineStub, resolveExecTarget: async () => ({ online: true, baseUrl: 'http://node' }) })
  const original = DshClient.prototype.getHistory
  DshClient.prototype.getHistory = async () => ({ ok: true, messages: [] })
  try {
    for (const channel of ['http', 'mcp'] as const) {
      const ctx = { channel, maxBlockMs: 0 }
      const chat = JSON.parse(await f.byName('workbuddy_task_chat').execute({ taskId: task.id }, ctx))
      assert.equal(chat.ok, true)
      assert.equal(chat.source, 'platform_ledger')
      assert.equal(chat.fallback.reason, 'remote_history_empty')
      assert.equal(chat.messages[0].content, 'WB_AI_UX_20261108_OK')
      for (const out of [chat, JSON.parse(await f.byName('workbuddy_task_manage').execute({ action: 'wait', taskId: task.id }, ctx)), ...await Promise.all(['summary', 'full'].map(async detail => JSON.parse(await f.byName('workbuddy_task_status').execute({ taskId: task.id, detail }, ctx))))]) {
        assert.equal(out.taskId, task.id)
        assert.equal(out.status, 'completed')
        assert.equal(out.lastReply, 'WB_AI_UX_20261108_OK')
        assert.equal(typeof out.clipped, 'boolean')
        assert.ok('route' in out)
        assert.equal(out.source, 'platform_ledger')
      }
    }
  } finally { DshClient.prototype.getHistory = original; await f.cleanup() }
})

test('task-85: multiple members expose choices; explicit targets never borrow another reply', async () => {
  const task = makeTask({ id: 'multi', memberAgentIds: ['a', 'b'], sessions: { a: { remoteSessionId: 'sa', baseUrl: '', createdAt: 1 }, b: { remoteSessionId: 'sb', baseUrl: '', createdAt: 1 } }, turns: [{ id: 'b-reply', seq: 1, role: 'agent', agentId: 'b', text: 'only-b', at: 1 }] })
  const f = setup([task], { ...engineStub, resolveExecTarget: async () => undefined })
  try {
    const tool = f.byName('workbuddy_task_chat')
    const choice = JSON.parse(await tool.execute({ taskId: task.id }))
    assert.equal(choice.code, 'CHAT_TARGET_REQUIRED')
    assert.deepEqual(choice.targets.map((t: any) => t.id), ['a', 'b'])
    const a = JSON.parse(await tool.execute({ taskId: task.id, subtaskId: 'a' }))
    assert.equal(a.ok, false)
    assert.deepEqual(a.messages, [])
    const b = JSON.parse(await tool.execute({ taskId: task.id, subtaskId: 'b' }))
    assert.equal(b.ok, true)
    assert.equal(b.source, 'platform_ledger')
    assert.equal(b.messages[0].content, 'only-b')
    assert.equal(b.fallback.reason, 'remote_history_unavailable')
  } finally { await f.cleanup() }
})

test('task-85: empty history is explained; pagination and newest-message byte clipping are visible', async () => {
  const task = makeTask({ id: 'clip-chat', sessions: { __node__: { remoteSessionId: 's', baseUrl: '', createdAt: 1 } } })
  const f = setup([task], { ...engineStub, resolveExecTarget: async () => ({ online: true, baseUrl: 'http://node' }) })
  const original = DshClient.prototype.getHistory
  try {
    const tool = f.byName('workbuddy_task_chat')
    DshClient.prototype.getHistory = async () => ({ ok: true, messages: [] })
    const empty = JSON.parse(await tool.execute({ taskId: task.id }))
    assert.equal(empty.ok, true)
    assert.match(empty.emptyReason, /没有消息/)
    assert.equal(empty.fallback.reason, 'remote_history_empty')
    DshClient.prototype.getHistory = async () => ({ ok: true, hasMore: true, totalMessages: 100, messages: [{ role: 'assistant', content: 'old'.repeat(6000) }, { role: 'assistant', content: 'NEW'.repeat(6000) }] })
    const clipped = JSON.parse(await tool.execute({ taskId: task.id, maxTextChars: '20000' }))
    assert.equal(clipped.clipped, true)
    assert.equal(clipped.messages.length, 1)
    assert.match(clipped.messages[0].content, /^NEW/)
    assert.equal(clipped.source, 'remote_history')
    const full = JSON.parse(await tool.execute({ taskId: task.id, full: 'true' }))
    assert.equal(full.messages.length, 2)
    assert.equal(full.clipped, true) // upstream page still has older messages
    DshClient.prototype.getHistory = async () => ({ ok: true, messages: [{ role: 'assistant', content: '最新回复'.repeat(5000) }] })
    const multibyte = JSON.parse(await tool.execute({ taskId: task.id, maxTextChars: '20000' }))
    assert.equal(multibyte.returned, 1)
    assert.equal(multibyte.clipped, true)
    assert.match(multibyte.messages[0].content, /^最新回复/)
    assert.ok(Buffer.byteLength(JSON.stringify(multibyte.messages)) < 33 * 1024)
  } finally { DshClient.prototype.getHistory = original; await f.cleanup() }
})

test('task-85: subtask history uses its own session instead of latest member session', async () => {
  const task = makeTask({ id: 'subtask-session', sessions: { a: { remoteSessionId: 'latest', baseUrl: '', createdAt: 1 } }, plan: { strategy: 'sequential', createdAt: 1, subtasks: [{ id: 'sub-old', title: 'old', prompt: '', agentId: 'a', dependsOn: [], status: 'completed', remoteSessionId: 'original', logs: [], result: { content: 'scoped-result' } }] } })
  const f = setup([task], { ...engineStub, resolveExecTarget: async () => ({ online: true, baseUrl: 'http://node' }) })
  const original = DshClient.prototype.getHistory
  DshClient.prototype.getHistory = async (_target, id) => { assert.equal(id, 'original'); return { ok: true, messages: [] } }
  try {
    const out = JSON.parse(await f.byName('workbuddy_task_chat').execute({ taskId: task.id, subtaskId: 'sub-old' }))
    assert.equal(out.sessionId, 'original')
    assert.equal(out.messages[0].content, 'scoped-result')
    assert.equal(out.source, 'platform_ledger')
  } finally { DshClient.prototype.getHistory = original; await f.cleanup() }
})

test('task-84: direct preview identities exclude credentials, paths and query tokens', () => {
  assert.deepEqual(publicNode({ kind: 'direct', apiBaseUrl: 'https://user:SECRET@example.test/api/SECRET?token=SECRET#SECRET' }), { kind: 'direct', nodeId: 'direct:https://example.test' })
})

test('task-84: compact monitor retains stable dispatch identity and busy state', async () => {
  const agents = [{ id: 'a', name: 'same', online: true, busy: true, nodeId: 'mapping:n' }, { id: 'b', name: 'same', online: false, busy: false, nodeId: 'app:m' }]
  const f = setup([], engineStub, { getOverview: async () => ({ agents, kpi: { agentsBusy: 1 } }) })
  try {
    const out = JSON.parse(await f.byName('workbuddy_monitor_read').execute({ action: 'overview' }))
    assert.deepEqual(out.agents, agents)
    assert.equal(out.agents.filter((a: any) => a.busy).length, out.kpi.agentsBusy)
  } finally { await f.cleanup() }
})

test('task-84: invalid IDs and ambiguous names fail before create/send/preflight mutations', async () => {
  let mutations = 0
  const engine = { ...engineStub, extractMentions: async () => { throw Object.assign(new Error('名称歧义'), { code: 'AMBIGUOUS_MENTION', candidates: [{ id: 'a', name: 'same', type: 'agent', apiKey: 'SECRET' }] }) }, createTask: async () => { mutations++ }, sendUserMessage: async () => { mutations++ } }
  const f = setup([makeTask({ id: 'target' })], engine)
  try {
    const tool = f.byName('workbuddy_task_manage')
    for (const action of ['create', 'send', 'preflight']) {
      const out = JSON.parse(await tool.execute({ action, taskId: 'target', message: '@same do work' }))
      assert.equal(out.code, 'AMBIGUOUS_MENTION')
      assert.deepEqual(out.candidates, [{ id: 'a', name: 'same', type: 'agent' }])
      assert.ok(!JSON.stringify(out).includes('SECRET'))
    }
    for (const memberAgentIds of ['{}', [1], [''], ['missing']]) {
      const out = JSON.parse(await tool.execute({ action: 'create', memberAgentIds }))
      assert.equal(out.ok, false)
    }
    assert.equal(mutations, 0)
    assert.equal(f.store.getTasks().length, 1)
  } finally { await f.cleanup() }
})

test('task-84: send forwards explicit structured IDs before delivery', async () => {
  let options: any
  const f = setup([makeTask({ id: 'send-by-id' })], { ...engineStub, sendUserMessage: async (_id: string, _text: string, opts: any) => { options = opts; return { ok: true } } })
  try {
    const a = f.store.upsertAgent({ name: 'same', dshRef: { kind: 'mapping', mappingId: 'n' } })
    const out = JSON.parse(await f.byName('workbuddy_task_manage').execute({ action: 'send', taskId: 'send-by-id', message: 'explicit ID intent', memberAgentIds: JSON.stringify([a.id]) }))
    assert.equal(out.ok, true)
    assert.deepEqual(options.memberAgentIds, [a.id])
  } finally { await f.cleanup() }
})

test('task-84: structured member IDs remain arrays and support duplicate-name roster selection', async () => {
  let saved: any
  const f = setup([], { ...engineStub, createTask: async (input: any) => { saved = input; return makeTask(input) } })
  try {
    const a = f.store.upsertAgent({ name: 'same', dshRef: { kind: 'mapping', mappingId: 'n1' } })
    f.store.upsertAgent({ name: 'same', dshRef: { kind: 'mapping', mappingId: 'n2' } })
    const out = JSON.parse(await f.byName('workbuddy_task_manage').execute({ action: 'create', title: a.id, memberAgentIds: [a.id] }))
    assert.equal(out.ok, true)
    assert.deepEqual(saved.memberAgentIds, [a.id])
  } finally { await f.cleanup() }
})

test('task-84: preflight uses engine taskExec, separates file owner, warns without executing/planning', async () => {
  let f: ReturnType<typeof setup>
  let workerId = ''
  const engine = { ...engineStub, extractMentions: async (text: string) => ({ mentionedAgentIds: text ? [workerId] : [], mentionedExpertIds: [] }), taskExec: (task: WorkTask) => {
    const p = f.store.getProject(task.projectId!)!
    return { dshRef: task.nodeRef || p.dshRef, workspaceDshRef: p.dshRef, workspace: p.workspace, apiKey: p.apiKey }
  } }
  f = setup([], engine, { peekOverview: () => ({ agents: [{ id: workerId, online: false, busy: true }], nodes: [{ mappingId: 'exec', online: false, runningCount: 1 }] }), getOverview: () => { throw new Error('预检不能刷新监控或访问远端') } })
  try {
    workerId = f.store.upsertAgent({ name: 'worker', dshRef: { kind: 'mapping', mappingId: 'worker-node' } }).id
    const p = f.store.upsertProject({ name: 'project', owner: 'alice', dshRef: { kind: 'mapping', mappingId: 'files' }, defaultExecutionNodeRef: { kind: 'mapping', mappingId: 'exec' }, workspace: '/repo', apiKey: 'SECRET' })
    const tool = f.byName('workbuddy_task_manage')
    const ctx = { channel: 'http' as const, maxBlockMs: 0, session: { userId: 'alice', role: 'user' as const } }
    const before = structuredClone(f.store.getProjects())
    const out = JSON.parse(await tool.execute({ action: 'preflight', projectId: p.id, message: '@worker analyze' }, ctx))
    assert.equal(out.readOnly, true)
    assert.equal(out.executionNode.nodeId, 'mapping:exec')
    assert.deepEqual(out.files, { node: { kind: 'mapping', nodeId: 'mapping:files' }, workspace: '/repo' })
    assert.match(out.planning, /未规划/)
    assert.equal(out.roles[0].executionNode.nodeId, 'mapping:worker-node')
    assert.match(out.warnings.join(' '), /离线/)
    assert.match(out.warnings.join(' '), /忙碌/)
    assert.ok(!JSON.stringify(out).includes('SECRET'))
    const plain = JSON.parse(await tool.execute({ action: 'preflight', projectId: p.id, memberAgentIds: [workerId] }, ctx))
    assert.equal(plain.route, 'orchestrate')
    assert.equal(plain.roles[0].id, workerId)
    const denied = JSON.parse(await tool.execute({ action: 'preflight', projectId: p.id }, { ...ctx, session: { userId: 'bob', role: 'user' } }))
    assert.equal(denied.code, 'PROJECT_NOT_FOUND')
    assert.ok(!JSON.stringify(denied).includes('/repo'))
    assert.equal(f.store.getTasks().length, 0)
    assert.deepEqual(f.store.getProjects(), before)
  } finally { await f.cleanup() }
})

test('task-53: task_manage list 不传 keyword 时回全量（向后兼容）', async () => {
  const a = makeTask({ id: 'task-a', title: '磁盘巡检' })
  const b = makeTask({ id: 'task-b', title: '日志分析' })
  const { byName, cleanup } = setup([a, b])
  try {
    const out = JSON.parse(await byName('workbuddy_task_manage').execute({ action: 'list' }))
    assert.equal(out.ok, true)
    assert.equal(out.tasks.length, 2)
    assert.equal(out.matched, undefined)
  } finally { await cleanup() }
})

test('task-53: task_manage list keyword 按标题大小写不敏感过滤', async () => {
  const a = makeTask({ id: 'task-a', title: 'Disk 巡检' })
  const b = makeTask({ id: 'task-b', title: '日志分析' })
  const { byName, cleanup } = setup([a, b])
  try {
    const out = JSON.parse(await byName('workbuddy_task_manage').execute({ action: 'list', keyword: 'DISK' }))
    assert.equal(out.ok, true)
    assert.equal(out.keyword, 'DISK')
    assert.equal(out.matched, 1)
    assert.deepEqual(out.tasks.map((t: any) => t.id), ['task-a'])
  } finally { await cleanup() }
})

test('task-53: task_manage list keyword 按任务 ID 过滤且不命中返回空集', async () => {
  const a = makeTask({ id: 'task-a1b2', title: ' unrelated ' })
  const { byName, cleanup } = setup([a])
  try {
    const hit = JSON.parse(await byName('workbuddy_task_manage').execute({ action: 'list', keyword: 'a1b2' }))
    assert.equal(hit.matched, 1)
    const miss = JSON.parse(await byName('workbuddy_task_manage').execute({ action: 'list', keyword: 'zzzz' }))
    assert.equal(miss.ok, true)
    assert.equal(miss.matched, 0)
    assert.deepEqual(miss.tasks, [])
  } finally { await cleanup() }
})

test('task-54: task_status detail:full 小任务仍回完整 task（向后兼容）', async () => {
  const t = makeTask({ id: 'task-small', title: '小任务', turns: [{ id: 't1', seq: 1, role: 'user' as const, at: Date.now(), text: 'hello' }] })
  const { byName, cleanup } = setup([t])
  try {
    const out = JSON.parse(await byName('workbuddy_task_status').execute({ taskId: 'task-small', detail: 'full' }))
    assert.equal(out.ok, true)
    assert.equal(out.oversized, undefined)
    assert.equal(out.task.id, 'task-small')
    assert.equal(out.chatDownloadUrl, undefined)
  } finally { await cleanup() }
})

test('task-54: task_status detail:full 超大任务降级为摘要 + chatDownloadUrl', async () => {
  // 32KB 阈值：正文 40KB 中文（UTF-8 每字 3 字节）稳定超限
  const big = '流'.repeat(40 * 1024)
  const t = makeTask({
    id: 'task-big',
    title: '超大任务',
    turns: [
      { id: 't1', seq: 1, role: 'user' as const, at: Date.now(), text: '帮我分析大日志' },
      { id: 't2', seq: 2, role: 'agent' as const, at: Date.now(), agentId: 'a1', agentName: 'worker', text: big },
    ],
    summary: undefined,
  })
  const { byName, library, cleanup } = setup([t])
  try {
    const raw = await byName('workbuddy_task_status').execute(
      { taskId: 'task-big', detail: 'full' },
      { channel: 'mcp', maxBlockMs: 0, requestBase: 'http://caller-view/wb' },
    )
    assert.equal(Buffer.byteLength(raw) < 32 * 1024, true, '降级后回包必须小于阈值')
    const out = JSON.parse(raw)
    assert.equal(out.ok, true)
    assert.equal(out.oversized, true)
    assert.equal(out.taskId, t.id)
    assert.equal(out.status, t.status)
    assert.equal(out.source, 'platform_ledger')
    assert.equal(out.clipped, true)
    assert.ok('route' in out)
    assert.equal(out.task, undefined, '降级后不回全文 task 对象')
    assert.equal(out.turns, 2)
    assert.equal(out.summary, '')
    assert.match(out.chatDownloadUrl, /^http:\/\/caller-view\/wb\/api\/tasks\/task-big\/chat-export\?token=/)
    assert.match(out.chatDownloadUrl, /format=json/)
    assert.match(out.chatDownloadUrlMarkdown, /format=markdown/)
    // 签发令牌可用真实 HMAC 校验通过；换任务 ID 即失效
    const token = new URL(out.chatDownloadUrl).searchParams.get('token')!
    assert.equal(library.verifyDownloadToken('chat-export:task-big', token), true)
    assert.equal(library.verifyDownloadToken('chat-export:task-other', token), false)
    assert.equal(library.verifyDownloadToken('chat-export:task-big', '123.badsig'), false)
  } finally { await cleanup() }
})

test('task-56: 工具创建支持 mapping/app/direct，精确与近似去重均按项目与执行节点区分', async () => {
  let fixture: ReturnType<typeof setup>
  const calls: any[] = []
  const engine = { ...engineStub, createTask: async (input: any) => {
    calls.push(input)
    const project = fixture.store.getProject(input.projectId)
    const task = makeTask({ ...input, status: 'draft', nodeRef: input.nodeRef || project?.defaultExecutionNodeRef || project?.dshRef, turns: input.message ? [{ id: 'user', seq: 1, role: 'user', text: input.message, at: Date.now() }] : [] })
    fixture.store.upsertTask(task)
    return task
  } }
  fixture = setup([], engine)
  try {
    const owner = { kind: 'mapping' as const, mappingId: 'tool-owner' }
    const a = fixture.store.upsertProject({ name: 'A', dshRef: owner })
    const b = fixture.store.upsertProject({ name: 'B', dshRef: owner })
    const tool = fixture.byName('workbuddy_task_manage')
    const title = 'task56-' + a.id
    const message = '验证不同节点执行相同项目指令。后续验收'
    const refs = [owner, { kind: 'app', appId: 'tool-executor' }, { kind: 'direct', apiBaseUrl: 'http://tool-executor' }]
    const ids = []
    for (const nodeRef of refs) {
      const out = JSON.parse(await tool.execute({ action: 'create', title, message, projectId: a.id, nodeRef }))
      assert.equal(out.ok, true)
      assert.equal(out.deduped, undefined, '不同执行节点必须创建独立任务')
      assert.deepEqual(calls.at(-1)?.nodeRef, nodeRef)
      ids.push(out.taskId)
    }
    assert.equal(new Set(ids).size, refs.length)
    const retry = JSON.parse(await tool.execute({ action: 'create', title, message, projectId: a.id, nodeRef: refs[1] }))
    assert.equal(retry.taskId, ids[1])
    assert.equal(retry.deduped, true)
    const fuzzy = JSON.parse(await tool.execute({ action: 'create', title: title + '-retry', message: message.replace('后续验收', '改写后续说明'), projectId: a.id, nodeRef: refs[1] }))
    assert.equal(fuzzy.taskId, ids[1])
    const otherProject = JSON.parse(await tool.execute({ action: 'create', title, message, projectId: b.id, nodeRef: refs[1] }))
    assert.equal(otherProject.deduped, undefined, '另一个项目不得被首句去重合并')
    const invalid = JSON.parse(await tool.execute({ action: 'create', title: title + '-invalid', projectId: a.id, nodeRef: { kind: 'app' } }))
    assert.equal(invalid.ok, false, '无效 nodeRef 不得静默落回项目默认节点')
  } finally { await fixture.cleanup() }
})

test('task-55: MCP 项目新建/编辑共享唯一性约束，冲突仅返回通用信息且保留权限', async () => {
  const { store, byName, cleanup } = setup([])
  try {
    const ref = { kind: 'mapping' as const, mappingId: 'owner-node' }
    const p = store.upsertProject({ name: 'private-project-name', owner: 'alice', apiKey: 'private-api-key', instruction: 'private-instruction', projectMembers: [{ userId: 'alice', role: 'owner', joinedAt: 1 }], dshRef: ref, workspace: '/private/repo' })
    const tool = byName('workbuddy_project_manage')
    const ctx = { channel: 'mcp' as const, maxBlockMs: 0, session: { userId: 'bob', role: 'user' as const } }
    const conflict = JSON.parse(await tool.execute({ action: 'upsert', project: { name: 'new', dshRef: ref, workspace: '/private/repo/src/../' } }, ctx))
    assert.equal(conflict.message, conflict.error)
    assert.equal(conflict.retryable, false)
    assert.deepEqual(conflict.recovery, { kind: 'stop' })
    assert.equal(conflict.status, 409)
    assert.equal(conflict.code, 'PROJECT_WORKSPACE_CONFLICT')
    for (const secret of [p.id, p.name, p.apiKey!, p.instruction!, 'alice']) assert.ok(!JSON.stringify(conflict).includes(secret))
    const other = JSON.parse(await tool.execute({ action: 'upsert', project: { name: 'other', dshRef: { kind: 'mapping', mappingId: 'other-node' }, workspace: '/private/repo' } }, ctx))
    assert.equal(other.ok, true)
    assert.equal(other.project.owner, 'bob')
    const before = structuredClone(store.getProject(other.project.id))
    const edit = JSON.parse(await tool.execute({ action: 'upsert', project: { id: other.project.id, name: 'edited', dshRef: ref } }, ctx))
    assert.equal(edit.code, 'PROJECT_WORKSPACE_CONFLICT')
    assert.deepEqual(store.getProject(other.project.id), before)
    assert.deepEqual(store.getProject(p.id)?.projectMembers, p.projectMembers)
    const invalid = JSON.parse(await tool.execute({ action: 'upsert', project: { name: 'invalid', dshRef: ref, workspace: './repo' } }, ctx))
    assert.equal(invalid.code, 'PROJECT_WORKSPACE_INVALID')
  } finally { await cleanup() }
})

test('task-55: MCP 已登录用户不可读取/改写隐藏项目，成员不可管理，服务令牌冲突也不返回私有数据', async () => {
  const { store, byName, cleanup } = setup([])
  try {
    const p = store.upsertProject({ name: 'private', owner: 'alice', apiKey: 'secret', projectMembers: [{ userId: 'alice', role: 'owner', joinedAt: 1 }, { userId: 'bob', role: 'member', joinedAt: 2 }], dshRef: { kind: 'app', appId: 'node' }, workspace: '/repo' })
    const tool = byName('workbuddy_project_manage')
    const ctx = { channel: 'mcp' as const, maxBlockMs: 0, session: { userId: 'carol', role: 'user' as const } }
    for (const action of ['get', 'upsert', 'delete']) {
      const out = JSON.parse(await tool.execute({ action, projectId: p.id, project: { id: p.id, name: 'overwrite' } }, ctx))
      const missing = JSON.parse(await tool.execute({ action, projectId: 'missing', project: { id: p.id, name: 'overwrite' } }, ctx))
      assert.equal(out.code, 'NOT_FOUND')
      assert.equal(out.message, '项目不存在')
      assert.equal(out.retryable, false)
      assert.equal(out.status, 404)
      if (action !== 'upsert') assert.deepEqual(out, missing, 'hidden and absent objects have identical public errors')
    }
    const list = JSON.parse(await tool.execute({ action: 'list' }, ctx))
    assert.deepEqual(list.projects, [])
    const bob = { ...ctx, session: { userId: 'bob', role: 'user' as const } }
    assert.equal(JSON.parse(await tool.execute({ action: 'get', projectId: p.id }, bob)).project.apiKey, undefined)
    assert.equal(JSON.parse(await tool.execute({ action: 'upsert', project: { id: p.id, name: 'overwrite' } }, bob)).status, 403)
    assert.equal(JSON.parse(await tool.execute({ action: 'delete', projectId: p.id }, bob)).status, 403)
    const conflict = JSON.parse(await tool.execute({ action: 'upsert', project: { name: 'duplicate', dshRef: p.dshRef, workspace: '/repo/' } }, { channel: 'mcp', maxBlockMs: 0, aiTokenOnly: true }))
    assert.equal(conflict.status, 409)
    assert.equal(conflict.project, undefined)
    assert.equal(store.getProjects().length, 1)
  } finally { await cleanup() }
})

test('WEB-2: group_manage ai-token deny precedes arg validation; per-user scope; CRUD + idempotent semantics', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'wb-group-tool-test-'))
  const store = new WorkStore(join(dataDir, 'store.json'))
  const groupsStore = new GroupStore(join(dataDir, 'groups.json'))
  const tools = createWorkBuddyToolDefs({ store, directory: {} as any, resolver: {} as any, composer: {} as any, planner: {} as any, engine: engineStub, sshStore: {} as any, groupsStore, consoleUrl: 'http://127.0.0.1:1/wb' })
  const tool = tools.find((t) => t.name === 'workbuddy_group_manage')!
  const run = async (args: any, ctx?: any) => JSON.parse(await tool.execute(args, ctx))
  const user = { channel: 'http', maxBlockMs: 600000, session: { userId: 'u1', username: '张三', role: 'user' as const } }
  const ai = { channel: 'http', maxBlockMs: 600000, aiTokenOnly: true }
  try {
    // ① 身份先于参数校验（裁定⑤）：空参数 + aiTokenOnly → AI_TOKEN_DENIED（而非 INVALID_PARAM）
    const denied = await run({}, ai)
    assert.equal(denied.code, 'AI_TOKEN_DENIED')
    assert.equal(denied.denied, 'ai-token-group-guard')
    assert.equal((await run({ action: 'list' }, ai)).code, 'AI_TOKEN_DENIED', '只读 action 同样拒绝')
    assert.equal((await run({ action: 'list', session: { userId: 'x' } }, ai)).code, 'AI_TOKEN_DENIED', '身份只取通道，不取工具参数')
    // ② 无登录会话 → UNAUTHORIZED（不落共享桶）
    assert.equal((await run({ action: 'list' }, { channel: 'http', maxBlockMs: 600000 })).code, 'UNAUTHORIZED')
    // ③ create：缺 id 服务端生成；数组去重保序；createdBy 服务端权威（登录用户名）
    const created = await run({ action: 'create', room: { name: '群A', memberAgentIds: ['a', 'b', 'a'], createdBy: 'spoof' } }, user)
    assert.equal(created.ok, true)
    const g1 = created.room
    assert.ok(g1.id)
    assert.deepEqual(g1.memberAgentIds, ['a', 'b'])
    assert.equal(g1.createdBy, '张三')
    assert.equal((await run({ action: 'create', room: { id: 'g-fixed', name: '固定' } }, user)).room.id, 'g-fixed')
    const g1b = (await run({ action: 'create', room: { id: g1.id, name: '群A改' } }, user)).room
    assert.equal(g1b.name, '群A改')
    assert.deepEqual((await run({ action: 'list' }, user)).rooms.map((r: any) => r.id), [g1.id, 'g-fixed'], '同 id 保位覆盖')
    // ④ update 部分字段合并；缺 room 参数校验拒绝
    const patched = await run({ action: 'update', roomId: g1.id, room: { notice: 'hi', mode: 'everyone' } }, user)
    assert.equal(patched.room.notice, 'hi')
    assert.equal(patched.room.mode, 'everyone')
    assert.equal(patched.room.name, '群A改')
    assert.equal((await run({ action: 'update', roomId: g1.id }, user)).code, 'INVALID_PARAM')
    // ⑤ mark_read：字符串归一化 + unreadCount 归零 + 单调不回退
    await run({ action: 'update', roomId: g1.id, room: { unreadCount: 9, lastReadSeq: 4 } }, user)
    const read = await run({ action: 'mark_read', roomId: g1.id, lastReadSeq: '7' }, user)
    assert.equal(read.room.lastReadSeq, 7)
    assert.equal(read.room.unreadCount, 0)
    assert.equal((await run({ action: 'mark_read', roomId: g1.id, lastReadSeq: 2 }, user)).room.lastReadSeq, 7, '单调不回退')
    // ⑥ rounds 幂等去重
    assert.equal((await run({ action: 'add_round', roomId: g1.id, taskId: 't1' }, user)).added, true)
    assert.equal((await run({ action: 'add_round', roomId: g1.id, taskId: 't1' }, user)).added, false)
    assert.deepEqual((await run({ action: 'rounds', roomId: g1.id }, user)).rounds, ['t1'])
    // ⑦ sections + SECTION_CONFLICT 带 nextAction
    assert.equal((await run({ action: 'add_section', name: '工作' }, user)).added, true)
    assert.equal((await run({ action: 'add_section', name: '工作' }, user)).added, false)
    assert.deepEqual((await run({ action: 'sections' }, user)).sections, ['工作'])
    const conflict = await run({ action: 'rename_section', old: '不存在', to: 'x' }, user)
    assert.equal(conflict.code, 'SECTION_CONFLICT')
    assert.equal(conflict.status, 409)
    assert.ok(conflict.nextAction)
    // ⑧ 跨用户隔离 + NOT_FOUND 带 nextAction
    const other = { ...user, session: { userId: 'u2', username: 'u2', role: 'user' as const } }
    assert.deepEqual((await run({ action: 'list' }, other)).rooms, [])
    const nf = await run({ action: 'get', roomId: g1.id }, other)
    assert.equal(nf.code, 'NOT_FOUND')
    assert.equal(nf.status, 404)
    assert.ok(nf.nextAction)
    // ⑨ delete 幂等
    assert.equal((await run({ action: 'delete', roomId: 'g-fixed' }, user)).deleted, true)
    assert.equal((await run({ action: 'delete', roomId: 'g-fixed' }, user)).deleted, false)
    // ⑩ compact 精简视图
    await run({ action: 'update', roomId: g1.id, room: { notice: '很长的公告' } }, user)
    const compact = (await run({ action: 'list', compact: 'true' }, user)).rooms
    assert.ok(!('notice' in compact[0]), 'compact 省略 notice')
    assert.equal(compact[0].name, '群A改')
  } finally {
    store.flush()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
