/**
 * onenat-workbuddy-web - 未竟事项采集（简版：手动触发，一次预览 → 勾选 → 落盘）
 *
 * 设计来源：`docs/design-backlog-auto-collect.md` v3 的 A+B 双源最小实现。
 *  - **A 任务账本**：本项目里 failed / partial_success / 卡死 running 的任务（纯内存，零节点 IO）；
 *  - **B 工作区代码/文档**：项目工作区目录里的明确标记（代码注释里的标记关键词、文档未勾选验收 /
 *    文档状态行…），只认确定标记、不做语义猜测；
 *  - 去重：已在 backlog 条目正文里出现过的 `<!-- wb:source=<key> -->` 直接跳过（跨轮幂等）。
 *
 * 边界（如实声明，见设计 §4.3/§4.6）：
 *  - 节点只有单层 `/fs/list`（无递归/无 grep），目录树由本模块 BFS 逐层列；因此有目录数/文件数/
 *    文件大小硬上限，超出置 truncated 而不是静默残缺；
 *  - 不扩 dsh-web-service 端点（README「D6 零侵入」），只用既有 fsList / fsDownload / fsUpload；
 *  - 本简版不落「采集状态文件」：幂等只靠 sourceKey 对账（重复点击不会重复建条目），
 *    也就没有水位线（每次预览都会重新算候选，但已登记的会被过滤掉）。
 */
import { createHash } from 'node:crypto'
import type { DshClient, DshTarget } from './remote-client.js'
import type { WorkStore } from './store.js'
import type { Project, WorkTask } from './types.js'
import { createItems, initBacklog, listBacklog, type BacklogItem } from './backlog.js'

// ---------- 类型 ----------

export type CollectSource = 'task' | 'code' | 'doc'

export interface CollectCandidate {
  /** 稳定来源键：task:<taskId> / code:<sha1> / doc:<sha1>；写入条目正文注释，用于跨轮去重 */
  key: string
  source: CollectSource
  title: string
  detail: string[]
  /** 工作区相对路径（code/doc 候选） */
  filePath?: string
  labels: string[]
}

export interface CollectStats {
  /** 任务账本命中数（去重前） */
  taskCandidates: number
  /** 工作区标记命中数（去重前） */
  workspaceCandidates: number
  /** 已登记（sourceKey 命中）而被过滤掉的候选数 */
  skippedKnown: number
  dirsScanned: number
  filesScanned: number
  filesSkipped: number
  /** 目录/文件数触顶（扫描不完整） */
  truncated: boolean
  /** 工作区扫描失败时的原因（任务账本候选仍会返回） */
  scanError?: string
  ms: number
}

export interface CollectPreview {
  projectId: string
  projectName: string
  initialized: boolean
  candidates: CollectCandidate[]
  stats: CollectStats
}

export interface CollectApplyResult {
  created: BacklogItem[]
  /** 预览里剩余未创建（超出单次上限）的 key */
  skippedKeys: string[]
  candidates: number
}

// ---------- 常量（上限都是「成本护栏」，不是可选优化） ----------

const TASK_LOOKBACK_MS = 30 * 24 * 3600_000
const STALE_RUNNING_MS = 2 * 3600_000
const MAX_CANDIDATES = 40
const MAX_APPLY_PER_RUN = 30

const WS_MAX_DEPTH = 3
const WS_MAX_DIRS = 40
const WS_MAX_FILES = 200
const WS_MAX_FILE_BYTES = 200_000
const WS_CONCURRENCY = 4
const WS_MAX_MARKERS_PER_FILE = 3

/** 硬排除目录（采集写的就是 backlog/，含它必然自激；其余是无效 IO 大户） */
const IGNORE_DIRS = new Set([
  'backlog', '.git', 'node_modules', 'dist', 'dist-test', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.cache', 'vendor', '.venv', 'venv', '__pycache__', '.dsh-uploads',
  'archive', '.idea', '.vscode', 'assets', 'static', 'public',
])

const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.java', '.kt', '.kts',
  '.rs', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.php', '.rb', '.sh', '.bash', '.ps1',
  '.sql', '.vue', '.svelte', '.lua', '.swift', '.scala', '.gradle', '.groovy', '.pl',
])
const DOC_EXTS = new Set(['.md', '.markdown', '.mdx', '.txt', '.rst', '.adoc'])

const IGNORE_FILE_RE = /^(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|composer\.lock)$|\.min\.(?:js|css)$|\.map$|\.(?:png|jpe?g|gif|webp|svg|ico|bmp|pdf|zip|gz|tar|tgz|rar|7z|exe|dll|so|dylib|bin|woff2?|ttf|eot|mp[34]|wav|avi|mov|mp4|lock|snap)$/i
// 自激防线：本文件是采集器自身，下面两条正则的字面量、本文件注释与字符串里若裸写标记词，
// 扫描项目工作区时会把自己登记成候选（QA 20261101 task-35 / backlog code:b1c5dfa7 误报实证）。
// 约定：① 中文关键词只在注释行才算标记（标识符、UI 文案与错误消息字符串里大量出现，裸匹配必然误报）；
// ② 本文件所有注释与字符串一律用「未竟/标记」等措辞，禁止裸写任何标记词（含标签常量）。
const CODE_MARKER_EN_RE = /\bTODO\b|\bFIXME\b|\bXXX\b|\bHACK\b/i
const CODE_MARKER_CN_RE = /待办|待补充|未完成/
const DOC_STATUS_RE = /\bTBD\b|待确认|待定|\bWIP\b|状态[:：]\s*(?:草稿|进行中|待完成|未完成)/i
const COMMENT_PREFIX_RE = /^\s*(?:\/\/+|\/\*+|\*+|#+|<!--|--|;+|%+)\s*/

// ---------- 来源键 ----------

function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

/** 工作区标记的稳定键：路径 + 规范化文本（不含行号 → 代码上下移动不重复登记） */
export function workspaceSourceKey(source: 'code' | 'doc', relPath: string, markerText: string): string {
  const normalized = markerText.replace(/\s+/g, ' ').trim()
  return `${source}:${sha1(`${relPath}\n${normalized}`).slice(0, 16)}`
}

function relPathOf(workspace: string, absPath: string): string {
  const ws = workspace.replace(/\/+$/, '')
  if (absPath === ws) return ''
  return absPath.startsWith(ws + '/') ? absPath.slice(ws.length + 1) : absPath
}

function clip(text: string, max: number): string {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

function fmtTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
}

// ---------- A：任务账本候选（纯内存，零节点 IO） ----------

/** 从任务账本挑出本项目「未竟」的任务（D2：failed / partial_success / 卡死 running） */
export function taskCandidatesFor(tasks: WorkTask[], projectId: string, now = Date.now()): CollectCandidate[] {
  const out: CollectCandidate[] = []
  for (const t of tasks) {
    if (!t || t.projectId !== projectId) continue
    if (t.archivedAt) continue
    // backlog 派生的任务失败后不再回采（断自激环）
    if (t.backlogRef) continue
    const status = t.status
    if (status !== 'failed' && status !== 'partial_success' && status !== 'running') continue
    if (status === 'running' && now - Number(t.updatedAt || 0) <= STALE_RUNNING_MS) continue
    if (Number(t.updatedAt || 0) < now - TASK_LOOKBACK_MS) continue
    const reason = status === 'failed' ? 'failed' : status === 'partial_success' ? 'partial' : 'stale'
    const detail: string[] = [`任务：${t.id}（状态 ${status}，最后更新 ${fmtTime(t.updatedAt)}）`]
    const summary = t.summary
    if (summary) {
      if (summary.finalConclusion) detail.push(`结论：${clip(summary.finalConclusion, 300)}`)
      else if (summary.overview) detail.push(`概述：${clip(summary.overview, 300)}`)
      if (summary.coverage) detail.push(`成员返回覆盖度：${summary.coverage.completed}/${summary.coverage.total}（${summary.coverage.status}）`)
    } else {
      const last = [...(t.turns || [])].reverse().find((x) => x.role === 'agent' && x.text)
      if (last) detail.push(`最后输出：${clip(last.text, 300)}`)
    }
    detail.push(`关联会话：#/task/${t.id}`)
    out.push({
      key: `task:${t.id}`,
      source: 'task',
      title: `[任务] ${t.title || t.id}`,
      detail,
      labels: ['auto-collect', 'source-task', reason],
    })
  }
  return out
}

// ---------- B：工作区代码/文档扫描（确定性标记） ----------

export interface WorkspaceScanOptions {
  maxDepth?: number
  maxDirs?: number
  maxFiles?: number
  maxFileBytes?: number
  concurrency?: number
  maxMarkersPerFile?: number
}

export interface WorkspaceScanResult {
  candidates: CollectCandidate[]
  dirsScanned: number
  filesScanned: number
  filesSkipped: number
  truncated: boolean
}

interface WorkspaceFileEntry {
  path: string
  rel: string
  size?: number
  mtime?: number
}

/** 扫描项目工作区的代码/文档，找出明确标记的未竟事项（只认标记，不做语义猜测） */
export async function scanWorkspaceCandidates(
  client: DshClient,
  target: DshTarget,
  workspace: string,
  opts?: WorkspaceScanOptions,
): Promise<WorkspaceScanResult> {
  const maxDepth = Math.max(0, opts?.maxDepth ?? WS_MAX_DEPTH)
  const maxDirs = Math.max(1, opts?.maxDirs ?? WS_MAX_DIRS)
  const maxFiles = Math.max(1, opts?.maxFiles ?? WS_MAX_FILES)
  const maxFileBytes = Math.max(1024, opts?.maxFileBytes ?? WS_MAX_FILE_BYTES)
  const concurrency = Math.max(1, opts?.concurrency ?? WS_CONCURRENCY)
  const maxMarkersPerFile = Math.max(1, opts?.maxMarkersPerFile ?? WS_MAX_MARKERS_PER_FILE)
  const root = workspace.replace(/\/+$/, '')
  const files: WorkspaceFileEntry[] = []
  let dirsScanned = 0
  let filesSkipped = 0
  let truncated = false

  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  while (queue.length) {
    const cur = queue.shift()!
    if (dirsScanned >= maxDirs) { truncated = true; break }
    const listing = await client.fsList(target, cur.dir, true)
    if (!listing.ok || !listing.data) {
      // 根目录读不到 = 工作区不可用，向上抛（路由层转成明确错误）；子目录失败只跳过
      if (cur.depth === 0) throw new Error(listing.error || '工作区目录读取失败')
      continue
    }
    dirsScanned++
    if (listing.data.truncated) truncated = true
    for (const e of listing.data.entries || []) {
      const name = String(e.name || '')
      if (!name || name.startsWith('.')) continue
      const abs = e.path || `${cur.dir}/${name}`
      if (e.type === 'dir') {
        if (IGNORE_DIRS.has(name)) continue
        if (cur.depth + 1 > maxDepth) { truncated = true; continue }
        queue.push({ dir: abs, depth: cur.depth + 1 })
        continue
      }
      if (e.type === 'link') continue
      const ext = (/\.[^.]+$/.exec(name) || [''])[0].toLowerCase()
      if (!CODE_EXTS.has(ext) && !DOC_EXTS.has(ext)) continue
      if (IGNORE_FILE_RE.test(name)) { filesSkipped++; continue }
      if (typeof e.size === 'number' && e.size > maxFileBytes) { filesSkipped++; continue }
      const rel = relPathOf(root, abs)
      if (!rel) continue
      files.push({ path: abs, rel, size: typeof e.size === 'number' ? e.size : undefined, mtime: typeof e.mtime === 'number' ? e.mtime : undefined })
    }
  }

  // 新文件优先：按 mtime 降序（无 mtime 时保持目录序），只读前 maxFiles 个
  const sorted = files
    .map((f, i) => ({ f, i }))
    .sort((a, b) => ((b.f.mtime || 0) - (a.f.mtime || 0)) || (a.i - b.i))
    .map((x) => x.f)
  if (sorted.length > maxFiles) truncated = true
  const picked = sorted.slice(0, maxFiles)

  const candidates: CollectCandidate[] = []
  let filesScanned = 0
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, picked.length) }, async () => {
    while (next < picked.length) {
      const f = picked[next++]
      let text: string | undefined
      try {
        const dl = await client.fsDownload(target, f.path)
        if (!dl.ok || !dl.res) { filesSkipped++; continue }
        text = await dl.res.text()
      } catch {
        filesSkipped++
        continue
      }
      filesScanned++
      const found = parseWorkspaceMarkers(text, f.rel, { maxPerFile: maxMarkersPerFile })
      for (const c of found) {
        if (candidates.length >= MAX_CANDIDATES) { truncated = true; break }
        candidates.push({ ...c, filePath: f.rel, detail: [...c.detail, `文件修改时间：${fmtTime(f.mtime || 0)}`] })
      }
    }
  })
  await Promise.all(workers)

  return { candidates: candidates.slice(0, MAX_CANDIDATES), dirsScanned, filesScanned, filesSkipped, truncated }
}

/** 从一段文件文本里提取明确的未竟标记（代码注释标记 / 文档未勾选验收 / 文档状态标记） */
export function parseWorkspaceMarkers(
  text: string,
  relPath: string,
  opts?: { maxPerFile?: number },
): CollectCandidate[] {
  const out: CollectCandidate[] = []
  const maxPerFile = Math.max(1, opts?.maxPerFile ?? WS_MAX_MARKERS_PER_FILE)
  const isDoc = DOC_EXTS.has((/\.[^.]+$/.exec(relPath) || [''])[0].toLowerCase())
  const lines = String(text || '').split(/\r?\n/)
  // 跳过 Markdown 围栏代码块（``` / ~~~）：示例模板里的未勾选项不是真实事项
  let fence: string | null = null
  for (let i = 0; i < lines.length && out.length < maxPerFile; i++) {
    const raw = lines[i]
    if (!raw || raw.length > 400) continue
    const line = raw.trim()
    if (isDoc) {
      const fm = /^\s*(```+|~~~+)/.exec(raw)
      if (fm) {
        const marker = fm[1].slice(0, 3)
        if (!fence) fence = marker
        else if (fence === marker) fence = null
        continue
      }
      if (fence) continue
    }
    if (!line) continue
    if (isDoc) {
      const ac = /^[-*+]\s+\[\s\]\s+(.+)$/.exec(line)
      if (ac) {
        const text = clip(ac[1], 80)
        out.push({
          key: workspaceSourceKey('doc', relPath, text),
          source: 'doc',
          title: `[文档] ${relPath}: 未勾选验收：${text}`,
          detail: [`文件：${relPath}（第 ${i + 1} 行）`, `未勾选：${clip(ac[1], 200)}`],
          labels: ['auto-collect', 'source-doc', 'doc-marker'],
        })
        continue
      }
      const st = DOC_STATUS_RE.exec(line)
      if (st) {
        out.push({
          key: workspaceSourceKey('doc', relPath, line),
          source: 'doc',
          title: `[文档] ${relPath}: ${clip(line, 60)}`,
          detail: [`文件：${relPath}（第 ${i + 1} 行）`, `命中标记：${clip(line, 200)}`],
          labels: ['auto-collect', 'source-doc', 'doc-status'],
        })
      }
      continue
    }
    const isComment = COMMENT_PREFIX_RE.test(line)
    const en = CODE_MARKER_EN_RE.test(line)
    const cn = isComment && CODE_MARKER_CN_RE.test(line.replace(COMMENT_PREFIX_RE, ''))
    if (!en && !cn) continue
    const body = line.replace(COMMENT_PREFIX_RE, '')
    out.push({
      key: workspaceSourceKey('code', relPath, body),
      source: 'code',
      title: `[代码] ${relPath}: ${clip(body, 60)}`,
      detail: [`文件：${relPath}（第 ${i + 1} 行）`, `命中标记：${clip(body, 200)}`],
      labels: ['auto-collect', 'source-code', 'code-marker'],
    })
  }
  return out
}

// ---------- 预览 / 落盘 ----------

const previewCache = new Map<string, { at: number; data: CollectPreview }>()
const PREVIEW_TTL_MS = 10 * 60_000
const busyProjects = new Set<string>()

/** 清缓存（单测与「重新扫描」按钮用） */
export function clearCollectCache(projectId?: string): void {
  if (projectId) previewCache.delete(projectId)
  else previewCache.clear()
}

/** 候选预览：本项目任务账本 + 工作区扫描，过滤掉已登记过的 sourceKey */
export async function previewProjectCollect(
  client: DshClient,
  store: WorkStore,
  project: Project,
  target: DshTarget,
  workspace: string,
): Promise<CollectPreview> {
  const t0 = Date.now()
  const list = await listBacklog(client, target, workspace).catch((err: unknown) => {
    throw new Error(`backlog 目录读取失败：${String((err as Error)?.message || err)}`)
  })
  const known = new Set<string>()
  for (const it of list.items) for (const k of it.sourceKeys || []) known.add(k)

  const taskCandidates = taskCandidatesFor(store.getTasks(), project.id)
  let workspaceCandidates: CollectCandidate[] = []
  let scanError: string | undefined
  let dirsScanned = 0
  let filesScanned = 0
  let filesSkipped = 0
  let truncated = false
  try {
    const scan = await scanWorkspaceCandidates(client, target, workspace)
    workspaceCandidates = scan.candidates
    dirsScanned = scan.dirsScanned
    filesScanned = scan.filesScanned
    filesSkipped = scan.filesSkipped
    truncated = scan.truncated
  } catch (err: unknown) {
    scanError = String((err as Error)?.message || err)
  }

  const all = [...taskCandidates, ...workspaceCandidates]
  const fresh = all.filter((c) => !known.has(c.key))
  const data: CollectPreview = {
    projectId: project.id,
    projectName: project.name,
    initialized: list.initialized,
    candidates: fresh.slice(0, MAX_CANDIDATES),
    stats: {
      taskCandidates: taskCandidates.length,
      workspaceCandidates: workspaceCandidates.length,
      skippedKnown: all.length - fresh.length,
      dirsScanned,
      filesScanned,
      filesSkipped,
      truncated: truncated || fresh.length > MAX_CANDIDATES,
      ...(scanError ? { scanError } : {}),
      ms: Date.now() - t0,
    },
  }
  previewCache.set(project.id, { at: Date.now(), data })
  return data
}

async function previewOrFresh(
  client: DshClient,
  store: WorkStore,
  project: Project,
  target: DshTarget,
  workspace: string,
): Promise<CollectPreview> {
  const hit = previewCache.get(project.id)
  if (hit && Date.now() - hit.at < PREVIEW_TTL_MS) return hit.data
  return previewProjectCollect(client, store, project, target, workspace)
}

function candidateDescription(c: CollectCandidate): string {
  const head = c.source === 'task'
    ? '由「未完成事项采集（任务账本）」自动登记：'
    : '由「未完成事项采集（工作区扫描）」自动登记：'
  const lines = [`<!-- wb:source=${c.key} -->`, head, '', ...c.detail.map((d) => `- ${d}`)]
  if (c.filePath) lines.push(`- 定位：项目工作区 → 右侧栏文件树 → \`${c.filePath}\``)
  return lines.join('\n')
}

function candidateAcceptance(c: CollectCandidate): string[] {
  if (c.source === 'task') {
    return ['确认该任务的失败/中断根因（任务详情与执行记录可回看）', '修复后复跑任务或明确关闭，并回写本条待办状态']
  }
  if (c.source === 'code') {
    return ['确认该处标记是否仍需处理（保留 / 删除标记 / 转成正式待办）', '处理后同步删除或更新代码中的标记']
  }
  return ['确认该未勾选项/待确认内容是否仍需跟进', '处理后同步勾选或更新文档']
}

/**
 * 落盘：按预览候选（可用 keys 收窄）批量建 backlog 条目。
 * 幂等：sourceKey 已在条目正文里的候选不会再创建；并发保护：同项目同一时刻只允许一个 apply。
 */
export async function applyProjectCollect(
  client: DshClient,
  store: WorkStore,
  project: Project,
  target: DshTarget,
  workspace: string,
  keys?: string[],
): Promise<CollectApplyResult> {
  if (busyProjects.has(project.id)) throw new Error('该项目的采集正在执行，请稍候再试')
  busyProjects.add(project.id)
  try {
    const preview = await previewOrFresh(client, store, project, target, workspace)
    const wanted = keys && keys.length ? new Set(keys.map(String)) : null
    const selected = wanted ? preview.candidates.filter((c) => wanted.has(c.key)) : preview.candidates
    if (!selected.length) return { created: [], skippedKeys: [], candidates: preview.candidates.length }
    if (!preview.initialized) {
      await initBacklog(client, target, workspace, { projectName: project.name })
    }
    const runnable = selected.slice(0, MAX_APPLY_PER_RUN)
    const skippedKeys = selected.slice(MAX_APPLY_PER_RUN).map((c) => c.key)
    const created = await createItems(
      client,
      target,
      workspace,
      runnable.map((c) => ({
        title: clip(c.title, 120),
        description: candidateDescription(c),
        acceptance: candidateAcceptance(c),
        labels: c.labels,
      })),
    )
    previewCache.delete(project.id)
    return { created, skippedKeys, candidates: preview.candidates.length }
  } finally {
    busyProjects.delete(project.id)
  }
}
