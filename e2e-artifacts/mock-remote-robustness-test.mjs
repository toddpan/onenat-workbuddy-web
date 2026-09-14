/**
 * 远端链路健壮性测试（确定性 mock 远端 DSH，不消耗 API 额度）
 *
 * 覆盖导致「聊天窗口内容收不全」的传输层故障：
 *   R1 正常帧           —— 基线
 *   R2 CRLF 行尾        —— 反代/隧道改写行尾后，'\n\n' 切帧会一帧都切不出来
 *   R3 多行 data:       —— 规范允许服务端把长载荷拆成多行
 *   R4 心跳注释         —— ': hb' 注释行不得干扰解析
 *   R5 中途掐断         —— 隧道/undici 空闲超时把 SSE 掐断（应有 complete=false + 已收内容）
 *   R6 掐断后引擎兜底   —— 引擎必须靠轮询对账拿回**全文**并落库（不得停在半截）
 *
 * 用法: node e2e-artifacts/mock-remote-robustness-test.mjs
 */
import http from 'node:http'
import { rmSync, mkdirSync } from 'node:fs'
import { DshClient } from '../dist/remote-client.js'
import { WorkStore } from '../dist/store.js'
import { TaskEngine } from '../dist/engine.js'
import { AgentResolver } from '../dist/resolver.js'
import { PromptComposer } from '../dist/prompt-composer.js'
import { Planner } from '../dist/planner.js'

const OUT = '/tmp/wb-mock-test'
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const STEP_TEXTS = [
  '第一步：' + 'A'.repeat(200),
  '第二步：' + 'B'.repeat(300),
  '第三步：' + 'C'.repeat(400),
]
const FULL = STEP_TEXTS.join('')

// ---------------------------------------------------------------- mock 远端 DSH
let mode = 'ok' // ok | crlf | multiline | heartbeat | cut
let sessionStatus = 'idle'
let historyMessages = []

const server = http.createServer((req, res) => {
  const url = req.url || ''
  const send = (obj, code = 200) => {
    res.statusCode = code
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(obj))
  }
  if (req.method === 'POST' && /^\/api\/v1\/sessions$/.test(url)) {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => send({ ok: true, data: { sessionId: 'session-mock' } }))
    return
  }
  if (req.method === 'GET' && /^\/api\/v1\/sessions\/[^/]+$/.test(url)) {
    return send({ ok: true, data: { id: 'session-mock', status: sessionStatus, cwd: '/tmp' } })
  }
  if (req.method === 'GET' && /history/.test(url)) {
    return send({ ok: true, data: { messages: historyMessages, hasMore: false } })
  }
  if (req.method === 'POST' && /\/prompt-stream$/.test(url)) {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      const nl = mode === 'crlf' ? '\r\n' : '\n'
      // 规范：载荷中的每个换行行都要以 'data: ' 前缀单独成行；客户端按 \n 重新拼接
      const frame = (event, data) => {
        const dataLines = String(data).split('\n').map((l) => `data: ${l}`).join(nl)
        res.write(`event: ${event}${nl}${dataLines}${nl}${nl}`)
      }
      const payload = (obj) => {
        // multiline：服务端把「本身含换行的载荷」按行拆成多条 data:
        return mode === 'multiline' ? JSON.stringify(obj, null, 2) : JSON.stringify(obj)
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' })
      frame('connected', JSON.stringify({ sessionId: 'session-mock' }))
      let seq = 0
      let i = 0
      const finishTurn = () => {
        sessionStatus = 'idle'
        historyMessages = [
          { seq: 1, role: 'user', content: 'PROMPT-FRAGMENT-UNIQUE' },
          ...STEP_TEXTS.map((t, k) => ({ seq: 10 + k, role: 'assistant', content: t })),
        ]
      }
      const tick = () => {
        if (i >= STEP_TEXTS.length) {
          if (mode !== 'cut') {
            frame('turn_end', JSON.stringify({ reason: 'completed', seq: seq++ }))
            frame('done', '[DONE]')
          }
          finishTurn()
          return
        }
        // 心跳注释行（不得干扰解析）
        if (mode === 'heartbeat') res.write(`: hb${nl}${nl}`)
        frame('delta', payload({ delta: STEP_TEXTS[i], seq: seq++ }))
        i++
        if (mode === 'cut' && i === 1) {
          // 模拟隧道/undici 空闲超时：第一段之后直接掐断客户端连接；
          // 远端回合仍在继续 —— 稍后自然结束（history 补齐全文），供引擎轮询对账
          setTimeout(() => res.destroy(), 10)
          setTimeout(finishTurn, 700)
          return
        }
        setTimeout(tick, 10)
      }
      setTimeout(tick, 10)
    })
    return
  }
  send({ ok: false, error: 'not found' }, 404)
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/api/v1`
const target = { baseUrl: base }
const client = new DshClient()

let pass = 0
let total = 0
function check(label, ok, detail) {
  total++
  if (ok) { pass++; console.log(`  ✅ ${label}`) }
  else console.log(`  ❌ ${label} — ${detail}`)
}

async function collect(label) {
  const chunks = []
  const r = await client.streamPrompt(target, 'session-mock', 'PROMPT-FRAGMENT-UNIQUE', {
    onDelta: (d) => chunks.push(d),
  })
  return { r, joined: chunks.join('') }
}

// ---------------- R1..R5：协议解析层 ----------------
for (const [name, m, expectFull] of [
  ['R1 正常帧', 'ok', true],
  ['R2 CRLF 行尾（反代改写）', 'crlf', true],
  ['R3 多行 data: 载荷', 'multiline', true],
  ['R4 心跳注释行', 'heartbeat', true],
  ['R5 中途掐断（complete=false）', 'cut', false],
]) {
  mode = m
  sessionStatus = 'running'
  historyMessages = []
  console.log(`\n[${name}]`)
  const { r, joined } = await collect(name)
  if (expectFull) {
    check(`增量累计 = 全文 (${joined.length}/${FULL.length})`, joined === FULL, `实际 ${joined.length} 字符, error=${r.error}`)
    check('complete === true', r.complete !== false, `complete=${r.complete}`)
  } else {
    check('已收到的增量保留（不丢已收部分）', joined === STEP_TEXTS[0], `收到 ${joined.length} 字符`)
    check('complete === false（判定为断流，可触发兜底）', r.complete === false, `complete=${r.complete}`)
  }
}

// ---------------- R6：引擎兜底对账 ----------------
console.log('\n[R6 引擎：断流后轮询对账必须拿回全文并落库]')
mode = 'cut'
sessionStatus = 'running'
historyMessages = []
// 让轮询在 300ms 粒度上跑（保持真实逻辑，仅缩短测试时长）
const origWait = DshClient.prototype.waitForSessionResult
DshClient.prototype.waitForSessionResult = function (t, s, o) {
  return origWait.call(this, t, s, { ...(o || {}), intervalMs: 300, maxMs: 30_000 })
}

const store = new WorkStore(`${OUT}/store.json`)
const directory = {
  endpoint: 'http://127.0.0.1:1', key: '',
  refresh: async () => ({}), listEndpoints: () => [],
  resolveMapping: () => undefined, resolveApp: () => undefined,
  fetchMappingCredentials: async () => ({ ok: false }),
}
const resolver = new AgentResolver(store, directory)
const engine = new TaskEngine(store, directory, resolver, new PromptComposer(directory), new Planner(store, resolver))
const agent = store.upsertAgent({ name: 'mock', dshRef: { kind: 'direct', apiBaseUrl: base }, resources: [], enabled: true })
const task = await engine.createTask({ memberAgentIds: [agent.id], mode: 'chat', message: 'PROMPT-FRAGMENT-UNIQUE' })

const deadline = Date.now() + 40_000
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 200))
  const t = store.getTask(task.id)
  if (t && ['completed', 'failed', 'cancelled'].includes(t.status)) break
}
const finalTurn = store.getTask(task.id).turns.find((t) => t.role === 'agent')
const ordered = STEP_TEXTS.every((t, k) => finalTurn.text.includes(t) && (k === 0 || finalTurn.text.indexOf(STEP_TEXTS[k - 1]) < finalTurn.text.indexOf(t)))
check(`落库正文包含全部三段且有序 (${(finalTurn.text || '').length} 字符)`, ordered, `实际: ${JSON.stringify(String(finalTurn.text).slice(0, 80))}`)
check('轮次已收敛（streaming=false）', finalTurn.streaming === false, `streaming=${finalTurn.streaming}`)

// ---------------- R7：store 高频写入合并 ----------------
console.log('\n[R7 store 流式写入合并（事件循环阻塞）]')
const t0 = process.hrtime.bigint()
for (let i = 0; i < 200; i++) store.appendTurnText(task.id, finalTurn.id, 'x')
store.flush()
const perAppend = Number(process.hrtime.bigint() - t0) / 1e6 / 200
check(`单次增量落库 < 0.2ms（实测 ${perAppend.toFixed(4)}ms）`, perAppend < 0.2, `${perAppend.toFixed(3)}ms`)
check('内存态即时可见（不受落盘合并影响）', store.getTask(task.id).turns.find((t) => t.id === finalTurn.id).text.endsWith('x'))

DshClient.prototype.waitForSessionResult = origWait
server.close()
console.log(`\n================ mock 健壮性测试：${pass}/${total} 通过 ================`)
process.exit(pass === total ? 0 : 2)
