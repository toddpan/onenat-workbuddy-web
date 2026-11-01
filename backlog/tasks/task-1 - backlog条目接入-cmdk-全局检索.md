---
id: TASK-1
title: "backlog 条目接入 cmdk 全局检索"
status: Done
assignee:
created_date: '2026-11-01T00:00:00Z'
updated_date: '2026-11-01T10:44:46Z'
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
- [x] #1 cmdk 面板能跨项目搜到 backlog 条目（itemId / 标题 / 状态关键词均可命中）
- [x] #2 选中条目后跳转到对应项目的待办看板并打开该条目抽屉
- [x] #3 未初始化 backlog 的项目不出现在结果中，且该节点不可达时不阻塞面板打开
- [x] #4 npm run build 与 npm run smoke 通过（新增断言或明确说明仅做手测）
<!-- AC:END -->

### 2026-11-01T05:00:27Z 派发为任务
task-3c3d653a · mode=orchestrate · 成员=2

### 2026-11-01T09:18:42Z 派发为任务
task-178a756c · mode=orchestrate · 成员=2

### 2026-11-01T09:32:00Z 完成（复验）

实现：`a22b68d feat(cmdk): 待办条目接入 ⌘K 全局检索（跨项目聚合 + 懒加载 + 跳看板开详情）`（`src/web-ui.ts` 纯前端，零后端改动）。

复验（当前 HEAD 44fce2c + 重新 `npm run build` 的 dist）：

- `npm run build` ✅（tsc + 3 页内联脚本 `node --check`）；`npm run smoke` ✅ **83 项全过**（含 TASK-1 接线 / 无 `?.`·`??` 2 项静态断言）。
- 真实 Chromium（ego-browser v2.2.0）独立 QA：桌面 **35/35** + 移动 390x844/X5 UA **8/8** + 环境种子 **29/29**，共 72 项断言全 PASS，未发现产品缺陷。
  - AC#1：`TASK-1`/标题片段/`To Do`·`In Progress`·`Done` 均命中「待办」组，同编号条目跨 A/C 两项目；
  - AC#2：Enter → `#backlog` + 对应项目看板 + 条目详情弹层（移动端同样通过）；
  - AC#3：overview 实测 **5015ms** 时面板 **16ms** 打开、返回后自动补组；不可达 / 归档 / 未初始化 / 慢节点项目 0 泄漏；
  - AC#4：build/smoke 通过，移动端无横向溢出、无 JS 异常。
- 报告：`docs/qa-cmdk-backlog-20261101.md`；证据与可复现脚本：`qa-20261101/task1-cmdk-backlog/`。
- QA 脚手架修正 2 处（非产品问题）：C5 对齐 `overviewOne` 的 unreachable `initialized:true` 语义；M6 改为断言「实际选中条目」所属项目与标题。


### 2026-11-01T09:30:59Z 派发执行（成功）
任务 task-178a756c · 结果=成功
I'll start by exploring the project structure and understanding the existing cmdk implementation.Interesting — git log shows a commit that looks like this exact task. Let me investigate the current state.The task appears already implemented in commit `a22b68d`. Let me verify current state — code, docs, and whether the build is current.Feature code exists and dist is current. Let me read the actual implementation to assess quality against the acceptance criteria.Implementation looks substantially

### 2026-11-01T10:02:11Z 派发为任务
task-68b459af · mode=orchestrate · 成员=2

### 2026-11-01T10:03:59Z 派发执行（成功）
任务 task-68b459af · 结果=成功
实现似乎已经在代码中了。我来检查一下 git status，并确认 build 和 smoke 是否通过。代码已在工作区完成，并附带 QA 证据。让我来运行验收检查（build + smoke）。TASK-1（backlog 条目接入 cmdk 全局检索）已完成并全量复验通过。本轮我做的是对既有实现做验收复跑与确认：

## 实现要点（src/web-ui.ts:15161-15233）

- **数据源**：复用跨项目聚合 `GET /api/backlog/overview`（src/router.ts:1496），打开面板时后台预取（不 await，懒加载），复用待办视图已加载的 `blState.data`，带 30s TTL 缓存。
- **命中范围**：itemId、标题、状态关键词均可命中（`kw` 含 status / 项目名 / 标签 / 负责人）。
- **AC#2 选中跳转**：`cmdkOpenBacklogItem` 先用聚合缓存即时渲染目标项目看板（避免白屏），`switchView('backlog')` 后拉权威列表刷新，再 `blOpenDetail(

### 2026-11-01T10:05:35Z 派发为任务
task-3c163e55 · mode=orchestrate · 成员=2

### 2026-11-01T10:07:00Z 派发执行（成功）
任务 task-3c163e55 · 结果=成功
实现似乎已经就绪。我先验证一下冒烟测试覆盖率，然后运行 build + smoke。TASK-1「backlog 条目接入 cmdk 全局检索」已完成并通过全部验证，实现就在 [src/web-ui.ts](src/web-ui.ts)。

## 实现要点

**数据源（优先复用跨项目聚合）**：复用 `GET /api/backlog/overview`（[cmdkBacklogPrefetch](src/web-ui.ts#L15184)）——打开面板时后台预取、不 await，面板立即打开（AC#3）；待办视图已加载过的 `blState.data` 优先复用，另加 30s TTL 兜底。服务端已做项目级失败隔离，单节点不可达不会拖慢面板；整体请求失败时静默降级，其它命令照常可用。

**检索与过滤**（[cmdkBacklogCmds / cmdkBacklogCmd](src/web-ui.ts#L15199)）：
- 只有输入查询词时才展开「待办」组，空查询保持面板轻量；
- 命中字段：itemId、标题（lb）、状态 + labels + assignees + 项目名（

### 2026-11-01T10:44:03Z 派发为任务
task-63851d5b · mode=orchestrate · 成员=2

### 2026-11-01T10:44:46Z 派发执行（成功）
任务 task-63851d5b · 结果=成功
实现已经在 src/web-ui.ts 中就位。我来验证一下配置（cmdkOpen 中的 prefetch hook），并运行 build + smoke 以确认验收。TASK-1「backlog 条目接入 cmdk 全局检索」已完成并验证通过。

## 实现内容（src/web-ui.ts）

- **跨项目检索**（AC#1）：`cmdkBacklogCmds()` 基于 `GET /backlog/overview` 聚合结果，把每条待办生成为「待办」组命令；`lb` 含 itemId + 标题，`kw` 含状态 / 项目名 / 标签 / 负责人，走现有 `cmdkMatch` 分词过滤，任意关键词可命中。
- **选中跳转**（AC#2）：`cmdkOpenBacklogItem(projectId, itemId)` 先用聚合缓存即时渲染看板（避免白屏），`switchView('backlog')` 后拉权威列表 `GET /projects/:id/backlog` 刷新，最后 `blOpenDetail(itemId)` 打开条目抽屉；列表拉取失败时保留缓存看板并 to
