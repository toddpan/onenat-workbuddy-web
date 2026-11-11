# 本轮 Token 与运行耗时修复（2026-11-10）

## 症状与证据

用户截图显示本轮合计 297,272 tok，运行时间只有 2 秒，LLM/工具/首 token/输出速度为空。截图中的加法本身正确：1,581 + 267 + 295,424 = 297,272；仅凭截图无法还原真实整轮账本。

定位到以下可确定复现的代码问题：

1. `DshClient.streamPrompt` 用后一条 usage 帧覆盖前一条。已核对已安装 dsh-web-service 的 streaming 实现：assistant/message 的 usage 按模型步骤透传。一轮多次模型/工具往返时，WorkBuddy 只保留最后一步。HTTP SSE 回归中输入 10、20，修复前实际为 20，修复后为 30。
2. 页面用 `uncachedInputTokens || inputTokens` 回退，明确的零值被丢弃。回归输入 uncached=0、input=100、cacheRead=100、output=7，修复前命中率 50%、总量重复计数；修复后命中率 100%、合计 107。页面、远端会话统计映射和报表求和统一保留显式零值。
3. 兼容节点可能返回 running=true、elapsedMs=0、turnStartedAt=null。邻接 pi-web-service 源码就是该行为，且耗时细项固定为零。页面每次轮询把本地锚点重置到 0，导致持续显示 0～2 秒。修复后在远端缺少时间时使用 WorkBuddy 已保存的 agent 回合起止时间；有效远端 elapsed 优先。
4. 本轮用量弹窗复用 `.sp-r`，样式却限定在 `.stat-panel` 内，导致截图中标签和值连在一起。新增弹窗作用域，采用左右对齐、行间距和分隔线。

耗时面板明确标注会话累计统计，远端未提供细项时显示“节点未提供”。本轮墙钟与会话累计指标不再混淆。

## 验证

- `node --test scripts/usage-display-regression.test.mjs`：从 TypeScript 源码生成真实页面脚本，以 JSDOM 执行用量胶囊、明细和计时函数。
- `npm run test:unit`：包含真实 HTTP SSE 多步骤用量回归及会话统计显式零值回归。
- `npm run build`、`npm run typecheck`、`npm run smoke`。

## 独立复核补充

补齐远端 `turnStartedAt` 有值但 `elapsedMs=0` 的分支，本地生命周期兜底同样生效；页面回归现为 6 项。

另发现尚未纳入本次修复的独立场景：多成员任务的 `/todos` 目前以有清单成员作为时间来源，而 `/stats` 汇总所有会话；结束时的统计刷新可能命中短时缓存或遇到在途请求而被跳过。这些场景需要进一步增加 router 生命周期回归，不能视为已修复，也不能据截图认定现场命中。

## 范围

修复当前源码并构建本地运行产物；没有自动部署或重启远端服务。历史落盘中已被覆盖的步骤用量无法凭当前字段精确还原，未批量改写历史记录。截图任务所属远端节点的实际响应未获取，因此不能声称已在该线上任务完成验收。
