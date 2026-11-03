/**
 * 定位「普通用户登录后控制台报 TypeError: Cannot read properties of null (reading 'addEventListener')」
 * —— 带堆栈的最小复现（ego-lite）
 *
 *   ego-browser nodejs < qa-20261102-perm-online/diag-member-error.mjs
 */
const fs = await import('node:fs/promises')
const STATE = JSON.parse(await fs.readFile('/tmp/wb-ego-perm-state.json', 'utf8'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const INIT_JS = `(function(){
  window.__qaErrors = [];
  window.addEventListener('error', function(e){
    var msg = (e && e.message) ? e.message : String(e);
    var stack = (e && e.error && e.error.stack) ? String(e.error.stack) : '';
    window.__qaErrors.push('pageerror: ' + msg + ' || ' + stack);
  });
  window.addEventListener('unhandledrejection', function(e){
    var r = e && e.reason;
    window.__qaErrors.push('unhandledrejection: ' + ((r && r.message) ? r.message : String(r)) + ' || ' + ((r && r.stack) ? r.stack : ''));
  });
  var oe = console.error;
  console.error = function(){ var a = Array.prototype.slice.call(arguments).map(function(x){ return (x && x.stack) ? String(x.stack) : String(x); }).join(' '); window.__qaErrors.push('console.error: ' + a); return oe.apply(console, arguments); };
})();`

const task = await taskSpace('wb-ego-perm')
const page = task.page('p1')
await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: INIT_JS })

// 退出 → 登录页
await page.goto(STATE.base + '/')
await page.evaluate(async () => {
  try { await fetch('/onenat-workbuddy/api/auth/logout', { method: 'POST' }) } catch (e) {}
}).catch(() => {})
await page.reload()
await page.waitForSelector('#username', { state: 'visible', timeout: 20000 })
console.log('[diag] 登录页就绪，注入错误收集后以普通用户登录')
await sleep(500)

// 清掉登录页阶段的错误，只关注控制台阶段
await page.evaluate(() => { window.__qaErrors = [] })

await page.fill('#username', STATE.member.user)
await page.fill('#password', STATE.member.pass)
await page.click('#btn')
await page.waitForSelector('#view-work', { state: 'visible', timeout: 30000 })
await sleep(2500)
const afterLogin = await page.evaluate(() => (window.__qaErrors || []).slice())
console.log('[diag] 登录后立即的错误:', JSON.stringify(afterLogin, null, 2))

async function gotoView(v) {
  const inMore = ['settings', 'resources', 'library', 'plugins', 'voice', 'schedules', 'files', 'experts', 'archive']
  if (inMore.includes(v)) {
    await page.click('#nav-more-btn'); await sleep(300); await page.click(`button[data-v="${v}"]`)
  } else {
    await page.click(`#nav button[data-v="${v}"]`)
  }
  await sleep(1500)
  const errs = await page.evaluate(() => (window.__qaErrors || []).slice())
  console.log(`[diag] 切到 ${v} 后错误:`, JSON.stringify(errs, null, 2))
}

await gotoView('agents')
await gotoView('settings')
await gotoView('work')
console.log('[diag] 全部错误:', JSON.stringify(await page.evaluate(() => (window.__qaErrors || []).slice()), null, 2))
