/**
 * onenat-workbuddy-web - ScheduleRunner: 定时任务调度器（Host 权威）
 *
 * 设计对齐 dsh-task-board 的调度语义：
 *  - Host 本地时区计算触发点；浏览器关闭不影响触发
 *  - 固定间隔 tick 扫描（20s），错过触发点不补跑：直接推进到下一个未来触发点
 *  - 触发 = 对每个目标子智能体独立创建任务会话并派发固定任务文本（复用 TaskEngine 派发链路）
 */

import { randomUUID } from 'node:crypto'
import type { WorkStore } from './store.js'
import type { TaskEngine } from './engine.js'
import type { ScheduleRule, ScheduleRun, ScheduleRunItem, ScheduledTask } from './types.js'

const TICK_MS = 20_000
const MAX_RUNS = 50
/** 单个子智能体派发失败时的重试次数（不含首次尝试） */
const DISPATCH_RETRIES = 1
/** 重试前等待毫秒 */
const RETRY_DELAY_MS = 2_000

export class ScheduleRunner {
  private timer: ReturnType<typeof setInterval> | null = null
  private firing = new Set<string>()
  /** 手动触发去重：scheduleId → 上次手动触发时间（防双击 3 秒窗口） */
  private lastManualFire = new Map<string, number>()

  /** 触发完成回调（监控采集用）：scheduleId + 本次运行记录（含派发结果） */
  public onRunFinished: ((scheduleId: string, run: ScheduleRun) => void) | null = null

  constructor(
    private store: WorkStore,
    private engine: TaskEngine,
    private log: (msg: string) => void = () => {},
    private directory?: import('./onenat.js').OnenatDirectory,
  ) {}

  public start(): void {
    if (this.timer) return
    // 启动时为缺 nextRunAt 的启用任务补算（错过的触发点不补跑，nextRun 只算未来点）
    for (const s of this.store.getSchedules()) {
      if (s.enabled && !s.nextRunAt) {
        this.store.mutateSchedule(s.id, (t) => {
          t.nextRunAt = nextRun(t.rule, Date.now())
        })
      }
    }
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.timer.unref?.()
    this.log(`定时任务调度器已启动（tick ${TICK_MS / 1000}s）`)
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private tick(): void {
    const now = Date.now()
    for (const s of this.store.getSchedules()) {
      if (!s.enabled || !s.nextRunAt) continue
      if (s.nextRunAt > now) continue
      if (now - s.nextRunAt > TICK_MS + 5_000) {
        // 进程休眠/停机错过的触发点：不补跑，直接跳到下一个未来点
        this.store.mutateSchedule(s.id, (t) => {
          t.nextRunAt = nextRun(t.rule, now)
        })
        this.log(`定时任务「${s.name}」错过触发点（${new Date(s.nextRunAt).toLocaleString()}），已跳过不补跑`)
        continue
      }
      void this.fire(s.id, false).catch((err) => {
        this.log(`定时任务「${s.name}」触发失败: ${err?.message || err}`)
      })
    }
  }

  /** 触发一次（定时或手动）。指令原样创建一个任务会话（@ 提及由引擎解析：单人多轮直通 / 多人协同编排）。 */
  public async fire(scheduleId: string, manual: boolean): Promise<ScheduleRun | undefined> {
    const s = this.store.getSchedule(scheduleId)
    if (!s) return undefined
    if (!manual) {
      if (this.firing.has(scheduleId)) return undefined
      this.firing.add(scheduleId)
    } else {
      // 手动触发 3 秒去重：双击/界面无反馈连点会发出两次 POST，第二次直接返回最近一次 run
      const last = this.lastManualFire.get(scheduleId)
      if (last && Date.now() - last < 3_000) {
        const lastRun = s.runs?.[0]
        this.log(`定时任务「${s.name}」${Math.round((Date.now() - last) / 1000)}s 内重复手动触发，已忽略（防双击）`)
        return lastRun
      }
      this.lastManualFire.set(scheduleId, Date.now())
    }
    try {
      const run: ScheduleRun = {
        id: `run-${randomUUID().slice(0, 8)}`,
        triggeredAt: Date.now(),
        ...(manual ? { manual: true } : {}),
        items: [],
      }
      const runStart = Date.now()
      // 过滤已删除的子智能体
      const validAgents = s.agentIds
        .map((aid) => this.store.getAgent(aid))
        .filter((a): a is NonNullable<typeof a> => Boolean(a))
      // 主 DSH 节点：新模型优先 schedule.nodeMappingId；存量无节点时回退首个子智能体的绑定映射节点；
      // 仍无节点（无 @ 子智能体 + 未配置节点）→ 用户语义「无子智能体=主 DSH 执行」：取目录首个在线 DSH 作为主节点
      const legacyNodeMappingId = validAgents.find((a) => a.dshRef?.kind === 'mapping' && a.dshRef.mappingId)?.dshRef as { kind: 'mapping'; mappingId: string } | undefined
      let nodeMappingId = s.nodeMappingId || legacyNodeMappingId?.mappingId || ''
      let nodeFallbackNote = ''
      if (!nodeMappingId) {
        const onlineDsh = this.directory?.listDshEndpoints().find((e: any) => e.online && e.baseUrl && e.mappingId)
        if (onlineDsh?.mappingId) {
          nodeMappingId = onlineDsh.mappingId
          nodeFallbackNote = `（未配置执行节点，已回退首个在线 DSH「${onlineDsh.tunnelName || onlineDsh.mappingId}」）`
          this.log(`定时任务「${s.name}」未配置执行节点且无 @ 子智能体，已回退首个在线 DSH「${onlineDsh.tunnelName || onlineDsh.mappingId}」执行`)
        }
      }
      const nodeRef = nodeMappingId ? { kind: 'mapping' as const, mappingId: nodeMappingId } : undefined
      // 单任务派发：指令原样交给 TaskEngine（与「新建任务」输入框同语义）——
      // 引擎 extractMentions 解析 @子智能体（@多个=协同编排）与 @资源（入口/凭证按绑定策略注入提示词）
      const items: ScheduleRunItem[] = []
      if (!validAgents.length && !nodeRef) {
        items.push({ agentId: s.agentIds[0] || '', agentName: s.agentIds[0] || '（无目标）', error: '任务未配置执行节点，且当前没有任何在线 DSH 节点可回退；请在编辑中选择执行节点' })
      } else {
        let lastErr = ''
        for (let attempt = 1; attempt <= 1 + DISPATCH_RETRIES; attempt++) {
          try {
            const task = await this.engine.createTask({
              title: `⏰ ${s.name}`,
              memberAgentIds: validAgents.map((a) => a.id),
              message: s.message,
              nodeRef,
              model: s.model,
              scheduleId: scheduleId,
              scheduleName: s.name,
            })
            if (validAgents.length) {
              for (const a of validAgents) {
                items.push({ agentId: a.id, agentName: a.name, taskId: task.id, taskTitle: task.title, attempts: attempt })
              }
            } else {
              const nodeTitle = nodeMappingId === s.nodeMappingId ? (s.nodeMappingId || '') : nodeMappingId
              items.push({ agentId: '__node__', agentName: `主 DSH 执行${nodeFallbackNote}`, taskId: task.id, taskTitle: task.title, attempts: attempt })
            }
            break
          } catch (err: any) {
            lastErr = err?.message || String(err)
            if (attempt <= DISPATCH_RETRIES && RETRY_DELAY_MS > 0) {
              await new Promise((r) => setTimeout(r, RETRY_DELAY_MS))
            }
          }
        }
        if (!items.length) {
          items.push({ agentId: validAgents[0]?.id || '__node__', agentName: validAgents[0]?.name || '节点主会话', error: lastErr, attempts: 1 + DISPATCH_RETRIES })
        }
      }
      run.items = items
      run.durationMs = Date.now() - runStart
      this.store.mutateSchedule(scheduleId, (t) => {
        t.runs.unshift(run)
        if (t.runs.length > MAX_RUNS) t.runs.length = MAX_RUNS
        t.lastRunAt = run.triggeredAt
        t.totalRuns = (t.totalRuns || 0) + 1
        if (run.items.some((i) => i.taskId)) t.successRuns = (t.successRuns || 0) + 1
        if (t.rule.kind === 'once' && !manual) t.enabled = false
        t.nextRunAt = t.enabled ? nextRun(t.rule, Date.now()) : undefined
      })
      const okCount = run.items.filter((i) => i.taskId).length
      this.log(`定时任务「${s.name}」${manual ? '手动触发' : '触发'}：${okCount}/${run.items.length} 个子智能体派发成功`)
      try {
        this.onRunFinished?.(scheduleId, run)
      } catch {
        /* 监控回调异常不影响调度 */
      }
      return run
    } finally {
      if (!manual) this.firing.delete(scheduleId)
    }
  }
}

// ---------- 规则 → 下次触发点（Host 本地时区） ----------

function parseHHmm(v: string): { h: number; m: number } | null {
  const mt = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim())
  if (!mt) return null
  const h = Number(mt[1])
  const m = Number(mt[2])
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return null
  return { h, m }
}

/**
 * 计算规则在 from 之后的下一个触发点（严格 > from，毫秒精度取整到秒）。
 * 返回 undefined 表示无未来触发点（如 once 已过期）。
 */
export function nextRun(rule: ScheduleRule, from: number): number | undefined {
  if (!rule) return undefined
  if (rule.kind === 'once') {
    return Number.isFinite(rule.at) && rule.at > from ? rule.at : undefined
  }
  if (rule.kind === 'interval') {
    const minutes = Math.max(1, Math.floor(Number(rule.minutes) || 0))
    if (!minutes) return undefined
    return from + minutes * 60_000
  }
  if (rule.kind === 'hourly') {
    const minute = Math.floor(Number(rule.minute))
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return undefined
    const cand = new Date(from)
    cand.setMinutes(minute, 0, 0)
    if (cand.getTime() > from) return cand.getTime()
    return cand.getTime() + 3_600_000
  }
  if (rule.kind === 'monthly') {
    const time = parseHHmm(rule.time)
    const days = [...new Set((rule.days || []).map((d) => Math.floor(Number(d))).filter((d) => d >= 1 && d <= 31))]
    if (!time || !days.length) return undefined
    const probe = new Date(from)
    probe.setHours(time.h, time.m, 0, 0)
    for (let monthOffset = 0; monthOffset < 25; monthOffset++) {
      const y = probe.getFullYear()
      const m = probe.getMonth() + monthOffset
      for (const day of [...days].sort((a, b) => a - b)) {
        const candDate = new Date(y, m, day, time.h, time.m, 0, 0)
        // 当月不存在的日期（如 2 月 30 日）Date 会顺延到下月，需校验回退
        if (candDate.getDate() !== day || candDate.getTime() <= from) continue
        return candDate.getTime()
      }
    }
    return undefined
  }
  if (rule.kind === 'daily') {
    const times = (rule.times || [])
      .map(parseHHmm)
      .filter(Boolean)
      .sort((a, b) => a!.h * 60 + a!.m - (b!.h * 60 + b!.m)) as Array<{ h: number; m: number }>
    if (!times.length) return undefined
    const base = new Date(from)
    base.setHours(0, 0, 0, 0)
    for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
      for (const t of times) {
        const cand = base.getTime() + dayOffset * 86_400_000 + t.h * 3_600_000 + t.m * 60_000
        if (cand > from) return cand
      }
    }
    return undefined
  }
  if (rule.kind === 'weekly') {
    const time = parseHHmm(rule.time)
    const days = [...new Set((rule.days || []).map((d) => Math.floor(Number(d))).filter((d) => d >= 0 && d <= 6))]
    if (!time || !days.length) return undefined
    const base = new Date(from)
    base.setHours(0, 0, 0, 0)
    for (let dayOffset = 0; dayOffset < 29; dayOffset++) {
      const dayDate = new Date(base.getTime() + dayOffset * 86_400_000)
      if (!days.includes(dayDate.getDay())) continue
      const cand = dayDate.getTime() + time.h * 3_600_000 + time.m * 60_000
      if (cand > from) return cand
    }
    return undefined
  }
  return undefined
}

/** 校验并规范化规则（供路由入参校验）；非法抛错 */
export function normalizeRule(input: any): ScheduleRule {
  const kind = String(input?.kind || '')
  if (kind === 'hourly') {
    const minute = Math.floor(Number(input.minute))
    if (!Number.isFinite(minute) || minute < 0 || minute > 59) throw new Error('每小时规则需要 0-59 的分钟数')
    return { kind: 'hourly', minute }
  }
  if (kind === 'monthly') {
    const time = parseHHmm(input.time)
    if (!time) throw new Error('每月规则需要合法时刻（HH:mm）')
    const dayNums = (Array.isArray(input.days) ? input.days : []).map((d: any) => Math.floor(Number(d))) as number[]
    const days: number[] = Array.from(new Set(dayNums).values()).filter((d) => d >= 1 && d <= 31)
    if (!days.length) throw new Error('每月规则需要至少勾选一个日期（1-31）')
    return { kind: 'monthly', days, time: `${time.h}:${String(time.m).padStart(2, '0')}` }
  }
  if (kind === 'daily') {
    const times = Array.isArray(input.times) ? input.times : []
    const valid = times.map((t: string) => parseHHmm(t)).filter(Boolean)
    if (!valid.length) throw new Error('每天规则需要至少一个合法时刻（HH:mm）')
    return { kind: 'daily', times: Array.from(new Set(times.filter((t: string) => parseHHmm(t))).values()) as string[] }
  }
  if (kind === 'weekly') {
    const time = parseHHmm(input.time)
    if (!time) throw new Error('每周规则需要合法时刻（HH:mm）')
    const dayNums = (Array.isArray(input.days) ? input.days : []).map((d: any) => Math.floor(Number(d))) as number[]
    const days: number[] = Array.from(new Set(dayNums).values()).filter((d) => d >= 0 && d <= 6)
    if (!days.length) throw new Error('每周规则需要至少勾选一个星期')
    return { kind: 'weekly', days, time: `${time.h}:${String(time.m).padStart(2, '0')}` }
  }
  if (kind === 'interval') {
    const minutes = Math.floor(Number(input.minutes))
    if (!Number.isFinite(minutes) || minutes < 1) throw new Error('间隔规则需要 ≥ 1 的分钟数')
    if (minutes > 60 * 24 * 30) throw new Error('间隔过大（最多 30 天）')
    return { kind: 'interval', minutes }
  }
  if (kind === 'once') {
    const at = Number(input.at)
    if (!Number.isFinite(at) || at <= Date.now()) throw new Error('一次性规则需要未来的时刻')
    return { kind: 'once', at }
  }
  throw new Error(`不支持的规则类型: ${kind || '(空)'}`)
}

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 规则 → 自然语言描述（后端统一产出，前端直接展示）。非法/缺字段返回降级文案 */
export function ruleText(rule: ScheduleRule | undefined): string {
  if (!rule) return '未配置规则'
  switch (rule.kind) {
    case 'once':
      return Number.isFinite(rule.at) ? new Date(rule.at).toLocaleString() : '一次性（时刻无效）'
    case 'interval': {
      const minutes = Math.max(1, Math.floor(Number(rule.minutes) || 0))
      if (minutes >= 1440 && minutes % 1440 === 0) return `每 ${minutes / 1440} 天`
      if (minutes >= 60 && minutes % 60 === 0) return `每 ${minutes / 60} 小时`
      return `每 ${minutes} 分钟`
    }
    case 'daily': {
      const times = (rule.times || []).map((t) => t.trim()).filter(Boolean)
      return times.length ? `每天 ${times.join('、')}` : '每天（未配置时刻）'
    }
    case 'weekly': {
      const days = [...new Set(rule.days || [])].sort((a, b) => a - b).map((d) => WEEKDAY_NAMES[d] ?? `周${d}`)
      if (!days.length) return '每周（未勾选星期）'
      if (days.length === 5 && [1, 2, 3, 4, 5].every((d) => (rule as any).days.includes(d))) {
        return `每工作日 ${rule.time}`
      }
      return `每周 ${days.join('、')} ${rule.time}`
    }
    case 'hourly': {
      const minute = Math.floor(Number(rule.minute))
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) return '每小时（分钟无效）'
      return `每小时的第 ${minute} 分`
    }
    case 'monthly': {
      const days = [...new Set(rule.days || [])].sort((a, b) => a - b)
      if (!days.length) return '每月（未勾选日期）'
      return `每月 ${days.join('、')} 号 ${rule.time}`
    }
    default:
      return '未配置规则'
  }
}

export type { ScheduledTask }
