# onenat-workbuddy-web 安全评审报告（Review Security）

> 生成时间：2026-10-16 · 角色：应用安全工程师（技术方案评审团）
> 工作目录：`/Users/tsbj/feyanggit/DHS-test/onenat-workbuddy-web` · 静态分析评审，未修改任何代码，未执行任何攻击性/破坏性验证
> 基线：已读 `docs/review-baseline.md`（其确认 docs/ 下无既往安全评审记录 → 按**首次安全评审**处理；git HEAD=`d1f96ac` 后无新源码提交）
> 方法：路由/门禁逐点走读 + 敏感数据落盘与日志路径追踪 + 依赖靶向核对（2 项 CVE）+ 本机数据目录权限只读佐证（`ls -la ~/.onenat-workbuddy/`）

---

## 结论摘要

1. **鉴权门禁主体是单点且闭合的**（`server.ts:427-450` 统一会话/AI 令牌判断；`import-create` 公开门禁后路由内还有严格令牌校验），未发现无需凭据即可写业务数据的绕过；但**"AI 令牌"这一通道权限过大且携带能力过重**，是本报告最大风险簇（V5/V6/V7/D1）。
2. **敏感凭据明文落盘且权限为 0644**：`store.json`（ONENAT apiKey、各子智能体/项目 apiKey、小智接入点）与 `ssh-resources.json`（SSH 密码/私钥）均为无 mode 的 `writeFileSync`（默认 0644），同库 `auth.json`/`ai-token.json` 却是 0600——属遗漏而非设计，本机实例已实测复现（store.json=`-rw-r--r--`，3.6MB）。
3. **依赖面干净但命中一条**：运行时依赖仅 ssh2/undici；靶向核对确认 `ssh2@1.17.0`（锁定版本）命中 CVE-2025-70034（ReDoS，CVSS 7.5），`undici@7.30.0` 不受 CVE-2025-47279 影响（修复于 7.5.0）。
4. 登录限流键可被伪造 `X-Forwarded-For` 绕过（V4）；AI 令牌可经 URL query 传递且请求日志记录完整 query（V3）——凭证防护的最后两块短板。
5. **阻断放行建议**：V2（明文密钥 0644）、V7+V6（AI 令牌可达 SSH 凭据获取/任意执行与节点凭据下发）、V4（暴露形态）、V5（AI 令牌面 SSRF）四簇未修复前，禁止向不受信方发放 AI 令牌、禁止 0.0.0.0 直接暴露形态放量。

---

## 1. 结论（本职责：权限与安全风险）

按任务合同三类检查项回答：

- **外部输入入口**：共盘点 17 类入口（§2），全部收敛到统一门禁；入口面本身无未授权写路径。风险集中在入口**可达之后的能力面**（工具通道含 SSH get/exec、fs 面含任意 direct baseUrl SSRF、直传 init 下发节点凭据）。
- **鉴权/授权检查点**：认证实现质量总体良好（scrypt+常数时间比较+失败延迟+HMAC 下载令牌均正确）；缺陷在**限流键可伪造**（V4）与**授权粒度**——单租户全平权、AI 令牌≈管理员且永不过期（D1）。
- **敏感数据流**：凭据静态保护两极分化（0600 vs 0644，V2）；令牌经 query 泄入日志（V3）；节点级 API Key 会被下发给任意调用方（V6）、按绑定策略注入任务提示词流向远端 LLM（设计内，已在 §4 标注）。
- **需要决策的建议**：把"AI 令牌"从"管理员等价令牌"降级为"最小能力集成令牌"（工具白名单 + 可过期 + 审计），并统一数据文件 0600。这是修复收益最大的两个动作。

## 2. 外部输入入口清单

| # | 入口 | 位置 | 鉴权要求 | 备注 |
|---|------|------|---------|------|
| 1 | `POST /api/auth/login` | server.ts:314-331 | 公开 | 失败限流 10 次/5 分钟/IP（键可伪造 → V4）；失败 400ms 延迟 |
| 2 | `POST /api/auth/logout`、`/api/auth/password`；`GET /api/auth/me` | server.ts:332-360 | 会话 | 改密吊销该用户全部会话（auth.ts:205-207 ✓） |
| 3 | `GET /healthz`（含 prefix 变体） | server.ts:284-296 | 公开 | 暴露 version/uptime/ONENAT baseUrl → D3 |
| 4 | `GET /`、`/console`、`/monitor`（未登录回落登录页/投屏页） | server.ts:299-304, 433-445 | 公开（页面） | 仅静态 HTML 渲染 |
| 5 | `GET /install-skill.sh`、`/install/**`、`/install/skills.json`、`/install/skills/:name` | server.ts:363-405 | 公开 | 文件名白名单 `/^[a-z0-9-]+\.md$/`（:392）拒绝路径穿越 ✓；资产内容无秘密 ✓ |
| 6 | `GET /library/file/:kind/:id?token=` | server.ts:408-425 | HMAC 签名令牌 | 签名/校验实现正确（library.ts:189-210：HMAC-SHA256+exp+timingSafeEqual ✓）；token 走 query → V3 |
| 7 | `POST /api/projects/import-create?token=` | server.ts:430-432（门禁仅要求非空）；router.ts:866-873（路由内校验 `pendingProjectImports` 64hex 随机令牌、2h TTL） | 一次性令牌 | 门禁宽松但路由内校验严格，**不构成未授权写**；令牌在提示词中下发远端节点（§4/D4） |
| 8 | `GET /api/tools`、`POST /api/tools/:name`（14 个工具） | server.ts:452-483；tool-ops.ts:1391 | 会话**或 AI 令牌** | 含 `workbuddy_ssh_resource_manage`（get=取完整凭据/exec=任意命令，tool-ops.ts:709-762）→ V7 |
| 9 | `/mcp`、`/mcp/`、`/api/experts/mcp`、`/api/mcp/status` | server.ts:485-502 | 会话或 AI 令牌 | MCP 内部实现未逐行审计 → G5 |
| 10 | 全部 `/api/**` 业务路由 | server.ts:505 → router.ts dispatch | 会话或 AI 令牌 | AI 令牌开放面白名单 server.ts:546-569 → D1 |
| 11 | `GET /api/tasks/:id/stream`（SSE） | router.ts:2883-2903 | 会话（AI 开放面不含 stream ✓） | 无背压处理（可用性，见 §6 D6 交叉引用） |
| 12 | 文件上传：`POST /api/tasks/:id/attachments`（≤2GB）、`/api/agents/fs/upload`、`/api/agents/:id/skills/upload`、`/api/library/:kind/upload`、`/api/tasks/:id/attachments/direct/{init,register,relay}` | router.ts:2784-2847, 1596-1620, 1832-1861, 1975-1990；engine.ts:2880-2976, 2977-3047 | 会话或 AI 令牌（tasks 附件面在 AI 开放面内，server.ts:560-562） | 2GB 整包内存缓冲（可用性）；direct/init 回传节点 apiKey → V6 |
| 13 | URL 参数：`node`（dshRef JSON）、`token`、`filename`/`x-filename` 等 | router.ts:200-213（resolveFsTarget 直收 node JSON） | 随所在路由 | `node` 直接作为 fetch 目标 → V5（SSRF） |
| 14 | 环境变量/CLI：`WORKBUDDY_TOKEN`、`WORKBUDDY_ADMIN_PASSWORD`、`ONENAT_API_KEY` 等 | server.ts:88-100 | 进程启动面 | 经 shell history/env 可泄露（次级，列为 D3 关联项） |
| 15 | 数据文件（本机写面）：auth.json / store.json / ssh-resources.json / ai-token.json / user-experts.json | auth.ts:59、store.ts:200、ssh-store.ts:201（server.ts:201）等 | 文件系统权限 | 权限两极分化 → V2 |
| 16 | 出站通道的**响应侧**（不可信输入）：ONENAT 目录刷新（60s）、远端 DSH SSE（LLM 输出）、小智 WS 对端、SSH 对端 | onenat.ts、remote-client.ts、xiaozhi-mcp.ts、ssh-resources.ts | — | 远端 LLM 输出回流驱动平台工具 → D4；对端 SSH 主机可触发 ssh2 解析 → V1 |
| 17 | 间接入口：任务消息/附件 → 远端 LLM → 工具调用（提示词注入面） | engine.ts:713+、tool-ops.ts | 会话/AI 令牌 | LLM 输出可驱动 `workbuddy_*` 全套工具（含 SSH exec）→ D4/D7 |

## 3. 鉴权与授权检查点及绕过分析

**做得对的（值得保持）**：
- 密码哈希：`scrypt` 加盐 64 字节 + `timingSafeEqual` 常数时间比较（auth.ts:36-44, 160）✓
- 登录失败限流 + 400ms 失败延迟 + 登录接口不记请求日志（server.ts:278, 324）✓
- 会话 Cookie：HttpOnly + SameSite=Lax（缓解 CSRF POST）+ 7 天滑动 + 改密全吊销（auth.ts:223-229, 196-209）✓
- AI 令牌校验：未配置时 fail-closed 拒绝一切（auth.ts:117-120）✓
- 库文件下载令牌：HMAC-SHA256 + 过期 + 常数时间比较（library.ts:189-210）✓
- `import-create` 双层校验：门禁放行后路由内仍校验真实随机令牌（router.ts:867-873）✓
- SSH 资源 list 场景正确脱敏（ssh-resources.ts:69-74 剥离 password/privateKey/passphrase）✓
- 未登录访问业务 API 统一 401（server.ts:433-437）✓

**绕过/弱化点（详见 §6 风险表）**：
- **V4** 限流键取 `x-real-ip`/`x-forwarded-for` 头且优先于 socket 地址（server.ts:311）——直接暴露或反代未清洗时，轮换 XFF 即绕过爆破防护，同时使 `failCounts` Map 无限增长（auth.ts:153-171）。
- **D1** 授权无资源级粒度：所有登录用户平权读写全部任务/智能体/凭据（auth.json 仅可手工增用户，无管理 API）；AI 令牌开放面（server.ts:546-569）覆盖工具通道/任务/项目/规划器/资源目录/文件面——**一个 AI 令牌 ≈ 管理员**，且永不过期、无审计绑定。
- **D3 关联**：Cookie `Secure` 仅在 `x-forwarded-proto=https` 时附加（server.ts:310；auth.ts:223-225），明文局域网部署可被嗅探。
- 用户名枚举计时侧信道：用户不存在时跳过 scrypt，响应显著更快（auth.ts:159-160）。

## 4. 敏感数据（凭据/令牌/个人数据）存储、日志与传输路径

### 4.1 存储（本机实例已实测佐证）

| 文件 | 内容 | 权限（代码/实测） | 结论 |
|------|------|------------------|------|
| `auth.json` | 用户名+scrypt 哈希（无明文） | mode 0600（auth.ts:138）✓ | 正确 |
| `ai-token.json` | AI 通道令牌 | mode 0600（auth.ts:84）✓ | 正确 |
| **`store.json`** | **ONENAT apiKey、agents[].apiKey、projects[].apiKey、xiaozhi endpoints（可含 token）** | 无 mode（store.ts:123）→ **0644（本机实测 `-rw-r--r--`）** | **V2** |
| **`ssh-resources.json`** | **SSH password / privateKey / passphrase 明文** | 无 mode（ssh-store.ts:40）→ 0644 | **V2** |
| `monitor/events-*.jsonl` | 任务标题、成员名、事件（无正文） | appendFileSync 无 mode → 0644（monitor.ts:397；本机实测） | 低（随 V2 一并收敛） |
| `library/` 技能/插件归档 | 上传内容 | 无 mode（library.ts:141）→ 0644 | 低 |

### 4.2 日志输出

- 请求日志记录**完整 query**：`console.log(...${url.pathname}${url.search}...)`（server.ts:279）。而 AI 令牌、库下载令牌、导入令牌均支持 `?token=`（server.ts:542；408-411；837）→ **令牌明文入服务端日志/反代日志**（V3）。
- 登录接口日志已跳过（server.ts:278）✓；auth.login 不输出密码 ✓。

### 4.3 传输路径

- 出站 fetch 的 TLS 由 `baseUrl` 决定：mapping 型节点可为 http（remote-client.ts 全部调用点）——内网明文（设计内，提示部署要求）。
- **directUploadInit 将目标节点的 `baseUrl + apiKey + sessionId + intranetBaseUrl` 作为 JSON 响应回传调用方**（engine.ts:3036-3046）——节点级长效凭据离开服务边界（V6）。
- 资源绑定凭据按"绑定策略注入任务提示词"流向远端 DSH 节点 LLM（产品语义，engine/scheduler 注释明示）——设计内的敏感流向，依赖远端节点的可信度（D4 关联）。
- 小智通道支持明文 `ws://` 出站，对端获得全量工具调用能力（xiaozhi-mcp.ts:5）（D5）。

## 5. 依赖已知高危项与不安全默认配置

### 5.1 依赖（运行时仅 2 个，靶向核对）

| 依赖 | 锁定版本 | 结论 | 依据 |
|------|---------|------|------|
| ssh2 | **1.17.0**（pnpm-lock） | **命中 CVE-2025-70034**：CWE-1333 正则复杂度缺陷（ReDoS），CVSS 7.5（AV:N/AC:L/PR:N/UI:N → A:H），受影响版本标注为 1.17.0；通告页未给出修复版本 | [Strix CVE-2025-70034](https://www.strix.ai/cve/CVE-2025-70034)（引 NVD）、[第三方通告 gist](https://gist.github.com/zcxlighthouse/78a0d9b7fcae20294076e8b24f763ce5)。**未做利用复现**（见 §8 场景 7） |
| undici | 7.30.0 | 不受 CVE-2025-47279 影响（webhook 式重复调用 + 无效证书导致内存泄漏；修复于 5.29.0/6.21.2/**7.5.0**，锁定版本更高） | [Debian Security Tracker CVE-2025-47279](https://security-tracker.debian.org/tracker/CVE-2025-47279) |

可达路径（V1）：SSH 资源 `test`/`exec`（tool-ops.ts:738-749 → ssh-resources.ts）会对**调用方指定主机**发起真实 SSH 握手；若已认证主体将 test 指向恶意 SSH 服务端，畸形 banner/握手响应可触发解析 ReDoS——在本服务单事件循环架构上表现为**进程级停顿**（与上一轮可用性报告 R1 同放大器）。

### 5.2 不安全默认配置

| 项 | 位置 | 问题 | 归类 |
|----|------|------|------|
| 默认管理员 `workbuddy`/`workbuddy-admin` 首次启动自动播种 | auth.ts:62-64；server.ts:80 | 暴露形态下可直接登录（帮助文本有提示但无强制改密） | D3 |
| `--host 0.0.0.0` 允许对外暴露 | server.ts:89, 688 | 仅控制台告警，无强约束（配合 V4/D3 风险放大） | D3 |
| Cookie `Secure` 条件性 | server.ts:310；auth.ts:223-225 | 明文部署可嗅探会话 | D3 |
| `/healthz` 未认证信息暴露 | server.ts:284-296 | version/uptime/ONENAT baseUrl 侦察价值 | D3 |
| 500 响应回显内部 `err.message` | server.ts:509-511 | 内部细节泄露 | D3 |
| 敏感数据文件 0644 | store.ts:123；ssh-store.ts:40 | 见 V2 | V2 |

## 6. 风险摘要表

> 类别：**V=已验证漏洞**（代码级证据确凿；标注"未复现"者指未做运行时利用验证）；**D=设计风险**；**G=材料缺口**。严重度按可利用性×业务影响标定（非纯 CVSS）。

| 编号 | 类别 | 严重度 | 位置 | 攻击/触发前提 | 影响 | 最小修复建议 | 验证状态 |
|------|------|--------|------|--------------|------|-------------|---------|
| V7 | 已验证 | **Critical** | tool-ops.ts:709-762 + server.ts:548（`/api/tools` 在 AI 开放面） | 任一持 AI 令牌的主体（外部智能体/脚本/MCP 客户端——产品主用法）调用 `workbuddy_ssh_resource_manage` 的 `get`/`exec` | 读取 SSH 资源池**全部明文凭据**（密码/私钥）并在配置主机上**执行任意命令**——主机级失陷 | `get`/`exec` 移出 AI 令牌开放面（仅登录会话）；或按工具白名单签发作用域令牌 | 代码级验证；未做运行时调用复现（计划） |
| V6 | 已验证 | High | engine.ts:3036-3046（directUploadInit 返回 target.apiKey）+ server.ts:562（direct 面开放 AI 令牌） | 持 AI 令牌或登录会话调用 `POST /api/tasks/:id/attachments/direct/init` | 获得 DSH 节点长效 API Key + 会话 + 内网基址——可完全控制该节点 | 不回传 apiKey：改发一次性签名直传凭证（HMAC uploadId，节点侧校验）；或 direct 面移出 AI 开放面 | 代码级验证 |
| V5 | 已验证 | High | router.ts:200-213（`node` 参数直收 dshRef JSON）→ resolver.ts:44-45（direct 直接采用 apiBaseUrl）→ 响应回读（router.ts:174, 1954-1956）；`/api/agents/fs/**` 在 AI 开放面（server.ts:556）；同类：`/api/agents/ping`（router.ts:2311 收任意 apiBaseUrl） | 持 AI 令牌（fs 面）或登录会话（ping） | SSRF：本服务向任意 URL（内网/环回/云元数据）发请求并**回读响应**——内网探测与凭据窃取 | direct 型 baseUrl 仅接受存储中登记节点，或拒绝私网/环回/链路本地段；fs 面禁用 direct 形态 | 代码级验证；未发起实际内网请求（计划） |
| V2 | 已验证 | High | store.ts:123；ssh-store.ts:40；library.ts:141；monitor.ts:397 | 同主机任意低权账户/备份管道/误同步读取数据目录 | **全部节点 API Key、SSH 密码/私钥明文泄露**（本机实测 store.json=0644 已复现） | 三处 `writeFileSync` 补 `mode: 0o600` + 启动时对存量文件 `chmod 600`；数据目录整体 0700 | 代码级 + 本机权限实测 ✅ |
| V4 | 已验证 | High（暴露形态下）/ Medium（默认本机） | server.ts:311（XFF 优先）+ auth.ts:153-171 | 服务直接暴露（支持 0.0.0.0）或反代未清洗 XFF；攻击者轮换 `X-Forwarded-For` | 登录爆破限流被绕过；`failCounts` Map 无限增长 → 内存耗尽（同进程拖垮登录与任务） | 可信反代开关（trust-proxy），未配置时一律用 `req.socket.remoteAddress`；failCounts 容量上限 | 代码级验证；未实测绕过（计划，见 §8-4） |
| V1 | 已验证（第三方通告，版本匹配） | Medium | ssh2@1.17.0（pnpm-lock）；可达点：tool-ops.ts:738-749 test/exec → ssh-resources.ts | 已认证主体配置 SSH 资源 test/exec 指向攻击者控制的恶意 SSH 服务端 | ReDoS（CVE-2025-70034）→ 事件循环停顿，进程级可用性影响 | 跟进上游修复版本升级；test/exec 限可信主机段 + 既有超时兜底 | 通告比对 ✅；利用未复现（隔离环境计划） |
| V3 | 已验证 | Medium | server.ts:542（query 取令牌）+ server.ts:279（日志记完整 query）；涉及 AI 令牌/库令牌/导入令牌 | 任何经 `?token=` 的调用 | 令牌明文进入服务端与反代日志（AI 令牌无过期 → 泄露长期有效） | 令牌仅接受 Header；请求日志对 search 脱敏 | 代码级验证 |
| D1 | 设计风险 | High | server.ts:546-569（AI 开放面）；auth.ts（令牌无过期）；无资源级 ACL | AI 令牌签发/泄露；多登录用户场景 | 令牌≈管理员（全工具+全数据+无审计）；任意用户可读全部凭据与任务 | 令牌作用域化（工具白名单）+ 过期 + 审计；多用户时资源级授权 | 设计审查 |
| D2 | 设计风险 | Medium | router.ts:1291（`GET /api/settings` 全量回显 `aiToken`） | 登录会话（或任意前端 XSS） | AI 令牌被读取（对比：onenat.apiKey 已打码 8 字符 ✓） | 仅返回 `hasAiToken` + 尾 4 位 | 代码级验证 |
| D3 | 设计风险 | High（暴露形态）/ Medium（默认） | auth.ts:62-64；server.ts:89,284-296,509-511,688；auth.ts:223-225 | 默认口令未改 + 0.0.0.0 部署；明文局域网 | 默认凭据登录、健康检查侦察、错误细节泄露、会话嗅探 | 首登强制改密；0.0.0.0 时强制改默认口令；healthz 收敛；500 通用化 | 设计审查 |
| D4 | 设计风险 | Medium | engine.ts（任务链路）；router.ts:834-861（导入令牌入提示词、2h 可重用窗口）；tool-ops.ts（LLM 可驱动全套工具） | 远端 DSH 节点被攻陷或上游提示注入 | 平台写操作（建项目/绑连接器/派任务/SSH exec）被间接驱动 | 敏感工具二次确认或白名单；导入令牌改一次性作废 | 设计审查 |
| D5 | 设计风险 | Medium | xiaozhi-mcp.ts:5（支持 ws:// 明文；对端免鉴权即得全量工具） | 接入点配置错误/被篡改/中间人 | 语音平台对端获得全部工具能力（含 SSH exec） | 强制 wss + 共享密钥握手；配置页安全告示 | 设计审查 |
| D6 | 设计风险 | High（可用性） | 上一轮报告 R1-R5：store 同步落盘（store.ts:114-127）、scryptSync（auth.ts:37）、2GB 内存上传（router.ts:3202-3220）、任务并发无上限（engine.ts:804-815） | 任意运行中任务/上传/登录风暴（含定时任务自动触发） | 登录/鉴权全 API 随任务负载排队，store 增长无自愈 | 详见上一轮《任务执行阻塞登录》报告的 P0-P1 修复集 | 代码级验证（前轮） |
| D7 | 设计风险 | High（待审计确认） | web-ui.ts 197 处 `innerHTML`（`esc()` 存在于 :2536，未逐点核验）；渲染源含远端 LLM 输出（不可信） | 存在任一未转义插值点 + 诱导用户/任务内容 | 存储型 XSS → 管理员浏览器代发请求（D2 使 aiToken 可被读取，放大） | 前端专项审计（→G1）；统一经 `esc()`/DOM API 渲染 | **未审计**（材料缺口 G1） |
| G1 | 材料缺口 | — | web-ui.ts / monitor-ui.ts | — | — | 197+16 处 innerHTML 逐点转义核验 | 未执行 |
| G2 | 材料缺口 | — | pnpm-lock.yaml / CI（无） | — | — | 全量 SCA 扫描（本次仅靶向 2 CVE）；补 CI+SCA 门禁（基线 §6 亦列无 CI） | 未执行 |
| G3 | 材料缺口 | — | 部署环境 | — | — | 生产部署形态（反代/TLS/绑定地址/数据目录备份与同步面）未提供 | 未获取 |
| G5 | 材料缺口 | — | mcp-server.ts / expert-mcp.ts | — | — | MCP 请求处理内部逐行审计（外层门禁已确认统一，内层未审计） | 未执行 |
| G6 | 材料缺口 | — | 生产实例数据目录 | — | — | 生产数据文件权限现状/是否已入备份 | 未获取 |

## 7. 阻断放行条件清单

满足**任一条**即不建议放量/对外发放能力，直至对应修复落地：

1. **V2 未修复**：禁止在共享主机/多账户环境/有备份同步链路的形态下运行（明文凭据 0644 可被同机任意账户读取）。修复成本低（三处 mode + chmod），应最优先。
2. **V7/V6 未修复**：**禁止向任何不受信集成方/第三方智能体发放 AI 令牌**（当前 AI 令牌等价于"SSH 全凭据读取 + 任意远程执行 + 节点 API Key 获取"）。
3. **V5 未修复**：同上，AI 令牌持有者可借 fs 面 SSRF 探测内网——开放面收紧前 AI 令牌不得出信任边界。
4. **V4 + D3 未修复**：禁止 `--host 0.0.0.0` 且无可信反代/TLS 的直接暴露形态上线（默认口令 + 限流绕过叠加）。
5. **V1 未排期**：SSH 资源 test/exec 不对非可信主机段开放（恶意 SSH 服务端可触发 ReDoS）。
6. **（继承上一轮）D6/R1 未修复**：任务并发负载形态下登录 P99 超约定 SLO（建议 2s，待质量角色确认）则阻断。

## 8. 需质量角色补充覆盖的验证场景（仅描述场景，不设计用例）

1. **前端 XSS 专项**：以任务正文、工具结果、项目名、智能体名为注入源（含 `<img onerror>`/事件属性/伪协议类载荷），遍历 web-ui/monitor-ui 全部 innerHTML 渲染点，确认全部经转义、无会话代发可能（对应 D7/G1）。
2. **SSRF 收紧验证**：持 AI 令牌以 `node={"kind":"direct","apiBaseUrl":"http://127.0.0.1:<内部端口>"}` 及云元数据地址形态调用 `/api/agents/fs/**`，确认白名单/私网拒绝生效（对应 V5）。
3. **AI 令牌面收缩验证**：仅持 AI 令牌依次调用 `workbuddy_ssh_resource_manage(get)`、`attachments/direct/init`、`GET /api/settings`，确认收缩后返回 403 且响应不含 apiKey/aiToken 明文（对应 V7/V6/D2）。
4. **限流绕过验证**：单 socket 轮换 XFF 发起 1000 次失败登录，确认 429 按真实 socket 地址触发且 failCounts 内存有界（对应 V4）。
5. **文件权限验证**：新写 store.json/ssh-resources.json 权限为 0600，存量文件迁移 chmod 生效，升级路径无回归（对应 V2）。
6. **凭证日志验证**：分别经 Header 与 query 携带令牌调用，检查服务端日志/反代日志无任何令牌明文（对应 V3）。
7. **ssh2 ReDoS 复现性评估**：在隔离环境用受控恶意 SSH banner 对 test 路径做时间测量，确认触发条件与上游修复版本有效性（对应 V1）。
8. **导入回调令牌重放**：捕获 createUrl 中的 token，在 2 小时窗口内重放，确认重用窗口的业务影响与一次性化后的行为（对应 D4）。
9. **（继承上一轮）**长流式任务 + 并发登录 + 大上传组合下的事件循环停顿与登录 P99 采样（对应 D6）。

## 9. 材料缺口与假设声明

**假设**：
- 已按 `docs/review-baseline.md` 采信基线（无既往安全评审记录 → 首次评审）；基线本身经上游实测验证。
- 本机 `~/.onenat-workbuddy/` 仅做只读权限佐证（`ls -la`），该实例视为开发实例，不作为生产结论。

**未执行的检索与测试（如实声明）**：未启动服务、未发送任何测试请求、未复现任何漏洞利用（V1/V4/V5 的利用仅代码级推演，复现列为 §8 计划）；依赖仅靶向核对 2 条 CVE，未做全量 SCA（G2）；web-ui.ts 11,268 行未逐行审计（G1）；mcp-server.ts/expert-mcp.ts 内部实现未逐行审计（G5）。外部通告来源：[Debian Tracker（undici CVE-2025-47279）](https://security-tracker.debian.org/tracker/CVE-2025-47279)、[Strix（ssh2 CVE-2025-70034）](https://www.strix.ai/cve/CVE-2025-70034)。

---

## 验收对照

| 验收标准 | 通过情况与证据 |
|---------|--------------|
| ① 产出安全评审文档（docs/review-security.md），每个发现含位置、攻击前提、影响、最小修复建议 | ✅ 本文件；§6 风险摘要表 19 行（V×7 / D×7 / G×5）均含六要素，位置精确到 file:line |
| ② 至少覆盖：外部输入入口清单、鉴权/授权检查点、敏感数据存储与传输路径三类检查项 | ✅ §2（17 类入口清单表）、§3（8 项正确实现 + 4 项弱化点）、§4（存储 7 文件/日志 2 项/传输 4 条路径）；另覆盖 §5（依赖 2 项 CVE 核对 + 6 项不安全默认） |
| ③ 区分"已验证漏洞"（附验证方式或证据）、"设计风险"、"材料缺口"三类 | ✅ §6 类别列：V=已验证（证据=代码定位/本机权限实测/外部通告比对，并逐项标注"未复现"项）、D=设计风险、G=材料缺口（5 项，注明未执行原因） |
| ④ 单独列出阻断放行条件清单及需质量角色补充覆盖的验证场景 | ✅ §7 六条阻断条件（按形态分级）；§8 九个验证场景（仅描述场景） |
| ⑤ 不擅自修改代码或发起破坏性验证 | ✅ 全程只读：未改任何业务代码（本文件为新增文档）、未启动服务、未发送测试请求、未复现攻击；外部动作仅 2 次公开 CVE 通告查询 + 本机数据目录只读 `ls` |
