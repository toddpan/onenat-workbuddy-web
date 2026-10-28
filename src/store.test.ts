/**
 * WorkStore 历史任务自动归档回归测试。
 *
 * 覆盖：超期终态任务的自动列表归档（archivedAt）+ 存储骨架化（bulkArchived + data/archive/），
 * 归档天数设置页配置（0 = 关闭、缺省回退环境变量）、取消归档后的周期宽限、重启重水合。
 * 注：写盘 await 窗口内的 mutation 竞态防护（updatedAt 比对）依赖真实异步时序，不易确定性构造，
 * 未在本文件覆盖（见 docs/feat-task-auto-archive.md）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkStore, isNodeAbsolutePath } from './store.js'
import type { WorkTask } from './types.js'

// —— 工作目录「节点侧绝对路径」判断（Windows DSH 节点兼容） ——
test('isNodeAbsolutePath: 接受 POSIX / Windows 盘符 / UNC 绝对路径', () => {
  for (const ok of ['/data/x/workspace', '/', '/a', 'C:\\work\\demo', 'C:/work/demo', 'd:/work', '\\\\server\\share', '//server/share', 'Z:\\tmp']) {
    assert.equal(isNodeAbsolutePath(ok), true, ok)
  }
})

test('isNodeAbsolutePath: 拒绝相对路径与无根盘符', () => {
  for (const bad of ['rel/path', './tmp', '../tmp', 'work', 'C:', 'c::\\x', '', '   ']) {
    assert.equal(isNodeAbsolutePath(bad), false, bad)
  }
})

// 测试进程内禁止构造函数自带的 30s 启动扫描（改由用例直接 await archiveSweep，保证确定性）
process.env.WORKBUDDY_ARCHIVE_BOOT_DELAY_MS = '3600000'

const DAY = 86_400_000

function makeStore(): { store: WorkStore; path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wb-store-test-'))
  const path = join(dir, 'store.json')
  return { store: new WorkStore(path), path, dir }
}

/** 白盒造任务：upsert 无条件刷新 updatedAt，超期时间须在 upsert 之后回写（写入的是 store 内同一活对象） */
function seedTask(store: WorkStore, partial: Partial<WorkTask>): WorkTask {
  const { updatedAt, ...rest } = partial
  const t = store.upsertTask({
    id: `task-${Math.random().toString(36).slice(2, 10)}`,
    title: 't',
    mode: 'chat',
    status: 'completed',
    memberAgentIds: [],
    turns: [{ id: 'turn-1', seq: 1, role: 'user', text: 'hello' }],
    sessions: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...rest,
  } as WorkTask)
  if (updatedAt !== undefined) t.updatedAt = updatedAt
  return t
}

/** 测试收尾：先同步 flush（放弃在途异步快照的 rename），再稍等在途 tmp 写入落地后清目录 */
async function cleanup(stores: WorkStore[], dir: string): Promise<void> {
  for (const s of stores) s.flush()
  await new Promise((r) => setTimeout(r, 50))
  rmSync(dir, { recursive: true, force: true })
}

test('超期终态任务：自动列表归档 + turns/taskLogs 骨架化 + 归档文件落盘', async () => {
  const { store, path, dir } = makeStore()
  try {
    const stale = seedTask(store, {
      status: 'completed',
      updatedAt: Date.now() - 8 * DAY,
      taskLogs: [{ id: 'log-1', at: Date.now(), level: 'info', text: 'x' } as any],
    })
    const n = await store.archiveSweep()
    assert.equal(n, 1)
    const t = store.getTask(stale.id)!
    assert.ok(t.archivedAt, '应设置 archivedAt（挪入「已归档会话」）')
    assert.ok(t.bulkArchived, '应设置 bulkArchived（存储瘦身）')
    assert.equal(t.turns.length, 1, '内存保持全量')
    // 归档文件包含正文
    const arc = JSON.parse(readFileSync(join(dir, 'archive', `${stale.id}.json`), 'utf-8'))
    assert.equal(arc.id, stale.id)
    assert.equal(arc.turns.length, 1)
    // 磁盘 store.json 只留骨架
    store.flush()
    const disk = JSON.parse(readFileSync(path, 'utf-8'))
    assert.equal(disk.tasks.find((x: WorkTask) => x.id === stale.id).turns.length, 0)
    // 重启重水合：内存恢复全量
    const store2 = new WorkStore(path)
    assert.equal(store2.getTask(stale.id)!.turns.length, 1)
    await cleanup([store, store2], dir)
  } catch (err) {
    store.flush()
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
})

test('运行中任务与未超期任务不被归档', async () => {
  const { store, dir } = makeStore()
  try {
    const running = seedTask(store, { status: 'running', updatedAt: Date.now() - 8 * DAY })
    const fresh = seedTask(store, { status: 'completed', updatedAt: Date.now() - 1 * DAY })
    const cancelled = seedTask(store, { status: 'cancelled', updatedAt: Date.now() - 8 * DAY, turns: [] })
    await store.archiveSweep()
    assert.ok(!running.archivedAt && !running.bulkArchived, '运行中不动')
    assert.ok(!fresh.archivedAt && !fresh.bulkArchived, '未超期不动')
    assert.ok(cancelled.archivedAt, '无正文可瘦身的超期终态任务仍应列表归档')
    assert.ok(!cancelled.bulkArchived, '无 turns/taskLogs 时不做存储瘦身')
  } finally {
    await cleanup([store], dir)
  }
})

test('归档天数 = 0 时关闭自动归档', async () => {
  const { store, dir } = makeStore()
  try {
    store.updateSettings({ archive: { taskArchiveDays: 0 } })
    seedTask(store, { status: 'completed', updatedAt: Date.now() - 365 * DAY })
    const n = await store.archiveSweep()
    assert.equal(n, 0)
    assert.ok(!store.getTasks()[0].archivedAt && !store.getTasks()[0].bulkArchived)
  } finally {
    await cleanup([store], dir)
  }
})

test('归档天数可在设置里调整并即时生效', async () => {
  const { store, dir } = makeStore()
  try {
    const t = seedTask(store, { status: 'failed', updatedAt: Date.now() - 2 * DAY })
    await store.archiveSweep()
    assert.ok(!t.archivedAt, '默认 7 天：2 天前不归档')
    store.updateSettings({ archive: { taskArchiveDays: 1 } })
    await store.archiveSweep()
    assert.ok(t.archivedAt && t.bulkArchived, '收窄到 1 天后立即归档')
  } finally {
    await cleanup([store], dir)
  }
})

test('取消归档后重新计时（mutateTask 刷新 updatedAt → 获得一个周期宽限）', async () => {
  const { store, dir } = makeStore()
  try {
    const t = seedTask(store, { status: 'completed', updatedAt: Date.now() - 8 * DAY })
    await store.archiveSweep()
    assert.ok(t.archivedAt)
    store.mutateTask(t.id, (x) => { x.archivedAt = undefined }) // 模拟前端「取消归档」
    await store.archiveSweep()
    assert.ok(!t.archivedAt, '宽限期内不重复归档')
  } finally {
    await cleanup([store], dir)
  }
})

test('store.json 无 archive 配置时回退环境变量 WORKBUDDY_ARCHIVE_DAYS', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-store-test-'))
  const path = join(dir, 'store.json')
  const store = new WorkStore(path)
  const store2 = new WorkStore(join(dir, 'store-2.json')) // 无文件新库
  try {
    // 手工构造旧版 store.json（无 archive 字段，模拟升级场景）
    const legacy = {
      agents: [], tasks: [], schedules: [], projects: [], teams: [],
      settings: { onenat: { baseUrl: 'https://x', apiKey: 'k', autoRefreshMs: 60000 }, planner: {} },
    }
    store.flush()
    writeFileSync(path, JSON.stringify(legacy), 'utf-8')
    process.env.WORKBUDDY_ARCHIVE_DAYS = '30'
    const upgraded = new WorkStore(path)
    assert.equal(upgraded.getSettings().archive?.taskArchiveDays, 30, '旧版 store 升级：天数取环境变量')
    delete process.env.WORKBUDDY_ARCHIVE_DAYS
    assert.equal(store2.getSettings().archive?.taskArchiveDays, 7, '无文件新库：默认 7')
    assert.ok(existsSync(path))
    await cleanup([upgraded], dir)
  } catch (err) {
    delete process.env.WORKBUDDY_ARCHIVE_DAYS
    await cleanup([store, store2], dir)
    throw err
  } finally {
    delete process.env.WORKBUDDY_ARCHIVE_DAYS
  }
})

test('批量恢复：按范围清 archivedAt + 解除骨架 + 刷新宽限计时，未命中不动', async () => {
  const { store, dir } = makeStore()
  try {
    const staleOld = Date.now() - 8 * DAY
    const a1 = seedTask(store, { status: 'completed', updatedAt: staleOld, projectId: 'proj-a' })
    const a2 = seedTask(store, { status: 'completed', updatedAt: staleOld, projectId: 'proj-a' })
    const free = seedTask(store, { status: 'completed', updatedAt: staleOld })
    await store.archiveSweep()
    assert.ok(a1.archivedAt && a2.archivedAt && free.archivedAt, '前置：三个均已归档')
    assert.ok(a1.bulkArchived, '前置：a1 已骨架化')

    const n = store.bulkUnarchive((t) => t.projectId === 'proj-a')
    assert.equal(n, 2, '项目内 2 个全部恢复')
    assert.ok(!a1.archivedAt && !a2.archivedAt, '项目内 archivedAt 已清')
    assert.ok(!a1.bulkArchived, '骨架标记解除（恢复常驻全量落盘）')
    assert.ok(a2.updatedAt > Date.now() - 10_000, 'updatedAt 刷新为当下（进入宽限）')
    assert.ok(free.archivedAt, '范围外保持归档')

    await store.archiveSweep()
    assert.ok(!a1.archivedAt, '宽限期内不重复归档')
    assert.ok(free.archivedAt, '未恢复的保持归档')

    assert.equal(store.bulkUnarchive(() => true), 1, '全量恢复只剩 free')
    assert.ok(!free.archivedAt)
    assert.equal(store.bulkUnarchive(() => true), 0, '幂等：无已归档时返回 0')
  } finally {
    await cleanup([store], dir)
  }
})

test('批量删除：仅删已归档目标（含 data/archive/ 文件），未归档/未选中不动', async () => {
  const { store, path, dir } = makeStore()
  try {
    const staleOld = Date.now() - 8 * DAY
    const a1 = seedTask(store, { status: 'completed', updatedAt: staleOld, projectId: 'proj-a' })
    const free = seedTask(store, { status: 'completed', updatedAt: staleOld })
    const live = seedTask(store, { status: 'completed', updatedAt: Date.now() })
    await store.archiveSweep()
    assert.ok(a1.archivedAt && a1.bulkArchived && free.archivedAt, '前置：a1/free 已归档')
    assert.ok(existsSync(join(dir, 'archive', `${a1.id}.json`)), '前置：归档文件已落盘')

    // live 未归档：即使 id 传入也必须被忽略（服务端 scoped 双保险）
    const n = store.bulkDeleteArchived([a1.id, live.id])
    assert.equal(n, 1, '只删已归档的 a1')
    assert.equal(store.getTask(a1.id), undefined, 'a1 已删除')
    assert.ok(store.getTask(free.id), '未选中的归档任务保留')
    assert.ok(store.getTask(live.id), '未归档任务保留')
    assert.ok(!existsSync(join(dir, 'archive', `${a1.id}.json`)), '归档文件一并清理')

    store.flush()
    const disk = JSON.parse(readFileSync(path, 'utf-8'))
    assert.ok(!disk.tasks.some((x: WorkTask) => x.id === a1.id), '落盘后 a1 不再存在')
    assert.equal(store.bulkDeleteArchived([free.id, live.id, 'task-none']), 1, '第二批：free 删除、live 忽略')
    assert.equal(store.bulkDeleteArchived([]), 0, '空清单返回 0')
  } finally {
    await cleanup([store], dir)
  }
})
