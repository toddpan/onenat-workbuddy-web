# 子技能：发起与跟踪任务（task_manage / task_status / task_chat / task_ask_answer / task_evaluate）

任务 = 一个多轮聊天窗口。创建后可追问、看进度、等结果、收产出文件。

## 消息文本语法：@ 提及

- `@项目名` → 对该项目发起任务（任务未绑定项目时自动绑定 projectId，节点/工作目录/项目指令/可@ sub agent 全自动继承）
- `@sub agent 名` → 任务委派给它，在**其绑定节点**上远程执行（名称须与列表完全一致，最长名优先；@ 多个 = 编排）
- `@专家名` → 召唤专家库角色（动态实例化在任务节点；@ 多个 = 并行编排）
- `@专家团名` → 按团队合同展开成员编排（内置 5 团 + 自定义团）
- `@资源名` → 资源入口与连接信息注入本次任务（如 `@136 环境-SSH Server`）
- `@[sub agent 名:文件路径]` → 引用其工作区文件（自动生成跨节点取用指引）
- 技能：自然语言指示即可（如「用 lark-cli 技能发消息给xxx」），也可 `/技能名` 显式加载

用 @ 时 `create` 的 `memberAgentIds` 可省略；两者同给也行。

## 发起任务前：先理清需求与项目，再用 @ 派对执行者

子智能体一律**无人值守执行**（禁止 `ask_user_question`，提问会让远程 DSH 会话停等且不透传 UI），
它们不会回头向用户澄清——所以**理解需求是宿主 AI 的责任，必须在 create 之前完成**：

1. **先判项目归属**：拿用户请求对照 `project_manage {action:"list"}` 里的项目
   （名称/指令/可@ sub agent/工作目录）。**能确定属于哪个项目，就从该项目发起**
   （`create` 带 `projectId`，节点/工作目录/项目指令/可@ 专家全部自动继承）；
   确定不了再走裸任务（`nodeRef`/`memberAgentIds`）。别在项目任务上重复传这些参数。
2. **先理清需求，不着急动手**：create 之前主动跟用户把需求对齐——做什么、交付什么、
   在哪个项目/环境做、验收标准是什么。有歧义（目标不明、收件人/环境无法解析、
   多个项目都可能、多种做法）时先问清再派发；用户已说清就直接执行，不重复确认。
3. **选对执行者**：`agent_manage {action:"list"}`（或监控 overview）看有哪些专家/子智能体，
   按「职责 + 绑定节点 + 工作目录」匹配；项目任务优先用项目里配置的专家（`expertIds`）；
   找不到合适人格时先 `expert_manage {action:"search", query:"…"}` 查专家库（数百位预制专家），
   没有合适的先 `upsert` 建子智能体或 `expert_manage create` 建用户专家，别把任务派给名字相近的。
4. **用 @ 写进 message**（推荐写法）：`message:"@136-苦力兔 检查 136 服务器磁盘占用并输出报告"`。
   @ 谁，任务就派给谁、在其绑定节点执行；@ 多个 = 编排（主调度自动拆子任务）。
   资源（如 SSH 环境）同样用 `@资源名` 注入，比只传 `memberAgentIds` 更直观，两种可同用。
5. **指令自包含**：子智能体拿不到对话上下文，message 里要写全路径、参数、验收标准；
   模糊指令会被保守执行并产生偏差。

## 环境切换：任务节点（nodeRef）

任务在哪台机器执行由 `nodeRef` 决定。先 `resource_manage {action:"dsh"}` 查可用 DSH 映射 ID，再：

```
task_manage {action:"create", nodeRef:{kind:"mapping", mappingId:"<DSH 映射 ID>"},
  message:"检查这台机器的磁盘占用"}
```

- 不传 `nodeRef`：用服务端默认节点；`wb.mjs task create --node <映射ID>` 等价。
- 任务节点只约束**主会话**；@ 的 sub agent 仍回各自绑定节点执行。
- 选节点前先 `resource_manage {action:"dsh"}` 确认在线（offline 的节点不派发）。

## 项目工作台发任务（最省事的方式）

```
task_manage {action:"create", projectId:"proj-x",
  message:"收集流程编排用户提交工单的情况，生成报告让 @飞书消息 发飞书消息给潘祖继"}
```

带 `projectId` 后**不用再传** `nodeRef`/`workspace`/`memberAgentIds`——节点、工作目录、项目指令、可@ sub agent 集合全部自动继承；主会话在项目节点执行，@ 的 sub agent 回各自绑定节点。节点与项目冲突时以项目为准。

## 典型流程：发任务并等结果（最常用）

```
1. monitor_read overview                 ← 挑在线且空闲的智能体（或 agent list / upsert 新建）
2. 先理清需求与项目归属：能确定项目就从项目发起（projectId）；需求有歧义先问清，不着急动手
3. task_manage create                    ← 立即回执 {accepted:true, taskId}，不等执行
   message:"让 @136-苦力兔 收集136 服务器的 KB 平台运行情况"     ← @ 指定执行者（推荐）
   或 memberAgentIds:["agent-x"] + message:"…"                  ← 显式成员写法
   或 projectId:"proj-x"                                        ← 项目任务（上下文全继承）
   或 nodeRef:{kind:"mapping", mappingId:"…"}                   ← 指定任务节点
4. task_manage {action:"wait", taskId:"…", timeoutMs:300000}   ← 拿 status/summary/lastReply
   超时则改用 task_status 轮询
5. file_manage download                  ← 需要时取产出文件
```

## 跟踪与追问工具

- `task_manage`：list / create / **send**（多轮发言）/ **wait**（进度快照；HTTP 通道同步等结果，MCP 通道不阻塞）/ members / cancel / delete。
- `task_status`：任务进度与汇总（默认摘要；`detail:"full"` 回全量）——轮询用。
- `task_chat`：看子任务远端聊天记录 / 向远端会话追问（`followupMessage`）。
- `task_ask_answer`：答复任务里挂起的 ask_user_question 提问（agentId 缺省自动探测提问成员）。
- `task_evaluate`：任务汇总报告。
