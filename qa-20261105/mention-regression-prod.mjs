/**
 * @ 菜单 / 执行位置 在线回归（真实浏览器 · ego-browser）
 *
 * 用法：
 *   BASE=http://127.0.0.1:3099 USER=workbuddy PASS=... ego-browser nodejs qa-20261105/mention-regression.mjs
 *
 * 覆盖 2026-11-05 线上报障的两个缺陷：
 *   ① 点分类筛选条（项目/专家团/…）后弹窗被关掉，无法继续选
 *      —— 根因：chip click 冒泡到 document 的「点空白关闭」监听，且 re-render 后 e.target 已脱离 DOM
 *      —— 同时：筛选条横向滚动把后 3 个分类藏在可视区外，点空处也会关窗
 *   ② 执行位置下拉看不到新节点（alita）—— 节点沉在滚动区底部，无搜索
 */
const task = await taskSpace("wb-mention-regression");
const page = task.page("p1");
// ego-browser 不支持向脚本传 env：直接改这里的三行即可指向别的环境
const BASE = "https://natpass.yikaihui.com";
const USER = "workbuddy";
const PASS = "ThunderSoft@88";
const results = [];
const ok = (name, cond, detail) => { results.push({ name, ok: !!cond, detail }); };

await page.goto(BASE + "/onenat-workbuddy/?r=" + Date.now(), { timeout: 30000 });
await page.waitForLoadState();
await page.waitForTimeout(1800);
if (await page.evaluate(() => !!document.querySelector('input[placeholder="用户名"]'))) {
  await page.fill('input[placeholder="用户名"]', USER);
  await page.fill('input[placeholder="密码"]', PASS);
  await page.click("text=登 录");
  await page.waitForTimeout(4500);
}

// ---------- ① @ 弹层分类筛选条 ----------
await page.click("#input");
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.press("Backspace");
await page.keyboard.type("@");
await page.waitForTimeout(3000);

const geo = await page.evaluate(() => {
  const f = document.getElementById("mention-filters");
  if (!f) return null;
  const fr = f.getBoundingClientRect();
  return { wrap: getComputedStyle(f).flexWrap,
    chips: [...f.querySelectorAll(".mention-chip")].map(e => { const r = e.getBoundingClientRect(); return { t: e.textContent.trim(), inside: r.right <= fr.right + 1 && r.left >= fr.left - 1 }; }) };
});
ok("筛选条存在且自动换行", geo && geo.wrap === "wrap", geo && geo.wrap);
ok("全部分类按钮都在可视区内（不再横向滚动藏匿）", geo && geo.chips.every(c => c.inside),
  geo && geo.chips.filter(c => !c.inside).map(c => c.t).join(","));

const clickChip = async (label) => {
  const box = await page.evaluate((lb) => {
    const b = [...document.querySelectorAll("#mention-filters .mention-chip")].find(e => e.textContent.includes(lb));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, label);
  if (!box) return { err: "chip-not-found" };
  await page.mouse.click(box.x, box.y, { label: "click " + label });
  await page.waitForTimeout(700);
  return await page.evaluate(() => ({
    open: document.getElementById("mention-popup").classList.contains("on"),
    count: document.querySelectorAll("#mention-list .mention-item").length,
  }));
};

for (const c of ["项目", "专家团", "智能体", "资源", "专家"]) {
  const r = await clickChip(c);
  ok("点「" + c + "」弹窗保持打开且有条目", r && r.open && r.count > 0, JSON.stringify(r));
}
const all = await clickChip("全部");
ok("回到「全部」恢复全量", all && all.open && all.count > 0, JSON.stringify(all));

// 智能体必须按 DSH 节点分组，且能滚动到新节点
const nodeGroups = await page.evaluate(() => [...document.querySelectorAll("#mention-list .mention-group.sub")].map(e => e.textContent.trim()));
ok("智能体按 DSH 节点分组", nodeGroups.length > 0, nodeGroups.join(" | ").slice(0, 160));

await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// ---------- ② 执行位置节点搜索 ----------
await page.click("loc=role:button[name='＋ 新建任务']");
await page.waitForTimeout(2500);
const pbox = await page.evaluate(() => { const r = document.getElementById("draft-place-btn").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
await page.mouse.click(pbox.x, pbox.y, { label: "open execute location" });
await page.waitForTimeout(1500);
ok("执行位置下拉有节点搜索框", await page.evaluate(() => !!document.querySelector("#place-search-input")));

await page.evaluate(() => document.querySelector("#place-search-input").focus());
await page.keyboard.type("alita");
await page.waitForTimeout(900);
const searched = await page.evaluate(() => {
  const p = document.querySelector(".place-pop");
  return { items: [...p.querySelectorAll(".main-agent-item[data-mid]")].map(e => e.querySelector(".ag-title")?.textContent.trim()),
    focus: document.activeElement && document.activeElement.id };
});
ok("搜索 alita 能定位到节点", searched.items.some(t => /alita/i.test(t || "")), searched.items.join(" | "));
ok("搜索过程中输入框焦点不丢", searched.focus === "place-search-input", searched.focus);

const failed = results.filter(r => !r.ok);
for (const r of results) console.log((r.ok ? "✅ " : "❌ ") + r.name + (r.ok ? "" : "  — " + r.detail));
console.log("");
console.log(failed.length ? "❌ 失败 " + failed.length + " / " + results.length : "✅ 全部通过（共 " + results.length + " 项）");
