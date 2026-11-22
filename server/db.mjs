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
  service_password_hash TEXT,
  caldav_semester TEXT,
  disabled INTEGER NOT NULL DEFAULT 0,
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
  user_id INTEGER NOT NULL,
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

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id INTEGER,
  csrf_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS caldav_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  label TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_caldav_tokens_user ON caldav_tokens(user_id);

CREATE TABLE IF NOT EXISTS caldav_colors (
  user_id INTEGER NOT NULL,
  calendar_key TEXT NOT NULL,
  color TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, calendar_key)
);
`);

// ---------- users ----------
export const getUserById = id =>
  db.prepare('SELECT * FROM users WHERE id = ?').get(id);

export const getUserByAccount = account =>
  db.prepare('SELECT * FROM users WHERE account = ?').get(account);

export const listUsers = () =>
  db.prepare(`SELECT u.*,
      (SELECT COUNT(*) FROM caldav_tokens t WHERE t.user_id = u.id AND t.revoked_at IS NULL) AS caldav_token_count
    FROM users u ORDER BY u.id`).all();

export function createUser({ account, passwordEnc, baseUrl, servicePasswordHash, caldavSemester }) {
  const t = now();
  const r = db.prepare(`INSERT INTO users
      (account, password_enc, base_url, service_password_hash, caldav_semester, disabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?)`)
    .run(account, passwordEnc, baseUrl ?? null, servicePasswordHash ?? null, caldavSemester ?? null, t, t);
  return getUserById(Number(r.lastInsertRowid));
}

export function updateUser(id, fields) {
  const user = getUserById(id);
  if (!user) return null;
  db.prepare(`UPDATE users SET account = ?, password_enc = ?,
      base_url = ?, service_password_hash = ?, caldav_semester = ?, disabled = ?, updated_at = ?
    WHERE id = ?`)
    .run(
      fields.account ?? user.account,
      fields.passwordEnc ?? user.password_enc,
      fields.baseUrl !== undefined ? fields.baseUrl : user.base_url,
      fields.servicePasswordHash !== undefined ? fields.servicePasswordHash : user.service_password_hash,
      fields.caldavSemester !== undefined ? fields.caldavSemester : user.caldav_semester,
      fields.disabled !== undefined ? (fields.disabled ? 1 : 0) : user.disabled,
      now(),
      id,
    );
  return getUserById(id);
}

export function deleteUser(id) {
  db.exec('BEGIN IMMEDIATE');
  try {
    // clients.user_id 是 NOT NULL，删除用户时一并删除其客户端
    db.prepare('DELETE FROM auth_codes WHERE client_id IN (SELECT client_id FROM clients WHERE user_id = ?)').run(id);
    db.prepare('DELETE FROM access_tokens WHERE client_id IN (SELECT client_id FROM clients WHERE user_id = ?)').run(id);
    db.prepare('DELETE FROM refresh_tokens WHERE client_id IN (SELECT client_id FROM clients WHERE user_id = ?)').run(id);
    db.prepare('DELETE FROM clients WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM caldav_tokens WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM caldav_colors WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM auth_codes WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM access_tokens WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(id);
    const changed = db.prepare('DELETE FROM users WHERE id = ?').run(id).changes;
    db.exec('COMMIT');
    return changed;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---------- clients ----------
export function createClient({ clientId, name, secretHash, redirectUris, scopes, isPublic, userId }) {
  if (!userId) throw new Error('client userId is required');
  db.prepare('INSERT INTO clients (client_id, name, secret_hash, redirect_uris, scopes, public, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(clientId, name, secretHash ?? null, JSON.stringify(redirectUris), scopes.join(' '), isPublic ? 1 : 0, userId, now());
  return getClient(clientId);
}

export const getClient = clientId =>
  db.prepare('SELECT * FROM clients WHERE client_id = ?').get(clientId);

export const listClients = () =>
  db.prepare(`SELECT c.client_id, c.name, c.redirect_uris, c.scopes, c.public, c.created_at,
      c.user_id, u.account
    FROM clients c LEFT JOIN users u ON u.id = c.user_id
    ORDER BY c.created_at DESC`).all();

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

// ---------- sessions ----------
export function createSession({ idHash, userId, csrfToken, expiresAt }) {
  db.prepare('INSERT INTO sessions (id_hash, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(idHash, userId ?? null, csrfToken, expiresAt, now());
}

export const getSession = idHash =>
  db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(idHash);

export const deleteSession = idHash =>
  db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(idHash).changes;

export const deleteUserSessions = userId =>
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;

// ---------- caldav tokens ----------
export function createCalDavToken({ userId, label, tokenHash }) {
  const r = db.prepare('INSERT INTO caldav_tokens (user_id, label, token_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, label ?? null, tokenHash, now());
  return getCalDavTokenById(Number(r.lastInsertRowid));
}

export const getCalDavTokenById = id =>
  db.prepare('SELECT * FROM caldav_tokens WHERE id = ?').get(id);

export const getCalDavTokenByHash = hash =>
  db.prepare('SELECT * FROM caldav_tokens WHERE token_hash = ? AND revoked_at IS NULL').get(hash);

export const listCalDavTokens = userId =>
  db.prepare('SELECT id, label, created_at, revoked_at, last_used_at FROM caldav_tokens WHERE user_id = ? ORDER BY id').all(userId);

export const revokeCalDavToken = (id, userId) =>
  db.prepare('UPDATE caldav_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .run(now(), id, userId).changes;

export const touchCalDavToken = id =>
  db.prepare('UPDATE caldav_tokens SET last_used_at = ? WHERE id = ?').run(now(), id);

// ---------- caldav colors ----------
export function listCalDavColors(userId) {
  const out = {};
  for (const row of db.prepare('SELECT calendar_key, color FROM caldav_colors WHERE user_id = ?').all(userId)) {
    out[row.calendar_key] = row.color;
  }
  return out;
}

export const setCalDavColor = (userId, calendarKey, color) =>
  db.prepare(`INSERT INTO caldav_colors (user_id, calendar_key, color, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, calendar_key) DO UPDATE SET color = excluded.color, updated_at = excluded.updated_at`)
    .run(userId, calendarKey, color, now());

export const deleteCalDavColor = (userId, calendarKey) =>
  db.prepare('DELETE FROM caldav_colors WHERE user_id = ? AND calendar_key = ?')
    .run(userId, calendarKey).changes > 0;

// ---------- cleanup ----------
export function cleanup() {
  const t = now();
  db.prepare('DELETE FROM auth_codes WHERE expires_at < ?').run(t - 3600);
  db.prepare('DELETE FROM access_tokens WHERE expires_at < ?').run(t - 86400);
  db.prepare('DELETE FROM refresh_tokens WHERE expires_at < ?').run(t - 86400);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(t);
}
