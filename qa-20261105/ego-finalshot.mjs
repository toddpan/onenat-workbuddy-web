const task = await taskSpace("wb-mention-at-menu");
const page = task.page("p1");
await page.goto("https://natpass.yikaihui.com/onenat-workbuddy/?r=" + Date.now(), { timeout: 40000 });
await page.waitForLoadState();
await page.waitForTimeout(2000);
if (await page.evaluate(() => !!document.querySelector('input[placeholder="用户名"]'))) {
  await page.fill('input[placeholder="用户名"]', "workbuddy");
  await page.fill('input[placeholder="密码"]', "ThunderSoft@88");
  await page.click("text=登 录");
  await page.waitForTimeout(5000);
}
await page.click("#input");
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.press("Backspace");
await page.keyboard.type("@");
await page.waitForTimeout(3500);
// 点智能体分类后截图（验证分类切换不关窗）
const box = await page.evaluate(() => {
  const b = [...document.querySelectorAll("#mention-filters .mention-chip")].find(e => e.textContent.includes("智能体"));
  const r = b.getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2};
});
await page.mouse.click(box.x, box.y, { label: "click agent filter" });
await page.waitForTimeout(900);
await page.screenshot({ path: "/Users/tsbj/feyanggit/DHS-test/onenat-workbuddy-web/qa-20261105/prod-chip-fixed.png" });
// 执行位置截图
await page.keyboard.press("Escape");
await page.click("loc=role:button[name='＋ 新建任务']");
await page.waitForTimeout(2500);
const pbox = await page.evaluate(() => { const r = document.getElementById("draft-place-btn").getBoundingClientRect(); return {x:r.x+r.width/2, y:r.y+r.height/2}; });
await page.mouse.click(pbox.x, pbox.y, { label: "open execute location" });
await page.waitForTimeout(1500);
await page.screenshot({ path: "/Users/tsbj/feyanggit/DHS-test/onenat-workbuddy-web/qa-20261105/prod-place-search.png" });
console.log("shots done");
