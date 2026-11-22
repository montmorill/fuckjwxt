// 服务自身登录会话 + 登录/授权确认页。
// 与教务账号一致：登录名是学号（users.account），密码是 service_password_hash（scrypt）。
import { config } from './config.mjs';
import * as db from './db.mjs';
import { randomToken, hashToken, safeEqual, now, verifyPassword, decrypt } from './crypto.mjs';

export const SID_COOKIE = 'qzgw_sid';

export const htmlEscape = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sidFromRequest(req) {
  return parseCookies(req.headers.cookie)[SID_COOKIE] || '';
}

function setSidCookie(res, sid) {
  const parts = [
    `${SID_COOKIE}=${sid}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${config.sessionTtl}`,
  ];
  if (config.cookieSecure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSidCookie(res) {
  const parts = [`${SID_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (config.cookieSecure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

export function getSessionFromRequest(req) {
  const sid = sidFromRequest(req);
  if (!sid) return null;
  const row = db.getSession(hashToken(sid));
  if (!row) return null;
  if (row.expires_at < now()) {
    db.deleteSession(row.id_hash);
    return null;
  }
  return row;
}

export function getSessionUser(req) {
  const session = getSessionFromRequest(req);
  if (!session || !session.user_id) return null;
  const user = db.getUserById(session.user_id);
  if (!user || user.disabled) return null;
  return { session, user };
}

export function createAnonymousSession(res) {
  const sid = randomToken(32);
  const csrf = randomToken(32);
  const idHash = hashToken(sid);
  const expiresAt = now() + config.sessionTtl;
  db.createSession({ idHash, userId: null, csrfToken: csrf, expiresAt });
  setSidCookie(res, sid);
  return { sid, idHash, csrf_token: csrf, expires_at: expiresAt, user_id: null };
}

export function rotateSession(res, oldSid, user) {
  if (oldSid) db.deleteSession(hashToken(oldSid));
  const sid = randomToken(32);
  const csrf = randomToken(32);
  const expiresAt = now() + config.sessionTtl;
  db.createSession({ idHash: hashToken(sid), userId: user.id, csrfToken: csrf, expiresAt });
  setSidCookie(res, sid);
  return { sid, csrf_token: csrf, expires_at: expiresAt, user_id: user.id };
}

export function destroySession(req, res) {
  const sid = sidFromRequest(req);
  if (sid) db.deleteSession(hashToken(sid));
  clearSidCookie(res);
}

export function safeNext(next) {
  const s = String(next || '');
  if (!s.startsWith('/') || s.startsWith('//') || s.includes('\\')) return '/';
  return s;
}

// ---------- 登录失败限流（内存，按 IP + 用户名） ----------
const fails = new Map();
const WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 10;

function failKey(ip, account) { return `${ip}|${String(account || '').toLowerCase()}`; }

export function loginAllowed(ip, account) {
  const key = failKey(ip, account);
  const entry = fails.get(key);
  if (!entry) return true;
  if (entry.reset < Date.now()) { fails.delete(key); return true; }
  return entry.count < MAX_FAILS;
}

export function recordLoginFailure(ip, account) {
  const key = failKey(ip, account);
  const entry = fails.get(key);
  if (!entry || entry.reset < Date.now()) {
    fails.set(key, { count: 1, reset: Date.now() + WINDOW_MS });
    return;
  }
  entry.count++;
}

export function clearLoginFailures(ip, account) {
  fails.delete(failKey(ip, account));
}

setInterval(() => {
  const t = Date.now();
  for (const [k, v] of fails) if (v.reset < t) fails.delete(k);
}, 60_000).unref();

// ---------- 页面 ----------
const pageStyle = `
  *{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;background:#f5f7fb;color:#1f2937;display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{width:100%;max-width:420px;background:#fff;border-radius:14px;box-shadow:0 12px 40px rgba(15,23,42,.12);padding:32px}
  h1{font-size:22px;margin:0 0 6px}p.sub{margin:0 0 24px;color:#6b7280;font-size:14px}
  label{display:block;font-size:13px;color:#374151;margin:14px 0 6px}
  input[type=text],input[type=password]{width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:15px;outline:none}
  input[type=text]:focus,input[type=password]:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.12)}
  .error{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:8px}
  .actions{display:flex;gap:10px;margin-top:24px}
  button{flex:1;padding:11px 14px;border-radius:8px;border:1px solid transparent;font-size:15px;cursor:pointer}
  button.primary{background:#2563eb;color:#fff}button.primary:hover{background:#1d4ed8}
  button.secondary{background:#fff;color:#374151;border-color:#d1d5db}button.secondary:hover{background:#f9fafb}
  .scopes{margin:18px 0;padding:0;list-style:none}.scopes li{padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:14px}
  code{background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:12px}
  .muted{color:#6b7280;font-size:12px;margin-top:18px}
`;

// 登录密码：优先校验服务密码；用户未设置服务密码时回退到教务密码。
export function verifyUserPassword(user, password) {
  const pwd = String(password || '');
  if (verifyPassword(pwd, user.service_password_hash)) return true;
  if (!user.service_password_hash && user.password_enc) {
    try { return safeEqual(decrypt(user.password_enc), pwd); } catch { return false; }
  }
  return false;
}

export function renderLoginPage({ csrf, next, error = '', account = '' }) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · 强智 Gateway</title><style>${pageStyle}</style></head><body>
<div class="card">
  <h1>登录 强智 Gateway</h1>
  <p class="sub">使用学号登录；未设置服务密码时使用教务系统密码。</p>
  ${error ? `<div class="error">${htmlEscape(error)}</div>` : ''}
  <form method="post" action="/login" autocomplete="on">
    <input type="hidden" name="csrf" value="${htmlEscape(csrf)}">
    <input type="hidden" name="next" value="${htmlEscape(next)}">
    <label for="account">学号</label>
    <input id="account" name="account" type="text" value="${htmlEscape(account)}" autocomplete="username" required>
    <label for="password">密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <div class="actions"><button class="primary" type="submit">登录</button></div>
  </form>
  <p class="muted">未设置服务密码时可直接使用教务密码；管理员可通过 <code>PUT /admin/users/{id}</code> 设置服务密码。</p>
</div></body></html>`;
}

const SCOPE_DESC = {
  'jwxt.read': '读取课表、成绩、考试、教材等',
  'jwxt.profile': '读取学籍信息（包含姓名等个人信息）',
  'offline_access': '允许长期访问（签发 refresh token）',
};

export function renderConsentPage({ csrf, user, client, scopes, params }) {
  const hidden = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `<input type="hidden" name="${htmlEscape(k)}" value="${htmlEscape(v)}">`)
    .join('\n    ');
  const scopeItems = scopes.map(s => `<li><code>${htmlEscape(s)}</code> ${htmlEscape(SCOPE_DESC[s] || '')}</li>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>授权 · ${htmlEscape(client.name)}</title><style>${pageStyle}</style></head><body>
<div class="card">
  <h1>授权访问</h1>
  <p class="sub"><strong>${htmlEscape(client.name)}</strong> 请求以 <strong>${htmlEscape(user.account)}</strong> 的身份访问：</p>
  <ul class="scopes">${scopeItems}</ul>
  <form method="post" action="/oauth/authorize">
    <input type="hidden" name="csrf" value="${htmlEscape(csrf)}">
    ${hidden}
    <div class="actions">
      <button class="secondary" type="submit" name="decision" value="deny">拒绝</button>
      <button class="primary" type="submit" name="decision" value="approve">同意</button>
    </div>
  </form>
  <p class="muted">客户端：<code>${htmlEscape(client.client_id)}</code></p>
</div></body></html>`;
}

const accountStyle = `
  .card.wide{max-width:860px}
  h2{font-size:16px;margin:26px 0 8px}
  .row{display:flex;gap:10px;align-items:flex-end;margin:6px 0 4px}
  .row label{flex:0 0 auto;margin:0;white-space:nowrap}
  .row input[type=text]{flex:1}
  .row button{flex:0 0 auto;margin:0}
  .token-box{background:#ecfdf5;border:1px solid #a7f3d0;border-radius:10px;padding:14px;margin:16px 0;font-size:14px}
  .token-box p{margin:6px 0}
  .token-url{display:block;word-break:break-all;line-height:1.6;margin:8px 0;background:#fff}
  .token-field{display:flex;gap:8px;align-items:flex-start;margin:10px 0}
  .token-label{flex:0 0 110px;font-size:12px;color:#6b7280;padding-top:8px}
  .cred-title{font-size:13px;font-weight:600;margin:14px 0 4px;color:#065f46}
  .token-field .token-url{flex:1;margin:0}
  .token-field button.slim{flex:0 0 auto;margin:0;padding:8px 10px;font-size:13px}
  table.how td{font-size:13px;line-height:1.55}
  .table-wrap{overflow-x:auto}
  table.tokens{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px}
  table.tokens th,table.tokens td{padding:8px 6px;border-bottom:1px solid #f1f5f9;text-align:left;vertical-align:top}
  table.tokens th{color:#6b7280;font-weight:500;white-space:nowrap}
  button.link{background:none;border:0;color:#dc2626;padding:0;font-size:13px;cursor:pointer;flex:none}
  .steps{margin:8px 0 0;padding-left:20px;font-size:14px;line-height:1.8}
  .steps li{margin:4px 0}
  .steps ul{margin:6px 0 0;padding-left:18px}
  .steps ul li{margin:3px 0}
  @media(max-width:560px){.row{flex-direction:column;align-items:stretch}.row button{width:100%}.token-field{flex-direction:column}.token-label{padding-top:0}}
`;

export function renderAccountPage({ user, csrf, tokens, newToken = null, error = '' }) {
  const fmt = ts => ts ? new Date(ts * 1000).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', hour12: false,
  }) : '—';
  const rows = tokens.filter(t => !t.revoked_at).map(t => `<tr>
      <td>${htmlEscape(t.label || '未命名')}</td>
      <td>${fmt(t.created_at)}</td>
      <td>${fmt(t.last_used_at)}</td>
      <td><form method="post" action="/account/caldav-tokens/${t.id}/delete" onsubmit="return confirm('撤销这个订阅链接？')"><input type="hidden" name="csrf" value="${htmlEscape(csrf)}"><button class="link" type="submit">撤销</button></form></td>
    </tr>`).join('');
  const tokenBox = newToken ? `<div class="token-box">
    <strong>已生成「${htmlEscape(newToken.label)}」</strong>
    <p>以下内容只显示这一次，请立即保存：</p>
    <div class="cred-title">CalDAV 账户</div>
    <div class="token-field">
      <div class="token-label">服务器</div>
      <code id="new-server" class="token-url">${htmlEscape(config.issuer + '/caldav/')}</code>
      <button class="secondary slim" type="button" onclick="copyText('new-server', this)">复制</button>
    </div>
    <div class="token-field">
      <div class="token-label">用户名</div>
      <code id="new-user" class="token-url">${htmlEscape(user.account)}</code>
      <button class="secondary slim" type="button" onclick="copyText('new-user', this)">复制</button>
    </div>
    <div class="token-field">
      <div class="token-label">密码 / Token</div>
      <code id="new-token" class="token-url">${htmlEscape(newToken.token)}</code>
      <button class="secondary slim" type="button" onclick="copyText('new-token', this)">复制</button>
    </div>
    <div class="cred-title">.ics 订阅链接</div>
    <div class="token-field">
      <div class="token-label">链接</div>
      <code id="new-url" class="token-url">${htmlEscape(newToken.url)}</code>
      <button class="secondary slim" type="button" onclick="copyText('new-url', this)">复制</button>
    </div>
  </div>` : '';
  const tokenTable = rows ? `<div class="table-wrap"><table class="tokens">
    <thead><tr><th>备注</th><th>创建时间</th><th>最近使用</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>` : '<p class="muted">还没有 CalDAV token。</p>';

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>我的账号 · 强智 Gateway</title><style>${pageStyle}${accountStyle}</style></head><body>
<div class="card wide">
  <h1>我的账号</h1>
  <p class="sub">学号 <strong>${htmlEscape(user.account)}</strong></p>
  ${error ? `<div class="error">${htmlEscape(error)}</div>` : ''}
  ${tokenBox}
  <h2>CalDAV token</h2>
  <form method="post" action="/account/caldav-tokens" class="row">
    <input type="hidden" name="csrf" value="${htmlEscape(csrf)}">
    <label for="label">备注</label>
    <input id="label" name="label" type="text" maxlength="64" placeholder="手机 / 电脑 / iPad">
    <button class="primary" type="submit">生成 CalDAV token</button>
  </form>
  ${tokenTable}
  <p class="muted">CalDAV 账户：服务器 <code>${config.issuer}/caldav/</code>，用户名学号，密码 token。链接和 token 只在生成时显示一次，没保存就撤销后重新生成。<a href="/logout">退出登录</a></p>
</div>
<script>
  function copyText(id, btn) {
    const el = document.getElementById(id);
    if (!el) return;
    const text = el.textContent;
    const done = () => {
      const old = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = old; }, 1200);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done).catch(() => {});
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch {}
      ta.remove();
    }
  }
</script>
</body></html>`;
}
