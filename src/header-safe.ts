/**
 * onenat-workbuddy-web - HTTP 头安全字符校验（API Key / Bearer Token 防天书报错）
 *
 * 背景（2026-11-06 线上事故）：pjy-DSH 映射在 ONENAT 后台的 API Key 被误粘贴成一段
 * 中文文本（368 字符，首字「四」U+56DB）。WorkBuddy 构造 Authorization: Bearer <key> 时，
 * undici fetch 因头值含 >0xFF 字符直接抛：
 *   "Cannot convert argument to a ByteString because the character at index 7 has a
 *    value of 22235 which is greater than 255."
 * ——「从远程 DSH 导入项目 → 获取工作区列表」整条链路（模型列表 / 工作区列表 / 任务派发）
 * 全部只给用户看到这句天书，无从知道要去 ONENAT 后台改凭证。
 *
 * 本模块把「凭证内容非法」变成早期、可操作的失败：
 *  - onenat.ts 凭证拉取层：坏凭证 -> ok:false + 中文指引（不进 credLastGood）；
 *  - remote-client.ts 头构造层：兜底抛友好错误（覆盖子智能体自带 apiKey 等其它来源）。
 *
 * HTTP 头值合法字符：RFC 7230 field-vchar（0x21-0x7E）+ 空格/HTAB。API Key 这类
 * 单词型取值按更严的可打印 ASCII（0x20-0x7E）校验即可 —— Authorization: Basic/Bearer
 * 场景下 Latin-1 高位字符（0x80-0xFF）同样会让 undici 抛 ByteString 错误。
 */

export interface UnsafeChar {
  /** 字符串中的下标 */
  index: number
  /** 码点（十进制） */
  code: number
  /** 该字符本身 */
  ch: string
}

/** 返回第一个不能安全放进 HTTP 头值的字符；全部安全返回 undefined。 */
export function firstUnsafeHeaderChar(s: string): UnsafeChar | undefined {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    // 代理对（emoji 等）与 Latin-1 高位字符一样不安全；charCodeAt 按 UTF-16 半边检查即可
    if (code < 0x20 || code > 0x7e) return { index: i, code, ch: s[i] }
  }
  return undefined
}

/** 码点的面向用户写法：U+56DB / 22235 双格式（对齐浏览器原始报错，方便搜索定位） */
function codeLabel(code: number): string {
  return 'U+' + code.toString(16).toUpperCase().padStart(4, '0') + '（十进制 ' + code + '）'
}

/**
 * 生成坏 API Key 的可操作报错文案。预览截 12 字（控制字符转空格），
 * 帮助用户在 ONENAT 后台一眼认出「粘贴错了什么」。
 */
export function unsafeApiKeyError(field: string, value: string): string {
  const bad = firstUnsafeHeaderChar(value)
  if (!bad) return ''
  const preview = value.slice(0, 12).replace(/[\x00-\x1f]/g, ' ')
  return (
    field + '含非 ASCII 字符（第 ' + bad.index + ' 个字符 ' + codeLabel(bad.code) + " '" + bad.ch + "'；开头：" + preview + '…），' +
    '请到 ONENAT 后台修正该映射/应用的 API Key（疑似误粘贴了中文文本或含不可见字符）；若远端节点无需鉴权，可清除映射级凭证覆盖。'
  )
}
