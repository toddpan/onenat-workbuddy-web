---
name: onenat-workbuddy
description: OneNat WorkBuddy 多智能体工作台 AI 管理技能：发任务给智能体并取结果、看监控态势、管子智能体/定时任务/文件、指定主调度。当用户提到 "WorkBuddy / 监控大屏 / 发任务 / 子智能体 / 定时任务 / 多智能体协作" 时使用。
---

# OneNat WorkBuddy 工作台技能

通过 **11 个工具**操作多智能体工作台。宿主无工具通道时用 `wb.mjs` 脚本（见文末）。

**鉴权**：HTTP 调用带 `Authorization: Bearer <APIKEY>`（控制台「设置 → AI 接入」生成）。未配置令牌时服务端拒绝一切调用；设置/登录接口不接受令牌。

## 核心概念

- **子智能体**：绑定一个 DSH 节点（`dshRef`），可配模型/系统提示词/工作目录 `workDir`/可用资源。
- **任务会话**：每任务一个聊天窗。1 成员 = 直通对话；多成员 = 协同编排（主调度拆解 → 子任务 → 汇总）。
- **@ 提及**：任务消息正文里 `@名称` 可直接指定执行者或资源，见下节。
- **资源目录**：ONENAT 平台的隧道/映射是唯一资源来源，以稳定 ID 标识；端口会漂移，**勿缓存公网 URL**。

## 消息文本语法：@ 提及

任务消息正文支持 @ 提及，是指定执行者与资源最自然的方式（引擎实时解析，被 @ 的智能体自动纳入任务成员）：

- `@子智能体名` → 任务交给它执行（名称须与子智能体列表完全一致，支持含空格完整名，最长名优先匹配；@ 多个 = 编排）
- `@资源名` → 资源入口与连接信息注入本次任务（如 `@136 环境-SSH Server`）
- `@[子智能体名:文件路径]` → 引用其工作区文件
- 技能：自然语言指示即可（如「用 lark-cli 技能发消息给xxx」），也可 `/技能名` 显式加载

用 @ 时 `create` 的 `memberAgentIds` 可省略；两者同给也行。

## 工具速查

| 工具 | 用途 |
|---|---|
| `workbuddy_monitor_read` | 监控态势：overview / events（`since` 增量）/ history / task（单任务详情） |
| `workbuddy_task_manage` | 任务：list / create（异步回执）/ send / **wait** / members / cancel / delete |
| `workbuddy_task_status` | 任务进度与汇总（默认摘要；`detail:"full"` 回全量） |
| `workbuddy_task_chat` | 看子任务远端聊天记录 / 向远端会话追问 |
| `workbuddy_task_evaluate` | 任务汇总报告 |
| `workbuddy_agent_manage` | 子智能体：list / upsert / delete / ping / preview / models / presets / enable / disable |
| `workbuddy_schedule_manage` | 定时任务：list / get / upsert / delete / toggle / run |
| `workbuddy_planner_manage` | 主调度：get / set / options |
| `workbuddy_file_manage` | 工作区文件：list / mkdir / upload / download / delete |
| `workbuddy_resource_manage` | 资源目录：list / dsh / resolve / refresh |
| `workbuddy_ssh_resource_manage` | SSH 资源池：list / get / upsert / delete / test / exec |

## 典型流程

### 发任务并等结果（最常用）

```
1. monitor_read overview                 ← 挑在线且空闲的智能体（或 agent list / upsert 新建）
2. task_manage create                    ← 立即回执 {accepted:true, taskId}，不等执行
   message:"让 @136-苦力兔 收集136 服务器的 KB 平台运行情况"     ← @ 指定执行者（推荐）
   或 memberAgentIds:["agent-x"] + message:"…"                  ← 显式成员写法
3. task_manage {action:"wait", taskId:"…", timeoutMs:300000}   ← 拿 status/summary/lastReply
   超时则改用 task_status 轮询
4. file_manage download                  ← 需要时取产出文件
```

### 看监控 / 值守

overview 看全局；`{action:"events", since:<时间戳>}` 增量拉告警；`{action:"task", taskId}` 看单任务卡点。

### 管理定时任务

```
schedule_manage {action:"upsert", schedule:{name:"每日站会纪要", agentIds:["agent-x"],
  message:"生成昨日站会纪要", rule:{kind:"daily", times:["09:00","18:00"]}}}
schedule_manage {action:"run", scheduleId:"sched-…"}     ← 手动触发验证
```
规则：daily(times) / weekly(days,time) / hourly(minute) / monthly(days,time) / interval(minutes) / once(at)。

### 指定主调度（主任务拆解由谁完成 + 用什么模型）

`planner_manage {action:"set", agentId:"agent-x", model:"deepseek/deepseek-v3"}`；`agentId:""` 恢复自动挑选。

### 新建子智能体

```
agent_manage {action:"upsert", agent:{name:"136-执行者",
  dshRef:{kind:"mapping", mappingId:"<DSH 映射 ID>"},
  systemPrompt:"<角色+职责>", workDir:"<项目目录>",
  resources:[{ref:{kind:"mapping", mappingId:"<SSH 映射 ID>"}, credentialMode:"self-fetch"}]}}
```
建好后 `ping` 探活、`models` 看可用模型。`credentialMode`：self-fetch（推荐）/ inline / omit。

### 文件交互

`upload`：`contentBase64`（≤1MB）或 `url`（服务器代拉 ≤10MB）；`download` 返回文本或 base64（≤8MB）。

## 行为约定

1. **一个请求只 create 一次**：相同内容重复 create 会被去重复用（`deduped:true`）；要进度用 `task_status` 或 `wait`，别把 create 当重试。
2. 发任务前先看监控挑在线空闲的智能体；离线节点不重试。
3. 窄通道（MCP/语音）不长阻塞：create 立即回执、追问异步投递，进度用 `task_status` 轮询。
4. 凭证敏感：APIKEY / SSH 密码不进无关输出；推荐 `self-fetch` 凭证模式。
5. `ssh exec` 与文件删除是危险操作：先确认目标与路径。
6. 任务执行中不能改成员或删除；对 ONENAT 只读，不改隧道映射。

## 无工具宿主：wb.mjs

配置在 `~/.workbuddy-skill.json`（安装时写入），或环境变量 `WORKBUDDY_BASE_URL` / `WORKBUDDY_TOKEN`。

```bash
wb.mjs monitor overview                          # 全局态势
wb.mjs task create --title x --agents agent-1 --message "…"
wb.mjs task wait --id task-xxx --timeout 300000  # 等结果
wb.mjs schedule upsert --json '{…}' | planner set --agent agent-x --model deepseek/deepseek-v3
wb.mjs file download --agent agent-x --path /w/a.txt --out ./a.txt
```
完整命令：`wb.mjs help`。安装：`curl -fsSL <服务地址>/onenat-workbuddy/install-skill.sh | bash -s -- --base-url <服务地址>/onenat-workbuddy --token <APIKEY>`。
