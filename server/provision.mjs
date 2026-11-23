// 未注册账号自动建号。
// 首次用“学号 + 教务密码”认证（CalDAV Basic、.ics 订阅、网页 /login）时，
// 先登录教务系统校验；通过即建号并加密保存密码。
// CalDAV token 只属于已建号的用户，不参与自动建号。
import { config } from './config.mjs';
import * as db from './db.mjs';
import { encrypt, hashToken } from './crypto.mjs';
import { verifyCredentials } from './jwxt-service.mjs';

const WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 5;      // 同一账号每窗口最多校验失败次数
const GLOBAL_MAX = 60;    // 全站每窗口最多校验次数，避免刷爆教务登录
const fails = new Map();  // account -> { count, reset }
let global = { count: 0, reset: 0 };
const inflight = new Map(); // account:passwordHash -> Promise<user|null>

function allowed(account) {
  const now = Date.now();
  if (global.reset <= now) global = { count: 0, reset: now + WINDOW_MS };
  if (global.count >= GLOBAL_MAX) return false;
  const entry = fails.get(account);
  return !entry || entry.reset <= now || entry.count < MAX_FAILS;
}

function recordFailure(account) {
  const now = Date.now();
  global.count++;
  const entry = fails.get(account);
  if (!entry || entry.reset <= now) {
    fails.set(account, { count: 1, reset: now + WINDOW_MS });
  } else {
    entry.count++;
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of fails) if (v.reset <= now) fails.delete(k);
}, 60_000).unref();

// 已注册用户直接返回；未注册且开关打开时校验教务密码并建号。校验失败/限流返回 null。
// verify 可注入，测试用。
export async function provisionUser(account, password, { verify = verifyCredentials } = {}) {
  account = String(account || '').trim();
  password = String(password || '');
  if (!config.autoProvision || !account || !password) return null;

  const existing = db.getUserByAccount(account);
  if (existing) return existing;

  const key = `${account}:${hashToken(password)}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  if (!allowed(account)) {
    console.warn(`[provision] 自动建号已限流 account=${account}`);
    return null;
  }

  const p = (async () => {
    try {
      await verify({ account, password, baseUrl: null });
    } catch (e) {
      recordFailure(account);
      console.warn(`[provision] 自动建号校验失败 account=${account}: ${e.message}`);
      return null;
    }
    // 校验期间可能已被并发请求建好
    const created = db.getUserByAccount(account);
    if (created) return created;
    try {
      const user = db.createUser({
        account,
        passwordEnc: encrypt(password),
        baseUrl: null,
        servicePasswordHash: null,
        caldavSemester: null,
      });
      console.log(`[provision] 自动建号 account=${account} user_id=${user.id}`);
      return user;
    } catch (e) {
      // 唯一索引冲突等：回查一次，交给调用方继续校验密码
      const raced = db.getUserByAccount(account);
      if (raced) return raced;
      console.error(`[provision] 自动建号失败 account=${account}: ${e.message}`);
      return null;
    }
  })().finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}
