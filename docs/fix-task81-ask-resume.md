# task-81 提问答复后聊天续接修复

## 根因与复现

`node scripts/ask-user-e2e.mjs` 以隔离 WorkBuddy 服务、HTTP DSH stub 和真实聊天 SSE 复现链路。修复前明确失败三项：提问挂起状态为 completed、卡片答复后仍为 completed、卡片续跑 running=false。

- runChatTurn/watchPendingAsk 为释放本地 prompt-stream，把等待答复误写为 completed；processUserMessage 还发送 task_end。远端实际仍 suspended 在 ask 工具中。
- 卡片接口已经调用续跑追踪，但该追踪是裸后台 Promise，不登记 activeJobs，不发布 running 状态，也没有任务级取消/排队管理。追踪仅在远端结束后一次性回填历史，执行过程无增量。
- 前端卡片成功后只切发送按钮，无聊天回源。首次 SSE 连接不回源，且 turn_end 只处理已有气泡；订阅空档丢失 turn_start 后，最终正文也无法补建轮次。

## 改动

- 等待提问保留 status=running + pendingAsk，释放本地派发资源但不广播 task_end。重启恢复保留可答复的等待态。
- 卡片续跑登记活动作业、支持取消与结束后队列处理，同任务防重复追踪。答复刚好撞上旧派发收尾时，等待旧观察作业释放后接管。
- 答复续跑持续读取远端 history，把已落库的阶段文本经 turn_delta 推入本地聊天；远端真正结束后对账全文并完成任务，追踪超时不再报成功。
- 前端答复成功后回源权威状态，必要时恢复 SSE；首次订阅和重连均回源补齐，缺失气泡时由 turn_end 补建。阻止重复点击和切换任务后的迟到答复污染当前界面。

## 验证

- `npm run build`
- `npm run typecheck`
- `node scripts/ask-user-e2e.mjs`：自由文本与卡片答复、等待/续跑状态、增量与全文 SSE、正常完成、二次提问、停止解挂、旧节点降级。
- `node --test scripts/ask-user-ui.test.mjs`：9 项，读取当前源模板，jsdom/vm 执行真实订阅/卡片/回源逻辑。
- `npm run test:unit`：333/333 通过，含新增重启等待态回归。
- `npm run smoke`：93 项。

验证在本机隔离服务与可控 DSH stub 完成，未重启现有长期运行实例，也未声称已在用户远端真实 LLM 会话上线验证。续跑增量受远端 history 落库节奏影响，并非逐 token 转发。首次全量单测出现一次既有临时目录清理 ENOTEMPTY，随后完整重跑通过。
