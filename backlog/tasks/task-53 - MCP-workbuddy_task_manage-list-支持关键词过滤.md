---
id: task-53
title: MCP workbuddy_task_manage list 支持关键词过滤
status: Done
assignee:
created_date: '2026-11-06T00:34:38Z'
updated_date: '2026-11-06T00:41:52Z'
labels:
  - mcp
  - search
  - backlog
dependencies:
priority: Medium
ordinal: 53000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
现状：src/tool-ops.ts workbuddy_task_manage 的 list action（约 L321-332）直接返回 store.getTasks() 全量列表，参数表里没有 keyword/search 字段，外部智能体无法按关键词筛选任务，任务多时回包膨胀且要自己过滤。需求：list 增加 keyword（可选）参数，对任务 id/title 做包含匹配（大小写不敏感，可扩展匹配消息正文），命中才返回；参数描述与工具 description 同步更新；补单测（命中/不命中/无 keyword 时行为不变）。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 list 支持 keyword 参数并对 id/title 过滤
- [ ] #2 无 keyword 时返回全部任务（向后兼容）
- [ ] #3 tool-ops 有对应单测且 npm run typecheck 通过
<!-- AC:END -->
