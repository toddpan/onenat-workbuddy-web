---
id: task-100
title: '[feature] 项目列表每个项目加「刷新」按钮，仅刷新该单个项目'
status: Done
assignee:
created_date: '2026-11-12T11:32:28Z'
updated_date: '2026-11-12T14:58:18Z'
labels:
  - feature
  - ui
  - projects
dependencies:
priority: Medium
ordinal: 100000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
控制台项目列表页：每个项目行的「进入工作台」按钮旁边新增一个刷新按钮。点击后只重新拉取并更新这一个项目（详情/节点状态/实时信息），不整页刷新、不影响其他项目行。刷新过程要有 loading/旋转视觉反馈，完成后原地更新该项目行数据。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 「进入工作台」旁出现刷新按钮，点击仅刷新当前项目行数据
- [x] #2 刷新中按钮呈现 loading 态，其余项目行不受影响
- [x] #3 刷新完成后该项目的节点状态/任务数等实时信息更新
- [x] #4 兼容移动端 ≤768px 与微信 X5 旧内核，npm run smoke 通过
<!-- AC:END -->

### 2026-11-12T14:54:07Z 派发为任务
task-405f31a0 · mode=chat · 成员=0

### 2026-11-12T14:58:18Z 派发执行（成功）
任务 task-405f31a0 · 结果=成功
现在我来执行实现。首先是卡片 HTML：现在我来在 `wireProjectCard` 中实现连接逻辑：现在处理 CSS —— 添加到 `.mini-btn` 样式附近：::first-letter 在旧内核按钮上的表现不稳定——我改用 span 包裹来优化它：布局没有问题（`pj-ops` 使用了 `flex-wrap`）。现在我来构建并验证：预先存在的类型错误（来自进行中的 task-101 工作）阻塞了构建 —— 应用了一个最小化的 narrowing 修复，且未更改其行为：我正在更新此工作的 backlog 项目：完成。task-100「项目列表单项目刷新按钮」已实现并通过全部验证。

## 改动内容（均在 [src/web-ui.ts](src/web-ui.ts)）

**1. 刷新按钮**（[#5113](src/web-ui.ts#L5113)）：`projectCardHtml` 中「🚀 工作台」旁新增 `↻` 按钮（`.pj-refresh`），title 说明仅刷新本项目。

**2. 单项目刷新逻辑** `refreshProjectRow(pid, btn)
