# 历史任务自动归档（设置页可配）

## 需求

历史任务记录自动归档：终态任务超过指定天数（默认 7 天）未更新即自动归档；归档天数不依赖环境变量，直接在控制台「设置」页配置。

## 背景与方案

此前"归档"在代码里是两套互不相通的机制：

| 机制 | 触发 | 效果 | 配置入口 |
| --- | --- | --- | --- |
| 手动列表归档 | 前端 🗄️ 按钮（`POST /api/tasks/:id/archive`） | 打 `archivedAt`，任务挪入「已归档会话」分组，数据不动 | 无（纯手动） |
| 冷归档瘦身 | `WorkStore.archiveSweep()`（启动 30s + 每 30 分钟） | 超期终态任务的 turns/taskLogs 移入 `data/archive/<id>.json`，store.json 只留骨架 | 仅环境变量 `WORKBUDDY_ARCHIVE_DAYS`（默认 7） |

本次将两者统一为一条「自动归档」链路，天数由设置页统一管理：

- **超期判定**：终态（completed/failed/partial_success/success/cancelled）且 `updatedAt` 超过配置天数
- **自动列表归档**：打 `archivedAt` → 前端挪入「已归档会话」分组（用户可感知，与手动按钮同语义；点开仍可查看与继续对话）
- **存储瘦身**：沿用原冷归档（先写归档文件、再打 `bulkArchived` 标记的崩溃安全顺序）
- 无 turns/taskLogs 可瘦身的超期终态任务只做列表归档；运行中任务永不归档

## 变更点

### `src/types.ts`

`WorkBuddySettings` 新增：

```ts
archive?: {
  /** 终态任务超过该天数未更新，自动挪入「已归档会话」并瘦身存储；0 = 关闭自动归档 */
  taskArchiveDays?: number
}
```

### `src/store.ts`

- 移除静态 `ARCHIVE_AFTER_MS`（环境变量在类初始化时一次性读取、不可变），改为 `archiveDays()` 实时读取：设置值优先 → 缺省回退环境变量 `WORKBUDDY_ARCHIVE_DAYS` → 再回退 7；`0` = 关闭（sweep 直接返回）
- `archiveSweep()` 在原骨架化之外，对超期终态任务补打 `archivedAt`（幂等：已归档的跳过）
- **顺带修复既有竞态**（见 docs/review-architecture-store-plan.md R-A1）：骨架化写盘的 await 窗口内若该任务被 mutation（此时 `bulkArchived` 未设、`touchTask` 感知不到），增量会随全量落盘、随后却被骨架化标记，重启重水合会用**旧**归档文件覆盖增量 → 丢数据且无告警。现记录写盘前的 `updatedAt`，写盘成功后比对，窗口内有变更则本轮放弃（列表归档也不打）、下轮重试
- `defaultSettings()` / `load()`：archive 配置参与默认合并与持久化（环境变量仅作首启动默认值，此后设置页为唯一权威）
- `updateSettings()` 支持 `archive` 段合并

### `src/router.ts`

- `POST /api/settings` 透传 `archive` 并校验：`taskArchiveDays` 需为 0–36500 整数，非法返回 400
- 保存归档配置后 fire-and-forget 触发一次 `archiveSweep()`：天数收窄立即归档超期任务（不必等下一轮 30 分钟扫描）

### `src/web-ui.ts`

设置页新增「任务归档」卡片（`自动归档天数（0 = 关闭）` 输入框 + 说明文案），`renderSettings()` 回填、保存随 payload 提交；保存成功后刷新会话列表（服务端 sweep 可能刚归档了超期任务）。

## 行为细节

- **取消归档宽限**：前端「取消归档」走 `mutateTask` → `updatedAt` 刷新为当前时间 → 天然获得一个完整周期（配置天数）的宽限，不会被下一轮扫描立刻归档回去
- **自动归档不可批量撤销**：调大天数 / 置 0 只停止后续自动归档，已自动归档的任务需逐个「取消归档」（与手动归档一致）
- **升级兼容**：旧 store.json 无 archive 字段 → 首启动用环境变量 `WORKBUDDY_ARCHIVE_DAYS`（无则 7）作为默认并持久化；此后设置页修改即覆盖

## 验证

- `npm run typecheck` 通过
- `npm run test:unit` 41 项全过，其中新增 `src/store.test.ts` 6 项：超期终态任务归档 + 骨架化 + 归档文件 + 重水合、运行中/未超期不动、天数 0 关闭、天数调整即时生效、取消归档宽限、环境变量回退
- `npm run build` + `npm run smoke` 51 项全过
- 已知未覆盖：写盘 await 窗口竞态防护依赖真实异步时序，未做确定性单测（逻辑为 updatedAt 前后比对，见上）
