// 单元测试：未注册账号自动建号（不联网，注入假 verify）。
// 用法：npm run test:provision
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'qzgw-autocreate-'));
process.env.MASTER_KEY = '11'.repeat(32); // 64 hex = 32 字节
process.env.ADMIN_TOKEN = 'test-admin-token-0123456789';
process.env.DB_PATH = join(dir, 'test.db');
process.env.AUTO_PROVISION = '1';

const { provisionUser } = await import('../server/provision.mjs');
const db = await import('../server/db.mjs');
const { encrypt, decrypt } = await import('../server/crypto.mjs');

let fails = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) fails++;
};

const verifyCalls = [];
const verify = async ({ account, password }) => {
  verifyCalls.push(account);
  await new Promise(r => setTimeout(r, 20));
  if (password !== 'correct-pass') throw new Error('账号或密码错误');
};
const opts = { verify };

// 1. 密码错误：不建号，记录一次失败
const bad = await provisionUser('202613000001', 'wrong-pass', opts);
ok('密码错误返回 null', bad === null);
ok('密码错误不写库', db.getUserByAccount('202613000001') === undefined);

// 2. 校验通过：建号、教务密码加密、不设服务密码
const user = await provisionUser('202613000002', 'correct-pass', opts);
ok('校验通过后建号', user?.account === '202613000002');
ok('教务密码加密落库', Boolean(user) && decrypt(user.password_enc) === 'correct-pass');
ok('不设置服务密码', Boolean(user) && user.service_password_hash === null);

// 3. 已存在账号：直接返回，不再登录教务
const callsBefore = verifyCalls.length;
const again = await provisionUser('202613000002', 'correct-pass', opts);
ok('已有账号不重复校验', again?.id === user.id && verifyCalls.length === callsBefore);

// 4. 并发请求合并为一次校验、一个账号
const callsBeforeConcurrent = verifyCalls.length;
const results = await Promise.all(
  Array.from({ length: 5 }, () => provisionUser('202613000003', 'correct-pass', opts)),
);
ok('并发只校验一次', verifyCalls.length === callsBeforeConcurrent + 1);
ok('并发只建一个账号', results.every(Boolean) && new Set(results.map(u => u.id)).size === 1);

// 5. 同一账号连续失败 5 次后，正确密码也不再尝试（15 分钟窗口）
for (let i = 0; i < 5; i++) await provisionUser('202613000004', 'wrong-pass', opts);
const callsBeforeBlocked = verifyCalls.length;
const blocked = await provisionUser('202613000004', 'correct-pass', opts);
ok('连续失败后限流', blocked === null && verifyCalls.length === callsBeforeBlocked);
ok('限流期间不建号', db.getUserByAccount('202613000004') === undefined);

// 6. 已存在的禁用账号：不重新校验，也不会建号
const disabled = db.createUser({
  account: '202613000005',
  passwordEnc: encrypt('correct-pass'),
  servicePasswordHash: null,
});
db.updateUser(disabled.id, { disabled: true });
const callsBeforeDisabled = verifyCalls.length;
const disabledResult = await provisionUser('202613000005', 'correct-pass', opts);
ok('禁用账号原样返回、不校验', disabledResult?.id === disabled.id && verifyCalls.length === callsBeforeDisabled);

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exitCode = fails ? 1 : 0;
