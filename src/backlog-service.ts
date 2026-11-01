/**
 * onenat-workbuddy-web - Backlog 共享服务层
 *
 * 从 router.ts 抽出的两段「多调用方」逻辑，供 HTTP 路由与工具通道（MCP / AI 技能）共用：
 *   1. dispatchBacklogItem —— 待办 → WorkTask 派发（docs/design-backlog-integration.md §6.1）
 *   2. overviewBacklog     —— 跨项目待办聚合（§7.3，并发 3、失败隔离）
 *
 * 放在 service 层而不是各自复制的原因：派发要复用 engine.createTask（继承项目节点/工作区/
 * 成员/技能）与 backlog 的乐观写路径，两处实现一旦分叉，回写闭环就会出现「一半任务带
 * backlogRef、一半不带」的静默缺陷。
 */
import type { DshClient, DshTarget } from './remote-client.js'
import type { AgentResolver } from './resolver.js'
import type { TaskEngine } from './engine.js'
import type { WorkStore } from './store.js'
import type { DshRef, Project, WorkTask } from './types.js'
import {
  appendExecutionRecord,
  encodeFrontmatter,
  extractAcceptanceText,
  extractDescription,
  findItem,
  listBacklog,
  normalizeItemId,
  probeBacklog,
  readConfig,
  readItem,
  resolveDoneStatus,
  resolveInProgressStatus,
  writeItem,
  type BacklogItem,
  type BacklogListResult,
} from './backlog.js'

/** 待办派发结果（与 HTTP API 的回包结构一致） */
export interface BacklogDispatchResult {
  task: { id: string; title: string; mode: string; status: string }
  item: { itemId: string; status: string }
}

export interface BacklogDispatchDeps {
  client: DshClient
  engine: TaskEngine
}

/**
 * 待办 → WorkBuddy 任务一键派发（§6.1）。
 *
 * 复用 engine.createTask（projectId 继承项目节点/工作区/成员/连接器/技能）；
 * 验收清单原文直达 planner；依赖未完成默认阻止（D5，可 force）；成功后置进行中并追加派发记录。
 *
 * 失败语义：抛出的错误带 `status`（404/409/…）与可选 `code`，调用方按需映射到 HTTP 状态码
 * 或工具通道的 `{ok:false, code}`，不在此处决定传输层表达。
 */
export async function dispatchBacklogItem(
  deps: BacklogDispatchDeps,
  proj: Project,
  target: DshTarget,
  workspace: string,
  itemId: string,
  opts: { force?: boolean; instruction?: string } = {},
): Promise<BacklogDispatchResult> {
  const found = await findItem(deps.client, target, workspace, itemId)
  if (!found) throw Object.assign(new Error(`待办 ${itemId} 不存在`), { status: 404, code: 'NOT_FOUND' })
  const item = found.item
  const doneStatus = resolveDoneStatus(found.list.config.statuses)
  if (!opts.force && item.dependencies?.length) {
    const byId = new Map(found.list.items.map((it) => [normalizeItemId(it.itemId), it]))
    const blocked = item.dependencies
      .map((d) => byId.get(normalizeItemId(d)))
      .filter((d): d is NonNullable<typeof d> => Boolean(d) && d!.status !== doneStatus)
    if (blocked.length) {
      throw Object.assign(
        new Error(`存在未完成依赖：${blocked.map((b) => b!.itemId).join('、')}（可勾选「忽略依赖」强制派发）`),
        { status: 409, code: 'DEPS_BLOCKED', blocked: blocked.map((b) => b!.itemId) },
      )
    }
  }
  const raw = await readItem(deps.client, target, workspace, item.fileName)
  const desc = extractDescription(raw)
  const ac = extractAcceptanceText(raw)
  const message = [
    `【来自 backlog 待办 ${item.itemId}】${item.title || ''}`,
    '',
    '## 描述',
    desc || '（待办未填写描述）',
    '',
    '## 验收清单',
    ac || '（待办未填写验收清单，请按描述自拟可验证的完成标准）',
    ...(opts.instruction ? ['', '## 附加说明', opts.instruction] : []),
  ].join('\n')
  const task = await deps.engine.createTask({
    title: item.title || String(item.itemId),
    projectId: proj.id,
    message,
    creator: 'console',
    backlogRef: { projectId: proj.id, itemId: item.itemId, itemTitle: item.title || '', dispatchedAt: Date.now() },
  })
  // 置进行中（状态可配置：resolveInProgressStatus 判定；已是该状态则不动）+ 追加派发记录
  const inProgress = resolveInProgressStatus(found.list.config.statuses)
  const nextStatus = inProgress && inProgress !== item.status ? inProgress : undefined
  const time = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  const markDispatched = (base: string) =>
    appendExecutionRecord(encodeFrontmatter(base, { status: nextStatus }), {
      time,
      title: '派发为任务',
      lines: [`${task.id} · mode=${task.mode} · 成员=${task.memberAgentIds.length}`],
    })
  // 任务已建之后，任何失败都不能让调用方以为「没派发成功」而重试 —— 那会产生重复任务。
  // 因此：① 乐观写冲突时重读最新内容再追加一次（执行记录是追加语义，可重入）；
  // ② 仍然失败也带 taskId 抛出，调用方据此提示「任务已创建，勿重复派发」。
  try {
    try {
      await writeItem(deps.client, target, workspace, item.fileName, () => markDispatched(raw), { base: raw })
    } catch (err) {
      if ((err as any)?.name !== 'BacklogConflictError') throw err
      const fresh = await readItem(deps.client, target, workspace, item.fileName)
      await writeItem(deps.client, target, workspace, item.fileName, () => markDispatched(fresh), { base: fresh })
    }
  } catch (err) {
    throw Object.assign(
      new Error(`任务 ${task.id} 已创建，但待办 ${item.itemId} 的状态/派发记录未写回：${(err as Error)?.message || err}`),
      { status: 502, code: 'WRITEBACK_FAILED', taskId: task.id, taskCreated: true, itemId: item.itemId },
    )
  }
  return {
    task: { id: task.id, title: task.title, mode: String(task.mode || 'chat'), status: String(task.status || 'draft') },
    item: { itemId: item.itemId, status: nextStatus || item.status || '' },
  }
}

/** 待办关联的 WorkBuddy 任务摘要（列表徽标 / 详情时间线用） */
export interface BacklogLinkedTask {
  id: string
  status: string
  summaryStatus: string
  writebackFailed: WorkTask['backlogWritebackFailed'] | null
  updatedAt: number
}

/** 与待办关联的任务列表（按更新时间倒序；itemId 大小写归一比对） */
export function linkedTasksFor(store: WorkStore, projectId: string, itemId: string): BacklogLinkedTask[] {
  const want = normalizeItemId(itemId)
  return store
    .getTasks()
    .filter((t) => t.backlogRef?.projectId === projectId && normalizeItemId(t.backlogRef!.itemId) === want)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((t) => ({
      id: t.id,
      status: t.status,
      summaryStatus: t.summary?.status || '',
      writebackFailed: t.backlogWritebackFailed || null,
      updatedAt: t.updatedAt,
    }))
}

/** 列表项 + 关联任务（HTTP API 与工具通道共用同一形状，避免 AI 与 UI 看到的字段不一致） */
export interface BacklogItemWithTasks extends BacklogItem {
  tasks: BacklogLinkedTask[]
}

/** 单项目待办列表（含关联任务） */
export async function listBacklogWithTasks(
  deps: { client: DshClient; store: WorkStore },
  target: DshTarget,
  workspace: string,
  projectId: string,
  opts?: { withBodies?: boolean; orderBy?: string; order?: string },
): Promise<BacklogListResult & { items: BacklogItemWithTasks[] }> {
  const list = await listBacklog(deps.client, target, workspace, opts)
  return {
    ...list,
    items: list.items.map((it) => ({ ...it, tasks: linkedTasksFor(deps.store, projectId, it.itemId) })),
  }
}

export interface BacklogOverviewProject {
  projectId: string
  projectName: string
  archived: boolean
  workspace: string
  nodeStatus: 'ok' | 'unreachable' | 'archived'
  initialized: boolean
  truncated: boolean
  statuses: string[]
  defaultStatus: string
  error: string
  items: BacklogItemWithTasks[]
}

export interface BacklogOverviewDeps {
  client: DshClient
  store: WorkStore
  resolver: JudgeResolver
}

/** 只依赖 resolveRef 的窄接口（router 与工具层都满足；避免把整个 AgentResolver 绑进来） */
export interface JudgeResolver {
  resolveRef(
    dshRef: DshRef,
    apiKey?: string,
    agentId?: string,
  ): Promise<{ baseUrl: string; apiKey?: string; online: boolean; error?: string }>
}

/**
 * 跨项目待办聚合（§7.3）：按项目并发 fan-out，限 3 路；
 * **失败隔离** —— 单项目节点不可达返回 `{...base, nodeStatus:'unreachable', error}` 而不拖垮整页。
 *
 * `withItems:false` 时只探活 + 读配置，不枚举待办（工具通道 `projects` 动作要列全部项目时避免
 * 逐项目拉全量条目，两者用的是同一套失败隔离与初始化判定）。
 */
export async function overviewBacklog(
  deps: BacklogOverviewDeps,
  projects: Project[],
  opts?: { concurrency?: number; withItems?: boolean },
): Promise<BacklogOverviewProject[]> {
  const limit = Math.max(1, Math.min(opts?.concurrency ?? 3, 8))
  const withItems = opts?.withItems !== false
  const out: BacklogOverviewProject[] = new Array(projects.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, projects.length) }, async () => {
      while (next < projects.length) {
        const idx = next++
        out[idx] = await overviewOne(deps, projects[idx], withItems)
      }
    }),
  )
  // 活动项目置顶 → 有 open 待办按数量降序 → 无待办垫底 → 归档沉底（task-52）
  return sortBacklogOverviewProjects(out, projects, deps.store)
}

/** 「活动项目」判定窗口：7 天内有任务/待办活动视为活动项目（task-52） */
const ACTIVITY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 项目最近活动时间：项目自身 updatedAt、该项目全部 WorkBuddy 任务 updatedAt、
 * 待办条目 updated_date（ISO 字符串，解析失败忽略）三者取最大；缺省 0。
 */
export function backlogProjectActivityAt(
  store: WorkStore,
  pr: Project,
  items: BacklogItemWithTasks[],
): number {
  let latest = pr.updatedAt || 0
  for (const t of store.getTasks()) {
    if (t.projectId === pr.id && t.updatedAt > latest) latest = t.updatedAt
  }
  for (const it of items) {
    const ts = it.updatedDate ? Date.parse(it.updatedDate) : NaN
    if (Number.isFinite(ts) && ts > latest) latest = ts
  }
  return latest
}

/**
 * 跨项目待办列表排序（task-52）：
 *   0 = 活动项目（未归档且 7 天内有任务/待办活动）排最上；
 *   1 = 有未完成（open）待办的项目，按 open 数量降序；
 *   2 = 无未完成待办的项目垫底；
 *   3 = 归档项目（只读，永沉底）。
 * 同组内按最近活动时间倒序。不可达/未初始化项目 items 为空（open=0），自然落组 2。
 */
export function sortBacklogOverviewProjects(
  rows: BacklogOverviewProject[],
  projects: Project[],
  store: WorkStore,
): BacklogOverviewProject[] {
  const byId = new Map(projects.map((pr) => [pr.id, pr]))
  const ranked = rows.map((row) => {
    const pr = byId.get(row.projectId)
    const doneStatus = resolveDoneStatus(row.statuses.length ? row.statuses : [row.defaultStatus || 'Done'])
    const open = row.items.filter((it) => it.status !== doneStatus).length
    const activityAt = pr ? backlogProjectActivityAt(store, pr, row.items) : 0
    const archived = row.nodeStatus === 'archived' || Boolean(pr?.archivedAt)
    const rank = archived ? 3 : activityAt > 0 && Date.now() - activityAt <= ACTIVITY_WINDOW_MS ? 0 : open > 0 ? 1 : 2
    return { row, rank, open, activityAt }
  })
  return ranked
    // rank0（活动项目）组内按最近活动倒序（open 数量降序只用于 rank1 组），再以活动时间兜底
    .sort((a, b) => a.rank - b.rank || (a.rank === 0 ? b.activityAt - a.activityAt : b.open - a.open) || b.activityAt - a.activityAt)
    .map((r) => r.row)
}

async function overviewOne(deps: BacklogOverviewDeps, pr: Project, withItems: boolean): Promise<BacklogOverviewProject> {
  const base = { projectId: pr.id, projectName: pr.name, archived: Boolean(pr.archivedAt), workspace: pr.workspace || '' }
  const empty = {
    ...base,
    initialized: false,
    truncated: false,
    statuses: [] as string[],
    defaultStatus: '',
    items: [] as BacklogItemWithTasks[],
  }
  if (pr.archivedAt) return { ...empty, nodeStatus: 'archived', error: '' }
  if (!pr.workspace) return { ...empty, nodeStatus: 'unreachable', error: '项目未配置工作目录' }
  try {
    const target = await deps.resolver.resolveRef(pr.dshRef, pr.apiKey, 'backlog-overview')
    if (!target.online || !target.baseUrl) {
      return { ...empty, nodeStatus: 'unreachable', error: target.error || '节点不可达' }
    }
    if (!withItems) {
      const initialized = await probeBacklog(deps.client, target, pr.workspace)
      const cfg = initialized ? await readConfig(deps.client, target, pr.workspace) : { statuses: [] as string[], defaultStatus: '', taskPrefix: '' }
      return {
        ...base,
        nodeStatus: 'ok',
        initialized,
        truncated: false,
        statuses: cfg.statuses,
        defaultStatus: cfg.defaultStatus,
        error: '',
        items: [],
      }
    }
    const list = await listBacklogWithTasks(deps, target, pr.workspace, pr.id)
    return {
      ...base,
      nodeStatus: 'ok',
      initialized: list.initialized,
      truncated: list.truncated,
      statuses: list.config.statuses,
      defaultStatus: list.config.defaultStatus,
      error: '',
      items: list.items,
    }
  } catch (err: any) {
    return {
      ...empty,
      initialized: true,
      nodeStatus: 'unreachable',
      error: String(err?.message || err).slice(0, 200),
    }
  }
}
