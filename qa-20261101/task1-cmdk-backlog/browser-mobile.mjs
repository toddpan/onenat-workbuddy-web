/**
 * TASK-1「backlog 条目接入 ⌘K 全局检索」——移动端 390x844 + 微信 X5 UA 真实 Chromium 验收（ego-browser）
 *
 * 运行（先起 qa-env.mjs，且已跑过 browser-desktop.mjs 复用同一 TaskSpace/Page）：
 *   cd <repo>
 *   ego-browser nodejs < qa-20261101/task1-cmdk-backlog/browser-mobile.mjs
 *
 * 输出：控制台逐条 AC 结果 + 截图 + /tmp/task1-cmdk-mobile-result.json
 */
const fs = await import('node:fs/promises')

const STATE = JSON.parse(await fs.readFile('/tmp/task1-cmdk-qa-state.json', 'utf8'))
const OUTDIR = '/Users/tsbj/feyanggit/DHS-test/onenat-workbuddy-web/qa-20261101/task1-cmdk-backlog'
const RESULT_PATH = '/tmp/task1-cmdk-mobile-result.json'
// 微信 X5（Chrome 66 内核）UA：复现旧内核 + 窄视口两个风险面
const X5_UA = 'Mozilla/5.0 (Linux; Android 8.1.0; MI 6 Build/OPM1.171019.011; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/66.0.3359.126 MQQBrowser/6.2 TBS/045008 Mobile Safari/537.36 MicroMessenger/7.0.9.1500(0x27000932) NetType/WIFI Language/zh_CN'

const task = await taskSpace('task1-cmdk-backlog-qa')
const page = task.page('p1')
const results = []
function rec(id, name, pass, detail) {
  const row = { id, name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) }
  results.push(row)
  console.log(`${row.pass ? 'PASS' : 'FAIL'} [${id}] ${name}${row.detail ? ' — ' + row.detail : ''}`)
  return row.pass
}
function snap() {
  return page.evaluate(() => {
    const list = document.getElementById('cmdk-list')
    const out = {
      maskOn: document.getElementById('cmdk-mask').classList.contains('on'),
      inputValue: document.getElementById('cmdk-input').value,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      groups: [],
      subDisplay: [],
      overflow: {
        docScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body ? document.body.scrollWidth : -1,
        maskScrollWidth: document.getElementById('cmdk-mask').scrollWidth,
        innerWidth: window.innerWidth,
      },
      cmdkRect: (function () { const r = document.querySelector('#cmdk-mask .cmdk').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width } })(),
      errors: window.__qaErrors ? window.__qaErrors.slice() : [],
    }
    let cur = null
    Array.prototype.slice.call(list.children).forEach((el) => {
      if (el.classList.contains('cmdk-group')) { cur = { title: (el.textContent || '').trim(), items: [] }; out.groups.push(cur) }
      else if (el.classList.contains('cmdk-item') && cur) {
        const lbEl = el.querySelector('.lb'), subEl = el.querySelector('.sub')
        out.groups[out.groups.length - 1].items.push({ lb: (lbEl && lbEl.textContent) || '', sub: (subEl && subEl.textContent) || '', sel: el.classList.contains('sel') })
        if (subEl) out.subDisplay.push(getComputedStyle(subEl).display)
      }
    })
    out.backlogGroup = null
    for (let i = 0; i < out.groups.length; i++) if (out.groups[i].title === '待办') out.backlogGroup = out.groups[i]
    return out
  })
}
async function setQuery(q) {
  await page.fill('#cmdk-input', q)
  await page.evaluate(() => { const i = document.getElementById('cmdk-input'); i.dispatchEvent(new Event('input', { bubbles: true })) })
  await page.waitForTimeout(80)
  return snap()
}

// ---------------- 0. 移动视口 + X5 UA，重新加载 ----------------
await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
await page.cdp('Emulation.setUserAgentOverride', { userAgent: X5_UA, acceptLanguage: 'zh-CN,zh;q=0.9', platform: 'Linux armv8l' })
await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
await page.goto(STATE.origin + '/healthz')
await page.evaluate((prefix) => fetch(prefix + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'workbuddy', password: 'workbuddy-admin' }),
}).then((r) => r.status), STATE.prefix)
await page.goto(STATE.baseUrl + '?m=' + Date.now())
await page.waitForFunction(() => {
  try { return !!document.getElementById('nav') && !!state && Array.isArray(state.projects) && state.projects.length >= 6 } catch (e) { return false }
}, undefined, { timeout: 40000 })
await page.waitForTimeout(400)
const env = await page.evaluate(() => ({
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
  ua: navigator.userAgent,
  dpr: window.devicePixelRatio,
  shouldBeMobile: window.matchMedia('(max-width: 768px)').matches,
}))
rec('M1', '移动视口 390x844 + 微信 X5 UA 生效', env.innerWidth === 390 && env.innerHeight === 844 && env.ua.indexOf('MicroMessenger') >= 0 && env.shouldBeMobile,
  `inner=${env.innerWidth}x${env.innerHeight} dpr=${env.dpr} ua.=…${env.ua.slice(-60)}`)

// ---------------- AC#4：面板可呼出、条目可命中、sub 隐藏、不横向溢出 ----------------
await page.keyboard.press('Control+k')
await page.waitForTimeout(120)
const openSnap = await snap()
rec('M2', '移动端 ⌘K 可呼出面板（#cmdk-mask.on）', openSnap.maskOn === true, `maskOn=${openSnap.maskOn}`)
await setQuery('TASK-1')
let lazyErr = ''
try {
  await page.waitForFunction(() => {
    try {
      const groups = Array.prototype.slice.call(document.querySelectorAll('#cmdk-list .cmdk-group')).map((g) => (g.textContent || '').trim())
      return document.getElementById('cmdk-mask').classList.contains('on') && groups.indexOf('待办') >= 0
    } catch (e) { return false }
  }, undefined, { timeout: 25000 })
} catch (e) { lazyErr = String(e && e.message ? e.message : e) }
const hit = await snap()
const hitItems = hit.backlogGroup ? hit.backlogGroup.items : []
const cross = hitItems.some((it) => it.sub.indexOf(STATE.projectA.name) >= 0) && hitItems.some((it) => it.sub.indexOf(STATE.projectC.name) >= 0)
rec('M3', '移动端输入 itemId 命中「待办」组且跨项目（A、C）', Boolean(hit.backlogGroup) && hitItems.length === 2 && cross,
  lazyErr || `items=${JSON.stringify(hitItems.map((x) => x.lb + ' / ' + x.sub))}`)
const subHidden = hit.subDisplay.length > 0 && hit.subDisplay.every((d) => d === 'none')
rec('M4', '≤768px 下 .cmdk-item .sub 列隐藏（display:none）', subHidden, `subDisplay=${JSON.stringify(hit.subDisplay)}`)
const noOverflow = hit.overflow.docScrollWidth <= hit.innerWidth + 1 && hit.overflow.bodyScrollWidth <= hit.innerWidth + 1 &&
  hit.overflow.maskScrollWidth <= hit.innerWidth + 1 && hit.cmdkRect.left >= -1 && hit.cmdkRect.right <= hit.innerWidth + 1
rec('M5', '无横向溢出：页面/mask scrollWidth ≤ innerWidth+1，面板在视口内', noOverflow,
  `overflow=${JSON.stringify(hit.overflow)} cmdkRect=${JSON.stringify(hit.cmdkRect)}`)
await page.screenshot({ path: OUTDIR + '/task1-07-mobile-cmdk-itemid.png' })

// ---------------- 补充：移动端选中后看板 + 详情弹层 ----------------
// 断言对象 = 面板当前实际选中的条目（query=TASK-1 时默认选中 C 项目同名条目），
// 而不是硬编码 A 项目 —— 否则会等错标题超时，却仍被宽松的 task-1 文案断言放过。
const selItem = hit.backlogGroup && hit.backlogGroup.items.find((it) => it.sel)
const selItemId = selItem ? (String(selItem.lb).match(/task-\d+/) || [''])[0] : ''
const selTitle = selItem ? String(selItem.lb).replace(/^task-\d+\s*/, '') : ''
const selProject = selItem ? String(selItem.sub).split(' · ')[0] : ''
await page.keyboard.press('Enter')
let jumpErr = ''
try {
  await page.waitForFunction(({ project }) => {
    try {
      if (location.hash !== '#backlog' || !document.getElementById('view-backlog').classList.contains('on')) return false
      if (!document.querySelector('#bl-root .bl-board')) return false
      const head = document.querySelector('#bl-root .bl-head b')
      return project ? Boolean(head) && head.textContent.indexOf(project) >= 0 : true
    } catch (e) { return false }
  }, { project: selProject }, { timeout: 25000 })
} catch (e) { jumpErr = String(e && e.message ? e.message : e) }
let modalErr = ''
try {
  await page.waitForFunction(({ itemId, title }) => {
    try {
      const m = document.getElementById('modal-mask')
      const t = document.getElementById('modal-title')
      if (!m.classList.contains('on') || !t) return false
      return itemId ? t.textContent.indexOf(itemId) >= 0 && t.textContent.indexOf(title) >= 0 : true
    } catch (e) { return false }
  }, { itemId: selItemId, title: selTitle }, { timeout: 25000 })
} catch (e) { modalErr = String(e && e.message ? e.message : e) }
const mobileJump = await page.evaluate(() => ({
  hash: location.hash,
  backlogOn: document.getElementById('view-backlog').classList.contains('on'),
  hasBoard: !!document.querySelector('#bl-root .bl-board'),
  boardTitle: (function () { const b = document.querySelector('#bl-root .bl-head b'); return b ? b.textContent : '' })(),
  cols: Array.prototype.slice.call(document.querySelectorAll('#bl-root .bl-col-h')).map((x) => (x.textContent || '').trim()),
  modalOn: document.getElementById('modal-mask').classList.contains('on'),
  modalTitle: document.getElementById('modal-title').textContent || '',
  overflowNow: { doc: document.documentElement.scrollWidth, inner: window.innerWidth, mask: document.getElementById('cmdk-mask').scrollWidth },
}))
const m6pass = mobileJump.hash === '#backlog' && mobileJump.backlogOn && mobileJump.hasBoard && mobileJump.modalOn
  && Boolean(selItemId) && mobileJump.modalTitle.indexOf(selItemId) >= 0 && mobileJump.modalTitle.indexOf(selTitle) >= 0
  && (!selProject || mobileJump.boardTitle.indexOf(selProject) >= 0)
rec('M6', '移动端选中条目后进入其所属项目 #backlog 看板并打开该条目详情弹层', m6pass,
  m6pass ? `selected=${selItemId} ${selTitle} @ ${selProject}; board=${mobileJump.boardTitle}; modal=${mobileJump.modalTitle}` : (jumpErr || modalErr || `hash=${mobileJump.hash} board=${mobileJump.boardTitle} modal=${mobileJump.modalTitle} cols=${JSON.stringify(mobileJump.cols)}`))
rec('M7', '移动端看板/弹层打开后仍无横向溢出', mobileJump.overflowNow.doc <= mobileJump.overflowNow.inner + 1 && mobileJump.overflowNow.mask <= mobileJump.overflowNow.inner + 1,
  `doc=${mobileJump.overflowNow.doc} inner=${mobileJump.overflowNow.inner} mask=${mobileJump.overflowNow.mask}`)
await page.screenshot({ path: OUTDIR + '/task1-08-mobile-backlog-board-modal.png' })

const errors = await page.evaluate(() => (window.__qaErrors ? window.__qaErrors.slice() : []))
rec('M8', '移动端全程无 pageerror / unhandledrejection / console.error', errors.length === 0, JSON.stringify(errors.slice(0, 6)))

const failed = results.filter((r) => !r.pass)
const summary = { ok: failed.length === 0, total: results.length, failed: failed.length, results, errors, ua: env.ua, viewport: { w: env.innerWidth, h: env.innerHeight } }
await fs.writeFile(RESULT_PATH, JSON.stringify(summary, null, 2))
console.log('\n===== 移动端轮汇总：' + (summary.ok ? '全部 PASS ✅' : failed.length + ' 项 FAIL ❌') + `（${results.length} 项） =====`)
if (failed.length) console.log('FAILED: ' + failed.map((r) => r.id + ' ' + r.name).join(' | '))
console.log('RESULT_JSON ' + RESULT_PATH)
