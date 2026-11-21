// Enumerate the student menu and probe each page with the authenticated session (read-only GETs).
import { writeFileSync, mkdirSync } from 'node:fs';
import { login, request } from '../server/jwxt/login.mjs';

const out = new URL('../research/site/modules/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(out, { recursive: true });

const { jar, location } = await login();
console.log('登录成功');

// establish /jsxsd session
let r = await request(jar, location);
if (r.location) r = await request(jar, new URL(r.location, location).href);
const mainUrl = 'https://jwglxt.sdust.edu.cn/jsxsd/framework/xsMainV.htmlx';
const main = await request(jar, mainUrl);
writeFileSync(out + '../main.html', main.text);
console.log('主页:', main.status, main.text.length, 'cookie:', jar.toObject());

const items = [];
const re = /<li\b[^>]*data-id="([^"]*)"[^>]*data-src="([^"]+)"[^>]*>\s*<span>([^<]*)<\/span>/gi;
for (const m of main.text.matchAll(re)) items.push({ id: m[1], src: m[2], name: m[3].trim() });
// de-dup by src, keep first name
const seen = new Set();
const uniq = items.filter(it => { if (seen.has(it.src)) return false; seen.add(it.src); return true; });
console.log(`菜单项: ${items.length}，去重后 ${uniq.length}\n`);

const results = [];
for (const it of uniq) {
  const url = new URL(it.src, mainUrl).href;
  await new Promise(r => setTimeout(r, 250));
  let res;
  try { res = await request(jar, url); } catch (e) { results.push({ ...it, error: e.message }); console.log(`ERR  ${it.name} ${it.src} ${e.message}`); continue; }
  const title = res.text.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '';
  const loginAgain = /id="showMsg"|欢迎登录教务系统/.test(res.text);
  const records = { ...it, url, status: res.status, location: res.location, ctype: res.res.headers.get('content-type'), len: res.text.length, title, loginAgain };
  results.push(records);
  const slug = it.src.replace(/^\/jsxsd\//, '').replace(/[^A-Za-z0-9._-]+/g, '_');
  writeFileSync(out + slug + '.html', res.text);
  console.log(`${String(res.status).padEnd(4)} ${String(res.text.length).padEnd(7)} ${title.slice(0, 20).padEnd(20)} ${it.name.padEnd(14)} ${it.src}${res.location ? ' -> ' + res.location : ''}${loginAgain ? ' [LOGIN?]' : ''}`);
}

writeFileSync(out + '../menu.json', JSON.stringify(results, null, 2));
console.log('\n已保存:', out);
