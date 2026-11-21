import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.mjs';

const KEY = config.masterKey;
const AAD = Buffer.from('jwxt-credential-v1');

export function encrypt(plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  cipher.setAAD(AAD);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decrypt(payload) {
  const buf = Buffer.from(payload, 'base64');
  if (buf.length < 28) throw new Error('ciphertext too short');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const d = createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAAD(AAD);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const hashToken = s => createHash('sha256').update(String(s)).digest('hex');
export const sha256b64url = s => createHash('sha256').update(String(s)).digest('base64url');

export function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && timingSafeEqual(A, B);
}

export const now = () => Math.floor(Date.now() / 1000);
