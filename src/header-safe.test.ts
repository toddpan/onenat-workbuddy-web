/**
 * HTTP 头安全字符校验回归测试（header-safe.ts）。
 *
 * 背景（2026-11-06 线上事故）：pjy-DSH 映射的 API Key 在 ONENAT 后台被误粘贴为
 * 一段中文文本，WorkBuddy 构造 Authorization: Bearer <key> 时 undici 抛
 * "Cannot convert argument to a ByteString because the character at index 7 has a
 * value of 22235 which is greater than 255"（22235 = '四' U+56DB，恰在 "Bearer "
 * 之后的 index 7），「从远程 DSH 导入项目 → 获取工作区列表」整条链路只显示这句天书。
 * 修复后：凭证拉取层拒绝坏 key（ok:false + 可操作文案），头构造层兜底抛同文案。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { firstUnsafeHeaderChar, unsafeApiKeyError } from './header-safe.js'
import { DshClient } from './remote-client.js'

test('firstUnsafeHeaderChar：复现线上事故字符串（index 7 = 四 U+56DB/22235）', () => {
  // 精确重构事故 Authorization 值："Bearer " 占 0-6，index 7 = key 首字「四」
  const authValue = 'Bearer ' + '四、TaskPerf 首动分段耗时'
  const bad = firstUnsafeHeaderChar(authValue)
  assert.ok(bad, '应检出不安全字符')
  assert.equal(bad.index, 7)
  assert.equal(bad.code, 22235)
  assert.equal(bad.ch, '四')
})

test('firstUnsafeHeaderChar：正常 ASCII key 应通过；高位/控制/emoji 应拦截', () => {
  assert.equal(firstUnsafeHeaderChar('onk-2d483fbaf1dffe489223cd1fb34dc14c4f38c5fb'), undefined)
  assert.equal(firstUnsafeHeaderChar('0ab06d5c9e8f'), undefined)
  assert.equal(firstUnsafeHeaderChar(''), undefined)
  assert.equal(firstUnsafeHeaderChar('oké')?.index, 2)
  assert.equal(firstUnsafeHeaderChar('a	b')?.index, 1)
  assert.equal(firstUnsafeHeaderChar('a😀b')?.index, 1)
})

test('unsafeApiKeyError：文案含定位信息与操作指引', () => {
  const msg = unsafeApiKeyError('映射 API Key', '四、TaskPerf 首动分段耗时')
  assert.ok(msg.includes('映射 API Key'))
  assert.ok(msg.includes('U+56DB'))
  assert.ok(msg.includes('22235'))
  assert.ok(msg.includes('四'))
  assert.ok(msg.includes('ONENAT 后台'))
})

test('unsafeApiKeyError：安全值返回空串', () => {
  assert.equal(unsafeApiKeyError('映射 API Key', 'good-key'), '')
})

test('DshClient.headers 兜底：坏 key 抛可操作错误而非 ByteString 天书', () => {
  const client = new DshClient() as any
  assert.throws(() => client.headers('四、中文误粘贴'), /非 ASCII/)
  assert.throws(() => client.headersAuth('  四、中文误粘贴  '), /ONENAT 后台/)
})

test('DshClient.headers 兜底：正常 key 仍生成 Bearer 头', () => {
  const client = new DshClient() as any
  assert.deepEqual(client.headers(' onk-abc '), {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: 'Bearer onk-abc',
  })
  assert.deepEqual(client.headersAuth('onk-abc'), { Accept: 'application/json', Authorization: 'Bearer onk-abc' })
  assert.deepEqual(client.headers(undefined), { 'Content-Type': 'application/json', Accept: 'application/json' })
})

test('DshClient.listWorkspaces：坏 key 不经网络即快速失败并返回友好文案', async () => {
  const client = new DshClient()
  const r = await client.listWorkspaces({ baseUrl: 'http://127.0.0.1:1', apiKey: '四、TaskPerf 首动分段耗时' })
  assert.equal(r.ok, false)
  assert.ok(r.error && r.error.includes('非 ASCII'))
  assert.ok(!r.error!.includes('ByteString'), '不应透传 undici 天书')
})
