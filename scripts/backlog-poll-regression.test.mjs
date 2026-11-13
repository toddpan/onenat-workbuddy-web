import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { JSDOM } from 'jsdom';

// TASK-95: execute the shipped browser functions, with no server, credentials or real timers.
// Run: node --test scripts/backlog-poll-regression.test.mjs
const compiled = ts.transpileModule(readFileSync(new URL('../src/web-ui.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
}).outputText;
const { renderWebUi } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const html = renderWebUi('');
const js = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)][0][1];
function block(start, end) {
  const from = js.indexOf(start), to = js.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Browser source block missing: ${start} ... ${end}`);
  return js.slice(from, to);
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function response() {
  return { ok: true, data: [{
    projectId: 'project-1', projectName: 'Example', nodeStatus: 'ok', initialized: true,
    total: 2, matched: 2, open: 2, done: 0, ready: 1, blocked: 0,
    statuses: ['To Do', 'Done'], facets: { labels: [{ value: 'poll', count: 2 }] }, truncated: true,
    items: [{ itemId: 'TASK-95', title: 'Polling regression', status: 'To Do', updatedDate: '2026-11-12T10:00:00Z' }],
  }] };
}
function harness({ realRender = false } = {}) {
  let now = 0, nextId = 1;
  const timers = new Map(), listeners = new Map(), requests = [], renders = [], paints = [];
  const notice = { hidden: true, textContent: '' };
  const document = {
    hidden: false,
    getElementById: id => id === 'bl-poll-notice' ? notice : null,
    addEventListener(name, fn) { listeners.set(name, fn); },
  };
  const ctx = {
    document, currentView: 'backlog',
    blState: {
      filters: { openOnly: true, search: '', statuses: [], priorities: [], types: [], labels: [], assignees: [], milestones: [], taskProjects: [] },
      sort: { orderBy: 'createdAt', order: 'desc' }, mineName: '', board: null,
      data: response(), loading: false, composing: false, searchTimer: null, picked: {}, expanded: {},
    },
    setTimeout(fn, delay) { const id = nextId++; timers.set(id, { fn, delay, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    api(url) { requests.push(url); return ctx.respond(url); },
    respond: () => response(),
    renderBacklogView(...args) { renders.push(args); return ctx.refresh(...args); },
    refresh: () => true,
    blRender(...args) { paints.push(args); },
    blEnsureMineName: async () => 'Me',
  };
  vm.createContext(ctx);
  vm.runInContext(block('function blQueryParams(', '/** 「仅分配给我」'), ctx);
  vm.runInContext(block('function blSeqOf(', 'function blSortItems('), ctx);
  if (realRender) vm.runInContext(block('async function renderBacklogView(', 'function blBadgeOf('), ctx);
  return {
    ctx, timers, requests, renders, paints, notice,
    baseline(value = response()) { ctx.blState.data = value; ctx.blPoll.signature = ctx.blProbeSignature(value); },
    visibility(hidden) { document.hidden = hidden; listeners.get('visibilitychange')(); },
    onlyTimer() { assert.equal(timers.size, 1, 'exactly one scheduled poll'); return [...timers.values()][0]; },
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const entry = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        now = entry[1].at;
        timers.delete(entry[0]);
        await entry[1].fn();
      }
      now = until;
    },
  };
}

test('poll state starts idle and uses the specified bounded backoff', () => {
  const h = harness(), { ctx } = h;
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.blPoll)), { timer: null, busy: false, failures: 0, signature: null, epoch: 0 });
  for (const [failures, delay] of [[0, 8000], [1, 8000], [2, 8000], [3, 16000], [4, 32000], [5, 60000], [20, 60000]]) {
    ctx.blPoll.failures = failures;
    assert.equal(ctx.blPollDelay(), delay, `failure count ${failures}`);
  }
});

test('probe retains active filters but overrides display sorting and bounds each project to one item', () => {
  const { ctx } = harness();
  Object.assign(ctx.blState.filters, { search: 'A & B', statuses: ['To Do', 'Doing'], labels: ['poll', 'ui'], mine: true });
  ctx.blState.mineName = 'Alice';
  ctx.blState.sort = { orderBy: 'priority', order: 'asc' };
  const url = new URL(ctx.blProbeUrl(), 'http://fixture.invalid');
  assert.equal(url.pathname, '/backlog/overview');
  assert.equal(url.searchParams.get('sort'), 'updatedAt');
  assert.equal(url.searchParams.get('order'), 'desc');
  assert.equal(url.searchParams.get('maxCount'), '1');
  assert.equal(url.searchParams.get('search'), 'A & B');
  assert.equal(url.searchParams.get('openOnly'), '1');
  assert.deepEqual(url.searchParams.getAll('status'), ['To Do', 'Doing']);
  assert.deepEqual(url.searchParams.getAll('labels'), ['poll', 'ui']);
  assert.deepEqual(url.searchParams.getAll('assignee'), ['Alice']);
  assert.equal(ctx.blState.sort.orderBy, 'priority');
});

test('sync replaces old timers, increments epoch, and honors immediate versus delayed polling', async () => {
  const h = harness(); h.baseline();
  h.ctx.blPollSync(false);
  const oldTimer = h.ctx.blPoll.timer;
  assert.equal(h.onlyTimer().delay, 8000);
  h.ctx.blPollSync(true);
  assert.equal(h.ctx.blPoll.epoch, 2);
  assert.equal(h.timers.has(oldTimer), false);
  assert.equal(h.onlyTimer().delay, 0);
  await h.advance(0);
  assert.equal(h.requests.length, 1);
  assert.equal(h.onlyTimer().delay, 8000);
});

for (const reason of ['view', 'hidden', 'board']) {
  test(`poll pauses for ${reason} and resumes with a single immediate probe`, async () => {
    const h = harness(); h.baseline();
    h.ctx.blPollSync();
    if (reason === 'view') h.ctx.currentView = 'monitor';
    if (reason === 'board') h.ctx.blState.board = { projectId: 'project-1' };
    if (reason === 'hidden') h.visibility(true); else h.ctx.blPollSync();
    assert.equal(h.ctx.blPollAllowed(), false);
    assert.equal(h.timers.size, 0);
    await h.advance(60000);
    await h.ctx.blPollTick();
    assert.equal(h.requests.length, 0);
    h.ctx.currentView = 'backlog'; h.ctx.blState.board = null;
    if (reason === 'hidden') h.visibility(false); else h.ctx.blPollSync(true);
    assert.equal(h.ctx.blPollAllowed(), true);
    assert.equal(h.onlyTimer().delay, 0);
    await h.advance(0);
    assert.equal(h.requests.length, 1);
    assert.equal(h.renders.length, 0);
  });
}

test('unchanged probes never fetch the full overview and keep one timer across cycles', async () => {
  const h = harness(); h.baseline(); h.ctx.blPollSync();
  await h.advance(24000);
  assert.equal(h.requests.length, 3);
  assert.ok(h.requests.every(url => new URL(url, 'http://fixture.invalid').searchParams.get('maxCount') === '1'));
  assert.equal(h.renders.length, 0);
  h.onlyTimer();
});

test('changed probe awaits one automatic full refresh before committing its signature', async () => {
  const h = harness(); h.baseline();
  const changed = response(); changed.data[0].items[0].title = 'Updated title';
  const gate = deferred(); h.ctx.respond = () => changed; h.ctx.refresh = () => gate.promise;
  const oldSignature = h.ctx.blPoll.signature;
  const tick = h.ctx.blPollTick();
  await Promise.resolve();
  assert.deepEqual(h.renders, [[true, true]]);
  assert.equal(h.ctx.blPoll.busy, true);
  assert.equal(h.ctx.blPoll.signature, oldSignature);
  assert.equal(h.timers.size, 0);
  // The real refresh owns the signature; model a newer write arriving between probe and full fetch.
  const newest = structuredClone(changed); newest.data[0].items[0].title = 'Newer full response';
  h.ctx.blPoll.signature = h.ctx.blProbeSignature(newest);
  gate.resolve(true); await tick;
  assert.equal(h.ctx.blPoll.signature, h.ctx.blProbeSignature(newest));
  h.ctx.respond = () => newest;
  assert.equal(h.ctx.blPoll.busy, false);
  h.onlyTimer();
  await h.advance(8000);
  assert.equal(h.renders.length, 1);
});

test('missing initial signature requests a full refresh even when cached data exists', async () => {
  const h = harness();
  await h.ctx.blPollTick();
  assert.deepEqual(h.renders, [[true, true]]);
});

test('signature detects counts, facets, project health, and latest item edits', () => {
  const { ctx } = harness(); const original = response(), signature = ctx.blProbeSignature(original);
  for (const change of [g => g.total++, g => g.matched++, g => g.ready++, g => g.blocked++, g => g.open--,
    g => g.done++, g => g.facets.labels[0].count++, g => { g.nodeStatus = 'unreachable'; },
    g => { g.items[0].title = 'Edited without timestamp change'; }, g => { g.items[0].updatedDate = '2026-11-13'; }]) {
    const changed = structuredClone(original); change(changed.data[0]);
    assert.notEqual(ctx.blProbeSignature(changed), signature);
  }
});

test('full overview and limited probe signatures agree despite older items, ordering and truncation', () => {
  const { ctx } = harness(); const probe = response(), full = response();
  full.data[0].truncated = false;
  full.data[0].items.unshift({ itemId: 'TASK-94', updatedDate: '2026-11-11', title: 'Older' });
  assert.equal(ctx.blProbeSignature(full), ctx.blProbeSignature(probe));
  const second = structuredClone(probe.data[0]); second.projectId = 'project-2';
  assert.equal(ctx.blProbeSignature({ data: [second, probe.data[0]] }), ctx.blProbeSignature({ data: [probe.data[0], second] }));
});

for (const failure of ['throw', 'not-ok', 'unreachable', 'refresh-false', 'refresh-throw']) {
  test(`${failure} failures back off and a successful probe restores normal cadence`, async () => {
    const h = harness(); h.baseline(); const oldSignature = h.ctx.blPoll.signature;
    h.ctx.respond = () => {
      if (failure === 'throw') throw new Error('network offline');
      if (failure === 'not-ok') return { ok: false, error: 'offline' };
      const r = response();
      if (failure === 'unreachable') r.data[0].nodeStatus = 'unreachable';
      if (failure.startsWith('refresh-')) r.data[0].total++;
      return r;
    };
    h.ctx.refresh = () => { if (failure === 'refresh-throw') throw new Error('refresh offline'); return false; };
    h.ctx.blPollSync(true);
    for (const [count, delay] of [[1, 8000], [2, 8000], [3, 16000], [4, 32000], [5, 60000], [6, 60000]]) {
      await h.advance(count === 1 ? 0 : h.onlyTimer().delay);
      assert.equal(h.ctx.blPoll.failures, count);
      assert.equal(h.onlyTimer().delay, delay);
      assert.equal(h.ctx.blPoll.busy, false);
      assert.equal(h.ctx.blPoll.signature, oldSignature);
      assert.equal(h.notice.hidden, count < 3);
    }
    assert.match(h.notice.textContent, /60/);
    h.ctx.respond = () => response(); h.ctx.refresh = () => true;
    await h.advance(60000);
    assert.equal(h.ctx.blPoll.failures, 0);
    assert.equal(h.onlyTimer().delay, 8000);
    assert.equal(h.notice.hidden, true);
  });
}

for (const field of ['loading', 'composing', 'searchTimer']) {
  test(`active ${field} defers polling without calling the API`, async () => {
    const h = harness(); h.baseline(); h.ctx.blState[field] = true;
    h.ctx.blPollSync(true); await h.advance(0);
    assert.equal(h.requests.length, 0);
    assert.equal(h.ctx.blPoll.failures, 0);
    assert.equal(h.onlyTimer().delay, 8000);
    h.ctx.blState[field] = false; await h.advance(8000);
    assert.equal(h.requests.length, 1);
  });
}

for (const invalidation of ['epoch', 'filters', 'hidden', 'view', 'board']) {
  test(`in-flight probe ignores stale success after ${invalidation} changes`, async () => {
    const h = harness(); h.baseline(); const oldSignature = h.ctx.blPoll.signature;
    const gate = deferred(); h.ctx.respond = () => gate.promise;
    const tick = h.ctx.blPollTick();
    assert.equal(h.ctx.blPoll.busy, true);
    await h.ctx.blPollTick();
    assert.equal(h.requests.length, 1, 'busy guard prevents overlapping probes');
    if (invalidation === 'filters') h.ctx.blState.filters.search = 'new query';
    if (invalidation === 'hidden') h.visibility(true);
    if (invalidation === 'view') h.ctx.currentView = 'monitor';
    if (invalidation === 'board') h.ctx.blState.board = {};
    if (invalidation === 'epoch') h.ctx.blPollSync(true);
    const changed = response(); changed.data[0].total++;
    gate.resolve(changed); await tick;
    assert.equal(h.ctx.blPoll.signature, oldSignature);
    assert.equal(h.ctx.blPoll.failures, 0);
    assert.equal(h.renders.length, 0);
    assert.equal(h.ctx.blPoll.busy, false);
    assert.equal(h.timers.size, h.ctx.blPollAllowed() ? 1 : 0);
  });
}

test('stale rejected probe does not count a failure and resumption remains scheduled', async () => {
  const h = harness(); h.baseline(); const gate = deferred(); h.ctx.respond = () => gate.promise;
  const tick = h.ctx.blPollTick(); h.visibility(true); h.visibility(false);
  assert.equal(h.timers.size, 0, 'busy probe owns resumption until finally');
  gate.reject(new Error('old request failed')); await tick;
  assert.equal(h.ctx.blPoll.failures, 0);
  assert.equal(h.ctx.blPoll.busy, false);
  h.onlyTimer();
});

test('invalidation during an awaited full refresh cannot commit the obsolete probe signature', async () => {
  const h = harness(); h.baseline(); const oldSignature = h.ctx.blPoll.signature;
  const changed = response(); changed.data[0].total++;
  const gate = deferred(); h.ctx.respond = () => changed; h.ctx.refresh = () => gate.promise;
  const tick = h.ctx.blPollTick(); await Promise.resolve();
  h.ctx.blPollSync(); gate.resolve(true); await tick;
  assert.equal(h.ctx.blPoll.signature, oldSignature);
  assert.equal(h.ctx.blPoll.failures, 0);
  h.onlyTimer();
});

test('degraded project still allows healthy project changes to refresh while counting backoff', async () => {
  const h = harness(); h.baseline();
  const degraded = response(); degraded.data[0].nodeStatus = 'unreachable';
  const healthy = structuredClone(response().data[0]); healthy.projectId = 'healthy'; healthy.items[0].title = 'New healthy item';
  degraded.data.push(healthy);
  h.ctx.respond = () => degraded;
  h.ctx.refresh = () => { h.ctx.blPoll.signature = h.ctx.blProbeSignature(degraded); return true; };
  await h.ctx.blPollTick();
  assert.deepEqual(h.renders, [[true, true]]);
  assert.equal(h.ctx.blPoll.failures, 1);
  assert.equal(h.ctx.blPoll.signature, h.ctx.blProbeSignature(degraded));
  await h.advance(8000);
  assert.equal(h.renders.length, 1, 'unchanged degraded project does not continuously full-fetch');
  assert.equal(h.ctx.blPoll.failures, 2);
});

test('real blRender preserves focus, input selection, checked rows, expanded groups and scrolling, and highlights only fresh rows', async () => {
  const h = harness({ realRender: true }); h.baseline();
  const dom = new JSDOM('<div id="scroll-parent"><div id="bl-root"></div></div>', { pretendToBeVisual: true });
  const { window } = dom, { document } = window;
  let scrollPosition = [12, 340];
  Object.defineProperties(window, { scrollX: { get: () => scrollPosition[0] }, scrollY: { get: () => scrollPosition[1] } });
  window.scrollTo = (x, y) => { scrollPosition = [x, y]; };
  h.ctx.document = document; h.ctx.window = window;
  h.ctx.blSyncBatchBtn = () => {};
  h.ctx.blOverviewHtml = () => '<input id="bl-q" value="server value">' +
    '<div class="bl-row" data-grp="project-1" data-item="TASK-95"><input class="bl-pick" data-pick="project-1:TASK-95" type="checkbox"></div>' +
    (h.ctx.blState.data.data[0].items.some(it => it.itemId === 'TASK-96') ? '<div class="bl-row" data-grp="project-1" data-item="TASK-96"></div>' : '');
  vm.runInContext(block('function blRender(preserve)', 'function blBoardItem('), h.ctx);
  h.ctx.blRender();
  const root = document.getElementById('bl-root'), parent = document.getElementById('scroll-parent');
  root.scrollTop = 125; root.scrollLeft = 7; parent.scrollTop = 450;
  h.ctx.blState.expanded['project-1'] = false;
  const input = document.getElementById('bl-q'); input.value = 'local search text'; input.focus(); input.setSelectionRange(2, 7);
  root.querySelector('.bl-pick').checked = true;
  const next = response(); next.data[0].items.push({ itemId: 'TASK-96', title: 'Fresh', updatedDate: '2026-11-13' });
  h.ctx.respond = () => next;
  assert.equal(await h.ctx.renderBacklogView(true, true), true);
  const restored = document.getElementById('bl-q');
  assert.equal(document.activeElement, restored);
  assert.equal(restored.value, 'local search text');
  assert.equal(restored.selectionStart, 2); assert.equal(restored.selectionEnd, 7);
  assert.equal(root.querySelector('.bl-pick').checked, true);
  assert.equal(h.ctx.blState.picked['project-1:TASK-95'], 1);
  assert.equal(h.ctx.blState.expanded['project-1'], false);
  assert.equal(root.scrollTop, 125); assert.equal(root.scrollLeft, 7); assert.equal(parent.scrollTop, 450);
  assert.deepEqual(scrollPosition, [12, 340]);
  assert.equal(root.querySelector('[data-item="TASK-95"]').classList.contains('bl-fresh'), false);
  assert.equal(root.querySelector('[data-item="TASK-96"]').classList.contains('bl-fresh'), true);
  await h.advance(50);
  assert.equal(root.querySelector('[data-item="TASK-96"]').classList.contains('bl-fresh'), false);
  dom.window.close();
});

test('real full refresh seeds a matching signature, so the next unchanged limited probe does not fetch again', async () => {
  const h = harness({ realRender: true });
  const full = response(); full.data[0].truncated = false;
  full.data[0].items.unshift({ itemId: 'TASK-94', title: 'Older', updatedDate: '2026-11-11' });
  h.ctx.respond = url => new URL(url, 'http://fixture.invalid').searchParams.has('maxCount') ? response() : full;
  assert.equal(await h.ctx.renderBacklogView(true), true);
  assert.equal(h.requests.length, 1);
  await h.advance(8000);
  assert.equal(h.requests.length, 2, 'only one limited probe after initial full fetch');
  assert.equal(h.paints.length, 2, 'initial loading and completed render only');
});

for (const invalidation of ['epoch', 'filters', 'board']) {
  test(`real automatic full refresh rejects outdated data after ${invalidation} changes`, async () => {
    const h = harness({ realRender: true }); h.baseline();
    const oldData = h.ctx.blState.data, oldSignature = h.ctx.blPoll.signature;
    const gate = deferred(); h.ctx.respond = () => gate.promise;
    const refresh = h.ctx.renderBacklogView(true, true);
    if (invalidation === 'epoch') h.ctx.blPollSync();
    if (invalidation === 'filters') h.ctx.blState.filters.search = 'new query';
    if (invalidation === 'board') h.ctx.blState.board = {};
    const changed = response(); changed.data[0].total++;
    gate.resolve(changed);
    assert.equal(await refresh, false);
    assert.equal(h.ctx.blState.data, oldData);
    assert.equal(h.ctx.blPoll.signature, oldSignature);
    assert.equal(h.ctx.blState.loading, false);
    assert.equal(h.paints.length, 0);
  });
}
