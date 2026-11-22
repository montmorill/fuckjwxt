// 只读 CalDAV：把课表转成 VEVENT，支持 PROPFIND / REPORT / GET。
// 认证：Basic（users.account + 该用户的 CalDAV token）或 OAuth Bearer（jwxt.read）。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { config } from './config.mjs';
import { hashToken, safeEqual, decrypt } from './crypto.mjs';
import * as db from './db.mjs';
import { authenticateBearer } from './oauth.mjs';
import { jwxt } from './jwxt-service.mjs';

const CALENDAR_NAME = '课表';
const CALENDAR_TIMEZONE = 'Asia/Shanghai';
const DEBUG = process.env.CALDAV_DEBUG === '1';
if (process.env.CALDAV_FIXTURE === '1') {
  console.warn('[caldav] fixture mode: using tests/fixtures/timetable.json（不会读取真实课表）');
}
const CALENDAR_TIMEZONE_LINES = [
  'BEGIN:VTIMEZONE',
  'TZID:Asia/Shanghai',
  'BEGIN:STANDARD',
  'DTSTART:19700101T000000',
  'TZOFFSETFROM:+0800',
  'TZOFFSETTO:+0800',
  'TZNAME:CST',
  'END:STANDARD',
  'END:VTIMEZONE',
];
const CALENDAR_TIMEZONE_ICS = CALENDAR_TIMEZONE_LINES.join('\r\n');
const COURSE_COLORS = [
  '#BE675E', '#C1834A', '#BB963E', '#5FA658', '#539BA7', '#6993DF',
  '#7B72DD', '#AE69C2', '#B05A87', '#729539', '#809DBB', '#AD746D',
];
const DEFAULT_PERIOD_TIMES = {
  '1-2': ['08:00', '09:50'],
  '3-4': ['10:10', '12:00'],
  '5-6': ['14:00', '15:50'],
  '7-8': ['16:10', '18:00'],
  '9-10': ['19:00', '20:50'],
};

function pathsFor(user) {
  const owner = encodeURIComponent(user.account);
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

// 普通客户端按 RFC 转义，保留英文逗号；OPPO 不还原转义，改用全角标点。
const icsEscapeRfc = s => String(s)
  .replace(/\\/g, '\\\\')
  .replace(/;/g, '\\;')
  .replace(/,/g, '\\,')
  .replace(/\r?\n/g, '\\n');
const icsEscapeOppo = s => String(s)
  .replace(/,/g, '、')
  .replace(/;/g, '；')
  .replace(/\r?\n/g, ' ')
  .replace(/\\/g, '＼');

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
async function authenticate(req) {
  const header = req.headers.authorization || '';

  if (/^Basic /i.test(header)) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const account = idx >= 0 ? decoded.slice(0, idx) : '';
    const password = idx >= 0 ? decoded.slice(idx + 1) : '';

    const user = db.getUserByAccount(account);
    if (!user || user.disabled) return { error: [401, 'CalDAV 学号或密码错误'], scheme: 'Basic' };

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

// 本地时间（固定 Asia/Shanghai，+08:00）转 UTC，用于 DTSTAMP
function utcStamp(y, m, d, hh = '00', mm = '00') {
  const dt = new Date(Date.UTC(y, m - 1, d, Number(hh) - 8, Number(mm)));
  return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}${pad(dt.getUTCMinutes())}${pad(dt.getUTCSeconds())}Z`;
}

// 带 TZID 的本地时间，不再写 UTC
function localStamp(y, m, d, hh = '00', mm = '00') {
  return `${y}${pad(m)}${pad(d)}T${pad(hh)}${pad(mm)}00`;
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
function vcalendar(eventLineArrays, name, { compact = false } = {}) {
  const lines = compact
    ? [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//qzgw//CN',
      `X-WR-TIMEZONE:${CALENDAR_TIMEZONE}`,
      ...CALENDAR_TIMEZONE_LINES,
      ...eventLineArrays.flat(),
      'END:VCALENDAR',
    ]
    : [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//qzgw//CN',
      `X-WR-CALNAME:${(compact ? icsEscapeOppo : icsEscapeRfc)(name || CALENDAR_NAME)}`,
      `X-WR-TIMEZONE:${CALENDAR_TIMEZONE}`,
      ...CALENDAR_TIMEZONE_LINES,
      ...eventLineArrays.flat(),
      'END:VCALENDAR',
    ];
  return lines.map(fold).join('\r\n') + '\r\n';
}

function calendarLabel(user, items) {
  const counts = new Map();
  for (const item of items) {
    const name = String(item.className || '').trim();
    if (name) counts.set(name, (counts.get(name) || 0) + 1);
  }
  const className = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))[0]?.[0] || '';
  return { className, calendarName: `${className || user.account} 课表` };
}

function buildEvent({ item, hash, day, sh, sm, eh, em, rdates, color, description, compact, calendarHref, stamp }) {
  const esc = compact ? icsEscapeOppo : icsEscapeRfc;
  const splitList = value => String(value || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
  const categoryParts = (compact
    ? ['课表', ...splitList(item.className), ...splitList(item.teacher)]
    : ['课表', ...splitList(item.className), item.name, ...splitList(item.teacher)]
  ).filter(Boolean);
  const categories = categoryParts.map(esc).join(',');
  const eventLines = compact
    ? [
      'BEGIN:VEVENT',
      `UID:${hash}@qzgw`,
      `DTSTAMP:${stamp}`,
      'SEQUENCE:3',
      `DTSTART;TZID=${CALENDAR_TIMEZONE}:${localStamp(day.y, day.m, day.d, sh, sm)}`,
      `DTEND;TZID=${CALENDAR_TIMEZONE}:${localStamp(day.y, day.m, day.d, eh, em)}`,
      `SUMMARY:${esc(item.name)}`,
      item.location ? `LOCATION:${esc(item.location)}` : '',
      description ? `DESCRIPTION:${esc(description)}` : '',
      `CATEGORIES:${categories}`,
      'END:VEVENT',
    ]
    : [
      'BEGIN:VEVENT',
      `UID:${hash}@qzgw`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=${CALENDAR_TIMEZONE}:${localStamp(day.y, day.m, day.d, sh, sm)}`,
      `DTEND;TZID=${CALENDAR_TIMEZONE}:${localStamp(day.y, day.m, day.d, eh, em)}`,
      ...rdates.map(r => `RDATE;TZID=${CALENDAR_TIMEZONE}:${r}`),
      `SUMMARY:${esc(item.name)}`,
      item.location ? `LOCATION:${esc(item.location)}` : '',
      description ? `DESCRIPTION:${esc(description)}` : '',
      `COLOR:${color || COURSE_COLORS[0]}`,
      `CATEGORIES:${categories}`,
      'END:VEVENT',
    ].filter(Boolean);

  const ics = vcalendar([eventLines], item.name, { compact });
  return {
    hash,
    uid: `${hash}@qzgw`,
    summary: item.name,
    href: `${calendarHref}${hash}.ics`,
    etag: `"${sha256(ics).slice(0, 32)}"`,
    ics,
    eventLines,
    start: localStamp(day.y, day.m, day.d, sh, sm),
    color: color || COURSE_COLORS[0],
  };
}

function buildEvents(items, start, semester, calendarHref, expand) {
  const times = periodTimes();
  const stamp = utcStamp(start.y, start.m, start.d, '00', '00');
  const events = [];
  const seen = new Set();
  const courseNames = [...new Set(items.map(i => i.name).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  const colors = new Map(courseNames.map((name, i) => [name, COURSE_COLORS[i % COURSE_COLORS.length]]));

  for (const item of items) {
    const weeks = parseWeeks(item.weeks);
    if (!weeks.length || !item.day) continue;

    const periodKey = parsePeriodKey(item.periods);
    const [startTime, endTime] = times[periodKey] || times['1-2'];
    const [sh, sm] = startTime.split(':');
    const [eh, em] = endTime.split(':');
    const description = item.teacher ? `教师：${item.teacher}` : '';
    const courseKey = item.courseCode || item.name;

    if (expand) {
      // OPPO 等客户端对 RDATE 展开支持不好：每个上课日生成独立 VEVENT。
      for (const week of weeks) {
        const day = dateFor(start, week, item.day);
        const hash = sha1(`${semester}|${courseKey}|${week}|${item.day}|${periodKey}`);
        if (seen.has(hash)) continue;
        seen.add(hash);
        events.push(buildEvent({ item, hash, day, sh, sm, eh, em, rdates: [], color: colors.get(item.name), description, compact: true, calendarHref, stamp }));
      }
      continue;
    }

    // 其他客户端使用标准 RDATE 展开，体积更小。
    const hash = sha1(`${semester}|${courseKey}|${item.day}|${periodKey}|${weeks.join(',')}`);
    if (seen.has(hash)) continue;
    seen.add(hash);
    const day = dateFor(start, weeks[0], item.day);
    const rdates = weeks.slice(1).map(week => {
      const d = dateFor(start, week, item.day);
      return localStamp(d.y, d.m, d.d, sh, sm);
    });
    events.push(buildEvent({ item, hash, day, sh, sm, eh, em, rdates, color: colors.get(item.name), description, compact: false, calendarHref, stamp }));
  }

  events.sort((a, b) => a.start.localeCompare(b.start) || a.hash.localeCompare(b.hash));
  return events;
}

function buildCourses(events, homeHref) {
  const groups = new Map();
  for (const e of events) {
    if (!groups.has(e.summary)) groups.set(e.summary, []);
    groups.get(e.summary).push(e);
  }
  return [...groups.entries()].map(([name, list]) => {
    const slug = sha1(name).slice(0, 12);
    const prefix = `${homeHref}course-${slug}/`;
    const courseEvents = list.map(e => ({ ...e, href: `${prefix}${e.hash}.ics` }));
    const ics = vcalendar(courseEvents.map(e => e.eventLines), name);
    return {
      name,
      slug,
      color: list[0].color || COURSE_COLORS[0],
      events: courseEvents,
      ics,
      etag: `"${sha256(ics).slice(0, 32)}"`,
    };
  });
}

let fixtureCache = null;
function loadFixture() {
  if (fixtureCache) return fixtureCache;
  fixtureCache = JSON.parse(readFileSync(new URL('../tests/fixtures/timetable.json', import.meta.url), 'utf8'));
  return fixtureCache;
}

async function buildCalendar(user, expand) {
  const fixture = process.env.CALDAV_FIXTURE === '1' ? loadFixture() : null;
  const semesters = fixture ? [] : await jwxt.semesters(user);
  const semester = fixture?.semester
    || user.caldav_semester
    || semesters.find(s => s.selected)?.value || semesters[0]?.value;
  if (!semester) throw new Error('没有可用学期');

  let items;
  let start;
  if (fixture) {
    items = fixture.items;
    start = fixture.start;
  } else {
    items = await jwxt.timetable(user, { semester });
    const html = await jwxt.calendar(user, semester);
    start = parseSemesterStart(html, semester);
  }
  const paths = pathsFor(user);
  const { className, calendarName } = calendarLabel(user, items);
  const events = buildEvents(items, start, semester, paths.calendar, expand);
  const courses = buildCourses(events, paths.home);
  const fullIcs = vcalendar(events.map(e => e.eventLines), calendarName);
  const etag = `"${sha256(fullIcs).slice(0, 32)}"`;
  const lastModified = new Date(Date.UTC(start.y, start.m - 1, start.d)).toUTCString();

  return { semester, start, events, courses, fullIcs, etag, lastModified, paths, className, calendarName };
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
      return `<C:calendar-user-address-set><D:href>mailto:${xmlEscape(ctx.account || '')}@jwxt.local</D:href></C:calendar-user-address-set>`;
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
      return `<C:calendar-description>${xmlEscape(ctx.description || '强智教务课表')}</C:calendar-description>`;
    case 'owner':
      return `<D:owner><D:href>${ctx.paths.principal}</D:href></D:owner>`;
    case 'supported-report-set':
      return '<D:supported-report-set><D:supported-report><D:report><C:calendar-query/></D:report></D:supported-report><D:supported-report><D:report><C:calendar-multiget/></D:report></D:supported-report><D:supported-report><D:report><D:sync-collection/></D:report></D:supported-report></D:supported-report-set>';
    case 'getctag':
      return ctx.etag ? `<CS:getctag>${xmlEscape(ctx.etag)}</CS:getctag>` : '';
    case 'sync-token':
      return ctx.etag ? `<D:sync-token>${xmlEscape(ctx.etag)}</D:sync-token>` : '';
    case 'calendar-color':
      return `<A:calendar-color>${ctx.color || '#FF9500FF'}</A:calendar-color>`;
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
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''));
  const accept = String(res.req?.headers['accept-encoding'] || '');
  const extra = { ...headers };
  if (buf.length > 1024 && status !== 304 && /\bgzip\b/i.test(accept)) {
    buf = gzipSync(buf);
    extra['Content-Encoding'] = 'gzip';
    extra.Vary = 'Accept-Encoding';
  }
  res.writeHead(status, {
    ...baseHeaders(),
    'Content-Length': buf.length,
    ...extra,
  });
  res.end(buf);
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
  if (parts[0] === 'principals' && parts.length === 2) return { kind: 'principal', account: parts[1] };
  if (parts[0] === 'calendars' && parts.length >= 2) {
    const account = parts[1];
    if (parts.length === 2) return { kind: 'home', account };
    if (parts.length === 3 && parts[2] === 'timetable') return { kind: 'calendar', account };
    if (parts.length === 3 && parts[2] === 'timetable.ics') return { kind: 'feed', account };
    if (parts.length === 3 && parts[2].startsWith('course-') && parts[2].endsWith('.ics')) {
      return { kind: 'feed', account, course: parts[2].slice(7, -4) };
    }
    if (parts.length === 3 && parts[2].startsWith('course-')) {
      return { kind: 'calendar', account, course: parts[2].slice(7) };
    }
    if (parts.length === 4 && parts[3].endsWith('.ics')) {
      const hash = parts[3].slice(0, -4);
      if (parts[2] === 'timetable') return { kind: 'event', account, hash };
      if (parts[2].startsWith('course-')) return { kind: 'event', account, course: parts[2].slice(7), hash };
    }
  }
  return { kind: 'notfound' };
}

function etagMatches(req, etag) {
  const header = String(req.headers['if-none-match'] || '');
  return header.split(',').map(s => s.trim().replace(/^W\//, '')).includes(etag);
}

async function handlePropfind(req, res, user, path, url) {
  if (path.kind === 'notfound') return send404(res);
  const depth = String(req.headers.depth || '0').toLowerCase();
  const deep = depth === '1' || depth === 'infinity';
  const body = await readBody(req);
  if (DEBUG) {
    console.log(`[caldav] PROPFIND ${path.kind} depth=${depth} ua=${JSON.stringify(req.headers['user-agent'] || '')}\n${body}`);
  }
  const requested = requestedProps(body);
  const paths = pathsFor(user);
  const account = user.account;

  const expand = expandEventsFor(req);
  let cal = null;
  if (['calendar', 'event', 'feed'].includes(path.kind) || (path.kind === 'home' && deep)) {
    cal = await calendarData(user, expand);
  }
  const calendarName = cal?.calendarName || CALENDAR_NAME;
  const course = path.course ? cal?.courses.find(c => c.slug === path.course) : null;
  const calEvents = course ? course.events : (cal?.events || []);
  const calEtag = course ? course.etag : cal?.etag;
  const calDisplayName = course ? course.name : calendarName;
  const calColor = course ? course.color : '#FF9500FF';

  const responses = [];
  const add = (href, ctx) => responses.push(responseXml(href, propsFor({ ...ctx, paths, account }, requested)));

  switch (path.kind) {
    case 'root':
      add(url.pathname === '/' ? '/' : '/caldav/', { kind: 'root', displayname: 'CalDAV' });
      if (deep) add(paths.principal, { kind: 'principal', displayname: account });
      break;
    case 'principal':
      add(paths.principal, { kind: 'principal', displayname: account });
      if (deep) add(paths.home, { kind: 'home', displayname: '日历' });
      break;
    case 'home':
      add(paths.home, { kind: 'home', displayname: '日历' });
      if (deep) {
        if (expand) {
          // OPPO：每门课一个日历，单次同步数据量更小
          for (const c of cal?.courses || []) {
            add(`${paths.home}course-${c.slug}/`, {
              kind: 'calendar',
              displayname: c.name,
              description: c.name,
              etag: c.etag,
              lastModified: cal.lastModified,
              color: c.color,
            });
          }
        } else {
          // 其他客户端：一个课表合集，事件级颜色/分类
          add(paths.calendar, {
            kind: 'calendar',
            displayname: calendarName,
            description: calendarName,
            etag: cal?.etag,
            lastModified: cal?.lastModified,
            color: '#FF9500FF',
          });
        }
      }
      break;
    case 'calendar':
    case 'feed': {
      if (path.course && !course) return send404(res);
      add(path.course ? `${paths.home}course-${course.slug}/` : paths.calendar, {
        kind: 'calendar',
        displayname: calDisplayName,
        description: calDisplayName,
        etag: calEtag,
        lastModified: cal.lastModified,
        color: calColor,
      });
      if (deep) {
        for (const e of calEvents) add(e.href, { kind: 'event', displayname: e.summary, etag: e.etag, lastModified: cal.lastModified });
      }
      break;
    }
    case 'event': {
      const e = calEvents.find(x => x.hash === path.hash);
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
  const course = path.course ? cal.courses.find(c => c.slug === path.course) : null;
  if (path.course && !course) return send404(res);
  const events = course ? course.events : cal.events;
  const token = course ? course.etag : cal.etag;

  const wants = [];
  if (/getetag/i.test(body)) wants.push('getetag');
  if (/getcontenttype/i.test(body)) wants.push('getcontenttype');
  if (/schedule-tag/i.test(body)) wants.push('schedule-tag');
  if (/calendar-data/i.test(body)) wants.push('calendar-data');
  if (/calendar-query/i.test(body) && !wants.includes('calendar-data')) wants.push('calendar-data');
  if (!wants.length) wants.push('getetag', 'calendar-data');

  const eventXml = e => {
    const props = wants.map(name => {
      if (name === 'getetag') return `<D:getetag>${xmlEscape(e.etag)}</D:getetag>`;
      if (name === 'getcontenttype') return '<D:getcontenttype>text/calendar; charset=utf-8</D:getcontenttype>';
      if (name === 'schedule-tag') return `<C:schedule-tag>${xmlEscape(e.etag)}</C:schedule-tag>`;
      return `<C:calendar-data>${xmlEscape(e.ics)}</C:calendar-data>`;
    }).join('');
    return `<D:response><D:href>${xmlEscape(e.href)}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
  };
  const notFoundXml = href => `<D:response><D:href>${xmlEscape(href)}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`;

  if (/sync-collection/i.test(body)) {
    return sendXml(res, multistatusWithToken(events.map(eventXml), token));
  }

  if (/calendar-multiget/i.test(body)) {
    const norm = href => {
      try { return decodeURIComponent(new URL(href, 'http://caldav.local').pathname); }
      catch { return href; }
    };
    const wanted = [...new Set([...body.matchAll(/<(?:\w+:)?href[^>]*>([^<]+)<\/(?:\w+:)?href>/gi)].map(m => norm(m[1].trim())))];
    if (wanted.length) {
      const byHref = new Map(events.map(e => [norm(e.href), e]));
      return sendXml(res, multistatus(wanted.map(href => byHref.has(href) ? eventXml(byHref.get(href)) : notFoundXml(href))));
    }
  }

  sendXml(res, multistatus(events.map(eventXml)));
}

async function handleGet(req, res, user, path) {
  const head = req.method === 'HEAD';
  const cal = await calendarData(user, expandEventsFor(req));
  const course = path.course ? cal.courses.find(c => c.slug === path.course) : null;
  if (path.course && !course) return send404(res);

  if (path.kind === 'calendar' || path.kind === 'feed') {
    const ics = course ? course.ics : cal.fullIcs;
    const etag = course ? course.etag : cal.etag;
    if (etagMatches(req, etag)) return sendNotModified(res, etag);
    return sendIcs(res, ics, etag, cal.lastModified, head);
  }

  if (path.kind === 'event') {
    const events = course ? course.events : cal.events;
    const e = events.find(x => x.hash === path.hash);
    if (!e) return send404(res);
    if (etagMatches(req, e.etag)) return sendNotModified(res, e.etag);
    return sendIcs(res, e.ics, e.etag, cal.lastModified, head);
  }

  return send404(res);
}

async function handleFeed(req, res, token) {
  const row = db.getCalDavTokenByHash(hashToken(token));
  const user = row ? db.getUserById(row.user_id) : null;
  if (!row || !user || user.disabled) return sendText(res, 401, '订阅 token 无效或已撤销');
  db.touchCalDavToken(row.id);

  const cal = await calendarData(user, expandEventsFor(req));
  const head = req.method === 'HEAD';
  if (etagMatches(req, cal.etag)) return sendNotModified(res, cal.etag);
  return sendIcs(res, cal.fullIcs, cal.etag, cal.lastModified, head);
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

  if (DEBUG && /OPPO/i.test(String(req.headers['user-agent'] || ''))) {
    const debugPath = url.pathname.startsWith('/caldav/feed/')
      ? '/caldav/feed/<redacted>.ics'
      : url.pathname;
    console.log(`[caldav] OPPO ${method} ${debugPath} accept-encoding=${req.headers['accept-encoding'] || '-'}`);
  }

  if (method === 'OPTIONS') return handleOptions(res);

  // /caldav/feed/<token>.ics：把 CalDAV token 放进路径，供只接受“订阅 URL”
  // 的客户端（如 Apple 日历）直接拉取整表，不需要 Basic 认证。
  const feed = url.pathname.match(/^\/caldav\/feed\/([^/]+)\.ics$/);
  if (feed) {
    if (method !== 'GET' && method !== 'HEAD') {
      return sendText(res, 405, '只读订阅', { Allow: 'GET, HEAD' });
    }
    return handleFeed(req, res, decodeURIComponent(feed[1]));
  }

  const auth = await authenticate(req);
  if (auth.error) {
    const [status, message] = auth.error;
    const challenge = auth.scheme === 'Bearer'
      ? 'Bearer error="invalid_token"'
      : 'Basic realm="强智 Gateway CalDAV", charset="UTF-8"';
    res.setHeader('WWW-Authenticate', challenge);
    return sendText(res, status, message);
  }

  const path = resolvePath(url);

  // 只能访问自己的 principal / calendar
  if (path.account && path.account !== auth.user.account) return send404(res);

  if (method === 'PROPFIND') return handlePropfind(req, res, auth.user, path, url);
  if (method === 'REPORT') return handleReport(req, res, auth.user, path);
  if (method === 'GET' || method === 'HEAD') return handleGet(req, res, auth.user, path);

  if (['PUT', 'DELETE', 'MKCALENDAR', 'PROPPATCH', 'COPY', 'MOVE'].includes(method)) {
    return sendText(res, 405, '只读 CalDAV', { Allow: 'OPTIONS, GET, HEAD, PROPFIND, REPORT' });
  }
  return sendText(res, 405, '不支持的方法', { Allow: 'OPTIONS, GET, HEAD, PROPFIND, REPORT' });
}
