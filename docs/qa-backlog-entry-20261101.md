# TASK-8「进入工作台」入口 — 浏览器端独立验收报告

- 验收日期：2026-11-01（CST）
- 验收角色：独立 QA 验证员（qa-verifier），非实现者
- 仓库：`/Users/tsbj/feyanggit/DHS-test/onenat-workbuddy-web`
- 分支 / HEAD：`feat/exec-place-ux` / `1bf6290`
- 验收工具：ego-browser v2.2.0（真实 Chromium，非 jsdom / 非 Playwright）
- 结论：**TASK-8 四项验收 4/4 PASS，补充验证项全部 PASS，未发现产品缺陷**

## 0. 一句话结论

在真实构建产物（dist/server.js + dist/web-ui.js）上，用真实 Chromium 打开控制台，
`#backlog` 待办聚合页每个项目分组标题行右侧均出现「进入工作台」按钮（在「看板」左侧），
点击进入该项目工作台草稿（`#work` + `📦 <项目名> · 🖥 <节点> ▾` + 「新任务（草稿）」），
浏览器返回可回到 `#backlog`；节点离线项目的入口按钮仍可用且由工作台承接节点错误态；
390x844 移动端视口下热区 44px、无横向溢出、点击生效。**全部通过，未发现缺陷。**

## 1. 被验收需求（TASK-8）

控制台「✅ 待办」聚合总览页（`#backlog`）每个项目分组标题行，在右侧操作区、
现有「看板」按钮**左侧**新增「进入工作台」按钮：

| AC | 要求 |
| --- | --- |
| #1 | 每个项目分组标题行都出现「进入工作台」按钮，与「看板」并列，顺序为「进入工作台 · 看板」 |
| #2 | 点击直达该项目工作台（`#work` 页签 + 该项目的新任务草稿），浏览器返回键/返回操作能回到 `#backlog` |
| #3 | 节点离线（`nodeStatus` 非 ok）时按钮仍可用（按钮层不 disabled/不拦截），进入后由工作台自行呈现节点错误态；项目数据加载失败给明确错误提示 |
| #4 | ≤768px（390x844 代表）与微信 X5 旧内核下布局正常：按钮不溢出、热区 ≥44px、可点击 |

实现契约（断言依据，来自 Lead 的 DOM 契约）：

- 按钮：`#bl-root .bl-group-h .bl-enter-btn[data-enter="<projectId>"]`，文案「进入工作台」；
  每个分组恰好 1 个；DOM 顺序在 `.bl-board-btn`（看板）之前；
- 点击后：`location.hash === '#work'`、`#view-work.on`、`#draft-place-btn` 含项目名与「📦」、
  `#chat-title` 含「新任务（草稿）」；
- 返回后：`location.hash === '#backlog'`、`#view-backlog.on`、`#bl-root .bl-group` 数量恢复；
- 离线分组：`.bl-enter-btn` 无 `disabled` 属性，点击进入工作台；
- 移动端 390x844：所有 `.bl-enter-btn` `getBoundingClientRect().height >= 44`、
  `document.documentElement.scrollWidth <= innerWidth + 1`、按钮可点击生效。

## 2. 环境与构建产物

| 项 | 值 |
| --- | --- |
| 被测构建 | `dist/web-ui.js`（858565 B，2026-11-01 10:51，sha256 `93234d1c…05c93f`） |
| 服务端 | `dist/server.js`（45165 B，2026-11-01 10:51，sha256 `194dd4ef…194e73899`） |
| Node | v26.7.0 |
| 浏览器 | ego-browser v2.2.0（Chromium，真实内核） |
| 服务端端口 | 18120（`--onenat-base-url http://127.0.0.1:18125 --onenat-api-key onk-mock-key-000`） |
| stub DSH 节点 | 18121（内存 FS + 即完成会话，语义对齐 `scripts/backlog-e2e.mjs`） |
| mock ONENAT | 18125（`scripts/mock-onenat.cjs`，`MOCK_ONENAT_PORT=18125`、`MOCK_ONENAT_KEY=onk-mock-key-000`） |
| 临时数据目录 | 系统临时目录下的 `workbuddy-task8-qa-*`（验收结束后已删除） |
| 登录账号 | 默认管理员 `workbuddy / workbuddy-admin` |

造数（`scripts/qa-backlog-entry.mjs` 一键完成）：

- **项目 A**「TASK8 验收项目A」：`dshRef = {kind:'direct', apiBaseUrl:'http://127.0.0.1:18121/api/v1'}`，
  `workspace=/tmp/task8-ws` → `POST /api/projects/:id/backlog/init` → 新建 3 条待办并置状态
  `To Do` / `In Progress` / `Done`（overview 中 `nodeStatus=ok`）；
- **项目 B**「TASK8 不可达项目」：`dshRef` 指向 `http://127.0.0.1:1/api/v1`，
  `workspace=/tmp/task8-ws-b` → overview 中 `nodeStatus=unreachable`（离线分组场景）。

## 3. 启动与复现命令

```bash
cd /Users/tsbj/feyanggit/DHS-test/onenat-workbuddy-web

# ① 只做 API 层种子自检（起 stub/mock/server → 登录 → 造数 → 断言 overview → 清理退出）
node scripts/qa-backlog-entry.mjs --check

# ② 起完整环境并保持运行（ready 后打印 QA_READY 并把 state 写到 /tmp/task8-qa-state.json）
node scripts/qa-backlog-entry.mjs

# ③ 用 ego-browser 驱动真实 Chromium 做浏览器端断言与截图（脚本内联在验收过程中执行；
#    读取 ② 产生的 state 文件，桌面 1440x900 / 移动 390x844 + 微信 X5 UA）
ego-browser nodejs <<'JS'
  const fs = await import("node:fs/promises");
  const STATE = JSON.parse(await fs.readFile("/tmp/task8-qa-state.json", "utf8"));
  const task = await taskSpace("task8-backlog-enter-qa");
  const page = task.page("p1");
  await page.goto(STATE.baseUrl);          // 首次命中登录页时用同一个 state 登录
  // …见 §4 断言序列；截图写入 qa-20261101/task8-*.png
JS

# ④ 结束：Ctrl-C / SIGTERM 触发清理（kill stub/server/mock ONENAT + 删除临时数据目录与 state）
```

`--check` 实测输出（全部通过）：

```
✅ 登录成功（workbuddy）
✅ 项目 A 创建
✅ 项目 A backlog 初始化
✅ backlog 配置就绪（statuses）— To Do / In Progress / Done
✅ 待办「实现「进入工作台」按钮」创建并置状态 To Do
✅ 待办「离线项目入口可用性验证」创建并置状态 In Progress
✅ 待办「历史已完成待办示例」创建并置状态 Done
✅ 项目 B（不可达节点）创建
✅ overview：项目 A nodeStatus=ok 且有 3 条待办 — items=3
✅ overview：项目 B nodeStatus=unreachable（离线分组）
```

## 4. 验收矩阵（逐项 PASS/FAIL + 证据）

浏览器轮次：桌面 1440x900（AC#1/#2/#3）、移动 390x844 + 微信 X5 UA（AC#4）、
补充故障注入轮（AC#3 错误提示 / 旧内核降级）。

### AC#1 — 每个分组都有「进入工作台」，与「看板」并列且在左

| # | 断言 | 结果 | 实测值 |
| --- | --- | --- | --- |
| 1.1 | 分组数 ≥2 | ✅ PASS | `groups=2`（A=`proj-xhlsmx96`、B=`proj-vx224jiz`） |
| 1.2 | 每个 `.bl-group-h` 恰好 1 个 `.bl-enter-btn` | ✅ PASS | 每行 `enterCount=1` |
| 1.3 | 按钮文案为「进入工作台」 | ✅ PASS | `["进入工作台","进入工作台"]` |
| 1.4 | `data-enter` 等于该分组 `projectId` | ✅ PASS | `["proj-vx224jiz","proj-xhlsmx96"]`（与 `data-grp-h` 逐一相等） |
| 1.5 | DOM 顺序在 `.bl-board-btn` 之前 | ✅ PASS | 两个分组 `enterBeforeBoard=true`（同父 children 索引比较） |
| 1.6 | 与「看板」并列（同一分组头，看板各 1 个、文案「看板」） | ✅ PASS | `boardCount=1`、`boardText="看板"` |
| 1.7 | 在线分组按钮启用 | ✅ PASS | A：`enterDisabled=false`、节点徽标「● 节点正常」 |

证据：`qa-20261101/task8-01-backlog-desktop-1440x900.png`（1440x900，两分组头右侧「进入工作台 · 看板」）

### AC#2 — 点击进入工作台草稿 + 浏览器返回回到待办聚合页

| # | 断言 | 结果 | 实测值 |
| --- | --- | --- | --- |
| 2.1 | 点击项目 A 按钮后 `location.hash === '#work'` | ✅ PASS | `hash=#work` |
| 2.2 | `#view-work.on`（且 `#view-backlog` 不再 on） | ✅ PASS | `workOn=true, backlogOn=false` |
| 2.3 | `#draft-place-btn` 含项目名与「📦」 | ✅ PASS | `📦 TASK8 验收项目A · 🖥 默认节点 ▾` |
| 2.4 | `#chat-title` 含「新任务（草稿）」 | ✅ PASS | `新任务（草稿）` |
| 2.5 | 进入草稿态（`body.draft-mode`） | ✅ PASS | `draftMode=true` |
| 2.6 | `history.back()` 后 `hash === '#backlog'` | ✅ PASS | `hash=#backlog` |
| 2.7 | 返回后 `#view-backlog.on`、`#view-work` 关闭 | ✅ PASS | `backlogOn=true, workOn=false` |
| 2.8 | 返回后分组数量恢复正常 | ✅ PASS | `groups=2, enterBtns=2` |

证据：
`qa-20261101/task8-02-workbench-draft-from-backlog.png`（进入工作台草稿态）、
`qa-20261101/task8-03-back-to-backlog-after-history-back.png`（返回后待办聚合页）

### AC#3 — 节点离线时按钮仍可用；工作台承接节点错误态；加载失败有明确提示

| # | 断言 | 结果 | 实测值 |
| --- | --- | --- | --- |
| 3.1 | 离线分组可识别（含 `[data-bl-retry]` 节点不可达徽标） | ✅ PASS | B 组 `hasRetryBadge=true`、徽标「⚠ 节点不可达」 |
| 3.2 | 离线分组 `.bl-enter-btn` 无 `disabled` 属性 | ✅ PASS | `enterDisabled=false` |
| 3.3 | 对照：离线分组「看板」仍 disabled（仅入口放开） | ✅ PASS | B 组 `boardDisabled=true`（A 组 `false`） |
| 3.4 | 点击离线项目按钮可进入工作台 | ✅ PASS | `hash=#work, workOn=true` |
| 3.5 | 离线项目草稿位置显示该项目 | ✅ PASS | `📦 TASK8 不可达项目 · 🖥 默认节点 ▾` + 「新任务（草稿）」 |
| 3.6 | 工作台自行呈现节点错误态（草稿内发送一条消息） | ✅ PASS | 任务 `task-3f83e69e` 置 `failed`；对话区显示「⚠️ 任务节点不可达（http://127.0.0.1:1/api/v1）：连接失败 / 请在右上角「节点」切换到可用节点后新建会话，或检查 ONENAT 上该映射的隧道/端口是否在线」；侧栏任务项标注「任务节点不可达」 |
| 3.7 | 项目数据加载失败给明确错误提示（故障注入：`api()` 全失败 + 清空 `state.projects`） | ✅ PASS | toast 依次为「项目列表尚未就绪，正在刷新后重试…」→「无法进入工作台：项目列表加载失败（请检查登录状态与网络后重试）」 |
| 3.8 | 项目不存在给明确错误提示（调用统一入口传入不存在的项目） | ✅ PASS | toast「无法进入工作台：项目不存在或已被删除（proj-does-not-exist-qa）」 |

证据：
`qa-20261101/task8-04-offline-project-workbench-draft.png`（离线项目进入工作台草稿）、
`qa-20261101/task8-10-offline-workbench-send-node-error.png`（工作台呈现节点错误态）、
`qa-20261101/task8-05-enter-missing-project-error-toast.png`（项目不存在提示）、
`qa-20261101/task8-11-project-list-load-failure-toast.png`（项目列表加载失败提示）

### AC#4 — 390x844 移动端（微信 X5 UA）布局与可点击

移动视口：`Emulation.setDeviceMetricsOverride 390x844、dpr=3、mobile=true`；
UA 覆盖为微信 X5/Chrome 66 内核 UA
（`… Chrome/66.0.3359.126 MQQBrowser/6.2 TBS/045008 … MicroMessenger/7.0.9 …`），
实测 `innerWidth=390, innerHeight=844`。

| # | 断言 | 结果 | 实测值 |
| --- | --- | --- | --- |
| 4.1 | 视口 390x844 | ✅ PASS | `innerWidth=390, innerHeight=844` |
| 4.2 | 每个 `.bl-enter-btn` `rect.height >= 44` | ✅ PASS | 两个按钮均 `h=44`、`w=93`（`min-height:44px` 生效） |
| 4.3 | 无横向溢出 | ✅ PASS | `documentElement.scrollWidth=390`、`body.scrollWidth=390`、`innerWidth=390`（`<= innerWidth+1`） |
| 4.4 | 按钮在视口内、不溢出 | ✅ PASS | `x=23, right=116`（视口宽 390，均在范围内） |
| 4.5 | 文案不换行/不挤压（X5 flex 收缩场景） | ✅ PASS | `white-space=nowrap`；按钮与「看板」矩形无重叠（`enterBoardOverlap=[false,false]`） |
| 4.6 | 分组头自身无横向滚动 | ✅ PASS | `scrollWidth=clientWidth=364`（窄屏自然换行成两行，头高 87px） |
| 4.7 | 移动端点按生效，进入工作台 | ✅ PASS | `hash=#work, workOn=true`，草稿 `📦 TASK8 验收项目A · 🖥 默认节点 ▾` |
| 4.8 | 移动端返回键回到待办聚合页 | ✅ PASS | `hash=#backlog, groups=2` |
| 4.9 | 旧内核降级：`history.pushState` 抛错时仍能进入工作台（不前置拦截） | ✅ PASS | 注入 `pushState` 抛错后点按仍 `workOn=true` + 草稿项目正确 |

证据：
`qa-20261101/task8-06-backlog-mobile-390x844-x5ua.png`（移动端待办页）、
`qa-20261101/task8-07-workbench-mobile-after-tap.png`（移动端进入工作台）、
`qa-20261101/task8-08-mobile-back-to-backlog.png`（移动端返回后待办页）、
`qa-20261101/task8-09-no-pushstate-still-enters.png`（pushState 不可用降级）

> **X5 覆盖度说明（如实记录）**：ego-browser 是 Chromium，无法真正切换成微信 X5 的
> Android WebView 旧引擎；本轮通过「窄视口 + 微信 X5 UA + 旧内核降级注入（pushState 不可用）」
> 复现 X5 的两个关键风险面（布局换行/热区、router 能力缺失）。另做了静态核查：本次改动新增
> CSS 仅 `flex:none`、`white-space:nowrap`、`min-height/padding/font-size`、`touch-action:manipulation`，
> 均为 Chrome 66 已支持属性，未引入 `color-mix()`/容器查询等新语法。真机 X5 引擎渲染仍需
> 人工/真机补测（本轮不具备条件）。

## 5. 补充验证

| 项 | 结果 | 说明 |
| --- | --- | --- |
| 统一入口复用（项目卡片 / ⌘K / 待办分组头共用 `enterProjectWorkspace`） | ✅ | 代码契约命中；本报告只对分组头入口做浏览器端验收（项目卡片入口为既有功能） |
| 项目 A 分组数据（3 条不同状态待办）正常渲染 | ✅ | `To Do` / `In Progress` / `Done` 三态可见，说明按钮新增未破坏行渲染 |
| 离线分组「看板」按钮保持 disabled（不回归） | ✅ | 只放开入口按钮，看板保持原有限制 |
| 浏览器返回的层级语义 | ✅ | 进入时 `history.pushState('#work')`，`history.back()` 回到 `#backlog`（`history.length` 增长） |

## 6. 发现的异常 / 缺陷

**产品缺陷：0 个。** 未发现与 TASK-8 需求或 DOM 契约不符的行为。

如实记录的非产品问题（脚手架侧）：

1. 首次配置轮次中，ego-browser 用「填表 + 点击登录按钮」方式登录后 20s 内未观测到应用加载
   （`#nav` 未出现）。删除 `wb_session` cookie 后复测同一路径**正常**跳转
   `…/onenat-workbuddy/?r=…` 并加载应用（`hasNav=true`），判定为首轮自动化时序抖动，**非产品缺陷**。
   正式验收轮次统一改用页面内 `fetch POST /api/auth/login` 完成登录（与表单同接口、同 Cookie），
   登录态正常。
2. X5 真机引擎不可得（见 §4 说明），仅做 UA + 视口 + 能力降级模拟。
3. AC#3.7/3.8 的「加载失败 / 项目不存在」提示通过故障注入触发（正常路径下概览页加载成功时不会出现），
   用于验证错误提示文案存在且可读，属补充验证而非用户常规路径。

## 7. 证据文件清单（`qa-20261101/`）

| 文件 | 尺寸 | 内容 |
| --- | --- | --- |
| `task8-01-backlog-desktop-1440x900.png` | 1440x900 | 桌面待办聚合页：两分组头「进入工作台 · 看板」；离机组「看板」置灰 |
| `task8-02-workbench-draft-from-backlog.png` | 1440x900 | 点击项目 A「进入工作台」后的工作台草稿态（`#work`） |
| `task8-03-back-to-backlog-after-history-back.png` | 1440x900 | `history.back()` 回到待办聚合页 |
| `task8-04-offline-project-workbench-draft.png` | 1440x900 | 离线项目 B 的按钮可用 → 进入其工作台草稿 |
| `task8-05-enter-missing-project-error-toast.png` | 1440x900 | 项目不存在时 toast 明确错误提示 |
| `task8-06-backlog-mobile-390x844-x5ua.png` | 390x844 | 移动端（X5 UA）待办页，按钮 44px、无横向溢出 |
| `task8-07-workbench-mobile-after-tap.png` | 390x844 | 移动端点按「进入工作台」后的工作台草稿 |
| `task8-08-mobile-back-to-backlog.png` | 390x844 | 移动端返回键回到待办聚合页 |
| `task8-09-no-pushstate-still-enters.png` | 390x844 | `pushState` 抛错（旧内核降级）仍进入工作台 |
| `task8-10-offline-workbench-send-node-error.png` | 1440x900 | 离线项目草稿内发送消息 → 工作台呈现节点错误态 |
| `task8-11-project-list-load-failure-toast.png` | 1440x900 | 项目列表加载失败时的明确错误提示（故障注入） |

## 8. 环境清理确认

验收结束后已清理（`node scripts/qa-backlog-entry.mjs` 的 SIGTERM 处理器：

```
pgrep 残留：none
18120/18121/18125 LISTEN：no listeners
临时数据目录 workbuddy-task8-qa-*：已删除
/tmp/task8-qa-state.json：已删除
```

---

# 复验（最终构建 a94c61da…）

- 复验日期：2026-11-01（CST），触发：Lead 按 independent reviewer 意见做 4 处收敛后重新构建
  （G1 防连点/`pushState` 幂等、G2 移动端按钮组靠右、⌘K 带 `fromView='backlog'`、smoke 断言更新），
  要求在**最终构建**上补做浏览器复验。上一轮 4/4 PASS 结论保留，本章为增量复验记录。
- 复验范围：a) AC#1/#2 正常路径回归；b) G1 连点历史污染修复；c) G2 移动端右对齐（390x844 + 320x844）；
  d) 两种错误提示回归 + 「正在刷新」toast 撤除。

## R1. 最终构建指纹（与旧验收构建区分）

| 项 | 旧验收构建（首轮报告） | **最终构建（本章复验对象）** |
| --- | --- | --- |
| `dist/web-ui.js` sha256 | `93234d1c1bc653d193b2d4b02d47a02389a7f4dc01135a19b27386101905c93f` | **`a94c61daa43f087a89eb1803d9edbcbc9f666148cb831efb4012c52f6d189947`** |
| `dist/web-ui.js` 大小 / mtime | 858565 B / 2026-11-01 10:51 | **859942 B / 2026-11-01 10:57:50** |
| `dist/server.js` sha256 | `194dd4ef…194e73899` | `194dd4efcfca9aee662915c23acad1fe09403b1dc8ead3d4e02e094194e73899`（未变） |

复验环境：复用 `scripts/qa-backlog-entry.mjs`（server 18120 / stub DSH 18121 / mock ONENAT 18125，
全新临时数据目录隔离，与 Lead 的 smoke 端口不冲突）；本次新建数据：
项目 A `proj-56zdygth`（可达 stub 节点、3 条不同状态待办）、项目 B `proj-1hwl3fah`（不可达节点）。
浏览器：ego-browser v2.2.0 真实 Chromium；桌面 1440x900，移动 390x844 / 320x844（dpr3、mobile、微信 X5 UA）。

## R2. a) 正常路径回归（最终构建）— PASS

| # | 断言 | 结果 | 实测值 |
| --- | --- | --- | --- |
| R-AC1.1 | overview 分组数 | ✅ PASS | `groups=2` |
| R-AC1.2 | 每个 `.bl-group-h` 恰好 1 个 `.bl-enter-btn`，文案「进入工作台」，`data-enter`==projectId | ✅ PASS | `[{pid:proj-1hwl3fah,n:1},{pid:proj-56zdygth,n:1}]`，文案均「进入工作台」 |
| R-AC1.3 | DOM 顺序在 `.bl-board-btn`（看板）之前且看板文案「看板」 | ✅ PASS | 两个分组 `enterBeforeBoard=true`、`boardText="看板"` |
| R-AC1.4 | 在线/离线按钮启用态与看板 disabled 对照 | ✅ PASS | A：`enter=false`；B：`enter=false`(无 disabled)、`board=true`(disabled)、`data-bl-retry` 徽标存在 |
| R-AC2.1 | 点击项目 A「进入工作台」→ `#work` + 工作台 + 草稿 | ✅ PASS | `hash=#work, workOn=true`，`#draft-place-btn="📦 TASK8 验收项目A · 🖥 默认节点 ▾"`，`#chat-title="新任务（草稿）"` |
| R-AC2.2 | `history.back()` → `#backlog` 且分组恢复 | ✅ PASS | `hash=#backlog, backlogOn=true, workOn=false, groups=2` |

证据：`qa-20261101/task8-12-final-build-desktop-backlog.png`（1440x900）、
`task8-13-final-build-workbench-draft.png`（1440x900）、
`task8-14-final-build-back-to-backlog.png`（1440x900）

## R3. b) G1 防连点 — PASS（评审连点场景修复实测生效）

构造场景：`state.projects = []`（模拟 `/api/projects` 返回空/过期，而 overview 仍展示该项目），
再触发「项目列表里没有该项目 → loadProjects 后重试」分支。

| # | 场景 | 断言 | 结果 | 实测值 |
| --- | --- | --- | --- | --- |
| R-G1a.1 | **同一 tick 连点两次**（快速双击） | 只压一条 `#work` 历史（`history.length` 增量 == 1） | ✅ PASS | `history.length 6 → 7`（delta=1）；重复测量第二轮 `9 → 10`（delta=1） |
| R-G1a.2 | 同上 | 「项目列表尚未就绪」toast 只出现 1 次（in-flight 守卫拦截第二次） | ✅ PASS | `window.toast` 调用计数：该类 toast **1 次**；全部 toast 调用 `["项目列表尚未就绪，正在刷新后重试…"]` |
| R-G1a.3 | 同上 | 重试成功进入工作台后「正在刷新」toast 已被撤掉 | ✅ PASS | `#toast.style.display === "none"` |
| R-G1a.4 | 同上 | **一次** `history.back()` 即回到待办聚合页 | ✅ PASS | `hash=#backlog, backlogOn=true, workOn=false, groups=2` |
| R-G1b.1 | loadProjects 成功后第二次点击（此时 hash 已是 `#work`） | `pushState` 幂等守卫生效，不再新增历史 | ✅ PASS | `history.length 7 → 8（首次进入）→ 8（二次点击后）`，delta=1 |
| R-G1b.2 | 同上 | 一次 back 回待办 | ✅ PASS | `hash=#backlog, backlogOn=true` |
| R-G1-control.1 | 不连点（单次点击）对照 | 增量 1 + 一次 back 回待办 | ✅ PASS | `history.length 8 → 9`；back 后 `#backlog` |

证据：`qa-20261101/task8-15-g1-doubleclick-one-back-to-backlog.png`（1440x900，连点场景一次 back 后的待办页）

> 说明：首次观测用 `MutationObserver` 监听 `#toast` 时，同一次 toast 因 `className` 与
> `textContent` 两次变更被计入 2 条记录（观察器伪影）。改用 `window.toast` 调用计数器复测，
> 实际调用次数为 **1**，与 in-flight 守卫实现一致；非产品问题。

## R4. c) G2 移动端按钮组靠右 — PASS

| # | 断言 | 结果 | 实测值（390x844） | 实测值（320x844） |
| --- | --- | --- | --- | --- |
| R-G2.1 | 视口生效 | ✅ PASS | `innerWidth=390` | `innerWidth=320` |
| R-G2.2 | 按钮换行到第二行 | ✅ PASS | `wrapped=true`（两分组） | `wrapped=true`（两分组） |
| R-G2.3 | 换行后「进入工作台 · 看板」右对齐（按钮组右缘≈分组头右内边距） | ✅ PASS | `header.right=377`，`board.right=367`，`rightGap=10` == `padding-right:10px` | `header.right=307`，`board.right=297`，`rightGap=10` == `padding-right:10px` |
| R-G2.4 | 两按钮同一行、同一基线 | ✅ PASS | `sameRow=true` | `sameRow=true` |
| R-G2.5 | 计算样式为移动端规则（非桌面基样式） | ✅ PASS | `font-size=12.5px`、`padding=10px 14px`、`min-height:44px` | `font-size=12.5px`、`padding=10px 14px` |
| R-G2.6 | 热区 ≥44px | ✅ PASS | `.bl-enter-btn 93x44`、`.bl-board-btn 55x44` | `.bl-enter-btn 93x44`、`.bl-board-btn 55x44` |
| R-G2.7 | 无横向溢出 | ✅ PASS | `docScrollWidth=bodyScrollWidth=390=innerWidth` | `docScrollWidth=bodyScrollWidth=320=innerWidth` |
| R-G2.8 | 可点击并进入工作台 | ✅ PASS | 点按 → `hash=#work`、`workOn=true`、草稿 `📦 TASK8 验收项目A · 🖥 默认节点 ▾`、无横向溢出（`390=390`） | 点按 → `hash=#work`、`workOn=true`、草稿 `📦 TASK8 验收项目A · 🖥 默认节点 ▾`、`320=320` |
| R-G2.9 | 320 下移动端返回回待办 | ✅ PASS | — | `hash=#backlog` |

证据：`qa-20261101/task8-18-mobile-390x844-buttons-right-aligned.png`（390x844）、
`task8-19-mobile-320x844-buttons-right-aligned.png`（320x844）、
`task8-20-mobile-320x844-workbench-after-tap.png`（320x844 点按后进入工作台）

> 说明：390 首次测量时 Chromium 设备模拟切换存在一次样式未切换的过渡态（按钮仍是桌面基样式
> 11px/4px 8px、宽 73px，但高仍 44px），显式 `reload` 后规范态为 12.5px/10px 14px/93px；
> 已用规范态复测并重拍截图 18。右对齐/热区/无溢出/可点击四项断言在两种状态下均成立，
> 属模拟器切换时序，非产品问题。

## R5. d) 错误提示回归 — PASS

| # | 场景 | 断言 | 结果 | 实测值 |
| --- | --- | --- | --- | --- |
| R-D1 | 项目不存在（传入 `proj-does-not-exist-qa`） | 明确错误提示 | ✅ PASS | toast：`项目列表尚未就绪，正在刷新后重试…` → `无法进入工作台：项目不存在或已被删除（proj-does-not-exist-qa）` |
| R-D2 | 项目列表加载失败（故障注入：`api()` 全失败 + `state.projects=[]`） | 明确错误提示（区分于「不存在」） | ✅ PASS | toast：`项目列表尚未就绪，正在刷新后重试…` → `无法进入工作台：项目列表加载失败（请检查登录状态与网络后重试）` |

证据：`qa-20261101/task8-16-error-missing-project-toast.png`（1440x900）、
`task8-17-error-project-list-load-failure-toast.png`（1440x900）

## R6. 复验结论与备注

**结论：最终构建 `dist/web-ui.js` sha256 `a94c61da…189947` 上，a) 正常路径回归、b) G1 防连点、
c) G2 移动端靠右、d) 错误提示回归 全部 PASS；G1/G2 两处修复实测生效；未发现新缺陷，
上一轮 AC#1~#4 4/4 PASS 结论在该构建上继续成立。**

备注（如实记录，均非产品缺陷）：

1. G1 首选观测手段（MutationObserver 监听 `#toast`）会把同一次 toast 的 className/text 两次变更
   记成 2 条，导致「toast 调用次数」误判；已改用 `window.toast` 调用计数器复测为 1 次。
2. 390px 首次测量落入 Chromium 设备模拟样式切换的过渡态（桌面基样式 11px/73px 宽、高已 44px），
   `reload` 后规范态 12.5px/93px；已按规范态复测与重拍。两项关键断言（右对齐、≥44px）不受影响。
3. 本复验的新浏览器任务空间登录：仅改 hash 的 `goto` 属 same-document 导航，会停留在登录页
   （与 `login-ui.ts` 中「replace 被当作片段导航」的既有注释同类问题）；改用 `?r=` 强制真实导航后
   登录正常。属 QA 脚手架路径问题，非本次改动范围。
4. 未运行 `npm run smoke` / `npm run build`（按约定由 Lead 负责；Lead 已确认最终 dist 由 `npm run build` 重跑产出）。
5. 环境清理确认（复验结束后）：

```
pgrep 残留：none
18120/18121/18125 LISTEN：no listeners
临时数据目录 workbuddy-task8-qa-*：已删除
/tmp/task8-qa-state.json：已删除
```
