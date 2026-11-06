import { readFileSync } from 'node:fs'
import { posix, win32 } from 'node:path'
import type { DshClient, DshTarget } from './remote-client.js'
import type { DshRef } from './types.js'

export const WORKSPACE_ACCESS_CLI_NAME = '.workbuddy-workspace-remote-v3.mjs'
const WORKSPACE_ACCESS_CLI_BASENAME = /^\.workbuddy-workspace-remote-v3(?:-[1-9]\d*)?\.mjs$/

/** DSH numbers a repeated upload in a shared cwd instead of overwriting it. */
export function isWorkspaceAccessCliPath(value: string): boolean {
  const paths = /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value) ? win32 : posix
  return paths.isAbsolute(value) && !value.includes('\0') && WORKSPACE_ACCESS_CLI_BASENAME.test(paths.basename(value))
}

/** Quote one literal POSIX shell argument, including credentials and paths. */
export function workspaceShellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'"
}

export interface WorkspaceAccessOptions {
  workspace: string
  baseUrl: string
  apiKey?: string
  cliPath?: string
  /** File owner's stable identity; app references must resolve to one mapping. */
  nodeRef?: DshRef
  onenatBaseUrl?: string
  onenatApiKey?: string
}

/** Install the credential-free helper in the receiving session, never in the remote project. */
export async function installWorkspaceAccessCli(client: DshClient, target: DshTarget, sessionId: string): Promise<string | undefined> {
  try {
    const data = readFileSync(new URL('../scripts/workspace-remote.mjs', import.meta.url))
    const out = await client.uploadFiles(target, sessionId, [{ filename: WORKSPACE_ACCESS_CLI_NAME, data, mimeType: 'text/javascript' }])
    return out.ok ? out.files?.find((file) => WORKSPACE_ACCESS_CLI_BASENAME.test(file.name) && isWorkspaceAccessCliPath(file.path) && (file.path.replace(/\\/g, '/').split('/').pop() === file.name))?.path : undefined
  } catch {
    return undefined
  }
}

/** Stable identity goes to the helper so a long turn never depends on a public port snapshot. */
export function buildWorkspaceAccessSection(options: WorkspaceAccessOptions): string {
  const { workspace, apiKey, cliPath } = options
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const auth = apiKey ? ` -H ${workspaceShellQuote(`Authorization: Bearer ${apiKey}`)}` : ''
  const lines = [
    '[项目工作区跨机访问]',
    `- 文件归属工作区: ${JSON.stringify(workspace)}；当前会话可在另一节点执行。该路径不是当前节点的本地 cwd。`,
    '- 项目文件与 backlog 的唯一事实源在文件归属节点；下载副本不会自动写回。',
  ]
  if (cliPath) {
    const ref = options.nodeRef
    const stable = ref && ref.kind !== 'direct'
    const locator = stable
      ? `--node-ref ${workspaceShellQuote(ref.kind === 'mapping' ? `mapping:${ref.mappingId}` : `app:${ref.appId}`)} --onenat-base ${workspaceShellQuote(options.onenatBaseUrl || '')}`
      : `--base ${workspaceShellQuote(baseUrl)}`
    const command = `WORKBUDDY_WORKSPACE_API_KEY=${workspaceShellQuote(apiKey || '')}${stable ? ` WORKBUDDY_ONENAT_API_KEY=${workspaceShellQuote(options.onenatApiKey || '')}` : ''} node ${workspaceShellQuote(cliPath)} ${locator} --root ${workspaceShellQuote(workspace)}`
    lines.push(
      `- 已安装远程工作区工具: ${JSON.stringify(cliPath)}（Node.js >=20）。先运行: ${command} --help`,
      `- 使用前缀: ${command}；按 --help 的参数执行 list/read/write/exec。`,
      stable
        ? '- 工具在每次请求（包括临时会话清理）前通过稳定节点引用重新查询 ONENAT；长回合也自动跟随端口变化。目录不可用、节点离线、app 对应多个映射时明确失败，不回退旧地址或其他节点。'
        : '- 此项目显式配置直连节点，工具使用该固定 API 地址；需要 ONENAT 端口漂移支持时应绑定 mapping。',
      '- read 返回 SHA256；write 必须携带该版本或明确声明目标不存在。冲突后重读，不能强制覆盖。',
      '- exec 在文件归属节点的根目录执行，命令用 argv 数组传入；按帮助提供路径 guards。构建、测试和 Git 操作通过该通道执行。',
      '- 操作通过文件节点临时 DSH 会话执行真实路径检查、协作锁和原子写入；节点缺能力、拒绝执行、超时或缺少有效结果时必须报告失败，不能据提示词推断成功。',
      '- 工具的工作区路径检查不等于任意命令的操作系统沙箱；仅运行用户授权的项目命令。',
    )
  } else {
    lines.push('- 远程操作工具未能安装：当前仅提供文件 HTTP 读取指引，写入和命令执行不可用；不要改在本机创建同路径目录。')
  }
  lines.push(
    `- 浏览目录: curl${auth} ${workspaceShellQuote(`${baseUrl}/fs/list?path=${encodeURIComponent(workspace)}&all=1`)}`,
    `- 下载文件: curl${auth} ${workspaceShellQuote(`${baseUrl}/fs/download?path=${encodeURIComponent(workspace + '/a.txt')}`)} -o a.txt`,
    '- 预览文本文件: 在下载 URL 末尾追加 &inline=1。HTTP path 必须是【绝对路径】，且需 URL 编码。',
    '- HTTP 文件浏览为原有节点文件服务；需要路径边界保证时使用远程工具，不跟随工作区外符号链接。',
    '- 上述 HTTP 浏览/下载 URL 仅是本轮快照；ONENAT 项目持续访问请使用带稳定引用的远程工具，不能缓存旧公网端口。',
  )
  return lines.join('\n')
}
