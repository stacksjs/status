import process from 'node:process'
import { log } from '@stacksjs/logging'
import { Job } from '@stacksjs/queue'
import CheckResult from '../Models/CheckResult'

/**
 * Retention window for raw per-check history, in days. The marketing site
 * advertises "90 days of history per monitor" (features/status-pages.stx,
 * ping-monitoring.stx) and the status page renders exactly 90 days of
 * uptime bars — this job is what makes that promise literally true instead
 * of letting `check_results` grow without bound (one row per monitor per
 * check adds up fast). Overridable per install; a self-hoster who wants a
 * longer archive just raises it.
 */
const RETENTION_DAYS = Number(process.env.CHECK_RESULT_RETENTION_DAYS) || 90

/**
 * Runs daily (see app/Scheduler.ts). Deletes check results older than the
 * retention window in one bulk query rather than loading rows into memory —
 * this table is by far the highest-volume one in the schema. Incidents,
 * SSL/DNS/domain snapshots, and Lighthouse reports are intentionally left
 * alone: they're low-volume, long-lived history the dashboards still show.
 */
export default new Job({
  name: 'PruneOldCheckResults',
  description: 'Delete per-check history older than the retention window',
  queue: 'checks',
  tries: 1,
  timeout: 120,

  async handle() {
    const days = RETENTION_DAYS > 0 ? RETENTION_DAYS : 90
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

    await CheckResult.where('checked_at', '<', cutoff).delete()

    log.debug(`[job] PruneOldCheckResults: pruned check results older than ${days}d (before ${cutoff})`)
  },
})
