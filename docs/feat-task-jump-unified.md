# 任务跳转统一（jumpToTask）＋ 归档页跳转 bug 修复

## 需求

「同一个任务在不同视图都有入口，但跳转行为各写各的」——`openTask()` 只负责渲染聊天区、**不切视图**，各视图的入口靠自己补 `switchView('work')`：监控弹窗补了、定时任务执行记录补了、⌘K 补了，**归档页没补**（点击已归档会话只调 `openTask(t.id)`，聊天区在后台渲染、页面停留在归档页——真 bug）。

本次建立单一跳转入口 `jumpToTask(taskId)`（`switchView('work')` + `await openTask(taskId)`），并把全部跨视图任务入口收敛过去；后续新增视图里出现任务入口时一律只能调它，杜绝再漏切视图。

## 变更点

仅 `src/web-ui.ts`，四处散点 → 统一入口：

| 入口 | 位置 | 变更 |
| --- | --- | --- |
| 监控大屏「任务详情」弹窗 footer「💬 在工作台打开完整对话」 | `monOpenTask` | `switchView + openTask` → `jumpToTask` |
| 定时任务详情·执行记录·「查看会话 →」 | `renderScheduleDetail` | 同上 |
| 归档管理·已归档会话行点击 | `renderArchiveList` | **bug 修复**：裸 `openTask` → `jumpToTask`（点开即进入工作台对话） |
| ⌘K 命令面板·会话命令 | `cmdkCommands` | 同上 |

工作台侧栏任务项点击保持裸 `openTask`（已在工作视图内，无需切）。

## 验收

1. `npm run build`：tsc 编译通过 + 内联脚本 `node --check` 关卡 3 页全过
2. `npm run typecheck`：通过
3. `npm run smoke`：54 项全过
4. `grep jumpToTask`：定义 1 处（`async function jumpToTask`，紧邻 `openTask`）+ 接线 4 处（监控/定时任务/归档/⌘K），无残留的跨视图裸调 `switchView('work'); openTask(` 组合
5. 手工走查：归档页点会话 → 自动切到工作台并打开该会话（对话可续聊）；监控任务详情弹窗/定时任务执行记录 → 行为不变

## 后续（未做，属「任务详情中心化」下一层）

- 监控大屏任务卡目前先进「任务详情摘要弹窗」再二跳工作台；若要「点卡直达完整对话」，把卡片点击改为 `jumpToTask`、摘要弹窗降级为卡片上的 ℹ️ 按钮（待走查确认用户习惯后再动）
- 任务详情「一屏看全」（对话+轨迹+子任务日志+文件聚合覆盖层）为独立立项
