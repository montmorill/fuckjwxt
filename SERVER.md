# jwxt-oauth

把强智教务账号封装成受 **OAuth 2.0** 保护的数据 API。单账号、零 npm 依赖（Node 24 内置 `node:http` / `node:sqlite` / `node:crypto`）。

## 特性

- 账号密码 **AES-256-GCM 加密落库**，主密钥只放环境变量，不进数据库、不进日志。
- OAuth2：
  - Authorization Code + PKCE（S256）
  - Client Credentials
  - Refresh Token 轮换 + 重放检测（重放会作废整个 family）
  - Revocation、Authorization Server Metadata
- 访问令牌 1 小时、刷新令牌 30 天；令牌只存 SHA-256 哈希。
- 教务会话缓存 15 分钟；过期或请求失败自动重新登录。
- 管理 API + 本地 CLI。
- 自带 **OpenAPI 3.0** 描述（`GET /openapi.json`），可直接导入 Postman / Apifox / Swagger Editor。
- **只读 CalDAV**：课表可直接添加到 iOS/Android/Thunderbird 日历（`CALDAV_TOKEN` 启用），见 [`CALDAV.md`](CALDAV.md)。
- 单账号自动同意（见“安全模型”）。

## 快速开始

```powershell
Copy-Item .env.example .env
# 填入 JWXT_ACCOUNT / JWXT_PASSWORD，并生成下面两个值
node scripts/admin.mjs gen-key      # 填入 MASTER_KEY
node scripts/admin.mjs gen-token    # 填入 ADMIN_TOKEN
npm start                           # 或 node --no-warnings server/index.mjs
```

启动时如果数据库里还没有账号、而 `.env` 里有 `JWXT_ACCOUNT/JWXT_PASSWORD`，会加密导入（不打印密码）。

注册客户端（管理 API）：

```bash
curl -sS -X POST http://localhost:8787/admin/clients \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"demo","redirectUris":["http://localhost:3000/cb"],"scopes":["jwxt.read","offline_access"]}'
```

返回的 `client_secret` 只显示一次。也可以直接用 CLI：

```bash
node scripts/admin.mjs add-client --name demo --redirect http://localhost:3000/cb --scopes jwxt.read,offline_access
```

## OAuth 流程

### 1. Authorization Code + PKCE（公开客户端）

生成 verifier/challenge：

```js
const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
```

浏览器打开（单账号会自动同意，直接 302 回 `redirect_uri`）：

```
GET /oauth/authorize?response_type=code
  &client_id=<client_id>
  &redirect_uri=http://localhost:3000/cb
  &scope=jwxt.read offline_access
  &state=xyz
  &code_challenge=<challenge>
  &code_challenge_method=S256
```

拿到 `code` 后换令牌：

```bash
curl -sS -X POST http://localhost:8787/oauth/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d grant_type=authorization_code \
  -d client_id=$CLIENT_ID \
  -d code=$CODE \
  -d redirect_uri=http://localhost:3000/cb \
  -d code_verifier=$VERIFIER
```

```json
{
  "access_token": "…",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "jwxt.read offline_access",
  "refresh_token": "…"
}
```

### 2. Client Credentials（机密客户端/机器对机器）

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

旧 refresh token 立即失效；若被重放，整个 family 作废。

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

- **从路由元数据生成**：`server/openapi.mjs` 定义每个路径/方法/scope/参数，`openapi.base.json` 保存 schema 与 security 基座。
- 生成：`npm run openapi`（可用 `ISSUER=https://your.domain npm run openapi` 生成外部地址）。
- 校验：`npm run openapi:check` —— 仓库里的 `openapi.json` 必须与源码生成结果完全一致，否则退出非 0（适合放 CI / 提交前钩子）。
- 本地钩子：`npm run hooks` 配置 `.githooks/pre-commit`；OpenAPI 相关文件被 staged 时自动校验（改了源但没 stage 生成的 spec 也会拦下）。
- 服务端启动时用同一份元数据构建 spec；并校验“实际注册的每条路由都必须有 OpenAPI 条目”，漏了会直接启动失败。
- 覆盖：OAuth 端点、数据 API、管理 API、错误响应、scope、请求/响应 schema。
- 可导入 Postman / Apifox / Swagger Editor。

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
| `GET /api/courses/plan` | — | 培养方案 90 门 |
| `GET /api/messages` | — | `{count,data}` |
| `GET /api/notices` | — | `{count,data}` |

成功响应统一 `{"data": …}`；错误统一：

```json
{"error":"invalid_token","error_description":"token expired"}
```

## 管理 API

所有管理请求带 `Authorization: Bearer $ADMIN_TOKEN`（或 `X-Admin-Token`）。

| 接口 | 说明 |
|---|---|
| `PUT /admin/account` | `{account,password,baseUrl?,verify?}`；默认先验证再落库 |
| `GET /admin/account` | 返回账号（不含密码） |
| `POST /admin/clients` | `{name,redirectUris,scopes?,public?}`，返回一次 `client_secret` |
| `GET /admin/clients` | 客户端列表 |
| `DELETE /admin/clients/:id` | 删除客户端 |

CLI 等价命令见 `node scripts/admin.mjs`。

## 安全模型

- 密码：AES-256-GCM，随机 IV，AAD 固定；`MASTER_KEY` 只在环境变量。
- 客户端 secret：只存 SHA-256，创建时返回一次。
- access/refresh token：只存 SHA-256；refresh 轮换 + 重放检测。
- 授权码：60 秒、单次使用、绑定 client/redirect_uri、PKCE。
- 管理接口：独立 `ADMIN_TOKEN`；令牌/管理接口按 IP 限流。
- CORS 默认关闭，按 `CORS_ORIGINS` 放行。
- **单账号自动同意**：授权页不询问用户，任何已注册客户端都能直接拿 code。只注册可信客户端，并严格校验 redirect URI / secret / PKCE。
- 生产环境务必用 HTTPS 反代，并把 `ISSUER` 改成外部地址；`bzb_*` 会话 Cookie 本身没有 `Secure`，但这里的 OAuth 令牌不依赖它。
- 威胁模型：数据库 + `MASTER_KEY` 同时泄露 = 教务密码泄露。轮换 `MASTER_KEY` 需要重新加密已有记录（未自动化）。

## 目录

```
server/
  config.mjs        环境变量与常量
  crypto.mjs        AES-GCM / 随机令牌 / 哈希
  db.mjs            SQLite schema 与查询
  jwxt-service.mjs  教务登录 + 会话缓存 + 数据封装
  oauth.mjs         OAuth2 逻辑
  api.mjs           受保护的数据接口
  index.mjs         HTTP 服务与路由
scripts/
  admin.mjs         gen-key / gen-token / set-account / add-client / list-clients
```

## 已验证

本地端到端 20 项通过：授权码 + PKCE、code 单次使用、client_credentials、refresh 轮换与重放、revoke、无效令牌、scope 403、元数据、密码密文落库与解密还原、令牌哈希存储。
