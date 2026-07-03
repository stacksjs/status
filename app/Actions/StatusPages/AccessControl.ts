/**
 * Pure access-control checks for gated status pages (stacksjs/status#1
 * Phase 12). Kept as plain functions (not an Action) — reused both from
 * UnlockStatusPageAction and, inline/duplicated per the established
 * per-view convention (see resources/views/status/[slug].stx,
 * resources/views/index.stx), from the SSR script-server blocks that
 * render the gate.
 */

/**
 * Whether `email`'s domain is in `allowedDomains`. This is a SOFT gate —
 * it checks a self-reported email address, it does not verify the
 * visitor actually controls that address (no magic-link/OTP round trip).
 * Good enough to keep casual/accidental access out, not a substitute for
 * real identity verification. Documented here rather than silently
 * presented as secure, same as the invite-email-delivery gap noted
 * elsewhere in this app.
 */
export function isEmailDomainAllowed(email: string, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0) return false
  const at = email.lastIndexOf('@')
  if (at === -1) return false
  const domain = email.slice(at + 1).toLowerCase().trim()
  return allowedDomains.some(allowed => domain === allowed.toLowerCase().trim())
}

/**
 * Whether `ip` matches any entry in `ranges` — each entry either a bare
 * IPv4 address or IPv4 CIDR notation (e.g. "203.0.113.0/24"). IPv6 is not
 * supported (an IPv6 visitor against an IPv4-only allowlist always
 * fails closed, i.e. is denied) — a real gap, not a silent one; flagged
 * as a follow-up rather than half-implementing IPv6 CIDR math.
 */
export function isIpAllowed(ip: string, ranges: string[]): boolean {
  if (!ip || ranges.length === 0) return false

  // Bun's server.requestIP() reports IPv4 connections in IPv4-mapped
  // IPv6 notation ("::ffff:127.0.0.1"), not plain dotted-quad — strip the
  // prefix so an ordinary IPv4 allowlist entry still matches. The bare
  // IPv6 loopback ("::1") is treated as 127.0.0.1 too — the same "this is
  // localhost" case, just reported differently depending on how the
  // client connected. Anything else IPv6 is genuinely unsupported (see
  // the doc comment above) and fails closed.
  let normalized = ip
  if (normalized.startsWith('::ffff:')) normalized = normalized.slice(7)
  else if (normalized === '::1') normalized = '127.0.0.1'

  const ipInt = ipv4ToInt(normalized)
  if (ipInt === null) return false

  return ranges.some((range) => {
    const trimmed = range.trim()
    if (!trimmed) return false

    if (!trimmed.includes('/'))
      return ipv4ToInt(trimmed) === ipInt

    const [base, bitsStr] = trimmed.split('/')
    const baseInt = ipv4ToInt(base!)
    const bits = Number(bitsStr)
    if (baseInt === null || Number.isNaN(bits) || bits < 0 || bits > 32) return false

    const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0
    return (ipInt & mask) === (baseInt & mask)
  })
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.trim().split('.')
  if (parts.length !== 4) return null

  let result = 0
  for (const part of parts) {
    const n = Number(part)
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
    result = (result << 8) | n
  }
  return result >>> 0
}
