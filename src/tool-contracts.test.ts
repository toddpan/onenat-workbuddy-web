import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkBuddyToolDefs } from './tool-ops.js'
import { toolDefToInputSchema } from './xiaozhi-mcp.js'
import { validateToolArgs } from './tool-contracts.js'
import { DshClient } from './remote-client.js'
import { TaskEngine } from './engine.js'
import { taskPreflight } from './task-preflight.js'
import { WorkBuddyRouter } from './router.js'
import { Readable } from 'node:stream'

const noMentions = { mentionedAgentIds: [], mentionedExpertIds: [] }
function boundTask(chatAgentId?: string): any {
  return { id: 'contract-chat', title: 'chat', mode: 'chat', chatAgentId, memberAgentIds: chatAgentId ? [chatAgentId] : [], turns: [], sessions: {}, taskLogs: [], createdAt: Date.now(), updatedAt: Date.now(), status: 'draft' }
}

// Discovery and invalid calls must not touch any business dependency.
function tools() {
  return createWorkBuddyToolDefs({ consoleUrl: 'http://localhost/wb' } as any)
}

function checkSchema(schema: any, path: string): void {
  assert.ok(schema && typeof schema === 'object', path)
  if (schema.type === 'object') {
    assert.ok(schema.properties, `${path}: object properties`)
    for (const name of schema.required || []) assert.ok(name in schema.properties, `${path}: dangling required ${name}`)
    for (const [key, value] of Object.entries(schema.properties)) checkSchema(value, `${path}.${key}`)
  }
  if (schema.type === 'array') {
    assert.ok(schema.items, `${path}: array items`)
    checkSchema(schema.items, `${path}[]`)
  }
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    for (const child of schema[key] || []) checkSchema(child, path)
  }
}

test('task-82: all seventeen model contracts have declared required properties and array items', () => {
  const defs = tools()
  assert.equal(defs.length, 18)
  for (const def of defs) {
    const schema: any = toolDefToInputSchema(def)
    checkSchema(schema, def.name)
    if ('action' in def.parameters) {
      assert.ok(schema.required.includes('action'), def.name)
      assert.ok(schema.properties.action.enum.length, def.name)
    } else {
      assert.ok(!schema.required.includes('action'), def.name)
    }
  }
  const schema = (name: string): any => defs.find(d => d.name === `workbuddy_${name}`)!.inputSchema
  for (const [name, param] of [['task_manage', 'memberAgentIds'], ['task_ask_answer', 'answers'], ['backlog_manage', 'itemIds']]) {
    assert.equal(schema(name).properties[param].type, 'array')
    assert.ok(schema(name).properties[param].items)
  }
  assert.deepEqual(schema('task_status').required, [])
})

test('task-82: native arrays and legacy JSON strings normalize to the same business arguments', () => {
  const cases = [
    ['task_manage', { action: 'create', memberAgentIds: ['a'] }, 'memberAgentIds'],
    ['task_ask_answer', { taskId: 't', answers: [{ id: 'q', selected: [], custom: 'yes' }] }, 'answers'],
    ['backlog_manage', { action: 'dispatch', projectId: 'p', itemIds: ['TASK-1'] }, 'itemIds'],
  ] as const
  for (const [name, args, key] of cases) {
    const native = validateToolArgs(`workbuddy_${name}`, args)
    const legacy = validateToolArgs(`workbuddy_${name}`, { ...args, [key]: JSON.stringify(args[key as keyof typeof args]) })
    assert.deepEqual(native.errors, [], name)
    assert.deepEqual(legacy.errors, [], name)
    assert.deepEqual(legacy.args, native.args, name)
  }
})

test('task-82: invalid fields are rejected before business dependencies run', async () => {
  const cases = [
    ['task_manage', { action: 'send', taskId: 't' }, 'message'],
    ['task_manage', { action: 'create', memberAgentIds: {} }, 'memberAgentIds'],
    ['task_manage', { action: 'create', memberAgentIds: [42] }, 'memberAgentIds'],
    ['agent_manage', { action: 'upsert', agent: { name: 'a', apiBaseUrl: 'http://local', resources: [null] } }, 'resources'],
    ['team_manage', { action: 'upsert', team: { name: 'a', goal: 'g', members: [null, null] } }, 'members'],
    ['task_ask_answer', { taskId: 't', answers: [{ selected: [] }] }, 'answers'],
    ['task_ask_answer', { taskId: 't', answers: [{ id: 'q', selected: {} }] }, 'selected'],
    ['backlog_manage', { action: 'dispatch', projectId: 'p', itemIds: {} }, 'itemIds'],
    ['project_manage', { action: 'upsert', project: { name: 'p' } }, 'project'],
    ['resource_manage', { action: 'invalid' }, 'action'],
  ] as const
  for (const [name, args, field] of cases) {
    const def = tools().find(d => d.name === `workbuddy_${name}`)!
    const result = JSON.parse(await def.execute(args))
    assert.equal(result.ok, false, name)
    assert.equal(result.code, 'INVALID_PARAM', name)
    assert.ok(result.errors.some((e: any) => e.path.includes(field)), JSON.stringify(result))
  }
})

test('task-82: native and legacy answers reach the successful answer handler unchanged', async () => {
  const answers = [{ id: 'q', selected: ['choice'], custom: 'text' }]
  const calls: unknown[] = []
  const original = DshClient.prototype.answerQuestion
  DshClient.prototype.answerQuestion = async (_target, sessionId, input) => {
    assert.equal(sessionId, 'session')
    calls.push(input)
    return { ok: true }
  }
  try {
    const defs = createWorkBuddyToolDefs({
      consoleUrl: 'http://localhost/wb',
      store: { getTask: () => ({ sessions: { __node__: { remoteSessionId: 'session' } } }), getAgent: () => undefined },
      engine: { resolveExecTarget: async () => ({ online: true, baseUrl: 'http://mock' }) },
    } as any)
    const tool = defs.find(d => d.name === 'workbuddy_task_ask_answer')!
    for (const value of [answers, JSON.stringify(answers)]) {
      const result = JSON.parse(await tool.execute({ taskId: 't', agentId: '__node__', answers: value }))
      assert.equal(result.ok, true)
      assert.equal(result.data.answered, 1)
    }
    assert.deepEqual(calls, [answers, answers])
  } finally { DshClient.prototype.answerQuestion = original }
})

test('task-82: unknown parameters are removed with visible warnings', () => {
  const checked = validateToolArgs('workbuddy_task_manage', { action: 'list', typo: 'ignored' })
  assert.deepEqual(checked.errors, [])
  assert.ok(checked.warnings.some(w => w.includes('typo')))
  assert.ok(!('typo' in checked.args))
})

test('task-93: shared schema preserves routing assertions and rejects malformed hard bindings', () => {
  const def = tools().find(d => d.name === 'workbuddy_task_manage')!
  const schema: any = toolDefToInputSchema(def)
  for (const key of ['chatAgentId', 'mode', 'memberAgentIds', 'teamId']) assert.ok(schema.properties[key], key)
  for (const input of [
    { action: 'create', chatAgentId: 'bot', mode: 'chat' },
    { action: 'create', chatAgentId: 'bot', mode: 'chat', memberAgentIds: ['bot'] },
    { action: 'send', taskId: 't', message: 'hello', chatAgentId: 'bot', mode: 'chat' },
  ]) {
    const checked = validateToolArgs(def.name, input)
    assert.deepEqual(checked.errors, [])
    assert.equal(checked.args.chatAgentId, 'bot')
    assert.deepEqual(checked.warnings, [])
  }
  for (const route of [
    { chatAgentId: 'bot' }, { chatAgentId: '' }, { chatAgentId: 1 },
    { chatAgentId: ' bot ', mode: 'chat' },
    { chatAgentId: 'bot', mode: 'orchestrate' },
    { chatAgentId: 'bot', mode: 'chat', memberAgentIds: [] },
    { chatAgentId: 'bot', mode: 'chat', memberAgentIds: ['other'] },
    { chatAgentId: 'bot', mode: 'chat', teamId: 'team' },
  ]) assert.ok(validateToolArgs(def.name, { action: 'create', ...route }).errors.length, JSON.stringify(route))
  assert.ok(validateToolArgs(def.name, { action: 'send', taskId: 't', message: 'hi', nodeRef: { kind: 'mapping', mappingId: 'node' } }).errors.length)
})

test('task-93: preflight validates existing assertions and shows hard binding without resolving credentials', async () => {
  const task = boundTask('bot')
  const engine: any = {
    validateChatBinding: TaskEngine.prototype.validateChatBinding,
    taskExec: () => ({ dshRef: { kind: 'mapping', mappingId: 'task-node' }, workspaceDshRef: { kind: 'mapping', mappingId: 'files' }, workspace: '/workspace' }),
    isRunning: () => false,
  }
  const store: any = { getAgent: () => ({ id: 'bot', name: 'Bot', apiKey: 'private-key', dshRef: { kind: 'direct', apiBaseUrl: 'https://user:password@example.test/path?token=private-token' } }) }
  const out = await taskPreflight(store, engine, { task, chatAgentId: 'bot', mode: 'chat' }, noMentions as any, { agents: [{ id: 'bot', online: false }] })
  assert.equal(out.route, 'agent-chat')
  assert.equal(out.chatAgentId, 'bot')
  assert.deepEqual(out.roster, ['bot'])
  assert.equal(out.roles[0].id, 'bot')
  assert.equal(out.executionNode?.nodeId, 'direct:https://example.test')
  assert.ok(out.warnings.some(w => w.includes('不回退')))
  assert.ok(!JSON.stringify(out).match(/private-key|password|private-token/))
  for (const assertion of [{ chatAgentId: 'other' }, { mode: 'orchestrate' as const }, { memberAgentIds: ['other'] }, { teamId: 'team' }]) {
    await assert.rejects(taskPreflight(store, engine, { task, ...assertion }, noMentions as any), { code: 'INVALID_PARAM' })
  }
  await assert.rejects(taskPreflight(store, engine, { task: boundTask(), chatAgentId: 'bot', mode: 'chat' }, noMentions as any), { code: 'INVALID_PARAM' })
  await assert.rejects(taskPreflight(store, engine, { chatAgentId: 'bot', mode: 'chat' }, { ...noMentions, mentionedProjectId: 'other-project' } as any), { code: 'INVALID_PARAM' })
  const missing = await taskPreflight({ ...store, getAgent: () => undefined }, engine, { task }, noMentions as any)
  assert.equal((missing.roles[0] as any).configured, false)
  assert.ok(missing.warnings.some(w => w.includes('缺失') && w.includes('不回退')))
})

test('task-93: tool send rejects conflicting binding before dedupe or delivery and forwards assertions', async () => {
  const task = boundTask('bot'), calls: any[] = []
  const defs = createWorkBuddyToolDefs({ consoleUrl: 'http://localhost', store: { getTask: () => task, getAgent: () => ({ id: 'bot' }) }, engine: {
    extractMentions: async () => noMentions,
    validateChatBinding: TaskEngine.prototype.validateChatBinding,
    sendUserMessage: async (...args: any[]) => { calls.push(args); return { ok: true } },
  } } as any)
  const tool = defs.find(d => d.name === 'workbuddy_task_manage')!
  const input = { action: 'send', taskId: task.id, message: 'contract unique send', chatAgentId: 'bot', mode: 'chat' }
  assert.equal(JSON.parse(await tool.execute(input)).ok, true)
  assert.equal(JSON.parse(await tool.execute({ ...input, chatAgentId: 'other' })).code, 'INVALID_PARAM')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][2].chatAgentId, 'bot')
  assert.equal(calls[0][2].mode, 'chat')
  const plain = boundTask()
  const teamCalls: any[] = []
  const plainTool = createWorkBuddyToolDefs({ consoleUrl: 'http://localhost', store: { getTask: () => plain }, engine: {
    extractMentions: async () => noMentions, validateChatBinding: TaskEngine.prototype.validateChatBinding,
    sendUserMessage: async (...args: any[]) => { teamCalls.push(args); return { ok: true } },
  } } as any).find(d => d.name === 'workbuddy_task_manage')!
  assert.equal(JSON.parse(await plainTool.execute({ action: 'send', taskId: plain.id, message: 'team routing contract', teamId: 'team-a' })).ok, true)
  assert.equal(teamCalls[0][2].teamId, 'team-a')
})

test('task-93: create dedupe keeps persistent bindings separate and forwards explicit mode', async () => {
  const tasks: any[] = [], calls: any[] = []
  const defs = createWorkBuddyToolDefs({ consoleUrl: 'http://localhost', store: {
    getTask: (id: string) => tasks.find(t => t.id === id), getTasks: () => tasks,
    getAgent: (id: string) => ({ id }), getProjects: () => [],
  }, engine: {
    extractMentions: async () => noMentions,
    validateChatBinding: TaskEngine.prototype.validateChatBinding,
    logTask: () => {}, isRunning: () => false,
    createTask: async (input: any) => {
      calls.push(input)
      const task = { ...boundTask(input.chatAgentId), id: `create-binding-${tasks.length}`, memberAgentIds: [input.chatAgentId], turns: [{ role: 'user', text: input.message }] }
      tasks.push(task); return task
    },
  } } as any)
  const tool = defs.find(d => d.name === 'workbuddy_task_manage')!
  const input = { action: 'create', title: 'binding-dedupe-contract', message: 'binding dedupe unique contract message', mode: 'chat' }
  const first = JSON.parse(await tool.execute({ ...input, chatAgentId: 'bot-a' }))
  const second = JSON.parse(await tool.execute({ ...input, chatAgentId: 'bot-b' }))
  assert.equal(first.ok, true); assert.equal(second.ok, true)
  assert.notEqual(first.taskId, second.taskId)
  assert.equal(first.chatAgentId, 'bot-a'); assert.equal(second.chatAgentId, 'bot-b')
  const repeat = JSON.parse(await tool.execute({ ...input, chatAgentId: 'bot-a' }))
  assert.equal(repeat.taskId, first.taskId)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].mode, 'chat')
})

test('task-93: REST create shares binding validation and preserves server ownership', async () => {
  const calls: any[] = [], router: any = Object.create(WorkBuddyRouter.prototype)
  router.requestContext = { getStore: () => ({}) }
  router.store = { getProject: () => undefined, getAgent: () => ({ id: 'bot' }) }
  router.permContext = () => ({ projects: [] })
  router.engine = { createTask: async (input: any) => { calls.push(input); return { ...boundTask(input.chatAgentId), ...input } } }
  let status: number | undefined
  router.sendJson = (_res: any, code: number) => { status = code }
  const request = async (body: any) => {
    const req: any = Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = 'POST'; req.url = '/api/tasks'
    await router.dispatchRequest(req, {}, '')
  }
  await request({ chatAgentId: 'bot', title: 'invalid create' })
  assert.equal(status, 400); assert.equal(calls.length, 0)
  await request({ chatAgentId: 'bot', mode: 'chat', memberAgentIds: '["bot"]', ownerUserId: 'injected' })
  assert.equal(status, 201); assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].memberAgentIds, ['bot'])
  assert.equal(calls[0].chatAgentId, 'bot'); assert.equal(calls[0].mode, 'chat')
  assert.equal(calls[0].ownerUserId, undefined)
  router.store.getAgent = () => ({ id: 'bot', ownerUserId: 'someone-else' })
  await request({ chatAgentId: 'bot', mode: 'chat' })
  assert.equal(status, 404); assert.equal(calls.length, 1, 'private BOT cannot be executed by ID')
})

test('task-93: REST patch validates binding before title and member writes', async () => {
  const task = boundTask('bot'), writes: any[] = []
  const router: any = Object.create(WorkBuddyRouter.prototype)
  router.taskForManage = () => ({ task })
  router.store = { getTask: () => task, mutateTask: (_id: string, fn: any) => { writes.push('title'); fn(task) } }
  router.engine = { validateChatBinding: TaskEngine.prototype.validateChatBinding, updateMembers: (...args: any[]) => writes.push(args) }
  let status: number | undefined
  router.sendJson = (_res: any, code: number) => { status = code }
  const request = async (body: any) => {
    const req: any = Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = 'PATCH'; req.url = '/api/tasks/contract-chat'
    await router.dispatchRequest(req, {}, '')
  }
  for (const route of [{ chatAgentId: null }, { chatAgentId: '' }, { chatAgentId: 'other' }, { mode: 'orchestrate' }, { memberAgentIds: ['other'] }, { teamId: 'team' }]) {
    await request({ ...route, title: 'must not write' })
    assert.equal(status, 400, JSON.stringify(route)); assert.equal(writes.length, 0)
  }
  await request({ chatAgentId: 'bot', mode: 'chat', memberAgentIds: ['bot'], title: 'updated' })
  assert.equal(status, 200); assert.equal(task.title, 'updated'); assert.equal(writes.length, 2)
  assert.equal(task.chatAgentId, 'bot')
})

test('task-93: bound model and preset endpoints use the BOT without planner and save model overrides', async () => {
  const task = boundTask('bot'), targets: string[] = [], updates: any[] = []
  task.sessions = { bot: { remoteSessionId: 'bot-session' }, __node__: { remoteSessionId: 'wrong-session' } }
  const router: any = Object.create(WorkBuddyRouter.prototype)
  router.taskForView = () => task
  router.store = { mutateTask: (_id: string, fn: any) => fn(task) }
  router.planner = { pickMainAgent: () => { throw new Error('planner must not run') } }
  router.engine = { resolveExecTarget: async (_task: any, id: string) => { targets.push(id); return { online: true, baseUrl: 'http://bot' } } }
  router.client = {
    getModels: async () => ({ ok: true, models: [{ id: 'model', provider: 'provider' }] }),
    getPresets: async () => ({ ok: true, presets: [{ id: 'preset' }] }),
    getSessionDetail: async (_target: any, sessionId: string) => { assert.equal(sessionId, 'bot-session'); return { ok: true, session: {} } },
    updateSessionModel: async (_target: any, sessionId: string, input: any) => { assert.equal(sessionId, 'bot-session'); updates.push(input); return { ok: true } },
  }
  let status: number | undefined
  router.sendJson = (_res: any, code: number) => { status = code }
  const request = async (path: string, method: string, body: any = {}) => {
    const req: any = Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = method; req.url = `/api/tasks/contract-chat/${path}`
    await router.dispatchRequest(req, {}, '')
  }
  for (const path of ['models', 'presets', 'session-model']) {
    await request(path, 'GET'); assert.equal(status, 200)
  }
  await request('session-model', 'PUT', { provider: 'provider', model: 'model', reasoningEffort: 'high' })
  assert.equal(status, 200); assert.equal(task.model, 'provider/model'); assert.equal(task.reasoningEffort, 'high')
  await request('session-preset', 'PUT', { preset: 'preset' })
  assert.equal(status, 200); assert.equal(task.agentPreset, 'preset')
  assert.ok(targets.length >= 5); assert.ok(targets.every(id => id === 'bot'))
  const count = updates.length, targetCount = targets.length
  for (const path of ['session-model', 'session-preset']) {
    await request(path, 'PUT', { agentId: 'other', model: 'wrong', preset: 'wrong' })
    assert.equal(status, 400)
  }
  assert.equal(updates.length, count); assert.equal(targets.length, targetCount)
  assert.equal(task.agentPreset, 'preset'); assert.equal(task.model, 'provider/model')
})

test('task-93: private BOT create and preflight are rejected without remote or task side effects', async () => {
  let writes = 0
  const tool = createWorkBuddyToolDefs({ consoleUrl: 'http://localhost', store: {
    getAgent: () => ({ id: 'private-bot', ownerUserId: 'owner' }), getProjects: () => [],
  }, engine: { createTask: () => { writes++ }, extractMentions: async () => noMentions } } as any).find(d => d.name === 'workbuddy_task_manage')!
  for (const action of ['create', 'preflight']) {
    const result = JSON.parse(await tool.execute({ action, mode: 'chat', chatAgentId: 'private-bot' }))
    assert.equal(result.code, 'AGENT_NOT_FOUND')
  }
  assert.equal(writes, 0)
})

test('task-93: REST messages preserves view check and routing options', async () => {
  const calls: any[] = []
  const router: any = Object.create(WorkBuddyRouter.prototype)
  router.taskForView = () => boundTask('bot')
  router.engine = { sendUserMessage: async (...args: any[]) => { calls.push(args); return { ok: true } } }
  let payload: any, status: number | undefined
  router.sendJson = (_res: any, code: number, data: any) => { status = code; payload = data }
  const request = async (body: any) => {
    const req: any = Readable.from([Buffer.from(JSON.stringify(body))])
    req.method = 'POST'; req.url = '/api/tasks/contract-chat/messages'
    await router.dispatchRequest(req, {}, '')
  }
  await request({ message: 'hello', chatAgentId: 'bot', mode: 'chat', memberAgentIds: ['bot'] })
  assert.equal(status, 202)
  assert.deepEqual(calls[0][2], { chatAgentId: 'bot', mode: 'chat', memberAgentIds: ['bot'] })
  await request({ message: 'hello', chatAgentId: 'bot', mode: 'orchestrate' })
  assert.equal(status, 400)
  assert.equal(payload.code, 'INVALID_PARAM')
  assert.equal(calls.length, 1)
  router.taskForView = () => undefined
  await request({ message: 'hello', chatAgentId: 'bot', mode: 'chat' })
  assert.equal(status, 404)
  assert.equal(calls.length, 1)
})

test('WEB-2: group_manage contract enforces branch-required fields and normalizes lastReadSeq', () => {
  const v = (args: any) => validateToolArgs('workbuddy_group_manage', args)
  for (const [action, field] of [
    ['get', 'roomId'], ['update', 'roomId'], ['delete', 'roomId'], ['rounds', 'roomId'], ['add_round', 'roomId'], ['mark_read', 'roomId'],
  ] as const) {
    assert.ok(v({ action }).errors.some((e) => e.path === field), `${action} 需要 ${field}`)
  }
  assert.ok(v({ action: 'create' }).errors.some((e) => e.path === 'room'), 'create 需要 room')
  assert.ok(v({ action: 'update', roomId: 'g' }).errors.some((e) => e.path === 'room'), 'update 需要 room 对象')
  assert.ok(v({ action: 'update', roomId: 'g', room: 'x' }).errors.some((e) => e.path === 'room'), 'room 非对象被拒')
  assert.ok(v({ action: 'add_section' }).errors.some((e) => e.path === 'name'), 'add_section 需要 name')
  assert.ok(v({ action: 'remove_section' }).errors.some((e) => e.path === 'name'), 'remove_section 需要 name')
  assert.ok(v({ action: 'rename_section', old: 'a' }).errors.some((e) => e.path === 'to'), 'rename_section 需要 old+to')
  assert.ok(v({ action: 'add_round', roomId: 'g' }).errors.some((e) => e.path === 'taskId'), 'add_round 需要 taskId')
  assert.ok(v({ action: 'mark_read', roomId: 'g' }).errors.some((e) => e.path === 'lastReadSeq'), 'mark_read 需要 lastReadSeq')
  assert.ok(v({ action: 'mark_read', roomId: 'g', lastReadSeq: '-1' }).errors.length, '负数位点被拒（整数下限 0）')
  const ok = v({ action: 'mark_read', roomId: 'g', lastReadSeq: '5', typo: 'ignored' })
  assert.ok(!ok.errors.length)
  assert.equal(ok.args.lastReadSeq, 5, '字符串数字归一化为整数')
  assert.deepEqual(ok.args.action, 'mark_read')
  assert.ok(ok.warnings.some((w) => w.includes('typo')), '未知参数告警')
})
