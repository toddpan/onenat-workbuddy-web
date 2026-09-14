/**
 * 故障注入代理：转发到真实 dsh-web-service，但在 SSE /prompt-stream 上模拟「隧道/反代中途掐断」。
 *
 * 现实触发：ONENAT 隧道 + nginx `proxy_read_timeout`、undici bodyTimeout、
 * 长工具/压缩静默段——都表现为「SSE 流在回合中途被切断」。
 *
 * 用法: node e2e-artifacts/cut-proxy.mjs [listenPort] [upstreamBase] [cutAfterNBytes]
 *   cutAfterNBytes 缺省 4096；收到超过该字节数后立即 destroy 连接（不再转发）
 */
import http from 'node:http'

const listenPort = Number(process.argv[2] || 3099)
const upstream = new URL(process.argv[3] || 'http://127.0.0.1:3080')
const cutAfter = Number(process.argv[4] || 4096)

const server = http.createServer((creq, cres) => {
  const isStream = /\/prompt-stream(\?|$)/.test(creq.url || '')
  const headers = { ...creq.headers, host: upstream.host }
  const preq = http.request(
    {
      hostname: upstream.hostname,
      port: upstream.port || 80,
      path: creq.url,
      method: creq.method,
      headers,
    },
    (pres) => {
      if (!isStream) {
        cres.writeHead(pres.statusCode || 200, pres.headers)
        pres.pipe(cres)
        return
      }
      cres.writeHead(pres.statusCode || 200, pres.headers)
      let forwarded = 0
      let cut = false
      pres.on('data', (buf) => {
        if (cut) return
        forwarded += buf.length
        if (forwarded > cutAfter) {
          cut = true
          console.log(`[cut-proxy] 已转发 ${forwarded} 字节 → 模拟隧道中途掐断 (${creq.url})`)
          cres.destroy()          // 客户端侧感知为「流被提前收掉」
          pres.destroy()          // 上游连接一并中断
          return
        }
        cres.write(buf)
      })
      pres.on('end', () => { if (!cut) cres.end() })
      pres.on('error', () => { if (!cut) cres.destroy() })
    },
  )
  preq.on('error', (e) => {
    if (!cres.headersSent) { cres.writeHead(502); cres.end('proxy upstream error: ' + e.message) }
    else cres.destroy()
  })
  creq.pipe(preq)
})

server.listen(listenPort, '127.0.0.1', () => {
  console.log(`[cut-proxy] listening http://127.0.0.1:${listenPort} → ${upstream.origin} (prompt-stream 转发 ${cutAfter} 字节后掐断)`)
})
