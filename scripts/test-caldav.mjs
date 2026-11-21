// CalDAV 只读端到端测试。
// 用法（没有 CALDAV_TOKEN 时会用 ADMIN_TOKEN 临时签发一个）：
//   CALDAV_URL=http://localhost:8787/caldav/ CALDAV_USERNAME=caldav ADMIN_TOKEN=... npm run test:caldav
const BASE = (process.env.CALDAV_URL || 'http://localhost:8787/caldav/').replace(/\/?$/, '/');
const origin = new URL(BASE).origin;
const USER = process.env.CALDAV_USERNAME || 'caldav';
const ADMIN = process.env.ADMIN_TOKEN;
let PASS = process.env.CALDAV_TOKEN || '';
let auth = PASS ? 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64') : '';
let issuedToken = null;
let fails = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) fails++;
};

async function fetchWithTimeout(url, opts = {}, ms = 90_000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function bootstrapToken() {
  if (auth) return;
  if (!ADMIN) {
    console.error('缺少 CALDAV_TOKEN 或 ADMIN_TOKEN');
    process.exit(1);
  }
  const admin = { Authorization: `Bearer ${ADMIN}` };
  const usersRes = await fetch(origin + '/admin/users', { headers: admin });
  const users = await usersRes.json();
  const user = Array.isArray(users) ? users.find(u => u.username === USER) : null;
  if (!user) {
    console.error(`找不到用户 ${USER}；先运行 test:oauth 或 add-user`);
    process.exit(1);
  }
  const r = await fetch(`${origin}/admin/users/${user.id}/caldav-tokens`, {
    method: 'POST',
    headers: { ...admin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ label: 'test-caldav' }),
  });
  const t = await r.json();
  if (!t.token) {
    console.error('签发 CalDAV token 失败', t);
    process.exit(1);
  }
  PASS = t.token;
  issuedToken = { userId: user.id, tokenId: t.id };
  auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
}

async function req(path, { method = 'GET', headers = {}, body } = {}) {
  const url = new URL(path, origin).href;
  const r = await fetchWithTimeout(url, {
    method,
    headers: { Authorization: auth, ...headers },
    body,
  });
  return { status: r.status, headers: r.headers, text: await r.text() };
}

const propfind = (path, depth, props) => req(path, {
  method: 'PROPFIND',
  headers: {
    Depth: String(depth),
    'Content-Type': 'application/xml; charset=utf-8',
  },
  body: `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop>${props}</D:prop></D:propfind>`,
});

await bootstrapToken();

try {
  const options = await fetchWithTimeout(new URL('/caldav/', origin), { method: 'OPTIONS' });
  ok('OPTIONS 暴露 calendar-access', options.status === 200 && /calendar-access/.test(options.headers.get('dav') || ''));

  const root = await propfind('/caldav/', 0, '<D:current-user-principal/>');
  ok('PROPFIND 根返回 current-user-principal', root.status === 207 && root.text.includes('/caldav/principals/'));

  const wellKnown = await propfind('/.well-known/caldav', 0, '<D:current-user-principal/>');
  ok('PROPFIND well-known 返回 principal', wellKnown.status === 207 && wellKnown.text.includes('/caldav/principals/'));

  const principalHref = root.text.match(/<D:current-user-principal><D:href>([^<]+)<\/D:href>/)?.[1]
    || '/caldav/principals/caldav/';
  const principal = await propfind(principalHref, 0, '<C:calendar-home-set/>');
  ok('PROPFIND principal 返回 calendar-home-set', principal.status === 207 && principal.text.includes('/caldav/calendars/'));

  const homeHref = principal.text.match(/<C:calendar-home-set><D:href>([^<]+)<\/D:href>/)?.[1]
    || '/caldav/calendars/caldav/';
  const home = await propfind(homeHref, 1, '<D:resourcetype/><D:displayname/>');
  ok('PROPFIND 日历首页 depth=1 列出 timetable', home.status === 207 && home.text.includes('timetable/'));

  const calHref = homeHref.replace(/\/?$/, '/') + 'timetable/';
  const cal = await propfind(calHref, 0, '<D:resourcetype/><D:displayname/>');
  ok('PROPFIND 日历集合是 calendar', cal.status === 207 && cal.text.includes('<C:calendar/>') && cal.text.includes('课表'));

  const report = await req(calHref, {
    method: 'REPORT',
    headers: {
      Depth: '1',
      'Content-Type': 'application/xml; charset=utf-8',
    },
    body: `<?xml version="1.0" encoding="utf-8"?><C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data/></D:prop></C:calendar-query>`,
  });
  const eventCount = (report.text.match(/BEGIN:VEVENT/g) || []).length;
  ok('REPORT calendar-query 返回 VEVENT', report.status === 207 && report.text.includes('BEGIN:VCALENDAR') && eventCount > 0, `events=${eventCount}`);

  const eventHref = report.text.match(/<D:href>([^<]+\.ics)<\/D:href>/i)?.[1];
  const event = eventHref ? await req(eventHref) : { status: 0, headers: new Headers(), text: '' };
  ok('GET 单个事件', event.status === 200 && /text\/calendar/i.test(event.headers.get('content-type') || '') && event.text.includes('BEGIN:VEVENT'));

  const feed = await req(calHref);
  const etag = feed.headers.get('etag') || '';
  ok('GET 日历集合（.ics）', feed.status === 200 && /text\/calendar/i.test(feed.headers.get('content-type') || '') && feed.text.includes('BEGIN:VCALENDAR') && Boolean(etag), `etag=${etag}`);
  if (etag) {
    const cached = await req(calHref, { headers: { 'If-None-Match': etag } });
    ok('If-None-Match 返回 304', cached.status === 304);
  }

  const bad = await fetchWithTimeout(new URL('/caldav/', origin), {
    method: 'PROPFIND',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${USER}:wrong`).toString('base64'),
      Depth: '0',
      'Content-Type': 'application/xml; charset=utf-8',
    },
    body: '<?xml version="1.0"?><D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>',
  });
  ok('错误密码返回 401', bad.status === 401);
} catch (e) {
  console.error('FAIL  异常:', e.message);
  fails++;
}

if (issuedToken && ADMIN) {
  await fetch(`${origin}/admin/users/${issuedToken.userId}/caldav-tokens/${issuedToken.tokenId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${ADMIN}` },
  }).catch(() => {});
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exitCode = fails ? 1 : 0;
