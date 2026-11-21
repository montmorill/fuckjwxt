# 移动端接口扫描（jwglxt.sdust.edu.cn）

探测日期 2026-11-21。结论先行：**强智自带的移动 App API 存在，但本部署未授权/已关闭**；没有独立的移动端子域名或 m 站。

## 1. 结论

1. `GET /app.do?method=authUser&xh=<学号>&pwd=<密码>` 是强智移动端（智校园 App）的标准登录接口，
   正常返回 `{flag, msg, token, userrealname, userdwmc, usertype}`，之后请求带 header `token`。
2. 在 `jwglxt.sdust.edu.cn` 上实测拿不到 token：
   - 无 Referer / 同源 Referer → `flag=1`，页面提示 **“用户没有登录，请重新登录！”**
   - 外部 Referer（公开客户端 SHST 用的 `http://www.baidu.com`）→ `flag=3`，**“未被授权的应用请求！”**
   - 带 Web 会话 Cookie、POST 表单、POST JSON、伪造 `token` 头，结果都一样。
3. 旧移动端主机 `jwgl.sdust.edu.cn`（SHST 文档里的 `http://jwgl.sdust.edu.cn/app.do`）现在 **502**。
4. 没有 `m./mobile./app./wap./wx.` 等子域名（DNS 不存在）；用手机 UA 访问 `jwglxt.sdust.edu.cn` 返回的是同一套响应式网页
   （`<meta viewport>` + `@media (max-width:420px)`），不是单独的移动接口。
5. 所以当前手机端能用的仍然是网页版 `/jsxsd/*` 接口（见 `API.md`），与 UA 无关。
   第三方 App/小程序（爱山科、掌上山科、山科小站/嵙嵙小站）要么依赖已下线的旧 `app.do`，要么解析网页。

> “未被授权的应用请求”是服务端的授权/授权码校验，不是客户端能修的东西；不建议也不应尝试绕过。

## 2. 探测记录

### 2.1 主机

| 主机 | 结果 |
|---|---|
| `m/mobile/app/wap/wx/weixin/jw.sdust.edu.cn` | DNS 不存在 |
| `jwgl.sdust.edu.cn` | 502 Bad Gateway（旧教务/旧移动端） |
| `jwglxt.sdust.edu.cn` | 200（当前教务） |
| `my.sdust.edu.cn` | 302 → `/cas/`（统一身份认证） |
| `portal.sdust.edu.cn` | 200（Umi 门户 SPA，`/api/*` 需 CAS） |
| `zhfw.sdust.edu.cn` | 302 → CAS（办事大厅） |

### 2.2 路径

| 路径 | 结果 |
|---|---|
| `/app/` `/mobile/` `/m/` `/wap/` `/wx/` `/api/` | 404 |
| `/appLogin.do` `/mobileLogin.do` `/Mobile.do` | “出错页面”，JS 跳 `/Logon.do?method=logout` |
| `/jsxsd/app/` `/jsxsd/m/` `/jsxsd/qrcode` | `/jsxsd` 的 catch-all 错误页（约 64KB），无实际内容 |
| `/app.do` | 存在：按 Referer 分流到 App 分支 |

### 2.3 Referer 矩阵（决定返回哪一个错误页）

| UA | Referer | 结果 |
|---|---|---|
| App（Android 6.0.1 C107-9） | 无 | `flag=1` 用户没有登录 |
| App | 同源 `https://jwglxt.sdust.edu.cn/` | `flag=1` 用户没有登录 |
| App | 外部 `http://www.baidu.com` | `flag=3` 未被授权的应用请求 |
| 桌面 Chrome / iPhone | 无 / 同源 | `flag=1` 用户没有登录 |
| 桌面 Chrome / iPhone | 外部 baidu | `flag=3` 未被授权的应用请求 |

即：**是否 App 分支由 Referer 决定，和 UA 无关**；两条分支都拿不到 token。

## 3. 公开资料中的 `/app.do` 契约（仅供参考，本部署不可用）

来源：`WindRunnerMax/SHST`（山科小站，target `jwgl.sdust.edu.cn/app.do`）、`Letki/QZAPI_Archive`、`cxyzzz/HUT_API`。

### 3.1 登录

```
GET {base}/app.do?method=authUser&xh=<学号>&pwd=<密码>
→ {"flag":"1","msg":"...","token":"<JWT>","userrealname":"...","userdwmc":"...","usertype":"..."}
```

- 后续所有请求在 **header** 加 `token: <token>`。
- 不同学校/版本的登录成功标记可能是 `flag` 或 `success`。
- 公开客户端还会带 `Referer: http://www.baidu.com` 和一个 App UA（正是这个 Referer 在本部署触发“未授权”）。

### 3.2 方法列表

| method | 参数 | 说明 |
|---|---|---|
| `getUserInfo` | `xh` | 账号信息（班级/电话/邮箱/年级/专业等） |
| `getStudentIdInfo` | `xh` | 学号内部 ID（bjid/ndzyid/yxid/xxdm） |
| `getCurrentTime` | `currDate=YYYY-MM-DD` | 当前周次 `zc`、学年 `xnxqh`、起止日期 |
| `getXnxq` | `xh` | 学年学期列表（`xnxq01id`, `xqmc`） |
| `getKbcxAzc` | `xh, xnxqid, zc` | 课表：`kcmc, jsxm, jsmc, kkzc, kssj, jssj` |
| `getCjcx` | `xh, xnxqid`（可空） | 成绩：`kcmc, zcj, xf` |
| `getKscx` | `xh` | 考试安排 |
| `getKxJscx` | `time, idleTime`（可选 `xqid,jxlid,classroomNumber`） | 空教室：`idleTime=allday/am/pm/night/0102/0304` |
| `getXqcx` | 无 | 校区列表 |
| `getJxlcx` | `xqid` | 教学楼列表 |
| `getEarlyWarnInfo` | `xh, history=0|1` | 学籍预警 |

## 4. 移动端可用方案

- **直接复用网页接口**：`server/jwxt/login.mjs` + `server/jwxt/api.mjs` 在手机浏览器/任意 UA 下都可用；
  登录页本身响应式，`/jsxsd/framework/xsMainV.htmlx` 也是响应式布局。
- 课表/成绩/考试/教材等直接走 `API.md` 里的 `/jsxsd/*`。
- 学校统一认证（`my.sdust.edu.cn/cas`）另有移动入口：微信/QQ/钉钉/建融慧学扫码、短信验证码，
  但那是门户/CAS 的移动能力，不等于教务 App API。

## 5. 复现

```powershell
node tools/probe_mobile.mjs
```

脚本会对比“无 Referer / 外部 Referer / 同源 Referer / 浏览器 UA”，打印 `flag` 和提示文本。

## 6. 注意

- `authUser` 把密码放在 URL query 里；即便 HTTPS，也会进浏览器历史、代理日志、Referer。只用于本地研究。
- 不要尝试构造 `appid/sign` 或伪造 Referer 去绕过“未被授权”；这是学校/厂商的授权开关。
