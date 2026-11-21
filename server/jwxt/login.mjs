// Reusable Qiangzhi (强智) jwglxt login client.
// Credentials from .env (JWXT_BASE_URL / JWXT_ACCOUNT / JWXT_PASSWORD) or arguments.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
for (const p of [resolve(here, '../../.env')]) {
  if (existsSync(p)) {
    try { process.loadEnvFile(p); } catch (e) { console.warn('读取 .env 失败:', p, e.message); }
    break;
  }
}

export const BASE = (process.env.JWXT_BASE_URL || 'https://jwglxt.sdust.edu.cn').replace(/\/+$/, '');
export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export class Jar {
  constructor() { this.map = new Map(); }
  absorb(res) {
    for (const sc of (res.headers.getSetCookie?.() || [])) {
      const [pair] = sc.split(';');
      const idx = pair.indexOf('=');
      if (idx > 0) this.map.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
  header() { return [...this.map].map(([k, v]) => `${k}=${v}`).join('; '); }
  static from(obj) { const j = new Jar(); j.map = new Map(Object.entries(obj)); return j; }
  toObject() { return Object.fromEntries(this.map); }
}

export async function request(jar, url, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    body,
    redirect: 'manual',
    headers: {
      'User-Agent': UA,
      'Referer': BASE + '/',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...(jar ? { Cookie: jar.header() } : {}),
      ...headers,
    },
  });
  jar?.absorb(res);
  const text = await res.text();
  return { res, text, status: res.status, location: res.headers.get('location') };
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

export async function login({ account = process.env.JWXT_ACCOUNT, password = process.env.JWXT_PASSWORD, baseUrl = BASE, retries = 2 } = {}) {
  if (!account || !password) throw new Error('缺少 JWXT_ACCOUNT / JWXT_PASSWORD');

  let lastErr;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    const jar = new Jar();
    try {
      await request(jar, baseUrl + '/');
      const sess = await request(jar, baseUrl + '/Logon.do?method=logon&flag=sess', { method: 'POST', body: '' });
      const [scode, sxh] = sess.text.split('#');
      if (!scode || !sxh) throw new Error('sess 响应异常: ' + sess.text.slice(0, 80));

      const form = new URLSearchParams({
        loginMethod: 'logon', userlanguage: '0',
        userAccount: account, userPassword: '', encoded: encode(scode, sxh, account, password),
      });
      const res = await request(jar, baseUrl + '/Logon.do?method=logon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });

      const msg = res.text.match(/id="showMsg">([^<]*)</)?.[1];
      if (msg) throw new Error('登录失败: ' + msg); // 凭据问题，不重试
      if (res.status !== 302 && res.status !== 303) throw new Error('登录结果未知: status=' + res.status);
      return { jar, location: res.location, baseUrl };
    } catch (e) {
      lastErr = e;
      if (/^登录失败/.test(e.message) || attempt > retries) break;
      await new Promise(r => setTimeout(r, 800 * attempt)); // 偶发 200/网络抖动，退避重试
    }
  }
  throw lastErr;
}
