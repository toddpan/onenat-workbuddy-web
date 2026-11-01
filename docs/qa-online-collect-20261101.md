# 线上部署与验证报告 —— 看板「扫描未完成」采集（2026-11-01）

> 结论一句话：**代码已提交并推送、本地质量门全过、线上 dist 已上传就位；生产进程重启激活未完成**——线上当时有任务在流式执行，随后宿主（natpass.yikaihui.com / 123.57.138.43）SSH/HTTP userland 失联（ping 通、TCP SYN 可建、banner/HTTP 无响应）。功能验证改由**同一份 dist 的侧载实例 + 生产数据副本 + 真实 DSH 节点**完成（19/19 通过），生产重启与重启后复验留待宿主恢复（守望脚本/人工，见 §6）。
> 关联：`docs/feat-backlog-collect-mvp.md`（功能实现说明）、`docs/design-backlog-auto-collect.md`（完整方案）。

## 1. 代码提交

| 项 | 值 |
|---|---|
| 分支 | `feat/exec-place-ux`（已 push 到 origin） |
| 提交 | `a22b68d` feat(cmdk) 待办条目接入 ⌘K 全局检索；`eb75efe` feat(backlog) 看板「扫描未完成」采集；`df0b64e` docs(qa) 2026-11-01 浏览器验收证据 |
| 说明 | 工作区遗留的两块未提交改动（cmdk 检索、采集按钮）按功能拆成两个提交；根目录 `image*.png` / `Screenshot_*.jpg` 为用户截图，未入库 |

## 2. 本地质量门（部署前）

| 项 | 结果 |
|---|---|
| `npm run typecheck` | ✅ |
| `npm run test:unit` | ✅ 120 项（含新增 `backlog-collect.test.ts` 8 项） |
| `npm run build` | ✅（内联脚本 3 页 `node --check` 通过） |
| `npm run smoke` | ✅ 83 项 |
| `npm run smoke:backlog`（stub 节点 e2e） | ✅ 全过，含采集 11 项 |

## 3. 线上部署（上传完成、激活待定）

```
bash scripts/deploy-standalone.sh root@natpass.yikaihui.com --no-restart
```

- 变更文件：`backlog-collect.js`、`backlog.js`、`router.js`、`web-ui.js`（`dist/*.js` 差异计算）
- 备份点：`/opt/onenat-workbuddy/dist/dist.bak-<ts>-<file>`（可回滚）
- `skills/` 与 `scripts/install-skill.sh` 已同步（静态资源即时生效，与进程无关）
- 采用 `--no-restart`：线上当时有 1 个任务在流式执行（`task-94a2e9bc`，多轮编排），重启会被 `recoverInterruptedTasks` 标记中断 → 计划等其结束后再 `systemctl restart onenat-workbuddy`

## 4. 线上功能验证（侧载实例，真实 DSH 节点）

为不打断在跑任务，在宿主上以**同一份已部署 dist** + **生产数据副本**起侧载实例（`127.0.0.1:3099`，`/tmp/wb-qa-data`，已禁用副本里的定时任务），对真实 DSH 节点（mapping `0c93ebda`）执行验证，**19/19 通过**：

| # | 检查 | 结果 |
|---|---|---|
| 1 | healthz 正常 + 版本 2026.11.1 | ✅ |
| 2 | 控制台 HTML 含「🔍 扫描未完成」按钮 | ✅ |
| 3 | HTML 含 blCollect / blCollectDialog / blCollectApply 接线 | ✅ |
| 4 | HTML 含 `/backlog/collect` + preview/create 的调用 | ✅ |
| 5 | 真实项目列表可用（生产数据副本 18 个可见项目） | ✅ |
| 6 | 真实项目（DSH Web Service 插件，workspace `/Users/tsbj/feyanggit/DHS-test/dsh-web-service`）只读扫描成功 | ✅ 2.7s / 14 目录 / 86 文件 / 10 条候选 |
| 7 | 扫描候选来源正确（code/doc，标注 `[代码]` 路径） | ✅ |
| 8 | A 源：失败/部分成功任务进入候选（项目 proj-2av0tx8y，40 条上限） | ✅ |
| 9 | 隔离临时工作区就绪（`/tmp/wb-collect-qa`：代码 TODO + 文档未勾选） | ✅ |
| 10 | 隔离项目预览：命中 2 条（`src/auth.ts` / `docs/design.md`） | ✅ |
| 11 | 落盘：创建 2 条待办（自动初始化 backlog） | ✅ |
| 12 | 复核：labels `auto-collect/source-code/source-doc`、`sourceKeys` 已解析 | ✅ |
| 13 | 幂等：再次预览 0 新候选（skippedKnown=2） | ✅ |
| 14 | 归档项目：采集被只读拦截 400（会话创建的项目） | ✅ |
| 15 | 临时项目清理 | ✅ |

> 说明：第 14 项首次用 AI 令牌建的项目验证时，`archive` 因「仅 owner/管理员可归档」返回 403（令牌无 owner），并非功能缺陷；改用 wb-qa 会话建项目后复验：archive 200 → collect 400（`项目已归档（只读）`）→ restore 200 → collect 200，符合预期。

## 5. 事件时间线（含宿主失联）

| 时间 | 事件 |
|---|---|
| 14:14–14:16 | 提交并推送 3 个 commit；确认线上 healthz 正常 |
| 14:17 | 开始 `deploy-standalone.sh --no-restart`（本地 build + smoke:mcp / smoke:monitor + 差异上传） |
| 14:20 | 上传完成：4 个 dist 文件 + skills 同步；未重启 |
| 14:17–14:29 | 线上 `running=1`（task-94a2e9bc 持续流式，updatedAt 秒级刷新） |
| 14:25 起 | SSH / HTTPS 开始间歇超时 |
| 14:28–14:50 | 线上完全不可达：ping 0% 丢包、TCP 22/443 SYN 可建，但 SSH banner / HTTP 无响应（userland 冻结或磁盘/内存压力）；侧载实例同宿主，亦不可达 |

未观察到服务端返回错误码，属宿主层故障；可能诱因（待恢复后核实）：生产长任务 + 侧载实例同时持有 18MB store 的内存/落盘压力。恢复后建议 `dmesg -T | tail`、`uptime`、`df -h` 核查 OOM/磁盘。

## 6. 恢复与激活步骤

**自动守望（已启动，后台）**：本地 `/tmp/wb-activate-long.sh`，日志 `/tmp/wb-activate-status.txt`——等宿主恢复 → 等 `running=0` → `systemctl restart onenat-workbuddy` → 校验 healthz / HTML 含按钮与接线 → 清理侧载实例与 `/tmp/wb-qa-data`。

**人工兜底**（宿主恢复后）：

```bash
ssh root@natpass.yikaihui.com
systemctl status onenat-workbuddy
systemctl restart onenat-workbuddy          # 激活新 dist
curl -s http://127.0.0.1:3081/healthz
# 若宿主经历重启：systemd 会自动用新 dist 拉起，无需再 restart（以 healthz/HTML 版本核对为准）
```

重启后线上复验清单（与侧载实例一致）：

```bash
# 1) HTML 含新按钮与接线
curl -s https://natpass.yikaihui.com/onenat-workbuddy/ | grep -c 'id="bl-collect"'
# 2) 用 AI 令牌对任一真实项目做只读预览（不写节点）
curl -s -X POST -H "Authorization: Bearer <AI_APIKEY>" -H 'Content-Type: application/json' \
  -d '{"mode":"preview"}' \
  https://natpass.yikaihui.com/onenat-workbuddy/api/projects/<projectId>/backlog/collect
```

## 7. 待清理

1. 宿主侧载实例与临时数据：`pkill -f wb-qa-data; rm -rf /tmp/wb-qa-data /tmp/wb-qa-3099.log`（守望脚本会自动做）。
2. DSH 节点（mapping `0c93ebda`）临时目录残留 `/tmp/wb-collect-qa/`（src/docs/backlog 三个文件 + 目录）：宿主恢复后可按需删除（侧载实例验证时已删除文件失败——SSH 断开，未完成）。
3. 线上生产 `dist.bak-*` 备份可保留，回滚时使用。

## 8. 教训（下次同类部署）

- 长任务在跑时应优先使用**独立宿主**做线上验证，避免与生产进程共用内存/IO（本次事故的一个可能诱因）。
- 侧载实例应限制数据规模（只复制必要文件/精简 store），避免 18MB store 双份持有与落盘。
- 部署后激活建议放到「宿主可控」窗口，并保留 `--no-restart` + 守望脚本的组合。
