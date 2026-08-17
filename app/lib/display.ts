/**
 * Presentation helpers shared by the dashboard and public status views.
 *
 * These existed as 31 copy-pasted definitions across 9 `.stx` server blocks
 * and had drifted into contradictions — `stLabel` had three versions, so the
 * same paused monitor read "Paused" on its detail page, "Pending" on the
 * monitors list and "Unknown" on a status page. Consolidating them here is
 * the point of migration Phase 5: server blocks can import app/ TS directly.
 *
 * Where copies differed for a real reason (a public status page formats dates
 * in the page's configured locale and shows the year; the dashboard does not)
 * the difference is an argument, not a second function.
 */

/** Values `monitors.status` is constrained to; anything else is a data bug. */
export type MonitorStatus = 'up' | 'down' | 'degraded' | 'paused' | 'unknown'

/** Pill class for a monitor status. Mirrors the `pill-*` CSS in the views. */
export function statusPillClass(status: string | null | undefined): string {
  if (status === 'up')
    return 'pill pill-up'
  if (status === 'degraded')
    return 'pill pill-degraded'
  if (status === 'down')
    return 'pill pill-down'
  return 'pill pill-unknown'
}

/**
 * Human label for a monitor status.
 *
 * Covers every value the column allows, including `paused` (three of the six
 * former copies silently fell through to their default for it). The fallback
 * is "Unknown" to match both the column's own default and the `pill-unknown`
 * class the same row already carries — the previous "Pending" implied a check
 * was on its way, which is not what `unknown` means.
 */
export function statusLabel(status: string | null | undefined): string {
  if (status === 'up')
    return 'Up'
  if (status === 'degraded')
    return 'Degraded'
  if (status === 'down')
    return 'Down'
  if (status === 'paused')
    return 'Paused'
  return 'Unknown'
}

/** Coarse relative time: "45s ago", "3m ago", "2h ago", "5d ago". */
export function relativeTime(iso: string | null | undefined, empty = 'never', now = Date.now()): string {
  if (!iso)
    return empty
  const then = new Date(iso).getTime()
  if (Number.isNaN(then))
    return empty
  const s = Math.max(0, Math.floor((now - then) / 1000))
  if (s < 60)
    return `${s}s ago`
  if (s < 3600)
    return `${Math.floor(s / 60)}m ago`
  if (s < 86_400)
    return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

export interface FormatDateOptions {
  /** BCP-47 tag; public status pages pass the page's configured locale. */
  locale?: string
  /** Include the year — incident permalinks do, dashboard tables do not. */
  year?: boolean
  /** Force 12/24-hour. Omitted means "whatever the locale does". */
  hour12?: boolean
  /** Rendered when the timestamp is missing or unparseable. */
  empty?: string
}

/**
 * Short date-time, e.g. "Aug 17 at 7:40 PM". Unparseable input renders as
 * `empty` rather than the string "Invalid Date" — two of the four former
 * copies had no such guard.
 */
export function formatDateTime(iso: string | null | undefined, options: FormatDateOptions = {}): string {
  const { locale = 'en-US', year = false, hour12, empty = '--' } = options
  if (!iso)
    return empty
  const d = new Date(iso)
  if (Number.isNaN(d.getTime()))
    return empty
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
  if (year)
    opts.year = 'numeric'
  if (hour12 !== undefined)
    opts.hour12 = hour12
  return d.toLocaleString(locale, opts)
}

/**
 * Calendar date only, "2026-08-17". Deliberately the raw ISO prefix rather
 * than a localized date: it is used for audit-ish columns (passkey created,
 * member joined) where an unambiguous, sortable date beats a pretty one.
 */
export function isoDate(iso: string | null | undefined, empty = '--'): string {
  if (!iso)
    return empty
  return String(iso).slice(0, 10)
}

/**
 * Hostname a monitor URL belongs to, used to group checks under one "site".
 *
 * Split-based rather than a `/[/:?#]/` character class: an unescaped slash
 * inside a regex character class confuses stx's `<script>` boundary scanner
 * and makes the whole server block fail to evaluate. `new URL()` is likewise
 * avoided — it throws on the bare-hostname monitors (ping, tcp_port, dns)
 * this also has to handle.
 */
export function siteHost(url: string | null | undefined): string {
  let h = String(url ?? '').replace(/^https?:\/\//i, '')
  h = h.split('/')[0].split('?')[0].split('#')[0].split(':')[0]
  return h.replace(/^www\./i, '').toLowerCase() || 'unknown'
}

/** URL-safe slug for a host, as used in /dashboard/sites/{slug}. */
export function siteSlug(host: string | null | undefined): string {
  return String(host ?? '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()
}
