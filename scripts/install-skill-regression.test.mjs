import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const cli = await readFile(new URL('skills/workbuddy-mcp/scripts/wbmcp.sh', root));
for (const failure of [null, 'initialize', 'tools/list', 'ping']) {
  test(`installer records real MCP probes and exits correctly: ${failure ?? 'success'}`, async t => {
    const dir = await mkdtemp(path.join(tmpdir(), 'wb-install-test-'));
    const server = http.createServer(async (req, res) => {
      if (req.method === 'GET') {
        if (req.url.endsWith('/wbmcp.sh')) return res.end(cli);
        if (req.url.endsWith('/wb.mjs')) return res.end('console.log("HTTP tools verified")');
        if (req.url.endsWith('/skills.json')) return res.end('[]');
        return res.end('# Mock skill');
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      if (request.method === 'notifications/initialized') return res.writeHead(202).end();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'mock-install-session' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(request.method === failure
        ? { error: { code: -32603, message: 'mock rejection' } }
        : { result: request.method === 'tools/list' ? { tools: [] } : {} }) }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    });
    const result = await new Promise((resolve, reject) => {
      const child = spawn('bash', [new URL('scripts/install-skill.sh', root).pathname, '--base-url', `http://127.0.0.1:${server.address().port}`, '--token', 'test-secret-never-report', '--dir', path.join(dir, 'skills')], { env: { ...process.env, HOME: dir, TMPDIR: dir } });
      let stdout = '', stderr = '';
      child.stdout.on('data', value => { stdout += value; });
      child.stderr.on('data', value => { stderr += value; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, failure ? 1 : 0, result.stderr);
    const raw = await readFile(path.join(dir, '.workbuddy-install-report.json'), 'utf8');
    const report = JSON.parse(raw);
    assert.equal(report.verified, !failure);
    assert.equal(report.filesInstalled, true);
    assert.equal(report.tokenExpiryPolicy, 'never');
    assert.equal(report.tokenExpiresAt, null);
    assert.equal(report.mcp.handshake, failure === 'initialize' ? 'failed' : 'passed');
    assert.equal(report.mcp['tools/list'], failure === 'initialize' ? 'skipped' : failure === 'tools/list' ? 'failed' : 'passed');
    assert.equal(report.mcp.ping, failure === 'initialize' ? 'skipped' : failure === 'ping' ? 'failed' : 'passed');
    assert.ok(!raw.includes('test-secret-never-report'));
    assert.match(result.stdout, /令牌永久有效/);
  });
}
