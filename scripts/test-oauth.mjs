// 端到端自测：多用户、服务登录/授权确认、OAuth、CalDAV 隔离。
// 只对测试实例运行：会创建/删除 test-* 客户端与 bob 用户。
// 用法：BASE_URL=http://localhost:8787 ADMIN_TOKEN=... node scripts/test-oauth.mjs
import { randomBytes, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

for (const p of ['.env', '../.env']) {
  if (existsSync(p)) {
    try { process.loadEnvFile(p); } catch { /* ignore */ }
    break;
  }
}

const BASE = (process.env.BASE_URL || 'http://localhost:8787').replace(/\/+$/, '');
const ADMIN = process.env.ADMIN_TOKEN;
if (!ADMIN) {
  console.error('缺少 ADMIN_TOKEN');
  process.exit(1);
}

let fails = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) fails++;
};

const asJson = async r => {
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body, headers: r.headers, text };
};
const get = (p, headers = {}) => fetch(BASE + p, { headers }).then(asJson);
const postJson = (p, body, headers = {}) =>
  fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).then(asJson);
const putJson = (p, body, headers = {}) =>
  fetch(BASE + p, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).then(asJson);
const del = (p, headers = {}) => fetch(BASE + p, { method: 'DELETE', headers }).then(asJson);
const postForm = (p, obj) =>
  fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(obj),
  }).then(asJson);

const admin = { Authorization: `Bearer ${ADMIN}` };
const csrfOf = html => html.match(/name="csrf" value="([^"]+)"/)?.[1] || '';

function makeJar() { return new Map(); }
function absorb(r, jar) {
  for (const c of (r.headers.getSetCookie?.() || [])) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
}
function cookieOf(jar) { return [...jar].map(([k, v]) => `${k}=${v}`).join('; '); }

async function web(path, opts = {}, jar = makeJar()) {
  const r = await fetch(BASE + path, {
    redirect: 'manual',
    ...opts,
    headers: { Cookie: cookieOf(jar), ...(opts.headers || {}) },
  });
  absorb(r, jar);
  return r;
}

async function serviceLogin(jar, username, password) {
  const page = await web('/login', {}, jar);
  const html = await page.text();
  const csrf = csrfOf(html);
  const res = await web('/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password, csrf, next: '/' }).toString(),
  }, jar);
  return { page: page.status, csrf, status: res.status, location: res.headers.get('location') };
}

async function approve(jar, params) {
  const consent = await web('/oauth/authorize?' + params, {}, jar);
  const html = await consent.text();
  const csrf = csrfOf(html);
  const body = new URLSearchParams(params);
  body.set('csrf', csrf);
  body.set('decision', 'approve');
  const res = await web('/oauth/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  }, jar);
  return {
    status: consent.status,
    consent: html.includes('授权访问'),
    csrf: Boolean(csrf),
    approveStatus: res.status,
    location: res.headers.get('location') || '',
  };
}

async function propfind(path, username, password, depth = 0) {
  const r = await fetch(BASE + path, {
    method: 'PROPFIND',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'),
      Depth: String(depth),
      'Content-Type': 'application/xml',
    },
    body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>',
  });
  return { status: r.status, text: await r.text() };
}

const createdClients = [];
let bobId = null;
let bobTokenId = null;
let primaryTokenId = null;

try {
  // ---------- 用户与登录 ----------
  const users = await get('/admin/users', admin);
  ok('admin users', users.status === 200 && Array.isArray(users.body));

  let primary = users.body.find(u => u.username === 'caldav') || users.body[0];
  if (!primary) {
    const account = process.env.JWXT_ACCOUNT;
    const password = process.env.JWXT_PASSWORD;
    if (!account || !password) {
      console.error('缺少 JWXT_ACCOUNT / JWXT_PASSWORD（用于创建第一个测试用户）');
      process.exit(1);
    }
    const created = await postJson('/admin/users', {
      username: 'caldav',
      displayName: 'caldav',
      account,
      password,
      servicePassword: 'test-pass',
    }, admin);
    ok('create primary user', created.status === 200 && Boolean(created.body.id), created.body.username);
    primary = created.body;
  } else {
    const setPass = await putJson(`/admin/users/${primary.id}`, { servicePassword: 'test-pass', disabled: false }, admin);
    ok('set service password', setPass.status === 200 && setPass.body.hasServicePassword === true);
  }
  ok('primary has username', Boolean(primary.username), primary.username);

  const primaryJar = makeJar();
  const login = await serviceLogin(primaryJar, primary.username, 'test-pass');
  ok('service login', login.page === 200 && login.status === 302 && primaryJar.has('jwo_sid'));

  const badLoginJar = makeJar();
  const badLogin = await serviceLogin(badLoginJar, primary.username, 'wrong-pass');
  ok('wrong service password rejected', badLogin.status === 401);

  // ---------- clients ----------
  const conf = await postJson('/admin/clients', {
    name: 'test-conf',
    redirectUris: ['http://localhost:9999/cb'],
    scopes: ['jwxt.read', 'jwxt.profile', 'offline_access'],
    userId: primary.id,
  }, admin);
  ok('create confidential client', conf.status === 200 && conf.body.client_id && conf.body.client_secret, conf.body.username);
  if (conf.body.client_id) createdClients.push(conf.body.client_id);

  const pub = await postJson('/admin/clients', {
    name: 'test-public',
    public: true,
    redirectUris: ['http://localhost:9999/cb'],
    scopes: ['jwxt.read', 'offline_access'],
    userId: primary.id,
  }, admin);
  ok('create public client', pub.status === 200 && !pub.body.client_secret);
  if (pub.body.client_id) createdClients.push(pub.body.client_id);

  // ---------- authorization code + PKCE + consent ----------
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const qs = new URLSearchParams({
    response_type: 'code',
    client_id: pub.body.client_id,
    redirect_uri: 'http://localhost:9999/cb',
    scope: 'jwxt.read offline_access',
    state: 'xyz',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  const consent = await approve(primaryJar, qs);
  ok('authorize requires consent page', consent.status === 200 && consent.consent);
  ok('approve redirects with code+state', consent.approveStatus === 302 && consent.location.includes('code='));
  const code = new URL(consent.location).searchParams.get('code');

  const tok = await postForm('/oauth/token', {
    grant_type: 'authorization_code',
    client_id: pub.body.client_id,
    code,
    redirect_uri: 'http://localhost:9999/cb',
    code_verifier: verifier,
  });
  ok('code exchange returns tokens', tok.status === 200 && tok.body.access_token && tok.body.refresh_token, tok.body.scope);
  const AT = tok.body.access_token;
  const RT = tok.body.refresh_token;

  const tt = await get('/api/timetable?semester=2026-2027-1', { Authorization: `Bearer ${AT}` });
  ok('timetable API', tt.status === 200 && Array.isArray(tt.body.data) && tt.body.data.length > 0,
    `count=${tt.body.data?.length}`);
  const me = await get('/api/me', { Authorization: `Bearer ${AT}` });
  ok('me API', me.status === 200 && me.body.data?.sub === String(primary.id));
  const prof = await get('/api/profile', { Authorization: `Bearer ${AT}` });
  ok('profile requires jwxt.profile (403)', prof.status === 403, prof.body.error);

  const codeReuse = await postForm('/oauth/token', {
    grant_type: 'authorization_code',
    client_id: pub.body.client_id,
    code,
    redirect_uri: 'http://localhost:9999/cb',
    code_verifier: verifier,
  });
  ok('authorization code single-use', codeReuse.status === 400 && codeReuse.body.error === 'invalid_grant');

  // ---------- client credentials（绑定 primary） ----------
  const cc = await postForm('/oauth/token', {
    grant_type: 'client_credentials',
    client_id: conf.body.client_id,
    client_secret: conf.body.client_secret,
    scope: 'jwxt.read jwxt.profile',
  });
  ok('client_credentials token', cc.status === 200 && cc.body.access_token && !cc.body.refresh_token, cc.body.scope);
  const prof2 = await get('/api/profile', { Authorization: `Bearer ${cc.body.access_token}` });
  ok('client_credentials can read profile', prof2.status === 200 && Boolean(prof2.body.data?.studentId));

  const badSecret = await postForm('/oauth/token', {
    grant_type: 'client_credentials',
    client_id: conf.body.client_id,
    client_secret: 'wrong',
  });
  ok('wrong client secret rejected', badSecret.status === 401 && badSecret.body.error === 'invalid_client');

  // ---------- refresh rotation + replay ----------
  const rf = await postForm('/oauth/token', {
    grant_type: 'refresh_token',
    client_id: pub.body.client_id,
    refresh_token: RT,
  });
  ok('refresh returns new tokens', rf.status === 200 && rf.body.access_token && rf.body.refresh_token);
  const RT2 = rf.body.refresh_token;
  const replay = await postForm('/oauth/token', {
    grant_type: 'refresh_token',
    client_id: pub.body.client_id,
    refresh_token: RT,
  });
  ok('old refresh token replay rejected', replay.status === 400 && replay.body.error === 'invalid_grant');
  const afterReplay = await postForm('/oauth/token', {
    grant_type: 'refresh_token',
    client_id: pub.body.client_id,
    refresh_token: RT2,
  });
  ok('family revoked after replay', afterReplay.status === 400 && afterReplay.body.error === 'invalid_grant');

  // ---------- revoke + invalid ----------
  const rev = await postForm('/oauth/revoke', { token: AT, client_id: pub.body.client_id });
  ok('revoke returns 200', rev.status === 200);
  const afterRevoke = await get('/api/me', { Authorization: `Bearer ${AT}` });
  ok('revoked access token rejected', afterRevoke.status === 401 && afterRevoke.body.error === 'invalid_token');
  ok('invalid token rejected', (await get('/api/me', { Authorization: 'Bearer nope' })).status === 401);

  // ---------- metadata / openapi ----------
  const meta = await get('/.well-known/oauth-authorization-server');
  ok('metadata', meta.status === 200 && meta.body.issuer === BASE && meta.body.code_challenge_methods_supported.includes('S256'));

  const spec = await get('/openapi.json');
  ok('openapi document', spec.status === 200
    && String(spec.body.openapi || '').startsWith('3.')
    && Boolean(spec.body.paths?.['/api/timetable'])
    && Boolean(spec.body.paths?.['/admin/users'])
    && Boolean(spec.body.components?.securitySchemes?.oauth2AuthCode));

  // ---------- 多用户 ----------
  const bob = await postJson('/admin/users', {
    username: 'bob',
    displayName: 'Bob',
    account: '202600000099',
    password: 'fake',
    servicePassword: 'bob-pass',
    verify: false,
  }, admin);
  ok('create second user', bob.status === 200 && Boolean(bob.body.id), bob.body.username);
  bobId = bob.body.id;

  const bobJar = makeJar();
  const bobLogin = await serviceLogin(bobJar, 'bob', 'bob-pass');
  ok('bob service login', bobLogin.status === 302);

  const bobVerifier = randomBytes(32).toString('base64url');
  const bobChallenge = createHash('sha256').update(bobVerifier).digest('base64url');
  const bobQs = new URLSearchParams({
    response_type: 'code',
    client_id: pub.body.client_id,
    redirect_uri: 'http://localhost:9999/cb',
    scope: 'jwxt.read',
    state: 'bob',
    code_challenge: bobChallenge,
    code_challenge_method: 'S256',
  });
  const bobConsent = await approve(bobJar, bobQs);
  const bobCode = new URL(bobConsent.location).searchParams.get('code');
  const bobTok = await postForm('/oauth/token', {
    grant_type: 'authorization_code',
    client_id: pub.body.client_id,
    code: bobCode,
    redirect_uri: 'http://localhost:9999/cb',
    code_verifier: bobVerifier,
  });
  ok('bob authorization code token', bobTok.status === 200 && Boolean(bobTok.body.access_token));
  const bobMe = await get('/api/me', { Authorization: `Bearer ${bobTok.body.access_token}` });
  ok('bob token is bound to bob', bobMe.status === 200 && bobMe.body.data?.sub === String(bobId), bobMe.body.data?.sub);

  // ---------- CalDAV 多用户隔离 ----------
  const bobCd = await postJson(`/admin/users/${bobId}/caldav-tokens`, { label: 'test' }, admin);
  ok('issue bob caldav token', bobCd.status === 200 && Boolean(bobCd.body.token));
  bobTokenId = bobCd.body.id;

  const primaryCd = await postJson(`/admin/users/${primary.id}/caldav-tokens`, { label: 'test-primary' }, admin);
  ok('issue primary caldav token', primaryCd.status === 200 && Boolean(primaryCd.body.token));
  primaryTokenId = primaryCd.body.id;

  const bobRoot = await propfind('/caldav/', 'bob', bobCd.body.token);
  ok('bob caldav discovery', bobRoot.status === 207 && bobRoot.text.includes('/caldav/principals/bob/'));

  const bobHome = await propfind('/caldav/calendars/bob/', 'bob', bobCd.body.token, 0);
  ok('bob home discovery', bobHome.status === 207 && bobHome.text.includes('/caldav/calendars/bob/'));

  const cross1 = await propfind('/caldav/calendars/caldav/', 'bob', bobCd.body.token);
  ok('bob cannot access primary calendar', cross1.status === 404);

  const cross2 = await propfind('/caldav/calendars/bob/', primary.username, primaryCd.body.token);
  ok('primary cannot access bob calendar', cross2.status === 404);

  const badCd = await propfind('/caldav/', 'bob', 'wrong-token');
  ok('wrong caldav token rejected', badCd.status === 401);
} finally {
  for (const id of createdClients) {
    await del(`/admin/clients/${encodeURIComponent(id)}`, admin).catch(() => {});
  }
  if (bobTokenId && bobId) {
    await del(`/admin/users/${bobId}/caldav-tokens/${bobTokenId}`, admin).catch(() => {});
  }
  if (primaryTokenId) {
    // primary id isn't stored if the initial lookup failed; best-effort
    const users = await get('/admin/users', admin).catch(() => null);
    const p = users?.body?.[0];
    if (p) await del(`/admin/users/${p.id}/caldav-tokens/${primaryTokenId}`, admin).catch(() => {});
  }
  if (bobId) await del(`/admin/users/${bobId}`, admin).catch(() => {});
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exitCode = fails ? 1 : 0;
