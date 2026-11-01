# 项目看板「扫描未完成」按钮（未完成事项采集 · 简版）

> 状态：**已实现并本地验证通过**（2026-11-01）
> 上游方案：`docs/design-backlog-auto-collect.md`（v3 完整方案：双源采集 + 定时 + 去重状态文件 + 休眠门禁）。
> 本文只描述本轮落地的**最简可用版**：手动触发、按项目、预览勾选后落盘。
> 关联：`docs/design-backlog-integration.md`（backlog 数据层/派发/回写）、`docs/design-backlog-mcp-tool.md`（工具通道契约）。

## 1. 需求与交互

项目看板窗口顶部新增按钮 **「🔍 扫描未完成」**，手动触发一次采集：

1. **A 任务账本**：本项目里执行过、但没做完的任务（失败 / 部分成功 / 卡死中断超过 2 小时；最近 30 天内）；
2. **B 工作区代码/文档**：项目工作区里的明确标记 —— 代码 `TODO / FIXME / XXX / HACK / 待办 / 待补充 / 未完成`，文档未勾选验收 `- [ ]`、文档状态标记 `TBD / 待确认 / 待定 / WIP / 状态：草稿|进行中`；
3. 结果以**候选预览弹窗**展示（按「任务 / 代码 / 文档」徽标 + 命中详情），默认全勾选，可逐条取消；
4. 点「创建选中（N 条）」后批量写入该项目 backlog（未初始化时自动初始化），完成后刷新看板。

扫描严格只认**明确标记**，不做语义猜测、不调用 LLM（零 token）；已登记过的来源不会重复出现（见 §4）。

## 2. 服务端

| 项 | 内容 |
|---|---|
| 路由 | `POST /api/projects/:id/backlog/collect`，body `{ mode: 'preview' \| 'create', keys?: string[] }` |
| 鉴权/门禁 | 复用既有 backlog 路由：登录/令牌 + 项目可见性 `canSeeProject` + 归档项目只读拦截（归档后 400） |
| 预览 | `mode:'preview'`（缺省）只算候选、不写节点；返回 `{projectId, projectName, initialized, candidates[], stats}` |
| 落盘 | `mode:'create'` 按 `keys` 建条目（`keys` 省略 = 全建）；返回 `{created[], skippedKeys[], candidates}` |
| 模块 | `src/backlog-collect.ts`（新增）：任务候选筛选、工作区 BFS 扫描、标记解析、sourceKey、预览缓存、per-project 锁 |
| 数据层增量 | `src/backlog.ts`：`BacklogItem.sourceKeys`（从正文 `<!-- wb:source=… -->` 解析）、`createItems()` 批量建条目（一次列目录分配 id，避免 N 倍请求）、`parseSourceKeys()` |
| 审计 | `backlog.collect.preview` / `backlog.collect` 写入审计日志 |

## 3. 判定与上限（成本护栏）

- **A 判定**：`status ∈ {failed, partial_success}` 或 `running 且 now-updatedAt > 2h`；排除 `archivedAt`、`backlogRef` 派生任务（断自激）、30 天前的旧任务。
- **B 扫描**：从 `project.workspace` 起 BFS，`maxDepth=3`、`maxDirs=40`、`maxFiles=200`、单文件 ≤200KB、目录/文件超限置 `truncated`；按 mtime 新→旧优先读；单文件最多 3 条标记；单次候选上限 40、单次创建上限 30。
- **硬排除目录**：`backlog`（采集自己写的目录，含它会自激）、`.git`、`node_modules`、`dist`、`build`、`out`、`coverage`、`.next`、`vendor`、`__pycache__` 等；二进制/图片/lock 文件跳过。
- **不扩节点端点**：只用节点既有 `GET /fs/list`（单层、`all=1`）+ `GET /fs/download`，不新增/不修改 dsh-web-service（README「D6 零侵入」）。
- **mtime 缺失**（节点实现差异）：照常扫描，只是失去「新文件优先」排序，不做时间窗过滤。

## 4. 幂等（跨轮不重复登记）

- 每个候选有稳定来源键：`task:<taskId>` / `code:<sha1(相对路径+标记文本)[:16]>` / `doc:<同上>`；只依赖路径与标记文本，**不含行号**（代码上下移动不会重复登记）。
- 创建时把键写进条目正文首行：`<!-- wb:source=<key> -->`；预览阶段 `listBacklog` 顺带解析所有条目正文里的标记，命中即过滤（`stats.skippedKnown` 可见）。
- 因此：**重复点按钮不会重复建条目**；用户删除条目后再点也不会重建（正文标记随条目删除而消失，但…见下）。

> 已知局限（简版取舍）：本版没有 `suppressedKeys` 墓碑与水位线状态文件 —— 用户删掉自动条目后，下一次扫描可能重新登记（与 v3 完整方案 §8 的「删除即不再跟进」不同）。完整方案落地时补齐。

## 5. 前端

- `src/web-ui.ts`：看板工具栏新增 `#bl-collect`（归档项目禁用）；`blRender()` 绑定 `blCollect`；新增 `blCollectDialog()`（候选弹窗，按来源徽标 + 详情 + 勾选计数同步）与 `blCollectApply()`（提交 keys → toast → 刷新看板）。
- 兼容既有约束：新增内联 JS 只用 `var/function/字符串拼接`，**无 `?.` / `??`**（微信 X5 旧内核），构建期 `node --check` 通过。

## 6. 验证结果（本地）

| 项 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run test:unit` | **120 项全过**（含新增 `src/backlog-collect.test.ts` 8 项：A 判定矩阵、标记解析、sourceKey 稳定性、忽略目录/超大文件、mtime 缺失、预览去重、落盘幂等、keys 收窄） |
| `npm run build` | 通过（内联脚本 3 页 `node --check` 通过） |
| `npm run smoke` | **83 项全过**（新增 2 项：按钮/预览/落盘接线、旧内核兼容） |
| `npm run smoke:backlog`（e2e，stub 节点） | 全过（新增 11 项：预览命中代码 TODO + 文档未勾选、排除 node_modules 与 backlog 自身、落盘 2 条、labels/sourceKeys/正文标记、重复预览与重复创建幂等、归档项目被拒） |
| 真实浏览器走查 | 未做（本轮以 e2e + 静态断言覆盖；建议上线前用真实节点点一次） |
| 线上侧载实例（同一 dist + 生产数据副本 + 真实 DSH 节点） | 19/19 通过（真实仓库扫描 2.7s/14 目录/86 文件/10 候选；隔离项目预览→落盘→幂等→归档拦截全链路）——详见 [qa-online-collect-20261101.md](qa-online-collect-20261101.md) |

## 7. 未实现（属于 v3 完整方案，后续排期）

1. 定时自动采集（`ScheduledTask.action = backlog_collect`）；
2. 独立采集状态文件（水位线 / fileIndex 增量 / 墓碑）；
3. 「我的待办」页的全局扫描入口与「休眠项目（N）」分组；
4. 工具通道 `workbuddy_backlog_manage action:"collect"`（让 AI 宿主可调）；
5. 活跃项目门禁（休眠项目不自动挖）；
6. LLM 语义扫描（M4）。
