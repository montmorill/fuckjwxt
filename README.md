# 强智 Gateway

山东科技大学强智教务系统（`jwglxt.sdust.edu.cn`）的协议研究，以及把账号包装成 **多用户 OAuth 2.0 数据 API** 的服务端。

## 文档

- [`docs/NOTES.md`](docs/NOTES.md) —— 登录流程、`scode/sxh` 编码、`ticqzket` 实测
- [`docs/API.md`](docs/API.md) —— 登录后可用接口清单、参数、返回结构
- [`docs/SERVER.md`](docs/SERVER.md) —— OAuth2 网关的部署、管理 API、数据 API
- [`openapi.json`](openapi.json) —— OpenAPI 3.0 描述（`npm run openapi` 从路由元数据生成，`npm run openapi:check` 校验是否过期；服务端 `GET /openapi.json`）
- `/docs` —— 在线 API 文档（Swagger UI，从 `/openapi.json` 渲染；前端资源走 cdnjs）。支持授权码 + PKCE 登录，客户端 redirect URI 用 `http://<host>:8787/docs/oauth2-redirect.html`。
- `/account` —— 账号自助页：登录后生成/撤销自己的 CalDAV 订阅链接。
- [`docs/CALDAV.md`](docs/CALDAV.md) —— 只读 CalDAV：把课表添加到系统日历
- [`client/README.md`](client/README.md) —— 客户端：PKCE、自动刷新、数据 API 封装

## 目录

```
tools/      一次性探测脚本（凭据从 .env 读）
server/     OAuth2 服务端（node:http + node:sqlite + node:crypto）
  jwxt/     强智登录与数据接口客户端
client/     浏览器/Node 客户端
scripts/    管理 CLI 与 OpenAPI 生成/校验
tests/      端到端测试与夹具
docs/       协议笔记 + 服务端/CalDAV 文档（不含抓包产物）
```

## 服务端快速开始

```powershell
Copy-Item .env.example .env
node scripts/admin.mjs gen-key      # 写入 MASTER_KEY
node scripts/admin.mjs gen-token    # 写入 ADMIN_TOKEN

# 创建第一个用户（校验教务密码并写入 SQLite；登录名即学号）
node scripts/admin.mjs add-user --account <学号> --password <教务密码> --service-password <服务密码>

npm start
```

- 服务端不再从 `.env` 导入用户；所有用户通过 CLI 或 `POST /admin/users` 创建。
- 登录名就是学号；不设服务密码时，`/login` 直接校验教务密码（CalDAV 也支持教务密码）。
- 打开 `http://localhost:8787/login`，用学号 + 密码（服务密码；未设置时用教务密码）登录。
- 给用户签发 CalDAV token：`node scripts/admin.mjs add-caldav-token <user_id> --label phone`。
- 数据库 schema 变更未做迁移；需要重建时删除 `data/qzgw.db`。

详细用法见 [`docs/SERVER.md`](docs/SERVER.md) 和 [`docs/CALDAV.md`](docs/CALDAV.md)。

## 开发

```bash
npm run hooks          # 配置 .githooks/pre-commit（每个 clone 执行一次）
npm run openapi:check  # 手动校验 openapi.json 是否最新
```

`pre-commit` 只在 `server/openapi.mjs`、`openapi.base.json`、`openapi.json` 被 staged 时运行，不会拖慢其他提交。

## 安全

- `.env`、`data/`（SQLite，含加密凭据和令牌哈希）、`docs/site/`（含个人信息）都已 gitignore。
- 教务密码用 AES-256-GCM 加密落库，主密钥只在环境变量；服务登录密码用 scrypt（未设置时回退到教务密码）；OAuth/CalDAV token 只存 SHA-256。
- 生产环境请用 HTTPS 反向代理，并把 `ISSUER` 改为外部地址。
- 这是研究/个人项目，自动化访问请遵守学校规定。
