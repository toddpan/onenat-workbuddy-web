---
name: workbuddy-mcp
description: 调用 OneNat WorkBuddy 多智能体工作台：任务创建/管理/查询/答复提问、监控态势、定时任务、项目管理、文件管理、专家库、SSH 资源、子智能体管理、项目待办（backlog/todo/看板）等 16 个工具。支持两种通道——MCP Server（Streamable HTTP，供 MCP 原生宿主注册）与 wbmcp.sh 脚本直连（无 MCP 宿主时的等价通道）。当用户要派任务给 WorkBuddy/子智能体/专家、查任务进度、看监控大屏、管项目或定时任务、传大文件、管理待办/backlog/todo/看板时使用。
---

# OneNat WorkBuddy MCP Skill

WorkBuddy 工作台的 **MCP 通道技能**：宿主支持 MCP 时把服务注册为 MCP Server；不支持时用配套脚本 `wbmcp.sh` 以「Streamable HTTP + JSON-RPC over POST」直连，效果等同。**两条通道工具同源、约定相同，本文件是共同的知识层。**

- 服务地址：`$BASE_URL/mcp`（`BASE_URL` 即工作台地址，含前缀；由安装脚本写进 `~/.workbuddy-skill.json`，或用环境变量 `WORKBUDDY_BASE_URL` / `WORKBUDDY_TOKEN` 覆盖）
- 鉴权：`Authorization: Bearer <APIKEY>`（也支持 `X-WorkBuddy-Token` 头或 `?token=` 参数）
- MCP 原生宿主（Claude / Cursor / Cline / DSH 等）的 mcpServers 条目：

```json
{ "mcpServers": { "onenat-workbuddy": { "url": "<BASE_URL>/mcp", "headers": { "Authorization": "Bearer <APIKEY>" } } } }
```

## 为什么接了 MCP 还要这份 SKILL

- **MCP 只管传输与工具发现**：`tools/list` 只有工具签名；「何时用、按什么顺序组合」的操作知识（下面的三步流程、@ 派活、轮询约定）都在本文件里。
- **触发靠 SKILL**：宿主靠 description/whenToUse 决定什么需求该想起工作台——没有它，接上了也不会主动用。
- **复杂逻辑在脚本端**：断点续传、直连通道优选（内网自证/公网回退）、幂等对账这些状态机由 `wbmcp.sh` 承载，MCP 工具调用表达不了。

## 快速用法

```bash
WB="<技能目录>/workbuddy-mcp/scripts/wbmcp.sh"   # 安装后位于各 AI 技能目录

# 列出全部工具
bash $WB tools

# 调用工具：wbmcp.sh call <工具名> '<JSON 参数>'
bash $WB call workbuddy_project_manage '{"action":"list"}'
bash $WB call workbuddy_task_status '{}'
bash $WB call workbuddy_monitor_read '{"action":"overview"}'
```

工具名与入参见 `bash $WB tools`。长任务用 `workbuddy_task_status`（默认 summary 小回包，`detail:"full"` 才是大回包）轮询。

## 带大文件的任务：标准三步流程（顺序不能反！）

任务要带日志包/数据集等大文件（≤2GB）时，**必须**按此顺序：

```bash
WB="<技能目录>/workbuddy-mcp/scripts/wbmcp.sh"

# ① 创建任务：**不带 message** —— 任务保持 draft 草稿态，不开始执行，拿到 taskId
bash $WB call workbuddy_task_manage '{"action":"create","projectId":"proj-xxx","title":"<标题>"}'

# ② P2P 直传附件（workbuddy 只下发 DSH 节点直连配方；文件直连节点，4MB/片，不经服务器中转；
#    putfile 自动完成 节点 init → 分片 → complete → 登记，回显落盘路径与跨节点下载 URL）
bash $WB putfile /path/to/log.zip task-xxxx [远端文件名]
#    中断/宿主超时后直接重跑即可：自动从节点断点续传（状态存临时目录，完成后自清）

# ③ send 首条消息（引用 ② 回显的工作区路径）—— 此时任务才开始执行
bash $WB call workbuddy_task_manage '{"action":"send","taskId":"task-xxxx","message":"日志已上传到 <路径>，请分析…"}'
```

**多成员/跨节点协作**：文件只上传到任务主节点一个节点。其它节点的成员需要该文件时，把 putfile/`upload_register` 回显的「跨节点下载 URL + 节点 apiKey」写进 send 的 message（下载方 `curl -H "Authorization: Bearer <节点apiKey>" -o 文件 "<URL>"`），实现 DSH↔DSH 点对点取文件，不经 workbuddy。

**反模式（真实事故 2026-10-14 task-80e9bfbd）**：create 带 message 并在正文写「日志包正在上传，收到路径后再开始分析」——任务照样立即开跑，执行者不会等文件；用户看到空跑的任务手动删除，上传中的附件 complete 直接 409「任务不存在」，206MB 白传。**永远不要在 create 的 message 里承诺"文件随后上传"，必须先传完再 send。**

`putfile` 会在 init 时回显任务状态；任务非 draft 时服务端返回 warning（说明附件很可能传了也读不到），看到 warning 应停手改走三步流程。

## 工具清单（16 个）

| 工具 | 用途 |
|---|---|
| workbuddy_task_manage | 任务会话：list / create（立即回执不等待）/ send（多轮）/ wait / delete / members / cancel |
| workbuddy_task_status | 查任务进度：状态、编排计划子任务、汇总结论（默认摘要，detail:"full" 全量） |
| workbuddy_task_chat | 看子任务/成员在远端 DSH 的聊天记录，可带 followupMessage 追问 |
| workbuddy_task_ask_answer | 答复任务里挂起的 ask_user_question 提问卡 |
| workbuddy_task_evaluate | 重新评估编排任务并生成/刷新汇总报告 |
| workbuddy_monitor_read | 监控大屏：overview / events / history / task |
| workbuddy_project_manage | 项目：list / get / upsert / delete（项目捆绑执行节点+工作目录+指令+可@成员） |
| workbuddy_schedule_manage | 定时任务：list / get / upsert / delete / toggle / run |
| workbuddy_file_manage | 远端工作区文件：list / mkdir / upload / download / delete / **upload_resumable_init + upload_register（大文件 P2P 分片直传 ≤2GB，断点续传）** |
| workbuddy_expert_manage | 专家库：list / get / search / create / update / delete |
| workbuddy_agent_manage | 子智能体管理：list / upsert / delete / ping / preview / models / presets / enable / disable |
| workbuddy_planner_manage | 主调度：get / set / options（拆解器兜底 + 调度模型） |
| workbuddy_resource_manage | ONENAT 隧道资源：list / dsh / resolve / refresh |
| workbuddy_ssh_resource_manage | SSH 连接资源池：list / get / upsert / delete / test / exec |
| workbuddy_team_manage | 专家团（合同式多成员协作单元）：list / get / upsert / delete / toggle（内置团只读） |
| workbuddy_backlog_manage | 项目待办 backlog（Backlog.md 兼容）：projects / config / init / list / search / view / create / edit / delete / dispatch / overview / retry-writeback |

## Backlog 待办管理

**backlog 是什么**：项目工作区 `<workspace>/backlog/tasks/*.md` 里的待办清单文件（Backlog.md 兼容：frontmatter 存 id/title/status/labels/dependencies/assignee/priority/due_date/ordinal，正文含 Description / Acceptance Criteria / 执行记录段）。唯一事实源是节点上的 md 文件——人在终端改、agent 在会话里改、Web 看板改，改的都是同一批文件；WorkBuddy 不复制数据。**别把它和任务内的执行清单混淆**：backlog 是项目的待办池，派发后变成普通 WorkBuddy 任务。

工具 `workbuddy_backlog_manage` 的 12 个 action：

- `projects` 列可管项目（id/name/节点/workspace/archived/initialized；会探测各项目 backlog 初始化状态，是拿 `projectId` 的入口）
- `config` 读项目配置（statuses / defaultStatus / taskPrefix / projectName）
- `init` 初始化 backlog 目录（幂等；`sample:"true"` 附带示例待办，`updateInstruction:"true"` 把协作约定写进项目指令）
- `list` 待办列表（元数据 + 验收进度 + 关联任务）；`search` 全文检索（**必须**带 `filter.search`）；`view` 单条详情（字段 + 完整 Markdown + 关联任务）
- `create` / `edit` / `delete`（物理删除必须 `force:"true"`）
- `dispatch` 派发为任务；`overview` 跨项目「我的待办」；`retry-writeback` 回写失败重试

**三个典型配方**

① AI 接到需求 → 先查重 → 再登记

```
workbuddy_backlog_manage {"action":"projects"}
workbuddy_backlog_manage {"action":"search","projectId":"proj-x","filter":{"search":"支付回调"}}
workbuddy_backlog_manage {"action":"create","projectId":"proj-x","item":{"title":"接入支付回调","labels":["backend"],"acceptance":["回调签名校验通过"]}}
```

② 挑可开工项 → 派发 → 用任务工具跟进

```
workbuddy_backlog_manage {"action":"list","projectId":"proj-x","filter":{"ready":true,"status":"To Do"}}
workbuddy_backlog_manage {"action":"dispatch","projectId":"proj-x","itemId":"TASK-3"}
workbuddy_task_status {"taskId":"<dispatch 返回的 taskId>"}
```

③ 看跨项目我的待办

```
workbuddy_backlog_manage {"action":"overview","filter":{"includeDone":false,"assignee":"alice"}}
```

**dispatch 的语义（重要）**：派发建出来的**就是普通 WorkBuddy 任务**——继承项目节点/工作区/成员/技能，可继续对话、看进度、取产出；验收清单原文直达编排拆解。任务终态由服务端自动回写待办状态（success → Done、failed → 回默认状态、partial_success → 保持）并追加执行记录。**不要手工 `edit` 待办状态冒充完成**；回写失败用 `retry-writeback` 补写。

**dispatch 回包形状**：单条派发是**扁平**的（顶层 `taskId` / `itemId` / `itemStatus` / `mode`；`itemIds` 只有 1 条时也走这个形状）；批量派发回 `{results:[{ok,itemId,taskId?|code,error?}…], succeeded, failed}`，跟进用 `results[i].taskId`——**别在批量回包里找顶层 `taskId`**。依赖未完成的条目默认拒绝派发（`code:"DEPS_BLOCKED"` + `blocked`），确认可忽略才 `force:"true"`。

**`taskCreated:"true"` = 任务已建但待办没写回（`code:"WRITEBACK_FAILED"`）**：这是「看起来失败、其实已经派发成功」的状态，**绝不能重新 dispatch**（会造出重复任务）；改用 `edit` 把状态置为进行中，或等任务跑完用 `retry-writeback` 补写。

**参数类型**：工具参数只有 `string` / `json` 两种。数组与对象一律放进 JSON 参数（`item` / `filter` / `itemIds`），布尔用字符串 `"true"` / `"false"`（如 `force`）。

**与上游 Backlog.md MCP 的差距（勿幻想不存在的 action）**：archive/restore（本仓库用状态迁移表达归档）、documents、milestones、DoD 默认值均未集成，原因见 `docs/design-backlog-mcp-tool.md` §8；每个 action 的必填项、item/filter 字段与错误码以该契约为准。

## 大文件上传（分片直传，≤2GB）

小文件：`upload`（contentBase64 ≤1MB 或 url 代拉 ≤10MB）；下载 `download` ≤8MB 且 **path 必须绝对路径**。

大文件（2GB 内）走 **P2P 直传**：`upload_resumable_init` 只下发 DSH 节点直连配方（节点 API 地址 + apiKey + 会话 + 分片端点模板），调用方直连节点「POST 节点 init → PUT 分片（409 对账续传）→ POST 节点 complete 得落盘路径」，再 `upload_register` 登记附件并拿跨节点下载 URL——文件字节不经 workbuddy 中转。直连配方里的 `baseUrlIntranet` 有歧义（每台节点的本机端都长 `127.0.0.1` 一样），**判定是否同机不靠猜**：`GET <基址>/api/v1/ping` 比对返回 `macs` 与本机网卡 MAC（`ip link`/`ifconfig`）有交集即本机节点；权威确认仍以 endpoints.init 返回 uploadId 为准（会话自证）。推荐直接用 `putfile` 封装（内置通道优选）。**上传前必读「带大文件的任务：标准三步流程」。**

**一键封装（推荐）**：

```bash
WB="<技能目录>/workbuddy-mcp/scripts/wbmcp.sh"
bash $WB putfile /path/to/bigfile.zip task-xxxx [远端文件名]
# 自动: init → 4MB/片顺序 PUT（带对账续传/通道优选） → complete → 登记 → 回显落盘路径
```

已验证：20MB 随机数据 3 片直传、9MB 2 片，MD5 双端一致。

注意：401「Invalid or missing API key」为节点通道偶发问题（疑似多后端凭据不一致），重试 1~2 次即可；持续出现需管理端修凭据。

## 使用约定（重要）

1. **发任务前先 `workbuddy_project_manage {"action":"list"}`** 判断需求归属项目：能确定就带 `projectId` 从该项目发起（自动继承节点/工作区/技能等上下文）。
2. **任务要带附件（大文件 ≤2GB）必须三步走**：create **不带 message**（draft 不执行）→ `putfile` 传附件 → `send` 引用路径启动；create 带 message = 立即执行，附件没传任务就开跑。
3. 需求有歧义先向用户问清，再创建任务。
4. 在 message 中用 `@子智能体名` / `@专家名` / `@专家团名` / `@资源名` 派活；@ 多个即编排协作。
5. 任务创建后用 `workbuddy_task_manage {"action":"wait"}` 或 `workbuddy_task_status` 轮询取结果，**不要重复 create**。
6. MCP 通道为异步回执：create/wait 立即返回进度快照，结果靠轮询 task_status / task_chat 获取。
