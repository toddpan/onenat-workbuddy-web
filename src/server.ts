#!/usr/bin/env node
/**
 * onenat-workbuddy-web - 独立部署入口（不依赖 DSH）
 *
 * 用 Node 原生 http 提供完整的 WorkBuddy Web 服务：
 *   - 控制台 UI          GET  {prefix}/
 *   - 全部业务 REST API  {prefix}/api/**        （WorkBuddyRouter 原样复用）
 *   - SSE 流式对话       GET  {prefix}/api/tasks/:id/stream
 *   - 工具能力 HTTP 通道  GET  {prefix}/api/tools          列出工具与参数
 *                        POST {prefix}/api/tools/:name    调用工具（等价 DSH 模型工具）
 *   - 健康检查           GET  /healthz
 *
 * 依赖仅 ssh2 / undici（可选加速）与 Node ≥ 20 内建能力，不 import cordis / @deepseek-ai/*。
 *
 * 用法:
 *   node dist/server.js --port 3081 --onenat-base-url http://127.0.0.1:18080 --onenat-api-key onk-xxx
 *   npm run start:standalone -- --port 3081
 */

import http from 'node:http'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { OnenatDirectory } from './onenat.js'
import { WorkStore } from './store.js'
import { AgentResolver } from './resolver.js'
import { PromptComposer } from './prompt-composer.js'
import { Planner } from './planner.js'
import { TaskEngine } from './engine.js'
import { ScheduleRunner } from './scheduler.js'
import { WorkBuddyRouter } from './router.js'
import { MonitorService } from './monitor.js'
import { XiaozhiMcpClient } from './xiaozhi-mcp.js'
import { SshResourceStore } from './ssh-store.js'
import { createWorkBuddyToolDefs, HTTP_TOOL_CTX, type WorkBuddyToolDef } from './tool-ops.js'
import { AuthService, SESSION_COOKIE } from './auth.js'
import { renderLoginUi } from './login-ui.js'
import { formatDateVersion, readPackageVersion } from './date-version.js'

// ---------------------------------------------------------------- 配置解析

export interface StandaloneConfig {
  host: string
  port: number
  prefix: string
  dataDir: string
  onenatBaseUrl: string
  onenatApiKey: string
  autoRefreshMs: number
  /** 设置后，工具 HTTP 通道需携带该令牌（控制台 UI 走登录会话） */
  apiToken: string
  /** 小智平台 MCP 接入点（ws:// / wss://，env WORKBUDDY_XIAOZHI_MCP；存储为空时作种子） */
  xiaozhiMcp: string
  /** 管理员账号（首次启动播种到 auth.json；默认 workbuddy） */
  adminUsername: string
  adminPassword: string
  quiet: boolean
}

const HELP = `OneNat WorkBuddy — 独立部署 WEB 服务（不依赖 DSH）

用法: node dist/server.js [选项]

选项:
  -p, --port <n>              监听端口（默认 3081；env PORT）
      --host <addr>           监听地址（默认 127.0.0.1；env HOST；0.0.0.0 表示对外暴露）
      --prefix <path>         路由前缀（默认 /onenat-workbuddy；设为 / 即挂到根路径）
      --data <dir>            数据目录（默认 $WORKBUDDY_HOME 或 ~/.onenat-workbuddy）
      --onenat-base-url <url> ONENAT 服务地址（默认取存储中的设置）
      --onenat-api-key <key>  ONENAT API Key（默认取存储中的设置）
      --auto-refresh <ms>     资源目录自动刷新间隔（默认取存储设置，通常 60000）
      --token <token>         AI APIKEY 种子（env WORKBUDDY_TOKEN；存储为空时写入；未配置任何令牌时工具通道拒绝一切调用）
      --xiaozhi-mcp <url>     小智平台 MCP 接入点（env WORKBUDDY_XIAOZHI_MCP；存储为空时作种子，设置页可改）
      --admin-username <name> 管理员用户名（env WORKBUDDY_ADMIN_USERNAME；默认 workbuddy，仅首次播种生效）
      --admin-password <pwd>  管理员密码（env WORKBUDDY_ADMIN_PASSWORD；默认 ThunderSoft@88，仅首次播种生效）
      --quiet                 关闭请求日志
  -h, --help                  显示帮助
  -v, --version               显示版本
`

export function parseArgs(argv: string[]): StandaloneConfig | { help: string } | { version: true } {
  const env = process.env
  const cfg: StandaloneConfig = {
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 0) || 3081,
    prefix: env.WORKBUDDY_PREFIX || '/onenat-workbuddy',
    dataDir: env.WORKBUDDY_HOME || join(homedir(), '.onenat-workbuddy'),
    onenatBaseUrl: env.ONENAT_BASE_URL || '',
    onenatApiKey: env.ONENAT_API_KEY || '',
    autoRefreshMs: Number(env.WORKBUDDY_AUTO_REFRESH_MS || 0),
    apiToken: env.WORKBUDDY_TOKEN || '',
    xiaozhiMcp: env.WORKBUDDY_XIAOZHI_MCP || '',
    adminUsername: env.WORKBUDDY_ADMIN_USERNAME || '',
    adminPassword: env.WORKBUDDY_ADMIN_PASSWORD || '',
    quiet: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`选项 ${a} 缺少取值`)
      return v
    }
    switch (a) {
      case '-h':
      case '--help':
        return { help: HELP }
      case '-v':
      case '--version':
        return { version: true }
      case '-p':
      case '--port':
        cfg.port = Number(next())
        break
      case '--host':
        cfg.host = next()
        break
      case '--prefix':
        cfg.prefix = next()
        break
      case '--data':
        cfg.dataDir = next()
        break
      case '--onenat-base-url':
        cfg.onenatBaseUrl = next()
        break
      case '--onenat-api-key':
        cfg.onenatApiKey = next()
        break
      case '--auto-refresh':
        cfg.autoRefreshMs = Number(next())
        break
      case '--token':
        cfg.apiToken = next()
        break
      case '--xiaozhi-mcp':
        cfg.xiaozhiMcp = next()
        break
      case '--admin-username':
        cfg.adminUsername = next()
        break
      case '--admin-password':
        cfg.adminPassword = next()
        break
      case '--quiet':
        cfg.quiet = true
        break
      default:
        if (a.startsWith('--') && a.includes('=')) {
          const [k, ...rest] = a.split('=')
          return parseArgs([...argv.slice(0, i), k, rest.join('='), ...argv.slice(i + 1)])
        }
        throw new Error(`未知选项: ${a}`)
    }
  }

  if (!Number.isFinite(cfg.port) || cfg.port <= 0 || cfg.port > 65535) throw new Error(`非法端口: ${cfg.port}`)
  if (!Number.isFinite(cfg.autoRefreshMs) || cfg.autoRefreshMs < 0) throw new Error(`非法刷新间隔: ${cfg.autoRefreshMs}`)
  cfg.prefix = normalizePrefix(cfg.prefix)
  cfg.dataDir = resolve(cfg.dataDir)
  return cfg
}

export function normalizePrefix(input: string): string {
  let p = String(input || '').trim()
  if (p === '/' || p === '') return ''
  if (!p.startsWith('/')) p = '/' + p
  return p.replace(/\/+$/, '')
}

/** 版本号：日期发布风格（YYYY.M.D），单一来源 package.json version */
function pkgVersion(): string {
  return formatDateVersion(readPackageVersion())
}

// ---------------------------------------------------------------- 服务装配

export interface StandaloneApp {
  server: http.Server
  router: WorkBuddyRouter
  tools: WorkBuddyToolDef[]
  directory: OnenatDirectory
  store: WorkStore
  config: StandaloneConfig
  port: number
  consoleUrl: string
  auth: AuthService
  close(): Promise<void>
}

export function createApp(cfg: StandaloneConfig): StandaloneApp {
  const storePath = join(cfg.dataDir, 'store.json')
  const sshStorePath = join(cfg.dataDir, 'ssh-resources.json')
  const store = new WorkStore(storePath)
  const sshStore = new SshResourceStore(sshStorePath)

  // 优先级: 命令行/env > 存储中的设置
  const settings = store.getSettings()
  if (cfg.onenatBaseUrl) settings.onenat.baseUrl = cfg.onenatBaseUrl
  if (cfg.onenatApiKey) settings.onenat.apiKey = cfg.onenatApiKey
  if (cfg.autoRefreshMs) settings.onenat.autoRefreshMs = cfg.autoRefreshMs
  store.updateSettings(settings)

  const log = (msg: string) => {
    if (!cfg.quiet) console.log(`[onenat-workbuddy] ${msg}`)
  }

  const directory = new OnenatDirectory(settings.onenat.baseUrl, settings.onenat.apiKey, log)
  directory.startAutoRefresh(settings.onenat.autoRefreshMs)

  const resolver = new AgentResolver(store, directory)
  const composer = new PromptComposer(directory)
  const planner = new Planner(store, resolver, { webServerPort: cfg.port || 3081 })
  const engine = new TaskEngine(store, directory, resolver, composer, planner)
  const scheduler = new ScheduleRunner(store, engine, log)
  scheduler.start()
  const monitor = new MonitorService(store, directory, resolver, engine, scheduler, sshStore, planner, cfg.dataDir, log)
  monitor.start()
  const auth = new AuthService(cfg.dataDir, cfg.adminUsername, cfg.adminPassword)
  // --token / WORKBUDDY_TOKEN 作为种子：存储为空时写入，此后以设置页「AI APIKEY」为唯一权威
  auth.seedAiToken(cfg.apiToken)

  // 小智平台 MCP 桥接：接入点优先级 命令行/env > 存储设置（存储为空时种子）；语音助手页可随时增删改（免重启）
  const xiaozhi = new XiaozhiMcpClient({
    serverName: 'onenat-workbuddy',
    serverVersion: pkgVersion(),
    getTools: () => tools,
    log,
  })
  {
    const settings = store.getSettings()
    let endpoints = [...(settings.xiaozhi?.endpoints || [])]
    if (!endpoints.length && cfg.xiaozhiMcp) {
      endpoints = [{ id: 'xz-default', endpoint: cfg.xiaozhiMcp, enabled: true }]
      store.updateSettings({ xiaozhi: { endpoints } })
    }
    xiaozhi.configureAll(endpoints)
  }
  const router = new WorkBuddyRouter(store, directory, resolver, composer, planner, engine, sshStore, scheduler, monitor, auth, xiaozhi)

  const { port } = cfg
  const consoleUrl = `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${port}${cfg.prefix || '/'}`
  const tools = createWorkBuddyToolDefs({ store, directory, resolver, composer, engine, sshStore, consoleUrl, monitor, scheduler, planner })
  const toolMap = new Map(tools.map((t) => [t.name, t]))

  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now()
    const url = new URL(req.url || '/', 'http://localhost')
    const method = (req.method || 'GET').toUpperCase()
    res.on('finish', () => {
      if (cfg.quiet || url.pathname === '/healthz' || url.pathname === `${cfg.prefix}/api/auth/login`) return
      console.log(`[onenat-workbuddy] ${method} ${url.pathname}${url.search} → ${res.statusCode} ${Date.now() - startedAt}ms`)
    })

    try {
      // ---------- 健康检查（永远在根路径，无需登录） ----------
      if (url.pathname === '/healthz' || (cfg.prefix && url.pathname === `${cfg.prefix}/healthz`)) {
        sendJson(res, 200, {
          ok: true,
          service: 'onenat-workbuddy-web',
          version: pkgVersion(),
          standalone: true,
          authRequired: true,
          uptimeSec: Math.round(process.uptime()),
          onenat: { configured: directory.configured, baseUrl: directory.endpoint || '', fetchedAt: directory.current()?.fetchedAt || null },
          consoleUrl,
        })
        return
      }

      // ---------- 根路径跳转到控制台（前缀非根时） ----------
      if (cfg.prefix && url.pathname === '/') {
        res.statusCode = 302
        res.setHeader('Location', cfg.prefix + '/')
        res.end()
        return
      }

      const prefix = cfg.prefix
      const underPrefix = prefix ? url.pathname === prefix || url.pathname.startsWith(prefix + '/') : true
      const sessionToken = AuthService.parseCookies(req.headers.cookie)[SESSION_COOKIE]
      const sessionUser = auth.validate(sessionToken)
      const isSecure = url.protocol === 'https:' || String(req.headers['x-forwarded-proto'] || '') === 'https'
      const clientIp = String(req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim()

      // ---------- 登录 / 会话端点（登录本身无需会话） ----------
      if (underPrefix && url.pathname === `${prefix}/api/auth/login` && method === 'POST') {
        if (auth.isRateLimited(clientIp)) {
          sendJson(res, 429, { ok: false, error: '尝试次数过多，请 5 分钟后再试' })
          return
        }
        const body = await readJsonBody(req)
        const username = String(body?.username || '').trim()
        const password = String(body?.password || '')
        const token = auth.login(username, password, clientIp)
        if (!token) {
          await new Promise((r) => setTimeout(r, 400)) // 失败小延迟，增加爆破成本
          sendJson(res, 401, { ok: false, error: '用户名或密码错误' })
          return
        }
        res.setHeader('Set-Cookie', AuthService.serializeSession(token, isSecure))
        sendJson(res, 200, { ok: true, data: { username } })
        return
      }
      if (underPrefix && url.pathname === `${prefix}/api/auth/logout` && method === 'POST') {
        auth.logout(sessionToken)
        res.setHeader('Set-Cookie', AuthService.serializeCleared())
        sendJson(res, 200, { ok: true })
        return
      }
      if (underPrefix && url.pathname === `${prefix}/api/auth/me` && method === 'GET') {
        if (!sessionUser) {
          sendJson(res, 401, { ok: false, error: '未登录', authRequired: true })
          return
        }
        sendJson(res, 200, { ok: true, data: { username: sessionUser } })
        return
      }
      if (underPrefix && url.pathname === `${prefix}/api/auth/password` && method === 'POST') {
        if (!sessionUser) {
          sendJson(res, 401, { ok: false, error: '未登录', authRequired: true })
          return
        }
        const body = await readJsonBody(req)
        const ok = auth.changePassword(sessionUser, String(body?.oldPassword || ''), String(body?.newPassword || ''))
        if (!ok) {
          sendJson(res, 400, { ok: false, error: '旧密码错误或新密码过短（至少 6 位）' })
          return
        }
        res.setHeader('Set-Cookie', AuthService.serializeCleared())
        sendJson(res, 200, { ok: true, message: '密码已更新，请重新登录' })
        return
      }

      // ---------- AI 技能安装资源（公开：脚本与 SKILL 本体不含任何秘密） ----------
      if (underPrefix && method === 'GET' && (url.pathname === `${prefix}/install-skill.sh` || url.pathname === `${prefix}/install/SKILL.md` || url.pathname === `${prefix}/install/wb.mjs`)) {
        const rel = url.pathname === `${prefix}/install-skill.sh` ? 'scripts/install-skill.sh'
          : url.pathname === `${prefix}/install/SKILL.md` ? 'skills/onenat-workbuddy/SKILL.md'
            : 'skills/onenat-workbuddy/scripts/wb.mjs'
        const file = resolveAssetFile(rel)
        if (!file) {
          sendJson(res, 404, { ok: false, error: `安装资源缺失: ${rel}` })
          return
        }
        res.statusCode = 200
        res.setHeader('Content-Type', url.pathname.endsWith('.sh') ? 'text/x-shellscript; charset=utf-8' : url.pathname.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'text/javascript; charset=utf-8')
        res.end(file)
        return
      }

      // ---------- 访问控制：控制台与业务 API 均需登录；AI 令牌可访问开放面（工具通道/监控/定时任务/规划器/文件） ----------
      const aiTokenOk = auth.validateAiToken(extractAiToken(req, url))
      if (underPrefix && !sessionUser && !aiTokenOk) {
        const isConsoleGet = method === 'GET' && (url.pathname === prefix || url.pathname === `${prefix}/` || url.pathname === `${prefix}/console` || url.pathname === `${prefix}/monitor` || url.pathname === `${prefix}/monitor/`)
        if (!isConsoleGet) {
          sendJson(res, 401, { ok: false, error: '未登录或会话已过期', authRequired: true })
          return
        }
        // 未登录访问控制台 / 投屏页 → 登录页
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(renderLoginUi(prefix, undefined, pkgVersion()))
        return
      }
      // 令牌已放行但路径不在 AI 开放面内（如设置、智能体写接口）→ 一律拒绝
      if (!sessionUser && aiTokenOk && !isAiTokenAllowedPath(url.pathname, cfg.prefix)) {
        sendJson(res, 403, { ok: false, error: 'AI 令牌无权访问该接口（仅开放工具通道/监控/定时任务/规划器/文件/资源目录）' })
        return
      }

      // ---------- 工具 HTTP 通道（登录会话或 AI 令牌，门禁已在上方统一完成） ----------
      const toolPath = `${prefix}/api/tools`
      if (url.pathname === toolPath || url.pathname.startsWith(toolPath + '/')) {
        const name = decodeURIComponent(url.pathname.slice(toolPath.length).replace(/^\//, ''))
        if (!name) {
          if (method === 'GET') {
            sendJson(res, 200, {
              ok: true,
              consoleUrl,
              tools: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
            })
            return
          }
          sendJson(res, 405, { ok: false, error: '请用 POST /api/tools/:name 调用工具' })
          return
        }
        const def = toolMap.get(name)
        if (!def) {
          sendJson(res, 404, { ok: false, error: `工具不存在: ${name}`, available: [...toolMap.keys()] })
          return
        }
        const args = method === 'GET' ? Object.fromEntries(url.searchParams.entries()) : await readJsonBody(req)
        try {
          // HTTP 工具通道：调用方（AI 技能 / wb.mjs / 三方系统）可承受长阻塞，按既有语义放行
          const raw = await def.execute(args || {}, HTTP_TOOL_CTX)
          sendJson(res, 200, { ok: true, tool: name, result: tryParse(raw) })
        } catch (err: any) {
          sendJson(res, 500, { ok: false, tool: name, error: err?.message || String(err) })
        }
        return
      }

      // ---------- 业务路由（控制台 + REST + SSE） ----------
      const handled = await router.dispatch(req, res, prefix, { auth: true })
      if (!handled && !res.headersSent) {
        sendJson(res, 404, { ok: false, error: `Endpoint not found: ${req.url}`, consoleUrl })
      }
    } catch (err: any) {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: err?.message || String(err) })
      else res.end()
    }
  })

  return {
    server,
    router,
    tools,
    directory,
    store,
    config: cfg,
    port,
    consoleUrl,
    auth,
    async close() {
      monitor.stop()
      xiaozhi.stop()
      scheduler.stop()
      directory.stopAutoRefresh()
      await new Promise<void>((done) => server.close(() => done()))
    },
  }
}

/** 从请求中提取 AI 令牌：Authorization: Bearer / X-WorkBuddy-Token / ?token= */
function extractAiToken(req: http.IncomingMessage, url: URL): string {
  const authz = String(req.headers.authorization || '')
  if (authz.startsWith('Bearer ')) return authz.slice(7).trim()
  const h = String(req.headers['x-workbuddy-token'] || '').trim()
  if (h) return h
  return String(url.searchParams.get('token') || '').trim()
}

/** AI 令牌可访问的开放面：工具通道 / 监控 / 定时任务 / 规划器 / 远端文件 / 资源目录只读 */
function isAiTokenAllowedPath(pathname: string, prefix: string): boolean {
  const p = prefix && pathname.startsWith(prefix) ? pathname.slice(prefix.length) || '/' : pathname
  if (p === '/api/tools' || p.startsWith('/api/tools/')) return true
  if (p.startsWith('/api/monitor/')) return true
  if (p === '/api/schedules' || p.startsWith('/api/schedules/')) return true
  if (p === '/api/schedule-templates') return true
  if (p.startsWith('/api/planner/')) return true
  if (p.startsWith('/api/agents/fs/')) return true
  if (p === '/api/resources' || p.startsWith('/api/resources/')) return true
  // 任务级文件面：下载成员工作区文件 / 附件上传 / 任务清单与统计（读）；messages 为多轮追问
  if (/^\/api\/tasks\/[^/]+\/(files\/download|attachments|todos|stats|messages)$/.test(p)) return true
  // 任务只读面（状态/详情/流）：AI 令牌跟踪自己派发的任务用
  if (/^\/api\/tasks\/[^/]+$/.test(p)) return true
  if (p === '/api/tasks' ) return true
  return false
}

/** 解析随包资源（SKILL/wb.mjs/install 脚本）：优先 cwd（仓库/挂载目录），回退 dist 上一级 */
function resolveAssetFile(rel: string): string | null {
  const here = fileURLToPath(import.meta.url)
  const candidates = [join(process.cwd(), rel), join(dirname(dirname(here)), rel)]
  for (const c of candidates) {
    try {
      if (existsSync(c)) return readFileSync(c, 'utf-8')
    } catch { /* 尝试下一个 */ }
  }
  return null
}

function readJsonBody(req: http.IncomingMessage, limit = 8 * 1024 * 1024): Promise<any> {
  return new Promise((done) => {
    let body = ''
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        req.destroy()
        done({})
        return
      }
      body += c
    })
    req.on('end', () => {
      try {
        done(body ? JSON.parse(body) : {})
      } catch {
        done({})
      }
    })
    req.on('error', () => done({}))
  })
}

function tryParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(data))
}

// ---------------------------------------------------------------- 启动

export async function start(cfg: StandaloneConfig): Promise<StandaloneApp> {
  const app = createApp(cfg)
  await new Promise<void>((done, fail) => {
    app.server.once('error', fail)
    app.server.listen(cfg.port, cfg.host, () => {
      app.server.removeListener('error', fail)
      const addr = app.server.address()
      if (addr && typeof addr === 'object') app.port = addr.port
      done()
    })
  })
  app.consoleUrl = `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${app.port}${cfg.prefix || '/'}`
  return app
}

async function main(): Promise<void> {
  let cfg: StandaloneConfig
  try {
    const parsed = parseArgs(process.argv.slice(2))
    if ('help' in parsed) {
      process.stdout.write(parsed.help)
      return
    }
    if ('version' in parsed) {
      console.log(pkgVersion())
      return
    }
    cfg = parsed
  } catch (err: any) {
    console.error(`参数错误: ${err?.message || err}\n`)
    process.stdout.write(HELP)
    process.exit(2)
  }

  const log = (msg: string) => {
    if (!cfg.quiet) console.log(`[onenat-workbuddy] ${msg}`)
  }

  const app = await start(cfg)
  console.log('')
  console.log(`  ⚡ OneNat WorkBuddy — 独立部署 WEB 服务（不依赖 DSH）  v${pkgVersion()}`)
  console.log(`  ├─ 控制台      ${app.consoleUrl}`)
  console.log(`  ├─ 监控投屏    ${app.consoleUrl.replace(/\/$/, '')}/monitor`)
  console.log(`  ├─ 健康检查    http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${app.port}/healthz`)
  console.log(`  ├─ 工具通道    ${app.tools.length} 个工具：${app.tools.map((t) => t.name).join(' / ')}`)
  console.log(`  ├─ 数据目录    ${cfg.dataDir}`)
  console.log(`  ├─ ONENAT      ${app.directory.endpoint || '(未配置，可在控制台「设置」页填写)'}`)
  console.log('  ├─ 登录鉴权    已启用（未登录访问控制台/API 将被拦截）')
  console.log(`  ├─ AI APIKEY   ${app.auth.hasAiToken() ? '已配置（设置页可查看/重置；工具通道与 AI 开放面凭 Bearer 令牌访问）' : '未配置 —— 工具通道拒绝一切调用，请登录控制台在「设置」页生成'}`)
  if (cfg.host === '0.0.0.0') console.log('  ⚠️  监听 0.0.0.0：已启用登录鉴权，仍建议置于反代之后并定期更换密码')
  console.log('')

  let closing = false
  const shutdown = async (signal: string) => {
    if (closing) return
    closing = true
    log(`收到 ${signal}，正在关闭…`)
    const timer = setTimeout(() => process.exit(0), 5000)
    timer.unref?.()
    await app.close().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

const isDirectRun = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  const same = (a: string, b: string) => {
    try {
      return realpathSync(a) === realpathSync(b)
    } catch {
      return resolve(a) === resolve(b)
    }
  }
  try {
    // realpath 比较：兼容 npm bin / npx 的符号链接入口（resolve 不跟随链接会误判）
    return same(entry, fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()

if (isDirectRun) {
  main().catch((err) => {
    console.error(`[onenat-workbuddy] 启动失败: ${err?.stack || err}`)
    process.exit(1)
  })
}
