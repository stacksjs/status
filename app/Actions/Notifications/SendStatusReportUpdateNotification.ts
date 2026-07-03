import { Action } from '@stacksjs/actions'
import { log } from '@stacksjs/logging'
import NotifyStatusReportSubscribers from '../../Jobs/NotifyStatusReportSubscribers'
import StatusReport from '../../Models/StatusReport'

/**
 * Fires on `statusreportupdate:created` (registered in app/Events.ts, via
 * StatusReportUpdate's `observe: ['create']` trait) — emails status page
 * subscribers the posted announcement update (stacksjs/status#1 Phase 12
 * follow-up).
 *
 * Posting an UPDATE is deliberately the notification trigger, not
 * creating the report itself: a `statusreport:created` listener would be
 * dead code by construction — the status_report_monitors pivot rows that
 * determine which status pages (and therefore which subscribers) are
 * affected can only be attached AFTER the report exists, so at create
 * time the audience is always empty. The authoring flow is: create the
 * report, attach monitors, then post the first update to announce it.
 */
export default new Action({
  name: 'SendStatusReportUpdateNotification',
  description: 'Email status page subscribers when a status report update is posted',

  async handle(update: { status_report_id: number, message: string, status: string }) {
    const report = await StatusReport.find(update.status_report_id)
    if (!report) return

    const subject = `📢 ${report.title}`
    const message = update.message || report.body || report.title

    await NotifyStatusReportSubscribers.dispatch({ statusReportId: report.id, subject, message })

    log.debug(`[listener] SendStatusReportUpdateNotification: dispatched subscriber fan-out for report ${report.id}`)
  },
})
