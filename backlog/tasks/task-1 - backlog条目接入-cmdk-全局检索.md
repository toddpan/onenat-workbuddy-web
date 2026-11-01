---
id: TASK-1
title: "backlog 条目接入 cmdk 全局检索"
status: "To Do"
assignee:
created_date: '2026-11-01T00:00:00Z'
updated_date: '2026-11-01T00:00:00Z'
labels:
  - "backlog"
  - "ui"
  - "search"
dependencies:
priority: "high"
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
现状：待办条目多了以后，只能进「✅ 待办」看板逐项目翻找，没有全局检索入口。

目标：把 backlog 条目接进控制台已有的 cmdk 全局搜索面板（与命令、任务、专家同一入口），支持输入即时过滤 itemId / 标题 / 状态，选中后跳到对应项目看板并打开该条目抽屉。

数据来源（二选一，优先复用）：
- 跨项目聚合：`GET {prefix}/api/backlog/overview`（已聚合全部项目的条目与 nodeStatus）；
- 单项目：`GET {prefix}/api/projects/:id/backlog`。

实现约束：
- 沿用 src/web-ui.ts 现有写法（原生 DOM + 字符串模板 + esc() + 现有 CSS 变量），不引入框架/新依赖；
- 未初始化 backlog 的项目（nodeStatus !== ok）不进结果，也不能因为某个节点不可达拖慢整个面板（懒加载或已有 overview 缓存）；
- 移动端 ≤768px 与微信 X5 旧内核下可用（不用 ?, ?? , 可选链等新语法需与文件现有风格一致）。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 cmdk 面板能跨项目搜到 backlog 条目（itemId / 标题 / 状态关键词均可命中）
- [ ] #2 选中条目后跳转到对应项目的待办看板并打开该条目抽屉
- [ ] #3 未初始化 backlog 的项目不出现在结果中，且该节点不可达时不阻塞面板打开
- [ ] #4 npm run build 与 npm run smoke 通过（新增断言或明确说明仅做手测）
<!-- AC:END -->
