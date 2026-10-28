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
