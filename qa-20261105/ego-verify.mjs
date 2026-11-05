const task = await taskSpace("wb-mention-at-menu");
const page = task.page("p1");
await page.goto("http://127.0.0.1:3099/onenat-workbuddy/?r=" + Date.now(), { timeout: 30000 });
await page.waitForLoadState();
await page.waitForTimeout(1500);
const onLogin = await page.evaluate(() => !!document.querySelector('input[placeholder="用户名"]'));
if (onLogin) {
  await page.fill('input[placeholder="用户名"]', "workbuddy");
  await page.fill('input[placeholder="密码"]', "ThunderSoft@88");
  await page.click("text=登 录");
  await page.waitForTimeout(4000);
}
await page.click("#input");
await page.evaluate(() => { const el = document.getElementById("input"); el.value = ""; el.focus(); });
await page.press("#input", "@");
await page.waitForTimeout(3500);
const info = await page.evaluate(() => {
  const filters = document.getElementById("mention-filters");
  const list = document.getElementById("mention-list");
  const head = document.getElementById("mention-head-label");
  const chips = [...(filters ? filters.querySelectorAll(".mention-chip") : [])].map(e => e.textContent.trim());
  const groups = [...(list ? list.querySelectorAll(".mention-group") : [])].map(e => e.textContent.trim());
  const items = [...(list ? list.querySelectorAll(".mention-item") : [])].map(e => e.querySelector(".name")?.textContent.trim()).filter(Boolean);
  return { head: head && head.textContent, chips, groups, total: items.length, hasAlita: items.includes("Alita"), alitaIdx: items.indexOf("Alita"), alitaResIdx: items.indexOf("alita-DSH") };
});
console.log(JSON.stringify(info, null, 1));
