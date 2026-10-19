/**
 * onenat-workbuddy-web - 邀请接受页（公开）
 * 用户经邮件/管理员复制的链接进入：回显邀请信息 → 设置密码激活账号 → 自动登录进控制台。
 * 移动端适配：≤480px 单列；不依赖新语法（兼容微信 X5 旧内核）。
 */

export function renderInviteUi(prefix: string, token: string, version?: string): string {
  const safePrefix = prefix || ''
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>接受邀请 · OneNat WorkBuddy</title>
<style>
:root {
  --bg: #f7f8fa; --bg2: #ffffff; --line: #e8eaed; --tx: #1f2329; --tx2: #5f6673; --tx3: #8f959e;
  --pri: #4d6bfe; --err: #e5484d; --ok: #2f9e63;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body { background: var(--bg); color: var(--tx); font-family: var(--font); display: flex; align-items: center; justify-content: center; padding: 20px; }
.card { width: 380px; max-width: 94vw; background: var(--bg2); border: 1px solid var(--line); border-radius: 16px; padding: 34px 30px 28px; box-shadow: 0 20px 60px rgba(31,35,41,.12); }
.brand { display: flex; align-items: center; gap: 10px; justify-content: center; margin-bottom: 6px; }
.brand .logo { width: 40px; height: 40px; border-radius: 10px; background: linear-gradient(135deg, #4d6bfe, #7a8cff); display: flex; align-items: center; justify-content: center; font-size: 20px; }
.brand b { font-size: 18px; }
.sub { text-align: center; color: var(--tx3); font-size: 12.5px; margin-bottom: 22px; }
.meta { background: #f6f7ff; border: 1px solid #dfe4ff; border-radius: 10px; padding: 12px 14px; font-size: 13px; margin-bottom: 18px; line-height: 1.8; }
.meta b { color: var(--pri); }
.field { margin-bottom: 14px; }
.field label { display: block; font-size: 12px; color: var(--tx2); margin-bottom: 6px; }
.field input { width: 100%; font-size: 14px; background: #fbfbfc; border: 1px solid var(--line); color: var(--tx); border-radius: 8px; padding: 11px 12px; outline: none; }
.field input:focus { border-color: var(--pri); }
.btn { width: 100%; margin-top: 6px; background: linear-gradient(135deg, #4d6bfe, #6b85ff); color: #fff; border: none; border-radius: 8px; padding: 12px; font-size: 14px; font-weight: 600; cursor: pointer; }
.btn:disabled { opacity: .55; cursor: not-allowed; }
.msg { display: none; margin-bottom: 14px; padding: 9px 12px; font-size: 12.5px; border-radius: 8px; }
.msg.err { display: block; color: #d33a41; background: rgba(229,72,77,.08); border: 1px solid rgba(229,72,77,.4); }
.msg.ok { display: block; color: var(--ok); background: rgba(47,158,99,.08); border: 1px solid rgba(47,158,99,.4); }
.hint { margin-top: 16px; text-align: center; color: var(--tx3); font-size: 11.5px; line-height: 1.7; }
@media (max-width: 480px) { .card { padding: 26px 20px 22px; } }
</style>
</head>
<body>
<div class="card">
<div class="brand"><div class="logo">⚡</div><b>OneNat WorkBuddy</b></div>
<div class="sub">账号邀请 · 设置密码后即可登录</div>
<div class="msg" id="msg"></div>
<div id="content" style="display:none">
<div class="meta" id="meta"></div>
<form id="form">
<div class="field"><label>昵称（可选）</label><input id="displayName" placeholder="显示名称"></div>
<div class="field"><label>设置密码（至少 8 位，含字母与数字）</label><input id="password" type="password" autocomplete="new-password" placeholder="密码"></div>
<div class="field"><label>确认密码</label><input id="password2" type="password" autocomplete="new-password" placeholder="再输一次"></div>
<button class="btn" id="btn" type="submit">激活账号并登录</button>
</form>
<div class="hint">链接 72 小时内有效 · 非本人操作请忽略本页${version ? '<br>版本 v' + version : ''}</div>
</div>
</div>
<script>
(function () {
  var PREFIX = ${JSON.stringify(safePrefix)};
  var TOKEN = ${JSON.stringify(token)};
  var msg = document.getElementById('msg');
  var content = document.getElementById('content');
  function showMsg(text, cls) { msg.textContent = text; msg.className = 'msg ' + cls; }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  fetch(PREFIX + '/api/invitations/' + encodeURIComponent(TOKEN))
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j || !j.ok || !j.data || !j.data.valid) {
        showMsg((j && j.data && j.data.reason) || '邀请链接无效或已过期', 'err');
        return;
      }
      document.getElementById('meta').innerHTML =
        '邀请邮箱：<b>' + esc(j.data.email) + '</b><br>' +
        (j.data.displayName ? '昵称：' + esc(j.data.displayName) + '<br>' : '') +
        '有效期至：' + new Date(j.data.expiresAt).toLocaleString();
      content.style.display = '';
    })
    .catch(function () { showMsg('网络异常，请刷新重试', 'err'); });
  document.getElementById('form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var pw = document.getElementById('password').value;
    var pw2 = document.getElementById('password2').value;
    if (pw !== pw2) { showMsg('两次输入的密码不一致', 'err'); return; }
    if (pw.length < 8 || !/[a-zA-Z]/.test(pw) || !/\d/.test(pw)) { showMsg('密码需至少 8 位，且同时包含字母与数字', 'err'); return; }
    var btn = document.getElementById('btn');
    btn.disabled = true; btn.textContent = '激活中…';
    fetch(PREFIX + '/api/invitations/' + encodeURIComponent(TOKEN), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw, displayName: document.getElementById('displayName').value.trim() })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok) { showMsg('✓ 账号已激活，正在进入控制台…', 'ok'); setTimeout(function () { location.replace(PREFIX + '/'); }, 800); return; }
      showMsg((j && j.error) || '激活失败', 'err');
      btn.disabled = false; btn.textContent = '激活账号并登录';
    }).catch(function () { showMsg('网络异常，请重试', 'err'); btn.disabled = false; btn.textContent = '激活账号并登录'; });
  });
})();
</script>
</body>
</html>`
}

/**
 * 密码重置页（公开，U-07）：忘记密码邮件链接进入，设置新密码。
 */
export function renderResetUi(prefix: string, token: string, version?: string): string {
  const safePrefix = prefix || ''
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>重置密码 · OneNat WorkBuddy</title>
<style>
:root {
  --bg: #f7f8fa; --bg2: #ffffff; --line: #e8eaed; --tx: #1f2329; --tx2: #5f6673; --tx3: #8f959e;
  --pri: #4d6bfe; --err: #e5484d; --ok: #2f9e63;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body { background: var(--bg); color: var(--tx); font-family: var(--font); display: flex; align-items: center; justify-content: center; padding: 20px; }
.card { width: 380px; max-width: 94vw; background: var(--bg2); border: 1px solid var(--line); border-radius: 16px; padding: 34px 30px 28px; box-shadow: 0 20px 60px rgba(31,35,41,.12); }
.brand { display: flex; align-items: center; gap: 10px; justify-content: center; margin-bottom: 6px; }
.brand .logo { width: 40px; height: 40px; border-radius: 10px; background: linear-gradient(135deg, #4d6bfe, #7a8cff); display: flex; align-items: center; justify-content: center; font-size: 20px; }
.brand b { font-size: 18px; }
.sub { text-align: center; color: var(--tx3); font-size: 12.5px; margin-bottom: 22px; }
.field { margin-bottom: 14px; }
.field label { display: block; font-size: 12px; color: var(--tx2); margin-bottom: 6px; }
.field input { width: 100%; font-size: 14px; background: #fbfbfc; border: 1px solid var(--line); color: var(--tx); border-radius: 8px; padding: 11px 12px; outline: none; }
.field input:focus { border-color: var(--pri); }
.btn { width: 100%; margin-top: 6px; background: linear-gradient(135deg, #4d6bfe, #6b85ff); color: #fff; border: none; border-radius: 8px; padding: 12px; font-size: 14px; font-weight: 600; cursor: pointer; }
.btn:disabled { opacity: .55; cursor: not-allowed; }
.msg { display: none; margin-bottom: 14px; padding: 9px 12px; font-size: 12.5px; border-radius: 8px; }
.msg.err { display: block; color: #d33a41; background: rgba(229,72,77,.08); border: 1px solid rgba(229,72,77,.4); }
.msg.ok { display: block; color: var(--ok); background: rgba(47,158,99,.08); border: 1px solid rgba(47,158,99,.4); }
.hint { margin-top: 16px; text-align: center; color: var(--tx3); font-size: 11.5px; line-height: 1.7; }
.hint a { color: var(--pri); text-decoration: none; }
@media (max-width: 480px) { .card { padding: 26px 20px 22px; } }
</style>
</head>
<body>
<div class="card">
<div class="brand"><div class="logo">⚡</div><b>OneNat WorkBuddy</b></div>
<div class="sub">重置密码 · 设置新密码后即可登录</div>
<div class="msg" id="msg"></div>
<div id="content">
<form id="form">
<div class="field"><label>新密码（至少 8 位，含字母与数字）</label><input id="password" type="password" autocomplete="new-password" placeholder="新密码"></div>
<div class="field"><label>确认新密码</label><input id="password2" type="password" autocomplete="new-password" placeholder="再输一次"></div>
<button class="btn" id="btn" type="submit">重置密码</button>
</form>
</div>
<div class="hint">链接 24 小时内有效 · 非本人操作请忽略本页<br><a href="${safePrefix}/">返回登录</a>${version ? ' · 版本 v' + version : ''}</div>
</div>
<script>
(function () {
  var PREFIX = ${JSON.stringify(safePrefix)};
  var TOKEN = ${JSON.stringify(token)};
  var msg = document.getElementById('msg');
  function showMsg(text, cls) { msg.textContent = text; msg.className = 'msg ' + cls; }
  if (!TOKEN) showMsg('链接缺少令牌，请从邮件重新进入', 'err');
  document.getElementById('form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var pw = document.getElementById('password').value;
    var pw2 = document.getElementById('password2').value;
    if (pw !== pw2) { showMsg('两次输入的密码不一致', 'err'); return; }
    if (pw.length < 8 || !/[a-zA-Z]/.test(pw) || !/\\d/.test(pw)) { showMsg('密码需至少 8 位，且同时包含字母与数字', 'err'); return; }
    var btn = document.getElementById('btn');
    btn.disabled = true; btn.textContent = '提交中…';
    fetch(PREFIX + '/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, newPassword: pw })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok) { showMsg('✓ 密码已重置，正在前往登录…', 'ok'); setTimeout(function () { location.replace(PREFIX + '/'); }, 1200); return; }
      showMsg((j && j.error) || '重置失败', 'err');
      btn.disabled = false; btn.textContent = '重置密码';
    }).catch(function () { showMsg('网络异常，请重试', 'err'); btn.disabled = false; btn.textContent = '重置密码'; });
  });
})();
</script>
</body>
</html>`
}

/**
 * 项目邀请接受页（公开，P-05）：回显项目/邀请人 → 未注册/invited 一设置密码并入项；
 * 已注册 active 用户需本人登录态接受；可拒绝。
 */
export function renderProjectInviteUi(prefix: string, token: string, version?: string): string {
  const safePrefix = prefix || ''
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>项目邀请 · OneNat WorkBuddy</title>
<style>
:root {
  --bg: #f7f8fa; --bg2: #ffffff; --line: #e8eaed; --tx: #1f2329; --tx2: #5f6673; --tx3: #8f959e;
  --pri: #4d6bfe; --err: #e5484d; --ok: #2f9e63;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; }
body { background: var(--bg); color: var(--tx); font-family: var(--font); display: flex; align-items: center; justify-content: center; padding: 20px; }
.card { width: 380px; max-width: 94vw; background: var(--bg2); border: 1px solid var(--line); border-radius: 16px; padding: 34px 30px 28px; box-shadow: 0 20px 60px rgba(31,35,41,.12); }
.brand { display: flex; align-items: center; gap: 10px; justify-content: center; margin-bottom: 6px; }
.brand .logo { width: 40px; height: 40px; border-radius: 10px; background: linear-gradient(135deg, #4d6bfe, #7a8cff); display: flex; align-items: center; justify-content: center; font-size: 20px; }
.brand b { font-size: 18px; }
.sub { text-align: center; color: var(--tx3); font-size: 12.5px; margin-bottom: 22px; }
.meta { background: #f6f7ff; border: 1px solid #dfe4ff; border-radius: 10px; padding: 12px 14px; font-size: 13px; margin-bottom: 18px; line-height: 1.8; }
.meta b { color: var(--pri); }
.field { margin-bottom: 14px; }
.field label { display: block; font-size: 12px; color: var(--tx2); margin-bottom: 6px; }
.field input { width: 100%; font-size: 14px; background: #fbfbfc; border: 1px solid var(--line); color: var(--tx); border-radius: 8px; padding: 11px 12px; outline: none; }
.field input:focus { border-color: var(--pri); }
.btn { width: 100%; margin-top: 6px; background: linear-gradient(135deg, #4d6bfe, #6b85ff); color: #fff; border: none; border-radius: 8px; padding: 12px; font-size: 14px; font-weight: 600; cursor: pointer; }
.btn:disabled { opacity: .55; cursor: not-allowed; }
.btn2 { width: 100%; margin-top: 10px; background: var(--bg2); color: var(--tx2); border: 1px solid var(--line); border-radius: 8px; padding: 11px; font-size: 13px; cursor: pointer; }
.msg { display: none; margin-bottom: 14px; padding: 9px 12px; font-size: 12.5px; border-radius: 8px; }
.msg.err { display: block; color: #d33a41; background: rgba(229,72,77,.08); border: 1px solid rgba(229,72,77,.4); }
.msg.ok { display: block; color: var(--ok); background: rgba(47,158,99,.08); border: 1px solid rgba(47,158,99,.4); }
.hint { margin-top: 16px; text-align: center; color: var(--tx3); font-size: 11.5px; line-height: 1.7; }
.hint a { color: var(--pri); text-decoration: none; }
@media (max-width: 480px) { .card { padding: 26px 20px 22px; } }
</style>
</head>
<body>
<div class="card">
<div class="brand"><div class="logo">⚡</div><b>OneNat WorkBuddy</b></div>
<div class="sub">项目邀请 · 接受后即可访问该项目</div>
<div class="msg" id="msg"></div>
<div id="content" style="display:none">
<div class="meta" id="meta"></div>
<div id="form-box"></div>
</div>
<div class="hint">链接 7 天内有效 · 非本人操作请忽略本页${version ? '<br>版本 v' + version : ''}</div>
</div>
<script>
(function () {
  var PREFIX = ${JSON.stringify(safePrefix)};
  var TOKEN = ${JSON.stringify(token)};
  var msg = document.getElementById('msg');
  var content = document.getElementById('content');
  var formBox = document.getElementById('form-box');
  var meta = document.getElementById('meta');
  function showMsg(text, cls) { msg.textContent = text; msg.className = 'msg ' + cls; }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  function decline() {
    if (!confirm('确定拒绝该邀请？拒绝后链接将失效。')) return;
    fetch(PREFIX + '/api/project-invitations/' + encodeURIComponent(TOKEN) + '/decline', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (j) { showMsg(j && j.ok ? '已拒绝该邀请' : ((j && j.error) || '操作失败'), j && j.ok ? 'ok' : 'err'); content.style.display = 'none'; })
      .catch(function () { showMsg('网络异常，请重试', 'err'); });
  }
  function accept(payload, btn, doneText) {
    btn.disabled = true; btn.textContent = '提交中…';
    fetch(PREFIX + '/api/project-invitations/' + encodeURIComponent(TOKEN), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok) { showMsg(doneText, 'ok'); setTimeout(function () { location.replace(PREFIX + '/'); }, 1000); return; }
      showMsg((j && j.error) || '接受失败', 'err');
      btn.disabled = false; btn.textContent = payload && payload.password ? '设置密码并加入项目' : '接受邀请';
    }).catch(function () { showMsg('网络异常，请重试', 'err'); btn.disabled = false; btn.textContent = payload && payload.password ? '设置密码并加入项目' : '接受邀请'; });
  }
  fetch(PREFIX + '/api/project-invitations/' + encodeURIComponent(TOKEN))
    .then(function (r) { return r.json(); })
    .then(function (j) {
      var d = j && j.data;
      if (!j || !j.ok || !d || !d.valid) { showMsg((d && d.reason) || '邀请链接无效或已过期', 'err'); return; }
      document.getElementById('meta').innerHTML =
        '项目：<b>' + esc(d.projectName || '（名称不可见）') + '</b><br>' +
        '邀请邮箱：<b>' + esc(d.email) + '</b>' + (d.inviterName ? '<br>邀请人：' + esc(d.inviterName) : '') +
        '<br>角色：' + (d.role === 'owner' ? 'owner（可管理项目）' : 'member') +
        '<br>有效期至：' + new Date(d.expiresAt).toLocaleString();
      if (d.projectArchived) { showMsg('该项目已归档（只读），请联系邀请人恢复后再接受', 'err'); return; }
      content.style.display = '';
      // 已登录：本人 → 直接接受；非本人 → 提示换号
      fetch(PREFIX + '/api/auth/me').then(function (r) { return r.json(); }).then(function (me) {
        var myName = me && me.ok && me.data && me.data.username;
        if (myName && myName.toLowerCase() === String(d.email).toLowerCase()) {
          formBox.innerHTML = '<button class="btn" id="accept-btn" type="button">接受邀请并进入项目</button><button class="btn2" id="decline-btn" type="button">拒绝邀请</button>';
          document.getElementById('accept-btn').addEventListener('click', function () { accept({}, this, '✓ 已加入项目，正在进入控制台…'); });
          document.getElementById('decline-btn').addEventListener('click', decline);
          return;
        }
        if (myName) {
          showMsg('当前登录账号（' + esc(myName) + '）与被邀请邮箱不一致：请退出后用 ' + esc(d.email) + ' 登录再打开本页', 'err');
          formBox.innerHTML = '<a class="btn" style="display:block;text-align:center;text-decoration:none" href="' + PREFIX + '/">前往登录</a><button class="btn2" id="decline-btn" type="button">拒绝邀请</button>';
          document.getElementById('decline-btn').addEventListener('click', decline);
          return;
        }
        if (d.account === 'active') {
          formBox.innerHTML = '<div style="font-size:12.5px;color:var(--tx2);line-height:1.8;margin-bottom:6px">该邮箱已有账号：请登录后回到本页接受邀请。</div>' +
            '<a class="btn" style="display:block;text-align:center;text-decoration:none" href="' + PREFIX + '/">前往登录</a><button class="btn2" id="decline-btn" type="button">拒绝邀请</button>';
          document.getElementById('decline-btn').addEventListener('click', decline);
          return;
        }
        if (d.account === 'disabled') { showMsg('该邮箱账号已被禁用，无法接受邀请', 'err'); return; }
        // none / invited：一步设置密码（注册/激活）并入项
        formBox.innerHTML =
          '<form id="form">' +
          (d.account === 'none' ? '<div class="field"><label>昵称（可选）</label><input id="displayName" placeholder="显示名称"></div>' : '') +
          '<div class="field"><label>设置密码（至少 8 位，含字母与数字）</label><input id="password" type="password" autocomplete="new-password" placeholder="密码"></div>' +
          '<div class="field"><label>确认密码</label><input id="password2" type="password" autocomplete="new-password" placeholder="再输一次"></div>' +
          '<button class="btn" id="submit-btn" type="submit">' + (d.account === 'invited' ? '激活账号并加入项目' : '创建账号并加入项目') + '</button>' +
          '</form>';
        document.getElementById('form').addEventListener('submit', function (ev) {
          ev.preventDefault();
          var pw = document.getElementById('password').value;
          var pw2 = document.getElementById('password2').value;
          if (pw !== pw2) { showMsg('两次输入的密码不一致', 'err'); return; }
          if (pw.length < 8 || !/[a-zA-Z]/.test(pw) || !/\\d/.test(pw)) { showMsg('密码需至少 8 位，且同时包含字母与数字', 'err'); return; }
          accept({ password: pw, displayName: (document.getElementById('displayName') || {}).value || '' }, document.getElementById('submit-btn'), '✓ 已加入项目，正在进入控制台…');
        });
      }).catch(function () { showMsg('网络异常，请刷新重试', 'err'); });
    })
    .catch(function () { showMsg('网络异常，请刷新重试', 'err'); });
})();
</script>
</body>
</html>`
}
