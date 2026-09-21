/**
 * onenat-workbuddy-web - WorkStore: 子智能体池 + 任务会话 + 设置 持久化
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { AgentResourceBinding, DshRef, StorageData, SubAgent, WorkBuddySettings, WorkTask, PlanSubtask, TaskTurn, ScheduledTask } from './types.js'

function defaultSettings(): WorkBuddySettings {
  return {
    onenat: {
      baseUrl: 'https://onenat.sooncore.com',
      apiKey: 'onk-2d483fbaf1dffe489223cd1fb34dc14c4f38c5fb',
      autoRefreshMs: 60_000,
    },
    planner: {},
  }
}

/** 判断两个 DSH 实体引用是否指向同一个目标（用于同实体去重防重复新增） */
function sameDshRef(a: DshRef | undefined, b: DshRef): boolean {
  if (!a) return false
  if (a.kind === 'direct' && b.kind === 'direct') return normalizeUrl(a.apiBaseUrl || '') === normalizeUrl(b.apiBaseUrl || '')
  if (a.kind === 'mapping' && b.kind === 'mapping') return a.mappingId === b.mappingId
  if (a.kind === 'app' && b.kind === 'app') return a.appId === b.appId
  return false
}

function normalizeUrl(u: string): string {
  return u.trim().replace(/\/+$/, '').toLowerCase()
}

export class WorkStore {
  private filePath: string
  private data: StorageData
  /** 尾随合并落盘窗口：流式增量期间避免每个 delta 全量写盘阻塞事件循环 */
  private static readonly TRAILING_SAVE_MS = 250
  private saveTimer: NodeJS.Timeout | null = null
  private dirty = false

  constructor(customPath?: string) {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    this.filePath = customPath || join(dshHome, 'onenat-workbuddy', 'store.json')
    this.data = { agents: [], tasks: [], schedules: [], settings: { ...defaultSettings(), xiaozhi: {} } }
    this.load()
    // 进程退出前把尾随写入落盘（SIGKILL 除外），避免最后 250ms 的流式增量丢失。
    // 只挂 'exit'：SIGINT/SIGTERM 走默认终止路径同样会触发 exit，且不会劫持 Ctrl-C 语义。
    process.once('exit', () => { if (this.dirty) this.flush() })
  }

  /** 数据目录（store.json 所在目录）；分片上传暂存于其下 uploads/ */
  public get dataDir(): string {
    return dirname(this.filePath)
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8'))
        const xz = parsed.settings?.xiaozhi || {}
        // 旧版单接入点字符串 → endpoints 列表迁移
        const endpoints = Array.isArray(xz.endpoints) && xz.endpoints.length
          ? xz.endpoints
          : (typeof xz.endpoint === 'string' && xz.endpoint ? [{ id: 'xz-default', endpoint: xz.endpoint, enabled: true }] : [])
        this.data = {
          agents: Array.isArray(parsed.agents) ? parsed.agents : [],
          tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
          schedules: Array.isArray(parsed.schedules) ? parsed.schedules : [],
          settings: {
            onenat: { ...defaultSettings().onenat, ...(parsed.settings?.onenat || {}) },
            planner: { ...defaultSettings().planner, ...(parsed.settings?.planner || {}) },
            xiaozhi: { endpoints },
          },
        }
      }
      this.save()
    } catch {
      // 容错回退
    }
  }

  public save(): void {
    this.flush()
  }

  /**
   * 高频写入合并（流式增量专用）。
   *
   * 背景：每个 delta 都会走 mutateTask → save()，而 save() 是全量
   * `JSON.stringify(data) + writeFileSync`。实测在 1.5MB 级 store 上单次约 3.5ms，
   * 且**同步阻塞事件循环**：长回合（上千个 delta）可累计数秒阻塞，把远端 SSE 的读取
   * 与浏览器方向的写入一起拖慢，静默段还会触发隧道/反代的空闲超时把流掐断
   * （表现就是「流式卡住 / 内容收不全」）。
   *
   * 因此流式增量只改内存（内存态始终权威），磁盘写入按 TRAILING_SAVE_MS 尾随合并；
   * 结构性变更（增删任务/智能体/成员等）仍走 save() 立即落盘。
   */
  public scheduleSave(): void {
    this.dirty = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      if (this.dirty) this.flush()
    }, WorkStore.TRAILING_SAVE_MS)
    // 常驻定时器不阻止进程退出（standalone server 由 http server 保持存活）
    this.saveTimer.unref?.()
  }

  /** 立即落盘（结构性变更、回合边界、进程退出前） */
  public flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.dirty = false
    try {
      const dir = dirname(this.filePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8')
    } catch (err) {
      console.error('[onenat-workbuddy] Failed to save store:', err)
    }
  }

  /**
   * 流式正文增量落库：内存即时生效（SSE/列表读取立刻可见），磁盘写入尾随合并。
   * 返回 false 表示任务/轮次不存在（调用方无需关心）。
   */
  public appendTurnText(taskId: string, turnId: string, delta: string): boolean {
    const task = this.data.tasks.find((t) => t.id === taskId)
    const turn = task?.turns.find((t) => t.id === turnId)
    if (!task || !turn) return false
    turn.text = (turn.text || '') + delta
    task.updatedAt = Date.now()
    this.scheduleSave()
    return true
  }

  // ---- Settings ----

  public getSettings(): WorkBuddySettings {
    return JSON.parse(JSON.stringify(this.data.settings))
  }

  public updateSettings(patch: Partial<WorkBuddySettings>): WorkBuddySettings {
    if (patch.onenat) this.data.settings.onenat = { ...this.data.settings.onenat, ...patch.onenat }
    if (patch.planner) this.data.settings.planner = { ...this.data.settings.planner, ...patch.planner }
    if (patch.xiaozhi) this.data.settings.xiaozhi = { ...(this.data.settings.xiaozhi || {}), ...patch.xiaozhi }
    this.save()
    return this.getSettings()
  }

  // ---- SubAgents ----

  public getAgents(): SubAgent[] {
    return [...this.data.agents]
  }

  public getAgent(id: string): SubAgent | undefined {
    return this.data.agents.find((a) => a.id === id)
  }

  public mutateAgent(id: string, fn: (a: SubAgent) => void): void {
    const agent = this.data.agents.find((a) => a.id === id)
    if (!agent) return
    fn(agent)
    agent.updatedAt = Date.now()
    this.save()
  }

  public upsertAgent(input: Partial<SubAgent>): SubAgent {
    const now = Date.now()
    const existing = input.id ? this.data.agents.find((a) => a.id === input.id) : undefined
    const dshRef: DshRef = (input.dshRef as DshRef) || existing?.dshRef || { kind: 'direct', apiBaseUrl: '' }
    const resources: AgentResourceBinding[] = (input.resources as AgentResourceBinding[]) || existing?.resources || []
    // 防重复兜底：无 id 新建时，若已存在「同名 + 相同 DSH 实体」的智能体，则复用该条目（更新而非新增），
    // 避免前端重复提交（如双击保存）生成多条同其实体的记录。
    let target = existing
    if (!target) {
      target = this.data.agents.find((a) => a.name === String(input.name) && sameDshRef(a.dshRef, dshRef))
    }
    const agent: SubAgent = {
      id: target?.id || `agent-${Math.random().toString(36).slice(2, 10)}`,
      name: String(input.name ?? target?.name ?? '未命名子智能体'),
      dshRef,
      ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : target?.apiKey ? { apiKey: target.apiKey } : {}),
      agentPreset: input.agentPreset ?? target?.agentPreset,
      permission: input.permission ?? target?.permission,
      provider: input.provider ?? target?.provider,
      model: input.model ?? target?.model,
      reasoningEffort: input.reasoningEffort ?? target?.reasoningEffort,
      systemPrompt: input.systemPrompt ?? target?.systemPrompt,
      workDir: input.workDir !== undefined ? normalizeWorkDir(input.workDir) : target?.workDir,
      resources,
      skills: input.skills !== undefined ? input.skills : target?.skills,
      ...(input.tags !== undefined ? { tags: input.tags } : target?.tags ? { tags: target.tags } : {}),
      description: input.description ?? target?.description,
      enabled: input.enabled ?? target?.enabled ?? true,
      createdAt: target?.createdAt ?? now,
      updatedAt: now,
    }
    const idx = this.data.agents.findIndex((a) => a.id === agent.id)
    if (idx >= 0) this.data.agents[idx] = agent
    else this.data.agents.push(agent)
    this.save()
    return agent
  }

  public deleteAgent(id: string): boolean {
    const before = this.data.agents.length
    this.data.agents = this.data.agents.filter((a) => a.id !== id)
    // 同步从任务成员里摘除
    for (const t of this.data.tasks) {
      if (t.memberAgentIds.includes(id)) {
        t.memberAgentIds = t.memberAgentIds.filter((x) => x !== id)
      }
    }
    // 同步从定时任务目标里摘除
    for (const s of this.data.schedules) {
      if (s.agentIds.includes(id)) {
        s.agentIds = s.agentIds.filter((x) => x !== id)
      }
    }
    const changed = this.data.agents.length !== before
    if (changed) this.save()
    return changed
  }

  // ---- ScheduledTasks（定时任务） ----

  public getSchedules(): ScheduledTask[] {
    return [...this.data.schedules].sort((a, b) => b.createdAt - a.createdAt)
  }

  public getSchedule(id: string): ScheduledTask | undefined {
    return this.data.schedules.find((s) => s.id === id)
  }

  public upsertSchedule(input: Partial<ScheduledTask>): ScheduledTask {
    const now = Date.now()
    const existing = input.id ? this.data.schedules.find((s) => s.id === input.id) : undefined
    const schedule: ScheduledTask = {
      id: existing?.id || `sched-${Math.random().toString(36).slice(2, 10)}`,
      name: String(input.name ?? existing?.name ?? '未命名定时任务'),
      description: input.description ?? existing?.description,
      agentIds: [...(input.agentIds ?? existing?.agentIds ?? [])],
      message: String(input.message ?? existing?.message ?? ''),
      rule: (input.rule as ScheduledTask['rule']) || existing?.rule || { kind: 'daily', times: ['09:00'] },
      enabled: input.enabled ?? existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastRunAt: input.lastRunAt ?? existing?.lastRunAt,
      nextRunAt: input.nextRunAt ?? existing?.nextRunAt,
      runs: input.runs ?? existing?.runs ?? [],
      totalRuns: input.totalRuns ?? existing?.totalRuns,
      successRuns: input.successRuns ?? existing?.successRuns,
    }
    const idx = this.data.schedules.findIndex((s) => s.id === schedule.id)
    if (idx >= 0) this.data.schedules[idx] = schedule
    else this.data.schedules.push(schedule)
    this.save()
    return schedule
  }

  public deleteSchedule(id: string): boolean {
    const before = this.data.schedules.length
    this.data.schedules = this.data.schedules.filter((s) => s.id !== id)
    const changed = this.data.schedules.length !== before
    if (changed) this.save()
    return changed
  }

  public mutateSchedule<T>(id: string, fn: (s: ScheduledTask) => T): T | undefined {
    const schedule = this.data.schedules.find((s) => s.id === id)
    if (!schedule) return undefined
    const out = fn(schedule)
    schedule.updatedAt = Date.now()
    this.save()
    return out
  }

  // ---- Tasks ----

  public getTasks(): WorkTask[] {
    return [...this.data.tasks].sort((a, b) => b.createdAt - a.createdAt)
  }

  public getTask(id: string): WorkTask | undefined {
    return this.data.tasks.find((t) => t.id === id)
  }

  public upsertTask(task: WorkTask): WorkTask {
    task.updatedAt = Date.now()
    const idx = this.data.tasks.findIndex((t) => t.id === task.id)
    if (idx >= 0) this.data.tasks[idx] = task
    else this.data.tasks.unshift(task)
    this.save()
    return task
  }

  public deleteTask(id: string): boolean {
    const before = this.data.tasks.length
    this.data.tasks = this.data.tasks.filter((t) => t.id !== id)
    const changed = this.data.tasks.length !== before
    if (changed) this.save()
    return changed
  }

  public mutateTask<T>(id: string, fn: (task: WorkTask) => T): T | undefined {
    const task = this.data.tasks.find((t) => t.id === id)
    if (!task) return undefined
    const out = fn(task)
    task.updatedAt = Date.now()
    this.save()
    return out
  }

  public appendTurn(taskId: string, turn: TaskTurn): TaskTurn | undefined {
    return this.mutateTask(taskId, (task) => {
      turn.seq = task.turns.length + 1
      task.turns.push(turn)
      return turn
    })
  }

  public updateTurn(taskId: string, turnId: string, fn: (turn: TaskTurn) => void): TaskTurn | undefined {
    return this.mutateTask(taskId, (task) => {
      const turn = task.turns.find((t) => t.id === turnId)
      if (turn) fn(turn)
      return turn
    })
  }

  public mutateSubtask(taskId: string, subtaskId: string, fn: (s: PlanSubtask) => void): PlanSubtask | undefined {
    return this.mutateTask(taskId, (task) => {
      const sub = task.plan?.subtasks.find((s) => s.id === subtaskId)
      if (sub) fn(sub)
      return sub
    })
  }
}

/** 工作目录规范化：去空白与尾斜杠；空值 → undefined */
function normalizeWorkDir(v: unknown): string | undefined {
  const s = String(v ?? '').trim().replace(/\/+$/, '')
  return s || undefined
}
