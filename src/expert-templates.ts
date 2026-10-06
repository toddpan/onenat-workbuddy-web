/**
 * onenat-workbuddy-web - 内置专家模板库（Phase 2 迁移期兼容层，@deprecated）
 *
 * 数据模型已合并进 src/expert-registry.ts（ExpertRegistry）：7 个内置质量门禁角色模板
 * 随 321 位名册专家一并迁移到 assets/experts/（JSON 资产，由 scripts/build-expert-assets.mjs
 * 从本文件历史版本生成）。本文件仅保留纯组装函数的转发导出，engine.ts / router.ts 等既有
 * 调用点零改动；Phase 3 将删除本文件并把调用点直接指向 expert-registry。
 *
 * 历史来源：dsh-agent-teams（DeepSeek Harness AgentTeams 插件）。
 */

export { expertPersona, expertRoleLabel } from './expert-registry.js'
