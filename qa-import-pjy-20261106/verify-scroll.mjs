const task = await taskSpace("verify-place-pjy-20261106");
const page = task.page("p1");
await page.goto("https://natpass.yikaihui.com/onenat-workbuddy/?r=" + Date.now(), { timeout: 40000 });
await page.waitForLoadState();
const needLogin = await page.evaluate(() => Boolean(document.getElementById('username')));
if (needLogin) {
  await page.fill('#username', 'workbuddy');
  await page.fill('#password', 'ThunderSoft@88');
  await page.click('#btn', { label: '提交登录表单' });
  await page.waitForSelector('#view-work', { state: 'visible', timeout: 30000 });
}
await page.waitForFunction(() => typeof state !== 'undefined' && state.resources && state.resources.length > 0, undefined, { timeout: 20000 });
await page.evaluate(() => { switchView('work'); startDraft(); });
await page.waitForSelector('#draft-place-btn', { state: 'visible', timeout: 15000 });
await page.click('#draft-place-btn', { label: '打开执行位置下拉' });
await page.waitForSelector('#place-node-list', { state: 'visible', timeout: 10000 });

const head = await page.evaluate(() => document.querySelector('.place-pop .main-agent-pop-head').textContent.trim());
console.log('头部:', head);

// 等引擎探测回调的重绘结束（新代码已保留滚动位置，这里主动滚到底）
await page.waitForTimeout(1800);
await page.evaluate(() => { const pop = document.querySelector('.place-pop'); pop.scrollTop = pop.scrollHeight; });
await page.waitForTimeout(400);
const vis = await page.evaluate(() => {
  const pop = document.querySelector('.place-pop');
  const item = Array.from(pop.querySelectorAll('.main-agent-item')).find(x => x.textContent.indexOf('pjy') >= 0);
  if (!item) return { found: false };
  const ir = item.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  return { found: true, title: item.querySelector('.ag-title').textContent.trim(), 在弹层可视区内: ir.top >= pr.top - 2 && ir.bottom <= pr.bottom + 2 };
});
console.log('滚到底后:', JSON.stringify(vis));
await page.screenshot({ path: '/Users/tsbj/feyanggit/DHS-test/onenat-workbuddy-web/qa-import-pjy-20261106/place-scroll-bottom-pjy.png' });

// 搜索直达
await page.fill('#place-search-input', 'pjy');
await page.waitForTimeout(300);
const filtered = await page.evaluate(() => Array.from(document.querySelectorAll('#place-node-list .main-agent-item .ag-title')).map(x => x.textContent.trim()));
console.log('搜索 pjy 结果:', JSON.stringify(filtered));
await page.screenshot({ path: '/Users/tsbj/feyanggit/DHS-test/onenat-workbuddy-web/qa-import-pjy-20261106/place-search-pjy.png' });
console.log('screenshots saved');
