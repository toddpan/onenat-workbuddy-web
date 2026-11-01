---
id: task-19
title: '[代码] scripts/smoke-standalone.mjs: TASK-8：待办聚合总览分组头「进入工作台」入口（静态渲染 + 跳转/回退/移动端热区实现都在控制台 HTML 内联 …'
status: Done
assignee:
created_date: '2026-11-01T10:01:48Z'
updated_date: '2026-11-01T10:36:29Z'
labels:
  - auto-collect
  - source-code
  - todo
dependencies:
ordinal: 19000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
<!-- wb:source=code:f41e44b357bf550c -->
由「未完成事项采集（工作区扫描）」自动登记：

- 文件：scripts/smoke-standalone.mjs（第 168 行）
- 命中标记：TASK-8：待办聚合总览分组头「进入工作台」入口（静态渲染 + 跳转/回退/移动端热区实现都在控制台 HTML 内联 JS/CSS 里）
- 文件修改时间：2026-11-01 06:07 UTC
- 定位：项目工作区 → 右侧栏文件树 → `scripts/smoke-standalone.mjs`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 确认该处 TODO/FIXME 是否仍需处理（保留 / 删除标记 / 转成正式待办）
- [ ] #2 处理后同步删除或更新代码中的标记
<!-- AC:END -->

### 2026-11-01T10:35:31Z 派发为任务
task-f3d50cce · mode=orchestrate · 成员=2

### 2026-11-01T10:36:29Z 派发执行（成功）
任务 task-f3d50cce · 结果=成功
TASK-8 功能已实现且浏览器验收报告显示 4/4 通过（见 `docs/qa-backlog-entry-20261101.md`）。`smoke-standalone.mjs` 第 168 行的注释只是测试区块的章节标注，并非待处理的 TODO，但它包含 "TASK-8" 关键字，导致待办事项扫描器重复生成此待办事项。我会重写该注释，改为描述性标签，同时保留断言，然后重新运行冒烟测试以进行确认。任务完成（task-19 处理结果）：

**核查结论**
- 该处并非未完成的 TODO/FIXME，而是 smoke 脚本里的测试区块章节注释。对应功能（待办分组头「进入工作台」入口：静态渲染、`enterProjectWorkspace` 跳转 + `history.pushState` 回退路由、移动端 44px 热区）已在 [src/web-ui.ts:2246](src/web-ui.ts:2246) / [src/web-ui.ts:4484](src/web-ui.ts:4484) 实现，并有浏览器端验收报告 4/4 PASS（[docs/qa-backlog-entry-
