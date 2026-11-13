---
id: task-98
title: '[bug] 编辑定时任务修改触发时间模式后无法保存'
status: Done
assignee:
created_date: '2026-11-12T11:32:07Z'
updated_date: '2026-11-12T15:18:26Z'
labels:
  - bug
  - ui
dependencies:
priority: High
ordinal: 98000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
控制台定时任务管理：编辑已有定时任务时，修改触发时间模式（rule.kind，如 daily→weekly、daily→interval、daily→once 等）后点保存，修改不生效/无法保存。需定位是前端表单未把 rule.kind 的切换与新字段（times/days/minute/minutes/at）收集提交，还是服务端 upsert 校验拒绝（前端提交结构与 workbuddy_schedule_manage rule 契约不一致）。修复后要求任意合法 kind 之间互切都能正常保存并在列表/详情正确回显，历史数据兼容。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 修改触发模式（如 daily→weekly）后保存成功，刷新页面后新模式正确回显
- [x] #2 daily/weekly/hourly/monthly/interval/once 各 kind 互切保存均正常，切换时对应字段正确收集与校验
- [x] #3 同次编辑中修改名称/message/成员等其他字段不受影响，可一并保存
- [x] #4 npm run typecheck 与 npm run smoke（含 schedule 相关用例）通过
<!-- AC:END -->

### 2026-11-12T15:15:20Z 派发为任务
task-25dd892f · mode=chat · 成员=0

### 2026-11-12T15:18:26Z 派发执行（成功）
任务 task-25dd892f · 结果=成功
Found it. The bug is in the frontend `web-ui.ts`. Server-side `normalizeRule` handles all kinds correctly; the problem is at line 14695:烟雾测试已通过（共 94 项）。现在进行端到端完整性检查：启动服务端，对规则类型切换进行 API 往返测试（服务端契约验证），并确认修复后的前端代码已正常提供：修复完成，task-98 已关闭。

## 根因

问题在前端 `src/web-ui.ts`，不在服务端。编辑抽屉里切换触发模式（`#sc-kind`）的 change 监听写的是：

```js
kindSel.addEventListener('change', () => { s = { rule: lastRule || (s && s.rule) }; renderRuleBox(); });
```

它把整个 `s` **覆盖成了只含 `rule` 的对象**，丢掉了 `id`（以及 nodeMappingId/model/skills 等全部既
