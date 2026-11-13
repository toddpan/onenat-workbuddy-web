---
id: task-97
title: 任务聊天排队追问支持取消：排队气泡「⚡ 立即发送」旁增加「✕ 取消」
status: Done
assignee:
created_date: '2026-11-12T09:37:13Z'
updated_date: '2026-11-12T11:28:50Z'
labels:
  - ui
  - chat
  - queue
dependencies:
priority: P2
ordinal: 97000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
现状：web-ui.ts syncQueuedUI 对 turn.queued 只渲染「⏳ 排队中」pill + 「⚡ 立即发送」，没有取消入口；而服务端 POST /api/tasks/:id/queue/delete 与 engine.deleteQueuedMessage 均已存在（router.ts manage 级门控），属纯 UI 缺口。
要做：syncQueuedUI 增加取消按钮 → api('/tasks/:id/queue/delete',{turnId}) 成功后：移除该气泡 flow、taskCache.turns 剔除该轮、hintComposer('✕ 已取消排队消息')、loadTasksQuiet()；按钮样式对齐 .dsh-sendnow（警示红色调），busy 防重；权限语义与立即发送一致（前端展示、服务端 manage 裁决，403 透出提示）。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 排队气泡有「✕ 取消」，点击后气泡消失、本轮结束后不再补发
- [ ] #2 服务端 400/403 错误经 hintComposer 原样透出
- [ ] #3 build-standalone.sh 与 npm run smoke 通过（含内联脚本语法关卡）
- [ ] #4 与安卓端取消行为一致（两端同期交付）
<!-- AC:END -->

### 2026-11-12T11:27:21Z 派发为任务
task-faba998a · mode=chat · 成员=0

### 2026-11-12T11:28:50Z 派发执行（成功）
任务 task-faba998a · 结果=成功
服务端已准备就绪。现在开始进行 UI 修改 —— 包括 CSS、`syncQueuedUI` 以及取消处理程序：现在针对 `syncQueuedUI` 和取消 handler：已完成。改动全部落在 [src/web-ui.ts](src/web-ui.ts)，服务端 `POST /api/tasks/:id/queue/delete`（router.ts manage 门控）本就存在，无需改动：

**1. CSS（警示红色调，对齐 `.dsh-sendnow` 尺寸/圆角）**
- 新增 `.dsh-queued-cancel`：`--err`/`--err-light` 配色（与项目既有 danger 语义一致），hover/`disabled` 与 `.dsh-sendnow` 行为相同

**2. `syncQueuedUI`（[web-ui.ts:7947](src/web-ui.ts#L7947)）**
- 排队气泡在「⚡ 立即发送」旁追加「✕ 取消」按钮；旧节点清理选择器同步纳入 `.dsh-queued-cancel`

**3. 新增 `cancelQueuedTur
