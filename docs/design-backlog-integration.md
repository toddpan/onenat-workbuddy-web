# Backlog 集成方案（v2：含 DSH 节点端侧）

> 状态：待评审（用户确认后动工）
> 上一轮评审见 `docs/review-backlog-md-integration.md`；本版在其范围表基础上，按用户新增要求补齐 **DSH 节点端侧安装/初始化**、**项目 backlog 生命周期**、**Web 端 todo list 管理**、**待办 → 任务执行**、**UI 交互** 五块内容。
> 所有引用的既有能力均在 `src/` 代码中核实过（fsList/fsUpload/fsMkdir/fsDownload/fsRemove、WorkTask、TaskSummary、project.instruction 注入点）。

---

## 1. 需求重述（整理后的用户需求）

用户要做的是「待办即工单」闭环，拆成五个子问题：

| # | 需求 | 本方案落点 |
|---|---|---|
| R1 | DSH 节点端侧：backlog **怎么安装、怎么初始化**（存哪里、什么格式、谁建、怎么建） | §3 存储与初始化 |
| R2 | **每个项目 backlog 的生命周期**：项目级（未初始化→在用→归档）与条目级（状态机+回写规则） | §4 生命周期 |
| R3 | **Web 端怎么管理 todo list**：浏览、新建、编辑、（删除），数据在节点上、Web 只是门面 | §5 服务端模块与 API |
| R4 | **用户怎么把 todo list 执行成任务**：一键/批量派发为 WorkTask，结果回写 backlog | §6 派发与回写闭环 |
| R5 | **UI 上需要这样的交互**：看板、卡片、空态引导、编辑对话框、状态可信度与失败可见性 | §7 UI 交互设计 |
| R6 | **跨项目统一入口**（本轮新增）：不进项目就能看到「属于我的」全部待办（原 N4 聚合总览，经用户确认转正为轻量版） | §5.2 overview API + §7.3 |

沿袭上轮评审已定的边界：采纳 Backlog.md 声明式数据格式但**不引入其进程依赖**；backlogRef 用**文件名前缀解析的 itemId 作稳定键**（文件名含空格且会被 agent 改，不做外键）；拖拽改状态、agent 技能化协同**后置**；跨项目聚合总览（N4）原评审标记后置，**经用户 2026-10-31 确认转正为轻量只读+派发版**（完整看板聚合仍后置）。

---

## 2. 总体架构：三个平面

```
浏览器 UI（web-ui.ts 内联控制台）
  │  GET/POST /api/projects/:id/backlog*、POST /api/tasks
  ▼
WorkBuddy 服务端（新增 src/backlog.ts 模块；数据不落 WorkBuddy 磁盘）
  │  /fs/list、/fs/download、/fs/upload、/fs/mkdir、/fs/remove（复用 remote-client 既有方法）
  ▼
DSH 节点端（项目工作区文件系统：<workspace>/backlog/ 目录，人/agent 双方可直接编辑）
```

设计原则：

1. **文件即数据库**：backlog 的唯一事实源在 DSH 节点项目工作区里，人在终端改、agent 在会话里改、Web 在看板改，改的都是同一批 md 文件。WorkBuddy 不复制数据，只做门面与编排。
2. **WorkBuddy 无状态透传**：列表请求时实时向节点聚合，不做本地持久化副本（一致性优先于性能；条目量级 ≤ 数百，实测慢再谈缓存）。
3. **最小新增依赖为零**：编解码手写、无 YAML 库（上轮架构师结论）。

---

## 3. DSH 节点端侧：存储、格式、安装与初始化（R1）

### 3.1 存储布局

每项目独立，位于项目工作区根：

```
<workspace>/
  backlog/                      ← 初始化时创建
    task-001 - 搭建登录接口.md   ← 每条待办一个文件，文件名 = "task-<itemId> - <title>.md"
    task-002 - 接入支付.md
    ...
```

- **itemId = 文件名前缀 `task-` 后的首个 token**，是 backlogRef 稳定键；文件名其余部分仅作缓存显示，允许被改名（改完下次列表自动刷新标题）。
- 目录式（而非单文件 backlog.md）的原因：与 Backlog.md 上游声明格式一致；并发写天然落在不同文件，冲突面小；列表只需读 frontmatter。

### 3.2 条目文件格式（已于 2026-10-31 部署上游 v1.55.3 实测核实，编解码仍做宽容处理）

**实测样本**（本地部署 backlog-demo，`backlog init` + `task create` + `task edit --status` 全流程验证）：

```markdown
---
id: TASK-1
title: 验证 Backlog.md 本地部署
status: To Do            # 取值来自 config.yml 的 statuses（人读名："To Do"/"In Progress"/"Done"，可配置）
assignee: []             # 数组
created_date: '2026-10-31T06:20:00Z'
labels:
  - backend
  - p0
dependencies: []
ordinal: 1000            # 自定义排序
updated_date: '2026-10-31T06:23:00Z'   # 状态变更时自动更新
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Web 端集成前的格式核实第一条任务
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 CLI 可创建任务
- [ ] #2 Web UI 可访问
<!-- AC:END -->

## Final Summary

<!-- SECTION:FINAL_SUMMARY:BEGIN -->
（task edit --final-summary 写入；即上游原生「执行记录」）
<!-- SECTION:FINAL_SUMMARY:END -->
```

目录布局实测：`backlog/` 下为 `tasks/task-<n> - <slug>.md`（任务在 **tasks/ 子目录**，文件名 id 前缀小写 `task-1`，frontmatter id 大写 `TASK-1`，一一对应仅大小写差异）+ `config.yml`（project_name / default_status / statuses / labels / date_format / default_port / task_prefix 等）。

对方案的影响（相对本版早稿的三处修正）：

1. **itemId 以 frontmatter `id` 字段为权威键**（`TASK-1`），文件名前缀仅作显示与粗解析入口；两者大小写差异必须归一处理。
2. **状态不硬编码**：看板列 = `config.yml` 的 `statuses`（人读名、可配置、可扩展自定义状态），WorkBuddy 侧维护「上游状态名 → 看板列」的映射，任务终态回写时用 `task edit --status <名>` 或按段标记直写。
3. **机器段标记是解析锚点**：`SECTION:DESCRIPTION` / `AC` / `FINAL_SUMMARY` 的 BEGIN/END 注释必须原样保留；**agent 回写执行记录直接复用上游原生 `Final Summary` 段**（对应本方案的「执行记录」概念），派发摘要写进该段而非自创小节。

编解码宽容原则不变：frontmatter 逐行解析声明字段、未声明字段与顺序保留，正文与段标记原样保留。

### 3.3 初始化：三种途径 + 引导

| 途径 | 流程 | 说明 |
|---|---|---|
| **A. Web 一键初始化**（主路径） | 项目工作台 Backlog 页签空态 → 「初始化 backlog」→ 服务端 `fsMkdir(workspace, 'backlog')` →（可选勾选）`fsUpload` 一条示例待办模板 → 页签变看板 | 用户零学习成本；失败一次即报错，不自动重试（端口漂移语义） |
| **B. agent 在会话里自建** | 项目 `instruction` 增加可选文案段（N5）：约定 `backlog/` 目录、frontmatter 字段、完成时勾验收置 done | agent 建好目录后，Web 端 fsList 检测到即自动点亮页签 |
| **C. 既有项目导入自动检测** | `/api/projects/import*` 流程尾部 `fsList(workspace + '/backlog')`，存在则 Project 打上 `backlogEnabled` 标记 | 不拷贝不复制，仅标记 |

**「安装」的本质**：backlog 没有任何进程需要安装到节点上——它只是工作区里的一个目录约定。唯一前提是项目已绑定 DSH 节点与 workspace（现有 Project.dshRef/workspace），初始化动作只是 mkdir+可选模板上传。

初始化状态判定（幂等）：`fsList('<workspace>/backlog')` 成功 → 已初始化；`error` 含不存在语义（节点无 error code，靠文案匹配 + 人工确认）→ 未初始化；连接失败 → 页签显示「节点不可达」而非「未初始化」，避免误导用户重复初始化。

### 3.4 节点能力约束与兜底（上轮架构师已核实）

| 约束 | 影响 | 兜底设计 |
|---|---|---|
| `/fs/*` **无原子写、无锁** | 人/agent/Web 三方并发写同一文件可能互相覆盖 | Web 写路径走**乐观读改写**：读原文 → 改 → 写前再读一次，若 base 内容已变则报「内容已更新，请刷新后重试」；回写只在文末追加，正文不整写 |
| 大目录 `fs/list` **truncated** | 待办数量极大时列表不全 | 列表响应带 `truncated` 标志，UI 顶部提示「仅显示前 N 条，请用搜索缩小范围」；首版不做分页游标 |
| 上传无 If-Match | 无法原子 CAS | 同乐观策略，冲突即重试提示，不做后台合并 |

---

## 4. 项目 backlog 生命周期（R2）

### 4.1 项目级状态机

```
未初始化 ──(途径A/B/C 任一)──▶ 初始化（空/蓄水） ──▶ 使用中（持续录入+派发+回写）
                                                        │
                                      项目归档(P-08) ──▶ 只读（页签保留只读视图，禁派发/禁编辑）
                                      项目恢复 ──▶ 使用中
```

- 初始化是**自动检测**的，不存布尔字段也可行；但为省每页签一次 fsList 往返，Project 上加缓存标记 `backlogEnabled?: boolean`（首次检测到 backlog/ 目录时置位，仅加速判定，事实源仍是目录存在性）。
- 项目归档沿用既有 P-08 语义：归档项目只读，Backlog 页签禁写禁派发（在 router 层复用既有归档检查，与 `/api/tasks` 同款拦截）。

### 4.2 条目级状态机与回写规则

```
open ──(用户一键/批量派发)──▶ in-progress(运行中) ──任务终态──▶ done | 回 open/in-progress
  │                                                            │
  ├──(用户手动)──▶ cancelled                                    └── 验收勾选由 agent 按 instruction 约定完成
  └──(用户手动)──▶ done（无任务佐证时标「手动关闭」）
```

回写规则（任务终态钩子，见 §6.3）：

| WorkTask.summary.status | 待办状态 | 正文追加 |
|---|---|---|
| success | done | 「执行记录」小节 + finalConclusion + 时间戳 |
| partial_success | in-progress（保持） | 执行记录 + 覆盖度说明（coverage 未全回传） |
| failed | open（回到待派发），或用户在派发时可勾「失败留在 in-progress」 | 执行记录 + 失败原因 |

状态可信度设计：done 卡片必须能点开看到关联任务与 finalConclusion；纯手动置 done 显示「手动关闭」徽标。**任务无摘要回传（如节点空回答）时，待办状态不动并标「回写未确认」**——不把失败静默成成功。

### 4.3 与任务生命周期的关系

- 派发创建的 WorkTask 通过 `backlogRef: { projectId, itemId, itemTitle, dispatchedAt }` 关联（新增可选字段），任务删除不影响 backlog（关联徽标显示「任务已删除」）。
- 同一待办可多次派发（失败重派）：backlogRef 记录最近一次派发 taskId，历史派发在条目详情抽屉的「执行记录」里可见。

---

## 5. Web 端 todo list 管理：服务端模块与 API（R3）

### 5.1 新增模块 `src/backlog.ts`

纯函数 + remote-client 编排，全部可单测：

- `encodeItem(spec)` / `decodeItem(raw)`：frontmatter 保真编解码（未知字段与顺序保留、正文原样）。
- `parseItemId(fileName)`：文件名前缀 → itemId（唯一外键）。
- `listBacklog(target, workspace)`：fsList 目录 → 逐文件 download 只解析 frontmatter 元数据（正文不拉）；返回 `{ items, truncated, initialized }`。条目 ≤ 数百时逐文件下载可行；若实测慢，退化为「目录 mtime 摘要 + 增量拉取」，首版不做。
- `readItem/writeItem`：读整文 / 乐观读改写（写前二次读校验 base，冲突抛 `BacklogConflictError`）。
- `appendExecutionRecord(itemId, record)`：只读尾部 + 文末追加，不触碰正文与前序记录。
- `initBacklog(target, workspace, opts)`：fsMkdir + 可选模板上传；目录已存在时幂等返回。
- `overviewBacklog(projects, opts)`：按项目并发（限 3）fan-out `listBacklog`，**失败隔离**——单项目节点不可达返回 `{ projectId, error }` 而不拖垮整页；供 §7.3 统一入口用。

### 5.2 API（全部过既有鉴权 + 项目权限门 + 归档只读拦截，与 `/api/tasks` 同级）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/projects/:id/backlog` | 列表（元数据聚合：id/标题/状态/标签/依赖/验收进度/关联任务徽标；含 initialized、truncated） |
| POST | `/api/projects/:id/backlog/init` | 初始化（途径 A） |
| GET | `/api/projects/:id/backlog/items/:itemId` | 详情（含正文、执行记录） |
| POST | `/api/projects/:id/backlog/items` | 新建（服务端分配下一个 itemId；标题必填，其余可空） |
| PUT | `/api/projects/:id/backlog/items/:itemId` | 编辑（乐观并发；冲突 409） |
| DELETE | `/api/projects/:id/backlog/items/:itemId` | 删除（物理删除前 UI 二次确认；默认推荐改 cancelled 保留历史） |
| POST | `/api/projects/:id/backlog/items/:itemId/dispatch` | 一键派发为任务（§6）；body 可带 mode/memberIds/instruction 附加说明 |
| POST | `/api/projects/:id/backlog/dispatch-batch` | 批量派发（返回逐条结果；部分失败不整体回滚，逐条报错） |
| GET | `/api/backlog/overview` | 跨项目统一入口（§7.3）：按当前用户可见项目 fan-out 聚合（并发限 3、失败隔离），返回 `[{ projectId, projectName, nodeStatus, initialized, truncated, items[], error? }]`；不实时刷新，进页拉一次 + 手动刷新 |

router 侧不新增权限模型：复用项目可见性（private 仅成员/owner）与归档检查。

---

## 6. 待办执行为任务：派发与回写闭环（R4）

### 6.1 派发语义（一键 / 批量）

`POST .../dispatch` 服务端动作序列：

1. `readItem` 取条目：描述 + 验收清单 + 标签/依赖。
2. 组装任务创建入参（复用 `POST /api/tasks` 既有逻辑，不绕过 engine）：
   - `title` = 待办标题；`projectId` = 项目 id（继承项目节点/workspace/专家/连接器/技能——这是项目绑定节点存在的意义）。
   - **验收标准直达 planner**：任务初始说明注入 `【来自 backlog 待办 <itemId>】` + 描述 + 验收清单原文，编排拆解（orchestrate）时子任务直接对齐验收项。
   - 依赖检查：`dependencies` 中存在非 done 的条目时，默认**阻止派发**并在 UI 提示「有未完成依赖」，允许用户勾选「忽略依赖强制派发」。
3. 创建成功后 `writeItem`：status → in-progress、assignee 记参考值、正文追加「已派发为任务 wt-xxx」记录。
4. 返回 `{ taskId, itemId }`；失败时待办状态不动，返回错误原因（UI 红点）。

派发走既有 `creator: 'console'` 通道，不做新的任务类型——**backlog 派发的任务就是普通任务**，可继续对话、可 fork、可归档。

### 6.2 批量派发与 DAG 的关系

批量派发 = 逐条独立派发（前端循环逐条调用 + 进度条），每条仍走单条 DAG 编排。**不在首版实现「多条待办自动组 DAG」**——条目间依赖已有 dependencies 字段表达，串行按依赖派发是用户心智；自动组拓扑属于后置增强。

### 6.3 回写：终态钩子

落点在 orchestrator 任务终态产出处（TaskSummary 已有 success/partial_success/failed 三态与 finalConclusion）：

- 任务带 `backlogRef` 时，终态后调用 `backlog.appendExecutionRecord` + 状态机迁移（§4.2 表格规则）。
- 回写失败（节点掉线/上传失败）：**任务侧标 `backlogWritebackFailed`**（taskLog 记录），待办保持 in-progress 且看板显示「回写未确认」徽标；页签提供「重试回写」按钮（重新按任务 summary 补写）。
- 主会话（非编排直聊）同样回写：钩子挂在任务终态统一出口，不区分路由模式；无 summary（如被取消）时不改状态，仅追加「任务已取消」记录。

---

## 7. UI 交互设计（R5，web-ui.ts 内联控制台）

### 7.1 页面结构：项目工作台新增「Backlog」页签

沿用现有 ws-tab-strip 页签样式（对话/资源/… 旁新增），页签内三块区域：

```
┌──────────────────────────────────────────────────────┐
│ [Backlog]                    ⚠ 回写未确认 2   [+ 新建待办] │
├──────────────────────────────────────────────────────┤
│ 看板列（横向滚动）:                                       │
│ ┌ open(5) ─────┐ ┌ in-progress(2) ┐ ┌ done(8) ─────┐   │
│ │ ▢ task-001 … │ │ ▢ task-003 🔵  │ │ ▢ task-004 ✓ │   │
│ │ [backend] [p1]│ │ 派发中 → 任务链接│ │ → finalConcl │   │
│ │ 依赖 1 未完成⚠│ │                │ │ 手动关闭 ⚪   │   │
│ └──────────────┘ └────────────────┘ └──────────────┘   │
│   （cancelled 折叠在底部一行，点开展开）                     │
└──────────────────────────────────────────────────────┘
```

### 7.2 关键交互清单

| 场景 | 交互 |
|---|---|
| **空态（未初始化）** | 引导卡片：一句话解释「backlog 是项目工作区里的待办清单文件，人和 agent 都能编辑」+ 按钮「初始化 backlog」（含可选勾选「附带示例待办」）；节点不可达时按钮禁用并显示原因 |
| **空态（已初始化无待办）** | 「暂无待办」+ [+ 新建待办] 主按钮 + 提示可让 agent 在会话里帮忙录入（instruction 约定生效后） |
| **看板** | 按 status 四列（open/in-progress/done/cancelled 折叠）；卡片 = 标题、标签 chips、依赖角标（`依赖 1 未完成⚠` 点击列出）、验收进度 `2/4`、关联任务徽标（🔵运行中可点跳任务 / ✓完成 / 🔴失败 / ⚠回写未确认） |
| **一键派发** | 卡片悬浮出现「▶ 派发」；点击弹确认条（显示将继承的执行位置：项目节点/workspace/成员），确认后卡片进 in-progress 并显示跳转任务的链接。依赖未完成时确认条内给出「忽略依赖」勾选 |
| **批量派发** | 卡片左上 checkbox 多选 → 顶部工具条「派发为任务 (3)」→ 逐条进度（成功 2 / 失败 1，失败原因悬浮可见）；部分失败不回滚 |
| **新建/编辑** | 右侧抽屉对话框：标题（必填）、描述（多行）、验收清单（逐行输入，存为 `- [ ]`）、标签（逗号分隔）、依赖（itemId 补全下拉）、优先级/截止日期（可选，frontmatter `priority`/`due_date` 直通）。保存 = PUT，409 冲突时弹「内容已被其他人/agent 更新，点此刷新」 |
| **条目详情** | 点击卡片开抽屉：完整正文（markdown 预览）、执行记录时间线（含每次派发任务链接与 finalConclusion）、操作按钮（编辑/派发/取消/删除） |
| **删除** | 物理删除需二次确认且文案提示「推荐改用 cancelled 保留历史」；列表提供「显示已取消」开关 |
| **失败可见性** | 页签标题栏红点计数（派发失败 + 回写未确认合计）；横幅列出可处置项：「重试派发」「重试回写」 |
| **状态可信度** | done 卡片角标区分「✓ 任务完成」（可点开 finalConclusion）与「⚪ 手动关闭」；无佐证的 done 不冒充验证过 |
| **agent 协同感知** | 卡片由 agent 建的（文件 mtime/内容无法区分来源，首版不区分作者，后置）——首版在项目 instruction 文案中约定 agent 建待办后@用户即可 |

### 7.3 「我的待办」：跨项目统一入口（R6，2026-10-31 转正）

导航侧栏新增一级入口「我的待办」（与项目列表平级），徽标 = 未完成待办总数。页面结构：

```
┌────────────────────────────────────────────────────────┐
│ 我的待办 (7)      [仅分配给我 ☐] [仅未完成 ☑] [↻ 刷新]      │
├────────────────────────────────────────────────────────┤
│ ▾ 项目A · To Do 3 / In Progress 1        ● 节点正常       │
│   ▢ TASK-3 接入支付    [p0][backend]  AC 1/3  ▶派发 →看板  │
│   ▢ TASK-5 …                                            │
│ ▾ 项目B · To Do 2                        ⚠ 节点不可达      │
│   （error chip：该项目节点连接失败，点重试；不拖垮其他项目）    │
│ ▸ 项目C · Done 1                            （折叠）       │
└────────────────────────────────────────────────────────┘
```

- **数据**：`GET /api/backlog/overview` 按当前用户可见项目 fan-out（复用既有项目权限门：owner/成员/team），进页拉一次 + 手动刷新，不做实时轮询。
- **「属于我的」语义（见 D8）**：默认 = 我可见项目里的全部待办，按项目分组；勾「仅分配给我」后按 assignee 匹配我的成员名（**启发式匹配，标注为假设**——上游 assignee 是自由 @ 名单，与 WorkBuddy 用户名可能不一致；匹配不上时该筛选返回空并提示改用项目内筛选）。
- **操作**：行内「▶ 派发」走 §6.1 同一 API（projectId 来自分组，无需手选）；「→看板」跳项目 Backlog 页签。编辑/详情仍在项目看板，总览页保持轻量只读+派发。
- **失败隔离**：单项目节点不可达显示独立 chip + 重试按钮，不影响其他项目渲染（overview 返回的 per-project error）。
- **不做**：跨项目拖拽、跨项目全局搜索、实时轮询——后置。

### 7.4 不做的交互（防蔓延）

拖拽改状态（上轮已后置）、完整跨项目看板聚合（7.3 轻量版之外的形式）、看板列自定义、泳道按 assignee 分组——均不进首版。

---

## 8. 分期与验收

### 8.1 范围表（M1 = MVP）

| 需求项 | 优先级 | 内容 | 验收指标 |
|---|---|---|---|
| B1 数据层 `backlog.ts` | 必须 | 编解码、itemId 解析、listBacklog、乐观读写、appendExecutionRecord、initBacklog | 单测：往返写回一致、未知字段与顺序保留、正文不被洗、冲突检测；纯新增模块 |
| B2 初始化（R1） | 必须 | Web 一键初始化（A）+ 指令文案约定（B）+ 导入自动检测（C） | 新项目可在 UI 一键建出 backlog/；导入含 backlog 的项目页签自动点亮；幂等重复初始化不报错 |
| B3 管理 API（R3） | 必须 | §5.2 全部 8 个端点，过鉴权/权限/归档门 | smoke：init→list→create→edit→conflict→delete 全链路（mock 节点）；归档项目写操作被拒 |
| B4 派发闭环（R4） | 必须 | dispatch API + backlogRef + 依赖检查 + 终态回写钩子 + 回写失败标记/重试 | 派发生成 WorkTask 可按 backlogRef 反查；success→done+finalConclusion；failed→回 open+原因；回写失败有标记可重试；回写不破坏既有内容 |
| B5 看板 UI（R5） | 必须 | 页签 + 看板 + 卡片 + 新建/编辑抽屉 + 一键/批量派发 + 空态引导 + 失败可见性 | 走查：未初始化→初始化→建 3 条→派发 1 条→（mock 成功/失败）→状态与徽标正确；冲突提示可用 |
| B6 instruction 文案（N5 文案版） | 建议 | 项目指令可选段：目录约定/状态字段/完成时勾验收置 done | dogfood 1–2 个真实项目一周，统计 agent 遵循率与文件损坏率，达标再谈技能化 |
| B7 「我的待办」统一入口（R6 轻量版） | 必须 | §5.2 overview API（fan-out+失败隔离）+ 侧栏入口 + 按项目分组列表 + 「仅分配给我/仅未完成」筛选 + 行内一键派发 + 跳转看板 | 走查：≥2 个项目聚合正确；1 个项目节点不可达时其余项目正常渲染（失败隔离）；筛选与行内派发可用；进页一次拉取不轮询 |
| 拖拽改状态 / 完整跨项目看板聚合 / agent 组 DAG / 技能化协同 | 暂缓 | — | N4 完整版维持后置（轻量版已按用户 2026-10-31 确认转正为 B7） |

### 8.2 质量门（与仓库规范一致）

`npm run typecheck`、`npm run test:unit`（含 backlog 编解码/状态机单测）、`npm run smoke` 39 项不回归、新增 smoke 子项；e2e 场景补充到 scripts/。

---

## 9. 风险与未决项（如实声明）

1. **~~Backlog.md 字段级格式未独立核实~~ → 已核实（2026-10-31，v1.55.3 本地部署实测）**：字段、段标记、目录布局与生命周期写回均按 §3.2 实测样本锁定；编解码仍保留宽容处理以兼容上游后续版本演进。
2. **/fs/* 无锁**是结构性约束，乐观读改写只保证「不静默覆盖」，不保证「零冲突」；高频双写场景的冲突率需 dogfood 实测。
3. **agent 自觉遵循约定**仍是未验证假设（B6 dogfood 就是为了测它）；首版不依赖 agent 回写状态——回写权威在服务端终态钩子。
4. 上轮评审三位专家产出后半段被截断（PM 指标数值、UX 逐障碍验收信号、架构师成本依据），本版范围表的验收指标为团队推荐值，基线待 dogfood 校准。
5. 逐文件下载列表的性能在条目数百级未实测；若慢，退化方案已预留（mtime 摘要增量拉）。
6. **与上游的已知差异：git 集成不做**。上游依赖 git 自动提交与跨分支任务状态聚合（worktree/多分支看板）；我们把工作区文件当纯文件读写、不做 git 提交（WorkBuddy 项目工作区不一定是 git 仓库）。代价：人/agent 的改动没有提交历史兜底（依赖节点自身快照/备份），跨分支聚合不适用。缓解：乐观写冲突检测 + 执行记录追加写已把误覆盖面压到最小；后续可在「工作区是 git 仓库」的前提下加可选自动提交。

---

## 10. 请用户确认的决策点

| # | 决策点 | 本方案默认值 |
|---|---|---|
| D1 | 存储形态：目录式（`backlog/` 每条一文件，与 Backlog.md 上游一致）vs 单文件 | **目录式** |
| D2 | Web 端新建/编辑录入是否进 MVP（上轮评审的待决策缺口） | **进**（你本轮已明确要求 web 端管理） |
| D3 | 删除语义 | **UI 默认引导 cancelled，物理删除需二次确认** |
| D4 | 失败回写落点 | **回 open（可勾选保持 in-progress）** |
| D5 | 依赖未完成时的派发 | **默认阻止 + 允许忽略强制派发** |
| D6 | 批量派发实现 | **逐条独立派发，不自动组 DAG** |
| D7 | 初始化是否附带示例待办 | **默认不附带（干净起步），可选勾选** |
| D8 | 「我的待办」的「我的」语义（R6） | **默认 = 我可见项目的全部待办按项目分组；附「仅分配给我」筛选（assignee 启发式匹配，失配提示）；总览页只读+派发，编辑回项目看板** |

---

## 11. 附录：与上游 Backlog.md（v1.55.3）功能对照

逐命令族核对（源码 `src/cli.ts` 注册面），三档归类：

### 11.1 M1 已覆盖（任务管理主干）

| 上游能力 | 我们的对应 |
|---|---|
| task create/edit/view/list | B3 管理 API + B5 抽屉/看板（复用派发闭环增强：验收直达 planner） |
| 可配置状态（config.statuses） | §3.2 修正 2：状态映射不硬编码 |
| 标签 / 依赖 / 验收清单 / 优先级 / 截止日期 | 抽屉与卡片全暴露（frontmatter 直通，编解码不洗字段） |
| Final Summary（执行记录） | 回写钩子直接复用该段（上游原生机制） |
| task archive / delete / restore | cancelled 引导 + 物理删除二次确认；恢复=编辑状态改回 |
| board view + Web 看板核心 | B5 项目看板 |
| init / config.yml | 初始化三途径 + statuses/端口等只读消费（config 编辑不进首版） |
| agent 集成的 instructions 路径 | B6 项目指令文案（等效：上游是生成 AGENTS.md，我们是注入项目指令） |
| （上游没有）跨项目聚合 | B7「我的待办」——WorkBuddy 反向增强 |
| （上游没有）执行闭环 | 派发即建任务继承项目节点/成员/技能 + 终态自动回写——上游靠人/agent 手动改状态 |

### 11.2 M1 主动不做、但有明确后置路径

| 上游能力 | 不做的理由 | 后置路径 |
|---|---|---|
| doc / decision 命令族（文档库、决策记录） | 与「待办即工单」目标正交，属 docs-as-code；WorkBuddy 已有附件与文件面板 | 目录天然共存（backlog/docs、backlog/decisions），可后置为只读浏览 |
| milestone 命令族 | 结构化目标管理，labels+dependencies 可近似 | 后置：里程碑分组视图 |
| draft 命令族（草稿→promote） | open 状态覆盖大半语义 | **零成本天然支持**：config.statuses 加一列「Draft」即可（状态可配置是设计前提） |
| search（模糊搜任务/文档/决策） | 首版不做 | WorkBuddy 已有 cmdk 面板，把 backlog 条目接进 cmdk 是自然路径 |
| statistics 统计页 | 低优先 | 后置；任务级 token 统计 WorkBuddy 已有 |
| task comments（留言+作者） | 「执行记录」段覆盖派发记录，独立留言段非必需 | 后置：执行记录段支持多条目（同一追加写机制） |
| DoD 模板（每任务可复用 DoD 清单） | 小功能 | 后置：新建待办的可选模板 |
| board export（markdown 报告） | 低价值 | 后置 |
| MCP server（backlog mcp start） | 不引入上游进程依赖 | **更优形态**：WorkBuddy 自有 mcp-server.ts 暴露 backlog 工具给接入的 agent（技能化协同阶段） |
| 上游 CLI 安装到节点 | 零节点依赖底线 | 同上，作为可选技能经 uploadSkill 注入 |

### 11.3 明确丢弃（含代价声明）

| 上游能力 | 结论 |
|---|---|
| git 自动提交 + 跨分支任务状态聚合 | **不做**（见 §9 风险 6）：工作区当纯文件、不做 git 提交；代价是改动无提交历史兜底、多分支看板不适用。缓解已设计（乐观冲突检测+追加写）；后续可在 git 仓库前提下加可选自动提交 |
| VS Code 扩展 / shell 补全 / doctor / cleanup / watch | 与本集成无关 |

**结论**：M1 覆盖上游「任务管理」主干并叠加 WorkBuddy 独有的执行闭环与跨项目聚合；丢弃项集中在 docs-as-code（文档/决策）、结构化管理（里程碑/草稿）、检索统计与 git/MCP 化集成，均有后置路径且不阻塞闭环。「未充分利用」最值得现在补的已补（抽屉暴露优先级/截止日期；Draft 状态天然兼容）。
