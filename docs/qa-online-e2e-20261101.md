# 在线部署与 QA 报告 —— AI 接入安装提示词服务端化（TASK-6）

- 日期：2026-11-01 08:55–09:05
- 环境：阿里云线上 https://natpass.yikaihui.com/onenat-workbuddy/（宿主 natpass.yikaihui.com:22，systemd 单元 `onenat-workbuddy`，Node v20.19.2）
- 方式：`scripts/deploy-standalone.sh` 增量部署（差异上传 + 远端备份 + `node --check` + restart + healthz/MCP fail-closed 验证）；另用**家笔记本电脑（panzj@…:36007）作为外部网络客户端**复验公网入口
- 账号：wb-qa（admin，沿用 2026-10-31 QA 账号）
- 代码状态：TASK-6 改动**均在工作树未提交**（基线 1bf6290），本次仅部署构建产物 `dist/`

## 部署内容

| 项 | 值 |
|---|---|
| 变更 dist 文件 | `dist/router.js`、`dist/web-ui.js`（`dist/ai-install.js` 已在线上，见下方异常） |
| 远端备份/回滚点 | `/opt/onenat-workbuddy/dist/dist.bak-<ts>-router.js` / `-web-ui.js` |
| 服务重启 | systemd `onenat-workbuddy` 重启，healthz uptime 归零，版本 `2026.11.1` |
| 部署后校验 | healthz ok / MCP 匿名 401 / monitor 页 ok（脚本 5/5 步全部通过） |

## 线上验证矩阵（全部通过）

| 项 | 结果 | 证据 |
|---|---|---|
| 新接口在线可用 | ✅ 200 | `GET /api/ai/install-prompt?base=https://natpass.yikaihui.com/onenat-workbuddy` 返回 `{base,mcpUrl,expertMcpUrl,installScriptUrl,hasToken:true,version:1,installPrompt}`，prompt 1496 字符 |
| 提示词与本地构建逐字一致 | ✅ | 线上 `installPrompt` 与本地 `dist/ai-install.js#buildAiInstallPrompt(线上 base, 线上 token)` **完全相等**（同参数下 ==，长度一致） |
| 控制台已改用服务端来源 | ✅ | 线上控制台 HTML 含 `ai/install-prompt` 引用 2 处、`async function renderAiInstall`，旧内联提示词文案 **0 处** |
| 未登录/令牌面 fail-closed | ✅ | 匿名 `/api/ai/install-prompt` → 401；MCP 匿名 `tools/list` → 401 |
| 既有功能回归 | ✅ | `/api/settings` 200（aiToken 前缀 wbk-920b…）、`/api/monitor/overview` 200（19 个智能体）、控制台 200 |
| 外部网络可达（家笔记本电脑） | ✅ | 家笔电 curl：healthz ok（v2026.11.1）、`/api/ai/install-prompt` 匿名 401、控制台登录页 200、MCP 匿名 401 |

## 本次发现的异常（如实记录）

1. **08:43 一次不完整部署**：线上 `/opt/onenat-workbuddy/dist/ai-install.js` 存在（mtime 08:43:02，与本地构建同 hash），但 `router.js`/`web-ui.js` 仍是旧版（无 `/api/ai/install-prompt` 路由、无 async renderAiInstall）→ 线上处于「新模块已上传、调用方未更新」的半部署态。推测为一次使用**过期 dist** 的增量部署（差异计算只命中了新增文件 ai-install.js）。
2. **08:46:11 服务重启**：systemd 记录 `Stopping onenat-workbuddy` → 08:46:17 `Started`，导致当时正在执行的 WorkBuddy 任务被标记中断（任务 `task-ac7b9ab9` 第 3 轮系统消息「服务重启导致本轮执行中断」）。本次部署已把半部署态补齐为完整一致态。

## 遗留

1. 源码改动（web 6 个文件 + android 3 个文件）均**未提交**，按惯例待验收后 commit/push。
2. Android 客户端需重新打包安装到手机后才会出现「AI 接入（一键安装）」区块（debug APK 已构建并通过模拟器 e2e；release 签名包见构建输出）。
3. 本地 `store.test.js` 归档断言存在既有间歇 flake，与本改动无关。
