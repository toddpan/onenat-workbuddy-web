import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { renderWebUi } from '../dist/web-ui.js';

// Exercise the actual generated browser code, without booting unrelated API clients.
const html = renderWebUi('');
const js = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)][0][1];
function block(start, end) {
  const from = js.indexOf(start);
  const to = js.indexOf(end, from);
  assert(from >= 0 && to > from, 'browser source markers must exist');
  return js.slice(from, to);
}
function harness() {
  const dom = new JSDOM('<div id="chat-title"></div><div id="chat-scroll"><div class="dsh-chat-column"></div></div><div id="modal"></div>');
  Object.defineProperty(dom.window.document, 'hidden', { value: false, writable: true });
  const requests = [], frames = [];
  const task = { turns: [{}] };
  const ctx = {
    document: dom.window.document, state: { currentTaskId: 't1', task, tasks: [], convView: 'chat' },
    currentView: 'work', openTaskSeq: 1,
    requestAnimationFrame: fn => frames.push(fn),
    api: (path, opts) => new Promise(resolve => requests.push({ path, opts, resolve })),
    renderActivity() {}, renderTaskList() {}, renderAgents() {}, renderProjects() {},
    esc: s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    fmtDateTime: String, openModal: (title, body) => { ctx.modalTitle = title; ctx.$('modal').innerHTML = body; },
    closeModal() {}, jumpToTask: id => { ctx.jumped = id; }, console,
  };
  ctx.$ = id => ctx.document.getElementById(id);
  vm.createContext(ctx);
  vm.runInContext(block('var activityState =', '// ---------- DSH 对话窗口'), ctx);
  // Keep tests independent of the full page layout, while retaining real activity render when needed.
  const renderActivity = ctx.renderActivity;
  ctx.renderActivity = () => {};
  return { ctx, dom, requests, frames, task, renderActivity, flush: async () => { frames.shift()(); return frames.shift()(); } };
}
const data = (version, unread = true) => ({ snapshotAt: 12345, snapshotVersion: version, items: [{ taskId: 't1', activityVersion: version, readVersion: unread ? 0 : version, unread, state: 'completed' }], counts: {}, agents: [], projects: [] });

test('generated browser script parses', () => { new Function(js); });

test('latest request wins, same snapshot refreshes reads, failure retains successful sample', async () => {
  const { ctx, requests } = harness();
  const first = ctx.loadActivity(), second = ctx.loadActivity();
  requests[1].resolve({ ok: true, data: data(2) }); await second;
  requests[0].resolve({ ok: true, data: data(1) }); await first;
  assert.equal(ctx.activityState.data.snapshotVersion, 2);
  assert.equal(ctx.activityState.successAt, 12345);
  const read = ctx.loadActivity(); requests[2].resolve({ ok: true, data: data(2, false) }); await read;
  assert.equal(ctx.activityState.byTask.t1.unread, false, 'read updates do not require a new snapshotVersion');
  const failure = ctx.loadActivity(); requests[3].resolve({ ok: false, error: 'offline' }); await failure;
  assert.equal(ctx.activityState.data.snapshotVersion, 2);
  assert.equal(ctx.activityState.byTask.t1.unread, false);
  assert.equal(ctx.activityState.successAt, 12345);
  assert.equal(ctx.activityState.error, 'offline');
});

test('acknowledges only the captured version after two rendered frames', async () => {
  const { ctx, requests, frames, task } = harness();
  ctx.activityState.byTask.t1 = data(99).items[0];
  ctx.ackRenderedActivity('t1', 7, 1, task);
  assert.equal(requests.length, 0);
  frames.shift()(); assert.equal(requests.length, 0);
  const pending = frames.shift()();
  assert.equal(requests[0].path, '/tasks/t1/read');
  assert.equal(JSON.parse(requests[0].opts.body).activityVersion, 7);
  requests[0].resolve({ ok: false }); await pending;
});

for (const [name, change] of [
  ['other view', h => { h.ctx.currentView = 'agents'; }],
  ['hidden document', h => { h.ctx.document.hidden = true; }],
  ['switched task', h => { h.ctx.state.currentTaskId = 't2'; }],
  ['superseded open', h => { h.ctx.openTaskSeq = 2; }],
  ['replaced task content', h => { h.ctx.state.task = { turns: [{}] }; }],
  ['history re-render', h => { h.ctx.activityRenderSeq++; }],
  ['viewing earlier content', h => { Object.defineProperty(h.ctx.$('chat-scroll'), 'scrollHeight', { value: 1000 }); }],
  ['trajectory', h => { h.ctx.state.convView = 'trajectory'; }],
  ['missing content DOM', h => { h.ctx.$('chat-scroll').innerHTML = ''; }],
  ['loading content', h => { h.ctx.$('chat-scroll').insertAdjacentHTML('beforeend', '<div class="chat-loading"></div>'); }],
  ['no messages', h => { h.task.turns = []; }],
]) {
  test('does not acknowledge: ' + name, async () => {
    const h = harness();
    h.ctx.ackRenderedActivity('t1', 7, 1, h.task);
    h.frames.shift()(); change(h); await h.frames.shift()();
    assert.equal(h.requests.length, 0);
  });
}

test('missing version never schedules acknowledgement', () => {
  const h = harness(); h.ctx.ackRenderedActivity('t1', null, 1, h.task);
  assert.equal(h.frames.length, 0); assert.equal(h.requests.length, 0);
});

test('detail capture precedes content GET, acknowledgement follows rendering', () => {
  const open = block('async function openTask(taskId)', '/** 对话内容列');
  assert(open.indexOf('await captureActivityVersion(taskId)') < open.indexOf("await api('/tasks/' + taskId)"));
  assert(open.indexOf('applyTaskToView(freshTask') < open.indexOf('ackRenderedActivity('));
});

test('archived detail badge survives default snapshots and ack updates only its matching version', async () => {
  const h = harness();
  const capture = h.ctx.captureActivityVersion('t1');
  h.requests[0].resolve({ ok: true, data: data(7) });
  assert.equal(await capture, 7);
  h.ctx.ackRenderedActivity('t1', 7, 1, h.task); h.frames.shift()(); const ack = h.frames.shift()();
  h.requests[1].resolve({ ok: true, data: { taskId: 't1', activityVersion: 7, readVersion: 7, unread: false } });
  await new Promise(resolve => setImmediate(resolve));
  h.requests[2].resolve({ ok: true, data: { ...data(8), items: [] } }); await ack;
  assert.equal(h.ctx.activityState.detail.unread, false);
  assert.equal(h.ctx.activityState.data.items.length, 0, 'archived task must not affect default totals');
  h.renderActivity();
  assert.match(h.ctx.$('activity-task-state').textContent, /已完成/);
  assert.doesNotMatch(h.ctx.$('activity-task-state').textContent, /未读/);
});

test('project workspace summary uses server project counts for both task and draft', () => {
  const h = harness();
  h.ctx.activityState.data = { ...data(7), projects: [{ projectId: 'p1', counts: { waitingReply: 2, running: 3, completed: 4, failed: 1, unread: 5 } }] };
  h.task.projectId = 'p1'; h.renderActivity();
  const summary = h.ctx.$('activity-project-work');
  assert.match(summary.textContent, /待答复 2/);
  assert.match(summary.textContent, /未读 5/);
  assert.equal(summary.querySelector('[data-activity-key]').getAttribute('data-activity-id'), 'p1');
  h.ctx.state.currentTaskId = null;
  h.ctx.state.draft = { place: { projectId: 'p1' } }; h.renderActivity();
  assert.equal(summary.style.display, '');
  assert.match(summary.textContent, /运行 3/);
  h.ctx.state.draft = null; h.renderActivity();
  assert.equal(summary.style.display, 'none');
});

test('activity click is handled before parent card navigation; listing does not mark read', () => {
  const h = harness(); let navigated = false;
  const card = h.ctx.document.createElement('div');
  card.innerHTML = '<button data-activity-key="unread" data-activity-scope="all" data-activity-id=""><span>未读</span></button>';
  card.addEventListener('click', () => { navigated = true; });
  h.ctx.document.body.appendChild(card);
  h.ctx.activityState.data = data(7);
  card.querySelector('span').dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
  assert.equal(navigated, false);
  assert.match(h.ctx.modalTitle, /未读/);
  assert.equal(h.requests.length, 0);
  h.ctx.document.querySelector('[data-activity-task]').click();
  assert.equal(h.ctx.jumped, 't1');
});
