# Backlog MCP 工具契约（workbuddy_backlog_manage）

> 目标：把平台 backlog 待办（Backlog.md 兼容，唯一事实源在 DSH 节点项目工作区
> `<workspace>/backlog/tasks/*.md`）暴露为 **MCP 工具**，让任意 MCP 宿主里的 AI 能直接
> 管理平台待办（增删改查 + 派发为 WorkBuddy 任务 + 跨项目总览）。
> 上游对照：Backlog.md 官方 MCP Server（`src/mcp/tools/tasks/*`，v1.55.3）的 `task_*` 工具族。
>
> 状态：实现中（本文件是工具签名与语义的唯一契约，实现/测试/文档均以此为准）

---

## 1. 为什么只新增一个工具

`src/tool-ops.ts` 的工具定义是 **HTTP 通道（`POST /api/tools/:name`）与 MCP 通道（`/mcp`）的共同来源**：
`server.ts` 每次 `GET /api/tools` / MCP `tools/list` 都动态读同一份 `getTools()`。
因此本需求**只需在 `tool-ops.ts` 注册一个工具**，两条通道自动同步，不存在「MCP 单独实现」的维护面。

工具粒度沿用仓库既有约定（`workbuddy_<域>_manage` + `action` 子命令），
而不是照抄上游一个动作一个 MCP 工具（上游 `task_create` / `task_edit` / … 共 8 个）。
理由：本仓库工具参数只支持 `string`/`json` 两种类型，既有 15 个工具已统一为「一个域一个工具 + action」，
拆成 8 个工具会与既有约定冲突并放大工具表噪声。

## 2. 工具签名

```
name: workbuddy_backlog_manage
parameters:
  action            (string, 必填) 见 §3
  projectId         (string)      项目 ID（overview 之外的操作必填）
  itemId            (string)      待办 ID（如 TASK-1；大小写不敏感）
  taskId            (string)      WorkBuddy 任务 ID（retry-writeback 用）
  itemIds           (json)        批量派发的待办 ID 数组
  item              (json)        create / edit 的待办字段（见 §5）；dispatch 时可用 `item.instruction` 传「附加说明」
  filter            (json)        list / search / overview 的过滤条件（见 §6）
  force             (string)      'true' = 忽略依赖强制派发 / 确认物理删除
  sample            (string)      init：'true' = 附带一条示例待办
  updateInstruction (string)      init：'true' = 把 backlog 协作约定写入项目指令
```

> 说明：`projects` / `overview` 也接受 `filter`（`projectIds` 收窄项目范围）；`retry-writeback` 用 `taskId`。
> `item.instruction` 只影响 dispatch：写进任务初始说明的「附加说明」段，直达编排拆解。

## 3. action 语义

| action | 必填 | 说明 | 对应上游 |
|---|---|---|---|
| `projects` | – | 列出可管项目：id/name/节点/workspace/archived/initialized | （WorkBuddy 独有，帮 AI 选 projectId） |
| `config` | projectId | backlog 配置：statuses / defaultStatus / taskPrefix / projectName / initialized | `init` 的只读部分 |
| `init` | projectId | 初始化 backlog 目录（幂等）；可带 `sample`、`updateInstruction` | `init`（CLI） |
| `list` | projectId | 待办列表（元数据 + 验收进度 + 关联任务），支持 §6 过滤 | `task_list` |
| `search` | projectId | 全文检索（标题/描述/备注/评论/最终总结/metadata；空白切词全部命中），需 `filter.search` | `task_search` |
| `view` | projectId, itemId | 单条详情：字段 + 完整 Markdown 原文 + 关联任务（含汇总） | `task_view` |
| `create` | projectId, item.title | 新建待办（itemId 服务端分配，沿用 `<task_prefix>-<n>`） | `task_create` |
| `edit` | projectId, itemId, item | 改字段 / 状态 / 标签 / 依赖 / 指派人 / 描述 / 验收清单 / 追加记录 | `task_edit` |
| `delete` | projectId, itemId, force='true' | 物理删除（必须 `force='true'`，否则返回二次确认提示） | `task_delete` |
| `dispatch` | projectId + (`itemId` 或 `itemIds`) | 派发为 WorkBuddy 任务（继承项目节点/工作区/成员/技能）；依赖未完成默认阻止，`force='true'` 忽略 | （WorkBuddy 独有执行闭环） |
| `overview` | – | 跨项目聚合「我的待办」（并发 3、失败隔离） | （WorkBuddy 独有） |
| `retry-writeback` | taskId | 任务终态回写待办失败后的重试 | （WorkBuddy 独有） |

## 4. 状态机与回写（沿用既有设计，不在此工具内新增语义）

- 派发成功：待办 status → 配置里的「进行中」状态（`resolveInProgressStatus`），正文追加「派发为任务」执行记录。
- 任务终态钩子（`engine.runBacklogWriteback`）：success → Done；failed → 回默认状态；partial_success → 保持。
- `edit` 只做人工/AI 显式修改，不触发回写。

## 5. `item` JSON（create / edit）

```jsonc
{
  "title": "接入支付回调",          // create 必填；edit 可改
  "description": "……",             // 替换 Description 段（段标记原样保留）
  "status": "In Progress",         // 必须是 config.statuses 之一（大小写不敏感）
  "priority": "High",              // 自由值（上游从 config.priorities 取值）
  "dueDate": "2026-11-30",         // 日期字符串 / null 清除
  "ordinal": 3000,                 // 手动排序
  "labels": ["backend", "p0"],     // 整体替换
  "assignees": ["alice"],          // 整体替换（上游字段名 assignee）
  "dependencies": ["TASK-1"],      // 整体替换
  // ---- 查询相关字段（docs/design-backlog-query-filters.md §2）：null/空串 = 清除 ----
  "type": "bug",                   // 任务类型（frontmatter type）
  "milestone": "M-1",              // 里程碑（frontmatter milestone）
  "taskProject": "web",            // monorepo 组件（frontmatter project）
  "parentTaskId": "TASK-12",       // 父任务（frontmatter parent_task_id）
  "acceptance": ["回调签名校验通过"], // 整体替换验收清单（保留已勾选状态优先按文本匹配）
  "acceptAdd": ["新增一条验收"],     // 追加验收项（不覆盖既有）
  "note": { "title": "人工备注", "lines": ["…"] }  // 文末追加执行记录（不动既有内容）
}
```

规则：
- 未出现的键 = 不改动（宽容原则，与 `encodeFrontmatter` 一致）；`null`/空串 = 清除该字段。
- `status` 非法时返回 `{ok:false,error:"status 非法，可选：…"}`，不做静默写入。
- `edit` 写路径走 `writeItem` 乐观并发：内容被他人改动返回 `{ok:false,code:"CONFLICT"}`，提示重新 `view` 后重试。
- `create` 一次写入 `type/milestone/taskProject/parentTaskId`（`createItem` 的原生字段），无需二次补写。

## 6. `filter` JSON（list / search / overview）

> 查询引擎与 REST 完全同源：`src/backlog-query.ts` 的 `parseBacklogQuery`（文档
> `docs/design-backlog-query-filters.md` §2/§5）。旧字段全部保留，值可为字符串或数组
> （数组/逗号分隔等价，大小写不敏感）。

| 字段 | 类型 | 说明 |
|---|---|---|
| `status` | string \| string[] | 只保留这些状态（多值并集，大小写不敏感） |
| `excludeStatus` | string \| string[] | 排除这些状态（与 `status` 同时给时排除优先） |
| `assignee` | string \| string[] | 指派人**包含**匹配（忽略前缀 `@`） |
| `unassigned` | bool | 仅未指派（**不可与 `assignee` 同用**） |
| `priority` | string \| string[] | 优先级多值（归一化 lower 后并集） |
| `type` | string \| string[] | 任务类型多值 |
| `labels` | string \| string[] | 标签，默认要求全部命中 |
| `labelMatch` | `"all"` \| `"any"` | 标签匹配模式（缺省 `all`；非法值 → `ok:false`） |
| `milestone` | string | 里程碑（`m-8`/`8` 数字别名；`__none__` = 无里程碑） |
| `taskProject` | string \| string[] | frontmatter `project`（monorepo 组件，非 WorkBuddy 项目） |
| `parent` | string | 只要该父任务的子任务（`parent_task_id`，id 归一化；不能为空串） |
| `search` | string | 全文检索：标题/描述/备注/评论/最终总结/metadata（空白切词、全部子串命中） |
| `ready` | bool | 未完成且依赖全部完成 |
| `blocked` | bool | 有未完成/未知依赖（与 `ready` 互斥） |
| `includeDone` | bool | `false` ≡ `openOnly=true`（overview **缺省 false**） |
| `openOnly` | bool | 按各项目自身 statuses 排除已关闭状态 |
| `sort` | `priority`\|`id`\|`ordinal`\|`createdAt`\|`updatedAt`\|`status` | 排序维度（缺省 `createdAt`；旧名 `orderBy` 继续可用） |
| `order` | `"asc"` \| `"desc"` | 排序方向（缺省 `desc`） |
| `limit` | number | 排序后的**硬截断**（只取前 N 条，缺省 50、上限 1000）；先截断再开窗 |
| `maxCount` | number | 窗口大小（`skip` 之后取多少条）；**翻页用 `skip`+`maxCount`**，不要用 `limit` |
| `skip` | number | 窗口偏移（在过滤 + 排序 + `limit` 截断之后，≥0） |
| `count` | bool | 只要计数，`items:[]` |
| `projectIds` | string[] | projects / overview：收窄 WorkBuddy 项目范围 |

```jsonc
// 例：高优、未完成、依赖已就绪的「登录 超时」相关待办，按优先级倒序取前 20 条
{ "status": ["To Do", "In Progress"], "excludeStatus": ["Done"], "priority": ["high"],
  "labels": ["backend"], "labelMatch": "all", "search": "登录 超时",
  "ready": true, "sort": "priority", "order": "desc", "limit": 20 }

// 例：翻页（第 2 页，每页 20 条）——分页窗口用 maxCount + skip
{ "sort": "createdAt", "order": "desc", "maxCount": 20, "skip": 20 }
```

> 分页语义（与上游 CLI 一致）：`limit` 先对排序结果硬截断，`skip`/`maxCount` 再在截断后的列表上开窗。
> 因此**「显示更多」只能带 `skip`+`maxCount`**；只带 `limit` 再叠加 `skip` 会让窗口越出截断列表（第 2 页变空）。
> 工具通道在**只给 `skip`** 时自动补 `maxCount=50`（不是 `limit`），保证翻页可用。

错误：`assignee`+`unassigned` 互斥、数值非法（`limit/skip/maxCount` 非整数或越界）、
`labelMatch`/`order` 非法 → `{ok:false, code:"INVALID_QUERY", error, errors[]}`（不静默降级）。

## 7. 返回约定

- 成功：`JSON.stringify({ ok: true, ... }, null, 2)`，列表类带 `statuses` / `truncated` / `total` / `matched` / `window` / `counts` / `facets`。
- 失败：`{ ok:false, error }`；`filter` 参数非法带 `code:"INVALID_QUERY"` 与 `errors[]`；冲突额外带 `code:"CONFLICT"`；
  依赖阻止带 `code:"DEPS_BLOCKED"` 与 `blocked:[…]`。
- 归档项目（`archivedAt` 非空）写操作一律拒绝，读操作放行（与 HTTP API 的 P-08 语义一致）。
- **`searchText` 是服务端检索语料，任何回包（list / overview / view / detail）都不得出现**（服务层统一剥离）。

各 action 的回包键（测试与文档以此为准）：

| action | 关键回包键 |
|---|---|
| `projects` | `projects[]`（`id/name/node?/workspace?/archived:boolean/nodeStatus/initialized/statuses?/defaultStatus?/error?`）、`total` |
| `config` | `initialized/statuses/defaultStatus/taskPrefix/instructionSnippet/archived` |
| `init` | `initialized/sampleItemId?/statuses/defaultStatus` |
| `list` / `search` | `initialized/statuses/defaultStatus/total(全量)/matched(命中)/returned(本窗口条数)/window{skip,total,nextSkip,cut,shown}/counts{open,done,ready,blocked,unassigned}/facets/query/items[]`；条目带 `isReady/blocked/blockingDependencies?/missingDependencies?` 与 `type/milestone/taskProject/parentTaskId?`（未初始化时 `initialized:false` + `tip`，`statuses/defaultStatus` 仍给默认值） |
| `view` | `item`（完整字段 + `isReady/blocked/blockingDependencies/missingDependencies`；**不含 searchText**）、`raw`（完整 Markdown；超 40K 字符截断并带 `rawTruncated:true` + `rawLength`）、`tasks[]`（关联任务含 summary）、`statuses` |
| `create` | `item`（含服务端分配的 `itemId` 与 type/milestone/taskProject/parentTaskId）、`warning?`（待办已建但 note 追加失败时） |
| `edit` | `itemId/updated[]/description?/acceptance?/note?` |
| `delete` | `deleted/fileName`（未带 `force` 时 `code:"CONFIRM_REQUIRED"`） |
| `dispatch`（单条；`itemIds` 只有 1 条时也走此形状） | **扁平**：`ok/taskId/itemId/taskTitle/mode/itemStatus` |
| `dispatch`（批量，`itemIds` ≥2 条） | `ok/results[]（ok/itemId/taskId?/code?/error?/blocked?/taskCreated?）/succeeded/failed` |
| `overview` | `summary{projects,unreachable,total,matched,open,ready,blocked}`、`facets`（所有项目并集）、`projects[]`（`projectId/projectName/nodeStatus/error?/statuses?/defaultStatus?/total/matched/open/done/ready/blocked/items[]`）；逐项目字段扁平（与 REST §4.2 一致）；**默认剔除已完成**（`includeDone` 缺省 false ≡ `openOnly=true`），要历史完成项显式 `includeDone:"true"` |
| `retry-writeback` | `taskId/projectId/itemId`（失败仍回 `taskId/projectId/itemId` + `retryable:true`） |

> HTTP 工具通道（`POST /api/tools/workbuddy_backlog_manage`）在外层再包一层 `{ok, tool, result}`，
> `result` 才是上表的工具回包；MCP 通道的 `tools/call` 直接拿上表 JSON 文本。

## 7.1 派发失败的「不可重试」语义（重要）

`dispatch` 是「先建任务、再写待办」的两步操作。任务一旦建成，就**不允许调用方把整个动作当失败重试**
（会产生重复任务）。因此：

- 写待办遇到乐观并发冲突：自动重读最新内容、重试追加一次（执行记录是追加语义，可重入）；
- 仍失败：回包带 `code:"WRITEBACK_FAILED"` + `taskId` + `taskCreated:true` + 原文解释。**看到 `taskCreated`
  就不要重新 dispatch**，改用 `edit` 手动置状态，或（任务终态后）调用 `retry-writeback`。

## 8. 与上游 Backlog.md MCP 的差距（如实声明）

| 上游能力 | 本工具 | 原因 |
|---|---|---|
| `task_list` / `task_search` / `task_view` / `task_create` / `task_edit` / `task_delete` | ✅ 全部覆盖 | — |
| `task_archive` / `task_restore` | ❌ 未实现 | 本仓库设计（`docs/design-backlog-integration.md` §11.2）已定：归档语义映射为状态迁移，物理归档目录后置；避免引入 `backlog/archive/` 目录与列表排除逻辑 |
| `definition_of_done_defaults_*` | ❌ 未实现 | 需在 `config.yml` 增项目级 DoD 默认值，数据层未建模；验收清单（AC）已覆盖主要用途 |
| `document_*`（8 个） | ❌ 未实现 | docs-as-code 与「待办即工单」正交，设计文档已列后置 |
| `milestone_*` | ⚠️ 部分 | 单条待办的 `milestone` 字段已支持（`--milestone` 过滤、`item.milestone` 读写）；里程碑清单管理（创建/重命名/归档）未实现——上游依赖 `milestones/` 归档目录，本仓库不建模 |
| 依赖 git 的历史/分支视图 | ❌ 未实现 | 工作区按纯文件读写，不做 git 提交（设计 §9 风险 6） |
| 派发为任务（上游无） | ✅ `dispatch` / `overview` / `retry-writeback` | WorkBuddy 独有执行闭环 |

## 9. 实现落点

| 文件 | 变更 |
|---|---|
| `src/backlog-service.ts` | `dispatchBacklogItem()`（从 router 抽出）+ `overviewBacklog()`（跨项目 fan-out，支持 `query` 逐项目过滤）；`stripBacklogSearchText` / `mergeBacklogFacets` / `summarizeBacklogOverview` |
| `src/backlog-query.ts` | 查询引擎（`parseBacklogQuery` / `applyBacklogQuery` / readiness / facets），REST 与工具通道共用 |
| `src/backlog-tool.ts` | 新增：`createBacklogManageTool(deps)` 返回 backlog 工具定义，由 `tool-ops.ts` 组装进 defs 表；filter 解析复用查询引擎 |
| `src/backlog.ts` | `listBacklog` 支持 `withBodies`（search 的描述预览）；查询字段（type/milestone/project/parent_task_id）与 `searchText` |
| `src/tool-ops.ts` | 注册第 16 个工具 `workbuddy_backlog_manage` |
| `src/router.ts` | 复用 `backlog-service`，两接口接入查询引擎与 `INVALID_QUERY` 错误码 |
| `scripts/backlog-e2e.mjs` | 新增 MCP 工具通道用例（stub DSH 节点）+ 查询链路覆盖 |
| `skills/workbuddy-mcp/SKILL.md`、`skills/onenat-workbuddy/*` | 工具清单与用法 |
