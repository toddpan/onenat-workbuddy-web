# QA：⌘K 命令面板 + 任务跳转统一 —— 真实浏览器验证（ego-lite）

- 日期：2026-01-27
- 方式：ego-lite（Chromium 真实浏览器）驱动 `dist/server.js` standalone 模式（mock ONENAT + 临时数据目录），模拟真实用户路径逐轮验证
- 关联：`docs/feat-cmdk-palette.md`、`docs/feat-task-jump-unified.md`
- 环境搭建：
  1. `MOCK_ONENAT_PORT=18080 node scripts/mock-onenat.cjs`（后台）
  2. `node dist/server.js --port 18091 --data /tmp/wb-ego-data --onenat-base-url http://127.0.0.1:18080 --onenat-api-key onk-mock-key-000 --quiet`（后台）
  3. REST 造数：登录 `workbuddy` → 建 1 个子智能体（绑 `map-dsh-live` 映射）→ 建 3 个会话（其中「Ego回归-归档会话」已归档）
  4. 脚本目录：`~/ego/wb-cmdk-e2e-20260127-1530/`（round-01 ~ round-08）

## 验证结果

| # | 场景 | 结果 |
|---|------|------|
| 01 | 首次加载 → `Meta+K` 呼出面板，操作/视图分组渲染正常 | ✅ |
| 02 | 过滤「定时」→ 仅「定时任务」且默认选中 → Enter 直达 `#schedules`，面板自动关闭 | ✅ |
| 02 | 空查询 `↑` 移选中（新建任务 → 运行配置）→ Esc 关闭 | ✅ |
| 02 | 过滤「归档」仅命中「归档管理」视图（活跃会话不含该词、已归档任务刻意排除——行为符合设计） | ✅ |
| 03 | 会话搜索「活跃」→ 唯一命中「Ego回归-活跃会话」→ Enter 进工作台并打开，`chat-title` 正确 | ✅ |
| 03 | 监控大屏 3 张任务卡 → 点卡片弹「任务详情」→ 点「在工作台打开完整对话」→ 切 `#work` 并打开对应会话 | ✅ |
| 04/05 | （诊断轮）归档分组默认折叠；旧轮次手动渲染前的点击出现一次未生效，定位为脚本时序问题 | ⚠️ 见下 |
| 06 | 重新 `renderArchiveList()` 后点击 → `#work` + 正确 chatTitle，无 JS 异常 | ✅ |
| 07 | **真实用户路径**：整页刷新 → ⌘K 进「归档管理」→ 展开分组 → 点已归档会话 → 自动切工作台打开「Ego回归-归档会话」 | ✅ |
| 08 | header `⌘K` 按钮点击呼出，焦点自动落在搜索框（18 条候选）；Esc 关闭 | ✅ |

## 结论

- **feat-cmdk-palette**：⌘K 面板 5 类命令源、多词过滤、键盘操作、按钮呼出，浏览器实测全部通过。
- **feat-task-jump-unified**：修复的关键路径（归档页会话点击 → `jumpToTask` → 自动切换到工作台）在整页刷新后的真实路径验证通过；监控大屏「在工作台打开完整对话」与 ⌘K 会话直达同样通过。
- round-05 的一次点击未生效与 `jumpToTask` 实现无关（fresh render 后同路径多次复测均通过、无异常上报），判定为测试脚本在后台 re-render 竞态窗口内点了被替换的旧 DOM 节点。
