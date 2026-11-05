const task = await taskSpace("wb-mention-at-menu");
const page = task.page("p1");
await page.goto("http://127.0.0.1:3099/onenat-workbuddy/?r=" + Date.now(), { timeout: 30000 });
await page.waitForLoadState();
await page.waitForTimeout(2500);
// 清空最近记录，从干净状态开始
await page.evaluate(() => localStorage.removeItem("wb_mention_recent_v1"));
await page.click("#input");
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.press("Backspace");
await page.keyboard.type("@");
await page.waitForTimeout(3000);
const r1 = await page.evaluate(() => {
  const el = document.getElementById("input");
  const it = [...document.querySelectorAll("#mention-list .mention-item")].find(e => e.querySelector(".name")?.textContent.trim() === "alita-DSH");
  it.click();
  return { value: el.value, recent: localStorage.getItem("wb_mention_recent_v1") };
});
console.log("① 插入 alita-DSH:", JSON.stringify(r1));
await page.waitForTimeout(400);
// 再次 @ 看「最近」分类
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.press("Backspace");
await page.keyboard.type("@");
await page.waitForTimeout(2500);
const r2 = await page.evaluate(() => ({
  chips: [...document.querySelectorAll("#mention-filters .mention-chip")].map(e=>e.textContent.trim()),
  groups: [...document.querySelectorAll("#mention-list .mention-group")].map(e=>e.textContent.trim()),
  firstItems: [...document.querySelectorAll("#mention-list .mention-item .name")].slice(0,4).map(e=>e.textContent.trim()),
}));
console.log("② 再次 @:", JSON.stringify(r2, null, 1));
// 点「最近」chip
await page.evaluate(() => {
  const b = [...document.querySelectorAll("#mention-filters .mention-chip")].find(e => e.textContent.includes("最近"));
  if (b) b.click();
});
await page.waitForTimeout(600);
const r3 = await page.evaluate(() => ({
  groups: [...document.querySelectorAll("#mention-list .mention-group")].map(e=>e.textContent.trim()),
  items: [...document.querySelectorAll("#mention-list .mention-item .name")].map(e=>e.textContent.trim()),
}));
console.log("③ 最近分类内容:", JSON.stringify(r3));
