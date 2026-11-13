---
id: task-107
title: '[bug][P3] 配置只从 $HOME 读取：自定义 --dir 安装后 wb.mjs 读不到配置'
status: Backlog
assignee:
created_date: '2026-11-13T15:30:00Z'
updated_date: '2026-11-13T15:35:00Z'
labels:
  - bug
  - install-client
dependencies:
priority: Medium
ordinal: 107000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
一键安装脚本 `install-skill.sh` 支持 `--dir <目录>` 把技能装到任意目录（如团队共享目录、容器内路径），但配置文件恒写到 `$HOME/.workbuddy-skill.json`；CLI `wb.mjs` 的 `loadConfig()` 也**只从 `$HOME` 读**（`wbmcp.sh` 例外，它支持 `WORKBUDDY_CONFIG` 环境变量覆盖）。后果：

1. 用 `--dir` 装到非 HOME 位置、又不 export 环境变量时，`wb.mjs` 报「配置缺失」，只有 `wbmcp.sh`（设 `WORKBUDDY_CONFIG`）能工作——同一安装的两套客户端行为不一致。
2. 多人共享一台机器/同一 HOME 时，配置互相覆盖（token 属不同账号）。

**测试基线**：分支 `feat/exec-place-ux`，HEAD `bd7a51c6`；源文件 `scripts/install-skill.sh`、`skills/onenat-workbuddy/scripts/wb.mjs`、`skills/workbuddy-mcp/scripts/wbmcp.sh`。

## 现象

`HOME=/tmp/qa-no-home`（无配置）且不设 `WORKBUDDY_TOKEN` 时：`wb.mjs tools` → 「错误: 配置缺失」exit 1，提示只有两种解决方式（一键安装 / export 环境变量），没有「配置在某目录」的提示；而 `wbmcp.sh` 在同样条件下可用 `WORKBUDDY_CONFIG=/path/to/config` 工作。

## 复现步骤

1. `mkdir -p /tmp/qa-no-home && rm -f /tmp/qa-no-home/.workbuddy-skill.json`
2. `env -u WORKBUDDY_TOKEN HOME=/tmp/qa-no-home WORKBUDDY_BASE_URL=http://127.0.0.1:18461/onenat-workbuddy node .../wb.mjs tools` → 配置缺失
3. 对照：`env -u WORKBUDDY_TOKEN HOME=/tmp/qa-no-home WORKBUDDY_CONFIG=/path/to/.workbuddy-skill.json bash .../wbmcp.sh probe` → 正常

## 实际结果

`wb.mjs` exit 1「配置缺失」（2026-11-13 实测，见上方命令）；`wbmcp.sh` 支持 `WORKBUDDY_CONFIG` 覆盖（源文件第 21 行）。

## 期望结果

`wb.mjs` 与 `wbmcp.sh` 一致支持 `WORKBUDDY_CONFIG` 环境变量覆盖配置路径；或安装脚本在 `--dir` 非 HOME 时把配置也写到该目录并提示用户。

## 证据/日志

- 实测输出：`错误: 配置缺失 / 配置缺失。两种方式任选：... / exit=1`
- 源文件：`wb.mjs:22` `join(homedir(), '.workbuddy-skill.json')`（无 env 覆盖）；`wbmcp.sh:21` `CFG="${WORKBUDDY_CONFIG:-$HOME/.workbuddy-skill.json}"`
- 文件名核对结论（顺带）：安装脚本/CLI/MCP 三方一致为 `.workbuddy-skill.json`，无文案不一致问题（原疑点排除）

## 定位

`skills/onenat-workbuddy/scripts/wb.mjs` `loadConfig()`：加 `WORKBUDDY_CONFIG` 支持即可对齐 `wbmcp.sh`。

## 严重级别

P3（有环境变量 workaround，仅影响自定义 --dir 安装与多账号共享场景）

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `wb.mjs` 支持 `WORKBUDDY_CONFIG`（与 wbmcp.sh 同名同语义）
- [ ] #2 设 `WORKBUDDY_CONFIG` 后不 export token 也能连通
- [ ] #3 help 文案补充 `WORKBUDDY_CONFIG` 说明
<!-- AC:END -->
