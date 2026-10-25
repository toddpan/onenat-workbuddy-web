# 修复：项目导入提示词优化 - 明确 node 和 workspace 预填值

## 问题描述

在导入项目时，节点智能体执行导入任务后调用 `/api/projects/import-create` 接口，但 POST 请求中可能缺少或错误地填写了 `node` 和 `workspace` 参数，导致平台侧校验失败（409 Conflict）。

## 根本原因

原提示词中，`node` 和 `workspace` 预填值的位置不够明确：

```typescript
// 原提示词（第 427 行）
`本项目将挂在来源节点「${nodeLabel}」（节点键：${nodeKey}）下，由平台按导入令牌自动绑定；你无需在 payload 里选节点，只要原样照抄下面的 node 与 workspace 预填值（平台会比对校验，不符即拒收）。`
```

这段话说"**原样照抄下面的** node 与 workspace 预填值"，但紧接着是候选清单（expertIds、connectorIds），真正的预填值要到步骤 4 的 JSON 模板才出现。这可能让 AI 误以为"下面"指的是候选清单部分，从而忽略了真正需要填写的预填值。

## 解决方案

将 `node` 和 `workspace` 预填值**提前并明确展示**在提示词开头部分，独立成段，使用醒目格式：

```typescript
// 优化后的提示词（第 427-431 行）
'',
`⚠️ 必填预填值（原样照抄到 payload JSON，平台会校验，不符即拒收）：`,
`   - node（节点键）："${nodeKey}"`,
`   - workspace（工作区路径）："${path}"`,
`本项目将挂在来源节点「${nodeLabel}」下，节点归属由平台按导入令牌自动绑定，你无需在 payload 里选节点。`,
''
```

### 改进点

1. **独立段落**：预填值单独成段，与候选清单明确分隔
2. **醒目标记**：使用 `⚠️` emoji 和明确的标题"必填预填值"
3. **具体展示**：直接展示完整的预填值内容，包括字段名、说明和具体值
4. **双引号包裹**：明确显示值的字符串格式（`"${nodeKey}"` 和 `"${path}"`）
5. **校验说明前置**：将"平台会校验，不符即拒收"放在开头，强调重要性

## 修改文件

- `src/library.ts` - `buildProjectImportPrompt` 函数（第 425-433 行）

## 验证要点

后续测试时应确认：

1. 节点智能体生成的 payload JSON 中，`node` 字段值与平台下发的 `nodeKey` 完全一致
2. `workspace` 字段值与平台下发的 `path` 完全一致
3. 不再出现 409 Conflict 响应（载荷校验不一致错误）

## 相关代码

### 平台侧校验逻辑

```typescript
// src/router.ts 第 896-902 行
const normPath = (v: string) => v.replace(/\/+$/, '')
const bodyNode = String(body.node || '').trim()
const bodyWorkspace = String(body.workspace || '').trim()
if (bodyNode !== this.nodeKeyOf(pending.nodeRef) || normPath(bodyWorkspace) !== normPath(pending.path)) {
  this.sendJson(res, 409, { 
    ok: false, 
    error: `载荷校验不一致（载荷 node=${bodyNode || '缺失'} workspace=${bodyWorkspace || '缺失'}；本任务应为 node=${this.nodeKeyOf(pending.nodeRef)} workspace=${pending.path}）——这份载荷可能被同机并发导入任务覆盖，请用本任务专属文件名 /tmp/wb-import-<导入ID> 重写载荷后重试` 
  })
  return true
}
```

### JSON 模板位置

```typescript
// src/library.ts 第 453 行
`   {"node":"${nodeKey}","workspace":"${path}","name":"…","instruction":"…","expertIds":[],"connectorIds":[],"skillNames":[],"summary":"…"}`
```

## 修改日期

2026-10-18
