/**
 * onenat-workbuddy-web - 监控投屏页（独立暗色全屏，供挂在显示器/电视墙）
 *
 * 路由：GET {prefix}/monitor（登录门与控制台一致）。
 * 自包含单页：轮询 /api/monitor/overview（5s）与 /api/monitor/history（60s），
 * 无构建依赖、无外部资源。设计原则「给人看」：大字号 KPI、图标化任务类型、
 * 一句话可读状态、资源在用高亮。
 */

export function renderMonitorUi(prefix: string, version: string): string {
  const API = (prefix || '') + '/api'
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WorkBuddy 监控大屏</title>
<style>
:root {
  --bg: #0a0f1e; --panel: #101830; --panel2: #0d1426; --line: #1e2a4a;
  --tx: #e7edf7; --tx2: #93a4c3; --tx3: #5b6b8c;
  --pri: #38bdf8; --ok: #34d399; --err: #f87171; --warn: #fbbf24; --purple: #a78bfa;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body {
  background: var(--bg); color: var(--tx);
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', 'Segoe UI', sans-serif;
  font-size: 14px; overflow-x: hidden;
}
.wrap { padding: 14px 18px 20px; display: flex; flex-direction: column; gap: 12px; min-height: 100vh; }
header { display: flex; align-items: center; gap: 14px; }
header .logo { font-size: 22px; }
header h1 { font-size: 19px; font-weight: 700; letter-spacing: .5px; }
header .sub { color: var(--tx3); font-size: 12.5px; }
.spacer { flex: 1; }
.chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--line);
  background: var(--panel2); border-radius: 999px; padding: 4px 12px; font-size: 12.5px; color: var(--tx2); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--tx3); }
.dot.ok { background: var(--ok); box-shadow: 0 0 6px var(--ok); }
.dot.bad { background: var(--err); box-shadow: 0 0 6px var(--err); }
#clock { font-variant-numeric: tabular-nums; font-size: 15px; color: var(--tx); font-weight: 600; }
.fs-btn { cursor: pointer; border: 1px solid var(--line); background: var(--panel2); color: var(--tx2);
  border-radius: 8px; padding: 4px 10px; font-size: 12.5px; }
.fs-btn:hover { color: var(--tx); border-color: var(--pri); }

.kpis { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; }
.kpi { background: linear-gradient(180deg, var(--panel), var(--panel2)); border: 1px solid var(--line);
  border-radius: 14px; padding: 12px 16px 10px; position: relative; overflow: hidden; }
.kpi .lb { color: var(--tx2); font-size: 12.5px; }
.kpi .v { font-size: 30px; font-weight: 800; margin-top: 2px; font-variant-numeric: tabular-nums; line-height: 1.15; }
.kpi .d { color: var(--tx3); font-size: 11.5px; margin-top: 1px; }
.kpi .v.ok { color: var(--ok); }
.kpi .v.err { color: var(--err); }
.kpi .v.pri { color: var(--pri); }
.kpi .v.warn { color: var(--warn); }

.grid { display: grid; grid-template-columns: 5fr 4fr 4fr; gap: 12px; align-items: start; }
.panel { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px; }
.panel h2 { font-size: 13.5px; color: var(--tx2); font-weight: 600; display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.panel h2 .cnt { color: var(--pri); font-variant-numeric: tabular-nums; }
.panel h2 .spacer { flex: 1; }
.panel h2 .mini { font-size: 11.5px; color: var(--tx3); font-weight: 400; }

.agent-list { display: flex; flex-direction: column; gap: 8px; max-height: 46vh; overflow: auto; }
.agent { border: 1px solid var(--line); border-radius: 12px; padding: 9px 12px; background: var(--panel2); }
.agent .row1 { display: flex; align-items: center; gap: 8px; }
.agent .st { width: 9px; height: 9px; border-radius: 50%; background: var(--tx3); flex: none; }
.agent .st.on { background: var(--ok); box-shadow: 0 0 8px var(--ok); }
.agent .st.off { background: var(--err); box-shadow: 0 0 8px var(--err); }
.agent .st.dis { background: var(--tx3); }
.agent .nm { font-weight: 700; font-size: 14.5px; }
.agent .md { color: var(--tx3); font-size: 11.5px; }
.agent .spacer { flex: 1; }
.badge { font-size: 11px; border-radius: 999px; padding: 2px 9px; border: 1px solid var(--line); color: var(--tx2); white-space: nowrap; }
.badge.busy { color: var(--pri); border-color: rgba(56,189,248,.5); animation: pulse 1.6s ease-in-out infinite; }
.badge.idle { color: var(--tx3); }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
.agent .act { margin-top: 5px; font-size: 12.5px; color: var(--tx2); line-height: 1.5;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.agent .act b { color: var(--tx); font-weight: 600; }
.agent .res { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 5px; }
.res-chip { font-size: 11px; border: 1px solid var(--line); border-radius: 6px; padding: 2px 7px; color: var(--tx3); }
.res-chip.on { color: var(--tx2); }
.res-chip.hot { color: var(--warn); border-color: rgba(251,191,36,.55); background: rgba(251,191,36,.08); }
.res-chip.off { color: var(--err); border-color: rgba(248,113,113,.4); }

.task-list { display: flex; flex-direction: column; gap: 8px; max-height: 46vh; overflow: auto; }
.task { border: 1px solid var(--line); border-radius: 12px; padding: 9px 12px; background: var(--panel2); }
.task.done { opacity: .72; }
.task .row1 { display: flex; align-items: center; gap: 8px; }
.task .ic { font-size: 15px; flex: none; }
.task .tt { font-weight: 700; font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.task .spacer { flex: 1; }
.task .el { color: var(--tx3); font-size: 11.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.task .hl { margin-top: 4px; font-size: 12.5px; line-height: 1.5; }
.task .hl.run { color: var(--pri); }
.task .hl.ok { color: var(--ok); }
.task .hl.bad { color: var(--err); }
.task .hl.stop { color: var(--warn); }
.task .bar { margin-top: 6px; height: 4px; border-radius: 4px; background: var(--line); overflow: hidden; }
.task .bar i { display: block; height: 100%; background: linear-gradient(90deg, var(--pri), var(--ok)); border-radius: 4px; transition: width .6s; }
.task .sub { margin-top: 4px; font-size: 11.5px; color: var(--tx3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.empty { color: var(--tx3); font-size: 12.5px; padding: 14px 0; text-align: center; }

.feed { display: flex; flex-direction: column; gap: 8px; max-height: 46vh; overflow: auto; }
.ev { display: flex; gap: 8px; padding: 5px 4px; border-bottom: 1px dashed rgba(30,42,74,.6); font-size: 12.5px; line-height: 1.45; }
.ev:last-child { border-bottom: none; }
.ev .t { color: var(--tx3); font-variant-numeric: tabular-nums; flex: none; font-size: 11.5px; padding-top: 1px; }
.ev .m { color: var(--tx2); }
.ev .m b { color: var(--tx); }
.ev.error .m { color: #fca5a5; }
.ev.warn .m { color: #fcd34d; }

.alerts { display: none; gap: 8px; flex-wrap: wrap; }
.alerts.on { display: flex; }
.alert { border: 1px solid rgba(248,113,113,.45); background: rgba(248,113,113,.08); color: #fca5a5;
  border-radius: 10px; padding: 6px 12px; font-size: 12.5px; }
.alert.warn { border-color: rgba(251,191,36,.45); background: rgba(251,191,36,.08); color: #fcd34d; }

.charts { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.chart-box svg { width: 100%; height: 150px; display: block; }
.legend { display: flex; gap: 14px; font-size: 11.5px; color: var(--tx3); font-weight: 400; }
.legend i { display: inline-block; width: 10px; height: 3px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }

.sched-strip { display: flex; gap: 8px; flex-wrap: wrap; }
.sched { border: 1px solid var(--line); background: var(--panel2); border-radius: 10px; padding: 7px 11px; font-size: 12px; color: var(--tx2); }
.sched b { color: var(--tx); font-weight: 600; }
.sched .nx { color: var(--pri); font-variant-numeric: tabular-nums; }
.sched.off { opacity: .5; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: var(--line); border-radius: 8px; }
@media (max-width: 1100px) {
  .kpis { grid-template-columns: repeat(3, 1fr); }
  .grid { grid-template-columns: 1fr; }
  .charts { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div class="logo">⚡</div>
    <div>
      <h1>WorkBuddy 智能体监控大屏</h1>
      <div class="sub">多智能体协作工作台 · 实时运行态势</div>
    </div>
    <div class="spacer"></div>
    <span class="chip"><span class="dot" id="live-dot"></span><span id="live-text">连接中…</span></span>
    <span class="chip" id="clock">--:--:--</span>
    <button class="fs-btn" onclick="toggleFs()">⛶ 全屏</button>
    <span class="chip">v${version}</span>
  </header>

  <div class="alerts" id="alerts"></div>

  <div class="kpis" id="kpis"></div>

  <div class="grid">
    <div class="panel">
      <h2>🤖 子智能体 <span class="cnt" id="ag-cnt"></span><span class="spacer"></span><span class="mini">绿=在线 · 红=离线 · 灰=停用</span></h2>
      <div class="agent-list" id="agents"><div class="empty">加载中…</div></div>
    </div>
    <div class="panel">
      <h2>📋 任务会话 <span class="cnt" id="task-cnt"></span><span class="spacer"></span><span class="mini">⏰ 定时 · 🎯 编排 · 💬 直通</span></h2>
      <div class="task-list" id="tasks"><div class="empty">加载中…</div></div>
    </div>
    <div class="panel">
      <h2>🔔 实时动态</h2>
      <div class="feed" id="feed"><div class="empty">暂无事件</div></div>
    </div>
  </div>

  <div class="charts">
    <div class="panel chart-box">
      <h2>📈 近 24 小时任务趋势 <span class="spacer"></span><span class="legend"><span><i style="background:var(--pri)"></i>运行中</span><span><i style="background:var(--ok)"></i>今日完成累计</span><span><i style="background:var(--err)"></i>今日失败累计</span></span></h2>
      <svg id="chart-tasks" viewBox="0 0 600 150" preserveAspectRatio="none"></svg>
    </div>
    <div class="panel chart-box">
      <h2>🪙 近 24 小时 Token 消耗（今日累计） <span class="spacer"></span><span class="legend"><span><i style="background:var(--purple)"></i>输入</span><span><i style="background:var(--warn)"></i>输出</span></span></h2>
      <svg id="chart-tokens" viewBox="0 0 600 150" preserveAspectRatio="none"></svg>
    </div>
  </div>

  <div class="panel">
    <h2>⏰ 定时任务 <span class="spacer"></span><span class="mini">蓝色为下次触发倒计时</span></h2>
    <div class="sched-strip" id="scheds"><span class="empty">暂无定时任务</span></div>
  </div>
</div>

<script>
var API = '${API}';
var overview = null;
var histDays = [];
var histLabels = [];

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function fmtInt(n) { return (n || 0).toLocaleString('zh-CN'); }
function fmtTok(n) {
  n = n || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
  if (n >= 1e4) return (n / 1e4).toFixed(1) + 'k';
  return String(n);
}
function fmtElapse(ms) {
  if (!ms || ms < 0) return '';
  var s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  var m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + (s % 60) + 's';
  var h = Math.floor(m / 60);
  if (h < 24) return h + 'h' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd' + (h % 24) + 'h';
}
function fmtClock(ts) {
  if (!ts) return '--:--';
  var d = new Date(ts);
  return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0');
}
function fmtCountdown(ts) {
  if (!ts) return '';
  var diff = ts - Date.now();
  if (diff <= 0) return '即将触发';
  var m = Math.floor(diff / 60000);
  if (m < 60) return m + ' 分钟后';
  var h = Math.floor(m / 60);
  if (h < 24) return h + ' 小时 ' + (m % 60) + ' 分后';
  return Math.floor(h / 24) + ' 天后';
}
var EV_ICON = {
  task_started: '▶️', task_completed: '✅', task_failed: '❌', task_cancelled: '⏹️',
  subtask_completed: '✔️', subtask_failed: '✖️', plan_created: '🧩', schedule_fired: '⏰',
  agent_online: '🟢', agent_offline: '🔴', resource_drift: '🔀', resource_offline: '📴', resource_online: '🔌'
};

function toggleFs() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
}

async function fetchJson(url) {
  try {
    var res = await fetch(url, { headers: { 'Content-Type': 'application/json' } });
    if (res.status === 401) { location.reload(); return null; }
    return await res.json();
  } catch (e) { return null; }
}

function renderKpi(k) {
  var next = k.nextScheduleAt ? fmtCountdown(k.nextScheduleAt) : '';
  var tiles = [
    { lb: '🤖 在线智能体', v: k.agentsOnline + '<span style="font-size:15px;color:var(--tx3)"> / ' + k.agentsTotal + '</span>', cls: k.agentsOnline ? 'ok' : 'err', d: k.agentsBusy + ' 个执行中' + (k.agentsDisabled ? ' · ' + k.agentsDisabled + ' 停用' : '') },
    { lb: '⚡ 运行中任务', v: fmtInt(k.tasksRunning), cls: 'pri', d: '并发执行态势' },
    { lb: '✅ 今日完成', v: fmtInt(k.tasksCompletedToday), cls: 'ok', d: '自今日 0 点' },
    { lb: '❌ 今日失败', v: fmtInt(k.tasksFailedToday), cls: k.tasksFailedToday ? 'err' : '', d: k.tasksFailedToday ? '需要关注' : '一切正常' },
    { lb: '🪙 今日 Token', v: fmtTok(k.tokensInputToday + k.tokensOutputToday), cls: '', d: '输入 ' + fmtTok(k.tokensInputToday) + ' · 缓存命中 ' + fmtTok(k.cacheReadToday) },
    { lb: '⏰ 下次定时', v: next ? '<span style="font-size:20px">' + esc(next) + '</span>' : '—', cls: 'warn', d: k.nextScheduleName ? esc(k.nextScheduleName).slice(0, 14) : '无启用中的定时任务' }
  ];
  var html = '';
  for (var i = 0; i < tiles.length; i++) {
    var t = tiles[i];
    html += '<div class="kpi"><div class="lb">' + t.lb + '</div><div class="v ' + t.cls + '">' + t.v + '</div><div class="d">' + t.d + '</div></div>';
  }
  document.getElementById('kpis').innerHTML = html;
}

function renderAgents(agents) {
  var el = document.getElementById('agents');
  var onlineCnt = agents.filter(function(a) { return a.online; }).length;
  document.getElementById('ag-cnt').textContent = onlineCnt + '/' + agents.length + ' 在线';
  if (!agents.length) { el.innerHTML = '<div class="empty">还没有子智能体</div>'; return; }
  var busy = agents.filter(function(a) { return a.busy; });
  var rest = agents.filter(function(a) { return !a.busy; });
  var ordered = busy.concat(rest);
  var html = '';
  for (var i = 0; i < ordered.length; i++) {
    var a = ordered[i];
    var stCls = !a.enabled ? 'dis' : (a.online ? 'on' : 'off');
    var badge = a.busy
      ? '<span class="badge busy">⚡ 执行中 ×' + a.runningCount + '</span>'
      : (!a.enabled
        ? '<span class="badge idle">已停用</span>'
        : (a.online ? '<span class="badge idle">空闲</span>' : '<span class="badge idle" style="color:var(--err)">离线</span>'));
    var resChips = '';
    var resources = a.resources || [];
    for (var j = 0; j < resources.length; j++) {
      var r = resources[j];
      var inUse = r.inUse && r.inUse.length;
      var cls = inUse ? 'hot' : (r.online ? 'on' : 'off');
      var mark = inUse ? ' 🔥' : (r.online ? '' : ' ⚠');
      resChips += '<span class="res-chip ' + cls + '" title="' + esc(r.kind) + ' · ' + esc(r.endpoint || '入口未知') + '">' + esc(r.name) + mark + '</span>';
    }
    var act = a.busy && a.currentActivity
      ? '<div class="act">▸ <b>' + esc(a.currentActivity) + '</b></div>'
      : (a.online ? '' : '<div class="act" style="color:var(--err)">' + esc(a.error || '不可达') + '</div>');
    html += '<div class="agent"><div class="row1"><span class="st ' + stCls + '"></span><span class="nm">' + esc(a.name) + '</span>' +
      '<span class="md">' + esc(a.model || '') + '</span><span class="spacer"></span>' + badge + '</div>' + act +
      (resChips ? '<div class="res">' + resChips + '</div>' : '') +
      '</div>';
  }
  el.innerHTML = html;
}

function hlClass(t) {
  if (t.running) return 'run';
  if (t.status === 'completed' || t.status === 'success') return 'ok';
  if (t.status === 'failed') return 'bad';
  if (t.status === 'cancelled') return 'stop';
  return '';
}

function renderTasks(tasks) {
  var el = document.getElementById('tasks');
  var running = tasks.filter(function(t) { return t.running; });
  var rest = tasks.filter(function(t) { return !t.running; }).slice(0, 10);
  document.getElementById('task-cnt').textContent = running.length + ' 运行中 / ' + tasks.length + ' 总数';
  var ordered = running.concat(rest).slice(0, 16);
  if (!ordered.length) { el.innerHTML = '<div class="empty">暂无任务会话</div>'; return; }
  var html = '';
  for (var i = 0; i < ordered.length; i++) {
    var t = ordered[i];
    var act = t.activity || {};
    var sub = '';
    if (act.subtasks && act.subtasks.total) {
      sub = '子任务 ' + act.subtasks.completed + '/' + act.subtasks.total + ' 完成' + (act.subtasks.currentTitle ? ' · 当前「' + esc(act.subtasks.currentTitle) + '」' : '');
    } else if (act.todoCurrent) {
      sub = '当前步骤：' + esc(act.todoCurrent);
    } else if (act.todosTotal) {
      sub = '清单 ' + act.todosDone + '/' + act.todosTotal;
    }
    var pct = (act.subtasks && act.subtasks.total) ? Math.round(100 * act.subtasks.completed / act.subtasks.total) : null;
    var agentsLine = t.agentNames && t.agentNames.length ? ' · ' + esc(t.agentNames.join('、')) : '';
    html += '<div class="task' + (t.running ? '' : ' done') + '">' +
      '<div class="row1"><span class="ic">' + t.typeIcon + '</span><span class="tt" title="' + esc(t.title) + '">' + esc(t.title) + '</span>' +
      '<span class="spacer"></span>' + (t.elapsedMs != null ? '<span class="el">⏱ ' + fmtElapse(t.elapsedMs) + '</span>' : '') + '</div>' +
      '<div class="hl ' + hlClass(t) + '">' + esc(t.headline) + '</div>' +
      (t.description ? '<div class="sub" title="' + esc(t.description) + '">' + esc(t.description) + agentsLine + '</div>' : '') +
      (sub ? '<div class="sub">' + sub + '</div>' : '') +
      (pct != null ? '<div class="bar"><i style="width:' + pct + '%"></i></div>' : '') +
      '</div>';
  }
  el.innerHTML = html;
}

function renderFeed(events) {
  var el = document.getElementById('feed');
  if (!events || !events.length) { el.innerHTML = '<div class="empty">暂无事件 · 等待任务与定时触发</div>'; return; }
  var html = '';
  for (var i = 0; i < Math.min(events.length, 60); i++) {
    var e = events[i];
    html += '<div class="ev ' + e.level + '"><span class="t">' + fmtClock(e.at) + '</span><span>' + (EV_ICON[e.kind] || '·') + '</span><span class="m">' + esc(e.msg) + '</span></div>';
  }
  el.innerHTML = html;
}

function renderAlerts(alerts) {
  var el = document.getElementById('alerts');
  if (!alerts || !alerts.length) { el.className = 'alerts'; el.innerHTML = ''; return; }
  var html = '';
  for (var i = 0; i < Math.min(alerts.length, 8); i++) {
    var a = alerts[i];
    html += '<span class="alert ' + (a.level === 'warn' ? 'warn' : '') + '">⚠ ' + esc(a.msg) + '</span>';
  }
  el.className = 'alerts on';
  el.innerHTML = html;
}

function renderScheds(list) {
  var el = document.getElementById('scheds');
  if (!list || !list.length) { el.innerHTML = '<span class="empty">暂无定时任务</span>'; return; }
  var html = '';
  for (var i = 0; i < list.length; i++) {
    var s = list[i];
    html += '<span class="sched' + (s.enabled ? '' : ' off') + '">' + (s.enabled ? '🟢' : '⚪') + ' <b>' + esc(s.name) + '</b> · ' + esc(s.ruleText) +
      (s.enabled && s.nextRunAt ? ' · <span class="nx">' + esc(fmtCountdown(s.nextRunAt)) + '</span>' : '') +
      (s.lastRunOk === false ? ' · <span style="color:var(--err)">上次失败</span>' : '') +
      '</span>';
  }
  el.innerHTML = html;
}

// ---------- 趋势图（纯 SVG，无依赖） ----------

function svgLine(svgId, series) {
  var svg = document.getElementById(svgId);
  if (!svg) return;
  var W = 600, H = 150, padL = 2, padB = 14, padT = 6;
  var n = series.length ? series[0].pts.length : 0;
  if (!n || !series.length) {
    svg.innerHTML = '<text x="300" y="75" fill="#5b6b8c" font-size="12" text-anchor="middle">暂无快照数据（每小时自动采集）</text>';
    return;
  }
  var max = 1;
  for (var s = 0; s < series.length; s++) {
    for (var i = 0; i < series[s].pts.length; i++) {
      if (series[s].pts[i] > max) max = series[s].pts[i];
    }
  }
  var stepX = (W - padL * 2) / Math.max(1, n - 1);
  var parts = [];
  for (var s2 = 0; s2 < series.length; s2++) {
    var se = series[s2];
    var d = '';
    for (var i2 = 0; i2 < se.pts.length; i2++) {
      var x = padL + i2 * stepX;
      var y = padT + (H - padT - padB) * (1 - Math.min(1, se.pts[i2] / max));
      d += (i2 ? ' L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    if (se.fill) {
      var area = d + ' L' + (padL + (se.pts.length - 1) * stepX).toFixed(1) + ' ' + (H - padB) + ' L' + padL + ' ' + (H - padB) + ' Z';
      parts.push('<path d="' + area + '" fill="' + se.color + '" opacity="0.12"/>');
    }
    // 单快照时补一个可见圆点（单点画不出线）
    if (n === 1) {
      var py = padT + (H - padT - padB) * (1 - Math.min(1, (se.pts[0] || 0) / max));
      parts.push('<circle cx="' + padL + '" cy="' + py.toFixed(1) + '" r="3" fill="' + se.color + '"/>');
    }
    parts.push('<path d="' + d + '" fill="none" stroke="' + se.color + '" stroke-width="2" stroke-linejoin="round"/>');
  }
  for (var i3 = 0; i3 < n; i3 += Math.max(1, Math.floor(n / 4))) {
    var lbl = histLabels[i3] || '';
    if (lbl) {
      var lx = Math.max(18, Math.min(W - 18, padL + i3 * stepX));
      parts.push('<text x="' + lx.toFixed(1) + '" y="' + (H - 2) + '" fill="#5b6b8c" font-size="9" text-anchor="middle">' + esc(lbl) + '</text>');
    }
  }
  svg.innerHTML = parts.join('');
}

function renderCharts() {
  var snaps = [];
  for (var i = 0; i < histDays.length; i++) {
    var arr = histDays[i].snapshots || [];
    for (var j = 0; j < arr.length; j++) snaps.push(arr[j]);
  }
  snaps.sort(function(a, b) { return a.at - b.at; });
  var cutoff = Date.now() - 24 * 3600 * 1000;
  var recent = snaps.filter(function(s) { return s.at >= cutoff; });
  // 单快照时复制一点成平线，避免图上只有一枚孤点
  if (recent.length === 1) recent = [recent[0], Object.assign({}, recent[0], { at: recent[0].at + 3600000 })];
  histLabels = recent.map(function(s) { return fmtClock(s.at); });
  svgLine('chart-tasks', [
    { color: '#38bdf8', pts: recent.map(function(s) { return s.tasksRunning; }), fill: false },
    { color: '#34d399', pts: recent.map(function(s) { return s.tasksCompletedToday; }), fill: true },
    { color: '#f87171', pts: recent.map(function(s) { return s.tasksFailedToday; }), fill: false }
  ]);
  svgLine('chart-tokens', [
    { color: '#a78bfa', pts: recent.map(function(s) { return s.tokensInputToday; }), fill: true },
    { color: '#fbbf24', pts: recent.map(function(s) { return s.tokensOutputToday; }), fill: false }
  ]);
}

// ---------- 轮询 ----------

async function poll() {
  var r = await fetchJson(API + '/monitor/overview');
  var dot = document.getElementById('live-dot');
  var txt = document.getElementById('live-text');
  if (!r || !r.ok) {
    dot.className = 'dot bad';
    txt.textContent = '连接失败 · 重试中';
    return;
  }
  dot.className = 'dot ok';
  txt.textContent = '实时连接正常';
  overview = r.data;
  renderKpi(overview.kpi);
  renderAgents(overview.agents || []);
  renderTasks(overview.tasks || []);
  renderFeed(overview.events || []);
  renderAlerts(overview.alerts || []);
  renderScheds(overview.schedules || []);
}

async function pollHistory() {
  var r = await fetchJson(API + '/monitor/history?days=2');
  if (r && r.ok) {
    histDays = r.data.days || [];
    renderCharts();
  }
}

function tickClock() {
  var d = new Date();
  document.getElementById('clock').textContent = d.toLocaleDateString('zh-CN') + ' ' + d.toLocaleTimeString('zh-CN', { hour12: false });
}

setInterval(poll, 5000);
setInterval(pollHistory, 60000);
setInterval(tickClock, 1000);
tickClock();
poll();
pollHistory();
</script>
</body>
</html>`
}
