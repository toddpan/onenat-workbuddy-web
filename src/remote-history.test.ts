import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DshClient } from './remote-client.js'

test('streamPrompt accumulates per-step usage across a multi-tool turn', async () => {
  const frames = [
    ['usage', { usage: { inputTokens: 10, cacheReadTokens: 100, outputTokens: 3 }, seq: 5 }],
    ['usage', { usage: { inputTokens: 20, cacheReadTokens: 200, outputTokens: 7 }, seq: 10 }],
    ['turn_end', { reason: 'completed' }], ['done', '[DONE]'],
  ].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('')
  const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.end(frames) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const seen: Record<string, number>[] = []
    const result = await new DshClient().streamPrompt({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1` }, 'minimal', 'test', { onUsage: u => seen.push(u) })
    assert.equal(result.usage?.inputTokens, 30)
    assert.equal(result.usage?.cacheReadTokens, 300)
    assert.equal(result.usage?.outputTokens, 10)
    assert.equal(seen[1].inputTokens, 30)
    assert.equal(seen[0].inputTokens, 10, 'previous snapshots must remain immutable')
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('getSessionStats respects explicit zero uncached input from compatible nodes', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, data: { usage: { inputTokens: 100, uncachedInputTokens: 0, cacheReadTokens: 100, outputTokens: 7 } } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const result = await new DshClient().getSessionStats({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1` }, 'minimal')
    assert.equal(result.stats?.inputTokens, 0)
    assert.equal(result.stats?.cacheReadTokens, 100)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

async function withHistoryServer(
  body: unknown,
  run: (baseUrl: string) => Promise<void>,
  status = 200,
): Promise<void> {
  const server = createServer((req, res) => {
    assert.equal(req.method, 'GET')
    assert.equal(req.url, '/api/v1/sessions/minimal/history?maxMessages=100')
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  }
}

test('getHistory preserves the installed dsh-web-service history payload and pagination metadata', async () => {
  // Installed sessions.ts returns this shape, including user/assistant text and event counters.
  const messages = [
    { seq: 1, type: 'user/message', role: 'user', content: 'ping', time: 1000 },
    { seq: 5, type: 'assistant/message', role: 'assistant', content: 'pong', time: 2000 },
  ]
  await withHistoryServer({ ok: true, data: {
    sessionId: 'minimal', messages, totalMessages: 4, totalEvents: 12, hasMore: true,
  } }, async (baseUrl) => {
    const result = await new DshClient().getHistory({ baseUrl }, 'minimal')
    assert.deepEqual(result, {
      ok: true, sessionId: 'minimal', messages, totalMessages: 4, totalEvents: 12, hasMore: true,
    })
  })
})

test('getHistory rejects invalid history payloads instead of reporting successful empty history', async (t) => {
  for (const data of [undefined, null, {}, { messages: null }, { messages: {} }, 'history']) {
    await t.test(JSON.stringify(data) || 'missing data', async () => {
      await withHistoryServer({ ok: true, data }, async (baseUrl) => {
        const result = await new DshClient().getHistory({ baseUrl }, 'minimal')
        assert.equal(result.ok, false)
        assert.match(result.error || '', /history|历史|协议/i)
        assert.equal(result.messages, undefined)
      })
    })
  }
})

test('getHistory rejects a non-boolean success marker', async () => {
  await withHistoryServer({ ok: 'true', data: { messages: [] } }, async (baseUrl) => {
    const result = await new DshClient().getHistory({ baseUrl }, 'minimal')
    assert.equal(result.ok, false)
    assert.match(result.error || '', /协议/)
  })
})

test('getHistory distinguishes an empty session from a session with events but no projected messages', async (t) => {
  for (const totalEvents of [0, 7]) {
    await t.test(`${totalEvents} events`, async () => {
      await withHistoryServer({ ok: true, data: {
        sessionId: 'minimal', messages: [], totalMessages: 0, totalEvents, hasMore: false,
      } }, async (baseUrl) => {
        const result = await new DshClient().getHistory({ baseUrl }, 'minimal')
        assert.deepEqual(result, {
          ok: true, sessionId: 'minimal', messages: [], totalMessages: 0, totalEvents, hasMore: false,
        })
      })
    })
  }
})

test('getHistory retains legacy data-array compatibility, including a genuinely empty array', async (t) => {
  for (const messages of [[], [{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }]]) {
    await t.test(`${messages.length} messages`, async () => {
      await withHistoryServer({ ok: true, data: messages }, async (baseUrl) => {
        assert.deepEqual(await new DshClient().getHistory({ baseUrl }, 'minimal'), { ok: true, messages })
      })
    })
  }
})

test('getHistory preserves remote failures and rejects HTTP errors even with an ok envelope', async (t) => {
  for (const scenario of [
    { status: 404, body: { ok: false, error: 'SESSION_NOT_FOUND' }, error: 'SESSION_NOT_FOUND' },
    { status: 200, body: { ok: false, error: 'history unavailable' }, error: 'history unavailable' },
    { status: 503, body: { ok: true, data: { messages: [] } }, error: 'HTTP 503' },
  ]) {
    await t.test(`${scenario.status}: ${scenario.error}`, async () => {
      await withHistoryServer(scenario.body, async (baseUrl) => {
        assert.deepEqual(await new DshClient().getHistory({ baseUrl }, 'minimal'), {
          ok: false, error: scenario.error, status: scenario.status,
          code: scenario.status === 404 ? 'SESSION_EXPIRED' : 'EXECUTION_FAILED',
        })
      }, scenario.status)
    })
  }
})
