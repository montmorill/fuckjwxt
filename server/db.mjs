import { DatabaseSync } from 'node:sqlite';
import { config } from './config.mjs';
import { now } from './crypto.mjs';

export const db = new DatabaseSync(config.dbPath);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account TEXT NOT NULL UNIQUE,
  password_enc TEXT NOT NULL,
  base_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  client_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  secret_hash TEXT,
  redirect_uris TEXT NOT NULL,
  scopes TEXT NOT NULL,
  public INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  redirect_uri TEXT NOT NULL,
  scopes TEXT NOT NULL,
  code_challenge TEXT,
  code_challenge_method TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS access_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  scopes TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_access_client ON access_tokens(client_id);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  scopes TEXT NOT NULL,
  family_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_client ON refresh_tokens(client_id);
CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens(family_id);
`);

// ---------- users ----------
export const getPrimaryUser = () =>
  db.prepare('SELECT * FROM users ORDER BY id LIMIT 1').get();

export const getUserById = id =>
  db.prepare('SELECT * FROM users WHERE id = ?').get(id);

export function upsertPrimaryUser({ account, passwordEnc, baseUrl }) {
  const existing = getPrimaryUser();
  const t = now();
  if (existing) {
    db.prepare('UPDATE users SET account = ?, password_enc = ?, base_url = ?, updated_at = ? WHERE id = ?')
      .run(account, passwordEnc, baseUrl ?? null, t, existing.id);
    return getUserById(existing.id);
  }
  const r = db.prepare('INSERT INTO users (account, password_enc, base_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(account, passwordEnc, baseUrl ?? null, t, t);
  return getUserById(Number(r.lastInsertRowid));
}

// ---------- clients ----------
export function createClient({ clientId, name, secretHash, redirectUris, scopes, isPublic }) {
  db.prepare('INSERT INTO clients (client_id, name, secret_hash, redirect_uris, scopes, public, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(clientId, name, secretHash ?? null, JSON.stringify(redirectUris), scopes.join(' '), isPublic ? 1 : 0, now());
  return getClient(clientId);
}

export const getClient = clientId =>
  db.prepare('SELECT * FROM clients WHERE client_id = ?').get(clientId);

export const listClients = () =>
  db.prepare('SELECT client_id, name, redirect_uris, scopes, public, created_at FROM clients ORDER BY created_at DESC').all();

export const deleteClient = clientId =>
  db.prepare('DELETE FROM clients WHERE client_id = ?').run(clientId).changes;

// ---------- auth codes ----------
export function createAuthCode({ codeHash, clientId, userId, redirectUri, scopes, codeChallenge, codeChallengeMethod, expiresAt }) {
  db.prepare(`INSERT INTO auth_codes
    (code_hash, client_id, user_id, redirect_uri, scopes, code_challenge, code_challenge_method, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(codeHash, clientId, userId, redirectUri, scopes.join(' '), codeChallenge ?? null, codeChallengeMethod ?? null, expiresAt, now());
}

export const getAuthCode = codeHash =>
  db.prepare('SELECT * FROM auth_codes WHERE code_hash = ?').get(codeHash);

export const markAuthCodeUsed = (codeHash, t = now()) =>
  db.prepare('UPDATE auth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL').run(t, codeHash).changes;

// ---------- access tokens ----------
export const createAccessToken = ({ tokenHash, clientId, userId, scopes, expiresAt }) =>
  db.prepare('INSERT INTO access_tokens (token_hash, client_id, user_id, scopes, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(tokenHash, clientId, userId, scopes.join(' '), expiresAt, now());

export const getAccessToken = tokenHash =>
  db.prepare('SELECT * FROM access_tokens WHERE token_hash = ?').get(tokenHash);

export const revokeAccessToken = (tokenHash, t = now()) =>
  db.prepare('UPDATE access_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(t, tokenHash).changes;

// ---------- refresh tokens ----------
export const createRefreshToken = ({ tokenHash, clientId, userId, scopes, familyId, expiresAt }) =>
  db.prepare('INSERT INTO refresh_tokens (token_hash, client_id, user_id, scopes, family_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(tokenHash, clientId, userId, scopes.join(' '), familyId, expiresAt, now());

export const getRefreshToken = tokenHash =>
  db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(tokenHash);

export const revokeRefreshToken = (tokenHash, t = now()) =>
  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(t, tokenHash).changes;

export const revokeRefreshFamily = (familyId, t = now()) =>
  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL').run(t, familyId).changes;

// ---------- cleanup ----------
export function cleanup() {
  const t = now();
  db.prepare('DELETE FROM auth_codes WHERE expires_at < ?').run(t - 3600);
  db.prepare('DELETE FROM access_tokens WHERE expires_at < ?').run(t - 86400);
  db.prepare('DELETE FROM refresh_tokens WHERE expires_at < ?').run(t - 86400);
}
