---
id: TASK-3
title: "看板拖拽改状态"
status: Done
assignee:
created_date: '2026-11-01T00:00:00Z'
updated_date: '2026-11-01T11:16:36Z'
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

### 2026-11-01T11:13:26Z 派发为任务
task-084a53e7 · mode=orchestrate · 成员=2

### 2026-11-01T11:16:36Z 派发执行（成功）
任务 task-084a53e7 · 结果=成功
服务端 PUT 功能已存在并带有冲突检测。现在我来查看 web-ui 中的前端看板。现在我来开始实现。首先修改 CSS：现在是看板的 HTML —— 卡片设置为可拖拽，列带有状态标记：现在我来添加辅助函数和拖拽委托：TASK-3 完成。改动全部在 [src/web-ui.ts](src/web-ui.ts)（服务端 `PUT …/backlog/items/:itemId` 与 `BacklogConflictError` 409 兜底本就存在，直接复用）：

**实现内容**
- **拖拽改状态**：看板卡片 `draggable` + 列 `data-st`，原生 `dragstart/dragover/drop` 事件委托挂在 `#bl-root`（重渲染不丢监听），不引入任何拖拽库。列顺序取 config.yml 的 `statuses`（原有 `blBoardHtml` 已按此渲染）。
- **乐观更新 + 回滚**：拖放后先改本地 `item.status` 并重渲染，随即 `PUT {prefix}/api/projects/:id/backlog/items/:item
