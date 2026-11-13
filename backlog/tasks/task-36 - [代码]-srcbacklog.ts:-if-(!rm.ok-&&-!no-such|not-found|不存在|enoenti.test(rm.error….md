---
id: task-36
title: '[代码] src/backlog.ts: if (!rm.ok && !/no such|not found|不存在|enoent/i.test(rm.error…'
status: Done
assignee:
created_date: '2026-11-01T10:01:48Z'
updated_date: '2026-11-01T11:07:05Z'
labels:
  - auto-collect
  - source-code
  - todo
dependencies:
ordinal: 36000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
<!-- wb:source=code:b96bf68ce6577e90 -->
由「未完成事项采集（工作区扫描）」自动登记：

- 文件：src/backlog.ts（第 413 行）
- 命中标记：if (!rm.ok && !/no such|not found|不存在|enoent/i.test(rm.error || '')) throw new Error(rm.error || '待办清理失败')
- 文件修改时间：2026-11-01 06:04 UTC
- 定位：项目工作区 → 右侧栏文件树 → `src/backlog.ts`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 确认该处 TODO/FIXME 是否仍需处理（保留 / 删除标记 / 转成正式待办）
- [ ] #2 处理后同步删除或更新代码中的标记
<!-- AC:END -->

### 2026-11-01T11:05:25Z 派发为任务
task-a9c0a541 · mode=orchestrate · 成员=2

### 2026-11-01T11:07:05Z 派发执行（成功）
任务 task-a9c0a541 · 结果=成功
代码检查已完成——现在我来验证 `collector` 的当前行为是否会将此行标记为误报，通过运行 `unit tests` 来确认：## 结论：task-36 为误报残留，无需改代码，可直接关闭该待办

**核查过程**

1. **查看命中行** [src/backlog.ts:413](src/backlog.ts#L413)：这是 `writeItem` 里「先删后写」兜底逻辑的错误处理行——`if (!rm.ok && !/no such|not found|不存在|enoent/i.test(...)) throw ...`。它不是 TODO/FIXME 标记，是**有注释支撑的正式实现**（上方 L408-410 注释解释了为何必须先删后写：DSH `/fs/upload` 对同名文件生成副本而非覆盖）。

2. **定位误报根因**：采集器的中文标记正则 `CODE_MARKER_CN_RE = /待办|待补充|未完成/` 命中了这行里的字符串「待办清理失败」。而 [backlog-collect.ts:99-102](src/backlog-collect.ts#L9
