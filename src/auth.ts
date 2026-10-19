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

/** 一次性令牌（统一表）：type 区分用户注册邀请 / 密码重置；库里只存 sha256 哈希 */
export interface InviteToken {
  id: string
  type: 'user_invite' | 'password_reset'
  tokenHash: string
  email: string
  userId: string
  status: 'pending' | 'used' | 'revoked'
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
/** 注册邀请链接有效期：72 小时 */
export const INVITE_TTL_MS = 72 * 60 * 60 * 1000

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

  /** 管理员用户列表（脱敏：不含哈希） */
  public listUsers(): Array<Pick<AuthUser, 'id' | 'username' | 'displayName' | 'role' | 'status' | 'createdAt' | 'lastLoginAt'>> {
    return this.users
      .filter((u) => u.status !== 'deleted')
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

  private issueToken(type: InviteToken['type'], email: string, userId: string): string {
    const token = randomBytes(32).toString('base64url')
    const inv: InviteToken = {
      id: 'inv-' + randomBytes(6).toString('hex'),
      type,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      email,
      userId,
      status: 'pending',
      expiresAt: Date.now() + INVITE_TTL_MS,
      createdAt: Date.now(),
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
