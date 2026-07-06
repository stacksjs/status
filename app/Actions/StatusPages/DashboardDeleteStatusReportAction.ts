import { Action } from '@stacksjs/actions'
import { resolveAuthenticatedTeamId } from '@stacksjs/auth'
import { db } from '@stacksjs/database'
import { response } from '@stacksjs/router'
import StatusReport from '../../Models/StatusReport'

/**
 * `POST /status-report-forms/{id}/delete` — delete a status report and its
 * monitor pivots + timeline updates (stacksjs/status#1 Phase 12
 * follow-up). Scoped to the requester's team. The pivot/update tables are
 * cleaned with raw db deletes since neither has a cascade relation
 * declared.
 */
export default new Action({
  name: 'DashboardDeleteStatusReportAction',
  description: 'Delete a status report from a dashboard form',

  async handle(request) {
    const authTeamId = await resolveAuthenticatedTeamId(request)
    if (!authTeamId)
      return response.unauthorized('Authentication required')

    const reportId = Number(request.get('id'))
    if (reportId) {
      const report = await StatusReport.where('id', reportId).where('team_id', authTeamId).first()
      if (report) {
        await db.deleteFrom('status_report_monitors').where('status_report_id', '=', reportId).execute()
        await db.deleteFrom('status_report_updates').where('status_report_id', '=', reportId).execute()
        await report.delete()
      }
    }

    return new Response(null, { status: 302, headers: { Location: '/dashboard/status-reports' } })
  },
})
