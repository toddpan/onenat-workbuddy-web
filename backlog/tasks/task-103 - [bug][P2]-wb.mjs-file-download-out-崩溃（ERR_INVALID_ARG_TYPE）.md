---
id: task-103
title: '[bug][P2] wb.mjs file download --out 崩溃（ERR_INVALID_ARG_TYPE）'
status: Backlog
assignee:
created_date: '2026-11-13T15:10:00Z'
updated_date: '2026-11-13T15:10:00Z'
labels:
  - bug
  - install-client
dependencies:
priority: High
ordinal: 103000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
安装客户端（HTTP 通道 `skills/onenat-workbuddy/scripts/wb.mjs`）执行 `file download --out <file>` 时抛 `TypeError [ERR_INVALID_ARG_TYPE]` 崩溃，不生成文件，退出码 1。服务端本身完全正常。

**测试基线**：仓库 `onenat-workbuddy-web` 分支 `feat/exec-place-ux`，HEAD `bd7a51c64def511441a02a147fc8978701758a46`；打包产物 `artifacts/backend-qa-20261113/onenat-workbuddy-web-2026.11.12.tgz`（版本 2026.11.12）。复现脚本：`artifacts/backend-qa-20261113/repro-download.mjs`（需先启动 `artifacts/backend-qa-20261113/fixture.mjs` 隔离服务）。

## 现象

`wb.mjs file download --agent <id> --path /qa/project/qa-download.txt --out qa-downloaded.txt` 连续 2 次均抛错：`错误: TypeError [ERR_INVALID_ARG_TYPE]: The first argument must be of type string or an instance of Buffer... Received undefined`（栈指向 `wb.mjs:254` `Buffer.from`）。

## 复现步骤

1. `node artifacts/backend-qa-20261113/fixture.mjs`（后台，端口 18461/18462）
2. `node artifacts/backend-qa-20261113/repro-download.mjs`
3. 或手工：先经 `workbuddy_file_manage` upload 一个文件，再 `WORKBUDDY_BASE_URL=http://127.0.0.1:18461/onenat-workbuddy WORKBUDDY_TOKEN=qa-disposable-token-20261113 node .../clients/onenat-workbuddy/scripts/wb.mjs file download --agent <id> --path /qa/project/qa-download.txt --out /tmp/qa.txt; echo $?`

## 实际结果

连续 2 次：`serverSuccess: true`（服务端返回内容正确，`serverContent: "QA download bytes\n"`），CLI `cliExit: 1`，`fileContent: null`（文件未生成），stderr 为上述 `ERR_INVALID_ARG_TYPE`。`--assert-no-bugs` 断言失败（bug: true）。

## 期望结果

退出 0 并保存与服务端返回完全一致的 18 字节内容。

## 证据/日志

- `artifacts/backend-qa-20261113/file-download-evidence-repeat.json`（2026-11-13 实测）
- 复现脚本输出：repeat 1/2 均 `{"serverSuccess":true,"cliExit":1,"fileContent":null,"bug":true}`
- 后端报告：`artifacts/backend-qa-20261113/issue-http-download.md`

## 定位（后端工程师结论，待修复时复核）

根因在 `wb.mjs:251` 附近 download 分支：`Buffer.from(json.content, ...)` 读了顶层字段，实际响应是 `{ok, tool, result}` 信封，`json.content` 为 undefined。QA 快照与源文件 `skills/onenat-workbuddy/scripts/wb.mjs` 逐字节一致（diff 已验证），修源文件即可。注意与 task-102 同文件，可一并修复。

## 严重级别

P2（直接影响脚本调用，下载功能完全不可用）

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `node repro-download.mjs --assert-no-bugs` 退出 0（2 次均保存正确 18 字节）
- [ ] #2 下载失败（404 等）时给出可读错误且退出非 0，不抛 TypeError
- [ ] #3 `npm run typecheck` 与相关回归通过
<!-- AC:END -->
