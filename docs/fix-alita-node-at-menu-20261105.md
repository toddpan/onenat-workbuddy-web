# 线上排障报告 —— alita 节点在 @ 菜单中"找不到"（2026-11-05）

> 结论一句话：alita 节点本身**完全健康**（DSH 0.6.1 / deepseek-flash / 公网 33709 在线），
> 用户"@ 找不到这个 DSH 资源、也看不到它下面的智能体"由**两个独立缺陷叠加**造成：
> ① **权限过滤**（普通用户看不到他人归属的智能体，且宽容模式项目的绑定成员也看不到）；
> ② **@ 弹层渲染截断**（392 条候选按固定 cap 截断，排在第 20 位的智能体 / 第 5 个 DSH 节点永远沉底）。
> 两者均已修复并上线。

## 1. 现场事实（排查证据）

| 项 | 实测值 |
|---|---|
| ONENAT 隧道 | `ZfiejEkCeN` name=**alita** online=**true** |
| 映射 | `dcb86658` app=DSH local=`127.0.0.1:31800` public=`tcp://natpass.yikaihui.com:33709` |
| 节点健康 | `/api/v1/system/status` → running，dsh-web-service `0.6.1`，standalonePort 31800 |
| 模型 | `deepseek-flash`（DeepSeek-V4.1-Flash）可用；presets standard/ptc/minimal/cordis |
| 智能体 | `agent-43i1lmqp` name=**Alita** dshRef=`{kind:mapping,mappingId:dcb86658}` owner=`usr-77c5cf4d0705ed24` |
| 候选接口 | admin 视角 392 条，含 Alita / alita-DSH / alita 项目，**稳定不抖动**（3 天日志 62 次请求 61×200） |

**结论：链路、节点、凭证、候选接口全部正常 —— 问题在前端可见性。**

## 2. 根因 A：权限过滤（主因）

`src/perm.ts` 的 `boundToUserProjectAgent` 只认 `isProjectMember`：

```ts
if (!isProjectMember(p, uid) && !isPlatformAdmin(session)) return false   // 旧实现
```

而 Alita 唯一绑定的项目 `proj-lg0q0ukq`（alita AI 语音平台工作区）**无 owner、无 projectMembers** ——
即 `projectIsolated()===false` 的**宽容模式项目**（全员可见），因此它**永远没有成员**。
于是出现荒谬结果：**项目人人可见，项目里的默认协作成员（Alita）谁都看不到**。

实测三个真实账号：

| 账号 | 角色 | 修复前 canViewAgent | 修复后 |
|---|---|---|---|
| workbuddy | admin | ✅ true | ✅ true |
| **Alita99Yoko**（报障用户） | **user** | ❌ **false** | ✅ true |
| 潘祖记 | user | ❌ false | ✅ true |

接口层是**静默隐藏**（`router.ts` candidates 用 `canViewAgent` 过滤，不可见就整条不出现），
用户只感知为"@ 找不到"，没有任何报错提示。

### 修复

可见性口径与项目本身对齐：绑定成立后跟随项目可见性 —— 宽容模式项目 → 所有登录用户；
隔离模式项目 → 仍严格仅成员/admin（**未放宽**）。

```ts
if (!binds) return false
if (!projectIsolated(p)) return true                     // 宽容模式项目：全员可见
return isProjectMember(p, uid) || isPlatformAdmin(session) // 隔离模式：维持严格判定
```

## 3. 根因 B：@ 弹层截断（次因）

`GROUP_CAP = { project: 6, team: 5, agent: 6, dsh: 4, ssh: 2, http: 2, expert: 8 }` ——
无关键字时每组只渲染前 N 条，其余折叠成一行"输入关键字过滤"。
线上有 **20 个智能体**、**13 个 DSH 节点**：Alita 排 agent 第 20 位、alita-DSH 排第 5 个节点，
**用户不预先知道节点名就永远看不到**。这解释了"新加的节点/智能体 @ 找不到"的直观感受。

### 修复：分类筛选条（对齐 Android 客户端 MentionPicker.kt）

- 新增筛选条：**全部 / 🕘最近 / 📁项目 / 🧩专家团 / 🤖智能体 / 📦资源 / 🧠专家**（带计数）
- **智能体按 DSH 节点分组**（`🖥 节点名 · N`），与 Android 一致
- **取消截断**：选中分类后完整可滚动，不再有"输入关键字过滤"黑洞
- **🕘 最近使用**：localStorage 持久化（`wb_mention_recent_v1`，上限 6 条），置顶显示
- 头部动态显示候选总数 / 匹配数
- 候选**每次打开 @ 时按 60s 过期刷新**（新增节点最多 60s 内可见，无需刷新页面）

## 4. 验证

| 层面 | 结果 |
|---|---|
| 类型检查 `npm run typecheck` | ✅ 通过 |
| 单元测试 `npm run test:unit` | ✅ **185/185**（含新增 alita 回归用例） |
| 集成冒烟 `npm run smoke` | ✅ **91/91** |
| 真实浏览器（生产数据，普通用户 Alita99Yoko） | ✅ Alita + alita-DSH 均可见于 `🖥 alita-DSH` 分组 |
| 线上端到端（2026-11-05 12:27 部署后） | ✅ 392 候选、6 分类、13 个节点分组、alita 三项全在 |
| 线上服务状态 | ✅ active，NRestarts=0，healthz 正常 |

## 5. 交互效果

修复后（普通用户视角）：

```
@ 提及 380 个候选 · 🕘最近 📁项目 🧩专家团 🤖智能体 📦资源 🧠专家
[全部380] [🕘最近1] [📁项目18] [🧩专家团5] [🤖智能体17] [📦资源12] [🧠专家328]
🕘 最近使用 · 1
📁 项目 · 18
🧩 专家团 · 5
🤖 智能体 · 17
  🖥 brain 环境-DSH:3080 · 3
  ...
  🖥 alita-DSH · 1        ← 新节点独立成组
      Alita               智能体 · alita-DSH · deepseek-flash
📦 资源 · 12
🧠 专家 · 328
```

## 6. 变更文件

| 文件 | 变更 |
|---|---|
| `src/perm.ts` | `boundToUserProjectAgent` 可见性口径对齐项目可见性 |
| `src/perm.test.ts` | 新增宽容模式项目绑定成员可见性回归用例 |
| `src/web-ui.ts` | @ 弹层分类筛选条 / 节点分组 / 最近使用 / 取消截断 / 候选过期刷新 |

> 部署记录：2026-11-05 12:27:07 CST，`systemctl restart onenat-workbuddy` 成功，NRestarts=0。
> 本地 `src/onenat.ts` / `src/router.ts` 的改动为部署**前**既有的未提交工作，非本次修复内容。
