---
id: task-86
title: '[P1] 统一工具错误码与结构化恢复建议，准确区分缺参与不存在'
status: Done
assignee:
created_date: '2026-11-08T11:41:49Z'
updated_date: '2026-11-08T13:39:17Z'
labels:
  - ai-ux-20261108
  - mcp
  - reliability
  - error-contract
dependencies:
priority: P1
ordinal: 86000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
来源：2026-11-08 AI 工具调用体验，关联体验任务 task-cafa75a0；已核对现有 backlog，无同范围条目。

实测：project_manage {action:'get'} 漏传 projectId 时返回“项目不存在 / 404”，无法区分缺参和真实不存在；task_manage list 的非法 limit 返回 INVALID_PARAM，但其他错误只有中文文本，错误字段不统一。已有 paramWarnings 能准确识别未知或不适用参数，需保留。

方案：在执行前校验 action 必填字段；统一 code/message/field/retryable/retryAfterMs 等错误契约。将自然语言 nextAction 补充为机器可读下一步信息，供 AI 决定等待、修正参数或停止。明确禁止靠解析中文文本判断错误类别。

范围：服务端业务错误与恢复建议；脚本退出码已拆分为 task-83，不重复实现；不得削弱现有鉴权、防枚举或幂等保护。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 缺少 projectId、taskId 等必要参数返回字段级 INVALID_PARAM，不再误报对象不存在。
- [ ] #2 所有工具失败响应提供统一的 code、message、field（适用时）、retryable 和 retryAfterMs（适用时），保留必要兼容字段。
- [ ] #3 区分权限不足、节点离线、会话过期、对象不存在、参数错误和执行失败，覆盖 HTTP 与 MCP 回归。
- [ ] #4 轮询或可恢复错误提供结构化下一步调用信息；调用方无需解析中文描述即可决定修正、等待或停止。
- [ ] #5 不泄露凭据；不把不可重试写操作标为可自动重试，保留既有去重和 taskCreated 防重复执行语义。
<!-- AC:END -->

### 2026-11-08T13:26:00Z 派发为任务
task-30a06409 · mode=chat · 成员=0

### 2026-11-08T13:39:17Z 派发执行（成功）
任务 task-30a06409 · 结果=成功
我会先检查工具分发、HTTP/MCP 错误出口和现有回归测试，再落实统一错误契约与结构化恢复建议，并验证缺参、鉴权和重复执行保护。
工作区已有其他任务的未提交改动，其中包含共享参数校验。我会在这些改动上增量实现，保留现有参数警告，并使用已加载的 agent-experience 技能检查机器可读恢复信息的设计。
参数校验已覆盖多数 action 的必填字段，但错误出口分散，使用了不同的错误码和字段。接下来会在共享出口统一契约，在业务分支明确标记错误类别；对隐藏对象继续返回“不存在”，保留防枚举行为。
核心错误契约和通道层已接通：失败响应会补齐 `code/message/retryable/recovery`，并保留兼容的 `error` 字段。远端调用也开始保留 HTTP 状态和结构化错误码；写操作失败默认不可自动重试，已有任务回执则引导调用方查询状态或重试回写。
错误契约相关回归已通过，包括 HTTP/MCP 缺参区分、隐藏对象保护、超限回执和写操作幂等回放。全量单测也已通过。常规 smoke 首次失败是因为并行任务新增了第 17 个工具，而脚本仍固定断言 16 个；已保留核心工具
