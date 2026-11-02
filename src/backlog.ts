/**
 * Backlog 集成数据层（docs/design-backlog-integration.md §3/§5.1）。
 *
 * backlog 的唯一事实源在 DSH 节点项目工作区：<workspace>/backlog/ 目录
 * （tasks/task-<n> - <slug>.md 每条一文件 + config.yml），采纳 Backlog.md 上游
 * 声明格式但不引入其进程依赖；WorkBuddy 通过 /fs/* 读写文件做门面。
 *
 * 编解码原则（宽容保真）：
 *  - frontmatter 逐行解析声明字段，未声明字段与原始顺序/缩进保留，写回只改目标字段；
 *  - 正文与段标记（SECTION:DESCRIPTION / AC / FINAL_SUMMARY 的 BEGIN/END）原样保留；
 *  - 执行记录只做文末追加，不触碰既有内容（§3.4 无锁兜底：乐观读改写）。
 */
import type { DshClient, DshTarget } from './remote-client.js'

export const BACKLOG_DIR = 'backlog'
export const BACKLOG_TASKS_DIR = 'backlog/tasks'

/** 上游缺省状态（config.yml 缺失/不可解析时使用；与 v1.55.3 实测一致） */
export const DEFAULT_STATUSES = ['To Do', 'In Progress', 'Done'] as const
export const DEFAULT_TASK_PREFIX = 'task'

export class BacklogConflictError extends Error {
  constructor(message = '内容已被其他人/agent 更新，请刷新后重试') {
    super(message)
    this.name = 'BacklogConflictError'
  }
}

export class BacklogNotInitializedError extends Error {
  constructor(message = 'backlog 未初始化') {
    super(message)
    this.name = 'BacklogNotInitializedError'
  }
}

/** frontmatter 声明字段（宽容：均可缺省） */
export interface BacklogFields {
  id?: string
  title?: string
  status?: string
  assignees?: string[]
  labels?: string[]
  dependencies?: string[]
  createdDate?: string
  updatedDate?: string
  ordinal?: number
  priority?: string
  dueDate?: string
  // ---- Backlog.md v1.55.3 frontmatter 的其余可查询字段（docs/design-backlog-query-filters.md §2）----
  /** `--type` 语义任务类型（bug/feature/…，取自 config types；缺省=未分类） */
  type?: string
  /** `--milestone` 里程碑 ID 或标题（上游存的是人读值，匹配时同时尝试 id 与标题） */
  milestone?: string
  /** frontmatter `project`（monorepo 组件名）。名字避开 WorkBuddy 的「项目」，故叫 taskProject */
  taskProject?: string
  /** frontmatter `parent_task_id`：父任务 ID（`--parent` 过滤用） */
  parentTaskId?: string
  /** frontmatter `subtasks`：子任务 ID 列表（上游声明字段，查询侧只透传） */
  subtasks?: string[]
  /** frontmatter `reporter`：登记人（metadata 参与 --search） */
  reporter?: string
}

export interface BacklogItem extends BacklogFields {
  /** frontmatter id（权威键，如 TASK-1；§3.2 修正 1） */
  itemId: string
  fileName: string
  filePath: string
  /** 验收进度（正文 AC 段 `- [x]` 计数；无 AC 段为 undefined） */
  acceptance?: { total: number; done: number }
  /** 有 Final Summary 或文末执行记录条目（启发：出现 `### ` 执行记录标题行） */
  hasExecutionRecord?: boolean
  /**
   * 正文里的来源标记（`<!-- wb:source=<key> -->`）：未完成事项采集用来跨轮去重。
   * 列表阶段就从已下载的 raw 里正则提取，不额外拉文件；无标记的条目该字段缺省。
   */
  sourceKeys?: string[]
  /**
   * 描述正文（仅 `listBacklog({ withBodies: true })` 时填充）。
   * 默认不填：列表只要元数据；正文段解析是 search 这类全量检索才需要的额外成本。
   */
  description?: string
  /**
   * 检索用正文（小写；frontmatter 字段 + 正文全文，`--search` 的语料）。
   * **仅服务端内部使用**：HTTP/工具回包必须剥离（体积与 token 预算），由 router/tool 层负责。
   */
  searchText?: string
}

export interface BacklogConfig {
  projectName?: string
  statuses: string[]
  defaultStatus: string
  taskPrefix: string
}

/** 节点目录下任务的完整读取结果 */
export interface BacklogListResult {
  initialized: boolean
  truncated: boolean
  config: BacklogConfig
  items: BacklogItem[]
}

// ---------- config.yml 极简解析（子集：顶层 key: value 与 key: [a, b] 数组） ----------

export function parseConfigYml(raw: string): BacklogConfig {
  const cfg: BacklogConfig = { statuses: [...DEFAULT_STATUSES], defaultStatus: DEFAULT_STATUSES[0], taskPrefix: DEFAULT_TASK_PREFIX }
  const lines = raw.split(/\r?\n/)
  for (const line of lines) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1].toLowerCase()
    let val = m[2].trim()
    if (val.startsWith('[') && val.endsWith(']')) {
      const items = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
      if (key === 'statuses' && items.length) cfg.statuses = items
      continue
    }
    val = val.replace(/^["']|["']$/g, '')
    if (!val) continue
    if (key === 'project_name') cfg.projectName = val
    else if (key === 'default_status' && cfg.statuses.includes(val)) cfg.defaultStatus = val
    else if (key === 'task_prefix') cfg.taskPrefix = val || DEFAULT_TASK_PREFIX
  }
  if (!cfg.statuses.includes(cfg.defaultStatus)) cfg.defaultStatus = cfg.statuses[0]
  return cfg
}

/** 「已完成」状态判定（§3.2 修正 2：状态人读名可配置，不硬编码）：名含 done/完成 优先，否则取末位 */
export function resolveDoneStatus(statuses: string[]): string {
  const hit = statuses.find((s) => /done|完成/i.test(s))
  return hit || statuses[statuses.length - 1]
}

/** 「进行中」状态判定：名含 progress/进行 优先，否则第二位（仅一档状态时返回 undefined 表示无从置进行中） */
export function resolveInProgressStatus(statuses: string[]): string | undefined {
  const hit = statuses.find((s) => /progress|进行/i.test(s))
  if (hit) return hit
  return statuses.length > 1 ? statuses[1] : undefined
}

// ---------- frontmatter 保真编解码 ----------

interface FmField {
  key: string
  /** 该字段在 fmLines 中的起始行下标（含 key 行） */
  start: number
  /** 结束行下标（含，闭区间；标量 = start，块列表 = 到最后一个 `- ` 行） */
  end: number
}

interface DecodedFrontmatter {
  fields: BacklogFields
  /** 标量行下标映射（数组字段无） */
  scalarIdx: Map<string, number>
  blocks: Map<string, FmField>
  fmEnd: number
}

function unquote(v: string): string {
  const t = v.trim()
  return /^".*"$/.test(t) || /^'.*'$/.test(t) ? t.slice(1, -1) : t
}

function quoteIfNeeded(v: string): string {
  return /[:#\[\]{}&*!|>'"%@`,]/.test(v) ? `'${v.replace(/'/g, "''")}'` : v
}

/** 行内数组（Backlog.md 也接受 `labels: [a, b]` 写法；宽容解析，非法即忽略） */
function parseInlineArray(val: string): string[] | undefined {
  const v = val.trim()
  if (!(v.startsWith('[') && v.endsWith(']'))) return undefined
  return v
    .slice(1, -1)
    .split(',')
    .map((x) => unquote(x))
    .filter((x) => x !== '')
}

/** 逐行解析 frontmatter：已知字段收集 + 行位置登记（写回时按位置原位改写） */
export function decodeFrontmatter(raw: string): { fields: BacklogFields; meta: DecodedFrontmatter } {
  const lines = raw.split(/\r?\n/)
  const fields: BacklogFields = {}
  const scalarIdx = new Map<string, number>()
  const blocks = new Map<string, FmField>()
  let fmEnd = -1
  if (lines[0]?.trim() !== '---') return { fields, meta: { fields, scalarIdx, blocks, fmEnd } }
  let i = 1
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '---') {
      fmEnd = i
      break
    }
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (m) {
      const key = m[1]
      const val = m[2].trim()
      if (val === '' ) {
        // 块列表字段：吞并后续 `- ` 行
        let j = i + 1
        while (j < lines.length && /^(\s*)-\s+/.test(lines[j]) && lines[j].trim() !== '---') j++
        blocks.set(key, { key, start: i, end: j - 1 })
        const items = lines
          .slice(i + 1, j)
          .map((l) => unquote(l.replace(/^\s*-\s+/, '')))
          .filter((s) => s !== '')
        if (key === 'labels') fields.labels = items
        else if (key === 'dependencies') fields.dependencies = items
        else if (key === 'assignee') fields.assignees = items
        else if (key === 'subtasks') fields.subtasks = items
      } else {
        // 行内数组：`labels: [a, b]` / `assignee: [x]` / `dependencies: [task-1]`（上游也接受该写法）
        const inlineArr = parseInlineArray(val)
        if (inlineArr) {
          if (key === 'labels') fields.labels = inlineArr
          else if (key === 'dependencies') fields.dependencies = inlineArr
          else if (key === 'assignee') fields.assignees = inlineArr
          else if (key === 'subtasks') fields.subtasks = inlineArr
          i++
          continue
        }
        scalarIdx.set(key, i)
        const v = unquote(val)
        if (key === 'id') fields.id = v
        else if (key === 'title') fields.title = v
        else if (key === 'status') fields.status = v
        else if (key === 'created_date') fields.createdDate = v
        else if (key === 'updated_date') fields.updatedDate = v
        else if (key === 'priority') fields.priority = v
        else if (key === 'due_date') fields.dueDate = v
        else if (key === 'type') fields.type = v
        else if (key === 'milestone') fields.milestone = v
        else if (key === 'project') fields.taskProject = v
        else if (key === 'parent_task_id') fields.parentTaskId = v
        else if (key === 'reporter') fields.reporter = v
        else if (key === 'ordinal') {
          const n = Number(v)
          if (Number.isFinite(n)) fields.ordinal = n
        }
      }
    }
    i++
  }
  return { fields, meta: { fields, scalarIdx, blocks, fmEnd } }
}

function joinLines(lines: string[]): string {
  return lines.join('\n')
}

/** 在原 frontmatter 文本上原位改写字段；缺失字段追加到 fm 尾部；未知字段与顺序原样保留 */
export function encodeFrontmatter(raw: string, patch: Partial<BacklogFields>): string {
  const { meta } = decodeFrontmatter(raw)
  if (meta.fmEnd < 0) return raw
  const lines = raw.split(/\r?\n/)
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const applyScalar = (key: string, value: string | number | undefined) => {
    if (value === undefined) return // 未给值 = 不改动（宽容原则）
    const idx = meta.scalarIdx.get(key)
    const text = value === '' ? '' : quoteIfNeeded(String(value))
    if (idx !== undefined) {
      lines[idx] = `${key}: ${text}`
    } else if (text) {
      lines.splice(meta.fmEnd, 0, `${key}: ${text}`)
      meta.fmEnd++
    }
  }
  const applyBlock = (key: string, items: string[] | undefined) => {
    if (items === undefined) return // 未显式给值的块字段保持原样（宽容原则：只改目标字段）
    const block = meta.blocks.get(key)
    const body = items.map((it) => `  - ${quoteIfNeeded(it)}`)
    if (block) {
      const replaceCount = block.end - block.start + 1
      lines.splice(block.start, replaceCount, `${key}:`, ...body)
      const delta = body.length + 1 - replaceCount
      // 平移后续已登记行位（blocks/scalars 均可能落在其后）
      for (const [k, idx] of meta.scalarIdx) if (idx > block.end) meta.scalarIdx.set(k, idx + delta)
      for (const [k, b] of blocksMapOf(meta)) if (b.start > block.end) { b.start += delta; b.end += delta }
      meta.fmEnd += delta
    } else if (items?.length) {
      lines.splice(meta.fmEnd, 0, `${key}:`, ...body)
      meta.fmEnd += body.length + 1
    }
  }
  // blocks 集合引用（供平移）：decode 时同一 Map
  function blocksMapOf(meta: DecodedFrontmatter): Map<string, FmField> {
    return meta.blocks
  }
  if (patch.title !== undefined) applyScalar('title', patch.title)
  if (patch.status !== undefined) applyScalar('status', patch.status)
  if (patch.priority !== undefined) applyScalar('priority', patch.priority)
  if (patch.dueDate !== undefined) applyScalar('due_date', patch.dueDate)
  if (patch.ordinal !== undefined) applyScalar('ordinal', patch.ordinal)
  if (patch.updatedDate !== undefined) applyScalar('updated_date', patch.updatedDate)
  // 查询相关字段（docs/design-backlog-query-filters.md §2）：未给值不改动，空串=清除
  if (patch.type !== undefined) applyScalar('type', patch.type)
  if (patch.milestone !== undefined) applyScalar('milestone', patch.milestone)
  if (patch.taskProject !== undefined) applyScalar('project', patch.taskProject)
  if (patch.parentTaskId !== undefined) applyScalar('parent_task_id', patch.parentTaskId)
  if (patch.reporter !== undefined) applyScalar('reporter', patch.reporter)
  applyBlock('labels', patch.labels)
  applyBlock('dependencies', patch.dependencies)
  applyBlock('assignee', patch.assignees)
  applyBlock('subtasks', patch.subtasks)
  // updated_date 未显式给时自动盖章（上游语义）
  if (patch.updatedDate === undefined) applyScalar('updated_date', now)
  return joinLines(lines)
}

// ---------- 正文解析（AC 进度 / 段标记保留） ----------

const AC_BEGIN = '<!-- AC:BEGIN -->'
const AC_END = '<!-- AC:END -->'

export function countAcceptance(body: string): { total: number; done: number } | undefined {
  const bi = body.indexOf(AC_BEGIN)
  const ei = body.indexOf(AC_END)
  const scope = bi >= 0 && ei > bi ? body.slice(bi, ei) : body
  const boxes = scope.match(/^\s*-\s+\[( |x|X)\]/gm)
  if (!boxes?.length) return undefined
  return { total: boxes.length, done: boxes.filter((b) => /\[[xX]\]/.test(b)).length }
}

export function hasExecutionRecord(raw: string): boolean {
  if (/<!--\s*SECTION:FINAL_SUMMARY:BEGIN\s*-->/.test(raw)) return true
  // 文末追加的执行记录条目：`### <ISO 时间> 派发执行…`（appendExecutionRecord 生成）
  return /^\s*#{3}\s+\d{4}-\d{2}-\d{2}[T ]/m.test(raw)
}

/** 文末追加执行记录（不动既有内容；§3.4 兜底） */
export function appendExecutionRecord(raw: string, entry: { time: string; title: string; lines: string[] }): string {
  const head = raw.endsWith('\n') ? raw : raw + '\n'
  const body = ['', `### ${entry.time} ${entry.title}`, ...entry.lines, '']
  return head + body.join('\n')
}

// ---------- 全文检索语料（--search） ----------

/** 去掉 frontmatter，返回正文（保留行结构；无 frontmatter 时原样返回） */
export function stripFrontmatter(raw: string): string {
  const lines = raw.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return raw
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return lines.slice(i + 1).join('\n')
  }
  return raw
}

/**
 * 构建 `--search` 语料（小写）：frontmatter 关键字段 + 正文全文。
 * 覆盖上游「搜索标题、描述、备注、评论与 metadata」：正文里本来就含 AC / 备注 / 最终总结 / 执行记录，
 * 因此正文全文 + 声明字段即可完整覆盖，且不需要再解析段标记（单次列表的成本不增加）。
 */
export function buildSearchText(fields: BacklogFields, raw: string): string {
  const meta = [
    fields.id,
    fields.title,
    fields.status,
    fields.priority,
    fields.type,
    fields.milestone,
    fields.taskProject,
    fields.parentTaskId,
    fields.reporter,
    fields.dueDate,
    ...(fields.assignees || []),
    ...(fields.labels || []),
    ...(fields.dependencies || []),
    ...(fields.subtasks || []),
  ]
    .filter((x): x is string => typeof x === 'string' && x.length > 0)
    .join('\n')
  return `${meta}\n${stripFrontmatter(raw)}`.toLowerCase()
}

// ---------- 文件名 / itemId ----------

export function slugifyTitle(title: string): string {
  return title.trim().replace(/\s+/g, '-').replace(/[/\\]/g, '').slice(0, 80) || 'untitled'
}

/** 文件名前缀 → itemId（小写 task-1）；frontmatter id 为权威（TASK-1），两者大小写归一比对 */
export function normalizeItemId(v: string): string {
  return v.trim().toUpperCase()
}

export function itemIdFromFileName(fileName: string, prefix = DEFAULT_TASK_PREFIX): string | undefined {
  const m = new RegExp(`^${prefix}-(\\d+)\\b`).exec(fileName)
  return m ? `${prefix}-${m[1]}` : undefined
}

// ---------- 列表排序（TASK-SORT-1）：状态（按 config 顺序）→ 优先级 → 创建时间 ----------

/**
 * 优先级归一权重（越小越靠前）：P0/critical/urgent/highest=0，high/P1=1，
 * medium/normal/中=2，low/P2/minor=3，lowest=4；无法识别/未设置 → 5（排同类最后）。
 * 匹配不分大小写；`P0`/`P1`/`P2` 这类带连字符或裸写都认。
 */
export function backlogPriorityWeight(priority?: string): number {
  const p = (priority || '').trim().toLowerCase()
  if (!p) return 5
  if (/^(p0|critical|urgent|highest|blocker|紧急|最高)$/.test(p)) return 0
  if (/^(p1|high|高|重要)$/.test(p)) return 1
  if (/^(p2|medium|mid|normal|中|普通)$/.test(p)) return 2
  if (/^(p3|low|低|minor)$/.test(p)) return 3
  if (/^(p4|lowest|lowest priority|最低)$/.test(p)) return 4
  return 5
}

// ---------- 列表排序（TASK-SORT-2）：orderBy + asc/desc（API/工具/前端共用） ----------

/** 列表排序维度：createdAt 映射 frontmatter createdDate，updatedAt 映射 updatedDate */
export type BacklogOrderBy = 'createdAt' | 'updatedAt' | 'priority' | 'status' | 'ordinal' | 'id'

export const BACKLOG_ORDER_BY_VALUES: BacklogOrderBy[] = [
  'createdAt',
  'updatedAt',
  'priority',
  'status',
  'ordinal',
  'id',
]

/** 解析 orderBy 参数：非法/缺省回退默认 createdAt */
export function parseBacklogOrderBy(raw?: string | null): BacklogOrderBy {
  const v = (raw || '').trim().toLowerCase()
  return (BACKLOG_ORDER_BY_VALUES as string[]).includes(v) ? (v as BacklogOrderBy) : 'createdAt'
}

/** 解析 asc/desc 参数：缺省 desc（创建时间倒序=最新在前），非法值回退默认 */
export function parseBacklogOrder(raw?: string | null): 'asc' | 'desc' {
  const v = (raw || '').trim().toLowerCase()
  return v === 'asc' ? 'asc' : 'desc'
}

/**
 * 任务 ID 的数字段（`task-2` → [2]，`task-2.10` → [2,10]，`JIRA-7` → [7]）。
 * 与上游 `src/utils/task-sorting.ts: parseTaskId` 同规则：去前缀字母段后按 `.` 拆数字，
 * 非数字段落退化为尾数字；完全无法解析返回 [0]。
 */
export function backlogIdNumericParts(itemId: string): number[] {
  const numericPart = String(itemId || '').replace(/^[a-zA-Z]+-/i, '')
  const dotParts = numericPart.split('.')
  const nums = dotParts.map((part) => {
    const n = Number.parseInt(part, 10)
    return Number.isNaN(n) ? null : n
  })
  if (nums.every((n) => n !== null)) return nums as number[]
  const trailing = /(\d+)$/.exec(numericPart)
  return trailing ? [Number.parseInt(trailing[1], 10)] : [0]
}

/** 任务 ID 排序（数字段逐段比较，长度不齐按 0 补齐；全等时用原串 localeCompare 兜底） */
export function compareBacklogIds(a: string, b: string): number {
  const pa = backlogIdNumericParts(a)
  const pb = backlogIdNumericParts(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x - y
  }
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true })
}

/**
 * 按 orderBy + asc/desc 排序（TASK-SORT-2）：服务端 API / 工具通道 / 前端共用同一规则。
 * - createdAt/updatedAt：ISO 日期字典序即时间序；空日期恒排尾（不受方向影响）；
 * - priority：backlogPriorityWeight（P0→P4→未知）；
 * - status：config.statuses 配置顺序（未收录排最后）；
 * - ordinal：数值（缺省排最后）。
 * - id：backlogIdNumericParts 数字段（task-2 < task-10）。
 * 平级兜底 itemId 序号（方向跟随 asc/desc）；不修改原数组，稳定排序。
 */
export function sortBacklogItemsBy<
  T extends { status?: string; priority?: string; createdDate?: string; updatedDate?: string; ordinal?: number; itemId: string },
>(items: T[], statuses: string[], orderBy: BacklogOrderBy = 'createdAt', order: 'asc' | 'desc' = 'desc'): T[] {
  const dir = order === 'asc' ? 1 : -1
  const statusIdx = new Map(statuses.map((s, i) => [s.trim().toLowerCase(), i]))
  const seqOf = (itemId: string): number => {
    const m = /(\d+)\s*$/.exec(itemId)
    return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER
  }
  if (orderBy === 'id') return [...items].sort((a, b) => compareBacklogIds(a.itemId, b.itemId) * dir)
  return [...items].sort((a, b) => {
    if (orderBy === 'priority') {
      const pa = backlogPriorityWeight(a.priority)
      const pb = backlogPriorityWeight(b.priority)
      if (pa !== pb) return (pa - pb) * dir
      return (seqOf(a.itemId) - seqOf(b.itemId)) * dir
    }
    if (orderBy === 'status') {
      const sa = statusIdx.get((a.status || '').trim().toLowerCase()) ?? statuses.length
      const sb = statusIdx.get((b.status || '').trim().toLowerCase()) ?? statuses.length
      if (sa !== sb) return (sa - sb) * dir
      return (seqOf(a.itemId) - seqOf(b.itemId)) * dir
    }
    if (orderBy === 'ordinal') {
      const ao = a.ordinal ?? Number.MAX_SAFE_INTEGER
      const bo = b.ordinal ?? Number.MAX_SAFE_INTEGER
      if (ao !== bo) return (ao - bo) * dir
      return (seqOf(a.itemId) - seqOf(b.itemId)) * dir
    }
    const key = orderBy === 'updatedAt' ? 'updatedDate' : 'createdDate'
    const da = a[key] || ''
    const db = b[key] || ''
    if (!da && db) return 1
    if (da && !db) return -1
    if (da !== db) return (da < db ? -1 : 1) * dir
    return (seqOf(a.itemId) - seqOf(b.itemId)) * dir
  })
}

/**
 * 待办列表展示排序：状态优先级（按 config.statuses 顺序，未收录状态排最后）→
 * 优先级权重 → 创建时间（createdDate 升序，老条目在前；缺 createdDate 时按
 * itemId 序号兜底）。原数组不被修改，返回新数组。稳定排序（ES2019+ Array.sort）。
 */
export function sortBacklogItems<T extends { status?: string; priority?: string; createdDate?: string; itemId: string }>(
  items: T[],
  statuses: string[],
): T[] {
  const statusIdx = new Map(statuses.map((s, i) => [s.trim().toLowerCase(), i]))
  const seqOf = (itemId: string): number => {
    const m = /(\d+)\s*$/.exec(itemId)
    return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER
  }
  return [...items].sort((a, b) => {
    const sa = statusIdx.get((a.status || '').trim().toLowerCase()) ?? statuses.length
    const sb = statusIdx.get((b.status || '').trim().toLowerCase()) ?? statuses.length
    if (sa !== sb) return sa - sb
    const pa = backlogPriorityWeight(a.priority)
    const pb = backlogPriorityWeight(b.priority)
    if (pa !== pb) return pa - pb
    const ca = a.createdDate || ''
    const cb = b.createdDate || ''
    if (ca !== cb) return ca < cb ? -1 : 1
    return seqOf(a.itemId) - seqOf(b.itemId)
  })
}

// ---------- 节点 IO（DshClient 门面） ----------

function joinPath(workspace: string, rel: string): string {
  const w = workspace.replace(/\/+$/, '')
  return `${w}/${rel}`
}

async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++
      out[idx] = await fn(items[idx])
    }
  })
  await Promise.all(workers)
  return out
}

async function downloadText(client: DshClient, target: DshTarget, filePath: string): Promise<string | undefined> {
  const dl = await client.fsDownload(target, filePath)
  if (!dl.ok || !dl.res) return undefined
  return await dl.res.text()
}

export function backlogPaths(workspace: string) {
  return {
    root: joinPath(workspace, BACKLOG_DIR),
    tasks: joinPath(workspace, BACKLOG_TASKS_DIR),
    config: joinPath(workspace, 'backlog/config.yml'),
  }
}

/** 初始化状态判定（幂等；§3.3）：backlog/ 目录 fsList 成功即视为已初始化 */
export async function probeBacklog(client: DshClient, target: DshTarget, workspace: string): Promise<boolean> {
  const out = await client.fsList(target, backlogPaths(workspace).root)
  return out.ok
}

export async function readConfig(client: DshClient, target: DshTarget, workspace: string): Promise<BacklogConfig> {
  const text = await downloadText(client, target, backlogPaths(workspace).config)
  return text ? parseConfigYml(text) : { statuses: [...DEFAULT_STATUSES], defaultStatus: DEFAULT_STATUSES[0], taskPrefix: DEFAULT_TASK_PREFIX }
}

/** 列表：目录枚举 → 并发下载逐文件解析（AC 进度同源计算；正文不二次拉） */
export async function listBacklog(
  client: DshClient,
  target: DshTarget,
  workspace: string,
  opts?: { withBodies?: boolean; orderBy?: string; order?: string },
): Promise<BacklogListResult> {
  const paths = backlogPaths(workspace)
  const cfg = await readConfig(client, target, workspace)
  // 必须带 all=1：真实 DSH 节点在无 all 时对含文件目录返回空 entries（QA 20261031 实测）
  const listing = await client.fsList(target, paths.tasks, true)
  if (!listing.ok || !listing.data) {
    const err = listing.error || ''
    if (/no such|not found|不存在|ENOENT/i.test(err)) {
      return { initialized: false, truncated: false, config: cfg, items: [] }
    }
    throw new Error(err || 'backlog 目录读取失败')
  }
  const files = (listing.data.entries || []).filter((e) => e.type !== 'dir' && e.name?.endsWith('.md'))
  const items = await pool(files, 6, async (e): Promise<BacklogItem | undefined> => {
    const raw = await downloadText(client, target, e.path || `${paths.tasks}/${e.name}`)
    if (raw === undefined) return undefined
    const { fields } = decodeFrontmatter(raw)
    const fmId = fields.id
    const prefixId = itemIdFromFileName(e.name || '', cfg.taskPrefix)
    const itemId = fmId || prefixId || (e.name || '').replace(/\.md$/i, '')
    const sourceKeys = parseSourceKeys(raw)
    return {
      ...fields,
      itemId,
      fileName: e.name || '',
      filePath: e.path || `${paths.tasks}/${e.name}`,
      acceptance: countAcceptance(raw),
      hasExecutionRecord: hasExecutionRecord(raw),
      // 检索语料随列表一起算（raw 已在内存，零额外 IO）；HTTP/工具回包负责剥离
      searchText: buildSearchText(fields, raw),
      ...(sourceKeys.length ? { sourceKeys } : {}),
      ...(opts?.withBodies ? { description: extractDescription(raw) } : {}),
    } satisfies BacklogItem
  })
  const list = items.filter((x): x is BacklogItem => Boolean(x))
  // 展示排序（TASK-SORT-2）：默认按创建时间倒序（最新在前）；可用 orderBy/order 覆盖；
  // API/工具/前端共用 sortBacklogItemsBy 同一规则，保证排序一致
  return {
    initialized: true,
    truncated: Boolean(listing.data.truncated),
    config: cfg,
    items: sortBacklogItemsBy(list, cfg.statuses, parseBacklogOrderBy(opts?.orderBy), parseBacklogOrder(opts?.order)),
  }
}

export async function readItem(client: DshClient, target: DshTarget, workspace: string, fileName: string): Promise<string> {
  const raw = await downloadText(client, target, `${backlogPaths(workspace).tasks}/${fileName}`)
  if (raw === undefined) throw new Error('待办文件读取失败')
  return raw
}

/** 乐观读改写（§3.4）：写前比对 base（给了 base 则预检，避免覆盖他人改动），写后再验证 —— /fs/* 无锁的最佳努力兜底 */
export async function writeItem(
  client: DshClient,
  target: DshTarget,
  workspace: string,
  fileName: string,
  mutate: (raw: string) => string,
  opts?: { base?: string },
): Promise<{ raw: string; base: string }> {
  const current = await readItem(client, target, workspace, fileName)
  const base = opts?.base ?? current
  if (opts?.base !== undefined && current !== opts.base) throw new BacklogConflictError()
  const next = mutate(current)
  // 真实 DSH 节点 /fs/upload 对已存在文件名生成 -N 副本而非覆盖（QA 20261031 实测），
  // 必须先删后写，否则更新会落到副本且 verify 读原文件必然冲突。
  // 代价：删成功、写失败时会短暂没有该文件 —— 用读到的 current 回写兜底（§3.4 结构性约束）。
  const dir = backlogPaths(workspace).tasks
  const rm = await client.fsRemove(target, `${dir}/${fileName}`)
  if (!rm.ok && !/no such|not found|不存在|enoent/i.test(rm.error || '')) throw new Error(rm.error || '待办清理失败')
  const up = await client.fsUpload(target, dir, [{ filename: fileName, data: Buffer.from(next, 'utf8'), mimeType: 'text/markdown' }])
  if (!up.ok) {
    const restore = await client.fsUpload(target, dir, [{ filename: fileName, data: Buffer.from(current, 'utf8'), mimeType: 'text/markdown' }]).catch(() => ({ ok: false }))
    throw new Error(`${up.error || '待办写回失败'}${restore.ok ? '（已回滚原内容）' : '（回滚失败，条目可能已丢失，请检查节点工作区）'}`)
  }
  const verify = await readItem(client, target, workspace, fileName)
  if (verify !== next) throw new BacklogConflictError()
  return { raw: next, base }
}

// ---------- 来源标记（未完成事项采集的去重锚点） ----------

const SOURCE_KEY_RE = /<!--\s*wb:source=([^\s<>]+)\s*-->/g

/** 从条目正文提取来源标记（`<!-- wb:source=task:wt-x -->` → `task:wt-x`） */
export function parseSourceKeys(raw: string): string[] {
  const out: string[] = []
  SOURCE_KEY_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SOURCE_KEY_RE.exec(raw))) out.push(m[1])
  return out
}

// ---------- 新建条目（单条 / 批量） ----------

/** 新建条目的入参（createItem / createItems 共用） */
export interface CreateItemSpec {
  title: string
  description?: string
  acceptance?: string[]
  labels?: string[]
  dependencies?: string[]
  assignees?: string[]
  priority?: string
  dueDate?: string
  type?: string
  milestone?: string
  taskProject?: string
  parentTaskId?: string
}

/** 生成条目 Markdown（字段顺序对齐上游 v1.55.3 实测样本，§3.2） */
function buildItemMarkdown(cfg: BacklogConfig, id: string, num: number, spec: CreateItemSpec, now: string): string {
  return [
    '---',
    `id: ${id}`,
    `title: ${quoteIfNeeded(spec.title)}`,
    `status: ${quoteIfNeeded(cfg.defaultStatus)}`,
    'assignee:',
    ...(spec.assignees || []).map((a) => `  - ${quoteIfNeeded(a)}`),
    `created_date: '${now}'`,
    `updated_date: '${now}'`,
    'labels:',
    ...(spec.labels || []).map((l) => `  - ${quoteIfNeeded(l)}`),
    'dependencies:',
    ...(spec.dependencies || []).map((d) => `  - ${quoteIfNeeded(d)}`),
    ...(spec.priority ? [`priority: ${quoteIfNeeded(spec.priority)}`] : []),
    ...(spec.type ? [`type: ${quoteIfNeeded(spec.type)}`] : []),
    ...(spec.milestone ? [`milestone: ${quoteIfNeeded(spec.milestone)}`] : []),
    ...(spec.taskProject ? [`project: ${quoteIfNeeded(spec.taskProject)}`] : []),
    ...(spec.parentTaskId ? [`parent_task_id: ${quoteIfNeeded(spec.parentTaskId)}`] : []),
    ...(spec.dueDate ? [`due_date: '${spec.dueDate}'`] : []),
    `ordinal: ${num * 1000}`,
    '---',
    '',
    '## Description',
    '',
    '<!-- SECTION:DESCRIPTION:BEGIN -->',
    spec.description || '',
    '<!-- SECTION:DESCRIPTION:END -->',
    '',
    '## Acceptance Criteria',
    '<!-- AC:BEGIN -->',
    ...(spec.acceptance || []).map((a, i) => `- [ ] #${i + 1} ${a}`),
    '<!-- AC:END -->',
    '',
  ].join('\n')
}

function itemFromSpec(id: string, num: number, fileName: string, tasksDir: string, cfg: BacklogConfig, spec: CreateItemSpec, now: string): BacklogItem {
  return {
    itemId: id,
    fileName,
    filePath: `${tasksDir}/${fileName}`,
    title: spec.title,
    status: cfg.defaultStatus,
    assignees: spec.assignees || [],
    labels: spec.labels || [],
    dependencies: spec.dependencies || [],
    createdDate: now,
    updatedDate: now,
    ordinal: num * 1000,
    priority: spec.priority,
    dueDate: spec.dueDate,
    type: spec.type,
    milestone: spec.milestone,
    taskProject: spec.taskProject,
    parentTaskId: spec.parentTaskId,
    acceptance: spec.acceptance?.length ? { total: spec.acceptance.length, done: 0 } : undefined,
  }
}

/**
 * 批量新建条目：**只做一次** readConfig + listBacklog（itemId 一次算好），再逐条上传。
 * 采集器一次登记多条时必须走这里 —— createItem 每条都全量列目录，N 条会把请求放大 N 倍。
 */
export async function createItems(
  client: DshClient,
  target: DshTarget,
  workspace: string,
  specs: CreateItemSpec[],
): Promise<BacklogItem[]> {
  if (!specs.length) return []
  const cfg = await readConfig(client, target, workspace)
  const list = await listBacklog(client, target, workspace)
  const nums = list.items
    .map((it) => Number(/-(\d+)$/.exec(it.itemId)?.[1]))
    .filter((n) => Number.isFinite(n) && n > 0)
  let nextNum = (nums.length ? Math.max(...nums) : 0) + 1
  const tasksDir = backlogPaths(workspace).tasks
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const out: BacklogItem[] = []
  for (const spec of specs) {
    const num = nextNum++
    const id = `${cfg.taskPrefix}-${num}`
    const fileName = `${id} - ${slugifyTitle(spec.title)}.md`
    const md = buildItemMarkdown(cfg, id, num, spec, now)
    const up = await client.fsUpload(target, tasksDir, [{ filename: fileName, data: Buffer.from(md, 'utf8'), mimeType: 'text/markdown' }])
    if (!up.ok) throw new Error(`${up.error || '待办创建失败'}（${out.length}/${specs.length} 条已创建，${id} 失败）`)
    out.push(itemFromSpec(id, num, fileName, tasksDir, cfg, spec, now))
  }
  return out
}

/** 新建单条（分配下一个 itemId：对既有 frontmatter id 与文件名前缀取 max+1） */
export async function createItem(
  client: DshClient,
  target: DshTarget,
  workspace: string,
  spec: CreateItemSpec,
): Promise<BacklogItem> {
  const items = await createItems(client, target, workspace, [spec])
  return items[0]
}

/** 按 itemId 找条目（列表后归一比对；文件名可能被 agent 改过） */
export async function findItem(client: DshClient, target: DshTarget, workspace: string, itemId: string): Promise<{ item: BacklogItem; list: BacklogListResult } | undefined> {
  const list = await listBacklog(client, target, workspace)
  const want = normalizeItemId(itemId)
  const hits = list.items.filter((it) => normalizeItemId(it.itemId) === want)
  // 重复 ID（如两个文件 frontmatter 都写 TASK-1）会导致派发/回写命中错文件（QA 20261101 实锤），
  // 必须显式报错让调用方改号，而不是静默取列表第一个。
  if (hits.length > 1) {
    throw new Error(
      `待办 ID 重复：${hits.length} 个文件都使用了 itemId=${itemId}（${hits.map((h) => h.fileName).join(' / ')}）。` +
        `请为一个文件改用唯一 id（frontmatter id 与文件名前缀同步修改）后再派发。`,
    )
  }
  const item = hits[0]
  if (!item) return undefined
  return { item, list }
}

/** 删除条目文件（物理删除；调用方负责二次确认语义） */
export async function deleteItem(client: DshClient, target: DshTarget, workspace: string, fileName: string): Promise<void> {
  const rm = await client.fsRemove(target, `${backlogPaths(workspace).tasks}/${fileName}`)
  if (!rm.ok) throw new Error(rm.error || '待办删除失败')
}

// ---------- 正文段提取（派发时把描述/验收原文带给 planner） ----------

function sectionBetween(body: string, begin: string, end: string): string | undefined {
  const bi = body.indexOf(begin)
  const ei = body.indexOf(end)
  if (bi < 0 || ei <= bi) return undefined
  return body
    .slice(bi + begin.length, ei)
    .replace(/^\r?\n/, '')
    .replace(/\r?\n$/, '')
}

export function extractDescription(raw: string): string | undefined {
  const body = raw.slice(decodeFrontmatter(raw).meta.fmEnd + 1)
  const byMarker = sectionBetween(body, '<!-- SECTION:DESCRIPTION:BEGIN -->', '<!-- SECTION:DESCRIPTION:END -->')
  if (byMarker !== undefined) return byMarker.trim()
  const m = /##\s*Description\s*\r?\n([\s\S]*?)(?=\r?\n##\s|\s*$)/i.exec(body)
  return m?.[1]?.trim() || undefined
}

export function extractAcceptanceText(raw: string): string | undefined {
  const body = raw.slice(decodeFrontmatter(raw).meta.fmEnd + 1)
  const byMarker = sectionBetween(body, AC_BEGIN, AC_END)
  const text = (byMarker !== undefined ? byMarker : /##\s*Acceptance Criteria\s*\r?\n([\s\S]*?)(?=\r?\n##\s|\s*$)/i.exec(body)?.[1] || '')?.trim()
  return text || undefined
}

/** B6/N5：注入项目指令的 backlog 协作约定文案（文案版协同；技能化/MCP 化为后置升级路径） */
export function backlogInstructionSnippet(): string {
  return [
    '## Backlog 待办协作约定',
    '- 本项目工作区有 backlog/ 待办目录（backlog/tasks/task-<n> - <标题>.md，frontmatter 含 id/title/status/labels/dependencies/验收清单）。',
    '- 用户提出新的需求或待办时：在 backlog/tasks/ 下新建条目文件（itemId 取现有最大序号 +1），并告知用户已登记。',
    '- 完成与 backlog 待办相关的工作后：勾选该待办正文 Acceptance Criteria 中已满足的项（`- [ ]` → `- [x]`）。',
    '- 派发类任务的完成状态由 WorkBuddy 服务端自动回写，无需手动置 Done；自主完成的待办请把 frontmatter status 置为 Done 并在正文末尾用「### <时间> 执行记录」小节写明结论。',
  ].join('\n')
}

// ---------- 正文段替换（编辑抽屉用；段标记原样保留，无标记时正则替换/追加） ----------

function spliceBetween(raw: string, begin: string, end: string, inner: string): string {
  const bi = raw.indexOf(begin)
  const ei = raw.indexOf(end)
  return raw.slice(0, bi + begin.length) + '\n' + inner + '\n' + raw.slice(ei)
}

export function replaceDescription(raw: string, text: string): string {
  const begin = '<!-- SECTION:DESCRIPTION:BEGIN -->'
  const end = '<!-- SECTION:DESCRIPTION:END -->'
  if (raw.includes(begin) && raw.includes(end)) return spliceBetween(raw, begin, end, text)
  const m = /(^|\r?\n)(##\s*Description\s*\r?\n)[\s\S]*?((?=\r?\n##\s)|$)/i.exec(raw)
  if (m) return raw.slice(0, m.index) + m[1] + m[2] + text + raw.slice(m.index + m[0].length)
  return `${raw.replace(/\s*$/, '')}\n\n## Description\n\n${text}\n`
}

export function replaceAcceptance(raw: string, items: string[]): string {
  // 编辑抽屉语义：整体替换 = 全部重置为未勾选（不继承旧勾选；测试见 backlog.test.ts）
  return setAcceptance(raw, items.map((text) => ({ text, done: false })), { preserveChecks: false })
}

/** 验收清单条目（写回时保留勾选状态） */
export interface AcceptanceEntry {
  text: string
  done: boolean
}

/** 验收条目行（本仓库写入格式 `- [ ] #1 文本` 与上游手写格式 `- [x] 文本`） */
const AC_ITEM_LINE = /^\s*-\s+\[( |x|X)\]\s*(?:#\d+\s*)?(.*)$/

/**
 * 解析验收清单条目：兼容 `- [ ] #1 文本`（本仓库写入格式）与 `- [x] 文本`（上游手写格式）。
 * 无 AC 段或无条目返回空数组。
 */
export function parseAcceptanceEntries(raw: string): AcceptanceEntry[] {
  const section = extractAcceptanceText(raw)
  if (!section) return []
  const out: AcceptanceEntry[] = []
  for (const line of section.split(/\r?\n/)) {
    const m = AC_ITEM_LINE.exec(line)
    if (!m) continue
    const text = m[2].trim()
    if (text) out.push({ text, done: /[xX]/.test(m[1]) })
  }
  return out
}

/**
 * AC 段内**无法识别为用户条目**的非空行（缩进续行、`*` 星号列表、说明文字等）。
 * 重写 AC 段时必须原样保留，否则人会认为「我只改了验收项，怎么别的字没了」。
 */
function unknownAcceptanceLines(raw: string): string[] {
  const section = extractAcceptanceText(raw)
  if (!section) return []
  return section.split(/\r?\n/).filter((l) => l.trim() !== '' && !AC_ITEM_LINE.test(l))
}

/** 写 AC 段（段标记优先，其次 `## Acceptance Criteria`，都没有则文末新增） */
function writeAcceptanceBlock(raw: string, body: string): string {
  if (raw.includes(AC_BEGIN) && raw.includes(AC_END)) return spliceBetween(raw, AC_BEGIN, AC_END, body)
  const m = /(^|\r?\n)(##\s*Acceptance Criteria\s*(?:\r?\n)?)[\s\S]*?((?=\r?\n##\s)|$)/i.exec(raw)
  if (m) return raw.slice(0, m.index) + m[1] + m[2] + `${AC_BEGIN}\n${body}\n${AC_END}` + raw.slice(m.index + m[0].length)
  return `${raw.replace(/\s*$/, '')}\n\n## Acceptance Criteria\n${AC_BEGIN}\n${body}\n${AC_END}\n`
}

/**
 * 整体写验收清单：默认**保留勾选状态**（上游语义：按 trim 后文本匹配，命中则沿用旧勾选）。
 * 新增条目默认未勾选；顺序按入参重排，序号重编为 #1..#n；无法解析的既有行原样保留在段末。
 */
export function setAcceptance(raw: string, entries: AcceptanceEntry[], opts?: { preserveChecks?: boolean }): string {
  const prev = new Map<string, boolean>()
  if (opts?.preserveChecks !== false) {
    for (const e of parseAcceptanceEntries(raw)) if (!prev.has(e.text.trim())) prev.set(e.text.trim(), e.done)
  }
  const lines = entries.map(
    (e, i) => `- [${e.done || prev.get(e.text.trim()) ? 'x' : ' '}] #${i + 1} ${e.text.trim()}`,
  )
  lines.push(...unknownAcceptanceLines(raw))
  return writeAcceptanceBlock(raw, lines.join('\n'))
}

/**
 * 追加验收项：**不动既有任何行**（含无法识别的行），只把新条目插到 AC 段末尾。
 * 与 `setAcceptance` 分开的原因：追加是最常见的 AI 动作，必须零丢字风险。
 */
export function appendAcceptance(raw: string, texts: string[]): string {
  const items = texts.map((t) => t.trim()).filter(Boolean)
  if (!items.length) return raw
  const start = parseAcceptanceEntries(raw).length
  const lines = items.map((t, i) => `- [ ] #${start + i + 1} ${t}`)
  if (raw.includes(AC_BEGIN) && raw.includes(AC_END)) {
    const ei = raw.indexOf(AC_END)
    const before = raw.slice(0, ei)
    const tail = raw.slice(ei)
    return `${before}${before.endsWith('\n') ? '' : '\n'}${lines.join('\n')}\n${tail}`
  }
  return writeAcceptanceBlock(raw, lines.join('\n'))
}

/**
 * 初始化（途径 A，幂等）：mkdir backlog + tasks + config.yml +（可选）示例待办。
 * 目录已存在时 fs/mkdir 幂等或报「已存在」均视为成功。
 */
export async function initBacklog(
  client: DshClient,
  target: DshTarget,
  workspace: string,
  opts?: { projectName?: string; sample?: boolean },
): Promise<{ initialized: boolean; sampleItemId?: string }> {
  const p = backlogPaths(workspace)
  const mkdirTolerant = async (parent: string, name: string) => {
    const r = await client.fsMkdir(target, parent, name)
    if (!r.ok && !/exist|已存在/i.test(r.error || '')) throw new Error(r.error || '初始化失败')
  }
  await mkdirTolerant(workspace, BACKLOG_DIR)
  await mkdirTolerant(p.root, 'tasks')
  // 幂等：已初始化（目录在 + config.yml 可读）直接返回，**不重传 config.yml**。
  // 真实 DSH 节点同名上传会生成 config-1.yml 副本（QA 20261031 实测），重复 init 会污染目录。
  if (await probeBacklog(client, target, workspace)) {
    if ((await downloadText(client, target, p.config)) !== undefined) return { initialized: true }
  }
  const cfgText = [
    `project_name: ${opts?.projectName ? quoteIfNeeded(opts.projectName) : '""'}`,
    `default_status: "${DEFAULT_STATUSES[0]}"`,
    `statuses: [${DEFAULT_STATUSES.map((s) => `"${s}"`).join(', ')}]`,
    'labels: []',
    'date_format: yyyy-mm-dd',
    'default_editor: "vi"',
    'auto_open_browser: false',
    'default_port: 6420',
    `task_prefix: ${DEFAULT_TASK_PREFIX}`,
    '',
  ].join('\n')
  const files: Array<{ filename: string; data: Buffer; mimeType?: string }> = [{ filename: 'config.yml', data: Buffer.from(cfgText, 'utf8'), mimeType: 'text/yaml' }]
  let sampleItemId: string | undefined
  if (opts?.sample) {
    const item = await createItem(client, target, workspace, {
      title: '示例待办（可删除）',
      description: '这是 backlog 初始化附带的示例条目，展示 frontmatter 与验收清单格式，可编辑或删除。',
      acceptance: ['勾选一个验收项试试', '把状态改为 Done 试试'],
      labels: ['sample'],
    })
    sampleItemId = item.itemId
  } else {
    // config.yml 与潜在示例待办一并上传（createItem 会自行上传，故此处只在无示例时上传）
  }
  const up = await client.fsUpload(target, p.root, files)
  if (!up.ok) throw new Error(up.error || '初始化写 config.yml 失败')
  return { initialized: true, sampleItemId }
}
