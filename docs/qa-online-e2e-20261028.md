# QA：全功能在线测试与修复 —— ego-lite 真实浏览器（v2026.10.28）

- 日期：2026-10-28
- 对象：线上 `https://natpass.yikaihui.com/onenat-workbuddy`（部署基线 v2026.10.26 / a396a23，含在途 ⌘K 特性——与本地工作区 dist md5 一致确认）
- 方式：ego-lite（Chromium 真实浏览器）按 `docs/qa-feature-inventory.md` 全清单逐模块在线走查 + AI token REST / MCP 通道 API 面测试
- 测试账号：`wb-qa`（本次经服务端 dist/auth.js 追加的 QA 管理员，auth.json 有备份，存量用户未动；保留供后续回归复用）
- 脚本目录：`~/ego/wb-online-qa-20261027/`（round-01 ~ round-19）
- 结果：**v2026.10.28 已部署上线**（4 dist 文件 md5 本地/远端对齐），5 个 BUG 修复 + 3 项交互优化，全部线上回归通过

## 测试覆盖（28 节清单）

| 模块 | 结果 | 说明 |
|---|---|---|
| §1 登录/账号 | ✅ | wb-qa 真实登录；错误提示、重定向正常 |
| §2 全局导航 | ✅ | 12 视图切换、hash 记忆（含带参 hash，见 BUG4）、更多菜单外点/Esc 关闭 |
| §3 会话侧栏 | ✅ | 一键新建、重命名（modal）、搜索/清空、分组折叠、归档↔恢复、「管理」跳转 |
| §4 会话主体 | ✅ | 工具栏四键、路由徽标、节点/主智能体选择器、轨迹 tab、任务详情弹窗 |
| §5 输入区 | ✅ | @联想（五类候选）、运行配置弹层、模型弹层（分组/目录外守卫）；/技能浮层=节点 supported:false 正确隐藏（见优化③） |
| §6 协作能力 | ✅ | 目标创建/清除闭环（pi 节点 supported:true）、权限弹层 11 档回显、计划模式 PUT 降级语义（见优化②） |
| §10 项目 | ✅ | 新建（modal）/编辑/归档/恢复/成员（owner 回显）/删除 全流程 |
| §12 子智能体 | ✅ | 抽屉（7 节点下拉+直连）、创建、Ping 探活、模型/预设按节点、卡片操作全集、删除 |
| §13 专家/团队 | ✅ | 329 位名册、用户自建 source:user、内置只读、删除；6 团队、团队抽屉 |
| §14 技能/插件库 | ✅ | 插件清单制导入弹层（节点+目标 AGENT 两段式）、上传/导入/安装记录 UI |
| §15 资源目录 | ✅ | 9 映射快照、引擎探测（dsh/zcode/pi 识别）、类型/入口/技能列 |
| §16 文件管理 | ✅ | 38 行列表、全操作按钮组；fs mkdir/list/remove API 全链路（KB136 节点实测） |
| §17 定时任务 | ✅ | 模板区、任务卡、详情/编辑抽屉（sc-* 字段 + 技能勾选） |
| §18 监控大屏 | ✅ | 内嵌版 KPI/任务详情弹窗；独立投屏页（时钟/7 KPI/feed/MCP 输入/全屏） |
| §19 语音助手 | ✅ | 接入点列表（真实小智端点）、添加弹窗 |
| §20 归档管理 | ✅ | 自动归档档位、搜索/排序、全部删除（confirm） |
| §21 设置页 | ✅ | ONENAT/用户管理（8 行）/审计日志/AI 接入；SSH 资源池为本轮补齐（BUG3） |
| §22 移动端 | ✅ | 390×844：输入 16px、侧栏抽屉+遮罩、mention 全宽 366/390 |
| §23 API 面 | ✅ | AI token：监控/工具/定时/项目/任务 200，users/audit 403 fail-closed；401/404 语义正确 |
| §24 MCP | ✅ | initialize→session→initialized 202→14 工具→tools/call(7.3KB overview)→prompts 空集→DELETE 204→status |
| §25 技能资产 | ✅ | 7 个安装端点 200、skills.json 6 文件、路径穿越探测 401 |
| §26-28 后台机制 | ✅ | 31 项部署冒烟随 deploy-standalone.sh 全过（调度/监控/事件落盘） |

排除的误报：右侧半截「交」浮块 = 浏览器 KISS Translator 扩展注入（kiss-translator-fab），非应用元素。

## 修复的 BUG（均已上线回归）

1. **task_end SSE 处理器 `ev` 未定义**（web-ui.ts）：`const ev` 声明在 try 块内、try 外引用 → 每次任务结束必抛 `Uncaught ReferenceError`，停止键无法收起、`markTrajDirty()` 失效。修复：提升声明 + 空值防护。回归：整轮周期零错误、停止键正常收起。
2. **正文双份入库**（engine.ts + remote-client.ts）：pi-web-service 流不发 `turn_end`（connected→delta→done）→「空回合自愈」守卫只看 `streamSeq>1` 不看内容 → 单 delta 短回复被误判空而重发 → 第二次派发后历史对账把两轮 assistant 拼成「好的好的」。修复：重发守卫补 `result.content` 判空。回归：回复「明白」「收到」均单份。
3. **SSH 资源池管理 UI 缺失**（web-ui.ts）：后端 CRUD/test/exec 全有、清单 §21 明确「设置区」，前端从未实现。补齐：设置页管理员卡（脱敏列表 hasPassword/hasPrivateKey、新增/编辑、真实连接测试、远程执行输出 exitCode/stdout/stderr、删除）。回归：建→测（127.0.0.1:22 通过）→删，凭证不回传。
4. **hash 携带查询参数解析失败**（web-ui.ts）：`#monitor?from=share` 找 `view-monitor?from=share` 落空 → 停在工作台。修复：hash 段 `split('?')` 后取视图名（boot 初始 + hashchange 两处）。回归：`#monitor?r=` 直达监控。
5. **OPTIONS 预检被 401 拦截**（server.ts）：访问控制门禁在 router.dispatch 之前且未豁免预检 → 无登录态跨域浏览器无法预检（与「CORS 全开 204」文档语义相悖）。修复：门禁条件加 `method !== 'OPTIONS'`。回归：线上 OPTIONS → 204 + 三 CORS 头。

## UI 交互优化

1. **Esc 统一收起 composer 三个下拉**（模型/主智能体/节点）——与导航「更多」菜单行为一致。
2. **计划模式 PUT 不支持时 sticky 隐藏入口**——修掉「GET 报 supported:true、PUT 才暴露不支持」导致的「点击失败→按钮又回来」循环（pi 节点实测）。
3. **done 帧快速对账**（remote-client streamDone + engine 分支）：流以 done 正常收尾且已有内容时立即回查历史重建整轮，不再进 15s 间隔长轮询——pi 类节点每轮回复快 ~15s（实测 18s→~4s 量级）。
4. `/` 技能浮层在节点不支持技能目录时键入零反馈——保留现行为（有匹配才显示），已在测试中确认为 supported:false 的正常降级；如需提示语可作为后续小改进。

## 已知瞬时现象（非 bug）

- 服务重启后首次派发若恰逢 ONENAT 凭证接口 5 次/分限速窗口，会以「任务节点不可达：Unauthorized」系统消息诚实落账，凭证缓存回填后自愈（实测一轮后正常）。

## 测试资产清理

- 已删：测试会话 `qa-e2e-侧栏流程测试`（级联远端会话）、本地 pi 实验 session、KB136 `/tmp/qa-e2e-dir-x9`。
- 保留：`wb-qa` / `WbQa2026x` QA 管理员（auth.json 备份 `auth.json.bak-qa-*` 在服务器数据目录）、`~/ego/wb-online-qa-20261027/` 全部脚本与截图。
