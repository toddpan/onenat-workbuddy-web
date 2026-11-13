import assert from 'node:assert/strict'
import test from 'node:test'
import { WORKBUDDY_TOOL_NAMES, toolInputSchema } from './tool-contracts.js'
import { TOOL_POLICY_SCOPE, toolActionPolicy, toolActions, toolActionRisks, toolAnnotations } from './tool-policy.js'

const readOnly = { readOnly: true }
const ai = { aiTokenOnly: true }

test('all registered contract actions have explicit policies; unknown actions fail closed', () => {
  for (const name of [...WORKBUDDY_TOOL_NAMES, 'workbuddy_capabilities']) {
    const schemaActions = name === 'workbuddy_capabilities' ? undefined : toolInputSchema(name).properties?.action?.enum
    if (schemaActions) assert.deepEqual(toolActions(name), schemaActions, name)
    const policies = toolActionRisks(name)
    assert.ok(policies.length, name)
    for (const policy of policies) {
      assert.equal(policy.allowed, true, `${name}/${policy.action}`)
      assert.ok(policy.risk.length, `${name}/${policy.action}`)
    }
    assert.equal(toolActionPolicy(name, { action: 'future-action' }).allowed, false, name)
  }
  for (const name of ['unknown', '__proto__', 'constructor', 'toString']) {
    assert.equal(toolActionPolicy(name, {}).allowed, false)
    assert.deepEqual(toolActions(name), [])
    assert.deepEqual(toolActionRisks(name), [])
  }
})

test('legacy missing-action defaults preserve each contract default without normalizing unknown input', () => {
  assert.equal(toolActionPolicy('workbuddy_agent_manage', {}).action, 'list')
  assert.equal(toolActionPolicy('workbuddy_monitor_read', {}).action, 'overview')
  assert.equal(toolActionPolicy('workbuddy_planner_manage', {}).action, 'get')
  for (const action of [' LIST ', 'LIST', false, 1, {}, [], '__proto__']) {
    assert.equal(toolActionPolicy('workbuddy_agent_manage', { action }).allowed, false)
  }
})

test('conservative read whitelist remains usable with readonly AI or console contexts', () => {
  const reads: Record<string, string[]> = {
    workbuddy_agent_manage: ['list'], workbuddy_task_manage: ['list', 'preflight', 'wait'],
    workbuddy_ssh_resource_manage: ['list'], workbuddy_monitor_read: ['overview', 'events', 'history', 'task'],
    workbuddy_schedule_manage: ['list', 'get'], workbuddy_planner_manage: ['get'],
    workbuddy_file_manage: ['list', 'download'], workbuddy_project_manage: ['list', 'get'],
    workbuddy_expert_manage: ['list', 'get', 'search'], workbuddy_team_manage: ['list', 'get'],
    workbuddy_backlog_manage: ['projects', 'config', 'list', 'search', 'view', 'overview'],
    workbuddy_capabilities: ['query'],
  }
  for (const ctx of [readOnly, { ...readOnly, ...ai }, { ...readOnly, session: { role: 'admin' as const } }]) {
    for (const [name, actions] of Object.entries(reads)) {
      for (const action of actions) assert.equal(toolActionPolicy(name, { action }, ctx).allowed, true, `${name}/${action}`)
    }
    assert.equal(toolActionPolicy('workbuddy_task_status', {}, ctx).allowed, true)
    assert.equal(toolActionPolicy('workbuddy_task_chat', {}, ctx).allowed, true)
  }
})

test('readonly rejects all mutation, execution, probe, refresh and credential branches', () => {
  for (const name of [...WORKBUDDY_TOOL_NAMES, 'workbuddy_capabilities']) {
    for (const policy of toolActionRisks(name, readOnly)) {
      const dangerous = policy.risk.some(risk => !['read', 'download'].includes(risk)) || !policy.risk.includes('read')
      assert.equal(policy.allowed, !dangerous, `${name}/${policy.action}`)
      if (dangerous) assert.ok(policy.reason)
    }
  }
  for (const name of ['workbuddy_resource_manage', 'workbuddy_agent_manage']) {
    const actions = name === 'workbuddy_resource_manage' ? ['list', 'dsh', 'resolve', 'refresh'] : ['ping', 'preview', 'models', 'presets']
    for (const action of actions) assert.equal(toolActionPolicy(name, { action }, readOnly).allowed, false)
  }
  assert.equal(toolActionPolicy('workbuddy_planner_manage', { action: 'options' }, readOnly).allowed, false)
})

test('chat execution is selected by the same truthiness as runtime, including whitespace', () => {
  for (const followupMessage of ['run', ' ', true, 1, {}]) {
    const decision = toolActionPolicy('workbuddy_task_chat', { followupMessage }, readOnly)
    assert.equal(decision.action, 'followup')
    assert.equal(decision.allowed, false)
    assert.ok(decision.risk.includes('execute'))
  }
  for (const followupMessage of ['', false, 0, null, undefined]) {
    const decision = toolActionPolicy('workbuddy_task_chat', { followupMessage }, readOnly)
    assert.equal(decision.action, 'read')
    assert.equal(decision.allowed, true)
  }
  assert.equal(toolActionPolicy('workbuddy_task_chat', { action: 'read', followupMessage: 'execute' }, readOnly).allowed, false)
})

test('evaluate and answering suspended questions are writes; wait is a read ceiling', () => {
  for (const name of ['workbuddy_task_evaluate', 'workbuddy_task_ask_answer']) {
    assert.equal(toolActionPolicy(name, {}, readOnly).allowed, false)
    assert.equal(toolActionPolicy(name, {}, ai).allowed, true)
    assert.ok(toolActionPolicy(name).risk.includes('write'))
  }
  assert.deepEqual(toolActionPolicy('workbuddy_task_manage', { action: 'wait' }, readOnly).risk, ['read'])
  assert.match(TOOL_POLICY_SCOPE, /object ACLs/)
})

test('full status may issue export credentials and is blocked with readonly credentials', () => {
  assert.equal(toolActionPolicy('workbuddy_task_status', { detail: 'summary' }, readOnly).allowed, true)
  const full = toolActionPolicy('workbuddy_task_status', { detail: 'full' }, readOnly)
  assert.equal(full.allowed, false)
  assert.ok(full.risk.includes('credentials'))
  assert.equal(toolActionPolicy('workbuddy_task_status', { detail: 'full' }, ai).allowed, true)
})

test('SSH AI guard is not bypassed by an inconsistent admin session or tool arguments', () => {
  for (const action of ['get', 'exec']) {
    assert.equal(toolActionPolicy('workbuddy_ssh_resource_manage', { action }, ai).allowed, false)
    assert.equal(toolActionPolicy('workbuddy_ssh_resource_manage', { action }, { ...ai, session: { role: 'admin' } }).allowed, false)
    assert.equal(toolActionPolicy('workbuddy_ssh_resource_manage', { action, aiTokenOnly: false, session: { role: 'admin' } }, ai).allowed, false)
    assert.equal(toolActionPolicy('workbuddy_ssh_resource_manage', { action }, { session: { userId: 'owner', role: 'user' } }).allowed, true)
  }
})

test('ordinary AI scope is not expanded or silently replaced by a new admin requirement', () => {
  const writes: Record<string, string> = {
    workbuddy_agent_manage: 'upsert', workbuddy_project_manage: 'upsert', workbuddy_schedule_manage: 'run',
    workbuddy_planner_manage: 'set', workbuddy_expert_manage: 'create', workbuddy_team_manage: 'upsert',
  }
  for (const [name, action] of Object.entries(writes)) {
    const policy = toolActionPolicy(name, { action }, ai)
    assert.equal(policy.allowed, true)
    assert.ok(policy.risk.includes('global-management'))
    assert.equal(toolActionPolicy(name, { action }, { ...ai, ...readOnly }).allowed, false)
  }
})

test('MCP annotations are conservative across all branches, independent of caller', () => {
  for (const name of ['workbuddy_task_chat', 'workbuddy_task_status', 'workbuddy_task_evaluate', 'workbuddy_resource_manage', 'workbuddy_file_manage']) assert.equal(toolAnnotations(name).readOnlyHint, false, name)
  assert.equal(toolAnnotations('workbuddy_capabilities').readOnlyHint, true)
  assert.equal(toolAnnotations('workbuddy_capabilities').idempotentHint, true)
  assert.equal(toolAnnotations('workbuddy_task_manage').destructiveHint, true)
  assert.equal(toolAnnotations('unknown').destructiveHint, true)
  assert.equal(toolAnnotations('unknown').readOnlyHint, false)
})

test('WEB-2: group_manage read/write/destructive tiers; AI tokens denied on all 12 actions (no shared bucket)', () => {
  const name = 'workbuddy_group_manage'
  const actions = toolActions(name)
  assert.deepEqual(actions, ['list', 'get', 'create', 'update', 'delete', 'sections', 'add_section', 'rename_section', 'remove_section', 'rounds', 'add_round', 'mark_read'])
  for (const action of ['list', 'get', 'sections', 'rounds']) assert.deepEqual(toolActionPolicy(name, { action }).risk, ['read'])
  for (const action of ['create', 'update', 'add_section', 'rename_section', 'remove_section', 'add_round', 'mark_read']) assert.deepEqual(toolActionPolicy(name, { action }).risk, ['write'])
  assert.deepEqual(toolActionPolicy(name, { action: 'delete' }).risk, ['write', 'destructive'])
  // AI 令牌（无登录身份）全部 action 一律拒绝——含只读；admin 会话混入也不得放行（身份来自通道，与参数无关）
  for (const action of actions) {
    assert.equal(toolActionPolicy(name, { action }, ai).allowed, false, `${action}/ai-token`)
    assert.equal(toolActionPolicy(name, { action }, { ...ai, session: { role: 'admin' } }).allowed, false, `${action}/ai-token+admin`)
    assert.equal(toolActionPolicy(name, { action, session: { userId: 'x', role: 'admin' } }, ai).allowed, false, `${action}/ai-token+args-session`)
  }
  // 控制台登录身份：只读档可用；readOnly 凭证只放行 read 档
  for (const action of ['list', 'get', 'sections', 'rounds']) {
    assert.equal(toolActionPolicy(name, { action }, { session: { userId: 'u', role: 'user' } }).allowed, true)
    assert.equal(toolActionPolicy(name, { action }, readOnly).allowed, true)
  }
  for (const action of ['create', 'update', 'delete', 'add_section', 'rename_section', 'remove_section', 'add_round', 'mark_read']) {
    assert.equal(toolActionPolicy(name, { action }, readOnly).allowed, false)
  }
  assert.equal(toolAnnotations(name).destructiveHint, true)
  assert.equal(toolAnnotations(name).readOnlyHint, false)
})

test('pure helpers do not mutate arguments, context, or returned shared data', () => {
  const args = Object.freeze({ action: 'send', message: 'run', taskId: 'task-1' })
  const ctx = Object.freeze({ ...ai, ...readOnly })
  const first = toolActionPolicy('workbuddy_task_manage', args, ctx)
  first.risk.push('corrupt')
  const actions = toolActions('workbuddy_task_manage')
  actions.push('corrupt')
  assert.equal(toolActionPolicy('workbuddy_task_manage', args, ctx).risk.includes('corrupt'), false)
  assert.equal(toolActions('workbuddy_task_manage').includes('corrupt'), false)
})
