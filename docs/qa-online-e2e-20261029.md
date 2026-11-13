# 在线 QA 报告 —— 执行位置/模型/工作区/状态栏改造（feat/exec-place-ux）

> **2026-10-29 更新：4 个 BUG 已全部修复并上线验证通过**（commit `369e310` + `1b913e3`，增量部署 web-ui.js 两轮，部署后浏览器逐项复验，见文末「修复与交付」节）。

- 日期：2026-10-29（08:00–08:45 初测；08:55–09:15 修复与复验）
- 环境：阿里云线上 https://natpass.yikaihui.com/onenat-workbuddy/（页脚版本 **v2026.10.29**，与本地 99450dd 一致）
- 账号：wb-qa（admin）；真实浏览器（Chrome DevTools MCP），登录态走 /api/auth/login
- 范围：TODO.md epic 全部 23 任务中可在线验证的 21 项（S3 上下文圆环、LLM 摘要续接按计划延后，不在列）
- 证据截图：`qa-20261029/01–05*.jpg`

## 结论速览

**19 项通过，3 个 BUG**（其中 2 个为 F1/F3 右侧栏的阻塞级缺陷，均有一行级修复）。核心改造（模型按任务保存、目录跟随节点、项目节点权威、草稿态、fork 续接、状态栏、逐轮用量）全部按设计工作。

| 项 | 结果 | 要点 |
|---|---|---|
| P0-1 模型按任务保存 | ✅ | 选中模型触发 `PUT /tasks/:id/model` + `PUT /tasks/:id/session-model` 双写；`task.model` 持久化（刷新后按钮仍显 deepseek-v4-flash）；全局 `state.taskEnv.model` 未被污染；其他任务无 model 字段 |
| P0-2 模型目录跟随任务节点 | ✅ | 草稿态目录=草稿所选节点（56 模型）；任务态目录=执行节点（KB136→12 模型，公司笔记本31789→56 模型）；按钮描述实时显示「模型目录: ×××」 |
| P0-3 项目任务节点以项目为准 | ✅ | 项目任务 `task.nodeRef=null`（创建不下发）；头部回显 `📦 项目 · 🖥 项目节点`（=project.nodeRef.mappingId=0c93ebda）；模型目录跟项目节点 |
| S1-1 状态栏双胶囊+明细面板 | ✅ | `⏱ 1 轮 · 3 步 · 241 tok/s` + `🗄 77K tok · 缓存命中 93%`；点击弹面板：输入/输出/缓存读/写 + 按成员行；Esc/点外关闭 |
| S1-2 事件驱动刷新 + 统计不可用 | ✅*/⚠️ | 空闲 16s 抓包 0 次统计轮询（仅运行中 5s）；turn_end 后胶囊即时更新。「统计不可用」灰胶囊**无真实样本**——当前 7 节点 /stats 全部 supported:true，代码路径审查通过（supported:false 且 reasonCode≠no_session 才显示，.off 无明细） |
| F2-1 本轮变更文件标签 | ✅ | 轮末「本轮变更 qa-note-20261029.md」chip；路径来自写类工具落盘（编辑文件 /data/panzj/qa-note-20261029.md） |
| F2-2 行内代码→下载链接 | ✅ | 回复正文行内代码 `/data/panzj/qa-note-20261029.md` 渲染为 `.dsh-change-link`；点击开侧栏预览页签（行为符合 F1-3 设计；预览 404 见环境备注③） |
| F1-1 右侧栏框架 | ❌ **BUG-2** | 详见下文；数据/逻辑在跑，视觉永远不可见 |
| F1-2 文件页签目录树 | ✅*/❌ | 首开路径正常：根目录 `/root 来源：节点默认目录`、懒加载 104 项、行内 @/👁/⬇/🗑、目录展开、MD 预览（渲染+源码切换）；但重挂载场景被 BUG-2c 连带破坏 |
| F1-3 变更页签 | ✅* | 按轮分组「08:09 · 🤖 KB 136 环境 · 主会话」+ ●修改标记 + 文件路径；点击开 viaTask 预览（同样受 BUG-2 遮蔽） |
| F3-1 输入框📎标签 | ✅ | 树内点 @ → 输入框上方 `📎 report_flow_order.md ✕` 可移除标签；发送时 `composeOutgoingText` 展开为相对路径（`请分析这个文件\nreport_flow_order.md` 实测）；**拖放上传不可用（BUG-2c 连带）** |
| S2-1 Token 按成员拆分 | ⚠️ | 面板「按成员」行 ✓（`主会话 · 🖥 KB 136 环境-DSH 77K tok · 命中 93%`）；`/api/usage/tokens/records?taskId=` 返回正常；但「查看本任务明细」弹窗 **BUG-1 卡死** |
| S2-2 逐轮用量胶囊 | ✅ | 轮尾 `🗄 26.2K · ⏱ 5.7秒`；点开「本轮用量」：输入（未命中缓存）395 / 输出 73 / 缓存读 25,728 / 缓存写 0 / 合计 26,196 / 命中率 98% / 本轮时长 5.7秒 |
| P1-1 头部只读标签+⋯菜单 | ✅ | 无节点下拉；`#chat-place` 只读标签悬停=工作区/节点+在线状态/默认模型/「执行位置随任务锁定」；⋯菜单：单独任务=「↪ 在其他节点继续…」，项目任务另有「📁 工作区文件」「⚙ 项目配置」（原横幅入口）；无项目横幅 |
| P1-2 离线禁用+离线条 | ✅ | 模拟离线：body.node-offline、输入框+发送禁用、红条「🖥 ×× 当前离线…」+「重试连接/在其他节点继续 →」；重试走真实探活（refreshNodeEngines）恢复在线并自动收条 |
| P2-1 两层执行位置选择框 | ✅ | 节点层：在线点+引擎徽标（DSH/ZCode/引擎?）+默认模型+「N 个项目 ›」；项目层：返回头+「不使用项目（单独任务）」+11 项目带工作区路径；「离线节点也可选」提示；选定后按钮/侧栏草稿行同步 |
| P2-2 空白新任务草稿态 | ✅ | ＋新建任务 → 纯前端草稿（state.draft、侧栏「新任务（草稿）」行、欢迎页文案「发送第一条消息时才创建任务」）；**0 个** POST /tasks；首条消息一次 POST 创建+发送（input.message），标题自动生成、草稿行消失；组内「＋」可带位置建草稿（位置记忆生效） |
| P3-1 侧栏分组+项目模式退役 | ✅ | 每项目一组「📦 名 · 🖥 节点」+ 每节点「🖥 ×× 单独任务」，活跃组靠前、组内 5 条+显示更多、组「＋」建草稿、搜索平铺、归档恒末组；无 enterProject/exitProject、无横幅 |
| P4-1 fork API | ✅ | `POST /tasks/:id/fork`（body.nodeRef 指定目标节点）：返回新任务+draft；新任务 `forkedFrom`/原任务 `forks[]` 双向链接；原任务侧栏行显示「已在 6cc2987d 续接 → task-1d94d4b9」 |
| P4-2 前端跨节点续接 | ✅ | ⋯「↪ 在其他节点继续…」→ 选择框**预填当前节点** → fork → 打开新任务+输入框带入最近对话原文（不自动发送，提示条说明）+「↪ 续自《…》」面包屑。实测用它在 31789 空流故障时切到 KB136 完成任务——真实故障场景下好用 |
| P5-1 @ 菜单执行位置 | ✅ | 子智能体「🤖 名 🖥 节点 · 模型」（同一节点不同智能体各显其模型）；专家「专家 · 分区 · 在本任务节点执行」；项目「📦 节点 · 在线」 |
| P5-2 抽屉/定时任务复用选择框 | ✅ | 抽屉 `#ag-place`（nodeOnly：7 节点 0 项目层）+模型输入 datalist=节点目录 34 项+目录外警告「⚠️ …不在该节点目录内…」；定时任务 `#sc-place`（nodeOnly）+模型首项「跟随节点默认（无人值守任务建议固定模型）」+hint 注明目录来源；原 `#ag-dsh`/`#sc-node` 直连下拉按设计保留 |

\* = 在 BUG-2 显示补丁（`.ws-side.on{display:flex}` 临时注入）下验证——功能逻辑本身可用。

## BUG 清单（含行级根因与修复建议）

### BUG-1（中，S2-1）：「查看本任务明细」弹窗永远卡在「加载中…」

- 现象：Token 面板 →「查看本任务明细 →」→ 弹窗停在 `加载中…`，接口 `/api/usage/tokens/records?taskId=` 实际 200 且有数据。截图 `04-bug1-token-detail-modal-stuck.jpg`。
- 根因：`openTaskUsageReport()`（src/web-ui.ts:9605-9617）假设 `openModal(...)` 返回 `{body}`，但 **`openModal()`（14104 行）从不 return**（纯副作用）。`m.body.innerHTML` 抛 `TypeError: Cannot read properties of undefined (reading 'body')`，表格填充中断。
- 修复（二选一）：`openModal` 末尾加 `return { body: $('modal-body') };`（对既有调用方无影响）；或 openTaskUsageReport 改用 `$('modal-body')`。

### BUG-2（高，F1-1 阻塞）：工作区右侧栏在所有视口永远不可见

- 现象：点 📁 后 `#ws-side` 有 `on` 类、内容照常渲染进 DOM（树/变更/预览都能通过 DOM 断言），但 computed `display:none`，宽度 0——桌面与 ≤768px 媒体查询下都不可见。用户感知为「点 📁 没反应」。
- 根因：CSS 只有 `.ws-side { …; display:none; … }`（1536 行）与 ≤768px 的 `position:absolute` 覆盖（1603 行），**没有任何规则在 `.on` 时把 display 打开**。CSSOM 实测仅一条 `.ws-side` 规则命中。
- 修复：补一条 `.ws-side.on { display: flex; }`。

### BUG-2c（高，F1-2/F3-1 连带）：`wsFilesRenderAll` 引用未定义变量 `tree` 抛 ReferenceError

- 现象链：文件页签重开/切换回来后树区空白；⟳ 刷新按钮点了没反应；拖放上传无效。首次打开路径正常（loadLevel 自带 renderTree + 行级监听）。
- 根因：`wsFilesRenderAll()`（src/web-ui.ts:10327）在绑定拖放处理时引用裸标识符 `tree`（10358 行起），但该函数只有 `const el = $('ws-files-root')`，`#ws-tree` 元素是 innerHTML 刚创建的、**没有赋给任何变量**；`tree` 仅在 `wsFilesRenderTree`（10244 行）的函数作用域里存在 → 每次运行到 10358 行抛 `ReferenceError: tree is not defined`，其后绑定（⟳ 刷新）与函数末尾的 `wsFilesRenderTree()` 全部不执行。在页面 evaluate 直接调用该函数可稳定复现同名报错。
- 修复：innerHTML 赋值后加 `const tree = $('ws-tree');`（拖放/刷新绑定与末次渲染随即恢复）。

> 三个 BUG 均为一行级修复；初测后已全部修复上线（见文末）。smoke/test:unit 全绿与此不矛盾——它们不覆盖浏览器 UI 层，正是 epic 已知限制（docs/feat-exec-place-ux.md「UI 行为无自动化浏览器测试」）。

### BUG-4（高，F1-2，BUG-2 修复后才暴露）：目录树复选框被全局 input 宽度规则拉满，文件名挤成 0 宽不可见

- 现象：侧栏显示修复后首次视觉检查发现，树行只见 ▸ 与勾选框、文件名全部不可见；DOM 里 `.ws-nm` 文本齐全但 offsetWidth=0（overflow:hidden），`.ws-chk` 被拉到 395px。
- 根因：131 行全局规则 `input, textarea, select { …; width:100% }` 命中行内勾选框；`.ws-chk { flex:none }`（1576 行）只禁 flex-grow，压不过显式 width。与归档页「flex 行内嵌 select 全局 width:100%」同款坑（第四次）。
- 修复：`.ws-chk { flex: none; width: auto; }`（1b913e3）。

## 修复与交付（2026-10-29 09:00–09:15）

四个修复各一行，两个 commit（`369e310` 三处 + `1b913e3` 复选框），已 push 到 feat/exec-place-ux 并经 `scripts/deploy-standalone.sh` 增量部署（两轮各仅 web-ui.js，远端备份/`node --check`/healthz/监控冒烟 31 项全过）。

**验证链**：build / typecheck / smoke 70 / test:unit 79 全绿 → 本地隔离实例（WORKBUDDY_HOME=/tmp，:3990）浏览器 8 断言（`.ws-side.on`→display:flex、openModal 返回 `{body}`、wsFilesRenderAll 无抛错/树渲染/dragover 高亮/drop 触发上传请求）→ 线上浏览器逐项复验：

| 修复 | 线上复验结果 |
|---|---|
| `.ws-side.on{display:flex}` | 点 📁 侧栏 420px 可见；部署后截图 `qa-20261029/06-sidebar-fixed-after-deploy.jpg` 树名/图标/勾选框全部正常 |
| `openModal` 返回 `{body}` | 「查看本任务明细」弹窗正常渲染逐轮表（时间|成员|模型|输入|输出|缓存读|合计；数据行 08:10 · KB 136 环境 · 主会话 · deepseek-v4-flash · 395/73/25728/468） |
| `const tree = $('ws-tree')` | 页签 files→changes→files 切回树自动渲染（修复前空白）；⟳ 刷新生效；dragover 高亮 ✓；**拖放上传 E2E：拖 `qa-drop-fix.txt` 到 /root/test 真实落盘**（/fs/list all=1 确认），验证后已删除清理 |
| `.ws-chk width:auto` | 勾选框 13px、文件名 341px 可见 |

复验备注：① 首轮部署后首开树区短暂为空——服务重启后 ONENAT 资源目录 ~1 分钟刷新窗口内 `/agents/fs/list` 解析失败的瞬时现象（wsTaskFileCtx 静默降级 root=''），手动重挂载即恢复，非修复回归；② 复验期间出现的「凭证获取失败（请求过于频繁）」为反复探活触发 ONENAT 凭证 5 次/分限速的已知自愈形态。

## 环境备注（非本次改造缺陷，跟进建议）

1. **公司笔记本-DSH:31789（0c93ebda）LLM 上游持续空流**：本轮两次任务均「远端流为空」自动重发仍空 → failed（与 10-28 已知形态一致）。QA 由此改走 P4-2 续接到 KB136。建议检查该节点上游通道。
2. **KB 136 环境（6cc2987d）文件路径语义**：智能体写文件报路径 `/data/panzj/qa-note-20261029.md`，但节点 /fs/list（/data/panzj、/root）均无此文件、/fs/download 404——疑 KB136 的 DSH 会话跑在容器/沙箱内，工具报路径与宿主文件系统不一致。F2/F1 的下载/预览通道因此 404（前端已如实显示「⚠️ 预览失败（HTTP 404）」）。建议在 KB136 上核实会话 cwd 与容器挂载。
3. **「统计不可用」无真实样本**：全部节点 /stats supported:true。该分支（unsupported/offline 灰胶囊）建议在节点下线或接入不支持 /stats 的引擎（pi-web-service 未来版本）时补测。
4. 顺带观察：S2-2「本轮用量」弹窗第 2 行「输出73 tok」标签与数值间缺空格（第 1 行「输入（未命中缓存）395 tok」格式正确），纯外观小疵。

## 测试留下的数据

- 新任务：`task-cc5ef31e`（31789，失败）与 `task-1d94d4b9`（fork→KB136，完成，task.model=deepseek-official/deepseek-v4-flash），标题均含 qa-note-20261029 可辨识。
- KB136 节点文件系统无测试残留（写文件未落到宿主，见备注②）；无其他写入。
