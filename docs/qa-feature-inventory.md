# OneNat WorkBuddy Web — 测试功能点清单

> **用途**：全量功能点盘点，供测试规划用（不含测试用例/步骤）。
> **基线**：v2026.10.26（package.json），commit `a396a23`，清点日 2026-10-27。
> **范围**：本仓库（web 服务端 + 内嵌前端）。安卓客户端、DSH/ZCode 节点本体不在本清单内。
> **阅读方式**：按页面/模块分组，功能点一条一行。「后台机制」部分盘点的是对测试可见的引擎/平台行为点。

---

## 1. 登录与账号体系（登录页 / 邀请页 / 鉴权）

- 登录页：用户名+密码表单、输错提示、429 限流提示、登录成功带 hash 重定向
- 登录安全：单 IP 5 分钟 10 次失败限速（429）、登录失败 400ms 人为延迟防爆破、异步 scrypt 校验
- 会话管理：HttpOnly Cookie（wb_session，7 天滑动有效期）；禁用/删除/改密用户会话即时失效
- 忘记密码：入口折叠框→申请重置邮件；恒定响应防邮箱枚举；重置邮件（24h token）；重置成功跳登录
- 密码重置页（/reset）：按 token 重置、新密码校验、重置后吊销该账号全部会话
- 用户邀请接受页（/invite）：回显邮箱/有效期；密码规则校验；激活即自动登录；重复激活/过期处理
- 项目邀请页（/project-invite）：回显项目/邀请人/角色；登录态四分支（本人直接接受 / 换号提示 / 已实测 提示登录 / 未注册一步设置密码建号入项）；可拒绝邀请；项目已归档提示
- 修改密码：≥6 位校验，成功后强制重新登录
- 首次启动播种默认管理员（workbuddy / workbuddy-admin）
- 密码策略：邀请激活 ≥8 位字母+数字；本人改密 ≥6 位
- 公开免登录面：/healthz、登录/邀请/重置端点与页面、安装资源（install-skill.sh / wb.mjs / SKILL.md 等）、带签名 token 的库文件下载与项目导入回调

## 2. 全局导航与顶栏

- 顶层页签：工作台、项目、监控大屏、子智能体
- 「更多」折叠菜单：资源目录、技能库、插件库、语音助手、定时任务、文件管理、专家管理、归档管理、设置
- 页签 hash 记忆（#monitor 等），刷新/重登不丢
- 顶栏 ONENAT 连接状态 chip（资源数/DSH 数/会话过期提示）
- 顶栏版本 chip（版本号 API 兜底显示）
- 退出登录
- 多点下拉：菜单外点击关闭、Esc 关闭
- 全局弹层基础设施：modal 弹窗、drawer 抽屉（带返回栈）、toast 气泡、复制按钮 ✓ 反馈
- 通用远端目录浏览器弹窗：主目录直跳、路径输入直跳、上级、隐藏文件显示、新建文件夹、使用此目录回填（项目/子智能体/定时任务三处共用）
- 静默轮询防抖：2.5s 节流、并发互斥、失败自愈重试（8s 间隔）

## 3. 工作台 — 会话列表侧栏

- ＋新建任务（一键建会话直接开聊，无弹窗；项目工作台内自动继承项目配置）
- 会话搜索（标题/最新内容过滤、一键清空）
- 时间分组：今天 / 前 7 天 / 更早 / 已归档；分组折叠展开、计数、「管理」跳归档页
- 会话条目：运行状态点、标题、最新内容预览（成员名/时间）、悬停操作（重命名/归档↔取消归档/删除）、点击打开
- 项目工作台模式：仅显示本项目任务、空态文案区分、签名比对避免整列重建（保留滚动位置）
- 移动端侧栏变抽屉（☰ 开关、遮罩关闭、选中自动收起）

## 4. 工作台 — 聊天会话主体

- 会话标题：双击重命名 / ✏️重命名按钮
- 🎯长期目标入口、📋计划模式开关（进/出/计划中状态）、🗜压缩对话（确认弹窗）、🔒运行权限切换（沙箱/审批）
- 路由徽标：🚀协同编排 / 💬直通对话 / 🎯定向直通；当前目标徽标
- 节点选择器：按隧道（机器）分组列 DSH 节点；DSH/ZCode 引擎徽标、健康探测点、默认模型、错误提示；选择后同步新任务环境、localStorage 记忆、联动刷新模型目录；不可达默认节点自动校正
- 主智能体选择器：切换主调度智能体+会话成员账本同步
- 空态欢迎卡 + 6 张快捷入口卡（监控/子智能体/语音/定时/资源/文件，直跳）
- 用户消息气泡：Markdown 渲染、时间、复制
- 助手流式渲染：思考折叠行→工具行→正文块按到达顺序交错；「深度求索中...」15 秒后出现计时钟
- 思考块：折叠/展开、运行中扫光动效、摘要跟随最后一行
- 工具行：按工具名分派图标/标题（运行命令/编辑文件/读取文件/搜索文件/访问网页/任务清单/询问用户/调用工具）、状态点（运行/失败）、折叠摘要、展开 IN/OUT 参数卡
- ask_user 提问卡：多问题渲染、单选/多选、选项描述、自定义回答输入、跳过、提交答复；已答复回显/失效判定；幽灵卡（无效调用）禁交互
- 编排计划卡：策略标签（DAG/顺序/并行）、子任务数、专家团徽标、成员泳道（主调度+成员+职责+节点）、依赖标注、未分配泳道；实时 plan_update/subtask_status 刷新
- 排队消息：⏳排队 pill、⚡立即发送（运行中=插话 steer / 空闲=立即派发）、编辑/删除排队消息
- 轮脚注：复制、成员·模型标签、时间、用量 pill（总 token + 缓存命中率）
- 历史分块加载：初始 30 条 + 顶部「加载更早 N 条」
- 消息内 @文件路径 自动转 📎 附件下载链接
- 回到底部悬浮按钮（智能跟随滚动）
- 任务统计条：轮数/步数、LLM/工具耗时、首 token 均值、decode 速率、缓存命中 %、输入/输出 token（5s 轮询 + SSE 刷新）
- 任务清单坞（todo-dock）：远端 todo_write 投影、进度计数、运行/上轮时长本地递增、三态图标、折叠记忆、3s 轮询
- 会话模型信息回显（模型/推理等级/模式预设）
- 会话技能目录预热（「/」候选）
- 会话内视图切换 tab：对话 / 轨迹
- SSE 实时通道事件全集：turn_start（补发/插话对账）、turn_delta（文本流）、turn_reasoning（思考流）、turn_tool（工具上/下线）、turn_usage（用量徽标）、turn_end（收敛终态 Markdown）、plan_update、subtask_status、log（轨迹账本）、task_status（运行态）、task_end（清理/止停键/协作能力重探测）；断线重连后 resync 回源补齐（防半截气泡）
- 心跳与重连：15s 心跳、断线自动重连

## 5. 工作台 — 消息输入区

- @ 提及联想浮层：候选五类（项目/专家团/专家/子智能体/资源）、前缀+子串过滤、↑↓选择、Tab/Enter 插入、专家 `#id` 精确直派、点击插入、中文输入法 Enter 保护
- / 技能联想浮层：会话技能目录、描述与可用成员、仅模型标记、词边界检测（排除 URL 文本）
- 附件上传：＋按钮+文件多选、输入框拖拽/粘贴自动上传
- P2P 直传：分片上传（内网优先/公网兜底）、断点续传、进度面板（每文件进度条/已同步成员数/失败重试按钮）、完成后路径自动回填输入框
- 运行配置弹层：①默认协作成员 chips ②执行节点/工作区（项目锁定只读）③连接器勾选（SSH 池/HTTP 映射）④技能输入 ⑤调度模型展示；非项目可「保存为新任务环境」
- 模型选择弹层：主调度+执行会话模型按 provider 分组、点选即生效、推理等级（efforts）切换、模式预设（presets）、目录外已保存模型提示与守卫（MODEL_NOT_IN_CATALOG）、跨节点换目录、错误回滚
- 发送键常驻（运行中=排队补充意见）、停止键运行中显示（取消任务）
- composer 顶部一行操作提示（淡出小字 hint）

## 6. 会话协作能力（长期目标 / 计划模式 / 压缩 / 运行权限）

- 长期目标：创建（描述+续跑轮数上限）、查看（状态/已推进轮数）、修改、标记完成、暂停/恢复推进、标记受阻（原因）、停止自动续跑+恢复、清除
- 计划模式：开关进出、状态检测（计划中 disabled）
- 压缩对话：确认弹窗、手动压缩远端会话历史
- 运行权限对话框：三档预设单选（只读 / 工作区可写 / 完全访问）、当前生效回显、应用实时下发所有会话
- 权限矩阵：任务级 > agent 级 > 默认；旧节点降级为提示词注入

## 7. LLM 编排与子任务

- 编排触发：@多成员消息→LLM 拆解为 DAG/顺序/并行子任务图
- 规划流式呈现：思考增量实时进规划气泡、规划等待动效
- 计划卡实时刷新：子任务状态机（待执行/执行中/成功/失败）
- 成员泳道与节点归属展示；依赖标注
- 子任务操作：日志抽屉（工作日志+最终产出 Markdown）、远端会话抽屉（消息回放+追问 followup）、失败「重试」
- 编排汇总：LLM 综合汇总评估；成员返回覆盖度（complete/partial/failed+缺口归因）；结论卡片
- 编排护栏（测试可见行为）：被 @ 成员人人有子任务、指令不混入其他成员名、主智能体至少留 1 个子任务、违规→纠正重规划一次、再违规带告警放行
- 防递归：成员指令剥离 @提及/引擎段头伪造/UPSTALL 围栏，补编排声明
- 上游产出注入：依赖子任务接收上游摘要（2000 字/单、12000 字/总截断）
- 无 @ 追问：编排后备注入上轮汇总+覆盖度上下文
- 子智能体执行失败/规划器不可达的静态兜底方案（≤3 成员统一执行指令）
- 任务取消：本地中止+远端会话取消（子任务+全部会话）+挂起问答自动解挂
- 子任务会话在任务节点上的动态专家实例化（@专家/@团队 → 临时 agent，用完即散）

## 8. 附件与文件跨节点引用

- 附件扇出上传：multipart 投递到所有目标成员节点
- P2P 直传控制面：init（下发节点地址+密钥+分片端点模板+内网基址）、register（登记落盘+跨节点下载 URL）、relay（HTTPS 混合内容场景裸流代理，4MB 分片背压）
- 大文件流程引导（draft 首消息带 2G 大文件流程教学）
- @文件路径解析：本地路径替换 / 远程下载 URL+curl 指引；@智能体 触发项目工作区跨机访问指引（fs/download、fs/list 教程）
- 文件下载代理：绝对路径→cwd 相对化、流式下载

## 9. 轨迹视图（会话 trajectory）

- 工具栏：时长模式切换（实际时长/等宽序列）、收起/展开所有轮次、收起/展开所有调用、搜索（命中计数、未命中淡出）
- 时间线：输入/模型/工具三泳道、轮次边界、span 悬停提示、点击选中、拖拽框选聚焦、单击清除
- 事件账本表：事件行（类型标签 user/system/log/message/tool/subtool、错误态）、请求累计 token、缓存 token 行
- 事件详情抽屉：概览/用量/预览/负载/结果/时序/原始 JSON 多 tab；来源（成员+模型）、思考摘录、Markdown 预览
- 任务级日志流入账本（SSE log 事件）

## 10. 项目管理

- 项目列表：搜索（名称/工作区路径）、环境筛选 chips、节点拓扑星型图（≥2 环境：ONENAT 网关中心、环境节点健康度点/资源类型色环/实体数角标、点击筛选、图例）
- 项目卡：名称、工作区、任务数、☁云端导入标记、指令预览、成员/技能/连接器 chips
- 项目卡操作：进入工作台、⚙编辑、📋复制、🗑删除
- 新建/编辑抽屉：名称、DSH 节点（按隧道分组）、📁浏览节点目录选工作区、项目指令（注入提示词）、默认协作成员、连接器勾选、技能勾选（节点已装）
- 项目成员管理：成员 chips+角色角标、升/降 owner、转让 owner、移除成员、添加已激活用户（搜索）、保底 1 名 owner 校验
- 项目成员邀请：邮件邀请（邮箱+角色、未注册一步注册入项）、SMTP 状态提示、重发/撤销邀请
- 项目归档/恢复（归档=只读，confirm 警告）
- 从远程 DSH 导入项目：选节点→拉工作区列表→勾选→发分析任务→3 秒倒计时自动跳工作台/留页轮询到货 toast
- 项目导入幂等：一次性导入令牌（2h）、防串号 409、agent 回调建项目（平台 API 自动建档）
- owner 转让（原 owner 降级 member）

## 11. 项目工作台与工作区文件

- 项目横幅：📦项目名、继承说明、📁工作区文件、⚙项目配置、退出项目；隐藏节点切换器
- 工作区文件抽屉：面包屑（工作区根）、搜索、显示隐藏项、刷新
- 上传（按钮+拖拽）、新建文件夹
- 批量操作：全选、批量@引用（相对路径回填对话）、批量下载、批量删除
- 每行操作：@文件引用、👁预览、⬇下载、🗑删除、目录进入
- 文件预览（通用）：图片/Markdown 渲染/代码、渲染↔源码切换、@文件 引用到对话、复制、下载、←返回
- 无工作区引导去配置

## 12. 子智能体管理

- ＋新建子智能体
- 环境拓扑星型图 + 环境筛选 chips + 搜索（名称/模型/描述）
- 按环境（机器/隧道）分组卡片、在线/离线计数、执行中药丸、分组折叠记忆
- 智能体卡：live 状态点（执行中动画/停用/离线/在线）、角色/预设/模型/工作目录/技能数 tags、当前活动、错误行、DSH 实体与资源清单
- 卡操作：🚀进入工作台（切节点）、编辑、📋复制、Ping 探活、提示词预览（脱敏+警告）、🎯技能、删除
- 新建/编辑抽屉：名称、🎓从专家库选择（名册筛选/搜索、预填人格+提示词、来源快照记录）、DSH 实体（映射/直连手输）、↻同步远端选项（预设/Provider/模型联动下拉、推理强度随模型显示隐藏）、工作目录+📁浏览、专家角色 role、系统提示词、执行提示词
- 资源绑定列表：资源选择/别名/凭证注入方式（self-fetch/inline/omit）、技能注入（all/none/指定）、用途说明、移除
- 技能中心抽屉：节点技能列表、上传压缩包安装、勾选绑定（≤20）、SKILL.md 预览、下载包、删除、保存绑定
- 智能体模型目录/模式预设按节点拉取（未保存智能体也可直接按节点取）
- 专家档案实例化成子智能体（fromExpertId 预填 + expertSource 服务端校验）
- 删除级联：从任务/定时任务/团队成员中自动摘除
- 启用/停用

## 13. 专家管理 / 专家团

- ＋新建专家；分区下拉筛选、搜索（名称/简介/标签）、计数、刷新
- 专家表：图标/名称/ID、分区、来源（内置/名册/用户）、标签、简介
- 操作：查看/编辑/删除（仅用户自建可写，内置/名册只读）
- 专家弹窗：id/展示名/emoji/分区/角色名/标签/简介/职责约束 systemPrompt/执行指导 executionPrompt
- 🧩专家团：卡片（内置/启停 tags、目标/交付要求、成员 chips 带职责）
- 团队操作：🚀发任务（一键建团队任务含当前节点）、📋复制为自定义、编辑、启停、删除
- 新建专家团抽屉：名称/简介/共同目标/共同约束/交付要求/主理人模板（通用/产品/技术/内容/数据/研究 6 类）、成员列表（子智能体↔专家库切换、职责分工、执行指示、2~8 人校验、重复成员校验）、主理人补充规则
- 5 内置团队（只读）：产品方案评审团/技术方案评审团/内容选题策划团/数据分析诊断团/专题研究专家团
- @提及解析语义：@项目/@专家团/@专家（即时#id 直派）/@智能体/@资源/@文件；同名歧义拒绝；环境名精确匹配

## 14. 技能库 / 插件库（两独立页）

- 库列表：名称/版本/描述/大小/上传时间、来源（手动上传/导入自节点）、插件家族徽标（DSH/ZCODE）
- 操作：安装/⬇下载/🚮删除
- 安装：勾选目标 DSH 主节点（可全选）、逐节点发起主会话安装任务、结果（成功任务 ID/派发失败）
- 安装记录区：名称/时间/目标节点/每节点状态 chips（成功/失败/执行中）、刷新
- ＋上传压缩包（zip/tgz 多文件，≤200MB、文件名防路径注入）
- ⬇技能导入自节点：拉已装技能清单勾选导入、已在库禁选
- ⬇插件导入自节点：清单制两段式（按节点+目标 AGENT 家族过滤、勾选派发导出任务、轮询回拉入库）；兜底全量导出流程
- 平台公网地址设置（下载链接基址 publicBaseUrl，留空自动推断）
- 库文件签名下载：HMAC token 30 分钟有效，供无登录态 DSH 节点拉包
- 安装提示词模板自检汇报（curl 下载→解压→装到技能目录→语义自检）
- 库说明条 + 使用说明

## 15. 资源目录

- 资源快照表：按隧道分组、资源名（在线点）+ 类型 tag（ssh/dsh/http/tcp）+ 公网入口（SSH 命令/HTTP URL）+ 内网目标 + 绑定技能清单
- ↻ 强制刷新（重拉 ONENAT 目录）
- 资源自动刷新（60s 周期）+ 快照缓存
- DSH 映射探引擎：身份/版本/健康/默认模型探测（DSH/ZCode 识别）、按节点模型目录
- 映射凭证：凭证接口拉取、限速退避、最后成功值回落

## 16. 文件管理页（远程工作空间）

- 智能体下拉（附工作目录名）
- 面包屑、搜索、隐藏项开关、刷新、上传、新建文件夹
- 批量：已选计数、批量 @引用（@智能体:路径 回填对话）、批量下载（防同名）、批量删除（confirm）、取消
- 全选/多选；文件表：图标分类、名称、大小、修改时间
- 每行：@文件、👁预览、⬇下载、🗑删除
- 拖拽上传
- 目录计数与当前路径展示
- 底层文件面：远端 list/mkdir/upload/download/remove（agent 或 node 二选一寻址）

## 17. 定时任务

- ＋新建定时任务；模板区一键预填（4 内置模板：晨会动态/风险扫描/发布简报/文档同步检查）
- 任务卡：启停状态、规则文案（自然语言）、节点、工作目录、技能数、目标智能体、备注 tags
- 任务文本预览、上次/下次触发、已运行次数、派发成功率
- 操作：详情、编辑、📋复制、Ping 探活、提示词预览（合成资源提示词弹窗）、▶立即执行、停用/启用、删除
- 新建/编辑抽屉：标题、执行节点、执行模型（按节点拉取）、📁浏览工作目录、技能绑定勾选（≤8）
- 调度类型六种：每天（times 数组）/每周（星期+时刻）/每小时/每月（日期+时刻，非法日校验顺延）/间隔/一次性（可多选时刻）、规则预览文案
- 指令 textarea：@ 联想、专家快捷 chips 插入、备注
- 详情抽屉：基本信息 tab（全量字段+任务文本+立即执行/停用）+ 执行记录 tab（每次触发：手动/定时、耗时、每个子智能体派发状态与失败原因重试次数、「会话 →」跳转、5s 自动刷新）
- 实例级配置：nodeMappingId/model/workDir/skills 随派发任务持久化（任务 ⏰ 标识）
- 手动触发 3 秒去重、自动触发防重入、派发失败重试 1 次（2s 延迟）
- once 触发后自动停用；错过触发点不补跑跳下一个未来点

## 18. 监控大屏（内嵌 view-monitor + 独立投屏 /monitor）

- 内嵌版：5s 自动刷新+更新时间、投屏页按钮
- 7 张 KPI 卡：在线智能体（执行中/停用副注）、运行中任务、今日完成、今日失败、今日 Token（缓存副注）、今日工具调用、下次定时（倒计时+任务名）
- 节点主会话列表：在线/离线/空闲/执行中×N、当前活动、累计任务 chips、点击任务详情弹窗
- 子智能体列表：busy 置顶、活性 live 条（工具名/思考中/当前 todo/进度条）、绑定资源 chips（🔥使用中/⚠离线）、点击智能体详情抽屉（资源在用清单+任务跳转）
- 任务会话列表：运行前置顶、类型图标（⏰定时/🎯编排/💬直通）、耗时、状态徽标（⏳等待答复/部分成功/草稿）、当前步骤/子任务进度、进度条、点击任务详情
- 任务详情弹窗：状态、编排计划、汇总结论、最近 20 轮对话回放、工具执行中提示
- 实时动态 feed（80 条、事件类型图标、错误/警告着色）
- 资源调用列（绑定资源在用任务、SSH 池）
- 24 小时趋势 SVG 线图（运行中/今日完成累计/失败累计，60s 拉快照历史）
- 投屏页（独立全屏）：连接状态 chip、时钟、⛶全屏、版本；6 张大字号 KPI；三栏（节点/子智能体/任务会话）；实时 feed（悬停展开多行）；近 24h 任务趋势 + Token 消耗 SVG；定时任务条（下次触发倒计时、上次失败标红）
- 投屏底部 MCP 双向输入：聚焦目标任务（点任务卡🎯）、无目标=建任务、`/workbuddy_xxx {JSON}`=直调工具、🧰工具面板（tools/list 浏览、点击回填、参数提示）、执行日志卡（保留 30 条）
- 监控数据：事件环形缓冲 500 条/按天 JSONL 落盘/重启回读 2 天；小时快照保留 30 天回看多天
- 工具参数脱敏（sshpass/token/Bearer 等 5 种规则，投屏安全）
- 告警聚合：agent 离线、失败任务按标题聚合、调度失败

## 19. 语音助手（小智平台接入）

- ＋添加接入点弹窗：名称+wss 接入点地址，保存即连
- 接入点列表（5s 轮询）：连接状态点（已连接/重连中/停用）
- 诊断信息悬停：调用/失败/回包丢弃/幂等命中/超大结果/断线原因/最近调用
- 启停、删除
- 双向 MCP：应答平台 initialize/ping/tools/list/tools/call； 断线 1s→60s 指数退避重连

## 20. 归档管理

- 自动归档开关 + 保留时长档位（3/7/14/30/90/180/365 天+自定义），关闭记忆上次时长
- 已归档会话搜索（标题/最新内容）、排序（更新时间/归档时间/标题）、项目筛选（所有/未分组/按项目）
- 按项目分组折叠：组头计数、▶恢复↩ / 🗑删除 / ⠇更多（按 ids 批量操作）
- 会话行：状态点、标题/预览、归档时间、逐条取消归档/删除
- 全部删除（总开关、confirm）
- 后台自动归档：终态任务超保留期自动归档+骨架化（turns/taskLogs 移入归档文件）、启动重水合、touch 修改回全量；归档项目沿用三态语义（批量端点 restore/delete）

## 21. 设置页

- ONENAT 平台：Base URL / API Key / 自动刷新间隔（改后即时生效）
- 任务归档入口卡（跳归档管理）
- 用户管理（管理员）：SMTP 状态提示、＋邀请用户（邮箱+昵称→邮件/复制链接）— 4 ⚠️ 此两行与其他内容整合：用户表（角色/状态/最后登录，操作：重发邀请/撤销邀请/设为管理员/设为普通/禁用/启用/删除，软删除提示）；至少留 1 名启用管理员校验
- 邀请链接弹窗：72h 有效、邮件发送状态、复制链接
- 用户搜索（登录用户，加项目成员用，最小字段）
- 修改自己显示名
- 当前账号：登录名/角色/昵称编辑、修改密码（成功自动重登）
- 审计日志（管理员，最近 100 条）：时间/操作者/动作/对象/详情 — 覆盖邀请/入项/角色变更/禁用/归档等关键操作
- AI 接入卡：APIKEY 生成/重置（立即失效提示）、MCP 接口地址复制、专家库 MCP 地址、双通道路径安装提示词（自动合成、一键复制）、使用约定
- SSH 资源池管理（设置区）：SSH 资源 CRUD（列表脱敏只留 hasPassword/hasPrivateKey）、真实连接测试（TCP 可达+认证握手、缺依赖降级 TCP 结论）、远程批量执行 shell（stdout/stderr/exitCode、超时）

## 22. 移动端适配（≤768px）

- 侧栏转抽屉、导航短标签
- 输入框 16px（防 iOS 缩放）、发送/停止键方形
- mention/model 弹层全宽固定位、键盘弹出隐藏 Tab、触屏失焦保护、点图标按钮不落焦点

## 23. HTTP API 接口面（接口测试用）

> 前缀默认 `/onenat-workbuddy`，可 `--prefix` 改根路径。

### 鉴权 / 账号
- `POST /api/auth/login` 登录（限速）
- `POST /api/auth/logout` 登出
- `GET /api/auth/me` 当前用户
- `POST /api/auth/password` 改密
- `POST /api/auth/forgot-password` / `POST /api/auth/reset-password` 重置链路
- `GET|POST /api/invitations/:token` 邀请查看/接受
- `GET|POST /api/project-invitations/:token` + `POST .../decline` 项目邀请三面
- `GET /api/users` / `POST /api/users` 用户列表/建邀
- `GET /api/users/lookup`、`GET /api/users/mail-status` SMTP 状态
- `PUT /api/users/me/profile`、`PUT /api/users/:id`、`POST /api/users/:id/resend-invite|revoke-invite|disable|enable`、`DELETE /api/users/:id`
- `GET /api/audit-log` 审计查询（admin）

### 项目
- `GET|POST /api/projects`、`POST /api/projects/import`、`POST /api/projects/import-create`（token 回调）
- `GET|PUT|PATCH|DELETE /api/projects/:id`
- `GET|POST /api/projects/:id/members`、`PUT|DELETE .../members/:uid`
- `POST .../archive|restore`、`POST .../ownership-transfer`
- `GET|POST .../invitations`、`POST .../invitations/:invId/resend|revoke`

### 子智能体 / 专家 / 团队
- `GET|POST /api/agents`（upsert、fromExpertId、expertSource 校验）
- `GET|DELETE /api/agents/:id`、`POST /api/agents/:id/ping`
- `GET /api/agents/:id/models|presets`、`GET /api/agents/models?node=|presets?node=`
- `GET /api/agents/:id/prompt-preview`
- `GET|POST /api/teams`、`GET|DELETE /api/teams/:id`
- `GET /api/mentions/candidates`
- `POST /api/experts/:id/instantiate`、专家库 MCP（见 §24）

### 任务 / 会话
- `GET /api/tasks?projectId=`、`POST /api/tasks`（draft 201、归档项目拒绝）
- `GET /api/tasks/:id`（withLogs）、`PATCH|PUT`（成员/标题）、`DELETE`
- `POST /api/tasks/:id/messages`（202、teamId 团队意图）
- `POST .../cancel`、`/rename`、`/archive`、`body.archived`
- `POST /api/tasks/bulk-archive`（restore/delete）
- `GET .../stream` SSE、`.../stats`、`.../todos`、`.../skills?q=`
- `GET .../models|presets`、`PUT .../model`、`PUT|GET .../session-model`、`PUT .../session-preset`
- `PUT|GET .../permission`
- `POST .../ask-answer` 提问答复
- `POST .../queue/send|update|delete`
- `POST .../attachments`（扇出）、`.../attachments/direct/init|register|relay`（P2P）
- `GET .../files/download`
- 协作（远端 ≥0.3.9 能力探测）：`GET|POST|PUT .../goal`、`GET|PUT .../plan`、`POST .../compact`
- 子任务：`POST .../subtasks/:subId/retry`、`GET .../chat`、`POST .../followup`、`POST .../summary`
- `POST /api/console/chat` App AI 控制台透传

### 节点 / 资源 / 文件
- `GET /api/resources`、`POST /api/resources/refresh|probe`、`GET /api/resources/mappings/:id/resolve`
- `GET /api/dsh-models?node=`、`GET /api/dsh-workspaces?node=`、`POST /api/dsh-test`
- `GET|POST /api/agents/fs/list|download|upload|remove|mkdir`（agent/node 寻址）
- `GET /api/agents/:id/skills?...`、`GET|POST .../bindings`、`POST .../upload`、`GET .../preview`、`DELETE .../skills/:name`、`GET .../download`
- SSH 池：`GET|POST /api/ssh-resources`、`GET|DELETE /api/ssh-resources/:id`、`POST .../test|exec`

### 技能/插件库
- `GET /api/library/overview`、`POST /api/library/skill|plugin/upload`、`POST /api/library/settings`
- `DELETE|GET /api/library/(skill|plugin)/:id`、`GET .../download`
- `POST /api/library/(skill|plugin)/:id/install`（nodeRefs、同节点去重）
- `GET /api/library/installs`
- 导入：`POST .../import/skills`、`POST .../import/plugins`（全量）、`POST .../import/plugins/list`（清单制）、`GET .../import/plugins/poll?taskId=`
- `GET /api/library/nodes/skills?node=`、`GET /api/library/nodes/plugins?node=&agentId=`
- `GET /library/file/(skill|plugin)/:id?token=`（签名下载，免登录态）

### 定时任务 / 规划 / 监控 / 用量 / 设置 / 工具通道
- `GET /api/schedule-templates`、`GET|POST /api/schedules`、`GET|PATCH|PUT|DELETE /api/schedules/:id`、`POST .../toggle|run`、`POST /api/schedules/ping`、`POST /api/schedules/prompt-preview`
- `GET|POST|PUT /api/planner/*`（options/config）
- `GET /api/monitor/overview|events?limit=|history?days=`
- `GET /api/usage/tokens/summary|records`（from/to/source/projectId/agentId/scheduleId/taskId 过滤）
- `GET|POST|PUT /api/settings`（apiKey 打码）、`POST /api/settings/ai-token/reset`
- `GET /api/version`
- 工具通道：`GET /api/tools`、`GET|POST /api/tools/:name`（登录会话或 AI 令牌）
- 小智：`GET /api/xiaozhi/status`、`POST|DELETE /api/xiaozhi/endpoints(/:id)`
- 基础：`GET /healthz`、`OPTIONS *` CORS 预检、`GET /`、`GET /monitor`、`GET /install-*` 安装资源、404 JSON

### 访问控制要点（横切）
- 会话 Cookie 或 AI 令牌（Bearer / X-WorkBuddy-Token / ?token=）
- AI 令牌开放面白名单：工具通道、/mcp、监控、定时任务、规划器、/api/agents/fs、资源目录、/api/dsh-models、任务读写/文件/附件、项目 CRUD；其余 403（fail-closed）
- 邮件类接口限流（1h 5 次）
- 管理员专属：用户管理、审计日志

## 24. MCP Server（对外工具通道）

- 主 MCP：`POST {prefix}/mcp` Streamable HTTP（JSON-RPC 2024-11-05、支持 batch、SSE 单帧回包、会话 Mcp-Session-Id 30min TTL、DELETE 会话、幂等回放 10min、阻塞上限 120s、64KB 单帧）
- `GET /api/mcp/status` 运行状态（会话数/调用/失败/幂等命中/超限）
- 14 个宿主无关工具（HTTP/小智/MCP 三通道同源）：
  - `workbuddy_resource_manage` 资源目录 list/dsh/resolve/refresh
  - `workbuddy_agent_manage` agent list/upsert/delete/ping/preview/models/presets/enable/disable
  - `workbuddy_task_manage` 任务 list/create（幂等去重）/send/wait/delete/members/cancel
  - `workbuddy_task_status` 任务进度（summary|full）
  - `workbuddy_task_chat` 子任务聊天记录+followup（三重裁剪）
  - `workbuddy_task_evaluate` 刷新汇总报告
  - `workbuddy_task_ask_answer` 自动探测挂起提问并答复
  - `workbuddy_ssh_resource_manage` SSH 池 list/get/upsert/delete/test/exec
  - `workbuddy_monitor_read` overview/events/history/task
  - `workbuddy_schedule_manage` 定时 list/get/upsert/delete/toggle/run
  - `workbuddy_planner_manage` 主调度 get/set/options
  - `workbuddy_file_manage` fs list/mkdir/upload/download/delete + P2P 直传 init/register
  - `workbuddy_project_manage` 项目 CRUD
  - `workbuddy_expert_manage` 专家 list/get/search/create/update/delete（copy-on-write）
- 专家库独立 MCP（`/api/experts/mcp`）：`expert.list|get|create|update|delete|search`
- prompts/resources 列表空集（语义校验点）

## 25. 技能资产（AI 双通道接入）

- 主技能 onenat-workbuddy（SKILL.md 总入口 + 6 分块子技能文档：tasks/experts/agents-projects/ops-monitoring/files-resources/cli）
- wb.mjs 命令行客户端（宿主无工具环境）
- workbuddy-mcp 技能 + wbmcp.sh 直连脚本
- install-skill.sh 一键安装（HTTP+MCP 双通道、APIKEY 参数写本机配置）
- 安装资源端点：/install-skill.sh、/install/wb.mjs、/install/SKILL.md、/install/mcp/SKILL.md、/install/wbmcp.sh、/install/skills.json、/install/skills/:slug.md（文件名白名单防穿越）

## 26. 后台机制与自愈行为（对测试可见的行为点）

### 任务执行引擎
- 双模式：chat 直通（单成员长持远端会话）/ orchestrate 编排
- @ 语义全集：@智能体/@资源/@专家/@团队/@项目/@文件/`@[智能体:路径]`/`@专家#id`；同名歧义拒绝、最长前缀匹配
- 节点直发（`__node__` 主会话）：无 @ 消息直连任务节点；节点 ping 预检（ONENAT online ≠ 进程活）
- 工作区/模型优先级：任务级 workDir/model > 项目 workspace > 调度 planner.model > agent 自带 > 节点默认
- 会话自愈四连：401/403 凭证强刷；ENOENT 工作目录 mkdir -p；瞬时失败退避重试；Provider Registry 错配回退节点默认模型（主会话模型自愈回退）
- 会话漂移免疫：每次派发实时解析公网入口（不缓存 URL）；nodeRef 对象格式校验
- 映射漂移自动重绑：natpass 重注册 mappingId 变更后自动改写存量 dshRef/nodeRef（agent/任务/定时全链）
- workspaceId 幂等注册、cwd realpath 等价校验、会话复用 vs 重建判定
- 派发降级链：SSE 流式优先 → 流零文本 history 对账 → 流式不支持降级同步 → 同步超时转轮询 → SSE 断流转轮询
- 空回合自愈（零内容零工具自动重发一次）；模型回退自愈（自带模型首轮无产出→丢会话按调度模型重建）
- ask_user 挂起治理：unattended 自动保守答复解锁 / attended 等待；答复桥续跑追踪；连环提问物化成答复卡；残留对账 + 幽灵卡 5 分钟清扫 + 周期扫描
- 消息队列：执行中排队 FIFO 补发、立即发送（steer 插话/空闲派发）、排队编辑/删除
- 进程重启自愈：running 任务标记 failed（中断恢复）
- 任务幂等：重复创建指纹去重（2min 精确 + 5min 首句近似）

### 编排护栏
- 计划合同校验 + 纠正一次重规划 + 告警放行；防递归净化；上游摘要注入+截断；成环检测降级并行

### 调度器
- Host 权威本地 20s tick（浏览器关闭不影响）；下次触发补算；间隔/每日/每周/每月/一次/每小时 6 类规则；once 自动停用；不补跑

### 监控/统计/审计
- 事件采集 13 类 + 双落盘（事件/小时快照）+ 回读
- Token 统计口径：逐轮归属（endedAt 优先）、跨日归完成日、缓存 token 单列、多源过滤（schedule/chat/orchestrate/console/tool）；历史快照冻结不回填
- 审计日志：关键操作追加写、保留 1000 条、0600 权限

### 资源面（ONENAT）
- 15s 快照缓存+并发去重+force 强刷、60s 周期刷新
- 唯一命名策略（泛称加环境前缀、同隧道同 kind 加端口后缀）
- 引擎探测 90s TTL、失败也缓存、并发去重；凭证 429 限速退避全局暂停（凭证烧保护）
- 节点漂移重绑回调

### 存储与数据
- store.json 单文件全家桶：尾随流式合并落盘（3s）+ 异步单飞 + 临时文件原子替换 + 退出 flush + writeEpoch 防旧快照覆盖
- 冷归档瘦身（见 §20）；删除级联；同名 upsert 去重
- 邮件：零依赖 SMTP（STARTTLS/AUTH LOGIN、RFC 2047 中文主题）、三模板（邀请 72h/项目邀请 7 天/重置 24h）、失败指数退避重试 3 次（认证失败不重试）、mock 模式落 mail-log

### 提示词合成（资源即提示词）
- compose 合成结构化提示词块：资源段（SSH/URL/raw tcp 入口、凭证 inline/self-fetch、风险提示）、技能三语义（agent 绑定/资源侧自助安装/[平台接入]过渡）、交互守卫（attended/unattended 二分：成员/编排/定时下发禁 ask 声明、节点主会话不下发）、脱敏 preview、块缓存（5min TTL）
- 预组装校验：离线资源跳过告警、动态 @ 去重合并

## 27. 跨通道一致性与安全要点（补充测试角度）

- 三通道（HTTP 工具/MCP/小智 WS）同 14 工具行为一致性；通道差异（阻塞上限/回包方式）
- AI 令牌 fail-closed、重置旧令牌立即失效
- 脱敏面：用户列表/SSH 资源/提示词预览/监控工具参数 全部打码或只留标志
- 邀请/重置 token 一次性且具有效期（72h/24h/7 天/2h/30min 分档）
- 软删除：用户删除可见性与数据保留；项目归档=只读；归档会话批量恢复/删除
- 防枚举：防邮箱枚举恒定响应、项目成员越权 404、错误未参 409 防串号
- CORS：OPTIONS 全开 204（含跨域访问与安全评估点）
- 文件面安全：文件名清理防路径注入、slug 白名单防穿越、签名下载 token 过期

## 28. 部署与运维（配套脚本，可做部署/回归测试入口）

- 独立构建 build-standalone.sh（不依赖 DSH checkout）、deploy-standalone.sh 标准部署流水线（构建→冒烟→上传→备份替换→重启→验证）
- 冒烟系列：smoke-standalone / smoke:e2e / smoke:schedules / smoke:monitor / smoke:ai / smoke:users / smoke:expert-crud / smoke:mail-real / smoke:mcp / smoke:xiaozhi
- E2E 系列：ask-user / attachment（双通道）/ console / permission / project-mention / queue / workspace-inject
- 启动参数：--port（默认 3081）/--host（默认 127.0.0.1）/ --prefix / --admin-username/--admin-password / WORKBUDDY_ENV_FILE
- mock-onenat 本地 Mock 服务（/api/v1 形状对齐真实）
