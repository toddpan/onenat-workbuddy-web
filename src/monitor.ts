/**
 * onenat-workbuddy-web - MonitorService: 监控大屏数据中枢（只读聚合 + 事件采集 + 趋势落盘）
 *
 * 职责：
 *  1. 事件采集：engine 全局 tap（任务/子任务/计划事件）+ scheduler.onRunFinished（定时触发）
 *     → 内存环形缓冲 + 按天 JSONL 落盘（<dataDir>/monitor/events-YYYY-MM-DD.jsonl）
 *  2. 健康巡检（30s）：解析全部子智能体（在线/离线/端口漂移），状态迁移记事件
 *  3. 小时快照：每小时一条 KPI 快照（snapshots-YYYY-MM-DD.jsonl），保留 30 天，支持回看多天趋势
 *  4. 聚合总览：buildOverview() 一次拉全量 —— KPI / 智能体 / 任务活动 / 资源调用 / 告警 / 事件
 *  5. 资源使用识别：扫描运行中任务最近工具调用参数，匹配绑定资源的 host:port/别名/应用名（尽力而为）
 *
 * 产出面向「给人看的监控屏」：任务类型图标（⏰ 定时 / 💬 直通 / 🎯 编排）、
 * 每个任务一句话可读状态（headline）、资源在用标记。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import type { OnenatDirectory } from './onenat.js'
import type { AgentResolver } from './resolver.js'
import type { TaskEngine } from './engine.js'
import type { ScheduleRunner } from './scheduler.js'
import { ruleText } from './scheduler.js'
import type { SshResourceStore } from './ssh-store.js'
import type { Planner } from './planner.js'
import { DshClient } from './remote-client.js'
import type { PlanSubtask, ResolvedEndpoint, ScheduledTask, SubAgent, TaskEvent, WorkTask } from './types.js'

// ---------------------------------------------------------------- 数据形状

export type MonitorEventKind =
  | 'task_started' | 'task_completed' | 'task_failed' | 'task_cancelled'
  | 'subtask_completed' | 'subtask_failed' | 'plan_created'
  | 'schedule_fired'
  | 'agent_online' | 'agent_offline'
  | 'resource_drift' | 'resource_offline' | 'resource_online'

export interface MonitorEvent {
  at: number
  kind: MonitorEventKind
  level: 'info' | 'warn' | 'error'
  /** 人类可读一句话 */
  msg: string
  taskId?: string
  agentId?: string
  scheduleId?: string
}

export interface MonitorSnapshot {
  at: number
  agentsTotal: number
  agentsOnline: number
  tasksRunning: number
  tasksCompletedToday: number
  tasksFailedToday: number
  schedulesEnabled: number
  tokensInputToday: number
  tokensOutputToday: number
  cacheReadToday: number
  toolCallsToday: number
}

export interface ResourceUsageHint {
  taskId: string
  taskTitle: string
  tool: string
  at: number
}

export interface AgentResourceView {
  ref: string
  /** alias || note || tunnelName || appName */
  name: string
  kind: string
  online: boolean
  endpoint: string
  credentialMode?: string
  inUse: ResourceUsageHint[]
}

export interface AgentMonitor {
  id: string
  name: string
  model?: string
  enabled: boolean
  online: boolean
  error?: string
  busy: boolean
  runningCount: number
  taskCount: number
  lastActiveAt?: number
  /** 正在做的一句话（运行中才有） */
  currentActivity?: string
  resources: AgentResourceView[]
}

export type TaskType = 'schedule' | 'chat' | 'orchestrate'

export interface TaskActivity {
  phase: string
  runningTools: Array<{ name: string; ms?: number; argsHead?: string; at: number }>
  todoCurrent?: string
  todosDone: number
  todosTotal: number
  subtasks?: { total: number; completed: number; failed: number; running: number; currentTitle?: string }
  turnCount: number
  lastToolAt?: number
}

export interface TaskMonitor {
  id: string
  title: string
  type: TaskType
  typeIcon: string
  typeLabel: string
  status: WorkTask['status']
  running: boolean
  agentIds: string[]
  agentNames: string[]
  createdAt: number
  updatedAt: number
  /** 本次执行已进行时长（运行中：自最近一条用户消息起；否则 undefined） */
  elapsedMs?: number
  /** 任务内容一句话（首条用户消息摘要） */
  description: string
  /** 当前状态一句话（给人看） */
  headline: string
  scheduleId?: string
  scheduleName?: string
  activity: TaskActivity
}

export interface ScheduleMonitor {
  id: string
  name: string
  enabled: boolean
  ruleText: string
  nextRunAt?: number
  lastRunAt?: number
  totalRuns: number
  successRuns: number
  lastRunOk?: boolean
  lastRunError?: string
}

export interface MonitorAlert {
  level: 'warn' | 'error'
  msg: string
  at: number
  refType?: 'agent' | 'task' | 'schedule' | 'resource'
  refId?: string
}

export interface MonitorOverview {
  at: number
  kpi: {
    agentsTotal: number
    agentsOnline: number
    agentsBusy: number
    agentsDisabled: number
    tasksRunning: number
    tasksCompletedToday: number
    tasksFailedToday: number
    tokensInputToday: number
    tokensOutputToday: number
    cacheReadToday: number
    toolCallsToday: number
    schedulesTotal: number
    schedulesEnabled: number
    nextScheduleAt?: number
    nextScheduleName?: string
  }
  agents: AgentMonitor[]
  tasks: TaskMonitor[]
  schedules: ScheduleMonitor[]
  sshPool: Array<{ id: string; name: string; host: string; port: number; ok?: boolean; lastTestedAt?: number; inUse: ResourceUsageHint[] }>
  alerts: MonitorAlert[]
  events: MonitorEvent[]
}

// ---------------------------------------------------------------- 服务

const RETENTION_DAYS = 30
const HEALTH_INTERVAL_MS = 30_000
const OVERVIEW_CACHE_MS = 3_000
const TODOS_TTL_MS = 10_000
const TOOL_USE_WINDOW_MS = 10 * 60_000

export class MonitorService {
  private client = new DshClient()
  private monitorDir: string
  private ring: MonitorEvent[] = []
  private unsubEngine?: () => void
  private healthTimer: ReturnType<typeof setInterval> | null = null
  private snapTimer: ReturnType<typeof setInterval> | null = null
  private lastSnapHour = 0
  private stopped = false

  /** 子智能体健康（健康巡检写入，overview 直接读取；HTTP 轮询不触发巡检） */
  private health = new Map<string, { online: boolean; error?: string; baseUrl?: string; at: number }>()
  /** 资源入口最近一次观测（端口漂移检测） */
  private seenEndpoints = new Map<string, { baseUrl: string; name: string; online: boolean }>()
  /** 任务状态迁移追踪（engine 事件 → 生命周期事件） */
  private taskStatus = new Map<string, WorkTask['status']>()
  private taskStartedAt = new Map<string, number>()

  /** 运行中任务清单缓存：taskId → todos 取数结果 */
  private todosCache = new Map<string, { at: number; value: { todoCurrent?: string; todosDone: number; todosTotal: number; running?: boolean; elapsedMs?: number } }>()
  private todosInflight = new Map<string, Promise<{ todoCurrent?: string; todosDone: number; todosTotal: number; running?: boolean; elapsedMs?: number }>>()

  private overviewCache: { at: number; value: MonitorOverview } | null = null
  private overviewInflight: Promise<MonitorOverview> | null = null

  constructor(
    private store: MonitorStoreDeps,
    private directory: OnenatDirectory,
    private resolver: AgentResolver,
    private engine: TaskEngine,
    private scheduler: ScheduleRunner | undefined,
    private sshStore: SshResourceStore,
    private planner: Planner,
    dataDir: string,
    private log: (msg: string) => void = () => {},
  ) {
    this.monitorDir = join(dataDir, 'monitor')
    try {
      if (!existsSync(this.monitorDir)) mkdirSync(this.monitorDir, { recursive: true })
    } catch { /* 只读文件系统下降级为纯内存 */ }
  }

  // ---------- 生命周期 ----------

  public start(): void {
    this.unsubEngine = this.engine.onTap((taskId, e) => this.onTaskEvent(taskId, e))
    if (this.scheduler) {
      this.scheduler.onRunFinished = (scheduleId, run) => {
        const s = this.store.getSchedule(scheduleId)
        const okCount = run.items.filter((i) => i.taskId).length
        const failed = run.items.filter((i) => i.error)
        const msg = failed.length
          ? `定时任务「${s?.name || scheduleId}」${run.manual ? '手动触发' : '触发'}：${okCount}/${run.items.length} 个智能体派发成功${failed.length ? `，失败：${failed[0].error}` : ''}`
          : `定时任务「${s?.name || scheduleId}」${run.manual ? '手动触发' : '触发'}：${okCount}/${run.items.length} 个智能体派发成功`
        this.record({
          at: run.triggeredAt,
          kind: 'schedule_fired',
          level: failed.length ? 'warn' : 'info',
          msg,
          scheduleId,
          taskId: run.items.find((i) => i.taskId)?.taskId,
        })
      }
    }
    // 首轮巡检立刻做一次，overview 首屏即有健康数据
    void this.healthSweep()
    this.healthTimer = setInterval(() => void this.healthSweep(), HEALTH_INTERVAL_MS)
    this.healthTimer.unref?.()
    this.snapTimer = setInterval(() => void this.snapshotTick(), 60_000)
    this.snapTimer.unref?.()
    this.cleanupRetention()
    this.log('监控服务已启动（健康巡检 30s · 小时快照 · 事件落盘 monitor/）')
  }

  public stop(): void {
    this.stopped = true
    this.unsubEngine?.()
    this.unsubEngine = undefined
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null }
    if (this.snapTimer) { clearInterval(this.snapTimer); this.snapTimer = null }
  }

  // ---------- 事件采集 ----------

  private onTaskEvent(taskId: string, e: TaskEvent): void {
    try {
      if (e.type === 'task_status') {
        const prev = this.taskStatus.get(taskId)
        const now = e.status
        this.taskStatus.set(taskId, now)
        if (prev === now) return
        const task = this.store.getTask(taskId)
        const title = task?.title || taskId
        if (now === 'running') {
          this.taskStartedAt.set(taskId, Date.now())
          this.record({
            at: Date.now(), kind: 'task_started', level: 'info', taskId,
            msg: `任务「${title}」开始执行（智能体：${(task?.memberAgentIds || []).map((id) => this.store.getAgent(id)?.name || id).join('、') || '—'}）`,
          })
        } else if (now === 'completed' || now === 'success') {
          this.record({
            at: Date.now(), kind: 'task_completed', level: 'info', taskId,
            msg: `任务「${title}」完成（耗时 ${fmtDuration(Date.now() - (this.taskStartedAt.get(taskId) || Date.now()))}）`,
          })
        } else if (now === 'failed') {
          const err = lastErrorFromLogs(task)
          this.record({
            at: Date.now(), kind: 'task_failed', level: 'error', taskId,
            msg: `任务「${title}」失败${err ? '：' + err : ''}`,
          })
        } else if (now === 'cancelled') {
          this.record({ at: Date.now(), kind: 'task_cancelled', level: 'warn', taskId, msg: `任务「${title}」已中止` })
        }
      } else if (e.type === 'plan_update' && e.plan) {
        const task = this.store.getTask(taskId)
        this.record({
          at: Date.now(), kind: 'plan_created', level: 'info', taskId,
          msg: `编排计划生成：${e.plan.subtasks.length} 个子任务 · 策略 ${strategyText(e.plan.strategy)}（任务「${task?.title || taskId}」）`,
        })
      } else if (e.type === 'subtask_status') {
        const sub: PlanSubtask | undefined = e.subtask
        if (!sub) return
        const task = this.store.getTask(taskId)
        if (sub.status === 'completed') {
          this.record({ at: Date.now(), kind: 'subtask_completed', level: 'info', taskId, agentId: sub.agentId, msg: `子任务「${sub.title}」完成（任务「${task?.title || taskId}」）` })
        } else if (sub.status === 'failed') {
          this.record({ at: Date.now(), kind: 'subtask_failed', level: 'error', taskId, agentId: sub.agentId, msg: `子任务「${sub.title}」失败（任务「${task?.title || taskId}」）${sub.error ? '：' + sub.error : ''}` })
        }
      }
    } catch { /* 监控采集异常绝不影响业务 */ }
  }

  private record(e: MonitorEvent): void {
    this.ring.unshift(e)
    if (this.ring.length > 500) this.ring.length = 500
    this.overviewCache = null
    this.appendEventFile(e)
  }

  private appendEventFile(e: MonitorEvent): void {
    if (!this.monitorDir) return
    try {
      appendFileSync(this.dayFile('events', e.at), JSON.stringify(e) + '\n', 'utf-8')
    } catch { /* 落盘失败降级为纯内存 */ }
  }

  private dayFile(kind: 'events' | 'snapshots', at: number): string {
    const d = new Date(at)
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return join(this.monitorDir, `${kind}-${ymd}.jsonl`)
  }

  // ---------- 健康巡检 ----------

  private async healthSweep(): Promise<void> {
    if (this.stopped) return
    try {
      const agents = this.store.getAgents()
      for (const agent of agents) {
        if (!agent.enabled) { this.health.delete(agent.id); continue }
        const target = await this.resolver.resolve(agent).catch(() => undefined)
        const prev = this.health.get(agent.id)
        const cur = {
          online: Boolean(target?.online),
          error: target?.online ? undefined : target?.error,
          baseUrl: target?.baseUrl || undefined,
          at: Date.now(),
        }
        this.health.set(agent.id, cur)
        if (prev && prev.online && !cur.online) {
          this.record({ at: Date.now(), kind: 'agent_offline', level: 'error', agentId: agent.id, msg: `子智能体「${agent.name}」离线${cur.error ? '：' + cur.error : ''}` })
        } else if (prev && !prev.online && cur.online) {
          this.record({ at: Date.now(), kind: 'agent_online', level: 'info', agentId: agent.id, msg: `子智能体「${agent.name}」恢复在线` })
        }
      }
      // 清理已删除智能体的健康记录
      const ids = new Set(agents.map((a) => a.id))
      for (const id of this.health.keys()) if (!ids.has(id)) this.health.delete(id)

      // 资源入口观测：在线状态迁移 + 端口漂移
      for (const ep of this.directory.listEndpoints()) {
        const key = ep.mappingId
        const prev = this.seenEndpoints.get(key)
        const cur = { baseUrl: ep.baseUrl || '', name: ep.note || ep.tunnelName || ep.mappingId, online: ep.online }
        this.seenEndpoints.set(key, cur)
        if (!prev) continue
        const boundBy = agents.filter((a) => a.resources.some((r) => 'mappingId' in r.ref && r.ref.mappingId === key))
        const boundNames = boundBy.map((a) => a.name).join('、')
        if (prev.online && !cur.online && boundBy.length) {
          this.record({ at: Date.now(), kind: 'resource_offline', level: 'warn', msg: `资源「${cur.name}」离线${boundNames ? '（绑定：' + boundNames + '）' : ''}` })
        } else if (!prev.online && cur.online && boundBy.length) {
          this.record({ at: Date.now(), kind: 'resource_online', level: 'info', msg: `资源「${cur.name}」恢复在线${boundNames ? '（绑定：' + boundNames + '）' : ''}` })
        } else if (cur.online && prev.baseUrl && cur.baseUrl && prev.baseUrl !== cur.baseUrl && boundBy.length) {
          this.record({ at: Date.now(), kind: 'resource_drift', level: 'warn', msg: `资源「${cur.name}」入口变化（端口漂移）：${prev.baseUrl} → ${cur.baseUrl}${boundNames ? '（绑定：' + boundNames + '）' : ''}` })
        }
      }
    } catch (err: any) {
      this.log(`监控健康巡检失败: ${err?.message || err}`)
    }
  }

  // ---------- 小时快照 ----------

  private async snapshotTick(): Promise<void> {
    if (this.stopped) return
    try {
      const hour = Math.floor(Date.now() / 3_600_000)
      if (hour === this.lastSnapHour) return
      this.lastSnapHour = hour
      const snap = this.computeSnapshot()
      try {
        appendFileSync(this.dayFile('snapshots', snap.at), JSON.stringify(snap) + '\n', 'utf-8')
      } catch { /* 降级 */ }
      if (new Date().getHours() === 0) this.cleanupRetention()
    } catch { /* 快照失败不影响业务 */ }
  }

  private computeSnapshot(): MonitorSnapshot {
    const now = Date.now()
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0)
    const agents = this.store.getAgents()
    const tasks = this.store.getTasks()
    let running = 0
    let completedToday = 0
    let failedToday = 0
    let tokensIn = 0
    let tokensOut = 0
    let cacheRead = 0
    let toolCalls = 0
    for (const t of tasks) {
      if (this.engine.isRunning(t.id)) running += 1
      if (t.updatedAt >= dayStart.getTime()) {
        if (t.status === 'completed' || t.status === 'success') completedToday += 1
        else if (t.status === 'failed') failedToday += 1
      }
      for (const turn of t.turns || []) {
        if (turn.at >= dayStart.getTime()) {
          const u = usageOf(turn.usage)
          tokensIn += u.input
          tokensOut += u.output
          cacheRead += u.cacheRead
          toolCalls += (turn.tools || []).length
        }
      }
    }
    return {
      at: now,
      agentsTotal: agents.length,
      agentsOnline: agents.filter((a) => a.enabled !== false && this.health.get(a.id)?.online).length,
      tasksRunning: running,
      tasksCompletedToday: completedToday,
      tasksFailedToday: failedToday,
      schedulesEnabled: this.store.getSchedules().filter((s) => s.enabled).length,
      tokensInputToday: tokensIn,
      tokensOutputToday: tokensOut,
      cacheReadToday: cacheRead,
      toolCallsToday: toolCalls,
    }
  }

  /** 读取最近 N 天的小时快照（回看多天趋势） */
  public readHistory(days: number): Array<{ date: string; snapshots: MonitorSnapshot[] }> {
    const n = Math.min(Math.max(1, Math.floor(days) || 7), RETENTION_DAYS)
    const out: Array<{ date: string; snapshots: MonitorSnapshot[] }> = []
    const now = new Date()
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86_400_000)
      const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      const file = join(this.monitorDir, `snapshots-${ymd}.jsonl`)
      const snapshots: MonitorSnapshot[] = []
      try {
        if (existsSync(file)) {
          for (const line of readFileSync(file, 'utf-8').split('\n')) {
            const s = line.trim() ? safeJson<MonitorSnapshot>(line) : undefined
            if (s && typeof s.at === 'number') snapshots.push(s)
          }
        }
      } catch { /* 单日文件损坏跳过 */ }
      out.push({ date: ymd, snapshots })
    }
    return out
  }

  private cleanupRetention(): void {
    try {
      const cutoff = Date.now() - RETENTION_DAYS * 86_400_000
      for (const f of readdirSync(this.monitorDir)) {
        const m = /^(\w+)-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f)
        if (!m) continue
        const t = new Date(m[2] + 'T00:00:00').getTime()
        if (Number.isFinite(t) && t < cutoff - 86_400_000) {
          try { unlinkSync(join(this.monitorDir, f)) } catch { /* 忽略 */ }
        }
      }
    } catch { /* 忽略 */ }
  }

  // ---------- 聚合总览 ----------

  public async getOverview(force = false): Promise<MonitorOverview> {
    if (!force && this.overviewCache && Date.now() - this.overviewCache.at < OVERVIEW_CACHE_MS) return this.overviewCache.value
    if (this.overviewInflight) return this.overviewInflight
    this.overviewInflight = this.buildOverview().finally(() => { this.overviewInflight = null })
    const value = await this.overviewInflight
    this.overviewCache = { at: Date.now(), value }
    return value
  }

  public getRecentEvents(limit: number): MonitorEvent[] {
    return this.ring.slice(0, Math.min(Math.max(1, limit), 500))
  }

  private async buildOverview(): Promise<MonitorOverview> {
    const now = Date.now()
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0)
    const agents = this.store.getAgents()
    const tasks = this.store.getTasks()
    const schedules = this.store.getSchedules()

    // 任务类型映射：schedule.runs[].items[].taskId（可靠）；标题 ⏰ 前缀兜底
    const scheduleOfTask = new Map<string, ScheduledTask>()
    for (const s of schedules) {
      for (const run of s.runs || []) {
        for (const item of run.items) {
          if (item.taskId && !scheduleOfTask.has(item.taskId)) scheduleOfTask.set(item.taskId, s)
        }
      }
    }

    // 运行中任务 → 资源使用线索（最近 10 分钟工具调用参数文本）
    const useHaystacks: Array<{ taskId: string; taskTitle: string; text: string; at: number }> = []
    for (const t of tasks) {
      if (!this.engine.isRunning(t.id)) continue
      const recent = (t.turns || []).slice(-2)
      for (const turn of recent) {
        for (const tool of turn.tools || []) {
          const at = tool.at || turn.at
          if (now - at > TOOL_USE_WINDOW_MS) continue
          useHaystacks.push({ taskId: t.id, taskTitle: t.title, text: `${tool.name} ${tool.args || ''} ${tool.result || ''}`.toLowerCase(), at })
        }
      }
    }
    const matchUses = (needles: string[]): ResourceUsageHint[] => {
      const hits: ResourceUsageHint[] = []
      for (const h of useHaystacks) {
        if (needles.some((n) => n.length >= 4 && h.text.includes(n))) {
          hits.push({ taskId: h.taskId, taskTitle: h.taskTitle, tool: h.text.split(' ', 1)[0] || '', at: h.at })
        }
      }
      return hits
    }

    // 智能体视图
    const runningTasks = tasks.filter((t) => this.engine.isRunning(t.id))
    const agentViews: AgentMonitor[] = agents.map((a) => {
      const h = this.health.get(a.id)
      const mine = tasks.filter((t) => t.memberAgentIds.includes(a.id) && t.status !== 'draft')
      const myRunning = runningTasks.filter((t) => t.memberAgentIds.includes(a.id))
      const resources: AgentResourceView[] = (a.resources || []).map((r) => {
        const ep = 'mappingId' in r.ref ? this.directory.resolveMapping(r.ref.mappingId) : this.directory.resolveApp(r.ref.appId)
        const name = r.alias || ep?.note || ep?.tunnelName || ep?.appName || ('mappingId' in r.ref ? r.ref.mappingId : r.ref.appId)
        const needles = resourceNeedles(ep, name)
        return {
          ref: 'mappingId' in r.ref ? `mapping:${r.ref.mappingId}` : `app:${r.ref.appId}`,
          name,
          kind: ep?.kind || 'unknown',
          online: Boolean(ep?.online),
          endpoint: ep?.baseUrl || '',
          credentialMode: r.credentialMode,
          inUse: needles.length ? matchUses(needles) : [],
        }
      })
      const lastActiveAt = mine.length ? Math.max(...mine.map((t) => t.updatedAt || 0)) : undefined
      const act = myRunning.map((t) => this.taskHeadline(t, scheduleOfTask.get(t.id))).filter(Boolean)
      return {
        id: a.id,
        name: a.name,
        model: [a.provider, a.model].filter(Boolean).join('/') || undefined,
        enabled: a.enabled !== false,
        online: a.enabled !== false && Boolean(h?.online),
        error: a.enabled !== false ? h?.error : '已停用',
        busy: myRunning.length > 0,
        runningCount: myRunning.length,
        taskCount: mine.length,
        lastActiveAt,
        currentActivity: act[0],
        resources,
      }
    })

    // 任务视图（运行中任务并发补齐远端 todo 清单：给人看的「当前步骤」）
    const taskViews: TaskMonitor[] = tasks.map((t) => this.taskView(t, scheduleOfTask.get(t.id)))
    await Promise.all(tasks.filter((t) => this.engine.isRunning(t.id)).map(async (t) => {
      const view = taskViews.find((v) => v.id === t.id)
      if (!view) return
      const todo = await this.todosOf(t)
      if (todo.todoCurrent) view.activity.todoCurrent = todo.todoCurrent
      if (todo.todosTotal) { view.activity.todosDone = todo.todosDone; view.activity.todosTotal = todo.todosTotal }
    }))

    // 定时任务视图
    const scheduleViews: ScheduleMonitor[] = schedules.map((s) => {
      const last = (s.runs || [])[0]
      return {
        id: s.id,
        name: s.name,
        enabled: s.enabled,
        ruleText: ruleText(s.rule),
        nextRunAt: s.nextRunAt,
        lastRunAt: s.lastRunAt,
        totalRuns: s.totalRuns || 0,
        successRuns: s.successRuns || 0,
        lastRunOk: last ? last.items.some((i) => i.taskId) : undefined,
        lastRunError: last?.items.find((i) => i.error)?.error,
      }
    })

    // SSH 资源池
    const sshPool = this.sshStore.list().map((r) => ({
      id: r.id,
      name: r.name,
      host: r.host,
      port: r.port,
      ok: r.lastTestOk,
      lastTestedAt: r.lastTestedAt,
      inUse: matchUses([r.host, `${r.host}:${r.port}`]),
    }))

    // KPI
    let tasksCompletedToday = 0
    let tasksFailedToday = 0
    let tokensIn = 0
    let tokensOut = 0
    let cacheRead = 0
    let toolCalls = 0
    for (const t of tasks) {
      if (t.updatedAt >= dayStart.getTime()) {
        if (t.status === 'completed' || t.status === 'success') tasksCompletedToday += 1
        else if (t.status === 'failed') tasksFailedToday += 1
      }
      for (const turn of t.turns || []) {
        if (turn.at >= dayStart.getTime()) {
          const u = usageOf(turn.usage)
          tokensIn += u.input
          tokensOut += u.output
          cacheRead += u.cacheRead
          toolCalls += (turn.tools || []).length
        }
      }
    }
    const nextSchedules = schedules
      .filter((s) => s.enabled && typeof s.nextRunAt === 'number')
      .sort((a, b) => (a.nextRunAt || 0) - (b.nextRunAt || 0))

    // 告警
    const alerts: MonitorAlert[] = []
    for (const a of agentViews) {
      if (!a.enabled) continue
      if (!a.online) alerts.push({ level: 'error', msg: `子智能体「${a.name}」离线${a.error ? '：' + a.error : ''}`, at: Date.now(), refType: 'agent', refId: a.id })
    }
    for (const t of tasks) {
      if (t.status === 'failed' && now - (t.updatedAt || 0) < 86_400_000) {
        alerts.push({ level: 'error', msg: `任务「${t.title}」失败`, at: t.updatedAt || now, refType: 'task', refId: t.id })
      }
    }
    for (const s of scheduleViews) {
      if (s.enabled && s.lastRunOk === false) {
        alerts.push({ level: 'warn', msg: `定时任务「${s.name}」最近一次触发失败${s.lastRunError ? '：' + s.lastRunError : ''}`, at: s.lastRunAt || now, refType: 'schedule', refId: s.id })
      }
    }
    alerts.sort((a, b) => b.at - a.at)

    const kpi = {
      agentsTotal: agents.length,
      agentsOnline: agentViews.filter((a) => a.online).length,
      agentsBusy: agentViews.filter((a) => a.busy).length,
      agentsDisabled: agentViews.filter((a) => !a.enabled).length,
      tasksRunning: runningTasks.length,
      tasksCompletedToday,
      tasksFailedToday,
      tokensInputToday: tokensIn,
      tokensOutputToday: tokensOut,
      cacheReadToday: cacheRead,
      toolCallsToday: toolCalls,
      schedulesTotal: schedules.length,
      schedulesEnabled: schedules.filter((s) => s.enabled).length,
      ...(nextSchedules[0] ? { nextScheduleAt: nextSchedules[0].nextRunAt, nextScheduleName: nextSchedules[0].name } : {}),
    }

    return {
      at: now,
      kpi,
      agents: agentViews,
      tasks: taskViews,
      schedules: scheduleViews,
      sshPool,
      alerts: alerts.slice(0, 30),
      events: this.ring.slice(0, 100),
    }
  }

  // ---------- 任务视图与人类可读描述 ----------

  private taskView(t: WorkTask, schedule: ScheduledTask | undefined): TaskMonitor {
    const running = this.engine.isRunning(t.id)
    // 类型识别三层兜底：创建时持久化的 scheduleId → runs 关联（50 条窗口内）→ 标题 ⏰ 前缀（历史任务/调度已删）
    if (!schedule && t.scheduleId) {
      schedule = {
        id: t.scheduleId,
        name: t.scheduleName || t.title.replace(/^⏰\s*/, ''),
        agentIds: [],
        message: '',
        rule: { kind: 'daily', times: [] },
        enabled: false,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        runs: [],
      } as ScheduledTask
    }
    if (!schedule && t.title.startsWith('⏰')) {
      schedule = {
        id: `legacy-${t.id}`,
        name: t.title.replace(/^⏰\s*/, ''),
        agentIds: [],
        message: '',
        rule: { kind: 'daily', times: [] },
        enabled: false,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        runs: [],
      } as ScheduledTask
    }
    const type: TaskType = schedule ? 'schedule' : t.mode === 'orchestrate' ? 'orchestrate' : 'chat'
    const typeIcon = type === 'schedule' ? '⏰' : type === 'orchestrate' ? '🎯' : '💬'
    const typeLabel = type === 'schedule' ? '定时任务' : type === 'orchestrate' ? '协同编排' : '直通对话'
    const agentNames = t.memberAgentIds.map((id) => this.store.getAgent(id)?.name || id)
    const activity = this.taskActivity(t, running)
    const elapsedMs = running ? this.elapsedOf(t) : undefined
    return {
      id: t.id,
      title: t.title,
      type,
      typeIcon,
      typeLabel,
      status: t.status,
      running,
      agentIds: [...t.memberAgentIds],
      agentNames,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      ...(elapsedMs !== undefined ? { elapsedMs } : {}),
      description: firstUserText(t),
      headline: this.taskHeadline(t, schedule),
      ...(schedule ? { scheduleId: schedule.id, scheduleName: schedule.name } : {}),
      activity,
    }
  }

  /** 给人看的一句话状态 */
  private taskHeadline(t: WorkTask, schedule?: ScheduledTask): string {
    const running = this.engine.isRunning(t.id)
    const prefix = schedule ? '⏰ ' : ''
    if (t.status === 'draft') return prefix + '等待发送'
    if (running) {
      const parts: string[] = []
      const plan = t.plan
      if (plan && plan.subtasks.length) {
        const done = plan.subtasks.filter((s) => s.status === 'completed').length
        const cur = plan.subtasks.find((s) => s.status === 'running')
        if (cur) parts.push(`子任务 ${done + 1}/${plan.subtasks.length}「${cur.title}」执行中`)
        else parts.push(`子任务进度 ${done}/${plan.subtasks.length}`)
      }
      const tool = this.currentTool(t)
      if (tool) parts.push(`正在调用工具「${tool.name}」`)
      else if (!parts.length) parts.push('正在生成回复')
      return prefix + parts.join(' · ')
    }
    if (t.status === 'completed' || t.status === 'success') return prefix + '已完成'
    if (t.status === 'failed') return prefix + '失败' + (lastErrorFromLogs(t) ? '：' + (lastErrorFromLogs(t) || '') : '')
    if (t.status === 'cancelled') return prefix + '已中止'
    if (t.status === 'partial_success') return prefix + '部分成功'
    return prefix + t.status
  }

  private taskActivity(t: WorkTask, running: boolean): TaskActivity {
    const turns = t.turns || []
    const last = turns[turns.length - 1]
    const tools: Array<{ name: string; ms?: number; argsHead?: string; at: number }> = []
    let lastToolAt: number | undefined
    for (const turn of turns.slice(-2)) {
      for (const tool of turn.tools || []) {
        if (tool.status === 'running') {
          tools.push({ name: tool.name, argsHead: (tool.args || '').slice(0, 80), at: tool.at || turn.at })
        }
        if (tool.at && (!lastToolAt || tool.at > lastToolAt)) lastToolAt = tool.at
      }
    }
    const plan = t.plan
    let subtasks: TaskActivity['subtasks']
    if (plan && plan.subtasks.length) {
      const cur = plan.subtasks.find((s) => s.status === 'running')
      subtasks = {
        total: plan.subtasks.length,
        completed: plan.subtasks.filter((s) => s.status === 'completed').length,
        failed: plan.subtasks.filter((s) => s.status === 'failed').length,
        running: plan.subtasks.filter((s) => s.status === 'running').length,
        ...(cur ? { currentTitle: cur.title } : {}),
      }
    }
    return {
      phase: this.taskHeadline(t),
      runningTools: running ? tools : [],
      todosDone: 0,
      todosTotal: 0,
      ...(subtasks ? { subtasks } : {}),
      turnCount: turns.length,
      ...(lastToolAt ? { lastToolAt } : {}),
    }
  }

  private currentTool(t: WorkTask): { name: string } | undefined {
    const turns = t.turns || []
    for (const turn of turns.slice(-2)) {
      const tool = (turn.tools || []).find((x) => x.status === 'running')
      if (tool) return { name: tool.name }
    }
    return undefined
  }

  private elapsedOf(t: WorkTask): number {
    const turns = t.turns || []
    let lastUserAt = 0
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === 'user') { lastUserAt = turns[i].at; break }
    }
    const start = this.taskStartedAt.get(t.id) || lastUserAt || t.updatedAt || Date.now()
    return Math.max(0, Date.now() - start)
  }

  /** 运行中任务的 todo 清单（主智能体会话优先），10s TTL；失败/不支持返回空 */
  private async todosOf(t: WorkTask): Promise<{ todoCurrent?: string; todosDone: number; todosTotal: number; running?: boolean; elapsedMs?: number }> {
    const cached = this.todosCache.get(t.id)
    if (cached && Date.now() - cached.at < TODOS_TTL_MS) return cached.value
    const inflight = this.todosInflight.get(t.id)
    if (inflight) return inflight
    const job = (async () => {
      const value = await this.fetchTodos(t)
      this.todosCache.set(t.id, { at: Date.now(), value })
      return value
    })()
    this.todosInflight.set(t.id, job)
    try {
      return await job
    } finally {
      this.todosInflight.delete(t.id)
    }
  }

  private async fetchTodos(t: WorkTask): Promise<{ todoCurrent?: string; todosDone: number; todosTotal: number; running?: boolean; elapsedMs?: number }> {
    const empty = { todosDone: 0, todosTotal: 0 }
    const bindings = Object.entries(t.sessions || {})
    if (!bindings.length) return empty
    const main = this.planner.pickMainAgent()
    bindings.sort((a, b) => (a[0] === main?.id ? -1 : 0) - (b[0] === main?.id ? -1 : 0))
    for (const [agentId, binding] of bindings) {
      const agent = this.store.getAgent(agentId)
      if (!agent) continue
      const target = await this.resolver.resolve(agent).catch(() => undefined)
      if (!target?.online || !target.baseUrl) continue
      const r = await this.client.getSessionTodos(target, binding.remoteSessionId).catch(() => undefined)
      if (!r?.ok || !r.supported || !r.todos?.length) continue
      const cur = r.todos.find((x) => x.status === 'in_progress')
      return {
        ...(cur ? { todoCurrent: cur.content } : {}),
        todosDone: r.todos.filter((x) => x.status === 'completed').length,
        todosTotal: r.todos.length,
        running: r.running,
        elapsedMs: r.elapsedMs,
      }
    }
    return empty
  }
}

// ---------------------------------------------------------------- 依赖接口（避免与实现循环 import）

export interface MonitorStoreDeps {
  getAgents(): SubAgent[]
  getAgent(id: string): SubAgent | undefined
  getTasks(): WorkTask[]
  getTask(id: string): WorkTask | undefined
  getSchedules(): ScheduledTask[]
  getSchedule(id: string): ScheduledTask | undefined
}

// ---------------------------------------------------------------- 工具函数

function safeJson<T>(line: string): T | undefined {
  try { return JSON.parse(line) as T } catch { return undefined }
}

/** 从任务日志里取最后一条错误 */
function lastErrorFromLogs(t: WorkTask | undefined): string | undefined {
  if (!t?.taskLogs) return undefined
  for (let i = t.taskLogs.length - 1; i >= 0; i--) {
    const e = t.taskLogs[i]
    if (e.level === 'error' && e.msg) return e.msg.slice(0, 120)
  }
  return undefined
}

function strategyText(s: 'parallel' | 'sequential' | 'dag'): string {
  return s === 'parallel' ? '并行' : s === 'sequential' ? '串行' : 'DAG'
}

function firstUserText(t: WorkTask): string {
  const first = (t.turns || []).find((x) => x.role === 'user')
  if (!first) return ''
  return first.text.replace(/\s+/g, ' ').trim().slice(0, 80)
}

/** token 账本求和：兼容多种字段命名（inputTokens/prompt_tokens/…） */
function usageOf(usage: Record<string, number> | undefined): { input: number; output: number; cacheRead: number } {
  const u = usage || {}
  let input = 0
  let output = 0
  let cacheRead = 0
  for (const [k, v] of Object.entries(u)) {
    if (typeof v !== 'number') continue
    const key = k.toLowerCase()
    if (key.includes('cache') && (key.includes('read') || key.includes('hit'))) cacheRead += v
    else if (key.includes('input') || key.includes('prompt')) input += v
    else if (key.includes('output') || key.includes('completion')) output += v
  }
  return { input, output, cacheRead }
}

/** 资源匹配关键词：host、host:port、别名/备注/隧道名/应用名（小写，≥4 字符才参与匹配） */
function resourceNeedles(ep: ResolvedEndpoint | undefined, name: string): string[] {
  const set = new Set<string>()
  const push = (v: string | undefined) => {
    const s = String(v || '').trim().toLowerCase()
    if (s.length >= 4) set.add(s)
  }
  if (ep) {
    push(ep.host)
    if (ep.port) push(`${ep.host}:${ep.port}`)
    push(ep.note)
    push(ep.tunnelName)
    push(ep.appName)
  }
  push(name)
  return [...set]
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时 ${m % 60} 分`
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`
}
