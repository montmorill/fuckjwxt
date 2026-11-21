# jwglxt.sdust.edu.cn 登录鉴权研究

> 探测日期：2026-11-21。对象：山东科技大学教务系统（湖南强智科技 jwglxt，非正方）。
> 仅做协议分析；未持有任何有效账号，成功分支未能实测。

## 1. 结论摘要

- 登录页直接由教务系统自己提供，**不是** CAS 跳转。表单 `POST /Logon.do?method=logon`。
- 密码不是明文直传，而是先用一次 `POST /Logon.do?method=logon&flag=sess` 拿到的随机串
  `scode#sxh` 做“交织混淆”，结果放在隐藏字段 `encoded` 里提交。
- 这是**混淆，不是加密**：`encoded` 中含明文账号/密码字符，拿到同一会话的 `scode/sxh` 即可还原。
  真正的保密完全依赖 HTTPS。
- 会话靠 Cookie `bzb_njw`（32 位十六进制，HttpOnly），前置负载均衡还下发粘性 Cookie `SERVERID_gld`（pc121/pc122）。
- 该部署**未启用验证码**：连续 7 次错误密码，返回的都是同一句
  `该帐号不存在或密码错误,请联系管理员!`，页面不出现验证码输入；伪造 `encoded` 也是同一句，无信息泄露。
- 站点**允许纯 HTTP 访问且不跳转 HTTPS、无 HSTS**，登录流程在 http 下同样可用 —— 见安全提示。

## 2. 完整请求序列

### 步骤 0：打开登录页

```
GET https://jwglxt.sdust.edu.cn/
```

响应 200，登录 HTML，同时下发：

```
Set-Cookie: bzb_njw=<32 hex>; Path=/; HttpOnly
Set-Cookie: SERVERID_gld=pc121|pc122; path=/
```

页面表单字段：

```html
<form name="loginForm" action="/Logon.do?method=logon" method="post">
  <input type="hidden" name="loginMethod"   value="logon">
  <input type="hidden" name="userlanguage"  value="0">
  <input type="text"     name="userAccount">
  <input type="password" name="userPassword">
  <input type="hidden"   name="encoded" value="">
</form>
```

### 步骤 1：取混淆种子

```
POST /Logon.do?method=logon&flag=sess      (空 body 即可；GET 也行)
```

响应体是一行纯文本，格式 `scode#sxh`：

```
<随机字母数字串>#<纯数字串，每位 1~3>
```

- `scode` 长度可变（实测约 99 字符），由 `[A-Za-z0-9]` 组成，每次调用都不同。
- `sxh` 的位数 = 明文串长度（上限 55），数字之和 = `scode` 长度。
- 这两个值与会话（`bzb_njw`）绑定；**必须与后续登录请求使用同一个 Cookie 罐**，中间不能丢失
  `SERVERID_gld`，否则可能落到另一台后端导致会话失效。

### 步骤 2：生成 encoded（页面 `loginajax()` 的算法）

```js
var code = userAccount + "%%%" + userPassword + "%%%" + codeDogSequence; // 无加密狗时 = " "
var encoded = "", scode = <scode>, sxh = <sxh>;
for (var i = 0; i < code.length; i++) {
  if (i < 55) {
    encoded += code.charAt(i) + scode.substring(0, parseInt(sxh.charAt(i)));
    scode = scode.substring(parseInt(sxh.charAt(i)));
  } else {
    encoded += code.substring(i);   // 超过 55 的先种子字符直接原样拼接
    break;
  }
}
```

即：明文第 i 个字符后面插入 `sxh[i]` 个 `scode` 字符；前 55 个明文字符参与交织，其余原样追加。
`codeDogSequence` 是 USB 加密狗序列号，该部署关闭（页面里是 `if("1"=='0')`），所以固定为一个空格。

### 步骤 3：提交登录

页面在提交前会把 `userPassword` 清空（`logon != logonLdap`），所以明文密码只存在于 `encoded`：

```
POST /Logon.do?method=logon
Content-Type: application/x-www-form-urlencoded
Cookie: bzb_njw=...; SERVERID_gld=...

loginMethod=logon&userlanguage=0&userAccount=<账号>&userPassword=&encoded=<urlencoded 后的 encoded>
```

### 步骤 4：结果判定

- 失败：200，重新渲染登录页，页面中含
  `<font color="red" size="2" id="showMsg">该帐号不存在或密码错误,请联系管理员!</font>`。
- 成功：预期为 3xx 跳到 `/index.htmlx` 并持有已认证会话（本环境无有效账号，**未实测**）。
- 未认证访问 `/index.htmlx` 仍返回登录页（200），不是 302。

## 3. 账号格式

`userAccount` 就是学号/工号（页面占位符“请输入账号”；CAS 页提示“职工号/学号/邮箱/别名”）。
密码经 `code` 拼接时若含 `%`、`+` 等字符，注意整体作为表单值做 URL 编码，不要分段编码。

## 4. 其他登录入口/机制

| 入口 | 说明 |
|---|---|
| `/Logon.do?method=logon` | 本文主流程 |
| 微信扫码框 | 页面有 `.qc` 占位图和切换逻辑，但**没有任何 JS 去申请二维码**，本部署下是死的 |
| USB 加密狗 | 页面加载 `/js/usbkey.js`，`postMessage` 与本地插件通信；相关分支被 `'1'=='0'` 关闭 |
| 短信验证码 | 模板有 `ReShowCodeTele`、`telephoneCode` 逻辑，但同样被 `'1'=='0'` 关闭 |
| `/Logon.do?method=logonLdap` | 明文账号/密码提交，返回 500（本部署不走） |
| `/sso`、`/sso/;bzb_njw=...` | 强智“业务系统认证集成”页，接受 `ticket`/`service` 参数，标题“业务系统认证集成-成功”，未登录时字段为空。说明学校 CAS 与该系统有集成，但默认登录页不走 CAS |
| 学校 CAS | `https://my.sdust.edu.cn/cas/`（Apereo CAS，Tomcat 8.0.47 / JDK 1.8.0_11）。办事大厅 `zhfw.sdust.edu.cn`、`portal.sdust.edu.cn` 走这个。支持账号密码、手机短信、QQ/DingTalk/微信扫码 |

### 学校 CAS（my.sdust.edu.cn/cas）要点（做统一认证时才需要）

- 登录页 `GET /cas/login?service=<业务系统URL>`，Apereo 标准字段：
  `username`、`password`（隐藏，提交的是 RSA 密文）、`execution`、`_eventId=submit`、`rememberMe`、`authcode`（验证码，默认隐藏）。
- RSA 公钥：`GET /cas/v2/getPubKey` → `{"modulus":"<hex>","exponent":"10001"}`。
- 加密方式（`js/login/login.js`）：**先把密码字符串反转，再 RSA（PKCS#1 v1.5）加密**，结果写回 `password`。
- 手机短信登录是第二个表单 `fm2`（`username=手机号`、`mobileCode`、隐藏 `password`）。
- 会话 Cookie `JSESSIONID=...cas3`，另有 `_pv0`。

## 5. 安全观察（供报告/加固参考，不建议进一步施压测试）

1. `http://jwglxt.sdust.edu.cn/` 直接 200 返回登录页，**不跳转 https，无 HSTS**；`flag=sess` 在 http 下也正常返回。
   用户若从 http 进入，账号密码（混淆后）将以明文过网。建议服务器端强制 301 到 https + `Strict-Transport-Security`。
2. 登录会话 Cookie `bzb_njw` 缺少 `Secure`、`SameSite`（仅 `HttpOnly`）。若强制 https，应补 `Secure`。
3. `encoded` 混淆可逆：客户端拿到 `scode/sxh` 即可还原密码，等价于明文；不应被视为任何形式的加密。
4. 该部署未启用验证码/失败锁定：7 次连续错误无变化（仅建议层面，不应继续测试）。
5. 错误信息统一为“账号不存在或密码错误”，无用户枚举 —— 这一点是好的。
6. `/sso` 的 302 Location 是 `http://...`（明文、且把会话 ID 放进 URL `;bzb_njw=...`），有会话泄露风险。

## 6. 最小可用客户端（Node 24，已验证能走到“账号或密码错误”分支）

见 `tools/probe_login.mjs`。核心：

```js
const BASE = 'https://jwglxt.sdust.edu.cn';
let cookies = new Map();
// 每次 fetch 后吸收 set-cookie，后续请求带 Cookie: bzb_njw=...; SERVERID_gld=...

await fetch(BASE + '/', { headers: { 'User-Agent': UA } });                       // 建会话
const sess = await (await fetch(BASE + '/Logon.do?method=logon&flag=sess',
  { method: 'POST', headers: { Cookie: cookieHeader() } })).text();

const [scode, sxh] = sess.split('#');
const code = `${account}%%%${password}%%% `;
let rest = scode, encoded = '';
for (let i = 0; i < code.length; i++) {
  if (i < 55) {
    encoded += code[i] + rest.slice(0, +sxh[i]);
    rest = rest.slice(+sxh[i]);
  } else { encoded += code.slice(i); break; }
}

const body = new URLSearchParams({
  loginMethod: 'logon', userlanguage: '0',
  userAccount: account, userPassword: '', encoded,
});
const res = await fetch(BASE + '/Logon.do?method=logon', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader() },
  body: body.toString(),
});
// 失败时 res.body 内含 id="showMsg" 的错误文案
```

## 7. 探测脚本

凭据放在项目根目录 `.env`（模板见 `.env.example`，已 gitignore），脚本会自动读取；也可用命令行参数覆盖。

登录后的接口清单见 **`research/API.md`**，可直接调用的客户端是 **`tools/jwxt_api.mjs`**（`node tools/jwxt_api.mjs` 会打印课表/考试/教材/执行计划摘要）。

- `tools/jwxt.mjs` —— 可复用的登录模块（`login()` 返回已认证的 Cookie 罐）
- `tools/jwxt_api.mjs` —— 登录后的数据接口封装（课表/成绩/考试/教材/学籍/公告等）
- `tools/probe_login.mjs` —— 完整两步登录（`.env` 或 `node tools/probe_login.mjs <账号> <密码>`）
- `tools/probe_edges.mjs` —— GET/POST sess、两次 sess、无 Cookie、垃圾 encoded、logonLdap、验证码接口、长输入
- `tools/probe_captcha.mjs` —— 连续失败是否触发验证码
- `tools/probe_decode.mjs` —— 省略/伪造 userAccount 时是否仍返回统一错误
