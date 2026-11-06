#!/usr/bin/env node
// node --test scripts/workspace-remote-test.mjs (Node >=20, POSIX)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, symlink, rm, readdir, unlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { remote, resolveWorkspaceTarget, makeCommand, shellQuote } from './workspace-remote.mjs';

const script = fileURLToPath(new URL('./workspace-remote.mjs', import.meta.url));
const sha = (s) => createHash('sha256').update(s).digest('hex');
const b64 = (s) => Buffer.from(s).toString('base64');
const run = (exe, argv, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(exe, argv, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [], stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.on('error', reject);
  child.on('close', (code) => resolve({ code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
});
const req = (root, operation, rest = {}) => ({ operation, root, nonce: randomBytes(24).toString('hex'), ...rest });
const decode = (stdout, request) => {
  const prefix = `WORKSPACE_REMOTE_RESULT:${request.nonce}:`;
  assert.ok(stdout.trim().startsWith(prefix), stdout);
  return JSON.parse(Buffer.from(stdout.trim().slice(prefix.length), 'base64').toString());
};
async function local(request) {
  const output = await run(process.execPath, [script, '--worker', b64(JSON.stringify(request))]);
  const result = decode(output.stdout, request);
  assert.equal(output.code, result.ok ? 0 : 1, output.stderr);
  return result;
}
async function fixture(t) {
  const base = await mkdtemp(path.join(tmpdir(), "workspace-remote-' quote $-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'root'); await mkdir(root);
  await writeFile(path.join(root, 'input.txt'), 'original');
  await writeFile(path.join(base, 'secret.txt'), 'secret');
  await symlink(base, path.join(root, 'escape'));
  await symlink(path.join(base, 'secret.txt'), path.join(root, 'secret-link'));
  return { base, root };
}

test('worker binary read, listing, atomic create/update and stale CAS', async (t) => {
  const { root } = await fixture(t);
  const listing = await local(req(root, 'list'));
  assert.equal(listing.ok, true);
  assert.ok(listing.entries.some((e) => e.name === 'escape' && e.type === 'symlink'));
  const read = await local(req(root, 'read', { path: 'input.txt' }));
  assert.equal(read.sha256, sha('original')); assert.equal(read.contentBase64, b64('original'));
  const created = await local(req(root, 'write', { path: 'new.bin', expectAbsent: true, contentBase64: b64(Buffer.from([0, 255, 39])) }));
  assert.equal(created.ok, true);
  assert.deepEqual(await readFile(path.join(root, 'new.bin')), Buffer.from([0, 255, 39]));
  assert.equal((await local(req(root, 'write', { path: 'new.bin', expectAbsent: true, contentBase64: b64('bad') }))).code, 'CAS_MISMATCH');
  assert.equal((await local(req(root, 'write', { path: 'input.txt', expectedSha256: sha('original'), contentBase64: b64('updated') }))).ok, true);
  assert.equal((await local(req(root, 'write', { path: 'input.txt', expectedSha256: sha('original'), contentBase64: b64('stale') }))).code, 'CAS_MISMATCH');
  assert.equal(await readFile(path.join(root, 'input.txt'), 'utf8'), 'updated');
  assert.deepEqual((await readdir(root)).filter((p) => p.startsWith('.workspace-remote.')), []);
});

test('realpath containment rejects traversal, sibling prefixes, final and parent symlinks', async (t) => {
  const { base, root } = await fixture(t);
  await mkdir(path.join(base, 'root-sibling')); await writeFile(path.join(base, 'root-sibling', 'x'), 'x');
  for (const target of ['../secret.txt', path.join(base, 'secret.txt'), path.join(base, 'root-sibling', 'x'), 'escape/secret.txt', 'secret-link']) {
    const r = await local(req(root, 'read', { path: target }));
    assert.equal(r.ok, false, target); assert.ok(['OUTSIDE_ROOT', 'SYMLINK'].includes(r.code), JSON.stringify(r));
    const w = await local(req(root, 'write', { path: target, expectAbsent: true, contentBase64: b64('unsafe') }));
    assert.equal(w.ok, false, target);
  }
  assert.equal((await local(req(root, 'list', { path: 'escape' }))).code, 'SYMLINK');
  assert.equal((await local(req(root, 'write', { path: 'escape/new', expectAbsent: true, contentBase64: b64('unsafe') }))).code, 'SYMLINK');
  assert.equal(await readFile(path.join(base, 'secret.txt'), 'utf8'), 'secret');
  assert.equal((await local(req(root, 'read', { path: '.workspace-remote.lock' }))).code, 'RESERVED');
});

test('read and list output budgets are explicit', async (t) => {
  const { root } = await fixture(t);
  await writeFile(path.join(root, 'large'), Buffer.alloc(8 * 1024 * 1024 + 1));
  assert.equal((await local(req(root, 'read', { path: 'large' }))).code, 'OUTPUT_LIMIT');
  const dir = path.join(root, 'many'); await mkdir(dir);
  await Promise.all(Array.from({ length: 2001 }, (_, i) => writeFile(path.join(dir, String(i)), '')));
  const listed = await local(req(root, 'list', { path: 'many' }));
  assert.equal(listed.ok, true); assert.equal(listed.truncated, true); assert.equal(listed.entries.length, 2000);
});

test('CAS races produce exactly one winner for both update and expect-absent', async (t) => {
  const { root } = await fixture(t);
  for (const [target, guard] of [['input.txt', { expectedSha256: sha('original') }], ['race.txt', { expectAbsent: true }]]) {
    const results = await Promise.all(['A', 'B', 'C', 'D'].map((s) => local(req(root, 'write', { path: target, contentBase64: b64(s), ...guard }))));
    assert.equal(results.filter((r) => r.ok).length, 1);
    assert.equal(results.filter((r) => r.code === 'CAS_MISMATCH').length, 3);
    assert.match(await readFile(path.join(root, target), 'utf8'), /^[ABCD]$/);
  }
});

test('exec requires CAS, checks boundaries and serializes aliases of one real root', async (t) => {
  const { base, root } = await fixture(t);
  const guards = [{ path: 'input.txt', expectedSha256: sha('original') }];
  assert.equal((await local(req(root, 'exec', { argv: [process.execPath, '--version'] }))).code, 'INVALID');
  assert.equal((await local(req(root, 'exec', { guards: [{ path: '../secret.txt', expectedSha256: sha('secret') }], argv: [process.execPath, '--version'] }))).code, 'OUTSIDE_ROOT');
  assert.equal((await local(req(root, 'exec', { guards: [{ path: 'input.txt', expectedSha256: sha('stale') }], argv: [process.execPath, '-e', 'throw Error("must not run")'] }))).code, 'CAS_MISMATCH');
  const alias = path.join(base, 'alias'); await symlink(root, alias);
  const program = `const fs=require('node:fs');fs.appendFileSync('events','start '+process.argv[1]+'\\n');setTimeout(()=>fs.appendFileSync('events','end '+process.argv[1]+'\\n'),120);`;
  const results = await Promise.all([root, alias, root].map((cwd, i) => local(req(cwd, 'exec', { guards, argv: [process.execPath, '-e', program, String(i)] }))));
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  const lines = (await readFile(path.join(root, 'events'), 'utf8')).trim().split('\n');
  for (let i = 0; i < lines.length; i += 2) { assert.match(lines[i], /^start /); assert.equal(lines[i + 1], lines[i].replace('start ', 'end ')); }
});

test('exec timeout, output bound, nonzero exit and stale lock fail explicitly', async (t) => {
  const { root } = await fixture(t);
  const guards = [{ path: 'input.txt', expectedSha256: sha('original') }];
  const timeout = await local(req(root, 'exec', { guards, argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], timeoutMs: 60 }));
  assert.equal(timeout.code, 'EXEC_TIMEOUT'); assert.equal(timeout.timedOut, true);
  assert.equal((await local(req(root, 'exec', { guards, argv: [process.execPath, '-e', 'process.exit(7)'] }))).exitCode, 7);
  assert.equal((await local(req(root, 'exec', { guards, argv: [process.execPath, '-e', 'process.stdout.write(Buffer.alloc(5*1024*1024))'] }))).code, 'OUTPUT_LIMIT');
  await writeFile(path.join(root, '.workspace-remote.lock'), 'stale');
  assert.equal((await local(req(root, 'read', { path: 'input.txt', lockTimeoutMs: 50 }))).code, 'LOCK_TIMEOUT');
  await unlink(path.join(root, '.workspace-remote.lock'));
  assert.equal((await local(req(root, 'read', { path: 'input.txt' }))).ok, true);
});

test('shell quoting preserves arbitrary strings and executes embedded worker', async (t) => {
  const { root } = await fixture(t);
  const text = `quote ' " $HOME $(touch forbidden) \nline`;
  const quoted = await run('bash', ['-c', `printf %s ${shellQuote(text)}`]);
  assert.equal(quoted.stdout, text);
  const request = req(root, 'write', { path: "quoted '$ file", expectAbsent: true, contentBase64: b64(text) });
  const output = await run('bash', ['-c', makeCommand(request)]);
  assert.equal(output.code, 0, output.stderr); assert.equal(decode(output.stdout, request).ok, true);
  assert.equal(await readFile(path.join(root, "quoted '$ file"), 'utf8'), text);
});

async function mockDSH(t, sessions = new Set()) {
  const requests = [];
  const roots = sessions.roots ??= new Map();
  let mode = 'run';
  const server = createServer(async (incoming, response) => {
    const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const multipart = String(incoming.headers['content-type'] || '').startsWith('multipart/');
    const body = raw.length && !multipart ? JSON.parse(raw.toString()) : null;
    const route = incoming.url; requests.push({ method: incoming.method, route, body, authorization: incoming.headers.authorization });
    const send = (status, data) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
    try {
      if (route === '/api/v1/sessions' && incoming.method === 'POST') {
        assert.deepEqual(Object.keys(body).sort(), ['cwd', 'title']);
        const id = randomBytes(8).toString('hex'); sessions.add(id); roots.set(id, body.cwd); return send(201, { ok: true, data: { sessionId: id } });
      }
      if (route.startsWith('/api/v1/fs/download?')) {
        const target = new URL(route, 'http://mock').searchParams.get('path');
        try {
          let value = JSON.parse(await readFile(target, 'utf8'));
          if (mode === 'result-bad-json') { await writeFile(target + '.tmp', 'sensitive incomplete result'); response.writeHead(200); return response.end('{"nonce":'); }
          if (mode === 'result-header-limit') { response.writeHead(200, { 'Content-Length': String(32 * 1024 * 1024 + 1) }); response.flushHeaders(); return; }
          if (mode === 'result-stream-limit') {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            const chunk = Buffer.alloc(1024 * 1024, 32);
            for (let i = 0; i < 33 && !response.destroyed; i++) {
              if (!response.write(chunk)) await new Promise(resolve => {
                const complete = () => { response.off('drain', complete); response.off('close', complete); resolve(); };
                response.once('drain', complete); response.once('close', complete);
              });
            }
            return response.end();
          }
          if (mode.startsWith('tamper-')) value[mode.slice(7)] = 'forged';
          return send(200, value);
        } catch (e) { if (e.code === 'ENOENT') return send(404, { ok: false, error: 'missing result' }); throw e; }
      }
      if (route.startsWith('/api/v1/fs/remove?')) {
        const target = new URL(route, 'http://mock').searchParams.get('path');
        assert.ok(path.isAbsolute(target) && /^workbuddy-workspace-(?:worker-[a-f0-9]+\.mjs|result-[a-f0-9]+\.json(?:\.tmp)?)$/.test(path.basename(target)));
        if (mode === 'file-cleanup-unauthorized') return send(401, { ok: false, error: 'mock cleanup authentication failure' });
        try { await unlink(target); }
        catch (e) { if (e.code === 'ENOENT') return send(404, { ok: false, error: 'already absent' }); throw e; }
        return send(200, { ok: true, data: {} });
      }
      const match = route.match(/^\/api\/v1\/sessions\/([^/]+)(\/(?:prompt|files))?$/);
      assert.ok(match && sessions.has(match[1]), route);
      if (incoming.method === 'DELETE') {
        if (mode === 'cleanup-failure') return send(500, { ok: false, error: 'mock cleanup failure' });
        sessions.delete(match[1]); return send(200, { ok: true, data: {} });
      }
      if (match[2] === '/files') {
        const form = await new Response(raw, { headers: { 'Content-Type': incoming.headers['content-type'] } }).formData();
        const file = form.get('files');
        assert.match(file.name, /^workbuddy-workspace-worker-[a-f0-9]+\.mjs$/);
        const target = path.join(roots.get(match[1]), file.name);
        await writeFile(target, Buffer.from(await file.arrayBuffer()));
        return send(200, { ok: true, data: { files: [{ name: file.name, path: target }] } });
      }
      assert.equal(incoming.method, 'POST'); assert.equal(match[2], '/prompt');
      if (mode === 'http-failure') return send(503, { ok: false, error: 'mock prompt failure' });
      if (mode === 'unsupported') return send(200, { ok: true, data: { content: 'UNSUPPORTED: command tool unavailable' } });
      if (mode === 'timeout') { await new Promise((r) => setTimeout(r, 150)); return send(200, { ok: true, data: { content: '' } }); }
      assert.ok(body.prompt.includes('You may read and inspect the script first'));
      assert.ok(body.prompt.includes('WorkBuddy workspace request:'));
      const command = body.prompt.slice(body.prompt.indexOf('\n\n') + 2);
      const output = await run('bash', ['-c', command]); assert.equal(output.code, 0, output.stderr);
      if (mode === 'lost-response' || mode === 'lost-response-missing-result') {
        if (mode === 'lost-response-missing-result') {
          const workerPath = command.slice("node '".length, -1).replaceAll("'\\''", "'");
          const resultPath = path.join(path.dirname(workerPath), 'workbuddy-workspace-result-' + /worker-([a-f0-9]+)\.mjs$/.exec(workerPath)[1] + '.json');
          await unlink(resultPath);
        }
        response.destroy(); return;
      }
      let content = output.stdout.trim();
      if (mode === 'timeout-after-exec') await new Promise(resolve => setTimeout(resolve, 300));
      if (mode === 'extra-text') content += '\nI succeeded';
      return send(200, { ok: true, data: { content } });
    } catch (e) { send(500, { ok: false, error: e.message }); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  return { base: `http://127.0.0.1:${server.address().port}/api/v1`, requests, sessions, mode: (next) => { mode = next; } };
}

test('mock DSH runs actual command, authenticates and always deletes temporary session', async (t) => {
  const { root } = await fixture(t); const mock = await mockDSH(t);
  const read = await remote(req(root, 'read', { path: 'input.txt' }), { base: mock.base, apiKey: 'test-only-secret' });
  assert.equal(read.sha256, sha('original')); assert.equal(read.executionEvidence, 'http-read-worker-result'); assert.equal(mock.sessions.size, 0);
  assert.ok(mock.requests.every((r) => r.authorization === 'Bearer test-only-secret'));
  assert.equal(mock.requests.at(-1).method, 'DELETE');
  const conflict = await remote(req(root, 'write', { path: 'input.txt', expectedSha256: sha('stale'), contentBase64: b64('must not overwrite') }), { base: mock.base, apiKey: 'test-only-secret' });
  assert.equal(conflict.ok, false); assert.equal(conflict.code, 'CAS_MISMATCH');
  assert.equal(await readFile(path.join(root, 'input.txt'), 'utf8'), 'original');
  for (const mode of ['unsupported', 'http-failure', 'tamper-nonce', 'tamper-operation', 'tamper-requestHash', 'timeout']) {
    mock.mode(mode);
    await assert.rejects(remote(req(root, 'read', { path: 'input.txt' }), { base: mock.base, requestTimeoutMs: mode === 'timeout' ? 60 : 5000 }));
    assert.equal(mock.sessions.size, 0, mode);
  }
  mock.mode('cleanup-failure');
  await assert.rejects(remote(req(root, 'read', { path: 'input.txt' }), { base: mock.base }), /CLEANUP_FAILED/);
  assert.equal(mock.sessions.size, 1);
});

test('lost response after an actual write reports OUTCOME_UNCERTAIN, never replays, and cleans the exact worker', async t => {
  const { root } = await fixture(t), node = await mockDSH(t);
  node.mode('lost-response-missing-result');
  await assert.rejects(remote(req(root, 'write', { path: 'input.txt', expectedSha256: sha('original'), contentBase64: b64('written before response loss') }), { base: node.base }), e => e.code === 'OUTCOME_UNCERTAIN' && /may already have occurred.*Do not replay.*read and verify CAS/.test(e.message));
  assert.equal(await readFile(path.join(root, 'input.txt'), 'utf8'), 'written before response loss');
  assert.equal(node.requests.filter(r => r.route.endsWith('/prompt')).length, 1);
  assert.equal(node.requests.filter(r => r.route.startsWith('/api/v1/fs/remove?')).length, 3);
  assert.equal(node.sessions.size, 0);
  assert.ok(!(await readdir(root)).some(n => n.startsWith('workbuddy-workspace-worker-')));
});

test('HTTP result survives a lost prompt response or corrupt model transcription without replay', async t => {
  const { root } = await fixture(t), node = await mockDSH(t);
  node.mode('lost-response');
  const value = await remote(req(root, 'write', { path: 'input.txt', expectedSha256: sha('original'), contentBase64: b64('write once') }), { base: node.base });
  assert.equal(value.sha256, sha('write once'));
  assert.equal(node.requests.filter(r => r.route.endsWith('/prompt')).length, 1);
  node.mode('extra-text');
  assert.equal((await remote(req(root, 'read', { path: 'input.txt' }), { base: node.base })).sha256, sha('write once'));
  assert.ok(!(await readdir(root)).some(n => n.startsWith('workbuddy-workspace-')));
});

test('prompt timeout after worker completion reads its result without replay; cleanup 404 is idempotent but 401 fails', async t => {
  const { root } = await fixture(t), node = await mockDSH(t);
  node.mode('timeout-after-exec');
  const value = await remote(req(root, 'write', { path: 'input.txt', expectedSha256: sha('original'), contentBase64: b64('timeout committed') }), { base: node.base, requestTimeoutMs: 180 });
  assert.equal(value.sha256, sha('timeout committed'));
  assert.equal(node.requests.filter(r => r.route.endsWith('/prompt')).length, 1);
  assert.equal(node.sessions.size, 0);
  assert.ok(!(await readdir(root)).some(n => n.startsWith('workbuddy-workspace-')));
  node.mode('file-cleanup-unauthorized');
  await assert.rejects(remote(req(root, 'read', { path: 'input.txt' }), { base: node.base }), e => e.code === 'CLEANUP_FAILED' && /401.*authentication failure/.test(e.message));
  assert.equal(node.sessions.size, 0, 'session deletion still attempted after temporary-file cleanup failed');
  assert.ok((await readdir(root)).some(n => n.startsWith('workbuddy-workspace-result-')), 'must report cleanup failure instead of pretending sensitive result is gone');
});

test('result header and chunked stream limits reject over 32 MiB and clean exact temporary paths', async t => {
  const { root } = await fixture(t), node = await mockDSH(t);
  for (const mode of ['result-header-limit', 'result-stream-limit']) {
    node.mode(mode);
    const before = node.requests.filter(r => r.route.endsWith('/prompt')).length;
    await assert.rejects(remote(req(root, 'read', { path: 'input.txt' }), { base: node.base, requestTimeoutMs: 1000 }), e => e.code === 'OUTCOME_UNCERTAIN' && /RESULT_LIMIT.*32 MiB/.test(e.message));
    assert.equal(node.requests.filter(r => r.route.endsWith('/prompt')).length, before + 1, 'no replay');
    assert.equal(node.sessions.size, 0);
    assert.ok(!(await readdir(root)).some(n => n.startsWith('workbuddy-workspace-')));
  }
});

test('invalid JSON and mismatched nonce, operation or digest reject results and clean sensitive files', async t => {
  const { root } = await fixture(t), node = await mockDSH(t);
  for (const mode of ['result-bad-json', 'tamper-nonce', 'tamper-operation', 'tamper-requestHash']) {
    node.mode(mode);
    await assert.rejects(remote(req(root, 'read', { path: 'input.txt' }), { base: node.base }), e => e.code === 'OUTCOME_UNCERTAIN' && (mode === 'result-bad-json' ? /RESULT_INVALID.*not valid JSON/.test(e.message) : /nonce, operation or request digest mismatch/.test(e.message)));
    assert.equal(node.sessions.size, 0);
    assert.ok(!(await readdir(root)).some(n => n.startsWith('workbuddy-workspace-')));
  }
});

test('unsupported prompt cleans upload without running it, including payload, and valid CAS failure self-cleans', async t => {
  const { root } = await fixture(t), node = await mockDSH(t);
  const contentBase64 = b64('sensitive test content');
  node.mode('unsupported');
  await assert.rejects(remote(req(root, 'write', { path: 'new.txt', expectAbsent: true, contentBase64 }), { base: node.base }), e => e.code === 'OUTCOME_UNCERTAIN');
  assert.ok(!(await readdir(root)).some(n => n.startsWith('workbuddy-workspace-worker-')));
  assert.equal((await readdir(root)).includes('new.txt'), false);
  node.mode('run');
  const conflict = await remote(req(root, 'write', { path: 'input.txt', expectedSha256: sha('stale'), contentBase64 }), { base: node.base });
  assert.equal(conflict.code, 'CAS_MISMATCH');
  assert.ok(!(await readdir(root)).some(n => n.startsWith('workbuddy-workspace-worker-')));
});

test('CLI help, validation and end-to-end mock DSH file write/read/exec', async (t) => {
  const { base, root } = await fixture(t); const mock = await mockDSH(t);
  const help = await run(process.execPath, [script, '--help']); assert.equal(help.code, 0); assert.match(help.stdout, /WORKBUDDY_WORKSPACE_API_KEY/); assert.match(help.stdout, /NOT an OS/);
  const localFile = path.join(base, 'replacement'); await writeFile(localFile, 'from CLI');
  const common = ['--base', mock.base, '--root', root];
  const invalid = await run(process.execPath, [script, 'write', ...common, '--path', 'x', '--file', localFile]);
  assert.equal(invalid.code, 1); assert.equal(mock.requests.length, 0);
  const wrote = await run(process.execPath, [script, 'write', ...common, '--path', 'from-cli', '--file', localFile, '--expect-absent']);
  assert.equal(wrote.code, 0, wrote.stderr); assert.equal(JSON.parse(wrote.stdout).sha256, sha('from CLI'));
  const read = await run(process.execPath, [script, ...common, 'read', '--path', 'from-cli']);
  assert.equal(read.code, 0, read.stderr); assert.equal(JSON.parse(read.stdout).contentBase64, b64('from CLI'));
  const exec = await run(process.execPath, [script, 'exec', ...common, '--guards', JSON.stringify([{ path: 'from-cli', expectedSha256: sha('from CLI') }]), '--', process.execPath, '-e', 'console.log(process.cwd())']);
  assert.equal(exec.code, 0, exec.stderr); assert.equal(JSON.parse(exec.stdout).stdout.trim(), await realpath(root));
  assert.equal(mock.sessions.size, 0);
});

async function mockDirectory(t, select) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url, auth: req.headers.authorization, cacheControl: req.headers['cache-control'] });
    const value = select(requests.length);
    res.writeHead(value.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(value));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  return { base: `http://127.0.0.1:${server.address().port}`, requests };
}
const catalog = (base, { online = true, extra = [] } = {}) => ({ tunnels: [{ id: 'tunnel', online, mappings: [{ id: 'file-owner', proto: 'tcp', local: '127.0.0.1:3080', public_url: base.replace('http:', 'tcp:').replace('/api/v1', ''), app: { id: 'owner-app', type: 'http-api', skills: [{ name: 'dsh-web-service' }] } }, ...extra] }] });

test('stable mapping follows port changes before every request and every operation, including cleanup', async t => {
  const { root } = await fixture(t);
  const sharedSessions = new Set();
  const a = await mockDSH(t, sharedSessions), b = await mockDSH(t, sharedSessions), c = await mockDSH(t, sharedSessions);
  // One long operation crosses three ports; the next operation must also avoid the old port.
  const directory = await mockDirectory(t, n => catalog(n === 1 ? a.base : n === 2 || n === 3 ? b.base : c.base));
  const options = { nodeRef: 'mapping:file-owner', onenatBase: directory.base, onenatApiKey: 'directory-secret', apiKey: 'node-secret' };
  const first = await remote(req(root, 'read', { path: 'input.txt' }), options);
  assert.equal(first.sha256, sha('original'));
  assert.equal(a.requests[0].route, '/api/v1/sessions');
  assert.match(b.requests[0].route, /\/files$/);
  assert.match(b.requests[1].route, /\/prompt$/);
  assert.match(c.requests[0].route, /\/fs\/download\?/);
  assert.equal(c.requests.at(-1).method, 'DELETE');
  assert.equal(sharedSessions.size, 0);
  await remote(req(root, 'list'), options);
  assert.equal(directory.requests.length, 16);
  assert.equal(a.requests.length, 1); assert.equal(b.requests.length, 2); assert.equal(c.requests.length, 13);
  assert.ok(directory.requests.every(r => r.path === '/api/v1/resources' && r.auth === 'Bearer directory-secret' && r.cacheControl === 'no-cache'));
  assert.ok([...a.requests, ...b.requests, ...c.requests].every(r => r.authorization === 'Bearer node-secret'));
});

test('stable references fail closed for offline, missing, ambiguous, non-DSH and unavailable directory', async t => {
  const node = await mockDSH(t);
  let value = catalog(node.base, { online: false });
  const directory = await mockDirectory(t, () => value);
  const options = { nodeRef: 'mapping:file-owner', onenatBase: directory.base, onenatApiKey: 'directory-secret' };
  await assert.rejects(resolveWorkspaceTarget(options), /NODE_OFFLINE/);
  value = { tunnels: [] };
  await assert.rejects(resolveWorkspaceTarget(options), /NODE_NOT_FOUND/);
  value = { status: 503 };
  await assert.rejects(resolveWorkspaceTarget(options), /DIRECTORY_UNAVAILABLE/);
  value = { ok: false };
  await assert.rejects(resolveWorkspaceTarget(options), /DIRECTORY_INVALID/);
  value = catalog(node.base);
  value.tunnels[0].mappings[0].app.skills = [];
  await assert.rejects(resolveWorkspaceTarget(options), /UNSUPPORTED/);
  value = catalog(node.base);
  assert.equal((await resolveWorkspaceTarget({ ...options, nodeRef: 'app:owner-app' })).mappingId, 'file-owner');
  value.tunnels[0].mappings.push({ ...value.tunnels[0].mappings[0], id: 'another-machine' });
  await assert.rejects(resolveWorkspaceTarget({ ...options, nodeRef: 'app:owner-app' }), /AMBIGUOUS_NODE/);
  await assert.rejects(resolveWorkspaceTarget({ ...options, base: node.base }), /mutually exclusive/);
  assert.equal(node.requests.length, 0, 'failed resolution must never contact the cached node');
});

test('directory failure after session creation still attempts fresh cleanup without replaying an uncertain operation', async t => {
  const { root } = await fixture(t), node = await mockDSH(t);
  const directory = await mockDirectory(t, n => n === 2 ? { status: 503 } : catalog(node.base));
  await assert.rejects(remote(req(root, 'read', { path: 'input.txt' }), { nodeRef: 'mapping:file-owner', onenatBase: directory.base, onenatApiKey: 'directory-secret' }), /DIRECTORY_UNAVAILABLE/);
  assert.equal(directory.requests.length, 3);
  assert.deepEqual(node.requests.map(r => r.method), ['POST', 'DELETE']);
  assert.equal(node.sessions.size, 0);
});

test('offline during a running operation reports uncertain cleanup and never falls back to the old port', async t => {
  const { root } = await fixture(t), node = await mockDSH(t);
  const directory = await mockDirectory(t, n => catalog(node.base, { online: n === 1 }));
  await assert.rejects(remote(req(root, 'read', { path: 'input.txt' }), { nodeRef: 'mapping:file-owner', onenatBase: directory.base, onenatApiKey: 'directory-secret' }), /NODE_OFFLINE.*CLEANUP_FAILED.*outcome may already have occurred/);
  assert.equal(directory.requests.length, 3);
  assert.equal(node.requests.length, 1, 'neither prompt nor DELETE may use the cached endpoint');
  assert.equal(node.sessions.size, 1, 'reports the unresolved temporary session instead of claiming it cleaned up');
});

test('CLI stable mapping mode validates mutually exclusive locator and resolves each invocation', async t => {
  const { root } = await fixture(t), node = await mockDSH(t);
  let online = true;
  const directory = await mockDirectory(t, () => catalog(node.base, { online }));
  const common = ['--node-ref', 'mapping:file-owner', '--onenat-base', directory.base, '--root', root];
  const env = { ...process.env, WORKBUDDY_ONENAT_API_KEY: 'catalog-key', WORKBUDDY_WORKSPACE_API_KEY: 'node-key' };
  const read = await run(process.execPath, [script, 'read', ...common, '--path', 'input.txt'], { env });
  assert.equal(read.code, 0, read.stderr); assert.equal(JSON.parse(read.stdout).sha256, sha('original'));
  const invalid = await run(process.execPath, [script, 'list', ...common, '--base', node.base], { env });
  assert.equal(invalid.code, 1); assert.equal(directory.requests.length, 8);
  online = false;
  const offline = await run(process.execPath, [script, 'list', ...common], { env });
  assert.equal(offline.code, 1); assert.equal(JSON.parse(offline.stderr).code, 'NODE_OFFLINE');
  assert.equal(node.requests.length, 8);
});
