import { config, SCOPES } from './config.mjs';
import { randomToken, hashToken, safeEqual, sha256b64url, now } from './crypto.mjs';
import * as db from './db.mjs';

export class OAuthError extends Error {
  constructor(status, error, description = '', headers = {}) {
    super(description || error);
    this.status = status;
    this.error = error;
    this.headers = headers;
  }
}

export const parseScopes = v => [...new Set(String(v || '').split(/\s+/).filter(Boolean))];
export const isSubset = (a, b) => a.every(x => b.includes(x));

export function authenticateClient(req, input = {}) {
  let clientId = input.client_id || '';
  let clientSecret = input.client_secret || '';
  const auth = req.headers.authorization || '';
  if (/^Basic /i.test(auth)) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx >= 0) {
      clientId = decoded.slice(0, idx);
      clientSecret = decoded.slice(idx + 1);
    }
  }
  if (!clientId) throw new OAuthError(401, 'invalid_client', 'client_id required');
  const client = db.getClient(clientId);
  if (!client) throw new OAuthError(401, 'invalid_client', 'unknown client');

  if (client.public) {
    if (clientSecret) throw new OAuthError(401, 'invalid_client', 'public client must not use a secret');
    return client;
  }
  if (!clientSecret) throw new OAuthError(401, 'invalid_client', 'client_secret required');
  if (!safeEqual(hashToken(clientSecret), client.secret_hash || '')) {
    throw new OAuthError(401, 'invalid_client', 'invalid client_secret');
  }
  return client;
}

function issueTokens({ client, user, scopes, withRefresh, familyId }) {
  const access = randomToken(32);
  db.createAccessToken({
    tokenHash: hashToken(access),
    clientId: client.client_id,
    userId: user.id,
    scopes,
    expiresAt: now() + config.accessTtl,
  });

  const out = {
    access_token: access,
    token_type: 'Bearer',
    expires_in: config.accessTtl,
    scope: scopes.join(' '),
  };

  if (withRefresh) {
    const refresh = randomToken(40);
    db.createRefreshToken({
      tokenHash: hashToken(refresh),
      clientId: client.client_id,
      userId: user.id,
      scopes,
      familyId: familyId || randomToken(16),
      expiresAt: now() + config.refreshTtl,
    });
    out.refresh_token = refresh;
  }
  return out;
}

export function validateAuthorize(query) {
  const responseType = query.get('response_type');
  if (responseType !== 'code') throw new OAuthError(400, 'unsupported_response_type', 'only code is supported');

  const clientId = query.get('client_id') || '';
  const redirectUri = query.get('redirect_uri') || '';
  const state = query.get('state') || '';
  const client = db.getClient(clientId);
  if (!client) throw new OAuthError(400, 'invalid_request', 'unknown client_id');

  const allowedUris = JSON.parse(client.redirect_uris);
  if (!allowedUris.includes(redirectUri)) {
    throw new OAuthError(400, 'invalid_request', 'redirect_uri is not registered');
  }

  const clientScopes = parseScopes(client.scopes);
  const requested = query.get('scope') ? parseScopes(query.get('scope')) : clientScopes.filter(s => s !== 'offline_access');
  if (!isSubset(requested, clientScopes)) throw new OAuthError(400, 'invalid_scope', 'scope not allowed for this client');

  const challenge = query.get('code_challenge') || '';
  const method = query.get('code_challenge_method') || '';
  if (challenge && method !== 'S256') throw new OAuthError(400, 'invalid_request', 'only S256 is supported');
  if (client.public && (!challenge || method !== 'S256')) {
    throw new OAuthError(400, 'invalid_request', 'public clients must use PKCE S256');
  }

  return { client, redirectUri, state, scopes: requested, challenge, method, responseType };
}

export function authorize({ query, user }) {
  const details = validateAuthorize(query);
  if (!user) throw new OAuthError(503, 'temporarily_unavailable', 'no user logged in');
  if (user.disabled) throw new OAuthError(403, 'access_denied', 'user disabled');

  const code = randomToken(32);
  db.createAuthCode({
    codeHash: hashToken(code),
    clientId: details.client.client_id,
    userId: user.id,
    redirectUri: details.redirectUri,
    scopes: details.scopes,
    codeChallenge: details.challenge || null,
    codeChallengeMethod: details.challenge ? 'S256' : null,
    expiresAt: now() + config.codeTtl,
  });

  const url = new URL(details.redirectUri);
  url.searchParams.set('code', code);
  if (details.state) url.searchParams.set('state', details.state);
  return url.toString();
}

function authorizationCode(req, input) {
  const client = authenticateClient(req, input);
  const code = input.code || '';
  const redirectUri = input.redirect_uri || '';
  const verifier = input.code_verifier || '';

  const row = db.getAuthCode(hashToken(code));
  if (!row) throw new OAuthError(400, 'invalid_grant', 'invalid code');
  if (row.used_at) throw new OAuthError(400, 'invalid_grant', 'code already used');
  if (row.expires_at < now()) throw new OAuthError(400, 'invalid_grant', 'code expired');
  if (row.client_id !== client.client_id) throw new OAuthError(400, 'invalid_grant', 'client mismatch');
  if (row.redirect_uri !== redirectUri) throw new OAuthError(400, 'invalid_grant', 'redirect_uri mismatch');

  if (row.code_challenge) {
    if (!verifier) throw new OAuthError(400, 'invalid_grant', 'code_verifier required');
    if (sha256b64url(verifier) !== row.code_challenge) throw new OAuthError(400, 'invalid_grant', 'PKCE verification failed');
  } else if (client.public) {
    throw new OAuthError(400, 'invalid_grant', 'PKCE required');
  }

  if (db.markAuthCodeUsed(row.code_hash) === 0) throw new OAuthError(400, 'invalid_grant', 'code already used');

  const user = db.getUserById(row.user_id);
  if (!user || user.disabled) throw new OAuthError(400, 'invalid_grant', 'user not found or disabled');
  const scopes = parseScopes(row.scopes);
  return issueTokens({ client, user, scopes, withRefresh: scopes.includes('offline_access') });
}

function refreshTokenGrant(req, input) {
  const client = authenticateClient(req, input);
  const token = input.refresh_token || '';
  const row = db.getRefreshToken(hashToken(token));

  if (!row) throw new OAuthError(400, 'invalid_grant', 'invalid refresh_token');
  if (row.client_id !== client.client_id) throw new OAuthError(400, 'invalid_grant', 'client mismatch');
  if (row.revoked_at) {
    // 重放已轮换的 refresh token：整个 family 作废
    db.revokeRefreshFamily(row.family_id);
    throw new OAuthError(400, 'invalid_grant', 'refresh_token reused');
  }
  if (row.expires_at < now()) throw new OAuthError(400, 'invalid_grant', 'refresh_token expired');

  const original = parseScopes(row.scopes);
  const requested = input.scope ? parseScopes(input.scope) : original;
  if (!isSubset(requested, original)) throw new OAuthError(400, 'invalid_scope', 'scope expansion is not allowed');

  db.revokeRefreshToken(row.token_hash);
  const user = db.getUserById(row.user_id);
  if (!user || user.disabled) throw new OAuthError(400, 'invalid_grant', 'user not found or disabled');
  return issueTokens({ client, user, scopes: requested, withRefresh: true, familyId: row.family_id });
}

function clientCredentialsGrant(req, input) {
  const client = authenticateClient(req, input);
  if (client.public) throw new OAuthError(400, 'unauthorized_client', 'public clients cannot use client_credentials');

  const user = db.getUserById(client.user_id);
  if (!user || user.disabled) throw new OAuthError(503, 'temporarily_unavailable', 'client has no active user');

  const allowed = parseScopes(client.scopes).filter(s => s !== 'offline_access');
  const requested = input.scope ? parseScopes(input.scope) : allowed;
  if (!isSubset(requested, allowed)) throw new OAuthError(400, 'invalid_scope', 'scope not allowed');

  return issueTokens({ client, user, scopes: requested, withRefresh: false });
}

export function token({ req, input }) {
  switch (input.grant_type) {
    case 'authorization_code': return authorizationCode(req, input);
    case 'refresh_token': return refreshTokenGrant(req, input);
    case 'client_credentials': return clientCredentialsGrant(req, input);
    default: throw new OAuthError(400, 'unsupported_grant_type', 'unsupported grant_type');
  }
}

export function authenticateBearer(req) {
  const header = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) throw new OAuthError(401, 'invalid_token', 'missing bearer token', { 'WWW-Authenticate': 'Bearer error="invalid_token"' });

  const row = db.getAccessToken(hashToken(m[1].trim()));
  if (!row) throw new OAuthError(401, 'invalid_token', 'unknown token', { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
  if (row.revoked_at) throw new OAuthError(401, 'invalid_token', 'token revoked', { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
  if (row.expires_at < now()) throw new OAuthError(401, 'invalid_token', 'token expired', { 'WWW-Authenticate': 'Bearer error="invalid_token"' });

  const client = db.getClient(row.client_id);
  const user = db.getUserById(row.user_id);
  if (!client || !user || user.disabled) {
    throw new OAuthError(401, 'invalid_token', 'token subject missing or disabled', { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
  }

  return { token: m[1].trim(), client, user, scopes: parseScopes(row.scopes) };
}

export function revoke({ req, input }) {
  const client = authenticateClient(req, input);
  const token = input.token || '';
  const hint = input.token_type_hint;

  if (hint !== 'refresh_token') {
    const a = db.getAccessToken(hashToken(token));
    if (a && a.client_id === client.client_id) db.revokeAccessToken(a.token_hash);
  }
  if (hint !== 'access_token') {
    const r = db.getRefreshToken(hashToken(token));
    if (r && r.client_id === client.client_id) {
      db.revokeRefreshFamily(r.family_id);
    }
  }
  return { ok: true };
}

export const metadata = () => ({
  issuer: config.issuer,
  authorization_endpoint: `${config.issuer}/oauth/authorize`,
  token_endpoint: `${config.issuer}/oauth/token`,
  revocation_endpoint: `${config.issuer}/oauth/revoke`,
  userinfo_endpoint: `${config.issuer}/oauth/userinfo`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'],
  scopes_supported: SCOPES,
  token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
  code_challenge_methods_supported: ['S256'],
});
