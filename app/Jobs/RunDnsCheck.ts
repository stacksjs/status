import { resolve4, resolve6, resolveCaa, resolveMx, resolveNs, resolveTxt } from 'node:dns/promises'
import { URL } from 'node:url'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import DnsSnapshot from '../Models/DnsSnapshot'
import Incident from '../Models/Incident'
import Monitor from '../Models/Monitor'

const RESOLVERS: Record<string, (host: string) => Promise<unknown>> = {
  A: host => resolve4(host),
  AAAA: host => resolve6(host),
  MX: host => resolveMx(host),
  TXT: host => resolveTxt(host),
  NS: host => resolveNs(host),
  CAA: host => resolveCaa(host),
}

/**
 * Snapshots A/AAAA/MX/TXT/NS/CAA records for a monitor's domain and diffs
 * against the previous snapshot per record type. A DNS change is not
 * inherently bad (customers rotate providers, add SPF/DKIM records
 * routinely) so this opens an incident with status 'monitoring' rather than
 * 'investigating' — informational, not a declared outage — except when NS
 * changes entirely, which is worth harder attention (a stolen or
 * misconfigured domain often shows up first as an NS change).
 */
export default new Job({
  name: 'RunDnsCheck',
  description: 'Snapshot and diff DNS records for a monitor',
  queue: 'checks',
  tries: 2,
  backoff: 30,
  timeout: 30,

  async handle(payload: { monitorId: number }) {
    const monitor = await Monitor.find(payload.monitorId)
    if (!monitor) {
      log.warn(`[job] RunDnsCheck: monitor ${payload.monitorId} not found`)
      return
    }

    let hostname = monitor.url
    try {
      hostname = new URL(monitor.url).hostname
    }
    catch {
      // bare hostname, no scheme
    }

    const checkedAt = new Date().toISOString()

    for (const [recordType, resolver] of Object.entries(RESOLVERS)) {
      let values: unknown[] = []
      try {
        const result = await resolver(hostname)
        values = Array.isArray(result) ? result : [result]
      }
      catch {
        // record type not present for this domain — not an error, just skip
        continue
      }

      const serialized = JSON.stringify(values)
      const previous = await DnsSnapshot.where('monitor_id', monitor.id)
        .where('record_type', recordType)
        .orderByDesc('created_at')
        .first()

      await DnsSnapshot.create({
        monitor_id: monitor.id,
        record_type: recordType,
        record_values: serialized,
        checked_at: checkedAt,
      })

      if (previous && previous.record_values !== serialized) {
        const isNsChange = recordType === 'NS'
        await Incident.create({
          monitor_id: monitor.id,
          started_at: checkedAt,
          cause: `${recordType} records changed for ${hostname}`,
          status: isNsChange ? 'investigating' : 'monitoring',
          impacted_checks: JSON.stringify([{ type: 'dns', recordType, previous: previous.record_values, current: serialized }]),
        })
        log.info(`[job] RunDnsCheck: ${monitor.name} — ${recordType} records changed`)
      }
    }
  },
})
