import process from 'node:process'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import ServerMetricSample from '../Models/ServerMetricSample'

/**
 * Retention window for agent-pushed host samples, in days. Matches the
 * 90-day history promise PruneOldCheckResults enforces for check_results —
 * a server page shows the same window of CPU/memory history that a monitor
 * page shows of uptime. Overridable per install; a self-hoster who wants a
 * longer archive just raises it.
 */
const RETENTION_DAYS = Number(process.env.SERVER_METRIC_SAMPLE_RETENTION_DAYS) || 90

/**
 * Runs daily (see app/Scheduler.ts). Deletes samples older than the
 * retention window in one bulk query rather than loading rows into memory —
 * one row per host per minute makes this the highest-volume table after
 * check_results. Keyed on sampled_at (the agent's own timestamp, and the
 * column the sweep index covers), not created_at. Servers, their incidents
 * and their denormalised last_sample_at are intentionally left alone: a
 * pruned history must not make a box look like it never reported.
 */
export default new Job({
  name: 'PruneOldServerMetricSamples',
  description: 'Delete agent host samples older than the retention window',
  queue: 'checks',
  tries: 1,
  timeout: 120,

  async handle() {
    const days = RETENTION_DAYS > 0 ? RETENTION_DAYS : 90
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

    await ServerMetricSample.where('sampled_at', '<', cutoff).delete()

    log.debug(`[job] PruneOldServerMetricSamples: pruned host samples older than ${days}d (before ${cutoff})`)
  },
})
