// Call the layui-table data endpoints discovered on the pages and print their JSON shape.
import { login, request } from './jwxt.mjs';
import { writeFileSync } from 'node:fs';

const base = 'https://jwglxt.sdust.edu.cn';
const { jar, location } = await login();
let r = await request(jar, location);
if (r.location) await request(jar, new URL(r.location, location).href);

const calls = [
  ['成绩列表', '/jsxsd/kscj/cjcx_list?pageNum=1&pageSize=5&kksj=&kcxz=&kcsx=&kcmc=&xsfs=all&sfxsbcxq=1&fxkcmc=&zxsbjg='],
  ['考试安排', '/jsxsd/xsks/xsksap_list?pageNum=1&pageSize=5&xnxqid=2026-2027-1&xqlb='],
  ['课表(viweType=0)', '/jsxsd/xskb/xskb_list.do?viweType=0'],
  ['课表(viweType=1)', '/jsxsd/xskb/xskb_list.do?viweType=1'],
  ['学籍子表-奖励', '/jsxsd/grxx/queryXsxx_jlxx'],
  ['学籍子表-家庭', '/jsxsd/grxx/queryXsxx_jtcy'],
  ['专业排名', '/jsxsd/view/xsxj/xscjpm.jsp'],
  ['学业完成-课程体系', '/jsxsd/xxwcqk/xxwcqkOnkctx.do?isdb=0'],
];

for (const [name, path] of calls) {
  await new Promise(r => setTimeout(r, 250));
  const x = await request(jar, base + path);
  const ct = x.res.headers.get('content-type') || '';
  const isJson = /json/i.test(ct) || /^\s*[{[]/.test(x.text);
  console.log(`\n=== ${name} -> ${x.status} ${ct} len=${x.text.length}${x.location ? ' loc=' + x.location : ''}`);
  if (isJson) {
    try {
      const j = JSON.parse(x.text);
      console.log('keys:', Object.keys(j));
      console.log(JSON.stringify(j).slice(0, 1200));
    } catch { console.log(x.text.slice(0, 500)); }
  } else {
    const title = x.text.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '';
    console.log('title:', title);
    console.log('head:', x.text.slice(0, 300).replace(/\s+/g, ' '));
  }
  const slug = path.split('?')[0].replace(/^\/jsxsd\//, '').replace(/[^A-Za-z0-9._-]+/g, '_');
  writeFileSync(new URL('../research/site/api_' + slug + (isJson ? '.json' : '.html'), import.meta.url), x.text);
}
