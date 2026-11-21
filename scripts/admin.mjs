#!/usr/bin/env node
// 本地管理脚本：生成密钥、设置教务账号、注册 OAuth 客户端。
// 用法：
//   node scripts/admin.mjs gen-key
//   node scripts/admin.mjs gen-token
//   node scripts/admin.mjs set-account --account 2026... --password '...'
//   node scripts/admin.mjs add-client --name demo --redirect http://localhost:3000/cb --scopes jwxt.read,offline_access
//   node scripts/admin.mjs list-clients
//   node scripts/admin.mjs del-client <client_id>
import { randomBytes } from 'node:crypto';

const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'gen-key') {
  console.log(randomBytes(32).toString('base64'));
  process.exit(0);
}
if (cmd === 'gen-token') {
  console.log(randomBytes(32).toString('base64url'));
  process.exit(0);
}

// 下面命令需要 MASTER_KEY / ADMIN_TOKEN 等配置
const { config } = await import('../server/config.mjs');
const { encrypt, hashToken, randomToken } = await import('../server/crypto.mjs');
const db = await import('../server/db.mjs');
const { verifyCredentials } = await import('../server/jwxt-service.mjs');

function parseArgs(argv) {
  const out = { _: [], redirect: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (key === 'redirect') {
      if (!next || next.startsWith('--')) throw new Error('--redirect 需要一个值');
      out.redirect.push(next); i++;
    } else if (next && !next.startsWith('--')) {
      out[key] = next; i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(rest);

switch (cmd) {
  case 'set-account': {
    const account = String(args.account || process.env.JWXT_ACCOUNT || '').trim();
    const password = String(args.password || process.env.JWXT_PASSWORD || '');
    const baseUrl = args['base-url'] || process.env.JWXT_BASE_URL || null;
    if (!account || !password) throw new Error('需要 --account 和 --password');
    if (!args['no-verify']) {
      await verifyCredentials({ account, password, baseUrl });
      console.log('账号密码校验通过');
    }
    const user = db.upsertPrimaryUser({ account, passwordEnc: encrypt(password), baseUrl });
    console.log(`已保存账号 ${user.account}（AES-256-GCM 加密）`);
    break;
  }
  case 'add-client': {
    const name = String(args.name || '').trim();
    if (!name) throw new Error('需要 --name');
    if (!args.redirect.length) throw new Error('至少需要一个 --redirect');
    const localHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
    for (const u of args.redirect) {
      let parsed;
      try { parsed = new URL(u); } catch { throw new Error(`redirect 不合法: ${u}`); }
      const local = localHosts.has(parsed.hostname);
      if (parsed.hash || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local))) {
        throw new Error(`redirect 必须是 https（localhost 可用 http）且不带 fragment: ${u}`);
      }
    }
    const scopes = String(args.scopes || 'jwxt.read').split(',').map(s => s.trim()).filter(Boolean);
    const { SCOPES } = await import('../server/config.mjs');
    const bad = scopes.filter(s => !SCOPES.includes(s));
    if (bad.length) throw new Error(`未知 scope: ${bad.join(', ')}`);
    const isPublic = Boolean(args.public);
    const clientId = 'qz_' + randomToken(12);
    const secret = isPublic ? null : randomToken(32);
    db.createClient({
      clientId, name, secretHash: secret ? hashToken(secret) : null,
      redirectUris: args.redirect, scopes, isPublic,
    });
    console.log(JSON.stringify({
      client_id: clientId,
      client_secret: secret,
      name, redirect_uris: args.redirect, scopes, public: isPublic,
    }, null, 2));
    console.log('\nclient_secret 只显示这一次，请立即保存。');
    break;
  }
  case 'list-clients': {
    console.table(db.listClients().map(c => ({
      client_id: c.client_id, name: c.name, scopes: c.scopes,
      public: Boolean(c.public), redirect_uris: c.redirect_uris,
    })));
    break;
  }
  case 'del-client': {
    const id = args._[0];
    if (!id) throw new Error('需要 client_id');
    console.log(db.deleteClient(id) ? '已删除' : '未找到');
    break;
  }
  default:
    console.log(`用法:
  node scripts/admin.mjs gen-key
  node scripts/admin.mjs gen-token
  node scripts/admin.mjs set-account --account <账号> --password <密码> [--base-url <url>] [--no-verify]
  node scripts/admin.mjs add-client --name <名称> --redirect <uri> [--redirect <uri2>] [--scopes jwxt.read,offline_access] [--public]
  node scripts/admin.mjs list-clients
  node scripts/admin.mjs del-client <client_id>`);
    process.exit(cmd ? 1 : 0);
}
