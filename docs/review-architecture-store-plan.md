# 架构评审：store 异步落盘 + 冷归档瘦身方案（Review Architecture R2）

> 评审时间：2026-10-17（公司笔记本节点，静态分析 + 本地验证）
> 评审对象：基线 `d1f96ac` 之后的两笔提交——`3b3a393`（落盘异步化+尾随放宽+异步scrypt）、`249f6a4`（冷归档瘦身 store.json）
> 方法：全量 diff 精读 + 行号核对 + `npm run typecheck` / `test:unit`(35/35) / `smoke`(51/51) 本地实测
> 边界：仅架构与扩展性。未做安全漏洞分析、未执行真实远端 e2e、未做崩溃/断电注入实验。

## 结论摘要

1. 方案整体方向正确：原子写（tmp+rename）消除了上轮 R2 的截断损坏源；异步单飞 + 冷归档把 15.9MB store 的落盘冻结问题按"写盘出主线程 + 磁盘骨架化"两层化解，架构上读路径零改动、内存仍持全量，是低风险、可逆的演进。typecheck / 单测 35 项 / smoke 51 项本地全部通过（2026-10-17 实测）。
2. 但上轮 R1（store.json 损坏 → `load()` 静默清空 → 启动回写覆盖原文件）**未被本方案覆盖**：`src/store.ts:106` 仍是静默 `catch {}`，`src/server.ts:210` 仍无条件 `updateSettings` 回写。原子写降低了损坏概率，损坏后的数据丢失链原样存在，且现在还叠加"归档索引丢失"放大效应。
3. 冷归档存在一个**真实的并发数据丢失窗口**：归档写盘（await）期间若该任务被 mutation，归档文件是 await 前的旧快照，`bulkArchived` 标记却在其后设置——重启重水合会用旧归档覆盖期间的增量（见 §R-A1，属小概率但非防御性设计）。
4. 次要发现：save 语义从"同步立即持久"弱化为"异步尽快持久"（崩溃窗口数据丢失面扩大，文档已自述）；旧版本二进制读新 store.json 会看到骨架任务表现为"内容消失"（降级兼容性）。

## 风险清单

| # | 严重度 | 位置 | 触发条件 | 影响 | 最小修改方案 | 验证方式 |
|---|---|---|---|---|---|---|
| R-A1 | **中高** | `src/store.ts` archiveSweep（先 `JSON.stringify` 快照→`await fspWriteFile`→再置 `t.bulkArchived`）与 mutateTask/touchTask 的时序 | 归档写盘的 await 窗口内，该终态任务被 mutation（如对终态任务追问/重试、subtask 日志补写）：mutation 时 `bulkArchived` 尚未设置，`touchTask` 不生效；增量已随全量落盘，随后 sweep 置标记骨架化 | **重启后数据丢失**：重水合发现骨架 + `bulkArchived` → 读归档文件（旧快照）→ await 窗口内的增量 turns/logs 丢失，且无任何告警 | sweep 记录 await 前的 `t.updatedAt`，写盘成功后、置标记前比对 `updatedAt` 是否变化，变化则跳过本轮下轮重试；或在 await 前先置临时 `archiving` 旗标使 touchTask 能感知 | 构造归档窗口内 mutate 的时序用例（可用 `WORKBUDDY_ARCHIVE_BOOT_DELAY_MS` + 手动触发 sweep） |
| R-A2 | **高（沿用）** | `src/store.ts:106` 静默 catch + `src/server.ts:210` 无条件启动回写 | store.json 任何原因损坏后的下一次启动 | 内存清空无告警 → 启动回写把空数据覆盖原文件；**新增强化**：归档文件 `data/archive/*.json` 成孤儿，任务索引随 store 一起丢失，恢复难度比上轮更高 | 落实上轮 R1 三件套：catch 内告警 + 损坏文件改名 `store.json.corrupt-<ts>`；启动回写仅在 CLI/env 值与存量不同时执行 | 损坏样本重跑启动路径；`npm run smoke` |
| R-A3 | 低中 | save() 语义变化（`save()` 现为异步，`src/store.ts` flushAsync） | 结构性变更（创建子智能体/任务/设置修改）后进程在写盘完成前崩溃/被 SIGKILL | 上轮这类数据同步持久、崩溃即存；现在丢失窗口 = 写盘时长（15MB 级数百 ms）+ 3s 尾随窗口。可接受但需被知情接受，不是 bug | 文档明确 durability 等级变化；关键结构变更（如改密后的 auth.json 除外、agent 创建）如需强持久可对个别路径保留 `flush()` | 崩溃注入实验（未执行，见缺口） |
| R-A4 | 低 | `flush()` 临时文件 `store.json.tmp` 与 `fspWriteFile` 共用同名 tmp；flush（exit 路径）与在途异步写并发时 epoch 防护已覆盖 rename，但**两路径写同一个 tmp 文件** | 进程 exit 触发 flush 时恰有在途异步写同写 `store.json.tmp` | exit 在主线程同步执行，与线程池写盘可交错写同一 tmp；epoch 检查使异步方放弃 rename，最终文件仍一致，仅 tmp 内容可能短暂混杂（rename 前被 flush 覆盖为完整内容）——实际后果趋零 | tmp 文件名按 epoch/随机后缀区分（一行改动） | 现有 epoch 逻辑代码审阅已核；补单测可选 |
| R-A5 | 低 | serializeForDisk 骨架 + 旧版本二进制 | 用旧版本（<249f6a4）二进制启动新数据目录 | 旧版无重水合逻辑，bulkArchived 任务显示为空会话——用户视角"数据消失"（数据实际在归档文件，未丢） | README/standalone-deploy.md 增加"降级前先跑当前版本清空 bulkArchived 或备份 archive/"说明 | 文档核对 |
| R-A6 | 信息 | write+rename 未 fsync | 断电（非进程崩溃） | rename 可能先于数据落盘持久化，极端情况 store.json 缺失/旧版——个人/内网部署可接受 | 如需更强保证：rename 前 `fh.datasync()`（牺牲部分性能收益） | 未执行断电注入 |

## 已验证为正确的关键设计（证据）

- **原子写消除截断损坏**：`flushAsync/doWrite` 与 `flush` 均 tmp+rename（store.ts diff），上轮 R2 关闭。
- **异步单飞 + epoch 防回写**：`dirtyGen`/`writeEpoch` 逻辑审阅无发现丢失更新路径；rerunNeeded 补写保序。
- **engine 编排路径漏改已补**：engine.ts:2167 每 25 delta 改 `scheduleSave`，与 chat 路径一致。
- **异步 scrypt**：login/changePassword 热路径出主线程（auth.ts），server.ts 两个调用点已 `await`；限速与失败延迟逻辑未受影响。改密后新哈希仍用同步版（单次 ~55ms，低频，可接受）。
- **归档顺序崩溃安全（主路径）**：先写归档文件成功再标记+save，崩溃只留孤儿归档文件；`archivePath` 有 id 白名单防路径注入；deleteTask 级联清理。
- 本地实测：`npm run typecheck` exit 0；`test:unit` 35/35；`smoke` 51/51（2026-10-17）。

## 交叉核对标记（转主调度）

- **安全意见**：R-A3 durability 弱化对 auth.json（不受影响，独立落盘）以外的敏感数据是否可接受；归档文件含会话明文与 apiKey 引用，`data/archive/` 落盘权限需一并评估（沿上轮 §3.1 移交项）。
- **回归用例**：R-A1 时序用例当前 51 项 smoke 不覆盖；建议补"归档窗口内 mutation + 重启重水合"回归；流式完整性场景（docs/streaming-integrity.md）应作为 3s 尾随窗口变更的固定回归项。

## 材料缺口与假设

1. 未执行：崩溃/断电注入、真实远端 e2e、多实例并发写同一 dataDir、"归档窗口 mutation"时序复现（静态推演 + 代码级确证，未复现运行时）。
2. 线上数据（15.9MB→5.5MB、healthz p50 1.6ms→167ms→1.5ms）引自提交信息自述，未独立复测。
3. 假设：单实例部署、终态任务仍可被 mutation（touchTask 的存在自证此场景被预期）。
4. R-A1 触发概率依赖终端任务被修改的频率，未从 git 历史统计；成立性由代码时序确证，概率未量化。

## 验收对照

| 验收标准 | 通过情况与证据 |
|---|---|
| 1. 每个架构风险含位置/触发条件/影响/最小修改方案 | ✅ §风险清单 6 条，全部含四要素 + 验证方式 |
| 2. 按组件/接口归组并标注交叉核对点 | ✅ 发现集中于 store 持久化组件 + auth 接口语义；§交叉核对标记列出安全 2 项、回归 2 项 |
| 3. 未执行的验证不标注通过、列明缺口 | ✅ 本地 typecheck/unit/smoke 实测通过已注明；崩溃注入/远端 e2e/时序复现均列入缺口；线上指标注明为提交自述 |
