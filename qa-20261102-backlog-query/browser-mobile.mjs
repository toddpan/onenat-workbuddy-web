/**
 * Backlog 查询能力——移动端 390×844 + 微信 X5 旧内核 UA 验收（ego-browser）
 *
 * 运行（先起 qa-env.mjs，并已跑过 browser-desktop.mjs 复用同一 TaskSpace）：
 *   cd <repo>
 *   ego-browser nodejs < qa-20261102-backlog-query/browser-mobile.mjs
 *
 * 覆盖（docs/design-backlog-query-filters.md §6.3/§8.3）：
 *   390×844 + X5 UA 生效 / 待办页查询栏与筛选面板单列 / chip·输入框热区 ≥44px /
 *   无横向溢出 / 搜索与就绪过滤生效 / 看板列横滑 + 查询栏 / 无 JS 错误 / 截图
 */
const fs = await import('node:fs/promises')

const STATE = JSON.parse(await fs.readFile('/tmp/backlog-query-qa-state.json', 'utf8'))
const OUTDIR = '/Users/tsbj/feyanggit/DHS-test/onenat-workbuddy-web/qa-20261102-backlog-query'
const RESULT_PATH = '/tmp/backlog-query-mobile-result.json'
// 微信 X5（Chrome 66 内核）UA：复现旧内核 + 窄视口两个风险面
const X5_UA = 'Mozilla/5.0 (Linux; Android 8.1.0; MI 6 Build/OPM1.171019.011; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/66.0.3359.126 MQQBrowser/6.2 TBS/045008 Mobile Safari/537.36 MicroMessenger/7.0.9.1500(0x27000932) NetType/WIFI Language/zh_CN'

const task = await taskSpace('blq-qa')
// 复用 desktop 脚本创建的同一 Page（ego TaskSpace 内只有 p1；同一 Page 上覆盖移动视口即可）
const page = task.page('p1')
const results = []
function rec(id, name, pass, detail) {
  const row = { id, name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) }
  results.push(row)
  console.log(`${row.pass ? 'PASS' : 'FAIL'} [${id}] ${name}${row.detail ? ' — ' + row.detail : ''}`)
  return row.pass
}

const INIT_JS = `(function(){
  window.__qaErrors = [];
  window.addEventListener('error', function(e){ window.__qaErrors.push('pageerror: ' + (e && e.message ? e.message : String(e))); });
  window.addEventListener('unhandledrejection', function(e){ var r = e && e.reason; window.__qaErrors.push('unhandledrejection: ' + (r && r.message ? r.message : String(r))); });
  var oe = console.error;
  console.error = function(){ var a = Array.prototype.slice.call(arguments).map(function(x){ return (x && x.stack) ? String(x.stack) : String(x); }).join(' '); window.__qaErrors.push('console.error: ' + a); return oe.apply(console, arguments); };
})();`

function envSnap() {
  return page.evaluate(() => {
    const root = document.getElementById('bl-root')
    const qa = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel || ''))
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right) } }
    const panel = document.getElementById('bl-fpanel')
    const styles = panel ? getComputedStyle(panel) : null
    const frow = panel ? panel.querySelector('.bl-frow') : null
    const frowStyles = frow ? getComputedStyle(frow) : null
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      ua: navigator.userAgent,
      isMobileUA: /MicroMessenger|MQQBrowser/i.test(navigator.userAgent),
      inBacklogView: Boolean(document.getElementById('view-backlog') && document.getElementById('view-backlog').classList.contains('on')),
      hasQbar: Boolean(document.getElementById('bl-qbar')),
      hasSearch: Boolean(document.getElementById('bl-q')),
      hasToggle: Boolean(document.getElementById('bl-f-toggle')),
      hasSort: Boolean(document.getElementById('bl-s-order')),
      cntText: (function () { const c = document.getElementById('bl-qcnt'); return c ? String(c.textContent || '').trim() : '' })(),
      rows: qa('#bl-root .bl-row[data-item]').map(function (el) { const t = el.querySelector('.bl-title'); return { id: el.dataset.item, text: String(el.textContent || ''), title: t ? String(t.textContent || '').trim() : '' } }),
      cards: qa('#bl-root .bl-card[data-item]').length,
      board: Boolean(document.querySelector('#bl-root .bl-board')),
      panelVisible: Boolean(panel) && panel.offsetParent !== null,
      panelDisplay: styles ? styles.display : '',
      panelDir: styles ? styles.flexDirection : '',
      frowDir: frowStyles ? frowStyles.flexDirection : '',
      chipRect: rect(document.querySelector('#bl-fpanel .bl-fchip[data-blf]')),
      inputRect: rect(document.getElementById('bl-q')),
      toggleRect: rect(document.getElementById('bl-f-toggle')),
      sortRect: rect(document.getElementById('bl-s-order')),
      searchClearRect: rect(document.getElementById('bl-q-clear')),
      // 横向溢出：文档/待办根节点不得超出视口（看板列容器自身允许 overflow-x）
      docScrollWidth: document.documentElement.scrollWidth,
      rootScrollWidth: root ? root.scrollWidth : 0,
      bodyScrollWidth: document.body.scrollWidth,
      errors: window.__qaErrors.slice(),
      qbarOverflow: (function () {
        const bar = document.getElementById('bl-qbar')
        if (!bar) return null
        const kids = Array.prototype.slice.call(bar.querySelectorAll('.bl-qrow > *, .bl-qwrap input'))
        return kids.filter(function (el) { const r = el.getBoundingClientRect(); return r.right > window.innerWidth + 1 }).length
      })(),
    }
  })
}

async function clickSel(sel) { await page.click(sel); await page.waitForTimeout(280); return envSnap() }
async function setSearch(q) {
  await page.fill('#bl-q', q)
  await page.evaluate(() => { const i = document.getElementById('bl-q'); i.dispatchEvent(new Event('input', { bubbles: true })) })
  await page.waitForTimeout(1000)
  return envSnap()
}

// ---------------- 0. 移动视口 + X5 UA ----------------
await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true })
await page.cdp('Emulation.setUserAgentOverride', { userAgent: X5_UA, acceptLanguage: 'zh-CN,zh;q=0.9', platform: 'Linux armv8l' })
await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: INIT_JS })
await page.goto(STATE.origin + '/healthz')
await page.evaluate((prefix) => fetch(prefix + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'workbuddy', password: 'workbuddy-admin' }),
}).then((r) => r.status), STATE.prefix)
await page.goto(STATE.baseUrl)
await page.waitForFunction(() => !!document.getElementById('nav'), undefined, { timeout: 40000 })
await page.waitForTimeout(900)
const e0 = await envSnap()
rec('M0.1', '移动视口 390×844 + 微信 X5 UA 生效', e0.innerWidth === 390 && e0.innerHeight === 844 && e0.isMobileUA, `inner=${e0.innerWidth}x${e0.innerHeight} isMobileUA=${e0.isMobileUA}`)

// 进入待办视图（移动端导航可能折叠，直接调用视图切换函数更稳）
await page.evaluate(() => { try { switchView('backlog') } catch (e) { const b = document.querySelector('[data-v="backlog"]'); if (b) b.click() } })
await page.waitForFunction(() => {
  const root = document.getElementById('bl-root')
  return root && (root.querySelector('.bl-group') || root.textContent.indexOf('加载') >= 0)
}, undefined, { timeout: 40000 })
await page.waitForTimeout(1200)
const m1 = await envSnap()
rec('M1.1', '待办聚合页移动端渲染：查询栏齐全 + 分组/行有内容', m1.inBacklogView && m1.hasQbar && m1.hasSearch && m1.hasToggle && m1.hasSort && m1.rows.length > 0, `rows=${m1.rows.length} cnt="${m1.cntText}"`)
rec('M1.2', '无横向溢出（文档/待办根节点 scrollWidth ≤ 视口 +1）', m1.docScrollWidth <= 391 && m1.rootScrollWidth <= 391 && m1.bodyScrollWidth <= 391, `doc=${m1.docScrollWidth} root=${m1.rootScrollWidth} body=${m1.bodyScrollWidth}`)
rec('M1.3', '查询栏子元素不越出视口', m1.qbarOverflow === 0, `overflowKids=${m1.qbarOverflow}`)
const tap = (r) => Boolean(r) && r.h >= 44
rec('M1.4', '移动端热区 ≥44px（搜索框/筛选开关/排序下拉）', tap(m1.inputRect) && tap(m1.toggleRect) && tap(m1.sortRect), `input=${JSON.stringify(m1.inputRect)} toggle=${JSON.stringify(m1.toggleRect)} sort=${JSON.stringify(m1.sortRect)}`)
await page.screenshot({ path: OUTDIR + '/mobile-01-backlog-overview.png' })

// ---------------- 1. 筛选面板单列 + chip 热区 ----------------
const m2 = await clickSel('#bl-f-toggle')
rec('M2.1', '筛选面板展开且移动端为单列纵向布局（display:flex column / 行纵向）',
  m2.panelVisible === true && (m2.panelDisplay === 'flex' || m2.panelDisplay === 'block') && (m2.frowDir === 'column' || m2.panelDir === 'column'),
  `display=${m2.panelDisplay} panelDir=${m2.panelDir} frowDir=${m2.frowDir}`)
rec('M2.2', '分面 chip 热区 ≥44px', tap(m2.chipRect), JSON.stringify(m2.chipRect))
await page.screenshot({ path: OUTDIR + '/mobile-02-filter-panel.png' })

// ---------------- 2. 搜索 + 就绪过滤（真实网络往返） ----------------
const m3 = await setSearch('登录')
rec('M3.1', '移动端搜索生效（结果收窄且命中目标）', m3.rows.length > 0 && m3.rows.length < m1.rows.length && m3.rows.some((r) => /登录/.test(r.title)), `rows ${m1.rows.length}→${m3.rows.length}`)
const m4 = await clickSel('#bl-q-clear')
rec('M3.2', '清除搜索恢复全量', m4.rows.length === m1.rows.length, `rows=${m4.rows.length}`)
const readyHit = await page.evaluate(() => {
  const chips = Array.prototype.slice.call(document.querySelectorAll('#bl-fpanel .bl-fchip[data-blf]'))
  const hit = chips.find((c) => /就绪/.test(String(c.textContent || '')))
  if (!hit) return false
  hit.click(); return true
})
await page.waitForTimeout(1000)
const m5 = await envSnap()
rec('M3.3', '移动端就绪 chip 过滤生效：结果行全部带「就绪」徽标', readyHit && m5.rows.length > 0 && m5.rows.every((r) => /就绪/.test(r.text)), `rows=${m5.rows.length}`)
const cleared = await page.evaluate(() => {
  const btn = document.getElementById('bl-f-clear')
  if (btn) { btn.click(); return true }
  const alt = document.querySelector('#bl-root [data-blf-clear]')
  if (alt) { alt.click(); return true }
  return false
})
await page.waitForTimeout(1000)
const m6 = await envSnap()
rec('M3.4', '移动端清除筛选恢复全量', cleared && m6.rows.length === m1.rows.length, `rows=${m6.rows.length}`)

// ---------------- 3. 项目看板（列横滑 + 查询栏） ----------------
const m7 = await clickSel('[data-board="' + STATE.projectA.id + '"]')
await page.waitForFunction(() => Boolean(document.querySelector('#bl-root .bl-board')), undefined, { timeout: 40000 })
await page.waitForTimeout(900)
const m8 = await envSnap()
const boardOverflow = await page.evaluate(() => {
  const board = document.querySelector('#bl-root .bl-board')
  if (!board) return null
  const cols = Array.prototype.slice.call(board.querySelectorAll('.bl-col'))
  return {
    scrollWidth: board.scrollWidth,
    clientWidth: board.clientWidth,
    colCount: cols.length,
    colWidth: cols[0] ? Math.round(cols[0].getBoundingClientRect().width) : 0,
    canScrollX: board.scrollWidth > board.clientWidth,
  }
})
rec('M4.1', '看板移动端渲染：3 列 + 可横向滑动（scrollWidth > clientWidth）', Boolean(boardOverflow) && boardOverflow.colCount === 3 && boardOverflow.canScrollX, JSON.stringify(boardOverflow))
rec('M4.2', '看板查询栏在移动端可用', m8.hasQbar && m8.hasSearch && m8.hasToggle && m8.hasSort, m8.cntText)
await page.screenshot({ path: OUTDIR + '/mobile-03-board.png' })
const m9 = await clickSel('#bl-f-toggle')
const boardFilter = await page.evaluate(() => {
  const chips = Array.prototype.slice.call(document.querySelectorAll('#bl-fpanel .bl-fchip[data-blf="priority"]'))
  const hit = chips.find((c) => String(c.dataset.blfv || '').toLowerCase() === 'high')
  if (!hit) return false
  hit.click(); return true
})
await page.waitForTimeout(1000)
const m10 = await envSnap()
rec('M4.3', '看板移动端优先级过滤生效（high 条目 2 张卡）', boardFilter && m10.cards === 2, `cards=${m10.cards}`)
const hideHint = await page.evaluate(() => {
  const el = document.querySelector('#bl-root .bl-hide')
  return el ? String(el.textContent || '').trim() : ''
})
rec('M4.4', '看板显示「被筛选隐藏 X 条」', /被筛选隐藏/.test(hideHint), hideHint)
await page.screenshot({ path: OUTDIR + '/mobile-04-board-filter.png' })
const m11 = await envSnap()
rec('M4.5', '全流程无 JS 错误（X5 内核模拟 + 窄视口）', m11.errors.length === 0, m11.errors.join(' | ').slice(0, 300))

const failed = results.filter((r) => !r.pass)
const summary = { ok: failed.length === 0, total: results.length, failed: failed.length, results, errors: m11.errors, viewport: { w: m11.innerWidth, h: m11.innerHeight }, ua: m11.ua, at: new Date().toISOString() }
await fs.writeFile(RESULT_PATH, JSON.stringify(summary, null, 2), 'utf8')
console.log(`\n移动端验收：${summary.ok ? '全部通过 ✅' : `${failed.length} 项失败 ❌`}（${results.length} 项）`)
console.log('RESULT ' + RESULT_PATH)
