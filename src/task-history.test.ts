import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkStore } from './store.js'
import { TaskHistory, TaskHistoryError, taskParticipation } from './task-history.js'
import { WorkBuddyRouter } from './router.js'
import type { PermSession } from './perm.js'
import type { WorkTask } from './types.js'

process.env.WORKBUDDY_ARCHIVE_BOOT_DELAY_MS = '3600000'
const owner: PermSession = { userId: 'owner', role: 'user' }
const member: PermSession = { userId: 'member', role: 'user' }
const admin: PermSession = { userId: 'admin', role: 'admin' }
const oldTime = Date.UTC(2020, 0, 1)
const params = (query = '') => new URLSearchParams(query)
function task(id: string, extra: Partial<WorkTask> = {}): WorkTask {
  return { id, title: id, mode: 'chat', status: 'completed', ownerUserId: 'owner',
    memberAgentIds: ['a'], chatAgentId: 'a', sessions: {}, turns: [],
    createdAt: oldTime, updatedAt: oldTime, ...extra }
}
function fixture(tasks: WorkTask[] = []) {
  const path = join(mkdtempSync(join(tmpdir(), 'wb-history-')), 'store.json')
  writeFileSync(path, JSON.stringify({
    agents: ['a', 'b', 'candidate'].map(id => ({ id, name: id, ownerUserId: 'owner', enabled: true,
      dshRef: { kind: 'direct', apiBaseUrl: `http://${id}` }, createdAt: 1, updatedAt: 1 })),
    projects: ['p', 'q'].map(id => ({ id, name: `Project ${id}`, owner: 'owner',
      projectMembers: [{ userId: 'member', role: 'member', joinedAt: 1 }],
      dshRef: { kind: 'direct', apiBaseUrl: 'http://node' }, workspace: `/${id}`,
      defaultAgentIds: [], createdAt: 1, updatedAt: 1 })), tasks,
  }))
  const store = new WorkStore(path)
  return { store, path, history: new TaskHistory(store) }
}
function denied(fn: () => unknown, status: number, code: string) {
  assert.throws(fn, error => error instanceof TaskHistoryError && error.status === status && error.code === code)
}
const ids = (page: ReturnType<TaskHistory['list']>) => page.items.map(row => row.taskId)

// Seed the real persisted ledger: no token statistics, recent-activity window, or default list cap.
test('all 351 old zero-token tasks remain discoverable in deterministic stable pages', () => {
  const tasks = Array.from({ length: 351 }, (_, i) => task(`old-${String(i).padStart(3, '0')}`))
  const { store, history } = fixture(tasks.reverse())
  try {
    let page = history.list(params('agentId=a&limit=50'), owner)
    const seen: string[] = []
    const snapshotAt = page.snapshotAt
    let pages = 0
    while (true) {
      pages++
      seen.push(...ids(page))
      assert.equal(page.source, 'task_ledger')
      assert.equal(page.sort, 'lastActivityAt_desc_taskId_asc')
      assert.equal(page.snapshotAt, snapshotAt)
      assert.equal(page.expiresAt, snapshotAt + 900_000)
      assert.ok(page.items.every(row => row.createdAt === oldTime && row.summary === ''))
      if (!page.nextCursor) { assert.equal(page.hasMore, false); break }
      assert.equal(page.hasMore, true)
      page = history.list(new URLSearchParams({ cursor: page.nextCursor }), owner)
    }
    assert.equal(pages, 8)
    assert.equal(new Set(seen).size, 351)
    assert.deepEqual(seen, Array.from({ length: 351 }, (_, i) => `old-${String(i).padStart(3, '0')}`))
  } finally { store.flush() }
})

test('concurrent updates, inserts and deletes preserve snapshot order while returning live fields', async () => {
  const { store, history } = fixture(['a', 'b', 'c', 'd', 'e', 'f'].map(id => task(id)))
  try {
    const first = history.list(params('limit=2'), owner)
    assert.deepEqual(ids(first), ['a', 'b'])
    const secondSnapshot = history.list(params('limit=3'), owner)
    await Promise.all([
      Promise.resolve().then(() => store.upsertTask({ ...store.getTask('e')!, title: 'Updated E', status: 'failed' })),
      Promise.resolve().then(() => store.upsertTask(task('new'))),
      Promise.resolve().then(() => store.deleteTask('c')),
    ])
    const second = history.list(new URLSearchParams({ cursor: first.nextCursor! }), owner)
    assert.deepEqual(ids(second), ['d', 'e'])
    assert.equal(second.items[1].title, 'Updated E')
    assert.equal(second.items[1].status, 'failed')
    assert.ok(second.items[1].lastActivityAt > oldTime)
    const last = history.list(new URLSearchParams({ cursor: second.nextCursor! }), owner)
    assert.deepEqual(ids(last), ['f'])
    assert.equal(last.nextCursor, null)
    assert.deepEqual(ids(history.list(new URLSearchParams({ cursor: secondSnapshot.nextCursor! }), owner)), ['d', 'e', 'f'])
    assert.ok(ids(history.list(params('limit=200'), owner)).includes('new'))
  } finally { store.flush() }
})

test('live ACL revocation skips pending rows and refills pages without leaking private or legacy tasks', () => {
  const { store, history } = fixture([
    task('a', { projectId: 'p' }), task('b', { projectId: 'p', ownerUserId: undefined }),
    task('c', { projectId: 'q' }), task('d', { projectId: 'q' }),
    task('private', { ownerUserId: 'other' }), task('ownerless-private', { projectId: 'hidden', ownerUserId: undefined }),
  ])
  store.upsertProject({ id: 'hidden', name: 'Hidden', owner: 'other', dshRef: { kind: 'direct', apiBaseUrl: 'http://hidden' }, workspace: '/hidden' })
  try {
    const first = history.list(params('limit=1'), member)
    assert.deepEqual(ids(first), ['a'])
    store.upsertProject({ id: 'p', projectMembers: [] })
    const next = history.list(new URLSearchParams({ cursor: first.nextCursor! }), member)
    assert.deepEqual(ids(next), ['c'])
    assert.deepEqual(ids(history.list(params('limit=200'), member)), ['c', 'd'])
    denied(() => history.list(params('projectId=p'), member), 404, 'NOT_FOUND')
    denied(() => history.list(params('projectId=hidden'), owner), 404, 'NOT_FOUND')
  } finally { store.flush() }
})

test('direct binding and each actual participation signal count; candidate/default membership does not', () => {
  const examples = [
    task('direct', { status: 'draft' }),
    task('session', { chatAgentId: undefined, sessions: { a: { remoteSessionId: 'remote', baseUrl: 'http://a', createdAt: 1 } } }),
    task('turn', { chatAgentId: undefined, turns: [{ id: 'turn', seq: 1, role: 'agent', agentId: 'a', text: 'done', at: oldTime }] }),
    task('plan', { chatAgentId: undefined, mode: 'orchestrate', plan: { strategy: 'parallel', createdAt: 1,
      subtasks: [{ id: 'sub', title: 'sub', prompt: 'work', agentId: 'a', dependsOn: [], status: 'completed', logs: [] }] } }),
    task('route', { chatAgentId: undefined, lastRoute: { kind: 'direct', agentId: 'a' } }),
    task('candidate', { chatAgentId: undefined, memberAgentIds: ['a', 'candidate'] }),
  ]
  const { store, history } = fixture(examples)
  try {
    assert.equal(taskParticipation(examples[0], 'a'), 'direct')
    for (const example of examples.slice(1, 5)) assert.equal(taskParticipation(example, 'a'), 'participant')
    assert.equal(taskParticipation(examples[5], 'a'), undefined)
    assert.equal(taskParticipation(examples[5], 'candidate'), undefined)
    assert.deepEqual(ids(history.list(params('agentId=a&participation=direct'), owner)), ['direct'])
    assert.deepEqual(ids(history.list(params('agentId=a&participation=participant'), owner)), ['plan', 'route', 'session', 'turn'])
    assert.deepEqual(ids(history.list(params('agentId=candidate'), owner)), [])
    assert.equal(history.list(params('agentId=a&participation=direct'), owner).items[0].canContinueDirect, true)
    assert.ok(history.list(params('agentId=a&participation=participant'), owner).items.every(row => !row.canContinueDirect))
  } finally { store.flush() }
})

test('cross-project and multi-BOT filtering follows actual evidence, independent of current associations', () => {
  const { store, history } = fixture([
    task('p-a', { projectId: 'p' }), task('q-a', { projectId: 'q' }),
    task('p-b', { projectId: 'p', chatAgentId: 'b', memberAgentIds: ['b'] }),
    task('multi', { projectId: 'q', chatAgentId: undefined, mode: 'orchestrate', memberAgentIds: ['a', 'b'],
      lastRoute: { kind: 'direct', agentId: 'a' }, turns: [{ id: 'b-turn', seq: 1, role: 'agent', agentId: 'b', text: 'B result', at: oldTime }] }),
  ])
  try {
    assert.deepEqual(ids(history.list(params('agentId=a'), owner)), ['multi', 'p-a', 'q-a'])
    assert.deepEqual(ids(history.list(params('agentId=b'), owner)), ['multi', 'p-b'])
    assert.deepEqual(ids(history.list(params('agentId=a&projectId=p'), owner)), ['p-a'])
    assert.deepEqual(ids(history.list(params('projectId=q'), owner)), ['multi', 'q-a'])
    const collaboration = history.list(params('agentId=b&participation=participant'), owner).items[0]
    assert.equal(collaboration.participation, 'participant')
    assert.equal(collaboration.continuationReason, 'unbound_task')
    assert.equal(history.list(params('agentId=a&projectId=p'), member).items[0].continuationReason, 'agent_forbidden')
  } finally { store.flush() }
})

test('archived tasks/projects and deleted or disabled BOTs remain visible with continuation reasons', () => {
  const { store, history } = fixture([
    task('archived-task', { archivedAt: 123 }), task('archived-project', { projectId: 'p' }),
    task('deleted-agent', { chatAgentId: 'gone', memberAgentIds: ['gone'] }),
    task('disabled-agent', { chatAgentId: 'b', memberAgentIds: ['b'] }),
  ])
  try {
    store.upsertProject({ id: 'p', archivedAt: 456 })
    store.upsertAgent({ id: 'b', enabled: false })
    assert.deepEqual(ids(history.list(params('archived=archived'), owner)), ['archived-task'])
    assert.deepEqual(ids(history.list(params('archived=active'), owner)), ['archived-project', 'deleted-agent', 'disabled-agent'])
    const archived = history.list(params('projectId=p&agentId=a'), owner).items[0]
    assert.equal(archived.project?.status, 'archived')
    assert.equal(archived.continuationReason, 'project_archived')
    const deleted = history.list(params('agentId=gone'), owner).items[0]
    assert.equal(deleted.agentStatus, 'deleted')
    assert.equal(deleted.continuationReason, 'agent_deleted')
    const disabled = history.list(params('agentId=b'), owner).items[0]
    assert.equal(disabled.agentStatus, 'disabled')
    assert.equal(disabled.continuationReason, 'agent_disabled')
    assert.equal(history.list(params('archived=archived'), owner).items[0].canContinueDirect, true)
    denied(() => history.list(params('agentId=nonexistent'), owner), 404, 'NOT_FOUND')
  } finally { store.flush() }
})

test('projectSnapshot survives project rename, deletion and store reload without granting former members access', () => {
  const { store, path } = fixture()
  store.upsertTask(task('persisted', { projectId: 'p',
    projectSnapshot: { projectId: 'forged', name: 'Client supplied name', capturedAt: 1 } }))
  const captured = { ...store.getTask('persisted')!.projectSnapshot! }
  assert.equal(captured.name, 'Project p')
  assert.equal(captured.projectId, 'p')
  assert.ok(captured.capturedAt > 0)
  store.upsertProject({ id: 'p', name: 'Renamed project' })
  store.upsertTask({ ...store.getTask('persisted')!, title: 'Updated task' })
  assert.deepEqual(store.getTask('persisted')!.projectSnapshot, captured)
  store.deleteProject('p')
  store.flush()
  const reloaded = new WorkStore(path)
  try {
    const history = new TaskHistory(reloaded)
    const row = history.list(params('projectId=p&agentId=a'), owner).items[0]
    assert.deepEqual(row.projectSnapshot, captured)
    assert.deepEqual(row.project, { projectId: 'p', name: 'Project p', status: 'deleted' })
    assert.equal(row.continuationReason, 'project_deleted')
    assert.equal(row.canContinueDirect, false)
    assert.deepEqual(ids(history.list(params(), member)), [])
    denied(() => history.list(params('projectId=p'), member), 404, 'NOT_FOUND')
    assert.deepEqual(ids(history.list(params('projectId=p'), admin)), ['persisted'])
  } finally { reloaded.flush() }
})

test('history requires user identity even for service/admin sessions and returns an explicit empty ledger', () => {
  const { store, history } = fixture()
  try {
    for (const session of [undefined, {}, { role: 'admin' as const }, { userId: '' }]) {
      denied(() => history.list(params(), session), 403, 'PERMISSION_DENIED')
    }
    const empty = history.list(params(), owner)
    assert.deepEqual(empty.items, [])
    assert.equal(empty.nextCursor, null)
    assert.equal(empty.hasMore, false)
    assert.equal(empty.source, 'task_ledger')
    assert.deepEqual(history.list(params('agentId=a'), owner).items, [])
  } finally { store.flush() }
})

test('cursors bind user, role and query; reject tampering, restart and exact expiration boundary', () => {
  const { store } = fixture([task('a'), task('b'), task('c')])
  let now = 1000
  const history = new TaskHistory(store, () => now)
  try {
    const first = history.list(params('agentId=a&limit=1'), owner)
    const cursor = first.nextCursor!
    denied(() => history.list(new URLSearchParams({ cursor }), member), 410, 'CURSOR_EXPIRED')
    denied(() => history.list(new URLSearchParams({ cursor }), { ...owner, role: 'admin' }), 410, 'CURSOR_EXPIRED')
    for (const query of ['limit=2', 'agentId=b', 'projectId=p', 'status=failed', 'archived=active', 'participation=direct', 'extra=1']) {
      denied(() => history.list(params(`cursor=${cursor}&${query}`), owner), 400, 'INVALID_CURSOR')
    }
    const parts = cursor.split('.')
    for (const forged of ['garbage', `${cursor}.extra`, `${parts[0]}.2.${parts[2]}`, `${parts[0]}.x.${parts[2]}`, `${parts[0]}.${parts[1]}.invalid`]) {
      denied(() => history.list(new URLSearchParams({ cursor: forged }), owner), 400, 'INVALID_CURSOR')
    }
    denied(() => new TaskHistory(store).list(new URLSearchParams({ cursor }), owner), 400, 'INVALID_CURSOR')
    now = first.expiresAt - 1
    assert.deepEqual(ids(history.list(new URLSearchParams({ cursor, agentId: 'a', limit: '1' }), owner)), ['b'])
    now++
    denied(() => history.list(new URLSearchParams({ cursor }), owner), 410, 'CURSOR_EXPIRED')
    assert.deepEqual(ids(history.list(params('limit=1'), owner)), ['a'])
  } finally { store.flush() }
})

test('query validates limits and filters; activity ordering and bounded summaries are independent of tokens', () => {
  const { store, history } = fixture([
    task('created', { createdAt: oldTime + 30 }), task('updated', { updatedAt: oldTime + 20, status: 'failed' }),
    task('turn', { turns: [{ id: 't', seq: 1, role: 'agent', text: 'x'.repeat(801), at: oldTime + 1, endedAt: oldTime + 40 }] }),
  ])
  try {
    assert.deepEqual(ids(history.list(params(), owner)), ['turn', 'created', 'updated'])
    const row = history.list(params(), owner).items[0]
    assert.equal(row.summary, 'x'.repeat(800))
    assert.equal(row.summaryTruncated, true)
    assert.equal(row.lastActivityAt, oldTime + 40)
    assert.deepEqual(ids(history.list(params('status=failed'), owner)), ['updated'])
    assert.equal(history.list(params('status=failed,completed'), owner).items.length, 3)
    for (const query of ['limit=0', 'limit=201', 'limit=-1', 'limit=1.5', 'limit=abc', 'participation=direct', 'participation=unknown', 'archived=unknown', 'status=unknown']) {
      denied(() => history.list(params(query), owner), 400, 'INVALID_PARAM')
    }
  } finally { store.flush() }
})

test('snapshot quotas isolate principals and single-page reads do not consume capacity', () => {
  const { store, history } = fixture([task('a'), task('b')])
  try {
    for (let i = 0; i < 110; i++) history.list(params('limit=200'), owner)
    for (let i = 0; i < 10; i++) history.list(params('limit=1'), owner)
    denied(() => history.list(params('limit=1'), owner), 429, 'HISTORY_QUERY_LIMIT')
    assert.equal(history.list(params('limit=1'), admin).items.length, 1)
  } finally { store.flush() }
})

test('status and archive selection is frozen while subsequent pages return current values', () => {
  const { store, history } = fixture([task('a'), task('b')])
  try {
    const first = history.list(params('agentId=a&status=completed&archived=active&limit=1'), owner)
    store.mutateTask('b', t => { t.status = 'failed'; t.archivedAt = 123 })
    const next = history.list(new URLSearchParams({ cursor: first.nextCursor! }), owner)
    assert.equal(next.items[0].taskId, 'b')
    assert.equal(next.items[0].status, 'failed')
    assert.equal(next.items[0].archivedAt, 123)
    assert.deepEqual(ids(history.list(params('status=completed&archived=active'), owner)), ['a'])
  } finally { store.flush() }
})

test('REST history route returns the shared ledger contract, no-store, cursors and structured errors', async () => {
  const { store } = fixture([task('a'), task('b')])
  const router = new WorkBuddyRouter(store, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any)
  const server = createServer((req, res) => {
    const userId = String(req.headers['x-test-user'] || '')
    void router.dispatch(req, res, '/onenat-workbuddy', userId ? {
      session: { userId, role: 'user', username: userId } as any,
    } : {}).then(handled => { if (!handled) { res.statusCode = 404; res.end() } })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const request = async (query: string, user = 'owner') => {
    const response = await fetch(`http://127.0.0.1:${address.port}/onenat-workbuddy/api/tasks/history?${query}`, { headers: { 'x-test-user': user } })
    return { status: response.status, cache: response.headers.get('cache-control'), body: await response.json() as any }
  }
  try {
    const first = await request('agentId=a&limit=1')
    assert.equal(first.status, 200)
    assert.equal(first.cache, 'no-store')
    assert.equal(first.body.ok, true)
    assert.equal(first.body.data.source, 'task_ledger')
    assert.equal(first.body.data.items[0].taskId, 'a')
    const query = new URLSearchParams({ cursor: first.body.data.nextCursor }).toString()
    const next = await request(query)
    assert.equal(next.body.data.items[0].taskId, 'b')
    assert.equal(next.body.data.nextCursor, null)
    const foreign = await request(query, 'member')
    assert.equal(foreign.status, 410)
    assert.equal(foreign.body.code, 'CURSOR_EXPIRED')
    const invalid = await request('limit=0')
    assert.equal(invalid.status, 400)
    assert.equal(invalid.body.code, 'INVALID_PARAM')
    const anonymous = await request('', '')
    assert.equal(anonymous.status, 403)
    assert.equal(anonymous.body.code, 'PERMISSION_DENIED')
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    store.flush()
  }
})
