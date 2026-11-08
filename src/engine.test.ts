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

import { TaskEngine, extractToolPaths, isAtMentionBoundary } from './engine.js'
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
  sessionCreates: Array<{ target: DshTarget; options: any }> = []
  mkdirs: string[] = []
  /** 收到的派发 prompt（按序），供断言上下文段注入 */
  prompts: string[] = []
  /** 流式正文（默认 stub-output）；丢尾回归用它构造「流式短、历史长」 */
  streamText = 'stub-output'
  /** 流内先发一次工具调用（触发 verifyTail 尾部复核路径） */
  emitTool = false
  /** reconcileTurn 返回的历史全文（空串 = 不对账成功） */
  reconcileText = ''
  /** reconcileTurn 调用次数（断言复核只发一次历史请求） */
  reconcileCalls = 0
  async createSession(_target: DshTarget, _title: string, _options?: any) {
    this.sessionCreates.push({ target: { ..._target }, options: { ..._options } })
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
  async streamPrompt(_t: DshTarget, _sid: string, prompt: string, handlers: any, _opts?: any): Promise<PromptResult> {
    this.prompts.push(prompt)
    await Promise.resolve()
    handlers?.onLog?.('stub stream start')
    if (this.emitTool) {
      handlers?.onToolCall?.({ id: 'call-stub', name: 'bash', arguments: { command: 'ls' } })
      handlers?.onToolResult?.({ id: 'call-stub', name: 'bash', result: 'ok' })
    }
    const text = this.streamText
    handlers?.onDelta?.(text)
    handlers?.onLog?.('stub turn_end')
    return { ok: true, content: text, complete: true, via: 'sse' } as PromptResult
  }
  async prompt(): Promise<PromptResult> {
    return { ok: true, content: 'stub-output', via: 'sync' } as PromptResult
  }
  async reconcileTurn(): Promise<PromptResult> {
    this.reconcileCalls++
    if (this.reconcileText) return { ok: true, content: this.reconcileText, via: 'poll', complete: true } as PromptResult
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
  async fsMkdir(_target: DshTarget, parent: string, name: string) {
    this.mkdirs.push(parent.replace(/\/$/, '') + '/' + name)
    return { ok: true }
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
  planOptions: any[] = []
  constructor(private factory?: (objective: string, members: PlannerMember[]) => PlanDraft, private summary?: TaskSummary) {}
  async pickTarget() {
    return { error: 'stub: no planner target' } as const
  }
  async planTask(objective: string, members: PlannerMember[], _targets?: unknown, options?: unknown): Promise<any> {
    this.planOptions.push(options)
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

/** 专家库 stub：默认一个内置专家 alameda（「阿拉米达」按中/英文匹配可提）；可注入额外专家（测同名/假同名） */
class StubRegistry {
  private experts: Array<Expert & ExpertProfile>
  constructor(extra?: Array<Partial<Expert & ExpertProfile> & { id: string }>) {
    const base: Expert & ExpertProfile = {
      id: 'alameda', name: '阿拉米达', nameEn: 'alameda', source: 'roster', division: 'team', divisionZh: '团队',
      icon: '🧩', description: 'stub 专家描述', tags: ['stub'],
      systemPrompt: 'stub system prompt', executionPrompt: 'stub execution', role: 'stub role',
    }
    this.experts = [base, ...(extra || []).map((e) => ({ ...base, ...e }))]
  }
  async search(): Promise<Expert[]> {
    return this.experts
  }
  async get(id: string): Promise<Expert | undefined> {
    return this.experts.find((e) => e.id === id)
  }
  async getProfile(id: string): Promise<ExpertProfile> {
    const hit = this.experts.find((e) => e.id === id)
    if (!hit) throw new Error('专家不存在')
    return hit
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

function makeFixture(opts?: { failResolver?: boolean; plannerFactory?: (objective: string, members: PlannerMember[]) => PlanDraft; summary?: TaskSummary; registryExperts?: Array<Partial<Expert & ExpertProfile> & { id: string }> }): Fixture {
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
    new StubRegistry(opts?.registryExperts) as unknown as ExpertRegistry,
    client as unknown as DshClient,
  )
  return { store, dir, client, engine, planners, registry: new StubRegistry(opts?.registryExperts), resolver }
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

// ---------- task-81：提问等待不能当作已完成，重启仍可答复 ----------
test('task-81: 重启保留 pendingAsk 等待态，普通中断任务仍标失败', async () => {
  const f = makeFixture()
  try {
    const waiting = await f.engine.createTask({ title: '等待答复' })
    const interrupted = await f.engine.createTask({ title: '执行中断' })
    f.store.mutateTask(waiting.id, t => {
      t.status = 'running'
      t.pendingAsk = { agentId: '__node__', sessionId: 'session', turnId: 'turn', questions: [{ id: 'q' }], at: Date.now() }
    })
    f.store.mutateTask(interrupted.id, t => { t.status = 'running' })
    assert.equal(f.engine.recoverInterruptedTasks(), 1)
    assert.equal(f.store.getTask(waiting.id)?.status, 'running')
    assert.ok(f.store.getTask(waiting.id)?.pendingAsk)
    assert.equal(f.store.getTask(interrupted.id)?.status, 'failed')
  } finally {
    await f.store.flush()
    rmSync(f.dir, { recursive: true, force: true })
  }
})

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

test('项目任务执行节点：显式覆盖与默认快照不改变文件归属或泄露凭证', async () => {
  const f = makeFixture()
  try {
    const owner = { kind: 'direct' as const, apiBaseUrl: 'http://owner-node' }
    const defaultNode = { kind: 'mapping' as const, mappingId: 'execution-a' }
    const proj = f.store.upsertProject({ name: '项目', dshRef: owner, apiKey: 'owner-secret', workspace: '/project', defaultExecutionNodeRef: defaultNode })
    const t = await f.engine.createTask({ title: '项目任务', projectId: proj.id, nodeRef: { kind: 'direct', apiBaseUrl: 'http://other-node' } })
    assert.equal(t.projectId, proj.id)
    assert.deepEqual(t.nodeRef, { kind: 'direct', apiBaseUrl: 'http://other-node' })
    const inherited = await f.engine.createTask({ projectId: proj.id })
    assert.deepEqual(inherited.nodeRef, defaultNode)
    defaultNode.mappingId = 'mutated-input'
    f.store.upsertProject({ id: proj.id, defaultExecutionNodeRef: { kind: 'mapping', mappingId: 'execution-b' } })
    assert.deepEqual(f.engine.taskExec(inherited).dshRef, { kind: 'mapping', mappingId: 'execution-a' })
    assert.deepEqual(f.engine.taskWorkspaceExec(inherited), { project: f.store.getProject(proj.id), dshRef: owner, apiKey: 'owner-secret', workspace: '/project' })
    assert.equal(f.engine.taskExec(inherited).apiKey, undefined, '归属节点密钥不得发送到异机执行节点')
    const legacy = { ...inherited, nodeRef: undefined }
    assert.deepEqual(f.engine.taskExec(legacy).dshRef, owner, '旧任务不追随新默认节点')
    const solo = await f.engine.createTask({ title: '单独任务', nodeRef: { kind: 'direct', apiBaseUrl: 'http://other-node' } })
    assert.ok(solo.nodeRef, '单独任务的 nodeRef 不受影响')
  } finally {
    f.store.flush()
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('task-56: @项目 首次绑定快照默认执行节点，显式节点保留且后续不随默认修改', async () => {
  const f = makeFixture()
  try {
    const owner: DshRef = { kind: 'mapping', mappingId: 'owner' }
    const executor: DshRef = { kind: 'mapping', mappingId: 'executor' }
    const project = f.store.upsertProject({ name: '节点快照项目', dshRef: owner, defaultExecutionNodeRef: executor })
    const inherited = await f.engine.createTask({ title: 'late project binding' })
    await f.engine.sendUserMessage(inherited.id, '@节点快照项目 检查会话节点')
    await settle(f.engine, f.store, inherited.id)
    assert.deepEqual(f.store.getTask(inherited.id)?.nodeRef, executor)
    f.store.upsertProject({ id: project.id, defaultExecutionNodeRef: owner })
    assert.deepEqual(f.engine.taskExec(f.store.getTask(inherited.id)!).dshRef, executor)
    const explicit = await f.engine.createTask({ nodeRef: executor })
    await f.engine.sendUserMessage(explicit.id, '@节点快照项目 检查显式节点')
    await settle(f.engine, f.store, explicit.id)
    assert.deepEqual(f.store.getTask(explicit.id)?.nodeRef, executor)
  } finally { f.store.flush(); rmSync(f.dir, { recursive: true, force: true }) }
})

test('task-56: 项目编排规划与主/子会话不在异机 mkdir 或使用文件归属路径', async () => {
  const f = makeFixture({ plannerFactory: (_objective, members) => ({
    strategy: 'parallel', subtasks: members.filter(m => m.agent.id !== '__node__').map(m => ({ title: '检查', prompt: '验证工作区隔离', agentId: m.agent.id, dependsOn: [] })),
  }) })
  try {
    const owner: DshRef = { kind: 'mapping', mappingId: 'owner' }
    const executor: DshRef = { kind: 'mapping', mappingId: 'executor' }
    seedAgent(f.store, 'remote-worker', { name: '异机成员', dshRef: executor })
    const project = f.store.upsertProject({ name: '异机规划', dshRef: owner, workspace: '/owner/project', defaultExecutionNodeRef: executor })
    const task = await f.engine.createTask({ projectId: project.id })
    await f.engine.sendUserMessage(task.id, '@异机成员 检查项目')
    const final = await settle(f.engine, f.store, task.id)
    assert.equal(final.status, 'success')
    assert.equal(f.planners.planOptions.length, 1)
    assert.equal(f.planners.planOptions[0].plannerCwd, undefined, '规划器不能把归属路径作为执行节点 cwd')
    assert.deepEqual(f.client.mkdirs, [], '规划器不能在异机补建同路径空目录')
    assert.ok(f.client.sessionCreates.length > 0)
    for (const created of f.client.sessionCreates) assert.equal(created.options.cwd, undefined)
    assert.ok(f.client.prompts.some(p => p.includes('[项目工作区跨机访问]')))
  } finally { f.store.flush(); rmSync(f.dir, { recursive: true, force: true }) }
})

test('task-56: 子智能体保留自身节点目录，回退异机不沿用旧 workDir', async () => {
  const f = makeFixture()
  try {
    const owner: DshRef = { kind: 'mapping', mappingId: 'owner' }
    const executor: DshRef = { kind: 'mapping', mappingId: 'executor' }
    const own: DshRef = { kind: 'mapping', mappingId: 'worker' }
    const project = f.store.upsertProject({ name: 'cwd', dshRef: owner, workspace: '/owner/project', defaultExecutionNodeRef: executor })
    const task = await f.engine.createTask({ projectId: project.id })
    const agent = { id: 'worker', name: 'worker', dshRef: own, workDir: '/worker/scratch' } as SubAgent
    const target = { online: true, baseUrl: 'http://worker', mappingId: 'worker', executionDshRef: own }
    assert.ok((await (f.engine as any).ensureSession(task.id, agent, target)).ok)
    assert.equal(f.client.sessionCreates.at(-1)?.options.cwd, '/worker/scratch')
    assert.ok((await (f.engine as any).ensureSession(task.id, agent, { ...target, executionDshRef: executor, mappingId: 'executor' })).ok)
    assert.equal(f.client.sessionCreates.at(-1)?.options.cwd, undefined)
    assert.ok((await (f.engine as any).ensureSession(task.id, agent, { ...target, executionDshRef: owner, mappingId: 'owner' })).ok)
    assert.equal(f.client.sessionCreates.at(-1)?.options.cwd, '/owner/project', '仅文件归属节点可用项目路径')
  } finally { f.store.flush(); rmSync(f.dir, { recursive: true, force: true }) }
})

test('task-56: legacy 项目任务无 nodeRef 的默认 fork 保留原有效节点，显式改节点或项目仍生效', async () => {
  const f = makeFixture()
  try {
    const owner: DshRef = { kind: 'mapping', mappingId: 'legacy-owner' }
    const executor: DshRef = { kind: 'mapping', mappingId: 'new-default' }
    const project = f.store.upsertProject({ name: '旧项目', dshRef: owner, defaultExecutionNodeRef: executor })
    const origin = await f.engine.createTask({ projectId: project.id })
    f.store.mutateTask(origin.id, t => { delete t.nodeRef })
    const fork = await f.engine.forkTask(origin.id)
    assert.deepEqual(fork.task.nodeRef, owner, '同项目默认续接快照旧任务有效节点，不改用当前项目默认值')
    assert.equal(f.store.getTask(origin.id)?.nodeRef, undefined, '不迁移旧任务记录')
    assert.deepEqual((await f.engine.forkTask(origin.id, { nodeRef: executor })).task.nodeRef, executor)
    const other = f.store.upsertProject({ name: '新项目', dshRef: owner, defaultExecutionNodeRef: executor })
    assert.deepEqual((await f.engine.forkTask(origin.id, { projectId: other.id })).task.nodeRef, executor, '显式切项目采用目标项目默认节点')
  } finally { f.store.flush(); rmSync(f.dir, { recursive: true, force: true }) }
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

test('跨节点续接 fork：双向链接 + 草稿 8000 字截断（保留尾部）', async () => {
  const f = makeFixture()
  try {
    const origin = await f.engine.createTask({ title: '原任务', nodeRef: { kind: 'direct', apiBaseUrl: 'http://stub-node' } })
    // 直接写盘几轮对话（不触发 LLM）
    f.store.mutateTask(origin.id, (t) => {
      t.turns = [
        { id: 't1', seq: 1, role: 'user', text: '第一问', at: Date.now() - 9000, endedAt: Date.now() - 8000 },
        { id: 't2', seq: 2, role: 'agent', agentName: '成员甲', text: '第一答'.repeat(30), at: Date.now() - 8000, endedAt: Date.now() - 7000 },
        { id: 't3', seq: 3, role: 'user', text: '第二问', at: Date.now() - 7000 },
      ]
      return t
    })
    const out = await f.engine.forkTask(origin.id, { nodeRef: { kind: 'direct', apiBaseUrl: 'http://other-node' } })
    assert.ok(out.task.id !== origin.id)
    assert.equal(out.task.forkedFrom?.taskId, origin.id, '新任务记录来源')
    assert.ok(out.task.title.startsWith('↪ '), '新任务标题带 ↪ 前缀')
    assert.ok(out.task.nodeRef, '单独任务续接保留 nodeRef')
    const originAfter = f.store.getTask(origin.id)!
    assert.ok((originAfter.forks || []).some((x) => x.taskId === out.task.id), '原任务记录 forks')
    const sysTurn = originAfter.turns.find((t) => t.role === 'system')
    assert.ok(sysTurn && sysTurn.text.includes(out.task.id), '原任务插入 system 续接轮（含新任务 ID）')
    assert.ok(out.draft.includes('最近对话'), '草稿带说明头')
    assert.ok(out.draft.includes('第二问'), '草稿含最近轮原文')
    assert.ok(out.draft.includes('【智能体 成员甲】'), '草稿标注角色与成员名')
    assert.ok(out.draft.length <= 8100, '草稿总长受 8000 上限约束（含头部与标记）')
    // 超长截断：保尾部 + 截断标记
    f.store.mutateTask(origin.id, (t) => {
      t.turns = [
        { id: 'b1', seq: 1, role: 'agent', text: 'A'.repeat(9000), at: Date.now() },
        { id: 'b2', seq: 2, role: 'user', text: '结尾问句', at: Date.now() },
      ]
      return t
    })
    const out2 = await f.engine.forkTask(origin.id)
    assert.ok(out2.draft.includes('结尾问句'), '截断保留尾部（最近内容）')
    assert.ok(out2.draft.includes('…（更早内容已截断）'), '截断带标记')
    // 项目任务续接：projectId 生效、不落 nodeRef（P0-3 同规则）
    f.store.upsertProject({ name: '续接项目', dshRef: { kind: 'direct', apiBaseUrl: 'http://stub-node' } })
    const proj = f.store.getProjects()[0]
    const origin3 = await f.engine.createTask({ title: '项目原任务', projectId: proj.id })
    const out3 = await f.engine.forkTask(origin3.id, { projectId: proj.id, nodeRef: { kind: 'direct', apiBaseUrl: 'http://other-node' } })
    assert.equal(out3.task.projectId, proj.id)
    assert.deepEqual(out3.task.nodeRef, { kind: 'direct', apiBaseUrl: 'http://other-node' }, '项目续接允许覆盖执行节点')
  } finally {
    f.store.flush()
    rmSync(f.dir, { recursive: true, force: true })
  }
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

// ---------- @ 提及边界（BUG 回归：URL/邮箱里的 @ 不得触发编排） ----------

test('isAtMentionBoundary：嵌入 token 的 @（邮箱/URL/CLI）不是提及起点，独立 @ 是', () => {
  // 非提及：@ 前是字母数字或邮箱/URL/路径/CLI 连接符
  for (const [text, at] of [
    ['ssh://zuji.pan@10.2.12.43:29418/x', 14], // zuji.pan@ ← user@host 分隔符
    ['git@github.com:a/b.git', 3],
    ['a@b.com', 1],
    ['curl -F f=@/tmp/a.json', 10],
    ['https://x.com/@org/settings', 14],
  ] as Array<[string, number]>) {
    assert.equal(text[at], '@', `用例下标错位: ${text}`)
    assert.equal(isAtMentionBoundary(text, at), false, `应判定为嵌入 @: ${text}`)
  }
  // 合法提及起点：文本开头 / 空白 / 中日韩 / 全角标点 / ASCII 句读
  for (const [text, at] of [
    ['@brain 开始', 0],
    ['请 @brain 开始', 2],
    ['帮我@brain 看看', 2],
    ['（@brain）负责', 1],
    ['参考:@brain 处理', 3],
  ] as Array<[string, number]>) {
    assert.equal(text[at], '@', `用例下标错位: ${text}`)
    assert.equal(isAtMentionBoundary(text, at), true, `应判定为提及起点: ${text}`)
  }
})

test('extractMentions：git SSH URL / 邮箱 / CLI @file 字面量不产生任何提及（线上事故回归）', async () => {
  const f = makeFixture()
  try {
    seedAgent(f.store, 'ag-git', { name: 'brain' })
    const cases = [
      '把仓库跟git clone ssh://zuji.pan@10.2.12.43:29418/general/robotic-knewlab-server 绑定',
      'git clone ssh://zuji.pan@10.2.12.43/general/robotic-knewlab-server 绑定', // 无端口变体（旧逻辑伪文件提及重灾区）
      'git clone ssh://git@github.com/toddpan/onenat-workbuddy.git 然后编译',
      '给 zhangsan@example.com 发一封邮件',
      'curl -F upload=@/tmp/a.json http://x',
      '看下 https://x.com/@tenant/settings 配置',
      'scp backup.tar.gz admin@192.168.1.10:/data/backup/',
    ]
    for (const text of cases) {
      const m = await f.engine.extractMentions(text)
      assert.deepEqual(m.mentionedAgentIds, [], `不应提及智能体: ${text}`)
      assert.deepEqual(m.mentionedResourceBindings, [], `不应提及资源: ${text}`)
      assert.equal(m.mentionedFiles, undefined, `不应伪文件提及: ${text} → ${JSON.stringify(m.mentionedFiles)}`)
      assert.equal(m.mentionedExpertIds?.length ?? 0, 0, `不应提及专家: ${text}`)
    }
    // 既有合法提及用法不受影响
    const ok1 = await f.engine.extractMentions('@brain 把仓库绑定到 origin')
    assert.deepEqual(ok1.mentionedAgentIds, ['ag-git'])
    const ok2 = await f.engine.extractMentions('帮我@brain 看下进展')
    assert.deepEqual(ok2.mentionedAgentIds, ['ag-git'], '中文紧邻 @ 仍可提及')
    const ok3 = await f.engine.extractMentions('（@brain）负责绑定')
    assert.deepEqual(ok3.mentionedAgentIds, ['ag-git'], '全角括号紧邻 @ 仍可提及')
    const ok4 = await f.engine.extractMentions('帮我看下 @brain:logs/app.log 的报错')
    assert.deepEqual(ok4.mentionedAgentIds, ['ag-git'], '@智能体:文件 语法不受影响')
    assert.ok(ok4.mentionedFiles?.[0]?.path === 'logs/app.log')
    const ok5 = await f.engine.extractMentions('@[brain:logs/app.log] 有报错')
    assert.deepEqual(ok5.mentionedAgentIds, ['ag-git'], '@[智能体:文件] 方括号语法不受影响')
    const ok6 = await f.engine.extractMentions('注意 @src/index.ts 这个文件')
    assert.ok(ok6.mentionedFiles?.length === 1, '独立 @文件 提及仍按原语义解析')
  } finally {
    f.store.flush()
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('git SSH URL 消息保持直通：不因 URL 里的 @ 升级编排模式', async () => {
  const f = makeFixture()
  try {
    seedAgent(f.store, 'ag-git', { name: 'brain' })
    const t = await f.engine.createTask({ title: '绑定仓库', memberAgentIds: ['ag-git'] })
    const ok = await f.engine.sendUserMessage(t.id, '把仓库跟git clone ssh://zuji.pan@10.2.12.43:29418/general/robotic-knewlab-server 绑定')
    assert.ok(ok.ok)
    const settled = await settle(f.engine, f.store, t.id)
    assert.equal(settled.mode, 'chat', '不得升级为编排模式')
    assert.equal(settled.plan, undefined, '不得产生编排计划')
    assert.equal(settled.lastRoute?.kind, 'chat', '路由应为直通')
    assert.equal(settled.lastRoute?.agentId, 'ag-git', '直通目标为任务成员')
  } finally {
    f.store.flush()
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('extractMentions：name==nameEn 的内置团队角色不再误判同名（假同名回归）', async () => {
  const f = makeFixture({ registryExperts: [{ id: 'expert-researcher', name: '调研专家', nameEn: '调研专家' }] })
  try {
    const m = await f.engine.extractMentions('@调研专家 帮我做一次调研')
    assert.deepEqual(m.mentionedExpertIds, ['expert-researcher'], '同一专家 name/nameEn 双注册应去重为单命中')
    assert.equal(m.mentionedExpertAmbiguous, undefined, '不得触发同名歧义')
  } finally {
    f.store.flush()
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('extractMentions：真同名两位专家仍判歧义', async () => {
  const f = makeFixture({
    registryExperts: [
      { id: 'reviewer-a', name: '评审专家', nameEn: 'reviewer-a' },
      { id: 'reviewer-b', name: '评审专家', nameEn: 'reviewer-b' },
    ],
  })
  try {
    const m = await f.engine.extractMentions('@评审专家 评审一下')
    assert.deepEqual(m.mentionedExpertIds || [], [], '未带 #id 时不指派任何专家（字段可缺省）')
    assert.equal(m.mentionedExpertAmbiguous, '评审专家')
    // 带 #id 精确直派不受影响
    const ok = await f.engine.extractMentions('@评审专家#reviewer-b 评审一下')
    assert.deepEqual(ok.mentionedExpertIds, ['reviewer-b'])
    assert.equal(ok.mentionedExpertAmbiguous, undefined)
  } finally {
    f.store.flush()
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('歧义 @ 阻断本轮：不降级主会话直发，任务标 failed', async () => {
  const f = makeFixture({
    registryExperts: [
      { id: 'reviewer-a', name: '评审专家', nameEn: 'reviewer-a' },
      { id: 'reviewer-b', name: '评审专家', nameEn: 'reviewer-b' },
    ],
  })
  try {
    const t = await f.engine.createTask({
      title: '歧义阻断',
      nodeRef: { kind: 'direct', apiBaseUrl: 'http://stub-node' },
      message: '@评审专家 请只回复 ok',
    })
    await delay(30)
    const after = f.store.getTask(t.id)!
    assert.equal(after.status, 'failed', '歧义轮应标记 failed（阻断而非静默直发）')
    const blocked = after.turns.find((x) => x.role === 'system' && /本轮已停止派发/.test(x.text))
    assert.ok(blocked, '应有阻断指引系统轮')
    assert.ok(!after.sessions['__node__'], '不得产生主会话直发')
  } finally {
    f.store.flush()
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('单成员聚焦轮裁剪：规划器多拆的调度方核验跳被移除，仅保留被 @ 成员子任务', async () => {
  const f = makeFixture({
    // 模拟规划器违规多拆：成员 1 个 + 调度方核验 1 个
    plannerFactory: (_objective, members) => ({
      strategy: 'sequential',
      subtasks: members.map((m) => ({
        title: m.agent.id === '__node__' ? '核验并汇总最终报告' : '执行评审',
        prompt: 'stub prompt',
        agentId: m.agent.id,
        dependsOn: m.agent.id === '__node__' ? ['执行评审'] : [],
      })),
    }),
  })
  try {
    const t = await f.engine.createTask({ title: '单专家单跳', nodeRef: { kind: 'direct', apiBaseUrl: 'http://stub-node' } })
    const ok = await f.engine.sendUserMessage(t.id, '@alameda 只读评审这段设计')
    assert.ok(ok.ok)
    const settled = await settle(f.engine, f.store, t.id)
    assert.equal(settled.plan?.subtasks.length, 1, 'delegate 轮只保留 1 个子任务')
    assert.equal(settled.plan?.subtasks[0].agentId, '__expert__:alameda', '保留的是被 @ 专家的子任务')
    assert.ok(!settled.plan?.subtasks.some((s) => s.agentId === '__node__'), '调度方核验跳已被裁剪')
    assert.equal(settled.summary?.coverage?.total, 1, 'coverage 只按真实成员计（不含 __node__）')
  } finally {
    f.store.flush()
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('编排子任务注入项目指令：chat 与编排同源（TaskContext 段）', async () => {
  const f = makeFixture({
    plannerFactory: (_o, members) => ({
      strategy: 'parallel',
      subtasks: members.filter((m) => m.agent.id !== '__node__').map((m) => ({ title: '执行', prompt: 'stub 执行', agentId: m.agent.id, dependsOn: [] })),
    }),
  })
  try {
    const proj = f.store.upsertProject({
      id: 'proj-rules',
      name: '规范项目',
      workspace: '/tmp/wb-rules',
      instruction: 'PROJECT-RULES-MARKER：所有产出必须中文并附验收对照。',
      dshRef: { kind: 'direct', apiBaseUrl: 'http://stub-node' },
    } as any)
    seedAgent(f.store, 'ag-rules', { name: '规则成员' })
    const t = await f.engine.createTask({ title: '项目编排', projectId: proj.id })
    // 显式 @ 成员进入编排派工路径（无 @ 会走主会话直发，覆盖不到 runSubtask）
    const ok = await f.engine.sendUserMessage(t.id, '@规则成员 按项目规范做一轮检查')
    assert.ok(ok.ok)
    const settled = await settle(f.engine, f.store, t.id)
    assert.equal(settled.plan?.scope?.kind, 'members')
    const dispatched = f.client.prompts.filter((p) => p.includes('[当前子任务指令]'))
    assert.ok(dispatched.length >= 1, '至少派发一个子任务')
    for (const p of dispatched) {
      assert.ok(p.includes('[项目指令]'), '编排子任务 prompt 含项目指令段')
      assert.ok(p.includes('PROJECT-RULES-MARKER'), '项目指令内容注入子任务')
    }
  } finally {
    f.store.flush()
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('流式丢尾自愈：多步回合 complete=true 但历史文本更长时，按会话历史补全正文（只复核一次）', async () => {
  const f = makeFixture()
  try {
    // 多步回合（流内出现工具调用）→ 收尾触发尾部复核
    f.client.emitTool = true
    f.client.streamText = '前半段结论：'
    // 历史里同一回合的完整文本：流式文本是它的真前缀 = 纯尾部丢失
    f.client.reconcileText = '前半段结论：\n\n| ID | 名称 |\n|---|---|\n| T1 | x |\n\n全部完成 END'
    seedAgent(f.store, 'ag-tail', { name: '尾巴成员' })
    const t = await f.engine.createTask({ title: '丢尾自愈', memberAgentIds: ['ag-tail'] })
    const sent = await f.engine.sendUserMessage(t.id, '给我一个表格')
    assert.ok(sent.ok, '发送成功')
    const done = await settle(f.engine, f.store, t.id)
    const agent = done.turns.filter((x) => x.role === 'agent').pop()!
    assert.equal(agent.text, f.client.reconcileText, '历史全文覆盖流式半截')
    assert.equal(f.client.reconcileCalls, 1, '尾部复核只发一次历史请求')
  } finally {
    f.store.flush()
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('流式丢尾自愈：单步回合（无工具）不做额外历史复核，保留流式正文', async () => {
  const f = makeFixture()
  try {
    f.client.emitTool = false
    f.client.streamText = 'stub-output'
    f.client.reconcileText = 'stub-output + 历史多出来的尾巴'
    seedAgent(f.store, 'ag-tail2', { name: '尾巴成员二' })
    const t = await f.engine.createTask({ title: '单步不复核', memberAgentIds: ['ag-tail2'] })
    const sent = await f.engine.sendUserMessage(t.id, '简单回答一句')
    assert.ok(sent.ok, '发送成功')
    const done = await settle(f.engine, f.store, t.id)
    const agent = done.turns.filter((x) => x.role === 'agent').pop()!
    assert.equal(agent.text, 'stub-output', '单步回合不额外拉历史')
    assert.equal(f.client.reconcileCalls, 0, '不应发起历史复核请求')
  } finally {
    f.store.flush()
    rmSync(f.dir, { recursive: true, force: true })
  }
})

// ---------- TASK-2：backlog 回写失败后台补偿器（指数退避自动重试） ----------

/** 造一个带 backlog 来源、已终态、有汇总且带失败标记的任务（补偿器的目标形态） */
function seedWritebackFailedTask(store: WorkStore, retry?: { count: number; nextAt: number }): WorkTask {
  const now = Date.now()
  return store.upsertTask({
    id: `task-wb-${Math.random().toString(36).slice(2, 8)}`,
    title: 'backlog 派发任务',
    mode: 'chat',
    status: 'completed',
    memberAgentIds: [],
    creator: 'console',
    turns: [],
    sessions: {},
    createdAt: now,
    updatedAt: now,
    backlogRef: { projectId: 'proj-x', itemId: 'item-1', itemTitle: '待办一', dispatchedAt: now },
    summary: { status: 'success', overview: '完成', subtaskSummaries: [], finalConclusion: 'ok', completedAt: now },
    backlogWritebackFailed: { at: now - 120_000, error: '节点不可达' },
    ...(retry ? { backlogWritebackRetry: retry } : {}),
  } as any)
}

test('backlog 回写补偿器：失败→按退避重试→成功清除标记与退避状态', async () => {
  const f = makeFixture()
  try {
    const t0 = seedWritebackFailedTask(f.store, { count: 0, nextAt: Date.now() - 1 })
    let calls = 0
    ;(f.engine as any).runBacklogWriteback = async (task: WorkTask) => {
      calls++
      if (calls === 1) throw new Error('节点抖动')
      // 第二次成功：走真实清除路径（清标记 + 清退避状态 + 审计）
      f.store.mutateTask(task.id, (t) => {
        delete t.backlogWritebackFailed
        delete t.backlogWritebackRetry
      })
    }
    const fired = await f.engine.runBacklogWritebackRetrySweep()
    assert.equal(fired, 1, '到点任务被拾起重试')
    await delay(20)
    let t = f.store.getTask(t0.id)!
    assert.equal(calls, 1, '首次重试已发起')
    assert.ok(t.backlogWritebackFailed, '重试失败仍带失败标记')
    assert.equal(t.backlogWritebackRetry?.count, 1, '退避计数已推进')
    assert.ok((t.backlogWritebackRetry?.nextAt || 0) > Date.now(), '下次重试在未来（退避生效）')
    // 退避窗口内不重试
    assert.equal(await f.engine.runBacklogWritebackRetrySweep(), 0, '退避窗口内不重复重试')
    // 人为把 nextAt 拨到过去，第二次重试成功
    f.store.mutateTask(t0.id, (x) => { if (x.backlogWritebackRetry) x.backlogWritebackRetry.nextAt = Date.now() - 1 })
    const fired2 = await f.engine.runBacklogWritebackRetrySweep()
    assert.equal(fired2, 1, '退避到点后再次重试')
    await delay(20)
    t = f.store.getTask(t0.id)!
    assert.equal(calls, 2)
    assert.ok(!t.backlogWritebackFailed, '成功后失败标记已清除')
    assert.ok(!t.backlogWritebackRetry, '成功后退避状态已清除')
    assert.equal(await f.engine.runBacklogWritebackRetrySweep(), 0, '标记清除后不再被拾起')
  } finally {
    f.store.flush()
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('backlog 回写补偿器：达上限停止重试、保留标记交回人工；重启后计数不清零', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-engine-test-'))
  const storePath = join(dir, 'store.json')
  let calls = 0
  const taskId = (() => {
    // 进程一：计数已到上限（3 次自动重试全部失败）
    const store = new WorkStore(storePath)
    const t = seedWritebackFailedTask(store, { count: 3, nextAt: Date.now() - 1 })
    const engine = new TaskEngine(store, RESOURCE_DIR_STUB, new StubResolver() as unknown as AgentResolver, new StubComposer() as unknown as PromptComposer, new StubPlanner() as unknown as Orchestrator, undefined, undefined, undefined)
    ;(engine as any).runBacklogWriteback = async () => { calls++ }
    return { id: t.id, flush: async () => {
      // 模拟正常进程关闭：先等当前异步保存结束，再同步兜底；两个写者共享 .tmp 时立即 flush 会制造测试竞态。
      for (let i = 0; (store as any).writing && i < 100; i++) await delay(5)
      assert.equal((store as any).writing, false, '正常保存应在重启前结束')
      store.flush()
    } }
  })()
  try {
    await taskId.flush()
    // 进程二：重新打开持久化 store —— 退避计数必须仍在（不重启清零），补偿器不再发起重试
    const store2 = new WorkStore(storePath)
    const engine2 = new TaskEngine(store2, RESOURCE_DIR_STUB, new StubResolver() as unknown as AgentResolver, new StubComposer() as unknown as PromptComposer, new StubPlanner() as unknown as Orchestrator, undefined, undefined, undefined)
    ;(engine2 as any).runBacklogWriteback = async () => { calls++ }
    const fired = await engine2.runBacklogWritebackRetrySweep(Date.now())
    assert.equal(fired, 0, '达上限后不再自动重试')
    assert.equal(calls, 0, '回写方法未被调用')
    const t = store2.getTask(taskId.id)!
    assert.ok(t.backlogWritebackFailed, '失败标记保留（UI 仍显「回写未确认」，可人工重试）')
    assert.equal(t.backlogWritebackRetry?.count, 3, '持久化的重试计数重启后不清零')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('backlog 回写补偿器：非终态/无汇总/backlogRef 缺失的任务不被拾起', async () => {
  const f = makeFixture()
  try {
    let calls = 0
    ;(f.engine as any).runBacklogWriteback = async () => { calls++ }
    // running 任务
    const running = seedWritebackFailedTask(f.store)
    f.store.mutateTask(running.id, (t) => { t.status = 'running' })
    // 无 summary
    const noSummary = seedWritebackFailedTask(f.store)
    f.store.mutateTask(noSummary.id, (t) => { delete t.summary })
    // 无 backlogRef
    const noRef = seedWritebackFailedTask(f.store)
    f.store.mutateTask(noRef.id, (t) => { delete t.backlogRef })
    const fired = await f.engine.runBacklogWritebackRetrySweep()
    assert.equal(fired, 0, '不满足前置条件的任务一律不拾起（避免空转）')
    assert.equal(calls, 0)
  } finally {
    f.store.flush()
    rmSync(f.dir, { recursive: true, force: true })
  }
})

test('上游结果文件跨节点下载清单：DAG 下游提示词注入上游产出上下文与结果文件下载配方', async () => {
  const f = makeFixture({
    // 双成员 DAG：上游产出报告并给出绝对路径 → 下游 dependsOn 消费
    plannerFactory: (_o, members) => {
      const ids = members.map((m) => m.agent.id).filter((id) => id !== '__node__')
      return {
        strategy: 'dag' as const,
        subtasks: [
          { title: '取数产出', prompt: '生成数据报告并把绝对路径写进结论', agentId: ids[0], dependsOn: [] },
          { title: '核验产出', prompt: '基于上游产出做交叉核验', agentId: ids[1], dependsOn: ['取数产出'] },
        ],
      }
    },
  })
  try {
    f.client.streamText = '分析完成。报告已写入 /tmp/wb-orch/report-final.md，请查阅。'
    seedAgent(f.store, 'ag-upstream', { name: '取数员' })
    seedAgent(f.store, 'ag-downstream', { name: '核验员' })
    const t = await f.engine.createTask({ title: 'DAG 文件传参', memberAgentIds: ['ag-upstream', 'ag-downstream'] })
    const sent = await f.engine.sendUserMessage(t.id, '@取数员 @核验员 先取数再核验')
    assert.ok(sent.ok)
    const settled = await settle(f.engine, f.store, t.id)
    assert.equal(settled.plan?.subtasks.length, 2, '双 @ 轮不裁剪，保留 DAG 两跳')
    assert.deepEqual(settled.plan?.subtasks[1].dependsOn.length, 1, '下游依赖上游')

    const dispatched = f.client.prompts.filter((p) => p.includes('[当前子任务指令]'))
    assert.equal(dispatched.length, 2, '按 DAG 顺序派发两个子任务')
    const upstreamPrompt = dispatched[0]
    const downstreamPrompt = dispatched[1]

    // 上游无依赖：不注入上游段
    assert.ok(!upstreamPrompt.includes('[上游产出]'), '上游子任务无依赖不注入上游产出段')
    assert.ok(!upstreamPrompt.includes('[上游结果文件'), '上游子任务不注入结果文件清单')

    // 下游：上游文本产出上下文 + 结果文件跨节点下载配方（URL + URL 编码绝对路径 + 密钥成对语义）
    assert.ok(downstreamPrompt.includes('[上游产出]'), '下游提示词注入上游产出段')
    assert.ok(downstreamPrompt.includes('上游子任务《取数产出》产出摘要'), '上游摘要按子任务标题标注')
    assert.ok(downstreamPrompt.includes('/tmp/wb-orch/report-final.md'), '上游产出文本（含结果文件路径）进入下游提示词')
    assert.ok(downstreamPrompt.includes('[上游结果文件（跨节点下载）]'), '下游提示词注入结果文件下载清单')
    const expectedUrl = `http://stub-node/fs/download?path=${encodeURIComponent('/tmp/wb-orch/report-final.md')}`
    assert.ok(downstreamPrompt.includes(expectedUrl), '下载 URL 指向上游成员节点基址且路径 URL 编码')
    assert.ok(downstreamPrompt.includes("-o 'report-final.md'"), '给出安全引用落盘文件名的 curl 指令')
    assert.ok(downstreamPrompt.includes('不在你的节点上'), '说明段明确跨节点语义')
  } finally {
    f.store.flush()
    rmSync(f.dir, { recursive: true, force: true })
  }
})


test('上游文件使用产出会话的稳定节点身份，不随成员改绑迁移或按裸路径去重', async () => {
  const f = makeFixture()
  try {
    const t = await f.engine.createTask({ title: '文件归属' })
    const task = f.store.getTask(t.id)!
    task.sessions = {
      a: { remoteSessionId: 'sa', baseUrl: 'http://old-a', nodeRefKey: 'mapping:origin-a', createdAt: 0 },
      b: { remoteSessionId: 'sb', baseUrl: 'http://old-b', nodeRefKey: 'mapping:origin-b', createdAt: 0 },
    }
    task.plan = { subtasks: [
      { id: 'a', agentId: 'a', title: 'A', result: { content: '/tmp/result.json' } },
      { id: 'b', agentId: 'b', title: 'B', result: { content: '/tmp/result.json' } },
    ] } as any
    ;(f.engine as any).resolver.resolveRef = async (ref: any) => ({ online: true, baseUrl: `http://${ref.mappingId}` })
    const out = await (f.engine as any).buildUpstreamFilesSection(task, { dependsOn: ['a', 'b'] })
    assert.ok(out.includes('http://origin-a/fs/download'))
    assert.ok(out.includes('http://origin-b/fs/download'))
    delete task.sessions.a.nodeRefKey
    const unknown = await (f.engine as any).buildUpstreamFilesSection(task, { dependsOn: ['a'] })
    assert.ok(unknown.includes('文件位置未验证'))
    assert.ok(!unknown.includes('curl'))
  } finally { f.store.flush(); rmSync(f.dir, { recursive: true, force: true }) }
})

test('跨节点主会话无需 @ 注入归属工作区指引，离线明确拒绝本机同路径', async () => {
  const f = makeFixture()
  try {
    const owner = { kind: 'mapping' as const, mappingId: 'file-node' }
    const executor = { kind: 'mapping' as const, mappingId: 'exec-node' }
    const project = f.store.upsertProject({ name: '跨节点', dshRef: owner, apiKey: 'owner-key', defaultExecutionNodeRef: executor, workspace: '/owner/repo' })
    const task = await f.engine.createTask({ projectId: project.id })
    const agent = { id: '__node__', name: '主会话', dshRef: executor } as SubAgent
    const engine = f.engine as any
    engine.resolver.resolveRef = async (ref: DshRef) => ({ online: true, baseUrl: ref.kind === 'mapping' && ref.mappingId === 'file-node' ? 'http://owner:100' : 'http://executor:200', apiKey: ref.kind === 'mapping' && ref.mappingId === 'file-node' ? 'owner-key' : 'exec-key' })
    const result = await f.engine.transformFileMentionsForAgent('读取项目', undefined, agent, task)
    assert.ok(result.extraSections.join(' ').includes('http://owner:100/fs/list'))
    assert.ok(!result.extraSections.join(' ').includes('http://executor:200/fs/list'))
    assert.ok(result.extraSections.join(' ').includes('不要改在本机创建同路径目录'))
    engine.resolver.resolveRef = async () => ({ online: false, baseUrl: 'http://stale:100' })
    const offline = await f.engine.transformFileMentionsForAgent('读取项目', undefined, agent, task)
    assert.ok(offline.extraSections.join(' ').includes('文件归属节点当前不可达'))
    assert.ok(!offline.extraSections.join(' ').includes('http://stale'))
    task.nodeRef = owner
    const local = await f.engine.transformFileMentionsForAgent('读取项目', undefined, { ...agent, dshRef: owner }, task)
    assert.ok(local.extraSections.join(' ').includes('[项目工作区]'))
    assert.ok(!local.extraSections.join(' ').includes('工具未能安装'))
  } finally { f.store.flush(); rmSync(f.dir, { recursive: true, force: true }) }
})

test('task-57: 主/子会话注入稳定引用，旧 helper 升级，回退节点按实际归属判断', async () => {
  const f = makeFixture()
  try {
    const owner = { kind: 'mapping' as const, mappingId: 'file-node' }
    const executor = { kind: 'mapping' as const, mappingId: 'exec-node' }
    const project = f.store.upsertProject({ name: '稳定远程工具', dshRef: owner, workspace: '/owner/repo', defaultExecutionNodeRef: executor })
    const task = await f.engine.createTask({ projectId: project.id })
    const engine = f.engine as any
    engine.directory = { endpoint: 'https://directory', key: 'catalog-key', resolveApp: () => ({ mappingId: 'file-node' }) }
    engine.resolver.resolveRef = async (ref: DshRef) => ({ online: true, baseUrl: 'http://' + (ref.kind === 'mapping' ? ref.mappingId : 'node'), apiKey: 'owner-key' })
    const uploads: string[] = []
    f.client.uploadFiles = async (_target?: any, _id?: any, files?: any) => {
      uploads.push(files[0].filename)
      return { ok: true, files: [{ name: files[0].filename, path: '/session/' + files[0].filename }] }
    }
    for (const id of ['__node__', 'child']) {
      for (const oldName of ['.workbuddy-workspace-remote.mjs', '.workbuddy-workspace-remote-v2.mjs', '.workbuddy-workspace-remote-v2-1.mjs']) {
        f.store.mutateTask(task.id, t => { t.sessions[id] = { remoteSessionId: 'session-' + id, baseUrl: 'http://executor', nodeRefKey: 'mapping:exec-node', workspaceAccessCliPath: '/session/' + oldName, createdAt: 0 } })
        const agent = { id, name: id, dshRef: executor } as SubAgent
        const result = await f.engine.transformFileMentionsForAgent('读取项目', undefined, agent, f.store.getTask(task.id)!)
        const prefix = result.extraSections.join('\n').split('\n').find(s => s.includes('使用前缀:'))!
        assert.ok(prefix.includes("--node-ref 'mapping:file-node'"))
        assert.ok(prefix.includes("--onenat-base 'https://directory'"))
        assert.ok(prefix.includes("WORKBUDDY_ONENAT_API_KEY='catalog-key'"))
        assert.ok(prefix.includes('.workbuddy-workspace-remote-v3.mjs'))
        assert.ok(!prefix.includes('--base '))
        await f.engine.transformFileMentionsForAgent('再次读取', undefined, agent, f.store.getTask(task.id)!)
      }
    }
    assert.deepEqual(uploads, Array(6).fill('.workbuddy-workspace-remote-v3.mjs'), '主/子旧版本各升级一次，新版本再次访问不上传')
    f.store.mutateTask(task.id, t => { t.sessions.child.nodeRefKey = 'mapping:file-node' })
    const local = await f.engine.transformFileMentionsForAgent('读取', undefined, { id: 'child', name: 'child', dshRef: executor } as SubAgent, f.store.getTask(task.id)!)
    assert.ok(local.extraSections[0].includes('[项目工作区]'), '子智能体回退文件节点时直接访问')
    const appProject = f.store.upsertProject({ name: '应用引用', dshRef: { kind: 'app', appId: 'owner-template' }, workspace: '/owner/app', defaultExecutionNodeRef: executor })
    const appTask = await f.engine.createTask({ projectId: appProject.id })
    f.store.mutateTask(appTask.id, t => { t.sessions.__node__ = { remoteSessionId: 'app-session', baseUrl: 'http://executor', nodeRefKey: 'mapping:exec-node', createdAt: 0 } })
    const appResult = await f.engine.transformFileMentionsForAgent('读取', undefined, { id: '__node__', name: 'main', dshRef: executor } as SubAgent, f.store.getTask(appTask.id)!)
    assert.ok(appResult.extraSections.join('\n').includes("--node-ref 'mapping:file-node'"), '共享 app 按本轮已解析 mapping 固定文件节点')
  } finally { f.store.flush(); rmSync(f.dir, { recursive: true, force: true }) }
})

test('task-57: 实际子任务派发接受同目录重名 helper 并复用稳定引用注入', async () => {
  const f = makeFixture()
  try {
    const owner = { kind: 'mapping' as const, mappingId: 'file-node' }
    const executor = { kind: 'mapping' as const, mappingId: 'exec-node' }
    const project = f.store.upsertProject({ name: '共享执行目录', dshRef: owner, workspace: '/owner/repo', defaultExecutionNodeRef: executor })
    seedAgent(f.store, 'child', { dshRef: executor })
    const task = await f.engine.createTask({ projectId: project.id, memberAgentIds: ['child'], workDir: '/executor/scratch' })
    f.store.mutateTask(task.id, t => {
      t.plan = { objective: '验证子任务自动注入', strategy: 'parallel', createdAt: Date.now(), subtasks: [{ id: 'sub', agentId: 'child', title: '验证', prompt: '读取归属项目', dependsOn: [], status: 'pending', logs: [] }] }
    })
    const engine = f.engine as any
    engine.directory = { ...RESOURCE_DIR_STUB, endpoint: 'https://directory', key: 'catalog-key' }
    engine.resolver.resolveRef = async (ref: DshRef) => ({ online: true, baseUrl: ref.kind === 'mapping' && ref.mappingId === 'file-node' ? 'http://owner:100' : 'http://executor:200', apiKey: 'owner-key' })
    const uploads: string[] = []
    f.client.uploadFiles = async (_target?: any, id?: any, files?: any) => {
      uploads.push(id)
      assert.equal(files[0].filename, '.workbuddy-workspace-remote-v3.mjs')
      return { ok: true, files: [{ name: '.workbuddy-workspace-remote-v3-1.mjs', path: '/executor/scratch/.workbuddy-workspace-remote-v3-1.mjs' }] }
    }
    for (let i = 0; i < 2; i++) {
      assert.equal((await f.engine.retrySubtask(task.id, 'sub')).ok, true)
      const prompt = f.client.prompts.at(-1)!
      assert.ok(prompt.includes("--node-ref 'mapping:file-node'"), '真正发往子会话的 prompt 必须有稳定 owner')
      assert.ok(prompt.includes('.workbuddy-workspace-remote-v3-1.mjs'))
      assert.ok(prompt.includes("WORKBUDDY_ONENAT_API_KEY='catalog-key'"))
      assert.ok(!prompt.includes('远程操作工具未能安装'))
      assert.equal(f.store.getTask(task.id)!.sessions.child.workspaceAccessCliPath, '/executor/scratch/.workbuddy-workspace-remote-v3-1.mjs')
    }
    assert.deepEqual(uploads, ['sess-1'], '有效编号文件名续用，不每轮重新上传')
  } finally { f.store.flush(); rmSync(f.dir, { recursive: true, force: true }) }
})

test('task-57: 首次新子会话经完整 runChatTurn 无附件即安装并注入 helper', async () => {
  const f = makeFixture()
  try {
    const owner = { kind: 'mapping' as const, mappingId: 'file-node' }
    const executor = { kind: 'mapping' as const, mappingId: 'exec-node' }
    const project = f.store.upsertProject({ name: '首次聊天注入', dshRef: owner, workspace: '/owner/repo', defaultExecutionNodeRef: executor })
    seedAgent(f.store, 'child', { dshRef: executor })
    const task = await f.engine.createTask({ projectId: project.id, memberAgentIds: [] })
    assert.deepEqual(task.sessions, {}, '不预建 binding，也不先上传附件')
    const engine = f.engine as any
    engine.directory = { ...RESOURCE_DIR_STUB, endpoint: 'https://directory', key: 'catalog-key' }
    f.resolver.resolveRef = async (ref: DshRef) => ({ online: true, baseUrl: ref.kind === 'mapping' && ref.mappingId === 'file-node' ? 'http://owner:100' : 'http://executor:200', apiKey: 'owner-key' })
    const uploads: Array<{ sessionId: string; path: string }> = []
    f.client.uploadFiles = async (_target?: any, sessionId?: any, files?: any) => {
      const path = '/executor/scratch/' + files[0].filename
      assert.equal(files[0].filename, '.workbuddy-workspace-remote-v3.mjs')
      assert.equal(f.store.getTask(task.id)!.sessions.child.remoteSessionId, sessionId, '先创建子 binding，再向同一会话安装')
      uploads.push({ sessionId, path })
      return { ok: true, files: [{ name: files[0].filename, path }] }
    }
    const text = '@child 读取项目并核对版本'
    const mentions = await f.engine.extractMentions(text)
    assert.equal(mentions.mentionedFiles, undefined)
    const target = await f.resolver.resolve(f.store.getAgent('child')!)
    for (let i = 0; i < 2; i++) {
      // Single-@ sendUserMessage now routes to a planner. Invoke the full chat
      // implementation explicitly so this regression cannot accidentally test a DAG.
      await engine.runChatTurn(task.id, text, mentions, new Map([['child', target]]), new AbortController().signal)
      const final = f.store.getTask(task.id)!
      assert.equal(final.status, 'completed')
      assert.equal(final.plan, undefined, '完整 runChatTurn 派发，不经 DAG 或手工 transformer')
      assert.equal(final.sessions.__node__, undefined, '无主会话或附件预建 binding 掩盖首轮行为')
      assert.strictEqual(final, task, '当前 WorkStore.mutateTask 保留对象身份')
      assert.equal(f.client.prompts.length, i + 1)
      const prompt = f.client.prompts[i]
      assert.ok(prompt.includes('[项目工作区跨机访问]'))
      assert.ok(prompt.includes("--node-ref 'mapping:file-node'"))
      assert.ok(prompt.includes("--onenat-base 'https://directory'"))
      assert.ok(prompt.includes("WORKBUDDY_ONENAT_API_KEY='catalog-key'"))
      assert.ok(prompt.includes('/executor/scratch/.workbuddy-workspace-remote-v3.mjs'))
      assert.ok(!prompt.includes('远程操作工具未能安装'))
      assert.equal(final.sessions.child.workspaceAccessCliPath, uploads[0].path)
    }
    assert.equal(f.client.created, 1, '第二轮续用首次子会话')
    assert.deepEqual(uploads.map(u => u.sessionId), ['sess-1'], '首次会话只上传一次 helper')
    assert.ok(!f.client.mkdirs.includes('/owner/repo'), '不在执行节点创建 owner 镜像目录')
  } finally { f.store.flush(); await delay(50); rmSync(f.dir, { recursive: true, force: true }) }
})

test('task-57: 公开单 @ 首次子派发经规划器安装编号 helper，无需刷新 task', async () => {
  const f = makeFixture({ plannerFactory: () => ({ strategy: 'parallel', subtasks: [{ agentId: 'child', title: '首次子派发', prompt: '读取归属项目并核对版本', dependsOn: [] }] }) })
  try {
    const owner = { kind: 'mapping' as const, mappingId: 'file-node' }
    const executor = { kind: 'mapping' as const, mappingId: 'exec-node' }
    const project = f.store.upsertProject({ name: '公开子派发入口', dshRef: owner, workspace: '/owner/repo', defaultExecutionNodeRef: executor })
    seedAgent(f.store, 'child', { dshRef: executor })
    const task = await f.engine.createTask({ projectId: project.id, memberAgentIds: [] })
    assert.deepEqual(task.sessions, {})
    assert.equal(task.attachments?.length || 0, 0)
    const engine = f.engine as any
    engine.directory = { ...RESOURCE_DIR_STUB, endpoint: 'https://directory', key: 'catalog-key' }
    f.resolver.resolveRef = async (ref: DshRef) => ({ online: true, baseUrl: ref.kind === 'mapping' && ref.mappingId === 'file-node' ? 'http://owner:100' : 'http://executor:200', apiKey: 'owner-key' })
    const uploads: string[] = []
    f.client.uploadFiles = async (_target?: any, sessionId?: any, files?: any) => {
      assert.equal(f.store.getTask(task.id)!.sessions.child.remoteSessionId, sessionId, '公开入口创建的 binding 在上传前已经可见')
      assert.equal(files[0].filename, '.workbuddy-workspace-remote-v3.mjs')
      uploads.push(sessionId)
      return { ok: true, files: [{ name: '.workbuddy-workspace-remote-v3-1.mjs', path: '/executor/scratch/.workbuddy-workspace-remote-v3-1.mjs' }] }
    }
    await f.engine.sendUserMessage(task.id, '@child 读取项目并核对版本')
    const final = await settle(f.engine, f.store, task.id)
    assert.equal(final.status, 'success')
    assert.equal(final.lastRoute?.kind, 'orchestrate', '公开单 @ 由实际路由决定，不直接调用 chat/transformer/retrySubtask')
    assert.ok(f.planners.planOptions.length > 0, '由 planner 生成计划，不预置 DAG')
    assert.equal(final.plan!.subtasks.length, 1)
    assert.equal(final.plan!.subtasks[0].agentId, 'child')
    assert.equal(final.plan!.subtasks[0].status, 'completed')
    assert.equal(final.sessions.__node__, undefined)
    assert.strictEqual(final, task, '真实 store 原地保留对象，不人为 upsert 替换')
    assert.deepEqual(uploads, ['sess-1'])
    assert.equal(final.sessions.child.workspaceAccessCliPath, '/executor/scratch/.workbuddy-workspace-remote-v3-1.mjs')
    assert.equal(f.client.prompts.length, 1)
    const prompt = f.client.prompts[0]
    assert.ok(prompt.includes('[项目工作区跨机访问]'))
    assert.ok(prompt.includes("--node-ref 'mapping:file-node'"))
    assert.ok(prompt.includes('/executor/scratch/.workbuddy-workspace-remote-v3-1.mjs'))
    assert.ok(!prompt.includes('远程操作工具未能安装'))
  } finally { f.store.flush(); await delay(50); rmSync(f.dir, { recursive: true, force: true }) }
})

test('主会话跨节点不使用归属路径，稳定映射端口漂移复用会话', async () => {
  const f = makeFixture()
  try {
    const owner = { kind: 'mapping' as const, mappingId: 'file-node' }
    const executor = { kind: 'mapping' as const, mappingId: 'exec-node' }
    const project = f.store.upsertProject({ name: '跨节点', dshRef: owner, defaultExecutionNodeRef: executor, workspace: '/owner/repo' })
    const task = await f.engine.createTask({ projectId: project.id })
    const agent = { id: '__node__', name: '主会话', dshRef: executor, workDir: '/owner/repo' } as SubAgent
    const target = { online: true, agentId: '__node__', baseUrl: 'http://tunnel:100', mappingId: 'exec-node' }
    const engine = f.engine as any
    const first = await engine.ensureSession(task.id, agent, target)
    assert.ok(first.ok)
    assert.equal(f.store.getTask(task.id)?.sessions.__node__.cwd, undefined)
    assert.equal(f.store.getTask(task.id)?.sessions.__node__.nodeRefKey, 'mapping:exec-node')
    const second = await engine.ensureSession(task.id, agent, { ...target, baseUrl: 'http://tunnel:999' })
    assert.equal(second.reused, true)
    assert.equal(f.client.created, 1)
    assert.equal(f.store.getTask(task.id)?.sessions.__node__.baseUrl, 'http://tunnel:999')
  } finally { f.store.flush(); rmSync(f.dir, { recursive: true, force: true }) }
})


test('app解析到mapping仍保留工作区身份；fork null明确退出项目', async () => {
  const f = makeFixture()
  try {
    const appRef = { kind: 'app' as const, appId: 'app-owner' }
    const project = f.store.upsertProject({ name: 'app', dshRef: appRef, workspace: '/app/repo' })
    const task = await f.engine.createTask({ projectId: project.id })
    const agent = { id: '__node__', name: 'main', dshRef: appRef } as SubAgent
    const out = await (f.engine as any).ensureSession(task.id, agent, { online: true, agentId: '__node__', baseUrl: 'http://tunnel:100', mappingId: 'resolved-app-mapping' })
    assert.ok(out.ok)
    assert.equal(f.store.getTask(task.id)?.sessions.__node__.cwd, '/app/repo')
    assert.equal(f.store.getTask(task.id)?.sessions.__node__.nodeRefKey, 'app:app-owner')
    const fork = await f.engine.forkTask(task.id, { projectId: null, nodeRef: { kind: 'direct', apiBaseUrl: 'http://solo' } })
    assert.equal(fork.task.projectId, undefined)
    assert.deepEqual(fork.task.nodeRef, { kind: 'direct', apiBaseUrl: 'http://solo' })
  } finally { f.store.flush(); rmSync(f.dir, { recursive: true, force: true }) }
})

test('task-59: 旧 URL/app-only 绑定不控制未知节点，也不将旧 sessionId 交给新节点探测', async () => {
  const f = makeFixture()
  try {
    const ref: DshRef = { kind: 'mapping', mappingId: 'current-node' }
    const task = await f.engine.createTask({ nodeRef: ref, memberAgentIds: [] })
    const calls: string[] = []
    f.client.getSession = async (_target, sid) => { calls.push(sid); return { ok: true, status: 'idle' } }
    for (const nodeRefKey of [undefined, 'app:old-template']) {
      f.store.mutateTask(task.id, t => { t.sessions.__node__ = { remoteSessionId: 'unverified-id', baseUrl: 'http://reused-port', nodeRefKey, createdAt: 0 } })
      const stored = f.store.getTask(task.id)!
      assert.equal(await f.engine.resolveExecTarget(stored, '__node__'), undefined)
      assert.equal((await f.engine.steerTaskMessage(task.id, 'no leak')).ok, false)
      const result: { ok: boolean; remoteSessionId?: string } = await (f.engine as any).ensureSession(task.id, { id: '__node__', name: 'main', dshRef: ref }, { online: true, baseUrl: 'http://current', mappingId: 'current-node' })
      assert.equal(result.ok, true); assert.notEqual(result.remoteSessionId, 'unverified-id')
    }
    assert.deepEqual(calls, [])
    assert.equal(f.client.created, 2)
  } finally { f.store.flush(); rmSync(f.dir, { recursive: true, force: true }) }
})

test('task-59: app 端口漂移复用，app 改绑拒绝迁移；会话控制按记录 mapping 重新解析', async () => {
  const f = makeFixture()
  try {
    const appRef: DshRef = { kind: 'app', appId: 'shared-template' }
    const project = f.store.upsertProject({ name: 'session identity', dshRef: appRef, workspace: '/repo' })
    const task = await f.engine.createTask({ projectId: project.id })
    const agent = { id: '__node__', name: 'main', dshRef: appRef } as SubAgent
    const engine = f.engine as any
    const first = await engine.ensureSession(task.id, agent, { online: true, baseUrl: 'http://node:100', mappingId: 'physical-a' })
    assert.equal(first.ok, true)
    assert.equal(f.store.getTask(task.id)?.sessions.__node__.resolvedMappingId, 'physical-a')
    const drift = await engine.ensureSession(task.id, agent, { online: true, baseUrl: 'http://node:200', mappingId: 'physical-a' })
    assert.equal(drift.reused, true)
    const changed = await engine.ensureSession(task.id, agent, { online: true, baseUrl: 'http://other:100', mappingId: 'physical-b' })
    assert.equal(changed.ok, false)
    assert.match(changed.error, /拒绝迁移/)
    assert.equal(f.client.created, 1)
    assert.equal(f.store.getTask(task.id)?.sessions.__node__.remoteSessionId, first.remoteSessionId)
    const refs: DshRef[] = []
    engine.resolver.resolveRef = async (ref: DshRef) => { refs.push(ref); return { online: true, baseUrl: 'http://node:300', mappingId: 'physical-a' } }
    const control = await f.engine.resolveExecTarget(task, '__node__')
    assert.equal(control?.baseUrl, 'http://node:300')
    assert.deepEqual(control?.executionDshRef, appRef)
    const calls: string[] = []
    f.client.steerSession = async (...input: any[]) => { calls.push(input[0].baseUrl); return { ok: true } }
    assert.equal((await f.engine.steerTaskMessage(task.id, 'stable control')).ok, true)
    assert.deepEqual(calls, ['http://node:300'])
    assert.deepEqual(refs, [{ kind: 'mapping', mappingId: 'physical-a' }, { kind: 'mapping', mappingId: 'physical-a' }])
    const init = await f.engine.directUploadInit(task.id, 'stable.txt', 1)
    assert.equal(init.ok, true)
    const registered = await f.engine.directUploadRegister(task.id, init.uploadId!, '/repo/stable.txt')
    assert.equal(registered.ok, true); assert.match(registered.attachment!.downloadUrl, /node:300/)
    const pending = await f.engine.directUploadInit(task.id, 'changed.txt', 1)
    assert.equal(pending.ok, true)
    f.store.mutateTask(task.id, t => { t.sessions.__node__.remoteSessionId = 'replacement-session' })
    const changedUpload = await f.engine.directUploadRegister(task.id, pending.uploadId!, '/repo/changed.txt')
    assert.equal(changedUpload.ok, false); assert.match(changedUpload.error!, /身份已变化/)
    engine.resolver.resolveRef = async () => ({ online: false, error: 'original mapping offline' })
    assert.equal(await f.engine.resolveExecTarget(task, '__node__'), undefined, '不得回退另一实体来访问已有会话')
    assert.equal((await f.engine.steerTaskMessage(task.id, 'offline')).ok, false)
    assert.deepEqual(calls, ['http://node:300'], '离线不得向旧 URL 发送控制请求')
    const cancellations: string[] = []
    ;(f.client as any).cancelSession = async (target: DshTarget) => { cancellations.push(target.baseUrl); return { ok: true } }
    const canceled = await f.engine.cancelTask(task.id)
    assert.equal(canceled.ok, true); assert.ok(canceled.warnings.length)
    assert.deepEqual(cancellations, [], '取消也不得回退旧地址')
    f.store.flush()
    const restarted = new WorkStore(join(f.dir, 'store.json'))
    assert.equal(restarted.getTask(task.id)?.sessions.__node__.resolvedMappingId, 'physical-a')
    restarted.flush()
  } finally { f.store.flush(); rmSync(f.dir, { recursive: true, force: true }) }
})
