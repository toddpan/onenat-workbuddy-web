/** Session acceptance evidence; run after live fixture: node scripts/project-console-browser-run.mjs live */
const fs = await import('node:fs/promises')
const assert = (await import('node:assert/strict')).default
const crypto = await import('node:crypto')
const out = task58RepoRoot + '/artifacts/task58/live'
const fixture = JSON.parse(await fs.readFile(out + '/fixture.json', 'utf8'))
const task = await taskSpace('workbuddy task58 console acceptance')
const page = task.page('p1')
const report = { at: new Date().toISOString(), checks: [], refs: fixture.refs }
async function check(name, fn) {
  try { const evidence = await fn(); report.checks.push({ name, result: 'PASS', evidence }); console.log('PASS ' + name) }
  catch (e) { report.checks.push({ name, result: 'FAIL', error: e.message }); throw e }
  finally { await fs.writeFile(out + '/browser-acceptance.json', JSON.stringify(report, null, 2)) }
}
await page.cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
await page.goto(fixture.base)
await page.fill('input[placeholder="用户名"]', 'workbuddy'); await page.fill('input[placeholder="密码"]', 'workbuddy-admin'); await page.click('loc=role:button[name="登 录"]')
await page.waitForSelector('#app')
await page.evaluate(() => { const fab = document.getElementById('kiss-translator-fab'); if (fab) fab.style.setProperty('display', 'none', 'important') })
await check('#2 real project editor identifies file owner, default executor and remote access', async () => {
  await page.click('nav button[data-v="projects"]'); await page.waitForSelector('.pj-edit'); await page.click('.pj-edit'); await page.waitForSelector('#pj-f-exec', { state: 'visible' })
  const value = await page.evaluate(() => ({ file: JSON.parse(document.getElementById('pj-f-node').value), exec: JSON.parse(document.getElementById('pj-f-exec').value), access: document.getElementById('pj-f-access').textContent, workspace: document.getElementById('pj-f-ws').value }))
  assert.equal(value.file.mappingId, fixture.refs.owner.mappingId); assert.equal(value.exec.mappingId, fixture.refs.executor.mappingId); assert.match(value.access, /跨节点远程访问/)
  await page.screenshot({ path: out + '/desktop-editor.png' }); await page.click('loc=role:button[name="取消"]')
  return value
})
let taskId
await check('#1 real browser selects authorized executor and creates project draft with nodeRef', async () => {
  await page.click('.pj-enter'); await page.waitForSelector('#draft-place-btn', { state: 'visible' }); await page.click('#draft-place-btn')
  await page.waitForSelector('.place-pop [data-mid="' + fixture.refs.executor.mappingId + '"]')
  await page.click('.place-pop [data-mid="' + fixture.refs.executor.mappingId + '"]')
  await page.click('#chat-model-btn')
  await page.waitForSelector('.model-item[data-v="deepseek-official/deepseek-v4-flash"]', { timeout: 30000 })
  await page.click('.model-item[data-v="deepseek-official/deepseek-v4-flash"]')
  // Use the normal draft materialization used before attachments. Set only a temporary execution cwd
  // in the fixture controller before any prompt, so the live model cannot write to production cwd.
  taskId = await page.evaluate(async () => commitDraft(''))
  assert.ok(taskId)
  const isolated = await (await fetch(fixture.controlBase + '/isolate-draft', { method: 'POST', body: JSON.stringify({ taskId }) })).json()
  assert.equal(isolated.ok, true)
  await page.evaluate(async taskId => { await openTask(taskId) }, taskId)
  const saved = await page.evaluate(() => ({ id: currentTaskObj().id, projectId: currentTaskObj().projectId, nodeRef: currentTaskObj().nodeRef, model: currentTaskObj().model }))
  assert.equal(saved.projectId, fixture.projectId); assert.equal(saved.nodeRef.mappingId, fixture.refs.executor.mappingId)
  return saved
})
await check('#1 real send runs DSH session on selected node in isolated execution directory', async () => {
  await page.fill('#input', '这是 task-58 控制台验收。只运行一次命令 node -e "console.log(process.cwd())"，然后返回 TASK58_OK 和实际 cwd。不要修改任何文件、不要派发任务、不要调用 WorkBuddy 或 OneNat 管理工具。')
  await page.click('#btn-send')
  await page.waitForFunction(() => currentTaskObj() && !['running', 'draft'].includes(currentTaskObj().status), undefined, { timeout: 240000 })
  const evidence = await (await fetch(fixture.controlBase + '/evidence')).json()
  const t = evidence.tasks.find(t => t.id === taskId)
  assert.equal(t.status, 'completed', JSON.stringify(t)); assert.equal(t.nodeRef.mappingId, fixture.refs.executor.mappingId)
  assert.equal(t.remote.cwd, fixture.executionRoot); assert.match(t.replies.join('\n'), /TASK58_OK/)
  return t
})
await check('#3 real file tree and backlog read file owner while execution is on another node', async () => {
  await page.click('#btn-ws-toggle'); await page.waitForFunction(() => document.getElementById('ws-files-root')?.textContent.includes('README.md'), undefined, { timeout: 30000 })
  const files = await page.evaluate(() => ({ text: document.getElementById('ws-files-root').textContent, node: wsFiles.node, projectId: wsFiles.projectId, root: wsFiles.root }))
  assert.equal(files.node.mappingId, fixture.refs.owner.mappingId); assert.equal(files.root, fixture.root)
  const content = await page.evaluate(async ({ projectId, refs, root }) => {
    const query = 'projectId=' + projectId + '&node=' + encodeURIComponent(JSON.stringify(refs.executor)) + '&path=' + encodeURIComponent(root + '/README.md') + '&inline=1'
    const r = await fetch('/onenat-workbuddy/api/agents/fs/download?' + query)
    if (!r.ok) throw new Error('Owner download failed ' + r.status)
    return r.text()
  }, fixture)
  const expected = (await (await fetch(fixture.controlBase + '/evidence')).json()).markerSha256
  const actual = crypto.createHash('sha256').update(content).digest('hex'); assert.equal(actual, expected)
  await page.screenshot({ path: out + '/desktop-files.png' }); await page.click('#btn-ws-toggle')
  await page.click('nav button[data-v="backlog"]'); await page.waitForFunction(() => document.getElementById('view-backlog').textContent.includes('Task58 live owner-only backlog'), undefined, { timeout: 30000 })
  const backlog = await page.evaluate(() => document.getElementById('view-backlog').textContent)
  return { files, sha256: actual, backlog }
})
await check('#3 real owner backlog and editor usable at 390px mobile viewport', async () => {
  await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await page.cdp('Emulation.setTouchEmulationEnabled', { enabled: true })
  const geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  assert.equal(geometry.width, 390); assert.equal(geometry.scrollWidth, 390)
  await page.screenshot({ path: out + '/mobile-backlog.png' })
  await page.click('nav button[data-v="projects"]'); await page.click('.pj-edit'); await page.waitForSelector('#pj-f-exec', { state: 'visible' })
  const form = await page.evaluate(() => ({ width: innerWidth, scroll: document.getElementById('modal-body').scrollWidth, client: document.getElementById('modal-body').clientWidth, access: document.getElementById('pj-f-access').textContent }))
  assert.ok(form.scroll <= form.client); assert.match(form.access, /跨节点远程访问/)
  await page.screenshot({ path: out + '/mobile-editor.png' }); await page.click('loc=role:button[name="取消"]')
  return { geometry, form }
})
await fs.writeFile(out + '/browser-acceptance.json', JSON.stringify(report, null, 2))
console.log('PASS real ONENAT console: ' + report.checks.length + '/' + report.checks.length)
