import process from 'node:process'
import { schedule } from '@stacksjs/scheduler'

/**
 * **Scheduler**
 *
 * Define your scheduled tasks here. Jobs, actions, and shell commands
 * can all be scheduled with a fluent, expressive API.
 *
 * @see https://docs.stacksjs.com/scheduling
 */
export default function () {
  // Run the Inspire job every hour
  schedule
    .job('Inspire')
    .hourly()
    .setTimeZone('America/Los_Angeles')

  // Fan out due monitor checks every minute (stacksjs/status#1 Phase 1/2)
  schedule
    .job('DispatchDueChecks')
    .everyMinute()

  // Heartbeat monitors are passive — watch for missed check-ins rather
  // than polling (stacksjs/status#1 Phase 2)
  schedule
    .job('CheckOverdueHeartbeats')
    .everyMinute()

  // Decide each availability monitor's up/down status from cross-region
  // agreement and open/resolve incidents accordingly (stacksjs/status#1
  // Phase 11). The per-region check jobs only record observations now — this
  // is where the verdict is made. MUST run on the primary only; running it in
  // a second region would race on the shared status/incident writes.
  schedule
    .job('EvaluateMonitorConsensus')
    .everyMinute()

  // Response-time trend analysis needs enough history per window to be
  // meaningful — no value in running it every minute. No everyFifteenMinutes
  // on the scheduler API, so everyTenMinutes is the closest fit
  // (stacksjs/status#1 Phase 4)
  schedule
    .job('CheckPerformanceTrends')
    .everyTenMinutes()

  // Self-check for the monitoring pipeline itself — "who monitors the
  // monitor?" (stacksjs/status#1 Phase 11). Runs independently of
  // DispatchDueChecks so a stall in that job's own logic doesn't also
  // silence this one.
  schedule
    .job('CheckWorkerHealth')
    .everyFiveMinutes()

  // Keeps MaintenanceWindow.status in sync with its timestamps
  // (stacksjs/status#1 Phase 12).
  schedule
    .job('UpdateMaintenanceWindowStatus')
    .everyMinute()

  // Periodic per-team uptime report emails. Runs daily; the job itself
  // decides which teams are due (weekly/monthly, from teams.report_frequency
  // and report_last_sent_at) so this stays a dumb daily tick.
  schedule
    .job('SendUptimeReports')
    .daily()

  // Enforce the 90-day (configurable) history retention the marketing site
  // advertises, and keep check_results from growing without bound.
  schedule
    .job('PruneOldCheckResults')
    .daily()

  // Run a custom action every five minutes
  // schedule.action('CleanupTempFiles').everyFiveMinutes()

  // Run a shell command daily at midnight
  // schedule.command('echo "Daily maintenance complete"').daily()
}

process.on('SIGINT', () => {
  schedule.gracefulShutdown().then(() => process.exit(0))
})
