import { Action } from '@stacksjs/actions'
import { resolveAuthenticatedTeamId } from '@stacksjs/auth'
import { response } from '@stacksjs/router'
import StatusReport from '../../Models/StatusReport'
import StatusReportUpdate from '../../Models/StatusReportUpdate'

/**
 * `POST /status-report-forms/{id}/updates` — post a timeline update to a
 * status report (stacksjs/status#1 Phase 12 follow-up). This is the action
 * that actually reaches subscribers: creating the StatusReportUpdate
 * through the ORM fires its `observe: ['create']` hook
 * ('statusreportupdate:created' -> SendStatusReportUpdateNotification ->
 * NotifyStatusReportSubscribers), so every status page showing a covered
 * monitor emails its subscribers.
 *
 * The parent report's status is bumped to match the update so the report
 * card and the public page reflect the latest state (and a 'resolved'
 * update stamps resolved_at + drops the report off the public page, which
 * only shows status != 'resolved'). Team-scoped: the report must belong to
 * the requester's team.
 */
export default new Action({
  name: 'DashboardPostReportUpdateAction',
  description: 'Post a status report update from a dashboard form',

  async handle(request) {
    const authTeamId = await resolveAuthenticatedTeamId(request)
    if (!authTeamId)
      return response.unauthorized('Authentication required')

    const reportId = Number(request.get('id'))
    const message = String(request.get('message') ?? '').trim()
    const status = String(request.get('status') ?? 'investigating')

    const report = reportId ? await StatusReport.where('id', reportId).where('team_id', authTeamId).first() : null
    if (!report)
      return response.forbidden('You do not have access to this status report')

    if (!message || !['investigating', 'identified', 'monitoring', 'resolved'].includes(status))
      return new Response(null, { status: 302, headers: { Location: `/dashboard/status-reports/${reportId}?error=update` } })

    // Create through the ORM so observe fires and subscribers are notified.
    await StatusReportUpdate.create({
      status_report_id: report.id,
      message,
      status,
      posted_at: new Date().toISOString(),
    })

    // Reflect the new state on the parent report.
    await report.update({
      status,
      resolved_at: status === 'resolved' ? new Date().toISOString() : undefined,
    })

    return new Response(null, { status: 302, headers: { Location: `/dashboard/status-reports/${reportId}?posted=1` } })
  },
})
