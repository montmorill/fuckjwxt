# fuckjwxt

山东科技大学强智教务系统（`jwglxt.sdust.edu.cn`）的协议研究，以及把账号包装成 **多用户 OAuth 2.0 数据 API** 的服务端。

## 文档

- [`research/NOTES.md`](research/NOTES.md) —— 登录流程、`scode/sxh` 编码、`ticqzket` 实测
- [`research/API.md`](research/API.md) —— 登录后可用接口清单、参数、返回结构
- [`research/MOBILE.md`](research/MOBILE.md) —— 移动端 `app.do` 探测（本部署未授权）
- [`SERVER.md`](SERVER.md) —— OAuth2 网关的部署、管理 API、数据 API
- [`openapi.json`](openapi.json) —— OpenAPI 3.0 描述（`npm run openapi` 从路由元数据生成，`npm run openapi:check` 校验是否过期；服务端 `GET /openapi.json`）
- [`CALDAV.md`](CALDAV.md) —— 只读 CalDAV：把课表添加到系统日历
- [`sdk/README.md`](sdk/README.md) —— 客户端 SDK：PKCE、自动刷新、数据 API 封装

## 目录

```
tools/      可复用的教务客户端与探测脚本
server/     OAuth2 服务端（node:http + node:sqlite + node:crypto）
sdk/        浏览器/Node 客户端 SDK
scripts/    管理 CLI 与端到端测试
research/   协议笔记（不含抓包产物）
```

## 服务端快速开始

```powershell
Copy-Item .env.example .env
node scripts/admin.mjs gen-key      # 写入 MASTER_KEY
node scripts/admin.mjs gen-token    # 写入 ADMIN_TOKEN

# 创建第一个用户（校验教务密码并写入 SQLite）
node scripts/admin.mjs add-user --username alice --account <学号> --password <教务密码> --service-password <服务密码>

npm start
```

- 服务端不再从 `.env` 导入用户；所有用户通过 CLI 或 `POST /admin/users` 创建。
- 打开 `http://localhost:8787/login`，用用户自己的用户名 + 服务密码登录。
- 给用户签发 CalDAV token：`node scripts/admin.mjs add-caldav-token <user_id> --label phone`。
- 数据库 schema 变更未做迁移；需要重建时删除 `data/jwxt-oauth.db`。

详细用法见 [`SERVER.md`](SERVER.md) 和 [`CALDAV.md`](CALDAV.md)。

## 开发

```bash
npm run hooks          # 配置 .githooks/pre-commit（每个 clone 执行一次）
npm run openapi:check  # 手动校验 openapi.json 是否最新
```

`pre-commit` 只在 `server/openapi.mjs`、`openapi.base.json`、`openapi.json` 被 staged 时运行，不会拖慢其他提交。

## 安全

- `.env`、`data/`（SQLite，含加密凭据和令牌哈希）、`research/site/`（含个人信息）都已 gitignore。
- 教务密码用 AES-256-GCM 加密落库，主密钥只在环境变量；服务登录密码用 scrypt；OAuth/CalDAV token 只存 SHA-256。
- 生产环境请用 HTTPS 反向代理，并把 `ISSUER` 改为外部地址。
- 这是研究/个人项目，自动化访问请遵守学校规定。
