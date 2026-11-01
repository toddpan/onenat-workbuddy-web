# Backlog 未完成任务自动采集 · 实施方案 v3（双源：任务账本 + 工作区代码/文档）

> 状态：**完整方案（v3）；其中「简版手动采集」已落地** —— 见 `docs/feat-backlog-collect-mvp.md`（看板顶部「🔍 扫描未完成」按钮：A+B 双源、预览勾选、幂等去重）。其余（定时/状态文件/门禁/工具通道）待排期。
> 决策来源：用户 2026-11-01 答复 —— **D1 = workbuddy 里的任务 + 工作区的代码和文档（A+B 双源）**；**D6 可选（不硬锁）**；**其余决策点按本方案推荐值锁定**（§13）。
> v3 变更：D1 从「A 或 B 二选一」改为「**A+B 双源**」，B 升级为一等公民（§4，不再只是后置的 LLM 扫描）；D6 活跃窗口改为**可配/可关的软门禁**；新增 B 的增量扫描（fileIndex）、双 sourceKey 命名空间、双源预算；分期调整为 M1(A) / M2(定时) / M3(B) / M4(可选 LLM + 工作区活跃探针)。
> 关联文档：`docs/design-backlog-integration.md`（backlog 数据层/派发/回写）、`docs/design-backlog-mcp-tool.md`（工具通道契约）、`docs/feat-task-auto-archive.md`（同类周期扫描先例）
> 事实基线：本文档「已有能力」均在 `src/` 中按行号核实（2026-11-01 13:40）；未核实项单独标注。

---

## 0. 一页结论（评审看这段就够）

| 问题 | 结论 |
|---|---|
| 做不做 | **做**。失败/部分成功任务 7 天后被自动归档、没有跟进池；backlog 是项目未完成事项的唯一看板。工作区里「代码 TODO / 文档未勾选」同样没有入口。 |
| 数据源 | **A 任务账本**（`WorkStore.getTasks()`）+ **B 工作区代码/文档**（确定性标记扫描），两源独立命名空间、独立预算、同一采集器。 |
| B 用不用 LLM | **不用**（MVP）。B = 正则/规则扫描（TODO/FIXME、未勾选验收、文档状态标记），零 token、可单测、无幻觉；LLM 语义判断后置 M4（需再确认）。 |
| B 能扫多大 | 单项目单次 ≤ 60 目录 / 300 文件（≈ 360 请求，首扫 20–30s）；增量轮通常 ≤ 80 请求；默认 7 天/项目、单轮最多 3 个项目。节点**没有递归/grep 端点**，所以「几千目录的大仓全量深扫」本期做不到——用 `scanRoots` 收窄或手动采；要突破需扩 dsh-web-service 端点（M4+ 评估，§4.6）。 |
| 会扫全部项目吗 | 不会。**五层门禁**：项目排除 → 活跃门禁（纯内存）→ 水位线/增量 → 节点 IO（仅剩少量项目）→ 预算与顺序。A/B 共用同一套门禁，B 另有「扫描间隔」限制频率。 |
| 会往看板灌垃圾吗 | 三道闸：**预览确认**（手动必预览）、`auto-collect` 标签可过滤、上限（单项目 20 / 单轮 60）+ 只扫近 30 天变更文件（B）。 |
| 会不会自己激活自己 | 不会。活跃度只看 **WorkTask.updatedAt**（采集只写 backlog 文件、不碰任务）；B 扫描**硬排除 `backlog/` 目录**。 |
| 定时怎么接 | 扩展既有 `ScheduledTask.action`，复用规则/手动执行/运行历史/监控，**存量定时任务零迁移**。 |
| 状态放哪 | 独立 `backlog-collect-state.json`（不进 store.json：store 全量重写，15.7MB 单次落盘 ~110–300ms，见 store.ts:44-46/216-219）。 |
| 默认开吗 | **默认关闭**（D9），部署后零行为变化，用户显式开启。 |
| 分期/工期 | M1 A 源+手动（2–3 人日）→ M2 定时（1–1.5）→ M3 B 源（2–3）→ M4 可选 LLM（1–2）；QA/回归 1–1.5 天。 |
| 唯一需要评审点头的 | ① B 默认「周频」扫描（7 天/次，可配）；② B 候选「只登记不自动派发」（与 A 一致）。按推荐执行，不同意见一句话即可改。 |

---

## 1. 需求（含本轮用户确认）

1. **手动触发**：用户在看板/我的待办点一下，把项目里没做完的事登记成 backlog 待办。
2. **定时触发**：平台按规则自动扫描**所有项目**，把未完成事项挖出来变成待办。
3. **只处理最近有推进的项目**：长期没动的项目不要反复扫，避免无意义操作、避免生成没人看的垃圾条目。
4. **（本轮确认，D1）未完成事项 = 两类**：
   - **A. workbuddy 里的任务**：失败/部分成功/卡死中断的任务；
   - **B. 工作区的代码和文档**：代码里的 `TODO/FIXME`、文档里未勾选的验收项/「待确认」「未完成」标记、未完成的设计文档。
5. **（本轮确认，D6）活跃窗口是可选/可配的软门禁**，不是硬编码 7 天。

---

## 2. 结论与关键取舍

### 2.1 为什么是双源，而不是「A 先做 B 后置」

A 和 B 补的是**两个不同的缺口**，不能互相替代：

| 源 | 覆盖的「未完成」 | 唯一性 |
|---|---|---|
| A 任务账本 | 派发了但没做完的事（failed / partial_success / 卡死） | 只有 WorkBuddy 有任务账本；这是执行闭环的产物 |
| B 工作区 | 还没变成任务的事（代码里挂着的 TODO、设计文档里没勾的验收） | 只有工作区文件里有；任务账本永远采不到 |

两者的**成本与风险不对称**（A 零节点 IO、无幻觉；B 有节点 IO、有误报面），所以：**同一份方案、同一个采集器、分两期交付**（A 先行上线 1 周验证采集口径，再开 B），但 B 在本方案里是**确定范围**，不是「以后再说」。

### 2.2 为什么 B 用确定性扫描而不是 LLM

- **可控**：一条正则 + 白名单就是判定，误报可解释、可复现、可单测；LLM 扫描要 JSON 契约 + 解析失败路径 + 幻觉兜底，成本与不确定性都高一个量级。
- **零 token**：定时每天跑也不烧钱。
- **可增量**：按文件 mtime 只扫变化的文件；LLM 方案很难增量（要重新喂上下文）。
- **后置语义扫描**：真正需要「理解」的（比如判断一份设计文档是否「实质上未完成」）留到 M4，用严格 JSON 契约，且**不让 agent 直接写文件**（服务端校验后统一 `createItem`）。

### 2.3 成本与安全底线

1. **常规定时一轮，A 的节点请求数 ≈ 0**：A 的候选筛选与活跃判定全在内存；B 只对「活跃 + 到扫描间隔」的少量项目做 IO（单轮 ≤3 项目，增量轮通常 ≤80 请求/项目）。
2. **单轮有硬预算**：单项目 20 条、单轮 60 条、超出记 `deferred` 下轮再采；B 另有目录/文件/字节上限。
3. **默认关闭 + 预览确认**：不确认不落盘（手动）；定时落盘也带 `auto-collect` 标签，可一键过滤/批量关。
4. **失败隔离**：单项目节点不可达 → 记 `error`，不重试（端口漂移语义），不影响其他项目。
5. **零侵入**：不改 ONENAT 服务端、不改 dsh-web-service（README D6）——只用节点既有 `/fs/list`、`/fs/download`、`/fs/upload`、`/fs/remove`、`/fs/mkdir`。

### 2.4 代码现状基线（已核实，行号以 2026-11-01 13:40 为准）

| 能力 | 现状 | 证据 |
|---|---|---|
| backlog 数据层 | 已实现 `listBacklog/readItem/writeItem/createItem/deleteItem/initBacklog/probeBacklog` 等 | `src/backlog.ts:328-700` |
| 列表 IO | `fsList(tasksDir, all=1)` + 逐文件下载，并发池 6；**未读 mtime/size**，无缓存/上限 | `src/backlog.ts:348-379`；`pool` :309-320 |
| 建条目 | `readConfig` + 全量 list → `max+1` 分配 id；**无锁、无幂等键、无来源标记** | `src/backlog.ts:418-480` |
| 写文件 | 远端 `fsUpload`；同名上传会生成 `-1` 副本 → `writeItem` 先 `fsRemove` 再上传再 verify | `src/backlog.ts:389-416` |
| 来源标记 | `sourceKey` / `wb:source` **不存在**（docs 里只有方案稿） | 全仓 grep 0 命中 |
| 工具通道 | `workbuddy_backlog_manage` 12 个 action，**无 collect** | `src/backlog-tool.ts:263-296/332-738`；`src/tool-ops.ts:1489/1502` |
| 定时任务 | `ScheduledTask` 无 `action` 字段；`fire()` 按 agent 派发；`ScheduleRunItem` 只有 agentId/agentName/taskId/taskTitle/error/attempts | `src/types.ts:542-603`；`src/scheduler.ts:80-185` |
| 任务状态 | `TaskStatus = draft\|running\|completed\|failed\|partial_success\|success\|cancelled` | `src/types.ts:311` |
| 任务来源字段 | `backlogRef`、`backlogWritebackFailed`、`archivedAt`、`projectId` 均已存在 | `src/types.ts:447-468` |
| 任务更新语义 | `appendTurnText`/`mutateTask`/`upsertTask`/`bulkUnarchive` 会写 `updatedAt`；**archiveSweep 不写** | `src/store.ts:163/310/581/612/696` |
| 项目字段 | `dshRef/workspace/apiKey/archivedAt/updatedAt`；**无 backlogEnabled** | `src/types.ts:261-292` |
| 持久化 | `store.save()` 全量 `JSON.stringify` + tmp/rename 单飞；流式有 3s 尾随合并 | `src/store.ts:207-271`；注释 :44-46/216-219 |
| 周期扫描先例 | `archiveSweep`：30s 首轮 + 30min interval、`sweeping` 重入保护、有变更才 save | `src/store.ts:150-196` |
| 节点 FS 能力 | `fsList`：**单层** `opendir`，`all=1` 才含文件元数据；entries 带 `name/path/type/hidden`（`size/mtime` 节点有则给，**目录也有 mtime**）；**单目录 2000 条硬上限 + `truncated`，无分页/无递归/无 glob/无 ignore 参数**；15s 超时。`fsDownload`：流式整文件读，**无 Range**，60s 空闲超时；`fsUpload` 同名生成 `-N` 副本；`fsRemove`/`fsMkdir`。**无 stat/etag/hash、无 grep/内容搜索、无批量读** | `src/remote-client.ts:387-415`（fsList）/`:469-481`（download）/`:501-542`；节点实现 `dsh-web-service/src/fs.ts:20/62/95-108/127/152-156/165-203` |
| UI 钩子 | 看板 `blBoardHtml`(web-ui.ts:14910)、我的待办 `blOverviewHtml`(14857)、弹窗 `openModal`(14383)、toast(2936)、定时任务抽屉 `openScheduleDrawer`(12030) | `src/web-ui.ts` |
| 测试 | 单测 `backlog.test.ts` 自带内存 fake FS（无共享 harness）；e2e `scripts/backlog-e2e.mjs` stub **无 mtime、所有项目共用一份 FS**；`npm run smoke` 实跑 **81 项** | `src/backlog.test.ts:221-267`；`scripts/backlog-e2e.mjs:60-135`；`scripts/smoke-standalone.mjs` |

> 结论：M1/M2 几乎零新增架构；M3 的 B 扫描也**只依赖既有 `/fs/*`**，不需要扩节点端点。缺口集中在：来源标记、per-project 锁、状态文件、`action` 分支、采集路由/工具/UI、e2e stub 升级。

---

## 3. 数据源 A：任务账本（WorkTask）

### 3.1 候选判定（默认值，可配）

命中即候选：

- `status === 'failed'`（失败）
- `status === 'partial_success'`（部分成功）
- `status === 'running'` 且 `now - updatedAt > staleRunningHours(默认 2h)`（疑似卡死/中断）
- `status === 'cancelled'` / `'draft'`：**默认不采**（可配 `includeCancelled/includeDraft` 打开）
- `status === 'success' | 'completed'`：终态成功，**永不采**

### 3.2 硬性排除

- `task.backlogRef` 非空 —— **断自激环**：backlog 派生的任务再失败，不再回采
- `task.archivedAt` 非空；项目 `project.archivedAt` 非空
- 采集窗口外：`updatedAt < now - lookbackDays(默认 30)`（首次上线不挖历史坟）
- 已登记过（§8 去重：sourceKey 命中或项目水位线之后无新素材）

### 3.3 条目内容（从任务账本抽取，不调 LLM）

- 标题：`task.title`（加来源前缀由 labels 承担，不改标题语义）
- 失败/中断原因：`task.summary?.finalConclusion || summary?.overview`（`src/types.ts:408-416`），无汇总时取最后一轮 agent 文本前 200 字
- 关联会话：`#/task/<id>`；若关联 backlog 派生则已被排除
- 原因标签：`failed` / `partial` / `stale`

---

## 4. 数据源 B：工作区代码/文档（本轮新增，重点）

### 4.1 「未完成事项」的确定性定义

只认**明确标记**，不做语义猜测：

| 类别 | 标记 | 适用文件 | 说明 |
|---|---|---|---|
| 代码待办 | 行内 `TODO` / `FIXME` / `XXX` / `HACK` / `待办` / `待补充` / `未完成`（词边界、大小写不敏感） | 代码扩展名白名单（`.ts .tsx .js .jsx .mjs .cjs .py .go .java .kt .rs .c .h .cpp .hpp .cs .php .rb .sh .sql .vue`） | 取标记行去注释符、截 60 字符为标题 |
| 文档未勾选 | Markdown 列表 `- [ ]`（未勾选） | `.md` | 每文件最多取 3 条，其余折叠为 1 条「另有 N 项未勾选」 |
| 文档状态标记 | `TBD` / `待确认` / `待定` / `WIP` / 「状态：草稿」/「状态：进行中」 | `.md` | 同一文件多条只取 1 条（避免刷屏） |
| 空实现占位 | `not implemented` / `未实现` / `TODO()`（可选开关） | 代码 | 默认关，噪音大，留给 M4 评估 |

不认（明确写下，避免后续误加）：普通注释里的「以后」「优化」「注意」等自然语言；测试夹具里的 TODO 示例（可通过 `excludeGlobs` 排除）；`backlog/` 目录里的条目本身。

### 4.2 扫描范围与忽略规则

- **根**：`project.workspace`（节点上的绝对路径）。节点只提供**单层 listing**（无递归参数），所以目录树由平台侧 BFS 逐层列。
- **扫描根（`scanRoots`，重要成本开关）**：默认尝试 `src / docs / scripts / lib / app / packages / test / tests / backend / frontend / server / web`（**存在才扫**）；一个都不存在时回退到 workspace 根。采集设置里可按项目改（如 `["src","docs","scripts"]`），是控制目录数最有效的手段。
- **深度**：`maxDepth` 默认 4（相对各 scanRoot）。
- **目录上限**：`maxDirs` 默认 60/项目/次；达到上限置 `scanTruncated` 并停止更深遍历（**广度优先，优先浅层**）。
- **单目录 2000 条上限**：`fsList` 命中 `truncated` 时**跳过该目录**并记 `dirTruncated`（只扫前 2000 条会得出「残缺结论」，不如明确跳过并在运行记录里可见）；`node_modules` 级目录本就在忽略列表里。
- **硬排除目录**（不可配置，防止自激与无效 IO）：`backlog`、`.git`、`node_modules`、`dist`、`dist-test`、`build`、`out`、`coverage`、`.next`、`.nuxt`、`.cache`、`vendor`、`.venv`、`__pycache__`、`.dsh-uploads`、`archive`。
  - `backlog` 必须在硬排除里：**采集写的就是它**，否则形成「采集→文件变化→再采集」的自激。
- **排除文件**：`*.min.js`、`*.map`、lock 文件（`package-lock.json`/`pnpm-lock.yaml`/`yarn.lock`）、二进制/图片/字体/压缩包、`size > maxFileBytes`（默认 200KB，**下载前用 listing 的 size 预筛，不浪费一次整文件下载**）、文件名含 `.bak`/`.tmp`。
- **时间窗**：只扫 `mtime >= now - modifiedWithinDays(默认 30)` 的文件。
- **项目级扩展**：`excludeGlobs`（如 `qa-*`、`assets/*`）可在采集配置里加，默认只含上面硬排除。

**mtime 缺失的降级（如实声明）**：若节点 `fsList` 对某项目未返回 mtime（版本/实现差异），无法做增量与时间窗 → 退化为「只扫 scanRoot 浅层（depth ≤2）、`maxFiles` 降到 100、不做 mtime 窗口」，运行记录标 `mtimeUnavailable`，UI 采集设置里显示「该节点未返回 mtime，工作区扫描能力受限」。不猜测、不静默全量下载。

### 4.3 增量扫描（fileIndex）与首扫策略

状态文件里按项目维护 `fileIndex: { relPath: mtime }`（上限 600 条，按 mtime 降序修剪）：

1. **首扫（无 fileIndex）**：BFS 列目录（≤ maxDirs）→ 收集文件清单（含 mtime/size）→ 过滤扩展名/忽略项/大小/时间窗 → 按 mtime 降序取前 `maxFiles`（默认 300）→ 逐个整文件下载并扫描 → 建索引。
2. **后续扫描**：列目录（目录数不变，≤ maxDirs）→ 与 fileIndex diff → **只下载「新增 / mtime 变化 / size 变化」的文件**（通常个位数到几十个）→ 扫描后合并索引、删除失效路径。
3. **索引超上限**：只保留最近 600 个文件，其余标记 `indexTruncated`；被挤出的文件下一轮仍会被 listing 看到，按 mtime 窗口 + 上限兜底，不会永久漏采。
4. **mtime 缺失**：见 §4.2 的降级路径（浅层 + 小上限 + 标注）。
5. **成本上限（本方案的硬约束）**：

| 项 | 上限 | 说明 |
|---|---|---|
| 目录 listing | ≤60 请求/项目/次 | 每目录 1 次 `fsList(all=1)`，15s 超时 |
| 文件下载 | 首扫 ≤300 请求；增量通常 ≤20 | 每文件 1 次整读（无 Range），下载前用 size 预筛 |
| 单项目单次 | ≤360 请求（最坏首扫）≈ 20–30s | 增量轮次通常 ≤80 请求 |
| 单轮定时 | B 最多 3 个项目，另设 `maxFilesPerRun=600` 全局文件预算 | 超出记 `deferred`，下轮继续 |
| 频率 | 默认 7 天/项目（`intervalHours=168`） | 与 A 的每次定时无关，A 可以在同一规则里每次跑 |

> 对照：无上限地扫一个 200 目录 / 2000 文本文件的中型仓库 ≈ 2200 次 HTTP（`fsList` 每目录一次、文件逐个整读），不可接受。所以 **maxDirs / maxFiles / scanRoots 是本方案能成立的三个前提**，不是可选优化。大仓项目要么配置 `scanRoots` 收窄，要么只手动采。

### 4.4 候选生成与噪声抑制

- 单文件最多 3 条候选（文档未勾选额外折叠 1 条汇总）；单项目 B 源最多 20 条（与 A 共享单项目上限，先 A 后 B）。
- 标题模板：
  - 代码：`[代码] <相对路径>: <标记内容截断>`
  - 文档：`[文档] <相对路径>: 未勾选验收：<条目标题>` / `[文档] <相对路径>: <状态标记>`
- 正文写清：文件相对路径（可点工作区文件树定位）、命中的标记原文（≤200 字）、文件 mtime、来源说明「由未完成事项采集（工作区扫描）自动登记」。
- 候选在预览里按 `来源徽标（任务/代码/文档）+ 文件路径` 展示，用户可逐条勾选。

### 4.5 sourceKey（跨轮稳定，不随行号漂移）

```
A:  task:<taskId>                             例 task:wt-3f9a1c2d
B1: code:<sha1(relPath + "\n" + normalizedMarkerLine)[:16]>
B2: doc:<sha1(relPath + "\n" + normalizedChecklistItemText)[:16]>
```

- 只哈希**路径 + 标记文本**，不含行号 → 文件上下移动/插入代码不会重复登记。
- 文本规范化：去行首注释符（`//`、`#`、`/*`、`*`、`<!--`）与首尾空白、连续空白压成一个；**保留大小写**（大小写不同视为不同事项，避免把两件事合并）。
- 同一行出现多个标记 → 以第一个为准（避免一条代码变三条候选）。
- 文件重命名 → sourceKey 变化 → 重登记一次（可接受；旧条目由其状态自洽，人工关闭即可）。

### 4.6 为什么不扩节点端点（D6 零侵入）与何时才扩

- 本方案 B 只使用节点既有 `GET /fs/list`、`GET /fs/download`（不新增/不修改 dsh-web-service），守住 README.md:267 的「D6 零侵入」。
- 代价（如实声明）：**没有递归/没有 grep/没有 Range** → 目录数 = 请求数，且每个候选文件必须整文件读。用 §4.3 的上限 + 增量 + `scanRoots` 把成本压到可接受，但「扫一个几千目录的大仓」在本期**做不到**。
- 什么时候才值得破例：当 dogfood 数据显示「`scanRoots` 收窄后仍常被 `scanTruncated` 挡住」或「用户明确要大仓全量」时，再评估在 dsh-web-service 增一个只读端点（如 `GET /fs/find?path=&pattern=&maxDepth=`，内容 grep 或递归 listing）。这是**新增能力、不破坏既有端点、向后兼容**，与 `docs/skills-management-design.md:93-94` 的破例先例同口径；但需要：① 设计文档显式改 D6 措辞；② dsh-web-service 版本升级覆盖每个节点。**本期不做**，列入 M4+ 的评估项。

---

## 5. 项目活跃门禁（双信号 + 可关闭）

### 5.1 为什么不能扫全部项目

平台线上实测 22 个项目、其中 6 个节点不可达（`docs/qa-online-backlog-mcp-20261101.md` §3）。若每轮对全部项目做「解析节点 → 列 backlog → 对账 → 建条目」：

- **成本**：每项目一次 resolve + 一次 fsList + 逐文件下载；B 还要遍历目录。
- **失败面**：休眠项目的节点大概率离线/端口漂移，每轮产生一堆「节点不可达」，淹没真实失败。
- **垃圾条目**：休眠项目里早就没人管的失败任务被反复登记 → 看板污染 → 用户不再看点板 → 功能失效。

### 5.2 活跃度模型（A 零 IO）

```
lastActiveAt(project) = max(updatedAt of 该项目的全部 WorkTask)   // 无任务 = 0
active(project)      = activityWindowDays > 0 ? lastActiveAt >= now - W : true   // W=7 天，0=关闭
```

**为什么只取 WorkTask.updatedAt**（本方案最关键的取舍）：

1. **它就是 A 的原料本身**：没有 WorkTask 的项目，A 采出来也是空集 → 用同一信号做门禁不损失 A 的产出。
2. **零成本**：`store.getTasks()` 是内存数组（`src/store.ts:571-573`），一次 O(n) 汇总，不连节点。
3. **不受采集自身污染**：采集只写 backlog 文件、不碰任务 → 不会刷新 `updatedAt` → 不会把休眠项目「变活跃」（若拿 backlog 文件 mtime 当信号，采集自己写一次就把项目激活了，形成自激）。
4. **语义贴合用户心智**：「最近有推进」= 最近有人在 WorkBuddy 里跑任务/改任务。

**不参与活跃度判定的信号**（明确写下，避免后续误加）：`Project.updatedAt`（改名/加成员就算活跃，噪音大）、backlog 文件 mtime（被采集自身污染）、节点 git 提交（需节点 IO，且与 A 无关联）。

**B 的活跃信号怎么办**（B 的原料不在任务账本里，这是双源带来的新问题）：

- B **复用同一活跃门禁**（项目最近有任务活动才扫工作区）—— 推荐，成本最低，语义是「最近有人在这个项目里干活，那它的代码/文档也值得看一眼」。
- 另加 **扫描间隔** `config.workspace.intervalHours`（默认 168h = 7 天/项目）作为第二道频率闸：活跃项目也不是每轮都扫。
- **关闭活跃窗口（D6=off）时**：A 退化为全项目（仍受水位线/预算/暂停/全局开关约束）；B 变为「全部已初始化 backlog 的项目按间隔轮扫」，**单轮最多扫 `config.workspace.maxProjectsPerRun`（默认 3）个项目**，按 `lastActiveAt` 降序排队，其余记 `deferred`。
- **已知局限（如实声明）**：一个项目如果长期没有任务活动、但代码在某处被人工/外部工具改了，B 不会自动扫到。要补这个口子需要「工作区活跃探针」（每轮每项目 1 次顶层 fsList，成本与收益都待评估）——放 M4，需单独确认。

### 5.3 五层门禁流水线（A/B 合流，越靠前越便宜）

```
L0 项目级排除（纯内存，0 IO）
   ├ 项目已归档 / 无 workspace / 全局采集关闭
   ├ backlog 未初始化（首次用 probeBacklog 探测，结果缓存 5 分钟；事实源仍是目录）
   └ 用户对该项目显式「暂停自动采集」
L1 活跃门禁（纯内存）
   └ active(project)：activityWindowDays > 0 时 lastActiveAt >= now - W
L2 水位线/增量门禁（纯内存）
   ├ A：候选 = 未完成任务 ∩ updatedAt > taskWatermark(project)；为空→A 跳过
   └ B：到扫描间隔才标记「需扫」；未到→B 跳过（不列目录、不下载）
L3 节点 IO（仅剩少量项目）
   └ resolveRef（实时解析，不缓存端口）
      → [A] listBacklog（一次，顺便取 sourceKey 对账）
      → [B] 列目录（≤maxDirs）→ 下载变更文件（≤maxFiles）→ 正则扫描
      → 按预算 createItem（单项目 ≤20，单轮 ≤60）
L4 预算与顺序（纯内存）
   └ 按 lastActiveAt 降序处理；超预算的项目记 deferred 下轮再采
L5 状态写回
   └ taskWatermark / lastCollectedAt / workspace.lastScanAt / fileIndex / 计数 / lastError → 独立状态文件（原子写 + 单飞）
```

**关键**：L1 与 L2 都在内存里完成。线上「22 个项目、日常只有几个活跃」的定时采集：**A 一次节点请求都不发**（候选为空）；B 只对「活跃 + 到间隔」的项目发请求，且单轮最多 3 个。

### 5.4 休眠项目的产品处理（不自动挖 ≠ 看不见）

| 场景 | 行为 |
|---|---|
| 自动定时采集 | 休眠项目直接跳过，不计失败、不报警（运行记录标 `dormant`，可展开看） |
| 「我的待办」页 | 新增折叠区**「休眠项目（N）」**，每项目一行：`项目名 · 休眠 N 天 · 未完成 M 条`——**纯内存计算，不连节点** |
| 单项目手动采集 | 允许（用户明确意图），预览里标注「该项目已休眠 N 天」，勾选后照常创建 |
| 项目「复活」 | 无需操作：任一任务新增/新对话/状态变化 → `updatedAt` 前移 → 下轮自动回到活跃集 |
| 每项目暂停 | opt-out 开关；「休眠」是自动判定、可被活动解除；「暂停」是人工意志、只能人工解除 |

### 5.5 抖动与边界

- **刚好跨窗口**：活跃窗口按「最后一次任务更新」滚动计算，不存在「周一 0 点判活」的悬崖。
- **时钟回拨/时区**：全部用 Host 本地毫秒时间戳比较（与 `nextRun` 同语义）；`watermark = max(watermark, now - lookback)` 兜底；B 的 `fileIndex` 只做「mtime > 已记录 mtime」比较，回拨时最多少扫、不会重复扫（sourceKey 兜底）。
- **任务自动归档不算推进**：`archiveSweep()` 直接写 `archivedAt`、不刷新 `updatedAt`（已核实 `src/store.ts:163`）→ 归档扫描不会把项目刷成活跃，也不会让水位线失效。
- **用户动作算推进**：`bulkUnarchive` 刷新 `updatedAt`（`src/store.ts:612`），属真实用户操作，计入活跃，可接受。
- **运行中任务的流式增量**：`appendTurnText` 走 `mutateTask` → `updatedAt` 持续前移（这就是「正在推进」的正解）。
- **B 与 A 的时间语义**：A 用任务账本时间；B 用文件 mtime；两者不互相污染，各自独立水位线。

### 5.6 自激污染防护（重要）

```
若把 backlog 文件 mtime 当活跃信号：采集写 backlog → mtime 变 → 判「有推进」→ 再采集 → …
若 B 扫描包含 backlog/ 目录：采集写入的条目自己会被当成「未勾选的文档事项」→ 再采集
```

本方案从四处切断：

1. 活跃度只看 WorkTask（§5.2），采集不写任务 → 断链；
2. B 扫描**硬排除 `backlog/`**（§4.2）+ 只认代码/文档扩展名白名单；
3. 采集条目带 `wb:source` 标记，对账命中即跳过（§8）；
4. 状态文件记录 `autoItems`（本模块创建过的 itemId ↔ sourceKey），未来若真要引入文件 mtime 信号，必须先排除这些名字。

### 5.7 状态存储：独立文件，不进 store.json

```jsonc
// <data>/backlog-collect-state.json   由 src/backlog-collect.ts 独占读写（tmp+rename 原子写、单飞）
{
  "version": 2,
  "config": {
    "enabled": false,                    // D9：默认关闭
    "activityWindowDays": 7,             // D6：0 = 关闭活跃门禁（可选）
    "lookbackDays": 30,
    "sources": { "tasks": true, "workspace": true },
    "perProjectLimit": 20,
    "perRunLimit": 60,
    "includeCancelled": false,
    "includeDraft": false,
    "staleRunningHours": 2,
    "cooldownMinutes": 0,
    "workspace": {
      "intervalHours": 168, "maxProjectsPerRun": 3, "maxFilesPerRun": 600,
      "scanRoots": ["src", "docs", "scripts", "lib", "app", "packages", "test", "tests", "backend", "frontend", "server", "web"],
      "maxDepth": 4, "maxDirs": 60, "maxFiles": 300, "maxFileBytes": 200000,
      "modifiedWithinDays": 30, "maxIndexEntries": 600,
      "excludeGlobs": []
    }
  },
  "projects": {
    "proj-xxx": {
      "taskWatermark": 1793500000000,     // 只采 updatedAt > watermark 的任务
      "lastActiveAt": 1793500000000,      // 观察值（UI 展示「休眠 N 天」）
      "lastRunAt": 1793500000000,         // 上次被扫到（含跳过）
      "lastCollectedAt": 1793500000000,
      "workspace": {
        "lastScanAt": 1793500000000,
        "scanTruncated": false,
        "mtimeUnavailable": false,
        "fileIndex": { "src/a.ts": 1793500000000, "docs/b.md": 1793500000000 },
        "lastError": { "at": 0, "message": "节点不可达" }
      },
      "autoItems": [{ "itemId": "task-12", "sourceKey": "code:1a2b3c4d5e6f7788", "at": 0 }],
      "suppressedKeys": [],               // 用户删除过的 sourceKey，永不重建（上限 500）
      "paused": false,
      "counters": { "created": 12, "skipped": 5, "errors": 0 }
    }
  },
  "lastRun": { "at": 0, "sources": ["tasks", "workspace"], "created": 0, "projects": 0, "errors": 0 }
}
```

**为什么单独一个文件**：

- `store.json` 每次 mutation 全量重写（含流式 delta），把高 churn 游标塞进去会放大写盘成本（`src/store.ts:44-46/216-219` 实测 15.7MB 单次 110–300ms 且同步阻塞）；
- 采集状态是「模块内部游标」，不是用户配置也不是业务实体，独立文件好备份/好重置（删掉即「重新全量采集」）；
- 配置项（活跃窗口/上限/忽略规则）也放这里，UI 通过采集 API 读写，不污染 settings；定时规则本身仍在 `ScheduledTask.rule`。
- `fileIndex` 与 `suppressedKeys` 都有条数上限，文件大小可控（估算 ≤ 200KB）。

---

## 6. 完整流程

```
定时触发（ScheduleRunner.tick, action.kind='backlog_collect'）
        │
        ▼
 ┌───────────────────────────────────────────────────────────────┐
 │ L0 纯内存：项目筛选（归档/无 workspace/未初始化/暂停/全局关闭）│
 │ L1 纯内存：活跃门禁  lastActiveAt >= now - W（W=0 时关闭）      │
 │ L2 纯内存：A 水位线 / B 扫描间隔                                │
 │      → 全平台常规一趟：A 零节点请求；B 最多 3 个项目             │
 └───────────────────────────────────────────────────────────────┘
        │ 仅剩「活跃且到点」的项目（按 lastActiveAt 降序，受单轮预算约束）
        ▼
  resolveRef（实时解析）
    ├ A: listBacklog（一次，取 sourceKey 对账）→ createItem × ≤20
    └ B: 列目录（≤60）→ 下载变更文件（≤300）→ 正则扫描 → 对账 → createItem × 剩余预算
        ▼
 写 backlog/tasks/task-<n> - <标题>.md（带 wb:source 标记）
 → 更新状态文件（taskWatermark=本轮开始时刻；workspace.lastScanAt=now；fileIndex 合并）
 → ScheduleRunItem（每项目一条：created/skipped/dormant/deferred/error）→ 运行历史 + 监控

手动触发（看板按钮 / 我的待办 / 工具通道）→ 同一个采集器，默认 dryRun 出候选预览 → 勾选确认 → 落盘
   → 单项目手动可绕过 L1（休眠项目也可采）；L2 默认仍生效（force 可绕）
定时任务「立即执行」→ 走 fire(id,true) → 直接 apply（与定时同语义，非 dryRun）
```

---

## 7. 触发机制

### 7.1 定时：扩展 `ScheduledTask`，不新建调度体系

复用 `src/scheduler.ts` 的规则计算（`normalizeRule`/`nextRun`）、20s tick（错过不补跑）、手动 `fire(id,true)`、`firing` 去重、`ScheduleRun` 滚动历史（50 条）、`onRunFinished` 监控回调。

```ts
export type ScheduleAction =
  | { kind: 'task' }                                   // 缺省 = 现有语义（存量数据零迁移）
  | { kind: 'backlog_collect'; sources?: Array<'tasks' | 'workspace'> }

export interface ScheduledTask {
  action?: ScheduleAction
  message: string        // backlog_collect 下可为空说明（校验按 action 分支）
}

// 仅列出新增字段（既有 agentId/agentName/taskId/... 不变；新增字段全 optional，向后兼容）
export interface ScheduleRunItem {
  projectId?: string; projectName?: string
  state?: 'collected' | 'dormant' | 'no-new-material' | 'cooling' | 'deferred' | 'error'
  source?: 'tasks' | 'workspace'
  created?: number; skipped?: number; itemIds?: string[]
}
```

- `fire()` 内按 `action.kind` 分支：`task` 分支一行不改；`backlog_collect` 分支调 `runScheduledCollect()`，`run.items` 组装为每项目一条（`agentId:'__collector__'`, `agentName:'未完成事项采集'`）。
- `upsertScheduleFromInput` 按 action 分支校验（`message` 在 collect 下可空；`agentIds`/`nodeMappingId` 在 collect 下可空）。
- `scheduleSummary`（`src/router.ts:532`）增加 `actionKind` 供列表徽标；监控事件 `kind:'schedule_fired'`（`src/monitor.ts:280-298`）的 payload 增加 `created/skipped` 汇总。
- 手动「立即执行」走既有 `POST /api/schedules/:id/run` → `fire(id,true)`，与定时同一条路径。

### 7.2 手动：四个入口、一条写路径

| 入口 | 位置 | 语义 |
|---|---|---|
| 项目看板「🔍 采集未完成」 | `blBoardHtml()` 工具栏（`src/web-ui.ts:14910`） | dryRun 出候选预览 → 勾选确认 → 落盘 |
| 「我的待办」页顶部 | `blOverviewHtml()`（`14857`） | 全局预览（按项目分组，含休眠项目分组） |
| 定时任务「立即执行」 | 已有 `POST /api/schedules/:id/run` | action=backlog_collect 的规则手动跑一次（**直接 apply**，与定时同语义，不走预览） |
| 工具通道 | `workbuddy_backlog_manage` 新增 `action:"collect"` | AI 宿主用，默认 dryRun，显式传 `dryRun:'false'` 才落盘 |

**预览而非直接写**：采集是「机器往人看的看板上写东西」，必须让人先看到「将新增哪 5 条」，否则第一次点就觉得被灌垃圾。

### 7.3 采集配置入口

- 定时任务页：动作类型「任务派发 / 待办采集」；选待办采集时隐藏 agent/节点/任务文本，改为「采集源（任务/代码文档）/ 活跃窗口 / 单项目上限 / 是否含 cancelled」。
- 采集设置卡片（我的待办页顶部，或设置页）：启用开关、活跃窗口、单轮上限、每项目暂停列表、B 扫描间隔、B 忽略目录、状态重置（删状态文件）。

---

## 8. 幂等与去重（三层防线 + 双命名空间 + 墓碑）

| 层 | 规则 | 实现 |
|---|---|---|
| 1. 水位线 / 增量（比对「新素材」） | A：只采 `updatedAt > taskWatermark`；B：只扫 mtime 变化的文件、未到间隔不扫 | 纯内存，L2 |
| 2. 稳定来源键（比对「已登记」） | 正文标记 `<!-- wb:source=<key> -->`；`listBacklog` 从 raw 正则提取全部标记，命中即跳过（任何状态） | `BacklogItem.sourceKeys`，复用既有下载（不额外请求） |
| 3. 状态兜底 | `autoItems`（itemId ↔ sourceKey）+ `suppressedKeys`（用户删除过的不再重建） | 状态文件 |

补充约束：

- **单项目上限** 20 条/次（超出记 `skipped`，下轮继续）；**单轮全局上限** 60 条（超出项目记 `deferred`）。
- **并发互斥**：per-project 进程内锁（`createItem` 的 `max+1` 分配在并发下会撞号，且同名上传在真实节点会生成 `-1` 副本）；手动 + 定时撞车由锁串行化；同一项目的 A/B 共享一把锁。
- **冷却**：默认 0（水位线与间隔已挡住重复挖掘）；保留 `cooldownMinutes` 给需要限流的部署。
- **失败不补做**：节点不可达 → 该项目本轮 `error`，不重试（端口漂移语义）。
- **删除即不再跟进**：用户删掉采集条目 = 不想再跟这条。下轮对账时发现 `autoItems` 里的 itemId 已不存在 → 把其 sourceKey 写入 `suppressedKeys`，**永不重建**（文档写明此语义：想恢复只能删状态文件里的对应 key 或新建同名条目手动维护）。
- **A/B 不交叉去重**：任务失败条目与代码 TODO 条目是不同对象（`task:` vs `code:`/`doc:` 命名空间），各自独立；人不难分辨（labels + 标题前缀）。

---

## 9. 生成的待办格式

### 9.1 A（任务账本）

```markdown
---
id: task-11
title: 修复登录接口 500
status: To Do
labels:
  - auto-collect
  - source-task
  - failed
---

## Description

<!-- wb:source=task:wt-3f9a1c2d -->
由「未完成事项采集（任务账本）」自动登记：任务 wt-3f9a1c2d（状态 failed，最后更新 2026-11-01 13:12）

- 任务标题：修复登录接口 500
- 失败原因（摘要）：会话在 tool 调用后超时
- 最终结论摘录：登录接口返回 500，未定位根因
- 关联会话：`#/task/wt-3f9a1c2d`

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 确认该任务的失败根因（任务详情/执行记录可回看）
- [ ] #2 修复后复跑任务或明确关闭，并回写本条待办状态
<!-- AC:END -->
```

### 9.2 B（工作区代码/文档）

```markdown
---
id: task-12
title: "[代码] src/auth/login.ts: TODO 补充刷新 token 的并发保护"
status: To Do
labels:
  - auto-collect
  - source-code
  - todo
---

## Description

<!-- wb:source=code:1a2b3c4d5e6f7788 -->
由「未完成事项采集（工作区扫描）」自动登记：

- 文件：`src/auth/login.ts`（mtime 2026-11-01 12:40）
- 命中标记：`// TODO 补充刷新 token 的并发保护`
- 定位提示：项目工作区 → 右侧栏文件树 → `src/auth/login.ts`

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 确认该处 TODO 是否仍需处理（保留 / 删除标记 / 转成正式待办）
- [ ] #2 处理后同步删除或更新代码中的标记
<!-- AC:END -->
```

- `labels` 固定 `auto-collect` + `source-task|source-code|source-doc` + 原因标签（`failed`/`partial`/`stale`/`todo`/`doc-todo`），看板与 cmdk 可据此过滤。
- 标记放**正文注释**而非自定义 frontmatter：上游 CLI 重写 frontmatter 可能丢未知字段，正文更抗写，人也看得见。
- 卡片徽标沿用现有 `labels` 渲染，无需新样式。

---

## 10. 代码落点

| 文件 | 变更 |
|---|---|
| `src/backlog-collect.ts`（新） | 采集器主模块：A 候选筛选、B 工作区扫描（列目录/下载/正则/增量）、活跃度计算、五层门禁、`planCollect`（dryRun）/`applyCollect`、`runScheduledCollect`、状态文件读写（原子写+单飞）、per-project 锁、预算与 deferred |
| `src/backlog-collect.test.ts`（新） | 单测：A 判定矩阵、B 标记正则矩阵、sourceKey 稳定性、水位线/间隔、预算与 deferred、锁、状态文件损坏恢复、休眠判定 |
| `src/types.ts` | `ScheduleAction`、`ScheduledTask.action`、`ScheduleRunItem` 扩展；`BacklogItem.sourceKeys?: string[]` |
| `src/backlog.ts` | `listBacklog` 从 raw 提取 `wb:source` 标记 → `sourceKeys`；`createItem` 支持写来源标记（新增可选 `source` 参数）；复用既有 `downloadText`（整文件读、size 预筛后调用） |
| 节点 API 使用约束（实现注意） | 工作区扫描全部走既有 `DshClient.fsList`（`all=1`、单层、15s 超时、`truncated` 视为跳过该目录）与 `fsDownload`（整文件、60s 空闲超时）；**不新增/不修改 dsh-web-service 端点**（D6）；下载前用 listing 的 `size` 过滤；不并发轰炸节点（扫描器内并发上限 4，低于 backlog 列表的 6） |
| `src/scheduler.ts` | `fire()`（`:80-185`）按 `action.kind` 分支；`run.items` 组装 collect 结果；`src/router.ts:532` 的 `scheduleSummary` 增加 `actionKind` |
| `src/router.ts` | 新增 `POST /api/backlog/collect`（全局，body: `{projectIds?, sources?, dryRun?, force?}`）、`POST /api/projects/:id/backlog/collect`、`GET/PATCH /api/backlog/collect/config`、`GET /api/backlog/collect/state`、`POST /api/backlog/collect/reset`；`upsertScheduleFromInput`（`router.ts:488-529`）按 action 校验；`POST /api/schedules/:id/run` 无需改 |
| `src/backlog-tool.ts` | `action:"collect"`：参数新增 `sources`（json 数组）与 `dryRun`（'true'）；回包 `{candidates[], created[], skipped[], errors[], projects[]}`；契约同步 `docs/design-backlog-mcp-tool.md` |
| `src/web-ui.ts` | 看板「🔍 采集未完成」按钮 + 候选预览弹窗（`openModal` 复用）；我的待办顶部全局采集 + 「休眠项目（N）」折叠区；定时任务抽屉动作类型 + 采集字段；采集设置卡片；卡片 `auto-collect`/来源徽标 |
| `scripts/backlog-e2e.mjs` | stub 升级：entries 带 `mtime`、按项目隔离 FS（第二 stub 端口或按 host 分流）、可注入「节点离线/慢」；新场景：A dryRun→apply→重复幂等→休眠跳过→水位线跳过→节点不可达隔离→B 扫描（TODO/未勾选）→删除不重建→定时 action 手动触发 |
| `scripts/smoke-standalone.mjs` | 新增静态断言：采集按钮/预览函数存在；新增内联代码段无 `?.`/`??`（X5 旧内核，沿用 181-198 的切片断言方式） |

---

## 11. 分期与验收

### M1 采集核心（A 源）+ 手动触发

- `backlog-collect.ts`（A 候选 + 门禁 L0/L1/L2 + plan/apply + 状态文件 + 锁）、`backlog.ts` 来源标记、`POST .../collect`、看板按钮 + 预览弹窗、工具 `collect`、休眠分组
- 验收：
  - 失败任务 → 预览出现 → 创建 1 条（labels/正文标记正确）→ 再点显示「已登记」不新增
  - 部分成功/卡死任务同样命中；success/completed 不命中；`backlogRef` 派生任务不命中
  - 水位线生效：任务无新更新 → 第二次点击零候选
  - 休眠项目预览提示「已休眠 N 天」；节点不可达项目显示错误 chip 且不影响其他项目
  - 并发点两次「采集」不产生重复 id / 重复条目

### M2 定时触发

- `ScheduledTask.action` + `fire()` 分支 + 定时任务页动作类型 + 采集设置卡片 + 运行历史明细
- 验收：
  - 建一条每天 09:00 的采集规则 → 「立即执行」产出条目，历史里能看到 `created/skipped/dormant/no-new-material`
  - **构造 5 个休眠项目 + 1 个活跃项目，验证一轮只有 1 个项目发生节点请求**（stub 计数器断言）
  - 存量「任务派发」类定时任务行为完全不变（回归 `npm run smoke:schedules`）

### M3 工作区扫描（B 源，确定性，无 LLM）

- 工作区扫描器 + fileIndex 增量 + 忽略规则 + `scanRoots` + 候选预览（按文件分组）+ B 预算 + 配置项 + e2e stub 升级
- 验收：
  - 工作区写入 `// TODO 修复并发` 与一个未勾选 `- [ ]` → 预览出现 2 条（标签 `source-code` / `source-doc`）
  - 重复采集不新增（sourceKey 命中）；把 TODO 行上移 10 行 → 仍不新增（无行号依赖）
  - 修改一个文件再采 → 只下载该文件（stub 请求计数断言）；未到扫描间隔 → 不列目录、不发请求
  - `backlog/` 目录里的条目不会被当成未勾选文档（自激防护）
  - 大文件/二进制/`node_modules`/非 scanRoot 目录被跳过；目录数超 `maxDirs` → `scanTruncated` 可见
  - 单目录返回 `truncated`（模拟 2000+ 条目）→ 该目录被跳过并记 `dirTruncated`，不产生残缺候选
  - 节点不返回 mtime（stub 关掉 mtime）→ 走降级路径（浅层 + 小上限）并在运行记录标 `mtimeUnavailable`
  - 节点不可达项目 `error` 隔离；单项目失败不影响其他项目

### M4（可选，需单独确认）语义扫描 + 工作区活跃探针

- LLM 扫「未完成设计文档」语义判断（严格 JSON 契约 → 服务端校验 → 统一 `createItem`，不让 agent 直接写文件）
- 工作区活跃探针（无任务活动但有代码变更的项目也能采）
- 自动派发（默认仍不做）
- 前置：M1/M2/M3 跑满一周、有真实使用数据后再评估成本与误报率

### 质量门（每个里程碑）

`npm run typecheck`、`npm run test:unit`（新增 `backlog-collect.test.ts`）、`npm run smoke`（81 项不回归，新增断言）、`npm run smoke:backlog`（e2e 内存 FS 覆盖）、`npm run smoke:schedules`（M2 起）、`npm run build` 后控制台走查（登录态 / ≤768px / 微信 X5 UA）。

### 工期估算（单人，含自测，不含独立 QA）

| 阶段 | 代码 | 单测/e2e | 小计 |
|---|---|---|---|
| M1 A 源 + 手动 | 1.5–2 人日 | 0.5–1 | **2–3 人日** |
| M2 定时 | 0.8–1 | 0.3 | **1–1.5 人日** |
| M3 B 源 | 1.5–2 | 0.5–1（含 stub 升级） | **2–3 人日** |
| M4（可选） | 1–1.5 | 0.3 | **1–2 人日** |
| 独立 QA/回归 | — | — | **1–1.5 天** |

若要求 A+B 同批上线：合并 M1+M3，工期约 4–6 人日（B 的扫描器与 A 的骨架可并行开发，但 e2e stub 升级是串行前置）。

---

## 12. 风险与对策

1. **自激循环**（采集→派发→失败→再采集）→ 排除 `backlogRef` 派生任务；采集件默认不自动派发。
2. **看板垃圾化** → 预览确认 + 水位线 + 上限/预算 + `auto-collect` 可过滤 + 30 天窗口 + 休眠不采。
3. **B 误报（TODO 噪音）** → 只认明确标记 + 只扫近 30 天变更文件 + 每文件/项目上限 + 预览逐条勾选 + labels 可过滤；不追求「零误报」，追求「可解释、可关闭」。
4. **B 成本（目录+文件请求）** → fileIndex 增量 + 7 天间隔 + 单轮最多 3 个项目 + `scanRoots` + 目录/文件/字节/单轮文件预算上限 + 失败隔离。上限不是可选优化：节点无递归端点，目录数 = 请求数（§4.3）。
5. **大仓扫不动（能力边界）** → 无递归/无 grep 端点，单项目硬上限 60 目录/300 文件/次；超出记 `scanTruncated`，不静默残缺。要扫几千目录的大仓需扩 dsh-web-service 端点（M4+ 评估，见 §4.6），本期明确不做。
6. **节点不返回 mtime** → 退化浅层小上限 + `mtimeUnavailable` 标注（§4.2），不静默全量下载。
7. **单目录 2000 条 truncated** → 该目录整体跳过并记 `dirTruncated`，避免「只扫到前 2000 条」的残缺结论。
8. **自激「活跃」** → 活跃度只看 WorkTask；B 硬排除 `backlog/`。
9. **标记被手改删除 → 重复登记** → 标记放 Description 段首；真被删说明用户不想要，重复规模可控；`suppressedKeys` 兜底。
10. **节点不可达/端口漂移** → 逐项目记 `state:'error'` 进运行历史，不重试，不影响其他项目。
11. **并发写**（`createItem` 无锁 + 同名上传生成副本）→ per-project 进程内锁；采集与人工新建串行；不引入分布式锁（单实例部署，多实例不在本期范围）。
12. **状态文件损坏/丢失** → 视为「重新开始」：水位线归零、fileIndex 清空、`autoItems` 空 → 靠 sourceKey 对账仍不重复建；只是可能多一次全量扫描（B 首扫成本）。
13. **状态文件膨胀** → `fileIndex ≤600`、`autoItems ≤500`、`suppressedKeys ≤500`，超限按时间裁剪。
14. **兼容性** → `ScheduledTask.action` 缺省 = 原语义，存量 store.json 零迁移；`ScheduleRunItem` 新增字段全 optional；单测覆盖「无 action 的旧数据」。
15. **性能** → A 常规一趟零节点请求；B 仅活跃项目且到间隔才扫；单次扫描上限可配。
16. **误把「配置」写进 store** → 采集配置只进状态文件；项目级暂停也只进状态文件（不改 Project，避免 `upsertProject` 全量覆盖 + save 的额外写盘）。

---

## 13. 决策定稿表（D1–D10）

| # | 决策点 | 定稿 | 来源 |
|---|---|---|---|
| **D1** | 「未完成的任务」数据源 | **A 任务账本 + B 工作区代码/文档（双源）**；B 用确定性标记扫描（非 LLM），双 sourceKey 命名空间、独立预算 | **用户确认**（2026-11-01） |
| D2 | 采集范围（A） | failed / partial_success / 卡死 running(>2h)；cancelled、draft 默认不采（可配） | 推荐锁定 |
| D3 | 采集后是否自动派发 | **否**（只登记，人决定何时派发） | 推荐锁定（与 A/B 一致） |
| D4 | 预算与冷却 | 单项目 20/次、单轮 60、冷却默认 0（水位线/间隔为主）；B 另有目录/文件/字节上限 | 推荐锁定 |
| D5 | 定时触发形态 | 扩展 `ScheduledTask.action`（复用规则/手动/历史/监控，存量零迁移） | 推荐锁定 |
| **D6** | 活跃窗口 | **默认 7 天，可配 3/7/14/30，可关闭（0=off）**——软门禁、可选项；关闭后 A 退化为全项目（受水位线/预算/暂停/全局开关约束），B 按间隔轮扫且单轮最多 3 个项目 | **用户确认「可选」**（按可配可关实现） |
| D7 | 休眠项目处理 | 自动跳过不挖；「我的待办」可见（内存计数）；允许手动采；有新活动自动复活；每项目可暂停 | 推荐锁定 |
| D8 | 状态存储 | 独立 `backlog-collect-state.json`（不进 store.json、不进用户 settings） | 推荐锁定 |
| D9 | 全局采集默认开关 | **默认关闭，用户显式开启**（避免升级后突然往所有项目写文件） | 推荐锁定 |
| **D10** | B 源判定与扫描策略（新增） | 确定性标记（TODO/FIXME、未勾选验收、文档状态标记）+ `scanRoots` 收窄 + 只扫近 30 天变更文件 + 硬排除 `backlog/` 等目录 + 默认 7 天间隔/项目 + 上限（60 目录/300 文件/单轮 3 项目/600 文件）+ `truncated` 目录跳过 + mtime 缺失降级；LLM 语义扫描与递归/grep 端点后置 M4+ | 推荐锁定 |

---

## 14. 相对 v2 的变更 / 开放项

**已变更（v2 → v3）**

1. D1 从「A 先做、B 后置 M3（LLM 扫描）」改为「**A+B 双源**」；B 从「M3 后置 LLM 扫描」改为「**M3 确定性扫描（必做）**」，LLM 语义扫描后置 M4。
2. 新增 §4（B 源的判定/范围/增量/候选/sourceKey）、§5.2 的「B 活跃信号怎么办」、§5.7 状态文件 v2 schema（fileIndex / autoItems / suppressedKeys）。
3. 新增 §8 的三层防线细节：双命名空间、墓碑（删除不重建）、per-project 锁与 A/B 共享锁。
4. 新增 §11 M3 验收与 e2e stub 升级要求（stub 无 mtime、无按项目隔离 FS 是当前明确缺口）。
5. D6 从「默认 7 天」改为「默认 7 天 + 可配 + 可关闭的软门禁」；补充「关闭后 A/B 各自的退化行为」。
6. §10 代码落点按实际代码现状校准（`backlog.ts` 已有函数行号、工具 12 action、`store.save` 全量落盘证据、无 `backlogEnabled` 字段等）。

**开放项（评审时如不同意，一句话即可改）**

1. **B 默认 7 天/项目扫描**（`config.workspace.intervalHours=168`）：若希望 B 与 A 同频（跟随定时规则，如每天），改默认值为 24 即可，代价是节点请求量上升一个量级（增量轮仍受上限保护）。
2. **B 候选只登记不自动派发**：与 A、D3 一致；若希望「代码 TODO 自动派发修复任务」，属危险动作，建议放到 M4 且默认关。
3. **B 不扫「无任务活动但代码有改动」的项目**（§5.2 已知局限）：需要「工作区活跃探针」，放 M4，需单独确认。
4. **大仓全量深扫（能力边界）**：节点只有单层 `/fs/list`，无递归/grep/Range。本期用 `scanRoots` + 上限 + 增量兜底，大仓只能收窄范围或手动采。若确需全量深扫，需在 dsh-web-service 增只读端点（递归 listing / 内容搜索），属**显式改 D6 口径**的跨仓变更（有 `docs/skills-management-design.md:93-94` 的破例先例），建议作为 M4+ 单独立项评估，不塞进本期。
5. **多实例部署**：本期 per-project 锁是进程内的，多实例并行采集会撞 id；当前部署是单实例（systemd `onenat-workbuddy`），如要多实例需先把锁/状态外置。
