---
id: task-85
title: '[P1] 统一任务结果读取契约，修复已完成任务聊天历史为空的体验'
status: Done
assignee:
created_date: '2026-11-08T11:41:28Z'
updated_date: '2026-11-08T12:58:41Z'
labels:
  - ai-ux-20261108
  - mcp
  - bug
  - task-session
  - reliability
dependencies:
priority: P1
ordinal: 85000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
来源：2026-11-08 AI 工具调用体验；复现任务 task-cafa75a0，已完成且回复 WB_AI_UX_20261108_OK。已核对现有 backlog，无同范围条目。

实测：wait、task_status 摘要及 full 中均可获得该任务回复，task_chat(taskId,subtaskId='__node__') 两次返回 ok:true、messages:[]。只传 taskId 则提示缺少 subtaskId；主会话读取需要知道特殊值 __node__。task_status 摘要将状态放在顶层，full 则返回 {ok,running,task}，调用方必须切换解析路径。

方案：固定公共响应字段（任务标识、状态、路由、摘要、裁剪标记）；主会话默认解析目标；区分平台消息账本与远端会话历史并返回 source。远端历史为空但平台已有回复时提供可解释回退，避免无解释的成功空数组。

定位：src/tool-ops.ts 的 taskStatus/taskChat，远端历史 client.getHistory 路径。当前仅证实读取结果不一致，不能据此断言消息丢失；需定位会话绑定、节点适配和历史读取原因。

保留已完成 task-54 的超大任务下载 URL 降级能力，不重复实现、不破坏其兼容性。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 定位 task-cafa75a0 或同等最小样例的远端历史为空原因，并提供明确的复现与修复证据。
- [ ] #2 wait、task_status、task_chat 对已完成纯文本任务均可获得回复，且返回结果来源可追溯。
- [ ] #3 主会话可仅凭 taskId 读取；多成员场景明确返回可选目标，不静默取错会话。
- [ ] #4 摘要、full、超大降级模式的公共字段位置稳定，并兼容既有调用方。
- [ ] #5 覆盖空会话、远端不可达、平台有回复但远端为空、内容裁剪及跨通道回归。
<!-- AC:END -->

### 2026-11-08T11:56:38Z 2026-11-08 BOT 历史需求复用与跨项目关联
BOT入口需求复用本项的指定任务结果/聊天记录读取契约，原任务范围、验收条件与优先级保持。
新增平台 task-90 负责按BOT/项目发现完整可见任务，边界与本项区分；Android proj-1107rd0q/task-36 和 task-40 负责历史UI和第二期联调。
跨入口均使用原taskId；Token消耗、最近7天记录或本机打开记录不能替代完整会话历史。
需求追踪标签：bot-entry-20261108。本次仅追加关联记录，没有派发执行。

### 2026-11-08T12:46:21Z 派发为任务
task-e8dc64cf · mode=chat · 成员=0

### 2026-11-08T12:58:41Z 派发执行（成功）
任务 task-e8dc64cf · 结果=成功
我会先沿任务会话绑定、远端历史读取和平台消息账本定位空历史的原因，再统一三个读取接口的公共字段与回退行为，并验证 task-54 的超大响应降级兼容性。这次会使用已加载的 dsh-web-service，以及 diagnosing-bugs 和 agent-experience 技能指导排查和工具契约修改。
工作区已有 task-84 的未提交改动，我会保留这些改动，只在相关读取逻辑上增量修复。目前确认 task_chat 要求显式指定目标，且远端返回空历史时会直接返回成功空数组；接下来会用最小回归样例锁定这个症状。
历史适配层已有一个红灯最小复现：上游返回 `{ok:true,data:{}}` 时，当前 getHistory 会把缺少消息字段解释为成功空历史。我们正在区分三种原因：协议形态未识别、绑定会话确实为空、分页信息被忽略；同时补充平台账本回退，避免调用方只收到无解释的空数组。当前另一个并行改动正在引入 schema 文件，暂时影响整包编译，我会保留该改动并在文件齐备后复验。
核心回归已通过：同一个已完成主会话，在 HTTP 和 MCP 两种调用上下文中，都能从 wait、s
