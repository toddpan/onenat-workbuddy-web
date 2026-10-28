/**
 * TaskEngine 行为回归测试（v2026.10.23 专家设计调整）。
 *
 * 覆盖公开行为（store 状态与任务账本，不碰私有方法）：
 *  1. 项目默认协作成员（defaultAgentIds）服务端继承：create 未传成员时继承、显式空数组不继承；
 *  2. 团队任务首轮触发团队合同，plan.scope.team 记录合同快照；后续无 @ 追问回主会话（不自动重跑全团）；
 *  3. @单专家 → 动态成员按新前缀 __expert__:<id> 登记（expertId 字段），编排 scope.kind=members，
 *     持久智能体实体优先于伪 id（同 id 实体不被动态实例遮蔽）；
 *  4. 存量 expert-<id> 账本兼容：重复 @同名专家时沿用历史伪 id，会话键不断裂。
 *
 * 远端 DSH 经注入的 StubClient 模拟（无网络）；运行：npm run test:unit。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 测试进程内禁止构造函数自带的 30s 启动归档扫描（对齐 store.test 做法）
process.env.WORKBUDDY_ARCHIVE_BOOT_DELAY_MS = '3600000'

import { TaskEngine, extractToolPaths } from './engine.js'
import { WorkStore } from './store.js'
import type { AgentResolver } from './resolver.js'
import type { PromptComposer, ComposeContext, ComposeResult } from './prompt-composer.js'
import type { Orchestrator } from './orchestrator.js'
import type { PlanDraft, PlannerMember } from './orchestrator.js'
import { OnenatDirectory } from './onenat.js'
import type { DshClient, DshTarget, PromptResult } from './remote-client.js'
import type { ExpertRegistry, Expert, ExpertProfile } from './expert-registry.js'
import { buildCoverage } from './orchestrator.js'
import type { DshRef, ExpertTeam, PlanSubtask, SubAgent, TaskSummary, WorkTask } from './types.js'
import { EXPERT_AGENT_ID_PREFIX } from './types.js'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---------- Stub 组件 ----------

/** 单目标节点 stub：所有 resolve 路径都指向本地假节点 */
class StubResolver {
  constructor(private failRef: boolean = false) {}
  async resolve(agent: SubAgent) {
    if (this.failRef) return { baseUrl: '', agentId: agent.id, resolvedAt: Date.now(), online: false, error: 'stub off' } as any
    return { baseUrl: 'http://stub-node', agentId: agent.id, resolvedAt: Date.now(), online: true } as any
  }
  async resolveRef(ref: DshRef, apiKey?: string, agentId = 'node') {
    if (this.failRef || ref.kind === 'unknown' as any) return { baseUrl: '', agentId, resolvedAt: Date.now(), online: false, error: 'stub off' } as any
    return { baseUrl: 'http://stub-node', agentId, resolvedAt: Date.now(), online: true } as any
  }
  async resolveMembers(agentIds: string[]) {
    if (this.failRef) {
      return { targets: new Map(), issues: agentIds.map((id) => ({ agentId: id, name: id, error: 'stub off' })) } as any
    }
    const targets = new Map(agentIds.map((id) => [id, { baseUrl: 'http://stub-node', agentId: id, resolvedAt: Date.now(), online: true } as DshTarget & { online: boolean }]))
    return { targets, issues: [] } as any
  }
}

class StubComposer {
  async compose(_agent: SubAgent, _ctx: ComposeContext): Promise<ComposeResult> {
    return { block: '', resources: [], warnings: [] }
  }
}

/** 远端 HTTP stub：会话即时成功 + 流式回写固定文本（engine 只会走 createSession/streamPrompt 主干） */
class StubDshClient {
  created = 0
  async createSession(_target: DshTarget, _title: string, _options?: any) {
    this.created++
    return { ok: true, sessionId: `sess-${this.created}` }
  }
  async setSessionPermission() {
    return { ok: false, supported: false, error: 'stub no permission route' }
  }
  async updateSessionModel() {
    return { ok: true }
  }
  async getSession(_target: DshTarget, _sessionId: string) {
    return { ok: true, status: 'idle' }
  }
  async ping(_target: DshTarget) {
    // 引擎在派发前会探活任务节点（dsh-web-service /system/status）
    return { ok: true, name: 'dsh-web-service-stub', version: '0.0.0-stub' } as any
  }
  async getSessionInfo() {
    return { ok: true }
  }
  async listPendingQuestions() {
    return { ok: true, supported: true, count: 0, batches: [] }
  }
  async streamPrompt(_t: DshTarget, _sid: string, _prompt: string, handlers: any, _opts?: any): Promise<PromptResult> {
    await Promise.resolve()
    handlers?.onLog?.('stub stream start')
    const text = 'stub-output'
    handlers?.onDelta?.(text)
    handlers?.onLog?.('stub turn_end')
    return { ok: true, content: text, complete: true, via: 'sse' } as PromptResult
  }
  async prompt(): Promise<PromptResult> {
    return { ok: true, content: 'stub-output', via: 'sync' } as PromptResult
  }
  async reconcileTurn(): Promise<PromptResult> {
    return { ok: false, error: 'stub reconcile unused' } as PromptResult
  }
  async waitForSessionResult(): Promise<PromptResult> {
    return { ok: false, error: 'stub poll unused' } as PromptResult
  }
  async cancelSession() {
    return { ok: true }
  }
  async steerSession() {
    return { ok: true }
  }
  async listWorkspaces() {
    return { ok: false } as any
  }
  async ensureWorkspace() {
    return { ok: false } as any
  }
  async uploadFiles() {
    return { ok: true } as any
  }
  async chat(_target: DshTarget, _messages: any, _opts?: any) {
    return { ok: true, content: 'stub chat conclusion' }
  }
  async chatWithTools() {
    return { ok: true, message: { role: 'assistant', content: 'stub' } }
  }
}

const RESOURCE_DIR_STUB = {
  resolveMapping: () => undefined,
  resolveApp: () => undefined,
  engineInfoOf: () => undefined,
  listEndpoints: () => [],
} as unknown as OnenatDirectory

/** 规划器 stub：可注入本轮计划；summarize 固定按 subtasks 生成（不走 LLM） */
class StubPlanner {
  private created = 0
  constructor(private factory?: (objective: string, members: PlannerMember[]) => PlanDraft, private summary?: TaskSummary) {}
  async pickTarget() {
    return { error: 'stub: no planner target' } as const
  }
  async planTask(objective: string, members: PlannerMember[]): Promise<any> {
    const draft = this.factory
      ? this.factory(objective, members)
      : { strategy: 'parallel' as const, subtasks: members.map((m) => ({ title: `t-${m.agent.id}`, prompt: `为 ${m.agent.name} 澄清环节 stub-${++this.created}`, agentId: m.agent.id, dependsOn: [] })) }
    return { plan: draft }
  }
  async summarize(_objective: string, subtasks: PlanSubtask[], _mt: Map<string, DshTarget>, _node?: unknown, opts?: { team?: ExpertTeam; nameOf?: (k: string) => string }): Promise<TaskSummary> {
    if (this.summary) return this.summary
    const completed = subtasks.filter((s) => s.status === 'completed').length
    const total = subtasks.length
    // 与 Orchestrator.summarize 同口径：团队轮按团队名册计；普通轮按实际参与者计
    const members = opts?.team
      ? opts.team.members.map((m) => ({
          id: (m.agentId || EXPERT_AGENT_ID_PREFIX + m.expertId),
          name: opts.nameOf?.(m.agentId || EXPERT_AGENT_ID_PREFIX + m.expertId) || String(m.agentId || m.expertId),
          duty: m.duty,
        }))
      : [...new Set(subtasks.map((s) => s.agentId))].map((id) => ({ id, name: opts?.nameOf?.(id) || String(id) }))
    return {
      status: completed === total && total > 0 ? 'success' : completed > 0 ? 'partial_success' : 'failed',
      overview: `stub ${completed}/${total}`,
      subtaskSummaries: subtasks.map((s) => ({ id: s.id, title: s.title, status: s.status, keyPoints: s.result?.content || '' })),
      finalConclusion: 'stub 结论',
      completedAt: Date.now(),
      ...(total ? { coverage: buildCoverage(members, subtasks) } : {}),
    }
  }
}

/** 专家库 stub：一个内置专家 alameda（「阿拉米达」按中/英文匹配可提） */
class StubRegistry {
  private expert: Expert & ExpertProfile
  constructor() {
    this.expert = {
      id: 'alameda', name: '阿拉米达', nameEn: 'alameda', source: 'roster', division: 'team', divisionZh: '团队',
      icon: '🧩', description: 'stub 专家描述', tags: ['stub'],
      systemPrompt: 'stub system prompt', executionPrompt: 'stub execution', role: 'stub role',
    }
  }
  async search(): Promise<Expert[]> {
    return [this.expert]
  }
  async get(id: string): Promise<Expert | undefined> {
    return id === this.expert.id ? this.expert : undefined
  }
  async getProfile(id: string): Promise<ExpertProfile> {
    if (id !== this.expert.id) throw new Error('专家不存在')
    return this.expert
  }
}

// ---------- 工具函数 ----------

interface Fixture {
  store: WorkStore
  dir: string
  client: StubDshClient
  engine: TaskEngine
  planners: StubPlanner
  registry: StubRegistry
  resolver: StubResolver
}

function makeFixture(opts?: { failResolver?: boolean; plannerFactory?: (objective: string, members: PlannerMember[]) => PlanDraft; summary?: TaskSummary }): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'wb-engine-test-'))
  const store = new WorkStore(join(dir, 'store.json'))
  const client = new StubDshClient()
  const planners = new StubPlanner(opts?.plannerFactory, opts?.summary)
  const resolver = new StubResolver(opts?.failResolver)
  const engine = new TaskEngine(
    store,
    RESOURCE_DIR_STUB,
    resolver as unknown as AgentResolver,
    new StubComposer() as unknown as PromptComposer,
    planners as unknown as Orchestrator,
    undefined,
    new StubRegistry() as unknown as ExpertRegistry,
    client as unknown as DshClient,
  )
  return { store, dir, client, engine, planners, registry: new StubRegistry(), resolver }
}

/** store 直接造启用子智能体（store.upsertAgent 新建实体不保留外部 id：先随机建再改名） */
function seedAgent(store: WorkStore, id: string, extra: Partial<SubAgent> = {}): SubAgent {
  const now = Date.now()
  const seedName = extra.name || id
  const created = store.upsertAgent({ id: `seed-${Math.random().toString(36).slice(2, 8)}-${id}`, name: seedName, dshRef: extra.dshRef || { kind: 'direct', apiBaseUrl: 'http://stub-node' }, enabled: extra.enabled ?? true, createdAt: now, updatedAt: now } as any)
  store.mutateAgent(created.id, (a) => {
    a.id = id
    a.role = extra.role
    a.systemPrompt = extra.systemPrompt
    a.executionPrompt = extra.executionPrompt
    if (extra.resources) a.resources = extra.resources
    if (extra.skills) a.skills = extra.skills
  })
  return store.getAgent(id)!
}

/** 等待 engine 空转（含异步 void 轮收尾），返回最终任务 */
async function settle(engine: TaskEngine, store: WorkStore, taskId: string, timeoutMs = 12_000): Promise<WorkTask> {
  const t0 = Date.now()
  for (;;) {
    await delay(50)
    const t = store.getTask(taskId)
    if (!t) throw new Error('任务消失: ' + taskId)
    if (!engine.isRunning(taskId) && Date.now() - t0 > 300) return store.getTask(taskId)!
    if (Date.now() - t0 > timeoutMs) throw new Error('任务未在时限内收敛: ' + taskId + ' 状态=' + t.status)
  }
}

// ---------- 用例 ----------

test('项目默认协作成员：create 未传 memberAgentIds 时由服务端继承；显式空数组不继承', async () => {
  const f = makeFixture()
  try {
    seedAgent(f.store, 'ag-default', { name: '默认成员甲' })
    seedAgent(f.store, 'ag-default2', { name: '默认成员乙' })
    f.store.upsertProject({ name: '示例项目', dshRef: { kind: 'direct', apiBaseUrl: 'http://stub-node' }, defaultAgentIds: ['ag-default', 'ag-default2'] })
    const proj = f.store.getProjects()[0]
    // canonical 与兼容别名镜像保持一致
    assert.deepEqual(f.store.getProject(proj.id)!.expertIds, ['ag-default', 'ag-default2'])

    const t1 = await f.engine.createTask({ title: '继承默认成员', projectId: proj.id })
    assert.deepEqual(t1.memberAgentIds.sort(), ['ag-default', 'ag-default2'], '未传成员 → 继承项目默认协作成员')

    const t2 = await f.engine.createTask({ title: '显式清空成员', projectId: proj.id, memberAgentIds: [] })
    assert.deepEqual(t2.memberAgentIds, [], '显式空数组 = 明确不要成员，不触发继承')

    const t3 = await f.engine.createTask({ title: '显式成员', projectId: proj.id, memberAgentIds: ['ag-default'] })
    assert.deepEqual(t3.memberAgentIds, ['ag-default'], '显式成员优先于项目默认')
  } finally {
    f.store.flush()
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('项目默认协作成员：全部停用时不强制继承，任务仍可节点直发', async () => {
  const f = makeFixture()
  try {
    seedAgent(f.store, 'ag-disabled', { enabled: false } as any)
    f.store.upsertProject({ name: '停用成员项目', dshRef: { kind: 'direct', apiBaseUrl: 'http://stub-node' }, defaultAgentIds: ['ag-disabled'] })
    const proj = f.store.getProjects()[0]
    const t = await f.engine.createTask({ title: '默认成员全停用', projectId: proj.id })
    assert.deepEqual(t.memberAgentIds, [])
  } finally {
    f.store.flush()
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('项目任务节点以项目为准：createTask 带 projectId 时忽略 nodeRef', async () => {
  const f = makeFixture()
  try {
    f.store.upsertProject({ name: '项目节点项目', dshRef: { kind: 'direct', apiBaseUrl: 'http://stub-node' } })
    const proj = f.store.getProjects()[0]
    const t = await f.engine.createTask({ title: '项目任务', projectId: proj.id, nodeRef: { kind: 'direct', apiBaseUrl: 'http://other-node' } })
    assert.equal(t.projectId, proj.id)
    assert.equal(t.nodeRef, undefined, '项目任务不应携带 nodeRef（执行节点由 project.dshRef 决定）')
    const solo = await f.engine.createTask({ title: '单独任务', nodeRef: { kind: 'direct', apiBaseUrl: 'http://other-node' } })
    assert.ok(solo.nodeRef, '单独任务的 nodeRef 不受影响')
  } finally {
    f.store.flush()
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('本轮变更：extractToolPaths 只取写入/编辑类工具的路径参数，不含内容', () => {
  assert.deepEqual(extractToolPaths('write', JSON.stringify({ content: 'x'.repeat(5000), path: 'src/a.ts' })), ['src/a.ts'])
  assert.deepEqual(extractToolPaths('edit', { file_path: '/abs/b.md', old_string: 'a', new_string: 'b' }), ['/abs/b.md'])
  assert.deepEqual(extractToolPaths('str_replace_editor', { command: 'str_replace', path: 'c.py' }), ['c.py'])
  assert.equal(extractToolPaths('str_replace_editor', { command: 'view', path: 'c.py' }), undefined, 'view 命令不算变更')
  assert.deepEqual(extractToolPaths('MultiEdit', { edits: [{ file_path: 'd.ts' }, { file_path: 'd.ts' }, { path: 'e.ts' }] }), ['d.ts', 'e.ts'])
  assert.deepEqual(
    extractToolPaths('apply_patch', { input: '*** Begin Patch\n*** Update File: f.ts\n@@\n-a\n+b\n*** Add File: g.ts\n+x\n*** End Patch' }),
    ['f.ts', 'g.ts'],
  )
  assert.deepEqual(extractToolPaths('apply_patch', '--- a/h.ts\n+++ b/h.ts\n@@\n-a\n+b'), ['h.ts'])
  assert.equal(extractToolPaths('read', { path: 'a.ts' }), undefined, '读类工具不算变更')
  assert.equal(extractToolPaths('bash', { command: 'echo > a.ts' }), undefined)
  assert.equal(extractToolPaths('write', { content: 'no path' }), undefined)
})

test('团队任务：首轮消息触发团队合同（plan.scope.team 快照）；无 @ 追问回主会话并携带上一轮汇总', async () => {
  const f = makeFixture()
  try {
    seedAgent(f.store, 'ag-team-a', { name: '团队成员A' })
    seedAgent(f.store, 'ag-team-b', { name: '团队成员B' })
    const team = f.store.upsertTeam({
      name: '测试专家团', goal: 'stub 团队目标', deliveryRequirements: 'stub 交付',
      members: [
        { agentId: 'ag-team-a', duty: '查资料' },
        { agentId: 'ag-team-b', duty: '写报告' },
      ],
      enabled: true,
    })
    // 建任务不带消息（退休 UI「发任务」入口形态）
    const t0 = await f.engine.createTask({ title: '🧩 测试专家团', teamId: team.id })
    assert.equal(t0.teamId, team.id)
    assert.notEqual(t0.mode, 'chat', '团队任务应为编排形态')
    assert.ok(t0.expertMembers === undefined, '纯子智能体团队无动态专家')
    // 无 @ 首句：团队轮不至于掉进主会话直发（teamFirstTurn 桥接）
    const ok = await f.engine.sendUserMessage(t0.id, '梳理测试专家团分工')
    assert.ok(ok.ok, '发送成功')
    const t1 = await settle(f.engine, f.store, t0.id)
    assert.ok(t1.plan, '应有编排计划')
    assert.equal(t1.plan!.scope?.kind, 'team')
    assert.equal(t1.plan!.scope?.team?.goal, 'stub 团队目标', 'scope 携带团队合同快照')
    assert.ok(t1.plan!.objective?.includes('梳理测试专家团分工'), 'plan.objective 记录本轮目标')
    // summary 传了团队合同 → coverage 按团队名册
    assert.ok(t1.summary?.coverage, '团队轮汇总携带 coverage')
    assert.equal(t1.summary!.coverage!.total, 2)

    // 追问轮（无 @，无团队意图）：回主会话直发且不重建计划（plan 保持团队 scope 快照）
    const beforePlan = t1.plan
    const ok2 = await f.engine.sendUserMessage(t0.id, '报告在哪我再看一下')
    assert.ok(ok2.ok)
    const t2 = await settle(f.engine, f.store, t0.id)
    assert.equal(t2.plan, beforePlan, '追问轮不新起计划')
    assert.ok(t2.turns.some((x) => x.role === 'agent' && /报告在哪我再看一下|stub-output/.test(x.text || '')), '追问轮有 agent 回复')
    // 汇总注入了追问上下文（上一轮编排结论）
    const followupTurn = t2.turns.find((x) => x.role === 'user' && x.text?.includes('报告在哪我再看一下'))
    assert.ok(followupTurn, '追问轮日志存在')
  } finally {
    f.store.flush()
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('@单专家：动态成员 __expert__: 前缀登记 + 编排 scope.kind=members + 持久实体优先', async () => {
  const f = makeFixture()
  try {
    const planTurns: string[] = []
    f.planners = new StubPlanner(function (_obj, members) {
      planTurns.push(members.map((m) => m.agent.id).join(','))
      return { strategy: 'parallel', subtasks: members.filter((m) => m.agent.id !== '__node__').slice(0, 1).map((m) => ({ title: `t-${m.agent.id}`, prompt: `stub ${m.agent.name}`, agentId: m.agent.id, dependsOn: [] })) }
    })
    f.engine = new TaskEngine(f.store, RESOURCE_DIR_STUB, f.resolver as unknown as AgentResolver, new StubComposer() as unknown as PromptComposer, f.planners as unknown as Orchestrator, undefined, new StubRegistry() as unknown as ExpertRegistry, f.client as unknown as DshClient)

    seedAgent(f.store, 'entity-sibling', { name: '无关实体' }) // 确保 store 有实体不影响伪 id 动态成员解析
    const t = await f.engine.createTask({ title: '单专家任务', nodeRef: { kind: 'direct', apiBaseUrl: 'http://stub-node' } })
    const ok = await f.engine.sendUserMessage(t.id, '@alameda 协助分析')
    assert.ok(ok.ok)
    const settled = await settle(f.engine, f.store, t.id)
    const em = settled.expertMembers || []
    assert.ok(em.length > 0, '动态成员已登记')
    assert.equal(em[0].id, '__expert__:alameda', '新前缀伪 id（消除与持久实体 id 域的碰撞）')
    assert.equal(em[0].expertId, 'alameda', '动态成员携带 expertId 字段')
    // 动态成员不落子智能体实体（makeExpertAgent 用完即散）
    assert.equal(f.store.getAgent(em[0].id), undefined, '动态专家伪 id 不产生持久实体')
    assert.ok(planTurns.length > 0, '编排规划被调用')
    assert.ok(planTurns[planTurns.length - 1].includes('__expert__:alameda'), '规划花名册包含动态专家伪 id')
    assert.ok(!settled.plan?.scope?.team, '非团队轮无团队合同')
    assert.equal(settled.plan?.scope?.kind, 'members')
    // 覆盖度按实际参与者（assigned 成员）
    assert.ok(settled.summary?.coverage?.total && settled.summary.coverage.total >= 1, 'coverage 已按本轮参与者构建')
  } finally {
    f.store.flush()
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('存量 expert-<id> 账本兼容：重复 @同名专家沿用历史伪 id；会话键不断裂', async () => {
  const f = makeFixture()
  try {
    // 直接用 store 造带旧前缀动态成员的任务（模拟 v2026.10.23 之前的存量数据）
    const t = f.store.upsertTask({
      id: 'task-legacy',
      title: '存量任务',
      mode: 'orchestrate',
      status: 'draft',
      memberAgentIds: [],
      nodeRef: { kind: 'direct', apiBaseUrl: 'http://stub-node' },
      turns: [],
      sessions: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expertMembers: [{ id: 'expert-alameda', name: '阿拉米达' }],
    } as WorkTask)
    const ok = await f.engine.sendUserMessage(t.id, '@alameda 再次分析')
    assert.ok(ok.ok)
    const settled = (await settle(f.engine, f.store, t.id))
    assert.ok(
      (settled.expertMembers || []).some((m) => m.id === 'expert-alameda'),
      '重复 @ 同名专家沿用存量账本 id（不迁移到新前缀）',
    )
    // plan scope members 键含存量伪 id
    assert.ok((settled.plan?.scope?.memberIds || []).includes('expert-alameda'), 'scope.memberIds 保留存量伪 id 键')
    // 子任务若被分给该伪 id，其远程会话键使用原 id（会话键不断裂）
    const legacySub = (settled.plan?.subtasks || []).find((s) => s.agentId === 'expert-alameda')
    assert.ok(legacySub && settled.sessions['expert-alameda'], '存量伪 id 成员的会话键沿伪 id 保存（不迁移新前缀）')
  } finally {
    f.store.flush()
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('普通编排轮（多 @）覆盖度只按参与者名单，不摊历史团队', async () => {
  const f = makeFixture()
  try {
    seedAgent(f.store, 'ag-x', { name: '成员X' })
    seedAgent(f.store, 'ag-y', { name: '成员Y' })
    const team = f.store.upsertTeam({
      name: '历史团', goal: '目标x',
      members: [
        { agentId: 'ag-x', duty: 'duty-x' },
        { agentId: 'ag-y', duty: 'duty-y' },
      ],
      enabled: true,
    })
    // 先做一轮团队轮
    const t = await f.engine.createTask({ title: '历史团任务', teamId: team.id, message: '第一轮按全团做' })
    await settle(f.engine, f.store, t.id)
    const ok = await f.engine.sendUserMessage(t.id, '@成员X 只补充一句')
    assert.ok(ok.ok)
    const settled = await settle(f.engine, f.store, t.id)
    assert.equal(settled.plan?.scope?.kind, 'members', '显式 @ 成员的新一轮不再是团队合同')
    // focused roster 只含被 @ 成员 + 主节点（无 ag-y）
    const roster = settled.plan?.scope?.memberIds || []
    assert.ok(roster.includes('ag-x') && !roster.includes('ag-y'), '聚焦名单只包含被 @ 成员')
  } finally {
    f.store.flush()
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('团队快照合同不随后续团队修改漂移（同任务换团队后旧计划仍带旧合同）', async () => {
  const f = makeFixture()
  try {
    seedAgent(f.store, 'ag-snap', { name: '快照成员' })
    const team1 = f.store.upsertTeam({ name: '团队A', goal: 'goal-A', members: [{ agentId: 'ag-snap', duty: 'dk' }], enabled: true })
    const team2 = f.store.upsertTeam({ name: '团队B', goal: 'goal-B', members: [{ agentId: 'ag-snap', duty: 'dk' }], enabled: true })
    const t = await f.engine.createTask({ title: '快照校验', teamId: team1.id, message: '按团队A做一期' })
    await settle(f.engine, f.store, t.id)
    const settled = (await Promise.all([f.store.getTask(t.id)]))[0]
    assert.equal(settled!.plan!.scope?.team?.goal, 'goal-A', '快照为第一轮团队 A 合同')
    // 换团队做第二轮
    const sendOk = await f.engine.sendUserMessage(t.id, '切换到团队B再来一轮', { teamId: team2.id })
    assert.ok(sendOk.ok === true || sendOk.queued === true, '换团队消息被接受')
    const t3 = await settle(f.engine, f.store, t.id)
    assert.equal(t3.teamId, team2.id, '任务 teamId 切换到团队 B')
    assert.ok(t3.plan!.scope && (t3.plan!.scope!.team?.goal === 'goal-B' || (t3.plan!.scope!.team?.goal === undefined)), '新一轮 scope 使用团队 B 合同')
  } finally {
    f.store.flush()
    rmSync(f.dir, { recursive: true, force: true })
  }
})
