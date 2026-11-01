/**
 * onenat-workbuddy-web - 敏感数据文件权限基线（task-54 V2）
 *
 * store.json / SSH 凭据库 / 插件库索引 / 监控事件等数据文件含明文凭据与业务数据，
 * 统一按 0600 落盘（数据目录 0700）；启动时对存量文件做一次 chmod 收紧。
 * Windows 无 POSIX 权限语义：chmod 静默忽略（不报错、不阻断业务）。
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const PRIVATE_FILE_MODE = 0o600
export const PRIVATE_DIR_MODE = 0o700

/** 新建数据目录（0700）；已存在不动 */
export function ensurePrivateDir(dir: string): void {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE })
  } catch { /* 目录创建失败由后续写盘报错 */ }
}

/** 收紧单个已存在文件的权限为 0600（不存在或 chmod 失败均静默） */
export function hardenFile(path: string): void {
  try {
    if (existsSync(path)) chmodSync(path, PRIVATE_FILE_MODE)
  } catch { /* Windows / 只读文件系统：忽略 */ }
}

/** 收紧目录下全部常规文件为 0600（一级目录；递归一层子目录，覆盖 archive/ 等） */
export function hardenDirFiles(dir: string, depth = 1): void {
  try {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      try {
        const st = statSync(p)
        if (st.isFile()) hardenFile(p)
        else if (st.isDirectory() && depth > 0) hardenDirFiles(p, depth - 1)
      } catch { /* 单个条目失败不影响其它 */ }
    }
  } catch { /* 目录不可读：忽略 */ }
}
