---
name: onenat-workbuddy
description: OneNat WorkBuddy 多智能体工作台 AI 管理技能：发任务给智能体并取结果、看监控态势、管子智能体/专家库/定时任务/文件/项目、切换执行节点。当用户提到 "WorkBuddy / 监控大屏 / 发任务 / 子智能体 / 专家 / 定时任务 / 项目 / 多智能体协作" 时使用。
---

# OneNat WorkBuddy 工作台技能

通过 **13 个工具**操作多智能体工作台。本文件是总入口：先看核心概念与路由表，**细节按需读子技能文件**（`skills/` 目录，相对本文件所在目录）。

**鉴权**：HTTP 调用带 `Authorization: Bearer <APIKEY>`（控制台「设置 → AI 接入」生成）。未配置令牌时服务端拒绝一切调用；设置/登录接口不接受令牌。

## 核心概念（执行模型）

- **节点（DSH）= 主 DSH**：决定任务在哪台机器上执行。任务创建时用 `nodeRef` 指定；无 @ 的主会话在该节点上直发。
- **子智能体 = sub agent**：绑定一个 DSH 节点（`dshRef`）+ 提示词/技能/资源的远程执行单元。消息里 `@它` 即委派任务，**它回到自己绑定的节点上远程执行**（其 `workDir` 只在自己节点有效）。
- **项目**：节点 + 工作目录 + 项目指令 + 可@ sub agent 集合 + 连接器 + 技能 的可复用上下文。`create` 带 `projectId` 即项目任务，全部上下文自动继承。
- **@ 提及**：消息正文里 `@名称` 直接指定执行者或资源（@ 项目/智能体/专家/专家团/资源均支持，详见 `skills/tasks.md`）。
- **资源目录**：ONENAT 平台的隧道/映射是唯一资源来源，以稳定 ID 标识；端口会漂移，**勿缓存公网 URL**。

## 子技能路由（按需加载，读完即用）

| 你要做什么 | 读哪个文件 |
|---|---|
| 发任务/追问/看进度/等结果；@ 提及完整语法；选节点(nodeRef)/项目任务 | `skills/tasks.md` |
| 查/建/改/删专家、修专家模板数据、专家 vs 子智能体选型 | `skills/experts.md` |
| 建/改子智能体（绑定节点）、建/改项目 | `skills/agents-projects.md` |
| 看监控/值守、告警增量、定时任务、主调度(规划器)配置 | `skills/ops-monitoring.md` |
| 上传/下载工作区文件、SSH 资源池、隧道资源目录 | `skills/files-resources.md` |
| 宿主无工具通道（改用 wb.mjs 命令行） | `skills/cli.md` |

**最小可用流程**（不必读子文件就能干的活）：

```
1. task_manage {action:"create", projectId:"proj-x", message:"让 @136-苦力兔 检查 136 磁盘占用"}   ← 立即回执
2. task_manage {action:"wait", taskId:"…", timeoutMs:300000}    ← 拿 status/summary/lastReply
```

发起前的判断（项目归属、需求澄清、执行者选择）见 `skills/tasks.md` 的五步流程——子智能体无人值守不会反问，理解需求是宿主 AI 的责任。

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
| `workbuddy_expert_manage` | 专家库：list（分页/过滤）/ get / search / create / update / delete（名册+内置+用户自建） |
| `workbuddy_project_manage` | 项目：list / get / upsert / delete |
| `workbuddy_schedule_manage` | 定时任务：list / get / upsert / delete / toggle / run |
| `workbuddy_planner_manage` | 主调度：get / set（模型、兜底拆解智能体）/ options |
| `workbuddy_file_manage` | 工作区文件：list / mkdir / upload / download / delete |
| `workbuddy_resource_manage` | 资源目录：list / dsh / resolve / refresh |
| `workbuddy_ssh_resource_manage` | SSH 资源池：list / get / upsert / delete / test / exec |

## 行为约定

1. **一个请求只 create 一次**：相同内容重复 create 会被去重复用（`deduped:true`）；要进度用 `task_status` 或 `wait`，别把 create 当重试。
2. **先理清需求与项目再 create**：先 `project list` 判断归属，能定项目就带 `projectId` 从项目发起；需求有歧义先在宿主层向用户问清（子智能体无人值守、不会反问），不着急动手；用 @ 把专家/子智能体写进 message 派活。
3. 发任务前先看监控挑在线空闲的智能体；离线节点不重试。
4. 选节点/建项目用 `resource_manage {action:"dsh"}` 拿映射 ID，别凭记忆猜 ID。
5. 窄通道（MCP/语音）不长阻塞：create 立即回执、追问异步投递，进度用 `task_status` 轮询。
6. 凭证敏感：APIKEY / SSH 密码不进无关输出；推荐 `self-fetch` 凭证模式。
7. `ssh exec` 与文件删除是危险操作：先确认目标与路径。
8. 任务执行中不能改成员或删除；对 ONENAT 只读，不改隧道映射。

## 无工具宿主

没有工具通道时改用 `wb.mjs` 命令行（配置 `~/.workbuddy-skill.json` 或 `WORKBUDDY_BASE_URL`/`WORKBUDDY_TOKEN`），完整用法见 `skills/cli.md`。
