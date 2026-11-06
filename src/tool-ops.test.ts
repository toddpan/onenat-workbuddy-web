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
import type { WorkTask } from './types.js'

/** 最小 TaskEngine stub：list/taskStatus 只用到 isRunning */
const engineStub = { isRunning: (_id: string) => false } as any

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

function setup(tasks: WorkTask[]) {
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
    engine: engineStub,
    sshStore: {} as any,
    consoleUrl: 'http://127.0.0.1:1/wb',
    downloadTokens: library,
  })
  const byName = (name: string) => tools.find((t) => t.name === name)!
  return { store, library, byName, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) }
}

test('task-53: task_manage list 不传 keyword 时回全量（向后兼容）', async () => {
  const a = makeTask({ id: 'task-a', title: '磁盘巡检' })
  const b = makeTask({ id: 'task-b', title: '日志分析' })
  const { byName, cleanup } = setup([a, b])
  try {
    const out = JSON.parse(await byName('workbuddy_task_manage').execute({ action: 'list' }))
    assert.equal(out.ok, true)
    assert.equal(out.tasks.length, 2)
    assert.equal(out.matched, undefined)
  } finally { cleanup() }
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
  } finally { cleanup() }
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
  } finally { cleanup() }
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
  } finally { cleanup() }
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
    assert.equal(out.summary, undefined)
    assert.match(out.chatDownloadUrl, /^http:\/\/caller-view\/wb\/api\/tasks\/task-big\/chat-export\?token=/)
    assert.match(out.chatDownloadUrl, /format=json/)
    assert.match(out.chatDownloadUrlMarkdown, /format=markdown/)
    // 签发令牌可用真实 HMAC 校验通过；换任务 ID 即失效
    const token = new URL(out.chatDownloadUrl).searchParams.get('token')!
    assert.equal(library.verifyDownloadToken('chat-export:task-big', token), true)
    assert.equal(library.verifyDownloadToken('chat-export:task-other', token), false)
    assert.equal(library.verifyDownloadToken('chat-export:task-big', '123.badsig'), false)
  } finally { cleanup() }
})
