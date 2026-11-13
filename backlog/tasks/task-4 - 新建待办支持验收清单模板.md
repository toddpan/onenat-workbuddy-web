---
id: TASK-4
title: "新建待办支持验收清单模板（DoD 模板）"
status: Done
assignee:
created_date: '2026-11-01T00:00:00Z'
updated_date: '2026-11-01T11:07:53Z'
labels:
  - "backlog"
  - "ui"
dependencies:
priority: "low"
ordinal: 4000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
文档 §11.2 的后置项「DoD 模板」轻量版：新建待办抽屉里提供可选模板，一键填充 Acceptance Criteria 骨架，降低手写门槛，同时让 agent/用户产出的条目格式更一致（验收项统一 `- [ ] #n <文本>`，可被 countAcceptance 正确计数）。

候选模板（首批）：
- 通用：功能可用 / 边界与错误路径 / 构建与 smoke 通过
- 缺陷修复：复现步骤确认 / 根因说明 / 修复验证 / 回归检查
- 文档：内容准确 / 链接与示例可运行 / 表述清晰无歧义

实现约束：
- 模板只是「填充草稿」，用户可自由增删；不选模板时不填充，保持原行为；
- 模板文本放前端常量或单独数据文件，不要硬编码进多个渲染分支；
- 保持 ≤768px 与微信 X5 兼容（不引入新依赖）。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [ ] #1 新建待办抽屉可选模板并一键填充验收清单
- [ ] #2 不选模板时新建流程行为与现在完全一致
- [ ] #3 用模板创建的条目能被 listBacklog 解析，acceptance 计数与实际条数一致
- [ ] #4 npm run build 与 npm run smoke 通过
<!-- AC:END -->

### 2026-11-01T11:05:30Z 派发为任务
task-bbd39858 · mode=orchestrate · 成员=2

### 2026-11-01T11:07:53Z 派发执行（成功）
任务 task-bbd39858 · 结果=成功
完成。TASK-4（DoD 验收清单模板，轻量版）已实现并通过构建与冒烟验证。

## 改动内容（仅 [src/web-ui.ts](src/web-ui.ts)）

1. **模板常量 `BL_DOD_TEMPLATES`**（[web-ui.ts:15245](src/web-ui.ts#L15245) 附近）：三套首批模板集中定义，单一数据源，未散落进渲染分支——
   - 通用（功能）：功能可用 / 边界与错误路径已覆盖 / 构建与 smoke 通过
   - 缺陷修复：复现步骤确认 / 根因说明 / 修复验证 / 回归检查
   - 文档：内容准确 / 链接与示例可运行 / 表述清晰无歧义
2. **新建抽屉专属 UI**：`blOpenEditor(null)` 时在验收清单上方渲染「验收模板（DoD，可选）」下拉；编辑已有待办（`itemId` 存在）完全不渲染该控件。
3. **一键填充逻辑**：选择模板后填入 `- [ ] #n <文本>` 可正确计数的条目草稿（纯文本行，服务端 [backlog.ts:479](src/backlog.ts#L479) 自动写成 `
