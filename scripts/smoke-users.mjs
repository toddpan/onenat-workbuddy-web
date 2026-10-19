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

/** 最近一封被假 SMTP 收下的邮件正文（服务端已解码） */
function lastMailBody(mails) {
  const list = mails || []
  return list[list.length - 1] || ''
}

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
  const fake = { received: '', rcpts: [], mails: [] }
  const smtpSrv = createServer((sock) => {
    let authStep = 0
    let inData = false
    let dataBuf = ''
    sock.write('220 fake ESMTP ready\r\n')
    sock.on('error', () => {})
    sock.on('data', (d) => {
      const chunk = d.toString()
      fake.received += chunk
      if (inData) {
        dataBuf += chunk
        if (/(^|\r\n)\.\r\n/.test(chunk)) {
          inData = false
          const payload = dataBuf.slice(0, dataBuf.indexOf('\r\n.\r\n'))
          const bodyB64 = payload.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n/g, '')
          try { fake.mails.push(Buffer.from(bodyB64, 'base64').toString('utf-8')) } catch { /* 忽略坏帧 */ }
          dataBuf = ''
          sock.write('250 queued\r\n')
        }
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
        else if (up.startsWith('DATA')) { inData = true; dataBuf = ''; sock.write('354 go\r\n') }
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

  // ⑬ 用户过滤 / 个人资料（U-08/U-12）
  const grace = await req('POST', `${PREFIX}/api/users`, { email: 'grace@example.com', displayName: '格蕾丝' })
  check('邀请 grace（供过滤用）', grace.status === 201)
  const qAlice = await req('GET', `${PREFIX}/api/users?q=alice`)
  check('用户过滤 ?q=', (qAlice.json?.data || []).length >= 1 && (qAlice.json?.data || []).every((u) => (u.username + (u.displayName || '')).toLowerCase().includes('alice')))
  const qInvited = await req('GET', `${PREFIX}/api/users?status=invited`)
  check('用户过滤 ?status=invited', (qInvited.json?.data || []).length >= 1 && (qInvited.json?.data || []).every((u) => u.status === 'invited'))
  const prof = await req('PUT', `${PREFIX}/api/users/me/profile`, { displayName: '管理员甲' })
  check('PUT /users/me/profile 改自己昵称', prof.status === 200 && prof.json?.data?.displayName === '管理员甲')
  const profNoLogin = await req('PUT', `${PREFIX}/api/users/me/profile`, { displayName: 'x' }, {}, '')
  check('未登录改昵称 401', profNoLogin.status === 401)

  // ⑭ 忘记密码/重置（U-07，假 SMTP 报文解码链接）
  const fpGhost = await req('POST', `${PREFIX}/api/auth/forgot-password`, { email: 'ghost@example.com' }, {}, '')
  check('forgot-password 恒 202（未知邮箱不泄露）', fpGhost.status === 202)
  const fpAlice = await req('POST', `${PREFIX}/api/auth/forgot-password`, { email: 'alice@example.com' }, {}, '')
  check('forgot-password 202（已注册）', fpAlice.status === 202)
  await sleep(300)
  const resetToken = (lastMailBody(fake.mails).match(/reset\?token=([A-Za-z0-9_-]+)/) || [])[1]
  check('重置邮件含链接 token（SMTP 报文解码）', Boolean(resetToken))
  const weakReset = await req('POST', `${PREFIX}/api/auth/reset-password`, { token: resetToken, newPassword: 'abcdefghij' }, {}, '')
  check('弱密码重置拒绝', weakReset.status === 400)
  const resetOk = await req('POST', `${PREFIX}/api/auth/reset-password`, { token: resetToken, newPassword: 'NewPass0rd9' }, {}, '')
  check('重置成功', resetOk.status === 200)
  check('旧密码失效', (await login('alice@example.com', 'Passw0rd123')).status === 401)
  const aliceRe = await login('alice@example.com', 'NewPass0rd9')
  check('新密码可登录', aliceRe.status === 200)
  const aliceCookie2 = aliceRe.cookie || ''

  // ⑮ 项目邮件邀请全流程（P-04/05/09）
  const invD = await req('POST', `${PREFIX}/api/projects/${pid}/invitations`, { email: 'dave@example.com' })
  check('owner 邮件邀请 201 + 邮件已发', invD.status === 201 && invD.json?.data?.emailSent === true, JSON.stringify(invD.json?.data))
  const invDTok = new URL(invD.json?.data?.inviteLink).searchParams.get('token')
  const insD = await req('GET', `${PREFIX}/api/project-invitations/${invDTok}`, undefined, {}, '')
  check('项目邀请回显（projectName/account=none）', insD.json?.data?.valid === true && insD.json?.data?.account === 'none' && insD.json?.data?.projectName === '权限冒烟项目')
  const dupInv = await req('POST', `${PREFIX}/api/projects/${pid}/invitations`, { email: 'dave@example.com' })
  check('同邮箱重复 pending 409', dupInv.status === 409)
  const invB = await req('POST', `${PREFIX}/api/projects/${pid}/invitations`, { email: 'bob@example.com' })
  const invBTok = new URL(invB.json?.data?.inviteLink).searchParams.get('token')
  const noSessAcc = await req('POST', `${PREFIX}/api/project-invitations/${invBTok}`, {}, {}, '')
  check('active 用户无会话接受 401', noSessAcc.status === 401)
  // 未注册 dave：一步设置密码入项（自动登录）
  const accD = await req('POST', `${PREFIX}/api/project-invitations/${invDTok}`, { password: 'Passw0rd123', displayName: '戴夫' }, {}, '')
  check('未注册一步注册入项', accD.status === 200 && accD.json?.data?.newSession === true && accD.cookie, JSON.stringify(accD.json))
  check('dave 入项后可见项目', (await req('GET', `${PREFIX}/api/projects/${pid}`, undefined, {}, accD.cookie)).status === 200)
  // 已注册 bob：登录后接受
  const bobRe = await login('bob@example.com', 'Passw0rd123')
  const accB = await req('POST', `${PREFIX}/api/project-invitations/${invBTok}`, {}, {}, bobRe.cookie)
  check('已注册登录后接受', accB.status === 200 && accB.json?.data?.newSession === false, JSON.stringify(accB.json))
  check('bob 入项后可见项目', (await req('GET', `${PREFIX}/api/projects/${pid}`, undefined, {}, bobRe.cookie)).status === 200)
  check('已成员再邀请 409', (await req('POST', `${PREFIX}/api/projects/${pid}/invitations`, { email: 'bob@example.com' })).status === 409)
  // 邀请列表 / 撤销（eve）
  const invE = await req('POST', `${PREFIX}/api/projects/${pid}/invitations`, { email: 'eve@example.com' })
  const invETok = new URL(invE.json?.data?.inviteLink).searchParams.get('token')
  const invList = await req('GET', `${PREFIX}/api/projects/${pid}/invitations`)
  const invEId = (invList.json?.data?.invitations || []).find((x) => x.email === 'eve@example.com')?.id
  check('邀请列表含 pending', Boolean(invEId))
  check('撤销邀请', (await req('POST', `${PREFIX}/api/projects/${pid}/invitations/${invEId}/revoke`)).status === 200)
  check('撤销后接受被拒', (await req('POST', `${PREFIX}/api/project-invitations/${invETok}`, { password: 'Passw0rd123' }, {}, '')).status === 400)
  // 重发（frank）：旧 token 失效、新 token 有效
  const invF = await req('POST', `${PREFIX}/api/projects/${pid}/invitations`, { email: 'frank@example.com' })
  const invFTokOld = new URL(invF.json?.data?.inviteLink).searchParams.get('token')
  const invFId = (await req('GET', `${PREFIX}/api/projects/${pid}/invitations`)).json?.data?.invitations.find((x) => x.email === 'frank@example.com')?.id
  const rsnd = await req('POST', `${PREFIX}/api/projects/${pid}/invitations/${invFId}/resend`)
  check('重发邀请 200 + 新链接', rsnd.status === 200 && Boolean(rsnd.json?.data?.inviteLink))
  const invFTokNew = new URL(rsnd.json?.data?.inviteLink).searchParams.get('token')
  check('重发后旧 token 失效', (await req('GET', `${PREFIX}/api/project-invitations/${invFTokOld}`, undefined, {}, '')).json?.data?.valid === false)
  check('重发后新 token 有效', (await req('GET', `${PREFIX}/api/project-invitations/${invFTokNew}`, undefined, {}, '')).json?.data?.valid === true)
  // member 不能管理邀请
  check('member 邀请他人 403', (await req('POST', `${PREFIX}/api/projects/${pid}/invitations`, { email: 'x9@example.com' }, {}, accD.cookie)).status === 403)

  // ⑯ 成员角色 / owner 转让 / 归档恢复（P-06/07/08）
  const membersNow = (await req('GET', `${PREFIX}/api/projects/${pid}/members`)).json?.data?.members || []
  const bobId = (membersNow.find((m) => (m.userInfo?.username === 'bob@example.com')) || {}).userId
  const adminId = me.json?.data?.userId
  check('owner 升级成员为 owner', (await req('PUT', `${PREFIX}/api/projects/${pid}/members/${bobId}`, { role: 'owner' })).status === 200)
  check('降级自己（仍有其他 owner）', (await req('PUT', `${PREFIX}/api/projects/${pid}/members/${adminId}`, { role: 'member' })).status === 200)
  check('member 改角色 403', (await req('PUT', `${PREFIX}/api/projects/${pid}/members/${bobId}`, { role: 'member' }, {}, accD.cookie)).status === 403)
  check('scope=owned 视图（dave 非 owner）', !((await req('GET', `${PREFIX}/api/projects?scope=owned`, undefined, {}, accD.cookie)).json?.data || []).some((p) => p.id === pid))
  check('scope=joined 视图含项目', ((await req('GET', `${PREFIX}/api/projects?scope=joined`, undefined, {}, accD.cookie)).json?.data || []).some((p) => p.id === pid))
  check('member 归档 403', (await req('POST', `${PREFIX}/api/projects/${pid}/archive`, {}, {}, accD.cookie)).status === 403)
  // admin（owner）归档
  const arch = await req('POST', `${PREFIX}/api/projects/${pid}/archive`)
  check('owner 归档项目', arch.status === 200 && arch.json?.data?.archived === true)
  check('归档后编辑 400', (await req('PATCH', `${PREFIX}/api/projects/${pid}`, { name: 'x' })).status === 400)
  check('归档后加成员 400', (await req('POST', `${PREFIX}/api/projects/${pid}/members`, { username: 'bob@example.com' })).status === 400)
  const taskArch = await req('POST', `${PREFIX}/api/tasks`, { projectId: pid, name: 't', message: 'x' })
  check('归档后发任务被拒', taskArch.status === 400 && /归档/.test(taskArch.json?.error || ''), JSON.stringify(taskArch.json))
  check('恢复项目', (await req('POST', `${PREFIX}/api/projects/${pid}/restore`)).status === 200)
  // owner 转让：admin（现 owner）→ bob；随后唯一 owner 保护
  const trans = await req('POST', `${PREFIX}/api/projects/${pid}/ownership-transfer`, { targetMemberId: bobId })
  check('owner 转让', trans.status === 200 && trans.json?.data?.owner === bobId)
  check('唯一 owner 自退被拒 422', (await req('DELETE', `${PREFIX}/api/projects/${pid}/members/${bobId}`, undefined, {}, bobRe.cookie)).status === 422)

  // ⑰ 审计日志（B-03）
  const audit = await req('GET', `${PREFIX}/api/audit-log?limit=100`)
  check('审计日志接口含关键动作', audit.status === 200 && ['project.invite.accept', 'project.member.role', 'project.archive', 'auth.password_reset'].every((a) => (audit.json?.data || []).some((e) => e.action === a)),
    JSON.stringify((audit.json?.data || []).slice(0, 3)))
  check('非管理员审计 403', (await req('GET', `${PREFIX}/api/audit-log`, undefined, {}, aliceCookie2)).status === 403)

  // ⑱ 邮件接口限流（B-04）：同邮箱第 6 次 429
  let lastInviteStatus = 0
  for (let i = 0; i < 6; i++) lastInviteStatus = (await req('POST', `${PREFIX}/api/users`, { email: 'ratelimit@example.com' })).status
  check('同邮箱邀请第 6 次 429', lastInviteStatus === 429, `last=${lastInviteStatus}`)
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
