---
id: task-9
title: backlog 待办管理接入 MCP/工具通道（第 16 个工具）并线上验证
status: Done
assignee:
created_date: '2026-11-01T03:54:18Z'
updated_date: '2026-11-01T03:54:18Z'
labels:
  - backlog
  - mcp
  - deploy
dependencies:
priority: High
ordinal: 9000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
把平台 backlog 待办暴露为 MCP 工具 workbuddy_backlog_manage（HTTP 工具通道 /api/tools 与 MCP /mcp 同源），
AI 可通过 12 个 action 管理待办：projects / config / init / list / search / view / create / edit / delete / dispatch / overview / retry-writeback。

实现要点：dispatch 建的就是普通 WorkBuddy 任务（继承项目节点/工作区/成员/技能）并由终态自动回写；
数据层加固验收清单勾选保留、追加零丢字、写失败回滚、重复 init 幂等；派发失败用 WRITEBACK_FAILED+taskCreated 防重复建任务。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
<!-- AC:END -->

### 2026-11-01T03:54:18Z 上线验证（2026-11-01）
提交 2d1708a（backlog MCP）+ 9c71731（部署脚本同步 skills/）已推送 feat/exec-place-ux
本地：typecheck/build 通过；unit 112；smoke 79；smoke:backlog 57；smoke:mcp 28；smoke:ai 43；smoke:xiaozhi 32 全绿
线上：11:50:48 等 running=0 后重启激活，部署后自检 15/15 通过（16 工具 / MCP / backlog 只读 22 项目 / 静态技能资源）
线上旁路实例验证 21/21（真实数据副本 + 真实 DSH 节点，含写路径 init→create→edit→delete）
