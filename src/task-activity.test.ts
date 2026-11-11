import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { WorkBuddyRouter } from './router.js'
import { WorkStore } from './store.js'
import { TaskActivity } from './task-activity.js'
import type { WorkTask } from './types.js'
const owner = { userId: 'owner', role: 'user' as const }
const member = { userId: 'member', role: 'user' as const }
const query = (s = '') => new URLSearchParams(s)
function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'activity-')), 'store.json')
  const task: WorkTask = { id: 'task', title: 'test', mode: 'chat', status: 'running', ownerUserId: 'owner',
    projectId: 'p', memberAgentIds: ['a'], chatAgentId: 'a', createdAt: 1, updatedAt: 1,
    sessions: { b: { remoteSessionId: 's', baseUrl: 'http://b', createdAt: 1 } }, turns: [],
    pendingAsk: { agentId: 'b', turnId: 'ask', sessionId: 's', questions: [{ id: 'q', question: 'choose' }], at: 1 } }
  writeFileSync(path, JSON.stringify({ tasks: [task], projects: [{ id: 'p', name: 'P', owner: 'owner',
    projectMembers: [{ userId: 'member', role: 'member' }], dshRef: { kind: 'direct', apiBaseUrl: 'http://p' }, workspace: '/p' }] }))
  const store = new WorkStore(path)
  return { store, path, activity: new TaskActivity(store, () => true) }
}

test('real pending ask overrides running; all BOT/project/task counts deduplicate and clear after answer', () => {
  const { store, activity } = fixture()
  try {
    const a = activity.list(query(), owner)
    assert.equal(a.counts.total, 1); assert.equal(a.counts.waitingReply, 1); assert.equal(a.counts.running, 0)
    assert.deepEqual(a.items[0].agentIds, ['a', 'b'])
    assert.ok(a.agents.every(a => a.counts.waitingReply === 1))
    assert.equal(activity.list(query('projectId=p'), owner).counts.waitingReply, 1)
    assert.equal(activity.list(query('agentId=b'), owner).items[0].taskId, 'task')
    assert.equal(activity.list(query('taskId=task'), owner).items[0].pendingAsk?.agentId, 'b')
    assert.equal(activity.list(query(), owner).items[0].activityVersion, a.items[0].activityVersion)
    store.mutateTask('task', t => { delete t.pendingAsk })
    const after = activity.list(query(), owner)
    assert.equal(after.counts.waitingReply, 0); assert.equal(after.counts.running, 1)
    assert.ok(after.agents.every(a => a.counts.waitingReply === 0))
  } finally { store.flush() }
})

test('read receipts are explicit, persistent, per user, monotonic, and do not swallow later changes', () => {
  const { store, path, activity } = fixture()
  try {
    const first = activity.list(query(), owner).items[0]
    assert.equal(first.unread, true)
    activity.list(query(), owner); activity.list(query('taskId=task'), owner)
    assert.equal(activity.list(query(), owner).counts.unread, 1)
    activity.read('task', { activityVersion: first.activityVersion }, owner)
    assert.equal(activity.list(query(), owner).counts.unread, 0)
    assert.equal(activity.list(query(), member).counts.unread, 1)
    store.mutateTask('task', t => { t.turns.push({ id: 'reply', seq: 1, role: 'agent', agentId: 'a', text: 'new', at: 1 }) })
    const second = activity.list(query(), owner).items[0]
    assert.ok(second.activityVersion > first.activityVersion)
    store.mutateTask('task', t => { t.turns[0].text = 'NEW' })
    const edited = activity.list(query(), owner).items[0]
    assert.ok(edited.activityVersion > second.activityVersion)
    // Restore the content before continuing receipt ordering assertions; versions never go backwards.
    store.mutateTask('task', t => { t.turns[0].text = 'new' })
    second.activityVersion = activity.list(query(), owner).items[0].activityVersion
    assert.equal(activity.read('task', { activityVersion: first.activityVersion }, owner).unread, true)
    activity.read('task', { activityVersion: second.activityVersion }, owner)
    assert.equal(activity.read('task', { activityVersion: first.activityVersion }, owner).readVersion, second.activityVersion)
    store.mutateTask('task', t => { t.title = 'metadata edit'; t.turns[0].usage = { totalTokens: 99 } })
    assert.equal(activity.list(query(), owner).counts.unread, 0)
    store.flush()
    const restored = new WorkStore(path)
    assert.equal(new TaskActivity(restored, () => true).list(query(), owner).counts.unread, 0)
    assert.equal(new TaskActivity(restored, () => true).list(query(), member).counts.unread, 1)
    restored.flush()
    assert.throws(() => activity.read('task', { activityVersion: second.activityVersion + 100 }, owner))
    assert.throws(() => activity.list(query()))
  } finally { store.flush() }
})

test('archive/deletion and revoked access disappear from counts, while authorized history stays readable', () => {
  const { store, activity } = fixture()
  try {
    assert.equal(activity.list(query(), member).counts.total, 1)
    store.upsertProject({ id: 'p', archivedAt: 10 })
    assert.equal(activity.list(query(), owner).counts.total, 0)
    assert.equal(activity.list(query('taskId=task'), owner).counts.total, 1)
    store.upsertProject({ id: 'p', archivedAt: 0, projectMembers: [] })
    assert.equal(activity.list(query(), member).counts.total, 0)
    assert.throws(() => activity.list(query('taskId=task'), member))
    assert.throws(() => activity.read('task', { activityVersion: 1 }, member))
    store.mutateTask('task', t => { t.archivedAt = 2 })
    assert.equal(activity.list(query(), owner).counts.total, 0)
    store.mutateTask('task', t => { delete t.archivedAt })
    store.deleteProject('p')
    assert.equal(activity.list(query(), owner).counts.total, 0)
    assert.equal(activity.list(query('taskId=task'), owner).counts.total, 1)
    store.deleteTask('task')
    assert.throws(() => activity.list(query('taskId=task'), owner))
    assert.equal(store.taskReadVersion('owner', 'task'), 0)
  } finally { store.flush() }
})

test('HTTP activity and read routes enforce identity, ACL, validation and no-store', async () => {
  const { store } = fixture()
  const router = new WorkBuddyRouter(store, {} as any, {} as any, {} as any, {} as any, { isRunning: () => true } as any, {} as any)
  const server = createServer((req, res) => {
    const userId = String(req.headers['x-test-user'] || '')
    void router.dispatch(req, res, '/onenat-workbuddy', userId ? { session: { userId, role: 'user', username: userId } as any } : {})
      .then(handled => { if (!handled) { res.statusCode = 404; res.end() } })
      .catch(error => { res.statusCode = 500; res.end(String(error)) })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const request = async (path: string, user = 'owner', body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${address.port}/onenat-workbuddy/api${path}`, {
      method: body ? 'POST' : 'GET', headers: { 'x-test-user': user, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: res.status, cache: res.headers.get('cache-control'), data: await res.json() as any }
  }
  try {
    const first = await request('/activity')
    assert.equal(first.status, 200); assert.equal(first.cache, 'no-store')
    const version = first.data.data.items[0].activityVersion
    const read = await request('/tasks/task/read', 'owner', { activityVersion: version, userId: 'member' })
    assert.equal(read.status, 200); assert.equal(read.data.data.unread, false)
    assert.equal((await request('/activity', 'member')).data.data.counts.unread, 1)
    assert.equal((await request('/activity', 'stranger')).data.data.counts.total, 0)
    assert.equal((await request('/activity?taskId=task', 'stranger')).status, 404)
    assert.equal((await request('/tasks/task/read', 'stranger', { activityVersion: version })).status, 404)
    assert.equal((await request('/tasks/task/read', 'owner', { activityVersion: version + 10 })).status, 400)
    assert.equal((await request('/activity', '')).status, 403)
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.flush()
  }
})

test('terminal/unknown status is independent from connectivity; equal timestamp edits advance version', () => {
  const { store } = fixture()
  try {
    const activity = new TaskActivity(store)
    store.mutateTask('task', t => { delete t.pendingAsk; t.status = 'running' })
    assert.equal(activity.list(query(), owner).items[0].state, 'unknown')
    for (const status of ['success', 'partial_success', 'completed', 'failed', 'cancelled', 'draft'] as const) {
      store.mutateTask('task', t => { t.status = status })
      assert.equal(activity.list(query(), owner).items[0].state, ['success', 'partial_success'].includes(status) ? 'completed' : status)
    }
  } finally { store.flush() }
})
