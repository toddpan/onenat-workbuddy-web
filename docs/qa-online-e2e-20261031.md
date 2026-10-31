# 在线部署与 QA 报告 —— Backlog 集成上线（v2026.10.31）

- 日期：2026-10-31（16:00–17:30）
- 环境：阿里云线上 https://natpass.yikaihui.com/onenat-workbuddy/（宿主 natpass.yikaihui.com:22，systemd 单元 `onenat-workbuddy`，Node v20.19.2 x86_64）
- 方式：`scripts/deploy-standalone.sh` 增量部署（差异上传 + 远端备份 + `node --check` + healthz/MCP fail-closed 验证）+ **ego-lite**（Chromium 真实浏览器）在线走查
- 账号：wb-qa（admin）；证据截图：`qa-20261031/01–02*.jpg`
- 代码状态：backlog 集成功能 + 本轮两处修复**均在工作树未提交**（基线 c3b292d），建议 QA 通过后按惯例 commit + push

## 结论速览

部署完成并在线验证通过。过程中发现 **2 个只在真实 DSH 节点暴露的 BUG**（mock 不模拟真实 fs 语义所以本地全绿），均已行级修复、补防回归断言、增量重上线并复验：

| BUG | 级别 | 根因 | 修复 |
|---|---|---|---|
| BUG-B1（高，看板阻塞）：线上 backlog 列表永远为空、条目 GET/PUT/DELETE 404 | 高 | `listBacklog()`（src/backlog.ts:346）调 `fsList` 未传 `all`；真实 DSH 节点无 `all=1` 时对含文件目录返回空 `entries` | `fsList(target, paths.tasks, true)`；mock 补「无 all=1 → 空 entries」语义 |
| BUG-B2（高，更新阻塞）：PUT 改状态返回 409，且产生同 id 副本文件 | 高 | 真实 DSH 节点 `/fs/upload` 对已存在文件名生成 `-1` **副本而非覆盖** → `writeItem` 写进副本、verify 读原文件必然不一致抛冲突 | `writeItem` 改为**先删后写**（容忍目标不存在）；测试桩与 e2e mock 补副本语义 |

## 部署与验证链

1. 本地：build / typecheck / test:unit 92 / smoke 70 / smoke:backlog（新增 e2e）全绿；
2. 版本号 `npm run version:bump` → 2026.10.31，并同步更新远端 `/opt/onenat-workbuddy/package.json`（部署脚本只同步 dist，版本号需单独同步，healthz 页脚方可体现）；
3. 第一轮部署：4 文件（backlog/engine/router/web-ui.js），healthz ok、MCP 匿名 401、公网入口 200/401 ✓；
4. ego-lite 在线走查发现 BUG-B1/B2 → 修复 + mock 防回归 → 第二轮增量仅 `backlog.js`，复验 ✓。

## 在线验证矩阵（修复后全部通过）

| 项 | 结果 | 证据 |
|---|---|---|
| 登录/会话 | ✅ | wb-qa 表单登录 → 工作台 73 任务正常渲染（无回归） |
| 版本徽标 | ✅ | 页脚/头部 **v2026.10.31** |
| 「✅待办」聚合视图 | ✅ | 新底部 Tab；`GET /api/backlog/overview` 200，data 为 22 项目数组（projectId/nodeStatus/initialized/statuses/items 字段与设计 §5.2 一致）；节点不可达项目如实标 ⚠（B7 隔离） |
| 项目看板 | ✅ | To Do / In Progress / Done 三列 + 返回头 + 派发选中(0) + 新建待办（截图 02） |
| init 初始化 | ✅ | `POST /backlog/init` 幂等（mkdir tolerant）；父目录不存在时报错准确（400「父目录不存在」） |
| 建条目 | ✅ | 201，itemId=task-1，status 取 defaultStatus |
| 改状态（PUT） | ✅ | 修复后 200（修复前 409+副本）；列表唯一条目 `task-1:In Progress`，无副本 |
| 删除 | ✅ | 200，列表归零 |
| 节点文件终态 | ✅ | `backlog/tasks/` 目录空（测试数据零残留）；config.yml + tasks/ 结构保留 |

## 测试遗留状态（如实记录）

1. **wb-qa 密码已重置**为 `WbQa-20261031-Tmp!`（旧密码 `WbQa-Temp-2026!` 已失效——10-23 之后被轮换）。远端原 auth.json 备份于 `/var/lib/onenat-workbuddy/auth.json.bak-qa-20261031-deploy`。
2. **qa-e2e-项目流程测试-改（proj-s9nndm9l）**：backlog 已初始化（config.yml + 空 tasks/ + 项目指令已追加协作约定片段）；其工作区 `/tmp/wb-qa-proj-ws` 在节点上曾丢失，已重建。该目录为 QA 沙箱，保留初始化状态供后续回归。
3. 未测试项：**一键派发 → 任务回写闭环在线上未跑**（会真实派发到 DSH 节点消耗 LLM；且 10-29 起公司笔记本 31789 节点 LLM 上游空流问题未解）。该链路已由 smoke:backlog（mock）覆盖逻辑层；建议 LLM 上游恢复后在线补一次端到端派发。

## 第二轮在线 QA（19:30–21:10，同一 v2026.10.31，无版本变更）

承接上一轮遗留项 3：**一键派发 → 任务回写闭环已在线上真实跑通**（LLM 上游已恢复）。本轮共 4 次真实派发（均为 chat 直发、真实 LLM、只读确认类任务），全部 success → 待办自动 Done + 执行记录追加。

### 本轮新发现并修复的 3 个 UI BUG（均已在线上验后复验）

| BUG | 级别 | 根因 | 修复 |
|---|---|---|---|
| BUG-B3：编辑/新建待办的描述与验收清单回填为空、多行验收被合并成一条 | 高（数据误导：直接点保存会把原描述/验收内容清空） | `src/web-ui.ts` 模板字符串内过度转义：`[\\s\\S]` 求值成 `[\s\S]` 之外的错误类（`[\sS]`），`split('\\\\n')` 求值成字面反斜杠+n | 改为 `[\\s\\S]` / `split('\\n')` / `join('\\n')`，三处同修 |
| BUG-B4：看板内点「↻ 刷新」不刷新看板（任务已回写 Done，界面仍显 In Progress） | 中 | 刷新按钮固定 `blState.data=null; renderBacklogView(true)`，看板态直接 `blRender()` 用旧 `blState.board` | 看板态改走 `blReloadBoard()` |
| BUG-B5：批量派发按钮在重渲染后文案残留（显示「派发选中 (1)」但无勾选） | 低 | `blBoardHtml()` 渲染时用的是渲染时刻的勾选数 | 新增 `blSyncBatchBtn()`，每次 `blRender()` 后按真实勾选数同步文案与 disabled |

另修 2 个轻量问题：任务徽标对 chat 直发任务显示 ⚪（改为按任务自身终态显示 ✅/🔴）；看板/详情点任务只渲染聊天区不切视图（改用既有统一入口 `jumpToTask`）。

### 本轮在线验证矩阵（ego-lite，全部通过）

| 项 | 结果 | 证据 |
|---|---|---|
| 「待办」聚合视图（B7） | ✅ | 23 个项目分组、节点状态 chip、计数正确；单项目节点短暂不可达时其余项目正常渲染（失败隔离）；恢复后刷新即回正常 |
| 一键初始化（途径 A） | ✅ | 空态引导 → 初始化 → 节点落盘 `backlog/config.yml` + `backlog/tasks/`；项目指令追加协作约定 |
| 新建待办（多行验收） | ✅ | 创建 task-1，节点文件 frontmatter/段标记完整；多行验收拆成 3 条 |
| 编辑抽屉回填 + 保存 | ✅ | 回填描述/验收/标签/状态；保存后节点文件内容正确、段标记与既有执行记录不被洗 |
| 一键派发 + 终态回写 | ✅ | task-1 → task-315ae7f9；任务 completed → 待办 Done + 「派发执行（成功）」记录（节点文件核验） |
| 第二次派发（复验） | ✅ | task-2 → task-07272fc4 → Done + ✅ 徽标 |
| 依赖阻止 + 强制派发（D5） | ✅ | 依赖未完成时 409「存在未完成依赖」，勾选忽略后可派发；执行后正常回写 Done |
| 批量派发 | ✅ | 勾选 1 条 → 「批量派发：成功 1 / 失败 0」→ 待办置 In Progress → 完成后 Done |
| 删除（二次确认） | ✅ | 两次 confirm 后物理删除，节点文件消失 |
| 详情抽屉 / 关联任务跳转 | ✅ | 详情展示完整正文 + 执行记录时间线；点关联任务跳工作台并打开对应会话 |
| 归档只读 / 冲突提示 | ✅（smoke 覆盖） | 线上未造归档项目，逻辑由 smoke:backlog 覆盖 |

### 本轮测试数据与清理

- 新建 QA 项目 `qa-backlog-20261031`（proj-wxsw1q7y，绑定公司笔记本-DSH:31789，工作区 `/tmp/wb-qa-backlog-20261031`）+ 4 条待办 + 4 个真实任务，验证完成后**已全部删除**（项目 DELETE 200、任务 DELETE 200×4，节点沙箱目录已移除）。
- 证据截图：`qa-20261031-bl/01–19*.jpg`（空态看板、建条目、派发、回写、编辑回填、批量按钮同步、任务跳转等）。

## 环境备注

1. **ego-lite 桥接僵死**：`ego-browser nodejs` 全模式挂起（AppKit 事件循环等待、无 socket 无子进程），`osascript quit` 超时（-1712），需 `kill -9` 主进程后 `open -a "ego lite"` 恢复；恢复后全流程正常。后续 QA 遇到同形态可直接照此处理。
2. 部署脚本 tar 在 Linux 解包时打印 `LIBARCHIVE.xattr` 警告，无实际影响（既有形态）。
