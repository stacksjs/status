import { describe, expect, test } from 'bun:test'
import { faker } from '@stacksjs/faker'
import Incident from '../../app/Models/Incident'
import Monitor from '../../app/Models/Monitor'
import Server from '../../app/Models/Server'
import ServerMetricSample from '../../app/Models/ServerMetricSample'

// Same footing as cron-validation.test.ts: the auto-CRUD store/update
// handlers validate a request against attributes[].validation.rule, so
// asserting the rule is asserting exactly what the API enforces. The
// factories are what `useSeeder` and the seeders run, so a factory whose
// output its own rule rejects would seed rows the API could never accept.
// No database here.

function attr(model: any, name: string): any {
  return model.attributes?.[name]
}

function rule(model: any, name: string): any {
  return attr(model, name)?.validation?.rule
}

function isValid(r: any, value: unknown): boolean {
  return r.validate(value).valid === true
}

function factoryValue(model: any, name: string): unknown {
  return attr(model, name)?.factory?.(faker)
}

describe('Server model', () => {
  test('status vocabulary is healthy | hot | quiet | unknown, default unknown', () => {
    const status = rule(Server, 'status')
    for (const value of ['healthy', 'hot', 'quiet', 'unknown'])
      expect(isValid(status, value)).toBe(true)
    // The monitor vocabulary is the site's, not the box's. (An empty value
    // passes: the rule is not `.required()`, the column default supplies it.)
    for (const value of ['up', 'degraded', 'down', 'paused'])
      expect(isValid(status, value)).toBe(false)
    expect(attr(Server, 'status').default).toBe('unknown')
  })

  test('status and lastSampleAt are written by ingest and the stale-server job only', () => {
    expect(attr(Server, 'status').fillable).toBe(false)
    expect(attr(Server, 'lastSampleAt').fillable).toBe(false)
    for (const name of ['teamId', 'name', 'metricsToken', 'cpuThreshold', 'ramThreshold', 'diskThreshold', 'metricsWindowSeconds'])
      expect(attr(Server, name).fillable).toBe(true)
  })

  test('the generated API is reads only, behind auth', () => {
    const api = (Server as any).traits.useApi
    expect(api.uri).toBe('servers')
    expect(api.routes).toEqual(['index', 'show'])
    expect(api.middleware).toContain('auth')
  })

  test('metricsToken is hidden and unique, and the factory mints an opaque token', () => {
    const token = attr(Server, 'metricsToken')
    expect(token.hidden).toBe(true)
    expect(token.unique).toBe(true)
    const minted = factoryValue(Server, 'metricsToken') as string
    expect(minted).toMatch(/^[0-9a-f]{32}$/)
    expect(isValid(token.validation.rule, minted)).toBe(true)
    expect(isValid(token.validation.rule, 'x'.repeat(65))).toBe(false)
  })

  test('thresholds are percentages with the documented defaults', () => {
    const defaults: Record<string, number> = { cpuThreshold: 90, ramThreshold: 90, diskThreshold: 85 }
    for (const [name, fallback] of Object.entries(defaults)) {
      const r = rule(Server, name)
      expect(attr(Server, name).default).toBe(fallback)
      expect(isValid(r, 0)).toBe(true) // 0 disables the alert
      expect(isValid(r, 100)).toBe(true)
      expect(isValid(r, -1)).toBe(false)
      expect(isValid(r, 101)).toBe(false)
    }
  })

  test('the metrics window is 30s..1d, default 300s', () => {
    const window = rule(Server, 'metricsWindowSeconds')
    expect(attr(Server, 'metricsWindowSeconds').default).toBe(300)
    expect(isValid(window, 30)).toBe(true)
    expect(isValid(window, 86_400)).toBe(true)
    expect(isValid(window, 29)).toBe(false)
    expect(isValid(window, 86_401)).toBe(false)
  })

  test('a server carries monitors, samples and incidents', () => {
    expect((Server as any).hasMany).toEqual(['Monitor', 'ServerMetricSample', 'Incident'])
    expect((Server as any).table).toBe('servers')
  })

  test('every factory produces a value its own rule accepts', () => {
    for (const name of Object.keys((Server as any).attributes)) {
      const value = factoryValue(Server, name)
      if (value === null || value === undefined)
        continue // lastSampleAt: no sample yet
      expect(isValid(rule(Server, name), value)).toBe(true)
    }
  })
})

describe('ServerMetricSample model', () => {
  test('readings are 0..100 percentages; MB counts are non-negative', () => {
    for (const name of ['cpuPercent', 'ramPercent', 'diskPercent']) {
      const r = rule(ServerMetricSample, name)
      expect(isValid(r, 0)).toBe(true)
      expect(isValid(r, 37.2)).toBe(true)
      expect(isValid(r, 100)).toBe(true)
      expect(isValid(r, 150)).toBe(false)
      expect(isValid(r, -0.1)).toBe(false)
    }
    for (const name of ['ramUsedMb', 'ramTotalMb']) {
      const r = rule(ServerMetricSample, name)
      expect(isValid(r, 0)).toBe(true)
      expect(isValid(r, 32_768)).toBe(true)
      expect(isValid(r, -1)).toBe(false)
    }
  })

  test('the four readings, host and sampledAt are required; disk and breaches are not', () => {
    for (const name of ['host', 'cpuPercent', 'ramPercent', 'ramUsedMb', 'ramTotalMb', 'sampledAt'])
      expect(attr(ServerMetricSample, name).required).toBe(true)
    for (const name of ['diskPercent', 'breaches'])
      expect(attr(ServerMetricSample, name).required).not.toBe(true)
    expect(isValid(rule(ServerMetricSample, 'sampledAt'), '')).toBe(false)
    expect(isValid(rule(ServerMetricSample, 'sampledAt'), '2026-09-02T00:00:00.000Z')).toBe(true)
  })

  test('host defaults to "default" and breaches to an empty JSON array', () => {
    expect(attr(ServerMetricSample, 'host').default).toBe('default')
    expect(isValid(rule(ServerMetricSample, 'host'), 'x'.repeat(65))).toBe(false)
    expect(attr(ServerMetricSample, 'breaches').default).toBe('[]')
    expect(JSON.parse(factoryValue(ServerMetricSample, 'breaches') as string)).toEqual([])
  })

  test('belongs to a Server, with no API and no uuid', () => {
    const sample = ServerMetricSample as any
    expect(sample.belongsTo).toEqual(['Server'])
    expect(sample.table).toBe('server_metric_samples')
    expect(sample.traits.useApi).toBeUndefined()
    expect(sample.traits.useUuid).toBeUndefined()
    expect(sample.traits.useTimestamps).toBe(true)
  })

  test('every factory produces a value its own rule accepts', () => {
    for (const name of Object.keys((ServerMetricSample as any).attributes)) {
      const value = factoryValue(ServerMetricSample, name)
      if (value === null || value === undefined)
        continue // diskPercent: the agent reported no disk
      expect(isValid(rule(ServerMetricSample, name), value)).toBe(true)
    }
  })
})

describe('serverId on Monitor and Incident', () => {
  test('both declare a nullable, fillable numeric serverId', () => {
    for (const model of [Monitor, Incident]) {
      const serverId = attr(model, 'serverId')
      expect(serverId).toBeTruthy()
      expect(serverId.fillable).toBe(true)
      expect(serverId.required).not.toBe(true)
      expect(isValid(serverId.validation.rule, 1)).toBe(true)
      expect(isValid(serverId.validation.rule, 'one')).toBe(false)
      expect(serverId.factory()).toBeNull()
    }
  })

  test('Monitor belongs to Server as well as Team', () => {
    expect((Monitor as any).belongsTo).toEqual(['Team', 'Server'])
  })

  test('Monitor keeps reportsMetrics and metricsToken until the cut-over step', () => {
    expect(attr(Monitor, 'reportsMetrics')).toBeTruthy()
    expect(attr(Monitor, 'metricsToken')).toBeTruthy()
  })

  test('Incident still belongs to Monitor', () => {
    expect((Incident as any).belongsTo).toEqual(['Monitor'])
  })
})
