// 强智 Gateway 客户端（浏览器 / Node 18+，零依赖）。
// 支持：client_credentials、authorization_code + PKCE、refresh、revoke、API 封装。
export class QzgwError extends Error {
  constructor(status, error, description) {
    super(description || error);
    this.name = 'QzgwError';
    this.status = status;
    this.error = error;
    this.description = description || '';
  }
}

const STORAGE_KEY = 'jwxt_tokens';

function base64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function normalizeBase(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '');
}

export class QzgwClient {
  constructor({
    baseUrl,
    clientId,
    clientSecret = null,
    redirectUri = null,
    fetch: fetchImpl = globalThis.fetch,
    storage = null,
    tokens = null,
  } = {}) {
    if (!baseUrl) throw new Error('baseUrl is required');
    if (!clientId) throw new Error('clientId is required');
    if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');
    this.baseUrl = normalizeBase(baseUrl);
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.fetch = fetchImpl;
    this.storage = storage;
    this.tokens = tokens;
  }

  // ---------- PKCE ----------
  static async createPkce() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const verifier = base64url(bytes);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return { verifier, challenge: base64url(new Uint8Array(digest)) };
  }

  authorizationUrl({
    scopes = [],
    state = '',
    codeChallenge = '',
    codeChallengeMethod = 'S256',
    redirectUri = this.redirectUri,
    extraParams = {},
  } = {}) {
    if (!redirectUri) throw new Error('redirectUri is required');
    const p = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: redirectUri,
    });
    const scope = Array.isArray(scopes) ? scopes.join(' ') : String(scopes || '');
    if (scope) p.set('scope', scope);
    if (state) p.set('state', state);
    if (codeChallenge) {
      p.set('code_challenge', codeChallenge);
      p.set('code_challenge_method', codeChallengeMethod);
    }
    for (const [k, v] of Object.entries(extraParams)) {
      if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
    }
    return `${this.baseUrl}/oauth/authorize?${p.toString()}`;
  }

  // ---------- token ----------
  async _tokenRequest(form) {
    const res = await this.fetch(`${this.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new QzgwError(res.status, body.error || 'token_error', body.error_description || res.statusText);
    }
    this.tokens = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      expiresAt: Date.now() + Number(body.expires_in || 3600) * 1000,
      scope: body.scope || '',
    };
    await this.save();
    return this.tokens;
  }

  async clientCredentials({ scopes = [] } = {}) {
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
    });
    if (this.clientSecret) form.set('client_secret', this.clientSecret);
    const scope = Array.isArray(scopes) ? scopes.join(' ') : String(scopes || '');
    if (scope) form.set('scope', scope);
    return this._tokenRequest(form);
  }

  async exchangeCode({ code, codeVerifier, redirectUri = this.redirectUri } = {}) {
    if (!code) throw new Error('code is required');
    if (!redirectUri) throw new Error('redirectUri is required');
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: this.clientId,
      code,
      redirect_uri: redirectUri,
    });
    if (this.clientSecret) form.set('client_secret', this.clientSecret);
    if (codeVerifier) form.set('code_verifier', codeVerifier);
    return this._tokenRequest(form);
  }

  async refresh() {
    if (!this.tokens?.refreshToken) throw new QzgwError(401, 'no_refresh_token', 'no refresh token');
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.clientId,
      refresh_token: this.tokens.refreshToken,
    });
    if (this.clientSecret) form.set('client_secret', this.clientSecret);
    return this._tokenRequest(form);
  }

  async revoke({ token = this.tokens?.accessToken, tokenType = 'access_token' } = {}) {
    if (!token) return;
    const form = new URLSearchParams({
      token,
      token_type_hint: tokenType,
      client_id: this.clientId,
    });
    if (this.clientSecret) form.set('client_secret', this.clientSecret);
    const res = await this.fetch(`${this.baseUrl}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new QzgwError(res.status, body.error || 'revoke_error', body.error_description || res.statusText);
    }
    this.tokens = null;
    await this.save();
  }

  async ensureAccessToken() {
    if (!this.tokens?.accessToken) {
      throw new QzgwError(401, 'no_token', 'call clientCredentials() or exchangeCode() first');
    }
    if (this.tokens.refreshToken && this.tokens.expiresAt < Date.now() + 60_000) {
      await this.refresh();
    }
    return this.tokens.accessToken;
  }

  // ---------- storage ----------
  async load() {
    if (!this.storage) return this.tokens;
    try {
      const stored = await this.storage.get?.(STORAGE_KEY);
      if (stored) this.tokens = stored;
    } catch { /* ignore storage errors */ }
    return this.tokens;
  }

  async save() {
    if (!this.storage) return;
    try { await this.storage.set?.(STORAGE_KEY, this.tokens); } catch { /* ignore */ }
  }

  // ---------- API ----------
  async api(path, { query = {}, method = 'GET', body, retry = true } = {}) {
    const accessToken = await this.ensureAccessToken();
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    const res = await this.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));

    if (res.status === 401 && retry && this.tokens?.refreshToken) {
      await this.refresh();
      return this.api(path, { query, method, body, retry: false });
    }
    if (!res.ok) {
      throw new QzgwError(res.status, json.error || 'api_error', json.error_description || res.statusText);
    }
    return json.data;
  }

  me() { return this.api('/api/me'); }
  profile() { return this.api('/api/profile'); }
  semesters() { return this.api('/api/semesters'); }
  weekRange({ semester } = {}) { return this.api('/api/week-range', { query: { semester } }); }
  timetable({ semester, week } = {}) { return this.api('/api/timetable', { query: { semester, week } }); }
  grades({ semester } = {}) { return this.api('/api/grades', { query: { semester } }); }
  exams({ semester } = {}) { return this.api('/api/exams', { query: { semester } }); }
  textbooks() { return this.api('/api/textbooks'); }
  planCourses() { return this.api('/api/courses/plan'); }
  messages() { return this.api('/api/messages'); }
  notices() { return this.api('/api/notices'); }
}

export default QzgwClient;
