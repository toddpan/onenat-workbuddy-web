# 执行位置 / 模型 / 工作区 / 状态栏体验改造（feat/exec-place-ux）

> 2026-10-28 ~ 2026-10-29 完成。任务源 `TODO.md`（Ralph 循环：P0 系列由循环与人工协作完成，P0-3 起由 ZCode 主会话接续完成剩余 17 个任务）。
> 方案参照 DeepSeek Harness Web（ui-workspace / ui-agent-preset / ui-model-selection / ui-sidebar-right / ui-sidebar-files / ui-deliverables / ui-chat StatsPills）。

## 设计约束（全程遵守）

1. 发送第一条消息前项目/节点/模型都可改；之后锁定在任务上，头部只读展示。
2. 模型按任务保存（`task.model`），只影响当前任务主会话；全局默认模型只在设置页改。
3. 模型目录永远取「任务实际执行节点」（项目任务 = `project.dshRef`，单独任务 = `task.nodeRef`，草稿 = 所选执行位置）。
4. 项目不是模式：侧栏按执行位置分组，无「进入/退出项目」。
5. 换节点 = 新任务续接：最近对话原文作首条草稿（不调用 LLM），双向链接。
6. 工作区文件与变更放右侧栏，打开时聊天区让宽不遮挡。
7. 不改 ONENAT 服务端与 dsh-web-service；节点不支持的能力如实显示原因。
8. 原生 DOM + 字符串模板 + `esc()`，不引入框架与新依赖。

## 变更点（按任务）

### P0 修复（切换不生效 / 模型串任务）

- **P0-1** `selectModel` 写 `PUT /tasks/:id/model` + `session-model`，不再写全局 planner 配置；设置页新增「全局默认模型」卡。
- **P0-2** 新增 `taskExecNodeId` / `reloadCatalogIfExecNodeChanged`：模型目录 `?node=` 跟随任务实际执行节点。
- **P0-3** 项目任务节点以项目为准：`engine.createTask` 带 `projectId` 时丢弃 `nodeRef`（+taskLog）；前端建项目任务不再下发 `env.nodeRef`；头部节点回显按 `project.dshRef`。

### S1 状态栏

- **S1-1** `#task-stats` 拆 ⏱ 时间胶囊（轮·步·tok/s；运行中显示每秒递增的本轮时长，数据源 `todoState`）+ 🗄 Token 胶囊（总量·缓存命中）；点击弹面板（耗时明细 / Token 账本），Esc/点外关闭，窄屏横向滚动。
- **S1-2** SSE `turn_end/subtask_status/task_end` 即时刷新统计与清单；轮询只在运行中保持（统计 5s、todos 3s）；`/stats` 不支持时灰胶囊「统计不可用」+ 原因（`reasonCode`: no_session/offline/unsupported）。

### F2 本轮变更

- **F2-1** engine 在工具调用落盘时保存路径类字段（`tool.paths`，只存路径）；agent 轮末尾「本轮变更」标签（≤6 个 +N），先走下载通道、F1-3 后改为侧栏预览。
- **F2-2** 回复正文行内代码精确等于变更路径（或唯一同名文件）时渲染为链接；同名多于一个不加链接。

### P1 头部与离线

- **P1-1** 头部去节点下拉，改只读执行位置标签（`renderChatPlace`，悬停显示工作区/在线状态/默认模型）；撤项目横幅；运行配置弹窗去「主会话节点」。
- **P1-2** 节点离线：输入框禁用 + 提示条（重试连接 / 在其他节点继续——后者 P4-2 启用）。

### P2 执行位置选择框与草稿页

- **P2-1** `placeState` 两层选择框组件（节点：在线点+引擎徽标+默认模型 → 该节点下项目/单独任务；离线灰显可选），输出 `{nodeMappingId, projectId|null}`；P5-2 扩展 `nodeOnly` 模式。
- **P2-2** 「＋ 新建任务」进草稿态（`state.draft`），首条消息时 `POST /tasks` 带 message 一次完成创建+发送（engine `input.message`）；欢迎页直接输入即发送；附件先建任务再上传；位置记忆（最近一次位置）。

### P3 侧栏分组与项目模式退役

- **P3-1** `renderTaskList` 按执行位置分组（📦 项目组 / 🖥 单独任务组，活跃组靠前，组内倒序默认 5 条「显示更多」入 localStorage）；分组标题「＋」= 组内建草稿；搜索平铺；行标记 pendingAsk 琥珀点 / ⏰ scheduleId / 运行蓝点；删除 `enterProject/exitProject/updateProjectBanner` 与 `wb-project-id`；「进入工作台」= 切工作台 + 展开分组 + 组内建草稿。

### F1/F3 右侧栏

- **F1-1** `ws-side` 侧栏框架：📁 开关、拖宽入 localStorage（≤768px 全屏）、页签条（文件/变更/预览*N）按任务记忆（`wsState.byTask`）。
- **F1-2** 文件页签：根目录 `task.workDir → 项目 workspace → 节点默认 cwd`（灰色注明来源）；懒加载目录树（`/agents/fs/list?node=`，任务 dshRef = 项目→task.nodeRef→所选节点）；上传/新建文件夹/隐藏项/过滤/批量（引用·下载·删除）；点文件开预览页签（图片/Markdown 渲染+源码/文本）。
- **F1-3** 变更页签按轮分组（时间·成员·🖥 节点），F2 标签与行内代码链接改开侧栏预览（`viaTask` 走任务成员下载通道）；目录树标「●已修改」。
- **F3-1** 「引用到对话」全量改为输入框上方可移除 📎 标签，发送时展开为相对路径并入正文；目录树拖文件到目录行即上传（行高亮），拖输入框走原附件上传。

### S2 按成员 Token

- **S2-1** `/stats` 新增 `members[] = { agentId, name, nodeLabel, model, stats }`（合并口径 `stats` 不变）；Token 面板「按成员」分行 + 「查看本任务明细」弹逐轮记录表（`/api/usage/tokens/records?taskId=`）。
- **S2-2** 逐轮用量胶囊：`🗄 总量(K/M) · ⏱ 时长(endedAt-at)`，点开明细（输入/输出/缓存读/写/命中率；远端透传 `ttftMs` 时含首 token）。

### P4 跨节点续接

- **P4-1** `POST /api/tasks/:id/fork`：新任务「↪ 原标题」+ `forkedFrom`/`forks[]` 双向链接 + 原任务插 system 续接轮；draft = 最近 6 轮已完成对话原文（8000 字上限，超长截前面留尾部），不调用 LLM。
- **P4-2** 头部 ⋯「↪ 在其他节点继续…」与离线条按钮：选位置（预填当前位置）→ fork → 打开新任务并带入 draft（不自动发送）；新任务头部「↪ 续自《标题》」面包屑跳回；原任务 system 轮「打开 ↪」。

### P5 一致性收尾

- **P5-1** @ 菜单：子智能体「🖥 节点 · 模型」，专家「在本任务节点执行」。
- **P5-2** 子智能体抽屉与定时任务表单复用执行位置选择框（nodeOnly 层）；抽屉模型输入按 `/dsh-models?node=` 目录过滤（目录外如实提示）；定时任务空模型 = 「跟随节点默认（无人值守任务建议固定模型）」。
- **P5-3** 删除 node-pop 时代死代码（`renderNodePop/setNodeBtnUi/closeNodePop/#node-btn 绑定`，`nodeState.userPicked` 因仍被可达性校正使用而保留）；README 使用流/移动端段落更新；本文档。

## 关键决策

| 决策 | 理由 |
|---|---|
| 项目任务的节点权威在 `project.dshRef` | 引擎 `taskExec` 解析顺序本就项目优先；三处（创建/回显/目录）统一该口径避免「换了项目节点任务还钉旧节点」 |
| fork 带「最近对话原文」而非 LLM 摘要 | 不依赖远端能力、确定性、零成本；LLM 摘要等用户确认后再加（S3 同批延后） |
| 侧栏文件通道复用 `/agents/fs/*?node=` | 接口天然与项目解耦，所有任务（含单独任务）零后端改动可用 |
| 成员文件预览走 `/tasks/:id/files/download?agent=` | 子智能体文件可能在成员节点上，任务通道由服务端按成员解析节点 |
| `nodeState.userPicked` 保留 | 子智能体卡「进入工作台」仍是用户显式选节点路径，可达性自动校正需该护栏 |
| 保留 `sc-node`/`ag-dsh` 下拉 | 直连地址与存量编辑需要；选择框是可视化增强，非替换 |

## 已知限制 / 未做

- UI 行为无自动化浏览器测试：全部前端交互「未做浏览器手测」，smoke 覆盖仅 API 层（含 fork/members/带 message 创建断言）。
- 上下文占用圆环（S3）：需远端 dsh-web-service 提供上下文窗口数据，等远端支持。
- LLM 摘要续接：P4 默认带原文，摘要模式待定。
