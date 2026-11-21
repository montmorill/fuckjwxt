// 只读 CalDAV：把课表转成 VEVENT，支持 PROPFIND / REPORT / GET。
// 认证：Basic（users.username + 该用户的 CalDAV token）或 OAuth Bearer（jwxt.read）。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from './config.mjs';
import { hashToken, safeEqual, decrypt } from './crypto.mjs';
import * as db from './db.mjs';
import { authenticateBearer } from './oauth.mjs';
import { jwxt } from './jwxt-service.mjs';

const CALENDAR_NAME = '课表';
const CALENDAR_TIMEZONE = 'Asia/Shanghai';
const DEBUG = process.env.CALDAV_DEBUG === '1';
const CALENDAR_TIMEZONE_ICS = [
  'BEGIN:VTIMEZONE',
  'TZID:Asia/Shanghai',
  'BEGIN:STANDARD',
  'DTSTART:19700101T000000',
  'TZOFFSETFROM:+0800',
  'TZOFFSETTO:+0800',
  'TZNAME:CST',
  'END:STANDARD',
  'END:VTIMEZONE',
].join('\r\n');
const DEFAULT_PERIOD_TIMES = {
  '1-2': ['08:00', '09:40'],
  '3-4': ['10:00', '11:40'],
  '5-6': ['14:00', '15:40'],
  '7-8': ['16:00', '17:40'],
  '9-10': ['19:00', '20:40'],
  '11-12': ['20:50', '22:30'],
};

function pathsFor(user) {
  const owner = encodeURIComponent(user.account || user.username);
  const home = `/caldav/calendars/${owner}/`;
  return {
    principal: `/caldav/principals/${owner}/`,
    home,
    calendar: `${home}timetable/`,
  };
}

const pad = n => String(n).padStart(2, '0');
const sha1 = s => createHash('sha1').update(String(s)).digest('hex');
const sha256 = s => createHash('sha256').update(String(s)).digest('hex');

// OPPO 日历不展开 RDATE，给它每个上课日生成独立 VEVENT。
const expandEventsFor = req => /OPPO/i.test(String(req.headers['user-agent'] || ''));

const xmlEscape = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const icsEscape = s => String(s)
  .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
  .replace(/\r?\n/g, '\\n');

// RFC 5545 行折叠（按 UTF-8 字节，续行以空格开头）
function fold(line) {
  const out = [];
  let current = '';
  let bytes = 0;
  for (const ch of String(line)) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > 73) {
      out.push(current);
      current = ' ' + ch;
      bytes = 1 + b;
    } else {
      current += ch;
      bytes += b;
    }
  }
  out.push(current);
  return out.join('\r\n');
}

const cache = new Map(); // `${userId}:${semester}` -> { at, data }
export function clearCache(userId) {
  if (userId === undefined || userId === null) { cache.clear(); return; }
  const prefix = `${userId}:`;
  for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key);
}

// ---------- 认证 ----------
export async function authenticate(req) {
  const header = req.headers.authorization || '';

  if (/^Basic /i.test(header)) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const username = idx >= 0 ? decoded.slice(0, idx) : '';
    const password = idx >= 0 ? decoded.slice(idx + 1) : '';

    const user = db.getUserByUsername(username) || db.getUserByAccount(username);
    if (!user || user.disabled) return { error: [401, 'CalDAV 用户名或密码错误'], scheme: 'Basic' };

    // 密码可以是该用户的 CalDAV token，也可以直接是强智教务密码。
    const token = db.getCalDavTokenByHash(hashToken(password));
    if (token && token.user_id === user.id) {
      db.touchCalDavToken(token.id);
      return { user };
    }

    try {
      if (safeEqual(decrypt(user.password_enc), password)) return { user };
    } catch { /* 解密失败按密码错误处理 */ }

    return { error: [401, 'CalDAV 用户名或密码错误'], scheme: 'Basic' };
  }

  if (/^Bearer /i.test(header)) {
    try {
      const auth = authenticateBearer(req);
      if (!auth.scopes.includes('jwxt.read')) return { error: [403, '缺少 jwxt.read'], scheme: 'Bearer' };
      return { user: auth.user };
    } catch (e) {
      return { error: [401, e.message], scheme: 'Bearer' };
    }
  }

  return { error: [401, '需要 Basic 或 Bearer 认证'], scheme: 'Basic' };
}

// ---------- 日期/周次 ----------
function parseWeeks(text) {
  const set = new Set();
  for (const part of String(text || '').split(/[,，]/)) {
    const p = part.trim();
    let m = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const a = Number(m[1]); const b = Number(m[2]);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) set.add(i);
    } else if (/^\d+$/.test(p)) {
      set.add(Number(p));
    }
  }
  return [...set].filter(n => n > 0).sort((a, b) => a - b);
}

function parsePeriodKey(periods) {
  const m = String(periods || '').match(/(\d+)\s*-\s*(\d+)/);
  if (m) return `${Number(m[1])}-${Number(m[2])}`;
  const one = String(periods || '').match(/(\d+)/);
  return one ? `${Number(one[1])}-${Number(one[1])}` : '';
}

let periodTimesCache = null;

// 作息表固定从 config/period-times.json 读；缺失或格式不对的键回退到内置默认值。
function periodTimes() {
  if (periodTimesCache) return periodTimesCache;
  const map = { ...DEFAULT_PERIOD_TIMES };
  try {
    const raw = JSON.parse(readFileSync(new URL('../config/period-times.json', import.meta.url), 'utf8'));
    for (const [key, value] of Object.entries(raw)) {
      if (!/^\d+-\d+$/.test(key) || !Array.isArray(value) || value.length !== 2) continue;
      const [start, end] = value.map(String);
      if (/^\d{1,2}:\d{2}$/.test(start) && /^\d{1,2}:\d{2}$/.test(end)) map[key] = [start, end];
    }
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn(`[caldav] config/period-times.json 读取失败，使用默认作息: ${e.message}`);
    }
  }
  periodTimesCache = map;
  return map;
}

function dateFor(start, week, day) {
  const d = new Date(Date.UTC(start.y, start.m - 1, start.d));
  d.setUTCDate(d.getUTCDate() + (week - 1) * 7 + (day - 1));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

// 本地时间（固定 Asia/Shanghai，+08:00）转 UTC 的 iCalendar 时间戳
function utcStamp(y, m, d, hh = '00', mm = '00') {
  const dt = new Date(Date.UTC(y, m - 1, d, Number(hh) - 8, Number(mm)));
  return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}${pad(dt.getUTCMinutes())}${pad(dt.getUTCSeconds())}Z`;
}

function parseSemesterStart(html, semester) {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => m[1]);
  const row = rows.find(r => r.includes('第1周'));
  if (row) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map(m => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    for (let i = 1; i <= 7; i++) {
      const m = cells[i]?.match(/(\d{1,2})月(\d{1,2})日/);
      if (m) {
        const month = Number(m[1]);
        const day = Number(m[2]);
        const [firstYear, secondYear] = semester.split('-').map(Number);
        const year = month >= 8 ? firstYear : secondYear;
        const d = new Date(Date.UTC(year, month - 1, day));
        d.setUTCDate(d.getUTCDate() - (i - 1));
        return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
      }
    }
  }
  throw new Error(`无法从教学周历解析 ${semester} 的开学日期`);
}

// ---------- ICS ----------
function vcalendar(eventLineArrays, name) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//jwxt-oauth//CN',
    'CALSCALE:GREGORIAN',
    `X-WR-CALNAME:${icsEscape(name || CALENDAR_NAME)}`,
    `X-WR-TIMEZONE:${CALENDAR_TIMEZONE}`,
    ...eventLineArrays.flat(),
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

function buildEvent({ item, hash, day, sh, sm, eh, em, rdates, description, calendarHref, stamp }) {
  const eventLines = [
    'BEGIN:VEVENT',
    `UID:${hash}@jwxt-oauth`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${utcStamp(day.y, day.m, day.d, sh, sm)}`,
    `DTEND:${utcStamp(day.y, day.m, day.d, eh, em)}`,
    ...rdates.map(r => `RDATE:${r}`),
    `SUMMARY:${icsEscape(item.name)}`,
    item.location ? `LOCATION:${icsEscape(item.location)}` : '',
    description ? `DESCRIPTION:${icsEscape(description)}` : '',
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'CATEGORIES:课表',
    'END:VEVENT',
  ].filter(Boolean);

  const ics = vcalendar([eventLines], item.name);
  return {
    hash,
    uid: `${hash}@jwxt-oauth`,
    summary: item.name,
    href: `${calendarHref}${hash}.ics`,
    etag: `"${sha256(ics).slice(0, 32)}"`,
    ics,
    eventLines,
    start: utcStamp(day.y, day.m, day.d, sh, sm),
  };
}

function buildEvents(items, start, semester, calendarHref, expand) {
  const times = periodTimes();
  const stamp = utcStamp(start.y, start.m, start.d, '00', '00');
  const events = [];
  const seen = new Set();

  for (const item of items) {
    const weeks = parseWeeks(item.weeks);
    if (!weeks.length || !item.day) continue;

    const periodKey = parsePeriodKey(item.periods);
    const [startTime, endTime] = times[periodKey] || times['1-2'];
    const [sh, sm] = startTime.split(':');
    const [eh, em] = endTime.split(':');

    const description = [
      item.teacher ? `教师: ${item.teacher}` : '',
      item.courseCode ? `课程编号: ${item.courseCode}` : '',
      item.className ? `班级: ${item.className}` : '',
      item.weeks ? `周次: ${item.weeks}` : '',
      item.location ? `地点: ${item.location}` : '',
    ].filter(Boolean).join('\n');

    if (expand) {
      // OPPO 等客户端对 RDATE 展开支持不好：每个上课日生成独立 VEVENT。
      for (const week of weeks) {
        const day = dateFor(start, week, item.day);
        const hash = sha1(`${semester}|${item.name}|${item.day}|${periodKey}|${item.location}|${item.teacher}|${week}`);
        if (seen.has(hash)) continue;
        seen.add(hash);
        events.push(buildEvent({ item, hash, day, sh, sm, eh, em, rdates: [], description, calendarHref, stamp }));
      }
      continue;
    }

    // 其他客户端使用标准 RDATE 展开，体积更小。
    const hash = sha1(`${semester}|${item.name}|${item.day}|${periodKey}|${item.location}|${item.teacher}|${item.weeks}`);
    if (seen.has(hash)) continue;
    seen.add(hash);
    const day = dateFor(start, weeks[0], item.day);
    const rdates = weeks.slice(1).map(week => {
      const d = dateFor(start, week, item.day);
      return utcStamp(d.y, d.m, d.d, sh, sm);
    });
    events.push(buildEvent({ item, hash, day, sh, sm, eh, em, rdates, description, calendarHref, stamp }));
  }

  events.sort((a, b) => a.start.localeCompare(b.start) || a.hash.localeCompare(b.hash));
  return events;
}

async function buildCalendar(user, expand) {
  const semesters = await jwxt.semesters(user);
  const semester = user.caldav_semester
    || semesters.find(s => s.selected)?.value || semesters[0]?.value;
  if (!semester) throw new Error('没有可用学期');

  const items = await jwxt.timetable(user, { semester });
  const html = await jwxt.calendar(user, semester);
  const start = parseSemesterStart(html, semester);
  const paths = pathsFor(user);
  const events = buildEvents(items, start, semester, paths.calendar, expand);
  const fullIcs = vcalendar(events.map(e => e.eventLines), CALENDAR_NAME);
  const etag = `"${sha256(fullIcs).slice(0, 32)}"`;
  const lastModified = new Date(Date.UTC(start.y, start.m - 1, start.d)).toUTCString();

  return { semester, start, events, fullIcs, etag, lastModified, paths };
}

async function calendarData(user, expand = false) {
  const key = `${user.id}:${user.caldav_semester || 'current'}:${expand ? 'oppo' : 'std'}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < config.caldavCacheMs) return hit.data;
  const data = await buildCalendar(user, expand);
  cache.set(key, { at: Date.now(), data });
  return data;
}

// ---------- XML ----------
function propXml(name, ctx) {
  switch (name) {
    case 'resourcetype':
      if (ctx.kind === 'calendar') return '<D:resourcetype><D:collection/><C:calendar/></D:resourcetype>';
      if (ctx.kind === 'event') return '<D:resourcetype/>';
      if (ctx.kind === 'principal') return '<D:resourcetype><D:collection/><D:principal/></D:resourcetype>';
      return '<D:resourcetype><D:collection/></D:resourcetype>';
    case 'displayname':
      return `<D:displayname>${xmlEscape(ctx.displayname || '')}</D:displayname>`;
    case 'current-user-principal':
      return `<D:current-user-principal><D:href>${ctx.paths.principal}</D:href></D:current-user-principal>`;
    case 'principal-url':
      return `<D:principal-URL><D:href>${ctx.paths.principal}</D:href></D:principal-URL>`;
    case 'calendar-home-set':
      return `<C:calendar-home-set><D:href>${ctx.paths.home}</D:href></C:calendar-home-set>`;
    case 'calendar-user-address-set':
      return `<C:calendar-user-address-set><D:href>mailto:${xmlEscape(ctx.username || '')}@jwxt.local</D:href></C:calendar-user-address-set>`;
    case 'current-user-privilege-set':
      return '<D:current-user-privilege-set><D:privilege><D:read/></D:privilege><D:privilege><D:read-current-user-privilege-set/></D:privilege></D:current-user-privilege-set>';
    case 'group-membership':
      return '<D:group-membership/>';
    case 'source':
      return '<CS:source/>';
    case 'supported-calendar-component-set':
      return '<C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>';
    case 'getetag':
      return ctx.etag ? `<D:getetag>${xmlEscape(ctx.etag)}</D:getetag>` : '';
    case 'getcontenttype':
      return ctx.kind === 'calendar' || ctx.kind === 'event'
        ? '<D:getcontenttype>text/calendar; charset=utf-8</D:getcontenttype>' : '';
    case 'getlastmodified':
      return ctx.lastModified ? `<D:getlastmodified>${xmlEscape(ctx.lastModified)}</D:getlastmodified>` : '';
    case 'calendar-description':
      return '<C:calendar-description>强智教务课表</C:calendar-description>';
    case 'owner':
      return `<D:owner><D:href>${ctx.paths.principal}</D:href></D:owner>`;
    case 'supported-report-set':
      return '<D:supported-report-set><D:supported-report><D:report><C:calendar-query/></D:report></D:supported-report><D:supported-report><D:report><C:calendar-multiget/></D:report></D:supported-report><D:supported-report><D:report><D:sync-collection/></D:report></D:supported-report></D:supported-report-set>';
    case 'getctag':
      return ctx.etag ? `<CS:getctag>${xmlEscape(ctx.etag)}</CS:getctag>` : '';
    case 'sync-token':
      return ctx.etag ? `<D:sync-token>${xmlEscape(ctx.etag)}</D:sync-token>` : '';
    case 'calendar-color':
      return '<A:calendar-color>#FF9500FF</A:calendar-color>';
    case 'calendar-order':
      return '<A:calendar-order>1</A:calendar-order>';
    case 'calendar-timezone':
      return `<C:calendar-timezone>${xmlEscape(CALENDAR_TIMEZONE_ICS)}</C:calendar-timezone>`;
    case 'supported-calendar-data':
      return '<C:supported-calendar-data><C:calendar-data content-type="text/calendar" version="2.0"/></C:supported-calendar-data>';
    case 'max-resource-size':
      return '<C:max-resource-size>10485760</C:max-resource-size>';
    case 'min-date-time':
      return '<C:min-date-time>20000101T000000Z</C:min-date-time>';
    case 'max-date-time':
      return '<C:max-date-time>20380101T000000Z</C:max-date-time>';
    case 'schedule-calendar-transp':
      return '<C:schedule-calendar-transp><C:opaque/></C:schedule-calendar-transp>';
    case 'quota-available-bytes':
      return '<D:quota-available-bytes>1073741824</D:quota-available-bytes>';
    case 'quota-used-bytes':
      return '<D:quota-used-bytes>0</D:quota-used-bytes>';
    default:
      return '';
  }
}

const DEFAULT_PROPS = {
  root: ['resourcetype', 'displayname', 'current-user-principal', 'current-user-privilege-set'],
  principal: ['resourcetype', 'displayname', 'current-user-principal', 'principal-url', 'calendar-home-set', 'calendar-user-address-set', 'current-user-privilege-set', 'group-membership'],
  home: ['resourcetype', 'displayname', 'current-user-principal', 'calendar-home-set', 'current-user-privilege-set', 'calendar-color', 'calendar-timezone', 'source'],
  calendar: ['resourcetype', 'displayname', 'supported-calendar-component-set', 'getetag', 'getcontenttype', 'calendar-description', 'owner', 'current-user-principal', 'calendar-home-set', 'supported-report-set', 'getctag', 'current-user-privilege-set', 'sync-token', 'calendar-color', 'calendar-order', 'calendar-timezone', 'supported-calendar-data', 'max-resource-size', 'min-date-time', 'max-date-time', 'schedule-calendar-transp', 'quota-available-bytes', 'quota-used-bytes', 'source'],
  event: ['getetag', 'getcontenttype', 'resourcetype', 'getlastmodified', 'displayname'],
};
const KNOWN_PROPS = new Set(Object.values(DEFAULT_PROPS).flat());

function requestedProps(body) {
  const propBlock = body.match(/<(?:\w+:)?prop\b[^>]*>([\s\S]*?)<\/(?:\w+:)?prop>/i)?.[1] || body;
  if (/allprop/i.test(propBlock)) return new Set();
  const out = new Set();
  for (const m of propBlock.matchAll(/<(?:\w+:)?([A-Za-z0-9_-]+)\b/gi)) {
    const name = m[1].toLowerCase();
    if (KNOWN_PROPS.has(name)) out.add(name);
  }
  return out;
}

function propsFor(ctx, requested) {
  const names = requested?.size ? [...requested] : DEFAULT_PROPS[ctx.kind];
  return names.map(name => propXml(name, ctx)).filter(Boolean);
}

function responseXml(href, props) {
  return `<D:response><D:href>${xmlEscape(href)}</D:href><D:propstat><D:prop>${props.join('')}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

function multistatus(responses) {
  return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:A="http://apple.com/ns/ical/">${responses.join('')}</D:multistatus>`;
}

function multistatusWithToken(responses, token) {
  return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/" xmlns:A="http://apple.com/ns/ical/">${responses.join('')}<D:sync-token>${xmlEscape(token)}</D:sync-token></D:multistatus>`;
}

// ---------- HTTP ----------
function baseHeaders() {
  return {
    DAV: '1, 2, calendar-access',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
}

function send(res, status, body, headers = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { ...baseHeaders(), ...headers });
  res.end(body);
}

function sendXml(res, xml) {
  send(res, 207, xml, { 'Content-Type': 'application/xml; charset=utf-8' });
}

function sendIcs(res, ics, etag, lastModified, head = false) {
  send(res, 200, head ? '' : ics, {
    'Content-Type': 'text/calendar; charset=utf-8',
    ETag: etag,
    'Last-Modified': lastModified,
  });
}

function sendText(res, status, text, headers = {}) {
  send(res, status, text + '\n', { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
}

function send404(res) { sendText(res, 404, 'not found'); }

function sendNotModified(res, etag) { send(res, 304, '', { ETag: etag }); }

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function resolvePath(url) {
  if (url.pathname === '/') return { kind: 'root' };
  if (!url.pathname.startsWith('/caldav')) return { kind: 'notfound' };
  const parts = url.pathname.replace(/^\/caldav\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return { kind: 'root' };
  if (parts[0] === 'principals' && parts.length === 2) return { kind: 'principal', username: parts[1] };
  if (parts[0] === 'calendars' && parts.length >= 2) {
    const username = parts[1];
    if (parts.length === 2) return { kind: 'home', username };
    if (parts.length === 3 && parts[2] === 'timetable') return { kind: 'calendar', username };
    if (parts.length === 3 && parts[2] === 'timetable.ics') return { kind: 'feed', username };
    if (parts.length === 4 && parts[2] === 'timetable' && parts[3].endsWith('.ics')) {
      return { kind: 'event', username, hash: parts[3].slice(0, -4) };
    }
  }
  return { kind: 'notfound' };
}

function etagMatches(req, etag) {
  const header = String(req.headers['if-none-match'] || '');
  return header.split(',').map(s => s.trim().replace(/^W\//, '')).includes(etag);
}

async function handlePropfind(req, res, user, path) {
  if (path.kind === 'notfound') return send404(res);
  const depth = String(req.headers.depth || '0').toLowerCase();
  const deep = depth === '1' || depth === 'infinity';
  const body = await readBody(req);
  if (DEBUG) {
    console.log(`[caldav] PROPFIND ${path.kind} depth=${depth} ua=${JSON.stringify(req.headers['user-agent'] || '')}\n${body}`);
  }
  const requested = requestedProps(body);
  const paths = pathsFor(user);
  const username = user.account || user.username;

  let cal = null;
  if (['calendar', 'event', 'feed'].includes(path.kind)) cal = await calendarData(user, expandEventsFor(req));

  const responses = [];
  const add = (href, ctx) => responses.push(responseXml(href, propsFor({ ...ctx, paths, username }, requested)));

  switch (path.kind) {
    case 'root':
      add('/caldav/', { kind: 'root', displayname: 'CalDAV' });
      if (deep) add(paths.principal, { kind: 'principal', displayname: username });
      break;
    case 'principal':
      add(paths.principal, { kind: 'principal', displayname: username });
      if (deep) add(paths.home, { kind: 'home', displayname: '日历' });
      break;
    case 'home':
      add(paths.home, { kind: 'home', displayname: '日历' });
      if (deep) {
        // 发现阶段不强制生成整张日历，避免首次 PROPFIND 过慢
        add(paths.calendar, { kind: 'calendar', displayname: CALENDAR_NAME, etag: cal?.etag, lastModified: cal?.lastModified });
      }
      break;
    case 'calendar':
    case 'feed':
      add(paths.calendar, { kind: 'calendar', displayname: CALENDAR_NAME, etag: cal.etag, lastModified: cal.lastModified });
      if (deep) {
        for (const e of cal.events) add(e.href, { kind: 'event', displayname: e.summary, etag: e.etag, lastModified: cal.lastModified });
      }
      break;
    case 'event': {
      const e = cal.events.find(x => x.hash === path.hash);
      if (!e) return send404(res);
      add(e.href, { kind: 'event', displayname: e.summary, etag: e.etag, lastModified: cal.lastModified });
      break;
    }
  }
  const xml = multistatus(responses);
  if (DEBUG) console.log(`[caldav] PROPFIND ${path.kind} response ${xml.length} bytes\n${xml.slice(0, 6000)}`);
  sendXml(res, xml);
}

async function handleReport(req, res, user, path) {
  if (path.kind !== 'calendar' && path.kind !== 'feed') {
    return sendText(res, 403, '只支持课表日历');
  }
  const body = await readBody(req);
  if (DEBUG) console.log(`[caldav] REPORT ${path.kind} ua=${JSON.stringify(req.headers['user-agent'] || '')}\n${body}`);
  const cal = await calendarData(user, expandEventsFor(req));
  let events = cal.events;

  if (/sync-collection/i.test(body)) {
    const responses = events.map(e => `<D:response><D:href>${xmlEscape(e.href)}</D:href><D:propstat><D:prop><D:getetag>${xmlEscape(e.etag)}</D:getetag><C:calendar-data>${xmlEscape(e.ics)}</C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
    return sendXml(res, multistatusWithToken(responses, cal.etag));
  }

  if (/calendar-multiget/i.test(body)) {
    const norm = href => {
      try { return decodeURIComponent(new URL(href, 'http://caldav.local').pathname); }
      catch { return href; }
    };
    const wanted = new Set([...body.matchAll(/<(?:\w+:)?href[^>]*>([^<]+)<\/(?:\w+:)?href>/gi)].map(m => norm(m[1].trim())));
    if (wanted.size) events = cal.events.filter(e => wanted.has(norm(e.href)));
  }

  const responses = events.map(e => `<D:response><D:href>${xmlEscape(e.href)}</D:href><D:propstat><D:prop><D:getetag>${xmlEscape(e.etag)}</D:getetag><C:calendar-data>${xmlEscape(e.ics)}</C:calendar-data></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
  sendXml(res, multistatus(responses));
}

async function handleGet(req, res, user, path) {
  const head = req.method === 'HEAD';
  const expand = expandEventsFor(req);

  if (path.kind === 'calendar' || path.kind === 'feed') {
    const cal = await calendarData(user, expand);
    if (etagMatches(req, cal.etag)) return sendNotModified(res, cal.etag);
    return sendIcs(res, cal.fullIcs, cal.etag, cal.lastModified, head);
  }

  if (path.kind === 'event') {
    const cal = await calendarData(user, expand);
    const e = cal.events.find(x => x.hash === path.hash);
    if (!e) return send404(res);
    if (etagMatches(req, e.etag)) return sendNotModified(res, e.etag);
    return sendIcs(res, e.ics, e.etag, cal.lastModified, head);
  }

  return send404(res);
}

function handleOptions(res) {
  send(res, 200, '', {
    DAV: '1, 2, calendar-access',
    Allow: 'OPTIONS, GET, HEAD, PROPFIND, REPORT',
    'MS-Author-Via': 'DAV',
  });
}

export async function handleCalDav(req, res, url) {
  const method = String(req.method || '').toUpperCase();

  if (method === 'OPTIONS') return handleOptions(res);

  const auth = await authenticate(req);
  if (auth.error) {
    const [status, message] = auth.error;
    const challenge = auth.scheme === 'Bearer'
      ? 'Bearer error="invalid_token"'
      : 'Basic realm="jwxt-oauth CalDAV", charset="UTF-8"';
    res.setHeader('WWW-Authenticate', challenge);
    return sendText(res, status, message);
  }

  const path = resolvePath(url);

  // 只能访问自己的 principal / calendar；路径可用 username 或学号
  const self = new Set([auth.user.username, auth.user.account].filter(Boolean));
  if (path.username && !self.has(path.username)) return send404(res);

  if (method === 'PROPFIND') return handlePropfind(req, res, auth.user, path);
  if (method === 'REPORT') return handleReport(req, res, auth.user, path);
  if (method === 'GET' || method === 'HEAD') return handleGet(req, res, auth.user, path);

  if (['PUT', 'DELETE', 'MKCALENDAR', 'PROPPATCH', 'COPY', 'MOVE'].includes(method)) {
    return sendText(res, 405, '只读 CalDAV', { Allow: 'OPTIONS, GET, HEAD, PROPFIND, REPORT' });
  }
  return sendText(res, 405, '不支持的方法', { Allow: 'OPTIONS, GET, HEAD, PROPFIND, REPORT' });
}
