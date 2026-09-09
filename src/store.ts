/**
 * @dsh-external/onenat-workbuddy - WorkStore: 子智能体池 + 任务会话 + 设置 持久化
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { AgentResourceBinding, DshRef, StorageData, SubAgent, WorkBuddySettings, WorkTask, PlanSubtask, TaskTurn } from './types.js'

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

  constructor(customPath?: string) {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    this.filePath = customPath || join(dshHome, 'onenat-workbuddy', 'store.json')
    this.data = { agents: [], tasks: [], settings: defaultSettings() }
    this.load()
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8'))
        this.data = {
          agents: Array.isArray(parsed.agents) ? parsed.agents : [],
          tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
          settings: {
            onenat: { ...defaultSettings().onenat, ...(parsed.settings?.onenat || {}) },
            planner: { ...defaultSettings().planner, ...(parsed.settings?.planner || {}) },
          },
        }
      }
      this.save()
    } catch {
      // 容错回退
    }
  }

  public save(): void {
    try {
      const dir = dirname(this.filePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8')
    } catch (err) {
      console.error('[onenat-workbuddy] Failed to save store:', err)
    }
  }

  // ---- Settings ----

  public getSettings(): WorkBuddySettings {
    return JSON.parse(JSON.stringify(this.data.settings))
  }

  public updateSettings(patch: Partial<WorkBuddySettings>): WorkBuddySettings {
    if (patch.onenat) this.data.settings.onenat = { ...this.data.settings.onenat, ...patch.onenat }
    if (patch.planner) this.data.settings.planner = { ...this.data.settings.planner, ...patch.planner }
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
    const changed = this.data.agents.length !== before
    if (changed) this.save()
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
