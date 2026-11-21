# CalDAV（只读课表）

把当前学期课表转成 VEVENT，手机/桌面日历可以直接添加 CalDAV 账户，或用 `.ics` 订阅。

## 启用

`.env`：

```dotenv
CALDAV_USER=caldav
CALDAV_TOKEN=<至少 24 字符，node scripts/admin.mjs gen-token>
CALDAV_TIMEZONE=Asia/Shanghai
CALDAV_SEMESTER=            # 留空=当前学期
CALDAV_SEMESTER_START=      # 留空=从教学周历解析；格式 YYYY-MM-DD
CALDAV_PERIOD_TIMES=        # 留空=内置默认节次时间
CALDAV_CACHE_MS=300000
```

`CALDAV_TOKEN` 为空时 CalDAV 端点返回 503，其他功能不受影响。

服务端启动日志会打印：

```
caldav: http://localhost:8787/caldav/ (user=caldav)
```

## 客户端配置

服务地址统一用：

```
http://<host>:8787/caldav/
```

| 客户端 | 配置 |
|---|---|
| iOS / macOS 日历 | 添加账户 → 其他 → CalDAV；服务器填上面的地址，用户 `caldav`，密码 `CALDAV_TOKEN` |
| Thunderbird | 新建日历 → 网络上 → CalDAV；URL 填上面的地址 + 用户名/密码 |
| DAVx5 (Android) | 添加账户 → 使用 URL 和用户名登录；选择“课表”日历 |
| 只读订阅 | `http://<host>:8787/caldav/calendars/caldav/timetable.ics`（Basic 认证） |

发现入口：

```
GET /.well-known/caldav  → 301 /caldav/
```

路径：

```
/caldav/principals/caldav/
/caldav/calendars/caldav/
/caldav/calendars/caldav/timetable/
/caldav/calendars/caldav/timetable/<hash>.ics
/caldav/calendars/caldav/timetable.ics
```

## 数据与时间

- 每个课程条目生成一个 VEVENT，`UID` 稳定（课程/星期/节次/地点/周次的哈希）。
- 多周课程用 `RDATE` 展开，例如高数 4,6,8,10,12 周会生成 1 个 `DTSTART` + 4 个 `RDATE`。
- 星期 1–7 映射周一到周日；周次从教学周历的第 1 周周一开始。
- 学期起始日期优先从 `/jsxsd/jxzl/jxzl_query` 的“第 1 周”行解析；失败则用 `CALDAV_SEMESTER_START`。
- 节次时间默认：

  ```
  1-2  08:00-09:40
  3-4  10:00-11:40
  5-6  14:00-15:40
  7-8  16:00-17:40
  9-10 19:00-20:40
  11-12 20:50-22:30
  ```

  可通过 `CALDAV_PERIOD_TIMES` 覆盖，例如：

  ```
  CALDAV_PERIOD_TIMES=1-2=08:00-09:35;3-4=10:00-11:35;5-6=14:00-15:35;7-8=16:00-17:35
  ```

- 时间按 `Asia/Shanghai (+08:00)` 转成 UTC 写入 ICS，客户端会自动按本地时区显示。

## 认证

- **Basic**：用户名 `CALDAV_USER`，密码 `CALDAV_TOKEN`（推荐给日历客户端）。
- **Bearer**：OAuth access token（需要 `jwxt.read`），适合脚本。
- 生产环境务必走 HTTPS；Basic 密码是长期令牌，泄露后请更换 `CALDAV_TOKEN` 并重启。

## 能力

| 方法 | 支持 |
|---|---|
| `OPTIONS` | `DAV: 1, 2, calendar-access` |
| `PROPFIND` | 根/principal/home/calendar/event，Depth 0/1 |
| `REPORT` | `calendar-query`（返回全部事件）、`calendar-multiget` |
| `GET` / `HEAD` | 日历集合、单个事件、`.ics` 订阅 |
| `PUT` / `DELETE` / `MKCALENDAR` | 405（只读） |

ETag 基于生成内容；`If-None-Match` 支持 304。

## 限制

- 只读，不支持客户端写回。
- 一次只暴露一个学期（`CALDAV_SEMESTER` 或当前学期）。
- `calendar-query` 的时间范围过滤未实现：客户端按时间范围查询时也会拿到整学期事件（数据量不大，通常可接受）。
- 不支持 `sync-collection`；客户端会回退到 `calendar-query`。
- 只支持 `Asia/Shanghai` 的 +08:00 换算。
- 数据缓存 5 分钟（`CALDAV_CACHE_MS`）；改了账号或学期后重启或等缓存过期。

## 测试

```bash
CALDAV_URL=http://localhost:8787/caldav/ \
CALDAV_USER=caldav \
CALDAV_TOKEN=... \
npm run test:caldav
```

覆盖：OPTIONS、principal/home/calendar 的 PROPFIND、REPORT 事件、单个事件 GET、整表 GET、ETag/304、错误密码 401。
