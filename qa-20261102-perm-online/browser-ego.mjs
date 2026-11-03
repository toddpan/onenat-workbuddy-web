/**
 * 线上控制台（https://natpass.yikaihui.com/onenat-workbuddy/）真实 Chromium 验收 —— ego-lite
 *
 * 运行：
 *   WB_ADMIN_PASS='***' node qa-20261102-perm-online/qa-env-online.mjs            # 先造数
 *   ego-browser nodejs < qa-20261102-perm-online/browser-ego.mjs                  # 再跑浏览器验收
 *   WB_ADMIN_PASS='***' node qa-20261102-perm-online/qa-env-online.mjs --cleanup   # 最后清理
 *
 * 覆盖（§10 权限模型扩展在线走查）：
 *   管理员：登录 → 控制台 → 子智能体（归属卡片可删）→ 项目 → 设置(SSH 池管理员卡)→ 监控大屏 → 资源目录
 *   普通用户：登录 → 子智能体（共享卡片可见但无删除按钮 / 未绑定卡片不可见）→ 设置(SSH 池管理员卡隐藏)
 *   移动端：375×812 视口无横向溢出（管理员复登后）
 *   全程：JS 错误收集（console.error / pageerror / unhandledrejection），分阶段取样
 *
 * 注：同一浏览器共享 Cookie，切换账号必须先 logout（脚本已处理）。
 */
const fs = await import('node:fs/promises')

const STATE = JSON.parse(await fs.readFile('/tmp/wb-ego-perm-state.json', 'utf8'))
const OUT = '/Users/tsbj/feyanggit/DHS-test/onenat-workbuddy-web/qa-20261102-perm-online'
const results = []
function rec(id, name, pass, detail) {
  const row = { id, name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) }
  results.push(row)
  console.log(`${row.pass ? 'PASS' : 'FAIL'} [${id}] ${name}${row.detail ? ' — ' + row.detail : ''}`)
  return row.pass
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 页面启动即注入：错误捕获（pageerror / unhandledrejection / console.error） */
const INIT_JS = `(function(){
  window.__qaErrors = [];
  window.addEventListener('error', function(e){ window.__qaErrors.push('pageerror: ' + (e && e.message ? e.message : String(e))); });
  window.addEventListener('unhandledrejection', function(e){ var r = e && e.reason; window.__qaErrors.push('unhandledrejection: ' + (r && r.message ? r.message : String(r))); });
  var oe = console.error;
  console.error = function(){ var a = Array.prototype.slice.call(arguments).map(function(x){ return (x && x.stack) ? String(x.stack) : String(x); }).join(' '); window.__qaErrors.push('console.error: ' + a); return oe.apply(console, arguments); };
})();`

const task = await taskSpace('wb-ego-perm')

/** 退出登录（同一浏览器共享 Cookie，必须先退出才能换账号） */
async function logout(page) {
  await page.evaluate(async () => {
    try { await fetch('/onenat-workbuddy/api/auth/logout', { method: 'POST' }) } catch (e) { /* ignore */ }
  }).catch(() => {})
  await page.reload()
  await page.waitForSelector('#username', { state: 'visible', timeout: 20000 })
  await sleep(500)
}

/** 登录并等待控制台就绪 */
async function login(page, user, pass) {
  await page.waitForSelector('#username', { state: 'visible', timeout: 20000 })
  await page.fill('#username', user)
  await page.fill('#password', pass)
  await page.click('#btn')
  await page.waitForSelector('#view-work', { state: 'visible', timeout: 30000 })
  await page.waitForFunction(() => {
    const t = document.getElementById('onenat-text')
    return t && t.textContent && t.textContent.indexOf('连接中') === -1
  }, undefined, { timeout: 30000 }).catch(() => {})
  await sleep(1000)
}

/** 读取页面关键事实 */
async function facts(page) {
  return await page.evaluate(() => {
    const q = (s) => document.querySelector(s)
    const qa = (s) => Array.prototype.slice.call(document.querySelectorAll(s || ''))
    const cards = qa('#agent-list .agent-card')
    const projCards = qa('.proj-card')
    const sshCard = q('#ssh-pool-card')
    const monView = q('#view-monitor')
    const resView = q('#view-resources')
    const find = (name) => cards.find((c) => String(c.textContent || '').indexOf(name) >= 0) || null
    const shared = find('QA-EGO 共享子智能体')
    return {
      version: (q('#version-text') || {}).textContent || '',
      onenat: (q('#onenat-text') || {}).textContent || '',
      onenatOk: Boolean(q('#onenat-dot') && q('#onenat-dot').className.indexOf('bad') === -1),
      navCount: qa('#nav button[data-v]').length,
      views: qa('.view.on').map((v) => v.id),
      agentCount: cards.length,
      sharedCard: Boolean(shared),
      sharedHasDel: shared ? Boolean(shared.querySelector('[data-op=del]')) : null,
      unboundCard: Boolean(find('QA-EGO 未绑定子智能体')),
      legacyDelBtns: cards.filter((c) => c.querySelector('[data-op=del]')).length,
      projCount: projCards.length,
      projHasQa: projCards.some((c) => String(c.textContent || '').indexOf('QA-EGO 权限项目') >= 0),
      sshCardVisible: Boolean(sshCard) && sshCard.offsetParent !== null && sshCard.style.display !== 'none',
      sshRows: qa('#ssh-body tr').length,
      sshHasQa: qa('#ssh-body tr').some((tr) => String(tr.textContent || '').indexOf('QA-EGO SSH 资源') >= 0),
      monTextLen: monView ? String(monView.textContent || '').replace(/\s+/g, ' ').trim().length : 0,
      monAgents: qa('#view-monitor .mon-agent').length,
      resTextLen: resView ? String(resView.textContent || '').replace(/\s+/g, ' ').trim().length : 0,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      errors: (window.__qaErrors || []).slice(),
      url: location.href,
    }
  })
}

/** 切到指定视图（走真实导航点击） */
async function gotoView(page, v) {
  const inMore = ['settings', 'resources', 'library', 'plugins', 'voice', 'schedules', 'files', 'experts', 'archive']
  if (inMore.includes(v)) {
    await page.click('#nav-more-btn')
    await sleep(300)
    await page.click(`button[data-v="${v}"]`)
  } else {
    await page.click(`#nav button[data-v="${v}"]`)
  }
  await page.waitForFunction((id) => {
    const el = document.getElementById(id)
    return el && el.classList.contains('on')
  }, 'view-' + v, { timeout: 15000 })
  await sleep(1200)
}

// ================= 阶段一：管理员（桌面 1440×900） =================
const p1 = task.page('p1')
await p1.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await p1.cdp('Page.addScriptToEvaluateOnNewDocument', { source: INIT_JS })
await p1.goto(STATE.base + '/')
await p1.waitForSelector('#username', { state: 'visible', timeout: 20000 }).catch(async () => {
  console.log('[phase1] 已有登录态，先退出')
  await logout(p1)
})
await p1.screenshot({ path: OUT + '/admin-01-login.png' })
const loginPage = await p1.evaluate(() => ({
  hasUser: Boolean(document.getElementById('username')),
  hasPass: Boolean(document.getElementById('password')),
  hasBtn: Boolean(document.getElementById('btn')),
  title: document.title,
}))
rec('A1', '登录页渲染（用户名/密码/登录按钮）', loginPage.hasUser && loginPage.hasPass && loginPage.hasBtn, JSON.stringify(loginPage))

await login(p1, STATE.admin.user, STATE.admin.pass)
const adminHome = await facts(p1)
rec('A2', '管理员登录后进入控制台（工作台视图）', adminHome.views.includes('view-work'), 'views=' + adminHome.views.join(','))
rec('A3', '版本号与线上部署一致', /v2026\.11\.1/.test(adminHome.version), 'version=' + adminHome.version)
rec('A4', 'ONENAT 资源目录已连接', adminHome.onenatOk && adminHome.onenat.indexOf('连接中') === -1, 'chip=' + adminHome.onenat)
rec('A5', '导航页签齐全', adminHome.navCount >= 5, 'nav buttons=' + adminHome.navCount)
await p1.screenshot({ path: OUT + '/admin-02-work.png' })

await gotoView(p1, 'agents')
await p1.waitForFunction(() => document.querySelectorAll('#agent-list .agent-card').length > 0, undefined, { timeout: 20000 }).catch(() => {})
const adminAgents = await facts(p1)
rec('A6', '子智能体列表在线渲染', adminAgents.agentCount > 0, 'cards=' + adminAgents.agentCount)
rec('A7', '归属=管理员的 QA 子智能体可见', adminAgents.sharedCard, 'shared=' + adminAgents.sharedCard)
rec('A8', '管理员对归属实体保留写面（删除按钮可见）', adminAgents.sharedHasDel === true, 'delBtn=' + adminAgents.sharedHasDel)
await p1.screenshot({ path: OUT + '/admin-03-agents.png' })

await gotoView(p1, 'projects')
const adminProjects = await facts(p1)
rec('A9', '项目列表在线渲染且含 QA 项目', adminProjects.projCount > 0 && adminProjects.projHasQa, 'cards=' + adminProjects.projCount)
await p1.screenshot({ path: OUT + '/admin-04-projects.png' })

await gotoView(p1, 'settings')
await sleep(1500)
const adminSettings = await facts(p1)
rec('A10', '设置页 SSH 资源池管理员卡可见', adminSettings.sshCardVisible, 'visible=' + adminSettings.sshCardVisible)
rec('A11', 'SSH 资源池含 QA 资源行', adminSettings.sshHasQa, 'rows=' + adminSettings.sshRows)
await p1.screenshot({ path: OUT + '/admin-05-settings-ssh.png' })

await gotoView(p1, 'monitor')
await sleep(2000)
const adminMonitor = await facts(p1)
rec('A12', '监控大屏在线渲染', adminMonitor.monTextLen > 50, 'textLen=' + adminMonitor.monTextLen + ' agents=' + adminMonitor.monAgents)
await p1.screenshot({ path: OUT + '/admin-06-monitor.png' })

await gotoView(p1, 'resources')
await sleep(2000)
const adminRes = await facts(p1)
rec('A13', 'ONENAT 资源目录在线渲染', adminRes.resTextLen > 50, 'textLen=' + adminRes.resTextLen)
await p1.screenshot({ path: OUT + '/admin-07-resources.png' })
const adminErrors = await p1.evaluate(() => (window.__qaErrors || []).slice())

// ================= 阶段二：普通用户（同页签换号） =================
await logout(p1)
await login(p1, STATE.member.user, STATE.member.pass)
const memberHome = await facts(p1)
const meInfo = await p1.evaluate(async () => {
  const r = await fetch('/onenat-workbuddy/api/auth/me')
  try { return await r.json() } catch (e) { return null }
})
rec('B1', '普通用户登录成功并进入控制台（角色=user，控制台非登录页）',
  memberHome.views.length > 0 && meInfo?.data?.role === 'user',
  'views=' + memberHome.views.join(',') + ' me=' + JSON.stringify(meInfo?.data || {}))

await gotoView(p1, 'agents')
await p1.waitForFunction(() => document.querySelectorAll('#agent-list .agent-card').length > 0, undefined, { timeout: 20000 }).catch(() => {})
const memberAgents = await facts(p1)
rec('B2', '普通用户可见项目显式共享的子智能体', memberAgents.sharedCard, 'shared=' + memberAgents.sharedCard)
rec('B3', '普通用户对他人归属子智能体无写面（无删除按钮）', memberAgents.sharedCard && memberAgents.sharedHasDel === false, 'delBtn=' + memberAgents.sharedHasDel)
rec('B4', '普通用户看不到未绑定的子智能体', !memberAgents.unboundCard, 'unboundVisible=' + memberAgents.unboundCard)
rec('B5', '普通用户可见存量智能体（宽容模式）但无写面', memberAgents.agentCount >= 10 && memberAgents.legacyDelBtns === 0,
  'cards=' + memberAgents.agentCount + ' withDelBtn=' + memberAgents.legacyDelBtns)
await p1.screenshot({ path: OUT + '/member-01-agents.png' })

await gotoView(p1, 'settings')
await sleep(1500)
const memberSettings = await facts(p1)
rec('B6', '普通用户看不到 SSH 资源池管理员卡', !memberSettings.sshCardVisible, 'visible=' + memberSettings.sshCardVisible)
await p1.screenshot({ path: OUT + '/member-02-settings.png' })
const memberErrors = await p1.evaluate(() => (window.__qaErrors || []).slice())

// ================= 阶段三：移动端（375×812，微信 X5 兼容基线） =================
await logout(p1)
await login(p1, STATE.admin.user, STATE.admin.pass)
await p1.cdp('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true })
await gotoView(p1, 'work')
await sleep(1200)
const mobile = await facts(p1)
rec('C1', '移动端 375×812 无横向溢出', mobile.overflow <= 2, 'overflow=' + mobile.overflow)
await p1.screenshot({ path: OUT + '/mobile-01-work.png' })
await gotoView(p1, 'agents')
await p1.waitForFunction(() => document.querySelectorAll('#agent-list .agent-card').length > 0, undefined, { timeout: 20000 }).catch(() => {})
const mobileAgents = await facts(p1)
rec('C2', '移动端子智能体页可用（卡片渲染）', mobileAgents.agentCount > 0, 'cards=' + mobileAgents.agentCount)
await p1.screenshot({ path: OUT + '/mobile-02-agents.png' })
await p1.cdp('Emulation.clearDeviceMetricsOverride')

// ================= JS 错误汇总 =================
rec('D1', '管理员流程无 JS 错误', adminErrors.length === 0, adminErrors.slice(0, 3).join(' | '))
rec('D2', '普通用户流程无 JS 错误', memberErrors.length === 0, memberErrors.slice(0, 3).join(' | '))

const failures = results.filter((r) => !r.pass).length
console.log(`\n${failures === 0 ? '✅ 全部通过' : '❌ 失败 ' + failures + ' 项'}（共 ${results.length} 项）`)
await fs.writeFile(OUT + '/browser-result.json', JSON.stringify({
  at: new Date().toISOString(),
  base: STATE.base,
  total: results.length,
  failures,
  results,
  adminErrors,
  memberErrors,
}, null, 2))
console.log('结果已写入 ' + OUT + '/browser-result.json')
