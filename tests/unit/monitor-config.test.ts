import { describe, expect, test } from 'bun:test'
import { applyLatencyThreshold, applyPingDegradation, configBool, configNumber, parseMonitorConfig } from '../../app/lib/monitorConfig'

describe('parseMonitorConfig / configNumber / configBool', () => {
  test('parses valid JSON, tolerates missing/malformed', () => {
    expect(parseMonitorConfig('{"port":5432}')).toEqual({ port: 5432 })
    expect(parseMonitorConfig(null)).toEqual({})
    expect(parseMonitorConfig('not json')).toEqual({})
  })

  test('configNumber returns non-negative numbers, else fallback', () => {
    const cfg = { a: 200, b: -5, c: 'x', d: 0 }
    expect(configNumber(cfg, 'a', 99)).toBe(200)
    expect(configNumber(cfg, 'b', 99)).toBe(99) // negative -> fallback
    expect(configNumber(cfg, 'c', 99)).toBe(99) // non-number -> fallback
    expect(configNumber(cfg, 'd', 99)).toBe(0) // zero is valid
    expect(configNumber(cfg, 'missing', 99)).toBe(99)
  })

  test('configBool returns booleans, else fallback', () => {
    expect(configBool({ x: true }, 'x', false)).toBe(true)
    expect(configBool({ x: 'true' }, 'x', false)).toBe(false)
    expect(configBool({}, 'x', true)).toBe(true)
  })
})

describe('applyLatencyThreshold (latency -> degraded)', () => {
  test('an up check over the threshold becomes degraded', () => {
    expect(applyLatencyThreshold('up', 800, 500)).toBe('degraded')
    expect(applyLatencyThreshold('up', 500, 500)).toBe('degraded') // >= is a breach
  })
  test('an up check under the threshold stays up', () => {
    expect(applyLatencyThreshold('up', 200, 500)).toBe('up')
  })
  test('threshold 0 disables the check', () => {
    expect(applyLatencyThreshold('up', 9999, 0)).toBe('up')
  })
  test('never upgrades a down/degraded result, or acts on a null time', () => {
    expect(applyLatencyThreshold('down', 9999, 500)).toBe('down')
    expect(applyLatencyThreshold('degraded', 9999, 500)).toBe('degraded')
    expect(applyLatencyThreshold('up', null, 500)).toBe('up')
  })
})

describe('applyPingDegradation (packet loss / RTT -> degraded)', () => {
  const opts = { rttThresholdMs: 300, lossThresholdPercent: 25 }
  test('loss over threshold degrades (and wins over RTT in the reason)', () => {
    const r = applyPingDegradation('up', 50, 40, opts)
    expect(r.status).toBe('degraded')
    expect(r.reason).toContain('packet loss')
  })
  test('RTT over threshold degrades when loss is fine', () => {
    const r = applyPingDegradation('up', 400, 0, opts)
    expect(r.status).toBe('degraded')
    expect(r.reason).toContain('RTT')
  })
  test('healthy stays up; thresholds of 0 disable', () => {
    expect(applyPingDegradation('up', 50, 0, opts).status).toBe('up')
    expect(applyPingDegradation('up', 9999, 99, { rttThresholdMs: 0, lossThresholdPercent: 0 }).status).toBe('up')
  })
  test('a down host is untouched', () => {
    expect(applyPingDegradation('down', null, 100, opts).status).toBe('down')
  })
})
