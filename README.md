# OneNat WorkBuddy (@dsh-external/onenat-workbuddy)

> **基于 ONENAT 资源面 + 多 DSH 算力面的多智能体协作工作台**
> 任务多轮聊天（DSH WEB 同款体验）· 子智能体绑定 ONENAT 上的 DSH 实体（端口漂移免疫）·
> SSH/HTTP 资源连接方式与技能自动注入子智能体提示词 · LLM Planner 主任务拆解 + DAG 协同派发 + 汇总。

设计文档: `ngrok 仓库 docs/onenat-workbuddy-design.md`

## 架构一句话

```
浏览器(DSH Web GUI / 独立控制台)
   └─ WorkBuddy 插件(主控 DSH)
        ├─ ResourceDirectory ← ONENAT /api/v1/resources(唯一实时资源源, 稳定ID→实时端口)
        ├─ SubAgentPool      → 多个 DSH 实例(dsh-web-service API, 每次派发前实时解析入口)
        └─ TaskEngine        → chat 直通 / orchestrate(Planner→DAG→汇总), SSE 双跳推流
```

## 安装与注入

```bash
bash scripts/build.sh          # 或 dev_build_plugin
npm run build:client           # tsdown → lib/client.js
dev_inject_plugin {"dir": "/path/to/onenat-workbuddy"}
```

打开控制台：`http://127.0.0.1:3080/onenat-workbuddy`（DSH Web GUI 侧栏亦有「WorkBuddy」入口）。

## 配置

插件 Config（cordis）或控制台「设置」页：

| 项 | 默认 | 说明 |
|---|---|---|
| `onenatBaseUrl` | `https://onenat.sooncore.com` | ONENAT 服务地址（HTTPS 域名入口；旧 `http://123.57.138.43:18080` 已弃用） |
| `onenatApiKey` | 内置默认 | `onk-…` AI 只读 Key |
| `autoRefreshMs` | 60000 | 资源目录自动刷新间隔 |
| `planner.mode` | `auto` | LLM 规划器：auto=本地 DSH 优先；agent=指定子智能体节点 |

本地联调可用 mock ONENAT：`node scripts/mock-onenat.cjs`（127.0.0.1:18080，数据形状与真实 API 一致），
然后在设置里把 baseUrl 指向 `http://127.0.0.1:18080`、Key 填 `onk-mock-key-000`。

## 使用流

1. **资源目录**页确认 ONENAT 隧道/映射/应用在线（SSH / DSH / HTTP）。
2. **子智能体**页新建：从下拉选择 DSH 实体（稳定 ID 绑定）→ 配 preset/model/角色提示词 →
   绑定可用资源（SSH/HTTP/DSH，各配凭证策略 `self-fetch|inline|omit` 与技能策略 `all|none`）→ 提示词预览。
3. **工作台**新建任务：选 1 个成员=直通聊天；选多个=协同编排（LLM 拆解→DAG 派发→🎯汇总）。
4. 每个任务一个聊天窗口：流式输出/思维链折叠/工具调用过程（对齐 DSH ui-chat turn-process：工具行=名称+参数+结果+耗时）/停止按钮/输入框下方 composer 工具栏（成员 chips + 主调度模型下拉，对齐 DSH web 对话；主任务拆解由设置页指定的子智能体完成，模型仅作用于主调度）/附件逐文件上传进度面板（排队→上传中 N%→✓ 已上传（含落盘路径与成员同步数）/✗ 失败，XHR onprogress 实时）/多轮追问/成员增删/失败子任务重试。
5. **编排看板**看子任务泳道、工作日志、远端会话记录与追问。

## REST API（前缀 /onenat-workbuddy）

```
GET  /api/resources                POST /api/resources/refresh
GET  /api/resources/mappings/:id/resolve
GET|POST /api/agents               DELETE /api/agents/:id
                                   POST body 可含 workDir（绝对路径，远端会话工作目录，空串清除；非法路径 400）
POST /api/agents/:id/ping          GET /api/agents/:id/models|presets|prompt-preview
GET  /api/agents/fs/list           ?agent&path — 代理远端目录浏览（编辑器「📁 浏览」选工作目录用）
POST /api/agents/fs/mkdir          {agent,path,name} — 远端新建文件夹
GET|POST /api/settings
GET|POST /api/tasks                GET|DELETE|PATCH /api/tasks/:id
POST /api/tasks/:id/rename         {title}        — 重命名会话（对齐 DSH session.rename）
POST /api/tasks/:id/archive        {archived}     — 归档/取消归档（幂等，仅列表隐藏）
POST /api/tasks/:id/attachments    multipart      — 附件上传到各成员远端工作区（需远端 dsh-web-service ≥ 0.1.0）
GET  /api/tasks/:id/files/download ?agent&path    — 代理下载成员工作区文件（AI 回复中的路径可直接用）
POST /api/tasks/:id/messages|cancel|summary
GET  /api/planner/options         规划器子智能体列表 + 其节点模型可选项 + 当前生效配置
POST /api/planner/config          设置规划器子智能体（agentId，空=自动：本地子智能体优先）与主调度模型
GET  /api/tasks/:id/stream         (SSE: turn_start/turn_delta/turn_reasoning/turn_tool/turn_end/plan_update/subtask_status/log/task_status/task_end)
GET|POST /api/tasks/:id/subtasks/:sid/chat|followup   POST …/retry
GET|POST /api/ssh-resources        DELETE /api/ssh-resources/:id   POST …/test|exec
```

## 模型工具

`workbuddy_resource_manage` / `workbuddy_agent_manage` / `workbuddy_task_manage` /
`workbuddy_task_status` / `workbuddy_task_chat` / `workbuddy_task_evaluate` / `workbuddy_ssh_resource_manage`
（SKILL 见 `skills/onenat-workbuddy/SKILL.md`，装到 `~/.dsh/skills/` 后智能体自动掌握。）

## 设计要点（对应设计文档决策编号）

- **D1 端口漂移免疫**：子智能体只存 `mappingId/appId`；`AgentResolver` 每次派发前强刷 ONENAT 并解析当下入口，解析结果写入任务日志可审计。
- **D2 资源即提示词**：`PromptComposer` 把绑定资源的入口+凭证+技能全文合成 `[可用资源清单]` 块注入子任务指令前。
- **D3 会话长持**：`(任务,成员) → remoteSessionId` 持久复用，多轮即续聊。
- **D4 LLM Planner**：单条 user 消息携带 JSON 契约（dsh-web-service 会忽略 system 角色），失败回退静态三段。
- **D5 流式双跳+降级**：远端 prompt-stream SSE → 本地 SSE 网关；旧远端自动降级同步+轮询。
- **D6 零侵入**：不改 ONENAT 服务端、不改 dsh-web-service，单插件可整体卸载。

## 代码来源

以 `dsh-remote-orchestrator` 为基座重构升级；SSE/OpenAI 协议对齐 `dsh-web-service`；
资源解析规则对齐 ONENAT `onenat-skill.md` 实测语义。BSD-3-Clause。
