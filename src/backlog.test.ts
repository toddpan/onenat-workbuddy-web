/**
 * Backlog 数据层单测（B1）。
 *
 * 覆盖：config.yml 子集解析、完成/进行中状态判定、frontmatter 保真编解码
 * （未知字段与顺序保留、块列表位移正确性）、AC 进度计数、执行记录追加不动既有内容、
 * itemId 文件名解析与归一、乐观写冲突检测（内存假节点）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseConfigYml,
  resolveDoneStatus,
  resolveInProgressStatus,
  decodeFrontmatter,
  encodeFrontmatter,
  countAcceptance,
  appendExecutionRecord,
  hasExecutionRecord,
  parseAcceptanceEntries,
  setAcceptance,
  appendAcceptance,
  replaceAcceptance,
  itemIdFromFileName,
  normalizeItemId,
  slugifyTitle,
  writeItem,
  BacklogConflictError,
  listBacklog,
  findItem,
  probeBacklog,
  sortBacklogItems,
  sortBacklogItemsBy,
  parseBacklogOrderBy,
  parseBacklogOrder,
  backlogPriorityWeight,
} from './backlog.js'
import type { DshClient, DshTarget } from './remote-client.js'

const SAMPLE = `---
id: TASK-1
title: 搭建登录接口
status: To Do
assignee:
  - @alice
created_date: '2026-10-31T06:20:00Z'
updated_date: '2026-10-31T06:20:00Z'
labels:
  - backend
  - p0
dependencies:
  - task-0
custom_field: keep-me
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
需求描述原文
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 支持账号密码登录
- [x] #2 返回 JWT
<!-- AC:END -->
`

test('parseConfigYml: statuses 数组与缺省回退', () => {
  const cfg = parseConfigYml(`project_name: "演示"\ndefault_status: "In Progress"\nstatuses: ["To Do", "In Progress", "Done"]\ntask_prefix: task\n`)
  assert.deepEqual(cfg.statuses, ['To Do', 'In Progress', 'Done'])
  assert.equal(cfg.defaultStatus, 'In Progress')
  assert.equal(cfg.taskPrefix, 'task')
  const fallback = parseConfigYml('random: x')
  assert.deepEqual(fallback.statuses, ['To Do', 'In Progress', 'Done'])
  // default_status 不在 statuses 内时回退首位
  const bad = parseConfigYml('statuses: ["A", "B"]\ndefault_status: "Z"')
  assert.equal(bad.defaultStatus, 'A')
})

test('resolveDoneStatus/resolveInProgressStatus: 人读名不硬编码', () => {
  assert.equal(resolveDoneStatus(['To Do', 'In Progress', 'Done']), 'Done')
  assert.equal(resolveDoneStatus(['待办', '进行中', '已完成']), '已完成')
  assert.equal(resolveDoneStatus(['A', 'B']), 'B')
  assert.equal(resolveInProgressStatus(['To Do', 'In Progress', 'Done']), 'In Progress')
  assert.equal(resolveInProgressStatus(['待办', '进行中', '完成']), '进行中')
  assert.equal(resolveInProgressStatus(['Only']), undefined)
})

test('decodeFrontmatter: 声明字段解析与自定义字段保留', () => {
  const { fields } = decodeFrontmatter(SAMPLE)
  assert.equal(fields.id, 'TASK-1')
  assert.equal(fields.title, '搭建登录接口')
  assert.equal(fields.status, 'To Do')
  assert.deepEqual(fields.assignees, ['@alice'])
  assert.deepEqual(fields.labels, ['backend', 'p0'])
  assert.deepEqual(fields.dependencies, ['task-0'])
  assert.equal(fields.ordinal, 1000)
})

test('encodeFrontmatter: 只改目标字段，未知字段与顺序保留', () => {
  const out = encodeFrontmatter(SAMPLE, { status: 'Done', labels: ['backend'], updatedDate: '2026-10-31T07:00:00Z' })
  const { fields } = decodeFrontmatter(out)
  assert.equal(fields.status, 'Done')
  assert.deepEqual(fields.labels, ['backend'])
  assert.equal(fields.updatedDate, '2026-10-31T07:00:00Z')
  // 未触碰字段原值保留
  assert.equal(fields.id, 'TASK-1')
  assert.deepEqual(fields.assignees, ['@alice'])
  assert.deepEqual(fields.dependencies, ['task-0'])
  assert.equal(fields.ordinal, 1000)
  assert.equal(fields.createdDate, '2026-10-31T06:20:00Z')
  // 自定义字段与正文整段原样
  assert.match(out, /custom_field: keep-me/)
  assert.match(out, /需求描述原文/)
  assert.match(out, /- \[ \] #1 支持账号密码登录/)
  // 标签块收缩后，后续 dependencies 块仍解析正确（位移正确性）
  const order = out.indexOf('dependencies:')
  const labelsIdx = out.indexOf('labels:')
  assert.ok(labelsIdx > -1 && order > labelsIdx)
})

test('encodeFrontmatter: 缺失字段追加到 frontmatter 尾部', () => {
  const minimal = `---\nid: TASK-2\ntitle: t\nstatus: To Do\n---\n\n正文`
  const out = encodeFrontmatter(minimal, { priority: 'high', labels: ['x', 'y'] })
  const { fields } = decodeFrontmatter(out)
  assert.equal(fields.priority, 'high')
  assert.deepEqual(fields.labels, ['x', 'y'])
  assert.match(out, /^---\n/, '仍以 --- 开头')
  assert.match(out, /\n---\n\n正文$/)
})

test('countAcceptance: AC 段标记内计数，无标记回退全文', () => {
  assert.deepEqual(countAcceptance(SAMPLE), { total: 2, done: 1 })
  const noMarker = '- [ ] a\n- [x] b\n- [X] c\n'
  assert.deepEqual(countAcceptance(noMarker), { total: 3, done: 2 })
  assert.equal(countAcceptance('no boxes'), undefined)
})

test('appendExecutionRecord: 追加在文末且不动既有内容', () => {
  const out = appendExecutionRecord(SAMPLE, { time: '2026-10-31T08:00:00Z', title: '派发执行（成功）', lines: ['任务 wt-9 完成', '<结论摘要>'] })
  assert.ok(out.startsWith(SAMPLE.replace(/\n$/, '') + '\n') || out.startsWith(SAMPLE))
  assert.match(out, /### 2026-10-31T08:00:00Z 派发执行（成功）/)
  assert.match(out, /任务 wt-9 完成/)
  assert.ok(hasExecutionRecord(out))
  assert.ok(!hasExecutionRecord(SAMPLE))
})

test('parseAcceptanceEntries: 解析条目并保留勾选状态（兼容 #n 与无编号）', () => {
  assert.deepEqual(parseAcceptanceEntries(SAMPLE), [
    { text: '支持账号密码登录', done: false },
    { text: '返回 JWT', done: true },
  ])
  // 上游手写格式（无 #n）同样解析；[X] 视为已勾选
  assert.deepEqual(parseAcceptanceEntries('<!-- AC:BEGIN -->\n- [X] a\n- [ ] b\n<!-- AC:END -->\n'), [
    { text: 'a', done: true },
    { text: 'b', done: false },
  ])
  assert.deepEqual(parseAcceptanceEntries('没有验收段'), [])
})

test('setAcceptance: 按文本匹配保留旧勾选、新增项默认未勾选、序号重编', () => {
  // 既有 #2「返回 JWT」已勾选 → 重排后仍保留勾选
  const kept = setAcceptance(SAMPLE, [
    { text: '返回 JWT', done: false },
    { text: '支持账号密码登录', done: false },
    { text: '新增一项', done: false },
  ])
  assert.match(kept, /- \[x\] #1 返回 JWT/)
  assert.match(kept, /- \[ \] #2 支持账号密码登录/)
  assert.match(kept, /- \[ \] #3 新增一项/)
  // 只重写 AC 段：正文与段标记原样保留
  assert.match(kept, /<!-- SECTION:DESCRIPTION:BEGIN -->\n需求描述原文\n<!-- SECTION:DESCRIPTION:END -->/)
  assert.deepEqual(countAcceptance(kept), { total: 3, done: 1 })
  // 无 AC 段的文件：追加一整段（含段标记）
  const appended = setAcceptance('# 标题\n\n正文\n', [{ text: 'a', done: false }])
  assert.match(appended, /<!-- AC:BEGIN -->\n- \[ \] #1 a\n<!-- AC:END -->/)
})

test('replaceAcceptance: 整体替换时全部重置为未勾选（编辑抽屉语义）', () => {
  // 用**既有已勾选文本**替换，验证抽屉路径确实不继承旧勾选（否则该回归测不出来）
  const out = replaceAcceptance(SAMPLE, ['返回 JWT'])
  assert.deepEqual(countAcceptance(out), { total: 1, done: 0 })
  assert.match(out, /- \[ \] #1 返回 JWT/)
})

test('setAcceptance: 保留 AC 段内无法识别的行（缩进续行 / 星号列表 / 说明文字）', () => {
  const raw = [
    '---', 'id: TASK-9', 'title: t', 'status: To Do', '---', '',
    '## Acceptance Criteria',
    '<!-- AC:BEGIN -->',
    '- [ ] #1 支持登录',
    '  - 续行：必须覆盖 2FA',
    '* [ ] 星号项（上游手写格式）',
    '说明：这一行是给人看的',
    '<!-- AC:END -->',
    '',
  ].join('\n')
  const out = setAcceptance(raw, [{ text: '支持登录', done: false }, { text: '新增项', done: false }])
  assert.match(out, /- \[ \] #1 支持登录/)
  assert.match(out, /- \[ \] #2 新增项/)
  // 无法识别的三行原样保留（不静默丢字）
  assert.match(out, /  - 续行：必须覆盖 2FA/)
  assert.match(out, /\* \[ \] 星号项（上游手写格式）/)
  assert.match(out, /说明：这一行是给人看的/)
})

test('appendAcceptance: 追加不动既有任何行（只插新条目、序号接续）', () => {
  const out = appendAcceptance(SAMPLE, ['新增项 A'])
  // 既有两行完全不变（含已勾选的 [x]）
  assert.match(out, /- \[ \] #1 支持账号密码登录/)
  assert.match(out, /- \[x\] #2 返回 JWT/)
  assert.match(out, /- \[ \] #3 新增项 A/)
  assert.deepEqual(countAcceptance(out), { total: 3, done: 1 })
})

test('itemId: 文件名解析与大小写归一', () => {
  assert.equal(itemIdFromFileName('task-12 - fix-login.md'), 'task-12')
  assert.equal(itemIdFromFileName('readme.md'), undefined)
  assert.equal(normalizeItemId('task-12'), normalizeItemId('TASK-12'))
  assert.equal(slugifyTitle('验证 Backlog.md 本地部署'), '验证-Backlog.md-本地部署')
  assert.equal(slugifyTitle('a/b\\c'), 'abc')
})

// —— 内存假节点（fsList/fsDownload/fsUpload）——

function fakeClient(initialFiles: Record<string, string>) {
  const files = new Map<string, string>(Object.entries(initialFiles))
  const dirs = new Set<string>(
    Object.keys(initialFiles).flatMap((k) => {
      const parts = k.split('/')
      return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'))
    }),
  )
  const client = {
    async fsList(_t: DshTarget, dirPath?: string, all?: boolean) {
      const p = (dirPath || '').replace(/\/+$/, '')
      if (!dirs.has(p)) return { ok: false, error: `no such file or directory: ${p}` }
      // 真实 DSH 节点语义：无 all=1 时含文件目录也返回空 entries（QA 20261031 实测）
      if (!all) return { ok: true, data: { path: dirPath || '', home: '', entries: [], truncated: false } }
      const prefix = p + '/'
      const entries = [...files.keys()]
        .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
        .map((k) => ({ name: k.slice(prefix.length), path: k, type: 'file' as const, hidden: false }))
      return { ok: true, data: { path: dirPath || '', home: '', entries, truncated: false } }
    },
    async fsDownload(_t: DshTarget, filePath: string) {
      if (!files.has(filePath)) return { ok: false, error: 'no such file' }
      return { ok: true, res: new Response(files.get(filePath)!) }
    },
    async fsUpload(_t: DshTarget, destDir: string, list: Array<{ filename: string; data: Buffer }>) {
      const full = (n: string) => `${destDir.replace(/\/+$/, '')}/${n}`
      for (const f of list) {
        // 真实 DSH 节点语义：已存在文件名生成 -1 副本而非覆盖
        let name = f.filename
        if (files.has(full(name))) {
          const m = /^(.*?)(\.[^.]+)?$/.exec(name)!
          name = `${m[1]}-1${m[2] || ''}`
        }
        files.set(full(name), f.data.toString('utf8'))
      }
      return { ok: true, files: [] }
    },
    async fsRemove(_t: DshTarget, p: string) {
      if (!files.delete(p)) return { ok: false, error: 'no such file' }
      return { ok: true }
    },
    async fsMkdir() {
      return { ok: true }
    },
  }
  return { client: client as unknown as DshClient, files }
}

const WS = '/ws/demo'
const FILE_PATH = `${WS}/backlog/tasks/task-1 - t.md`

test('writeItem: 正常写回 + base 过期抛冲突 + 写后被篡改抛冲突', async () => {
  const { client, files } = fakeClient({ [FILE_PATH]: SAMPLE })
  const target: DshTarget = { baseUrl: 'http://x' }

  // 正常：基于现读内容改 status
  const r1 = await writeItem(client, target, WS, 'task-1 - t.md', (raw) => encodeFrontmatter(raw, { status: 'Done' }))
  assert.match(r1.raw, /status: Done/)
  assert.match(files.get(FILE_PATH)!, /status: Done/)

  // base 过期：调用方拿旧 base 写 → 预检冲突
  await assert.rejects(
    () => writeItem(client, target, WS, 'task-1 - t.md', (raw) => encodeFrontmatter(raw, { status: 'To Do' }), { base: SAMPLE }),
    BacklogConflictError,
  )

  // 写后验证：上传与读不一致（模拟并发第三方写入）→ 冲突
  const tamper = fakeClient({ [FILE_PATH]: SAMPLE })
  ;(tamper.client as unknown as { fsUpload: () => void }).fsUpload = function () {
    // 上传同时被第三方覆盖为别的内容
    tamper.files.set(FILE_PATH, '---\nid: TASK-1\ntitle: 被别人改了\n---\n')
    return Promise.resolve({ ok: true, files: [] })
  } as never
  await assert.rejects(() => writeItem(tamper.client, target, WS, 'task-1 - t.md', (raw) => raw), BacklogConflictError)
})

test('listBacklog: 目录枚举 + 逐文件解析 + 未初始化判定', async () => {
  const { client } = fakeClient({
    [`${WS}/backlog/tasks/task-1 - t.md`]: SAMPLE,
    [`${WS}/backlog/config.yml`]: 'statuses: ["To Do", "In Progress", "Done"]\ndefault_status: "To Do"\ntask_prefix: task\n',
  })
  const target: DshTarget = { baseUrl: 'http://x' }
  const list = await listBacklog(client, target, WS)
  assert.equal(list.initialized, true)
  assert.equal(list.items.length, 1)
  assert.equal(list.items[0].itemId, 'TASK-1')
  assert.deepEqual(list.items[0].acceptance, { total: 2, done: 1 })

  const empty = fakeClient({})
  const none = await listBacklog(empty.client, target, WS)
  assert.equal(none.initialized, false)
  assert.equal(none.items.length, 0)
  assert.equal(await probeBacklog(empty.client, target, WS), false)
  assert.equal(await probeBacklog(client, target, WS), true)
})

test('findItem: 重复 itemId 显式报错，不再静默取第一个（QA 20261101 错派根因）', async () => {
  const target: DshTarget = { baseUrl: 'http://x' }
  const dup = fakeClient({
    [`${WS}/backlog/tasks/task-1 - backlog条目接入-cmdk-全局检索.md`]: SAMPLE,
    [`${WS}/backlog/tasks/task-1 - todo-project-list-sorting.md`]: SAMPLE.replace('TASK-1', 'TASK-1'),
    [`${WS}/backlog/config.yml`]: 'statuses: ["To Do", "In Progress", "Done"]\ndefault_status: "To Do"\ntask_prefix: task\n',
  })
  await assert.rejects(
    () => findItem(dup.client, target, WS, 'TASK-1'),
    /待办 ID 重复/,
  )
  // 改号后可正常定位
  const fixed = fakeClient({
    [`${WS}/backlog/tasks/task-1 - t.md`]: SAMPLE,
    [`${WS}/backlog/config.yml`]: 'statuses: ["To Do", "In Progress", "Done"]\ndefault_status: "To Do"\ntask_prefix: task\n',
  })
  const found = await findItem(fixed.client, target, WS, 'task-1')
  assert.equal(found?.item.itemId, 'TASK-1')
})

// ---------- TASK-SORT-1：待办列表展示排序（状态 → 优先级 → 创建时间） ----------

test('backlogPriorityWeight: 常见写法归一，未识别/空值排最后', () => {
  assert.equal(backlogPriorityWeight('P0'), 0)
  assert.equal(backlogPriorityWeight('urgent'), 0)
  assert.equal(backlogPriorityWeight('High'), 1)
  assert.equal(backlogPriorityWeight('高'), 1)
  assert.equal(backlogPriorityWeight('medium'), 2)
  assert.equal(backlogPriorityWeight('low'), 3)
  assert.equal(backlogPriorityWeight('lowest'), 4)
  assert.equal(backlogPriorityWeight(undefined), 5)
  assert.equal(backlogPriorityWeight('随便写的'), 5)
})

test('sortBacklogItems: 状态优先 → 优先级 → 创建时间；未知状态/优先级排尾；不改原数组', () => {
  const statuses = ['To Do', 'In Progress', 'Done']
  const mk = (itemId: string, over: Partial<{ status: string; priority: string; createdDate: string }> = {}) => ({ itemId, ...over })
  const input = [
    mk('TASK-4', { status: 'In Progress', priority: 'low', createdDate: '2026-01-03' }),
    mk('TASK-2', { status: 'To Do', priority: 'P0', createdDate: '2026-01-02' }),
    mk('TASK-9', { status: 'Done', priority: 'P0', createdDate: '2026-01-01' }),
    mk('TASK-1', { status: 'To Do', priority: 'high', createdDate: '2026-01-05' }),
    mk('TASK-3', { status: 'To Do', priority: 'high', createdDate: '2026-01-01' }),
    mk('TASK-5', { status: '随便', priority: 'P0', createdDate: '2026-01-01' }),
    mk('TASK-6', { status: 'In Progress', priority: 'P0', createdDate: '2026-01-04' }),
  ]
  const sorted = sortBacklogItems(input, statuses)
  assert.deepEqual(
    sorted.map((x) => x.itemId),
    // To Do(P0 → high，同优先级创建早在前) → In Progress → Done → 未收录状态
    ['TASK-2', 'TASK-3', 'TASK-1', 'TASK-6', 'TASK-4', 'TASK-9', 'TASK-5'],
  )
  assert.equal(input[0].itemId, 'TASK-4') // 原数组不被修改
})

test('listBacklog: 默认按创建时间倒序（最新在前；平级按 itemId 序号倒序兜底）——TASK-SORT-2 验收 #1', async () => {
  const target: DshTarget = { baseUrl: 'http://x' }
  const mk = (id: string, status: string, priority: string, createdDate: string) =>
    SAMPLE.replace('TASK-1', id)
      .replace(/status: .*/, `status: ${status}`)
      .replace(/created_date: .*/, `priority: ${priority}\ncreated_date: "${createdDate}"`)
  const { client } = fakeClient({
    [`${WS}/backlog/config.yml`]: 'statuses: ["To Do", "In Progress", "Done"]\ndefault_status: "To Do"\ntask_prefix: task\n',
    [`${WS}/backlog/tasks/task-1 - a.md`]: mk('TASK-1', 'Done', 'P0', '2026-01-01'),
    [`${WS}/backlog/tasks/task-2 - b.md`]: mk('TASK-2', 'To Do', 'low', '2026-01-01'),
    [`${WS}/backlog/tasks/task-3 - c.md`]: mk('TASK-3', 'To Do', 'P0', '2026-01-09'),
    [`${WS}/backlog/tasks/task-4 - d.md`]: mk('TASK-4', 'To Do', 'P0', '2026-01-02'),
  })
  const list = await listBacklog(client, target, WS)
  assert.deepEqual(list.items.map((x) => x.itemId), ['TASK-3', 'TASK-4', 'TASK-2', 'TASK-1'])
  // 显式 orderBy=priority 覆盖默认
  const byPri = await listBacklog(client, target, WS, { orderBy: 'priority', order: 'asc' })
  assert.deepEqual(byPri.items.map((x) => x.itemId), ['TASK-1', 'TASK-3', 'TASK-4', 'TASK-2'])
})

test('parseBacklogOrderBy / parseBacklogOrder: 非法与缺省回退默认（createdAt desc）', () => {
  assert.equal(parseBacklogOrderBy(), 'createdAt')
  assert.equal(parseBacklogOrderBy('PRIORITY'), 'priority')
  assert.equal(parseBacklogOrderBy('bogus'), 'createdAt')
  assert.equal(parseBacklogOrder(), 'desc')
  assert.equal(parseBacklogOrder('asc'), 'asc')
  assert.equal(parseBacklogOrder('nonsense'), 'desc')
})

test('sortBacklogItemsBy: 五种维度 × asc/desc（TASK-SORT-2 验收 #2）', () => {
  const statuses = ['To Do', 'In Progress', 'Done']
  const mk = (itemId: string, over: Partial<{ status: string; priority: string; createdDate: string; updatedDate: string; ordinal: number }>) => ({
    itemId,
    status: 'To Do',
    createdDate: '2026-01-01',
    ...over,
  })
  const items = [
    mk('TASK-1', { priority: 'P2', createdDate: '2026-01-03', updatedDate: '2026-02-01', ordinal: 3000 }),
    mk('TASK-2', { priority: 'P0', createdDate: '2026-01-02', updatedDate: '2026-01-05', ordinal: 1000 }),
    mk('TASK-3', { priority: 'P1', createdDate: '2026-01-04', ordinal: 2000 }),
    mk('TASK-4', { status: 'Done', priority: 'P3', createdDate: '2026-01-01' }),
  ]
  const ids = (xs: { itemId: string }[]) => xs.map((x) => x.itemId)
  // createdAt desc 默认（最新在前）
  assert.deepEqual(ids(sortBacklogItemsBy(items, statuses)), ['TASK-3', 'TASK-1', 'TASK-2', 'TASK-4'])
  assert.deepEqual(ids(sortBacklogItemsBy(items, statuses, 'createdAt', 'asc')), ['TASK-4', 'TASK-2', 'TASK-1', 'TASK-3'])
  // updatedAt：TASK-3 无 updatedDate 恒排尾
  assert.deepEqual(ids(sortBacklogItemsBy(items, statuses, 'updatedAt')), ['TASK-1', 'TASK-2', 'TASK-4', 'TASK-3'])
  // priority：P0→P1→P2→P3（asc）
  assert.deepEqual(ids(sortBacklogItemsBy(items, statuses, 'priority', 'asc')), ['TASK-2', 'TASK-3', 'TASK-1', 'TASK-4'])
  // status：按 statuses 配置顺序（asc）；desc 时 Done 在前
  assert.deepEqual(ids(sortBacklogItemsBy(items, statuses, 'status', 'asc')), ['TASK-1', 'TASK-2', 'TASK-3', 'TASK-4'])
  assert.deepEqual(ids(sortBacklogItemsBy(items, statuses, 'status', 'desc'))[0], 'TASK-4')
  // ordinal：1000→2000→3000（asc），缺 ordinal 的 TASK-4 恒排尾
  assert.deepEqual(ids(sortBacklogItemsBy(items, statuses, 'ordinal', 'asc')), ['TASK-2', 'TASK-3', 'TASK-1', 'TASK-4'])
  // 不改原数组
  assert.equal(items[0].itemId, 'TASK-1')
})

