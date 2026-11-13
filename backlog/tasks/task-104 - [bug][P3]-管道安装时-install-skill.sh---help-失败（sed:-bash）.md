---
id: task-104
title: '[bug][P3] 管道安装时 install-skill.sh --help 失败（sed: bash）'
status: Backlog
assignee:
created_date: '2026-11-13T15:10:00Z'
updated_date: '2026-11-13T15:10:00Z'
labels:
  - bug
  - install-client
dependencies:
priority: Medium
ordinal: 104000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
安装客户端安装脚本 `scripts/install-skill.sh` 以管道方式安装（`curl ... | bash -s -- --help`）时 `--help` 失败：退出码 1，报 `sed: bash: No such file or directory`，不显示用法。

**测试基线**：仓库 `onenat-workbuddy-web` 分支 `feat/exec-place-ux`，HEAD `bd7a51c64def511441a02a147fc8978701758a46`；打包产物 `artifacts/backend-qa-20261113/onenat-workbuddy-web-2026.11.12.tgz`（版本 2026.11.12）。复现脚本：`artifacts/backend-qa-20261113/repro-client.mjs`（case "Piped installer --help"，需先启动 fixture 隔离服务）。

## 现象

`curl -fsSL <base>/install-skill.sh | bash -s -- --help` 退出 1，stderr：`sed: bash: No such file or directory`。

## 复现步骤

1. `node artifacts/backend-qa-20261113/fixture.mjs`（后台，端口 18461）
2. `curl -fsSL http://127.0.0.1:18461/onenat-workbuddy/install-skill.sh | bash -s -- --help; echo $?`
3. 或 `node artifacts/backend-qa-20261113/repro-client.mjs` 看 "Piped installer --help" 条目

## 实际结果

`{"code":1,"stdout":"","stderr":"sed: bash: No such file or directory\n"}`，bug: true。

## 期望结果

退出 0 并显示安装用法说明。

## 证据/日志

- `artifacts/backend-qa-20261113/install-help.log`
- `artifacts/backend-qa-20261113/client-bug-evidence.json`（case "Piped installer --help"）
- 后端报告：`artifacts/backend-qa-20261113/issue-install-help.md`

## 定位（后端工程师结论，待修复时复核）

根因在 `install-skill.sh:37` 附近：`-h|--help)` 分支用 `sed -n '2,27p' "$0"` 打印用法，但 `bash -s` 管道执行时 `$0` 是 `bash` 而非脚本路径，sed 找不到文件。QA 快照 `installed/node_modules/onenat-workbuddy-web/scripts/install-skill.sh` 与源文件 `scripts/install-skill.sh` 逐字节一致（diff 已验证），修源文件即可。建议改用 heredoc 内嵌用法文本，避免依赖 `$0`。

## 严重级别

P3（影响体验与自助排错，不阻断正式安装）

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `curl ... | bash -s -- --help` 退出 0 且输出用法
- [ ] #2 非管道方式 `bash install-skill.sh --help` 行为不变
- [ ] #3 `scripts/install-skill-regression.test.mjs`（或等价回归）通过
<!-- AC:END -->
