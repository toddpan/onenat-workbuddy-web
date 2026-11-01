---
id: task-20
title: '[代码] scripts/smoke-standalone.mjs: check(''待办分组头含「进入工作台」按钮且在「看板」之前'', blEnterIdx > 0 && blBoardId…'
status: Done
assignee:
created_date: '2026-11-01T10:01:48Z'
updated_date: '2026-11-01T10:44:33Z'
labels:
  - auto-collect
  - source-code
  - todo
dependencies:
ordinal: 20000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
<!-- wb:source=code:3208be595d6c5d46 -->
由「未完成事项采集（工作区扫描）」自动登记：

- 文件：scripts/smoke-standalone.mjs（第 171 行）
- 命中标记：check('待办分组头含「进入工作台」按钮且在「看板」之前', blEnterIdx > 0 && blBoardIdx > blEnterIdx, `enter=${blEnterIdx} board=${blBoardIdx}`)
- 文件修改时间：2026-11-01 06:07 UTC
- 定位：项目工作区 → 右侧栏文件树 → `scripts/smoke-standalone.mjs`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 确认该处 TODO/FIXME 是否仍需处理（保留 / 删除标记 / 转成正式待办）
- [ ] #2 处理后同步删除或更新代码中的标记
<!-- AC:END -->

### 2026-11-01T10:44:05Z 派发为任务
task-944da35b · mode=orchestrate · 成员=2

### 2026-11-01T10:44:33Z 派发执行（成功）
任务 task-944da35b · 结果=成功
task-20 已核验完毕，结论：**误报，无需处理，保留原样**。

## 核验结论

**验收 #1 — 该处是否仍需处理：不需要。**

- 待办采集器命中的 `scripts/smoke-standalone.mjs` 第 171 行，实际是一条**冒烟测试回归断言**（`check('待办分组头含「进入工作台」按钮且在「看板」之前', …)`），并非 TODO/FIXME 标记——全文件 `grep TODO|FIXME` 零匹配。
- 该断言守卫的是「待办分组头『进入工作台』入口」功能，对应实现位于 [src/web-ui.ts:14884](src/web-ui.ts#L14884)（按钮渲染）及 CSS 热区规则（L2246-2252），功能已实现且断言与源码一致。
- 实测验证：`npm run smoke` 全量通过（**83/83**），包含这条断言在内的「进入工作台」三条回归检查均为 ✅。

**验收 #2 — 标记同步：无需改动。** 代码中不存在待删除/更新的标记；采集器是将 `check('…')` 测试断言文本误识别为未完成事项（这类 smoke 断言含
