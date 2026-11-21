#!/usr/bin/env node
// 本地管理脚本：生成密钥、管理用户/CalDAV token、注册 OAuth 客户端。
// 运行 `node scripts/admin.mjs` 查看完整用法。
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
const { encrypt, hashToken, hashPassword, randomToken } = await import('../server/crypto.mjs');
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
  case 'add-user': {
    const username = String(args.username || '').trim();
    const account = String(args.account || '').trim();
    const password = String(args.password || '');
    const baseUrl = args['base-url'] || null;
    const displayName = args['display-name'] || username;
    const servicePassword = args['service-password'] || null;
    if (!username || !account || !password) throw new Error('需要 --username --account --password');
    if (!/^[A-Za-z0-9._-]{2,64}$/.test(username)) throw new Error('username 只能包含 A-Z a-z 0-9 . _ -，长度 2-64');
    if (servicePassword !== null && String(servicePassword).length < 8) throw new Error('--service-password 至少 8 位');
    if (db.getUserByUsername(username)) throw new Error('username 已存在');
    if (db.getUserByAccount(account)) throw new Error('account 已存在');
    if (!args['no-verify']) {
      await verifyCredentials({ account, password, baseUrl });
      console.log('账号密码校验通过');
    }
    const user = db.createUser({
      username,
      displayName,
      account,
      passwordEnc: encrypt(password),
      baseUrl,
      servicePasswordHash: servicePassword ? hashPassword(String(servicePassword)) : null,
    });
    console.log(JSON.stringify({
      id: user.id,
      username: user.username,
      account: user.account,
      hasServicePassword: Boolean(user.service_password_hash),
    }, null, 2));
    break;
  }
  case 'list-users': {
    console.table(db.listUsers().map(u => ({
      id: u.id,
      username: u.username,
      account: u.account,
      disabled: Boolean(u.disabled),
      servicePassword: Boolean(u.service_password_hash),
      caldavTokens: u.caldav_token_count,
    })));
    break;
  }
  case 'set-user': {
    const id = Number(args._[0]);
    if (!id) throw new Error('需要 user id');
    const user = db.getUserById(id);
    if (!user) throw new Error('用户不存在');
    const username = args.username !== undefined ? String(args.username).trim() : user.username;
    const account = args.account !== undefined ? String(args.account).trim() : user.account;
    const baseUrl = args['base-url'] !== undefined ? args['base-url'] : user.base_url;
    if (args.username !== undefined) {
      if (!/^[A-Za-z0-9._-]{2,64}$/.test(username)) throw new Error('username 不合法');
      const other = db.getUserByUsername(username);
      if (other && other.id !== id) throw new Error('username 已存在');
    }
    if (args.account !== undefined) {
      const other = db.getUserByAccount(account);
      if (other && other.id !== id) throw new Error('account 已存在');
    }

    let passwordEnc = user.password_enc;
    if (args.password !== undefined) {
      const password = String(args.password);
      if (!password) throw new Error('--password 不能为空');
      if (!args['no-verify']) await verifyCredentials({ account, password, baseUrl });
      passwordEnc = encrypt(password);
    }

    let servicePasswordHash = user.service_password_hash;
    if (args['service-password'] !== undefined) {
      if (!args['service-password']) servicePasswordHash = null;
      else {
        if (String(args['service-password']).length < 8) throw new Error('--service-password 至少 8 位');
        servicePasswordHash = hashPassword(String(args['service-password']));
      }
    }

    const disabled = args.disabled !== undefined
      ? !(args.disabled === false || args.disabled === 'false' || args.disabled === '0')
      : Boolean(user.disabled);

    const updated = db.updateUser(id, {
      username,
      displayName: args['display-name'] !== undefined ? String(args['display-name']) : user.display_name,
      account,
      passwordEnc,
      baseUrl,
      servicePasswordHash,
      disabled,
    });
    if (args['service-password'] !== undefined || disabled) db.deleteUserSessions(id);
    console.log(`已更新 #${updated.id} ${updated.username}（disabled=${Boolean(updated.disabled)}）`);
    break;
  }
  case 'del-user': {
    const id = Number(args._[0]);
    if (!id) throw new Error('需要 user id');
    console.log(db.deleteUser(id) ? '已删除' : '未找到');
    break;
  }
  case 'add-caldav-token': {
    const userId = Number(args._[0]);
    if (!userId) throw new Error('需要 user id');
    if (!db.getUserById(userId)) throw new Error('用户不存在');
    const token = randomToken(32);
    const row = db.createCalDavToken({
      userId,
      label: args.label ? String(args.label) : null,
      tokenHash: hashToken(token),
    });
    console.log(JSON.stringify({ id: row.id, label: row.label, token }, null, 2));
    console.log('\ntoken 只显示这一次，请立即保存。');
    break;
  }
  case 'list-caldav-tokens': {
    const userId = Number(args._[0]);
    if (!userId) throw new Error('需要 user id');
    console.table(db.listCalDavTokens(userId).map(t => ({
      id: t.id,
      label: t.label,
      createdAt: t.created_at,
      revokedAt: t.revoked_at,
      lastUsedAt: t.last_used_at,
    })));
    break;
  }
  case 'del-caldav-token': {
    const userId = Number(args._[0]);
    const tokenId = Number(args._[1]);
    if (!userId || !tokenId) throw new Error('需要 user id 和 token id');
    console.log(db.revokeCalDavToken(tokenId, userId) ? '已撤销' : '未找到');
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

    if (!args.user) throw new Error('需要 --user <id|username>');
    const owner = /^\d+$/.test(String(args.user))
      ? db.getUserById(Number(args.user))
      : db.getUserByUsername(String(args.user));
    if (!owner) throw new Error('--user 不存在');
    const userId = owner.id;

    db.createClient({
      clientId, name, secretHash: secret ? hashToken(secret) : null,
      redirectUris: args.redirect, scopes, isPublic, userId,
    });
    console.log(JSON.stringify({
      client_id: clientId,
      client_secret: secret,
      name, redirect_uris: args.redirect, scopes, public: isPublic,
      user_id: userId, username: owner.username,
    }, null, 2));
    console.log('\nclient_secret 只显示这一次，请立即保存。');
    break;
  }
  case 'list-clients': {
    console.table(db.listClients().map(c => ({
      client_id: c.client_id, name: c.name, username: c.username,
      scopes: c.scopes, public: Boolean(c.public), redirect_uris: c.redirect_uris,
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
  node scripts/admin.mjs add-user --username <名> --account <学号> --password <密码> [--service-password <密码>] [--display-name <名>] [--base-url <url>] [--no-verify]
  node scripts/admin.mjs list-users
  node scripts/admin.mjs set-user <id> [--username <名>] [--account <学号>] [--password <密码>] [--service-password <密码>] [--display-name <名>] [--disabled true|false] [--no-verify]
  node scripts/admin.mjs del-user <id>
  node scripts/admin.mjs add-caldav-token <user_id> [--label <标签>]
  node scripts/admin.mjs list-caldav-tokens <user_id>
  node scripts/admin.mjs del-caldav-token <user_id> <token_id>
  node scripts/admin.mjs add-client --name <名称> --redirect <uri> [--redirect <uri2>] [--scopes jwxt.read,offline_access] [--public] [--user <id|username>]
  node scripts/admin.mjs list-clients
  node scripts/admin.mjs del-client <client_id>`);
    process.exit(cmd ? 1 : 0);
}
