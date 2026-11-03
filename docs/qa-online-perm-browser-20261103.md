# 线上验收报告 —— 权限模型（§10）真实浏览器全量走查（2026-11-03）

> 结论一句话：第二轮（真实 Chromium / ego-lite）验收在权限控制台发现并修复 **1 个 P1 前端缺陷** —— 普通用户打开「子智能体」页即抛 `TypeError: Cannot read properties of null (reading 'addEventListener')`，使该列表**所有**卡片的按钮集体失效；修复并重新部署后，线上 API 权限矩阵 **45/45**、浏览器走查矩阵 **23/23** 全通过，全流程 **0 条 JS 错误**，QA 临时数据已清零。
>
> 关联：`docs/design-user-project-management.md`（§10 权限模型设计与落地说明）、`src/perm.ts`（统一权限判定）、`scripts/perm-owner-e2e-online.mjs`（线上接口矩阵）、`qa-20261102-perm-online/browser-ego.mjs`（浏览器走查）、`docs/qa-aliyun-permission-20261102.md`（第一轮：P0 存量写面放开 / P1 归属劫持 / P1 前端按钮未收敛）。

## 1. 验收对象与环境

| 项 | 值 |
|---|---|
| 交付内容 | §10 权限模型扩展：平台角色 / 项目成员 / 资源归属 / 智能体归属，判定集中在 `src/perm.ts` |
| 环境 | 阿里云生产 `root@natpass.yikaihui.com`（`/opt/onenat-workbuddy/dist`，systemd `onenat-workbuddy`，数据目录 `/var/lib/onenat-workbuddy`） |
| 入口 | `https://natpass.yikaihui.com/onenat-workbuddy/` |
| 版本 | `v2026.11.1`（`/healthz` 实测 `authRequired=true`，匿名访问 fail-closed） |
| 验证工具 | ego-lite 真实浏览器（space `wb-ego-perm`，1440×900 桌面 + 375×812 移动视口）+ 直连 REST 矩阵 |
| 账号 | 管理员 `wb-qa`；普通用户为 QA 期间临时邀请并激活的 `qa-ego-*@example.com`（验证后软删除） |

### 1.1 部署记录（本轮两次）

| 次序 | 时间 | 变更文件 | 结果 |
|---|---|---|---|
| #1（第一轮收尾） | 2026-11-02 22:59 | `perm.js`、`router.js`、`web-ui.js`（+ `skills/` 哈希漂移同步） | `systemctl restart` 成功；远端备份 `dist.bak-20261102-225913-{perm,router,web-ui}.js`；healthz + MCP 匿名 401 fail-closed 校验通过 |
| #2（本轮修复） | 2026-11-03 06:14 | `web-ui.js`（`wireAgentCard` 空指针修复） | `ExecMainStartTimestamp=2026-11-03 06:14:22 CST`，`NRestarts=0`；远端备份 `dist.bak-20261103-061419-web-ui.js`；本地/远端 md5 一致（`292d3b5f48b6db8f6249b41845a05477`），远端文件含修复标记 |

> ⚠️ 每次 `systemctl restart onenat-workbuddy` 会把当时处于 `running` 的任务标记为失败（`src/engine.ts` 自愈文案：「⚠️ 服务重启导致本轮执行中断，任务已标记为失败；远端可能仍产生过部分结果，如需请重发消息」）。本轮两次部署各造成一次该状态，属预期副作用，已在上一轮报告中记录。

## 2. 本轮新发现并修复的缺陷（P1）

### 2.1 现象

以**普通用户**登录控制台 → 点「子智能体」页签，页面在渲染卡片时抛未捕获异常：

```
TypeError: Cannot read properties of null (reading 'addEventListener')
    at wireAgentCard (…/onenat-workbuddy/?r=…:11082:39)
    at renderAgents (…:11023:38)
    at switchView (…:4986:25)
```

可见后果：**该页面所有子智能体卡片的「进入工作台 / 复制 / Ping 探活 / 提示词预览 / 技能」按钮全部失效**（事件绑定在异常处中断），且列表中第一张不可管的卡片之后的卡片同样失去事件。

### 2.2 定位过程（ego-lite）

1. 用 `page.cdp('Page.addScriptToEvaluateOnNewDocument')` 在页面启动前注入错误收集器（`error` / `unhandledrejection` / `console.error`），保证捕获到**首屏即抛**的异常与堆栈；
2. 复现脚本 `qa-20261102-perm-online/diag-member-error.mjs`：普通用户登录 → 逐个切页签，每切一次打印错误数组；
3. 错误只在切到「子智能体」页时出现，堆栈直指 `wireAgentCard` 的 `card.querySelector('[data-op=edit]').addEventListener(...)`。

### 2.3 根因

上一轮 P1 修复给卡片加了**按归属条件渲染**的按钮（`managed ? '<button data-op="edit">编辑</button>' : ''`、`managed ? '<button data-op="del">删除</button>' : ''`），但 `wireAgentCard` 仍按「按钮必定存在」去绑定事件：

```js
card.querySelector('[data-op=edit]').addEventListener('click', …)   // 非归属人：null.addEventListener → TypeError
card.querySelector('[data-op=del]').addEventListener('click', …)
```

普通用户看到的卡片没有 `edit`/`del` 两个按钮 → 抛错 → 同一函数后续的 `copy/skills/ping/preview/del` 绑定全部不执行，并且 `renderAgents` 里 `cards.forEach(wireAgentCard)` 被异常打断，**后面所有卡片**同样失效。

### 2.4 修复（`src/web-ui.ts`）

1. `wireAgentCard` 改为缺省即跳过的安全绑定（按钮不存在 → 不绑定，不抛错）：

```js
const on = (op, fn) => { const el = card.querySelector('[data-op=' + op + ']'); if (el) el.addEventListener('click', fn); };
on('enter', …); on('edit', …); on('copy', …); on('skills', …); on('ping', …); on('preview', …); on('del', …);
```

2. `renderAgents` 增加逐卡兜底，单卡异常不再影响其余卡片：

```js
el.querySelectorAll('.agent-card').forEach(card => {
  try { wireAgentCard(card); } catch (err) { console.error('[web-ui] 子智能体卡片绑定失败', card.dataset.agent, err); }
});
```

> 与服务端口径不变：写面仍由 `canManageAgentUi()`（与 `src/perm.ts` 同口径）决定，隐藏按钮≠放开权限；服务端 403 兜底保持不变。

### 2.5 复验

修复 → `npm run build` → `npm run typecheck` → `npm run smoke` → 部署 #2 → 同一浏览器脚本复跑：**23/23 通过**，其中 `D2 普通用户流程无 JS 错误` 由 ❌（1 条 pageerror）转 ✅；普通用户卡片「删除」按钮仍为 0 个（权限未被放宽）。

## 3. 线上 API 权限矩阵（45/45 ✅）

脚本：`scripts/perm-owner-e2e-online.mjs`（环境变量注入，不落盘明文；`WB_KEEP=1` 可保留数据，默认自动清理）。
结果文件：`qa-20261102-perm-online/api-result.json`。

| 组 | 断言数 | 覆盖 | 结果 |
|---|---|---|---|
| ① 管理员登录 | 1 | `wb-qa` 登录取会话 | ✅ 200 |
| ② 邀请与激活 | 2 | 管理员邀请普通用户 → 令牌激活 → 自动登录 | ✅ 201 / 200 |
| ③ 归属建立 | 7 | 建 SSH 资源（归属=管理员）、建子智能体（回显 `ownerUserId`）、建未绑定对照体、建项目、加入成员 | ✅ |
| ④ 负向矩阵 | 10 | 普通用户对他人资源：列表不含 / 明文 404（防枚举）/ exec 403 / 删 403 / 改 403；对他人智能体：列表不含 / 详情 404 / 改 403 / 删 403 / 同名同节点新建 403 | ✅ 全部按预期 |
| ⑤ 归属人读写 | 2 | 归属人可取 SSH 明文凭据、可读智能体 `apiKey`/提示词 | ✅ 200 |
| ⑥ 项目绑定共享 | 9 | 项目绑定 SSH 与默认智能体后：成员可见但脱敏、无明文、**可使用**（exec 200）、不可删（403）；未绑定智能体仍 404 | ✅ |
| ⑦ `allowMemberInvite` | 4 | 默认成员邀请 403 → 开启开关 → 成员邀请 201 → 撤销邀请 200 | ✅ |
| ⑧ 存量口径回归 | 6 | 他人归属智能体不泄漏（泄漏 0）、显式共享可见、未绑定不可见、存量智能体仍可见（宽容）、存量私有配置脱敏、存量删除 403（线上事故回归） | ✅ |
| ⑨ 既有功能回归 | 4 | `healthz` 正常、监控总览可读、成员项目列表只含自己所属、未登录业务接口 401 | ✅ |

**合计 45 项，失败 0。**

## 4. 真实浏览器走查矩阵（23/23 ✅）

脚本：`qa-20261102-perm-online/browser-ego.mjs`（ego-lite，注入错误收集器 + 走真实导航点击）。
结果文件：`qa-20261102-perm-online/browser-result.json`。

| 组 | 项数 | 覆盖 | 结果 |
|---|---|---|---|
| A 管理员（1440×900） | 13 | 登录页渲染、登录进入工作台、版本 `v2026.11.1`、ONENAT 目录已连接（10 资源 / 8 DSH 节点）、导航 14 个页签、子智能体 20 张卡、QA 归属卡可见、**管理员可见「删除」写面**、项目 23 张卡含 QA 项目、设置页 SSH 池管理员卡可见且含 QA 资源行、监控大屏渲染（28 个智能体）、资源目录渲染 | ✅ |
| B 普通用户（同一浏览器换号） | 6 | 登录成功（`role=user`）、可见项目显式共享的智能体、**无「删除」写面**、看不到未绑定智能体、存量 19 张卡全部只读（带删除按钮的卡片数 = 0）、设置页 SSH 池管理员卡隐藏 | ✅ |
| C 移动端（375×812） | 2 | 工作台横向溢出 0px、子智能体页卡片渲染 20 张 | ✅ |
| D JS 错误 | 2 | 管理员流程 0 条、普通用户流程 0 条（修复前 1 条 pageerror） | ✅ |

### 4.1 截图清单（`qa-20261102-perm-online/`）

| 文件 | 内容 | 尺寸 |
|---|---|---|
| `admin-01-login.png` | 登录页 | 1440×900 |
| `admin-02-work.png` | 管理员工作台 | 1440×900 |
| `admin-03-agents.png` | 管理员子智能体列表（含「编辑/删除」写面） | 1440×900 |
| `admin-04-projects.png` | 项目列表 | 1440×900 |
| `admin-05-settings-ssh.png` | 设置页 SSH 资源池（管理员卡） | 1440×900 |
| `admin-06-monitor.png` | 监控大屏 | 1440×900 |
| `admin-07-resources.png` | ONENAT 资源目录 | 1440×900 |
| `member-01-agents.png` | 普通用户子智能体列表（「🔒 只读」，无写面按钮） | 1440×900 |
| `member-02-settings.png` | 普通用户设置页（无 SSH 池管理员卡） | 1440×900 |
| `mobile-01-work.png` / `mobile-02-agents.png` | 移动端工作台 / 子智能体页 | 375×812 |

## 5. 本地质量门（部署前）

| 项 | 结果 |
|---|---|
| `npm run build` | ✅ 纯 tsc，产出 `dist/server.js` |
| `npm run typecheck` | ✅ |
| `npm run test:unit` | ✅ **176 / 176** |
| `npm run smoke` | ✅ **91 项** |
| `npm run smoke:perm` | ✅ **43 项**（归属/共享/存量口径端到端） |

## 6. 生产数据清理核对（QA 副作用）

| 对象 | 处理 | 复核 |
|---|---|---|
| 子智能体 `QA-EGO 共享子智能体` / `QA-EGO 未绑定子智能体` | 已删除 | ✅ 残留 0 |
| 项目 `QA-EGO 权限项目` | 已删除 | ✅ 残留 0 |
| SSH 资源 `QA-EGO SSH 资源` | 已删除 | ✅ 残留 0 |
| 临时账号 `qa-ego-*@example.com`（普通用户） | 已软删除 | ✅ 残留 0 |
| 项目邀请（成员发出） | 已撤销 | ✅ revoke 200 |

复核方式：清理后以管理员身份重新拉取 `/api/agents`、`/api/ssh-resources`、`/api/projects`、`/api/users`，按 `QA-EGO` / `qa-ego` 前缀计数，**四项均为 0**；`/healthz` 仍 `ok=true`。

## 7. 遗留与建议

1. **前端归属态尚未覆盖全部实体**：本轮只收敛了子智能体卡片；SSH 资源、项目成员面板的归属展示与操作按钮仍未按归属收敛（普通用户当前因卡片隐藏而天然不可见，但语义上应与 `perm.ts` 逐项对齐）。
2. **`allowMemberInvite` 仍缺 UI 开关**：后端与接口已就绪（403 → 开启 → 201 已在线验证），控制台项目面板没有对应开关，只能走 API。
3. **接口与撤销语义不一致（易踩坑）**：`POST /api/projects/:id/invitations` 返回的 `inviteLink` 里是**令牌**，而撤销接口 `POST /api/projects/:id/invitations/:invId/revoke` 要的是**邀请 id**（`GET …/invitations` 列表返回）；用令牌调用会得到 404「仅待处理邀请可撤销」。建议在接口文档中显式区分，或让撤销接口同时接受令牌。
4. **普通成员新建同名智能体被 403 拦截**：语义正确（不得借同名复用改写他人资产），但错误文案可再明确「同名同实体已被他人占用，请改名」。
5. **审计覆盖**：子智能体/资源的删除动作仍未进审计日志（上一轮已列，仍未修）。
6. **存量归属回填**：存量实体（无 `ownerUserId`）统一归「管理员可管」，建议按业务实际显式归属到人。

## 8. 复现方式

```bash
# ① 造数（管理员密码走环境变量，不落盘）
WB_ADMIN_PASS='***' node scripts/perm-owner-e2e-env.mjs
# ② 线上接口矩阵（45 项，自动清理）
WB_ADMIN_PASS='***' node scripts/perm-owner-e2e-online.mjs
# ③ 真实浏览器走查（23 项，需 ego-lite）
ego-browser nodejs < qa-20261102-perm-online/browser-ego.mjs
# ④ 清理
WB_ADMIN_PASS='***' node scripts/perm-owner-e2e-env.mjs --cleanup
```
