---
id: task-102
title: '[bug][P2] HTTP CLI wb.mjs 业务失败仍返回退出码 0'
status: Backlog
assignee:
created_date: '2026-11-13T15:10:00Z'
updated_date: '2026-11-13T15:10:00Z'
labels:
  - bug
  - install-client
dependencies:
priority: High
ordinal: 102000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
安装客户端（HTTP 通道 `skills/onenat-workbuddy/scripts/wb.mjs`）在业务操作失败时仍返回退出码 0，与 MCP 通道（`wbmcp.sh` 正确返回 1）行为不一致。自动化脚本/Agent 会误判调用成功。

**测试基线**：仓库 `onenat-workbuddy-web` 分支 `feat/exec-place-ux`，HEAD `bd7a51c64def511441a02a147fc8978701758a46`；打包产物 `artifacts/backend-qa-20261113/onenat-workbuddy-web-2026.11.12.tgz`（版本 2026.11.12）。复现脚本：`artifacts/backend-qa-20261113/repro-client.mjs`（需先启动 `artifacts/backend-qa-20261113/fixture.mjs` 隔离服务）。

## 现象

对不存在的对象执行 `wb.mjs project get --id qa-missing-project`（task/expert 查询同理），服务端返回 `{ok:false, code:'NOT_FOUND'}`，CLI 退出码却是 0；MCP 客户端同一操作退出码 1。

## 复现步骤

1. `node artifacts/backend-qa-20261113/fixture.mjs`（后台，端口 18461/18462）
2. `node artifacts/backend-qa-20261113/repro-client.mjs`
3. 或手工：`WORKBUDDY_BASE_URL=http://127.0.0.1:18461/onenat-workbuddy WORKBUDDY_TOKEN=qa-disposable-token-20261113 node artifacts/backend-qa-20261113/clients/onenat-workbuddy/scripts/wb.mjs project get --id qa-missing-project; echo $?`

## 实际结果

连续 2 次：`httpExit: 0`，`businessOk: false`，`businessCode: 'NOT_FOUND'`；对照 `mcpExit: 1`。`--assert-no-bugs` 模式断言失败（bug: true）。

## 期望结果

业务失败（`result.ok === false`）时 HTTP CLI 返回非 0 退出码，与 MCP 通道一致。

## 证据/日志

- `artifacts/backend-qa-20261113/client-bug-evidence.json`（2026-11-13 实测）
- 复现脚本输出：case "HTTP CLI business failure exit"，repeat 1/2 均 `{"httpExit":0,"mcpExit":1,"bug":true}`
- 后端报告：`artifacts/backend-qa-20261113/issue-http-exit.md`

## 定位（后端工程师结论，待修复时复核）

根因在 `wb.mjs:86` 附近 `tool()` 只检查外层信封 `json.ok`，未下钻 `result.ok`；而下载路径 `wb.mjs:251` 直接读顶层字段，实际结构是 `{ok, tool, result}` 信封。QA 快照 `clients/onenat-workbuddy/scripts/wb.mjs` 与源文件 `skills/onenat-workbuddy/scripts/wb.mjs` 逐字节一致（diff 已验证），修源文件即可。

## 严重级别

P2（直接影响脚本/自动化调用）

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `node repro-client.mjs --assert-no-bugs` 退出 0（业务失败退出码非 0）
- [ ] #2 MCP 通道退出码行为保持不变
- [ ] #3 `npm run typecheck` 与相关回归通过
<!-- AC:END -->
