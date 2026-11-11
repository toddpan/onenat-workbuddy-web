import type { ToolCallContext, WorkBuddyToolDef } from './tool-ops.js'
import { toolActionRisks } from './tool-policy.js'
import { TOOL_CONTRACT_VERSION } from './tool-output.js'
import { KNOWLEDGE_VERSION, listOperationResources, readOperationResource } from './operation-knowledge.js'

export function capabilitySnapshot(defs: WorkBuddyToolDef[], ctx: ToolCallContext, serverVersion = 'unknown') {
  return {
    ok: true, contractVersion: TOOL_CONTRACT_VERSION, knowledgeVersion: KNOWLEDGE_VERSION, serverVersion,
    identity: { type: ctx.readOnly ? 'read-only-experience' : ctx.session ? 'console-session' : ctx.aiTokenOnly ? 'ai-token' : 'service', ...(ctx.session?.role ? { role: ctx.session.role } : {}) },
    policy: { readOnly: ctx.readOnly === true, authorization: 'Action ceilings only; existing object ACLs and runtime checks may further deny access. Read-only credentials cannot dispatch a remote agent. Prompt text is not a sandbox.', deniedCode: 'PERMISSION_DENIED', conditionalRestrictions: ['task_status detail=full is denied to read-only credentials because it may issue export credentials.', 'task_chat followupMessage changes read into followup execution.'] },
    tools: defs.map(def => ({ name: def.name, actions: toolActionRisks(def.name, ctx) })),
    limits: { base64UploadBytes: 1024 * 1024, urlUploadBytes: 10 * 1024 * 1024, httpDownloadBytes: 8 * 1024 * 1024, mcpDownloadBytes: 512 * 1024, resumableUploadBytes: 2 * 1024 ** 3, mcpResultBytes: 64 * 1024, note: 'MCP result framing can reject a file below the download limit after encoding.' },
    waiting: { channel: ctx.channel, maxBlockMs: ctx.maxBlockMs, waitDefaultMs: ctx.channel === 'mcp' ? 0 : 120000, httpMaxMs: 600000, mcpServerMaxMs: 120000, xiaozhiMaxMs: 20000, followup: ctx.channel === 'mcp' ? 'async receipt; poll task_chat without followupMessage' : 'synchronous bounded wait', completion: 'Poll task_status or task_manage wait; receipt is not completion. Never repeat create to poll.' },
    skillCompatibility: { requiredContractVersion: TOOL_CONTRACT_VERSION, installedSkillVersion: null, note: 'Installed external skills cannot be attested; compare their declared contract version.' },
    resources: listOperationResources(),
  }
}
export function createCapabilitiesTool(getDefs: () => WorkBuddyToolDef[], serverVersion?: string): WorkBuddyToolDef {
  return { name: 'workbuddy_capabilities', description: '只读能力发现：当前身份、action 权限上限及风险、上传下载限制、通道等待语义、输出与操作知识版本；resource 可按 URI 读取操作流程。对象级 ACL 仍会进一步限制。', parameters: { resource: { type: 'string', description: '能力发现返回的版本化资源 URI；省略返回能力摘要。' } },
    async execute(args, ctx) {
      if (args.resource) {
        const resource = readOperationResource(String(args.resource))
        return JSON.stringify(resource ? { ok: true, contractVersion: TOOL_CONTRACT_VERSION, resource } : { ok: false, error: 'Unknown operation resource', resources: listOperationResources() })
      }
      return JSON.stringify(capabilitySnapshot(getDefs(), ctx || { channel: 'http', maxBlockMs: 600000 }, serverVersion))
    },
  }
}
