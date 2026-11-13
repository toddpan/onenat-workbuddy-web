# BOT 与项目双向关联（task-89）

项目 `defaultAgentIds` 是正式关系的唯一事实源，`expertIds` 是兼容输入/输出别名；同时传入时 canonical 优先（包括空数组），读取及写入去重。BOT 的 `sharedProjectIds` 保持既有显式授权字段，仅用于使用权限，不是正式关系的第二份副本。一次任务临时 @ BOT 不写项目关系。

启动迁移把旧项目 `expertIds` 补入 canonical，并将迁移前的默认成员授权保存到内部 `legacyAgentAccessIds`。该字段不接受项目 API 输入；新项目为空。新增关系不追加授权；解除关系移除对应旧授权；再次关联需要重新满足 BOT 可使用范围。既有 `sharedProjectIds` 显式授权独立保留。迁移不触碰任务，不更改 BOT 的全局工作目录。

默认成员仍作为项目任务候选继承，不作为自动全员派工命令；task-84 的显式 @、稳定 ID 和 preflight 规则继续适用。历史参与依据会话绑定、BOT 发言或编排子任务，单纯出现在默认候选账本中不计实际参与。尚未留下以上执行记录的历史意图不推断为参与。

## REST

以下均位于 `/onenat-workbuddy/api`：

| 方法 | 路径 | 含义 |
| --- | --- | --- |
| GET | `/projects/:projectId/agents` | 返回 linked 正式关系及 historical 未关联的实际历史参与者 |
| GET | `/agents/:agentId/projects` | 返回 linked 正式关联项目及 historical 未关联的实际参与项目 |
| PUT / DELETE | `/projects/:projectId/agents/:agentId` | 幂等添加/解除一条关系 |
| PUT / DELETE | `/agents/:agentId/projects/:projectId` | 同一操作的反向入口 |

响应遵循 `{ok,data}`；写入返回 `{projectId,agentId,linked,changed}`，重复添加或解除 `changed:false`。BOT 状态 available/disabled/deleted，项目状态 active/archived。删除 BOT 保留项目里的缺失 ID，便于查询 deleted 状态和后续解除；已有任务参与者快照保留。

新增关联查询需要控制台登录身份，无用户绑定的 AI 令牌/匿名服务上下文拒绝；仅返回调用者可见项目；BOT 反查还要求 BOT 可使用（已删除 BOT 仅在可见关系或可见任务中留有证据时可查）。历史任务按现有任务 ACL 筛选，不泄露隐藏任务计数。关联列表只提供 ID、名称及状态，不返回节点密钥、工作目录或提示词。

写入需要控制台登录身份、项目 owner/admin 管理权；添加还要求调用者在修改前已可使用 BOT。AI 令牌与只读通道不能执行新关联写入。归档项目只读，修改返回 409；不可见项目与不可使用 BOT 返回 404。已删除 BOT 不能添加，允许项目管理者解除残留 ID。

## 工具

- `workbuddy_project_manage`: `agents(projectId)`、`link_agent(projectId,agentId)`、`unlink_agent(projectId,agentId)`。
- `workbuddy_agent_manage`: `projects(agentId)`、`link_project(agentId,projectId)`、`unlink_project(agentId,projectId)`。

工具与 REST 复用同一服务及权限判定；原 project upsert 的 defaultAgentIds/expertIds 替换写法保留，并检查 BOT 可使用性。旧的整表替换语义为后写覆盖；并发编辑应使用上述单条增量入口，不使用先读数组再回传全量。增量入口的读取/校验/写入不含 await，在同一服务进程事件循环中串行，无丢失更新；当前 JSON store 不提供多服务进程共同写同一数据目录的保证。

关联不改变人类项目成员、文件 ACL、节点权限或 AI 令牌 scope。需要分工时继续使用 BOT 自身角色及现有团队合同，不新增重复角色模型。

## 验证边界

单测覆盖多对多、重复调用、Promise 并发增量操作、重启迁移、隐藏项目、非管理成员、不可使用 BOT、AI/只读拒绝、删除/解除/归档保留任务、仅候选与实际历史区分；本地 HTTP router 与工具契约交叉回查覆盖两端读写。真实设备和 Android UI 未验证，待 task-39/40 联调补验。本条未派发后续 backlog，未部署生产。
