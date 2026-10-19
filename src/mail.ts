/**
 * onenat-workbuddy-web - 邮件发送服务（零依赖 SMTP 客户端）
 *
 * - SMTP 配置走环境变量（可由 .env 提供，见 loadDotEnv）：
 *   SMTP_HOST / SMTP_PORT(默认 465) / SMTP_SECURE(默认 true=SSL) /
 *   SMTP_USER / SMTP_PASS(授权码) / SMTP_FROM_NAME(发件人显示名)
 * - 未配置 SMTP 时为「开发模式」：邮件内容写入日志与 mail_log（status=mock），
 *   接口仍返回邀请链接供手动发送，不阻塞业务（smoke 测试零依赖）。
 * - 发送失败按指数退避重试（默认 3 次：0/1s/2s；认证失败不重试），结果落 mail-log.json（保留最近 200 条）。
 * - 协议实现：EHLO →（明文端口且服务端支持时 STARTTLS 升级）→ AUTH LOGIN →
 *   MAIL FROM → RCPT TO → DATA → QUIT；仅支持 LOGIN 认证（163/QQ/企业邮箱均支持）。
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

export interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  user: string
  pass: string
  fromName: string
}

export interface MailEntry {
  id: string
  type: string
  to: string
  subject: string
  status: 'sent' | 'failed' | 'mock'
  error?: string
  attempts?: number
  createdAt: number
}

export interface SendResult {
  ok: boolean
  /** 状态：sent=已发出；mock=未配置 SMTP（开发模式，内容已记录）；failed=发送失败 */
  status: 'sent' | 'mock' | 'failed'
  error?: string
  attempts: number
}

const MAIL_LOG_MAX = 200

/** 解析 .env 文本（KEY=VALUE；支持 # 注释、可选 export 前缀与成对引号） */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const body = line.startsWith('export ') ? line.slice(7).trim() : line
    const eq = body.indexOf('=')
    if (eq <= 0) continue
    const key = body.slice(0, eq).trim()
    let val = body.slice(eq + 1).trim()
    const quoted = /^(["'])([\s\S]*)\1\s*(?:#.*)?$/.exec(val)
    if (quoted) val = quoted[2]
    else { const ci = val.indexOf(' #'); if (ci >= 0) val = val.slice(0, ci).trim() }
    if (key) out[key] = val
  }
  return out
}

/** 加载 .env 到 process.env（不覆盖已有值）：优先 WORKBUDDY_ENV_FILE，其次 CWD/.env，最后 dataDir/.env */
export function loadDotEnv(dataDir: string): void {
  const candidates = process.env.WORKBUDDY_ENV_FILE
    ? [process.env.WORKBUDDY_ENV_FILE]
    : [join(process.cwd(), '.env'), join(dataDir, '.env')]
  for (const p of candidates) {
    try {
      if (!p || !existsSync(p)) continue
      const parsed = parseDotEnv(readFileSync(p, 'utf-8'))
      let applied = 0
      for (const [k, v] of Object.entries(parsed)) {
        if (process.env[k] === undefined) { process.env[k] = v; applied++ }
      }
      if (applied) console.log(`[onenat-workbuddy] 已从 ${p} 加载 ${applied} 项环境配置`)
      break
    } catch (err) {
      console.error('[onenat-workbuddy] .env 加载失败（忽略，继续用进程环境变量）:', err)
    }
  }
}

/** 从环境变量读取 SMTP 配置；host/user/pass 任一缺失 → null（开发模式） */
export function readSmtpConfig(env: NodeJS.ProcessEnv): SmtpConfig | null {
  const host = String(env.SMTP_HOST || '').trim()
  const user = String(env.SMTP_USER || '').trim()
  const pass = String(env.SMTP_PASS || '')
  if (!host || !user || !pass) return null
  const port = Number(env.SMTP_PORT || 0) || 465
  const secure = env.SMTP_SECURE === undefined ? true : /^(1|true|yes|on)$/i.test(env.SMTP_SECURE.trim())
  return { host, port, secure, user, pass, fromName: String(env.SMTP_FROM_NAME || 'OneNat WorkBuddy').trim() }
}

/** RFC 2047 编码（非 ASCII 主题/显示名） */
function rfc2047(text: string): string {
  return `=?UTF-8?B?${Buffer.from(text, 'utf-8').toString('base64')}?=`
}

/**
 * 邮件类接口限流（B-04）：滑动窗口内按 key（惯例 `${ip}|${action}|${email}`）计数，
 * 超限返回 true。内存态即可（重启清零，攻击面是发信骚扰而非计费）。
 */
export class RateLimiter {
  private hits = new Map<string, number[]>()
  constructor(private windowMs: number = 60 * 60 * 1000, private max: number = 5) {}

  /** 记一次并返回是否超限（超限时本次同样被拒） */
  public hit(key: string): boolean {
    const now = Date.now()
    const recent = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs)
    recent.push(now)
    this.hits.set(key, recent)
    if (this.hits.size > 5000) {
      // 惰性清理：键过多时丢弃全空窗口
      for (const [k, v] of this.hits) {
        if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k)
      }
    }
    return recent.length > this.max
  }

  public remaining(key: string): number {
    const now = Date.now()
    const recent = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs)
    return Math.max(0, this.max - recent.length)
  }
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export class MailService {
  private cfg: SmtpConfig | null
  private logPath: string

  constructor(dataDir: string, env: NodeJS.ProcessEnv = process.env) {
    this.cfg = readSmtpConfig(env)
    this.logPath = join(dataDir, 'mail-log.json')
  }

  public get configured(): boolean {
    return Boolean(this.cfg)
  }

  /** 管理端展示：配置概要（不含密码）与最近发送记录 */
  public status(): { configured: boolean; host?: string; port?: number; secure?: boolean; from?: string; fromName?: string; recent: MailEntry[] } {
    return {
      configured: Boolean(this.cfg),
      host: this.cfg?.host,
      port: this.cfg?.port,
      secure: this.cfg?.secure,
      from: this.cfg?.user,
      fromName: this.cfg?.fromName,
      recent: this.readLog().slice(-10).reverse(),
    }
  }

  /** 用户注册邀请邮件 */
  public async sendInviteMail(opts: { to: string; displayName?: string; inviteLink: string; expiresAt: number; attempts?: number; timeoutMs?: number }): Promise<SendResult> {
    const name = opts.displayName ? `${opts.displayName}（${opts.to}）` : opts.to
    const expires = new Date(opts.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    const subject = '【OneNat WorkBuddy】账号邀请：请设置密码激活'
    const html = [
      '<div style="font-family:-apple-system,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;max-width:520px;margin:0 auto;padding:24px;">',
      '<h2 style="color:#1f2329;">OneNat WorkBuddy 账号邀请</h2>',
      `<p style="color:#5f6673;font-size:14px;line-height:1.8;">您好，<b style="color:#1f2329;">${escapeHtml(name)}</b> 已被授权使用 OneNat WorkBuddy 平台。<br>请点击下方按钮设置登录密码并激活账号：</p>`,
      `<p style="text-align:center;margin:26px 0;"><a href="${escapeHtml(opts.inviteLink)}" style="background:#4d6bfe;color:#fff;padding:12px 30px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;">激活账号</a></p>`,
      `<p style="color:#8f959e;font-size:12.5px;line-height:1.8;">链接 72 小时内有效（至 ${expires}）。若按钮不可点，请复制以下链接到浏览器打开：<br><span style="color:#4d6bfe;word-break:break-all;">${escapeHtml(opts.inviteLink)}</span></p>`,
      '<p style="color:#8f959e;font-size:12px;">如非本人操作，请忽略本邮件。</p>',
      '</div>',
    ].join('')
    return this.send({ type: 'user_invite', to: opts.to, subject, html, attempts: opts.attempts, timeoutMs: opts.timeoutMs })
  }

  /** 项目成员邀请邮件 */
  public async sendProjectInviteMail(opts: { to: string; projectName: string; inviterName: string; role: 'owner' | 'member'; inviteLink: string; expiresAt: number; attempts?: number; timeoutMs?: number }): Promise<SendResult> {
    const roleText = opts.role === 'owner' ? 'owner（可管理项目）' : 'member'
    const expires = new Date(opts.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    const subject = `【OneNat WorkBuddy】项目邀请：加入「${opts.projectName}」`
    const html = [
      '<div style="font-family:-apple-system,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;max-width:520px;margin:0 auto;padding:24px;">',
      '<h2 style="color:#1f2329;">OneNat WorkBuddy 项目邀请</h2>',
      `<p style="color:#5f6673;font-size:14px;line-height:1.8;"><b style="color:#1f2329;">${escapeHtml(opts.inviterName)}</b> 邀请你以 <b style="color:#4d6bfe;">${roleText}</b> 身份加入项目 <b style="color:#1f2329;">「${escapeHtml(opts.projectName)}」</b>：</p>`,
      `<p style="text-align:center;margin:26px 0;"><a href="${escapeHtml(opts.inviteLink)}" style="background:#4d6bfe;color:#fff;padding:12px 30px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;">查看并接受邀请</a></p>`,
      `<p style="color:#8f959e;font-size:12.5px;line-height:1.8;">链接 7 天内有效（至 ${expires}）。若按钮不可点，请复制以下链接到浏览器打开：<br><span style="color:#4d6bfe;word-break:break-all;">${escapeHtml(opts.inviteLink)}</span></p>`,
      '<p style="color:#8f959e;font-size:12px;">如非本人操作，请忽略本邮件。</p>',
      '</div>',
    ].join('')
    return this.send({ type: 'project_invite', to: opts.to, subject, html, attempts: opts.attempts, timeoutMs: opts.timeoutMs })
  }

  /** 密码重置邮件 */
  public async sendResetMail(opts: { to: string; resetLink: string; expiresAt: number; attempts?: number; timeoutMs?: number }): Promise<SendResult> {
    const expires = new Date(opts.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    const subject = '【OneNat WorkBuddy】密码重置'
    const html = [
      '<div style="font-family:-apple-system,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;max-width:520px;margin:0 auto;padding:24px;">',
      '<h2 style="color:#1f2329;">OneNat WorkBuddy 密码重置</h2>',
      '<p style="color:#5f6673;font-size:14px;line-height:1.8;">我们收到了您（或他人）重置该邮箱账号密码的请求。请点击下方按钮设置新密码：</p>',
      `<p style="text-align:center;margin:26px 0;"><a href="${escapeHtml(opts.resetLink)}" style="background:#4d6bfe;color:#fff;padding:12px 30px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;">重置密码</a></p>`,
      `<p style="color:#8f959e;font-size:12.5px;line-height:1.8;">链接 24 小时内有效（至 ${expires}）。若按钮不可点，请复制以下链接到浏览器打开：<br><span style="color:#4d6bfe;word-break:break-all;">${escapeHtml(opts.resetLink)}</span></p>`,
      '<p style="color:#8f959e;font-size:12px;">如非本人操作，请忽略本邮件，您的账号不会受影响。</p>',
      '</div>',
    ].join('')
    return this.send({ type: 'password_reset', to: opts.to, subject, html, attempts: opts.attempts, timeoutMs: opts.timeoutMs })
  }

  /** 发送邮件：未配置 SMTP → mock 落库；已配置 → 真发（失败重试；认证类失败不重试） */
  public async send(opts: { type: string; to: string; subject: string; html: string; attempts?: number; timeoutMs?: number }): Promise<SendResult> {
    const attempts = Math.max(1, opts.attempts ?? 3)
    if (!this.cfg) {
      console.log(`[onenat-workbuddy][mail:mock] 未配置 SMTP，邮件未发送 —— to=${opts.to} subject=${opts.subject}\n${opts.html}`)
      this.appendLog({ type: opts.type, to: opts.to, subject: opts.subject, status: 'mock' })
      return { ok: false, status: 'mock', error: 'SMTP 未配置（开发模式：内容已记录，请复制邀请链接手动发送）', attempts: 0 }
    }
    const timeoutMs = opts.timeoutMs ?? 10_000
    let lastErr = ''
    let used = 0
    for (let attempt = 1; attempt <= attempts; attempt++) {
      used = attempt
      try {
        await smtpSend(this.cfg, opts, timeoutMs)
        this.appendLog({ type: opts.type, to: opts.to, subject: opts.subject, status: 'sent', attempts: attempt })
        return { ok: true, status: 'sent', attempts: attempt }
      } catch (err: any) {
        lastErr = err?.message || String(err)
        console.error(`[onenat-workbuddy] 邮件发送失败（第 ${attempt}/${attempts} 次）to=${opts.to}: ${lastErr}`)
        if (/AUTH 认证|AUTH 用户名/.test(lastErr)) break // 凭证错误重试无意义
        if (attempt < attempts) await new Promise((r) => setTimeout(r, 1000 * attempt))
      }
    }
    this.appendLog({ type: opts.type, to: opts.to, subject: opts.subject, status: 'failed', error: lastErr, attempts: used })
    return { ok: false, status: 'failed', error: lastErr, attempts: used }
  }

  private readLog(): MailEntry[] {
    try {
      if (existsSync(this.logPath)) {
        const parsed = JSON.parse(readFileSync(this.logPath, 'utf-8'))
        return Array.isArray(parsed.entries) ? parsed.entries : []
      }
    } catch { /* 损坏即重建 */ }
    return []
  }

  private appendLog(e: Omit<MailEntry, 'id' | 'createdAt'>): void {
    try {
      const entries = this.readLog()
      entries.push({ id: 'ml-' + randomBytes(5).toString('hex'), createdAt: Date.now(), ...e })
      const dir = dirname(this.logPath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.logPath, JSON.stringify({ entries: entries.slice(-MAIL_LOG_MAX) }, null, 2), { mode: 0o600 })
    } catch (err) {
      console.error('[onenat-workbuddy] mail-log 写入失败:', err)
    }
  }
}

// ---------- SMTP 客户端（EHLO/STARTTLS/AUTH LOGIN/MAIL/RCPT/DATA） ----------

class SmtpError extends Error {}

interface Reply {
  code: number
  lines: string[]
}

async function connectSocket(cfg: SmtpConfig, timeoutMs: number): Promise<Socket> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = cfg.secure
      ? tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host })
      : netConnect({ host: cfg.host, port: cfg.port })
    const timer = setTimeout(() => { s.destroy(); reject(new SmtpError(`连接 ${cfg.host}:${cfg.port} 超时`)) }, timeoutMs)
    s.once('connect', () => { clearTimeout(timer); resolve(s) })
    s.once('error', (err) => { clearTimeout(timer); reject(new SmtpError(`连接失败: ${err.message}`)) })
  })
  socket.setTimeout(timeoutMs + 5000)
  socket.once('timeout', () => socket.destroy())
  return socket
}

/** 读取一条完整 SMTP 应答（多行以「NNN 」结尾行闭合） */
async function readReply(socket: Socket): Promise<Reply> {
  const state = socket as Socket & { __buf?: string }
  state.__buf = state.__buf || ''
  const deadline = Date.now() + 30_000
  for (;;) {
    const lines = state.__buf.split('\r\n')
    let end = -1
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i])) { end = i; break }
    }
    if (end >= 0) {
      state.__buf = lines.slice(end + 1).join('\r\n')
      const replyLines = lines.slice(0, end + 1)
      return { code: Number(replyLines[0].slice(0, 3)), lines: replyLines }
    }
    if (Date.now() > deadline) throw new SmtpError('等待服务器应答超时')
    await new Promise<void>((resolve, reject) => {
      const onData = (chunk: Buffer) => { state.__buf += chunk.toString('utf-8'); cleanup(); resolve() }
      const onErr = (err: Error) => { cleanup(); reject(new SmtpError(`连接中断: ${err.message}`)) }
      const onClose = () => { cleanup(); reject(new SmtpError('连接被服务器关闭')) }
      function cleanup() {
        socket.off('data', onData)
        socket.off('error', onErr)
        socket.off('close', onClose)
      }
      socket.once('data', onData)
      socket.once('error', onErr)
      socket.once('close', onClose)
    })
  }
}

async function command(socket: Socket, line: string | null, expect: number[], what: string): Promise<Reply> {
  if (line !== null) socket.write(line + '\r\n')
  const reply = await readReply(socket)
  if (!expect.includes(reply.code)) {
    throw new SmtpError(`${what} 失败（${reply.code}）: ${(reply.lines[reply.lines.length - 1].slice(4) || reply.lines[0]).trim()}`)
  }
  return reply
}

/** 一封邮件的完整 SMTP 会话；任何一步失败抛错（由 MailService 负责重试） */
export async function smtpSend(cfg: SmtpConfig, mail: { to: string; subject: string; html: string }, timeoutMs: number): Promise<void> {
  let socket = await connectSocket(cfg, timeoutMs)
  try {
    await readReply(socket) // 220 greeting
    let ehlo = await command(socket, 'EHLO workbuddy.local', [250], 'EHLO')
    // 明文端口 + 服务端支持 → STARTTLS 升级（587/25 场景）
    if (!cfg.secure && ehlo.lines.some((l) => /^250[- ]STARTTLS/i.test(l))) {
      await command(socket, 'STARTTLS', [220], 'STARTTLS')
      socket = await new Promise<Socket>((resolve, reject) => {
        const t = tlsConnect({ socket, servername: cfg.host }, () => resolve(t as Socket))
        t.once('error', (err) => reject(new SmtpError(`TLS 升级失败: ${err.message}`)))
      })
      socket.setTimeout(timeoutMs + 5000)
      socket.once('timeout', () => socket.destroy())
      await command(socket, 'EHLO workbuddy.local', [250], 'EHLO(TLS)')
    }
    await command(socket, 'AUTH LOGIN', [334], 'AUTH LOGIN')
    await command(socket, Buffer.from(cfg.user).toString('base64'), [334], 'AUTH 用户名')
    await command(socket, Buffer.from(cfg.pass).toString('base64'), [235], 'AUTH 认证')
    await command(socket, `MAIL FROM:<${cfg.user}>`, [250], 'MAIL FROM')
    await command(socket, `RCPT TO:<${mail.to}>`, [250, 251], 'RCPT TO')
    await command(socket, 'DATA', [354], 'DATA')
    const messageId = `<${Date.now()}.${randomBytes(8).toString('hex')}@workbuddy.local>`
    const headers = [
      `From: ${rfc2047(cfg.fromName)} <${cfg.user}>`,
      `To: <${mail.to}>`,
      `Subject: ${rfc2047(mail.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: ${messageId}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
    ]
    const body64 = Buffer.from(mail.html, 'utf-8').toString('base64').replace(/(.{76})/g, '$1\r\n')
    // 点转义：以 . 开头的行前再加一个点（RFC 5321）
    const payload = (headers.join('\r\n') + '\r\n\r\n' + body64 + '\r\n').replace(/(^|\r\n)\./g, '$1..')
    socket.write(payload + '.\r\n')
    await command(socket, null, [250], '投递')
    await command(socket, 'QUIT', [221], 'QUIT').catch(() => undefined)
  } finally {
    socket.destroy()
  }
}
