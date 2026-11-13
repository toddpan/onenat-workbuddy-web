---
id: task-31
title: '[代码] scripts/backlog-e2e.mjs: 2. 新建待办（依赖 task-1）→ 编辑 → 详情正文与段标记保留'
status: Done
assignee:
created_date: '2026-11-01T10:01:48Z'
updated_date: '2026-11-01T11:06:22Z'
labels:
  - auto-collect
  - source-code
  - todo
dependencies:
ordinal: 31000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
<!-- wb:source=code:9f2b3e6eebd7bbf4 -->
由「未完成事项采集（工作区扫描）」自动登记：

- 文件：scripts/backlog-e2e.mjs（第 8 行）
- 命中标记：2. 新建待办（依赖 task-1）→ 编辑 → 详情正文与段标记保留
- 文件修改时间：2026-11-01 06:07 UTC
- 定位：项目工作区 → 右侧栏文件树 → `scripts/backlog-e2e.mjs`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 确认该处 TODO/FIXME 是否仍需处理（保留 / 删除标记 / 转成正式待办）
- [ ] #2 处理后同步删除或更新代码中的标记
<!-- AC:END -->

### 2026-11-01T11:05:23Z 派发为任务
task-fe3512ed · mode=orchestrate · 成员=2

### 2026-11-01T11:06:22Z 派发执行（成功）
任务 task-fe3512ed · 结果=成功
我检查了 task-31 对应的 `scripts/backlog-e2e.mjs:8` 标记，结论如下：

## 核查结论：保留（非 TODO/FIXME，是场景文档注释）

**该行不是待处理的技术债标记**，而是脚本头部注释里对 E2E 场景 2 的一句话说明：

- 第 8 行：`2. 新建待办（依赖 task-1）→ 编辑 → 详情正文与段标记保留` —— 描述的是脚本将要验证的场景
- 对应实现在 `scripts/backlog-e2e.mjs:277-287`（“// 2. 新建（依赖 sample）→ 编辑 → 详情” 段落）：
  - 新建待办并挂依赖（`dependencies: [sampleId]`，即 init 生成的示例待办 task-1）✅
  - 编辑（`PUT ... /items/{id}` 改 priority/labels）✅
  - 详情断言（第 287 行）：`priority: high` frontmatter 生效 + `AC:BEGIN` 段标记保留 + 描述正文不被清洗 ✅

**注释与实现逐项对齐，且行为已全部有断言覆盖**，无
