/**
 * AI 接入安装提示词（src/ai-install.ts）单测。
 *
 * 覆盖：base 归一化与非法拒绝、URL 拼接、token/占位符与 hasToken、三段标题、
 * 与旧 Web 正文一致的关键行（仅搬位置、不改文案）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AI_INSTALL_BASE_MAX_LEN,
  AI_INSTALL_PROMPT_VERSION,
  AI_INSTALL_TOKEN_PLACEHOLDER,
  buildAiInstallPayload,
  buildAiInstallPrompt,
  normalizeInstallBase,
} from './ai-install.js'

const BASE = 'https://wb.example.com/onenat-workbuddy'
const TOKEN = 'wbk-test-token'

test('normalizeInstallBase：去尾部斜杠 + 丢弃 query/hash', () => {
  assert.equal(normalizeInstallBase(BASE), BASE)
  assert.equal(normalizeInstallBase(BASE + '/'), BASE)
  assert.equal(normalizeInstallBase(BASE + '///'), BASE)
  assert.equal(normalizeInstallBase('  ' + BASE + '/  '), BASE)
  assert.equal(normalizeInstallBase(BASE + '/?x=1#frag'), BASE)
  assert.equal(normalizeInstallBase('https://wb.example.com/'), 'https://wb.example.com')
  assert.equal(normalizeInstallBase('http://127.0.0.1:3081/onenat-workbuddy/'), 'http://127.0.0.1:3081/onenat-workbuddy')
})

test('normalizeInstallBase：非法输入返回 null', () => {
  assert.equal(normalizeInstallBase(''), null)
  assert.equal(normalizeInstallBase('   '), null)
  assert.equal(normalizeInstallBase(null), null)
  assert.equal(normalizeInstallBase(undefined), null)
  assert.equal(normalizeInstallBase(123), null)
  assert.equal(normalizeInstallBase('wb.example.com'), null)
  assert.equal(normalizeInstallBase('ftp://wb.example.com'), null)
  assert.equal(normalizeInstallBase('javascript:alert(1)'), null)
  assert.equal(normalizeInstallBase('//wb.example.com'), null)
  assert.equal(normalizeInstallBase('https://'), null)
  assert.equal(normalizeInstallBase('https://wb.example.com/a\nb'), null)
  assert.equal(normalizeInstallBase('https://wb.example.com/a\tb'), null)
  assert.equal(normalizeInstallBase('https://wb.example.com/\u0000'), null)
  assert.equal(normalizeInstallBase('https://wb.example.com/' + 'a'.repeat(AI_INSTALL_BASE_MAX_LEN)), null)
})

test('buildAiInstallPrompt：URL 拼接正确（mcp / expert mcp / 安装脚本）', () => {
  const prompt = buildAiInstallPrompt(BASE, TOKEN)
  assert.ok(prompt.includes(BASE + '/install-skill.sh | bash -s -- --base-url ' + BASE + ' --token ' + TOKEN))
  assert.ok(prompt.includes('服务地址（Streamable HTTP，JSON-RPC over POST）：' + BASE + '/mcp'))
  assert.ok(prompt.includes('{ "mcpServers": { "onenat-workbuddy": { "url": "' + BASE + '/mcp", "headers": { "Authorization": "Bearer ' + TOKEN + '" } } } }'))
})

test('buildAiInstallPrompt：含三段标题与完成汇报', () => {
  const prompt = buildAiInstallPrompt(BASE, TOKEN)
  for (const heading of ['【第 1 步 · 一键安装（有终端就先做这步）】', '【第 2 步 · MCP 原生注册（仅宿主支持 MCP 时叠加，否则跳过）】', '【使用约定（两通道一致）】', '【完成汇报】']) {
    assert.ok(prompt.includes(heading), '缺少标题: ' + heading)
  }
  assert.ok(prompt.startsWith('请把「OneNat WorkBuddy 多智能体工作台」接入为你的工具平台并验证可用。'))
  assert.ok(prompt.endsWith('说明：宿主类型与所选通道（脚本/MCP/两者）、安装与注册写入的位置、验证结果；若失败，给出原因。'))
  // 无结尾换行（与旧 Web 端 textarea 内容逐字一致）
  assert.ok(!prompt.endsWith('\n'))
})

test('buildAiInstallPrompt：无 token 时用占位符，正文仍完整', () => {
  const prompt = buildAiInstallPrompt(BASE, '')
  assert.ok(prompt.includes('--token ' + AI_INSTALL_TOKEN_PLACEHOLDER))
  assert.ok(prompt.includes('鉴权：Authorization: Bearer ' + AI_INSTALL_TOKEN_PLACEHOLDER))
  assert.ok(prompt.includes('"Authorization": "Bearer ' + AI_INSTALL_TOKEN_PLACEHOLDER + '"'))
  assert.ok(!prompt.includes('Bearer （'))
  assert.ok(prompt.includes('【第 1 步') && prompt.includes('【第 2 步') && prompt.includes('【使用约定（两通道一致）】'))
})

test('buildAiInstallPayload：字段齐全、token 权威、hasToken 正确', () => {
  const withToken = buildAiInstallPayload(BASE, TOKEN)
  assert.equal(withToken.version, AI_INSTALL_PROMPT_VERSION)
  assert.equal(withToken.version, 1)
  assert.equal(withToken.base, BASE)
  assert.equal(withToken.token, TOKEN)
  assert.equal(withToken.hasToken, true)
  assert.equal(withToken.mcpUrl, BASE + '/mcp')
  assert.equal(withToken.expertMcpUrl, BASE + '/api/experts/mcp')
  assert.equal(withToken.installScriptUrl, BASE + '/install-skill.sh')
  assert.equal(withToken.installPrompt, buildAiInstallPrompt(BASE, TOKEN))

  const noToken = buildAiInstallPayload(BASE, '')
  assert.equal(noToken.token, '')
  assert.equal(noToken.hasToken, false)
  assert.ok(noToken.installPrompt.includes(AI_INSTALL_TOKEN_PLACEHOLDER))
  // 同一入参两次生成应完全一致（纯函数，无隐藏状态）
  assert.equal(buildAiInstallPrompt(BASE, TOKEN), buildAiInstallPrompt(BASE, TOKEN))
})
