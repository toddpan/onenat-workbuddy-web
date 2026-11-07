#!/usr/bin/env node
/**
 * 本地稳定性验证驱动（验证重跑 2026-11-07）——只验证，不修改被测代码。
 *
 * 阶段：
 *   ST0 拉起 mock ONENAT(18085) + dist/server.js(18095, 持久数据目录) —— 记录启动耗时
 *   ST1 只读高频：/healthz ×100 顺序 + 混合读并发 6轮×8
 *   ST2 数据面回环 ×3：项目 create→409→delete；draft 任务 create→draft→delete；
 *      chat 任务 create→rename→model set/get/clear→messages→delete→404
 *   ST3 异常中断恢复：基线快照 → kill -9 → 重启(同数据目录) → 健康恢复 + 数据持久化比对
 *   ST4 长跑 180s @≈2qps 混合读 + 每 10s 采样 RSS/CPU
 *
 * 每阶段独立打印 STAGE 结果与退出码语义；全脚本退出码非 0 即存在失败阶段。
 */
import { spawn } from 'node:child_process'
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

async function snapshot() {
  const tasks = await req('GET', `${PREFIX}/api/tasks`)
  const projects = await req('GET', `${PREFIX}/api/projects`)
  const authRaw = existsSync(join(DATA_DIR, 'auth.json')) ? createHash('sha256').update(readFileSync(join(DATA_DIR, 'auth.json'))).digest('hex') : 'absent'
  const taskIds = (tasks.json?.data || []).map((t) => t.id).sort().join(',')
  const projIds = (projects.json?.data || []).map((p) => p.id).sort().join(',')
  return { taskIds, projIds, authHash: authRaw, taskCount: (tasks.json?.data || []).length, projCount: (projects.json?.data || []).length }
}

// ---------- ST0 ----------
rmSync(DATA_DIR, { recursive: true, force: true })
mkdirSync(DATA_DIR, { recursive: true })
console.log(`== 本地稳定性验证 ==\n   数据目录 ${DATA_DIR}\n   服务 ${BASE}${PREFIX}`)

spawnJob('mock-onenat', process.execPath, [join(ROOT, 'scripts', 'mock-onenat.cjs')], { MOCK_ONENAT_PORT: String(MOCK_PORT) })
const mockReady = await waitMockReady()
const st0 = Date.now()
spawnJob('server', process.execPath, [
  join(ROOT, 'dist', 'server.js'), '--port', String(PORT), '--data', DATA_DIR,
  '--onenat-base-url', `http://127.0.0.1:${MOCK_PORT}`, '--onenat-api-key', 'onk-mock-key-000',
], { WORKBUDDY_ALLOW_PRIVATE_DIRECT: '1' })
const bootMs = await waitHealthy()
const loginStatus = bootMs > 0 ? await login() : 0
stage('ST0 启动', bootMs > 0 && loginStatus === 200 && mockReady, `mock就绪=${mockReady} 首次健康检查耗时=${bootMs}ms login=${loginStatus}`)
console.log(`server pid=${children.find((c) => c.name === 'server')?.child.pid}`)

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

  const burstLat = []
  let burstErr = 0
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
    // (a) 项目生命周期
    const ws = join(tmpdir(), `wb-stab-ws-${Date.now()}-${i}`)
    mkdirSync(ws, { recursive: true })
    const c1 = await req('POST', `${PREFIX}/api/projects`, { name: `stab-cycle-${i}`, workspace: ws })
    const pid = c1.json?.data?.id
    line([200, 201].includes(c1.status) && Boolean(pid), `round${i} 项目 create status=${c1.status}`)
    const c2 = await req('POST', `${PREFIX}/api/projects`, { name: `stab-cycle-${i}`, workspace: ws })
    line(c2.status === 409, `round${i} 项目重复 create 期望 409 实际 ${c2.status}`)
    const c3 = await req('DELETE', `${PREFIX}/api/projects/${pid}`)
    line([200, 204].includes(c3.status), `round${i} 项目 delete status=${c3.status}`)
    rmSync(ws, { recursive: true, force: true })

    // (b) draft 任务生命周期
    const d1 = await req('POST', `${PREFIX}/api/tasks`, { title: `stab-draft-${i}`, mode: 'chat' })
    const did = d1.json?.data?.id
    line(d1.json?.data?.status === 'draft' && Boolean(did), `round${i} draft create status=${d1.json?.data?.status} id=${did || 'none'}`)
    const d2 = await req('DELETE', `${PREFIX}/api/tasks/${did}`)
    line([200, 204].includes(d2.status), `round${i} draft delete status=${d2.status}`)

    // (c) chat 任务数据回环
    const t1 = await req('POST', `${PREFIX}/api/tasks`, { title: `stab-chat-${i}`, mode: 'chat' })
    const tid = t1.json?.data?.id
    line(Boolean(tid), `round${i} chat create id=${tid || 'none'}`)
    const t2 = await req('POST', `${PREFIX}/api/tasks/${tid}/rename`, { title: `stab-chat-${i}-改名` })
    line(t2.status === 200, `round${i} rename status=${t2.status}`)
    const t3 = await req('PUT', `${PREFIX}/api/tasks/${tid}/model`, { model: 'smoke-provider/stab-model' })
    line(t3.status === 200, `round${i} model set status=${t3.status}`)
    const t4 = await req('GET', `${PREFIX}/api/tasks/${tid}`)
    line(t4.json?.data?.model === 'smoke-provider/stab-model' && t4.json?.data?.title === `stab-chat-${i}-改名`, `round${i} 回读 model=${t4.json?.data?.model} title=${t4.json?.data?.title}`)
    const t5 = await req('PUT', `${PREFIX}/api/tasks/${tid}/model`, { model: '' })
    line(t5.status === 200, `round${i} model clear status=${t5.status}`)
    const t6 = await req('GET', `${PREFIX}/api/tasks/${tid}/messages`)
    line(t6.status === 200, `round${i} messages status=${t6.status}`)
    const t7 = await req('DELETE', `${PREFIX}/api/tasks/${tid}`)
    line([200, 204].includes(t7.status), `round${i} delete status=${t7.status}`)
    const t8 = await req('GET', `${PREFIX}/api/tasks/${tid}`)
    line(t8.status === 404, `round${i} 删除后 GET 期望 404 实际 ${t8.status}`)
  }
  stage('ST2 数据面回环×3', fail === 0, `ok=${ok} fail=${fail}`)
}

// ---------- ST3 ----------
{
  const before = await snapshot()
  const serverChild = children.find((c) => c.name === 'server')?.child
  const t0 = Date.now()
  serverChild.kill('SIGKILL')
  await sleep(300)
  const dead = await req('GET', '/healthz')
  const killedOk = dead.err || dead.status === 0
  const st3a = Date.now()
  spawnJob('server2', process.execPath, [
    join(ROOT, 'dist', 'server.js'), '--port', String(PORT), '--data', DATA_DIR,
    '--onenat-base-url', `http://127.0.0.1:${MOCK_PORT}`, '--onenat-api-key', 'onk-mock-key-000',
  ], { WORKBUDDY_ALLOW_PRIVATE_DIRECT: '1' })
  const recoverMs = await waitHealthy(30000)
  const relogin = recoverMs > 0 ? await login() : 0
  const after = await snapshot()
  const preserved = before.taskIds === after.taskIds && before.projIds === after.projIds
  const authSame = before.authHash === after.authHash
  console.log(`ST3 kill前任务数=${before.taskCount} 项目数=${before.projCount} → 重启后任务数=${after.taskCount} 项目数=${after.projCount}`)
  console.log(`ST3 任务/项目清单一致=${preserved} auth.json sha256 一致=${authSame} 会话复用登录=${relogin}`)
  stage('ST3 kill -9 中断恢复', killedOk && recoverMs > 0 && preserved && authSame, `kill 确认=${killedOk} 恢复耗时=${recoverMs}ms 数据一致=${preserved} auth一致=${authSame} (杀至重启墙钟 ${Date.now() - t0}ms)`)
  // 保留 server2 作为 ST4 被测进程
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
      samples.push({ t: Math.round((Date.now() - t0) / 1000), row })
      console.log(`  [${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s] cpu/rss/etime: ${row} | reqs=${reqs} err=${errs} avg=${Math.round(lat.reduce((a, b) => a + b, 0) / lat.length)}ms`)
      nextSample += 10000
    }
    await sleep(450) // ≈2 qps
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
  writeFileSync(join(OUT, 'st4-samples.log'), samples.map((s) => `${s.t}s ${s.row}`).join('\n') + '\n')
}

const failed = stageResults.filter((s) => !s.ok)
console.log(`\n==== 稳定性汇总: ${stageResults.length - failed.length}/${stageResults.length} PASS ====`)
for (const s of stageResults) console.log(`  ${s.ok ? '✅' : '❌'} ${s.name} — ${s.detail}`)
for (const c of children) { try { c.child.kill('SIGKILL') } catch {} }
process.exit(failed.length ? 1 : 0)
