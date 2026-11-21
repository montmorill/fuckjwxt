// 从 server/openapi.mjs 的路由元数据生成根目录 openapi.json。
// 用法：npm run openapi   或   ISSUER=https://your.domain npm run openapi
import { writeFileSync } from 'node:fs';
import { buildOpenApi } from '../server/openapi.mjs';

const issuer = (process.env.ISSUER || 'http://localhost:8787').replace(/\/+$/, '');
const spec = buildOpenApi(issuer);

writeFileSync(
  new URL('../openapi.json', import.meta.url),
  JSON.stringify(spec, null, 2) + '\n',
);

console.log(`openapi.json 已生成：${Object.keys(spec.paths).length} 个路径，issuer=${issuer}`);
