# 阿里云生产环境验收报告 —— 权限模型（§10）修复与回归（2026-11-02）

> 结论一句话：**发现并修复 1 个 P0 权限漏洞（普通用户可删除任意存量子智能体，已在生产造成 1 个智能体被误删）、1 个 P1 归属劫持缺陷（管理员编辑存量实体会静默夺取归属）、1 个 P1 前端缺陷（普通用户仍看到必 403 的「编辑/删除」按钮）**；被误删的「136-苦力兔」已按取证证据恢复（原始 id `agent-wj59ud30` 保留），QA 期间产生的临时账号与测试实体已全部清理，生产数据回到 QA 前口径。
> 关联：`docs/design-user-project-management.md`（§10 权限模型设计与落地说明）、`src/perm.ts`（统一权限判定）、`scripts/perm-owner-e2e.mjs`（归属/共享端到端验证）。
>
> **后续**：第二轮真实浏览器（ego-lite）全量走查见 `docs/qa-online-perm-browser-20261103.md` —— 该轮发现并修复了本轮 P1 前端修复引入的空指针（普通用户打开「子智能体」页时 `wireAgentCard` 抛 `TypeError`，使列表所有卡片按钮失效），并给出线上 45 项接口矩阵 + 23 项浏览器矩阵的结果。

## 1. 验收环境

| 项 | 值 |
|---|---|
| 环境 | 阿里云生产 `root@natpass.yikaihui.com`（`/opt/onenat-workbuddy/dist`，systemd `onenat-workbuddy`） |
| 入口 | `https://natpass.yikaihui.com/onenat-workbuddy/` |
| 版本 | `v2026.11.1`（`/healthz` 实测） |
| 部署方式 | `bash scripts/deploy-standalone.sh root@natpass.yikaihui.com`（构建 → smoke:mcp/smoke:monitor → md5 差异 → 上传 → 远端备份 → `node --check` → `systemctl restart` → healthz 校验） |
| 验证工具 | ego-lite（真实浏览器，space `onenat-workbuddy-aliyun-qa`）+ 直连 REST 探测 |

## 2. 发现的问题与修复

### 2.1 P0：存量（无归属）实体的写面对全员开放 —— 普通用户删掉了生产子智能体

- **现象**：以普通用户（`role=user`）调用 `DELETE /api/agents/:id` 返回 `{"ok":true,"data":{"deleted":true}}`，线上「136-苦力兔」被删除且**无任何服务端备份**（`store.json` 无历史版本，`archive/` 只有任务包）。
- **根因**：`src/perm.ts` 的 `canManageAgent` / `canManageResource` 对 `ownerUserId` 缺省的存量实体「宽容放行」（`if (!agent.ownerUserId) return true`）。存量资产在多用户环境下没有可追溯的归属人，等价于**任何登录用户都能改删**。
- **修复**：存量实体改为「**可见/可用全员、写面仅管理员**」——
  - `canManageAgent`：有归属人 → 仅归属人 + admin；无归属人 → 仅 admin。
  - `canManageResource`：同口径（取明文凭据同样归入写面）。
  - 存量实体对普通用户仍可见、可 `@`、可使用（不破坏既有协作与排期任务），只是不能改/删/看明文。
- **影响面**：修复后普通用户对存量智能体的 `apiKey` / `systemPrompt` / `executionPrompt` 一并按脱敏视图返回（此前全员可见，属同源缺陷）。

### 2.2 P1：管理员编辑存量实体会静默夺取归属

- **现象**：`POST /api/agents`（带既有 `id`）、`POST /api/ssh-resources`、`POST /api/teams` 在更新既有实体时用 `existing.ownerUserId ?? session.userId` 计算归属 —— 对**存量无归属**实体，管理员改一次名/改一次配置，它就变成该管理员的**个人私有**资产，其余用户随即不可见。
- **修复**：归属只在**新建**时写入；更新既有实体时保持原归属（`existing.ownerUserId`，无归属则仍无归属）。

### 2.3 P1：前端未反映权限

- **现象**：普通用户在子智能体卡片上仍看到「编辑」「删除」按钮，点击必 403（此前 UI 完全没有权限态）。
- **修复**：`src/web-ui.ts` 新增 `canManageAgentUi()`（与服务端同口径），非归属人卡片隐藏「编辑/删除」并显示「🔒 只读」标签；`state.me` 就绪后自动重绘卡片。

### 2.4 附带修复：同名复用路径的越权

`POST /api/agents` 的「同名 + 同 DSH 实体复用」路径已存在 403 守卫（§2.1 语义收紧后对存量实体同样生效）：普通用户不得借同名复用改写他人（含存量）智能体。

## 3. 被误删实体的恢复（取证与还原）

线上无 `store.json` 历史版本，恢复证据全部来自**节点侧会话历史**与**规划器花名册**（派工时会把角色/执行方法/技能清单注入远端会话，故可回溯）。

| 字段 | 恢复值 | 取证来源 |
|---|---|---|
| `id` | `agent-wj59ud30` | 线上任务日志中的 `workbuddy_agent_manage list` 输出 |
| `name` | 136-苦力兔 | 同上 |
| `dshRef` | `{kind:"mapping", mappingId:"6cc2987d"}` | 同上 |
| `workDir` | `/root/KB-app优化` | 同上 |
| `apiKey` / `agentPreset` / `provider` / `model` / `permission` | 节点凭证 + `standard` / `zai-coding-cn` / `glm-5.3-flash` / `danger-full-access` | 同节点同族智能体「KB 平台日志采集助手」一致 |
| `role` | 修复工程师 | 规划器花名册「角色=修复工程师」 |
| `executionPrompt` | 「工作方法：1. 逐条修复… 2. 修复前先复现… 3. 修复后重新运行验证…」 | 规划器花名册「执行方法=」（前 120 字原文，尾部被花名册截断，尾句按该智能体历史自述「复现 → 定点修复 → 验证 → 问题/修复/验证对照表」补齐） |
| `systemPrompt` | 空 | 卡片未出现提示词预览（其余智能体均有），与花名册只列角色+执行方法一致 |
| `skills` | `kb-bugs`、`kb-log-usage`、`kb-runtime-collect`、`scene-skill-index`、`tspan`、`kb-api`、`kb-algo` | 该智能体自述「已装载技能」行 + 节点技能目录 |

> **未能 1:1 还原的部分（需业务确认）**：原卡片显示「🎯 8 技能」，可取证到 7 个技能名，第 8 个名称无痕迹（疑为 `kb-deploy` 一类，未凭空补写）；`executionPrompt` 第 3 条尾句为按语义补齐，建议业务方按原意复核。

还原方式：先以管理员 API 重建（服务端会分配新 id 并写入归属），随后**停服**将 `store.json` 中的条目改为原始 id 并移除归属（保持「存量无归属」口径，与其余存量智能体一致），再启服复验。

## 4. 回归验证结果

### 4.1 本地质量门（部署前）

| 项 | 结果 |
|---|---|
| `npm run typecheck` | ✅ |
| `npm run test:unit` | ✅ 176 项（含 `src/perm.test.ts` 13 项） |
| `npm run smoke` | ✅ 91 项 |
| `npm run smoke:users` | ✅ 86 项 |
| `npm run smoke:mcp` | ✅ 28 项 |
| `npm run smoke:perm` | ✅ **43 项**（新增 12 项存量无归属回归：普通用户删/改存量智能体 403、同名复用 403、被拒后实体仍在、存量 SSH 删 403、明文不可取、管理员编辑不夺取归属等） |

### 4.2 线上（阿里云）实测

| 检查 | 期望 | 实测 |
|---|---|---|
| 普通用户看子智能体列表 | 18 张卡，均「🔒 只读」 | ✅ 18 / 18 只读 |
| 普通用户卡片「编辑/删除」按钮 | 不出现 | ✅ 0 个 |
| 普通用户 `DELETE /api/agents/agent-wj59ud30` | 403 | ✅ `无权删除该子智能体（仅归属人或管理员可删）` |
| 普通用户 `POST /api/agents` 改存量 | 403 | ✅ `无权修改该子智能体（仅归属人或管理员可改）` |
| 普通用户读存量智能体 | 脱敏 | ✅ `apiKey`/`systemPrompt` 均 undefined |
| 管理员卡片「编辑/删除」 | 出现 | ✅ 恢复后的「136-苦力兔」卡片含「编辑」「删除」 |
| 管理员读存量智能体 | 完整 | ✅ `apiKey` 可见 |
| 恢复后的智能体 | 与删除前一致 | ✅ id `agent-wj59ud30`、角色 修复工程师、`/root/KB-app优化`、映射 `6cc2987d`、7 技能、无归属 |
| 控制台 JS 错误 | 无 | ✅ 仅 2 条由验证脚本自身 DELETE/POST 探测产生的 403 网络日志 |

## 5. 生产数据清理（QA 副作用）

| 对象 | 处理 |
|---|---|
| 智能体 `QA-EGO 共享子智能体`、`QA-EGO 未绑定子智能体` | 已删除 |
| 项目 `QA-EGO 权限项目` | 已删除 |
| SSH 资源 `QA-EGO SSH 资源` | 已删除 |
| 临时账号 `wb-qa-tmp`(admin)、`wb-qa-user`(user)、`qa-ego-*@example.com`×3 | 已软删除（`status=deleted`） |
| 远端 `/tmp/wb-*.mjs` 临时脚本 | 已删除 |
| 线上实体计数 | 智能体 18、项目 22、SSH 2 —— 与 QA 前口径一致 |

> **留待业务确认**：`qa-e2e-项目流程测试-改`（项目，2026-10-30 的历史 QA 残留，非本次 QA 产生）仍在库内；因非本次产生、未擅自删除，请业务方决定是否清理。另有 `598432467@qq.com` 在 `auth.json` 中同时存在 `active` 与 `deleted` 两条同名记录（历史遗留），不影响登录。

## 6. 遗留建议

1. **归属回填**：存量实体（无 `ownerUserId`）目前统一归「管理员可管」。建议按业务实际把常驻智能体/SSH 资源显式归属到人（管理员可在 UI 编辑归属，或后台一次性回填），避免长期停留在存量口径。
2. **审计覆盖**：当前审计日志未记录子智能体/资源的**删除**动作，本次数据丢失无法事后追溯。建议把 `agent.delete` / `resource.delete` 纳入审计与「删除前快照」落盘。
3. **前端补齐**：SSH 资源、项目成员面板的归属展示与操作按钮尚未按归属收敛（本轮只做了子智能体卡片）；`allowMemberInvite` 开关仍缺 UI（后端已就绪）。
4. **§10.5 剩余范围**：任务/文件/定时任务的按人隔离尚未实现。
