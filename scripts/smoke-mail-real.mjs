#!/usr/bin/env node
/**
 * SMTP 发信自检（运维工具）：加载 .env / 环境变量的 SMTP_* 配置，向指定地址
 * （缺省发给 SMTP_USER 自己）发送一封验证邮件，打印结果并以其为退出码。
 *
 * 用法：node scripts/smoke-mail-real.mjs [收件邮箱]
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadDotEnv, MailService, readSmtpConfig } from '../dist/mail.js'

const dataDir = process.env.WORKBUDDY_HOME || join(homedir(), '.onenat-workbuddy')
loadDotEnv(dataDir)
const cfg = readSmtpConfig(process.env)
if (!cfg) {
  console.error('❌ SMTP 未配置：需要 SMTP_HOST / SMTP_USER / SMTP_PASS（可放 .env）')
  process.exit(1)
}
console.log(`SMTP: ${cfg.host}:${cfg.port} secure=${cfg.secure} from="${cfg.fromName}" <${cfg.user}>`)
const to = process.argv[2] || cfg.user
console.log(`向 ${to} 发送验证邮件…`)
const mail = new MailService(dataDir, process.env)
const r = await mail.send({
  type: 'mail_selftest',
  to,
  subject: '【OneNat WorkBuddy】SMTP 发信验证',
  html: `<p>这是一封来自 <b>OneNat WorkBuddy</b> 的 SMTP 配置验证邮件。</p><p>收到即表示邮件通道工作正常，用户邀请将可自动发送。</p>`,
})
if (r.ok) console.log(`✅ 发送成功（第 ${r.attempts} 次尝试）`)
else console.error(`❌ 发送失败（${r.status}，尝试 ${r.attempts} 次）: ${r.error}`)
process.exit(r.ok ? 0 : 1)
