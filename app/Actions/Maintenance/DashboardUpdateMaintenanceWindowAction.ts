import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { parseMaintenanceForm } from '../../lib/maintenanceForm'
import MaintenanceWindow from '../../Models/MaintenanceWindow'
import { requireTeamId } from '../../lib/teamGuard'

/**
 * `POST /api/maintenance-forms/{id}/update` — edit a window from the
 * dashboard's detail page.
 *
 * `status` is editable here on purpose: cancelling is the operationally
 * important one. A cancelled window means the maintenance did NOT happen,
 * so app/lib/maintenance.ts deliberately keeps counting its time against
 * uptime and keeps paging — cancelling is how an operator says "we called
 * it off, go back to alerting me", and without a UI that was unreachable.
 *
 * `subscribers_notified_for` is intentionally NOT settable: it is the
 * NotifyUpcomingMaintenance job's bookkeeping for announcing each
 * occurrence exactly once, and hand-editing it would either double-send or
 * silently skip an announcement.
 */
export default new Action({
  name: 'DashboardUpdateMaintenanceWindowAction',
  description: 'Update a maintenance window from a dashboard form post',

  async handle(request) {
    const authTeamId = await requireTeamId(request)
    if (authTeamId instanceof Response)
      return authTeamId

    const windowId = Number(request.get('id'))
    if (!windowId)
      return response.json({ error: 'id is required' }, { status: 422 })

    const window = await MaintenanceWindow.where('id', windowId).where('team_id', authTeamId).first()
    if (!window)
      return response.forbidden('You do not have access to this maintenance window')

    const parsed = parseMaintenanceForm({
      title: request.get('title'),
      description: request.get('description'),
      starts_at: request.get('starts_at'),
      ends_at: request.get('ends_at'),
      recurrence_cron: request.get('recurrence_cron'),
      status: request.get('status'),
    })

    if (!parsed.ok)
      return new Response(null, { status: 302, headers: { Location: `/dashboard/maintenance/${windowId}?error=${parsed.error}` } })

    // Cleared fields are written as '' rather than null: the ORM's update
    // type takes `string | undefined`, and `undefined` means "leave alone",
    // which would make clearing impossible — you could turn a one-off window
    // into a recurring one but never back. Empty string is behaviourally
    // identical for every consumer (expandWindowIntervals falsy-checks
    // `recurrence_cron?.trim()`, and the views use `|| 'One-off'`), and it
    // passes the model's own validation, which explicitly allows a blank
    // recurrence.
    await window.update({
      title: parsed.values.title,
      description: parsed.values.description ?? '',
      starts_at: parsed.values.starts_at,
      ends_at: parsed.values.ends_at,
      recurrence_cron: parsed.values.recurrence_cron ?? '',
      status: parsed.values.status,
    })

    return new Response(null, { status: 302, headers: { Location: `/dashboard/maintenance/${windowId}?saved=1` } })
  },
})
