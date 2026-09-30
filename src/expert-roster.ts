/**
 * onenat-workbuddy-web - 内置专家名册（321 位专业智能体）
 *
 * persona 快照与目录约定移植自 dsh-agency-agents（Apache-2.0，MichengAI）：
 *   assets/expert-roster/{en,zh}/<division>/<slug>.md —— YAML frontmatter 元数据 + persona 正文。
 * 上游 persona 源自 The Agency（MIT）与 agency-agents-zh 中文本地化，授权边界见
 * assets/expert-roster/NOTICE 与各目录内 LICENSE。
 *
 * 名册定位是「预制人格库」：启动不加载，首次访问只扫描 frontmatter 建索引
 * （分块读文件头部，不载入正文），一键创建子智能体时才按需读取正文预填表单。
 * 名册不参与运行时路由；创建出的子智能体是普通实体，走既有委派/编排链路。
 */

import { existsSync } from 'node:fs'
import { open, readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 外部名册根目录环境变量（结构需与 assets/expert-roster 一致：en/zh 两个语种目录）。 */
const ROOT_ENV = 'WORKBUDDY_EXPERT_ROOT'

/** 名册内 slug（文件名去 .md）白名单模式，拼接路径前校验，拒绝路径穿越。 */
const EXPERT_PATH_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** frontmatter 只读文件头部：分块读到能匹配完整块的长度即停，不载入 persona 正文。 */
const FRONTMATTER_READ_CHUNK_BYTES = 1024
const FRONTMATTER_MAX_BYTES = 64 * 1024

/** 列表接口的简介截断长度，控制全量名册 JSON 体积。 */
const DESCRIPTION_LIST_LIMIT = 120

/** 分区目录名 → 中文分区名（对齐 dsh-agency-agents ZH_DIVISION）。 */
export const DIVISION_ZH: Readonly<Record<string, string>> = {
  academic: '学术',
  company: '公司经营',
  design: '设计',
  engineering: '工程',
  finance: '金融',
  'game-development': '游戏开发',
  gis: '地理信息',
  healthcare: '医疗健康',
  hr: '人力资源',
  legal: '法务',
  marketing: '市场营销',
  'paid-media': '付费媒体',
  product: '产品',
  'project-management': '项目管理',
  research: '研究',
  sales: '销售',
  security: '安全',
  'spatial-computing': '空间计算',
  specialized: '专业',
  support: '支持',
  'supply-chain': '供应链',
  testing: '测试',
}

/** 名册专家的展示元数据（name/description 为中文优先；nameEn/descriptionEn 恒为英文原文）。 */
export interface RosterExpert {
  slug: string
  division: string
  emoji: string
  name: string
  nameEn: string
  description: string
  descriptionEn: string
}

export interface RosterDivision {
  division: string
  divisionZh: string
  count: number
  /** 列表输出中 description 截断到 DESCRIPTION_LIST_LIMIT。 */
  experts: RosterExpert[]
}

export interface RosterIndex {
  /** 资产缺失（如部署包未带 assets）时为 false，接口降级为空名册而非报错。 */
  available: boolean
  total: number
  divisions: RosterDivision[]
}

interface FrontmatterMetadata {
  name?: string
  description?: string
  descriptionEn?: string
  emoji?: string
}

/** 解析名册根目录：显式参数 > 环境变量 > 就近向上找 package.json 同级的 assets/expert-roster。 */
export function resolveRosterRoot(explicit?: string): string {
  if (explicit && explicit.trim() !== '') return explicit
  const fromEnv = process.env[ROOT_ENV]?.trim()
  if (fromEnv) return fromEnv
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = join(dir, 'assets', 'expert-roster')
    if (existsSync(join(candidate, 'en'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) return candidate
    dir = parent
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** 剥离字段值首尾的成对引号，保留引号内部的 #、冒号等字符。 */
function unquote(value: string): string {
  const first = value.charAt(0)
  if ((first === '"' || first === "'") && value.length >= 2 && value.endsWith(first)) {
    return value.slice(1, -1)
  }
  return value
}

function parseFrontmatterMetadata(fm: string): FrontmatterMetadata {
  const get = (key: string): string | undefined => {
    const m = fm.match(new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm'))
    return m === null ? undefined : unquote(m[1].trim())
  }
  return { name: get('name'), description: get('description'), descriptionEn: get('descriptionEn'), emoji: get('emoji') }
}

/** 解析完整 frontmatter（含正文），正文为空或块缺失视为无效名册文件。 */
function parsePersonaFile(raw: string): FrontmatterMetadata & { body: string } | undefined {
  const match = stripBom(raw).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (match === null) return undefined
  const body = match[2].trim()
  if (body === '') return undefined
  return { ...parseFrontmatterMetadata(match[1]), body }
}

async function readFrontmatterMetadata(filePath: string): Promise<FrontmatterMetadata | undefined> {
  const file = await open(filePath, 'r')
  const decoder = new TextDecoder('utf-8')
  let raw = ''
  let position = 0
  try {
    while (position < FRONTMATTER_MAX_BYTES) {
      const size = Math.min(FRONTMATTER_READ_CHUNK_BYTES, FRONTMATTER_MAX_BYTES - position)
      const buffer = Buffer.allocUnsafe(size)
      const { bytesRead } = await file.read(buffer, 0, size, position)
      if (bytesRead === 0) {
        raw += decoder.decode()
        const match = stripBom(raw).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
        return match === null ? undefined : parseFrontmatterMetadata(match[1])
      }
      position += bytesRead
      raw += decoder.decode(buffer.subarray(0, bytesRead), { stream: true })
      const match = stripBom(raw).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
      if (match !== null) return parseFrontmatterMetadata(match[1])
    }
    return undefined
  } finally {
    await file.close()
  }
}

/** 递归遍历目录下的 .md 文件；目录按名称排序，保证重复 slug 的覆盖顺序确定。 */
async function walkMarkdown(dir: string, onFile: (filePath: string) => Promise<void>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined)
  if (entries === undefined) return
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walkMarkdown(full, onFile)
    else if (entry.isFile() && entry.name.endsWith('.md')) await onFile(full)
  }
}

/** 扫描一个语种目录（en 为基线名册，zh 为中文覆盖），返回 slug → 元数据。 */
async function scanLocale(localeDir: string): Promise<Map<string, { meta: FrontmatterMetadata; division: string }>> {
  const out = new Map<string, { meta: FrontmatterMetadata; division: string }>()
  const divisions = (await readdir(localeDir, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
  for (const division of divisions) {
    await walkMarkdown(join(localeDir, division), async (filePath) => {
      const fileName = filePath.split('/').pop() || ''
      const slug = fileName.slice(0, -3)
      if (!EXPERT_PATH_SEGMENT.test(slug)) return
      let meta: FrontmatterMetadata | undefined
      try {
        meta = await readFrontmatterMetadata(filePath)
      } catch {
        return
      }
      if (meta === undefined || meta.name === undefined || meta.description === undefined) return
      if (out.has(slug)) console.warn(`[onenat-workbuddy] 专家名册 slug 冲突（${localeDir}），后加载者覆盖：${slug}`)
      out.set(slug, { meta, division })
    })
  }
  return out
}

/**
 * 内置专家名册。en/ 目录为基线（含全部专家），zh/ 为中文译文覆盖（slug 一一对应）；
 * 单个专家缺失译文时回退英文字段，正文读取时中文优先。
 */
export class ExpertRoster {
  private root: string
  private expertsPromise?: Promise<RosterExpert[]>

  constructor(root?: string) {
    this.root = resolveRosterRoot(root)
  }

  /** 首次访问扫描建索引，进程内缓存。 */
  private experts(): Promise<RosterExpert[]> {
    this.expertsPromise ??= (async () => {
      const en = await scanLocale(join(this.root, 'en'))
      const zh = await scanLocale(join(this.root, 'zh'))
      const experts: RosterExpert[] = []
      for (const [slug, entry] of en) {
        const zhEntry = zh.get(slug)
        const zhMeta = zhEntry?.meta
        experts.push({
          slug,
          division: entry.division,
          emoji: zhMeta?.emoji || entry.meta.emoji || '',
          name: zhMeta?.name || entry.meta.name || '',
          nameEn: entry.meta.name || '',
          description: zhMeta?.description || entry.meta.description || '',
          descriptionEn: entry.meta.descriptionEn || '',
        })
      }
      return experts.sort((a, b) => a.division.localeCompare(b.division) || a.slug.localeCompare(b.slug))
    })()
    return this.expertsPromise
  }

  /** 全量名册索引（列表简介截断）；资产缺失时 available=false 降级为空名册。 */
  async index(): Promise<RosterIndex> {
    if (!existsSync(join(this.root, 'en'))) return { available: false, total: 0, divisions: [] }
    const experts = await this.experts()
    const byDivision = new Map<string, RosterExpert[]>()
    for (const expert of experts) {
      const list = byDivision.get(expert.division) ?? []
      list.push(expert)
      byDivision.set(expert.division, list)
    }
    const divisions = [...byDivision.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([division, list]) => ({
        division,
        divisionZh: DIVISION_ZH[division] ?? division,
        count: list.length,
        experts: list.map((e) => ({ ...e, description: truncate(e.description, DESCRIPTION_LIST_LIMIT) })),
      }))
    return { available: true, total: experts.length, divisions }
  }

  /** 读取一位专家的 persona 正文（中文优先，缺译文回退 en 原文）。 */
  async getPrompt(slug: string, division: string): Promise<{ expert: RosterExpert; prompt: string }> {
    if (!EXPERT_PATH_SEGMENT.test(slug)) throw new Error('无效的专家标识。')
    const expert = (await this.experts()).find((e) => e.slug === slug && e.division === division)
    if (expert === undefined) throw new Error('名册中不存在该专家。')
    for (const locale of ['zh', 'en'] as const) {
      const raw = await readFile(join(this.root, locale, division, `${slug}.md`), 'utf8').catch(() => undefined)
      if (raw === undefined) continue
      const parsed = parsePersonaFile(raw)
      if (parsed !== undefined) return { expert, prompt: parsed.body }
    }
    throw new Error('专家提示词文件缺失或格式无效。')
  }
}

function truncate(text: string, limit: number): string {
  const codePoints = Array.from(text)
  return codePoints.length <= limit ? text : `${codePoints.slice(0, limit).join('')}…`
}
