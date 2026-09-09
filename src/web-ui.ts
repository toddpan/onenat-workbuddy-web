/**
 * @dsh-external/onenat-workbuddy - Interactive Web Console UI
 *
 * 单页控制台: 工作台(任务多轮聊天) / 子智能体 / 资源目录 / 编排看板 / 设置
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

export function renderWebUi(prefix: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
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
body { background: var(--bg); color: var(--tx); font-family: var(--font); font-size: 14px; overflow: hidden; -webkit-font-smoothing: antialiased; }
button { font-family: inherit; cursor: pointer; border: none; outline: none; }
input, textarea, select { font-family: inherit; font-size: 13px; background: var(--bg); border: 1px solid var(--line); color: var(--tx); border-radius: var(--rad-sm); padding: 8px 10px; outline: none; width: 100%; }
input:focus, textarea:focus, select:focus { border-color: var(--pri); }
textarea { resize: vertical; min-height: 56px; }
::placeholder { color: var(--tx3); }
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-thumb { background: var(--line2); border-radius: 3px; }
::-webkit-scrollbar-track { background: transparent; }

/* ---- Layout ---- */
#app { display: flex; flex-direction: column; height: 100vh; width: 100vw; overflow: hidden; }
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
nav { display: flex; gap: 2px; }
nav button {
  background: transparent; color: var(--tx2); padding: 6px 12px; border-radius: var(--rad-sm);
  font-size: 13px; font-weight: 500; transition: all .15s ease;
}
nav button:hover { color: var(--tx); background: var(--bg3); }
nav button.on { color: var(--pri); background: var(--pri-light); font-weight: 600; }
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
.member-chips { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.mchip {
  display: inline-flex; align-items: center; gap: 5px; background: var(--bg3); border: 1px solid var(--line2);
  font-size: 11.5px; color: var(--tx2); border-radius: 999px; padding: 2px 8px; user-select: none;
}
.mchip .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); flex: none; }
.mchip .x { cursor: pointer; color: var(--tx3); font-size: 11px; margin-left: 2px; }
.mchip .x:hover { color: var(--err); }

.chat-scroll {
  flex: 1; overflow-y: auto; padding: 18px 24px 28px; scroll-behavior: auto;
}
.chat-empty {
  height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center;
  color: var(--tx3); gap: 12px; user-select: none;
}
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

/* DSH Web 规范 Markdown 内容区 */
.msg .content {
  line-height: 1.65; word-break: break-word; font-size: 13.5px; color: var(--tx);
}
.msg.user .content {
  background: #1e293b; border: 1px solid var(--line2); border-radius: 12px 2px 12px 12px;
  padding: 10px 14px; display: inline-block; text-align: left;
}
.msg.user .content p { margin: 0; }

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

/* 编排计划卡片 */
.plan-card {
  border: 1px solid var(--line2); background: var(--bg2); border-radius: var(--rad); padding: 12px 16px; margin: 8px 0 20px;
}
.plan-card h4 { font-size: 13px; color: var(--acc); margin-bottom: 10px; display: flex; align-items: center; justify-content: space-between; }
.plan-row {
  display: flex; align-items: center; gap: 10px; padding: 7px 0; border-top: 1px dashed var(--line); font-size: 12.5px;
}
.plan-row .st {
  flex: none; width: 68px; text-align: center; font-size: 10.5px; border-radius: 999px; padding: 2px 0; font-weight: 500;
}
.st.pending { background: var(--bg3); color: var(--tx3); }
.st.running { background: var(--warn-light); color: var(--warn); }
.st.completed { background: var(--ok-light); color: var(--ok); }
.st.failed { background: var(--err-light); color: var(--err); }
.st.skipped { background: var(--bg3); color: var(--tx3); }
.plan-row .ag { color: var(--tx3); font-size: 11.5px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.plan-row .ops { display: flex; gap: 6px; flex: none; }

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
  padding: 7px 14px; display: none; font-weight: 600; font-size: 12px; flex: none;
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
.mention-popup {
  position: absolute; bottom: 100%; left: 16px; width: 340px; max-height: 280px;
  background: var(--bg2); border: 1px solid var(--line2); border-radius: 10px;
  box-shadow: 0 8px 30px rgba(0,0,0,.65); z-index: 35; display: none; flex-direction: column;
  overflow: hidden; margin-bottom: 8px;
}
.mention-popup.on { display: flex; }
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
</style>
</head>
<body>
<div id="app">
  <header>
    <div class="brand"><div class="logo">⚡</div><span>OneNat WorkBuddy</span><small>多智能体协作工作台</small></div>
    <nav id="nav">
      <button data-v="work" class="on">💬 工作台</button>
      <button data-v="agents">🤖 子智能体</button>
      <button data-v="resources">🗂 资源目录</button>
      <button data-v="board">📊 编排看板</button>
      <button data-v="settings">⚙️ 设置</button>
    </nav>
    <div class="hspacer"></div>
    <div class="chip" id="onenat-chip"><span class="dot" id="onenat-dot"></span><span id="onenat-text">ONENAT 连接中…</span></div>
  </header>
  <main>
    <div class="view on" id="view-work">
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
          <span class="title" id="chat-title" title="双击重命名">选择或新建任务</span>
          <button class="mini-btn" id="btn-rename-task" style="display:none" title="重命名会话">✏️</button>
          <span class="badge mode" id="chat-mode" style="display:none"></span>
          <span class="hspacer"></span>
          <button class="btn-stop" id="btn-stop">■ 停止</button>
          <button class="mini-btn" id="btn-arch-task" style="display:none" title="归档会话">🗄️ 归档</button>
          <button class="mini-btn danger" id="btn-del-task" style="display:none">删除</button>
        </div>
        <div class="chat-scroll" id="chat-scroll">
          <div class="chat-empty" id="chat-empty">
            <div style="font-size:36px">⚡</div>
            <div style="font-weight:600;font-size:15px;color:var(--tx)">OneNat WorkBuddy · 智能体协作工作台</div>
            <div style="font-size:12.5px;max-width:420px;text-align:center;line-height:1.6">点击「＋ 新建任务」直接开启会话。在输入框中键入 @ 可即时指定智能体或注入资源。</div>
          </div>
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
          <div class="chat-input">
            <button class="mini-btn" id="btn-attach" title="上传附件到工作区" style="padding:10px 12px">📎</button>
            <input type="file" id="file-input" multiple style="display:none" />
            <textarea id="input" placeholder="输入消息…（输入 @ 可指定智能体或绑定资源，Enter 发送）"></textarea>
            <button class="btn-send" id="btn-send">发送</button>
          </div>
          <div class="composer-bar">
            <span class="hspacer"></span>
            <select class="cfg-sel" id="chat-model" title="主调度模型（主任务拆解用，不影响成员子智能体）" style="display:none">
              <option value="">主调度默认模型</option>
            </select>
          </div>
        </div>
      </section>
    </div>
    <div class="view" id="view-agents"><div class="panel">
      <div class="panel-head"><h2>子智能体池</h2><span class="sub">绑定 ONENAT 上的 DSH 实体（稳定 ID，端口变化不影响）· 配置模式/模型/提示词/可用资源</span><span class="hspacer"></span><button class="btn pri" id="btn-new-agent">＋ 新建子智能体</button></div>
      <div id="agent-list"></div>
    </div></div>
    <div class="view" id="view-resources"><div class="panel">
      <div class="panel-head"><h2>资源目录</h2><span class="sub" id="res-sub"></span><span class="hspacer"></span><button class="btn" id="btn-res-refresh">↻ 强制刷新</button></div>
      <div class="card" style="padding:0"><table class="res" id="res-table"><thead><tr><th>资源</th><th>类型</th><th>公网入口（实时解析）</th><th>内网目标</th><th>技能</th></tr></thead><tbody></tbody></table></div>
    </div></div>
    <div class="view" id="view-board"><div class="panel">
      <div class="panel-head"><h2>编排看板</h2><span class="sub">orchestrate 模式任务的计划与子任务执行视图</span></div>
      <div id="board-list"></div>
    </div></div>
    <div class="view" id="view-settings"><div class="panel" style="max-width:760px">
      <div class="panel-head"><h2>设置</h2></div>
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
      <button class="btn pri" id="btn-save-settings">保存设置</button>
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

/**
 * 前端核心状态管理与缓存层（对齐 DSH Web Client Store 架构）
 */
const state = {
  resources: [],
  agents: [],
  tasks: [],
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
async function api(path, opts) {
  const res = await fetch(API + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
  let json = null; try { json = await res.json(); } catch (e) {}
  if (!json) json = { ok: false, error: 'HTTP ' + res.status };
  return json;
}
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

// ---------- 导航 ----------
document.querySelectorAll('#nav button').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.v));
});
function switchView(v) {
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  document.querySelectorAll('.view').forEach(x => x.classList.toggle('on', x.id === 'view-' + v));
  if (v === 'resources') renderResources();
  if (v === 'agents') renderAgents();
  if (v === 'board') renderBoard();
  if (v === 'settings') renderSettings();
}

// ---------- 初始化引导 ----------
async function boot() {
  initMentionPopup();
  await Promise.all([loadResources(), loadAgents(), loadTasks(), loadSettings()]);
  await refreshMentionCandidates();
  renderTaskList();
  setInterval(loadTasksQuiet, 4000);
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
    $('onenat-text').textContent = 'ONENAT 未连接: ' + (r.error || '').slice(0, 60);
  }
}
async function loadAgents() {
  const r = await api('/agents');
  if (r.ok) state.agents = Array.isArray(r.data) ? r.data : [];
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
  const el = $('task-list');
  el.innerHTML = '';
  if (!state.tasks.length) {
    el.innerHTML = '<div style="color:var(--tx3);font-size:12.5px;padding:16px 12px;text-align:center">还没有任务，点击上方「新建任务」发起第一个会话。</div>';
    return;
  }

  // 搜索过滤
  const q = state.searchQuery;
  const filtered = q
    ? state.tasks.filter(t => (t.title && t.title.toLowerCase().includes(q)) || (t.lastPreview && t.lastPreview.toLowerCase().includes(q)))
    : state.tasks;

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

  const modeBadge = t.mode === 'orchestrate'
    ? '<span class="mode-badge">⚡编排</span>'
    : '<span class="mode-badge chat">💬直通</span>';

  const memberNames = (t.memberAgentIds || []).map(id => {
    const a = state.agents.find(x => x.id === id);
    return a ? a.name : id;
  }).join('、');

  const subText = t.lastPreview ? esc(t.lastPreview) : (memberNames ? '成员: ' + esc(memberNames) : fmtTime(t.updatedAt || t.createdAt));

  div.innerHTML =
    '<div class="row-top">' +
    '<span class="s ' + statusColor(t.running ? 'running' : t.status) + '"></span>' +
    '<span class="t">' + esc(t.title) + '</span>' +
    modeBadge +
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
    if ($('btn-del-task')) $('btn-del-task').style.display = '';
    if ($('btn-add-member')) $('btn-add-member').style.display = '';
    if ($('btn-rename-task')) $('btn-rename-task').style.display = '';
    if ($('btn-arch-task')) $('btn-arch-task').style.display = taskSummary.archivedAt ? 'none' : '';
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
}

/** 将任务数据渲染到对话视图（支持高性能批量/分块装配） */
function applyTaskToView(task, isInitialRender) {
  const ce = $('chat-empty'); if (ce) ce.style.display = 'none';
  if ($('chat-title')) $('chat-title').textContent = task.title || '未命名任务';
  if ($('btn-del-task')) $('btn-del-task').style.display = '';
  if ($('btn-add-member')) $('btn-add-member').style.display = '';
  if ($('btn-rename-task')) $('btn-rename-task').style.display = '';
  if ($('btn-arch-task')) $('btn-arch-task').style.display = task.archivedAt ? 'none' : '';
  refreshChatHead(task);
  setSending(task.status === 'running');

  const scroll = $('chat-scroll');
  if (!scroll) return;
  state.turnEls = {};
  scroll.innerHTML = '';

  const turns = task.turns || [];
  const total = turns.length;
  const HIDE = state.showAllTurns ? 0 : Math.max(0, total - state.initialVisibleLimit);

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
  $('btn-del-task').style.display = 'none';
  $('btn-add-member').style.display = 'none';
  $('btn-rename-task').style.display = 'none';
  $('btn-arch-task').style.display = 'none';
  $('chat-mode').style.display = 'none';
  $('member-chips').innerHTML = '';
}

function refreshChatHead(taskMaybe) {
  const task = taskMaybe || state.taskCache.get(state.currentTaskId) || state.tasks.find(t => t.id === state.currentTaskId);
  if (!task) return;
  const modeEl = $('chat-mode');
  modeEl.style.display = '';
  const isOrch = task.mode === 'orchestrate';
  modeEl.className = 'badge mode' + (isOrch ? '' : ' chat');
  modeEl.textContent = isOrch ? '⚡ 协同编排' : '💬 直通对话';
}

// ---------- RAF 节流流式更新与 SSE 事件连接 ----------
let pendingStreamUpdates = false;
const streamBuffer = { deltas: [], reasonings: [], tools: [] };

function scheduleStreamFlush() {
  if (pendingStreamUpdates) return;
  pendingStreamUpdates = true;
  requestAnimationFrame(() => {
    pendingStreamUpdates = false;
    // 刷写正文 delta
    while (streamBuffer.deltas.length > 0) {
      const { turnId, delta } = streamBuffer.deltas.shift();
      const el = state.turnEls[turnId];
      if (el && el.text) el.text.textContent += delta;
    }
    // 刷写思考 reasoning
    while (streamBuffer.reasonings.length > 0) {
      const { turnId, delta } = streamBuffer.reasonings.shift();
      const el = state.turnEls[turnId];
      if (el && el.rz) {
        el.rz.style.display = '';
        el.reasoning.textContent += delta;
        el.rzSum.textContent = '思考中 · ' + lastLine(el.reasoning.textContent);
      }
    }
    // 刷写工具调用
    while (streamBuffer.tools.length > 0) {
      const { turnId, tool } = streamBuffer.tools.shift();
      handleToolEvent(turnId, tool);
    }
    smartScrollBottom();
  });
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
      streamBuffer.deltas.push({ turnId: ev.turnId, delta: ev.delta });
      scheduleStreamFlush();
    } catch {}
  });

  es.addEventListener('turn_reasoning', e => {
    try {
      const ev = JSON.parse(e.data);
      streamBuffer.reasonings.push({ turnId: ev.turnId, delta: ev.delta });
      scheduleStreamFlush();
    } catch {}
  });

  es.addEventListener('turn_tool', e => {
    try {
      const ev = JSON.parse(e.data);
      streamBuffer.tools.push({ turnId: ev.turnId, tool: ev.tool });
      scheduleStreamFlush();
    } catch {}
  });

  es.addEventListener('turn_end', e => {
    try {
      const ev = JSON.parse(e.data);
      const el = state.turnEls[ev.turn.id];
      if (el) {
        el.text.innerHTML = md(withFileLinks(taskId, ev.turn.agentId, ev.turn.text || ''));
        const c = el.wrap.querySelector('.cursor');
        if (c) c.remove();
        if (el.rz && ev.turn.reasoning) {
          el.rz.style.display = '';
          el.reasoning.textContent = ev.turn.reasoning;
          el.rzSum.textContent = '已思考 ' + ev.turn.reasoning.length + ' 字';
        }
        if (el.tws && ev.turn.tools && ev.turn.tools.length) {
          el.tools = ev.turn.tools;
          ev.turn.tools.forEach(t => upsertToolRow(el.twsBody, t));
          syncToolsBar(el.tws, el.twsSum, el.tools);
        }
      }
      smartScrollBottom();
      loadTasksQuiet();
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
    loadTasksQuiet();
    for (const k in state.turnEls) {
      const c = state.turnEls[k].wrap.querySelector('.cursor');
      if (c) c.remove();
    }
    setSending(false);
  });

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

// ---------- 消息组件构建器 ----------
function buildTurnElement(taskId, turn) {
  const wrap = document.createElement('div');
  const roleClass = turn.role === 'user' ? 'user' : (turn.role === 'system' ? 'system' : 'agent');
  const isOrch = turn.agentName === '🎯 总调度汇总';
  wrap.className = 'msg ' + roleClass + (isOrch ? ' orchestrator' : '');

  const avatar = turn.role === 'user' ? '你' : (turn.role === 'system' ? '⚠' : (isOrch ? '🎯' : '🤖'));
  const name = turn.role === 'user' ? '你' : (turn.role === 'system' ? '系统' : esc(turn.agentName || '子智能体'));

  const agent = state.agents.find(a => a.id === turn.agentId);
  const modelBadge = agent && agent.model ? '<span class="tag-model">' + esc(String(agent.model).split('/').pop()) + '</span>' : '';

  wrap.innerHTML =
    '<div class="avatar">' + avatar + '</div>' +
    '<div class="bubble">' +
    '<div class="meta"><b>' + name + '</b>' + modelBadge + '<span>' + fmtTime(turn.at) + '</span></div>' +
    '<div class="rz" style="display:none"><div class="rz-head"><span class="rz-chev">▸</span>💭 思考过程<span class="rz-sum"></span></div><div class="rz-body"></div></div>' +
    '<div class="tws" style="display:none"><div class="tws-head"><span class="rz-chev">▸</span>🔧 工具调用<span class="tws-sum"></span></div><div class="tws-body"></div></div>' +
    '<div class="content markdown"></div>' +
    '</div>';

  const textEl = wrap.querySelector('.content');
  if (turn.streaming) {
    textEl.textContent = turn.text || '';
    const cur = document.createElement('span'); cur.className = 'cursor'; textEl.appendChild(cur);
  } else {
    textEl.innerHTML = turn.role === 'agent' ? md(withFileLinks(taskId, turn.agentId, turn.text || '')) : md(turn.text || '');
  }

  const rz = wrap.querySelector('.rz');
  const rzBody = wrap.querySelector('.rz-body');
  const rzSum = wrap.querySelector('.rz-sum');
  const rzChev = wrap.querySelector('.rz-chev');
  if (turn.reasoning && turn.role === 'agent') {
    rz.style.display = '';
    rzBody.textContent = turn.reasoning;
    rzSum.textContent = '已思考 ' + turn.reasoning.length + ' 字';
  }
  rz.querySelector('.rz-head').addEventListener('click', () => {
    const open = rzBody.style.display !== 'none';
    rzBody.style.display = open ? 'none' : 'block';
    rzChev.textContent = open ? '▸' : '▾';
  });

  const tws = wrap.querySelector('.tws');
  const twsBody = wrap.querySelector('.tws-body');
  const twsSum = wrap.querySelector('.tws-sum');
  tws.querySelector('.tws-head').addEventListener('click', () => {
    const open = twsBody.style.display !== 'none';
    twsBody.style.display = open ? 'none' : 'flex';
    tws.querySelector('.rz-chev').textContent = open ? '▸' : '▾';
  });

  if (turn.tools && turn.tools.length) {
    turn.tools.forEach(t => upsertToolRow(twsBody, t));
    syncToolsBar(tws, twsSum, turn.tools);
  }

  state.turnEls[turn.id] = {
    wrap, text: textEl, reasoning: rzBody, rz, rzSum, content: textEl, tws, twsBody, twsSum,
    tools: turn.tools && turn.tools.length ? turn.tools.slice() : undefined
  };

  return wrap;
}

function appendLiveTurn(taskId, turn) {
  const scroll = $('chat-scroll');
  const el = buildTurnElement(taskId, turn);
  scroll.appendChild(el);
  smartScrollBottom();
}

function upsertToolRow(twsBody, t) {
  let row = twsBody.querySelector('.tw-row[data-tid="' + t.id + '"]');
  if (!row) {
    row = document.createElement('div');
    row.className = 'tw-row'; row.dataset.tid = t.id;
    row.innerHTML = '<div class="tw-line"><span class="tw-ic"></span><span class="tw-name"></span><span class="tw-ms"></span><span class="tw-chev">▸</span></div><div class="tw-detail" style="display:none"></div>';
    twsBody.appendChild(row);
    row.querySelector('.tw-line').addEventListener('click', () => {
      const d = row.querySelector('.tw-detail');
      const open = d.style.display !== 'none';
      d.style.display = open ? 'none' : 'block';
      row.querySelector('.tw-chev').textContent = open ? '▸' : '▾';
    });
  }
  row.querySelector('.tw-ic').textContent = t.status === 'running' ? '⏳' : (t.status === 'failed' ? '✗' : '✓');
  row.querySelector('.tw-name').textContent = t.name + (t.args ? ' · ' + t.args.slice(0, 80) : '');
  row.querySelector('.tw-ms').textContent = t.ms !== undefined ? (t.ms / 1000).toFixed(1) + 's' : '';
  const parts = [];
  if (t.args) parts.push('参数: ' + t.args);
  if (t.result) parts.push('结果: ' + t.result);
  row.querySelector('.tw-detail').textContent = parts.join('\\n') || '（无详情）';
  return row;
}

function syncToolsBar(tws, twsSum, tools) {
  tws.style.display = '';
  const running = tools.some(t => t.status === 'running');
  twsSum.textContent = '（' + tools.length + '）' + (running ? ' · 执行中…' : '');
}

function handleToolEvent(turnId, tool) {
  const el = state.turnEls[turnId];
  if (!el || !el.twsBody) return;
  el.tools = el.tools || [];
  const i = el.tools.findIndex(t => t.id === tool.id);
  if (i >= 0) el.tools[i] = tool; else el.tools.push(tool);
  upsertToolRow(el.twsBody, tool);
  syncToolsBar(el.tws, el.twsSum, el.tools);
  if (tool.status === 'running') {
    el.twsBody.style.display = 'flex';
    el.tws.querySelector('.rz-chev').textContent = '▾';
  }
  smartScrollBottom();
}

// ---------- 编排计划卡片 (Plan Card) ----------
let planRowEls = {};

function createPlanCardElement(plan) {
  const card = document.createElement('div');
  card.className = 'plan-card';
  card.innerHTML = '<h4><span>📋 编排计划 · ' + esc(plan.strategy || '协同模式') + '</span><span style="font-size:11.5px;color:var(--tx3)">' + (plan.subtasks || []).length + ' 个子任务</span></h4>';
  for (const s of plan.subtasks || []) {
    const row = document.createElement('div');
    row.className = 'plan-row'; row.dataset.sid = s.id;
    const agent = state.agents.find(a => a.id === s.agentId);
    row.innerHTML = '<span class="st ' + s.status + '">' + s.status + '</span><span style="flex:none;font-weight:500">' + esc(s.title) + '</span><span class="ag">🤖 ' + esc(agent ? agent.name : s.agentId) + '</span><span class="ops">' +
      '<button class="mini-btn" data-op="logs">日志</button><button class="mini-btn" data-op="chat">会话</button>' + (s.status === 'failed' ? '<button class="mini-btn" data-op="retry">重试</button>' : '') + '</span>';
    row.querySelector('[data-op=logs]').addEventListener('click', () => showSubtaskLogs(s));
    row.querySelector('[data-op=chat]').addEventListener('click', () => showSubtaskChat(s.id, s.agentId));
    const rb = row.querySelector('[data-op=retry]');
    if (rb) rb.addEventListener('click', async () => { const r = await api('/tasks/' + state.currentTaskId + '/subtasks/' + s.id + '/retry', { method: 'POST' }); toast(r.ok ? '已重新派发' : (r.error || '失败'), !r.ok); });
    planRowEls[s.id] = row;
    card.appendChild(row);
  }
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
  $('btn-send').disabled = on;
  $('btn-stop').style.display = on ? 'inline-block' : 'none';
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
    await api('/tasks/' + state.currentTaskId + '/cancel', { method: 'POST' });
    toast('已发送停止指令');
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
  panel.innerHTML = '<div class="up-head"><b>📎 上传附件到工作区</b><span class="up-count"></span><span class="hspacer"></span><button class="mini-btn" id="up-close">✕</button></div><div class="up-rows"></div>';
  $('up-close').addEventListener('click', () => { panel.style.display = 'none'; });
  const rowsEl = panel.querySelector('.up-rows');
  const rows = files.map(f => ({ file: f, status: 'waiting', pct: 0 }));

  const statusText = r => r.status === 'waiting' ? '排队中…'
    : r.status === 'uploading'
      ? (r.pct >= 100 ? '⚡ 已到达服务器 · 正在分发到成员工作区…' : '上传中 ' + r.pct + '%')
    : r.status === 'done' ? '✓ 已上传' + (r.dest ? ' → ' + r.dest : '') + (r.memberCount > 1 ? '（已同步 ' + r.memberCount + ' 个成员）' : '')
    : '✗ 失败: ' + (r.err || '未知');

  function renderRow(r) {
    let el = r.el;
    if (!el) {
      el = document.createElement('div');
      el.className = 'up-row';
      el.innerHTML = '<div class="up-line"><span class="up-name"></span><span class="up-size"></span></div>' +
        '<div class="up-bar"><div class="up-bar-in"></div></div><div class="up-status"></div>';
      rowsEl.appendChild(el);
      r.el = el;
    }
    el.className = 'up-row ' + r.status;
    el.querySelector('.up-name').textContent = '📄 ' + r.file.name;
    el.querySelector('.up-name').title = r.file.name;
    el.querySelector('.up-size').textContent = fmtSize(r.file.size);
    el.querySelector('.up-bar-in').style.width = (r.status === 'done' ? 100 : r.pct) + '%';
    el.querySelector('.up-bar').classList.toggle('indet', r.status === 'uploading' && r.pct >= 100);
    el.querySelector('.up-status').textContent = statusText(r);
    const done = rows.filter(x => x.status === 'done').length;
    panel.querySelector('.up-count').textContent = done + '/' + rows.length;
  }
  rows.forEach(renderRow);

  (async () => {
    for (const r of rows) {
      r.status = 'uploading'; renderRow(r);
      try {
        const json = await new Promise((resolve, reject) => {
          const fd = new FormData();
          fd.append('files', r.file, r.file.name);
          const xhr = new XMLHttpRequest();
          xhr.open('POST', API + '/tasks/' + taskId + '/attachments');
          xhr.upload.onprogress = e => { if (e.lengthComputable) { r.pct = Math.round(e.loaded / e.total * 100); renderRow(r); } };
          xhr.onload = () => {
            let j = null; try { j = JSON.parse(xhr.responseText); } catch (e) {}
            if (xhr.status >= 200 && xhr.status < 300 && j && j.ok) resolve(j);
            else reject(new Error((j && j.error) || 'HTTP ' + xhr.status));
          };
          xhr.onerror = () => reject(new Error('网络错误'));
          xhr.send(fd);
        });
        const okResults = (json.data.results || []).filter(rr => rr.ok);
        const dest = okResults.flatMap(rr => (rr.files || []).map(f => f.path))[0];
        r.dest = dest;
        r.memberCount = okResults.length;
        r.status = 'done'; r.pct = 100; renderRow(r);
        appendAttachmentLine('[附件' + (r.memberCount > 1 ? '·' + r.memberCount + '成员' : '') + '] ' + (r.dest || r.file.name) + ' (' + fmtSize(r.file.size) + ')');
      } catch (e) {
        r.status = 'error'; r.err = e.message || String(e); renderRow(r);
      }
    }
    const okRows = rows.filter(r => r.status === 'done');
    if (okRows.length) {
      toast('已上传 ' + okRows.length + '/' + rows.length + ' 个附件，路径已填入输入框');
    } else toast('附件上传失败', true);
    if (rows.every(r => r.status === 'done')) setTimeout(() => { panel.style.display = 'none'; }, 2500);
  })();
}

function appendAttachmentLine(line) {
  const inp = $('input');
  inp.value = (inp.value ? inp.value.replace(/\\n$/, '') + '\\n' : '') + line;
  inp.focus();
}

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

    // 匹配光标前最近的一个 @ 符号
    const match = /@([^\s@]*)$/.exec(textBeforeCursor);
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
      return n.includes(mentionQuery) || id.includes(mentionQuery) || d.includes(mentionQuery);
    });

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

// ---------- 主调度模型选择 ----------
async function loadPlannerOptions() {
  const msel = $('chat-model');
  msel.style.display = '';
  msel.disabled = true;
  const r = await api('/planner/options');
  if (!r.ok || !r.data) { msel.disabled = false; return; }
  const d = r.data;
  const curModel = (d.current || {}).model || '';
  const groups = {};
  for (const m of d.models || []) { (groups[m.provider] = groups[m.provider] || []).push(m); }
  let mhtml = '';
  if (curModel && !Object.keys(groups).some(pv => (groups[pv] || []).some(m => pv + '/' + m.id === curModel))) {
    mhtml += '<option value="' + esc(curModel) + '" selected>' + esc(curModel + '（已保存）') + '</option>';
  }
  let first = true;
  for (const pv of Object.keys(groups)) {
    mhtml += '<optgroup label="' + esc(pv) + '">';
    for (const m of groups[pv]) {
      const v = pv + '/' + m.id;
      const selAttr = curModel ? (v === curModel ? ' selected' : '') : (first ? ' selected' : '');
      mhtml += '<option value="' + esc(v) + '"' + selAttr + '>' + esc(m.id + (m.isDefault ? ' ★' : '')) + '</option>';
      first = false;
    }
    mhtml += '</optgroup>';
  }
  msel.innerHTML = mhtml;
  msel.disabled = false;
  msel.title = '主调度模型（主任务拆解用）· ' + Object.keys(groups).length + ' 个提供商 / ' + (d.models || []).length + ' 个模型';
}
$('chat-model').addEventListener('change', async () => {
  const mv = $('chat-model').value;
  const r = await api('/planner/config', { method: 'POST', body: JSON.stringify({ model: mv || '' }) });
  if (r.ok) toast('✓ 主调度模型已更新为「' + (r.data.model || '默认') + '」');
  else toast(r.error || '保存失败', true);
});
loadPlannerOptions();

// 会话删除 / 重命名 / 归档
$('btn-del-task').addEventListener('click', async () => {
  if (!state.currentTaskId) return;
  if (!confirm('确定删除该任务及其全部会话记录？')) return;
  const id = state.currentTaskId;
  await api('/tasks/' + id, { method: 'DELETE' });
  state.taskCache.delete(id);
  state.currentTaskId = null;
  disconnectStream();
  resetChatView();
  loadTasks();
});
$('btn-rename-task').addEventListener('click', () => {
  const t = state.tasks.find(x => x.id === state.currentTaskId);
  if (t) promptRenameTask(t);
});
$('chat-title').addEventListener('dblclick', () => {
  const t = state.tasks.find(x => x.id === state.currentTaskId);
  if (t) promptRenameTask(t);
});
$('btn-arch-task').addEventListener('click', async () => {
  const id = state.currentTaskId;
  if (!id) return;
  const r = await api('/tasks/' + id + '/archive', { method: 'POST', body: JSON.stringify({ archived: true }) });
  if (r.ok) {
    toast('🗄️ 已归档');
    await loadTasks();
    renderTaskList();
  } else toast(r.error || '归档失败', true);
});

// ---------- 一键新建任务（免弹窗，自动生成会话并即刻开聊，参考 DSH 体验） ----------
$('btn-new-task').addEventListener('click', createNewTaskDirectly);
async function createNewTaskDirectly() {
  const allIds = state.agents.map(a => a.id);
  const r = await api('/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title: '新任务',
      memberAgentIds: allIds,
    })
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
    el.innerHTML = '<div class="card"><span class="sub" style="color:var(--tx3)">还没有子智能体。点击「新建子智能体」—— 从资源目录中选择一个 DSH 实例（稳定 ID 绑定，端口变化不影响），配置模式/模型/提示词与可用资源。</span></div>';
    return;
  }
  for (const a of state.agents) {
    const card = document.createElement('div'); card.className = 'card';
    const dshDesc = describeDshRef(a);
    const resDesc = (a.resources || []).map(r => r.alias || r.ref.mappingId || r.ref.appId).join('、') || '无';
    card.innerHTML = '<div class="row1"><h3>' + esc(a.name) + '</h3>' +
      (a.enabled === false ? '<span class="tag err">停用</span>' : '<span class="tag ok">启用</span>') +
      '<span class="tag">' + esc(a.agentPreset || 'cordis') + '</span>' +
      (a.model ? '<span class="tag">' + esc(a.model) + '</span>' : '') +
      (a.workDir ? '<span class="tag" title="远端工作目录">📁 ' + esc(a.workDir) + '</span>' : '') + '</div>' +
      '<div class="desc">DSH 实体: <span class="mono">' + esc(dshDesc) + '</span><br>绑定资源: ' + esc(resDesc) +
      (a.systemPrompt ? '<br>角色: ' + esc(a.systemPrompt.slice(0, 80)) : '') + '</div>' +
      '<div class="ops"><button class="btn" data-op="edit">编辑</button><button class="btn" data-op="ping">Ping 探活</button><button class="btn" data-op="preview">提示词预览</button><button class="btn danger" data-op="del">删除</button></div>';
    card.querySelector('[data-op=edit]').addEventListener('click', () => openAgentDrawer(a));
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
    '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px"><button class="mini-btn" id="ag-sync" style="padding:6px 10px">↻ 同步远端选项</button><span class="hint" id="ag-opts-hint" style="margin:0">预设 / 提供商 / 模型可从远端 DSH 拉取后下拉选择</span></div>' +
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
    const payload = collectAgent(isEdit ? agent : null);
    if (!payload) return;
    const r = await api('/agents', { method: 'POST', body: JSON.stringify(payload) });
    if (!r.ok) { toast(r.error || '保存失败', true); return; }
    closeDrawer(); await loadAgents(); renderAgents(); toast('✓ 子智能体已保存');
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

// ---------- 编排看板视图 ----------
function renderBoard() {
  const el = $('board-list'); el.innerHTML = '';
  const orchTasks = state.tasks.filter(t => t.plan || t.mode === 'orchestrate');
  if (!orchTasks.length) {
    el.innerHTML = '<div class="card"><span style="color:var(--tx3)">暂无编排任务。在工作台新建任务时选择多个子智能体即为协同编排模式。</span></div>';
    return;
  }
  for (const t of orchTasks) {
    const card = document.createElement('div'); card.className = 'card';
    const subs = (t.plan && t.plan.subtasks) || [];
    const done = subs.filter(s => s.status === 'completed').length;
    card.innerHTML = '<div class="row1"><h3>' + esc(t.title) + '</h3><span class="s ' + statusColor(t.running ? 'running' : t.status) + '" style="width:9px;height:9px;border-radius:50%"></span>' +
      '<span class="tag">' + (t.plan ? esc(t.plan.strategy) : '—') + '</span><span class="tag">' + done + '/' + subs.length + ' 完成</span>' +
      '<span class="tag ' + statusColor(t.status) + '">' + esc(t.status) + '</span></div>' +
      '<div style="margin-top:10px">' + subs.map(s => {
        const ag = state.agents.find(a => a.id === s.agentId);
        return '<div class="plan-row"><span class="st ' + s.status + '">' + s.status + '</span><span style="flex:none;font-weight:500">' + esc(s.title) + '</span><span class="ag">🤖 ' + esc(ag ? ag.name : s.agentId) + (s.error ? ' · ' + esc(s.error.slice(0, 60)) : '') + '</span>' +
          '<span class="ops"><button class="mini-btn" data-sid="' + s.id + '" data-op="logs">日志</button><button class="mini-btn" data-sid="' + s.id + '" data-op="chat">会话</button></span></div>';
      }).join('') + '</div>' +
      (t.summary ? '<div class="desc" style="margin-top:10px"><b>结论:</b> ' + esc(t.summary.finalConclusion || '').slice(0, 300) + '</div>' : '');
    card.querySelectorAll('[data-op=logs]').forEach(b => b.addEventListener('click', () => {
      const s = subs.find(x => x.id === b.dataset.sid); if (s) showSubtaskLogs(s);
    }));
    card.querySelectorAll('[data-op=chat]').forEach(b => b.addEventListener('click', () => {
      const s = subs.find(x => x.id === b.dataset.sid);
      showSubtaskChat(b.dataset.sid, s ? s.agentId : undefined);
    }));
    el.appendChild(card);
  }
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

// ---------- 设置视图 ----------
function renderSettings() {
  const s = state.settings || { onenat: {}, planner: {} };
  $('set-base').value = s.onenat.baseUrl || '';
  $('set-key').value = s.onenat.apiKey || '';
  $('set-refresh').value = s.onenat.autoRefreshMs || 60000;
  fillPlannerAgentSetting();
}
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
  const payload = {
    onenat: { baseUrl: $('set-base').value.trim(), apiKey: $('set-key').value.trim(), autoRefreshMs: Number($('set-refresh').value) || 60000 },
    planner: { agentId: $('set-planner-agent').value.trim() },
  };
  const r = await api('/settings', { method: 'POST', body: JSON.stringify(payload) });
  if (r.ok) { state.settings = r.data; toast('✓ 设置已保存'); loadResources(); }
  else toast(r.error || '保存失败', true);
});

// ---------- 抽屉与弹窗控制 ----------
function openDrawer(title) { $('drawer-title').textContent = title; $('drawer').classList.add('on'); $('drawer-mask').classList.add('on'); }
function closeDrawer() { $('drawer').classList.remove('on'); $('drawer-mask').classList.remove('on'); }
$('drawer-close').addEventListener('click', closeDrawer);
$('drawer-mask').addEventListener('click', closeDrawer);
function openModal(title, bodyHtml) {
  $('modal-title').textContent = title; $('modal-body').innerHTML = bodyHtml; $('modal-foot').innerHTML = '<button class="btn" onclick="closeModal()">关闭</button>';
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
