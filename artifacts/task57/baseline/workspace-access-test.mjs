import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildWorkspaceAccessSection, installWorkspaceAccessCli, workspaceShellQuote } from '../dist/workspace-access.js'

test('remote workspace instructions separate owner files from local execution and quote literal arguments', () => {
  const section = buildWorkspaceAccessSection({ workspace: "/project/a ' $(touch nope)", baseUrl: 'https://node.example/api/v1/', apiKey: "key'$(nope)", cliPath: "/tmp/helper ' file.mjs" })
  assert.ok(section.includes('不是当前节点的本地 cwd'))
  assert.ok(section.includes('WORKBUDDY_WORKSPACE_API_KEY='))
  assert.ok(section.includes(workspaceShellQuote("key'$(nope)")))
  assert.ok(section.includes('SHA256'))
  assert.ok(section.includes('临时 DSH 会话'))
  assert.ok(section.includes('list/read/write/exec'))
  assert.ok(section.includes(workspaceShellQuote('https://node.example/api/v1/fs/download?path=' + encodeURIComponent("/project/a ' $(touch nope)/a.txt"))))
})

test('missing helper never promises remote write or command support', () => {
  const section = buildWorkspaceAccessSection({ workspace: '/project', baseUrl: 'https://owner/api/v1' })
  assert.ok(section.includes('写入和命令执行不可用'))
  assert.ok(section.includes('/fs/list?path=') && section.includes('&all=1'))
})

test('helper upload includes no project credentials and uses target session', async () => {
  let upload
  const path = await installWorkspaceAccessCli({ uploadFiles: async (...args) => {
    upload = args
    return { ok: true, files: [{ name: '.workbuddy-workspace-remote.mjs', path: '/session/.workbuddy-workspace-remote.mjs' }] }
  } }, { baseUrl: 'https://executor', apiKey: 'execution-secret' }, 'session-id')
  assert.equal(path, '/session/.workbuddy-workspace-remote.mjs')
  assert.equal(upload[1], 'session-id')
  assert.ok(!upload[2][0].data.toString().includes('execution-secret'))
  assert.equal(await installWorkspaceAccessCli({ uploadFiles: async () => ({ ok: false }) }, {}, 'session'), undefined)
})
