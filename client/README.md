# 强智 Gateway 客户端

零依赖客户端，浏览器和 Node 18+ 都能用（依赖全局 `fetch` / `crypto.subtle`）。

```js
import { QZGWClient, QZGWError } from './client/index.mjs';
```

## 1. Client Credentials（服务端/脚本）

客户端在服务端注册时绑定了一个用户：

```bash
node scripts/admin.mjs add-client --name demo --redirect https://example.com/cb --scopes jwxt.read,offline_access --user alice
```

```js
const client = new QZGWClient({
  baseUrl: 'http://localhost:8787',
  clientId: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
});

await client.clientCredentials({ scopes: ['jwxt.read'] });

const me = await client.me();
const semesters = await client.semesters();
const timetable = await client.timetable({ semester: '2026-2027-1' });
const grades = await client.grades({ semester: '2026-2027-1' });
```

## 2. Authorization Code + PKCE（浏览器）

服务端注册一个公开客户端（`--public`），并允许它的来源（`CORS_ORIGINS`）。

```js
const client = new QZGWClient({
  baseUrl: 'http://localhost:8787',
  clientId: 'qz_xxx',
  redirectUri: location.origin + '/callback',
});

const pkce = await QZGWClient.createPkce();
sessionStorage.setItem('pkce', pkce.verifier);
sessionStorage.setItem('state', crypto.randomUUID());

location.href = client.authorizationUrl({
  scopes: ['jwxt.read', 'offline_access'],
  state: sessionStorage.getItem('state'),
  codeChallenge: pkce.challenge,
});
```

回调页：

```js
const params = new URLSearchParams(location.search);
if (params.get('state') !== sessionStorage.getItem('state')) throw new Error('state mismatch');
await client.exchangeCode({
  code: params.get('code'),
  codeVerifier: sessionStorage.getItem('pkce'),
});
const me = await client.me();
```

服务端会先要求登录（`/login`），再显示授权确认页。

## 3. 自动刷新

token 响应带 `refresh_token` 时（需要 `offline_access`），客户端会在过期前 60 秒或收到 401 时自动 `refresh()` 并重试一次。

```js
const tokens = await client.exchangeCode({ code, codeVerifier });
console.log(tokens.refreshToken);
```

## 4. 持久化

默认只在内存里。传一个 `storage` 即可持久化（例如 localStorage）：

```js
const storage = {
  get: key => JSON.parse(localStorage.getItem(key) || 'null'),
  set: (key, value) => value ? localStorage.setItem(key, JSON.stringify(value)) : localStorage.removeItem(key),
};

const client = new QZGWClient({
  baseUrl: 'http://localhost:8787',
  clientId: 'qz_xxx',
  redirectUri: location.origin + '/callback',
  storage,
});
await client.load(); // 读取上次的 token
```

Node 里可以存到文件/数据库，接口同样是 `get/set`。

## 5. API

| 方法 | 对应接口 |
|---|---|
| `me()` | `GET /api/me` |
| `profile()` | `GET /api/profile` |
| `semesters()` | `GET /api/semesters` |
| `weekRange({semester})` | `GET /api/week-range` |
| `timetable({semester, week})` | `GET /api/timetable` |
| `grades({semester})` | `GET /api/grades` |
| `exams({semester})` | `GET /api/exams` |
| `textbooks()` | `GET /api/textbooks` |
| `planCourses()` | `GET /api/courses/plan` |
| `messages()` | `GET /api/messages` |
| `notices()` | `GET /api/notices` |
| `api(path, options)` | 任意受保护路径 |

所有方法返回 API 的 `data` 字段；错误抛 `QZGWError`：

```js
try {
  await client.timetable();
} catch (e) {
  if (e instanceof QZGWError) {
    console.error(e.status, e.error, e.description);
  }
}
```

## 6. 撤销

```js
await client.revoke(); // 撤销 access token
await client.revoke({ token: client.tokens?.refreshToken, tokenType: 'refresh_token' });
```

## 注意

- 浏览器使用需要服务端 `CORS_ORIGINS` 放行页面来源。
- `client_secret` 绝不能放在浏览器；浏览器用公开客户端 + PKCE。
- 生产环境走 HTTPS；`baseUrl` 与服务端 `ISSUER` 保持一致。
