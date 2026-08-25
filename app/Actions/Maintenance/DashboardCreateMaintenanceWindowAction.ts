import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { parseMaintenanceForm } from '../../lib/maintenanceForm'
import MaintenanceWindow from '../../Models/MaintenanceWindow'
import { resolveOrCreateTeamId } from '../../lib/teamContext'

/**
 * `POST /api/maintenance-forms/create` — the dashboard's native HTML form
 * counterpart to the model's auto-generated JSON `store` route.
 *
 * The auto-CRUD route has existed since Phase 12 and the jobs, suppression
 * and subscriber notices were all built against it, but nothing in the
 * product ever posted to it: there was no view, no form and no nav entry,
 * so scheduling a window meant curl. docs/operate/maintenance.md has been
 * telling operators to "go to Maintenance and click Schedule window" the
 * whole time. This is that button.
 *
 * team_id comes from the requester's own session rather than a form field
 * — the same hole DashboardCreateStatusPageAction had to close.
 */
export default new Action({
  name: 'DashboardCreateMaintenanceWindowAction',
  description: 'Create a maintenance window from a dashboard form post',

  async handle(request) {
    const authTeamId = await resolveOrCreateTeamId(request)
    if (!authTeamId)
      return response.json({ error: 'Authentication required' }, { status: 401 })

    const parsed = parseMaintenanceForm({
      title: request.get('title'),
      description: request.get('description'),
      starts_at: request.get('starts_at'),
      ends_at: request.get('ends_at'),
      recurrence_cron: request.get('recurrence_cron'),
      status: request.get('status'),
    })

    if (!parsed.ok)
      return new Response(null, { status: 302, headers: { Location: `/dashboard/maintenance?error=${parsed.error}` } })

    const window = await MaintenanceWindow.create({
      teamId: authTeamId,
      title: parsed.values.title,
      description: parsed.values.description ?? undefined,
      startsAt: parsed.values.starts_at,
      endsAt: parsed.values.ends_at,
      recurrenceCron: parsed.values.recurrence_cron ?? undefined,
      status: parsed.values.status,
    })

    return new Response(null, { status: 302, headers: { Location: `/dashboard/maintenance/${window.id}` } })
  },
})
