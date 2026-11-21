# jwglxt 可用接口清单（登录后 · 学生端）

探测日期 2026-11-21，账号角色：2026 级本科（软件工程）。全部为只读 GET/POST 验证。
登录方式见 `NOTES.md`。可用客户端：`server/jwxt/api.mjs`。

## 0. 通用约定

- 登录成功后有两套会话 Cookie：
  - `bzb_njw` + `SERVERID_gld=pc121|pc122`（主站）
  - `bzb_jsxsd` + `SERVERID_jsxsd=njxpc135|136`（`/jsxsd` 业务应用，单独一套后端）
  - 两套都要保留；`SERVERID_*` 是粘性路由，丢了可能落到另一台后端导致未登录。
- 登录 302 到 `/jsxsd/xk/LoginToXk?method=jwxt&ticqzket=<一次性 token>`，跟随该 URL 后才建立 `/jsxsd` 会话。
- JSON 接口统一返回：`{"msg":"","code":0|"0","data":[...],"count":N}`；`code` 的 0 有时是数字、有时是字符串。
- **很多列表接口要求 `X-Requested-With: XMLHttpRequest` 才返回 JSON**，否则返回整个页面 HTML。
- 分页参数一般叫 `pageNum` / `pageSize`，但部分接口忽略它们并一次返回全部（如教材）。
- 抓取建议间隔 ≥200ms，不要并发轰炸；同一会话串行请求。

## 1. 认证 / 会话

| 接口 | 方法 | 说明 |
|---|---|---|
| `/Logon.do?method=logon&flag=sess` | POST(空 body) | 返回 `scode#sxh` |
| `/Logon.do?method=logon` | POST 表单 | 字段 `loginMethod=logon&userlanguage=0&userAccount=&userPassword=&encoded=`；成功 302 |
| `/jsxsd/xk/LoginToXk?method=jwxt&ticqzket=...` | GET | 登录响应 Location，跟进后进入 `/jsxsd` |
| `/jsxsd/framework/xsMainV.htmlx` | GET | 主框架（123KB），含全部菜单 `li[data-src]` |
| `/jsxsd/framework/xsMainV_new_10424.htmlx?t1=1&ggflag=&jumpid=` | GET | 个人中心 iframe |
| `/Logon.do?method=logout` | GET | 注销 |

## 2. 实测有数据的接口

| 功能 | 接口 | 参数 | 返回 | 实测 |
|---|---|---|---|---|
| 学期列表 | `/jsxsd/xskb/xskb_list.do?viweType=0` | 无 | HTML 中的 `#xnxq01id` options | 2026-2027-1/2 |
| 周次范围 | `/jsxsd/xskb/jxzlzc_xnxq_ajax` | `xnxq01id=2026-2027-1` | JSON `[{qszc:1,jszc:20}]` | ✓ |
| 课表 | `/jsxsd/xskb/xskb_list.do?viweType=0` | 可选 `xnxq01id`、`zc`(第几周) | HTML 表格 | 32 条课程 |
| 结课考试 | `/jsxsd/xsks/xsstk_list` | `pageNum,pageSize,xnxqid` | JSON | 3 场 |
| 教材 | `/jsxsd/jcgl/bjjcdg_query?reqType=listData` | 无 | JSON | 7 本 |
| 教材订购计划 | `/jsxsd/jcgl/jcjhcx_list?reqType=listData` | `xnxqid`（注意不是 xnxq01id）、`kcfx` | JSON | 7 条，`msg=不在控制时间内!`（列表可读，订购未开放） |
| 执行计划 | `/jsxsd/pyfa/pyfa_query?islist=1` | **POST** 表单 `kkxq, kcxx, pageNum, pageSize` | JSON | 21 门（GET 只返回页面） |
| 培养方案课程清单 | `/jsxsd/jlsgl/toPyfakclist.do` | `xs0101id, fx=, pageNum, pageSize` | JSON | **90 门**，每页固定 20 |
| 毕业审核-已修/计划课程 | `/jsxsd/bygl/bygl_ckxsList_yxjhw` | `type=4&bs=list&pageNum&pageSize` | JSON | 21 门；`bs=list` 必须带 |
| 专业字典 | `/jsxsd/comm/getNdzy` | 无 | JSON | 4027 条 `id,zymc,ksnd,zymc2` |
| 培养方案 | `/jsxsd/pyfa/topyfamx` | 无 | HTML 222KB | 2026 版培养方案全文 |
| 学业完成-课程体系 | `/jsxsd/xxwcqk/xxwcqkOnkctx.do?isdb=0` | 无 | HTML 53KB | 已修/正修读学分、课程列表 |
| 学业完成-课程性质 | `/jsxsd/xxwcqk/xxwcqkOnkclb.do?isdb=0` | 无 | HTML | ✓ |
| 学业完成-课程属性 | `/jsxsd/xxwcqk/xxwcqkOnkcxz.do?isdb=0` | 无 | HTML | ✓ |
| 学业完成-通选类别 | `/jsxsd/xxwcqk/xxwcqkOnszklb.do?isdb=0` | 无 | HTML | ✓ |
| 教学周历 | `/jsxsd/jxzl/jxzl_query` | `xnxq01id` | HTML 50KB（周次-日期-备注） | ✓ |
| 教学进程 | `/jsxsd/pyfa/pyfajc_query` | `xnxq01id` | HTML 20KB | ✓ |
| 学籍核对 | `/jsxsd/xsxj/xjxxgl.do?type=list` | 无 | JSON（含身份证号等 PII） | 3 条记录 |
| 学籍卡片 | `/jsxsd/grxx/xsxx` | 无 | HTML（PII） | ✓ |
| 学籍子表 | `/jsxsd/grxx/queryXsxx_jlxx` / `_jtcy` / `_xjyd` / `_jlqk` / `_cfqk` | 无 | layui JSON | 均为空记录 |
| 学生照片 | `/jsxsd/grxx/xszpLoad` | 无 | `image/jpeg` | 39KB，需用 arrayBuffer 读 |
| 成绩证明模板 | `/jsxsd/kscj/cjzm_list?type=listData` | 无 | JSON（含 PII） | 2 种模板 |
| 成绩证明预览 | `/jsxsd/kscj/cjzm_preview?dylx=1` | `dylx` | JSON | `没有数据！`（无成绩） |

## 3. 接口存在但当前为空

大一第一学期，很多模块还没数据；接口本身正常返回 `code:0,data:[]`。

| 功能 | 接口 | 参数 |
|---|---|---|
| 成绩列表 | `/jsxsd/kscj/cjcx_list` | `pageNum,pageSize,kksj,kcxz,kcsx,kcmc,xsfs=max|all,sfxsbcxq=1,fxkcmc,zxsbjg` |
| 考试安排（期末） | `/jsxsd/xsks/xsksap_list` | `pageNum,pageSize,xnxqid,xqlb=1|2|3` |
| 成绩明细（平时分） | `/jsxsd/kscj/pscj_list.do` | `xs0101id,jx0404id,cj0708id,zcj` |
| 补考报名 | `/jsxsd/kscj/bkbm_query?type=list0` / `list1` | 无 |
| 缓考/免考 | `/jsxsd/kscj/hksq_list`、`mksq_list` | 无 |
| 重修报名 | `/jsxsd/kscj/cxbmxk_query1` / `query22` | 无 |
| 调停课 | `/jsxsd/xskb/loadTtkMxList` | `pageNum,pageSize,xnxq01id` |
| 选课轮次 | `/jsxsd/xsxk/xklc_list_data` | 无 |
| 选课结果 | `/jsxsd/xkgl/loadXsxkjgList?lx=xkrz|tkrz` | 无（返回页面/空） |
| 缴费 | `/jsxsd/xfxfgl/xsjfck?type=1` | 无 |
| 专业排名 | `/jsxsd/xsxj/xscjpm.do` | `pageNum,pageSize,xnxq01id`（可空） |
| 学籍预警 | `/jsxsd/xsxj/xsyjxx_list.do` | 无 |
| 学籍异动 | `/jsxsd/xsxj/xsydxx.do?type=list` | 无 |
| 学生证补办 | `/jsxsd/xsxj/xszToApply.do?type=list` | 无 |
| 评教 | `/jsxsd/xspj/xspj_find.do?type=list`、`/jsxsd/newxspj/xspj_list.do?islist=1` | 无 |
| 消息通知 | `/jsxsd/ggly/xxtz_query?type=list&pageNum=1&pageSize=50` | **需 XHR 头** |
| 公告 | `/jsxsd/ggly/ysgg_query?type=list&pageNum=1&pageSize=50` | 需 XHR；详情 `/jsxsd/ggly/ggly_show?ggid=` |
| 留言 | `/jsxsd/ggly/ysly_query?type=list` | 需 XHR |
| 在线问答 | `/jsxsd/zxwd/zxwd_opt?type=list` | 无 |
| 课程替代 | `/jsxsd/xsxj/grkctdToApply.do?reqType=listData` | 无 |
| 公选加分 | `/jsxsd/kscj/publicRepalceApply.do?type=listData` | 无 |

## 4. HTML 型页面（只适合整体渲染/解析，不是 JSON）

`/jsxsd/module/...` 菜单里的 54 个页面全部可访问（见 `research/site/menu.json`）。数据较多、值得直接解析的：

- 课表：`td[name=kbDataTd] > ul[name=kbdataUl] > li.courselists-item`
  - 课程名：`.qz-hasCourse-title`
  - 详情：`p.qz-hasCourse-detaillists`（老师/时间/地点 + `kchSpan` 课程编号 + `dealeSpan` 班级/人数/考核/学时 + `fzmSpan` 分组名）
  - 解析输出同时保留：`rawHtml`（详情块的原始内 HTML，含可能的 `href/src/实体`）与 `rawText`（去标签、解实体后的纯文本，结构化字段由它解析）
  - 列序号 1-7 = 周一至周日；行首 `name=timeTd` 是节次
- 教学周历：`/jsxsd/jxzl/jxzl_query?xnxq01id=`
- 培养方案：`/jsxsd/pyfa/topyfamx`
- 学业完成：`/jsxsd/xxwcqk/xxwcqkOnkctx.do?isdb=0`
- 学籍卡片：`/jsxsd/grxx/xsxx`
- 教室使用：`/jsxsd/kbxx/jsjy_query`（页面表单；数据走 `jsjy_processAjax`，参数较多，未深挖）

## 5. 全量扫描结果（2026-11-21）

从 54 个菜单页 + 子页共提取 **241 个去重接口**；只读请求 **184 个**；**57 个写操作/导出接口**主动跳过。

### 5.1 现在确实能拿到数据的（9 个 JSON + 6 个 HTML）

| 数据 | 接口 | 数量 |
|---|---|---|
| 课表 | `xskb_list.do?viweType=0` | 32 条课程 |
| 结课考试 | `xsks/xsstk_list` | 3 场 |
| 教材 | `jcgl/bjjcdg_query` | 7 本 |
| 执行计划 | `pyfa/pyfa_query` (POST) | 21 门 |
| 培养方案课程 | `jlsgl/toPyfakclist.do` | 90 门 |
| 毕业审核-计划课程 | `bygl/bygl_ckxsList_yxjhw?type=4&bs=list` | 21 门 |
| 学籍核对 | `xsxj/xjxxgl.do?type=list` | 3 条 |
| 成绩证明模板 | `kscj/cjzm_list` | 2 种 |
| 周次范围 | `xskb/jxzlzc_xnxq_ajax` | 1–20 周 |
| 培养方案全文 | `pyfa/topyfamx` | HTML 222KB |
| 学业完成（4 个 tab） | `xxwcqk/xxwcqkOnkctx|Onkclb|Onkcxz|Onszklb.do?isdb=0` | HTML 36–110KB |
| 教学周历 | `jxzl/jxzl_query?xnxq01id=` | HTML 50KB |
| 学籍卡片 | `grxx/xsxx` | HTML 18KB |
| 个人中心 | `framework/xsMainV_new_10424.htmlx` | HTML 14KB |

### 5.2 当前为空（接口正常，`data:[]` 或 HTML 中无记录）

**因大一第一学期还没有数据：**
- 成绩 `kscj/cjcx_list`（0 条；`xsfs=max` 也一样）
- 期末考试安排 `xsks/xsksap_list`（0；结课考试是另一张表，有 3 场）
- 平时成绩明细 `kscj/pscj_list.do`（0）
- 专业排名 `xsxj/xscjpm.do`（0）
- 成绩证明预览 `kscj/cjzm_preview` → `没有数据！`
- 学业完成里的“已修学分”= 0.0（课程列表有，学分未产生）
- 毕业审核要素点/学位/计划内 `bygl_ckxsList_yxsd|yxwd|yxjhn`（0）

**没有业务/未开放：**
- 公告、消息、留言 `ggly/xxtz_query|ysgg_query|ysly_query`（0，需 XHR 头）
- 选课轮次 `xsxk/xklc_list_data`（0）→ 选课中心 `newXsxkzx` 无 `jx0502zbid` 可进
- 选课结果 `xkgl/loadXsxkjgList`（页面无数据）
- 缴费 `xfxfgl/xsjfck?type=1`（0）
- 评教 `xspj/xspj_find.do`、过程评价 `newxspj/xspj_list.do`（0）
- 补考 `kscj/bkbm_query`、缓考 `hksq_list`、免考 `mksq_list`、重修 `cxbmxk_query1/22`（均 0）
- 调停课 `xskb/loadTtkMxList`（0）
- 学籍预警 `xsxj/xsyjxx_list.do`、学籍异动 `xsxj/xsydxx.do?type=list`、学生证补办 `xszToApply.do?type=list`（0）
- 课程替代 `xsxj/grkctdToApply.do`、公选加分、辅修/微专业报名（0）
- 文档管理 `wdgl/wdnr_list`（0）
- 教材订购 `jcgl/jcjhcx_list?xnxqid=`（列表 7 条，但 `msg=不在控制时间内!`，订购未开放）
- 教学进程 `pyfa/pyfajc_query`（POST 返回 `data:[], zc:"20"`）

**空占位记录 `data:[{}]`：** 学籍卡片的奖励/家庭成员/学籍异动/简历/处分 5 个子表（没有记录）。

**需要参数/权限，未拿到数据：**
- `kbxx/jsjy_processAjax`、`jsjy_jszyqk`、`jsjynew/jsjy_processAjax_new` → `no-open`
- 各种详情页需要业务 ID：公告 `ggid`、考试备注 `kw0410id`、课程替代 `jx0404id`、缴费汇总 `xsjfhzid`、准考证 `xnxqid+xqlb` 等
- `kxjsgl.do`、`mzsq*.htmlx`、`xspj_list.do?pj0502id=`、`grkctdsq_shjl.do` → 500/404

### 5.3 没有探测的部分（有意为之）

- **57 个写操作**：选课、退课、补考/重修/缓考申请、评教提交、缴费、改密码、补办申请、打印/导出（会生成文件）等，全部跳过，避免产生业务数据。
- 教师端/管理端接口（学生账号无权限）。
- 移动端/APP 专用接口（如果有，路径可能是 `/app/`、`/mobile/`，本次未扫）。
- 微信公众号扫码登录（页面二维码是静态占位，未接线）。

## 6. 移动端

强智 App API（`/app.do?method=authUser`）在本部署未授权/已关闭，且无独立 m 站；详见 `MOBILE.md`。
手机端可直接复用本文件里的 `/jsxsd/*` 接口。

## 7. 已知坑

1. 列表接口不带 `X-Requested-With: XMLHttpRequest` 会返回整页 HTML（`ggly/*` 实测）。
2. `pyfa_query?islist=1` 必须 POST 表单，GET 只回页面。
3. 教材订购计划的学期参数是 `xnxqid`；教材查询/考试/课表用 `xnxq01id` 或 `xnxqid`，不同模块不统一。
4. `bzb_jsxsd` 是第二套会话；只拿 `bzb_njw` 访问 `/jsxsd/*` 会掉登录。
5. `xszpLoad` 是 JPEG，按文本读会损坏，要用 `arrayBuffer`。
6. 学籍类接口含身份证号、手机号、家庭住址，落盘/日志时注意脱敏；`research/site/` 已加入 `.gitignore`。
7. 毕业审核列表要带 `bs=list`（页面里 `data-url` 不带它，真正请求的 URL 在页面底部 JS 里）。
8. 培养方案课程 `toPyfakclist.do` 的 `pageSize` 固定 20，翻页靠 `pageNum`，共 90 门。
9. 登录偶尔会返回 200 而不是 302（偶发，非凭据错误）；`server/jwxt/login.mjs` 已加退避重试，遇到 `showMsg` 的凭据错误不重试。
