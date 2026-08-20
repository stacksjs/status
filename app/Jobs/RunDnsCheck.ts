import { resolve4, resolve6, resolveCaa, resolveMx, resolveNs, resolveTxt } from 'node:dns/promises'
import process from 'node:process'
import { URL } from 'node:url'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import CheckResult from '../Models/CheckResult'
import DnsSnapshot from '../Models/DnsSnapshot'
import Incident from '../Models/Incident'
import { openIncident } from '../lib/maintenance'
import Monitor from '../Models/Monitor'
import { broadcastMonitorUpdate } from '../Realtime/broadcastMonitorUpdate'

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
 * misconfigured domain often shows up first as an NS change), or when a
 * record set is removed outright (no MX at all means mail is dead, no NS
 * means the delegation is gone) — those get 'investigating' too.
 *
 * Snapshots are written only when the value actually changes, so the table
 * holds a change history rather than one row per record type per run.
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

    const startedAt = performance.now()

    let hostname = monitor.url
    try {
      hostname = new URL(monitor.url).hostname
    }
    catch {
      // bare hostname, no scheme
    }

    const checkedAt = new Date().toISOString()
    let recordTypesResolved = 0
    const changedTypes: string[] = []

    for (const [recordType, resolver] of Object.entries(RESOLVERS)) {
      let values: unknown[] | null = []
      try {
        const result = await resolver(hostname)
        values = Array.isArray(result) ? result : [result]
        recordTypesResolved++
      }
      catch (error) {
        // Distinguish "this domain genuinely publishes no such record" from
        // "the resolver could not answer right now". ENODATA/ENOTFOUND mean
        // the nameserver authoritatively has nothing, which is a real state
        // worth diffing — deleting every MX or the SPF TXT record is exactly
        // the misconfiguration this check exists to catch, and it used to be
        // invisible because every failure was skipped. Anything else
        // (SERVFAIL, ETIMEOUT, EREFUSED, ...) is a resolver problem, and
        // treating it as "the records vanished" would page on every blip.
        const code = (error as NodeJS.ErrnoException)?.code
        if (code !== 'ENODATA' && code !== 'ENOTFOUND') {
          values = null
        }
      }

      // Resolver failure (not authoritative absence) — leave this record
      // type's history untouched and try again on the next run.
      if (values === null)
        continue

      // Canonicalize before serializing: resolvers return round-robin
      // rotations in whatever order the nameserver felt like, so a raw
      // JSON.stringify flags a "change" on every check for any domain
      // behind a CDN or multi-record set. Order carries no meaning for a
      // record SET; sort a stable string form of each value instead.
      // (Found in production: 131 duplicate "records changed" incidents
      // against one WordPress site in a single evening.)
      const canonical = values
        .map(value => typeof value === 'string' ? value : JSON.stringify(value))
        .sort()
      const serialized = JSON.stringify(canonical)
      // Order by id, not created_at: the timestamp is second-granular, so two
      // snapshots written in the same second (a backfill, or two record types
      // changing on one run) tie and the "previous" value comes back in
      // whatever order the engine chose — which silently diffs against the
      // wrong row. The autoincrement id is strictly insertion-ordered.
      const previous = await DnsSnapshot.where('monitor_id', monitor.id)
        .where('record_type', recordType)
        .orderByDesc('id')
        .first()

      // A record type this domain has never published stays out of the
      // table entirely, so an absent AAAA/CAA doesn't seed a baseline row
      // for every monitored domain.
      if (!previous && canonical.length === 0)
        continue

      const changed = !previous || previous.record_values !== serialized

      // Snapshot only on change. Writing an identical row on every run made
      // this table the fastest-growing one in the schema (2,320 rows for a
      // single monitor's A records in six weeks, of which two were actual
      // changes) and made the monitor page's "last 10 snapshots" panel show
      // ten copies of the current value instead of the change history.
      if (changed) {
        await DnsSnapshot.create({
          monitor_id: monitor.id,
          recordType: recordType,
          recordValues: serialized,
          checkedAt: checkedAt,
        })
      }

      if (previous && changed) {
        changedTypes.push(recordType)
        // Losing an entire record set is a harder failure than a rotation:
        // no MX means mail stops, no NS means the delegation is gone.
        const removed = canonical.length === 0
        const isNsChange = recordType === 'NS'
        const cause = removed
          ? `All ${recordType} records were removed for ${hostname}`
          : `${recordType} records changed for ${hostname}`

        // One open incident per record type at a time: a record set that
        // keeps moving (or a snapshot-format migration) must not stack a
        // fresh incident - and a fresh channel notification - on every
        // run while the previous one is still unresolved.
        const openSameCause = (await Incident.where('monitor_id', monitor.id).where('cause', cause).get())
          .some(existing => existing.status !== 'resolved')

        if (!openSameCause) {
          await openIncident({
            monitor_id: monitor.id,
            started_at: checkedAt,
            cause,
            status: isNsChange || removed ? 'investigating' : 'monitoring',
            impacted_checks: JSON.stringify([{ type: 'dns', recordType, previous: previous.record_values, current: serialized }]),
          })
        }
        log.info(`[job] RunDnsCheck: ${monitor.name} — ${cause}${openSameCause ? ' (incident already open, not duplicated)' : ''}`)
      }
    }

    // A record change is informational (the incident above already covers
    // it) - the check itself passed as long as at least one record type
    // resolved. Nothing resolving at all means the domain isn't answering
    // DNS, which is the actual failure this check can detect.
    const status: 'up' | 'down' = recordTypesResolved > 0 ? 'up' : 'down'
    const message = status === 'up'
      ? changedTypes.length > 0
        ? `Snapshotted ${recordTypesResolved} record type(s), changed: ${changedTypes.join(', ')}`
        : `Snapshotted ${recordTypesResolved} record type(s)`
      : `DNS resolution failed for ${hostname}: no record types resolved`

    await CheckResult.create({
      monitor_id: monitor.id,
      status,
      responseTimeMs: Math.round(performance.now() - startedAt),
      statusCode: 0,
      message,
      metadata: JSON.stringify({ hostname, recordTypesResolved, changedTypes }),
      region: process.env.WORKER_REGION || 'default',
      checkedAt: checkedAt,
    })

    // last_checked_at must advance on every terminal path - DispatchDueChecks
    // schedules off it, so skipping it would re-dispatch this check every minute.
    const consecutiveFailures = status === 'up' ? 0 : monitor.consecutive_failures + 1
    await monitor.update({ status, last_checked_at: checkedAt, consecutive_failures: consecutiveFailures })
    // Push this check outcome to the live-status broadcaster so the
    // dashboard updates sub-second. Fire-and-forget; a no-op unless
    // Redis fan-out is enabled (the poller is the fallback).
    void broadcastMonitorUpdate(monitor.id)
  },
})
