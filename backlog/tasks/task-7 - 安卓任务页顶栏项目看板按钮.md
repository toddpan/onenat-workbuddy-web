---
id: TASK-7
title: "安卓任务页顶栏新增「项目看板」按钮（直达当前项目 backlog 看板）"
status: Done
assignee:
created_date: '2026-11-01T00:45:00Z'
updated_date: '2026-11-01T02:20:19Z'
labels:
  - "android"
  - "backlog"
  - "ui"
dependencies:
priority: "medium"
ordinal: 7000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
需求（用户 2026-11-01）：手机客户端任务会话页的**顶栏工具栏**加一个按钮，点击直接打开**当前项目**的任务看板（backlog 看板），不用再走「待办 → 聚合总览 → 展开项目」两步。

现状（安卓 onenat-workbuddy-android）：
- 顶栏操作行是 CollabUi.kt 的 CollabEntryRow（约 L90-125）：🎯 长期目标 / 📋 计划模式 / 🗜️ 压缩 / ⏰ 定时任务 / 📤 分享 / 📁 文件 / ↪ 跨节点续接；这些入口都是可空回调（null 不渲染），单行等距，HeaderIconButton 22sp + ≥48dp 热区 + contentDescription 必填。
- backlog 能力已齐全：BacklogScreen.kt（聚合层 + 看板层 boardProj 状态）、Api.kt「Backlog 待办」段（约 L351-395）提供 backlogList / backlogInit / backlogCreateItem / backlogUpdateItem / backlogDispatch 等。
- 但入口只有一处：WbShell.kt「待办（Backlog）」→ MainActivity.kt L354 挂 "backlog" -> BacklogScreen(...)，进去是**聚合总览**，要手动再选中项目才进看板；没有从任务上下文直达的能力。
- 任务对象已带 projectId（WbModels.kt 的 Task.projectId，parseTask 读 data.projectId），足以定位项目。

要做的事：
1. CollabEntryRow 新增入口（建议 ✅ 或 📋 + 「看板」文字标签，与「📁 文件」同款），回调 onBacklog: (() -> Unit)? = null；为 null 时不渲染，保持其它调用方不受影响。
2. BacklogScreen 支持**直接进入指定项目的看板态**：新增可空参数（如 initialProjectId: String?）；非空时加载该项目 backlog 并直接置 boardProj（跳过聚合页），聚合入口原有行为不变。
3. 路由串联：MainActivity 增加类似 openBacklog(projectId) 的路由/状态，任务页按钮把 Task.projectId 传进去；返回键回到任务会话。
4. 边界与降级：任务无 projectId → 按钮不渲染（或置灰 + 说明「当前任务未绑定项目」）；项目未初始化 backlog → 看板空态给「初始化 backlog」按钮（复用 Api.backlogInit）；项目已归档 → 只读提示；节点不可达 → 明确错误态（由看板既有错误态承接，不要在按钮层预判）。
5. 不要重复实现看板 UI：条目 CRUD、派发、依赖校验、回写状态展示全部复用 BacklogScreen 现有实现，本任务只做「入口 + 直达参数 + 空态引导」。

参考：Web 端从任务进入项目待办的交互（控制台「进入工作台 → 待办」），安卓端补齐同等可达性即算对齐。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 项目任务页顶栏出现「看板」入口；点击直达该项目 backlog 看板（不经过聚合总览页）
- [ ] #2 非项目任务（无 projectId）不显示该入口，或置灰并有明确原因提示
- [ ] #3 项目 backlog 未初始化时给出「初始化」引导且可直接初始化成功
- [ ] #4 项目已归档 / 节点不可达时显示对应只读或错误态，不出现空白页或崩溃
- [ ] #5 返回键从看板回到原任务会话；WbShell「待办」聚合入口原有行为不变
- [ ] #6 顶栏在窄屏（≤768px / 手机竖屏）不换行破版，图标 22sp、热区 ≥48dp、contentDescription 已设置
- [ ] #7 看板内条目 CRUD / 派发 / 依赖校验复用现有实现，无重复实现
<!-- AC:END -->

### 2026-11-01T01:47:27Z 派发为任务
task-b4a1ade2 · mode=orchestrate · 成员=2

### 2026-11-01T02:20:19Z 派发执行（成功）
任务 task-b4a1ade2 · 结果=成功
I'll start by getting oriented — checking the workspace, finding the Android project and the backlog task record.Found both the backlog task record and the Android project. Let me read them.This session is the dispatch for TASK-7. Let me read the key Android files.Now let me inspect the API layer, models, and the web-side backlog endpoints that back this screen.Let me check the build tooling and docs before deciding on the split.Build tooling looks complete. Let me verify a baseline compile work
