# QA 报告 —— 看板依赖就绪误报阻塞修复 + 阿里云部署

- 日期：2026-11-02
- 触发：用户报告「项目看板中的任务，依赖关系更新不对，A 依赖 B 任务，B 任务完成了 A 还显示依赖 B」
- 修复范围：`src/backlog-query.ts`（新增 `isDepDoneStatus`）、`src/backlog-query.test.ts`（回归用例）
- 部署：`scripts/deploy-standalone.sh root@natpass.yikaihui.com` 标准流水线

## 1. 根因

看板依赖判定存在**两套不一致的「完成」定义**：

| 侧 | 实现 | 语义 |
|---|---|---|
| 派发拦截 / 任务终态回写（`backlog-service.ts` / `engine.ts`） | `resolveDoneStatus(config.statuses)` | 按名字匹配 `Done`/`*完成*`，**不要求是 statuses 末位** |
| 看板就绪/阻塞徽标（`backlog-query.ts` `readinessOf`） | `isTerminalStatus` | **只认 statuses 配置的末位** |

当项目 backlog 配置里 `Done` 之后还挂着其它状态（如 `['To Do','In Progress','Done','Cancelled']`，
或中文 `['待办','进行中','完成','取消']`）时：B 完成被回写成 `Done`（非末位）→
`isTerminalStatus('Done')` = false → A 永远显示 ⛔ 阻塞「未完成依赖: B」。

未暴露原因：同日早前的 QA（`qa-backlog-query-20261102.md`）语料用的是标准三档配置（Done 恰在末位），
两条路径结果一致；真实项目在 Done 后追加状态即触发。

## 2. 修复

- 新增 `isDepDoneStatus(status, statuses)`：依赖视为完成 = 终态 **或** 等于
  `resolveDoneStatus` 判出的 Done 档（大小写/空白容错），与派发拦截的 `status !== doneStatus` 完全对齐；
- `readinessOf` 的依赖检查由 `isTerminalStatus` 换成 `isDepDoneStatus`；
- 条目自身终态判定、`isClosedStatus`（openOnly/done 计数）不变。

## 3. 回归用例（`backlog-query.test.ts`）

- Done 非末位（英文/中文配置）→ 依赖完成 → A 就绪（修复前误报阻塞）；
- 末位终态（`Cancelled`）→ 视为已完结解除阻塞（与上游 terminal 语义一致）；
- 夹在中间的取消写法（`['To Do','Cancelled','Done']` 的 `Cancelled`）→ 不算完成，仍阻塞（fail-closed）；
- `isDepDoneStatus` 直测：终态 / done 大小写空白容错 / 未完成。

## 4. 验证

| 项 | 结果 |
|---|---|
| `npm run typecheck` | ✅ |
| `npm run test:unit` | ✅ 162/162（含新增回归） |
| `npm run build` | ✅ |
| `npm run smoke` | ✅ 91 项 |
| `npm run smoke:backlog` | ✅ 全过 |

## 5. 部署（阿里云线上）

- 方式：`bash scripts/deploy-standalone.sh root@natpass.yikaihui.com`（构建 → smoke:mcp + smoke:monitor 31 项 → md5 差异上传 → 远端备份替换 → `node --check` → `systemctl restart onenat-workbuddy` → healthz / MCP 匿名 401 fail-closed）
- 变更文件（6）：`backlog-query.js`、`backlog-service.js`、`backlog-tool.js`、`backlog.js`、`router.js`、`web-ui.js`
- 回滚点：远端 `/opt/onenat-workbuddy/dist/dist.bak-<ts>-<file>`
- 部署后验证：本机 healthz ✅（version 2026.11.1）；公网 `https://natpass.yikaihui.com/onenat-workbuddy/healthz` → 200 ✅

## 6. 备注

- 就绪态是查询时实时计算的，**已受影响的存量条目无需修数据**，重启/刷新看板后立即恢复 ✅；
- 已知残留（未改，保持既有语义）：`dispatchBacklogItem` 拦截用 `status !== doneStatus`，
  对「末位终态为取消类」的依赖会判为未完成而拦截派发（可用「忽略依赖」force）；如需对齐可后续统一。
