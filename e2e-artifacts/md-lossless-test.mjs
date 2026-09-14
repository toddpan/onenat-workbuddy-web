/**
 * 从「真实渲染出的控制台 UI」里抽出 markdown 渲染链路（esc/md/parseInline/parseBlocks/withFileLinks），
 * 对真实 AI 输出做「无损性」校验：markdown 渲染不得吞掉任何正文内容。
 *
 * 用法: node e2e-artifacts/md-lossless-test.mjs [uiHtml] [sampleTextFile]
 */
import { readFileSync } from 'node:fs'

const uiHtmlPath = process.argv[2] || '/tmp/wb-ui.html'
const sampleFile = process.argv[3]

const html = readFileSync(uiHtmlPath, 'utf-8')
const scriptMatch = /<script>([\s\S]*)<\/script>/.exec(html)
if (!scriptMatch) throw new Error('no <script> in rendered UI')
const script = scriptMatch[1]

/** 抽出顶层函数源码：从 `function NAME(` 到其后首个顶格 `}` 行（渲染产物里顶层函数均顶格收尾） */
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`function ${name} not found`)
  const end = src.indexOf('\n}', start)
  if (end < 0) throw new Error(`unterminated function ${name}`)
  return src.slice(start, end + 2)
}
function extractConst(src, name) {
  const m = new RegExp(`const ${name}\\s*=\\s*[\\s\\S]*?;\\n`).exec(src)
  if (!m) throw new Error(`const ${name} not found`)
  return m[0]
}

const pieces = [
  extractConst(script, 'mdCache'),
  extractConst(script, 'FILE_LINK_RE'),
  extractFunction(script, 'esc'),
  extractFunction(script, 'parseInline'),
  extractFunction(script, 'parseBlocks'),
  extractFunction(script, 'md'),
  extractFunction(script, 'withFileLinks'),
].join('\n')

const factory = new Function('location', 'API', `
  ${pieces}
  return { md, withFileLinks, esc };
`)
const { md, withFileLinks } = factory({ origin: 'http://127.0.0.1:3081' }, '/onenat-workbuddy/api')

/** 把 HTML 还原成纯文本（去标签 + 反转义）用于无损比对 */
function htmlToText(h) {
  return String(h)
    .replace(/<button[\s\S]*?<\/button>/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}
/** 归一化：去掉 markdown 语法字符与空白，仅留「正文语义字符」用于无损比对 */
const norm = (s) => String(s).replace(/[`*|#>~_\-\s\[\]()]/g, '')

/** 检查原文本的每一段是否都在渲染结果中出现 */
function checkLossless(src, outHtml, label) {
  const rendered = norm(htmlToText(outHtml))
  const srcNorm = norm(src)
  const problems = []
  for (const line of String(src).split('\n')) {
    const t = norm(line)
    if (t.length < 4) continue
    if (!rendered.includes(t)) problems.push(line.slice(0, 100))
  }
  console.log(`--- ${label}`)
  console.log('    原文非空白字符数 :', srcNorm.length)
  console.log('    渲染后字符数     :', rendered.length)
  console.log('    渲染后包含全文   :', rendered.includes(srcNorm) ? '是' : '否')
  console.log('    行级丢失数量     :', problems.length)
  for (const p of problems.slice(0, 8)) console.log('      ✗', JSON.stringify(p))
  return { lossless: problems.length === 0, missing: problems }
}

// ---------------- 样本 ----------------

// S1: 真实模型输出风格（代码块 + 表格 + 长正文）
const S1 = `**第 1 步输出：\`1789389293\`**

这是当前时刻的 Unix 时间戳，表示自 1970-01-01 00:00:00 UTC 起经过的秒数。

\`\`\`bash
$ date +%s
1789389293
\`\`\`

**第 2 步输出：**
\`\`\`
ActionStageHandler_deploy.log
com.apple.launchd.abc
\`\`\`

| 命令 | 作用 | 输出 |
|---|---|---|
| date +%s | 取当前时间戳 | 1789389293 |
| ls /tmp | 列临时目录 | 5 个条目 |
| uname -a | 系统身份 | Darwin 24.6.0 |

**第 3 步输出：** \`Darwin tsbjdeMacBook-Air.local 24.6.0 arm64\`

最后，我用不少于 400 字总结：这三条命令分别做了三件事——检查时间、文件系统、系统身份。
这类探测命令成本极低、没有副作用，却能为后续操作建立可信前提。
整轮执行严格遵循了用户的顺序要求，三条命令均为真实调用，输出未经任何修饰或虚构。
收尾的一句必须完整可见，否则就是渲染层吞掉了尾巴。`

// S2: 未闭合代码围栏（流式中途截断的典型形态）
const S2 = `先看看源码结构：

\`\`\`ts
import { x } from 'y'
export function f() {
  return 1
}
`

// S3: 含表格且表格后还有正文
const S3 = `汇总如下：

| 项 | 值 |
|---|---|
| A | 1 |
| B | 2 |

表格之后这段文字也必须完整显示出来，不能被吞掉。`

// S4: 长文本（触发 md 缓存 key 分支 > 5000 字符）
const S4 = ('这是一段很长的中文正文，用于触发 markdown 缓存的长文本分支。'.repeat(220)) + '\n\n结尾标记-END-MARKER-12345'

const cases = [
  ['S1 真实输出风格', S1],
  ['S2 未闭合代码围栏', S2],
  ['S3 表格后正文', S3],
  ['S4 超长文本(>5000)', S4],
]
if (sampleFile) cases.push(['样本文件', readFileSync(sampleFile, 'utf-8')])

let allOk = true
for (const [label, src] of cases) {
  const out = md(withFileLinks('task-x', 'agent-y', src))
  const r = checkLossless(src, out, label)
  if (!r.lossless) allOk = false
}
console.log('\n' + (allOk ? '✅ 全部样本渲染无损' : '⚠️ 存在渲染丢内容样本'))
process.exit(allOk ? 0 : 2)
