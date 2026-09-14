/**
 * 探针：并发订阅
 *   A) POST /sessions/:id/prompt-stream —— 业务流（delta/reasoning/tool_call/tool_result/turn_end）
 *   B) GET  /sessions/:id/events        —— 底层会话事件总线（session/event 原始事件）
 * 回合结束后拉 history 对账，三方字符数/文本比对，定位丢内容发生在哪一层。
 *
 * 用法：node e2e-artifacts/probe-dsh-sse.mjs [baseUrl] [cwd]
 */
import { writeFileSync } from 'node:fs'

const base = (process.argv[2] || 'http://127.0.0.1:3080/api/v1').replace(/\/+$/, '')
const cwd = process.argv[3] || '/tmp'

const PROMPT = [
  '请依次执行以下三步，每一步都必须真的调用 bash 工具（不要凭空编造输出）：',
  '1) 执行 `date +%s` ；',
  '2) 执行 `ls /tmp | head -5` ；',
  '3) 执行 `uname -a` 。',
  '三步全部完成后，用不少于 300 字的中文，逐条复述每条命令的真实输出，并总结你做了什么。',
].join('\n')

const t0 = Date.now()
const stamp = () => Date.now() - t0

/** 通用 SSE 帧读取：把 `event:`/`data:` 帧按到达顺序交给 onFrame */
async function readSse(res, onFrame, label) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let stopped = false
  while (!stopped) {
    const chunk = await reader.read()
    if (chunk.done) break
    buf += decoder.decode(chunk.value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const evName = /^event:\s*(.+)$/m.exec(frame)?.[1]?.trim()
      const dataRaw = /^data:\s*([\s\S]*)$/m.exec(frame)?.[1] ?? ''
      let data = dataRaw
      try { data = JSON.parse(dataRaw) } catch {}
      if (await onFrame(evName, data, frame) === false) { stopped = true; break }
    }
  }
  try { await reader.cancel() } catch {}
  console.log(`[${label}] 读取结束 @${stamp()}ms`)
}

async function main() {
  const created = await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd, title: 'SSE 完整性探针' }),
  }).then((r) => r.json())
  if (!created?.ok) throw new Error('create session failed: ' + JSON.stringify(created))
  const sessionId = created.data?.sessionId || created.data?.id
  console.log('[probe] session =', sessionId, 'cwd =', cwd)

  // ---- B) 先挂底层事件总线 ----
  const busFrames = []
  let busText = ''
  const busAbort = new AbortController()
  const busRes = await fetch(`${base}/sessions/${encodeURIComponent(sessionId)}/events`, { signal: busAbort.signal })
  const busTask = readSse(busRes, (evName, data) => {
    if (evName !== 'event') return true
    const type = data?.type
    let chars = 0
    if (type === 'assistant/message') {
      const c = data?.data?.message?.content
      if (Array.isArray(c)) {
        const t = c.filter((x) => x.type === 'text').map((x) => x.text).join('')
        chars = t.length
        busText += t
      }
    }
    busFrames.push({ t: stamp(), type, chars, seq: data?.seq })
    console.log(`[bus] @${stamp()}ms seq=${data?.seq} ${type} chars=${chars}`)
    return true
  }, 'bus')

  // ---- A) 业务流 ----
  const frames = []
  let deltaText = ''
  let reasoningText = ''
  const res = await fetch(`${base}/sessions/${encodeURIComponent(sessionId)}/prompt-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: PROMPT, timeoutMs: 600000 }),
  })
  console.log('[probe] prompt-stream HTTP', res.status)
  await readSse(res, (evName, data) => {
    const entry = { t: stamp(), ev: evName, len: typeof data?.delta === 'string' ? data.delta.length : undefined }
    if (evName === 'delta') { deltaText += data.delta; entry.head = data.delta.slice(0, 80) }
    if (evName === 'reasoning') { reasoningText += data.delta || ''; entry.head = String(data.delta).slice(0, 40) }
    if (evName === 'tool_call') entry.head = data?.name
    if (evName === 'turn_end') entry.head = JSON.stringify(data?.reason).slice(0, 40)
    frames.push(entry)
    console.log('[stream]', JSON.stringify(entry))
    return evName !== 'done'
  }, 'stream')

  // ---- 收尾对账 ----
  await new Promise((r) => setTimeout(r, 1500))
  busAbort.abort()
  await busTask.catch(() => {})

  const hist = await fetch(`${base}/sessions/${encodeURIComponent(sessionId)}/history?maxMessages=200`).then((r) => r.json())
  const msgs = hist?.data?.messages || hist?.data || []
  const assistantTexts = (Array.isArray(msgs) ? msgs : []).filter((m) => m?.role === 'assistant').map((m) => {
    const c = m.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) return c.filter((x) => x?.type === 'text').map((x) => x.text).join('')
    return ''
  })
  const historyAll = assistantTexts.join('\n')

  const report = {
    sessionId, base,
    busFrames,
    streamFrames: frames,
    bus: { assistantMessageChars: busText.length, busText },
    stream: { deltaChars: deltaText.length, reasoningChars: reasoningText.length, deltaText, reasoningText },
    history: { assistantMessages: assistantTexts.length, chars: historyAll.length, historyAll },
  }
  const out = new URL('./probe-dsh-sse-result.json', import.meta.url)
  writeFileSync(out, JSON.stringify(report, null, 2), 'utf-8')

  console.log('\n================ 汇总 ================')
  console.log('底层事件总线上 assistant/message 文本字符数 :', busText.length)
  console.log('业务流 prompt-stream 上 delta 字符数        :', deltaText.length)
  console.log('history 中 assistant 文本字符数             :', historyAll.length)
  console.log('底层事件类型序列                            :', busFrames.map((f) => f.type).join(' → '))
  console.log('结果已写入                                  :', out.pathname)
  if (busText.length !== deltaText.length) console.log('⚠️ 底层事件与业务流字符数不一致 —— 丢内容发生在 prompt-stream 转发层')
  else console.log('✅ 底层事件与业务流字符数一致')
}

main().catch((e) => { console.error('[probe] FAILED', e); process.exit(1) })
