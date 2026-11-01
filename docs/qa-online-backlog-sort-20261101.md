# 收口上线报告 —— backlog 排序 + 安全基线（SSRF/文件权限/AI 令牌门禁）

- 日期：2026-11-01 20:45–21:05
- 分支：`feat/exec-place-ux`，回滚点 tag：`deploy/backlog-sort-20261101`（= 846e438）
- 环境：阿里云线上 `https://natpass.yikaihui.com/onenat-workbuddy/`，systemd `onenat-workbuddy`

## 1. 提交清单（已推送）

| commit | 标题 |
|---|---|
| dd59ed7 | feat(backlog): 待办列表排序 orderBy/order（TASK-SORT-2）+ overview 项目分组排序（task-52） |
| 63686f5 | feat(security): 直连节点 SSRF 防护（task-53 V5） |
| 9c953e0 | feat(security): 敏感数据文件权限基线 0600/0700（task-54 V2） |
| 846e438 | feat(security): AI 令牌低信任通道禁止 SSH 凭据读取与远程 exec（task-51 V7 安全基线） |
| a4ab84f | test(e2e): 测试自检服务器显式 WORKBUDDY_ALLOW_PRIVATE_DIRECT=1 适配 task-53 SSRF 防护 |

未提交遗留：工作区根目录 `image.png / image-1/2/3.png` 为 QA 截图散件（docs/review-baseline.md 已记录），未入库。

## 2. 部署

- `scripts/deploy-standalone.sh root@natpass.yikaihui.com`：构建+冒烟（smoke:mcp、smoke:monitor）→ md5 差异上传 15 个 dist 文件（逐一远端备份 `dist.bak-20261101-204956-*`）→ `node --check` → 重启 → healthz/MCP 匿名 401 验证通过。
- 本地与远端 `dist/web-ui.js` md5 一致（96cb0ad4…），无半部署态。
- 部署前记录回滚点：git tag `deploy/backlog-sort-20261101` + 远端 dist.bak。
- 重启自愈把 1 个存量 status=running 的陈旧任务标记 failed（该任务更新时间在部署前十余小时，无活跃工作丢失）。

## 3. 逐项验证结论

| 项 | 结论 |
|---|---|
| a. `GET /api/projects/:id/backlog?orderBy=priority&order=asc` | ✅ 线上 proj-2av0tx8y：high→medium… 优先级升序生效；`createdAt desc` 默认最新在前；非法参数安全回退默认 |
| b. `/api/backlog/overview` 项目分组排序 | ✅ 线上 22 项目：活动项目置顶（OneNat WorkBuddy 最前）；线上当前无 open 待办/归档项目，分组语义由单测覆盖（backlog-service.test.ts，本地 134 单测全过、构建 md5 与线上一致） |
| c. 前端排序控件 | ✅ 线上 web-ui.js 含 `BL_SORT_FIELDS`/`bl-sort-sel` 控件（5 维 orderBy + asc/desc，localStorage 持久化），与本地构建逐字节一致；线上管理员口令已非默认，未做浏览器级登录复核 |
| d. smoke 关键页面 | ✅ healthz ok、控制台页面 200、MCP 匿名 401（fail-closed）；本地 smoke 83 项全过 |
| e. e2e 55 项失败 / SSRF 拒 127.0.0.1 | ✅ 已定位并修复：失败根因是 e2e 自检服务器直连 127.0.0.1 mock 节点被 task-53 SSRF 防护默认拒绝。修复方式为测试脚本为**自检服务器**注入 `WORKBUDDY_ALLOW_PRIVATE_DIRECT=1`（生产策略未放宽，云元数据段仍一律拒绝）。修复后 backlog-e2e 全过、console-e2e 全过、smoke-standalone 83 项全过（a4ab84f） |

## 4. 遗留问题

1. 线上管理员口令非默认值，本次未做浏览器级前端交互复核（控件随 dist 逐字节一致 + 本地 e2e 通过，风险低）。
2. e2e 产物截图散件（image*.png）未入库，如需归档请移入 docs/ 或删除。
3. 重启自愈标记 failed 的陈旧任务（如 task-987d518d 等）如需重跑请人工重新发起。
