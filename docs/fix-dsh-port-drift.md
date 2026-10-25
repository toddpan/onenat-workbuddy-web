# DSH 节点端口漂移导致 WorkBuddy 访问不了远程 DSH —— 根因与修复（2026-10-25）

## 现象

DSH 桌面端每次重启后，WorkBuddy Web 访问不了该节点上的远程 DSH（任务派发失败、文件接口失败、节点探测不可达），直到有人在 ONENAT 后台手工把映射的本地端口改成 DSH 新端口。2026-10-18 排查过一次（当时 19387→51045），本次（19387→56552→56562，一天数漂）彻底修复。

## 根因（两层）

1. **端口漂移（主因）**：DSH 桌面端主 webserver 端口随每次启动动态分配（插件源码注释明说「桌面端 GUI 端口随启动变化，不能固定」）。ONENAT 映射（如公司笔记本 `0c93ebda`）指向的本地端口是 managed config，不会跟随——重启后映射指向死端口，公网入口 TCP 通但 HTTP 空回复/拒连。WorkBuddy 侧所有解析都是实时刷新（mappingId 不变、URL 每次派发强刷），**workbuddy-web 代码没有缓存问题**，坏在映射本身指向死端口。
2. **冷启动鉴权 fail-closed（次因，dsh-web-service 插件 bug）**：插件数据面鉴权在首个请求就执行，但密钥存储 `ensureReady()` 依赖首个 handler 触发；新启动窗口内 `initDone=false`，`verifyDataToken` fail-closed，**合法 Key 也被 401**。即使端口修对了，DSH 重启后的首批 WorkBuddy 探测仍会失败（实测复现：同一 Key 重启前 200、重启后 401，直到一次管理调用触发 init 才恢复）。

## 修复（落在 dsh-web-service 插件 v0.4.1，节点端可配置、通过 UI）

- **固定端口（UI 可配）**：设置页（`{prefix}/settings/api-keys`）新增「2. 服务端口」区块，可设置/清除固定端口；管理端点 `GET/PUT {prefix}/api-keys/port`（管理令牌鉴权、仅回环）。生效端口 = UI 设置 `fixedPort`（`<dshHome>/dsh-web-service/service-settings.json` 持久化）‖ 配置 `standalonePort` ‖ 0。保存先试绑定、成功才落盘（EADDRINUSE 明确报错），**即时生效免重启**；重启后自动恢复监听。`/system/status` 的 `standalonePort` 字段反映实际监听值。
- **冷启动鉴权修复**：插件 apply() 启动即 `keyStore.ensureReady()`，首批请求不再被 fail-closed 拒掉。

配套动作（公司笔记本节点）：fixedPort=19387；ONENAT 映射 `0c93ebda` local 改指 `127.0.0.1:19387`（一次到位，之后不再动）。

## 验证（2026-10-25 实测）

- 本机：重启 DSH 两次，主端口 50073→50483→51556 照旧漂移，**19387 始终监听**。
- 首枪鉴权：重启后**第一条**带映射凭证的请求即 200（修复前 401）。
- 公网：`natpass.yikaihui.com:31476` → `dsh-web-service v0.4.1, standalonePort 19387`。
- WorkBuddy：`POST /api/resources/probe` 5/5 节点 reachable；公司笔记本双引擎清晰区分（`公司笔记本-DSH:19387` 与 `公司笔记本-DSH:3081`(zcode)）。

## 追加修复（同日，用户实测发现）

- **v0.4.2 设置页整页空白（JS 语法错）**：0.4.1 在「服务端口」清除按钮的 `window.confirm` 提示串里把换行转义写错（模板字面量 `\n` 应为 `\\n`），发出的 HTML 内联脚本含真实换行 → 整段脚本语法错误，页面只剩页头（令牌门与所有区块都不渲染）。修复 + 新增验收：构建后用 `node --check` 对页面全部内联 `<script>` 逐段做语法检查（PAGE-CHECK），0.4.2 装机后对线上页面重复同检查，三段脚本全过、令牌门/服务端口区块正常渲染。
- **0.4.1 冷启动 401 复盘**：同版本号 tgz 重打包 pnpm 不会重装（首次修 ensureReady 后 grep 旧构建误判已修），靠版本号 bump 强制换包才生效——插件迭代必须递增版本。

## 其它节点

- KB136 / brain：映射指 3080（DSH 主 webserver 默认端口，服务器上端口空闲不漂），无需处理。
- 家笔记本 WIN（`453cf106→19387`）：探测 reachable（v0.3.7），暂无需处理；若日后漂移，装 v0.4.1 并同样设固定端口即可。
