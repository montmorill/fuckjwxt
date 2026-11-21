// Probe the Qiangzhi (强智) Logon.do flow used by https://jwglxt.sdust.edu.cn/
//
// 凭据来源（二选一）：
//   1) 项目根目录的 .env（复制 .env.example 后填写 JWXT_ACCOUNT / JWXT_PASSWORD）
//   2) 命令行参数：node tools/probe-login.mjs <账号> <密码>
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
for (const p of [resolve(here, '../.env'), resolve(here, '.env')]) {
  if (existsSync(p)) {
    try { process.loadEnvFile(p); } catch (e) { console.warn('读取 .env 失败:', p, e.message); }
    break;
  }
}

const BASE = (process.env.JWXT_BASE_URL || 'https://jwglxt.sdust.edu.cn').replace(/\/+$/, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const account = process.argv[2] ?? process.env.JWXT_ACCOUNT;
const password = process.argv[3] ?? process.env.JWXT_PASSWORD;
if (!account || !password) {
  console.error('缺少账号或密码。请复制 .env.example 为 .env 并填写，或：');
  console.error('  node tools/probe-login.mjs <账号> <密码>');
  process.exit(1);
}

class Jar {
  constructor() { this.map = new Map(); }
  absorb(res) {
    const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const sc of list) {
      const [pair] = sc.split(';');
      const idx = pair.indexOf('=');
      this.map.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  header() { return [...this.map].map(([k, v]) => `${k}=${v}`).join('; '); }
}

const jar = new Jar();
const baseHeaders = () => ({
  'User-Agent': UA,
  'Cookie': jar.header(),
  'Referer': BASE + '/',
  'Origin': BASE,
});

async function step(name, url, opts = {}) {
  const res = await fetch(url, { redirect: 'manual', ...opts, headers: { ...baseHeaders(), ...(opts.headers || {}) } });
  jar.absorb(res);
  const body = await res.text();
  console.log(`\n--- ${name} ---`);
  console.log('status:', res.status, '| location:', res.headers.get('location'));
  console.log('set-cookie:', res.headers.getSetCookie?.().join(' || ') || '(none)');
  console.log("body[:400]:", JSON.stringify(body.slice(0, 400)));
  return { res, body };
}

// 1) landing page (establishes session)
await step('GET /', BASE + '/');

// 2) get scode#sxh
const { body: sess } = await step('POST /Logon.do?method=logon&flag=sess', BASE + '/Logon.do?method=logon&flag=sess', { method: 'POST', body: '' });

// 3) encode exactly like the page's loginajax()
const codeDogSequence = ' ';
const code = `${account}%%%${password}%%%${codeDogSequence}`;
const [scode, sxh] = sess.split('#');
if (!scode || !sxh) { console.error('unexpected sess payload'); process.exit(1); }
console.log(`\ncode length=${code.length} scode length=${scode.length} sxh length=${sxh.length}`);
const sxhSum = [...sxh].reduce((a, d) => a + Number(d), 0);
console.log(`sxh digit sum=${sxhSum} (should equal scode length)`);

let remaining = scode, encoded = '';
for (let i = 0; i < code.length; i++) {
  if (i < 55) {
    encoded += code[i] + remaining.slice(0, Number(sxh[i]));
    remaining = remaining.slice(Number(sxh[i]));
  } else {
    encoded += code.slice(i);
    break;
  }
}
console.log(`encoded length=${encoded.length} (内容含密码字符，已省略)`);

// 4) submit the login form
const form = new URLSearchParams();
form.set('loginMethod', 'logon');
form.set('userlanguage', '0');
form.set('userAccount', account);
form.set('userPassword', '');
form.set('encoded', encoded);
const final = await step('POST /Logon.do?method=logon', BASE + '/Logon.do?method=logon', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: form.toString(),
});

// 结果判定
const msg = final.body.match(/id="showMsg">([^<]*)</)?.[1];
const loc = final.res.headers.get('location');
console.log('\n=== 结果 ===');
if (final.res.status >= 300 && final.res.status < 400) {
  console.log('✅ 登录成功，跳转到:', loc);
} else if (msg) {
  console.log('❌ 登录失败:', msg);
} else {
  console.log(`⚠️ 未识别：status=${final.res.status}，页面 ${final.body.length} 字节（可能就是登录后首页）`);
}

// 其他可能的服务端提示
const interesting = final.body.match(/[^\n]*(alert|提示|错误|验证码|锁定|失败|logonError)[^\n]*/gi) || [];
if (interesting.length) {
  console.log('\n=== 页面中的提示文本 ===');
  for (const l of interesting.slice(0, 10)) console.log(l.trim().slice(0, 200));
}
