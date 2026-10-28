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
