# 在线 QA 报告 —— 群功能 Web 同步改造上线验证

> 日期：2026-11-11 ｜ 部署方式：`scripts/deploy-standalone.sh root@<aliyun-ecs>`（差异上传 + 逐文件备份 + systemd 重启 + healthz/MCP 内建验证，DEPLOY_EXIT=0）
> 环境：阿里云线上 https://natpass.yikaihui.com/onenat-workbuddy/ ｜ 版本 **v2026.11.1** ｜ 账号 wb-qa（admin，密码见 qa-online-e2e-20261031.md 轮换记录）
> 范围：群实体存储 / REST / MCP 工具 / UI 四屏的线上功能与安全验证；证据截图 /tmp/online-*.png（本机临时目录）

## 结论速览：16/16 通过，0 阻塞

| # | 验证项 | 结果 | 证据 |
|---|---|---|---|
| 1 | healthz + 重启生效 | ✅ | `{"ok":true,"version":"2026.11.1","uptimeSec":53}`（重启后 53 秒内探到） |
| 2 | 未鉴权 /api/groups | ✅ | 401 AUTH_REQUIRED fail-closed（路由存在而非 404） |
| 3 | wb-qa 登录 + 控制台含群屏 | ✅ | 登录 ok；页面群代码 43 处命中 |
| 4 | 分组新增 | ✅ | POST /api/group-sections → `added:true` |
| 5 | 建群（全字段回显） | ✅ | POST /api/groups → createdBy 服务端填充 wb-qa、默认值齐全 |
| 6 | 列表 / PUT 更新 | ✅ | 改名 + archived:true + lastReadSeq:42 全部落库 |
| 7 | 轮次去重幂等 | ✅ | 同 taskId 追加两次 → 列表仅 1 条 |
| 8 | markRead 单调钳制（AND-2 生产验证） | ✅ | 已到 42 后发 3 → 保持 42 |
| 9 | 不存在群 id 子资源 | ✅ | 404 NOT_FOUND（契约 §2） |
| 10 | 工具清单 | ✅ | /api/tools **18 个工具**含 workbuddy_group_manage |
| 11 | 工具通道正向调用 | ✅ | 会话身份 POST workbuddy_group_manage {action:list} → 返回群数据 |
| 12 | 浏览器：群导航页签 | ✅ | 👥 群 tab → 「👥 协作群」屏全要素（截图 /tmp/online-groups-list.png） |
| 13 | 浏览器：归档过滤 | ✅ | 显示已归档勾选 → 分组「在线验证-20261111 · 1 群」+ 📦已归档/空闲/管理员主持/提醒档徽标 |
| 14 | 浏览器：建群向导 3 步 | ✅ | 第1步成员多选（≥2 门槛提示在位）→ 第2步 gw-mode=admin 默认 + 无管理员 → 第3步创建 |
| 15 | 浏览器：创建 → 群聊天屏 | ✅ | toast「✓ 群已创建」；空群名成员拼接、"2 位成员 · 管理员 无 · 频道空闲"、composer「发送即开启新一轮」（截图 /tmp/online-group-created.png） |
| 16 | 测试数据清理 | ✅ | 向导群 + API 群 + 分组全删，终态列表 0 群 |

## 安全语义线上佐证

- 该部署未启用 `--token`，工具通道走会话鉴权；群工具经会话身份调用成功（§3 裁定：群数据=登录用户私有）。
- AI 令牌（WORKBUDDY_TOKEN）在启用 --token 的部署上调用群工具将得到 AI_TOKEN_DENIED——由单测与 smoke:mcp 覆盖（165/165），生产未启 token 通道故无线上样本。

## 备注

- 服务器侧变更文件均有 `dist.bak-<ts>-<file>` 备份；skills/ 漂移同步一次（groups.md 等 4 文件上线）。
- 向导群 API name=""（空）+ 渲染期成员名拼接——与契约「name 空 = 成员名拼接」一致，非缺陷。
- 已知非缺陷观察：群列表默认隐藏归档群（勾「显示已归档」可见），与 §4.10 生命周期语义一致。
