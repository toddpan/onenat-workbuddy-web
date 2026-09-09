/**
 * Mock ONENAT 服务 — 仅为本地链路验证用（云端 123.57.138.43:18080 恢复后无需此服务）
 * 数据形状与真实 ONENAT /api/v1 完全一致（见 onenat-skill.md 实测）
 */
const http = require('node:http')
const fs = require('node:fs')

const PORT = 18080
const KEY = 'onk-mock-key-000'
const auth = (req) => {
  const h = req.headers.authorization || ''
  return h === 'Bearer ' + KEY || (req.url || '').includes('key=' + KEY)
}

const skillSsh = fs.readFileSync('/Users/tsbj/feyanggit/ngrok/onenat-app-ssh-usage.md', 'utf-8')
const skillDsh = fs.readFileSync('/Users/tsbj/feyanggit/ngrok/dsh-web-service-skill.md', 'utf-8')

const tunnels = [
  {
    id: 'tunnel-local',
    name: '本地验证环境',
    note: 'mock ONENAT 本地联调',
    online: true,
    mappings: [
      {
        id: 'map-ssh-01',
        proto: 'tcp',
        public_url: 'tcp://127.0.0.1:22',
        local: '127.0.0.1:22',
        note: '本机 SSH',
        auth_override: true,
        auth_type: 'basic',
        app: {
          id: 'app-ssh-01', name: 'SSH Server', type: 'ssh', auth_type: 'basic', username: 'tsbj',
          description: 'mock: 本机 SSH',
          skills: [{ name: 'usage.md', size: skillSsh.length, url: `http://127.0.0.1:${PORT}/api/v1/apps/app-ssh-01/skills/usage.md/content?key=${KEY}` }],
        },
      },
      {
        id: 'map-dsh-01',
        proto: 'tcp',
        public_url: 'tcp://127.0.0.1:3999',
        local: '127.0.0.1:3080',
        note: 'DSH 本机实例(端口漂移演练: 3080→3999)',
        auth_override: false,
        auth_type: 'bearer',
        app: {
          id: 'app-dsh-01', name: 'DSH', type: 'http-api', auth_type: 'bearer',
          internal_url: 'http://127.0.0.1:3080',
          description: 'mock: DeepSeek Harness Web Service',
          skills: [{ name: 'dsh-web-service', size: skillDsh.length, url: `http://127.0.0.1:${PORT}/api/v1/apps/app-dsh-01/skills/dsh-web-service/content?key=${KEY}` }],
        },
        // 演练: 模拟客户端重连后公网端口漂移（DSH 经本机 socat/nginx 不变，这里直接改端口字段做断言）
        public_url_note: 'drift-drill',
      },
    ],
  },
]

const server = http.createServer((req, res) => {
  const url = req.url || '/'
  if (!auth(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: '无效 API KEY' }))
    return
  }
  const json = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)) }
  if (url === '/api/v1/resources') return json(200, { base_url: `http://127.0.0.1:${PORT}`, tunnels })
  if (url === '/api/v1/apps') {
    return json(200, { ok: true, data: tunnels.flatMap(t => t.mappings.map(m => m.app)) })
  }
  let m = /^\/api\/v1\/apps\/([^/]+)\/skills\/([^/]+)\/content/.exec(url)
  if (m) {
    const text = m[1] === 'app-ssh-01' ? skillSsh : skillDsh
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' })
    return res.end(text)
  }
  m = /^\/api\/v1\/mappings\/([^/]+)\/credentials/.exec(url)
  if (m) {
    if (m[1] === 'map-ssh-01') return json(200, { auth_type: 'basic', username: 'tsbj', password: 'mock-pass-not-real', resolved_from: 'mapping-override' })
    return json(200, { auth_type: 'bearer', resolved_from: 'app-default' })
  }
  m = /^\/api\/v1\/apps\/([^/]+)\/credentials/.exec(url)
  if (m) return json(200, { auth_type: 'bearer', resolved_from: 'app-default' })
  json(404, { error: 'not found: ' + url })
})

server.listen(PORT, '127.0.0.1', () => console.log('mock ONENAT listening on 127.0.0.1:' + PORT))
