/** Session acceptance evidence; run with: node scripts/project-console-browser-run.mjs mock */
const fs = await import('node:fs/promises')
const assert = (await import('node:assert/strict')).default
const out = task58Artifacts
const fixture = JSON.parse(await fs.readFile(out + '/fixture.json', 'utf8'))
const task = await taskSpace(task58BrowserSpace)
const page = task.page('p1')
const report = { at: new Date().toISOString(), spaceId: task.spaceId, checks: [], layouts: [] }
async function check(name, fn) {
  try { const evidence = await fn(); report.checks.push({ name, result: 'PASS', evidence }); console.log('PASS ' + name) }
  catch (e) { report.checks.push({ name, result: 'FAIL', error: e.message }); throw e }
  finally { await fs.writeFile(out + '/browser-acceptance.json', JSON.stringify(report, null, 2)) }
}
async function viewport(width, height) {
  await page.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width <= 768 })
  await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: width <= 768 })
}
async function nav(view) { await page.click('nav button[data-v="' + view + '"]') }
async function enter() { await nav('projects'); await page.waitForSelector('.pj-enter'); await page.click('.pj-enter'); await page.waitForSelector('#draft-place-btn', { state: 'visible' }) }
async function choose(id) { await page.click('#draft-place-btn'); await page.click('.place-pop [data-mid="' + id + '"]') }
async function send(text) {
  await page.fill('#input', text); await page.click('#btn-send')
  await page.waitForFunction(() => currentTaskObj()?.status === 'completed', undefined, { timeout: 25000 })
  return page.evaluate(() => ({ id: currentTaskObj().id, projectId: currentTaskObj().projectId, nodeRef: currentTaskObj().nodeRef }))
}
async function files() {
  await page.click('#btn-ws-toggle')
  await page.waitForFunction(() => document.getElementById('ws-files-root')?.textContent.includes('README.md'))
  return page.evaluate(() => ({ text: document.getElementById('ws-files-root').textContent, node: wsFiles.node, projectId: wsFiles.projectId, rootSrc: wsFiles.rootSrc }))
}
async function closeEditor() { await page.click('loc=role:button[name="取消"]'); await page.waitForFunction(() => !document.getElementById('modal-mask').classList.contains('on')) }
async function layout(name, selector) {
  const value = await page.evaluate(selector => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, rect: document.querySelector(selector).getBoundingClientRect().toJSON() }), selector)
  assert.ok(value.rect.left >= -1 && value.rect.right <= value.width + 1, JSON.stringify(value))
  assert.ok(value.scrollWidth <= value.width, JSON.stringify(value))
  report.layouts.push({ name, ...value }); return value
}
await fetch(fixture.directoryBase + '/control', { method: 'POST', body: JSON.stringify({ ownerOnline: true, extraOnline: false }) })
await viewport(1280, 900)
await page.goto(fixture.base)
if (await page.evaluate(() => !!document.querySelector('input[placeholder="用户名"]'))) {
  await page.fill('input[placeholder="用户名"]', 'workbuddy'); await page.fill('input[placeholder="密码"]', 'workbuddy-admin'); await page.click('loc=role:button[name="登 录"]')
}
await page.waitForSelector('#app')
// Test-page-only isolation: remove the extension's independent shadow-root hosts.
// A document stylesheet cannot reliably override extension inline styles or shadow contents.
report.extensionIsolation = await page.evaluate(() => {
  const removed = []
  const isolate = () => {
    for (const id of ['kiss-translator-fab', 'kiss-translator-box']) {
      const host = document.getElementById(id)
      if (host) { removed.push({ id, hadShadowRoot: !!host.shadowRoot }); host.remove() }
    }
  }
  isolate()
  const observer = new MutationObserver(isolate)
  observer.observe(document.documentElement, { childList: true, subtree: true })
  window.task58ExtensionIsolation = { removed, observer }
  return { scope: 'isolated page only', removed }
})
await page.evaluate(async ({projectId,refs}) => {
  const r = await fetch('/onenat-workbuddy/api/projects/' + projectId, { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify({defaultExecutionNodeRef: refs.executor}) });
  if (!r.ok) throw new Error('Unable to reset isolated fixture default');
  await loadProjects();
}, fixture)
await page.evaluate(() => {
  window.task58Evidence = { requests: [], errors: [] }
  window.addEventListener('error', e => window.task58Evidence.errors.push(e.message))
  const original = window.fetch
  window.fetch = function(url, options) {
    if (options?.body && typeof options.body === 'string') { try { window.task58Evidence.requests.push({ url: String(url), method: options.method, body: JSON.parse(options.body) }) } catch {} }
    return original.apply(this, arguments)
  }
})
await check('#1 desktop project picker preserves draft/project and sends explicit nodeRef', async () => {
  await enter(); await choose('file-owner'); await page.fill('#input', 'Task58 desktop browser execution')
  await choose('execution'); assert.equal(await page.evaluate(() => document.getElementById('input').value), 'Task58 desktop browser execution')
  const t = await send('Task58 desktop browser execution')
  assert.equal(t.projectId, fixture.projectId); assert.equal(t.nodeRef.mappingId, 'execution')
  const payload = await page.evaluate(() => window.task58Evidence.requests.find(r => r.url.endsWith('/tasks'))?.body)
  assert.equal(payload.projectId, fixture.projectId); assert.equal(payload.nodeRef.mappingId, 'execution')
  const f = await files(); assert.equal(f.node.mappingId, 'file-owner'); assert.match(f.rootSrc, /跨节点远程访问/); assert.doesNotMatch(f.text, /EXECUTOR_ONLY/)
  await page.screenshot({ path: out + '/desktop-files.png' }); await page.click('#btn-ws-toggle')
  return { task: t, payload, files: f }
})
await check('#2 editor separates owner/default nodes, updates access text and persists only chosen default', async () => {
  await nav('projects'); await page.click('.pj-edit'); await page.waitForSelector('#pj-f-exec')
  const before = await page.evaluate(() => ({ file: JSON.parse(document.getElementById('pj-f-node').value), exec: JSON.parse(document.getElementById('pj-f-exec').value), note: document.getElementById('pj-f-access').textContent }))
  assert.equal(before.file.mappingId, 'file-owner'); assert.equal(before.exec.mappingId, 'execution'); assert.match(before.note, /跨节点远程访问/)
  await page.selectOption('#pj-f-exec', ''); assert.match(await page.evaluate(() => document.getElementById('pj-f-access').textContent), /同节点直接访问/)
  await page.click('loc=role:button[name="保存配置"]'); await page.waitForFunction(() => !document.getElementById('modal-mask').classList.contains('on'))
  await page.waitForFunction(() => document.querySelector('.proj-card')?.textContent.includes('同节点直接访问'))
  await page.click('.pj-edit'); await page.waitForSelector('#pj-f-exec', { state: 'visible' })
  assert.equal(await page.evaluate(() => document.getElementById('pj-f-exec').value), '')
  const saved = await page.evaluate(() => ({ file: JSON.parse(document.getElementById('pj-f-node').value), workspace: document.getElementById('pj-f-ws').value }))
  assert.equal(saved.file.mappingId, 'file-owner'); assert.equal(saved.workspace, fixture.root)
  await closeEditor(); return { before, saved }
})
for (const width of [320, 390, 768]) {
  await viewport(width, 844)
  await check('#1/#3 mobile ' + width + 'px project node selection, files and backlog', async () => {
    await enter(); await page.click('#draft-place-btn')
    const popup = await layout('picker-' + width, '.place-pop')
    assert.ok(popup.rect.top >= 12 && popup.rect.bottom <= popup.height - 12, JSON.stringify(popup))
    assert.equal(await page.evaluate(() => !!document.querySelector('.place-pop [data-mid="offline"]')), false)
    await page.click('.place-pop [data-mid="file-owner"]')
    const t = await send('Task58 mobile browser ' + width)
    assert.equal(t.projectId, fixture.projectId); assert.equal(t.nodeRef.mappingId, 'file-owner')
    const f = await files(); assert.equal(f.node.mappingId, 'file-owner'); assert.match(f.rootSrc, /同节点直接访问/); assert.doesNotMatch(f.rootSrc, /跨节点远程访问/)
    await layout('files-' + width, '#ws-side')
    if (width === 390) await page.screenshot({ path: out + '/mobile-files.png' })
    const closeHit = await page.evaluate(() => {
      const button = document.getElementById('btn-ws-close')
      const rect = button.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      window.task58CloseEvents = []
      button.addEventListener('click', event => window.task58CloseEvents.push({ isTrusted: event.isTrusted, target: event.target.id }), { once: true })
      return { button: rect.toJSON(), hit: hit?.id, receivesInput: hit === button || button.contains(hit), extensionPresent: !!document.getElementById('kiss-translator-fab') }
    })
    assert.equal(closeHit.extensionPresent, false)
    assert.equal(closeHit.receivesInput, true, JSON.stringify(closeHit))
    await page.click('#btn-ws-close', { label: '关闭移动文件侧栏' })
    await page.waitForFunction(() => !document.getElementById('ws-side').classList.contains('on'))
    const closeEvents = await page.evaluate(() => window.task58CloseEvents)
    assert.ok(closeEvents.some(event => event.isTrusted && event.target === 'btn-ws-close'), JSON.stringify(closeEvents))
    report.layouts.push({ name: 'close-pointer-' + width, closeHit, events: closeEvents, sidebarClosed: true })
    await nav('backlog'); await page.waitForFunction(() => document.getElementById('view-backlog').textContent.includes('Owner-only backlog'))
    if (await page.evaluate(() => !!document.getElementById('bl-back'))) await page.click('#bl-back')
    await page.waitForSelector('.bl-board-btn')
    await layout('backlog-' + width, '#view-backlog')
    await page.click('.bl-board-btn'); await page.waitForSelector('.bl-card')
    const board = await page.evaluate(() => document.getElementById('view-backlog').textContent)
    assert.match(board, /Owner-only backlog/)
    if (width === 390) await page.screenshot({ path: out + '/mobile-backlog.png' })
    await nav('projects'); await page.click('.pj-edit'); await page.waitForSelector('#pj-f-node', { state: 'visible' })
    await layout('editor-' + width, '.modal')
    const form = await page.evaluate(() => ({ client: document.getElementById('modal-body').clientWidth, scroll: document.getElementById('modal-body').scrollWidth }))
    assert.ok(form.scroll <= form.client, JSON.stringify(form)); await closeEditor()
    return { task: t, files: f, form }
  })
}
await check('#1 live catalog refresh retains project identity and exposes new online node', async () => {
  await fetch(fixture.directoryBase + '/control', { method: 'POST', body: JSON.stringify({ extraOnline: true }) })
  // Refresh via the visible control so resource and probe caches follow normal UI behavior.
  await page.click('#nav-more-btn')
  await page.click('nav button[data-v="resources"]')
  await page.click('#btn-res-refresh')
  await page.waitForFunction(() => state.resources.some(node => node.mappingId === 'new-execution'))
  await enter(); await page.click('#draft-place-btn')
  // Opening the picker performs the normal TTL-gated probe; include its asynchronous repaint.
  await page.waitForSelector('.place-pop [data-mid="new-execution"]', { timeout: 20000 })
  await page.click('.place-pop [data-mid="new-execution"]')
  const place = await page.evaluate(() => state.draft.place)
  assert.equal(place.projectId, fixture.projectId); assert.equal(place.nodeMappingId, 'new-execution')
  return place
})
await check('#3 offline file owner fails closed and never lists executor files', async () => {
  await fetch(fixture.directoryBase + '/control', { method: 'POST', body: JSON.stringify({ ownerOnline: false }) })
  const r = await page.evaluate(async ({ projectId, root, refs }) => {
    const file = await fetch('/onenat-workbuddy/api/agents/fs/list?projectId=' + projectId + '&node=' + encodeURIComponent(JSON.stringify(refs.executor)) + '&path=' + encodeURIComponent(root) + '&all=1')
    const backlog = await fetch('/onenat-workbuddy/api/projects/' + projectId + '/backlog')
    return { file: { status: file.status, body: await file.json() }, backlog: { status: backlog.status, body: await backlog.json() } }
  }, fixture)
  assert.equal(r.file.status, 502); assert.equal(r.backlog.status, 502)
  await fetch(fixture.directoryBase + '/control', { method: 'POST', body: JSON.stringify({ ownerOnline: true }) })
  return r
})
const observed = await (await fetch(fixture.directoryBase + '/observations')).json()
const fileCalls = observed.observations.filter(o => /\/fs\/(list|download)$/.test(o.path))
assert.ok(fileCalls.some(o => o.query.includes('backlog')))
assert.ok(fileCalls.every(o => o.name === 'owner' && o.authorized), 'owner files/backlog must always use owner credentials')
report.ownerRequests = fileCalls
report.browserErrors = await page.evaluate(() => window.task58Evidence.errors)
report.extensionRemovals = await page.evaluate(() => window.task58ExtensionIsolation.removed)
report.interactionMode = 'Real browser pointer clicks; no evaluate click/dispatchEvent or product button handler calls'
assert.deepEqual(report.browserErrors, [])
await fs.writeFile(out + '/browser-acceptance.json', JSON.stringify(report, null, 2))
console.log('PASS task-58 browser acceptance: ' + report.checks.length + '/' + report.checks.length)
