/**
 * Pure parsing + validation for the monitor create/edit dashboard forms.
 *
 * Native HTML forms post strings and omit unchecked checkboxes entirely, so
 * everything arrives as `string | undefined`. The JSON API's
 * CreateMonitorAction runs no validation at all (Monitor.create does not
 * execute the model's schema rules — only the auto-CRUD PATCH path does),
 * which is survivable for a curl caller reading docs but not for a form:
 * `enabled="on"` would store a truthy string, a blank interval would store
 * NaN in an INTEGER column, and a config object posted un-stringified would
 * store "[object Object]" that every reader silently try/catches to {}.
 * This module is where those traps are defused, and it is pure so the
 * defusing is unit-tested (same split as sslExpiry / consensusStatus).
 */

/** The monitor.type enum, DB CHECK-constrained. Order drives the form's select. */
export const MONITOR_TYPES = [
  'uptime',
  'ping',
  'tcp_port',
  'ssl',
  'domain',
  'dns',
  'dns_blocklist',
  'health',
  'cron',
  'performance',
  'lighthouse',
  'broken_links',
  'port_scan',
  'ai_check',
] as const

export type MonitorType = typeof MONITOR_TYPES[number]

/** Human labels, matching the wording the monitors list already uses. */
export const TYPE_LABELS: Record<MonitorType, string> = {
  uptime: 'Uptime (HTTP)',
  ping: 'Ping (ICMP)',
  tcp_port: 'TCP port',
  ssl: 'SSL certificate',
  domain: 'Domain expiry',
  dns: 'DNS records',
  dns_blocklist: 'DNS blocklist',
  health: 'Health check (JSON)',
  cron: 'Heartbeat / cron job',
  performance: 'Performance',
  lighthouse: 'Lighthouse audit',
  broken_links: 'Broken links crawl',
  port_scan: 'Port scan',
  ai_check: 'AI check',
}

/** Types whose `url` must be a full http(s) URL (the job fetches it). */
const NEEDS_HTTP_URL = new Set<string>(['uptime', 'health', 'lighthouse', 'broken_links', 'performance', 'ai_check', 'ssl'])

/** Types that accept a bare hostname (the job resolves/dials the host). */
const HOST_ONLY_OK = new Set<string>(['ping', 'tcp_port', 'port_scan', 'dns', 'domain', 'dns_blocklist', 'cron'])

export function isMonitorType(value: unknown): value is MonitorType {
  return typeof value === 'string' && (MONITOR_TYPES as readonly string[]).includes(value)
}

/**
 * HTML checkbox semantics: an unchecked box is absent from the body, a
 * checked one posts "on" (or whatever value= says). Anything absent, "0",
 * "false" or "off" is false; everything else present is true. Returning a
 * real boolean matters — `enabled` is an INTEGER column and the dispatcher
 * filters `where('enabled', true)`, so the string "false" would keep a
 * monitor the operator just disabled running forever.
 */
export function coerceCheckbox(raw: unknown, fallback = false): boolean {
  if (raw === undefined || raw === null || raw === '')
    return fallback
  if (typeof raw === 'boolean')
    return raw
  const value = String(raw).toLowerCase()
  return !(value === '0' || value === 'false' || value === 'off' || value === 'no')
}

/**
 * An integer inside [min, max], or null when absent/blank/unparseable.
 * Explicitly rejects NaN — `Number('') === 0` and `Number('abc') === NaN`
 * both slip past a naive `Number(x) < floor` guard.
 */
export function intInRange(raw: unknown, min: number, max: number): number | null {
  if (raw === undefined || raw === null || String(raw).trim() === '')
    return null
  const value = Number(String(raw).trim())
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max)
    return null
  return value
}

/** Comma/space separated port list -> unique sorted numbers in 1..65535. */
export function parsePortList(raw: unknown): number[] {
  if (raw === undefined || raw === null)
    return []
  return [...new Set(
    String(raw)
      .split(/[\s,]+/)
      .map(part => Number(part.trim()))
      .filter(port => Number.isInteger(port) && port >= 1 && port <= 65535),
  )].sort((a, b) => a - b)
}

export interface MonitorFormInput {
  name?: unknown
  url?: unknown
  type?: unknown
  enabled?: unknown
  check_interval_seconds?: unknown
  reports_metrics?: unknown
  // type-specific / advanced
  port?: unknown
  path?: unknown
  ping_count?: unknown
  packet_loss_threshold_percent?: unknown
  latency_threshold_ms?: unknown
  full_scan?: unknown
  expected_ports?: unknown
  alert_on_fingerprint_change?: unknown
  origin_ip?: unknown
  lighthouse_device?: unknown
  cpu_threshold?: unknown
  ram_threshold?: unknown
  disk_threshold?: unknown
  // heartbeat (type: cron)
  expected_interval_seconds?: unknown
  grace_seconds?: unknown
  cron_expression?: unknown
}

export interface MonitorFormResult {
  /** Snake_case attributes ready for Monitor.create/update. */
  values: {
    name: string
    url: string
    type: MonitorType
    enabled: boolean
    check_interval_seconds: number
    config: string
    reports_metrics: boolean
  }
  /** Heartbeat row attributes, only for type 'cron'. */
  heartbeat: { expected_interval_seconds: number, grace_seconds: number, cron_expression: string | null } | null
  /** Snake_case error code for the ?error= redirect, or null when valid. */
  error: string | null
}

/**
 * Heartbeat row attributes for a monitor, or null when the type doesn't take
 * one. Shared by the dashboard form and the API's CreateMonitorAction so both
 * entry points apply the same cadence/grace defaults — a 'cron' monitor
 * without this row is inert (DispatchDueChecks has no cron entry, and
 * CheckOverdueHeartbeats iterates HeartbeatMonitor), so it can never alert.
 *
 * Defaults match docs/monitors/cron-heartbeats.md: hourly cadence, 5-minute
 * grace, no cron expression.
 */
export function heartbeatAttributesFor(type: MonitorType, input: MonitorFormInput): MonitorFormResult['heartbeat'] {
  if (type !== 'cron')
    return null
  const expected = intInRange(input.expected_interval_seconds, 60, 31_536_000) ?? 3600
  const grace = intInRange(input.grace_seconds, 0, 86_400) ?? 300
  const cron = String(input.cron_expression ?? '').trim()
  return { expected_interval_seconds: expected, grace_seconds: grace, cron_expression: cron || null }
}

/**
 * Build the per-type `config` JSON. Only keys meaningful for `type` are
 * written, so switching a monitor's type doesn't leave stale keys behind,
 * and a key the operator left blank is omitted entirely (every job reader
 * falls back to its own documented default rather than to a null).
 */
export function buildMonitorConfig(type: MonitorType, input: MonitorFormInput, reportsMetrics: boolean): Record<string, unknown> {
  const config: Record<string, unknown> = {}

  if (type === 'tcp_port') {
    const port = intInRange(input.port, 1, 65535)
    if (port !== null)
      config.port = port
  }

  if (type === 'health') {
    const path = String(input.path ?? '').trim()
    if (path)
      config.path = path
  }

  if (type === 'ping') {
    const count = intInRange(input.ping_count, 1, 10)
    if (count !== null)
      config.pingCount = count
    const loss = intInRange(input.packet_loss_threshold_percent, 0, 100)
    if (loss !== null)
      config.packetLossThresholdPercent = loss
  }

  if (type === 'port_scan') {
    if (coerceCheckbox(input.full_scan))
      config.fullScan = true
    const expected = parsePortList(input.expected_ports)
    if (expected.length > 0)
      config.expectedPorts = expected
  }

  if (type === 'ssl' && coerceCheckbox(input.alert_on_fingerprint_change))
    config.alertOnFingerprintChange = true

  if (type === 'dns_blocklist') {
    const ip = String(input.origin_ip ?? '').trim()
    if (ip)
      config.origin_ip = ip
  }

  if (type === 'lighthouse') {
    const device = String(input.lighthouse_device ?? '').trim()
    if (device === 'desktop' || device === 'mobile')
      config.device = device
  }

  // Latency degradation applies to the request-shaped checks.
  if (type === 'uptime' || type === 'tcp_port' || type === 'health' || type === 'ping') {
    const latency = intInRange(input.latency_threshold_ms, 0, 600_000)
    if (latency !== null)
      config.latencyThresholdMs = latency
  }

  // Agent-pushed resource thresholds are orthogonal to type.
  if (reportsMetrics) {
    const cpu = intInRange(input.cpu_threshold, 0, 100)
    if (cpu !== null)
      config.cpuThreshold = cpu
    const ram = intInRange(input.ram_threshold, 0, 100)
    if (ram !== null)
      config.ramThreshold = ram
    const disk = intInRange(input.disk_threshold, 0, 100)
    if (disk !== null)
      config.diskThreshold = disk
  }

  return config
}

/**
 * Validate and normalize a submitted monitor form. Returns the first error
 * code rather than a field map: the no-JS form renders one `.flash.error`
 * banner, and a code keeps the message wording in the view where the rest
 * of the copy lives.
 */
export function parseMonitorForm(input: MonitorFormInput): MonitorFormResult {
  const name = String(input.name ?? '').trim()
  const url = String(input.url ?? '').trim()
  const type = input.type

  const fail = (error: string): MonitorFormResult => ({
    values: { name, url, type: isMonitorType(type) ? type : 'uptime', enabled: true, check_interval_seconds: 60, config: '{}', reports_metrics: false },
    heartbeat: null,
    error,
  })

  if (!name)
    return fail('name_required')
  if (name.length > 150)
    return fail('name_too_long')
  if (!isMonitorType(type))
    return fail('type_invalid')
  if (!url)
    return fail('url_required')
  if (url.length > 2048)
    return fail('url_too_long')

  if (NEEDS_HTTP_URL.has(type)) {
    let parsed: URL | null = null
    try {
      parsed = new URL(url)
    }
    catch {
      parsed = null
    }
    // Scheme-restricted for the same reason the check jobs are: Bun's fetch
    // honors file:/data:, so a file:// monitor URL would read local files.
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:'))
      return fail('url_scheme')
  }
  else if (!HOST_ONLY_OK.has(type) && !/^[\w.-]+$/.test(url)) {
    return fail('url_invalid')
  }

  // The model floors this at 10s; the caller additionally enforces the
  // team's plan floor, which it cannot do here (it needs a DB read).
  const interval = intInRange(input.check_interval_seconds, 10, 86_400)
  if (interval === null)
    return fail('interval_invalid')

  const reportsMetrics = coerceCheckbox(input.reports_metrics)
  const config = buildMonitorConfig(type, input, reportsMetrics)

  const heartbeat = heartbeatAttributesFor(type, input)

  return {
    values: {
      name,
      url,
      type,
      enabled: coerceCheckbox(input.enabled, true),
      check_interval_seconds: interval,
      config: JSON.stringify(config),
      reports_metrics: reportsMetrics,
    },
    heartbeat,
    error: null,
  }
}
