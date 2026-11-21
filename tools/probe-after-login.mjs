// Log in, follow the post-login redirect chain, dump landed pages and their frames/links.
import { writeFileSync, mkdirSync } from 'node:fs';
import { login, request } from '../server/jwxt/login.mjs';

const out = new URL('../docs/site/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(out, { recursive: true });
const save = (name, text) => writeFileSync(out + name, text);

const { jar, location } = await login();
console.log('登录成功，Location:', location);
console.log('登录后 Cookie:', jar.toObject());

let url = location;
for (let hop = 0; hop < 10; hop++) {
  const r = await request(jar, url);
  console.log(`\n[${hop}] GET ${url}\n  -> ${r.status}${r.location ? ' Location=' + r.location : ''} len=${r.text.length} type=${r.res.headers.get('content-type')}`);
  const file = `hop${hop}.html`;
  save(file, r.text);
  const title = r.text.match(/<title>([^<]*)<\/title>/i)?.[1];
  console.log('  title:', JSON.stringify(title));
  for (const m of r.text.matchAll(/<(frame|iframe)[^>]+(?:src|name)="[^"]*"[^>]*>/gi)) console.log('  frame:', m[0].slice(0, 200));
  for (const m of r.text.matchAll(/<script[^>]+src="([^"]+)"/gi)) console.log('  script:', m[1]);
  for (const m of r.text.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([^<]{0,40})/gi)) console.log('  a:', m[1], '|', m[2].trim());
  if (!r.location) break;
  url = new URL(r.location, url).href;
}

console.log('\n最终 Cookie:', jar.toObject());
save('cookies.json', JSON.stringify(jar.toObject(), null, 2));
console.log('\n已保存到 docs/site/');
