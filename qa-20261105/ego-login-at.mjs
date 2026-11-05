const task = await taskSpace("wb-mention-at-menu");
const page = task.page("p1");
await page.fill("@1", "workbuddy");
await page.fill("@2", "ThunderSoft@88");
await page.click("@3");
await page.waitForLoadState();
await page.waitForTimeout(4000);
console.log("URL:", await page.url());
// 打开任务输入框并输入 @
const hasInput = await page.evaluate(() => !!document.getElementById("input"));
console.log("has #input:", hasInput);
if (hasInput) {
  await page.click("#input");
  await page.evaluate(() => { const el = document.getElementById("input"); el.value = ""; el.focus(); });
  await page.press("#input", "@");
  await page.waitForTimeout(2500);
  const info = await page.evaluate(() => {
    const popup = document.getElementById("mention-popup");
    const filters = document.getElementById("mention-filters");
    const list = document.getElementById("mention-list");
    const head = document.getElementById("mention-head-label");
    const chips = [...(filters ? filters.querySelectorAll(".mention-chip") : [])].map(e => e.textContent.trim());
    const headers = [...(list ? list.querySelectorAll(".mention-group") : [])].map(e => e.textContent.trim());
    const items = [...(list ? list.querySelectorAll(".mention-item") : [])].map(e => e.querySelector(".name")?.textContent.trim()).filter(Boolean);
    return { open: popup && popup.classList.contains("on"), head: head && head.textContent, chips, headers, itemCount: items.length, items: items.slice(0,40) };
  });
  console.log(JSON.stringify(info, null, 1));
}
