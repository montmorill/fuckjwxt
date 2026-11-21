// Probe candidate JSON/list endpoints discovered from the module pages. Read-only GETs.
import { login, request } from './jwxt.mjs';

const base = 'https://jwglxt.sdust.edu.cn';
const { jar, location } = await login();
let r = await request(jar, location);
if (r.location) await request(jar, new URL(r.location, location).href);

const urls = [
  '/jsxsd/ggly/xxtz_query?type=list',
  '/jsxsd/ggly/ysgg_query?type=list',
  '/jsxsd/ggly/ysly_query?type=list',
  '/jsxsd/zxwd/zxwd_opt?type=list',
  '/jsxsd/jcgl/bjjcdg_query?reqType=listData',
  '/jsxsd/jcgl/jcjhcx_list?reqType=listData',
  '/jsxsd/kscj/cjzm_list?type=listData',
  '/jsxsd/kscj/publicRepalceApply.do?type=listData',
  '/jsxsd/kscj/bkbm_query?type=list0',
  '/jsxsd/kscj/bkbm_query?type=list1',
  '/jsxsd/kscj/hksq_list',
  '/jsxsd/kscj/mksq_list',
  '/jsxsd/xsxj/xsyjxx_list.do',
  '/jsxsd/xsxj/xjxxgl.do?type=list',
  '/jsxsd/xsxj/xsydxx.do?type=list',
  '/jsxsd/xsxj/grkctdToApply.do?reqType=listData',
  '/jsxsd/xsxj/xscjpm.do',
  '/jsxsd/xsxj/xszToApply.do?type=list',
  '/jsxsd/xfxfgl/xsjfck?type=1',
  '/jsxsd/xsxk/xklc_list_data',
  '/jsxsd/xsks/xsstk_list',
  '/jsxsd/xskb/loadTtkMxList',
  '/jsxsd/pyfa/pyfa_query?islist=1',
  '/jsxsd/pyfa/fxpyfa_query?islist=1',
  '/jsxsd/pyfa/pyfajc_query',
  '/jsxsd/xspj/xspj_find.do?type=list',
  '/jsxsd/newxspj/xspj_list.do?islist=1',
  '/jsxsd/xxwcqk/byqkcx.do?initType=toData',
  '/jsxsd/kbxx/jsjy_rqAjax',
  '/jsxsd/jlsgl/jlcjtj_find.do?reqType=listData',
];

for (const path of urls) {
  await new Promise(r => setTimeout(r, 250));
  let x;
  try { x = await request(jar, base + path); } catch (e) { console.log(`\n${path}\n  ERR ${e.message}`); continue; }
  const ct = x.res.headers.get('content-type') || '';
  const body = x.text.trim();
  const looksJson = /json/i.test(ct) || /^[{[]/.test(body);
  const kind = looksJson ? 'JSON' : (/<html/i.test(body) ? 'HTML' : 'TEXT');
  let shape = '';
  if (looksJson) {
    try {
      const j = JSON.parse(body);
      shape = Array.isArray(j) ? `array(${j.length})` : `keys=${Object.keys(j).join(',')}`;
      if (Array.isArray(j) && j[0]) shape += ` itemkeys=${Object.keys(j[0]).join(',')}`;
      else if (j && typeof j === 'object' && Array.isArray(j.data) && j.data[0]) shape += ` itemkeys=${Object.keys(j.data[0]).join(',')}`;
    } catch { shape = 'JSON? ' + body.slice(0, 120); }
  } else {
    shape = (x.text.match(/<title>([^<]*)<\/title>/i)?.[1] ? 'title=' + x.text.match(/<title>([^<]*)<\/title>/i)[1] : '') + ' ' + body.slice(0, 80).replace(/\s+/g, ' ');
  }
  console.log(`\n${path}\n  ${x.status} ${kind} len=${x.text.length} ${shape}${x.location ? ' loc=' + x.location : ''}`);
  if (looksJson) console.log('  ' + body.slice(0, 500).replace(/\s+/g, ' '));
}
