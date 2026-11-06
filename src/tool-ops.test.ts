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
import { WorkStore } from './store.js'
import { SkillPluginLibrary } from './library.js'
import { DshClient, type DshTarget } from './remote-client.js'
import type { WorkTask } from './types.js'

/** 最小 TaskEngine stub：list/taskStatus 的运行态与审计日志。 */
const engineStub = { isRunning: (_id: string) => false, logTask: () => {} } as any

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

function setup(tasks: WorkTask[], engine: any = engineStub) {
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
    assert.deepEqual(Object.keys(conflict).sort(), ['code', 'error', 'ok', 'status'])
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
      assert.deepEqual(out, { ok: false, error: '项目不存在', status: 404 })
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
