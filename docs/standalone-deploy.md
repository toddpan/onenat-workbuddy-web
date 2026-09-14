# OneNat WorkBuddy 独立部署指南（不依赖 DSH）

同一份核心代码（`src/onenat.ts` / `store.ts` / `resolver.ts` / `prompt-composer.ts` / `planner.ts` /
`engine.ts` / `router.ts` / `web-ui.ts`）有两种运行方式，二者互不影响：

| | DSH 插件模式 | **独立部署模式（本文）** |
|---|---|---|
| 入口 | `lib/index.js`（cordis 插件） | `dist/server.js` |
| 宿主 | DSH 进程（`ctx.webServer` + `ctx.tools`） | Node 原生 `http` 服务，**零 DSH 依赖** |
| 控制台 | `http://<DSH>/onenat-workbuddy` | `http://<host>:<port>/onenat-workbuddy` |
| 模型工具 | 注册进 DSH 模型工具表 | HTTP 工具通道 `GET/POST /api/tools[/:name]` |
| 数据目录 | `$DSH_HOME/onenat-workbuddy/` | `--data` / `$WORKBUDDY_HOME`（默认 `~/.onenat-workbuddy`） |

> 独立部署只依赖 Node ≥ 20 的内建能力；`ssh2`（SSH 资源 test/exec）与 `undici`（SSE 长静默段
> 关闭 chunk 间超时）是**可选**依赖，缺失时自动优雅降级，服务照常可用。

---

## 1. 构建

```bash
# 只编译独立服务（DSH 无关的服务端图）→ dist/
bash scripts/build-standalone.sh          # 或 npm run build:standalone

# 编译产物
node dist/server.js --help
```

`build-standalone.sh` 会：

1. 定位 `tsc`（本地 `node_modules/.bin/tsc` → `$DSH_CHECKOUT` → `npx typescript@5`）；
2. 按 `tsconfig.server.json` 编译（只收 `src/server.ts` 及其 DSH 无关的依赖图）；
3. 校验 `dist/server.js` 存在，且产物里**没有** `cordis` / `@deepseek-ai/*` 引用，否则构建失败。

`dist/` 里不会有 `index.js` / `tools.js` / `client.js` —— 那三个是 DSH 插件模式专用文件。

---

## 2. 启动

```bash
node dist/server.js --port 3081 \
  --onenat-base-url https://onenat.sooncore.com \
  --onenat-api-key onk-xxxxxxxx
```

启动后输出：

```
  ⚡ OneNat WorkBuddy — 独立部署 WEB 服务（不依赖 DSH）
  ├─ 控制台      http://127.0.0.1:3081/onenat-workbuddy
  ├─ 健康检查    http://127.0.0.1:3081/healthz
  ├─ 工具通道    7 个工具：workbuddy_resource_manage / ... / workbuddy_ssh_resource_manage
  ├─ 数据目录    /root/.onenat-workbuddy
  ├─ ONENAT      https://onenat.sooncore.com
```

### 命令行参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `-p, --port <n>` | `3081` | 监听端口 |
| `--host <addr>` | `127.0.0.1` | 监听地址；`0.0.0.0` 表示对外暴露（见 §6 安全） |
| `--prefix <path>` | `/onenat-workbuddy` | 路由前缀；设 `/` 即挂到根路径 |
| `--data <dir>` | `$WORKBUDDY_HOME` 或 `~/.onenat-workbuddy` | 数据目录（`store.json` / `ssh-resources.json`） |
| `--onenat-base-url <url>` | 取存储设置 | ONENAT 服务地址（覆盖存储值，不写回） |
| `--onenat-api-key <key>` | 取存储设置 | ONENAT API Key（`onk-…`） |
| `--auto-refresh <ms>` | 取存储设置（约 60000） | 资源目录自动刷新间隔（下限 15s） |
| `--token <token>` | 空 = 不校验 | 仅保护**工具 HTTP 通道**（控制台 UI 走登录会话） |
| `--admin-username <name>` | `workbuddy` | 管理员用户名（仅首次播种 auth.json 时生效） |
| `--admin-password <pwd>` | `ThunderSoft@88` | 管理员密码（仅首次播种 auth.json 时生效） |
| `--quiet` | 关 | 关闭逐请求日志 |
| `-h, --help` / `-v, --version` | | 帮助 / 版本 |

### 环境变量

`HOST`、`PORT`、`WORKBUDDY_PREFIX`、`WORKBUDDY_HOME`、`ONENAT_BASE_URL`、`ONENAT_API_KEY`、
`WORKBUDDY_AUTO_REFRESH_MS`、`WORKBUDDY_TOKEN`、`WORKBUDDY_ADMIN_USERNAME`、`WORKBUDDY_ADMIN_PASSWORD`。
命令行参数优先于环境变量，环境变量优先于存储中的设置。

### 登录鉴权（默认开启）

控制台与全部业务 API（`{prefix}/api/**`）均需登录：未登录访问控制台返回登录页，访问 API 返回 401；
`/healthz` 保持公开供探活。

- 管理员默认 `workbuddy / ThunderSoft@88`，**仅首次启动**播种到 `dataDir/auth.json`
  （scrypt 加盐哈希，不落明文）；之后改密码请走 API，再改环境变量/启动参数不生效；
- 会话为 HttpOnly Cookie（`wb_session`），7 天滑动过期；服务重启后需重新登录；
- 登录失败限速：单 IP 5 分钟内 10 次失败即 429（另有 400ms 失败延迟）；
- 修改密码：`POST {prefix}/api/auth/password` `{"oldPassword":"…","newPassword":"…"}`
  （成功后吊销该用户全部会话）；`GET {prefix}/api/auth/me` 查当前登录用户；
- 增加用户：编辑 `auth.json` 按既有 `salt/hash` 格式追加；
- DSH 插件模式不受影响（沿用 DSH 自身鉴权，控制台不渲染登录/退出元素）。

---

## 3. 接口面

控制台与业务 REST 全部挂在 `--prefix` 下（下表省略前缀），与插件模式**完全一致**（见 README 路由表）：

```
GET  {prefix}/                     控制台单页（响应式，含移动端底部 Tab）
GET  {prefix}/api/resources        资源目录（ONENAT 实时快照）
GET  {prefix}/api/agents|tasks     子智能体 / 任务
POST {prefix}/api/tasks/:id/messages|cancel|summary
GET  {prefix}/api/tasks/:id/stream SSE：turn_start/turn_delta/turn_reasoning/turn_tool/turn_end/plan_update/...
GET  {prefix}/api/ssh-resources    SSH 连接资源池
```

独立部署新增两个口子：

```
GET  /healthz                      健康检查（永远在根路径，无需前缀/令牌）
GET  {prefix}/api/tools            列出 7 个工具及其参数 schema
POST {prefix}/api/tools/:name      调用工具（等价 DSH 模型工具）
```

```bash
# 列出工具
curl -s http://127.0.0.1:3081/onenat-workbuddy/api/tools | jq '.tools[].name'

# 查资源目录
curl -s -X POST http://127.0.0.1:3081/onenat-workbuddy/api/tools/workbuddy_resource_manage \
  -H 'Content-Type: application/json' -d '{"action":"list"}' | jq '.result.count'

# 建子智能体（ONENAT 映射绑定，端口漂移免疫）
curl -s -X POST http://127.0.0.1:3081/onenat-workbuddy/api/tools/workbuddy_agent_manage \
  -H 'Content-Type: application/json' \
  -d '{"action":"upsert","agent":{"name":"执行者","dshRef":{"kind":"mapping","mappingId":"map-xxxx"}}}'

# 建任务并立即发起（多成员 = LLM 拆解 + DAG 编排）
curl -s -X POST http://127.0.0.1:3081/onenat-workbuddy/api/tools/workbuddy_task_manage \
  -H 'Content-Type: application/json' \
  -d '{"action":"create","title":"巡检","memberAgentIds":["agent-xxxx"],"message":"检查磁盘占用并按大小排序"}'

# 启用 --token 后，工具通道需带令牌
curl -s -H 'Authorization: Bearer <token>' http://127.0.0.1:3081/onenat-workbuddy/api/tools
```

---

## 4. 本地验证（mock ONENAT + 冒烟脚本）

```bash
bash scripts/build-standalone.sh
node scripts/smoke-standalone.mjs        # 31 项：健康检查/控制台/REST/工具通道/令牌/落盘
SMOKE_E2E=1 node scripts/smoke-standalone.mjs   # 追加真实派发端到端（需本机 DSH web 在 3080）
```

冒烟脚本自拉起 `scripts/mock-onenat.cjs`（127.0.0.1:18080，数据形状与真实 ONENAT 一致）与
`dist/server.js`（临时数据目录），跑完自动清理进程与临时目录，退出码非 0 即失败。

`SMOKE_E2E=1` 会真的派发一条消息到本机 DSH web service（默认 `127.0.0.1:3080`，可用 `DSH_WEB_PORT` 改），
断言：子智能体 ping 在线 → 任务进入 running → 完成后产出回复文本 → 绑定远端会话。

手工联调：

```bash
node scripts/mock-onenat.cjs &                       # mock ONENAT
node dist/server.js --port 3081 --data /tmp/wb \
  --onenat-base-url http://127.0.0.1:18080 --onenat-api-key onk-mock-key-000
open http://127.0.0.1:3081/onenat-workbuddy
```

---

## 5. 常驻部署

### systemd

```ini
# /etc/systemd/system/onenat-workbuddy.service
[Unit]
Description=OneNat WorkBuddy (standalone web service)
After=network-online.target

[Service]
Type=simple
User=workbuddy
WorkingDirectory=/opt/onenat-workbuddy
Environment=HOST=127.0.0.1
Environment=PORT=3081
Environment=WORKBUDDY_HOME=/var/lib/onenat-workbuddy
Environment=ONENAT_BASE_URL=https://onenat.sooncore.com
Environment=ONENAT_API_KEY=onk-xxxxxxxx
ExecStart=/usr/bin/node /opt/onenat-workbuddy/dist/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

### Docker

```bash
docker build -t onenat-workbuddy .
docker run -d --name workbuddy -p 3081:3081 \
  -e ONENAT_BASE_URL=https://onenat.sooncore.com \
  -e ONENAT_API_KEY=onk-xxxxxxxx \
  -v workbuddy-data:/data \
  onenat-workbuddy
```

### 反向代理（nginx，含 Basic 认证）

服务自身不做用户鉴权，公网暴露请套一层：

```nginx
server {
  listen 443 ssl;
  server_name workbuddy.example.com;

  location /onenat-workbuddy/ {
    auth_basic "WorkBuddy";
    auth_basic_user_file /etc/nginx/.htpasswd;

    proxy_pass http://127.0.0.1:3081;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;

    # SSE：必须关闭缓冲，否则流式输出会攒到最后一次性吐出
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    chunked_transfer_encoding on;
  }
}
```

---

## 6. 安全边界

- **默认只监听 `127.0.0.1`**。绑 `0.0.0.0` 时启动横幅会给出显式告警。
- 控制台与业务 API **没有内建鉴权**（与插件模式共用同一套路由），面向他人时必须置于反代/内网之后；
- **登录鉴权默认开启**（见上文「登录鉴权」）：控制台与业务 API 需登录，管理员见 `--admin-*` 参数；
- **工具通道是特权面**（含 SSH `exec`、读取明文凭据），跨机调用请务必启用 `--token`
  （或 `WORKBUDDY_TOKEN`），令牌只保护 `/api/tools*`，不影响控制台 UI；
- SSH 资源存储（`ssh-resources.json`）含明文密码/私钥，请确保 `--data` 目录权限收敛（如 `chmod 700`）；
- 子智能体派发提示词会把绑定资源的入口与凭证（按 `self-fetch|inline|omit` 策略）交给远端模型，
  策略与信任边界见 README「设计要点」。
