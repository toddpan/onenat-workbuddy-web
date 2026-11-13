import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { WorkBuddyRouter } from './router.js'
import { createWorkBuddyToolDefs } from './tool-ops.js'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkStore } from './store.js'
import { ProjectAgents, ProjectAgentError } from './project-agents.js'
import { canUseAgent } from './perm.js'
import type { WorkTask } from './types.js'

process.env.WORKBUDDY_ARCHIVE_BOOT_DELAY_MS = '3600000'
const owner = { session: { userId: 'owner', role: 'user' as const } }
function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'wb-rel-')), 'store.json')
  const store = new WorkStore(path)
  const a = store.upsertAgent({ name: 'A', dshRef: { kind: 'direct', apiBaseUrl: 'http://a' }, ownerUserId: 'owner', workDir: '/bot' })
  const b = store.upsertAgent({ name: 'B', dshRef: { kind: 'direct', apiBaseUrl: 'http://b' }, ownerUserId: 'owner' })
  const p = store.upsertProject({ name: 'P', dshRef: a.dshRef, workspace: '/p', owner: 'owner' })
  const q = store.upsertProject({ name: 'Q', dshRef: a.dshRef, workspace: '/q', owner: 'owner' })
  return { path, store, a, b, p, q, service: new ProjectAgents(store) }
}
function denied(fn: () => unknown, status: number) { assert.throws(fn, e => e instanceof ProjectAgentError && e.status === status) }

test('many-to-many: both orientations, idempotency, concurrent additions, persisted single source', async () => {
  const { store, service, a, b, p, q, path } = fixture()
  await Promise.all([a, b].map(bot => Promise.resolve().then(() => service.change(p.id, bot.id, true, owner))))
  service.change(q.id, a.id, true, owner)
  assert.equal(service.change(p.id, a.id, true, owner).changed, false)
  assert.equal(service.forProject(p.id, owner).linked.length, 2)
  assert.equal(service.forAgent(a.id, owner).linked.length, 2)
  await Promise.all([a, b].map(bot => Promise.resolve().then(() => service.change(p.id, bot.id, false, owner))))
  assert.equal(service.change(p.id, b.id, false, owner).changed, false)
  assert.equal(service.forProject(p.id, owner).linked.length, 0)
  assert.equal(service.forAgent(a.id, owner).linked.length, 1)
  assert.equal(store.getAgent(a.id)?.workDir, '/bot')
  store.flush()
  const reloaded = new WorkStore(path)
  assert.equal(new ProjectAgents(reloaded).forAgent(a.id, owner).linked[0].projectId, q.id)
  reloaded.flush()
})

test('ACL: hidden project, non-manager, unusable BOT, read-only and AI token fail closed; links grant no access', () => {
  const { store, service, a, p } = fixture()
  denied(() => service.forProject(p.id, { session: { userId: 'outsider' } }), 404)
  denied(() => service.forProject(p.id, { aiTokenOnly: true }), 403)
  denied(() => service.forAgent(a.id, {}), 403)
  denied(() => service.forAgent(a.id, { aiTokenOnly: true }), 403)
  store.upsertProject({ id: p.id, projectMembers: [{ userId: 'member', role: 'member', joinedAt: 1 }] })
  denied(() => service.change(p.id, a.id, true, { session: { userId: 'member' } }), 403)
  const privateBot = store.upsertAgent({ name: 'private', dshRef: a.dshRef, ownerUserId: 'other' })
  denied(() => service.change(p.id, privateBot.id, true, owner), 404)
  denied(() => service.change(p.id, a.id, true, { aiTokenOnly: true }), 403)
  denied(() => service.change(p.id, a.id, true, { ...owner, readOnly: true }), 403)
  service.change(p.id, a.id, true, owner)
  assert.equal(canUseAgent({ userId: 'member' }, a, { projects: store.getProjects() }), false)
  assert.deepEqual(service.forAgent(a.id, { session: { userId: 'owner' } }).historical, [])
  store.flush()
})

test('history distinguishes actual participation from candidates; unlink/delete/archive preserve task snapshot', () => {
  const { store, service, a, b, p } = fixture()
  service.change(p.id, a.id, true, owner)
  const task: WorkTask = { id: 'history', title: 'History', projectId: p.id, ownerUserId: 'owner', mode: 'chat', status: 'completed', memberAgentIds: [a.id, b.id], sessions: {}, turns: [{ id: 'turn', seq: 1, role: 'agent', agentId: a.id, agentName: a.name, text: 'done', at: 1 }], createdAt: 1, updatedAt: 1 }
  store.upsertTask(task)
  assert.equal(service.forProject(p.id, owner).historical.length, 0, 'B is only a candidate')
  const snapshot = JSON.stringify(store.getTask(task.id))
  service.change(p.id, a.id, false, owner)
  assert.equal(service.forProject(p.id, owner).historical[0].agentId, a.id)
  service.change(p.id, a.id, true, owner)
  store.deleteAgent(a.id)
  assert.equal(service.forProject(p.id, owner).linked[0].status, 'deleted')
  denied(() => service.change(p.id, a.id, true, owner), 404)
  service.change(p.id, a.id, false, owner)
  assert.equal(service.forAgent(a.id, owner).historical[0].projectId, p.id)
  store.upsertProject({ id: p.id, archivedAt: Date.now() })
  assert.equal(service.forAgent(a.id, owner).historical[0].status, 'archived')
  denied(() => service.change(p.id, b.id, true, owner), 409)
  assert.equal(JSON.stringify(store.getTask(task.id)), snapshot)
  store.flush()
})

test('REST and tools share both directions, permissions and idempotent changes', async () => {
  const { store, a, b, p, q } = fixture()
  const router = new WorkBuddyRouter(store, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any)
  const tools = createWorkBuddyToolDefs({ store, directory: {} as any, resolver: {} as any, composer: {} as any, planner: {} as any, engine: {} as any, sshStore: {} as any, consoleUrl: 'http://local' })
  const server = createServer((req, res) => {
    const userId = String(req.headers['x-test-user'] || 'owner')
    void router.dispatch(req, res, '/onenat-workbuddy', { session: { userId, role: 'user', username: userId } as any }).then(handled => { if (!handled) { res.statusCode = 404; res.end() } })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as import('node:net').AddressInfo).port
  const request = async (method: string, path: string, user = 'owner') => {
    const res = await fetch(`http://127.0.0.1:${port}/onenat-workbuddy/api/${path}`, { method, headers: { 'x-test-user': user } })
    return { status: res.status, body: await res.json() as any }
  }
  const call = async (name: string, args: Record<string, unknown>, extra = {}) => JSON.parse(await tools.find(t => t.name === name)!.execute(args, { channel: 'http', maxBlockMs: 0, ...owner, ...extra }))
  try {
    await Promise.all([a, b].map(bot => request('PUT', `projects/${p.id}/agents/${bot.id}`)))
    assert.equal((await request('GET', `projects/${p.id}/agents`)).body.data.linked.length, 2)
    assert.equal((await call('workbuddy_agent_manage', { action: 'link_project', agentId: a.id, projectId: q.id })).ok, true)
    assert.equal((await request('GET', `agents/${a.id}/projects`)).body.data.linked.length, 2)
    assert.equal((await call('workbuddy_project_manage', { action: 'agents', projectId: p.id })).data.linked.length, 2)
    assert.equal((await request('DELETE', `agents/${a.id}/projects/${p.id}`)).body.data.changed, true)
    assert.equal((await call('workbuddy_project_manage', { action: 'unlink_agent', projectId: p.id, agentId: a.id })).data.changed, false)
    assert.equal((await request('GET', `projects/${p.id}/agents`, 'outsider')).status, 404)
    assert.equal((await call('workbuddy_agent_manage', { action: 'projects', agentId: a.id }, { session: { userId: 'outsider' } })).code, 'NOT_FOUND')
    assert.equal((await call('workbuddy_project_manage', { action: 'link_agent', projectId: p.id, agentId: a.id }, { aiTokenOnly: true })).code, 'PERMISSION_DENIED')
    assert.equal((await call('workbuddy_agent_manage', { action: 'link_project', agentId: a.id })).field, 'projectId')
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.flush() }
})

test('legacy expertIds migrate once; canonical empty wins; history never creates associations or grants', () => {
  const { store, path, a, b, p, q } = fixture()
  store.flush()
  const projects = [{ ...p, defaultAgentIds: undefined, expertIds: [a.id, a.id], legacyAgentAccessIds: undefined }, { ...q, defaultAgentIds: [], expertIds: [b.id], legacyAgentAccessIds: undefined }]
  writeFileSync(path, JSON.stringify({ agents: [a, b], projects, tasks: [] }))
  const migrated = new WorkStore(path)
  const service = new ProjectAgents(migrated)
  assert.deepEqual(migrated.getProject(p.id)?.defaultAgentIds, [a.id])
  assert.deepEqual(migrated.getProject(p.id)?.expertIds, [a.id])
  assert.deepEqual(migrated.getProject(q.id)?.defaultAgentIds, [])
  service.change(p.id, b.id, true, owner)
  assert.deepEqual(migrated.getProject(p.id)?.legacyAgentAccessIds, [a.id])
  migrated.flush()
  const again = new WorkStore(path)
  assert.deepEqual(again.getProject(p.id)?.legacyAgentAccessIds, [a.id])
  const restarted = new ProjectAgents(again)
  restarted.change(p.id, a.id, false, owner)
  restarted.change(p.id, a.id, true, owner)
  assert.deepEqual(again.getProject(p.id)?.legacyAgentAccessIds, [], 'unlink revokes legacy grant; relink cannot recreate it')
  again.flush()
})
