/**
 * onenat-workbuddy-web - 用户自建专家存储（UserExpertStore）
 *
 * ExpertRegistry 的 JSON 资产层（assets/experts）是只读的生成产物（roster + builtin 模板）。
 * 本模块为「用户创建的专家」提供持久化层：单个 JSON 文件（<dataDir>/user-experts.json），
 * 与资产层合并后形成统一的专家视图（合并逻辑见 ExpertRegistry.attachUserStore）。
 *
 * 权限边界：builtin / roster 专家只读；只有 source === 'user' 的专家可编辑与删除。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Expert, ExpertProfile } from './expert-registry.js'

/** 用户专家 id 白名单（与资产层一致的小写 slug，防路径穿越）。 */
const EXPERT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 用户专家默认分区。 */
export const USER_DIVISION = 'user'
export const USER_DIVISION_ZH = '用户创建'

export type UserExpertInput = Partial<Omit<ExpertProfile, 'id' | 'source'>> & { id: string }

export class UserExpertStore {
  private filePath: string
  /** id → 完整档案；首访惰性加载。 */
  private cache?: Map<string, ExpertProfile>

  constructor(dataDir: string, fileName = 'user-experts.json') {
    this.filePath = join(dataDir, fileName)
  }

  private load(): Map<string, ExpertProfile> {
    if (this.cache) return this.cache
    const out = new Map<string, ExpertProfile>()
    try {
      if (existsSync(this.filePath)) {
        const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as ExpertProfile[]
        if (Array.isArray(parsed)) {
          for (const p of parsed) {
            if (p && typeof p.id === 'string' && EXPERT_ID.test(p.id) && typeof p.systemPrompt === 'string') {
              out.set(p.id, { ...p, source: 'user' })
            }
          }
        }
      }
    } catch {
      // 文件损坏时降级为空库（与 ExpertRegistry 的容错语义一致）
    }
    this.cache = out
    return out
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify([...this.load().values()], null, 2), 'utf8')
    } catch (err) {
      console.error('[onenat-workbuddy] Failed to save user experts:', err)
    }
  }

  list(): Expert[] {
    return [...this.load().values()].map(({ systemPrompt: _sp, executionPrompt: _ep, role: _r, locales: _l, ...meta }) => meta as Expert)
  }

  get(id: string): ExpertProfile | undefined {
    return this.load().get(id)
  }

  /** 创建或整体更新一位用户专家；返回保存后的完整档案。 */
  upsert(input: UserExpertInput): ExpertProfile {
    const id = String(input.id).trim()
    if (!EXPERT_ID.test(id)) throw new Error('专家 id 必须是小写字母/数字的中划线 slug（如 my-reviewer）。')
    const existing = this.load().get(id)
    const profile: ExpertProfile = {
      ...existing,
      ...input,
      id,
      source: 'user',
      division: String(input.division || existing?.division || USER_DIVISION).trim() || USER_DIVISION,
      divisionZh: String(input.divisionZh || existing?.divisionZh || USER_DIVISION_ZH).trim() || USER_DIVISION_ZH,
      icon: String(input.icon || existing?.icon || '🧩').trim() || '🧩',
      name: String(input.name || existing?.name || id).trim() || id,
      description: String(input.description ?? existing?.description ?? '').trim(),
      systemPrompt: String(input.systemPrompt ?? existing?.systemPrompt ?? ''),
    }
    if (!profile.nameEn && existing?.nameEn) profile.nameEn = existing.nameEn
    if (!profile.descriptionEn && existing?.descriptionEn) profile.descriptionEn = existing.descriptionEn
    if (!profile.systemPrompt.trim()) throw new Error('systemPrompt 不能为空。')
    this.load().set(id, profile)
    this.save()
    return profile
  }

  /** 删除用户专家；builtin/roster 或不存在返回 false（调用方负责区分 404/403）。 */
  delete(id: string): boolean {
    const map = this.load()
    if (!map.has(id)) return false
    map.delete(id)
    this.save()
    return true
  }
}
