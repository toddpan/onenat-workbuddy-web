---
id: task-101
title: '[feature] 任务会话聊天框中 AI 回复显示其使用的模型'
status: Done
assignee:
created_date: '2026-11-12T11:32:38Z'
updated_date: '2026-11-12T15:01:19Z'
labels:
  - feature
  - task-session
  - ui
dependencies:
priority: Medium
ordinal: 101000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
任务会话聊天界面：AI 返回的消息需显示该轮回复实际使用的模型（provider/model，如 deepseek/deepseek-v3、zai-coding-cn/glm-5.3）。编排任务里不同子任务/成员可能用不同模型，需按消息粒度标注。实现路径：任务引擎/聊天存储与 task chat API 为每条 assistant 消息携带模型信息；前端渲染在消息气泡上（发送者名旁小字或角标）。历史消息缺模型信息时兼容渲染不报错。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 每条 AI 回复气泡显示该次执行实际使用的 provider/model
- [x] #2 编排任务中不同成员（不同模型）的回复各自显示自己的模型
- [x] #3 历史消息（无模型字段）兼容渲染，不报错不显示乱码
- [x] #4 REST API 返回的消息体带模型字段；npm run typecheck 与 npm run smoke 通过

### 2026-11-12 实现记录
- `TaskTurn.model` / `PlanSubtask.model`：回合/子任务收尾时从远端会话详情（GET /sessions/:id 的 model.selected，3s 超时 best-effort）回填 provider/model；拿不到时回退成员实体自带 provider/model。
- SSE `turn_end` 事件随完整 turn 对象携带 model，前端实时刷新。
- REST：GET /api/tasks/:id 的 turns、/api/tasks/:id/subtasks/:sid/chat 的 assistant 消息均带 `model` 字段（远端 history 不带模型时按子任务记录补齐，缺记录不编造）。
- 前端：消息气泡发送者名旁角标优先显示 `turn.model`；历史消息缺字段时回退推断（主智能体=当前选中模型、子智能体=实体配置），无配置时不显示乱码；`applyModelBadge` 幂等。
- 回归：`npm run test:model-badge`（3 项）；npm run typecheck、npm run smoke（94 项）通过。
<!-- AC:END -->

### 2026-11-12T14:53:42Z 派发为任务
task-307ea0e1 · mode=chat · 成员=0

### 2026-11-12T15:01:19Z 派发执行（成功）
任务 task-307ea0e1 · 结果=成功
我已经了解整体情况了。现在我来实现，包括：在 turns/subtasks 中记录实际的会话模型，通过 API 透传，并在 UI 中进行渲染。现在是引擎辅助程序和两个调用点：现在我来修改 `router.ts`，在子任务聊天消息中标注模型：现在处理前端。首先是 `buildTurnElement` badge ——优先使用实际的 `turn.model`：现在开始构建、类型检查和冒烟测试：所有检查均已通过。我来通过 `mock ONENAT` 添加一个快速回归测试，验证 `model` 字段的端到端流程，遵循现有的 `e2e` 模式：所有测试已通过。注册该脚本并更新待办事项的验收状态：完成。task-101「AI 回复显示其使用的模型」已实现并全部验证通过。

## 改动摘要

**数据与引擎**（[src/types.ts](src/types.ts)、[src/engine.ts](src/engine.ts#L2065)）
- `TaskTurn.model` / `PlanSubtask.model` 新增字段：回合/子任务收尾时调用新私有方法 `resolveUsedMode
