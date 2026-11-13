/**
 * onenat-workbuddy-web - AI 接入安装提示词（服务端统一来源）
 *
 * TASK-6 设计约束：Web 控制台「设置 → AI 接入」与安卓客户端共用同一份提示词正文。
 * 正文只在这里拼装一次，两端都通过 GET {prefix}/api/ai/install-prompt 取回展示/复制；
 * 客户端不得另行拼装（原 Web 端 renderAiInstall 的内联正文已整体搬迁到这里）。
 *
 * 纯函数模块（无 IO / 无状态），便于单测与跨端复用。
 */

/** 提示词结构版本：正文结构变更时递增，客户端可据此判断是否需要重新拉取 */
export const AI_INSTALL_PROMPT_VERSION = 2 as const
/** base 参数最大长度（防超长输入） */
export const AI_INSTALL_BASE_MAX_LEN = 512
/** 未生成 APIKEY 时 token 位置的占位符（保持旧 Web 行为；客户端靠 hasToken 阻断复制） */
export const AI_INSTALL_TOKEN_PLACEHOLDER = '<先生成APIKEY>'

export interface AiInstallPayload {
  /** 归一化后的访问基址（origin + pathname，去尾部 `/`） */
  base: string
  /** 服务端权威 AI 令牌（未配置为空串） */
  token: string
  hasToken: boolean
  /** Streamable HTTP MCP 端点：base + /mcp */
  mcpUrl: string
  /** 专家库 MCP 端点：base + /api/experts/mcp */
  expertMcpUrl: string
  /** 一键安装脚本：base + /install-skill.sh */
  installScriptUrl: string
  /** 发给 AI 的安装提示词正文（与旧 Web 端逐字一致） */
  installPrompt: string
  version: typeof AI_INSTALL_PROMPT_VERSION
  /** AI token has no TTL; explicit reset revokes it. */
  tokenExpiresAt: null
  tokenExpiryPolicy: 'never'
}

/**
 * 归一化调用方传入的 base：
 * - 仅接受 http(s):// 绝对地址；trim 后长度 ≤512；禁控制字符；必须能被 new URL() 解析
 * - 输出 origin + pathname（忽略 search / hash），去掉尾部所有 `/`
 * - 非法返回 null（路由层据此回 400）
 */
export function normalizeInstallBase(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > AI_INSTALL_BASE_MAX_LEN) return null
  if (!/^https?:\/\//i.test(trimmed)) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (!parsed.hostname) return null
  const normalized = (parsed.origin + parsed.pathname).replace(/\/+$/, '')
  return normalized || null
}

/**
 * 生成发给 AI 的安装提示词正文。
 * 文本与 Web 控制台旧实现（renderAiInstall）逐字一致 —— 只搬位置，禁止改文案。
 * token 为空时用占位符，其余部分照常生成。
 */
export function buildAiInstallPrompt(base: string, token: string): string {
  const tok = token || AI_INSTALL_TOKEN_PLACEHOLDER
  const mcpUrl = base + '/mcp'
  return (
    '请把「OneNat WorkBuddy 多智能体工作台」接入为你的工具平台并验证可用。它提供 16 个工具：任务创建/管理/查询/答复提问、监控态势、定时任务、项目管理、文件管理、专家库、SSH 资源池、项目待办（backlog）等（接入后 tools/list 查看全部）。\n' +
    '\n【第 1 步 · 一键安装（有终端就先做这步）】\n' +
    'curl -fsSL ' + base + '/install-skill.sh | bash -s -- --base-url ' + base + ' --token ' + tok + '\n' +
    '自动装两套技能到本机 AI 技能目录（DSH/ZCode/Claude/agents）：HTTP 通道 wb.mjs + MCP 通道 workbuddy-mcp（共用 ~/.workbuddy-skill.json），并双通道自检。MCP 须逐项通过 handshake → tools/list → ping；结果写入 ~/.workbuddy-install-report.json，失败或跳过不算验证成功。可用 bash <技能目录>/workbuddy-mcp/scripts/wbmcp.sh probe 重验（脚本通道与 MCP 等价）。\n' +
    '\n【第 2 步 · MCP 原生注册（仅宿主支持 MCP 时叠加，否则跳过）】\n' +
    '服务地址（Streamable HTTP，JSON-RPC over POST）：' + mcpUrl + '\n' +
    '鉴权：Authorization: Bearer ' + tok + '（也支持 X-WorkBuddy-Token 请求头或 ?token= 查询参数）。\n' +
    '令牌永久有效（无 TTL），仅显式重置令牌会使旧令牌失效；MCP 会话失效与令牌有效期无关。\n' +
    'mcpServers 条目：\n' +
    '{ "mcpServers": { "onenat-workbuddy": { "url": "' + mcpUrl + '", "headers": { "Authorization": "Bearer ' + tok + '" } } } }\n' +
    '【DSH 宿主注意】DSH 不解析上面的 mcpServers JSON，必须在 DSH profile 的 cordis.patch.yml 里用 dsh-mcp-client 插件条目注册（serverName 决定工具名前缀 mcp__<serverName>__workbuddy_*）：\n' +
    '- insert:\n' +
    '    - id: onenat-workbuddy-mcp\n' +
    "      name: '@deepseek-ai/dsh-mcp-client'\n" +
    '      config:\n' +
    '        serverName: onenat\n' +
    '        transport: streamable-http\n' +
    "        url: '" + mcpUrl + "'\n" +
    '        headers:\n' +
    "          Authorization: Bearer '" + tok + "'\n" +
    'patch 在 DSH 启动期加载，改完需重启 DSH 才生效；同一 profile 内 serverName 必须唯一。\n' +
    '生效后 tools/list 应能看到 workbuddy_task_manage 等工具。说明：MCP 只提供工具签名，大文件三步流程、@ 派活等使用知识在技能 SKILL.md 里，操作前先读。\n' +
    '\n【使用约定（两通道一致）】\n' +
    '1. 发任务前先调用 project_manage list 判断需求归属的项目：能确定项目就从该项目发起并带 projectId。\n' +
    '2. 需求有歧义时先向用户问清，再创建任务。\n' +
    '3. 在 message 中用 @子智能体名 / @专家名 / @专家团名 / @资源名 派活；@ 多个即编排协作。\n' +
    '4. 任务创建后用 task_manage wait 或 task_status 轮询获取结果，不要重复 create。\n' +
    '5. 带大文件（≤2GB）必须三步走：create 不带 message（draft 不执行）→ putfile 直传 → send 引用路径启动；create 带 message 任务会立即开跑。\n' +
    '\n【完成汇报】\n' +
    '说明：宿主类型与所选通道（脚本/MCP/两者）、安装与注册写入的位置、验证结果；若失败，给出原因。'
  )
}

/** 组装接口回包 data（base 须为已归一化基址；token 取服务端权威值） */
export function buildAiInstallPayload(base: string, token: string): AiInstallPayload {
  const tok = token || ''
  return {
    base,
    token: tok,
    hasToken: Boolean(tok),
    mcpUrl: base + '/mcp',
    expertMcpUrl: base + '/api/experts/mcp',
    installScriptUrl: base + '/install-skill.sh',
    installPrompt: buildAiInstallPrompt(base, tok),
    version: AI_INSTALL_PROMPT_VERSION,
    tokenExpiresAt: null,
    tokenExpiryPolicy: 'never',
  }
}
