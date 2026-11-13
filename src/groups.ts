/**
 * onenat-workbuddy-web - 协作群（Group）存储层
 *
 * 契约唯一事实源：docs/groups-web-sync-plan-2026-11-11.md §1（实体与幂等语义）。
 * 字段名与 Android GroupRoom JSON 逐字一致（上游 onenat-workbuddy-android GroupRoom.kt）。
 *
 * 落盘：单文件 $DSH_HOME/dsh-orchestrator-groups.json，取 ssh-store 的 0600 + fs-perms 惯例，
 * 写盘方式取 store.ts 的 tmp+rename 原子写（写盘中途崩溃不留截断文件）。
 * 文件内按登录身份（userId）分 scope：{ users: { <userId>: { rooms, sections, rounds } } }——
 * 群无共享/归属人语义（契约 §1「v1 无共享群」），不复用 perm.ts 的 canViewResource 共享模型。
 *
 * 容错语义（review-web-1 P1/P2/P3，对齐 Android GroupStore「load 失败不得触发 save 清数据」）：
 * - load 解析失败/根对象非法 → 内存置空表供读、置 unhealthy；所有写口 persist() 拒绝覆盖写原文件
 *   （保现场），向上抛 STORE_UNHEALTHY，由 REST 映射 500——绝不静默清库。
 * - 单条群记录损坏 → 逐条宽松整形/跳过（对齐 Android parse* 防御），不影响整库健康。
 * - persist 写盘失败 → 抛 STORE_WRITE_FAILED（REST 映射 500），响应如实反映落盘结果。
 *
 * 幂等语义（契约 §1，逐条对齐 Android GroupStore，对账表见 review-web-1 P9）：
 * - upsert：同 id 保位覆盖内容；新 id 追加末尾（列表渲染顺序不抖动）。
 * - delete：不存在静默幂等；同时清 rounds:<roomId> 孤儿键。
 * - 分组 add：重名幂等 → {added:false}；trim 后空名 INVALID_PARAM。
 *   rename：旧名不存在或新名已存在（含新旧同名）→ SECTION_CONFLICT；级联迁移 rooms.section（索引序不变）。
 *   remove：不存在静默幂等（有效名）；级联置 ""（Android null ≡ Web ""）；空白名 INVALID_PARAM。
 * - rounds add：同 taskId 去重保序；群不存在不落键（Web 多用户服务端不留孤儿，review P6）。
 * - markRead：lastReadSeq = max(当前, 入参) 单调不回退；unreadCount 归零；同步读-改-写无 await 间隙（review P8）。
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { ensurePrivateDir, hardenFile, PRIVATE_FILE_MODE } from './fs-perms.js'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { GroupRoom } from './types.js'

/** 群公告字数上限（契约 §1：≤2000 字，按码点计，对齐 Android groupNoticeError 的 codePointCount） */
export const NOTICE_MAX = 2000

export const GROUP_MODES = ['admin', 'everyone'] as const
export const NOTIFY_LEVELS = ['all', 'mention', 'mute'] as const
/** 新建群默认：管理员主持 / 仅@我 提醒（契约 §1，对齐 Android GroupDefaults） */
export const DEFAULT_GROUP_MODE = 'admin'
export const DEFAULT_NOTIFY_LEVEL = 'mention'

/** 群存储错误码：SECTION_CONFLICT→409；INVALID_PARAM→400；STORE_UNHEALTHY/STORE_WRITE_FAILED→500 */
export class GroupStoreError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'GroupStoreError'
  }
}

// ---------- 纯函数（node --test 直测；语义对齐 Android GroupStore 索引纯函数与 parse* 防御） ----------

/** 字符串卫生：非字符串/空 → ""（对齐 Android optString；绝不向 Android 下发 null 字段，review P10） */
function asString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

/** 保序去重；非数组 → []；逐项 asString 后滤空（契约 §2：memberAgentIds/projectIds 服务端归一化） */
export function dedupeKeepOrder(ids: unknown): string[] {
  if (!Array.isArray(ids)) return []
  const out: string[] = []
  for (const v of ids) {
    const s = asString(v)
    if (!s || out.includes(s)) continue
    out.push(s)
  }
  return out
}

/** 计数卫生：有限数取整并钳 ≥0，其余 → 0（对齐 Android updateUnread 负值钳 0；review P8） */
function asCount(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0
}

/** 布尔卫生：只认 true/'true'/false/'false'（W1-3：Boolean('false') 方向性错误），其余回退调用方默认 */
function asTriBool(v: unknown): boolean | undefined {
  if (v === true || v === 'true') return true
  if (v === false || v === 'false') return false
  return undefined
}

export interface NormalizeGroupRoomOptions {
  /** 权威 id（POST 缺 id 由调用方生成；PUT 用路径 id，body.id 不参与） */
  id: string
  /** 服务端维护时间（毫秒）：新群 updatedAt=now */
  now: number
  /** 已存在群的 createdAt（服务端权威，覆盖写入保留原值；缺省 = now） */
  createdAt?: number
  /** 登录用户名（服务端权威填充，客户端值被覆盖；已存在群保持原 createdBy，review P10） */
  createdBy?: string
  /** 已存在群的 lastReadSeq 现值（POST 整体覆盖时由调用方传入，AND-2：落库取 max 防陈旧位点回退） */
  prevLastReadSeq?: number
  /** true = 读取期宽松整形：非法枚举落默认、不校验公告长度，绝不抛异常（对齐 Android parse）；缺省严格校验 */
  lenient?: boolean
}

/**
 * GroupRoom 归一化 + 校验（契约 §1/§2）：
 * - mergeBase 非 undefined = 部分字段更新（PUT 语义）：input 缺省字段回退 mergeBase；
 *   mergeBase = undefined = 整实体 upsert（POST 语义）：缺省字段落默认值。
 * - 严格模式：mode/notifyLevel 非空且非法 → INVALID_PARAM；notice 超 2000 码点 → INVALID_PARAM。
 *   「缺省 ≠ 非法」（review P10）：空串/缺省 → 默认 admin/mention；显式非法枚举才 400。
 * - name/section trim 后空串归 ""；adminAgentId/channelRef/permissionOverride 归 ""（不 trim）；
 *   memberAgentIds/projectIds 去重保序；activeProjectId ∉ projectIds 归一化为 ""（不报错）。
 * - createdBy/createdAt 服务端权威；unreadCount/lastReadSeq 负值/非法值钳 0。
 */
export function normalizeGroupRoom(input: any, mergeBase: GroupRoom | undefined, opts: NormalizeGroupRoomOptions): GroupRoom {
  const raw = input && typeof input === 'object' ? input : {}
  const base = mergeBase
  const str = (key: string): string => (raw[key] !== undefined ? asString(raw[key]) : base ? base[key as keyof GroupRoom] as string : '')

  const resolveEnum = (rawVal: unknown, baseVal: string | undefined, allowed: readonly string[], def: string, field: string): string => {
    const s = rawVal !== undefined ? asString(rawVal) : baseVal ?? def
    if (!s) return def
    if (!allowed.includes(s)) {
      if (opts.lenient) return def
      throw new GroupStoreError('INVALID_PARAM', field + ' 必须是 ' + allowed.join('|') + ' 之一')
    }
    return s
  }

  const notice = str('notice')
  const noticeLen = [...notice].length
  if (noticeLen > NOTICE_MAX && !opts.lenient) {
    throw new GroupStoreError('INVALID_PARAM', '群公告最多 ' + NOTICE_MAX + ' 字（当前 ' + noticeLen + ' 字）')
  }

  const memberAgentIds = raw.memberAgentIds !== undefined ? dedupeKeepOrder(raw.memberAgentIds) : base?.memberAgentIds ?? []
  const projectIds = raw.projectIds !== undefined ? dedupeKeepOrder(raw.projectIds) : base?.projectIds ?? []
  const activeProjectIdRaw = str('activeProjectId')
  const activeProjectId = activeProjectIdRaw && projectIds.includes(activeProjectIdRaw) ? activeProjectIdRaw : ''

  return {
    id: opts.id,
    name: str('name').trim(),
    notice,
    adminAgentId: str('adminAgentId'),
    mode: resolveEnum(raw.mode, base?.mode, GROUP_MODES, DEFAULT_GROUP_MODE, 'mode') as GroupRoom['mode'],
    memberAgentIds,
    channelRef: str('channelRef'),
    projectIds,
    activeProjectId,
    section: str('section').trim(),
    createdBy: opts.createdBy ?? base?.createdBy ?? '',
    archived: (raw.archived !== undefined ? asTriBool(raw.archived) : undefined) ?? base?.archived ?? false,
    notifyLevel: resolveEnum(raw.notifyLevel, base?.notifyLevel, NOTIFY_LEVELS, DEFAULT_NOTIFY_LEVEL, 'notifyLevel') as GroupRoom['notifyLevel'],
    unreadCount: raw.unreadCount !== undefined ? asCount(raw.unreadCount) : base?.unreadCount ?? 0,
    // AND-2（契约 §1 裁定）：落库 lastReadSeq = max(现值, 入参)——陈旧位点不回退；unreadCount 照收（客户端覆盖上报口径不变）
    lastReadSeq: Math.max(
      raw.lastReadSeq !== undefined ? asCount(raw.lastReadSeq) : base?.lastReadSeq ?? 0,
      Math.max(opts.prevLastReadSeq ?? 0, base?.lastReadSeq ?? 0),
    ),
    permissionOverride: str('permissionOverride'),
    createdAt: opts.createdAt ?? opts.now,
    updatedAt: opts.now,
  }
}

/** 读取期宽松整形：任何输入都不抛异常（单条损坏逐条兜底，不影响整库健康） */
function coerceGroupRoom(raw: any, now: number): GroupRoom {
  return normalizeGroupRoom(raw, undefined, { id: asString(raw?.id), now, createdBy: asString(raw?.createdBy), lenient: true })
}

/** 单用户 scope（文件内分桶结构，review P4） */
interface GroupUserScope {
  /** 群实体（保索引序 = 列表渲染序） */
  rooms: GroupRoom[]
  /** 首页分组名（保序） */
  sections: string[]
  /** 历史轮：rounds[roomId] = taskId 保序表（当前频道在 room.channelRef，不入此表） */
  rounds: Record<string, string[]>
}

function sanitizeSections(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : []
  return arr.map((s) => asString(s).trim()).filter(Boolean).filter((s, i, a) => a.indexOf(s) === i)
}

function sanitizeRounds(v: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [roomId, list] of Object.entries(v as Record<string, unknown>)) {
      const ids = dedupeKeepOrder(list)
      if (roomId && ids.length) out[roomId] = ids
    }
  }
  return out
}

/**
 * 协作群存储（契约 §1）。单文件多用户分桶；写口全同步（读-改-写无 await 间隙，review P8），
 * Node 单线程内天然串行；每次写口即时原子落盘（tmp+rename）。
 */
export class GroupStore {
  private filePath: string
  private users: Record<string, GroupUserScope> = {}
  /** load 失败/根对象非法 → true：读出空表但拒绝覆盖写原文件（保现场，review P1） */
  private unhealthy = false

  constructor(customPath?: string) {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    this.filePath = customPath || join(dshHome, 'dsh-orchestrator-groups.json')
    // 启动时对存量文件收紧 0600（fs-perms 惯例；Windows 无 POSIX 语义静默忽略）
    hardenFile(this.filePath)
    this.load()
  }

  /** 数据文件绝对路径（诊断/测试用） */
  public get path(): string {
    return this.filePath
  }

  /** 文件是否处于「损坏拒写」保护态（诊断/测试用） */
  public get isUnhealthy(): boolean {
    return this.unhealthy
  }

  private load(): void {
    if (!existsSync(this.filePath)) {
      this.unhealthy = false
      this.users = {}
      return
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.markUnhealthy('群存储文件根对象非法')
        return
      }
      // 结构级损坏（users/scope 条目/rooms/sections/rounds 形态非法）一律 unhealthy 拒写保现场（review W1-1）；
      // 单条群记录损坏仍走 coerceGroupRoom 逐条兜底（对齐 Android「索引损坏 unhealthy、单条损坏跳过」）。
      const users = (parsed as { users?: unknown }).users
      if (!users || typeof users !== 'object' || Array.isArray(users)) {
        this.markUnhealthy('群存储文件 users 结构非法')
        return
      }
      const now = Date.now()
      for (const [uid, scope] of Object.entries(users as Record<string, unknown>)) {
        if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
          this.markUnhealthy('群存储文件 scope 条目结构非法（' + uid + '）')
          return
        }
        const s = scope as Record<string, unknown>
        if (!Array.isArray(s.rooms) || !Array.isArray(s.sections) || !s.rounds || typeof s.rounds !== 'object' || Array.isArray(s.rounds)) {
          this.markUnhealthy('群存储文件 rooms/sections/rounds 结构非法（' + uid + '）')
          return
        }
        this.users[uid] = {
          rooms: (s.rooms as unknown[]).map((r) => coerceGroupRoom(r, now)).filter((r) => r.id),
          sections: sanitizeSections(s.sections),
          rounds: sanitizeRounds(s.rounds),
        }
      }
      this.unhealthy = false
    } catch (err) {
      console.error('[onenat-workbuddy] Failed to load group store (refusing to overwrite):', err)
      this.markUnhealthy('群存储文件 JSON 损坏')
    }
  }

  /** unhealthy = 拒绝全部写口；keepMemory=true（写盘失败场景）保留内存态供读，不回滚（review W1-2 保现场一致） */
  private markUnhealthy(reason: string, keepMemory = false): void {
    this.unhealthy = true
    this.unhealthyReason = reason
    if (!keepMemory) this.users = {}
  }

  private unhealthyReason = ''

  public get unhealthyMessage(): string {
    return this.unhealthyReason || '群存储文件不可解析'
  }

  /**
   * 原子落盘（store.ts flush 同款 tmp+rename；review P2）。
   * unhealthy → 拒绝写（保现场）；写盘失败 → 抛错（REST 必须如实反馈，review P3）。
   */
  private persist(): void {
    if (this.unhealthy) {
      throw new GroupStoreError('STORE_UNHEALTHY', this.unhealthyMessage + '，已拒绝写入以保护现场，请人工检查 ' + this.filePath)
    }
    try {
      const dir = dirname(this.filePath)
      ensurePrivateDir(dir)
      const tmp = this.filePath + '.tmp'
      writeFileSync(tmp, JSON.stringify({ users: this.users }, null, 2), { encoding: 'utf-8', mode: PRIVATE_FILE_MODE })
      renameSync(tmp, this.filePath)
    } catch (err) {
      // W1-2：写盘失败 → 置 unhealthy 拒绝后续写口（内存态保留供读、不回滚），避免残缺态继续覆盖
      const reason = '群存储落盘失败：' + (err instanceof Error ? err.message : String(err))
      this.markUnhealthy(reason, true)
      throw new GroupStoreError('STORE_WRITE_FAILED', reason)
    }
  }

  /** 写口统一门禁：损坏保护态下一律拒绝（先于任何内存变更，保证 list 不被污染，review P1） */
  private assertWritable(): void {
    if (this.unhealthy) {
      throw new GroupStoreError('STORE_UNHEALTHY', this.unhealthyMessage + '，已拒绝写入以保护现场，请人工检查 ' + this.filePath)
    }
  }

  private scope(userId: string, create: boolean): GroupUserScope | undefined {
    let s = this.users[userId]
    if (!s && create) {
      s = { rooms: [], sections: [], rounds: {} }
      this.users[userId] = s
    }
    return s
  }

  // ---------- 群 CRUD ----------

  /** 当前用户全部群（保索引序；返回副本防外部改写） */
  public list(userId: string): GroupRoom[] {
    return [...(this.scope(userId, false)?.rooms ?? [])]
  }

  public get(userId: string, roomId: string): GroupRoom | undefined {
    return this.scope(userId, false)?.rooms.find((r) => r.id === roomId)
  }

  /** 幂等：同 id 保位覆盖内容，新 id 追加末尾（契约 §1；对齐 Android upsertIds） */
  public upsert(userId: string, room: GroupRoom): GroupRoom {
    this.assertWritable()
    const s = this.scope(userId, true)!
    const idx = s.rooms.findIndex((r) => r.id === room.id)
    if (idx >= 0) s.rooms[idx] = room
    else s.rooms.push(room)
    this.persist()
    return room
  }

  /** 删除群：不存在静默幂等；同时清 rounds 孤儿键（契约 §1；返回是否确有删除） */
  public delete(userId: string, roomId: string): boolean {
    this.assertWritable()
    const s = this.scope(userId, false)
    if (!s) return false
    const before = s.rooms.length
    s.rooms = s.rooms.filter((r) => r.id !== roomId)
    const hadRounds = Object.prototype.hasOwnProperty.call(s.rounds, roomId)
    if (hadRounds) delete s.rounds[roomId]
    const changed = s.rooms.length !== before || hadRounds
    if (changed) this.persist()
    return changed
  }

  // ---------- 首页分组（section） ----------

  /** 分组名列表（保序；读取期再兜底 trim/去重，对齐 Android sections()） */
  public sections(userId: string): string[] {
    return sanitizeSections(this.scope(userId, false)?.sections ?? [])
  }

  /** 新增分组：重名幂等 → {added:false}；trim 后空名 INVALID_PARAM（契约 §2，review P7/lead 裁定③） */
  public addSection(userId: string, name: unknown): { added: boolean } {
    this.assertWritable()
    const trimmed = asString(name).trim()
    if (!trimmed) throw new GroupStoreError('INVALID_PARAM', '分组名不能为空')
    const s = this.scope(userId, true)!
    if (this.sections(userId).includes(trimmed)) return { added: false }
    s.sections.push(trimmed)
    this.persist()
    return { added: true }
  }

  /**
   * 重命名分组：旧名不存在或新名已存在（含新旧同名）→ SECTION_CONFLICT（契约 §1；HTTP 409）；
   * 级联迁移 rooms.section 不留孤儿引用，群索引序不变（review P9）；空名 INVALID_PARAM。
   */
  public renameSection(userId: string, oldName: unknown, newName: unknown): { renamed: true; sections: string[] } {
    this.assertWritable()
    const o = asString(oldName).trim()
    const n = asString(newName).trim()
    if (!o || !n) throw new GroupStoreError('INVALID_PARAM', '重命名需要非空的原分组名与新分组名')
    const s = this.scope(userId, false)
    const cur = this.sections(userId)
    if (!s || !cur.includes(o) || cur.includes(n)) {
      throw new GroupStoreError('SECTION_CONFLICT', '分组「' + o + '」不存在或「' + n + '」已存在，无法重命名')
    }
    s.sections = cur.map((x) => (x === o ? n : x))
    const now = Date.now()
    for (let i = 0; i < s.rooms.length; i++) {
      if (s.rooms[i].section === o) s.rooms[i] = { ...s.rooms[i], section: n, updatedAt: now }
    }
    this.persist()
    return { renamed: true, sections: [...s.sections] }
  }

  /**
   * 删除分组：不存在静默幂等（有效名）；级联 rooms.section 置 ""（Android null ≡ Web ""）；
   * 空白名 INVALID_PARAM（lead 裁定③）。
   */
  public removeSection(userId: string, name: unknown): { removed: boolean } {
    this.assertWritable()
    const n = asString(name).trim()
    if (!n) throw new GroupStoreError('INVALID_PARAM', '分组名不能为空')
    const s = this.scope(userId, false)
    if (!s) return { removed: false }
    const before = s.sections.length
    s.sections = s.sections.filter((x) => x !== n)
    const now = Date.now()
    let roomsChanged = false
    for (let i = 0; i < s.rooms.length; i++) {
      if (s.rooms[i].section === n) {
        s.rooms[i] = { ...s.rooms[i], section: '', updatedAt: now }
        roomsChanged = true
      }
    }
    const removed = s.sections.length !== before || roomsChanged
    if (removed) this.persist()
    return { removed }
  }

  // ---------- 讨论轮与已读 ----------

  /** 历史轮 taskId 列表（保序去重；读取期兜底滤空，对齐 Android rounds() 读侧 distinct） */
  public rounds(userId: string, roomId: string): string[] {
    const cur = this.scope(userId, false)?.rounds[roomId] ?? []
    return cur.filter(Boolean).filter((t, i, a) => a.indexOf(t) === i)
  }

  /** 追加历史轮：同 taskId 去重保序；空 taskId/群不存在不落键（不留孤儿，review P6） */
  public addRound(userId: string, roomId: string, taskId: unknown): { added: boolean } {
    this.assertWritable()
    const id = asString(taskId).trim()
    if (!id || !this.get(userId, roomId)) return { added: false }
    const s = this.scope(userId, true)!
    const cur = s.rounds[roomId] ?? (s.rounds[roomId] = [])
    if (cur.includes(id)) return { added: false }
    cur.push(id)
    this.persist()
    return { added: true }
  }

  /**
   * 已读落位（契约 §1）：unreadCount 归零；lastReadSeq = max(当前, 入参) 单调不回退；
   * 群不存在 → undefined（REST 404）；同步读-改-写、无 await 间隙（review P8）。
   */
  public markRead(userId: string, roomId: string, lastReadSeq: number): GroupRoom | undefined {
    this.assertWritable()
    const s = this.scope(userId, false)
    if (!s) return undefined
    const idx = s.rooms.findIndex((r) => r.id === roomId)
    if (idx < 0) return undefined
    const cur = s.rooms[idx]
    const next: GroupRoom = { ...cur, unreadCount: 0, lastReadSeq: Math.max(cur.lastReadSeq, lastReadSeq), updatedAt: Date.now() }
    s.rooms[idx] = next
    this.persist()
    return next
  }
}
