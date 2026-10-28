# Ralph 进度日志

每轮工人在末尾追加 ≤8 行。只追加，不改写已有内容。

## 2026-10-28 初始化

- 任务源：TODO.md（P0 → S1 → F2 → P1 → P2 → P3 → F1 → F3 → S2 → P4 → P5）。
- 代码地图：前端全部在 `src/web-ui.ts`（内联脚本字符串，注意 `\\` 转义——模板内的反斜杠要写两次）；路由在 `src/router.ts`；任务执行在 `src/engine.ts`（`taskExec` 决定执行节点，`ensureSession` 一带决定主会话模型）。
- 已知关键位置：`selectModel` / `loadPlannerOptions` / `syncNodeChipToTask` / `selectNode` / `createNewTaskDirectly` / `renderTaskStats` / `renderTodoDock` / `enterProject` / `updateProjectBanner` / `openProjectFiles`。
- 已有接口：`PUT /api/tasks/:id/model`（任务级模型）、`PUT /api/tasks/:id/session-model`、`GET /api/tasks/:id/stats|todos`、`/api/usage/tokens/records?taskId=`。

## P0-1（主会话手工完成）
- web-ui.ts：`selectModel` 先 PUT session-model（跟随默认时下发 globalDefault），成功或 NO_SESSION 后 PUT /tasks/:id/model；无任务写 `state.taskEnv.model`，`createNewTaskDirectly` 带 `body.model`。
- `modelState.cur` = 任务级模型（空=跟随默认），`modelState.globalDefault` = settings.planner.model；新增 `followDefaultName()` / `currentTaskModelChoice()`。
- `loadPlannerOptions` / `selectMainAgent` 回包只更新 globalDefault；`loadSessionModelInfo` 用 `d.taskModel` 回显。
- 设置页新增「全局默认模型」卡（`renderDefaultModelSetting` + `#btn-save-default-model` → POST /planner/config {model}）。
- smoke 5.1 节 5 项断言；临时任务结尾删除，保持「tasks=2」断言。
- 注意（P0-2）：`loadPlannerOptions` 仍按 `nodeState.cur` 拉目录；设置页下拉用的也是这份目录。

## P0-2
- web-ui.ts：新增 `currentTaskObj()` / `taskExecNodeId(task)`（项目 dshRef → task.nodeRef → nodeState.cur，均只认 mapping）/ `reloadCatalogIfExecNodeChanged()`；`loadPlannerOptions` 的 `?node=` 和 `loadedForNode` 改用执行节点。
- 重拉时机：`openTask` 末尾、`resetChatView` 末尾、`initNodeState`；`syncNodeChipToTask` 删除了 loadPlannerOptions，`selectNode` 仅在无当前任务时重拉；`applyReachableNodeDefault` 原本就跳过有任务的情况。
- 手测步骤（未做）：节点 A/B 各一个任务 → 打开 A 任务看模型弹层目录来源（按钮 title「模型目录: 」）为 A → 打开 B 任务应切到 B → 有任务时在节点下拉选别的节点，目录不变 → 删除/关闭任务回空视图，目录回到所选节点；项目任务目录应为项目 dshRef 节点。
- 注意（P0-3）：`createNewTaskDirectly` 仍对项目任务带 env.nodeRef；`syncNodeChipToTask` 仍只看 task.nodeRef。

## P0-3
- engine.ts `createTask`：带 projectId 时不再落 nodeRef（任务对象铺开处按 `!input.projectId && input.nodeRef` 守卫），并 taskLog 一条「项目任务节点以项目为准，已忽略请求中的 nodeRef」。排查过其它 createTask 调用方（router 项目导入/安装/插件导出、scheduler）均不带 projectId，无误伤面。
- web-ui.ts `createNewTaskDirectly`：项目任务不再下发 `env.nodeRef`（`if (!proj && env.nodeRef)`）。
- web-ui.ts `syncNodeChipToTask`：先按 project.dshRef 回显（mapping→nodeState.cur+taskEnv；direct→「直连」；app/快照缺失→项目摘要 nodeTitle 兜底），项目分支 return true 不再落到 task.nodeRef。返回值调用方未使用。
- smoke 新增 5.2 节 4 项断言（创建项目 → projectId+nodeRef 同传创建任务断言无 nodeRef → 回读仍无 → 对照单独任务保留 nodeRef）；engine.test.ts 新增单测「项目任务节点以项目为准」。
- 验证：build / typecheck / smoke（63 项）/ test:unit（77 项）全过；未做浏览器手测。
- 手测步骤（未做）：进入项目工作台点「＋新建任务」→ 头部节点应显示项目节点（非默认节点），模型目录来源为项目节点；带 nodeRef 的存量项目任务打开后头部同样显示项目节点；网络层确认 POST /api/tasks 请求体无 nodeRef。

## S1-1
- web-ui.ts：`#task-stats` 内改为 `.stat-pills`（`#stat-pill-time` / `#stat-pill-tok`）+ `#stat-panel`；新增 `renderStatPills` / `renderStatPanel` / `closeStatPanel` / `statsLiveElapsed` / `statsSpeed`，`renderTaskStats` 只存 `statsState.stats` 后调 `renderStatPills`；statsState 加 `stats` / `panel`。
- 运行时长：`renderTodoDock` 开头更新 `todoState.running/baseElapsed/anchorAt` 后调 `renderStatPills`；`tickTodoElapsed`（1s）改为刷新胶囊；`#todo-elapsed` 与其 CSS 已删；todo 坞无清单即隐藏；/todos 不支持时把 running 置 false。
- 关闭面板：胶囊外点击 + document Esc（stopPropagation）；`resetTaskStats` 会关闭面板。
- 注意（S1-2）：轮询仍是 statsState.timer 5s / todoState.timer 3s 常驻；`supported:false` 时 renderTaskStats(null)，胶囊直接隐藏，还没有「统计不可用」灰胶囊。
- 未验证：浏览器手测（胶囊样式、面板定位、手机端横滑、运行中每秒递增）。

## S1-2
- router.ts `getTaskStats`：supported=false 时附 `reasonCode`（no_session 无绑定 / offline 成员节点全离线 / unsupported 远端过旧，reason 取 client 返回的 error）+ `reason`。
- web-ui.ts：新增 `syncLivePolling(running)`（setSending 末尾调用；startTaskStats/TodosPolling 改为拉一次 + 按 body.task-running 决定）；subtask_status / task_end 监听补 `loadTaskStats()` + `loadTaskTodos()`。
- `statsState.unsupported` 存原因；`renderStatPills` 无数据且有原因时时间胶囊显示「统计不可用」（`.stat-pill.off` 灰虚线，title=原因，点击不开面板）；no_session 不提示。
- 注意：todo 的 1s tick 仍常驻（只在 running 时渲染）；/todos 不支持时尚无提示（不在本任务范围）。
- smoke 新增 1 项（新任务 /stats → reasonCode=no_session）。未验证：浏览器手测（灰胶囊样式、空闲时 Network 无轮询、运行结束轮询停止）。

## F2-1
- 结论：`TurnToolCall.args` 是截断到 400 字符的摘要，write 类工具 content 在前时路径会丢 → 按「未落盘」处理。
- types.ts `TurnToolCall.paths?: string[]`；engine.ts 新增导出 `extractToolPaths(name, args)`（写类工具名口径同前端 toolMeta；str_replace_editor 的 view 排除；支持 path/file_path/notebook_path/edits[]/apply_patch 补丁头），`onToolCall` 落 `tool.paths`；engine.test.ts 新增 1 个单测。
- web-ui.ts：新增 `turnChangedPaths(turn)`（跳过 status=error，去重）/ `renderTurnChanges(foot, turn, taskId)`（插在 `.dsh-actions-foot` 前，≤6 + `+N`，title=完整路径，href=/tasks/:id/files/download?agent&path）；调用点：`buildTurnElement` 非流式分支、`finalizeTurnBlocks` 末尾。CSS `.dsh-changes` / `.dsh-change-chip`。
- 注意（F2-2）：可直接复用 `turnChangedPaths(turn)` 作为变更列表；`withFileLinks` 会先把行内代码 stash 掉，F2-2 需在 md 渲染后或 stash 还原时处理。存量历史轮没有 paths，不显示变更。
- 未验证：浏览器手测（标签样式、流式结束后出现、点击下载相对路径是否能被节点解析）；没有补 smoke 断言（mock 流不产生写类工具）。

## F2-2
- web-ui.ts：新增 `changedPathForCode(code, paths)`（精确路径命中 → 否则文件名唯一命中，同名>1 返回空）/ `linkChangedPathsInBody(body, paths, turn, taskId)`（遍历 `.dsh-body code`，跳过 pre 内和已在 a 内的，外包 `a.dsh-change-link`，href 同 F2-1 下载地址）。
- 调用点：`renderTurnChanges` 渲染完变更标签后调用，历史回放与 `finalizeTurnBlocks` 收尾两条路径都覆盖；变更列表为空时不处理。CSS `a.dsh-change-link code` 点状下划线。
- 注意（F1）：右侧栏预览上线后，变更标签与正文链接的 href 要一起改。
- 未验证：浏览器手测（链接样式、点击下载）；没有补 smoke 断言（mock 流不产生写类工具，与 F2-1 相同）。

## P1-1
- web-ui.ts：头部 `#node-picker` 换成 `#chat-place`（.badge.place）+ `#head-more`/`#head-more-pop`；新增 `taskPlaceInfo(task)` / `renderChatPlace(task)` / `closeHeadMore()`；调用点：`refreshChatHead`、`resetChatView`、`refreshNodeEngines`（changed 时）、`updateProjectBanner`。
- `updateProjectBanner` 只删旧横幅并调 `renderChatPlace`；`exitProject` 去掉 picker 显示逻辑；`openProjectFiles(pid)` 支持传项目 id（⋯ 菜单按任务所属项目）。
- `openRunConfig`：单独任务不再有 `#rc-node` 下拉，保存只写连接器/技能；项目任务仍显示锁定节点和工作区。
- 注意（P1-2/P2）：`#node-btn`/`#node-pop` DOM 已删，`setNodeBtnUi`/`renderNodePop`/`selectNode` 仍在（都判空），`nodeState.cur` 仍是新任务的默认节点；P2 选择框可复用 `renderNodePop` 的分组探测逻辑。标签悬停在线状态读 `res.engine`，P1-2 可复用 `taskPlaceInfo(task).res`。
- 标签只在 task.sessions 非空时显示（草稿不显示）。
- 验证：build / typecheck / smoke（64 项）全过；未跑 test:unit（只改了 web-ui.ts）；未做浏览器手测（标签样式、悬停 title、⋯ 菜单定位、手机端换行）。

## P1-2
- web-ui.ts：新增 `renderNodeOffline(task)` / `retryNodeConnection()`，在 `renderChatPlace` 末尾调用（这样 refreshChatHead / resetChatView / refreshNodeEngines 三条路径都会覆盖）；HTML 在 `#composer-hint` 后加 `#node-offline`；新增 CSS `.node-offline` 和 `textarea:disabled`。
- 判定条件：task.sessions 非空，且 `taskPlaceInfo(task).res.engine.reachable === false`。没探测过（engine 缺失）不算离线，草稿也不判断。
- 离线状态记在 `body.node-offline` 上：`setSending` 据此决定发送键是否禁用，`send()` 遇到离线直接返回；重试中的状态记在 `#node-offline` 的 `data-retrying`。
- 注意（P4-2）：「在其他节点继续 →」按钮是 `[data-op="fork"]`，目前写死为 disabled，P4 接上续接入口时要把它启用并绑定事件。
- 未验证：浏览器手测（离线条样式、禁用效果、重试流程）；没补 smoke 断言（mock 没有离线节点）。只改了 web-ui.ts，所以没跑 test:unit。

## P2-1
- web-ui.ts：从 `renderNodePop` 抽出 `dshNodeGroups(opts)` / `dshNodeItemHtml(n, isCur, extra)` / `probeNodesIfStale(opts)`，旧 node-pop 改用它们，行为不变。
- 新增 `placeState`（place / pop / anchor / level / browse / onChange）和 `openPlacePop(anchor, place, onChange)` / `renderPlacePop` / `selectPlace` / `closePlacePop` / `normalizePlace` / `placeLabel` / `placeProjectNode` / `placeNodeProjects`。弹层动态挂在 body 上（`.main-agent-pop.place-pop`，fixed 定位，下方空间不够就向上弹）；外部点击或 Esc 关闭；`refreshNodeEngines` 在 changed 时会重绘它。
- 第一层：选节点（副标题写「N 个项目 ›」或「单独任务 ›」）；第二层：「不使用项目」+ 该节点下的项目（按 dshRef.mappingId 匹配）。选项目时 `normalizePlace` 节点取项目节点。
- 注意（P2-2）：组件没有接入页面，草稿页调用 `openPlacePop(btn, state.draft.place, cb)` 即可，按钮文字用 `placeLabel(place)`。dshRef 是 direct/app 的项目不会出现在任何节点下。
- 未验证：浏览器手测（弹层定位、两层切换、离线灰显）；没补 smoke 断言（纯前端组件）。只改了 web-ui.ts，没跑 test:unit。

## P2-2（ZCode 主会话接管收尾）
- 第 9 轮工人跑到 70 轮时被上游 404（claude-haiku-5-5 不受账号组支持，aborted_streaming）打断，$26.86 沉没；循环按脏树守卫自动 PAUSE。产物检查：web-ui.ts +247/-36、smoke +2 断言，build/typecheck/smoke(66) 全绿，实现完整（draft 态/草稿行/commitDraft/兼容入口/附件先建后传），判定可直接收尾，主会话代为提交。
- 用户指示改向：剩余任务由 ZCode 主会话直接完成，claude CLI 循环与监工停止，定时巡检自动化撤除。
- 注意（后续任务）：createNewTaskDirectly 现签名 (message)，返回任务 id；草稿弹层复用 P2-1 placeState（renderPlacePop/closePlacePop）；P3-1 分组渲染里已有 draftOn 分支（draftTaskItemElement），改造 renderTaskList 时保留。

## P3-1（ZCode 主会话）
- renderTaskList 整体替换为执行位置分组（taskPlaceKey：proj:<id> / node:<mappingId>）；saveGroupPrefs + wb.groupCollapsed/wb.groupMore 持久化；分组「＋」→ startDraft(place)。
- 项目模式删除面：state.projectId 字段、enterProject/exitProject/updateProjectBanner、wb-project-id、pj-enter/命令面板入口、openRunConfig（curTask 来源）、头部⋯菜单（去掉「退出项目」项）、openProjectFiles（pid 必传）；「进入工作台」统一 = switchView('work') + 展开分组 + startDraft({projectId})。
- 行标记：createTaskItemElement 的点支持 t.pendingAsk（.s.ask 琥珀）、title 前缀 ⏰（taskSummary 新增 scheduleId）；.s.running 改 var(--pri) 蓝。
- 坑：openRunConfig 内已有遗留 const curTask（同函数重复声明）→ build 的 node --check 才能抓到（tsc 不查内联脚本）；已删遗留两行。
- smoke「数据落盘」断言偶发中间态（防抖尾随写），改 5s 轮询到满足。验证四件套全过；未做浏览器手测。

## F1-1（ZCode 主会话）
- ws-side：HTML 在 </section>(chat-main) 后、CSS 挂 .gh-more 锚点后；display 由 .on 类控制；media ≤768 全屏（width:100%!important，拖手隐藏）。
- JS：wsState{open,width,byTask}；wsTaskState()=byTask[currentTaskId]；openWsTab(kind,extra)/closeWsTab(key)/openWsSide(tab?)/closeWsSide/wsRestoreForTask；wireWsSide IIFE 绑 📁/✕/拖宽。preview 页签 key='preview:'+path。
- 接线：applyTaskToView 显示 📁 + wsRestoreForTask；resetChatView 隐藏 📁 + closeWsSide。
- 注意：openRunConfig 那次 curTask 重复声明的教训——同函数内加局部变量先 grep；锚点替换若 count!=1 先看上下文（S1-1 工人已改过 task-stats 区块）。

## F1-2（ZCode 主会话）
- wsFiles 状态 + wsTaskDshRef/wsTaskFileCtx（根目录三级优先）+ 懒加载 levels{dirPath:{open,entries,loading,error}} + 委托式 tree.onclick；wsPreviewRender 进 ws-body（复用 md()/code-preview-box）；wsRefToChat 相对路径引用。
- 头部⋯「工作区文件」→ openWsSide({kind:'files'})；openProjectFiles 暂留（P5-3 清理）。renderWsSide 按 tab.kind 分发 mount。
- 大坑（再犯就打脸）：web-ui.ts 是 TS 模板字面量——要写进内联脚本的 `\n` 必须在源码里写 `\\n`；python heredoc 里写 '\\\\n'（4 个）才落成源码 '\\n'（3 字符）。node --check 才能抓到，tsc 不查。
- openRunConfig 的 curTask 重复声明教训同前：新增局部名先 grep。

## F1-3（ZCode 主会话）
- wsTaskChanges/wsChangesAllPaths（turnChangedPaths 复用 F2 提取）+ wsChangedCache 按 taskId 缓存（树标记用）；wsChangesMount 按轮分组渲染。
- 预览双通道：tab.viaTask → /tasks/:id/files/download?agent=（成员节点）；否则 /agents/fs/download?node=。F2 chip 与行内代码链接的 click 都走 openWsSide preview。
- 注意：dsh-change-chip 从 <a> 改成了 span[role=button]（保留键盘 Enter/Space）；F2 的 CSS 不用动。

## F3-1（ZCode 主会话）
- state.fileTags + composeOutgoingText/clearFileTags/renderFileTags；引用入口（wsRefToChat/addFileTag/批量×2/pjRefToChat）全改标签；send() 两分支成功后清；openTask 切换清。
- 目录树 drop：wsFilesRenderAll 里委托 dragover/drop（行→该目录/文件→父目录/空白→lastDir），wsFilesUpload(files,dest) 共用。
- 第三次踩模板转义坑（'\\n'）：python heredoc 写源码级反斜杠一律用 4 写法；以后任何含 \n 的 JS 字符串进 web-ui.ts 都先想这步。

## S2-1（ZCode 主会话）
- getTaskStats：bindings.map 出 members（agent.dshRef||task.nodeRef||proj.dshRef → nodeLabelOf），stats 只在 ok 时带；payload.stats 原样。
- 前端 statsState.members；Token 面板「按成员」区 + sp-foot「查看本任务明细」→ openTaskUsageReport（openModal 表格，records?taskId=&limit=200）。
- 注意：路由改动若再动 getTaskStats，payload 里已有 reasonCode/reason（S1-2 加的）别弄丢。

## S2-2（ZCode 主会话）
- applyUsageBadge(el, usage, turn)：button 化 + fmtStatsTokens 压缩 + durMs=turn.endedAt-at（流式中 turn 未收尾无 ⏱，turn_end 重渲染后出现）；openTurnUsageDetail 弹层。4 个调用点补 turn。
- 远端 usage 事件字段（remote-client 透传）：uncachedInputTokens/inputTokens/cacheReadTokens/cacheWriteTokens/outputTokens；ttftMs 只在 session stats。别在逐轮明细承诺首 token 一定有。
