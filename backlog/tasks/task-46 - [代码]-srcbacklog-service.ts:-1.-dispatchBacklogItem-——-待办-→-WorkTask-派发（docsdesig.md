---
id: task-46
title: '[代码] src/backlog-service.ts: 1. dispatchBacklogItem —— 待办 → WorkTask 派发（docs/design-backl…'
status: To Do
assignee:
created_date: '2026-11-01T10:05:08Z'
updated_date: '2026-11-01T10:05:08Z'
labels:
  - auto-collect
  - source-code
  - todo
dependencies:
ordinal: 46000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
<!-- wb:source=code:68d5cc1a44be983b -->
由「未完成事项采集（工作区扫描）」自动登记：

- 文件：src/backlog-service.ts（第 5 行）
- 命中标记：1. dispatchBacklogItem —— 待办 → WorkTask 派发（docs/design-backlog-integration.md §6.1）
- 文件修改时间：2026-11-01 03:13 UTC
- 定位：项目工作区 → 右侧栏文件树 → `src/backlog-service.ts`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 确认该处 TODO/FIXME 是否仍需处理（保留 / 删除标记 / 转成正式待办）
- [ ] #2 处理后同步删除或更新代码中的标记
<!-- AC:END -->
