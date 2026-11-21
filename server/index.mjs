import http from 'node:http';
import { config, SCOPES } from './config.mjs';
import { buildOpenApi, routeKeys as specRouteKeys } from './openapi.mjs';
import {
  db, getUserById, getUserByUsername, getUserByAccount,
  createUser, updateUser, deleteUser, listUsers,
  createClient, listClients, deleteClient,
  createCalDavToken, listCalDavTokens, revokeCalDavToken, deleteUserSessions, cleanup,
} from './db.mjs';
import { encrypt, hashToken, hashPassword, verifyPassword, randomToken, safeEqual } from './crypto.mjs';
import * as oauth from './oauth.mjs';
import { handlers as apiHandlers, ApiError } from './api.mjs';
import { verifyCredentials, clearSession, clearAllSessions } from './jwxt-service.mjs';
import { handleCalDav, clearCache as clearCalDavCache } from './caldav.mjs';
import {
  getSessionFromRequest, getSessionUser, createAnonymousSession, rotateSession, destroySession,
  sidFromRequest, safeNext, renderLoginPage, renderConsentPage,
  loginAllowed, recordLoginFailure, clearLoginFailures,
} from './auth.mjs';

class HttpError extends Error {
  constructor(status, error, description = '', headers = {}) {
    super(description || error);
    this.status = status;
    this.error = error;
    this.headers = headers;
  }
}

const routes = [];
const add = (method, path, handler, opts = {}) =>
  routes.push({ method, parts: path.split('/').filter(Boolean), handler, skipOpenApi: Boolean(opts.skipOpenApi) });

function match(method, pathname) {
  const parts = pathname.split('/').filter(Boolean);
  for (const r of routes) {
    if (r.method !== method || r.parts.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < r.parts.length; i++) {
      const p = r.parts[i];
      if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(parts[i]);
      else if (p !== parts[i]) { ok = false; break; }
    }
    if (ok) return { route: r, params };
  }
  return null;
}

// ---------- HTTP helpers ----------
function baseHeaders() {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };
}

function sendJson(res, status, body, extra = {}) {
  const headers = { ...baseHeaders(), 'Content-Type': 'application/json; charset=utf-8', ...extra };
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function sendText(res, status, body, extra = {}) {
  const headers = { ...baseHeaders(), 'Content-Type': 'text/plain; charset=utf-8', ...extra };
  res.writeHead(status, headers);
  res.end(body);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { ...baseHeaders(), 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

const safeUser = u => ({
  id: u.id,
  username: u.username,
  displayName: u.display_name,
  account: u.account,
  baseUrl: u.base_url,
  disabled: Boolean(u.disabled),
  hasServicePassword: Boolean(u.service_password_hash),
  caldavTokenCount: u.caldav_token_count,
  caldavSemester: u.caldav_semester || null,
  createdAt: u.created_at,
  updatedAt: u.updated_at,
});

function redirect(res, location) {
  res.writeHead(302, { ...baseHeaders(), Location: location });
  res.end();
}

const reply = (body, status = 200, headers = {}) => ({ __reply: true, body, status, headers });

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'payload_too_large', 'request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function parseForm(req) {
  return Object.fromEntries(new URLSearchParams(await readBody(req)));
}

async function parseJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'invalid_json', 'invalid JSON body'); }
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  if (config.corsOrigins.includes('*') || config.corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', config.corsOrigins.includes('*') ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

// ---------- rate limit (in-memory) ----------
const hits = new Map();
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of hits) if (v.reset < t) hits.delete(k);
}, 60_000).unref();

function rateLimit(req, limit = config.adminRateLimit) {
  const ip = req.socket.remoteAddress || 'unknown';
  const t = Date.now();
  let e = hits.get(ip);
  if (!e || e.reset < t) { e = { count: 0, reset: t + 60_000 }; hits.set(ip, e); }
  e.count++;
  if (e.count > limit) throw new HttpError(429, 'rate_limited', 'too many requests');
}

function requireAdmin(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : String(req.headers['x-admin-token'] || '');
  if (!token || !safeEqual(token, config.adminToken)) throw new HttpError(401, 'unauthorized', 'admin token required');
}

const validateScopes = scopes => {
  if (!Array.isArray(scopes) || scopes.length === 0) return ['jwxt.read'];
  const out = [...new Set(scopes.map(s => String(s)))];
  const bad = out.filter(s => !SCOPES.includes(s));
  if (bad.length) throw new HttpError(400, 'invalid_scope', `unknown scopes: ${bad.join(', ')}`);
  return out;
};

// ---------- routes: meta ----------
const openapi = buildOpenApi(config.issuer);

add('GET', '/', async () => ({
  name: 'jwxt-oauth',
  issuer: config.issuer,
  metadata: `${config.issuer}/.well-known/oauth-authorization-server`,
  openapi: `${config.issuer}/openapi.json`,
  api: ['/api/me', '/api/profile', '/api/semesters', '/api/timetable', '/api/grades', '/api/exams', '/api/textbooks'],
}));

add('GET', '/openapi.json', async ({ res }) => {
  res.writeHead(200, { ...baseHeaders(), 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(openapi));
});

add('GET', '/healthz', async () => ({ status: 'ok', time: new Date().toISOString() }));

add('GET', '/.well-known/oauth-authorization-server', async () => oauth.metadata());

// ---------- routes: 服务登录 ----------
add('GET', '/login', async ({ req, res, query }) => {
  const next = safeNext(query.get('next') || '/');
  if (getSessionUser(req)) return redirect(res, next);
  let session = getSessionFromRequest(req);
  if (!session) session = createAnonymousSession(res);
  sendHtml(res, 200, renderLoginPage({ csrf: session.csrf_token, next }));
}, { skipOpenApi: true });

add('POST', '/login', async ({ req, res }) => {
  const form = await parseForm(req);
  const next = safeNext(form.next || '/');
  const session = getSessionFromRequest(req);
  if (!session || !form.csrf || !safeEqual(form.csrf, session.csrf_token)) {
    return sendHtml(res, 400, renderLoginPage({ csrf: session?.csrf_token || '', next, error: '会话已过期，请重试' }));
  }

  const ip = req.socket.remoteAddress || 'unknown';
  const username = String(form.username || '').trim();
  if (!loginAllowed(ip, username)) {
    return sendHtml(res, 429, renderLoginPage({ csrf: session.csrf_token, next, username, error: '尝试过于频繁，请稍后再试' }));
  }

  const user = getUserByUsername(username);
  if (!user || user.disabled || !verifyPassword(String(form.password || ''), user.service_password_hash)) {
    recordLoginFailure(ip, username);
    return sendHtml(res, 401, renderLoginPage({ csrf: session.csrf_token, next, username, error: '用户名或密码错误' }));
  }

  clearLoginFailures(ip, username);
  rotateSession(res, sidFromRequest(req), user);
  redirect(res, next);
}, { skipOpenApi: true });

const logoutHandler = async ({ req, res }) => {
  destroySession(req, res);
  redirect(res, '/login');
};
add('GET', '/logout', logoutHandler, { skipOpenApi: true });
add('POST', '/logout', logoutHandler, { skipOpenApi: true });

// ---------- routes: oauth ----------
add('GET', '/oauth/authorize', async ({ req, res, query }) => {
  const details = oauth.validateAuthorize(query);
  const current = getSessionUser(req);
  if (!current) {
    return redirect(res, `/login?next=${encodeURIComponent(safeNext(req.url))}`);
  }

  sendHtml(res, 200, renderConsentPage({
    csrf: current.session.csrf_token,
    user: current.user,
    client: details.client,
    scopes: details.scopes,
    params: {
      response_type: query.get('response_type') || 'code',
      client_id: query.get('client_id') || '',
      redirect_uri: query.get('redirect_uri') || '',
      scope: query.get('scope') || '',
      state: query.get('state') || '',
      code_challenge: query.get('code_challenge') || '',
      code_challenge_method: query.get('code_challenge_method') || '',
    },
  }));
});

add('POST', '/oauth/authorize', async ({ req, res }) => {
  const form = await parseForm(req);
  const current = getSessionUser(req);
  if (!current) return redirect(res, '/login?next=' + encodeURIComponent('/oauth/authorize'));
  if (!form.csrf || !safeEqual(form.csrf, current.session.csrf_token)) {
    throw new HttpError(400, 'invalid_request', 'csrf token mismatch');
  }

  const params = new URLSearchParams();
  for (const k of ['response_type', 'client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method']) {
    if (form[k] !== undefined && form[k] !== '') params.set(k, form[k]);
  }
  const details = oauth.validateAuthorize(params);

  if (form.decision !== 'approve') {
    const url = new URL(details.redirectUri);
    url.searchParams.set('error', 'access_denied');
    if (details.state) url.searchParams.set('state', details.state);
    return redirect(res, url.toString());
  }

  redirect(res, oauth.authorize({ query: params, user: current.user }));
}, { skipOpenApi: true });

add('POST', '/oauth/token', async ({ req }) => {
  rateLimit(req);
  const input = await parseForm(req);
  const tokens = oauth.token({ req, input });
  return reply(tokens, 200, { Pragma: 'no-cache' });
});

add('POST', '/oauth/revoke', async ({ req }) => {
  rateLimit(req);
  const input = await parseForm(req);
  const out = oauth.revoke({ req, input });
  return reply(out);
});

add('GET', '/oauth/userinfo', async ({ req }) => {
  const auth = oauth.authenticateBearer(req);
  return {
    sub: String(auth.user.id),
    account: auth.user.account,
    client_id: auth.client.client_id,
    scopes: auth.scopes,
  };
});

// ---------- routes: api ----------
const apiRoutes = {
  '/api/me': 'me',
  '/api/profile': 'profile',
  '/api/semesters': 'semesters',
  '/api/week-range': 'weekRange',
  '/api/timetable': 'timetable',
  '/api/grades': 'grades',
  '/api/exams': 'exams',
  '/api/textbooks': 'textbooks',
  '/api/courses/plan': 'planCourses',
  '/api/messages': 'messages',
  '/api/notices': 'notices',
};

for (const [path, name] of Object.entries(apiRoutes)) {
  add('GET', path, async ({ req, query }) => {
    const auth = oauth.authenticateBearer(req);
    const data = await apiHandlers[name]({ auth, query });
    return { data };
  });
}

// ---------- routes: admin users ----------
const USERNAME_RE = /^[A-Za-z0-9._-]{2,64}$/;
const validateUsername = value => {
  const username = String(value || '').trim();
  if (!USERNAME_RE.test(username)) {
    throw new HttpError(400, 'invalid_request', 'username must be 2-64 chars of A-Z a-z 0-9 . _ -');
  }
  return username;
};

const SEMESTER_RE = /^\d{4}-\d{4}-[12]$/;
const validateSemester = value => {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const semester = String(value).trim();
  if (!SEMESTER_RE.test(semester)) {
    throw new HttpError(400, 'invalid_request', 'caldavSemester must look like 2026-2027-1');
  }
  return semester;
};

add('GET', '/admin/users', async ({ req }) => {
  requireAdmin(req);
  return listUsers().map(safeUser);
});

add('POST', '/admin/users', async ({ req }) => {
  requireAdmin(req);
  rateLimit(req);
  const body = await parseJson(req);
  const username = validateUsername(body.username);
  const account = String(body.account || '').trim();
  const password = String(body.password || '');
  const displayName = body.displayName ? String(body.displayName).trim() : username;
  const baseUrl = body.baseUrl ? String(body.baseUrl).trim() : null;
  const servicePassword = body.servicePassword === undefined ? null : String(body.servicePassword);
  const caldavSemester = validateSemester(body.caldavSemester) ?? null;

  if (!account) throw new HttpError(400, 'invalid_request', 'account required');
  if (!password) throw new HttpError(400, 'invalid_request', 'password required');
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new HttpError(400, 'invalid_request', 'baseUrl must be http(s)');
  if (servicePassword !== null && servicePassword.length < 8) {
    throw new HttpError(400, 'invalid_request', 'servicePassword must be at least 8 chars');
  }
  if (getUserByUsername(username)) throw new HttpError(409, 'conflict', 'username already exists');
  if (getUserByAccount(account)) throw new HttpError(409, 'conflict', 'account already exists');

  if (body.verify !== false) {
    try {
      await verifyCredentials({ account, password, baseUrl });
    } catch {
      throw new HttpError(400, 'invalid_credentials', '账号或密码校验失败');
    }
  }

  const user = createUser({
    username,
    displayName,
    account,
    passwordEnc: encrypt(password),
    baseUrl,
    servicePasswordHash: servicePassword ? hashPassword(servicePassword) : null,
    caldavSemester,
  });
  return safeUser(user);
});

add('PUT', '/admin/users/:userId', async ({ req, params }) => {
  requireAdmin(req);
  rateLimit(req);
  const id = Number(params.userId);
  const user = getUserById(id);
  if (!user) throw new HttpError(404, 'not_found', 'user not found');

  const body = await parseJson(req);
  let username = user.username;
  if (body.username !== undefined) {
    username = validateUsername(body.username);
    const other = getUserByUsername(username);
    if (other && other.id !== id) throw new HttpError(409, 'conflict', 'username already exists');
  }

  let account = user.account;
  const accountChanged = body.account !== undefined && String(body.account).trim() !== user.account;
  if (body.account !== undefined) {
    account = String(body.account).trim();
    if (!account) throw new HttpError(400, 'invalid_request', 'account required');
    const other = getUserByAccount(account);
    if (other && other.id !== id) throw new HttpError(409, 'conflict', 'account already exists');
  }
  if (accountChanged && body.password === undefined && body.verify !== false) {
    throw new HttpError(400, 'invalid_request', 'changing account requires password or verify:false');
  }

  let passwordEnc = user.password_enc;
  let passwordPlain = null;
  if (body.password !== undefined) {
    passwordPlain = String(body.password);
    if (!passwordPlain) throw new HttpError(400, 'invalid_request', 'password required');
    passwordEnc = encrypt(passwordPlain);
  }

  const baseUrl = body.baseUrl !== undefined
    ? (body.baseUrl ? String(body.baseUrl).trim() : null)
    : user.base_url;
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new HttpError(400, 'invalid_request', 'baseUrl must be http(s)');

  let servicePasswordHash = user.service_password_hash;
  let revokeSessions = false;
  if (body.servicePassword !== undefined) {
    if (body.servicePassword === null || body.servicePassword === '') {
      servicePasswordHash = null;
    } else {
      const sp = String(body.servicePassword);
      if (sp.length < 8) throw new HttpError(400, 'invalid_request', 'servicePassword must be at least 8 chars');
      servicePasswordHash = hashPassword(sp);
    }
    revokeSessions = true;
  }

  const disabled = body.disabled !== undefined ? Boolean(body.disabled) : Boolean(user.disabled);
  const caldavSemester = validateSemester(body.caldavSemester);

  if (body.verify !== false && passwordPlain !== null) {
    try {
      await verifyCredentials({ account, password: passwordPlain, baseUrl });
    } catch {
      throw new HttpError(400, 'invalid_credentials', '账号或密码校验失败');
    }
  }

  const updated = updateUser(id, {
    username,
    displayName: body.displayName !== undefined ? String(body.displayName).trim() : user.display_name,
    account,
    passwordEnc,
    baseUrl,
    servicePasswordHash,
    caldavSemester,
    disabled,
  });

  clearSession(id);
  clearCalDavCache(id);
  if (revokeSessions || disabled) deleteUserSessions(id);

  return safeUser(updated);
});

add('DELETE', '/admin/users/:userId', async ({ req, params }) => {
  requireAdmin(req);
  const id = Number(params.userId);
  if (!getUserById(id)) throw new HttpError(404, 'not_found', 'user not found');
  const changed = deleteUser(id);
  clearSession(id);
  clearCalDavCache(id);
  return { ok: Boolean(changed) };
});

add('POST', '/admin/users/:userId/caldav-tokens', async ({ req, params }) => {
  requireAdmin(req);
  rateLimit(req);
  const id = Number(params.userId);
  if (!getUserById(id)) throw new HttpError(404, 'not_found', 'user not found');
  const body = await parseJson(req);
  const label = body.label ? String(body.label).slice(0, 80) : null;
  const token = randomToken(32);
  const row = createCalDavToken({ userId: id, label, tokenHash: hashToken(token) });
  return { id: row.id, label: row.label, token }; // 只返回这一次
});

add('GET', '/admin/users/:userId/caldav-tokens', async ({ req, params }) => {
  requireAdmin(req);
  const id = Number(params.userId);
  if (!getUserById(id)) throw new HttpError(404, 'not_found', 'user not found');
  return listCalDavTokens(id).map(t => ({
    id: t.id,
    label: t.label,
    createdAt: t.created_at,
    revokedAt: t.revoked_at,
    lastUsedAt: t.last_used_at,
  }));
});

add('DELETE', '/admin/users/:userId/caldav-tokens/:tokenId', async ({ req, params }) => {
  requireAdmin(req);
  const changed = revokeCalDavToken(Number(params.tokenId), Number(params.userId));
  if (!changed) throw new HttpError(404, 'not_found', 'token not found');
  return { ok: true };
});

add('POST', '/admin/clients', async ({ req }) => {
  requireAdmin(req);
  rateLimit(req);
  const body = await parseJson(req);
  const name = String(body.name || '').trim();
  if (!name) throw new HttpError(400, 'invalid_request', 'name required');

  const redirectUris = Array.isArray(body.redirectUris) ? body.redirectUris.map(String) : [];
  if (!redirectUris.length) throw new HttpError(400, 'invalid_request', 'redirectUris required');
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
  for (const u of redirectUris) {
    let parsed;
    try { parsed = new URL(u); } catch { throw new HttpError(400, 'invalid_request', `invalid redirect URI: ${u}`); }
    const local = localHosts.has(parsed.hostname);
    if (parsed.hash || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local))) {
      throw new HttpError(400, 'invalid_request', `redirect URI must be https (http only for localhost): ${u}`);
    }
  }

  const scopes = validateScopes(body.scopes);
  const isPublic = Boolean(body.public);
  const clientId = 'qz_' + randomToken(12);
  const secret = isPublic ? null : randomToken(32);

  let userId;
  if (body.userId !== undefined) {
    userId = Number(body.userId);
  } else if (body.username) {
    const owner = getUserByUsername(String(body.username));
    if (!owner) throw new HttpError(400, 'invalid_request', 'user not found');
    userId = owner.id;
  } else {
    throw new HttpError(400, 'invalid_request', 'userId or username required');
  }
  const owner = userId ? getUserById(userId) : null;
  if (!owner) throw new HttpError(400, 'invalid_request', 'user not found');

  createClient({
    clientId,
    name,
    secretHash: secret ? hashToken(secret) : null,
    redirectUris,
    scopes,
    isPublic,
    userId,
  });

  return {
    client_id: clientId,
    client_secret: secret, // 只返回这一次
    name,
    redirect_uris: redirectUris,
    scopes,
    public: isPublic,
    user_id: userId,
    username: owner.username,
  };
});

add('GET', '/admin/clients', async ({ req }) => {
  requireAdmin(req);
  return listClients().map(c => ({
    client_id: c.client_id,
    name: c.name,
    redirect_uris: JSON.parse(c.redirect_uris),
    scopes: c.scopes.split(' ').filter(Boolean),
    public: Boolean(c.public),
    user_id: c.user_id,
    username: c.username,
    created_at: c.created_at,
  }));
});

add('DELETE', '/admin/clients/:clientId', async ({ req, params }) => {
  requireAdmin(req);
  const changed = deleteClient(params.clientId);
  if (!changed) throw new HttpError(404, 'not_found', 'client not found');
  return { ok: true };
});

// ---------- OpenAPI 覆盖校验 ----------
// 实际注册的路由必须都能在 openapi.mjs 的 routeMeta 里找到，防止文档漏接口。
const toSpecPath = parts => '/' + parts.join('/').replace(/:([A-Za-z0-9_]+)/g, '{$1}');
const actualRouteKeys = new Set(
  routes.filter(r => !r.skipOpenApi).map(r => `${r.method} ${toSpecPath(r.parts)}`),
);
const specKeys = new Set(specRouteKeys);
const missingInSpec = [...actualRouteKeys].filter(k => !specKeys.has(k));
if (missingInSpec.length) {
  throw new Error(`OpenAPI 缺少路由: ${missingInSpec.join(', ')}`);
}
const notRegistered = [...specKeys].filter(k => !actualRouteKeys.has(k));
if (notRegistered.length) {
  console.warn(`[openapi] 以下路径只写在文档里、没有注册: ${notRegistered.join(', ')}`);
}

// ---------- server ----------
function errorResponse(res, err) {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  const body = {
    error: err.error || (status === 500 ? 'server_error' : 'error'),
    error_description: err.message || '',
  };
  const headers = { ...(err.headers || {}) };
  if (status === 502) body.error_description = '教务系统请求失败，请稍后重试';
  sendJson(res, status, body, headers);
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  applyCors(req, res);

  try {
    // CalDAV 固定入口
    if (url.pathname === '/.well-known/caldav') {
      if (req.method === 'GET' || req.method === 'HEAD') {
        res.writeHead(301, { ...baseHeaders(), Location: new URL('/caldav/', url).href });
        return res.end();
      }
      // iOS 会用 PROPFIND 探测 well-known，按根集合处理
      const davUrl = new URL(url.href);
      davUrl.pathname = '/caldav/';
      await handleCalDav(req, res, davUrl);
      return;
    }
    if (url.pathname === '/caldav' || url.pathname.startsWith('/caldav/')
        || (req.method === 'PROPFIND' && url.pathname === '/')) {
      await handleCalDav(req, res, url);
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, baseHeaders());
      return res.end();
    }

    const m = match(req.method, url.pathname);
    if (!m) throw new HttpError(404, 'not_found', 'not found');
    const result = await m.route.handler({
      req, res, url, query: url.searchParams, params: m.params,
    });
    if (result?.__reply) sendJson(res, result.status, result.body, result.headers);
    else if (result !== undefined && !res.headersSent) sendJson(res, 200, result);
  } catch (e) {
    if (!res.headersSent) {
      if (e instanceof oauth.OAuthError || e instanceof HttpError || e instanceof ApiError) {
        errorResponse(res, e);
      } else {
        console.error('[unhandled]', e);
        errorResponse(res, { status: 502, error: 'upstream_error', message: '' });
      }
    }
  } finally {
    const ms = Date.now() - started;
    if (!url.pathname.startsWith('/healthz')) {
      console.log(`${req.method} ${url.pathname} ${res.statusCode || '-'} ${ms}ms`);
    }
  }
});

setInterval(cleanup, 10 * 60_000).unref();

server.listen(config.port, () => {
  console.log(`jwxt-oauth listening on ${config.issuer}`);
  console.log(`db: ${config.dbPath}`);
  console.log(`scopes: ${SCOPES.join(', ')}`);
  console.log(`login: ${config.issuer}/login`);
  console.log(`caldav: ${config.issuer}/caldav/ (multi-user, Basic tokens in DB)`);
});

function shutdown() {
  console.log('\nshutting down…');
  clearAllSessions();
  server.close(() => {
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export { server };
