import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildWorkspaceAccessSection, installWorkspaceAccessCli, workspaceShellQuote, WORKSPACE_ACCESS_CLI_NAME, isWorkspaceAccessCliPath } from '../dist/workspace-access.js'

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

test('stable owner injects mapping and directory credentials without a fixed helper endpoint', () => {
  const section = buildWorkspaceAccessSection({ workspace: '/project', baseUrl: 'https://old-port/api/v1', apiKey: 'node-key', cliPath: '/session/helper.mjs', nodeRef: { kind: 'mapping', mappingId: 'owner' }, onenatBaseUrl: 'https://directory', onenatApiKey: "catalog'key" })
  const prefix = section.split('\n').find(line => line.includes('使用前缀:'))
  assert.ok(prefix.includes("--node-ref 'mapping:owner'"))
  assert.ok(prefix.includes("--onenat-base 'https://directory'"))
  assert.ok(prefix.includes('WORKBUDDY_ONENAT_API_KEY=' + workspaceShellQuote("catalog'key")))
  assert.ok(!prefix.includes('--base ') && !prefix.includes('old-port'))
  assert.ok(section.includes('每次请求') && section.includes('临时会话清理'))
})

test('missing helper never promises remote write or command support', () => {
  const section = buildWorkspaceAccessSection({ workspace: '/project', baseUrl: 'https://owner/api/v1' })
  assert.ok(section.includes('写入和命令执行不可用'))
  assert.ok(section.includes('/fs/list?path=') && section.includes('&all=1'))
})

test('numbered DSH helper upload remains installed and cached, only matching absolute versioned paths qualify', async () => {
  for (const name of [WORKSPACE_ACCESS_CLI_NAME, '.workbuddy-workspace-remote-v3-1.mjs', '.workbuddy-workspace-remote-v3-12.mjs']) {
    const path = '/shared/' + name;
    const installed = await installWorkspaceAccessCli({ uploadFiles: async () => ({ ok: true, files: [{ name, path }] }) }, {}, 'child');
    assert.equal(installed, path);
    assert.equal(isWorkspaceAccessCliPath(path), true);
  }
  for (const file of [
    { name: '.workbuddy-workspace-remote.mjs', path: '/shared/.workbuddy-workspace-remote.mjs' },
    { name: '.workbuddy-workspace-remote-v2.mjs', path: '/shared/.workbuddy-workspace-remote-v2.mjs' },
    { name: '.workbuddy-workspace-remote-v2-1.mjs', path: '/shared/.workbuddy-workspace-remote-v2-1.mjs' },
    { name: '.workbuddy-workspace-remote-v30.mjs', path: '/shared/.workbuddy-workspace-remote-v30.mjs' },
    { name: WORKSPACE_ACCESS_CLI_NAME, path: 'relative/' + WORKSPACE_ACCESS_CLI_NAME },
    { name: WORKSPACE_ACCESS_CLI_NAME, path: '/shared/unrelated.mjs' },
  ]) {
    assert.equal(await installWorkspaceAccessCli({ uploadFiles: async () => ({ ok: true, files: [file] }) }, {}, 'child'), undefined);
    assert.equal(isWorkspaceAccessCliPath(file.path), false);
  }
});

test('helper upload includes no project credentials and uses target session', async () => {
  let upload
  const path = await installWorkspaceAccessCli({ uploadFiles: async (...args) => {
    upload = args
    return { ok: true, files: [{ name: WORKSPACE_ACCESS_CLI_NAME, path: '/session/' + WORKSPACE_ACCESS_CLI_NAME }] }
  } }, { baseUrl: 'https://executor', apiKey: 'execution-secret' }, 'session-id')
  assert.equal(path, '/session/' + WORKSPACE_ACCESS_CLI_NAME)
  assert.equal(upload[1], 'session-id')
  assert.ok(!upload[2][0].data.toString().includes('execution-secret'))
  assert.equal(await installWorkspaceAccessCli({ uploadFiles: async () => ({ ok: false }) }, {}, 'session'), undefined)
})
