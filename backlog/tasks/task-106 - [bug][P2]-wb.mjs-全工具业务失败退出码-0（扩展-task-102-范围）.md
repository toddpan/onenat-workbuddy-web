---
id: task-106
title: '[bug][P2] wb.mjs 全工具业务失败退出码 0（扩展 task-102 范围）'
status: Backlog
assignee:
created_date: '2026-11-13T15:30:00Z'
updated_date: '2026-11-13T15:30:00Z'
labels:
  - bug
  - install-client
dependencies:
  - task-102
priority: High
ordinal: 106000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
task-102 报告的业务失败退出码 0 问题不止 project/task/expert 查询：自由测试证实 **wb.mjs 所有工具命令**的业务失败（`result.ok=false`）都返回退出码 0。修复 task-102 的 `tool()` 下钻 `result.ok` 后应一并覆盖下列全部场景，本条作为回归覆盖清单。

**测试基线**：分支 `feat/exec-place-ux`，HEAD `bd7a51c6`；产物 `artifacts/backend-qa-20261113/onenat-workbuddy-web-2026.11.12.tgz`。自由测试脚本 `artifacts/test-qa-20261113/free-test.mjs`（case C1–C10），fixture 隔离服务 18461/18462。

## 现象

以下命令业务失败时退出码均为 0（期望非 0），且响应信封是 `{ok:true, tool, result:{ok:false, code:'NOT_FOUND'|'INVALID_PARAM', ...}}`——外层 ok 恒为 true，CLI 只看外层所以全 0：

| 命令 | 服务端 result.code |
|---|---|
| `task status --id qa-missing-task` | NOT_FOUND（任务不存在） |
| `expert get --id qa-missing-expert` | NOT_FOUND（专家不存在） |
| `schedule get --id qa-missing-schedule` | NOT_FOUND |
| `file download --agent qa-node --path 不存在` | NOT_FOUND（子智能体不存在） |
| `file list --agent qa-node --path /no-such-dir` | NOT_FOUND |
| `resource resolve --mapping qa-missing-mapping` | NOT_FOUND |
| `agent ping --id qa-missing-agent` | NOT_FOUND |
| `backlog list --project qa-missing-project` | NOT_FOUND |
| `task chat --id qa-missing-task --sub x` | NOT_FOUND |
| `agent upsert`（缺 --json） | INVALID_PARAM（agent/name/dshRef 必填） |

## 复现步骤

1. `node artifacts/backend-qa-20261113/fixture.mjs`（后台）
2. `node artifacts/test-qa-20261113/free-test.mjs` 看 C1–C10（当前均 FAIL，即复现成功）
3. 或手工：`WORKBUDDY_BASE_URL=http://127.0.0.1:18461/onenat-workbuddy WORKBUDDY_TOKEN=qa-disposable-token-20261113 node clients/.../wb.mjs task status --id qa-missing-task; echo $?` → 0

## 实际结果

上表 10 个场景全部 exit 0，stdout 打印完整业务失败 JSON（含 code/error/recovery）。

## 期望结果

业务失败（`result.ok===false`）时退出非 0（建议 2），stdout 仍打印 JSON 供脚本解析。

## 证据/日志

- `artifacts/test-qa-20261113/free-test-evidence.json`（C1–C10 明细）
- 实测 stdout：`result.ok:false, code:NOT_FOUND`，外层 `ok:true`

## 定位

同 task-102：`wb.mjs` `tool()` 函数（源文件 `skills/onenat-workbuddy/scripts/wb.mjs`）只看外层信封。修复一处即覆盖全部场景；注意 `agent upsert` 缺参属 INVALID_PARAM 而非 NOT_FOUND，两者都应非 0。

## 严重级别

P2（与 task-102 同级；自动化/Agent 对所有失败都会误判成功）

## Acceptance Criteria

<!-- AC:BEGIN -->
- [ ] #1 `node artifacts/test-qa-20261113/free-test.mjs` 中 C1–C10 全部 PASS（退出码 2）
- [ ] #2 task-102 的 repro-client.mjs --assert-no-bugs 通过
- [ ] #3 MCP 通道行为不变（E4 仍为 1）
- [ ] #4 npm run typecheck 与相关回归通过
<!-- AC:END -->
