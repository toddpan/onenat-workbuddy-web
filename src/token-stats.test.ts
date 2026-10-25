/**
 * Token 统计口径回归测试（token-stats.ts）。
 *
 * 背景（2026-10-25 线上事故）：监控大屏「今日 Token」曾按任务级口径统计
 * （任务 updatedAt 在今天 → 该任务全部回合计入今天），导致长生命周期任务的
 * 历史消耗在每个活跃日被重复累计（2026-10-18/19 趋势图单日虚高 1800 万+/1000 万+）。
 * 现改为按【回合】归属：turn.endedAt（收尾时刻）优先，回退 turn.at（开始时刻）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { usageOf, turnUsageAt, sumUsageSince } from './token-stats.js'
import type { WorkTask } from './types.js'

const DAY = 86_400_000

function dayStart(offsetDays = 0): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime() - offsetDays * DAY
}

const T0 = dayStart()
/** 昨晚 23:50 */
const Y2350 = T0 - 10 * 60_000
/** 今晨 00:10 */
const T0010 = T0 + 10 * 60_000
/** 今天 10:00 */
const T1000 = T0 + 10 * 3_600_000

function task(turns: Array<Partial<WorkTask['turns'][number]>>): Pick<WorkTask, 'turns'> {
  return { turns: turns.map((t, i) => ({ id: `turn-${i + 1}`, seq: i + 1, role: 'agent', text: '', at: T1000, ...t })) as WorkTask['turns'] }
}

test('usageOf：字段命名兼容 + cacheWrite/totalTokens 等杂项不计入', () => {
  assert.deepEqual(
    usageOf({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 30, cacheWriteTokens: 999, totalTokens: 179, modelRequestCount: 6, reasoningTokens: 7, webFetchRequests: 1, source: 0 as unknown as number }),
    { input: 100, output: 50, cacheRead: 30 },
  )
  assert.deepEqual(usageOf({ prompt_tokens: 10, completion_tokens: 5, cache_hit_tokens: 2 }), { input: 10, output: 5, cacheRead: 2 })
  assert.deepEqual(usageOf(undefined), { input: 0, output: 0, cacheRead: 0 })
})

test('turnUsageAt：endedAt 优先，缺失回退 at', () => {
  assert.equal(turnUsageAt({ at: Y2350, endedAt: T0010 }), T0010)
  assert.equal(turnUsageAt({ at: Y2350 }), Y2350)
})

test('跨日回合（新数据有 endedAt）：昨晚开始今晨收尾 → 计入今日', () => {
  const r = sumUsageSince([task([{ at: Y2350, endedAt: T0010, usage: { inputTokens: 5000, outputTokens: 3000, cacheReadTokens: 1000 } }])], T0)
  assert.deepEqual({ i: r.tokensIn, o: r.tokensOut, c: r.cacheRead }, { i: 5000, o: 3000, c: 1000 })
})

test('跨日回合（旧数据无 endedAt）：回退开始时刻 → 不计入今日（与消耗报表回退口径一致）', () => {
  const r = sumUsageSince([task([{ at: Y2350, usage: { inputTokens: 5000, outputTokens: 3000 } }])], T0)
  assert.equal(r.tokensIn, 0)
})

test('多日长任务今天仍活跃：只计今日回合，历史回合不再重复累计（线上 10-18/19 虚高根因回归）', () => {
  const threeDayTask = task([
    { at: T0 - 3 * DAY, usage: { inputTokens: 4_000_000, outputTokens: 10_000, cacheReadTokens: 3_000_000 } },
    { at: T0 - 2 * DAY, usage: { inputTokens: 5_000_000, outputTokens: 11_000, cacheReadTokens: 4_000_000 } },
    { at: T0 - DAY, usage: { inputTokens: 6_000_000, outputTokens: 12_000, cacheReadTokens: 5_000_000 } },
    { at: T1000, usage: { inputTokens: 2_000, outputTokens: 500, cacheReadTokens: 800 }, tools: [{ id: 'x', name: 'read', args: '', result: '', status: 'done', at: T1000 }] },
  ])
  const r = sumUsageSince([threeDayTask], T0)
  assert.deepEqual({ i: r.tokensIn, o: r.tokensOut, c: r.cacheRead, tools: r.toolCalls }, { i: 2_000, o: 500, c: 800, tools: 1 })
})

test('纯历史任务（昨日已完成）不计入今日', () => {
  const r = sumUsageSince([task([{ at: Y2350 - DAY, usage: { inputTokens: 10_000, outputTokens: 5_000 } }])], T0)
  assert.equal(r.tokensIn + r.tokensOut, 0)
})

test('今日任务正常计入（含工具数）', () => {
  const r = sumUsageSince([
    task([
      { at: T1000, usage: { inputTokens: 3_000, outputTokens: 2_000 }, tools: [{ id: 'a', name: 'bash', args: '', result: '', status: 'done', at: T1000 }] },
      { at: T1000 + 1_000, usage: { inputTokens: 1_000, outputTokens: 500 }, tools: [{ id: 'b', name: 'read', args: '', result: '', status: 'done', at: T1000 }, { id: 'c', name: 'grep', args: '', result: '', status: 'error', at: T1000 }] },
    ]),
    task([{ at: T1000, usage: undefined }]), // 无 usage 回合贡献 0
  ], T0)
  assert.deepEqual({ i: r.tokensIn, o: r.tokensOut, tools: r.toolCalls }, { i: 4_000, o: 2_500, tools: 3 })
})
