// 校验仓库里的 openapi.json 是否与 server/openapi.mjs 的元数据一致。
// 用法：npm run openapi:check
//       ISSUER=https://your.domain npm run openapi:check
//       OPENAPI_FILE=data/other.json npm run openapi:check   # 指定文件
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApi } from '../server/openapi.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const issuer = (process.env.ISSUER || 'http://localhost:8787').replace(/\/+$/, '');
const file = process.env.OPENAPI_FILE
  ? resolve(process.env.OPENAPI_FILE)
  : resolve(ROOT, 'openapi.json');

let actual;
try {
  actual = readFileSync(file, 'utf8');
} catch {
  console.error(`找不到 ${file}`);
  console.error('先运行：npm run openapi');
  process.exit(1);
}

const expected = JSON.stringify(buildOpenApi(issuer), null, 2) + '\n';

if (actual === expected) {
  console.log(`openapi.json 是最新的（issuer=${issuer}）`);
  process.exit(0);
}

console.error(`openapi.json 与源码不一致（issuer=${issuer}）`);
console.error('请运行：npm run openapi');
const a = actual.split('\n');
const b = expected.split('\n');
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  if (a[i] !== b[i]) {
    console.error(`首个差异在第 ${i + 1} 行：`);
    console.error(`  文件: ${JSON.stringify(a[i] ?? '(缺失)')}`.slice(0, 300));
    console.error(`  期望: ${JSON.stringify(b[i] ?? '(缺失)')}`.slice(0, 300));
    break;
  }
}
process.exit(1);
