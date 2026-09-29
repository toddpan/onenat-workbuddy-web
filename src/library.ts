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
    '4. 最后汇报：每个 tgz 文件的【绝对路径】及对应插件名与版本、跳过清单。绝对路径清单是平台回收的依据，务必逐行列出。',
    '不要做与本任务无关的其他操作。',
  ].join('\n')
}

/** 从任务轮次文本中提取导出的 tgz 绝对路径清单 */
export function extractExportedPaths(text: string): string[] {
  const hits = new Set<string>()
  const re = /(?:^|[\s"'`(])((?:\/[\w.@+-]+)+\/[\w.@+-]+\.tgz)/g
  for (const m of text.matchAll(re)) hits.add(m[1])
  return [...hits]
}
