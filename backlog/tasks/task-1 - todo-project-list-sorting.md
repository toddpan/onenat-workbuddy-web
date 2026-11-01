---
id: TASK-1
title: 待办项目列表显示时按规则排序
status: "To Do"
assignee:
created_date: '2026-11-01'
updated_date: '2026-11-01'
labels:
  - ui
  - backlog
dependencies:
ordinal: 1000
---

## Description

待办项目列表在控制台显示时目前按创建/文件顺序罗列，需要按明确的规则排序后再展示（如：状态优先级 → 优先级 → 创建时间），保证高优先级与进行中的项目排在前面，前后端与移动端（≤768px）视图保持一致。

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 确定并实现待办项目列表的排序规则（状态 → 优先级 → 创建时间）
- [ ] #2 列表 API 与控制台前端展示均按排序规则输出
- [ ] #3 移动端（≤768px / X5 内核）视图排序一致
- [ ] #4 补充单测并 npm run smoke 通过
<!-- AC:END -->
