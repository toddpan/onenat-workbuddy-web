---
id: task-52
title: 待办项目列表排序：有未完成待办的项目排前面、活动项目排最上
status: Done
assignee:
created_date: '2026-11-01T12:11:28Z'
updated_date: '2026-11-01T12:16:27Z'
labels:
  - 体验
  - backlog
dependencies:
priority: Medium
ordinal: 52000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
待办（backlog）项目列表当前没有排序规则，添加排序：1) 活动项目（最近有任务/待办活动，如 7 天内有更新）排最上面；2) 其余项目按未完成（open）待办数量降序排，有未完成待办的项目排在无待办项目上面；3) 数量相同时按最近活动时间倒序。服务端 overview 的 projects[] 按该规则排序返回，前端列表同步生效。验收：活动项目在最上、有 open 待办的项目次之且按数量降序、无待办项目垫底、同组内按最近活动倒序。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 活动项目（近期有任务/待办活动）排最上
- [ ] #2 有未完成待办的项目按 open 数量降序排在前面
- [ ] #3 无待办项目垫底，同组内按最近活动时间倒序
<!-- AC:END -->

### 2026-11-01T12:12:30Z 派发为任务
task-885ca37f · mode=orchestrate · 成员=2

### 2026-11-01T12:16:27Z 派发执行（成功）
任务 task-885ca37f · 结果=成功
我已经了解情况了。我来检查一下现有的测试文件，看看其中的模式。现在我来实现 `backlog-service.ts` 中的排序逻辑：前端会按照服务器顺序渲染 `groups`，因此它会自动继承排序。现在我来添加单元测试：测试夹具 bug —— 我的 `pr()` 辅助函数遗漏了 `updatedAt`：我测试文件中的一个用例通过了；`backlog.test.ts` 中有一个报错。让我检查一下这是否是之前就存在的：`backlog.test.ts` 的失败源自工作树中不相关的、未提交的 TASK-SORT-2 更改（`src/backlog.ts` 排序重构）——并非由我的编辑引起。让我来验证我的范围，然后进行构建 + 冒烟测试：完成。task-52「待办项目列表排序」已实现并通过验证。

## 改动内容

**[src/backlog-service.ts](src/backlog-service.ts#L233-L268)**（服务端，HTTP `/api/backlog/overview` 与工具通道 `projects`/`overview` 共用同一实现，一处排序三处生效）：
