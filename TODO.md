# TODO：执行位置 / 模型 / 工作区 / 状态栏 体验改造

> Ralph 循环的唯一任务源。每轮只做一个任务，按顺序取第一个「依赖已完成」的 `[ ]`。
> 状态：`[ ]` 待做 · `[x]` 完成 · `[!]` 阻塞（下一行写原因） · `[~]` 延后（循环跳过）
> 方案来源：2026-10-28 会话评审（参照 DeepSeek Harness Web：`ui-workspace` / `ui-agent-preset` / `ui-model-selection` / `ui-sidebar-right` / `ui-sidebar-files` / `ui-deliverables` / `ui-chat StatsPills`）。

## 设计约束（每个任务都必须遵守）

1. 发送第一条消息前，项目 / 节点 / 模型都可改；之后项目和节点锁定在任务上，头部只显示、不提供切换。
2. 模型按任务保存（`task.model`），只影响当前任务的主会话；全局默认模型只在设置页改。
3. 模型目录永远取「当前任务实际执行的节点」：项目任务 = `project.dshRef`，单独任务 = `task.nodeRef`，草稿 = 所选执行位置。
4. 项目不是一种模式：工作台侧栏按执行位置分组，不再有「进入 / 退出项目」。
5. 换节点 = 在新节点续接：新建任务，最近几轮原文作为首条草稿（不调用 LLM 生成摘要），原任务和新任务双向链接。
6. 工作区文件和变更放在右侧栏，打开时聊天区让出宽度，不遮挡对话。
7. 不改 ONENAT 服务端、不改 dsh-web-service（README D6）。需要远端能力的功能，节点不支持时如实显示原因。
8. 沿用 `src/web-ui.ts` 的现有写法（原生 DOM + 字符串模板 + `esc()` + 现有 CSS 变量），不引入框架和新依赖。

## 验证（每个任务完成前必须全部通过）

```bash
npm run build        # tsc + 内联脚本 node --check
npm run typecheck
npm run smoke        # 自带 mock ONENAT
npm run test:unit    # 改了 engine / router / store / types 时必跑
```

UI 行为目前没有自动化浏览器测试：任务说明里的「验收」若写了 smoke 断言，就必须补上断言；纯视觉部分在完成说明里写清楚「未做浏览器手测」。

---

## P0 修复：切换不生效 / 模型串任务（不改交互）

- [x] **P0-1** 模型按任务保存，不再写全局
  - 完成：selectModel 改写 task.model + session-model，modelState 拆 cur/globalDefault，设置页新增「全局默认模型」卡；smoke 新增 5 项断言。验证：npm run build / typecheck / smoke（59 项全过）
  - 依赖：无
  - `selectModel()`（web-ui.ts，搜 `async function selectModel`）：有当前任务时写 `PUT /tasks/:id/model`（路由已存在，router.ts 搜 `taskModelMatch`），有远端会话时再调 `PUT /tasks/:id/session-model` 即时生效；不再 `POST /planner/config`。无当前任务时写入 `state.taskEnv.model`，`createNewTaskDirectly` 随 `body.model` 下发（核对 router `POST /api/tasks` 是否把 `model` 透传给 `engine.createTask`，没有就补）。
  - `MODEL_NOT_IN_CATALOG` 的回滚改为回滚 `task.model`，不再回滚 planner 设置。
  - 打开任务时模型按钮回显 `task.model`；为空时显示「跟随默认 · <默认模型名>」。
  - 设置页要有「主调度默认模型」入口（复用 `/planner/config`）；没有就加。
  - 验收：smoke 新增断言——对任务 A 调 `PUT /model` 后，`GET /api/settings` 的 `planner.model` 不变，任务 B 的 `model` 不变。

- [x] **P0-2** 模型目录跟随任务实际执行节点
  - 完成：新增 taskExecNodeId / currentTaskObj / reloadCatalogIfExecNodeChanged，loadPlannerOptions 的 ?node= 改按任务执行节点，openTask / resetChatView / initNodeState 按需重拉；syncNodeChipToTask 与有任务时的 selectNode 不再改目录。验证：npm run build / typecheck / smoke（59 项全过）；未做浏览器手测
  - 依赖：P0-1
  - 新增 `taskExecNodeId(task)`：`project.dshRef`（mapping）→ `task.nodeRef`（mapping）→ `nodeState.cur`。`loadPlannerOptions()` 的 `?node=` 改用它；`openTask` 后执行节点变化时重拉目录。
  - 打开已有任务时，`selectNode` / `applyReachableNodeDefault` 不得再改变模型目录。
  - 验收：build / typecheck / smoke 通过；在 `.ralph/progress.md` 写下手测步骤。

- [ ] **P0-3** 项目任务的节点以项目为准
  - 依赖：P0-2
  - `createNewTaskDirectly`：项目任务不再带 `env.nodeRef`。
  - `syncNodeChipToTask`：项目任务按 `project.dshRef` 回显（核对 `/api/projects` 是否返回 `dshRef`）。
  - 后端兜底：带 `projectId` 创建任务时丢弃 `nodeRef`（engine `createTask` 或 router `POST /api/tasks`）。
  - 验收：smoke 断言——带 `projectId` 和 `nodeRef` 创建任务后，任务上没有 `nodeRef`。

## S1 状态栏改造（前端为主）

- [ ] **S1-1** 状态栏拆成两个胶囊 + 两个面板
  - 依赖：P0-3
  - `renderTaskStats()` 不再输出单行文本，`#task-stats` 内渲染：
    - ⏱ 时间胶囊：`轮 · 步 · tok/s`；运行中改为显示每秒递增的「本轮时长」。
    - 🗄 Token 胶囊：`总 token · 缓存命中 %`。
  - 点击胶囊弹出面板：时间面板（本轮运行 / LLM 耗时 / 工具耗时 / 首 token 平均 / 输出速度）；Token 面板（输入 / 输出 / 缓存读 / 缓存写）。点外部或按 Esc 关闭。手机端横向滚动，不截断。
  - 运行时长从 `renderTodoDock` 的 `#todo-elapsed` 移到时间胶囊（继续用 `todoState.running / baseElapsed / anchorAt` 作数据源），todo 坞只显示任务清单。
  - 验收：build / typecheck / smoke 通过。

- [ ] **S1-2** 事件驱动刷新 + 不支持时如实显示
  - 依赖：S1-1
  - SSE 的 `turn_end` / `subtask_status` / `task_end` 到达时立即 `loadTaskStats()`、`loadTaskTodos()`；轮询只在任务运行中保持（统计 5s、todos 3s），空闲时停止。
  - `/stats` 返回 `supported:false` 时显示灰色胶囊「统计不可用」，`title` 写原因。核对 router `getTaskStats` 的返回字段，没有原因就补上（如节点版本过低）。
  - 验收：build / typecheck / smoke 通过。

## F2 本轮变更文件（前端为主）

- [ ] **F2-1** 每轮回复末尾显示「本轮变更」
  - 依赖：S1-2
  - 先读 `types.ts` 的 `TurnToolCall` 和 engine 记录工具调用的位置，确认工具参数是否落盘。
    - 已落盘：前端从每轮工具调用里提取写入 / 编辑类工具（按实际工具名单，如 write / edit / str_replace_editor / apply_patch）的路径参数，去重。
    - 未落盘：在 engine 记录工具调用时额外保存路径类字段（只存路径，不存内容），并补单元测试。
  - agent 轮末尾渲染变更标签：最多 6 个，多出的显示 `+N`，`title` 为完整路径；点击走现有 `/tasks/:id/files/download?agent&path`（F1 完成后改为右侧栏预览）。
  - 验收：build / typecheck / smoke（改了 engine 时加 test:unit）通过。

- [ ] **F2-2** 回复里的文件路径可点击
  - 依赖：F2-1
  - AI 回复中的行内代码，若精确等于变更列表中的某个路径，或等于唯一一个变更文件的文件名，就渲染为链接；同名文件多于一个时不加链接。
  - 验收：build / typecheck / smoke 通过。

## P1 头部只读 + 节点离线

- [ ] **P1-1** 头部改成只读的执行位置标签
  - 依赖：F2-2
  - `chat-head` 去掉 `#node-picker`，改为只读标签「📦 项目 · 🖥 节点」，悬停显示工作区路径和节点在线状态 / 默认模型。草稿（还没有远端会话）时不显示，留给 P2 的选择框。
  - 去掉 `updateProjectBanner` 横幅：「工作区文件 / 项目配置」挪进头部 `⋯` 菜单。暂不删 `enterProject`/`exitProject`（P3 再删），只是不再插入横幅、不再隐藏节点选择器。
  - 运行配置弹窗（`openRunConfig`）删除「主会话节点」下拉，只保留连接器和技能。
  - 验收：build / typecheck / smoke 通过；grep 不到 `node-picker` 的显示/隐藏逻辑残留。

- [ ] **P1-2** 节点离线时禁用输入框并给出操作
  - 依赖：P1-1
  - 打开任务后按执行节点的引擎探测结果（`state.resources[].engine.reachable`）判断；离线时输入框禁用，输入区上方显示「🖥 X 当前离线，这个任务的会话保存在该节点上 · [重试连接] [在其他节点继续 →]」。
  - 「在其他节点继续」在 P4 完成前先显示为禁用，`title` 写「即将支持」。重试 = `refreshNodeEngines(true)` 后重新判断。
  - 验收：build / typecheck / smoke 通过。

## P2 执行位置选择框 + 空白新任务页

- [ ] **P2-1** 执行位置选择框组件
  - 依赖：P1-2
  - 两层菜单：节点（在线点 + 引擎徽标 + 默认模型）→ 该节点下的项目 + 「不使用项目（单独任务）」。离线节点灰显但可选。
  - 输出 `{ nodeMappingId, projectId|null }`；选项目时节点自动取项目节点。
  - 只实现组件和状态（`placeState`），这一步不接入页面；复用 `renderNodePop` 的分组和探测逻辑，旧 `node-pop` 先保留。
  - 验收：build / typecheck / smoke 通过。

- [ ] **P2-2** 空白新任务页 + 首条消息时才创建
  - 依赖：P2-1
  - 「＋ 新建任务」不再调用 `POST /tasks`：进入草稿态（`state.draft = { place, model }`），聊天区居中显示输入框，下方放执行位置选择框，模型按钮可用；侧栏对应分组顶部加一行临时的「新任务（草稿）」。
  - 发送第一条消息时 `POST /tasks`，body 带 projectId / nodeRef / model 和 message（核对 router 是否支持带 message 创建即发送，engine `createTask` 有 `input.message`），然后打开任务。附件上传前若没有任务，先创建再上传。
  - 默认位置：侧栏分组的「＋」→ 当前任务的位置 → 本地记录的最近一次位置。
  - 切换位置时保留草稿文字；新节点的目录里没有当前模型时，回退到节点默认模型，并提示一次。
  - 团队任务（`teamId`）、专家团「🚀 发任务」等其他建任务入口保持原样。
  - 验收：build / typecheck / smoke 通过；smoke 补断言——带 message 创建任务后，任务里有 1 个 user 轮次。

## P3 侧栏按执行位置分组

- [ ] **P3-1** 侧栏分组 + 删除项目模式
  - 依赖：P2-2
  - `renderTaskList`：分组 = 每个项目一组（📦 名称 · 🖥 节点）+ 每个节点一组「单独任务」；组内按更新时间排序，默认显示 5 条，「显示更多」展开；展开状态存在 localStorage。分组标题上的「＋」= 在该位置新建草稿。
  - 搜索时改为平铺的结果列表；已归档仍单独成组。
  - 删除 `enterProject`/`exitProject`/`updateProjectBanner` 的过滤模式和 `wb-project-id` sessionStorage；项目页「进入工作台」改为切到工作台、展开该项目分组、在组内建草稿。
  - 行标记：运行中蓝点、`pendingAsk` 琥珀点、`scheduleId` 显示 ⏰（核对任务列表接口是否返回这些字段，没有就补上摘要字段）。
  - 验收：build / typecheck / smoke 通过；grep 不到 `state.projectId` 用于过滤任务列表的逻辑。

## F1 右侧栏：工作区文件

- [ ] **F1-1** 右侧栏框架
  - 依赖：P3-1
  - 聊天区右侧新增可收起的侧栏，打开时聊天区让出宽度（不是遮罩）；宽度可拖动，存 localStorage；≤768px 全屏打开。头部 📁 按钮负责开关。
  - 页签条：文件 / 变更 / 预览（可关闭，可开多个）。页签状态按任务记忆，切换任务时恢复。
  - 验收：build / typecheck / smoke 通过。

- [ ] **F1-2** 文件页签：目录树，所有任务可用
  - 依赖：F1-1
  - 根目录优先级：`task.workDir` → 项目 `workspace` → 节点默认（远端 cwd 列表接口）。顶部路径行用灰色注明来源。
  - 逐层展开的目录树，展开时才加载；保留上传、新建文件夹、显示隐藏项、过滤、多选批量操作（引用 / 下载 / 删除）。复用 `pjFiles*` 的接口调用，项目抽屉入口改为打开侧栏。
  - 点文件 = 新开预览页签（复用现有的预览渲染）；⋯ 菜单：引用到对话 / 下载 / 复制路径 / 删除。
  - 验收：build / typecheck / smoke 通过。

- [ ] **F1-3** 变更页签 + 目录树修改标记
  - 依赖：F1-2, F2-2
  - 变更页签按轮分组列出 F2 算出的变更文件；目录树中对应文件标「●已修改」。F2 的变更标签和路径链接改为在侧栏里打开预览。
  - 子智能体在别的节点改的文件，标出 🖥 节点名，打开时走该成员的下载通道。
  - 验收：build / typecheck / smoke 通过。

- [ ] **F3-1** 输入框文件标签 + 拖放
  - 依赖：F1-3
  - 「引用到对话」改为在输入框上方显示可移除的 📎 文件标签（textarea 内做不了原子标签，所以放在输入框上方），发送时展开为相对工作区的路径并入正文。
  - 文件拖到目录树上 = 上传到该目录；拖到输入框 = 走现有附件上传。
  - 验收：build / typecheck / smoke 通过。

## S2 按成员拆分 Token + 逐轮胶囊

- [ ] **S2-1** Token 面板按成员拆分
  - 依赖：F3-1
  - 先读 router `getTaskStats`：在合并各成员统计之前保留每个成员的数据，返回 `data.members[] = { agentId, name, nodeLabel, model, stats }`，合并后的 `data.stats` 保持不变（向后兼容）。
  - Token 面板列出「主会话 / 🤖 成员 · 🖥 节点 · 模型 · token · 缓存命中」，底部「查看本任务明细 →」跳到 Token 报表并按 `taskId` 筛选（现有 `/api/usage/tokens/records?taskId=`）。
  - 验收：build / typecheck / smoke / test:unit 通过；smoke 断言 `/stats` 返回 `members` 字段（mock 下可以是空数组）。

- [ ] **S2-2** 逐轮用量胶囊
  - 依赖：S2-1
  - agent 轮的操作行右侧显示 `🗄 8.2K`、`⏱ 34秒`，点开看这一轮的输入 / 输出 / 缓存 / 首 token。数据来自 `TaskTurn.usage`（先核对字段）；没有数据就不显示。
  - 验收：build / typecheck / smoke 通过。

## P4 跨节点续接

- [ ] **P4-1** 后端 `POST /api/tasks/:id/fork`
  - 依赖：S2-2
  - body `{ nodeRef?, projectId? }`：创建新任务 `↪ 原标题`，记录 `forkedFrom: { taskId, at }`，原任务追加 `forks[]`（types.ts 加可选字段，store 向后兼容）。
  - 返回 `draft`：最近 N 轮已完成对话的原文（默认 6 轮，总长上限 8000 字，超长截断前面的部分），开头写「以下是在 <原节点> 上进行的任务《标题》的最近对话：」。不调用 LLM。
  - 原任务插入一条 system 轮次「已在 🖥 X 继续 → <新任务ID>」。
  - 验收：test:unit 覆盖 draft 截断和双向链接；smoke 覆盖接口。

- [ ] **P4-2** 前端续接入口
  - 依赖：P4-1
  - 头部 `⋯` 菜单「在其他节点继续…」和 P1-2 离线条的按钮：弹出执行位置选择框（预填同项目或其他节点）→ 调 fork → 打开新任务，并把 `draft` 填进输入框（不自动发送）。
  - 新任务头部面包屑显示「续自《标题》」，可跳回原任务；原任务里那条 system 轮次可点击跳到新任务。
  - 验收：build / typecheck / smoke 通过。

## P5 一致性收尾

- [ ] **P5-1** @ 菜单显示执行位置
  - 依赖：P4-2
  - 子智能体：「🤖 名称 · 🖥 节点 · 模型」；专家：「🧠 名称 · 在本任务节点执行」。
  - 验收：build / typecheck / smoke 通过。

- [ ] **P5-2** 子智能体抽屉 / 定时任务表单复用选择框
  - 依赖：P5-1
  - 子智能体抽屉：节点用执行位置选择框（只有节点层），模型下拉按所选节点的目录过滤。定时任务表单：执行位置 + 模型；模型为空时显示「跟随节点默认（无人值守任务建议固定模型）」。
  - 验收：build / typecheck / smoke / smoke:schedules 通过。

- [ ] **P5-3** 清理与文档
  - 依赖：P5-2
  - 删除没人用的 `node-pop`、`nodeState.userPicked` 等旧逻辑；README「使用流」和移动端适配段落按新交互更新；在 `docs/` 新增 `feat-exec-place-ux.md` 记录本次改造（决策和变更点）。
  - 验收：build / typecheck / smoke / test:unit 全部通过。

## 延后（循环跳过）

- [~] **S3** 上下文占用圆环：需要远端 dsh-web-service 提供上下文窗口和占用数据，违反约束 7，等远端支持后再做。
- [~] **LLM 摘要续接**：P4 默认带原文；摘要模式等用户确认后再加。

