#!/usr/bin/env node
/**
 * 安装客户端缺陷回归（task-102/103/104/105/106/107）
 *
 *   node --test scripts/install-client-regression.test.mjs
 *
 * 直接测**仓库源文件**（skills/onenat-workbuddy/scripts/wb.mjs 与 scripts/install-skill.sh），
 * 不依赖真实 ONENAT / DSH：工具通道用一个最小 HTTP mock 返回 {ok,tool,result} 信封。
 *
 * 覆盖：
 *   T1 task-102/106 业务失败（result.ok=false）→ 退出码 2，stdout 保留 JSON
 *   T2 task-106 成功调用仍退出 0；无 ok 字段 / 字符串结果的历史形状不误判
 *   T3 task-103 file download --out 落盘且字节/sha256 一致
 *   T4 task-103 下载失败退出非 0，且不抛 ERR_INVALID_ARG_TYPE
 *   T5 task-107 WORKBUDDY_CONFIG 可覆盖配置路径（HOME 无配置也能连通）
 *   T6 task-107 无 WORKBUDDY_CONFIG 且 HOME 无配置 → 配置缺失退出 1（对照基线）
 *   T7 task-104 管道安装（bash -s -- --help）退出 0 且输出用法
 *   T8 task-105 卸载清除安装报告、配置与技能目录；重复卸载幂等
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 默认测仓库源文件；WB_CLIENT_UNDER_TEST / WB_INSTALLER_UNDER_TEST 可指向任意副本，
// 用于验证本回归在修复前确实会变红（红能力），而不只是恒绿的空断言。
const WB = process.env.WB_CLIENT_UNDER_TEST || path.join(ROOT, 'skills/onenat-workbuddy/scripts/wb.mjs')
const INSTALLER = process.env.WB_INSTALLER_UNDER_TEST || path.join(ROOT, 'scripts/install-skill.sh')
const CONTENT = 'QA download bytes\n'

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** 最小工具通道 mock：按 工具名 + action 返回业务信封 */
async function toolServer(t) {
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || '{}') : {}
    const url = req.url || '/'
    const send = (code, data) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(data))
    }
    if (url === '/api/tools') {
      return send(200, { ok: true, tools: [{ name: 'workbuddy_project_manage', description: 'mock' }] })
    }
    const name = url.startsWith('/api/tools/') ? url.slice('/api/tools/'.length) : ''
    const envelope = (result) => send(200, { ok: true, tool: name, result, structuredContent: { ok: result.ok, data: result } })
    if (name === 'workbuddy_file_manage' && body.action === 'download') {
      if (String(body.path || '').endsWith('missing.txt')) {
        return envelope({ ok: false, code: 'NOT_FOUND', error: 'no such file', status: 404, retryable: false })
      }
      return envelope({
        ok: true, name: 'qa-download.txt', size: Buffer.byteLength(CONTENT),
        sha256: sha256(Buffer.from(CONTENT)), encoding: 'utf8', content: CONTENT,
      })
    }
    if (name === 'workbuddy_project_manage') {
      return envelope({ ok: false, code: 'NOT_FOUND', error: '项目不存在', status: 404, retryable: false })
    }
    if (name === 'workbuddy_task_manage') {
      // 历史形状：result 没有 ok 字段，不应被误判为失败
      return send(200, { ok: true, tool: name, result: { taskId: 'task-mock', title: 'mock' } })
    }
    return envelope({ ok: true, echoed: body })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}`
}

const baseEnv = (extra = {}) => ({
  ...process.env,
  WORKBUDDY_BASE_URL: '',
  WORKBUDDY_TOKEN: '',
  WORKBUDDY_CONFIG: '',
  ...extra,
})

function runCli(args, env) {
  // 必须用异步 spawn：mock 工具通道跑在本测试进程内，spawnSync 会阻塞事件循环导致子进程请求无人应答
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WB, ...args], { env: baseEnv(env) })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function tmpHome(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wb-client-reg-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// ---------------------------------------------------------------- T1 / T2

test('T1 task-102/106: business failure exits non-zero and keeps JSON on stdout', async (t) => {
  const base = await toolServer(t)
  const r = await runCli(['project', 'get', '--id', 'qa-missing-project'], { WORKBUDDY_BASE_URL: base, WORKBUDDY_TOKEN: 'mock-token' })
  assert.equal(r.code, 2, `expected exit 2, got ${r.code}: ${r.stderr}`)
  const parsed = JSON.parse(r.stdout) // stdout 仍是可解析 JSON，供脚本继续消费
  assert.equal(parsed.result.ok, false)
  assert.equal(parsed.result.code, 'NOT_FOUND')
})

test('T2 task-106: success still exits 0; result without ok is not a failure', async (t) => {
  const base = await toolServer(t)
  const ok = await runCli(['task', 'status', '--id', 'task-mock'], { WORKBUDDY_BASE_URL: base, WORKBUDDY_TOKEN: 'mock-token' })
  assert.equal(ok.code, 0, `expected exit 0, got ${ok.code}: ${ok.stderr}`)
  assert.match(ok.stdout, /task-mock/)
})

// ---------------------------------------------------------------- T3 / T4

test('T3 task-103: file download --out saves exact bytes and exits 0', async (t) => {
  const base = await toolServer(t)
  const out = path.join(tmpHome(t), 'qa-downloaded.txt')
  const r = await runCli(['file', 'download', '--agent', 'agent-mock', '--path', '/qa/project/qa-download.txt', '--out', out],
    { WORKBUDDY_BASE_URL: base, WORKBUDDY_TOKEN: 'mock-token' })
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`)
  assert.ok(existsSync(out), 'downloaded file must exist')
  const saved = readFileSync(out)
  assert.equal(saved.toString('utf8'), CONTENT)
  assert.equal(sha256(saved), sha256(Buffer.from(CONTENT)))
  assert.equal(saved.length, 18)
})

test('T4 task-103: download failure exits non-zero without ERR_INVALID_ARG_TYPE', async (t) => {
  const base = await toolServer(t)
  const out = path.join(tmpHome(t), 'missing.txt')
  const r = await runCli(['file', 'download', '--agent', 'agent-mock', '--path', '/qa/project/missing.txt', '--out', out],
    { WORKBUDDY_BASE_URL: base, WORKBUDDY_TOKEN: 'mock-token' })
  assert.notEqual(r.code, 0, 'failed download must not report success')
  assert.doesNotMatch(r.stderr, /ERR_INVALID_ARG_TYPE/)
  assert.ok(!existsSync(out), 'no partial file on failure')
  assert.match(r.stdout, /NOT_FOUND/)
})

// ---------------------------------------------------------------- T5 / T6

test('T5 task-107: WORKBUDDY_CONFIG overrides config path', async (t) => {
  const base = await toolServer(t)
  const home = tmpHome(t)          // HOME 里故意不放配置
  const cfgDir = tmpHome(t)
  const cfg = path.join(cfgDir, 'custom-config.json')
  writeFileSync(cfg, JSON.stringify({ baseUrl: base, token: 'mock-token' }))
  const r = await runCli(['tools'], { HOME: home, WORKBUDDY_CONFIG: cfg })
  assert.equal(r.code, 0, `expected exit 0 via WORKBUDDY_CONFIG, got ${r.code}: ${r.stderr}`)
  assert.match(r.stdout, /连接正常/)
})

test('T6 task-107: without WORKBUDDY_CONFIG an empty HOME reports missing config', async (t) => {
  const home = tmpHome(t)
  const r = await runCli(['tools'], { HOME: home })
  assert.equal(r.code, 1, `expected exit 1, got ${r.code}`)
  assert.match(r.stderr, /配置缺失/)
})

// ---------------------------------------------------------------- T7

test('T7 task-104: piped installer --help works (bash -s)', async () => {
  const script = readFileSync(INSTALLER, 'utf8')
  const r = spawnSync('bash', ['-s', '--', '--help'], { input: script, encoding: 'utf8' })
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`)
  assert.match(r.stdout, /用法:/)
  assert.match(r.stdout, /--base-url/)
  assert.match(r.stdout, /--uninstall/)
  assert.doesNotMatch(r.stdout, /set -euo pipefail/, 'help must not leak shell code')
  assert.doesNotMatch(r.stderr, /No such file/)
})

test('T7b task-104: file invocation --help matches piped output', () => {
  const file = spawnSync('bash', [INSTALLER, '--help'], { encoding: 'utf8' })
  const piped = spawnSync('bash', ['-s', '--', '--help'], { input: readFileSync(INSTALLER, 'utf8'), encoding: 'utf8' })
  assert.equal(file.status, 0)
  assert.equal(piped.status, 0)
  assert.equal(file.stdout, piped.stdout)
})

// ---------------------------------------------------------------- T8

test('T8 task-105: uninstall clears install report, config and skill dirs; idempotent', (t) => {
  const home = tmpHome(t)
  for (const d of ['.dsh/skills/onenat-workbuddy', '.dsh/skills/workbuddy-mcp']) {
    mkdirSync(path.join(home, d), { recursive: true })
    writeFileSync(path.join(home, d, 'SKILL.md'), 'installed')
  }
  writeFileSync(path.join(home, '.workbuddy-skill.json'), JSON.stringify({ baseUrl: 'http://127.0.0.1:1/x', token: 't' }))
  const report = path.join(home, '.workbuddy-install-report.json')
  writeFileSync(report, JSON.stringify({ filesInstalled: true, verified: true }))

  const first = spawnSync('bash', [INSTALLER, '--uninstall'], { env: { ...process.env, HOME: home }, encoding: 'utf8' })
  assert.equal(first.status, 0, first.stderr)
  assert.ok(!existsSync(report), 'stale verified report must be removed')
  assert.ok(!existsSync(path.join(home, '.workbuddy-skill.json')), 'config must be removed')
  assert.ok(!existsSync(path.join(home, '.dsh/skills/onenat-workbuddy')), 'skill dir must be removed')
  assert.ok(!existsSync(path.join(home, '.dsh/skills/workbuddy-mcp')), 'mcp skill dir must be removed')
  assert.match(first.stdout, /已清除安装报告/)

  // 幂等：再次卸载不报错
  const second = spawnSync('bash', [INSTALLER, '--uninstall'], { env: { ...process.env, HOME: home }, encoding: 'utf8' })
  assert.equal(second.status, 0, second.stderr)
})
