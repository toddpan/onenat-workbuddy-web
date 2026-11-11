---
id: task-93
title: '[P0] BOT 直聊执行者硬绑定：跳过规划并禁止静默回退'
status: Done
assignee:
created_date: '2026-11-08T14:28:38Z'
updated_date: '2026-11-08T14:38:56Z'
labels:
  - bot-entry-20261108
  - phase-1
  - bug
  - backend
  - task-session
  - integration-blocker
dependencies:
  - task-84
priority: High
ordinal: 93000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
来源：Android proj-1107rd0q/task-39 首期联调与只读代码审计发现的阻塞。现有 POST /api/tasks {mode:chat,memberAgentIds:[id],message} 被 engine.processUserMessage 强制改成 orchestrate；后续无ID send 会落 __node__/默认BOT；所选BOT目录离线而项目节点在线时还可能静默换执行者。仅稳定候选ID不能兑现用户一对一BOT入口。

请只实现本条平台修复，不修改Android源码（task-39正在并发联调），不自行派发其他待办，不部署正式服务，不修改签名/生产配置、不提交或覆盖已有改动。相邻Android验收运行实例冻结在其 out/task-39/platform-dist，本条改源代码后由宿主协调更新隔离实例，勿自行重启3990或操作模拟器。

采用显式新契约 chatAgentId（不可把旧memberAgentIds账本直接解释为直聊，以保留task-84已确认的旧语义）：新建 mode:chat + chatAgentId:id 时建立持久化的硬绑定，memberAgentIds可同时记录同一id。直聊分支在planner/主节点回退前，直接按该id调用BOT会话；绑定贯穿后续发送、排队、重启、角色/技能/模型/工作区。已有会话不允许通过send悄悄换绑定；普通无绑定任务、项目默认成员、多BOT编排和@委派保持兼容。mode/绑定/成员或显式路由意图冲突应明确拒绝，不能静默变成编排。

删除/停用/离线/目标不可解析时明确失败，禁止换planner或__node__；绑定会话显式模型或目录无效时也不能静默切为其他身份/模型/目录。项目文件归属与执行节点继续解耦，不改BOT全局workDir；任务/项目同节点workspace优先的既有明确上下文可保留，但须可观察且不退默认目录。

统一types/store/engine、REST create/messages、工具create/send、参数契约/schema和只读preflight：预检区分真正直聊绑定与编排候选，不创建任务/远端会话，不回传凭据。向宿主提供Android对接字段、响应、旧历史会话迁移/拒绝边界。

已定位：engine.ts createTask显式ID转sendUserMessage→processUserMessage单成员分支；router.ts /tasks/:id/messages只转message/teamId；task-preflight.ts route当前总是orchestrate。实现结束列出修改文件、真实测试和剩余真实DSH联调风险，不以mock证明人格/技能实际生效。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 显式chatAgentId直聊首轮直接执行所选稳定ID，无planner调用；旧ID-only/@/多BOT语义回归通过。
- [ ] #2 绑定持久化并贯穿REST/工具后续send、队列及重载，维持原taskId与项目快照；不匹配的绑定或成员输入拒绝且不产生执行副作用。
- [ ] #3 停用/删除/离线/不可解析BOT与显式无效模型/目录均清楚失败，无__node__/planner/默认身份静默回退，权限边界不扩大。
- [ ] #4 REST、工具参数契约和preflight一致，预检真实标明直聊绑定且只读，不返回凭据；提供Android接入契约。
- [ ] #5 新增确定性路由/远端请求/持久化/故障/兼容回归，构建类型检查和单测通过；区分本地协议测试与task-39待验的真实DSH/LLM。
<!-- AC:END -->

### 2026-11-08T14:29:52Z 派发为任务
task-10a25d2d · mode=chat · 成员=0

### 2026-11-08T14:38:56Z 派发执行（成功）
任务 task-10a25d2d · 结果=成功
我会先核对现有路由、持久化和远端会话创建逻辑，再实现 `chatAgentId` 硬绑定及回归测试。范围限定在平台源码、测试和接入文档；不操作 Android、3990 实例或正式服务。接口部分会遵循已加载的 `dsh-web-service` 技能，并加载工具契约相关技能。
工作区已有多项未提交改动，包含本条涉及的引擎和接口文件。我会在当前内容上做定点增量，保留这些改动。已确认旧的单成员 ID 输入会被转成显式委派并进入规划；新直聊分支需要在规划和主节点回退之前截获，并复用现有 BOT 会话机制。
硬绑定路由已加入引擎：首轮和后续消息都会直接解析所选 BOT，先于 planner 和主节点回退。接下来收紧会话创建中的模型、目录降级路径，并验证排队和重载后仍保留绑定；新旧契约的兼容测试正在并行补充。
现有单测已通过。直聊分支现在会校验显式模型和预设目录项，远端建会话失败时直接报错；配置了工作目录时，还会确认远端返回的实际 `cwd`。这些检查用于阻止无效配置被降级为默认配置，真实人格和技能效果仍需 DSH 联调验证。

