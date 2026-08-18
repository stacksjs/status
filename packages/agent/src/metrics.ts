import { readFileSync, statfsSync } from 'node:fs'
import { cpus, freemem, hostname, totalmem } from 'node:os'

/**
 * Host metrics, collected with native APIs only — no shell, no `df`.
 *
 * The cgroup files are consulted before /proc, and before os.totalmem(), and
 * that ordering is the substance of this module rather than a detail. Inside
 * a container /proc/meminfo and os.totalmem() both describe the *host*: an app
 * capped at 512 MB on a 64 GB box reads as 3% used while it is being
 * OOM-killed. The same goes for CPU — when a quota is set, usage has to be
 * measured against the quota, or a container pinned at half a core reads as
 * 1.5% of a 32-core host.
 */

export interface HostMetrics {
  cpuPercent: number
  ramPercent: number
  ramUsedMb: number
  ramTotalMb: number
  diskPercent?: number
}

/** Reads the pseudo-files the kernel exposes host state through. */
export type FileReader = (path: string) => string | null

export interface Clock {
  /** Monotonic nanoseconds — an NTP step must not produce a negative window. */
  monotonicNanos: () => number
  unixSeconds: () => number
}

export const systemFileReader: FileReader = (path) => {
  try {
    return readFileSync(path, 'utf8')
  }
  catch {
    // Absent is the normal state of these paths off Linux, and unreadable is
    // the normal state inside a hardened container. Neither is exceptional.
    return null
  }
}

export const systemClock: Clock = {
  monotonicNanos: () => Number(process.hrtime.bigint()),
  unixSeconds: () => Math.floor(Date.now() / 1000),
}

const CGROUP = {
  v2Memory: { max: '/sys/fs/cgroup/memory.max', current: '/sys/fs/cgroup/memory.current', stat: '/sys/fs/cgroup/memory.stat' },
  v1Memory: {
    limit: '/sys/fs/cgroup/memory/memory.limit_in_bytes',
    usage: '/sys/fs/cgroup/memory/memory.usage_in_bytes',
    stat: '/sys/fs/cgroup/memory/memory.stat',
  },
  v2Cpu: { stat: '/sys/fs/cgroup/cpu.stat', max: '/sys/fs/cgroup/cpu.max' },
  v1Cpu: {
    usage: '/sys/fs/cgroup/cpuacct/cpuacct.usage',
    quota: '/sys/fs/cgroup/cpu/cpu.cfs_quota_us',
    period: '/sys/fs/cgroup/cpu/cpu.cfs_period_us',
  },
} as const

// ---------------------------------------------------------------- memory ---

export type MemorySource = 'cgroup-v2' | 'cgroup-v1' | 'proc-meminfo' | 'os'

export interface MemoryUsage {
  usedBytes: number
  totalBytes: number
  /** Which interface answered. A container reporting the host's memory is the
   *  failure this module exists to prevent, and this is how you see it. */
  source: MemorySource
}

/** Exported for testing: parse `MemAvailable` (kB) out of /proc/meminfo text. */
export function parseMemAvailable(meminfo: string): number | null {
  return parseMeminfoBytes(meminfo, 'MemAvailable')
}

/** Exported for testing: one `Key: 1234 kB` line of /proc/meminfo, as bytes. */
export function parseMeminfoBytes(meminfo: string, key: string): number | null {
  const match = meminfo.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm'))
  return match ? Number(match[1]) * 1024 : null
}

/** Exported for testing: one `key value` pair of a cgroup stat file. */
export function parseStatValue(contents: string, key: string): number | null {
  const match = contents.match(new RegExp(`^${key}\\s+(\\d+)$`, 'm'))
  return match ? Number(match[1]) : null
}

function parseInteger(raw: string | null, allowNegative = false): number | null {
  if (raw === null)
    return null
  const trimmed = raw.trim()
  return new RegExp(allowNegative ? '^-?\\d+$' : '^\\d+$').test(trimmed) ? Number(trimmed) : null
}

/**
 * A cgroup limit in bytes, or null when the group is unconstrained.
 *
 * "Unconstrained" has two spellings: cgroup v2's literal `max`, and v1's
 * sentinel of a near-max byte count (commonly 9223372036854771712). Both mean
 * "the host's memory", where /proc/meminfo is the more accurate answer.
 */
function cgroupLimit(raw: string | null): number | null {
  if (raw === null)
    return null
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed === 'max')
    return null
  const limit = parseInteger(trimmed)
  return limit === null || limit <= 0 || limit >= Number.MAX_SAFE_INTEGER ? null : limit
}

export function readMemory(files: FileReader = systemFileReader): MemoryUsage {
  return cgroupV2Memory(files) ?? cgroupV1Memory(files) ?? meminfoMemory(files) ?? osMemory()
}

function cgroupV2Memory(files: FileReader): MemoryUsage | null {
  const limit = cgroupLimit(files(CGROUP.v2Memory.max))
  const current = parseInteger(files(CGROUP.v2Memory.current))
  if (limit === null || current === null)
    return null

  // Excluding the inactive file cache matches what kubelet calls the working
  // set. Page cache is reclaimable under pressure, so counting it would put
  // every long-running container at ~100% forever.
  const inactiveFile = parseStatValue(files(CGROUP.v2Memory.stat) ?? '', 'inactive_file') ?? 0
  return { usedBytes: Math.max(0, current - inactiveFile), totalBytes: limit, source: 'cgroup-v2' }
}

function cgroupV1Memory(files: FileReader): MemoryUsage | null {
  const limit = cgroupLimit(files(CGROUP.v1Memory.limit))
  const usage = parseInteger(files(CGROUP.v1Memory.usage))
  if (limit === null || usage === null)
    return null

  const inactiveFile = parseStatValue(files(CGROUP.v1Memory.stat) ?? '', 'total_inactive_file') ?? 0
  return { usedBytes: Math.max(0, usage - inactiveFile), totalBytes: limit, source: 'cgroup-v1' }
}

function meminfoMemory(files: FileReader): MemoryUsage | null {
  const contents = files('/proc/meminfo')
  if (contents === null)
    return null

  const total = parseMeminfoBytes(contents, 'MemTotal')
  if (total === null || total <= 0)
    return null

  // MemAvailable, not MemFree: freemem() maps to MemFree, which excludes the
  // reclaimable page cache and reports a healthy long-lived server at 90%+.
  const available = parseMeminfoBytes(contents, 'MemAvailable')
    ?? (parseMeminfoBytes(contents, 'MemFree') ?? 0)
    + (parseMeminfoBytes(contents, 'Buffers') ?? 0)
    + (parseMeminfoBytes(contents, 'Cached') ?? 0)
    + (parseMeminfoBytes(contents, 'SReclaimable') ?? 0)

  return { usedBytes: Math.max(0, total - Math.min(total, available)), totalBytes: total, source: 'proc-meminfo' }
}

/** macOS and Windows, where there is no /proc to read. Overstates usage —
 *  freemem() ignores reclaimable cache — but it is the only thing available. */
function osMemory(): MemoryUsage {
  const totalBytes = totalmem()
  return { usedBytes: Math.max(0, totalBytes - freemem()), totalBytes, source: 'os' }
}

/** Memory in use, in MB and percent. */
export function memory(files: FileReader = systemFileReader): { ramPercent: number, ramUsedMb: number, ramTotalMb: number, source: MemorySource } {
  const usage = readMemory(files)
  return {
    ramPercent: clampPercent(Math.round((usage.usedBytes / usage.totalBytes) * 100)),
    ramUsedMb: Math.round(usage.usedBytes / 1024 ** 2),
    ramTotalMb: Math.round(usage.totalBytes / 1024 ** 2),
    source: usage.source,
  }
}

// ------------------------------------------------------------------- cpu ---

export type CpuSource = 'cgroup-v2' | 'cgroup-v1' | 'proc-stat' | 'os'

/**
 * One reading of the CPU counters.
 *
 * `busy` and `capacity` are cumulative and share a unit — jiffies, or
 * microseconds. Only their deltas are ever divided, so the unit cancels and
 * no source needs to know the kernel's tick rate.
 */
export interface CpuSnapshot {
  busy: number
  capacity: number
  source: CpuSource
  takenAtUnix: number
}

/**
 * Cores allowed by cgroup v2's `cpu.max`, formatted "<quota|max> <period>".
 * Null when unquotaed: without a ceiling there is nothing to be a fraction of.
 */
export function parseCgroupQuota(raw: string | null): number | null {
  if (raw === null)
    return null
  const [quota, period] = raw.trim().split(/\s+/)
  if (quota === undefined || period === undefined || quota === 'max')
    return null
  const cores = Number(quota) / Number(period)
  return Number.isFinite(cores) && cores > 0 ? cores : null
}

/**
 * Busy and total jiffies from the aggregate `cpu` line of /proc/stat.
 *
 * iowait counts as idle — the CPU is available during it, and folding it into
 * busy makes a slow disk look like a hot processor. Only the first eight
 * columns are counted: `guest` and `guest_nice` follow, and the kernel already
 * includes them in `user` and `nice`.
 */
export function parseProcStat(contents: string): { busy: number, total: number } | null {
  const match = contents.match(/^cpu\s+(.+)$/m)
  if (!match?.[1])
    return null

  const fields = match[1].trim().split(/\s+/).map(Number).slice(0, 8)
  if (fields.length < 4 || fields.some(value => !Number.isFinite(value)))
    return null

  const total = fields.reduce((sum, value) => sum + value, 0)
  const idle = fields[3]! + (fields[4] ?? 0)
  return { busy: total - idle, total }
}

export function cpuSnapshot(files: FileReader = systemFileReader, clock: Clock = systemClock): CpuSnapshot {
  return cgroupV2Cpu(files, clock)
    ?? cgroupV1Cpu(files, clock)
    ?? procStatCpu(files, clock)
    ?? osCpu(clock)
}

/** Cumulative CPU-microseconds this cgroup is entitled to, as of now. */
function entitledMicros(clock: Clock, cores: number): number {
  return (clock.monotonicNanos() / 1000) * cores
}

function cgroupV2Cpu(files: FileReader, clock: Clock): CpuSnapshot | null {
  const usageMicros = parseStatValue(files(CGROUP.v2Cpu.stat) ?? '', 'usage_usec')
  const cores = parseCgroupQuota(files(CGROUP.v2Cpu.max))
  if (usageMicros === null || cores === null)
    return null

  return { busy: usageMicros, capacity: entitledMicros(clock, cores), source: 'cgroup-v2', takenAtUnix: clock.unixSeconds() }
}

function cgroupV1Cpu(files: FileReader, clock: Clock): CpuSnapshot | null {
  const usageNanos = parseInteger(files(CGROUP.v1Cpu.usage))
  const quota = parseInteger(files(CGROUP.v1Cpu.quota), true)
  const period = parseInteger(files(CGROUP.v1Cpu.period))

  // -1 is v1's spelling of "no quota".
  if (usageNanos === null || quota === null || quota <= 0 || period === null || period <= 0)
    return null

  return { busy: usageNanos / 1000, capacity: entitledMicros(clock, quota / period), source: 'cgroup-v1', takenAtUnix: clock.unixSeconds() }
}

function procStatCpu(files: FileReader, clock: Clock): CpuSnapshot | null {
  const contents = files('/proc/stat')
  if (contents === null)
    return null
  const totals = parseProcStat(contents)
  return totals === null ? null : { busy: totals.busy, capacity: totals.total, source: 'proc-stat', takenAtUnix: clock.unixSeconds() }
}

/**
 * The last resort, and the one advantage this runtime has over PHP: os.cpus()
 * exposes per-core cumulative times on macOS and Windows too, so CPU is never
 * simply unmeasurable the way it is for a PHP process off Linux.
 */
function osCpu(clock: Clock): CpuSnapshot {
  let busy = 0
  let total = 0
  for (const core of cpus()) {
    const t = core.times
    busy += t.user + t.nice + t.sys + t.irq
    total += t.user + t.nice + t.sys + t.irq + t.idle
  }
  return { busy, capacity: total, source: 'os', takenAtUnix: clock.unixSeconds() }
}

/**
 * The share of the interval between two readings that was busy.
 *
 * Null rather than a number wherever one cannot honestly be derived: a
 * counter reset by a reboot, two readings from different sources (different
 * units), a window so wide the answer no longer describes now, or no window
 * at all. A plausible-looking 0% would be worse than a gap — it is also what
 * an idle box reports, so nobody would ever notice it was invented.
 */
export function percentBetween(previous: CpuSnapshot, current: CpuSnapshot, maxAgeSeconds = 900): number | null {
  if (previous.source !== current.source)
    return null

  const age = current.takenAtUnix - previous.takenAtUnix
  if (age < 0 || age > maxAgeSeconds)
    return null

  const busyDelta = current.busy - previous.busy
  const capacityDelta = current.capacity - previous.capacity
  if (busyDelta < 0 || capacityDelta <= 0)
    return null

  return clampPercent(Math.round((busyDelta / capacityDelta) * 100))
}

export interface CpuSampler {
  /** Usage since the previous call. Null on the first one. */
  sample: () => number | null
  /** Both readings taken here, sleeping between them. */
  sampleBlocking: (sampleMs?: number) => Promise<number | null>
}

/**
 * A sampler that remembers its previous reading.
 *
 * A long-lived server can hold that in memory, which is the whole difference
 * from the PHP side: there, every scheduled run is a fresh process and the
 * previous counter has to survive in a cache. Here it does not — but the
 * first call after a restart still has nothing to compare against, and says
 * so rather than guessing.
 */
export function createCpuSampler(options: { files?: FileReader, clock?: Clock, maxAgeSeconds?: number } = {}): CpuSampler {
  const files = options.files ?? systemFileReader
  const clock = options.clock ?? systemClock
  const maxAgeSeconds = options.maxAgeSeconds ?? 900
  let previous: CpuSnapshot | null = null

  const sample = (): number | null => {
    const current = cpuSnapshot(files, clock)
    const last = previous
    // Stored even when no percentage comes out, or a sampler that starts on a
    // mismatched reading would never recover.
    previous = current
    return last === null ? null : percentBetween(last, current, maxAgeSeconds)
  }

  return {
    sample,
    sampleBlocking: async (sampleMs = 1000) => {
      const first = cpuSnapshot(files, clock)
      await new Promise(resolve => setTimeout(resolve, sampleMs))
      return percentBetween(first, cpuSnapshot(files, clock), maxAgeSeconds)
    },
  }
}

/**
 * Busy time as a percentage over `sampleMs`, taking both readings now.
 *
 * Kept for one-shot callers (a CLI, a cron). A long-lived process should use
 * createCpuSampler() instead and not hold the event loop for a second.
 */
export async function cpuPercent(sampleMs = 1000, files: FileReader = systemFileReader, clock: Clock = systemClock): Promise<number> {
  return await createCpuSampler({ files, clock }).sampleBlocking(sampleMs) ?? 0
}

// ------------------------------------------------------------------ disk ---

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

// --------------------------------------------------------------- collect ---

/** One full sample, shaped exactly as the StatusHQ ingest endpoint expects. */
export async function collect(options: { mount?: string, sampleMs?: number, files?: FileReader } = {}): Promise<HostMetrics> {
  const files = options.files ?? systemFileReader
  const cpu = await createCpuSampler({ files }).sampleBlocking(options.sampleMs ?? 1000)
  const mem = memory(files)
  const disk = diskPercent(options.mount ?? '/')

  return {
    cpuPercent: cpu ?? 0,
    ramPercent: mem.ramPercent,
    ramUsedMb: mem.ramUsedMb,
    ramTotalMb: mem.ramTotalMb,
    ...(disk === undefined ? {} : { diskPercent: disk }),
  }
}

export interface HostSample extends Omit<HostMetrics, 'cpuPercent'> {
  /** Null until a second reading exists to compare against. */
  cpuPercent: number | null
  host: string
  memorySource: MemorySource
}

/**
 * A collector for long-lived processes: no sleeping, and CPU differenced
 * against the previous call rather than a blocking second sample.
 */
export function createCollector(options: { mount?: string, files?: FileReader, clock?: Clock, host?: string } = {}) {
  const files = options.files ?? systemFileReader
  const sampler = createCpuSampler({ files, clock: options.clock })

  return {
    collect: (): HostSample => {
      const mem = memory(files)
      const disk = diskPercent(options.mount ?? '/')
      return {
        cpuPercent: sampler.sample(),
        ramPercent: mem.ramPercent,
        ramUsedMb: mem.ramUsedMb,
        ramTotalMb: mem.ramTotalMb,
        memorySource: mem.source,
        host: options.host ?? hostname(),
        ...(disk === undefined ? {} : { diskPercent: disk }),
      }
    },
  }
}

/**
 * Whether a sample can be pushed at all.
 *
 * The ingest requires CPU and rejects a payload without it, so the first
 * sample after a restart is deliberately not sent. One skipped minute beats
 * a fabricated number.
 */
export function isReportable(sample: HostSample): boolean {
  return sample.cpuPercent !== null
}

/** The ingest payload for a sample, dropping the fields it does not accept. */
export function toIngestPayload(sample: HostSample): HostMetrics & { host: string } {
  const { memorySource: _memorySource, ...rest } = sample
  return { ...rest, cpuPercent: sample.cpuPercent ?? 0 }
}
