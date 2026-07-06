import { Action } from '@stacksjs/actions'
import { resolveAuthenticatedTeamId } from '@stacksjs/auth'
import { response } from '@stacksjs/router'
import Monitor from '../../Models/Monitor'
import StatusReport from '../../Models/StatusReport'
import StatusReportMonitor from '../../Models/StatusReportMonitor'

/**
 * `POST /status-report-forms/{id}/monitors/add` — attach a monitor to a
 * status report (stacksjs/status#1 Phase 12 follow-up). The pivot rows
 * this writes are what determine a report's audience: the public status
 * page shows a report when one of ITS monitors is covered, and posting an
 * update emails those pages' subscribers. Both the report and the monitor
 * must belong to the requester's team (same ownership scoping as
 * DashboardAssignMonitorAction). No-ops if already attached.
 */
export default new Action({
  name: 'DashboardAttachReportMonitorAction',
  description: 'Attach a monitor to a status report from a dashboard form',

  async handle(request) {
    const authTeamId = await resolveAuthenticatedTeamId(request)
    if (!authTeamId)
      return response.unauthorized('Authentication required')

    const reportId = Number(request.get('id'))
    const monitorId = Number(request.get('monitor_id'))

    if (reportId && monitorId) {
      const report = await StatusReport.where('id', reportId).where('team_id', authTeamId).first()
      const monitor = await Monitor.where('id', monitorId).where('team_id', authTeamId).first()
      if (!report || !monitor)
        return response.forbidden('You do not have access to this status report or monitor')

      const existing = await StatusReportMonitor.where('status_report_id', reportId).where('monitor_id', monitorId).first()
      if (!existing) {
        await StatusReportMonitor.create({
          status_report_id: reportId,
          monitor_id: monitorId,
        })
      }
    }

    return new Response(null, { status: 302, headers: { Location: `/dashboard/status-reports/${reportId}` } })
  },
})
