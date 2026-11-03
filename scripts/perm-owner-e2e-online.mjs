#!/usr/bin/env node
/**
 * 线上权限矩阵验证（§10 权限模型扩展 —— 资源归属 / 子智能体归属 / 项目绑定共享 / 成员邀请开关）
 *
 *   WB_BASE=https://natpass.yikaihui.com/onenat-workbuddy \
 *   WB_ADMIN_USER=wb-qa WB_ADMIN_PASS='***' \
 *   node scripts/perm-owner-e2e-online.mjs
 *
 * 与本地版 scripts/perm-owner-e2e.mjs 的差异：
 *   - 打的是**线上实例**（默认 natpass.yikaihui.com），不本地起服务；
 *   - 测试数据统一打 QA 标签（WB_TAG），结束默认清理（WB_KEEP=1 保留）；
 *   - 额外断言「线上存量数据」语义：他人归属的实体不可见、存量无归属实体可见但写面仅管理员。
 *
 * 退出码非 0 即失败。结果 JSON 落到 qa-20261102-perm-online/api-result.json。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = (process.env.WB_BASE || 'https://natpass.yikaihui.com/onenat-workbuddy').replace(/\/$/, '')
const ADMIN_USER = process.env.WB_ADMIN_USER || 'wb-qa'
const ADMIN_PASS = process.env.WB_ADMIN_PASS || ''
const TAG = process.env.WB_TAG || 'QA-EGO'
const KEEP = process.env.WB_KEEP === '1'
const OUT_DIR = join(ROOT, process.env.WB_OUT_DIR || 'qa-20261102-perm-online')

if (!ADMIN_PASS) {
  console.error('缺少 WB_ADMIN_PASS（不落盘明文，请用环境变量传入）')
  process.exit(2)
}

const results = []
let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  if (!ok) failures++
  results.push({ name, pass: ok, detail: detail === undefined ? '' : String(detail) })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
  return ok
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

const created = { projectId: '', agentIds: [], sshId: '', userId: '', inviteToken: '' }
let adminCookie = ''

async function cleanup() {
  if (KEEP) {
    console.log('\n[cleanup] WB_KEEP=1，保留测试数据')
    return
  }
  console.log('\n[cleanup] 清理线上测试数据…')
  if (!adminCookie) {
    console.log('  无管理员会话，跳过清理')
    return
  }
  if (created.projectId && created.inviteToken) {
    const r = await req('POST', `/api/projects/${created.projectId}/invitations/${created.inviteToken}/revoke`, undefined, adminCookie).catch(() => null)
    console.log(`  项目邀请撤销 → ${r ? r.status : 'ERR'}`)
  }
  if (created.projectId) {
    const r = await req('DELETE', `/api/projects/${created.projectId}`, undefined, adminCookie).catch(() => null)
    console.log(`  项目 ${created.projectId} → ${r ? r.status : 'ERR'}`)
  }
  for (const id of created.agentIds) {
    const r = await req('DELETE', `/api/agents/${id}`, undefined, adminCookie).catch(() => null)
    console.log(`  子智能体 ${id} → ${r ? r.status : 'ERR'}`)
  }
  if (created.sshId) {
    const r = await req('DELETE', `/api/ssh-resources/${created.sshId}`, undefined, adminCookie).catch(() => null)
    console.log(`  SSH 资源 ${created.sshId} → ${r ? r.status : 'ERR'}`)
  }
  if (created.userId) {
    const r = await req('DELETE', `/api/users/${created.userId}`, undefined, adminCookie).catch(() => null)
    console.log(`  用户 ${created.userId} → ${r ? r.status : 'ERR'}`)
  }
}

async function main() {
  const stamp = Date.now().toString(36).slice(-6)
  const memberEmail = `${TAG.toLowerCase()}-${stamp}@example.com`

  // ---------- ① 管理员登录 ----------
  const admin = await req('POST', '/api/auth/login', { username: ADMIN_USER, password: ADMIN_PASS })
  check('① 管理员登录成功', admin.status === 200 && admin.json?.ok, `status=${admin.status}`)
  if (!admin.cookie) throw new Error('管理员登录未拿到会话 Cookie')
  adminCookie = admin.cookie

  // ---------- ② 邀请并激活普通用户 ----------
  const inv = await req('POST', '/api/users', { email: memberEmail, displayName: `${TAG} 普通用户` }, adminCookie)
  const inviteToken = new URL(inv.json?.data?.inviteLink || 'http://x/?token=').searchParams.get('token') || ''
  check('② 管理员邀请普通用户并拿到邀请令牌', inv.status === 201 && Boolean(inviteToken), `status=${inv.status}`)
  created.userId = inv.json?.data?.userId || ''
  const memberPass = `Wb${TAG.replace(/[^A-Za-z0-9]/g, '')}${stamp}!`
  const accept = await req('POST', `/api/invitations/${inviteToken}`, { password: memberPass, displayName: `${TAG} 普通用户` })
  check('② 普通用户激活并自动登录', accept.status === 200 && Boolean(accept.cookie), `status=${accept.status}`)
  const memberCookie = accept.cookie || ''

  // ---------- ③ 管理员建资源/子智能体/项目（归属 = 管理员） ----------
  const ssh = await req('POST', '/api/ssh-resources', {
    name: `${TAG} SSH 资源`, host: '127.0.0.1', port: 22, authType: 'password', username: 'qa-tester', password: 'qa-secret-value',
  }, adminCookie)
  created.sshId = ssh.json?.data?.id || ''
  check('③ 管理员创建 SSH 资源（归属=管理员）', ssh.status === 200 && Boolean(created.sshId), `status=${ssh.status} id=${created.sshId}`)
  check('③ SSH 资源回显脱敏（无明文密码）', ssh.json?.data?.password === undefined && ssh.json?.data?.hasPassword === true)

  const agentRes = await req('POST', '/api/agents', {
    name: `${TAG} 共享子智能体`,
    dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:1' },
    apiKey: 'sk-qa-agent-secret',
    systemPrompt: `${TAG} 内部系统提示词（不应外泄）`,
  }, adminCookie)
  const agentId = agentRes.json?.data?.id || ''
  created.agentIds.push(agentId)
  check('③ 管理员创建子智能体（归属=管理员）', agentRes.status === 200 && Boolean(agentId), `status=${agentRes.status} id=${agentId}`)
  check('③ 子智能体回显含归属人', agentRes.json?.data?.ownerUserId === inv.json?.data?.userId || Boolean(agentRes.json?.data?.ownerUserId),
    `ownerUserId=${agentRes.json?.data?.ownerUserId}`)

  const unbound = await req('POST', '/api/agents', {
    name: `${TAG} 未绑定子智能体`,
    dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:2' },
    apiKey: 'sk-qa-unbound-secret',
    systemPrompt: `${TAG} 未绑定提示词`,
  }, adminCookie)
  const unboundId = unbound.json?.data?.id || ''
  created.agentIds.push(unboundId)
  check('③ 管理员创建未绑定子智能体（对照组）', unbound.status === 200 && Boolean(unboundId), `status=${unbound.status}`)

  const proj = await req('POST', '/api/projects', { name: `${TAG} 权限项目`, dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:1' } }, adminCookie)
  const pid = proj.json?.data?.id || ''
  created.projectId = pid
  check('③ 管理员创建项目', proj.status === 200 && Boolean(pid), `status=${proj.status} id=${pid}`)
  const addM = await req('POST', `/api/projects/${pid}/members`, { username: memberEmail }, adminCookie)
  check('③ 管理员把普通用户加入项目', addM.status === 200 && (addM.json?.data?.members || []).some((m) => m.role === 'member'), `status=${addM.status}`)

  // ---------- ④ 未绑定前：普通用户完全不可见不可用 ----------
  const aSshList1 = await req('GET', '/api/ssh-resources', undefined, memberCookie)
  check('④ 普通用户 SSH 列表不含他人资源', !(aSshList1.json?.data || []).some((r) => r.id === created.sshId),
    `list=${(aSshList1.json?.data || []).length}`)
  const aSshGet1 = await req('GET', `/api/ssh-resources/${created.sshId}`, undefined, memberCookie)
  check('④ 普通用户取 SSH 明文凭据 404（防枚举）', aSshGet1.status === 404, `status=${aSshGet1.status}`)
  const aSshExec1 = await req('POST', `/api/ssh-resources/${created.sshId}/exec`, { command: 'echo hi', timeoutMs: 1500 }, memberCookie)
  check('④ 普通用户 exec 他人 SSH 资源 403', aSshExec1.status === 403, `status=${aSshExec1.status}`)
  const aSshDel1 = await req('DELETE', `/api/ssh-resources/${created.sshId}`, undefined, memberCookie)
  check('④ 普通用户删除他人 SSH 资源 403', aSshDel1.status === 403, `status=${aSshDel1.status}`)
  const aSshUpd1 = await req('POST', '/api/ssh-resources', { id: created.sshId, name: '改名尝试', host: '127.0.0.1', username: 'qa-tester', password: 'x' }, memberCookie)
  check('④ 普通用户改他人 SSH 资源 403', aSshUpd1.status === 403, `status=${aSshUpd1.status}`)

  const aAgentList1 = await req('GET', '/api/agents', undefined, memberCookie)
  check('④ 普通用户智能体列表不含他人智能体', !(aAgentList1.json?.data || []).some((a) => a.id === agentId || a.id === unboundId),
    `list=${(aAgentList1.json?.data || []).length}`)
  const aAgentGet1 = await req('GET', `/api/agents/${agentId}`, undefined, memberCookie)
  check('④ 普通用户取他人子智能体 404', aAgentGet1.status === 404, `status=${aAgentGet1.status}`)
  const aAgentUpd1 = await req('POST', '/api/agents', { id: agentId, name: '改名尝试', dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:1' } }, memberCookie)
  check('④ 普通用户改他人子智能体 403', aAgentUpd1.status === 403, `status=${aAgentUpd1.status}`)
  const aAgentDel1 = await req('DELETE', `/api/agents/${agentId}`, undefined, memberCookie)
  check('④ 普通用户删他人子智能体 403', aAgentDel1.status === 403, `status=${aAgentDel1.status}`)
  const aSameName = await req('POST', '/api/agents', { name: `${TAG} 共享子智能体`, dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:1' } }, memberCookie)
  check('④ 普通用户同名同节点新建被拒（不得复用他人资产）', aSameName.status === 403, `status=${aSameName.status}`)

  // ---------- ⑤ 归属人（管理员）可见明文 ----------
  const admSsh = await req('GET', `/api/ssh-resources/${created.sshId}`, undefined, adminCookie)
  check('⑤ 归属人可取 SSH 明文凭据', admSsh.status === 200 && admSsh.json?.data?.password === 'qa-secret-value', `status=${admSsh.status}`)
  const admAgent = await req('GET', `/api/agents/${agentId}`, undefined, adminCookie)
  check('⑤ 归属人可读子智能体 apiKey / 提示词',
    admAgent.status === 200 && admAgent.json?.data?.apiKey === 'sk-qa-agent-secret' && admAgent.json?.data?.systemPrompt?.includes('内部系统提示词'),
    `status=${admAgent.status}`)

  // ---------- ⑥ 项目绑定共享：可见可用，但不可取明文/改删 ----------
  const bindSsh = await req('PATCH', `/api/projects/${pid}`, {
    name: `${TAG} 权限项目`, dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:1' }, connectorIds: [`ssh:${created.sshId}`],
  }, adminCookie)
  check('⑥ 项目绑定 SSH 资源', bindSsh.status === 200 && (bindSsh.json?.data?.connectorIds || []).includes(`ssh:${created.sshId}`), `status=${bindSsh.status}`)
  const bindAgent = await req('PATCH', `/api/projects/${pid}`, {
    name: `${TAG} 权限项目`, dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:1' }, defaultAgentIds: [agentId],
  }, adminCookie)
  check('⑥ 项目绑定子智能体为默认协作成员', bindAgent.status === 200 && (bindAgent.json?.data?.defaultAgentIds || []).includes(agentId), `status=${bindAgent.status}`)

  const aSshList2 = await req('GET', '/api/ssh-resources', undefined, memberCookie)
  check('⑥ 绑定后普通用户可见该 SSH 资源（脱敏）', (aSshList2.json?.data || []).some((r) => r.id === created.sshId && r.password === undefined))
  const aSshGet2 = await req('GET', `/api/ssh-resources/${created.sshId}`, undefined, memberCookie)
  check('⑥ 绑定后普通用户仍拿不到明文凭据', aSshGet2.status === 200 && aSshGet2.json?.data?.password === undefined, `status=${aSshGet2.status}`)
  const aSshExec2 = await req('POST', `/api/ssh-resources/${created.sshId}/exec`, { command: 'echo hi', timeoutMs: 1500 }, memberCookie)
  check('⑥ 绑定后普通用户可使用该资源（非 403）', aSshExec2.status !== 403, `status=${aSshExec2.status}`)
  const aSshDel2 = await req('DELETE', `/api/ssh-resources/${created.sshId}`, undefined, memberCookie)
  check('⑥ 绑定后普通用户仍不能删除资源 403', aSshDel2.status === 403, `status=${aSshDel2.status}`)

  const aAgentGet2 = await req('GET', `/api/agents/${agentId}`, undefined, memberCookie)
  check('⑥ 绑定后普通用户可见子智能体但提示词脱敏',
    aAgentGet2.status === 200 && aAgentGet2.json?.data?.apiKey === undefined && aAgentGet2.json?.data?.systemPrompt === undefined,
    `status=${aAgentGet2.status} data=${JSON.stringify(aAgentGet2.json?.data || {}).slice(0, 160)}`)
  const aAgentDel2 = await req('DELETE', `/api/agents/${agentId}`, undefined, memberCookie)
  check('⑥ 绑定后普通用户仍不能删除子智能体 403', aAgentDel2.status === 403, `status=${aAgentDel2.status}`)
  const aUnboundGet = await req('GET', `/api/agents/${unboundId}`, undefined, memberCookie)
  check('⑥ 未绑定到项目的子智能体对普通用户仍 404', aUnboundGet.status === 404, `status=${aUnboundGet.status}`)

  // ---------- ⑦ allowMemberInvite 开关 ----------
  const invBefore = await req('POST', `/api/projects/${pid}/invitations`, { email: `bob-${stamp}@example.com` }, memberCookie)
  check('⑦ 默认普通成员不可邀请（403）', invBefore.status === 403, `status=${invBefore.status}`)
  const openSwitch = await req('PATCH', `/api/projects/${pid}`, {
    name: `${TAG} 权限项目`, dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:1' }, allowMemberInvite: true,
  }, adminCookie)
  check('⑦ 开启「成员可邀请」开关', openSwitch.status === 200 && openSwitch.json?.data?.allowMemberInvite === true, `status=${openSwitch.status}`)
  const invAfter = await req('POST', `/api/projects/${pid}/invitations`, { email: `bob-${stamp}@example.com` }, memberCookie)
  check('⑦ 开关打开后普通成员可邀请（201）', invAfter.status === 201, `status=${invAfter.status}`)
  if (invAfter.status === 201) {
    // 撤销接口按「邀请 id」定位（GET 列表返回 id），不是 token
    const invList = await req('GET', `/api/projects/${pid}/invitations`, undefined, adminCookie)
    const pending = (invList.json?.data?.invitations || [])[0]
    created.inviteToken = pending?.id || ''
    const revoke = await req('POST', `/api/projects/${pid}/invitations/${encodeURIComponent(created.inviteToken)}/revoke`, undefined, adminCookie).catch(() => null)
    check('⑦ 清理：撤销普通成员发出的项目邀请', !revoke || revoke.status === 200, `status=${revoke ? revoke.status : 'ERR'}`)
  }

  // ---------- ⑧ 线上存量语义：他人归属实体不可见；存量无归属实体写面仅管理员 ----------
  const admAgentList = await req('GET', '/api/agents', undefined, adminCookie)
  const admIds = (admAgentList.json?.data || []).map((a) => a.id)
  // 「他人归属」= 归属人不是普通用户、且不是本次显式共享给该项目的子智能体
  const otherOwned = (admAgentList.json?.data || []).filter((a) => a.ownerUserId && a.ownerUserId !== created.userId && a.id !== agentId)
  const memAgentList = await req('GET', '/api/agents', undefined, memberCookie)
  const memIds = (memAgentList.json?.data || []).map((a) => a.id)
  const leaked = otherOwned.filter((a) => memIds.includes(a.id))
  check('⑧ 普通用户看不到他人归属的线上子智能体', leaked.length === 0,
    `管理员可见 ${admIds.length} 个（他人归属未共享 ${otherOwned.length} 个），普通用户可见 ${memIds.length} 个，泄漏 ${leaked.length} 个`)
  check('⑧ 普通用户能看到项目显式共享的子智能体（应可见）', memIds.includes(agentId), `可见=${memIds.includes(agentId)}`)
  check('⑧ 普通用户看不到未绑定的子智能体（应不可见）', !memIds.includes(unboundId), `可见=${memIds.includes(unboundId)}`)
  const legacyAgents = (admAgentList.json?.data || []).filter((a) => !a.ownerUserId)
  const legacyVisible = legacyAgents.filter((a) => memIds.includes(a.id))
  check('⑧ 存量（无归属）子智能体对普通用户仍可见（宽容模式）', legacyVisible.length === legacyAgents.length,
    `存量 ${legacyAgents.length} 个，普通用户可见 ${legacyVisible.length} 个`)
  if (legacyAgents.length) {
    const lg = legacyAgents[0]
    const lgGet = await req('GET', `/api/agents/${lg.id}`, undefined, memberCookie)
    check('⑧ 普通用户读存量子智能体时私有配置脱敏',
      lgGet.status === 200 && lgGet.json?.data?.apiKey === undefined && lgGet.json?.data?.systemPrompt === undefined,
      `id=${lg.id} status=${lgGet.status}`)
    const lgDel = await req('DELETE', `/api/agents/${lg.id}`, undefined, memberCookie)
    check('⑧ 普通用户删除存量子智能体 403（线上事故回归）', lgDel.status === 403, `status=${lgDel.status}`)
  }

  // ---------- ⑨ 审计与回归：既有功能未被权限改造打坏 ----------
  const health = await fetch(`${BASE}/healthz`).then((r) => r.json()).catch(() => null)
  check('⑨ healthz 正常', health?.ok === true, JSON.stringify(health || {}).slice(0, 120))
  const mon = await req('GET', '/api/monitor/overview', undefined, adminCookie)
  check('⑨ 监控总览可读（既有功能回归）', mon.status === 200 && mon.json?.ok, `status=${mon.status}`)
  const projList = await req('GET', '/api/projects', undefined, memberCookie)
  check('⑨ 普通用户项目列表只含自己所属项目',
    projList.status === 200 && (projList.json?.data || []).some((p) => p.id === pid),
    `status=${projList.status} count=${(projList.json?.data || []).length}`)
  const anon = await req('GET', '/api/agents')
  check('⑨ 未登录访问业务接口被拒（fail-closed）', anon.status === 401, `status=${anon.status}`)

  const summary = {
    base: BASE,
    at: new Date().toISOString(),
    admin: ADMIN_USER,
    member: memberEmail,
    ids: { project: pid, agent: agentId, unboundAgent: unboundId, ssh: created.sshId, user: created.userId },
    total: results.length,
    failures,
    results,
  }
  try {
    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(join(OUT_DIR, 'api-result.json'), JSON.stringify(summary, null, 2))
  } catch (err) {
    console.error('结果落盘失败:', err)
  }
  console.log(`\n${failures === 0 ? '✅ 全部通过' : '❌ 失败 ' + failures + ' 项'}（共 ${results.length} 项）`)
  return failures
}

main()
  .then(async (f) => {
    await cleanup()
    process.exit(f === 0 ? 0 : 1)
  })
  .catch(async (err) => {
    console.error('线上权限验证异常:', err)
    await cleanup()
    process.exit(1)
  })
