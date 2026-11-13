# Backlog 任务查询能力集成（对照 Backlog.md CLI / MCP / Web UI）

> 状态：**已实施并验收**（2026-11-02；QA 报告见 [`docs/qa-backlog-query-20261102.md`](qa-backlog-query-20261102.md)）。本文件是前后端 + 工具通道 + 测试的**唯一契约**。
> 上游依据：`MrLesk/Backlog.md` v1.55.3（本机实测 `npx --yes backlog.md task list --help`，源码 `src/cli.ts: runTaskList`、
> `src/utils/task-search.ts: createTaskFilterMatcher`、`src/utils/readiness.ts`、`src/utils/task-sorting.ts`、`src/utils/list-window.ts`）。

## 1. 目标

把 Backlog.md 的分类查询能力（`backlog task list --ready` 等）**完整**集成到 WorkBuddy：
- **待办任务列表**（控制台「✅ 待办」聚合页，跨项目）
- **每个项目的详细看板**（项目看板视图）
- 同时暴露到 REST API 与工具通道 `workbuddy_backlog_manage`（AI 可用）

不改数据格式：唯一事实源仍是 DSH 节点项目工作区 `<workspace>/backlog/tasks/*.md`（Backlog.md 兼容 frontmatter），
WorkBuddy 只做「读 + 查询 + 门面」，不复制、不缓存。

## 2. 对照表（上游 → WorkBuddy）

| Backlog.md CLI / 语义 | 查询参数（API/工具统一名） | UI 控件 | 语义与上游对齐说明 |
|---|---|---|---|
| `--status <s>`（可重复/逗号） | `status`（多值） | 状态 chips 多选 | 大小写不敏感、trim 后比较；多值取并集 |
| `--exclude-status <s>` | `excludeStatus` | 状态列「隐藏」操作（看板列菜单） | 先包含后排除（同时给时排除优先） |
| `--assignee <a>` | `assignee`（多值） | 指派 chips + 「仅分配给我」 | **放宽为包含匹配**（大小写不敏感；忽略前缀 `@`）——与既有「仅分配给我」行为一致 |
| `--unassigned` | `unassigned`（布尔） | 「未分配」chip | 与 `assignee` 互斥（同时给 → 400 / 工具 `ok:false`） |
| `--priority <p>` | `priority`（多值） | 优先级 chips | 归一化 lower + 去空白；多值取并集 |
| `--type <t>` | `type`（多值） | 类型 chips | 大小写不敏感 |
| `--project <p>`（monorepo 组件） | `taskProject`（多值） | 组件 chips（有数据才显示） | 与 WorkBuddy 的「项目」无关，故改名 `taskProject`，避免混淆 |
| `--labels <l,...>`（AND） | `labels`（多值）+ `labelMatch=all\|any`（缺省 `all`） | 标签 chips（默认 AND，标注「需全部命中」） | 上游 `--labels` 固定 AND；`any` 为 WorkBuddy 扩展 |
| `--milestone <m>` | `milestone`（单值；`__none__` = 无里程碑） | 里程碑 chips | 先精确匹配 id/标题（含 `m-8`/`8` 数字别名），未命中退化为标题包含匹配（上游用 Fuse 最近匹配，这里确定性降级） |
| `--parent <taskId>` | `parent`（单值） | 卡片「⊞ 子任务」入口（看板内钻取） | 按 `parent_task_id` 相等（id 归一化，忽略前缀大小写） |
| `--search <q>` | `search`（单值） | 搜索框（防抖 300ms） | 覆盖标题/描述/备注/评论/最终总结/metadata（正文全文 + frontmatter 字段）；按空白切词，**全部命中**（子串、大小写不敏感）。上游为 Fuse 模糊，这里确定性降级并文档化 |
| `--ready` | `ready`（布尔） | 「✅ 就绪（可开工）」chip | 见 §3：未完成 + 依赖全部完成（未知依赖 = 阻塞，fail-closed，与上游一致） |
| （扩展）被阻塞 | `blocked`（布尔） | 「⛔ 被阻塞」chip | `blocked = blockingDependencies ∪ missingDependencies 非空`，与 `ready` 互斥 |
| `--sort priority\|id\|ordinal` | `sort`（`priority\|id\|ordinal\|createdAt\|updatedAt\|status`） | 排序下拉 | `priority` 高→低（`order` 控制）；`id` 按数字段比较（task-2 < task-10）；缺省 `createdAt` 倒序（沿用 TASK-SORT-2 既有 UX，不改成上游的 ordinal 默认） |
| （排序方向） | `order`（`asc\|desc`） | ↓/↑ chip | |
| `--limit <n>` | `limit`（正整数） | —（API/CLI 对齐用，UI 不分页用它） | 排序后**硬截断**（上游 `runTaskList` 顺序：过滤 → 排序 → limit → 窗口） |
| `--max-count <n>` | `maxCount`（正整数） | 每页条数（看板「显示更多」） | **窗口大小**：`skip` 之后最多取多少条；`window.nextSkip/cut` 由它驱动 |
| `--skip <n>` | `skip`（≥0） | 「显示更多」翻页 | 窗口在过滤 + 排序 + limit 之后 |

> 注意 `limit` 与 `maxCount` **不是别名**（上游语义如此）：`limit` 把命中集合截断成上限，`maxCount` 是分页窗口。
> UI 分页必须用 `skip` + `maxCount`；用 `limit` 分页会导致 `window.nextSkip` 恒为 null（第 2 页取空）。
> 例：`?maxCount=50&skip=0` → 第 1 页 50 条 + `nextSkip=50`；`?maxCount=50&skip=50` → 第 2 页。
| `--count` | `count=1` | 计数文案（匹配 N / 共 M） | 只返回计数，不返回条目明细 |
| （项目作用域） | `projectIds`（多值） | 项目分组折叠（点击分组头） | 仅 overview 支持，WorkBuddy 项目 ID |
| （概览默认） | `openOnly`（布尔） | 「仅未完成」chip | 按**各项目自己的**状态配置排除已关闭状态（done/完成/cancel/取消/末位状态） |
| （兼容旧参数） | `includeDone` | — | `includeDone=false` ≡ `openOnly=true`（工具通道旧语义） |

## 3. 就绪（ready）判定（与上游 `src/utils/readiness.ts` 对齐）

对条目 `t`、项目状态配置 `statuses`：

1. **终态**：状态 == `statuses` 末位（大小写不敏感）→ 不 ready、不 blocked。归档项目条目视为不可开工。
2. 无依赖 → **ready**。
3. 每个依赖 `d`：
   - 在项目全量条目里归一化 id 找不到（或重复 id 歧义）→ `missingDependencies`（**阻塞**，fail-closed）；
   - 找到但状态非终态 → `blockingDependencies`（阻塞）；
   - 找到且终态 → 满足。
4. `isReady = 未终态 && blockingDependencies.length===0 && missingDependencies.length===0`；`blocked = 反向`。

> 与旧工具通道实现的差异（已确认收口）：旧实现「依赖找不到不算阻塞」，本次改为 fail-closed。
> 派发拦截仍走 `backlog-service.dispatchBacklogItem` 既有逻辑（本次不动）。

## 4. REST API

统一 query 参数名（camelCase；同时接受 kebab-case，如 `exclude-status`、`max-count`）；
多值参数支持**重复参数**与**逗号分隔**两种写法（同上游 CLI）。

### 4.1 `GET /api/projects/:id/backlog?<query>`

响应 `data`（在既有 `{initialized,truncated,config,items,tasks,...}` 上**只增不改**）：

```jsonc
{
  "initialized": true, "truncated": false, "config": {...},
  "items": [ { "...BacklogItem": true, "tasks": [...],
               "isReady": true, "blocked": false,
               "blockingDependencies": [], "missingDependencies": [] } ],
  "total": 42,            // 该项目全部条目数（未过滤）
  "matched": 7,           // 过滤后、窗口前
  "counts": { "open": 5, "done": 37, "ready": 3, "blocked": 2, "unassigned": 4 },
  "window": { "skip": 0, "total": 7, "nextSkip": 7, "cut": true },
  "facets": { "statuses": [{"value":"To Do","count":3}], "priorities": [], "types": [],
              "labels": [], "assignees": [], "milestones": [], "taskProjects": [] },
  "query": { "...解析后的 BacklogQuery（回显，便于调试）" }
}
```

- `count=1` → `items: []`，其余计数照常。
- `window.total` = 过滤后命中数（`matched`）；`window.nextSkip` = 下一页 `skip`（无更多为 null），分页用 `skip`+`maxCount`。
- 非法数值（`limit/skip/maxCount` 非数字或负数）→ 400 `{ok:false,error,code:"INVALID_QUERY"}`；
  非法 `sort` → 回退缺省（宽松，不报错）。
- `assignee` + `unassigned` 同时给 → 400 `INVALID_QUERY`。

### 4.2 `GET /api/backlog/overview?<query>`

`data` **仍是项目分组数组**（向后兼容），响应信封额外带 `query/summary/facets`：

```jsonc
{
  "ok": true,
  "data": [ { "projectId":"...", "projectName":"...", "nodeStatus":"ok", "initialized":true,
              "statuses":[...], "defaultStatus":"To Do",
              "total": 12, "matched": 3, "open": 4, "done": 8, "ready": 2, "blocked": 1,
              "facets": { ... },                 // 该项目全量条目统计
              "items": [ ...仅返回过滤命中项，带 isReady/blocked... ] } ],
  "query": { ... },
  "summary": { "projects": 3, "total": 30, "matched": 9, "open": 11, "ready": 5, "blocked": 3, "unreachable": 0 },
  "facets": { ... }                              // 所有项目并集
}
```

- `openOnly` 按各项目自身状态配置分别排除。
- 每个项目仍**失败隔离**（沿用 `overviewBacklog`）。
- `matched=0` 的项目仍返回（UI 显示「无匹配」并保留项目头），`nodeStatus≠ok` 照旧返回错误态。

## 5. 工具通道 `workbuddy_backlog_manage`

`filter` JSON 扩展（旧字段全部保留，均可用字符串或数组）：

```jsonc
{
  "status": ["To Do","In Progress"], "excludeStatus": ["Done"],
  "assignee": ["@alice"], "unassigned": false,
  "priority": ["high"], "type": ["bug"],
  "labels": ["backend"], "labelMatch": "all",
  "milestone": "M-1", "taskProject": ["web"],
  "parent": "TASK-12", "search": "登录 超时",
  "ready": true, "blocked": false, "includeDone": false,
  "sort": "priority", "orderBy": "priority", "order": "desc",
  "limit": 20, "maxCount": 20, "skip": 0, "count": false,
  "projectIds": ["proj-xxx"]
}
```

- `list` / `overview` 回包新增：`matched`、`window`、`counts`（overview 逐项目 + `summary`）、`facets`；
  条目新增 `isReady/blocked/blockingDependencies/missingDependencies`（`list`/`overview`/`view`）。
- `search` 动作保持「必填 `filter.search`」契约，内部复用同一查询引擎（正文检索）。
- 错误：`assignee`+`unassigned` 互斥 → `ok:false`；数值非法 → `ok:false`。

## 6. UI（web-ui.ts）

### 6.1 待办聚合页（「我的待办」）
- 顶部查询栏：搜索框、`筛选`（展开面板）、排序下拉 + 方向 chip、计数「匹配 N / 共 M」、`清除筛选`。
- 筛选面板（桌面一行、移动端折叠）：状态 / 优先级 / 类型 / 标签(AND) / 指派 / 未分配 / 里程碑 / 就绪 / 被阻塞，
  值来自 `facets`（无数据的维度不显示）；全部 chip 多选，选中即请求（搜索框防抖 300ms）。
- 每个项目分组头：`匹配 N / 共 M`，展开态沿用；无匹配项目显示「无匹配待办」而不隐藏（保留节点错误可见性）。
- 筛选条件编码进 `GET /api/backlog/overview?<query>`（服务端过滤，保证与 CLI/工具同语义）。
- **可选**：筛选面板底部显示等价 CLI 命令（`npx --yes backlog.md task list --ready --status "To Do" ...`），点击复制。

### 6.2 项目看板
- 同一查询栏（作用于该项目 `GET /api/projects/:id/backlog?<query>`）。
- 列头计数 = 过滤后列内条数；顶部提示「被筛选隐藏 X 条」；`matched=0` 显示空态 + 清除筛选入口。
- `window.cut` 时列底「显示更多」（带 `skip` 再请求，追加渲染）。
- 拖拽改状态、批量派发、编辑/删除、扫描未完成等既有能力不改；拖拽后用新查询重载（保持筛选）。
- 状态列「隐藏」= `excludeStatus`（可选，低优先级；有则放列头 ⊗）。

### 6.3 约束
- 移动端 ≤768px 可用：chip 可换行、点击区域 ≥44px、`overflow-x:auto` 横滑；微信 X5 内核兼容
  （**新代码禁止 `?.` / `??` / 模板字符串以外的新语法**；`Array.prototype.includes` 可用）。
- 计数/空态/筛选态都有明确文案；筛选条件不持久化（会话内保留，排序沿用 `localStorage['bl-sort']`）。

## 7. 模块与测试落点

| 层 | 文件 | 负责 |
|---|---|---|
| 解析/数据层 | `src/backlog.ts` | frontmatter 新字段（type/milestone/project/parent_task_id/subtasks/inline 数组）、`searchText` |
| 查询引擎 | `src/backlog-query.ts`（新） | `parseBacklogQuery / applyBacklogQuery / computeReadiness / buildBacklogFacets / sortBacklogItemsV2` |
| 查询引擎单测 | `src/backlog-query.test.ts`（新） | 逐条对照 §2/§3 语义 |
| REST | `src/router.ts` | 两接口参数接线、错误码、剥离 `searchText` |
| 服务层 | `src/backlog-service.ts` | overview 逐项目应用查询 + summary/facets |
| 工具 | `src/backlog-tool.ts` | filter 解析扩展、回包字段、`view` 带 readiness |
| 前端 | `src/web-ui.ts` | §6 控件与请求 |
| E2E | `scripts/backlog-e2e.mjs` | 真实 stub 节点上的查询链路 |
| 静态冒烟 | `scripts/smoke-standalone.mjs` | 前端控件/接口存在的静态断言 |
| 文档 | `README.md`、`docs/design-backlog-mcp-tool.md` | 用户可见说明 + 工具契约 |

## 8. 验收（Definition of Done）

1. `npm run build && npm run typecheck && npm run test:unit` 全绿（含新增查询引擎用例）。
2. `npm run smoke`、`npm run smoke:backlog` 全绿；e2e 覆盖：`--ready`、status 多值/exclude、priority/type/labels(AND)、
   assignee/unassigned、milestone、parent、search（正文命中）、sort、limit/skip/count、facets、overview 逐项目过滤 + summary。
3. 浏览器实测（桌面 1440×900 + 移动 390×844）：待办列表与项目看板都能筛选、计数正确、清空筛选恢复、无 JS 报错。
4. CLI 等价性说明文档化（§2 对照表），差异项（search 非模糊、assignee 包含匹配、默认排序沿用 createdAt 倒序）如实标注。

## 9. 验收证据（2026-11-02）

| 项 | 结果 |
|---|---|
| `npm run build` | 通过（tsc + 三个页面内联脚本 `node --check`） |
| `npm run typecheck` | 通过（0 error） |
| `npm run test:unit` | **161 passed / 0 failed**（新增 `src/backlog-query.test.ts` 23 条 + `backlog.test.ts` 新增 4 条） |
| `node scripts/backlog-e2e.mjs` | **144/144 全绿**（既有 66 + 查询能力 78） |
| `npm run smoke` | **91/91 全绿**（既有 83 + 查询 UI/接口静态断言 8） |
| 浏览器桌面 1440×900 | **22/22 PASS**（`qa-20261102-backlog-query/browser-desktop.mjs`） |
| 浏览器移动 390×844 + 微信 X5 UA | **16/16 PASS**（`browser-mobile.mjs`：热区 ≥44px、无横向溢出、面板单列、看板横滑） |
| 看板分页 >50 条 | **8/8 PASS**（`browser-pagination.mjs`：maxCount=50 → `#bl-more` → skip=50 追加到 63 条） |

浏览器 fixture：`qa-20261102-backlog-query/qa-env.mjs`（stub DSH 节点内存 FS，项目 A 10 条覆盖全查询维度、项目 B 63 条含分页语料）；
截图见同目录 `desktop-01..09` / `mobile-01..04`。
