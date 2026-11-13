/** Versioned result contract shared by MCP and HTTP; legacy text remains byte-for-byte available. */
export const TOOL_CONTRACT_VERSION = '2026-11-08.1'
export const TOOL_OUTPUT_SCHEMA = {
  type: 'object', required: ['contractVersion', 'ok', 'data'], additionalProperties: false,
  properties: {
    contractVersion: { type: 'string', enum: [TOOL_CONTRACT_VERSION] },
    ok: { type: 'boolean' },
    data: { type: 'object', additionalProperties: true, description: 'Original tool JSON object; action-specific fields remain compatible.' },
  },
}
export function structuredToolResult(text: string): { contractVersion: string; ok: boolean; data: Record<string, unknown> } {
  let data: Record<string, unknown>
  try {
    const value = JSON.parse(text)
    data = value && typeof value === 'object' && !Array.isArray(value) ? value : { value }
  } catch { data = { text } }
  return { contractVersion: TOOL_CONTRACT_VERSION, ok: data.ok !== false, data }
}
export function mcpToolResult(text: string, isError = false) {
  const structuredContent = structuredToolResult(text)
  if (isError) structuredContent.ok = false
  return { content: [{ type: 'text', text }], structuredContent, isError: !structuredContent.ok }
}
