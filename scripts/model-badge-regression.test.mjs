import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { JSDOM } from 'jsdom';

// AI 回复模型角标回归（backlog task-101）：AI 气泡按消息粒度显示该轮实际使用的 provider/model；
// 历史消息缺 model 字段时兼容渲染不报错。
const compiled = ts.transpileModule(readFileSync(new URL('../src/web-ui.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText;
const { renderWebUi } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
const html = renderWebUi('');
const js = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)][0][1];
function block(start, end) {
  const from = js.indexOf(start), to = js.indexOf(end, from);
  assert(from >= 0 && to > from, 'block not found: ' + start);
  return js.slice(from, to);
}

function ctxFor() {
  const dom = new JSDOM('<div id="host"></div>');
  const ctx = {
    document: dom.window.document,
    esc: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    md: (s) => String(s ?? ''),
    fmtTime: () => '12:00',
    DSH_ICONS: { copy: '' },
    wireCopyAction() {},
    syncQueuedUI() {},
    createBlock() { const el = ctx.document.createElement('div'); return { el, fill() {}, append() {}, upsert() {} }; },
    applyUsageBadge() {},
    renderTurnChanges() {},
    withFileLinks: (_t, _a, s) => s,
    state: { agents: [], taskCache: new Map(), turnEls: {} },
    modelState: {},
    mainAgentState: {},
    openTask() {},
  };
  vm.createContext(ctx);
  return ctx;
}

test('assistant bubble shows actual per-turn model (provider/model) over inference', () => {
  const ctx = ctxFor();
  vm.runInContext(block('function buildTurnElement(', '\n/** 排队消息 UI'), ctx);
  const flow = ctx.buildTurnElement('task-1', {
    id: 't1', role: 'agent', agentId: 'agent-a', agentName: 'agent-a', text: 'hello',
    at: Date.now(), model: 'deepseek/deepseek-v3',
  });
  const pill = flow.querySelector('.dsh-usage-pill[data-role="agent"]');
  assert.ok(pill, 'agent pill missing');
  assert.match(pill.textContent, /agent-a · deepseek\/deepseek-v3/);
});

test('history turns without model field render without errors (fallback inference, no badge garbage)', () => {
  const ctx = ctxFor();
  vm.runInContext(block('function buildTurnElement(', '\n/** 排队消息 UI'), ctx);
  const flow = ctx.buildTurnElement('task-1', {
    id: 't2', role: 'agent', agentId: 'agent-a', agentName: '张三', text: 'legacy turn', at: Date.now(),
  });
  const pill = flow.querySelector('.dsh-usage-pill[data-role="agent"]');
  assert.ok(pill);
  // 无实体配置模型时仅显示发送者名，不出乱码
  assert.doesNotMatch(pill.textContent, /undefined|\[object/);
});

test('applyModelBadge updates pill on turn_end and stays idempotent', () => {
  const ctx = ctxFor();
  vm.runInContext(block('function buildTurnElement(', '\n/** 排队消息 UI'), ctx);
  vm.runInContext(block('function applyModelBadge(', '\nfunction ' + ''), ctx);
  const flow = ctx.buildTurnElement('task-1', {
    id: 't3', role: 'agent', agentId: 'agent-b', agentName: 'writer', text: 'x', at: Date.now(),
  });
  ctx.applyModelBadge(flow, 'zai-coding-cn/glm-5.3');
  const pill = flow.querySelector('.dsh-usage-pill[data-role="agent"]');
  assert.equal(pill.textContent, 'writer · zai-coding-cn/glm-5.3');
  // 幂等：同值不重复拼接
  ctx.applyModelBadge(flow, 'zai-coding-cn/glm-5.3');
  assert.equal(pill.textContent, 'writer · zai-coding-cn/glm-5.3');
  // 空/缺失模型不改写（历史消息兼容）
  ctx.applyModelBadge(flow, undefined);
  assert.equal(pill.textContent, 'writer · zai-coding-cn/glm-5.3');
});
