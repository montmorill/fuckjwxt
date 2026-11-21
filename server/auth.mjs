// 服务自身登录会话 + 登录/授权确认页。
// 与教务账号一致：登录名是学号（users.account），密码是 service_password_hash（scrypt）。
import { config } from './config.mjs';
import * as db from './db.mjs';
import { randomToken, hashToken, safeEqual, now } from './crypto.mjs';

export const SID_COOKIE = 'jwo_sid';

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

export function renderLoginPage({ csrf, next, error = '', account = '' }) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · jwxt-oauth</title><style>${pageStyle}</style></head><body>
<div class="card">
  <h1>登录 jwxt-oauth</h1>
  <p class="sub">使用服务账号登录，不是教务系统密码。</p>
  ${error ? `<div class="error">${htmlEscape(error)}</div>` : ''}
  <form method="post" action="/login" autocomplete="on">
    <input type="hidden" name="csrf" value="${htmlEscape(csrf)}">
    <input type="hidden" name="next" value="${htmlEscape(next)}">
    <label for="account">学号</label>
    <input id="account" name="account" type="text" value="${htmlEscape(account)}" autocomplete="username" required>
    <label for="password">服务密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <div class="actions"><button class="primary" type="submit">登录</button></div>
  </form>
  <p class="muted">管理员可通过 <code>PUT /admin/users/{id}</code> 设置服务密码。</p>
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
  <p class="sub"><strong>${htmlEscape(client.name)}</strong> 请求以 <strong>${htmlEscape(user.display_name || user.account)}</strong> 的身份访问：</p>
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
