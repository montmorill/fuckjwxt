// Does repeated failure trigger a captcha / lockout? What does logonLdap expect?
const BASE = 'https://jwglxt.sdust.edu.cn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

class Jar {
  constructor() { this.map = new Map(); }
  absorb(res) {
    for (const sc of (res.headers.getSetCookie?.() || [])) {
      const [p] = sc.split(';'); const i = p.indexOf('=');
      this.map.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
    }
  }
  header() { return [...this.map].map(([k, v]) => `${k}=${v}`).join('; '); }
}

async function req(jar, url, opts = {}) {
  const res = await fetch(url, { redirect: 'manual', ...opts, headers: { 'User-Agent': UA, 'Referer': BASE + '/', ...(jar ? { Cookie: jar.header() } : {}), ...(opts.headers || {}) } });
  if (jar) jar.absorb(res);
  return { res, body: await res.text() };
}

function encode(scode, sxh, account, password) {
  const code = `${account}%%%${password}%%% `;
  let rest = scode, out = '';
  for (let i = 0; i < code.length; i++) {
    if (i < 55) { out += code[i] + rest.slice(0, +sxh[i]); rest = rest.slice(+sxh[i]); }
    else { out += code.slice(i); break; }
  }
  return out;
}

const jar = new Jar();
await req(jar, BASE + '/');

for (let n = 1; n <= 7; n++) {
  const s = await req(jar, BASE + '/Logon.do?method=logon&flag=sess', { method: 'POST' });
  const [scode, sxh] = s.body.split('#');
  const form = new URLSearchParams({ loginMethod: 'logon', userlanguage: '0', userAccount: '202000000000', userPassword: '', encoded: encode(scode, sxh, '202000000000', 'wrong' + n) });
  const r = await req(jar, BASE + '/Logon.do?method=logon', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  const msg = r.body.match(/id="showMsg">([^<]*)</)?.[1] ?? '';
  const hasCaptcha = /SafeCodeImg|randcode|verifycode|验证码/.test(r.body);
  const captchaInput = r.body.match(/<input[^>]*(randcode|code|verif)[^>]*>/i)?.[0] ?? '';
  console.log(`fail #${n}: status=${r.res.status} msg=${JSON.stringify(msg)} captchaMarkup=${hasCaptcha} input=${JSON.stringify(captchaInput)}`);
}

console.log('\n--- final login page captcha markers ---');
const p = await req(jar, BASE + '/');
for (const m of p.body.matchAll(/[^\n]*(verifycode|SafeCodeImg|randcode|验证码)[^\n]*/gi)) console.log(m[0].trim().slice(0, 200));

console.log('\n--- logonLdap: what fields? try with randcode ---');
const s2 = await req(jar, BASE + '/Logon.do?method=logon&flag=sess', { method: 'POST' });
const [sc, sx] = s2.body.split('#');
for (const extra of [{}, { randcode: '1234' }, { verifycode: '1234' }, { captcha: '1234' }]) {
  const form = new URLSearchParams({ loginMethod: 'logonLdap', userlanguage: '0', userAccount: '202000000000', userPassword: 'wrongpass', ...extra });
  const r = await req(jar, BASE + '/Logon.do?method=logonLdap', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() });
  const msg = r.body.match(/id="showMsg">([^<]*)</)?.[1] ?? '';
  console.log('logonLdap', JSON.stringify(extra), '->', r.res.status, JSON.stringify(msg), 'loc=' + (r.res.headers.get('location') || '-'));
}
