# 在线部署与 QA 报告 —— backlog MCP 工具上线（TASK-9）

- 日期：2026-11-01 11:39–11:56
- 环境：阿里云线上 `https://natpass.yikaihui.com/onenat-workbuddy/`（宿主 `natpass.yikaihui.com:22`，systemd 单元 `onenat-workbuddy`，Node v20.19.2，`WORKBUDDY_HOME=/var/lib/onenat-workbuddy`）
- 方式：`scripts/deploy-standalone.sh --no-restart` 上传 → **延迟激活**（等 running 任务归零后 `systemctl restart`）→ 自动自检
- 代码状态：`2d1708a`（backlog MCP 工具）+ `9c71731`（部署脚本修复）已推送 `feat/exec-place-ux`
- 账号/令牌：沿用线上 AI APIKEY（`wbk-92…`）；未在任何文档中落明文

## 1. 为什么用「延迟激活」而不是直接重启

本轮部署任务本身就跑在被部署的这个实例上（`task-03d6b7bd`）。`engine.recoverInterruptedTasks()`
只处理 `status === 'running'` 的任务，因此只要等**本轮结束后**再重启，就不会把自己标记为中断。

激活脚本（`/tmp/activate.sh`，detached）逻辑：

1. 延迟 60s（让当前回合正常收尾）+ 可取消开关 `/tmp/wb-activate-cancel`；
2. 轮询 `/api/tasks`，**等 running 任务数归零**（最多约 10 分钟；期间可持续取消）；
3. `systemctl restart onenat-workbuddy` → 等待 healthz；
4. 跑只读自检 → 结果写 `/var/log/onenat-workbuddy/post-deploy-verify.json`。

实际执行：`11:50:48 重启（running=0）` → `11:50:55 服务已起` → `11:50:59 自检完成 ok=true 15/15`。
**未打断任何在跑任务**。

## 2. 部署内容

| 项 | 值 |
|---|---|
| 变更 dist 文件 | `ai-install.js`、`backlog-service.js`、`backlog-tool.js`、`backlog.js`、`router.js`、`tool-ops.js`、`web-ui.js`（7 个） |
| 技能与安装资源 | `skills/`（2 套 SKILL + 新子技能 `backlog.md`）、`scripts/install-skill.sh` 全量同步 |
| 远端备份点 | `/opt/onenat-workbuddy/dist/dist.bak-<ts>-<file>` |
| 静态资源生效 | 无需重启：服务从工作目录读取，上传即生效（本次实测 `/install/*` 已即时返回新版） |

## 3. 部署后自检（线上生产，15/15 全过）

`/var/log/onenat-workbuddy/post-deploy-verify.json`：

| 检查 | 结果 |
|---|---|
| healthz ok + 版本 | ✅ `v=2026.11.1` |
| HTTP 工具通道 16 个且含 `workbuddy_backlog_manage` | ✅ count=16 |
| 工具通道匿名 → 401（fail-closed） | ✅ |
| MCP 匿名 → 401（fail-closed） | ✅ |
| MCP `tools/list` 16 个 | ✅ |
| MCP `tools/call` backlog(projects) 可用 | ✅ projects=22 |
| backlog `projects` 真实聚合 | ✅ total=22 |
| backlog `overview` 跨项目 + 失败隔离 | ✅ `{"projects":22,"unreachable":6,"open":4}` |
| backlog `config` 状态配置 | ✅ `To Do/In Progress/Done` |
| backlog `list` 真实待办 | ✅ total=8 |
| backlog `view` 完整 raw + AC 段标记 | ✅ |
| workbuddy-mcp SKILL 含 Backlog 节 + 16 工具 | ✅ |
| onenat-workbuddy SKILL 16 工具 | ✅ |
| 子技能清单含 `backlog.md` | ✅ |
| `wb.mjs` 含 backlog 命令 | ✅ |

## 4. 激活风险旁路验证（21/21，独立于生产进程）

为了在**不动生产进程**的前提下验证新代码，用生产数据副本 + 真实 DSH 节点在 3099 起旁路实例：

| 组 | 用例 | 结果 |
|---|---|---|
| 通道 | HTTP 16 工具 / MCP `tools/list` 16 / MCP `tools/call` 可用 | ✅ |
| 只读 | projects（22）/ overview（失败隔离）/ config / list / search / view | ✅ |
| 写路径 | `init` → `create`×2（含依赖）→ `edit`（status/labels/`acceptAdd`/`note`）→ `view` 复核（AC 3 项、note、标签） | ✅ |
| 守卫 | 非法 status → `INVALID_STATUS`+可选值；`dispatch` 依赖阻止 → `DEPS_BLOCKED` 且**未建任务** | ✅ |
| 删除 | 无 `force` → `CONFIRM_REQUIRED`；`force:"true"` → 删除；再 view → `NOT_FOUND` | ✅ |
| 容错 | 非法 JSON `filter` → 明确报错；`unassigned`+`assignee` 冲突 → 报错 | ✅ |

旁路实例与临时项目、临时工作区已全部清理；生产进程全程未受影响。

## 5. 本次发现的问题

1. **部署脚本不同步 `skills/`（已修，`9c71731`）**：服务端从工作目录读 `skills/` 与
   `scripts/install-skill.sh`（`/install/skill.sh`、`/install/mcp/SKILL.md`、`/install/wb.mjs`、
   `/install/skills.json`），而脚本只同步 `dist/*.js`、`dist/mcp/`、`assets/experts/`
   → 线上 SKILL 长期停在 10-08/10-15 旧版，本轮 SKILL 更新原本无法生效。
   顺带修：早退判断未含 skills 漂移、bsdtar `--exclude` 位置、CJK 相邻变量名展开、
   `set -e` 下 `[ cond ] && VAR=1` 的退出隐患。
2. **KnewLab 项目节点凭据失效（未修，已登记 backlog `task-10`）**：`proj-75wwwck5` 的 DSH 节点
   返回 `Unauthorized: Invalid or missing API key`；`overview` 的失败隔离正确生效（其它项目不受影响）。
3. **（未验证，仅提示）** 服务器 `127.0.0.1:3082` 被无关的 `zcode-web-service` 占用，
   旁路验证改用 3099；后续做临时实例验证时避开 3082。

## 6. 待办登记（本次用线上新工具完成，dogfooding）

| itemId | 状态 | 标题 |
|---|---|---|
| `task-9` | Done | backlog 待办管理接入 MCP/工具通道（第 16 个工具）并线上验证 |
| `task-10` | To Do | 修复 KnewLab 项目（proj-75wwwck5）DSH 节点 API Key 失效 |

登记过程本身即线上工具的真实写入验证：`create` 两条 → `list` 返回 10 条（TASK-1~8 + task-9/10）。

## 7. 遗留（已知差异，未改动）

1. **新建条目的 frontmatter id 大小写与上游规范不一致**：`createItem` 写 `id: task-9`（小写），
   而仓库既有条目与 Backlog.md v1.55.3 实测样本是 `id: TASK-9`（大写，文件名前缀小写）。
   读取侧全程大小写归一（`normalizeItemId`），功能不受影响；仅看板/详情展示的 ID 大小写不统一。
   若要统一，需改 `createItem` 并同步 e2e 断言（当前 e2e 按小写断言）。
2. 本轮未提交 Android 侧改动（本任务不含）。
3. `npm run test:unit` 采用 `--test-concurrency=1`：新增测试文件后，原有 engine 用例在并行调度下
   会间歇失败（既有 flake，与本改动无关），串行后稳定 112/112。
