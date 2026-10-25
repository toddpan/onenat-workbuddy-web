# Token 统计修复说明（v2 · 2026-10-25）

## 问题描述

监控大屏（应用内 `#monitor` tab 与 `/monitor` 投屏页）的「今日 Token」与趋势图统计不准确：

1. **趋势图跨日重复累计（主因，线上实锤）**：2026-10-18 快照记录单日输入 18,477,600、10-19 记录 10,715,480，而当天真实逐轮消耗远小于此。
2. **今日 KPI 混入昨日回合**：过夜任务昨晚开始的回合 token 被计入今天（2026-10-25 实测多计 1,026 输入 / 127,552 缓存读）。
3. **监控大屏与消耗报表（UsageService）数字对不上**：两处口径不同。

## 根本原因

v1 修复（2026-10-18 上线）把统计改成**任务级口径**：任务「今天有活动」（`isRunning || updatedAt >= 今日零点`）就把**该任务全部回合**的 token 计入今天。

```typescript
// ❌ v1：任务级口径
const taskActiveToday = isRunning || (t.updatedAt >= dayStart.getTime())
if (taskActiveToday) {
  for (const turn of t.turns || []) { tokensIn += usageOf(turn.usage).input; ... }
}
```

长生命周期任务（跨多天的项目会话/编排任务）只要当天有任何更新，其**全部历史回合**都会被重复计入当天——同一批 token 在每个活跃日被反复累计，造成趋势图单日千万级虚高。今天发一条消息的多日旧任务同理。

更早的 v0（`turn.at >= dayStart` 按回合开始时刻过滤）则遗漏跨日回合（昨晚开始、今晨完成的回合），方向相反但量级小。

## 修复方案（v2）：按【回合】归属，收束单一口径

**归属时刻 = `turn.endedAt`（回合收尾时刻）优先，回退 `turn.at`（回合开始时刻）**：

- 跨日回合（昨晚开始、今晨收尾）归**完成日**——`endedAt` 在收尾时打点；
- 历史数据无 `endedAt` 回退 `at`，监控大屏与消耗报表（UsageService）用同一口径，两边数字一致；
- 多日长任务只计当天回合，历史回合不再重复累计。

### 修改位置

| 文件 | 改动 |
|---|---|
| `src/token-stats.ts`（新增） | 单一事实源：`usageOf`（账本求和，兼容 inputTokens/prompt_tokens 等命名，cacheRead 单列、totalTokens/modelRequestCount 等杂项不计入）、`turnUsageAt`、`sumUsageSince` |
| `src/types.ts` | `TaskTurn` 增加 `endedAt?: number` |
| `src/engine.ts` | 全部 8 处回合收尾点（主收尾/ask 挂起两种收尾/续跑中止与对账/规划收敛/重启自愈/任务取消）打点 `tt.endedAt = Date.now()` |
| `src/monitor.ts` | `computeSnapshot()`（趋势快照）与 `buildOverview()`（实时 KPI）两处任务级口径改为 `sumUsageSince(tasks, dayStart)` 逐轮口径；本地 `usageOf` 副本删除 |
| `src/usage.ts` | `collectRecords()` 归属时刻改用 `turnUsageAt`；本地 `usageOf` 副本删除 |

### 单测（src/token-stats.test.ts）

覆盖：字段命名兼容与杂项排除、endedAt 优先级、跨日回合（新数据计入今日 / 旧数据回退不计）、**多日长任务只计今日回合（10-18/19 虚高根因回归）**、纯历史任务、今日任务含工具数。`npm run test:unit` 72/72 绿。

## 线上验证（2026-10-25，v2026.10.25 已部署 natpass 入口）

服务器 store.json 地面真值（2026-10-25 11:01 CST）：

| 口径 | 输入 | 输出 | 缓存读 | 工具 |
|---|---|---|---|---|
| 旧（任务级，修复前 KPI） | 1,310,206 | 18,027 | 1,395,200 | 110 |
| 新（逐轮，修复后 KPI） | **1,309,180** | **15,497** | **1,267,648** | **79** |
| 逐轮真值（独立脚本核算） | 1,309,180 | 15,497 | 1,267,648 | — |

ego-browser 在线验收（natpass.yikaihui.com）：应用内 `#monitor` tab 与 `/monitor` 投屏页均显示「今日 Token 132.5k · 输入 130.9k · 缓存命中 126.8k · 工具 79」，与逐轮真值一致；当日新快照已按新口径落盘（1,309,180）。

## 已知边界

- **历史快照不回填**：趋势图里 10-18/19 等旧日的千万级虚高是当时口径下的冻结记录，无法精确重算（相关任务已被自动归档骨架化，turns 移入 `data/archive/`，但归属时刻信息已不可复原）。自 2026-10-25 起新快照均为新口径。
- 归档任务的 turns 不在 store 内存中，监控与消耗报表对「归档日之前」的历史汇总都同样不可见（两侧一致，非本次问题）。
- 流式中的回合在收尾前无 `endedAt`，按 `at`（开始时刻）临时归属；收尾打点后按完成日归属。
