/**
 * Backlog 查询引擎单测（docs/design-backlog-query-filters.md §2/§3/§7）。
 *
 * 逐条对照上游 Backlog.md `task list` 的过滤语义：status/excludeStatus/assignee/unassigned/
 * priority/type/labels/labelMatch/milestone/taskProject/parent/search/ready/blocked/openOnly/
 * sort/order/limit/maxCount/skip/count + facets + 参数解析/错误。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyBacklogQuery,
  backlogQueryToSearchParams,
  buildBacklogFacets,
  computeReadiness,
  countBacklogQuery,
  isClosedStatus,
  isTerminalStatus,
  matchesBacklogQuery,
  NO_MILESTONE_QUERY_VALUE,
  parseBacklogQuery,
  readinessOfItem,
  type BacklogQuery,
} from './backlog-query.js'
import type { BacklogItem } from './backlog.js'

const STATUSES = ['To Do', 'In Progress', 'Done']

/** 造条目：只给关心的字段，其余保持缺省 */
function mk(itemId: string, over: Partial<BacklogItem> = {}): BacklogItem {
  return {
    itemId,
    fileName: `${itemId}.md`,
    filePath: `backlog/tasks/${itemId}.md`,
    title: `标题 ${itemId}`,
    status: 'To Do',
    createdDate: '2026-01-01T00:00:00Z',
    searchText: `标题 ${itemId}`,
    ...over,
  }
}

/** 常见语料：覆盖优先级/类型/标签/指派/里程碑/组件/父任务 */
const CORPUS: BacklogItem[] = [
  mk('TASK-1', {
    title: '登录接口',
    status: 'To Do',
    priority: 'high',
    type: 'feature',
    labels: ['backend', 'p0'],
    assignees: ['@alice'],
    milestone: 'M-1',
    taskProject: 'web',
    parentTaskId: 'TASK-10',
    createdDate: '2026-01-01T00:00:00Z',
    ordinal: 1000,
    searchText: 'task-1\n登录接口\nto do\nhigh\nfeature\nbackend\np0\n@alice\nm-1\nweb\n需求描述原文 端到端链路验证 token 过期',
  }),
  mk('TASK-2', {
    title: '支付接入',
    status: 'In Progress',
    priority: 'medium',
    type: 'feature',
    labels: ['backend'],
    assignees: ['bob'],
    milestone: 'M-2',
    taskProject: 'api',
    createdDate: '2026-01-02T00:00:00Z',
    ordinal: 2000,
    searchText: 'task-2\n支付接入\nin progress\nmedium\nfeature\nbackend\nbob\nm-2\napi\n支付回调幂等',
  }),
  mk('TASK-3', {
    title: '修复崩溃',
    status: 'Done',
    priority: 'low',
    type: 'bug',
    labels: ['frontend'],
    milestone: 'M-1',
    createdDate: '2026-01-03T00:00:00Z',
    ordinal: 3000,
    searchText: 'task-3\n修复崩溃\ndone\nlow\nbug\nfrontend\nm-1\n崩溃栈',
  }),
  mk('TASK-4', {
    title: '依赖未完成',
    status: 'To Do',
    priority: 'high',
    labels: ['backend', 'p0'],
    dependencies: ['TASK-2'],
    createdDate: '2026-01-04T00:00:00Z',
    ordinal: 4000,
    searchText: 'task-4\n依赖未完成\nto do\nhigh\nbackend\np0\ntask-2',
  }),
  mk('TASK-5', {
    title: '依赖已完成',
    status: 'To Do',
    dependencies: ['TASK-3'],
    createdDate: '2026-01-05T00:00:00Z',
    ordinal: 5000,
    searchText: 'task-5\n依赖已完成\nto do\ntask-3',
  }),
  mk('TASK-6', {
    title: '依赖缺失',
    status: 'To Do',
    dependencies: ['TASK-404'],
    createdDate: '2026-01-06T00:00:00Z',
    ordinal: 6000,
    searchText: 'task-6\n依赖缺失\nto do\ntask-404',
  }),
  mk('TASK-10', {
    title: '父任务',
    status: 'In Progress',
    createdDate: '2026-01-07T00:00:00Z',
    searchText: 'task-10\n父任务\nin progress',
  }),
]

const ids = (items: Array<{ itemId: string }>): string[] => items.map((x) => x.itemId)
const run = (query: BacklogQuery, items: BacklogItem[] = CORPUS): string[] =>
  ids(applyBacklogQuery(items, query, { statuses: STATUSES }).items)

// ---------------------------------------------------------------- 参数解析

test('parseBacklogQuery: URLSearchParams 重复参数与逗号分隔都支持（同上游 CLI）', () => {
  const q = new URLSearchParams()
  q.append('status', 'To Do')
  q.append('status', 'In Progress')
  q.append('priority', 'high,medium')
  q.append('labels', 'backend')
  q.append('labels', 'p0')
  const parsed = parseBacklogQuery(q)
  assert.deepEqual(parsed.errors, [])
  assert.deepEqual(parsed.query.status, ['To Do', 'In Progress'])
  assert.deepEqual(parsed.query.priority, ['high', 'medium'])
  assert.deepEqual(parsed.query.labels, ['backend', 'p0'])
})

test('parseBacklogQuery: kebab-case 与旧参数别名', () => {
  const q = new URLSearchParams('exclude-status=Done&max-count=5&orderBy=priority&order=asc&includeDone=0&project=web')
  const parsed = parseBacklogQuery(q)
  assert.deepEqual(parsed.errors, [])
  assert.deepEqual(parsed.query.excludeStatus, ['Done'])
  assert.equal(parsed.query.maxCount, 5)
  assert.equal(parsed.query.sort, 'priority')
  assert.equal(parsed.query.order, 'asc')
  assert.equal(parsed.query.openOnly, true, 'includeDone=false ≡ openOnly')
  assert.deepEqual(parsed.query.taskProject, ['web'], '--project 映射到 frontmatter 组件名')
})

test('parseBacklogQuery: 对象入参（工具通道 JSON）支持数组/布尔/数字', () => {
  const parsed = parseBacklogQuery({
    status: ['To Do'],
    unassigned: true,
    ready: 'true',
    limit: 10,
    sort: 'id',
    order: 'desc',
  })
  assert.deepEqual(parsed.errors, [])
  assert.deepEqual(parsed.query.status, ['To Do'])
  assert.equal(parsed.query.unassigned, true)
  assert.equal(parsed.query.ready, true)
  assert.equal(parsed.query.limit, 10)
  assert.equal(parsed.query.sort, 'id')
})

test('parseBacklogQuery: 非法值报错（调用方转 400 / ok:false）', () => {
  assert.match(parseBacklogQuery(new URLSearchParams('assignee=a&unassigned=1')).errors.join(), /不能同时使用/)
  assert.match(parseBacklogQuery(new URLSearchParams('limit=0')).errors.join(), /limit/)
  assert.match(parseBacklogQuery(new URLSearchParams('skip=-1')).errors.join(), /skip/)
  assert.match(parseBacklogQuery(new URLSearchParams('maxCount=abc')).errors.join(), /maxCount/)
  assert.match(parseBacklogQuery(new URLSearchParams('order=up')).errors.join(), /order/)
  assert.match(parseBacklogQuery(new URLSearchParams('labelMatch=some')).errors.join(), /labelMatch/)
  assert.match(parseBacklogQuery(new URLSearchParams('parent=')).errors.join(), /parent/)
  assert.deepEqual(parseBacklogQuery(new URLSearchParams('sort=whatever')).errors, [], '非法 sort 宽松回退')
})

test('parseBacklogQuery → backlogQueryToSearchParams 可回环', () => {
  const original: BacklogQuery = {
    status: ['To Do'],
    excludeStatus: ['Done'],
    assignee: ['@alice'],
    priority: ['high'],
    type: ['bug'],
    labels: ['backend', 'p0'],
    labelMatch: 'all',
    milestone: 'M-1',
    taskProject: ['web'],
    parent: 'TASK-10',
    search: '登录 超时',
    ready: true,
    sort: 'priority',
    order: 'asc',
    limit: 20,
    skip: 5,
  }
  const qs = backlogQueryToSearchParams(original)
  const parsed = parseBacklogQuery(new URLSearchParams(qs))
  assert.deepEqual(parsed.errors, [])
  assert.deepEqual(parsed.query.status, original.status)
  assert.deepEqual(parsed.query.excludeStatus, original.excludeStatus)
  assert.deepEqual(parsed.query.assignee, original.assignee)
  assert.deepEqual(parsed.query.priority, original.priority)
  assert.deepEqual(parsed.query.type, original.type)
  assert.deepEqual(parsed.query.labels, original.labels)
  assert.equal(parsed.query.milestone, original.milestone)
  assert.deepEqual(parsed.query.taskProject, original.taskProject)
  assert.equal(parsed.query.parent, original.parent)
  assert.equal(parsed.query.search, original.search)
  assert.equal(parsed.query.ready, true)
  assert.equal(parsed.query.sort, 'priority')
  assert.equal(parsed.query.order, 'asc')
  assert.equal(parsed.query.limit, 20)
  assert.equal(parsed.query.skip, 5)
})

// ---------------------------------------------------------------- 分类过滤

test('status / excludeStatus：多值并集、大小写不敏感、排除优先', () => {
  assert.deepEqual(run({ status: ['to do'] }), ['TASK-6', 'TASK-5', 'TASK-4', 'TASK-1'])
  assert.deepEqual(run({ status: ['To Do', 'In Progress'] }).sort(), ['TASK-1', 'TASK-10', 'TASK-2', 'TASK-4', 'TASK-5', 'TASK-6'])
  assert.deepEqual(run({ excludeStatus: ['Done', 'In Progress'] }).sort(), ['TASK-1', 'TASK-4', 'TASK-5', 'TASK-6'])
  assert.deepEqual(run({ status: ['To Do'], excludeStatus: ['To Do'] }), [], '同时给时排除优先（交集为空）')
})

test('assignee / unassigned：包含匹配（忽略 @ 前缀），未指派单独过滤', () => {
  assert.deepEqual(run({ assignee: ['alice'] }), ['TASK-1'])
  assert.deepEqual(run({ assignee: ['@alice'] }), ['TASK-1'])
  assert.deepEqual(run({ assignee: ['BOB'] }), ['TASK-2'])
  assert.deepEqual(run({ unassigned: true }).sort(), ['TASK-10', 'TASK-3', 'TASK-4', 'TASK-5', 'TASK-6'])
})

test('priority / type：多值并集（归一化 lower）', () => {
  assert.deepEqual(run({ priority: ['HIGH'] }).sort(), ['TASK-1', 'TASK-4'])
  assert.deepEqual(run({ priority: ['high', 'low'] }).sort(), ['TASK-1', 'TASK-3', 'TASK-4'])
  assert.deepEqual(run({ type: ['BUG'] }), ['TASK-3'])
  assert.deepEqual(run({ type: ['feature', 'bug'] }).sort(), ['TASK-1', 'TASK-2', 'TASK-3'])
})

test('labels：缺省 AND（上游 --labels），labelMatch=any 为扩展', () => {
  assert.deepEqual(run({ labels: ['backend', 'p0'] }).sort(), ['TASK-1', 'TASK-4'])
  assert.deepEqual(run({ labels: ['backend', 'p0'], labelMatch: 'any' }).sort(), ['TASK-1', 'TASK-2', 'TASK-4'])
  assert.deepEqual(run({ labels: ['BACKEND'] }).sort(), ['TASK-1', 'TASK-2', 'TASK-4'])
})

test('milestone：精确 id/标题、数字别名 m-8/8、包含匹配、__none__', () => {
  assert.deepEqual(run({ milestone: 'M-1' }).sort(), ['TASK-1', 'TASK-3'])
  assert.deepEqual(run({ milestone: 'm-1' }).sort(), ['TASK-1', 'TASK-3'])
  assert.deepEqual(run({ milestone: NO_MILESTONE_QUERY_VALUE }).sort(), ['TASK-10', 'TASK-4', 'TASK-5', 'TASK-6'])
  const withNum = [...CORPUS, mk('TASK-7', { milestone: 'M-8', searchText: 'x' })]
  assert.deepEqual(run({ milestone: '8' }, withNum), ['TASK-7'], '数字别名按 id 匹配')
  assert.deepEqual(run({ milestone: 'm-08' }, withNum), ['TASK-7'])
  assert.deepEqual(run({ milestone: 'm-2' }).sort(), ['TASK-2'])
  // 标题包含（上游最近匹配的确定性降级）
  const withTitle = [...CORPUS, mk('TASK-8', { milestone: '登录改造 2026Q1', searchText: 'x' })]
  assert.deepEqual(run({ milestone: '2026Q1' }, withTitle), ['TASK-8'])
})

test('taskProject（frontmatter project）与 parent（子任务）过滤', () => {
  assert.deepEqual(run({ taskProject: ['web'] }), ['TASK-1'])
  assert.deepEqual(run({ parent: 'task-10' }), ['TASK-1'])
  assert.deepEqual(run({ parent: 'TASK-99' }), [])
})

test('search：标题/正文/metadata 子串、空白切词全部命中、大小写不敏感', () => {
  assert.deepEqual(run({ search: '登录接口' }), ['TASK-1'])
  assert.deepEqual(run({ search: 'token 过期' }), ['TASK-1'], '正文里的多个词 AND')
  assert.deepEqual(run({ search: '端到端' }), ['TASK-1'], '正文命中（标题不含该词）')
  assert.deepEqual(run({ search: 'backend' }).sort(), ['TASK-1', 'TASK-2', 'TASK-4'], 'metadata（标签）命中')
  assert.deepEqual(run({ search: '@ALICE' }), ['TASK-1'], 'metadata（指派人）命中且大小写不敏感')
  assert.deepEqual(run({ search: '不存在的词' }), [])
})

test('openOnly：按状态配置排除已关闭（done/完成/cancel/取消/末位）', () => {
  assert.deepEqual(run({ openOnly: true }).sort(), ['TASK-1', 'TASK-10', 'TASK-2', 'TASK-4', 'TASK-5', 'TASK-6'])
  assert.equal(isClosedStatus('Done', STATUSES), true)
  assert.equal(isClosedStatus('Cancelled', ['Todo', 'Doing', 'Done', 'Cancelled']), true)
  assert.equal(isClosedStatus('已取消', STATUSES), true)
  assert.equal(isClosedStatus('To Do', STATUSES), false)
  assert.equal(isTerminalStatus('Cancelled', ['Todo', 'Doing', 'Done', 'Cancelled']), true)
})

// ---------------------------------------------------------------- 就绪 / 阻塞

test('ready：无依赖=就绪、依赖已完成=就绪、依赖未完成=阻塞、依赖缺失=阻塞（fail-closed）', () => {
  const ready = run({ ready: true }).sort()
  assert.deepEqual(ready, ['TASK-1', 'TASK-10', 'TASK-2', 'TASK-5'])
  const blocked = run({ blocked: true }).sort()
  assert.deepEqual(blocked, ['TASK-4', 'TASK-6'])
})

test('ready：终态条目既非 ready 也非 blocked；未知依赖计入 missingDependencies', () => {
  const map = computeReadiness(CORPUS, STATUSES)
  assert.deepEqual(map.get('TASK-3'), { isReady: false, blocked: false, blockingDependencies: [], missingDependencies: [] })
  assert.deepEqual(map.get('TASK-4'), { isReady: false, blocked: true, blockingDependencies: ['TASK-2'], missingDependencies: [] })
  assert.deepEqual(map.get('TASK-6'), { isReady: false, blocked: true, blockingDependencies: [], missingDependencies: ['TASK-404'] })
  assert.deepEqual(map.get('TASK-5'), { isReady: true, blocked: false, blockingDependencies: [], missingDependencies: [] })
})

test('ready/blocked 判定不受其它过滤条件影响（deps 语料必须是全量）', () => {
  // 只看 TASK-5 子集：依赖 TASK-3 不在语料里 → fail-closed 阻塞
  const subset = CORPUS.filter((x) => x.itemId === 'TASK-5')
  assert.deepEqual(run({ ready: true }, subset), [])
  // 全量语料 + 只显示 To Do：TASK-5 仍就绪
  assert.deepEqual(run({ ready: true, status: ['To Do'] }).sort(), ['TASK-1', 'TASK-5'])
})

test('重复 ID 的依赖解析 fail-closed（歧义 = 未知）', () => {
  const dup = [mk('TASK-1', { status: 'Done', searchText: 'x' }), mk('TASK-1', { status: 'To Do', searchText: 'y' }), mk('TASK-9', { dependencies: ['TASK-1'], searchText: 'z' })]
  const map = computeReadiness(dup, STATUSES)
  assert.deepEqual(map.get('TASK-9')?.missingDependencies, ['TASK-1'])
  assert.equal(map.get('TASK-9')?.blocked, true)
})

test('readinessOfItem / matchesBacklogQuery 单条判定可用', () => {
  const r = readinessOfItem(CORPUS[3], CORPUS, STATUSES) // TASK-4
  assert.equal(r.blocked, true)
  assert.equal(matchesBacklogQuery(CORPUS[3], { blocked: true }, { statuses: STATUSES, readiness: r }), true)
  assert.equal(matchesBacklogQuery(CORPUS[3], { ready: true }, { statuses: STATUSES, readiness: r }), false)
})

// ---------------------------------------------------------------- 排序 / 窗口 / 计数

test('sort：priority（asc=高→低）/ id / ordinal / createdAt / updatedAt / status + 方向', () => {
  assert.deepEqual(run({ sort: 'priority', order: 'asc' }).slice(0, 2), ['TASK-1', 'TASK-4'])
  assert.deepEqual(run({ sort: 'priority', order: 'desc' }).slice(0, 2), ['TASK-10', 'TASK-6'], 'desc=低→高；未设置优先级（权重最大）排最前')
  assert.deepEqual(run({ sort: 'id', order: 'asc' }).slice(0, 3), ['TASK-1', 'TASK-2', 'TASK-3'])
  assert.deepEqual(run({ sort: 'id', order: 'desc' }).slice(0, 2), ['TASK-10', 'TASK-6'])
  assert.deepEqual(run({ sort: 'ordinal', order: 'asc' }).slice(0, 2), ['TASK-1', 'TASK-2'])
  assert.deepEqual(run({ sort: 'createdAt', order: 'desc' }).slice(0, 2), ['TASK-10', 'TASK-6'])
  assert.deepEqual(run({ sort: 'status', order: 'asc' }).slice(0, 1), ['TASK-1'])
  assert.deepEqual(run({ sort: 'status', order: 'desc' }).slice(0, 1), ['TASK-3'], 'Done 在配置顺序末位')
  // id 数字段：task-2 < task-10（不是字典序）
  const numeric = [mk('task-10', { searchText: 'x' }), mk('task-2', { searchText: 'y' })]
  assert.deepEqual(run({ sort: 'id', order: 'asc' }, numeric), ['task-2', 'task-10'])
})

test('window：limit/maxCount/skip 在排序后应用，window 字段完整', () => {
  // limit 先截断（3 条）→ 再 skip 1 → 剩 2 条（上游 runTaskList 顺序）
  const r = applyBacklogQuery(CORPUS, { sort: 'id', order: 'asc', limit: 3, skip: 1 }, { statuses: STATUSES })
  assert.deepEqual(ids(r.items), ['TASK-2', 'TASK-3'])
  assert.equal(r.matched, 7, 'matched = 过滤后总数，不受 limit/skip 影响')
  assert.deepEqual(r.window, { skip: 1, total: 7, nextSkip: null, cut: true, shown: 2 })
  const paged = applyBacklogQuery(CORPUS, { sort: 'id', order: 'asc', maxCount: 3, skip: 1 }, { statuses: STATUSES })
  assert.deepEqual(ids(paged.items), ['TASK-2', 'TASK-3', 'TASK-4'])
  assert.deepEqual(paged.window, { skip: 1, total: 7, nextSkip: 4, cut: true, shown: 3 })
  const last = applyBacklogQuery(CORPUS, { sort: 'id', order: 'asc', skip: 5 }, { statuses: STATUSES })
  assert.equal(last.window.nextSkip, null)
  assert.equal(last.window.cut, true, 'skip>0 时前面的条目被窗口留下，cut 仍为 true（同上游）')
  // limit 与 maxCount 同时给 → 先 limit 截断，再窗口（上游顺序，不会越出 limit）
  const cap = applyBacklogQuery(CORPUS, { limit: 5, maxCount: 2 }, { statuses: STATUSES })
  assert.equal(cap.items.length, 2)
  const mixed = applyBacklogQuery(CORPUS, { sort: 'id', order: 'asc', limit: 3, skip: 1 }, { statuses: STATUSES })
  assert.deepEqual(ids(mixed.items), ['TASK-2', 'TASK-3'], 'limit 先截断到 3 条，再 skip 1 → 2 条')
  assert.equal(mixed.window.nextSkip, null)
  assert.equal(mixed.matched, 7, 'matched 统计不受 limit 影响')
})

test('count=1：只返回计数（条目为空，窗口不生效）', () => {
  const r = applyBacklogQuery(CORPUS, { count: true, ready: true }, { statuses: STATUSES })
  assert.deepEqual(r.items, [])
  assert.equal(r.matched, 4)
  assert.equal(r.counts.ready, 4)
  assert.equal(r.counts.open, 6)
  assert.equal(r.counts.done, 1)
  assert.equal(r.counts.blocked, 2)
  assert.equal(r.counts.unassigned, 5)
  const counted = countBacklogQuery(CORPUS, { ready: true }, { statuses: STATUSES })
  assert.equal(counted.matched, 4)
  assert.equal(counted.ready, 4)
})

test('facets：维度取值 + 计数（按未过滤语料），状态按配置顺序', () => {
  const facets = buildBacklogFacets(CORPUS, STATUSES)
  assert.deepEqual(
    facets.statuses.map((x) => x.value),
    ['To Do', 'In Progress', 'Done'],
  )
  assert.equal(facets.statuses[0].count, 4)
  assert.deepEqual(
    facets.priorities.map((x) => x.value),
    ['high', 'medium', 'low'],
  )
  assert.deepEqual(facets.labels.map((x) => x.value).sort(), ['backend', 'frontend', 'p0'])
  assert.deepEqual(facets.assignees.map((x) => x.value), ['@alice', 'bob'])
  assert.deepEqual(facets.types.map((x) => x.value).sort(), ['bug', 'feature'])
  assert.deepEqual(facets.milestones.map((x) => x.value), ['M-1', 'M-2'])
  assert.deepEqual(facets.taskProjects.map((x) => x.value), ['api', 'web'])
})

test('applyBacklogQuery 不修改入参（纯函数）', () => {
  const snapshot = JSON.stringify(CORPUS)
  applyBacklogQuery(CORPUS, { ready: true, sort: 'priority', order: 'asc' }, { statuses: STATUSES })
  assert.equal(JSON.stringify(CORPUS), snapshot)
})
