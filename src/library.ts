/**
 * onenat-workbuddy-web - 平台技能/插件库
 *
 * 技能与插件以压缩包为单元（.zip / .tgz）存放在 <dataDir>/library/，
 * index.json 记条目元数据、安装记录与签名密钥。远端 DSH 节点的安装/导出
 * 一律通过向该节点子智能体发起任务完成（提示词模板见文末），平台不直接
 * 改写远端文件；安装结果经安装记录（按目标任务状态回查）展示。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync, rmSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkStore } from './store.js'

const execFileP = promisify(execFile)

export type LibKind = 'skill' | 'plugin'

export interface LibEntry {
  id: string
  kind: LibKind
  /** 技能：SKILL.md frontmatter name；插件：package.json name；解析失败用文件名去后缀 */
  name: string
  /** 插件版本（package.json version） */
  version?: string
  description?: string
  filename: string
  size: number
  uploadedAt: number
  source: 'upload' | 'import'
  /** source=import 时的来源子智能体名（其所在节点） */
  sourceNode?: string
  /** 插件家族（引擎形态）：dsh / zcode / 未来扩展的其它 AGENT 家族；技能不设。导入时随来源节点/目标 agent 匹配校验 */
  family?: string
}

export interface LibInstallTarget {
  agentId: string
  agentName: string
  taskId: string
  status: 'running' | 'success' | 'failed'
  finishedAt?: number
}

export interface LibInstallRecord {
  id: string
  kind: LibKind
  libId: string
  name: string
  at: number
  targets: LibInstallTarget[]
}

interface LibIndex {
  v: 1
  secret: string
  publicBaseUrl?: string
  entries: LibEntry[]
  installs: LibInstallRecord[]
}

const DOWNLOAD_TOKEN_TTL_MS = 30 * 60 * 1000
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024

export class SkillPluginLibrary {
  private libDir: string
  private index: LibIndex

  constructor(
    dataDir: string,
    private store: WorkStore,
    private log: (msg: string) => void = () => {},
  ) {
    this.libDir = join(dataDir, 'library')
    for (const d of [this.libDir, this.skillsDir(), this.pluginsDir()]) {
      try {
        if (!existsSync(d)) mkdirSync(d, { recursive: true })
      } catch { /* 只读文件系统下降级：入库/下载不可用，不影响其余功能 */ }
    }
    this.index = this.loadIndex()
  }

  private skillsDir(): string {
    return join(this.libDir, 'skills')
  }

  private pluginsDir(): string {
    return join(this.libDir, 'plugins')
  }

  private indexPath(): string {
    return join(this.libDir, 'index.json')
  }

  private loadIndex(): LibIndex {
    try {
      const raw = JSON.parse(readFileSync(this.indexPath(), 'utf-8'))
      if (raw && Array.isArray(raw.entries) && typeof raw.secret === 'string') {
        return { v: 1, secret: raw.secret, publicBaseUrl: raw.publicBaseUrl || undefined, entries: raw.entries, installs: Array.isArray(raw.installs) ? raw.installs : [] }
      }
    } catch { /* 首次启动或损坏则重建（条目文件仍在，可手工恢复） */ }
    return { v: 1, secret: randomUUID() + randomUUID(), entries: [], installs: [] }
  }

  private save(): void {
    try {
      const tmp = this.indexPath() + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.index, null, 2), 'utf-8')
      renameSync(tmp, this.indexPath())
    } catch (err: any) {
      this.log(`技能插件库 index.json 写入失败: ${err?.message || err}`)
    }
  }

  // ---------- 条目 ----------

  public list(kind: LibKind): LibEntry[] {
    return this.index.entries.filter((e) => e.kind === kind).sort((a, b) => b.uploadedAt - a.uploadedAt)
  }

  public get(id: string): LibEntry | undefined {
    return this.index.entries.find((e) => e.id === id)
  }

  public allEntries(): LibEntry[] {
    return this.index.entries
  }

  public async add(
    kind: LibKind,
    file: { filename: string; data: Buffer },
    source: 'upload' | 'import',
    sourceNode?: string,
    family?: string,
  ): Promise<LibEntry> {
    if (file.data.length === 0) throw new Error('文件为空')
    if (file.data.length > MAX_ARCHIVE_BYTES) throw new Error(`文件超过 ${Math.round(MAX_ARCHIVE_BYTES / 1024 / 1024)}MB 上限`)
    const id = randomUUID().slice(0, 8)
    const filename = sanitizeFilename(file.filename || (kind === 'skill' ? 'skill.zip' : 'plugin.tgz'))
    const dir = kind === 'skill' ? this.skillsDir() : this.pluginsDir()
    writeFileSync(join(dir, id), file.data)
    const meta = await parseArchiveMeta(kind, filename, file.data).catch(() => undefined)
    const entry: LibEntry = {
      id,
      kind,
      name: meta?.name || stemOf(filename),
      ...(meta?.version ? { version: meta.version } : {}),
      ...(meta?.description ? { description: meta.description } : {}),
      filename,
      size: file.data.length,
      uploadedAt: Date.now(),
      source,
      ...(sourceNode ? { sourceNode } : {}),
      ...(family ? { family } : {}),
    }
    this.index.entries.push(entry)
    this.save()
    return entry
  }

  public remove(id: string): boolean {
    const entry = this.get(id)
    if (!entry) return false
    const dir = entry.kind === 'skill' ? this.skillsDir() : this.pluginsDir()
    try {
      unlinkSync(join(dir, id))
    } catch { /* 文件已不存在则忽略 */ }
    this.index.entries = this.index.entries.filter((e) => e.id !== id)
    this.save()
    return true
  }

  public readFile(id: string): Buffer | undefined {
    const entry = this.get(id)
    if (!entry) return undefined
    const dir = entry.kind === 'skill' ? this.skillsDir() : this.pluginsDir()
    try {
      return readFileSync(join(dir, id))
    } catch {
      return undefined
    }
  }

  // ---------- 签名下载链接（DSH 无平台登录态，凭 token 拉包） ----------

  public setPublicBaseUrl(url: string): void {
    const t = String(url || '').trim().replace(/\/+$/, '')
    this.index.publicBaseUrl = t || undefined
    this.save()
  }

  public publicBaseUrl(): string | undefined {
    return this.index.publicBaseUrl || undefined
  }

  public downloadToken(id: string, ttlMs = DOWNLOAD_TOKEN_TTL_MS): string {
    const exp = Date.now() + ttlMs
    const sig = createHmac('sha256', this.index.secret).update(`${id}.${exp}`).digest('base64url')
    return `${exp}.${sig}`
  }

  public verifyDownloadToken(id: string, token: string): boolean {
    const m = /^(\d+)\.([A-Za-z0-9_-]+)$/.exec(String(token || ''))
    if (!m) return false
    const exp = Number(m[1])
    if (!Number.isFinite(exp) || exp < Date.now()) return false
    const expect = createHmac('sha256', this.index.secret).update(`${id}.${exp}`).digest('base64url')
    const a = Buffer.from(m[2])
    const b = Buffer.from(expect)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  // ---------- 安装记录 ----------

  public createInstall(kind: LibKind, entry: LibEntry, targets: Array<{ agentId: string; agentName: string; taskId: string }>): LibInstallRecord {
    const record: LibInstallRecord = {
      id: randomUUID().slice(0, 8),
      kind,
      libId: entry.id,
      name: entry.name,
      at: Date.now(),
      targets: targets.map((t) => ({ ...t, status: 'running' as const })),
    }
    this.index.installs.unshift(record)
    if (this.index.installs.length > 200) this.index.installs.length = 200
    this.save()
    return record
  }

  /** 展示前按目标任务最新状态回写（自愈式，无需引擎钩子） */
  public syncInstalls(): LibInstallRecord[] {
    let dirty = false
    for (const rec of this.index.installs) {
      for (const t of rec.targets) {
        if (t.status !== 'running') continue
        const task = this.store.getTask(t.taskId)
        if (!task) continue
        if (task.status === 'completed' || task.status === 'success' || task.status === 'partial_success') {
          t.status = 'success'
          t.finishedAt = task.updatedAt || Date.now()
          dirty = true
        } else if (task.status === 'failed' || task.status === 'cancelled') {
          t.status = 'failed'
          t.finishedAt = task.updatedAt || Date.now()
          dirty = true
        }
      }
    }
    if (dirty) this.save()
    return this.index.installs
  }
}

// ---------- 压缩包元数据解析（best-effort，失败降级为文件名） ----------

interface ArchiveMeta {
  name?: string
  version?: string
  description?: string
}

async function parseArchiveMeta(kind: LibKind, filename: string, data: Buffer): Promise<ArchiveMeta | undefined> {
  const lower = filename.toLowerCase()
  const isZip = lower.endsWith('.zip')
  const isTar = lower.endsWith('.tgz') || lower.endsWith('.tar.gz') || lower.endsWith('.tar')
  if (!isZip && !isTar) return undefined
  const marker = kind === 'skill' ? /(^|\/)SKILL\.md$/i : /(^|\/)package\.json$/
  const tmp = join(tmpdir(), `wb-lib-${randomUUID().slice(0, 8)}${isZip ? '.zip' : '.tgz'}`)
  try {
    writeFileSync(tmp, data)
    let entry: string | undefined
    let content: string | undefined
    if (isZip) {
      const list = await execFileP('unzip', ['-Z1', tmp], { timeout: 15_000 }).catch(() => undefined)
      const names = (list?.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)
      entry = pickEntry(names, marker)
      if (entry) {
        const out = await execFileP('unzip', ['-p', tmp, entry], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }).catch(() => undefined)
        content = out?.stdout
      }
    } else {
      const list = await execFileP('tar', ['-tf', tmp], { timeout: 15_000 }).catch(() => undefined)
      const names = (list?.stdout || '').split('\n').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean)
      entry = pickEntry(names, marker)
      if (entry) {
        const out = await execFileP('tar', ['-xOf', tmp, entry], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 }).catch(() => undefined)
        content = out?.stdout
      }
    }
    if (!content) return undefined
    return kind === 'skill' ? parseSkillFrontmatter(content) : parsePackageJson(content)
  } finally {
    try {
      rmSync(tmp, { force: true })
    } catch { /* 临时文件清理失败无碍 */ }
  }
}

function pickEntry(names: string[], marker: RegExp): string | undefined {
  const hits = names.filter((n) => marker.test(n) && !n.split('/').some((seg) => seg === '__MACOSX' || seg.startsWith('._')))
  if (!hits.length) return undefined
  // 路径最浅者优先（npm pack 的 package/ 包装目录、单层包装都能命中）
  return hits.sort((a, b) => a.split('/').length - b.split('/').length)[0]
}

function parseSkillFrontmatter(content: string): ArchiveMeta {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(content)
  if (!m) return {}
  const fm = m[1]
  const name = /^name:\s*(.+)$/m.exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, '')
  const description = /^description:\s*(.+)$/m.exec(fm)?.[1]?.trim().replace(/^["']|["']$/g, '')
  return { ...(name ? { name } : {}), ...(description ? { description } : {}) }
}

function parsePackageJson(content: string): ArchiveMeta {
  try {
    const pkg = JSON.parse(content)
    return {
      ...(pkg.name ? { name: String(pkg.name) } : {}),
      ...(pkg.version ? { version: String(pkg.version) } : {}),
      ...(pkg.description ? { description: String(pkg.description).slice(0, 200) } : {}),
    }
  } catch {
    return {}
  }
}

function sanitizeFilename(name: string): string {
  const cleaned = String(name || '').replace(/[\\/]/g, '_').replace(/[\u0000-\u001f]/g, '').trim()
  return cleaned || 'archive.bin'
}

function stemOf(filename: string): string {
  return filename.replace(/\.(tgz|tar\.gz|zip|tar)$/i, '')
}

// ---------- 安装 / 导出任务提示词模板 ----------

/** 技能安装任务提示词：下载 → 解压 → 装到 ~/.dsh/skills/<name>/ → 自检 → 汇报 */
export function buildSkillInstallPrompt(entry: LibEntry, url: string): string {
  const name = entry.name
  return [
    `【平台下发任务】在本节点安装技能「${name}」，请严格按步骤执行并汇报结果。`,
    '',
    `1. 下载技能包（先 mkdir -p /tmp/wb-lib）：`,
    `   curl -fSL --retry 2 -o "/tmp/wb-lib/${entry.filename}" "${url}"`,
    `   下载后用 ls -la 确认文件存在且大于 0 字节。`,
    `2. 解压到临时目录（.tgz/.tar.gz 用 tar -xzf，.zip 用 unzip -o）：`,
    `   mkdir -p "/tmp/wb-lib/${name}" && 解压 "/tmp/wb-lib/${entry.filename}" 到该目录`,
    `3. 找到 SKILL.md 所在目录（可能在解压根目录或单层子目录里），把该目录的全部内容安装到用户技能目录：`,
    `   rm -rf ~/.dsh/skills/${name} && mkdir -p ~/.dsh/skills/${name}`,
    `   cp -a "<SKILL.md 所在目录>/. " ~/.dsh/skills/${name}/`,
    `4. 自检：head -20 ~/.dsh/skills/${name}/SKILL.md，确认 frontmatter 的 name 为 ${name}。`,
    '5. 汇报：安装成功/失败、最终安装路径；失败时给出关键报错原文。',
  ].join('\n')
}

/** 插件安装任务提示词：下载 → dsh plugin add → 确认状态 → 汇报 */
export function buildPluginInstallPrompt(entry: LibEntry, url: string): string {
  const label = entry.version ? `${entry.name}@${entry.version}` : entry.name
  return [
    `【平台下发任务】在本节点安装 DSH 插件「${label}」，请严格按步骤执行并汇报结果。`,
    '',
    `1. 下载插件包（先 mkdir -p /tmp/wb-lib）：`,
    `   curl -fSL --retry 2 -o "/tmp/wb-lib/${entry.filename}" "${url}"`,
    `   下载后用 ls -la 确认文件存在且大于 0 字节。`,
    `2. 安装插件：`,
    `   dsh plugin add "/tmp/wb-lib/${entry.filename}"`,
    `   - 若该命令不接受本地文件路径，改用：dsh plugin add "${url}"`,
    '3. 确认安装状态（dsh plugin list 或等价查看方式）：',
    '   - 状态 applied = 已生效；restart-required = 需要重启节点后生效，请明确说明需重启。',
    '4. 汇报：插件名、版本、安装状态（applied / restart-required / 失败）；失败时给出关键报错原文。',
  ].join('\n')
}

/** 插件导出任务提示词（从节点导入插件用）：枚举已装插件 → npm pack → 汇报 tgz 绝对路径清单 */
export function buildPluginExportPrompt(): string {
  return [
    '【平台下发任务】把本节点已安装的 DSH 插件打包导出，供平台回收存档。请严格按以下步骤执行：',
    '',
    '1. 列出本节点已安装的 DSH 插件（优先 dsh plugin list；不可用则从 DSH profile 的 package.json 依赖里识别）。',
    '2. 对每个插件：定位其包目录（含 package.json 的目录），在该目录执行：',
    '   npm pack --pack-destination "$HOME/wb-lib-export/"',
    '   （目录不存在先 mkdir -p "$HOME/wb-lib-export"；无法定位包目录的插件跳过，并在汇报中说明原因。）',
    '3. 全部完成后执行：ls -la "$HOME/wb-lib-export/"',
    '4. 最后汇报：每个 tgz 文件的【绝对路径】及对应插件名与版本、跳过清单。绝对路径务必单独一行、原样输出（不要加粗、不要用括号/书名号包裹，也不要改写成 ~ 开头）。绝对路径清单是平台回收的依据，务必逐行列出。',
    '不要做与本任务无关的其他操作。',
  ].join('\n')
}

/** 按清单导出提示词（从节点导入插件·新版）：节点对每个 sourcePath 打包，汇报 tgz 绝对路径清单 */
export interface PluginPackItem {
  name: string
  /** node 上的绝对目录（含 package.json / .zcode-plugin 的插件目录） */
  sourcePath: string
  version?: string
}

export function buildPluginListExportPrompt(items: PluginPackItem[]): string {
  const lines: string[] = [
    '【平台下发任务】把本节点已安装的插件按平台给定清单打包导出，供平台回收存档。请严格按以下步骤执行：',
    '',
    '1. 先建立导出目录：mkdir -p "$HOME/wb-lib-export"',
    '2. 对下方每个【插件目录】逐个执行（目录即插件所在位置，无需 cd 之外的操作）：',
    '   npm pack --json --pack-destination "$HOME/wb-lib-export" "目录"', '',
  ]
  for (const it of items) {
    lines.push(`  - 目录 ${it.sourcePath}${it.version ? `（${it.name}@${it.version}）` : `（${it.name}）`}`)
  }
  lines.push(
    '',
    '3. 若某个目录 npm 不可用或打包失败，改用 tar 兜底：tar czf "$HOME/wb-lib-export/<插件名>-<版本>.tgz" -C "目录" .',
    '4. 全部完成后执行：ls -la "$HOME/wb-lib-export/"',
    '5. 最后汇报：每个 tgz 文件的【绝对路径】及对应插件名与版本、失败/跳过清单。绝对路径务必单独一行、原样输出（不要加粗、不要用括号/书名号包裹，也不要改写成 ~ 开头）。绝对路径清单是平台回收的依据，务必逐行列出。',
    '不要做与本任务无关的其他操作。禁止执行目录内 npm scripts（仅打包，不 build）。',
  )
  return lines.join('\n')
}

/** 从任务轮次文本中提取导出的 tgz 绝对路径清单 */
export function extractExportedPaths(text: string): string[] {
  const hits = new Set<string>()
  // 不要求路径前必须是空白/引号：模型汇报常把路径包进 **加粗**、（）、【】、表格竖线等，
  // 旧的边界约束会把整条汇报判成「未解析到路径」导致回收为空。
  const re = /((?:\/[\w.@+-]+)+\/[\w.@+-]+\.tgz)/g
  for (const m of text.matchAll(re)) hits.add(m[1])
  return [...hits]
}

/** 项目导入任务提示词：节点智能体分析远程项目 → 推断新建项目表单各字段 → 调平台接口自动建项目。
 * ⚠️ 提示词里不能出现「@ + 路径」字面量（如 curl 的 "@/tmp/x.json"）：服务端 extractMentions 会把
 * 独立路径样式的 @提及 兜底挂到 agents[0]，导致导入任务被定向委派到错误执行者。故用 $PAYLOAD 变量承载。
 * ⚠️ 临时文件必须带本次导入 ID：同一台机器可能同时执行多个导入任务，固定文件名（如
 * /tmp/wb-import-payload.json）会被并发任务互相覆盖（2026-10-18 线上事故：并发导入互相写走了对方载荷）。
 * 节点归属由平台按导入令牌在服务端绑定；payload 里的 node/workspace 只是防串号的一致性校验字段，
 * 平台比对不符会 409 拒收，智能体须原样照抄预填值。 */
export function buildProjectImportPrompt(opts: {
  name: string
  path: string
  createUrl: string
  nodeLabel: string
  nodeKey: string
  importId: string
  experts: Array<{ id: string; name: string; role?: string }>
  connectors: Array<{ id: string; label: string }>
}): string {
  const { name, path, createUrl, nodeLabel, nodeKey, importId, experts, connectors } = opts
  const expertList = experts.length
    ? experts.map((e) => `  - ${e.id}｜${e.name}${e.role ? `（${e.role}）` : ''}`).join('\n')
    : '  （平台当前没有可选成员，defaultAgentIds 留空数组）'
  const connectorList = connectors.length
    ? connectors.map((c) => `  - ${c.id}｜${c.label}`).join('\n')
    : '  （平台当前没有可选连接器，connectorIds 留空数组）'
  const tmpPrefix = `/tmp/wb-import-${importId}`
  return [
    `【平台下发任务】分析本节点上的项目工作区「${path}」，推断它在 Web 平台「新建项目」表单里应填的内容，然后调用平台接口把这个项目添加到平台（来源节点：${nodeLabel}；参考名：${name}）。请严格按步骤执行并汇报。`,
    '',
    `⚠️ 必填预填值（原样照抄到 payload JSON，平台会校验，不符即拒收）：`,
    `   - node（节点键）："${nodeKey}"`,
    `   - workspace（工作区路径）："${path}"`,
    `本项目将挂在来源节点「${nodeLabel}」下，节点归属由平台按导入令牌自动绑定，你无需在 payload 里选节点。`,
    '',
    '只能从下面的候选里选，禁止编造不存在的 ID：',
    '项目默认协作成员候选（defaultAgentIds，按职责与项目性质匹配）：',
    expertList,
    '项目连接器候选（connectorIds，项目需要访问的外部环境/服务才选）：',
    connectorList,
    '',
    '⚠️ 本任务的所有临时文件（载荷 JSON、中间稿等）统一用前缀 ' + tmpPrefix + '（如 ' + tmpPrefix + '.json、' + tmpPrefix + '-instr.md）。同一台机器可能同时执行多个导入任务，禁止使用不带本 ID 的临时文件名（如固定的 /tmp/wb-import-payload.json），否则并发任务会互相覆盖载荷。',
    '',
    `1. 确认目录存在：ls -la "${path}"（不存在则直接汇报失败，不要调用接口）。`,
    '2. 分析项目：查看目录结构（如 ls 或 tree 两层）、README/README.md、package.json / pyproject.toml / requirements.txt / pom.xml / go.mod / Cargo.toml 等清单与关键配置、主要源码入口，搞清楚：这是什么项目、技术栈、如何构建/运行/测试、大致用途与当前状态。',
    '3. 推断「新建项目」表单各字段：',
    '   - name：简洁的项目名（尽量 ≤20 字，可用中文概括用途）',
    '   - instruction：项目指令（以「# 角色」开头的 Markdown，写明项目背景、技术栈、目录结构要点、构建/运行/测试命令、注意事项，供平台后续任务注入；300~800 字）',
    '   - defaultAgentIds：从候选里挑该项目可能依赖的默认协作成员（没有合适的就空数组）',
    '   - connectorIds：从候选里挑项目会涉及的连接器（没有就空数组）',
    '   - skillNames：本节点已安装技能里项目会用到的（可 ls ~/.dsh/skills 查看，取目录名；没有就空数组）',
    '   - summary：一句话分析结论（这个项目是做什么的）',
    `4. 把上述字段加上预填的 node/workspace 写成 JSON 文件（UTF-8、合法 JSON；node 与 workspace 必须=如下原值，一字不改；用 heredoc 写文件，注意 instruction 内的引号与换行要转义）：`,
    `   PAYLOAD="${tmpPrefix}.json"`,
    '   cat > "$PAYLOAD" <<\'JSON\'',
    `   {"node":"${nodeKey}","workspace":"${path}","name":"…","instruction":"…","defaultAgentIds":[],"connectorIds":[],"skillNames":[],"summary":"…"}`,
    '   JSON',
    '   （写完后用 python3 -m json.tool "$PAYLOAD" 校验合法并核验 node/workspace 原值仍在，不对就修好再继续。）',
    '5. 调用平台接口创建项目（JSON 原文 POST，记录 HTTP 响应原文）：',
    '   curl -sS -X POST -H "Content-Type: application/json" --data-binary "@$PAYLOAD" "' + createUrl + '"',
    '   响应为 JSON：ok=true 且 data.workspace=' + path + ' 表示平台已按你推断的表单建好项目；ok=false 时把 error 原文一并汇报。若响应里 data.workspace 与本任务路径不一致，说明载荷被并发任务覆盖了——立即用本任务专属文件名重写载荷并重试一次，仍不一致则汇报失败。',
    `6. 汇报：项目分析结论（是什么项目/技术栈/怎么跑）、表单各字段的取值与理由（各一句话；字段表第一、二行必须是 node=${nodeKey} 与 workspace=${path}，并注明与平台响应 data.node.mappingId / data.workspace 是否一致；含平台侧 data.name 与你提交的 name 是否一致）、平台创建结果原文。`,
    '不要修改工作区内的任何文件，不要做与本任务无关的其他操作。',
  ].join('\n')
}
