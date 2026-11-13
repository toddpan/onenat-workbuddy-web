/**
 * Backlog 查询能力——桌面 1440×900 真实 Chromium 验收（ego-browser）
 *
 * 运行（先起 qa-env.mjs）：
 *   cd <repo>
 *   ego-browser nodejs < qa-20261102-backlog-query/browser-desktop.mjs
 *
 * 覆盖（docs/design-backlog-query-filters.md §6/§8.3）：
 *   查询栏存在 / 搜索防抖与清除 / 筛选面板展开 / 优先级·就绪·标签 chips / 计数文案 /
 *   清除筛选恢复 / 项目看板查询栏·被筛选隐藏·列计数 / ⌘K 待办组仍可用 / 无 JS 报错 / 截图
 */
const fs = await import('node:fs/promises')

const STATE = JSON.parse(await fs.readFile('/tmp/backlog-query-qa-state.json', 'utf8'))
const OUTDIR = '/Users/tsbj/feyanggit/DHS-test/onenat-workbuddy-web/qa-20261102-backlog-query'
const RESULT_PATH = '/tmp/backlog-query-desktop-result.json'
const task = await taskSpace('blq-qa')
const page = task.page('p1')

const results = []
function rec(id, name, pass, detail) {
  const row = { id, name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) }
  results.push(row)
  console.log(`${row.pass ? 'PASS' : 'FAIL'} [${id}] ${name}${row.detail ? ' — ' + row.detail : ''}`)
  return row.pass
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 页面启动即注入：错误捕获 + overview/board 请求记录 */
const INIT_JS = `(function(){
  window.__qaErrors = [];
  window.__qaReqs = [];
  window.addEventListener('error', function(e){ window.__qaErrors.push('pageerror: ' + (e && e.message ? e.message : String(e))); });
  window.addEventListener('unhandledrejection', function(e){ var r = e && e.reason; window.__qaErrors.push('unhandledrejection: ' + (r && r.message ? r.message : String(r))); });
  var oe = console.error;
  console.error = function(){ var a = Array.prototype.slice.call(arguments).map(function(x){ return (x && x.stack) ? String(x.stack) : String(x); }).join(' '); window.__qaErrors.push('console.error: ' + a); return oe.apply(console, arguments); };
  var of = window.fetch;
  window.fetch = function(url){ var u = String(url);
    if (u.indexOf('/backlog') >= 0) window.__qaReqs.push(u);
    return of.apply(this, arguments);
  };
})();`

function snap() {
  return page.evaluate(() => {
    const q = (sel) => document.querySelector(sel)
    const qa = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel || ''))
    const root = document.getElementById('bl-root')
    const rows = qa('#bl-root .bl-row[data-item]')
    const cards = qa('#bl-root .bl-card[data-item]')
    const cnt = document.getElementById('bl-qcnt')
    return {
      inBacklogView: Boolean(document.getElementById('view-backlog') && document.getElementById('view-backlog').classList.contains('on')),
      hasQbar: Boolean(document.getElementById('bl-qbar')),
      hasSearch: Boolean(document.getElementById('bl-q')),
      hasToggle: Boolean(document.getElementById('bl-f-toggle')),
      hasSort: Boolean(document.getElementById('bl-s-order')),
      hasDir: Boolean(document.getElementById('bl-s-dir')),
      cntText: cnt ? String(cnt.textContent || '').trim() : '',
      panels: qa('#bl-fpanel').length,
      panelVisible: (function () { var p = document.getElementById('bl-fpanel'); return Boolean(p) && p.offsetParent !== null })(),
      chips: qa('#bl-fpanel .bl-fchip[data-blf]').length,
      chipKeys: (function () { var m = {}; qa('#bl-fpanel .bl-fchip[data-blf]').forEach(function (c) { var k = c.dataset.blf; m[k] = (m[k] || 0) + 1 }); return m })(),
      rows: rows.map(function (el) {
        var t = el.querySelector('.bl-title'); var title = t ? String(t.textContent || '') : ''
        return { id: el.dataset.item, title: title.trim(), grp: el.dataset.grp || '', text: String(el.textContent || '') }
      }),
      cards: cards.map(function (el) {
        return { id: el.dataset.item, text: String(el.textContent || '') }
      }),
      groups: qa('#bl-root .bl-group').length,
      groupHeads: qa('#bl-root .bl-group-h').map(function (el) { return String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) }),
      hiddenHint: (function () { var els = qa('#bl-root .bl-hide'); return els.length ? String(els[0].textContent || '').trim() : '' })(),
      board: Boolean(document.querySelector('#bl-root .bl-board')),
      boardCols: qa('#bl-root .bl-col').length,
      boardColHeads: qa('#bl-root .bl-col-h').map(function (el) { return String(el.textContent || '').replace(/\s+/g, ' ').trim() }),
      moreBtn: Boolean(document.getElementById('bl-more')),
      clearBtn: Boolean(document.getElementById('bl-f-clear')) || qa('#bl-root [data-blf-clear]').length > 0,
      cmdk: Boolean(document.getElementById('cmdk-mask')),
      errors: window.__qaErrors.slice(),
      reqs: (window.__qaReqs || []).slice(-8),
      bodyText: root ? String(root.textContent || '').replace(/\s+/g, ' ').slice(0, 400) : '',
    }
  })
}

async function clickSel(sel) {
  await page.click(sel)
  await page.waitForTimeout(250)
  return snap()
}
async function setSearch(q) {
  await page.fill('#bl-q', q)
  await page.evaluate(() => { const i = document.getElementById('bl-q'); i.dispatchEvent(new Event('input', { bubbles: true })) })
  await page.waitForTimeout(900) // 350ms 防抖 + overview 网络
  return snap()
}
async function filterBy(kind, value) {
  const sel = '#bl-fpanel .bl-fchip[data-blf="' + kind + '"][data-blfv="' + value + '"]'
  return clickSel(sel)
}
async function clearFilters() {
  const r = await page.evaluate(() => {
    const btn = document.getElementById('bl-f-clear')
    if (btn) { btn.click(); return 'btn' }
    const alt = document.querySelector('#bl-root [data-blf-clear]')
    if (alt) { alt.click(); return 'alt' }
    return 'none'
  })
  await page.waitForTimeout(900)
  return { how: r, state: await snap() }
}

// ---------------- 0. 视口 + 登录 + 就绪 ----------------
// DoD §8.3：桌面 1440×900（ego 默认 1470×733，显式覆盖保证可复现）
await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: INIT_JS })
await page.goto(STATE.origin + '/healthz')
await page.evaluate((prefix) => fetch(prefix + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'workbuddy', password: 'workbuddy-admin' }),
}).then((r) => r.status), STATE.prefix)
await page.goto(STATE.baseUrl)
await page.waitForFunction(() => {
  try { return !!document.getElementById('nav') && !!state && Array.isArray(state.projects) && state.projects.length >= 2 } catch (e) { return false }
}, undefined, { timeout: 40000 })
await page.waitForTimeout(500)
const env = await page.evaluate(() => ({ innerWidth: window.innerWidth, innerHeight: window.innerHeight, dpr: window.devicePixelRatio, ua: navigator.userAgent }))
rec('D0.1', '桌面视口 1400x900 级 + 控制台加载（项目 >= 2）', env.innerWidth >= 1200 && env.innerHeight >= 700, `inner=${env.innerWidth}x${env.innerHeight}`)

// ---------------- 1. 进入待办视图 ----------------
await clickSel('[data-v="backlog"]')
await page.waitForFunction(() => {
  const root = document.getElementById('bl-root')
  return root && (root.querySelector('.bl-group') || root.textContent.indexOf('加载') >= 0)
}, undefined, { timeout: 40000 })
await page.waitForTimeout(800)
const s1 = await snap()
rec('D1.1', '待办聚合页渲染：分组 >= 2、查询栏齐全（qbar/搜索/筛选开关/排序/方向/计数）',
  s1.inBacklogView && s1.groups >= 2 && s1.hasQbar && s1.hasSearch && s1.hasToggle && s1.hasSort && s1.hasDir && Boolean(s1.cntText),
  `groups=${s1.groups} cnt="${s1.cntText}"`)
rec('D1.2', '查询栏默认不展开筛选面板', s1.panels === 0 || s1.panelVisible === false, `panels=${s1.panels} visible=${s1.panelVisible}`)
rec('D1.3', '首屏无 JS 错误', s1.errors.length === 0, s1.errors.join(' | ').slice(0, 200))
await page.screenshot({ path: OUTDIR + '/desktop-01-backlog-overview.png' })

// ---------------- 2. 搜索（防抖 + 命中 + 清除） ----------------
const allRows = s1.rows.map((r) => r.id)
const s2 = await setSearch('登录')
rec('D2.1', '搜索「登录」命中目标条目且结果收窄', s2.rows.length > 0 && s2.rows.length < s1.rows.length && s2.rows.some((r) => /登录/.test(r.title)), `rows ${s1.rows.length}→${s2.rows.length}`)
rec('D2.2', '搜索请求带 search 参数（服务端过滤）', s2.reqs.some((u) => u.indexOf('search=') >= 0), String(s2.reqs.slice(-2)))
rec('D2.3', '计数文案含「匹配」且为匹配/共 M', /匹配/.test(s2.cntText) && /共/.test(s2.cntText), s2.cntText)
await page.screenshot({ path: OUTDIR + '/desktop-02-search.png' })
const s3 = await clickSel('#bl-q-clear')
rec('D2.4', '清除搜索恢复全量', s3.rows.length === allRows.length, `rows=${s3.rows.length} (期望 ${allRows.length})`)

// ---------------- 3. 筛选面板 + 优先级 / 就绪 / 标签 ----------------
const s4 = await clickSel('#bl-f-toggle')
rec('D3.1', '筛选面板展开且分面 chips 来自 facets（status/priority/type/label/assignee 等）',
  s4.panelVisible === true && s4.chips > 0 && Object.keys(s4.chipKeys).length >= 4,
  `chips=${s4.chips} kinds=${JSON.stringify(s4.chipKeys)}`)
await page.screenshot({ path: OUTDIR + '/desktop-03-filter-panel.png' })

const s5 = await filterBy('priority', 'high')
rec('D3.2', '优先级 high 过滤生效（结果全部含 high 语义：仅 A/B 项目 high 条目）',
  s5.rows.length > 0 && s5.rows.length < s3.rows.length && s5.rows.every((r) => /task-(1|4)$/.test(r.id)), `rows=${s5.rows.map((r) => r.id).join(',')}`)

const s6 = await clearFilters()
rec('D3.3', '清除筛选恢复全量', s6.state.rows.length === allRows.length, `how=${s6.how} rows=${s6.state.rows.length}`)

// 就绪 chip
const s7 = await clickSel('#bl-f-toggle')
let s8 = s7
if (s7.panelVisible !== true) s8 = await clickSel('#bl-f-toggle')
const readyChip = await page.evaluate(() => {
  const chips = Array.prototype.slice.call(document.querySelectorAll('#bl-fpanel .bl-fchip[data-blf]'))
  const hit = chips.find((c) => /就绪/.test(String(c.textContent || '')))
  if (!hit) return false
  hit.click(); return true
})
await page.waitForTimeout(900)
const s9 = await snap()
rec('D3.4', '就绪（READY）chip 过滤生效：结果行全部带「就绪」徽标',
  readyChip && s9.rows.length > 0 && s9.rows.every((r) => /就绪/.test(r.text)), `chip=${readyChip} rows=${s9.rows.length}`)
const blockedChip = await page.evaluate(() => {
  const chips = Array.prototype.slice.call(document.querySelectorAll('#bl-fpanel .bl-fchip[data-blf]'))
  const hit = chips.find((c) => /阻塞/.test(String(c.textContent || '')))
  if (!hit) return false
  hit.click(); return true
})
await page.waitForTimeout(900)
const s10 = await snap()
rec('D3.5', '被阻塞 chip 过滤生效：结果行全部带「阻塞」徽标',
  blockedChip && s10.rows.length > 0 && s10.rows.every((r) => /阻塞/.test(r.text)), `chip=${blockedChip} rows=${s10.rows.length}`)
await page.screenshot({ path: OUTDIR + '/desktop-04-ready-blocked.png' })
const s11 = await clearFilters()
rec('D3.6', '再次清除筛选恢复全量', s11.state.rows.length === allRows.length, `rows=${s11.state.rows.length}`)

// ---------------- 4. 项目看板 ----------------
const s12 = await clickSel('[data-board="' + STATE.projectA.id + '"]')
await page.waitForFunction(() => Boolean(document.querySelector('#bl-root .bl-board')), undefined, { timeout: 40000 })
await page.waitForTimeout(600)
const s13 = await snap()
rec('D4.1', '项目看板打开：3 列 + 卡片 10 条 + 列头计数', s13.board && s13.boardCols === 3 && s13.cards.length === 10, `cols=${s13.boardCols} cards=${s13.cards.length}`)
rec('D4.2', '看板查询栏同样存在（搜索/筛选开关/排序/计数）', s13.hasQbar && s13.hasSearch && s13.hasToggle && s13.hasSort, s13.cntText)
await page.screenshot({ path: OUTDIR + '/desktop-05-board.png' })

const s14 = await clickSel('#bl-f-toggle')
const boardFiltered = await page.evaluate(() => {
  const chips = Array.prototype.slice.call(document.querySelectorAll('#bl-fpanel .bl-fchip[data-blf="priority"]'))
  const hit = chips.find((c) => String(c.dataset.blfv || '').toLowerCase() === 'high')
  if (!hit) return false
  hit.click(); return true
})
await page.waitForTimeout(1000)
const s15 = await snap()
rec('D4.3', '看板优先级过滤生效：只剩 high 条目（2 条）', boardFiltered && s15.cards.length === 2, `cards=${s15.cards.map((c) => c.id).join(',')}`)
rec('D4.4', '看板显示「被筛选隐藏 X 条」提示', /被筛选隐藏/.test(s15.hiddenHint), s15.hiddenHint)
const clearBoard = await clearFilters()
const s16 = clearBoard.state
rec('D4.5', '看板清除筛选恢复 10 条', s16.cards.length === 10, `cards=${s16.cards.length} how=${clearBoard.how}`)

// 搜索看板
const s17 = await setSearch('幂等')
rec('D4.6', '看板搜索「幂等」命中正文条目（服务端全文检索）', s17.cards.length === 1 && s17.cards[0].id === 'task-2', `cards=${s17.cards.map((c) => c.id).join(',')}`)
await clickSel('#bl-q-clear')
await page.screenshot({ path: OUTDIR + '/desktop-06-board-filter.png' })
await clickSel('#bl-back')

// ---------------- 5. ⌘K 待办组回归（默认 openOnly 下仍能搜到 Done 条目） ----------------
await page.keyboard.press('Meta+k')
await page.waitForTimeout(900)
const cmdk1 = await page.evaluate(() => {
  const mask = document.getElementById('cmdk-mask')
  return { on: Boolean(mask && mask.classList.contains('on')), items: Array.prototype.slice.call(document.querySelectorAll('#cmdk-list .cmdk-item .lb')).map((el) => String(el.textContent || '')) }
})
const s18 = await (async () => {
  await page.fill('#cmdk-input', 'task-3')
  await page.evaluate(() => { const i = document.getElementById('cmdk-input'); i.dispatchEvent(new Event('input', { bubbles: true })) })
  await page.waitForTimeout(900)
  return page.evaluate(() => ({ on: Boolean(document.getElementById('cmdk-mask').classList.contains('on')), items: Array.prototype.slice.call(document.querySelectorAll('#cmdk-list .cmdk-item')).map((el) => String(el.textContent || '')) }))
})()
rec('D5.1', '⌘K 面板打开且待办组可用（能搜到完成态条目 task-3）',
  cmdk1.on && s18.items.some((t) => /task-3/.test(t)), `items=${s18.items.length} hit=${s18.items.filter((t) => /task-3/.test(t)).length}`)
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
const s19 = await snap()
rec('D5.2', '全流程无 JS 错误（页面 error / unhandledrejection / console.error）', s19.errors.length === 0, s19.errors.join(' | ').slice(0, 300))
await page.screenshot({ path: OUTDIR + '/desktop-07-final.png' })

const failed = results.filter((r) => !r.pass)
const summary = { ok: failed.length === 0, total: results.length, failed: failed.length, results, errors: s19.errors, viewport: env, at: new Date().toISOString() }
await fs.writeFile(RESULT_PATH, JSON.stringify(summary, null, 2), 'utf8')
console.log(`\n桌面验收：${summary.ok ? '全部通过 ✅' : `${failed.length} 项失败 ❌`}（${results.length} 项）`)
console.log('RESULT ' + RESULT_PATH)
