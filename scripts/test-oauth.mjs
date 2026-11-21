// 端到端自测：授权码 + PKCE、client_credentials、refresh 轮换、revoke、加密/哈希检查前置条件。
// 只对测试实例运行：会创建并删除 test-* 客户端。
// 用法：BASE_URL=http://localhost:8787 ADMIN_TOKEN=... node scripts/test-oauth.mjs
import { randomBytes, createHash } from 'node:crypto';

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
  return { status: r.status, body, headers: r.headers };
};
const get = (p, headers = {}) => fetch(BASE + p, { headers }).then(asJson);
const postJson = (p, body, headers = {}) =>
  fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).then(asJson);
const postForm = (p, obj) =>
  fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(obj),
  }).then(asJson);

const admin = { Authorization: `Bearer ${ADMIN}` };
const created = [];

try {
  const acc = await get('/admin/account', admin);
  ok('admin account seeded', acc.status === 200 && Boolean(acc.body.account));
  ok('admin requires token', (await get('/admin/account')).status === 401);

  const conf = await postJson('/admin/clients', {
    name: 'test-conf',
    redirectUris: ['http://localhost:9999/cb'],
    scopes: ['jwxt.read', 'jwxt.profile', 'offline_access'],
  }, admin);
  ok('create confidential client', conf.status === 200 && conf.body.client_id && conf.body.client_secret);
  if (conf.body.client_id) created.push(conf.body.client_id);

  const pub = await postJson('/admin/clients', {
    name: 'test-public',
    public: true,
    redirectUris: ['http://localhost:9999/cb'],
    scopes: ['jwxt.read', 'offline_access'],
  }, admin);
  ok('create public client', pub.status === 200 && !pub.body.client_secret);
  if (pub.body.client_id) created.push(pub.body.client_id);

  // authorization code + PKCE
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
  const authRes = await fetch(`${BASE}/oauth/authorize?${qs}`, { redirect: 'manual' });
  const loc = authRes.headers.get('location') || '';
  const code = new URL(loc).searchParams.get('code');
  ok('authorize redirects with code+state',
    authRes.status === 302 && Boolean(code) && new URL(loc).searchParams.get('state') === 'xyz');

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
  ok('me API', me.status === 200 && Boolean(me.body.data?.sub));
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

  // client credentials
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

  // refresh rotation + replay
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

  // revoke + invalid
  const rev = await postForm('/oauth/revoke', { token: AT, client_id: pub.body.client_id });
  ok('revoke returns 200', rev.status === 200);
  const afterRevoke = await get('/api/me', { Authorization: `Bearer ${AT}` });
  ok('revoked access token rejected', afterRevoke.status === 401 && afterRevoke.body.error === 'invalid_token');
  ok('invalid token rejected', (await get('/api/me', { Authorization: 'Bearer nope' })).status === 401);

  const meta = await get('/.well-known/oauth-authorization-server');
  ok('metadata', meta.status === 200 && meta.body.issuer === BASE && meta.body.code_challenge_methods_supported.includes('S256'));

  const spec = await get('/openapi.json');
  ok('openapi document', spec.status === 200
    && String(spec.body.openapi || '').startsWith('3.')
    && Boolean(spec.body.paths?.['/api/timetable'])
    && Boolean(spec.body.components?.securitySchemes?.oauth2AuthCode));
} finally {
  for (const id of created) {
    await fetch(`${BASE}/admin/clients/${encodeURIComponent(id)}`, { method: 'DELETE', headers: admin }).catch(() => {});
  }
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
