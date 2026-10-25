/**
 * onenat-workbuddy-web - Token 统计口径（单一事实源）
 *
 * 「今日/区间 Token」一律按【回合】归属，不按任务归属：
 *   - 归属时刻 = turn.endedAt（回合收尾时刻）优先，回退 turn.at（回合开始时刻）。
 *     跨日回合（昨晚开始、今晨收尾）归完成日；历史数据无 endedAt 时回退开始时刻。
 *   - 曾用的任务级口径（任务 updatedAt 在今天 → 全部回合计入今天）会把长生命周期任务
 *     的历史消耗在每个活跃日重复累计（2026-10-18/19 监控屏单日 1800 万+/1000 万+ 虚高的根因），
 *     已废弃。监控大屏（MonitorService）与消耗报表（UsageService）共用本口径，两边数字一致。
 */

import type { TaskTurn, WorkTask } from './types.js'

/** token 账本求和：兼容多种字段命名（inputTokens/prompt_tokens/…）；cacheRead 单列不计入 input */
export function usageOf(usage: Record<string, number> | undefined): { input: number; output: number; cacheRead: number } {
  const u = usage || {}
  let input = 0
  let output = 0
  let cacheRead = 0
  for (const [k, v] of Object.entries(u)) {
    if (typeof v !== 'number') continue
    const key = k.toLowerCase()
    if (key.includes('cache') && (key.includes('read') || key.includes('hit'))) cacheRead += v
    else if (key.includes('input') || key.includes('prompt')) input += v
    else if (key.includes('output') || key.includes('completion')) output += v
  }
  return { input, output, cacheRead }
}

/** 回合 token 的归属时刻：收尾时刻优先（跨日回合归完成日），旧数据无 endedAt 回退开始时刻 */
export function turnUsageAt(turn: Pick<TaskTurn, 'at' | 'endedAt'>): number {
  return turn.endedAt ?? turn.at
}

export interface UsageTotals {
  tokensIn: number
  tokensOut: number
  cacheRead: number
  toolCalls: number
}

/** 汇总「归属时刻 ≥ since」的全部回合用量（监控今日 KPI / 快照共用） */
export function sumUsageSince(tasks: Array<Pick<WorkTask, 'turns'>>, since: number): UsageTotals {
  const out: UsageTotals = { tokensIn: 0, tokensOut: 0, cacheRead: 0, toolCalls: 0 }
  for (const t of tasks) {
    for (const turn of t.turns || []) {
      if (turnUsageAt(turn) < since) continue
      const u = usageOf(turn.usage)
      out.tokensIn += u.input
      out.tokensOut += u.output
      out.cacheRead += u.cacheRead
      out.toolCalls += (turn.tools || []).length
    }
  }
  return out
}
