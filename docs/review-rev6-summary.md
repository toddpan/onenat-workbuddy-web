# review-rev6-summary · REV-6 专家审查汇总（task-6 / REV-6）

- 审查人：expert ｜ 汇总时点：2026-11-11 ｜ 契约事实源：docs/groups-web-sync-plan-2026-11-11.md（§1-§6，含全部裁定回写）
- 性质：五份审查报告终态收拢 + 全部裁定台账 + 遗留池 + 方法论教训——**ACC-8 总验收输入**。视觉/交互面权威 = ui-designer docs/ui-review-web-groups.md（本汇总不覆盖）。

---

## 一、五份报告终态（全部 ⛔ 0 / ⚠️ 0 未决）

| 报告 | 对象 | 审查轮次 | 终态 |
|---|---|---|---|
| review-web-1.md | WEB-1 群存储 + REST（src/groups.ts / router 12 端点 / 16 测试） | 预研备忘 13 组 + 正式对账 + 第二轮复核（⛔1→0） | 闭环 |
| review-web-2.md | WEB-2 MCP 工具（contracts/policy/ops 四处登记 + server 装配 + 测试） | 正式对账 + 裁定回写 | 闭环 |
| review-web-3.md | WEB-3 群 UI（web-ui.ts 群段；折叠/开轮/结束轮/设置/向导） | 预研 + 正式对账 + 第二轮（6 修复 5 过 1 返工）+ 第三轮（W3-3 闭环）+ 收尾批次（G-W-P0-1/P1 系列）+ R1 ⛔ 热修闭环 + G-W-P0-3 ⛔ 审计闭环 | 闭环 |
| review-web-4.md | SKILL-4 文档（groups.md / 双 SKILL.md / 脚本） | 正式对账 + W4-2 闭环 | 闭环 |
| review-and-5.md | AND-5 Android 接口化（GroupRepository / Api 11 方法 / 调用点五文件 / +2 纯函数测试） | 正式对账 + 收尾批次（AND-1/2/3 闭环） | 闭环 |

**质量数据（最终态）**：Web typecheck 0 错、test:unit **374/374**（含 groups.test.ts 19 项、groups-confirm.test.ts 确认门回归 3 项、AND-2 单调 4 断言）、build EXIT=0；Android `:app:compileDebugKotlin` + `:app:testDebugUnitTest` **179 tests / 0 failures**。复核期间累计抓出并闭环 ⛔ 4 项（W1-1 结构级损坏静默清库、W3-0 尾部构建重复〔lead 发现〕、R1 确认门 DOM 重读全字段清零〔ui-designer 复验发现〕、G-W-P0-3 正则双层转义丢失〔ui-designer 复验发现〕）＋ ⚠️ 10+ 项（全部处置或归档）。

## 二、裁定台账（全部已回写契约或归档）

### 契约回写类（§=groups-web-sync-plan-2026-11-11.md 行号）
| # | 裁定 | 契约锚点 |
|---|---|---|
| 1 | 落盘：tmp+rename 原子写 + load 失败/JSON 损坏拒绝覆盖写；「仿 ssh-store」只取 0600/fs-perms 惯例 | §1:39 |
| 2 | 不存在群 id：GET/PUT :id、GET/POST :id/rounds、POST :id/read 一律 404（DELETE 幂等 200 例外，复核 W1-4 修订）；跨用户 id 同 404 防枚举 | §2:65 |
| 3 | 分组空白名 400 INVALID_PARAM；DELETE 不存在有效名幂等 200 | §2:67 |
| 4 | 分组引用容差（渲染未分组）+ 新建入口必须先 POST group-sections | §2:69 |
| 5 | AI 令牌通道：workbuddy_group_manage 全 12 action AI_TOKEN_DENIED，先身份后校验，不做共享桶 | §3:79 |
| 6 | GroupStore 单实例装配（server.ts 一次建、双路注入；禁懒建/模块级注册表） | §3:80 |
| 7 | 空转折叠重复判定（≥8 码点包含）：代码保留、调用侧停用，对齐 Android 基线；启用记遗留池 | §4:86 |
| 8 | groups.md 以 MCP 通道用法为主（REST 属控制台/Android 契约面）；脚本通道不可用工具以 HELP/文档边界说明替代命令登记（wb.mjs 先例） | §5:93 |

### 专家裁定类（expert 终审，lead 确认）
| # | 裁定 |
|---|---|
| 9 | W3-3 验证写法与三层转义根因（TS 源→页面字符串→正则源），产物级验证方法确立 |
| 10 | wb.mjs 不加 group case：调用必 AI_TOKEN_DENIED，加 case = 死命令；HELP 知情 + tools 列表可见 = 知情链完整（裁定 8 的先例） |
| 11 | P1-2 建群门槛：Android 实测基线 **≥1**（CreateGroupWizard.kt:145 isEmpty；ui-designer 引用的 ≥2 是 spec §4.3-⑥ 文档口径，Android 实现自身偏离 spec）——Web 收紧 ≥2 **可接受**（群语义本质/贴合 spec 文档/文案明示/跨端数据兼容） |
| 12 | AND-2 根解：Web 服务端 upsert 落库 lastReadSeq = max(现值, 入参)（unreadCount 照收），Android 零改动；四写口调用点全覆盖 + 新群边界正确 + 4 断言单测 |
| 13 | DshNodes 零改动判定确认（GroupStore 用法全属 §6 本地保留项） |
| 14 | TaskMonitorService.kt:48 保留现状（本地缓存 + 5min gate：离线通知友好/零流量/读口写穿保鲜），切 repo.groups() 记遗留池 |
| 15 | W2-1/W4-3 在途改动归属归档（readOnly 令牌块 / tasks.md+wbmcp.sh 均 08:43 前 git status 已列，非本次写入） |
| 16 | AND-2/TaskMonitor/遗留池三条处置均经 lead 确认归档 |

### 修复闭环类（programmer 交付 → expert 复核通过）
W1-1~W1-6（groups.ts 损坏保现场/keepMemory/asTriBool/rounds 400/INTERNAL_ERROR 500）→ W3-0（热修）→ W3-1~6（折叠原文保留/归一化对齐/孤儿频道补偿/先建分组/重复判定停用/mcp 示例）→ W4-2 → AND-1~3 → G-W-P0-1/P1-2/4/6/7/8（回显/门槛/档名/破坏性合并确认/danger 键）→ R1 ⛔（确认门 DOM 快照）→ G-W-P0-3 ⛔（正则双层转义 + 词边界退格 + replace 串三层修复）。全部附产物级或代码级+行号验证。

## 三、遗留池条目清单（非阻塞，处置建议）

| # | 条目 | 来源 | 建议处置与优先级 |
|---|---|---|---|
| 1 | spec 文档对齐：§4.3-⑥「≥2」vs Android 实现「≥1」（P1-2 裁定附注）；spec「恢复同确认」超前双端实现（恢复不确认） | review-web-3 收尾批次 | **中**：Android 侧择机补校验或 spec 修订，双端+文档三点对齐一次做 |
| 2 | 空转折叠重复判定（≥8 码点包含）启用：代码保留、调用侧停用；启用须双端同投 | §4:86（W3-2） | **中**：作为「双端一致增强」独立任务，启用前补 Android 调用侧 |
| 3 | ToolPolicyContext.session 增补可选 username：群 createdBy 全通道无 userId 降级 | W2-3 | **低**：类型增补非行为变更 |
| 4 | TaskMonitor 群列表切 repo.groups()：通知准确性要求提升时后台 gate 内一次刷新 + 失败回退本地 | AND-5 裁定 14 | **低**：现状离线友好已够 |
| 5 | 删除分组二次确认：级联影响=引用群变未分组（可逆），Android 同款无确认 | review-web-3 收尾 | **低**：随任意 UI 批次顺带 |
| 6 | 归档 cancel 静默失败孤儿频道：已 Log.w 留痕 + 任务中心手动收口 | AND-3（已闭环） | **低**：如需自动收口可在归档后异步对账 |

## 四、方法论教训（REV-6 固化，后续复核 SOP 输入）

1. **确认类 UI 修复必须追踪「确认后执行路径」的输入来源**（R1 教训）：P1-6/7 复核验证了 reasons 判定与二段式流程，未追确认回调的 DOM 生命周期——openModal 销毁表单后重读 DOM = 全字段清零。复核 SOP：确认类修复必须回答「确认回调的数据从哪来」。
2. **正则/转义验证判据必须含「正应命中」正例，且产物行逐行 eval**（G-W-P0-3 教训）：只测「不误命中」会让「永不匹配的坏正则」也 PASS（词边界退格化被 split-join 兜底掩盖）；测试替身（脚本内正确转义）验证产线转义是循环命题——**产品行为只认 build 产物，自证与复核必须从产物提取 eval**。
3. **验证脚本自身也需要被验证**（复跑插曲）：复跑脚本变量名与产物定义错位（return IDLE vs GROUP_IDLE_RE）连误三轮，而 dbg probe 的 typeof 信号早已给出正解——验证脚本报错时先怀疑脚本，再怀疑被测物。
4. **三层转义是 web-ui.ts（TS 模板串嵌页面 JS）的结构性风险**（R1/P0-3 共同根因）：TS 源 → 页面字符串 → 正则源，每层转义翻倍。处置建议（后续批次可选）：群区正则迁移为字面量正则（不经字符串构造，天然无层数问题）或集中一个 escapeForPageRegExp 工具函数 + 产物行断言测试。

## 五、剩余风险声明

- 双端建群门槛差异（Web ≥2 / Android ≥1）：已裁定可接受（裁定 11），文案可感知；数据跨端兼容。
- unreadCount「客户端覆盖上报照收」+ lastReadSeq 服务端 max：并发 markRead 安全（单调），覆盖上报合法场景保留。
- 归档时频道 cancel 失败：Log.w 留痕 + 任务中心手动收口（AND-3 已闭环，遗留池 6 可选增强）。
- web-ui.ts 群段约 630 行内联页面 JS：无 DOM 单测框架，行为级验证依赖 ui-designer 走查 + 产物提取 eval（本次已建立方法）。
- 契约 §5 SKILL 与 §4 UI 的行为一致性以本汇总为对账快照；后续任何群行为变更须同步五份 review 台账的增量维护约定不在本任务范围。

## 六、验收结论

- 五份 review-*.md 全部 ⛔ 清零、⚠️ 全部处置（闭环/归档/遗留池），每条附文件:行号与验证方法。
- 契约 §1-§6 全部裁定回写落地，实现与契约逐条对账通过（本汇总 §二台账）。
- 双端构建与测试绿（数据见 §一）。
- **REV-6 审查侧验收通过，输出即 ACC-8 总验收输入。**
