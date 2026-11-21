// 探测 jwglxt 的移动端 App API（/app.do?method=authUser）。
// 公开资料里的用法：GET /app.do?method=authUser&xh=&pwd= 返回 token，
// 之后请求带 header `token: <token>`。部分学校的接口未授权/已关闭。
import { BASE, UA } from '../server/jwxt/login.mjs';

const account = process.env.JWXT_ACCOUNT;
const password = process.env.JWXT_PASSWORD;
if (!account || !password) {
  console.error('缺少 JWXT_ACCOUNT / JWXT_PASSWORD（见 .env.example）');
  process.exit(1);
}

// 智校园 App 抓包得到的 UA（2019 版）
const APP_UA = 'Mozilla/5.0 (Linux; U; Mobile; Android 6.0.1;C107-9 Build/FRF91 )';
const q = 'method=authUser&xh=' + encodeURIComponent(account) + '&pwd=' + encodeURIComponent(password);

function summarize(text) {
  const flag = text.match(/var flag='(\d+)'/)?.[1];
  if (/^\s*[{[]/.test(text.trim())) {
    try {
      const j = JSON.parse(text);
      return { json: true, keys: Object.keys(j), flag: j.flag, msg: j.msg, token: j.token ? String(j.token).slice(0, 12) + '…' : undefined };
    } catch { /* fall through */ }
  }
  const tail = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return { json: false, flag, msg: tail.slice(tail.lastIndexOf('}') + 1).trim() };
}

// 关键：服务端是按 Referer 区分“App 请求”的，UA 不影响结果。
//   外部 Referer（如 http://www.baidu.com，SHST 公开客户端就是这么写的） -> flag=3 未被授权的应用请求
//   无 Referer / 同源 Referer                                      -> flag=1 用户没有登录
for (const [name, headers] of [
  ['无 Referer', { 'User-Agent': APP_UA }],
  ['外部 Referer(baidu)', { 'User-Agent': APP_UA, Referer: 'http://www.baidu.com' }],
  ['同源 Referer', { 'User-Agent': APP_UA, Referer: BASE + '/' }],
  ['浏览器 UA + 无 Referer', { 'User-Agent': UA }],
]) {
  try {
    const r = await fetch(`${BASE}/app.do?${q}`, { headers });
    const t = await r.text();
    console.log(`\n== ${name} ==`);
    console.log('status:', r.status, '| ctype:', r.headers.get('content-type'), '| len:', t.length);
    console.log(summarize(t));
  } catch (e) {
    console.log(`\n== ${name} ==\nERR ${e.message}`);
  }
}

// 旧移动端主机（2026-11 实测 502）：
//   http://jwgl.sdust.edu.cn/app.do
