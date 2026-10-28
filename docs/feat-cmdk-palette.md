# ⌘K 命令面板（视图 / 操作 / 会话 / 子智能体 / 项目 一站式直达）

## 需求

控制台此前键盘效率为零：切到「定时任务」要鼠标点「更多 → 定时任务」，找某个会话要回侧栏搜。补上一个全局命令面板：任何页面按 `⌘K` / `Ctrl+K`（或点 header「⌘K」按钮）呼出，输入即过滤，`↑↓` 选择、`Enter` 执行、`Esc` 关闭，**到达任意功能 ≤2 步**。

## 设计要点

- **零后端改动**：纯前端（`src/web-ui.ts` 内联脚本，沿用现有 `esc` / `toast` / `switchView` / `openTask` 等既有函数，不引入新依赖、不碰 `state` 结构）。
- **五类命令源**，按组渲染：
  | 组 | 来源 | 动作 |
  | --- | --- | --- |
  | 操作 | 固定 | 新建任务（`createNewTaskDirectly`）、运行配置（`openRunConfig('top')`，自动切回工作台） |
  | 视图 | 固定 4 个一级 Tab + `MORE_VIEWS` 9 个二级视图 | `switchView(v)` |
  | 会话 | `state.tasks` 未归档（空查询取最近 8 条，有查询扩到 60 条） | `switchView('work')` + `openTask(t.id)`；sub 显示最近预览/时间 |
  | 子智能体 | `state.agents` | `switchView('agents')` + `openAgentDrawer(a)`；kw 含 `describeDshRef`（直连/映射描述，可搜节点名） |
  | 项目 | `state.projects` | `enterProject(p.id)`；已归档项目标注「已归档」 |
- **过滤打分**：多词 AND（空格分词），命中 label 词首 > label 包含 > kw 包含；组内按登记序。会话/子智能体/项目数据在面板打开时即取即用（每次打开重建命令表，无缓存失配问题）。
- **异步兜底**：`cmdkRun` 对 act 返回值检查 `.catch`（openTask/enterProject 是 async），异步失败走 toast，不静默。
- **z-index 层级**：cmdk 60 > modal 50 > drawer 40——面板永远在最上层，可从任何 drawer/modal 场景呼出。
- **移动端**（≤768px）：面板顶部上移（8vh），隐藏 sub 列避免横向溢出。

## 变更点

仅 `src/web-ui.ts`：

- `<style>`：新增 `.cmdk-*` 样式块（含媒体查询），复用既有 `--bg/--line/--tx/--pri-light` token
- HTML：header `version-chip` 之后新增 `#cmdk-btn` 呼出按钮；`toast` 之前新增 `#cmdk-mask` 面板 DOM
- `<script>`：`boot()` 之前新增命令面板段（`cmdkCommands` / `cmdkMatch` / `cmdkRank` / `cmdkRender` / `cmdkPaintSel` / `cmdkOpen` / `cmdkClose` / `cmdkRun` / `initCmdk` 接线 IIFE）

嵌码遵循本文件历史纪律：内联 JS 不使用反引号、不写 `${`（静态断言有检查）；正则字面量按模板串双反斜杠转义（`/\\s+/` → 产物 `/\s+/`）。

## 验收

1. `npm run build`：tsc 编译通过 + build 脚本内联脚本 `node --check` 关卡 3 页全过（`page scripts extracted: 3`）
2. `npm run typecheck`：通过
3. `npm run smoke`：54 项全过（服务正常起、页面正常回）
4. `node --input-type=module` 静态断言（dist/web-ui.js 渲染产物）：`#cmdk-mask`/`#cmdk-btn`/`#cmdk-input`/`#cmdk-list` 齐备且 mask 唯一、`split(/\s+/)` 转义正确且无 `split('s+')` 残留、无 `${` 插值泄漏、`initCmdk` 接线唯一、foot 快捷键提示存在
5. 浏览器手工走查（待 ego-browser 回归时覆盖）：
   - `⌘K`/`Ctrl+K` 呼出后：输入「定时」→ 组「视图」置顶出现定时任务 → Enter 直达
   - 输入会话标题片段 → 该会话在「会话」组 → Enter 打开对话
   - 输入子智能体名称/节点名 → Enter 打开该子智能体编辑抽屉
   - `↑↓` 在选中项间循环、Esc/点击遮罩关闭
