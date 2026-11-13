const task = await taskSpace("verify-place-pjy-20261106");
const page = task.page("p1");
console.log("spaceId:", task.spaceId);
await page.goto("https://natpass.yikaihui.com/onenat-workbuddy/?r=" + Date.now(), { timeout: 40000 });
await page.waitForLoadState();

const needLogin = await page.evaluate(() => Boolean(document.getElementById('username')));
if (needLogin) {
  await page.fill('#username', 'workbuddy');
  await page.fill('#password', 'ThunderSoft@88');
  await page.click('#btn', { label: '提交登录表单' });
  await page.waitForSelector('#view-work', { state: 'visible', timeout: 30000 });
  console.log('login: ok');
} else {
  console.log('login: already signed in');
}

// 等目录加载完成（boot 加载 11 个 DSH 节点，含 pjy）
await page.waitForFunction(() => typeof state !== 'undefined' && state.resources && state.resources.length > 0, undefined, { timeout: 20000 });
const fresh = await page.evaluate(() => dshNodeOptions().some(r => r.mappingId === '949c4354'));
console.log('fresh page has pjy (expect true):', fresh);

// ★ 复现用户场景：模拟"开了一上午的老页面"——目录里没有 pjy 且目录已过期
await page.evaluate(() => {
  state.resources = state.resources.filter(r => r.mappingId !== '949c4354');
  state.resourcesAt = Date.now() - 120000;
});
const stale = await page.evaluate(() => dshNodeOptions().some(r => r.mappingId === '949c4354'));
console.log('stale catalog has pjy (expect false):', stale);

// 进入新任务草稿，打开执行位置下拉
await page.evaluate(() => { switchView('work'); startDraft(); });
await page.waitForSelector('#draft-place-btn', { state: 'visible', timeout: 15000 });
await page.click('#draft-place-btn', { label: '打开执行位置下拉' });
await page.waitForSelector('#place-node-list', { state: 'visible', timeout: 10000 });

const immediately = await page.evaluate(() => document.getElementById('place-node-list').textContent.includes('pjy'));
console.log('pjy visible immediately (expect false, 目录还是旧的):', immediately);

// 修复点：目录过期 → 打开下拉时后台自动重拉 → pjy-DSH 不刷新页面自动出现
await page.waitForFunction(() => {
  const box = document.getElementById('place-node-list');
  return box && box.textContent.indexOf('pjy') >= 0;
}, undefined, { timeout: 20000 });

const found = await page.evaluate(() => {
  const box = document.getElementById('place-node-list');
  const items = Array.from(box.querySelectorAll('.main-agent-item .ag-title')).map(x => x.textContent.trim());
  return { nodeCount: items.length, pjy: items.filter(t => t.indexOf('pjy') >= 0), catalogCount: dshNodeOptions().length };
});
console.log('RESULT:', JSON.stringify(found, null, 2));
await page.screenshot({ path: '/Users/tsbj/feyanggit/DHS-test/onenat-workbuddy-web/qa-import-pjy-20261106/place-pjy-auto-refresh.png' });
console.log('screenshot saved');
