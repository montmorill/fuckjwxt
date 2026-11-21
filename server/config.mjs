import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 加载项目根目录 .env（不覆盖已有环境变量）
for (const p of [resolve(ROOT, '.env'), resolve(process.cwd(), '.env')]) {
  if (existsSync(p)) {
    try { process.loadEnvFile(p); } catch { /* ignore */ }
    break;
  }
}

const parseKey = raw => {
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  const b = Buffer.from(raw, 'base64');
  return b.length === 32 ? b : null;
};

const masterKey = parseKey(process.env.MASTER_KEY);
if (!masterKey) {
  throw new Error('MASTER_KEY 缺失或格式不对：需要 32 字节 base64 或 64 位 hex。生成：node scripts/admin.mjs gen-key');
}

const adminToken = process.env.ADMIN_TOKEN || '';
if (adminToken.length < 24) {
  throw new Error('ADMIN_TOKEN 缺失或太短（至少 24 字符）。生成：node scripts/admin.mjs gen-token');
}

const port = Number(process.env.PORT || 8787);
const issuer = (process.env.ISSUER || `http://localhost:${port}`).replace(/\/+$/, '');
const dbPath = resolve(ROOT, process.env.DB_PATH || 'data/jwxt-oauth.db');
mkdirSync(dirname(dbPath), { recursive: true });

// 多用户模式下每个用户可单独设置 baseUrl；这里只是未设置时的默认值。
export const DEFAULT_JWXT_BASE_URL = 'https://jwglxt.sdust.edu.cn';

export const config = {
  port,
  issuer,
  dbPath,
  masterKey,
  adminToken,
  corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  accessTtl: Number(process.env.ACCESS_TOKEN_TTL || 3600),          // 秒
  refreshTtl: Number(process.env.REFRESH_TOKEN_TTL || 2592000),     // 秒，30 天
  codeTtl: Number(process.env.AUTH_CODE_TTL || 60),                 // 秒
  sessionTtlMs: Number(process.env.JWXT_SESSION_TTL_MS || 900000),  // 15 分钟
  adminRateLimit: Number(process.env.ADMIN_RATE_LIMIT || 120),      // 每分钟

  // 服务登录会话（OAuth 资源所有者）
  sessionTtl: Number(process.env.SERVICE_SESSION_TTL || 604800),      // 秒，7 天
  cookieSecure: issuer.startsWith('https://'),

  // CalDAV（只读课表）
  // 学期/开学日期/作息不再走 env：学期按用户，开学日期从教学周历解析，作息在 config/period-times.json
  caldavCacheMs: Number(process.env.CALDAV_CACHE_MS || 300000),     // 5 分钟
};

export const SCOPES = ['jwxt.read', 'jwxt.profile', 'offline_access'];
