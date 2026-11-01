/**
 * onenat-workbuddy-web - Backlog 工具（workbuddy_backlog_manage）
 *
 * 把平台 backlog 待办（Backlog.md 兼容；唯一事实源在 DSH 节点项目工作区
 * `<workspace>/backlog/tasks/*.md`）暴露给工具通道：HTTP `POST /api/tools/workbuddy_backlog_manage`
 * 与 MCP `tools/call` 同源（tool-ops 的同一份 defs 表），不需要两套实现。
 *
 * 契约：`docs/design-backlog-mcp-tool.md`（action 语义 / item / filter / 错误码）。
 * 上游对照：Backlog.md 官方 MCP Server 的 task_* 工具族（v1.55.3），差距见契约 §8。
 *
 * 设计取舍：
 *  - 一个工具 + action 子命令（而不是上游 8 个独立工具）——与仓库其余 15 个工具同构；
 *  - 参数只有 string/json 两种类型，数组/对象一律走 `item` / `filter` / `itemIds` JSON 参数；
 *  - 写路径全部走 backlog 数据层的乐观读改写（`writeItem` 带 base 预检），冲突显式报 CONFLICT，
 *    不静默覆盖人/agent 的并发改动。
 */
import { DshClient } from './remote-client.js'
import type { DshTarget } from './remote-client.js'
import type { AgentResolver } from './resolver.js'
import type { TaskEngine } from './engine.js'
import type { WorkStore } from './store.js'
import type { Project } from './types.js'
import {
  appendExecutionRecord,
  backlogInstructionSnippet,
  createItem,
  deleteItem,
  encodeFrontmatter,
  findItem,
  initBacklog,
  normalizeItemId,
  parseBacklogOrderBy,
  parseBacklogOrder,
  probeBacklog,
  readConfig,
  readItem,
  replaceDescription,
  resolveDoneStatus,
  appendAcceptance,
  setAcceptance,
  sortBacklogItemsBy,
  writeItem,
  type BacklogConfig,
  type BacklogFields,
  type BacklogItem,
  type BacklogOrderBy,
} from './backlog.js'
import {
  dispatchBacklogItem,
  listBacklogWithTasks,
  overviewBacklog,
  type BacklogItemWithTasks,
} from './backlog-service.js'
import type { WorkBuddyToolDef } from './tool-ops.js'

/**
 * 列表单次最多返回条目。默认 50 而不是 200：
 * MCP 单帧上限 64KB（xiaozhi-mcp.ts MAX_RESULT_BYTES），带描述正文时 200 条中文任务
 * 就能把整包换成「结果过大」提示。要更多请用 filter 收窄或显式传 limit。
 */
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 1000
/** 列表里描述正文的截断长度（完整正文用 view） */
const DESC_PREVIEW = 600
/** view 返回 raw 的上限（超出截断并标明，避免撑爆单帧） */
const RAW_MAX = 40_000

// ---------------------------------------------------------------- 参数工具

/** 严格 JSON 参数解析：给了内容但解析失败要报错，不能静默当成「未提供」（会把全量列表当默认返回） */
function parseJsonArg(v: unknown, name: string): { ok: true; value: any } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, value: undefined }
  if (typeof v === 'object') return { ok: true, value: v }
  const s = String(v).trim()
  if (!s) return { ok: true, value: undefined }
  try {
    return { ok: true, value: JSON.parse(s) }
  } catch {
    return { ok: false, error: `${name} 不是合法 JSON（应为对象/数组，例如 {"title":"…"}）` }
  }
}

/** 布尔参数归一（工具参数只有 string/json，布尔从 "true" 字符串来） */
function isFlag(v: unknown): boolean {
  if (v === true) return true
  return String(v ?? '').trim().toLowerCase() === 'true'
}

/** 单行字段清洗：换行会被 frontmatter / 段落语法吞进去（标题里塞 `\n## 新段` = 结构注入） */
function oneLine(v: unknown): string {
  return String(v ?? '').replace(/[\r\n]+/g, ' ').trim()
}

/** 长文本预览（列表用的是摘要，完整正文交给 view） */
function previewText(text: string, max: number): string {
  const t = String(text || '').trim()
  return t.length > max ? `${t.slice(0, max)}…（已截断，完整内容用 action:"view"）` : t
}

function toStrArray(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]
  return arr.map((x) => oneLine(x)).filter(Boolean)
}

function ok(payload: Record<string, unknown>): string {
  return JSON.stringify({ ok: true, ...payload }, null, 2)
}

function fail(error: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ok: false, error, ...extra })
}

/** 去掉值为 undefined 的键：MCP 回包对 AI 是 token 预算，空字段没有信息量（不修改入参） */
function compact<T extends Record<string, any>>(obj: T): T {
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v
  return out as T
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

function errorText(err: unknown): string {
  return String((err as any)?.message || err).slice(0, 400)
}

// ---------------------------------------------------------------- 过滤

export interface BacklogFilter {
  status?: string
  assignee?: string
  unassigned?: boolean
  labels?: string[]
  search?: string
  ready?: boolean
  includeDone?: boolean
  limit?: number
  projectIds?: string[]
  /** 排序维度（TASK-SORT-2）：缺省 createdAt（与 REST 列表默认一致） */
  orderBy?: BacklogOrderBy
  order?: 'asc' | 'desc'
  /** statuses 配置顺序（orderBy:"status" 时使用） */
  statuses?: string[]
}

export function parseBacklogFilter(raw: unknown): BacklogFilter {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const f: BacklogFilter = {}
  if (typeof src.status === 'string' && src.status.trim()) f.status = src.status.trim()
  if (typeof src.assignee === 'string' && src.assignee.trim()) f.assignee = src.assignee.trim()
  if (src.unassigned !== undefined) f.unassigned = isFlag(src.unassigned) || src.unassigned === true
  if (src.labels !== undefined) f.labels = toStrArray(src.labels)
  if (typeof src.search === 'string' && src.search.trim()) f.search = src.search.trim()
  if (src.ready !== undefined) f.ready = isFlag(src.ready) || src.ready === true
  // 三态：未给 = 默认（overview 侧默认剔除已完成项）；给了就按布尔字面量
  if (src.includeDone !== undefined) f.includeDone = isFlag(src.includeDone) || src.includeDone === true
  if (src.limit !== undefined && src.limit !== '') {
    const n = Number(src.limit)
    if (Number.isFinite(n)) f.limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)))
  }
  if (src.projectIds !== undefined) f.projectIds = toStrArray(src.projectIds)
  // 排序（TASK-SORT-2）：非法值走 parse 兜底，与 REST 列表同规则
  f.orderBy = parseBacklogOrderBy(typeof src.orderBy === 'string' ? src.orderBy : undefined)
  f.order = parseBacklogOrder(typeof src.order === 'string' ? src.order : undefined)
  if (Array.isArray(src.statuses)) f.statuses = toStrArray(src.statuses)
  return f
}

/** 待办是否满足过滤条件（search 覆盖标题/描述/标签，与上游 task_search 语义对齐） */
function matchFilter(it: BacklogItem, f: BacklogFilter, doneStatus: string, isReady: (it: BacklogItem) => boolean): boolean {
  if (f.status && String(it.status || '').toLowerCase() !== f.status.toLowerCase()) return false
  const assignees = (it.assignees || []).map((a) => a.toLowerCase())
  if (f.assignee && !assignees.some((a) => a.includes(f.assignee!.toLowerCase()))) return false
  if (f.unassigned && assignees.length) return false
  if (f.labels?.length) {
    const have = (it.labels || []).map((l) => l.toLowerCase())
    if (!f.labels.every((l) => have.includes(l.toLowerCase()))) return false
  }
  if (f.search) {
    const hay = `${it.title || ''}\n${it.description || ''}\n${(it.labels || []).join(' ')}`.toLowerCase()
    if (!hay.includes(f.search.toLowerCase())) return false
  }
  if (f.ready && !isReady(it)) return false
  if (f.includeDone === false && String(it.status || '').toLowerCase() === doneStatus.toLowerCase()) return false
  return true
}

/** 应用过滤 + 排序（ordinal 升序，其次 id 序号）；返回截断前的总数 */
export function applyBacklogFilter(
  items: BacklogItemWithTasks[],
  f: BacklogFilter,
  doneStatus: string,
): { items: BacklogItemWithTasks[]; total: number } {
  const byId = new Map(items.map((it) => [normalizeItemId(it.itemId), it]))
  // 依赖未知（条目已删/被改名）不算阻塞：与派发侧「仅对找到的进行中的依赖阻止」保持一致
  const isReady = (it: BacklogItem): boolean =>
    !it.dependencies?.length ||
    it.dependencies.every((d) => {
      const dep = byId.get(normalizeItemId(d))
      return !dep || dep.status === doneStatus
    })
  const matched = items.filter((it) => matchFilter(it, f, doneStatus, isReady))
  // 排序（TASK-SORT-2）：orderBy + asc/desc，与 REST 列表/前端共用 sortBacklogItemsBy 同一规则；
  // 缺省 createdAt desc（最新在前），兼容旧默认改由显式 orderBy:"ordinal" 获得
  const sorted = sortBacklogItemsBy(matched, f.statuses || [], f.orderBy || 'createdAt', f.order || 'desc')
  const limit = f.limit ?? DEFAULT_LIMIT
  return { items: sorted.slice(0, limit), total: sorted.length }
}

// ---------------------------------------------------------------- 视图投影

function linkTasks(tasks: BacklogItemWithTasks['tasks']) {
  return tasks.map((t) => compact({ id: t.id, status: t.status, summaryStatus: t.summaryStatus || undefined, writebackFailed: t.writebackFailed ? t.writebackFailed.error : undefined }))
}

/** 列表用精简投影：字段够 AI 判断「该派发哪条」，正文留给 view */
function briefItem(it: BacklogItemWithTasks, withDescription: boolean) {
  return compact({
    itemId: it.itemId,
    title: it.title,
    status: it.status,
    priority: it.priority,
    dueDate: it.dueDate,
    assignees: it.assignees?.length ? it.assignees : undefined,
    labels: it.labels?.length ? it.labels : undefined,
    dependencies: it.dependencies?.length ? it.dependencies : undefined,
    acceptance: it.acceptance,
    hasExecutionRecord: it.hasExecutionRecord || undefined,
    fileName: it.fileName,
    description: withDescription ? previewText(it.description || '', DESC_PREVIEW) : undefined,
    tasks: it.tasks.length ? linkTasks(it.tasks) : undefined,
  })
}

/** 状态归一（大小写不敏感）；非法值给出可选列表而不是静默写入 */
function canonicalStatus(cfg: BacklogConfig, value: string): { status?: string; error?: string } {
  const want = value.trim().toLowerCase()
  const hit = cfg.statuses.find((s) => s.toLowerCase() === want)
  if (hit) return { status: hit }
  return { error: `status 非法：${value}（可选：${cfg.statuses.join(' / ')}）` }
}

// ---------------------------------------------------------------- 工具定义

export interface BacklogToolDeps {
  store: WorkStore
  resolver: AgentResolver
  engine: TaskEngine
  /** 复用 tool-ops 的 DshClient（避免每次调用新建连接池）；缺省时自建 */
  client?: DshClient
  /** 项目节点的可读名（列表里帮 AI 认节点；缺省回落到 dshRef 原始值） */
  nodeTitle?: (proj: Project) => string | undefined
}

export function createBacklogManageTool(deps: BacklogToolDeps): WorkBuddyToolDef {
  const { store, resolver, engine } = deps
  const client = deps.client || new DshClient()

  const nodeTitle = (proj: Project): string => {
    const custom = deps.nodeTitle?.(proj)
    if (custom) return custom
    const ref = proj.dshRef as any
    return ref?.kind === 'mapping' ? `mapping:${ref.mappingId}` : ref?.kind === 'app' ? `app:${ref.appId}` : String(ref?.apiBaseUrl || '未配置节点')
  }

  const tool: WorkBuddyToolDef = {
    name: 'workbuddy_backlog_manage',
    description:
      '管理平台 backlog 待办（Backlog.md 兼容：项目工作区 backlog/tasks/*.md，人在终端、agent 在会话、Web 看板三方改的是同一批文件）。' +
      'action: projects（列可管项目，先用它拿 projectId）/ config（状态与配置）/ init（初始化）/ list（筛选列表）/ search（标题+描述全文检索）/ ' +
      'view（详情含完整 Markdown）/ create / edit / delete / dispatch（派发为 WorkBuddy 任务）/ overview（跨项目我的待办）/ retry-writeback（回写失败重试）。' +
      '使用约定：① 登记需求前先 list 或 search 查重，别重复建；② dispatch 建出来的就是普通 WorkBuddy 任务（继承项目节点/工作区/成员/技能），' +
      '任务终态会由服务端自动回写待办状态与执行记录——不要手工改 status 冒充完成；③ delete 是物理删除，必须显式 force:"true"（推荐改状态保留历史）；' +
      '④ 有未完成依赖默认阻止派发，确认要强推才带 force:"true"；' +
      '⑤ 若 dispatch 回包带 taskCreated:"true"（任务已创建但待办未写回），**绝不要重新 dispatch**——用 edit 手动置状态或稍后 retry-writeback。' +
      '参数类型：只有 string/json 两种——数组与对象放进 item / filter / itemIds，布尔用 "true"/"false" 字符串。',
    parameters: {
      action: {
        type: 'string',
        description: '操作: projects / config / init / list / search / view / create / edit / delete / dispatch / overview / retry-writeback',
      },
      projectId: { type: 'string', description: '项目 ID（除 projects / overview 外必填；用 action:"projects" 查询）' },
      itemId: { type: 'string', description: '待办 ID（如 TASK-1，大小写不敏感；view / edit / delete / 单条 dispatch 用）' },
      taskId: { type: 'string', description: 'WorkBuddy 任务 ID（retry-writeback 用）' },
      itemIds: { type: 'json', description: '批量派发用待办 ID 数组: ["TASK-1","TASK-2"]' },
      item: {
        type: 'json',
        description:
          'create / edit 的待办字段: {title?, description?, status?, priority?, dueDate?, ordinal?, labels?:[], assignees?:[], dependencies?:[], ' +
          'acceptance?:[], acceptAdd?:[], note?:{title?, lines?:[]}}（未出现的键=不改动；status 必须是 config.statuses 之一；dueDate 传 null 清除）',
      },
      filter: {
        type: 'json',
        description:
          'list / search / overview 过滤: {status?, assignee?, unassigned?:bool, labels?:[], search?:string, ready?:bool, includeDone?:bool, limit?:number, projectIds?:[], orderBy?:"priority"|"status"|"createdAt"|"updatedAt"|"ordinal", order?:"asc"|"desc"}（orderBy 缺省 createdAt 倒序=最新在前）',
      },
      force: { type: 'string', description: '布尔字符串 "true"：忽略未完成依赖强制派发 / 确认待办物理删除' },
      sample: { type: 'string', description: 'init 用："true" = 一并创建一条示例待办' },
      updateInstruction: { type: 'string', description: 'init 用："true" = 把 backlog 协作约定追加进项目指令' },
    },
    async execute(args) {
      const action = String(args.action || 'list').trim()
      // 严格解析：给了内容但 JSON 不合法要报错；静默当「未提供」会把全量列表当默认结果返回
      const filterParsed = parseJsonArg(args.filter, 'filter')
      if (!filterParsed.ok) return fail(filterParsed.error)
      const itemParsed = parseJsonArg(args.item, 'item')
      if (!itemParsed.ok) return fail(itemParsed.error)
      const filter = parseBacklogFilter(filterParsed.value)
      const itemArg = (itemParsed.value && typeof itemParsed.value === 'object' ? itemParsed.value : {}) as Record<string, any>
      if (filter.unassigned && filter.assignee) {
        return fail('filter.unassigned 与 filter.assignee 不能同时使用（前者=仅未指派，后者=按指派人匹配）')
      }

      /** 解析项目 + 节点（读操作也要求节点在线——backlog 的事实源在节点上） */
      const projectCtx = async (): Promise<
        | { ok: true; proj: Project; target: DshTarget; workspace: string }
        | { ok: false; text: string }
      > => {
        const id = String(args.projectId || '').trim()
        if (!id) return { ok: false, text: fail('缺少 projectId（先用 action:"projects" 查询可管项目）') }
        const proj = store.getProject(id)
        if (!proj) return { ok: false, text: fail(`项目不存在: ${id}（先用 action:"projects" 查询）`, { code: 'NOT_FOUND' }) }
        if (!proj.workspace) return { ok: false, text: fail('项目未配置工作目录（workspace），无法使用 backlog') }
        const target = await resolver.resolveRef(proj.dshRef, proj.apiKey, `backlog-tool-${action}`)
        if (!target.online || !target.baseUrl) {
          return { ok: false, text: fail(target.error || '节点不可达（端口可能已漂移，先确认节点在线）', { code: 'NODE_UNREACHABLE' }) }
        }
        return { ok: true, proj, target: { baseUrl: target.baseUrl, apiKey: target.apiKey }, workspace: proj.workspace }
      }

      const writeGuard = (proj: Project): string | undefined =>
        proj.archivedAt ? fail('项目已归档（只读），请先恢复项目再操作 backlog', { code: 'PROJECT_ARCHIVED' }) : undefined

      try {
        // ---------------- projects：可管项目一览（含初始化状态） ----------------
        if (action === 'projects') {
          let projects = store.getProjects()
          if (filter.projectIds?.length) projects = projects.filter((p) => filter.projectIds!.includes(p.id))
          const rows = await overviewBacklog({ client, store, resolver }, projects, { withItems: false })
          return ok({
            total: rows.length,
            projects: rows.map((r) => {
              const proj = store.getProject(r.projectId)
              return compact({
                id: r.projectId,
                name: r.projectName,
                node: proj ? nodeTitle(proj) : undefined,
                workspace: r.workspace || undefined,
                // 显式布尔（不 compact 掉 false）：AI 需要区分「未归档」与「字段缺失」
                archived: r.archived,
                nodeStatus: r.nodeStatus,
                initialized: r.initialized,
                statuses: r.statuses.length ? r.statuses : undefined,
                defaultStatus: r.defaultStatus || undefined,
                error: r.error || undefined,
              })
            }),
            usage: '拿到 id 后: {action:"list", projectId:"<id>"}；未初始化项目先 {action:"init", projectId:"<id>"}',
          })
        }

        // ---------------- overview：跨项目聚合（失败隔离） ----------------
        if (action === 'overview') {
          let projects = store.getProjects()
          if (filter.projectIds?.length) projects = projects.filter((p) => filter.projectIds!.includes(p.id))
          const rows = await overviewBacklog({ client, store, resolver }, projects, { withItems: true })
          // overview 是「我的工作」视图：默认剔除已完成项（契约 §6），要历史完成项显式 includeDone:"true"
          const overviewFilter: BacklogFilter = { ...filter, includeDone: filter.includeDone === true }
          let openTotal = 0
          const projectsOut = rows.map((r) => {
            const doneStatus = resolveDoneStatus(r.statuses.length ? r.statuses : [r.defaultStatus || 'Done'])
            // 每项目各自的 statuses 传入，orderBy:"status" 时按该项目配置顺序排
            const filtered = r.nodeStatus === 'ok' ? applyBacklogFilter(r.items, { ...overviewFilter, statuses: r.statuses }, doneStatus) : { items: [], total: 0 }
            // open 与 includeDone 解耦：显式 includeDone:"true" 时 total 含已完成，但 open 只数进行中的
            const open = r.nodeStatus === 'ok'
              ? applyBacklogFilter(r.items, { ...overviewFilter, includeDone: false }, doneStatus).total
              : 0
            openTotal += open
            return compact({
              projectId: r.projectId,
              projectName: r.projectName,
              archived: r.archived || undefined,
              nodeStatus: r.nodeStatus,
              initialized: r.initialized,
              truncated: r.truncated || undefined,
              error: r.error || undefined,
              total: filtered.total,
              open,
              items: filtered.items.map((it) => briefItem(it, false)),
            })
          })
          return ok({
            summary: {
              projects: projectsOut.length,
              unreachable: projectsOut.filter((p) => p.nodeStatus === 'unreachable').length,
              open: openTotal,
            },
            projects: projectsOut,
          })
        }

        // ---------------- retry-writeback：任务终态回写重试 ----------------
        if (action === 'retry-writeback') {
          const taskId = String(args.taskId || '').trim()
          if (!taskId) return fail('缺少 taskId（dispatch 回包里的 taskId）')
          const task = store.getTask(taskId)
          if (!task) return fail(`任务不存在: ${taskId}`, { code: 'NOT_FOUND' })
          if (!task.backlogRef) return fail(`任务 ${taskId} 没有 backlog 来源（非 backlog 派发的任务无法回写）`)
          const pid = String(args.projectId || '').trim()
          if (pid && pid !== task.backlogRef.projectId) return fail(`projectId(${pid}) 与任务的 backlog 来源项目(${task.backlogRef.projectId}) 不一致`)
          // 与 HTTP 路由同语义：归档项目只读，回写也是写
          const sourceProject = store.getProject(task.backlogRef.projectId)
          if (sourceProject?.archivedAt) {
            return fail('来源项目已归档（只读），请先恢复项目再重试回写', { code: 'PROJECT_ARCHIVED' })
          }
          try {
            await engine.runBacklogWriteback(task)
            return ok({ taskId, projectId: task.backlogRef.projectId, itemId: task.backlogRef.itemId })
          } catch (err) {
            const msg = errorText(err)
            // 统一走引擎的失败记账：失败标记 + 退避计数推进（TASK-2 补偿器共用同一退避序列）
            engine.recordWritebackFailure(task.id, err)
            return fail(`回写仍失败：${msg}`, { taskId, projectId: task.backlogRef.projectId, itemId: task.backlogRef.itemId, retryable: true })
          }
        }

        // 以下 action 都需要项目上下文
        const ctx = await projectCtx()
        if (!ctx.ok) return ctx.text
        const { proj, target, workspace } = ctx

        // ---------------- config ----------------
        if (action === 'config') {
          const initialized = await probeBacklog(client, target, workspace)
          const cfg = await readConfig(client, target, workspace)
          return ok({
            projectId: proj.id,
            projectName: proj.name,
            archived: Boolean(proj.archivedAt),
            initialized,
            statuses: cfg.statuses,
            defaultStatus: cfg.defaultStatus,
            taskPrefix: cfg.taskPrefix,
            instructionSnippet: backlogInstructionSnippet(),
          })
        }

        // ---------------- init ----------------
        if (action === 'init') {
          const blocked = writeGuard(proj)
          if (blocked) return blocked
          const out = await initBacklog(client, target, workspace, {
            projectName: proj.name,
            sample: isFlag(args.sample),
          })
          if (isFlag(args.updateInstruction) && !`${proj.instruction || ''}`.includes('## Backlog 待办协作约定')) {
            store.upsertProject({
              id: proj.id,
              instruction: `${proj.instruction ? proj.instruction + '\n\n' : ''}${backlogInstructionSnippet()}`,
            } as any)
          }
          const cfg = await readConfig(client, target, workspace)
          return ok({
            projectId: proj.id,
            initialized: out.initialized,
            sampleItemId: out.sampleItemId,
            statuses: cfg.statuses,
            defaultStatus: cfg.defaultStatus,
            usage: '登记待办: {action:"create", projectId, item:{title, description, acceptance:[...]}}',
          })
        }

        // ---------------- list / search ----------------
        if (action === 'list' || action === 'search') {
          if (action === 'search' && !filter.search) {
            return fail('search 需要 filter.search（在标题/描述/标签里检索关键词）')
          }
          const needBodies = Boolean(filter.search) || action === 'search'
          const list = await listBacklogWithTasks({ client, store }, target, workspace, proj.id, { withBodies: needBodies })
          if (!list.initialized) {
            return ok({
              projectId: proj.id,
              projectName: proj.name,
              initialized: false,
              statuses: list.config.statuses,
              defaultStatus: list.config.defaultStatus,
              total: 0,
              returned: 0,
              items: [],
              tip: '该项目还没有 backlog，先 {action:"init", projectId:"…"}',
            })
          }
          const doneStatus = resolveDoneStatus(list.config.statuses)
          const { items, total } = applyBacklogFilter(list.items, { ...filter, statuses: list.config.statuses }, doneStatus)
          return ok({
            projectId: proj.id,
            projectName: proj.name,
            initialized: true,
            truncated: list.truncated || undefined,
            statuses: list.config.statuses,
            defaultStatus: list.config.defaultStatus,
            total,
            returned: items.length,
            items: items.map((it) => briefItem(it, needBodies)),
          })
        }

        // ---------------- view ----------------
        if (action === 'view') {
          const itemId = String(args.itemId || '').trim()
          if (!itemId) return fail('缺少 itemId（如 TASK-1）')
          const found = await findItem(client, target, workspace, itemId)
          if (!found) return fail(`待办 ${itemId} 不存在`, { code: 'NOT_FOUND' })
          const raw = await readItem(client, target, workspace, found.item.fileName)
          const linked = store
            .getTasks()
            .filter((t) => t.backlogRef?.projectId === proj.id && normalizeItemId(t.backlogRef!.itemId) === normalizeItemId(found.item.itemId))
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((t) => ({
              id: t.id,
              title: t.title,
              status: t.status,
              summaryStatus: t.summary?.status || '',
              summary: t.summary
                ? compact({ overview: t.summary.overview, finalConclusion: t.summary.finalConclusion, completedAt: t.summary.completedAt })
                : null,
              writebackFailed: t.backlogWritebackFailed || null,
              updatedAt: t.updatedAt,
            }))
          return ok({
            projectId: proj.id,
            projectName: proj.name,
            item: found.item,
            statuses: found.list.config.statuses,
            defaultStatus: found.list.config.defaultStatus,
            tasks: linked,
            raw: raw.length > RAW_MAX ? raw.slice(0, RAW_MAX) : raw,
            rawTruncated: raw.length > RAW_MAX || undefined,
            rawLength: raw.length,
          })
        }

        // ---------------- create ----------------
        if (action === 'create') {
          const blocked = writeGuard(proj)
          if (blocked) return blocked
          const title = oneLine(itemArg.title)
          if (!title) return fail('create 需要 item.title')
          const cfg = await readConfig(client, target, workspace)
          let createdStatus: string | undefined
          if (itemArg.status !== undefined) {
            const r = canonicalStatus(cfg, String(itemArg.status))
            if (r.error) return fail(r.error, { code: 'INVALID_STATUS', statuses: cfg.statuses })
            createdStatus = r.status
          }
          const created = await createItem(client, target, workspace, {
            title,
            description: itemArg.description !== undefined && itemArg.description !== null ? String(itemArg.description) : undefined,
            acceptance: toStrArray(itemArg.acceptance ?? itemArg.acceptanceCriteria),
            labels: toStrArray(itemArg.labels),
            dependencies: toStrArray(itemArg.dependencies),
            assignees: toStrArray(itemArg.assignees ?? itemArg.assignee),
            priority: itemArg.priority !== undefined && itemArg.priority !== null ? String(itemArg.priority) : undefined,
            dueDate: itemArg.dueDate !== undefined && itemArg.dueDate !== null ? String(itemArg.dueDate) : undefined,
          })
          // createItem 只写默认状态与自动 ordinal：显式给了 status/ordinal 时按同一乐观写路径补一次
          const patch: Partial<BacklogFields> = {}
          if (createdStatus && createdStatus !== created.status) patch.status = createdStatus
          if (itemArg.ordinal !== undefined && itemArg.ordinal !== null && Number.isFinite(Number(itemArg.ordinal))) patch.ordinal = Number(itemArg.ordinal)
          let final = created
          if (Object.keys(patch).length) {
            const raw = await readItem(client, target, workspace, created.fileName)
            const next = encodeFrontmatter(raw, patch)
            await writeItem(client, target, workspace, created.fileName, () => next, { base: raw })
            final = { ...created, ...patch }
          }
          // create 也支持 item.note（契约 §5：create / edit 通用）——先建后追加，失败只作告警不回滚
          let noteWarning: string | undefined
          if (itemArg.note !== undefined) {
            try {
              const raw0 = await readItem(client, target, workspace, created.fileName)
              const note = typeof itemArg.note === 'string' ? { title: '备注', lines: [itemArg.note] } : itemArg.note || {}
              const lines = toStrArray(note.lines)
              const next = appendExecutionRecord(raw0, {
                time: nowIso(),
                title: oneLine(note.title) || '备注',
                lines: lines.length ? lines : ['（无内容）'],
              })
              await writeItem(client, target, workspace, created.fileName, () => next, { base: raw0 })
            } catch (err) {
              noteWarning = `待办已创建，但 note 追加失败：${errorText(err)}`
            }
          }
          return ok({
            projectId: proj.id,
            item: final,
            warning: noteWarning,
            usage: '派发执行: {action:"dispatch", projectId, itemId:"' + final.itemId + '"}',
          })
        }

        // ---------------- edit ----------------
        if (action === 'edit') {
          const blocked = writeGuard(proj)
          if (blocked) return blocked
          const itemId = String(args.itemId || '').trim()
          if (!itemId) return fail('缺少 itemId（如 TASK-1）')
          const found = await findItem(client, target, workspace, itemId)
          if (!found) return fail(`待办 ${itemId} 不存在`, { code: 'NOT_FOUND' })
          const cfg = found.list.config
          const raw = await readItem(client, target, workspace, found.item.fileName)
          let next = raw
          const fm: Partial<BacklogFields> = {}
          if (itemArg.title !== undefined) fm.title = oneLine(itemArg.title)
          if (itemArg.status !== undefined) {
            const r = canonicalStatus(cfg, String(itemArg.status))
            if (r.error) return fail(r.error, { code: 'INVALID_STATUS', statuses: cfg.statuses })
            fm.status = r.status
          }
          if (itemArg.priority !== undefined) fm.priority = itemArg.priority === null ? '' : String(itemArg.priority)
          if (itemArg.dueDate !== undefined) fm.dueDate = itemArg.dueDate === null ? '' : String(itemArg.dueDate)
          if (itemArg.ordinal !== undefined) {
            const n = Number(itemArg.ordinal)
            if (!Number.isFinite(n)) return fail('ordinal 必须是数字')
            fm.ordinal = n
          }
          if (itemArg.labels !== undefined) fm.labels = toStrArray(itemArg.labels)
          if (itemArg.dependencies !== undefined) fm.dependencies = toStrArray(itemArg.dependencies)
          if (itemArg.assignees !== undefined || itemArg.assignee !== undefined) fm.assignees = toStrArray(itemArg.assignees ?? itemArg.assignee)

          if (Object.keys(fm).length) next = encodeFrontmatter(next, fm)
          if (typeof itemArg.description === 'string') next = replaceDescription(next, itemArg.description)
          const acSet = itemArg.acceptance ?? itemArg.acceptanceCriteria ?? itemArg.acceptanceCriteriaSet
          if (acSet !== undefined) next = setAcceptance(next, toStrArray(acSet).map((text) => ({ text, done: false })))
          const acAdd = itemArg.acceptAdd ?? itemArg.acceptanceCriteriaAdd
          if (acAdd !== undefined) {
            // 追加路径只插行不动既有内容（含无法识别的行），零丢字风险
            next = appendAcceptance(next, toStrArray(acAdd))
          }
          if (itemArg.note !== undefined) {
            const note = typeof itemArg.note === 'string' ? { title: '备注', lines: [itemArg.note] } : itemArg.note || {}
            const lines = toStrArray(note.lines)
            next = appendExecutionRecord(next, {
              time: nowIso(),
              title: oneLine(note.title) || '备注',
              lines: lines.length ? lines : ['（无内容）'],
            })
          }
          if (next === raw) {
            return fail(
              'item 没有可修改的字段（支持 title / description / status / priority / dueDate / ordinal / labels / assignees / dependencies / acceptance / acceptAdd / note）',
            )
          }
          try {
            await writeItem(client, target, workspace, found.item.fileName, () => next, { base: raw })
          } catch (err: any) {
            if (err?.name === 'BacklogConflictError') {
              return fail('待办内容已被其他人/agent 更新（乐观并发冲突）：先 action:"view" 取最新内容，再重试编辑', { code: 'CONFLICT' })
            }
            throw err
          }
          return ok({
            projectId: proj.id,
            itemId: found.item.itemId,
            updated: Object.keys(fm),
            description: typeof itemArg.description === 'string' || undefined,
            acceptance: acSet !== undefined || acAdd !== undefined || undefined,
            note: itemArg.note !== undefined || undefined,
            usage: '复核: {action:"view", projectId, itemId:"' + found.item.itemId + '"}',
          })
        }

        // ---------------- delete ----------------
        if (action === 'delete') {
          const blocked = writeGuard(proj)
          if (blocked) return blocked
          const itemId = String(args.itemId || '').trim()
          if (!itemId) return fail('缺少 itemId（如 TASK-1）')
          if (!isFlag(args.force)) {
            return fail(
              '物理删除不可恢复：确认要删请带 force:"true" 重试；更推荐用 edit 把 status 改为收尾状态（如 Done）保留历史',
              { code: 'CONFIRM_REQUIRED' },
            )
          }
          const found = await findItem(client, target, workspace, itemId)
          if (!found) return fail(`待办 ${itemId} 不存在`, { code: 'NOT_FOUND' })
          await deleteItem(client, target, workspace, found.item.fileName)
          return ok({ projectId: proj.id, deleted: found.item.itemId, fileName: found.item.fileName })
        }

        // ---------------- dispatch（单条 / 批量） ----------------
        if (action === 'dispatch') {
          const blocked = writeGuard(proj)
          if (blocked) return blocked
          const idsParsed = parseJsonArg(args.itemIds, 'itemIds')
          if (!idsParsed.ok) return fail(idsParsed.error)
          if (idsParsed.value !== undefined && !Array.isArray(idsParsed.value)) {
            return fail('itemIds 必须是数组，如 ["TASK-1","TASK-2"]')
          }
          const batch = (idsParsed.value || []).map((x: unknown) => String(x).trim()).filter(Boolean)
          const single = String(args.itemId || '').trim()
          const ids = batch.length ? batch : single ? [single] : []
          if (!ids.length) return fail('dispatch 需要 itemId（单条）或 itemIds（批量）')
          const instruction = typeof itemArg.instruction === 'string' && itemArg.instruction.trim() ? itemArg.instruction.trim() : undefined
          const force = isFlag(args.force)
          const results: Array<Record<string, unknown>> = []
          for (const id of ids) {
            try {
              const r = await dispatchBacklogItem({ client, engine }, proj, target, workspace, id, { force, instruction })
              results.push(compact({ ok: true, itemId: r.item.itemId, taskId: r.task.id, taskTitle: r.task.title, mode: r.task.mode, itemStatus: r.item.status }))
            } catch (err: any) {
              results.push(compact({
                ok: false,
                itemId: id,
                code: err?.code,
                error: errorText(err),
                blocked: Array.isArray(err?.blocked) ? err.blocked : undefined,
                // 任务已建但条目未写回：把 taskId 交回调用方，避免 AI 以为失败而重复派发
                taskId: err?.taskId,
                taskCreated: err?.taskCreated || undefined,
              }))
            }
          }
          const succeeded = results.filter((r) => r.ok).length
          const payload: Record<string, unknown> = {
            ok: true,
            projectId: proj.id,
            results,
            succeeded,
            failed: results.length - succeeded,
            usage: '跟进执行: workbuddy_task_status {taskId}；任务终态会自动回写待办',
          }
          if (ids.length === 1) {
            Object.assign(payload, results[0])
            delete (payload as any).results
            delete (payload as any).succeeded
            delete (payload as any).failed
          }
          return JSON.stringify(payload, null, 2)
        }

        return fail(`不支持的 action: ${action}（可选：projects / config / init / list / search / view / create / edit / delete / dispatch / overview / retry-writeback）`)
      } catch (err: any) {
        if (err?.name === 'BacklogConflictError') {
          return fail('待办内容已被其他人/agent 更新（乐观并发冲突）：先 view 取最新内容再重试', { code: 'CONFLICT' })
        }
        return fail(errorText(err))
      }
    },
  }

  return tool
}
