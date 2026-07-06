import { Action } from '@stacksjs/actions'
import { resolveAuthenticatedTeamId } from '@stacksjs/auth'
import { response } from '@stacksjs/router'
import StatusReport from '../../Models/StatusReport'

/**
 * `POST /status-report-forms/create` — create a manual status-page
 * announcement (stacksjs/status#1 Phase 12 follow-up: the dashboard
 * authoring surface for status reports, which previously had no UI at all
 * — a report + its monitor pivots could only be created by curling the
 * API). team_id is derived from the requester's own session, never a form
 * field. Redirects to the report's detail page to attach monitors and
 * post the first update.
 */
export default new Action({
  name: 'DashboardCreateStatusReportAction',
  description: 'Create a status report from a dashboard form',

  async handle(request) {
    const authTeamId = await resolveAuthenticatedTeamId(request)
    if (!authTeamId)
      return response.json({ error: 'Authentication required' }, { status: 401 })

    const title = String(request.get('title') ?? '').trim()
    const body = String(request.get('body') ?? '').trim()
    const status = String(request.get('status') ?? 'investigating')

    if (!title)
      return new Response(null, { status: 302, headers: { Location: '/dashboard/status-reports?error=title' } })
    if (!['investigating', 'identified', 'monitoring', 'resolved'].includes(status))
      return new Response(null, { status: 302, headers: { Location: '/dashboard/status-reports?error=status' } })

    const report = await StatusReport.create({
      team_id: authTeamId,
      title,
      body: body || undefined,
      status,
      started_at: new Date().toISOString(),
      resolved_at: status === 'resolved' ? new Date().toISOString() : undefined,
    })

    return new Response(null, { status: 302, headers: { Location: `/dashboard/status-reports/${report.id}` } })
  },
})
