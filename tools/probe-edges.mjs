// Edge-case probes for the Qiangzhi Logon.do flow.
const BASE = 'https://jwglxt.sdust.edu.cn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

class Jar {
  constructor() { this.map = new Map(); }
  absorb(res) {
    for (const sc of (res.headers.getSetCookie?.() || [])) {
      const [pair] = sc.split(';'); const i = pair.indexOf('=');
      this.map.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  header() { return [...this.map].map(([k, v]) => `${k}=${v}`).join('; '); }
  clone() { const j = new Jar(); j.map = new Map(this.map); return j; }
}

function encode(scode, sxh, account, password, dog = ' ') {
  const code = `${account}%%%${password}%%%${dog}`;
  let rest = scode, out = '';
  for (let i = 0; i < code.length; i++) {
    if (i < 55) { out += code[i] + rest.slice(0, +sxh[i]); rest = rest.slice(+sxh[i]); }
    else { out += code.slice(i); break; }
  }
  return out;
}

async function req(jar, url, opts = {}) {
  const res = await fetch(url, { redirect: 'manual', ...opts, headers: { 'User-Agent': UA, 'Referer': BASE + '/', ...(jar ? { Cookie: jar.header() } : {}), ...(opts.headers || {}) } });
  if (jar) jar.absorb(res);
  const body = await res.text();
  return { res, body };
}

const show = (label, r) => {
  const msg = r.body.match(/id="showMsg">([^<]*)</)?.[1] ?? '';
  const title = r.body.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '';
  console.log(`${label}: status=${r.res.status} loc=${r.res.headers.get('location') || '-'} title=${JSON.stringify(title)} showMsg=${JSON.stringify(msg)} len=${r.body.length}`);
};

const account = '202000000000', password = 'not-a-real-password';

// A) baseline (GET landing, POST sess, POST logon, same jar)
{
  const jar = new Jar();
  await req(jar, BASE + '/');
  const s = await req(jar, BASE + '/Logon.do?method=logon&flag=sess', { method: 'POST' });
  const [scode, sxh] = s.body.split('#');
  console.log('\n[A] baseline sess payload:', JSON.stringify(s.body));
  const form = new URLSearchParams({ loginMethod: 'logon', userlanguage: '0', userAccount: account, userPassword: '', encoded: encode(scode, sxh, account, password) });
  show('[A] logon', await req(jar, BASE + '/Logon.do?method=logon', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() }));
}

// B) sess via GET
{
  const jar = new Jar();
  await req(jar, BASE + '/');
  const s = await req(jar, BASE + '/Logon.do?method=logon&flag=sess', { method: 'GET' });
  console.log('\n[B] GET sess body:', JSON.stringify(s.body.slice(0, 160)));
}

// C) sess twice in one session, then use the FIRST scode
{
  const jar = new Jar();
  await req(jar, BASE + '/');
  const s1 = await req(jar, BASE + '/Logon.do?method=logon&flag=sess', { method: 'POST' });
  const s2 = await req(jar, BASE + '/Logon.do?method=logon&flag=sess', { method: 'POST' });
  console.log('\n[C] same?', s1.body === s2.body);
  const [scode, sxh] = s1.body.split('#');
  const form = new URLSearchParams({ loginMethod: 'logon', userlanguage: '0', userAccount: account, userPassword: '', encoded: encode(scode, sxh, account, password) });
  show('[C] logon with 1st scode', await req(jar, BASE + '/Logon.do?method=logon', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() }));
}

// D) sess with jar, logon with NO cookie
{
  const jar = new Jar();
  await req(jar, BASE + '/');
  const s = await req(jar, BASE + '/Logon.do?method=logon&flag=sess', { method: 'POST' });
  const [scode, sxh] = s.body.split('#');
  const form = new URLSearchParams({ loginMethod: 'logon', userlanguage: '0', userAccount: account, userPassword: '', encoded: encode(scode, sxh, account, password) });
  show('[D] logon no cookie', await req(null, BASE + '/Logon.do?method=logon', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() }));
}

// E) garbage encoded
{
  const jar = new Jar();
  await req(jar, BASE + '/');
  const form = new URLSearchParams({ loginMethod: 'logon', userlanguage: '0', userAccount: account, userPassword: '', encoded: 'garbage' });
  show('[E] garbage encoded', await req(jar, BASE + '/Logon.do?method=logon', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() }));
}

// F) plain credentials, no encoded (like loginLdap might)
{
  const jar = new Jar();
  await req(jar, BASE + '/');
  const form = new URLSearchParams({ loginMethod: 'logonLdap', userlanguage: '0', userAccount: account, userPassword: password });
  show('[F] logonLdap plain', await req(jar, BASE + '/Logon.do?method=logonLdap', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() }));
}

// G) captcha endpoint
{
  const jar = new Jar();
  await req(jar, BASE + '/');
  const r = await req(jar, BASE + '/verifycode.servlet?t=' + Math.random());
  console.log('\n[G] verifycode:', r.res.status, r.res.headers.get('content-type'), 'len=' + r.body.length);
}

// H) long inputs (>55 encoded chars)
{
  const jar = new Jar();
  await req(jar, BASE + '/');
  const s = await req(jar, BASE + '/Logon.do?method=logon&flag=sess', { method: 'POST' });
  const [scode, sxh] = s.body.split('#');
  const a2 = '202000000000', p2 = 'x'.repeat(30);
  const enc = encode(scode, sxh, a2, p2);
  const form = new URLSearchParams({ loginMethod: 'logon', userlanguage: '0', userAccount: a2, userPassword: '', encoded: enc });
  show('[H] long code len=' + `${a2}%%%${p2}%%% `.length, await req(jar, BASE + '/Logon.do?method=logon', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() }));
}
