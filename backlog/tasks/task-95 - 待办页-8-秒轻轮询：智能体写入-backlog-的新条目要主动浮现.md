---
id: task-95
title: 待办页 8 秒轻轮询：智能体写入 backlog 的新条目要主动浮现
status: To Do
assignee:
created_date: '2026-11-12T01:54:24Z'
updated_date: '2026-11-12T01:54:24Z'
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
