/**
 * onenat-workbuddy-web - WorkStore: 子智能体池 + 任务会话 + 设置 持久化
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { writeFile as fspWriteFile, rename as fspRename, mkdir as fspMkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { AgentResourceBinding, DshRef, ExpertTeam, Project, StorageData, SubAgent, WorkBuddySettings, WorkTask, PlanSubtask, TaskTurn, ScheduledTask, TeamTemplateId } from './types.js'
import { BUILTIN_TEAMS } from './expert-teams.js'

function defaultSettings(): WorkBuddySettings {
  return {
    onenat: {
      baseUrl: 'https://onenat.sooncore.com',
      apiKey: '', // 凭证不入库默认值：首次启动后在设置页填写，或经环境注入
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
  /**
   * 尾随合并落盘窗口：流式增量期间避免每个 delta 都触发落盘。
   * 3s：线上实测 15.7MB store 单次快照 ~110ms，250ms 间隔会把事件循环打到 ~50% 冻结占空比
   * （登录等无关请求全部排队），放宽到 3s 后占空比 ~4%；代价是崩溃最多丢 3s 流式文本。
   */
  private static readonly TRAILING_SAVE_MS = 3_000
  private saveTimer: NodeJS.Timeout | null = null
  private dirty = false
  /** 每次数据变更信号（save/scheduleSave）递增：用于判断快照后是否又有新变更 */
  private dirtyGen = 0
  /** 异步落盘单飞状态 */
  private writing = false
  private rerunNeeded = false
  /** 同步 flush 递增：使仍在途的异步写放弃 rename，防止旧快照覆盖更新的落盘 */
  private writeEpoch = 0
  /** 冷数据归档：终态任务超过该时长后，turns/taskLogs 的磁盘主体移入 data/archive/，store.json 只留骨架 */
  private static readonly ARCHIVE_AFTER_MS = (Number(process.env.WORKBUDDY_ARCHIVE_DAYS) || 7) * 86_400_000
  private static readonly ARCHIVE_SWEEP_MS = 30 * 60_000
  private static readonly TERMINAL_STATUS = new Set(['completed', 'failed', 'partial_success', 'success', 'cancelled'])
  private sweeping = false

  constructor(customPath?: string) {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    this.filePath = customPath || join(dshHome, 'onenat-workbuddy', 'store.json')
    this.data = { agents: [], tasks: [], schedules: [], projects: [], teams: [], settings: { ...defaultSettings(), xiaozhi: {} } }
    this.load()
    // 进程退出前把未落盘变更同步写盘（SIGKILL 除外）：覆盖尾随窗口内与仍在途的异步写。
    // 只挂 'exit'：SIGINT/SIGTERM 走默认终止路径同样会触发 exit，且不会劫持 Ctrl-C 语义。
    process.once('exit', () => { if (this.dirty) this.flush() })
    // 冷数据归档扫描：启动后延迟一轮 + 周期扫描（不阻止进程退出）
    const bootDelay = Number(process.env.WORKBUDDY_ARCHIVE_BOOT_DELAY_MS)
    const bootSweep = setTimeout(() => { void this.archiveSweep() }, Number.isFinite(bootDelay) && bootDelay >= 0 ? bootDelay : 30_000)
    bootSweep.unref?.()
    const sweepTimer = setInterval(() => { void this.archiveSweep() }, WorkStore.ARCHIVE_SWEEP_MS)
    sweepTimer.unref?.()
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
          projects: Array.isArray(parsed.projects) ? parsed.projects : [],
          teams: Array.isArray(parsed.teams) ? parsed.teams : [],
          settings: {
            onenat: { ...defaultSettings().onenat, ...(parsed.settings?.onenat || {}) },
            planner: { ...defaultSettings().planner, ...(parsed.settings?.planner || {}) },
            xiaozhi: { endpoints },
          },
        }
      }
      this.rehydrateArchived()
      this.save()
    } catch {
      // 容错回退
    }
  }

  /** 启动重水合：bulkArchived 标记且磁盘为骨架的任务，从 data/archive/<id>.json 取回 turns/taskLogs（内存恢复全量，标记保留） */
  private rehydrateArchived(): void {
    for (const t of this.data.tasks) {
      if (!t.bulkArchived) continue
      if ((t.turns?.length || 0) > 0 || (t.taskLogs?.length || 0) > 0) continue // 磁盘为全量（归档写成功但 store 未及保存的崩溃窗口）：直接用
      try {
        const raw = JSON.parse(readFileSync(this.archivePath(t.id), 'utf-8'))
        if (raw?.id !== t.id) throw new Error(`归档 id 不匹配: ${raw?.id}`)
        t.turns = Array.isArray(raw.turns) ? raw.turns : []
        t.taskLogs = Array.isArray(raw.taskLogs) ? raw.taskLogs : []
      } catch (err) {
        console.warn(`[onenat-workbuddy] 任务 ${t.id} 归档文件读取失败，保留磁盘骨架:`, err instanceof Error ? err.message : err)
      }
    }
  }

  /** 归档文件路径（id 形如 task-xxxxxxxx，白名单校验防路径注入） */
  private archivePath(taskId: string): string {
    if (!/^task-[A-Za-z0-9_-]+$/.test(taskId)) throw new Error(`非法任务 id: ${taskId}`)
    return join(dirname(this.filePath), 'archive', `${taskId}.json`)
  }

  /**
   * 冷数据归档扫描：终态 + 超过 ARCHIVE_AFTER_MS 未更新的任务，把 turns/taskLogs 写入
   * data/archive/<id>.json 后打 bulkArchived 标记（磁盘骨架化）。顺序保证崩溃安全：
   * 先写归档文件成功、再标记+save——中途崩溃只会留下一个将被下轮覆盖的孤儿归档文件，
   * 不会丢数据。内存始终持全量（读路径零改动），任何 mutation 走 touchTask 解除归档。
   * 返回本轮归档的任务数。
   */
  public async archiveSweep(): Promise<number> {
    if (this.sweeping) return 0
    this.sweeping = true
    try {
      const cutoff = Date.now() - WorkStore.ARCHIVE_AFTER_MS
      let archived = 0
      for (const t of this.data.tasks) {
        if (t.bulkArchived) continue
        if (!WorkStore.TERMINAL_STATUS.has(t.status)) continue
        if ((t.updatedAt || 0) > cutoff) continue
        const turns = t.turns || []
        const logs = t.taskLogs || []
        if (!turns.length && !logs.length) continue
        try {
          const dir = join(dirname(this.filePath), 'archive')
          await fspMkdir(dir, { recursive: true })
          const target = this.archivePath(t.id)
          const tmp = target + '.tmp'
          await fspWriteFile(tmp, JSON.stringify({ id: t.id, archivedAt: Date.now(), turns, taskLogs: logs }), 'utf-8')
          await fspRename(tmp, target)
          t.bulkArchived = { at: Date.now(), turns: turns.length, logs: logs.length }
          archived++
        } catch (err) {
          console.error(`[onenat-workbuddy] 任务 ${t.id} 归档失败（下轮重试）:`, err instanceof Error ? err.message : err)
        }
      }
      if (archived) {
        console.log(`[onenat-workbuddy] 冷归档：${archived} 个任务的 turns/taskLogs 已移入 data/archive/`)
        this.save()
      }
      return archived
    } finally {
      this.sweeping = false
    }
  }

  /** 归档任务一旦被修改即恢复为常驻全量（磁盘随后恢复完整落盘，冷归档由下轮扫描重新接管） */
  private touchTask(t: WorkTask | undefined): void {
    if (t?.bulkArchived) delete t.bulkArchived
  }

  /**
   * 常规落盘入口：异步单飞写（主线程只付 JSON.stringify 快照成本，写盘走线程池）。
   * 结构性变更（增删任务/智能体/成员等）与流式尾随都汇入这里。
   */
  public save(): void {
    this.dirtyGen++
    this.flushAsync()
  }

  /**
   * 高频写入合并（流式增量专用）。
   *
   * 背景：每个 delta 都会走 mutateTask → save()，而落盘是全量
   * `JSON.stringify(data) + 写盘`。1.5MB 级 store 单次 ~3.5ms 尚可全同步；
   * 线上 15.7MB 后单次 ~300ms 且**同步阻塞事件循环**：250ms 尾随间隔意味着
   * 长回合期间事件循环约一半时间处于冻结，登录等无关请求全部排队
   * （2026-10-16 线上实测，详见 healthz 探针数据）。
   *
   * 因此流式增量只改内存（内存态始终权威），磁盘写入按 TRAILING_SAVE_MS 尾随合并；
   * 结构性变更（增删任务/智能体/成员等）仍走 save() 立即触发异步落盘。
   */
  public scheduleSave(): void {
    this.dirtyGen++
    this.dirty = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      if (this.dirty) this.flushAsync()
    }, WorkStore.TRAILING_SAVE_MS)
    // 常驻定时器不阻止进程退出（standalone server 由 http server 保持存活）
    this.saveTimer.unref?.()
  }

  /**
   * 异步落盘（单飞合并）：主线程只做一次 JSON.stringify 快照（13MB 级 ~110ms），
   * 写盘走 fs.promises 线程池，不阻塞事件循环；写临时文件后 rename 原子替换，
   * 写盘中途崩溃/断电不会留下截断的 store.json（旧版直接 writeFileSync 会）。
   * 写盘期间再次调用只置重跑标记，完成后补写最新快照，串行不堆积。
   */
  public flushAsync(): void {
    this.dirty = true
    if (this.writing) {
      this.rerunNeeded = true
      return
    }
    this.writing = true
    void this.doWrite()
  }

  private async doWrite(): Promise<void> {
    try {
      const dir = dirname(this.filePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const json = JSON.stringify(this.serializeForDisk(), null, 2)
      const atSnapshot = this.dirtyGen
      const epoch = this.writeEpoch
      const tmp = this.filePath + '.tmp'
      await fspWriteFile(tmp, json, 'utf-8')
      if (epoch !== this.writeEpoch) return // 期间发生过同步 flush（如进程退出），放弃旧快照防止回写覆盖
      await fspRename(tmp, this.filePath)
      if (atSnapshot >= this.dirtyGen) this.dirty = false // 快照后无新变更才清脏；有则留给下一轮补写
    } catch (err) {
      console.error('[onenat-workbuddy] Failed to save store (async):', err)
    } finally {
      this.writing = false
      if (this.rerunNeeded) {
        this.rerunNeeded = false
        this.flushAsync()
      }
    }
  }

  /** 磁盘序列化视图：bulkArchived 任务只落骨架（turns/taskLogs 主体在 data/archive/），内存与其它任务原样共享 */
  private serializeForDisk(): StorageData {
    if (!this.data.tasks.some((t) => t.bulkArchived)) return this.data
    return { ...this.data, tasks: this.data.tasks.map((t) => (t.bulkArchived ? { ...t, turns: [], taskLogs: [] } : t)) }
  }

  /** 同步立即落盘（进程退出前兜底用；常规路径一律走 flushAsync） */
  public flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.writeEpoch++
    this.dirty = false
    try {
      const dir = dirname(this.filePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const tmp = this.filePath + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.serializeForDisk(), null, 2), 'utf-8')
      renameSync(tmp, this.filePath)
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
    this.touchTask(task)
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
      role: input.role !== undefined ? String(input.role).trim() || undefined : target?.role,
      executionPrompt: input.executionPrompt !== undefined ? String(input.executionPrompt).trim() || undefined : target?.executionPrompt,
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
    // 同步从专家团成员里摘除（成员不足 2 人时团队保留但不可用，需编辑补齐）
    for (const team of this.data.teams) {
      if (team.members.some((m) => m.agentId === id)) {
        team.members = team.members.filter((m) => m.agentId !== id)
        team.updatedAt = Date.now()
      }
    }
    const changed = this.data.agents.length !== before
    if (changed) this.save()
    return changed
  }

  // ---- ExpertTeams（专家团） ----

  /**
   * 全部团队 = 内置种子团（只读，随版本提供）+ 自定义团。
   * 内置团不落库：升级自动跟随代码种子；同名自定义团被 parseTeamInput 拒绝，不会产生歧义。
   */
  public getTeams(): ExpertTeam[] {
    const custom = [...this.data.teams].sort((a, b) => b.createdAt - a.createdAt)
    const builtinIds = new Set(BUILTIN_TEAMS.map((t) => t.id))
    return [...BUILTIN_TEAMS, ...custom.filter((t) => !builtinIds.has(t.id))]
  }

  public getTeam(id: string): ExpertTeam | undefined {
    return BUILTIN_TEAMS.find((t) => t.id === id) ?? this.data.teams.find((t) => t.id === id)
  }

  /** 无校验落库（校验在 router 的 parseTeamInput）；成员引用的子智能体由调用方保证存在；内置团 id 只读 */
  public upsertTeam(input: Partial<ExpertTeam>): ExpertTeam {
    if (input.id && BUILTIN_TEAMS.some((t) => t.id === input.id)) {
      throw new Error('内置专家团只读，请复制为自定义团队后修改。')
    }
    const now = Date.now()
    const existing = input.id ? this.data.teams.find((t) => t.id === input.id) : undefined
    const team: ExpertTeam = {
      id: existing?.id || `team-${Math.random().toString(36).slice(2, 10)}`,
      name: String(input.name ?? existing?.name ?? '未命名专家团'),
      description: input.description !== undefined ? (String(input.description).trim() || undefined) : existing?.description,
      goal: String(input.goal ?? existing?.goal ?? ''),
      constraints: input.constraints !== undefined ? (String(input.constraints).trim() || undefined) : existing?.constraints,
      deliveryRequirements: input.deliveryRequirements !== undefined ? (String(input.deliveryRequirements).trim() || undefined) : existing?.deliveryRequirements,
      members: (input.members as ExpertTeam['members']) || existing?.members || [],
      coordinatorPrompt: input.coordinatorPrompt !== undefined ? (String(input.coordinatorPrompt).trim() || undefined) : existing?.coordinatorPrompt,
      templateId: (input.templateId as TeamTemplateId | undefined) ?? existing?.templateId,
      enabled: input.enabled ?? existing?.enabled ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    const idx = this.data.teams.findIndex((t) => t.id === team.id)
    if (idx >= 0) this.data.teams[idx] = team
    else this.data.teams.push(team)
    this.save()
    return team
  }

  public deleteTeam(id: string): boolean {
    if (BUILTIN_TEAMS.some((t) => t.id === id)) return false
    const before = this.data.teams.length
    this.data.teams = this.data.teams.filter((t) => t.id !== id)
    // 关联任务只摘除 teamId 标记（历史任务与产出保留）
    for (const t of this.data.tasks) {
      if (t.teamId === id) delete t.teamId
    }
    const changed = this.data.teams.length !== before
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
      nodeMappingId: input.nodeMappingId !== undefined ? (input.nodeMappingId || undefined) : existing?.nodeMappingId,
      model: input.model !== undefined ? (input.model || undefined) : existing?.model,
      workDir: input.workDir !== undefined ? (input.workDir || undefined) : existing?.workDir,
      skills: input.skills !== undefined ? [...(input.skills || [])] : existing?.skills,
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

  /**
   * 映射漂移重绑：natpass 重注册后 mappingId 会变（服务没换、身份换了），按 from→to
   * 改写所有存量引用 —— 子智能体绑定节点（dshRef）、任务节点（nodeRef）、定时任务节点
   * （nodeMappingId）。返回改写的引用条数（0 = 没有需要重绑的引用）。
   */
  public rebindMappingRefs(pairs: Array<{ from: string; to: string }>): number {
    if (!pairs?.length) return 0
    // from===to 是无效迁移（检测缺陷的兜底防线）：过滤掉，绝不空转改写存盘
    const map = new Map(pairs.filter((p) => p.from !== p.to).map((p) => [p.from, p.to]))
    if (!map.size) return 0
    let changed = 0
    for (const a of this.data.agents) {
      if (a.dshRef?.kind === 'mapping' && map.has(a.dshRef.mappingId)) {
        const to = map.get(a.dshRef.mappingId)!
        this.mutateAgent(a.id, (x) => {
          if (x.dshRef?.kind === 'mapping') x.dshRef.mappingId = to
        })
        changed++
      }
    }
    for (const t of this.data.tasks) {
      if (t.nodeRef?.kind === 'mapping' && map.has(t.nodeRef.mappingId)) {
        const to = map.get(t.nodeRef.mappingId)!
        this.mutateTask(t.id, (x) => {
          if (x.nodeRef?.kind === 'mapping') x.nodeRef.mappingId = to
        })
        changed++
      }
    }
    for (const s of this.data.schedules) {
      if (s.nodeMappingId && map.has(s.nodeMappingId)) {
        this.mutateSchedule(s.id, (x) => {
          x.nodeMappingId = map.get(x.nodeMappingId!)
        })
        changed++
      }
    }
    return changed
  }

  // ---- Tasks ----

  public getTasks(): WorkTask[] {
    return [...this.data.tasks].sort((a, b) => b.createdAt - a.createdAt)
  }

  public getTask(id: string): WorkTask | undefined {
    return this.data.tasks.find((t) => t.id === id)
  }

  public upsertTask(task: WorkTask): WorkTask {
    this.touchTask(task)
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
    if (changed) {
      try {
        if (existsSync(this.archivePath(id))) unlinkSync(this.archivePath(id))
      } catch {
        /* 归档文件清理失败不影响删除 */
      }
      this.save()
    }
    return changed
  }

  // ---- Projects ----

  public getProjects(): Project[] {
    return [...this.data.projects].sort((a, b) => b.createdAt - a.createdAt)
  }

  public getProject(id: string): Project | undefined {
    return this.data.projects.find((p) => p.id === id)
  }

  public upsertProject(input: Partial<Project>): Project {
    const now = Date.now()
    const existing = input.id ? this.data.projects.find((p) => p.id === input.id) : undefined
    const project: Project = {
      id: existing?.id || `proj-${Math.random().toString(36).slice(2, 10)}`,
      name: String(input.name ?? existing?.name ?? '未命名项目'),
      dshRef: (input.dshRef as Project['dshRef']) || existing?.dshRef || { kind: 'direct', apiBaseUrl: '' },
      apiKey: input.apiKey !== undefined ? input.apiKey : existing?.apiKey,
      workspace: input.workspace !== undefined ? (String(input.workspace).trim() || undefined) : existing?.workspace,
      instruction: input.instruction !== undefined ? (String(input.instruction).trim() || undefined) : existing?.instruction,
      expertIds: input.expertIds ? [...new Set(input.expertIds.map(String))] : existing?.expertIds || [],
      connectorIds: input.connectorIds ? [...new Set(input.connectorIds.map(String))] : existing?.connectorIds || [],
      skillNames: input.skillNames ? [...new Set(input.skillNames.map(String))] : existing?.skillNames || [],
      owner: input.owner !== undefined ? input.owner : existing?.owner,
      projectMembers: input.projectMembers !== undefined ? input.projectMembers : existing?.projectMembers,
      visibility: input.visibility !== undefined ? input.visibility : existing?.visibility,
      importedFrom: input.importedFrom ?? existing?.importedFrom,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    const idx = this.data.projects.findIndex((p) => p.id === project.id)
    if (idx >= 0) this.data.projects[idx] = project
    else this.data.projects.push(project)
    this.save()
    return project
  }

  public deleteProject(id: string): boolean {
    const before = this.data.projects.length
    this.data.projects = this.data.projects.filter((p) => p.id !== id)
    const changed = this.data.projects.length !== before
    if (changed) this.save()
    return changed
  }

  public mutateTask<T>(id: string, fn: (task: WorkTask) => T): T | undefined {
    const task = this.data.tasks.find((t) => t.id === id)
    if (!task) return undefined
    this.touchTask(task)
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
