/**
 * onenat-workbuddy-web - 直连节点 SSRF 防护（task-53 V5）
 *
 * dshRef.kind='direct' 的 apiBaseUrl 由用户任意填写，服务端会向其发起 ping /fs 等请求并回读响应，
 * 等于把内网/云元数据探测能力交给了任何能配置直连节点的调用方。本模块在解析直连目标时校验地址：
 *  - 永远拒绝：链路本地段（含云元数据 169.254.169.254）、未指定地址、组播/保留段、元数据域名；
 *  - 默认拒绝：环回与内网段（127/8、10/8、172.16/12、192.168/16、100.64/10、IPv6 fc00::/7、fe80::/10）；
 *    本机/内网单机部署可用 WORKBUDDY_ALLOW_PRIVATE_DIRECT=1 显式放开（元数据段仍拒绝）。
 */

import { lookup } from 'node:dns/promises'

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SsrfBlockedError'
  }
}

/** 是否放行环回/内网直连（本机单机部署显式开关；云元数据段不受此开关影响） */
export function allowPrivateDirect(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.WORKBUDDY_ALLOW_PRIVATE_DIRECT || '').trim().toLowerCase())
}

function ipToLong(ip: string): number | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return undefined
  const parts = m.slice(1).map(Number)
  if (parts.some((n) => n > 255)) return undefined
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

function inCidr(ip: string, base: string, bits: number): boolean {
  const v = ipToLong(ip)
  const b = ipToLong(base)
  if (v === undefined || b === undefined) return false
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0
  return (v & mask) === (b & mask)
}

/** 单个 IP 字面量是否被禁止作为直连目标。返回 null=允许，否则为拒绝原因 */
export function blockedIpReason(ip: string): string | null {
  const reasonMetadata = '保留/元数据段'
  const reasonPrivate = '内网/环回段'
  const v4 = ipToLong(ip)
  if (v4 !== undefined) {
    if (inCidr(ip, '169.254.0.0', 16)) return reasonMetadata // 链路本地：AWS/GCP/阿里云元数据 169.254.169.254
    if (v4 === 0 || inCidr(ip, '0.0.0.0', 8)) return reasonMetadata // 未指定地址
    if (inCidr(ip, '224.0.0.0', 4)) return reasonMetadata // 组播/保留
    if (inCidr(ip, '255.255.255.255', 32)) return reasonMetadata
    if (inCidr(ip, '100.64.0.0', 10)) return allowPrivateDirect() ? null : reasonPrivate // CGNAT（Tailscale 等属内网语义）
    if (inCidr(ip, '10.0.0.0', 8) || inCidr(ip, '172.16.0.0', 12) || inCidr(ip, '192.168.0.0', 16)) return allowPrivateDirect() ? null : reasonPrivate
    if (inCidr(ip, '127.0.0.0', 8)) return allowPrivateDirect() ? null : reasonPrivate
    return null
  }
  const lower = ip.toLowerCase()
  if (lower === '::' || lower === '::1') return allowPrivateDirect() ? null : reasonPrivate
  const v6 = lower.replace(/^\[[^\]]*\]$/, (m) => m) // 已是裸地址
  if (/^f[de]/.test(v6)) return allowPrivateDirect() ? null : reasonPrivate // fc00::/7 unique-local、fe80::/10 link-local
  if (/^ff/.test(v6)) return reasonMetadata // 组播
  return null
}

/** 元数据专用域名（无论开关一律拒绝） */
const BLOCKED_HOSTNAMES = new Set(['metadata', 'metadata.google.internal', 'instance-data', '100.100.100.200'])

export interface DirectUrlCheckResult {
  /** 校验通过后的规范化 base（去尾斜杠） */
  normalized: string
}

/**
 * 校验用户提供的直连节点 base URL 是否允许作为服务端出站目标。
 * 域名会做 DNS 解析并校验全部地址（解析失败视为不允许——无法证明其非内网）。
 * 抛出 SsrfBlockedError 表示拒绝。
 */
export async function assertDirectBaseUrlAllowed(rawUrl: string): Promise<DirectUrlCheckResult> {
  const trimmed = String(rawUrl || '').trim()
  let u: URL
  try {
    u = new URL(trimmed)
  } catch {
    throw new SsrfBlockedError(`直连节点地址非法: ${trimmed.slice(0, 120)}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new SsrfBlockedError(`直连节点仅允许 http/https: ${u.protocol}`)
  }
  const hostname = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new SsrfBlockedError(`直连节点禁止指向云元数据地址: ${hostname}`)
  }
  const literal = blockedIpReason(hostname)
  if (literal) throw new SsrfBlockedError(`直连节点地址被安全策略拒绝（${literal}）: ${hostname}`)
  if (!literal && /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    // 合法 IPv4 字面量
  } else if (!hostname.includes(':')) {
    // 域名：解析全部地址逐一校验（防内网域名/解析到内网 IP）
    let addrs: Array<{ address: string }> = []
    try {
      addrs = await lookup(hostname, { all: true, verbatim: true })
    } catch (err: any) {
      throw new SsrfBlockedError(`直连节点域名解析失败（不解析不发放出站许可）: ${hostname} · ${err?.message || err}`)
    }
    for (const a of addrs) {
      const reason = blockedIpReason(a.address)
      if (reason) throw new SsrfBlockedError(`直连节点域名解析到被禁地址（${reason}）: ${hostname} → ${a.address}`)
    }
  }
  return { normalized: trimmed.replace(/\/+$/, '') }
}
