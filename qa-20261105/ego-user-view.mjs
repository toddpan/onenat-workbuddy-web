const task = await taskSpace("wb-mention-at-menu");
const page = task.page("p1");
await page.goto("http://127.0.0.1:3099/onenat-workbuddy/?r=" + Date.now(), { timeout: 30000 });
await page.waitForLoadState();
await page.waitForTimeout(1500);
// 先退出当前会话
await page.evaluate(async () => { try { await fetch("/onenat-workbuddy/api/auth/logout", {method:"POST"}); } catch(e){} });
await page.goto("http://127.0.0.1:3099/onenat-workbuddy/?r=" + Date.now(), { timeout: 30000 });
await page.waitForLoadState();
await page.waitForTimeout(1500);
const onLogin = await page.evaluate(() => !!document.querySelector('input[placeholder="用户名"]'));
console.log("登录页:", onLogin);
await page.fill('input[placeholder="用户名"]', "Alita99Yoko");
await page.fill('input[placeholder="密码"]', "Test@12345");
await page.click("text=登 录");
await page.waitForTimeout(4000);
const who = await page.evaluate(async () => { const r = await fetch("/onenat-workbuddy/api/auth/me"); return await r.json(); });
console.log("当前用户:", JSON.stringify(who));
await page.click("#input");
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.press("Backspace");
await page.keyboard.type("@");
await page.waitForTimeout(3000);
const info = await page.evaluate(() => ({
  chips: [...document.querySelectorAll("#mention-filters .mention-chip")].map(e=>e.textContent.trim()),
  groups: [...document.querySelectorAll("#mention-list .mention-group")].map(e=>e.textContent.trim()),
  hasAlitaAgent: [...document.querySelectorAll("#mention-list .mention-item .name")].some(e=>e.textContent.trim()==="Alita"),
  hasAlitaRes: [...document.querySelectorAll("#mention-list .mention-item .name")].some(e=>e.textContent.trim()==="alita-DSH"),
}));
console.log("普通用户 @ 菜单:", JSON.stringify(info, null, 1));
