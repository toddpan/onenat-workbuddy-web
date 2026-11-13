const task = await taskSpace("verify-pjy-import-fix-20261106");
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

await page.evaluate(() => { location.hash = '#projects'; });
await page.waitForSelector('#btn-proj-import', { state: 'visible', timeout: 15000 });
await page.click('#btn-proj-import', { label: '打开从远程 DSH 导入弹窗' });
await page.waitForSelector('#pimp-node', { state: 'visible', timeout: 10000 });

await page.evaluate(() => {
  const sel = document.getElementById('pimp-node');
  const opt = Array.from(sel.options).find(o => o.textContent.includes('pjy'));
  sel.value = opt.value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
});
const chosen = await page.evaluate(() => document.getElementById('pimp-node').selectedOptions[0].textContent.trim());
console.log('selected node:', chosen);

await page.click('#pimp-fetch', { label: '点击获取工作区列表' });
await page.waitForFunction(() => {
  const l = document.getElementById('pimp-list');
  return l && (l.querySelector('.lib-check') || l.querySelector('.lib-empty'));
}, undefined, { timeout: 30000 });

const result = await page.evaluate(() => {
  const l = document.getElementById('pimp-list');
  const msg = document.getElementById('pimp-msg');
  return {
    msg: msg ? msg.textContent : '',
    isEmpty: Boolean(l.querySelector('.lib-empty')),
    textHasError: /ByteString|22235/.test(l.textContent || ''),
    workspaces: Array.from(l.querySelectorAll('.lib-check label')).map(x => x.textContent.trim().replace(/\s+/g, ' '))
  };
});
console.log('RESULT:', JSON.stringify(result, null, 2));
await page.screenshot({ path: '/Users/tsbj/feyanggit/DHS-test/onenat-workbuddy-web/qa-import-pjy-20261106/after-fix-modal.png' });
console.log('screenshot saved');
