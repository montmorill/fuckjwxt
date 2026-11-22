// 客户端端到端测试。
// 用法：BASE_URL=http://localhost:8787 ADMIN_TOKEN=... node tests/client.mjs
import { existsSync } from 'node:fs';
import { QzgwClient, QzgwError } from '../client/index.mjs';

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

const admin = { Authorization: `Bearer ${ADMIN}` };
const get = async p => (await fetch(BASE + p, { headers: admin })).json();
const post = async (p, body) => (await fetch(BASE + p, {
  method: 'POST',
  headers: { ...admin, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})).json();
const del = p => fetch(BASE + p, { method: 'DELETE', headers: admin });

let clientId = null;
try {
  // 用户：直接用第一个测试用户，没有就用 .env 里的真实账号创建一个
  const users = await get('/admin/users');
  let primary = Array.isArray(users) ? users[0] : null;
  if (!primary) {
    const account = process.env.JWXT_ACCOUNT;
    const password = process.env.JWXT_PASSWORD;
    if (!account || !password) {
      console.error('缺少用户，且没有 JWXT_ACCOUNT / JWXT_PASSWORD 可用于创建');
      process.exit(1);
    }
    primary = await post('/admin/users', {
      account,
      password,
      servicePassword: 'test-pass',
    });
  }

  const created = await post('/admin/clients', {
    name: 'test-client',
    redirectUris: ['http://localhost:9999/cb'],
    scopes: ['jwxt.read', 'jwxt.profile'],
    userId: primary.id,
  });
  clientId = created.client_id;
  ok('create client', Boolean(clientId && created.client_secret));

  const client = new QzgwClient({
    baseUrl: BASE,
    clientId,
    clientSecret: created.client_secret,
  });

  const tokens = await client.clientCredentials({ scopes: ['jwxt.read'] });
  ok('clientCredentials', Boolean(tokens.accessToken), tokens.scope);

  const me = await client.me();
  ok('me', me.sub === String(primary.id), me.sub);

  const semesters = await client.semesters();
  ok('semesters', Array.isArray(semesters) && semesters.length > 0, `count=${semesters.length}`);

  const tt = await client.timetable({ semester: '2026-2027-1' });
  ok('timetable', Array.isArray(tt) && tt.length > 0, `count=${tt.length}`);

  const grades = await client.grades({ semester: '2026-2027-1' });
  ok('grades', grades && typeof grades === 'object' && Array.isArray(grades.data));

  // PKCE / authorizationUrl
  const pkce = await QzgwClient.createPkce();
  ok('createPkce', pkce.verifier.length >= 43 && pkce.challenge.length > 0 && pkce.challenge !== pkce.verifier);
  const authUrl = new URL(client.authorizationUrl({
    scopes: ['jwxt.read', 'offline_access'],
    state: 's1',
    codeChallenge: pkce.challenge,
    redirectUri: 'http://localhost:9999/cb',
  }));
  ok('authorizationUrl',
    authUrl.pathname === '/oauth/authorize'
    && authUrl.searchParams.get('response_type') === 'code'
    && authUrl.searchParams.get('client_id') === clientId
    && authUrl.searchParams.get('state') === 's1'
    && authUrl.searchParams.get('code_challenge') === pkce.challenge
    && authUrl.searchParams.get('code_challenge_method') === 'S256');

  // 错误
  const bad = new QzgwClient({ baseUrl: BASE, clientId });
  bad.tokens = { accessToken: 'bad', refreshToken: null, expiresAt: Date.now() + 60_000, scope: '' };
  try {
    await bad.me();
    ok('invalid token throws', false);
  } catch (e) {
    ok('invalid token throws', e instanceof QzgwError && e.status === 401, e.error);
  }

  // storage 持久化
  const store = new Map();
  const storage = {
    get: key => store.get(key),
    set: (key, value) => store.set(key, value),
    delete: key => store.delete(key),
  };
  const c2 = new QzgwClient({ baseUrl: BASE, clientId, clientSecret: created.client_secret, storage });
  await c2.clientCredentials({ scopes: ['jwxt.read'] });
  const c3 = new QzgwClient({ baseUrl: BASE, clientId, clientSecret: created.client_secret, storage });
  await c3.load();
  ok('storage load', Boolean(c3.tokens?.accessToken));
  const me3 = await c3.me();
  ok('storage token works', me3.sub === String(primary.id));
} finally {
  if (clientId) await del(`/admin/clients/${encodeURIComponent(clientId)}`).catch(() => {});
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exitCode = fails ? 1 : 0;
