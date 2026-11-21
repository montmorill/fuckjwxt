# jwxt-oauth

把强智教务账号封装成受 **OAuth 2.0** 保护的多用户数据 API。零 npm 依赖（Node 24 内置 `node:http` / `node:sqlite` / `node:crypto`）。

## 特性

- **多用户**：每个用户有独立的教务账号、服务登录密码、OAuth token、CalDAV token。
- 教务密码 **AES-256-GCM 加密落库**；服务登录密码 **scrypt**；主密钥只放环境变量。
- OAuth2：
  - Authorization Code + PKCE（S256）+ 服务登录 + 授权确认页
  - Client Credentials（每个客户端绑定一个用户）
  - Refresh Token 轮换 + 重放检测（重放作废整个 family）
  - Revocation、Authorization Server Metadata
- 访问令牌 1 小时、刷新令牌 30 天；令牌只存 SHA-256 哈希。
- 教务会话缓存 15 分钟；过期或请求失败自动重新登录。
- **只读 CalDAV**：每个用户独立用户名 + 多个可撤销 app token，见 [`CALDAV.md`](CALDAV.md)。
- 管理 API + 本地 CLI。
- 客户端 SDK：`sdk/index.mjs`（浏览器/Node，PKCE、自动刷新、API 封装）。
- OpenAPI 3.0（`GET /openapi.json`，`npm run openapi` 生成，`npm run openapi:check` 校验）。

## 快速开始

```powershell
Copy-Item .env.example .env
node scripts/admin.mjs gen-key      # 填入 MASTER_KEY
node scripts/admin.mjs gen-token    # 填入 ADMIN_TOKEN

# 创建第一个用户（会校验教务密码并写入 SQLite）
node scripts/admin.mjs add-user `
  --username alice `
  --account <学号> `
  --password '<教务密码>' `
  --service-password '<服务密码>'

npm start
```

- 服务端**不再从 `.env` 导入用户**；用户必须通过 CLI 或 `POST /admin/users` 创建。
- 打开 `http://localhost:8787/login`，用用户自己的用户名 + 服务密码登录。
- **不兼容旧版单用户数据库**：升级请删除 `data/jwxt-oauth.db`。

### 添加更多用户

CLI：

```bash
node scripts/admin.mjs add-user \
  --username alice \
  --account 202600000001 \
  --password '<教务密码>' \
  --service-password '<服务密码>' \
  --display-name 'Alice'
```

或管理 API：

```bash
curl -X POST http://localhost:8787/admin/users \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","account":"202600000001","password":"...","servicePassword":"...","displayName":"Alice"}'
```

`verify` 默认 `true`（先登录教务验证再落库）；测试数据可传 `"verify": false`。

`caldavSemester` 可选，格式如 `2026-2027-1`；不设置时 CalDAV 使用当前学期。

### 给用户签发 CalDAV token

```bash
node scripts/admin.mjs add-caldav-token <user_id> --label phone
# 或
curl -X POST http://localhost:8787/admin/users/<user_id>/caldav-tokens \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{"label":"phone"}'
```

返回的 token 只显示一次，作为 CalDAV Basic 密码；可签发多个、单独撤销。

### 注册客户端

```bash
node scripts/admin.mjs add-client \
  --name demo \
  --redirect http://localhost:3000/cb \
  --scopes jwxt.read,offline_access \
  --user alice
```

- `--user` 必填，客户端必须绑定一个用户。
- `client_credentials` 会为该绑定用户签发 token。

## OAuth 流程

### 1. Authorization Code + PKCE

1. 浏览器打开 `/oauth/authorize?...`；
2. 未登录 → 302 到 `/login?next=...`；
3. 登录后 → 授权确认页，展示客户端名称和 scopes；
4. 点“同意” → 302 回 `redirect_uri`，带 `code` 和原 `state`。

```js
const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
```

```
GET /oauth/authorize?response_type=code
  &client_id=<client_id>
  &redirect_uri=http://localhost:3000/cb
  &scope=jwxt.read offline_access
  &state=xyz
  &code_challenge=<challenge>
  &code_challenge_method=S256
```

换令牌：

```bash
curl -sS -X POST http://localhost:8787/oauth/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d grant_type=authorization_code \
  -d client_id=$CLIENT_ID \
  -d code=$CODE \
  -d redirect_uri=http://localhost:3000/cb \
  -d code_verifier=$VERIFIER
```

code 绑定当前登录用户；`/api/*` 返回的是该用户的数据。

### 2. Client Credentials

客户端在注册时绑定了用户，`client_credentials` 直接为该用户签发 token：

```bash
curl -sS -X POST http://localhost:8787/oauth/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d grant_type=client_credentials \
  -d client_id=$CLIENT_ID \
  -d client_secret=$CLIENT_SECRET \
  -d scope='jwxt.read'
```

### 3. Refresh

```bash
curl -sS -X POST http://localhost:8787/oauth/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d grant_type=refresh_token \
  -d client_id=$CLIENT_ID \
  -d refresh_token=$REFRESH_TOKEN
```

旧 refresh token 立即失效；重放会作废整个 family。

### 4. 撤销

```bash
curl -sS -X POST http://localhost:8787/oauth/revoke \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d token=$ACCESS_OR_REFRESH_TOKEN \
  -d client_id=$CLIENT_ID \
  -d client_secret=$CLIENT_SECRET   # 公开客户端不需要
```

### 5. Metadata

```
GET /.well-known/oauth-authorization-server
```

## OpenAPI

```
GET /openapi.json
```

- 路径元数据在 `server/openapi.mjs`，schema 基座在 `openapi.base.json`。
- 生成：`npm run openapi`（`ISSUER=https://your.domain npm run openapi` 生成外部地址）。
- 校验：`npm run openapi:check`，不一致退出非 0；pre-commit 钩子自动跑。
- 服务启动时校验“实际注册的每条路由都有 OpenAPI 条目”。

`/login`、`/logout`、`POST /oauth/authorize` 是 HTML 表单流程，未纳入 OpenAPI。

## Scope

| scope | 作用 |
|---|---|
| `jwxt.read` | 课表、成绩、考试、教材、培养方案课程、消息、公告 |
| `jwxt.profile` | 个人信息（含姓名等 PII） |
| `offline_access` | 签发 refresh token |

## 数据 API（Bearer）

| 接口 | 参数 | 返回 |
|---|---|---|
| `GET /api/me` | — | `{sub, account, client_id, scopes}` |
| `GET /api/profile` | — | `{studentId, name, gender, college, major, className, grade}`（需 `jwxt.profile`） |
| `GET /api/semesters` | — | `[{value,label,selected}]` |
| `GET /api/week-range` | `semester` | `{qszc,jszc}` |
| `GET /api/timetable` | `semester`, `week` | 课表数组（含 `rawHtml/rawText`） |
| `GET /api/grades` | `semester` | `{code,count,data,meta}` |
| `GET /api/exams` | `semester` | `{final, courseEnd}` |
| `GET /api/textbooks` | — | 教材数组 |
| `GET /api/courses/plan` | — | 培养方案课程 |
| `GET /api/messages` | — | `{count,data}` |
| `GET /api/notices` | — | `{count,data}` |

成功响应 `{"data": …}`；错误 `{"error":"…","error_description":"…"}`。

## 管理 API

带 `Authorization: Bearer $ADMIN_TOKEN`（或 `X-Admin-Token`）。

| 接口 | 说明 |
|---|---|
| `GET /admin/users` | 用户列表 |
| `POST /admin/users` | 创建用户 `{username,account,password,servicePassword?,displayName?,baseUrl?,caldavSemester?,verify?}` |
| `PUT /admin/users/:userId` | 更新用户（账号/密码/服务密码/禁用/CalDAV 学期） |
| `DELETE /admin/users/:userId` | 删除用户（级联删除会话/CalDAV token） |
| `POST /admin/users/:userId/caldav-tokens` | 签发 CalDAV token（只返回一次） |
| `GET /admin/users/:userId/caldav-tokens` | token 列表 |
| `DELETE /admin/users/:userId/caldav-tokens/:tokenId` | 撤销 token |
| `POST /admin/clients` | `{name,redirectUris,scopes?,public?,userId?/username?}` |
| `GET /admin/clients` | 客户端列表（含绑定用户） |
| `DELETE /admin/clients/:clientId` | 删除客户端 |

CLI：`node scripts/admin.mjs` 查看全部命令。

## 安全模型

- 教务密码：AES-256-GCM；`MASTER_KEY` 只在环境变量。
- 服务登录密码：scrypt + 随机 salt，存 `users.service_password_hash`。
- 服务会话：`jwo_sid` HttpOnly + SameSite=Lax；HTTPS 下自动加 `Secure`；登录后轮换 session、CSRF 校验。
- 客户端 secret：只存 SHA-256，创建时返回一次。
- access/refresh token：只存 SHA-256；refresh 轮换 + 重放检测。
- 授权码：60 秒、单次使用、绑定 client/redirect_uri/user、PKCE。
- CalDAV：每个用户独立用户名 + 多个 token（只存 SHA-256）；Basic 密码也可直接使用该用户的强智密码；路径只能访问自己的 principal/calendar。
- 管理接口：独立 `ADMIN_TOKEN`；登录/管理接口限流。
- CORS 默认关闭，按 `CORS_ORIGINS` 放行。
- 生产环境务必用 HTTPS 反代，并把 `ISSUER` 改成外部地址。
- 威胁模型：数据库 + `MASTER_KEY` 同时泄露 = 教务密码泄露。轮换 `MASTER_KEY` 需要重新加密已有记录（未自动化）。

## 目录

```
sdk/
  index.mjs         客户端 SDK
  index.d.ts        TypeScript 类型
server/
  config.mjs        环境变量与常量
  crypto.mjs        AES-GCM / scrypt / 随机令牌 / 哈希
  db.mjs            SQLite schema、迁移与查询
  auth.mjs          服务登录会话、CSRF、登录/授权确认页
  jwxt-service.mjs  教务登录 + 会话缓存 + 数据封装
  oauth.mjs         OAuth2 逻辑
  api.mjs           受保护的数据接口
  caldav.mjs        只读 CalDAV
  openapi.mjs       OpenAPI 路由元数据
  index.mjs         HTTP 服务与路由
scripts/
  admin.mjs         密钥/用户/CalDAV token/客户端管理
```

## 已验证

- OAuth 端到端 **38 项**：服务登录、授权确认、PKCE、code 单次、多用户绑定、client_credentials、refresh 轮换/重放、revoke、CalDAV 隔离与强智密码登录等。
- CalDAV **10 项**：PROPFIND/REPORT/GET、ETag/304、错误密码 401。
- SDK **11 项**：client_credentials、me/semesters/timetable/grades、PKCE、authorizationUrl、错误、storage。
