---
name: workbuddy-mcp
description: 调用 OneNat WorkBuddy 多智能体工作台：任务创建/管理/查询/答复提问、监控态势、定时任务、项目管理、文件管理、专家库、SSH 资源、子智能体管理等 14 个工具。支持两种通道——MCP Server（Streamable HTTP，供 MCP 原生宿主注册）与 wbmcp.sh 脚本直连（无 MCP 宿主时的等价通道）。当用户要派任务给 WorkBuddy/子智能体/专家、查任务进度、看监控大屏、管项目或定时任务、传大文件时使用。
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

## 工具清单（14 个）

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
