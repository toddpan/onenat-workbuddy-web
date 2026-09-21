/**
 * onenat-workbuddy-web - 登录认证（独立部署模式）
 *
 * - 用户落盘 dataDir/auth.json（scrypt 加盐哈希，不存明文）；首次运行无用户时
 *   用 adminUsername/adminPassword 播种管理员账号；
 * - 会话为内存态 HttpOnly Cookie（默认 7 天滑动过期），重启后需重新登录；
 * - 登录失败限速：单 IP 5 分钟内 10 次失败即 429。
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface AuthUser {
  username: string
  salt: string
  hash: string
  createdAt: number
}

interface AuthStore {
  users: AuthUser[]
}

interface Session {
  username: string
  expiresAt: number
}

export const SESSION_COOKIE = 'wb_session'

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const LOGIN_FAIL_WINDOW_MS = 5 * 60 * 1000
const LOGIN_FAIL_MAX = 10

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString('hex')
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf-8')
  const bb = Buffer.from(b, 'utf-8')
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}

export class AuthService {
  private filePath: string
  private users: AuthUser[] = []
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
      this.createUser(adminUsername || 'workbuddy', adminPassword || 'ThunderSoft@88')
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
      }
    } catch (err) {
      console.error('[onenat-workbuddy] auth.json 读取失败，回退为空用户表:', err)
      this.users = []
    }
  }

  private save(): void {
    try {
      const dir = dirname(this.filePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.filePath, JSON.stringify({ users: this.users }, null, 2), { mode: 0o600 })
    } catch (err) {
      console.error('[onenat-workbuddy] auth.json 写入失败:', err)
    }
  }

  public createUser(username: string, password: string): AuthUser {
    const salt = randomBytes(16).toString('hex')
    const user: AuthUser = { username, salt, hash: hashPassword(password, salt), createdAt: Date.now() }
    this.users.push(user)
    this.save()
    return user
  }

  /** 校验登录；成功返回新会话 token，失败返回 null（内置单 IP 限速） */
  public login(username: string, password: string, clientIp: string): string | null {
    const fails = this.failCounts.get(clientIp) || []
    const recent = fails.filter((t) => Date.now() - t < LOGIN_FAIL_WINDOW_MS)
    this.failCounts.set(clientIp, recent)
    if (recent.length >= LOGIN_FAIL_MAX) return null

    const user = this.users.find((u) => u.username === username)
    const ok = user ? safeEqual(hashPassword(password, user.salt), user.hash) : false
    if (!ok) {
      recent.push(Date.now())
      return null
    }
    this.failCounts.delete(clientIp)
    const token = randomBytes(32).toString('hex')
    this.sessions.set(token, { username: user!.username, expiresAt: Date.now() + SESSION_TTL_MS })
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
    if (!token) return undefined
    const s = this.sessions.get(token)
    if (!s) return undefined
    if (Date.now() > s.expiresAt) {
      this.sessions.delete(token)
      return undefined
    }
    s.expiresAt = Date.now() + SESSION_TTL_MS
    return s.username
  }

  public logout(token: string | undefined): void {
    if (token) this.sessions.delete(token)
  }

  /** 修改密码（校验旧密码）；成功后吊销该用户全部会话 */
  public changePassword(username: string, oldPassword: string, newPassword: string): boolean {
    const user = this.users.find((u) => u.username === username)
    if (!user) return false
    if (!safeEqual(hashPassword(oldPassword, user.salt), user.hash)) return false
    if (!newPassword || newPassword.length < 6) return false
    user.salt = randomBytes(16).toString('hex')
    user.hash = hashPassword(newPassword, user.salt)
    this.save()
    for (const [token, s] of this.sessions) {
      if (s.username === username) this.sessions.delete(token)
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
