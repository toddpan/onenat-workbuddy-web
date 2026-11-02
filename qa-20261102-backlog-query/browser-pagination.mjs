/**
 * Backlog 看板分页验收（>50 条）——验证「显示更多」走 skip + maxCount 窗口
 *
 * 背景：契约裁定 `limit`=排序后硬截断（UI 不用），`maxCount`=分页窗口大小。
 * 前端 `blLoadBoard` 发 `maxCount=50&skip=<window.nextSkip>`；本条覆盖该链路，
 * 防止「用 limit 分页导致第 2 页取空」的原缺陷回归。
 *
 * 运行（先起 qa-env.mjs，且 browser-desktop.mjs 已创建 Page）：
 *   ego-browser nodejs < qa-20261102-backlog-query/browser-pagination.mjs
 */
const fs = await import('node:fs/promises')

const STATE = JSON.parse(await fs.readFile('/tmp/backlog-query-qa-state.json', 'utf8'))
const OUTDIR = '/Users/tsbj/feyanggit/DHS-test/onenat-workbuddy-web/qa-20261102-backlog-query'
const RESULT_PATH = '/tmp/backlog-query-pagination-result.json'
const task = await taskSpace('blq-qa')
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
  window.__qaReqs = [];
  window.addEventListener('error', function(e){ window.__qaErrors.push('pageerror: ' + (e && e.message ? e.message : String(e))); });
  window.addEventListener('unhandledrejection', function(e){ var r = e && e.reason; window.__qaErrors.push('unhandledrejection: ' + (r && r.message ? r.message : String(r))); });
  var of = window.fetch;
  window.fetch = function(url){ var u = String(url); if (u.indexOf('/backlog') >= 0) window.__qaReqs.push(u); return of.apply(this, arguments); };
})();`

function snap() {
  return page.evaluate(() => {
    const qa = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel || ''))
    const more = document.getElementById('bl-more')
    return {
      cards: qa('#bl-root .bl-card[data-item]').map((el) => el.dataset.item),
      moreVisible: Boolean(more) && more.offsetParent !== null,
      moreText: more ? String(more.textContent || '').trim() : '',
      moreSkip: more ? String(more.dataset.skip || '') : '',
      reqs: (window.__qaReqs || []).slice(-6),
      errors: window.__qaErrors.slice(),
      boardCols: qa('#bl-root .bl-col-h').map((el) => String(el.textContent || '').replace(/\s+/g, ' ').trim()),
    }
  })
}

await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await page.cdp('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36' })
await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: INIT_JS })
await page.goto(STATE.origin + '/healthz')
await page.evaluate((prefix) => fetch(prefix + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'workbuddy', password: 'workbuddy-admin' }),
}).then((r) => r.status), STATE.prefix)
await page.goto(STATE.baseUrl)
await page.waitForFunction(() => !!document.getElementById('nav'), undefined, { timeout: 40000 })
await page.waitForTimeout(800)
await page.evaluate(() => { try { switchView('backlog') } catch (e) { const b = document.querySelector('[data-v="backlog"]'); if (b) b.click() } })
await page.waitForFunction(() => {
  const root = document.getElementById('bl-root')
  return root && root.querySelector('.bl-group')
}, undefined, { timeout: 40000 })
await page.waitForTimeout(1200)

// 打开项目 B 看板（63 条 → 超过 pageSize 50）
await page.click('[data-board="' + STATE.projectB.id + '"]')
await page.waitForFunction(() => Boolean(document.querySelector('#bl-root .bl-board')), undefined, { timeout: 40000 })
await page.waitForTimeout(900)
const s1 = await snap()
rec('P1.1', '项目 B 看板首屏按 maxCount=50 分页（50 张卡）', s1.cards.length === 50, `cards=${s1.cards.length}`)
rec('P1.2', '首屏请求带 maxCount=50 且不带 limit（契约裁定：limit 是硬截断，UI 不用）',
  s1.reqs.some((u) => /maxCount=50/.test(u)) && !s1.reqs.some((u) => /[?&]limit=/.test(u)),
  s1.reqs.slice(-1).join(''))
rec('P1.3', '「显示更多」按钮出现且提示剩余条数（还有 13 条）', s1.moreVisible && /13/.test(s1.moreText), `text="${s1.moreText}" skip=${s1.moreSkip}`)
rec('P1.4', '「显示更多」携带 skip=50（window.nextSkip）', s1.moreSkip === '50', `skip=${s1.moreSkip}`)
await page.screenshot({ path: OUTDIR + '/desktop-08-pagination-page1.png' })

await page.click('#bl-more')
await page.waitForTimeout(1200)
const s2 = await snap()
rec('P2.1', '第 2 页追加渲染：卡片 50→63（不重复、不丢失）',
  s2.cards.length === 63 && new Set(s2.cards).size === 63, `cards=${s2.cards.length} unique=${new Set(s2.cards).size}`)
rec('P2.2', '第 2 页请求带 skip=50 + maxCount=50', s2.reqs.some((u) => /skip=50/.test(u) && /maxCount=50/.test(u)), s2.reqs.slice(-1).join(''))
rec('P2.3', '分页耗尽后「显示更多」消失', s2.moreVisible === false, `moreVisible=${s2.moreVisible} text="${s2.moreText}"`)
await page.screenshot({ path: OUTDIR + '/desktop-09-pagination-page2.png' })
rec('P2.4', '分页过程无 JS 错误', s2.errors.length === 0, s2.errors.join(' | ').slice(0, 200))

const failed = results.filter((r) => !r.pass)
const summary = { ok: failed.length === 0, total: results.length, failed: failed.length, results, errors: s2.errors, at: new Date().toISOString() }
await fs.writeFile(RESULT_PATH, JSON.stringify(summary, null, 2), 'utf8')
console.log(`\n分页验收：${summary.ok ? '全部通过 ✅' : `${failed.length} 项失败 ❌`}（${results.length} 项）`)
console.log('RESULT ' + RESULT_PATH)
