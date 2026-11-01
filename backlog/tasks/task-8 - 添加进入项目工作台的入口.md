---
id: TASK-8
title: "添加进入项目工作台的入口"
status: Done
assignee:
created_date: '2026-11-01T02:25:00Z'
updated_date: '2026-11-01T03:02:47Z'
labels:
  - "backlog"
  - "ui"
dependencies:
priority: "medium"
ordinal: 8000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
需求（用户 2026-11-01，附截图）：在控制台**「✅ 待办」聚合总览页**（#backlog），每个项目的分组标题行加一个**「进入工作台」按钮**，点击直接进入该项目的工作台。

现状（截图依据）：
- 聚合总览页每个项目一行分组头：📦 项目名 · 「待办 5 / 完成 3」 · 节点状态徽标（如「● 节点正常」），行右侧已有「看板」按钮；
- 条目行右侧有「▶ 派发」按钮；分组头与看板之间目前没有「进入工作台」的直达入口，要从待办去项目工作台需绕道「项目」页。

要做的事：
1. Web 端（src/web-ui.ts 待办聚合总览视图）：在每个项目分组标题行、「看板」按钮旁新增「进入工作台」按钮，点击切换到该项目的工作台/项目详情视图（复用现有项目视图渲染逻辑，不新造页面）。
2. 按钮沿用现有原生 DOM 写法与按钮样式（与「看板」同款），不引入新依赖。
3. 位置与层级：分组头右侧操作区，排序建议「进入工作台 · 看板」；点击后路由状态可回退（返回键/返回操作回到待办聚合页）。
4. 边界与降级：节点离线（nodeStatus 非 ok）时按钮仍可用（工作台视图自行承接错误态），不要在按钮层预判；项目数据加载失败给明确错误提示。
5. 移动端 ≤768px 与微信 X5 旧内核下按钮不溢出、可点热区足够（≥44px）。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 待办聚合总览页每个项目分组标题行出现「进入工作台」按钮（与「看板」并列）
- [ ] #2 点击按钮直达该项目工作台/项目详情视图，可返回待办聚合页
- [ ] #3 节点离线/加载失败等边界场景有明确错误态（不在按钮层拦截）
- [ ] #4 移动端 ≤768px 与 X5 内核下布局正常、热区足够
<!-- AC:END -->

## Implementation Notes
<!-- SECTION:IMPLEMENTATION-NOTES:BEGIN -->

<!-- SECTION:IMPLEMENTATION-NOTES:END -->

### 2026-11-01T02:46:49Z 派发为任务
task-626d3820 · mode=orchestrate · 成员=2

### 2026-11-01T03:02:47Z 派发执行（成功）
任务 task-626d3820 · 结果=成功
TASK-8 已完成并交付。以下是最终结论。

## 改动内容（工作树未提交，共 2 个源码文件 + 3 个 QA 交付物）

| 文件 | 改动 |
|---|---|
| [src/web-ui.ts](src/web-ui.ts#L14878) | 待办聚合总览每个项目分组头，在「看板」左侧新增「进入工作台」按钮（`data-enter=<projectId>`，与看板同款 `.mini-btn`，未加 disabled） |
| [src/web-ui.ts](src/web-ui.ts#L4484) | 抽出统一入口 `enterProjectWorkspace(projectId, fromView)`，项目卡片 `.pj-enter`、⌘K 项目命令、待办按钮三处共用；从待办页进入时先 `history.pushState('#work')`，返回键/返回操作回到 `#backlog`；项目列表缺失时区分「列表加载失败」与「项目已删除」两种明确提示，并带防连点/幂等守卫 |
| [src/web-ui.ts](src/web-ui.ts#L2246-L2252) | 移动
