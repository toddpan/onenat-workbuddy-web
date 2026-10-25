# 修复：项目列表按节点正确分组显示

## 问题描述

当同一台机器上启动多个不同端口的 DSH 节点（如 `公司笔记本-DSH:3081` 和 `公司笔记本-DSH:3082`）时，前端项目列表将它们错误地归为同一组，导致用户无法区分不同节点下的项目。

### 根本原因

前端 `topoResLabel` 函数使用 `tunnelName`（仅包含机器名，不含端口）作为**首选标签**，而非 `appName`（包含端口的完整节点标识）：

```javascript
// 修复前
function topoResLabel(r) { 
  return r.tunnelName || r.appName || r.note || r.mappingId || r.appId || ''; 
}
```

这导致 `renderProjects` 函数中的分组逻辑 `topoEntityEnvKey(p.dshRef, p.nodeTitle)` 无法区分同机不同端口的节点。

## 修复方案

### 前端修复（src/web-ui.ts:3695）

**移除 `tunnelName` 的首选地位**，改为优先使用 `appName`：

```javascript
// 修复后
function topoResLabel(r) { 
  return r.appName || r.note || r.mappingId || r.appId || ''; 
}
```

### 配套后端修复（已完成）

后端 7 处 `nodeLabelOf` 相关代码已在 [fix-node-display-confusion.md](./fix-node-display-confusion.md) 中完成修复，确保 API 返回的 `nodeTitle` 字段包含端口区分。

## 影响范围

### 直接影响

1. **项目列表分组** - 同机不同端口的节点现在显示为不同分组
2. **拓扑环境筛选器** - 筛选器芯片正确反映各节点的项目数量
3. **视觉一致性** - 前端显示与后端 API 返回的 `nodeTitle` 保持一致

### 不受影响

- **任务列表** - 按时间维度分组，不涉及节点分组
- **节点选择器** - `label` 已正确使用 `appName` 优先，`tunnel` 字段保留为元信息
- **拓扑健康状态** - 独立于标签逻辑

## 验证步骤

1. 启动两个不同端口的 DSH 节点（如 `:3081` 和 `:3082`）
2. 在每个节点下导入或创建项目
3. 刷新项目列表页面
4. 确认：
   - 项目列表中显示两个独立的分组
   - 分组名称包含端口号（如 `公司笔记本-DSH:3081`）
   - 拓扑筛选器显示正确的分组数量

## 相关文件

- [src/web-ui.ts:3695](../src/web-ui.ts#L3695) - 关键修复：`topoResLabel` 函数
- [src/router.ts](../src/router.ts) - 后端 `nodeLabelOf` 方法（已修复）
- [docs/fix-node-display-confusion.md](./fix-node-display-confusion.md) - 后端节点标签修复文档
- [docs/fix-project-import-prompt.md](./fix-project-import-prompt.md) - 导入提示词优化文档

## 相关概念

### appName vs tunnelName

- **`appName`** - 完整的节点标识，格式为 `{tunnelName}-DSH:{port}`（如 `公司笔记本-DSH:3081`），用于区分同机不同端口的节点
- **`tunnelName`** - OneNAT 隧道名称，仅包含机器名（如 `公司笔记本`），不含端口信息
- **使用原则** - 所有需要**精确识别节点**的场景应使用 `appName`，`tunnelName` 仅作为元信息保留

### topoEntityEnvKey 逻辑

项目和任务的分组键生成流程：

1. 根据 `dshRef.kind` 判断节点类型（`mapping` / `direct` / `app`）
2. 查找对应的 resource 对象
3. 调用 `topoResLabel(resource)` 生成标签
4. 调用 `topoEnvKey(label)` 规范化为环境键（小写、去空格等）

修复后，步骤 3 返回 `appName`（含端口），确保同机不同端口节点生成不同的环境键。

## 修改摘要

**修改文件**: 1 个  
**修改行数**: 1 行  
**影响范围**: 项目列表分组显示、拓扑环境筛选器  
**破坏性**: 无（仅修正显示逻辑）
