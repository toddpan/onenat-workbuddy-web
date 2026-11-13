---
id: task-99
title: '[bug] 项目管理「待办」按钮应打开该项目的 backlog 看板'
status: Done
assignee:
created_date: '2026-11-12T11:32:19Z'
updated_date: '2026-11-12T15:17:43Z'
labels:
  - bug
  - ui
  - projects
dependencies:
priority: High
ordinal: 99000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
控制台项目管理中的「待办」按钮：点开后应直接打开该项目自己的 backlog 看板（按 projectId 定位，展示该项目的 statuses 与待办条目），而不是全局待办页或不对应项目的看板。需修复路由/入口传参，确保 projectId 正确传递并贯穿看板加载、增删改、派发等操作。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 在任一项目上点「待办」打开的是该项目的看板（projectId 正确，显示该项目 statuses 与条目）
- [ ] #2 切换其他项目再点「待办」，看板随目标项目切换，无串数据
- [ ] #3 该项目看板内的待办增删改与派发操作均作用在该项目上
- [ ] #4 未初始化 backlog 的项目点「待办」给出明确引导（初始化提示）
- [ ] #5 移动端 ≤768px 下入口与看板可用
<!-- AC:END -->

### 2026-11-12T15:15:18Z 派发为任务
task-1b00cf24 · mode=chat · 成员=0

### 2026-11-12T15:17:43Z 派发执行（成功）
任务 task-1b00cf24 · 结果=成功
Now I'll implement the fix. Three changes: a shared `blOpenProjectBoard` entry, the project-card button using it, and an uninitialized-board guidance state in `blBoardHtml`.修复完成。改动集中在 `src/web-ui.ts`（前端路由/入口），构建、typecheck、smoke（94 项）全部通过。

## 改动内容

**1. 新增统一入口 `blOpenProjectBoard(projectId)`**（紧邻 `blNewBoard`）
- 项目「待办」→ 直接打开**该项目自己的看板**：`blState.board = blNewBoard(pid, 项目名)`，再 `switchView('backlog')` + `blLoadBoard({})`，走 `GET /projects/:id/backlog`，展示该项目自己的 statuses 与条目。
- 项目列表未就绪时先刷新一次再定位（拿不到名
