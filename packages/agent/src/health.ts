import { collect, cpuPercent, diskPercent, memory } from './metrics'

/**
 * The pull side: expose an endpoint StatusHQ (or Oh Dear) polls.
 *
 * Emits the `spatie/laravel-health` schema deliberately — that is the format
 * the ecosystem standardized on, so an endpoint built with this is readable
 * by either service with no adapter.
 */

export type CheckStatus = 'ok' | 'warning' | 'failed' | 'crashed' | 'skipped'

export interface CheckResult {
  name: string
  label: string
  status: CheckStatus
  notificationMessage: string
  shortSummary: string
  meta: Record<string, unknown>
}

/** A check is any function returning a result; throwing is reported as `crashed`. */
export type Check = () => CheckResult | Promise<CheckResult>

export interface HealthReport {
  finishedAt: string
  checkResults: CheckResult[]
}

function result(
  name: string,
  label: string,
  status: CheckStatus,
  shortSummary: string,
  notificationMessage = '',
  meta: Record<string, unknown> = {},
): CheckResult {
  return { name, label, status, notificationMessage, shortSummary, meta }
}

/** Percentage-threshold check shared by the disk/memory/cpu builtins. */
function thresholdResult(
  name: string,
  label: string,
  value: number | undefined,
  unit: string,
  { warning, failure }: { warning: number, failure: number },
  metaKey: string,
): CheckResult {
  if (value === undefined)
    return result(name, label, 'skipped', 'unavailable', `${label} could not be measured on this platform`)

  const status: CheckStatus = value >= failure ? 'failed' : value >= warning ? 'warning' : 'ok'
  const message = status === 'ok' ? '' : `${label} is at ${value}${unit} (threshold ${status === 'failed' ? failure : warning}${unit})`
  return result(name, label, status, `${value}${unit}`, message, { [metaKey]: value })
}

export function usedDiskSpaceCheck(options: { mount?: string, warning?: number, failure?: number } = {}): Check {
  return () => thresholdResult(
    'UsedDiskSpace',
    'Used disk space',
    diskPercent(options.mount ?? '/'),
    '%',
    { warning: options.warning ?? 70, failure: options.failure ?? 90 },
    'disk_space_used_percentage',
  )
}

export function usedMemoryCheck(options: { warning?: number, failure?: number } = {}): Check {
  return () => {
    const mem = memory()
    return thresholdResult(
      'UsedMemory',
      'Used memory',
      mem.ramPercent,
      '%',
      { warning: options.warning ?? 80, failure: options.failure ?? 95 },
      'memory_used_percentage',
    )
  }
}

export function cpuLoadCheck(options: { warning?: number, failure?: number, sampleMs?: number } = {}): Check {
  return async () => thresholdResult(
    'CpuLoad',
    'CPU load',
    await cpuPercent(options.sampleMs ?? 1000),
    '%',
    { warning: options.warning ?? 75, failure: options.failure ?? 90 },
    'cpu_used_percentage',
  )
}

/**
 * Run every check and build the report.
 *
 * A check that throws becomes `crashed` rather than taking the endpoint down
 * with it — one broken check must not blind the monitor to the other twelve.
 */
export async function runChecks(checks: Check[]): Promise<HealthReport> {
  const checkResults = await Promise.all(checks.map(async (check): Promise<CheckResult> => {
    try {
      return await check()
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return result('UnknownCheck', 'Unknown check', 'crashed', 'crashed', message)
    }
  }))

  // Unix seconds, as a string: what the schema specifies and what the
  // consumer's staleness window is measured against.
  return { finishedAt: String(Math.floor(Date.now() / 1000)), checkResults }
}

/**
 * A `fetch`-style handler serving the report — works in Bun.serve, Hono,
 * Elysia, and Node via any Request/Response adapter.
 *
 * When `secret` is set the caller must present it in the
 * `oh-dear-health-check-secret` header, the same header spatie/laravel-health
 * validates, and a mismatch is a flat 403 with no report body.
 */
export function createHealthHandler(options: { checks: Check[], secret?: string }) {
  return async (request: Request): Promise<Response> => {
    if (options.secret) {
      const presented = request.headers.get('oh-dear-health-check-secret')
      if (presented !== options.secret)
        return Response.json({ error: 'Invalid health check secret' }, { status: 403 })
    }

    const report = await runChecks(options.checks)
    return Response.json(report)
  }
}

/** The default set: everything measurable about the host, no configuration. */
export function defaultChecks(): Check[] {
  return [usedDiskSpaceCheck(), usedMemoryCheck(), cpuLoadCheck()]
}

export { collect, cpuPercent, diskPercent, memory }
export type { HostMetrics } from './metrics'
