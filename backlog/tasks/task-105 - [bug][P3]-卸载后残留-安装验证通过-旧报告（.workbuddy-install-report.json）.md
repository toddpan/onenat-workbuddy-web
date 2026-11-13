---
id: task-105
title: '[bug][P3] 卸载后残留「安装验证通过」旧报告（.workbuddy-install-report.json）'
status: Backlog
assignee:
created_date: '2026-11-13T15:10:00Z'
updated_date: '2026-11-13T15:10:00Z'
labels:
  - bug
  - install-client
dependencies:
priority: Medium
ordinal: 105000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
安装客户端执行 `install-skill.sh --uninstall` 后，技能目录与配置（`.workbuddy-skill.json`）都删除了，但安装报告 `.workbuddy-install-report.json` 仍保留，且内容还是 `filesInstalled: true / verified: true`，会误导后来的人或 AI 认为客户端仍处于已安装已验证状态。

**测试基线**：仓库 `onenat-workbuddy-web` 分支 `feat/exec-place-ux`，HEAD `bd7a51c64def511441a02a147fc8978701758a46`；打包产物 `artifacts/backend-qa-20261113/onenat-workbuddy-web-2026.11.12.tgz`（版本 2026.11.12）。复现脚本：`artifacts/backend-qa-20261113/repro-client.mjs`（case "Uninstall stale verified report"，需先启动 fixture 隔离服务并存在一次安装产物 `client-runtime/`）。

## 现象

卸载后 `.workbuddy-install-report.json` 依然存在，`filesInstalled:true`、`http:"passed"`、`mcp` 全 passed、`verified:true`。

## 复现步骤

1. `node artifacts/backend-qa-20261113/fixture.mjs`（后台，端口 18461/18462）
2. `node artifacts/backend-qa-20261113/repro-client.mjs` 看 "Uninstall stale verified report" 条目
3. 或手工：`HOME=<临时目录> bash installed/node_modules/onenat-workbuddy-web/scripts/install-skill.sh --uninstall` 后检查 `$HOME/.workbuddy-install-report.json`

## 实际结果

`exit: 0`，`httpInstalled:false`，`mcpInstalled:false`，`configExists:false`，`reportExists:true`，`staleReport.verified:true`，bug: true。

## 期望结果

卸载时删除安装报告，或将 `filesInstalled` 与 `verified` 置为 false。

## 证据/日志

- `artifacts/backend-qa-20261113/client-bug-evidence.json`（case "Uninstall stale verified report"，staleReport 全文）
- `artifacts/backend-qa-20261113/uninstall-home/`（卸载后的临时 HOME，含残留报告）
- 后端报告：`artifacts/backend-qa-20261113/issue-uninstall-report.md`

## 定位（后端工程师结论，待修复时复核）

根因在 `install-skill.sh:58` 附近卸载分支：`rm -f "$CFG"` 只删了配置，没有处理 `$HOME/.workbuddy-install-report.json`。QA 快照 `installed/node_modules/onenat-workbuddy-web/scripts/install-skill.sh` 与源文件 `scripts/install-skill.sh` 逐字节一致（diff 已验证），修源文件即可。

## 严重级别

P3（状态误导，不影响功能）

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 卸载后 `.workbuddy-install-report.json` 不存在，或 `filesInstalled:false && verified:false`
- [ ] #2 重新安装后报告恢复 `verified:true`
- [ ] #3 `scripts/install-skill-regression.test.mjs`（或等价回归）通过
<!-- AC:END -->
