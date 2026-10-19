/**
 * 用户管理与项目成员端到端冒烟（自带临时数据目录，不依赖 mock ONENAT）。
 *
 * 覆盖：管理员登录 → 邀请用户（复制链接模式）→ 链接回显 → 激活登录 →
 * 权限（非管理员 403）→ 项目 owner 自动认领 → 添加/移除项目成员 →
 * 成员隔离（非成员 404 防枚举）→ 最后 owner 保护 → 禁用/启用 → 迁移宽容模式。
 *
 * 运行：node scripts/smoke-users.mjs（先 bash scripts/build-standalone.sh）
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.SMOKE_USERS_PORT || 18095)
const PREFIX = '/onenat-workbuddy'
const BASE = `http://127.0.0.1:${PORT}`

const results = []
let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  if (!ok) failures++
  results.push(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`)
}

let COOKIE = ''
async function req(method, path, body, headers = {}, cookie = COOKIE) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = undefined }
  return { status: res.status, json, headers: res.headers, cookie: (res.headers.get('set-cookie') || '').split(';')[0] }
}
async function login(username, password) {
  const res = await fetch(BASE + `${PREFIX}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const json = await res.json().catch(() => undefined)
  return { status: res.status, json, cookie: (res.headers.get('set-cookie') || '').split(';')[0] }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const procs = []
function spawnJob(name, args, env = {}) {
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const tag = `[${name}]`
  child.stdout.on('data', (d) => { if (process.env.VERBOSE) console.log(tag, String(d)) })
  child.stderr.on('data', (d) => console.error(tag, String(d)))
  procs.push(child)
  return child
}
function cleanup() { for (const p of procs) { try { p.kill('SIGKILL') } catch { /* ignore */ } } }
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(1) })

async function main() {
  if (!existsSync(join(ROOT, 'dist', 'server.js'))) {
    console.error('缺少 dist/server.js —— 先执行: npm run build')
    process.exit(1)
  }
  // 假 SMTP 服务器：验证邀请邮件端到端真发（非 mock 模式）
  const fake = { received: '', rcpts: [] }
  const smtpSrv = createServer((sock) => {
    let authStep = 0
    let inData = false
    sock.write('220 fake ESMTP ready\r\n')
    sock.on('error', () => {})
    sock.on('data', (d) => {
      const chunk = d.toString()
      fake.received += chunk
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
        else if (authStep === 2) { authStep = 0; sock.write('235 ok\r\n') }
        else if (up.startsWith('MAIL FROM')) sock.write('250 ok\r\n')
        else if (up.startsWith('RCPT TO')) { fake.rcpts.push(line); sock.write('250 ok\r\n') }
        else if (up.startsWith('DATA')) { inData = true; sock.write('354 go\r\n') }
        else if (up.startsWith('QUIT')) { sock.write('221 bye\r\n'); sock.end() }
      }
    })
  })
  await new Promise((r) => smtpSrv.listen(0, '127.0.0.1', r))
  const smtpPort = smtpSrv.address().port

  const dataDir = mkdtempSync(join(tmpdir(), 'wb-users-smoke-'))
  // 预置一个「无 owner 存量项目」（模拟升级前的旧数据），验证宽容模式
  writeFileSync(join(dataDir, 'store.json'), JSON.stringify({
    agents: [], tasks: [], schedules: [], teams: [], settings: {},
    projects: [{ id: 'proj-legacy000', name: '存量宽容项目', dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:1' }, expertIds: [], connectorIds: [], skillNames: [], createdAt: Date.now(), updatedAt: Date.now() }],
  }))
  spawnJob('server', [join(ROOT, 'dist', 'server.js'), '--port', String(PORT), '--data', dataDir, '--quiet'], {
    SMTP_HOST: '127.0.0.1',
    SMTP_PORT: String(smtpPort),
    SMTP_SECURE: 'false',
    SMTP_USER: 'wb@test.local',
    SMTP_PASS: 'secret',
    SMTP_FROM_NAME: 'WB 冒烟',
  })
  const t0 = Date.now()
  while (Date.now() - t0 < 20000) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) break } catch { /* retry */ }
    await sleep(200)
  }

  try {
    // ① 管理员登录（种子账号）
    const admin = await login('workbuddy', 'workbuddy-admin')
    check('管理员种子账号可登录', admin.status === 200 && admin.json?.ok, `status=${admin.status}`)
    COOKIE = admin.cookie
    const me = await req('GET', `${PREFIX}/api/auth/me`)
    check('/auth/me 返回 userId/role=admin', me.json?.data?.role === 'admin' && /^usr-/.test(me.json?.data?.userId || ''), JSON.stringify(me.json?.data))

    // ② 邀请用户
    const inv = await req('POST', `${PREFIX}/api/users`, { email: 'Alice@Example.com', displayName: '爱丽丝' })
    check('管理员邀请用户 201 + 邀请链接', inv.status === 201 && /^.*\/invite\?token=/.test(inv.json?.data?.inviteLink || ''), `status=${inv.status}`)
    check('邮箱小写归一化落库', inv.json?.data?.username === 'alice@example.com')
    check('邀请邮件已自动发送（SMTP E2E）', inv.json?.data?.email?.sent === true, JSON.stringify(inv.json?.data?.email))
    check('假 SMTP 收到 RCPT TO', fake.rcpts.some((l) => /rcpt to:<alice@example\.com>/i.test(l)), fake.rcpts.join(' | '))
    const inviteLink = inv.json?.data?.inviteLink || ''
    const inviteToken = new URL(inviteLink).searchParams.get('token') || ''

    // 重复邮箱 409
    const dup = await req('POST', `${PREFIX}/api/users`, { email: 'alice@example.com' })
    check('重复邮箱 409', dup.status === 409)

    // ③ 邀请回显（公开，无需登录）
    const info = await req('GET', `${PREFIX}/api/invitations/${inviteToken}`, undefined, {}, '')
    check('邀请回显公开可用', info.status === 200 && info.json?.data?.valid === true && info.json?.data?.email === 'alice@example.com')
    const badInfo = await req('GET', `${PREFIX}/api/invitations/not-a-real-token`, undefined, {}, '')
    check('无效 token 回显 invalid', badInfo.json?.data?.valid === false)

    // ④ 激活（弱密码 → 拒；正常 → 自动登录会话）
    const weakPw = await req('POST', `${PREFIX}/api/invitations/${inviteToken}`, { password: 'abcdefghij' }, {}, '')
    check('弱密码（无数字）拒绝', weakPw.status === 400)
    const accept = await req('POST', `${PREFIX}/api/invitations/${inviteToken}`, { password: 'Passw0rd123', displayName: '爱丽丝' }, {}, '')
    check('激活成功并自动登录', accept.status === 200 && accept.json?.ok === true && accept.cookie, `status=${accept.status} body=${JSON.stringify(accept.json)} cookie=${accept.cookie ? 'yes' : 'no'}`)
    const aliceCookie = accept.cookie || ''
    const reuse = await req('POST', `${PREFIX}/api/invitations/${inviteToken}`, { password: 'Passw0rd123' }, {}, '')
    check('token 一次性（重复使用拒绝）', reuse.status === 400)

    // ⑤ 普通用户权限
    const aliceMe = await req('GET', `${PREFIX}/api/auth/me`, undefined, {}, aliceCookie)
    check('alice me：role=user', aliceMe.json?.data?.role === 'user')
    const forbidden = await req('GET', `${PREFIX}/api/users`, undefined, {}, aliceCookie)
    check('非管理员访问 /api/users 403', forbidden.status === 403)
    const adminList = await req('GET', `${PREFIX}/api/users`)
    check('管理员用户列表含 alice（invited→active）', adminList.json?.data?.some((u) => u.username === 'alice@example.com' && u.status === 'active'))
    const mailSt = await req('GET', `${PREFIX}/api/users/mail-status`)
    check('邮件状态：已配置 SMTP', mailSt.json?.data?.configured === true && mailSt.json?.data?.host === '127.0.0.1', JSON.stringify({ configured: mailSt.json?.data?.configured, host: mailSt.json?.data?.host }))
    let mailLogOk = false
    try {
      const log = JSON.parse(readFileSync(join(dataDir, 'mail-log.json'), 'utf-8'))
      mailLogOk = (log.entries || []).some((e) => e.status === 'sent' && e.to === 'alice@example.com')
    } catch { /* 文件缺失视为失败 */ }
    check('mail-log 记录 sent', mailLogOk)

    // ⑥ 项目：管理员创建 → owner 自动认领；添加 alice 为成员
    const proj = await req('POST', `${PREFIX}/api/projects`, { name: '权限冒烟项目', dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:1' } })
    check('创建项目成功', proj.status === 200 && proj.json?.ok, JSON.stringify(proj.json?.error))
    const pid = proj.json?.data?.id
    check('创建者自动成为 owner', proj.json?.data?.owner === me.json?.data?.userId)
    check('成员隔离已启用', proj.json?.data?.isolated === true)
    const addM = await req('POST', `${PREFIX}/api/projects/${pid}/members`, { username: 'alice@example.com' })
    check('owner 添加 alice 为成员', addM.status === 200 && (addM.json?.data?.members || []).some((m) => m.role === 'member'))
    const addDup = await req('POST', `${PREFIX}/api/projects/${pid}/members`, { username: 'alice@example.com' })
    check('重复添加 409', addDup.status === 409)

    // ⑦ 成员可见 / 非成员不可见（防枚举 404）
    const aliceView = await req('GET', `${PREFIX}/api/projects/${pid}`, undefined, {}, aliceCookie)
    check('成员可见项目', aliceView.status === 200)
    // 再邀请 bob（不加入项目），验证非成员 404
    const bobInv = await req('POST', `${PREFIX}/api/users`, { email: 'bob@example.com' })
    const bobToken = new URL(bobInv.json?.data?.inviteLink || '', BASE).searchParams.get('token') || ''
    const bobAccept = await req('POST', `${PREFIX}/api/invitations/${bobToken}`, { password: 'Passw0rd123' }, {}, '')
    const bobCookie = bobAccept.cookie || ''

    // ⑦b 重发邀请：旧 token 作废 + 新链接邮件自动重发
    const carolInv = await req('POST', `${PREFIX}/api/users`, { email: 'carol@example.com' })
    check('carol 邀请邮件自动发送', carolInv.json?.data?.email?.sent === true, JSON.stringify(carolInv.json?.data?.email))
    const carolRe = await req('POST', `${PREFIX}/api/users/${carolInv.json?.data?.userId}/resend-invite`)
    check('重发邀请邮件自动发送', carolRe.status === 200 && carolRe.json?.data?.email?.sent === true, JSON.stringify(carolRe.json?.data?.email))
    const carolToken = new URL(carolRe.json?.data?.inviteLink).searchParams.get('token') || ''
    const carolAccept = await req('POST', `${PREFIX}/api/invitations/${carolToken}`, { password: 'Passw0rd123' }, {}, '')
    check('重发后的新 token 可激活（旧 token 已作废）', carolAccept.status === 200, `status=${carolAccept.status}`)
    const bobView = await req('GET', `${PREFIX}/api/projects/${pid}`, undefined, {}, bobCookie)
    check('非成员访问项目 404（防枚举）', bobView.status === 404, `status=${bobView.status}`)
    const bobList = await req('GET', `${PREFIX}/api/projects`, undefined, {}, bobCookie)
    check('项目列表对非成员隐藏', !(bobList.json?.data || []).some((p) => p.id === pid))

    // ⑧ alice（member）不可编辑/删除；不可移除他人
    const aliceEdit = await req('PATCH', `${PREFIX}/api/projects/${pid}`, { name: 'x' }, {}, aliceCookie)
    check('member 编辑项目 403', aliceEdit.status === 403)
    const aliceDel = await req('DELETE', `${PREFIX}/api/projects/${pid}`, undefined, {}, aliceCookie)
    check('member 删除项目 403', aliceDel.status === 403)
    const aliceKick = await req('DELETE', `${PREFIX}/api/projects/${pid}/members/${me.json?.data?.userId}`, undefined, {}, aliceCookie)
    check('member 移除他人 403', aliceKick.status === 403)

    // ⑨ 最后 owner 保护 + 成员移除 + alice 自行退出
    const kickOwner = await req('DELETE', `${PREFIX}/api/projects/${pid}/members/${me.json?.data?.userId}`)
    check('不能移除最后一个 owner 422', kickOwner.status === 422)
    const leave = await req('DELETE', `${PREFIX}/api/projects/${pid}/members/${aliceMe.json?.data?.userId}`, undefined, {}, aliceCookie)
    check('member 自行退出成功', leave.status === 200)
    const reView = await req('GET', `${PREFIX}/api/projects/${pid}`, undefined, {}, aliceCookie)
    check('退出后失去访问（404）', reView.status === 404)

    // ⑩ 禁用/启用；admin 保护
    const users = (await req('GET', `${PREFIX}/api/users`)).json?.data || []
    const alice = users.find((u) => u.username === 'alice@example.com')
    const dis = await req('POST', `${PREFIX}/api/users/${alice.id}/disable`)
    check('禁用用户', dis.status === 200)
    const aliceLogin = await login('alice@example.com', 'Passw0rd123')
    check('禁用后不可登录', aliceLogin.status === 401)
    const oldCookieWorks = await req('GET', `${PREFIX}/api/auth/me`, undefined, {}, aliceCookie)
    check('禁用后旧会话失效', oldCookieWorks.status === 401)
    check('启用用户', (await req('POST', `${PREFIX}/api/users/${alice.id}/enable`)).status === 200)
    check('重新可登录', (await login('alice@example.com', 'Passw0rd123')).status === 200)

    // ⑪ 迁移宽容模式：存量无 owner 项目所有人可见（预置于数据目录）
    const legacyView = await req('GET', `${PREFIX}/api/projects/proj-legacy000`, undefined, {}, bobCookie)
    check('无 owner 存量项目宽容模式（非成员可见）', legacyView.status === 200, `status=${legacyView.status}`)
    const bobLegacyList = await req('GET', `${PREFIX}/api/projects`, undefined, {}, bobCookie)
    check('存量项目出现在非成员项目列表', (bobLegacyList.json?.data || []).some((p) => p.id === 'proj-legacy000'))

    // ⑫ 邀请页（公开 HTML）
    const page = await fetch(`${BASE}${PREFIX}/invite?token=whatever`)
    const pageText = await page.text()
    check('邀请页公开可访问', page.status === 200 && pageText.includes('激活账号'))
  } finally {
    cleanup()
    try { smtpSrv.close() } catch { /* ignore */ }
    try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  console.log(results.join('\n'))
  console.log(`\n${failures === 0 ? '✅ 全部通过' : '❌ 失败 ' + failures + ' 项'}（共 ${results.length} 项）`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('冒烟执行异常:', err)
  cleanup()
  process.exit(1)
})
