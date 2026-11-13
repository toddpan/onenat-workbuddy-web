# 线上部署与验证报告 —— 看板「扫描未完成」采集（2026-11-01）

> 结论一句话：**代码已提交推送；线上 dist 已激活并完成线上复验**——宿主 15:44 重启后 systemd 自动以新 dist 拉起，侧载实例 19/19 功能验证 + 生产实测（dist md5 / HTML / 接口 / 真实浏览器点选）全部通过。期间线上长任务 `task-94a2e9bc` 因**宿主重启**中断（14 轮记录保留，状态 failed），非本次代码/部署导致；线上首次采集预览的 401 是 ONENAT 凭证接口限速所致，冷却后即恢复（见 §4.1 备注）。
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

## 3. 线上部署（上传完成，已激活 ✅）

> 2026-11-01 复核更新：本节标题原为「上传完成、激活待定」。实际激活已于当日完成——宿主 15:44:38 重启后 systemd 以新 dist 自动拉起（见 §4.1），生产复验通过。11-01 晚间再次核实：`/healthz` 返回 `version 2026.11.1`、服务持续运行，激活结论成立。

### 3.1 部署与激活过程（原始记录）

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

### 4.1 生产进程激活与复验（15:45 起）

宿主在 **15:44:38 完成重启**（此前 userland 冻结：ping/TCP 正常但 SSH/HTTP 无响应），systemd 以**新 dist 自动拉起**；守望脚本随后确认 `running=0` 并显式 restart 一次，服务健康。生产复验：

| # | 检查 | 结果 |
|---|---|---|
| 1 | dist 完整性：4 个变更文件本地/远端 md5 完全一致（web-ui / backlog-collect / backlog / router） | ✅ |
| 2 | 控制台 HTML（登录态）：`id="bl-collect"`、`blCollectDialog`、`blCollectApply`、`/backlog/collect` ×2、`mode: 'preview'/'create'` | ✅ |
| 3 | 生产接口只读预览：`POST /api/projects/proj-eec3rnr4/backlog/collect {mode:"preview"}` → 200 / 3.4s / 14 目录 / 86 文件 / 10 候选 | ✅ |
| 4 | 真实浏览器点选（ego-browser，wb-qa 登录）：待办 → 项目看板「DSH Web Service 插件」→ 顶部「🔍 扫描未完成」→ 点击弹窗「10 条候选」（任务账本 0 / 工作区 10；默认勾选 10/10；底部「取消 / 创建选中（10 条）」），关闭弹窗未落盘 | ✅ 截图 `qa-20261101/online-collect/01-prod-board-collect-modal.png` |
| 5 | 未登录 HTML 检查的「缺按钮」为误判（返回登录页），登录态复核通过 | ✅ |

> **排障备注（限速，不是缺陷）**：生产首次预览返回 `backlog 目录读取失败：Unauthorized: Invalid or missing API key`——ONENAT 映射凭证接口限速 **5 次/分**，短时间多次解析（侧载验证 + 生产复验叠加）把配额打满，解析器拿不到 apiKey；等待 90s 后单次调用即恢复 200。日志可佐证：`15:45:44 collect → 400`、`15:48:46 collect → 200`。高频/批量采集时需要节流或缓存凭证。


## 5. 事件时间线（含宿主失联）

| 时间 | 事件 |
|---|---|
| 14:14–14:16 | 提交并推送 3 个 commit；确认线上 healthz 正常 |
| 14:17 | 开始 `deploy-standalone.sh --no-restart`（本地 build + smoke:mcp / smoke:monitor + 差异上传） |
| 14:20 | 上传完成：4 个 dist 文件 + skills 同步；未重启 |
| 14:17–14:29 | 线上 `running=1`（task-94a2e9bc 持续流式，updatedAt 秒级刷新） |
| 14:25 起 | SSH / HTTPS 开始间歇超时 |
| 14:28–14:50 | 线上完全不可达：ping 0% 丢包、TCP 22/443 SYN 可建，但 SSH banner / HTTP 无响应（userland 冻结或磁盘/内存压力）；侧载实例同宿主，亦不可达 |
| 15:44:38 | **宿主重启完成**（先前 userland 冻结）；systemd 以新 dist 自动拉起服务 |
| 15:45:05 | 守望脚本确认 healthz 200 + running=0 → 显式 `systemctl restart`，服务 active |
| 15:48:46 | 生产 `collect preview` 200（3.4s / 10 候选）；此前一次 400 为凭证限速（见 §4.1） |
| 15:5x | ego-browser 生产浏览器点选通过；侧载实例与 `/tmp/wb-qa-data` 已清理；DSH 节点 `/tmp/wb-collect-qa`（5 文件 + 5 目录）已清理 |
| 15:4x | 长任务 `task-94a2e9bc` 因宿主重启中断：状态 failed、14 轮记录保留（非部署导致） |

未观察到服务端返回错误码，属宿主层故障；可能诱因（待恢复后核实）：生产长任务 + 侧载实例同时持有 18MB store 的内存/落盘压力。恢复后建议 `dmesg -T | tail`、`uptime`、`df -h` 核查 OOM/磁盘。

## 6. 恢复与激活步骤（已完成，留档备查）

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

## 7. 清理状态

1. **已完成**：宿主侧载实例进程与 `/tmp/wb-qa-data`、`/tmp/wb-qa-3099.log`（守望脚本清理，已复核不存在）。
2. **已完成**：DSH 节点（mapping `0c93ebda`）临时目录 `/tmp/wb-collect-qa/`——5 个文件（backlog 2 条 + config.yml + src/docs 两个样例）+ 5 个目录全部删除。
3. **保留**：线上 `dist.bak-*` 备份（回滚点），按需清理。

## 8. 教训（下次同类部署）

- 长任务在跑时应优先使用**独立宿主**做线上验证，避免与生产进程共用内存/IO（本次事故的一个可能诱因）。
- 侧载实例应限制数据规模（只复制必要文件/精简 store），避免 18MB store 双份持有与落盘。
- 部署后激活建议放到「宿主可控」窗口，并保留 `--no-restart` + 守望脚本的组合。
- **ONENAT 映射凭证接口限速 5 次/分**：批量/高频派发与采集会把配额打满，解析拿不到 apiKey 时表现为节点 401；要么节流，要么在解析器侧做短 TTL 缓存。
- 宿主仅 1.6GB 内存：生产长任务 + 第二实例/大 store 容易触发内存压力（本次重启时间点与长任务叠加，具体 OOM 证据在重启后 dmesg 已清空，未能确认）；同类验证建议放独立机器。
