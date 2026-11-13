# 修复：pjy-DSH「从远程 DSH 导入项目」报 ByteString 天书错误（2026-11-06）

## 现象

阿里云线上（https://natpass.yikaihui.com/onenat-workbuddy/）新增 pjy-DSH 节点后，
「项目 → 从远程 DSH 导入 → 获取工作区列表」弹窗报错：

> Cannot convert argument to a ByteString because the character at index 7 has a value of 22235 which is greater than 255.

## 根因

- ONENAT 映射 `949c4354`（pjy-DSH）在后台的 **API Key 被误粘贴成一段 368 字符的中文文本**（开头「四、TaskPerf 首动分段耗时…」，resolved_from=mapping）。
- WorkBuddy `DshClient.headers()` 构造 `Authorization: Bearer <key>`；`"Bearer "` 占 index 0-6，
  **index 7 = key 首字「四」（U+56DB = 十进制 22235 > 255）**，undici fetch 构造 Headers 时直接抛上述错误。
- 影响面：该节点的工作区列表（/api/dsh-workspaces）、模型列表（/api/dsh-models）、任务派发等一切要带鉴权头的调用。
- pjy 节点实测**不校验鉴权**（无 Authorization / 乱 key 均 200），这段中文凭证纯属脏数据。

## 修复

### 1. 数据修复（线上 ONENAT）

- 先备份 `/opt/onenat/onenat-dashboard.json` → `...bak-fixpjy-20261106`；
- admin 登录 dashboard，`PATCH /api/mappings/949c4354`（带全量字段）+ `auth: {auth_type:"none"}` 清除映射级凭证覆盖；
- 修复后凭证回落应用默认（resolved_from=app，48 位 hex ASCII key），pjy 节点 200 正常。

### 2. 代码修复（防再发：坏凭证 → 可操作文案，不再是天书）

- 新增 `src/header-safe.ts`：`firstUnsafeHeaderChar()` + `unsafeApiKeyError()`（定位到第几个字符/U+码点/预览 12 字 + ONENAT 后台修正指引）；
- `src/onenat.ts` `doFetchMappingCredentials`：凭证含非可打印 ASCII → `ok:false` + 友好文案；只进 15s 负缓存，**绝不写 credLastGood**；
- `src/remote-client.ts` `headers()/headersAuth()`：兜底 fail-fast（覆盖子智能体自带 apiKey 等其它来源）；
- 新增 `src/header-safe.test.ts` 7 个回归用例（含事故字符串 index 7/U+56DB/22235 精确断言）；`package.json` test:unit 纳入。

## 验证

| 项 | 结果 |
| --- | --- |
| 单元测试 | `npm run test:unit` 195/195 ✅（typecheck ✅） |
| 部署 | `scripts/deploy-standalone.sh root@natpass.yikaihui.com`，变更 3 文件（header-safe.js / onenat.js / remote-client.js），healthz ✅ v2026.11.1 |
| API 回归 | `GET /api/dsh-workspaces?node=949c4354` → `ok:true` + 4 个工作区（原报错接口）；`/api/dsh-models` ✅ |
| 浏览器 E2E | ego-browser 走真实 UI：项目页 → 导入弹窗 → 选 pjy-DSH → 获取工作区列表 → 列出 dsh-onenat / dsh-webapi / onenat / default-workspace，无报错（qa-import-pjy-20261106/after-fix-modal.png） |
