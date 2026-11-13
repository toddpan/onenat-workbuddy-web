const task = await taskSpace("wb-mention-prod-verify");
const page = task.page("p1");
// 直接用线上环境，但普通用户密码未知，改为验证已修复的服务端权限口径 + 线上页面资源可达
await page.goto("https://natpass.yikaihui.com/onenat-workbuddy/?r=" + Date.now(), { timeout: 40000 });
await page.waitForLoadState();
await page.waitForTimeout(2000);
const title = await page.title();
console.log("页面:", title, "| URL:", await page.url());
// 未登录应跳登录页
const onLogin = await page.evaluate(() => !!document.querySelector('input[placeholder="用户名"]'));
console.log("登录页:", onLogin);
// 用管理员登录后检查线上真实 @ 菜单渲染（含新筛选条）
await page.fill('input[placeholder="用户名"]', "workbuddy");
await page.fill('input[placeholder="密码"]', "ThunderSoft@88");
await page.click("text=登 录");
await page.waitForTimeout(5000);
await page.click("#input");
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.press("Backspace");
await page.keyboard.type("@");
await page.waitForTimeout(4000);
const info = await page.evaluate(() => ({
  chips: [...document.querySelectorAll("#mention-filters .mention-chip")].map(e=>e.textContent.trim()),
  groups: [...document.querySelectorAll("#mention-list .mention-group")].map(e=>e.textContent.trim()),
  alitaItems: [...document.querySelectorAll("#mention-list .mention-item")].filter(e=>/Alita|alita/.test(e.textContent)).map(e=>e.querySelector(".name")?.textContent.trim()),
}));
console.log("线上 @ 菜单:", JSON.stringify(info, null, 1));
const p = await page.screenshot({ path: "/Users/tsbj/feyanggit/DHS-test/onenat-workbuddy-web/qa-20261105/prod-verify.png" });
console.log("shot:", p);
