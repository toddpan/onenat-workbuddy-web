/**
 * 客户端渲染回归测试（jsdom 驱动「真实渲染出的控制台 UI」）
 *
 * 目标：无论流式事件是否完整到达，聊天窗口中该轮 AI 消息的**最终显示文本**
 *       必须等于服务端权威 turn.text（不丢、不截断）。
 *
 * 场景：
 *   C1 正常流式：turn_start → deltas → turn_end(全文)                 → 期望全文
 *   C2 中途加入：详情里已是半截正文(streaming)，之后无 delta，turn_end(全文) → 期望全文
 *   C3 断线丢帧：收到部分 delta，之后 SSE 静默（丢帧），turn_end(全文)      → 期望全文
 *   C4 断线且丢 turn_end：收到部分 delta 后彻底静默 → 重连(open) 后必须回源补齐 → 期望全文
 *   C5 折叠旧轮次 + 重连：轮次多于 initialVisibleLimit 时，回源补齐不得把折叠的旧轮次补到末尾
 *
 * 用法: node e2e-artifacts/client-streaming-test.mjs [uiHtmlPath]
 */
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'

/** jsdom 仅用于本回归测试：优先 DSH checkout，其次本地 node_modules；都没有则跳过 */
function loadJsdom() {
  const anchors = [
    process.env.DSH_CHECKOUT ? `${process.env.DSH_CHECKOUT}/package.json` : null,
    '/Users/tsbj/feyanggit/deepseek-harness/package.json',
    `${process.env.HOME}/deepseek-harness/package.json`,
    `${process.env.HOME}/feyanggit/deepseek-harness/package.json`,
  ].filter((p) => p && existsSync(p))
  for (const anchor of anchors) {
    try { return createRequire(anchor)('jsdom') } catch { /* 试下一个 */ }
  }
  try { return createRequire(import.meta.url)('jsdom') } catch {
    console.log('⚠️ 未找到 jsdom（npm i -D jsdom 或设置 DSH_CHECKOUT 后重跑），跳过客户端渲染回归')
    process.exit(0)
  }
}

const { JSDOM } = loadJsdom()

const uiPath = process.argv[2] || '/tmp/wb-ui.html'
let html = readFileSync(uiPath, 'utf-8')
// 暴露内部函数供测试驱动（插在 boot() 之前，保证脚本作用域内可见）
html = html.replace(
  'boot();',
  `window.__wb = { state, openTask, applyTaskToView, connectStream, disconnectStream, buildTurnElement, finalizeTurnBlocks, streamBuffer };
boot();`,
)

const TASK_ID = 'task-test'
const TURN_ID = 'turn-test'
const FULL_TEXT = '## 最终结论\n\n' + '这是服务端权威的完整正文，必须一字不差地显示出来。'.repeat(20) + '\n\nEND-MARKER-987654321'
const PARTIAL_TEXT = FULL_TEXT.slice(0, 120)

/** 每个场景独立的可控 EventSource */
class FakeEventSource {
  static instances = []
  constructor(url) {
    this.url = url
    this.listeners = {}
    this.readyState = 1
    FakeEventSource.instances.push(this)
  }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn) }
  removeEventListener() {}
  close() { this.readyState = 2 }
  emit(type, obj) {
    for (const fn of this.listeners[type] || []) fn({ data: JSON.stringify(obj) })
  }
  /** 模拟浏览器 EventSource 自动重连：先 error，再 open（含 onXxx 属性式监听） */
  fireError() {
    for (const fn of this.listeners.error || []) fn({})
    if (typeof this.onerror === 'function') this.onerror({})
  }
  fireOpen() {
    for (const fn of this.listeners.open || []) fn({})
    if (typeof this.onopen === 'function') this.onopen({})
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeTask(text, streaming, extraHistoryTurns = 0) {
  const history = []
  for (let i = 0; i < extraHistoryTurns; i++) {
    history.push({ id: `turn-h${i}`, seq: i + 1, role: 'user', text: `历史提问 ${i}`, at: Date.now() - 60000 + i * 100 })
    history.push({ id: `turn-ha${i}`, seq: i + 1, role: 'agent', agentId: 'agent-1', agentName: '测试子智能体', text: `历史回答 ${i}，内容用于占位。`, streaming: false, tools: [], at: Date.now() - 60000 + i * 100 })
  }
  return {
    id: TASK_ID,
    title: '测试任务',
    mode: 'chat',
    status: streaming ? 'running' : 'completed',
    memberAgentIds: ['agent-1'],
    turns: [
      ...history,
      { id: 'turn-user', seq: 900, role: 'user', text: '请给我结论', at: Date.now() - 5000 },
      { id: TURN_ID, seq: 901, role: 'agent', agentId: 'agent-1', agentName: '测试子智能体', text, streaming, tools: [], at: Date.now() },
    ],
    sessions: {},
    createdAt: Date.now() - 60000,
    updatedAt: Date.now(),
  }
}

async function runScenario(name, { detailText, chatEvents, postReconnectTask, extraHistoryTurns = 0, taskAtReconnect }) {
  FakeEventSource.instances = []
  let currentTask = makeTask(detailText, true, extraHistoryTurns)
  let detailCalls = 0

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://127.0.0.1:3081/onenat-workbuddy/',
    beforeParse(window) {
      window.EventSource = FakeEventSource
      window.fetch = async (url) => {
        const u = String(url)
        let body = { ok: true, data: null }
        if (/\/tasks\/[^/]+\/stats/.test(u)) body = { ok: true, data: {} }
        else if (/\/tasks\/[^/?]+$/.test(u)) { detailCalls++; body = { ok: true, data: currentTask } }
        else if (/\/tasks$/.test(u)) body = { ok: true, data: [currentTask] }
        else if (/\/agents$/.test(u)) body = { ok: true, data: [{ id: 'agent-1', name: '测试子智能体', dshRef: { kind: 'direct', apiBaseUrl: 'x' } }] }
        else if (/\/resources$/.test(u)) body = { ok: true, data: { endpoints: [] } }
        else if (/\/settings$/.test(u)) body = { ok: true, data: {} }
        else if (/\/schedules$/.test(u)) body = { ok: true, data: [] }
        else body = { ok: true, data: [] }
        return { status: 200, ok: true, json: async () => body }
      }
      window.__setTask = (t) => { currentTask = t }
    },
  })

  const { window } = dom
  await sleep(120) // 等 boot() 完成
  const wb = window.__wb
  if (!wb) throw new Error('未能注入 __wb 钩子（UI 结构变化？）')

  await wb.openTask(TASK_ID)
  await sleep(60)
  const es = FakeEventSource.instances[FakeEventSource.instances.length - 1]
  if (!es) throw new Error('未建立 SSE 连接')
  es.fireOpen() // 浏览器 EventSource 连接成功必发 open（首次不算重连）
  await sleep(20)

  // 驱动事件
  for (const ev of chatEvents) {
    if (ev.stop) continue
    es.emit(ev.type, ev.data)
    await sleep(0)
  }
  // 触发一次 rAF 冲刷
  await new Promise((r) => window.requestAnimationFrame(() => r()))
  await sleep(30)

  const domMsgsBefore = window.document.querySelectorAll('#chat-scroll .msg').length

  // C4/C5：重连
  if (chatEvents.some((e) => e.stop)) {
    if (postReconnectTask) window.__setTask(postReconnectTask)
    es.fireError()
    es.fireOpen()
    await sleep(120)
    await new Promise((r) => window.requestAnimationFrame(() => r()))
  }

  const domMsgsAfter = window.document.querySelectorAll('#chat-scroll .msg').length
  const el = wb.state.turnEls[TURN_ID]
  const shown = el ? el.blocks.textContent : ''
  let ok = shown.includes('END-MARKER-987654321')
  if (extraHistoryTurns > 0 && domMsgsAfter !== domMsgsBefore) {
    // 回源补齐不得把被 initialVisibleLimit 折叠的旧轮次重复补到末尾
    console.log(`  ⚠️ 重连后气泡数变化 ${domMsgsBefore} → ${domMsgsAfter}（折叠轮次被重复补插）`)
    ok = false
  }
  const shownChars = shown.replace(/\s+/g, '').length
  const fullChars = FULL_TEXT.replace(/\s+/g, '').length
  console.log(`\n[${name}]`)
  console.log(`  显示字符数 ${shownChars} / 期望 ${fullChars}  结尾标记: ${ok ? '✅ 在' : '❌ 缺失'}`)
  if (!ok) console.log('  实际显示尾部:', JSON.stringify(shown.slice(-120)))
  dom.window.close()
  return ok
}

const scenarios = [
  ['C1 正常流式', {
    detailText: '',
    chatEvents: [
      { type: 'turn_start', data: { type: 'turn_start', turn: { id: TURN_ID, seq: 2, role: 'agent', agentId: 'agent-1', agentName: '测试子智能体', text: '', streaming: true, at: Date.now() } } },
      { type: 'turn_delta', data: { type: 'turn_delta', turnId: TURN_ID, delta: FULL_TEXT.slice(0, 200), seq: 0 } },
      { type: 'turn_delta', data: { type: 'turn_delta', turnId: TURN_ID, delta: FULL_TEXT.slice(200, 600), seq: 1 } },
      { type: 'turn_delta', data: { type: 'turn_delta', turnId: TURN_ID, delta: FULL_TEXT.slice(600), seq: 2 } },
      { type: 'turn_end', data: { type: 'turn_end', turn: makeTask(FULL_TEXT, false).turns[1] } },
    ],
  }],
  ['C2 中途加入（详情半截 + 无后续 delta）', {
    detailText: PARTIAL_TEXT,
    chatEvents: [
      { type: 'turn_end', data: { type: 'turn_end', turn: makeTask(FULL_TEXT, false).turns[1] } },
    ],
  }],
  ['C3 断线丢帧（部分 delta 后直接 turn_end）', {
    detailText: '',
    chatEvents: [
      { type: 'turn_start', data: { type: 'turn_start', turn: { id: TURN_ID, seq: 2, role: 'agent', agentId: 'agent-1', agentName: '测试子智能体', text: '', streaming: true, at: Date.now() } } },
      { type: 'turn_delta', data: { type: 'turn_delta', turnId: TURN_ID, delta: PARTIAL_TEXT, seq: 0 } },
      { type: 'turn_end', data: { type: 'turn_end', turn: makeTask(FULL_TEXT, false).turns[1] } },
    ],
  }],
  ['C4 断线且 turn_end 也丢（重连后须回源补齐）', {
    detailText: '',
    chatEvents: [
      { type: 'turn_start', data: { type: 'turn_start', turn: { id: TURN_ID, seq: 2, role: 'agent', agentId: 'agent-1', agentName: '测试子智能体', text: '', streaming: true, at: Date.now() } } },
      { type: 'turn_delta', data: { type: 'turn_delta', turnId: TURN_ID, delta: PARTIAL_TEXT, seq: 0 } },
      { type: 'gap', stop: true },
    ],
    postReconnectTask: makeTask(FULL_TEXT, false),
  }],
  ['C5 折叠旧轮次 + 重连（不得把折叠轮次补到末尾）', {
    detailText: PARTIAL_TEXT,
    extraHistoryTurns: 20, // 共 42 轮 > initialVisibleLimit(30)
    chatEvents: [{ type: 'gap', stop: true }],
    postReconnectTask: makeTask(FULL_TEXT, false, 20),
  }],
]

let pass = 0
for (const [name, cfg] of scenarios) {
  try {
    if (await runScenario(name, cfg)) pass++
  } catch (e) {
    console.log(`\n[${name}]\n  ❌ 异常: ${e.message}`)
  }
}
console.log(`\n================ 客户端渲染回归：${pass}/${scenarios.length} 通过 ================`)
process.exit(pass === scenarios.length ? 0 : 2)
