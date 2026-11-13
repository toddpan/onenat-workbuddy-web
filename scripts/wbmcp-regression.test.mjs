import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = path.join(root, 'skills/workbuddy-mcp/scripts/wbmcp.sh');
const token = 'mock-workbuddy-token-DO-NOT-LOG';
const nodeKey = 'mock-node-api-key-DO-NOT-LOG';
const nodeSession = 'mock-node-session-DO-NOT-LOG';
const success = { content: [{ type: 'text', text: JSON.stringify({ ok: true, value: 'accepted' }) }] };

function reply(res, request, result = success, options = {}) {
  const envelope = { jsonrpc: '2.0', id: request.id, result };
  res.writeHead(options.status ?? 200, { 'Content-Type': 'text/event-stream', ...options.headers });
  res.end(`data: ${JSON.stringify(envelope)}\n\n`);
}

async function fixture(t, respond, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'wbmcp-regression-'));
  const config = path.join(dir, 'config.json');
  await writeFile(config, JSON.stringify({ baseUrl: 'http://127.0.0.1:1', token: 'unused-config-token' }));
  const uploadSource = path.join(dir, 'upload.txt');
  await writeFile(uploadSource, 'mock upload payload');
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    requests.push({ ...request, headers: req.headers });
    if (options.handshake && ['initialize', 'notifications/initialized'].includes(request.method)) {
      await options.handshake(req, res, request, requests);
    } else if (request.method === 'initialize') {
      reply(res, request, { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'mock', version: '1' } }, { headers: { 'Mcp-Session-Id': `session-${requests.length}` } });
    } else if (request.method === 'notifications/initialized') {
      res.writeHead(202).end();
    } else {
      await respond(req, res, request, requests);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return {
    requests,
    uploadSource,
    async session() {
      const files = (await readdir(dir)).filter(name => name.endsWith('.sid'));
      return files.length ? readFile(path.join(dir, files[0]), 'utf8') : null;
    },
    async run(args = ['call', 'invalid_readonly_probe', '{}'], options = {}) {
      return await new Promise((resolve, reject) => {
        const child = spawn('bash', [script, ...args], {
          cwd: root,
          env: { ...process.env, TMPDIR: dir, WORKBUDDY_CONFIG: config, WORKBUDDY_BASE_URL: `http://127.0.0.1:${server.address().port}`, WORKBUDDY_TOKEN: token, WORKBUDDY_TIMEOUT_SECONDS: '0.3' },
          detached: true,
        });
        let stdout = '', stderr = '', timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          process.kill(-child.pid, 'SIGKILL');
        }, options.deadline ?? 6000);
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal, stdout, stderr, timedOut });
        });
      });
    },
  };
}

function failed(result) {
  assert.equal(result.timedOut, false, 'CLI must finish before the test watchdog');
  assert.equal(result.signal, null, 'CLI must exit normally');
  assert.notEqual(result.code, 0, 'CLI must report failure with a nonzero exit status');
}

function succeeded(result) {
  assert.equal(result.timedOut, false);
  assert.equal(result.signal, null);
  assert.equal(result.code, 0, 'CLI must report success');
}

test('invalid_readonly_probe rejects ok:false text plus isError:true', async t => {
  const mock = await fixture(t, (_req, res, request) => reply(res, request, {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'invalid read-only probe' }) }],
    isError: true,
  }));
  const result = await mock.run(['call', 'workbuddy_task_manage', '{"action":"invalid_readonly_probe"}']);
  t.diagnostic(`observed CLI exit status: ${result.code}`);
  failed(result);
  assert.equal(businessRequests(mock).length, 1);
  assert.equal(businessRequests(mock)[0].params.name, 'workbuddy_task_manage');
  assert.equal(businessRequests(mock)[0].params.arguments.action, 'invalid_readonly_probe');
});

// These tests exercise the real bash/curl/Python CLI against the HTTP boundary.
// Keep each scenario's config and session cache private; reuse only within a test
// when verifying that a failed command makes the next command initialize again.
function rpcError(res, request, code = -32001) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code, message: 'mock failure' } })}\n\n`);
}

function businessRequests(mock) {
  return mock.requests.filter(request => !['initialize', 'notifications/initialized'].includes(request.method));
}

function initializeCount(mock) {
  return mock.requests.filter(request => request.method === 'initialize').length;
}

function noSecrets(result) {
  for (const secret of [token, nodeKey, nodeSession]) {
    assert.equal(result.stderr.includes(secret), false, 'stderr must not expose mock credentials');
  }
}

test('legal tools/call succeeds and uses the environment URL and bearer token', async t => {
  const mock = await fixture(t, (_req, res, request) => reply(res, request));
  const result = await mock.run(['call', 'workbuddy_task_status', '{"taskId":"task-83"}']);
  succeeded(result);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, value: 'accepted' });
  assert.equal(businessRequests(mock).length, 1);
  assert.equal(businessRequests(mock)[0].headers.authorization, `Bearer ${token}`);
  assert.deepEqual(businessRequests(mock)[0].params, { name: 'workbuddy_task_status', arguments: { taskId: 'task-83' } });
  noSecrets(result);
});

for (const [name, result] of [
  ['ok:false without isError', { content: [{ type: 'text', text: '{"ok":false,"error":"rejected"}' }] }],
  ['isError:true without ok:false', { content: [{ type: 'text', text: 'tool failed' }], isError: true }],
  ['structuredContent ok:false', { content: [], structuredContent: { ok: false, error: 'rejected' } }],
]) {
  test(`${name} fails without replay and clears the session`, async t => {
    let count = 0;
    const mock = await fixture(t, (_req, res, request) => reply(res, request, ++count === 1 ? result : success));
    failed(await mock.run());
    assert.equal(count, 1);
    succeeded(await mock.run());
    assert.equal(count, 2);
    assert.equal(initializeCount(mock), 2);
  });
}

test('ordinary text content remains a successful tool result', async t => {
  const mock = await fixture(t, (_req, res, request) => reply(res, request, { content: [{ type: 'text', text: 'plain tool output' }] }));
  const result = await mock.run();
  succeeded(result);
  assert.ok(result.stdout.includes('plain tool output'));
});

for (const code of [-32602, -32001]) {
  test(`RPC error ${code} fails once and the next command reinitializes`, async t => {
    let count = 0;
    const mock = await fixture(t, (_req, res, request) => ++count === 1 ? rpcError(res, request, code) : reply(res, request));
    failed(await mock.run());
    assert.equal(count, 1);
    succeeded(await mock.run());
    assert.equal(initializeCount(mock), 2);
    assert.equal(count, 2);
  });
}

for (const status of [401, 404, 500]) {
  test(`HTTP ${status} fails even with a valid success envelope and is not replayed`, async t => {
    let count = 0;
    const mock = await fixture(t, (_req, res, request) => reply(res, request, success, { status: ++count === 1 ? status : 200 }));
    failed(await mock.run());
    assert.equal(count, 1);
    succeeded(await mock.run());
    assert.equal(initializeCount(mock), 2);
  });
}

test('WORKBUDDY_TIMEOUT_SECONDS bounds a stalled response and clears the session', async t => {
  let count = 0;
  const mock = await fixture(t, (_req, res, request) => {
    if (++count > 1) reply(res, request);
    // The first socket intentionally stays open until curl times out.
  });
  const started = performance.now();
  failed(await mock.run());
  assert.ok(performance.now() - started < 5000, 'configured timeout must take effect');
  assert.equal(count, 1);
  succeeded(await mock.run());
  assert.equal(initializeCount(mock), 2);
});

for (const [name, contentType, body] of [
  ['non-JSON response', 'text/plain', 'upstream unavailable'],
  ['broken direct JSON', 'application/json', '{"jsonrpc":'],
  ['broken SSE JSON', 'text/event-stream', 'data: {"jsonrpc":\n\n'],
  ['SSE without data events', 'text/event-stream', 'event: message\nnot-data: {}\n\n'],
]) {
  test(`${name} fails without replay and clears the session`, async t => {
    let count = 0;
    const mock = await fixture(t, (_req, res, request) => {
      if (++count === 1) {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(body);
      } else reply(res, request);
    });
    failed(await mock.run());
    assert.equal(count, 1);
    succeeded(await mock.run());
    assert.equal(initializeCount(mock), 2);
  });
}

for (const kind of ['wrong response id', 'duplicate response id', 'bad frame after success']) {
  test(`${kind} fails without replay and clears the session`, async t => {
    let count = 0;
    const mock = await fixture(t, (_req, res, request) => {
      if (++count > 1) return reply(res, request);
      const envelope = { jsonrpc: '2.0', id: kind === 'wrong response id' ? request.id + 100 : request.id, result: success };
      const frame = `data: ${JSON.stringify(envelope)}\n\n`;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(kind === 'duplicate response id' ? frame + frame : kind === 'bad frame after success' ? frame + 'data: {broken\n\n' : frame);
    });
    failed(await mock.run());
    assert.equal(count, 1);
    succeeded(await mock.run());
    assert.equal(initializeCount(mock), 2);
  });
}

test('application/json response succeeds without replay', async t => {
  const mock = await fixture(t, (_req, res, request) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: success }));
  });
  const result = await mock.run();
  succeeded(result);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, value: 'accepted' });
  assert.equal(businessRequests(mock).length, 1);
});

test('CRLF and multiline SSE ignores notifications and selects the matching response', async t => {
  const mock = await fixture(t, (_req, res, request) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end([
      ': keepalive', '',
      'event: message',
      'data: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info"}}', '',
      `data: {"jsonrpc":"2.0","id":${request.id},`,
      `data: "result":${JSON.stringify(success)}}`, '', '',
    ].join('\r\n'));
  });
  const result = await mock.run();
  succeeded(result);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, value: 'accepted' });
  assert.equal(businessRequests(mock).length, 1);
});

test('tools/list prints a legal tool list', async t => {
  const mock = await fixture(t, (_req, res, request) => reply(res, request, { tools: [{ name: 'mock_tool', description: 'Mock description\nextra detail' }] }));
  const result = await mock.run(['tools']);
  succeeded(result);
  assert.match(result.stdout, /mock_tool/);
  assert.equal(businessRequests(mock).length, 1);
});

for (const failure of ['expired', 'HTTP404']) {
  test(`tools/list ${failure} is not replayed and the next invocation recovers`, async t => {
    let count = 0;
    const mock = await fixture(t, (_req, res, request) => {
      if (++count === 1) {
        if (failure === 'expired') rpcError(res, request);
        else reply(res, request, { tools: [] }, { status: 404 });
      } else reply(res, request, { tools: [] });
    });
    failed(await mock.run(['tools']));
    assert.equal(count, 1);
    succeeded(await mock.run(['tools']));
    assert.equal(initializeCount(mock), 2);
  });
}

for (const [action, tool, args] of [
  ['create', 'workbuddy_task_manage', { action: 'create', title: 'mock task' }],
  ['send', 'workbuddy_task_manage', { action: 'send', taskId: 'task-83', message: 'mock message' }],
  ['dispatch', 'workbuddy_backlog_manage', { action: 'dispatch', projectId: 'mock-project', itemId: 'TASK-83' }],
]) {
  for (const failure of ['disconnect', 'expired', 'HTTP404']) {
    test(`${action} ${failure} is received only once; next explicit call reinitializes`, async t => {
      let count = 0;
      const mock = await fixture(t, (req, res, request) => {
        if (++count > 1) return reply(res, request);
        if (failure === 'disconnect') req.socket.destroy();
        else if (failure === 'expired') rpcError(res, request);
        else reply(res, request, success, { status: 404 });
      });
      const command = ['call', tool, JSON.stringify(args)];
      failed(await mock.run(command));
      assert.equal(count, 1, 'a potentially accepted write must never be replayed');
      succeeded(await mock.run(['call', 'workbuddy_task_status', '{"taskId":"task-83"}']));
      assert.equal(initializeCount(mock), 2);
      assert.equal(businessRequests(mock).filter(request => request.params.arguments.action === action).length, 1);
    });
  }
}

for (const failure of ['disconnect', 'expired', 'HTTP404']) {
  test(`raw ${failure} is not replayed and the next invocation recovers`, async t => {
    let count = 0;
    const mock = await fixture(t, (req, res, request) => {
      if (++count > 1) return reply(res, request);
      if (failure === 'disconnect') req.socket.destroy();
      else if (failure === 'expired') rpcError(res, request);
      else reply(res, request, success, { status: 404 });
    });
    const command = ['raw', JSON.stringify({ jsonrpc: '2.0', id: 83, method: 'tools/call', params: { name: 'workbuddy_task_manage', arguments: { action: 'create' } } })];
    failed(await mock.run(command));
    assert.equal(count, 1);
    const result = await mock.run(command);
    succeeded(result);
    assert.equal(JSON.parse(result.stdout).id, 83);
    assert.equal(initializeCount(mock), 2);
  });
}

test('direct JSON initialize response establishes a reusable session', async t => {
  const mock = await fixture(t, (_req, res, request) => reply(res, request), {
    handshake(_req, res, request) {
      if (request.method === 'notifications/initialized') return res.writeHead(202).end();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'json-initialize-session' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'mock', version: '1' } } }));
    },
  });
  succeeded(await mock.run());
  succeeded(await mock.run());
  assert.equal(initializeCount(mock), 1);
  assert.equal(businessRequests(mock).length, 2);
  assert.equal(businessRequests(mock)[0].headers['mcp-session-id'], 'json-initialize-session');
});

for (const stage of ['initialize', 'notifications/initialized']) {
  test(`${stage} failure stops the command and the next invocation reinitializes`, async t => {
    let failedHandshake = false;
    const mock = await fixture(t, (_req, res, request) => reply(res, request), {
      handshake(_req, res, request) {
        if (!failedHandshake && request.method === stage) {
          failedHandshake = true;
          res.writeHead(401, { 'Content-Type': 'text/plain', 'Mcp-Session-Id': 'failed-session' });
          return res.end(`denied ${token} ${nodeKey} ${nodeSession}`);
        }
        if (request.method === 'notifications/initialized') return res.writeHead(202).end();
        reply(res, request, { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'mock', version: '1' } }, { headers: { 'Mcp-Session-Id': 'recovered-session' } });
      },
    });
    const result = await mock.run();
    failed(result);
    noSecrets(result);
    assert.equal(businessRequests(mock).length, 0);
    succeeded(await mock.run());
    assert.equal(initializeCount(mock), 2);
    assert.equal(businessRequests(mock).length, 1);
  });
}

for (const kind of ['tool failure', 'invalid direct recipe']) {
  test(`putfile ${kind} propagates failure without later upload or registration`, async t => {
    const mock = await fixture(t, (_req, res, request) => reply(res, request, {
      content: [{ type: 'text', text: JSON.stringify(kind === 'tool failure'
        ? { ok: false, error: 'init rejected' }
        : { ok: true, uploadId: 'mock-upload', direct: {} }) }],
    }));
    const result = await mock.run(['putfile', mock.uploadSource, 'task-83']);
    failed(result);
    noSecrets(result);
    assert.equal(businessRequests(mock).length, 1);
    assert.equal(businessRequests(mock)[0].params.name, 'workbuddy_file_manage');
    assert.equal(businessRequests(mock)[0].params.arguments.action, 'upload_resumable_init');
  });
}

test('failure diagnostics do not leak bearer tokens or node credentials', async t => {
  const mock = await fixture(t, (_req, res, request) => reply(res, request, {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: `failure ${token}`, direct: { apiKey: nodeKey, sessionId: nodeSession } }) }],
  }));
  const result = await mock.run();
  failed(result);
  noSecrets(result);
});

function sessionExpired(res, request) {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32001, message: 'expired', data: { code: 'SESSION_EXPIRED' } } }));
}

test('legacy SESSION_EXPIRED reinitializes and retries the original write once', async t => {
  let count = 0;
  const mock = await fixture(t, (_req, res, request) => ++count === 1 ? sessionExpired(res, request) : reply(res, request));
  succeeded(await mock.run(['call', 'workbuddy_task_manage', '{"action":"create","title":"legacy"}']));
  assert.equal(count, 2);
  assert.equal(initializeCount(mock), 2);
  assert.deepEqual(businessRequests(mock)[0].params, businessRequests(mock)[1].params);
});

test('persistent SESSION_EXPIRED stops after one compatibility retry', async t => {
  const mock = await fixture(t, (_req, res, request) => sessionExpired(res, request));
  const result = await mock.run();
  failed(result);
  assert.equal(businessRequests(mock).length, 2);
  assert.equal(initializeCount(mock), 2);
  assert.match(result.stderr, /persisted after one retry/);
});

test('successful response session header is cached for the next command', async t => {
  const mock = await fixture(t, (_req, res, request) => reply(res, request, success, { headers: { 'Mcp-Session-Id': 'rotated-session' } }));
  succeeded(await mock.run());
  assert.equal(await mock.session(), 'rotated-session');
  succeeded(await mock.run());
  assert.equal(businessRequests(mock)[1].headers['mcp-session-id'], 'rotated-session');
  assert.equal(initializeCount(mock), 1);
});

for (const failing of [null, 'tools/list', 'ping']) {
  test(`probe reports actual stages (${failing ?? 'success'})`, async t => {
    const mock = await fixture(t, (_req, res, request) => request.method === failing
      ? rpcError(res, request)
      : reply(res, request, request.method === 'tools/list' ? { tools: [] } : {}));
    const result = await mock.run(['probe']);
    if (failing) failed(result); else succeeded(result);
    assert.deepEqual(JSON.parse(result.stdout), { handshake: 'passed', 'tools/list': failing === 'tools/list' ? 'failed' : 'passed', ping: failing === 'ping' ? 'failed' : 'passed' });
    noSecrets(result);
  });
}

test('probe handshake failure reports remaining stages skipped', async t => {
  const mock = await fixture(t, () => {}, { handshake(_req, res) { res.writeHead(401).end(); } });
  const result = await mock.run(['probe']);
  failed(result);
  assert.deepEqual(JSON.parse(result.stdout), { handshake: 'failed', 'tools/list': 'skipped', ping: 'skipped' });
  assert.equal(businessRequests(mock).length, 0);
});
