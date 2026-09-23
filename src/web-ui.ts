/**
 * onenat-workbuddy-web - Interactive Web Console UI
 *
 * 单页控制台: 工作台(任务多轮聊天) / 子智能体 / 资源目录 / 设置
 *
 * 深度集成 DSH Web 架构设计与性能优化：
 *  1. 会话列表管理：按时间分组（今天/前7天/更早/已归档）、即时搜索过滤、状态脉冲指示、子智能体成员徽章；
 *  2. 0ms 瞬时会话切换：客户端内存 Store 缓存已访问会话，切换时瞬间呈现，后台静默增量同步；
 *  3. 高性能历史渲染：分页分块渲染（最新轮次优先 + 向上加载更早历史）、Markdown 编译缓存、DocumentFragment 批处理挂载；
 *  4. RAF 节流流式更新：requestAnimationFrame 聚合 SSE 高频 delta/reasoning，智能跟随滚动（不打断用户向上查阅）；
 *  5. 子智能体交互模式深度融合：自适应 Header、各智能体独立气泡、可折叠思考流、工具调用执行树、DAG 编排计划追踪与子会话穿透。
 *
 * 注意: 嵌入式 JS 全程不使用外层反引号模板串冲突字符，避免转义问题。
 */

export function renderWebUi(prefix: string, opts?: { auth?: boolean; version?: string }): string {
  const AUTH_ENABLED = opts?.auth === true
  const VERSION = String(opts?.version || '')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="theme-color" content="#090e17">
<title>OneNat WorkBuddy · 多智能体协作工作台</title>
<style>
:root {
  --bg: #090e17; --bg2: #0f172a; --bg3: #182238; --bg-hover: #1e2c47;
  --line: #202e48; --line2: #2e4166; --line-light: rgba(148, 163, 184, 0.15);
  --tx: #f1f5f9; --tx2: #94a3b8; --tx3: #64748b;
  --pri: #38bdf8; --pri-d: #0284c7; --pri-light: rgba(56, 189, 248, 0.12);
  --acc: #818cf8; --acc-light: rgba(129, 140, 248, 0.12);
  --ok: #34d399; --ok-light: rgba(52, 211, 153, 0.15);
  --warn: #fbbf24; --warn-light: rgba(251, 191, 36, 0.15);
  --err: #f87171; --err-light: rgba(248, 113, 113, 0.15);
  --rad: 10px; --rad-sm: 6px;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; width: 100%; }
body { background: var(--bg); color: var(--tx); font-family: var(--font); font-size: 14px; overflow: hidden; -webkit-font-smoothing: antialiased; -webkit-tap-highlight-color: transparent; overscroll-behavior: none; }
button { font-family: inherit; cursor: pointer; border: none; outline: none; touch-action: manipulation; }
input, textarea, select { font-family: inherit; font-size: 13px; background: var(--bg); border: 1px solid var(--line); color: var(--tx); border-radius: var(--rad-sm); padding: 8px 10px; outline: none; width: 100%; }
input:focus, textarea:focus, select:focus { border-color: var(--pri); }
textarea { resize: vertical; min-height: 56px; }
::placeholder { color: var(--tx3); }
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-thumb { background: var(--line2); border-radius: 3px; }
::-webkit-scrollbar-track { background: transparent; }

/* ---- Layout ---- */
#app { display: flex; flex-direction: column; height: 100vh; height: 100dvh; width: 100vw; overflow: hidden; }
header {
  background: var(--bg2); border-bottom: 1px solid var(--line); height: 52px;
  display: flex; align-items: center; gap: 16px; padding: 0 18px; flex: none; z-index: 30;
}
.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 15px; user-select: none; }
.brand .logo {
  width: 28px; height: 28px; border-radius: 7px;
  background: linear-gradient(135deg, #0284c7, #818cf8);
  display: flex; align-items: center; justify-content: center; font-size: 14px;
  box-shadow: 0 0 12px rgba(56,189,248,.35);
}
.brand small { color: var(--tx3); font-weight: 400; font-size: 11px; margin-left: 4px; }
nav { display: flex; gap: 2px; align-items: center; }
.nav-sep { width: 1px; height: 18px; background: var(--line); margin: 0 7px; flex: none; }
.settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; align-items: start; margin-bottom: 12px; }
.settings-grid .card { margin: 0; }
.settings-grid .ai-card { grid-column: 1 / -1; }
@media (max-width: 900px) { .settings-grid { grid-template-columns: 1fr; } }
nav button {
  background: transparent; color: var(--tx2); padding: 6px 12px; border-radius: var(--rad-sm);
  font-size: 13px; font-weight: 500; transition: all .15s ease;
  display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;
}
nav button .ic { font-size: 1.05em; line-height: 1; }
nav button:hover { color: var(--tx); background: var(--bg3); }
nav button.on { color: var(--pri); background: var(--pri-light); font-weight: 600; box-shadow: inset 0 2px 0 var(--pri); }
.hspacer { flex: 1; }
.chip {
  display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--tx2);
  background: var(--bg3); border: 1px solid var(--line); border-radius: 999px; padding: 4px 12px;
}
.chip .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--err); }
.chip .dot.ok { background: var(--ok); }
main { flex: 1; display: flex; overflow: hidden; position: relative; }
.view { display: none; flex: 1; overflow: hidden; }
.view.on { display: flex; }

/* ---- 工作台 会话侧栏 ---- */
#view-work { display: none; }
#view-work.on { display: flex; }
.task-side {
  width: 280px; flex: none; background: var(--bg2); border-right: 1px solid var(--line);
  display: flex; flex-direction: column; overflow: hidden;
}
.side-head {
  padding: 12px 14px 8px; display: flex; align-items: center; justify-content: space-between; gap: 8px;
}
.side-head b { font-size: 13px; color: var(--tx2); letter-spacing: .02em; }
.btn-new {
  background: linear-gradient(135deg, #0284c7, #2563eb); color: #fff; border-radius: var(--rad-sm);
  padding: 6px 12px; font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; gap: 4px;
  box-shadow: 0 2px 8px rgba(2, 132, 199, 0.3); transition: filter .15s ease;
}
.btn-new:hover { filter: brightness(1.15); }
.side-search-box {
  padding: 0 12px 8px; position: relative;
}
.side-search-box input {
  background: var(--bg); border: 1px solid var(--line); font-size: 12px; padding: 6px 10px 6px 26px;
  border-radius: 6px;
}
.side-search-box .s-icon {
  position: absolute; left: 20px; top: 7px; color: var(--tx3); font-size: 12px; pointer-events: none;
}
.side-search-box .s-clear {
  position: absolute; right: 20px; top: 6px; color: var(--tx3); font-size: 12px; cursor: pointer; display: none;
}
.side-search-box .s-clear:hover { color: var(--tx); }
.task-list {
  flex: 1; overflow-y: auto; padding: 2px 8px 12px;
}

/* 侧栏分组 */
.group-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 8px 4px; font-size: 11px; font-weight: 600; color: var(--tx3);
  cursor: pointer; user-select: none; text-transform: uppercase; letter-spacing: .04em;
}
.group-header:hover { color: var(--tx2); }
.group-header .gh-left { display: flex; align-items: center; gap: 4px; }
.group-header .gh-chev { font-size: 10px; width: 12px; }
.group-header .gh-cnt { font-size: 10.5px; opacity: .7; font-weight: 400; }
.group-body { display: flex; flex-direction: column; gap: 2px; }
.group-body.collapsed { display: none; }

/* 会话条目 */
.task-item {
  padding: 8px 10px; border-radius: 8px; cursor: pointer; position: relative;
  display: flex; flex-direction: column; gap: 3px; border: 1px solid transparent;
  transition: background .12s ease, border-color .12s ease;
}
.task-item:hover { background: var(--bg3); }
.task-item.on {
  background: var(--pri-light); border-color: rgba(56, 189, 248, 0.35);
}
.task-item .row-top {
  display: flex; align-items: center; gap: 7px; min-width: 0;
}
.task-item .s {
  width: 7px; height: 7px; border-radius: 50%; flex: none;
}
.s.running { background: var(--warn); box-shadow: 0 0 8px var(--warn); animation: pulse 1.2s infinite; }
.s.completed { background: var(--ok); }
.s.failed { background: var(--err); }
.s.partial_success { background: var(--warn); }
.s.draft { background: var(--tx3); }
@keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .4; transform: scale(1.15); } }

.task-item .t {
  flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; font-weight: 500;
}
.task-item.on .t { color: var(--tx); font-weight: 600; }
.task-item .mode-badge {
  font-size: 10px; border-radius: 4px; padding: 1px 5px; flex: none;
  background: rgba(129, 140, 248, 0.15); color: var(--acc); border: 1px solid rgba(129, 140, 248, 0.3);
}
.task-item .mode-badge.chat {
  background: rgba(56, 189, 248, 0.12); color: var(--pri); border-color: rgba(56, 189, 248, 0.25);
}
.task-item .row-sub {
  display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--tx3);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 14px;
}
.task-item .acts {
  display: none; position: absolute; right: 6px; top: 7px; gap: 2px; background: var(--bg2);
  border-radius: 4px; padding: 1px 2px; box-shadow: 0 2px 6px rgba(0,0,0,.4);
}
.task-item:hover .acts { display: flex; }
.task-item.on .acts { background: var(--bg3); }
.task-item .acts button {
  background: transparent; border: none; cursor: pointer; font-size: 11px; padding: 2px 4px;
  border-radius: 4px; opacity: .8; color: var(--tx2);
}
.task-item .acts button:hover { background: var(--bg-hover); opacity: 1; color: var(--tx); }
.task-item.archived { opacity: .65; }

/* ---- 对话窗口主体 ---- */
.chat-main { flex: 1; display: flex; flex-direction: column; overflow: hidden; background: var(--bg); position: relative; }
.chat-head {
  height: 52px; flex: none; border-bottom: 1px solid var(--line); display: flex; align-items: center;
  gap: 10px; padding: 0 18px; background: var(--bg2); z-index: 10;
}
.chat-head .title {
  font-weight: 600; font-size: 14px; color: var(--tx); overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; max-width: 380px;
}
.chat-head .title:hover { color: var(--pri); cursor: default; }
.badge {
  font-size: 11px; border-radius: 999px; padding: 2px 9px; border: 1px solid var(--line2); color: var(--tx2); flex: none;
}
.badge.mode { color: var(--acc); border-color: rgba(129,140,248,.4); background: var(--acc-light); }
.badge.mode.chat { color: var(--pri); border-color: rgba(56,189,248,.4); background: var(--pri-light); }
.badge.mode.chat.direct { color: var(--ok); border-color: rgba(74,222,128,.4); background: var(--ok-light); font-weight: 600; }
.member-chips { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.mchip {
  display: inline-flex; align-items: center; gap: 5px; background: var(--bg3); border: 1px solid var(--line2);
  font-size: 11.5px; color: var(--tx2); border-radius: 999px; padding: 2px 8px; user-select: none;
}
.mchip .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); flex: none; }
.mchip .x { cursor: pointer; color: var(--tx3); font-size: 11px; margin-left: 2px; }
.mchip .x:hover { color: var(--err); }

/* ---- 聊天头部主智能体选择器 ---- */
.main-agent-picker { position: relative; flex: none; }
.main-agent-btn {
  display: inline-flex; align-items: center; gap: 6px;
  background: var(--bg3); border: 1px solid var(--line2); border-radius: var(--rad-sm);
  color: var(--tx2); padding: 5px 11px; font-size: 12px; font-weight: 500;
  cursor: pointer; white-space: nowrap; max-width: 280px;
  transition: all .15s ease;
}
.main-agent-btn:hover { color: var(--pri); border-color: var(--pri); background: var(--bg-hover); }
.main-agent-btn .ag-ico { font-size: 13px; line-height: 1; flex: none; }
.main-agent-btn .ag-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.main-agent-btn .ag-arr { font-size: 10px; opacity: .7; flex: none; margin-left: 2px; }
.main-agent-btn.ok {
  border-color: rgba(52,211,153,.65) !important; color: #a7f3d0 !important;
  transition: border-color .18s ease, color .18s ease;
}

.main-agent-pop {
  position: absolute; top: calc(100% + 6px); right: 0; z-index: 75;
  width: 350px; max-width: calc(100vw - 24px); max-height: 54vh; overflow-y: auto; -webkit-overflow-scrolling: touch;
  background: var(--bg2); border: 1px solid var(--line2); border-radius: 10px;
  box-shadow: 0 12px 38px rgba(0,0,0,.6); padding: 6px; display: none;
}
.main-agent-pop.on { display: block; }
.main-agent-pop-head {
  display: flex; justify-content: space-between; align-items: center; gap: 8px;
  padding: 6px 10px; font-size: 11px; color: var(--tx3);
  border-bottom: 1px solid var(--line); margin-bottom: 4px;
}
.main-agent-item {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px;
  cursor: pointer; font-size: 12.5px; color: var(--tx); transition: background .12s ease;
}
.main-agent-item:hover { background: var(--bg-hover); }
.main-agent-item.on { color: var(--pri); background: var(--pri-light); }
.main-agent-item .ag-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.main-agent-item .ag-title { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.main-agent-item .ag-sub { font-size: 11px; color: var(--tx3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.main-agent-item.on .ag-sub { color: rgba(56, 189, 248, 0.75); }
.main-agent-item .ag-ck { flex: none; visibility: hidden; font-weight: 700; color: var(--pri); }
.main-agent-item.on .ag-ck { visibility: visible; }

.chat-scroll {
  flex: 1; overflow-y: auto; padding: 18px 24px 28px; scroll-behavior: auto;
}
.chat-empty {
  height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center;
  color: var(--tx3); gap: 12px; user-select: none;
}

.qe-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 18px; width: min(620px, 92%); }
.qe-card {
  display: flex; flex-direction: column; align-items: flex-start; gap: 3px; text-align: left;
  background: var(--bg2); border: 1px solid var(--line); border-radius: var(--rad); padding: 10px 12px;
  font-family: inherit; color: var(--tx); cursor: pointer; transition: border-color .15s, transform .15s;
}
.qe-card:hover { border-color: var(--pri); transform: translateY(-1px); }
.qe-card .qe-ic { font-size: 16px; }
.qe-card b { font-size: 12.5px; font-weight: 600; }
.qe-card .qe-d { font-size: 11px; color: var(--tx3); line-height: 1.45; }
.chat-loading {
  display: flex; align-items: center; justify-content: center; height: 100%; color: var(--tx3); font-size: 13px; gap: 8px;
}

/* 历史消息加载更早提示按钮 */
.hist-more-bar {
  display: flex; justify-content: center; margin: 0 0 16px;
}
.hist-more-btn {
  background: var(--bg2); border: 1px dashed var(--line2); color: var(--tx2); font-size: 12px;
  padding: 6px 16px; border-radius: 999px; cursor: pointer; transition: all .15s ease;
}
.hist-more-btn:hover { color: var(--pri); border-color: var(--pri); background: var(--pri-light); }

/* ---- 对话消息条目 & DSH Web 级 Markdown 样式体系 ---- */
.msg { margin-bottom: 22px; display: flex; gap: 12px; max-width: 980px; }
.msg.user { margin-left: auto; flex-direction: row-reverse; }
.msg .avatar {
  width: 32px; height: 32px; border-radius: 8px; flex: none; display: flex; align-items: center;
  justify-content: center; font-size: 13px; font-weight: 700; color: #fff; user-select: none;
}
.msg.user .avatar { background: #334155; }
.msg.agent .avatar { background: linear-gradient(135deg, #0284c7, #818cf8); }
.msg.agent.orchestrator .avatar { background: linear-gradient(135deg, #f59e0b, #ef4444); }
.msg.system .avatar { background: #7c2d3a; }
.msg .bubble { flex: 1; min-width: 0; }
.msg.agent .bubble, .msg.system .bubble { border-left: 2px solid rgba(99, 140, 255, 0.28); padding-left: 14px; }
.msg .meta {
  font-size: 11.5px; color: var(--tx3); margin-bottom: 6px; display: flex; gap: 8px; align-items: center;
}
.msg.user .meta { justify-content: flex-end; }
.msg .meta .tag-model {
  background: var(--bg3); border: 1px solid var(--line); border-radius: 4px; padding: 0 5px; font-size: 10px; color: var(--tx2);
}
.msg .meta .tag-cache {
  background: rgba(99, 140, 255, 0.10); border: 1px solid rgba(99, 140, 255, 0.35); border-radius: 4px; padding: 0 5px; font-size: 10px; color: var(--pri); white-space: nowrap;
}

/* DSH Web 规范 Markdown 内容区 */
.msg .content {
  line-height: 1.65; word-break: break-word; font-size: 13.5px; color: var(--tx);
}
.msg.user .content {
  background: #1e293b; border: 1px solid var(--line2); border-radius: 12px 2px 12px 12px;
  padding: 10px 14px; display: inline-block; text-align: left;
}
.msg.user .content p { margin: 0; }

@keyframes sysWaitPulse { 0%, 100% { opacity: 1 } 50% { opacity: .4 } }
@keyframes sysWaitDots { 0% { content: '' } 25% { content: '·' } 50% { content: '··' } 75%, 100% { content: '···' } }
body.task-running .msg.system.sys-planning .content {
  animation: sysWaitPulse 1.7s ease-in-out infinite;
}
body.task-running .msg.system.sys-planning .content::after {
  content: ''; display: inline-block; width: 1.4em; text-align: left; color: var(--warn);
  animation: sysWaitDots 1.6s steps(1, end) infinite;
}
.markdown { overflow-wrap: anywhere; }
.markdown h1 { font-size: 18px; font-weight: 700; margin: 20px 0 10px; color: var(--tx); border-bottom: 1px solid var(--line); padding-bottom: 6px; }
.markdown h2 { font-size: 16px; font-weight: 600; margin: 18px 0 8px; color: var(--tx); }
.markdown h3 { font-size: 14.5px; font-weight: 600; margin: 14px 0 6px; color: var(--tx); }
.markdown h4 { font-size: 13.5px; font-weight: 600; margin: 12px 0 4px; color: var(--tx); }
.markdown p { margin: 10px 0; }
.markdown p:first-child { margin-top: 0; }
.markdown p:last-child { margin-bottom: 0; }
.markdown strong { font-weight: 600; color: #fff; }
.markdown em { font-style: italic; }
.markdown s { text-decoration: line-through; opacity: .75; }
.markdown hr { border: none; height: 1px; background: var(--line); margin: 16px 0; }
.markdown blockquote {
  border-left: 3px solid var(--pri-d); background: rgba(2,132,199,.06); border-radius: 0 6px 6px 0;
  padding: 6px 12px; margin: 10px 0; color: var(--tx2); font-size: 13px;
}
.markdown a { color: var(--pri); text-decoration: none; border-bottom: 1px solid transparent; transition: border-color .15s ease; }
.markdown a:hover { border-color: var(--pri); text-decoration: none; }
.markdown ul, .markdown ol { margin: 10px 0; padding-left: 20px; }
.markdown li { margin: 4px 0; }
.markdown li > p { margin: 4px 0; }
.markdown input[type="checkbox"] {
  width: auto; margin-right: 6px; vertical-align: middle; accent-color: var(--pri);
}

/* 行内代码 */
.markdown :not(pre) > code {
  font-family: var(--mono); font-size: 12px; background: #162238; border: 1px solid var(--line);
  color: #38bdf8; border-radius: 4px; padding: 1px 5px; margin: 0 2px;
}

/* @ 提及高亮胶囊 (Mention Pill) */
.markdown .mention-tag {
  display: inline-flex; align-items: center; background: rgba(56, 189, 248, 0.15); border: 1px solid rgba(56, 189, 248, 0.4);
  color: #38bdf8; border-radius: 4px; padding: 0 5px; font-weight: 600; font-size: 12px; margin: 0 2px;
}

/* 代码块 Banner + 复制（对齐 DSH CodeBlock） */
.md-code-block {
  margin: 12px 0; border-radius: 10px; background: #070c14; border: 1px solid var(--line); overflow: hidden;
}
.md-code-banner {
  display: flex; align-items: center; justify-content: space-between; padding: 6px 12px;
  background: #0f172a; border-bottom: 1px solid var(--line); font-size: 11px; color: var(--tx3);
  font-family: var(--mono); user-select: none;
}
.md-code-lang { font-weight: 600; color: var(--tx2); text-transform: uppercase; letter-spacing: .05em; }
.md-code-copy {
  background: transparent; border: 1px solid var(--line2); color: var(--tx2); border-radius: 4px;
  padding: 2px 7px; font-size: 10.5px; cursor: pointer; transition: all .15s ease;
}
.md-code-copy:hover { color: var(--pri); border-color: var(--pri); }
.md-code-copy.copied { color: var(--ok); border-color: var(--ok); }
.md-code-block pre {
  margin: 0; padding: 12px 14px; overflow-x: auto; background: transparent; font-family: var(--mono);
  font-size: 12.5px; line-height: 1.6; color: #e2e8f0;
}
.md-code-block pre code { border: none; background: none; padding: 0; margin: 0; color: inherit; font-size: inherit; }

/* GFM 表格（对齐 DSH TableWrapper） */
.md-table-wrap {
  max-width: 100%; overflow-x: auto; margin: 12px 0; border: 1px solid var(--line); border-radius: 8px;
}
.md-table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: left; }
.md-table th {
  background: #0f172a; padding: 8px 12px; font-weight: 600; color: var(--tx2); font-size: 12px;
  border-bottom: 1px solid var(--line); border-right: 1px solid var(--line);
}
.md-table th:last-child { border-right: none; }
.md-table td {
  padding: 8px 12px; border-bottom: 1px solid rgba(148,163,184,.1); border-right: 1px solid rgba(148,163,184,.1); color: var(--tx);
  word-break: break-word; overflow-wrap: anywhere;
}
.md-table td:last-child { border-right: none; }
.md-table tr:last-child td { border-bottom: none; }
.md-table tr:nth-child(even) td { background: rgba(255,255,255,.015); }
.md-table tr:hover td { background: rgba(56,189,248,.05); }
.cursor {
  display: inline-block; width: 7px; height: 14px; background: var(--pri);
  animation: pulse .8s infinite; vertical-align: text-bottom; margin-left: 2px;
}

/* 思考过程组件 */
.blocks { display: flex; flex-direction: column; gap: 6px; }
.blk { min-width: 0; }
.blk-text { margin: 2px 0; }
.blk-tool .tw-row { margin: 0; }
.rz {
  margin: 4px 0 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg2); overflow: hidden;
}
.rz-head {
  display: flex; align-items: center; gap: 6px; padding: 6px 10px; font-size: 11.5px; color: var(--tx3);
  cursor: pointer; user-select: none; transition: color .15s ease;
}
.rz-head:hover { color: var(--tx2); background: rgba(255,255,255,.02); }
.rz-chev { display: inline-block; width: 10px; transition: transform .15s ease; }
.rz-sum { flex: 1; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .75; }
.rz-body {
  display: none; border-top: 1px dashed var(--line); padding: 8px 12px; color: var(--tx3);
  font-size: 12px; white-space: pre-wrap; max-height: 200px; overflow-y: auto; line-height: 1.55;
  font-family: var(--mono); background: rgba(0,0,0,.15);
}

/* 主调度规划气泡（system 轮次）：拆解结论 + ▸ 阶段日志流水 + 可折叠思考流 */
.msg.system .blk-text p { margin: 2px 0; font-size: 13px; }
.msg.system .blk-text p:first-child { margin-top: 0; }
.msg.system .rz { background: rgba(15, 23, 42, 0.55); }
.msg.system .rz-body { max-height: 260px; }

/* 工具调用树组件 */
.tws { margin: 4px 0 8px; }
.tws-head {
  display: flex; align-items: center; gap: 6px; padding: 5px 10px; font-size: 11.5px; color: var(--tx3);
  cursor: pointer; user-select: none; border-radius: 6px; background: rgba(15, 23, 42, 0.6);
  border: 1px solid var(--line); width: fit-content;
}
.tws-head:hover { color: var(--pri); border-color: rgba(56,189,248,.3); }
.tws-body { margin: 6px 0 4px 10px; border-left: 2px solid rgba(99,140,255,.25); padding-left: 6px; display: flex; flex-direction: column; gap: 4px; }
.tw-row {
  padding: 4px 8px; font-size: 11.5px; background: var(--bg2); border: 1px solid var(--line); border-radius: 6px;
}
.tw-line { display: flex; gap: 6px; align-items: center; cursor: pointer; color: var(--tx2); min-width: 0; }
.tw-line:hover { color: var(--pri); }
.tw-ic { font-size: 11px; }
.tw-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); }
.tw-ms { color: var(--tx3); flex: none; font-size: 10.5px; }
.tw-chev { color: var(--tx3); flex: none; font-size: 10px; }
.tw-detail {
  margin: 4px 0 2px; padding: 6px 8px; background: rgba(2,6,23,.55); border: 1px solid rgba(148,163,184,.15);
  border-radius: 6px; font-family: var(--mono); font-size: 11px; white-space: pre-wrap; word-break: break-all;
  max-height: 180px; overflow-y: auto; color: var(--tx2);
}

/* 问答交互卡片 */
.ask-card {
  margin: 10px 0; padding: 14px 16px; background: var(--bg2); border: 1px solid rgba(99, 140, 255, 0.45);
  border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.3); display: flex; flex-direction: column; gap: 12px;
  max-width: 720px; width: 100%; box-sizing: border-box;
}
.ask-card.submitted {
  border-color: rgba(52,211,153,0.35); background: rgba(15, 23, 42, 0.5); opacity: 0.92;
}
.ask-head {
  display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--pri);
  padding-bottom: 6px; border-bottom: 1px dashed var(--line);
}
.ask-head .ask-icon { font-size: 16px; }
.ask-head .ask-status {
  margin-left: auto; font-size: 11px; padding: 2px 9px; border-radius: 999px;
  background: rgba(99,140,255,0.15); color: var(--pri); border: 1px solid rgba(99,140,255,0.3);
}
.ask-card.submitted .ask-status {
  background: var(--ok-light); color: var(--ok); border-color: rgba(52,211,153,0.3); font-weight: 500;
}
.ask-q-title {
  font-size: 14px; font-weight: 600; color: var(--tx); line-height: 1.5; margin-bottom: 8px;
}
.ask-options {
  display: flex; flex-direction: column; gap: 8px;
}
.ask-opt {
  display: flex; align-items: flex-start; gap: 12px; padding: 10px 14px; background: rgba(255,255,255,0.03);
  border: 1px solid var(--line2); border-radius: 8px; cursor: pointer; transition: all 0.15s ease; user-select: none;
}
.ask-opt:hover {
  background: rgba(99,140,255,0.08); border-color: rgba(99,140,255,0.4);
}
.ask-opt.selected {
  background: rgba(99,140,255,0.15); border-color: var(--pri); box-shadow: 0 0 0 1px var(--pri);
}
.ask-card.submitted .ask-opt.selected {
  background: rgba(52,211,153,0.12); border-color: var(--ok); box-shadow: 0 0 0 1px var(--ok);
}
.ask-card.submitted .ask-opt:not(.selected) {
  opacity: 0.45; cursor: default;
}
.ask-opt input[type="radio"], .ask-opt input[type="checkbox"] {
  /* 全局 input 规则（width:100% + 边框 + 内边距）会把 radio/checkbox 拉成占满整行的大盒子，
     挤压选项文字成竖排——这里显式还原为原生控件外观 */
  width: auto; height: auto; flex: none; padding: 0; border: none; background: none; border-radius: 0;
  margin: 3px 0 0; accent-color: var(--pri); cursor: pointer; transform: scale(1.1);
}
.ask-opt-main { flex: 1; min-width: 0; }
.ask-opt-label { font-size: 13.5px; font-weight: 500; color: var(--tx); }
.ask-opt-desc { font-size: 12px; color: var(--tx3); margin-top: 3px; line-height: 1.45; }
.ask-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 6px; padding-top: 6px; }
.ask-btn-submit {
  padding: 8px 20px; font-size: 13px; font-weight: 600; border-radius: 7px; background: var(--pri);
  color: #fff; border: none; cursor: pointer; transition: all 0.15s ease; box-shadow: 0 2px 8px rgba(56,189,248,0.25);
}
.ask-btn-submit:disabled { opacity: 0.4; cursor: not-allowed; box-shadow: none; }
.ask-btn-submit:not(:disabled):hover { filter: brightness(1.1); transform: translateY(-1px); }

/* 编排计划卡片 */
.plan-card {
  border: 1px solid var(--line2); background: var(--bg2); border-radius: var(--rad); padding: 12px 16px; margin: 8px 0 20px;
}
.plan-card h4 { font-size: 13px; color: var(--acc); margin-bottom: 10px; display: flex; align-items: center; justify-content: space-between; }
.plan-row {
  display: flex; align-items: center; gap: 10px; padding: 7px 4px; border-top: 1px dashed var(--line); font-size: 12.5px;
  border-radius: 6px; position: relative; transition: background .3s ease;
}
.plan-row .st {
  flex: none; width: 68px; text-align: center; font-size: 10.5px; border-radius: 999px; padding: 2px 0; font-weight: 500;
  transition: background .35s ease, color .35s ease;
}
.st.pending { background: var(--bg3); color: var(--tx3); }
.st.running { background: var(--warn-light); color: var(--warn); }
.st.completed { background: var(--ok-light); color: var(--ok); }
.st.failed { background: var(--err-light); color: var(--err); }
.st.skipped { background: var(--bg3); color: var(--tx3); }

/* ---- 编排进行中的等待动效：running 行流光扫过 + 状态芯片呼吸 + 头部齿轮 ---- */
@keyframes planFlow { 0% { background-position: 120% 0 } 100% { background-position: -120% 0 } }
@keyframes stBreath { 0%, 100% { opacity: 1 } 50% { opacity: .45 } }
@keyframes gearSpin { to { transform: rotate(360deg) } }
@keyframes planBarPulse { 0%, 100% { opacity: .35; transform: scaleY(.7) } 50% { opacity: 1; transform: scaleY(1) } }
.plan-row.row-running {
  background-image: linear-gradient(90deg, rgba(251,191,36,0) 0%, rgba(251,191,36,.10) 45%, rgba(251,191,36,.16) 55%, rgba(251,191,36,0) 100%);
  background-size: 220% 100%;
  animation: planFlow 2.2s linear infinite;
}
.plan-row.row-running::before {
  content: ''; position: absolute; left: -4px; top: 18%; bottom: 18%; width: 3px; border-radius: 2px;
  background: var(--warn); animation: planBarPulse 1.3s ease-in-out infinite;
}
.plan-row.row-running .st.running { animation: stBreath 1.5s ease-in-out infinite; }
.plan-row.row-pending { opacity: .62; }
.plan-card .plan-gear { display: none; margin-right: 6px; }
.plan-card.plan-active .plan-gear {
  display: inline-flex; color: var(--warn);
  animation: gearSpin 2.2s linear infinite;
}
.plan-row .ag { color: var(--tx3); font-size: 11.5px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plan-row .ops { display: flex; gap: 6px; flex: none; }
/* DAG 依赖可视化 */
.plan-dep {
  display: inline-block; margin-top: 3px; font-size: 10.5px; color: var(--pri); background: rgba(99,140,255,.1);
  border: 1px solid rgba(99,140,255,.25); border-radius: 5px; padding: 1px 6px; max-width: 100%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: middle;
}
.plan-card.has-deps .plan-row { align-items: flex-start; }
.plan-card.has-deps .plan-row .ops { margin-top: 2px; }

/* 输入框与工具栏 */
.chat-input-container {
  flex: none; border-top: 1px solid var(--line); background: var(--bg2); display: flex; flex-direction: column;
}
.chat-input {
  padding: 10px 18px 8px; display: flex; gap: 10px; align-items: flex-end;
}
.chat-input textarea {
  min-height: 44px; max-height: 160px; line-height: 1.5; font-size: 13.5px;
}
.btn-send {
  background: linear-gradient(135deg, #0284c7, #2563eb); color: #fff; border-radius: var(--rad-sm);
  padding: 9px 18px; font-weight: 600; font-size: 13px; box-shadow: 0 2px 8px rgba(2, 132, 199, 0.3);
  transition: all .15s ease; flex: none;
}
.btn-send:disabled { opacity: .5; cursor: not-allowed; box-shadow: none; }
.btn-stop {
  background: transparent; border: 1px solid var(--err); color: var(--err); border-radius: var(--rad-sm);
  padding: 9px 14px; display: none; font-weight: 600; font-size: 12px; flex: none;
}
.btn-stop:hover { background: var(--err); color: #fff; }
.mini-btn {
  background: var(--bg3); border: 1px solid var(--line2); color: var(--tx2); font-size: 11px;
  border-radius: var(--rad-sm); padding: 4px 8px; transition: all .12s ease;
}
.mini-btn:hover { color: var(--pri); border-color: var(--pri); background: var(--bg-hover); }
.mini-btn.danger:hover { color: var(--err); border-color: var(--err); }
.composer-bar {
  display: flex; align-items: center; gap: 8px; padding: 6px 18px 8px;
  background: rgba(10,14,26,.4); min-height: 32px; flex-wrap: wrap; font-size: 12px;
}
.cfg-sel {
  width: auto; max-width: 220px; min-width: 130px; font-size: 11.5px !important;
  padding: 4px 8px !important; border-radius: 6px !important; flex: none;
}

/* 主调度模型选择：自定义弹层（原生 select 的移动端全屏弹窗体验差：字大、选项折行、样式失控） */
.model-picker { position: relative; flex: none; }
.model-btn {
  display: inline-block; text-align: left; cursor: pointer; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; max-width: 62vw; min-width: 150px;
  background: var(--bg3); border: 1px solid var(--line2); color: var(--tx2);
}
.model-btn:hover { color: var(--pri); border-color: var(--pri); }
/* 成功类操作的就地反馈：不再弹底部 toast（会盖住输入区、打断视线），
   改为「按钮/输入区脉冲 + 输入区上方一行淡出小字」——反馈贴近发生位置，不遮挡操作区。 */
.model-btn.ok, .btn-at-file.ok {
  border-color: rgba(52,211,153,.65) !important; color: #a7f3d0 !important;
  transition: border-color .18s ease, color .18s ease;
}
/* 模型切换结果写进 composer 工具条（就地、不遮挡输入框），8s 后自动隐去 */
.model-status { display: none; color: var(--tx3); font-size: 11px; max-width: 46vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-status.on { display: inline-block; }
.model-status.ok { color: #6ee7b7; }
.chat-input.ok-flash { animation: composerOkFlash 1s ease; }
@keyframes composerOkFlash {
  0% { box-shadow: inset 0 0 0 1px rgba(52,211,153,0), inset 0 0 0 rgba(52,211,153,0); }
  22% { box-shadow: inset 0 0 0 1px rgba(52,211,153,.7), inset 0 0 24px rgba(52,211,153,.16); }
  100% { box-shadow: inset 0 0 0 1px rgba(52,211,153,0), inset 0 0 0 rgba(52,211,153,0); }
}
.composer-hint {
  position: absolute; bottom: 100%; left: 50%; margin-bottom: 12px; z-index: 46;
  display: flex; align-items: center; gap: 6px; max-width: min(78%, 560px);
  padding: 6px 12px; border-radius: 999px;
  background: rgba(15,23,42,.96); border: 1px solid var(--line2);
  color: var(--tx2); font-size: 12px; line-height: 1.4;
  box-shadow: 0 6px 20px rgba(0,0,0,.42);
  pointer-events: none; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  opacity: 0; transform: translate(-50%, 6px);
  transition: opacity .18s ease, transform .18s ease, border-color .18s ease, color .18s ease;
}
.composer-hint.on { opacity: 1; transform: translate(-50%, 0); }
.composer-hint.ok { border-color: rgba(52,211,153,.45); color: #a7f3d0; }
.composer-hint.err { border-color: var(--err); color: #fecaca; }
.model-pop {
  position: absolute; bottom: calc(100% + 10px); right: 0; z-index: 70;
  width: 420px; max-width: calc(100vw - 20px); max-height: 54vh; overflow-y: auto; -webkit-overflow-scrolling: touch;
  background: var(--bg2); border: 1px solid var(--line2); border-radius: 12px;
  box-shadow: 0 14px 44px rgba(0,0,0,.6); padding: 6px; display: none;
}
.model-pop.on { display: block; }
.model-pop-head {
  display: flex; justify-content: space-between; align-items: center; gap: 10px;
  padding: 8px 10px 6px; font-size: 11px; color: var(--tx3);
  border-bottom: 1px solid var(--line); margin-bottom: 4px;
}
.model-group {
  padding: 8px 10px 3px; font-size: 10.5px; font-weight: 700; color: var(--pri);
  text-transform: uppercase; letter-spacing: .05em;
}
.model-item {
  display: flex; align-items: center; gap: 8px; padding: 10px; border-radius: 8px;
  cursor: pointer; font-size: 12.5px; color: var(--tx);
}
.model-item:hover { background: var(--bg-hover); }
.model-item.on { color: var(--pri); background: var(--pri-light); }
.model-item .n { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-item .ck { flex: none; visibility: hidden; font-weight: 700; }
.model-item.on .ck { visibility: visible; }
.model-empty { padding: 14px; color: var(--tx3); font-size: 12px; text-align: center; }

/* 任务实时统计条（轮/步 · LLM/工具耗时 · 首 token/吞吐 · 缓存命中 · token 账本），对齐 DSH web StatsLine */
.task-stats {
  flex: none; padding: 4px 18px 7px; font-size: 11px; color: var(--tx3); line-height: 1.5;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; text-align: center;
  user-select: none; border-top: 1px solid var(--line);
}

/* ---- 任务清单坞（对齐 DSH web TodoPanel：任务 + N 进行中 · M 待处理 + 运行时长） ---- */
.todo-dock {
  flex: none; margin: 0 14px 6px; border: 1px solid var(--line); border-radius: var(--rad);
  background: var(--bg2); overflow: hidden;
}
.todo-head {
  width: 100%; display: flex; align-items: center; gap: 8px; padding: 7px 10px;
  background: transparent; color: var(--tx2); font-size: 12.5px; text-align: left;
}
.todo-head:hover { background: var(--bg-hover); }
.todo-lead { display: inline-flex; align-items: center; color: var(--pri); flex: none; }
.todo-title { color: var(--tx); font-weight: 600; flex: none; }
.todo-progress { color: var(--tx3); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.todo-elapsed { color: var(--tx3); font-size: 11.5px; flex: none; font-variant-numeric: tabular-nums; }
.todo-elapsed.run { color: var(--pri); }
.todo-chev { flex: none; color: var(--tx3); font-size: 10.5px; }
.todo-list { list-style: none; max-height: 170px; overflow-y: auto; padding: 2px 0 6px; border-top: 1px solid var(--line); }
.todo-item { display: flex; gap: 8px; align-items: flex-start; padding: 4px 12px; font-size: 12.5px; line-height: 1.5; color: var(--tx2); }
.todo-item .g { flex: none; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; margin-top: 1px; }
.todo-item .c { flex: 1; min-width: 0; word-break: break-word; }
.todo-item[data-status="in_progress"] .c { color: var(--tx); }
.todo-item[data-status="completed"] .c { color: var(--tx3); }
.todo-item[data-status="completed"] .g { color: var(--ok); }
.todo-item[data-status="in_progress"] .g { color: var(--pri); }
/* 会话已结束但条目仍停留在进行中：琥珀静态环，不转（区别于运行中的蓝色转圈） */
.todo-item[data-status="unfinished"] .g { color: var(--warn); }
.todo-item[data-status="unfinished"] .c { color: var(--tx2); }
.todo-item[data-status="pending"] .g { color: var(--tx3); }
.todo-spin { animation: todo-spin 1.1s linear infinite; transform-origin: 7px 7px; }
@keyframes todo-spin { to { transform: rotate(360deg); } }
.todo-empty { padding: 5px 12px 8px; font-size: 11.5px; color: var(--tx3); border-top: 1px solid var(--line); }

/* 附件上传面板 */
#upload-panel {
  position: fixed; right: 18px; bottom: 90px; z-index: 9000; width: 360px; max-width: calc(100vw - 36px);
  background: var(--bg2); border: 1px solid var(--line2); border-radius: 10px;
  box-shadow: 0 8px 30px rgba(0,0,0,.5); padding: 12px 14px; display: none;
}
.up-head { display: flex; align-items: center; gap: 8px; font-size: 12.5px; margin-bottom: 8px; }
.up-count { color: var(--tx3); font-size: 11.5px; }
.up-rows { display: flex; flex-direction: column; gap: 8px; max-height: 240px; overflow-y: auto; }
.up-row { font-size: 11.5px; }
.up-line { display: flex; gap: 8px; align-items: baseline; }
.up-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--tx); }
.up-size { color: var(--tx3); flex: none; font-size: 10.5px; }
.up-bar { height: 4px; border-radius: 2px; background: rgba(148,163,184,.18); overflow: hidden; margin: 4px 0 3px; }
.up-bar-in { height: 100%; width: 0%; background: var(--pri); border-radius: 2px; transition: width .15s ease; }
.up-row.done .up-bar-in { background: var(--ok); }
.up-row.error .up-bar-in { background: var(--err); }
.up-status { color: var(--tx3); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.up-row.done .up-status { color: var(--ok); }
/* 输入框拖放文件高亮 + 提示浮层 */
.chat-input-container.drop-hover .chat-input { outline: 2px dashed var(--pri); outline-offset: -4px; border-radius: var(--rad-sm); }
.chat-input-container.drop-hover::after {
  content: '松开以上传附件（自动上传并填入文件路径）';
  position: absolute; inset: 0; z-index: 40; display: flex; align-items: center; justify-content: center;
  background: rgba(2, 132, 199, .12); color: var(--pri); font-size: 13px; font-weight: 600; pointer-events: none;
  border-radius: var(--rad-sm);
}
.up-row.error .up-status { color: var(--err); }
.up-bar.indet .up-bar-in {
  width: 100% !important;
  background: repeating-linear-gradient(90deg, var(--pri) 0 8px, rgba(99,140,255,.35) 8px 16px);
  background-size: 32px 100%; animation: up-indet .7s linear infinite; opacity: .85;
}
@keyframes up-indet { from { background-position: 0 0; } to { background-position: 32px 0; } }

/* 通用面板与组件 */
.panel { flex: 1; overflow-y: auto; padding: 20px 28px; }
.panel-head { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
.panel-head h2 { font-size: 17px; }
.panel-head .sub { color: var(--tx3); font-size: 12.5px; }
.btn { background: var(--bg3); border: 1px solid var(--line2); color: var(--tx2); border-radius: var(--rad-sm); padding: 7px 14px; font-size: 13px; }
.btn:hover { color: var(--pri); border-color: var(--pri); }
.btn.pri { background: var(--pri-d); border-color: var(--pri-d); color: #fff; font-weight: 600; }
.btn.danger:hover { color: var(--err); border-color: var(--err); }
.card { background: var(--bg2); border: 1px solid var(--line); border-radius: var(--rad); padding: 14px 16px; margin-bottom: 12px; }
.card .row1 { display: flex; align-items: center; gap: 10px; }
.card h3 { font-size: 14.5px; flex: 1; }
.tag { font-size: 11px; color: var(--tx2); background: var(--bg3); border: 1px solid var(--line2); padding: 2px 8px; border-radius: 999px; }
.tag.ok { color: var(--ok); border-color: rgba(52,211,153,.4); }
.tag.err { color: var(--err); border-color: rgba(248,113,113,.4); }
.tag.dsh { color: var(--pri); border-color: rgba(56,189,248,.4); }
.tag.ssh { color: var(--warn); border-color: rgba(251,191,36,.4); }
.card .desc { color: var(--tx2); font-size: 12.5px; margin-top: 6px; line-height: 1.6; }
.card .ops { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.mono { font-family: var(--mono); font-size: 12px; color: var(--tx2); }
.tbl-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
table.res { width: 100%; border-collapse: collapse; font-size: 13px; }
table.res th { text-align: left; color: var(--tx3); font-weight: 500; font-size: 12px; padding: 8px 10px; border-bottom: 1px solid var(--line); }
table.res td { padding: 9px 10px; border-bottom: 1px solid var(--bg3); }
tr.tunnel-row td { background: var(--bg3); color: var(--acc); font-weight: 600; font-size: 12.5px; }
.dot2 { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
.dot2.ok { background: var(--ok); } .dot2.err { background: var(--err); }

/* 抽屉与弹窗 */
.drawer-mask { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 40; display: none; }
.drawer-mask.on { display: block; }
.drawer {
  position: fixed; top: 0; right: -580px; width: 580px; max-width: 94vw; height: 100vh;
  background: var(--bg2); border-left: 1px solid var(--line); z-index: 41; transition: right .22s ease;
  display: flex; flex-direction: column;
}
.drawer.on { right: 0; }
.drawer-head { height: 52px; flex: none; display: flex; align-items: center; gap: 10px; padding: 0 18px; border-bottom: 1px solid var(--line); }
.drawer-head b { flex: 1; font-size: 14.5px; }
.drawer-body { flex: 1; overflow-y: auto; padding: 16px 18px; }
.field { margin-bottom: 13px; }
.field label { display: block; font-size: 12px; color: var(--tx2); margin-bottom: 5px; }
.field .hint { font-size: 11.5px; color: var(--tx3); margin-top: 4px; line-height: 1.5; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.grid3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
.bind-row { border: 1px solid var(--line); border-radius: 8px; padding: 10px; margin-bottom: 8px; background: var(--bg); }
.modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.55); z-index: 50; display: none; align-items: center; justify-content: center; }
.modal-mask.on { display: flex; }
.modal { width: 620px; max-width: 94vw; max-height: 86vh; background: var(--bg2); border: 1px solid var(--line2); border-radius: 14px; display: flex; flex-direction: column; overflow: hidden; }
.modal-head { padding: 14px 20px; border-bottom: 1px solid var(--line); display: flex; align-items: center; }
.modal-head b { flex: 1; font-size: 15px; }
.modal-body { padding: 18px 20px; overflow-y: auto; }
.modal-foot { padding: 12px 20px; border-top: 1px solid var(--line); display: flex; gap: 10px; justify-content: flex-end; }
.pre-block { background: #0d1526; border: 1px solid var(--line); border-radius: 8px; padding: 12px; font-size: 12px; white-space: pre-wrap; word-break: break-all; max-height: 420px; overflow-y: auto; color: #c7d4ee; font-family: var(--mono); }
.agent-check { display: flex; align-items: center; gap: 10px; border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px; cursor: pointer; }
.agent-check:hover { border-color: var(--line2); }
.agent-check.on { border-color: var(--pri); background: rgba(56,189,248,.08); }
.agent-check input { width: auto; }
.agent-check .n { font-weight: 600; font-size: 13.5px; }
.agent-check .d { color: var(--tx3); font-size: 12px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toast { position: fixed; bottom: 22px; left: 50%; transform: translateX(-50%); background: var(--bg3); border: 1px solid var(--line2); color: var(--tx); padding: 9px 18px; border-radius: 8px; z-index: 99; display: none; font-size: 13px; max-width: 70vw; box-shadow: 0 4px 20px rgba(0,0,0,.5); }
.toast.err { border-color: var(--err); color: #fecaca; }
.log-line { font-family: var(--mono); font-size: 12px; padding: 3px 0; border-bottom: 1px dashed var(--bg3); color: var(--tx2); }
.log-line .lv { display: inline-block; width: 44px; color: var(--tx3); }
.log-line.error .lv { color: var(--err); } .log-line.warn .lv { color: var(--warn); } .log-line.tool .lv { color: var(--acc); }
.settings-note { color: var(--tx3); font-size: 12px; line-height: 1.7; margin-top: 8px; }

/* 目录选择器 */
.db-top { display: flex; gap: 8px; margin-bottom: 10px; align-items: center; }
.db-list { max-height: 46vh; overflow-y: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--bg2); }
.db-row { display: flex; align-items: center; gap: 8px; padding: 9px 12px; cursor: pointer; border-bottom: 1px solid rgba(148,163,184,.08); font-size: 12.5px; }
.db-row:last-child { border-bottom: none; }
.db-row:hover { background: rgba(99,140,255,.10); }
.db-row .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.db-row .chev { color: var(--tx3); }
.db-row.up { color: var(--tx2); }

/* @ 提及自动联想浮层 (Mentions Popup) */
.chat-input-container { position: relative; }
/* 回到底部悬浮按钮：锚定输入区上缘，长对话/手机端快速跳底部 */
.jump-bottom {
  position: absolute; bottom: 100%; right: 16px; margin-bottom: 10px; z-index: 12;
  display: none; align-items: center; gap: 4px;
  background: var(--bg3); border: 1px solid var(--line2); color: var(--tx2);
  font-size: 12px; padding: 8px 13px; border-radius: 999px;
  box-shadow: 0 4px 16px rgba(0,0,0,.5);
}
.jump-bottom.on { display: inline-flex; }
.jump-bottom:hover { color: var(--pri); border-color: var(--pri); }
.mention-popup {
  position: absolute; bottom: 100%; left: 16px; width: 340px; max-height: 280px;
  background: var(--bg2); border: 1px solid var(--line2); border-radius: 10px;
  box-shadow: 0 8px 30px rgba(0,0,0,.65); z-index: 35; display: none; flex-direction: column;
  overflow: hidden; margin-bottom: 8px;
}
.mention-popup.on { display: flex; }
/* 抽屉等容器内向下弹出的变体 */
.mention-popup.below { bottom: auto; top: 100%; margin-bottom: 0; margin-top: 8px; }
.mention-popup-head {
  padding: 8px 12px; background: var(--bg3); border-bottom: 1px solid var(--line);
  font-size: 11px; font-weight: 600; color: var(--tx3); display: flex; justify-content: space-between;
}
.mention-popup-list { overflow-y: auto; flex: 1; }
.mention-item {
  padding: 8px 12px; display: flex; align-items: center; gap: 10px; cursor: pointer;
  border-bottom: 1px solid rgba(148,163,184,.06); font-size: 13px; transition: background .12s ease;
}
.mention-item:last-child { border-bottom: none; }
.mention-item.active, .mention-item:hover { background: rgba(56,189,248,.12); }
.mention-item .icon { font-size: 14px; flex: none; }
.mention-item .info { flex: 1; min-width: 0; }
.mention-item .name { font-weight: 600; color: var(--tx); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mention-item .desc { font-size: 11px; color: var(--tx3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }
.mention-item .tag {
  font-size: 10px; padding: 1px 5px; border-radius: 4px; font-family: var(--mono); border: 1px solid var(--line);
}
.mention-item .tag.agent { color: var(--pri); border-color: rgba(56,189,248,.4); }
.mention-item .tag.resource { color: var(--warn); border-color: rgba(251,191,36,.4); }
.mention-empty { padding: 16px; text-align: center; color: var(--tx3); font-size: 12px; }
.db-row.is-hidden { opacity: .55; }
.db-empty { padding: 18px; text-align: center; color: var(--tx3); font-size: 12px; line-height: 1.7; }
.db-note { font-size: 11.5px; color: var(--tx3); margin-top: 6px; min-height: 15px; word-break: break-all; }
.db-bar { display: flex; gap: 8px; margin-top: 10px; align-items: center; }
.db-bar .on { color: #60a5fa; }
.db-create { display: flex; gap: 8px; align-items: center; padding: 8px 12px; background: rgba(99,140,255,.08); border-bottom: 1px solid rgba(148,163,184,.08); font-size: 12px; }
.db-create input { flex: 1; }

/* 移动端侧栏切换按钮（默认桌面隐藏） */
.side-toggle {
  display: none; background: transparent; border: 1px solid var(--line2); color: var(--tx2);
  border-radius: var(--rad-sm); padding: 3px 8px; font-size: 14px; line-height: 1; flex: none;
}
.side-toggle:hover { color: var(--pri); border-color: var(--pri); }
.side-backdrop { display: none; }

/* ============================================================
   移动端响应式适配 (≤768px)
   主导航下沉为底部 Tab 栏 · 侧栏变抽屉 · 聊天头部两行自适应 ·
   输入区 16px 防 iOS 聚焦缩放 · 弹窗/抽屉全屏 · 表格容器横向滚动 ·
   dvh 动态视口（微信/移动浏览器地址栏收展不裁切）· 触摸目标 ≥32px
   ============================================================ */
@media (max-width: 768px) {
  /* ---- 视口与输入基础 ---- */
  #app { height: 100vh; height: 100dvh; }
  input, textarea, select { font-size: 16px; } /* ≥16px 防止 iOS 聚焦自动放大 */
  textarea { min-height: 42px; }

  /* ---- 顶部：品牌压缩 + ONENAT 状态胶囊退化为状态点 ---- */
  header { padding: 0 10px; gap: 8px; height: 46px; }
  .brand { gap: 6px; min-width: 0; flex: 1; }
  .brand .logo { width: 24px; height: 24px; font-size: 12px; flex: none; }
  .brand span { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .brand small { display: none; }
  .chip { display: inline-flex; padding: 5px 7px; gap: 4px; flex: none; }
  .chip #onenat-text { display: none; }
  .chip #version-text { font-family: var(--mono); font-size: 11px; white-space: nowrap; }

  /* ---- 主导航下沉为底部 Tab 栏（移动端标准导航模式） ---- */
  nav {
    position: fixed; left: 0; right: 0; bottom: 0; z-index: 46;
    display: flex; align-items: stretch; max-width: none; overflow: visible; gap: 0;
    background: var(--bg2); border-top: 1px solid var(--line);
    padding-bottom: env(safe-area-inset-bottom);
    box-shadow: 0 -6px 20px rgba(0,0,0,.4);
  }
  nav::-webkit-scrollbar { display: none; }
  nav button {
    flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 2px; margin: 4px 3px 2px; padding: 5px 2px; min-height: 46px;
    font-size: 10.5px !important; border-radius: 10px;
  }
  nav button .ic { font-size: 17px; }
  main { padding-bottom: calc(62px + env(safe-area-inset-bottom)); }
  /* 软键盘弹出（body.kb-open）时隐藏底部 Tab 栏，空间让给消息区 */
  body.kb-open nav { display: none; }
  body.kb-open main { padding-bottom: 0; }

  /* ---- 工作台：侧栏变抽屉 ---- */
  #view-work { position: relative; }
  .task-side {
    position: absolute; top: 0; left: 0; bottom: 0; z-index: 20;
    width: 82vw; max-width: 330px; border-right: 1px solid var(--line2);
    transform: translateX(-100%); transition: transform .22s ease;
    box-shadow: 6px 0 24px rgba(0,0,0,.55);
  }
  #view-work.side-open .task-side { transform: translateX(0); }
  .side-backdrop {
    display: block; position: absolute; inset: 0; background: rgba(0,0,0,.55);
    z-index: 15; opacity: 0; pointer-events: none; transition: opacity .18s ease;
  }
  #view-work.side-open .side-backdrop { opacity: 1; pointer-events: auto; }
  .side-toggle { display: inline-flex; align-items: center; min-height: 32px; padding: 4px 10px; }
  .side-toggle .st-hamb { font-size: 16px; }
  .btn-new { padding: 8px 12px; font-size: 12.5px; }

  /* ---- 聊天头部：单行紧凑（☰ + 标题 + ✏️ + 模式徽章；停止在输入框旁，归档/删除在会话抽屉里） ---- */
  .chat-head { flex-wrap: wrap; height: auto; min-height: 44px; padding: 6px 10px; row-gap: 4px; column-gap: 8px; align-items: center; justify-content: flex-start; }
  .side-toggle { order: -1; }
  .chat-head .title { flex: 1 1 auto; min-width: 0; max-width: none; font-size: 13.5px; }
  .chat-head .hspacer { display: none; }
  .chat-head .mini-btn { min-height: 30px; padding: 5px 9px; font-size: 12px; white-space: nowrap; flex: none; }
  .chat-head .badge { display: inline-flex; }
  .chat-head .badge.mode { flex: 0 1 auto; min-width: 0; max-width: 36vw; }
  .badge { display: inline-flex; align-items: center; min-height: 26px; font-size: 10.5px; padding: 3px 9px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; box-sizing: border-box; }
  .main-agent-btn { max-width: 48vw; font-size: 11.5px; padding: 3px 8px; min-height: 28px; }
  .main-agent-pop { position: fixed; left: 10px; right: 10px; top: 52px; width: auto; max-width: none; max-height: 56vh; }

  /* ---- 消息区 ---- */
  .chat-scroll { padding: 12px 12px 32px; }
  .msg { gap: 8px; margin-bottom: 16px; }
  .msg .avatar { width: 28px; height: 28px; font-size: 12px; border-radius: 7px; }
  .msg.agent .bubble, .msg.system .bubble { padding-left: 10px; }
  .msg.user .content { padding: 8px 11px; }
  .msg .content { font-size: 13px; }
  .msg .meta { flex-wrap: wrap; row-gap: 2px; }
  .markdown h1 { font-size: 15px; }
  .markdown h2 { font-size: 14px; }
  .markdown h3 { font-size: 13.5px; }
  .md-code-block pre { font-size: 11.5px; }
  .md-code-copy { padding: 5px 10px; font-size: 11px; }
  .hist-more-btn { padding: 9px 16px; }
  .tw-row { padding: 6px 8px; }
  .rz-head { padding: 9px 10px; }

  /* ---- 输入区：输入行 + 紧凑工具条（横向滚动，模型下拉不再全宽堆叠） ---- */
  .chat-input { padding: 8px 10px 6px; gap: 8px; }
  .chat-input textarea { font-size: 16px; min-height: 40px; max-height: 132px; }
  .btn-send { padding: 8px 14px; font-size: 13.5px; min-height: 40px; }
  .btn-stop { padding: 8px 12px; font-size: 13px; min-height: 40px; }
  .composer-bar { padding: 5px 10px 7px; gap: 6px; flex-wrap: nowrap; overflow-x: auto; -webkit-overflow-scrolling: touch; scrollbar-width: none; }
  .composer-bar::-webkit-scrollbar { display: none; }
  .composer-bar .hspacer { display: none; }
  .composer-bar .member-chips { flex: none; flex-wrap: nowrap; }
  .cfg-sel { width: auto !important; min-width: 170px; max-width: 62vw; flex: 0 0 auto; font-size: 16px !important; padding: 6px 8px !important; min-height: 34px; }
  .model-btn { max-width: 62vw; }
  .model-pop { position: fixed; left: 10px; right: 10px; bottom: calc(64px + env(safe-area-inset-bottom)); width: auto; max-width: none; max-height: 58vh; }
  .jump-bottom { right: 12px; padding: 8px 11px; font-size: 12px; }
  .jump-bottom .jb-t { display: none; }
  .task-stats { padding: 4px 10px 5px; font-size: 10.5px; }
  .todo-dock { margin: 0 8px 6px; }
  .todo-list { max-height: 132px; }
  .todo-elapsed { font-size: 11px; }

  /* ---- 提及浮层 ---- */
  .mention-popup { width: calc(100vw - 24px); left: 12px; }
  .mention-item { padding: 11px 12px; }

  /* ---- 计划卡片 ---- */
  .plan-card { padding: 10px 12px; }
  .plan-row { flex-wrap: wrap; gap: 6px; }
  .plan-row .st { width: 58px; }
  .plan-row .ag { width: 100%; order: 3; }
  .plan-row .ops { margin-left: auto; }
  .plan-row .ops .mini-btn { min-height: 30px; padding: 5px 10px; }

  /* ---- 通用面板 ---- */
  .panel { padding: 14px 12px; }
  .panel-head { flex-wrap: wrap; gap: 8px; }
  .panel-head h2 { font-size: 15px; }
  .panel-head .sub { width: 100%; font-size: 12px; }
  .panel-head .btn { min-height: 34px; }
  .grid2, .grid3 { grid-template-columns: 1fr; }

  /* ---- 卡片: 标签与操作按钮换行，避免溢出 ---- */
  .card { padding: 12px; }
  .card .row1 { flex-wrap: wrap; gap: 6px; }
  .card .row1 h3 { font-size: 15px; }
  .card .ops { flex-wrap: wrap; gap: 7px; }
  .card .ops .btn { font-size: 12.5px; padding: 8px 11px; min-height: 34px; }
  .card .desc { word-break: break-word; }
  .card .desc .mono { word-break: break-all; }
  .bind-row, .agent-check { padding: 10px; }

  /* ---- 资源目录表：容器横向滚动（不依赖 :has()，兼容旧内核） ---- */
  table.res { min-width: 640px; }
  table.res th, table.res td { white-space: nowrap; padding: 9px 10px; }
  table.res .dot2 { margin-left: 6px; margin-right: 0; }
  .md-table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .md-table { width: auto; font-size: 12px; }
  .md-table th, .md-table td { white-space: nowrap; padding: 6px 9px; }

  /* ---- 弹窗 / 抽屉 ---- */
  .modal-mask { padding: 12px; }
  .modal { width: 100%; max-width: 100%; max-height: calc(100dvh - 24px); }
  .modal-foot { flex-wrap: wrap; }
  .modal-foot .btn { min-height: 38px; }
  .drawer { width: 100vw; max-width: 100vw; height: 100vh; height: 100dvh; }
  .drawer-head { padding: 0 14px; height: 48px; }
  .drawer-body { padding: 12px 14px; }
  .db-row { padding: 11px 12px; }
  #upload-panel { right: 10px; bottom: calc(66px + env(safe-area-inset-bottom)); width: calc(100vw - 20px); max-width: 100%; }
  .pre-block { max-height: 60vh; }

  /* ---- Toast / 问答卡片（避开底部 Tab 栏） ---- */
  .toast { bottom: calc(62px + env(safe-area-inset-bottom)); max-width: 90vw; font-size: 12.5px; }
  .composer-hint { max-width: calc(100vw - 24px); font-size: 11.5px; margin-bottom: 8px; }
  .ask-opt { padding: 12px 14px; }
  .ask-btn-submit { min-height: 40px; }
}

/* 触屏设备无 hover：会话条目操作按钮常显（改为条目内第三行，右对齐），并整体紧凑化 */
@media (max-width: 768px) and (hover: none) {
  .task-item { padding: 7px 9px; gap: 2px; }
  .task-item .t { font-size: 12px; }
  .task-item .row-sub { font-size: 10.5px; padding-left: 13px; }
  .task-item .acts {
    display: flex; position: static; margin: 1px 0 0; justify-content: flex-end;
    background: transparent; box-shadow: none; padding: 0; gap: 2px;
  }
  .task-item .acts button { font-size: 13px; padding: 2px 7px; }
}
/* ---- 定时任务详情（页签式，对齐 KB 任务详情页） ---- */
.sched-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin-bottom: 12px; }
.sched-tab { background: transparent; color: var(--tx2); padding: 8px 14px; font-size: 13px; border-bottom: 2px solid transparent; border-radius: 0; }
.sched-tab:hover { color: var(--tx); }
.sched-tab.on { color: var(--pri); border-bottom-color: var(--pri); font-weight: 600; }
.sched-grid { display: grid; grid-template-columns: 110px 1fr; gap: 8px 12px; font-size: 13px; }
.sched-grid .k { color: var(--tx3); }
.sched-agent { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: var(--bg); border: 1px solid var(--line); border-radius: var(--rad-sm); cursor: pointer; }
.sched-agent:hover { border-color: var(--line2); }
.sched-tpl { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; cursor: pointer; transition: border-color .15s; }
.sched-tpl:hover { border-color: var(--pri); }
.run-card { background: var(--bg2); border: 1px solid var(--line); border-radius: var(--rad-sm); padding: 10px 12px; margin-bottom: 10px; }
.run-item { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 12.5px; flex-wrap: wrap; }
.run-item .mini-btn { margin-left: auto; }

/* ---- 远程工作空间文件管理 ---- */
.files-panel { display: flex; flex-direction: column; height: 100%; max-width: 100% !important; padding: 0 !important; }
.files-head { padding: 12px 18px 8px; border-bottom: 1px solid var(--line); }
.files-crumb-bar {
  display: flex; align-items: center; gap: 2px; padding: 6px 18px; background: rgba(15,23,42,.6);
  border-bottom: 1px solid var(--line); font-size: 13px; overflow-x: auto; white-space: nowrap; flex: none;
}
.files-crumb {
  display: inline-flex; align-items: center; gap: 4px; color: var(--tx2); cursor: pointer; padding: 3px 7px;
  border-radius: var(--rad-sm); transition: all .15s; font-size: 12.5px;
}
.files-crumb:hover { color: var(--pri); background: var(--bg3); }
.files-crumb.active { color: var(--tx); font-weight: 600; cursor: default; }
.files-crumb-sep { color: var(--tx3); font-size: 11px; padding: 0 2px; }

.files-action-bar {
  display: flex; align-items: center; gap: 10px; padding: 10px 18px; border-bottom: 1px solid var(--line);
  background: var(--bg2); flex-wrap: wrap; flex: none;
}
.files-search-box {
  display: flex; align-items: center; gap: 6px; background: var(--bg); border: 1px solid var(--line);
  border-radius: var(--rad-sm); padding: 5px 10px; width: 220px;
}
.files-search-box input {
  border: none; background: transparent; padding: 0; font-size: 12.5px; width: 100%; color: var(--tx);
}
.files-body-wrap {
  flex: 1; display: flex; flex-direction: column; overflow: hidden; position: relative; background: var(--bg); min-height: 200px;
}
.files-body-wrap.drop-hover {
  outline: 2px dashed var(--pri); outline-offset: -4px; background: rgba(56,189,248,.04);
}
.files-table-wrap {
  flex: 1; overflow-y: auto; overflow-x: auto;
}
.files-table {
  width: 100%; border-collapse: collapse; font-size: 13px; text-align: left;
}
.files-table th {
  position: sticky; top: 0; background: var(--bg2); z-index: 5; padding: 9px 16px;
  border-bottom: 1px solid var(--line); color: var(--tx3); font-weight: 600; font-size: 12px;
}
.files-row {
  border-bottom: 1px solid rgba(32,46,72,.3); transition: background .12s;
}
.files-row:hover { background: var(--bg-hover); }
.files-cell {
  padding: 8px 16px; vertical-align: middle; color: var(--tx2);
}
.files-cell-name {
  color: var(--tx); font-weight: 500; display: flex; align-items: center; gap: 8px; cursor: pointer;
}
.files-cell-name:hover { color: var(--pri); }
.files-icon { font-size: 16px; flex: none; width: 20px; text-align: center; }
.files-actions {
  display: flex; align-items: center; justify-content: flex-end; gap: 6px;
}
.btn-at-file {
  background: rgba(56,189,248,.12); color: var(--pri); border: 1px solid rgba(56,189,248,.35);
  border-radius: 999px; padding: 3px 10px; font-size: 11.5px; font-weight: 600; display: inline-flex;
  align-items: center; gap: 3px; cursor: pointer; transition: all .15s;
}
.btn-at-file:hover {
  background: var(--pri); color: #090e17; border-color: var(--pri); box-shadow: 0 0 10px rgba(56,189,248,.4);
}
.files-footer {
  padding: 6px 18px; background: var(--bg2); border-top: 1px solid var(--line); display: flex;
  align-items: center; font-size: 12px; color: var(--tx3); flex: none;
}
.files-empty-box {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 48px 16px; color: var(--tx3); gap: 10px;
}
/* ---- 批量操作：行选择复选框 + 批量操作条 ---- */
.files-cell-check { width: 34px; padding: 8px 6px 8px 14px; text-align: center; }
.files-check {
  width: 15px; height: 15px; margin: 0; cursor: pointer; accent-color: var(--pri);
  vertical-align: middle; opacity: 0; transition: opacity .12s ease;
}
.files-row:hover .files-check, .files-check:checked, .files-check:focus { opacity: 1; }
.files-row.selected { background: var(--pri-light); }
.files-row.selected .files-cell-name { color: var(--pri); }
.files-check-all { width: 15px; height: 15px; margin: 0; cursor: pointer; accent-color: var(--pri); vertical-align: middle; }
.batch-bar {
  display: none; align-items: center; gap: 8px; padding: 8px 18px;
  background: var(--pri-light); border-bottom: 1px solid rgba(56,189,248,.3); flex: none;
  font-size: 12.5px;
}
.batch-bar.on { display: flex; }
.batch-bar .batch-count { color: var(--pri); font-weight: 600; white-space: nowrap; }
.batch-bar .btn { font-size: 12px; padding: 5px 11px; min-height: 30px; white-space: nowrap; }
.batch-bar .btn.danger-batch:hover { color: var(--err); border-color: var(--err); }
.code-preview-box {
  background: rgba(2,6,23,.7); border: 1px solid var(--line); border-radius: 8px;
  padding: 12px 14px; font-family: var(--mono); font-size: 12px; line-height: 1.55;
  color: var(--tx); overflow: auto; max-height: 520px; white-space: pre-wrap; word-break: break-all;
}
/* ---------- 监控大屏 ---------- */
.mon-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
.mon-status { color: var(--tx3); font-size: 12px; }
.mon-kpis { display: grid; grid-template-columns: repeat(7, 1fr); gap: 8px; margin-bottom: 12px; }
.mon-kpi { background: var(--bg2); border: 1px solid var(--line); border-radius: var(--rad); padding: 9px 12px; min-width: 0; }
.mon-kpi .lb { color: var(--tx3); font-size: 11.5px; white-space: nowrap; }
.mon-kpi .v { font-size: 19px; font-weight: 700; margin-top: 2px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mon-kpi .d { color: var(--tx3); font-size: 10.5px; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mon-kpi .v.ok { color: var(--ok); } .mon-kpi .v.err { color: var(--err); }
.mon-kpi .v.pri { color: var(--pri); } .mon-kpi .v.warn { color: var(--warn); }
.mon-alerts { display: none; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.mon-alerts.on { display: flex; }
.mon-alert { font-size: 12px; border: 1px solid rgba(248,113,113,.4); background: var(--err-light); color: #fca5a5; border-radius: 8px; padding: 4px 10px; }
.mon-alert.warn { border-color: rgba(251,191,36,.4); background: var(--warn-light); color: #fcd34d; }
.mon-grid { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 5fr) minmax(0, 4fr); gap: 12px; align-items: start; }
.mon-col { min-width: 0; }
.mon-sec-title { font-size: 12.5px; color: var(--tx2); font-weight: 600; margin: 4px 0 8px; display: flex; align-items: center; gap: 6px; }
.mon-sec-title .cnt { color: var(--pri); font-weight: 500; font-size: 11.5px; }
.mon-sec-title .spacer { flex: 1; }
.mon-list { display: flex; flex-direction: column; gap: 7px; max-height: 44vh; overflow: auto; padding-right: 2px; }
.mon-agent, .mon-task { border: 1px solid var(--line); border-radius: var(--rad); background: var(--bg2); padding: 8px 11px; cursor: pointer; transition: border-color .15s; min-width: 0; }
.mon-agent:hover, .mon-task:hover { border-color: var(--line2); }
.mon-row1 { display: flex; align-items: center; gap: 7px; min-width: 0; }
.mon-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--tx3); flex: none; }
.mon-dot.on { background: var(--ok); box-shadow: 0 0 6px var(--ok); }
.mon-dot.off { background: var(--err); box-shadow: 0 0 6px var(--err); }
.mon-nm { font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mon-md { color: var(--tx3); font-size: 11px; white-space: nowrap; }
.mon-spacer { flex: 1; }
.mon-badge { font-size: 10.5px; border-radius: 999px; padding: 1px 8px; border: 1px solid var(--line); color: var(--tx3); white-space: nowrap; flex: none; }
.mon-badge.busy { color: var(--pri); border-color: rgba(56,189,248,.45); }
.mon-badge.run { color: var(--pri); border-color: rgba(56,189,248,.45); }
.mon-badge.ok { color: var(--ok); border-color: rgba(52,211,153,.4); }
.mon-badge.bad { color: var(--err); border-color: rgba(248,113,113,.4); }
.mon-badge.warn { color: var(--warn); border-color: rgba(251,191,36,.4); }
.mon-act { margin-top: 4px; font-size: 12px; color: var(--tx2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mon-act b { color: var(--tx); font-weight: 600; }
.mon-err-line { margin-top: 4px; font-size: 12px; color: var(--err); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mon-res { margin-top: 5px; display: flex; flex-wrap: wrap; gap: 4px; }
.mon-res-chip { font-size: 10.5px; border: 1px solid var(--line); border-radius: 6px; padding: 1px 7px; color: var(--tx3); }
.mon-res-chip.on { color: var(--tx2); }
.mon-res-chip.hot { color: var(--warn); border-color: rgba(251,191,36,.5); background: var(--warn-light); }
.mon-res-chip.off { color: var(--err); border-color: rgba(248,113,113,.35); }
.mon-hl { margin-top: 3px; font-size: 12px; color: var(--tx2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mon-hl.run { color: var(--pri); }
.mon-hl.ok { color: var(--ok); }
.mon-hl.bad { color: var(--err); }
.mon-hl.stop { color: var(--warn); }
.mon-desc { margin-top: 2px; font-size: 11px; color: var(--tx3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mon-bar { margin-top: 5px; height: 3px; border-radius: 3px; background: var(--line); overflow: hidden; }
.mon-bar i { display: block; height: 100%; background: linear-gradient(90deg, var(--pri), var(--ok)); transition: width .5s; }
.mon-feed { display: flex; flex-direction: column; max-height: 60vh; overflow: auto; }
.mon-ev { display: flex; gap: 7px; padding: 4px 2px; border-bottom: 1px dashed var(--line); font-size: 12px; line-height: 1.45; }
.mon-ev:last-child { border-bottom: none; }
.mon-ev .t { color: var(--tx3); font-size: 11px; font-variant-numeric: tabular-nums; flex: none; padding-top: 1px; }
.mon-ev .m { color: var(--tx2); min-width: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.mon-ev:hover .m { -webkit-line-clamp: unset; }

/* ---------- 项目 ---------- */
.proj-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
.proj-card { border: 1px solid var(--line); border-radius: var(--rad); background: var(--bg2); padding: 14px 16px; cursor: pointer; transition: border-color .15s, transform .15s; }
.proj-card:hover { border-color: var(--pri); transform: translateY(-1px); }
.proj-card .pj-name { font-weight: 700; font-size: 15px; margin-bottom: 4px; }
.proj-card .pj-meta { font-size: 11.5px; color: var(--tx3); line-height: 1.6; }
.proj-card .pj-ins { font-size: 11.5px; color: var(--tx2); margin: 6px 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.pj-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.pj-form-row { display: flex; gap: 10px; margin-bottom: 10px; }
.pj-form-row .field { flex: 1; margin: 0; }
.pj-checks { display: flex; flex-direction: column; gap: 6px; max-height: 200px; overflow: auto; border: 1px solid var(--line); border-radius: 6px; padding: 8px; }
.pj-checks label { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--tx2); cursor: pointer; }
.pj-banner { display: flex; align-items: center; gap: 8px; padding: 6px 12px; background: var(--pri-light); border: 1px solid rgba(56,189,248,.3); border-radius: var(--rad); margin-bottom: 8px; font-size: 12.5px; }
.rc-section { margin-bottom: 14px; }
.rc-section > b { display: block; font-size: 12.5px; color: var(--tx); margin-bottom: 8px; }
.rc-section .hint { font-size: 11.5px; color: var(--tx3); line-height: 1.6; }
.pj-banner b { color: var(--pri); }
.mon-ev.error .m { color: #fca5a5; }
.mon-ev.warn .m { color: #fcd34d; }
.mon-trend { margin-top: 12px; }
.mon-trend svg { width: 100%; height: 130px; display: block; background: var(--bg2); border: 1px solid var(--line); border-radius: var(--rad); }
.mon-legend { display: flex; gap: 14px; font-size: 11px; color: var(--tx3); margin-top: 5px; }
.mon-legend i { display: inline-block; width: 10px; height: 3px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }
.mon-empty { color: var(--tx3); font-size: 12px; padding: 10px 0; text-align: center; }
/* ---------- 语音助手（小智 MCP 接入） ---------- */
.xz-list { display: flex; flex-direction: column; gap: 8px; }
.xz-row { display: flex; align-items: center; gap: 10px; border: 1px solid var(--line); border-radius: var(--rad); background: var(--bg2); padding: 10px 14px; }
.xz-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--tx3); flex: none; }
.xz-dot.on { background: var(--ok); box-shadow: 0 0 6px var(--ok); }
.xz-dot.off { background: var(--err); box-shadow: 0 0 6px var(--err); }
.xz-name { font-weight: 600; white-space: nowrap; }
.xz-ep { flex: 1; min-width: 0; font-family: var(--mono); font-size: 12px; color: var(--tx3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.xz-empty { color: var(--tx3); font-size: 12.5px; padding: 14px 0; text-align: center; }
/* 任务详情弹层 */
.mtd-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.mtd-sec { margin-top: 12px; }
.mtd-sec > b { display: block; font-size: 12.5px; color: var(--tx2); margin-bottom: 6px; }
.mtd-turn { border: 1px solid var(--line); border-radius: 8px; padding: 7px 10px; margin-bottom: 6px; background: var(--bg2); }
.mtd-turn .mtd-role { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--tx3); margin-bottom: 3px; }
.mtd-turn .mtd-role .who { color: var(--tx2); font-weight: 600; }
.mtd-turn .mtd-text { font-size: 12.5px; line-height: 1.55; color: var(--tx); white-space: pre-wrap; word-break: break-word; max-height: 180px; overflow: auto; }
.mtd-tool { font-size: 11.5px; color: var(--tx3); padding: 2px 0; font-family: var(--mono); }
.mtd-tool .tn { color: var(--acc); }
.mtd-tool.ok .tn { color: var(--ok); }
.mtd-tool.err .tn { color: var(--err); }
.mtd-tool.run .tn { color: var(--pri); }
</style>
</head>
<body>
<div id="app">
  <header>
    <div class="brand"><div class="logo">⚡</div><span id="brand-title">OneNat WorkBuddy</span><small>多智能体协作工作台</small></div>
    <nav id="nav">
      <button data-v="work" class="on"><span class="ic">💬</span><span class="lb">工作台</span></button>
      <button data-v="projects"><span class="ic">📦</span><span class="lb">项目</span></button>
      <button data-v="monitor"><span class="ic">📊</span><span class="lb">监控大屏</span></button>
      <span class="nav-sep" aria-hidden="true"></span>
      <button data-v="agents"><span class="ic">🤖</span><span class="lb">子智能体</span></button>
      <button data-v="resources"><span class="ic">🗂</span><span class="lb">资源目录</span></button>
      <button data-v="voice"><span class="ic">🎙</span><span class="lb">语音助手</span></button>
      <span class="nav-sep" aria-hidden="true"></span>
      <button data-v="schedules"><span class="ic">⏰</span><span class="lb">定时任务</span></button>
      <button data-v="files"><span class="ic">📁</span><span class="lb">文件管理</span></button>
      <span class="nav-sep" aria-hidden="true"></span>
      <button data-v="settings"><span class="ic">⚙️</span><span class="lb">设置</span></button>
    </nav>
    <div class="hspacer"></div>
    <div class="chip" id="onenat-chip"><span class="dot" id="onenat-dot"></span><span id="onenat-text">ONENAT 连接中…</span></div>
    <div class="chip" id="version-chip" title="OneNat WorkBuddy 版本（日期发布）"><span class="ver-ic">🏷</span><span id="version-text">v${VERSION}</span></div>
    ${AUTH_ENABLED ? '<button class="mini-btn" id="logout-btn" title="退出登录">⎋ 退出</button>' : ''}
  </header>
  <main>
    <div class="view on" id="view-work">
      <div class="side-backdrop" id="side-backdrop"></div>
      <aside class="task-side">
        <div class="side-head">
          <b>任务会话</b>
          <button class="btn-new" id="btn-new-task">＋ 新建任务</button>
        </div>
        <div class="side-search-box">
          <span class="s-icon">🔍</span>
          <input id="side-search" placeholder="搜索会话…" />
          <span class="s-clear" id="side-search-clear">✕</span>
        </div>
        <div class="task-list" id="task-list"></div>
      </aside>
      <section class="chat-main">
        <div class="chat-head" id="chat-head">
          <button class="side-toggle" id="btn-side-toggle" title="会话列表"><span class="st-hamb">☰</span></button>
          <span class="title" id="chat-title" title="双击重命名">选择或新建任务</span>
          <button class="mini-btn" id="btn-rename-task" style="display:none" title="重命名会话">✏️</button>
          <span class="badge mode" id="chat-mode" style="display:none"></span>
          <span class="hspacer"></span>
          <div class="main-agent-picker" id="main-agent-picker">
            <button class="main-agent-btn" id="main-agent-btn" title="全局默认智能体：影响所有未 @ 指定智能体的任务；单任务临时切换请用输入区上方「🎛 运行配置」">
              <span class="ag-ico">🤖</span>
              <span class="ag-name" id="main-agent-btn-name">主智能体: 加载中…</span>
              <span class="ag-arr">▾</span>
            </button>
            <div class="main-agent-pop" id="main-agent-pop"></div>
          </div>
        </div>
        <div class="chat-scroll" id="chat-scroll">
          <div class="chat-empty" id="chat-empty">
            <div style="font-size:34px">⚡</div>
            <div style="font-weight:600;font-size:15px;color:var(--tx)">OneNat WorkBuddy · 智能体协作工作台</div>
            <div style="font-size:12.5px;max-width:360px;text-align:center;line-height:1.6">点击「＋ 新建任务」开启会话；输入框键入 @ 可即时指定智能体或注入资源。</div>
            <div class="qe-grid">
              <button class="qe-card" data-qe="monitor"><span class="qe-ic">📊</span><b>监控大屏</b><span class="qe-d">智能体运行态势 · 任务进度 · 实时动态</span></button>
              <button class="qe-card" data-qe="agents"><span class="qe-ic">🤖</span><b>子智能体</b><span class="qe-d">添加/编辑执行节点 · 绑定资源与工作目录</span></button>
              <button class="qe-card" data-qe="voice"><span class="qe-ic">🎙</span><b>语音助手</b><span class="qe-d">接入小智，语音发任务、查结果</span></button>
              <button class="qe-card" data-qe="schedules"><span class="qe-ic">⏰</span><b>定时任务</b><span class="qe-d">按规则自动派发固定任务给智能体</span></button>
              <button class="qe-card" data-qe="resources"><span class="qe-ic">🗂</span><b>资源目录</b><span class="qe-d">SSH / DSH / HTTP 资源实时入口</span></button>
              <button class="qe-card" data-qe="files"><span class="qe-ic">📁</span><b>文件管理</b><span class="qe-d">浏览 / 上传智能体工作区文件</span></button>
            </div>
          </div>
        </div>
        <div class="todo-dock" id="todo-dock" style="display:none">
          <button class="todo-head" id="todo-head" aria-expanded="true" title="远端 DSH 会话的任务清单（todo_write）与运行时长 · 点击折叠/展开">
            <span class="todo-lead" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1.4" y="1.4" width="11.2" height="11.2" rx="2.6" stroke="currentColor" stroke-width="1.2"/><path d="M4.3 7.1l1.8 1.8 3.5-3.7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
            <span class="todo-title">任务</span>
            <span class="todo-progress" id="todo-progress"></span>
            <span class="hspacer"></span>
            <span class="todo-elapsed" id="todo-elapsed" style="display:none"></span>
            <span class="todo-chev" id="todo-chev" aria-hidden="true">▴</span>
          </button>
          <ul class="todo-list" id="todo-list"></ul>
        </div>
        <div class="chat-input-container">
          <!-- @ 提及自动联想浮层 -->
          <div class="mention-popup" id="mention-popup">
            <div class="mention-popup-head">
              <span>提及智能体或资源 (@)</span>
              <span>↑↓ 选择 · Enter 插入</span>
            </div>
            <div class="mention-popup-list" id="mention-list"></div>
          </div>
          <div class="mention-popup" id="skill-popup">
            <div class="mention-popup-head">
              <span>技能 (/) · 发送后由 DSH 装载技能正文</span>
              <span>↑↓ 选择 · Enter 插入</span>
            </div>
            <div class="mention-popup-list" id="skill-list"></div>
          </div>
          <button class="jump-bottom" id="btn-jump-bottom" title="回到底部">⬇<span class="jb-t"> 回到底部</span></button>
          <div class="composer-hint" id="composer-hint"></div>
          <div class="chat-input">
            <button class="mini-btn" id="btn-attach" title="上传附件到工作区" style="padding:10px 12px">📎</button>
            <input type="file" id="file-input" multiple style="display:none" />
            <textarea id="input" placeholder="输入消息…（@ 指定智能体/注入资源，Enter 发送）"></textarea>
            <button class="btn-stop" id="btn-stop" title="停止生成">■ 停止</button>
            <button class="btn-send" id="btn-send">发送</button>
          </div>
          <div class="composer-bar">
            <span class="hspacer"></span>
            <span class="model-status" id="model-status"></span>
            <button class="mini-btn" id="btn-run-config" title="运行配置：执行专家 / 节点与工作区 / 连接器 / 技能 / 模型">🎛 运行配置</button>
            <div class="model-picker" id="model-picker">
              <button class="cfg-sel model-btn" id="chat-model-btn" title="主调度模型 + 执行会话模型（点选即生效）">⚙ 主调度默认模型</button>
              <div class="model-pop" id="model-pop"></div>
            </div>
          </div>
          <div class="task-stats" id="task-stats" style="display:none"></div>
        </div>
      </section>
    </div>
    <div class="view" id="view-voice">
      <div class="panel">
        <div class="panel-head">
          <h2>🎙 语音助手</h2>
          <span class="sub">小智平台 MCP 接入（可多实例）· 工作台 11 个工具注册为语音可调用的 MCP 工具 · 变更即时生效（免重启）</span>
          <span class="hspacer"></span>
          <button class="btn pri" id="btn-xz-add">＋ 添加接入点</button>
        </div>
        <div class="xz-list" id="xz-list"><div class="mon-empty">加载中…</div></div>
        <div class="settings-note" style="margin-top:12px">接入点地址在小智平台「MCP 插件」页查看（形如 wss://api.xiaozhi.me/mcp/?token=…）。
          连接断开自动重连；停用/删除即时生效。注册的工具清单与「设置 → AI 接入」的工具通道实时同步，语音即可发任务、管理任务、看监控、管理定时任务。</div>
      </div>
    </div>
    <div class="view" id="view-projects">
      <div class="panel">
        <div class="panel-head">
          <h2>📦 项目</h2>
          <span class="sub">项目 = 节点 + 工作区 + 指令 + 子智能体/连接器/技能 的组合。项目内发起的任务自动继承全部上下文。</span>
          <span class="hspacer"></span>
          <button class="btn pri" id="btn-proj-new">＋ 新建项目</button>
        </div>
        <div class="proj-grid" id="proj-grid"><div class="mon-empty">加载中…</div></div>
      </div>
    </div>
    <div class="view" id="view-monitor">
      <div class="panel">
        <div class="mon-head">
          <div class="panel-head" style="margin:0"><h2>📊 监控大屏</h2><span class="sub">智能体运行态势 · 每 5 秒自动刷新 · 点智能体看会话，点任务看详情</span></div>
          <span class="hspacer"></span>
          <span class="mon-status" id="mon-status"></span>
          <button class="btn" id="mon-open-proj" title="独立暗色全屏投屏页（适合挂显示器）">🖥 投屏页</button>
        </div>
        <div class="mon-kpis" id="mon-kpis"><div class="mon-empty" style="grid-column:1/-1">加载中…</div></div>
        <div class="mon-alerts" id="mon-alerts"></div>
        <div class="mon-grid">
          <div class="mon-col">
            <div class="mon-sec-title">🤖 子智能体 <span class="cnt" id="mon-ag-cnt"></span><span class="spacer"></span><span style="color:var(--tx3);font-weight:400;font-size:11px">绿 在线 · 红 离线</span></div>
            <div class="mon-list" id="mon-agents"><div class="mon-empty">加载中…</div></div>
            <div class="mon-sec-title" style="margin-top:14px">🗂 资源调用 <span class="cnt" id="mon-res-cnt"></span></div>
            <div class="mon-list" id="mon-resources" style="max-height:26vh"><div class="mon-empty">加载中…</div></div>
          </div>
          <div class="mon-col">
            <div class="mon-sec-title">📋 任务会话 <span class="cnt" id="mon-task-cnt"></span><span class="spacer"></span><span style="color:var(--tx3);font-weight:400;font-size:11px">⏰ 定时 · 🎯 编排 · 💬 直通</span></div>
            <div class="mon-list" id="mon-tasks"><div class="mon-empty">加载中…</div></div>
          </div>
          <div class="mon-col">
            <div class="mon-sec-title">🔔 实时动态</div>
            <div class="mon-feed" id="mon-feed"><div class="mon-empty">暂无事件</div></div>
          </div>
        </div>
        <div class="mon-trend">
          <div class="mon-sec-title">📈 近 24 小时趋势 <span class="spacer"></span><span class="mon-legend" style="margin:0"><span><i style="background:var(--pri)"></i>运行中</span><span><i style="background:var(--ok)"></i>今日完成累计</span><span><i style="background:var(--err)"></i>今日失败累计</span></span></div>
          <svg id="mon-chart" viewBox="0 0 600 130" preserveAspectRatio="none"></svg>
        </div>
      </div>
    </div>
    <div class="view" id="view-files"><div class="panel files-panel">
      <div class="panel-head files-head">
        <h2>📁 远程工作空间文件管理</h2>
        <span class="sub">浏览、上传与管理远程主智能体 / 子智能体工作区文件 · 支持一键「@文件」引用到对话</span>
        <span class="hspacer"></span>
        <div style="display:flex;align-items:center;gap:6px">
          <label style="font-size:12px;color:var(--tx3);white-space:nowrap">智能体:</label>
          <select id="files-agent-select" class="cfg-sel" style="max-width:220px"></select>
        </div>
      </div>
      <div class="files-crumb-bar" id="files-crumb-bar"></div>
      <div class="files-action-bar">
        <div class="files-search-box">
          <span style="color:var(--tx3);font-size:13px">🔍</span>
          <input id="files-search" placeholder="按文件名搜索..." />
          <span id="files-search-clear" style="display:none;cursor:pointer;color:var(--tx3);font-size:12px">✕</span>
        </div>
        <button class="btn" id="btn-files-hidden" style="padding:6px 10px;font-size:12px">显示隐藏项</button>
        <span class="hspacer"></span>
        <button class="btn" id="btn-files-refresh" title="刷新文件列表">🔄 刷新</button>
        <button class="btn pri" id="btn-files-upload" title="上传文件到当前目录">⬆️ 上传文件</button>
        <button class="btn" id="btn-files-mkdir" title="新建文件夹">📁 新建文件夹</button>
        <input type="file" id="files-file-input" multiple style="display:none" />
      </div>
      <div class="batch-bar" id="files-batch-bar">
        <span class="batch-count" id="files-batch-count">已选 0 项</span>
        <button class="btn" id="btn-batch-at">💬 批量 @ 引用</button>
        <button class="btn" id="btn-batch-download">⬇️ 批量下载</button>
        <button class="btn danger-batch" id="btn-batch-del">🗑️ 批量删除</button>
        <span class="hspacer"></span>
        <button class="btn" id="btn-batch-clear" style="padding:5px 9px">✕ 取消选择</button>
      </div>
      <div class="files-body-wrap" id="files-drop-area">
        <div class="files-table-wrap">
          <table class="files-table">
            <thead>
              <tr>
                <th class="files-cell-check" style="width:34px;padding:9px 6px 9px 14px"><input type="checkbox" class="files-check-all" id="files-check-all" title="全选/取消全选" /></th>
                <th style="width:40%">名称</th>
                <th style="width:14%">大小</th>
                <th style="width:20%">修改时间</th>
                <th style="width:20%;text-align:right">操作</th>
              </tr>
            </thead>
            <tbody id="files-list"></tbody>
          </table>
        </div>
      </div>
      <div class="files-footer">
        <span id="files-stats">0 个项目</span>
        <span class="hspacer"></span>
        <span id="files-current-path-text" style="color:var(--tx3);font-size:11.5px;font-family:var(--mono)"></span>
      </div>
    </div></div>
    <div class="view" id="view-agents"><div class="panel">
      <div class="panel-head"><h2>子智能体管理</h2><span class="sub">绑定 ONENAT 上的 DSH 实体（稳定 ID，端口变化不影响）· 配置模式/模型/提示词/可用资源</span><span class="hspacer"></span><button class="btn pri" id="btn-new-agent">＋ 新建子智能体</button></div>
      <div id="agent-list"></div>
    </div></div>
    <div class="view" id="view-schedules"><div class="panel">
      <div class="panel-head"><h2>定时任务</h2><span class="sub">按规则定时把固定任务文本派发给一个或多个子智能体 · Host 侧调度（关闭页面不影响触发，错过的触发点不补跑）</span><span class="hspacer"></span><button class="btn pri" id="btn-new-schedule">＋ 新建定时任务</button></div>
      <div id="schedule-list"></div>
    </div></div>
    <div class="view" id="view-resources"><div class="panel">
      <div class="panel-head"><h2>资源目录</h2><span class="sub" id="res-sub"></span><span class="hspacer"></span><button class="btn" id="btn-res-refresh">↻ 强制刷新</button></div>
      <div class="card" style="padding:0"><div class="tbl-wrap"><table class="res" id="res-table"><thead><tr><th>资源</th><th>类型</th><th>公网入口（实时解析）</th><th>内网目标</th><th>技能</th></tr></thead><tbody></tbody></table></div></div>
    </div></div>
    <div class="view" id="view-settings"><div class="panel" style="max-width:1100px;margin:0 auto">
      <div class="panel-head"><h2>设置</h2><span class="sub">平台连接 · 主任务调度 · AI 接入</span><span class="hspacer"></span><button class="btn pri" id="btn-save-settings">保存设置</button></div>
      <div class="settings-grid">
      <div class="card">
        <h3 style="margin-bottom:12px">ONENAT 平台</h3>
        <div class="grid2">
          <div class="field"><label>Base URL</label><input id="set-base"></div>
          <div class="field"><label>API Key (onk-…)</label><input id="set-key"></div>
        </div>
        <div class="field" style="max-width:280px"><label>自动刷新间隔 (ms)</label><input id="set-refresh" type="number"></div>
      </div>
      <div class="card">
        <h3 style="margin-bottom:12px">LLM 规划器（主任务拆解）</h3>
        <div class="field" style="max-width:420px">
          <label>指定子智能体（主任务拆解由谁完成）</label>
          <select id="set-planner-agent"></select>
        </div>
        <div class="settings-note" id="set-planner-note">主任务拆解调用所选子智能体完成；默认自动使用本地子智能体（无则取列表第一个）。拆解用模型可在聊天窗下方工具栏选择，仅作用于主调度。</div>
      </div>
      <div class="card ai-card">
        <h3 style="margin-bottom:12px">AI 接入（一键安装提示词）</h3>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px">
          <b style="font-size:12.5px;color:var(--tx2)">① 安装提示词</b>
          <span style="font-size:11.5px;color:var(--tx3)">复制后发给任意有终端的 AI，它执行命令即完成安装与自检</span>
          <span class="hspacer"></span>
          <button class="btn" id="btn-reset-ai-token" style="white-space:nowrap" title="生成新令牌，旧令牌立即失效（无需重启）">生成 / 重置 APIKEY</button>
        </div>
        <textarea id="set-ai-install" readonly rows="8" style="font-family:var(--mono);font-size:12px;width:100%" placeholder="生成 APIKEY 后这里会出现安装提示词"></textarea>
        <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
          <button class="btn pri" id="btn-copy-ai-install" style="white-space:nowrap" title="复制安装提示词">复制安装提示词</button>
          <span style="font-size:11.5px;color:var(--tx3)">AI 执行后会自动装到本机所有 AI 技能目录（DSH / ZCode / Claude）并自检。</span>
        </div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:12px">
          <b style="font-size:12.5px;color:var(--tx2)">② APIKEY</b>
          <input id="set-ai-token" readonly style="font-family:var(--mono);flex:1" placeholder="未生成">
          <span style="font-size:11.5px;color:var(--tx3)">已内嵌于上方提示词，无需单独传递 · 重置后旧令牌立即失效（无需重启）</span>
        </div>
      </div>
      </div>
    </div></div>
  </main>
</div>

<div class="drawer-mask" id="drawer-mask"></div>
<aside class="drawer" id="drawer"><div class="drawer-head"><b id="drawer-title">详情</b><button class="mini-btn" id="drawer-close">✕ 关闭</button></div><div class="drawer-body" id="drawer-body"></div></aside>

<div class="modal-mask" id="modal-mask"><div class="modal"><div class="modal-head"><b id="modal-title"></b><button class="mini-btn" onclick="closeModal()">✕</button></div><div class="modal-body" id="modal-body"></div><div class="modal-foot" id="modal-foot"></div></div></div>
<div class="toast" id="toast"></div>

<script>
const PREFIX = ${JSON.stringify(prefix)};
const API = PREFIX + '/api';
const VERSION = ${JSON.stringify(VERSION)};
(function initVersion() {
  var el = document.getElementById('version-text');
  if (el && VERSION) el.textContent = 'v' + VERSION;
  // 服务端版本号兜底刷新（页面缓存/直接打开 dist 等场景）
  fetch(API + '/version').then(function (r) { return r.json(); }).then(function (j) {
    var v = j && j.data && j.data.version;
    if (v && el) el.textContent = 'v' + v;
  }).catch(function () {});
})();

/**
 * 前端核心状态管理与缓存层（对齐 DSH Web Client Store 架构）
 */
const state = {
  resources: [],
  agents: [],
  tasks: [],
  projects: [],
  projectId: null,   // 项目工作台：当前进入的项目（null = 全部/普通任务）
  taskEnv: { nodeRef: null, connectorIds: [], skillNames: [] },   // 单独任务环境（节点/连接器/技能）
  schedules: [],
  scheduleTemplates: null,
  taskCache: new Map(), // taskId -> WorkTask (完整缓存，支持 0ms 瞬间切换)
  settings: null,
  currentTaskId: null,
  searchQuery: '',
  groupCollapsed: { today: false, week: false, older: false, archived: true },
  es: null,
  turnEls: {},
  renderedTurnsCount: 0,
  initialVisibleLimit: 30, // 初始分块渲染轮数（加速首屏渲染）
  showAllTurns: false,
  renderedFromIndex: 0, // 当前视图实际渲染的起始轮次下标（供断线回源补齐限定窗口）
};

// Markdown 结果缓存，消除反复正则计算
const mdCache = new Map();

// @ 提及候选缓存与浮层状态
let mentionCandidates = [];
let mentionActiveIdx = 0;
let mentionMatched = [];
let mentionQuery = '';
let mentionCursorStart = 0;

// ---------- 工具函数 ----------
function $(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function toast(msg, isErr) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast on' + (isErr ? ' err' : ''); t.style.display = 'block';
  clearTimeout(t._h); t._h = setTimeout(() => { t.style.display = 'none'; }, 3200);
}
/**
 * 就地轻提示：在输入区上方淡出一行小字（不遮挡输入框与操作区），1.9s 自动淡出。
 * 用于「已填入输入框 / 已切换」这类成功反馈——底部长驻 toast 会盖住 composer 且打断视线。
 */
function hintComposer(msg, isErr) {
  const el = $('composer-hint');
  if (!el || !msg) return;
  el.textContent = msg;
  el.className = 'composer-hint on ' + (isErr ? 'err' : 'ok');
  clearTimeout(el._h);
  el._h = setTimeout(() => { el.classList.remove('on'); }, isErr ? 4200 : 1900);
}
/** 输入区脉冲：内容被填入输入框时给一次「已就位」的视觉确认（不占位、不遮挡） */
function pulseComposer() {
  const el = document.querySelector('.chat-input');
  if (!el) return;
  el.classList.remove('ok-flash');
  void el.offsetWidth; // 强制重排以重启动画
  el.classList.add('ok-flash');
  clearTimeout(el._f);
  el._f = setTimeout(() => el.classList.remove('ok-flash'), 1100);
}
/** 按钮就地确认：临时把按钮文案换成成功态并高亮，随后自动还原（替代成功类 toast） */
function flashBtnOk(btn, okText, restoreText, ms) {
  if (!btn) return;
  if (btn._okTimer) clearTimeout(btn._okTimer);
  btn.textContent = okText;
  btn.classList.add('ok');
  btn._okTimer = setTimeout(() => {
    btn.textContent = restoreText;
    btn.classList.remove('ok');
    btn._okTimer = null;
  }, ms || 1600);
}
async function api(path, opts) {
  let res;
  try {
    res = await fetch(API + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
  } catch (e) {
    // 网络层失败（服务重启间隙/连接被重置等）：不抛出，统一按业务失败处理，避免调用方中断卡死
    return { ok: false, error: '网络错误: ' + (e && e.message ? e.message : 'fetch failed') };
  }
  ${AUTH_ENABLED ? "if (res.status === 401 && path.indexOf('/auth/') !== 0) { location.replace(PREFIX + '/' + (location.hash || '')); return { ok: false, error: '未登录' }; }" : ''}
  let json = null; try { json = await res.json(); } catch (e) {}
  if (!json) json = { ok: false, error: 'HTTP ' + res.status };
  return json;
}
/** multipart 上传（不设 Content-Type，让浏览器自动带 boundary） */
async function apiPostMulti(path, formData) {
  const res = await fetch(API + path, { method: 'POST', body: formData });
  ${AUTH_ENABLED ? "if (res.status === 401) { location.replace(PREFIX + '/'); return { ok: false, error: '未登录' }; }" : ''}
  let json = null; try { json = await res.json(); } catch (e) {}
  if (!json) json = { ok: false, error: 'HTTP ' + res.status };
  return json;
}
${AUTH_ENABLED ? `async function doLogout() {
  try { await fetch(API + '/auth/logout', { method: 'POST' }); } catch (e) {}
  location.replace(PREFIX + '/' + (location.hash || ''));
}` : ''}
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}
function fmtDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/**
 * DSH Web 对齐的高性能 GFM Markdown 渲染引擎（含代码块复制、GFM 表格、任务列表、LRU 缓存）
 */
function md(text) {
  if (!text) return '';
  const cacheKey = text.length < 5000 ? text : (text.slice(0, 500) + '::' + text.length + '::' + text.slice(-500));
  if (mdCache.has(cacheKey)) return mdCache.get(cacheKey);

  let s = String(text);

  // 1. 提取并保护代码块
  const codeBlocks = [];
  s = s.replace(/\`\`\`([a-zA-Z0-9_+\\-#]*)[ \\t]*\\n([\\s\\S]*?)(?:\`\`\`|$)/g, (m, lang, code) => {
    const langClean = (lang || '').trim();
    const langLabel = langClean || 'TEXT';
    const escapedCode = esc(code.replace(/\\n$/, ''));
    const html =
      '<div class="md-code-block">' +
      '<div class="md-code-banner">' +
      '<span class="md-code-lang">' + esc(langLabel) + '</span>' +
      '<button class="md-code-copy" onclick="copyCode(this)" title="复制内容">复制</button>' +
      '</div>' +
      '<pre><code data-lang="' + esc(langClean) + '">' + escapedCode + '</code></pre>' +
      '</div>';
    codeBlocks.push(html);
    return '\\n%%CODEBLOCK_' + (codeBlocks.length - 1) + '%%\\n';
  });

  // 2. 提取并保护 GFM 表格
  const tables = [];
  s = s.replace(/(?:^|\\n)((?:\\|[^\\n]+\\|\\n?){2,})/g, (m, tableBlock) => {
    const lines = tableBlock.trim().split(/\\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length >= 2 && lines[1].includes('-')) {
      const parseRow = row => row.replace(/^\\|/, '').replace(/\\|$/, '').split('|').map(c => c.trim());
      const headers = parseRow(lines[0]);
      const alignLine = parseRow(lines[1]);
      const aligns = alignLine.map(a => {
        if (a.startsWith(':') && a.endsWith(':')) return 'center';
        if (a.endsWith(':')) return 'right';
        return 'left';
      });
      let tblHtml = '<div class="md-table-wrap"><table class="md-table"><thead><tr>';
      headers.forEach((h, i) => {
        const al = aligns[i] ? ' style="text-align:' + aligns[i] + '"' : '';
        tblHtml += '<th' + al + '>' + parseInline(h) + '</th>';
      });
      tblHtml += '</tr></thead><tbody>';
      for (let r = 2; r < lines.length; r++) {
        const cells = parseRow(lines[r]);
        tblHtml += '<tr>';
        cells.forEach((c, i) => {
          const al = aligns[i] ? ' style="text-align:' + aligns[i] + '"' : '';
          tblHtml += '<td' + al + '>' + parseInline(c) + '</td>';
        });
        tblHtml += '</tr>';
      }
      tblHtml += '</tbody></table></div>';
      tables.push(tblHtml);
      return '\\n%%TABLE_' + (tables.length - 1) + '%%\\n';
    }
    return m;
  });

  // 3. 行内元素与块级解析
  s = parseBlocks(s);

  // 4. 还原保护块
  s = s.replace(/%%CODEBLOCK_(\\d+)%%/g, (m, idx) => codeBlocks[+idx] || '');
  s = s.replace(/%%TABLE_(\\d+)%%/g, (m, idx) => tables[+idx] || '');

  if (mdCache.size > 800) mdCache.clear();
  mdCache.set(cacheKey, s);
  return s;
}

function parseInline(text) {
  let s = esc(text);
  // @ 智能体与资源高亮（对齐 DSH UI pill）
  s = s.replace(/@([^\s@,，。!！?？:：;；]+)/g, '<span class="mention-tag">@$1</span>');
  // 行内代码
  s = s.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');
  // 粗体
  s = s.replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<strong>$1</strong>');
  // 斜体
  s = s.replace(/(^|[^*\\w])\\*([^*\\n]+)\\*/g, '$1<em>$2</em>');
  // 删除线
  s = s.replace(/~~([^~\\n]+)~~/g, '<s>$1</s>');
  // 链接
  s = s.replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}

function parseBlocks(src) {
  const lines = src.split(/\\n/);
  const out = [];
  let inList = null; // 'ul' | 'ol'
  let inQuote = false;

  const closeList = () => {
    if (inList) { out.push('</' + inList + '>'); inList = null; }
  };
  const closeQuote = () => {
    if (inQuote) { out.push('</blockquote>'); inQuote = false; }
  };

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      closeList();
      closeQuote();
      continue;
    }

    // 占位符直接穿透
    if (trimmed.startsWith('%%CODEBLOCK_') || trimmed.startsWith('%%TABLE_')) {
      closeList(); closeQuote();
      out.push(trimmed);
      continue;
    }

    // 引用 blockquote
    if (trimmed.startsWith('&gt;') || trimmed.startsWith('>')) {
      closeList();
      if (!inQuote) { out.push('<blockquote>'); inQuote = true; }
      const qText = trimmed.replace(/^(?:&gt;|>)\\s?/, '');
      out.push('<p>' + parseInline(qText) + '</p>');
      continue;
    } else {
      closeQuote();
    }

    // 标题
    if (/^#{1,6}\\s/.test(trimmed)) {
      closeList();
      const level = trimmed.match(/^#+/)[0].length;
      const hText = trimmed.replace(/^#+\\s*/, '');
      out.push('<h' + level + '>' + parseInline(hText) + '</h' + level + '>');
      continue;
    }

    // 分隔线
    if (/^(?:-{3,}|\\*{3,}|_{3,})$/.test(trimmed)) {
      closeList();
      out.push('<hr>');
      continue;
    }

    // 任务列表 Task List: - [ ] 或 - [x]
    const taskMatch = /^[-*]\\s+\\[([ xX])\\]\\s+(.+)$/.exec(trimmed);
    if (taskMatch) {
      if (inList !== 'ul') { closeList(); out.push('<ul style="list-style:none;padding-left:4px">'); inList = 'ul'; }
      const checked = taskMatch[1].toLowerCase() === 'x';
      out.push('<li><input type="checkbox" ' + (checked ? 'checked' : '') + ' disabled>' + parseInline(taskMatch[2]) + '</li>');
      continue;
    }

    // 无序列表
    const ulMatch = /^[-*•]\\s+(.+)$/.exec(trimmed);
    if (ulMatch) {
      if (inList !== 'ul') { closeList(); out.push('<ul>'); inList = 'ul'; }
      out.push('<li>' + parseInline(ulMatch[1]) + '</li>');
      continue;
    }

    // 有序列表
    const olMatch = /^(\\d+)[.)]\\s+(.+)$/.exec(trimmed);
    if (olMatch) {
      if (inList !== 'ol') { closeList(); out.push('<ol>'); inList = 'ol'; }
      out.push('<li>' + parseInline(olMatch[2]) + '</li>');
      continue;
    }

    // 普通段落
    closeList();
    out.push('<p>' + parseInline(trimmed) + '</p>');
  }

  closeList();
  closeQuote();
  return out.join('\\n');
}

/** 代码复制功能（对齐 DSH Web CodeBlock） */
function copyCode(btn) {
  const block = btn.closest('.md-code-block');
  if (!block) return;
  const code = block.querySelector('code');
  if (!code) return;
  const text = code.textContent || '';
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = '✓ 已复制';
    btn.classList.add('copied');
    setTimeout(() => {
      btn.textContent = '复制';
      btn.classList.remove('copied');
    }, 2000);
  }).catch(() => {
    toast('复制失败', true);
  });
}

function statusColor(s) {
  return s === 'completed' || s === 'success' ? 'completed'
    : (s === 'running' ? 'running' : (s === 'failed' ? 'failed' : (s === 'partial_success' ? 'partial_success' : 'draft')));
}

// ---------- AI 文本中的文件路径 → 可下载链接 ----------
const FILE_LINK_RE = /(?<![:\\/\\w.\\-])(\\/(?:[A-Za-z0-9_\\-.\\u4e00-\\u9fa5]+\\/)*[A-Za-z0-9_\\-\\u4e00-\\u9fa5]+(?:\\.[A-Za-z0-9_\\-\\u4e00-\\u9fa5]+)*\\.(?:txt|md|markdown|json|jsonl|csv|tsv|log|pdf|png|jpe?g|gif|webp|svg|bmp|ico|zip|gz|tgz|tar|7z|html?|css|js|mjs|ts|jsx|tsx|py|sh|bat|sql|xml|ya?ml|toml|ini|conf|env|bin|dat|xlsx?|docx?|pptx?|mp[34]|wav|webm))(?![\\w.\\-])/g;
function withFileLinks(taskId, agentId, text) {
  if (!text || String(text).indexOf('/') < 0) return text;
  let s = String(text);
  const stash = [];
  s = s.replace(/\`\`\`[\\s\\S]*?\`\`\`|\`[^\`\\n]+\`/g, (m) => { stash.push(m); return '\\u0000' + stash.length + '\\u0000'; });
  s = s.replace(FILE_LINK_RE, (m, p) => '[📎 ' + p.split('/').pop() + '](' + location.origin + API + '/tasks/' + taskId + '/files/download?agent=' + encodeURIComponent(agentId || '') + '&path=' + encodeURIComponent(p) + ')');
  s = s.replace(/\\u0000(\\d+)\\u0000/g, (m, i) => stash[+i - 1] || '');
  return s;
}

function fmtSize(n) {
  if (n < 1024) return n + 'B';
  if (n < 1048576) return (n / 1024).toFixed(1) + 'KB';
  return (n / 1048576).toFixed(1) + 'MB';
}

function lastLine(s) {
  const lines = String(s || '').split('\\n').filter(x => x.trim());
  return (lines[lines.length - 1] || '').slice(0, 90);
}

// ---------- 监控大屏 ----------
var monData = null;
var monTimer = null;
var monHist = [];
var monHistLabels = [];
var monHistAt = 0;

function monitorStart() {
  if ($('mon-open-proj') && !$('mon-open-proj')._wired) {
    $('mon-open-proj')._wired = true;
    $('mon-open-proj').addEventListener('click', () => window.open(PREFIX + '/monitor', '_blank'));
  }
  if (monTimer) return;
  renderMonitor();
  monTimer = setInterval(renderMonitor, 5000);
}
function monitorStop() {
  if (monTimer) { clearInterval(monTimer); monTimer = null; }
}

async function renderMonitor() {
  var r = await api('/monitor/overview');
  var st = $('mon-status');
  if (!r.ok) { st.textContent = '⚠ 加载失败：' + (r.error || '未知'); return; }
  st.textContent = '更新于 ' + fmtTime(Date.now());
  monData = r.data;
  renderMonKpis(monData.kpi);
  renderMonAlerts(monData.alerts || []);
  renderMonAgents(monData.agents || []);
  renderMonTasks(monData.tasks || []);
  renderMonFeed(monData.events || []);
  renderMonResources(monData.agents || [], monData.sshPool || []);
  if (Date.now() - monHistAt > 60000) {
    monHistAt = Date.now();
    var hr = await api('/monitor/history?days=2');
    if (hr.ok) { monHist = (hr.data.days || []); renderMonChart(); }
  }
}

function monFmtTok(n) {
  n = n || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + 'k';
  return String(n);
}
function monFmtElapse(ms) {
  if (!ms || ms < 0) return '';
  var s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  var m = Math.floor(s / 60); if (m < 60) return m + 'm' + (s % 60) + 's';
  var h = Math.floor(m / 60); if (h < 24) return h + 'h' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd' + (h % 24) + 'h';
}
function monFmtCountdown(ts) {
  if (!ts) return '';
  var diff = ts - Date.now();
  if (diff <= 0) return '即将触发';
  var m = Math.floor(diff / 60000);
  if (m < 60) return m + ' 分钟后';
  var h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时 ' + (m % 60) + ' 分后';
  return Math.floor(h / 24) + ' 天后';
}
var MON_EV_ICON = {
  task_started: '▶️', task_completed: '✅', task_failed: '❌', task_cancelled: '⏹️',
  subtask_completed: '✔️', subtask_failed: '✖️', plan_created: '🧩', schedule_fired: '⏰',
  agent_online: '🟢', agent_offline: '🔴', resource_drift: '🔀', resource_offline: '📴', resource_online: '🔌'
};

function renderMonKpis(k) {
  var tiles = [
    { lb: '🤖 在线智能体', v: k.agentsOnline + ' / ' + k.agentsTotal, cls: k.agentsOnline ? 'ok' : 'err', d: k.agentsBusy + ' 执行中' + (k.agentsDisabled ? ' · ' + k.agentsDisabled + ' 停用' : '') },
    { lb: '⚡ 运行中任务', v: String(k.tasksRunning), cls: 'pri', d: '并发执行' },
    { lb: '✅ 今日完成', v: String(k.tasksCompletedToday), cls: 'ok', d: '自 0 点' },
    { lb: '❌ 今日失败', v: String(k.tasksFailedToday), cls: k.tasksFailedToday ? 'err' : '', d: k.tasksFailedToday ? '需关注' : '正常' },
    { lb: '🪙 今日 Token', v: monFmtTok(k.tokensInputToday + k.tokensOutputToday), cls: '', d: '缓存命中 ' + monFmtTok(k.cacheReadToday) },
    { lb: '🛠 今日工具调用', v: String(k.toolCallsToday), cls: '', d: k.schedulesEnabled + '/' + k.schedulesTotal + ' 定时启用' },
    { lb: '⏰ 下次定时', v: k.nextScheduleAt ? monFmtCountdown(k.nextScheduleAt) : '—', cls: 'warn', d: k.nextScheduleName || '无启用定时任务' }
  ];
  var html = '';
  for (var i = 0; i < tiles.length; i++) {
    var t = tiles[i];
    html += '<div class="mon-kpi"><div class="lb">' + t.lb + '</div><div class="v ' + t.cls + '" title="' + esc(t.v) + '">' + esc(t.v) + '</div><div class="d" title="' + esc(t.d) + '">' + esc(t.d) + '</div></div>';
  }
  $('mon-kpis').innerHTML = html;
}

function renderMonAlerts(alerts) {
  var el = $('mon-alerts');
  if (!alerts.length) { el.className = 'mon-alerts'; el.innerHTML = ''; return; }
  var html = '';
  for (var i = 0; i < Math.min(alerts.length, 6); i++) {
    html += '<span class="mon-alert ' + (alerts[i].level === 'warn' ? 'warn' : '') + '">⚠ ' + esc(alerts[i].msg) + '</span>';
  }
  el.className = 'mon-alerts on';
  el.innerHTML = html;
}

function renderMonAgents(agents) {
  var el = $('mon-agents');
  var onlineCnt = agents.filter(function(a) { return a.online; }).length;
  $('mon-ag-cnt').textContent = onlineCnt + '/' + agents.length + ' 在线';
  if (!agents.length) { el.innerHTML = '<div class="mon-empty">还没有子智能体，去「子智能体」页创建</div>'; return; }
  var busy = agents.filter(function(a) { return a.busy; });
  var rest = agents.filter(function(a) { return !a.busy; });
  var ordered = busy.concat(rest);
  var html = '';
  for (var i = 0; i < ordered.length; i++) {
    var a = ordered[i];
    var stCls = !a.enabled ? '' : (a.online ? 'on' : 'off');
    var badge = a.busy ? '<span class="mon-badge busy">⚡ 执行中 ×' + a.runningCount + '</span>'
      : (!a.enabled ? '<span class="mon-badge">已停用</span>'
      : (a.online ? '<span class="mon-badge">空闲</span>' : '<span class="mon-badge bad">离线</span>'));
    var resChips = '';
    var resources = a.resources || [];
    for (var j = 0; j < resources.length; j++) {
      var rr = resources[j];
      var inUse = rr.inUse && rr.inUse.length;
      var cls = inUse ? 'hot' : (rr.online ? 'on' : 'off');
      var mark = inUse ? ' 🔥' : (rr.online ? '' : ' ⚠');
      resChips += '<span class="mon-res-chip ' + cls + '" title="' + esc(rr.kind) + ' · ' + esc(rr.endpoint || '入口未知') + '">' + esc(rr.name) + mark + '</span>';
    }
    var act = a.busy && a.currentActivity ? '<div class="mon-act">▸ <b>' + esc(a.currentActivity) + '</b></div>'
      : (a.online ? '' : '<div class="mon-err-line">' + esc(a.error || '不可达') + '</div>');
    html += '<div class="mon-agent" data-agent="' + esc(a.id) + '" title="点击查看该智能体的会话列表">' +
      '<div class="mon-row1"><span class="mon-dot ' + stCls + '"></span><span class="mon-nm">' + esc(a.name) + '</span>' +
      '<span class="mon-md">' + esc(a.model || '') + '</span><span class="mon-spacer"></span>' + badge + '</div>' + act +
      (resChips ? '<div class="mon-res">' + resChips + '</div>' : '') +
      '</div>';
  }
  el.innerHTML = html;
  el.querySelectorAll('.mon-agent').forEach(function(card) {
    card.addEventListener('click', function() { monOpenAgent(card.dataset.agent); });
  });
}

function monHlCls(t) {
  if (t.running) return 'run';
  if (t.status === 'completed' || t.status === 'success') return 'ok';
  if (t.status === 'failed') return 'bad';
  if (t.status === 'cancelled') return 'stop';
  return '';
}

/** 定时派生任务标题自带「⏰ 」前缀，图标位已单独渲染，避免重复 */
function monTaskTitle(t) {
  var s = String(t.title || '');
  if (t.type === 'schedule') {
    while (s.charAt(0) === '⏰' || s.charAt(0) === ' ') s = s.slice(1);
  }
  return s;
}

function renderMonTasks(tasks) {
  var el = $('mon-tasks');
  var running = tasks.filter(function(t) { return t.running; });
  $('mon-task-cnt').textContent = running.length + ' 运行 / ' + tasks.length + ' 总数';
  if (!tasks.length) { el.innerHTML = '<div class="mon-empty">暂无任务会话</div>'; return; }
  var rest = tasks.filter(function(t) { return !t.running; }).slice(0, 14);
  var ordered = running.concat(rest);
  var html = '';
  for (var i = 0; i < ordered.length; i++) {
    var t = ordered[i];
    var act = t.activity || {};
    var sub = '';
    if (act.subtasks && act.subtasks.total) {
      sub = '子任务 ' + act.subtasks.completed + '/' + act.subtasks.total + ' 完成' + (act.subtasks.currentTitle ? ' · 「' + esc(act.subtasks.currentTitle) + '」' : '');
    } else if (act.todoCurrent) {
      sub = '当前步骤：' + esc(act.todoCurrent);
    } else if (act.todosTotal) {
      sub = '清单 ' + act.todosDone + '/' + act.todosTotal;
    }
    var pct = (act.subtasks && act.subtasks.total) ? Math.round(100 * act.subtasks.completed / act.subtasks.total) : null;
    html += '<div class="mon-task' + (t.running ? '' : ' done') + '" data-task="' + esc(t.id) + '" title="点击查看任务详情">' +
      '<div class="mon-row1"><span>' + t.typeIcon + '</span><span class="mon-nm">' + esc(monTaskTitle(t)) + '</span>' +
      '<span class="mon-spacer"></span>' +
      (t.running ? '<span class="mon-badge run">⏱ ' + monFmtElapse(t.elapsedMs) + '</span>' : '') +
      '<span class="mon-badge ' + (t.running ? 'run' : monHlCls(t) === 'bad' ? 'bad' : monHlCls(t) === 'ok' ? 'ok' : monHlCls(t) === 'stop' ? 'warn' : '') + '">' + esc(t.status === 'running' ? '运行中' : t.status === 'completed' || t.status === 'success' ? '完成' : t.status === 'failed' ? '失败' : t.status === 'cancelled' ? '已中止' : t.status === 'draft' ? '草稿' : '部分成功') + '</span>' +
      '</div>' +
      '<div class="mon-hl ' + monHlCls(t) + '">' + esc(t.headline) + '</div>' +
      (t.description ? '<div class="mon-desc" title="' + esc(t.description) + '">' + esc(t.description) + '</div>' : '') +
      (sub ? '<div class="mon-desc">' + sub + '</div>' : '') +
      (pct != null ? '<div class="mon-bar"><i style="width:' + pct + '%"></i></div>' : '') +
      '</div>';
  }
  el.innerHTML = html;
  el.querySelectorAll('.mon-task').forEach(function(card) {
    card.addEventListener('click', function() { monOpenTask(card.dataset.task); });
  });
}

function renderMonFeed(events) {
  var el = $('mon-feed');
  if (!events.length) { el.innerHTML = '<div class="mon-empty">暂无事件 · 等待任务与定时触发</div>'; return; }
  var html = '';
  for (var i = 0; i < Math.min(events.length, 80); i++) {
    var e = events[i];
    html += '<div class="mon-ev ' + e.level + '"><span class="t">' + fmtTime(e.at) + '</span><span>' + (MON_EV_ICON[e.kind] || '·') + '</span><span class="m">' + esc(e.msg) + '</span></div>';
  }
  el.innerHTML = html;
}

function renderMonResources(agents, sshPool) {
  var el = $('mon-resources');
  var rows = [];
  var total = 0, hot = 0;
  for (var i = 0; i < agents.length; i++) {
    var a = agents[i];
    var resources = a.resources || [];
    for (var j = 0; j < resources.length; j++) {
      var r = resources[j];
      total += 1;
      var inUse = r.inUse && r.inUse.length;
      if (inUse) hot += 1;
      var useBy = inUse ? ' 🔥 ' + esc(r.inUse[0].taskTitle) : '';
      rows.push('<div class="mon-row1" style="padding:2px 0"><span class="mon-badge ' + (inUse ? 'warn' : r.online ? 'ok' : 'bad') + '">' + esc(a.name) + '</span>' +
        '<span class="mon-nm" style="font-weight:400">' + esc(r.name) + '</span>' +
        '<span class="mon-md">' + esc(r.kind) + (r.online ? '' : ' · 离线') + useBy + '</span><span class="mon-spacer"></span></div>');
    }
  }
  for (var s = 0; s < sshPool.length; s++) {
    var p = sshPool[s];
    if (!(p.inUse && p.inUse.length)) continue;
    hot += 1;
    rows.push('<div class="mon-row1" style="padding:2px 0"><span class="mon-badge warn">SSH 池</span>' +
      '<span class="mon-nm" style="font-weight:400">' + esc(p.name) + '</span>' +
      '<span class="mon-md">🔥 ' + esc(p.inUse[0].taskTitle) + '</span><span class="mon-spacer"></span></div>');
  }
  $('mon-res-cnt').textContent = total + ' 绑定 · ' + hot + ' 使用中';
  el.innerHTML = rows.length ? rows.join('') : '<div class="mon-empty">没有绑定资源 · 在「子智能体」页为智能体绑定 SSH/HTTP/DSH 资源</div>';
}

function monOpenAgent(agentId) {
  if (!monData) return;
  var a = null;
  for (var i = 0; i < monData.agents.length; i++) if (monData.agents[i].id === agentId) a = monData.agents[i];
  if (!a) return;
  var list = monData.tasks.filter(function(t) { return t.agentIds.indexOf(agentId) >= 0; });
  var html = '<div class="mon-row1" style="margin-bottom:8px"><span class="mon-dot ' + (a.online ? 'on' : 'off') + '"></span>' +
    '<span class="mon-nm">' + esc(a.name) + '</span><span class="mon-spacer"></span>' +
    '<span class="mon-badge ' + (a.busy ? 'busy' : '') + '">' + (a.busy ? '⚡ 执行中' : a.online ? '空闲' : '离线') + '</span></div>';
  if (a.model) html += '<div class="mon-desc">模型：' + esc(a.model) + '</div>';
  if (a.resources && a.resources.length) {
    html += '<div class="mtd-sec"><b>🗂 绑定资源</b>';
    for (var j = 0; j < a.resources.length; j++) {
      var r = a.resources[j];
      var inUse = r.inUse && r.inUse.length;
      html += '<div class="mon-row1" style="padding:2px 0"><span class="mon-res-chip ' + (inUse ? 'hot' : r.online ? 'on' : 'off') + '">' + esc(r.name) + (inUse ? ' 🔥' : '') + '</span>' +
        '<span class="mon-md">' + esc(r.kind) + (r.credentialMode ? ' · 凭证 ' + esc(r.credentialMode) : '') + '</span><span class="mon-spacer"></span></div>';
      if (inUse) {
        for (var u = 0; u < r.inUse.length; u++) {
          html += '<div class="mon-desc">↳ 任务「' + esc(r.inUse[u].taskTitle) + '」的工具调用中出现该资源</div>';
        }
      }
    }
    html += '</div>';
  }
  html += '<div class="mtd-sec"><b>📋 会话列表（' + list.length + '）</b>';
  if (!list.length) html += '<div class="mon-empty">该智能体还没有参与任何任务</div>';
  for (var k = 0; k < list.length; k++) {
    var t = list[k];
    html += '<div class="mon-task" data-mtask="' + esc(t.id) + '"><div class="mon-row1"><span>' + t.typeIcon + '</span>' +
      '<span class="mon-nm">' + esc(monTaskTitle(t)) + '</span><span class="mon-spacer"></span>' +
      '<span class="mon-md">' + fmtDateTime(t.updatedAt) + '</span></div>' +
      '<div class="mon-hl ' + monHlCls(t) + '">' + esc(t.headline) + '</div></div>';
  }
  html += '</div>';
  $('drawer-title').textContent = '🤖 ' + a.name + ' · 运行详情';
  $('drawer-body').innerHTML = html;
  openDrawer('🤖 ' + a.name + ' · 运行详情');
  $('drawer-body').querySelectorAll('[data-mtask]').forEach(function(card) {
    card.addEventListener('click', function() { closeDrawer(); monOpenTask(card.dataset.mtask); });
  });
}

async function monOpenTask(taskId) {
  openModal('任务详情', '<div class="mon-empty">加载中…</div>');
  var r = await api('/tasks/' + encodeURIComponent(taskId));
  if (!r.ok) { openModal('任务详情', '<div class="mon-empty">加载失败：' + esc(r.error || '未知') + '</div>'); return; }
  var t = r.data;
  var mon = null;
  if (monData) for (var i = 0; i < monData.tasks.length; i++) if (monData.tasks[i].id === taskId) mon = monData.tasks[i];
  var typeIcon = mon ? mon.typeIcon : (t.mode === 'orchestrate' ? '🎯' : '💬');
  var headTitle = mon ? monTaskTitle(mon) : String(t.title || '');
  var html = '';
  html += '<div class="mtd-head"><span style="font-size:18px">' + typeIcon + '</span><b>' + esc(headTitle) + '</b>' +
    '<span class="mon-badge ' + (t.running ? 'run' : t.status === 'failed' ? 'bad' : t.status === 'completed' || t.status === 'success' ? 'ok' : '') + '">' + esc(t.status) + '</span>' +
    '<span class="mon-md">' + esc((t.memberAgentIds || []).length) + ' 成员 · ' + fmtDateTime(t.createdAt) + '</span></div>';
  if (mon) {
    html += '<div class="mtd-sec"><b>当前状态</b><div class="mon-hl ' + monHlCls(mon) + '" style="white-space:normal">' + esc(mon.headline) + '</div>';
    var act = mon.activity || {};
    if (act.todoCurrent) html += '<div class="mon-desc">当前步骤：' + esc(act.todoCurrent) + '</div>';
    if (act.runningTools && act.runningTools.length) {
      for (var rt = 0; rt < act.runningTools.length; rt++) {
        html += '<div class="mtd-tool run"><span class="tn">⏳ ' + esc(act.runningTools[rt].name) + '</span> 执行中</div>';
      }
    }
    if (act.subtasks && act.subtasks.total) {
      html += '<div class="mon-desc">子任务进度：' + act.subtasks.completed + '/' + act.subtasks.total + ' 完成' + (act.subtasks.failed ? ' · ' + act.subtasks.failed + ' 失败' : '') + '</div>';
    }
    html += '</div>';
  }
  if (t.plan && t.plan.subtasks && t.plan.subtasks.length) {
    html += '<div class="mtd-sec"><b>🧩 编排计划（' + t.plan.subtasks.length + ' 个子任务）</b>';
    for (var p = 0; p < t.plan.subtasks.length; p++) {
      var sb = t.plan.subtasks[p];
      html += '<div class="mon-row1" style="padding:2px 0"><span class="mon-badge ' + (sb.status === 'completed' ? 'ok' : sb.status === 'running' ? 'run' : sb.status === 'failed' ? 'bad' : '') + '">' + esc(sb.status) + '</span>' +
        '<span class="mon-nm" style="font-weight:400">' + esc(sb.title) + '</span></div>';
    }
    html += '</div>';
  }
  if (t.summary && t.summary.finalConclusion) {
    html += '<div class="mtd-sec"><b>✅ 汇总结论</b><div class="mtd-turn"><div class="mtd-text">' + esc(t.summary.finalConclusion.slice(0, 800)) + '</div></div></div>';
  }
  var turns = (t.turns || []).slice(-20);
  html += '<div class="mtd-sec"><b>💬 对话回放（最近 ' + turns.length + ' 轮，完整对话请在工作台查看）</b>';
  if (!turns.length) html += '<div class="mon-empty">还没有对话</div>';
  for (var ti = 0; ti < turns.length; ti++) {
    var turn = turns[ti];
    var who = turn.role === 'user' ? '👤 你' : turn.role === 'system' ? '⚙ 系统' : '🤖 ' + (turn.agentName || '智能体');
    var toolsHtml = '';
    var tools = turn.tools || [];
    for (var t2 = 0; t2 < tools.length; t2++) {
      var tool = tools[t2];
      var cls = tool.status === 'running' ? 'run' : tool.status === 'error' ? 'err' : 'ok';
      var ico = tool.status === 'running' ? '⏳' : tool.status === 'error' ? '❌' : '🔧';
      toolsHtml += '<div class="mtd-tool ' + cls + '"><span class="tn">' + ico + ' ' + esc(tool.name) + '</span>' +
        (tool.ms ? ' ' + Math.round(tool.ms / 100) / 10 + 's' : '') +
        (tool.args ? ' · ' + esc(String(tool.args).slice(0, 60)) : '') + '</div>';
    }
    var text = String(turn.text || '');
    if (text.length > 600) text = text.slice(0, 600) + ' …';
    html += '<div class="mtd-turn"><div class="mtd-role"><span class="who">' + esc(who) + '</span><span>' + fmtTime(turn.at) + '</span></div>' +
      toolsHtml +
      (text ? '<div class="mtd-text">' + esc(text) + '</div>' : '') +
      '</div>';
  }
  html += '</div>';
  var foot = '<button class="btn" onclick="closeModal()">关闭</button>';
  openModal('任务详情', html);
  $('modal-foot').innerHTML = foot + ' <button class="btn pri" id="mtd-open-work">💬 在工作台打开完整对话</button>';
  $('mtd-open-work').addEventListener('click', function() {
    closeModal();
    switchView('work');
    openTask(taskId);
  });
}

function monRenderChartSvg() {
  var snaps = [];
  for (var i = 0; i < monHist.length; i++) {
    var arr = monHist[i].snapshots || [];
    for (var j = 0; j < arr.length; j++) snaps.push(arr[j]);
  }
  snaps.sort(function(a, b) { return a.at - b.at; });
  var cutoff = Date.now() - 24 * 3600 * 1000;
  var recent = snaps.filter(function(s) { return s.at >= cutoff; });
  // 单快照时复制一点成平线，避免画不出任何可见轨迹
  if (recent.length === 1) recent = [recent[0], Object.assign({}, recent[0], { at: recent[0].at + 3600000 })];
  monHistLabels = recent.map(function(s) { return fmtTime(s.at); });
  var svg = $('mon-chart');
  if (!svg) return;
  if (!recent.length) { svg.innerHTML = '<text x="300" y="65" fill="#64748b" font-size="11" text-anchor="middle">暂无快照数据（服务每小时自动采集一次）</text>'; return; }
  var series = [
    { color: '#38bdf8', pts: recent.map(function(s) { return s.tasksRunning; }), fill: false },
    { color: '#34d399', pts: recent.map(function(s) { return s.tasksCompletedToday; }), fill: true },
    { color: '#f87171', pts: recent.map(function(s) { return s.tasksFailedToday; }), fill: false }
  ];
  var W = 600, H = 130, padB = 14, padT = 6;
  var max = 1;
  for (var s2 = 0; s2 < series.length; s2++) for (var p2 = 0; p2 < series[s2].pts.length; p2++) if (series[s2].pts[p2] > max) max = series[s2].pts[p2];
  var n = recent.length;
  var stepX = W / Math.max(1, n - 1);
  var parts = [];
  for (var s3 = 0; s3 < series.length; s3++) {
    var se = series[s3];
    var d = '';
    for (var p3 = 0; p3 < se.pts.length; p3++) {
      var x = p3 * stepX;
      var y = padT + (H - padT - padB) * (1 - Math.min(1, se.pts[p3] / max));
      d += (p3 ? ' L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    if (se.fill) {
      parts.push('<path d="' + d + ' L' + ((se.pts.length - 1) * stepX).toFixed(1) + ' ' + (H - padB) + ' L0 ' + (H - padB) + ' Z" fill="' + se.color + '" opacity="0.1"/>');
    }
    parts.push('<path d="' + d + '" fill="none" stroke="' + se.color + '" stroke-width="2" stroke-linejoin="round"/>');
  }
  for (var p4 = 0; p4 < n; p4 += Math.max(1, Math.floor(n / 6))) {
    var lbl = monHistLabels[p4] || '';
    if (lbl) {
      var lx = Math.max(20, Math.min(W - 20, p4 * stepX));
      parts.push('<text x="' + lx.toFixed(1) + '" y="' + (H - 2) + '" fill="#64748b" font-size="9" text-anchor="middle">' + esc(lbl) + '</text>');
    }
  }
  svg.innerHTML = parts.join('');
}
function renderMonChart() { monRenderChartSvg(); }

// ---------- 语音助手（小智 MCP 接入） ----------
var xzTimer = null;
function voiceStart() {
  if (!$('btn-xz-add')._wired) {
    $('btn-xz-add')._wired = true;
    $('btn-xz-add').addEventListener('click', () => xzOpenForm(null));
  }
  loadXzList();
  if (!xzTimer) xzTimer = setInterval(loadXzList, 5000);
}
function voiceStop() {
  if (xzTimer) { clearInterval(xzTimer); xzTimer = null; }
}
async function loadXzList() {
  const el = $('xz-list');
  if (!el) return;
  const r = await api('/xiaozhi/status');
  const list = (r.ok && r.data.endpoints) || [];
  if (!list.length) {
    el.innerHTML = '<div class="xz-empty">还没有接入点 —— 点右上角「＋ 添加接入点」，把小智平台的 MCP 接入地址填进来</div>';
    return;
  }
  const html = list.map((x) => {
    const dotCls = !x.enabled ? '' : (x.connected ? 'on' : 'off');
    const badge = !x.enabled ? '<span class="mon-badge">已停用</span>'
      : (x.connected ? '<span class="mon-badge ok">● 已连接 · 语音可发任务</span>' : '<span class="mon-badge warn">● 未连接（自动重连中）</span>');
    // 诊断：调用/丢弃/幂等命中/上次断线原因 —— 重复建单、会话被打断时的第一现场
    const st = x.stats || {};
    const last = st.lastTool;
    const diag = (st.calls || st.dropped || st.replays || st.lastClose)
      ? '<span class="xz-ep" title="' + esc([
          '调用 ' + (st.calls || 0) + ' 次 · 失败 ' + (st.failures || 0) + ' 次',
          '回包丢弃 ' + (st.dropped || 0) + ' 次（平台侧会看到无应答，可能重发整轮请求）',
          '幂等命中 ' + (st.replays || 0) + ' 次（重复投递已拦下，未重复建单）',
          '超大结果 ' + (st.oversize || 0) + ' 次',
          st.lastClose ? '上次断开 code=' + st.lastClose.code + (st.lastClose.reason ? ' reason=' + st.lastClose.reason : '') + ' @ ' + new Date(st.lastClose.at).toLocaleTimeString() : '',
          last ? '最近调用 ' + last.name + ' ' + (last.bytes / 1024).toFixed(1) + 'KB ' + last.ms + 'ms ' + (last.delivered ? '已回包' : '回包丢弃') + (last.replayed ? ' · 幂等回放' : '') : '',
        ].filter(Boolean).join('\\n')) + '">调用 ' + (st.calls || 0) + ' · 丢弃 ' + (st.dropped || 0) + ' · 幂等 ' + (st.replays || 0) + '</span>'
      : '';
    return '<div class="xz-row"><span class="xz-dot ' + dotCls + '"></span>' +
      '<span class="xz-name">' + esc(x.name || '未命名接入点') + '</span>' +
      '<span class="xz-ep" title="' + esc(x.endpoint) + '">' + esc(x.endpoint) + '</span>' + badge + diag +
      "<button class='btn' data-xz-op='toggle' data-xz-id='" + esc(x.id) + "' data-xz='" + esc(JSON.stringify(x)) + "' style='white-space:nowrap'>" + (x.enabled ? '停用' : '启用') + '</button>' +
      "<button class='btn danger' data-xz-op='del' data-xz-id='" + esc(x.id) + "' style='white-space:nowrap'>删除</button>" +
      '</div>';
  }).join('');
  el.innerHTML = html;
  el.querySelectorAll('[data-xz-op]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const op = btn.dataset.xzOp;
      if (op === 'toggle') {
        const x = JSON.parse(btn.dataset.xz);
        const rr = await api('/xiaozhi/endpoints', { method: 'POST', body: JSON.stringify({ id: x.id, name: x.name, endpoint: x.endpoint, enabled: !x.enabled }) });
        if (rr.ok) toast(x.enabled ? '✓ 已停用' : '✓ 已启用'); else toast(rr.error || '操作失败', true);
      } else if (op === 'del') {
        if (!confirm('删除该接入点？')) return;
        const rr = await api('/xiaozhi/endpoints/' + encodeURIComponent(btn.dataset.xzId), { method: 'DELETE' });
        if (rr.ok) toast('✓ 已删除'); else toast(rr.error || '删除失败', true);
      }
      loadXzList();
    });
  });
}
function xzOpenForm(existing) {
  const isEdit = Boolean(existing);
  openModal(isEdit ? '编辑接入点' : '添加小智接入点',
    '<div class="field" style="margin-bottom:10px"><label>名称（可选）</label><input id="xz-f-name" placeholder="例：客厅小智" value="' + esc(existing && existing.name || '') + '"></div>' +
    '<div class="field"><label>MCP 接入点（ws:// 或 wss://，小智平台「MCP 插件」页可查）</label>' +
    '<input id="xz-f-ep" style="font-family:var(--mono)" placeholder="wss://api.xiaozhi.me/mcp/?token=…" value="' + esc(existing && existing.endpoint || '') + '"></div>');
  $('modal-foot').innerHTML = '<button class="btn" onclick="closeModal()">取消</button><button class="btn pri" id="xz-f-save">保存并连接</button>';
  $('xz-f-save').addEventListener('click', async () => {
    const body = {
      id: existing && existing.id,
      name: $('xz-f-name').value.trim(),
      endpoint: $('xz-f-ep').value.trim(),
      enabled: existing ? existing.enabled !== false : true,
    };
    if (!body.endpoint) { toast('请填写接入点地址', true); return; }
    const r = await api('/xiaozhi/endpoints', { method: 'POST', body: JSON.stringify(body) });
    if (!r.ok) { toast(r.error || '保存失败', true); return; }
    closeModal();
    toast('✓ 已保存，正在连接小智平台');
    loadXzList();
  });
}

// ---------- 项目 ----------
async function loadProjects() {
  const r = await api('/projects');
  state.projects = r.ok ? (r.data || []) : [];
}

function renderProjects() {
  const grid = $('proj-grid');
  if (document.getElementById('btn-proj-new') && !document.getElementById('btn-proj-new')._wired) {
    document.getElementById('btn-proj-new')._wired = true;
    document.getElementById('btn-proj-new').addEventListener('click', function () { openProjectDrawer(null); });
  }
  if (!state.projects.length) {
    grid.innerHTML = '<div class="mon-empty">还没有项目 —— 点右上角「＋ 新建项目」创建。项目把节点、工作区、指令、连接器、技能捆绑成一个可复用的工作上下文。</div>';
    return;
  }
  grid.innerHTML = state.projects.map(function (p) {
    var taskCount = state.tasks.filter(function (t) { return t.projectId === p.id; }).length;
    var chips = [
      p.expertIds.length ? p.expertIds.map(function (id) { var a = state.agents.find(function (x) { return x.id === id; }); return a ? a.name : id; }).join(' · ') : '',
      p.skillNames.length ? p.skillNames.length + ' 技能' : '',
      p.connectorIds.length ? p.connectorIds.length + ' 连接器' : ''
    ].filter(Boolean).join(' ｜ ');
    return '<div class="proj-card" data-proj="' + esc(p.id) + '">' +
      '<div class="pj-name">' + esc(p.name) + '</div>' +
      '<div class="pj-meta">🖥 ' + esc(p.nodeTitle) + (p.workspace ? ' · 📁 ' + esc(p.workspace) : '') + ' · 📋 ' + taskCount + ' 个任务</div>' +
      (p.instructionPreview ? '<div class="pj-ins">' + esc(p.instructionPreview) + '</div>' : '') +
      '<div class="pj-chips"><span class="tag">' + chips + '</span></div>' +
      '<div class="ops" style="display:flex;gap:8px;margin-top:10px">' +
      '<button class="mini-btn pj-enter">🚀 进入工作台</button>' +
      '<button class="mini-btn pj-edit">⚙ 编辑</button>' +
      '<button class="mini-btn pj-del">🗑 删除</button></div>' +
      '</div>';
  }).join('');
  grid.querySelectorAll('.proj-card').forEach(function (card) {
    var pid = card.dataset.proj;
    card.querySelector('.pj-enter').addEventListener('click', function () { enterProject(pid); });
    card.querySelector('.pj-edit').addEventListener('click', function () { openProjectDrawer(pid); });
    card.querySelector('.pj-del').addEventListener('click', async function () {
      if (!confirm('删除项目「' + (state.projects.find(function (x) { return x.id === pid; }) || {}).name + '」？项目下的任务不会被删除。')) return;
      const r = await api('/projects/' + encodeURIComponent(pid), { method: 'DELETE' });
      if (r.ok) { toast('✓ 项目已删除'); if (state.projectId === pid) exitProject(); loadProjects(); renderProjects(); }
      else toast(r.error || '删除失败', true);
    });
  });
}

// 通用模态按钮助手（openModal 只支持静态 footer，这里手动绑定）
// bindModalActions 已移除：openModal 原生支持自定义 footer 按钮

async function enterProject(projectId) {
  const p = state.projects.find((x) => x.id === projectId);
  if (!p) { toast('项目不存在', true); return; }
  state.projectId = projectId;
  state.currentTaskId = null;
  state.taskCache.clear();
  await loadTasks();
  switchView('work');
  updateProjectBanner();
  toast('已进入项目「' + p.name + '」');
}

function exitProject() {
  state.projectId = null;
  state.currentTaskId = null;
  loadTasks();
  renderTaskList();
  updateProjectBanner();
  const picker = document.getElementById('main-agent-picker');
  if (picker) picker.style.display = '';
}

function updateProjectBanner() {
  var el = document.getElementById('pj-banner');
  const p = state.projectId ? state.projects.find((x) => x.id === state.projectId) : null;
  if (!p) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'pj-banner';
    el.className = 'pj-banner';
    const head = document.querySelector('.chat-head');
    head.insertAdjacentElement('afterend', el);
  }
  el.innerHTML = '📦 项目工作台：<b>' + esc(p.name || p.id) + '</b>' +
    '<span style="color:var(--tx3)">（任务自动继承项目节点 / 工作区 / 指令 / 连接器 / 技能）</span>' +
    '<span style="flex:1"></span>' +
    '<button class="mini-btn" id="pj-cfg">⚙ 项目配置</button>' +
    '<button class="mini-btn" id="pj-exit">退出项目</button>';
  document.getElementById('pj-exit').addEventListener('click', function () { exitProject(); });
  document.getElementById('pj-cfg').addEventListener('click', function () { openProjectDrawer(p.id); });
  // 项目工作台隐藏全局默认智能体切换器（项目任务默认成员来自项目，临时切换用 🎛 运行配置）
  const picker = document.getElementById('main-agent-picker');
  if (picker) picker.style.display = 'none';
}

async function openProjectDrawer(projectId) {
  const p = state.projects.find(function (x) { return x.id === projectId; });
  const isEdit = Boolean(p);
  if (!state.agents.length) await loadAgents();
  // 浏览/技能采样用的智能体：优先项目首位子智能体（其所在节点即项目节点）
  const browseAgentId = (p && p.expertIds && p.expertIds[0]) || (state.agents[0] && state.agents[0].id) || '';
  const nodeOptions = [];
  for (const r of state.resources) {
    if (r.kind === 'dsh' && r.mappingId) nodeOptions.push({ label: (r.title || r.appName || r.note || r.mappingId), ref: { kind: 'mapping', mappingId: r.mappingId } });
  }
  for (const a of state.agents) {
    if (a.dshRef && a.dshRef.kind === 'direct' && a.dshRef.apiBaseUrl) {
      nodeOptions.push({ label: (a.name + '（直连）'), ref: { kind: 'direct', apiBaseUrl: a.dshRef.apiBaseUrl } });
    }
  }
  // 节点已装技能（供项目技能勾选）
  let nodeSkills = [];
  if (browseAgentId) {
    const sr = await api('/agents/' + browseAgentId + '/skills');
    if (sr.ok) nodeSkills = ((sr.data || {}).skills || []).map(function (x) { return x.name; });
  }
  // 连接器候选：SSH 连接器池 + ONENAT HTTP/映射连接器
  const conns = [];
  try {
    const sr = await api('/ssh-resources');
    for (const x of (sr.data || [])) conns.push({ id: 'ssh:' + x.id, label: '🖥 ' + x.name + '（' + x.host + '）' });
  } catch (e) { /* ignore */ }
  for (const r of state.resources) {
    if (r.kind !== 'dsh' && r.mappingId) conns.push({ id: 'map:' + r.mappingId, label: '🌐 ' + (r.appName || r.note || r.mappingId) });
  }
  const sel = new Set(p ? p.skillNames || [] : []);
  const connSel = new Set(p ? p.connectorIds || [] : []);
  const nodeJson = p ? JSON.stringify(p.dshRef || {}) : '';
  openModal(isEdit ? '项目配置 · ' + p.name : '新建项目',
    '<div class="field" style="margin-bottom:10px"><label>项目名称</label><input id="pj-f-name" value="' + esc(p ? p.name : '') + '" placeholder="例：KB 平台交付"></div>' +
    '<div class="field" style="margin-bottom:10px"><label>DSH 节点</label><select id="pj-f-node" class="cfg-sel">' +
    nodeOptions.map(function (n) {
      const sel = nodeJson === JSON.stringify(n.ref) ? ' selected' : '';
      return '<option value="' + esc(JSON.stringify(n.ref)) + '"' + sel + '>' + esc(n.label) + '</option>';
    }).join('') +
    '</select></div>' +
    '<div class="field" style="margin-bottom:10px"><label>项目工作目录（从节点浏览选择，会话 cwd 与工作区）</label>' +
    '<div style="display:flex;gap:8px;align-items:center"><input id="pj-f-ws" style="font-family:var(--mono);flex:1" value="' + esc(p ? p.workspace || '' : '') + '" placeholder="/workspace/project">' +
    '<button class="mini-btn" id="pj-f-browse" style="padding:10px 14px;white-space:nowrap">📁 浏览节点目录</button></div></div>' +
    '<div class="field" style="margin-bottom:10px"><label>项目指令（注入每次任务，角色/阶段/规范）</label><textarea id="pj-f-ins" rows="6" style="font-family:var(--mono);font-size:12px" placeholder="# 角色\\n你是一个…助手…">' + esc(p ? p.instruction || '' : '') + '</textarea></div>' +
    '<div class="field" style="margin-bottom:10px"><label>项目子智能体（勾选 = 项目内任务默认成员）</label><div class="pj-checks">' +
    state.agents.map(function (a) {
      const on = p && (p.expertIds || []).indexOf(a.id) >= 0;
      return '<label><input type="checkbox" class="pj-exp" value="' + esc(a.id) + '"' + (on ? ' checked' : '') + '> ' + esc(a.name) + '</label>';
    }).join('') +
    '</div></div>' +
    '<div class="field" style="margin-bottom:10px"><label>项目连接器（勾选后项目任务可用）</label><div class="pj-checks">' +
    (conns.length ? conns.map(function (c) {
      const on = connSel.has(c.id);
      return '<label><input type="checkbox" class="pj-conn" value="' + esc(c.id) + '"' + (on ? ' checked' : '') + '> ' + esc(c.label) + '</label>';
    }).join('') : '<div class="mon-empty">暂无候选连接器（SSH 池 / ONENAT 资源目录为空）</div>') +
    '</div></div>' +
    '<div class="field"><label>项目技能（勾选后派发时以 /名 手势加载）</label><div class="pj-checks">' +
    (nodeSkills.length ? nodeSkills.map(function (n) {
      const on = sel.has(n);
      return '<label><input type="checkbox" class="pj-skill" value="' + esc(n) + '"' + (on ? ' checked' : '') + '> ' + esc(n) + '</label>';
    }).join('') : '<div class="mon-empty">该节点暂无已装技能（或采样智能体不可达）</div>') +
    '</div></div>',
    [
      { label: '取消', cls: '', act: function () { closeModal(); } },
      { label: isEdit ? '保存配置' : '创建项目', cls: 'pri', act: async function () {
        const name = document.getElementById('pj-f-name').value.trim();
        if (!name) { toast('请填写项目名称', true); return; }
        let dshRef;
        try { dshRef = JSON.parse(document.getElementById('pj-f-node').value); } catch (e) { toast('节点无效', true); return; }
        const body = {
          id: isEdit ? p.id : undefined,
          name,
          dshRef,
          workspace: document.getElementById('pj-f-ws').value.trim(),
          instruction: document.getElementById('pj-f-ins').value,
          expertIds: Array.from(document.querySelectorAll('.pj-exp:checked')).map(function (x) { return x.value; }),
          connectorIds: Array.from(document.querySelectorAll('.pj-conn:checked')).map(function (x) { return x.value; }),
          skillNames: Array.from(document.querySelectorAll('.pj-skill:checked')).map(function (x) { return x.value; }),
        };
        const r = await api('/projects' + (isEdit ? '/' + p.id : ''), { method: isEdit ? 'PATCH' : 'POST', body: JSON.stringify(body) });
        if (!r.ok) { toast(r.error || '保存失败', true); return; }
        await loadProjects();
        closeModal();
        toast('✓ 项目已保存');
        renderProjects();
        if (isEdit && state.projectId === p.id) updateProjectBanner();
      } },
    ]);
}

// ---------- 单独任务环境（节点/连接器/技能） ----------
// ---------- 运行配置（统一弹层：专家/节点/连接器/技能/模型，按作用域感知） ----------
if (document.getElementById('btn-run-config')) {
  document.getElementById('btn-run-config').addEventListener('click', function () { openRunConfig('top'); });
}

/** 打开运行配置弹层。focus: 'expert' 时滚动定位到执行专家分区 */
async function openRunConfig(focus) {
  const proj = state.projectId ? state.projects.find(function (x) { return x.id === state.projectId; }) : null;
  const isProject = Boolean(proj);
  const inProject = isProject && state.projectId === proj.id; // 恒真，占位便于阅读
  // 采样智能体：项目首位专家 / 全局默认 / 第一个智能体（用于拉取节点技能清单）
  const sampleAgentId = (proj && proj.expertIds[0]) || (state.agents[0] && state.agents[0].id) || '';
  // 连接器候选
  const conns = [];
  try {
    const sr = await api('/ssh-resources');
    for (const x of (sr.data || [])) conns.push({ id: 'ssh:' + x.id, label: '🖥 ' + x.name + '（' + x.host + '）' });
  } catch (e) { /* ignore */ }
  for (const r of state.resources) {
    if (r.kind !== 'dsh' && r.mappingId) conns.push({ id: 'map:' + r.mappingId, label: '🌐 ' + (r.appName || r.note || r.mappingId) });
  }
  // 节点已装技能
  let nodeSkills = [];
  if (sampleAgentId) {
    const sr = await api('/agents/' + sampleAgentId + '/skills');
    if (sr.ok) nodeSkills = ((sr.data || {}).skills || []).map(function (x) { return x.name; });
  }
  const curTask = state.currentTaskId ? state.tasks.find(function (t) { return t.id === state.currentTaskId; }) : null;
  const curMember = curTask && curTask.memberAgentIds.length === 1 ? curTask.memberAgentIds[0] : null;
  const mainName = (mainAgentState && mainAgentState.resolvedAgentName) || mainAgentState.cur || '自动';

  const expertSection = isProject
    ? (curTask
        ? '<div class="field"><div class="pj-checks" id="rc-experts">' +
          state.agents.map(function (a) {
            const on = curMember ? a.id === curMember : (proj.expertIds || []).indexOf(a.id) >= 0;
            return '<label><input type="radio" name="rc-expert" value="' + esc(a.id) + '"' + (on ? ' checked' : '') + '> ' + esc(a.name) + '</label>';
          }).join('') + '</div>' +
          '<div class="hint">仅影响当前任务后续消息；改全局默认用上方「默认智能体」按钮</div></div>'
        : '<div class="hint">项目配套专家：' + esc((proj.expertIds || []).map(function (id) { var a = state.agents.find(function (x) { return x.id === id; }); return a ? a.name : id; }).join('、') || '未配置') + '（发起任务后可临时切换）</div>')
    : '<div class="hint">全局默认智能体：' + esc(mainName) + '（在右上角按钮或设置页修改）</div>';

  const nodeSection = isProject
    ? '<div class="hint">🔒 项目节点：' + esc(proj.nodeTitle || '') + ' · 工作区：' + esc(proj.workspace || '(默认)') + ' —— 修改请点项目横幅「⚙ 项目配置」</div>'
    : '<div class="field"><label>执行节点（DSH，仅对新任务生效）</label><select id="rc-node" class="cfg-sel"><option value="">（默认：主智能体节点）</option>' +
      state.resources.filter(function (r) { return r.kind === 'dsh' && r.mappingId; }).map(function (r) {
        const sel = state.taskEnv.nodeRef && state.taskEnv.nodeRef.mappingId === r.mappingId ? ' selected' : '';
        return '<option value="' + esc(r.mappingId) + '"' + sel + '>' + esc(r.note || r.appName || r.mappingId) + '</option>';
      }).join('') + '</select></div>';

  const connSection = isProject
    ? '<div class="pj-chips">' + ((proj.connectorIds || []).map(function (cid) { return '<span class="tag">' + esc(cid) + '</span>'; }).join(' ') || '<span class="sub">未绑定</span>') + '</div><div class="hint">修改请点项目横幅「⚙ 项目配置」</div>'
    : '<div class="pj-checks">' + (conns.length ? conns.map(function (c) {
        const on = state.taskEnv.connectorIds.indexOf(c.id) >= 0;
        return '<label><input type="checkbox" class="rc-conn" value="' + esc(c.id) + '"' + (on ? ' checked' : '') + '> ' + esc(c.label) + '</label>';
      }).join('') : '<div class="mon-empty">暂无候选连接器</div>') + '</div>';

  const skillSection = isProject
    ? '<div class="pj-chips">' + ((proj.skillNames || []).map(function (n) { return '<span class="tag">/' + esc(n) + '</span>'; }).join(' ') || '<span class="sub">未配置</span>') + '</div><div class="hint">修改请点项目横幅「⚙ 项目配置」</div>'
    : '<div class="field"><label>技能（逗号分隔，/名 手势加载，仅对新任务生效）</label><input id="rc-skills" style="font-family:var(--mono)" value="' + esc((state.taskEnv.skillNames || []).join(',')) + '" placeholder="lark-cli, kb-log"></div>';

  const modelSection = '<div class="hint">当前主调度模型：<b>' + esc((state.settings && state.settings.planner && state.settings.planner.model) || '默认模型') + '</b> —— 切换用输入区下方模型按钮（全局生效，含项目任务）</div>';

  const bodyHtml =
    '<div class="rc-section" id="rc-sec-expert"><b>① 执行专家</b>' + expertSection + '</div>' +
    '<div class="rc-section"><b>② 执行节点 与 工作区</b>' + nodeSection + '</div>' +
    '<div class="rc-section"><b>③ 连接器 / 技能</b>' + connSection + skillSection + '</div>' +
    '<div class="rc-section"><b>④ 模型</b>' + modelSection + '</div>';

  const actions = [];
  // 单独任务：保存节点/连接器/技能到新任务环境
  if (!isProject) {
    actions.push({ label: '保存为新任务环境', cls: 'pri', act: function () {
      const node = document.getElementById('rc-node');
      state.taskEnv.nodeRef = node && node.value ? { kind: 'mapping', mappingId: node.value } : null;
      state.taskEnv.connectorIds = Array.prototype.map.call(document.querySelectorAll('.rc-conn:checked'), function (x) { return x.value; });
      state.taskEnv.skillNames = (document.getElementById('rc-skills') || { value: '' }).value.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
      closeModal();
      toast('✓ 运行配置已保存（作用于新任务）');
    } });
  }
  // 项目任务：保存临时专家切换
  if (isProject && curTask && curMember !== null) {
    actions.push({ label: '保存专家切换（仅当前任务）', cls: 'pri', act: async function () {
      const sel = document.querySelector('input[name="rc-expert"]:checked');
      if (!sel) { toast('请选择专家', true); return; }
      const r = await api('/tasks/' + curTask.id, { method: 'PATCH', body: JSON.stringify({ memberAgentIds: [sel.value] }) });
      if (!r.ok) { toast(r.error || '切换失败', true); return; }
      await loadTasks();
      closeModal();
      toast('✓ 当前任务专家已切换');
    } });
  }
  actions.push({ label: '关闭', cls: '', act: function () { closeModal(); } });

  openModal('🎛 运行配置' + (isProject ? ' · ' + proj.name : ''), bodyHtml, actions);
  if (focus === 'expert') { const el = document.getElementById('rc-sec-expert'); if (el) el.scrollIntoView(); }
}

// ---------- 导航 ----------
document.querySelectorAll('#nav button').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.v));
});
${AUTH_ENABLED ? `var logoutBtn = document.getElementById('logout-btn');
if (logoutBtn) logoutBtn.addEventListener('click', doLogout);` : ''}var currentView = 'work';
function switchView(v) {
  if (!document.getElementById('view-' + v)) return;
  currentView = v;
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  document.querySelectorAll('.view').forEach(x => x.classList.toggle('on', x.id === 'view-' + v));
  if (v === 'files') renderFilesView();
  if (v === 'resources') renderResources();
  if (v === 'agents') renderAgents();
  if (v === 'schedules') renderSchedules();
  if (v === 'settings') renderSettings();
  if (v === 'voice') voiceStart(); else voiceStop();
  if (v === 'monitor') monitorStart(); else monitorStop();
  if (v === 'projects') renderProjects();
  // 当前页签写入 hash：刷新/分享链接都停留在原页签（replaceState 不产生历史噪音）
  var h = '#' + v;
  if (location.hash !== h) { try { history.replaceState(null, '', h); } catch (e) { location.hash = h; } }
}
window.addEventListener('hashchange', () => {
  var v = (location.hash || '').replace('#', '') || 'work';
  if (v !== currentView && document.getElementById('view-' + v)) switchView(v);
});

// ---------- 移动端侧栏抽屉开关 ----------
function isMobile() { return window.innerWidth <= 768; }
function closeSidebar() { $('view-work').classList.remove('side-open'); }
function openSidebar() { $('view-work').classList.add('side-open'); }
if ($('btn-side-toggle')) {
  $('btn-side-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    $('view-work').classList.toggle('side-open');
  });
}
if ($('side-backdrop')) {
  $('side-backdrop').addEventListener('click', () => closeSidebar());
}
// 选中会话后自动收起手机端侧栏
document.addEventListener('click', (e) => {
  if (isMobile() && e.target.closest('.task-item')) closeSidebar();
});
// 窗口从手机切回桌面时清理抽屉状态
window.addEventListener('resize', () => { if (!isMobile()) closeSidebar(); });

// 手机端软键盘处理：输入框聚焦时给 body 加 kb-open（CSS 隐藏底部 Tab 栏，
// 空间让给消息区）；键盘收起后若消息区原本贴底则跟随到底，避免停在半空。
if ($('input')) {
  const kbInput = $('input');
  kbInput.addEventListener('focus', () => { if (isMobile()) document.body.classList.add('kb-open'); });
  kbInput.addEventListener('blur', () => {
    document.body.classList.remove('kb-open');
    const cs = $('chat-scroll');
    if (cs && cs.scrollHeight - cs.scrollTop - cs.clientHeight < 160) cs.scrollTop = cs.scrollHeight;
  });
}
// 触屏上点击发送/附件/停止/回到底部时不让输入框失焦（软键盘保持展开）
['btn-send', 'btn-attach', 'btn-stop', 'btn-jump-bottom'].forEach((bid) => {
  const el = $(bid); if (!el) return;
  el.addEventListener('mousedown', (e) => e.preventDefault());
});

// 手机端底部 Tab 使用短标签（桌面保持全称）
const NAV_LABELS = {
  work: { full: '工作台', short: '工作台' },
  projects: { full: '项目', short: '项目' },
  monitor: { full: '监控大屏', short: '监控' },
  files: { full: '文件管理', short: '文件' },
  agents: { full: '子智能体', short: '子智能体' },
  schedules: { full: '定时任务', short: '定时' },
  voice: { full: '语音助手', short: '语音' },
  resources: { full: '资源目录', short: '资源' },
  settings: { full: '设置', short: '设置' },
};
function applyNavLabels() {
  const short = isMobile();
  document.querySelectorAll('#nav button').forEach(b => {
    const lb = b.querySelector('.lb');
    const cfg = NAV_LABELS[b.dataset.v];
    if (lb && cfg) lb.textContent = short ? cfg.short : cfg.full;
  });
  // 手机端品牌名缩短，避免顶部截断成 "OneNat W…"
  const bt = $('brand-title');
  if (bt) bt.textContent = short ? 'WorkBuddy' : 'OneNat WorkBuddy';
}
window.addEventListener('resize', applyNavLabels);
applyNavLabels();

// ---------- 初始化引导 ----------
async function boot() {
  initMentionPopup();
  document.querySelectorAll('.qe-card[data-qe]').forEach((card) => {
    card.addEventListener('click', () => switchView(card.dataset.qe));
  });
  await Promise.all([loadResources(), loadAgents(), loadTasks(), loadSettings(), loadSchedules(), loadPlannerOptions(), loadProjects()]);
  await refreshMentionCandidates();
  renderTaskList();
  // 按 hash 恢复刷新前的页签（#monitor / #voice / #settings …），无 hash 停在工作台
  var initial = (location.hash || '').replace('#', '');
  if (initial && document.getElementById('view-' + initial)) switchView(initial);
  setInterval(loadTasksQuiet, 4000);
  // ONENAT 状态自愈：资源目录未加载成功时每 8s 重试（覆盖启动瞬间网络抖动/服务重启窗口），成功或超 2 分钟后停止
  const heal = setInterval(async () => {
    if (state.resources.length) { clearInterval(heal); return; }
    await Promise.all([loadResources(), loadAgents(), loadTasks(), loadPlannerOptions()]);
  }, 8000);
  setTimeout(() => clearInterval(heal), 120000);
}
async function loadResources() {
  const r = await api('/resources');
  if (r.ok) {
    state.resources = r.data.endpoints || [];
    const dshCount = state.resources.filter(x => x.kind === 'dsh').length;
    $('onenat-dot').className = 'dot ok';
    $('onenat-text').textContent = 'ONENAT · ' + state.resources.length + ' 资源 / ' + dshCount + ' DSH 节点';
  } else {
    state.resources = [];
    $('onenat-dot').className = 'dot';
    const errMsg = r.error || '';
    // 会话过期（服务重启后内存会话清空）≠ ONENAT 连接故障，避免误导
    if (errMsg.indexOf('登录') >= 0 || errMsg.indexOf('会话') >= 0) {
      $('onenat-text').textContent = 'ONENAT · 会话已过期，请重新登录';
    } else {
      $('onenat-text').textContent = 'ONENAT 未连接: ' + errMsg.slice(0, 60);
    }
  }
}
async function loadAgents() {
  const r = await api('/agents');
  if (r.ok) {
    state.agents = Array.isArray(r.data) ? r.data : [];
    if (mainAgentState.loaded) renderMainAgentPop();
  }
}
async function loadTasks() {
  const r = await api('/tasks');
  if (r.ok) {
    state.tasks = Array.isArray(r.data) ? r.data : [];
    renderTaskList();
  }
}
let quietTimer = null, quietBusy = false, quietLast = 0;
async function loadTasksQuiet() {
  const now = Date.now();
  if (quietBusy) return;
  if (now - quietLast < 2500) {
    if (!quietTimer) quietTimer = setTimeout(() => { quietTimer = null; loadTasksQuiet(); }, 2500 - (now - quietLast));
    return;
  }
  quietLast = now; quietBusy = true;
  try {
    const cur = state.currentTaskId;
    const r = await api('/tasks');
    if (r.ok) {
      state.tasks = Array.isArray(r.data) ? r.data : [];
      renderTaskList();
      if (cur) refreshChatHead();
    }
  } finally { quietBusy = false; }
}
async function loadSettings() {
  const r = await api('/settings');
  if (r.ok) state.settings = r.data;
}

// ---------- 会话列表管理（按时间分组 + 搜索过滤 + 即时切换） ----------
$('side-search').addEventListener('input', (e) => {
  state.searchQuery = e.target.value.trim().toLowerCase();
  $('side-search-clear').style.display = state.searchQuery ? 'block' : 'none';
  renderTaskList();
});
$('side-search-clear').addEventListener('click', () => {
  $('side-search').value = '';
  state.searchQuery = '';
  $('side-search-clear').style.display = 'none';
  renderTaskList();
});

function renderTaskList() {
  // 项目工作台模式：只显示本项目任务
  var visibleTasks = state.projectId ? state.tasks.filter(function (t) { return t.projectId === state.projectId; }) : state.tasks;
  const el = $('task-list');
  el.innerHTML = '';
  if (!visibleTasks.length) {
    el.innerHTML = state.projectId
      ? '<div style="color:var(--tx3);font-size:12.5px;padding:16px 12px;text-align:center">本项目还没有任务，点击上方「＋ 新建任务」发起。</div>'
      : '<div style="color:var(--tx3);font-size:12.5px;padding:16px 12px;text-align:center">还没有任务，点击上方「新建任务」发起第一个会话。</div>';
    return;
  }

  // 搜索过滤（在项目可见集内过滤）
  const q = state.searchQuery;
  const filtered = q
    ? visibleTasks.filter(t => (t.title && t.title.toLowerCase().includes(q)) || (t.lastPreview && t.lastPreview.toLowerCase().includes(q)))
    : visibleTasks;

  if (q && !filtered.length) {
    el.innerHTML = '<div style="color:var(--tx3);font-size:12px;padding:16px 12px;text-align:center">未找到匹配的会话</div>';
    return;
  }

  // 时间维度分组：今天 / 前7天 / 更早 / 已归档
  const now = Date.now();
  const ONE_DAY = 24 * 3600 * 1000;
  const SEVEN_DAYS = 7 * ONE_DAY;

  const groups = {
    today: { title: '今天', items: [] },
    week: { title: '前 7 天', items: [] },
    older: { title: '更早', items: [] },
    archived: { title: '已归档会话', items: [] },
  };

  for (const t of filtered) {
    if (t.archivedAt) {
      groups.archived.items.push(t);
      continue;
    }
    const tTime = t.updatedAt || t.createdAt || now;
    const diff = now - tTime;
    if (diff < ONE_DAY) groups.today.items.push(t);
    else if (diff < SEVEN_DAYS) groups.week.items.push(t);
    else groups.older.items.push(t);
  }

  for (const [key, grp] of Object.entries(groups)) {
    if (!grp.items.length) continue;
    const isCollapsed = state.groupCollapsed[key] ?? (key === 'archived');
    const grpDiv = document.createElement('div');
    grpDiv.style.marginBottom = '6px';

    const head = document.createElement('div');
    head.className = 'group-header';
    head.innerHTML = '<span class="gh-left"><span class="gh-chev">' + (isCollapsed ? '▸' : '▾') + '</span><span>' + esc(grp.title) + '</span></span><span class="gh-cnt">' + grp.items.length + '</span>';
    head.addEventListener('click', () => {
      state.groupCollapsed[key] = !isCollapsed;
      renderTaskList();
    });
    grpDiv.appendChild(head);

    const body = document.createElement('div');
    body.className = 'group-body' + (isCollapsed ? ' collapsed' : '');
    for (const t of grp.items) {
      body.appendChild(createTaskItemElement(t, key === 'archived'));
    }
    grpDiv.appendChild(body);
    el.appendChild(grpDiv);
  }
}

function createTaskItemElement(t, archived) {
  const div = document.createElement('div');
  const isSelected = t.id === state.currentTaskId;
  div.className = 'task-item' + (isSelected ? ' on' : '') + (archived ? ' archived' : '');
  div.title = (archived ? '已归档 · ' : '') + t.title + (t.lastPreview ? '\\n最新: ' + t.lastPreview : '');


  const memberNames = (t.memberAgentIds || []).map(id => {
    const a = state.agents.find(x => x.id === id);
    return a ? a.name : id;
  }).join('、');

  const subText = t.lastPreview ? esc(t.lastPreview) : (memberNames ? '成员: ' + esc(memberNames) : fmtTime(t.updatedAt || t.createdAt));

  div.innerHTML =
    '<div class="row-top">' +
    '<span class="s ' + statusColor(t.running ? 'running' : t.status) + '"></span>' +
    '<span class="t">' + esc(t.title) + '</span>' +
    '</div>' +
    '<div class="row-sub">' + subText + '</div>' +
    '<span class="acts">' +
    '<button data-a="rename" title="重命名">✏️</button>' +
    (archived ? '<button data-a="toggle-archive" title="取消归档">↩️</button>' : '<button data-a="toggle-archive" title="归档">🗄️</button>') +
    '<button data-a="delete" title="删除" style="color:var(--err)">🗑️</button>' +
    '</span>';

  div.addEventListener('click', () => openTask(t.id));
  div.querySelector('[data-a=rename]').addEventListener('click', (e) => { e.stopPropagation(); promptRenameTask(t); });
  div.querySelector('[data-a=toggle-archive]').addEventListener('click', async (e) => {
    e.stopPropagation();
    const want = !archived;
    const r = await api('/tasks/' + t.id + '/archive', { method: 'POST', body: JSON.stringify({ archived: want }) });
    if (r.ok) {
      toast(want ? '🗄️ 已归档' : '↩️ 已恢复到列表');
      t.archivedAt = want ? Date.now() : undefined;
      renderTaskList();
      loadTasksQuiet();
    } else toast(r.error || '操作失败', true);
  });
  div.querySelector('[data-a=delete]').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('确定删除会话「' + t.title + '」？')) return;
    await api('/tasks/' + t.id, { method: 'DELETE' });
    state.taskCache.delete(t.id);
    if (state.currentTaskId === t.id) {
      state.currentTaskId = null;
      disconnectStream();
      resetChatView();
    }
    toast('已删除');
    loadTasks();
  });
  return div;
}

function promptRenameTask(t) {
  openModal('重命名会话',
    '<input id="rn-input" style="width:100%;background:var(--bg3);border:1px solid var(--line2);border-radius:8px;padding:8px 10px;color:var(--tx);font-size:13px" value="' + esc(t.title) + '" maxlength="80">' +
    '<div style="margin-top:14px;display:flex;justify-content:flex-end;gap:8px"><button class="mini-btn" id="rn-cancel">取消</button><button class="btn pri" id="rn-ok">保存</button></div>');
  const input = $('rn-input'); input.focus(); input.select();
  const doSave = async () => {
    const title = input.value.trim();
    if (!title) { toast('标题不能为空', true); return; }
    const r = await api('/tasks/' + t.id + '/rename', { method: 'POST', body: JSON.stringify({ title }) });
    if (r.ok) {
      closeModal();
      t.title = title;
      const cached = state.taskCache.get(t.id);
      if (cached) cached.title = title;
      renderTaskList();
      if (state.currentTaskId === t.id) $('chat-title').textContent = title;
      toast('✓ 已重命名');
    } else toast(r.error || '重命名失败', true);
  };
  $('rn-ok').addEventListener('click', doSave);
  $('rn-cancel').addEventListener('click', closeModal);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSave(); });
}

// ---------- 对话回话交互（0ms 内存缓存瞬时呈现 + 分批渲染 + RAF 调度） ----------
let openTaskSeq = 0;

async function openTask(taskId) {
  if (state.currentTaskId === taskId && state.taskCache.has(taskId)) {
    return; // 已在当前会话
  }

  const isSwitching = state.currentTaskId !== taskId;
  state.currentTaskId = taskId;
  const seq = ++openTaskSeq;
  disconnectStream();
  renderTaskList();

  // 1. 0ms 瞬时呈现：优先检查 Client-Side TaskCache 缓存
  const cachedTask = state.taskCache.get(taskId);
  const taskSummary = state.tasks.find(t => t.id === taskId);

  if (cachedTask) {
    // 立即秒开渲染内存数据
    applyTaskToView(cachedTask, false);
    connectStream(taskId);
  } else if (taskSummary) {
    // 乐观换壳（标题、按钮状态、骨架屏），绝不卡顿
    const ce = $('chat-empty'); if (ce) ce.style.display = 'none';
    if ($('chat-title')) $('chat-title').textContent = taskSummary.title || '加载中…';
    if ($('btn-add-member')) $('btn-add-member').style.display = '';
    if ($('btn-rename-task')) $('btn-rename-task').style.display = '';
    setSending(!!(taskSummary.running || taskSummary.status === 'running'));
    const scroll = $('chat-scroll');
    if (scroll) scroll.innerHTML = '<div class="chat-loading"><span>⏳</span><span>正在加载会话内容…</span></div>';
  }

  // 2. 后台发起异步同步，更新缓存并增量/静默渲染
  const r = await api('/tasks/' + taskId);
  if (seq !== openTaskSeq || state.currentTaskId !== taskId) return; // 已切到别的会话，丢弃旧响应
  if (!r.ok) {
    toast(r.error || '加载会话失败', true);
    return;
  }

  const freshTask = r.data;
  state.taskCache.set(taskId, freshTask);
  applyTaskToView(freshTask, !cachedTask);
  connectStream(taskId);
  startTaskStatsPolling();
  startTaskTodosPolling();
  ensureSkillList(); // "/" 技能候选预热（对齐 harness warm 钩子：打开会话即拉目录）
}

/** 将任务数据渲染到对话视图（支持高性能批量/分块装配） */
function applyTaskToView(task, isInitialRender) {
  const ce = $('chat-empty'); if (ce) ce.style.display = 'none';
  if ($('chat-title')) $('chat-title').textContent = task.title || '未命名任务';
  if ($('btn-add-member')) $('btn-add-member').style.display = '';
  if ($('btn-rename-task')) $('btn-rename-task').style.display = '';
  refreshChatHead(task);
  setSending(task.status === 'running');

  const scroll = $('chat-scroll');
  if (!scroll) return;
  state.turnEls = {};
  scroll.innerHTML = '';

  const turns = task.turns || [];
  const total = turns.length;
  const HIDE = state.showAllTurns ? 0 : Math.max(0, total - state.initialVisibleLimit);
  // 记录视图实际渲染的起始下标：断线回源补齐（reconcileViewWithServer）只能在这个窗口内补轮次，
  // 否则会把被 initialVisibleLimit 折叠的旧轮次重复补到列表末尾
  state.renderedFromIndex = HIDE;

  // 顶部“加载更早历史”按钮
  if (HIDE > 0) {
    const moreBar = document.createElement('div');
    moreBar.className = 'hist-more-bar';
    moreBar.innerHTML = '<button class="hist-more-btn">⌃ 加载更早的 ' + HIDE + ' 条历史消息</button>';
    moreBar.querySelector('button').addEventListener('click', () => {
      state.showAllTurns = true;
      applyTaskToView(task, false);
    });
    scroll.appendChild(moreBar);
  }

  // 使用 DocumentFragment 一次性批量挂载历史轮次（极大减少 DOM reflow / 重排卡顿）
  const frag = document.createDocumentFragment();
  for (let i = HIDE; i < total; i++) {
    const turn = turns[i];
    const turnEl = buildTurnElement(task.id, turn);
    frag.appendChild(turnEl);

    // 如果是用户发送的轮次且后面关联了编排计划
    if (turn.role === 'user' && task.plan && (i === total - 1 || (turn.subtaskIds && turn.subtaskIds.length))) {
      const planCard = createPlanCardElement(task.plan);
      frag.appendChild(planCard);
    }
  }
  scroll.appendChild(frag);

  // 兜底：若有 plan 但未挂在任何 user 轮次后，挂在末尾
  if (task.plan && !scroll.querySelector('.plan-card')) {
    scroll.appendChild(createPlanCardElement(task.plan));
  }

  // 滚动到底部（单次完成）
  scroll.scrollTop = scroll.scrollHeight;
}

function resetChatView() {
  $('chat-scroll').innerHTML = '<div class="chat-empty" id="chat-empty"><div style="font-size:36px">⚡</div><div>从左侧选择任务，或新建一个任务会话</div></div>';
  $('chat-title').textContent = '选择或新建任务';
  if ($('btn-add-member')) $('btn-add-member').style.display = 'none';
  if ($('btn-rename-task')) $('btn-rename-task').style.display = 'none';
  if ($('chat-mode')) $('chat-mode').style.display = 'none';
  const mc = $('member-chips'); if (mc) mc.innerHTML = '';
  resetTaskStats();
  resetTaskTodos();
}

function refreshChatHead(taskMaybe) {
  const nameEl = $('main-agent-btn-name');
  if (nameEl && mainAgentState.loaded) nameEl.textContent = mainAgentBtnLabel();
  const task = taskMaybe || state.taskCache.get(state.currentTaskId) || state.tasks.find(t => t.id === state.currentTaskId);
  if (!task) return;
  const modeEl = $('chat-mode');
  modeEl.style.display = '';
  const isOrch = task.mode === 'orchestrate';
  // lastRoute 记录最近一轮的实际路由（单人为定向直通），优先展示它，避免与多成员 mode 冲突
  const route = task.lastRoute;
  if (route && route.kind === 'direct') {
    modeEl.className = 'badge mode chat direct';
    modeEl.textContent = '🎯 定向直通 → ' + (route.agentName || route.agentId || '子智能体');
    return;
  }
  if (route && route.kind === 'chat') {
    modeEl.className = 'badge mode chat';
    modeEl.textContent = '💬 直通对话';
    return;
  }
  modeEl.className = 'badge mode' + (isOrch ? '' : ' chat');
  modeEl.textContent = isOrch ? '⚡ 协同编排' : '💬 直通对话';
}

// ---------- RAF 节流流式更新与 SSE 事件连接 ----------
let pendingStreamUpdates = false;
// 流式块缓冲：按 seq 排序后交错渲染（reasoning / tool / text 到达顺序）
const streamBuffer = { events: [] };

function scheduleStreamFlush() {
  if (pendingStreamUpdates) return;
  pendingStreamUpdates = true;
  requestAnimationFrame(() => {
    pendingStreamUpdates = false;
    // 按到达顺序（seq）排序，跨类型交错渲染，避免「所有思考/工具/回答堆一起」
    streamBuffer.events.sort((a, b) => a.seq - b.seq);
    const batch = streamBuffer.events.splice(0);
    for (const ev of batch) {
      const el = state.turnEls[ev.turnId];
      if (!el) continue;
      if (el.kind === 'settled') continue; // turn_end 已收敛为最终 markdown，丢弃迟到的流式块
      if (el.kind !== 'stream' && ev.kind !== 'delta') continue;
      if (ev.kind === 'reasoning') {
        const blk = ensureLiveBlock(el, 'reasoning', ev.turnId);
        blk.append(ev.delta || '', true);
      } else if (ev.kind === 'tool') {
        upsertLiveTool(el, ev.tool);
      } else if (ev.kind === 'delta') {
        const blk = ensureLiveBlock(el, 'text', ev.turnId);
        blk.append(ev.delta || '');
      }
    }
    smartScrollBottom();
  });
}

/** 确保流式消息中存在指定类型的块；若最后一块类型不同则新增，实现按到达顺序交错 */
function ensureLiveBlock(el, kind, turnId) {
  const blocks = el.blocks.querySelectorAll('.blk');
  let last = blocks.length ? blocks[blocks.length - 1] : null;
  // 工具调用按 id 复用；文本/思考连续追加到现有块
  if (last && last.dataset.kind === kind && kind !== 'tool') {
    const existing = el.blocks.__blockMap[kind];
    if (existing) return existing;
  }
  const blk = createBlock(kind);
  el.blocks.appendChild(blk.el);
  el.blocks.__blockMap = el.blocks.__blockMap || {};
  el.blocks.__blockMap[kind] = blk;
  return blk;
}

function upsertLiveTool(el, tool) {
  const turnMeta = {
    agentName: el.dataset?.agentName || el.wrap?.dataset?.agentName || '',
    agentId: el.dataset?.agentId || el.wrap?.dataset?.agentId || '',
    taskId: state.currentTaskId,
  };
  let row = el.blocks.querySelector('.blk-tool[data-tid="' + tool.id + '"]');
  if (!row) {
    const blk = createBlock('tool');
    blk.upsert(tool, turnMeta);
    el.blocks.appendChild(blk.el);
    row = blk.el;
  } else {
    // 复用现有行更新
    const blk = { el: row, kind: 'tool', upsert(t, meta) {
      if (t.name === 'ask_user_question' || t.name === 'ask-user-question') {
        renderAskUserCard(row, t, meta || turnMeta);
      } else {
        renderNormalToolRow(row, t);
      }
    } };
    blk.upsert(tool, turnMeta);
  }
  if (tool.status === 'running') {
    const line = row.querySelector('.tw-line');
    if (line) {
      const d = row.querySelector('.tw-detail');
      if (d) d.style.display = 'block';
      const chev = row.querySelector('.tw-chev');
      if (chev) chev.textContent = '▾';
    }
  }
}

function connectStream(taskId) {
  disconnectStream();
  const es = new EventSource(API + '/tasks/' + taskId + '/stream');
  state.es = es;

  es.addEventListener('turn_start', e => {
    try {
      const ev = JSON.parse(e.data);
      appendLiveTurn(taskId, ev.turn);
    } catch {}
  });

  es.addEventListener('turn_delta', e => {
    try {
      const ev = JSON.parse(e.data);
      streamBuffer.events.push({ seq: ev.seq || 0, kind: 'delta', turnId: ev.turnId, delta: ev.delta });
      scheduleStreamFlush();
    } catch {}
  });

  es.addEventListener('turn_reasoning', e => {
    try {
      const ev = JSON.parse(e.data);
      streamBuffer.events.push({ seq: ev.seq || 0, kind: 'reasoning', turnId: ev.turnId, delta: ev.delta });
      scheduleStreamFlush();
    } catch {}
  });

  es.addEventListener('turn_tool', e => {
    try {
      const ev = JSON.parse(e.data);
      streamBuffer.events.push({ seq: ev.seq || 0, kind: 'tool', turnId: ev.turnId, tool: ev.tool });
      scheduleStreamFlush();
    } catch {}
  });

  es.addEventListener('turn_usage', e => {
    try {
      const ev = JSON.parse(e.data);
      const el = state.turnEls[ev.turnId];
      if (el) applyUsageBadge(el, ev.usage);
    } catch {}
  });

  es.addEventListener('turn_end', e => {
    try {
      const ev = JSON.parse(e.data);
      const el = state.turnEls[ev.turn.id];
      if (el) {
        finalizeTurnBlocks(el, ev.turn, taskId);
        applyUsageBadge(el, ev.turn.usage);
      }
      smartScrollBottom();
      loadTasksQuiet();
      loadTaskStats();
      loadTaskTodos();
    } catch {}
  });

  es.addEventListener('plan_update', e => {
    try {
      const ev = JSON.parse(e.data);
      renderPlanCard(ev.plan, true);
    } catch {}
  });

  es.addEventListener('subtask_status', e => {
    try {
      const ev = JSON.parse(e.data);
      updatePlanRow(ev.subtask);
      loadTasksQuiet();
    } catch {}
  });

  es.addEventListener('log', e => {
    try {
      const ev = JSON.parse(e.data);
      appendLogLine(ev);
    } catch {}
  });

  es.addEventListener('task_status', e => {
    try {
      const ev = JSON.parse(e.data);
      setSending(ev.status === 'running');
    } catch {}
    loadTasksQuiet();
  });

  es.addEventListener('task_end', e => {
    try {
      const ev = JSON.parse(e.data);
      if (ev.task) {
        state.taskCache.set(ev.task.id, ev.task);
        if (ev.task.id === state.currentTaskId) refreshChatHead(ev.task);
      }
    } catch {}
    loadTasksQuiet();
    for (const k in state.turnEls) {
      const c = state.turnEls[k].wrap.querySelector('.cursor');
      if (c) c.remove();
    }
    setSending(false);
  });

  // 重连补齐：EventSource 首次连接成功不算重连；此后每次 onopen 都意味着中间丢过帧，
  // 必须回源用服务端权威文本校正（否则断连窗口内的 turn_end 会让气泡永久停在半截）
  let sseOpened = false;
  es.onopen = () => {
    if (sseOpened) resyncCurrentTask();
    sseOpened = true;
  };
  es.onerror = () => {};
}

function disconnectStream() {
  if (state.es) {
    state.es.close();
    state.es = null;
  }
}

/** 智能跟随滚动：仅当用户已在底部附近时自动滚到底，不打扰向上阅读 */
function smartScrollBottom() {
  const s = $('chat-scroll');
  if (s.scrollHeight - s.scrollTop - s.clientHeight < 220) {
    s.scrollTop = s.scrollHeight;
  }
}
function scrollBottom() {
  const s = $('chat-scroll');
  s.scrollTop = s.scrollHeight;
}

// ---------- 回到底部悬浮按钮 ----------
(function initJumpBottom() {
  const btn = $('btn-jump-bottom');
  const s = $('chat-scroll');
  if (!btn || !s) return;
  let ticking = false;
  s.addEventListener('scroll', () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const away = s.scrollHeight - s.scrollTop - s.clientHeight;
      btn.classList.toggle('on', away > 400);
    });
  });
  btn.addEventListener('click', () => { scrollBottom(); btn.classList.remove('on'); });
})();

// ---------- 消息组件构建器 ----------

/**
 * 渲染单个消息内容块（对齐 DSH ui-chat 的 assistant block 序列）。
 * 思考、工具调用、正文在消息内按到达顺序交错排列，而非三个堆叠容器。
 * @returns 块元素 { el, kind, update } — update 用于流式追加内容
 */
function createBlock(kind) {
  if (kind === 'reasoning') {
    const el = document.createElement('div');
    el.className = 'blk blk-reasoning rz';
    el.dataset.kind = 'reasoning';
    el.innerHTML =
      '<div class="rz-head"><span class="rz-chev">▸</span>💭 思考过程<span class="rz-sum"></span></div>' +
      '<div class="rz-body"></div>';
    const body = el.querySelector('.rz-body');
    const sum = el.querySelector('.rz-sum');
    const chev = el.querySelector('.rz-chev');
    el.querySelector('.rz-head').addEventListener('click', () => {
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      chev.textContent = open ? '▸' : '▾';
    });
    return {
      el, kind,
      /** 流式追加思考文字 */
      append(delta, running) {
        body.style.display = '';
        chev.textContent = '▾';
        body.textContent += delta;
        el.querySelector('.rz-head').classList.add('open');
        sum.textContent = running ? '思考中 · ' + lastLine(body.textContent) : '已思考 ' + body.textContent.length + ' 字';
      },
      /** 回填完整思考文本（turn_end） */
      fill(text) {
        if (!text) return;
        body.style.display = '';
        chev.textContent = '▾';
        body.textContent = text;
        sum.textContent = '已思考 ' + text.length + ' 字';
      },
      el,
    };
  }

  if (kind === 'text') {
    const el = document.createElement('div');
    el.className = 'blk blk-text content markdown';
    el.dataset.kind = 'text';
    const state = { streamingText: '', lastPaint: 0 };
    const paint = () => {
      state.lastPaint = Date.now();
      el.innerHTML = md(state.streamingText);
      const cur = document.createElement('span'); cur.className = 'cursor';
      el.appendChild(cur);
    };
    return {
      el, kind,
      /** 流式追加：节流渲染 markdown（≥400ms 一次，收尾由 finalizeTurnBlocks 兜底全量重渲） */
      append(delta) {
        state.streamingText += delta;
        el.contentState = { streaming: true, text: state.streamingText };
        if (Date.now() - state.lastPaint >= 400) paint();
      },
      /** 完成后渲染 markdown */
      fill(html) {
        el.innerHTML = html;
        delete el.contentState;
      },
    };
  }

  // kind === 'tool'
  const el = document.createElement('div');
  el.className = 'blk blk-tool tw-row';
  el.dataset.kind = 'tool';
  el.dataset.tid = '';
  const rowEl = {
    el, kind,
    /** 更新单个工具调用行（按 id 复用现有行，支持 ask_user_question 问答卡片） */
    upsert(t, meta) {
      el.dataset.tid = t.id;
      if (t.name === 'ask_user_question' || t.name === 'ask-user-question') {
        renderAskUserCard(el, t, meta);
      } else {
        renderNormalToolRow(el, t);
      }
    },
  };
  return rowEl;
}

function parseAskQuestions(argsStr) {
  if (!argsStr) return null;
  try {
    const obj = typeof argsStr === 'string' ? JSON.parse(argsStr) : argsStr;
    if (obj && Array.isArray(obj.questions) && obj.questions.length) {
      return obj.questions;
    }
    if (obj && obj.question) {
      return [obj];
    }
  } catch {}
  return null;
}

function renderAskUserCard(el, t, turnMeta) {
  el.className = 'blk blk-tool';
  el.dataset.tid = t.id;
  const questions = parseAskQuestions(t.args);
  if (!questions) {
    renderNormalToolRow(el, t);
    return;
  }
  const isDone = t.status === 'done' || Boolean(t.result);
  let qHtml = '';
  questions.forEach((q, qIdx) => {
    const qTitle = q.header ? '【' + esc(q.header) + '】' + esc(q.question) : esc(q.question);
    const isMulti = Boolean(q.multi_select);
    const inputType = isMulti ? 'checkbox' : 'radio';
    const groupName = 'ask_q_' + t.id + '_' + (q.id || qIdx);
    let optHtml = '';
    (q.options || []).forEach((opt, oIdx) => {
      const optLabel = typeof opt === 'string' ? opt : opt.label;
      const optDesc = typeof opt === 'object' && opt.description ? opt.description : '';
      const isDefault = oIdx === 0 && !isMulti;
      optHtml += '<label class="ask-opt' + (isDefault && !isDone ? ' selected' : '') + '">' +
        '<input type="' + inputType + '" name="' + groupName + '" value="' + esc(optLabel) + '"' + (isDefault && !isDone ? ' checked' : '') + (isDone ? ' disabled' : '') + '>' +
        '<div class="ask-opt-main">' +
          '<div class="ask-opt-label">' + esc(optLabel) + '</div>' +
          (optDesc ? '<div class="ask-opt-desc">' + esc(optDesc) + '</div>' : '') +
        '</div>' +
      '</label>';
    });
    qHtml += '<div class="ask-q" data-qid="' + esc(q.id || String(qIdx)) + '">' +
      '<div class="ask-q-title">' + qTitle + '</div>' +
      '<div class="ask-options">' + optHtml + '</div>' +
      '<input class="ask-custom" type="text" placeholder="自定义回答（可选，多选时为补充说明）" style="margin-top:6px;font-size:12px">' +
    '</div>';
  });

  const statusText = isDone ? '✓ 已答复' : '⏳ 等待选择';
  const footHtml = isDone
    ? (t.result ? '<div class="ask-result-hint" style="font-size:11.5px;color:var(--tx3);margin-top:4px">答复内容: ' + esc(t.result) + '</div>' : '')
    : '<div class="ask-actions">' +
        '<span style="font-size:11.5px;color:var(--tx3);margin-right:auto">选择后提交答复；答复会直接回传给子智能体</span>' +
        '<button class="ask-btn-skip" type="button">跳过</button>' +
        '<button class="ask-btn-submit" type="button">📤 提交答复</button>' +
      '</div>';

  el.innerHTML = '<div class="ask-card' + (isDone ? ' submitted' : '') + '">' +
    '<div class="ask-head">' +
      '<span class="ask-icon">❓</span>' +
      '<span class="ask-title">子智能体需要您的确认 / 选择</span>' +
      '<span class="ask-status">' + statusText + '</span>' +
    '</div>' +
    '<div class="ask-body">' + qHtml + '</div>' +
    footHtml +
  '</div>';

  const card = el.querySelector('.ask-card');
  if (!isDone && card) {
    card.querySelectorAll('.ask-opt').forEach(optEl => {
      optEl.addEventListener('click', () => {
        const inp = optEl.querySelector('input');
        if (!inp || inp.disabled) return;
        if (inp.type === 'radio') {
          const group = card.querySelectorAll('input[name="' + inp.name + '"]');
          group.forEach(g => {
            const p = g.closest('.ask-opt');
            if (p) p.classList.remove('selected');
          });
          optEl.classList.add('selected');
        } else {
          if (inp.checked) optEl.classList.add('selected');
          else optEl.classList.remove('selected');
        }
      });
    });

    const submitBtn = card.querySelector('.ask-btn-submit');
    if (submitBtn) {
      const collectAnswers = () => {
        const answers = [];
        card.querySelectorAll('.ask-q').forEach(qEl => {
          const qid = qEl.dataset.qid;
          const selected = Array.from(qEl.querySelectorAll('input:checked')).map(c => c.value);
          const customEl = qEl.querySelector('.ask-custom');
          const custom = customEl && customEl.value.trim() !== '' ? customEl.value.trim() : undefined;
          if (selected.length || custom) {
            answers.push(custom ? { id: qid, selected, custom } : { id: qid, selected });
          } else {
            answers.push({ id: qid, selected: [] });
          }
        });
        return answers;
      };
      const markSubmitted = () => {
        card.classList.add('submitted');
        card.querySelectorAll('input, button').forEach(i => { i.disabled = true; });
        const st = card.querySelector('.ask-status');
        if (st) st.textContent = '✓ 已提交答复';
      };
      const sendAnswer = async (answers, skip) => {
        if (!skip && answers.every(a => a.selected.length === 0 && !a.custom)) {
          toast('请至少选择一个选项、填写自定义回答，或点「跳过」', true);
          return;
        }
        submitBtn.disabled = true;
        submitBtn.textContent = '提交中…';
        const st = card.querySelector('.ask-status');
        if (st) st.textContent = '⏳ 提交中…';
        const agentId = (turnMeta && turnMeta.agentId) || '';
        const r = await api('/tasks/' + state.currentTaskId + '/ask-answer', {
          method: 'POST',
          body: JSON.stringify({ agentId, answers }),
        });
        if (r.ok) {
          markSubmitted();
          toast('✓ 答复已回传，子智能体继续执行中…');
          setSending(true);
        } else {
          submitBtn.disabled = false;
          submitBtn.textContent = '📤 提交答复';
          if (st) st.textContent = '⏳ 等待选择';
          toast(r.error || '答复提交失败', true);
        }
      };
      submitBtn.addEventListener('click', () => {
        if (!state.currentTaskId) { toast('请先选择任务', true); return; }
        sendAnswer(collectAnswers(), false);
      });
      const skipBtn = card.querySelector('.ask-btn-skip');
      if (skipBtn) {
        skipBtn.addEventListener('click', () => {
          if (!state.currentTaskId) { toast('请先选择任务', true); return; }
          sendAnswer(collectAnswers().map(a => ({ id: a.id, selected: [] })), true);
        });
      }
    }
  }
}

function renderNormalToolRow(el, t) {
  el.className = 'blk blk-tool tw-row';
  let line = el.querySelector('.tw-line');
  if (!line) {
    el.innerHTML = '<div class="tw-line"><span class="tw-ic"></span><span class="tw-name"></span><span class="tw-ms"></span><span class="tw-chev">▸</span></div><div class="tw-detail" style="display:none"></div>';
    line = el.querySelector('.tw-line');
    line.addEventListener('click', () => {
      const d = el.querySelector('.tw-detail');
      const open = d.style.display !== 'none';
      d.style.display = open ? 'none' : 'block';
      el.querySelector('.tw-chev').textContent = open ? '▸' : '▾';
    });
  }
  el.querySelector('.tw-ic').textContent = t.status === 'running' ? '⏳' : (t.status === 'error' ? '✗' : '✓');
  el.querySelector('.tw-name').textContent = t.name + (t.args ? ' · ' + t.args.slice(0, 80) : '');
  el.querySelector('.tw-ms').textContent = t.ms !== undefined ? (t.ms / 1000).toFixed(1) + 's' : '';
  const parts = [];
  if (t.args) parts.push('参数: ' + t.args);
  if (t.result) parts.push('结果: ' + t.result);
  el.querySelector('.tw-detail').textContent = parts.join('\\n') || '（无详情）';
}

/** 由 token 账本计算缓存命中率（0-100），无可计费输入返回 null */
function cacheHitPercent(usage) {
  if (!usage) return null;
  const read = Number(usage.cacheReadTokens) || 0;
  const miss = Number(usage.uncachedInputTokens) || Number(usage.inputTokens) || 0;
  const write = Number(usage.cacheWriteTokens) || 0;
  const denom = read + miss + write;
  if (denom <= 0) return null;
  return Math.round((read / denom) * 100);
}

/** 生成缓存命中徽标 HTML；无 usage 返回空串 */
function usageBadgeHtml(usage) {
  if (!usage || typeof usage !== 'object') return '';
  const pct = cacheHitPercent(usage);
  const miss = Number(usage.uncachedInputTokens) || Number(usage.inputTokens) || 0;
  const read = Number(usage.cacheReadTokens) || 0;
  const out = Number(usage.outputTokens) || 0;
  if (pct === null) return '';
  const tooltip = '缓存命中 ' + read.toLocaleString() + ' 词 · 冷读 ' + miss.toLocaleString() + ' 词 · 输出 ' + out.toLocaleString() + ' 词';
  return '<span class="tag-cache" title="' + esc(tooltip) + '">缓存 ' + pct + '%</span>';
}

/** 更新 turn 元素 meta 里的缓存徽标（流式实时或回放时写入） */
function applyUsageBadge(el, usage) {
  const meta = el && el.wrap && el.wrap.querySelector('.meta');
  if (!meta) return;
  const old = meta.querySelector('.tag-cache');
  if (old) old.remove();
  const badge = usageBadgeHtml(usage);
  if (badge) meta.insertAdjacentHTML('beforeend', badge);
}

function buildTurnElement(taskId, turn) {
  const wrap = document.createElement('div');
  const roleClass = turn.role === 'user' ? 'user' : (turn.role === 'system' ? 'system' : 'agent');
  const isOrch = turn.agentName === '🎯 总调度汇总';
  const isPlanningWait = roleClass === 'system' && /正在拆解|规划子任务|流水线/.test(turn.text || '');
  wrap.className = 'msg ' + roleClass + (isOrch ? ' orchestrator' : '') + (isPlanningWait ? ' sys-planning' : '');
  wrap.dataset.turnId = turn.id;
  wrap.dataset.agentName = turn.agentName || '';
  wrap.dataset.agentId = turn.agentId || '';

  // 系统轮次带 agentName（如「🎯 主调度规划」）时以该身份展示，区别于告警类系统消息
  const isNamedSys = roleClass === 'system' && Boolean(turn.agentName);
  const avatar = turn.role === 'user' ? '你' : (roleClass === 'system' ? (isNamedSys ? '🎯' : '⚠') : (isOrch ? '🎯' : '🤖'));
  const name = turn.role === 'user' ? '你' : esc(turn.agentName || (roleClass === 'system' ? '系统' : '子智能体'));

  const agent = state.agents.find(a => a.id === turn.agentId);
  // 模型标签取「该轮实际生效的模型」：主智能体 = 模型列表当前选中（engine.ensureSession 建会话
  // 即用 planner.model 覆盖其自身配置）；被 @ 的子智能体 = 其自身配置的模型。
  const isMainTurn = turn.agentId && turn.agentId === (mainAgentState.cur || mainAgentState.resolvedAgentId);
  const badgeModel = (isMainTurn && modelState.cur)
    ? String(modelState.cur).split('/').pop()
    : (agent ? String(agent.model || '').split('/').pop() : '');
  const modelBadge = badgeModel ? '<span class="tag-model">' + esc(badgeModel) + '</span>' : '';
  const cacheBadge = usageBadgeHtml(turn.usage);

  wrap.innerHTML =
    '<div class="avatar">' + avatar + '</div>' +
    '<div class="bubble">' +
    '<div class="meta"><b>' + name + '</b>' + modelBadge + cacheBadge + '<span>' + fmtTime(turn.at) + '</span></div>' +
    '<div class="blocks"></div>' +
    '</div>';

  const blocks = wrap.querySelector('.blocks');
  const turnMeta = { agentName: turn.agentName, agentId: turn.agentId, taskId };

  // 非流式（历史回放）：按「思考 → 工具调用 → 正文」的稳定顺序渲染。
  // 思考块对 agent 与 system（主调度规划轮）都渲染 —— 编排拆解的思考/推理日志需要回放可见
  if (!turn.streaming) {
    if (turn.reasoning && (turn.role === 'agent' || turn.role === 'system')) {
      const rb = createBlock('reasoning'); rb.fill(turn.reasoning); blocks.appendChild(rb.el);
    }
    if (turn.tools && turn.tools.length) {
      for (const t of turn.tools) {
        const tb = createBlock('tool'); tb.upsert(t, turnMeta); blocks.appendChild(tb.el);
      }
    }
    if (turn.text) {
      const te = createBlock('text');
      te.el.innerHTML = turn.role === 'agent' ? md(withFileLinks(taskId, turn.agentId, turn.text || '')) : md(turn.text || '');
      blocks.appendChild(te.el);
    }
  } else {
    // 流式：按到达顺序交错追加块（对齐 DSH assistant-block 序列）
    if (turn.text) {
      const te = createBlock('text'); te.el.textContent = turn.text || ''; blocks.appendChild(te.el);
    }
  }

  state.turnEls[turn.id] = {
    wrap, blocks, kind: turn.streaming ? 'stream' : 'settled', text: null, reasoning: null,
  };

  return wrap;
}

function appendLiveTurn(taskId, turn) {
  const scroll = $('chat-scroll');
  // 幂等：同一轮次的 turn_start 重复到达（重连回放 / 视图刚重建）时复用已有气泡，不重复插入
  const existing = state.turnEls[turn.id];
  if (existing && existing.wrap && existing.wrap.parentNode) return;
  const el = buildTurnElement(taskId, turn);
  scroll.appendChild(el);
  smartScrollBottom();
}

/**
 * SSE 重连后回源补齐。
 *
 * 浏览器 EventSource 自动重连时**不会重放**断连期间的事件，若 turn_end 恰好落在断连窗口里，
 * 页面就会永久停在半截正文（用户只能手动切会话/刷新才恢复）。
 * 这里在重连成功（onopen 且非首次）时重新拉取会话详情，用服务端权威 turn.text 校正页面：
 *   - 仍在流式（kind=stream）或页面文本短于权威文本的轮次 → 就地重建气泡；
 *   - 页面上完全缺失的轮次 → 补齐。
 */
async function resyncCurrentTask() {
  const taskId = state.currentTaskId;
  if (!taskId) return;
  const r = await api('/tasks/' + taskId);
  if (!r.ok || !r.data || state.currentTaskId !== taskId) return;
  state.taskCache.set(taskId, r.data);
  reconcileViewWithServer(taskId, r.data);
}

/** 用服务端权威任务状态校正当前视图（见 resyncCurrentTask） */
function reconcileViewWithServer(taskId, task) {
  const scroll = $('chat-scroll');
  if (!scroll || state.currentTaskId !== taskId) return;
  // 只比对「正文语义字符」：markdown 语法字符在渲染时被消化，直接比长度会误判。
  // 注意本文件整体处于模板字符串内，正则里的反斜杠与反引号必须按模板串转义（\\x60 = 反引号）
  const norm = (s) => String(s == null ? '' : s).replace(/[\\x60*|#>~_()\\[\\]\\-\\s]/g, '');
  const turns = task.turns || [];
  const from = state.renderedFromIndex || 0; // 视图按 initialVisibleLimit 只渲染末尾若干轮，勿把被折叠的旧轮补到末尾
  for (let i = from; i < turns.length; i++) {
    const turn = turns[i];
    const el = state.turnEls[turn.id];
    const inDom = el && el.wrap && el.wrap.parentNode;
    if (!inDom) {
      appendLiveTurn(taskId, turn);
      continue;
    }
    const shown = norm(el.blocks ? el.blocks.textContent : '');
    const auth = norm(turn.text);
    const tail = auth.slice(-40);
    const complete = auth.length > 0 && (shown.includes(auth) || (tail && shown.endsWith(tail)));
    // 仍在流式的轮次一律按服务端快照重建；已收敛的轮次仅在页面明确缺内容且更短时重建
    const stale = el.kind === 'stream' ? !complete : (!complete && auth.length > shown.length);
    if (stale) {
      const fresh = buildTurnElement(taskId, turn);
      el.wrap.replaceWith(fresh);
    }
  }
  smartScrollBottom();
}

/** turn_end 收尾：把流式块收敛为最终形式（思考回填、正文渲染 markdown、压缩为稳定顺序） */
function finalizeTurnBlocks(el, turn, taskId) {
  el.kind = 'settled';
  const blocks = el.blocks;
  // 移除残留光标
  blocks.querySelectorAll('.cursor').forEach(c => c.remove());

  // 1) 正文：收集全部流式 text 块（主调度规划轮的阶段日志与思考块交错，会产生多个 text 块），
  //    以服务端权威文本 turn.text 为准整体收敛进第一个 text 块渲染 markdown，移除多余块。
  //
  //    ⚠️ 曾经丢内容的根因：中途加入会话（断线重连 / 打开正在执行的会话 / 刷新页面）时，
  //    buildTurnElement 生成的 text 块**没有 contentState**（正文只活在 DOM 里），
  //    旧条件 [textBlk.contentState || textBlks.length > 1] 在「只有一个无 contentState 的块」时为假，
  //    于是整段收尾被跳过 —— turn_end 携带的服务端全文被丢弃，气泡永久停在半截。
  //    现在只要拿到权威 fullText 就无条件回填，与块的来源无关。
  const textBlks = Array.prototype.slice.call(blocks.querySelectorAll('.blk-text'));
  const textBlk = textBlks[0] || null;
  let streamText = '';
  for (const b of textBlks) streamText += b.contentState ? b.contentState.text : (b.textContent || '');
  const fullText = turn.text || streamText;
  if (textBlk) {
    if (fullText) {
      textBlk.classList.add('settled');
      textBlk.innerHTML = turn.role === 'agent' ? md(withFileLinks(taskId, turn.agentId, fullText)) : md(fullText);
      delete textBlk.contentState;
    }
    for (const extra of textBlks.slice(1)) extra.remove();
  } else if (fullText) {
    const te = createBlock('text');
    te.el.innerHTML = turn.role === 'agent' ? md(withFileLinks(taskId, turn.agentId, fullText)) : md(fullText);
    blocks.appendChild(te.el);
  }

  // 2) 思考：流式中已存在的块更新为完整文本与「已思考 N 字」终态；缺失则补充。
  //    覆盖 agent 与 system（主调度规划轮）——编排拆解的思考过程在收尾后同样可见
  if (turn.reasoning) {
    const existing = blocks.querySelector('.blk-reasoning');
    if (existing) {
      const body = existing.querySelector('.rz-body');
      const sum = existing.querySelector('.rz-sum');
      if (body) body.textContent = turn.reasoning;
      if (sum) sum.textContent = '已思考 ' + turn.reasoning.length + ' 字';
    } else {
      const rb = createBlock('reasoning'); rb.fill(turn.reasoning); blocks.appendChild(rb.el);
    }
  }

  // 3) 工具：确保最终工具列表的每一行都在页面上
  if (turn.tools && turn.tools.length) {
    const turnMeta = { agentName: turn.agentName, agentId: turn.agentId, taskId };
    for (const t of turn.tools) {
      if (!blocks.querySelector('.blk-tool[data-tid="' + t.id + '"]')) {
        const tb = createBlock('tool'); tb.upsert(t, turnMeta); blocks.appendChild(tb.el);
      }
    }
  }

  // 4) 规划等待动效收敛：终态文本不再是「正在拆解」类等待语时移除脉冲点，避免完成后仍显示等待中
  if (el.wrap && el.wrap.classList.contains('sys-planning') && !/正在拆解|规划子任务|流水线/.test(turn.text || '')) {
    el.wrap.classList.remove('sys-planning');
  }
}

// ---------- 编排计划卡片 (Plan Card) ----------
let planRowEls = {};

function createPlanCardElement(plan) {
  const card = document.createElement('div');
  card.className = 'plan-card';
  const subs = plan.subtasks || [];
  // 计算依赖标题映射（用 subtask 标题/id 反查依赖标签）
  const titleById = new Map();
  subs.forEach(s => {
    if (s.title) titleById.set(s.id, s.title);
  });
  // 判断是否有任何依赖关系（决定是否显示 DAG 依赖区）
  const hasDep = subs.some(s => s.dependsOn && s.dependsOn.length);
  const stratLabel = plan.strategy === 'dag' ? 'DAG 依赖编排' : (plan.strategy === 'sequential' ? '顺序执行' : '并行协同');
  const headerTail =
    '<span class="plan-strat" style="font-weight:600;color:var(--pri)">' + esc(stratLabel) + '</span>' +
    '<span style="font-size:11.5px;color:var(--tx3)">' + subs.length + ' 个子任务</span>';

  // 依赖图例 / 提示行
  let depHeaderHtml = '';
  if (hasDep) {
    depHeaderHtml = '<div class="plan-dep-hint" style="font-size:11.5px;color:var(--tx3);margin-bottom:6px">' +
      (plan.strategy === 'dag' ? '↘ 箭头表示子任务依赖关系（被指向者需等待其前置完成）' : '⛓ 依赖：下方子任务需等待其前置完成') +
      '</div>';
  }

  // 任务行
  let rowsHtml = '';
  for (const s of subs) {
    const agent = state.agents.find(a => a.id === s.agentId);
    const deps = (s.dependsOn || []).map(id => titleById.get(id) || id).filter(Boolean);
    const depTag = deps.length
      ? '<span class="plan-dep" title="依赖于: ' + esc(deps.join('、')) + '">⛓ ' + esc(deps.join('、')) + '</span>'
      : '';
    const failedBtn = s.status === 'failed' ? '<button class="mini-btn" data-op="retry">重试</button>' : '';
    // 行内依赖标注放在任务标题上方一行（若存在依赖）
    const titleCell = depTag
      ? '<div style="display:block;line-height:1.5"><span style="display:block;font-weight:500">' + esc(s.title) + '</span>' + depTag + '</div>'
      : '<span style="font-weight:500">' + esc(s.title) + '</span>';
    const rowStateCls = s.status === 'running' ? ' row-running' : (s.status === 'pending' ? ' row-pending' : '');
    rowsHtml +=
      '<div class="plan-row' + rowStateCls + '" data-sid="' + s.id + '" data-deps="' + esc(deps.join('|')) + '">' +
      '<span class="st ' + s.status + '">' + s.status + '</span>' + titleCell +
      '<span class="ag">🤖 ' + esc(agent ? agent.name : s.agentId) + '</span>' +
      '<span class="ops"><button class="mini-btn" data-op="logs">日志</button><button class="mini-btn" data-op="chat">会话</button>' + failedBtn + '</span>' +
      '</div>';
  }

  const hasActive = subs.some(x => x.status === 'running' || x.status === 'pending');
  if (hasActive) card.classList.add('plan-active');
  card.innerHTML = '<h4><span><span class="plan-gear">⚙</span>📋 编排计划 · ' + esc(plan.strategy || '协同模式') + '</span>' + headerTail + '</h4>' +
    depHeaderHtml + rowsHtml;

  // 依赖箭头：为每个有依赖的子任务，在其行上方画一条指向前置任务的连接线
  if (hasDep) {
    // 使用 planRowEls 之外的临时 map 记录行元素，用于连线
    const rowEls = {};
    card.querySelectorAll('.plan-row').forEach(r => { rowEls[r.dataset.sid] = r; });
    card.querySelectorAll('.plan-row[data-deps]:not([data-deps=""])').forEach(row => {
      const deps = (row.dataset.deps || '').split('|').filter(Boolean);
      const depBadge = row.querySelector('.plan-dep');
      if (depBadge) depBadge.textContent = '⛓ 前置: ' + deps.join('、');
    });
    card.classList.add('has-deps');
  }

  // 绑定行内操作（注意 innerHTML 已整体替换，需重新绑定）
  card.querySelectorAll('.plan-row').forEach(row => {
    const s = subs.find(x => x.id === row.dataset.sid);
    if (!s) return;
    row.querySelector('[data-op=logs]').addEventListener('click', () => showSubtaskLogs(s));
    row.querySelector('[data-op=chat]').addEventListener('click', () => showSubtaskChat(s.id, s.agentId));
    const rb = row.querySelector('[data-op=retry]');
    if (rb) rb.addEventListener('click', async () => { const r = await api('/tasks/' + state.currentTaskId + '/subtasks/' + s.id + '/retry', { method: 'POST' }); toast(r.ok ? '已重新派发' : (r.error || '失败'), !r.ok); });
    planRowEls[s.id] = row;
  });

  return card;
}

function renderPlanCard(plan, live) {
  document.querySelectorAll('.plan-card[data-live="1"]').forEach(x => x.remove());
  const card = createPlanCardElement(plan);
  card.dataset.live = '1';
  const scroll = $('chat-scroll');
  scroll.appendChild(card);
  if (live) smartScrollBottom();
}

function updatePlanRow(sub) {
  const row = planRowEls[sub.id];
  if (!row) return;
  const st = row.querySelector('.st');
  st.className = 'st ' + sub.status;
  st.textContent = sub.status;
  row.classList.toggle('row-running', sub.status === 'running');
  row.classList.toggle('row-pending', sub.status === 'pending');
  const card = row.closest('.plan-card');
  if (card) {
    const stillActive = [...card.querySelectorAll('.st')].some(x => x.classList.contains('running') || x.classList.contains('pending'));
    card.classList.toggle('plan-active', stillActive);
  }
}

const logBuffer = [];
function appendLogLine(ev) {
  logBuffer.push(ev);
  const drawerBody = $('drawer-body');
  if ($('drawer').classList.contains('on') && $('drawer-title').textContent.indexOf('工作日志') >= 0) {
    const div = document.createElement('div');
    div.className = 'log-line ' + (ev.level || 'info');
    div.innerHTML = '<span class="lv">[' + (ev.level || 'info') + ']</span>' + esc(ev.msg);
    drawerBody.appendChild(div);
    drawerBody.scrollTop = 1e9;
  }
}

function setSending(on) {
  // 运行中：发送键让位给停止键（位于输入框旁），视觉上只有一个主动作；
  // body.task-running 同时驱动「规划中」系统消息的等待动效
  $('btn-send').style.display = on ? 'none' : '';
  $('btn-send').disabled = on;
  $('btn-stop').style.display = on ? 'inline-block' : 'none';
  document.body.classList.toggle('task-running', on);
}

// ---------- 发送消息与附件 ----------
$('btn-send').addEventListener('click', send);

async function send() {
  const text = $('input').value.trim();
  if (!text) return;
  if (!state.currentTaskId) {
    toast('请先从左侧选择任务，或点击「＋ 新建任务」', true);
    return;
  }
  $('input').value = '';
  setSending(true);
  const r = await api('/tasks/' + state.currentTaskId + '/messages', { method: 'POST', body: JSON.stringify({ message: text }) });
  if (!r.ok) {
    toast(r.error || '发送失败', true);
    setSending(false);
  }
}

$('btn-stop').addEventListener('click', async () => {
  if (state.currentTaskId) {
    const btn = $('btn-stop');
    btn.disabled = true;
    btn.textContent = '■ 停止中…';
    const r = await api('/tasks/' + state.currentTaskId + '/cancel', { method: 'POST' });
    btn.disabled = false;
    btn.textContent = '■ 停止';
    if (r.ok) {
      setSending(false);
      toast('✓ 任务已成功停止');
    } else {
      toast(r.error || '停止指令发送失败', true);
    }
  }
});

// ---------- 附件上传 ----------
$('btn-attach').addEventListener('click', () => {
  if (!state.currentTaskId) { toast('请先选择或新建任务', true); return; }
  $('file-input').click();
});
$('file-input').addEventListener('change', () => {
  const input = $('file-input');
  const files = Array.from(input.files || []);
  input.value = '';
  if (!files.length || !state.currentTaskId) return;
  uploadAttachments(files);
});

function uploadAttachments(files) {
  const taskId = state.currentTaskId;
  if (!taskId) return;
  let panel = $('upload-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'upload-panel';
    document.body.appendChild(panel);
  }
  panel.style.display = 'block';
  panel.innerHTML = '<div class="up-head"><b>📎 上传附件到工作区（分片·断点续传）</b><span class="up-count"></span><span class="hspacer"></span><button class="mini-btn" id="up-close">✕</button></div><div class="up-rows"></div>';
  $('up-close').addEventListener('click', () => { panel.style.display = 'none'; });
  const rowsEl = panel.querySelector('.up-rows');
  const rows = files.map(f => ({ file: f, status: 'waiting', pct: 0 }));

  const statusText = r => r.status === 'waiting' ? '排队中…'
    : r.status === 'uploading'
      ? (r.pct >= 100 ? '⚡ 已到达服务器 · 正在分发到成员工作区…'
        : '上传中 ' + r.pct + '%' + (r.loaded != null ? '（' + fmtSize(r.loaded) + ' / ' + fmtSize(r.total || r.file.size) + '）' : '')
          + (r.resumedFrom ? ' · 已续传' : ''))
    : r.status === 'done' ? '✓ 已上传' + (r.dest ? ' → ' + r.dest : '') + (r.memberCount > 1 ? '（已同步 ' + r.memberCount + ' 个成员）' : '')
    : r.status === 'error'
      ? '✗ 失败: ' + (r.err || '未知') + (r.received ? '（已传 ' + fmtSize(r.received) + '，重试将从断点续传）' : '')
    : '';

  function renderRow(r) {
    let el = r.el;
    if (!el) {
      el = document.createElement('div');
      el.className = 'up-row';
      el.innerHTML = '<div class="up-line"><span class="up-name"></span><span class="up-size"></span></div>' +
        '<div class="up-bar"><div class="up-bar-in"></div></div><div class="up-status"></div>' +
        '<button class="mini-btn up-retry" style="display:none;margin-top:4px">↻ 断点续传重试</button>';
      rowsEl.appendChild(el);
      r.el = el;
      el.querySelector('.up-retry').addEventListener('click', () => {
        el.querySelector('.up-retry').style.display = 'none';
        uploadOne(r);
      });
    }
    el.className = 'up-row ' + r.status;
    el.querySelector('.up-name').textContent = '📄 ' + r.file.name;
    el.querySelector('.up-name').title = r.file.name;
    el.querySelector('.up-size').textContent = fmtSize(r.file.size);
    el.querySelector('.up-bar-in').style.width = (r.status === 'done' ? 100 : r.pct) + '%';
    el.querySelector('.up-bar').classList.toggle('indet', r.status === 'uploading' && r.pct >= 100);
    el.querySelector('.up-status').textContent = statusText(r);
    el.querySelector('.up-retry').style.display = r.status === 'error' ? '' : 'none';
    const done = rows.filter(x => x.status === 'done').length;
    panel.querySelector('.up-count').textContent = done + '/' + rows.length;
  }
  rows.forEach(renderRow);

  // ---- 分片断点续传核心：init → PUT 分片（XHR 进度）→ complete ----
  const CHUNK = 4 * 1024 * 1024;
  const resumeKey = f => 'wb-upload:' + taskId + ':' + f.name + ':' + f.size + ':' + (f.lastModified || 0);
  const fetchJson = (path, opts) => fetch(API + path, opts).then(async res => ({ status: res.status, json: await res.json().catch(() => ({})) }));

  async function putChunk(uploadId, offset, blob, onChunkProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', API + '/tasks/' + taskId + '/attachments/resumable/' + encodeURIComponent(uploadId) + '?offset=' + offset);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = e => { if (e.lengthComputable) onChunkProgress(e.loaded); };
      xhr.onload = () => {
        let j = null; try { j = JSON.parse(xhr.responseText); } catch (e) {}
        if (xhr.status === 409) return resolve({ conflict: true, received: (j && j.data && j.data.received) || 0 });
        if (xhr.status >= 200 && xhr.status < 300 && j && j.ok) return resolve({ received: j.data.received });
        reject(new Error((j && j.error) || 'HTTP ' + xhr.status));
      };
      xhr.onerror = () => reject(new Error('网络错误'));
      xhr.send(blob);
    });
  }

  async function uploadOne(r) {
    const f = r.file;
    r.status = 'uploading'; r.err = null; renderRow(r);
    let uploadId = null; let received = 0;
    try {
      // 断点恢复：localStorage 里存着上次中断的 uploadId → 查服务端接收量
      const key = resumeKey(f);
      let resumedFrom = 0;
      try {
        const saved = JSON.parse(localStorage.getItem(key) || 'null');
        if (saved && saved.uploadId) {
          const st = await fetchJson('/tasks/' + taskId + '/attachments/resumable/' + encodeURIComponent(saved.uploadId));
          if (st.status === 200 && st.json?.ok) {
            uploadId = saved.uploadId;
            received = st.json.data.received || 0;
            resumedFrom = received;
          }
        }
      } catch (e) { /* 恢复失败 → 全新上传 */ }
      if (!uploadId) {
        const init = await fetchJson('/tasks/' + taskId + '/attachments/resumable/init', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: f.name, size: f.size, mimeType: f.type || undefined }),
        });
        if (!(init.status < 300 && init.json?.ok)) throw new Error(init.json?.error || 'init HTTP ' + init.status);
        uploadId = init.json.data.uploadId;
        received = init.json.data.received || 0;
      }
      r.resumedFrom = resumedFrom;
      try { localStorage.setItem(key, JSON.stringify({ uploadId })); } catch (e) {}

      // 分片循环：offset 冲突(409)以服务端为准；网络错误对账后续传
      let failCount = 0;
      while (received < f.size) {
        const end = Math.min(received + CHUNK, f.size);
        const sent = await putChunk(uploadId, received, f.slice(received, end), loaded => {
          r.pct = Math.min(99, Math.floor((received + loaded) * 100 / f.size));
          r.loaded = received + loaded; r.total = f.size;
          renderRow(r);
        }).then(
          v => { failCount = 0; return v; },
          err => {
            if (++failCount >= 3) throw err;
            return { conflict: false, retry: true };
          },
        );
        if (sent.retry) {
          // 对账服务端接收量后从断点继续
          const st = await fetchJson('/tasks/' + taskId + '/attachments/resumable/' + encodeURIComponent(uploadId));
          received = (st.status === 200 && st.json?.ok) ? (st.json.data.received || 0) : received;
          continue;
        }
        received = sent.conflict ? (sent.received || received) : sent.received;
        r.pct = Math.min(99, Math.floor(received * 100 / f.size));
        r.loaded = received; r.total = f.size;
        renderRow(r);
      }

      // 完成（服务端在此阶段向成员节点分片中继）
      r.pct = 100; renderRow(r);
      const done = await fetchJson('/tasks/' + taskId + '/attachments/resumable/' + encodeURIComponent(uploadId) + '/complete', { method: 'POST' });
      if (!(done.status < 300 && done.json?.ok)) throw new Error(done.json?.error || 'complete HTTP ' + done.status);
      const okResults = ((done.json.data || {}).results || []).filter(rr => rr.ok);
      r.dest = okResults.flatMap(rr => (rr.files || []).map(x => x.path))[0];
      r.memberCount = okResults.length;
      r.status = 'done'; r.pct = 100; renderRow(r);
      try { localStorage.removeItem(key); } catch (e) {}
      appendAttachmentLine('[附件' + (r.memberCount > 1 ? '·' + r.memberCount + '成员' : '') + '] ' + (r.dest || f.name) + ' (' + fmtSize(f.size) + ')');
    } catch (e) {
      r.status = 'error';
      r.err = e.message || String(e);
      r.received = received; // 断点位置（提示可续传重试）
      renderRow(r);
    }
  }

  (async () => {
    for (const r of rows) await uploadOne(r);
    const okRows = rows.filter(r => r.status === 'done');
    if (okRows.length) {
      // 上传面板已逐行显示结果，收尾改为输入区就地提示，避免底部 toast 再盖住输入框
      pulseComposer();
      hintComposer('已上传 ' + okRows.length + '/' + rows.length + ' 个附件，路径已填入输入框');
    } else toast('附件上传失败（可点「断点续传重试」从断点继续）', true);
    if (rows.every(r => r.status === 'done')) setTimeout(() => { panel.style.display = 'none'; }, 2500);
  })();
}

function appendAttachmentLine(line) {
  const inp = $('input');
  inp.value = (inp.value ? inp.value.replace(/\\n$/, '') + '\\n' : '') + line;
  inp.focus();
}

// ---------- 输入框拖入 / 粘贴文件 → 自动上传（复用 uploadAttachments 逐文件进度面板） ----------
(function setupInputFileDrop() {
  const container = document.querySelector('.chat-input-container');
  const input = $('input');
  if (!container || !input) return;

  // 拖入：counter 方式避免子元素 dragleave 抖动
  let dragDepth = 0;
  container.addEventListener('dragenter', e => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    container.classList.add('drop-hover');
  });
  container.addEventListener('dragover', e => {
    if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    container.classList.add('drop-hover');
  });
  container.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) container.classList.remove('drop-hover');
  });
  container.addEventListener('drop', e => {
    e.preventDefault();
    dragDepth = 0;
    container.classList.remove('drop-hover');
    const files = Array.from(e.dataTransfer?.files || []);
    if (!files.length) return;
    if (!state.currentTaskId) { toast('请先选择或新建任务，再拖入附件', true); return; }
    uploadAttachments(files);
  });
  // 拖拽被系统/浏览器取消时兜底清高亮
  document.addEventListener('dragend', () => { dragDepth = 0; container.classList.remove('drop-hover'); });

  // 粘贴：剪贴板里有文件时拦截并自动上传（纯文本粘贴不受影响）
  input.addEventListener('paste', e => {
    const files = Array.from(e.clipboardData?.files || []);
    if (!files.length) return;
    e.preventDefault();
    if (!state.currentTaskId) { toast('请先选择或新建任务，再粘贴附件', true); return; }
    uploadAttachments(files);
  });
})();

// ---------- @ 提及自动联想组件 (Mentions Auto-complete) ----------
async function refreshMentionCandidates() {
  const r = await api('/mentions/candidates');
  if (r.ok && r.data) {
    mentionCandidates = r.data;
  } else {
    // 降级使用本地 state 聚合
    const list = [];
    (state.agents || []).forEach(a => {
      if (a.enabled !== false) {
        list.push({
          type: 'agent', id: a.id, name: a.name, kind: 'agent',
          detail: (a.dshRef && a.dshRef.kind) + ' · ' + (a.model ? String(a.model).split('/').pop() : '默认模型')
        });
      }
    });
    (state.resources || []).forEach(m => {
      list.push({
        type: 'resource', id: m.mappingId || m.id, name: m.appName || m.note || m.id, kind: m.kind || 'unknown',
        detail: (m.kind || '').toUpperCase() + ' · ' + (m.online ? '在线' : '离线')
      });
    });
    mentionCandidates = list;
  }
}

function initMentionPopup() {
  const input = $('input');
  const popup = $('mention-popup');
  const listEl = $('mention-list');
  if (!input || !popup || !listEl) return;

  function hidePopup() {
    popup.classList.remove('on');
    mentionMatched = [];
  }

  function renderMentionList() {
    if (!mentionMatched.length) {
      listEl.innerHTML = '<div class="mention-empty">无匹配的智能体或资源</div>';
      return;
    }
    let html = '';
    mentionMatched.forEach((item, idx) => {
      const active = idx === mentionActiveIdx ? ' active' : '';
      const icon = item.type === 'agent' ? '🤖' : (item.kind === 'ssh' ? '🖥️' : (item.kind === 'http' ? '🌐' : '📦'));
      const tagClass = item.type === 'agent' ? 'agent' : 'resource';
      const tagText = item.type === 'agent' ? '智能体' : (item.kind ? item.kind.toUpperCase() : '资源');
      html += '<div class="mention-item' + active + '" data-idx="' + idx + '">' +
        '<span class="icon">' + icon + '</span>' +
        '<div class="info">' +
          '<div class="name">' + esc(item.name) + '</div>' +
          (item.detail ? '<div class="desc">' + esc(item.detail) + '</div>' : '') +
        '</div>' +
        '<span class="tag ' + tagClass + '">' + esc(tagText) + '</span>' +
      '</div>';
    });
    listEl.innerHTML = html;

    listEl.querySelectorAll('.mention-item').forEach(el => {
      el.addEventListener('click', () => {
        const idx = +el.dataset.idx;
        insertMention(mentionMatched[idx]);
      });
    });

    const activeEl = listEl.querySelector('.mention-item.active');
    if (activeEl && typeof activeEl.scrollIntoView === 'function') activeEl.scrollIntoView({ block: 'nearest' });
  }

  function insertMention(item) {
    if (!item) return;
    const text = input.value;
    const before = text.slice(0, mentionCursorStart);
    const after = text.slice(input.selectionEnd);
    const insertText = '@' + item.name + ' ';
    input.value = before + insertText + after;
    const newPos = before.length + insertText.length;
    input.selectionStart = newPos;
    input.selectionEnd = newPos;
    hidePopup();
    input.focus();
  }

  input.addEventListener('input', () => {
    const text = input.value;
    const pos = input.selectionStart;
    const textBeforeCursor = text.slice(0, pos);

    // 匹配光标前最近的一个 @ 符号，允许资源名/智能体名内部含空格（如 "KB 136 环境-SSH Server"）
    const match = /@([^@]*)$/.exec(textBeforeCursor);
    if (!match) {
      hidePopup();
      return;
    }

    mentionCursorStart = match.index;
    mentionQuery = match[1].toLowerCase().trim();

    if (!mentionCandidates.length) refreshMentionCandidates();

    mentionMatched = mentionCandidates.filter(c => {
      if (!mentionQuery) return true;
      const n = (c.name || '').toLowerCase();
      const id = (c.id || '').toLowerCase();
      const d = (c.detail || '').toLowerCase();
      // 前缀匹配优先：允许多词名称随输入逐词匹配；其次兜底子串匹配
      return n.startsWith(mentionQuery) || n.includes(mentionQuery) || id.includes(mentionQuery) || d.includes(mentionQuery);
    });

    // 无匹配 → 隐藏弹窗，不显示「无匹配」空提示
    if (!mentionMatched.length) {
      hidePopup();
      return;
    }

    mentionActiveIdx = 0;
    renderMentionList();
    popup.classList.add('on');
  });

  input.addEventListener('keydown', e => {
    const isPopupOpen = popup.classList.contains('on') && mentionMatched.length > 0;
    if (isPopupOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mentionActiveIdx = (mentionActiveIdx + 1) % mentionMatched.length;
        renderMentionList();
        return;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        mentionActiveIdx = (mentionActiveIdx - 1 + mentionMatched.length) % mentionMatched.length;
        renderMentionList();
        return;
      } else if (e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        insertMention(mentionMatched[mentionActiveIdx]);
        return;
      } else if (e.key === 'Enter') {
        // 若弹窗中有多个选项或者用户主动用上下键选了某个非首项，优先插入；否则允许直接回车或按 Tab
        e.preventDefault();
        e.stopPropagation();
        insertMention(mentionMatched[mentionActiveIdx]);
        return;
      } else if (e.key === 'Escape') {
        hidePopup();
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  document.addEventListener('click', e => {
    if (!popup.contains(e.target) && e.target !== input) {
      hidePopup();
    }
  });
}

// ---------- 输入框 "/" 技能候选（对齐 harness ui-skill 触发源：候选来自会话技能目录，
// 选中插入字面 /name 随消息发送，远端 DSH 宿主 tool-skill pre-step 识别手势后把技能正文注入模型上下文） ----------
const skillPick = { taskId: '', list: [], fetchedAt: 0, matched: [], active: 0, span: null, supported: true };

/** 预热/刷新当前任务的技能目录（单次拉取全量，键入时本地过滤——对齐 harness 每会话一次 RPC） */
async function ensureSkillList() {
  const taskId = state.currentTaskId;
  if (!taskId) return false;
  if (skillPick.taskId !== taskId) { skillPick.taskId = taskId; skillPick.list = []; skillPick.fetchedAt = 0; skillPick.supported = true; }
  if (skillPick.list.length || Date.now() - skillPick.fetchedAt < 60_000 || !skillPick.supported) return skillPick.supported;
  try {
    const r = await api('/tasks/' + taskId + '/skills');
    if (r.ok) {
      skillPick.supported = r.data.supported !== false;
      skillPick.list = r.data.skills || [];
      skillPick.fetchedAt = Date.now();
    }
  } catch {}
  return skillPick.supported;
}

function initSkillPopup() {
  const input = $('input');
  const popup = $('skill-popup');
  const listEl = $('skill-list');
  if (!input || !popup || !listEl) return;

  function hideSkillPopup() {
    popup.classList.remove('on');
    skillPick.matched = [];
    skillPick.span = null;
  }

  /** 光标处的 / 触发 token（简化 harness detect.ts：词边界 + URL 排除）。注意：本文件是外层模板串，正则反斜杠需双写 */
  function detectSlash() {
    const text = input.value;
    const caret = input.selectionStart;
    if (caret === null || caret === undefined) return null;
    let start = caret;
    while (start > 0 && !/\\s/.test(text.charAt(start - 1))) start--;
    if (text.charAt(start) !== '/') return null;
    const prev = start > 0 ? text.charAt(start - 1) : '';
    if (prev === '/' || prev === ':') return null; // URL 的 // 与 scheme:/
    const token = text.slice(start, caret);
    const query = token.slice(1);
    if (query.includes('/') || query.length > 64) return null;
    return { start, end: caret, query };
  }

  function filterSkills(query) {
    const q = query.toLowerCase();
    if (!q) return skillPick.list.slice(0, 30);
    const starts = skillPick.list.filter(s => s.name.toLowerCase().startsWith(q));
    const seen = new Set(starts.map(s => s.name));
    for (const s of skillPick.list) {
      if (seen.has(s.name)) continue;
      if (s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q)) starts.push(s);
    }
    return starts.slice(0, 30);
  }

  function renderSkillList() {
    if (!skillPick.matched.length) {
      listEl.innerHTML = '<div class="mention-empty">无匹配技能</div>';
      return;
    }
    let html = '';
    skillPick.matched.forEach((item, idx) => {
      const active = idx === skillPick.active ? ' active' : '';
      const userOnly = item.userInvocable === false ? '<span class="tag">仅模型</span>' : '';
      const agents = (item.agents || []).join('、');
      html += '<div class="mention-item' + active + '" data-idx="' + idx + '">' +
        '<span class="icon">🎯</span>' +
        '<div class="info">' +
          '<div class="name">' + esc(item.name) + '</div>' +
          '<div class="desc">' + esc(item.description || '') + (agents ? ' · 可用: ' + esc(agents) : '') + '</div>' +
        '</div>' +
        userOnly +
      '</div>';
    });
    listEl.innerHTML = html;
    listEl.querySelectorAll('.mention-item').forEach(el => {
      el.addEventListener('click', () => {
        pickSkill(skillPick.matched[+el.dataset.idx]);
      });
    });
    const activeEl = listEl.querySelector('.mention-item.active');
    if (activeEl && typeof activeEl.scrollIntoView === 'function') activeEl.scrollIntoView({ block: 'nearest' });
  }

  function pickSkill(item) {
    if (!item || !skillPick.span) return;
    const s = skillPick.span;
    const before = input.value.slice(0, s.start);
    const after = input.value.slice(input.selectionEnd);
    const insertText = '/' + item.name + ' ';
    input.value = before + insertText + after;
    const newPos = before.length + insertText.length;
    input.selectionStart = newPos;
    input.selectionEnd = newPos;
    hideSkillPopup();
    input.focus();
  }

  input.addEventListener('input', async () => {
    const hit = detectSlash();
    if (!hit) { hideSkillPopup(); return; }
    skillPick.span = hit;
    const ok = await ensureSkillList();
    if (!ok) { hideSkillPopup(); return; }
    // 输入期间 span 可能因继续键入而变化，重新检测
    const fresh = detectSlash();
    if (!fresh) { hideSkillPopup(); return; }
    skillPick.span = fresh;
    skillPick.matched = filterSkills(fresh.query);
    if (!skillPick.matched.length) { hideSkillPopup(); return; }
    skillPick.active = 0;
    renderSkillList();
    popup.classList.add('on');
  });

  input.addEventListener('keydown', e => {
    const isOpen = popup.classList.contains('on') && skillPick.matched.length > 0;
    if (!isOpen) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopImmediatePropagation();
      skillPick.active = (skillPick.active + 1) % skillPick.matched.length;
      renderSkillList();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopImmediatePropagation();
      skillPick.active = (skillPick.active - 1 + skillPick.matched.length) % skillPick.matched.length;
      renderSkillList();
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      e.stopImmediatePropagation();
      pickSkill(skillPick.matched[skillPick.active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      hideSkillPopup();
    }
  });

  document.addEventListener('click', e => {
    if (!popup.contains(e.target) && e.target !== input) hideSkillPopup();
  });
}
initSkillPopup();

// ---------- 主智能体与主调度模型选择 ----------
const mainAgentState = {
  loaded: false,
  cur: '', // 配置的 agentId, '' 表示自动
  auto: true,
  resolvedAgentId: '',
  resolvedAgentName: '',
  agents: [],
  source: '',
  error: '',
};

/**
 * 本地即时应用主智能体选择：按钮文案、标题、弹层 ✓ 全部就地更新。
 * /planner/options 需要远端解析（首屏可耗时数百 ms），切换反馈不能等它。
 */
function applyMainAgentSelection(sel) {
  if (!sel) return;
  const agentId = sel.agentId === undefined ? mainAgentState.cur : String(sel.agentId || '');
  const auto = sel.auto === undefined ? !agentId : !!sel.auto;
  const resolvedId = String(sel.resolvedAgentId || (auto ? mainAgentState.resolvedAgentId : agentId) || '');
  const resolved = mainAgentState.agents.find(a => a.id === resolvedId);
  mainAgentState.cur = agentId;
  mainAgentState.auto = auto;
  mainAgentState.resolvedAgentId = resolvedId;
  if (sel.resolvedAgentName !== undefined) mainAgentState.resolvedAgentName = sel.resolvedAgentName;
  else if (resolved) mainAgentState.resolvedAgentName = resolved.name;
  mainAgentState.loaded = true;

  const nameEl = $('main-agent-btn-name');
  if (nameEl) nameEl.textContent = mainAgentBtnLabel();
  const btn = $('main-agent-btn');
  if (btn) btn.title = mainAgentBtnTitle();
  renderMainAgentPop();
  // 主智能体换了，气泡模型标签的归属也要跟着换
  refreshMainAgentModelBadges();
}

/**
 * 把服务端返回的任务摘要并回本地列表状态并立即重绘侧栏（无需刷新页面）。
 * 服务端在切换主智能体时会同步「当前会话 + 空草稿」的成员账本，这里负责让界面同帧跟上。
 */
function applyTaskSummaries(summaries) {
  const list = Array.isArray(summaries) ? summaries.filter(s => s && s.id) : [];
  if (!list.length) return;
  for (const s of list) {
    const idx = state.tasks.findIndex(t => t.id === s.id);
    if (idx >= 0) state.tasks[idx] = Object.assign({}, state.tasks[idx], s);
    else state.tasks.unshift(s);
    const cached = state.taskCache.get(s.id);
    // 缓存里是含 turns 的完整任务，只并成员/模式字段，绝不用摘要覆盖全文
    if (cached) state.taskCache.set(s.id, Object.assign({}, cached, { memberAgentIds: s.memberAgentIds, mode: s.mode }));
  }
  renderTaskList();
  if (list.some(s => s.id === state.currentTaskId)) refreshChatHead();
}

/** 主智能体当前生效的模型（模型列表选中值；未选中时回退其自身配置） */
function mainAgentEffectiveModel() {
  if (modelState.cur) return String(modelState.cur).split('/').pop();
  const mainId = mainAgentState.cur || mainAgentState.resolvedAgentId || '';
  const a = state.agents.find(x => x.id === mainId);
  return a && a.model ? String(a.model).split('/').pop() : '';
}

/**
 * 就地刷新聊天窗已渲染气泡的模型标签（与 buildTurnElement 同一判定）：
 * 主智能体 = 模型列表当前选中；其他智能体 = 各自配置。切换模型/主智能体后立即生效，无需刷新页面。
 */
function refreshMainAgentModelBadges() {
  const scroll = $('chat-scroll');
  if (!scroll) return;
  const mainId = mainAgentState.cur || mainAgentState.resolvedAgentId || '';
  const mainShort = mainAgentEffectiveModel();
  scroll.querySelectorAll('.msg.agent').forEach(wrap => {
    const aid = wrap.dataset.agentId || '';
    if (!aid) return;
    const a = state.agents.find(x => x.id === aid);
    const short = (aid === mainId) ? mainShort : (a && a.model ? String(a.model).split('/').pop() : '');
    const meta = wrap.querySelector('.meta');
    if (!meta) return;
    let tag = meta.querySelector('.tag-model');
    if (short) {
      if (!tag) {
        tag = document.createElement('span');
        tag.className = 'tag-model';
        const b = meta.querySelector('b');
        if (b && b.nextSibling) meta.insertBefore(tag, b.nextSibling);
        else meta.appendChild(tag);
      }
      tag.textContent = short;
    } else if (tag) {
      tag.remove();
    }
  });
}

function mainAgentBtnLabel() {
  if (!mainAgentState.loaded) return '默认智能体: 加载中…';
  if (mainAgentState.error) return '⚠️ 主智能体异常';
  if (mainAgentState.auto) {
    return '默认智能体: ' + (mainAgentState.resolvedAgentName || '自动') + '（自动）';
  }
  return '默认智能体: ' + (mainAgentState.resolvedAgentName || mainAgentState.cur || '未命名');
}

function mainAgentBtnTitle() {
  if (mainAgentState.error) return '⚠️ 规划器当前不可用：' + mainAgentState.error + '（点击切换）';
  return '当前主智能体（点击切换）· ' + (mainAgentState.auto ? '自动策略：本地/在线节点优先' : '固定指定') + (mainAgentState.source ? ' · 来源: ' + mainAgentState.source : '');
}

function renderMainAgentPop() {
  const pop = $('main-agent-pop');
  if (!pop) return;
  const isAuto = mainAgentState.auto;
  const curId = mainAgentState.cur;
  const resolvedName = mainAgentState.resolvedAgentName || '本地子智能体优先';
  let html = '<div class="main-agent-pop-head"><span>主智能体（Planner / 默认应答）</span><span>点选即切换</span></div>';

  // 1. 自动选择项
  html += '<div class="main-agent-item' + (isAuto ? ' on' : '') + '" data-id="">' +
    '<div class="ag-info">' +
      '<div class="ag-title">⚡（自动）' + esc(resolvedName) + '</div>' +
      '<div class="ag-sub">本地或在线 DSH 子智能体优先 · 智能动态兜底</div>' +
    '</div>' +
    '<span class="ag-ck">✓</span>' +
  '</div>';

  // 2. 全部子智能体列表
  const allAgents = mainAgentState.agents || [];
  if (allAgents.length) {
    html += '<div class="model-group" style="margin-top:4px">指定子智能体</div>';
    for (const a of allAgents) {
      const isSelected = !isAuto && curId === a.id;
      const detail = state.agents.find(x => x.id === a.id) || {};
      const subParts = [];
      // 正在充当主智能体的行显示模型列表当前选中的模型（运行时实际生效），其余行显示各自配置
      const isMainRow = isSelected || (isAuto && a.id === (mainAgentState.resolvedAgentId || ''));
      const effModel = isMainRow ? mainAgentEffectiveModel() : (detail.model ? String(detail.model).split('/').pop() : '');
      if (effModel) subParts.push('模型: ' + effModel);
      if (detail.workDir) subParts.push('目录: ' + detail.workDir);
      if (detail.dshRef && detail.dshRef.kind === 'direct') subParts.push('直连');
      else if (detail.dshRef && detail.dshRef.mappingId) subParts.push('ONENAT: ' + detail.dshRef.mappingId);
      const subInfo = subParts.join(' · ') || '子智能体';

      html += '<div class="main-agent-item' + (isSelected ? ' on' : '') + '" data-id="' + esc(a.id) + '">' +
        '<div class="ag-info">' +
          '<div class="ag-title">🤖 ' + esc(a.name || a.id) + '</div>' +
          '<div class="ag-sub">' + esc(subInfo) + '</div>' +
        '</div>' +
        '<span class="ag-ck">✓</span>' +
      '</div>';
    }
  } else if (!isAuto) {
    html += '<div class="model-empty">暂无可用子智能体</div>';
  }

  if (mainAgentState.error) {
    html += '<div class="model-empty" style="color:var(--err);font-size:11.5px">⚠️ ' + esc(mainAgentState.error) + '</div>';
  }

  pop.innerHTML = html;
  pop.querySelectorAll('.main-agent-item').forEach(it => {
    it.addEventListener('click', () => selectMainAgent(it.dataset.id));
  });
}

function closeMainAgentPop() {
  const p = $('main-agent-pop');
  if (p) p.classList.remove('on');
}

if ($('main-agent-btn')) {
  $('main-agent-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    closeModelPop();
    const pop = $('main-agent-pop');
    if (!pop) return;
    if (pop.classList.contains('on')) { closeMainAgentPop(); return; }
    renderMainAgentPop();
    pop.classList.add('on');
  });
}

async function selectMainAgent(agentId) {
  const targetId = (agentId || '').trim();
  const btn = $('main-agent-btn');
  closeMainAgentPop();

  const found = mainAgentState.agents.find(a => a.id === targetId);
  const displayName = targetId ? (found ? found.name : targetId) : '自动（本地优先）';

  const modelBtnEl = $('chat-model-btn');
  // 模型列表选中值在切换主智能体时保持不变（需求：主智能体模型 = 模型列表中选中的）。
  // 若新主智能体节点没有该模型，ensureSession 会话级下发失败时由远端默认兜底，选中态仍归用户。

  // 1) 就地切换：按钮/弹层 ✓ 先跟上，不等任何网络
  applyMainAgentSelection({ agentId: targetId, auto: !targetId });

  // 带上当前会话：服务端据此同步「当前会话 + 空草稿」的成员账本，侧栏列表立即更新
  const r = await api('/planner/config', {
    method: 'POST',
    body: JSON.stringify({ agentId: targetId, taskId: state.currentTaskId || '' })
  });

  if (r.ok) {
    // 2) 服务端权威结果覆盖本地（自动模式解析出的真实主智能体、成员账本同步后的任务摘要）；
    //    模型选中保持用户所选（d.model = settings.planner.model，切主智能体不重置）
    const d = r.data || {};
    modelState.cur = d.model || '';
    if (modelBtnEl) modelBtnEl.textContent = modelBtnLabel(modelState.cur);
    applyMainAgentSelection({
      agentId: d.agentId || '',
      auto: !d.agentId,
      resolvedAgentId: d.resolvedAgentId,
      resolvedAgentName: d.resolvedAgentName,
    });
    applyTaskSummaries(d.tasks);
    if (btn) flashBtnOk(btn, '✓ 已切为「' + displayName + '」', mainAgentBtnLabel());
    hintComposer('✓ 主智能体已切到「' + displayName + '」');
    loadPlannerOptions();
    if ($('set-planner-agent')) fillPlannerAgentSetting();
    if (state.currentTaskId) refreshChatHead();
  } else {
    toast(r.error || '切换主智能体失败', true);
    // 失败回滚到服务端真实状态，避免界面显示未生效的选择
    loadPlannerOptions();
  }
}

// ---------- 主调度模型选择（自定义弹层：原生 select 的移动端全屏弹窗字大折行且样式失控） ----------
const modelState = { groups: {}, cur: '', loaded: false, error: '' };
function modelBtnLabel(v) { return '⚙ ' + (v || '主调度默认模型'); }
function modelBtnTitle() { return '主调度模型 + 执行会话模型（点选即生效）'; }
function renderModelPop() {
  const pop = $('model-pop');
  const cur = modelState.cur;
  const known = Object.keys(modelState.groups).some(pv => (modelState.groups[pv] || []).some(m => pv + '/' + m.id === cur));
  let html = '<div class="model-pop-head"><span>主调度 + 执行会话模型</span><span>点选即生效</span></div>';
  html += '<div class="model-item' + (!cur ? ' on' : '') + '" data-v=""><span class="n">主调度默认模型</span><span class="ck">✓</span></div>';
  if (cur && !known) {
    html += '<div class="model-item on" data-v="' + esc(cur) + '"><span class="n">' + esc(cur + '（已保存）') + '</span><span class="ck">✓</span></div>';
  }
  for (const pv of Object.keys(modelState.groups)) {
    html += '<div class="model-group">' + esc(pv) + '</div>';
    for (const m of modelState.groups[pv]) {
      const v = pv + '/' + m.id;
      html += '<div class="model-item' + (v === cur ? ' on' : '') + '" data-v="' + esc(v) + '"><span class="n">' + esc(m.id + (m.isDefault ? ' ★' : '')) + '</span><span class="ck">✓</span></div>';
    }
  }
  if (!Object.keys(modelState.groups).length) {
    if (modelState.error) html += '<div class="model-empty" style="color:var(--err);font-size:11.5px">⚠️ 模型目录获取失败: ' + esc(modelState.error) + '</div>';
    else if (!cur) html += '<div class="model-empty">暂无可选模型</div>';
  }
  pop.innerHTML = html;
  pop.querySelectorAll('.model-item').forEach(it => it.addEventListener('click', () => selectModel(it.dataset.v)));
}
async function loadPlannerOptions() {
  const modelBtn = $('chat-model-btn');
  const agentBtn = $('main-agent-btn');
  if (modelBtn) modelBtn.disabled = true;
  if (agentBtn) agentBtn.disabled = true;

  const r = await api('/planner/options');
  if (!r.ok || !r.data) {
    if (modelBtn) modelBtn.disabled = false;
    if (agentBtn) agentBtn.disabled = false;
    return;
  }
  const d = r.data;

  // 1. 更新主智能体状态
  mainAgentState.agents = d.agents || [];
  mainAgentState.cur = (d.current || {}).agentId || '';
  mainAgentState.auto = (d.current || {}).auto !== false;
  mainAgentState.source = d.source || '';
  mainAgentState.error = d.error || '';
  const resolved = mainAgentState.agents.find(a => a.id === (d.current || {}).agentId);
  mainAgentState.resolvedAgentId = (d.current || {}).agentId || '';
  mainAgentState.resolvedAgentName = resolved ? resolved.name : ((d.current || {}).agentId || '');
  mainAgentState.loaded = true;

  if (agentBtn) {
    agentBtn.disabled = false;
    const nameEl = $('main-agent-btn-name');
    if (nameEl) nameEl.textContent = mainAgentBtnLabel();
    agentBtn.title = mainAgentBtnTitle();
    renderMainAgentPop();
  }

  // 2. 更新模型状态
  modelState.cur = (d.current || {}).model || '';
  modelState.groups = {};
  modelState.error = d.modelError || '';
  for (const m of d.models || []) { (modelState.groups[m.provider] = modelState.groups[m.provider] || []).push(m); }
  modelState.loaded = true;
  if (modelBtn) {
    modelBtn.disabled = false;
    modelBtn.textContent = modelBtnLabel(modelState.cur);
    modelBtn.title = modelBtnTitle() + ' · ' + Object.keys(modelState.groups).length + ' 个提供商 / ' + (d.models || []).length + ' 个模型';
    renderModelPop();
  }
  // 服务端权威状态到位后，气泡模型标签与之一致（主智能体 = 列表选中模型）
  refreshMainAgentModelBadges();
}
function closeModelPop() { $('model-pop').classList.remove('on'); }
$('chat-model-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  closeMainAgentPop();
  const pop = $('model-pop');
  if (pop.classList.contains('on')) { closeModelPop(); return; }
  renderModelPop();
  pop.classList.add('on');
});
document.addEventListener('click', (e) => {
  const modelPop = $('model-pop');
  if (modelPop && modelPop.classList.contains('on') && !modelPop.contains(e.target) && e.target !== $('chat-model-btn')) {
    closeModelPop();
  }
  const agentPop = $('main-agent-pop');
  if (agentPop && agentPop.classList.contains('on') && !agentPop.contains(e.target) && e.target !== $('main-agent-btn') && !($('main-agent-btn') && $('main-agent-btn').contains(e.target))) {
    closeMainAgentPop();
  }
});
/** 模型切换结果就地展示在 composer 工具条（替代底部 toast，不遮挡输入区），8s 后自动隐去 */
function setModelStatus(text) {
  const el = $('model-status');
  if (!el) return;
  if (el._h) clearTimeout(el._h);
  if (!text) { el.className = 'model-status'; el.textContent = ''; return; }
  el.textContent = text;
  el.className = 'model-status on ok';
  el._h = setTimeout(() => { el.className = 'model-status'; el.textContent = ''; el._h = null; }, 8000);
}
async function selectModel(v) {
  modelState.cur = v;
  const btn = $('chat-model-btn');
  btn.textContent = modelBtnLabel(v);
  closeModelPop();
  const shortModel = v ? (v.indexOf('/') >= 0 ? v.slice(v.indexOf('/') + 1).trim() : v) : '默认';
  // 1) 更新主调度模型（只写 planner 设置，不改写主智能体自身 provider/model 配置：
  //    「选中的模型」与「智能体默认模型」是两个概念，@ 子智能体仍按各自配置执行）
  const r = await api('/planner/config', { method: 'POST', body: JSON.stringify({ model: v || '' }) });
  // 气泡模型标签就地与新选中值对齐（主智能体 = 列表选中；其余 = 各自配置）
  if (r.ok) { refreshMainAgentModelBadges(); }
  // 2) 同步更新当前任务里主智能体执行会话的模型（不传 agentId，服务端默认作用于当前主智能体；PUT /sessions/:id 透传到远端 DSH）
  if (state.currentTaskId) {
    const slashIdx = v.indexOf('/');
    const provider = slashIdx >= 0 ? v.slice(0, slashIdx).trim() : '';
    const modelId = slashIdx >= 0 ? v.slice(slashIdx + 1).trim() : v;
    const sr = await api('/tasks/' + state.currentTaskId + '/session-model', {
      method: 'PUT',
      body: JSON.stringify({ provider: provider || undefined, model: modelId }),
    });
    if (sr.ok) {
      // 按钮原地点亮确认 + 工具条就地写明生效范围（不再弹 toast）
      flashBtnOk(btn, '✓ 已切换「' + modelId + '」', modelBtnLabel(v));
      setModelStatus('✓ 主智能体会话已切到「' + modelId + '」· 主调度「' + (v || '默认') + '」');
      return;
    }
    if (sr.code !== 'NO_SESSION') toast(sr.error || '执行会话模型更新失败', true);
  }
  if (r.ok) {
    flashBtnOk(btn, '✓ 已切换「' + shortModel + '」', modelBtnLabel(v));
    setModelStatus('✓ 主调度模型已切到「' + (v || '默认') + '」');
  } else {
    toast(r.error || '保存失败', true);
  }
}
loadPlannerOptions();

// ---------- 任务实时统计条（对齐 DSH web StatsLine：轮/步 · LLM/工具耗时 · 首 token/吞吐 · 缓存命中 · token 账本） ----------
const statsState = { timer: null, inFlight: false, lastRendered: '' };
function fmtStatsDuration(ms) {
  const s = ms / 1000;
  if (s < 60) return (Math.round(s * 10) / 10) + '秒';
  const whole = Math.round(s);
  return Math.floor(whole / 60) + '分' + (whole % 60) + '秒';
}
function fmtStatsTokens(n) {
  if (n >= 1e9) return (Math.round(n / 1e8) / 10) + 'G';
  if (n >= 1e6) return (Math.round(n / 1e5) / 10) + 'M';
  if (n >= 1e3) return (Math.round(n / 100) / 10) + 'K';
  return String(n);
}
function fmtCacheHit(read, billedInput) {
  if (!(billedInput > 0)) return null;
  const pct = (read / billedInput) * 100;
  if (pct >= 99.95) return '100';
  const rounded = Math.round(pct * 10) / 10;
  return rounded < 100 ? String(Math.round(pct)) : rounded.toFixed(1);
}
function renderTaskStats(stats) {
  const el = $('task-stats');
  if (!stats || (!stats.steps && !stats.outputTokens && !stats.inputTokens && !stats.cacheReadTokens)) {
    el.style.display = 'none';
    el.textContent = '';
    return;
  }
  const groups = [];
  if (stats.steps > 0) {
    groups.push(stats.turns + ' 轮 · ' + stats.steps + ' 步');
    const durations = [];
    if (stats.llmMs > 0) durations.push('LLM ' + fmtStatsDuration(stats.llmMs));
    if (stats.toolMs > 0) durations.push('工具调用 ' + fmtStatsDuration(stats.toolMs));
    if (durations.length) groups.push(durations.join(' · '));
    const speeds = [];
    if (stats.ttftSteps > 0) speeds.push('首 token 平均 ' + fmtStatsDuration(stats.ttftMs / stats.ttftSteps));
    if (stats.decodeMs > 0) speeds.push(Math.round(stats.decodeTokens / (stats.decodeMs / 1000)) + ' tok/s');
    if (speeds.length) groups.push(speeds.join(' · '));
  }
  const billedInput = (stats.inputTokens || 0) + (stats.cacheReadTokens || 0) + (stats.cacheWriteTokens || 0);
  const hasTokens = billedInput > 0 || (stats.outputTokens || 0) > 0;
  if (hasTokens) {
    const hit = fmtCacheHit(stats.cacheReadTokens || 0, billedInput);
    if (hit !== null) groups.push('缓存命中 ' + hit + '%');
    groups.push('输入 ' + fmtStatsTokens(billedInput) + ' tok · 输出 ' + fmtStatsTokens(stats.outputTokens || 0) + ' tok');
  }
  const line = groups.join(' | ');
  if (!line) { el.style.display = 'none'; return; }
  if (line !== statsState.lastRendered) {
    statsState.lastRendered = line;
    el.textContent = line;
    el.title = line;
  }
  el.style.display = '';
}
async function loadTaskStats() {
  const taskId = state.currentTaskId;
  if (!taskId || statsState.inFlight) return;
  statsState.inFlight = true;
  try {
    const r = await api('/tasks/' + taskId + '/stats');
    // 期间切走了会话则丢弃
    if (r.ok && state.currentTaskId === taskId) renderTaskStats(r.data && r.data.supported ? r.data.stats : null);
  } catch {}
  statsState.inFlight = false;
}
function resetTaskStats() {
  if (statsState.timer) { clearInterval(statsState.timer); statsState.timer = null; }
  statsState.lastRendered = '';
  const el = $('task-stats');
  if (el) { el.style.display = 'none'; el.textContent = ''; }
}
// 打开会话时启动轮询（5s），关闭/切换时重置；SSE turn_end 处也会即时刷新
function startTaskStatsPolling() {
  resetTaskStats();
  loadTaskStats();
  statsState.timer = setInterval(loadTaskStats, 5000);
}

// ---------- 任务清单坞（远端 DSH 会话的 todo_write 投影 + 运行时长，对齐 DSH web TodoPanel） ----------
// 数据链路：浏览器 → WorkBuddy /api/tasks/:id/todos → 远端 dsh-web-service GET /sessions/:id/todos。
// 运行时长在本地按「服务端 elapsedMs + 本地经过时间」递增，避免两端时钟漂移。
const todoState = { timer: null, tick: null, inFlight: false, visible: false, running: false, baseElapsed: 0, anchorAt: 0, lastHtml: '', collapsed: false };
try { todoState.collapsed = localStorage.getItem('wb.todoCollapsed') === '1'; } catch (e) {}
function fmtTodoDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  if (h > 0) return h + '小时' + m + '分';
  if (m > 0) return m + '分' + (s < 10 ? '0' + s : String(s)) + '秒';
  return total + '秒';
}
function todoGlyph(status) {
  if (status === 'completed') {
    return '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6.4" stroke="currentColor" stroke-width="1.2"/><path d="M4.3 7.2l1.8 1.8 3.6-3.9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  // in_progress = 会话运行中（蓝色渐隐环 + 旋转）；unfinished = 会话已结束但模型没标完成（琥珀色静态环，不转）
  if (status === 'in_progress' || status === 'unfinished') {
    const spin = status === 'in_progress' ? ' class="todo-spin"' : '';
    return '<svg' + spin + ' width="14" height="14" viewBox="0 0 14 14" fill="none"><defs><linearGradient id="todo-grad" x1="2.5" y1="12" x2="10.5" y2="3.5" gradientUnits="userSpaceOnUse"><stop stop-color="currentColor"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><circle cx="7" cy="7" r="6.4" stroke="url(#todo-grad)" stroke-width="1.4"/></svg>';
  }
  return '<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6.4" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2.4 2.4"/></svg>';
}
function setTodoCollapsedUI() {
  const list = $('todo-list'); const chev = $('todo-chev');
  if (chev) chev.textContent = todoState.collapsed ? '▾' : '▴';
  if (list) list.style.display = todoState.collapsed ? 'none' : '';
}
function renderTodoDock(data) {
  const dock = $('todo-dock');
  if (!dock) return;
  const todos = Array.isArray(data && data.todos) ? data.todos : [];
  const running = !!(data && data.running);
  const elapsed = (data && data.elapsedMs) || 0;
  if (!todos.length && !running && !(elapsed > 0)) {
    dock.style.display = 'none';
    todoState.visible = false;
    return;
  }
  dock.style.display = '';
  todoState.visible = true;
  const c = (data && data.counts) || { completed: 0, inProgress: 0, pending: 0 };
  const parts = [];
  if (c.completed > 0) parts.push(c.completed + ' 已完成');
  // 会话已结束（running=false）时，模型遗留的 in_progress 条目是「未完成」而不是「进行中」——
  // 否则远端任务早已跑完，前端却一直显示运行中（蓝色转圈）。
  if (c.inProgress > 0) parts.push(c.inProgress + (running ? ' 进行中' : ' 未完成'));
  if (c.pending > 0) parts.push(c.pending + ' 待处理');
  const prog = $('todo-progress');
  if (prog) prog.textContent = parts.length ? parts.join(' · ') : (todos.length ? todos.length + ' 项' : '本轮暂无清单');
  // 运行时长：服务端 elapsedMs 为锚点，前端每秒本地递增（运行中）
  todoState.running = running;
  todoState.baseElapsed = elapsed;
  todoState.anchorAt = Date.now();
  const el = $('todo-elapsed');
  if (el) {
    if (running || elapsed > 0) {
      el.style.display = '';
      el.className = 'todo-elapsed' + (running ? ' run' : '');
      el.textContent = (running ? '⏱ 运行时长 ' : '⏱ 上轮时长 ') + fmtTodoDuration(elapsed);
      el.title = running
        ? '远端 DSH 会话本轮运行中（本地每秒递增）'
        : '远端 DSH 会话最后一轮运行时长';
    } else {
      el.style.display = 'none';
    }
  }
  const list = $('todo-list');
  if (!list) return;
  if (!todos.length) {
    list.innerHTML = '<li class="todo-empty">主智能体本轮尚未写入任务清单（todo_write）</li>';
    setTodoCollapsedUI();
    todoState.lastHtml = '';
    return;
  }
  const items = todos.map(function (it) {
    const raw = it && it.status;
    const st = raw === 'completed' ? 'completed' : (raw === 'in_progress' ? (running ? 'in_progress' : 'unfinished') : 'pending');
    const title = st === 'unfinished' ? ' title="本轮已结束，该任务仍停留在进行中（未完成）"' : '';
    return '<li class="todo-item" data-status="' + st + '"' + title + '><span class="g">' + todoGlyph(st) + '</span><span class="c">' + esc(it && it.content) + '</span></li>';
  }).join('');
  if (items !== todoState.lastHtml) {
    todoState.lastHtml = items;
    list.innerHTML = items;
  }
  setTodoCollapsedUI();
}
function tickTodoElapsed() {
  if (!todoState.visible || !todoState.running) return;
  const el = $('todo-elapsed');
  if (!el) return;
  el.textContent = '⏱ 运行时长 ' + fmtTodoDuration(todoState.baseElapsed + (Date.now() - todoState.anchorAt));
}
async function loadTaskTodos() {
  const taskId = state.currentTaskId;
  if (!taskId || todoState.inFlight) return;
  todoState.inFlight = true;
  try {
    const r = await api('/tasks/' + taskId + '/todos');
    if (state.currentTaskId !== taskId) return; // 已切走：丢弃旧响应
    if (!r.ok || !r.data || r.data.supported === false) {
      const dock = $('todo-dock');
      if (dock) dock.style.display = 'none';
      todoState.visible = false;
      return;
    }
    renderTodoDock(r.data);
  } catch (e) {
  } finally {
    todoState.inFlight = false;
  }
}
function resetTaskTodos() {
  if (todoState.timer) { clearInterval(todoState.timer); todoState.timer = null; }
  if (todoState.tick) { clearInterval(todoState.tick); todoState.tick = null; }
  todoState.inFlight = false; todoState.visible = false; todoState.running = false;
  todoState.baseElapsed = 0; todoState.lastHtml = '';
  const dock = $('todo-dock');
  if (dock) dock.style.display = 'none';
}
// 打开会话时启动轮询（3s，清单随 todo_write 步进变化）+ 运行时长 1s 本地递增；SSE turn_end 处即时刷新
function startTaskTodosPolling() {
  resetTaskTodos();
  loadTaskTodos();
  todoState.timer = setInterval(loadTaskTodos, 3000);
  todoState.tick = setInterval(tickTodoElapsed, 1000);
}
$('todo-head').addEventListener('click', () => {
  todoState.collapsed = !todoState.collapsed;
  try { localStorage.setItem('wb.todoCollapsed', todoState.collapsed ? '1' : '0'); } catch (e) {}
  setTodoCollapsedUI();
});

// 会话重命名（删除/归档入口在会话抽屉的会话条目上）
$('btn-rename-task').addEventListener('click', () => {
  const t = state.tasks.find(x => x.id === state.currentTaskId);
  if (t) promptRenameTask(t);
});
$('chat-title').addEventListener('dblclick', () => {
  const t = state.tasks.find(x => x.id === state.currentTaskId);
  if (t) promptRenameTask(t);
});

// ---------- 一键新建任务（免弹窗，自动生成会话并即刻开聊，参考 DSH 体验） ----------
$('btn-new-task').addEventListener('click', createNewTaskDirectly);
async function createNewTaskDirectly() {
  // 不指定成员：由服务端按「主智能体」默认归属（engine.defaultMemberAgentIds，与无 @ 消息的路由判定同源）。
  // 历史实现传 state.agents.map(...) 全部子智能体，导致无 @ 的新任务被放大成全员编排，
  // 且上传附件时会向所有成员节点扇出（每个成员都被建远端会话）。
  const proj = state.projectId ? state.projects.find(function (x) { return x.id === state.projectId; }) : null;
  const env = state.taskEnv || {};
  const body = {
    title: '新任务',
  };
  if (proj) { body.projectId = proj.id; body.memberAgentIds = proj.expertIds; if (proj.skillNames.length) body.skillNames = proj.skillNames; if (proj.connectorIds.length) body.connectorIds = proj.connectorIds; }
  if (env.nodeRef) body.nodeRef = env.nodeRef;
  if (env.connectorIds && env.connectorIds.length) body.connectorIds = env.connectorIds;
  if (env.skillNames && env.skillNames.length) body.skillNames = env.skillNames;
  const r = await api('/tasks', {
    method: 'POST',
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    toast(r.error || '创建会话失败', true);
    return;
  }
  await loadTasks();
  await openTask(r.data.id);
  const input = $('input');
  if (input) input.focus();
}
function closeModal() { $('modal-mask').classList.remove('on'); }

// ---------- 资源目录视图 ----------
$('btn-res-refresh').addEventListener('click', async () => {
  toast('刷新中…');
  await api('/resources/refresh', { method: 'POST' });
  await loadResources();
  renderResources();
  toast('已刷新');
});
function renderResources() {
  const tb = $('res-table').querySelector('tbody'); tb.innerHTML = '';
  $('res-sub').textContent = state.resources.length ? ('共 ' + state.resources.length + ' 个映射 · 快照时间 ' + fmtTime(state.resources[0].resolvedAt)) : 'ONENAT 未连接或无资源';
  let lastTunnel = '';
  for (const ep of state.resources) {
    if (ep.tunnelName !== lastTunnel) {
      lastTunnel = ep.tunnelName;
      const tr = document.createElement('tr'); tr.className = 'tunnel-row';
      tr.innerHTML = '<td colspan="5">🕳 ' + esc(ep.tunnelName) + ' · ' + (ep.online ? '在线' : '离线') + '</td>';
      tb.appendChild(tr);
    }
    const tr = document.createElement('tr');
    const kindTag = { dsh: 'dsh', ssh: 'ssh' }[ep.kind] || '';
    const entry = ep.kind === 'ssh' ? ('ssh -p ' + ep.port + ' @' + ep.host) : (ep.baseUrl || (ep.host + ':' + (ep.port || '')));
    tr.innerHTML = '<td>' + esc(ep.appName || ep.note || ep.mappingId) + '<span class="dot2 ' + (ep.online ? 'ok' : 'err') + '" title="' + (ep.online ? '在线' : '离线') + '"></span></td>' +
      '<td><span class="tag ' + kindTag + '">' + esc(ep.kind) + '</span></td>' +
      '<td class="mono">' + esc(entry) + '</td><td class="mono">' + esc(ep.local) + '</td>' +
      '<td class="mono">' + ((ep.appSkills || []).map(s => esc(s.name)).join(', ') || '—') + '</td>';
    tb.appendChild(tr);
  }
}

// ---------- 子智能体视图 ----------
$('btn-new-agent').addEventListener('click', () => openAgentDrawer(null));
function renderAgents() {
  const el = $('agent-list'); el.innerHTML = '';
  if (!state.agents.length) {
    el.innerHTML = '<div class="card"><span class="sub" style="color:var(--tx3)">还没有子智能体。点击「新建子智能体」—— 从资源目录中选择一个 DSH 节点（稳定 ID 绑定，端口变化不影响），配置提示词与可用连接器。</span></div>';
    return;
  }
  for (const a of state.agents) {
    const card = document.createElement('div'); card.className = 'card';
    const dshDesc = describeDshRef(a);
    const resDesc = (a.resources || []).map(r => r.alias || r.ref.mappingId || r.ref.appId).join('、') || '无';
    const skillNames = (a.skills || []).filter(Boolean);
    const skillDesc = skillNames.length ? skillNames.map(esc).join('、') : '无';
    card.innerHTML = '<div class="row1"><h3>' + esc(a.name) + '</h3>' +
      (a.enabled === false ? '<span class="tag err">停用</span>' : '<span class="tag ok">启用</span>') +
      '<span class="tag">' + esc(a.agentPreset || 'cordis') + '</span>' +
      (a.model ? '<span class="tag">' + esc(a.model) + '</span>' : '') +
      (a.workDir ? '<span class="tag" title="远端工作目录">📁 ' + esc(a.workDir) + '</span>' : '') +
      (skillNames.length ? '<span class="tag" title="绑定技能（派发时手势加载）">🎯 ' + skillNames.length + ' 技能</span>' : '') + '</div>' +
      '<div class="desc">DSH 实体: <span class="mono">' + esc(dshDesc) + '</span><br>绑定资源: ' + esc(resDesc) +
      '<br>绑定技能: <span class="mono">' + (skillNames.length ? skillNames.map(s => '<span class="tag" style="margin:2px 4px 2px 0">🎯 ' + esc(s) + '</span>').join('') : '<span class="sub">无</span>') + '</span>' +
      (a.systemPrompt ? '<br>角色: ' + esc(a.systemPrompt.slice(0, 80)) : '') + '</div>' +
      '<div class="ops"><button class="btn" data-op="edit">编辑</button><button class="btn" data-op="ping">Ping 探活</button><button class="btn" data-op="preview">提示词预览</button><button class="btn" data-op="skills">🎯 技能</button><button class="btn danger" data-op="del">删除</button></div>';
    card.querySelector('[data-op=edit]').addEventListener('click', () => openAgentDrawer(a));
    card.querySelector('[data-op=skills]').addEventListener('click', () => openSkillCenter(a));
    card.querySelector('[data-op=ping]').addEventListener('click', async () => {
      toast('探测中…');
      const r = await api('/agents/' + a.id + '/ping', { method: 'POST' });
      const p = r.data && r.data.ping;
      if (p && p.ok) toast('✓ ' + a.name + ' 在线 · ' + (p.name || '') + ' v' + (p.version || '?') + (r.data.resolved ? ' · ' + r.data.resolved.baseUrl : ''));
      else toast('✗ ' + a.name + ' 不可达: ' + ((p && p.error) || '未知'), true);
    });
    card.querySelector('[data-op=preview]').addEventListener('click', async () => {
      toast('合成提示词中…');
      const r = await api('/agents/' + a.id + '/prompt-preview');
      if (!r.ok) { toast(r.error, true); return; }
      openModal('资源提示词预览（脱敏）', '<div class="pre-block">' + esc(r.data.full || '(空)') + '</div>' + (r.data.warnings && r.data.warnings.length ? '<div style="color:var(--warn);font-size:12px;margin-top:8px">⚠ ' + r.data.warnings.map(esc).join('；') + '</div>' : ''));
    });
    card.querySelector('[data-op=del]').addEventListener('click', async () => {
      if (!confirm('删除子智能体「' + a.name + '」？')) return;
      await api('/agents/' + a.id, { method: 'DELETE' }); await loadAgents(); renderAgents(); toast('已删除');
    });
    el.appendChild(card);
  }
}
function describeDshRef(a) {
  if (!a.dshRef) return '(未绑定)';
  if (a.dshRef.kind === 'direct') return '直连 ' + a.dshRef.apiBaseUrl;
  if (a.dshRef.kind === 'mapping') {
    const ep = state.resources.find(x => x.mappingId === a.dshRef.mappingId);
    return '映射 ' + a.dshRef.mappingId + (ep ? ' → ' + (ep.baseUrl || '离线') : '（未在目录发现）');
  }
  const ep = state.resources.find(x => x.appId === a.dshRef.appId);
  return '应用 ' + a.dshRef.appId + (ep ? ' → ' + (ep.baseUrl || '离线') : '');
}

// ---------- 技能中心（管理 + 绑定子智能体节点的技能） ----------
let skillCenterAgent = null; // 当前技能中心对应的子智能体
async function openSkillCenter(agent) {
  skillCenterAgent = agent;
  openDrawer('🎯 技能中心 · ' + (agent.name || agent.id));
  $('drawer-body').innerHTML =
    '<div class="hint" id="sk-hint">加载该节点的技能列表…</div>' +
    '<div id="sk-body"></div>';
  await loadSkillCenter();
}
async function loadSkillCenter() {
  const a = skillCenterAgent;
  if (!a) return;
  const body = $('sk-body');
  $('sk-hint').textContent = '加载中…';
  const r = await api('/agents/' + a.id + '/skills');
  if (!r.ok) {
    $('sk-hint').textContent = '✗ ' + (r.error || '加载失败');
    return;
  }
  $('sk-hint').textContent = '';
  const d = r.data || {};
  const skills = (d.skills || []).map(s => ({
    name: s.name, description: s.description, path: s.path, root: s.root,
    modelInvocable: s.modelInvocable !== false, userInvocable: !!s.userInvocable,
    whenToUse: s.whenToUse, size: s.size,
  }));
  const bound = new Set(d.bindings || []);
  if (d.unsupported) {
    $('sk-hint').textContent = '⚠ ' + (d.error || '远端 dsh-web-service 未暴露 /skills 端点');
    body.innerHTML = '';
    return;
  }
  const rows = skills.map((s, i) => skillRowHtml(s, bound.has(s.name), i)).join('');
  body.innerHTML =
    '<div style="margin-bottom:12px;background:var(--bg2);padding:12px;border-radius:8px">' +
    '<div class="field" style="margin:0"><label>上传技能（整包压缩包 .zip/.tgz，含 SKILL.md 与 references/）</label>' +
    '<div style="display:flex;gap:8px;align-items:center"><input type="file" id="sk-file" accept=".zip,.tgz,.tar.gz,.gz" style="flex:1">' +
    '<button class="mini-btn" id="sk-up" style="padding:10px 14px">⬆ 上传</button></div>' +
    '<div class="hint">解压后自动识别技能名；同名覆盖。上传到该节点的「用户技能」目录。</div></div></div>' +
    '<div class="field"><label>已安装技能（' + skills.length + ' 个）· 勾选 = 绑定到该子智能体（派发时以 /名 手势提示 DSH 加载，技能须已安装在节点上，最多 20 个）</label>' +
    '<div id="sk-list" style="display:flex;flex-direction:column;gap:8px">' +
    (rows || '<div class="card"><span class="sub">该节点暂无技能，上传一个技能包开始。</span></div>') + '</div></div>' +
    '<div class="ops" style="display:flex;gap:10px;margin-top:14px"><button class="btn pri" id="sk-save">保存绑定</button><button class="btn" id="sk-close">关闭</button></div>';
  // 绑定切换（本地集合，保存时才提交）
  const bindSel = new Set(bound);
  body.querySelectorAll('.sk-bind').forEach(cb => {
    cb.addEventListener('change', () => {
      const name = cb.dataset.name;
      if (cb.checked) bindSel.add(name); else bindSel.delete(name);
      if (bindSel.size > 20) {
        cb.checked = false; bindSel.delete(name);
        toast('最多绑定 20 个技能', true);
      }
    });
  });
  body.querySelectorAll('[data-sk=preview]').forEach(btn => btn.addEventListener('click', async () => {
    const name = btn.dataset.name;
    toast('加载技能「' + name + '」…');
    const p = await api('/agents/' + a.id + '/skills/preview?name=' + encodeURIComponent(name));
    if (!p.ok || !p.data) { toast(p.error || '预览失败', true); return; }
    const s = p.data;
    openModal('技能预览 · ' + s.name,
      '<div class="sub" style="margin-bottom:6px">' + esc(s.path || '') + '</div>' +
      '<div class="tag ok">可模型调用</div><div class="tag">' + (s.userInvocable ? '用户可调用' : '仅模型') + '</div>' +
      '<div class="pre-block" style="max-height:52vh;overflow:auto">' + esc(s.raw || s.content || '') + '</div>');
  }));
  body.querySelectorAll('[data-sk=del]').forEach(btn => btn.addEventListener('click', async () => {
    const name = btn.dataset.name;
    if (!confirm('删除技能「' + name + '」？')) return;
    const del = await api('/agents/' + a.id + '/skills/' + encodeURIComponent(name), { method: 'DELETE' });
    if (!del.ok) { toast(del.error || '删除失败', true); return; }
    toast('已删除 ' + name); await loadSkillCenter();
  }));
  // 下载 SKILL.md
  body.querySelectorAll('[data-sk=dl]').forEach(btn => btn.addEventListener('click', () => {
    const name = btn.dataset.name;
    fetch(API + '/agents/' + a.id + '/skills/' + encodeURIComponent(name) + '/download').then(r => {
      if (!r.ok) { toast('下载失败', true); return; }
      return r.blob();
    }).then(b => {
      const url = URL.createObjectURL(b);
      const link = document.createElement('a'); link.href = url; link.download = name + '.tgz';
      document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
    }).catch(() => toast('下载失败', true));
  }));
  // 上传
  $('sk-up').addEventListener('click', async () => {
    const input = $('sk-file');
    if (!input.files || !input.files[0]) { toast('请先选择技能压缩包', true); return; }
    const fd = new FormData();
    fd.append('file', input.files[0]);
    toast('上传中…');
    const up = await apiPostMulti('/agents/' + a.id + '/skills/upload', fd);
    if (!up.ok) { toast(up.error || '上传失败', true); return; }
    toast('✓ 技能已安装 ' + (up.data && up.data.name || '')); await loadSkillCenter();
  });
  $('sk-save').addEventListener('click', async () => {
    const skills = Array.from(bindSel);
    const save = await api('/agents/' + a.id + '/skills/bindings', { method: 'POST', body: JSON.stringify({ skills }) });
    if (!save.ok) { toast(save.error || '保存失败', true); return; }
    toast('✓ 已保存 ' + skills.length + ' 个绑定技能'); await loadAgents(); renderAgents();
  });
  $('sk-close').addEventListener('click', closeDrawer);
}
function skillRowHtml(s, bound, i) {
  const tags = [s.modelInvocable ? '模型可调用' : '仅用户', s.userInvocable ? '用户可调用' : ''].filter(Boolean)
    .map(t => '<span class="tag">' + t + '</span>').join('');
  return '<div class="card" style="margin:0">' +
    '<div class="row1" style="align-items:center"><label style="display:flex;align-items:center;gap:8px;flex:1;min-width:0">' +
    '<input type="checkbox" class="sk-bind" data-name="' + esc(s.name) + '"' + (bound ? ' checked' : '') + ' style="width:16px;height:16px">' +
    '<span class="mono" style="font-weight:600">' + esc(s.name) + '</span>' + tags + '</label>' +
    '<span class="sub" style="flex:none">' + (s.size ? (s.size > 1024 ? (s.size / 1024).toFixed(1) + 'KB' : s.size + 'B') : '') + '</span></div>' +
    '<div class="desc">' + esc(s.description || '') + (s.path ? '<br><span class="mono" style="color:var(--tx3);font-size:11px">' + esc(s.path) + '</span>' : '') + '</div>' +
    '<div class="ops" style="margin-top:6px"><button class="mini-btn" data-sk="preview" data-name="' + esc(s.name) + '">预览</button>' +
    '<button class="mini-btn" data-sk="dl" data-name="' + esc(s.name) + '">打包下载</button>' +
    '<button class="mini-btn danger" data-sk="del" data-name="' + esc(s.name) + '">删除</button></div></div>';
}

function openAgentDrawer(agent) {
  const isEdit = Boolean(agent);
  openDrawer(isEdit ? '编辑子智能体' : '新建子智能体');
  const dshOptions = state.resources.filter(x => x.kind === 'dsh' && x.online)
    .map(x => '<option value="mapping:' + esc(x.mappingId) + '">' + esc(x.tunnelName + ' · ' + (x.appName || x.note) + ' → ' + x.baseUrl) + '</option>').join('');
  const resOptions = state.resources.map(x => '<option value="' + esc(x.mappingId) + '">' + esc('[' + x.kind + '] ' + x.tunnelName + ' · ' + (x.appName || x.note || x.mappingId) + (x.online ? '' : '（离线）')) + '</option>').join('');
  const binds = (agent && agent.resources || []).map((r, i) => bindRowHtml(r, i, resOptions)).join('');
  $('drawer-body').innerHTML =
    '<div class="field"><label>名称</label><input id="ag-name" value="' + esc(agent ? agent.name : '') + '" placeholder="如: 136-执行者 / 169-质检员"></div>' +
    '<div class="field"><label>DSH 实体（稳定 ID 绑定 · 端口漂移免疫）</label><select id="ag-dsh"><option value="">— 选择 ONENAT 上的 DSH 实例 —</option>' + dshOptions +
      '<option value="direct:">直连地址（手工输入）…</option></select>' +
      '<input id="ag-direct" placeholder="http://host:port/api/v1" style="display:none;margin-top:8px">' +
      '<div class="hint">列表来自资源目录中 type=http-api 且带 dsh-web-service 技能的映射。</div></div>' +
    '<div class="field"><label>API Key（可选）</label><input id="ag-key" value="' + esc(agent && agent.apiKey || '') + '"></div>' +
    '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px"><button class="mini-btn" id="ag-sync" style="padding:6px 10px;flex:none;white-space:nowrap">↻ 同步远端选项</button><span class="hint" id="ag-opts-hint" style="margin:0">预设 / 提供商 / 模型可从远端 DSH 拉取后下拉选择</span></div>' +
    '<div class="grid3">' +
    '<div class="field"><label>模式预设 agentPreset</label><input id="ag-preset" value="' + esc(agent && agent.agentPreset || 'cordis') + '"></div>' +
    '<div class="field"><label>Provider</label><input id="ag-provider" value="' + esc(agent && agent.provider || '') + '" placeholder="远端默认"></div>' +
    '<div class="field"><label>Model</label><input id="ag-model" value="' + esc(agent && agent.model || '') + '" placeholder="远端默认"></div></div>' +
    '<div class="field"><label>工作目录（绝对路径 · 对齐 DSH 工作区）</label><div style="display:flex;gap:8px"><input id="ag-workdir" value="' + esc(agent && agent.workDir || '') + '" placeholder="如 /data/panzj/workspace/demo"><button class="mini-btn" id="ag-browse" style="flex:none;padding:10px 12px" title="浏览远端目录并选择">📁 浏览</button></div>' +
    '<div class="hint">该成员远端会话的 cwd：文件工具根目录、附件落盘处。</div></div>' +
    '<div class="field"><label>角色提示词 systemPrompt</label><textarea id="ag-sp" placeholder="你是……负责……">' + esc(agent && agent.systemPrompt || '') + '</textarea></div>' +
    '<div class="field"><label>可用资源绑定（连接方式+技能将注入该智能体的提示词）</label><div id="bind-list">' + binds + '</div>' +
    '<button class="mini-btn" id="bind-add" style="margin-top:4px">＋ 添加资源绑定</button></div>' +
    '<div class="ops" style="display:flex;gap:10px;margin-top:14px"><button class="btn pri" id="ag-save">保存</button><button class="btn" id="ag-cancel">取消</button></div>';

  const dshSel = $('ag-dsh'), directInput = $('ag-direct');
  if (isEdit && agent.dshRef) {
    if (agent.dshRef.kind === 'mapping') dshSel.value = 'mapping:' + agent.dshRef.mappingId;
    else if (agent.dshRef.kind === 'direct') { dshSel.value = 'direct:'; directInput.style.display = ''; directInput.value = agent.dshRef.apiBaseUrl; }
  }
  dshSel.addEventListener('change', () => { directInput.style.display = dshSel.value === 'direct:' ? '' : 'none'; });
  $('bind-add').addEventListener('click', () => {
    const div = document.createElement('div');
    div.innerHTML = bindRowHtml({ ref: { kind: 'mapping', mappingId: '' }, credentialMode: 'self-fetch', skillMode: 'all' }, Date.now(), resOptions);
    $('bind-list').appendChild(div.firstElementChild);
    wireBindRows();
  });
  $('ag-cancel').addEventListener('click', closeDrawer);
  $('ag-browse').addEventListener('click', async () => {
    const saved = collectAgent(isEdit ? agent : null);
    if (!saved) return;
    toast('保存并解析远端节点…');
    const r = await api('/agents', { method: 'POST', body: JSON.stringify(saved) });
    if (!r.ok) { toast(r.error || '保存失败', true); return; }
    await loadAgents(); renderAgents();
    openDirBrowser(r.data.id, p => { const inp = $('ag-workdir'); if (inp) inp.value = p; });
  });
  $('ag-sync').addEventListener('click', async () => {
    const btn = $('ag-sync'), hint = $('ag-opts-hint');
    const saved = collectAgent(isEdit ? agent : null);
    if (!saved) return;
    btn.disabled = true; btn.textContent = '↻ 同步中…'; hint.textContent = '正在保存并从远端拉取…';
    try {
      const r = await api('/agents', { method: 'POST', body: JSON.stringify(saved) });
      if (!r.ok) throw new Error(r.error || '保存失败');
      const [pr, mr] = await Promise.all([api('/agents/' + r.data.id + '/presets'), api('/agents/' + r.data.id + '/models')]);
      const presets = ((pr.ok && pr.data.presets) || []).map(p => p.id).filter(Boolean);
      const models = (mr.ok && mr.data.models) || [];
      if (!presets.length && !models.length) {
        const e = pr.error || mr.error || '远端未返回预设/模型';
        hint.textContent = '同步失败: ' + e;
        toast(e, true); return;
      }
      const curPreset = $('ag-preset').value.trim();
      const curProvider = $('ag-provider').value.trim();
      const curModel = $('ag-model').value.trim();
      const providers = [];
      for (const m of models) if (m.provider && !providers.includes(m.provider)) providers.push(m.provider);
      const presetOpts = presets.slice();
      if (curPreset && !presetOpts.includes(curPreset)) presetOpts.unshift(curPreset);
      $('ag-preset').outerHTML = '<select id="ag-preset">' + presetOpts.map(p => '<option value="' + esc(p) + '"' + (p === curPreset ? ' selected' : '') + '>' + esc(p === curPreset && !presets.includes(p) ? p + '（当前）' : p) + '</option>').join('') + '</select>';
      $('ag-provider').outerHTML = '<select id="ag-provider"><option value=""' + (!curProvider ? ' selected' : '') + '>远端默认</option>' + providers.map(p => '<option value="' + esc(p) + '"' + (p === curProvider ? ' selected' : '') + '>' + esc(p) + '</option>').join('') + '</select>';
      function modelOpts(provider, cur) {
        const list = provider ? models.filter(m => m.provider === provider) : models;
        return '<option value=""' + (!cur ? ' selected' : '') + '>远端默认</option>' + list.map(m =>
          '<option value="' + esc(m.id) + '"' + (m.id === cur ? ' selected' : '') + '>' + esc(m.id + (m.isDefault ? '（默认）' : '') + (provider ? '' : ' · ' + m.provider)) + '</option>').join('');
      }
      $('ag-model').outerHTML = '<select id="ag-model">' + modelOpts(curProvider, curModel) + '</select>';
      $('ag-provider').addEventListener('change', () => {
        const pv = $('ag-provider').value;
        const cur = $('ag-model').value;
        $('ag-model').outerHTML = '<select id="ag-model">' + modelOpts(pv, cur) + '</select>';
      });
      hint.textContent = '✓ 已同步 ' + presets.length + ' 个预设 · ' + providers.length + ' 个提供商 · ' + models.length + ' 个模型';
      toast('✓ 远端选项已同步');
    } catch (e) {
      hint.textContent = '同步失败: ' + (e.message || e);
      toast(e.message || '同步失败', true);
    } finally {
      btn.disabled = false; btn.textContent = '↻ 同步远端选项';
    }
  });
  $('ag-save').addEventListener('click', async () => {
    const btn = $('ag-save');
    if (btn.disabled) return; // 防重复保存：保存中忽略后续点击
    const payload = collectAgent(isEdit ? agent : null);
    if (!payload) return;
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      const r = await api('/agents', { method: 'POST', body: JSON.stringify(payload) });
      if (!r.ok) { toast(r.error || '保存失败', true); return; }
      closeDrawer(); await loadAgents(); renderAgents(); toast('✓ 子智能体已保存');
    } finally {
      btn.disabled = false; btn.textContent = '保存';
    }
  });
  wireBindRows();
}
function bindRowHtml(r, i, resOptions) {
  const sel = r.skillMode;
  const skillModeVal = sel === 'all' || sel === 'none' ? sel : 'names';
  return '<div class="bind-row" data-i="' + i + '">' +
    '<div class="grid2"><div class="field" style="margin:0"><label>资源</label><select class="b-map"><option value="">— 选择 —</option>' + resOptions + '</select></div>' +
    '<div class="field" style="margin:0"><label>别名</label><input class="b-alias" value="' + esc(r.alias || '') + '"></div></div>' +
    '<div class="grid3" style="margin-top:8px"><div class="field" style="margin:0"><label>凭证注入</label><select class="b-cred">' +
    '<option value="self-fetch"' + (r.credentialMode === 'self-fetch' ? ' selected' : '') + '>self-fetch · AI 自取</option>' +
    '<option value="inline"' + (r.credentialMode === 'inline' ? ' selected' : '') + '>inline · 写入提示词</option>' +
    '<option value="omit"' + (r.credentialMode === 'omit' ? ' selected' : '') + '>omit · 不提供</option></select></div>' +
    '<div class="field" style="margin:0"><label>技能注入</label><select class="b-skill">' +
    '<option value="all"' + (skillModeVal === 'all' ? ' selected' : '') + '>all · 全部内联</option>' +
    '<option value="none"' + (skillModeVal === 'none' ? ' selected' : '') + '>none · 只给目录</option></select></div>' +
    '<div class="field" style="margin:0"><label>用途说明</label><input class="b-note" value="' + esc(r.note || '') + '"></div></div>' +
    '<div style="text-align:right;margin-top:6px"><button class="mini-btn danger b-del">移除</button></div></div>';
}
function wireBindRows() {
  document.querySelectorAll('#bind-list .bind-row').forEach(row => {
    if (row._wired !== true) {
      row.querySelector('.b-del').addEventListener('click', () => row.remove());
      row._wired = true;
    }
  });
}
function collectAgent(existing) {
  const name = $('ag-name').value.trim();
  if (!name) { toast('缺少名称', true); return null; }
  let dshRef;
  const dshVal = $('ag-dsh').value;
  if (dshVal.startsWith('mapping:')) dshRef = { kind: 'mapping', mappingId: dshVal.slice(8) };
  else if (dshVal === 'direct:') {
    const url = $('ag-direct').value.trim();
    if (!url) { toast('直连地址为空', true); return null; }
    dshRef = { kind: 'direct', apiBaseUrl: url };
  } else { toast('请选择 DSH 实体', true); return null; }
  const resources = [];
  document.querySelectorAll('#bind-list .bind-row').forEach(row => {
    const mappingId = row.querySelector('.b-map').value;
    if (!mappingId) return;
    resources.push({
      ref: { kind: 'mapping', mappingId },
      alias: row.querySelector('.b-alias').value.trim() || undefined,
      credentialMode: row.querySelector('.b-cred').value,
      skillMode: row.querySelector('.b-skill').value,
      note: row.querySelector('.b-note').value.trim() || undefined,
    });
  });
  const payload = {
    name,
    dshRef,
    resources,
    agentPreset: $('ag-preset').value.trim() || 'cordis',
    systemPrompt: $('ag-sp').value.trim() || undefined,
    enabled: true,
  };
  if ($('ag-key').value.trim()) payload.apiKey = $('ag-key').value.trim();
  if ($('ag-provider').value.trim()) payload.provider = $('ag-provider').value.trim();
  if ($('ag-model').value.trim()) payload.model = $('ag-model').value.trim();
  payload.workDir = $('ag-workdir').value.trim() || '';
  if (existing && existing.id) payload.id = existing.id;
  return payload;
}

function showSubtaskLogs(s) {
  openDrawer('工作日志 · ' + s.title);
  const body = $('drawer-body'); body.innerHTML = '<div style="color:var(--tx3);font-size:12px;padding:4px 0">加载日志…</div>';
  renderSubtaskLogs(s);
  const taskIdUsed = state.currentTaskId || findTaskIdOfSubtask(s.id);
  if (taskIdUsed) {
    api('/tasks/' + taskIdUsed).then(r => {
      if (!r.ok || !r.data || !r.data.plan) return;
      const fresh = (r.data.plan.subtasks || []).find(x => x.id === s.id);
      if (fresh && (fresh.logs || []).length !== (s.logs || []).length) {
        s.logs = fresh.logs; s.result = fresh.result;
        renderSubtaskLogs(s);
      }
    });
  }
}
function renderSubtaskLogs(s) {
  const body = $('drawer-body');
  if (!$('drawer-title').textContent.includes(s.title)) return;
  body.innerHTML = '';
  for (const l of s.logs || []) {
    const div = document.createElement('div'); div.className = 'log-line ' + (l.level || 'info');
    div.innerHTML = '<span class="lv">[' + (l.level || 'info') + ']</span><span style="color:var(--tx3)">' + fmtTime(l.ts) + '</span> ' + esc(l.msg);
    body.appendChild(div);
  }
  if (!(s.logs || []).length) body.innerHTML = '<div style="color:var(--tx3)">暂无日志</div>';
  if (s.result && s.result.content && String(s.result.content).trim()) {
    const div = document.createElement('div');
    div.style.cssText = 'margin-top:12px;padding-top:10px;border-top:1px solid rgba(148,163,184,.2)';
    div.innerHTML = '<div style="font-size:11.5px;color:var(--tx3);margin-bottom:6px">📝 最终产出（AI 回复 · Markdown 渲染）</div>' +
      '<div class="content" style="white-space:pre-wrap;line-height:1.6;font-size:12.5px">' + md(String(s.result.content).slice(0, 20000)) + '</div>';
    body.appendChild(div);
  }
  body.scrollTop = 1e9;
}

async function showSubtaskChat(subtaskId, agentId) {
  const taskIdUsed = state.currentTaskId || findTaskIdOfSubtask(subtaskId);
  if (!agentId) {
    for (const t of state.tasks) {
      const s = ((t.plan && t.plan.subtasks) || []).find(x => x.id === subtaskId);
      if (s) { agentId = s.agentId; break; }
    }
  }
  openDrawer('远端会话 · ' + subtaskId);
  const body = $('drawer-body'); body.innerHTML = '<div style="color:var(--tx3)">加载中…</div>';
  const r = await api('/tasks/' + taskIdUsed + '/subtasks/' + subtaskId + '/chat');
  if (!r.ok) { body.innerHTML = '<div style="color:var(--err)">' + esc(r.error || '加载失败') + '</div>'; return; }
  const msgs = r.data.messages || [];
  const roleLabel = { user: '用户指令', assistant: '助手回复', system: '系统' };
  body.innerHTML = (r.data.note ? '<div style="background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.4);color:#fbbf24;padding:8px 12px;border-radius:8px;font-size:12px;margin-bottom:12px">⚠ ' + esc(r.data.note) + '</div>' : '') +
    msgs.map(m => {
      const raw = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.filter(b => b.type === 'text').map(b => b.text).join('\\n') : '';
      const badge = m.local ? ' <span style="background:rgba(148,163,184,.18);color:var(--tx3);padding:1px 6px;border-radius:6px;font-size:10.5px">本地缓存</span>' : '';
      const rendered = m.role === 'assistant' ? md(withFileLinks(taskIdUsed, agentId, raw.slice(0, 20000))) : md(raw.slice(0, 20000));
      return '<div style="margin-bottom:12px"><div style="font-size:11.5px;color:var(--tx3)">' + esc(roleLabel[m.role] || m.role) + badge + '</div><div class="content" style="white-space:pre-wrap;line-height:1.6;font-size:12.5px">' + rendered + (raw.length > 20000 ? '<div style="color:var(--tx3);font-size:11px;margin-top:4px">（内容过长，已截断显示）</div>' : '') + '</div></div>';
    }).join('') +
  '<div style="margin-top:12px;display:flex;gap:8px"><input id="fu-input" placeholder="向该远端会话追问…"><button class="btn pri" id="fu-send">发送</button></div><div id="fu-reply"></div>';
  $('fu-send').addEventListener('click', async () => {
    const msg = $('fu-input').value.trim(); if (!msg) return;
    $('fu-send').disabled = true; toast('已发送，等待远端回复…');
    const fr = await api('/tasks/' + taskIdUsed + '/subtasks/' + subtaskId + '/followup', { method: 'POST', body: JSON.stringify({ message: msg }) });
    $('fu-reply').innerHTML = fr.ok ? '<div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(148,163,184,.2)"><div style="font-size:11.5px;color:var(--tx3);margin-bottom:4px">远端回复</div><div class="content" style="white-space:pre-wrap;line-height:1.6;font-size:12.5px">' + md(withFileLinks(taskIdUsed, agentId, fr.reply || '(空)')) + '</div></div>' : '<div style="color:var(--err)">' + esc(fr.error) + '</div>';
    $('fu-send').disabled = false;
  });
}

function findTaskIdOfSubtask(subId) {
  for (const t of state.tasks) { if ((t.plan && t.plan.subtasks || []).some(s => s.id === subId)) return t.id; }
  return state.currentTaskId;
}

// ---------- 定时任务视图 ----------
/**
 * 定时任务指令框的 @ 提及联想（对齐主输入框交互：@ 触发、↑↓/Tab/Enter 选择、Esc 关闭）。
 * 与主输入框的差异：Enter 仅在弹窗打开时插入候选（否则换行），不触发发送。
 */
function setupScheduleMention(input, popup, listEl) {
  if (!input || !popup || !listEl) return;
  let cursorStart = 0;
  let matched = [];
  let activeIdx = 0;
  let hideTimer = null;

  function hide() { popup.classList.remove('on'); matched = []; }

  function render() {
    if (!matched.length) { listEl.innerHTML = '<div class="mention-empty">无匹配的智能体或资源</div>'; return; }
    listEl.innerHTML = matched.map((item, idx) => {
      const active = idx === activeIdx ? ' active' : '';
      const icon = item.type === 'agent' ? '🤖' : (item.kind === 'ssh' ? '🖥️' : (item.kind === 'http' ? '🌐' : '📦'));
      const tagClass = item.type === 'agent' ? 'agent' : 'resource';
      const tagText = item.type === 'agent' ? '智能体' : (item.kind ? item.kind.toUpperCase() : '资源');
      return '<div class="mention-item' + active + '" data-idx="' + idx + '">' +
        '<span class="icon">' + icon + '</span>' +
        '<div class="info"><div class="name">' + esc(item.name) + '</div>' +
        (item.detail ? '<div class="desc">' + esc(item.detail) + '</div>' : '') + '</div>' +
        '<span class="tag ' + tagClass + '">' + esc(tagText) + '</span></div>';
    }).join('');
    listEl.querySelectorAll('.mention-item').forEach(el => {
      el.addEventListener('mousedown', e => { e.preventDefault(); insert(matched[+el.dataset.idx]); });
    });
    const act = listEl.querySelector('.mention-item.active');
    if (act && act.scrollIntoView) act.scrollIntoView({ block: 'nearest' });
  }

  function insert(item) {
    if (!item) return;
    const text = input.value;
    const before = text.slice(0, cursorStart);
    const after = text.slice(input.selectionEnd);
    const insertText = '@' + item.name + ' ';
    input.value = before + insertText + after;
    const pos = before.length + insertText.length;
    input.selectionStart = input.selectionEnd = pos;
    hide();
    input.focus();
  }

  input.addEventListener('input', () => {
    const before = input.value.slice(0, input.selectionStart);
    const m = /@([^@]*)$/.exec(before);
    if (!m) { hide(); return; }
    cursorStart = m.index;
    const q = m[1].toLowerCase().trim();
    refreshMentionCandidates().then(() => {
      matched = mentionCandidates.filter(c => {
        if (!q) return true;
        const n = (c.name || '').toLowerCase(); const id = (c.id || '').toLowerCase(); const d = (c.detail || '').toLowerCase();
        return n.startsWith(q) || n.includes(q) || id.includes(q) || d.includes(q);
      });
      if (!matched.length) { hide(); return; }
      activeIdx = 0;
      render();
      popup.classList.add('on');
    });
  });

  input.addEventListener('keydown', e => {
    const open = popup.classList.contains('on') && matched.length > 0;
    if (!open) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = (activeIdx + 1) % matched.length; render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = (activeIdx - 1 + matched.length) % matched.length; render(); }
    else if (e.key === 'Tab' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); insert(matched[activeIdx]); }
    else if (e.key === 'Escape') { hide(); }
  });
  input.addEventListener('blur', () => { hideTimer = setTimeout(hide, 150); });
  input.addEventListener('focus', () => { clearTimeout(hideTimer); });
}

/**
 * 从指令文本解析 @ 提及（与服务端 extractMentions 同策略：候选按名称长度降序做最长前缀匹配）。
 * 返回 { agentIds, unknown } —— unknown 是 @ 到但无法解析为子智能体的片段（提示用户）。
 */
function parseScheduleMentions(text) {
  const dict = [];
  for (const a of (state.agents || [])) {
    if (a.name) dict.push({ type: 'agent', name: a.name, id: a.id });
    if (a.id) dict.push({ type: 'agent', name: a.id, id: a.id });
  }
  dict.sort((x, y) => y.name.length - x.name.length);
  const agentIds = []; const unknown = new Set();
  let i = 0;
  while (i < text.length) {
    if (text[i] !== '@') { i++; continue; }
    const rest = text.slice(i + 1);
    const hit = dict.find(e => rest.startsWith(e.name));
    if (hit) {
      if (!agentIds.includes(hit.id)) agentIds.push(hit.id);
      i += 1 + hit.name.length;
    } else {
      const seg = /@([^\s@]+)/.exec(rest);
      if (seg) { unknown.add(seg[1]); i += 1 + seg[1].length; }
      else i++;
    }
  }
  return { agentIds, unknown: Array.from(unknown) };
}

$('btn-new-schedule').addEventListener('click', () => openScheduleDrawer(null));
async function loadSchedules() {
  const r = await api('/schedules');
  if (r.ok) state.schedules = Array.isArray(r.data) ? r.data : [];
  if (!state.scheduleTemplates) {
    const t = await api('/schedule-templates');
    if (t.ok) state.scheduleTemplates = Array.isArray(t.data) ? t.data : [];
  }
}
const WEEK_CN = '日一二三四五六';
function ruleText(rule) {
  if (!rule) return '';
  if (rule.kind === 'daily') return '每天 ' + (rule.times || []).join('、');
  if (rule.kind === 'weekly') {
    const days = [...new Set(rule.days || [])].sort((a, b) => a - b);
    if (days.length === 5 && days.every(d => d >= 1 && d <= 5)) return '每工作日 ' + rule.time;
    return '每周' + days.map(d => WEEK_CN[d]).join('、') + ' ' + rule.time;
  }
  if (rule.kind === 'hourly') return '每小时的第 ' + rule.minute + ' 分';
  if (rule.kind === 'monthly') return '每月 ' + [...new Set(rule.days || [])].sort((a, b) => a - b).join('、') + ' 号 ' + rule.time;
  if (rule.kind === 'interval') {
    const m = rule.minutes || 0;
    if (m >= 1440 && m % 1440 === 0) return '每 ' + (m / 1440) + ' 天';
    if (m >= 60 && m % 60 === 0) return '每 ' + (m / 60) + ' 小时';
    return '每 ' + m + ' 分钟';
  }
  if (rule.kind === 'once') return '一次性 · ' + fmtDateTime(rule.at);
  return String(rule.kind || '');
}
const TASK_STATUS_CN = { draft: '草稿', running: '执行中', completed: '已完成', success: '已完成', partial_success: '部分成功', failed: '失败', cancelled: '已中止' };
function agentNamesOf(s) {
  const ids = s.agentIds || [];
  const named = (s.agents || []);
  return ids.map(id => { const a = named.find(x => x.id === id); return a ? a.name : id; }).join('、') || '—';
}
function renderSchedules() {
  const el = $('schedule-list'); el.innerHTML = '';
  // 模板区（一键创建：预填表单）
  const tplList = state.scheduleTemplates || [];
  if (tplList.length) {
    const tplBox = document.createElement('div'); tplBox.className = 'card';
    tplBox.innerHTML = '<div class="sub" style="margin-bottom:10px">📋 定时任务模板（点击即预填新建表单）</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px">' +
      tplList.map((t, i) =>
        '<div class="sched-tpl" data-tpl="' + i + '">' +
        '<div style="display:flex;align-items:center;gap:6px"><b>' + (t.icon ? esc(t.icon) + ' ' : '') + esc(t.name) + '</b>' +
        '<span class="tag" style="margin-left:auto">⏰ ' + esc(ruleText(t.rule)) + '</span></div>' +
        '<div class="sub" style="margin-top:6px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">' + esc(t.description) + '</div>' +
        '</div>').join('') + '</div>';
    tplBox.querySelectorAll('[data-tpl]').forEach(node => {
      node.addEventListener('click', () => openScheduleDrawer(null, tplList[Number(node.dataset.tpl)]));
    });
    el.appendChild(tplBox);
  }
  if (!state.schedules.length) {
    el.insertAdjacentHTML('beforeend', '<div class="card"><span class="sub" style="color:var(--tx3)">还没有定时任务。点击「＋ 新建定时任务」或从上方模板开始—— 选择一个或多个子智能体，配置触发规则与固定任务文本，到点由 Host 自动派发执行。</span></div>');
    return;
  }
  for (const s of state.schedules) {
    const card = document.createElement('div'); card.className = 'card';
    const successRate = s.totalRuns ? Math.round((s.successRuns || 0) * 100 / s.totalRuns) : null;
    card.innerHTML = '<div class="row1"><h3>' + esc(s.name) + '</h3>' +
      (s.enabled ? '<span class="tag ok">▶ 启用中</span>' : '<span class="tag err">⏸ 已暂停</span>') +
      '<span class="tag">🕐 ' + esc(s.ruleText || ruleText(s.rule)) + '</span>' +
      '<span class="tag">🤖 ' + esc(agentNamesOf(s)) + '</span>' +
      (s.description ? '<span class="tag">' + esc(s.description) + '</span>' : '') + '</div>' +
      '<div class="desc">任务文本: ' + esc(String(s.messagePreview || s.message || '').slice(0, 120)) +
      '<br>上次触发: ' + (s.lastRunAt ? fmtDateTime(s.lastRunAt) : '从未') +
      ' · 下次触发: ' + (s.enabled ? (s.nextRunAt ? fmtDateTime(s.nextRunAt) : '—') : '（已暂停）') +
      ' · 已运行 <b>' + (s.totalRuns || 0) + '</b> 次' +
      (successRate !== null ? ' · 派发成功率 ' + successRate + '%' : '') + '</div>' +
      '<div class="ops"><button class="btn" data-op="detail">详情</button><button class="btn" data-op="edit">编辑</button>' +
      '<button class="btn" data-op="run">▶ 立即执行</button><button class="btn" data-op="toggle">' + (s.enabled ? '停用' : '启用') + '</button>' +
      '<button class="btn danger" data-op="del">删除</button></div>';
    card.querySelector('[data-op=detail]').addEventListener('click', () => openScheduleDetail(s.id));
    card.querySelector('[data-op=edit]').addEventListener('click', () => openScheduleDrawer(s));
    card.querySelector('[data-op=run]').addEventListener('click', async () => {
      toast('派发中…');
      const r = await api('/schedules/' + s.id + '/run', { method: 'POST' });
      if (!r.ok) { toast(r.error || '触发失败', true); return; }
      const run = r.data || {};
      const okCount = (run.items || []).filter(i => i.taskId).length;
      toast('✓ 已派发 ' + okCount + '/' + (run.items || []).length + ' 个子智能体');
      await loadSchedules(); renderSchedules();
      openScheduleDetail(s.id);
    });
    card.querySelector('[data-op=toggle]').addEventListener('click', async () => {
      const r = await api('/schedules/' + s.id + '/toggle', { method: 'POST' });
      if (!r.ok) { toast(r.error || '操作失败', true); return; }
      toast(r.data && r.data.enabled ? '✓ 已启用' : '已停用');
      await loadSchedules(); renderSchedules();
    });
    card.querySelector('[data-op=del]').addEventListener('click', async () => {
      if (!confirm('删除定时任务「' + s.name + '」？触发历史一并删除。')) return;
      await api('/schedules/' + s.id, { method: 'DELETE' });
      await loadSchedules(); renderSchedules(); toast('已删除');
    });
    el.appendChild(card);
  }
}

function openScheduleDrawer(s, tpl) {
  const isEdit = Boolean(s);
  const prefill = tpl || {};
  openDrawer(isEdit ? '编辑定时任务' : (prefill.id ? '新建定时任务（模板: ' + prefill.name + '）' : '新建定时任务'));
  $('drawer-body').innerHTML =
    '<div class="field"><label>任务标题</label><input id="sc-name" value="' + esc(s ? s.name : (prefill.name || '')) + '" placeholder="如: 每日站会摘要"></div>' +
    '<div class="field"><label>调度（Host 本地时区 · 错过的触发点不补跑）</label>' +
    '<select id="sc-kind">' +
    '<option value="daily"' + (!s || s.rule.kind === 'daily' ? ' selected' : '') + '>每天（固定时刻，可多个）</option>' +
    '<option value="weekly"' + (s && s.rule.kind === 'weekly' ? ' selected' : '') + '>每周（勾选星期 + 时刻）</option>' +
    '<option value="hourly"' + (s && s.rule.kind === 'hourly' ? ' selected' : '') + '>每小时（第 N 分）</option>' +
    '<option value="monthly"' + (s && s.rule.kind === 'monthly' ? ' selected' : '') + '>每月（勾选日期 + 时刻）</option>' +
    '<option value="interval"' + (s && s.rule.kind === 'interval' ? ' selected' : '') + '>间隔（每 N 分钟）</option>' +
    '<option value="once"' + (s && s.rule.kind === 'once' ? ' selected' : '') + '>一次性（指定时刻）</option>' +
    '</select>' +
    '<div id="sc-rule-box" style="margin-top:8px"></div>' +
    '<div class="hint" id="sc-preview" style="margin-top:6px;color:var(--pri)"></div></div>' +
    '<div class="field"><label>指令（用 @ 提及子智能体与资源，与新建任务同语义）</label>' +
    '<div style="position:relative">' +
    '<textarea id="sc-message" style="min-height:110px" placeholder="如: 让 @苦力兔 把 @136 上的日志收集过来，分析系统运行情况&#10;输入 @ 唤起子智能体 / 资源联想">' + esc(s ? s.message : (prefill.message || '')) + '</textarea>' +
    '<div class="mention-popup below" id="sc-mention-popup" style="left:0;right:0;width:auto">' +
    '<div class="mention-popup-head">提及子智能体或资源</div>' +
    '<div class="mention-popup-list" id="sc-mention-list"></div>' +
    '</div></div>' +
    '<div class="hint">触发时自动解析 @提及：被 @ 的子智能体进入执行（@ 多个 = 协同编排），@ 的资源把入口与凭证按绑定策略注入提示词。</div></div>' +
    '<div class="field"><label>备注（可选）</label><input id="sc-desc" value="' + esc(s && s.description || (prefill.description || '')) + '"></div>' +
    '<div class="ops" style="display:flex;gap:10px;margin-top:14px"><button class="btn pri" id="sc-save">' + (isEdit ? '保存' : '创建定时任务') + '</button><button class="btn" id="sc-cancel">取消</button></div>';

  // @ 提及联想（候选与主输入框共用 /mentions/candidates）
  setupScheduleMention($('sc-message'), $('sc-mention-popup'), $('sc-mention-list'));

  // 模板预填规则（仅新建且模板带规则时）
  if (!isEdit && prefill.rule) s = { rule: prefill.rule };
  const kindSel = $('sc-kind'), ruleBox = $('sc-rule-box'), previewEl = $('sc-preview');
  function currentRule() {
    const kind = kindSel.value;
    const cur = (s && s.rule && s.rule.kind === kind) ? s.rule : {};
    if (kind === 'daily') {
      const times = String($('sc-times').value || '').split(/[,，]/).map(x => x.trim()).filter(Boolean);
      return { kind, times };
    }
    if (kind === 'weekly') {
      const days = Array.from(new Set(document.querySelectorAll('.sc-day:checked').flatMap(cb => cb.value.split(','))).values()).map(Number).filter(d => d >= 0 && d <= 6);
      return { kind, days, time: $('sc-time').value.trim() };
    }
    if (kind === 'hourly') return { kind, minute: Number($('sc-minute').value) };
    if (kind === 'monthly') {
      const days = Array.from(document.querySelectorAll('.sc-mday:checked')).map(cb => Number(cb.value));
      return { kind, days, time: $('sc-time').value.trim() };
    }
    if (kind === 'interval') return { kind, minutes: Number($('sc-minutes').value) };
    const v = $('sc-at').value;
    return { kind: 'once', at: v ? new Date(v).getTime() : NaN };
  }
  function renderRuleBox() {
    const kind = kindSel.value;
    const cur = (s && s.rule && s.rule.kind === kind) ? s.rule : {};
    if (kind === 'daily') {
      const times = cur.kind === 'daily' ? (cur.times || []).join(', ') : '09:00';
      ruleBox.innerHTML = '<input id="sc-times" value="' + esc(times) + '" placeholder="多个时刻用英文逗号分隔，如 09:00, 18:30">' +
        '<div class="hint">每天在这些时刻触发（Host 本地时区）。</div>';
    } else if (kind === 'weekly') {
      const days = cur.kind === 'weekly' ? (cur.days || []) : [1, 2, 3, 4, 5];
      const time = cur.kind === 'weekly' ? cur.time : '09:00';
      let checks = '<label style="display:inline-flex;align-items:center;gap:4px;margin:0 10px 6px 0"><input type="checkbox" class="sc-day" value="1,2,3,4,5" style="width:15px;height:15px">每工作日</label>';
      for (let d = 0; d < 7; d++) {
        checks += '<label style="display:inline-flex;align-items:center;gap:4px;margin:0 10px 6px 0"><input type="checkbox" class="sc-day" value="' + d + '"' + (days.includes(d) ? ' checked' : '') + ' style="width:15px;height:15px">周' + WEEK_CN[d] + '</label>';
      }
      ruleBox.innerHTML = '<div style="margin-bottom:8px">' + checks + '</div><input id="sc-time" value="' + esc(time) + '" placeholder="时刻 HH:mm">';
    } else if (kind === 'hourly') {
      const minute = cur.kind === 'hourly' ? cur.minute : 0;
      ruleBox.innerHTML = '<div style="display:flex;align-items:center;gap:8px">每小时的第 <input id="sc-minute" type="number" min="0" max="59" value="' + esc(minute) + '" style="width:80px"> 分</div>';
    } else if (kind === 'monthly') {
      const days = cur.kind === 'monthly' ? (cur.days || []) : [1];
      const time = cur.kind === 'monthly' ? cur.time : '09:00';
      let checks = '';
      for (let d = 1; d <= 31; d++) {
        checks += '<label style="display:inline-flex;align-items:center;gap:3px;margin:0 8px 6px 0"><input type="checkbox" class="sc-mday" value="' + d + '"' + (days.includes(d) ? ' checked' : '') + ' style="width:14px;height:14px">' + d + '</label>';
      }
      ruleBox.innerHTML = '<div style="margin-bottom:8px;max-height:96px;overflow:auto">' + checks + '</div><input id="sc-time" value="' + esc(time) + '" placeholder="时刻 HH:mm">' +
        '<div class="hint">当月不存在的日期（如 2 月 30 日）自动跳过。</div>';
    } else if (kind === 'interval') {
      const minutes = cur.kind === 'interval' ? cur.minutes : 60;
      ruleBox.innerHTML = '<input id="sc-minutes" type="number" min="1" value="' + esc(minutes) + '" placeholder="间隔分钟数">' +
        '<div class="hint">从保存时刻起每 N 分钟触发一次。</div>';
    } else {
      const at = cur.kind === 'once' ? new Date(cur.at - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
      ruleBox.innerHTML = '<input id="sc-at" type="datetime-local" value="' + esc(at) + '">' +
        '<div class="hint">到点触发一次后自动停用。</div>';
    }
    // 控件变化时实时更新自然语言预览
    ruleBox.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('change', updatePreview);
      inp.addEventListener('input', updatePreview);
    });
    updatePreview();
  }
  function updatePreview() {
    try {
      const text = ruleText(currentRule());
      previewEl.textContent = '触发预览：' + text;
    } catch { previewEl.textContent = ''; }
  }
  renderRuleBox();
  let lastRule = (s && s.rule) || null;
  const origUpdatePreview = updatePreview;
  updatePreview = function () { try { lastRule = currentRule(); } catch { /* 半填状态忽略 */ } origUpdatePreview(); };
  kindSel.addEventListener('change', () => { s = { rule: lastRule || (s && s.rule) }; renderRuleBox(); });
  $('sc-cancel').addEventListener('click', closeDrawer);
  $('sc-save').addEventListener('click', async () => {
    const btn = $('sc-save');
    if (btn.disabled) return;
    const payload = collectSchedule(isEdit ? s : null);
    if (!payload) return;
    btn.disabled = true; btn.textContent = '保存中…';
    try {
      const r = await api('/schedules', { method: 'POST', body: JSON.stringify(payload) });
      if (!r.ok) { toast(r.error || '保存失败', true); return; }
      closeDrawer(); await loadSchedules(); renderSchedules(); toast('✓ 定时任务已保存');
    } finally {
      btn.disabled = false; btn.textContent = '保存';
    }
  });
}
function collectSchedule(existing) {
  const name = $('sc-name').value.trim();
  if (!name) { toast('缺少名称', true); return null; }
  const message = $('sc-message').value.trim();
  if (!message) { toast('指令不能为空', true); return null; }
  // 从指令的 @ 提及解析目标子智能体（与触发时服务端 extractMentions 同策略）
  const parsed = parseScheduleMentions(message);
  let agentIds = parsed.agentIds;
  if (!agentIds.length && existing && (existing.agentIds || []).length) {
    // 编辑旧任务且指令里没有 @ 智能体：回退到原有目标，避免静默丢目标
    agentIds = existing.agentIds;
  }
  if (!agentIds.length) { toast('请在指令中用 @ 提及至少一个子智能体（如 @苦力兔）', true); return null; }
  if (parsed.unknown.length) {
    toast('⚠️ 这些 @ 未匹配到子智能体（将按资源处理）: ' + parsed.unknown.join('、'), true);
  }
  const kind = $('sc-kind').value;
  let rule;
  if (kind === 'daily') {
    const times = $('sc-times').value.split(/[,，]/).map(x => x.trim()).filter(Boolean);
    rule = { kind: 'daily', times };
  } else if (kind === 'weekly') {
    const days = Array.from(new Set(document.querySelectorAll('.sc-day:checked').flatMap(cb => cb.value.split(','))).values()).map(Number).filter(d => d >= 0 && d <= 6);
    rule = { kind: 'weekly', days, time: $('sc-time').value.trim() };
  } else if (kind === 'hourly') {
    rule = { kind: 'hourly', minute: Number($('sc-minute').value) };
  } else if (kind === 'monthly') {
    const days = Array.from(document.querySelectorAll('.sc-mday:checked')).map(cb => Number(cb.value));
    rule = { kind: 'monthly', days, time: $('sc-time').value.trim() };
  } else if (kind === 'interval') {
    rule = { kind: 'interval', minutes: Number($('sc-minutes').value) };
  } else {
    const v = $('sc-at').value;
    rule = { kind: 'once', at: v ? new Date(v).getTime() : NaN };
  }
  const payload = { name, agentIds, rule, message, enabled: existing ? existing.enabled : true };
  const desc = $('sc-desc').value.trim();
  if (desc) payload.description = desc;
  if (existing && existing.id) payload.id = existing.id;
  return payload;
}

// ---------- 定时任务详情（页签：基本信息 / 执行记录，样式对齐 KB 任务详情页） ----------
let scheduleDetailTimer = null;
async function openScheduleDetail(id, tab) {
  const r = await api('/schedules/' + id);
  if (!r.ok) { toast(r.error || '加载失败', true); return; }
  const s = r.data;
  openDrawer('定时任务详情 · ' + s.name);
  renderScheduleDetail(s, tab || 'info');
  if (scheduleDetailTimer) clearInterval(scheduleDetailTimer);
  scheduleDetailTimer = setInterval(async () => {
    if (!$('drawer').classList.contains('on') || !$('sched-tabs')) { clearInterval(scheduleDetailTimer); scheduleDetailTimer = null; return; }
    const fresh = await api('/schedules/' + id);
    if (fresh.ok) renderScheduleDetail(fresh.data, $('sched-tabs').dataset.tab || 'info', true);
  }, 5000);
}
function renderScheduleDetail(s, tab, keepScroll) {
  if (!$('sched-tabs') && keepScroll) return;
  const body = $('drawer-body');
  const scrollTop = keepScroll ? body.scrollTop : 0;
  body.innerHTML =
    '<div class="sched-tabs" id="sched-tabs" data-tab="' + tab + '">' +
    '<button class="sched-tab' + (tab === 'info' ? ' on' : '') + '" data-t="info">基本信息</button>' +
    '<button class="sched-tab' + (tab === 'runs' ? ' on' : '') + '" data-t="runs">执行记录（' + (s.runs || []).length + '）</button>' +
    '</div><div id="sched-tab-body"></div>';
  body.querySelectorAll('.sched-tab').forEach(b => b.addEventListener('click', () => renderScheduleDetail(s, b.dataset.t)));
  const tb = $('sched-tab-body');
  if (tab === 'info') {
    tb.innerHTML =
      '<div class="sched-grid">' +
      '<div class="k">任务名称</div><div>' + esc(s.name) + '</div>' +
      '<div class="k">状态</div><div>' + (s.enabled ? '<span class="tag ok">启用</span>' : '<span class="tag err">停用</span>') + '</div>' +
      '<div class="k">触发规则</div><div>' + esc(s.ruleText || ruleText(s.rule)) + '</div>' +
      '<div class="k">目标子智能体</div><div>' + esc(agentNamesOf(s)) + '</div>' +
      '<div class="k">累计触发</div><div>' + (s.totalRuns || 0) + ' 次' + (s.totalRuns ? ' · 派发成功率 ' + Math.round((s.successRuns || 0) * 100 / s.totalRuns) + '%' : '') + '</div>' +
      '<div class="k">上次触发</div><div>' + (s.lastRunAt ? fmtDateTime(s.lastRunAt) : '从未') + '</div>' +
      '<div class="k">下次触发</div><div>' + (s.enabled ? (s.nextRunAt ? fmtDateTime(s.nextRunAt) : '—') : '（已停用）') + '</div>' +
      '<div class="k">备注</div><div>' + esc(s.description || '—') + '</div>' +
      '<div class="k">创建时间</div><div>' + fmtDateTime(s.createdAt) + '</div>' +
      '</div>' +
      '<div class="field" style="margin-top:14px"><label>任务文本（每次触发派发给每个子智能体）</label>' +
      '<div class="pre-block" style="max-height:180px;overflow:auto">' + esc(s.message || '') + '</div></div>' +
      '<div class="ops" style="display:flex;gap:10px;margin-top:14px">' +
      '<button class="btn pri" id="sd-run">▶ 立即执行</button>' +
      '<button class="btn" id="sd-toggle">' + (s.enabled ? '停用' : '启用') + '</button>' +
      '<button class="btn" id="sd-edit">编辑</button></div>';
    $('sd-run').addEventListener('click', async () => {
      toast('派发中…');
      const rr = await api('/schedules/' + s.id + '/run', { method: 'POST' });
      if (!rr.ok) { toast(rr.error || '触发失败', true); return; }
      toast('✓ 已派发');
      openScheduleDetail(s.id, 'runs');
    });
    $('sd-toggle').addEventListener('click', async () => {
      const rr = await api('/schedules/' + s.id + '/toggle', { method: 'POST' });
      if (!rr.ok) { toast(rr.error || '操作失败', true); return; }
      toast(rr.data && rr.data.enabled ? '✓ 已启用' : '已停用');
      await loadSchedules(); renderSchedules();
      openScheduleDetail(s.id, tab);
    });
    $('sd-edit').addEventListener('click', () => { closeDrawer(); openScheduleDrawer(s); });
  } else {
    const runs = (s.runs || []);
    if (!runs.length) {
      tb.innerHTML = '<div class="hint" style="padding:12px 0">暂无触发记录。可点击列表中的「▶ 立即执行」手动触发一次。</div>';
      return;
    }
    tb.innerHTML = runs.map(run => {
      const items = (run.items || []).map(it => {
        const st = it.taskStatus || (it.error ? 'failed' : 'unknown');
        const stCls = st === 'running' ? 'warn' : (st === 'completed' || st === 'success' ? 'ok' : 'err');
        const label = it.error ? ('派发失败: ' + it.error + (it.attempts > 1 ? '（已重试 ' + (it.attempts - 1) + ' 次）' : '')) : (TASK_STATUS_CN[st] || st);
        return '<div class="run-item">' +
          '<span class="mono">' + esc(it.agentName || it.agentId) + '</span>' +
          '<span class="tag ' + stCls + '">' + esc(label) + '</span>' +
          (it.taskId ? '<button class="mini-btn" data-task="' + esc(it.taskId) + '">查看会话 →</button>' : '') +
          '</div>';
      }).join('');
      return '<div class="run-card">' +
        '<div class="row1" style="margin-bottom:6px"><b style="font-size:12.5px">' + fmtDateTime(run.triggeredAt) + '</b>' +
        (run.manual ? '<span class="tag">手动</span>' : '<span class="tag ok">定时</span>') +
        (typeof run.durationMs === 'number' ? '<span class="tag">⏱ ' + (run.durationMs / 1000).toFixed(1) + 's</span>' : '') + '</div>' + items + '</div>';
    }).join('');
    tb.querySelectorAll('[data-task]').forEach(b => b.addEventListener('click', () => {
      closeDrawer();
      switchView('work');
      openTask(b.dataset.task);
    }));
  }
  if (keepScroll) body.scrollTop = scrollTop;
}

// ---------- 远程工作空间文件管理视图 ----------
const filesState = {
  agentId: '',
  path: '',
  home: '',
  parent: '',
  entries: [],
  truncated: false,
  showHidden: false,
  searchKeyword: '',
  loading: false,
  error: '',
  initialized: false,
  selected: new Set(), // 批量操作：选中的条目 path
};

function classifyFileIcon(name, type) {
  if (type === 'dir') return '📁';
  if (type === 'link') return '🔗';
  const ext = (name.split('.').pop() || '').toLowerCase();
  switch (ext) {
    case 'ts': case 'tsx': case 'js': case 'jsx': case 'mjs': case 'cjs': return '⚡';
    case 'py': case 'python': return '🐍';
    case 'sh': case 'bash': case 'zsh': return '🐚';
    case 'json': case 'yaml': case 'yml': case 'toml': case 'xml': return '⚙️';
    case 'md': case 'markdown': case 'txt': case 'log': return '📝';
    case 'html': case 'htm': case 'css': case 'scss': case 'less': return '🌐';
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': case 'svg': case 'ico': return '🖼️';
    case 'zip': case 'tar': case 'gz': case 'tgz': case '7z': case 'rar': return '📦';
    case 'pdf': return '📕';
    case 'mp3': case 'wav': case 'flac': return '🎵';
    case 'mp4': case 'webm': case 'mov': return '🎬';
    case 'rs': case 'go': case 'java': case 'c': case 'cpp': case 'h': case 'hpp': return '📄';
    default: return '📄';
  }
}

/** 一键将文件引用填入对话输入框（格式为 @智能体名:文件路径，发送前按目标节点自动转换为本地路径或下载URL） */
function atFileToChat(filePath, fileName) {
  switchView('work');
  const inp = $('input');
  if (inp) {
    let refPath = filePath;
    if (filesState.home && refPath.startsWith(filesState.home)) {
      refPath = refPath.slice(filesState.home.length);
      while (refPath.startsWith('/') || refPath.startsWith('\\\\')) {
        refPath = refPath.slice(1);
      }
    }
    const currentAgent = state.agents.find(a => a.id === filesState.agentId);
    const agentName = currentAgent ? currentAgent.name : (filesState.agentId || '智能体');
    const finalPath = refPath || fileName;
    const insertText = '@' + agentName + ':' + finalPath + ' ';
    const val = inp.value || '';
    inp.value = val ? (val.endsWith(' ') ? val + insertText : val + ' ' + insertText) : insertText;
    inp.focus();
    // 就地反馈：输入区脉冲 + 上方一行淡出小字（引用内容已在输入框可见，无需底部 toast 再打断）
    pulseComposer();
    hintComposer('已引用 @' + agentName + ':' + finalPath);
  }
}

/** 在线预览文件（文本/代码/图片/Markdown） */
async function previewFile(agentId, filePath, fileName) {
  openDrawer('📄 文件预览 · ' + fileName);
  const body = $('drawer-body');
  body.innerHTML = '<div style="padding:32px;text-align:center;color:var(--tx3)">正在加载文件内容…</div>';

  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'].includes(ext);
  const downloadUrl = API + '/agents/fs/download?agent=' + encodeURIComponent(agentId) + '&path=' + encodeURIComponent(filePath);
  const inlineUrl = downloadUrl + '&inline=1';

  let actionsHtml = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid var(--line);flex-wrap:wrap">' +
    '<button class="btn-at-file" id="fp-at">@文件 引用到对话</button>' +
    '<button class="btn" id="fp-copy-path" style="padding:4px 10px;font-size:12px">📋 复制路径</button>' +
    '<span class="hspacer"></span>' +
    '<a class="btn pri" href="' + downloadUrl + '" download="' + esc(fileName) + '" style="text-decoration:none;padding:5px 12px;font-size:12.5px;display:inline-flex;align-items:center;gap:4px">⬇️ 下载文件</a>' +
  '</div>';

  if (isImage) {
    body.innerHTML = actionsHtml +
      '<div style="text-align:center;padding:16px;background:rgba(0,0,0,.3);border-radius:8px;overflow:auto">' +
      '<img src="' + inlineUrl + '" style="max-width:100%;max-height:480px;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.5)" alt="' + esc(fileName) + '">' +
      '</div>' +
      '<div style="margin-top:10px;color:var(--tx3);font-size:12px;font-family:var(--mono);word-break:break-all">' + esc(filePath) + '</div>';
  } else {
    try {
      const res = await fetch(inlineUrl);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      body.innerHTML = actionsHtml +
        '<div class="code-preview-box">' + esc(text) + '</div>' +
        '<div style="margin-top:10px;color:var(--tx3);font-size:12px;font-family:var(--mono);word-break:break-all">' + esc(filePath) + '</div>';
    } catch (e) {
      body.innerHTML = actionsHtml +
        '<div style="padding:32px;text-align:center;color:var(--tx3)">' +
        '<div style="font-size:36px;margin-bottom:8px">📦</div>' +
        '<div style="font-size:13.5px;color:var(--tx)">二进制文件或无法直接在线预览</div>' +
        '<div style="margin-top:8px;font-size:12px;font-family:var(--mono)">' + esc(filePath) + '</div>' +
        '</div>';
    }
  }

  const atBtn = $('fp-at');
  if (atBtn) atBtn.addEventListener('click', () => { closeDrawer(); atFileToChat(filePath, fileName); });
  const copyBtn = $('fp-copy-path');
  if (copyBtn) copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(filePath).then(() => toast('✓ 已复制文件路径'));
  });
}

/** 渲染面包屑路径导航 */
function renderFilesCrumbs() {
  const bar = $('files-crumb-bar');
  if (!bar) return;
  const cur = filesState.path || filesState.home || '/';
  const parts = cur.split('/').flatMap(x => x.split('\\\\')).filter(Boolean);
  const isWindows = cur.includes(':');
  const rootLabel = isWindows ? (parts[0] || '盘符') : '🏠 根目录';

  let html = '<span class="files-crumb' + (parts.length === 0 ? ' active' : '') + '" data-p="' + (isWindows ? (parts[0] + '/') : '/') + '"><span>' + rootLabel + '</span></span>';

  let acc = isWindows ? (parts[0] + '/') : '/';
  const startIdx = isWindows ? 1 : 0;
  for (let i = startIdx; i < parts.length; i++) {
    const p = parts[i];
    acc = acc.endsWith('/') ? (acc + p) : (acc + '/' + p);
    const isLast = i === parts.length - 1;
    html += '<span class="files-crumb-sep">/</span>';
    html += '<span class="files-crumb' + (isLast ? ' active' : '') + '" data-p="' + esc(acc) + '"><span>' + esc(p) + '</span></span>';
  }
  bar.innerHTML = html;
  bar.querySelectorAll('.files-crumb:not(.active)').forEach(el => {
    el.addEventListener('click', () => loadFilesDir(el.dataset.p));
  });
}

/** 渲染文件列表表格 */
function renderFilesTable() {
  const tbody = $('files-list');
  if (!tbody) return;
  const kw = filesState.searchKeyword.toLowerCase().trim();

  let filtered = (filesState.entries || []).filter(e => {
    if (!filesState.showHidden && e.hidden) return false;
    if (kw && !e.name.toLowerCase().includes(kw)) return false;
    return true;
  });

  if (filesState.loading) {
    tbody.innerHTML = '<tr><td colspan="5"><div class="files-empty-box"><span class="cursor"></span><span>正在读取远程文件列表…</span></div></td></tr>';
    return;
  }

  if (filesState.error) {
    tbody.innerHTML = '<tr><td colspan="5"><div class="files-empty-box" style="color:var(--err)"><span>⚠️ 无法读取工作空间</span><span>' + esc(filesState.error) + '</span></div></td></tr>';
    return;
  }

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="5"><div class="files-empty-box"><span>📁</span><span>' + (kw ? '未找到匹配的文件或文件夹' : '当前目录为空') + '</span></div></td></tr>';
    $('files-stats').textContent = '0 个项目';
    renderBatchBar();
    return;
  }

  let rowsHtml = '';
  // 如果不是根目录，增加返回上一级行
  if (filesState.parent && filesState.path !== filesState.parent) {
    rowsHtml += '<tr class="files-row" data-parent="1">' +
      '<td class="files-cell-check"></td>' +
      '<td class="files-cell files-cell-name"><span class="files-icon">📁</span><span>..（返回上级）</span></td>' +
      '<td class="files-cell">—</td><td class="files-cell">—</td><td class="files-cell" style="text-align:right">—</td>' +
    '</tr>';
  }

  for (const item of filtered) {
    const isDir = item.type === 'dir';
    const icon = classifyFileIcon(item.name, item.type);
    const sizeText = isDir ? '—' : (item.size != null ? fmtSize(item.size) : '—');
    const mtimeText = item.mtime ? fmtDateTime(item.mtime) : '—';
    const downloadUrl = API + '/agents/fs/download?agent=' + encodeURIComponent(filesState.agentId) + '&path=' + encodeURIComponent(item.path);

    const selected = filesState.selected.has(item.path);
    rowsHtml += '<tr class="files-row' + (selected ? ' selected' : '') + '" data-path="' + esc(item.path) + '" data-name="' + esc(item.name) + '" data-type="' + esc(item.type || 'file') + '">' +
      '<td class="files-cell-check"><input type="checkbox" class="files-check" data-path="' + esc(item.path) + '"' + (selected ? ' checked' : '') + ' title="选择" /></td>' +
      '<td class="files-cell files-cell-name">' +
        '<span class="files-icon">' + icon + '</span>' +
        '<span style="' + (item.hidden ? 'opacity:.6' : '') + '">' + esc(item.name) + '</span>' +
      '</td>' +
      '<td class="files-cell">' + sizeText + '</td>' +
      '<td class="files-cell" style="font-size:12px;color:var(--tx3)">' + mtimeText + '</td>' +
      '<td class="files-cell" style="text-align:right">' +
        '<div class="files-actions">' +
          '<button class="btn-at-file" data-op="at" title="将 @' + esc(item.name) + ' 引用填入输入框">@文件</button>' +
          (!isDir ? '<button class="mini-btn" data-op="preview" title="在线预览">👁️</button>' : '') +
          (!isDir ? '<a class="mini-btn" href="' + downloadUrl + '" download="' + esc(item.name) + '" title="下载文件" style="text-decoration:none">⬇️</a>' : '') +
          '<button class="mini-btn danger" data-op="del" title="删除">🗑️</button>' +
        '</div>' +
      '</td>' +
    '</tr>';
  }

  tbody.innerHTML = rowsHtml;

  // 绑定行点击
  tbody.querySelectorAll('.files-row').forEach(row => {
    if (row.dataset.parent) {
      row.addEventListener('click', () => loadFilesDir(filesState.parent));
      return;
    }
    const itemPath = row.dataset.path;
    const itemName = row.dataset.name;
    const itemType = row.dataset.type;

    // 点击行名称进入目录或预览
    const nameCell = row.querySelector('.files-cell-name');
    if (nameCell) {
      nameCell.addEventListener('click', e => {
        e.stopPropagation();
        if (itemType === 'dir') loadFilesDir(itemPath);
        else previewFile(filesState.agentId, itemPath, itemName);
      });
    }

    // @文件 按钮
    const atBtn = row.querySelector('[data-op="at"]');
    if (atBtn) {
      atBtn.addEventListener('click', e => {
        e.stopPropagation();
        atFileToChat(itemPath, itemName);
      });
    }

    // 预览按钮
    const prevBtn = row.querySelector('[data-op="preview"]');
    if (prevBtn) {
      prevBtn.addEventListener('click', e => {
        e.stopPropagation();
        previewFile(filesState.agentId, itemPath, itemName);
      });
    }

    // 选择复选框（批量操作）
    const check = row.querySelector('.files-check');
    if (check) {
      check.addEventListener('click', e => e.stopPropagation());
      check.addEventListener('change', () => {
        if (check.checked) filesState.selected.add(itemPath);
        else filesState.selected.delete(itemPath);
        row.classList.toggle('selected', check.checked);
        syncBatchSelection();
      });
    }

    // 删除按钮
    const delBtn = row.querySelector('[data-op="del"]');
    if (delBtn) {
      delBtn.addEventListener('click', async e => {
        e.stopPropagation();
        const label = itemType === 'dir' ? '文件夹及其内容' : '文件';
        if (!confirm('确定在远程主机上删除此' + label + '「' + itemName + '」？此操作不可恢复。')) return;
        const r = await api('/agents/fs/remove?agent=' + encodeURIComponent(filesState.agentId) + '&path=' + encodeURIComponent(itemPath), { method: 'DELETE' });
        if (!r.ok) { toast(r.error || '删除失败', true); return; }
        toast('✓ 已删除 ' + itemName);
        loadFilesDir(filesState.path);
      });
    }
  });

  const dirCount = filtered.filter(x => x.type === 'dir').length;
  const fileCount = filtered.filter(x => x.type !== 'dir').length;
  $('files-stats').textContent = (dirCount ? dirCount + ' 个文件夹 · ' : '') + fileCount + ' 个文件';
  $('files-current-path-text').textContent = filesState.path || filesState.home || '';
  syncBatchSelection();
}

/** 批量操作：同步复选框/表头全选/批量条状态 */
function syncBatchSelection() {
  const box = $('files-check-all');
  if (box) {
    const rows = document.querySelectorAll('#files-list .files-check');
    const checked = document.querySelectorAll('#files-list .files-check:checked');
    box.checked = rows.length > 0 && checked.length === rows.length;
    box.indeterminate = checked.length > 0 && checked.length < rows.length;
  }
  const n = filesState.selected.size;
  const countEl = $('files-batch-count');
  if (countEl) countEl.textContent = '已选 ' + n + ' 项';
  const bar = $('files-batch-bar');
  if (bar) bar.classList.toggle('on', n > 0);
}

/** 加载指定目录的文件 */
async function loadFilesDir(dirPath) {
  if (!filesState.agentId) return;
  filesState.loading = true;
  filesState.error = '';
  renderFilesTable();

  const url = '/agents/fs/list?agent=' + encodeURIComponent(filesState.agentId) +
    (dirPath ? '&path=' + encodeURIComponent(dirPath) : '') + '&all=1';
  const r = await api(url);
  filesState.loading = false;

  if (!r.ok) {
    filesState.error = r.error || '加载目录失败';
    renderFilesTable();
    return;
  }

  filesState.path = r.data.path || dirPath || '';
  filesState.home = r.data.home || '';
  filesState.parent = r.data.parent || '';
  filesState.entries = r.data.entries || [];
  filesState.truncated = Boolean(r.data.truncated);

  renderFilesCrumbs();
  renderFilesTable();
}

/** 初始化并渲染文件管理视图 */
async function renderFilesView() {
  const sel = $('files-agent-select');
  if (!sel) return;

  // 刷新子智能体列表
  if (!state.agents.length) await loadAgents();

  const agents = state.agents.filter(a => a.enabled !== false);
  if (!agents.length) {
    $('files-list').innerHTML = '<tr><td colspan="4"><div class="files-empty-box"><span>🤖</span><span>尚未创建任何子智能体，请先在「子智能体」页创建。</span></div></td></tr>';
    return;
  }

  // 保持当前选中的智能体或默认第一个
  if (!filesState.agentId || !agents.some(a => a.id === filesState.agentId)) {
    filesState.agentId = agents[0].id;
  }

  let opts = '';
  for (const a of agents) {
    const dirBasename = a.workDir ? a.workDir.split('/').pop().split('\\\\').pop() : '';
    opts += '<option value="' + esc(a.id) + '"' + (a.id === filesState.agentId ? ' selected' : '') + '>' +
      esc(a.name) + (dirBasename ? ' (' + esc(dirBasename) + ')' : '') +
    '</option>';
  }
  sel.innerHTML = opts;

  if (!filesState.initialized) {
    filesState.initialized = true;

    sel.addEventListener('change', () => {
      filesState.agentId = sel.value;
      filesState.path = '';
      loadFilesDir('');
    });

    // 搜索过滤
    const searchInp = $('files-search');
    const clearBtn = $('files-search-clear');
    if (searchInp) {
      searchInp.addEventListener('input', () => {
        filesState.searchKeyword = searchInp.value;
        if (clearBtn) clearBtn.style.display = searchInp.value ? 'inline-block' : 'none';
        renderFilesTable();
      });
    }
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        searchInp.value = '';
        filesState.searchKeyword = '';
        clearBtn.style.display = 'none';
        renderFilesTable();
      });
    }

    // 隐藏文件开关
    const hideBtn = $('btn-files-hidden');
    if (hideBtn) {
      hideBtn.addEventListener('click', () => {
        filesState.showHidden = !filesState.showHidden;
        hideBtn.classList.toggle('pri', filesState.showHidden);
        hideBtn.textContent = filesState.showHidden ? '✓ 显示隐藏项' : '显示隐藏项';
        renderFilesTable();
      });
    }

    // 刷新按钮
    const refreshBtn = $('btn-files-refresh');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => loadFilesDir(filesState.path));
    }

    // 批量操作条：全选 / 批量@ / 批量下载 / 批量删除 / 取消选择
    const checkAll = $('files-check-all');
    if (checkAll) {
      checkAll.addEventListener('change', () => {
        const check = checkAll.checked;
        (filesState.entries || []).forEach(e => {
          if (check) filesState.selected.add(e.path);
          else filesState.selected.delete(e.path);
        });
        renderFilesTable();
      });
    }
    const batchBar = $('files-batch-bar');
    if (batchBar) {
      const bAt = $('btn-batch-at');
      if (bAt) bAt.addEventListener('click', () => batchAt());
      const bDl = $('btn-batch-download');
      if (bDl) bDl.addEventListener('click', () => batchDownload());
      const bDel = $('btn-batch-del');
      if (bDel) bDel.addEventListener('click', () => batchDelete());
      const bClear = $('btn-batch-clear');
      if (bClear) bClear.addEventListener('click', () => {
        filesState.selected.clear();
        renderFilesTable();
      });
    }

    // 新建文件夹按钮
    const mkdirBtn = $('btn-files-mkdir');
    if (mkdirBtn) {
      mkdirBtn.addEventListener('click', async () => {
        if (!filesState.path) { toast('请先加载目录', true); return; }
        const name = prompt('在当前目录下新建文件夹：\\n' + filesState.path, '');
        if (!name || !name.trim()) return;
        const r = await api('/agents/fs/mkdir', {
          method: 'POST',
          body: JSON.stringify({ agent: filesState.agentId, path: filesState.path, name: name.trim() })
        });
        if (!r.ok) { toast(r.error || '创建文件夹失败', true); return; }
        toast('✓ 已创建文件夹「' + name.trim() + '」');
        loadFilesDir(filesState.path);
      });
    }

    // 上传文件按钮与拖放
    const uploadBtn = $('btn-files-upload');
    const fileInp = $('files-file-input');
    if (uploadBtn && fileInp) {
      uploadBtn.addEventListener('click', () => {
        if (!filesState.path) { toast('请先选择目录', true); return; }
        fileInp.click();
      });
      fileInp.addEventListener('change', async () => {
        const files = Array.from(fileInp.files || []);
        fileInp.value = '';
        if (!files.length || !filesState.path) return;
        await uploadFilesToAgent(filesState.agentId, filesState.path, files);
      });
    }

    // 拖放区域
    const dropArea = $('files-drop-area');
    if (dropArea) {
      let dragDepth = 0;
      dropArea.addEventListener('dragenter', e => {
        if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
        e.preventDefault();
        dragDepth++;
        dropArea.classList.add('drop-hover');
      });
      dropArea.addEventListener('dragover', e => {
        if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        dropArea.classList.add('drop-hover');
      });
      dropArea.addEventListener('dragleave', () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth) dropArea.classList.remove('drop-hover');
      });
      dropArea.addEventListener('drop', async e => {
        e.preventDefault();
        dragDepth = 0;
        dropArea.classList.remove('drop-hover');
        const files = Array.from(e.dataTransfer?.files || []);
        if (!files.length || !filesState.path) return;
        await uploadFilesToAgent(filesState.agentId, filesState.path, files);
      });
    }
  }

  // 加载初始目录
  if (!filesState.path) {
    loadFilesDir('');
  } else {
    renderFilesCrumbs();
    renderFilesTable();
  }
}

/** 向上批量上传文件到远程目录 */
async function uploadFilesToAgent(agentId, destPath, files) {
  toast('正在上传 ' + files.length + ' 个文件到工作空间…');
  let successCount = 0;
  for (const f of files) {
    try {
      const fd = new FormData();
      fd.append('files', f, f.name);
      const res = await fetch(API + '/agents/fs/upload?agent=' + encodeURIComponent(agentId) + '&path=' + encodeURIComponent(destPath), {
        method: 'POST',
        body: fd,
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.ok) successCount++;
      else toast('文件「' + f.name + '」上传失败: ' + (json.error || 'HTTP ' + res.status), true);
    } catch (e) {
      toast('文件「' + f.name + '」上传网络错误', true);
    }
  }
  if (successCount > 0) {
    toast('✓ 已成功上传 ' + successCount + '/' + files.length + ' 个文件');
    loadFilesDir(destPath);
  }
}

// ---------- 批量操作：批量 @ 引用 / 批量下载 / 批量删除 ----------

/** 取当前选中且仍存在于列表中的条目 */
function getSelectedEntries() {
  return (filesState.entries || []).filter(e => filesState.selected.has(e.path));
}

/** 批量 @ 引用：把选中文件以 @智能体:相对路径 形式填入对话输入框 */
async function batchAt() {
  const items = getSelectedEntries();
  if (!items.length) { toast('请先选择文件', true); return; }
  const agent = state.agents.find(a => a.id === filesState.agentId);
  const agentName = agent ? agent.name : (filesState.agentId || '智能体');
  const refs = items.map(it => {
    let refPath = it.path;
    if (filesState.home && refPath.startsWith(filesState.home)) {
      refPath = refPath.slice(filesState.home.length);
      while (refPath.startsWith('/') || refPath.startsWith('\\\\')) refPath = refPath.slice(1);
    }
    return '@' + agentName + ':' + (refPath || it.name);
  });
  switchView('work');
  const inp = $('input');
  if (inp) {
    const val = inp.value || '';
    const insertText = refs.join(' ') + ' ';
    inp.value = val ? (val.endsWith(' ') ? val + insertText : val + ' ' + insertText) : insertText;
    inp.focus();
    pulseComposer();
    hintComposer('已引用 ' + refs.length + ' 个文件（@' + agentName + ':…）');
  }
  filesState.selected.clear();
  syncBatchSelection();
}

/** 批量下载：逐个抓取选中文件并触发浏览器下载（多个同名自动加序号） */
async function batchDownload() {
  const items = getSelectedEntries().filter(it => it.type !== 'dir');
  if (!items.length) { toast('请选择要下载的文件', true); return; }
  toast('正在下载 ' + items.length + ' 个文件…');
  const usedNames = {};
  let ok = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const url = API + '/agents/fs/download?agent=' + encodeURIComponent(filesState.agentId) + '&path=' + encodeURIComponent(it.path);
    try {
      const res = await fetch(url);
      if (!res.ok) { toast('「' + it.name + '」下载失败 (HTTP ' + res.status + ')', true); continue; }
      const buf = await res.arrayBuffer();
      const blob = new Blob([buf], { type: 'application/octet-stream' });
      const a = document.createElement('a');
      let fname = it.name;
      if (usedNames[fname]) { usedNames[fname]++; const dot = fname.lastIndexOf('.'); fname = dot > 0 ? (fname.slice(0, dot) + '_' + usedNames[fname] + fname.slice(dot)) : (fname + '_' + usedNames[fname]); }
      else usedNames[fname] = 1;
      a.href = URL.createObjectURL(blob);
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      ok++;
    } catch (e) {
      toast('「' + it.name + '」下载出错', true);
    }
    // 多个文件之间稍作间隔，避免浏览器拦截连续下载
    if (i < items.length - 1) await new Promise(r => setTimeout(r, 250));
  }
  toast(ok === items.length ? '✓ 已下载 ' + ok + ' 个文件' : '已下载 ' + ok + '/' + items.length + ' 个文件', ok === 0);
}

/** 批量删除：确认后逐个删除选中条目（文件夹含其内容） */
async function batchDelete() {
  const items = getSelectedEntries();
  if (!items.length) { toast('请先选择文件', true); return; }
  const dirs = items.filter(it => it.type === 'dir').length;
  const names = items.map(it => it.name).join('、');
  const warn = dirs ? '（含 ' + dirs + ' 个文件夹及其全部内容）' : '';
  if (!confirm('确定在远程主机上删除选中的 ' + items.length + ' 个项目' + warn + '？\\n\\n' + names + '\\n\\n此操作不可恢复。')) return;
  let ok = 0, fail = 0;
  for (const it of items) {
    const r = await api('/agents/fs/remove?agent=' + encodeURIComponent(filesState.agentId) + '&path=' + encodeURIComponent(it.path), { method: 'DELETE' });
    if (r.ok) ok++;
    else { fail++; toast('删除「' + it.name + '」失败: ' + (r.error || '未知错误'), true); }
  }
  filesState.selected.clear();
  if (ok > 0) toast('✓ 已删除 ' + ok + (fail ? ' 个（' + fail + ' 个失败）' : ' 个'));
  loadFilesDir(filesState.path);
}

// ---------- 设置视图 ----------
function renderSettings() {
  const s = state.settings || { onenat: {}, planner: {} };
  $('set-base').value = s.onenat.baseUrl || '';
  $('set-key').value = s.onenat.apiKey || '';
  $('set-refresh').value = s.onenat.autoRefreshMs || 60000;
  $('set-ai-token').value = s.aiToken || '';
  renderAiInstall();
  fillPlannerAgentSetting();
}
/** AI 安装提示词：以浏览器当前访问地址为准（反代/远程场景自动匹配），内嵌 APIKEY，发给 AI 照做即可 */
function renderAiInstall() {
  const token = $('set-ai-token').value;
  const base = location.origin + PREFIX;
  const tok = token || '<先生成APIKEY>';
  $('set-ai-install').value =
    '请安装 OneNat WorkBuddy 技能（多智能体工作台：发任务/管理任务/监控/定时任务/文件管理等 11 个工具）。\\n' +
    '1. 在终端执行安装命令（会自动装到本机所有 AI 技能目录 DSH/ZCode/Claude 并自检）：\\n' +
    '   curl -fsSL ' + base + '/install-skill.sh | bash -s -- --base-url ' + base + ' --token ' + tok + '\\n' +
    '2. 安装后执行 wb.mjs tools 验证连通，并汇报安装结果。\\n' +
    '3. 之后即可用 wb.mjs 或技能里的工具操作工作台，例如：wb.mjs monitor overview 看监控态势；wb.mjs task create --title x --agents <智能体ID> --message "任务内容" 发任务。';
}
$('btn-copy-ai-install').addEventListener('click', () => {
  if (!$('set-ai-token').value) { toast('请先「生成 / 重置」APIKEY', true); return; }
  navigator.clipboard.writeText($('set-ai-install').value).then(() => toast('✓ 安装提示词已复制，发给 AI 即可安装'), () => toast('复制失败，请手动选择复制', true));
});
$('btn-reset-ai-token').addEventListener('click', async () => {
  if (!confirm('生成新 APIKEY？旧令牌立即失效，已安装到各智能体的 SKILL 需要更新令牌。')) return;
  const r = await api('/settings/ai-token/reset', { method: 'POST' });
  if (r.ok && r.data && r.data.token) {
    $('set-ai-token').value = r.data.token;
    state.settings = Object.assign({}, state.settings || {}, { aiToken: r.data.token });
    renderAiInstall();
    toast('✓ 新 APIKEY 已生成（无需重启）');
  } else toast(r.error || '生成失败', true);
});
async function fillPlannerAgentSetting() {
  const sel = $('set-planner-agent'), note = $('set-planner-note');
  const r = await api('/planner/options');
  const d = (r.ok && r.data) || {};
  const agents = d.agents || [];
  const cur = d.current || {};
  let opts = '';
  const autoName = (agents.find(a => a.id === cur.agentId) || {}).name || (cur.auto ? '未配置' : '');
  opts += '<option value=""' + (cur.auto ? ' selected' : '') + '>（自动）' + esc(autoName || '本地子智能体优先') + '</option>';
  for (const a of agents) {
    opts += '<option value="' + esc(a.id) + '"' + (!cur.auto && cur.agentId === a.id ? ' selected' : '') + '>' + esc(a.name) + '</option>';
  }
  sel.innerHTML = opts;
  if (d.error) note.textContent = '⚠️ 规划器当前不可用：' + d.error + '。可在上方指定其他子智能体。';
  else note.textContent = '主任务拆解由「' + (cur.auto ? autoName + '（自动）' : ((agents.find(a => a.id === cur.agentId) || {}).name || cur.agentId)) + '」完成；拆解用模型可在聊天窗下方工具栏选择，仅作用于主调度。';
}
$('btn-save-settings').addEventListener('click', async () => {
  const plannerAgentId = $('set-planner-agent').value.trim();
  const payload = {
    onenat: { baseUrl: $('set-base').value.trim(), apiKey: $('set-key').value.trim(), autoRefreshMs: Number($('set-refresh').value) || 60000 },
    planner: { agentId: plannerAgentId },
  };
  const r = await api('/settings', { method: 'POST', body: JSON.stringify(payload) });
  if (r.ok) {
    state.settings = r.data;
    toast('✓ 设置已保存');
    loadResources();
    // 主智能体也可能在这里被改掉：走同一条切换通道，立即同步侧栏列表成员账本（免刷新）
    const pr = await api('/planner/config', {
      method: 'POST',
      body: JSON.stringify({ agentId: plannerAgentId, taskId: state.currentTaskId || '' })
    });
    if (pr.ok) {
      const d = pr.data || {};
      applyMainAgentSelection({
        agentId: d.agentId || '',
        auto: !d.agentId,
        resolvedAgentId: d.resolvedAgentId,
        resolvedAgentName: d.resolvedAgentName,
      });
      applyTaskSummaries(d.tasks);
      loadPlannerOptions();
    }
  }
  else toast(r.error || '保存失败', true);
});

// ---------- 抽屉与弹窗控制 ----------
function openDrawer(title) { $('drawer-title').textContent = title; $('drawer').classList.add('on'); $('drawer-mask').classList.add('on'); }
function closeDrawer() { $('drawer').classList.remove('on'); $('drawer-mask').classList.remove('on'); }
$('drawer-close').addEventListener('click', closeDrawer);
$('drawer-mask').addEventListener('click', closeDrawer);
function openModal(title, bodyHtml, actions) {
  $('modal-title').textContent = title; $('modal-body').innerHTML = bodyHtml;
  if (actions && actions.length) {
    $('modal-foot').innerHTML = actions.map((a, i) => '<button class="btn ' + (a.cls || '') + '" data-mact="' + i + '">' + esc(a.label) + '</button>').join(' ');
    actions.forEach((a, i) => {
      const b = document.querySelector('#modal-foot [data-mact="' + i + '"]');
      if (b) b.addEventListener('click', a.act);
    });
  } else {
    $('modal-foot').innerHTML = '<button class="btn" onclick="closeModal()">关闭</button>';
  }
  $('modal-mask').classList.add('on');
}

// ---------- 远端目录浏览器 ----------
function openDirBrowser(agentId, onPick) {
  const st = { path: '', home: '', parent: undefined, entries: [], truncated: false, showHidden: false };
  $('modal-title').textContent = '选择工作目录';
  $('modal-body').innerHTML =
    '<div class="db-top"><button class="mini-btn" id="db-home" title="主目录">🏠</button>' +
    '<input id="db-path" placeholder="主目录（可输入绝对路径后回车跳转）" style="flex:1;font-family:var(--mono)">' +
    '<button class="mini-btn" id="db-go">前往</button></div>' +
    '<div id="db-list" class="db-list"></div>' +
    '<div id="db-note" class="db-note"></div>' +
    '<div class="db-bar"><button class="mini-btn" id="db-new">＋ 新建文件夹</button>' +
    '<button class="mini-btn" id="db-hidden" style="border:none;background:transparent">显示隐藏文件</button></div>';
  $('modal-foot').innerHTML = '<button class="btn" id="db-cancel">取消</button><button class="btn pri" id="db-open">使用此目录</button>';
  $('modal-mask').classList.add('on');
  const listEl = $('db-list');
  function renderList() {
    const rows = [];
    if (st.parent) rows.push('<div class="db-row up" data-p=".."><span>↩ 上级目录</span><span class="chev">‹</span></div>');
    const items = st.entries.filter(e => st.showHidden || !e.hidden);
    if (!st.loading && !rows.length && !items.length) rows.push('<div class="db-empty">此目录下没有子目录</div>');
    for (const e of items) {
      rows.push('<div class="db-row' + (e.hidden ? ' is-hidden' : '') + '" data-p="' + esc(e.path) + '" title="' + esc(e.path) + '"><span>📁</span><span class="nm">' + esc(e.name) + '</span><span class="chev">›</span></div>');
    }
    if (st.loading) rows.push('<div class="db-empty">加载中…</div>');
    listEl.innerHTML = rows.join('');
    listEl.querySelectorAll('.db-row').forEach(row => row.addEventListener('click', () => {
      const p = row.dataset.p;
      load(p === '..' ? st.parent : p);
    }));
    $('db-note').textContent = st.truncated ? '文件夹过多，仅显示开头部分。' : (st.path ? '当前：' + st.path : '');
  }
  async function load(p) {
    st.loading = true; renderList();
    const r = await api('/agents/fs/list?agent=' + encodeURIComponent(agentId) + (p ? '&path=' + encodeURIComponent(p) : ''));
    st.loading = false;
    if (!r.ok) {
      listEl.innerHTML = '<div class="db-empty" style="color:var(--err)">浏览失败: ' + esc(r.error || '未知') + '</div>';
      return;
    }
    st.path = r.data.path; st.home = r.data.home; st.parent = r.data.parent;
    st.entries = r.data.entries || []; st.truncated = !!r.data.truncated;
    $('db-path').value = st.path === st.home ? '' : st.path;
    $('db-path').placeholder = st.path === st.home ? '主目录（' + st.home + '）' : '输入绝对路径后回车';
    renderList();
  }
  $('db-go').addEventListener('click', () => { const v = $('db-path').value.trim(); if (v) load(v); });
  $('db-path').addEventListener('keydown', e => { if (e.key === 'Enter') { const v = $('db-path').value.trim(); if (v) load(v); } });
  $('db-home').addEventListener('click', () => load(''));
  $('db-hidden').addEventListener('click', () => { st.showHidden = !st.showHidden; const b = $('db-hidden'); b.classList.toggle('on', st.showHidden); b.textContent = st.showHidden ? '✓ 显示隐藏文件' : '显示隐藏文件'; renderList(); });
  $('db-new').addEventListener('click', () => {
    if ($('db-create-row')) return;
    if (!st.path) { toast('请先进入一个目录', true); return; }
    const row = document.createElement('div');
    row.className = 'db-create'; row.id = 'db-create-row';
    row.innerHTML = '<span style="flex:none">在「' + esc(st.path.split('/').pop() || st.path) + '」中新建</span>' +
      '<input id="db-nf" placeholder="文件夹名称">' +
      '<button class="mini-btn" id="db-nf-ok">创建</button><button class="mini-btn" id="db-nf-no" style="border:none;background:transparent">取消</button>';
    listEl.insertBefore(row, listEl.firstElementChild);
    $('db-nf').focus();
    $('db-nf-no').addEventListener('click', () => row.remove());
    $('db-nf-ok').addEventListener('click', async () => {
      const name = $('db-nf').value.trim();
      if (!name) return;
      const r = await api('/agents/fs/mkdir', { method: 'POST', body: JSON.stringify({ agent: agentId, path: st.path, name }) });
      if (!r.ok) { toast(r.error || '创建失败', true); return; }
      toast('✓ 已创建 ' + name);
      load(st.path);
    });
  });
  $('db-cancel').addEventListener('click', closeModal);
  $('db-open').addEventListener('click', () => { if (!st.path) { toast('尚未加载目录', true); return; } onPick(st.path); closeModal(); });
  load('');
}

boot();
</script>
</body>
</html>`
}
