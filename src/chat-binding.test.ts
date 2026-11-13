/**
 * task-93 deterministic regression for explicit chat-agent binding.
 *
 * The DSH client and resolver below are local stubs. These tests verify WorkBuddy's
 * routing, persistence and request construction; they do not establish behavior of
 * a real DSH server. Run after adding this file to the unit-test command.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.WORKBUDDY_ARCHIVE_BOOT_DELAY_MS = '3600000'

import { TaskEngine } from './engine.js'
import { WorkStore } from './store.js'
import type { AgentResolver } from './resolver.js'
import type { PromptComposer } from './prompt-composer.js'
import type { Orchestrator } from './orchestrator.js'
import { DshClient, type DshTarget, type PromptResult } from './remote-client.js'
import { createServer } from 'node:http'
import type { ExpertRegistry } from './expert-registry.js'
import type { SubAgent } from './types.js'
import type { OnenatDirectory } from './onenat.js'

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

class ChatResolver {
  offline = false
  resolveCalls: string[] = []
  resolveRefCalls: string[] = []
  async resolve(agent: SubAgent) {
    this.resolveCalls.push(agent.id)
    return this.offline
      ? { baseUrl: '', agentId: agent.id, resolvedAt: Date.now(), online: false, error: 'stub offline' } as any
      : { baseUrl: 'http://chat-agent', agentId: agent.id, resolvedAt: Date.now(), online: true } as any
  }
  async resolveRef(_ref: any, _key?: string, id = 'node') {
    this.resolveRefCalls.push(id)
    return { baseUrl: 'http://fallback-node', agentId: id, resolvedAt: Date.now(), online: true } as any
  }
  async resolveMembers(ids: string[]) {
    const targets = new Map(ids.map((id) => [id, { baseUrl: 'http://chat-agent', agentId: id, resolvedAt: Date.now(), online: true } as any]))
    return { targets, issues: [] }
  }
}

class ChatComposer {
  async compose(_agent: SubAgent, _ctx: any) {
    return { block: (_agent.skills || []).map(name => `/${name}`).join(' '), resources: [], warnings: [] }
  }
}

class ChatPlanner {
  pickTargetCalls = 0
  planCalls = 0
  async pickTarget() { this.pickTargetCalls++; return { error: 'should not select planner target' } as const }
  pickMainAgent() { return undefined }
  async planTask() { this.planCalls++; throw new Error('bound chat must not plan') }
  async summarize() { throw new Error('bound chat must not summarize') }
}

class ChatRegistry {
  async search() { return [] }
  async get() { return undefined }
  async getProfile() { throw new Error('unused') }
}

class ChatClient {
  created = 0
  sessionCreates: Array<{ target: DshTarget; title: string; options: any }> = []
  prompts: string[] = []
  promptStarted?: () => void
  promptGate?: Promise<void>
  createFailure?: string
  actualCwd?: string
  actualModelMismatch = false
  actualPresetMismatch = false
  modelCatalog: Array<{ provider: string; id: string }> = [{ provider: 'openai', id: 'gpt-test' }]
  presetCatalog: Array<{ id: string; name?: string }> = [{ id: 'preset-test', name: 'Preset Test' }]
  modelCatalogOk = true
  presetCatalogOk = true
  detailReads = 0

  async createSession(target: DshTarget, title: string, options?: any) {
    this.sessionCreates.push({ target: { ...target }, title, options: { ...options } })
    this.created++
    if (this.createFailure) return { ok: false, error: this.createFailure }
    return { ok: true, sessionId: `chat-session-${this.created}` }
  }
  async setSessionPermission() { return { ok: false, supported: false, error: 'stub permission unsupported' } }
  async updateSessionModel() { return { ok: true } }
  async getSession() { return { ok: true, status: 'idle' } }
  async ping() { return { ok: true, name: 'local-dsh-stub', version: 'test' } }
  async getSessionInfo(_target: DshTarget, _sid: string) {
    return { ok: true, cwd: this.actualCwd ?? this.sessionCreates.at(-1)?.options?.cwd }
  }
  async getSessionDetail() {
    this.detailReads++
    const options = this.sessionCreates.at(-1)?.options || {}
    const [provider, model] = String(options.model || '').split('/')
    return {
      ok: true,
      session: {
        ...(options.model ? { model: this.actualModelMismatch ? { provider: 'other', model: 'other-model' } : { provider: options.provider || provider || 'openai', model: options.model || model } } : {}),
        ...(options.agentPreset ? { agentPreset: this.actualPresetMismatch ? 'other-preset' : options.agentPreset } : {}),
      },
    }
  }
  async getModels() { return { ok: this.modelCatalogOk, models: this.modelCatalog } }
  async getPresets() { return { ok: this.presetCatalogOk, presets: this.presetCatalog } }
  async listPendingQuestions() { return { ok: true, supported: true, count: 0, batches: [] } }
  async streamPrompt(_target: DshTarget, _sid: string, prompt: string, handlers: any): Promise<PromptResult> {
    this.prompts.push(prompt)
    this.promptStarted?.()
    if (this.promptGate) await this.promptGate
    handlers?.onLog?.('local stub stream start')
    handlers?.onDelta?.('stub-answer')
    handlers?.onLog?.('stub turn_end')
    return { ok: true, content: 'stub-answer', complete: true, via: 'sse' }
  }
  async prompt(): Promise<PromptResult> { return { ok: true, content: 'stub-answer', via: 'sync' } }
  async reconcileTurn(): Promise<PromptResult> { return { ok: false, error: 'unused' } }
  async waitForSessionResult(): Promise<PromptResult> { return { ok: false, error: 'unused' } }
  async cancelSession() { return { ok: true } }
  async steerSession() { return { ok: true } }
  async listWorkspaces() { return { ok: false, workspaces: [] } }
  async ensureWorkspace() { return { ok: false } }
  async fsMkdir() { return { ok: true } }
  async uploadFiles() { return { ok: true, files: [] } }
  async chat() { return { ok: true, content: 'unused' } }
  async chatWithTools() { return { ok: true, message: { role: 'assistant', content: 'unused' } } }
}

const DIRECTORY = {
  resolveMapping: () => undefined,
  resolveApp: () => undefined,
  engineInfoOf: () => undefined,
  listEndpoints: () => [],
} as unknown as OnenatDirectory

interface Fixture {
  dir: string
  store: WorkStore
  engine: TaskEngine
  client: ChatClient
  resolver: ChatResolver
  planner: ChatPlanner
}

function makeEngine(store: WorkStore, client = new ChatClient(), resolver = new ChatResolver(), planner = new ChatPlanner()) {
  const engine = new TaskEngine(
    store,
    DIRECTORY,
    resolver as unknown as AgentResolver,
    new ChatComposer() as unknown as PromptComposer,
    planner as unknown as Orchestrator,
    undefined,
    new ChatRegistry() as unknown as ExpertRegistry,
    client as unknown as DshClient,
  )
  return { engine, client, resolver, planner }
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'wb-chat-binding-'))
  const store = new WorkStore(join(dir, 'store.json'))
  const bits = makeEngine(store)
  return { dir, store, ...bits }
}

function seedAgent(store: WorkStore, id: string, extra: Partial<SubAgent> = {}): SubAgent {
  const created = store.upsertAgent({
    name: extra.name || id,
    dshRef: extra.dshRef || { kind: 'direct', apiBaseUrl: 'http://chat-agent' },
    enabled: extra.enabled ?? true,
    ...extra,
  })
  store.mutateAgent(created.id, (agent) => { agent.id = id })
  return store.getAgent(id)!
}

async function settle(f: Pick<Fixture, 'engine' | 'store'>, taskId: string, timeoutMs = 5_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    await pause(15)
    const task = f.store.getTask(taskId)
    assert.ok(task, 'task remains in store')
    if (!f.engine.isRunning(taskId) && !task.queue?.length && Date.now() - started > 80) return task
  }
  throw new Error(`task did not settle: ${taskId}`)
}

async function sendAndSettle(f: Fixture, taskId: string, text: string) {
  const result = await f.engine.sendUserMessage(taskId, text)
  assert.equal(result.ok, true)
  return settle(f, taskId)
}

function cleanup(f: Fixture) {
  f.store.flush()
  rmSync(f.dir, { recursive: true, force: true })
}

test('task-93 real HTTP client preserves explicit session identity and directory payload', async () => {
  const requests: any[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    requests.push({ url: req.url, method: req.method, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') })
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true, data: { sessionId: 'http-session' } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address() as { port: number }
    const client = new DshClient()
    const result = await client.createSession({ baseUrl: `http://127.0.0.1:${address.port}/api/v1` }, 'bound', { provider: 'provider', model: 'model', agentPreset: 'preset', cwd: '/explicit/work' })
    assert.equal(result.sessionId, 'http-session')
    assert.deepEqual(requests, [{ method: 'POST', url: '/api/v1/sessions', body: { title: 'bound', provider: 'provider', model: 'model', agentPreset: 'preset', cwd: '/explicit/work' } }])
  } finally { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())) }
})

test('task-93 create requires explicit chat mode and freezes the sole member', async () => {
  const f = makeFixture()
  try {
    seedAgent(f.store, 'chat-a')
    seedAgent(f.store, 'chat-b')
    await assert.rejects(f.engine.createTask({ chatAgentId: 'chat-a' }), /mode:chat/)
    await assert.rejects(f.engine.createTask({ chatAgentId: 'chat-a', mode: 'orchestrate' }), /mode:chat/)
    await assert.rejects(f.engine.createTask({ chatAgentId: 'chat-a', mode: 'chat', memberAgentIds: [] }), /只能包含/)
    await assert.rejects(f.engine.createTask({ chatAgentId: 'chat-a', mode: 'chat', memberAgentIds: ['chat-b'] }), /只能包含/)
    await assert.rejects(f.engine.createTask({ chatAgentId: 'missing', mode: 'chat' }), /不存在或已停用/)
    assert.equal(f.store.getTasks().length, 0, 'rejected creates have no task side effects')
    const omitted = await f.engine.createTask({ chatAgentId: 'chat-a', mode: 'chat' })
    assert.equal(omitted.chatAgentId, 'chat-a')
    assert.equal(omitted.mode, 'chat')
    assert.deepEqual(omitted.memberAgentIds, ['chat-a'])
    const explicit = await f.engine.createTask({ chatAgentId: 'chat-a', mode: 'chat', memberAgentIds: ['chat-a'] })
    assert.deepEqual(explicit.memberAgentIds, ['chat-a'])
  } finally { cleanup(f) }
})

test('task-93 send binding conflicts are rejected before turns, queue, logs or remote calls', async () => {
  const f = makeFixture()
  try {
    seedAgent(f.store, 'chat-a')
    seedAgent(f.store, 'chat-b')
    const task = await f.engine.createTask({ chatAgentId: 'chat-a', mode: 'chat' })
    const before = structuredClone(f.store.getTask(task.id))
    await assert.rejects(f.engine.sendUserMessage(task.id, 'should not run', { chatAgentId: 'chat-b' }), /不能添加或更换/)
    await assert.rejects(f.engine.sendUserMessage(task.id, 'should not run', { mode: 'orchestrate' }), /不能通过发送消息切换模式/)
    await assert.rejects(f.engine.sendUserMessage(task.id, 'should not run', { memberAgentIds: ['chat-b'] }), /只能包含/)
    await assert.rejects(f.engine.sendUserMessage(task.id, '@chat-b please', {}), /冲突/)
    assert.deepEqual(f.store.getTask(task.id), before)
    assert.equal(f.client.created, 0)
    assert.deepEqual(f.client.prompts, [])
  } finally { cleanup(f) }
})

test('task-93 store rejects mutation/upsert that changes binding without corrupting the task', async () => {
  const f = makeFixture()
  try {
    seedAgent(f.store, 'chat-a')
    seedAgent(f.store, 'chat-b')
    const task = await f.engine.createTask({ chatAgentId: 'chat-a', mode: 'chat' })
    assert.throws(() => f.store.mutateTask(task.id, (t) => { t.chatAgentId = 'chat-b' }), /不能添加、更换或清除/)
    assert.equal(f.store.getTask(task.id)?.chatAgentId, 'chat-a')
    assert.throws(() => f.store.mutateTask(task.id, (t) => { t.mode = 'orchestrate' }), /模式\/成员\/团队冲突/)
    assert.equal(f.store.getTask(task.id)?.mode, 'chat')
    assert.throws(() => f.store.mutateTask(task.id, (t) => { t.memberAgentIds = ['chat-b'] }), /模式\/成员\/团队冲突/)
    assert.deepEqual(f.store.getTask(task.id)?.memberAgentIds, ['chat-a'])
    const replacement = structuredClone(f.store.getTask(task.id)!)
    replacement.chatAgentId = 'chat-b'
    assert.throws(() => f.store.upsertTask(replacement), /不能添加、更换或清除/)
    assert.equal(f.store.getTask(task.id)?.chatAgentId, 'chat-a')
  } finally { cleanup(f) }
})

test('task-93 every bound turn directly runs the bound BOT, never planner or orchestrator', async () => {
  const f = makeFixture()
  try {
    seedAgent(f.store, 'chat-a', {
      name: '专属助理', role: '专属角色', systemPrompt: '专属人格约束。', executionPrompt: '按清单交付。',
      skills: ['chat-skill'], agentPreset: 'preset-test', provider: 'openai', model: 'gpt-test', workDir: '/tmp/chat-agent-work',
    })
    const task = await f.engine.createTask({ chatAgentId: 'chat-a', mode: 'chat' })
    await sendAndSettle(f, task.id, 'first bound message')
    await sendAndSettle(f, task.id, 'second bound message')
    const final = f.store.getTask(task.id)!
    assert.equal(final.lastRoute?.kind, 'chat')
    assert.equal(final.lastRoute?.agentId, 'chat-a')
    assert.equal(final.plan, undefined)
    assert.deepEqual(final.memberAgentIds, ['chat-a'])
    assert.ok(final.turns.filter((t) => t.role === 'agent').every((t) => t.agentId === 'chat-a'))
    assert.equal(f.planner.planCalls, 0)
    assert.equal(f.planner.pickTargetCalls, 0)
    assert.equal(f.client.prompts.length, 2)
    const first = f.client.sessionCreates[0]
    assert.equal(first.target.baseUrl, 'http://chat-agent')
    assert.equal(first.options.agentPreset, 'preset-test')
    assert.equal(first.options.provider, 'openai')
    assert.equal(first.options.model, 'gpt-test')
    assert.equal(first.options.cwd, '/tmp/chat-agent-work')
    assert.match(f.client.prompts[0], /专属角色/)
    assert.match(f.client.prompts[0], /专属人格约束/)
    assert.match(f.client.prompts[0], /按清单交付/)
    assert.match(f.client.prompts[0], /\/chat-skill/)
  } finally { cleanup(f) }
})

test('task-93 queue preserves the hard binding for FIFO follow-up turns', async () => {
  const f = makeFixture()
  try {
    seedAgent(f.store, 'chat-a')
    const task = await f.engine.createTask({ chatAgentId: 'chat-a', mode: 'chat' })
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const firstStarted = new Promise<void>((resolve) => { started = resolve })
    f.client.promptGate = gate
    f.client.promptStarted = started
    const first = await f.engine.sendUserMessage(task.id, 'first')
    assert.equal(first.ok, true)
    await firstStarted
    const queued = await f.engine.sendUserMessage(task.id, 'queued second')
    assert.equal(queued.queued, true)
    assert.deepEqual(f.store.getTask(task.id)?.queue?.map((q) => q.text), ['queued second'])
    release()
    f.client.promptGate = undefined
    f.client.promptStarted = undefined
    const final = await settle(f, task.id, 6_000)
    assert.equal(final.chatAgentId, 'chat-a')
    assert.deepEqual(final.memberAgentIds, ['chat-a'])
    assert.equal(final.queue?.length || 0, 0)
    assert.deepEqual(final.turns.filter((t) => t.role === 'user').map((t) => t.text), ['first', 'queued second'])
    assert.ok(final.turns.filter((t) => t.role === 'agent').every((t) => t.agentId === 'chat-a'))
    assert.equal(f.planner.planCalls, 0)
    assert.equal(f.client.prompts.length, 2)
  } finally { cleanup(f) }
})

test('task-93 bound chat identity and session config survive store reload and continue on the same BOT', async () => {
  const f = makeFixture()
  try {
    seedAgent(f.store, 'chat-a', { agentPreset: 'preset-test' })
    const task = await f.engine.createTask({ chatAgentId: 'chat-a', mode: 'chat', agentPreset: 'preset-test' })
    await sendAndSettle(f, task.id, 'before restart')
    f.store.flush()
    const reloaded = new WorkStore(join(f.dir, 'store.json'))
    const restored = reloaded.getTask(task.id)!
    assert.equal(restored.chatAgentId, 'chat-a')
    assert.deepEqual(restored.memberAgentIds, ['chat-a'])
    assert.equal(restored.sessions['chat-a'].remoteSessionId, 'chat-session-1')
    const bits = makeEngine(reloaded)
    const f2: Fixture = { dir: f.dir, store: reloaded, ...bits }
    await sendAndSettle(f2, task.id, 'after restart')
    const after = reloaded.getTask(task.id)!
    assert.equal(after.chatAgentId, 'chat-a')
    assert.equal(after.lastRoute?.agentId, 'chat-a')
    assert.equal(after.sessions['chat-a'].remoteSessionId, 'chat-session-1')
    assert.equal(bits.client.created, 0, 'reloaded bound session is reused, not rebound or recreated')
    assert.deepEqual(bits.resolver.resolveRefCalls, [])
    assert.equal(bits.planner.planCalls, 0)
  } finally { cleanup(f) }
})

test('task-93 offline, deleted and disabled BOT failures never fall back to a node', async (t) => {
  for (const failure of ['offline', 'deleted', 'disabled'] as const) {
    await t.test(failure, async () => {
      const f = makeFixture()
      try {
        seedAgent(f.store, 'chat-a')
        const task = await f.engine.createTask({ chatAgentId: 'chat-a', mode: 'chat', nodeRef: { kind: 'direct', apiBaseUrl: 'http://configured-node' } })
        if (failure === 'offline') f.resolver.offline = true
        if (failure === 'deleted') f.store.deleteAgent('chat-a')
        if (failure === 'disabled') f.store.mutateAgent('chat-a', (a) => { a.enabled = false })
        await sendAndSettle(f, task.id, 'must fail explicitly')
        const final = f.store.getTask(task.id)!
        assert.equal(final.status, 'failed')
        assert.match(final.turns.filter((turn) => turn.role === 'system').map((turn) => turn.text).join('\n'), /直聊硬绑定执行失败/)
        assert.equal(f.client.created, 0)
        assert.deepEqual(f.client.prompts, [])
        assert.deepEqual(f.resolver.resolveRefCalls, [], 'no task-node fallback')
        assert.equal(f.planner.pickTargetCalls, 0)
      } finally { cleanup(f) }
    })
  }
})

test('task-93 explicit model and preset are read-only validated before session creation', async (t) => {
  for (const invalid of ['model', 'preset'] as const) {
    await t.test(invalid, async () => {
      const f = makeFixture()
      try {
        seedAgent(f.store, 'chat-a')
        if (invalid === 'model') f.client.modelCatalog = [{ provider: 'openai', id: 'another-model' }]
        if (invalid === 'preset') f.client.presetCatalog = [{ id: 'another-preset' }]
        const task = await f.engine.createTask({
          chatAgentId: 'chat-a', mode: 'chat',
          ...(invalid === 'model' ? { model: 'openai/not-installed' } : { agentPreset: 'missing-preset' }),
        })
        await sendAndSettle(f, task.id, 'must not use default config')
        assert.equal(f.store.getTask(task.id)?.status, 'failed')
        assert.equal(f.client.created, 0, 'invalid explicit config is rejected before createSession')
        assert.equal(f.client.prompts.length, 0)
        assert.deepEqual(f.client.sessionCreates, [])
      } finally { cleanup(f) }
    })
  }
})

test('task-93 strict cwd and remote effective identity checks refuse silent fallback before prompt', async (t) => {
  for (const invalid of ['cwd', 'model', 'preset', 'create-failure'] as const) {
    await t.test(invalid, async () => {
      const f = makeFixture()
      try {
        seedAgent(f.store, 'chat-a', { workDir: '/tmp/chat-bound-dir', provider: 'openai', model: 'gpt-test', agentPreset: 'preset-test' })
        if (invalid === 'cwd') f.client.actualCwd = '/tmp/unexpected-dir'
        if (invalid === 'model') f.client.actualModelMismatch = true
        if (invalid === 'preset') f.client.actualPresetMismatch = true
        if (invalid === 'create-failure') f.client.createFailure = 'ENOENT: ensure project directory failed'
        const task = await f.engine.createTask({ chatAgentId: 'chat-a', mode: 'chat' })
        await sendAndSettle(f, task.id, 'strict checks before prompt')
        const final = f.store.getTask(task.id)!
        assert.equal(final.status, 'failed')
        assert.equal(f.client.prompts.length, 0)
        if (invalid === 'create-failure') {
          assert.equal(f.client.created, 1, 'no directory retry or default-directory session')
          assert.equal(f.client.sessionCreates.length, 1)
          assert.equal(f.client.sessionCreates[0].options.cwd, '/tmp/chat-bound-dir')
        } else {
          assert.equal(f.client.created, 1)
          assert.equal(f.client.detailReads, 1)
        }
        assert.deepEqual(f.resolver.resolveRefCalls, [])
      } finally { cleanup(f) }
    })
  }
})

test('task-93 legacy ID-only chat remains unbound and explicit @ extraction remains available', async () => {
  const f = makeFixture()
  try {
    seedAgent(f.store, 'legacy-a', { name: 'Legacy Bot' })
    const task = await f.engine.createTask({ mode: 'chat', memberAgentIds: ['legacy-a'], nodeRef: { kind: 'direct', apiBaseUrl: 'http://chat-agent' } })
    assert.equal(task.chatAgentId, undefined, 'old ID-only membership must not be inferred as a hard binding')
    const mentions = await f.engine.extractMentions('@Legacy Bot hello')
    assert.deepEqual(mentions.mentionedAgentIds, ['legacy-a'])
    assert.equal(f.store.getTask(task.id)?.chatAgentId, undefined)
    await sendAndSettle(f, task.id, 'legacy ordinary follow-up')
    const done = f.store.getTask(task.id)!
    assert.equal(done.lastRoute?.kind, 'chat')
    assert.equal(done.lastRoute?.agentId, '__node__', 'legacy unbound message follows its existing task-node routing')
    assert.equal(f.planner.planCalls, 0)
  } finally { cleanup(f) }
})
