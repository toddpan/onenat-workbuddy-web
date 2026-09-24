---
name: onenat-workbuddy
description: OneNat WorkBuddy 多智能体工作台 AI 管理技能：发任务给智能体并取结果、看监控态势、管子智能体/定时任务/文件/项目、切换执行节点。当用户提到 "WorkBuddy / 监控大屏 / 发任务 / 子智能体 / 定时任务 / 项目 / 多智能体协作" 时使用。
---

# OneNat WorkBuddy 工作台技能

通过 **12 个工具**操作多智能体工作台。宿主无工具通道时用 `wb.mjs` 脚本（见文末）。

**鉴权**：HTTP 调用带 `Authorization: Bearer <APIKEY>`（控制台「设置 → AI 接入」生成）。未配置令牌时服务端拒绝一切调用；设置/登录接口不接受令牌。

## 核心概念（执行模型）

- **节点（DSH）= 主 DSH**：决定任务在哪台机器上执行。任务创建时用 `nodeRef` 指定；无 @ 的主会话在该节点上直发。
- **子智能体 = sub agent**：绑定一个 DSH 节点（`dshRef`）+ 提示词/技能/资源的远程执行单元。消息里 `@它` 即委派任务，**它回到自己绑定的节点上远程执行**（其 `workDir` 只在自己节点有效）。
- **项目**：节点 + 工作目录 + 项目指令 + 可@ sub agent 集合 + 连接器 + 技能 的可复用上下文。`create` 带 `projectId` 即项目任务，全部上下文自动继承。
- **@ 提及**：消息正文里 `@名称` 直接指定执行者或资源，见下节。
- **资源目录**：ONENAT 平台的隧道/映射是唯一资源来源，以稳定 ID 标识；端口会漂移，**勿缓存公网 URL**。

## 消息文本语法：@ 提及

- `@sub agent 名` → 任务委派给它，在**其绑定节点**上远程执行（名称须与列表完全一致，最长名优先；@ 多个 = 编排）
- `@资源名` → 资源入口与连接信息注入本次任务（如 `@136 环境-SSH Server`）
- `@[sub agent 名:文件路径]` → 引用其工作区文件（自动生成跨节点取用指引）
- 技能：自然语言指示即可（如「用 lark-cli 技能发消息给xxx」），也可 `/技能名` 显式加载

用 @ 时 `create` 的 `memberAgentIds` 可省略；两者同给也行。

## 环境切换：任务节点（nodeRef）

任务在哪台机器执行由 `nodeRef` 决定。先 `resource_manage {action:"dsh"}` 查可用 DSH 映射 ID，再：

```
task_manage {action:"create", nodeRef:{kind:"mapping", mappingId:"<DSH 映射 ID>"},
  message:"检查这台机器的磁盘占用"}
```

- 不传 `nodeRef`：用服务端默认节点；`wb.mjs task create --node <映射ID>` 等价。
- 任务节点只约束**主会话**；@ 的 sub agent 仍回各自绑定节点执行。
- 选节点前先 `resource_manage {action:"dsh"}` 确认在线（offline 的节点不派发）。

## 项目管理：project_manage

```
project_manage {action:"list"}                                   ← 列出项目（含节点/工作区/可@ sub agent/任务数）
project_manage {action:"get", projectId:"proj-x"}
project_manage {action:"upsert", project:{name:"KB 平台交付",
  dshRef:{kind:"mapping", mappingId:"<DSH 映射 ID>"},
  workspace:"/root/KB-algo", instruction:"<角色/阶段/规范指令>",
  expertIds:["agent-a","agent-b"], skillNames:["kb-algo","kb-api"]}}
project_manage {action:"delete", projectId:"proj-x"}
```

## 项目工作台发任务（最省事的方式）

```
task_manage {action:"create", projectId:"proj-x",
  message:"收集流程编排用户提交工单的情况，生成报告让 @飞书消息 发飞书消息给潘祖继"}
```

带 `projectId` 后**不用再传** `nodeRef`/`workspace`/`memberAgentIds`——节点、工作目录、项目指令、可@ sub agent 集合全部自动继承；主会话在项目节点执行，@ 的 sub agent 回各自绑定节点。节点与项目冲突时以项目为准。

## 工具速查

| 工具 | 用途 |
|---|---|
| `workbuddy_monitor_read` | 监控态势：overview / events（`since` 增量）/ history / task（单任务详情） |
| `workbuddy_task_manage` | 任务：list / create（异步回执，支持 `nodeRef`/`projectId`）/ send / **wait** / members / cancel / delete |
| `workbuddy_task_status` | 任务进度与汇总（默认摘要；`detail:"full"` 回全量） |
| `workbuddy_task_chat` | 看子任务远端聊天记录 / 向远端会话追问 |
| `workbuddy_task_ask_answer` | 答复任务里挂起的 ask_user_question 提问（agentId 缺省自动探测提问成员） |
| `workbuddy_task_evaluate` | 任务汇总报告 |
| `workbuddy_agent_manage` | 子智能体：list / upsert / delete / ping / preview / models / presets / enable / disable |
| `workbuddy_project_manage` | 项目：list / get / upsert / delete |
| `workbuddy_schedule_manage` | 定时任务：list / get / upsert / delete / toggle / run |
| `workbuddy_planner_manage` | 主调度：get / set（模型、兜底拆解智能体）/ options |
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
   或 projectId:"proj-x"                                        ← 项目任务（上下文全继承）
   或 nodeRef:{kind:"mapping", mappingId:"…"}                   ← 指定任务节点
3. task_manage {action:"wait", taskId:"…", timeoutMs:300000}   ← 拿 status/summary/lastReply
   超时则改用 task_status 轮询
4. file_manage download                  ← 需要时取产出文件
```

### 看监控 / 值守

overview 看全局；`{action:"events", since:<时间戳>}` 增量拉告警；`{action:"task", taskId}` 看单任务卡点。

### 管理定时任务

```
schedule_manage {action:"upsert", schedule:{name:"每日站会纪要", nodeMappingId:"<DSH 映射 ID>",
  model:"zai-coding-cn/glm-5.3-flash", message:"生成昨日站会纪要", rule:{kind:"daily", times:["09:00","18:00"]}}}
schedule_manage {action:"run", scheduleId:"sched-…"}     ← 手动触发验证
```

规则：daily(times) / weekly(days,time) / hourly(minute) / monthly(days,time) / interval(minutes) / once(at，**毫秒时间戳**如 `Date.now()+3600000`，不接受日期字符串)。
`nodeMappingId` = 执行节点（主 DSH），到点任务在该节点直发；旧数据（仅 agentIds）自动回退到首个智能体绑定节点。
`model` = 实例级模型（可选，provider/model 格式）：**无人值守任务建议固定为稳定模型**，留空跟随全局调度模型（模型按钮切错会影响无人值守任务）。

### 主调度（@ 多个 sub agent 编排时拆任务用）

编排拆解默认在**任务发起节点（主 DSH）**上执行，无需指定拆解器智能体；`agentId` 仅作任务节点不可达时的兜底。模型：`planner_manage {action:"set", model:"zai-coding-cn/glm-5.3-flash"}`（建议给无人值守场景固定稳定模型）。普通任务不经规划器。

### 新建子智能体（sub agent）

```
agent_manage {action:"upsert", agent:{name:"136-执行者",
  dshRef:{kind:"mapping", mappingId:"<DSH 映射 ID>"},
  systemPrompt:"<角色+职责>", workDir:"<该节点上的项目目录>",
  resources:[{ref:{kind:"mapping", mappingId:"<SSH 映射 ID>"}, credentialMode:"self-fetch"}]}}
```

建好后 `ping` 探活、`models` 看可用模型。`credentialMode`：self-fetch（推荐）/ inline / omit。
`workDir` 必须是该 sub agent **绑定节点上的绝对路径**——@ 它时就在那台机器上执行。

### 文件交互

`upload`：`contentBase64`（≤1MB）或 `url`（服务器代拉 ≤10MB）；`download` 返回文本或 base64（≤8MB）。

## 行为约定

1. **一个请求只 create 一次**：相同内容重复 create 会被去重复用（`deduped:true`）；要进度用 `task_status` 或 `wait`，别把 create 当重试。
2. 发任务前先看监控挑在线空闲的智能体；离线节点不重试。
3. 选节点/建项目用 `resource_manage {action:"dsh"}` 拿映射 ID，别凭记忆猜 ID。
4. 窄通道（MCP/语音）不长阻塞：create 立即回执、追问异步投递，进度用 `task_status` 轮询。
5. 凭证敏感：APIKEY / SSH 密码不进无关输出；推荐 `self-fetch` 凭证模式。
6. `ssh exec` 与文件删除是危险操作：先确认目标与路径。
7. 任务执行中不能改成员或删除；对 ONENAT 只读，不改隧道映射。

## 无工具宿主：wb.mjs

配置在 `~/.workbuddy-skill.json`（安装时写入），或环境变量 `WORKBUDDY_BASE_URL` / `WORKBUDDY_TOKEN`。

```bash
wb.mjs monitor overview                          # 全局态势
wb.mjs resource dsh                              # 可用 DSH 节点（拿映射 ID）
wb.mjs task create --title x --message "…" --node <映射ID>          # 指定任务节点
wb.mjs project list                              # 项目列表
wb.mjs task create --title x --project proj-x --message "…（可 @sub agent）"   # 项目任务
wb.mjs task wait --id task-xxx --timeout 300000  # 等结果
wb.mjs schedule upsert --json '{…}' | planner set --agent agent-x --model deepseek/deepseek-v3
wb.mjs file download --agent agent-x --path /w/a.txt --out ./a.txt
```

完整命令：`wb.mjs help`。安装：`curl -fsSL <服务地址>/onenat-workbuddy/install-skill.sh | bash -s -- --base-url <服务地址>/onenat-workbuddy --token <APIKEY>`。
