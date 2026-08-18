import type { CpuSnapshot, FileReader } from '../../packages/agent/src/metrics'
import { describe, expect, test } from 'bun:test'
import {
  createCollector,
  createCpuSampler,
  cpuSnapshot,
  isReportable,
  memory,
  parseCgroupQuota,
  parseProcStat,
  percentBetween,
  readMemory,
  toIngestPayload,
} from '../../packages/agent/src/metrics'

/**
 * The container-awareness half of @statushq/agent.
 *
 * Every reading comes from a fixture rather than the machine running the
 * suite: none of these paths exist on macOS, and the cases that matter (a
 * container at its memory limit, a counter reset by a reboot) are not
 * reproducible on demand anywhere.
 */

const MB = 1024 * 1024

function reader(files: Record<string, string>): FileReader {
  return path => files[path] ?? null
}

const MEMINFO = [
  'MemTotal:       65798616 kB',
  'MemFree:         2338712 kB',
  'MemAvailable:   19603868 kB',
  'Buffers:          856140 kB',
  'Cached:         18899828 kB',
  'SReclaimable:    1204832 kB',
].join('\n')

const CGROUP_V2_MEMORY_STAT = 'anon 268435456\ninactive_anon 4194304\ninactive_file 100663296\nactive_file 33554432\n'

function container(usedMb = 256, limitMb = 512): Record<string, string> {
  return {
    '/sys/fs/cgroup/memory.max': String(limitMb * MB),
    '/sys/fs/cgroup/memory.current': String(usedMb * MB),
    '/sys/fs/cgroup/memory.stat': CGROUP_V2_MEMORY_STAT,
    '/proc/meminfo': MEMINFO,
  }
}

describe('memory in a container', () => {
  test('the cgroup limit wins over the host memory', () => {
    // The bug this fixes: /proc/meminfo (and os.totalmem()) describe the
    // 64 GB box, so a 512 MB container reads as 70% used when it is at 31%
    // of what it may use — or sails past its own limit while claiming to be
    // fine. Wrong in both directions, and silent in both.
    const usage = readMemory(reader(container()))

    expect(usage.source).toBe('cgroup-v2')
    expect(usage.totalBytes).toBe(512 * MB)
  })

  test('reclaimable page cache is not counted as used', () => {
    // 256 MB current − 96 MB inactive_file. Counting the cache would put
    // every long-running container at ~100% forever.
    const mem = memory(reader(container()))

    expect(mem.ramUsedMb).toBe(160)
    expect(mem.ramPercent).toBe(31)
  })

  test('an unlimited cgroup v2 falls through to meminfo', () => {
    const files = { ...container(), '/sys/fs/cgroup/memory.max': 'max\n' }

    expect(readMemory(reader(files)).source).toBe('proc-meminfo')
  })

  test('cgroup v1 is read when v2 is absent', () => {
    const usage = readMemory(reader({
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': String(512 * MB),
      '/sys/fs/cgroup/memory/memory.usage_in_bytes': String(256 * MB),
      '/sys/fs/cgroup/memory/memory.stat': 'total_inactive_file 100663296\n',
    }))

    expect(usage.source).toBe('cgroup-v1')
    expect(usage.usedBytes).toBe(160 * MB)
  })

  test('the v1 unlimited sentinel is not treated as a limit', () => {
    // Docker writes a near-max byte count for "no limit". Taken literally it
    // makes every container look 0.000001% used.
    const usage = readMemory(reader({
      '/sys/fs/cgroup/memory/memory.limit_in_bytes': '9223372036854771712',
      '/sys/fs/cgroup/memory/memory.usage_in_bytes': String(256 * MB),
      '/proc/meminfo': MEMINFO,
    }))

    expect(usage.source).toBe('proc-meminfo')
  })

  test('meminfo uses MemAvailable rather than MemFree', () => {
    // MemFree alone would report this healthy host at 96% used.
    expect(memory(reader({ '/proc/meminfo': MEMINFO })).ramPercent).toBe(70)
  })

  test('meminfo without MemAvailable adds the reclaimable pools', () => {
    const withoutAvailable = MEMINFO.split('\n').filter(line => !line.startsWith('MemAvailable')).join('\n')

    expect(memory(reader({ '/proc/meminfo': withoutAvailable })).ramPercent).toBe(65)
  })

  test('off Linux it falls back to the os APIs rather than reporting nothing', () => {
    // The one advantage this runtime has over PHP, which has no equivalent
    // and has to report memory as skipped on macOS.
    const usage = readMemory(reader({}))

    expect(usage.source).toBe('os')
    expect(usage.totalBytes).toBeGreaterThan(0)
  })
})

describe('cpu counters', () => {
  test('iowait counts as idle and guest time is not counted twice', () => {
    // guest (500) and guest_nice (100) are already inside user and nice —
    // summing the whole line counts them again. iowait leaves the CPU free.
    const parsed = parseProcStat('cpu  120000 3000 40000 900000 8000 0 2000 0 500 100\ncpu0 1 2 3 4\n')

    expect(parsed).toEqual({ busy: 165000, total: 1073000 })
  })

  test('a truncated cpu line is rejected rather than guessed', () => {
    expect(parseProcStat('cpu  100 200\n')).toBeNull()
    expect(parseProcStat('intr 5\n')).toBeNull()
  })

  test('a quota reads as a share of a core, and "max" as none', () => {
    expect(parseCgroupQuota('50000 100000')).toBe(0.5)
    expect(parseCgroupQuota('200000 100000\n')).toBe(2)
    // Without a quota there is no ceiling to be a percentage of.
    expect(parseCgroupQuota('max 100000')).toBeNull()
    expect(parseCgroupQuota(null)).toBeNull()
  })

  test('a quotaed container is measured against its quota, not the host', () => {
    // A container capped at half a core on a 32-core host is at 100% of what
    // it may use while /proc/stat shows 1.5%.
    const clock = { monotonicNanos: () => 20_000_000_000, unixSeconds: () => 1000 }
    const snapshot = cpuSnapshot(reader({
      '/sys/fs/cgroup/cpu.stat': 'usage_usec 4200000\n',
      '/sys/fs/cgroup/cpu.max': '50000 100000',
      '/proc/stat': 'cpu  1 2 3 4 5 6 7 8\n',
    }), clock)

    expect(snapshot.source).toBe('cgroup-v2')
    expect(snapshot.busy).toBe(4_200_000)
    // 20s of wall time at half a core = 10s of CPU it was entitled to.
    expect(snapshot.capacity).toBe(10_000_000)
  })

  test('an unquotaed container falls through to proc-stat, then to os', () => {
    const clock = { monotonicNanos: () => 1, unixSeconds: () => 1000 }

    expect(cpuSnapshot(reader({
      '/sys/fs/cgroup/cpu.stat': 'usage_usec 4200000\n',
      '/sys/fs/cgroup/cpu.max': 'max 100000',
      '/proc/stat': 'cpu  1 2 3 4 5 6 7 8\n',
    }), clock).source).toBe('proc-stat')

    expect(cpuSnapshot(reader({}), clock).source).toBe('os')
  })
})

describe('percentBetween', () => {
  const snapshot = (busy: number, capacity: number, takenAtUnix = 1000, source: CpuSnapshot['source'] = 'proc-stat'): CpuSnapshot =>
    ({ busy, capacity, source, takenAtUnix })

  test('it is the busy share of the interval', () => {
    expect(percentBetween(snapshot(1000, 10_000), snapshot(1060, 10_100, 1060))).toBe(60)
  })

  test('a rebooted counter is discarded rather than wrapped', () => {
    // Counters restart at zero on boot. A wrapped subtraction would report a
    // wild percentage at exactly the moment someone is watching.
    expect(percentBetween(snapshot(50_000, 100_000), snapshot(10, 100, 1060))).toBeNull()
  })

  test('a window wider than the max age is not differenced', () => {
    expect(percentBetween(snapshot(1000, 10_000), snapshot(2000, 20_000, 5000))).toBeNull()
  })

  test('two sources are not subtracted from each other', () => {
    // Adding a CPU limit to a running deployment switches jiffies for
    // microseconds. Subtracting one from the other is garbage.
    expect(percentBetween(snapshot(1000, 10_000), snapshot(2000, 20_000, 1060, 'cgroup-v2'))).toBeNull()
  })

  test('a window in which nothing moved is unknown, not zero', () => {
    expect(percentBetween(snapshot(1000, 10_000), snapshot(1000, 10_000, 1060))).toBeNull()
  })

  test('bursting above the quota still clamps to one hundred', () => {
    expect(percentBetween(snapshot(0, 0, 1000, 'cgroup-v2'), snapshot(12_000_000, 10_000_000, 1060, 'cgroup-v2'))).toBe(100)
  })
})

describe('createCpuSampler', () => {
  test('the first sample reports nothing, the second reports the rate', () => {
    let busy = 1000
    let idle = 9000
    const files: FileReader = path => path === '/proc/stat' ? `cpu  ${busy} 0 0 ${idle} 0 0 0 0\n` : null
    const sampler = createCpuSampler({ files, clock: { monotonicNanos: () => 1, unixSeconds: () => 1000 } })

    // One cumulative reading is the average since boot — on a box idle all
    // week and pinned right now, that reads as roughly nothing.
    expect(sampler.sample()).toBeNull()

    busy += 40
    idle += 60
    expect(sampler.sample()).toBe(40)
  })
})

describe('the ingest payload', () => {
  test('a sample without cpu is withheld rather than sent as zero', () => {
    const collector = createCollector({ files: reader(container()), host: 'web-01' })

    const first = collector.collect()
    expect(first.cpuPercent).toBeNull()
    expect(isReportable(first)).toBe(false)
  })

  test('it carries the host and drops fields the ingest does not accept', () => {
    const collector = createCollector({ files: reader(container()), host: 'web-01' })
    collector.collect()
    const sample = { ...collector.collect(), cpuPercent: 42 }

    const payload = toIngestPayload(sample)

    expect(payload.host).toBe('web-01')
    expect(payload.cpuPercent).toBe(42)
    expect(payload.ramTotalMb).toBe(512)
    // memorySource is diagnostic, not part of the ingest contract.
    expect('memorySource' in payload).toBe(false)
  })
})
