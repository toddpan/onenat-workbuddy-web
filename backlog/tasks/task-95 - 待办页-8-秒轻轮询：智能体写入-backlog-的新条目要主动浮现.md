---
id: task-95
title: 待办页 8 秒轻轮询：智能体写入 backlog 的新条目要主动浮现
status: Done
assignee:
created_date: '2026-11-12T01:54:24Z'
updated_date: '2026-11-12T02:20:32Z'
labels:
  - backlog
  - ui
  - reliability
dependencies:
priority: P2
ordinal: 95000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
现象：待办页（renderBacklogView）只在进入页面或手动点「↻ 刷新」时拉一次 /backlog/overview，之后完全静止。智能体在项目 backlog/ 目录里新写或改动的条目不会自己出现，人看到的永远是进页那一刻的快照——「人与智能体共编辑一块板子」这个前提在观感上不成立。

已侦察确认的锚点：blOverviewUrl() 与 renderBacklogView() 的一次性拉取路径；blState.data 为已加载聚合结果，cmdkBl 已有 30s TTL 缓存可参考。服务端 /backlog/overview 已返回每项目 open/done/ready/blocked 与 updatedAt，可作为廉价探针。

方案：进入待办页后挂 8 秒轻轮询，只取 overview 的 counts + updatedAt 等轻量字段做比对，命中变化才全量重拉，避免每次都传大对象刷屏；新增条目插入时闪一次 --pri-light 背景过渡（CSS transition 约 600ms）提示新增；页面切走（switchView 非 backlog）或 document.hidden 时暂停，回来自动恢复；连续失败 3 次后指数退避（8s → 16s → 32s，上限 60s）并在页头给一行轻量降级提示，不弹错误弹窗。

范围约束：不改服务端接口；不复用群聊那条 SSE（群频道的实时通道只服务群内消息）；看板视图（blState.board）与聚合视图共用同一套刷新节流，但看板视图保持现有「操作后按需重载」语义，不做轮询。

注意：这一项要碰 blState 的刷新时序，必须保证勾选态（blState.picked）、筛选条件、搜索框焦点与滚动位置在自动刷新后不丢——refs 见 blRender() 里已有的勾选回填与焦点还原逻辑。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 进入待办页后无需手动刷新，智能体写入的新条目在 8 秒内自动出现
- [ ] #2 无变化时轮询只取轻量 counts/updatedAt，不重复传输完整条目列表
- [ ] #3 新增条目出现时有可见的高亮过渡提示，不打断当前滚动位置与勾选态
- [ ] #4 切到其他页签或浏览器标签页隐藏时轮询自动暂停，返回后恢复
- [ ] #5 轮询连续失败时指数退避并在页头显示降级提示，不弹错误弹窗
- [ ] #6 看板视图不引入轮询，仍保持操作后按需重载
- [ ] #7 经 build-standalone.sh 与 npm run smoke 验证通过（含内联脚本语法关卡）
<!-- AC:END -->

### 2026-11-12T02:03:02Z 派发为任务
task-634ed873 · mode=chat · 成员=0

### 2026-11-12T02:20:32Z 派发执行（成功）
任务 task-634ed873 · 结果=成功
我会先核对待办页的加载逻辑和 overview 现有参数，再实现轻轮询、状态保留与失败退避，最后运行构建和 smoke 验证。
源码里有一处与侦察描述不同：overview 已支持 `count=1`，但没有返回项目 `updatedAt`。只比较计数会漏掉标题、正文等修改。我会在现有接口范围内，用计数、分面统计和按更新时间取的最新一条记录做轻量探针；无变化时不拉完整列表。同时会加请求过期校验，防止旧响应覆盖新的筛选或看板状态。
轮询和自动刷新路径已接入，正在检查切页、筛选与响应返回之间的竞态。首轮构建遇到工作区另一处正在编辑的 MCP 文件类型错误；我会保留那部分改动，完成待办回归测试后再重跑构建。另一个需要保留的行为是项目失败隔离：单个节点不可达时，其他项目仍应能更新。
构建和 smoke 已通过。回归测试还会核对“完整结果”和“只取最新一条的探针”能否生成一致签名，避免无变化时反复全量刷新；也会验证过期响应不会覆盖筛选、自动刷新保留光标和勾选态，以及连续失败后的退避恢复。
最终构建的三页内联脚本语法检查和 smoke 94 项均已通过。针对性测试正在收尾，已覆盖无变化不全拉、切页
