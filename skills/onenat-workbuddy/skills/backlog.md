# 子技能：Backlog 待办（backlog_manage）

backlog = **项目工作区里的待办清单文件**：`<workspace>/backlog/tasks/*.md`（Backlog.md 兼容，每条一文件，frontmatter 存 id/title/status/labels/dependencies/assignee/priority/due_date/ordinal，正文含 Description / Acceptance Criteria / 执行记录段）。唯一事实源是节点上的 md 文件——人改、agent 改、Web 看板改的都是同一批文件，WorkBuddy 不存副本。

⚠️ 别和任务的 todo 混淆：任务内 `task_status`/`todo_write` 是会话内的执行清单；backlog 是**项目的待办池**，派发后变成普通 WorkBuddy 任务。

完整契约（必填项、item/filter 字段、错误码）：`docs/design-backlog-mcp-tool.md`。本文件只讲怎么用。

## 先选项目

`{action:"projects"}` 列出可管项目（id / name / 节点 / workspace / archived / initialized），拿 `projectId`。除 `projects` / `overview` / `retry-writeback` 外都要 `projectId`；未初始化先 `{action:"init", projectId}`（幂等；`sample:"true"` 附带示例待办，`updateInstruction:"true"` 把协作约定写进项目指令）。

状态名来自项目 `config.yml`（可配置），**不是**固定的 open/in-progress。先 `{action:"config", projectId}` 看 `statuses` / `defaultStatus` / `taskPrefix`，再按真实取值写。

## 12 个 action

| action | 入参 | 用途 |
|---|---|---|
| `projects` | – | 列可管项目，选 projectId |
| `config` | projectId | 读配置：statuses / defaultStatus / taskPrefix / projectName / initialized |
| `init` | projectId，可选 sample / updateInstruction | 初始化 backlog 目录（幂等） |
| `list` | projectId，filter | 待办列表（元数据 + 验收进度 + 关联任务；支持全部分类查询/排序/分页） |
| `search` | projectId，filter.search | 全文检索正文（标题/描述/备注/评论/元数据） |
| `view` | projectId，itemId | 单条详情：字段 + 完整 Markdown 原文 + 关联任务（含汇总） |
| `create` | projectId，item.title | 新建待办（itemId 服务端分配 `<task_prefix>-<n>`） |
| `edit` | projectId，itemId，item | 改字段/状态/标签/依赖/指派人/描述/验收清单/追加记录 |
| `delete` | projectId，itemId，force="true" | 物理删除（不加 force 只回二次确认提示） |
| `dispatch` | projectId + itemId（批量 itemIds） | 派发为 WorkBuddy 任务；依赖未完成默认阻止，force="true" 忽略 |
| `overview` | filter（includeDone / assignee / unassigned / limit） | 跨项目聚合「我的待办」（并发 3、失败隔离） |
| `retry-writeback` | taskId | 任务终态回写失败后重试 |

成功回 `{ok:true, ...}`：列表类带 `statuses` / `truncated` / `total`；`dispatch` **单条回包是扁平的**（顶层 `taskId` / `itemId` / `itemStatus` / `mode`），**批量回包**是 `{results:[{ok,itemId,taskId?|code,error?}…], succeeded, failed}`——跟进用 `results[i].taskId`，别在批量回包里找顶层 `taskId`。

**各 action 返回要点**：`projects` 每项带 `archived` / `nodeStatus` / `initialized`；`init` 回 `initialized` + `sampleItemId` + `statuses`；`list` / `search` 回 `initialized` / `statuses` / `total` / `returned` / `items`（未初始化时 `initialized:false` + `tip`）；`view` 回 `item` + `raw`（完整 Markdown）+ `tasks`（关联任务与汇总）；`create` 回 `item`（含服务端分配的 `itemId`）；`edit` 回 `updated`（实际改动的字段）；`delete` 回 `deleted` + `fileName`；`overview` 回 `summary{projects,unreachable,open}` + **`projects[]`**（按项目分组，每项带 `nodeStatus` / `error?` / `total` / `items[]`）；`retry-writeback` 回 `taskId` / `projectId` / `itemId`。

## 典型工作流：查重 → 登记 → 派发 → 追踪

```
1. 查重（先做，别重复建）
   {action:"list", projectId:"proj-x", filter:{status:"To Do"}}
   {action:"search", projectId:"proj-x", filter:{search:"支付回调"}}
2. 登记
   {action:"create", projectId:"proj-x", item:{title:"接入支付回调", description:"……",
     labels:["backend"], priority:"High", dueDate:"2026-11-30",
     acceptance:["回调签名校验通过","失败重试有日志"]}}
   验收标准写进 acceptance 数组（每条一个可验证项），不要只写描述——派发时原文直达编排拆解。
3. 挑可开工项
   {action:"list", projectId:"proj-x", filter:{ready:true, status:"To Do"}}
   ready=true 表示依赖已全部完成；有未完成依赖的条目默认不可派发。
4. 派发
   {action:"dispatch", projectId:"proj-x", itemId:"TASK-3"}          ← 批量用 itemIds:["TASK-3","TASK-4"]
   派出来的就是普通任务：继承了项目节点/工作区/成员/技能。单条回包的 taskId 就是任务 ID，
   批量回包逐条看 results[i].taskId / ok，后续用 task_status / task_chat 跟进。
5. 收尾
   任务终态由服务端自动回写：success → Done；failed → 回默认状态；partial_success → 保持。
   回写失败的任务带 backlogWritebackFailed，用 {action:"retry-writeback", taskId:"…"} 补写。
```

**不要手工 `edit` 待办状态冒充完成**：完成凭证是「关联任务成功 + 自动回写」；手动改状态只用于人明确要求关闭、或记录选定的 cancelled 状态。

## item / filter 字段

- `item`（create / edit）：`title` / `description` / `status` / `priority` / `dueDate` / `ordinal` / `labels` / `assignees` / `dependencies` / `acceptance` / `acceptAdd` / `note`。
  - 未出现的键 = 不改动（宽容原则）；`labels` / `assignees` / `dependencies` / `acceptance` 为**整体替换**，追加验收用 `acceptAdd`，追加记录用 `note:{title, lines}`。
  - `status` 必须是 `config.statuses` 之一（大小写不敏感），非法时直接报错，不静默写入。
- `filter`（list / search / overview）——与 Backlog.md `task list` 的查询能力对齐（契约全文：`docs/design-backlog-query-filters.md`）：
  - 分类：`status`（多值，大小写不敏感）/ `excludeStatus` / `priority` / `type` / `labels` + `labelMatch:"all"|"any"`（缺省 all）/ `milestone`（id 或标题；`__none__` = 无里程碑）/ `taskProject`（frontmatter `project` 组件）/ `parent`（父任务 ID）/ `assignee`（包含匹配）/ `unassigned`（不可与 assignee 同用）
  - 检索：`search`（标题+描述+备注+评论+metadata 全文，空白切词 = 全部命中）
  - 就绪：`ready` / `blocked`（依赖未完成或依赖找不到都算阻塞，fail-closed；条目回包带 `isReady` / `blockingDependencies` / `missingDependencies`）
  - 排序/窗口：`sort`（`priority|id|ordinal|createdAt|updatedAt|status`，`orderBy` 为旧别名）+ `order`（`asc|desc`）；`limit`=排序后**硬截断**；`maxCount`=分页窗口大小（配合 `skip` 翻页，回包 `window.nextSkip` 给下一页）；`count:true` 只要计数
  - 其他：`includeDone`（overview 用，默认只回未完成）/ `projectIds`（overview 限项目）/ `limit` 默认 50、上限 1000——MCP 单帧 64KB，别一次拉太多
  - 回包：列表类带 `total`（全量）/ `matched`（命中）/ `counts{open,done,ready,blocked,unassigned}` / `window` / `facets`（可选项及计数，UI 用）

## 错误与常见坑

- `code:"CONFLICT"`：写路径是乐观并发，文件已被其他人/agent 改过 → 重新 `view` 拿最新内容再 `edit`，**不要重放旧 item**。
- `code:"DEPS_BLOCKED"` + `blocked:[…]`：依赖未完成 → 先完成依赖，或确认可忽略后 `force:"true"`。
- `code:"WRITEBACK_FAILED"` + `taskCreated:true` + `taskId`：**任务已经建出来了**，只是待办状态没写回。这是最容易踩的坑——重跑 dispatch 会造出重复任务；改用 `edit` 置状态，或等任务终态后 `retry-writeback`。
- 归档项目（`projects` 里 `archived:true`）**只读**：读放行，create / edit / delete / dispatch / init 一律拒绝——要走先恢复项目。
- `delete` 是物理删除、不可恢复：默认用 `edit` 把 status 改成取消/关闭保留历史，确实要删才 `force:"true"`。
- 工具参数只有 `string` / `json` 两种：`item` / `filter` / `itemIds` 传 JSON；布尔用字符串 `"true"` / `"false"`。
- `itemId` 大小写不敏感（`TASK-1` = `task-1`）；界面上的文件名前缀只是显示，权威键是 frontmatter `id`。
- 上游 Backlog.md MCP 的 `archive`/`restore`、documents、milestones、DoD 默认值**未集成**（契约 §8）：不要调用不存在的 action，归档语义用状态迁移表达。
