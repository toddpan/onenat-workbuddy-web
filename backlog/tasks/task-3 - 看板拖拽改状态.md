---
id: TASK-3
title: "看板拖拽改状态"
status: "To Do"
assignee:
created_date: '2026-11-01T00:00:00Z'
updated_date: '2026-11-01T00:00:00Z'
labels:
  - "backlog"
  - "ui"
dependencies:
priority: "medium"
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
设计文档 §8/§9 一再把「拖拽改状态」后置，但落地成本其实很低：拖完调一次 `PUT {prefix}/api/projects/:id/backlog/items/:itemId`（body 带 status）即可，服务端已有乐观冲突检测（BacklogConflictError）兜底。

目标：项目待办看板支持把卡片在列间拖拽直接改 status，列顺序取 config.yml 的 statuses。

实现约束：
- 写入失败（尤其 BacklogConflictError）必须 toast 提示「内容已被他人更新，请刷新」并保持原状，绝不静默覆盖；
- 拖拽后可先行乐观更新 UI，请求返回再落定/回滚；
- 移动端 ≤768px 与微信 X5 不启用拖拽（保持现有点击进抽屉编辑），避免误触与事件兼容坑；
- 不引入拖拽库：优先原生 dragstart/dragover/drop（如需触屏另议，不在本任务范围）。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 桌面端把卡片拖到另一列后，条目 frontmatter 的 status 被正确更新（刷新列表可见）
- [ ] #2 并发冲突时提示刷新且服务端内容未被覆盖
- [ ] #3 移动端不出现拖拽交互，原有点击编辑抽屉行为不变
- [ ] #4 npm run build 与 npm run smoke 通过
<!-- AC:END -->
