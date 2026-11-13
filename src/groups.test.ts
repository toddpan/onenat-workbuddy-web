/**
 * groups.test.ts - 协作群存储层 + REST 契约单测（契约 docs/groups-web-sync-plan-2026-11-11.md §1/§2）
 *
 * 覆盖：字段归一化/校验（缺省不等于非法）、幂等语义对账（review-web-1 P9 表）、
 * tmp+rename 原子写、损坏拒写保现场（P1）、每用户隔离（P4）、已读单调（P8）、
 * 12 个 REST 端点包络与错误码（P11，含 404/409/400/500/401）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { GroupStore, GroupStoreError, normalizeGroupRoom, dedupeKeepOrder, NOTICE_MAX } from './groups.js'
import type { GroupRoom } from './types.js'
import { WorkStore } from './store.js'
import { WorkBuddyRouter } from './router.js'

function tmpFile(name: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wb-groups-'))
  return { dir, path: join(dir, name) }
}

function room(id: string, patch: Partial<GroupRoom> = {}): GroupRoom {
  return {
    id,
    name: '',
    notice: '',
    adminAgentId: '',
    mode: 'admin',
    memberAgentIds: [],
    channelRef: '',
    projectIds: [],
    activeProjectId: '',
    section: '',
    createdBy: 'tester',
    archived: false,
    notifyLevel: 'mention',
    unreadCount: 0,
    lastReadSeq: 0,
    permissionOverride: '',
    createdAt: 1000,
    updatedAt: 1000,
    ...patch,
  }
}

test('normalize POST-style defaults: mode=admin notify=mention, empty string fields, server authority', () => {
  const now = 1700000000000
  const r = normalizeGroupRoom({ name: '群A', createdBy: 'hacker', createdAt: 1, updatedAt: 2 }, undefined, { id: 'g1', now, createdBy: 'user-1' })
  assert.equal(r.id, 'g1')
  assert.equal(r.mode, 'admin')
  assert.equal(r.notifyLevel, 'mention')
  assert.equal(r.unreadCount, 0)
  assert.equal(r.lastReadSeq, 0)
  assert.equal(r.archived, false)
  assert.equal(r.permissionOverride, '')
  assert.equal(r.adminAgentId, '')
  assert.equal(r.channelRef, '')
  assert.equal(r.section, '')
  assert.equal(r.createdBy, 'user-1', 'createdBy 服务端权威，客户端值被覆盖')
  assert.equal(r.createdAt, now, 'createdAt 服务端维护')
  assert.equal(r.updatedAt, now)
})

test('normalize PUT merge: absent fields fall back to base, explicit null clears', () => {
  const base = room('g1', { name: '群A', notice: '公告', memberAgentIds: ['a', 'b'], projectIds: ['p1'], activeProjectId: 'p1', section: '工作' })
  const r = normalizeGroupRoom({ notice: '新公告' }, base, { id: 'g1', now: 2000, createdAt: base.createdAt, createdBy: base.createdBy })
  assert.equal(r.notice, '新公告')
  assert.equal(r.name, '群A')
  assert.deepEqual(r.memberAgentIds, ['a', 'b'])
  assert.equal(r.activeProjectId, 'p1')
  assert.equal(r.section, '工作')
  assert.equal(r.createdAt, 1000, '更新保 createdAt')
  assert.equal(r.updatedAt, 2000, '更新刷 updatedAt')
  const cleared = normalizeGroupRoom({ notice: null, section: null }, base, { id: 'g1', now: 3000 })
  assert.equal(cleared.notice, '')
  assert.equal(cleared.section, '')
})

test('normalize strict validation: invalid enum 400, notice over 2000 code points, default differs from invalid', () => {
  const now = 1
  const mk = (input: any) => () => normalizeGroupRoom(input, undefined, { id: 'g1', now, createdBy: 'u' })
  assert.throws(mk({ mode: 'free' }), (e: any) => e instanceof GroupStoreError && e.code === 'INVALID_PARAM')
  assert.throws(mk({ notifyLevel: 'loud' }), (e: any) => e instanceof GroupStoreError && e.code === 'INVALID_PARAM')
  assert.throws(mk({ notice: '好'.repeat(NOTICE_MAX + 1) }), (e: any) => e.code === 'INVALID_PARAM')
  assert.doesNotThrow(mk({ notice: '好'.repeat(NOTICE_MAX) }))
  const r = normalizeGroupRoom({ mode: '', notifyLevel: '' }, undefined, { id: 'g1', now, createdBy: 'u' })
  assert.equal(r.mode, 'admin', '空串=缺省，落默认 admin，不是非法')
  assert.equal(r.notifyLevel, 'mention', '空串=缺省，落默认 mention')
})

test('archived strict bool: only true/true-string honored, false-string clears, garbage falls back (W1-3)', () => {
  const base = room('g1', { archived: true })
  assert.equal(normalizeGroupRoom({ archived: 'false' }, base, { id: 'g1', now: 1 }).archived, false, '"false" 显式清除')
  assert.equal(normalizeGroupRoom({ archived: 'true' }, undefined, { id: 'g1', now: 1 }).archived, true)
  assert.equal(normalizeGroupRoom({ archived: 'yes' }, base, { id: 'g1', now: 1 }).archived, true, '垃圾值回退 base（规避 Boolean(false-string) 方向性错误）')
  assert.equal(normalizeGroupRoom({ archived: 1 }, undefined, { id: 'g1', now: 1 }).archived, false, '垃圾值回退默认 false')
})

test('AND-2 upsert lastReadSeq monotonic: stale seq never rolls back, forward seq accepted, unreadCount accepted', () => {
  const existing = room('g1', { lastReadSeq: 42, unreadCount: 2 })
  // POST 整体覆盖带陈旧位点（5 < 现值 42）→ 不回退
  const stale = normalizeGroupRoom({ lastReadSeq: 5, unreadCount: 0 }, undefined, { id: 'g1', now: 1, createdAt: 1000, createdBy: 'u', prevLastReadSeq: existing.lastReadSeq })
  assert.equal(stale.lastReadSeq, 42, 'POST 陈旧位点不回退（落库取 max）')
  assert.equal(stale.unreadCount, 0, 'unreadCount 照收（客户端覆盖上报口径不变）')
  // PUT 部分更新带陈旧位点 → mergeBase 亦作现值参与 max
  const stalePut = normalizeGroupRoom({ lastReadSeq: 3 }, existing, { id: 'g1', now: 2, createdAt: 1000, createdBy: 'u' })
  assert.equal(stalePut.lastReadSeq, 42)
  // 前进位点照收
  const fwd = normalizeGroupRoom({ lastReadSeq: 50 }, undefined, { id: 'g1', now: 3, prevLastReadSeq: 42 })
  assert.equal(fwd.lastReadSeq, 50)
  // 新群无现值 → 入参生效
  const fresh = normalizeGroupRoom({ lastReadSeq: 7 }, undefined, { id: 'g2', now: 4, createdBy: 'u' })
  assert.equal(fresh.lastReadSeq, 7)
})

test('normalize arrays dedupe keep order; activeProjectId outside projectIds normalized to empty; name/section trimmed', () => {
  assert.deepEqual(dedupeKeepOrder(['a', 'b', 'a', '', 3, '3']), ['a', 'b', '3'])
  const r = normalizeGroupRoom({ memberAgentIds: ['x', 'x', 'y'], projectIds: ['p1'], activeProjectId: 'p2', name: '  群  ', section: '  ' }, undefined, { id: 'g1', now: 1, createdBy: 'u' })
  assert.deepEqual(r.memberAgentIds, ['x', 'y'])
  assert.equal(r.activeProjectId, '', 'activeProjectId 不在 projectIds 内则归一化为空串，不报错')
  assert.equal(r.name, '群')
  assert.equal(r.section, '')
})
// ---------- GroupStore：幂等语义（review-web-1 P9 对账表） ----------

test('upsert: same id keeps index position, new id appends (P9)', () => {
  const { dir, path } = tmpFile('g.json')
  try {
    const s = new GroupStore(path)
    s.upsert('u1', room('a'))
    s.upsert('u1', room('b'))
    s.upsert('u1', room('c'))
    s.upsert('u1', room('a2', { id: 'a' }))
    assert.deepEqual(s.list('u1').map((r) => r.id), ['a', 'b', 'c'], '同 id 保位覆盖')
    s.upsert('u1', room('d'))
    assert.deepEqual(s.list('u1').map((r) => r.id), ['a', 'b', 'c', 'd'], '新 id 追加末尾')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('delete: idempotent + clears orphan rounds key (P9)', () => {
  const { dir, path } = tmpFile('g.json')
  try {
    const s = new GroupStore(path)
    s.upsert('u1', room('a'))
    s.addRound('u1', 'a', 't1')
    assert.deepEqual(s.rounds('u1', 'a'), ['t1'])
    assert.equal(s.delete('u1', 'a'), true)
    assert.equal(s.delete('u1', 'a'), false, '不存在静默幂等')
    assert.deepEqual(s.rounds('u1', 'a'), [], '级联清 rounds 孤儿键')
    assert.equal(s.get('u1', 'a'), undefined)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('sections: add dup idempotent, blank 400, rename conflict + cascade, remove cascade to empty string', () => {
  const { dir, path } = tmpFile('g.json')
  try {
    const s = new GroupStore(path)
    assert.deepEqual(s.addSection('u1', '工作'), { added: true })
    assert.deepEqual(s.addSection('u1', '工作'), { added: false }, '重名幂等')
    assert.throws(() => s.addSection('u1', '  '), (e: any) => e.code === 'INVALID_PARAM')
    assert.throws(() => s.addSection('u1', ''), (e: any) => e.code === 'INVALID_PARAM')
    s.addSection('u1', '闲聊')
    s.upsert('u1', room('r1', { section: '工作' }))
    s.upsert('u1', room('r2', { section: '闲聊' }))

    const rn = s.renameSection('u1', '工作', '项目群')
    assert.deepEqual(rn.sections, ['项目群', '闲聊'], 'rename 索引序不变')
    assert.equal(s.get('u1', 'r1')?.section, '项目群', '级联迁移不留孤儿引用')
    assert.throws(() => s.renameSection('u1', '不存在', '闲聊'), (e: any) => e.code === 'SECTION_CONFLICT')
    assert.throws(() => s.renameSection('u1', '项目群', '闲聊'), (e: any) => e.code === 'SECTION_CONFLICT')
    assert.throws(() => s.renameSection('u1', '项目群', '项目群'), (e: any) => e.code === 'SECTION_CONFLICT')
    assert.throws(() => s.renameSection('u1', '  ', 'x'), (e: any) => e.code === 'INVALID_PARAM')

    assert.deepEqual(s.removeSection('u1', '项目群'), { removed: true })
    assert.equal(s.get('u1', 'r1')?.section, '', '级联置空串（Android null 等价 Web 空串）')
    assert.deepEqual(s.removeSection('u1', '项目群'), { removed: false }, '不存在有效名幂等')
    assert.throws(() => s.removeSection('u1', ' '), (e: any) => e.code === 'INVALID_PARAM')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('rounds: dedupe keep order, blank/missing room no orphan keys; markRead monotonic (P6/P8/P9)', () => {
  const { dir, path } = tmpFile('g.json')
  try {
    const s = new GroupStore(path)
    s.upsert('u1', room('a'))
    assert.deepEqual(s.addRound('u1', 'a', 't1'), { added: true })
    assert.deepEqual(s.addRound('u1', 'a', 't1'), { added: false }, '同 taskId 去重幂等')
    assert.deepEqual(s.addRound('u1', 'a', 't2'), { added: true })
    assert.deepEqual(s.rounds('u1', 'a'), ['t1', 't2'], '保序')
    assert.deepEqual(s.addRound('u1', 'a', '  '), { added: false })
    assert.deepEqual(s.addRound('u1', 'ghost', 't9'), { added: false }, '群不存在不落孤儿键')

    s.upsert('u1', room('a', { unreadCount: 7, lastReadSeq: 5 }))
    const r = s.markRead('u1', 'a', 9)
    assert.equal(r?.unreadCount, 0, 'unreadCount 归零')
    assert.equal(r?.lastReadSeq, 9)
    const r2 = s.markRead('u1', 'a', 3)
    assert.equal(r2?.lastReadSeq, 9, '单调不回退')
    assert.equal(s.markRead('u1', 'ghost', 1), undefined, '群不存在返回 undefined（REST 404）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('per-user isolation: A/B scopes fully separated (P4)', () => {
  const { dir, path } = tmpFile('g.json')
  try {
    const s = new GroupStore(path)
    s.upsert('u1', room('a', { section: '工作' }))
    s.addSection('u1', '工作')
    s.addRound('u1', 'a', 't1')
    assert.deepEqual(s.list('u2'), [])
    assert.equal(s.get('u2', 'a'), undefined)
    assert.deepEqual(s.sections('u2'), [])
    assert.deepEqual(s.rounds('u2', 'a'), [])
    assert.equal(s.delete('u2', 'a'), false, '跨用户不可改')
    assert.equal(s.markRead('u2', 'a', 1), undefined)
    s.upsert('u2', room('a', { name: 'B的群' }))
    assert.equal(s.get('u1', 'a')?.name, '')
    assert.equal(s.get('u2', 'a')?.name, 'B的群')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('persistence: reload sees data, atomic write leaves no tmp file, 0600 mode on POSIX', () => {
  const { dir, path } = tmpFile('g.json')
  try {
    const s = new GroupStore(path)
    s.upsert('u1', room('a', { name: '持久' }))
    s.addRound('u1', 'a', 't1')
    assert.equal(existsSync(path + '.tmp'), false, 'tmp+rename 原子写不留临时文件')
    const s2 = new GroupStore(path)
    assert.equal(s2.get('u1', 'a')?.name, '持久')
    assert.deepEqual(s2.rounds('u1', 'a'), ['t1'])
    if (process.platform !== 'win32') {
      assert.equal(statSync(path).mode & 0o777, 0o600, '数据文件 0600（fs-perms 惯例）')
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('corrupt file: reads empty, refuses overwrite (preserve scene), reports unhealthy (P1)', () => {
  const { dir, path } = tmpFile('g.json')
  try {
    const garbage = '{ not valid json !!!'
    writeFileSync(path, garbage, 'utf-8')
    const s = new GroupStore(path)
    assert.deepEqual(s.list('u1'), [])
    assert.equal(s.isUnhealthy, true)
    assert.throws(() => s.upsert('u1', room('a')), (e: any) => e.code === 'STORE_UNHEALTHY', '损坏后拒绝覆盖写')
    assert.throws(() => s.addSection('u1', 'x'), (e: any) => e.code === 'STORE_UNHEALTHY')
    assert.equal(readFileSync(path, 'utf-8'), garbage, '原文件现场未被破坏')
    assert.deepEqual(s.list('u1'), [], '读仍可用（空表）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('structural corruption: users non-object / rooms non-array / scope entry invalid → unhealthy, writes refused, file preserved (W1-1)', () => {
  const forms: [string, string][] = [
    ['users 非对象', '{"users": 5}'],
    ['rooms 非数组', '{"users":{"u1":{"rooms":"x","sections":[],"rounds":{}}}}'],
    ['scope 条目非对象', '{"users":{"u1": 7}}'],
  ]
  for (const [label, raw] of forms) {
    const { dir, path } = tmpFile('g.json')
    try {
      writeFileSync(path, raw, 'utf-8')
      const s = new GroupStore(path)
      assert.equal(s.isUnhealthy, true, label + ' → unhealthy')
      assert.throws(() => s.upsert('u1', room('a')), (e: any) => e.code === 'STORE_UNHEALTHY', label + ' → 写口拒绝')
      assert.equal(readFileSync(path, 'utf-8'), raw, label + ' → 原文件不被覆盖')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }
})

test('persist failure: STORE_WRITE_FAILED then STORE_UNHEALTHY, memory kept for reads, no rollback (W1-2)', () => {
  const { dir, path } = tmpFile('g.json')
  try {
    const s = new GroupStore(path)
    s.upsert('u1', room('a', { name: 'first' }))
    // 确定性写败：tmp 落点被目录占用（ensurePrivateDir 会重建被删目录，故用 EISDIR 注入）
    mkdirSync(path + '.tmp')
    assert.throws(() => s.upsert('u1', room('b')), (e: any) => e.code === 'STORE_WRITE_FAILED')
    assert.equal(s.isUnhealthy, true)
    assert.throws(() => s.upsert('u1', room('c')), (e: any) => e.code === 'STORE_UNHEALTHY', '失败后拒绝后续写口')
    assert.equal(s.get('u1', 'a')?.name, 'first', '内存态保留供读（不回滚）')
    assert.deepEqual(s.list('u1').map((r) => r.id), ['a', 'b'], '失败前已入内存的 b 保留（保现场语义，不回滚）')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('lenient load: corrupt single room skipped, invalid enum falls back to default, others intact', () => {
  const { dir, path } = tmpFile('g.json')
  try {
    writeFileSync(path, JSON.stringify({ users: { u1: { rooms: [{ id: 'ok' }, { bad: 1 }, { id: 'weird', mode: 'chaos', unreadCount: -3 }], sections: ['', '重复', '重复', ' 保留 '], rounds: { ok: ['t1', 't1', ''] } } } }), 'utf-8')
    const s = new GroupStore(path)
    assert.equal(s.isUnhealthy, false, '单条损坏不影响整库健康')
    assert.deepEqual(s.list('u1').map((r) => r.id), ['ok', 'weird'])
    assert.equal(s.list('u1')[1].mode, 'admin', '非法枚举读取期落默认')
    assert.equal(s.list('u1')[1].unreadCount, 0, '负值钳 0')
    assert.deepEqual(s.sections('u1'), ['重复', '保留'])
    assert.deepEqual(s.rounds('u1', 'ok'), ['t1'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
// ---------- REST 契约（§2 全部 12 端点 + 错误码） ----------

type Send = (method: string, path: string, body?: any, session?: { userId: string; username: string } | null) => Promise<{ status: number; body: any }>

async function httpFixture(run: (send: Send) => Promise<void>, brokenStorePath?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-groups-http-'))
  const store = new WorkStore(join(dir, 'store.json'))
  if (brokenStorePath) writeFileSync(brokenStorePath, '{ broken', 'utf-8')
  const groups = new GroupStore(brokenStorePath ?? join(dir, 'groups.json'))
  const router = new WorkBuddyRouter(store, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, groups)
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x')
    // 查询串 as=<user> 模拟不同登录身份；as=none 模拟无登录（AI 令牌/服务通道）
    const as = url.searchParams.get('as')
    const session = as === 'none' ? undefined : ({ userId: as || 'u1', username: as || 'u1', role: 'member' } as any)
    void router.dispatch(req, res, '/wb', { session }).catch(() => {
      res.statusCode = 500
      res.end(JSON.stringify({ ok: false, error: 'fixture dispatch error' }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = 'http://127.0.0.1:' + (server.address() as any).port + '/wb'
  const send: Send = async (method, path, body, session) => {
    const as = session === null ? 'none' : session?.userId || 'u1'
    const r = await fetch(base + path + '?as=' + as, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: r.status, body: await r.json() }
  }
  try { await run(send) }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); store.flush(); rmSync(dir, { recursive: true, force: true }) }
}

test('REST: create/list/get/put/delete happy path + envelope + server-authoritative fields', async () => {
  await httpFixture(async (send) => {
    const created = await send('POST', '/api/groups', { name: '群A', memberAgentIds: ['a', 'b', 'a'], createdBy: 'spoof', createdAt: 1 })
    assert.equal(created.status, 200)
    assert.equal(created.body.ok, true)
    const g = created.body.data
    assert.ok(g.id, '缺 id 服务端生成')
    assert.deepEqual(g.memberAgentIds, ['a', 'b'])
    assert.equal(g.createdBy, 'u1', 'createdBy 服务端权威')
    assert.notEqual(g.createdAt, 1)

    const list = await send('GET', '/api/groups')
    assert.deepEqual(list.body.data.map((r: GroupRoom) => r.id), [g.id], 'GET 保索引序')

    const got = await send('GET', '/api/groups/' + g.id)
    assert.equal(got.status, 200)
    assert.equal(got.body.data.name, '群A')

    const patched = await send('PUT', '/api/groups/' + g.id, { notice: 'hi', mode: 'everyone' })
    assert.equal(patched.body.data.notice, 'hi')
    assert.equal(patched.body.data.mode, 'everyone')
    assert.equal(patched.body.data.name, '群A', 'PUT 部分字段合并')
    assert.equal(patched.body.data.createdBy, 'u1')
    assert.equal((await send('PUT', '/api/groups/' + g.id, { mode: 'chaos' })).status, 400)
    assert.equal((await send('PUT', '/api/groups/' + g.id, { notice: '好'.repeat(NOTICE_MAX + 1) })).status, 400)
    assert.equal((await send('PUT', '/api/groups/ghost', { notice: 'x' })).body.code, 'NOT_FOUND')
    assert.equal((await send('PUT', '/api/groups/ghost', { notice: 'x' })).status, 404)

    assert.deepEqual((await send('DELETE', '/api/groups/' + g.id)).body, { ok: true, data: { deleted: true } })
    assert.deepEqual((await send('DELETE', '/api/groups/' + g.id)).body, { ok: true, data: { deleted: false } }, '删除幂等')
    assert.equal((await send('GET', '/api/groups/' + g.id)).status, 404)
  })
})
test('REST: POST same id keeps position; sections/rounds/read full contract incl 409/404/400', async () => {
  await httpFixture(async (send) => {
    await send('POST', '/api/groups', { id: 'g-1', name: '一' })
    await send('POST', '/api/groups', { id: 'g-2', name: '二' })
    const g1b = (await send('POST', '/api/groups', { id: 'g-1', name: '一改' })).body.data
    assert.equal(g1b.name, '一改')
    const order = (await send('GET', '/api/groups')).body.data.map((r: GroupRoom) => r.id)
    assert.deepEqual(order, ['g-1', 'g-2'], 'POST 同 id 保位（create/upsert 幂等语义）')

    // 分组
    assert.deepEqual((await send('POST', '/api/group-sections', { name: '工作' })).body.data, { added: true })
    assert.deepEqual((await send('POST', '/api/group-sections', { name: '工作' })).body.data, { added: false }, '重名幂等')
    assert.equal((await send('POST', '/api/group-sections', { name: '  ' })).status, 400)
    assert.deepEqual((await send('GET', '/api/group-sections')).body.data, ['工作'])
    await send('POST', '/api/group-sections', { name: '第二' })
    assert.equal((await send('PUT', '/api/group-sections/工作', { to: '项目群' })).body.data.renamed, true)
    assert.equal((await send('PUT', '/api/group-sections/不存在', { to: 'x' })).status, 409)
    assert.equal((await send('PUT', '/api/group-sections/项目群', { to: '第二' })).status, 409, '新名已存在 409')
    assert.equal((await send('PUT', '/api/group-sections/项目群', { to: '项目群' })).status, 409, '新旧同名 409')
    assert.equal((await send('PUT', '/api/group-sections/项目群', { to: '其他' })).status, 200)
    assert.equal((await send('PUT', '/api/group-sections/x', { to: ' ' })).status, 400, '空新名 400')
    assert.equal((await send('DELETE', '/api/group-sections/ ')).status, 400, 'DELETE 空白名 400（lead 裁定三）')
    assert.equal((await send('DELETE', '/api/group-sections/不存在')).status, 200, '不存在有效名幂等 200')

    // 级联：room.section 迁移/置空
    await send('PUT', '/api/groups/g-1', { section: '其他' })
    await send('PUT', '/api/group-sections/其他', { to: '最终' })
    assert.equal((await send('GET', '/api/groups/g-1')).body.data.section, '最终', 'rename 级联迁移')
    await send('DELETE', '/api/group-sections/最终')
    assert.equal((await send('GET', '/api/groups/g-1')).body.data.section, '', 'remove 级联置空')

    // 历史轮
    assert.equal((await send('GET', '/api/groups/ghost/rounds')).status, 404)
    assert.equal((await send('POST', '/api/groups/ghost/rounds', { taskId: 't' })).status, 404, 'lead 裁定二')
    assert.deepEqual((await send('POST', '/api/groups/g-1/rounds', { taskId: 't1' })).body.data, { added: true })
    assert.deepEqual((await send('POST', '/api/groups/g-1/rounds', { taskId: 't1' })).body.data, { added: false })
    assert.equal((await send('POST', '/api/groups/g-1/rounds', { taskId: '  ' })).status, 400, '空 taskId 400（W1-5 写口严格口径）')
    assert.deepEqual((await send('GET', '/api/groups/g-1/rounds')).body.data, ['t1'])

    // 已读
    await send('PUT', '/api/groups/g-1', { unreadCount: 9, lastReadSeq: 4 })
    const read = await send('POST', '/api/groups/g-1/read', { lastReadSeq: 7 })
    assert.equal(read.body.data.unreadCount, 0)
    assert.equal(read.body.data.lastReadSeq, 7)
    assert.equal((await send('POST', '/api/groups/g-1/read', { lastReadSeq: 2 })).body.data.lastReadSeq, 7, '单调不回退')
    assert.equal((await send('POST', '/api/groups/g-1/read', { lastReadSeq: -1 })).status, 400)
    assert.equal((await send('POST', '/api/groups/g-1/read', { lastReadSeq: 'x' })).status, 400)
    assert.equal((await send('POST', '/api/groups/ghost/read', { lastReadSeq: 1 })).status, 404)
  })
})

test('REST: per-user isolation, no-session 401, cross-user 404', async () => {
  await httpFixture(async (send) => {
    const g = (await send('POST', '/api/groups', { name: 'A的群' }, { userId: 'uA', username: 'uA' })).body.data
    const other = await send('GET', '/api/groups', undefined, { userId: 'uB', username: 'uB' })
    assert.deepEqual(other.body.data, [], '跨用户不可见')
    assert.equal((await send('GET', '/api/groups/' + g.id, undefined, { userId: 'uB', username: 'uB' })).status, 404, '跨用户 404 防枚举')
    assert.equal((await send('DELETE', '/api/groups/' + g.id, undefined, { userId: 'uB', username: 'uB' })).body.data.deleted, false, '跨用户不可改')
    const noSession = await send('GET', '/api/groups', undefined, null)
    assert.equal(noSession.status, 401, '无登录身份（AI 令牌通道）401，不落共享桶（P5）')
    assert.equal((await send('POST', '/api/groups', { name: 'x' }, null)).status, 401)
  })
})

test('REST: unhealthy store surfaces 500 and preserves the corrupt file (P1/P3)', async () => {
  const { dir, path } = tmpFile('groups-broken.json')
  try {
    const garbage = '{ broken'
    await httpFixture(async (send) => {
      const r = await send('POST', '/api/groups', { name: 'x' })
      assert.equal(r.status, 500, '写口拒写必须如实反馈（review P3）')
      assert.equal(r.body.ok, false)
      assert.equal(r.body.code, 'STORE_UNHEALTHY')
      assert.equal((await send('GET', '/api/groups')).status, 200, '读口空表仍可用')
      assert.equal(readFileSync(path, 'utf-8'), garbage, 'HTTP 路径同样保现场')
    }, path)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
