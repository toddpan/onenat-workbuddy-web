---
name: onenat-workbuddy
description: OneNat WorkBuddy 多智能体工作台 AI 管理技能：读取监控大屏态势、创建任务并指定子智能体执行、等任务结果、管理文件（上传/下载/远端工作区）、管理子智能体（增删改/启停/探活）、管理定时任务、指定主调度（拆解智能体与模型）、查看资源目录。当用户提到 "WorkBuddy / 监控大屏 / 发任务给智能体 / 子智能体管理 / 定时任务 / 多智能体协作" 时使用。
---

# OneNat WorkBuddy 工作台技能（v2）

你（AI）可以通过 **11 个工具**操作 WorkBuddy 工作台。宿主没有工具通道时，用随附脚本 `wb.mjs` 走 HTTP + APIKEY（见文末）。

## 鉴权

- 所有 HTTP 调用带 `Authorization: Bearer <APIKEY>` 或请求头 `X-WorkBuddy-Token: <APIKEY>`。
- APIKEY 由管理员在 WorkBuddy 控制台「设置 → AI APIKEY」生成/重置；**未配置时服务端拒绝一切工具调用**。
- 令牌面：工具通道、监控、定时任务、规划器、远端文件、资源目录。设置/登录接口不接受令牌。

## 核心概念

- **资源目录**：ONENAT 平台（隧道→映射→应用）是唯一资源实时来源。SSH 主机 / DSH 实例 / HTTP 应用都以 `mappingId`（稳定 ID）标识；公网端口会漂移，WorkBuddy 每次派发前实时解析，**不要缓存公网 URL**。
- **子智能体**：绑定一个 DSH 实体（`dshRef`），可配置模型/系统提示词/远端工作目录 `workDir`，并绑定若干可用资源（入口+凭证+技能在派发时自动注入提示词）。
- **任务会话**：每任务一个聊天窗口。1 个成员 = chat 直通；多个成员 = orchestrate（LLM Planner 拆解 → DAG 调度 → 汇总）。
- **主调度**：主任务拆解由「规划器」指定的子智能体完成，其模型可单独指定（`workbuddy_planner_manage`）。

## 工具速查

| 工具 | 用途 |
|---|---|
| `workbuddy_monitor_read` | 监控大屏: overview（全局态势）/ events（事件流，`since` 增量轮询）/ history（N 天趋势）/ task（单任务详情） |
| `workbuddy_resource_manage` | 资源目录: list / dsh（只列 DSH 算力节点）/ resolve / refresh |
| `workbuddy_agent_manage` | 子智能体: list / upsert / delete / ping / preview / models（远端可用模型）/ presets / enable / disable |
| `workbuddy_task_manage` | 任务: list / create（带首条消息即派发，**立即回执**，`memberAgentIds` 指定执行者）/ send / **wait**（HTTP 通道可同步等结果；MCP/语音通道立即返回快照）/ members / cancel / delete |
| `workbuddy_task_status` | 任务进度、编排计划、子任务状态、汇总（默认摘要小回包；`detail:"full"` 才回全量轮次与日志） |
| `workbuddy_task_chat` | 查看子任务远端聊天记录（默认最近 20 条 + 单条截断，可 `maxMessages`/`maxTextChars`/`full`）/ 向远端会话追问（MCP 通道异步投递，回执后用下一次调用取结果） |
| `workbuddy_task_evaluate` | 查看任务汇总报告 |
| `workbuddy_schedule_manage` | 定时任务: list / get（执行记录）/ upsert / delete / toggle / run（手动触发） |
| `workbuddy_planner_manage` | 主调度: get / set（拆解智能体 + 模型）/ options（候选与可用模型） |
| `workbuddy_file_manage` | 远端工作区文件: list / mkdir / upload（base64 ≤1MB 或 URL ≤10MB）/ download / delete |
| `workbuddy_ssh_resource_manage` | 本地 SSH 资源池: list / get / upsert / delete / test / exec |

## 典型流程

### A. 发任务并等结果（最常用）

```
1. workbuddy_monitor_read {action:"overview"}          ← 看哪个智能体在线/空闲
2. workbuddy_agent_manage {action:"list"}              ← 挑执行者（或 upsert 新建）
3. workbuddy_task_manage {action:"create", memberAgentIds:["agent-x"], message:"…", title:"…"}
   ← 立即回执：{accepted:true, taskId, nextAction}，不等执行
4. workbuddy_task_manage {action:"wait", taskId:"task-…", timeoutMs:300000}
   ← HTTP 工具通道：同步等结果（返回 status/summary/lastReply）
   ← MCP/语音通道：wait 只回快照，进度改用 workbuddy_task_status 轮询
5. workbuddy_file_manage {action:"download", agent:"agent-x", path:"…"}   ← 取产出文件
```

一句话契约：**一个请求只 create 一次**。重复 create 相同内容（2 分钟内）会被服务端去重、复用既有任务并返回 `deduped:true`；
要进度就 `task_status` 轮询或 `wait` 取快照，**不要靠再 create 一次来"重试"**。

### B. 看监控/值守

- 全局：`workbuddy_monitor_read {action:"overview"}`（kpi.agentsOnline/tasksRunning/alerts…）
- 增量告警轮询：`workbuddy_monitor_read {action:"events", since:<上次时间戳>}`
- 某任务卡住？`{action:"task", taskId:"…"}` 看当前工具调用与最近对话。

### C. 管理定时任务

```
workbuddy_schedule_manage {action:"upsert", schedule:{
  name:"每日站会纪要", agentIds:["agent-x"], message:"生成昨日站会纪要",
  rule:{kind:"daily", times:["09:00","18:00"]}, enabled:true}}
workbuddy_schedule_manage {action:"run", scheduleId:"sched-…"}      ← 手动触发验证
```
规则: daily(times)/weekly(days,time)/hourly(minute)/monthly(days,time)/interval(minutes)/once(at 毫秒)。

### D. 指定主调度（拆解由谁完成 + 用什么模型）

```
workbuddy_planner_manage {action:"options"}                          ← 看候选智能体与可用模型
workbuddy_planner_manage {action:"set", agentId:"agent-x", model:"deepseek/deepseek-v3"}
workbuddy_planner_manage {action:"set", agentId:""}                  ← 恢复自动挑选
```

### E. 新建子智能体

```json
workbuddy_agent_manage {"action":"upsert","agent":{
  "name":"136-执行者",
  "dshRef":{"kind":"mapping","mappingId":"<DSH 映射 ID>"},
  "agentPreset":"cordis", "model":"deepseek/deepseek-v3",
  "systemPrompt":"你是核心执行工程师…",
  "workDir":"/workspace/tasks",
  "resources":[{"ref":{"kind":"mapping","mappingId":"<SSH 映射 ID>"},"alias":"db-hop","credentialMode":"self-fetch","skillMode":"all"}]
}}
```
`credentialMode`: self-fetch（推荐）/ inline / omit；`skillMode`: all / none / {names}。
建好后 `ping` 探活、`models` 看远端可用模型。

### F. 文件交互

```
workbuddy_file_manage {action:"upload", agent:"agent-x", name:"data.csv", contentBase64:"…"}   ≤1MB
workbuddy_file_manage {action:"upload", agent:"agent-x", name:"big.zip", url:"https://…"}      ≤10MB 服务器代拉
workbuddy_file_manage {action:"list", agent:"agent-x"}                                         看工作区
workbuddy_file_manage {action:"download", agent:"agent-x", path:"/workspace/out.txt"}
```

## REST 速查（前缀 /onenat-workbuddy，同样凭 Bearer 令牌访问开放面）

- 监控: `GET /api/monitor/overview` · `GET /api/monitor/events?limit&since` · `GET /api/monitor/history?days`
- 资源: `GET /api/resources` · `POST /api/resources/refresh`
- 定时: `GET|POST /api/schedules` · `GET|DELETE|PATCH /api/schedules/:id` · `POST /api/schedules/:id/toggle|run`
- 规划器: `GET /api/planner/options` · `POST /api/planner/config {agentId, model}`
- 文件: `GET /api/agents/fs/list?agent&path` · `POST /api/agents/fs/mkdir {agent,path,name}` · `GET /api/tasks/:id/files/download?agent&path` · `POST /api/tasks/:id/attachments`（multipart）
- 安装本技能: `curl -fsSL <服务地址>/onenat-workbuddy/install-skill.sh | bash -s -- --base-url <服务地址>/onenat-workbuddy --token <APIKEY> [--dir ~/.dsh/skills|~/.zcode/skills|~/.claude/skills]`

## 行为约定

1. 对 ONENAT 只读：不创建/修改/删除隧道或映射（接口也会拒绝）。
2. 发任务前先看监控挑空闲且在线的智能体；离线节点不要反复重试。
3. `wait` 超时后改用 `workbuddy_task_status` 轮询，不要重复创建同一任务；
   重复 create 同内容会被服务端去重（回 `deduped:true`），别把 create 当重试手段。
4. 窄通道（MCP/语音）单次调用不要长阻塞：create 立即回执、追问异步投递、ssh 长命令改后台执行 + 分段查询；
   长回包会被瘦身（`task_status` 摘要、`task_chat` 分页截断、单帧 64KB 上限）。
5. 凭证敏感：不要把 APIKEY / SSH 密码写进无关输出；推荐 `self-fetch` 凭证模式。
6. 任务执行中不能变更成员或删除任务；成员变更下一轮生效。
7. `ssh exec` 与文件删除是危险操作：先确认目标与路径，避免误删。

## 无工具宿主：wb.mjs 脚本

配置读取 `~/.workbuddy-skill.json`（一键安装时写入），或环境变量 `WORKBUDDY_BASE_URL` / `WORKBUDDY_TOKEN`。

```bash
wb.mjs monitor overview                          # 全局态势
wb.mjs monitor events --since 1730000000000      # 增量事件
wb.mjs task create --title x --agents agent-1,agent-2 --message "…"
wb.mjs task wait --id task-xxx --timeout 300000  # 等结果
wb.mjs agent list | agent upsert --json '{…}' | agent models --id agent-x
wb.mjs schedule upsert --json '{…}' | planner set --agent agent-x --model deepseek/deepseek-v3
wb.mjs file upload --agent agent-x --name a.txt --file ./a.txt | file download --agent agent-x --path /w/a.txt --out ./a.txt
```
完整命令：`wb.mjs help`。
