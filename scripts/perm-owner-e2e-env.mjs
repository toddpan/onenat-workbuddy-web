#!/usr/bin/env node
/**
 * 线上（natpass.yikaihui.com）权限验收 —— 测试数据编排
 *
 *   WB_ADMIN_PASS='***' node scripts/perm-owner-e2e-env.mjs            # 造数并写 state
 *   WB_ADMIN_PASS='***' node scripts/perm-owner-e2e-env.mjs --cleanup  # 按 state 清理
 *
 * 造数内容（全部带 QA-EGO 标签，便于识别与清理）：
 *   - 普通用户 qa-ego-<stamp>@example.com（管理员邀请 → 链接激活）
 *   - 子智能体「QA-EGO 共享子智能体」（归属=管理员；带 apiKey/提示词）
 *   - 子智能体「QA-EGO 未绑定子智能体」（归属=管理员；对照组，不绑项目）
 *   - 项目「QA-EGO 权限项目」（管理员 + 普通用户成员；绑定上面的共享子智能体与 SSH 资源）
 *   - SSH 资源「QA-EGO SSH 资源」（归属=管理员）
 *
 * state JSON 默认写到 /tmp/wb-ego-perm-state.json，供 ego-browser 脚本读取。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = (process.env.WB_BASE || 'https://natpass.yikaihui.com/onenat-workbuddy').replace(/\/$/, '')
const ADMIN_USER = process.env.WB_ADMIN_USER || 'wb-qa'
const ADMIN_PASS = process.env.WB_ADMIN_PASS || ''
const STATE_PATH = process.env.WB_STATE || '/tmp/wb-ego-perm-state.json'
const TAG = 'QA-EGO'
const CLEANUP = process.argv.includes('--cleanup')

if (!ADMIN_PASS) {
  console.error('缺少 WB_ADMIN_PASS（请用环境变量传入，不落盘明文）')
  process.exit(2)
}

async function req(method, path, body, cookie = '') {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = undefined }
  return { status: res.status, json, cookie: (res.headers.get('set-cookie') || '').split(';')[0] }
}

async function login() {
  const r = await req('POST', '/api/auth/login', { username: ADMIN_USER, password: ADMIN_PASS })
  if (r.status !== 200 || !r.cookie) throw new Error(`管理员登录失败 status=${r.status}`)
  return r.cookie
}

async function cleanup(state) {
  const cookie = await login()
  console.log('[cleanup] 清理 QA-EGO 测试数据…')
  if (state.ids?.projectId) {
    console.log('  项目', state.ids.projectId, '→', (await req('DELETE', `/api/projects/${state.ids.projectId}`, undefined, cookie)).status)
  }
  for (const id of state.ids?.agentIds || []) {
    console.log('  子智能体', id, '→', (await req('DELETE', `/api/agents/${id}`, undefined, cookie)).status)
  }
  if (state.ids?.sshId) {
    console.log('  SSH 资源', state.ids.sshId, '→', (await req('DELETE', `/api/ssh-resources/${state.ids.sshId}`, undefined, cookie)).status)
  }
  if (state.ids?.userId) {
    console.log('  用户', state.ids.userId, '→', (await req('DELETE', `/api/users/${state.ids.userId}`, undefined, cookie)).status)
  }
  const left = await req('GET', '/api/agents', undefined, cookie)
  const rest = (left.json?.data || []).filter((a) => String(a.name || '').startsWith(TAG)).map((a) => a.id)
  console.log('  剩余 QA-EGO 智能体:', rest.length ? rest.join(',') : '无')
}

async function main() {
  if (CLEANUP) {
    let state
    try { state = JSON.parse(readFileSync(STATE_PATH, 'utf8')) } catch { state = null }
    if (!state) { console.error('读不到 state:', STATE_PATH); process.exit(2) }
    await cleanup(state)
    return
  }

  const stamp = Date.now().toString(36).slice(-6)
  const cookie = await login()
  console.log('[env] 管理员登录成功')

  const memberEmail = `qa-ego-${stamp}@example.com`
  const memberPass = `WbQa${stamp}Member9`
  const inv = await req('POST', '/api/users', { email: memberEmail, displayName: 'QA-EGO 普通用户' }, cookie)
  const token = new URL(inv.json?.data?.inviteLink || 'http://x/?token=').searchParams.get('token') || ''
  if (inv.status !== 201 || !token) throw new Error(`邀请失败 status=${inv.status}`)
  const accept = await req('POST', `/api/invitations/${token}`, { password: memberPass, displayName: 'QA-EGO 普通用户' })
  if (accept.status !== 200) throw new Error(`激活失败 status=${accept.status}`)
  console.log('[env] 普通用户已激活:', memberEmail)

  const ssh = await req('POST', '/api/ssh-resources', {
    name: `${TAG} SSH 资源`, host: '127.0.0.1', port: 22, authType: 'password', username: 'qa-tester', password: 'qa-secret-value',
  }, cookie)
  const sshId = ssh.json?.data?.id
  const shared = await req('POST', '/api/agents', {
    name: `${TAG} 共享子智能体`, dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:1' },
    apiKey: 'sk-qa-agent-secret', systemPrompt: `${TAG} 内部系统提示词（不应外泄）`,
  }, cookie)
  const sharedId = shared.json?.data?.id
  const unbound = await req('POST', '/api/agents', {
    name: `${TAG} 未绑定子智能体`, dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:2' },
    apiKey: 'sk-qa-unbound-secret', systemPrompt: `${TAG} 未绑定提示词`,
  }, cookie)
  const unboundId = unbound.json?.data?.id
  const proj = await req('POST', '/api/projects', { name: `${TAG} 权限项目`, dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:1' } }, cookie)
  const pid = proj.json?.data?.id
  if (!sshId || !sharedId || !unboundId || !pid) throw new Error('造数失败')
  await req('POST', `/api/projects/${pid}/members`, { username: memberEmail }, cookie)
  await req('PATCH', `/api/projects/${pid}`, {
    name: `${TAG} 权限项目`, dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:1' },
    connectorIds: [`ssh:${sshId}`], defaultAgentIds: [sharedId], allowMemberInvite: true,
  }, cookie)
  console.log('[env] QA 数据就绪：', { sshId, sharedId, unboundId, pid })

  const state = {
    base: BASE,
    at: new Date().toISOString(),
    admin: { user: ADMIN_USER, pass: ADMIN_PASS },
    member: { user: memberEmail, pass: memberPass },
    ids: { projectId: pid, agentIds: [sharedId, unboundId], sharedAgentId: sharedId, unboundAgentId: unboundId, sshId, userId: inv.json?.data?.userId },
  }
  // state 含明文口令（清理阶段需重新登录），只落 /tmp 且收紧权限，不入库
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), { mode: 0o600 })
  console.log('[env] state →', STATE_PATH)
}

main().catch((e) => { console.error('[env] 失败:', e.message); process.exit(1) })
