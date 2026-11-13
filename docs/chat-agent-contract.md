# BOT 直聊硬绑定契约（task-93）

Android 和其他调用端通过 `create` 的 `mode:"chat"` 与 `chatAgentId` 明确建立 BOT 一对一直聊。服务端持久化绑定，首轮和后续轮次跳过规划，在该 BOT 的节点及会话上执行。绑定 BOT 离线、停用、缺失或远端调用失败时，执行失败；不会回退到主会话、主调度或其他 BOT。

## 创建与消息

REST 创建：`POST /api/tasks`。HTTP 工具、标准 MCP 与小智 MCP 使用 `workbuddy_task_manage` 的同名字段。

```json
{
  "action": "create",
  "mode": "chat",
  "chatAgentId": "agent-bot-a",
  "title": "与 BOT A 对话",
  "message": "你好"
}
```

REST 请求体去掉 `action`。`memberAgentIds` 可省略；如提供，必须为 `["agent-bot-a"]`。项目任务使用显式 `projectId`，工作区、文件权限继续遵循项目既有规则。`nodeRef` 描述任务上下文，不能替代绑定 BOT 的执行节点。

工具成功受理响应示例（示意，状态可能随异步执行变化；其他公共响应字段省略）：

```json
{
  "ok": true,
  "accepted": true,
  "taskId": "task-example",
  "mode": "chat",
  "chatAgentId": "agent-bot-a",
  "members": ["agent-bot-a"],
  "status": "running"
}
```

REST 创建返回 HTTP 201，任务位于 `data`，其中保存 `chatAgentId`。REST 列表摘要、任务详情和工具创建回执均可读取绑定。成功受理仅表示异步任务已接收；执行结果应继续查询任务状态和对话历史。

后续消息示例：

```json
{
  "action": "send",
  "taskId": "task-example",
  "message": "继续",
  "chatAgentId": "agent-bot-a",
  "mode": "chat"
}
```

REST 使用 `POST /api/tasks/task-example/messages`，请求体去掉 `action`、`taskId`。`chatAgentId` 和 `mode` 可以省略；提供时仅断言已保存的绑定/路由，不能修改它们。`memberAgentIds` 同样只能省略或包含绑定 BOT 唯一 ID。REST 保持可见任务才能发送消息的权限校验，无法访问的任务仍返回 404。

## 只读预检

```json
{
  "action": "preflight",
  "taskId": "task-example",
  "chatAgentId": "agent-bot-a",
  "message": "继续"
}
```

新任务预检省略 `taskId` 并显式提供 `mode:"chat"`。已有任务预检会检查输入断言及消息的显式路由；不能通过预检替旧任务增加绑定。硬绑定响应的核心字段如下：

```json
{
  "ok": true,
  "readOnly": true,
  "route": "agent-chat",
  "chatAgentId": "agent-bot-a",
  "roles": [{
    "id": "agent-bot-a",
    "name": "BOT A",
    "kind": "agent",
    "executionNode": {"kind": "mapping", "nodeId": "mapping:bot-node"},
    "online": false,
    "busy": null
  }],
  "roster": ["agent-bot-a"],
  "warnings": ["直聊 BOT agent-bot-a 离线（监控快照）；执行不可用时失败，不回退任务节点或其他 BOT"]
}
```

`roles` 表示本轮执行者或普通编排候选；`roster` 是已保存/拟创建的成员账本，不能据此推断发生了派工。`executionNode` 是 BOT 执行节点，`files.node` 是文件归属节点，两者可能不同。预检仅读取配置和已有监控快照，不 probe、不解析远端凭据、不调用规划器、不创建会话；未知在线状态返回 null，快照离线只产生警告。

## 迁移与拒绝边界

- 旧任务即使 `mode:"chat"` 且只有一个 `memberAgentIds`，也不会自动视为 BOT 硬绑定。继续沿用普通任务行为；需要直聊时新建任务。
- 新建时仅提供 `chatAgentId`、省略 `mode`，或提供 `mode:"orchestrate"`，均拒绝。
- send 或已有任务 preflight 不得给旧任务新增 `chatAgentId`，不得把已绑定 BOT 换为其他 ID。
- 绑定任务的 mode、成员、teamId、其他 BOT/专家/团队的显式 @ 路由冲突均拒绝；相同 BOT 的 @ 提及允许。已有绑定任务不能通过 @其他项目切换上下文。新建直聊使用 @项目时须与显式 `projectId` 一致。
- send 不支持 `nodeRef` / `projectId` 修改；调用端应新建任务。REST、HTTP 工具和 MCP 不会静默丢弃这些已知路由字段。
- REST PATCH/PUT 任务时，`chatAgentId` / `mode` 仅校验既有绑定，清除、增加或换绑均拒绝；路由校验在标题或成员写入之前完成。相同绑定的断言可与标题更新、合法成员更新一起提交，原有管理权限不变。
- 冲突在任务创建、消息排队、去重命中或远端执行前检查，返回 `ok:false`；参数冲突使用 `code:"INVALID_PARAM"`。REST 参数冲突返回 HTTP 400。被拒绝请求不会新增用户消息或启动执行。

## 验证范围

本地契约测试验证参数 schema、入口转发、拒绝边界、绑定预检、凭据隐藏及无执行副作用。模拟远端和本地协议测试只能证明协议行为；不能证明真实 DSH 加载了特定人格、预设或技能。真实人格/技能需要在对应 DSH 节点检查会话配置，并以独立的真实交互证据确认。硬绑定运行时严格检查远端模型/预设目录以及会话实际配置（包括工作目录）；旧 DSH 若缺少所需目录或会话详情字段，可能被拒绝执行，必须在真实联调中确认兼容性。Android 集成应显示任务保存的 `chatAgentId`，以任务状态区分“已受理”和“执行成功”，并把绑定不可用展示为失败，避免声称已自动改派。
