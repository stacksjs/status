import type { CpuSampler, FileReader, MemorySource } from './metrics'
import { collect, cpuPercent, createCpuSampler, diskPercent, memory, systemFileReader } from './metrics'

/**
 * The pull side: expose an endpoint StatusHQ (or Oh Dear) polls.
 *
 * Emits the `spatie/laravel-health` schema deliberately — that is the format
 * the ecosystem standardized on, so an endpoint built with this is readable
 * by either service with no adapter, and matches what statushq/laravel emits
 * from the PHP side.
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
  value: number | undefined | null,
  unit: string,
  { warning, failure }: { warning: number, failure: number },
  metaKey: string,
  unavailableReason: string,
  extraMeta: Record<string, unknown> = {},
): CheckResult {
  // Skipped, not failed. An unmeasurable metric says nothing about the
  // application's health, and paging on "we could not look" is how a monitor
  // teaches its owner to ignore it.
  if (value === undefined || value === null)
    return result(name, label, 'skipped', 'unavailable', unavailableReason, extraMeta)

  const status: CheckStatus = value >= failure ? 'failed' : value >= warning ? 'warning' : 'ok'
  const message = status === 'ok' ? '' : `${label} is at ${value}${unit} (threshold ${status === 'failed' ? failure : warning}${unit})`
  return result(name, label, status, `${value}${unit}`, message, { [metaKey]: value, ...extraMeta })
}

export function usedDiskSpaceCheck(options: { mount?: string, warning?: number, failure?: number } = {}): Check {
  const mount = options.mount ?? '/'
  return () => thresholdResult(
    // The name spatie/laravel-health uses, so a team migrating from Oh Dear
    // keeps its history instead of starting a fresh series.
    'UsedDiskSpace',
    'Used disk space',
    diskPercent(mount),
    '%',
    { warning: options.warning ?? 70, failure: options.failure ?? 90 },
    'disk_space_used_percentage',
    `${mount} could not be stat-ed`,
    { path: mount },
  )
}

export function usedMemoryCheck(options: { warning?: number, failure?: number, files?: FileReader } = {}): Check {
  return () => {
    const mem = memory(options.files ?? systemFileReader)
    return thresholdResult(
      'UsedMemory',
      'Used memory',
      mem.ramPercent,
      '%',
      { warning: options.warning ?? 80, failure: options.failure ?? 95 },
      'memory_used_percentage',
      'memory could not be read on this host',
      {
        memory_used_mb: mem.ramUsedMb,
        memory_total_mb: mem.ramTotalMb,
        // Which interface answered. A container reporting the host's 64 GB
        // instead of its own 512 MB limit is the failure mode this check
        // exists to avoid, and `source` is how you see it from the outside.
        source: mem.source satisfies MemorySource,
      },
    )
  }
}

/**
 * CPU in use as a percentage of what this container or host may use.
 *
 * Not a load average. `sys_getloadavg`-style load counts runnable processes
 * and is unbounded and core-count-relative — 8.0 is idle on a 16-core box and
 * a fire on a 2-core one. This is a bounded percentage, which is what the
 * StatusHQ ingest and its thresholds are defined in terms of.
 *
 * Pass a shared `sampler` in a long-lived server: it differences against the
 * previous call instead of holding the event loop for a second, at the cost
 * of reporting `skipped` until it has been called twice.
 */
export function cpuUsageCheck(options: { warning?: number, failure?: number, sampleMs?: number, sampler?: CpuSampler, files?: FileReader } = {}): Check {
  return async () => thresholdResult(
    'CpuUsage',
    'CPU usage',
    options.sampler
      ? options.sampler.sample()
      : await createCpuSampler({ files: options.files }).sampleBlocking(options.sampleMs ?? 1000),
    '%',
    { warning: options.warning ?? 75, failure: options.failure ?? 90 },
    'cpu_used_percentage',
    'no previous sample to compare against yet — usage is a rate, so the first reading cannot report one',
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
 * Elysia, Stacks, and Node via any Request/Response adapter.
 *
 * When `secret` is set the caller must present it in the
 * `oh-dear-health-check-secret` header, the same header spatie/laravel-health
 * validates, and a mismatch is a flat 403 with no report body: the check names
 * alone describe the application's internals.
 */
export function createHealthHandler(options: { checks: Check[], secret?: string }) {
  return async (request: Request): Promise<Response> => {
    if (options.secret) {
      const presented = request.headers.get('oh-dear-health-check-secret')
      if (presented !== options.secret)
        return Response.json({ error: 'Invalid health check secret' }, { status: 403 })
    }

    // Always 200, including when checks failed. The status code answers "did
    // the endpoint work", the body answers "is the app healthy" — conflating
    // them means a consumer cannot tell a failing check from a dead server.
    return Response.json(await runChecks(options.checks))
  }
}

/** The default set: everything measurable about the host, no configuration. */
export function defaultChecks(options: { sampler?: CpuSampler, files?: FileReader } = {}): Check[] {
  return [
    usedDiskSpaceCheck(),
    usedMemoryCheck({ files: options.files }),
    cpuUsageCheck({ sampler: options.sampler, files: options.files }),
  ]
}

export { collect, cpuPercent, createCpuSampler, diskPercent, memory }
export type { CpuSampler, HostMetrics, MemorySource } from './metrics'
