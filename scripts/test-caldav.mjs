// CalDAV 只读端到端测试。
// 用法：
//   CALDAV_URL=http://localhost:8787/caldav/ CALDAV_USER=caldav CALDAV_TOKEN=... npm run test:caldav
const BASE = (process.env.CALDAV_URL || 'http://localhost:8787/caldav/').replace(/\/?$/, '/');
const USER = process.env.CALDAV_USER || 'caldav';
const PASS = process.env.CALDAV_TOKEN;
if (!PASS) {
  console.error('缺少 CALDAV_TOKEN');
  process.exit(1);
}

const origin = new URL(BASE).origin;
const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
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

try {
  const options = await fetchWithTimeout(new URL('/caldav/', origin), { method: 'OPTIONS' });
  ok('OPTIONS 暴露 calendar-access', options.status === 200 && /calendar-access/.test(options.headers.get('dav') || ''));

  const root = await propfind('/caldav/', 0, '<D:current-user-principal/>');
  ok('PROPFIND 根返回 current-user-principal', root.status === 207 && root.text.includes('/caldav/principals/'));

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

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exitCode = fails ? 1 : 0;
