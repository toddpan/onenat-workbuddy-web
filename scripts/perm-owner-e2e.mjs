#!/usr/bin/env node
/**
 * 资源归属与项目绑定共享端到端验证（§10 权限模型扩展）
 *   node scripts/perm-owner-e2e.mjs
 *
 * 链路：临时数据目录起 dist/server.js → 管理员登录 → 邀请普通用户并激活 →
 *       管理员建 SSH 资源 / 子智能体（归属=管理员）→ 建项目并加普通用户为成员 →
 *       断言普通用户在「未绑定项目」时不可见不可用 → 项目绑定后可见可用但仍不可取明文/改删 →
 *       子智能体：绑定前 404，绑定后可见但提示词脱敏 → allowMemberInvite 开关。
 *
 * 退出码非 0 即失败。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PERM_OWNER_E2E_PORT || 18097)
const PREFIX = '/onenat-workbuddy'
const BASE = `http://127.0.0.1:${PORT}`

const results = []
let failures = 0
function check(name, cond, detail = '') {
  const ok = Boolean(cond)
  if (!ok) failures++
  results.push(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) console.log(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`)
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const procs = []
function spawnJob(name, args, env = {}) {
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', (d) => { if (process.env.VERBOSE) console.log(`[${name}]`, String(d)) })
  child.stderr.on('data', (d) => console.error(`[${name}]`, String(d)))
  procs.push(child)
  return child
}
function cleanup() { for (const p of procs) { try { p.kill('SIGKILL') } catch { /* ignore */ } } }
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(1) })

async function main() {
  if (!existsSync(join(ROOT, 'dist', 'server.js'))) {
    console.error('缺少 dist/server.js —— 先执行: npm run build')
    process.exit(1)
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'wb-perm-owner-'))
  // 预置「存量无归属」fixture（ownerUserId 缺省）：线上事故回归点 ——
  // 普通用户曾成功删除存量子智能体。存量实体必须「可见可用全员、写面仅管理员」。
  writeFileSync(join(dataDir, 'store.json'), JSON.stringify({
    agents: [{
      id: 'agent-legacy-1',
      name: '存量无归属智能体',
      dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:1' },
      apiKey: 'sk-legacy-secret',
      systemPrompt: '存量系统提示词',
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }],
    tasks: [], schedules: [], projects: [], teams: [], settings: {},
  }, null, 2))
  writeFileSync(join(dataDir, 'ssh-resources.json'), JSON.stringify({ resources: [{
    id: 'ssh-legacy-1',
    name: '存量无归属主机',
    host: '127.0.0.1',
    port: 22,
    authType: 'password',
    username: 'tester',
    password: 'legacy-secret',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }] }, null, 2))
  spawnJob('server', [join(ROOT, 'dist', 'server.js'), '--port', String(PORT), '--data', dataDir, '--quiet'])

  const t0 = Date.now()
  let up = false
  while (Date.now() - t0 < 20000) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) { up = true; break } } catch { /* retry */ }
    await sleep(200)
  }
  if (!up) throw new Error('服务未就绪')

  try {
    // ---------- ① 管理员与普通用户 ----------
    const admin = await req('POST', `${PREFIX}/api/auth/login`, { username: 'workbuddy', password: 'workbuddy-admin' })
    check('管理员登录成功', admin.status === 200 && admin.json?.ok, `status=${admin.status}`)
    const adminCookie = admin.cookie || ''

    const inv = await req('POST', `${PREFIX}/api/users`, { email: 'alice@example.com', displayName: '爱丽丝' }, adminCookie)
    const inviteToken = new URL(inv.json?.data?.inviteLink || 'http://x/?token=').searchParams.get('token') || ''
    check('管理员邀请用户并拿到邀请链接', inv.status === 201 && Boolean(inviteToken), `status=${inv.status}`)
    const accept = await req('POST', `${PREFIX}/api/invitations/${inviteToken}`, { password: 'Passw0rd123', displayName: '爱丽丝' })
    check('普通用户激活并自动登录', accept.status === 200 && Boolean(accept.cookie), `status=${accept.status}`)
    const aliceCookie = accept.cookie || ''

    // ---------- ② 管理员建资源与子智能体（归属 = 管理员） ----------
    const ssh = await req('POST', `${PREFIX}/api/ssh-resources`, {
      name: '归属测试主机', host: '127.0.0.1', port: 22, authType: 'password', username: 'tester', password: 'p@ss-secret',
    }, adminCookie)
    const sshId = ssh.json?.data?.id || ''
    check('管理员创建 SSH 资源', ssh.status === 200 && Boolean(sshId), `status=${ssh.status}`)
    check('SSH 资源回显脱敏（不含明文密码）', ssh.json?.data?.password === undefined && ssh.json?.data?.hasPassword === true)

    const agent = await req('POST', `${PREFIX}/api/agents`, {
      name: '归属测试智能体',
      dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:1' },
      apiKey: 'sk-agent-secret',
      systemPrompt: '内部系统提示词',
    }, adminCookie)
    const agentId = agent.json?.data?.id || ''
    check('管理员创建子智能体', agent.status === 200 && Boolean(agentId), `status=${agent.status}`)

    const proj = await req('POST', `${PREFIX}/api/projects`, { name: '归属测试项目', dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:1' } }, adminCookie)
    const pid = proj.json?.data?.id || ''
    check('管理员创建项目', proj.status === 200 && Boolean(pid), `status=${proj.status}`)
    const addM = await req('POST', `${PREFIX}/api/projects/${pid}/members`, { username: 'alice@example.com' }, adminCookie)
    check('管理员把 alice 加入项目', addM.status === 200 && (addM.json?.data?.members || []).some((m) => m.role === 'member'), `status=${addM.status}`)

    // ---------- ③ 未绑定项目前：普通用户完全不可见不可用 ----------
    const aList1 = await req('GET', `${PREFIX}/api/ssh-resources`, undefined, aliceCookie)
    check('普通用户 SSH 列表不含他人资源', !(aList1.json?.data || []).some((r) => r.id === sshId))
    const aGet1 = await req('GET', `${PREFIX}/api/ssh-resources/${sshId}`, undefined, aliceCookie)
    check('普通用户取 SSH 明文凭据 404（防枚举）', aGet1.status === 404, `status=${aGet1.status}`)
    const aExec1 = await req('POST', `${PREFIX}/api/ssh-resources/${sshId}/exec`, { command: 'echo hi' }, aliceCookie)
    check('普通用户 exec 他人 SSH 资源 403', aExec1.status === 403, `status=${aExec1.status}`)
    const aDel1 = await req('DELETE', `${PREFIX}/api/ssh-resources/${sshId}`, undefined, aliceCookie)
    check('普通用户删除他人 SSH 资源 403', aDel1.status === 403, `status=${aDel1.status}`)
    const aUpd1 = await req('POST', `${PREFIX}/api/ssh-resources`, { id: sshId, name: '改名尝试', host: '127.0.0.1', username: 'tester', password: 'x' }, aliceCookie)
    check('普通用户改他人 SSH 资源 403', aUpd1.status === 403, `status=${aUpd1.status}`)

    const aAgentList1 = await req('GET', `${PREFIX}/api/agents`, undefined, aliceCookie)
    check('普通用户智能体列表不含他人智能体', !(aAgentList1.json?.data || []).some((a) => a.id === agentId))
    const aAgentGet1 = await req('GET', `${PREFIX}/api/agents/${agentId}`, undefined, aliceCookie)
    check('普通用户取他人子智能体 404', aAgentGet1.status === 404, `status=${aAgentGet1.status}`)
    const aAgentUpd1 = await req('POST', `${PREFIX}/api/agents`, { id: agentId, name: '改名尝试', dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:1' } }, aliceCookie)
    check('普通用户改他人子智能体 403', aAgentUpd1.status === 403, `status=${aAgentUpd1.status}`)
    const aAgentDel1 = await req('DELETE', `${PREFIX}/api/agents/${agentId}`, undefined, aliceCookie)
    check('普通用户删他人子智能体 403', aAgentDel1.status === 403, `status=${aAgentDel1.status}`)

    // 同名 + 同节点的「复用」路径不得绕过归属：他人同名新建应被拒
    const aSameName = await req('POST', `${PREFIX}/api/agents`, {
      name: '归属测试智能体',
      dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:1' },
    }, aliceCookie)
    check('普通用户以同名同节点新建被拒（不得复用他人资产）', aSameName.status === 403, `status=${aSameName.status}`)
    const admSameName = await req('POST', `${PREFIX}/api/agents`, {
      name: '归属测试智能体',
      dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:1' },
    }, adminCookie)
    check('归属人同名新建复用原条目且不转移归属', admSameName.status === 200 && admSameName.json?.data?.id === agentId, `status=${admSameName.status} id=${admSameName.json?.data?.id}`)

    // ---------- ④ 管理员侧：归属人可见明文 ----------
    const admGet = await req('GET', `${PREFIX}/api/ssh-resources/${sshId}`, undefined, adminCookie)
    check('归属人可取 SSH 明文凭据', admGet.status === 200 && admGet.json?.data?.password === 'p@ss-secret')
    const admAgent = await req('GET', `${PREFIX}/api/agents/${agentId}`, undefined, adminCookie)
    check('归属人可读子智能体 apiKey / 提示词', admAgent.status === 200 && admAgent.json?.data?.apiKey === 'sk-agent-secret' && admAgent.json?.data?.systemPrompt === '内部系统提示词')

    // ---------- ⑤ 项目绑定共享：可见可用，但不可取明文/改删 ----------
    const bindSsh = await req('PATCH', `${PREFIX}/api/projects/${pid}`, { name: '归属测试项目', dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:1' }, connectorIds: [`ssh:${sshId}`] }, adminCookie)
    check('项目绑定 SSH 资源', bindSsh.status === 200 && (bindSsh.json?.data?.connectorIds || []).includes(`ssh:${sshId}`), `status=${bindSsh.status}`)
    const bindAgent = await req('PATCH', `${PREFIX}/api/projects/${pid}`, { name: '归属测试项目', dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:1' }, defaultAgentIds: [agentId] }, adminCookie)
    check('项目绑定子智能体为默认协作成员', bindAgent.status === 200 && (bindAgent.json?.data?.defaultAgentIds || []).includes(agentId), `status=${bindAgent.status}`)

    const aList2 = await req('GET', `${PREFIX}/api/ssh-resources`, undefined, aliceCookie)
    check('绑定后普通用户可见该 SSH 资源（脱敏）', (aList2.json?.data || []).some((r) => r.id === sshId && r.password === undefined))
    const aGet2 = await req('GET', `${PREFIX}/api/ssh-resources/${sshId}`, undefined, aliceCookie)
    check('绑定后普通用户仍拿不到明文凭据', aGet2.status === 200 && aGet2.json?.data?.password === undefined, `status=${aGet2.status}`)
    const aExec2 = await req('POST', `${PREFIX}/api/ssh-resources/${sshId}/exec`, { command: 'echo hi', timeoutMs: 1500 }, aliceCookie)
    check('绑定后普通用户可使用该资源（非 403）', aExec2.status !== 403, `status=${aExec2.status}`)
    const aDel2 = await req('DELETE', `${PREFIX}/api/ssh-resources/${sshId}`, undefined, aliceCookie)
    check('绑定后普通用户仍不能删除资源 403', aDel2.status === 403, `status=${aDel2.status}`)

    const aAgentGet2 = await req('GET', `${PREFIX}/api/agents/${agentId}`, undefined, aliceCookie)
    check('绑定后普通用户可见子智能体但提示词脱敏',
      aAgentGet2.status === 200 && aAgentGet2.json?.data?.apiKey === undefined && aAgentGet2.json?.data?.systemPrompt === undefined,
      `status=${aAgentGet2.status} data=${JSON.stringify(aAgentGet2.json?.data || {}).slice(0, 160)}`)
    const aAgentDel2 = await req('DELETE', `${PREFIX}/api/agents/${agentId}`, undefined, aliceCookie)
    check('绑定后普通用户仍不能删除子智能体 403', aAgentDel2.status === 403, `status=${aAgentDel2.status}`)

    // ---------- ⑥ allowMemberInvite 开关 ----------
    const invBefore = await req('POST', `${PREFIX}/api/projects/${pid}/invitations`, { email: 'bob@example.com' }, aliceCookie)
    check('默认普通成员不可邀请（403）', invBefore.status === 403, `status=${invBefore.status}`)
    const openSwitch = await req('PATCH', `${PREFIX}/api/projects/${pid}`, { name: '归属测试项目', dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:1' }, allowMemberInvite: true }, adminCookie)
    check('开启「成员可邀请」开关', openSwitch.status === 200 && openSwitch.json?.data?.allowMemberInvite === true, `status=${openSwitch.status}`)
    const invAfter = await req('POST', `${PREFIX}/api/projects/${pid}/invitations`, { email: 'bob@example.com' }, aliceCookie)
    check('开关打开后普通成员可邀请（201）', invAfter.status === 201, `status=${invAfter.status}`)

    // ---------- ⑦ 存量无归属实体：可见可用全员，写面仅管理员（线上数据丢失回归点） ----------
    const aLegacyList = await req('GET', `${PREFIX}/api/agents`, undefined, aliceCookie)
    check('普通用户可见存量（无归属）子智能体', (aLegacyList.json?.data || []).some((a) => a.id === 'agent-legacy-1'))
    const aLegacyGet = await req('GET', `${PREFIX}/api/agents/agent-legacy-1`, undefined, aliceCookie)
    check('普通用户读存量子智能体时提示词脱敏', aLegacyGet.status === 200 && aLegacyGet.json?.data?.apiKey === undefined && aLegacyGet.json?.data?.systemPrompt === undefined,
      `status=${aLegacyGet.status} data=${JSON.stringify(aLegacyGet.json?.data || {}).slice(0, 160)}`)
    const aLegacyDel = await req('DELETE', `${PREFIX}/api/agents/agent-legacy-1`, undefined, aliceCookie)
    check('普通用户删除存量（无归属）子智能体 403 —— 线上事故回归', aLegacyDel.status === 403, `status=${aLegacyDel.status}`)
    const aLegacyUpd = await req('POST', `${PREFIX}/api/agents`, { id: 'agent-legacy-1', name: '存量改名尝试', dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:1' } }, aliceCookie)
    check('普通用户改写存量（无归属）子智能体 403', aLegacyUpd.status === 403, `status=${aLegacyUpd.status}`)
    const aLegacySame = await req('POST', `${PREFIX}/api/agents`, { name: '存量无归属智能体', dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:1' } }, aliceCookie)
    check('普通用户以同名同节点复用存量智能体被拒 403', aLegacySame.status === 403, `status=${aLegacySame.status}`)
    const aLegacyStill = await req('GET', `${PREFIX}/api/agents/agent-legacy-1`, undefined, aliceCookie)
    check('被拒后存量子智能体仍然存在（未被误删）', aLegacyStill.status === 200, `status=${aLegacyStill.status}`)

    const aLegacySshList = await req('GET', `${PREFIX}/api/ssh-resources`, undefined, aliceCookie)
    check('普通用户可见存量（无归属）SSH 资源（脱敏）', (aLegacySshList.json?.data || []).some((r) => r.id === 'ssh-legacy-1' && r.password === undefined))
    const aLegacySshGet = await req('GET', `${PREFIX}/api/ssh-resources/ssh-legacy-1`, undefined, aliceCookie)
    check('普通用户取存量 SSH 明文凭据失败（无明文）', aLegacySshGet.status === 200 && aLegacySshGet.json?.data?.password === undefined, `status=${aLegacySshGet.status}`)
    const aLegacySshDel = await req('DELETE', `${PREFIX}/api/ssh-resources/ssh-legacy-1`, undefined, aliceCookie)
    check('普通用户删除存量（无归属）SSH 资源 403', aLegacySshDel.status === 403, `status=${aLegacySshDel.status}`)

    const admLegacy = await req('GET', `${PREFIX}/api/agents/agent-legacy-1`, undefined, adminCookie)
    check('管理员可见存量子智能体完整配置（apiKey/提示词）', admLegacy.status === 200 && admLegacy.json?.data?.apiKey === 'sk-legacy-secret', `status=${admLegacy.status}`)
    const admLegacyEdit = await req('POST', `${PREFIX}/api/agents`, { id: 'agent-legacy-1', name: '存量无归属智能体', dshRef: { kind: 'direct', apiBaseUrl: 'http://127.0.0.1:1' } }, adminCookie)
    check('管理员编辑存量子智能体后不夺取归属（仍为无归属）', admLegacyEdit.status === 200 && admLegacyEdit.json?.data?.ownerUserId === undefined,
      `status=${admLegacyEdit.status} owner=${admLegacyEdit.json?.data?.ownerUserId}`)

    // ---------- ⑧ 全局面收敛（§11 Phase A：设置/监控/用量/规划器/库设置/语音助手） ----------
    const adminMe = await req('GET', `${PREFIX}/api/auth/me`, undefined, adminCookie)
    const aliceMe = await req('GET', `${PREFIX}/api/auth/me`, undefined, aliceCookie)
    const adminUid = adminMe.json?.data?.userId || ''
    const aliceUid = aliceMe.json?.data?.userId || ''
    check('双角色取到 userId（后续归属断言依赖）', Boolean(adminUid) && Boolean(aliceUid))

    const admSet = await req('GET', `${PREFIX}/api/settings`, undefined, adminCookie)
    check('管理员 GET /settings 含 aiToken 字段', admSet.status === 200 && typeof admSet.json?.data?.aiToken === 'string', `status=${admSet.status}`)
    const aSet = await req('GET', `${PREFIX}/api/settings`, undefined, aliceCookie)
    check('普通用户 GET /settings 不再下发 aiToken（空串）且无 xiaozhi 凭证段',
      aSet.status === 200 && aSet.json?.data?.aiToken === '' && !('xiaozhi' in (aSet.json?.data || {})),
      `status=${aSet.status} aiToken=${JSON.stringify(aSet.json?.data?.aiToken)} hasXz=${'xiaozhi' in (aSet.json?.data || {})}`)
    const aSetSave = await req('POST', `${PREFIX}/api/settings`, { archive: { taskArchiveDays: 7 } }, aliceCookie)
    check('普通用户改全局设置 403', aSetSave.status === 403, `status=${aSetSave.status}`)
    const aTokReset = await req('POST', `${PREFIX}/api/settings/ai-token/reset`, undefined, aliceCookie)
    check('普通用户重置 AI 令牌 403', aTokReset.status === 403, `status=${aTokReset.status}`)
    const aUsage = await req('GET', `${PREFIX}/api/usage/tokens/summary`, undefined, aliceCookie)
    check('普通用户看全局 Token 用量 403', aUsage.status === 403, `status=${aUsage.status}`)
    const admUsage = await req('GET', `${PREFIX}/api/usage/tokens/summary`, undefined, adminCookie)
    check('管理员看全局 Token 用量 200', admUsage.status === 200, `status=${admUsage.status}`)
    const aPlannerCfg = await req('POST', `${PREFIX}/api/planner/config`, { model: 'zai-coding-cn/glm-5.3-flash' }, aliceCookie)
    check('普通用户改全局规划器配置 403', aPlannerCfg.status === 403, `status=${aPlannerCfg.status}`)
    const aLibSet = await req('POST', `${PREFIX}/api/library/settings`, { publicBaseUrl: 'https://evil.example.com' }, aliceCookie)
    check('普通用户改库共享基址 403', aLibSet.status === 403, `status=${aLibSet.status}`)
    const aXz = await req('GET', `${PREFIX}/api/xiaozhi/status`, undefined, aliceCookie)
    check('普通用户访问语音助手接入 403', aXz.status === 403, `status=${aXz.status}`)

    // ---------- ⑨ 任务归属矩阵（§11：无项目任务仅创建者可见，管理仅归属人+admin） ----------
    const admTask = await req('POST', `${PREFIX}/api/tasks`, { title: '管理员私有任务', message: '第一条' }, adminCookie)
    const admTaskId = admTask.json?.data?.id || ''
    check('管理员建任务后归属=创建者', admTask.status === 201 && admTask.json?.data?.ownerUserId === adminUid, `status=${admTask.status} owner=${admTask.json?.data?.ownerUserId}`)
    const aTaskList1 = await req('GET', `${PREFIX}/api/tasks`, undefined, aliceCookie)
    check('普通用户任务列表不含他人私有任务', !(aTaskList1.json?.data || []).some((t) => t.id === admTaskId))
    const aTaskGet = await req('GET', `${PREFIX}/api/tasks/${admTaskId}`, undefined, aliceCookie)
    check('普通用户读他人私有任务 404（防枚举）', aTaskGet.status === 404, `status=${aTaskGet.status}`)
    const aTaskDel = await req('DELETE', `${PREFIX}/api/tasks/${admTaskId}`, undefined, aliceCookie)
    check('普通用户删他人私有任务 404', aTaskDel.status === 404, `status=${aTaskDel.status}`)
    const aTaskRename = await req('POST', `${PREFIX}/api/tasks/${admTaskId}/rename`, { title: '改名尝试' }, aliceCookie)
    check('普通用户改他人私有任务名 404', aTaskRename.status === 404, `status=${aTaskRename.status}`)
    const aTaskModel = await req('PUT', `${PREFIX}/api/tasks/${admTaskId}/model`, { model: 'p/m' }, aliceCookie)
    check('普通用户切他人私有任务模型 404', aTaskModel.status === 404, `status=${aTaskModel.status}`)
    const aTaskStream = await fetch(`${BASE}${PREFIX}/api/tasks/${admTaskId}/stream`, { headers: { Cookie: aliceCookie } })
    check('普通用户订阅他人私有任务 SSE 404', aTaskStream.status === 404, `status=${aTaskStream.status}`)
    aTaskStream.body?.cancel().catch(() => {})

    const aTask = await req('POST', `${PREFIX}/api/tasks`, { title: '爱丽丝任务', message: '第一条' }, aliceCookie)
    const aTaskId = aTask.json?.data?.id || ''
    check('普通用户建任务归属=自己', aTask.status === 201 && aTask.json?.data?.ownerUserId === aliceUid, `status=${aTask.status} owner=${aTask.json?.data?.ownerUserId}`)
    const aTaskList2 = await req('GET', `${PREFIX}/api/tasks`, undefined, aliceCookie)
    check('普通用户可见自己的任务', (aTaskList2.json?.data || []).some((t) => t.id === aTaskId))
    const admTaskList = await req('GET', `${PREFIX}/api/tasks`, undefined, adminCookie)
    check('管理员可见全部任务（含他人私有）', (admTaskList.json?.data || []).some((t) => t.id === admTaskId) && (admTaskList.json?.data || []).some((t) => t.id === aTaskId))
    const aArch = await req('POST', `${PREFIX}/api/tasks/${aTaskId}/archive`, { archived: true }, aliceCookie)
    check('归属人可归档自己的任务', aArch.status === 200, `status=${aArch.status}`)
    const aArchDel = await req('DELETE', `${PREFIX}/api/tasks/${aTaskId}`, undefined, aliceCookie)
    check('归属人可删除自己的任务', aArchDel.status === 200, `status=${aArchDel.status}`)
    const admTaskDel = await req('DELETE', `${PREFIX}/api/tasks/${admTaskId}`, undefined, adminCookie)
    check('归属人（管理员）可删除自己的任务', admTaskDel.status === 200, `status=${admTaskDel.status}`)

    // ---------- ⑩ 定时任务归属矩阵（§11：可见=归属人/admin；管理含手动 run） ----------
    const aSched = await req('POST', `${PREFIX}/api/schedules`, { name: '爱丽丝定时', message: '例行问候', rule: { kind: 'daily', times: ['09:00'] } }, aliceCookie)
    const aSchedId = aSched.json?.data?.id || ''
    check('普通用户建定时任务归属=自己', aSched.status === 200 && aSched.json?.data?.ownerUserId === aliceUid, `status=${aSched.status} owner=${aSched.json?.data?.ownerUserId}`)
    const admSched = await req('POST', `${PREFIX}/api/schedules`, { name: '管理员定时', message: '例行巡检', rule: { kind: 'daily', times: ['23:00'] } }, adminCookie)
    const admSchedId = admSched.json?.data?.id || ''
    check('管理员建定时任务归属=自己', admSched.status === 200 && admSched.json?.data?.ownerUserId === adminUid, `status=${admSched.status}`)
    const aSchedList = await req('GET', `${PREFIX}/api/schedules`, undefined, aliceCookie)
    check('普通用户定时列表不含他人定时任务', (aSchedList.json?.data || []).some((s) => s.id === aSchedId) && !(aSchedList.json?.data || []).some((s) => s.id === admSchedId))
    const aSchedGet = await req('GET', `${PREFIX}/api/schedules/${admSchedId}`, undefined, aliceCookie)
    check('普通用户读他人定时任务 404', aSchedGet.status === 404, `status=${aSchedGet.status}`)
    const aSchedDel = await req('DELETE', `${PREFIX}/api/schedules/${admSchedId}`, undefined, aliceCookie)
    check('普通用户删他人定时任务 404', aSchedDel.status === 404, `status=${aSchedDel.status}`)
    const aSchedRun = await req('POST', `${PREFIX}/api/schedules/${admSchedId}/run`, undefined, aliceCookie)
    check('普通用户手动触发他人定时任务 404', aSchedRun.status === 404, `status=${aSchedRun.status}`)
    const admSchedDel = await req('DELETE', `${PREFIX}/api/schedules/${aSchedId}`, undefined, adminCookie)
    check('管理员可删他人定时任务', admSchedDel.status === 200, `status=${admSchedDel.status}`)
    const aSchedDel2 = await req('DELETE', `${PREFIX}/api/schedules/${aSchedId}`, undefined, aliceCookie)
    check('普通用户删自己的定时任务', aSchedDel2.status === 200 || aSchedDel2.status === 404, `status=${aSchedDel2.status}`)
  } finally {
    cleanup()
    try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  console.log(results.join('\n'))
  console.log(`\n${failures === 0 ? '✅ 全部通过' : '❌ 失败 ' + failures + ' 项'}（共 ${results.length} 项）`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('E2E 执行异常:', err)
  cleanup()
  process.exit(1)
})
