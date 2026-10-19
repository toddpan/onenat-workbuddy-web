/**
 * onenat-workbuddy-web - 审计日志（B-03）
 *
 * 关键操作（邀请、入项、角色变更、禁用、归档等）追加落盘 dataDir/audit-log.json，
 * 管理端可查（GET /api/audit-log）。追加写、保留最近 1000 条，写失败不阻塞业务。
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface AuditEntry {
  id: string
  /** 操作者 userId（系统动作为 'system'） */
  actorId: string
  actorName?: string
  /** 如 user.invite / project.member.add / auth.password_reset */
  action: string
  targetType: string
  targetId: string
  detail?: string
  ip?: string
  createdAt: number
}

const AUDIT_MAX = 1000

export class AuditLog {
  private filePath: string

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'audit-log.json')
  }

  public record(e: Omit<AuditEntry, 'id' | 'createdAt'>): void {
    try {
      const entry: AuditEntry = { id: 'aud-' + randomBytes(5).toString('hex'), createdAt: Date.now(), ...e }
      const entries = this.read()
      entries.push(entry)
      const dir = dirname(this.filePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.filePath, JSON.stringify({ entries: entries.slice(-AUDIT_MAX) }, null, 2), { mode: 0o600 })
    } catch (err) {
      console.error('[onenat-workbuddy] audit-log 写入失败:', err)
    }
  }

  /** 最近记录（新的在前） */
  public list(limit = 100): AuditEntry[] {
    return this.read().slice(-Math.max(1, Math.min(limit, AUDIT_MAX))).reverse()
  }

  private read(): AuditEntry[] {
    try {
      if (existsSync(this.filePath)) {
        const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8'))
        return Array.isArray(parsed.entries) ? parsed.entries : []
      }
    } catch { /* 损坏即重建 */ }
    return []
  }
}
