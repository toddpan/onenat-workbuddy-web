# 修复：执行位置下拉看不到新加的 DSH 节点（2026-11-06 续报）

## 现象

pjy-DSH 映射已在 ONENAT 后台添加且在线（服务端 `GET /api/resources` 实测 11 个 DSH 节点含 pjy-DSH），
但用户长时间开着的页面里，「执行位置」下拉始终看不到 pjy-DSH——只能刷新整页才出现。用户报告为"老 BUG"。

## 根因

`state.resources` 只在**页面 boot 时加载一次**（`loadResources()`）：

- 8s 自愈循环仅在目录为空时运行（成功一次即停止，最长 2 分钟）；
- 之后只有「资源目录」页的手动刷新按钮（`btn-res-refresh`）与保存设置会重拉；
- **执行位置下拉打开时不刷新** → 页面开着不动，ONENAT 新加的映射永远不出现。

服务端目录本身是新鲜的（`autoRefreshMs` 默认 60s 自动刷新 snapshot；`/api/resources` 有 1.5s 微缓存）。
11-05 已修过同族问题的两个入口：@ 菜单候选按 60s 过期刷新（5d51885/420d45e/54ede44）、
执行位置"沉底"搜索框——但执行位置下拉的**目录数据新鲜度**漏掉了。

## 修复（对齐 @ 菜单的 60s 过期口径）

- `state.resourcesAt`：`loadResources()` 成功时打点；
- `catalogStale()` / `refreshCatalogIfStale(onDone)`：>60s 视为过期，后台重拉（服务端 15s TTL + 并发去重 + 1.5s 微缓存，成本可控）；
- `openPlacePop()`：打开下拉时过期则后台重拉，完成后弹层仍开着才重绘（正在输入搜索关键字时不打断）；
- `openProjectImportModal()`（导入弹窗同数据源）：打开前过期先重拉（60s 门控命中即零等待）。

效果：新加的 DSH 节点最多 60s 后在执行位置/导入弹窗自动可见，无需刷新整页。

## 验证

| 项 | 结果 |
| --- | --- |
| 服务端目录 | `GET /api/resources` → 11 DSH 节点含 pjy-DSH（online）✅ |
| typecheck | ✅ |
| 线上浏览器 E2E（老页面场景模拟） | 页面内存删掉 pjy + `resourcesAt` 调到 2 分钟前 → 打开执行位置下拉瞬间无 pjy → 后台自动重拉后 **pjy-DSH 自动出现（11 节点全量）**，全程未刷新页面 ✅（qa-import-pjy-20261106/place-pjy-auto-refresh.png） |

> 注：已部署后，**当前开着的旧页面需手动刷新一次**加载新 JS；之后新节点即自动可见。
