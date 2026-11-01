# ⌘K 命令面板接入 backlog 条目全局检索（TASK-1）

## 需求

待办条目多了以后，只能进「✅ 待办」聚合页逐项目翻找，没有全局检索入口。本变更把 backlog 条目接进控制台已有的 ⌘K 命令面板（与命令、任务、专家同一入口）：输入即时过滤 itemId / 标题 / 状态关键词，选中后跳到对应项目的待办看板并打开该条目详情抽屉。

## 设计要点

- **纯前端**（`src/web-ui.ts` 内联脚本），零后端改动：复用现有 `GET {prefix}/api/backlog/overview`（跨项目聚合，服务端 `overviewBacklog` 已按项目做失败隔离）与 `GET {prefix}/api/projects/:id/backlog`（单项目权威列表），沿用 `esc` / `toast` / `switchView` / `blRender` / `blOpenDetail` 等既有函数，不引入框架或新依赖。
- **命令源**：`cmdkCommands(query)` 在**有查询词时**追加「待办」组（空查询不展开，避免一次把全部条目塞进面板）：
  | 字段 | 值 |
  | --- | --- |
  | lb（可搜） | `itemId + 标题` |
  | kw（可搜） | 状态 + 项目名 + labels + assignees |
  | sub | `项目名 · 状态`（≤768px 隐藏，故状态同时进了 kw） |
  | ord | 35（会话 30 之后、子智能体 40 之前） |
  | act | `cmdkOpenBacklogItem(projectId, itemId)` |
- **懒加载、不阻塞面板打开**（AC#3）：`cmdkOpen()` 只触发 `cmdkBacklogPrefetch()`（后台 `api('/backlog/overview')`，不 await），面板立即渲染其它命令；请求返回后若面板仍开着再 `cmdkRender()` 把「待办」组补进去。缓存优先级：`blState.data`（待办视图已加载的同一份聚合）> 面板自有缓存（30s TTL）；`loading` 去重，避免连开门板重复打接口。
- **过滤**（AC#3）：只收 `nodeStatus === 'ok' && initialized` 的项目；未初始化 backlog、节点不可达（`unreachable`）、归档（`archived`）的项目一律不进结果。
- **跳转**（AC#2）：`cmdkOpenBacklogItem` = 先用聚合缓存即时渲染该项目看板并 `switchView('backlog')`（避免远端请求期间白屏/停留在旧看板）→ 再拉 `GET /projects/:id/backlog` 权威刷新 → `blOpenDetail(itemId)` 打开条目详情抽屉；列表请求失败时保留缓存看板并 toast 明确错误，不静默。
- **交互提示**：header ⌘K 按钮 title 与输入框 placeholder 增加「待办条目标题或状态」；`cmdkCommands` 顺带补上「待办 · Backlog」视图命令（此前 ⌘K 缺该一级视图）。
- **兼容性**：新增段只用 `var` / `function` / 字符串拼接 / Promise，不使用 `?.`、`??`、反引号与 `${`（页面源码在 TS 模板字符串内），移动端 ≤768px 沿用既有 `.cmdk-item .sub { display:none }` 与面板宽度规则。

## 变更点

| 文件 | 变更 |
| --- | --- |
| `src/web-ui.ts` | cmdk 段：新增「待办」视图命令、`cmdkCommands` 追加 backlog 条目、`cmdkOpen` 触发预取、placeholder/title 文案；backlog 段新增 `cmdkBl` 缓存与 `cmdkBacklogGroups` / `cmdkBacklogPrefetch` / `cmdkBacklogCmds` / `cmdkBacklogCmd` / `cmdkOpenBacklogItem` |
| `scripts/smoke-standalone.mjs` | 新增 2 项静态断言：cmdk×backlog 接线齐备（视图命令 / 懒加载 / nodeStatus+initialized 过滤 / 跳看板开详情）；新增代码段无 `?.` / `??`（X5 旧内核） |

## 验收

1. `npm run build`：tsc 通过 + 内联脚本 `node --check` 关卡 3 页全过（`page scripts extracted: 3`）
2. `npm run typecheck`：通过
3. `npm run smoke`：83 项全过（含上述 2 项新增断言）
4. 浏览器真实走查（独立 QA，真实 Chromium + stub DSH）：见 `docs/qa-cmdk-backlog-20261101.md`
   - 输入 itemId / 标题片段 / 状态词（To Do / In Progress / Done）均能命中「待办」组，且跨项目
   - 未初始化 / 节点不可达项目不出现在结果里；overview 慢时面板仍立即打开、返回后自动补组
   - 选中后进入对应项目看板并打开条目详情抽屉；≤768px 与微信 X5 UA 下可用、无横向溢出
   - 复验结果：桌面 35/35 + 移动 8/8 + 环境种子 29/29 全 PASS（overview 5015ms 时面板 16ms 打开）
