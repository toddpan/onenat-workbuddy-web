/**
 * onenat-workbuddy-web - 统一专家注册表（ExpertRegistry，Phase 2）
 *
 * 合并原 src/expert-roster.ts（321 位 The Agency 预制人格库）与 src/expert-templates.ts
 * （7 个内置质量门禁角色模板）的数据模型，数据源从 MD frontmatter 迁移到 JSON：
 *   assets/experts/index.json       —— 全量元数据索引（小，常驻内存缓存）
 *   assets/experts/profiles/<id>.json —— 完整档案（惰性按需读取，进程内缓存）
 * 资产由 scripts/build-expert-assets.mjs 生成；授权边界见 assets/experts/NOTICE。
 *
 * 两层数据：Expert（索引元数据，全量常驻）与 ExpertProfile（完整提示词，惰性加载），
 * 对应原 roster「分块读头部 + 按需读正文」的性能语义。资产缺失时降级为空注册表而非报错。
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { SubAgent } from './types.js'

/** 外部资产根目录环境变量（结构需与 assets/experts 一致）。 */
const ROOT_ENV = 'WORKBUDDY_EXPERT_ROOT'

/** 专家 id（文件名去 .json）白名单模式，拼接路径前校验，拒绝路径穿越。 */
const EXPERT_PATH_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 列表接口的简介截断长度（生成期已截断，运行时仅兜底）。 */
export const LIST_DESCRIPTION_LIMIT = 120

/** 内置角色分区（EXPERT_TEMPLATES 迁移后的归属分区）。 */
export const BUILTIN_DIVISION = 'team'

/* ---------- 数据模型 ---------- */

/** 统一专家实体：roster 专家与内置角色模板收敛为同一形状。 */
export interface Expert {
  /** 稳定标识：roster 用原 slug；内置角色保留原 id（如 expert-reviewer） */
  id: string
  /** 来源，便于迁移期排查与回退 */
  source: 'roster' | 'builtin'
  /** 归属分区；内置角色用 'team' 分区 */
  division: string
  /** 分区展示名（生成期固化进数据） */
  divisionZh: string
  /** 图标：统一叫 icon（兼容原 emoji/icon 两种命名） */
  icon: string
  /** 展示名（zh 优先） */
  name: string
  nameEn?: string
  /** 简介（zh 优先）；索引内已按 LIST_DESCRIPTION_LIMIT 截断 */
  description: string
  descriptionEn?: string
  /** 标签，用于筛选（可选） */
  tags?: string[]
}

/** 专家完整档案：惰性加载 assets/experts/profiles/<id>.json。 */
export interface ExpertProfile extends Expert {
  /** 职责与约束（对应原 systemPrompt / roster persona 正文） */
  systemPrompt: string
  /** 执行指导：角色专属工作方法与产出结构（可缺省） */
  executionPrompt?: string
  /** builtin 模板的正式角色名（写入 SubAgent.role）；roster 专家缺省 */
  role?: string
  /** 双语完整提示词（顶层字段 = zh 优先默认值） */
  locales?: { [locale: string]: { systemPrompt?: string; executionPrompt?: string } }
}

export interface ExpertDivision {
  division: string
  divisionZh: string
  count: number
  /** 列表输出中 description 截断 */
  experts: Expert[]
}

export interface ExpertIndex {
  /** 资产缺失时降级为空注册表而非报错（保留原语义） */
  available: boolean
  total: number
  divisions: ExpertDivision[]
}

interface IndexFile {
  version: number
  experts: Expert[]
}

/* ---------- 资产根目录解析（沿用原 roster 语义） ---------- */

/** 解析资产根目录：显式参数 > 环境变量 > 就近向上找 package.json 同级的 assets/experts。 */
export function resolveRegistryRoot(explicit?: string): string {
  if (explicit && explicit.trim() !== '') return explicit
  const fromEnv = process.env[ROOT_ENV]?.trim()
  if (fromEnv) return fromEnv
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = join(dir, 'assets', 'experts')
    if (existsSync(join(candidate, 'index.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) return candidate
    dir = parent
  }
}

function truncate(text: string, limit: number): string {
  const codePoints = Array.from(text)
  return codePoints.length <= limit ? text : `${codePoints.slice(0, limit).join('')}…`
}

/**
 * 统一专家注册表。index.json 首次访问加载并进程内缓存；profiles/<id>.json 惰性读取并缓存。
 * 排序与原 roster 保持一致：分区名、专家 id 均 localeCompare 升序。
 */
export class ExpertRegistry {
  private root: string
  private indexPromise?: Promise<Expert[]>

  constructor(root?: string) {
    this.root = resolveRegistryRoot(root)
  }

  /** 首次访问加载 index.json，进程内缓存；文件缺失/损坏时降级为空注册表。 */
  private experts(): Promise<Expert[]> {
    this.indexPromise ??= (async () => {
      try {
        const raw = JSON.parse(await readFile(join(this.root, 'index.json'), 'utf8')) as IndexFile
        if (!Array.isArray(raw?.experts)) return []
        // index.json 生成期已按（分区, id）排序，且 builtin 模板保持声明顺序追加在 team 分区；
        // 运行时仅按分区做稳定排序，不重排分区内顺序（保留 builtin 原始声明顺序）。
        return raw.experts
          .filter((e) => e && typeof e.id === 'string' && EXPERT_PATH_SEGMENT.test(e.id))
          .map((e) => ({ ...e, description: truncate(e.description ?? '', LIST_DESCRIPTION_LIMIT) }))
          .sort((a, b) => a.division.localeCompare(b.division))
      } catch {
        return []
      }
    })()
    return this.indexPromise
  }

  /** 全量索引：按分区分组（运行时分组，数据层保持单层扁平列表）。 */
  async index(): Promise<ExpertIndex> {
    if (!existsSync(join(this.root, 'index.json'))) return { available: false, total: 0, divisions: [] }
    const experts = await this.experts()
    const byDivision = new Map<string, Expert[]>()
    for (const expert of experts) {
      const list = byDivision.get(expert.division) ?? []
      list.push(expert)
      byDivision.set(expert.division, list)
    }
    const divisions = [...byDivision.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([division, list]) => ({
        division,
        divisionZh: list[0]?.divisionZh ?? division,
        count: list.length,
        experts: list.map((e) => ({ ...e, description: truncate(e.description, LIST_DESCRIPTION_LIMIT) })),
      }))
    return { available: true, total: experts.length, divisions }
  }

  /** 精确取一位专家的元数据。 */
  async get(id: string): Promise<Expert | undefined> {
    if (!EXPERT_PATH_SEGMENT.test(id)) return undefined
    return (await this.experts()).find((e) => e.id === id)
  }

  /** 惰性加载完整档案：读 assets/experts/profiles/<id>.json（进程内缓存）。 */
  async getProfile(id: string): Promise<ExpertProfile> {
    if (!EXPERT_PATH_SEGMENT.test(id)) throw new Error('无效的专家标识。')
    const expert = await this.get(id)
    if (expert === undefined) throw new Error('注册表中不存在该专家。')
    const raw = await readFile(join(this.root, 'profiles', `${id}.json`), 'utf8').catch(() => undefined)
    if (raw === undefined) throw new Error('专家档案文件缺失或格式无效。')
    let profile: ExpertProfile
    try {
      profile = JSON.parse(raw) as ExpertProfile
    } catch {
      throw new Error('专家档案文件缺失或格式无效。')
    }
    if (typeof profile?.systemPrompt !== 'string' || profile.systemPrompt.trim() === '') {
      throw new Error('专家档案文件缺失或格式无效。')
    }
    // 顶层字段 = zh 优先默认值；缺失译文时回落 locales 中的英文原文（对齐原 en/zh 双目录回退语义）
    if (profile.systemPrompt.trim() === '' && profile.locales?.en?.systemPrompt) {
      profile.systemPrompt = profile.locales.en.systemPrompt
    }
    if (!profile.executionPrompt && profile.locales?.en?.executionPrompt) {
      profile.executionPrompt = profile.locales.en.executionPrompt
    }
    return { ...expert, systemPrompt: profile.systemPrompt, executionPrompt: profile.executionPrompt, role: profile.role, locales: profile.locales }
  }

  /** 按分区筛选。 */
  async byDivision(division: string): Promise<Expert[]> {
    return (await this.experts()).filter((e) => e.division === division)
  }

  /** 关键词检索 name/nameEn/description/descriptionEn/tags（大小写不敏感子串）。 */
  async search(query: string): Promise<Expert[]> {
    const q = query.trim().toLowerCase()
    if (q === '') return this.experts()
    return (await this.experts()).filter((e) => {
      const haystack = [e.name, e.nameEn, e.description, e.descriptionEn, ...(e.tags ?? [])]
        .filter((v): v is string => typeof v === 'string')
        .join('\n')
        .toLowerCase()
      return haystack.includes(q)
    })
  }

}

/* ---------- 人格组装层（保留纯函数，不进数据模型；原 expert-templates.ts 职责） ---------- */

/**
 * 专家人格组装（原 expertPersona 原样迁移，签名不变）：
 * 角色声明 + 职责约束（systemPrompt）+ 执行指导（executionPrompt）。
 * 各注入点在其外再包 [执行者角色] / sysPrefix 上下文。
 */
export function expertPersona(
  agent: Pick<SubAgent, 'name' | 'role' | 'systemPrompt' | 'executionPrompt'>,
  /** member = 编排派工的子任务执行者；direct = 用户在会话里直接 @/对话（无主调度，不应禁止其使用自身工具与委派能力） */
  mode: 'member' | 'direct' = 'member',
): string {
  const parts: string[] = []
  const role = agent.role?.trim()
  parts.push(
    mode === 'member'
      ? `你是「${agent.name}」，多智能体团队中的一名执行成员${role ? `，正式角色：${role}` : ''}。主调度负责拆解与派工；你专注完成分配给你的任务，不做转派，不越界接管他人任务。`
      : `你是「${agent.name}」${role ? `（角色：${role}）` : ''}，正在与用户直接对话。按用户本轮诉求执行，可按需使用你自身可用的工具与能力。`,
  )
  const persona = agent.systemPrompt?.trim()
  if (persona) parts.push(persona)
  const guidance = agent.executionPrompt?.trim()
  if (guidance) parts.push(`[执行指导]\n${guidance}`)
  return parts.join('\n\n')
}

/** 角色展示名：role 优先，回退「通用执行者」（编排花名册与日志用） */
export function expertRoleLabel(agent: Pick<SubAgent, 'role' | 'systemPrompt'>): string {
  return agent.role?.trim() || '通用执行者'
}
