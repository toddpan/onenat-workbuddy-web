#!/usr/bin/env node
/**
 * 运行权限（permission）端到端验证：
 *   node scripts/permission-e2e.mjs
 *
 * 链路：本脚本内起一个 stub DSH 节点（记录 prompt-stream 实际收到的提示词）
 *   → 拉起 dist/server.js（临时数据目录，直连实体不依赖 ONENAT）
 *   → 1) 智能体实体带 permission='danger-full-access' 创建，回读断言
 *   → 2) 任务级 PUT /api/tasks/:id/permission 设 'workspace-write'，发消息，
 *       断言远端收到的提示词含「[运行权限]: workspace-write」（任务级优先于实体默认）
 *   → 3) 清除任务级权限再发一条消息，断言回落到实体默认 'danger-full-access'
 * 退出码非 0 即失败。
 *
 * 注：stub 每轮只回一个 delta，会触发引擎「空结果自愈重发一次」，属正常现象；
 *     断言一律按「提示词包含对应消息文本」检索，不按到达序号。
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PERM_E2E_PORT || 18093)
const STUB_PORT = Number(process.env.PERM_E2E_STUB_PORT || 18099)
const PREFIX = '/onenat-workbuddy'
const BASE = `http://127.0.0.1:${PORT}`

let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  if (!ok) failures++
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(cond, label, timeoutMs = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try { if (await cond()) return } catch { /* retry */ }
    await sleep(300)
  }
  throw new Error(`等待超时: ${label}`)
}

// ---------- stub DSH 节点：记录收到的提示词与原生权限调用 ----------
const receivedPrompts = []
const permissionCalls = []
let stubSupportsPermission = true // false = 模拟旧版 dsh-web-service（无 /permission 路由）
const stub = createServer((req, res) => {
  const url = req.url || ''
  let body = ''
  req.on('data', (c) => { body += c })
  req.on('end', () => {
    if (req.method === 'PUT' && url === '/api/v1/sessions/stub-s1/permission' && stubSupportsPermission) {
      const preset = (() => { try { return JSON.parse(body)?.preset } catch { return undefined } })()
      permissionCalls.push(preset)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, data: { sessionId: 'stub-s1', preset, sandbox: preset, approval: preset === 'danger-full-access' ? 'never' : 'ask' } }))
      return
    }
    if (req.method === 'POST' && url === '/api/v1/sessions') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, data: { sessionId: 'stub-s1' } }))
      return
    }
    if (req.method === 'GET' && url === '/api/v1/sessions/stub-s1') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, data: { sessionId: 'stub-s1', cwd: '/tmp' } }))
      return
    }
    if (req.method === 'POST' && url === '/api/v1/sessions/stub-s1/prompt-stream') {
      try { receivedPrompts.push(JSON.parse(body)?.prompt || '') } catch { receivedPrompts.push(body) }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('event: delta\ndata: {"delta":"ok"}\n\n')
      res.write('event: turn_end\ndata: {}\n\n')
      res.write('event: done\ndata: {}\n\n')
      res.end()
      return
    }
    // 其余（todos/stats 等）按「旧版不支持」处理，调用方自动降级
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'not supported by stub' }))
  })
})

const procs = []
function cleanup() {
  try { stub.close() } catch { /* ignore */ }
  for (const p of procs) { try { p.kill('SIGKILL') } catch { /* ignore */ } }
}
process.on('exit', cleanup)
process.on('SIGINT', () => process.exit(1))

let COOKIE = ''
async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(COOKIE ? { Cookie: COOKIE } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json; try { json = JSON.parse(text) } catch { json = undefined }
  return { status: res.status, json }
}

async function main() {
  if (!existsSync(join(ROOT, 'dist', 'server.js'))) {
    console.error('缺少 dist/server.js —— 先执行: bash scripts/build-standalone.sh')
    process.exit(1)
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'workbuddy-perm-e2e-'))
  console.log(`\n== 运行权限 E2E ==\n   数据目录 ${dataDir}\n   服务 ${BASE}${PREFIX}\n`)

  await new Promise((r) => stub.listen(STUB_PORT, '127.0.0.1', r))
  const server = spawn(process.execPath, [
    join(ROOT, 'dist', 'server.js'),
    '--port', String(PORT),
    '--data', dataDir,
    '--quiet',
  ], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] })
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`))
  procs.push(server)
  await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok, 'standalone server 就绪')

  // 登录
  const loginRes = await fetch(`${BASE}${PREFIX}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'workbuddy', password: 'ThunderSoft@88' }),
  })
  COOKIE = (loginRes.headers.get('set-cookie') || '').split(';')[0]
  check('管理员登录成功', loginRes.ok && COOKIE.startsWith('wb_session='))

  // 1) 智能体实体 permission 持久化
  const agentRes = await req('POST', `${PREFIX}/api/agents`, {
    name: 'perm-e2e',
    dshRef: { kind: 'direct', apiBaseUrl: `http://127.0.0.1:${STUB_PORT}/api/v1` },
    apiKey: 'stub-key',
    permission: 'danger-full-access',
  })
  const agent = agentRes.json?.data
  check('创建带运行权限的子智能体', agentRes.status === 200 || agentRes.status === 201, JSON.stringify(agentRes.json || {}).slice(0, 120))
  check('实体 permission 持久化 = danger-full-access', agent?.permission === 'danger-full-access', `got=${agent?.permission}`)
  const agentId = agent?.id
  const readBack = await req('GET', `${PREFIX}/api/agents/${agentId}`)
  check('实体读取回含 permission', readBack.json?.data?.permission === 'danger-full-access', `got=${readBack.json?.data?.permission}`)

  // 2) 任务级权限覆盖
  const taskRes = await req('POST', `${PREFIX}/api/tasks`, { title: 'perm e2e', mode: 'chat', memberAgentIds: [agentId] })
  const taskId = taskRes.json?.data?.id
  check('创建测试任务', Boolean(taskId), `status=${taskRes.status}`)
  const setPerm = await req('PUT', `${PREFIX}/api/tasks/${taskId}/permission`, { permission: 'workspace-write' })
  check('PUT 任务级权限接口生效', setPerm.json?.data?.permission === 'workspace-write', `got=${setPerm.json?.data?.permission}`)
  const detail = await req('GET', `${PREFIX}/api/tasks/${taskId}`)
  check('任务详情返回 permission 字段', detail.json?.data?.permission === 'workspace-write', `got=${detail.json?.data?.permission}`)

  const msg1 = await req('POST', `${PREFIX}/api/tasks/${taskId}/messages`, { message: '你好，报告当前权限' })
  check('发送消息被受理', msg1.status === 202 || msg1.status === 200, `status=${msg1.status}`)
  await waitFor(() => receivedPrompts.some((p) => p.includes('你好，报告当前权限')), '第一条派发提示词到达 stub 节点')
  const p1 = receivedPrompts.find((p) => p.includes('你好，报告当前权限'))
  check('建会话后经原生接口下发任务级 workspace-write', permissionCalls[0] === 'workspace-write', `calls=${JSON.stringify(permissionCalls)}`)
  check('原生已生效：提示词不再注入「[运行权限]」', !p1.includes('[运行权限]'))

  // 3) 清除任务级 → 回落实体默认，并立即推送到已存在会话
  await sleep(1200) // 等第一轮完全收尾
  const clearRes = await req('PUT', `${PREFIX}/api/tasks/${taskId}/permission`, { permission: '' })
  const cleared = (await req('GET', `${PREFIX}/api/tasks/${taskId}`)).json?.data?.permission
  check('清除任务级权限（空串）', cleared === undefined || cleared === '', `got=${JSON.stringify(cleared)}`)
  check('清除后立即原生切回实体默认 danger-full-access', permissionCalls.at(-1) === 'danger-full-access'
    && clearRes.json?.data?.applied?.[0]?.ok === true, JSON.stringify(clearRes.json?.data?.applied))
  const before = permissionCalls.length
  const msg2 = await req('POST', `${PREFIX}/api/tasks/${taskId}/messages`, { message: '再报一次当前权限' })
  check('第二条消息被受理', msg2.status === 202 || msg2.status === 200, `status=${msg2.status}`)
  await waitFor(() => receivedPrompts.some((p) => p.includes('再报一次当前权限')), '第二条派发提示词到达 stub 节点')
  const p2 = receivedPrompts.find((p) => p.includes('再报一次当前权限'))
  check('权限未变：复用会话不重复下发', permissionCalls.length === before, `calls=${JSON.stringify(permissionCalls)}`)
  check('第二轮提示词同样不注入「[运行权限]」', !p2.includes('[运行权限]'))

  // 5) 未配置任何权限 → 默认全部权限
  const a2 = (await req('POST', `${PREFIX}/api/agents`, {
    name: 'perm-e2e-default',
    dshRef: { kind: 'direct', apiBaseUrl: `http://127.0.0.1:${STUB_PORT}/api/v1` },
    apiKey: 'stub-key',
  })).json?.data
  const t2 = (await req('POST', `${PREFIX}/api/tasks`, { title: 'perm default', mode: 'chat', memberAgentIds: [a2?.id] })).json?.data?.id
  const n0 = permissionCalls.length
  await req('POST', `${PREFIX}/api/tasks/${t2}/messages`, { message: '默认权限验证' })
  await waitFor(() => receivedPrompts.some((p) => p.includes('默认权限验证')), '默认权限任务派发到达')
  check('未配置权限时默认下发 danger-full-access', permissionCalls.slice(n0).includes('danger-full-access'), `calls=${JSON.stringify(permissionCalls.slice(n0))}`)


  // 4) 旧版节点（无 /permission 路由）→ 降级为提示词声明
  stubSupportsPermission = false
  await sleep(1200)
  await req('PUT', `${PREFIX}/api/tasks/${taskId}/permission`, { permission: 'workspace-write' })
  const msg3 = await req('POST', `${PREFIX}/api/tasks/${taskId}/messages`, { message: '旧节点降级验证' })
  check('第三条消息被受理', msg3.status === 202 || msg3.status === 200, `status=${msg3.status}`)
  await waitFor(() => receivedPrompts.some((p) => p.includes('旧节点降级验证')), '第三条派发提示词到达 stub 节点')
  const p3 = receivedPrompts.find((p) => p.includes('旧节点降级验证'))
  check('旧节点降级：提示词含「[运行权限]: workspace-write」', p3.includes('[运行权限]: workspace-write'))

  console.log(failures === 0 ? '\n全部通过 ✅\n' : `\n${failures} 项失败 ❌\n`)
  try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  cleanup()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); cleanup(); process.exit(1) })
