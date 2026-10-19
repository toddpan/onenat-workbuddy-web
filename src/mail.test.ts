/**
 * MailService 单测：.env 解析、SMTP 配置读取、开发模式（mock 落库）、
 * 真 SMTP 会话（本地假服务器：EHLO/AUTH LOGIN/MAIL/RCPT/DATA 全流程）、
 * 认证失败不重试、mail-log 记录。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Socket } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MailService, parseDotEnv, readSmtpConfig, type SmtpConfig } from './mail.js'

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'wb-mail-test-'))
}

test('parseDotEnv：注释 / 引号 / export 前缀 / 行内注释', () => {
  const parsed = parseDotEnv([
    '# 邮件服务配置',
    'SMTP_HOST=smtp.163.com',
    'SMTP_PORT="465" # 行内注释',
    "export SMTP_FROM_NAME='OneNat Workbuddy'",
    'SMTP_PASS=abc#not-comment', // # 前无空格：视为值的一部分
    '',
    '=NOKEY',
  ].join('\n'))
  assert.deepEqual(parsed, {
    SMTP_HOST: 'smtp.163.com',
    SMTP_PORT: '465',
    SMTP_FROM_NAME: 'OneNat Workbuddy',
    SMTP_PASS: 'abc#not-comment',
  })
})

test('readSmtpConfig：缺字段 → null（开发模式）；齐全 → 默认 465/SSL', () => {
  assert.equal(readSmtpConfig({} as NodeJS.ProcessEnv), null)
  assert.equal(readSmtpConfig({ SMTP_HOST: 'h', SMTP_USER: 'u' } as NodeJS.ProcessEnv), null)
  const cfg = readSmtpConfig({ SMTP_HOST: 'smtp.163.com', SMTP_USER: 'a@b.c', SMTP_PASS: 'k' } as NodeJS.ProcessEnv)
  assert.deepEqual(cfg, { host: 'smtp.163.com', port: 465, secure: true, user: 'a@b.c', pass: 'k', fromName: 'OneNat WorkBuddy' })
  const cfg2 = readSmtpConfig({ SMTP_HOST: 'h', SMTP_PORT: '587', SMTP_SECURE: 'false', SMTP_USER: 'u', SMTP_PASS: 'p' } as NodeJS.ProcessEnv)
  assert.equal(cfg2?.port, 587)
  assert.equal(cfg2?.secure, false)
})

test('未配置 SMTP：开发模式（mock），mail-log 记录且接口不抛错', async () => {
  const dir = tmpDir()
  try {
    const mail = new MailService(dir, {} as NodeJS.ProcessEnv)
    assert.equal(mail.configured, false)
    const r = await mail.sendInviteMail({ to: 'a@b.c', inviteLink: 'http://x/invite?token=t', expiresAt: Date.now() + 1000 })
    assert.equal(r.ok, false)
    assert.equal(r.status, 'mock')
    const log = JSON.parse(readFileSync(join(dir, 'mail-log.json'), 'utf-8'))
    assert.equal(log.entries.length, 1)
    assert.equal(log.entries[0].status, 'mock')
    assert.equal(log.entries[0].to, 'a@b.c')
    assert.equal(mail.status().configured, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

interface FakeSmtp {
  port: number
  received: () => string
  rcpts: () => string[]
  close: () => Promise<void>
  /** 置为 true：AUTH 一律 535 */
  failAuth: { value: boolean }
}

/** 本地假 SMTP 服务器：支持 EHLO/AUTH LOGIN/MAIL/RCPT/DATA/QUIT */
function startFakeSmtp(): Promise<FakeSmtp> {
  let received = ''
  const rcpts: string[] = []
  const failAuth = { value: false }
  const server = createServer((sock: Socket) => {
    let authStep = 0
    let inData = false
    sock.write('220 fake ESMTP ready\r\n')
    sock.on('error', () => { /* 客户端主动断开忽略 */ })
    sock.on('data', (d) => {
      const chunk = d.toString()
      received += chunk
      if (inData) {
        if (/(^|\r\n)\.\r\n/.test(chunk)) { inData = false; sock.write('250 queued\r\n') }
        return
      }
      for (const line of chunk.split('\r\n')) {
        if (!line) continue
        const up = line.toUpperCase()
        if (up.startsWith('EHLO')) sock.write('250-fake\r\n250-AUTH LOGIN\r\n250 8BITMIME\r\n')
        else if (up.startsWith('AUTH LOGIN')) { authStep = 1; sock.write('334 VXNlcm5hbWU6\r\n') }
        else if (authStep === 1) { authStep = 2; sock.write('334 UGFzc3dvcmQ6\r\n') }
        else if (authStep === 2) { authStep = 0; sock.write(failAuth.value ? '535 authentication failed\r\n' : '235 ok\r\n') }
        else if (up.startsWith('MAIL FROM')) sock.write('250 ok\r\n')
        else if (up.startsWith('RCPT TO')) { rcpts.push(line); sock.write('250 ok\r\n') }
        else if (up.startsWith('DATA')) { inData = true; sock.write('354 go\r\n') }
        else if (up.startsWith('QUIT')) { sock.write('221 bye\r\n'); sock.end() }
        else if (up.startsWith('STARTTLS')) sock.write('454 TLS not available\r\n')
      }
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        port,
        received: () => received,
        rcpts: () => rcpts,
        failAuth,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

async function withFakeSmtp(fn: (fake: FakeSmtp, cfg: SmtpConfig, dataDir: string) => Promise<void>): Promise<void> {
  const fake = await startFakeSmtp()
  const dataDir = tmpDir()
  const env = {
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(fake.port),
    SMTP_SECURE: 'false',
    SMTP_USER: 'wb@test.local',
    SMTP_PASS: 'secret',
    SMTP_FROM_NAME: 'WB 测试',
  } as NodeJS.ProcessEnv
  try {
    await fn(fake, readSmtpConfig(env)!, dataDir)
  } finally {
    await fake.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
}

test('SMTP 全流程：邀请邮件真发成功（命令序列 + mail-log=sent）', async () => {
  await withFakeSmtp(async (fake, cfg, dataDir) => {
    const mail = new MailService(dataDir, {
      SMTP_HOST: cfg.host, SMTP_PORT: String(cfg.port), SMTP_SECURE: 'false',
      SMTP_USER: cfg.user, SMTP_PASS: cfg.pass, SMTP_FROM_NAME: cfg.fromName,
    } as unknown as NodeJS.ProcessEnv)
    assert.equal(mail.configured, true)
    const r = await mail.sendInviteMail({ to: 'alice@example.com', displayName: '爱丽丝', inviteLink: 'http://127.0.0.1:3081/invite?token=tok1', expiresAt: Date.now() + 1000, attempts: 1 })
    assert.equal(r.ok, true, `发送应成功：${r.error || ''}`)
    assert.equal(r.status, 'sent')
    const received = fake.received()
    assert.ok(received.includes('EHLO workbuddy.local'), 'EHLO')
    assert.ok(received.includes('AUTH LOGIN'), 'AUTH LOGIN')
    assert.ok(received.includes(Buffer.from('wb@test.local').toString('base64')), 'AUTH 用户名')
    assert.ok(received.includes(Buffer.from('secret').toString('base64')), 'AUTH 密码')
    assert.ok(received.includes('MAIL FROM:<wb@test.local>'), 'MAIL FROM')
    assert.deepEqual(fake.rcpts(), ['RCPT TO:<alice@example.com>'], 'RCPT TO')
    // 主题 RFC2047 编码后原文不出现在明文中，但 base64 解码可还原
    const subjectB64 = Buffer.from('【OneNat WorkBuddy】账号邀请：请设置密码激活', 'utf-8').toString('base64')
    assert.ok(received.includes(subjectB64), '主题（RFC 2047）')
    // 正文为 base64 传输编码：截取 DATA 载荷解码后校验邀请链接
    const dataIdx = received.indexOf('DATA\r\n') + 6
    const dataPayload = received.slice(dataIdx, received.indexOf('\r\n.\r\n', dataIdx))
    const bodyText = Buffer.from(dataPayload.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n/g, ''), 'base64').toString('utf-8')
    assert.ok(bodyText.includes('http://127.0.0.1:3081/invite?token=tok1'), '正文（base64 解码）含邀请链接')
    const log = JSON.parse(readFileSync(join(dataDir, 'mail-log.json'), 'utf-8'))
    assert.equal(log.entries[0].status, 'sent')
    assert.equal(log.entries[0].to, 'alice@example.com')
    // 管理端 status 回显配置与最近记录（不含密码）
    const st = mail.status()
    assert.equal(st.configured, true)
    assert.equal(st.host, '127.0.0.1')
    assert.equal(st.recent[0].status, 'sent')
    assert.equal(JSON.stringify(st).includes('secret'), false)
  })
})

test('认证失败：不重试（attempts=1），mail-log=failed 带原因', async () => {
  await withFakeSmtp(async (fake, cfg, dataDir) => {
    fake.failAuth.value = true
    const mail = new MailService(dataDir, {
      SMTP_HOST: cfg.host, SMTP_PORT: String(cfg.port), SMTP_SECURE: 'false',
      SMTP_USER: cfg.user, SMTP_PASS: cfg.pass,
    } as unknown as NodeJS.ProcessEnv)
    const r = await mail.sendInviteMail({ to: 'bob@example.com', inviteLink: 'http://x/invite?token=t', expiresAt: Date.now() + 1000, attempts: 3 })
    assert.equal(r.ok, false)
    assert.equal(r.status, 'failed')
    assert.equal(r.attempts, 1, '认证错误不应重试')
    assert.match(r.error || '', /AUTH 认证/)
    const log = JSON.parse(readFileSync(join(dataDir, 'mail-log.json'), 'utf-8'))
    assert.equal(log.entries[0].status, 'failed')
    assert.match(log.entries[0].error, /AUTH 认证/)
  })
})
