#!/usr/bin/env node
/**
 * 本地稳定性验证驱动 v2（验证重跑 2026-11-07）——只验证，不修改被测代码。
 * v2 修正（v1 三处驱动侧契约错误，均非产品缺陷）：
 *   1. 项目 create 需要 dshRef（v1 传 workspace 字符串 → 400）；
 *      同参重复 create 的正确契约是 200 reused:true（409 仅用于不可见项目的 workspace 冲突）；
 *   2. /api/tasks/:id/messages 只有 POST（发送），无 GET（v1 误用 GET → 404）；
 *   3. ST3 以语义比较（users/invites 数组）替代整文件 sha256，并保留前后原始文件供 diff。
 * 新增：ST4b 客户端/服务端时延差归因（node fetch 全局池 vs 全新 undici Agent vs curl 子进程）。
 *
 * 阶段：
 *   ST0 拉起 mock ONENAT(18085) + dist/server.js(18095, 持久数据目录) —— 记录启动耗时
 *   ST1 只读高频：/healthz ×100 顺序 + 混合读并发 6轮×8
 *   ST2 数据面回环 ×3：项目 create→dup(reused)→delete→recreate(fresh id)；
 *      draft 任务 create→draft→delete；chat 任务 create→rename→model set/get/clear→列表含/删后不含
 *   ST2p 持久化造数：写入 1 个项目 + 2 个任务（供 ST3 重启存活验证）
 *   ST3 异常中断恢复：基线快照 → kill -9 → 重启(同数据目录) → 健康恢复 + 数据/账号持久化比对
 *   ST4 长跑 180s @≈2qps 混合读 + 每 10s 采样 RSS/CPU
 *   ST4b 时延归因：fetch 全局池 / 新 undici Agent / curl 子进程 三方对比 ×20
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const OUT = resolve(dirname(fileURLToPath(import.meta.url)))
const PORT = 18095
const MOCK_PORT = 18085
const PREFIX = '/onenat-workbuddy'
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = process.env.STAB_DATA_DIR || join(OUT, 'stab-data')
const SOAK_MS = Number(process.env.STAB_SOAK_MS || 180000)
const stageResults = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function stage(name, ok, detail = '') {
  stageResults.push({ name, ok, detail })
  console.log(`\n@@STAGE ${name}: ${ok ? 'PASS' : 'FAIL'}${detail ? ` — ${detail}` : ''}`)
}

let COOKIE = ''
async function req(method, path, body, headers = {}) {
  const t0 = Date.now()
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(COOKIE ? { Cookie: COOKIE } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    let json
    try { json = JSON.parse(text) } catch { json = undefined }
    return { status: res.status, text, json, ms: Date.now() - t0 }
  } catch (e) {
    return { status: 0, text: String(e), json: undefined, ms: Date.now() - t0, err: true }
  }
}

async function login() {
  const res = await fetch(BASE + `${PREFIX}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'workbuddy', password: 'workbuddy-admin' }),
  })
  COOKIE = (res.headers.get('set-cookie') || '').split(';')[0]
  return res.status
}

const children = []
function spawnJob(name, cmd, args, env = {}) {
  const stream = createWriteStream(join(OUT, `${name}.log`), { flags: 'a' })
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.pipe(stream)
  child.stderr.pipe(stream)
  children.push({ name, child })
  return child
}

async function waitMockReady(timeoutMs = 15000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/api/v1/resources`, { headers: { Authorization: 'Bearer onk-mock-key-000' } })
      if (r.ok) return true
    } catch { /* retry */ }
    await sleep(100)
  }
  return false
}

async function waitHealthy(timeoutMs = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/healthz`)
      if (r.ok) return Date.now() - t0
    } catch { /* retry */ }
    await sleep(100)
  }
  return -1
}

function authState() {
  const p = join(DATA_DIR, 'auth.json')
  if (!existsSync(p)) return { raw: 'absent', hash: 'absent', users: [], invites: [] }
  const raw = readFileSync(p, 'utf-8')
  let parsed
  try { parsed = JSON.parse(raw) } catch { parsed = {} }
  return {
    raw,
    hash: createHash('sha256').update(raw).digest('hex'),
    users: (parsed.users || []).map((u) => `${u.id}|${u.username}|${u.role}|${u.status}`).sort(),
    invites: (parsed.invites || []).map((i) => `${i.type}|${i.email}|${i.status}`).sort(),
  }
}

async function snapshot() {
  const tasks = await req('GET', `${PREFIX}/api/tasks`)
  const projects = await req('GET', `${PREFIX}/api/projects`)
  const a = authState()
  return {
    taskIds: (tasks.json?.data || []).map((t) => t.id).sort().join(','),
    projIds: (projects.json?.data || []).map((p) => p.id).sort().join(','),
    taskCount: (tasks.json?.data || []).length,
    projCount: (projects.json?.data || []).length,
    auth: a,
  }
}

// ---------- ST0 ----------
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })
console.log(`== 本地稳定性验证 v2 ==\n   数据目录 ${DATA_DIR}\n   服务 ${BASE}${PREFIX}`)

spawnJob('mock-onenat', process.execPath, [join(ROOT, 'scripts', 'mock-onenat.cjs')], { MOCK_ONENAT_PORT: String(MOCK_PORT) })
const mockReady = await waitMockReady()
spawnJob('server', process.execPath, [
  join(ROOT, 'dist', 'server.js'), '--port', String(PORT), '--data', DATA_DIR,
  '--onenat-base-url', `http://127.0.0.1:${MOCK_PORT}`, '--onenat-api-key', 'onk-mock-key-000',
], { WORKBUDDY_ALLOW_PRIVATE_DIRECT: '1' })
const bootMs = await waitHealthy()
const loginStatus = bootMs > 0 ? await login() : 0
stage('ST0 启动', bootMs > 0 && loginStatus === 200 && mockReady, `mock就绪=${mockReady} 首次健康检查耗时=${bootMs}ms login=${loginStatus}`)
console.log(`server1 pid=${children.find((c) => c.name === 'server')?.child.pid}`)

// ---------- ST1 ----------
{
  const lat = []
  let errs = 0
  for (let i = 0; i < 100; i++) {
    const r = await req('GET', '/healthz')
    if (r.err || r.status !== 200) errs++
    lat.push(r.ms)
  }
  lat.sort((a, b) => a - b)
  const avg = Math.round(lat.reduce((a, b) => a + b, 0) / lat.length)
  console.log(`ST1 healthz n=100 ok=${100 - errs} avg=${avg}ms p50=${lat[49]}ms p95=${lat[94]}ms max=${lat[99]}ms err=${errs}`)

  let burstErr = 0
  const burstLat = []
  const paths = [
    `${PREFIX}/api/monitor/overview`, `${PREFIX}/api/tasks`, `${PREFIX}/api/projects`,
    `${PREFIX}/api/resources`, `${PREFIX}/api/schedules`, '/healthz',
  ]
  const t0 = Date.now()
  for (let round = 0; round < 6; round++) {
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => req('GET', paths[i % paths.length])))
    for (const r of rs) { burstLat.push(r.ms); if (r.err || r.status !== 200) burstErr++ }
  }
  const burstTotal = Date.now() - t0
  burstLat.sort((a, b) => a - b)
  const bavg = Math.round(burstLat.reduce((a, b) => a + b, 0) / burstLat.length)
  console.log(`ST1 burst n=48 ok=${48 - burstErr} avg=${bavg}ms max=${burstLat[47]}ms wall=${burstTotal}ms err=${burstErr}`)
  stage('ST1 只读高频', errs === 0 && burstErr === 0, `healthz avg=${avg}ms max=${lat[99]}ms; burst avg=${bavg}ms max=${burstLat[47]}ms`)
}

// ---------- ST2 ----------
{
  let ok = 0, fail = 0
  const line = (c, m) => { if (c) ok++; else { fail++; console.log(`  ✗ ${m}`) } }
  for (let i = 1; i <= 3; i++) {
    // (a) 项目生命周期（契约：POST /api/projects {name, dshRef}；同参重复 create → 200 reused:true）
    const c1 = await req('POST', `${PREFIX}/api/projects`, { name: `stab-cycle-${i}`, dshRef: { kind: 'mapping', mappingId: 'map-dsh-01' } })
    const pid = c1.json?.data?.id
    line(c1.status === 200 && Boolean(pid), `round${i} 项目 create status=${c1.status} id=${pid || 'none'}`)
    const c2 = await req('POST', `${PREFIX}/api/projects`, { name: `stab-cycle-${i}`, dshRef: { kind: 'mapping', mappingId: 'map-dsh-01' } })
    const reused = c2.json?.data?.reused === true && c2.json?.data?.projectId === pid
    line(c2.status === 200 && reused, `round${i} 项目重复 create 期望 200 reused 去重 实际 status=${c2.status} reused=${c2.json?.data?.reused} projectId=${c2.json?.data?.projectId}`)
    const c3 = await req('DELETE', `${PREFIX}/api/projects/${pid}`)
    line([200, 204].includes(c3.status), `round${i} 项目 delete status=${c3.status}`)
    const c4 = await req('POST', `${PREFIX}/api/projects`, { name: `stab-cycle-${i}`, dshRef: { kind: 'mapping', mappingId: 'map-dsh-01' } })
    const freshId = c4.json?.data?.id
    line(c4.status === 200 && Boolean(freshId) && freshId !== pid && !c4.json?.data?.reused, `round${i} 删除后重建应为全新项目 新id=${freshId} 旧id=${pid} reused=${c4.json?.data?.reused}`)
    const c5 = await req('DELETE', `${PREFIX}/api/projects/${freshId}`)
    line([200, 204].includes(c5.status), `round${i} 清理重建项目 status=${c5.status}`)

    // (b) draft 任务生命周期
    const d1 = await req('POST', `${PREFIX}/api/tasks`, { title: `stab-draft-${i}`, mode: 'chat' })
    const did = d1.json?.data?.id
    line(d1.json?.data?.status === 'draft' && Boolean(did), `round${i} draft create status=${d1.json?.data?.status} id=${did || 'none'}`)
    const d2 = await req('DELETE', `${PREFIX}/api/tasks/${did}`)
    line([200, 204].includes(d2.status), `round${i} draft delete status=${d2.status}`)

    // (c) chat 任务数据回环（契约：messages 仅 POST；列表成员关系作读回环）
    const t1 = await req('POST', `${PREFIX}/api/tasks`, { title: `stab-chat-${i}`, mode: 'chat' })
    const tid = t1.json?.data?.id
    line(Boolean(tid), `round${i} chat create id=${tid || 'none'}`)
    const t2 = await req('POST', `${PREFIX}/api/tasks/${tid}/rename`, { title: `stab-chat-${i}-改名` })
    line(t2.status === 200, `round${i} rename status=${t2.status}`)
    const t3 = await req('PUT', `${PREFIX}/api/tasks/${tid}/model`, { model: 'smoke-provider/stab-model' })
    line(t3.status === 200, `round${i} model set status=${t3.status}`)
    const t4 = await req('GET', `${PREFIX}/api/tasks/${tid}`)
    line(t4.json?.data?.model === 'smoke-provider/stab-model' && t4.json?.data?.title === `stab-chat-${i}-改名`, `round${i} 回读 model=${t4.json?.data?.model} title=${t4.json?.data?.title}`)
    const list1 = await req('GET', `${PREFIX}/api/tasks`)
    line((list1.json?.data || []).some((t) => t.id === tid), `round${i} 任务列表包含新任务`)
    const t5 = await req('PUT', `${PREFIX}/api/tasks/${tid}/model`, { model: '' })
    line(t5.status === 200, `round${i} model clear status=${t5.status}`)
    const t7 = await req('DELETE', `${PREFIX}/api/tasks/${tid}`)
    line([200, 204].includes(t7.status), `round${i} delete status=${t7.status}`)
    const list2 = await req('GET', `${PREFIX}/api/tasks`)
    line(!(list2.json?.data || []).some((t) => t.id === tid), `round${i} 删除后列表不含该任务`)
    const t8 = await req('GET', `${PREFIX}/api/tasks/${tid}`)
    line(t8.status === 404, `round${i} 删除后 GET 期望 404 实际 ${t8.status}`)
  }
  stage('ST2 数据面回环×3', fail === 0, `ok=${ok} fail=${fail}`)
}

// ---------- ST2p 持久化造数 ----------
{
  const p1 = await req('POST', `${PREFIX}/api/projects`, { name: 'stab-persist-project', dshRef: { kind: 'mapping', mappingId: 'map-dsh-01' } })
  const t1 = await req('POST', `${PREFIX}/api/tasks`, { title: 'stab-persist-draft', mode: 'chat' })
  const t2 = await req('POST', `${PREFIX}/api/tasks`, { title: 'stab-persist-chat', mode: 'chat', model: 'smoke-provider/persist-model' })
  const ok = p1.status === 200 && t1.json?.data?.status === 'draft' && Boolean(t2.json?.data?.id)
  stage('ST2p 持久化造数', ok, `project=${p1.json?.data?.id} draft=${t1.json?.data?.id} chat=${t2.json?.data?.id}`)
}

// ---------- ST3 ----------
{
  const before = await snapshot()
  writeFileSync(join(OUT, 'st3-auth-before.json'), before.auth.raw === 'absent' ? 'absent' : before.auth.raw)
  const serverChild = children.find((c) => c.name === 'server')?.child
  const t0 = Date.now()
  serverChild.kill('SIGKILL')
  await sleep(300)
  const dead = await req('GET', '/healthz')
  const killedOk = dead.err || dead.status === 0
  spawnJob('server2', process.execPath, [
    join(ROOT, 'dist', 'server.js'), '--port', String(PORT), '--data', DATA_DIR,
    '--onenat-base-url', `http://127.0.0.1:${MOCK_PORT}`, '--onenat-api-key', 'onk-mock-key-000',
  ], { WORKBUDDY_ALLOW_PRIVATE_DIRECT: '1' })
  const recoverMs = await waitHealthy(30000)
  COOKIE = ''
  const relogin = recoverMs > 0 ? await login() : 0
  const after = await snapshot()
  writeFileSync(join(OUT, 'st3-auth-after.json'), after.auth.raw === 'absent' ? 'absent' : after.auth.raw)
  const preserved = before.taskIds === after.taskIds && before.projIds === after.projIds
  const authSem = JSON.stringify(before.auth.users) === JSON.stringify(after.auth.users) && JSON.stringify(before.auth.invites) === JSON.stringify(after.auth.invites)
  const authRaw = before.auth.hash === after.auth.hash
  console.log(`ST3 kill前任务=${before.taskCount} 项目=${before.projCount} → 重启后任务=${after.taskCount} 项目=${after.projCount}`)
  console.log(`ST3 任务/项目清单一致=${preserved} 账号语义一致=${authSem} auth.json 字节一致=${authRaw}`)
  if (!preserved) console.log(`  before tasks=${before.taskIds}\n  after  tasks=${after.taskIds}`)
  if (!authSem) console.log(`  before users=${JSON.stringify(before.auth.users)}\n  after  users=${JSON.stringify(after.auth.users)}`)
  if (!authRaw) {
    const importStr = 'diff st3-auth-before st3-auth-after'
    console.log(`  auth.json 字节有差异（如仅格式/顺序则降级为观察项；账号语义一致=${authSem}）。可用 ${importStr} 复核`)
  }
  stage('ST3 kill -9 中断恢复', killedOk && recoverMs > 0 && preserved && authSem, `kill确认=${killedOk} 恢复耗时=${recoverMs}ms 数据一致=${preserved} 账号语义一致=${authSem} auth字节一致=${authRaw} 重新登录=${relogin} (杀至重启墙钟 ${Date.now() - t0}ms)`)
}

// ---------- ST4 ----------
{
  const serverPid = children.find((c) => c.name === 'server2')?.child.pid
  const samples = []
  let reqs = 0, errs = 0
  const lat = []
  const paths = [
    `${PREFIX}/api/monitor/overview`, `${PREFIX}/api/tasks`, `${PREFIX}/api/projects`,
    `${PREFIX}/api/resources`, `${PREFIX}/api/schedules`, '/healthz',
  ]
  const t0 = Date.now()
  let nextSample = t0
  let i = 0
  while (Date.now() - t0 < SOAK_MS) {
    const r = await req('GET', paths[i++ % paths.length])
    reqs++
    lat.push(r.ms)
    if (r.err || r.status !== 200) errs++
    if (Date.now() >= nextSample) {
      const ps = await new Promise((res) => {
        const p = spawn('ps', ['-o', 'pcpu,rss,etime', '-p', String(serverPid)], { stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        p.stdout.on('data', (d) => (out += d))
        p.on('exit', () => res(out.trim()))
      })
      const row = ps.split('\n')[1]?.trim().replace(/\s+/g, ' ')
      samples.push({ t: Math.round((Date.now() - t0) / 1000), row, avg: Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) })
      console.log(`  [${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s] cpu/rss/etime: ${row} | reqs=${reqs} err=${errs} 累计avg=${Math.round(lat.reduce((a, b) => a + b, 0) / lat.length)}ms`)
      nextSample += 10000
    }
    await sleep(450)
  }
  lat.sort((a, b) => a - b)
  const first = samples[0]?.row.split(' ') || []
  const last = samples[samples.length - 1]?.row.split(' ') || []
  const rssGrowKB = Number(last[1]) - Number(first[1])
  const p95 = lat[Math.floor(lat.length * 0.95)]
  console.log(`ST4 soak ${SOAK_MS / 1000}s reqs=${reqs} err=${errs} avg=${Math.round(lat.reduce((a, b) => a + b, 0) / lat.length)}ms p95=${p95}ms max=${lat[lat.length - 1]}ms samples=${samples.length}`)
  console.log(`ST4 RSS 首采=${first[1]}KB 末采=${last[1]}KB 增长=${rssGrowKB}KB CPU末采=${last[0]}%`)
  const alive = !(await req('GET', '/healthz')).err
  stage('ST4 长跑负载与资源', errs === 0 && alive, `错误率=${errs}/${reqs} RSS增长=${rssGrowKB}KB 进程存活=${alive}`)
  writeFileSync(join(OUT, 'st4-samples.log'), samples.map((s) => `${s.t}s avg=${s.avg}ms ${s.row}`).join('\n') + '\n')
}

// ---------- ST4b 时延归因 ----------
{
  const { request: undiciRequest, Agent } = await import('undici')
  const freshAgent = new Agent()
  const rows = []
  // 三种客户端各 20 次顺序 GET /healthz
  for (let k = 0; k < 20; k++) {
    const t1 = Date.now(); await req('GET', '/healthz'); rows.push(`fetch#${k}=${Date.now() - t1}ms`)
  }
  for (let k = 0; k < 20; k++) {
    const t1 = Date.now()
    await undiciRequest(`${BASE}/healthz`, { dispatcher: freshAgent })
    rows.push(`undici-fresh#${k}=${Date.now() - t1}ms`)
  }
  for (let k = 0; k < 20; k++) {
    const t1 = Date.now()
    const c = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', `${BASE}/healthz`])
    rows.push(`curl#${k}=${Date.now() - t1}ms(${c.stdout.toString()})`)
  }
  const sum = (pre) => rows.filter((r) => r.startsWith(pre)).map((r) => Number(r.match(/=(\d+)ms/)[1]))
  const stat = (arr) => `avg=${Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)}ms max=${Math.max(...arr)}ms`
  console.log(`ST4b fetch全局池: ${stat(sum('fetch#'))}`)
  console.log(`ST4b undici全新Agent: ${stat(sum('undici-fresh#'))}`)
  console.log(`ST4b curl子进程: ${stat(sum('curl#'))}`)
  writeFileSync(join(OUT, 'st4b-latency.log'), rows.join('\n') + '\n')
  stage('ST4b 时延归因', true, `fetch=${stat(sum('fetch#'))} undiciFresh=${stat(sum('undici-fresh#'))} curl=${stat(sum('curl#'))}`)
}

// ---------- 清理持久化造数 ----------
{
  const tasks = await req('GET', `${PREFIX}/api/tasks`)
  for (const t of tasks.json?.data || []) if (String(t.title).startsWith('stab-persist')) await req('DELETE', `${PREFIX}/api/tasks/${t.id}`)
  const projects = await req('GET', `${PREFIX}/api/projects`)
  for (const p of projects.json?.data || []) if (String(p.name).startsWith('stab-persist')) await req('DELETE', `${PREFIX}/api/projects/${p.id}`)
  console.log('\n清理：持久化造数已删除')
}

const failed = stageResults.filter((s) => !s.ok)
console.log(`\n==== 稳定性汇总: ${stageResults.length - failed.length}/${stageResults.length} PASS ====`)
for (const s of stageResults) console.log(`  ${s.ok ? '✅' : '❌'} ${s.name} — ${s.detail}`)
for (const c of children) { try { c.child.kill('SIGKILL') } catch {} }
process.exit(failed.length ? 1 : 0)
