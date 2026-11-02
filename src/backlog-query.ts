/**
 * Backlog 任务查询引擎（docs/design-backlog-query-filters.md 唯一契约）。
 *
 * 把 Backlog.md `backlog task list` 的分类查询能力落成**纯函数**，供三处复用、禁止分叉：
 *   1. REST：`GET /api/projects/:id/backlog`、`GET /api/backlog/overview`（router.ts）
 *   2. 工具通道：`workbuddy_backlog_manage` 的 list / overview / search（backlog-tool.ts）
 *   3. 单测：src/backlog-query.test.ts 逐条对照上游语义
 *
 * 纯函数约束：不碰 IO、不读 clock、不改入参（返回新对象），因此 UI 侧如需本地即时筛选
 * 也能照抄同一规则（当前实现由服务端过滤，UI 只渲染）。
 *
 * 与上游（MrLesk/Backlog.md v1.55.3）的语义对应见 doc §2；已知差异：
 *  - `search`：上游 Fuse 模糊匹配，这里「空白切词 + 全部子串命中」（确定性、无依赖）；
 *  - `assignee`：上游精确匹配，这里包含匹配（兼容既有「仅分配给我」的宽松行为）；
 *  - 默认排序：上游 ordinal→priority→id，这里沿用 WorkBuddy 既有 createdAt 倒序（TASK-SORT-2）。
 */
import {
  compareBacklogIds,
  normalizeItemId,
  sortBacklogItemsBy,
  type BacklogItem,
  type BacklogOrderBy,
} from './backlog.js'

// ---------------------------------------------------------------- 类型

/** 解析后的查询条件（API / 工具 / 前端共用同一形状） */
export interface BacklogQuery {
  /** `--status`：只保留这些状态（大小写不敏感，多值并集） */
  status?: string[]
  /** `--exclude-status`：排除这些状态（与 status 同时给时排除优先） */
  excludeStatus?: string[]
  /** `--assignee`：按指派人匹配（包含匹配；可带或不带 `@`） */
  assignee?: string[]
  /** `--unassigned`：只要没有指派人的条目（与 assignee 互斥） */
  unassigned?: boolean
  /** `--priority`：优先级多值（归一化 lower 后并集） */
  priority?: string[]
  /** `--type`：任务类型多值 */
  type?: string[]
  /** `--labels`：标签多值；`labelMatch` 决定全部命中还是任一命中（上游 --labels = all） */
  labels?: string[]
  labelMatch?: 'all' | 'any'
  /** `--milestone`：里程碑；`__none__` = 只要没有里程碑的条目 */
  milestone?: string
  /** `--project`（frontmatter 组件名，避免与 WorkBuddy 项目混淆） */
  taskProject?: string[]
  /** `--parent`：只要该父任务的子任务（itemId 归一化比较） */
  parent?: string
  /** `--search`：全文检索词（空白切词、全部子串命中） */
  search?: string
  /** `--ready`：未完成且依赖全部完成 */
  ready?: boolean
  /** 扩展：被阻塞（有未完成/未知依赖） */
  blocked?: boolean
  /** 兼容旧工具语义：includeDone=false ≡ openOnly=true */
  includeDone?: boolean
  /** 按各项目自身状态配置排除已关闭状态（done/完成/cancel/取消/末位状态） */
  openOnly?: boolean
  /** 排序维度（orderBy 为旧参数别名）：缺省 createdAt */
  sort?: BacklogOrderBy
  order?: 'asc' | 'desc'
  /** 展示条数上限（limit 与 maxCount 同时给时取较小值） */
  limit?: number
  /** 窗口偏移（在过滤 + 排序之后应用） */
  skip?: number
  maxCount?: number
  /** 只要计数，不要条目明细 */
  count?: boolean
  /** WorkBuddy 项目作用域（仅 overview 使用；不参与条目过滤，由调用方筛项目） */
  projectIds?: string[]
}

export interface BacklogReadiness {
  /** 可以开工：未完成 + 依赖全部完成 */
  isReady: boolean
  /** 不可开工：至少一个依赖未完成或无法解析（fail-closed） */
  blocked: boolean
  /** 解析到「未完成」状态的依赖 ID */
  blockingDependencies: string[]
  /** 解析不到唯一任务的依赖 ID */
  missingDependencies: string[]
}

export interface BacklogCounts {
  /** 未关闭条目数（openOnly 同一判定） */
  open: number
  /** 已关闭条目数 */
  done: number
  ready: number
  blocked: number
  unassigned: number
}

export interface BacklogFacetValue {
  value: string
  count: number
}

/** 各查询维度的可选值 + 计数（未过滤语料上统计，供 UI 生成筛选项） */
export interface BacklogFacets {
  statuses: BacklogFacetValue[]
  priorities: BacklogFacetValue[]
  types: BacklogFacetValue[]
  labels: BacklogFacetValue[]
  assignees: BacklogFacetValue[]
  milestones: BacklogFacetValue[]
  taskProjects: BacklogFacetValue[]
}

export interface BacklogWindow {
  skip: number
  /** 过滤后、窗口前总数 */
  total: number
  /** 下一个 skip（无更多为 null） */
  nextSkip: number | null
  /** 是否被窗口截断 */
  cut: boolean
  /** 本窗口实际返回条数 */
  shown: number
}

export type BacklogQueryItem<T extends BacklogItem> = T & BacklogReadiness

export interface BacklogQueryResult<T extends BacklogItem> {
  /** 命中且已排序 + 切窗的条目（附带 readiness 派生字段） */
  items: BacklogQueryItem<T>[]
  /** 输入语料总条数（未过滤） */
  total: number
  /** 过滤后、窗口前条数 */
  matched: number
  counts: BacklogCounts
  window: BacklogWindow
  /** 未过滤语料的分面统计 */
  facets: BacklogFacets
}

export interface BacklogQueryContext {
  /** 项目状态配置（config.yml statuses）；缺省按 DEFAULT_STATUSES */
  statuses?: string[]
}

export interface BacklogQueryParse {
  query: BacklogQuery
  /** 参数错误（调用方转 400 INVALID_QUERY / 工具 ok:false）；空数组 = 合法 */
  errors: string[]
}

/** `milestone=__none__`：只要没有里程碑的条目（与上游 NO_MILESTONE_FILTER_VALUE 对应） */
export const NO_MILESTONE_QUERY_VALUE = '__none__'

const DEFAULT_QUERY_STATUSES = ['To Do', 'In Progress', 'Done']
const CLOSED_STATUS_RE = /done|完成|cancel|取消|closed|关闭|放弃|归档/i

// ---------------------------------------------------------------- 基础判定

/** 终态 = config.statuses 末位（与上游 src/utils/terminal-status.ts 一致） */
export function isTerminalStatus(status: string | undefined, statuses: string[]): boolean {
  const list = statuses.length ? statuses : DEFAULT_QUERY_STATUSES
  const terminal = list[list.length - 1]
  if (!terminal) return false
  return String(status || '').trim().toLowerCase() === terminal.trim().toLowerCase()
}

/**
 * 「已关闭」判定（openOnly / done 计数用）：终态 或 语义上表示完成/取消/关闭的状态名。
 * 比 isTerminalStatus 宽，因为真实项目会把 `Cancelled`/`已取消` 之类追加在 Done 之后。
 */
export function isClosedStatus(status: string | undefined, statuses: string[]): boolean {
  const s = String(status || '').trim()
  if (!s) return false
  return isTerminalStatus(s, statuses) || CLOSED_STATUS_RE.test(s)
}

/** 汇总语料的 ID 索引：归一化 id → 条目；重复 id 记为歧义（依赖解析 fail-closed） */
function buildIdIndex(items: BacklogItem[]): Map<string, BacklogItem | null> {
  const index = new Map<string, BacklogItem | null>()
  for (const it of items) {
    const key = normalizeItemId(it.itemId || '')
    if (!key) continue
    index.set(key, index.has(key) ? null : it)
  }
  return index
}

/**
 * 计算全部条目的就绪状态（一次建索引，列表查询不再逐条解析依赖）。
 * 语义与上游 `createReadinessGraph` / `getTaskReadiness` 对齐，见 doc §3。
 */
export function computeReadiness(
  items: BacklogItem[],
  statuses: string[] = DEFAULT_QUERY_STATUSES,
): Map<string, BacklogReadiness> {
  const index = buildIdIndex(items)
  const out = new Map<string, BacklogReadiness>()
  for (const it of items) {
    const key = normalizeItemId(it.itemId || '')
    const readiness = readinessOf(it, statuses, index)
    if (key) out.set(key, readiness)
  }
  return out
}

function readinessOf(
  item: BacklogItem,
  statuses: string[],
  index: Map<string, BacklogItem | null>,
): BacklogReadiness {
  const notActionable: BacklogReadiness = {
    isReady: false,
    blocked: false,
    blockingDependencies: [],
    missingDependencies: [],
  }
  // 已完成（终态）的条目既不是 ready 也不是 blocked
  if (isTerminalStatus(item.status, statuses)) return notActionable
  const deps = item.dependencies || []
  if (deps.length === 0) {
    return { isReady: true, blocked: false, blockingDependencies: [], missingDependencies: [] }
  }
  const blockingDependencies: string[] = []
  const missingDependencies: string[] = []
  for (const dep of deps) {
    const hit = index.get(normalizeItemId(dep))
    if (hit === undefined || hit === null) missingDependencies.push(dep)
    else if (!isTerminalStatus(hit.status, statuses)) blockingDependencies.push(hit.itemId || dep)
  }
  const blocked = blockingDependencies.length > 0 || missingDependencies.length > 0
  return { isReady: !blocked, blocked, blockingDependencies, missingDependencies }
}

/** ready/blocked 过滤用的单条判定（列表与详情共用同一规则） */
export function readinessOfItem(item: BacklogItem, all: BacklogItem[], statuses: string[] = DEFAULT_QUERY_STATUSES): BacklogReadiness {
  return readinessOf(item, statuses, buildIdIndex(all))
}

// ---------------------------------------------------------------- 参数解析

function toList(value: unknown): string[] {
  if (value === undefined || value === null) return []
  const flat: string[] = []
  const push = (v: unknown) => {
    if (v === undefined || v === null) return
    const s = String(v).trim()
    if (!s) return
    for (const part of s.split(',')) {
      const p = part.trim()
      if (p) flat.push(p)
    }
  }
  if (Array.isArray(value)) for (const v of value) push(v)
  else push(value)
  return flat
}

function readParam(src: URLSearchParams | Record<string, unknown>, names: string[]): unknown {
  if (src instanceof URLSearchParams) {
    const out: string[] = []
    for (const name of names) for (const v of src.getAll(name)) out.push(v)
    return out.length === 0 ? undefined : out
  }
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(src, name) && src[name] !== undefined) return src[name]
  }
  return undefined
}

function parseBool(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const s = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on', 'y'].includes(s)) return true
  if (['0', 'false', 'no', 'off', 'n'].includes(s)) return false
  return undefined
}

function parseIntStrict(value: unknown, min: number, field: string, errors: string[]): number | undefined {
  if (value === undefined || value === null) return undefined
  const raw = String(Array.isArray(value) ? value[value.length - 1] : value).trim()
  if (!/^-?\d+$/.test(raw)) {
    errors.push(`${field} 必须是整数（收到 "${raw}"）`)
    return undefined
  }
  const n = Number.parseInt(raw, 10)
  if (n < min) {
    errors.push(`${field} 必须 ≥ ${min}（收到 ${n}）`)
    return undefined
  }
  return n
}

const SORT_ALIASES: Record<string, BacklogOrderBy> = {
  // 上游 --sort 取值
  priority: 'priority',
  id: 'id',
  ordinal: 'ordinal',
  // WorkBuddy 既有 orderBy 取值 + 常见别名
  status: 'status',
  createdat: 'createdAt',
  created_at: 'createdAt',
  created: 'createdAt',
  createddate: 'createdAt',
  updatedat: 'updatedAt',
  updated_at: 'updatedAt',
  updated: 'updatedAt',
  updateddate: 'updatedAt',
}

/** 解析排序维度：非法/缺省回退 createdAt（宽松，不报错——与既有 orderBy 解析一致） */
export function parseSortField(raw: unknown): BacklogOrderBy {
  const v = String(raw ?? '').trim().toLowerCase()
  return SORT_ALIASES[v] ?? 'createdAt'
}

const SORT_FIELD_VALUES: BacklogOrderBy[] = ['priority', 'id', 'ordinal', 'createdAt', 'updatedAt', 'status']

/** 排序维度候选（UI 控件用） */
export function backlogSortFields(): BacklogOrderBy[] {
  return [...SORT_FIELD_VALUES]
}

/**
 * 解析查询条件：URLSearchParams（REST）或普通对象（工具通道 JSON）同一入口。
 * 多值参数支持「重复参数」与「逗号分隔」两种写法（对齐上游 CLI 文档）。
 */
export function parseBacklogQuery(src?: URLSearchParams | Record<string, unknown>): BacklogQueryParse {
  const query: BacklogQuery = {}
  const errors: string[] = []
  if (!src) return { query, errors }

  const status = toList(readParam(src, ['status', 'statuses']))
  if (status.length) query.status = status
  const excludeStatus = toList(readParam(src, ['excludeStatus', 'exclude-status', 'excludeStatuses']))
  if (excludeStatus.length) query.excludeStatus = excludeStatus

  const assignee = toList(readParam(src, ['assignee', 'assignees']))
  if (assignee.length) query.assignee = assignee
  const unassigned = parseBool(readParam(src, ['unassigned']))
  if (unassigned !== undefined) query.unassigned = unassigned

  if (query.unassigned && query.assignee?.length) {
    errors.push('unassigned 与 assignee 不能同时使用（前者=只要未指派，后者=按指派人匹配）')
  }

  const priority = toList(readParam(src, ['priority', 'priorities']))
  if (priority.length) query.priority = priority
  const type = toList(readParam(src, ['type', 'types', 'taskType', 'taskTypes']))
  if (type.length) query.type = type

  const labels = toList(readParam(src, ['labels', 'label']))
  if (labels.length) query.labels = labels
  const labelMatchRaw = String(readParam(src, ['labelMatch', 'label-match']) ?? '').trim().toLowerCase()
  if (labelMatchRaw) {
    if (labelMatchRaw === 'all' || labelMatchRaw === 'any') query.labelMatch = labelMatchRaw
    else errors.push(`labelMatch 只能是 all 或 any（收到 "${labelMatchRaw}"）`)
  }

  const milestone = String(readParam(src, ['milestone']) ?? '').trim()
  if (milestone) query.milestone = milestone

  const taskProject = toList(readParam(src, ['taskProject', 'task-project', 'project', 'projects']))
  if (taskProject.length) query.taskProject = taskProject

  const parent = String(readParam(src, ['parent', 'parentTaskId']) ?? '').trim()
  if (parent) query.parent = parent
  // 空字符串 parent 不得静默降级为「不过滤」（上游同约束）
  if (src instanceof URLSearchParams ? src.has('parent') : Object.prototype.hasOwnProperty.call(src, 'parent')) {
    if (!parent) errors.push('parent 不能为空（省略该参数表示不过滤）')
  }

  const search = String(readParam(src, ['search', 'q', 'query']) ?? '').trim()
  if (search) query.search = search

  const ready = parseBool(readParam(src, ['ready']))
  if (ready !== undefined) query.ready = ready
  const blocked = parseBool(readParam(src, ['blocked', 'isBlocked']))
  if (blocked !== undefined) query.blocked = blocked

  const includeDone = parseBool(readParam(src, ['includeDone', 'include-done']))
  if (includeDone !== undefined) query.includeDone = includeDone
  const openOnly = parseBool(readParam(src, ['openOnly', 'open-only']))
  if (openOnly !== undefined) query.openOnly = openOnly
  if (includeDone === false) query.openOnly = true

  const sortRaw = readParam(src, ['sort', 'orderBy', 'order-by'])
  if (sortRaw !== undefined) query.sort = parseSortField(sortRaw)
  const orderRaw = String(readParam(src, ['order', 'dir']) ?? '').trim().toLowerCase()
  if (orderRaw) {
    if (orderRaw === 'asc' || orderRaw === 'desc') query.order = orderRaw
    else errors.push(`order 只能是 asc 或 desc（收到 "${orderRaw}"）`)
  }

  const limit = parseIntStrict(readParam(src, ['limit']), 1, 'limit', errors)
  if (limit !== undefined) query.limit = limit
  const maxCount = parseIntStrict(readParam(src, ['maxCount', 'max-count']), 1, 'maxCount', errors)
  if (maxCount !== undefined) query.maxCount = maxCount
  const skip = parseIntStrict(readParam(src, ['skip']), 0, 'skip', errors)
  if (skip !== undefined) query.skip = skip
  const count = parseBool(readParam(src, ['count']))
  if (count !== undefined) query.count = count

  const projectIds = toList(readParam(src, ['projectIds', 'project-ids']))
  if (projectIds.length) query.projectIds = projectIds

  return { query, errors }
}

// ---------------------------------------------------------------- 匹配

function normalizeText(v: string | undefined): string {
  return String(v ?? '').trim().toLowerCase()
}

/** 指派人匹配：大小写不敏感、忽略前缀 `@`，双向包含（兼容「仅分配给我」既有行为） */
function assigneeMatches(have: string, want: string): boolean {
  const a = normalizeText(have).replace(/^@+/, '')
  const b = normalizeText(want).replace(/^@+/, '')
  if (!a || !b) return false
  return a === b || a.indexOf(b) >= 0 || b.indexOf(a) >= 0
}

function searchMatches(item: BacklogItem, search: string): boolean {
  const hay = item.searchText ?? ''
  const tokens = normalizeText(search).split(/\s+/).filter(Boolean)
  if (!tokens.length) return true
  for (const token of tokens) if (hay.indexOf(token) < 0) return false
  return true
}

/** 里程碑匹配：`__none__` = 无里程碑；否则精确 id/标题（含 m-8 / 8 数字别名）→ 退化为标题包含 */
function milestoneMatches(item: BacklogItem, want: string): boolean {
  const have = normalizeText(item.milestone)
  const target = normalizeText(want)
  if (!target) return true
  if (target === NO_MILESTONE_QUERY_VALUE) return !have
  if (!have) return false
  if (have === target) return true
  const numeric = (v: string): string | undefined => {
    const m = /^(?:m-)?(\d+)$/.exec(v)
    return m ? m[1].replace(/^0+(?=\d)/, '') : undefined
  }
  const targetNum = numeric(target)
  if (targetNum !== undefined) {
    const haveNum = numeric(have)
    if (haveNum !== undefined) return haveNum === targetNum
  }
  return have.indexOf(target) >= 0
}

/** 单条是否命中查询（readiness 由调用方传入；缺省时按单条 + 自身为语料降级计算） */
export function matchesBacklogQuery(
  item: BacklogItem,
  query: BacklogQuery,
  ctx: BacklogQueryContext & { readiness?: BacklogReadiness } = {},
): boolean {
  const statuses = ctx.statuses?.length ? ctx.statuses : DEFAULT_QUERY_STATUSES
  const status = normalizeText(item.status)

  if (query.status?.length) {
    const wanted = new Set(query.status.map((s) => normalizeText(s)).filter(Boolean))
    if (!wanted.has(status)) return false
  }
  if (query.excludeStatus?.length) {
    const excluded = new Set(query.excludeStatus.map((s) => normalizeText(s)).filter(Boolean))
    if (excluded.has(status)) return false
  }

  if (query.assignee?.length) {
    const have = item.assignees || []
    if (!have.some((a) => query.assignee!.some((want) => assigneeMatches(a, want)))) return false
  }
  if (query.unassigned) {
    if ((item.assignees || []).some((a) => String(a).trim().length > 0)) return false
  }

  if (query.priority?.length) {
    const wanted = new Set(query.priority.map((p) => normalizeText(p)).filter(Boolean))
    if (!wanted.has(normalizeText(item.priority))) return false
  }
  if (query.type?.length) {
    const wanted = new Set(query.type.map((t) => normalizeText(t)).filter(Boolean))
    if (!wanted.has(normalizeText(item.type))) return false
  }
  if (query.labels?.length) {
    const have = new Set((item.labels || []).map((l) => normalizeText(l)).filter(Boolean))
    const wanted = query.labels.map((l) => normalizeText(l)).filter(Boolean)
    const ok = query.labelMatch === 'any' ? wanted.some((l) => have.has(l)) : wanted.every((l) => have.has(l))
    if (!ok) return false
  }
  if (query.milestone !== undefined) {
    if (!milestoneMatches(item, query.milestone)) return false
  }
  if (query.taskProject?.length) {
    const wanted = new Set(query.taskProject.map((p) => normalizeText(p)).filter(Boolean))
    if (!wanted.has(normalizeText(item.taskProject))) return false
  }
  if (query.parent) {
    if (!item.parentTaskId || normalizeItemId(item.parentTaskId) !== normalizeItemId(query.parent)) return false
  }
  if (query.search) {
    if (!searchMatches(item, query.search)) return false
  }
  if (query.openOnly) {
    if (isClosedStatus(item.status, statuses)) return false
  }

  if (query.ready || query.blocked) {
    const readiness = ctx.readiness ?? readinessOf(item, statuses, buildIdIndex([item]))
    if (query.ready && !readiness.isReady) return false
    if (query.blocked && !readiness.blocked) return false
  }

  return true
}

// ---------------------------------------------------------------- 分面

function facetPush(map: Map<string, { value: string; count: number }>, raw: string | undefined): void {
  const text = String(raw ?? '').trim()
  if (!text) return
  const key = text.toLowerCase()
  const hit = map.get(key)
  if (hit) hit.count++
  else map.set(key, { value: text, count: 1 })
}

function facetList(
  map: Map<string, { value: string; count: number }>,
  order: string[] = [],
): BacklogFacetValue[] {
  const orderIdx = new Map(order.map((v, i) => [v.trim().toLowerCase(), i]))
  return [...map.values()].sort((a, b) => {
    const ai = orderIdx.get(a.value.toLowerCase())
    const bi = orderIdx.get(b.value.toLowerCase())
    if (ai !== undefined || bi !== undefined) {
      return (ai === undefined ? Number.MAX_SAFE_INTEGER : ai) - (bi === undefined ? Number.MAX_SAFE_INTEGER : bi)
    }
    if (a.count !== b.count) return b.count - a.count
    return a.value.localeCompare(b.value)
  })
}

/** 统计各查询维度的可选值（**未过滤语料**；UI 用它生成筛选项，避免选了就消失） */
export function buildBacklogFacets(items: BacklogItem[], statuses: string[] = DEFAULT_QUERY_STATUSES): BacklogFacets {
  const statusMap = new Map<string, { value: string; count: number }>()
  const priorityMap = new Map<string, { value: string; count: number }>()
  const typeMap = new Map<string, { value: string; count: number }>()
  const labelMap = new Map<string, { value: string; count: number }>()
  const assigneeMap = new Map<string, { value: string; count: number }>()
  const milestoneMap = new Map<string, { value: string; count: number }>()
  const taskProjectMap = new Map<string, { value: string; count: number }>()
  for (const it of items) {
    facetPush(statusMap, it.status)
    facetPush(priorityMap, it.priority)
    facetPush(typeMap, it.type)
    for (const l of it.labels || []) facetPush(labelMap, l)
    for (const a of it.assignees || []) facetPush(assigneeMap, a)
    facetPush(milestoneMap, it.milestone)
    facetPush(taskProjectMap, it.taskProject)
  }
  // 状态按项目配置顺序（未配置的按计数降序垫底）
  const priorityOrder = defaultPriorityOrder()
  return {
    statuses: facetList(statusMap, statuses),
    priorities: facetList(priorityMap, priorityOrder),
    types: facetList(typeMap),
    labels: facetList(labelMap),
    assignees: facetList(assigneeMap),
    milestones: facetList(milestoneMap),
    taskProjects: facetList(taskProjectMap),
  }
}

/** 优先级从高到低的归一化取值（未配置时的缺省：high→medium→low） */
function defaultPriorityOrder(): string[] {
  return ['high', 'medium', 'low']
}

// ---------------------------------------------------------------- 主流程

/**
 * 应用过滤 + 排序 + 窗口，返回条目与统计。
 *
 * 顺序严格对齐上游 `runTaskList`：**先过滤 → 再排序 → 最后切窗**（`--limit/--max-count/--skip` 在排序后）。
 * `ready`/`blocked` 依赖全量语料（`items` 必须是项目全量，不能是已过滤子集），否则依赖被筛掉会误判。
 */
export function applyBacklogQuery<T extends BacklogItem>(
  items: T[],
  query: BacklogQuery,
  ctx: BacklogQueryContext = {},
): BacklogQueryResult<T> {
  const statuses = ctx.statuses?.length ? ctx.statuses : DEFAULT_QUERY_STATUSES
  const readiness = computeReadiness(items, statuses)
  const facets = buildBacklogFacets(items, statuses)

  // 未过滤语料的计数（UI 显示「就绪 N / 阻塞 M」等）
  const counts: BacklogCounts = { open: 0, done: 0, ready: 0, blocked: 0, unassigned: 0 }
  for (const it of items) {
    const r = readiness.get(normalizeItemId(it.itemId || ''))
    if (isClosedStatus(it.status, statuses)) counts.done++
    else counts.open++
    if (r?.isReady) counts.ready++
    if (r?.blocked) counts.blocked++
    if (!(it.assignees || []).some((a) => String(a).trim().length > 0)) counts.unassigned++
  }

  const matched = items
    .filter((it) =>
      matchesBacklogQuery(it, query, {
        statuses,
        readiness: readiness.get(normalizeItemId(it.itemId || '')),
      }),
    )
    .map((it) => ({
      ...it,
      ...(readiness.get(normalizeItemId(it.itemId || '')) ?? {
        isReady: false,
        blocked: false,
        blockingDependencies: [],
        missingDependencies: [],
      }),
    }))

  const sorted = sortBacklogItemsBy(matched, statuses, query.sort ?? 'createdAt', query.order ?? 'desc')

  // 上游顺序：过滤 → 排序 → `--limit`（硬截断）→ `--skip/--max-count` 窗口（list-window）。
  // limit 必须在窗口之前生效，否则 `limit=10&skip=5` 会越出 limit 取到第 15 条（与 CLI 不一致）。
  const limited = query.limit === undefined ? sorted : sorted.slice(0, query.limit)
  const skip = query.skip ?? 0
  const end = query.maxCount === undefined ? limited.length : Math.min(limited.length, skip + query.maxCount)
  const windowItems = limited.slice(skip, end)

  return {
    items: query.count ? [] : windowItems,
    total: items.length,
    matched: sorted.length,
    counts,
    window: {
      skip,
      total: sorted.length,
      nextSkip: end < limited.length ? end : null,
      cut: end - skip < limited.length,
      shown: query.count ? 0 : windowItems.length,
    },
    facets,
  }
}

/** 计数投影（`count=1` 用；不含条目明细，也不做排序/切窗） */
export function countBacklogQuery(
  items: BacklogItem[],
  query: BacklogQuery,
  ctx: BacklogQueryContext = {},
): BacklogCounts & { total: number; matched: number } {
  const statuses = ctx.statuses?.length ? ctx.statuses : DEFAULT_QUERY_STATUSES
  const result = applyBacklogQuery(items, { ...query, count: true, skip: 0, limit: undefined, maxCount: undefined }, { statuses })
  return { ...result.counts, total: result.total, matched: result.matched }
}

/** 多值参数拼接为查询串（前端/测试共用；空值忽略） */
export function backlogQueryToSearchParams(query: BacklogQuery): string {
  const parts: string[] = []
  const add = (name: string, value: string | number | boolean | undefined) => {
    if (value === undefined || value === '') return
    parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`)
  }
  const addList = (name: string, values?: string[]) => {
    if (!values?.length) return
    for (const v of values) add(name, v)
  }
  addList('status', query.status)
  addList('excludeStatus', query.excludeStatus)
  addList('assignee', query.assignee)
  if (query.unassigned) add('unassigned', '1')
  addList('priority', query.priority)
  addList('type', query.type)
  addList('labels', query.labels)
  add('labelMatch', query.labelMatch)
  add('milestone', query.milestone)
  addList('taskProject', query.taskProject)
  add('parent', query.parent)
  add('search', query.search)
  if (query.ready) add('ready', '1')
  if (query.blocked) add('blocked', '1')
  if (query.openOnly) add('openOnly', '1')
  if (query.includeDone !== undefined) add('includeDone', query.includeDone ? '1' : '0')
  add('sort', query.sort)
  add('order', query.order)
  add('limit', query.limit)
  add('maxCount', query.maxCount)
  add('skip', query.skip)
  if (query.count) add('count', '1')
  addList('projectIds', query.projectIds)
  return parts.join('&')
}
