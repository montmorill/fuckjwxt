// 生成/校验根目录 openapi.json（源自 server/openapi.mjs 的路由元数据）。
// 用法：
//   npm run openapi                                生成
//   ISSUER=https://your.domain npm run openapi     指定 issuer
//   npm run openapi:check                          校验
//   OPENAPI_FILE=data/other.json npm run openapi:check   # 指定文件
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildOpenApi } from '../server/openapi.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const issuer = (process.env.ISSUER || 'http://localhost:8787').replace(/\/+$/, '');
const cmd = process.argv[2];

if (cmd === 'gen') {
  const spec = buildOpenApi(issuer);
  writeFileSync(resolve(ROOT, 'openapi.json'), JSON.stringify(spec, null, 2) + '\n');
  console.log(`openapi.json 已生成：${Object.keys(spec.paths).length} 个路径，issuer=${issuer}`);
  process.exit(0);
}

if (cmd === 'check') {
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
}

console.error('用法: node scripts/openapi.mjs <gen|check>');
process.exit(1);
