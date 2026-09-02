import { db } from '@stacksjs/database'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import { thresholdsForServer } from '../Actions/Agents/metricsThresholds'
import { aggregateHostStatus, readingsFromSamples, serverStatusFromFleet } from '../lib/agentHosts'
import { reconcileServerIncidents } from '../lib/serverIncidents'

/**
 * Every minute. Two jobs:
 *
 *  1. A box whose agent has not pushed inside its window is marked 'quiet'
 *     (the agent went quiet — the box may be gone) and gets one box-level
 *     incident. A box that has never pushed is skipped: 'unknown' is not
 *     'quiet', so a server created in the dashboard does not page five
 *     minutes later while the operator is still running the installer.
 *
 *  2. Every box that IS inside its window has its status recomputed from the
 *     same windowed fleet the ingest uses and its incidents reconciled from
 *     that state. This is what makes the state machine hold on the tick as
 *     well as on the push: a 'hot' server with no open server_hot (a crash
 *     between the ingest's status write and its reconcile, or the
 *     post-backfill state) gets its incident within a minute; a breaching host
 *     that aged out of the window while another host kept pushing turns the
 *     box 'healthy' without waiting for the next push; and a 'quiet' server
 *     whose window an operator just widened leaves 'quiet' and closes its
 *     server_silent as soon as the samples say so.
 *
 * Every status write is a compare-and-set on last_sample_at: this job runs in
 * the queue worker and the ingest in the web process, and SQLite's
 * per-process transaction serialisation does not order them. If a push landed
 * between this tick's read and its write, the UPDATE matches zero rows and the
 * server is skipped for this tick — the push's own reconcile already ran on
 * fresher data.
 *
 * Nothing here writes a Monitor: the sites on the box keep their own verdicts
 * from their own checks, so the CheckStaleMetrics / EvaluateMonitorConsensus
 * tug-of-war has no two writers left to happen between.
 */
export default new Job({
  name: 'CheckStaleServers',
  description: 'Reconcile server status and incidents from the windowed samples; open incidents for servers whose agent stopped pushing',
  queue: 'checks',
  tries: 1,
  timeout: 30,

  async handle() {
    const now = Date.now()
    let overdue = 0

    for (const server of await db.selectFrom('servers').selectAll().execute()) {
      // Never heard from is not went quiet.
      if (server.status === 'unknown' || !server.last_sample_at)
        continue

      const baseline = Date.parse(String(server.last_sample_at))
      if (!Number.isFinite(baseline))
        continue

      const { windowSeconds } = thresholdsForServer(server)
      const isOverdue = now >= baseline + windowSeconds * 1000
      const checkedAt = new Date(now).toISOString()

      if (!isOverdue) {
        // Inside the window: the fleet is the truth. Same query as the ingest.
        const windowStart = new Date(now - windowSeconds * 1000).toISOString()
        const recent = await db.selectFrom('server_metric_samples')
          .where('server_id', '=', server.id)
          .where('sampled_at', '>=', windowStart)
          .orderBy('sampled_at', 'desc')
          .orderBy('id', 'desc')
          .selectAll()
          .execute()

        const fleet = aggregateHostStatus(readingsFromSamples(recent), now, windowSeconds)
        const status = serverStatusFromFleet(fleet)

        if (status !== server.status) {
          // Covers stale-hot (the breaching host aged out) and the widened
          // window that leaves a box 'quiet' with fresh samples behind it.
          if (!(await claimServerStatus(server.id, String(server.last_sample_at), status, checkedAt)))
            continue
          server.status = status
        }

        await reconcileServerIncidents(server as never, checkedAt, fleet)
        continue
      }

      if (server.status !== 'quiet') {
        // A push that landed between the read and this write means the box is
        // not quiet after all; its own reconcile ran on fresher data.
        if (!(await claimServerStatus(server.id, String(server.last_sample_at), 'quiet', checkedAt)))
          continue
        server.status = 'quiet'
        log.warn(`[job] CheckStaleServers: ${server.name} stopped pushing metrics`)
      }

      // State-based: opens one server_silent if none is open, otherwise nothing.
      await reconcileServerIncidents(server as never, checkedAt)
      overdue++
    }

    if (overdue > 0)
      log.debug(`[job] CheckStaleServers: ${overdue} server(s) overdue`)
  },
})

/**
 * Compare-and-set servers.status on the last_sample_at this tick read. Returns
 * false when a push moved the baseline first, in which case this tick has
 * nothing to say about the box.
 *
 * The update builder reports its affected-row count as a bare number from
 * `execute()` and as `{ numUpdatedRows }` from `executeTakeFirst()`
 * (bun-query-builder client.d.ts); the latter is the one that is typed, so it
 * is the one used, with a defensive Number() around a possibly absent field.
 *
 * Exported for the CAS test in tests/feature/server-incidents.test.ts: the
 * race it guards against is two processes, which a single-process test can
 * only stage by driving this directly.
 */
export async function claimServerStatus(serverId: number, baseline: string, status: string, at: string): Promise<boolean> {
  const result = await db.updateTable('servers')
    .set({ status, updated_at: at } as never)
    .where('id', '=', serverId)
    .where('last_sample_at', '=', baseline)
    .executeTakeFirst()

  return Number(result?.numUpdatedRows ?? 0) > 0
}
