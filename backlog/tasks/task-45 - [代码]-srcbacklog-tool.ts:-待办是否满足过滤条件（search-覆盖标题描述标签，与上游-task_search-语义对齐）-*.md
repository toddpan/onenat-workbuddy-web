---
id: task-45
title: '[代码] src/backlog-tool.ts: 待办是否满足过滤条件（search 覆盖标题/描述/标签，与上游 task_search 语义对齐） */'
status: To Do
assignee:
created_date: '2026-11-01T10:05:08Z'
updated_date: '2026-11-01T10:05:08Z'
labels:
  - auto-collect
  - source-code
  - todo
dependencies:
ordinal: 45000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
<!-- wb:source=code:58e7b41114f2747e -->
由「未完成事项采集（工作区扫描）」自动登记：

- 文件：src/backlog-tool.ts（第 162 行）
- 命中标记：待办是否满足过滤条件（search 覆盖标题/描述/标签，与上游 task_search 语义对齐） */
- 文件修改时间：2026-11-01 03:17 UTC
- 定位：项目工作区 → 右侧栏文件树 → `src/backlog-tool.ts`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 确认该处 TODO/FIXME 是否仍需处理（保留 / 删除标记 / 转成正式待办）
- [ ] #2 处理后同步删除或更新代码中的标记
<!-- AC:END -->
