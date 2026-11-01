---
id: task-10
title: 修复 KnewLab 项目（proj-75wwwck5）DSH 节点 API Key 失效
status: To Do
assignee:
created_date: '2026-11-01T03:54:18Z'
updated_date: '2026-11-01T03:54:18Z'
labels:
  - ops
  - bug
dependencies:
ordinal: 10000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
线上 backlog overview 失败隔离暴露出：项目 proj-75wwwck5（KnewLab，workspace /data/panzj/KnewLab）绑定的 DSH 节点
返回 `Unauthorized: Invalid or missing API key`，导致该项目 backlog 无法读取（其它项目正常，隔离生效）。

需要在节点侧核对/轮换该映射的实例凭据（ONENAT 映射的 credentials），或改绑到正常节点后复验；
复验方式：{action:"overview"} 中该项目 nodeStatus 应为 ok，且 {action:"list", projectId:"proj-75wwwck5"} 可读。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 节点凭据修复后 overview 中 proj-75wwwck5 的 nodeStatus=ok
- [ ] #2 backlog list 可正常读取该项目待办
<!-- AC:END -->
