const task = await taskSpace("wb-mention-at-menu");
const page = task.page("p1");
await page.goto("http://127.0.0.1:3099/onenat-workbuddy/?r=" + Date.now(), { timeout: 30000 });
await page.waitForLoadState();
await page.waitForTimeout(3000);
const prodJson = await (await import("node:fs/promises")).readFile("/Users/tsbj/feyanggit/DHS-test/onenat-workbuddy-web/qa-20261105/prod-cands.json", "utf8");
const cands = JSON.parse(prodJson);
console.log("注入线上候选:", cands.length);
await page.evaluate((list) => { window.__PROD_CANDS = list; }, cands);

// 用页面内真实逻辑：直接打开 @ 然后覆写 mentionCandidates 再触发一次 input 渲染
await page.click("#input");
await page.evaluate(() => { const el = document.getElementById("input"); el.value = ""; el.focus(); });
await page.press("#input", "@");
await page.waitForTimeout(2500);

// 尝试通过页面的模块变量不可达，改为拦截 fetch 让 refreshMentionCandidates 拿到线上数据
await page.evaluate(() => {
  const orig = window.fetch;
  window.fetch = async (u, o) => {
    const r = await orig(u, o);
    if (String(u).includes("/mentions/candidates") && window.__PROD_CANDS) {
      const j = await r.clone().json();
      return new Response(JSON.stringify({ ok: true, data: window.__PROD_CANDS }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return r;
  };
});
// 重新输入 @ 触发刷新（超过 60s 过期或首次）
await page.fill("#input", "");
await page.press("#input", "q");
await page.press("#input", "Backspace");
await page.press("#input", "@");
await page.waitForTimeout(3000);

const info = await page.evaluate(() => {
  const filters = document.getElementById("mention-filters");
  const list = document.getElementById("mention-list");
  const head = document.getElementById("mention-head-label");
  const chips = [...(filters ? filters.querySelectorAll(".mention-chip") : [])].map(e => e.textContent.trim());
  const headers = [...(list ? list.querySelectorAll(".mention-group") : [])].map(e => e.textContent.trim());
  const items = [...(list ? list.querySelectorAll(".mention-item") : [])].map(e => e.querySelector(".name")?.textContent.trim()).filter(Boolean);
  return { head: head && head.textContent, chips, headers, itemCount: items.length, hasAlita: items.includes("Alita"), alitaIdx: items.indexOf("Alita"), first: items.slice(0,12) };
});
console.log(JSON.stringify(info, null, 1));
