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
      } else {
        scalarIdx.set(key, i)
        const v = unquote(val)
        if (key === 'id') fields.id = v
        else if (key === 'title') fields.title = v
        else if (key === 'status') fields.status = v
        else if (key === 'created_date') fields.createdDate = v
        else if (key === 'updated_date') fields.updatedDate = v
        else if (key === 'priority') fields.priority = v
        else if (key === 'due_date') fields.dueDate = v
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
  applyBlock('labels', patch.labels)
  applyBlock('dependencies', patch.dependencies)
  applyBlock('assignee', patch.assignees)
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
export async function listBacklog(client: DshClient, target: DshTarget, workspace: string, opts?: { withBodies?: boolean }): Promise<BacklogListResult> {
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
    return {
      ...fields,
      itemId,
      fileName: e.name || '',
      filePath: e.path || `${paths.tasks}/${e.name}`,
      acceptance: countAcceptance(raw),
      hasExecutionRecord: hasExecutionRecord(raw),
    } satisfies BacklogItem
  })
  const list = items.filter((x): x is BacklogItem => Boolean(x))
  return { initialized: true, truncated: Boolean(listing.data.truncated), config: cfg, items: list }
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
  // 必须先删后写，否则更新会落到副本且 verify 读原文件必然冲突
  const rm = await client.fsRemove(target, `${backlogPaths(workspace).tasks}/${fileName}`)
  if (!rm.ok && !/no such|not found|不存在|enoent/i.test(rm.error || '')) throw new Error(rm.error || '待办清理失败')
  const up = await client.fsUpload(target, backlogPaths(workspace).tasks, [{ filename: fileName, data: Buffer.from(next, 'utf8'), mimeType: 'text/markdown' }])
  if (!up.ok) throw new Error(up.error || '待办写回失败')
  const verify = await readItem(client, target, workspace, fileName)
  if (verify !== next) throw new BacklogConflictError()
  return { raw: next, base }
}

/** 新建条目：分配下一个 itemId（对既有 frontmatter id 与文件名前缀取 max+1） */
export async function createItem(
  client: DshClient,
  target: DshTarget,
  workspace: string,
  spec: { title: string; description?: string; acceptance?: string[]; labels?: string[]; dependencies?: string[]; assignees?: string[]; priority?: string; dueDate?: string },
): Promise<BacklogItem> {
  const cfg = await readConfig(client, target, workspace)
  const list = await listBacklog(client, target, workspace)
  const nums = list.items
    .map((it) => Number(/-(\d+)$/.exec(it.itemId)?.[1]))
    .filter((n) => Number.isFinite(n) && n > 0)
  const nextNum = (nums.length ? Math.max(...nums) : 0) + 1
  const id = `${cfg.taskPrefix}-${nextNum}`
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const fm = [
    '---',
    `id: ${id}`,
    `title: ${quoteIfNeeded(spec.title)}`,
    `status: ${quoteIfNeeded(cfg.defaultStatus)}`,
    `assignee:`,
    ...(spec.assignees || []).map((a) => `  - ${quoteIfNeeded(a)}`),
    `created_date: '${now}'`,
    `updated_date: '${now}'`,
    `labels:`,
    ...(spec.labels || []).map((l) => `  - ${quoteIfNeeded(l)}`),
    `dependencies:`,
    ...(spec.dependencies || []).map((d) => `  - ${quoteIfNeeded(d)}`),
    ...(spec.priority ? [`priority: ${quoteIfNeeded(spec.priority)}`] : []),
    ...(spec.dueDate ? [`due_date: '${spec.dueDate}'`] : []),
    `ordinal: ${nextNum * 1000}`,
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
  ]
  const fileName = `${id} - ${slugifyTitle(spec.title)}.md`
  const up = await client.fsUpload(target, backlogPaths(workspace).tasks, [{ filename: fileName, data: Buffer.from(fm.join('\n'), 'utf8'), mimeType: 'text/markdown' }])
  if (!up.ok) throw new Error(up.error || '待办创建失败')
  return {
    itemId: id,
    fileName,
    filePath: `${backlogPaths(workspace).tasks}/${fileName}`,
    title: spec.title,
    status: cfg.defaultStatus,
    assignees: spec.assignees || [],
    labels: spec.labels || [],
    dependencies: spec.dependencies || [],
    createdDate: now,
    updatedDate: now,
    ordinal: nextNum * 1000,
    priority: spec.priority,
    dueDate: spec.dueDate,
    acceptance: spec.acceptance?.length ? { total: spec.acceptance.length, done: 0 } : undefined,
  }
}

/** 按 itemId 找条目（列表后归一比对；文件名可能被 agent 改过） */
export async function findItem(client: DshClient, target: DshTarget, workspace: string, itemId: string): Promise<{ item: BacklogItem; list: BacklogListResult } | undefined> {
  const list = await listBacklog(client, target, workspace)
  const want = normalizeItemId(itemId)
  const item = list.items.find((it) => normalizeItemId(it.itemId) === want)
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
  const body = items.map((a, i) => `- [ ] #${i + 1} ${a}`).join('\n')
  if (raw.includes(AC_BEGIN) && raw.includes(AC_END)) return spliceBetween(raw, AC_BEGIN, AC_END, body)
  const m = /(^|\r?\n)(##\s*Acceptance Criteria\s*(?:\r?\n)?)[\s\S]*?((?=\r?\n##\s)|$)/i.exec(raw)
  if (m) return raw.slice(0, m.index) + m[1] + m[2] + `${AC_BEGIN}\n${body}\n${AC_END}` + raw.slice(m.index + m[0].length)
  return `${raw.replace(/\s*$/, '')}\n\n## Acceptance Criteria\n${AC_BEGIN}\n${body}\n${AC_END}\n`
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
