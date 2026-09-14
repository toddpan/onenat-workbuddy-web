# 聊天窗口流式内容「显示不全」根因分析与修复

> 现象：在 WorkBuddy 控制台发一个任务，聊天气泡里流式显示的 AI 内容不全 —— 有一部分没有收到或没有显示出来。
> 本文给出链路定位方法、复现证据、根因清单与修复/回归测试。

## 1. 链路拓扑

```
远端 DSH 节点 ── dsh-web-service /prompt-stream (SSE) ──► WorkBuddy 引擎 ──► 浏览器 EventSource ──► 聊天气泡
   (harness          event: delta / reasoning /                    engine.onDelta        GET /api/tasks/:id/stream
    session/event)    tool_call / tool_result / turn_end           store.turn.text       turn_delta / turn_end
                      经 ONENAT 隧道/反代                                             RAF 节流渲染 + turn_end 收尾
```

内容可能在四处丢失：远端 SSE 传输、`dsh-web-service` 转发、WorkBuddy 引擎落库、浏览器渲染。逐层用探针与回归测试定位后，**主因在浏览器渲染层与断线恢复层**，另有三处放大/诱发因素。

## 2. 定位方法（可复跑）

| 工具 | 作用 |
|---|---|
| `e2e-artifacts/probe-dsh-sse.mjs` | 同时订阅 `prompt-stream` 与底层 `/events`，对账「事件总线 vs 转发流 vs history」三层字符数 |
| `e2e-artifacts/cut-proxy.mjs` | 故障注入代理：在 `prompt-stream` 上转发 N 字节后掐断，模拟隧道/反代空闲超时 |
| `e2e-artifacts/e2e-workbuddy-turn.mjs` | 真机端到端：L1 远端原始帧 / L2 引擎事件流 / L3 落库正文，并与远端 history 对账 |
| `e2e-artifacts/client-streaming-test.mjs` | **jsdom 驱动真实渲染出的控制台 UI**，断言「气泡最终显示文本 == 服务端权威 turn.text」 |
| `e2e-artifacts/mock-remote-robustness-test.mjs` | 确定性 mock 远端：CRLF / 多行 data: / 心跳 / 掐断 / 引擎兜底 / 落盘合并 |
| `e2e-artifacts/md-lossless-test.mjs` | markdown 渲染无损性（代码块、表格、超长文本不得吞正文） |

一键复跑：

```bash
npm run test:streaming        # 三组回归一键跑（mock 远端 / 客户端渲染 / markdown 无损）
npm run test:streaming:e2e    # 真机端到端（消耗 API 额度，需本地 DSH + 一个已配置子智能体）
```

分项：

```bash
# 1) 渲染当前 UI 供客户端测试使用
node -e "import('./dist/web-ui.js').then(m=>require('fs').writeFileSync('/tmp/wb-ui.html',m.renderWebUi('/onenat-workbuddy',{auth:false})))"
node e2e-artifacts/client-streaming-test.mjs /tmp/wb-ui.html   # 5/5
node e2e-artifacts/mock-remote-robustness-test.mjs             # 14/14
node e2e-artifacts/md-lossless-test.mjs /tmp/wb-ui.html        # 全部无损
node e2e-artifacts/e2e-workbuddy-turn.mjs http://127.0.0.1:3080/api/v1 /tmp /tmp/wb-e2e # 真机
```

## 3. 根因

### R1（主因）收尾渲染丢弃服务端权威全文 —— `web-ui.ts` `finalizeTurnBlocks`

旧代码只在「正文块带 `contentState`」或「存在多个正文块」时才回填：

```js
if (textBlk && (textBlk.contentState || textBlks.length > 1)) { /* 用 turn.text 重渲 */ }
```

而 `buildTurnElement` 渲染**中途加入**的流式轮次时，只写 `te.el.textContent = turn.text`（**没有 contentState**）。
于是「页面上只有一个无 contentState 的正文块」这个条件为假 → 整段收尾被跳过 →
`turn_end` 携带的服务端全文被直接丢弃，气泡永久停在加入时的那半截。

触发场景（都是日常操作）：任务执行中切走再切回、刷新页面、DSH Web GUI 内嵌 iframe 面板被重新挂载、
断线期间页面重连后只拿到详情快照。**这就是「有一部分没有显示出来」的直接原因。**

jsdom 回归证据（修复前）：C2 场景只显示 117/526 字符，结尾标记缺失。

### R2 浏览器 EventSource 重连不回源 —— `web-ui.ts` `connectStream`

`es.onerror = () => {}` 静默吞掉断线；EventSource 自动重连**不重放**断连期间的事件。
若 `turn_end` 恰好落在断连窗口里，页面永远停在半截，只能靠用户手动切会话/刷新恢复。
（回归证据：C4 场景 115/526 字符。）

### R3 每个 delta 全量同步写盘（放大因素）—— `store.ts`

`onDelta → mutateTask → save()` 是全量 `JSON.stringify(store) + writeFileSync`。
实测 1.52MB store 单次 **3.48ms 且同步阻塞事件循环**；按流式粒度（旧版/逐 token provider 可上千 delta）
累计数秒阻塞，把远端 SSE 读取与浏览器方向写入一起拖慢，静默段还会触发隧道/undici 空闲超时**掐断流**
→ 反过来制造 R2/R1 的触发条件。

### R4 SSE 帧解析过窄 —— `remote-client.ts`

只按 `\n\n` 切帧、只取第一行 `data:`：
- 反代/隧道改写为 CRLF 时，分隔符是 `\r\n\r\n`，`indexOf('\n\n')` **一帧都切不出来**；
- 规范允许的长载荷多行 `data:` 会被截断成半截 JSON → `JSON.parse` 失败 → 该帧被丢弃。

### R5 生产者未锚定 turn（潜在提前关流）—— `dsh-web-service` `streaming.ts`

`prompt-stream` 是**会话级**订阅。若订阅时该会话上一轮尚未收尾（prompt 被排队 / steer 到运行中回合），
旧轮次的 `turn/end` 会被误判为本次结束 → 流提前关闭，调用方拿到半截内容却认为 `complete`。

## 4. 修复

| 文件 | 修复 |
|---|---|
| `onenat-workbuddy-web/src/web-ui.ts` | `finalizeTurnBlocks`：只要拿到权威 `turn.text` 就**无条件回填**，与块的来源无关；正文取「contentState 优先、否则 DOM 文本」 |
| 同上 | 新增 `resyncCurrentTask` / `reconcileViewWithServer`：SSE **重连成功即回源**，按服务端权威文本就地重建仍在流式或明显偏短的轮次气泡；`appendLiveTurn` 幂等（同轮次不重复插气泡） |
| `onenat-workbuddy-web/src/store.ts` | 新增 `appendTurnText` + `scheduleSave()`：流式增量只改内存（内存态权威），磁盘按 250ms 尾随合并；`save()`/`flush()` 仍即时落盘，进程 `exit` 前兜底落盘 |
| `onenat-workbuddy-web/src/engine.ts` | `onDelta` 改走 `appendTurnText`（内存即时可见 + 磁盘合并），回合边界由既有 `updateTurn` 触发 `flush()` |
| `onenat-workbuddy-web/src/remote-client.ts` | 新增 `parseSseFrame`/`SSE_FRAME_SEP`：容忍 CRLF，按规范逐行解析并支持多行 `data:`，忽略心跳注释 |
| `dsh-web-service/src/streaming.ts` | `prompt-stream` 与 OpenAI 流式路径锚定本轮 turn：订阅前旧轮次的 `turn/end` 忽略，已认领 turn 后其它 turn 的事件不转发（steer 模式保持旧行为） |

## 5. 验证结果

| 测试 | 修复前 | 修复后 |
|---|---|---|
| 客户端渲染回归 C1 正常流式 | ✅ | ✅ |
| 客户端渲染回归 C2 中途加入 | ❌ 117/526 | ✅ 524/526 |
| 客户端渲染回归 C3 断线丢帧 | ✅ | ✅ |
| 客户端渲染回归 C4 断线且丢 turn_end | ❌ 115/526 | ✅ 524/526 |
| 客户端渲染回归 C5 折叠旧轮次 + 重连 | — | ✅ 气泡数不变（不重复补插被折叠轮次） |
| mock 远端健壮性（CRLF/多行/心跳/掐断/兜底/落盘） | 12/14 | **14/14** |
| markdown 渲染无损（代码块/表格/超长） | ✅ | ✅ |
| 真机端到端（本地 DSH） | — | L1=L2=L3=2317 字符，与远端 history 完全一致 |
| 真机端到端 + 中途掐断（cut-proxy） | — | 流上只收到 73 字符，兜底对账后落库 2465 字符（全文） |
| `smoke-standalone.mjs` | 39/39 | 39/39 |
| `smoke-schedules.mjs` | 51/51 | 51/51 |
| 单 delta 落库阻塞 | 3.48 ms | **0.0058 ms** |

## 6. 生效方式

- **onenat-workbuddy-web**：`dist/` 与 `lib/` 已重新构建（`bash scripts/build-standalone.sh`、`bash scripts/build.sh`）。
  - 独立部署实例（`node dist/server.js --port 3081 …`）**需按原命令重启**才会加载新 dist。
  - DSH 插件形态：`dev_reload_package onenat-workbuddy` 或重启 DSH。
- **dsh-web-service**：`lib/` 已重新构建，并已用 `dev_reload_package dsh-web-service` 在运行中的 DSH 上热重载生效
  （已自检 `/api/v1/system/status` 与 `prompt-stream` SSE 路由正常）。

> 注：`~/.dsh/profiles/web/node_modules/@dsh-external/onenat-workbuddy` 目前是**悬空软链**
> （指向已改名的 `DHS-test/onenat-workbuddy`，实际目录为 `onenat-workbuddy-web`），
> 因此 DSH GUI 内并未挂载该工作台；用户侧入口是独立部署的 3081 控制台。若要 GUI 内嵌面板，请重建该软链。

## 7. 未覆盖 / 后续建议

- 未引入 delta 级 `Last-Event-ID` 断点续传（重连目前靠回源补齐，语义足够且改动更小）。
- 引擎侧的兜底仍依赖远端 `GET /sessions/:id` 的 `status`；若远端在回合中途误报 `idle`，
  对账可能取到部分文本（本次未复现，保留观察）。
