// Full read-only sweep of every /jsxsd endpoint found in the menu + module pages.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { connect } from '../server/jwxt/api.mjs';

const site = new URL('../docs/site/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const dir = site + 'modules/';

// ---- collect endpoints ----
const endpoints = new Map();
const add = (u, from) => {
  u = u.replace(/\\/g, '');
  if (!/^\/jsxsd\//.test(u)) return;
  if (/\.(css|js|png|jpe?g|gif|ico|svg|woff2?|ttf)$/i.test(u)) return;
  if (!endpoints.has(u)) endpoints.set(u, new Set());
  endpoints.get(u).add(from);
};

for (const f of readdirSync(dir)) {
  if (!f.endsWith('.html')) continue;
  const s = readFileSync(dir + f, 'utf8');
  for (const m of s.matchAll(/["'](\/jsxsd\/[A-Za-z0-9_\/.\-]+(?:\?[^"']*)?)["']/g)) add(m[1], f.replace(/\.html$/, ''));
}
// menu data-src from the main frame
if (existsSync(site + 'main.html')) {
  const s = readFileSync(site + 'main.html', 'utf8');
  for (const m of s.matchAll(/data-src="([^"]+)"/g)) add(m[1], '(菜单页)');
}
for (const [u, from] of [
  ['/jsxsd/xxwcqk/xxwcqkOnkctx.do?isdb=0', '(子页)'],
  ['/jsxsd/xxwcqk/xxwcqkOnkclb.do?isdb=0', '(子页)'],
  ['/jsxsd/xxwcqk/xxwcqkOnkcxz.do?isdb=0', '(子页)'],
  ['/jsxsd/xxwcqk/xxwcqkOnszklb.do?isdb=0', '(子页)'],
  ['/jsxsd/xskb/xskb_list.do?viweType=0', '(子页)'],
  ['/jsxsd/xskb/xskb_list.do?viweType=1', '(子页)'],
  ['/jsxsd/xskb/xskb_list.do?viweType=2', '(子页)'],
  ['/jsxsd/kscj/cjcx_list', '(子页)'],
  ['/jsxsd/xsks/xsstk_list', '(子页)'],
  ['/jsxsd/xsks/xsksap_list', '(子页)'],
  ['/jsxsd/xsxj/xscjpm.do', '(子页)'],
  ['/jsxsd/xskb/jxzlzc_xnxq_ajax', '(子页)'],
  ['/jsxsd/xskb/loadTtkMxList', '(子页)'],
]) add(u, from);

// 写操作 / 非幂等：跳过（print/preview 只读但会生成文件，也跳过）
const WRITE = /(save|_add|add\.|add\?|\/add|del|cancel|update|edit|oper|submit|apply|songsheng|qxdg|print|preview|download|upload|import|pwdjy|xgmm|pwd)/i;
// 已知需要参数的接口：补上参数
const EXTRA_Q = {
  '/jsxsd/xsks/xsstk_list': 'xnxqid=2026-2027-1',
  '/jsxsd/xsks/xsksap_list': 'xnxqid=2026-2027-1&xqlb=',
  '/jsxsd/kscj/cjcx_list': 'kksj=&kcxz=&kcsx=&kcmc=&xsfs=max&sfxsbcxq=1&fxkcmc=&zxsbjg=',
  '/jsxsd/xsxj/xscjpm.do': 'xnxq01id=&',
  '/jsxsd/xskb/jxzlzc_xnxq_ajax': 'xnxq01id=2026-2027-1',
};

const rows = [];
const s = await connect();
let readCount = 0;
for (const [raw] of endpoints) {
  const [path, query = ''] = raw.split('?');
  const row = { url: raw, pages: [...endpoints.get(raw)], kind: '' };
  if (WRITE.test(path)) { row.kind = 'write-skip'; rows.push(row); continue; }
  readCount++;

  let q = EXTRA_Q[path] ?? query;
  q = q ? (q.includes('pageNum=') ? q : q + '&pageNum=1&pageSize=100') : 'pageNum=1&pageSize=100';
  const url = path + '?' + q;
  try {
    const x = await s.get(url);
    row.status = x.status;
    row.ctype = x.res.headers.get('content-type') || '';
    const t = x.text.trim();
    row.len = t.length;
    if (/^[{[]/.test(t)) {
      row.kind = 'json';
      try {
        const j = JSON.parse(t);
        if (Array.isArray(j)) {
          row.dataCount = j.length;
          row.sampleKeys = j[0] ? Object.keys(j[0]).join(',') : '';
        } else {
          row.dataCount = Array.isArray(j.data) ? j.data.length : null;
          row.count = j.count; row.msg = j.msg; row.code = j.code;
          row.sampleKeys = j.data?.[0] ? Object.keys(j.data[0]).join(',') : '';
          row.emptyPlaceholder = row.dataCount === 1 && !row.sampleKeys;
        }
      } catch { row.kind = 'json-bad'; }
    } else if (/<html/i.test(t)) {
      row.kind = 'html';
      row.title = t.match(/<title>([^<]*)<\/title>/i)?.[1] || '';
      row.noOpen = /no-open/i.test(row.title) || t.length < 1200 && /no-open|未开放/.test(t);
    } else {
      row.kind = 'text';
      row.preview = t.slice(0, 60);
    }
  } catch (e) { row.kind = 'error'; row.error = e.message; }
  rows.push(row);
  await new Promise(r => setTimeout(r, 100));
}

// ---- report ----
const realData = rows.filter(r => r.kind === 'json' && r.dataCount > 0 && !r.emptyPlaceholder);
const placeholder = rows.filter(r => r.emptyPlaceholder);
const emptyJson = rows.filter(r => r.kind === 'json' && (r.dataCount === 0));
const needParam = rows.filter(r => ['html', 'json', 'error'].includes(r.kind) && (r.noOpen || r.status === 404 || r.status === 500 || /参数不能为空|请选择/.test(r.msg || '')));
const html = rows.filter(r => r.kind === 'html' && !r.noOpen);
const writes = rows.filter(r => r.kind === 'write-skip');

console.log(`去重接口 ${endpoints.size}；只读请求 ${readCount}；跳过写操作 ${writes.length}\n`);
console.log(`===== 有数据 (${realData.length}) =====`);
for (const r of realData) console.log(`  ${r.url}  data=${r.dataCount} count=${r.count ?? '-'} ${r.msg ? 'msg=' + r.msg : ''} keys=${r.sampleKeys}`.slice(0, 380));
console.log(`\n===== JSON 空数组 (${emptyJson.length}) =====`);
for (const r of emptyJson) console.log(`  ${r.url}${r.msg ? '  msg=' + r.msg : ''}`.slice(0, 300));
console.log(`\n===== 空占位记录 data=[{}] (${placeholder.length}) =====`);
for (const r of placeholder) console.log(`  ${r.url}`);
console.log(`\n===== 需要参数/未开放/报错 (${needParam.length}) =====`);
for (const r of needParam) console.log(`  ${r.url}  ${r.status ?? ''} ${r.title ? 'title=' + r.title : ''} ${r.msg ?? ''} ${r.error ?? ''}`.slice(0, 300));
console.log(`\n===== 返回整页 HTML（页面/表单，需解析或交互） (${html.length}) =====`);
for (const r of html) console.log(`  ${r.url}  title=${JSON.stringify(r.title)} len=${r.len}`.slice(0, 300));
console.log(`\n===== 跳过写操作 (${writes.length}) =====`);
for (const r of writes) console.log(`  ${r.url}`.slice(0, 200));

writeFileSync(site + 'sweep.json', JSON.stringify(rows, null, 2));
console.log('\n明细: docs/site/sweep.json');
