import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { JSDOM } from 'jsdom';

// Exercise generated browser functions directly from source, before building.
const compiled = ts.transpileModule(readFileSync(new URL('../src/web-ui.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText;
const { renderWebUi } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const html = renderWebUi('');
const js = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)][0][1];
function block(start, end) {
  const from = js.indexOf(start), to = js.indexOf(end, from);
  assert(from >= 0 && to > from);
  return js.slice(from, to);
}
function harness() {
  const dom = new JSDOM('<div id="todo-dock"></div><div id="foot"></div>');
  let now = 100000;
  const ctx = {
    document: dom.window.document, Date: { now: () => now },
    state: { task: { turns: [{ role: 'agent', at: 40000 }] } },
    todoState: { running: false, baseElapsed: 0, anchorAt: 0 },
    esc: String, fmtStatsTokens: String, fmtStatsDuration: String,
    renderStatPills() {}, openModal(_title, body) { ctx.modal = body; }, closeModal() {},
  };
  ctx.$ = id => ctx.document.getElementById(id);
  vm.createContext(ctx);
  vm.runInContext(block('function cacheHitPercent(', '/** 本轮变更文件'), ctx);
  vm.runInContext(block('function renderTodoDock(', '// 运行中每秒刷新'), ctx);
  return { ctx, advance(ms) { now += ms; } };
}

test('explicit zero uncached input is preserved in badge, modal and cache hit', () => {
  const { ctx } = harness();
  const usage = { inputTokens: 100, uncachedInputTokens: 0, cacheReadTokens: 100, outputTokens: 7 };
  assert.equal(ctx.cacheHitPercent(usage), 100);
  ctx.applyUsageBadge({ foot: ctx.$('foot') }, usage);
  const pill = ctx.$('foot').querySelector('button');
  assert.match(pill.title, /107 tok/);
  pill.click();
  assert.match(ctx.modal, /输入（未命中缓存）<\/span><b>0 tok/);
});

test('usage modal has shared row layout outside the stat panel', () => {
  const { ctx } = harness();
  ctx.openTurnUsageDetail({}, 0, null, 0);
  assert.match(ctx.modal, /class="turn-usage-detail"/);
  assert.match(html, /\.turn-usage-detail \.sp-r\s*\{[^}]*display: flex/);
});

test('runtime without remote timing uses WorkBuddy turn start across polls', () => {
  const { ctx, advance } = harness();
  const payload = { todos: [], running: true, elapsedMs: 0, turnStartedAt: null };
  ctx.renderTodoDock(payload);
  assert.equal(ctx.todoState.baseElapsed, 60000);
  advance(3000);
  ctx.renderTodoDock(payload);
  assert.equal(ctx.todoState.baseElapsed, 63000);
});

test('zero remote elapsed with a start timestamp still uses local lifecycle', () => {
  const { ctx, advance } = harness();
  const data = { todos: [], running: true, elapsedMs: 0, turnStartedAt: 40000 };
  ctx.renderTodoDock(data);
  assert.equal(ctx.todoState.baseElapsed, 60000);
  advance(3000);
  ctx.renderTodoDock(data);
  assert.equal(ctx.todoState.baseElapsed, 63000);
});

test('completed turn retains its local duration when node provides no timing', () => {
  const { ctx } = harness();
  ctx.state.task.turns[0].endedAt = 90000;
  ctx.renderTodoDock({ todos: [], running: false, elapsedMs: 0, turnStartedAt: null });
  assert.equal(ctx.todoState.baseElapsed, 50000);
});

test('authoritative remote elapsed still takes precedence', () => {
  const { ctx } = harness();
  ctx.renderTodoDock({ todos: [], running: true, elapsedMs: 15000, turnStartedAt: 85000 });
  assert.equal(ctx.todoState.baseElapsed, 15000);
});
