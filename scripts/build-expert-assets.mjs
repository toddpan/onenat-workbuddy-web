#!/usr/bin/env node
/**
 * 生成 assets/experts/（ExpertRegistry Phase 2 数据资产）：
 *  1. 读 assets/expert-roster 下 en/zh 两个语种目录的 .md（frontmatter + persona 正文），合成双语专家（zh 覆盖 en 基线）。
 *  2. 从 src/expert-templates.ts 提取 EXPERT_TEMPLATES 常量（纯 JS 字面量，去类型标注后可直接求值），生成 7 个 builtin 档案（division=team）。
 *  3. 输出 assets/experts/index.json + profiles/<id>.json + schema/*.schema.json，校验 id 唯一性与 slug 白名单。
 *
 * 幂等，可重复运行。迁移验收：index 总数 = 321（roster）+ 7（builtin）。
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROSTER_ROOT = join(ROOT, 'assets', 'expert-roster')
const OUT_ROOT = join(ROOT, 'assets', 'experts')
const TEMPLATES_TS = join(ROOT, 'src', 'expert-templates.ts')

const EXPERT_PATH_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DESCRIPTION_LIST_LIMIT = 120

const DIVISION_ZH = {
  academic: '学术', company: '公司经营', design: '设计', engineering: '工程', finance: '金融',
  'game-development': '游戏开发', gis: '地理信息', healthcare: '医疗健康', hr: '人力资源',
  legal: '法务', marketing: '市场营销', 'paid-media': '付费媒体', product: '产品',
  'project-management': '项目管理', research: '研究', sales: '销售', security: '安全',
  'spatial-computing': '空间计算', specialized: '专业', support: '支持', 'supply-chain': '供应链',
  testing: '测试',
}

function stripBom(t) { return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t }
function unquote(v) {
  const f = v.charAt(0)
  return (f === '"' || f === "'") && v.length >= 2 && v.endsWith(f) ? v.slice(1, -1) : v
}
function parseFrontmatter(fm) {
  const get = (key) => {
    const m = fm.match(new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm'))
    return m === null ? undefined : unquote(m[1].trim())
  }
  return { name: get('name'), description: get('description'), descriptionEn: get('descriptionEn'), emoji: get('emoji') }
}
function parsePersonaFile(raw) {
  const m = stripBom(raw).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (m === null) return undefined
  const body = m[2].trim()
  return body === '' ? undefined : { ...parseFrontmatter(m[1]), body }
}

/** 递归收集 .md 文件（目录名排序保证确定性）。 */
function walkMd(dir, out = []) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) walkMd(full, out)
    else if (e.isFile() && e.name.endsWith('.md')) out.push(full)
  }
  return out
}

/** 扫描一个语种目录，返回 slug → { meta, division, body }。 */
function scanLocale(localeDir) {
  const out = new Map()
  let divisions = []
  try { divisions = readdirSync(localeDir, { withFileTypes: true }) } catch { return out }
  for (const d of divisions.filter((e) => e.isDirectory()).map((e) => e.name).sort((a, b) => a.localeCompare(b))) {
    for (const filePath of walkMd(join(localeDir, d))) {
      const slug = (filePath.split('/').pop() || '').slice(0, -3)
      if (!EXPERT_PATH_SEGMENT.test(slug)) continue
      let parsed
      try { parsed = parsePersonaFile(readFileSync(filePath, 'utf8')) } catch { continue }
      if (parsed === undefined || parsed.name === undefined || parsed.description === undefined) continue
      out.set(slug, { meta: parsed, division: d, body: parsed.body })
    }
  }
  return out
}

/** 从 expert-templates.ts 提取 EXPERT_TEMPLATES 数组字面量并求值（数组内容为纯 JS 表达式，无 TS 语法）。
 *  Phase 2 迁移完成后 expert-templates.ts 已变成纯转发 shim，此时回退读既有生成的 builtin 资产
 *  （index.json source=builtin + profiles/expert-*.json），保证脚本继续幂等可重跑。 */
async function extractTemplates() {
  const src = readFileSync(TEMPLATES_TS, 'utf8')
  const start = src.indexOf('EXPERT_TEMPLATES: ExpertTemplate[] = [')
  if (start < 0) {
    const idxPath = join(OUT_ROOT, 'index.json')
    if (!existsSync(idxPath)) throw new Error('expert-templates.ts 已是 shim 且 assets/experts/index.json 不存在，无法恢复 builtin 模板')
    const idx = JSON.parse(readFileSync(idxPath, 'utf8'))
    const out = []
    for (const e of idx.experts.filter((x) => x.source === 'builtin')) {
      const p = JSON.parse(readFileSync(join(OUT_ROOT, 'profiles', `${e.id}.json`), 'utf8'))
      out.push({ id: e.id, name: e.name, icon: e.icon, role: p.role || e.name, description: e.description, systemPrompt: p.systemPrompt, executionPrompt: p.executionPrompt || '' })
    }
    if (out.length === 0) throw new Error('既有资产中没有 builtin 模板')
    return out
  }
  const eq = src.indexOf('= [', start)
  if (eq < 0) throw new Error('未找到 EXPERT_TEMPLATES 数组起始')
  const arrStart = eq + 2
  // 找到与数组起始 [ 配对的 ]（模板字面量内不出现未配对的 ]）
  let depth = 0, end = -1
  for (let i = arrStart; i < src.length; i++) {
    if (src[i] === '[') depth++
    else if (src[i] === ']') { depth--; if (depth === 0) { end = i; break } }
  }
  if (end < 0) throw new Error('EXPERT_TEMPLATES 数组未闭合')
  const code = `const EXPERT_TEMPLATES = ${src.slice(arrStart, end + 1)};\nexport default EXPERT_TEMPLATES;\n`
  const dataUrl = `data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`
  // eslint-disable-next-line no-eval -- 动态 import data URL 求值纯数据字面量
  return import(dataUrl).then((m) => m.default)
}

function truncate(text, limit) {
  const cps = Array.from(text)
  return cps.length <= limit ? text : `${cps.slice(0, limit).join('')}…`
}

const builtin = await extractTemplates()

// ---------- roster（en 基线 + zh 覆盖） ----------
const en = scanLocale(join(ROSTER_ROOT, 'en'))
const zh = scanLocale(join(ROSTER_ROOT, 'zh'))
const experts = []
for (const [slug, entry] of en) {
  const z = zh.get(slug)
  const zm = z?.meta
  experts.push({
    id: slug,
    source: 'roster',
    division: entry.division,
    divisionZh: DIVISION_ZH[entry.division] ?? entry.division,
    icon: zm?.emoji || entry.meta.emoji || '',
    name: zm?.name || entry.meta.name || '',
    nameEn: entry.meta.name || '',
    description: truncate(zm?.description || entry.meta.description || '', DESCRIPTION_LIST_LIMIT),
    descriptionEn: truncate(entry.meta.descriptionEn || '', DESCRIPTION_LIST_LIMIT),
    ...(z || entry.body ? {} : {}),
    _zhBody: z?.body,
    _enBody: entry.body,
  })
}
experts.sort((a, b) => a.division.localeCompare(b.division) || a.id.localeCompare(b.id))

// ---------- builtin 模板 ----------
for (const t of builtin) {
  if (!EXPERT_PATH_SEGMENT.test(t.id)) throw new Error(`builtin id 不合法：${t.id}`)
  experts.push({
    id: t.id,
    source: 'builtin',
    division: 'team',
    divisionZh: '团队角色',
    icon: t.icon || '🧩',
    name: t.name,
    nameEn: t.name,
    description: truncate(t.description, DESCRIPTION_LIST_LIMIT),
    descriptionEn: truncate(t.description, DESCRIPTION_LIST_LIMIT),
    _builtin: t,
  })
}

// ---------- 校验 ----------
const seen = new Set()
for (const e of experts) {
  if (!EXPERT_PATH_SEGMENT.test(e.id)) throw new Error(`id 不合法：${e.id}`)
  if (seen.has(e.id)) throw new Error(`id 重复：${e.id}`)
  seen.add(e.id)
  if (!e.name || !e.description) throw new Error(`专家 ${e.id} 缺 name/description`)
}

// ---------- 输出 ----------
rmSync(OUT_ROOT, { recursive: true, force: true })
mkdirSync(join(OUT_ROOT, 'profiles'), { recursive: true })
mkdirSync(join(OUT_ROOT, 'schema'), { recursive: true })

const indexOut = {
  $schema: './schema/index.schema.json',
  version: 1,
  generatedAt: new Date().toISOString().slice(0, 10),
  experts: experts.map(({ _zhBody, _enBody, _builtin, ...meta }) => meta),
}
writeFileSync(join(OUT_ROOT, 'index.json'), JSON.stringify(indexOut, null, 2) + '\n')

for (const e of experts) {
  let profile
  if (e._builtin) {
    profile = {
      $schema: '../schema/profile.schema.json',
      id: e.id,
      role: e._builtin.role,
      systemPrompt: e._builtin.systemPrompt,
      executionPrompt: e._builtin.executionPrompt,
      locales: { zh: { systemPrompt: e._builtin.systemPrompt, executionPrompt: e._builtin.executionPrompt } },
    }
  } else {
    profile = {
      $schema: '../schema/profile.schema.json',
      id: e.id,
      systemPrompt: e._zhBody ?? e._enBody,
      locales: {
        ...(e._zhBody ? { zh: { systemPrompt: e._zhBody } } : {}),
        ...(e._enBody ? { en: { systemPrompt: e._enBody } } : {}),
      },
    }
  }
  writeFileSync(join(OUT_ROOT, 'profiles', `${e.id}.json`), JSON.stringify(profile, null, 2) + '\n')
}

writeFileSync(join(OUT_ROOT, 'schema', 'index.schema.json'), JSON.stringify({
  type: 'object',
  required: ['version', 'experts'],
  properties: {
    version: { const: 1 },
    experts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'source', 'division', 'divisionZh', 'name', 'description'],
        properties: {
          id: { $ref: '#/$defs/slug' },
          source: { enum: ['roster', 'builtin'] },
          division: { type: 'string' },
          divisionZh: { type: 'string' },
          icon: { type: 'string' },
          name: { type: 'string' },
          nameEn: { type: 'string' },
          description: { type: 'string' },
          descriptionEn: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
    },
  },
  $defs: { slug: { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' } },
}, null, 2) + '\n')

writeFileSync(join(OUT_ROOT, 'schema', 'profile.schema.json'), JSON.stringify({
  type: 'object',
  required: ['id', 'systemPrompt'],
  properties: {
    id: { $ref: '#/$defs/slug' },
    role: { type: 'string' },
    systemPrompt: { type: 'string' },
    executionPrompt: { type: 'string' },
    locales: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        properties: { systemPrompt: { type: 'string' }, executionPrompt: { type: 'string' } },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
  $defs: { slug: { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' } },
}, null, 2) + '\n')

// NOTICE 沿用上游授权说明
const srcNotice = join(ROSTER_ROOT, 'NOTICE')
if (existsSync(srcNotice)) {
  writeFileSync(join(OUT_ROOT, 'NOTICE'),
    readFileSync(srcNotice, 'utf8') +
    '\n---\n本目录 index.json / profiles/*.json 由 scripts/build-expert-assets.mjs 从 assets/expert-roster 与' +
    ' src/expert-templates.ts 生成，属上述来源的演绎物，授权边界沿用上游 NOTICE/LICENSE。\n')
}

const rosterCount = experts.filter((e) => e.source === 'roster').length
const builtinCount = experts.filter((e) => e.source === 'builtin').length
console.log(`[build-expert-assets] roster=${rosterCount} builtin=${builtinCount} total=${experts.length}`)
if (rosterCount + builtinCount !== 328) {
  console.error(`[build-expert-assets] 总数异常，期望 321 + 7 = 328`)
  process.exit(1)
}
