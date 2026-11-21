# CalDAV（只读课表，多用户）

把每个用户的当前学期课表转成 VEVENT。手机/桌面日历可以添加 CalDAV 账户，或用 `.ics` 订阅。

## 启用与签发 token

CalDAV 不需要全局开关；每个用户用**自己的用户名 + CalDAV app token 或强智教务密码**认证。

管理员给用户签发 token：

```bash
node scripts/admin.mjs add-caldav-token <user_id> --label phone
# 或
curl -X POST http://localhost:8787/admin/users/<user_id>/caldav-tokens \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{"label":"phone"}'
```

返回的 token **只显示一次**，作为该用户的 CalDAV Basic 密码。可以给同一用户签发多个（手机、电脑），单独撤销：

```bash
node scripts/admin.mjs list-caldav-tokens <user_id>
node scripts/admin.mjs del-caldav-token <user_id> <token_id>
```

## 客户端配置

服务地址：

```
http://<host>:8787/caldav/
```

| 客户端 | 配置 |
|---|---|
| iOS / macOS 日历 | 添加账户 → 其他 → CalDAV；服务器填上面的地址，用户名填用户的 `username` 或学号，密码填该用户的 CalDAV token（或强智密码） |
| Thunderbird | 新建日历 → 网络上 → CalDAV；URL 同上 + 用户名/密码 |
| DAVx5 (Android) | 添加账户 → URL + 用户名密码 → 选择该用户的“课表” |
| 只读订阅 | `http://<host>:8787/caldav/calendars/<username>/timetable.ics`（Basic 认证） |

发现入口：

```
GET /.well-known/caldav  → 301 /caldav/
```

每个用户的路径：

```
/caldav/principals/<username>/
/caldav/calendars/<username>/
/caldav/calendars/<username>/timetable/
/caldav/calendars/<username>/timetable/<hash>.ics
/caldav/calendars/<username>/timetable.ics
```

用户名只能访问自己的 principal/calendar，跨用户请求返回 404。Basic 登录名可以用 `username` 或学号；服务器返回的 href 统一使用 `username`，客户端跟随发现结果即可，手动拼路径时两种标识都接受。

## 数据与时间

- 默认每个课程条目生成一个 VEVENT，多周用 `RDATE` 展开。
- 检测到 `User-Agent` 含 `OPPO`（OPPO 日历不展开 `RDATE`）时，改为每个上课日一个独立 VEVENT，同一课程不同周次使用不同 UID。
- 两种模式的 UID、ETag 和缓存彼此独立，客户端切来切去不会互相污染。
- 星期 1–7 映射周一到周日；周次从教学周历的第 1 周周一开始。
- 学期默认取该用户教务系统里的当前学期；需要固定某学期时，在用户上设置 `caldavSemester`（CLI `--caldav-semester` 或管理 API），不设置则跟随当前学期。
- 学期起始日期从 `/jsxsd/jxzl/jxzl_query` 的“第 1 周”行解析；解析失败会报错，不再用环境变量兜底。
- 节次时间在 [`config/period-times.json`](config/period-times.json) 中配置，格式为 `"1-2": ["08:00", "09:40"]`；文件缺失时使用内置默认值。修改后需重启服务。

  ```json
  {
    "1-2": ["08:00", "09:40"],
    "3-4": ["10:00", "11:40"],
    "5-6": ["14:00", "15:40"],
    "7-8": ["16:00", "17:40"],
    "9-10": ["19:00", "20:40"],
    "11-12": ["20:50", "22:30"]
  }
  ```

- 时区固定 `Asia/Shanghai (+08:00)`，时间转成 UTC 写入 ICS，客户端自动按本地时区显示。

## 认证

- **Basic**：用户名可以是 `users.username` 或学号（`users.account`）；密码可以是该用户的 CalDAV token（数据库只存 SHA-256），也可以直接使用该用户保存的强智教务密码（解密后比对）。
- **Bearer**：OAuth access token（需要 `jwxt.read`），绑定 token 的 `user_id`。
- Basic 失败返回 401；跨用户路径返回 404。
- 每个用户可签发多个 token，单独撤销；token 只显示一次。
- 强智密码可以直连，但 Basic 是明文传输：生产环境务必走 HTTPS；能给客户端单独签发 token 时优先用 token，泄露后可单独撤销而不影响教务密码。

## 能力

| 方法 | 支持 |
|---|---|
| `OPTIONS` | `DAV: 1, 2, calendar-access` |
| `PROPFIND` | 根/principal/home/calendar/event，Depth 0/1/infinity |
| `REPORT` | `calendar-query`（返回全部事件）、`calendar-multiget` |
| `GET` / `HEAD` | 日历集合、单个事件、`.ics` 订阅 |
| `PUT` / `DELETE` / `MKCALENDAR` | 405（只读） |

ETag 基于生成内容；`If-None-Match` 支持 304。

## 限制

- 只读，不支持客户端写回。
- 一次只暴露一个学期（用户固定的 `caldavSemester`，否则当前学期）。
- `calendar-query` 的时间范围过滤未实现：按时间范围查询也会拿到整学期事件。
- 不支持 `sync-collection`；客户端会回退到 `calendar-query`。
- 时区固定 `Asia/Shanghai (+08:00)`。
- 数据缓存 5 分钟（`CALDAV_CACHE_MS`），缓存按用户隔离；改账号/学期后清缓存或等待过期。

## 测试

```bash
# 不传 CALDAV_TOKEN 时会用 ADMIN_TOKEN 临时签发一个，测试结束自动撤销
CALDAV_URL=http://localhost:8787/caldav/ \
CALDAV_USERNAME=alice \
ADMIN_TOKEN=<ADMIN_TOKEN> \
npm run test:caldav
```

覆盖：OPTIONS、`/.well-known/caldav` 与 principal/home/calendar 的 PROPFIND、REPORT（calendar-query / sync-collection / OPPO 独立事件）、单个事件 GET、整表 GET、ETag/304、错误密码 401。
