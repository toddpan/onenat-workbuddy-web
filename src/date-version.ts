/**
 * onenat-workbuddy-web - 版本维护工具
 *
 * 版本号采用日期发布风格：YYYY.M.D（如 2026.9.15）。
 * 单一事实来源为 package.json 的 version 字段：
 *   - 读取: readPackageVersion()（就近向上找 package.json，兼容 dist/ 与 lib/ 两种部署位置）
 *   - 展示: formatDateVersion() 归一化为 YYYY.M.D（无月份时视为 1 月）
 *   - 升级: npm run version:bump [-- y.m.d]（写回 package.json）
 */

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface DateVersionParts {
  year: number
  month: number
  day: number
}

/** 向上查找并解析 package.json 的 version 字段（找不到返回 '0.0.0'） */
export function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  for (let d = here; ; ) {
    const candidate = join(d, 'package.json')
    if (existsSync(candidate)) {
      try {
        const v = JSON.parse(readFileSync(candidate, 'utf-8')).version
        if (typeof v === 'string' && v) return v
      } catch {
        /* 继续向上找 */
      }
    }
    const parent = dirname(d)
    if (parent === d) break
    d = parent
  }
  return '0.0.0'
}

/**
 * 把任意版本号归一化为日期版本展示串。
 *   '2026.9.15' → '2026.9.15'
 *   '2026-09-15' → '2026.9.15'
 *   '2026.09.15' → '2026.9.15'（去零）
 *   '2026.9' → '2026.9.1'（缺月/日补 1）
 *   其它形式 → 原样透传（兼容语义化版本号）
 */
export function formatDateVersion(version: string): string {
  const raw = String(version || '').trim()
  const m = /^(\d{4})[.\-/](\d{1,2})(?:[.\-/](\d{1,2}))?$/.exec(raw)
  if (!m) return raw
  const year = Number(m[1])
  const month = Number(m[2])
  const day = m[3] ? Number(m[3]) : 1
  if (month < 1 || month > 12 || day < 1 || day > 31) return raw
  return `${year}.${month}.${day}`
}

/** 解析日期版本为各段（非法时返回 null） */
export function parseDateVersion(version: string): DateVersionParts | null {
  const m = /^(\d{4})[.\-/](\d{1,2})(?:[.\-/](\d{1,2}))?$/.exec(String(version || '').trim())
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = m[3] ? Number(m[3]) : 1
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return { year, month, day }
}

/** 日期版本升序比较：a < b → -1，相等 → 0，a > b → 1（无法解析时按字符串比较） */
export function compareDateVersion(a: string, b: string): number {
  const pa = parseDateVersion(a)
  const pb = parseDateVersion(b)
  if (!pa || !pb) return String(a).localeCompare(String(b))
  return pa.year - pb.year || pa.month - pb.month || pa.day - pb.day
}

/** 生成下一个日期版本（y.m.d 三段均缺省则按今天本地时区） */
export function nextDateVersion(argv?: string[]): string {
  const today = new Date()
  let y = today.getFullYear()
  let m = today.getMonth() + 1
  let d = today.getDate()
  const arg = (argv || []).find((x) => x && !x.startsWith('-'))
  if (arg) {
    const parts = arg.split(/[.\-/]/).map((x) => Number(x))
    const given = parts.filter((x) => Number.isFinite(x))
    if (given.length === 0) throw new Error(`无法解析日期版本: ${arg}`)
    if (given.length >= 1) y = given[0]
    if (given.length >= 2) m = given[1]
    if (given.length >= 3) d = given[2]
  }
  if (y < 1000 || m < 1 || m > 12 || d < 1 || d > 31) throw new Error(`非法日期版本: ${y}.${m}.${d}`)
  return `${y}.${m}.${d}`
}

/** 写回 package.json 的 version 字段（找不到 package.json 时抛错） */
export function writePackageVersion(version: string): string {
  const here = dirname(fileURLToPath(import.meta.url))
  for (let d = here; ; ) {
    const candidate = join(d, 'package.json')
    if (existsSync(candidate)) {
      const raw = readFileSync(candidate, 'utf-8')
      const pkg = JSON.parse(raw)
      pkg.version = version
      writeFileSync(candidate, JSON.stringify(pkg, null, 2) + '\n', 'utf-8')
      return candidate
    }
    const parent = dirname(d)
    if (parent === d) break
    d = parent
  }
  throw new Error('未找到 package.json，无法写回版本')
}

/** CLI: npm run version:bump [-- y.m.d] */
const isDirectRun = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
})()

if (isDirectRun) {
  const version = nextDateVersion(process.argv.slice(2))
  const file = writePackageVersion(version)
  console.log(`version: ${version}  (${file})`)
}
