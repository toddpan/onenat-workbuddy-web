const task = await taskSpace("verify-place-pjy-20261106");
const page = await task.newPage();
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
await page.waitForSelector('#place-search-input', { state: 'visible', timeout: 10000 });
await page.evaluate(() => {
  const si = document.getElementById('place-search-input');
  si.value = 'pjy';
  si.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(400);
const filtered = await page.evaluate(() => Array.from(document.querySelectorAll('#place-node-list .main-agent-item .ag-title')).map(x => x.textContent.trim()));
console.log('搜索 pjy 结果:', JSON.stringify(filtered));
await page.screenshot({ path: '/Users/tsbj/feyanggit/DHS-test/onenat-workbuddy-web/qa-import-pjy-20261106/place-search-pjy.png' });
console.log('search screenshot saved');
