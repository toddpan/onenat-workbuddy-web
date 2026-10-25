# 修复项目列表中节点显示混淆问题

## 问题描述

同一台机器（同一条 ONENAT 隧道）上运行多个不同端口的 DSH 服务时，导入到不同 DSH 节点的项目在项目列表中被错误地放到了一起，没有按端口区分开。

例如：公司笔记本上同时运行两个 DSH 实例（不同端口），从这两个节点导入的项目应该分别显示在各自节点下，但实际上混在了一起。

## 根本原因

在 `src/router.ts` 中，多处代码使用了 `tunnelName` 来标识节点，而 `tunnelName` 只能标识隧道（机器），无法区分同一台机器上不同端口的服务。

`src/onenat.ts` 中的 `buildEndpoint` 方法已经正确处理了这个问题：当同一隧道下有多个相同 kind 的映射时，会在 `appName` 中追加本地端口后缀（如 `公司笔记本-DSH:18083`），但项目摘要等地方没有使用这个字段。

## 修复方案

将所有用于显示节点名称的地方从 `tunnelName` 改为 `appName`：

### 后端修复（src/router.ts）

1. **`nodeLabelOf` 方法** (第 258 行)
   - 修改前：`return m?.tunnelName || m?.appName || ref.mappingId`
   - 修改后：`return m?.appName || ref.mappingId`

2. **`projectSummary` 方法** (第 280 行)
   - 修改前：`this.directory.resolveMapping(proj.dshRef.mappingId)?.tunnelName`
   - 修改后：`this.directory.resolveMapping(proj.dshRef.mappingId)?.appName`

3. **`scheduleSummary` 方法** (第 403 行)
   - 修改前：`this.directory.resolveMapping(s.nodeMappingId)?.tunnelName`
   - 修改后：`this.directory.resolveMapping(s.nodeMappingId)?.appName`

4. **`/api/dsh-models` 接口** (第 1107、1114 行)
   - 修改前：`ep.tunnelName || mappingId`
   - 修改后：`ep.appName || mappingId`

5. **`/api/dsh-workspaces` 接口** (第 1126、1135 行)
   - 修改前：`ep.tunnelName || mappingId`
   - 修改后：`ep.appName || mappingId`

6. **`/api/schedules/:id/ping` 接口** (第 1170 行)
   - 修改前：`ep?.tunnelName || nodeMappingId`
   - 修改后：`ep?.appName || nodeMappingId`

7. **`/api/schedules/preview` 接口** (第 1240 行)
   - 修改前：`this.directory.resolveMapping(nodeMappingId)?.tunnelName`
   - 修改后：`this.directory.resolveMapping(nodeMappingId)?.appName`

### 前端修复（src/web-ui.ts）

8. **`topoResLabel` 函数** (第 3695 行) - **关键修复**
   - 修改前：`return r.tunnelName || r.appName || r.note || r.mappingId || r.appId || ''`
   - 修改后：`return r.appName || r.note || r.mappingId || r.appId || ''`
   - **影响**：项目列表分组逻辑依赖此函数，修复后同一机器不同端口的节点将正确分组显示

## 设计原理

### `appName` vs `tunnelName`

- **`tunnelName`**：标识 ONENAT 隧道（对应一台机器），同一台机器上的所有映射共享相同的 `tunnelName`
- **`appName`**：标识具体的应用服务，包含端口后缀以区分同一机器上的不同服务

`onenat.ts` 中的命名逻辑：

```typescript
// 基础名称
let uniqueName = rawAppName

// 为泛称资源添加隧道前缀
if (uniqueName === 'DSH' || uniqueName === 'SSH Server' || ...) {
  uniqueName = `${t.name}-${uniqueName}`
}

// 同一隧道下同 kind 映射 ≥2 条时追加本地端口后缀
if ((kind === 'dsh' || kind === 'http') && this.sameKindSiblingCount(t, kind) > 1) {
  const localPort = ... 
  uniqueName = `${uniqueName}:${localPort}`
}
```

结果示例：
- 单个 DSH：`公司笔记本-DSH`
- 多个 DSH：`公司笔记本-DSH:18083`、`公司笔记本-DSH:18084`

### 保留 `tunnelName` 的场景

以下场景仍保留 `tunnelName` 作为补充信息，这是合理的：

1. **资源选择器的 detail 字段**（第 2419 行）：`${ep.kind} · ${ep.tunnelName} · ${ep.online ? '在线' : '离线'}`
   - 显示完整上下文信息，帮助用户理解资源归属

2. **引擎探测结果**（第 1069 行）：`{ mappingId, appName, tunnelName, engine }`
   - 同时返回两个字段供前端灵活使用

3. **任务执行的 fallback 链**（第 2974、2981 行）：`ep.appName || ep.tunnelName || nodeMappingId`
   - 健壮性考虑，虽然 `appName` 总是存在，但保留 fallback 无害

## 影响范围

- **项目列表（前端）**：现在能正确区分同一台机器上不同端口的 DSH 节点，分组显示时按 `appName`（包含端口）而非 `tunnelName`（仅机器名）
- **项目列表（API）**：`/api/projects` 返回的 `nodeTitle` 包含端口区分
- **定时任务**：任务关联的节点名称显示正确的端口信息
- **节点选择器**：各个接口返回的 `nodeTitle` 包含端口区分
- **错误提示**：离线/不存在等错误信息中的节点名称更精确

## 测试验证

1. 启动同一台机器上的两个 DSH 实例（不同端口）
2. 从两个节点分别导入项目
3. 检查项目列表，确认项目分别显示在不同节点下（节点名带端口后缀）
4. 检查定时任务列表，确认节点名称显示正确
5. 尝试离线某个端口的节点，确认错误提示中节点名称精确

## 相关文件

- [src/router.ts](../src/router.ts) - 后端 API 返回的节点名称修复（7 处）
- [src/web-ui.ts](../src/web-ui.ts) - 前端项目列表分组显示修复（1 处，关键修复点）
- [src/onenat.ts](../src/onenat.ts) - `appName` 命名逻辑实现
- [docs/fix-project-import-prompt.md](./fix-project-import-prompt.md) - 相关：导入提示词优化
