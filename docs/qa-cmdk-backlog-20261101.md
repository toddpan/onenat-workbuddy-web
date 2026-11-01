# TASK-1「backlog 条目接入 ⌘K 全局检索」— 浏览器端验收报告

- 验收日期：2026-11-01（CST）
- 验收角色：独立复验（在既有实现 `a22b68d` 之上重跑真实浏览器验收，非实现者）
- 仓库：`/Users/tsbj/feyanggit/DHS-test/onenat-workbuddy-web`
- 分支 / HEAD：`feat/exec-place-ux` / `44fce2c`（被测实现 = `a22b68d feat(cmdk): 待办条目接入 ⌘K 全局检索`）
- 验收工具：ego-browser v2.2.0（真实 Chromium，非 jsdom / 非 Playwright）
- 结论：**TASK-1 四项验收 4/4 PASS；桌面 35 项 + 移动端 8 项 + 环境种子 29 项，共 72 项断言全绿，未发现产品缺陷**

## 0. 一句话结论

在真实构建产物（`dist/server.js` + `dist/web-ui.js`）上，用真实 Chromium 打开控制台：
⌘K 面板可在 overview 仍耗时 5s 的情况下 **16ms 内打开**、返回后自动补入「待办」组；
itemId / 标题 / 状态词均可跨项目命中；未初始化 / 节点不可达 / 归档 / 慢节点项目一律不进结果；
选中条目后进入**对应项目的看板**并打开该条目详情弹层；390x844 + 微信 X5 UA 下检索与跳转均可用、无横向溢出、无 JS 异常。

## 1. 被验收需求（TASK-1）

把 backlog 条目接入控制台已有的 ⌘K 命令面板（与命令、任务、专家同一入口），输入即时过滤 itemId / 标题 / 状态，选中后跳到对应项目的待办看板并打开该条目抽屉。

| AC | 要求 |
| --- | --- |
| #1 | cmdk 面板能跨项目搜到 backlog 条目（itemId / 标题 / 状态关键词均可命中） |
| #2 | 选中条目后跳转到对应项目的待办看板并打开该条目抽屉 |
| #3 | 未初始化 backlog 的项目不出现在结果中，且该节点不可达时不阻塞面板打开 |
| #4 | `npm run build` 与 `npm run smoke` 通过（新增断言或明确说明仅做手测） |

实现契约（断言依据，来自 `src/web-ui.ts` 的 `cmdkBacklog*` 段）：

- 命令组标题 `待办`，条目 `lb = itemId + 标题`、`kw = 状态 + 项目名 + labels + assignees`、`sub = 项目名 · 状态`；
- 仅收 `nodeStatus === 'ok' && initialized` 的项目；`cmdkOpen()` 同步触发 `cmdkBacklogPrefetch()` **不 await**，返回后若面板仍开着再 `cmdkRender()`；
- 选中 → `cmdkOpenBacklogItem(projectId, itemId)`：先聚合缓存即时渲染看板 + `switchView('backlog')`，再拉单项目权威列表刷新并 `blOpenDetail(itemId)`。

## 2. 环境与构建产物

| 项 | 值 |
| --- | --- |
| 被测构建 | `dist/web-ui.js` 869050 B，sha256 `d08f202c…e663`（`npm run build` 重跑产出） |
| 服务端 | `dist/server.js` 45165 B，sha256 `194dd4ef…3899` |
| Node | v26.7.0 |
| 浏览器 | ego-browser v2.2.0（Chromium 真实内核；桌面 1470x733〔ego 默认窗口，脚本未强设 1440x900〕，移动 390x844 dpr3 + 微信 X5 UA） |
| 服务端口 | 18120（`--onenat-base-url http://127.0.0.1:18125 --onenat-api-key onk-mock-key-000`） |
| stub DSH（快） | 18121（内存 FS + 即完成会话，语义对齐 `scripts/backlog-e2e.mjs`） |
| stub DSH（慢） | 18122（`/api/v1/fs/*` 延迟 2500ms，制造 overview ≈5s 的阻塞风险） |
| mock ONENAT | 18125（`scripts/mock-onenat.cjs`） |

造数（全部经 REST 真实写入，再由 `GET /api/backlog/overview` 复核语义）：

| 项目 | 形态 | backlog |
| --- | --- | --- |
| A `TASK1 验收项目A` | 可达、已初始化 | 3 条：task-1 To Do / task-2 In Progress / task-3 Done |
| C `TASK1 跨项目C` | 可达、已初始化（第二项目） | 2 条：task-1 To Do / task-2 In Progress |
| D `TASK1 未初始化项目` | 可达、`backlog/` 不存在 | 无（`initialized=false`） |
| B `TASK1 不可达项目` | 先 init+建条，再改 dshRef 为黑洞地址 | 残留 task-1，overview `nodeStatus=unreachable` |
| E `TASK1 归档项目` | 先 init+建条，再归档 | 残留 task-1，overview `nodeStatus=archived` |
| S `TASK1 慢节点项目` | 指向 18122（fs 延迟 2500ms）、未初始化 | 无（拖慢 overview 至约 5s） |

## 3. 启动与复现命令

```bash
cd /Users/tsbj/feyanggit/DHS-test/onenat-workbuddy-web
npm run build

# ① 只做 API 层种子自检（起 stub/mock/server → 登录 → 造数 → 断言 overview → 清理退出）
node qa-20261101/task1-cmdk-backlog/qa-env.mjs --check

# ② 起完整环境并保持运行（ready 后打印 QA_READY 并把 state 写到 /tmp/task1-cmdk-qa-state.json）
node qa-20261101/task1-cmdk-backlog/qa-env.mjs

# ③ 真实 Chromium 桌面验收（另开终端）
ego-browser nodejs < qa-20261101/task1-cmdk-backlog/browser-desktop.mjs

# ④ 真实 Chromium 移动端 390x844 + 微信 X5 UA 验收
ego-browser nodejs < qa-20261101/task1-cmdk-backlog/browser-mobile.mjs

# ⑤ 结束：Ctrl-C / SIGTERM 触发清理（kill stub/slow-stub/server/mock ONENAT + 删除临时数据目录与 state）
```

## 4. 验收矩阵（逐项 PASS/FAIL + 证据）

结果汇总：`qa-env --check` **29/29 PASS**；桌面轮 **35/35 PASS**；移动端轮 **8/8 PASS**（结果 JSON：`/tmp/task1-cmdk-desktop-result.json`、`/tmp/task1-cmdk-mobile-result.json`）。

### AC#1 — itemId / 标题 / 状态关键词均可命中，且跨项目（桌面 B1–B10）

| # | 场景 | 实测 |
| --- | --- | --- |
| B1 | 输入 `TASK-1`（大写、大小写不敏感）命中「待办」组 | 2 条，来自 A、C 两个项目 |
| B2 | 跨项目命中：同编号 `task-1` 分属 A / C | subs = `TASK1 跨项目C · To Do` / `TASK1 验收项目A · To Do` |
| B3 | 条目文本 = itemId + 标题 | `task-1 接入 cmdk 全局检索入口` 等 |
| B4 | 标题片段「全局检索」 | 命中 A 项目 task-1 |
| B5 | 标题片段「跨项目独有标题片段」 | 命中 C 项目 task-2 |
| B6/B7/B8 | 状态词 `To Do` / `In Progress` / `Done` | 分别命中 2 / 2 / 1 条 |
| B9 | 小写 `task-1` | 同样命中 2 条（大小写不敏感） |
| B10 | placeholder 提示 | 含「待办条目标题或状态」 |

证据：`task1-03-desktop-cmdk-itemid-crossproject.png`、`task1-04-desktop-cmdk-status-in-progress.png`。

### AC#2 — 选中后跳对应项目看板并打开抽屉（桌面 D1–D6 / 移动 M6）

| # | 场景 | 实测 |
| --- | --- | --- |
| D1 | 目标条目前置于待办组且默认选中（Enter 可达） | `sel=true` |
| D2 | Enter → `#backlog` + `#view-backlog.on` + 面板关闭 | hash=#backlog，workOn=false |
| D3 | 出现该项目看板 `.bl-board` | 标题 `📦 TASK1 验收项目A · 看板` |
| D4 | 看板三状态列 + To Do 列有 task-1 卡片 | cols=`To Do 1 / In Progress 1 / Done 1` |
| D5 | 随后打开条目详情弹层 `#modal-mask.on` | 标题 `待办 task-1 · 接入 cmdk 全局检索入口` |
| D6 | 关闭弹层后仍停留在该项目看板 | 链路完整 |
| M6 | 移动端选中条目 → **其所属项目**看板 + 详情弹层 | 选中 C 项目 `task-1 跨项目同名编号条目` → 看板 `📦 TASK1 跨项目C · 看板` + 弹层 `待办 task-1 · 跨项目同名编号条目` |

证据：`task1-05-desktop-backlog-board-and-detail.png`、`task1-08-mobile-backlog-board-modal.png`。

### AC#3 — 懒加载不阻塞面板；未初始化/不可达不得进结果（桌面 A1–A7 / C1–C5 / P0.2）

| # | 场景 | 实测 |
| --- | --- | --- |
| P0.2 | 首屏未提前拉 overview（冷缓存场景成立） | `ov=null, cmdkBl.cache=null, blState.data=null` |
| A1/A2 | Ctrl+K 立即呼出；同时已发起 `GET /api/backlog/overview` 且未 await | `maskOn=true`，请求 `inFlight=true` |
| A3 | **面板打开延迟 ≪ overview 耗时** | 按键→`.on` **16ms**，overview 仍在途 |
| A4 | overview 在途期间其它命令仍可用（输入「定时」命中视图） | groups=视图:1 |
| A5 | overview 未返回前输入 itemId 不出现「待办」组（懒加载） | hasBacklogGroup=false（166ms） |
| A6 | overview 返回后、面板保持打开时自动补「待办」组（未关闭重开） | groups=待办:2 |
| A7 | overview 实测确实慢（阻塞风险成立） | **5015ms** |
| C1/C2/C3 | 不可达 B / 归档 E 的残留条目不得出现；未初始化 D 无「待办」条目 | backlogGroup=false / backlogItems=0 |
| C4 | 8 组检索中「待办」组不含 B/E/D/S 任一项目条目 | `leaked=[]` |
| C5 | overview 语义正确 | A/C ok+initialized；D/S ok 未初始化；B unreachable；E archived（见 §5.1） |

证据：`task1-01-desktop-cmdk-overview-loading.png`、`task1-02-desktop-cmdk-lazy-backlog-group.png`。

### AC#4 — build / smoke 与移动端（桌面 E1–E4 / F1，移动 M1–M8）

| # | 场景 | 实测 |
| --- | --- | --- |
| E1 | header ⌘K 按钮呼出 | maskOn=true |
| E2 | 空查询不展开待办条目（保持轻量）但有「待办 · Backlog」视图命令 | backlogGroup=false，hasViewCmd=true |
| E3/E4 | Esc 关闭；Meta+K 呼出 | 均 PASS |
| F1 | 全程无 pageerror / unhandledrejection / console.error | `[]` |
| M1 | 390x844 + 微信 X5 UA 生效 | inner=390x844 dpr=3，`matchMedia('(max-width:768px)')` true |
| M2/M3 | 移动端呼出面板；输入 itemId 跨项目命中 | 2 条（A、C） |
| M4 | ≤768px 下 `.cmdk-item .sub` 隐藏 | `display:none` |
| M5/M7 | 无横向溢出、面板在视口内（检索态 / 看板+弹层态） | `docScrollWidth=390 ≤ innerWidth+1`；面板 16→374 |
| M8 | 移动端全程无 JS 异常 | `[]` |

构建/冒烟（Lead 门禁）：

- `npm run build`：tsc 通过 + 内联脚本 `node --check` 关卡 3 页全过（`page scripts extracted: 3`）。
- `npm run smoke`：**83 项全过**（含 TASK-1 的 2 项静态断言：接线齐备、新增代码段无 `?.` / `??`）。

证据：`task1-06-desktop-cmdk-empty-query.png`、`task1-07-mobile-cmdk-itemid.png`。

## 5. 补充验证与 QA 脚本修正（如实记录）

### 5.1 C5：unreachable 项目的 `initialized` 语义

`overviewOne()` 在 resolve 成功但读盘抛错时返回 `initialized: true, nodeStatus: 'unreachable'`
（语义 = 「已初始化状态未知，不误报成『尚未初始化 backlog』」；**排除依据是 `nodeStatus`，不是 `initialized`**）。
原 QA 脚本把它断言成 `initialized:false`，与产品既有语义不符（且该字段不参与 ⌘K 过滤，C1/C4 已单独验证排除）。
本轮把断言修正为 `initialized:true`，并在脚本内注明依据；未修改产品代码（该行为不属于 TASK-1 验收面，且改动会误导 backlog 总览页对离线项目的文案）。

### 5.2 M6：断言对象改为「实际选中条目」

原脚本假设 Enter 选中的是 A 项目条目，但查询 `TASK-1` 时默认选中（ord 排序后）C 项目的同名条目，
导致等待硬编码标题超时、最终却仍被宽松的 `task-1` 文案断言放过（假通过风险）。
本轮改为读取面板当前真实选中条目，断言「看板 = 该条目所属项目」「弹层标题 = 该 itemId + 标题」；
实测选中 C 项目 task-1 → C 项目看板 + C 条目弹层，链路正确。

### 5.3 微信 X5 覆盖度说明

ego-browser 是 Chromium，**无法真正切换到微信 X5 的旧内核**。本轮以「X5 UA + 390x844 + 旧内核语法静态闸门」组合覆盖：
`npm run smoke` 对新增段断言无 `?.` / `??`，构建脚本对内联脚本做 `node --check`；X5 UA 下实际跑通检索与跳转、无 JS 异常。
**X5 真机未验，属已知限制。**

## 6. 发现的异常 / 缺陷

- 产品缺陷：**未发现**。
- QA 脚本问题 2 处（见 §5.1、§5.2），已修正并重跑，均不影响产品结论。

## 7. 证据文件清单（`qa-20261101/task1-cmdk-backlog/`）

| 文件 | 内容 |
| --- | --- |
| `qa-env.mjs` | stub DSH（快/慢）+ mock ONENAT + server 编排与 6 项目造数 |
| `browser-desktop.mjs` | 桌面 1470x733 的 35 项断言（A/B/C/D/E/F 组） |
| `browser-mobile.mjs` | 移动 390x844 + X5 UA 的 8 项断言（M 组） |
| `task1-01-desktop-cmdk-overview-loading.png` | overview 在途时面板已可用的现场 |
| `task1-02-desktop-cmdk-lazy-backlog-group.png` | overview 返回后「待办」组自动补入 |
| `task1-03-desktop-cmdk-itemid-crossproject.png` | 输入 itemId 跨项目命中 |
| `task1-04-desktop-cmdk-status-in-progress.png` | 状态词 `In Progress` 命中 |
| `task1-05-desktop-backlog-board-and-detail.png` | 跳看板 + 条目详情弹层 |
| `task1-06-desktop-cmdk-empty-query.png` | 空查询面板（不展开条目） |
| `task1-07-mobile-cmdk-itemid.png` | 移动端 itemId 命中（sub 列隐藏） |
| `task1-08-mobile-backlog-board-modal.png` | 移动端跳看板 + 详情弹层 |

## 8. 环境清理确认

```
pgrep 残留：无（stub / slow-stub / server / mock ONENAT 均已 kill）
18120/18121/18122/18125 LISTEN：无
临时数据目录 workbuddy-task1-qa-*：已删除
/tmp/task1-cmdk-qa-state.json、/tmp/task1-cmdk-*-result.json：保留（本轮结果 JSON，便于复核）
```
