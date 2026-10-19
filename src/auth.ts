/**
 * onenat-workbuddy-web - 登录认证（独立部署模式）
 *
 * - 用户落盘 dataDir/auth.json（scrypt 加盐哈希，不存明文）；首次运行无用户时
 *   用 adminUsername/adminPassword 播种管理员账号；
 * - 会话为内存态 HttpOnly Cookie（默认 7 天滑动过期），重启后需重新登录；
 * - 登录失败限速：单 IP 5 分钟内 10 次失败即 429。
 */

import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

export type UserStatus = 'invited' | 'active' | 'disabled' | 'deleted'
export type UserRole = 'admin' | 'user'

export interface AuthUser {
  /** 稳定用户 ID（usr- 前缀）：项目成员 / 会话 / 审计以此关联；旧版 auth.json 缺失时 load 自动补齐 */
  id: string
  username: string
  displayName?: string
  salt: string
  hash: string
  role: UserRole
  status: UserStatus
  createdAt: number
  lastLoginAt?: number
}

/** 一次性令牌（统一表）：type 区分用户注册邀请 / 密码重置 / 项目成员邀请；库里只存 sha256 哈希 */
export interface InviteToken {
  id: string
  type: 'user_invite' | 'password_reset' | 'project_invite'
  tokenHash: string
  email: string
  /** user_invite / password_reset：关联用户；project_invite：目标可能尚未注册，为空 */
  userId: string
  /** project_invite 专属：目标项目与入项角色、发起人 */
  projectId?: string
  role?: 'owner' | 'member'
  invitedBy?: string
  status: 'pending' | 'used' | 'revoked' | 'declined'
  expiresAt: number
  usedAt?: number
  createdAt: number
}

interface AuthStore {
  users: AuthUser[]
  invites?: InviteToken[]
}

interface Session {
  userId: string
  username: string
  expiresAt: number
}

export interface SessionInfo {
  userId: string
  username: string
  displayName?: string
  role: UserRole
}

export const SESSION_COOKIE = 'wb_session'

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const LOGIN_FAIL_WINDOW_MS = 5 * 60 * 1000
const LOGIN_FAIL_MAX = 10
/** 注册邀请链接有效期：72 小时；密码重置：24 小时；项目邀请：7 天 */
export const INVITE_TTL_MS = 72 * 60 * 60 * 1000
export const RESET_TTL_MS = 24 * 60 * 60 * 1000
export const PROJECT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

const scryptAsync = promisify(scrypt) as (password: string, salt: string, keylen: number) => Promise<Buffer>

/** 同步版哈希：仅用于启动播种（进程启动时事件循环空闲，一次 ~55ms 无影响） */
function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex')
}

/** 登录/改密热路径用异步 scrypt（libuv 线程池执行，不阻塞事件循环） */
async function hashPasswordAsync(password: string, salt: string): Promise<string> {
  return (await scryptAsync(password, salt, 64)).toString('hex')
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf-8')
  const bb = Buffer.from(b, 'utf-8')
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

export class AuthService {
  private filePath: string
  private users: AuthUser[] = []
  private invites: InviteToken[] = []
  /** 进程内 token 防双击：已受理的 tokenHash 立即记入，落盘窗口内并发请求同样被拒 */
  private usedTokenHashes = new Set<string>()
  private sessions = new Map<string, Session>()
  /** AI 工具通道令牌（wbk-…）：落盘 ai-token.json，设置页可查看/重置，无需重启 */
  private aiTokenPath: string
  private aiToken: string | null = null

  constructor(
    dataDir: string,
    adminUsername: string,
    adminPassword: string,
  ) {
    this.filePath = join(dataDir, 'auth.json')
    this.aiTokenPath = join(dataDir, 'ai-token.json')
    this.load()
    if (!this.users.length) {
      this.createUser(adminUsername || 'workbuddy', adminPassword || 'workbuddy-admin')
      console.log(`[onenat-workbuddy] 已创建管理员账号「${adminUsername || 'workbuddy'}」（auth.json 可增删用户）`)
    }
    this.loadAiToken()
  }

  // ---- AI 工具通道令牌 ----

  private loadAiToken(): void {
    try {
      if (existsSync(this.aiTokenPath)) {
        const parsed = JSON.parse(readFileSync(this.aiTokenPath, 'utf-8'))
        this.aiToken = typeof parsed.token === 'string' && parsed.token ? parsed.token : null
      }
    } catch {
      this.aiToken = null
    }
  }

  private saveAiToken(): void {
    try {
      writeFileSync(this.aiTokenPath, JSON.stringify({ token: this.aiToken, updatedAt: Date.now() }, null, 2), { mode: 0o600 })
    } catch (err) {
      console.error('[onenat-workbuddy] ai-token.json 写入失败:', err)
    }
  }

  /** 当前 AI 令牌（未配置返回空串：工具通道 fail-closed 拒绝一切调用） */
  public getAiToken(): string {
    return this.aiToken || ''
  }

  /** 是否已配置 AI 令牌 */
  public hasAiToken(): boolean {
    return Boolean(this.aiToken)
  }

  /** 种子令牌（--token / WORKBUDDY_TOKEN 启动参数）：仅在尚未配置时写入，之后以设置页管理为准 */
  public seedAiToken(token: string): void {
    const t = String(token || '').trim()
    if (!t || this.aiToken) return
    this.aiToken = t
    this.saveAiToken()
    console.log('[onenat-workbuddy] 已将启动参数令牌播种为 AI APIKEY（后续可在设置页重置）')
  }

  /** 重置 AI 令牌：生成 wbk- 前缀随机值并落盘（旧令牌立即失效），无需重启 */
  public resetAiToken(): string {
    this.aiToken = 'wbk-' + randomBytes(24).toString('hex')
    this.saveAiToken()
    return this.aiToken
  }

  /** 校验 AI 令牌；未配置令牌时一律拒绝（fail-closed） */
  public validateAiToken(candidate: string | undefined | null): boolean {
    if (!this.aiToken || !candidate) return false
    return safeEqual(this.aiToken, String(candidate))
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8'))
        this.users = Array.isArray(parsed.users) ? parsed.users : []
        this.invites = Array.isArray(parsed.invites) ? parsed.invites : []
      }
    } catch (err) {
      console.error('[onenat-workbuddy] auth.json 读取失败，回退为空用户表:', err)
      this.users = []
      this.invites = []
    }
    // 旧版 auth.json 迁移：补齐 id/role/status（存量账号即管理员，行为与升级前一致）
    let migrated = false
    for (const u of this.users) {
      if (!u.id) { u.id = 'usr-' + randomBytes(8).toString('hex'); migrated = true }
      if (!u.role) { u.role = 'admin'; migrated = true }
      if (!u.status) { u.status = 'active'; migrated = true }
    }
    if (migrated) this.save()
  }

  private save(): void {
    try {
      const dir = dirname(this.filePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.filePath, JSON.stringify({ users: this.users, invites: this.invites }, null, 2), { mode: 0o600 })
    } catch (err) {
      console.error('[onenat-workbuddy] auth.json 写入失败:', err)
    }
  }

  public createUser(username: string, password: string): AuthUser {
    const salt = randomBytes(16).toString('hex')
    const user: AuthUser = {
      id: 'usr-' + randomBytes(8).toString('hex'),
      username,
      salt,
      hash: hashPassword(password, salt),
      role: 'admin',
      status: 'active',
      createdAt: Date.now(),
    }
    this.users.push(user)
    this.save()
    return user
  }

  // ---------- 用户 / 邀请管理（Phase 1：管理员邀请 + 链接激活） ----------

  private static normalizeEmail(v: string): string {
    return String(v || '').trim().toLowerCase()
  }

  /** 密码策略：≥8 位且同时含字母与数字 */
  public static validNewPassword(pw: string): boolean {
    return typeof pw === 'string' && pw.length >= 8 && /[a-zA-Z]/.test(pw) && /\d/.test(pw)
  }

  private findByEmail(email: string): AuthUser | undefined {
    const e = AuthService.normalizeEmail(email)
    return this.users.find((u) => AuthService.normalizeEmail(u.username) === e && u.status !== 'deleted')
  }

  public getUserById(id: string): AuthUser | undefined {
    return this.users.find((u) => u.id === id && u.status !== 'deleted')
  }

  public getUserByUsername(username: string): AuthUser | undefined {
    return this.users.find((u) => u.username === username && u.status !== 'deleted')
  }

  /** 管理员用户列表（脱敏：不含哈希）；支持 status/role/q（用户名或昵称包含，大小写不敏感）过滤 */
  public listUsers(filters: { status?: string; role?: string; q?: string } = {}): Array<Pick<AuthUser, 'id' | 'username' | 'displayName' | 'role' | 'status' | 'createdAt' | 'lastLoginAt'>> {
    const q = String(filters.q || '').trim().toLowerCase()
    return this.users
      .filter((u) => u.status !== 'deleted')
      .filter((u) => !filters.status || u.status === filters.status)
      .filter((u) => !filters.role || u.role === filters.role)
      .filter((u) => !q || u.username.toLowerCase().includes(q) || (u.displayName || '').toLowerCase().includes(q))
      .map(({ id, username, displayName, role, status, createdAt, lastLoginAt }) => ({ id, username, displayName, role, status, createdAt, lastLoginAt }))
  }

  /** 活跃用户摘要（添加项目成员等场景；不含敏感字段） */
  public listActiveUsers(): Array<{ id: string; username: string; displayName?: string }> {
    return this.users
      .filter((u) => u.status === 'active')
      .map((u) => ({ id: u.id, username: u.username, displayName: u.displayName }))
  }

  /**
   * 管理员创建 invited 用户并签发注册邀请；返回 token 原文（只此一次，用于拼邀请链接）。
   * 邮箱全局唯一（含 invited 态）；已存在非 deleted 用户返回 conflict。
   */
  public createUserInvite(email: string, displayName: string): { user: AuthUser; token: string } | { conflict: string } {
    const e = AuthService.normalizeEmail(email)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { conflict: '邮箱格式不正确' }
    if (this.users.some((u) => AuthService.normalizeEmail(u.username) === e && u.status !== 'deleted')) {
      return { conflict: '该邮箱已存在（invited 用户可重发邀请）' }
    }
    const salt = randomBytes(16).toString('hex')
    const user: AuthUser = {
      id: 'usr-' + randomBytes(8).toString('hex'),
      username: e,
      displayName: String(displayName || '').trim() || undefined,
      // invited 态无密码：占位随机盐+哈希，登录校验必失败
      salt,
      hash: hashPassword(randomBytes(32).toString('hex'), salt),
      role: 'user',
      status: 'invited',
      createdAt: Date.now(),
    }
    this.users.push(user)
    // 旧邀请作废（同邮箱仅一份 pending）
    for (const inv of this.invites) {
      if (inv.type === 'user_invite' && inv.email === e && inv.status === 'pending') inv.status = 'revoked'
    }
    const token = this.issueToken('user_invite', e, user.id)
    return { user, token }
  }

  /** 重发邀请：旧 token 作废、刷新有效期，返回新 token 原文 */
  public resendInvite(userId: string): string | undefined {
    const user = this.users.find((u) => u.id === userId && u.status === 'invited')
    if (!user) return undefined
    const e = AuthService.normalizeEmail(user.username)
    for (const inv of this.invites) {
      if (inv.type === 'user_invite' && inv.email === e && inv.status === 'pending') inv.status = 'revoked'
    }
    return this.issueToken('user_invite', e, user.id)
  }

  /** 撤销邀请（U-04）：pending 注册邀请置 revoked；用户保持 invited 态，可后续重发或删除 */
  public revokeUserInvite(userId: string): boolean {
    const user = this.users.find((u) => u.id === userId && u.status === 'invited')
    if (!user) return false
    const e = AuthService.normalizeEmail(user.username)
    let hit = false
    for (const inv of this.invites) {
      if (inv.type === 'user_invite' && inv.email === e && inv.status === 'pending') { inv.status = 'revoked'; hit = true }
    }
    if (hit) this.save()
    return hit
  }

  // ---------- 密码重置（U-07）：与注册邀请同一令牌机制，type=password_reset，24h ----------

  /** 申请重置：仅 active 用户签发 token；邮箱不存在返回 null（调用方恒定响应，防枚举）。旧 pending 重置作废 */
  public requestPasswordReset(email: string): string | null {
    const e = AuthService.normalizeEmail(email)
    const user = this.users.find((u) => AuthService.normalizeEmail(u.username) === e && u.status === 'active')
    if (!user) return null
    for (const inv of this.invites) {
      if (inv.type === 'password_reset' && inv.email === e && inv.status === 'pending') inv.status = 'revoked'
    }
    return this.issueToken('password_reset', e, user.id, { ttlMs: RESET_TTL_MS })
  }

  /** 重置密码：校验 token → 设置新密码（≥8 位字母+数字）→ 吊销该用户全部会话。token 原子置 used */
  public async resetPassword(token: string, newPassword: string): Promise<{ ok: true; username: string } | { ok: false; error: string }> {
    const inv = this.findInvite(token)
    if (!inv || inv.type !== 'password_reset') return { ok: false, error: '重置链接无效' }
    const hash = inv.tokenHash
    if (this.usedTokenHashes.has(hash)) return { ok: false, error: '重置链接已被使用' }
    if (inv.status !== 'pending') return { ok: false, error: inv.status === 'revoked' ? '重置链接已失效，请重新申请' : '重置链接已被使用' }
    if (Date.now() > inv.expiresAt) return { ok: false, error: '重置链接已过期，请重新申请' }
    if (!AuthService.validNewPassword(newPassword)) return { ok: false, error: '密码需至少 8 位，且同时包含字母与数字' }
    const user = this.users.find((u) => u.id === inv.userId)
    if (!user || user.status !== 'active') return { ok: false, error: '账号状态异常，请联系管理员' }
    this.usedTokenHashes.add(hash)
    user.salt = randomBytes(16).toString('hex')
    user.hash = await hashPasswordAsync(newPassword, user.salt)
    inv.status = 'used'
    inv.usedAt = Date.now()
    for (const [t, s] of this.sessions) {
      if (s.userId === user.id) this.sessions.delete(t)
    }
    this.save()
    return { ok: true, username: user.username }
  }

  // ---------- 项目成员邀请（P-04/05/09）：统一令牌表 type=project_invite，7 天 ----------

  /** 发起项目邀请：同项目同邮箱仅一份 pending；返回 token 原文（拼邀请链接用一次） */
  public createProjectInvite(projectId: string, email: string, role: 'owner' | 'member', invitedBy: string): { token: string } | { conflict: string } {
    const e = AuthService.normalizeEmail(email)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return { conflict: '邮箱格式不正确' }
    if (this.invites.some((x) => x.type === 'project_invite' && x.projectId === projectId && x.email === e && x.status === 'pending')) {
      return { conflict: '该邮箱已有待处理邀请（可重发刷新有效期）' }
    }
    return { token: this.issueToken('project_invite', e, '', { ttlMs: PROJECT_INVITE_TTL_MS, projectId, role, invitedBy }) }
  }

  /** 重发项目邀请：旧 token 作废、刷新 7 天有效期 */
  public resendProjectInvite(projectId: string, inviteId: string): string | undefined {
    const inv = this.invites.find((x) => x.id === inviteId && x.type === 'project_invite' && x.projectId === projectId)
    if (!inv || inv.status !== 'pending') return undefined
    inv.status = 'revoked'
    return this.issueToken('project_invite', inv.email, '', { ttlMs: PROJECT_INVITE_TTL_MS, projectId, role: inv.role, invitedBy: inv.invitedBy })
  }

  /** 撤销项目邀请 */
  public revokeProjectInvite(projectId: string, inviteId: string): boolean {
    const inv = this.invites.find((x) => x.id === inviteId && x.type === 'project_invite' && x.projectId === projectId)
    if (!inv || inv.status !== 'pending') return false
    inv.status = 'revoked'
    this.save()
    return true
  }

  /** 项目邀请列表（管理用，含历史） */
  public listProjectInvites(projectId: string): Array<Pick<InviteToken, 'id' | 'email' | 'role' | 'status' | 'invitedBy' | 'createdAt' | 'expiresAt' | 'usedAt'>> {
    return this.invites
      .filter((x) => x.type === 'project_invite' && x.projectId === projectId)
      .map(({ id, email, role, status, invitedBy, createdAt, expiresAt, usedAt }) => ({ id, email, role: role || 'member', status, invitedBy, createdAt, expiresAt, usedAt }))
  }

  /** 校验项目邀请（不消耗）：回显邮箱/角色/有效期/发起人 + 目标邮箱账号状态（接受页据此决定表单形态） */
  public inspectProjectInvite(token: string): { valid: true; email: string; role: 'owner' | 'member'; projectId: string; expiresAt: number; account: 'none' | 'invited' | 'active' | 'disabled'; inviterName?: string } | { valid: false; reason: string } {
    const inv = this.findInvite(token)
    if (!inv || inv.type !== 'project_invite') return { valid: false, reason: '邀请链接无效' }
    if (inv.status === 'used') return { valid: false, reason: '邀请已被接受' }
    if (inv.status === 'declined') return { valid: false, reason: '邀请已被拒绝' }
    if (inv.status === 'revoked') return { valid: false, reason: '邀请已被撤销，请联系邀请人重发' }
    if (Date.now() > inv.expiresAt) return { valid: false, reason: '邀请已过期，请联系邀请人重发' }
    const user = this.users.find((u) => AuthService.normalizeEmail(u.username) === AuthService.normalizeEmail(inv.email) && u.status !== 'deleted')
    const account = !user ? 'none' : user.status === 'active' ? 'active' : user.status === 'invited' ? 'invited' : 'disabled'
    const inviter = inv.invitedBy ? this.users.find((u) => u.id === inv.invitedBy) : undefined
    return { valid: true, email: inv.email, role: inv.role || 'member', projectId: inv.projectId!, expiresAt: inv.expiresAt, account, inviterName: inviter?.displayName || inviter?.username }
  }

  /**
   * 接受项目邀请（P-05）：token 原子置 used。
   * - 邮箱未注册：{password} 必填，一步创建账号（active）并入项；
   * - 邮箱为 invited（管理员预建）：{password} 必填，激活并入项（一步完成，签发会话）；
   * - 邮箱已 active：需以该邮箱的登录态调用（sessionUserId 匹配），否则 403 文案；不签发新会话；
   * - disabled：拒绝。
   * 成员记录由路由层写 store（本方法只管账号与令牌），返回 joined 用户信息与可选新会话。
   */
  public async acceptProjectInvite(
    token: string,
    opts: { password?: string; displayName?: string; sessionUserId?: string },
  ): Promise<{ ok: true; user: AuthUser; newSessionToken?: string } | { ok: false; error: string; code?: number }> {
    const inv = this.findInvite(token)
    if (!inv || inv.type !== 'project_invite') return { ok: false, error: '邀请链接无效' }
    const hash = inv.tokenHash
    if (this.usedTokenHashes.has(hash)) return { ok: false, error: '邀请已被接受' }
    const checked = this.inspectProjectInvite(token)
    if (!checked.valid) return { ok: false, error: checked.reason }
    const e = AuthService.normalizeEmail(inv.email)
    const existing = this.users.find((u) => AuthService.normalizeEmail(u.username) === e && u.status !== 'deleted')
    if (existing && existing.status === 'disabled') return { ok: false, error: '该账号已被禁用，无法接受邀请', code: 403 }
    let user: AuthUser
    let newSessionToken: string | undefined
    if (existing && existing.status === 'active') {
      if (!opts.sessionUserId) return { ok: false, error: '该邮箱已有账号，请登录后接受邀请', code: 401 }
      if (opts.sessionUserId !== existing.id) return { ok: false, error: '请退出后使用被邀请邮箱对应的账号登录再接受', code: 403 }
      user = existing
    } else {
      // none / invited：一步设置密码（注册或激活）
      if (!AuthService.validNewPassword(String(opts.password || ''))) {
        return { ok: false, error: '密码需至少 8 位，且同时包含字母与数字' }
      }
      if (existing) {
        user = existing
        user.salt = randomBytes(16).toString('hex')
        user.hash = await hashPasswordAsync(String(opts.password), user.salt)
        user.status = 'active'
      } else {
        const salt = randomBytes(16).toString('hex')
        user = {
          id: 'usr-' + randomBytes(8).toString('hex'),
          username: e,
          salt,
          hash: await hashPasswordAsync(String(opts.password), salt),
          role: 'user',
          status: 'active',
          createdAt: Date.now(),
        }
        this.users.push(user)
      }
      const dn = String(opts.displayName || '').trim()
      if (dn) user.displayName = dn
      newSessionToken = randomBytes(32).toString('hex')
      this.sessions.set(newSessionToken, { userId: user.id, username: user.username, expiresAt: Date.now() + SESSION_TTL_MS })
    }
    this.usedTokenHashes.add(hash)
    inv.status = 'used'
    inv.usedAt = Date.now()
    if (!inv.invitedBy && opts.sessionUserId) inv.invitedBy = opts.sessionUserId
    this.save()
    return { ok: true, user, newSessionToken }
  }

  /** 拒绝项目邀请（持 token 即可，效果=该链接作废） */
  public declineProjectInvite(token: string): boolean {
    const inv = this.findInvite(token)
    if (!inv || inv.type !== 'project_invite' || inv.status !== 'pending' || Date.now() > inv.expiresAt) return false
    inv.status = 'declined'
    this.save()
    return true
  }

  private issueToken(
    type: InviteToken['type'],
    email: string,
    userId: string,
    opts: { ttlMs?: number; projectId?: string; role?: 'owner' | 'member'; invitedBy?: string } = {},
  ): string {
    const token = randomBytes(32).toString('base64url')
    const inv: InviteToken = {
      id: 'inv-' + randomBytes(6).toString('hex'),
      type,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      email,
      userId,
      status: 'pending',
      expiresAt: Date.now() + (opts.ttlMs ?? INVITE_TTL_MS),
      createdAt: Date.now(),
      ...(opts.projectId ? { projectId: opts.projectId, role: opts.role || 'member', invitedBy: opts.invitedBy } : {}),
    }
    this.invites.push(inv)
    // 过期/已用令牌定期瘦身：保留最近 500 条
    if (this.invites.length > 800) {
      this.invites = this.invites.filter((x) => x.status === 'pending' || Date.now() - x.createdAt < 30 * 24 * 60 * 60 * 1000).slice(-500)
    }
    this.save()
    return token
  }

  /** 校验邀请（不消耗）：返回回显信息或失效原因 */
  public inspectInvite(token: string): { valid: true; email: string; displayName?: string; expiresAt: number } | { valid: false; reason: string } {
    const inv = this.findInvite(token)
    if (!inv) return { valid: false, reason: '邀请链接无效' }
    if (inv.status === 'used') return { valid: false, reason: '邀请已被使用' }
    if (inv.status === 'revoked') return { valid: false, reason: '邀请已被撤销，请联系管理员重发' }
    if (Date.now() > inv.expiresAt) return { valid: false, reason: '邀请已过期，请联系管理员重发' }
    const user = this.users.find((u) => u.id === inv.userId)
    if (!user || user.status !== 'invited') return { valid: false, reason: '邀请状态异常，请联系管理员' }
    return { valid: true, email: inv.email, displayName: user.displayName, expiresAt: inv.expiresAt }
  }

  private findInvite(token: string): InviteToken | undefined {
    if (!token) return undefined
    const hash = createHash('sha256').update(token).digest('hex')
    return this.invites.find((x) => x.tokenHash === hash)
  }

  /**
   * 接受邀请激活账号：设置密码（≥8 位字母+数字）→ active → 自动签发登录会话。
   * token 原子置 used（内存 Set 先行，落盘随后），双击/并发只有一次成功。
   */
  public async acceptInvite(
    token: string,
    password: string,
    displayName?: string,
  ): Promise<{ ok: true; sessionToken: string; username: string } | { ok: false; error: string }> {
    const inv = this.findInvite(token)
    if (!inv || inv.type !== 'user_invite') return { ok: false, error: '邀请链接无效' }
    const hash = inv.tokenHash
    if (this.usedTokenHashes.has(hash)) return { ok: false, error: '邀请已被使用' }
    const checked = this.inspectInvite(token)
    if (!checked.valid) return { ok: false, error: checked.reason }
    if (!AuthService.validNewPassword(password)) return { ok: false, error: '密码需至少 8 位，且同时包含字母与数字' }
    const user = this.users.find((u) => u.id === inv.userId)
    if (!user || user.status !== 'invited') return { ok: false, error: '邀请状态异常，请联系管理员' }
    this.usedTokenHashes.add(hash)
    user.salt = randomBytes(16).toString('hex')
    user.hash = await hashPasswordAsync(password, user.salt)
    const dn = String(displayName || '').trim()
    if (dn) user.displayName = dn
    user.status = 'active'
    inv.status = 'used'
    inv.usedAt = Date.now()
    const sessionToken = randomBytes(32).toString('hex')
    this.sessions.set(sessionToken, { userId: user.id, username: user.username, expiresAt: Date.now() + SESSION_TTL_MS })
    this.save()
    return { ok: true, sessionToken, username: user.username }
  }

  /** 禁用/启用：至少保留 1 名启用状态管理员；禁用立即吊销其全部会话 */
  public setUserStatus(userId: string, status: 'active' | 'disabled'): { ok: boolean; error?: string } {
    const user = this.users.find((u) => u.id === userId && u.status !== 'deleted')
    if (!user) return { ok: false, error: '用户不存在' }
    if (user.status === 'invited' && status === 'active') return { ok: false, error: 'invited 用户需通过邀请链接激活' }
    if (user.role === 'admin' && status === 'disabled') {
      const others = this.users.some((u) => u.id !== userId && u.role === 'admin' && u.status === 'active')
      if (!others) return { ok: false, error: '至少保留一名启用的管理员' }
    }
    user.status = status
    if (status === 'disabled') {
      for (const [token, s] of this.sessions) {
        if (s.userId === userId) this.sessions.delete(token)
      }
    }
    this.save()
    return { ok: true }
  }

  /** 角色变更：降级校验至少 1 名管理员 */
  public setRole(userId: string, role: UserRole): { ok: boolean; error?: string } {
    const user = this.users.find((u) => u.id === userId && u.status !== 'deleted')
    if (!user) return { ok: false, error: '用户不存在' }
    if (user.role === 'admin' && role === 'user') {
      const others = this.users.some((u) => u.id !== userId && u.role === 'admin' && u.status === 'active')
      if (!others) return { ok: false, error: '至少保留一名管理员' }
    }
    user.role = role
    this.save()
    return { ok: true }
  }

  /** 软删除：至少保留 1 名管理员；吊销全部会话 */
  public softDeleteUser(userId: string): { ok: boolean; error?: string } {
    const user = this.users.find((u) => u.id === userId && u.status !== 'deleted')
    if (!user) return { ok: false, error: '用户不存在' }
    if (user.role === 'admin') {
      const others = this.users.some((u) => u.id !== userId && u.role === 'admin' && u.status === 'active')
      if (!others) return { ok: false, error: '至少保留一名管理员，不能删除' }
    }
    user.status = 'deleted'
    for (const inv of this.invites) {
      if (inv.userId === userId && inv.status === 'pending') inv.status = 'revoked'
    }
    for (const [token, s] of this.sessions) {
      if (s.userId === userId) this.sessions.delete(token)
    }
    this.save()
    return { ok: true }
  }

  public setDisplayName(userId: string, displayName: string): boolean {
    const user = this.users.find((u) => u.id === userId && u.status !== 'deleted')
    if (!user) return false
    user.displayName = String(displayName || '').trim() || undefined
    this.save()
    return true
  }

  /** 校验登录；成功返回新会话 token，失败返回 null（内置单 IP 限速）。异步 scrypt 不阻塞事件循环 */
  public async login(username: string, password: string, clientIp: string): Promise<string | null> {
    const fails = this.failCounts.get(clientIp) || []
    const recent = fails.filter((t) => Date.now() - t < LOGIN_FAIL_WINDOW_MS)
    this.failCounts.set(clientIp, recent)
    if (recent.length >= LOGIN_FAIL_MAX) return null

    const name = String(username || '').trim()
    const user = this.users.find((u) => u.username === name) || this.users.find((u) => AuthService.normalizeEmail(u.username) === AuthService.normalizeEmail(name))
    const ok = user && user.status === 'active' ? safeEqual(await hashPasswordAsync(password, user.salt), user.hash) : false
    if (!ok) {
      recent.push(Date.now())
      return null
    }
    this.failCounts.delete(clientIp)
    user!.lastLoginAt = Date.now()
    const token = randomBytes(32).toString('hex')
    this.sessions.set(token, { userId: user!.id, username: user!.username, expiresAt: Date.now() + SESSION_TTL_MS })
    this.save()
    return token
  }

  private failCounts = new Map<string, number[]>()

  /** 单 IP 是否已被登录限速 */
  public isRateLimited(clientIp: string): boolean {
    const fails = (this.failCounts.get(clientIp) || []).filter((t) => Date.now() - t < LOGIN_FAIL_WINDOW_MS)
    return fails.length >= LOGIN_FAIL_MAX
  }

  /** 校验会话 Cookie；有效则滑动续期并返回用户名 */
  public validate(token: string | undefined): string | undefined {
    return this.validateSession(token)?.username
  }

  /** 校验会话并返回完整会话信息（userId/role 等，供权限判定）；禁用/删除用户会话即时失效 */
  public validateSession(token: string | undefined): SessionInfo | undefined {
    if (!token) return undefined
    const s = this.sessions.get(token)
    if (!s) return undefined
    if (Date.now() > s.expiresAt) {
      this.sessions.delete(token)
      return undefined
    }
    const user = this.users.find((u) => u.id === s.userId)
    if (!user || user.status !== 'active') {
      this.sessions.delete(token)
      return undefined
    }
    s.expiresAt = Date.now() + SESSION_TTL_MS
    return { userId: user.id, username: user.username, displayName: user.displayName, role: user.role }
  }

  /** 用户名 → 摘要（会话/审计展示用） */
  public describeUser(usernameOrId: string): { id: string; username: string; displayName?: string; role: UserRole } | undefined {
    const u = this.users.find((x) => x.id === usernameOrId || x.username === usernameOrId)
    return u ? { id: u.id, username: u.username, displayName: u.displayName, role: u.role } : undefined
  }

  public logout(token: string | undefined): void {
    if (token) this.sessions.delete(token)
  }

  /** 修改密码（校验旧密码）；成功后吊销该用户全部会话 */
  public async changePassword(usernameOrId: string, oldPassword: string, newPassword: string): Promise<boolean> {
    const user = this.users.find((u) => u.username === usernameOrId || u.id === usernameOrId)
    if (!user) return false
    if (!safeEqual(await hashPasswordAsync(oldPassword, user.salt), user.hash)) return false
    if (!newPassword || newPassword.length < 6) return false
    user.salt = randomBytes(16).toString('hex')
    user.hash = await hashPasswordAsync(newPassword, user.salt)
    this.save()
    for (const [token, s] of this.sessions) {
      if (s.userId === user.id) this.sessions.delete(token)
    }
    return true
  }

  // ---- Cookie 工具 ----

  public static parseCookies(header: string | undefined): Record<string, string> {
    const out: Record<string, string> = {}
    for (const part of String(header || '').split(';')) {
      const idx = part.indexOf('=')
      if (idx < 0) continue
      out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim())
    }
    return out
  }

  public static serializeSession(token: string, secure: boolean): string {
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`
  }

  public static serializeCleared(): string {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  }
}
