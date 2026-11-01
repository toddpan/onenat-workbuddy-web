/**
 * 未竟事项采集（简版）单测：A 任务账本候选 / B 工作区标记扫描 / 去重 / 落盘幂等。
 * 只在内存 Fake DSH 节点上跑（无网络），覆盖设计文档 docs/design-backlog-auto-collect.md 的 M1 验收口径。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { DshClient, DshTarget } from './remote-client.js'
import type { WorkStore } from './store.js'
import type { Project, WorkTask } from './types.js'
import {
  applyProjectCollect,
  clearCollectCache,
  parseWorkspaceMarkers,
  previewProjectCollect,
  scanWorkspaceCandidates,
  taskCandidatesFor,
} from './backlog-collect.js'

const WS = '/ws/demo'
const TARGET: DshTarget = { baseUrl: 'http://fake' }
const PROJECT = { id: 'proj-1', name: '演示项目', dshRef: { kind: 'direct', apiBaseUrl: 'http://fake' } } as unknown as Project

const CONFIG_YML = 'statuses: ["To Do", "In Progress", "Done"]\ndefault_status: "To Do"\ntask_prefix: task\n'

// ---------- Fake DSH 节点：目录（含 mtime）+ 文件 ----------

interface FakeFile { text: string; mtime?: number; size?: number }

function fakeClient(initial: { files?: Record<string, FakeFile | string>; dirs?: string[] } = {}) {
  const files = new Map<string, FakeFile>()
  for (const [p, v] of Object.entries(initial.files || {})) files.set(p, typeof v === 'string' ? { text: v } : v)
  const dirs = new Set<string>(initial.dirs || [])
  const ensureDir = (d: string) => {
    const parts = d.split('/').filter(Boolean)
    for (let i = 1; i <= parts.length; i++) dirs.add('/' + parts.slice(0, i).join('/'))
  }
  dirs.forEach(ensureDir)
  for (const p of files.keys()) ensureDir(p.split('/').slice(0, -1).join('/') || '/')

  const dirOf = (p: string) => p.split('/').slice(0, -1).join('/') || '/'
  const client = {
    async fsList(_t: DshTarget, dirPath?: string, all?: boolean) {
      const p = (dirPath || '').replace(/\/+$/, '')
      if (!dirs.has(p)) return { ok: false, error: `no such file or directory: ${p}` }
      if (!all) return { ok: true, data: { path: dirPath || '', home: '', entries: [], truncated: false } }
      const entries: Array<{ name: string; path: string; type: 'dir' | 'file'; size?: number; mtime?: number; hidden: boolean }> = []
      for (const f of files.keys()) {
        if (dirOf(f) !== p) continue
        const name = f.split('/').pop()!
        const meta = files.get(f)!
        entries.push({ name, path: f, type: 'file', size: meta.size ?? meta.text.length, mtime: meta.mtime, hidden: name.startsWith('.') })
      }
      for (const d of dirs) {
        if (d === p || dirOf(d) !== p) continue
        entries.push({ name: d.split('/').pop()!, path: d, type: 'dir', mtime: Date.now(), hidden: (d.split('/').pop() || '').startsWith('.') })
      }
      entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1))
      return { ok: true, data: { path: dirPath || '', home: '', entries, truncated: false } }
    },
    async fsDownload(_t: DshTarget, filePath: string) {
      const f = files.get(filePath)
      if (!f) return { ok: false, error: 'no such file' }
      return { ok: true, res: new Response(f.text) }
    },
    async fsUpload(_t: DshTarget, destDir: string, list: Array<{ filename: string; data: Buffer }>) {
      const dir = destDir.replace(/\/+$/, '')
      ensureDir(dir)
      for (const f of list) {
        let name = f.filename
        if (files.has(`${dir}/${name}`)) {
          const m = /^(.*?)(\.[^.]+)?$/.exec(name)!
          name = `${m[1]}-1${m[2] || ''}`
        }
        files.set(`${dir}/${name}`, { text: f.data.toString('utf8'), mtime: Date.now() })
      }
      return { ok: true, files: [] }
    },
    async fsRemove(_t: DshTarget, p: string) {
      if (!files.delete(p) && !dirs.delete(p.replace(/\/+$/, ''))) return { ok: false, error: 'no such file' }
      return { ok: true }
    },
    async fsMkdir(_t: DshTarget, parent: string, name: string) {
      ensureDir(`${parent.replace(/\/+$/, '')}/${name}`)
      return { ok: true }
    },
  }
  return { client: client as unknown as DshClient, files }
}

function backlogFiles(extra: Record<string, FakeFile | string> = {}) {
  return { [`${WS}/backlog/config.yml`]: CONFIG_YML, ...extra }
}

function task(over: Partial<WorkTask>): WorkTask {
  return {
    id: 'wt-1',
    title: '修复登录 500',
    mode: 'chat',
    status: 'failed',
    memberAgentIds: [],
    turns: [],
    sessions: {},
    createdAt: Date.now() - 1000,
    updatedAt: Date.now() - 1000,
    projectId: 'proj-1',
    ...over,
  } as unknown as WorkTask
}

const storeOf = (tasks: WorkTask[]) => ({ getTasks: () => tasks }) as unknown as WorkStore

// ---------- A：任务账本候选 ----------

test('taskCandidatesFor: failed/partial/卡死 running 命中；成功、归档、backlog 派生、旧任务不采', () => {
  const now = Date.now()
  const tasks = [
    task({ id: 'wt-failed', status: 'failed' }),
    task({ id: 'wt-partial', status: 'partial_success' }),
    task({ id: 'wt-stale', status: 'running', updatedAt: now - 3 * 3600_000 }),
    task({ id: 'wt-fresh-running', status: 'running', updatedAt: now - 60_000 }),
    task({ id: 'wt-success', status: 'success' }),
    task({ id: 'wt-completed', status: 'completed' }),
    task({ id: 'wt-cancelled', status: 'cancelled' }),
    task({ id: 'wt-archived', status: 'failed', archivedAt: now }),
    task({ id: 'wt-from-backlog', status: 'failed', backlogRef: { projectId: 'proj-1', itemId: 'TASK-1', itemTitle: 'x', dispatchedAt: now } }),
    task({ id: 'wt-old', status: 'failed', updatedAt: now - 40 * 24 * 3600_000 }),
    task({ id: 'wt-other-project', status: 'failed', projectId: 'proj-2' }),
  ]
  const out = taskCandidatesFor(tasks, 'proj-1', now)
  assert.deepEqual(out.map((c) => c.key).sort(), ['task:wt-failed', 'task:wt-partial', 'task:wt-stale'])
  const partial = out.find((c) => c.key === 'task:wt-partial')!
  assert.match(partial.title, /\[任务\] 修复登录 500/)
  assert.ok(partial.labels.includes('partial'))
  assert.ok(partial.detail.some((d) => d.includes('#/task/wt-partial')))
})

// ---------- B：工作区标记扫描 ----------

test('parseWorkspaceMarkers: 代码标记 / 文档未勾选 / 文档状态标记；无标记文本不产生候选', () => {
  const code = [
    'const a = 1',
    // ↓ 以下两行为测试夹具标记（backlog 复核 task-26/task-27/task-32：解析器用例数据，非真实工程事项，勿据此登记）
    '// TODO 补充刷 token 的并发保护',
    'function f() { /* FIXME 未完成 */ }',
    '// 普通注释：以后再说',
  ].join('\n')
  const codeCands = parseWorkspaceMarkers(code, 'src/auth.ts')
  assert.equal(codeCands.length, 2)
  assert.equal(codeCands[0].source, 'code')
  assert.match(codeCands[0].title, /\[代码\] src\/auth\.ts: TODO 补充刷 token 的并发保护/)
  assert.equal(codeCands[0].labels.includes('source-code'), true)

  const doc = ['# 设计', '- [x] 已完成项', '- [ ] 未完成验收项', '状态：草稿', '普通段落'].join('\n')
  const docCands = parseWorkspaceMarkers(doc, 'docs/design.md')
  assert.equal(docCands.length, 2)
  assert.match(docCands[0].title, /未勾选验收：未完成验收项/)
  assert.match(docCands[1].title, /状态：草稿/)

  assert.equal(parseWorkspaceMarkers('hello\nworld', 'src/plain.ts').length, 0)
})

test('parseWorkspaceMarkers: 字符串/普通代码行里的中文「待办/未完成」不再误报（QA task-35），注释行仍命中', () => {
  const code = [
    "if (raw === undefined) throw new Error('待办文件读取失败')",
    'const title = \'未完成事项采集\'',
    'await listBacklog(client) // TODO 待办列表分页优化',
    '// 待补充：错误码对照表',
  ].join('\n')
  const cands = parseWorkspaceMarkers(code, 'src/backlog.ts')
  assert.equal(cands.length, 2)
  assert.match(cands[0].title, /TODO 待办列表分页优化/)
  assert.match(cands[1].title, /待补充：错误码对照表/)
})

test('parseWorkspaceMarkers: 围栏代码块内的标记跳过（backlog task-24：示例模板不误报）', () => {
  const doc = [
    '# 生成格式示例',
    '',
    '```markdown',
    '## Acceptance Criteria',
    '- [ ] #1 确认该任务的失败根因（示例模板，非真实待办）',
    '状态：草稿',
    '```',
    '',
    '- [ ] 真实未完成项',
    '~~~',
    '- [ ] 波浪线围栏内不算',
    '~~~',
  ].join('\n')
  const cands = parseWorkspaceMarkers(doc, 'docs/design.md')
  assert.equal(cands.length, 1)
  assert.match(cands[0].title, /未勾选验收：真实未完成项/)
})

test('parseWorkspaceMarkers: 采集器自身源码不自激（backlog code:b1c5dfa7 复核：正则定义行、标签字符串、说明注释都不是真实事项）', async () => {
  // 夹具：复刻采集器源码里曾自命中的两类「代码行」形态——标签常量里的裸 'todo'、
  // 说明字符串里的裸英文标记词（英文标记不限于注释行，字符串同样命中，QA 实证）
  const before = [
    "labels: ['auto-collect', 'source-code', 'todo'],",
    'return [\'确认该处 TODO/FIXME 是否仍需处理（保留 / 删除标记 / 转成正式待办）\']',
  ].join('\n')
  assert.equal(parseWorkspaceMarkers(before, 'src/old.ts').length, 2)

  // 修复后形态（backlog-collect.ts 现状）：标签改中性词、文案不裸写标记词 → 零候选
  const after = [
    "labels: ['auto-collect', 'source-code', 'code-marker'],",
    'return [\'确认该处标记是否仍需处理（保留 / 删除标记 / 转成正式待办）\']',
    'const CODE_MARKER_EN_RE = /\\bTODO\\b|\\bFIXME\\b|\\bXXX\\b|\\bHACK\\b/i',
    'const CODE_MARKER_CN_RE = /待办|待补充|未完成/',
    "// 本项目本身就是事项管理系统，中文关键词（见上）大量出现在标识符、UI 文案与错误消息里",
  ].join('\n')
  // 说明：中文关键词只在注释行才算、英文标记正则字面量受 \b 边界保护不会匹配自身
  assert.equal(parseWorkspaceMarkers(after, 'src/backlog-collect.ts').length, 0)

  // 真实自扫描：编译产物与源码注释一致，扫描自身模块文本必须零候选（防止未来编辑重新引入裸标记词）
  const { readFile } = await import('node:fs/promises')
  const self = await readFile(new URL('../src/backlog-collect.ts', import.meta.url), 'utf8')
  assert.equal(parseWorkspaceMarkers(self, 'backlog-collect.ts').length, 0)
})

test('sourceKey: 只依赖路径+标记文本，行号变化不影响（跨轮稳定）', () => {
  const a = parseWorkspaceMarkers('// TODO 补并发保护', 'src/auth.ts')[0]
  const b = parseWorkspaceMarkers('\n\n\n\n// TODO 补并发保护', 'src/auth.ts')[0]
  const c = parseWorkspaceMarkers('// TODO 补并发保护', 'src/other.ts')[0]
  assert.equal(a.key, b.key)
  assert.notEqual(a.key, c.key)
  assert.match(a.key, /^code:[0-9a-f]{16}$/)
})

test('scanWorkspaceCandidates: 忽略 node_modules/.git/backlog 与二进制/超大文件；truncated 标记目录触顶', async () => {
  const { client } = fakeClient({
    files: {
      [`${WS}/src/a.ts`]: { text: '// TODO 补并发保护', mtime: 2000 },
      [`${WS}/src/b.ts`]: { text: 'export const b = 1', mtime: 1000 },
      [`${WS}/docs/x.md`]: { text: '- [ ] 未完成验收项', mtime: 1500 },
      [`${WS}/node_modules/dep/index.js`]: { text: '// TODO 依赖里的标记不应采', mtime: 3000 },
      [`${WS}/.git/config`]: { text: 'TODO', mtime: 3000 },
      [`${WS}/backlog/tasks/task-9 - x.md`]: { text: '- [ ] backlog 自己的条目', mtime: 3000 },
      [`${WS}/images/logo.png`]: { text: 'TODO binary', mtime: 3000 },
      [`${WS}/src/huge.ts`]: { text: '// TODO', mtime: 3000, size: 10 * 1024 * 1024 },
    },
  })
  const out = await scanWorkspaceCandidates(client, TARGET, WS, { maxDepth: 3, maxDirs: 40, maxFiles: 50, maxFileBytes: 200_000 })
  const keys = out.candidates.map((c) => c.filePath).sort()
  assert.deepEqual(keys, ['docs/x.md', 'src/a.ts'])
  assert.equal(out.truncated, false)
  assert.ok(out.filesScanned >= 2)
  // 目录上限压到 1 → 只读根目录、结果截断
  const capped = await scanWorkspaceCandidates(client, TARGET, WS, { maxDirs: 1 })
  assert.equal(capped.dirsScanned, 1)
  assert.equal(capped.truncated, true)
})

test('scanWorkspaceCandidates: 节点不返回 mtime 时仍能扫描（不做时间窗）', async () => {
  const { client } = fakeClient({ files: { [`${WS}/src/a.ts`]: { text: '// FIXME 未完成' } } })
  const out = await scanWorkspaceCandidates(client, TARGET, WS)
  assert.equal(out.candidates.length, 1)
})

// ---------- 预览 + 落盘（幂等） ----------

test('previewProjectCollect: 合并 A+B 候选；apply 落盘带 sourceKey；再次预览全部被判重', async () => {
  clearCollectCache()
  const { client, files } = fakeClient({
    files: backlogFiles({
      [`${WS}/src/a.ts`]: { text: '// TODO 补并发保护', mtime: 2000 },
      [`${WS}/docs/x.md`]: { text: '- [ ] 未完成验收项', mtime: 1500 },
    }),
  })
  const tasks = [task({ id: 'wt-failed', status: 'failed' })]
  const pv = await previewProjectCollect(client, storeOf(tasks), PROJECT, TARGET, WS)
  assert.equal(pv.initialized, false)
  assert.equal(pv.candidates.length, 3)
  assert.deepEqual(pv.candidates.map((c) => c.source).sort(), ['code', 'doc', 'task'])

  const created = await applyProjectCollect(client, storeOf(tasks), PROJECT, TARGET, WS)
  assert.equal(created.created.length, 3)
  assert.deepEqual(created.created.map((c) => c.itemId), ['task-1', 'task-2', 'task-3'])
  for (const it of created.created) {
    const raw = files.get(`${WS}/backlog/tasks/${it.fileName}`)!.text
    assert.match(raw, /<!-- wb:source=(task:wt-failed|code:[0-9a-f]{16}|doc:[0-9a-f]{16}) -->/)
    assert.match(raw, /- \[ \] #1 /)
  }

  // 再次预览：标记已存在 → 候选被过滤（幂等）
  clearCollectCache()
  const pv2 = await previewProjectCollect(client, storeOf(tasks), PROJECT, TARGET, WS)
  assert.equal(pv2.candidates.length, 0)
  assert.equal(pv2.stats.skippedKnown, 3)
  // 再落盘也不会新增
  const again = await applyProjectCollect(client, storeOf(tasks), PROJECT, TARGET, WS)
  assert.equal(again.created.length, 0)
})

test('previewProjectCollect: backlog 未初始化时自动跳过工作区标记也已登记过的（config 缺失容忍）', async () => {
  clearCollectCache()
  const { client } = fakeClient({ files: { [`${WS}/src/a.ts`]: '// TODO 补并发保护' } })
  const pv = await previewProjectCollect(client, storeOf([]), PROJECT, TARGET, WS)
  assert.equal(pv.initialized, false)
  assert.equal(pv.candidates.length, 1)
  const out = await applyProjectCollect(client, storeOf([]), PROJECT, TARGET, WS)
  assert.equal(out.created.length, 1)
  assert.match(out.created[0].title || '', /\[代码\] src\/a\.ts/)
})

test('applyProjectCollect: keys 收窄只建选中的条目', async () => {
  clearCollectCache()
  const { client } = fakeClient({
    files: backlogFiles({
      [`${WS}/src/a.ts`]: '// TODO 第一处',
      [`${WS}/src/b.ts`]: '// TODO 第二处',
    }),
  })
  const pv = await previewProjectCollect(client, storeOf([]), PROJECT, TARGET, WS)
  assert.equal(pv.candidates.length, 2)
  const only = pv.candidates[0].key
  const out = await applyProjectCollect(client, storeOf([]), PROJECT, TARGET, WS, [only])
  assert.equal(out.created.length, 1)
  assert.equal(out.skippedKeys.length, 0)
})
