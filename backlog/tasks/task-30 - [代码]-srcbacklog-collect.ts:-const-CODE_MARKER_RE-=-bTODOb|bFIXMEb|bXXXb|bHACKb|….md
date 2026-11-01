---
id: task-30
title: '[代码] src/backlog-collect.ts: const CODE_MARKER_RE = /\bTODO\b|\bFIXME\b|\bXXX\b|\bHACK\b|…'
status: To Do
assignee:
created_date: '2026-11-01T10:01:48Z'
updated_date: '2026-11-01T10:01:48Z'
labels:
  - auto-collect
  - source-code
  - todo
dependencies:
ordinal: 30000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
<!-- wb:source=code:b1c5dfa7cef3801c -->
由「未完成事项采集（工作区扫描）」自动登记：

- 文件：src/backlog-collect.ts（第 99 行）
- 命中标记：const CODE_MARKER_RE = /\bTODO\b|\bFIXME\b|\bXXX\b|\bHACK\b|待办|待补充|未完成/i
- 文件修改时间：2026-11-01 06:04 UTC
- 定位：项目工作区 → 右侧栏文件树 → `src/backlog-collect.ts`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 确认该处 TODO/FIXME 是否仍需处理（保留 / 删除标记 / 转成正式待办）
- [ ] #2 处理后同步删除或更新代码中的标记
<!-- AC:END -->
