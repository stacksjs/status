import { describe, expect, test } from 'bun:test'
import { buildMonitorConfig, coerceCheckbox, intInRange, isMonitorType, MONITOR_TYPES, parseMonitorForm, parsePortList } from '../../app/lib/monitorForm'

/** A minimally valid submission; individual tests override one field. */
function form(overrides: Record<string, unknown> = {}) {
  return { name: 'Checkout API', url: 'https://api.example.com', type: 'uptime', check_interval_seconds: '60', ...overrides }
}

describe('coerceCheckbox', () => {
  test('absent means unchecked (browsers omit unchecked boxes entirely)', () => {
    expect(coerceCheckbox(undefined)).toBe(false)
    expect(coerceCheckbox(null)).toBe(false)
    expect(coerceCheckbox('')).toBe(false)
  })

  test('present means checked, whatever the value attribute says', () => {
    expect(coerceCheckbox('on')).toBe(true)
    expect(coerceCheckbox('true')).toBe(true)
    expect(coerceCheckbox('1')).toBe(true)
    expect(coerceCheckbox('yes')).toBe(true)
  })

  test('explicit falsey strings are false - the trap that kept disabled monitors running', () => {
    // A select posting "false" (as the enabled dropdown does) must actually
    // disable: `where('enabled', true)` would otherwise still match the
    // truthy string "false".
    expect(coerceCheckbox('false')).toBe(false)
    expect(coerceCheckbox('0')).toBe(false)
    expect(coerceCheckbox('off')).toBe(false)
    expect(coerceCheckbox('no')).toBe(false)
    expect(coerceCheckbox('FALSE')).toBe(false)
  })

  test('honors the fallback only when absent', () => {
    expect(coerceCheckbox(undefined, true)).toBe(true)
    expect(coerceCheckbox('false', true)).toBe(false)
  })
})

describe('intInRange', () => {
  test('accepts integers inside the range', () => {
    expect(intInRange('60', 10, 86_400)).toBe(60)
    expect(intInRange(' 30 ', 10, 86_400)).toBe(30)
    expect(intInRange('10', 10, 86_400)).toBe(10)
  })

  test('rejects the values a naive Number() would let through', () => {
    // Number('') === 0 and Number('abc') === NaN; `NaN < floor` is false,
    // so both used to slip past the plan gate into an INTEGER column.
    expect(intInRange('', 10, 86_400)).toBeNull()
    expect(intInRange('abc', 10, 86_400)).toBeNull()
    expect(intInRange(undefined, 10, 86_400)).toBeNull()
    expect(intInRange('9', 10, 86_400)).toBeNull()
    expect(intInRange('99999999', 10, 86_400)).toBeNull()
    expect(intInRange('1.5', 1, 100)).toBeNull()
  })
})

describe('parsePortList', () => {
  test('parses separators, dedupes and sorts', () => {
    expect(parsePortList('22, 80,443')).toEqual([22, 80, 443])
    expect(parsePortList('443 22 443')).toEqual([22, 443])
  })

  test('drops out-of-range and non-numeric entries', () => {
    expect(parsePortList('0, 22, 70000, http')).toEqual([22])
    expect(parsePortList('')).toEqual([])
    expect(parsePortList(undefined)).toEqual([])
  })
})

describe('isMonitorType', () => {
  test('accepts every enum value and nothing else', () => {
    for (const type of MONITOR_TYPES)
      expect(isMonitorType(type)).toBe(true)
    expect(isMonitorType('sql')).toBe(false)
    expect(isMonitorType('')).toBe(false)
    expect(isMonitorType(undefined)).toBe(false)
  })

  test('covers the 14 DB CHECK-constrained values', () => {
    expect(MONITOR_TYPES).toHaveLength(14)
  })
})

describe('buildMonitorConfig', () => {
  test('writes only keys meaningful for the type', () => {
    const cfg = buildMonitorConfig('tcp_port', { port: '5432', path: '/health', ping_count: '5' }, false)
    expect(cfg).toEqual({ port: 5432 })
  })

  test('omits blank fields so job defaults apply', () => {
    expect(buildMonitorConfig('tcp_port', { port: '' }, false)).toEqual({})
    expect(buildMonitorConfig('health', { path: '   ' }, false)).toEqual({})
  })

  test('health endpoints carry their secret and freshness window', () => {
    // The secret is what makes a spatie/laravel-health endpoint reachable at
    // all; without a form field it could only be set by writing config JSON.
    expect(buildMonitorConfig('health', { path: '/oh-dear-health-check-results', health_secret: 'sh4red', health_max_age_seconds: '300' }, false))
      .toEqual({ path: '/oh-dear-health-check-results', healthSecret: 'sh4red', healthMaxAgeSeconds: 300 })
  })

  test('health secret and freshness are omitted when blank, so defaults apply', () => {
    expect(buildMonitorConfig('health', { path: '/health', health_secret: '  ', health_max_age_seconds: '' }, false))
      .toEqual({ path: '/health' })
  })

  test('an out-of-range freshness window is dropped rather than stored', () => {
    expect(buildMonitorConfig('health', { health_max_age_seconds: '5' }, false)).toEqual({})
    expect(buildMonitorConfig('health', { health_max_age_seconds: '999999' }, false)).toEqual({})
  })

  test('health keys are not written for other types', () => {
    expect(buildMonitorConfig('uptime', { health_secret: 'x', health_max_age_seconds: '300' }, false)).toEqual({})
  })

  test('per-type keys use the names the jobs actually read', () => {
    expect(buildMonitorConfig('ping', { ping_count: '4', packet_loss_threshold_percent: '20' }, false))
      .toEqual({ pingCount: 4, packetLossThresholdPercent: 20 })
    expect(buildMonitorConfig('ssl', { alert_on_fingerprint_change: 'on' }, false))
      .toEqual({ alertOnFingerprintChange: true })
    expect(buildMonitorConfig('port_scan', { full_scan: 'on', expected_ports: '22,443' }, false))
      .toEqual({ fullScan: true, expectedPorts: [22, 443] })
    expect(buildMonitorConfig('lighthouse', { lighthouse_device: 'desktop' }, false))
      .toEqual({ device: 'desktop' })
    expect(buildMonitorConfig('dns_blocklist', { origin_ip: '203.0.113.10' }, false))
      .toEqual({ origin_ip: '203.0.113.10' })
  })

  test('latency threshold applies only to the request-shaped checks', () => {
    expect(buildMonitorConfig('uptime', { latency_threshold_ms: '800' }, false)).toEqual({ latencyThresholdMs: 800 })
    expect(buildMonitorConfig('dns', { latency_threshold_ms: '800' }, false)).toEqual({})
  })

  test('metric thresholds only when the host reports metrics', () => {
    expect(buildMonitorConfig('uptime', { cpu_threshold: '80', disk_threshold: '70' }, false)).toEqual({})
    expect(buildMonitorConfig('uptime', { cpu_threshold: '80', disk_threshold: '70' }, true))
      .toEqual({ cpuThreshold: 80, diskThreshold: 70 })
    // 0 is meaningful (disables that threshold), not "blank".
    expect(buildMonitorConfig('uptime', { cpu_threshold: '0' }, true)).toEqual({ cpuThreshold: 0 })
  })

  test('an unknown lighthouse device is ignored rather than stored', () => {
    expect(buildMonitorConfig('lighthouse', { lighthouse_device: 'watch' }, false)).toEqual({})
  })
})

describe('parseMonitorForm', () => {
  test('accepts a valid submission and stringifies config', () => {
    const result = parseMonitorForm(form({ type: 'tcp_port', url: 'db.example.com', port: '5432' }))
    expect(result.error).toBeNull()
    expect(result.values.name).toBe('Checkout API')
    expect(result.values.type).toBe('tcp_port')
    expect(result.values.check_interval_seconds).toBe(60)
    // config is a STRING column - an object here would store "[object Object]"
    // and every reader would silently try/catch it to {}.
    expect(typeof result.values.config).toBe('string')
    expect(JSON.parse(result.values.config)).toEqual({ port: 5432 })
  })

  test('defaults enabled to true, honors an explicit false', () => {
    expect(parseMonitorForm(form()).values.enabled).toBe(true)
    expect(parseMonitorForm(form({ enabled: 'false' })).values.enabled).toBe(false)
    expect(parseMonitorForm(form({ enabled: 'true' })).values.enabled).toBe(true)
  })

  test('rejects missing and oversized fields with a code per problem', () => {
    expect(parseMonitorForm(form({ name: '   ' })).error).toBe('name_required')
    expect(parseMonitorForm(form({ name: 'x'.repeat(151) })).error).toBe('name_too_long')
    expect(parseMonitorForm(form({ type: 'sql' })).error).toBe('type_invalid')
    expect(parseMonitorForm(form({ url: '' })).error).toBe('url_required')
    expect(parseMonitorForm(form({ url: `https://e.com/${'x'.repeat(2048)}` })).error).toBe('url_too_long')
  })

  test('fetching check types require an http(s) URL', () => {
    // Same guard the check jobs apply: Bun's fetch honors file:/data:, so a
    // file:// monitor URL would read local files.
    expect(parseMonitorForm(form({ type: 'uptime', url: 'file:///etc/passwd' })).error).toBe('url_scheme')
    expect(parseMonitorForm(form({ type: 'uptime', url: 'example.com' })).error).toBe('url_scheme')
    expect(parseMonitorForm(form({ type: 'health', url: 'https://example.com' })).error).toBeNull()
  })

  test('host-shaped check types accept a bare hostname', () => {
    expect(parseMonitorForm(form({ type: 'ping', url: 'example.com' })).error).toBeNull()
    expect(parseMonitorForm(form({ type: 'dns', url: 'example.com' })).error).toBeNull()
    expect(parseMonitorForm(form({ type: 'tcp_port', url: 'db.internal' })).error).toBeNull()
  })

  test('rejects an unusable interval instead of writing NaN', () => {
    expect(parseMonitorForm(form({ check_interval_seconds: '' })).error).toBe('interval_invalid')
    expect(parseMonitorForm(form({ check_interval_seconds: 'soon' })).error).toBe('interval_invalid')
    expect(parseMonitorForm(form({ check_interval_seconds: '5' })).error).toBe('interval_invalid')
  })

  test('cron monitors carry heartbeat attributes with documented defaults', () => {
    const bare = parseMonitorForm(form({ type: 'cron', url: 'jobs.example.com' }))
    expect(bare.error).toBeNull()
    expect(bare.heartbeat).toEqual({ expected_interval_seconds: 3600, grace_seconds: 300, cron_expression: null })

    const explicit = parseMonitorForm(form({
      type: 'cron',
      url: 'jobs.example.com',
      expected_interval_seconds: '86400',
      grace_seconds: '600',
      cron_expression: '0 3 * * *',
    }))
    expect(explicit.heartbeat).toEqual({ expected_interval_seconds: 86_400, grace_seconds: 600, cron_expression: '0 3 * * *' })
  })

  test('non-cron monitors carry no heartbeat', () => {
    expect(parseMonitorForm(form()).heartbeat).toBeNull()
  })
})
