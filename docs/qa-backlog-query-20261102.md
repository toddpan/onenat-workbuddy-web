# QA 报告 —— Backlog 任务查询能力集成（Backlog.md `task list` 全分类查询）

- 日期：2026-11-02
- 唯一权威契约：[`docs/design-backlog-query-filters.md`](design-backlog-query-filters.md)（§2 对照表 / §3 就绪 / §4 REST / §5 工具 / §8 验收）
- 被测范围：`src/backlog.ts`（frontmatter 新字段 + `searchText`）、`src/backlog-query.ts`（查询引擎，新）、
  `src/router.ts`（REST 接线）、`src/backlog-service.ts`（overview 逐项目 + summary/facets）、
  `src/backlog-tool.ts`（工具通道 filter）、`src/web-ui.ts`（待办聚合页 + 项目看板查询栏）
- 上游依据：MrLesk/Backlog.md v1.55.3（`runTaskList` / `createTaskFilterMatcher` / `readiness.ts` / `task-sorting.ts` / `list-window.ts`）

## 1. 环境与构建版本

| 项 | 值 |
|---|---|
| 代码版本 | `git HEAD = 0cead37` + 本次未提交工作树（`src/backlog-query.ts` 等新增/修改） |
| 构建产物（最终） | `dist/` 最终构建于 **2026-11-02 08:12**（含 frontend 的 `maxCount` 分页修正 + backend 工具通道收尾）：`server.js` md5 `3208379d…`、`web-ui.js` md5 `5aad2dc0…`、`backlog-query.js` md5 `d0d9bf2d…`、`backlog-tool.js` md5 `f339ac2c…`、`router.js` md5 `3b3db162…` |
| Node / 平台 | Node v26.7.0 / macOS（darwin） |
| 数据源 | stub DSH 节点（e2e 内存 FS）+ mock ONENAT（smoke） |
| e2e 语料 | 项目 P5 `/tmp/bl-e2e-ws5`：6 条待办（覆盖 status/priority/type/labels/assignee/milestone/parent/dependencies/正文检索词） |
| Lead 浏览器 fixture | `qa-20261102-backlog-query/qa-env.mjs`：项目 A 10 条（覆盖查询全维度）+ 项目 B 63 条（原 3 条 + 60 条批量分页语料，用于 `maxCount`/`skip` 分页验收） |

> 本报告「§3/§4」数字对应**最终构建（08:12）**上的复跑结果；该构建已含前端分页参数修正（`params.limit` → `params.maxCount`，见 §7.7）。
> 中间构建（08:08）上同一套断言也曾全绿（144/144、91/91），两次结果一致，说明分页修正未引入回归。

构建与执行命令（Lead 统一构建）：

```bash
npm run build        # tsc → dist/（QA 不在并行期自行构建，避免 dist 竞争）
npm run typecheck
npm run test:unit    # 含 src/backlog-query.test.ts
node scripts/backlog-e2e.mjs
npm run smoke
```

## 2. 覆盖矩阵（CLI 参数 × REST × 工具 × UI）

图例：✅ = 有自动断言/静态断言且通过；◐ = 有实现但仅间接覆盖；— = 不适用。

| CLI / 语义 | REST `GET /api/projects/:id/backlog` | 工具 `workbuddy_backlog_manage` | UI（待办聚合页 / 项目看板） | 结果 |
|---|---|---|---|---|
| `--ready` | ✅ 无依赖就绪 / 依赖未完成阻塞 / 依赖完成就绪 / 缺失依赖阻塞（§10.2） | ✅ `filter.ready` | ✅ 就绪 chip + 卡片 ✅/⛔ | ✅ |
| （扩展）被阻塞 | ✅ `blocked=1` + `blockingDependencies/missingDependencies` | ✅ `filter.blocked` | ✅ 被阻塞 chip | ✅ |
| `--status`（多值） | ✅ 重复参数 + 逗号两种写法 | ✅ 数组 | ✅ 状态 chips 多选 | ✅ |
| `--exclude-status` | ✅ 单值 + 与 status 同给排除优先 | ✅ `filter.excludeStatus` | ◐ 看板列头隐藏（可选，未做） | ✅ |
| `--assignee`（放宽包含匹配） | ✅ `alice` 同时命中 `alice@example.com` | ✅ 数组 | ✅ 指派 chips + 仅分配给我 | ✅ |
| `--unassigned` | ✅ 无指派人 2 条；与 assignee 互斥 400 | ✅ 互斥 → `ok:false` | ✅ 未分配 chip | ✅ |
| `--priority` | ✅ 多值并集 | ✅ 数组 | ✅ 优先级 chips | ✅ |
| `--type` | ✅ | ✅ 数组 | ✅ 类型 chips | ✅ |
| `--labels`（AND） | ✅ `backend,api` AND + `labelMatch=any` 扩展 | ✅ `labels` + `labelMatch` | ✅ 标签 chips（标注需全部命中） | ✅ |
| `--milestone` | ✅ 精确 + `m-8`/`8` 数字别名 | ✅ 单值 | ✅ 里程碑 chips | ✅ |
| `--parent` | ✅ id 归一化（`TASK-201` ≡ `task-201`） | ✅ 单值 | ◐ 看板内钻取（卡片「⊞ 子任务」） | ✅ |
| `--search` | ✅ 仅正文命中（标题不含该词）+ 空白切词 AND | ✅ `filter.search` | ✅ 搜索框（防抖） | ✅ |
| `--sort priority\|id\|ordinal` | ✅ `sort=id&order=asc`、`sort=priority` 高→低 | ✅ `sort/order` | ✅ 排序下拉（含 ID）+ 方向 chip | ✅ |
| `--limit` | ✅ 硬截断（`limit=3` → 3 条、`nextSkip=null/cut=false`） | ✅ `filter.limit` | ◐ UI 不用它分页（契约 §2 明确） | ✅ |
| `--max-count` | ✅ 分页窗口（`maxCount=3&skip=3` 第 2 页、`nextSkip` 驱动） | ✅ `filter.maxCount` | ✅ 看板「显示更多」 | ✅ |
| `--skip` | ✅ `window{skip,total,nextSkip,cut}` | ✅ `skip` | ✅ 显示更多翻页 | ✅ |
| `--count` | ✅ `items=[]` 计数照常 | ✅ `count` | ✅ 计数文案「匹配 N / 共 M」 | ✅ |
| facets | ✅ 7 维度计数（statuses/priorities/types/labels/assignees/milestones/taskProjects） | ✅ `facets`（顶层） | ✅ 筛选项值来源 | ✅ |
| overview 逐项目过滤 | ✅ 逐项目 `total/matched/open/done/ready/blocked` + 信封 `summary/facets/query` | ✅ overview 动作同字段（扁平） | ✅ 项目分组「匹配 N / 共 M」 | ✅ |
| `openOnly` / `includeDone` | ✅ 逐项目排除已关闭；`includeDone=false` ≡ `openOnly=true` | ✅ 默认剔除已完成 | ✅ 仅未完成 chip | ✅ |
| `projectIds` | ✅ overview 项目作用域 | ✅ | ◐ 按项目分组 | ✅ |
| 非法参数 | ✅ `limit=0` / `skip=-1` / `limit=abc` / assignee+unassigned → 400 `INVALID_QUERY` | ✅ → `ok:false` | ✅ 错误提示捕获 | ✅ |
| 回包剥离 `searchText` | ✅ 断言 | ✅（同一序列化路径） | — | ✅ |
| `matched=0` 项目仍返回 | ✅ 5 个项目分组都在、P5 `matched=0` | ✅ | ✅「无匹配待办」不隐藏分组头 | ✅ |
| X5 旧内核兼容 | — | — | ✅ 新增查询段无 `?.` / `??`（静态断言） | ✅ |

## 3. e2e 结果（`node scripts/backlog-e2e.mjs`）

执行时间 2026-11-02 08:12，**最终构建（08:12）**；**共 144 项断言全部通过，退出码 0**。

| 项 | 命令 | 结果 |
|---|---|---|
| 既有回归（B1-B7 / 工具通道 / 采集，66 条） | `node scripts/backlog-e2e.mjs` | ✅ 66/66 |
| 新增查询能力（78 条，§10） | 同上 | ✅ 78/78 |
| 合计 / 退出码 | 同上 | ✅ 144/144，EXIT=0 |

新增断言分布（§10）：

| 分组 | 条数 | 关键断言（实测值） |
|---|---|---|
| 语料准备 / P5 初始化 | 2 | 初始化成功；6 条 frontmatter 直写 stub FS |
| 全量列表 + 计数 + facets + window + 剥离 searchText | 9 | `total=6/matched=6`；默认 `createdAt desc`（task-206 最前）；`counts{open:5,done:1,ready:3,blocked:2,unassigned:2}`；facets 7 维计数（To Do=4、high=2、api=4、M-1=3 等）；`searchText` 全部剥离 |
| ready/blocked 判定（§3 四条规则） | 7 | 201 就绪 / 202 blocked←201 / 205 就绪←203(Done) / 206 blocked←task-999（missing，fail-closed）/ 203 终态两 false；`ready=1`→3 条、`blocked=1`→2 条 |
| 过滤维度 | 15 | status 多值（重复/逗号）、excludeStatus、排除优先、priority、type、labels AND/any、assignee 包含匹配、unassigned、milestone（M-2 与数字别名 2）、parent（TASK-201 归一化）、search 正文命中（标题不含「幂等」）+ 多词 AND |
| 排序 / 切窗 / 计数 | 9 | `sort=id&order=asc`；`limit` 硬截断（3 条 + nextSkip=null/cut=false）；`maxCount=3` 第 1/2 页（nextSkip=3→null）；`limit=3&maxCount=5&skip=2` 只剩 1 条（证明 limit≠maxCount 别名）；priority asc 高→低 / desc 低→高；`count=1` items=[]；query 回显 |
| 非法参数 | 4 | `limit=0`、`skip=-1`、`limit=abc`、assignee+unassigned → 400 `{ok:false,code:"INVALID_QUERY"}` |
| overview | 9 | `projectIds` 只返回 P5；逐项目 `total=6/matched=6/open=5/done=1/ready=3/blocked=2` + facets；信封 `summary{projects:1,total:6,matched:6,open:5,ready:3,blocked:2,unreachable:0}` + facets 并集 + query 回显；`openOnly=1` → matched=5 无 Done；`search=幂等` → matched=1；`search=绝不存在关键词xyz` → 5 个分组全返回、P5 matched=0 |
| 工具通道 list / view / overview / search | 23 | filter 新字段 10 组（status 数组/excludeStatus/priority/type/labels+labelMatch/milestone/parent/search/sort/limit+maxCount/skip/count/ready/blocked）；回包 `total/counts{…}/window/facets`；条目 `isReady/blocked`；`view` 带 readiness + `blockingDependencies`；`overview` 逐项目扁平计数 + `summary` + 顶层 facets + includeDone；非法 filter → `ok:false`；`search` 缺 `filter.search` 仍 `ok:false` |

Lead 侧 fixture（`node qa-20261102-backlog-query/qa-env.mjs --check`）已全绿（Lead 报告）：项目 A 10 条 + 项目 B 63 条，
`ready=6`、`facets` 有值、`searchText` 已剥离、`overview A.matched=8`，用于浏览器验收（含 >50 条分页场景）。

## 4. 静态冒烟结果（`npm run smoke`）

执行时间 2026-11-02 08:12（为避免与 Lead 并行跑冒烟抢默认端口，QA 用 `SMOKE_PORT=18097 SMOKE_MOCK_PORT=18087` 跑同一脚本）；
**最终构建（08:12）**；**共 91 项断言全部通过，退出码 0**。

| 项 | 命令 | 结果 |
|---|---|---|
| 既有回归（83 条） | `npm run smoke` | ✅ 83/83 |
| 新增查询 UI 静态断言（8 条） | 同上 | ✅ 8/8 |
| 合计 / 退出码 | 同上 | ✅ 91/91，EXIT=0 |

新增 8 条静态断言（对象 = 服务端内联渲染的控制台源码字面量，锚点缺失即回归）：

1. **待办查询栏存在**：`id="bl-qbar"` / `id="bl-q"`（搜索框）/ `class="bl-qinput"` / `placeholder="搜索标题…"` /
   `id="bl-f-toggle"`（⚙ 筛选）/ `id="bl-s-order"`（排序下拉）/ `id="bl-s-dir"`（↓/↑ 方向）/ `id="bl-qcnt"`（计数）/ `data-blf-clear="1"`（清除筛选）。
2. **筛选面板存在**：`function blFilterPanelHtml` + facets 驱动的 chips 行（状态/优先级/标签/里程碑…）+
   `'✅ 就绪（可开工）'`、`'⛔ 被阻塞'`、`'仅未完成'` 三个 toggle + 等价 CLI 命令展示（`blCliText`）。
3. **计数与筛选态提示**：`'匹配 ' + matched + ' / 共 '`、`被筛选隐藏 X 条`、`无匹配待办`（分组头保留）。
4. **就绪态徽标**：`blReadyBadgeHtml` + `>✅ 就绪</span>` + `>⛔ 阻塞</span>` + `bl-st-ready`。
5. **看板「显示更多」分页**：`id="bl-more"` + `data-skip=` + `window.nextSkip` + `params.skip = String(skip)`。
6. **前端请求带查询参数**：`blQueryParams` / `blQs` + `p.search/openOnly/ready/blocked/labelMatch/milestone/unassigned/status/priority/sort/order` +
   `'/backlog/overview' + (qs ? '?' + qs : '')` + 项目看板 `encodeURIComponent(b.projectId) + '/backlog?' + blQs(params)`。
7. **facets 消费 + 排序维度新增 id**：`BL_FACET_KEYS`（7 维）+ `blNormFacets` + `facets.statuses` + 排序下拉 `['id', 'ID']`。
8. **X5 旧内核兼容**：新增查询段（`查询/筛选状态` → `⌘K` 锚点之间，约 50KB 源码）无 `?.` / `??`。

> 说明：断言按 Lead 要求写成「锚点存在即通过」的宽容形式，但锚点全部取自**真实实现**（先用 `grep dist/web-ui.js` 确认）；
> 控件 id/文案改名会导致断言失败——属预期回归保护，改文案时同步 `scripts/smoke-standalone.mjs`。

## 5. 单元测试 / 构建

| 项 | 命令 | 结果 |
|---|---|---|
| TypeScript 类型检查 | `npm run typecheck` | ✅ 通过（0 error，全量 `tsconfig.server.json`） |
| 单测（含 `src/backlog-query.test.ts` 查询引擎逐条 §2/§3 语义） | `npm run test:unit` | ✅ **161 passed / 0 failed**（含 `backlog-query.test.js` 23 条 + `backlog.test.js` 25 条；`package.json` 的 tsc 输入与 `node --test` 列表已加入 `backlog-query.ts/.test.ts`） |
| 构建 | `npm run build` | ✅ Lead 最终构建通过（2026-11-02 08:12；tsc + 三页面内联脚本 `node --check`），e2e/smoke 已在该构建上复跑全绿 |

## 6. 浏览器实测（契约 §8.3）

**由 Lead 使用 ego-browser 执行，脚本与截图已入库 `qa-20261102-backlog-query/`**；fixture 项目 A 10 条 + 项目 B 63 条（含 60 条分页语料）。
运行方式：`ego-browser nodejs < qa-20261102-backlog-query/browser-*.mjs`。

| 视口 / 场景 | 脚本 | 结果 | 截图 |
|---|---|---|---|
| 桌面 1440×900（显式 Emulation 覆盖）：待办聚合页筛选 / 搜索 / 就绪阻塞 chip / 项目看板 / 看板筛选 / 无 JS 报错 | `browser-desktop.mjs` | ✅ **22/22 PASS** | `desktop-01-backlog-overview.png` … `desktop-07-final.png`（7 张） |
| 移动 390×844 + 微信 X5 UA：chips 换行、热区 ≥44px、无横向溢出、筛选面板单列、看板列横滑 | `browser-mobile.mjs` | ✅ **16/16 PASS** | `mobile-01-backlog-overview.png` … `mobile-04-board-filter.png`（4 张） |
| 分页 >50 条：首屏 `maxCount=50` → 50 卡；`#bl-more`「还有 13 条」→ skip=50；点击后 50→63 卡按 itemId 去重；分页耗尽按钮消失 | `browser-pagination.mjs` | ✅ **8/8 PASS** | `desktop-08-pagination-page1.png`、`desktop-09-pagination-page2.png` |

关键实测值（Lead 实测，全程 0 JS 错误）：

- 待办聚合页：计数「**匹配 10 / 共 13**」；搜索「登录」rows 10→1 且请求带 `search=`；筛选 chips 共 31 个
  （status 3 / priority 3 / type 7 / label 6 / assignee 2 / milestone 3 / taskProject 2 / toggle 5）；
  「✅ 就绪」chip 下 rows 全部带 ✅ 徽标、「⛔ 被阻塞」chip 下 rows 全部带 ⛔ 徽标。
- 项目看板：A 项目 10 卡 3 列；`high` 过滤后 2 卡 + 提示「被筛选隐藏 8 条」；看板搜索「幂等」正文命中 task-2。
- ⌘K：能检索到 `Done` 条目 task-3（跨项目聚合未被 openOnly 默认过滤）。
- 契约 §6.3 移动端要求（≤768px 可用、chip 换行、点击区 ≥44px、`overflow-x:auto` 横滑、微信 X5 兼容）实测通过。

## 7. 已知差异与限制（如实标注，非缺陷）

1. **search 非模糊匹配**：上游用 Fuse 模糊；WorkBuddy 为「空白切词 + 全部子串命中（大小写不敏感）」，
   确定性、无额外依赖，但对拼写错误/语序变化不宽容。
2. **assignee 为包含匹配**：上游精确匹配；WorkBuddy 双向包含 + 忽略 `@` 前缀（兼容既有「仅分配给我」）。
   副作用：`assignee=ali` 会命中 `alice`（宽松行为已文档化）。
3. **默认排序沿用 `createdAt` 倒序**：不采用上游 `ordinal→priority→id` 默认（沿用 WorkBuddy 既有 TASK-SORT-2 UX）。
4. **priority 的 `order` 语义沿用既有实现**：`sort=priority&order=asc` = 高→低（由 `src/backlog-query.test.ts` 固定），
   与「数值升序」直觉相反；同权重内 asc 按 id 升序、desc 按 id 倒序（e2e 已双向断言）。
5. **milestone**：上游 Fuse 最近匹配；WorkBuddy 精确 id/标题（含 `m-8`/`8` 数字别名）→ 退化为标题包含。
6. **就绪 fail-closed**：依赖找不到（或重复 id 歧义）视为阻塞（与上游一致），但旧工具通道实现曾「找不到不算阻塞」，
   本次已收口——依赖缺失会阻塞就绪判断（派发拦截仍走 `dispatchBacklogItem` 既有逻辑，未改）。
7. **`limit` 与 `maxCount` 不是别名**（上游语义，契约 §2 已明确）：`limit` = 排序后硬截断命中集合；
   `maxCount` = `skip` 之后的分页窗口大小。**UI 分页必须用 `skip`+`maxCount`**；用 `limit` 分页会让
   `window.nextSkip` 恒为 null（第 2 页取空）。08:08 中间构建的前端曾用 `params.limit` 分页，**最终构建（08:12）
   已修正为 `params.maxCount`**（e2e/smoke 已在最终构建上复跑全绿）。
8. **`window.cut` 语义**：实现为 `end - skip < limited.length`，即「窗口是否截断了候选集合（含 skip 掉的前缀）」，
   因此 `skip>0` 且无下一页时也可能 `cut=true`（如 `skip=4` → 2 条、`nextSkip=null`、`cut=true`）。
   **是否还有下一页只看 `nextSkip`**；这与上游以 `page.total` 为分母的口径有细微差，不影响分页行为（e2e 已按实现断言）。
9. **facets 在未过滤语料上统计**：选中某个筛选不会让其它筛选项消失/计数变小（UI 生成筛选项的稳定来源）。
10. **筛选不持久化**：筛选条件仅会话内保留（排序沿用 `localStorage['bl-sort']`），刷新页面后清空。
11. **工具通道 overview 逐项目计数为扁平字段**（Lead 2026-11-02 契约确认：`total/matched/open/done/ready/blocked`，
    与 REST §4.2 一致）；`facets` 在工具 overview 回包**顶层**，不下发到逐项目行。

## 8. 遗留风险

1. **真实项目自定义状态**：本地 stub 的 `statuses` 为默认三态；真实项目若配置中文状态或追加 `Cancelled`，
   `openOnly/ready` 的「终态=末位」「已关闭语义名」判定建议在 1 个真实项目抽查（本次未覆盖）。
2. **e2e overview 项目分组数固定**：断言按本次测试数据固定为 5（P1-P5），后续 e2e 增加项目需同步更新
   （`overview：matched=0 的项目仍返回` 一条）。
3. **smoke 静态断言依赖源码锚点**：控件 id/文案/注释锚点改名会导致断言失败（预期回归保护），需同步脚本。
4. **工具通道 overview 形状**：若后续把逐项目计数改为 `counts` 聚合对象，需同步 e2e（当前按 Lead 确认的扁平字段严格断言）。
5. **`window.cut` 口径**：本实现含「skip 掉的前缀」语义（§7.8），UI 只看 `nextSkip`，若后续有调用方按 `cut` 判断
   「还有下一页」需注意；e2e 已按实现锁定，改口径要同步断言与文档。

## 9. 交付文件

本任务（QA/文档）产出：

| 文件 | 内容 |
|---|---|
| `scripts/backlog-e2e.mjs` | 新增 §10「任务查询能力」e2e（+435 行 / 78 条断言，既有 66 条未改）：stub 内存 FS 直写 6 条 Backlog.md frontmatter 语料，覆盖 REST 全过滤维度/排序/切窗/facets/就绪判定/非法参数 + overview 逐项目过滤/summary/openOnly/matched=0 + 工具通道 filter/回包/view readiness |
| `scripts/smoke-standalone.mjs` | 新增 8 条前端静态断言（+75 行）：查询栏/筛选面板/计数提示/就绪徽标/看板「显示更多」/请求 query 参数/facets 消费+排序 id/X5 无 `?.`·`??`；既有 83 条全绿 |
| `README.md` | 新增「待办任务（Backlog）与查询筛选」章节（+122 行）：接口示例、参数表、就绪判定、CLI 等效对照表、已知差异、工具通道示例；同步 smoke 项数与 `limit/maxCount` 最终语义 |
| `docs/qa-backlog-query-20261102.md` | 本报告（覆盖矩阵、逐项结果、已知差异、遗留风险、浏览器实测） |

协作产物（Lead / 其他 teammate）：`qa-20261102-backlog-query/`（fixture + 3 个浏览器脚本 + 13 张截图）；
Lead 同步更新了 `skills/onenat-workbuddy/skills/backlog.md` 与 `skills/workbuddy-mcp/SKILL.md` 的 filter 字段说明（供 AI 使用）。
