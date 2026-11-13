# task-58 控制台项目节点选择验收

验收窗口：2026-11-06T17:03Z～17:40Z（北京时间 2026-11-07 01:03～01:40）。仅处理 task-58，依赖 task-56；依赖文件当前为 Done。原平台派发任务为 `task-22da2aa8`，平台终态留给原任务正常回写，本条不人工设置平台成功。

## 结论与范围

三项 AC 均完成本地实际验收。读取既有项目/执行节点设计、相关 UI/路由/测试及 task-56 验收记录后，仅修复本次浏览器复现的三个 UI 缺口。产品增量均在 `src/web-ui.ts`：移动节点弹层溢出、同项目切换执行节点后文件访问说明过期、768px 关闭抽屉仍遮挡发送按钮。没有改写项目身份、后端文件路由或 task-57 远程工具实现。

保留进入本轮时全部未提交改动；开始状态及补丁保存在 `artifacts/task58/baseline-status.txt`、`baseline.patch`。本轮期间 `src/engine.ts`、`src/engine.test.ts` 及未跟踪远程 helper 文件存在并行更新，未回退、覆盖或归为 task-58 成果。最终测试针对当时整个工作树运行。只看本条产品修复的差异见 `artifacts/task58/incremental-ui.patch`。

## 按 AC 验收

| AC | 结果 | 实际证据 |
| --- | --- | --- |
| #1 项目内新会话选择在线节点并携带 nodeRef | PASS | mock 浏览器从同一项目切换 owner/executor，输入草稿保持；实际 POST /tasks 同时带 projectId 与显式 nodeRef。离线候选不显示，目录新增在线节点重载后可选，项目 ID 不变。真实 ONENAT 浏览器选 brain mapping `5602f2c2`，创建任务 `task-32d8fa26`，nodeRef 与模型回读正确，随后真实发送完成。 |
| #2 编辑区分文件节点、默认执行节点及远程状态 | PASS | mock 表单分别显示 file-owner/execution，清除默认执行节点立即变为直接访问，保存后重开仍为空，文件 owner/root 不变。真实表单文件归属 KB136 mapping `6cc2987d`、默认执行 brain，直接显示“跨节点远程访问；项目目录不是执行节点的原生本地 cwd”。390px 实际表单 clientWidth=scrollWidth=358。 |
| #3 文件树/backlog 始终访问文件 owner；<=768px 可用 | PASS | mock 节点返回不同文件并检查各次 FS list/download 的节点及鉴权，全部命中文件 owner；即使带冲突 executor 查询，文件 owner 离线时文件与 backlog 均返回 502，不回退。真实 tree/root 为 KB136，backlog 读取 owner-only 条目，README 下载 SHA256 与 KB136 随机标记一致。320/390/768px 均实际完成节点选择、发送、文件浏览、backlog 概览/看板和项目编辑，无页面横向溢出。 |

### 真实节点证据的边界

- 两节点入口、凭据、在线状态和模型目录均经实时 ONENAT 目录查询，未把先前公网端口当当前入口。KB136 文件根与 brain 执行根均为随机 `/tmp/wb-task58-*` 目录，且检查 KB136 根在 brain 上不存在。
- 真实浏览器按正常选择器选节点和模型。为隔离运行目录，使用正常附件上传前的 `commitDraft('')` 草稿落盘路径，然后由仅存在于测试 fixture 的控制端为该 draft 指定 brain 临时 workDir；之后通过发送按钮真实发送。真实测得任务 completed，远端 `/sessions/:id` 回读 cwd 为 brain 临时目录，浏览器轨迹显示运行 `node -e "console.log(process.cwd())"`，返回 TASK58_OK。没有让模型修改生产目录。
- 真实任务 `task-32d8fa26`，远端会话 `session-5c7fa5df-884d-4745-b178-e76110203f1d`。README SHA256：`f1012c04722344a38159a8982b747d6fc5082a7e3ee84c2ddddbb4f0319343a4`。带冲突 executor 查询的下载仍命中项目文件 owner。
- 真实一键首消息创建的 POST 行为由 mock 浏览器验证；真实节点采用上述无首消息 draft 后发送流程。不能把这两条合并描述为同一个未经干预的一键真实场景。
- 本条真实验证是控制台选择、会话执行和 owner 文件读取，不替代 task-57 对远程写入/构建/Git 的验收。

## 缺口与修复

1. **390px 节点菜单超出视口**：原菜单 top=571.273、height=293、bottom=864.273，超过 844px 视口。旧逻辑固定以 260px 判断可用空间。改用实际菜单高度、12px 边距和有界 max-height/max-width；节点目录/搜索重绘后重新定位，支持 visualViewport resize/scroll，旧环境回退 innerWidth/innerHeight。最终 320/390/768 三档 popup 均在视口内；视觉视口缩小另有函数回归。
2. **文件树来源说明缓存过期**：同项目 owner/root 未变时目录树复用，但 rootSrc 仍显示上一个执行节点的“跨节点访问”。现在保留目录 entries，同时按当前任务更新 rootSrc。修复前后证据分别为 `stale-file-status-before.json` 和最终浏览器报告；文件路由本身在复现时已正确。
3. **768px 关闭抽屉遮挡发送**：抽屉移动样式宽 100vw，关闭偏移仍 -580px，实测关闭态左边界 x=580、宽768，右侧188px覆盖发送按钮，命中元素为 drawer-body。仅在移动媒体规则中将关闭偏移设为 -100vw，显式保留打开态 right:0。最终768px实际点击发送并完成任务。

前两项先新增测试，原源码运行3项全部失败（`ui-regression-before.log`），修复后通过。后补视觉视口用例，总计4/4。第三项以真实浏览器失败 hit target/几何记录和768px复验覆盖，不用“CSS字串存在”代替交互验证。

## 最终运行结果

以下日志位于 `artifacts/task58/`，命令均实际运行，最终退出码0：

| 检查 | 结果 | 日志 |
| --- | --- | --- |
| npm run typecheck | PASS | typecheck-verified.log |
| npm run build（含内嵌页面脚本解析） | PASS | build-verified.log |
| npm run test:unit | 218/218 | unit-verified.log |
| npm run smoke | 93/93 | smoke-verified.log |
| node --test scripts/project-console-ui-test.mjs | 4/4 | ui-regression-verified.log |
| node scripts/project-node-ui-test.mjs | 19条 | ui-focused-verified.log |
| node scripts/project-execution-e2e.mjs | 8/8组 | execution-verified.log |
| node scripts/project-workspace-e2e.mjs | PASS | workspace-verified.log |
| node --test scripts/workspace-remote-test.mjs scripts/workspace-access-test.mjs | 25/25 | workspace-tools-verified.log |
| 实际 mock 浏览器，桌面+320/390/768px | 7/7组 | mock/browser-run-conclusive.log、mock/browser-acceptance.json |
| 实际 ONENAT 两节点浏览器 | 5/5组 | live/browser-run.log、live/browser-acceptance.json |
| git diff --check | PASS | diff-check.log |

最初基线为217个单测，最终218个，新增数量来自本轮期间的并行工作；不可将总数增长归于本条UI修复。早先额外远程工具回归出现缺失导出、结果超时/损坏三项失败，保留 `workspace-tools-final.log`；并行更新后重新构建并完整复验25/25，不隐去先前失败。

## 浏览器执行与失败记录

使用既有 Ego 浏览器，一个 TaskSpace（14，`workbuddy task58 console acceptance`），已 finish，未安装新浏览器或升级工具。320/390/768px使用 CDP设备视口，每个独立调用重新应用模拟参数。保留所有中途失败日志：错误测试选择器、看板状态复用、翻译扩展覆盖关闭按钮，以及上述真实768px产品缺陷。

首次验收时用户浏览器的 kiss-translator 浮层反复覆盖文件侧栏关闭按钮；仅注入隐藏样式未稳定奏效，曾以按钮处理器完成后续流程，该轮关闭步骤不能证明用户可点击。按用户要求已补做真实指针复验，见下方补充：只在隔离页移除扩展独立容器并观察重新注入，320/390/768px 均经 `page.click('#btn-ws-close')` 真实点击，中心命中关闭按钮、事件 isTrusted=true、侧栏随后关闭。没有调用 evaluate click/dispatchEvent 或产品关闭函数，也没有为扩展修改产品源码。

截图：`mock/mobile-files.png`、`mock/mobile-backlog.png`、`live/desktop-files.png`、`live/desktop-editor.png`、`live/mobile-editor.png`、`live/mobile-backlog.png`。移动看板使用原有局部横向滚动，页面本身不横向溢出。尚未实测真实微信/X5、iOS/Android软键盘、辅助功能或所有<=768px设备；Chromium视口和函数级视觉视口回归不能证明这些环境全部兼容。

## 复验入口与清理

- mock fixture：`node scripts/project-console-fixture.mjs`；浏览器：`node scripts/project-console-browser-run.mjs mock`。
- 真实 fixture：`WORKBUDDY_LIVE_ACCEPTANCE=1 node scripts/project-console-live.mjs`；浏览器：`node scripts/project-console-browser-run.mjs live`。需要本机现有ONENAT授权、在线节点及所选模型。没有把真实凭据写入报告。
- 浏览器脚本依赖验收TaskSpace的p1及fixture输出。portable runner做Ego输入注入，避免Ego进程cwd为`/`且不继承shell环境；支持 `WORKBUDDY_CONSOLE_ARTIFACTS` 与 `WORKBUDDY_BROWSER_SPACE` 指定隔离证据目录/空间。用户要求的真实指针复验已通过该runner完整运行7/7，未重跑真实模型。
- 停止fixture使用各自控制地址 `POST /stop`。最终mock、真实fixture已正常退出；真实会话、两侧随机目录、增量workspace及本地临时数据删除均获成功响应，见 `live/fixture-report.json`。DSH DELETE可能保留归档历史，不声称物理擦除聊天。
- 第一轮mock被job取消以SIGKILL结束，未运行清理回调；已核对精确临时目录与项目ID后删除其残留。首次macOS `/var` 与 `/private/var` 实路径断言拒绝删除，改按canonical temp parent验证后成功。见 `temp-cleanup.json`、`cleanup-verified.json`，最终本地task58临时目录为0。

未 commit/push，未部署或重启正式服务，未修改现有DSH GUI，未派发重复实现/后续backlog，未向原宿主任务递归发消息。所有临时服务已停止；三个AC在本地文件登记，原平台状态由正常任务回写流程处理。

## 用户要求的真实指针复验（北京时间 2026-11-07 01:44 起）

独立重读原 `artifacts/task58/mock/browser-run-second.log`：#1/#2 PASS；后续报错明确为 kiss-translator-fab 拦截 #btn-ws-close，不是产品关闭按钮本身失败的证据。原文件未覆盖，SHA256 已在 `interaction-retest/scope.json` 登记并于结束时重新比对。

隔离复验页属于新一轮独立浏览器TaskSpace 15（`workbuddy task58 pointer interaction retest`），原14空间早已结束。检查发现 kiss-translator-fab 和 kiss-translator-box 各有独立shadowRoot；在测试页移除这两个独立host，并用 MutationObserver 防止该页重新注入，不禁用用户全局扩展，不改产品DOM或源码。

新脚本在每个移动宽度点击前记录 `elementFromPoint`，再使用浏览器 `page.click` 关闭；监听只读证据记录 isTrusted，未调用 DOM .click、dispatchEvent 或 closeWsSide。最终320/390/768三档命中均为 btn-ws-close、isTrusted=true、sidebarClosed=true。随后完成backlog概览/看板、项目编辑、正常控件刷新目录及owner离线拒绝；完整7/7组通过，浏览器错误数组为空。

证据均在 `artifacts/task58/interaction-retest/`：

- `browser-pointer-conclusive.log`：最终7/7；`mock/browser-acceptance.json`：三档命中、trusted事件、布局、owner请求。
- `browser-pointer.log`、`browser-pointer-final.log`：保留新增节点目录场景两次中途失败。冷启动两节点消耗凭据请求保护额度，第三节点探测失败缓存，测试等候条件又早于打开picker触发正常TTL探测；最终通过真实“资源目录→强制刷新”后打开picker执行探测恢复。没有强改资源/探测缓存或产品逻辑，不把这两次测试等候失败误报为已修产品缺陷。
- `typecheck.log`、`build.log`、`unit.log`（218/218）、`smoke.log`（93/93）、`ui-regression.log`（4/4）：当前工作树统一构建复验通过。
- `helper-remote.log`：当前两个文件合跑25/25，包含结果边界；`result-boundaries.log`：两项结果边界独立2/2。这两个边界属于25项子集，不能相加宣称27项。用户提供的另一次24/24是其独立运行口径，本轮以实际25/25回包为准。旧缺失导出/超时/损坏失败来自并行中间态，不再作为当前helper缺陷。
- `scope.json`、`final-checks.json`：原失败日志哈希未变、产品UI源码哈希未变，新增仅测试脚本和证据文档；本轮未改helper/remote实现。

本轮隔离fixture已通过 /stop 正常退出并删除临时数据；浏览器TaskSpace15已finish。真实ONENAT两节点原有5/5证据保留，未重复执行模型。微信/X5真机与移动软键盘仍未验证。Ego提示可升级，未升级工具。

## 最终收尾核对（2026-11-06T17:59:43Z）

按用户要求只独立读取已有报告，不再扩张测试：原mock browser报告7项均PASS，live browser报告5项均PASS；live fixture-report清理记录共5项成功，分别为远端会话、owner临时目录、execution临时目录、新增workspace、本地临时数据。task-58的3项AC已全部勾选，依赖task-56保持不变。

证据口径必须分开：原mock7/7轮中，翻译扩展遮挡后的收起文件栏使用handler点击，因此该原轮不能称为“全真实点击”，也不能据此证明关闭按钮可被用户命中。其后独立interaction-retest记录的真实指针复验作为补充证据保留，不反向改写原轮发生过的操作。真实微信/X5、移动软键盘仍未验证；DSH删除/归档成功不等于历史物理擦除。

已有范围已收尾，本次仅补文档和核对AC；未提交、未部署、未重复派发或手工改平台终态。原派发task-22da2aa8由本次最终答复结束后进入平台正常自动回写流程；本地保留In Progress，不预先宣称平台已Done。
