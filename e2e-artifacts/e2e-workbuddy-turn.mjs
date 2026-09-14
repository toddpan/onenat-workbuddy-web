/**
 * 端到端复现harness：WorkBuddy 引擎 ← 真实 dsh-web-service(远端 DSH)
 *
 * 同时抓三层数据，用于定位「聊天窗口内容不全」发生在哪一层：
 *   L1 远端 SSE 原始帧（monkey-patch DshClient.prototype.streamPrompt 记录）
 *   L2 引擎 task 事件流（engine.subscribe：turn_delta/turn_reasoning/turn_tool/turn_end）
 *   L3 落库的 turn.text（store.getTask().turns）
 * 再与远端会话 history 对账。
 *
 * 用法: node e2e-artifacts/e2e-workbuddy-turn.mjs [remoteBase] [cwd] [outDir]
 */
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { WorkStore } from '../dist/store.js'
import { TaskEngine } from '../dist/engine.js'
import { AgentResolver } from '../dist/resolver.js'
import { PromptComposer } from '../dist/prompt-composer.js'
import { Planner } from '../dist/planner.js'
import { DshClient } from '../dist/remote-client.js'

const remoteBase = (process.argv[2] || 'http://127.0.0.1:3080/api/v1').replace(/\/+$/, '')
const cwd = process.argv[3] || '/tmp'
const outDir = process.argv[4] || '/tmp/wb-e2e'

const PROMPT = [
  '请严格按顺序执行下面三步，每一步都必须真实调用 bash 工具（不要编造输出）：',
  '1) `date +%s`',
  '2) `ls /tmp | head -5`',
  '3) `uname -a`',
  '每执行完一条，先用两三句话解释这条输出的含义；三条都完成后，用不少于 400 字中文总结你做了什么、看到了什么。',
].join('\n')

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

// ---- L1: 抓远端原始 SSE 帧 ----
const rawFrames = []
const origStreamPrompt = DshClient.prototype.streamPrompt
DshClient.prototype.streamPrompt = async function (target, sessionId, prompt, handlers, options) {
  const wrapped = {
    ...handlers,
    onDelta: (d) => { rawFrames.push({ ch: 'delta', d }); handlers.onDelta?.(d) },
    onReasoning: (d) => { rawFrames.push({ ch: 'reasoning', d }); handlers.onReasoning?.(d) },
  }
  const r = await origStreamPrompt.call(this, target, sessionId, prompt, wrapped, options)
  rawFrames.push({ ch: '#result', content: r.content, complete: r.complete, via: r.via, error: r.error })
  return r
}

const store = new WorkStore(`${outDir}/store.json`)
const directory = {
  endpoint: 'http://127.0.0.1:1',
  key: '',
  refresh: async () => ({}),
  listEndpoints: () => [],
  resolveMapping: () => undefined,
  resolveApp: () => undefined,
  fetchMappingCredentials: async () => ({ ok: false }),
}
const resolver = new AgentResolver(store, directory)
const composer = new PromptComposer(directory)
const planner = new Planner(store, resolver)
const engine = new TaskEngine(store, directory, resolver, composer, planner)

const agent = store.upsertAgent({
  name: 'E2E-本地DSH',
  dshRef: { kind: 'direct', apiBaseUrl: remoteBase },
  workDir: cwd,
  resources: [],
  enabled: true,
})

// ---- L2: 引擎事件流 ----
const events = []
const main = async () => {
  const task = await engine.createTask({ memberAgentIds: [agent.id], mode: 'chat', message: PROMPT })
  const taskId = task.id
  const unsub = engine.subscribe(taskId, (e) => {
    const rec = { t: Date.now(), type: e.type }
    if (e.type === 'turn_delta' || e.type === 'turn_reasoning') rec.len = (e.delta || '').length
    if (e.type === 'turn_end') rec.textLen = (e.turn?.text || '').length
    if (e.type === 'task_status') rec.status = e.status
    events.push(rec)
    if (e.type === 'turn_delta' || e.type === 'turn_reasoning') events[events.length - 1].turnId = e.turnId
  })

  // 等待任务结束（轮询 store 状态）
  const deadline = Date.now() + 8 * 60_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500))
    const t = store.getTask(taskId)
    if (t && ['completed', 'failed', 'cancelled'].includes(t.status)) break
  }
  unsub()

  const final = store.getTask(taskId)
  const agentTurns = (final.turns || []).filter((t) => t.role === 'agent')
  const engineDeltaText = rawFrames.concat ? null : null
  const deltasFromEvents = events.filter((e) => e.type === 'turn_delta').reduce((a, e) => a + (e.len || 0), 0)

  // L1 汇总
  const l1Delta = rawFrames.filter((f) => f.ch === 'delta').map((f) => f.d).join('')
  const l1Result = rawFrames.find((f) => f.ch === '#result')
  const l1DeltasSum = l1Delta

  // 远端 history
  const sess = final.sessions[agent.id]
  let remoteAssistant = ''
  let remoteMsgCount = 0
  if (sess) {
    const h = await fetch(`${sess.baseUrl}/sessions/${encodeURIComponent(sess.remoteSessionId)}/history?maxMessages=500`).then((r) => r.json()).catch(() => ({}))
    const msgs = h?.data?.messages || h?.data || []
    const asst = (Array.isArray(msgs) ? msgs : []).filter((m) => m.role === 'assistant')
    remoteMsgCount = asst.length
    remoteAssistant = asst.map((m) => {
      const c = m.content
      if (typeof c === 'string') return c
      if (Array.isArray(c)) return c.filter((x) => x?.type === 'text').map((x) => x.text).join('')
      return ''
    }).join('\n')
  }

  const report = {
    remoteBase, cwd, prompt: PROMPT,
    taskId,
    status: final.status,
    agentTurnIds: agentTurns.map((t) => t.id),
    l1_rawFrames: rawFrames.map((f) => (f.ch === '#result' ? { ch: f.ch, complete: f.complete, via: f.via, error: f.error, contentChars: (f.content || '').length } : { ch: f.ch, chars: (f.d || '').length, head: (f.d || '').slice(0, 40) })),
    l1_streamDeltaChars: l1DeltasSum.length,
    l1_streamDeltaText: l1DeltasSum,
    l2_events: events,
    l2_turnDeltaChars: deltasFromEvents,
    l3_turns: agentTurns.map((t) => ({ id: t.id, textChars: (t.text || '').length, reasoningChars: (t.reasoning || '').length, tools: (t.tools || []).length, text: t.text, usage: t.usage })),
    remote: { assistantMessages: remoteMsgCount, chars: remoteAssistant.length, text: remoteAssistant },
  }
  writeFileSync(`${outDir}/report.json`, JSON.stringify(report, null, 2), 'utf-8')

  console.log('\n================ 端到端三层对账 ================')
  console.log('L1 远端 SSE delta 字符数   :', l1DeltasSum.length, ' complete =', l1Result?.complete, ' via =', l1Result?.via)
  console.log('L2 引擎 turn_delta 字符数  :', deltasFromEvents)
  for (const t of agentTurns) console.log('L3 落库 turn.text 字符数   :', (t.text || '').length, ' tools =', (t.tools || []).length)
  console.log('远端 history 助手文本字符数:', remoteAssistant.length, `(${remoteMsgCount} 条 assistant)`)
  console.log('报告:', `${outDir}/report.json`)
  const ok = l1DeltasSum.length === deltasFromEvents && agentTurns.every((t) => (t.text || '').length === deltasFromEvents)
  console.log(ok ? '✅ 三层字符数一致' : '⚠️ 存在不一致，见 report.json')
}

main().catch((e) => { console.error('[e2e] FAILED', e); process.exit(1) })
