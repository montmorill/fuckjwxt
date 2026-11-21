import { connect, getSemesters, getWeekRange, getTimetable, getGrades, getExams, getTextbooks, getPlanCourses, getStudentInfo, getMessages, getNotices, getCalendar } from '../tools/jwxt_api.mjs';
import { request } from '../tools/jwxt.mjs';
import { config } from './config.mjs';
import { decrypt } from './crypto.mjs';

const sessions = new Map();   // userId -> { session, expiresAt, verifiedAt }
const inflight = new Map();   // userId -> Promise
const VERIFY_MS = 5 * 60_000;

async function sessionLooksValid(session) {
  try {
    const r = await request(session.jar, session.base + '/jsxsd/framework/xsMainV.htmlx');
    return r.status === 200 && !/欢迎登录教务系统|id="showMsg"/.test(r.text);
  } catch {
    return false;
  }
}

export function clearSession(userId) { sessions.delete(userId); }
export function clearAllSessions() { sessions.clear(); inflight.clear(); }

async function loginUser(user) {
  const password = decrypt(user.password_enc);
  return connect({
    account: user.account,
    password,
    baseUrl: user.base_url || config.jwxtBaseUrl,
  });
}

export async function getSession(user) {
  const hit = sessions.get(user.id);
  if (hit && hit.expiresAt > Date.now()) {
    if (Date.now() - hit.verifiedAt < VERIFY_MS) return hit.session;
    // 缓存超过 5 分钟：轻量验证一下，失效则重新登录
    if (await sessionLooksValid(hit.session)) {
      hit.verifiedAt = Date.now();
      return hit.session;
    }
    sessions.delete(user.id);
  }
  if (inflight.has(user.id)) return inflight.get(user.id);

  const p = loginUser(user)
    .then(session => {
      sessions.set(user.id, {
        session,
        expiresAt: Date.now() + config.sessionTtlMs,
        verifiedAt: Date.now(),
      });
      return session;
    })
    .finally(() => inflight.delete(user.id));
  inflight.set(user.id, p);
  return p;
}

// 数据接口失败时丢弃会话，自动重新登录并重试一次
export async function withSession(user, fn) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    const session = await getSession(user);
    try {
      return await fn(session);
    } catch (e) {
      sessions.delete(user.id);
      last = e;
    }
  }
  throw last;
}

export async function verifyCredentials({ account, password, baseUrl }) {
  await connect({ account, password, baseUrl: baseUrl || config.jwxtBaseUrl });
  return true;
}

export const jwxt = {
  semesters: user => withSession(user, s => getSemesters(s)),
  weekRange: (user, semester) => withSession(user, s => getWeekRange(s, semester)),
  timetable: (user, opts) => withSession(user, s => getTimetable(s, opts)),
  calendar: (user, semester) => withSession(user, async s => {
    const html = await getCalendar(s, semester);
    if (!/第1周/.test(html)) throw new Error('教学周历无效（可能会话过期）');
    return html;
  }),
  grades: (user, opts) => withSession(user, s => getGrades(s, opts)),
  exams: (user, opts) => withSession(user, s => getExams(s, opts)),
  textbooks: user => withSession(user, s => getTextbooks(s)),
  planCourses: user => withSession(user, s => getPlanCourses(s)),
  messages: user => withSession(user, s => getMessages(s)),
  notices: user => withSession(user, s => getNotices(s)),
  profile: user => withSession(user, async s => {
    const rows = await getStudentInfo(s);
    const r = rows[0] || {};
    return {
      studentId: r.f1 ?? null,
      name: r.f3 ?? null,
      gender: r.f11 ?? null,
      college: r.yx_mc ?? null,
      major: r.zy_mc ?? null,
      className: r.f9 ?? null,
      grade: r.f10 ?? null,
    };
  }),
};
