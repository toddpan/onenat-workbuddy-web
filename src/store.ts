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
      apiKey: 'onk-REDACTED-rotate-this-key',
      autoRefreshMs: 60_000,
    },
    planner: {},
  }
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

  public upsertAgent(input: Partial<SubAgent>): SubAgent {
    const now = Date.now()
    const existing = input.id ? this.data.agents.find((a) => a.id === input.id) : undefined
    const dshRef: DshRef = (input.dshRef as DshRef) || existing?.dshRef || { kind: 'direct', apiBaseUrl: '' }
    const resources: AgentResourceBinding[] = (input.resources as AgentResourceBinding[]) || existing?.resources || []
    const agent: SubAgent = {
      id: existing?.id || `agent-${Math.random().toString(36).slice(2, 10)}`,
      name: String(input.name ?? existing?.name ?? '未命名子智能体'),
      dshRef,
      ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : existing?.apiKey ? { apiKey: existing.apiKey } : {}),
      agentPreset: input.agentPreset ?? existing?.agentPreset,
      permission: input.permission ?? existing?.permission,
      provider: input.provider ?? existing?.provider,
      model: input.model ?? existing?.model,
      reasoningEffort: input.reasoningEffort ?? existing?.reasoningEffort,
      systemPrompt: input.systemPrompt ?? existing?.systemPrompt,
      workDir: input.workDir !== undefined ? normalizeWorkDir(input.workDir) : existing?.workDir,
      resources,
      ...(input.tags !== undefined ? { tags: input.tags } : existing?.tags ? { tags: existing.tags } : {}),
      description: input.description ?? existing?.description,
      enabled: input.enabled ?? existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? now,
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
