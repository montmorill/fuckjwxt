import http from 'node:http';
import { config, SCOPES } from './config.mjs';
import { db, getPrimaryUser, upsertPrimaryUser, createClient, listClients, deleteClient, cleanup } from './db.mjs';
import { encrypt, hashToken, randomToken, safeEqual } from './crypto.mjs';
import * as oauth from './oauth.mjs';
import { handlers as apiHandlers, ApiError } from './api.mjs';
import { verifyCredentials, clearSession, clearAllSessions } from './jwxt-service.mjs';

class HttpError extends Error {
  constructor(status, error, description = '', headers = {}) {
    super(description || error);
    this.status = status;
    this.error = error;
    this.headers = headers;
  }
}

const routes = [];
const add = (method, path, handler) => routes.push({ method, parts: path.split('/').filter(Boolean), handler });

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
add('GET', '/', async () => ({
  name: 'jwxt-oauth',
  issuer: config.issuer,
  metadata: `${config.issuer}/.well-known/oauth-authorization-server`,
  api: ['/api/me', '/api/profile', '/api/semesters', '/api/timetable', '/api/grades', '/api/exams', '/api/textbooks'],
}));

add('GET', '/healthz', async () => ({ status: 'ok', time: new Date().toISOString() }));

add('GET', '/.well-known/oauth-authorization-server', async () => oauth.metadata());

// ---------- routes: oauth ----------
add('GET', '/oauth/authorize', async ({ req, res, query }) => {
  const user = getPrimaryUser();
  const url = oauth.authorize({ query, user });
  redirect(res, url);
});

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

// ---------- routes: admin ----------
add('PUT', '/admin/account', async ({ req }) => {
  requireAdmin(req);
  rateLimit(req);
  const body = await parseJson(req);
  const account = String(body.account || '').trim();
  const password = String(body.password || '');
  const baseUrl = body.baseUrl ? String(body.baseUrl).trim() : null;
  if (!account) throw new HttpError(400, 'invalid_request', 'account required');
  if (!password) throw new HttpError(400, 'invalid_request', 'password required');
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new HttpError(400, 'invalid_request', 'baseUrl must be http(s)');

  if (body.verify !== false) {
    try {
      await verifyCredentials({ account, password, baseUrl });
    } catch {
      throw new HttpError(400, 'invalid_credentials', '账号或密码校验失败');
    }
  }

  const user = upsertPrimaryUser({
    account,
    passwordEnc: encrypt(password),
    baseUrl,
  });
  clearSession(user.id);
  return { ok: true, account: user.account, verified: body.verify !== false };
});

add('GET', '/admin/account', async ({ req }) => {
  requireAdmin(req);
  const user = getPrimaryUser();
  if (!user) return { account: null };
  return { account: user.account, baseUrl: user.base_url, updatedAt: user.updated_at };
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

  createClient({
    clientId,
    name,
    secretHash: secret ? hashToken(secret) : null,
    redirectUris,
    scopes,
    isPublic,
  });

  return {
    client_id: clientId,
    client_secret: secret, // 只返回这一次
    name,
    redirect_uris: redirectUris,
    scopes,
    public: isPublic,
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
    created_at: c.created_at,
  }));
});

add('DELETE', '/admin/clients/:clientId', async ({ req, params }) => {
  requireAdmin(req);
  const changed = deleteClient(params.clientId);
  if (!changed) throw new HttpError(404, 'not_found', 'client not found');
  return { ok: true };
});

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

  if (req.method === 'OPTIONS') {
    res.writeHead(204, baseHeaders());
    return res.end();
  }

  try {
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

// 首次启动：如果有 .env 里的教务账号且库里还没有，就加密入库（不打印密码）
if (!getPrimaryUser() && process.env.JWXT_ACCOUNT && process.env.JWXT_PASSWORD) {
  upsertPrimaryUser({
    account: process.env.JWXT_ACCOUNT,
    passwordEnc: encrypt(process.env.JWXT_PASSWORD),
    baseUrl: process.env.JWXT_BASE_URL || null,
  });
  console.log('[init] 已从环境变量导入教务账号（加密存储）');
}

setInterval(cleanup, 10 * 60_000).unref();

server.listen(config.port, () => {
  console.log(`jwxt-oauth listening on ${config.issuer}`);
  console.log(`db: ${config.dbPath}`);
  console.log(`scopes: ${SCOPES.join(', ')}`);
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
