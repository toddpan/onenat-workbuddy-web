/**
 * onenat-workbuddy-web - ONENAT 资源目录与解析器
 *
 * 唯一实时数据源: GET /api/v1/resources（+ /api/v1/apps 交叉补充）
 * 解析规则对齐 onenat.md（实测语义）:
 *  - online=false 或缺 public_url ⇒ 不可达，不缓存旧端口
 *  - tcp 隧道承载 HTTP（local 指向 web 端口或绑定 http-api 应用）⇒ 合成 baseUrl
 *  - DSH 实体识别: app.type === 'http-api' 且技能清单含 dsh-web-service（双重校验防绑错）
 *  - 公网端口动态: 每次派发前强刷新，绝不变异缓存 URL（D1）
 */

import type {
  DshEngineInfo,
  OnenatApp,
  OnenatCredentials,
  OnenatTunnel,
  ResolvedEndpoint,
  ResourceSnapshot,
} from './types.js'

const WEB_PORT_MIN = 3000
const WEB_PORT_MAX = 9999

export function cleanBaseUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

function parsePublicUrl(publicUrl: string | undefined): { proto: 'tcp' | 'http'; host: string; port?: number } | undefined {
  if (!publicUrl) return undefined
  const m = /^(tcp|http):\/\/([^:/]+)(?::(\d+))?/.exec(publicUrl.trim())
  if (!m) return undefined
  return {
    proto: m[1] === 'http' ? 'http' : 'tcp',
    host: m[2],
    port: m[3] ? Number(m[3]) : undefined,
  }
}

function looksLikeWebPort(local: string): boolean {
  const m = /:(\d+)$/.exec(local.trim())
  if (!m) return false
  const port = Number(m[1])
  return port >= WEB_PORT_MIN && port <= WEB_PORT_MAX
}

function classifyKind(app: OnenatApp | undefined, local: string, proto: 'tcp' | 'http'): ResolvedEndpoint['kind'] {
  const type = (app?.type || '').toLowerCase()
  if (type === 'ssh' || /:(\d+)$/.exec(local)?.[1] === '22') return 'ssh'
  if (type === 'http-api' && app?.skills?.some((s) => /dsh/i.test(s.name))) return 'dsh'
  if (type === 'http-api' || proto === 'http' || looksLikeWebPort(local)) return 'http'
  return 'tcp'
}

export class OnenatDirectory {
  private snapshot: ResourceSnapshot | undefined
  private refreshPromise: Promise<ResourceSnapshot> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private credCache = new Map<string, { at: number; data: OnenatCredentials }>()
  /**
   * 凭证缓存 TTL。**必须短**：映射实例凭证在 OneNat 后台改完后，本进程缓存最多
   * 只会阻碍这么久（旧实现 10 分钟 ⇒ "设了独立凭证，注入的还是应用默认/旧密码"）。
   * 同时它也是 OneNat 侧 5 次/分限速的保护：TTL 内同映射最多取 1 次。
   * 10 分钟 TTL：凭证轮换的即时性由 401 自愈的 force 强拉保证（绕过 TTL），
   * 平时限速 5 次/分是主要矛盾——TTL 越短越容易打出 429。
   */
  private static CRED_TTL = 10 * 60 * 1000
  /** 失败（403/429）负缓存 TTL：只用来挡连环触发，绝不当成功凭证用 */
  private static CRED_NEG_TTL = 15 * 1000
  /** 最近一次成功凭证（mappingId → data）：限速/网络失败时回落，绝不因 429 把 key 弄丢 */
  private credLastGood = new Map<string, OnenatCredentials>()

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private log: (msg: string) => void = () => {},
  ) {}

  public configure(baseUrl: string, apiKey: string): void {
    this.baseUrl = cleanBaseUrl(baseUrl || '')
    this.apiKey = apiKey || ''
    this.snapshot = undefined
    this.credCache.clear()
  }

  /**
   * 让某映射（或全部）的凭证缓存立即失效。
   * 调用时机：OneNat 侧改过实例凭证后、以及需要"派发必取最新值"的场合。
   */
  public invalidateCredential(mappingId?: string): void {
    if (mappingId) this.credCache.delete(mappingId)
    else this.credCache.clear()
  }

  public get configured(): boolean {
    return Boolean(this.baseUrl && this.apiKey)
  }

  public get endpoint(): string {
    return cleanBaseUrl(this.baseUrl)
  }

  /** 平台 API Key（提示词 [平台接入] 段用；self-fetch 凭证策略需要） */
  public get key(): string {
    return this.apiKey
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      ...extra,
    }
  }

  /** 拉取实时资源快照（并发去重；force 时丢弃缓存） */
  public async refresh(force = false): Promise<ResourceSnapshot> {
    if (!this.configured) throw new Error('ONENAT 未配置（baseUrl / apiKey 缺失）')
    if (!force && this.snapshot && Date.now() - this.snapshot.fetchedAt < 15_000) {
      return this.snapshot
    }
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = this.doFetch()
      .then((snap) => {
        this.snapshot = snap
        return snap
      })
      .finally(() => {
        this.refreshPromise = undefined
      })
    return this.refreshPromise
  }

  private async doFetch(): Promise<ResourceSnapshot> {
    const res = await fetch(`${this.baseUrl}/api/v1/resources`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(12_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`ONENAT /api/v1/resources HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    const json: any = await res.json()
    const tunnels: OnenatTunnel[] = Array.isArray(json?.tunnels) ? json.tunnels : []
    const snap: ResourceSnapshot = { fetchedAt: Date.now(), baseUrl: this.baseUrl, tunnels }
    this.detectMappingDrift(snap)
    return snap
  }

  public current(): ResourceSnapshot | undefined {
    return this.snapshot
  }

  /** 解析单个映射为当下公网入口；不可达时返回 online=false 的结果（不抛错，由调用方决定跳过） */
  public resolveMapping(mappingId: string): ResolvedEndpoint | undefined {
    const snap = this.snapshot
    if (!snap) return undefined
    for (const t of snap.tunnels) {
      for (const m of t.mappings || []) {
        if (m.id !== mappingId) continue
        return this.buildEndpoint(t, m, snap.fetchedAt)
      }
    }
    return undefined
  }

  /** 按应用 ID 反查绑定它的映射（取第一条可达的） */
  public resolveApp(appId: string): ResolvedEndpoint | undefined {
    const snap = this.snapshot
    if (!snap) return undefined
    let fallback: ResolvedEndpoint | undefined
    for (const t of snap.tunnels) {
      for (const m of t.mappings || []) {
        if (m.app?.id !== appId) continue
        const ep = this.buildEndpoint(t, m, snap.fetchedAt)
        if (ep.online) return ep
        fallback ??= ep
      }
    }
    return fallback
  }

  private buildEndpoint(t: OnenatTunnel, m: any, at: number): ResolvedEndpoint {
    const parsed = parsePublicUrl(m.public_url)
    const app: OnenatApp | undefined = m.app
    const online = Boolean(t.online && parsed)
    const kind = classifyKind(app, String(m.local ?? ''), m.proto === 'http' ? 'http' : 'tcp')
    const rawAppName = app?.name || m.note || ''
    // 自动为同名或泛称资源（如 "SSH Server"、"DSH"）打上隧道环境前缀，确保全系统资源名唯一直观
    let uniqueName = rawAppName
    if (t.name) {
      if (!uniqueName) {
        uniqueName = `${t.name}-${kind.toUpperCase()}`
      } else if (uniqueName === 'SSH Server' || uniqueName === 'SSH' || uniqueName === 'DSH' || uniqueName === 'HTTP API') {
        uniqueName = `${t.name}-${uniqueName}`
      }
    }
    // 同一隧道下同 kind 映射 ≥2 条时（典型：一台机器并存 DSH 引擎与 ZCode 引擎两个 web service），
    // 泛称唯一名会撞名、用户无法辨识选的是哪个引擎 → 追加本地端口后缀。
    // 用本地端口而非公网端口：natpass 公网端口天天漂，本地端口语义稳定（"这台机器的哪个服务"）。
    const localPort = Number(/:(\d+)$/.exec(String(m.local ?? '').trim())?.[1] ?? 0) || undefined
    if ((kind === 'dsh' || kind === 'http') && this.sameKindSiblingCount(t, kind) > 1) {
      const suffix = String(localPort || parsed?.port || '')
      if (suffix) uniqueName = `${uniqueName}:${suffix}`
    }

    const ep: ResolvedEndpoint = {
      mappingId: m.id,
      appId: app?.id,
      tunnelId: t.id,
      tunnelName: t.name,
      note: m.note,
      online,
      proto: m.proto === 'http' ? 'http' : 'tcp',
      host: parsed?.host || '',
      port: parsed?.port,
      local: String(m.local ?? ''),
      localPort,
      kind,
      // 平台已给出"是否实例级覆盖"标志：接住它，合成时才能区分
      // 实例独立凭证(mapping) 与 继承应用默认(app)；字段缺失时保持 undefined(未知)
      authOverride: m.auth_override === undefined ? undefined : Boolean(m.auth_override),
      appName: uniqueName || rawAppName || `${t.name || 'node'}-${kind}`,
      appType: app?.type,
      appSkills: app?.skills,
      resolvedAt: at,
    }
    if (online && parsed) {
      const portPart = `:${parsed.port ?? (ep.local ? Number(/:(\d+)$/.exec(ep.local)?.[1] ?? 80) : 80)}`
      if (m.proto === 'http') {
        ep.baseUrl = `http://${parsed.host}${parsed.port ? `:${parsed.port}` : ''}`
      } else if (kind === 'dsh' || kind === 'http' || (app?.type === 'http-api') || looksLikeWebPort(ep.local)) {
        // DSH 实体: dsh-web-service 约定 Base URL 含 /api/v1 路径（技能文件同口径）
        ep.baseUrl = kind === 'dsh' ? `http://${parsed.host}${portPart}/api/v1` : `http://${parsed.host}${portPart}`
      }
    }
    return ep
  }

  /** DSH 型映射速览（供 UI 下拉与自动发现） */
  public listDshEndpoints(): ResolvedEndpoint[] {
    const snap = this.snapshot
    if (!snap) return []
    const out: ResolvedEndpoint[] = []
    for (const t of snap.tunnels) {
      for (const m of t.mappings || []) {
        const ep = this.buildEndpoint(t, m, snap.fetchedAt)
        if (ep.kind === 'dsh') out.push(ep)
      }
    }
    return out
  }

  /** 隧道内同 kind 映射条数（唯一名撞名判定用） */
  private sameKindSiblingCount(t: OnenatTunnel, kind: ResolvedEndpoint['kind']): number {
    let n = 0
    for (const m of t.mappings || []) {
      if (classifyKind(m.app, String(m.local ?? ''), m.proto === 'http' ? 'http' : 'tcp') === kind) n++
    }
    return n
  }

  // ---------- 引擎探测（DshEngineInfo） ----------
  // 一条隧道可并存多个 DSH 兼容引擎（DSH / ZCode headless），平台元数据区分不了；
  // 主动探测 /system/status + /models 拿到引擎身份、健康态与模型目录（模型按钮按节点联动的数据源）。

  private engineCache = new Map<string, DshEngineInfo>()
  private engineInflight = new Map<string, Promise<DshEngineInfo>>()
  /** 探测档案 TTL：节点下拉打开时按需刷新，平时不主动打节点 */
  private static ENGINE_TTL = 90_000
  /**
   * 平台凭证接口限速退避：凭证 429 后全局暂停探测（生产流量与探测共用同一 5 次/分预算，
   * 不退避的 warmup 会跟派发流量互相挤兑）。退避期内探测返回「健康未知」而非再打凭证接口。
   */
  private credLimitedUntil = 0
  private static CRED_LIMIT_BACKOFF = 5 * 60_000

  public engineInfoOf(mappingId: string): DshEngineInfo | undefined {
    return this.engineCache.get(mappingId)
  }

  /** 把所有 kind=dsh 映射标记为待重探（下次 probe 生效） */
  public invalidateEngineInfo(): void {
    this.engineCache.clear()
  }

  /** 探测单个 DSH 端点（并发去重 + TTL 缓存；失败也缓存，避免下拉每次打开都打一遍死节点） */
  public async probeEngine(ep: ResolvedEndpoint, opts?: { force?: boolean }): Promise<DshEngineInfo> {
    const cached = this.engineCache.get(ep.mappingId)
    if (!opts?.force && cached && Date.now() - cached.probedAt < OnenatDirectory.ENGINE_TTL) return cached
    const inflight = this.engineInflight.get(ep.mappingId)
    if (inflight) return inflight
    const p = this.doProbeEngine(ep).finally(() => this.engineInflight.delete(ep.mappingId))
    this.engineInflight.set(ep.mappingId, p)
    return p
  }

  private async doProbeEngine(ep: ResolvedEndpoint): Promise<DshEngineInfo> {
    const base: DshEngineInfo = { engine: 'unknown', reachable: false, probedAt: Date.now() }
    const fail = (error: string): DshEngineInfo => {
      const info: DshEngineInfo = { ...base, error }
      this.engineCache.set(ep.mappingId, info)
      return info
    }
    if (!ep.online || !ep.baseUrl) return fail('映射离线或公网入口未合成')
    if (Date.now() < this.credLimitedUntil) {
      return fail(`平台凭证接口限速退避中（${Math.ceil((this.credLimitedUntil - Date.now()) / 1000)}s 后自动恢复），节点健康未知`)
    }
    const root = cleanBaseUrl(ep.baseUrl)
    const call = async (apiKey?: string, path = 'system/status'): Promise<{ res: Response; json: any }> => {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`
      const res = await fetch(`${root}/${path}`, { headers, signal: AbortSignal.timeout(6_000) })
      const json: any = await res.json().catch(() => ({}))
      return { res, json }
    }
    const callOk = async (apiKey?: string): Promise<any> => {
      const r = await call(apiKey)
      if (!r.res.ok || r.json?.ok !== true) throw new Error(r.json?.error || `HTTP ${r.res.status}`)
      return r.json
    }
    // 凭证：映射实例凭证优先（走限速保护的缓存）。
    // 平台凭证接口限速 5 次/分：拿不到凭证时只做一次无 key 探测（兼容免鉴权节点），
    // 节点若 401 如实上报「凭证获取失败」并停止 —— 此时 force 重取大概率还是 429，
    // 重试只会每节点再烧一次限速预算（实测会把整轮探测拖进连环 429）。
    let cred = await this.fetchMappingCredentials(ep.mappingId)
    if (!cred.ok && /429|频繁/i.test(String(cred.error || ''))) {
      this.credLimitedUntil = Date.now() + OnenatDirectory.CRED_LIMIT_BACKOFF
    }
    let statusJson: any
    try {
      statusJson = await callOk(cred.ok ? cred.apiKey || cred.token : undefined)
    } catch (err: any) {
      const unauthorized = /401|unauthorized/i.test(String(err?.message || ''))
      if (unauthorized && !cred.ok) return fail(`凭证获取失败（${cred.error || '未知'}），节点要求鉴权，稍后重试`)
      if (unauthorized) {
        cred = await this.fetchMappingCredentials(ep.mappingId, true)
        if (!cred.ok) return fail(`凭证获取失败（${cred.error || '未知'}），节点要求鉴权，稍后重试`)
        try {
          statusJson = await callOk(cred.apiKey || cred.token)
        } catch (err2: any) {
          return fail(err2?.message || '探测失败')
        }
      } else {
        return fail(err?.message || '探测失败')
      }
    }
    const data = statusJson?.data || {}
    const svcName = String(data.name || '')
    const engine: DshEngineInfo['engine'] = /zcode/i.test(svcName) ? 'zcode' : /dsh|harness/i.test(svcName) ? 'dsh' : 'unknown'
    const info: DshEngineInfo = {
      engine,
      name: svcName || undefined,
      version: data.version || undefined,
      reachable: true,
      probedAt: Date.now(),
    }
    // 模型目录（默认模型 + 摘要）：失败不影响可达判定 —— 活着但模型目录拿不到也是有用信息
    try {
      const cred = this.credLastGood.get(ep.mappingId) || this.credCache.get(ep.mappingId)?.data
      const key = cred?.ok ? cred.apiKey || cred.token : undefined
      const r = await call(key, 'models')
      if (r.res.ok && r.json?.ok) {
        const dm = r.json.data?.defaultModel
        if (dm && typeof dm === 'object' && dm.provider && dm.model) {
          info.defaultModel = `${dm.provider}/${dm.model}`
          if (dm.reasoningEffort) info.defaultReasoningEffort = String(dm.reasoningEffort)
        } else if (typeof dm === 'string' && dm) info.defaultModel = dm
        info.models = (Array.isArray(r.json.data?.models) ? r.json.data.models : [])
          .slice(0, 80)
          .map((m: any) => ({ provider: String(m.provider || ''), id: String(m.id || ''), name: m.name || undefined, isDefault: Boolean(m.isDefault) }))
      }
    } catch {
      /* 模型目录失败不影响节点可达判定 */
    }
    this.engineCache.set(ep.mappingId, info)
    return info
  }

  /** 探测全部 DSH 映射（并发；force 绕过 TTL） */
  public async probeAllDsh(opts?: { force?: boolean }): Promise<void> {
    const eps = this.listDshEndpoints()
    await Promise.allSettled(eps.map((ep) => this.probeEngine(ep, opts)))
  }

  // ---------- 映射漂移检测（natpass 重注册后 mappingId 变化） ----------
  // 稳定键 = tunnelId + local（本地端口）：natpass 语义里「哪台机器的哪个本地服务」不随重注册变。
  // 检测到 旧id 消失 且 稳定键命中新映射 时回调 onMappingDrift，由 server 接线改写 store 存量引用。

  public onMappingDrift?: (pairs: Array<{ from: string; to: string; tunnelName?: string; local?: string }>) => void

  private detectMappingDrift(next: ResourceSnapshot): void {
    const prev = this.snapshot
    if (!prev) return
    const keyOf = (t: OnenatTunnel, m: any): string => `${t.id}|${String(m.local ?? '').trim()}`
    const nextIds = new Set<string>()
    const nextByKey = new Map<string, { id: string; tunnel: OnenatTunnel; local: string }>()
    for (const t of next.tunnels) {
      for (const m of t.mappings || []) {
        nextIds.add(m.id)
        nextByKey.set(keyOf(t, m), { id: m.id, tunnel: t, local: String(m.local ?? '') })
      }
    }
    const pairs: Array<{ from: string; to: string; tunnelName?: string; local?: string }> = []
    const seenKey = new Set<string>()
    for (const t of prev.tunnels) {
      for (const m of t.mappings || []) {
        if (nextIds.has(m.id)) continue // 旧 id 仍在线，无漂移
        const k = keyOf(t, m)
        if (seenKey.has(k)) continue // 同稳定键多条旧映射（历史重复登记），只迁一次
        const hit = nextByKey.get(k)
        if (!hit || hit.id === m.id) continue // 服务下线 / 稳定键命中自身（非漂移），交给既有报错路径
        seenKey.add(k)
        pairs.push({ from: m.id, to: hit.id, tunnelName: t.name, local: hit.local })
        // 引擎档案跟着身份走：置为临期，下次探测刷新（本地服务没换，引擎不会变）
        const oldInfo = this.engineCache.get(m.id)
        if (oldInfo) this.engineCache.set(hit.id, { ...oldInfo, probedAt: 0 })
      }
    }
    if (pairs.length) {
      for (const p of pairs) {
        this.credCache.delete(p.from)
        this.credLastGood.delete(p.from)
      }
      this.log(`[onenat] 检测到映射漂移 ${pairs.length} 条: ${pairs.map((p) => `${p.from}→${p.to}（${p.tunnelName || ''} ${p.local}）`).join(', ')}`)
      this.onMappingDrift?.(pairs)
    }
  }

  /** 全量资源清单（供资源目录页展示） */
  public listEndpoints(): ResolvedEndpoint[] {
    const snap = this.snapshot
    if (!snap) return []
    const out: ResolvedEndpoint[] = []
    for (const t of snap.tunnels) {
      for (const m of t.mappings || []) {
        out.push(this.buildEndpoint(t, m, snap.fetchedAt))
      }
    }
    return out
  }

  /** 下载应用技能文件全文（url 已自带 key） */
  /**
   * 读取映射实例的有效凭证（映射覆盖优先，回退应用默认）。
   * ONENAT 侧限速 5 次/分 ⇒ 本地缓存，但**成功值与失败值分开计时**：
   * 成功值 30s（保证刚改完凭证就派发也能取到新值），403/429 等失败 15s；
   * 失败值永远不会被当成可用凭证。
   * 返回值带 resolvedFrom（mapping=实例独立 / app=继承应用默认）与 fetchedAt。
   */
  public async fetchMappingCredentials(mappingId: string, force = false): Promise<OnenatCredentials> {
    const cached = this.credCache.get(mappingId)
    const ttl = cached?.data.ok ? OnenatDirectory.CRED_TTL : OnenatDirectory.CRED_NEG_TTL
    if (!force && cached && Date.now() - cached.at < ttl) return cached.data
    // ONENAT 凭证接口限速极严（5 次/分），429 时退避重试一次再放弃
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 2000))
        const res = await fetch(`${this.baseUrl}/api/v1/mappings/${encodeURIComponent(mappingId)}/credentials`, {
          headers: this.headers(),
          signal: AbortSignal.timeout(10_000),
        })
        const json: any = await res.json().catch(() => ({}))
        if (!res.ok) {
          const data: OnenatCredentials = { ok: false, error: json?.error || `HTTP ${res.status}`, fetchedAt: Date.now() }
          // 403/429 属策略性失败：只做短负缓存，避免连环触发限速
          if (res.status === 403 || res.status === 429) this.credCache.set(mappingId, { at: Date.now(), data })
          if (res.status === 429 && attempt === 0) continue
          // 限速/策略失败时回落最近一次成功凭证：key 本来就好，绝不能因为拿不到凭证而 401
          return this.credLastGood.get(mappingId) || data
        }
        const data: OnenatCredentials = {
          ok: true,
          authType: json?.auth_type || json?.authType,
          username: json?.username,
          password: json?.password,
          apiKey: json?.api_key || json?.apiKey,
          token: json?.token,
          resolvedFrom: json?.resolved_from || json?.resolvedFrom,
          fetchedAt: Date.now(),
        }
        this.credCache.set(mappingId, { at: Date.now(), data })
        this.credLastGood.set(mappingId, data)
        return data
      } catch (err: any) {
        if (attempt > 0) {
          return this.credLastGood.get(mappingId) || { ok: false, error: err?.message || '凭证读取失败', fetchedAt: Date.now() }
        }
      }
    }
    return this.credLastGood.get(mappingId) || { ok: false, error: '凭证读取失败', fetchedAt: Date.now() }
  }

  /** 对 DSH 端点探活：GET /system/status */
  public static async pingDsh(baseUrl: string, apiKey?: string): Promise<{ ok: boolean; name?: string; version?: string; providers?: string[]; error?: string }> {
    try {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`
      const res = await fetch(`${cleanBaseUrl(baseUrl)}/system/status`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      })
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` }
      return { ok: true, name: json.data?.name, version: json.data?.version, providers: json.data?.providers || [] }
    } catch (err: any) {
      return { ok: false, error: err?.message || '连接失败' }
    }
  }

  /** 启动周期刷新（60s 级；派发前另有强刷新） */
  public startAutoRefresh(intervalMs: number): void {
    this.stopAutoRefresh()
    const ms = Math.max(15_000, intervalMs || 60_000)
    this.timer = setInterval(() => {
      this.refresh(true).catch((err) => {
        this.log(`[onenat] 自动刷新失败: ${err?.message || err}`)
      })
    }, ms)
    this.refresh(true).catch(() => {})
  }

  public stopAutoRefresh(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }
}
