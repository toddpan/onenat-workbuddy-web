# OneNat WorkBuddy 附件上传 P2P 直传 实现文档

> 状态：已实现并部署线上（2026-10-14，commit `c6cf023`，internal-deploy 环境）。
> 前代方案（服务端暂存 + 分片中继）已整体删除，本文描述现行 P2P 架构，并在附录记录演进史供考古。
> 关联：`docs/streaming-integrity.md`（流式）、`docs/standalone-deploy.md`（部署）。

---

## 0. 需求一句话

AI（MCP 通道）与 WEB 控制台都要能上传**最大 2GB** 的文件（典型：日志包）到任务工作区；
**文件字节直连 DSH 节点，不经 workbuddy 服务器中转**；多 DSH 协作时文件只传主节点一份，
其它节点通过「该节点的完整下载 URL + 密钥」点对点取文件。

---

## 1. 架构总览

workbuddy 从「数据面」退役为「控制面」：只下发直连配方与登记结果，不碰文件字节。

```
浏览器 / AI 宿主（curl 等）
   │  ① POST /api/tasks/:id/attachments/direct/init        （控制面：AI 令牌/登录态）
   │     ◀─ direct 配方 { baseUrl, apiKey, sessionId, 端点模板 } + uploadId（30 分钟登记簿）
   │
   │  ② 直连 DSH 节点（不经 workbuddy）
   │     POST   {node}/sessions/:sid/files/resumable?name=&size=   → nodeUploadId
   │     PUT    {node}/sessions/:sid/files/resumable/:nid?offset=N （≤4MB/片，409 对账续传）
   │     POST   {node}/sessions/:sid/files/resumable/:nid/complete → files[0].path（落盘绝对路径）
   │
   │  ③ POST /api/tasks/:id/attachments/direct/register    （凭 path 登记附件）
   │     ◀─ attachment + 跨节点下载 URL（{node}/fs/download?path=<abs>）+ curl 示例
   │
   ▼  ④ workbuddy_task_manage {action:"send"} 引用路径/URL —— 任务此时才开始执行
```

多成员协作（P2P 语义）：文件只上传**主节点**一份；其它节点的成员需要该文件时，
由消息携带「下载 URL + 节点 apiKey」，下载方 `curl -H "Authorization: Bearer <key>" -o 文件 <URL>`
自行取文件 —— **DSH↔DSH 点对点，workbuddy 零中转**。

---

## 2. DSH 节点 API 前提（2026-10-14 对 natpass 隧道真实节点实测）

| 能力 | 端点 | 说明 |
|---|---|---|
| 会话创建 | `POST /api/v1/sessions` | workbuddy 控制面内部 ensureSession 使用 |
| 分片直传 | `POST /api/v1/sessions/:sid/files/resumable?name=&size=&mimeType=` | → `data.uploadId`、`data.received`（断点续传入口） |
| 分片追加 | `PUT /api/v1/sessions/:sid/files/resumable/:nid?offset=N` | body=原始字节；offset ≠ 已收字节数 → **409**（`data.received` 为权威，对账后续传）；单片建议 ≤4MB |
| 进度对账 | `GET /api/v1/sessions/:sid/files/resumable/:nid` | → `data.received` |
| 分片完成 | `POST /api/v1/sessions/:sid/files/resumable/:nid/complete` | → `data.files[0].path`（工作区落盘**绝对路径**） |
| 文件下载 | `GET /api/v1/fs/download?path=<绝对路径>`；会话内相对路径走 `GET /api/v1/sessions/:sid/files/download?path=` | 跨节点下载用 |
| 鉴权 | `Authorization: Bearer <apiKey>` | **仅支持请求头**；`?api_key=` / `?token=` 实测 401。因此「完整下载 URL」= URL + 密钥成对交付，下载方加请求头 |
| CORS | 回显 Origin，放行 `GET/POST/PUT/DELETE/OPTIONS` 与 `Content-Type, Authorization, Accept` 头 | 浏览器可直连（控制台直传依赖此项，已实测） |

> 节点侧协议由 `dsh-web-service` 提供；旧版节点无 `/files/resumable` 时不支持本方案（P2P 无降级中继，见 §8）。

---

## 3. 控制面 API（workbuddy）

均挂在任务附件面下，AI 令牌开放面已放行（`server.ts isAiTokenAllowedPath`），
鉴权与其它任务 API 一致（登录 Cookie 或 AI 令牌 Bearer/X-WorkBuddy-Token）。

### 3.1 `POST /api/tasks/:taskId/attachments/direct/init`

请求体：`{ "name": "app.log", "size": 2147483648, "mimeType": "text/plain" }`

- 校验：任务存在、`size ≤ 2GB`
- 主节点选择（`engine.directUploadInit`）：
  1. 项目工作区任务 → 项目节点主会话（`__node__`）
  2. **无成员任务（节点直发/主会话语义）→ 任务节点主会话**（draft 无会话也可，ensureSession 兜底建会话）
  3. 多成员任务 → 第一个成员所在节点（其余成员走跨节点下载，不做服务端扇出）
- `ensureSession` 后把 `{taskId,name,size,mimeType,agentId,nodeBaseUrl,nodeSessionId}` 存入
  **内存登记簿**（30 分钟 TTL，uploadId 前缀 `dup-`；不含节点密钥）

响应：

```json
{
  "ok": true,
  "uploadId": "dup-9e5e4f38…",
  "taskId": "task-6a216377",
  "name": "app.log", "size": 20971520,
  "target": { "agentId": "__node__", "agentName": "笔记本节点-DSH · 主会话",
              "baseUrl": "http://natpass.yikaihui.com:31285/api/v1",
              "apiKey": "<节点apiKey>", "sessionId": "session-945c…" }
}
```

### 3.2 `POST /api/tasks/:taskId/attachments/direct/register`

请求体：`{ "uploadId": "dup-…", "path": "<节点 complete 返回的落盘路径>", "size": 20971520, "mimeType": "text/plain" }`

- 消费登记簿（一次性，二次登记报「不存在或已登记过」）
- 写入 `task.attachments`：`{name, path, size, mimeType, agentId, agentName, remoteSessionId, nodeBaseUrl, source:"direct", uploadedAt}`
- 生成跨节点下载 URL：绝对路径 → `{node}/fs/download?path=`；相对路径 → `{node}/sessions/:sid/files/download?path=`

响应：

```json
{
  "ok": true,
  "attachment": { "name": "app.log", "path": "/Users/tsbj/.dsh/profiles/desktop/app.log",
                  "size": 20971520, "downloadUrl": "http://…/api/v1/fs/download?path=%2FUsers%2F…" },
}
```

### 3.3 双地址：内网/本机基址优先（会话自证）

mapping 节点的 ONENAT 目录带 `local` 字段（natpass 隧道的节点侧本机端，如 `127.0.0.1:19387`），
init 会据此合成 `direct.baseUrlIntranet` 一并下发。**该地址有歧义**——每个节点的本机端都长这样，
客户端无法从地址判断通向的是不是目标任务节点。

判定不靠猜，靠**会话自证**：直传接口全部会话作用域（sessionId 是目标节点上的 UUID），
对内网基址发一次节点 init——返回 `uploadId` 即证明通向的就是目标任务节点（可全程走内网）；
404/401/超时则回退公网基址。即使探测被绕过，后续每个分片 PUT 也带 sessionId，错误机器上写不进任何字节。

- 两套基址除前缀外端点完全一致，apiKey 通用
- 提速场景：调用方与节点同机/同内网（AI 宿主跑在节点本机上时走回环）
- 代价：跨内网时多付一次短超时探测（wbmcp 6s / 控制台 5s）
- **实战验证（2026-10-14，internal-deploy 线上 4 节点全测）**：
  - 同机命中：AI 宿主=笔记本节点，目标=笔记本节点（local 127.0.0.1:19387）→ 内网回环，20MB 2s（公网 54s）
  - 跨内网回退：目标=测试环境B（local 127.0.0.1:3080，本机该端口无监听）→ 即时 Connection refused → 回退公网，1MB 6s
  - **端口碰撞（最严苛）**：目标=家 WINDOWS 笔记本（local 同为 127.0.0.1:19387）→ 探测撞上本机自己的真实 DSH →
    会话自证拒绝（本机 DSH 不认识家 WINDOWS 任务创建的 sessionId）→ 回退公网，文件正确落至
    `C:\Users\webmaster\...`，本机 DSH 工作区零污染

### 3.3.1 流式代理回退（浏览器专用）

**约束**：控制台页面是 https，而节点直传地址是 http —— 浏览器混合内容策略会拦截 https→http 的
fetch（`127.0.0.1` 豁免）。因此浏览器直连仅在本机节点场景可用；目标为远程节点时两个候选
（内网/公网）都会失败。

**回退**：直连任一环节失败，控制台自动改走
`POST /api/tasks/:taskId/attachments/direct/relay?uploadId=<init 下发的会话>`——
浏览器把整文件 PUT 给 workbuddy（同源 https，无混合内容问题），服务端**边收边以 4MB 分片**
写入节点 resumable 会话（纯管道不落盘，>8MB 触发读端背压，内存有界），节点 complete 后自动登记附件
（等价 register，返回 attachment/downloadUrl/downloadUrlIntranet）。失败可重试（重新 init 全量重传）。

- AI/wbmcp 通道无混合内容概念，保持纯 P2P 直传，不走此端点
- 代价：浏览器 + 远程节点场景带宽回到隧道速度（如 测试环境B ~0.4MB/s）；同机节点仍走 127.0.0.1 直连豁免
- 状态面板：代理上传阶段进度条为浏览器→workbuddy 实速；满格后节点侧收尾通常瞬间完成（管道式）

### 3.4 跨节点下载

```
curl -H "Authorization: Bearer <节点apiKey>" -o app.log "<downloadUrl>"
```

密钥即 init 响应里的 `direct.apiKey`（节点级）；**URL 与密钥必须成对交付**。
register 同时返回 `downloadUrlIntranet`（节点内网变体）——下载方与该节点同内网时优先尝试，失败用公网 `downloadUrl`。

---

## 4. 客户端接入

### 4.1 WEB 控制台（`src/web-ui.ts` uploadAttachments）

拖入/粘贴/选择文件 → 面板逐文件：`direct/init` → 直连节点三步（XHR PUT 带进度，409 对账）→
节点 complete → `direct/register` → 行状态 `✓ 已上传`，输入框自动填入
`[附件·直传] <落盘路径>` 与 `[跨节点下载] <URL>（Authorization: Bearer <节点apiKey>）`。
节点 CORS 已由 dsh-web-service 放行控制台 Origin，浏览器直传无需代理。

### 4.2 MCP / AI 工具链（`workbuddy_file_manage`）

| action | 作用 |
|---|---|
| `upload_resumable_init` | 入参 `{taskId, name, size, mimeType?}`；返回 `direct` 配方（含 curl 示例四步）+ `taskStatus` 回显（非 draft 附 `warning`：大概率 create 带了 message，执行者读不到本次上传） |
| `upload_register` | 入参 `{taskId, uploadId, path(节点 complete 返回), size?}`；登记并返回 `downloadUrl` / `downloadAuth` / `multiAgentHint` |

`workbuddy_task_manage` 描述引导大文件**四步**（防「create 带 message 任务先跑」事故，详见 §7）：
① create **不带 message**（draft 不执行）→ ② `upload_resumable_init` 按配方直连节点上传 →
③ `upload_register` 登记 → ④ `send` 引用路径（多成员附 URL+密钥）开始分析。

### 4.3 wbmcp.sh 一键封装（AI 宿主技能，`~/.agents/skills/workbuddy-mcp/`）

```
wbmcp.sh putfile <本地文件> <taskId> [远端文件名]
```

自动完成：MCP init → 直传通道优选（内网基址 6s 短超时探测，会话自证通过即走内网；失败回退公网）→
节点侧 init → 4MB 分片直连（409 对账）→ 节点 complete → MCP upload_register →
回显「落盘路径 + 跨节点下载 URL」。中断/超时直接重跑：状态文件（`$TMPDIR/wb-putfile-*.json`）
自动从节点断点续传，完成后自清。实测 20MB：公网隧道 54s → 内网回环 **2s**（27×）。

---

## 5. 安全考量

- **节点 apiKey 经 init 下发给调用方**（浏览器/AI）——P2P 直传的固有代价，方案拍板时接受；
  泄漏面 = 可操作该节点 DSH API。节点密钥为映射级凭证，workbuddy 侧不额外落盘（登记簿只存地址/会话）。
- **任务须用 mapping 形态 nodeRef**：direct 形态 nodeRef（仅 apiBaseUrl）没有可解析凭证，
  init 会下发空密钥 → 节点 401。生产建任务用 `{kind:"mapping", mappingId}`（tools 通道 create 现已两种都支持）。
- 下载接口无 query 密钥签名机制（dsh-web-service 现状），如需「可公开转发的自包含 URL」
  需要在 dsh-web-service 侧增加签名下载端点 —— 列为后续可选项（§8）。

---

## 6. 验证

- 本地 e2e（stub 模拟节点 resumable/download 协议 + Bearer 校验 + CORS 头）：
  - `scripts/attachment-ai-token-e2e.mjs`（AI 令牌通道，21 项）：draft 引导 / init 配方 / 节点 409 对账 /
    complete 路径 / register / 跨节点下载字节一致 + 无密钥 401 / 防重复登记 / 超 2GB 拒绝 / 非 draft 警示 / MCP 通道
  - `scripts/attachment-e2e.mjs`（控制台会话通道，7 项）：登录 → init → 直传 → register → 附件 → 下载比对
- MCP 冒烟 `scripts/smoke-mcp-server.mjs` 25/25；typecheck + standalone 构建通过
- 线上（internal-deploy 公网入口 + 笔记本节点真实节点）：wbmcp putfile 20MB 全程 54s；
  下载 URL + 密钥取回**字节级一致**（cmp）；附件 `source=direct` + nodeBaseUrl；旧中继端点已 403/404 下线

---

## 7. 已知边界与后续可选项

1. **旧版 DSH 节点**（无 `/files/resumable`）无法使用 P2P 直传，无自动降级（旧中继已删）。
   节点需 dsh-web-service 支持分片协议。
2. **direct 形态 nodeRef 无凭证**（§5）。
3. 附件登记为信任模式：register 不主动到节点校验文件存在（调用方持 AI 令牌/登录态，伪造面有限）。
   如需强校验可在 register 时调节点 fs/list 比对。
4. 多成员任务的编排派发提示词**不会自动注入**下载 URL——依赖 send 消息携带（工具响应已给出现成片段）。
   若要「零消息携带」，可在 orchestrator 里为非主节点子任务自动附下载指引（后续可选）。
5. 小文件 `upload`（base64 ≤1MB / URL ≤10MB）与 `/api/agents/fs/upload`（控制台子智能体文件管理）
   保持 workbuddy→节点直发语义不变（数据面，但它们本就直发节点、无暂存）。

## 8. 故障排查速查

| 现象 | 原因 | 处置 |
|---|---|---|
| 节点 init 401 `Invalid or missing API key` | 任务是 direct nodeRef（无凭证）或映射凭证失效 | 用 mapping nodeRef 建任务；检查 ONENAT 映射凭证 |
| init 报「节点不可用」 | 任务无任何节点上下文（无 nodeRef/项目/成员且未配默认节点） | create 带 nodeRef 或 projectId |
| register 报「直传会话不存在或已登记过」 | uploadId 已消费或超 30 分钟 | 重新 init |
| 节点 PUT 409 | offset ≠ 节点已收字节（并发/重试） | 按 409 响应 `data.received` 对账续传（putfile/控制台自动处理） |
| 下载 401 | 未带 Bearer 头或密钥错 | `-H "Authorization: Bearer <init 返回的 apiKey>"` |
| 内网通道探测失败（正常现象） | 调用方与节点不同机/不同内网 | 自动回退公网隧道，无需处理 |
| 控制台报「所有直传通道均不可达」且不回退 | 旧版前端（无流式代理回退） | 重新部署/强刷页面 |
| 浏览器控制台出现 Mixed Content 报错 | https 页面直连 http 节点被拦 | 属预期：前端已自动改走流式代理，无需处理 |
| 跨节点下载 404 | path 与节点侧实际落盘不一致 | 以节点 complete 返回的 `files[0].path` 为准 |

---

## 附录 A. 关键代码位置

| 内容 | 位置 |
|---|---|
| 控制面（init/register/登记簿/下载 URL） | `src/engine.ts` `directUploadInit` / `directUploadRegister` / `buildNodeDownloadUrl` |
| 路由 | `src/router.ts` `attachments/direct/init|register` |
| AI 令牌开放面 | `src/server.ts` `isAiTokenAllowedPath` |
| MCP 工具（直传配方/登记/引导文案） | `src/tool-ops.ts` `workbuddy_file_manage` |
| 控制台直传面板 | `src/web-ui.ts` `uploadAttachments`（nodeJson + uploadOne） |
| 节点协议客户端（workbuddy 自用） | `src/remote-client.ts` `uploadFileResumable` / `downloadFile` / `fsDownload` |
| 一键封装（AI 宿主侧，仓库外） | `~/.agents/skills/workbuddy-mcp/wbmcp.sh` putfile；`SKILL.md` 三步流程章节 |
| e2e | `scripts/attachment-ai-token-e2e.mjs`、`scripts/attachment-e2e.mjs` |

## 附录 B. 演进史（考古）

| 阶段 | 方案 | 退役原因 |
|---|---|---|
| v1 控制台中继 | 浏览器分片 → workbuddy 暂存 `uploads/*.part` → complete 同步 4MB 分片中继到节点 | complete 同步阻塞：110MB 经 natpass 隧道（~0.3MB/s）中继 6 分钟，代理必然掐断调用方连接；complete 不幂等重试会落双份文件 |
| v2 异步受理 | complete 立即受理（meta→.relaying 原子认领锁），中继转后台，客户端轮询任务附件 | 解决了连接被掐与双份文件，但中继带宽仍受隧道限制，workbuddy 仍是数据面瓶颈与单点 |
| **v3 P2P 直传（现行）** | workbuddy 只做控制面，客户端直连 DSH 节点，跨节点经下载 URL 互访 | —— |

v1/v2 时代的其它沉淀已被 v3 继承：AI 令牌开放面、`upload_resumable_init` 非 draft 警示、
「create 不带 message（draft）→ 传附件 → send」三/四步引导、draft 回执防误导文案。
