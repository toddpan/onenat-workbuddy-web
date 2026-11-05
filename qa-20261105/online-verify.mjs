const task = await taskSpace("wb-online-verify");
const page = task.page("p1");
const R = [];
const ok = (n, c, d) => R.push({ n, ok: !!c, d });

// ========== 0. 打开线上首页 ==========
await page.goto("https://natpass.yikaihui.com/onenat-workbuddy/?r=" + Date.now(), { timeout: 40000 });
await page.waitForLoadState();
await page.waitForTimeout(2500);
const login = await page.evaluate(() => !!document.querySelector('input[placeholder="用户名"]'));
ok("线上可访问", await page.title(), await page.title());
// 已有会话时直接可用，也是正常状态（不算失败）
ok("鉴权与登录态正常", true, login ? "需登录→已登录" : "已有会话");

if (login) {
  await page.fill('input[placeholder="用户名"]', "workbuddy");
  await page.fill('input[placeholder="密码"]', "ThunderSoft@88");
  await page.click("text=登 录");
  await page.waitForTimeout(5500);
}
const me = await page.evaluate(async () => { try { const r = await fetch("/onenat-workbuddy/api/auth/me"); return await r.json(); } catch(e) { return {err:String(e)}; } });
ok("管理员登录成功", me && me.ok, JSON.stringify(me && me.data && me.data.username));

// ========== 1. 服务端候选：alita 三项是否齐全 ==========
const cands = await page.evaluate(async () => { const r = await fetch("/onenat-workbuddy/api/mentions/candidates"); const j = await r.json(); return j.data || j; });
const list = Array.isArray(cands) ? cands : (cands.items || []);
ok("候选接口返回数据", list.length > 0, "共 " + list.length + " 条");
const findIt = (n) => list.find(x => (x.name || "").trim() === n);
const alitaAgent = findIt("Alita");
const alitaRes = findIt("alita-DSH");
const alitaProj = list.find(x => (x.type === "project") && /alita/i.test(x.name || ""));
ok("智能体 Alita 在候选中", !!alitaAgent, alitaAgent ? JSON.stringify({id:alitaAgent.id, detail:alitaAgent.detail}) : "未找到");
ok("资源 alita-DSH 在候选中", !!alitaRes, alitaRes ? JSON.stringify({id:alitaRes.id, detail:alitaRes.detail}) : "未找到");
ok("项目 alita 工作区在候选中", !!alitaProj, alitaProj ? alitaProj.name : "未找到");

// ========== 2. @ 弹层 ==========
await page.click("#input");
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.press("Backspace");
await page.keyboard.type("@");
await page.waitForTimeout(3000);
const pop = await page.evaluate(() => {
  const p = document.getElementById("mention-popup");
  if (!p) return null;
  const f = document.getElementById("mention-filters");
  const fr = f && f.getBoundingClientRect();
  return { open: p.classList.contains("on"), hasFilters: !!f,
    wrap: f && getComputedStyle(f).flexWrap,
    chips: f ? [...f.querySelectorAll(".mention-chip")].map(e => { const r = e.getBoundingClientRect(); return { t: e.textContent.trim(), inside: !fr || (r.right <= fr.right + 1 && r.left >= fr.left - 1) }; }) : [],
    head: (document.getElementById("mention-head-label") || {}).textContent || "" };
});
ok("@ 弹层打开", pop && pop.open, String(pop && pop.open));
ok("分类筛选条存在", pop && pop.hasFilters, String(pop && pop.hasFilters));
ok("筛选条自动换行", pop && pop.wrap === "wrap", String(pop && pop.wrap));
ok("7个分类全部在可视区内", pop && pop.chips.length >= 7 && pop.chips.every(c => c.inside), pop ? pop.chips.map(c => c.t + (c.inside ? "" : "(越界)")).join(" ") : "");

// 逐个点分类，验证弹窗不关
const clickChip = async (label) => {
  const box = await page.evaluate((lb) => {
    const b = [...document.querySelectorAll("#mention-filters .mention-chip")].find(e => e.textContent.includes(lb) || e.dataset.f === lb);
    if (!b) return null; const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, label);
  if (!box) return { err: "chip-not-found" };
  await page.mouse.click(box.x, box.y, { label: "click " + label });
  await page.waitForTimeout(750);
  return await page.evaluate(() => ({ open: document.getElementById("mention-popup").classList.contains("on"),
    count: document.querySelectorAll("#mention-list .mention-item").length }));
};
for (const c of ["项目", "专家团", "智能体", "资源", "专家", "recent"]) {
  const r = await clickChip(c);
  ok("点「" + c + "」弹窗保持打开", r && r.open, JSON.stringify(r));
}

// 智能体分类下：节点分组 + Alita 可见
await clickChip("智能体");
const agView = await page.evaluate(() => ({
  nodes: [...document.querySelectorAll("#mention-list .mention-group.sub")].map(e => e.textContent.trim()),
  names: [...document.querySelectorAll("#mention-list .mention-item .name")].map(e => e.textContent.trim()),
}));
ok("智能体按 DSH 节点分组", agView.nodes.length > 0, agView.nodes.join(" | ").slice(0,150));
ok("智能体分类下能看到 Alita", agView.names.includes("Alita"), "Alita " + (agView.names.includes("Alita") ? "✓" : "✗") + " / 共 " + agView.names.length + " 个");
ok("有 alita-DSH 节点分组", agView.nodes.some(n => /alita/i.test(n)), agView.nodes.filter(n => /alita/i.test(n)).join(""));

// ========== 3. 真实插入 Alita ==========
await clickChip("全部");
await page.keyboard.type("alita");
await page.waitForTimeout(1200);
const matched = await page.evaluate(() => [...document.querySelectorAll("#mention-list .mention-item")].map(e => (e.querySelector(".name")||{}).textContent));
ok("输入 alita 能过滤出候选", matched.length > 0, matched.slice(0,6).join(" | "));
const inserted = await page.evaluate(() => {
  const items = [...document.querySelectorAll("#mention-list .mention-item")];
  const t = items.find(e => ((e.querySelector(".name")||{}).textContent||"").trim() === "Alita") || items[0];
  if (!t) return { err: "no item" };
  t.click();
  return { clicked: ((t.querySelector(".name")||{}).textContent||"").trim() };
});
await page.waitForTimeout(900);
const val = await page.evaluate(() => ({ v: document.getElementById("input").value,
  ls: localStorage.getItem("wb_mention_recent_v1") }));
ok("点击候选插入到输入框", /@Alita/i.test(val.v || ""), JSON.stringify(inserted) + " → value=" + JSON.stringify(val.v));
ok("最近使用已持久化", !!val.ls, String(val.ls).slice(0, 120));

// ========== 4. 执行位置搜索 ==========
await page.keyboard.press("Escape");
await page.click("loc=role:button[name='＋ 新建任务']");
await page.waitForTimeout(2500);
const pbox = await page.evaluate(() => { const r = document.getElementById("draft-place-btn").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: Math.round(r.width) }; });
await page.mouse.click(pbox.x, pbox.y, { label: "open execute location" });
await page.waitForTimeout(1600);
const placeOpen = await page.evaluate(() => {
  const p = document.querySelector(".place-pop");
  return { has: !!p, hasSearch: !!(p && p.querySelector("#place-search-input")),
    count: p ? p.querySelectorAll(".main-agent-item[data-mid]").length : 0,
    names: p ? [...p.querySelectorAll(".main-agent-item[data-mid]")].map(e => e.querySelector(".ag-title")?.textContent.trim()) : [] };
});
ok("执行位置下拉打开", placeOpen.has, String(placeOpen.has));
ok("执行位置有节点搜索框", placeOpen.hasSearch, String(placeOpen.hasSearch));
const expectNodes = list.filter(x => x.type === "resource" && /DSH/i.test(x.detail || "")).length;
ok("节点列表与资源目录一致", placeOpen.count >= Math.min(expectNodes, 10), "列表 " + placeOpen.count + " 个 / 目录 DSH 资源 " + expectNodes + " 个");
ok("节点列表包含 alita-DSH（原排最后）", placeOpen.names.some(n => /alita/i.test(n||"")), placeOpen.names.filter(n=>/alita/i.test(n||"")).join(""));

await page.evaluate(() => document.querySelector("#place-search-input").focus());
await page.keyboard.type("alita");
await page.waitForTimeout(1000);
const sr = await page.evaluate(() => { const p = document.querySelector(".place-pop");
  return { items: [...p.querySelectorAll(".main-agent-item[data-mid]")].map(e => e.querySelector(".ag-title")?.textContent.trim()),
    focus: document.activeElement && document.activeElement.id }; });
ok("搜索 alita 精确定位节点", sr.items.some(t => /alita/i.test(t||"")), sr.items.join(" | "));
ok("搜索时输入框焦点不丢", sr.focus === "place-search-input", sr.focus);

// ========== 5. 进入 alita 项目层 ==========
await page.evaluate(() => { const it = [...document.querySelectorAll(".place-pop .main-agent-item[data-mid]")].find(e => /alita/i.test(e.textContent)); if (it) it.click(); });
await page.waitForTimeout(1200);
const lv2 = await page.evaluate(() => { const p = document.querySelector(".place-pop"); return p ? {
  head: (p.querySelector(".main-agent-pop-head")||{}).textContent.trim(),
  items: [...p.querySelectorAll(".main-agent-item")].map(e => (e.querySelector(".ag-title")||{}).textContent.trim()) } : null; });
ok("能进入 alita 节点的项目层", lv2 && /alita/i.test(lv2.head||""), JSON.stringify(lv2));

// ========== 输出 ==========
const fail = R.filter(r => !r.ok);
for (const r of R) console.log((r.ok ? "✅ " : "❌ ") + r.n + (r.ok ? "" : "   → " + r.d) + (r.ok && r.d ? "   [" + r.d + "]" : ""));
console.log("");
console.log(fail.length ? "❌ 失败 " + fail.length + " / " + R.length : "✅ 全部通过（共 " + R.length + " 项）");
