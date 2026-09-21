/**
 * onenat-workbuddy-web - 登录页（独立部署模式）
 * 风格与控制台一致；未登录访问控制台时由 server 返回本页。
 * 注意: 嵌入式 JS 不使用外层模板串冲突字符。
 */

export function renderLoginUi(prefix: string, errmsg?: string, version?: string): string {
  const safePrefix = prefix || ''
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="theme-color" content="#090e17">
<title>登录 · OneNat WorkBuddy</title>
<style>
:root {
  --bg: #090e17; --bg2: #0f172a; --bg3: #182238; --line: #202e48; --line2: #2e4166;
  --tx: #f1f5f9; --tx2: #94a3b8; --tx3: #64748b;
  --pri: #38bdf8; --pri-d: #0284c7; --pri-light: rgba(56, 189, 248, 0.12);
  --err: #f87171; --err-light: rgba(248, 113, 113, 0.12);
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body { background: var(--bg); color: var(--tx); font-family: var(--font); display: flex; align-items: center; justify-content: center; -webkit-font-smoothing: antialiased; padding: 20px; }
body::before { content: ''; position: fixed; inset: 0; background: radial-gradient(600px 300px at 50% 0%, rgba(56,189,248,.08), transparent); pointer-events: none; }
.card {
  width: 380px; max-width: 94vw; background: var(--bg2); border: 1px solid var(--line);
  border-radius: 16px; padding: 34px 30px 28px; box-shadow: 0 20px 60px rgba(0,0,0,.5); position: relative; z-index: 1;
}
.brand { display: flex; align-items: center; gap: 10px; justify-content: center; margin-bottom: 6px; }
.brand .logo { width: 40px; height: 40px; border-radius: 10px; background: linear-gradient(135deg, #0284c7, #818cf8); display: flex; align-items: center; justify-content: center; font-size: 20px; box-shadow: 0 0 16px rgba(56,189,248,.35); }
.brand b { font-size: 18px; }
.sub { text-align: center; color: var(--tx3); font-size: 12.5px; margin-bottom: 24px; }
.field { margin-bottom: 14px; }
.field label { display: block; font-size: 12px; color: var(--tx2); margin-bottom: 6px; }
.field input {
  width: 100%; font-size: 14px; background: var(--bg); border: 1px solid var(--line); color: var(--tx);
  border-radius: 8px; padding: 11px 12px; outline: none; transition: border-color .15s ease;
}
.field input:focus { border-color: var(--pri); }
.btn-login {
  width: 100%; margin-top: 6px; background: linear-gradient(135deg, #0284c7, #2563eb); color: #fff;
  border: none; border-radius: 8px; padding: 12px; font-size: 14px; font-weight: 600; cursor: pointer;
  box-shadow: 0 4px 14px rgba(2, 132, 199, 0.35); transition: filter .15s ease;
}
.btn-login:hover { filter: brightness(1.12); }
.btn-login:disabled { opacity: .55; cursor: not-allowed; }
.err {
  display: none; margin-bottom: 14px; padding: 9px 12px; font-size: 12.5px; color: #fecaca;
  background: var(--err-light); border: 1px solid rgba(248,113,113,.4); border-radius: 8px;
}
.err.on { display: block; }
.hint { margin-top: 18px; text-align: center; color: var(--tx3); font-size: 11.5px; line-height: 1.7; }
@media (max-width: 480px) { .card { padding: 26px 20px 22px; } }
</style>
</head>
<body>
<div class="card">
  <div class="brand"><div class="logo">⚡</div><b>OneNat WorkBuddy</b></div>
  <div class="sub">多智能体协作工作台 · 请登录后使用</div>
  <div class="err" id="err"></div>
  <form id="form">
    <div class="field"><label>用户名</label><input id="username" autocomplete="username" autofocus placeholder="用户名"></div>
    <div class="field"><label>密码</label><input id="password" type="password" autocomplete="current-password" placeholder="密码"></div>
    <button class="btn-login" id="btn" type="submit">登 录</button>
  </form>
  <div class="hint">登录状态保留 7 天 · 会话 Cookie 仅存放于浏览器${version ? `<br>版本 v${version}` : ''}</div>
</div>
<script>
(function () {
  var PREFIX = ${JSON.stringify(safePrefix)};
  var errEl = document.getElementById('err');
  var btn = document.getElementById('btn');
  function showErr(msg) { errEl.textContent = msg; errEl.className = 'err on'; }
  document.getElementById('form').addEventListener('submit', async function (ev) {
    ev.preventDefault();
    var username = document.getElementById('username').value.trim();
    var password = document.getElementById('password').value;
    if (!username || !password) { showErr('请输入用户名与密码'); return; }
    btn.disabled = true; btn.textContent = '登录中…';
    try {
      var res = await fetch(PREFIX + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
      });
      var json = null; try { json = await res.json(); } catch (e) {}
      if (res.status === 429) { showErr('尝试次数过多，请 5 分钟后再试'); }
      else if (json && json.ok) { location.replace(PREFIX + '/'); return; }
      else { showErr((json && json.error) || '用户名或密码错误'); }
    } catch (e) { showErr('网络异常，请重试'); }
    btn.disabled = false; btn.textContent = '登 录';
  });
})();
</script>
</body>
</html>`
}
