/**
 * AuthService 多用户 + 邀请机制单测。
 *
 * 覆盖：旧版 auth.json 迁移（补 id/role/status）、管理员邀请 → 链接激活全流程、
 * token 状态机（无效/过期/重复使用）、邮箱唯一性、密码策略、
 * admin 保护（最后一个管理员不可降级/禁用/删除）、禁用即吊销会话、登录邮箱别名。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthService, INVITE_TTL_MS } from './auth.js'

function makeAuth(seed = true): { auth: AuthService; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'wb-auth-test-'))
  const auth = new AuthService(dir, seed ? 'admin' : '', seed ? 'admin-pass-1' : '')
  return { auth, dir }
}

function cleanup(dir: string) {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

test('旧版 auth.json 自动迁移：补齐 id/role/status（存量账号=管理员）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb-auth-mig-'))
  try {
    // 旧格式：仅 username/salt/hash/createdAt
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({
      users: [{ username: 'legacy', salt: 'aa', hash: 'bb', createdAt: 1 }],
    }))
    const auth = new AuthService(dir, 'x', 'y')
    const users = auth.listUsers()
    assert.equal(users.length, 1)
    assert.match(users[0].id, /^usr-/)
    assert.equal(users[0].role, 'admin')
    assert.equal(users[0].status, 'active')
    // 迁移结果已落盘
    const raw = JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf-8'))
    assert.ok(raw.users[0].id)
  } finally {
    cleanup(dir)
  }
})


test('管理员邀请 → 链接激活 → 登录全流程', async () => {
  const { auth, dir } = makeAuth()
  try {
    const result = auth.createUserInvite('User@Example.COM ', '张三')
    assert.ok('user' in result)
    assert.equal(result.user.status, 'invited')
    assert.equal(result.user.username, 'user@example.com') // 邮箱小写归一化
    assert.ok(result.token.length >= 40) // 256 位熵 base64url

    // 回显（不消耗）
    const info = auth.inspectInvite(result.token)
    assert.ok(info.valid && info.email === 'user@example.com')

    // 弱密码拒绝
    const weak = await auth.acceptInvite(result.token, 'short1', '')
    assert.equal(weak.ok, false)
    const noDigit = await auth.acceptInvite(result.token, 'abcdefghij', '')
    assert.equal(noDigit.ok, false)

    // 正常激活 + 自动登录会话
    const ok = await auth.acceptInvite(result.token, 'Passw0rd123', '')
    assert.equal(ok.ok, true)
    const sess = auth.validateSession(ok.ok ? ok.sessionToken : '')
    assert.ok(sess && sess.role === 'user' && sess.username === 'user@example.com')

    // token 一次性：重复使用拒绝
    const again = await auth.acceptInvite(result.token, 'Passw0rd123', '')
    assert.equal(again.ok, false)

    // 激活后可用邮箱登录（大小写不敏感）
    const token = await auth.login('USER@EXAMPLE.COM', 'Passw0rd123', '127.0.0.1')
    assert.ok(token)
    // invited 态不可登录（密码占位随机，必然失败）已由 status=active 门控覆盖
  } finally {
    cleanup(dir)
  }
})

test('token 状态机：无效 / 撤销（重发后旧链接失效）', async () => {
  const { auth, dir } = makeAuth()
  try {
    assert.equal(auth.inspectInvite('no-such-token').valid, false)
    const r1 = auth.createUserInvite('a@x.com', '')
    assert.ok('token' in r1)
    const r2 = auth.resendInvite(r1.user.id)
    assert.ok(r2)
    assert.notEqual(r2, r1.token)
    assert.equal(auth.inspectInvite(r1.token).valid, false) // 旧 token 作废
    assert.equal(auth.inspectInvite(r2!).valid, true)
  } finally {
    cleanup(dir)
  }
})

test('邮箱唯一性：重复创建返回 conflict，可重发', async () => {
  const { auth, dir } = makeAuth()
  try {
    const r1 = auth.createUserInvite('dup@x.com', '')
    assert.ok('user' in r1)
    const r2 = auth.createUserInvite('DUP@x.com', '')
    assert.ok('conflict' in r2)
    assert.match(r2.conflict, /已存在/)
    assert.ok(auth.resendInvite(r1.user.id))
  } finally {
    cleanup(dir)
  }
})

test('admin 保护：最后一个管理员不可降级/禁用/删除；禁用即吊销会话', async () => {
  const { auth, dir } = makeAuth()
  try {
    const users = auth.listUsers()
    const admin = users.find((u) => u.role === 'admin')!
    assert.equal(auth.setRole(admin.id, 'user').ok, false)
    assert.equal(auth.setUserStatus(admin.id, 'disabled').ok, false)
    assert.equal(auth.softDeleteUser(admin.id).ok, false)

    // 第二名管理员就位后：可禁用其中一人（仍有 active 管理员），禁用即吊销会话
    const r = auth.createUserInvite('second@x.com', '')
    assert.ok('token' in r)
    await auth.acceptInvite(r.token, 'Passw0rd123', '')
    assert.equal(auth.setRole(r.user.id, 'admin').ok, true)
    const loginToken = await auth.login('second@x.com', 'Passw0rd123', '127.0.0.1')
    assert.ok(loginToken)
    assert.equal(auth.setUserStatus(r.user.id, 'disabled').ok, true)
    // 禁用后该用户会话即时失效
    assert.equal(auth.validateSession(loginToken!), undefined)

    // 启用后可降级原管理员（第二名管理员 active）
    assert.equal(auth.setUserStatus(r.user.id, 'active').ok, true)
    assert.equal(auth.setRole(admin.id, 'user').ok, true)
  } finally {
    cleanup(dir)
  }
})

test('邀请有效期常量与过期拒绝', async () => {
  assert.equal(INVITE_TTL_MS, 72 * 60 * 60 * 1000)
  const { auth, dir } = makeAuth()
  try {
    const r = auth.createUserInvite('exp@x.com', '')
    assert.ok('token' in r)
    // 直接把库中 token 过期时间拨回过去
    const { readFileSync, writeFileSync } = await import('node:fs')
    const p = join(dir, 'auth.json')
    const raw = JSON.parse(readFileSync(p, 'utf-8'))
    raw.invites[0].expiresAt = Date.now() - 1000
    writeFileSync(p, JSON.stringify(raw))
    const auth2dir = dir
    void auth2dir
    // 重建实例读取过期状态
    const auth2 = new AuthService(auth2dir, '', '')
    const info = auth2.inspectInvite(r.token)
    assert.equal(info.valid, false)
    assert.match(info.valid ? '' : info.reason, /过期/)
  } finally {
    cleanup(dir)
  }
})

// 防止 unused 警告
void createHash; void randomBytes; void existsSync
