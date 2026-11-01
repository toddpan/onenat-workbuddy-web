/**
 * TASK-1「backlog 条目接入 ⌘K 全局检索」——桌面 1440x900 真实 Chromium 验收（ego-browser）
 *
 * 运行（先起 qa-env.mjs）：
 *   cd <repo>
 *   ego-browser nodejs < qa-20261101/task1-cmdk-backlog/browser-desktop.mjs
 *
 * 依赖：/tmp/task1-cmdk-qa-state.json（qa-env.mjs 写入）、本仓库 qa-20261101/task1-cmdk-backlog/ 截图目录
 * 输出：控制台逐条 AC 结果 + 截图 + /tmp/task1-cmdk-desktop-result.json
 */
const fs = await import('node:fs/promises')

const STATE = JSON.parse(await fs.readFile('/tmp/task1-cmdk-qa-state.json', 'utf8'))
const OUTDIR = '/Users/tsbj/feyanggit/DHS-test/onenat-workbuddy-web/qa-20261101/task1-cmdk-backlog'
const RESULT_PATH = '/tmp/task1-cmdk-desktop-result.json'
const task = await taskSpace('task1-cmdk-backlog-qa')
const page = task.page('p1')

const results = []
function rec(id, name, pass, detail) {
  const row = { id, name, pass: Boolean(pass), detail: detail === undefined ? '' : String(detail) }
  results.push(row)
  console.log(`${row.pass ? 'PASS' : 'FAIL'} [${id}] ${name}${row.detail ? ' — ' + row.detail : ''}`)
  return row.pass
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 页面启动即注入：window error / unhandledrejection / console.error 捕获 + fetch 计时 + ⌘K 时间戳
const INIT_JS = `(function(){
  window.__qaErrors = [];
  window.__qaOv = null;
  window.__qaKeyAt = 0;
  window.addEventListener('error', function(e){ window.__qaErrors.push('pageerror: ' + (e && e.message ? e.message : String(e))); });
  window.addEventListener('unhandledrejection', function(e){ var r = e && e.reason; window.__qaErrors.push('unhandledrejection: ' + (r && r.message ? r.message : String(r))); });
  var oe = console.error;
  console.error = function(){ var a = Array.prototype.slice.call(arguments).map(function(x){ return (x && x.stack) ? String(x.stack) : String(x); }).join(' '); window.__qaErrors.push('console.error: ' + a); return oe.apply(console, arguments); };
  var of = window.fetch;
  window.fetch = function(url){ var u = String(url); var rec = { url: u, start: performance.now() };
    if (u.indexOf('/backlog/overview') >= 0) window.__qaOv = rec;
    return of.apply(this, arguments).then(function(res){ rec.end = performance.now(); rec.status = res.status; return res; }, function(err){ rec.end = performance.now(); rec.error = String(err && err.message ? err.message : err); throw err; });
  };
  document.addEventListener('keydown', function(e){ if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) window.__qaKeyAt = performance.now(); }, true);
})();`

function snap() {
  return page.evaluate(() => {
    const list = document.getElementById('cmdk-list')
    const out = {
      maskOn: document.getElementById('cmdk-mask').classList.contains('on'),
      inputValue: document.getElementById('cmdk-input').value,
      placeholder: document.getElementById('cmdk-input').placeholder,
      groups: [],
    }
    let cur = null
    Array.prototype.slice.call(list.children).forEach((el) => {
      if (el.classList.contains('cmdk-group')) { cur = { title: (el.textContent || '').trim(), items: [] }; out.groups.push(cur) }
      else if (el.classList.contains('cmdk-item') && cur) {
        const lbEl = el.querySelector('.lb'), subEl = el.querySelector('.sub')
        cur.items.push({ lb: (lbEl && lbEl.textContent) || '', sub: (subEl && subEl.textContent) || '', sel: el.classList.contains('sel'), idx: el.dataset.i })
      }
    })
    out.backlogGroup = null
    for (let i = 0; i < out.groups.length; i++) if (out.groups[i].title === '待办') out.backlogGroup = out.groups[i]
    const ov = window.__qaOv
    out.ov = ov ? { start: ov.start, end: ov.end || null, inFlight: !ov.end, dur: ov.end ? ov.end - ov.start : null, status: ov.status || null, error: ov.error || null } : null
    out.keyAt = window.__qaKeyAt
    out.now = performance.now()
    out.errors = window.__qaErrors.slice()
    return out
  })
}
async function setQuery(q) {
  await page.fill('#cmdk-input', q)
  await page.evaluate(() => { const i = document.getElementById('cmdk-input'); i.dispatchEvent(new Event('input', { bubbles: true })) })
  await page.waitForTimeout(60)
  return snap()
}

// ---------------- 0. 准备：登录 + 应用就绪 ----------------
await page.cdp('Page.addScriptToEvaluateOnNewDocument', { source: INIT_JS })
await page.goto(STATE.origin + '/healthz')
await page.evaluate((prefix) => fetch(prefix + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'workbuddy', password: 'workbuddy-admin' }),
}).then((r) => r.status), STATE.prefix)
await page.goto(STATE.baseUrl)
await page.waitForFunction(() => {
  try { return !!document.getElementById('nav') && !!state && Array.isArray(state.projects) && state.projects.length >= 6 && !!document.getElementById('cmdk-mask') } catch (e) { return false }
}, undefined, { timeout: 40000 })
await page.waitForTimeout(400)
const cold = await page.evaluate(() => ({
  url: location.href,
  projectCount: (function () { try { return state.projects.length } catch (e) { return -1 } })(),
  cmdkBlCache: window.cmdkBl ? window.cmdkBl.cache : 'missing',
  blStateData: window.blState ? window.blState.data : 'missing',
  ov: window.__qaOv,
  errors: window.__qaErrors.slice(),
}))
rec('P0.1', '登录并加载控制台（项目 >= 6、cmdk DOM 就绪）', cold.projectCount >= 6, `projects=${cold.projectCount} url=${cold.url}`)
rec('P0.2', '首屏未提前拉 /backlog/overview（⌘K 冷缓存场景成立）', cold.ov === null && cold.cmdkBlCache == null && cold.blStateData == null,
  `ov=${JSON.stringify(cold.ov)} cmdkBl.cache=${JSON.stringify(cold.cmdkBlCache)} blState.data=${JSON.stringify(cold.blStateData)}`)

// ---------------- AC#3a：面板打开不被慢 overview 阻塞 + 懒加载补入 ----------------
await page.keyboard.press('Control+k')
const openSnap = await snap()
rec('A1', 'Ctrl+K 立即呼出 #cmdk-mask.on（此时 overview 仍在途）', openSnap.maskOn === true, `maskOn=${openSnap.maskOn}`)
rec('A2', '呼出时已同步发起 GET /api/backlog/overview 且未 await', Boolean(openSnap.ov && openSnap.ov.start > 0), `ov=${JSON.stringify(openSnap.ov)}`)
rec('A3', '面板打开延迟（按键→读到 .on）远小于 overview 耗时', openSnap.ov && openSnap.ov.inFlight === true && (openSnap.now - openSnap.keyAt) < 1500,
  `probeDelay=${Math.round(openSnap.now - openSnap.keyAt)}ms ovInFlight=${openSnap.ov && openSnap.ov.inFlight}`)

const during1 = await setQuery('定时')
const viewGroup1 = during1.groups.find((g) => g.title === '视图') || { items: [] }
const hasSchedules = viewGroup1.items.some((it) => it.lb.indexOf('定时任务') >= 0)
rec('A4', 'overview 在途期间其它命令仍可用（输入「定时」命中视图·定时任务）', hasSchedules && during1.ov && during1.ov.inFlight === true,
  `groups=${during1.groups.map((g) => g.title + ':' + g.items.length).join(',')} ovInFlight=${during1.ov && during1.ov.inFlight}`)

const during2 = await setQuery('TASK-1')
const lazyBefore = {
  hasBacklogGroup: Boolean(during2.backlogGroup),
  ovInFlight: Boolean(during2.ov && during2.ov.inFlight),
  elapsedSinceKey: during2.now - during2.keyAt,
  groups: during2.groups.map((g) => g.title + ':' + g.items.length),
}
await page.screenshot({ path: OUTDIR + '/task1-01-desktop-cmdk-overview-loading.png' })
rec('A5', '慢 overview 未返回前输入 itemId 不出现「待办」组（懒加载，非阻塞等待）', lazyBefore.ovInFlight ? lazyBefore.hasBacklogGroup === false : true,
  `hasBacklogGroup=${lazyBefore.hasBacklogGroup} ovInFlight=${lazyBefore.ovInFlight} elapsedSinceKey=${Math.round(lazyBefore.elapsedSinceKey)}ms groups=${lazyBefore.groups.join(',')}`)

let lazyAfter = null
let lazyWaitErr = ''
try {
  await page.waitForFunction(() => {
    try {
      const ov = window.__qaOv
      const groups = Array.prototype.slice.call(document.querySelectorAll('#cmdk-list .cmdk-group')).map((g) => (g.textContent || '').trim())
      return !!(ov && ov.end && groups.indexOf('待办') >= 0 && document.getElementById('cmdk-mask').classList.contains('on'))
    } catch (e) { return false }
  }, undefined, { timeout: 25000 })
} catch (e) { lazyWaitErr = String(e && e.message ? e.message : e) }
lazyAfter = await snap()
const appearsAfterEnd = Boolean(lazyAfter.ov && lazyAfter.ov.end) && Boolean(lazyAfter.backlogGroup)
rec('A6', 'overview 返回后「待办」组在面板保持打开时自动补入（未关闭重开）', appearsAfterEnd && lazyAfter.maskOn === true && lazyAfter.inputValue === 'TASK-1',
  lazyWaitErr || `maskOn=${lazyAfter.maskOn} input=${lazyAfter.inputValue} groups=${lazyAfter.groups.map((g) => g.title + ':' + g.items.length).join(',')}`)
const ovSlow = lazyAfter.ov ? lazyAfter.ov.dur : null
rec('A7', `overview 确实慢（实测耗时 >= ${Math.round(STATE.slowMs * 1.6)}ms，制造阻塞风险成立）`, ovSlow !== null && ovSlow >= STATE.slowMs * 1.6,
  `overviewDur=${ovSlow === null ? 'null' : Math.round(ovSlow) + 'ms'} status=${lazyAfter.ov && lazyAfter.ov.status}`)
await page.screenshot({ path: OUTDIR + '/task1-02-desktop-cmdk-lazy-backlog-group.png' })

// ---------------- AC#1：itemId / 标题片段 / 状态词命中「待办」组 ----------------
const expectProjects = [STATE.projectA.name, STATE.projectC.name]
const expectItemText = [
  STATE.projectA.items[0].itemId + ' ' + STATE.projectA.items[0].title,
  STATE.projectC.items[0].itemId + ' ' + STATE.projectC.items[0].title,
]
const byId = await setQuery('TASK-1')
const idItems = byId.backlogGroup ? byId.backlogGroup.items : []
const crossProject = expectProjects.every((p) => idItems.some((it) => it.sub.indexOf(p) >= 0))
rec('B1', '「待办」组标题恰为「待办」，输入 itemId（大写 TASK-1，大小写不敏感）命中 A、C 两个项目条目',
  Boolean(byId.backlogGroup) && byId.backlogGroup.title === '待办' && idItems.length === 2 && crossProject,
  `groupTitle=${byId.backlogGroup && byId.backlogGroup.title} items=${JSON.stringify(idItems.map((x) => ({ lb: x.lb, sub: x.sub })))}`)
rec('B2', '跨项目命中：同编号 task-1 分别来自 TASK1 验收项目A 与 TASK1 跨项目C', crossProject, `subs=${idItems.map((x) => x.sub).join(' | ')}`)
rec('B3', '命中条目文本含 itemId + 标题（lb 契约）', expectItemText.every((t) => idItems.some((it) => it.lb === t)),
  `expect=${JSON.stringify(expectItemText)}`)
await page.screenshot({ path: OUTDIR + '/task1-03-desktop-cmdk-itemid-crossproject.png' })

const titleQ = await setQuery('全局检索')
const titleItems = titleQ.backlogGroup ? titleQ.backlogGroup.items : []
rec('B4', '标题片段「全局检索」命中 A 项目 task-1', titleItems.length === 1 && titleItems[0].lb.indexOf('接入 cmdk 全局检索入口') >= 0,
  `items=${JSON.stringify(titleItems.map((x) => x.lb))}`)

const titleC = await setQuery('跨项目独有标题片段')
const titleCItems = titleC.backlogGroup ? titleC.backlogGroup.items : []
rec('B5', '标题片段「跨项目独有标题片段」命中 C 项目 task-2', titleCItems.length === 1 && titleCItems[0].lb.indexOf('跨项目独有标题片段') >= 0 && titleCItems[0].sub.indexOf(STATE.projectC.name) >= 0,
  `items=${JSON.stringify(titleCItems.map((x) => x.lb + ' / ' + x.sub))}`)

const stTodo = await setQuery('To Do')
const todoItems = stTodo.backlogGroup ? stTodo.backlogGroup.items : []
rec('B6', '状态词「To Do」命中 2 条 To Do 待办（A、C）', todoItems.length === 2 && todoItems.every((it) => it.sub.indexOf('To Do') >= 0),
  `items=${JSON.stringify(todoItems.map((x) => x.lb + ' / ' + x.sub))}`)

const stIn = await setQuery('In Progress')
const inItems = stIn.backlogGroup ? stIn.backlogGroup.items : []
rec('B7', '状态词「In Progress」命中 2 条 In Progress 待办（A、C）', inItems.length === 2 && inItems.every((it) => it.sub.indexOf('In Progress') >= 0),
  `items=${JSON.stringify(inItems.map((x) => x.lb + ' / ' + x.sub))}`)
await page.screenshot({ path: OUTDIR + '/task1-04-desktop-cmdk-status-in-progress.png' })

const stDone = await setQuery('Done')
const doneItems = stDone.backlogGroup ? stDone.backlogGroup.items : []
rec('B8', '状态词「Done」命中 A 项目 1 条 Done 待办', doneItems.length === 1 && doneItems[0].lb.indexOf('已完成历史待办') >= 0,
  `items=${JSON.stringify(doneItems.map((x) => x.lb + ' / ' + x.sub))}`)

const lowerId = await setQuery('task-1')
const lowerItems = lowerId.backlogGroup ? lowerId.backlogGroup.items : []
rec('B9', '小写 itemId「task-1」同样命中 2 条（大小写不敏感）', lowerItems.length === 2, `items=${lowerItems.length}`)
const placeholder = await page.evaluate(() => document.getElementById('cmdk-input').placeholder)
rec('B10', '面板 placeholder 含待办检索提示', placeholder.indexOf('待办') >= 0 && placeholder.indexOf('状态') >= 0, `placeholder=${placeholder}`)

// ---------------- AC#3b：未初始化 / 不可达 / 归档 / 慢节点项目条目不得出现 ----------------
const ghostQ = await setQuery('残留待办')
const ghostTexts = ghostQ.groups.reduce((acc, g) => acc.concat(g.items.map((it) => g.title + '|' + it.lb + '|' + it.sub)), [])
rec('C1', '不可达项目（TASK1 不可达项目）残留条目不得出现', !ghostQ.backlogGroup && ghostTexts.every((t) => t.indexOf('不可达节点残留待办') < 0),
  `groups=${ghostQ.groups.map((g) => g.title + ':' + g.items.length).join(',')} backlogGroup=${Boolean(ghostQ.backlogGroup)}`)

const ghostQ2 = await setQuery('归档项目残留')
rec('C2', '归档项目（TASK1 归档项目）残留条目不得出现', !ghostQ2.backlogGroup && ghostQ2.groups.every((g) => g.items.every((it) => it.lb.indexOf('归档项目残留待办') < 0)),
  `groups=${ghostQ2.groups.map((g) => g.title + ':' + g.items.length).join(',')}`)

const uninitQ = await setQuery('未初始化')
const uninitBacklog = uninitQ.backlogGroup ? uninitQ.backlogGroup.items : []
const dAsProjectCmd = uninitQ.groups.some((g) => g.title === '项目' && g.items.some((it) => it.lb.indexOf(STATE.projectD.name) >= 0))
rec('C3', '未初始化 backlog 项目（TASK1 未初始化项目）无「待办」条目（仅可能作为「项目」命令出现）',
  uninitBacklog.length === 0 && uninitBacklog.every((it) => it.sub.indexOf(STATE.projectD.name) < 0),
  `backlogItems=${uninitBacklog.length} projectCmdVisible=${dAsProjectCmd}`)

const allSubs = []
for (const q of ['TASK-1', '全局检索', 'To Do', 'In Progress', 'Done', '残留待办', '归档项目残留', '未初始化']) {
  const s = await setQuery(q)
  if (s.backlogGroup) for (const it of s.backlogGroup.items) allSubs.push(it.sub)
}
const forbiddenProjects = [STATE.projectB.name, STATE.projectE.name, STATE.projectD.name, STATE.projectS.name]
const leaked = allSubs.filter((sub) => forbiddenProjects.some((p) => sub.indexOf(p) >= 0))
rec('C4', '全部检索中「待办」组不含 unreachable/archived/未初始化/慢节点任一项目的条目', leaked.length === 0,
  `scannedGroups=${allSubs.length} leaked=${JSON.stringify(leaked)}`)

const cacheCheck = await page.evaluate(() => {
  try {
    const c = window.cmdkBl && window.cmdkBl.cache
    if (!c) return { cache: 'missing' }
    return { cache: c.map((g) => ({ name: g.projectName, nodeStatus: g.nodeStatus, initialized: g.initialized, items: (g.items || []).length })) }
  } catch (e) { return { cache: 'error', e: String(e) } }
})
const stat = {}
if (Array.isArray(cacheCheck.cache)) for (const g of cacheCheck.cache) stat[g.name] = g
const wantStat = [
  [STATE.projectA.name, 'ok', true, 3],
  [STATE.projectC.name, 'ok', true, 2],
  [STATE.projectD.name, 'ok', false, 0],
  [STATE.projectB.name, 'unreachable', false, 0],
  [STATE.projectE.name, 'archived', false, 0],
  [STATE.projectS.name, 'ok', false, 0],
]
const statOk = wantStat.every((w) => Boolean(stat[w[0]]) && stat[w[0]].nodeStatus === w[1] && stat[w[0]].initialized === w[2] && stat[w[0]].items === w[3])
rec('C5', '⌘K 数据源 overview 语义正确（A/C ok+initialized；D/S ok 未初始化；B unreachable；E archived）', statOk,
  `cache=${JSON.stringify(cacheCheck.cache)}`)

// ---------------- AC#2：选中 → 切 #backlog 看板 + 打开条目详情弹层 ----------------
await setQuery('全局检索')
const selSnap = await snap()
const firstSel = selSnap.backlogGroup && selSnap.backlogGroup.items.find((it) => it.sel)
rec('D1', '目标条目前置于待办组且默认为选中项（Enter 可达）', Boolean(firstSel) && firstSel.lb.indexOf('接入 cmdk 全局检索入口') >= 0,
  `sel=${JSON.stringify(firstSel)}`)

await page.keyboard.press('Enter')
let jumpErr = ''
try {
  await page.waitForFunction(() => location.hash === '#backlog' && document.getElementById('view-backlog').classList.contains('on'), undefined, { timeout: 15000 })
} catch (e) { jumpErr = String(e && e.message ? e.message : e) }
const afterJump = await page.evaluate(() => ({
  hash: location.hash,
  backlogOn: document.getElementById('view-backlog').classList.contains('on'),
  workOn: document.getElementById('view-work').classList.contains('on'),
  hasBoard: !!document.querySelector('#bl-root .bl-board'),
  cols: Array.prototype.slice.call(document.querySelectorAll('#bl-root .bl-col-h')).map((x) => (x.textContent || '').trim()),
  cards: Array.prototype.slice.call(document.querySelectorAll('#bl-root .bl-card')).map((x) => ({ item: x.dataset.item, text: (x.querySelector('.bl-title') || {}).textContent || '' })),
  boardTitle: (function () { const b = document.querySelector('#bl-root .bl-head b'); return b ? b.textContent : '' })(),
  cmdkMaskOn: document.getElementById('cmdk-mask').classList.contains('on'),
}))
rec('D2', 'Enter 后 hash=#backlog、#view-backlog.on、⌘K 面板已关闭', afterJump.hash === '#backlog' && afterJump.backlogOn && !afterJump.cmdkMaskOn && !afterJump.workOn,
  jumpErr || `hash=${afterJump.hash} backlogOn=${afterJump.backlogOn} workOn=${afterJump.workOn} cmdkMaskOn=${afterJump.cmdkMaskOn}`)
rec('D3', '出现该项目看板 .bl-board，标题为 TASK1 验收项目A', afterJump.hasBoard && afterJump.boardTitle.indexOf(STATE.projectA.name) >= 0,
  `hasBoard=${afterJump.hasBoard} boardTitle=${afterJump.boardTitle}`)
rec('D4', '看板含三种状态列且 To Do 列有 task-1 卡片', ['To Do', 'In Progress', 'Done'].every((s) => afterJump.cols.some((c) => c.indexOf(s) >= 0)) && afterJump.cards.some((c) => c.item === STATE.projectA.items[0].itemId),
  `cols=${JSON.stringify(afterJump.cols)} cards=${JSON.stringify(afterJump.cards.map((c) => c.item))}`)

let modalErr = ''
try {
  await page.waitForFunction(() => {
    try {
      const m = document.getElementById('modal-mask')
      const t = document.getElementById('modal-title')
      return m.classList.contains('on') && t && t.textContent && t.textContent.indexOf('接入 cmdk 全局检索入口') >= 0
    } catch (e) { return false }
  }, undefined, { timeout: 20000 })
} catch (e) { modalErr = String(e && e.message ? e.message : e) }
const modal = await page.evaluate(() => ({
  on: document.getElementById('modal-mask').classList.contains('on'),
  title: document.getElementById('modal-title').textContent || '',
  bodyHasItem: (document.getElementById('modal-body').textContent || '').indexOf('接入 cmdk 全局检索入口') >= 0,
}))
rec('D5', '随后打开条目详情弹层 #modal-mask.on，标题含 itemId 与标题', modal.on && modal.title.indexOf('task-1') >= 0 && modal.title.indexOf('接入 cmdk 全局检索入口') >= 0,
  modalErr || `title=${modal.title}`)
await page.screenshot({ path: OUTDIR + '/task1-05-desktop-backlog-board-and-detail.png' })

// 关闭弹层（modal-head ✕ 走 closeModal）
await page.click('#modal-mask .modal-head button')
await page.waitForFunction(() => !document.getElementById('modal-mask').classList.contains('on'), undefined, { timeout: 8000 }).catch(() => {})
const afterClose = await page.evaluate(() => ({
  modalOn: document.getElementById('modal-mask').classList.contains('on'),
  backlogOn: document.getElementById('view-backlog').classList.contains('on'),
  hasBoard: !!document.querySelector('#bl-root .bl-board'),
}))
rec('D6', '关闭详情弹层后仍停留在该项目看板（跳转链路完整）', !afterClose.modalOn && afterClose.backlogOn && afterClose.hasBoard,
  `modalOn=${afterClose.modalOn} backlogOn=${afterClose.backlogOn} hasBoard=${afterClose.hasBoard}`)

// ---------------- 补充：按钮呼出 / 空查询不展开条目 / Esc / Meta+K ----------------
await page.click('#cmdk-btn')
await page.waitForTimeout(150)
const emptySnap = await snap()
const viewCmd = emptySnap.groups.some((g) => g.title === '视图' && g.items.some((it) => it.lb.indexOf('待办 · Backlog') >= 0))
rec('E1', '点击 header ⌘K 按钮呼出面板', emptySnap.maskOn === true, `maskOn=${emptySnap.maskOn}`)
rec('E2', '空查询不展开待办条目（保持轻量）但存在「待办 · Backlog」视图命令', !emptySnap.backlogGroup && viewCmd,
  `backlogGroup=${Boolean(emptySnap.backlogGroup)} hasViewCmd=${viewCmd} groups=${emptySnap.groups.map((g) => g.title + ':' + g.items.length).join(',')}`)
await page.screenshot({ path: OUTDIR + '/task1-06-desktop-cmdk-empty-query.png' })
await page.keyboard.press('Escape')
await page.waitForTimeout(120)
const escSnap = await snap()
rec('E3', 'Esc 关闭面板', escSnap.maskOn === false, `maskOn=${escSnap.maskOn}`)
await page.keyboard.press('Meta+k')
await page.waitForTimeout(150)
const metaSnap = await snap()
rec('E4', 'Meta+K（⌘K）同样呼出面板', metaSnap.maskOn === true, `maskOn=${metaSnap.maskOn}`)
await page.keyboard.press('Escape')
await page.waitForTimeout(120)

// ---------------- 全程无 pageerror / console.error ----------------
const errors = await page.evaluate(() => window.__qaErrors.slice())
rec('F1', '全程无 pageerror / unhandledrejection / console.error', errors.length === 0, JSON.stringify(errors.slice(0, 6)))

// ---------------- 汇总 ----------------
const failed = results.filter((r) => !r.pass)
const summary = { ok: failed.length === 0, total: results.length, failed: failed.length, results, errors, state: { projectA: STATE.projectA, projectC: STATE.projectC, projectB: STATE.projectB, projectD: STATE.projectD, projectE: STATE.projectE, projectS: STATE.projectS, slowMs: STATE.slowMs } }
await fs.writeFile(RESULT_PATH, JSON.stringify(summary, null, 2))
console.log('\n===== 桌面轮汇总：' + (summary.ok ? '全部 PASS ✅' : failed.length + ' 项 FAIL ❌') + `（${results.length} 项） =====`)
if (failed.length) console.log('FAILED: ' + failed.map((r) => r.id + ' ' + r.name).join(' | '))
console.log('RESULT_JSON ' + RESULT_PATH)
