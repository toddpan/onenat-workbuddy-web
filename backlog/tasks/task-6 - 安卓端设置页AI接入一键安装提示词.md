---
id: TASK-6
title: "安卓端设置页新增 AI 接入一键安装提示词（与 Web 端一致、可复制）"
status: Done
assignee:
created_date: '2026-11-01T00:40:00Z'
updated_date: '2026-11-01T09:05:00Z'
labels:
  - "android"
  - "ai-access"
  - "ui"
dependencies:
priority: "high"
ordinal: 6000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
需求（用户 2026-11-01）：安卓客户端「设置」页要补齐与 Web 端一致的「AI 接入（一键安装）」能力——展示 AI APIKEY、MCP 地址与**一键安装提示词**，并支持一键复制；复制出来的内容与 Web 端逐字一致，可粘给任意 AI 完成 MCP/技能双通道接入。

现状：
- Web 端已有完整实现（src/web-ui.ts「设置 → AI 接入」区块）：① AI APIKEY（GET /api/settings 的 aiToken，可 POST /api/settings/ai-token/reset 重置）② 接口地址（<base>/mcp、专家库 <base>/api/experts/mcp）③ 安装提示词（renderAiInstall() 客户端拼装：curl /install-skill.sh --base-url --token + mcpServers 条目 + 使用约定），带「复制安装提示词」「复制 MCP 地址」按钮。
- 安卓端只有「AI 工具通道令牌」的只读展示 + 重置令牌（app/src/main/java/com/thundersoft/workbuddy/AdminScreens.kt，SettingsScreen 内 ~L1750），没有安装提示词生成与复制。

推荐做法（避免两端文案漂移，本任务的关键设计约束）：
- 把提示词正文下沉为**服务端接口**（如 GET /api/ai/install-prompt，返回 {token, mcpUrl, expertMcpUrl, installPrompt}），Web 与安卓共用同一份文本；Web 侧 renderAiInstall 改为调用该接口渲染。仅当明确不做服务端接口时，才允许在 Kotlin 复制文案，且必须在文件注释标注「与 web-ui.ts renderAiInstall 同源，改一处必须同步另一处」。
- base 取值规则与 Web 相同：<用户配置的 WorkBuddy 服务地址含前缀>（安卓端当前只有 ONENAT 地址，WorkBuddy 基址需新增一项设置或用已知的服务基址 + /onenat-workbuddy）。注意 Web 端是 location.origin + PREFIX，安卓没有 origin，必须显式落一个「WorkBuddy 服务地址」配置项。
- 复制用 ClipboardManager + Toast 反馈，与现有「重置令牌」交互风格一致（material3 TextButton，≥48dp 热区）。

参考：网络层走现有 Api.settings()（已返回 aiToken）；文件锚点 AdminScreens.kt SettingsScreen（~L1613）与「AI 工具通道令牌」SectionTitle（~L1750）。
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 安卓设置页能显示 AI APIKEY（脱敏或按现有风格）与 MCP 地址（<base>/mcp）
- [x] #2 「复制安装提示词」按钮可复制完整提示词，内容与 Web 端逐字段一致（同一 base/token 下 curl 命令、mcpServers 条目、使用约定三段一致）
- [x] #3 base 取自明确的「WorkBuddy 服务地址」配置（含前缀 /onenat-workbuddy），不硬编码域名
- [x] #4 未生成 token 时给出「先生成 / 重置」引导，不复制空 token 的提示词
- [x] #5 与 Web 端共用同一份提示词来源（服务端接口优先）；若走 Kotlin 复制，必须双端注释互指
- [x] #6 设置页布局在窄屏（≤768px / 手机竖屏）不破版，复制后有 Toast 反馈
<!-- AC:END -->

### 2026-11-01T00:33:35Z 派发为任务
task-ac7b9ab9 · mode=orchestrate · 成员=2

### 2026-11-01 08:55 执行记录（已完成）
- 方案：提示词正文下沉服务端（未走 Kotlin 复制文案），Web/安卓共用同一份文本。
- Web（onenat-workbuddy-web，未提交）：
  - 新增 `src/ai-install.ts`（`normalizeInstallBase` / `buildAiInstallPrompt` / `buildAiInstallPayload`）、`src/ai-install.test.ts`；
  - `src/router.ts` 新增 `GET {prefix}/api/ai/install-prompt[?base=]`（控制台会话鉴权；AI 令牌 403；非法 base 400；base 归一化 origin+pathname 去尾 `/`；默认按 Host/x-forwarded-* 推导）；
  - `src/web-ui.ts` `renderAiInstall()` 改异步拉接口填充 ①APIKEY ②MCP 地址 ③安装提示词，删除旧客户端内联正文（全仓唯一文案在 `src/ai-install.ts`）；
  - 测试：`typecheck` ✅ / `test:unit` 105 ✅（99+6）/ `build` ✅ / `smoke` 76 ✅（70+6）/ `smoke:ai` 43 ✅（40+3）；正文与改造前基线逐字节 diff = 0（base=https://wb.example.com/onenat-workbuddy, token=wbk-test-token，1358 字符）。
- Android（onenat-workbuddy-android，未提交，增量 3 文件）：
  - `Api.kt` 新增 `aiInstallPrompt(base)`（`GET /api/ai/install-prompt?base=<Api.baseUrl>`，base 为空明确报错）；
  - `AdminScreens.kt` SettingsScreen 原「AI 工具通道令牌」节重做为「AI 接入（一键安装）」：WorkBuddy 服务地址（登录配置含前缀，不硬编码）、① APIKEY + 生成/重置（重置后自动重拉提示词）、② MCP 地址 + 复制、专家库 MCP/鉴权说明、③ 提示词 8 行折叠预览/展开限高内嵌滚动 +「复制安装提示词」；未生成 token 只 Toast 引导不复制；加载/404 升级提示/重试；按钮 min 48dp 热区；窄屏 Column/FlowRow 无横向溢出；
  - `README.md` 设置行更新；`./gradlew assembleDebug` BUILD SUCCESSFUL，APK `app/build/outputs/apk/debug/onenat-workbuddy-android-v2026.10.31.apk`。
- 模拟器端到端（emulator-5554，1080x2400 ≈393dp；服务 `http://10.0.2.2:3990/onenat-workbuddy`）：登录 → 设置页三段展示正常；未生成 token 点复制仅 Toast「请先「生成 / 重置」APIKEY…」；生成后令牌/提示词自动刷新（22 行）；展开+框内滚动不破版；复制提示词 Toast「✓ 安装提示词已复制，发给 AI 即可安装」；复制 MCP 地址 Toast 正确。证据 13 张：`qa-20261101/task6-0*.png`（关键：`task6-01/02` 折叠态、`task6-04b` 无令牌引导、`task6-05` 重置后、`task6-06/06b` 展开滚动、`task6-07d` 复制 Toast、`task6-08` MCP 复制 Toast）。
- 结论：AC#1–#6 全部满足（复制文本来自服务端 `installPrompt` 原文，非本地拼装；Web/安卓同源）。
- 遗留（非本任务）：① 既有单测 `store.test.js` 归档断言偶发 flake（1/4 复跑），与本改动无关；② `smoke:ai` 原「13 工具」断言在 HEAD 已失效，已顺手修为 15（tool-ops 实际 15 个）；③ 提示词正文固定写「14 个工具」为改造前既有文案（本次按逐字一致要求未改），建议后续统一为 15。

### 2026-11-01 09:05 继续执行：线上部署 + 在线验证（已完成）
- 触发：上一轮执行被线上服务重启中断（systemd 记录 08:46:11 Stopping → 08:46:17 Started），用户「继续」恢复；线上当时为半部署态（`dist/ai-install.js` 已上传，但 `router.js`/`web-ui.js` 仍旧版）。
- 部署：`scripts/deploy-standalone.sh root@natpass.yikaihui.com` 增量部署 2 个文件（`dist/router.js`、`dist/web-ui.js`），远端备份 `dist.bak-<ts>-*.js`，systemd 重启后 healthz/MCP 匿名 401 验证通过（版本 2026.11.1）。
- 在线验证（wb-qa 会话）：
  - `GET /api/ai/install-prompt?base=https://natpass.yikaihui.com/onenat-workbuddy` → 200，base/mcpUrl/expertMcpUrl/installScriptUrl 与线上域名一致，hasToken=true，version=1，prompt 1496 字符；
  - **线上 installPrompt 与本地 `dist/ai-install.js` 同参数构建结果逐字相等**（证明线上运行的就是本轮代码）；
  - 线上控制台 HTML：`ai/install-prompt` 引用 2 处、`async function renderAiInstall` 存在、旧内联提示词 0 处；
  - 回归：settings 200（aiToken 前缀 wbk-920b…）、monitor 200（19 智能体）、MCP 匿名 401；匿名新接口 401（fail-closed）；
  - 外部网络复验（家笔记本电脑 panzj@…:36007）：healthz v2026.11.1、匿名新接口 401、控制台 200、MCP 401 —— 公网可达且鉴权正常。
- 报告：`docs/qa-online-e2e-20261101.md`（含异常记录：08:43 半部署只上传 ai-install.js；08:46:11 服务重启中断任务）。
- Android 产物：debug APK `app/build/outputs/apk/debug/onenat-workbuddy-android-v2026.10.31.apk`（模拟器 e2e 通过）；release 签名包由同版本构建产出（见构建日志），待装机验证。
- 仍未提交：web 6 文件 + android 3 文件，按惯例待验收后 commit/push。
