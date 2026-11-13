# 修复报告 —— 流式回复未按 Markdown 渲染、中止后气泡永远停在原文本（2026-11-05）

> 结论一句话：流式显示层（`src/web-ui.ts` 客户端）有**三个叠加缺陷**，外加一个观感放大项——
> ① **中途加入/重连回源重建的流式快照用 `textContent` 直灌 DOM**：`**`、反引号等语法字符原样裸露，整段回复看起来「没按 MD 渲染」；
> ② **这类重建块没有 `__blockMap`，后续第一个 delta 在 `ensureLiveBlock` 抛 TypeError**，把 RAF 冲刷循环整个打断——流式更新从此冻结，用户看到的就是一段再也不动的原文本；
> ③ **停止/取消没有逐轮 turn_end**（服务端直接置 `streaming=false` 只补发 `task_end`），前端从不收敛——被中止的回复永远停在未渲染的半截；
> ④ 生成中的**未闭合** `**加粗` / 行内码 / 围栏代码块在渲染时原样裸露语法字符。
> 四项均已修复，jsdom 回归 7/7、markdown 无损 ✅、mock 健壮性 14/14。

## 1. 现场现象（用户截图）

- 一个 6分37秒 的长回合中途点停止后，助手气泡整段显示为**未渲染原文本**：
  `**RTX 的解析光源列表是空的**`、`UsdLux.SphereLight.Define`（带反引号）、`**全黑(16,0)**` 等 markdown 语法字符全部裸露。
- 流式进行中（回复未完成前）同样凌乱：**打开正在执行的会话 / 页面刷新 / SSE 重连回源**后，气泡停止更新且保持原文本。

## 2. 根因（均在 `src/web-ui.ts` 客户端模板串内）

### R-A（主因）`ensureLiveBlock` 抛 TypeError → 流式更新整轮冻结

```js
// 修复前
const existing = el.blocks.__blockMap[kind];   // __blockMap 未初始化时直接 TypeError
```

`buildTurnElement` 直接装配的块（中途加入 / 回源重建 / 刷新页面）不会初始化 `el.blocks.__blockMap`
（该属性只在 `ensureLiveBlock` 的**创建分支**里补建）。此后第一个 `turn_delta` 走到复用分支即抛
`Cannot read properties of undefined (reading 'text')`——异常从 RAF 冲刷循环中穿出，**同批事件全部丢弃**、
滚动跟随也不执行；而下一帧重新调度后又在同一处抛错。表现：气泡永久冻结在重建时的快照上。

**旧回归为什么没抓到**：C2 场景（中途加入）刻意设计为「快照后无后续 delta」，恰好绕开了 `ensureLiveBlock`。

### R-B 流式快照 `textContent` 直灌（语法字符裸露的直接来源）

```js
// 修复前（buildTurnElement 的流式分支）
const te = createBlock('text'); te.el.textContent = turn.text || ''; blocks.appendChild(te.el);
```

快照正文不经 `md()` 渲染；且没有登记 `__blockMap`，即使 R-A 修掉，后续 delta 也会另起新块，
出现「快照原文 + 续写」双块叠影。

### R-C 停止/取消无逐轮 turn_end，前端无收敛兜底

服务端 `engine.ts cancelTask`：置 `turn.streaming=false` → 追加系统行「⏹ 已停止」→ 发 `task_status` + `task_end`，**不发 turn_end**。
前端 `task_end` 处理器只移除光标 + 关停止键，**不收敛流式块** → 被中止的回复永远停在流式半截（截图正是此场景）。

### R-D 观感放大：未闭合语法原样裸露

流式生成中常见未闭合的 `**加粗` / 行内码 / \`\`\` 围栏，直接喂给 `md()` 会原样裸露（等闭合标记到达才突然变样）。

## 3. 修复（均在 `src/web-ui.ts`）

| # | 位置 | 修复 |
|---|---|---|
| 1 | `ensureLiveBlock` | `__blockMap` 容错读取（`(el.blocks.__blockMap \|\| {})[kind]`），重建块不再抛 TypeError |
| 2 | `buildTurnElement` 流式分支 | 快照改走 `te.append(turn.text)`（立即按 markdown 渲染）并登记 `__blockMap['text']`，后续 delta 复用同一块续写 |
| 3 | `connectStream` 的 `task_end` | 新增 `finalizeStaleStreamTurns(task)` 兜底：把页面上仍处于流式态的轮次按服务端权威 turns 调 `finalizeTurnBlocks` 收敛渲染（正常路径 turn_end 已先行收敛，此处为 no-op） |
| 4 | `createBlock('text').paint` | 新增 `balanceStreamingMd()`：流式 paint 前补全未闭合语法（奇数围栏行补闭合围栏、奇数 `**` 补 `**`、奇数反引号补反引号；先剔除围栏段与成对行内码再计数，不误伤代码内容）。只作用于流式 paint，turn_end 收敛仍用权威全文，不影响无损性 |

## 4. 验证

### 回归场景扩充（`e2e-artifacts/client-streaming-test.mjs`）

新增两个此前缺失的场景（支持 `midCheck` 中间态断言 / `lateEvents` 延迟收尾事件 / `fullText` 场景级期望全文）：

- **C6 中途加入 + delta 续写**：快照含未闭合 `**`，其后 delta 补上闭合。中间态断言：续写必须渲染（不冻结）+ 无 `**`/`##`/反引号裸露。
- **C7 停止/取消（无逐轮 turn_end）**：`task_status` + `task_end` 后必须收敛为渲染态全文。

对「仅回退本修复、保留其它未提交改动」的 no-fix 构建做对照，C6/C7 精确复现两个根因：

```
TypeError: Cannot read properties of undefined (reading 'text')   ← R-A
    at ensureLiveBlock
[midCheck] ❌ 续写 delta 未渲染（流式更新冻结）；流式正文未按 markdown 渲染（语法字符裸露）  ← R-A + R-B + R-D
[C7] 显示字符数 115 / 期望 526  结尾标记: ❌ 缺失                  ← R-C
```

| 套件 | no-fix | 修复后 |
|---|---|---|
| 客户端渲染回归 C1–C5 | ✅ | ✅ |
| C6 中途加入 + delta 续写 | ❌（冻结 + 原文裸露） | ✅ |
| C7 停止/取消 task_end 兜底 | ❌ 115/526 | ✅ |
| markdown 渲染无损（含未闭合围栏样本） | ✅ | ✅ |
| mock 远端健壮性 | （harness 失联） | **14/14** |
| `balanceStreamingMd` 真实构建产物提取单测（含围栏路径） | — | 9/9 |
| `tsc -p tsconfig.server.json --noEmit` / 构建脚本 `node --check` 三页脚本语法关卡 | — | ✅ |

### 顺带修复（测试基建，使 `npm run test:streaming` 恢复一键可跑）

- `mock-remote-robustness-test.mjs`：Phase-3 合并后仍 import 早已不存在的 `dist/planner.js` → 改为 `dist/orchestrator.js` 的 `Orchestrator`（构造形状一致）。
- 回环 mock（127.0.0.1）需按 ssrf-guard 约定放行内网直连：`run-streaming-tests.mjs` 现默认注入 `WORKBUDDY_ALLOW_PRIVATE_DIRECT=1`（显式传入的环境变量优先；元数据段仍一律拒绝）。

## 5. 生效方式

- `dist/` 已重新构建（`bash scripts/build-standalone.sh`，含三页脚本 `node --check` 语法关卡）。
- 独立部署实例（`node dist/server.js …`）**需按原命令重启**后生效；浏览器端强刷一次页面。
