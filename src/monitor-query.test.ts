import { test } from 'node:test'
import assert from 'node:assert/strict'
import { queryMonitorOverview, MonitorQueryError, type MonitorQueryOptions } from './monitor-query.js'
import type { MonitorOverview } from './monitor.js'
import type { Project, WorkTask } from './types.js'

const now = new Date(2026, 10, 8, 12).getTime()
function project(id = 'p1'): Project {
  return { id, name: id, dshRef: { kind: 'mapping', mappingId: 'files' }, defaultExecutionNodeRef: { kind: 'mapping', mappingId: 'exec' }, workspace: '/shared', defaultAgentIds: ['a1'], expertIds: [], connectorIds: ['ssh:r1'], skillNames: [], createdAt: now, updatedAt: now }
}
function task(id: string, projectId = 'p1', memberAgentIds = ['a2']): WorkTask {
  return { id, projectId, title: id, mode: 'chat', status: 'running', memberAgentIds, sessions: {}, turns: [], nodeRef: { kind: 'mapping', mappingId: 'exec' }, createdAt: now, updatedAt: now }
}
function fixture(tasks = [task('t1'), task('secret-task', 'p2', ['a1'])]): MonitorOverview {
  return {
    at: now,
    kpi: { agentsTotal: 99, agentsOnline: 99, agentsBusy: 99, agentsDisabled: 99, tasksRunning: 99, tasksCompletedToday: 99, tasksFailedToday: 99, tokensInputToday: 999999, tokensOutputToday: 999999, cacheReadToday: 999999, toolCallsToday: 999999, schedulesTotal: 99, schedulesEnabled: 99, nextScheduleAt: now, nextScheduleName: 'secret-schedule' },
    agents: ['a1', 'a2', 'secret-agent'].map((id) => ({ id, nodeId: 'mapping:exec', name: id, enabled: true, online: true, busy: true, runningCount: 99, taskCount: 99, currentActivity: 'secret-task', resources: [], live: { taskId: 'secret-task', taskTitle: 'secret-task', phase: 'secret-task', state: 'thinking', todosDone: 0, todosTotal: 0 } })),
    nodes: ['files', 'exec', 'secret-node'].map((key) => ({ key, name: key, mappingId: key, baseUrl: 'http://cache:1234', online: true, runningCount: 99, tasksTotal: 99, tasksToday: 99, lastTaskTitle: 'secret-task', currentTaskId: 'secret-task', currentActivity: 'secret-task', model: 'secret-model' })),
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, type: 'chat', typeIcon: 'x', typeLabel: 'chat', status: t.status, running: t.status === 'running', agentIds: t.memberAgentIds, agentNames: t.memberAgentIds, createdAt: now, updatedAt: now, description: 'd'.repeat(4000), headline: 'h'.repeat(4000), activity: { phase: 'p', runningTools: [], todosDone: 0, todosTotal: 0, turnCount: 0 } })),
    schedules: [{ id: 'secret-schedule', name: 'secret-schedule', enabled: true, ruleText: 'daily', totalRuns: 99, successRuns: 99 }],
    sshPool: ['r1', 'secret-resource'].map((id) => ({ id, name: id, host: 'host', port: 2222, inUse: [{ taskId: 'secret-task', taskTitle: 'secret-task', tool: 'bash', at: now }] })),
    events: [ { at: now, level: 'info', kind: 'task_started', msg: 't1', taskId: 't1' }, { at: now, level: 'info', kind: 'agent_online', msg: 'a1', agentId: 'a1' }, { at: now, level: 'info', kind: 'task_started', msg: 'secret-task', taskId: 'secret-task', agentId: 'a1' }, { at: now, level: 'info', kind: 'schedule_fired', msg: 'secret-schedule', scheduleId: 'secret-schedule' } ],
    alerts: [ { at: now, level: 'error', refType: 'task', refId: 't1', msg: 'secret aggregate 99' }, { at: now, level: 'warn', refType: 'schedule', refId: 'secret-schedule', msg: 'secret-schedule' } ],
  }
}

test('no options preserves legacy overview shape and object', () => {
  const overview = fixture()
  assert.equal(queryMonitorOverview(overview, undefined, { projects: [], tasks: [] }), overview)
  assert.equal(queryMonitorOverview(overview, {}, { projects: [], tasks: [] }), overview)
})

test('project projection recomputes KPI and shared activity without global leakage', () => {
  const tasks = [task('t1'), task('secret-task', 'p2', ['a1'])]
  const overview = fixture(tasks)
  const before = JSON.stringify(overview)
  const result = queryMonitorOverview(overview, { projectId: 'p1' }, { projects: [project()], tasks })
  assert.deepEqual(result.tasks?.map((t) => t.id), ['t1'])
  assert.deepEqual(result.agents?.map((a) => a.id), ['a1', 'a2'])
  assert.equal(result.agents?.[0].busy, true) // globally busy is retained for dispatch
  assert.equal(result.agents?.[0].taskCount, 0)
  assert.equal(result.agents?.[1].taskCount, 1)
  assert.equal(result.kpi?.agentsTotal, 2)
  assert.equal(result.kpi?.agentsBusy, 1)
  assert.equal(result.kpi?.tasksRunning, 1)
  assert.equal(result.kpi?.tokensInputToday, 0)
  assert.equal(result.kpi?.schedulesTotal, undefined)
  assert.deepEqual(result.schedules, [])
  assert.deepEqual(result.sshPool?.map((r) => r.id), ['r1'])
  assert.deepEqual(result.sshPool?.[0].inUse, [])
  assert.deepEqual(result.nodes?.map((n) => [n.key, n.tasksTotal]), [['files', 0], ['exec', 1]])
  assert.equal(result.events?.length, 2)
  assert.equal(result.alerts?.length, 1)
  assert.equal(result.alerts?.[0].msg, '任务「t1」失败')
  assert.ok(!JSON.stringify(result).includes('secret'))
  assert.equal(JSON.stringify(overview), before)
})

test('empty project cannot borrow task ownership from a shared workspace', () => {
  const result = queryMonitorOverview(fixture(), { projectId: 'empty' }, { projects: [{ ...project('empty'), defaultAgentIds: [], connectorIds: [] }], tasks: [task('t1')] })
  assert.deepEqual(result.tasks, [])
  assert.deepEqual(result.agents, [])
  assert.deepEqual(result.events, [])
  assert.equal(result.kpi?.tasksRunning, 0)
  assert.ok(result.nodes?.every((n) => n.tasksTotal === 0))
})

test('stable node identities associate app sessions without matching cached URLs', () => {
  const tasks = [task('t1')]
  tasks[0].nodeRef = { kind: 'app', appId: 'app1' }
  tasks[0].sessions.__node__ = { remoteSessionId: 's', baseUrl: 'http://cache:1234', nodeRefKey: 'app:app1', resolvedMappingId: 'actual', createdAt: now }
  const overview = fixture(tasks)
  overview.nodes.push({ key: 'actual', mappingId: 'actual', name: 'Actual', online: true, runningCount: 99, tasksTotal: 99, tasksToday: 99 })
  const result = queryMonitorOverview(overview, { projectId: 'p1', section: 'nodes', compact: true }, { projects: [project()], tasks })
  assert.equal(result.nodes?.find((n) => n.key === 'actual')?.tasksTotal, 1)
  assert.equal(result.nodes?.find((n) => n.key === 'exec')?.tasksTotal, 0)
  assert.ok(!result.nodes?.some((n) => n.key === 'secret-node'))
  assert.ok(!JSON.stringify(result).includes('http://cache'))
})

test('compact agents and tasks keep stable routing and fit a typical 2KB section', () => {
  const tasks = [task('t1'), task('t2'), task('t3')]
  for (const section of ['agents', 'tasks']) {
    const result = queryMonitorOverview(fixture(tasks), { projectId: 'p1', section, compact: 'true' }, { projects: [project()], tasks })
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 2048)
    assert.ok(result.metadata?.omittedFields.length)
    if (section === 'tasks') {
      assert.equal(result.tasks?.[0].projectId, 'p1')
      assert.equal(result.tasks?.[0].nodeId, 'mapping:exec')
      assert.deepEqual(result.tasks?.[0].agentIds, ['a2'])
    } else {
      assert.equal(result.agents?.[0].nodeId, 'mapping:exec')
      assert.equal(result.agents?.[0].online, true)
      assert.equal(typeof result.agents?.[0].busy, 'boolean')
    }
  }
})

test('limit defaults to 30, accepts 200 and reports truncation before slicing', () => {
  const tasks = Array.from({ length: 205 }, (_, i) => task(`t${i}`))
  const overview = fixture(tasks)
  for (const [limit, expected] of [[undefined, 30], ['2', 2], [200, 200]] as const) {
    const result = queryMonitorOverview(overview, { section: 'tasks', compact: true, limit }, { projects: [project()], tasks })
    assert.equal(result.tasks?.length, expected)
    assert.deepEqual(result.metadata?.sections.tasks, { total: 205, returned: expected, hasMore: true })
  }
})

test('invalid sections and parameter types fail with 400; missing visible project fails 404', () => {
  const overview = fixture()
  for (const options of [ { section: 'agents,nope' }, { section: 'agents,' }, { section: '' }, { compact: 'yes' }, { limit: '' }, { limit: '1.5' }, { limit: 0 }, { limit: -1 }, { limit: NaN }, { limit: Infinity }, { limit: 201 }, { projectId: '' }, { limit: false }, { compact: 1 }, { section: ['tasks'] } ]) {
    assert.throws(() => queryMonitorOverview(overview, options as MonitorQueryOptions, { projects: [], tasks: [] }), (e) => e instanceof MonitorQueryError && e.status === 400)
  }
  assert.throws(() => queryMonitorOverview(overview, { projectId: 'missing' }, { projects: [], tasks: [] }), (e) => e instanceof MonitorQueryError && e.status === 404)
})

test('sparse legacy overview and compact agent records retain existing fields', () => {
  const agents = [{ id: 'a', name: 'Agent', online: true, busy: true, nodeId: 'mapping:n' }]
  const overview = { agents, kpi: { agentsBusy: 1 } } as MonitorOverview
  const result = queryMonitorOverview(overview, { compact: true }, { projects: [], tasks: [] })
  assert.deepEqual(result.agents, agents)
})

test('nested array truncation identifies each row without overwriting totals', () => {
  const tasks = [task('t1', 'p1', ['a1', 'a2', 'a3']), task('t2', 'p1', ['a1', 'a2', 'a3', 'a4'])]
  const result = queryMonitorOverview(fixture(tasks), { section: 'tasks', compact: true, limit: 2 }, { projects: [], tasks })
  assert.deepEqual(result.metadata?.sections['tasks[0].agentIds'], { total: 3, returned: 2, hasMore: true })
  assert.deepEqual(result.metadata?.sections['tasks[1].agentIds'], { total: 4, returned: 2, hasMore: true })
  assert.deepEqual(result.metadata?.sections.tasks, { total: 2, returned: 2, hasMore: false })
  assert.equal(result.metadata?.totalSource, 'overviewSnapshot')
})

test('section selection, empty arrays, and description truncation are explicit', () => {
  const overview = fixture([])
  const result = queryMonitorOverview(overview, { section: 'tasks,events', compact: false }, { projects: [], tasks: [] })
  assert.deepEqual(result.tasks, [])
  assert.equal(result.kpi, undefined)
  assert.deepEqual(result.metadata?.sections.tasks, { total: 0, returned: 0, hasMore: false })
  overview.events[0].msg = 'x'.repeat(1000)
  const compact = queryMonitorOverview(overview, { section: 'events', compact: true }, { projects: [], tasks: [] })
  assert.equal(compact.events?.[0].msg.length, 100)
  assert.ok(compact.metadata?.truncatedFields.includes('events[0].msg'))
})
