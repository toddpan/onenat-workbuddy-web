import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkStore } from './store.js'
import { WorkBuddyRouter } from './router.js'
import { MonitorService } from './monitor.js'
import { createWorkBuddyToolDefs } from './tool-ops.js'
process.env.WORKBUDDY_ARCHIVE_BOOT_DELAY_MS = '3600000'

async function fixture(run: (f: any) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-agent-validation-'))
  const store = new WorkStore(join(dir, 'store.json'))
  const agent = store.upsertAgent({ name: 'fixture', dshRef: { kind: 'mapping', mappingId: 'node' } })
  const directory = { listEndpoints: () => [], resolveMapping: () => undefined }
  const resolver = {
    resolve: async () => ({ online: false, error: 'prior offline', baseUrl: '' }),
    resolveWithPing: async () => ({ target: { online: true, baseUrl: 'http://fixture', resolvedAt: Date.now() }, ping: { ok: true } }),
  }
  const engine = { onTap: () => () => {}, isRunning: () => false, taskExec: () => ({}), validateChatBinding: () => {}, extractMentions: async () => ({ mentionedAgentIds: [], mentionedExpertIds: [] }) }
  const monitor = new MonitorService(store, directory as any, resolver as any, engine as any, undefined, { list: () => [] } as any, {} as any, dir)
  const router = new WorkBuddyRouter(store, directory as any, resolver as any, {} as any, {} as any, engine as any, {} as any, undefined, monitor)
  const tools = createWorkBuddyToolDefs({ store, directory: directory as any, resolver: resolver as any, composer: {} as any, planner: {} as any, engine: engine as any, sshStore: {} as any, monitor, consoleUrl: 'http://fixture' })
  const server = createServer((req, res) => { void router.dispatch(req, res, '/onenat-workbuddy', { session: { userId: 'test-admin', role: 'admin', username: 'test-admin' } as any }).catch(err => { res.statusCode = 500; res.end(JSON.stringify({ error: err.message })) }) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as any).port}/onenat-workbuddy`
  const post = async (path: string, body: any) => { const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() } }
  try { await run({ store, agent, monitor, resolver, post, preflight: async () => JSON.parse(await tools.find(t => t.name === 'workbuddy_task_manage')!.execute({ action: 'preflight', mode: 'chat', chatAgentId: agent.id })) }) }
  finally { monitor.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.flush(); rmSync(dir, { recursive: true, force: true }) }
}

test('D01 real HTTP rejects blank creation and explicit rename, permits omitted-name patch', async () => {
  await fixture(async ({ post, agent, store }) => {
    for (const name of ['', ' \t\n', null, 42]) {
      const before = store.getAgents().length
      assert.equal((await post('/api/agents', { name, dshRef: agent.dshRef })).status, 400)
      assert.equal(store.getAgents().length, before)
      assert.equal((await post('/api/agents', { id: agent.id, name })).status, 400)
      assert.equal(store.getAgent(agent.id).name, 'fixture')
    }
    assert.equal((await post('/api/agents', { dshRef: agent.dshRef })).status, 400)
    const patch = await post('/api/agents', { id: agent.id, description: 'partial update' })
    assert.equal(patch.status, 200); assert.equal(patch.body.data.name, 'fixture')
  })
})

test('D02 HTTP successful ping refreshes an offline monitor snapshot consumed by tool preflight', async () => {
  await fixture(async ({ post, agent, monitor, preflight }) => {
    monitor.start()
    await new Promise(resolve => setImmediate(resolve))
    await monitor.getOverview(true)
    assert.equal((await preflight()).roles[0].online, false)
    assert.equal((await post(`/api/agents/${agent.id}/ping`, {})).body.data.ping.ok, true)
    assert.equal((await preflight()).roles[0].online, true, 'successful real ping must replace stale offline observation')
  })
})

test('D02 new and rebound BOTs are unknown until observed; failed probes remain offline', async () => {
  await fixture(async ({ store, agent, monitor, resolver, post, preflight }) => {
    await monitor.getOverview(true)
    assert.equal((await preflight()).roles[0].online, null)
    await post(`/api/agents/${agent.id}/ping`, {})
    assert.equal((await preflight()).roles[0].online, true)
    store.upsertAgent({ id: agent.id, dshRef: { kind: 'mapping', mappingId: 'rebound' } })
    assert.equal((await preflight()).roles[0].online, null)
    resolver.resolveWithPing = async () => ({ ping: { ok: false, error: 'probe failed' } })
    await post(`/api/agents/${agent.id}/ping`, {})
    assert.equal((await preflight()).roles[0].online, false)
  })
})

test('D02 first background health observation refreshes cached preflight without overview polling', async () => {
  await fixture(async ({ monitor, resolver, preflight }) => {
    let finish: (value: any) => void = () => {}
    resolver.resolve = () => new Promise(resolve => { finish = resolve })
    monitor.start()
    await monitor.getOverview(true)
    finish({ online: true, baseUrl: 'http://fixture' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal((await preflight()).roles[0].online, true)
  })
})

test('D02 delayed offline sweep cannot overwrite a newer successful explicit ping', async () => {
  await fixture(async ({ monitor, resolver, preflight, post, agent }) => {
    let finish: (value: any) => void = () => {}
    resolver.resolve = () => new Promise(resolve => { finish = resolve })
    monitor.start()
    await monitor.getOverview(true)
    await post(`/api/agents/${agent.id}/ping`, {})
    finish({ online: false, error: 'older observation' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal((await preflight()).roles[0].online, true)
  })
})

test('D01 store rejects explicit blank names atomically but accepts omitted-name patch', async () => {
  await fixture(async ({ store, agent }) => {
    assert.throws(() => store.upsertAgent({ name: '  ' }), /name/)
    assert.throws(() => store.upsertAgent({ id: agent.id, name: '' }), /name/)
    assert.equal(store.upsertAgent({ id: agent.id, enabled: false }).name, 'fixture')
  })
})
