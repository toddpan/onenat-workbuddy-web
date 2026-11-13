import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { JSDOM } from 'jsdom';

// Evaluate the CURRENT source template in memory, not potentially stale dist output.
// Only the unrelated model-config HTML/script import is stubbed; no build/files emitted.
const source = readFileSync(new URL('../src/web-ui.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  reportDiagnostics: true,
});
assert.equal(compiled.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error).length, 0);
const exports = {};
vm.runInNewContext(compiled.outputText, {
  exports,
  require(name) {
    assert.equal(name, './model-config-ui.js');
    return { MODEL_CONFIG_CARD: '', MODEL_CONFIG_SCRIPT: '' };
  },
});
assert.equal(typeof exports.renderWebUi, 'function');
const html = exports.renderWebUi('/workbuddy');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
new vm.Script(script); // Also catches incorrect escaping inside the large TS template.
const ast = ts.createSourceFile('web-ui-inline.js', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = new Map(ast.statements.filter(ts.isFunctionDeclaration).map(n => [n.name.text, n.getText(ast)]));
const names = ['esc', 'parseAskQuestions', 'renderAskUserCard', 'connectStream', 'disconnectStream',
  'appendLiveTurn', 'resyncCurrentTask', 'reconcileViewWithServer', 'finalizeTurnBlocks'];
const plain = value => JSON.parse(JSON.stringify(value));
const drain = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function harness(t) {
  const dom = new JSDOM('<div id="chat-scroll"><div class="dsh-chat-column"></div></div>');
  t.after(() => dom.window.close());
  const document = dom.window.document;
  const calls = [], sending = [], streams = [], heads = [];
  const state = { currentTaskId: 'task-a', taskCache: new Map(), turnEls: {}, renderedFromIndex: 0, es: null, sending: false };
  let handler = async () => ({ ok: true, data: { id: 'task-a', turns: [], running: false } });
  class EventSource {
    constructor(url) { this.url = url; this.readyState = 0; this.listeners = new Map(); streams.push(this); }
    addEventListener(name, fn) { this.listeners.set(name, fn); }
    close() { this.readyState = 2; }
    open() { this.readyState = 1; this.onopen(); }
    emit(name, data) { assert.ok(this.listeners.has(name)); this.listeners.get(name)({ data: JSON.stringify(data) }); }
  }
  const context = {
    document, state, EventSource, API: '/workbuddy/api',
    $: id => document.getElementById(id), chatColumn: () => document.querySelector('.dsh-chat-column'),
    api: async (url, options) => { calls.push({ url, options }); return handler(url, options); },
    setSending(value) { sending.push(value); state.sending = value; },
    refreshChatHead(task) { heads.push(task.id); },
    // Rendering boundary: a minimal bubble record; stream/card/reconciliation logic is real.
    buildTurnElement(taskId, turn) {
      const wrap = document.createElement('article'), blocks = document.createElement('div');
      wrap.dataset.turnId = turn.id;
      const text = document.createElement('div'); text.dataset.kind = 'text'; text.textContent = turn.text || '';
      blocks.appendChild(text); wrap.appendChild(blocks);
      state.turnEls[turn.id] = { wrap, blocks, kind: turn.streaming ? 'stream' : 'settled' };
      return wrap;
    },
    createBlock(kind) { const el = document.createElement('div'); el.dataset.kind = kind; return { el }; },
    md: text => '<p>' + context.esc(text) + '</p>', withFileLinks: (_task, _agent, text) => text,
  };
  for (const name of ['smartScrollBottom', 'syncQueuedUI', 'showTurnStatus', 'markTrajDirty', 'removeTurnStatus',
    'applyUsageBadge', 'renderTurnChanges', 'loadTasksQuiet', 'loadTaskStats', 'loadTaskTodos', 'toast']) context[name] = () => {};
  vm.createContext(context);
  vm.runInContext(names.map(name => { assert.ok(functions.has(name), name); return functions.get(name); }).join('\n'), context);
  return { context, state, calls, sending, streams, heads, document, setApi(fn) { handler = fn; } };
}

function card(h) {
  const root = h.document.createElement('div');
  h.document.querySelector('.dsh-chat-column').appendChild(root);
  h.context.renderAskUserCard(root, {
    id: 'ask-1', name: 'ask_user_question', status: 'running', awaiting: true,
    args: JSON.stringify({ questions: [{ id: 'q1', question: 'Choose', options: [{ label: 'Blue' }, { label: 'Green' }] }] }),
  }, { taskId: 'task-a', agentId: 'agent-1' });
  return root;
}

test('first SSE onopen (and reconnect) fetches authoritative snapshot and fills the subscription gap', async t => {
  const h = harness(t);
  h.setApi(async () => ({ ok: true, data: { id: 'task-a', running: false, turns: [{ id: 'missed', role: 'agent', text: 'Complete response' }] } }));
  h.context.connectStream('task-a');
  assert.equal(h.calls.length, 0);
  const es = h.streams[0]; es.open(); await drain();
  assert.equal(h.calls[0].url, '/tasks/task-a');
  assert.match(h.document.body.textContent, /Complete response/);
  assert.deepEqual(h.sending, [false]);
  es.open(); await drain();
  assert.equal(h.calls.length, 2);
  assert.equal(h.document.querySelectorAll('article').length, 1, 'snapshot replay is idempotent');
});

test('obsolete SSE onopen cannot fetch a different task or reuse a replaced stream', async t => {
  const h = harness(t); h.context.connectStream('task-a'); const old = h.streams[0];
  h.context.connectStream('task-a'); old.open(); await drain();
  assert.equal(h.calls.length, 0);
  h.state.currentTaskId = 'task-b'; h.streams[1].open(); await drain();
  assert.equal(h.calls.length, 0);
});

test('turn_end without turn_start creates and finalizes the missing bubble, without duplicates', t => {
  const h = harness(t); h.context.connectStream('task-a');
  const turn = { id: 'late', role: 'agent', text: 'Authoritative final answer', streaming: false };
  h.streams[0].emit('turn_end', { turn });
  assert.equal(h.document.querySelectorAll('article').length, 1);
  assert.equal(h.state.turnEls.late.kind, 'settled');
  assert.equal(h.state.turnEls.late.blocks.innerHTML, '<div data-kind="text"><p>Authoritative final answer</p></div>');
  h.streams[0].emit('turn_end', { turn });
  assert.equal(h.document.querySelectorAll('article').length, 1);
});

test('late turn_end from another task does not insert a bubble', t => {
  const h = harness(t); h.context.connectStream('task-a'); h.state.currentTaskId = 'task-b';
  h.streams[0].emit('turn_end', { turn: { id: 'old', role: 'agent', text: 'Old answer' } });
  assert.equal(h.document.querySelectorAll('article').length, 0);
  assert.equal(h.state.turnEls.old, undefined);
});

for (const action of ['submit', 'skip']) {
  test(`card ${action} POSTs then resyncs; completed task never blindly becomes sending`, async t => {
    const h = harness(t); h.state.es = { readyState: 2, close() {} };
    h.setApi(async (_url, options) => options
      ? { ok: true, data: {} }
      : { ok: true, data: { id: 'task-a', running: false, turns: [{ id: 'answer', role: 'agent', text: 'Already finished' }] } });
    const root = card(h); root.querySelector(`.ask-btn-${action}`).click(); await drain();
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[0].url, '/tasks/task-a/ask-answer');
    assert.equal(h.calls[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(h.calls[0].options.body), { agentId: 'agent-1', answers: [{ id: 'q1', selected: action === 'submit' ? ['Blue'] : [] }] });
    assert.equal(h.calls[1].url, '/tasks/task-a');
    assert.ok(root.querySelector('.ask-card').classList.contains('submitted'));
    assert.equal(h.streams.length, 1, 'closed SSE is restored');
    assert.deepEqual(h.sending, [false]);
    assert.match(h.document.body.textContent, /Already finished/);
  });
}

test('card submit waits for snapshot before setting authoritative running state', async t => {
  const h = harness(t), snapshot = deferred(); h.state.es = { readyState: 1 };
  h.setApi(async (_url, options) => options ? { ok: true, data: {} } : snapshot.promise);
  card(h).querySelector('.ask-btn-submit').click(); await drain();
  assert.equal(h.calls.length, 2); assert.deepEqual(h.sending, []);
  snapshot.resolve({ ok: true, data: { id: 'task-a', running: true, turns: [] } }); await drain();
  assert.deepEqual(h.sending, [true]); assert.equal(h.streams.length, 0);
});

test('card response after switching tasks cannot mark old card submitted, reconnect or mutate sending', async t => {
  const h = harness(t), response = deferred(); h.setApi(() => response.promise);
  const root = card(h); root.querySelector('.ask-btn-submit').click();
  h.state.currentTaskId = 'task-b'; h.state.sending = true;
  response.resolve({ ok: true, data: {} }); await drain();
  assert.equal(h.calls.length, 1); assert.equal(h.streams.length, 0); assert.deepEqual(h.sending, []);
  assert.equal(h.state.sending, true);
  assert.equal(root.querySelector('.ask-card').classList.contains('submitted'), false);
});

test('snapshot response after switching tasks cannot overwrite the new task view/state', async t => {
  const h = harness(t), response = deferred(); h.setApi(() => response.promise);
  const sync = h.context.resyncCurrentTask(); h.state.currentTaskId = 'task-b';
  response.resolve({ ok: true, data: { id: 'task-a', running: false, turns: [{ id: 'old', text: 'Old answer' }] } });
  await sync;
  assert.equal(h.state.taskCache.has('task-a'), false); assert.deepEqual(h.sending, []);
  assert.deepEqual(h.heads, []); assert.equal(h.document.querySelectorAll('article').length, 0);
});
