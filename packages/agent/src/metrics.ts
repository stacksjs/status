import { readFileSync } from 'node:fs'
import { statfsSync } from 'node:fs'
import { cpus, freemem, platform, totalmem } from 'node:os'

/**
 * Host metrics, collected with native APIs only — no shell, no `df`, no
 * `/proc` parsing except where the kernel is the only honest source.
 *
 * This is what spatie/laravel-health cannot do: it shells out to `df` for
 * disk (which needs proc_open, commonly disabled on shared hosting) and ships
 * no CPU or memory check at all.
 */

export interface HostMetrics {
  cpuPercent: number
  ramPercent: number
  ramUsedMb: number
  ramTotalMb: number
  diskPercent?: number
}

interface CpuSample { busy: number, total: number }

function cpuSample(): CpuSample {
  let busy = 0
  let total = 0
  for (const core of cpus()) {
    const t = core.times
    busy += t.user + t.nice + t.sys + t.irq
    total += t.user + t.nice + t.sys + t.irq + t.idle
  }
  return { busy, total }
}

/**
 * Busy time as a percentage over `sampleMs`.
 *
 * Two samples, not one: `os.cpus()` reports cumulative time since boot, so a
 * single reading is the machine's lifetime average — on a box that is busy
 * now but idle for a week, that reads as ~0%.
 */
export async function cpuPercent(sampleMs = 1000): Promise<number> {
  const first = cpuSample()
  await new Promise(resolve => setTimeout(resolve, sampleMs))
  const second = cpuSample()
  const deltaTotal = second.total - first.total
  if (deltaTotal <= 0)
    return 0
  return clampPercent(Math.round(((second.busy - first.busy) / deltaTotal) * 100))
}

/**
 * Memory in use, in MB and percent.
 *
 * On Linux this reads `MemAvailable` from /proc/meminfo rather than using
 * `os.freemem()`. freemem() maps to `MemFree`, which excludes reclaimable
 * page cache — on a healthy server that has been up for a while it reports
 * 90%+ used and would page you continuously. MemAvailable is the kernel's own
 * estimate of what a new workload could get without swapping. Elsewhere
 * (macOS, Windows) freemem() is the only thing available.
 */
export function memory(): { ramPercent: number, ramUsedMb: number, ramTotalMb: number } {
  const totalBytes = totalmem()
  let availableBytes = freemem()

  if (platform() === 'linux') {
    const available = readMemAvailableBytes()
    if (available != null)
      availableBytes = available
  }

  const usedBytes = Math.max(0, totalBytes - availableBytes)
  return {
    ramPercent: clampPercent(Math.round((usedBytes / totalBytes) * 100)),
    ramUsedMb: Math.round(usedBytes / 1024 ** 2),
    ramTotalMb: Math.round(totalBytes / 1024 ** 2),
  }
}

/** Exported for testing: parse `MemAvailable` (kB) out of /proc/meminfo text. */
export function parseMemAvailable(meminfo: string): number | null {
  const match = meminfo.match(/^MemAvailable:\s+(\d+)\s*kB/m)
  return match ? Number(match[1]) * 1024 : null
}

function readMemAvailableBytes(): number | null {
  try {
    return parseMemAvailable(readFileSync('/proc/meminfo', 'utf8'))
  }
  catch {
    return null
  }
}

/**
 * Percentage of `mount` in use. Uses the statfs syscall directly; returns
 * undefined rather than guessing when the path is not statfs-able.
 */
export function diskPercent(mount = '/'): number | undefined {
  try {
    const stats = statfsSync(mount)
    if (!stats.blocks)
      return undefined
    // bavail (available to unprivileged users), not bfree — bfree counts
    // reserved blocks a normal process can never use, so it understates.
    return clampPercent(Math.round((1 - Number(stats.bavail) / Number(stats.blocks)) * 100))
  }
  catch {
    return undefined
  }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value))
    return 0
  return Math.min(100, Math.max(0, value))
}

/** One full sample, shaped exactly as the StatusHQ ingest endpoint expects. */
export async function collect(options: { mount?: string, sampleMs?: number } = {}): Promise<HostMetrics> {
  const [cpu, mem] = await Promise.all([
    cpuPercent(options.sampleMs ?? 1000),
    Promise.resolve(memory()),
  ])
  const disk = diskPercent(options.mount ?? '/')
  return { cpuPercent: cpu, ...mem, ...(disk === undefined ? {} : { diskPercent: disk }) }
}
