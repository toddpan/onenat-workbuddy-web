---
id: task-18
title: '[文档] docs/qa-online-collect-20261101.md: ## 3. 线上部署（上传完成、激活待定）'
status: Done
assignee:
created_date: '2026-11-01T10:01:48Z'
updated_date: '2026-11-01T10:36:25Z'
labels:
  - auto-collect
  - source-doc
  - doc-status
dependencies:
ordinal: 18000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
<!-- wb:source=doc:595113f1d5bea45d -->
由「未完成事项采集（工作区扫描）」自动登记：

- 文件：docs/qa-online-collect-20261101.md（第 24 行）
- 命中标记：## 3. 线上部署（上传完成、激活待定）
- 文件修改时间：2026-11-01 07:53 UTC
- 定位：项目工作区 → 右侧栏文件树 → `docs/qa-online-collect-20261101.md`
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 确认该未勾选项/待确认内容是否仍需跟进
- [ ] #2 处理后同步勾选或更新文档
<!-- AC:END -->

### 2026-11-01T10:35:30Z 派发为任务
task-f721fe6d · mode=orchestrate · 成员=2

### 2026-11-01T10:36:25Z 派发执行（成功）
任务 task-f721fe6d · 结果=成功
这份待办来自 qa 报告第 24 行的标题「## 3. 线上部署（上传完成、激活待定）」。文档开头结论已写明：宿主 15:44 重启后 systemd 已用新 dist 自动拉起并完成线上复验（§4.1），即「激活待定」实际已完成，只是第 3 节标题没同步。先核实线上当前状态，再更新文档。线上核实：`healthz` 正常、版本 `2026.11.1`、已运行约 1 小时（说明 15:44 重启后由 systemd 以新 dist 拉起，激活完成）。首页 HTML 未登录时返回登录页，grep 到 0 是文档 §4.1 已记录过的已知误判，非异常。

结论：该待办「激活待定」已实际完成，仅需同步文档标题。backlog task-18 已处理完毕，两项验收均完成：

**#1 是否仍需跟进 —— 无需跟进，遗留项早已闭环**
- 待办命中的标记是文档 [docs/qa-online-collect-20261101.md:24](docs/qa-online-collect-20261101.md#L24) 的旧标题「上传完成、**激活待定**」，但同文档开头结论与 §4.1 已写明：
