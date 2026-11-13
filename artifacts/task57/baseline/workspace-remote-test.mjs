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
import { remote, makeCommand, shellQuote } from './workspace-remote.mjs';

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

async function mockDSH(t) {
  const sessions = new Set(), requests = [];
  let mode = 'run';
  const server = createServer(async (incoming, response) => {
    const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
    const route = incoming.url; requests.push({ method: incoming.method, route, body, authorization: incoming.headers.authorization });
    const send = (status, data) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); };
    try {
      if (route === '/api/v1/sessions' && incoming.method === 'POST') {
        assert.deepEqual(Object.keys(body).sort(), ['cwd', 'title']);
        const id = randomBytes(8).toString('hex'); sessions.add(id); return send(201, { ok: true, data: { sessionId: id } });
      }
      const match = route.match(/^\/api\/v1\/sessions\/([^/]+)(\/prompt)?$/);
      assert.ok(match && sessions.has(match[1]), route);
      if (incoming.method === 'DELETE') {
        if (mode === 'cleanup-failure') return send(500, { ok: false, error: 'mock cleanup failure' });
        sessions.delete(match[1]); return send(200, { ok: true, data: {} });
      }
      assert.equal(incoming.method, 'POST'); assert.equal(match[2], '/prompt');
      if (mode === 'http-failure') return send(503, { ok: false, error: 'mock prompt failure' });
      if (mode === 'unsupported') return send(200, { ok: true, data: { content: 'UNSUPPORTED: command tool unavailable' } });
      if (mode === 'timeout') { await new Promise((r) => setTimeout(r, 150)); return send(200, { ok: true, data: { content: '' } }); }
      const command = body.prompt.slice(body.prompt.indexOf('\n\n') + 2);
      const output = await run('bash', ['-c', command]); assert.equal(output.code, 0, output.stderr);
      let content = output.stdout.trim();
      if (mode.startsWith('tamper-')) {
        const colon = content.lastIndexOf(':'); const result = JSON.parse(Buffer.from(content.slice(colon + 1), 'base64').toString());
        result[mode.slice(7)] = 'forged'; content = content.slice(0, colon + 1) + b64(JSON.stringify(result));
      }
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
  assert.equal(read.sha256, sha('original')); assert.equal(read.executionEvidence, 'model-relayed-worker-result'); assert.equal(mock.sessions.size, 0);
  assert.ok(mock.requests.every((r) => r.authorization === 'Bearer test-only-secret'));
  assert.equal(mock.requests[2].method, 'DELETE');
  for (const mode of ['unsupported', 'http-failure', 'tamper-nonce', 'tamper-operation', 'tamper-requestHash', 'extra-text', 'timeout']) {
    mock.mode(mode);
    await assert.rejects(remote(req(root, 'read', { path: 'input.txt' }), { base: mock.base, requestTimeoutMs: mode === 'timeout' ? 60 : 5000 }));
    assert.equal(mock.sessions.size, 0, mode);
  }
  mock.mode('cleanup-failure');
  await assert.rejects(remote(req(root, 'read', { path: 'input.txt' }), { base: mock.base }), /CLEANUP_FAILED/);
  assert.equal(mock.sessions.size, 1);
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
