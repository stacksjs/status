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
 * Whether `ip` matches any entry in `ranges`. Each entry is a bare address
 * or CIDR block, in either family:
 *   - IPv4:  "203.0.113.5" or "203.0.113.0/24"
 *   - IPv6:  "2001:db8::1" or "2001:db8::/32"
 *
 * Matching is family-aware: a range's family (v4 vs v6) is decided by
 * whether it contains a colon, and the visitor is compared only against
 * ranges of a family it has an address in. Malformed entries are skipped
 * (never a match), and an empty visitor or empty allowlist fails closed.
 *
 * NOTE: keep in sync with the inline copy in
 * resources/views/status/[slug].stx (the per-request gate — this module's
 * `isIpAllowed` is the canonical, unit-tested reference the view mirrors,
 * per the established self-contained-view convention).
 */
export function isIpAllowed(ip: string, ranges: string[]): boolean {
  if (!ip || ranges.length === 0) return false

  // Normalize the visitor into whichever families it can be compared in.
  // Bun's server.requestIP() reports IPv4 connections in IPv4-mapped IPv6
  // form ("::ffff:127.0.0.1"), and IPv6 loopback as "::1". We compute BOTH
  // representations where they exist so, e.g., an IPv4-mapped client
  // matches a plain "127.0.0.1/8" entry AND a "::ffff:0:0/96" entry, and
  // "::1" matches both "::1/128" and the localhost "127.0.0.1".
  let v4: number | null = null
  let v6: bigint | null = null

  const s = ip.trim()
  if (s.startsWith('::ffff:') && s.includes('.')) {
    v4 = ipv4ToInt(s.slice(7))
    v6 = ipv6ToBigInt(s)
  }
  else if (s === '::1') {
    v6 = ipv6ToBigInt(s)
    v4 = ipv4ToInt('127.0.0.1')
  }
  else if (s.includes(':')) {
    v6 = ipv6ToBigInt(s)
  }
  else {
    v4 = ipv4ToInt(s)
  }

  if (v4 === null && v6 === null) return false

  return ranges.some((range) => {
    const trimmed = range.trim()
    if (!trimmed) return false
    return trimmed.includes(':')
      ? (v6 !== null && matchCidr6(v6, trimmed))
      : (v4 !== null && matchCidr4(v4, trimmed))
  })
}

function matchCidr4(ipInt: number, range: string): boolean {
  if (!range.includes('/'))
    return ipv4ToInt(range) === ipInt

  const [base, bitsStr] = range.split('/')
  const baseInt = ipv4ToInt(base!)
  const bits = Number(bitsStr)
  if (baseInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false

  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0
  return (ipInt & mask) === (baseInt & mask)
}

function matchCidr6(ipBig: bigint, range: string): boolean {
  if (!range.includes('/')) {
    const only = ipv6ToBigInt(range)
    return only !== null && only === ipBig
  }

  const [base, bitsStr] = range.split('/')
  const baseBig = ipv6ToBigInt(base!)
  const bits = Number(bitsStr)
  if (baseBig === null || !Number.isInteger(bits) || bits < 0 || bits > 128) return false

  const full = (1n << 128n) - 1n
  const mask = bits === 0 ? 0n : (full << BigInt(128 - bits)) & full
  return (ipBig & mask) === (baseBig & mask)
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.trim().split('.')
  if (parts.length !== 4) return null

  let result = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n < 0 || n > 255) return null
    result = (result << 8) | n
  }
  return result >>> 0
}

/**
 * Parse an IPv6 address into a 128-bit BigInt, or null if malformed.
 * Handles "::" zero-compression (at most once), an optional embedded IPv4
 * tail ("::ffff:1.2.3.4"), and a "%zone" suffix (ignored). Groups are
 * 1-4 hex digits.
 */
function ipv6ToBigInt(ip: string): bigint | null {
  let s = ip.trim()
  const pct = s.indexOf('%')
  if (pct !== -1) s = s.slice(0, pct)
  if (s.length === 0 || s.includes(':::')) return null

  const doubleColon = s.indexOf('::')
  if (doubleColon !== -1 && s.indexOf('::', doubleColon + 1) !== -1) return null // more than one "::"

  // Expand an embedded IPv4 tail into two 16-bit hex groups.
  const expandTail = (groups: string[]): string[] | null => {
    if (groups.length === 0) return groups
    const last = groups[groups.length - 1]!
    if (!last.includes('.')) return groups
    const v4 = ipv4ToInt(last)
    if (v4 === null) return null
    const hi = (v4 >>> 16) & 0xFFFF
    const lo = v4 & 0xFFFF
    return [...groups.slice(0, -1), hi.toString(16), lo.toString(16)]
  }

  let groups: string[]
  if (doubleColon === -1) {
    const raw = s.split(':')
    const expanded = expandTail(raw)
    if (expanded === null || expanded.length !== 8) return null
    groups = expanded
  }
  else {
    const leftRaw = s.slice(0, doubleColon) ? s.slice(0, doubleColon).split(':') : []
    const rightRaw = s.slice(doubleColon + 2) ? s.slice(doubleColon + 2).split(':') : []
    const right = expandTail(rightRaw)
    if (right === null) return null
    const fill = 8 - leftRaw.length - right.length
    if (fill < 1) return null // "::" must stand for at least one zero group
    groups = [...leftRaw, ...Array.from({ length: fill }, () => '0'), ...right]
  }

  let result = 0n
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null
    result = (result << 16n) | BigInt(Number.parseInt(g, 16))
  }
  return result
}
