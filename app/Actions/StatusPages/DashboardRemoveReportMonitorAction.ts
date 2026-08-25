import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import StatusReport from '../../Models/StatusReport'
import StatusReportMonitor from '../../Models/StatusReportMonitor'
import { resolveOrCreateTeamId } from '../../lib/teamContext'

/**
 * `POST /status-report-forms/{id}/monitors/remove` — detach a monitor
 * from a status report (stacksjs/status#1 Phase 12 follow-up). Scoped so
 * the report must belong to the requester's team before any pivot is
 * removed.
 */
export default new Action({
  name: 'DashboardRemoveReportMonitorAction',
  description: 'Detach a monitor from a status report from a dashboard form',

  async handle(request) {
    const authTeamId = await resolveOrCreateTeamId(request)
    if (!authTeamId)
      return response.unauthorized('Authentication required')

    const reportId = Number(request.get('id'))
    const monitorId = Number(request.get('monitor_id'))

    if (reportId && monitorId) {
      const report = await StatusReport.where('id', reportId).where('team_id', authTeamId).first()
      if (report) {
        const pivot = await StatusReportMonitor.where('status_report_id', reportId).where('monitor_id', monitorId).first()
        if (pivot) await pivot.delete()
      }
    }

    return new Response(null, { status: 302, headers: { Location: `/dashboard/status-reports/${reportId}` } })
  },
})
