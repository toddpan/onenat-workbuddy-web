---
name: onenat-workbuddy
description: OneNat WorkBuddy 多智能体工作台操作指南：任务会话管理（多轮聊天）、子智能体（绑定 ONENAT 上 DSH 实体，端口漂移免疫）、资源目录（SSH/DSH/HTTP 应用与技能）、主任务 LLM 编排派发。当用户提到 "WorkBuddy / 任务编排 / 子智能体 / 内网资源协同 / 多智能体协作" 时使用。
---

# OneNat WorkBuddy 工作台技能

你作为智能体可以通过以下 6 个工具操作 WorkBuddy 工作台，也可直接调用其 REST API（前缀 `/onenat-workbuddy`）。

## 核心概念

- **资源目录**：ONENAT 平台（隧道→映射→应用）是唯一资源实时来源。SSH 主机、DSH 实例、HTTP 应用都以
  `mappingId`（稳定 ID）标识；公网端口会随客户端重连漂移，WorkBuddy 在每次派发前实时解析，**任何地方都不要缓存公网 URL**。
- **子智能体**：绑定一个 DSH 实体（`dshRef: {kind:'mapping', mappingId}`），agentPreset/Provider/Model 支持「↻ 同步远端选项」一键拉取（`GET /api/agents/:id/presets` + `/models`）后下拉选择；`workDir`（可选，绝对路径）= 该成员远端会话的工作目录（cwd），编辑器「📁 浏览」可远端目录树选择（经 `GET /api/agents/fs/list` / `POST /api/agents/fs/mkdir`，对齐 DSH directory-picker-browse 交互：主目录/上级/新建文件夹/显示隐藏文件/截断提示），修改后远端会话自动重建；
  并可绑定若干**可用资源**（SSH/HTTP/DSH），其连接方式+凭证+技能文件会在派发时自动注入该子智能体的提示词。
- **任务会话**：每任务一个聊天窗口，多轮对话。挂 1 个成员 = chat 直通；挂多个成员 = orchestrate 编排
  （LLM Planner 拆解 → DAG 调度并发/串行 → 汇总结论）。

## 工具速查

| 工具 | 用途 |
|---|---|
| `workbuddy_resource_manage` | 资源目录: list / dsh（只列 DSH 算力节点）/ resolve / refresh |
| `workbuddy_agent_manage` | 子智能体: list / upsert / delete / ping / preview（资源提示词预览） |
| `workbuddy_task_manage` | 任务: list / create（可带首条消息立即发起）/ send（多轮发言）/ delete / members / cancel |
| `workbuddy_task_status` | 任务进度、计划、子任务日志、汇总 |
| `workbuddy_task_chat` | 查看子任务远端 DSH 完整聊天记录，或向远端会话追问 |
| `workbuddy_task_evaluate` | 刷新任务汇总报告 |
| `workbuddy_ssh_resource_manage` | 本地 SSH 资源池（ONENAT 之外直连主机）: list/get/upsert/delete/test/exec |

## 典型流程

1. **看资源**：`workbuddy_resource_manage {action:'dsh'}` 找 DSH 算力节点；`{action:'list'}` 看 SSH/HTTP 资源。
2. **建子智能体**：
   ```json
   workbuddy_agent_manage {"action":"upsert","agent":{
     "name":"136-执行者",
     "dshRef":{"kind":"mapping","mappingId":"<DSH 映射 ID>"},
     "agentPreset":"cordis",
     "systemPrompt":"你是核心执行工程师，负责……",
     "resources":[
       {"ref":{"kind":"mapping","mappingId":"<SSH 映射 ID>"},"alias":"db-hop","credentialMode":"self-fetch","skillMode":"all","note":"登录 136 查日志"}
     ]
   }}
   ```
   `credentialMode`: `self-fetch`（AI 凭 ONENAT 凭证接口自取，推荐）/ `inline`（写进提示词）/ `omit`；
   `skillMode`: `all`（技能全文内联）/ `none`（只给目录按需下载）。
3. **发起任务**：单成员直通——`workbuddy_task_manage {"action":"create","memberAgentIds":["agent-x"],"message":"排查 5xx"}`；
   多成员编排同理传多个成员，Planner 自动拆解派发。
4. **追问/监控**：`send` 多轮发言；`workbuddy_task_status` 看进度与日志；`workbuddy_task_chat` 看远端现场或追问。

## REST API（前缀 /onenat-workbuddy）

- `GET /api/resources`、`POST /api/resources/refresh`、`GET /api/resources/mappings/:id/resolve`
- `GET|POST /api/agents`、`DELETE /api/agents/:id`、`POST /api/agents/:id/ping`、`GET /api/agents/:id/models|presets|prompt-preview`
- `GET|POST /api/tasks`、`GET|DELETE|PATCH /api/tasks/:id`、`POST /api/tasks/:id/rename|archive|messages|cancel|summary`
- `POST /api/tasks/:id/attachments`（multipart，`files[]` 多文件）— 附件上传：逐成员 ensureSession 后经远端 `POST /sessions/:id/files` 落到其工作区，返回各成员的 `files[].path` 绝对路径；登记进 `task.attachments`
- `GET /api/tasks/:id/files/download?agent=<agentId>&path=<绝对或相对路径>` — 代理下载成员远端工作区文件；`path` 可直接用 AI 回复中的绝对路径（引擎会先取远端会话 cwd 换算为相对路径）
- 前端：聊天输入框 📎 附件按钮；agent 消息里的文件路径自动改写为 `📎 文件名` 全 URL 下载链接（代码块内不改写）
- 依赖：远端 DSH 需部署 `dsh-web-service ≥ 0.1.0`（files 三端点）
- `GET /api/tasks/:id/stream`（SSE: turn_start/turn_delta/turn_reasoning/turn_end/plan_update/subtask_status/log/task_end）
- `GET|POST /api/tasks/:id/subtasks/:sid/chat|followup`、`POST /api/tasks/:id/subtasks/:sid/retry`
- 控制台: `/onenat-workbuddy`（工作台聊天 / 子智能体 / 资源目录 / 编排看板 / 设置）

## 行为约定

1. 对 ONENAT 只读：不创建/修改/删除隧道或映射（接口也会拒绝）。
2. 派发前 WorkBuddy 会自动刷新资源；若成员节点离线，任务日志与结果会标明，不要反复重试离线节点。
3. 凭证敏感：不要把 API Key / SSH 密码写进无关输出；默认推荐 `self-fetch` 让子智能体按需自取。
4. 成员变更在下一轮消息生效；任务执行中不能变更成员或删除。
