// Authenticated jwglxt API client (read-only endpoints verified 2026-11-21).
import { login, request, BASE, UA } from './login.mjs';

const XHR = { 'X-Requested-With': 'XMLHttpRequest' };

export async function connect(opts = {}) {
  const { jar, location, baseUrl } = await login(opts);
  const base = (baseUrl || BASE).replace(/\/+$/, '');
  let r = await request(jar, location);
  if (r.location) await request(jar, new URL(r.location, location).href);
  const get = (path, o = {}) =>
    request(jar, base + path, { ...o, headers: { ...XHR, ...(o.headers || {}) } });
  const getText = async p => (await get(p)).text;
  const getJson = async p => JSON.parse(await getText(p));
  return { base, jar, get, getText, getJson };
}

// 常见 HTML 实体解码（按项目里实际会出现的字符集，够用且不引入依赖）
const decodeEntities = s => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&nbsp;/gi, ' ')
  .replace(/&lt;/gi, '<')
  .replace(/&gt;/gi, '>')
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&amp;/gi, '&');

const strip = s => decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// ---- 学期 ----
export async function getSemesters(s) {
  const html = await s.getText('/jsxsd/xskb/xskb_list.do?viweType=0');
  const block = html.match(/<select[^>]*id="xnxq01id"[\s\S]*?<\/select>/i)?.[0] ?? '';
  return [...block.matchAll(/<option value="([^"]+)"([^>]*)>([^<]*)<\/option>/g)].map(m => ({
    value: m[1], label: m[3].trim(), selected: /selected/.test(m[2]),
  }));
}

// 教学周范围（该学期共几周）
export async function getWeekRange(s, semester) {
  const j = await s.getJson('/jsxsd/xskb/jxzlzc_xnxq_ajax?xnxq01id=' + encodeURIComponent(semester));
  return Array.isArray(j) ? j[0] : j;
}

// ---- 课表 ----
function parseCourseDetail(detailHtml, detailText) {
  // 老师/时间/地点只在 abbrinfo 这个 span 里；分开取可避免 linkSpan 等文本混进来
  const abbrHtml = detailHtml.match(/<span[^>]*qz-hasCourse-abbrinfo[^>]*>([\s\S]*?)<\/span>/i)?.[1];
  const abbr = strip(abbrHtml ?? detailText);
  const timeText = abbr.match(/时间[:：]\s*([^;]*)/)?.[1]?.trim() ?? '';
  const pick = (src, label) => src.match(new RegExp(label + '[:：]\\s*([^;]*)'))?.[1]?.trim() ?? '';
  return {
    teacher: pick(abbr, '老师'),
    timeText,
    weeks: timeText.match(/^([^\[]*?)周/)?.[1]?.trim() ?? '',
    periods: timeText.match(/\[([^\]]*)\]/)?.[1]?.trim() ?? '',
    location: pick(abbr, '地点'),
    courseCode: detailText.match(/课程编号[:：]\s*([^\s;]+)/)?.[1]?.trim() ?? '',
    className: pick(detailText, '班级'),
    students: pick(detailText, '总人数'),
    examType: pick(detailText, '考核方式'),
    hours: pick(detailText, '总学时'),
  };
}

export function parseTimetable(html) {
  const table = html.match(/<table[^>]*class="[^"]*qz-weeklyTable[^"]*"[\s\S]*?<\/table>/i)?.[0];
  if (!table) return [];
  const out = [];
  for (const row of table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rowHtml = row[1];
    const period = strip(rowHtml.match(/<td[^>]*name="timeTd"[^>]*>([\s\S]*?)<\/td>/i)?.[1] ?? '');
    let day = 0;
    for (const td of rowHtml.matchAll(/<td([^>]*)name="kbDataTd"([^>]*)>([\s\S]*?)<\/td>/gi)) {
      day++;
      for (const li of td[3].matchAll(/<li[^>]*class="[^"]*courselists-item[^"]*"[\s\S]*?<\/li>/gi)) {
        const name = strip(li[0].match(/class="[^"]*qz-hasCourse-title[^"]*"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? '');
        // 详情分散在多个 span（abbrinfo / kchSpan / dealeSpan / fzmSpan）。
        // rawHtml 保留原始内 HTML（含 href/src/实体等），rawText 是解码后的纯文本，解析用 rawText。
        const detailHtml = li[0].match(/<p[^>]*class="[^"]*qz-hasCourse-detaillists[^"]*"[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? '';
        const detailText = strip(detailHtml);
        if (name) out.push({ day, period, name, ...parseCourseDetail(detailHtml, detailText), rawHtml: detailHtml.trim(), rawText: detailText });
      }
    }
  }
  return out;
}

export async function getTimetable(s, { semester, week } = {}) {
  const q = new URLSearchParams({ viweType: '0' });
  if (semester) q.set('xnxq01id', semester);
  if (week) q.set('zc', String(week));
  return parseTimetable(await s.getText('/jsxsd/xskb/xskb_list.do?' + q));
}

// ---- 成绩 ----
export async function getGrades(s, { semester = '', courseName = '', bestOnly = true } = {}) {
  const q = new URLSearchParams({
    pageNum: '1', pageSize: '1000', kksj: semester, kcxz: '', kcsx: '', kcmc: courseName,
    xsfs: bestOnly ? 'max' : 'all', sfxsbcxq: '1', fxkcmc: '', zxsbjg: '',
  });
  const j = await s.getJson('/jsxsd/kscj/cjcx_list?' + q);
  return { code: j.code, count: j.count, data: j.data || [], meta: { tjsj: j.tjsj, pjxfjdts: j.pjxfjdts } };
}

// ---- 考试 ----
export async function getExams(s, { semester = '' } = {}) {
  const base = { pageNum: '1', pageSize: '200', xnxqid: semester };
  const final = await s.getJson('/jsxsd/xsks/xsksap_list?' + new URLSearchParams({ ...base, xqlb: '' }));
  const courseEnd = await s.getJson('/jsxsd/xsks/xsstk_list?' + new URLSearchParams(base));
  return { final: final.data || [], courseEnd: courseEnd.data || [] };
}

// ---- 教材 ----
export async function getTextbooks(s) {
  const j = await s.getJson('/jsxsd/jcgl/bjjcdg_query?reqType=listData');
  return j.data || [];
}

// 教材订购计划（注意参数名是 xnxqid，不是 xnxq01id；可能返回“不在控制时间内!”）
export async function getTextbookPlan(s, { semester = '' } = {}) {
  const q = new URLSearchParams({ reqType: 'listData', xnxqid: semester, kcfx: '' });
  const j = await s.getJson('/jsxsd/jcgl/jcjhcx_list?' + q);
  return { message: j.msg, data: j.data || [] };
}

// 执行计划（这个接口必须 POST 表单参数，GET 只会返回页面）
export async function getExecutionPlan(s, { semester = '' } = {}) {
  const body = new URLSearchParams({ kkxq: semester, kcxx: '', pageNum: '1', pageSize: '500' });
  const r = await s.get('/jsxsd/pyfa/pyfa_query?islist=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const j = JSON.parse(r.text);
  return { count: j.count, data: j.data || [] };
}

// ---- 调停课 ----
export async function getSuspendAdjust(s, { semester = '' } = {}) {
  const q = new URLSearchParams({ pageNum: '1', pageSize: '100', xnxq01id: semester });
  const j = await s.getJson('/jsxsd/xskb/loadTtkMxList?' + q);
  return j.data || [];
}

// ---- 培养方案课程清单（需要学号，分页每页 20，毕业前共约 90 门） ----
export async function getPlanCourses(s, { pageSize = 20 } = {}) {
  const info = await getStudentInfo(s);
  const xh = info[0]?.f1;
  if (!xh) throw new Error('无法从学籍接口获取学号');
  const out = [];
  for (let page = 1; page <= 100; page++) {
    const q = new URLSearchParams({ xs0101id: xh, fx: '', pageNum: String(page), pageSize: String(pageSize) });
    const j = await s.getJson('/jsxsd/jlsgl/toPyfakclist.do?' + q);
    const data = j.data || [];
    out.push(...data);
    if (!data.length || out.length >= Number(j.count || 0)) break;
  }
  return out;
}

// ---- 毕业审核（type: 1=要素点 2=学位 3=计划内? 4=已修/计划课程；type=4 有数据） ----
export async function getGraduationAudit(s, type = 4) {
  const map = { 1: 'yxsd', 2: 'yxwd', 3: 'yxjhn', 4: 'yxjhw' };
  const id = map[type] || 'yxjhw';
  const j = await s.getJson(`/jsxsd/bygl/bygl_ckxsList_${id}?type=${type}&bs=list&pageNum=1&pageSize=200`);
  return j.data || [];
}

// ---- 教学进程（POST；当前账号返回 data:[]，zc=20） ----
export async function getTeachingProgress(s, semester) {
  const r = await s.get('/jsxsd/pyfa/pyfajc_query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ xnxq: semester, type: 'seach' }).toString(),
  });
  return JSON.parse(r.text);
}

// ---- 学籍 ----
export async function getStudentInfo(s) {
  const j = await s.getJson('/jsxsd/xsxj/xjxxgl.do?type=list');
  return j.data || [];
}

// ---- 消息 / 公告 ----
export async function getMessages(s, { page = 1, size = 50 } = {}) {
  const j = await s.getJson(`/jsxsd/ggly/xxtz_query?type=list&pageNum=${page}&pageSize=${size}`);
  return { count: j.count, data: j.data || [] };
}

export async function getNotices(s, { page = 1, size = 50 } = {}) {
  const j = await s.getJson(`/jsxsd/ggly/ysgg_query?type=list&pageNum=${page}&pageSize=${size}`);
  return { count: j.count, data: j.data || [] };
}

// ---- HTML 型数据页 ----
export const getCalendar = (s, semester) =>
  s.getText('/jsxsd/jxzl/jxzl_query?xnxq01id=' + encodeURIComponent(semester));
export const getTrainingPlan = s => s.getText('/jsxsd/pyfa/topyfamx');
export const getCreditProgress = s => s.getText('/jsxsd/xxwcqk/xxwcqkOnkctx.do?isdb=0');
export const getClassrooms = s => s.getText('/jsxsd/kbxx/jsjy_query');

// ---- 照片（二进制，需用 arrayBuffer 读取） ----
export async function getPhotoBytes(s) {
  const res = await fetch(s.base + '/jsxsd/grxx/xszpLoad', {
    headers: { 'User-Agent': UA, Cookie: s.jar.header() },
  });
  s.jar.absorb(res);
  return { contentType: res.headers.get('content-type'), bytes: Buffer.from(await res.arrayBuffer()) };
}

// CLI: node server/jwxt/api.mjs
if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const s = await connect();
  const semesters = await getSemesters(s);
  const cur = semesters.find(x => x.selected)?.value || semesters[0]?.value;
  console.log('学期:', semesters.map(x => x.value + (x.selected ? '*' : '')).join(', '), '| 当前:', cur);

  const tt = await getTimetable(s, { semester: cur });
  console.log(`\n课表: ${tt.length} 条`);
  for (const c of tt.slice(0, 6)) console.log(`  周${c.day} ${c.period} ${c.name} | ${c.teacher} | ${c.timeText} | ${c.location}`);

  const grades = await getGrades(s);
  console.log(`\n成绩: count=${grades.count}`);

  const exams = await getExams(s, { semester: cur });
  console.log(`考试: 期末=${exams.final.length} 结课=${exams.courseEnd.length}`);
  for (const e of exams.courseEnd) console.log(`  ${e.kssj} ${e.kc_mc} ${e.js_mc}`);

  const books = await getTextbooks(s);
  console.log(`\n教材: ${books.length} 本`);
  for (const b of books) console.log(`  ${b.kcmc} -> ${b.jcmc}`);

  const plan = await getExecutionPlan(s, { semester: cur });
  console.log(`\n执行计划: ${plan.count} 门`);
  for (const c of plan.data.slice(0, 5)) console.log(`  ${c.kch} ${c.kc_mc} ${c.xf}学分 ${c.khlb_mc}`);

  const msgs = await getMessages(s);
  const notices = await getNotices(s);
  console.log(`\n消息: ${msgs.count} 公告: ${notices.count}`);
}
